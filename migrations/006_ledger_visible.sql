-- 帳本要不要給季打成員看（2026-10-12）。既有資料庫執行一次；全新安裝用 schema.sql，不需要執行。
--   npx wrangler d1 execute badminton --remote --file=migrations/006_ledger_visible.sql
-- 預設 1：維持原本的行為（季打成員看得到唯讀的帳本），要關掉由管理員在「設定」取消勾選。
ALTER TABLE clubs ADD COLUMN ledger_visible INTEGER NOT NULL DEFAULT 1;
