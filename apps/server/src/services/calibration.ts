import {
  applyTightening,
  buildCalibrationReason,
  CALIBRATION_RULES,
  canTighten,
  evaluateCalibration,
  fingerprintOf,
  labelForCause,
  snapshotValue,
  type CalibrationField,
  type ResultEvidence,
  type TimingCalibrationSnapshot,
} from '@flil/shared';
import type { MissReason } from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { computeWindowsForInspiration, loadTiming } from './windowEngine.js';
import { touch } from './inspirations.js';

export interface CalibrationOutcome {
  hitRate: number;
  hitCount: number;
  partialCount: number;
  missCount: number;
  tightened: { field: string; before: unknown; after: unknown }[];
  suggestions: string[];
}

/** 重算命中率：hit 计 1，partial 计 0.5（文档 6.3） */
export function recomputeHitRate(inspirationId: string): {
  hitRate: number;
  hitCount: number;
  partialCount: number;
  missCount: number;
} {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN hit_level = 'hit' THEN 1 ELSE 0 END) AS hit_count,
         SUM(CASE WHEN hit_level = 'partial' THEN 1 ELSE 0 END) AS partial_count,
         SUM(CASE WHEN hit_level = 'miss' THEN 1 ELSE 0 END) AS miss_count
       FROM shoot_result WHERE inspiration_id = ?`,
    )
    .get(inspirationId) as {
    hit_count: number | null;
    partial_count: number | null;
    miss_count: number | null;
  };

  const hitCount = row.hit_count ?? 0;
  const partialCount = row.partial_count ?? 0;
  const missCount = row.miss_count ?? 0;
  const total = hitCount + partialCount + missCount;
  const hitRate = total ? (hitCount + partialCount * 0.5) / total : 0;

  db.prepare(
    'UPDATE inspiration SET hit_count = ?, partial_count = ?, miss_count = ?, hit_rate = ? WHERE id = ?',
  ).run(hitCount, partialCount, missCount, Number(hitRate.toFixed(4)), inspirationId);

  return { hitRate: Number(hitRate.toFixed(4)), hitCount, partialCount, missCount };
}

/** 取最近回填（自新向旧）。字段足以让共享口径独立复算，不另立判断标准。 */
function recentResults(inspirationId: string, limit = 6): ResultEvidence[] {
  const rows = getDb()
    .prepare(
      `SELECT id, hit_level, miss_reasons, filled_at FROM shoot_result
       WHERE inspiration_id = ? ORDER BY filled_at DESC, rowid DESC LIMIT ?`,
    )
    .all(inspirationId, limit) as { id: string; hit_level: string; miss_reasons: string; filled_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    hitLevel: r.hit_level,
    missReasons: parseJson<MissReason[]>(r.miss_reasons, []),
    filledAt: r.filled_at,
  }));
}

/** timing 行 → 共享口径使用的条件快照 */
function snapshotOfRow(timingRow: NonNullable<ReturnType<typeof loadTiming>>): TimingCalibrationSnapshot {
  const profile = parseJson<{ cloudCoverPct?: { min: number; max: number } }>(timingRow.weather_profile, {});
  return {
    azimuthTolerance: timingRow.azimuth_tolerance,
    windowToleranceMin: timingRow.window_tolerance_min,
    cloudCoverPct: profile.cloudCoverPct ? { ...profile.cloudCoverPct } : null,
  };
}

/** 把快照写回 timing 行（收紧与撤销走同一个出口，保证字段口径一致） */
function persistSnapshot(timingId: string, snap: TimingCalibrationSnapshot): void {
  const row = getDb().prepare('SELECT weather_profile FROM timing WHERE id = ?').get(timingId) as
    | { weather_profile: string }
    | undefined;
  const profile = parseJson<Record<string, unknown>>(row?.weather_profile ?? '{}', {});
  if (snap.cloudCoverPct) profile.cloudCoverPct = snap.cloudCoverPct;
  else delete profile.cloudCoverPct;
  getDb()
    .prepare(
      `UPDATE timing SET azimuth_tolerance = ?, window_tolerance_min = ?, weather_profile = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(snap.azimuthTolerance, snap.windowToleranceMin, toJson(profile), nowIso(), timingId);
}

interface CalibrationLogRow {
  id: string;
  field: string;
  before_value: string | null;
  after_value: string | null;
  reason: string;
  triggered_by: string | null;
  cause: string | null;
  evidence: string | null;
  undone_at: string | null;
  created_at: string;
}

function logCalibration(params: {
  libraryId: string;
  inspirationId: string;
  field: CalibrationField;
  before: TimingCalibrationSnapshot;
  after: TimingCalibrationSnapshot;
  reason: string;
  triggeredBy: string;
  cause: MissReason;
  evidence: ResultEvidence[];
}): void {
  const beforeValue = snapshotValue(params.field, params.before);
  const afterValue = snapshotValue(params.field, params.after);
  getDb()
    .prepare(
      `INSERT INTO calibration_log
         (id, library_id, inspiration_id, field, before_value, after_value, reason, triggered_by,
          cause, evidence, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newId(),
      params.libraryId,
      params.inspirationId,
      params.field,
      toJson(beforeValue),
      toJson(afterValue),
      params.reason,
      params.triggeredBy,
      params.cause,
      toJson(params.evidence),
      nowIso(),
    );
}

/** 建议规则：非收紧类偏差（现场改造 / 人太多）只提示，绝不动卡片状态 */
function buildSuggestions(results: ResultEvidence[]): string[] {
  const suggestions: string[] = [];
  if (results.filter((r) => r.missReasons.includes('site_rebuilt')).length >= 2) {
    suggestions.push('该地点已有 2 次「现场已改造」记录，建议归档这张卡（系统不会自动改状态）。');
  }
  if (results.filter((r) => r.missReasons.includes('too_crowded')).length >= 2) {
    suggestions.push('该地点已有 2 次「人太多」记录，建议在机位备注里补充备用时段。');
  }
  return suggestions;
}

/**
 * 回填后的校准（文档 6.3 规则 2/3）。
 *
 * 全部判断走共享口径 @flil/shared/calibration：
 *  - 连续 3 次"同一归一主因"的 miss 才收紧一档，三次混合（时间/天气/光位）不收紧；
 *  - 证据指纹落库，同一批证据只收紧一次——撤销后也不会对同一批 miss 反复收紧，
 *    必须再来 3 次新的同因 miss；回填被修订导致主因变化时指纹随之变化，可重新判定；
 *  - 到下限不再写空收紧记录；
 *  - 收紧后立即按同一份条件重算窗口，判断 / 留痕 / 撤销 / 窗口共用同一口径。
 */
export async function applyCalibration(
  libraryId: string,
  inspirationId: string,
  triggeredBy: string,
): Promise<CalibrationOutcome> {
  const db = getDb();
  const stats = recomputeHitRate(inspirationId);
  const results = recentResults(inspirationId);
  const suggestions = buildSuggestions(results);
  const tightened: CalibrationOutcome['tightened'] = [];

  const timingRow = loadTiming(inspirationId);
  const decision = evaluateCalibration(results);

  if (timingRow && decision.shouldTighten && decision.cause && decision.field) {
    const { cause, field, window, fingerprint } = decision;
    // 证据指纹查重：同一批 miss（含已撤销的收紧）绝不重复收紧。
    // 查重口径仍是共享函数 fingerprintOf，不留第二套判断。
    const usedFingerprints = new Set(
      (
        db
          .prepare('SELECT evidence FROM calibration_log WHERE inspiration_id = ? AND evidence IS NOT NULL')
          .all(inspirationId) as { evidence: string }[]
      ).map((r) => fingerprintOf(parseJson<ResultEvidence[]>(r.evidence, []))),
    );

    if (fingerprint && !usedFingerprints.has(fingerprint)) {
      const before = snapshotOfRow(timingRow);
      if (canTighten(field, before)) {
        const after = applyTightening(field, before);
        const reason = buildCalibrationReason({ cause, field, window, before });
        const run = db.transaction(() => {
          persistSnapshot(timingRow.id, after);
          logCalibration({
            libraryId,
            inspirationId,
            field,
            before,
            after,
            reason,
            triggeredBy,
            cause,
            evidence: window,
          });
        });
        run();
        tightened.push({
          field,
          before: snapshotValue(field, before),
          after: snapshotValue(field, after),
        });
        touch(inspirationId);
      } else {
        suggestions.push(
          `已连续 3 次因「${labelForCause(cause)}」未命中，但${CALIBRATION_RULES[field].label}已到收窄下限（${describeFloor(field)}），无法再自动收紧；建议核对机位/光位标注或考虑归档，系统不会自动改卡片状态。`,
        );
      }
    }
  }

  if (tightened.length) {
    // 窗口与收紧共用同一份 timing：收紧后立刻按新条件复算，保证判定可复算
    await computeWindowsForInspiration(inspirationId).catch(() => undefined);
  }

  return { ...stats, tightened, suggestions };
}

function describeFloor(field: CalibrationField): string {
  const rule = CALIBRATION_RULES[field];
  return field === 'cloudCoverPct'
    ? `宽度 ${rule.floor}%`
    : `${rule.floor}${field === 'azimuth_tolerance' ? '°' : ' 分钟'}`;
}

export function listCalibration(inspirationId: string): Record<string, unknown>[] {
  const rows = getDb()
    .prepare('SELECT * FROM calibration_log WHERE inspiration_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(inspirationId) as CalibrationLogRow[];
  return rows.map((r) => ({
    id: r.id,
    field: r.field,
    before: parseJson(r.before_value, null),
    after: parseJson(r.after_value, null),
    reason: r.reason,
    cause: r.cause,
    evidence: parseJson<ResultEvidence[] | null>(r.evidence, null),
    undoneAt: r.undone_at ?? null,
    createdAt: r.created_at,
  }));
}

/**
 * 撤销一次收窄（校准必须可回溯、可撤销）。
 * 逆回放同样走共享口径：把该字段恢复成留痕快照里的 before 值——
 * 该值正是收紧时 buildCalibrationReason 文案与窗口复算使用的同一份数据。
 * 撤销后立即按恢复后的条件重算窗口。
 */
export async function undoCalibration(
  calibrationId: string,
  libraryId: string,
  inspirationId: string,
): Promise<void> {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM calibration_log WHERE id = ? AND inspiration_id = ?')
    .get(calibrationId, inspirationId) as (CalibrationLogRow & { library_id: string }) | undefined;
  if (!row || row.library_id !== libraryId) return;
  if (row.undone_at) return; // 幂等：重复撤销不产生副作用

  const timingRow = loadTiming(inspirationId);
  if (!timingRow) return;

  const field = row.field as CalibrationField;
  const beforeValue = parseJson<unknown>(row.before_value, null);
  const current = snapshotOfRow(timingRow);
  const restored: TimingCalibrationSnapshot = {
    azimuthTolerance: current.azimuthTolerance,
    windowToleranceMin: current.windowToleranceMin,
    cloudCoverPct: current.cloudCoverPct ? { ...current.cloudCoverPct } : null,
  };
  if (field === 'azimuth_tolerance' && typeof beforeValue === 'number') {
    restored.azimuthTolerance = beforeValue;
  } else if (field === 'window_tolerance_min' && typeof beforeValue === 'number') {
    restored.windowToleranceMin = beforeValue;
  } else if (field === 'cloudCoverPct') {
    restored.cloudCoverPct = beforeValue as { min: number; max: number };
  }

  const run = db.transaction(() => {
    persistSnapshot(timingRow.id, restored);
    db.prepare('UPDATE calibration_log SET undone_at = ? WHERE id = ? AND undone_at IS NULL').run(
      nowIso(),
      calibrationId,
    );
  });
  run();
  touch(inspirationId);

  await computeWindowsForInspiration(inspirationId).catch(() => undefined);
}

// 供修订回填（amend）后重新跑一遍校准；主因变化会改变证据指纹，从而允许重新判定。
export async function recalibrateAfterAmend(
  libraryId: string,
  inspirationId: string,
  triggeredBy: string,
): Promise<CalibrationOutcome> {
  return applyCalibration(libraryId, inspirationId, triggeredBy);
}
