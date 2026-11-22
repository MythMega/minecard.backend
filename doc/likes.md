# Likes

Un like par **ami** et par jour UTC (un joueur peut donc liker toute sa Follow List, une fois
chacun). Le joueur liké gagne `+1` au compteur `likes.like_count` et
`+0.1` à `bonus_from_like`. Le bonus est consommé **par entier** à la lecture authentifiée :
`4.8` devient `0.8` et la partie entière (`4`) est rendue au jeu comme autant de Sparks à créditer
(la balance reste locale, comme toutes les autres monnaies).

## Migration

```sh
npx wrangler d1 execute minecard-db --file=./sql/schema/05-likes.sql --remote
npx wrangler d1 execute minecard-db --file=./sql/schema/05-likes.sql --local
npx wrangler d1 execute minecard-db --file=./sql/schema/07-like-everyone.sql --remote
npx wrangler d1 execute minecard-db --file=./sql/schema/07-like-everyone.sql --local
```

Les scripts sont idempotents et ne dépendent que de la table `users` de `01-create.sql`.
`07-like-everyone.sql` crée `like_daily_target` (un like par ami et par jour) et y recopie
l'historique de `like_daily`, qui reste en place mais n'est plus écrit.

## Routes

| Route | Corp / params | Rôle |
| --- | --- | --- |
| `POST /likes/friend` | `{ uuid, auth_code, target_uuid }` | Donne le like du jour à un ami. `409` s'il l'a déjà reçu aujourd'hui, `404` si la cible n'a pas de compte en ligne. |
| `POST /likes/batch` | `{ uuid, auth_code, target_uuids: [...] }` | Donne le like du jour à toute une liste (100 max) en une requête : `{ liked, already, unknown, likes, likes_sent }`. Les comptes inconnus et soi-même sont ignorés, pas rejetés. |
| `GET /likes?uuid=…` | — | Compteur public d'un joueur, **sans** toucher au bonus. |
| `GET /likes?uuids=a,b,c` | — | Compteurs de la Follow List, 100 UUID maximum : `{ "likes": { "<uuid>": 3 } }`. |
| `GET /likes?uuid=…&auth_code=…` | — | Lecture authentifiée : réclame la partie entière du bonus et renvoie `{ likes, bonus_from_like, sparks, likes_sent, liked_targets_today }`. |

La contrainte « un like par ami et par jour » est tenue par la clé primaire
`(liker_uuid, target_uuid, day)` de `like_daily_target`, pas par le client : une seconde requête le
même jour pour le même ami ne peut pas atteindre les compteurs. `likes_sent` (nombre total de likes
envoyés) et `liked_targets_today` sont calculés par la même lecture authentifiée, ce qui alimente le
trophée `likessent` et les boutons de la Follow List sans requête supplémentaire. La consommation du bonus est gardée par
`CAST(ROUND(bonus_from_like, 1) AS INTEGER) = earned`, donc deux lectures concurrentes ne peuvent
pas créditer deux fois les mêmes unités.

Côté jeu : `js/business/LikesManager.js` (lectures, like, crédit des Sparks via
`SparksManager.addSparks(..., SPARKS_SOURCES.LIKES)`), compteur du header dans `js/app.js`
(masqué si la lecture échoue ou si aucun compte en ligne n'existe) et likes affichés dans la
Follow List (`js/UI/views/SocialView.js`).
