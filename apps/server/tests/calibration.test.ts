import { describe, expect, it } from 'vitest';
import {
  AZIMUTH_TOLERANCE_FLOOR,
  classifyMissCause,
  evidenceFingerprint,
  evaluateCalibration,
  type TimingLike,
} from '@flil/shared';

function timing(patch: Partial<TimingLike> = {}): TimingLike {
  return {
    azimuthTolerance: 15,
    windowToleranceMin: 12,
    weatherProfile: { cloudCoverPct: { min: 10, max: 80 } },
    ...patch,
  };
}

let seq = 0;
function r(hitLevel: 'hit' | 'partial' | 'miss', missReasons: string[] = []) {
  seq += 1;
  return { id: `res${seq}`, hitLevel, missReasons };
}

describe('校准同因口径 classifyMissCause', () => {
  it('单因 timing_off 归因为时间差了', () => {
    expect(classifyMissCause(['timing_off'])).toBe('timing_off');
  });

  it('单因 weather_mismatch 归因为天气不符', () => {
    expect(classifyMissCause(['weather_mismatch'])).toBe('weather_mismatch');
  });

  it('同一条同时勾时间+天气 = 混合偏差，不归因', () => {
    expect(classifyMissCause(['timing_off', 'weather_mismatch'])).toBeNull();
  });

  it('带其它原因（光位不对、人太多等）不影响单因归因', () => {
    expect(classifyMissCause(['timing_off', 'too_crowded'])).toBe('timing_off');
  });

  it('只有不可收紧原因 → 不归因', () => {
    expect(classifyMissCause(['site_rebuilt', 'too_crowded'])).toBeNull();
  });
});

describe('evaluateCalibration：连续三次同因收紧', () => {
  it('连续 3 次单因 timing_off → 收紧方位角容差', () => {
    const out = evaluateCalibration(
      [r('miss', ['timing_off']), r('miss', ['timing_off']), r('miss', ['timing_off'])],
      timing(),
    );
    expect(out.sameCauseStreak).toBe(true);
    expect(out.cause).toBe('timing_off');
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].field).toBe('azimuth_tolerance');
    expect(out.actions[0].before).toBe(15);
    expect(out.actions[0].after).toBe(10);
  });

  it('连续 3 次单因 weather_mismatch → 收窄云量区间，而不是方位角', () => {
    const out = evaluateCalibration(
      [r('miss', ['weather_mismatch']), r('miss', ['weather_mismatch']), r('miss', ['weather_mismatch'])],
      timing(),
    );
    expect(out.sameCauseStreak).toBe(true);
    expect(out.cause).toBe('weather_mismatch');
    expect(out.actions[0].field).toBe('weather_profile.cloudCoverPct');
    expect(out.actions[0].after).toEqual({ min: 15, max: 75 });
  });

  it('★ 三条 miss 的原因各不相同（时间/天气混合出现）→ 不算同因，不收紧', () => {
    const out = evaluateCalibration(
      [
        r('miss', ['weather_mismatch']),
        r('miss', ['timing_off', 'weather_mismatch']),
        r('miss', ['timing_off']),
      ],
      timing(),
    );
    expect(out.sameCauseStreak).toBe(false);
    expect(out.actions).toHaveLength(0);
    expect(out.mixedResultIds).toHaveLength(1);
  });

  it('★ 三条都"各含"时间或天气但并非同一单因 → 不算同因（旧的 some() 逻辑会误判）', () => {
    const out = evaluateCalibration(
      [
        r('miss', ['timing_off', 'weather_mismatch']),
        r('miss', ['timing_off', 'weather_mismatch']),
        r('miss', ['timing_off', 'weather_mismatch']),
      ],
      timing(),
    );
    expect(out.sameCauseStreak).toBe(false);
    expect(out.cause).toBeNull();
    expect(out.actions).toHaveLength(0);
    expect(out.mixedResultIds).toHaveLength(3);
  });

  it('timing/weather 交替单因 → 打断连续，不收紧', () => {
    const out = evaluateCalibration(
      [r('miss', ['timing_off']), r('miss', ['weather_mismatch']), r('miss', ['timing_off'])],
      timing(),
    );
    expect(out.sameCauseStreak).toBe(false);
    expect(out.actions).toHaveLength(0);
  });

  it('中间夹一次 hit/partial → 连续被打断', () => {
    const out = evaluateCalibration(
      [r('miss', ['timing_off']), r('hit'), r('miss', ['timing_off']), r('miss', ['timing_off'])],
      timing(),
    );
    expect(out.sameCauseStreak).toBe(false);
    expect(out.actions).toHaveLength(0);
  });

  it('最近三条窗口之外的更早记录不改变触发判断（同因段可更长，但看三连窗口）', () => {
    const out = evaluateCalibration(
      [
        r('miss', ['timing_off']),
        r('miss', ['timing_off']),
        r('miss', ['timing_off']),
        r('hit'),
        r('miss', ['weather_mismatch']),
      ],
      timing(),
    );
    expect(out.sameCauseStreak).toBe(true);
    expect(out.cause).toBe('timing_off');
    expect(out.window).toHaveLength(3);
  });

  it('其它原因（现场改造等）打断连续，只走建议不走收紧', () => {
    const out = evaluateCalibration(
      [r('miss', ['site_rebuilt']), r('miss', ['timing_off']), r('miss', ['timing_off'])],
      timing(),
    );
    expect(out.sameCauseStreak).toBe(false);
    expect(out.actions).toHaveLength(0);
  });
});

describe('evaluateCalibration：同一段不反复收紧', () => {
  it('段锚点 = 段内最早一条回填；同段再次评估时若已消费则不产出 action', () => {
    const a = r('miss', ['timing_off']);
    const b = r('miss', ['timing_off']);
    const c = r('miss', ['timing_off']);
    const out1 = evaluateCalibration([c, b, a], timing(), []);
    expect(out1.episodeId).toBe(a.id);
    expect(out1.actions).toHaveLength(1);

    const out2 = evaluateCalibration([c, b, a], timing(), [a.id]);
    expect(out2.actions).toHaveLength(0);
  });

  it('证据指纹只取三连窗口且与顺序无关', () => {
    const a = r('miss', ['timing_off']);
    const b = r('miss', ['timing_off']);
    expect(evidenceFingerprint([a, b])).toBe(evidenceFingerprint([b, a]));
  });

  it('★ 三连触发收紧后，第 4、5 次同因 miss 仍属同一段，不再次收紧', () => {
    const a = r('miss', ['timing_off']);
    const b = r('miss', ['timing_off']);
    const c = r('miss', ['timing_off']); // 三连在此完成，段锚点 a
    const d = r('miss', ['timing_off']);
    const e = r('miss', ['timing_off']);
    const atD = evaluateCalibration([d, c, b, a], timing(), [a.id]);
    const atE = evaluateCalibration([e, d, c, b, a], timing(), [a.id]);
    expect(atD.episodeId).toBe(a.id);
    expect(atE.episodeId).toBe(a.id);
    expect(atD.actions).toHaveLength(0);
    expect(atE.actions).toHaveLength(0);
  });

  it('连续被打断后重新攒齐三连（新段、新锚点）→ 可以再次收紧', () => {
    const a = r('miss', ['timing_off']);
    const b = r('miss', ['timing_off']);
    const c = r('miss', ['timing_off']); // 第一段，锚点 a，已收紧
    const hit = r('hit'); // 打断
    const x = r('miss', ['timing_off']);
    const y = r('miss', ['timing_off']);
    const z = r('miss', ['timing_off']); // 第二段，锚点 x
    const out = evaluateCalibration([z, y, x, hit, c, b, a], timing(), [a.id]);
    expect(out.actions).toHaveLength(1);
    expect(out.episodeId).toBe(x.id);
  });

  it('混合偏差打断旧段；其后攒齐的三连是新段', () => {
    const a = r('miss', ['timing_off']);
    const b = r('miss', ['timing_off']);
    const c = r('miss', ['timing_off']); // 第一段锚点 a
    const mixed = r('miss', ['timing_off', 'weather_mismatch']); // 打断
    const x = r('miss', ['timing_off']);
    const y = r('miss', ['timing_off']);
    const z = r('miss', ['timing_off']);
    const out = evaluateCalibration([z, y, x, mixed, c, b, a], timing(), [a.id]);
    expect(out.actions).toHaveLength(1);
    expect(out.episodeId).toBe(x.id);
  });

  it('方位角到底后改收窗口容差；两者都到底给人工建议', () => {
    const floor = timing({ azimuthTolerance: AZIMUTH_TOLERANCE_FLOOR, windowToleranceMin: 12 });
    const out1 = evaluateCalibration(
      [r('miss', ['timing_off']), r('miss', ['timing_off']), r('miss', ['timing_off'])],
      floor,
    );
    expect(out1.actions[0].field).toBe('window_tolerance_min');
    expect(out1.actions[0].after).toBe(9);

    const bottom = timing({ azimuthTolerance: AZIMUTH_TOLERANCE_FLOOR, windowToleranceMin: 6 });
    const out2 = evaluateCalibration(
      [r('miss', ['timing_off']), r('miss', ['timing_off']), r('miss', ['timing_off'])],
      bottom,
    );
    expect(out2.actions).toHaveLength(0);
    expect(out2.suggestions.join(' ')).toContain('人工复核');
  });

  it('天气同因但未设云量区间 → 不收紧，给人工建议', () => {
    const out = evaluateCalibration(
      [r('miss', ['weather_mismatch']), r('miss', ['weather_mismatch']), r('miss', ['weather_mismatch'])],
      timing({ weatherProfile: {} }),
    );
    expect(out.actions).toHaveLength(0);
    expect(out.suggestions.join(' ')).toContain('天气画像');
  });

  it('没有 timing 条件时同因仍可识别，但不产出收紧', () => {
    const out = evaluateCalibration(
      [r('miss', ['timing_off']), r('miss', ['timing_off']), r('miss', ['timing_off'])],
      null,
    );
    expect(out.sameCauseStreak).toBe(true);
    expect(out.actions).toHaveLength(0);
  });
});
