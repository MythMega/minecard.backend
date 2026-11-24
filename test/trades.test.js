/**
 * Trades - regression tests of the rarity 6 opening.
 *
 * The rule: rarity 6 (Unique) is tradable from four friendship stars. The friendship XP itself
 * lives in the player's save, so each request carries the stars it used (`friendship_stars`) and
 * the worker refuses a rarity 6 trade below four. The table check was widened for existing
 * databases in `sql/schema/11-trade-rarity-6.sql`.
 *
 * No framework: `node --test`, and a D1 stand-in that records the statements (see
 * `favorites.test.js` for the same approach). The real database was checked through
 * `wrangler d1 execute --local` with the schema files.
 *
 * Run with `npm test`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  getTradeCost,
  handleTradeRequest,
  isRarityOpenAtFriendship,
} from "../src/tradeService.ts";

const INITIATOR = "6f9619ff-8b86-d011-b42d-00cf4fc964ff";
const RESPONDER = "7a8b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const AUTH_CODE = "ABCDEFGH12345678";

/** Body of a rarity 6 request, as the client sends it from four stars. */
function tradeBody(stars) {
  return {
    uuid: INITIATOR,
    auth_code: AUTH_CODE,
    responder_uuid: RESPONDER,
    rarity: 6,
    friendship_stars: stars,
    card: {
      key: "SERIE-A1 _ V001_classic",
      card_id: "SERIE-A1 / V001",
      style: "classic",
      set: "A1",
      rarity: 6,
      name: "Unique",
    },
  };
}

/**
 * D1 stand-in for one trade creation or one proposal.
 *
 * @param {{rarity?: number, stars?: number}} [options] - Row and request shape.
 * @returns {{db: object, inserts: Array<{sql: string, values: unknown[]}>}} The fake and its writes.
 */
function tradeDb({ rarity = 6, stars = 4 } = {}) {
  const inserts = [];
  const card = {
    key: "SERIE-A1 _ V001_classic",
    card_id: "SERIE-A1 / V001",
    style: "classic",
    set: "A1",
    rarity,
    name: "Unique",
  };
  const row = {
    id: "trade-id",
    status: "pending",
    rarity,
    initiator_uuid: INITIATOR,
    responder_uuid: RESPONDER,
    initiator_card_key: card.key,
    initiator_card_json: JSON.stringify(card),
    responder_card_key: null,
    responder_card_json: null,
    sparks_cost: getTradeCost(rarity).sparks,
    ender_eyes_cost: getTradeCost(rarity).enderEyes,
    created_at: "2026-11-24 00:00:00",
    updated_at: "2026-11-24 00:00:00",
    expires_at: "2026-11-25 00:00:00",
    initiator_claimed_at: null,
    responder_claimed_at: null,
    closed_at: null,
  };
  return {
    inserts,
    db: {
      prepare(sql) {
        const record = { sql, values: [] };
        return {
          bind(...values) {
            record.values = values;
            return {
              async first() {
                if (/SELECT auth_code FROM users/.test(sql)) return { auth_code: AUTH_CODE };
                if (/SELECT uuid FROM users WHERE uuid/.test(sql)) return { uuid: RESPONDER };
                if (/SELECT id FROM trades WHERE initiator_uuid/.test(sql)) return null;
                if (/SELECT \* FROM trades WHERE id/.test(sql)) return row;
                return null;
              },
              async all() {
                if (/FROM cards WHERE uuid IN/.test(sql)) {
                  return {
                    results: [
                      { uuid: INITIATOR, username: "Initiateur" },
                      { uuid: RESPONDER, username: "Répondeur" },
                    ],
                  };
                }
                return { results: [] };
              },
              async run() {
                if (/INSERT INTO trades/.test(sql)) inserts.push(record);
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
}

test("rarity 6 costs five Ender Eyes and its squared Sparks", () => {
  assert.deepEqual(getTradeCost(6), { sparks: 36, enderEyes: 5 });
  // The other rarities keep the legacy rule of the worker.
  assert.deepEqual(getTradeCost(1), { sparks: 1, enderEyes: 1 });
  assert.deepEqual(getTradeCost(5), { sparks: 25, enderEyes: 5 });
});

test("rarity 6 needs four friendship stars, every other rarity does not", () => {
  assert.equal(isRarityOpenAtFriendship(6, 4), true);
  assert.equal(isRarityOpenAtFriendship(6, 5), true);
  assert.equal(isRarityOpenAtFriendship(6, 3), false);
  assert.equal(isRarityOpenAtFriendship(6, 0), false);
  // A missing or malformed star count cannot open the rarity.
  assert.equal(isRarityOpenAtFriendship(6, Number(undefined)), false);
  assert.equal(isRarityOpenAtFriendship(6, 4.5), false);
  assert.equal(isRarityOpenAtFriendship(5, 0), true);
  assert.equal(isRarityOpenAtFriendship(1, 0), true);
});

test("creating a rarity 6 trade below four stars is refused before any write", async () => {
  const { db, inserts } = tradeDb();
  const result = await handleTradeRequest(
    new Request("https://worker.test/trades", {
      method: "POST",
      body: JSON.stringify(tradeBody(3)),
    }),
    db,
    "/trades"
  );

  assert.equal(result.status, 400);
  assert.match(result.body.error, /4 étoiles/);
  assert.equal(inserts.length, 0);
});

test("creating a rarity 6 trade from four stars stores the price of the table", async () => {
  const { db, inserts } = tradeDb();
  const result = await handleTradeRequest(
    new Request("https://worker.test/trades", {
      method: "POST",
      body: JSON.stringify(tradeBody(4)),
    }),
    db,
    "/trades"
  );

  assert.equal(result.status, 201);
  assert.equal(result.body.trade.rarity, 6);
  assert.equal(inserts.length, 1);
  const values = inserts[0].values;
  // (id, rarity, initiator, responder, key, json, sparks, eyes)
  assert.equal(values[1], 6);
  assert.equal(values[6], 36);
  assert.equal(values[7], 5);
});

test("the responder side of a rarity 6 trade is gated on its own stars", async () => {
  const { db } = tradeDb();
  const body = (stars) => ({
    uuid: RESPONDER,
    auth_code: AUTH_CODE,
    trade_id: "trade-id",
    action: "propose",
    friendship_stars: stars,
    card: {
      key: "SERIE-A1 _ V002_classic",
      card_id: "SERIE-A1 / V002",
      style: "classic",
      set: "A1",
      rarity: 6,
      name: "Unique",
    },
  });

  const refused = await handleTradeRequest(
    new Request("https://worker.test/trades/respond", {
      method: "POST",
      body: JSON.stringify(body(3)),
    }),
    db,
    "/trades/respond"
  );
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /4 étoiles/);

  const accepted = await handleTradeRequest(
    new Request("https://worker.test/trades/respond", {
      method: "POST",
      body: JSON.stringify(body(4)),
    }),
    db,
    "/trades/respond"
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.status, "proposed");
});

