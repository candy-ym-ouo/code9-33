import {
  CALIBRATION_RULE_VERSION,
  evidenceFingerprint,
  evaluateCalibration,
  type CalibrationField,
  type CalibrationResultInput,
} from '@flil/shared';
import type { MissReason } from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { loadTiming, timingRowToDto, computeWindowsForInspiration } from './windowEngine.js';
import { touch } from './inspirations.js';

export interface CalibrationOutcome {
  hitRate: number;
  hitCount: number;
  partialCount: number;
  missCount: number;
  tightened: { field: string; before: unknown; after: unknown }[];
  suggestions: string[];
  /** 最近回填里同时勾了时间+天气的混合偏差记录（不构成同因，仅供留痕/提示） */
  mixedReasons: string[];
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

function lastResults(
  inspirationId: string,
  limit = 5,
): { id: string; hit_level: string; miss_reasons: MissReason[] }[] {
  const rows = getDb()
    .prepare(
      'SELECT id, hit_level, miss_reasons FROM shoot_result WHERE inspiration_id = ? ORDER BY filled_at DESC, rowid DESC LIMIT ?',
    )
    .all(inspirationId, limit) as { id: string; hit_level: string; miss_reasons: string }[];
  return rows.map((r) => ({
    id: r.id,
    hit_level: r.hit_level,
    miss_reasons: parseJson<MissReason[]>(r.miss_reasons, []),
  }));
}

interface CalibrationLogRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  field: string;
  before_value: string | null;
  after_value: string | null;
  reason: string;
  triggered_by: string | null;
  undone_at: string | null;
  created_at: string;
  cause: string | null;
  streak_episode_id: string | null;
  trigger_result_id: string | null;
  evidence_fingerprint: string | null;
  evidence_result_ids: string | null;
  rule_version: number;
}

function logCalibration(entry: {
  libraryId: string;
  inspirationId: string;
  field: string;
  before: unknown;
  after: unknown;
  reason: string;
  triggeredBy: string;
  cause: string;
  episodeId: string;
  triggerResultId: string;
  fingerprint: string;
  evidenceIds: string[];
}): void {
  getDb()
    .prepare(
      `INSERT INTO calibration_log
         (id, library_id, inspiration_id, field, before_value, after_value, reason, triggered_by,
          cause, streak_episode_id, trigger_result_id, evidence_fingerprint, evidence_result_ids,
          rule_version, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newId(),
      entry.libraryId,
      entry.inspirationId,
      entry.field,
      toJson(entry.before),
      toJson(entry.after),
      entry.reason,
      entry.triggeredBy,
      entry.cause,
      entry.episodeId,
      entry.triggerResultId,
      entry.fingerprint,
      toJson(entry.evidenceIds),
      CALIBRATION_RULE_VERSION,
      nowIso(),
    );
}

/**
 * 收紧与撤销**共用的唯一定值落点**：
 * 同一字段的写入逻辑只在这里出现一次，保证撤销恢复的值与收紧前完全同口径。
 * weather_profile 只替换 cloudCoverPct，其余画像键原样保留。
 */
function writeFieldValue(timingId: string, field: CalibrationField, value: unknown): void {
  const db = getDb();
  if (field === 'azimuth_tolerance') {
    db.prepare('UPDATE timing SET azimuth_tolerance = ?, updated_at = ? WHERE id = ?').run(
      value as number,
      nowIso(),
      timingId,
    );
  } else if (field === 'window_tolerance_min') {
    db.prepare('UPDATE timing SET window_tolerance_min = ?, updated_at = ? WHERE id = ?').run(
      value as number,
      nowIso(),
      timingId,
    );
  } else if (field === 'weather_profile.cloudCoverPct') {
    const timing = loadTimingById(timingId);
    const profile = parseJson<{ cloudCoverPct?: unknown }>(timing?.weather_profile ?? '{}', {});
    profile.cloudCoverPct = value;
    db.prepare('UPDATE timing SET weather_profile = ?, updated_at = ? WHERE id = ?').run(
      toJson(profile),
      nowIso(),
      timingId,
    );
  }
}

function loadTimingById(timingId: string) {
  return getDb().prepare('SELECT * FROM timing WHERE id = ?').get(timingId) as
    | { weather_profile: string }
    | undefined;
}

/**
 * 已经收紧过的同因连续段锚点集合（**含已撤销记录**）。
 * 撤销代表"人不认可这次收紧"，因此该段不会被释放：三连之后继续回填
 * 的同因 miss 属于同一段，不会反复收紧；必须打断连续并另起新段。
 */
function consumedEpisodeIds(inspirationId: string): Set<string> {
  const rows = getDb()
    .prepare('SELECT streak_episode_id FROM calibration_log WHERE inspiration_id = ?')
    .all(inspirationId) as { streak_episode_id: string | null }[];
  return new Set(rows.map((r) => r.streak_episode_id).filter((x): x is string => x !== null));
}

/**
 * 回填后的校准（文档 6.3 规则 2/3）：
 * 连续 3 次**单因相同**的 miss → 收紧一档；混合偏差（同一条同时勾时间与
 * 天气）无法归因，不触发收紧。site_rebuilt 出现 2 次 → 建议归档。
 * **只收紧判断与给建议，绝不自动改卡片状态**——人的决定由人做。
 *
 * 判断走共享纯函数 evaluateCalibration；收紧后按同一 timing 立即重算窗口，
 * 保证判定、留痕、撤销、窗口四处口径一致、可复算。
 */
export async function applyCalibration(
  libraryId: string,
  inspirationId: string,
  triggeredBy: string,
): Promise<CalibrationOutcome> {
  const db = getDb();
  const stats = recomputeHitRate(inspirationId);
  const results = lastResults(inspirationId, 5);
  const tightened: CalibrationOutcome['tightened'] = [];
  const suggestions: string[] = [];

  const timingRow = loadTiming(inspirationId);
  const timing = timingRow ? timingRowToDto(timingRow) : null;

  // —— 唯一判断口径 ——
  const evaluation = evaluateCalibration(
    results.map(
      (r): CalibrationResultInput => ({
        id: r.id,
        hitLevel: r.hit_level as CalibrationResultInput['hitLevel'],
        missReasons: r.miss_reasons,
      }),
    ),
    timing,
    consumedEpisodeIds(inspirationId),
  );

  suggestions.push(...evaluation.suggestions);

  if (timingRow && evaluation.actions.length && evaluation.episodeId) {
    // 留痕窗口固定为最近三连（最新在前），触发回填 = 三连最新一条；
    // actions 非空时 window 必有 3 条（由同一口径保证）
    const episodeId = evaluation.episodeId;
    const evidenceWindow = evaluation.window;
    const fingerprint = evidenceFingerprint(evidenceWindow);
    const evidenceIds = evidenceWindow.map((r) => r.id);
    const triggerResultIdValue = evidenceWindow[0].id;
    const apply = db.transaction(() => {
      for (const action of evaluation.actions) {
        writeFieldValue(timingRow.id, action.field, action.after);
        logCalibration({
          libraryId,
          inspirationId,
          field: action.field,
          before: action.before,
          after: action.after,
          reason: action.reason,
          triggeredBy,
          cause: action.cause,
          episodeId,
          triggerResultId: triggerResultIdValue,
          fingerprint,
          evidenceIds,
        });
        tightened.push({ field: action.field, before: action.before, after: action.after });
      }
    });
    apply();
  }

  // 非同因类建议（与收紧口径无关，按最近 5 条回填计数）
  if (results.filter((r) => r.miss_reasons.includes('site_rebuilt')).length >= 2) {
    suggestions.push('该地点已有 2 次「现场已改造」记录，建议归档这张卡（系统不会自动改状态）。');
  }
  if (results.filter((r) => r.miss_reasons.includes('too_crowded')).length >= 2) {
    suggestions.push('该地点已有 2 次「人太多」记录，建议在机位备注里补充备用时段。');
  }

  if (tightened.length) {
    touch(inspirationId);
    // —— 窗口与判断共用落库后的同一份 timing，立即按新条件复算 ——
    await computeWindowsForInspiration(inspirationId).catch(() => {
      // 天气源不可用等情况下窗口重算失败不影响校准本身；下一轮扫描会补齐
    });
  }

  return { ...stats, tightened, suggestions, mixedReasons: evaluation.mixedResultIds };
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
    episodeId: r.streak_episode_id,
    triggerResultId: r.trigger_result_id,
    evidence: r.evidence_result_ids ? parseJson<string[]>(r.evidence_result_ids, []) : [],
    ruleVersion: r.rule_version,
    undoneAt: r.undone_at ?? null,
    createdAt: r.created_at,
  }));
}

/**
 * 撤销一次收窄（校准必须可回溯、可撤销）。
 * 恢复值走与收紧相同的 {@link writeFieldValue} 落点，并按恢复后的 timing
 * 立即重算窗口；证据指纹保留（撤销后旧证据不会再触发同一收紧）。
 */
export async function undoCalibration(
  calibrationId: string,
  libraryId: string,
  inspirationId: string,
): Promise<void> {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM calibration_log WHERE id = ? AND inspiration_id = ?')
    .get(calibrationId, inspirationId) as CalibrationLogRow | undefined;
  if (!row || row.library_id !== libraryId || row.undone_at) return;

  const timing = loadTiming(inspirationId);
  const restore = db.transaction(() => {
    if (timing) {
      writeFieldValue(
        timing.id,
        row.field as CalibrationField,
        parseJson<unknown>(row.before_value, null),
      );
    }
    db.prepare('UPDATE calibration_log SET undone_at = ? WHERE id = ?').run(nowIso(), calibrationId);
  });
  restore();

  if (timing) {
    touch(inspirationId);
    await computeWindowsForInspiration(inspirationId).catch(() => {
      // 重算失败不阻断撤销；下一轮扫描会按恢复后的条件补齐
    });
  }
}
