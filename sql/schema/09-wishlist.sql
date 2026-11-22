-- =============================================================================
-- Wishlist (the cards a player hopes to receive) - MineCards
--
-- Apply with:
--   npx wrangler d1 execute minecard-db --file=./sql/schema/09-wishlist.sql --remote
--   npx wrangler d1 execute minecard-db --file=./sql/schema/09-wishlist.sql --local
--
-- Reference: `src/wishlistService.ts`.
--
-- This script is idempotent (`IF NOT EXISTS`): running it twice never loses a
-- wish. It only depends on the `users` table of `01-create.sql`, because a
-- player only has a wishlist once they have an online account (a row in
-- `users`, created by the first card publication or the first online save).
--
-- ONE ROW PER PLAYER, written by the publication of the trainer card
-- (`POST /cards`): the payload carries up to ten collection keys in the order
-- the collection shows them, and the row keeps them so a followed player can
-- display them (and favour them in a trade).
--
-- Every slot is NULLABLE: a wishlist of three cards stores `card1` … `card3`
-- and seven NULLs, and an empty wishlist is ten NULLs. The row itself always
-- exists once the card was published with the field: an explicit empty list is
-- how the game empties the wishlist online, while an ABSENT field leaves the
-- stored list alone (an older client must never wipe it).
--
-- `cardN` holds a collection key (`<cardId>_<style>`, e.g. `creeper_foil`): an
-- opaque string for the worker, resolved by the game.
-- =============================================================================

CREATE TABLE IF NOT EXISTS wishlist (
  uuid TEXT PRIMARY KEY,
  card1 TEXT,
  card2 TEXT,
  card3 TEXT,
  card4 TEXT,
  card5 TEXT,
  card6 TEXT,
  card7 TEXT,
  card8 TEXT,
  card9 TEXT,
  card10 TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (uuid) REFERENCES users(uuid) ON DELETE CASCADE
);
