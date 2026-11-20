import { getCardsByUuids, UpsertCardInput, upsertCard } from "./cardService";

export interface Env {
  DB: D1Database;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
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