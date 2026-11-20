# Échanges (trades) — API, schéma et cycle de vie

Deux joueurs échangent **une carte de même rareté**. Le worker est la source de
vérité du cycle de vie, du stock d'**Œil de l'End** et des statistiques ;
la collection et les Sparks restent locaux au navigateur.

- Schéma : [`sql/schema/trade-table.sql`](../sql/schema/trade-table.sql)
- Code : [`src/tradeService.ts`](../src/tradeService.ts), routé par `src/index.ts`
- Côté jeu : `js/business/TradeManager.js` et `js/UI/views/TradeView.js`

## Règles

| Règle | Valeur |
| --- | --- |
| Raretés échangeables | 1 à 5 (la rareté 6, Unique, ne s'échange jamais) |
| Cartes échangées | même rareté **exactement** |
| Coût en Œil de l'End | 1 par rareté (rareté 5 = tout le stock) |
| Coût en Sparks | rareté² (rareté 4 = 16 Sparks) |
| Stock d'Œil de l'End | 5 maximum, +1 par jour UTC |
| Demandes ouvertes simultanées | 1 par initiateur (`pending` + `proposed`) |
| Délai | 24 h avant expiration automatique, remboursement des deux côtés |
| Cartes proposées | uniquement des doublons (vérifié côté client) |
| Statistiques | **locales** (`user_state["trades"].stats`), jamais en base |

Le coût est identique pour les deux joueurs : chacun paie
`rareté` Œils de l'End et `rareté²` Sparks pour la carte qu'il met dans
l'échange. Aucune des deux cartes ne peut être « plus chère » que l'autre,
puisque la rareté est la même.

## Authentification

Chaque requête porte `uuid` + `auth_code`, exactement comme `POST /cards`.
Un joueur doit avoir **publié sa carte de dresseur** (ligne dans `users`) pour
échanger : c'est la seule table qui contient le code secret. Une paire
invalide reçoit `403`.

## Statuts

| Statut | Phase |
| --- | --- |
| `pending` | A a proposé une carte, en attente de B |
| `proposed` | B a répondu avec une carte de même rareté, en attente de A |
| `accepted` | A a accepté ; les deux cartes sont verrouillées, chacun peut récupérer |
| `completed` | Les deux joueurs ont récupéré leur carte |
| `declined` | B a refusé (remboursement de A) |
| `cancelled` | A a annulé (remboursement des deux) |
| `expired` | 24 h écoulées avant acceptation (remboursement des deux) |

Un retrait de contre-proposition par B (`cancel` sur un trade `proposed`) ne
crée pas un statut à part : le trade revient à `pending` et B récupère sa
carte et ses Œils de l'End.

## Remboursements

Le worker ne peut pas rendre une carte ni des Sparks qu'il ne stocke pas : il
rend les **Œils de l'End** (il les possède) et renvoie le statut. Le client,
lui, tient un registre local des cartes et Sparks mis en jeu
(`user_state["trades"].escrows`) et les rend quand il voit un statut clos
(`declined`, `cancelled`, `expired`). Ce registre est la raison pour laquelle un
remboursement ne peut pas être appliqué deux fois, même après un rechargement.

## Routes

Toutes les réponses sont du JSON. Les erreurs suivent le format existant
`{ "error": "message" }`.

### `GET /trades?uuid=…&auth_code=…`

Liste les échanges du joueur, applique le rafraîchissement quotidien des Œils
de l'End et **expire d'abord** les échanges ouverts depuis plus de 24 h.

```json
{
  "uuid": "…",
  "ender_eyes": 3,
  "max_ender_eyes": 5,
  "next_refill_day": "2026-11-21",
  "incoming": [ { "id": "…", "status": "pending", "my_role": "responder", "…": "…" } ],
  "outgoing": [ { "id": "…", "status": "proposed", "my_role": "initiator", "…": "…" } ],
  "history": [ { "id": "…", "status": "completed", "…": "…" } ]
}
```

Un trade est rendu sous cette forme :

```json
{
  "id": "3f0f…",
  "status": "proposed",
  "rarity": 3,
  "sparks_cost": 9,
  "ender_eyes_cost": 3,
  "my_role": "initiator",
  "initiator": {
    "uuid": "…", "username": "Steve",
    "card": { "key": "SERIE-A1 / W001_classic", "card_id": "SERIE-A1 / W001",
              "style": "classic", "set": "A1", "rarity": 3,
              "name": "Creeper", "image": "assets/cards/…png" },
    "claimed": false
  },
  "responder": { "uuid": "…", "username": "Alex", "card": { "…": "…" }, "claimed": false },
  "created_at": "2026-11-20 12:00:00",
  "updated_at": "2026-11-20 12:04:11",
  "expires_at": "2026-11-21 12:00:00",
  "closed_at": null,
  "closed_by": null
}
```

`card` peut être `null` tant que B n'a rien proposé. `initiator.claimed` et
`responder.claimed` indiquent qui a déjà récupéré sa carte.

### `POST /trades` — créer une demande (A)

```json
{
  "uuid": "…", "auth_code": "…",
  "responder_uuid": "…",
  "rarity": 3,
  "card": { "key": "…", "card_id": "…", "style": "classic", "set": "A1",
            "rarity": 3, "name": "Creeper", "image": "assets/…" },
  "created_at": "2026-11-20T12:00:00.000Z"
}
```

`created_at` est **informatif** (`client_created_at`) : l'échéance est calculée
avec l'horloge du worker, jamais avec celle du client.

- `201` : `{ "trade": { … }, "ender_eyes": 2 }`
- `404` : le destinataire n'a pas publié sa carte
- `409` : demande déjà en cours, ou pas assez d'Œils de l'End

### `POST /trades/respond` — refuser ou contre-proposer (B)

```json
{ "uuid": "…", "auth_code": "…", "trade_id": "…", "action": "deny" }
```

```json
{ "uuid": "…", "auth_code": "…", "trade_id": "…", "action": "propose",
  "card": { "…": "…", "rarity": 3 } }
```

`deny` rembourse A. `propose` consomme les Œils de l'End de B et remplace une
éventuelle contre-proposition précédente (remboursée d'abord). La carte doit
avoir exactement la rareté du trade.

### `POST /trades/accept` — accepter la contre-proposition (A)

```json
{ "uuid": "…", "auth_code": "…", "trade_id": "…" }
```

Passe le trade en `accepted`. Aucun remboursement : les deux côtés gardent
leurs ressources engagées jusqu'à la récupération.

### `POST /trades/cancel` — annuler (A) ou retirer sa contre-proposition (B)

```json
{ "uuid": "…", "auth_code": "…", "trade_id": "…" }
```

- A sur `pending`/`proposed` → `cancelled`, remboursement des deux côtés.
- B sur `proposed` → retour à `pending`, remboursement de B uniquement.

### `POST /trades/claim` — récupérer la carte reçue

```json
{ "uuid": "…", "auth_code": "…", "trade_id": "…" }
```

Marque la récupération du joueur. Quand les **deux** ont récupéré, le trade
passe en `completed`. Répondre `completed` deux fois est sans effet.

## Statistiques (locales)

Le worker ne tient **aucune** statistique d'échanges : elles vivent dans la
sauvegarde du joueur (`user_state["trades"].stats`, voir `TradeManager`),
comme les tirages, les ventes ou les Sparks. Le client incrémente un compteur
la première fois qu'il observe une transition de statut :

| Compteur | Sens |
| --- | --- |
| `completed` | échanges conclus |
| `cancelled` | annulés par l'initiateur |
| `declined` | refusés par le destinataire |
| `expired` | expirés au bout de 24 h |
| `sparksSpent` | Sparks réellement dépensés (échanges conclus uniquement) |
| `enderEyesSpent` | Œils de l'End réellement dépensés |
| `cardsGiven` / `cardsReceived` | cartes données / reçues |

Un échange remboursé incrémente son compteur d'issue mais **pas**
`sparksSpent` : les Sparks sont revenus. Le détail est aussi conservé par
rareté (`byRarity`).

## Installation

```bash
npx wrangler d1 execute minecard-db --file=./sql/schema/trade-table.sql --remote
npx wrangler deploy
```

Le script est idempotent : le relancer ne détruit aucun échange en cours.

## Notes de conception

- **Pas de clé étrangère** vers `users` dans `trades` : un trade peut survivre à
  la republication d'une carte, et l'historique ne doit pas disparaître avec
  elle. L'authentification vérifie déjà l'existence de `users`.
- **Un seul index partiel** (`initiator_uuid` sur `pending`/`proposed`) garantit
  la règle « une demande à la fois » même en cas de requêtes concurrentes ; une
  insertion perdante rembourse immédiatement les Œils de l'End.
- **`accepted` n'expire pas** : la carte est déjà engagée et le trade n'attend
  plus qu'une récupération. L'expirer après qu'un joueur a récupéré sa carte
  créerait une duplication.
- **Aucune donnée de collection** n'est envoyée au worker en dehors du payload
  de la carte échangée : le reste du jeu continue de fonctionner hors ligne.
