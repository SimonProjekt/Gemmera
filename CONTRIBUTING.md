# Workflow & samarbete — Gemmera

Detta dokument beskriver hur vi arbetar tillsammans i Gemmera-repot. Läs igenom innan du gör din första PR. Det är även avsett att kunna sparas som Claude-memory så att Claude följer samma regler som teamet.

## TL;DR

- Brancha alltid från `dev` med prefix `feature/`, `fix/`, `docs/` eller `refactor/`
- Skriv commits i [Conventional Commits](https://www.conventionalcommits.org/)-format
- Öppna PR mot `dev`, **inte** `main`
- Minst en teammedlem måste approve:a innan merge
- Aldrig committa direkt till `main` eller `dev`
- Aldrig `git push --force` till `main` eller `dev`

## Branchstrategi

| Branch | Syfte | Vem pushar dit? |
|---|---|---|
| `main` | Stabil, demobar kod. Uppdateras endast via PR från `dev` vid milstolpe/release. | Ingen direkt — bara via PR. |
| `dev` | Integrationsbranch. Allt feature-arbete samlas här. | Ingen direkt — bara via PR från feature-branches. |
| `feature/<namn>` | Allt nytt arbete. Branchas från `dev`, mergas tillbaka till `dev`. | Författaren själv. |

### Namnkonvention för feature-branches

- `feature/<beskrivande-namn>` — ny funktionalitet (t.ex. `feature/state-machine-framework`)
- `fix/<beskrivande-namn>` — buggfix
- `docs/<beskrivande-namn>` — dokumentationsändring
- `refactor/<beskrivande-namn>` — refaktorering utan beteendeändring

Använd korta engelska beskrivningar med bindestreck — det matchar branch-namnen GitHub visar i sin UI.

## Daglig arbetsgång

### 1. Innan du börjar på en ny uppgift

```bash
git fetch
git checkout dev
git pull
git checkout -b feature/<din-feature>
```

### 2. Under tiden du arbetar

```bash
git status                                    # vad har ändrats?
git diff                                      # visa ändringarna
git add <fil>                                 # stage:a specifika filer (undvik git add .)
git commit -m "feat(area): kort beskrivning"
git push -u origin feature/<din-feature>      # första push:en
git push                                      # därefter
```

Committa ofta i små bitar. Varje commit ska vara en logisk ändring.

### 3. Innan du öppnar PR — synka med `dev`

Andra har troligen mergat saker till `dev` medan du jobbat. Hämta in det:

```bash
git fetch
git merge origin/dev
# om konflikter: lös dem (se sektionen nedan), committa, pusha
```

Detta gör att du fångar konflikter på din branch i stället för att blanda in dem i PR:n.

### 4. Öppna PR

```bash
gh pr create --base dev --title "feat(area): kort titel" --body "..."
```

**OBS:** `--base dev` är kritiskt. GitHub:s default är `main`, så glöm inte detta.

## Commit-meddelanden — Conventional Commits

Format: `<typ>(<scope>): <kort beskrivning>`

| Typ | När du använder det |
|---|---|
| `feat` | Ny funktionalitet |
| `fix` | Buggfix |
| `docs` | Endast dokumentationsändring |
| `refactor` | Kodförbättring utan beteendeändring |
| `test` | Lagt till eller ändrat tester |
| `chore` | Bygge, paketändring, config, etc. |

**Scope:** området som ändras — `rag`, `ui`, `tool-loop`, `runtime`, `classifier`, `chat`, etc.

**Exempel från repots historik:**

- `feat(rag): markdown-aware chunker (closes #6)`
- `fix(rag): chunker hashes textForEmbed, not raw text`
- `docs: add bge-m3 install step and mark Vecka 3 complete`

**Stäng issues automatiskt:** lägg `Closes #N` (eller `Fixes #N` för buggar) i commit-meddelandet eller PR-beskrivningen — issuen stängs då när PR:n mergas.

## Issues

Vi använder GitHub Issues för all uppgiftsspårning. [Öppna issues](https://github.com/SimonProjekt/Gemmera/issues) är listan över vad som behöver göras.

### När du tar en issue

1. Läs igenom issue-beskrivningen i sin helhet
2. Lämna en kommentar på issuen: t.ex. "Jag tar denna"
3. Assigna dig själv: `gh issue edit <N> --add-assignee @me`
4. Referera issuen i din branch och commits (`feature/state-machine-framework` för #33)
5. Stäng issuen via PR:n med `Closes #<N>`

### Innan du claim:ar en stor issue

Kolla att ingen annan redan jobbar på det området. Snabb check:

```bash
git log --all --oneline -20 --grep="<sökord>"
gh issue list --assignee "*"
```

## Pull Requests

### Vad PR:n ska innehålla

PR-beskrivningen bör täcka:

- **Vad** — kort sammanfattning av ändringen
- **Varför** — länk till issuen och kort motivering
- **Hur testa** — kommandon eller manuella steg så att reviewer kan verifiera

Mall:

```markdown
## Vad
Implementerar state machine-ramverket per #33.

## Varför
Närmaste byggsten för ingest- och query-state-machines (#39, #41) som är nästa
prioritet i Tool-loop v1.

## Hur testa
- `npm test` — alla nya unit tests ska passera
- Lägg till en debug-state och verifiera i dev-tools

Closes #33
```

### Review-process

- Minst en teammedlem måste approve:a innan merge
- Reviewer-rollen roterar mellan teammedlemmarna
- Använd GitHub:s review-knappar: **Approve**, **Request changes**, **Comment**
- Diskutera i kommentarer på PR:n (inte i DM/Slack) — det ger spårbarhet
- Sikta på att reviewa inom 24 timmar

### Merge-policy

- **Squash & merge** är default — en commit per feature i `dev`-historiken
- **PR-författaren mergar** efter approve, inte reviewern
- Radera feature-branchen efter merge (GitHub erbjuder en knapp)

## Konflikter

När `git merge origin/dev` säger att det finns konflikter:

1. `git status` listar konfliktade filer
2. Öppna varje fil — leta efter markörer:
   ```
   <<<<<<< HEAD
   din ändring
   =======
   den andras ändring
   >>>>>>> origin/dev
   ```
3. Behåll det som ska vara kvar (kan vara båda, en av dem, eller en kombination), ta bort alla markörer
4. `git add <fil>` när filen är fixad
5. När alla filer är resolved: `git commit` (Git föreslår automatiskt ett merge-meddelande)
6. Kör testerna för att verifiera att inget gick sönder
7. `git push`

Om du fastnar — fråga i teamchatten eller pinga en teammedlem på issuen.

## Releases (dev → main)

När `dev` är stabilt och innehåller en milstolpe:

1. Öppna PR från `dev` → `main`
2. Hela teamet reviewar
3. Merge → tagga (`git tag v0.1.0`) → skapa release på GitHub

## Det här gör vi aldrig

- **Inte** committa direkt till `main` eller `dev`
- **Inte** `git push --force` till `main` eller `dev`
- **Inte** mergea egna PR utan review
- **Inte** committa secrets (`.env`, API-nycklar, lösenord)
- **Inte** radera andras branches utan att fråga
- **Inte** använda `--no-verify` för att kringgå hooks

## För Claude (AI-pair)

Om du läser detta som Claude när du arbetar i Gemmera-repot, följ dessa regler:

- Skapa alltid en `feature/`-, `fix/`-, `docs/`- eller `refactor/`-branch från `dev` innan du gör ändringar — aldrig direkt på `main` eller `dev`
- Använd Conventional Commits-format för alla commit-meddelanden (`<typ>(<scope>): <beskrivning>`)
- PR-base ska alltid vara `dev`, aldrig `main`
- Innan du börjar arbeta på en issue: be användaren bekräfta att den ska claim:as och föreslå att assigna användaren på GitHub
- Föreslå PR-titel och -beskrivning, men öppna inte PR:n utan användarens godkännande
- Force-push, `git reset --hard`, branch-radering och andra destruktiva operationer kräver alltid explicit godkännande från användaren — fråga först
- Innan du föreslår en stor branch-ändring (rebase, force-push), kontrollera först att branchen inte är delad
