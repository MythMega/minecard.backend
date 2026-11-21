-- =============================================================================
-- Online save backups ("Sauvegarde en ligne") - MineCards
--
-- Apply with:
--   npx wrangler d1 execute minecard-db --file=./sql/schema/04-save.sql --remote
--   npx wrangler d1 execute minecard-db --file=./sql/schema/04-save.sql --local
--
-- Reference: `src/saveService.ts` and `doc/saves.md`.
--
-- This script is idempotent (`IF NOT EXISTS`): running it twice never loses a
-- backup. It depends on the `users` table of `01-create.sql` only, because the
-- secret write code lives there: a row is created for an account that never
-- published its trainer card, with the code of its FIRST upload, and every later
-- upload and download must present that exact code.
-- =============================================================================

-- One uploaded save. The file itself is stored as-is: the text of a `.save`
-- container (Base64 of the deflate stream produced by `SaveFile`), so a download
-- can be imported by the game with no transformation.
--
-- `byte_size` is the length of that text, kept so a row can be audited without
-- decoding it. `created_at` is written by the SERVER clock, like every other
-- timestamp of the schema: the date shown by the game is the date of the upload,
-- never the clock of the device that sent it.
--
-- The UUID is a foreign key: deleting the player's `users` row (the admin clear
-- scripts) also deletes their backups. `ON DELETE CASCADE` is the only reason
-- this table can be cleaned up from `users` alone.
CREATE TABLE IF NOT EXISTS saves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL,
  save_blob TEXT NOT NULL CHECK (length(save_blob) > 0),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (uuid) REFERENCES users(uuid) ON DELETE CASCADE
);

-- Reads the backups of one account, newest first (the download button asks for
-- the last one), and supports the trim that keeps only the 5 newest rows.
CREATE INDEX IF NOT EXISTS idx_saves_uuid ON saves(uuid, id DESC);
