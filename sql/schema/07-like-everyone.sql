-- =============================================================================
-- Likes, one per FRIEND per UTC day ("Like tout le monde") - MineCards
--
-- Apply with:
--   npx wrangler d1 execute minecard-db --file=./sql/schema/07-like-everyone.sql --remote
--   npx wrangler d1 execute minecard-db --file=./sql/schema/07-like-everyone.sql --local
--
-- Reference: `src/likeService.ts` and `doc/likes.md`.
--
-- `05-likes.sql` keyed `like_daily` by `(liker_uuid, day)`: a player could give exactly ONE like per
-- day, to one friend, which makes liking the whole Follow List impossible. The rule is now one like
-- per FRIEND per day, held by the primary key of `like_daily_target`. The batch route
-- (`POST /likes/batch`) writes it for every followed player in one request.
--
-- This script is idempotent: `IF NOT EXISTS` for the table and the index, and it reads no other
-- table, so it can be applied whatever the state of the database. The likes feature never reached
-- production, so the single likes recorded by the first version of the rule are not copied;
-- `08-drop-like-daily.sql` then removes `like_daily` entirely.
-- =============================================================================

-- One row per (liker, friend, day): the database itself refuses a second like of the same friend
-- the same day, whatever the client sends.
CREATE TABLE IF NOT EXISTS like_daily_target (
  liker_uuid TEXT NOT NULL,
  target_uuid TEXT NOT NULL,
  day TEXT NOT NULL DEFAULT (date('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (liker_uuid, target_uuid, day),
  CHECK (liker_uuid <> target_uuid),
  FOREIGN KEY (liker_uuid) REFERENCES users(uuid) ON DELETE CASCADE,
  FOREIGN KEY (target_uuid) REFERENCES users(uuid) ON DELETE CASCADE
);

-- The "likes sent" counter of one player (`GET /likes?uuid=…&auth_code=…`) reads by liker.
CREATE INDEX IF NOT EXISTS idx_like_daily_target_target ON like_daily_target(target_uuid, day);
