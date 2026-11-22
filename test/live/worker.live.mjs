#!/usr/bin/env node
/**
 * Live end-to-end check of a RUNNING MineCards worker: every route that touches D1.
 *
 * Covers the whole online surface against a real HTTP endpoint: trainer cards, favourites and
 * binder, likes (single, batch, public and authenticated reads, Spark bonus), online saves,
 * the trade state machine, the administration gate, and the concurrency of a first publication.
 *
 * USAGE
 *   node test/live/worker.live.mjs                       # local worker (http://127.0.0.1:8787)
 *   node test/live/worker.live.mjs --url=https://minecard-backend.jordanmorindev.workers.dev
 *   npm run test:live
 *
 * OPTIONS (or the matching environment variable)
 *   --url=<base>        Worker origin to test.        WORKER_URL   (default http://127.0.0.1:8787)
 *   --prefix=<text>     Username prefix of the accounts created. LIVE_PREFIX (default "E2E")
 *   --admin-key=<key>   Also checks the content of /admin/backup. ADMIN_KEY (never logged)
 *   --restore           Also runs POST /admin/restore. DESTRUCTIVE: it rewrites the whole database
 *                       from the dump it just downloaded, so only use it on a database you may wipe.
 *   --max-batch-ms=<n>  Fails when one 30-friend like batch takes longer. LIVE_MAX_BATCH_MS (3000)
 *
 * WHAT IT LEAVES BEHIND
 *   Test accounts (`<prefix> <run> …`), their likes, saves and trades. Nothing is deleted: the
 *   targeted cleanup is `sql/schema/admin/clean_test_accounts.sql` (see the reminder printed at
 *   the end). The script is safe to run twice: every account gets a fresh UUID.
 *
 * EXIT CODE
 *   0 when every check passed, 1 otherwise (each failure is printed with its status).
 */
import { gunzipSync } from "node:zlib";
import { randomUUID, randomBytes } from "node:crypto";

/** Parses `--key=value` and `--flag`, keeping environment fallbacks. */
function readOptions(argv) {
  const flags = new Map();
  for (const entry of argv) {
    if (!entry.startsWith("--")) continue;
    const [key, ...rest] = entry.slice(2).split("=");
    flags.set(key, rest.length > 0 ? rest.join("=") : true);
  }
  const read = (name, env, fallback) => {
    const value = flags.get(name);
    if (typeof value === "string") return value;
    return process.env[env] ?? fallback;
  };
  return {
    url: read("url", "WORKER_URL", "http://127.0.0.1:8787").replace(/\/+$/, ""),
    prefix: read("prefix", "LIVE_PREFIX", "E2E"),
    adminKey: read("admin-key", "ADMIN_KEY", ""),
    restore: flags.has("restore"),
    maxBatchMs: Number(read("max-batch-ms", "LIVE_MAX_BATCH_MS", "3000")),
  };
}

const OPTIONS = readOptions(process.argv.slice(2));
const RUN = randomBytes(3).toString("hex");
const RESULTS = [];

/**
 * Records and prints one check.
 *
 * @param {string} name - What is checked, in French (the language of the product).
 * @param {boolean} ok - Outcome.
 * @param {unknown} [detail] - Value worth printing on failure.
 */
function check(name, ok, detail = "") {
  RESULTS.push({ name, ok: Boolean(ok) });
  const suffix = detail === "" || detail === undefined ? "" : ` | ${String(detail)}`;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${suffix}`);
}

/**
 * Sends one JSON request and decodes the answer.
 *
 * @param {string} method - HTTP verb.
 * @param {string} path - Path and query string, starting with `/`.
 * @param {object|undefined} body - JSON body.
 * @param {Record<string,string>} [headers] - Extra headers.
 * @returns {Promise<{status: number, body: any, headers: Headers}>} The answer.
 */
async function call(method, path, body, headers = {}) {
  const init = { method, headers: { "user-agent": "minecards-live-check", ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const response = await fetch(OPTIONS.url + path, { ...init, signal: AbortSignal.timeout(60000) });
  const text = await response.text();
  let parsed;
  try {
    parsed = text === "" ? {} : JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** @returns {string} A 16-character code, shaped like the one the game generates. */
function authCode() {
  return randomBytes(8).toString("hex").toUpperCase();
}

/**
 * Body of `POST /cards`.
 *
 * @param {string} uuid - Player UUID.
 * @param {string} code - Secret code.
 * @param {string} username - Displayed name.
 * @returns {object} The payload.
 */
function cardBody(uuid, code, username) {
  return {
    uuid,
    auth_code: code,
    username,
    background_card_id: "default",
    profile_picture_id: "none",
    title_id: "none",
    card_color_id: "auto",
    username_color_id: "auto",
    location_id: "assets/img/card_back.png",
    card_layout: "classic",
    profile_icon_size: "normal",
    profile_icon_align: "center",
    profile_icon_shape: "normal",
    card_rarity: 1,
    title_color_id: "auto",
    open_booster: 0,
    different_cards: 0,
    date_first_card: "2026-01-01",
    level: 1,
    block_mined: 0,
    picks: 0,
    points: 10,
  };
}

/**
 * Publishes a fresh trainer card.
 *
 * @param {string} label - Suffix of the username.
 * @returns {Promise<{uuid: string, code: string, status: number}>} The account.
 */
async function newPlayer(label) {
  const uuid = randomUUID();
  const code = authCode();
  const { status } = await call("POST", "/cards", cardBody(uuid, code, `${OPTIONS.prefix} ${RUN} ${label}`));
  return { uuid, code, status };
}

/**
 * Card payload of one side of a trade.
 *
 * @param {number} rarity - Rarity, 1 to 5.
 * @param {string} key - Collection key (`<cardId>_<style>`).
 * @returns {object} The payload.
 */
function tradeCard(rarity, key) {
  return {
    key,
    card_id: key.split("_")[0],
    style: "classic",
    set: "A1",
    rarity,
    name: `${OPTIONS.prefix} card`,
  };
}

async function cards() {
  const alice = await newPlayer("Alice");
  check("POST /cards crée un compte", alice.status === 201, alice.status);

  const updated = cardBody(alice.uuid, alice.code, `${OPTIONS.prefix} ${RUN} Alice 2`);
  updated.level = 4;
  let answer = await call("POST", "/cards", updated);
  check(
    "POST /cards met à jour",
    answer.status === 200 && answer.body.action === "updated" && answer.body.card.level === 4,
    answer.status
  );

  answer = await call("POST", "/cards", { ...updated, auth_code: "ZZZZZZZZZZZZZZZZ" });
  check("mauvais code → 403", answer.status === 403, answer.status);

  const incomplete = { ...updated };
  delete incomplete.username;
  answer = await call("POST", "/cards", incomplete);
  check("corps incomplet → 400", answer.status === 400, answer.status);

  const bob = await newPlayer("Bob");
  answer = await call("GET", `/cards?uuids=${alice.uuid},${bob.uuid}`);
  const returned = new Set((answer.body.cards ?? []).map((card) => card.uuid));
  check(
    "GET /cards?uuids= renvoie les deux",
    answer.status === 200 && returned.has(alice.uuid) && returned.has(bob.uuid),
    answer.status
  );

  answer = await call("POST", "/cards/batch", { uuids: [alice.uuid] });
  check(
    "POST /cards/batch → cards + favorites",
    answer.status === 200 && (answer.body.cards ?? []).length === 1 && typeof answer.body.favorites === "object",
    answer.status
  );

  await call(
    "POST",
    "/cards",
    {
      ...updated,
      favorite_cards: ["a1_001", "a1_002"],
      favorite_trophies: ["A1_completion_bronze"],
      binder_code: "eJyAAA_-",
    }
  );
  answer = await call("GET", `/cards?uuids=${alice.uuid}`);
  let row = answer.body.favorites?.[alice.uuid] ?? {};
  check(
    "favoris + binder écrits",
    JSON.stringify(row.cards) === JSON.stringify(["a1_001", "a1_002"]) &&
      JSON.stringify(row.trophies) === JSON.stringify(["A1_completion_bronze"]) &&
      row.binder === "eJyAAA_-",
    JSON.stringify(row)
  );

  await call("POST", "/cards", updated);
  answer = await call("GET", `/cards?uuids=${alice.uuid}`);
  row = answer.body.favorites?.[alice.uuid] ?? {};
  check("publication sans les champs ne change rien", (row.cards ?? []).length === 2, JSON.stringify(row));

  await call("POST", "/cards", { ...updated, favorite_cards: [], favorite_trophies: [], binder_code: "" });
  answer = await call("GET", `/cards?uuids=${alice.uuid}`);
  row = answer.body.favorites?.[alice.uuid] ?? {};
  check(
    "listes vides effacent favoris et binder",
    (row.cards ?? [null]).length === 0 && (row.trophies ?? [null]).length === 0 && row.binder === "",
    JSON.stringify(row)
  );

  answer = await call("POST", "/cards", { ...updated, binder_code: "pas un code" });
  check("binder_code non URL-safe → 400", answer.status === 400, answer.status);

  return alice;
}

async function likes(alice) {
  const targets = [];
  for (let index = 0; index < 30; index += 1) targets.push(await newPlayer(`Like ${index}`));
  const targetUuids = targets.map((target) => target.uuid);
  const unknown = randomUUID();

  const startedAt = performance.now();
  let answer = await call("POST", "/likes/batch", {
    uuid: alice.uuid,
    auth_code: alice.code,
    target_uuids: [...targetUuids, unknown, alice.uuid],
  });
  const elapsed = Math.round(performance.now() - startedAt);
  check(
    "lot de 30 amis likés",
    answer.status === 200 && (answer.body.liked ?? []).length === 30,
    `${answer.status} · ${elapsed} ms · likes_sent=${answer.body.likes_sent}`
  );
  check(
    "lot rapide (2 allers-retours D1)",
    answer.status === 200 && elapsed <= OPTIONS.maxBatchMs,
    `${elapsed} ms (max ${OPTIONS.maxBatchMs})`
  );
  check(
    "inconnu et soi-même écartés",
    JSON.stringify(answer.body.unknown) === JSON.stringify([unknown]) && !(answer.body.liked ?? []).includes(alice.uuid),
    JSON.stringify(answer.body.unknown)
  );

  answer = await call("POST", "/likes/batch", { uuid: alice.uuid, auth_code: alice.code, target_uuids: targetUuids });
  check(
    "rejeu : 30 'already', 0 liké",
    answer.status === 200 && (answer.body.liked ?? []).length === 0 && (answer.body.already ?? []).length === 30,
    answer.status
  );

  answer = await call("POST", "/likes/friend", { uuid: alice.uuid, auth_code: alice.code, target_uuid: targetUuids[0] });
  check("like simple déjà donné → 409", answer.status === 409, answer.status);

  answer = await call("POST", "/likes/friend", {
    uuid: alice.uuid,
    auth_code: "WRONGCODE0000000",
    target_uuid: targetUuids[0],
  });
  check("like avec mauvais code → 403", answer.status === 403, answer.status);

  answer = await call("POST", "/likes/batch", { uuid: alice.uuid, auth_code: alice.code, target_uuids: ["pas-un-uuid"] });
  check("lot avec UUID invalide → 400", answer.status === 400, answer.status);

  answer = await call("GET", `/likes?uuids=${targetUuids.slice(0, 3).join(",")}`);
  const counts = Object.values(answer.body.likes ?? {});
  check("compteurs publics à 1", answer.status === 200 && counts.length === 3 && counts.every((value) => value === 1), JSON.stringify(answer.body));

  for (const target of targets.slice(0, 10)) {
    await call("POST", "/likes/friend", { uuid: target.uuid, auth_code: target.code, target_uuid: alice.uuid });
  }
  answer = await call("GET", `/likes?uuid=${alice.uuid}&auth_code=${alice.code}`);
  check(
    "lecture authentifiée : likes_sent + amis déjà likés",
    answer.status === 200 && answer.body.likes_sent === 30 && (answer.body.liked_targets_today ?? []).length === 30,
    answer.status
  );
  check(
    "bonus par entiers (10 likes = 1 Spark)",
    answer.status === 200 && answer.body.sparks === 1 && Math.abs(Number(answer.body.bonus_from_like)) < 0.001,
    `likes=${answer.body.likes} sparks=${answer.body.sparks} bonus=${answer.body.bonus_from_like}`
  );
}

async function saves(alice) {
  let answer = await call("POST", "/saves", { uuid: alice.uuid, auth_code: alice.code, save: "A".repeat(2000) });
  check("POST /saves enregistre", answer.status === 201 && answer.body.kept === 5, answer.status);

  answer = await call("GET", `/saves/last?uuid=${alice.uuid}&auth_code=${alice.code}`);
  check("GET /saves/last donne la date", answer.status === 200 && answer.body.exists === true, answer.status);

  let last = "";
  for (let index = 0; index < 6; index += 1) {
    last = `SAVE-${index}-${"A".repeat(1000)}`;
    await call("POST", "/saves", { uuid: alice.uuid, auth_code: alice.code, save: last });
  }
  answer = await call("GET", `/saves/last/file?uuid=${alice.uuid}&auth_code=${alice.code}`);
  check("GET /saves/last/file renvoie le dernier", answer.status === 200 && answer.body.save === last, `${answer.status} · ${(answer.body.save ?? "").length} o`);

  answer = await call("GET", `/saves/last?uuid=${alice.uuid}&auth_code=WRONGCODE0000000`);
  check("sauvegardes privées : mauvais code → 403", answer.status === 403, answer.status);

  answer = await call("POST", "/saves", { uuid: alice.uuid, auth_code: alice.code, save: "A".repeat(1000001) });
  check("sauvegarde > 1 Mo → 413", answer.status === 413, answer.status);
}

async function trades() {
  const initiator = await newPlayer("Trade A");
  const responder = await newPlayer("Trade B");
  const outsider = await newPlayer("Trade C");

  let answer = await call("POST", "/trades", {
    uuid: initiator.uuid,
    auth_code: initiator.code,
    responder_uuid: responder.uuid,
    rarity: 2,
    card: tradeCard(2, "trade_a_classic"),
  });
  const tradeId = answer.body.trade?.id ?? "";
  check("POST /trades crée une demande", answer.status === 201 && answer.body.trade?.status === "pending", answer.status);

  answer = await call("POST", "/trades", {
    uuid: initiator.uuid,
    auth_code: initiator.code,
    responder_uuid: responder.uuid,
    rarity: 2,
    card: tradeCard(2, "trade_a_classic"),
  });
  check("deux demandes ouvertes → 409", answer.status === 409, answer.status);

  answer = await call("POST", "/trades", {
    uuid: initiator.uuid,
    auth_code: initiator.code,
    responder_uuid: outsider.uuid,
    rarity: 4,
    card: tradeCard(2, "trade_b_classic"),
  });
  check("rareté incohérente → 400", answer.status === 400, answer.status);

  answer = await call("POST", "/trades", {
    uuid: initiator.uuid,
    auth_code: initiator.code,
    responder_uuid: randomUUID(),
    rarity: 2,
    card: tradeCard(2, "trade_a_classic"),
  });
  check("destinataire sans compte → 404", answer.status === 404, answer.status);

  answer = await call("GET", `/trades?uuid=${responder.uuid}&auth_code=${responder.code}`);
  check("GET /trades montre la demande entrante", answer.status === 200 && (answer.body.incoming ?? []).length === 1, answer.status);

  answer = await call("POST", "/trades/accept", { uuid: responder.uuid, auth_code: responder.code, trade_id: tradeId });
  check("le destinataire n'accepte pas → 403", answer.status === 403, answer.status);

  answer = await call("POST", "/trades/respond", {
    uuid: responder.uuid,
    auth_code: responder.code,
    trade_id: tradeId,
    action: "propose",
    card: tradeCard(2, "trade_c_classic"),
  });
  check("POST /trades/respond propose", answer.status === 200, answer.status);

  answer = await call("POST", "/trades/accept", { uuid: initiator.uuid, auth_code: initiator.code, trade_id: tradeId });
  check("POST /trades/accept accepte", answer.status === 200, answer.status);

  answer = await call("POST", "/trades/claim", { uuid: responder.uuid, auth_code: responder.code, trade_id: tradeId });
  check("1re récupération : encore 'accepted'", answer.status === 200 && answer.body.status === "accepted", JSON.stringify(answer.body));

  answer = await call("POST", "/trades/claim", { uuid: initiator.uuid, auth_code: initiator.code, trade_id: tradeId });
  check("2e récupération : 'completed'", answer.status === 200 && answer.body.status === "completed", JSON.stringify(answer.body));

  answer = await call("GET", `/trades?uuid=${initiator.uuid}&auth_code=${initiator.code}`);
  check(
    "historique : échange terminé présent",
    answer.status === 200 && (answer.body.history ?? []).some((trade) => trade.status === "completed"),
    answer.status
  );

  answer = await call("POST", "/trades/claim", { uuid: outsider.uuid, auth_code: outsider.code, trade_id: tradeId });
  check("un tiers ne récupère pas → 403", answer.status === 403, answer.status);

  answer = await call("POST", "/trades", {
    uuid: initiator.uuid,
    auth_code: initiator.code,
    responder_uuid: responder.uuid,
    rarity: 1,
    card: tradeCard(1, "trade_d_classic"),
  });
  const denyId = answer.body.trade?.id ?? "";
  answer = await call("POST", "/trades/respond", {
    uuid: responder.uuid,
    auth_code: responder.code,
    trade_id: denyId,
    action: "deny",
  });
  check("refus → 'declined'", answer.status === 200 && answer.body.status === "declined", JSON.stringify(answer.body));

  answer = await call("POST", "/trades", {
    uuid: initiator.uuid,
    auth_code: initiator.code,
    responder_uuid: responder.uuid,
    rarity: 1,
    card: tradeCard(1, "trade_e_classic"),
  });
  const cancelId = answer.body.trade?.id ?? "";
  answer = await call("POST", "/trades/cancel", { uuid: initiator.uuid, auth_code: initiator.code, trade_id: cancelId });
  check("annulation → 'cancelled'", answer.status === 200 && answer.body.status === "cancelled", JSON.stringify(answer.body));

  answer = await call("POST", "/trades", {
    uuid: initiator.uuid,
    auth_code: initiator.code,
    responder_uuid: responder.uuid,
    rarity: 1,
    card: tradeCard(1, "trade_f_classic"),
  });
  const refuseId = answer.body.trade?.id ?? "";
  await call("POST", "/trades/respond", {
    uuid: responder.uuid,
    auth_code: responder.code,
    trade_id: refuseId,
    action: "propose",
    card: tradeCard(1, "trade_g_classic"),
  });
  await call("POST", "/trades/accept", { uuid: initiator.uuid, auth_code: initiator.code, trade_id: refuseId });
  answer = await call("POST", "/trades/refuse", { uuid: responder.uuid, auth_code: responder.code, trade_id: refuseId });
  check("refus avant récupération → 'cancelled'", answer.status === 200 && answer.body.status === "cancelled", JSON.stringify(answer.body));
}

async function admin() {
  let answer = await call("GET", "/admin/backup");
  check("GET /admin/backup sans clé → 401", answer.status === 401, answer.status);

  answer = await call("POST", "/admin/restore", {}, { "x-admin-key": "not-the-key" });
  check("POST /admin/restore mauvaise clé → 403", answer.status === 403, answer.status);

  const anonymous = await call("GET", "/admin/backup");
  check("aucun CORS sur /admin", anonymous.headers.get("access-control-allow-origin") === null, anonymous.headers.get("access-control-allow-origin"));

  if (!OPTIONS.adminKey) {
    console.log("… contenu du backup et restauration non testés (--admin-key absent)");
    return;
  }

  const raw = await fetch(`${OPTIONS.url}/admin/backup`, {
    headers: { "x-admin-key": OPTIONS.adminKey, "user-agent": "minecards-live-check" },
    signal: AbortSignal.timeout(60000),
  });
  check("GET /admin/backup avec la clé → 200", raw.status === 200, raw.status);
  const bytes = Buffer.from(await raw.arrayBuffer());
  const gzipped = bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  check("backup gzippé", gzipped, `${bytes.length} o`);
  let dump = null;
  if (gzipped) {
    try {
      dump = JSON.parse(gunzipSync(bytes).toString("utf8"));
    } catch {
      dump = null;
    }
  }
  const names = (dump?.tables ?? []).map((table) => table.name);
  check(
    "le backup embarque les tables de likes",
    names.includes("likes") && names.includes("like_daily_target"),
    names.join(", ")
  );

  if (!OPTIONS.restore) {
    console.log("… restauration non testée (--restore absent, elle réécrit toute la base)");
    return;
  }
  if (!dump) {
    check("restauration possible", false, "dump illisible");
    return;
  }
  answer = await call("POST", "/admin/restore", dump, { "x-admin-key": OPTIONS.adminKey });
  check(
    "POST /admin/restore → 200 avec safety_backup",
    answer.status === 200 && answer.body.restored === true && typeof answer.body.safety_backup === "string",
    `${answer.status} · ${answer.body.rows} lignes`
  );
}

async function misc() {
  let answer = await call("GET", "/does-not-exist");
  check("route inconnue → 404", answer.status === 404, answer.status);
  answer = await call("OPTIONS", "/cards");
  check("OPTIONS → 204", answer.status === 204, answer.status);
}

async function concurrency() {
  const uuid = randomUUID();
  const code = authCode();
  const answers = await Promise.all(
    Array.from({ length: 8 }, () => call("POST", "/cards", cardBody(uuid, code, `${OPTIONS.prefix} ${RUN} race`)))
  );
  const statuses = answers.map((answer) => answer.status);
  check(
    "8 premières publications simultanées : aucun 500",
    !statuses.includes(500) && statuses.filter((status) => status === 201).length === 1,
    statuses.sort().join(",")
  );
}

const startedAt = Date.now();
console.log(`Worker: ${OPTIONS.url} · run ${RUN} · préfixe "${OPTIONS.prefix}"`);

try {
  const alice = await cards();
  await likes(alice);
  await saves(alice);
  await trades();
  await admin();
  await misc();
  await concurrency();
} catch (error) {
  check("scénario interrompu par une erreur réseau", false, error instanceof Error ? error.message : String(error));
}

const failed = RESULTS.filter((result) => !result.ok);
console.log();
console.log(`${RESULTS.length - failed.length}/${RESULTS.length} vérifications passées en ${Math.round((Date.now() - startedAt) / 100) / 10} s`);
if (failed.length > 0) {
  console.log(`ÉCHECS : ${failed.map((result) => result.name).join(" | ")}`);
  process.exitCode = 1;
}
// The cleanup that matches the prefix that was used: the marker rule, or the older prefixes.
const cleanupScript = OPTIONS.prefix.toUpperCase().includes("TESTUSERBDD")
  ? "clean_testuserbdd_accounts.sql"
  : "clean_test_accounts.sql";
console.log(
  "Nettoyage des comptes de test :\n" +
    `  npx wrangler d1 execute minecard-db --file=./sql/schema/admin/${cleanupScript} --remote`
);
