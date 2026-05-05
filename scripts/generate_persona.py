#!/usr/bin/env python3
"""
Generate demo-vault/raw/ documents for the fictional persona Jonas Berg.

Run once to populate the vault. Skips files that already exist so it is safe
to re-run after partial failures. Requires ANTHROPIC_API_KEY in the environment.

Usage:
    python scripts/generate_persona.py
    python scripts/generate_persona.py --output demo-vault/raw
"""

import argparse
import os
import sys
import time
from pathlib import Path

import anthropic

# ---------------------------------------------------------------------------
# Jonas Berg — persona specification
# ---------------------------------------------------------------------------
PERSONA = """
Du skriver dokument för den fiktiva personen Jonas Berg. Håll dig strikt till
dessa fakta i allt du skriver:

GRUNDFAKTA
- Namn: Jonas Berg
- Född: 14 mars 1989, Uppsala
- Bor nu: Uppsala (Luthagen)
- Yrke: Mjukvaruutvecklare på ett mellanstort konsultbolag (Stratego AB)
- Språk: Skriver på svenska

FAMILJ
- Dotter Maja, född 2017. Jonas har henne varannan vecka (delad vårdnad).
- Skild från Sara sedan 2022. Separationen var svår men de är nu civila mot varandra.
- Pappa Gunnar avled i en hjärtattack i november 2023. Jonas sörjer fortfarande.
- Mamma Britta, 68, bor i Göteborg. Ring varandra ungefär en gång i veckan.
- Bror Erik, 33, bor i Malmö. Hade ett allvarligt bråk med Jonas i december 2023
  (handlade om arvet efter pappan). De har knappt pratat sedan dess.

PERSONLIGHET & INTRESSEN
- Introvert men varm. Tänker mycket innan han talar.
- Stark läsare — framför allt science fiction, filosofi och svensk skönlitteratur.
- Började springa och vandra 2025 som ett sätt att hantera sorgen efter pappan.
- Lyssnar på indie-folk och jazz. Spelar gitarr dåligt men med glädje.
- Jobbar på ett personligt sidoprojekt: ett enkelt CLI-verktyg i Rust för
  att hantera läslistor (heter "bokhylla").
- Reflekterande dagboksskrivare sedan tonåren.
- Dricker för mycket kaffe. Försöker minska.

VÄNNER
- Petra Lindqvist: bästa vän sedan gymnasiet, bor i Stockholm, jobbar på museum.
- David Ek: jobbkollega och träningskompis.
- Linnea Strand: bokklubben, träffas en gång i månaden.

AKTUELLT (2025–2026)
- Jobbar på ett stort migrationsuppdrag (monolith → mikrotjänster) för en kund.
- Maj–juni 2025: vandrade E4-sträckan Sundsvall–Härnösand (3 dagar, 60 km) med David.
- Höst 2025: läste Ursula K. Le Guins "The Dispossessed", påverkad starkt.
- Januari 2026: skickade ett brev till Erik. Inget svar ännu.
- Maja fyller 9 i april 2026. Jonas planerar en utflykt till Skansen.
"""

# ---------------------------------------------------------------------------
# Documents to generate
# ---------------------------------------------------------------------------
DOCUMENTS = [
    # --- Diary entries ---
    {
        "filename": "dagbok_2025-03-14.md",
        "prompt": (
            "Skriv ett dagboksinlägg daterat den 14 mars 2025 (Jonas 36-årsdag). "
            "Han skriver på kvällen. Maja ringde och sjöng Grattis. Han är lite melankolisk "
            "men också tacksam. Nämn att han tänker på pappan. Ca 300 ord."
        ),
    },
    {
        "filename": "dagbok_2025-05-28.md",
        "prompt": (
            "Skriv ett dagboksinlägg daterat den 28 maj 2025, kvällen innan vandringen "
            "med David ska börja. Jonas packar ryggsäcken och är nervös men exalterad. "
            "Det är hans första fleradagarsvandring. Ca 250 ord."
        ),
    },
    {
        "filename": "dagbok_2025-06-01.md",
        "prompt": (
            "Skriv ett dagboksinlägg daterat den 1 juni 2025 — sista vandringsdagen. "
            "De kom fram till Härnösand. Fötterna gör ont. Jonas mår bra för första "
            "gången på länge. Konkreta detaljer om landskapet, en rolig händelse under "
            "vandringen, och en känsla av att ha åstadkommit något. Ca 350 ord."
        ),
    },
    {
        "filename": "dagbok_2025-10-08.md",
        "prompt": (
            "Skriv ett dagboksinlägg daterat den 8 oktober 2025. Jonas har precis "
            "avslutat 'The Dispossessed'. Han reflekterar över boken och kopplar "
            "temat om egendom och frihet till sin egen situation efter skilsmässan "
            "och pappans bortgång. Bokklubben träffas om en vecka. Ca 300 ord."
        ),
    },
    {
        "filename": "dagbok_2025-12-24.md",
        "prompt": (
            "Skriv ett dagboksinlägg daterat julafton den 24 december 2025. "
            "Maja är hos Sara i år. Jonas är ensam hemma. Han lagade en enkel middag, "
            "ringde mamma Britta, tänkte på Erik. Ledsamt men inte dramatiskt — mer "
            "en stillsam reflektion. Ca 280 ord."
        ),
    },
    {
        "filename": "dagbok_2026-01-15.md",
        "prompt": (
            "Skriv ett dagboksinlägg daterat den 15 januari 2026. Jonas skickade "
            "brevet till Erik för två veckor sedan. Inget svar. Han är osäker om "
            "han gjorde rätt. Funderar på jobbet — migrationsuppdraget är stressigt. "
            "Planerar Majas 9-årsdag i april. Ca 300 ord."
        ),
    },
    {
        "filename": "dagbok_2026-03-02.md",
        "prompt": (
            "Skriv ett dagboksinlägg daterat den 2 mars 2026. Jonas språng 10 km "
            "i snön på morgonen — personbästa. Kollegan David nämnde att han funderar "
            "på att byta jobb. Jonas funderar om han också borde det. Sidoprojektet "
            "'bokhylla' tar form, ett litet genombrott i koden igår. Ca 280 ord."
        ),
    },
    # --- Book reviews ---
    {
        "filename": "bokrecension_the-dispossessed.md",
        "prompt": (
            "Skriv en personlig bokrecension av Ursula K. Le Guins 'The Dispossessed' "
            "skriven av Jonas i oktober 2025. Inte en akademisk recension — mer en "
            "reflektion i dagboksstil om vad boken betydde för honom personligen, "
            "kopplat till hans egna tankar om frihet, egendom och gemenskap. Ca 400 ord."
        ),
    },
    {
        "filename": "bokrecension_mannen-utan-egenskaper.md",
        "prompt": (
            "Skriv en kortare bokrecension av Robert Musils 'Mannen utan egenskaper' "
            "(del 1) skriven av Jonas i september 2025. Han kämpar med boken — den är "
            "svår men fascinerande. Han är halvvägs igenom. Reflektera över vad det "
            "innebär att 'vara' någon. Ca 250 ord."
        ),
    },
    {
        "filename": "bokrecension_projekt-hail-mary.md",
        "prompt": (
            "Skriv en enthusiastisk bokrecension av Andy Weirs 'Project Hail Mary' "
            "skriven av Jonas i maj 2025. Han älskade den — speciellt vänskapen "
            "som uppstår. Utan spoilers om slutet. Ca 300 ord."
        ),
    },
    # --- Letters ---
    {
        "filename": "brev_till_erik_2026-01.md",
        "prompt": (
            "Skriv brevet Jonas skickade till sin bror Erik i januari 2026. "
            "Det är det första egentliga kontaktet sedan bråket om arvet. "
            "Jonas tar inte tillbaka allt men vill ha sin bror tillbaka. "
            "Brevet är försiktigt, ärligt och lite fumligt — inte fullt genomarbetat. "
            "Ca 350 ord. Formatera som ett faktiskt brev (Hej Erik, ... / Jonas)."
        ),
    },
    {
        "filename": "brev_till_petra_2025-08.md",
        "prompt": (
            "Skriv ett brev/mejl Jonas skickade till sin bästa vän Petra i Stockholm "
            "i augusti 2025. De ses sällan på sistone. Jonas berättar om vandringen, "
            "om hur han mår, och frågar hur det är med hennes utställningsprojekt "
            "på museet. Ledigt och varmt tonfall. Ca 300 ord."
        ),
    },
    # --- Project notes ---
    {
        "filename": "projektanteckningar_bokhylla.md",
        "prompt": (
            "Skriv Jonas tekniska anteckningar om sitt CLI-sidoprojekt 'bokhylla' "
            "i Rust. Inkludera: vad projektet gör (spåra läslista, betyg, anteckningar), "
            "vilka kommandon som finns (add, list, review, done), tekniska utmaningar "
            "han stött på (t.ex. serialisering med serde_json, felhantering). "
            "Skriv som anteckningar till sig själv — inte dokumentation. Ca 350 ord."
        ),
    },
    {
        "filename": "projektanteckningar_migrering.md",
        "prompt": (
            "Skriv Jonas anteckningar från jobbet om migrationsuppdraget "
            "(monolith → mikrotjänster) för kund. Anteckningarna är från ett "
            "veckomöte i november 2025. Inkludera: vad teamet diskuterade, "
            "beslut som togs om domain boundaries, en risk Jonas lyfte som ingen "
            "lyssnade på, nästa steg. Inga riktiga kundnamn — 'Kunden' räcker. "
            "Skriv som snabba arbetsanteckningar. Ca 300 ord."
        ),
    },
    # --- Other personal writing ---
    {
        "filename": "tankar_om_pappa.md",
        "prompt": (
            "Skriv ett odaterat, mer essäistiskt stycke där Jonas försöker sätta ord "
            "på vad han saknar med sin pappa Gunnar ett år efter att han gick bort. "
            "Inte en nekrolog — mer ett försök att förstå sorgen. Konkreta minnen "
            "blandas med abstrakta reflektioner. Ca 400 ord."
        ),
    },
    {
        "filename": "vandringsnoter_sundsvall_harnosand.md",
        "prompt": (
            "Skriv Jonas fältanteckningar från vandringen Sundsvall–Härnösand i juni 2025. "
            "Tre korta sektioner: Dag 1, Dag 2, Dag 3. Konkreta detaljer: väder, "
            "terräng, vad de åt, en rolig eller svår incident per dag, slutkänslan. "
            "Skriv som snabba anteckningar gjorda i fält — inte polerad prosa. Ca 400 ord."
        ),
    },
    {
        "filename": "laslogg_2025.md",
        "prompt": (
            "Skriv Jonas läslogg för 2025 — en lista med korta kommentarer om varje "
            "bok han läste under året. Inkludera minst 8 böcker med datum-ungefär, "
            "betyg 1-5 och 1-3 meningar per bok. Bland böckerna ska ingå "
            "'Project Hail Mary', 'Mannen utan egenskaper' (del 1, ej klar), "
            "och 'The Dispossessed'. Resten hittar du på. Ca 350 ord."
        ),
    },
    {
        "filename": "boklubbsanteckningar_okt2025.md",
        "prompt": (
            "Skriv Jonas anteckningar från bokklubben i oktober 2025 där de "
            "diskuterade 'The Dispossessed'. Deltagare: Jonas, Linnea Strand, "
            "två andra (Karin och Marcus). Anteckna vad de tyckte, var de var "
            "oense, vilka citat som diskuterades. Skriv som snabba mötesanteckningar. "
            "Ca 280 ord."
        ),
    },
]


def generate_document(client: anthropic.Anthropic, doc: dict, out_dir: Path) -> bool:
    path = out_dir / doc["filename"]
    if path.exists():
        print(f"  skip  {doc['filename']} (exists)")
        return False

    print(f"  gen   {doc['filename']} ...", end="", flush=True)
    try:
        message = client.messages.create(
            model="claude-opus-4-7",
            max_tokens=1024,
            system=[
                {
                    "type": "text",
                    "text": PERSONA,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": doc["prompt"]}],
        )
        text = message.content[0].text
        path.write_text(text, encoding="utf-8")
        print(f" done ({message.usage.output_tokens} tok)")
        return True
    except anthropic.APIError as e:
        print(f" ERROR: {e}")
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Jonas Berg demo documents")
    parser.add_argument(
        "--output",
        default="demo-vault/raw",
        help="Output directory (default: demo-vault/raw)",
    )
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("Error: ANTHROPIC_API_KEY environment variable not set")

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    client = anthropic.Anthropic(api_key=api_key)

    print(f"Generating {len(DOCUMENTS)} documents into {out_dir}/\n")
    generated = 0
    for i, doc in enumerate(DOCUMENTS, 1):
        print(f"[{i:2d}/{len(DOCUMENTS)}]", end=" ")
        if generate_document(client, doc, out_dir):
            generated += 1
            if i < len(DOCUMENTS):
                time.sleep(0.5)

    print(f"\nDone. Generated {generated} new files, skipped {len(DOCUMENTS) - generated}.")


if __name__ == "__main__":
    main()
