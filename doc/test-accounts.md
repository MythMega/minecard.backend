# Comptes de test : la règle du marqueur `TESTUSERBDD`

Tout compte de test créé pour MineCards **doit contenir `TESTUSERBDD` dans son pseudo** :

```
TESTUSERBDD_like1
testuserbdd-tradeA
monTESTUSERBDD
```

La règle existe pour une seule raison : pouvoir supprimer d'un coup tout ce qu'on a fabriqué en
testant, sans jamais toucher aux vrais joueurs. Un script de nettoyage ciblé s'appuie sur ce
marqueur.

## Côté jeu (minecard)

Quand un joueur enregistre un pseudo qui contient `TESTUSERBDD` (casse ignorée), la boîte de dialogue
« Modifier le pseudo » affiche un avertissement et **n'enregistre rien** tant qu'on n'a pas cliqué
sur « Oui, je suis un compte de test » (`ProfileView.handleNameSubmit`). Modifier le champ retire
l'avertissement : il faut le relire avant de confirmer à nouveau.

C'est volontairement un avertissement, pas un refus : on veut pouvoir se créer des comptes de test
jetables en deux clics, tout en empêchant un vrai joueur de choisir ce texte par accident.

## Côté worker (minecard.backend)

Le marqueur n'est **jamais** vérifié par le worker : il ne lit que le pseudo publié. La suppression
est un script SQL lancé à la main (aucun point d'entrée HTTP, aucun raccourci npm) :

```bash
# Tout ce qui contient TESTUSERBDD dans le pseudo, avec ses données liées.
npx wrangler d1 execute minecard-db --file=./sql/schema/admin/clean_testuserbdd_accounts.sql --remote
```

Ce que le script supprime, pour chaque compte visé : `like_daily_target` (des deux côtés),
`likes`, `favorite`, `wishlist`, `saves`, `trades`, `cards`, puis `users`. Il affiche avant les `DELETE` le
nombre de lignes visées, table par table, et il est idempotent (le relancer ne fait rien).

Il **conserve** la ligne `likes` d'un vrai joueur qui aurait reçu un like d'un compte de test : ce
compteur est réel.

Deux scripts voisins existent pour les données plus anciennes :

| Script | Cible |
| --- | --- |
| `sql/schema/admin/clean_testuserbdd_accounts.sql` | pseudos contenant `TESTUSERBDD` (la règle actuelle) |
| `sql/schema/admin/clean_test_accounts.sql` | pseudos commençant par `E2E ` ou `TEST ` (comptes créés avant la règle) |
| `sql/schema/admin/clear_all_datas.sql` | toute la base (à ne jamais lancer sur la production) |

## Non rétroactif

La règle s'applique à partir de maintenant : les comptes de test existants qui ne contiennent pas le
marqueur ne sont pas visés par le nouveau script. Deux façons de les traiter :

- renommer leur pseudo pour y ajouter `TESTUSERBDD`, puis lancer le script ;
- les supprimer avec `clean_test_accounts.sql` si leur pseudo commence par `E2E ` ou `TEST `.

Un compte de test qui n'a **jamais publié sa carte de dresseur** n'a pas de pseudo en base : le
script ne peut pas le trouver. Ajoute son UUID à la main dans l'`INSERT` de la table de travail du
script (ou publie sa carte, ce qui enregistre le pseudo).

## Vérification

`test/live/worker.live.mjs` crée ses comptes avec le préfixe `E2E` (option `--prefix=`) ; pour les
nommer selon la règle actuelle :

```bash
node test/live/worker.live.mjs --url=http://127.0.0.1:8787 --prefix=TESTUSERBDD
```
