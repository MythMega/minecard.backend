option 1

```ts
async function fetchCardsByUuids(uuids: string[]) {
  const query = encodeURIComponent(uuids.join(","));
  const res = await fetch(`${BASE_URL}/cards?uuids=${query}`);

  if (!res.ok) {
    throw new Error(`Erreur HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.cards; // Tableau des cartes trouvées (sans auth_code)
}
```

option 2

```ts
async function fetchCardsBatch(uuids: string[]) {
  const res = await fetch(`${BASE_URL}/cards/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uuids }),
  });

  if (!res.ok) {
    throw new Error(`Erreur HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.cards;
}
```