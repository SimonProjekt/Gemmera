# Personlig kunskapsbas - Gemmera

**DD1349 VT26 — Projektuppgift i introduktion till datalogi**

Ett Obsidian-plugin som förvandlar din vault till en lokal, privat kunskapsbas driven av Googles Gemma-modell. Användaren chattar med Gemma direkt i Obsidian, och modellen skapar och uppdaterar sammanlänkade wiki-sidor med `[[wikilinks]]` åt användaren — allt utan att data lämnar datorn.

## MVP

Ett Obsidian-plugin som lägger till en chattpanel i sidofältet. Gemma kör lokalt via Ollama och har verktyg för att skapa, läsa och uppdatera filer i vaulten.

Kärnfunktioner:

- **Chatt-gränssnitt** — användaren pratar med Gemma i en panel inne i Obsidian.
- **Filskapande via chat** — Gemma kan skapa nya markdown-filer med `[[wikilinks]]` baserat på konversationen (t.ex. "gör en anteckning om det vi just diskuterade").
- **Uppdatering av befintliga sidor** — Gemma kan läsa och lägga till innehåll i existerande filer, med preview innan ändring skrivs.
- **Sökning i vaulten** — Gemma kan slå upp innehåll i vaultens filer för att svara med citat till källor.

Fejkpersonen "Jonas Berg" (dagböcker, brev, bokrecensioner) medföljer som demo-vault så allt fungerar direkt efter installation.

## Säkerhetsprinciper

- Preview-innan-skriv som default för alla filändringar.
- Append-only uppdateringar av existerande sidor.
- Radering kräver explicit bekräftelse i UI.
- Lokalt via Ollama. Inget cloud-API-fallback.
- MIT-licens.

## Teknisk stack

TypeScript, Obsidian Plugin API, Svelte för chat-UI, Gemma via Ollama lokalt, Markdown med Obsidian-kompatibla wikilinks, Claude API för engångsgenerering av demo-persona.

## Tidsplan — 4 veckor

- **Vecka 1 (grund):** Repo-setup, plugin-skelett, Ollama-integration, enkel chat-panel, persona-generering.
- **Vecka 2 (full MVP):** Verktyg för filskapande, läsning och uppdatering. Preview-dialog. Tester på Jonas-vaulten.
- **Vecka 3 (utökning):** Ett av röstinmatning / vault-sökning med citat / inkrementell indexering. Val efter v2-retro.
- **Vecka 4 (polering):** Utvärdering mot 20 testfrågor, installationsguide, demo-förberedelse.

**Slutacceptans:** en ny person installerar pluginet, följer README, och har en fungerande chatt som kan skapa filer i sin vault inom 20 min på en typisk 8 GB-bärbar.

## Utvärdering

20 förberedda frågor/uppgifter om Jonas med kända svar. Mätvärden: svarsandel, citat-korrekthet, kvalitet på skapade filer och wikilinks, körtid (P50/P95) för svar och filskapande.

## Team

Par-projekt. Person A: Ollama-integration och LLM-prompting/verktygsanrop. Person B: Obsidian-plugin-UI, chat-panel, persona-generering. Båda deltar i planering varje vecka; review-rollen roterar.

Se [projektbeskrivning.md](projektbeskrivning.md) för fullständig specifikation.
