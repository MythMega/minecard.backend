-- =============================================================================
-- Trade system ("Échanges") - MineCards
--
-- Apply with:
--   npx wrangler d1 execute minecard-db --file=./sql/schema/03-trade-table.sql --remote
--   npx wrangler d1 execute minecard-db --file=./sql/schema/03-trade-table.sql --local
--
-- Reference: `src/tradeService.ts` and `doc/trades.md`.
--
-- This script is idempotent (`IF NOT EXISTS`): running it twice never loses a
-- trade. It only depends on the `users` table of `01-create.sql` for the
-- authentication code, and adds one table of its own.
--
-- The Ender Eyes stock is NOT here: like the collection, the Sparks and the
-- statistics, it lives in the player's save (`user_state["trades"].enderEyes`,
-- max 5, +1 per UTC day). The worker only knows the trades themselves, which
-- keeps every route at one authentication read instead of a currency
-- round-trip.
-- =============================================================================

-- One trade. The row carries BOTH cards as JSON: the worker never reads the
-- local collection, so the card a player gave is stored here until the other
-- side claims it (and returned as-is on a refund).
--
-- Statuses, one per phase of the exchange:
--   pending   A proposed a card, waiting for B.
--   proposed  B answered with a card of the same rarity, waiting for A.
--   accepted  A accepted B's proposal. Both cards are locked, each side can
--             claim the card it receives.
--   completed Both sides claimed. The trade is conclusive.
--   declined  B refused. A is refunded (card, Sparks and Ender Eyes).
--   cancelled A cancelled (or B withdrew a proposal, which goes back to
--             `pending` instead). Everyone is refunded.
--   expired   The 24 h deadline passed before the trade was accepted. Everyone
--             is refunded.
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'proposed', 'accepted', 'completed', 'declined', 'cancelled', 'expired')),
  -- Rarity shared by both cards. Rarity 6 (Unique) is tradable from four
  -- friendship stars, checked by the worker (`friendship_stars`); the column
  -- accepts it so the row can be written.
  rarity INTEGER NOT NULL CHECK (rarity BETWEEN 1 AND 6),
  initiator_uuid TEXT NOT NULL,
  responder_uuid TEXT NOT NULL,
  initiator_card_key TEXT NOT NULL,
  initiator_card_json TEXT NOT NULL,
  responder_card_key TEXT,
  responder_card_json TEXT,
  -- Cost of ONE side: 5 Ender Eyes for rarity 6, one per rarity below, + rarity² Sparks.
  sparks_cost INTEGER NOT NULL CHECK (sparks_cost > 0),
  ender_eyes_cost INTEGER NOT NULL CHECK (ender_eyes_cost BETWEEN 1 AND 5),
  -- Initiation timestamp, written by the SERVER clock: the client one is never trusted.
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  initiator_claimed_at TEXT,
  responder_claimed_at TEXT,
  closed_at TEXT,
  CHECK (initiator_uuid <> responder_uuid),
  CHECK (initiator_card_key <> ''),
  -- A proposal always comes with its card, and a card never comes alone.
  CHECK (
    (responder_card_key IS NULL AND responder_card_json IS NULL)
    OR (responder_card_key IS NOT NULL AND responder_card_json IS NOT NULL)
  )
);

-- The active trade of a player, and the two sides of the history screen.
CREATE INDEX IF NOT EXISTS idx_trades_initiator ON trades(initiator_uuid, status);
CREATE INDEX IF NOT EXISTS idx_trades_responder ON trades(responder_uuid, status);
CREATE INDEX IF NOT EXISTS idx_trades_expiry ON trades(status, expires_at);

-- One open REQUEST at a time per initiator. `accepted` is deliberately not
-- covered: the card is already given and the trade only waits for a claim, so
-- blocking a new request on it would freeze the account if the player forgets
-- to claim. The worker answers 409 before reaching this index anyway.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_one_open_per_initiator
  ON trades(initiator_uuid)
  WHERE status IN ('pending', 'proposed');

-- Trade statistics are NOT stored here: like every other counter of the game they live in the
-- player's save (`user_state["trades"].stats`), so a `.save` export carries them and the worker
-- never keeps a second, divergent history of a player's progression.
--
-- A database created from an earlier revision of this file may still hold an empty `trade_stats`
-- table: drop it so the schema matches the code. The worker never wrote a row in it.
DROP TABLE IF EXISTS trade_stats;

-- Earlier revisions kept the Ender Eyes balance here. It is local now: drop the
-- table so the schema matches the code (a 5-Eye column would only ever be
-- stale, since nothing refills or spends it anymore).
DROP TABLE IF EXISTS trade_accounts;
