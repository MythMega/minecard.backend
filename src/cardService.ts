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

interface ExistingUserRow {
  uuid: string;
  auth_code: string;
}

export type UpsertResult =
  | { status: 201; action: "created"; card: PublicCard }
  | { status: 200; action: "updated"; card: PublicCard }
  | { status: 403; error: string };

/**
 * Crée l'utilisateur + la carte si l'UUID n'existe pas encore,
 * ou met à jour la carte si l'UUID existe et que auth_code correspond.
 * auth_code n'est jamais retourné.
 */
export async function upsertCard(
  db: D1Database,
  input: UpsertCardInput
): Promise<UpsertResult> {
  const existingUser = await db
    .prepare("SELECT uuid, auth_code FROM users WHERE uuid = ?")
    .bind(input.uuid)
    .first<ExistingUserRow>();

  let action: "created" | "updated";

  if (!existingUser) {
    await db
      .prepare("INSERT INTO users (uuid, auth_code) VALUES (?, ?)")
      .bind(input.uuid, input.auth_code)
      .run();
    action = "created";
  } else {
    if (existingUser.auth_code !== input.auth_code) {
      return {
        status: 403,
        error: "Authentification invalide pour cet UUID.",
      };
    }

    await db
      .prepare("UPDATE users SET updated_at = datetime('now') WHERE uuid = ?")
      .bind(input.uuid)
      .run();
    action = "updated";
  }

  await db
    .prepare(
      `INSERT INTO cards (
        uuid,
        username,
        background_card_id,
        profile_picture_id,
        title_id,
        card_color_id,
        username_color_id,
        location_id,
        size_id,
        open_booster,
        different_cards,
        date_first_card,
        level,
        block_mined,
        picks,
        points,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(uuid) DO UPDATE SET
        username = excluded.username,
        background_card_id = excluded.background_card_id,
        profile_picture_id = excluded.profile_picture_id,
        title_id = excluded.title_id,
        card_color_id = excluded.card_color_id,
        username_color_id = excluded.username_color_id,
        location_id = excluded.location_id,
        size_id = excluded.size_id,
        open_booster = excluded.open_booster,
        different_cards = excluded.different_cards,
        date_first_card = excluded.date_first_card,
        level = excluded.level,
        block_mined = excluded.block_mined,
        picks = excluded.picks,
        points = excluded.points,
        updated_at = datetime('now')`
    )
    .bind(
      input.uuid,
      input.username,
      input.background_card_id,
      input.profile_picture_id,
      input.title_id,
      input.card_color_id,
      input.username_color_id,
      input.location_id,
      input.size_id,
      input.open_booster,
      input.different_cards,
      input.date_first_card,
      input.level,
      input.block_mined,
      input.picks,
      input.points
    )
    .run();
    
    const card = await getCardByUuid(db, input.uuid);
    if (!card) {
        throw new Error("Impossible de relire la carte après sauvegarde.");
    }

    if (action === "created") {
        return {
        status: 201,
        action: "created",
        card,
        };
    }

    return {
        status: 200,
        action: "updated",
        card,
    };
}

export async function getCardByUuid(
  db: D1Database,
  uuid: string
): Promise<PublicCard | null> {
  const row = await db
    .prepare(
      `SELECT
        uuid,
        username,
        background_card_id,
        profile_picture_id,
        title_id,
        card_color_id,
        username_color_id,
        location_id,
        size_id,
        open_booster,
        different_cards,
        date_first_card,
        level,
        block_mined,
        picks,
        points,
        updated_at
      FROM cards
      WHERE uuid = ?`
    )
    .bind(uuid)
    .first<PublicCard>();

  return row ?? null;
}

export async function getCardsByUuids(
  db: D1Database,
  uuids: string[]
): Promise<PublicCard[]> {
  const cleaned = Array.from(
    new Set(uuids.map((u: string) => u.trim()).filter((u: string) => u.length > 0))
  ).slice(0, 100);

  if (cleaned.length === 0) {
    return [];
  }

  const placeholders = cleaned.map(() => "?").join(", ");
  const query = `SELECT
      uuid,
      username,
      background_card_id,
      profile_picture_id,
      title_id,
      card_color_id,
      username_color_id,
      location_id,
      size_id,
      open_booster,
      different_cards,
      date_first_card,
      level,
      block_mined,
      picks,
      points,
      updated_at
    FROM cards
    WHERE uuid IN (${placeholders})`;

  const result = await db.prepare(query).bind(...cleaned).all<PublicCard>();
  return result.results ?? [];
}