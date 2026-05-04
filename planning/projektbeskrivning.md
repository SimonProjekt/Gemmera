# Personlig kunskapsbas — projektbeskrivning

**DD1349 VT26 — Projektuppgift i introduktion till datalogi**

## Kort beskrivning

Ett Python-CLI som förvandlar en Obsidian-vault till en lokal, privat kunskapsbas driven av Gemma 4. Användaren släpper råa dokument i `raw/`, kör ett kommando som låter Gemma kompilera dem till sammanlänkade wiki-sidor med `[[wikilinks]]` och backlinks, och kan sedan ställa frågor mot sin kunskapsbas — allt utan att data lämnar datorn. Verktyget levereras med en genererad fejkperson ("Jonas Berg") som inbyggd demo-korpus så allt fungerar direkt efter kloning.

Projektet tillämpar samma säkerhets- och privacyprinciper som en fullständig Obsidian-plugin-version som planeras separat (se `planning/overview.md` för den långsiktiga arkitekturen). Denna CLI är en skalad-ned variant som kan byggas av ett par studenter på fyra veckor.

## Problem vi löser

Andrej Karpathy beskrev ett kraftfullt mönster för personliga kunskapsbaser i en gist från april 2026, men lämnade paketering och interaktion öppet. Samtidigt använder alla befintliga implementationer externa API:er — vilket betyder att din mest personliga data skickas till Anthropic eller OpenAI. Vi bygger den version av mönstret som faktiskt kan användas för privat material: lokalt via Gemma 4, med Obsidian som gränssnitt, och gratis att köra efter installation.

## Målgrupp

Personer som redan använder eller vill börja använda Obsidian för att samla anteckningar, artiklar, dagboksinlägg eller forskningsmaterial — och som vill ha AI-driven struktur och sökning utan att lämna ifrån sig sin data. Sekundärt: utvecklare som vill ha en färdigpaketerad implementation av Karpathy-mönstret att bygga vidare på.

## MVP — vad som levereras i slutet av vecka 2

En Obsidian-vault med tre mappar:

- `raw/` — råa filer som användaren lägger in
- `wiki/` — LLM-kompilerade och sammanlänkade sidor
- `outputs/` — svar på frågor och intermediär data

En CLI med tre kommandon:

- `kb compile` — Gemma 4 E4B läser allt i `raw/` och bygger eller uppdaterar wiki-sidorna med Obsidian-kompatibla `[[wikilinks]]`, taggar och backlinks. Preview visas innan skrivning.
- `kb ask "fråga"` — svarar på frågor med citat och hänvisningar till specifika wiki- och raw-filer.
- `kb lint` — hittar motsägelser, orphan-sidor (utan inkommande länkar) och påståenden utan källa.

Fejkpersonen "Jonas Berg" medföljer i repot som komplett demo-vault: dagboksinlägg, brev, bokrecensioner, projektanteckningar. Persona-datan genereras med hjälp av Claude API (engångskörning) och genereringsscriptet ingår i repot så att användare kan skapa egna personor med andra egenskaper.

Obsidians inbyggda graf-vy visar automatiskt hur wiki-sidorna hänger ihop.

## Säkerhetsprinciper

Dessa principer är ärvda från den större plugin-planeringen och tillämpas även i denna CLI-version:

- **Preview-innan-skriv är default.** `kb compile` visar alla föreslagna wiki-sidor innan filerna skrivs till disk. Användaren godkänner explicit (eller kör `--yes` för automatisk acceptans i CI).
- **Append-only vid uppdatering.** Om en wiki-sida redan finns läggs nytt innehåll till under ett daterat avsnitt, aldrig ovanpå befintligt. Det finns ingen full-body-replace-funktion i v1.
- **Uttrycklig bekräftelse vid radering.** Destruktiva operationer (`kb lint --prune-orphans` eller motsvarande) kräver både flagga och interaktiv y/N-prompt. Aldrig tyst radering.
- **Lokalt, ingen cloud.** Allt inferensarbete via Ollama lokalt. Inget cloud-API-fallback i någon situation.
- **MIT-licens** för att tillåta återanvändning och vidareutveckling.

## Uttalade icke-mål

- Ingen egen markdown-editor eller frontend — Obsidian är vårt gränssnitt.
- Ingen egen graf-visualisering — vi använder Obsidians inbyggda graf-vy.
- Ingen användarautentisering eller multi-user-stöd.
- Ingen vektor-databas eller embeddings — vi följer Karpathys filbaserade approach. (Den fullskaliga plugin-versionen använder embeddings; denna CLI gör inte det.)
- Ingen finjustering av modeller.
- Ingen mobilapp (Obsidian Mobile finns redan för den som vill läsa sin vault på telefonen).
- Ingen deploy till produktion — localhost räcker för demo.
- Ingen Obsidian-plugin-implementation i denna kursversion (plugin-versionen är ett separat, långsiktigt projekt).
- Inget cloud-API-fallback. Allt körs lokalt. E4B eller inget.
- Inga större Gemma-varianter (26B MoE, 31B Dense). E4B är den enda modellen vi stödjer.

## Arkitektur i korthet

Systemet är tre lager:

1. **Kompileringspipeline** — Gemma 4 E4B tar råa dokument, identifierar koncept, extraherar relationer, och genererar wiki-sidor med `[[wikilinks]]`. Prompt-strukturen är versionerad och JSON-schema-tvingad via Ollama `format: "json"`.
2. **Fråge-pipeline** — Gemma E4B får råa plus wiki-sidor som kontext, svarar på frågan, och producerar svar med citat till källfiler. Citat valideras mot tillgängliga filer; hallucinerade länkar avvisas.
3. **Vault-struktur** — plain Markdown på disk med frontmatter och Obsidian-kompatibla wikilinks. Ingen databas, ingen synk, ingen vendor lock-in.

Gemma-integration sker via Ollama som körs lokalt. CLI:n antar att Ollama är installerad (lägger det som krav i installationsguiden) — till skillnad från plugin-versionen spawnar vi inte Ollama automatiskt.

## Teknisk stack

- Python 3.11+
- Gemma 4 E4B lokalt via Ollama (~3 GB första gången)
- Obsidian som gränssnitt (gratis, finns för alla plattformar)
- Markdown-filer med Obsidian-kompatibla `[[wikilinks]]` som primär lagring
- Typer för CLI (modernt, typsäkert, Click-kompatibelt)
- Claude API för engångsgenerering av fejkpersonens data
- pytest för tester
- GitHub Actions för CI om tiden räcker
- MIT-licens

Avsiktliga avvägningar jämfört med plugin-versionen:

- Ingen DuckDB eller embeddings — Karpathys filbaserade approach passar kursens tidsram.
- Ingen reranker.
- Ingen state machine — raka async-funktioner räcker för CLI-komplexiteten.
- Ingen intent classifier — användaren väljer kommando explicit (`compile`, `ask`, `lint`).

## Tidsplan — 4 veckor, konkret

### Vecka 1: grund

Dag 1–2: Repo-setup, beroenden (Typer, pytest, python-ollama-klient), CLI-skelett med tomma `kb compile`, `kb ask`, `kb lint`. `.kbignore`-format definierat (gitignore-stil).

Dag 3–4: Vault-struktur bestämd (`raw/`, `wiki/`, `outputs/`). Fejkpersona "Jonas Berg" genereras via Claude API med repeterbart script. Minst 15 dokument i `raw/`.

Dag 5–7: `kb compile` fungerar på ett enstaka dokument — läser en fil från `raw/`, anropar Gemma E4B via Ollama med versionerad prompt, producerar en wiki-sida med korrekta `[[wikilinks]]` efter preview-godkännande.

**Acceptans vecka 1**: en användare klonar repot, följer installationsguiden, kör `kb compile` på en fil, godkänner preview, och ser en giltig wiki-sida i `wiki/` som öppnas snyggt i Obsidian.

### Vecka 2: full MVP

Dag 8–10: `kb compile` fungerar på hela Jonas-korpusen (ca 20 filer). Cross-referenser mellan wiki-sidor via `[[wikilinks]]`. Append-only uppdatering om en wiki-sida redan finns (under daterat avsnitt).

Dag 11–12: `kb ask "fråga"` implementerad. Svar med citat till källfiler; citat valideras mot faktiska filer, hallucinerade länkar avvisas. Output skrivs till `outputs/` med tidsstämpel.

Dag 13–14: `kb lint` implementerad (motsägelser, orphan-sidor, påståenden utan källa). Tester skrivna för alla tre kommandon. Destruktiva lint-operationer kräver `--confirm` + y/N-prompt.

**Acceptans vecka 2**: hela Jonas-korpusen kompilerar utan fel. Minst 15 av 20 testfrågor besvaras korrekt med rätt citat. Lintern hittar minst 80% av medvetet injicerade motsägelser. Graf-vyn i Obsidian visar sammanhängande kluster.

### Vecka 3: utvald utökning

Vi väljer en av följande alternativ baserat på vecka-2-retrospektivet och kvarvarande tid. Valet sker vid slutet av vecka 2.

**Alternativ A — Röstinmatning.** Tala in en tanke, transkriberas lokalt (whisper.cpp eller motsvarande), texten sparas som ny `raw/`-fil och vävs in vid nästa `kb compile`.

**Alternativ B — Inkrementell kompilering.** Bara kompilera om det som ändrats sedan senaste körningen (content-hash per fil), istället för hela vaulten. Speedup för stora vaults.

**Alternativ C — Tunn Obsidian-plugin-brygga.** Lägger till `Kompilera`- och `Fråga`-knappar i sidofältet som anropar CLI:n via IPC. Inte den fullskaliga plugin-versionen, utan en minimalbrygga för bättre demo-UX.

### Vecka 4: polering och demo

Dag 22–24: Utvärdering mot de 20 testfrågorna dokumenteras. Kvantitativa resultat sammanfattas. Kvalitativ analys av vilka frågor som fungerar och vilka som kollapsar.

Dag 25–26: README skrivs med installationsguide (Ollama + Gemma 4 E4B pull), skärmdumpar från Obsidian inklusive graf-vyn, exempel-kommandon, troubleshooting.

Dag 27–28: Demo-förberedelse: körordning, backup-plan om Ollama kraschar, förberedd scripted demo som körs offline om live-körning fallerar.

**Slutacceptans**: en ny person kan klona repot, följa README, och ha `kb ask` fungerande inom 20 minuter på en typisk 8 GB-bärbar.

## Acceptanstester

Dessa körs manuellt vid slutet av varje vecka och automatiseras med pytest där möjligt.

1. Klona repot på en ren dator, följ installationsguiden, kör `kb ask "vem är Jonas?"` och få ett meningsfullt svar med giltiga citat.
2. Kör `kb compile` på Jonas-korpusen, öppna vaulten i Obsidian, se att graf-vyn visar sammanhängande kluster.
3. Kör `kb lint` på en modifierad version av Jonas-korpusen där vi medvetet injicerat motsägelser — lintern flaggar minst 80% av dem.
4. Kör `kb compile` två gånger på samma input. Andra körningen detekterar att inget ändrats och hoppar över de oförändrade filerna (kräver vecka-3 alternativ B om vi inte valt det).
5. Avbryt `kb compile` mitt i körningen med Ctrl+C. Inga halvskrivna filer kvar i vault; eventuella pågående preview-godkännanden kastas.

## Risker och motåtgärder

| Risk | Sannolikhet | Påverkan | Motåtgärd |
|---|---|---|---|
| Gemma 4 E4B för svag för strukturerad extraktion | Medel | Hög | JSON-schema-tvingad dekodning (Ollama `format: "json"`). Förenkla extraktion-schemat om kvaliteten brister. Om fortfarande otillräckligt efter vecka 1 — utvärdera en större lokal modell, men håll fast vid inget cloud-fallback. |
| Hallucinerade wikilinks till sidor som inte finns | Hög | Medel | Validera alla `[[wikilinks]]` i output mot befintliga filer. Okända länkar markeras som förslag i preview, inte auto-skrivs. |
| Ollama installationsfriktion för testare | Medel | Medel | Installationsguide för macOS, Linux, Windows. Första-gången-script som verifierar Ollama och modell-pull innan första `kb compile`. |
| 4-veckors tidsram är knapp | Medel | Hög | Vecka 3-utökningen är optional — MVP levereras vid slutet av vecka 2. Vecka 4 är alltid polering oavsett vecka-3-resultat. |
| Persona-generering kostar för mycket Claude API-kredit | Låg | Låg | Engångskörning, ca 50 Claude-anrop totalt. Cachad output i repot så att kloning inte triggar ny generering. |
| Testfrågor för lätta eller för svåra | Medel | Medel | Iterera på frågesetet efter första körningen. Balansera svårighetsgrad mellan direkta fakta och flerstegsslutsatser. |
| Gemma-pull på 3 GB tar tid på svag uppkoppling | Låg | Låg | Förvarna i installationsguiden. Erbjud kachad tar.gz-backup för demo-datorer. |

## Beslut som är fastslagna

- Python CLI, inte Obsidian-plugin, i denna kursversion.
- Gemma 4 E4B som enda modell. Ingen 26B MoE, 31B Dense, eller annan variant.
- Ollama som lokal runtime. Användaren installerar själv; CLI:n spawnar inte Ollama.
- Filbaserad approach (Karpathy-mönstret). Ingen DuckDB, ingen embeddings, ingen reranker.
- Append-only uppdateringar av wiki-sidor. Ingen full-body-replace-funktion.
- Preview-innan-skriv som default för `kb compile`.
- Radering kräver explicit `--confirm` plus interaktiv y/N-bekräftelse.
- Inget cloud-API-fallback någonsin.
- MIT-licens.
- Typer för CLI.
- pytest för tester.

## Öppna frågor (parkerade, inte blockerande)

- Exakt prompt-formulering för kompileringspipeline och frågebesvaring — skrivs under vecka 1.
- Valet av vecka-3-utökning (A/B/C) — sker efter vecka-2-retrospektiv.
- Om whisper.cpp eller något annat är rätt val för röstinmatning (alternativ A) — utreds innan beslutet.
- Vilken version av Ollama vi ska kräva som minimum i installationsguiden — bestäms när vi verifierat API-stabiliteten.

## Utvärdering

Vi skriver 20 förberedda frågor om Jonas med kända svar (till exempel "när träffade han senast sin bror?", "vilka böcker läste han i januari?") och mäter hur ofta systemet svarar korrekt. Vi dokumenterar även vilka typer av frågor som fungerar bra och vilka som kollapsar.

Lintern utvärderas genom att medvetet injicera motsägelser i Jonas data och mäta hur stor andel som upptäcks.

Vi utvärderar också kvaliteten på de genererade wikilinks — hur ofta länkar de rätt, och hur användbar blir graf-vyn i Obsidian?

Mätvärden i slutrapporten:

- **Svarsandel**: andel av de 20 frågorna som besvaras korrekt.
- **Citat-korrekthet**: andel svar där citaten faktiskt backar upp påståendet.
- **Lint precision och recall** på injicerade motsägelser.
- **Wikilink-kvalitet**: andel länkar som pekar på rätt sida.
- **Körtid**: `kb compile` på hela korpusen (P50 och P95), `kb ask` per fråga.

## Vår egen edge

Karpathy beskrev ett datamönster, inte en produkt. Vi paketerar mönstret på tre avgörande sätt:

1. **Lokalt via Gemma 4 E4B** — ingen data lämnar din dator, vilket är hela poängen med en "personlig" kunskapsbas. Privacy-vinkeln är vårt starkaste argument.
2. **Obsidian som gränssnitt** — istället för att bygga en egen frontend utnyttjar vi ett verktyg som miljontals redan använder. Graf-vy, backlinks, sökning och taggning kommer gratis. Vi fokuserar på det AI:n gör, inte på att bygga UI.
3. **Inbyggd demo-persona som gör att verktyget fungerar direkt efter kloning.** Öppna vaulten i Obsidian, kör ett kommando, klar. Genereringsscriptet låter vem som helst skapa sin egen fejkperson.

## Teamupplägg

Par-projekt. Vi delar upp arbetet så att båda kan förklara alla delar.

- **Person A** fokuserar primärt på kompileringspipelinen och LLM-prompting (hur Gemma 4 extraherar koncept och skapar wikilinks).
- **Person B** fokuserar primärt på CLI-ergonomi, vault-struktur och fejkpersona-generering.

Varje vecka roterar den som driver review-cykeln (öppnar pull requests, granskar den andres PR). Båda deltar i planeringen varje vecka.

## Planerade utökningar om tid finns (utöver vecka 3)

- **Auto-taggning** och upptäckt av duplicerade koncept mellan wiki-sidor.
- **Import av webbartiklar** via Obsidian Web Clipper direkt till `raw/`.
- **CI med GitHub Actions** som kör pytest på varje push om det inte hunnits med under vecka 1.

## Koppling till den större plugin-planeringen

Denna CLI är en bantad version av en större Obsidian-plugin-arkitektur som planeras separat i `planning/overview.md`. Principer som delas:

- Lokalt först, ingen cloud-fallback.
- Gemma 4 E4B som enda modell.
- Obsidian som långsiktig lagring (bara Markdown på disk).
- Preview-innan-skriv, append-only, uttrycklig bekräftelse vid radering.
- MIT-licens.

Skillnader från plugin-versionen:

- CLI istället för Obsidian-plugin — kursen är i Python, och fyra veckor räcker inte för en fullständig TypeScript-plugin.
- Filbaserad retrieval (Karpathy-mönstret) istället för DuckDB + embeddings + reranker.
- Raka async-funktioner istället för state machines.
- Ingen intent classifier — användaren väljer kommando explicit.
- Användaren installerar Ollama själv istället för att plugin:en spawnar det.

Plugin-versionen är ett separat, långsiktigt projekt. Denna kurs är ett första steg på vägen och validerar kärnprinciperna i en mindre, snabbare form.
