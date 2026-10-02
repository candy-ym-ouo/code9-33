import { MissReason } from './enums.js';
import type { TimingDto } from './types.js';

/**
 * 校准口径（文档 6.3 规则 2/3）
 * ----------------------------------------
 * 判断、留痕、撤销与窗口重算**共用本文件的同一份纯函数口径**：
 * 任何一方想回答"这次回填该不该收紧、收紧哪个字段"，都必须经由
 * {@link evaluateCalibration}，不允许各自再写一套判断。
 *
 * 设计要点：
 * 1. **同因必须是单因**：一次 miss 同时勾了「时间差了」和「天气不符」
 *    属于混合偏差，无法归因到任何一个可收紧项——既不算 timing 同因，
 *    也不算 weather 同因，更不会被"任一命中"式判断吞掉。
 * 2. **只认最近连续 3 次 miss**：中间夹一次 hit/partial、一次混合偏差
 *    或一次其它原因，即打断连续。
 * 3. **触发去重以"同因连续段（episode）"为锚**：一次未被打断的同因
 *    miss 连续段至多收紧一档——三连触发后，第 4、5 次同因 miss 只是
 *    同一段在继续，不会因"三连窗口滑动"而反复收紧；撤销也不释放该段。
 *    只有连续段被打断（hit/partial/混合偏差/其它原因）后重新攒齐三连，
 *    才作为新的一段再次收紧。
 */

/** 可归因、可据此收紧的偏差原因（其它原因只给建议，不触发收紧） */
export type CalibrationCause =
  | (typeof MissReason.timingOff)
  | (typeof MissReason.weatherMismatch);

export interface CalibrationResultInput {
  id: string;
  hitLevel: 'hit' | 'partial' | 'miss';
  missReasons: readonly string[];
}

export interface TimingLike {
  azimuthTolerance: number;
  windowToleranceMin: number;
  weatherProfile: Pick<TimingDto['weatherProfile'], 'cloudCoverPct'>;
}

/** 收紧档位常量——判断侧与留痕文案共用，避免魔法数字在各处漂移 */
export const CALIBRATION_RULE_VERSION = 1;
export const CALIBRATION_STREAK = 3;
export const AZIMUTH_TOLERANCE_FLOOR = 8;
export const AZIMUTH_TOLERANCE_STEP = 5;
export const WINDOW_TOLERANCE_FLOOR = 6;
export const WINDOW_TOLERANCE_STEP = 3;
export const CLOUD_BAND_MIN_WIDTH = 15;
export const CLOUD_BAND_SHRINK = 5;

/**
 * 把单次 miss 归因到**唯一一个**可收紧原因。
 * @returns 可归因原因；混合偏差 / 无可收紧原因 → null（不归因）
 */
export function classifyMissCause(missReasons: readonly string[]): CalibrationCause | null {
  const timing = missReasons.includes(MissReason.timingOff);
  const weather = missReasons.includes(MissReason.weatherMismatch);
  if (timing && weather) return null; // 混合偏差：无法归因
  if (timing) return MissReason.timingOff;
  if (weather) return MissReason.weatherMismatch;
  return null;
}

export type CalibrationField =
  | 'azimuth_tolerance'
  | 'window_tolerance_min'
  | 'weather_profile.cloudCoverPct';

export interface CalibrationAction {
  field: CalibrationField;
  before: unknown;
  after: unknown;
  reason: string;
  cause: CalibrationCause;
}

export interface CalibrationEvaluation {
  /** 最近回填是否构成连续 3 次同因 miss（混合偏差不算同因） */
  sameCauseStreak: boolean;
  /** 连续段的共同原因；不构成同因时为 null */
  cause: CalibrationCause | null;
  /** 最近 3 条回填（最新在前）——参与同因判断与留痕的窗口 */
  window: CalibrationResultInput[];
  /** 当前未被打断的同因 miss 连续段（最新在前，可能长于 3 条） */
  streak: CalibrationResultInput[];
  /** 连续段锚点：段内最早一条回填 ID；同一段无论多长只收紧一次 */
  episodeId: string | null;
  /** 最近回填中"同时勾时间+天气"的混合偏差记录 ID */
  mixedResultIds: string[];
  /** 同因但当前条件已无档可收时给出的人工建议 */
  suggestions: string[];
  /** 本次应执行的收紧（至多一条；该段已收紧过或已到底时为空） */
  actions: CalibrationAction[];
}

/**
 * 唯一校准口径：给定回填序列（最新在前）、当前 timing 与已收紧过的
 * 同因连续段锚点集合，产出是否收紧、收紧哪一项的确定性结论。
 *
 * @param consumedEpisodeIds 已经收紧过的连续段（段内最早回填 ID）；
 *   撤销后仍保留——同一段不会二次收紧，必须打断后重新攒齐三连。
 */
export function evaluateCalibration(
  results: readonly CalibrationResultInput[],
  timing: TimingLike | null,
  consumedEpisodeIds: Iterable<string> = [],
): CalibrationEvaluation {
  const window3 = results.slice(0, CALIBRATION_STREAK);
  // 先在 3 条窗口内标出混合偏差（即使它打断了连续，也要完整留痕）
  const mixedResultIds = window3
    .filter(
      (r) =>
        r.missReasons.includes(MissReason.timingOff) &&
        r.missReasons.includes(MissReason.weatherMismatch),
    )
    .map((r) => r.id);

  // 沿完整历史向前，构建当前未被打断的同因 miss 连续段（遇打断即停）。
  // 段可能长于 3 条：三连之后的第 4、5 次同因 miss 仍属于同一段。
  const streak: CalibrationResultInput[] = [];
  let cause: CalibrationCause | null = null;
  for (const r of results) {
    if (r.hitLevel !== 'miss') break; // 连续性只允许 miss
    const c = classifyMissCause(r.missReasons);
    if (c === null) break; // 混合偏差 / 其它原因 → 打断同因连续
    if (cause === null) cause = c;
    else if (cause !== c) break; // 两种可归因原因交替 → 不是同一段
    streak.push(r);
  }

  const sameCauseStreak = streak.length >= CALIBRATION_STREAK && cause !== null;
  // 段锚点 = 段内最早一条（序列最新在前，即末尾）
  const episodeId = streak.length ? streak[streak.length - 1].id : null;
  const alreadyTightened = episodeId !== null && new Set(consumedEpisodeIds).has(episodeId);
  const actions: CalibrationAction[] = [];
  const suggestions: string[] = [];

  if (sameCauseStreak && timing && cause && !alreadyTightened) {
    if (cause === MissReason.timingOff) {
      if (timing.azimuthTolerance > AZIMUTH_TOLERANCE_FLOOR) {
        const before = timing.azimuthTolerance;
        const after = Math.max(AZIMUTH_TOLERANCE_FLOOR, before - AZIMUTH_TOLERANCE_STEP);
        actions.push({
          field: 'azimuth_tolerance',
          before,
          after,
          cause,
          reason: `连续 ${CALIBRATION_STREAK} 次未命中且同因「时间差了」，方位角容差收紧一档（${before}°→${after}°）`,
        });
      } else if (timing.windowToleranceMin > WINDOW_TOLERANCE_FLOOR) {
        const before = timing.windowToleranceMin;
        const after = Math.max(WINDOW_TOLERANCE_FLOOR, before - WINDOW_TOLERANCE_STEP);
        actions.push({
          field: 'window_tolerance_min',
          before,
          after,
          cause,
          reason: `连续 ${CALIBRATION_STREAK} 次未命中且同因「时间差了」，方位角容差已到底，窗口容差收紧一档（${before}→${after} 分钟）`,
        });
      } else {
        suggestions.push(
          `连续 ${CALIBRATION_STREAK} 次同因「时间差了」，但方位角与窗口容差都已到底，无法继续自动收紧；请人工复核时间锚或机位。`,
        );
      }
    } else {
      const band = timing.weatherProfile.cloudCoverPct;
      if (band && band.max - band.min > CLOUD_BAND_MIN_WIDTH) {
        const before = { ...band };
        const after = { min: band.min + CLOUD_BAND_SHRINK, max: band.max - CLOUD_BAND_SHRINK };
        actions.push({
          field: 'weather_profile.cloudCoverPct',
          before,
          after,
          cause,
          reason: `连续 ${CALIBRATION_STREAK} 次未命中且同因「天气不符」，云量目标区间收窄一档（${before.min}%–${before.max}%→${after.min}%–${after.max}%）`,
        });
      } else {
        suggestions.push(
          `连续 ${CALIBRATION_STREAK} 次同因「天气不符」，但云量区间已无档可收（或未设云量目标），无法自动收紧；请人工复核天气画像。`,
        );
      }
    }
  }

  return { sameCauseStreak, cause, window: window3, streak, episodeId, mixedResultIds, suggestions, actions };
}

/**
 * 证据指纹：一次收紧所依据的最近 3 条回填 ID（排序后拼接）。
 * 仅用于留痕/排障复算；去重以连续段锚点 episodeId 为准（见 evaluateCalibration）。
 */
export function evidenceFingerprint(streak: readonly Pick<CalibrationResultInput, 'id'>[]): string {
  return streak
    .map((r) => r.id)
    .slice(0, CALIBRATION_STREAK)
    .sort()
    .join('|');
}
