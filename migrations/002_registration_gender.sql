-- 性別只留在臨打報名上（2026-10-11）：registrations.guest_gender 改名為 gender（自己報名也能選），
-- 拿掉成員資料上的性別。已經執行過 001 的資料庫執行一次；全新安裝用 schema.sql，不需要執行。
--   npx wrangler d1 execute badminton --remote --file=migrations/002_registration_gender.sql
ALTER TABLE registrations RENAME COLUMN guest_gender TO gender;
ALTER TABLE club_members DROP COLUMN gender;
