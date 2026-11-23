const BASE_URL = "https://minecard-backend.<ton-sous-domaine>.workers.dev";

```ts
async function saveMyCard() {
  const payload = {
    uuid: "550e8400-e29b-41d4-a716-446655440000",
    auth_code: localStorage.getItem("minecard_auth_code")!,
    username: "StevePro",
    background_card_id: "bg_nether_01",
    profile_picture_id: "pfp_alex_smile",
    title_id: "title_miner",
    card_color_id: "color_emerald",
    username_color_id: "ucolor_gold",
    location_id: "loc_overworld",
    card_layout: "classic",
    profile_icon_size: "normal",
    profile_icon_align: "center",
    profile_icon_shape: "normal",
    card_rarity: 3,
    title_color_id: "auto",
    open_booster: 12,
    different_cards: 48,
    date_first_card: "2026-05-10",
    level: 15,
    block_mined: 3420,
    picks: 9,
    points: 1850,
  };

  const res = await fetch(`${BASE_URL}/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Erreur HTTP ${res.status}`);
  }

  // Contient { action: "created" | "updated", card: { ... } } sans auth_code
  return await res.json();
}
```

## Pseudo unique

`username` est unique en base (index insensible à la casse `idx_cards_username_unique`, voir
`sql/schema/10-username-unique.sql`). Une publication qui change de pseudo est donc vérifiée avant
l'écriture :

- `409` avec `{ "error": "Ce pseudo est déjà pris par un autre joueur." }` quand un autre compte
  l'utilise déjà (même en changeant la casse) ;
- l'index rattrape les deux publications simultanées et renvoie le même `409`, jamais un `500` ;
- une publication qui garde son propre pseudo n'est jamais refusée.

Le pseudo devient alors un identifiant public, traduit en UUID par `GET /lookup` (voir
`doc/lookup.md`).
