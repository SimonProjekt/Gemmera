# Personlig kunskapsbas - Gemmera

**DD1349 VT26 — Projektuppgift i introduktion till datalogi**

Ett Obsidian-plugin som förvandlar din vault till en lokal, privat kunskapsbas driven av Googles Gemma-modell. Användaren chattar med Gemma direkt i Obsidian, och modellen skapar och uppdaterar sammanlänkade wiki-sidor med `[[wikilinks]]` åt användaren — allt utan att data lämnar datorn.

## MVP

Ett Obsidian-plugin som lägger till en chattpanel i sidofältet. Gemma kör lokalt via Ollama med token-för-token strömning och bibehåller konversationshistorik mellan sessioner.

Kärnfunktioner:

- **Chatt-gränssnitt** — användaren pratar med Gemma i en panel inne i Obsidian.
- **Filskapande via chat** — Gemma kan skapa nya markdown-filer med `[[wikilinks]]` baserat på konversationen (t.ex. "gör en anteckning om det vi just diskuterade").
- **Uppdatering av befintliga sidor** — Gemma kan läsa och lägga till innehåll i existerande filer, med preview innan ändring skrivs.
- **Sökning i vaulten** — Gemma kan slå upp innehåll i vaultens filer för att svara med citat till källor.

Fejkpersonen "Jonas Berg" (dagböcker, brev och bokrecensioner på svenska) medföljer som demo-vault så allt fungerar direkt efter installation.

## Distribution

Planen är att publicera Gemmera på GitHub under MIT-licens. README:n kommer att innehålla en installations-checklista och en lista över beroenden. Exakt innehåll fastställs senare i projektet — nedan är ett **exempel** på hur det skulle kunna se ut.

*Exempel på installations-checklista:*

- **Klona repo** — t.ex. `git clone` av Gemmera-repot till valfri plats.
- **Installera beroenden** — t.ex. `npm install` i projektmappen.
- **Bygg plugin** — t.ex. `npm run build` för att generera `main.js`.
- **Kopiera till vault** — t.ex. lägg `main.js`, `manifest.json` och `styles.css` i `<vault>/.obsidian/plugins/gemmera/`.
- **Aktivera** — t.ex. slå på Gemmera under Obsidians inställningar → Community plugins.

*Exempel på beroenden:*

- **Obsidian** (t.ex. ≥ 1.5)
- **Node.js** och **npm** — för bygget.
- **Ollama** — lokalt installerad och igång.
- **Gemma-modell** — hämtas via Ollama (storlek beroende på hårdvara).
- **Rekommenderat:** ~8 GB RAM för mindre modell, mer för större varianter.

## Distribution

Planen är att publicera Gemmera på GitHub under MIT-licens. README:n kommer att innehålla en installations-checklista och en lista över beroenden. Exakt innehåll fastställs senare i projektet — nedan är ett **exempel** på hur det skulle kunna se ut.

*Exempel på installations-checklista:*

- **Klona repo** — t.ex. `git clone` av Gemmera-repot till valfri plats.
- **Installera beroenden** — t.ex. `npm install` i projektmappen.
- **Bygg plugin** — t.ex. `npm run build` för att generera `main.js`.
- **Kopiera till vault** — t.ex. lägg `main.js`, `manifest.json` och `styles.css` i `<vault>/.obsidian/plugins/gemmera/`.
- **Aktivera** — t.ex. slå på Gemmera under Obsidians inställningar → Community plugins.

*Exempel på beroenden:*

- **Obsidian** (t.ex. ≥ 1.5)
- **Node.js** och **npm** — för bygget.
- **Ollama** — lokalt installerad och igång.
- **Gemma-modell** — hämtas via Ollama (storlek beroende på hårdvara).
- **Rekommenderat:** ~8 GB RAM för mindre modell, mer för större varianter.

## Säkerhetsprinciper

- Preview-innan-skriv som default för alla filändringar.
- Append-only uppdateringar av existerande sidor.
- Radering kräver explicit bekräftelse i UI.
- Lokalt via Ollama. Inget cloud-API-fallback.
- MIT-licens.

## Teknisk stack

TypeScript, Obsidian Plugin API, Svelte för chat-UI, Gemma via Ollama lokalt, Markdown med Obsidian-kompatibla wikilinks.
## Tidsplan — 4 veckor

### Vecka 1 ✅ (grund)
- [x] Repo-setup
- [x] Plugin-skelett
- [x] Ollama-integration med token-strömning
- [x] Chat-panel med konversationshistorik
- [x] Persona-generering (Jonas Berg, svenska anteckningar)

### Vecka 2 ✅ (full MVP)
- [x] Verktyg för filskapande, läsning och uppdatering
- [x] Preview-dialog
- [x] Vault-sökning med citat

### Vecka 3 (utökning)
- [ ] Inkrementell indexering

**Slutacceptans:** en ny person installerar pluginet, följer README, och har en fungerande chatt som kan skapa filer i sin vault inom 20 min på en typisk 8 GB-bärbar.

## Utvärdering

20 förberedda frågor/uppgifter om Jonas med kända svar. Mätvärden: svarsandel, citat-korrekthet, kvalitet på skapade filer och wikilinks, körtid (P50/P95) för svar och filskapande.

## Team

Par-projekt. Person A: Ollama-integration och LLM-prompting/verktygsanrop. Person B: Obsidian-plugin-UI, chat-panel, persona-generering. Båda deltar i planering varje vecka; review-rollen roterar.

Se [projektbeskrivning.md](projektbeskrivning.md) för fullständig specifikation.


