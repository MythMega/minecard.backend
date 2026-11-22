# Likes

Un like par joueur et par jour UTC. Le joueur liké gagne `+1` au compteur `likes.like_count` et
`+0.1` à `bonus_from_like`. Le bonus est consommé **par entier** à la lecture authentifiée :
`4.8` devient `0.8` et la partie entière (`4`) est rendue au jeu comme autant de Sparks à créditer
(la balance reste locale, comme toutes les autres monnaies).

## Migration

```sh
npx wrangler d1 execute minecard-db --file=./sql/schema/05-likes.sql --remote
npx wrangler d1 execute minecard-db --file=./sql/schema/05-likes.sql --local
```

Le script est idempotent et ne dépend que de la table `users` de `01-create.sql`.

## Routes

| Route | Corp / params | Rôle |
| --- | --- | --- |
| `POST /likes/friend` | `{ uuid, auth_code, target_uuid }` | Donne le like du jour. `409` si déjà donné aujourd'hui, `404` si la cible n'a pas de compte en ligne. |
| `GET /likes?uuid=…` | — | Compteur public d'un joueur, **sans** toucher au bonus. |
| `GET /likes?uuids=a,b,c` | — | Compteurs de la Follow List, 100 UUID maximum : `{ "likes": { "<uuid>": 3 } }`. |
| `GET /likes?uuid=…&auth_code=…` | — | Lecture authentifiée : réclame la partie entière du bonus et renvoie `{ likes, bonus_from_like, sparks, liked_today }`. |

La contrainte « un like par jour » est tenue par la clé primaire `(liker_uuid, day)` de
`like_daily`, pas par le client : une seconde requête le même jour ne peut pas atteindre les
compteurs. La consommation du bonus est gardée par
`CAST(ROUND(bonus_from_like, 1) AS INTEGER) = earned`, donc deux lectures concurrentes ne peuvent
pas créditer deux fois les mêmes unités.

Côté jeu : `js/business/LikesManager.js` (lectures, like, crédit des Sparks via
`SparksManager.addSparks(..., SPARKS_SOURCES.LIKES)`), compteur du header dans `js/app.js`
(masqué si la lecture échoue ou si aucun compte en ligne n'existe) et likes affichés dans la
Follow List (`js/UI/views/SocialView.js`).
