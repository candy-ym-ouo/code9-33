import { describe, expect, it } from 'vitest';
import {
  applyTightening,
  CALIBRATION_RULES,
  canTighten,
  evaluateCalibration,
  fieldForCause,
  fingerprintOf,
  primaryCause,
  type ResultEvidence,
  type TimingCalibrationSnapshot,
} from '@flil/shared';

function result(
  id: string,
  hitLevel: string,
  missReasons: string[],
  filledAt = `2026-01-0${id}T10:00:00.000Z`,
): ResultEvidence {
  return { id, hitLevel, missReasons: missReasons as ResultEvidence['missReasons'], filledAt };
}

const baseSnap: TimingCalibrationSnapshot = {
  azimuthTolerance: 15,
  windowToleranceMin: 12,
  cloudCoverPct: { min: 20, max: 80 },
};

describe('primaryCause / fieldForCause 归一口径', () => {
  it('混合偏差只归一为一个主因，且优先级固定（时间 > 光位 > 天气）', () => {
    expect(primaryCause(['weather_mismatch', 'timing_off'])).toBe('timing_off');
    expect(primaryCause(['weather_mismatch', 'light_direction_wrong'])).toBe('light_direction_wrong');
    expect(primaryCause(['weather_mismatch'])).toBe('weather_mismatch');
    expect(primaryCause(['site_rebuilt', 'too_crowded'])).toBeNull();
  });

  it('每个主因映射到唯一字段', () => {
    expect(fieldForCause('timing_off')).toBe('window_tolerance_min');
    expect(fieldForCause('light_direction_wrong')).toBe('azimuth_tolerance');
    expect(fieldForCause('weather_mismatch')).toBe('cloudCoverPct');
    expect(fieldForCause(null)).toBeNull();
  });
});

describe('evaluateCalibration 同因判断', () => {
  it('连续 3 次同一主因 miss 才触发', () => {
    const d = evaluateCalibration([
      result('3', 'miss', ['timing_off']),
      result('2', 'miss', ['timing_off']),
      result('1', 'miss', ['timing_off']),
    ]);
    expect(d.shouldTighten).toBe(true);
    expect(d.cause).toBe('timing_off');
    expect(d.field).toBe('window_tolerance_min');
    expect(d.window).toHaveLength(3);
    expect(d.fingerprint).toBeTruthy();
  });

  it('三次混合偏差（时间/天气/光位各一）不得判为同因——本次缺陷的核心断言', () => {
    const d = evaluateCalibration([
      result('3', 'miss', ['timing_off']),
      result('2', 'miss', ['weather_mismatch']),
      result('1', 'miss', ['light_direction_wrong']),
    ]);
    expect(d.shouldTighten).toBe(false);
    expect(d.cause).toBeNull();
    expect(d.field).toBeNull();
    expect(d.fingerprint).toBeNull();
  });

  it('每条都勾了时间+天气的混合偏差，归一后主因一致才触发；否则不触发', () => {
    const same = evaluateCalibration([
      result('3', 'miss', ['timing_off', 'weather_mismatch']),
      result('2', 'miss', ['timing_off', 'weather_mismatch']),
      result('1', 'miss', ['timing_off', 'weather_mismatch']),
    ]);
    expect(same.shouldTighten).toBe(true);
    expect(same.cause).toBe('timing_off');

    // 两条 timing+weather、一条只 weather：归一主因 timing/timing/weather → 不同因，不触发
    const mixed = evaluateCalibration([
      result('3', 'miss', ['timing_off', 'weather_mismatch']),
      result('2', 'miss', ['timing_off', 'weather_mismatch']),
      result('1', 'miss', ['weather_mismatch']),
    ]);
    expect(mixed.shouldTighten).toBe(false);
  });

  it('链条被 hit/partial 打断：最近一条不是 miss 就不触发', () => {
    const d = evaluateCalibration([
      result('4', 'hit', []),
      result('3', 'miss', ['timing_off']),
      result('2', 'miss', ['timing_off']),
      result('1', 'miss', ['timing_off']),
    ]);
    expect(d.shouldTighten).toBe(false);
    expect(d.window).toHaveLength(0);
  });

  it('只有 2 次 miss 不触发', () => {
    const d = evaluateCalibration([
      result('2', 'miss', ['timing_off']),
      result('1', 'miss', ['timing_off']),
    ]);
    expect(d.shouldTighten).toBe(false);
  });

  it('不可校准原因打断链条（自己没到不计入）', () => {
    const d = evaluateCalibration([
      result('4', 'miss', ['timing_off']),
      result('3', 'miss', ['did_not_arrive']),
      result('2', 'miss', ['timing_off']),
      result('1', 'miss', ['timing_off']),
    ]);
    expect(d.shouldTighten).toBe(false);
    expect(d.window).toHaveLength(1);
  });
});

describe('证据指纹', () => {
  it('同一批证据指纹与顺序无关（可复算）', () => {
    const win = [
      result('3', 'miss', ['timing_off']),
      result('2', 'miss', ['timing_off']),
      result('1', 'miss', ['timing_off']),
    ];
    expect(fingerprintOf(win)).toBe(fingerprintOf([...win].reverse()));
  });

  it('原因被修订后指纹改变——修订允许重新判定', () => {
    const before = [result('1', 'miss', ['timing_off'])];
    const after = [result('1', 'miss', ['weather_mismatch'])];
    expect(fingerprintOf(before)).not.toBe(fingerprintOf(after));
  });
});

describe('收紧档位与撤销逆运算', () => {
  it('时间偏差收紧窗口容差 12→9，下限 6', () => {
    const next = applyTightening('window_tolerance_min', baseSnap);
    expect(next.windowToleranceMin).toBe(9);
    expect(applyTightening('window_tolerance_min', next).windowToleranceMin).toBe(6);
    const atFloor = applyTightening('window_tolerance_min', { ...next, windowToleranceMin: 6 });
    expect(atFloor.windowToleranceMin).toBe(6);
    expect(canTighten('window_tolerance_min', atFloor)).toBe(false);
  });

  it('光位偏差收紧方位角 15→10→8，到下限 8 不再收紧', () => {
    const once = applyTightening('azimuth_tolerance', baseSnap);
    expect(once.azimuthTolerance).toBe(10);
    const twice = applyTightening('azimuth_tolerance', once);
    expect(twice.azimuthTolerance).toBe(CALIBRATION_RULES.azimuth_tolerance.floor);
    expect(applyTightening('azimuth_tolerance', twice).azimuthTolerance).toBe(8);
    expect(canTighten('azimuth_tolerance', twice)).toBe(false);
  });

  it('天气偏差两侧各收 5 个百分点，宽度低于 25（=下限+2*步长）即停', () => {
    const once = applyTightening('cloudCoverPct', baseSnap);
    expect(once.cloudCoverPct).toEqual({ min: 25, max: 75 });
    let s = once;
    while (canTighten('cloudCoverPct', s)) s = applyTightening('cloudCoverPct', s);
    // 20..80(宽60) → 25..75 → 30..70 → 35..65 → 40..60(宽20)，再收会越过宽度下限 15，停
    expect(s.cloudCoverPct).toEqual({ min: 40, max: 60 });
    expect(canTighten('cloudCoverPct', s)).toBe(false);
  });

  it('未设云量区间时天气偏差无法收紧（不写空记录）', () => {
    const noCloud: TimingCalibrationSnapshot = { ...baseSnap, cloudCoverPct: null };
    expect(canTighten('cloudCoverPct', noCloud)).toBe(false);
    expect(applyTightening('cloudCoverPct', noCloud)).toEqual(noCloud);
  });

  it('收紧不修改入参（撤销回放依赖不可变快照）', () => {
    const copy = { ...baseSnap, cloudCoverPct: { ...baseSnap.cloudCoverPct! } };
    applyTightening('cloudCoverPct', baseSnap);
    expect(baseSnap).toEqual(copy);
  });
});
