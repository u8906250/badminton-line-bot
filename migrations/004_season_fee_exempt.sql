-- 季打可加入不在 LINE 上的人、不收季費（2026-10-11）。既有資料庫執行一次；全新安裝用 schema.sql，不需要執行。
--   npx wrangler d1 execute badminton --remote --file=migrations/004_season_fee_exempt.sql
ALTER TABLE season_members ADD COLUMN fee_exempt INTEGER NOT NULL DEFAULT 0;
