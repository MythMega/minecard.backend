-- =============================================================================
-- Likes ("cœurs") - MineCards
--
-- Apply with:
--   npx wrangler d1 execute minecard-db --file=./sql/schema/05-likes.sql --remote
--   npx wrangler d1 execute minecard-db --file=./sql/schema/05-likes.sql --local
--
-- Reference: `src/likeService.ts` and `doc/likes.md`.
--
-- This script is idempotent (`IF NOT EXISTS`): running it twice never loses a
-- like. It depends on the `users` table of `01-create.sql` only, because a
-- player can only be liked once they have an online account (a row in `users`,
-- created by the first card publication or the first online save).
--
-- This script only creates `likes` (the counters of the RECEIVER). The daily
-- quota lives in `07-like-everyone.sql`: one like per friend per UTC day, held
-- by `like_daily_target`. The older `like_daily` table it used to create here
-- was dropped by `08-drop-like-daily.sql`.
-- =============================================================================

-- One row per liked player: how many likes they received, and the fraction of
-- a Spark still waiting for them.
--
-- `like_count` is a plain counter. `bonus_from_like` grows by 0.1 per like and
-- is consumed BY WHOLE UNITS by the next authenticated read of that player
-- (`GET /likes?uuid=...&auth_code=...`): 4.8 becomes 0.8 and the player is
-- credited 4 Sparks by the game, which keeps the balance local like every
-- other currency. One received like therefore always ends up worth 1 Spark.
--
-- The bonus is never reset by a like: it only decreases by the integer part
-- the reader claims.
CREATE TABLE IF NOT EXISTS likes (
  uuid TEXT PRIMARY KEY,
  like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  bonus_from_like REAL NOT NULL DEFAULT 0 CHECK (bonus_from_like >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (uuid) REFERENCES users(uuid) ON DELETE CASCADE
);