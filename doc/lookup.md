# `GET /lookup` - retrouver un joueur par son pseudo ou son UUID

Le pseudo d'une carte de dresseur est **unique** en base (`sql/schema/10-username-unique.sql`,
index `idx_cards_username_unique`, insensible à la casse). Il désigne donc un compte à lui seul et
peut remplacer l'UUID partout où le jeu demandait un identifiant : ajouter un ami, charger une
sauvegarde en ligne. Cette route est la seule traduction pseudo → UUID.

## Requête

```
GET /lookup?query=<pseudo|uuid>
```

Le **format du champ** décide de la lecture, le joueur n'a jamais à préciser ce qu'il a tapé :

- une valeur au format UUID v4 est lue comme un UUID (comparaison exacte, minuscules) ;
- tout le reste est lu comme un pseudo, avec `COLLATE NOCASE` (`steve` trouve `Steve`, la même
  règle que l'index unique).

Contraintes : `query` obligatoire, 24 caractères au plus pour un pseudo (la longueur maximale d'un
nom de profil dans le jeu), 36 pour un UUID.

## Réponses

| Statut | Corps |
| --- | --- |
| `200` | `{ "found": true, "uuid": "…", "username": "Steve" }` |
| `200` | `{ "found": false }` (pseudo libre, ou compte sans carte publiée) |
| `400` | `{ "error": "…" }` quand `query` est vide ou trop long |
| `405` | `{ "error": "Méthode non autorisée." }` pour toute méthode autre que `GET` |

`found: false` est une **réponse normale**, pas une erreur : le jeu affiche son propre message
(« Aucun joueur ne porte ce pseudo »), dans sa langue.

## Ce que la route ne fait pas

- Elle ne lit que `cards` : un pseudo n'existe qu'une fois la carte de dresseur publiée. Un compte
  qui n'a fait qu'envoyer une sauvegarde reste joignable par son UUID, jamais par un pseudo.
- Elle n'autorise rien. Le pseudo et la carte qu'il désigne sont publics, comme `GET /cards` ; une
  sauvegarde en ligne demande toujours la paire `uuid` + `auth_code`.
- Elle ne renvoie jamais le code secret.

## Clients

- Jeu : `SocialManager.resolvePlayerIdentifier()` (amis) et `SaveSyncManager.resolveCredentials()`
  (récupération d'une sauvegarde en ligne à l'onboarding).
- Pages d'administration : `admin/save-sync.js` (`resolveSaveIdentifier`), utilisée par
  `admin/save-editor.html` et `admin/openings.html`.
