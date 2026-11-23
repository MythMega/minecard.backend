-- =============================================================================
-- Unique trainer-card pseudo ("username") - MineCards
--
-- Apply with:
--   npx wrangler d1 execute minecard-db --file=./sql/schema/10-username-unique.sql --remote
--   npx wrangler d1 execute minecard-db --file=./sql/schema/10-username-unique.sql --local
--
-- Reference: `src/cardService.ts` (`POST /cards`) and `src/lookupService.ts`
-- (`GET /lookup`, the pseudo -> UUID lookup the game and the admin pages use).
--
-- WHY
--   Two accounts may not share a pseudo any more: the pseudo becomes a way to
--   designate a player (add a friend, load an online save) exactly like the
--   UUID, so it must designate exactly one account. `POST /cards` checks the
--   pseudo before writing, but two publications sent at the same instant could
--   both pass that read: the index is what makes the rule true whatever the
--   timing, and the worker turns the failure into a 409 instead of a 500.
--
-- CASE-INSENSITIVE
--   The index uses `COLLATE NOCASE`, so `Steve` and `steve` are the SAME pseudo.
--   Without it, a player could take `Steve` to impersonate `steve` in a friend
--   request, and a lookup typed with another case would find nobody. The
--   comparison is ASCII-only case folding, which is what the game's pseudos use
--   (accented names are compared exactly).
--
-- IDEMPOTENT
--   `IF EXISTS` / `IF NOT EXISTS`: running the script twice is safe. It reads
--   no other table, so it can be applied whatever the state of the database.
--
-- RUN IT ONLY WHEN NO PSEUDO IS DUPLICATED
--   A database that already holds two identical (or two same-case) pseudos makes
--   the CREATE UNIQUE INDEX fail, and the statement changes nothing: the check
--   below lists them first. The production database has no duplicate (verified
--   before adding the constraint), and this script only reports, never deletes.
-- =============================================================================

-- Preview: every pseudo used by more than one account. Must answer no row before
-- the unique index is created. Kept as a plain SELECT: the script never edits a
-- card, a duplicated pseudo needs a human decision (which account keeps it).
SELECT username, COUNT(*) AS accounts
FROM cards
GROUP BY username COLLATE NOCASE
HAVING COUNT(*) > 1;

-- The plain index of `01-create.sql` is replaced by the unique one: the same
-- column, one index, and the lookups by pseudo use it.
DROP INDEX IF EXISTS idx_cards_username;

-- One account per pseudo, case-insensitive. This is the constraint `POST /cards`
-- relies on when it answers 409 "pseudo déjà pris".
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_username_unique ON cards(username COLLATE NOCASE);
