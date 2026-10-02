import { MissReason } from './enums.js';

/**
 * 校准的唯一可复算口径（文档 6.3 规则 2/3）。
 *
 * 四方共享同一套纯函数，任何一方都不得自行另立口径：
 *   1. 判断  —— evaluateCalibration：是否触发、触发哪个字段；
 *   2. 留痕  —— buildCalibrationReason / 证据指纹：写进 calibration_log 的内容；
 *   3. 撤销  —— applyTightening 的逆运算，按证据快照回放；
 *   4. 窗口  —— tightening 后用同一份 TimingDto 重算 computeDay。
 */

/** 可被自动收紧的三个字段，各自对应唯一的偏差因 */
export const CALIBRATION_FIELDS = ['azimuth_tolerance', 'window_tolerance_min', 'cloudCoverPct'] as const;
export type CalibrationField = (typeof CALIBRATION_FIELDS)[number];

export interface FieldRule {
  /** 一次收紧的步长 */
  step: number;
  /** 允许收紧到的下限（到限不再收紧，避免条件被收到不可能成立） */
  floor: number;
  /** 留痕/建议里的人类可读名称 */
  label: string;
}

/**
 * 字段档位是唯一事实源：判断"能不能再收"、留痕的前后值、撤销时的合法性校验都取这里。
 */
export const CALIBRATION_RULES: Record<CalibrationField, FieldRule> = {
  azimuth_tolerance: { step: 5, floor: 8, label: '方位角容差' },
  window_tolerance_min: { step: 3, floor: 6, label: '窗口时间容差' },
  cloudCoverPct: { step: 5, floor: 15, label: '云量区间宽度' },
};

/**
 * 一次回填只认定一个"校准主因"，映射到唯一字段。
 * 同一条回填同时勾了多个校准类原因（混合偏差）时，按此固定优先级取一个，
 * 保证判断、留痕、撤销、窗口在任何时间重算结果一致，且绝不"一条结果算两个因"。
 */
const CAUSE_PRIORITY: ReadonlyArray<{ cause: MissReason; field: CalibrationField; causeLabel: string }> = [
  { cause: MissReason.timingOff, field: 'window_tolerance_min', causeLabel: '时间差了' },
  { cause: MissReason.lightDirectionWrong, field: 'azimuth_tolerance', causeLabel: '光位不对' },
  { cause: MissReason.weatherMismatch, field: 'cloudCoverPct', causeLabel: '天气不符' },
];

/** 可触发收紧的原因集合（其余原因如现场改造/人太多只给建议，不动条件） */
export const CALIBRATABLE_CAUSES: ReadonlySet<MissReason> = new Set(CAUSE_PRIORITY.map((c) => c.cause));

/** 取一条回填结果的校准主因；不含任何可校准原因时返回 null */
export function primaryCause(reasons: readonly MissReason[]): MissReason | null {
  for (const c of CAUSE_PRIORITY) {
    if (reasons.includes(c.cause)) return c.cause;
  }
  return null;
}

/** 主因 → 应收紧的唯一字段；非校准原因返回 null */
export function fieldForCause(cause: MissReason | null): CalibrationField | null {
  return CAUSE_PRIORITY.find((c) => c.cause === cause)?.field ?? null;
}

/** 主因的人类可读名称（留痕文案统一取这里） */
export function labelForCause(cause: MissReason): string {
  return CAUSE_PRIORITY.find((c) => c.cause === cause)?.causeLabel ?? cause;
}

export interface ResultEvidence {
  id: string;
  hitLevel: string;
  missReasons: MissReason[];
  filledAt: string;
}

/** 收紧时用于回放/复算的条件快照（留痕的 before/after 都以此结构存放） */
export interface TimingCalibrationSnapshot {
  azimuthTolerance: number;
  windowToleranceMin: number;
  cloudCoverPct: { min: number; max: number } | null;
}

export interface CalibrationDecision {
  /** 是否构成"连续 3 次同因 miss" */
  shouldTighten: boolean;
  /** 三次共同的校准主因（混合偏差下为按优先级归一后的单一主因） */
  cause: MissReason | null;
  /** 应收紧的字段；null 表示无对应字段 */
  field: CalibrationField | null;
  /** 证据窗口：实际参与判断的最近连续 miss（自新向旧，最多 3 条） */
  window: ResultEvidence[];
  /**
   * 证据指纹：三条结果 id 排序后拼接。
   * 同一批证据只允许收紧一次（即使后来被撤销），避免滑动窗口对同一批 miss 反复收紧。
   */
  fingerprint: string | null;
  /** 归一后的主因序列（自新向旧），供留痕展示"三次各自是什么因" */
  causeSignatures: MissReason[];
}

/**
 * 判断的唯一入口（纯函数，可随时复算）。
 *
 * 规则：
 * - 只看"最近一段连续 miss"——一旦出现 hit/partial，链条立即中断（连续才算连续）；
 * - 每条 miss 按固定优先级归一为单一校准主因；三次主因完全相同才是"同因"，
 *   三次里混合了不同校准因（如时间/天气/光位）→ 不触发；
 * - 含不可校准原因（自己没到/现场改造等）的 miss 不计入链条。
 */
export function evaluateCalibration(results: readonly ResultEvidence[]): CalibrationDecision {
  const window: ResultEvidence[] = [];
  const causeSignatures: MissReason[] = [];

  for (const r of results) {
    if (r.hitLevel !== 'miss') break;
    const cause = primaryCause(r.missReasons);
    if (!cause) break;
    window.push(r);
    causeSignatures.push(cause);
    if (window.length === 3) break;
  }

  const sameCause = window.length === 3 && causeSignatures.every((c) => c === causeSignatures[0]);
  const cause: MissReason | null = sameCause ? (causeSignatures[0] ?? null) : null;

  return {
    shouldTighten: sameCause,
    cause,
    field: fieldForCause(cause),
    window,
    fingerprint: sameCause ? fingerprintOf(window) : null,
    causeSignatures: sameCause ? causeSignatures : [],
  };
}

/**
 * 证据指纹（纯函数，留痕与查重共用）。
 * 指纹同时绑定结果 id 与其归一主因：回填被修订（amend）导致原因变化时，
 * 指纹随之改变，修订后的证据才能被重新判定与收紧。
 */
export function fingerprintOf(window: readonly ResultEvidence[]): string {
  return window
    .map((r) => `${r.id}:${primaryCause(r.missReasons) ?? 'none'}`)
    .sort()
    .join('|');
}

/** 取快照中某字段的当前值（收紧、留痕前后值、撤销回放共用同一索引口径） */
export function snapshotValue(
  field: CalibrationField,
  snap: TimingCalibrationSnapshot,
): number | { min: number; max: number } | null {
  if (field === 'cloudCoverPct') return snap.cloudCoverPct;
  return field === 'azimuth_tolerance' ? snap.azimuthTolerance : snap.windowToleranceMin;
}

/**
 * 某字段按当前快照是否还能再收紧一档（判断与留痕共用，避免"到限仍记一条收紧"）。
 * 统一不变量：收紧后的值仍不得越过 floor——标量靠 Math.max 夹取，
 * 云量区间两侧各收 step、宽度减少 2*step，故要求 当前宽度 - 2*step >= floor。
 */
export function canTighten(field: CalibrationField, snap: TimingCalibrationSnapshot): boolean {
  if (field === 'cloudCoverPct') {
    if (!snap.cloudCoverPct) return false;
    const width = snap.cloudCoverPct.max - snap.cloudCoverPct.min;
    return width - 2 * CALIBRATION_RULES.cloudCoverPct.step >= CALIBRATION_RULES.cloudCoverPct.floor;
  }
  const current = field === 'azimuth_tolerance' ? snap.azimuthTolerance : snap.windowToleranceMin;
  return current > CALIBRATION_RULES[field].floor;
}

/**
 * 施加一档收紧，返回新快照（不修改入参）。到限或字段无法收紧时原样返回。
 * 这是收紧的唯一运算口径；撤销即对留痕快照做逆回放。
 */
export function applyTightening(field: CalibrationField, snap: TimingCalibrationSnapshot): TimingCalibrationSnapshot {
  const next: TimingCalibrationSnapshot = {
    azimuthTolerance: snap.azimuthTolerance,
    windowToleranceMin: snap.windowToleranceMin,
    cloudCoverPct: snap.cloudCoverPct ? { ...snap.cloudCoverPct } : null,
  };
  if (!canTighten(field, snap)) return next;
  const { step } = CALIBRATION_RULES[field];
  if (field === 'cloudCoverPct' && next.cloudCoverPct) {
    next.cloudCoverPct = { min: next.cloudCoverPct.min + step, max: next.cloudCoverPct.max - step };
  } else if (field === 'azimuth_tolerance') {
    next.azimuthTolerance = Math.max(CALIBRATION_RULES.azimuth_tolerance.floor, next.azimuthTolerance - step);
  } else if (field === 'window_tolerance_min') {
    next.windowToleranceMin = Math.max(
      CALIBRATION_RULES.window_tolerance_min.floor,
      next.windowToleranceMin - step,
    );
  }
  return next;
}

/** 收紧幅度的人类可读描述（留痕 reason 与建议共用同一文案口径） */
export function describeChange(field: CalibrationField, before: TimingCalibrationSnapshot): string {
  const rule = CALIBRATION_RULES[field];
  if (field === 'cloudCoverPct' && before.cloudCoverPct) {
    return `云量区间 [${before.cloudCoverPct.min}%, ${before.cloudCoverPct.max}%] 两侧各收窄 ${rule.step} 个百分点（下限宽度 ${rule.floor}%）`;
  }
  if (field === 'azimuth_tolerance') {
    return `方位角容差 ${before.azimuthTolerance}° → ${Math.max(rule.floor, before.azimuthTolerance - rule.step)}°`;
  }
  return `窗口时间容差 ${before.windowToleranceMin} 分钟 → ${Math.max(
    rule.floor,
    before.windowToleranceMin - rule.step,
  )} 分钟`;
}

/**
 * 留痕理由的唯一构造口径：写进 calibration_log.reason 的每一个字都来自这里。
 * 拿着日志里的证据（cause + evidence 快照 + before/after）即可独立复算整条结论。
 */
export function buildCalibrationReason(input: {
  cause: MissReason;
  field: CalibrationField;
  window: readonly Pick<ResultEvidence, 'filledAt'>[];
  before: TimingCalibrationSnapshot;
}): string {
  const dates = input.window.map((r) => r.filledAt.slice(0, 10)).join('、');
  return (
    `连续 3 次未命中且同一校准主因「${labelForCause(input.cause)}」（回填日期：${dates}），` +
    `${describeChange(input.field, input.before)}，收紧一档`
  );
}
