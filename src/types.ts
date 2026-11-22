export interface Env {
  DB: D1Database;
}

/**
 * Payload envoyé par le client pour créer ou mettre à jour sa carte.
 * Tous les IDs, uuid, username, auth_code et date_first_card sont des string.
 * Les stats numériques sont des entiers (>= 0).
 */
export interface UpsertCardInput {
  uuid: string;
  auth_code: string;
  username: string;
  background_card_id: string;
  profile_picture_id: string;
  title_id: string;
  card_color_id: string;
  username_color_id: string;
  location_id: string;
  card_layout: string;
  profile_icon_size: string;
  profile_icon_align: string;
  profile_icon_shape: string;
  card_rarity: number;
  title_color_id: string;
  open_booster: number;
  different_cards: number;
  date_first_card: string;
  level: number;
  block_mined: number;
  picks: number;
  points: number;
  /** Favourite collection keys (`<cardId>_<style>`), up to seven, in profile order. */
  favorite_cards?: string[];
  /** Featured trophy ids, up to seven, in profile order. */
  favorite_trophies?: string[];
}

/**
 * Objet carte retourné au client :
 * IMPORTANT : auth_code n'est JAMAIS présent ici.
 */
export interface PublicCard {
  uuid: string;
  username: string;
  background_card_id: string;
  profile_picture_id: string;
  title_id: string;
  card_color_id: string;
  username_color_id: string;
  location_id: string;
  card_layout: string;
  profile_icon_size: string;
  profile_icon_align: string;
  profile_icon_shape: string;
  card_rarity: number;
  title_color_id: string;
  open_booster: number;
  different_cards: number;
  date_first_card: string;
  level: number;
  block_mined: number;
  picks: number;
  points: number;
  updated_at: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const CARD_LAYOUTS = new Set(["classic", "fullart"]);
const PROFILE_ICON_SIZES = new Set([
  "tiny",
  "verySmall",
  "small",
  "normal",
  "large",
  "veryLarge",
  "huge",
]);
const PROFILE_ICON_ALIGNS = new Set(["top", "left", "center", "right", "bottom"]);
const PROFILE_ICON_SHAPES = new Set(["normal", "round"]);
const MIN_CARD_RARITY = 1;
const MAX_CARD_RARITY = 6;

export function validateUpsertCardPayload(
  body: unknown
): { ok: true; data: UpsertCardInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Corps de requête JSON invalide." };
  }

  const b = body as Record<string, unknown>;

  const requiredStrings: Array<keyof UpsertCardInput> = [
    "uuid",
    "auth_code",
    "username",
    "background_card_id",
    "profile_picture_id",
    "title_id",
    "card_color_id",
    "username_color_id",
    "location_id",
    "card_layout",
    "profile_icon_size",
    "profile_icon_align",
    "profile_icon_shape",
    "title_color_id",
    "date_first_card",
  ];

  for (const key of requiredStrings) {
    if (!isNonEmptyString(b[key])) {
      return { ok: false, error: `Le champ '${key}' doit être une chaîne non vide.` };
    }
  }

  const enumFields: Array<[keyof UpsertCardInput, Set<string>]> = [
    ["card_layout", CARD_LAYOUTS],
    ["profile_icon_size", PROFILE_ICON_SIZES],
    ["profile_icon_align", PROFILE_ICON_ALIGNS],
    ["profile_icon_shape", PROFILE_ICON_SHAPES],
  ];

  for (const [key, allowed] of enumFields) {
    if (!allowed.has((b[key] as string).trim())) {
      return { ok: false, error: `La valeur du champ '${key}' est invalide.` };
    }
  }

  const requiredInts: Array<keyof UpsertCardInput> = [
    "open_booster",
    "different_cards",
    "card_rarity",
    "level",
    "block_mined",
    "picks",
    "points",
  ];

  for (const key of requiredInts) {
    if (!isNonNegativeInt(b[key])) {
      return { ok: false, error: `Le champ '${key}' doit être un entier positif ou nul.` };
    }
  }

  const cardRarity = b.card_rarity as number;
  if (cardRarity < MIN_CARD_RARITY || cardRarity > MAX_CARD_RARITY) {
    return {
      ok: false,
      error: `Le champ 'card_rarity' doit être compris entre ${MIN_CARD_RARITY} et ${MAX_CARD_RARITY}.`,
    };
  }

  return {
    ok: true,
    data: {
      uuid: (b.uuid as string).trim(),
      auth_code: b.auth_code as string,
      username: (b.username as string).trim(),
      background_card_id: (b.background_card_id as string).trim(),
      profile_picture_id: (b.profile_picture_id as string).trim(),
      title_id: (b.title_id as string).trim(),
      card_color_id: (b.card_color_id as string).trim(),
      username_color_id: (b.username_color_id as string).trim(),
      location_id: (b.location_id as string).trim(),
      card_layout: (b.card_layout as string).trim(),
      profile_icon_size: (b.profile_icon_size as string).trim(),
      profile_icon_align: (b.profile_icon_align as string).trim(),
      profile_icon_shape: (b.profile_icon_shape as string).trim(),
      card_rarity: cardRarity,
      title_color_id: (b.title_color_id as string).trim(),
      open_booster: b.open_booster as number,
      different_cards: b.different_cards as number,
      date_first_card: (b.date_first_card as string).trim(),
      level: b.level as number,
      block_mined: b.block_mined as number,
      picks: b.picks as number,
      points: b.points as number,
    },
  };
}