-- 校准留痕补齐"可复算证据"：判断口径、证据窗口与归一主因一并落库，
-- 判断 / 留痕 / 撤销 / 窗口四方共享同一份证据（文档 6.3）。
ALTER TABLE calibration_log ADD COLUMN cause TEXT;
ALTER TABLE calibration_log ADD COLUMN evidence TEXT;
