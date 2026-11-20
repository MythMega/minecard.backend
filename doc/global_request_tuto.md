```markdown
# Documentation API — Minecard Backend (Front-end)

Base URL : `https://minecard-backend.jordanmorindev.workers.dev`

Aucune clé API ou header d'authentification global n'est requis côté client.
L'authentification d'écriture repose uniquement sur le couple `uuid` + `auth_code`.

---

## Règles importantes côté client

1. **`auth_code` secret local** :
   - Générer un code aléatoire côté client (16 caractères alphanumériques pour MineCards) lors de la création du profil local et le stocker en local (`localStorage`, fichier de config, etc.).
   - L'envoyer uniquement lors de la sauvegarde/mise à jour de sa propre carte (`POST` / `PUT` `/cards`).
   - **Ne jamais le journaliser** et **ne pas s'attendre à le recevoir** dans les réponses de l'API (il n'est jamais renvoyé). L'application peut l'afficher dans ses paramètres pour permettre à l'utilisateur de le conserver.
2. **Types des données** :
   - Tous les identifiants (`uuid`, `*_id`), `auth_code`, `username` et `date_first_card` sont des `string` non vides.
   - Les statistiques (`open_booster`, `different_cards`, `level`, `block_mined`, `picks`, `points`) sont des `number` entiers `>= 0`.
   - `card_rarity` est un entier de `1` (Commune) à `6` (Unique).
   - La présentation de la carte est répartie dans des champs explicites : `card_layout` (`classic` ou `fullart`), `profile_icon_size` (`tiny`, `verySmall`, `small`, `normal`, `large`, `veryLarge`, `huge`), `profile_icon_align` (`top`, `left`, `center`, `right`, `bottom`), `profile_icon_shape` (`normal`, `round`) et `title_color_id` (identifiant de couleur ou `auto`).
3. **CORS** : activé (`Access-Control-Allow-Origin: *`, méthodes `GET, POST, PUT, OPTIONS`, header `Content-Type`).

---

## 1. Créer ou mettre à jour sa carte

- **Méthode** : `POST` ou `PUT`
- **URL** : `https://minecard-backend.jordanmorindev.workers.dev/cards`
- **Headers** :
  ```http
  Content-Type: application/json

```

* **Comportement** :
* Si `uuid` n'existe pas encore : crée l'utilisateur avec son `auth_code` et insère la carte (`201 Created`).
* Si `uuid` existe déjà : vérifie `auth_code`. Si valide, met à jour la carte (`200 OK`). Si invalide, renvoie `403 Forbidden`.



### JSON envoyé (Body)

```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "auth_code": "A1B2C3D4E5F6G7H8",
  "username": "StevePro",
  "background_card_id": "bg_nether_01",
  "profile_picture_id": "pfp_alex_smile",
  "title_id": "title_miner",
  "card_color_id": "color_emerald",
  "username_color_id": "ucolor_gold",
  "location_id": "loc_overworld",
  "card_layout": "classic",
  "profile_icon_size": "normal",
  "profile_icon_align": "center",
  "profile_icon_shape": "normal",
  "card_rarity": 3,
  "title_color_id": "auto",
  "open_booster": 12,
  "different_cards": 48,
  "date_first_card": "2026-05-10",
  "level": 15,
  "block_mined": 3420,
  "picks": 9,
  "points": 1850
}

```

### JSON reçu — Succès (`201 Created` ou `200 OK`)

`auth_code` est absent de `card`.

```json
{
  "action": "created",
  "card": {
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "username": "StevePro",
    "background_card_id": "bg_nether_01",
    "profile_picture_id": "pfp_alex_smile",
    "title_id": "title_miner",
    "card_color_id": "color_emerald",
    "username_color_id": "ucolor_gold",
    "location_id": "loc_overworld",
    "card_layout": "classic",
    "profile_icon_size": "normal",
    "profile_icon_align": "center",
    "profile_icon_shape": "normal",
    "card_rarity": 3,
    "title_color_id": "auto",
    "open_booster": 12,
    "different_cards": 48,
    "date_first_card": "2026-05-10",
    "level": 15,
    "block_mined": 3420,
    "picks": 9,
    "points": 1850,
    "updated_at": "2026-11-20 12:00:00"
  }
}

```

*(Note : `action` vaut `"created"` au `201` et `"updated"` au `200`.)*

---

## 2. Récupérer les cartes d'une liste d'UUIDs (GET)

* **Méthode** : `GET`
* **URL** : `https://minecard-backend.jordanmorindev.workers.dev/cards?uuids=uuid1,uuid2,uuid3`
* **Notes** :
* Les doublons et espaces sont nettoyés côté serveur.
* Limite à **100 UUIDs** maximum par requête.
* Les UUIDs inconnus sont simplement ignorés (pas d'erreur `404` globale).



### JSON reçu (`200 OK`)

```json
{
  "cards": [
    {
      "uuid": "550e8400-e29b-41d4-a716-446655440000",
      "username": "StevePro",
      "background_card_id": "bg_nether_01",
      "profile_picture_id": "pfp_alex_smile",
      "title_id": "title_miner",
      "card_color_id": "color_emerald",
      "username_color_id": "ucolor_gold",
      "location_id": "loc_overworld",
      "card_layout": "classic",
      "profile_icon_size": "normal",
      "profile_icon_align": "center",
      "profile_icon_shape": "normal",
      "card_rarity": 3,
      "title_color_id": "auto",
      "open_booster": 12,
      "different_cards": 48,
      "date_first_card": "2026-05-10",
      "level": 15,
      "block_mined": 3420,
      "picks": 9,
      "points": 1850,
      "updated_at": "2026-11-20 12:00:00"
    }
  ]
}

```

---

## 3. Récupérer les cartes d'une liste d'UUIDs en batch (POST)

Pratique si la liste d'UUIDs est longue (évite les limites de longueur d'URL).

* **Méthode** : `POST`
* **URL** : `https://minecard-backend.jordanmorindev.workers.dev/cards/batch`
* **Headers** :
```http
Content-Type: application/json

```



### JSON envoyé (Body)

```json
{
  "uuids": [
    "550e8400-e29b-41d4-a716-446655440000",
    "660e8400-e29b-41d4-a716-446655440001"
  ]
}

```

### JSON reçu (`200 OK`)

Même structure que le `GET /cards` :

```json
{
  "cards": [
    {
      "uuid": "550e8400-e29b-41d4-a716-446655440000",
      "username": "StevePro",
      "background_card_id": "bg_nether_01",
      "profile_picture_id": "pfp_alex_smile",
      "title_id": "title_miner",
      "card_color_id": "color_emerald",
      "username_color_id": "ucolor_gold",
      "location_id": "loc_overworld",
      "card_layout": "classic",
      "profile_icon_size": "normal",
      "profile_icon_align": "center",
      "profile_icon_shape": "normal",
      "card_rarity": 3,
      "title_color_id": "auto",
      "open_booster": 12,
      "different_cards": 48,
      "date_first_card": "2026-05-10",
      "level": 15,
      "block_mined": 3420,
      "picks": 9,
      "points": 1850,
      "updated_at": "2026-11-20 12:00:00"
    }
  ]
}

```

---

## 4. Codes d'erreur possibles

Toutes les erreurs retournent un JSON de la forme :

```json
{
  "error": "Message explicatif"
}

```

| Code HTTP | Signification | Cas fréquent |
| --- | --- | --- |
| `400` | Bad Request | JSON mal formé, champ manquant/vide, mauvais type (`string` vs `number` entier `>= 0`), ou `uuids` absent/invalide sur `/cards/batch` |
| `403` | Forbidden | L'`uuid` existe déjà en base mais `auth_code` ne correspond pas |
| `404` | Not Found | Route inexistante |
| `500` | Internal Server Error | Erreur inattendue côté Worker ou base D1 |

```

```