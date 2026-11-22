import { handleAdminRequest } from "./adminService";
import { getCardsByUuids, UpsertCardInput, upsertCard } from "./cardService";
import { handleLikesRequest } from "./likeService";
import { handleSaveRequest } from "./saveService";
import { handleTradeRequest } from "./tradeService";

export interface Env {
  DB: D1Database;
  /** Administration key of `/admin/*` (see `doc/admin-backup.md`). */
  adminkey?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
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

function validateUpsertCardPayload(
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // Administration owns `/admin` (`/admin/backup`, `/admin/restore`): it answers a
      // ready Response, or null for any other path.
      const adminResponse = await handleAdminRequest(
        request,
        { db: env.DB, adminKey: env.adminkey },
        path
      );
      if (adminResponse) {
        return adminResponse;
      }

      // Trades own their whole subtree (`/trades`, `/trades/respond`, ...): the
      // service answers null for any other path, so the card routes below are
      // untouched.
      const tradeResult = await handleTradeRequest(request, env.DB, path);
      if (tradeResult) {
        return jsonResponse(tradeResult.body, tradeResult.status);
      }

      // Online backups own `/saves` (`/saves`, `/saves/last`, `/saves/last/file`): same
      // contract, the service answers null for any other path.
      const saveResult = await handleSaveRequest(request, env.DB, path);
      if (saveResult) {
        return jsonResponse(saveResult.body, saveResult.status);
      }

      // Likes own `/likes` (`/likes`, `/likes/friend`): the counts and the bonus are server-side,
      // the Sparks they pay stay in the player's save.
      const likeResult = await handleLikesRequest(request, env.DB, path);
      if (likeResult) {
        return jsonResponse(likeResult.body, likeResult.status);
      }

      if (request.method === "GET" && path === "/cards") {
        const rawUuids = url.searchParams.get("uuids") ?? "";
        const uuidList = rawUuids.split(",");
        const cards = await getCardsByUuids(env.DB, uuidList);
        return jsonResponse({ cards });
      }

      if (request.method === "POST" && path === "/cards/batch") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "JSON invalide." }, 400);
        }

        const uuids =
          body && typeof body === "object" && Array.isArray((body as { uuids?: unknown }).uuids)
            ? (body as { uuids: unknown[] }).uuids.filter(
                (u): u is string => typeof u === "string"
              )
            : null;

        if (!uuids) {
          return jsonResponse(
            { error: "Le champ 'uuids' (tableau de string) est requis." },
            400
          );
        }

        const cards = await getCardsByUuids(env.DB, uuids);
        return jsonResponse({ cards });
      }

      if ((request.method === "POST" || request.method === "PUT") && path === "/cards") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "JSON invalide." }, 400);
        }

        const validation = validateUpsertCardPayload(body);
        if (!validation.ok) {
          return jsonResponse({ error: validation.error }, 400);
        }

        const result = await upsertCard(env.DB, validation.data);

        if (result.status === 403) {
          return jsonResponse({ error: result.error }, 403);
        }

        return jsonResponse(
          {
            action: result.action,
            card: result.card,
          },
          result.status
        );
      }

      return jsonResponse({ error: "Route introuvable." }, 404);
    } catch (err) {
      console.error("Erreur Worker:", err);
      return jsonResponse({ error: "Erreur interne du serveur." }, 500);
    }
  },
};