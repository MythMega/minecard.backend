// The extension is explicit: Node runs this module in the tests (`npm test`), and it needs one
// (see `allowImportingTsExtensions`). The worker bundles it exactly the same way.
import { writeFavorites } from "./favoriteService.ts";
import { writeWishlist } from "./wishlistService.ts";

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
  /** Share code of the binder the profile pins on its card (opaque to the worker). */
  binder_code?: string;
  /** Collection keys of the wishlist, up to ten, in display order. */
  wishlist_cards?: string[];
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

interface ExistingUserRow {
  uuid: string;
  auth_code: string;
}

export type UpsertResult =
  | { status: 201; action: "created"; card: PublicCard }
  | { status: 200; action: "updated"; card: PublicCard }
  | { status: 403; error: string }
  | { status: 409; error: string };

/** Message of the 409 answered when another account already uses the pseudo. */
export const USERNAME_TAKEN_ERROR = "Ce pseudo est déjà pris par un autre joueur.";

/**
 * Compares two pseudos the way the database does: case-insensitively.
 *
 * The unique index of the schema is declared COLLATE NOCASE, so Steve and
 * steve are the SAME pseudo. A publication that only changes the case of its
 * own pseudo therefore writes nothing new, and must not be refused.
 *
 * @param {string} a - One pseudo.
 * @param {string} b - The other pseudo.
 * @returns {boolean} True when both designate the same pseudo.
 */
function sameUsername(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Tells whether a D1 failure is the unique index of the pseudo refusing a write.
 *
 * Two publications can pass the read of upsertCard at the same instant and both
 * try to store the same pseudo: the index keeps the rule, and the loser must get
 * the same 409 as the usual case instead of a 500.
 *
 * @param {unknown} error - Error thrown by D1.
 * @returns {boolean} True when the unique constraint of cards.username fired.
 */
function isUsernameConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: cards\.username/i.test(message);
}

const CARD_COLUMNS = [
  "uuid",
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
  "card_rarity",
  "title_color_id",
  "open_booster",
  "different_cards",
  "date_first_card",
  "level",
  "block_mined",
  "picks",
  "points",
].join(", ");

const CARD_PLACEHOLDERS = CARD_COLUMNS.split(", ")
  .map(() => "?")
  .join(", ");

const CARD_UPDATE_ASSIGNMENTS = [
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
  "card_rarity",
  "title_color_id",
  "open_booster",
  "different_cards",
  "date_first_card",
  "level",
  "block_mined",
  "picks",
  "points",
]
  .map((column) => `${column} = excluded.${column}`)
  .join(", ");

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
    // Two devices publishing the same fresh UUID at the same moment must not fail: the second
    // insert is ignored, and the code the winner stored is compared below. Without this, D1 throws
    // on the `users` primary key and the client gets a 500 instead of its 403/200.
    const inserted = await db
      .prepare("INSERT INTO users (uuid, auth_code) VALUES (?, ?) ON CONFLICT(uuid) DO NOTHING")
      .bind(input.uuid, input.auth_code)
      .run();

    if ((inserted.meta?.changes ?? 0) === 0) {
      const winner = await db
        .prepare("SELECT uuid, auth_code FROM users WHERE uuid = ?")
        .bind(input.uuid)
        .first<ExistingUserRow>();
      if (winner?.auth_code !== input.auth_code) {
        return {
          status: 403,
          error: "Authentification invalide pour cet UUID.",
        };
      }
      action = "updated";
    } else {
      action = "created";
    }
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

  // The pseudo is a PUBLIC identifier now (GET /lookup): it must designate one account only,
  // otherwise a friend request would reach the wrong player. The read below answers the usual
  // case; a publication that keeps its own pseudo skips it entirely, so a rename is the only
  // upload that pays for it.
  const existingCard = await db
    .prepare("SELECT username FROM cards WHERE uuid = ?")
    .bind(input.uuid)
    .first<{ username: string }>();
  if (!existingCard || !sameUsername(existingCard.username, input.username)) {
    const taken = await db
      .prepare("SELECT uuid FROM cards WHERE username = ? COLLATE NOCASE AND uuid <> ?")
      .bind(input.username, input.uuid)
      .first<{ uuid: string }>();
    if (taken) {
      return { status: 409, error: USERNAME_TAKEN_ERROR };
    }
  }

  try {
    await db
      .prepare(
        `INSERT INTO cards (${CARD_COLUMNS}, updated_at)
        VALUES (${CARD_PLACEHOLDERS}, datetime('now'))
        ON CONFLICT(uuid) DO UPDATE SET
          ${CARD_UPDATE_ASSIGNMENTS},
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
        input.card_layout,
        input.profile_icon_size,
        input.profile_icon_align,
        input.profile_icon_shape,
        input.card_rarity,
        input.title_color_id,
        input.open_booster,
        input.different_cards,
        input.date_first_card,
        input.level,
        input.block_mined,
        input.picks,
        input.points
      )
      .run();
  } catch (error) {
    if (isUsernameConflict(error)) {
      return { status: 409, error: USERNAME_TAKEN_ERROR };
    }
    throw error;
  }

  // The favourites travel with the card: a followed player gets them in the same batch read, so
  // the Follow List never needs a second route for them. A payload WITHOUT the lists writes
  // nothing: only an explicit field (an empty list included) may change what is stored.
  await writeFavorites(db, input.uuid, {
    trophies: input.favorite_trophies,
    cards: input.favorite_cards,
    binder: input.binder_code,
  });

  // The wishlist travels with the card too, in its own table: it is what a followed player reads
  // to favour the cards the owner hopes to receive, in the friend dialog and in a trade. Same rule
  // as the favourites: a payload WITHOUT the field writes nothing.
  await writeWishlist(db, input.uuid, input.wishlist_cards);

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
      `SELECT ${CARD_COLUMNS}, updated_at
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
  const query = `SELECT ${CARD_COLUMNS}, updated_at
    FROM cards
    WHERE uuid IN (${placeholders})`;

  const result = await db.prepare(query).bind(...cleaned).all<PublicCard>();
  return result.results ?? [];
}
