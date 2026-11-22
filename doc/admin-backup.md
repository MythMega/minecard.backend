# Administration : sauvegarde et restauration de la base

Deux routes réservées à l'administrateur, dans `src/adminService.ts` :

| Route | Méthode | Rôle |
| --- | --- | --- |
| `/admin/backup` | `GET` | Télécharge **toute** la base en un fichier `.json.gz` |
| `/admin/restore` | `POST` | Réécrit **toute** la base à partir de ce fichier |

Les deux exigent la clé d'administration dans l'en-tête `x-admin-key` (jamais dans l'URL : une
query string finit dans les logs). La clé vient **exclusivement du secret Cloudflare `adminkey`** :
`wrangler.toml` ne contient aucune valeur.

```bash
npx wrangler secret put adminkey    # saisit la valeur, une fois
npx wrangler secret list            # confirme son existence (la valeur n'est jamais affichée)
```

Le secret est conservé à chaque `npx wrangler deploy` et disponible dans le worker sous
`env.adminkey`. Pour la changer : relancer `secret put`, aucun redéploiement n'est nécessaire.

En local, `wrangler dev` lit `adminkey` depuis `.dev.vars` (créé à la racine, ignoré par Git) :

```
adminkey="root"
```

Sans secret ni `.dev.vars`, les routes répondent `503` ; sans en-tête, `401` ; mauvaise clé, `403`.

## Télécharger une sauvegarde

```bash
curl -H "x-admin-key: $ADMIN_KEY" \
  -o minecard-backup.json.gz \
  https://minecard-backend.jordanmorindev.workers.dev/admin/backup
```

Le fichier contient les sept tables (`users`, `likes`, `cards`, `trades`, `saves`, `favorite`,
`like_daily_target`), colonnes et lignes comprises, plus un horodatage `exported_at`. Les compteurs
de likes, le bonus en attente et les likes déjà donnés aujourd'hui voyagent donc avec la sauvegarde.

## Restaurer (tout réécrire)

```bash
curl -X POST -H "x-admin-key: $ADMIN_KEY" \
  -H "Content-Type: application/gzip" \
  --data-binary @minecard-backup.json.gz \
  https://minecard-backend.jordanmorindev.workers.dev/admin/restore
```

Réponse :

```json
{
  "restored": true,
  "exported_at": "2026-11-21T12:00:00.000Z",
  "tables": { "users": 42, "likes": 30, "cards": 40, "trades": 7, "saves": 118, "favorite": 12, "like_daily_target": 64 },
  "rows": 313,
  "duration_ms": 340,
  "safety_backup": "H4sIAAAA…",
  "safety_backup_bytes": 4821
}
```

`safety_backup` est l'état de la base **juste avant** la réécriture, gzippé puis Base64 : si une
restauration est interrompue, il suffit de décoder ce champ et de le renvoyer sur `/admin/restore`.
Il vaut `null` au-delà de 4 Mo compressés : dans ce cas, faites un `GET /admin/backup` avant.

Le corps peut être le `.json.gz` ou le JSON brut (le worker reconnaît le gzip à ses deux premiers
octets), 10 Mo maximum, 50 Mo une fois décompressé.

## Ce que fait la restauration

1. **Validation complète avant la première écriture.** Le marqueur `format`, la `version`, les
   sept tables, chaque colonne (comparée au schéma réel via `PRAGMA table_info`) et la largeur
   de chaque ligne sont vérifiés. Un fichier douteux répond `400` sans rien modifier.
2. **Instantané** de l'état courant, renvoyé dans `safety_backup` (voir ci-dessus).
3. **Vidage** des sept tables en un seul `batch()` atomique, enfants d'abord
   (`like_daily_target`, `favorite`, `saves`, `trades`, `cards`, `likes`, `users`).
4. **Insertion** des lignes par lots de 40 (`batch()` atomique par lot), `users` avant ses enfants
   à cause des clés étrangères.

Un échec au milieu laisse les lots déjà passés en place : renvoyez le même fichier, la
restauration commence par vider les tables — ou renvoyez `safety_backup` pour revenir à l'état
d'avant.

Une ancienne sauvegarde, écrite avant que `favorite`, `likes` et `like_daily_target` soient
exportées, reste acceptée : ces tables sont alors vidées et laissées vides, comme tout fichier
restauré.

## Pourquoi pas un `.sqlite` ?

Un Worker n'embarque aucun moteur SQLite : il ne peut que lancer du SQL sur D1, pas fabriquer le
format de fichier d'une base. Il n'y a donc pas de `.sqlite` généré côté Worker.

Pour un vrai fichier SQLite, à faire depuis votre machine (sur un export obtenu avec
`wrangler d1 export`, qui sort du SQL) :

```bash
npx wrangler d1 export minecard-db --remote --output=backup.sql
sqlite3 minecard.sqlite < backup.sql
```

Le `.json.gz` de `/admin/backup` est la version « depuis n'importe où » : plus compacte (gzip sur
du texte déjà Base64), restaurable par un simple `curl`, et sans dépendre de l'installation locale
de Wrangler.

## Notes

- L'API d'administration n'envoie **aucun en-tête CORS** : elle s'utilise en ligne de commande, pas
depuis une page web. Une sauvegarde contient les `auth_code` de tous les comptes ;
`Access-Control-Allow-Origin: *` aurait laissé n'importe quel site lire cette réponse.
- Le fichier contient les `auth_code` des joueurs et leurs sauvegardes : gardez-le privé.
- `saves.id` est exporté et réinséré tel quel, donc l'ordre des sauvegardes d'un compte est
  conservé.
- Une colonne ajoutée plus tard par un script de schéma suit automatiquement : l'export et
  l'import lisent la liste des colonnes à l'exécution.
