-- =============================================================================
-- Favorites (favourite cards and featured trophies) - MineCards
--
-- Apply with:
--   npx wrangler d1 execute minecard-db --file=./sql/schema/06-favorites.sql --remote
--   npx wrangler d1 execute minecard-db --file=./sql/schema/06-favorites.sql --local
--
-- Reference: `src/favoriteService.ts`.
--
-- This script is idempotent (`IF NOT EXISTS`): running it twice never loses a
-- favourite. A database created BEFORE `binder_code` existed keeps its table
-- untouched by it, so it needs the column once:
--   npx wrangler d1 execute minecard-db --remote --command="ALTER TABLE favorite ADD COLUMN binder_code TEXT" It only depends on the `users` table of `01-create.sql`, because a
-- player only has favourites once they have an online account (a row in
-- `users`, created by the first card publication or the first online save).
--
-- ONE ROW PER PLAYER, written by the publication of the trainer card
-- (`POST /cards`): the payload carries the pinned card keys and trophy ids in
-- the order the profile shows them, and this table keeps them so a followed
-- player can display them in the game.
--
-- Every slot is NULLABLE: an empty slot is `NULL`, so an account that pinned
-- fewer than seven favourites stores only what it has, and a player who never
-- published a card simply has no row at all.
--
-- `cardN` holds a collection key (`<cardId>_<style>`, e.g. `creeper_foil`),
-- `trophyN` a trophy id of the catalogue (e.g. `A1_completion_bronze`): both are
-- opaque strings for the worker, resolved by the game.
--
-- `binder_code` holds the share code of the binder the profile pins on its card
-- (`collection.html?code=...`, produced by the game): the deflated, URL-safe
-- Base64 payload of the binder. The worker never reads it, it only hands it to
-- the followed players so their friend dialog can open the binder. NULL means
-- "no binder pinned", and an explicit empty code clears it.
-- =============================================================================

CREATE TABLE IF NOT EXISTS favorite (
  uuid TEXT PRIMARY KEY,
  trophy1 TEXT,
  trophy2 TEXT,
  trophy3 TEXT,
  trophy4 TEXT,
  trophy5 TEXT,
  trophy6 TEXT,
  trophy7 TEXT,
  card1 TEXT,
  card2 TEXT,
  card3 TEXT,
  card4 TEXT,
  card5 TEXT,
  card6 TEXT,
  card7 TEXT,
  binder_code TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (uuid) REFERENCES users(uuid) ON DELETE CASCADE
);
