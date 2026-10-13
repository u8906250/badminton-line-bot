-- 臨打費分男女（2026-10-10）。既有資料庫執行一次；全新安裝用 schema.sql 就已包含，不需要執行。
--   npx wrangler d1 execute badminton --remote --file=migrations/001_gender_fee.sql
ALTER TABLE clubs ADD COLUMN casual_fee_female INTEGER;
ALTER TABLE club_members ADD COLUMN gender TEXT CHECK (gender IN ('M','F'));
ALTER TABLE registrations ADD COLUMN guest_gender TEXT CHECK (guest_gender IN ('M','F'));
