CREATE TABLE IF NOT EXISTS users (
  uuid TEXT PRIMARY KEY,
  auth_code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  uuid TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  background_card_id TEXT NOT NULL,
  profile_picture_id TEXT NOT NULL,
  title_id TEXT NOT NULL,
  card_color_id TEXT NOT NULL,
  username_color_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  size_id TEXT NOT NULL,
  open_booster INTEGER NOT NULL DEFAULT 0,
  different_cards INTEGER NOT NULL DEFAULT 0,
  date_first_card TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  block_mined INTEGER NOT NULL DEFAULT 0,
  picks INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (uuid) REFERENCES users(uuid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cards_username ON cards(username);