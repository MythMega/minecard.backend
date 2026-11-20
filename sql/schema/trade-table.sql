-- =============================================================================
-- Trade system ("Échanges") - MineCards
--
-- Apply with:
--   npx wrangler d1 execute minecard-db --file=./sql/schema/trade-table.sql --remote
--   npx wrangler d1 execute minecard-db --file=./sql/schema/trade-table.sql --local
--
-- Reference: `src/tradeService.ts` and `doc/trades.md`.
--
-- This script is idempotent (`IF NOT EXISTS`): running it twice never loses a
-- trade. It only depends on the `users` table of `01-create.sql` for the
-- authentication code, and adds three tables of its own.
-- =============================================================================

-- Ender Eyes: the trade currency. At most 5 per account, refilled by 1 per UTC
-- day. The balance lives on the server because it is what makes a trade
-- possible: a client cannot spend more than the worker allows.
--
-- `ender_eyes_day` is the UTC day the balance was last brought up to date
-- (`YYYY-MM-DD`). Every trade request calls the refill first, so the balance is
-- correct even for a player who has not opened the game for a week.
CREATE TABLE IF NOT EXISTS trade_accounts (
  uuid TEXT PRIMARY KEY,
  ender_eyes INTEGER NOT NULL DEFAULT 5
    CHECK (ender_eyes >= 0 AND ender_eyes <= 5),
  ender_eyes_day TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  -- Rarity shared by both cards. 6 (Unique) is never tradable: the CHECK makes
  -- the rule impossible to bypass, whatever the client sends.
  rarity INTEGER NOT NULL CHECK (rarity BETWEEN 1 AND 5),
  initiator_uuid TEXT NOT NULL,
  responder_uuid TEXT NOT NULL,
  initiator_card_key TEXT NOT NULL,
  initiator_card_json TEXT NOT NULL,
  responder_card_key TEXT,
  responder_card_json TEXT,
  -- Cost of ONE side: 1 Ender Eye per rarity + rarity² Sparks.
  sparks_cost INTEGER NOT NULL CHECK (sparks_cost > 0),
  ender_eyes_cost INTEGER NOT NULL CHECK (ender_eyes_cost BETWEEN 1 AND 5),
  -- Informational only: the client clock is never trusted for the deadline.
  client_created_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  initiator_claimed_at TEXT,
  responder_claimed_at TEXT,
  closed_at TEXT,
  -- UUID of the player who closed the trade, or 'system' for the 24 h sweep.
  closed_by TEXT,
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
