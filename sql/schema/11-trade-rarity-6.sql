-- =============================================================================
-- Trade rarity 6 (Unique) - MineCards
--
-- Apply with:
--   npx wrangler d1 execute minecard-db --file=./sql/schema/11-trade-rarity-6.sql --remote
--   npx wrangler d1 execute minecard-db --file=./sql/schema/11-trade-rarity-6.sql --local
--
-- Reference: `src/tradeService.ts`, `sql/schema/03-trade-table.sql` and `doc/trades.md`.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt once with rarity BETWEEN 1 AND 6.
-- Every row is copied as is (no trade is lost, no status changes), then the indexes are recreated.
-- The client only offers rarity 6 from four friendship stars, and the worker refuses the request
-- below that (`friendship_stars`), but the column check is widened for every row created from now on.
-- =============================================================================

BEGIN TRANSACTION;

ALTER TABLE trades RENAME TO trades_legacy;

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'proposed', 'accepted', 'completed', 'declined', 'cancelled', 'expired')),
  -- Rarity shared by both cards. Rarity 6 (Unique) is tradable from four friendship stars.
  rarity INTEGER NOT NULL CHECK (rarity BETWEEN 1 AND 6),
  initiator_uuid TEXT NOT NULL,
  responder_uuid TEXT NOT NULL,
  initiator_card_key TEXT NOT NULL,
  initiator_card_json TEXT NOT NULL,
  responder_card_key TEXT,
  responder_card_json TEXT,
  -- Cost of ONE side: 5 Ender Eyes for rarity 6, one per rarity below, plus rarity² Sparks.
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

INSERT INTO trades SELECT * FROM trades_legacy;

DROP TABLE trades_legacy;

-- The active trade of a player, and the two sides of the history screen.
CREATE INDEX IF NOT EXISTS idx_trades_initiator ON trades(initiator_uuid, status);
CREATE INDEX IF NOT EXISTS idx_trades_responder ON trades(responder_uuid, status);
CREATE INDEX IF NOT EXISTS idx_trades_expiry ON trades(status, expires_at);

-- One open REQUEST at a time per initiator. `accepted` is deliberately not covered: the card is
-- already given and the trade only waits for a claim, so blocking a new request on it would freeze
-- the account if the player forgets to claim.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_one_open_per_initiator
  ON trades(initiator_uuid)
  WHERE status IN ('pending', 'proposed');

COMMIT;
