-- =============================================================================
-- Targeted cleanup of the accounts created by the live checks - MineCards
--
-- Apply with:
--   npx wrangler d1 execute minecard-db --file=./sql/schema/admin/clean_test_accounts.sql --remote
--   npx wrangler d1 execute minecard-db --file=./sql/schema/admin/clean_test_accounts.sql --local
--
-- Older rule ONLY: the current convention is the `TESTUSERBDD` marker, handled by
-- `clean_testuserbdd_accounts.sql` (a name containing it is matched by BOTH scripts, which is
-- harmless). Run the marker script too, otherwise newer test accounts stay in the database.
--
-- What it removes: every account whose TRAINER CARD username starts with `E2E ` or `TEST ` (what
-- `test/live/worker.live.mjs` writes, plus the hand-made test accounts of the first likes session),
-- with its likes, favourites, saves, trades and daily like rows. A REAL player is never touched:
-- the predicate is a username the operator chose, and no real account is called that.
--
-- What it keeps: the `likes` row of a REAL player who received a like from a test account. That
-- counter is genuine (the like really happened), and deleting it would rewrite a real profile for
-- no reason.
--
-- Idempotent: the list of test UUIDs is rebuilt from scratch on every run (the helper table is
-- dropped first and last), so running the script twice deletes nothing the second time. Unlike
-- `clear_all_datas.sql`, it leaves the whole real database in place.
--
-- An account that only uploaded a save (a `users` row with no trainer card) has no username to
-- match: add its UUID by hand in the INSERT below if one ever needs to go.
-- =============================================================================

-- The UUIDs of the test accounts, captured BEFORE their cards are deleted. `_test_accounts` is a
-- transient helper, dropped at the end of this script.
DROP TABLE IF EXISTS _test_accounts;
CREATE TABLE _test_accounts (uuid TEXT PRIMARY KEY);
INSERT OR IGNORE INTO _test_accounts (uuid)
  SELECT uuid FROM cards WHERE username LIKE 'E2E %' OR username LIKE 'TEST %';

-- Preview: how many rows each DELETE below will remove. One statement per table, because this
-- SQLite build refuses a long `UNION ALL` ("too many terms in compound SELECT").
SELECT 'users' AS table_name, COUNT(*) AS rows_to_delete FROM users WHERE uuid IN (SELECT uuid FROM _test_accounts);
SELECT 'cards' AS table_name, COUNT(*) AS rows_to_delete FROM cards WHERE uuid IN (SELECT uuid FROM _test_accounts);
SELECT 'likes' AS table_name, COUNT(*) AS rows_to_delete FROM likes WHERE uuid IN (SELECT uuid FROM _test_accounts);
SELECT 'favorite' AS table_name, COUNT(*) AS rows_to_delete FROM favorite WHERE uuid IN (SELECT uuid FROM _test_accounts);
SELECT 'wishlist' AS table_name, COUNT(*) AS rows_to_delete FROM wishlist WHERE uuid IN (SELECT uuid FROM _test_accounts);
SELECT 'saves' AS table_name, COUNT(*) AS rows_to_delete FROM saves WHERE uuid IN (SELECT uuid FROM _test_accounts);
SELECT 'trades' AS table_name, COUNT(*) AS rows_to_delete FROM trades
 WHERE initiator_uuid IN (SELECT uuid FROM _test_accounts) OR responder_uuid IN (SELECT uuid FROM _test_accounts);
SELECT 'like_daily_target' AS table_name, COUNT(*) AS rows_to_delete FROM like_daily_target
 WHERE liker_uuid IN (SELECT uuid FROM _test_accounts) OR target_uuid IN (SELECT uuid FROM _test_accounts);

-- Children first, `users` last: the script works whether or not foreign keys are enforced.
DELETE FROM like_daily_target
 WHERE liker_uuid IN (SELECT uuid FROM _test_accounts) OR target_uuid IN (SELECT uuid FROM _test_accounts);

DELETE FROM likes WHERE uuid IN (SELECT uuid FROM _test_accounts);
DELETE FROM favorite WHERE uuid IN (SELECT uuid FROM _test_accounts);
DELETE FROM wishlist WHERE uuid IN (SELECT uuid FROM _test_accounts);
DELETE FROM saves WHERE uuid IN (SELECT uuid FROM _test_accounts);

DELETE FROM trades
 WHERE initiator_uuid IN (SELECT uuid FROM _test_accounts) OR responder_uuid IN (SELECT uuid FROM _test_accounts);

DELETE FROM cards WHERE uuid IN (SELECT uuid FROM _test_accounts);
DELETE FROM users WHERE uuid IN (SELECT uuid FROM _test_accounts);

DROP TABLE _test_accounts;
