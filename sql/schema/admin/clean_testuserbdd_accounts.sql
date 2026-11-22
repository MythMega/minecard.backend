-- =============================================================================
-- Targeted cleanup of the TEST accounts - MineCards
--
-- Apply with (there is deliberately NO npm shortcut: this stays a manual gesture):
--   npx wrangler d1 execute minecard-db --file=./sql/schema/admin/clean_testuserbdd_accounts.sql --remote
--   npx wrangler d1 execute minecard-db --file=./sql/schema/admin/clean_testuserbdd_accounts.sql --local
--
-- THE RULE
--   Every test account MUST contain `TESTUSERBDD` in its pseudo ("TESTUSERBDD_like1",
--   "monTESTUSERBDD", ...). This script deletes every account whose pseudo contains it, with
--   everything the account owns: like counters and Spark bonus, favourites and binder, online
--   saves, trades, and the likes it gave today. Picking a real pseudo that contains the marker
--   would therefore delete a real account - the game warns about it before saving such a name.
--
--   The match is `LIKE '%TESTUSERBDD%'`: anywhere in the name, and case-insensitive for ASCII, so
--   "testuserbdd_like1" is caught too. A test account that never published its trainer card has no
--   pseudo to match: add its UUID by hand in the INSERT below.
--
-- WHAT IT KEEPS
--   The `likes` row of a REAL player who received a like from a test account: the like really
--   happened, and erasing that counter would rewrite a real profile for nothing.
--
-- Idempotent: the UUID list is rebuilt on every run (the helper table is dropped first and last),
-- so running it twice deletes nothing the second time. Unlike `clear_all_datas.sql`, it leaves
-- every other account in place.
--
-- Reference: `doc/test-accounts.md`.
-- =============================================================================

-- The UUIDs of the test accounts, captured BEFORE their cards are deleted. `_testuserbdd` is a
-- transient helper, dropped at the end of this script; `cards.uuid` is unique, so the copy holds no
-- duplicate.
DROP TABLE IF EXISTS _testuserbdd;
CREATE TABLE _testuserbdd AS SELECT uuid FROM cards WHERE username LIKE '%TESTUSERBDD%';

-- Preview: how many rows each DELETE below will remove. One statement per table, because this
-- SQLite build refuses a long `UNION ALL` ("too many terms in compound SELECT").
SELECT 'users' AS table_name, COUNT(*) AS rows_to_delete FROM users WHERE uuid IN (SELECT uuid FROM _testuserbdd);
SELECT 'cards' AS table_name, COUNT(*) AS rows_to_delete FROM cards WHERE uuid IN (SELECT uuid FROM _testuserbdd);
SELECT 'likes' AS table_name, COUNT(*) AS rows_to_delete FROM likes WHERE uuid IN (SELECT uuid FROM _testuserbdd);
SELECT 'favorite' AS table_name, COUNT(*) AS rows_to_delete FROM favorite WHERE uuid IN (SELECT uuid FROM _testuserbdd);
SELECT 'saves' AS table_name, COUNT(*) AS rows_to_delete FROM saves WHERE uuid IN (SELECT uuid FROM _testuserbdd);
SELECT 'trades' AS table_name, COUNT(*) AS rows_to_delete FROM trades
 WHERE initiator_uuid IN (SELECT uuid FROM _testuserbdd) OR responder_uuid IN (SELECT uuid FROM _testuserbdd);
SELECT 'like_daily_target' AS table_name, COUNT(*) AS rows_to_delete FROM like_daily_target
 WHERE liker_uuid IN (SELECT uuid FROM _testuserbdd) OR target_uuid IN (SELECT uuid FROM _testuserbdd);

-- Children first, `users` last: the script works whether or not foreign keys are enforced.
DELETE FROM like_daily_target
 WHERE liker_uuid IN (SELECT uuid FROM _testuserbdd) OR target_uuid IN (SELECT uuid FROM _testuserbdd);

DELETE FROM likes WHERE uuid IN (SELECT uuid FROM _testuserbdd);
DELETE FROM favorite WHERE uuid IN (SELECT uuid FROM _testuserbdd);
DELETE FROM saves WHERE uuid IN (SELECT uuid FROM _testuserbdd);

DELETE FROM trades
 WHERE initiator_uuid IN (SELECT uuid FROM _testuserbdd) OR responder_uuid IN (SELECT uuid FROM _testuserbdd);

DELETE FROM cards WHERE uuid IN (SELECT uuid FROM _testuserbdd);
DELETE FROM users WHERE uuid IN (SELECT uuid FROM _testuserbdd);

DROP TABLE _testuserbdd;
