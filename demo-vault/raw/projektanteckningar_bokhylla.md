# bokhylla — projektanteckningar

Personligt sidoprojekt i Rust. Enkelt CLI för att hålla koll på läslista.

## Vad det gör

- Lägga till böcker med titel, författare, status (vill-läsa / läser / klar)
- Lista böcker, filtrera på status eller författare
- Skriva korta recensioner/anteckningar per bok
- Betygsätta (1–5)
- Exportera till enkel markdown

## Kommandon (nuläge)

```
bokhylla add "Titel" --author "Namn" --status reading
bokhylla list [--status done] [--sort title|author|rating|date]
bokhylla review <id> --text "..." --rating 4
bokhylla done <id>
bokhylla export > laslogg.md
```

## Datalagring

JSON-fil i `~/.local/share/bokhylla/books.json`. Enkel, portabel, läsbar. Ingen databas.

Struct:
```rust
struct Book {
    id: Uuid,
    title: String,
    author: String,
    status: Status,
    rating: Option<u8>,
    notes: Option<String>,
    added: DateTime<Utc>,
    finished: Option<DateTime<Utc>>,
}
```

## Utmaningar / lärdomar

**Felhantering:** Fastnade länge på hur man propagerar fel snyggt. Löste med `thiserror`-crate — definierar egna feltyper med `#[derive(Error)]`. Mycket snyggare än att matcha `std::io::Error` överallt.

**Sortering:** `list --sort` tog längre tid än väntat. Vill kunna sortera på flera fält. Lösning: `--sort`-flaggan tar en nyckel, implementerat med `Ord` på en enum. Framtida tanke: kombinera sorteringsnycklar.

**serde_json + Option:** `None`-fält serialiseras som `null` by default. Vill skippa dem. Löst med `#[serde(skip_serializing_if = "Option::is_none")]`. Lärde mig mer om serde-attribut än jag tänkt.

## Nästa steg

- [ ] Stöd för taggar
- [ ] `search`-kommando (freetext i titlar/anteckningar)
- [ ] Bättre felmeddelanden för felformaterad JSON-fil
- [ ] Tester (skäms lite)
