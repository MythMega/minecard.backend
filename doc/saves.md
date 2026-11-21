# Sauvegarde en ligne

Le joueur envoie le fichier `.save` qu'il vient d'exporter, et n'importe quel autre
appareil peut le télécharger puis le charger dans le jeu. Les **5 dernières**
sauvegardes d'un compte sont conservées.

## Dépôt et déploiement

| Partie | Emplacement |
| --- | --- |
| Worker Cloudflare | `C:\Users\mythm\source\repos\minecard.backend` |
| Jeu (site statique) | `C:\Users\mythm\source\repos\mythmega.github.io\projets\minecards` |
| API déployée | `https://minecard-backend.jordanmorindev.workers.dev` |

```bash
cd C:\Users\mythm\source\repos\minecard.backend
npx wrangler d1 execute minecard-db --file=./sql/schema/04-save.sql --remote
npx wrangler deploy
```

## Table `saves`

`sql/schema/04-save.sql`. Une ligne par envoi :

| Colonne | Rôle |
| --- | --- |
| `id` | Clé primaire auto-incrémentée : c'est l'ordre d'arrivée (deux envois dans la même seconde restent ordonnés). |
| `uuid` | Propriétaire de la sauvegarde. Clé étrangère vers `users(uuid)`, `ON DELETE CASCADE`. |
| `save_blob` | Le fichier `.save` **tel quel** : le texte Base64 du flux `deflate` produit par `SaveFile`, sans transformation. |
| `byte_size` | Longueur du texte, pour auditer une ligne sans la décoder. |
| `created_at` | Horodatage **écrit par le serveur** (`datetime('now')`) : la date affichée par le jeu est celle de l'envoi, jamais celle de l'appareil. |

Index `idx_saves_uuid` sur `(uuid, id DESC)` : la lecture de la dernière
sauvegarde et l'élagage à 5 restent indexés.

## Authentification

`uuid` + `auth_code`, comme `POST /cards` et les échanges. **Toute écriture est
précédée de la vérification du code**, sans exception :

- compte connu : le code présenté doit être celui de `users`, sinon `403` et
  rien n'est écrit ;
- compte inconnu : la ligne `users` est créée avec le code de ce premier envoi
  (c'est ainsi qu'un compte qui n'a jamais publié sa carte de dresseur obtient
  son code). Une course entre deux appareils est relue puis comparée : un seul
  code peut s'imposer.

Les **lectures** sont privées aussi : la date et le fichier exigent le code, donc
un UUID seul ne révèle jamais la sauvegarde de quelqu'un.

La forme est validée avant la base : UUID v4, code de 16 caractères
`[A-Z0-9]`, sauvegarde non vide et ≤ **1 Mo** (`MAX_SAVE_BYTES = 1 000 000`).

D1 documente une limite de **2 000 000 octets par ligne**, et une ligne de `saves`
contient aussi `uuid`, `byte_size` et `created_at`. Un test réel a bien stocké
2 Mio (2 097 152 caractères), mais le jeu reste à la moitié de la limite
documentée : toute la ligne reste largement dans le plafond, quelle que soit la
valeur réellement appliquée par la plateforme. Un `.save` réel fait quelques
dizaines de Kio.

La constante du jeu (`SAVE_SYNC_MAX_BYTES` dans `SaveSyncManager.js`) et son
message d'erreur portent la même valeur : le client refuse avant d'envoyer, le
worker refuse avant d'écrire, et les deux disent « 1 Mo ».

## Routes

| Route | Corps / paramètres | Réponse |
| --- | --- | --- |
| `POST /saves` | `{ uuid, auth_code, save }` | `201 { saved_at, kept: 5 }` |
| `GET /saves/last?uuid=&auth_code=` | — | `200 { exists, saved_at }` |
| `GET /saves/last/file?uuid=&auth_code=` | — | `200 { exists, saved_at, save }` |

`exists: false` (et `saved_at: null`) répond `200` : l'absence de sauvegarde
n'est pas une erreur. Le contenu n'est **jamais** interprété par le worker : la
validation du `.save` est faite par le jeu (`SaveFile.validateSavePayload`),
avant toute écriture dans IndexedDB.

Codes d'erreur : `400` (champ invalide), `403` (code refusé), `404` (route),
`405` (méthode), `413` (au-delà de 1 Mo).

Côté jeu, toute requête refusée par le worker est aussi consignée dans
**Paramètres › Rapport d'erreurs** : le message du serveur, plus le détail de la
requête (`POST /saves → 413 · …`). La chaîne de requête n'y figure jamais, car
elle porte `auth_code`.

## Côté jeu

`js/business/SaveSyncManager.js` :

- `uploadCurrentSave()` → `SaveFile.createSaveFile()`, puis `POST /saves` ;
- `getLastSaveDate()` → `GET /saves/last` ;
- `downloadLastSave()` → `GET /saves/last/file`, `SaveFile.validateSavePayload()`,
  `SaveFile.writeStores()`, puis rechargement de la page.

Le code secret est celui de `user_state["social"].authCode` (le même que la carte
de dresseur) ; `SocialManager.ensureAuthCode()` le crée s'il n'existe pas encore.
