-- ==========================================
-- Wipe COMPLET de toutes les données (D1) (a ne faire qu'en cas de test)
--
-- Apply with:
--   npx wrangler d1 execute minecard-db --file=./sql/schema/admin/clear_all_datas.sql --remote
--   npx wrangler d1 execute minecard-db --file=./sql/schema/admin/clear_all_datas.sql --local
--
-- Children first, parents last: every row that references `users` goes before
-- it, so the script works whether or not foreign keys are enforced.
-- ==========================================
DELETE FROM like_daily_target;
DELETE FROM likes;
DELETE FROM favorite;
DELETE FROM wishlist;
DELETE FROM trades;
DELETE FROM cards;
DELETE FROM saves;
DELETE FROM users;
