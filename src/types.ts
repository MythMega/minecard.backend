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
  size_id: string;
  open_booster: number;
  different_cards: number;
  date_first_card: string;
  level: number;
  block_mined: number;
  picks: number;
  points: number;
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
  size_id: string;
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
    "size_id",
    "date_first_card",
  ];

  for (const key of requiredStrings) {
    if (!isNonEmptyString(b[key])) {
      return { ok: false, error: `Le champ '${key}' doit être une chaîne non vide.` };
    }
  }

  const requiredInts: Array<keyof UpsertCardInput> = [
    "open_booster",
    "different_cards",
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
      size_id: (b.size_id as string).trim(),
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