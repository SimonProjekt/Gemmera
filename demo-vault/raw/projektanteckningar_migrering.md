# Migrationsuppdraget — veckomöte nov 2025

**Datum:** 12 november 2025  
**Närvarande:** Jonas, David, Karin (tech lead), Lisa (kund), Erik R (kund, produktägare)

---

## Diskuterat

Domain boundaries är fortfarande inte låsta. Lisa vill att betalflödet ligger i en domän, Erik R vill dela upp det i tre separata tjänster (checkout, payment, refund). Karin håller med Erik R i teorin men påpekade att det kräver mer arbete med eventuell konsistens.

Beslut: en tjänst i MVP, splittad vid behov i fas 2. Dokumenteras i ADR.

Databas: enades om att varje mikrotjänst äger sin data. Read-modell löses med events (Kafka). Jonas ska ta fram event-schema-förslag till nästa vecka.

## Risk jag lyfte (ingen lyssnade)

Rollback-procedurerna är inte definierade. Om migreringen av en tjänst går fel i prod — vad händer? Vi har inte svaret och det är oroväckande. Lisa sa "vi tar det när vi kommer dit". David nickade åt mig på ett sätt som sa "du har rätt men det är inte värt striden nu".

Noterat här för att kunna säga "jag sa det" senare. Förhoppningsvis aldrig.

## Nästa steg

- Jonas: event-schema-förslag (fredag)
- David: CI/CD-pipeline för tjänst 1 (nästa sprint)
- Karin: ADR för domain split
- Kund: bekräfta staging-miljön är klar (utlovad sedan 3 veckor)

## Övrig anteckning

Kunden ändrade scope igen. Tjänst 2 ska nu inkludera notifikationer som tidigare var separat. Lade till en dag i estimat. Lisa verkade inte förstå varför.
