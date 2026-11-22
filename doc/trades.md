# Échanges (trades) — API, schéma et cycle de vie

Deux joueurs échangent **une carte de même rareté**. Le worker est la source de
vérité du **cycle de vie** d'un échange ; la collection, les Sparks, le stock
d'**Œil de l'End** et les statistiques restent locaux au navigateur.

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
| Stock d'Œil de l'End | 5 maximum, +1 par jour UTC, **stocké localement** |
| Demandes ouvertes simultanées | 1 par initiateur (`pending` + `proposed`) |
| Délai | 24 h avant expiration automatique, remboursement des deux côtés |
| Cartes proposées | uniquement des doublons (vérifié côté client) |
| Statistiques | **locales** (`user_state["trades"].stats`), jamais en base |

Le coût est identique pour les deux joueurs : chacun paie
`rareté` Œils de l'End et `rareté²` Sparks pour la carte qu'il met dans
l'échange. Aucune des deux cartes ne peut être « plus chère » que l'autre,
puisque la rareté est la même.

## Authentification

Chaque requête porte `uuid` + `auth_code`, exactement comme `POST /cards` :
`/trades` en paramètres de requête, les `POST` dans le corps JSON. Aucune route
n'accepte une requête sans les deux champs : le worker répond `403` avant toute
lecture d'échange.

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
| `cancelled` | A a annulé, ou un joueur a refusé la carte reçue (remboursement des deux) |
| `expired` | 24 h écoulées avant acceptation (remboursement des deux) |

Un retrait de contre-proposition par B (`cancel` sur un trade `proposed`) ne
crée pas un statut à part : le trade revient à `pending` et B récupère sa
carte et ses Œils de l'End.

## Courses de statut

Une action peut arriver après que l'autre joueur a déjà fait évoluer l'échange.
Chaque transition est gardée par un `WHERE … AND status IN (…)` : elle répond
`409` quand elle n'est plus possible, sans rien modifier.

| Action tardive | Réponse |
| --- | --- |
| `accept` après un retrait de B | `409`, le trade reste `pending` |
| `claim` sur un échange refusé, annulé ou expiré | `409`, « échange clos » |
| `respond` après une annulation | `409` |
| `cancel` / `claim` après acceptation puis récupération | `409` ou `200` inchangé |
| deuxième refus, deuxième contre-proposition | `409` |

Le client traduit `409` en `trade.error.conflict` et `404` en
`trade.error.notFound`, ferme le dialogue fautif et recharge la liste. L'escrow
local (carte, Sparks, Œils) n'est remboursé qu'à la réconciliation avec le
nouveau statut : une action refusée ne rembourse donc rien, et une fermeture ne
rembourse jamais deux fois.

## Remboursements

Le worker ne stocke ni carte, ni Sparks, ni Œils de l'End : il ne fait que
renvoyer le statut. Le client tient un registre local de ce qui est mis en jeu
(`user_state["trades"].escrows` : carte, Sparks et Œils) et le rend lui-même
quand il voit un statut clos (`declined`, `cancelled`, `expired`) ou une
contre-proposition retirée. Ce registre est la raison pour laquelle un
remboursement ne peut pas être appliqué deux fois, même après un rechargement.

## Routes

Toutes les réponses sont du JSON. Les erreurs suivent le format existant
`{ "error": "message" }`.

### `GET /trades?uuid=…&auth_code=…`

Liste les échanges du joueur et **expire d'abord** ceux qui sont ouverts depuis
plus de 24 h. Aucun solde n'est renvoyé : les Œils de l'End sont locaux.

```json
{
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
              "style": "classic", "set": "A1", "rarity": 3, "name": "Creeper" },
    "claimed": false
  },
  "responder": { "uuid": "…", "username": "Alex", "card": { "…": "…" }, "claimed": false },
  "created_at": "2026-11-20 12:00:00"
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
            "rarity": 3, "name": "Creeper" }
}
```

La date d'initiation est écrite par l'horloge du **worker** (`created_at`) et
l'échéance en découle : une horloge client faussée ne peut ni allonger ni
raccourcir le délai de 24 h. Aucun chemin d'illustration n'est envoyé : le
receveur résout l'image depuis son propre catalogue avec `card.key`.

- `201` : `{ "trade": { … } }`
- `404` : le destinataire n'a pas publié sa carte
- `409` : demande déjà en cours (le solde d'Œils est vérifié par le client)

### `POST /trades/respond` — refuser ou contre-proposer (B)

```json
{ "uuid": "…", "auth_code": "…", "trade_id": "…", "action": "deny" }
```

```json
{ "uuid": "…", "auth_code": "…", "trade_id": "…", "action": "propose",
  "card": { "…": "…", "rarity": 3 } }
```

`deny` clôt le trade, et le client rembourse A depuis son escrow. `propose`
remplace une éventuelle contre-proposition précédente ; le client rend l'ancien
escrow et en enregistre un nouveau. La carte doit avoir exactement la rareté du
trade.

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

- A sur `pending`/`proposed` → `cancelled` ; le client rembourse les deux côtés.
- B sur `proposed` → retour à `pending` ; le client rembourse B uniquement.

### `POST /trades/refuse` — refuser une carte reçue et clore pour les deux

```json
{ "uuid": "…", "auth_code": "…", "trade_id": "…" }
```

Appelée par le joueur qui découvre que la carte reçue n'est pas échangeable
(promo, extension fermée) : le worker ne peut pas en juger, seule la
configuration du jeu le sait. Le trade passe en `cancelled` pour **les deux**
joueurs, qui remboursent alors chacun leur escrow au rafraîchissement suivant.
C'est ce qui remplace l'annulation impossible d'un trade déjà `accepted`.

Refusée (`409`) dès qu'une des deux cartes a été récupérée : le trade serait
clos alors que l'un a déjà la carte de l'autre, et le remboursement la
dupliquerait.

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
  la règle « une demande à la fois » même en cas de requêtes concurrentes :
  l'insertion perdante répond `409` et le client rembourse son escrow.
- **Aucune table de monnaie** : le stock d'Œils de l'End vit dans la sauvegarde
  (`user_state["trades"]`, avec le jour UTC du dernier rafraîchissement). Une
  requête d'échange ne fait donc qu'une lecture d'authentification, au lieu de
  lire, remettre à niveau puis dépenser une ligne de monnaie.
- **`accepted` n'expire pas** : la carte est déjà engagée et le trade n'attend
  plus qu'une récupération. L'expirer après qu'un joueur a récupéré sa carte
  créerait une duplication.
- **Aucune donnée de collection** n'est envoyée au worker en dehors du payload
  de la carte échangée : le reste du jeu continue de fonctionner hors ligne.
