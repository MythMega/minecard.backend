-- Presentation fields of a published trainer card.
-- One column holds one value: the client no longer packs layout, avatar options and rarity in size_id.
ALTER TABLE cards ADD COLUMN card_layout TEXT NOT NULL DEFAULT 'classic'
  CHECK (card_layout IN ('classic', 'fullart'));
ALTER TABLE cards ADD COLUMN profile_icon_size TEXT NOT NULL DEFAULT 'normal'
  CHECK (profile_icon_size IN ('tiny', 'verySmall', 'small', 'normal', 'large', 'veryLarge', 'huge'));
ALTER TABLE cards ADD COLUMN profile_icon_align TEXT NOT NULL DEFAULT 'center'
  CHECK (profile_icon_align IN ('top', 'left', 'center', 'right', 'bottom'));
ALTER TABLE cards ADD COLUMN profile_icon_shape TEXT NOT NULL DEFAULT 'normal'
  CHECK (profile_icon_shape IN ('normal', 'round'));
ALTER TABLE cards ADD COLUMN card_rarity INTEGER NOT NULL DEFAULT 1
  CHECK (card_rarity BETWEEN 1 AND 6);
ALTER TABLE cards ADD COLUMN title_color_id TEXT NOT NULL DEFAULT 'auto';

-- The packed presentation string is not used anymore. Existing rows keep the defaults above.
ALTER TABLE cards DROP COLUMN size_id;
