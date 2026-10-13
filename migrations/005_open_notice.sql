-- 開放報名通知（2026-10-11）。既有資料庫執行一次；全新安裝用 schema.sql，不需要執行。
--   npx wrangler d1 execute badminton --remote --file=migrations/005_open_notice.sql
ALTER TABLE sessions ADD COLUMN open_notified_at TEXT;
