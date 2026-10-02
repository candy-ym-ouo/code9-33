-- 校准留痕补齐可复算口径（与判断侧 evaluateCalibration 对应）：
-- cause                 触发收紧的唯一同因（timing_off / weather_mismatch）
-- streak_episode_id     同因连续段锚点（段内最早一条回填 ID）：同一段至多收紧一次，撤销也不释放
-- trigger_result_id     完成"连续 3 次同因"的那条回填 ID（三连窗口的最新一条）
-- evidence_fingerprint  三连回填 ID 指纹（排序后 | 连接），供人工复算
-- evidence_result_ids   三连回填 ID（JSON 数组，最新在前）
-- rule_version          判定口径版本，未来口径调整后可区分历史记录按哪版算出
ALTER TABLE calibration_log ADD COLUMN cause TEXT;
ALTER TABLE calibration_log ADD COLUMN streak_episode_id TEXT;
ALTER TABLE calibration_log ADD COLUMN trigger_result_id TEXT;
ALTER TABLE calibration_log ADD COLUMN evidence_fingerprint TEXT;
ALTER TABLE calibration_log ADD COLUMN evidence_result_ids TEXT;
ALTER TABLE calibration_log ADD COLUMN rule_version INTEGER NOT NULL DEFAULT 1;

-- 同一个同因连续段至多收紧一次（含已撤销记录）：
-- 三连之后第 4/5 次同因 miss 不会反复收紧；必须打断后另起一段。
CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_streak_episode
  ON calibration_log (streak_episode_id);
