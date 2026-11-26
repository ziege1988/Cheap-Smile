# 😊 Cheap Smile

Preisalarm-App fürs iPhone – wie ein „besseres idealo“, nur für **deine** Wunschprodukte und nur mit **seriösen Shops**.

- Produkte per **Name oder Link** hinzufügen, optional mit **Wunschpreis**
- Pro Produkt einstellbar: **gebrauchte Artikel erlauben** (beim Anlegen, in der Kachel und in den Details)
- Preise immer **inkl. Versandkosten** (unbekannter Versand wird konservativ geschätzt und markiert)
- **Push**, wenn der Wunschpreis erreicht ist – und „**Nicht dein Wunschpreis, aber ein sehr gutes Angebot**“, wenn der Preis deutlich unter dem üblichen Niveau liegt
- **Aktionen, Streichpreise und Gutscheincodes** werden erkannt, Codes lassen sich mit einem Tipp kopieren
- **Zum Shop**-Button leitet direkt zum günstigsten seriösen Angebot
- Produkt entfernen = auch der zugehörige Alarm ist weg
- App **aktualisiert sich beim Start selbst**

## Shop-Prüfung (gegen Fake-Shops)

Ein Shop wird nur vorgeschlagen, wenn er **alle** Prüfungen besteht. Ausgeschlossene Shops werden in der Detailansicht mit Grund angezeigt.

| Prüfung | Regel (Standard, in der App änderbar) |
|---|---|
| Sperrliste | AliExpress, Temu, Shein, Wish, Banggood, DHgate … sofort raus |
| Trustpilot | TrustScore ≥ 3,5 **und** ≥ 30 Bewertungen; kein Profil → raus. Blockiert Trustpilot den Abruf, wird die Bewertung über Google (SerpApi) gelesen; geht auch das nicht, wird strenger geprüft (Impressum mit Handelsregister/USt-ID) und markiert |
| Impressum | muss existieren und Firma + Adresse + Kontakt enthalten |
| Herkunft | Firmensitz/Telefon in Fernost (CN, HK, MO, TW, VN, TH, MY, ID, PH, KH, MM, LA) → raus; ebenso Domains wie `.cn` |
| Rückgabe | Widerrufsbelehrung nötig, Frist ≥ 14 Tage, keine Wiedereinlagerungsgebühr, keine Rücksendung nach Fernost |
| Rücksendekosten | > 20 % des Artikelpreises → Angebot raus |
| Domain-Alter | < 1 Jahr → raus (sofern die Registry das Alter per RDAP verrät) |
| Fake-Preis | Preis < 55 % des Marktpreises anderer Shops → „Fake-Shop-Verdacht“ |

**Bekannte Händler (Positivliste, z. B. Otto, MediaMarkt, Amazon):** Große Händler haben auf Trustpilot oft schlechte Werte, obwohl sie seriös sind. Deshalb gilt für sie die Trustpilot-Schwelle nicht. Stattdessen wird geprüft, ob es wirklich der **echte Händler** ist:
- **Originaldomain:** nur exakt `otto.de` (bzw. echte Subdomains) zählt.
- **Nachahmer-Domains** wie `otto-sale.de`, `amaz0n.de`, `mediamartk.de`, `media-markt-outlet.de` oder `saturn-deals.store` werden als Fake-Shop-Verdacht sofort ausgeschlossen.
- **Betreiber:** Das Impressum muss die Marke als Betreiber nennen (z. B. „Otto (GmbH & Co KG)“). Blockiert der Shop automatische Abrufe, genügt die Originaldomain.
- **Fernost** (Sitz oder Rücksendeadresse) schließt auch bekannte Händler aus.
- **Marktplatz-Verkäufer:** Auf Marktplätzen (Amazon, Otto, Kaufland, eBay …) wird der Drittanbieter angezeigt. Verkäufer aus Fernost werden ausgeschlossen.

## Architektur (komplett kostenlos)

```
iPhone (PWA vom Home-Bildschirm)            GitHub Pages  ← app/
        │  HTTPS + Zugangsschlüssel
        ▼
Cloudflare Worker (Free)                    ← worker/
  ├─ API: Produkte, Einstellungen, Push-Abos
  ├─ Cron alle 30 Min.: Preise prüfen, Shops suchen, Pushes senden
  ├─ KV-Speicher: Produkte, Preisverlauf, Shop-Urteile (30 Tage Cache)
  └─ Web Push (VAPID) direkt an Apple
```

- **Websuche:** **Google** über SerpApi (Secret `SERPAPI_KEY`, 250 Suchen/Monat kostenlos, gleichmäßig über den Monat verteilt). Rückfallebene: DuckDuckGo ohne Schlüssel, optional Brave (`BRAVE_API_KEY`). Die offizielle Google Custom Search API nimmt keine neuen Nutzer mehr an und wird zum 01.01.2027 abgeschaltet. Google direkt abzufragen blockiert Google und verstößt gegen die Nutzungsbedingungen.
- **Preise:** werden aus den schema.org-Produktdaten der Shopseite gelesen (wie bei Google Shopping), ersatzweise aus Meta-Tags bzw. dem Seitentext.
- **Free-Tarif-Grenzen:** 50 Abrufe pro Worker-Lauf. Der Cron arbeitet deshalb in Portionen; bei vielen Produkten dauert ein kompletter Durchlauf mehrere Läufe.

## Amazon

Amazon blockiert direkte Abrufe. Mit dem Schalter **„Amazon einbeziehen“** (pro Produkt) fragt die App Amazon.de einmal täglich über die **SerpApi-Amazon-Suche** ab und prüft das Ergebnis mit denselben strengen Regeln. Jede Abfrage verbraucht eine Suche aus dem kostenlosen Monatskontingent (250). Ist es aufgebraucht, zeigt die App einen Hinweis, markiert den letzten Amazon-Preis mit Datum und sendet einmal pro Monat eine Push-Nachricht. **Es entstehen keine Kosten** (kostenloser Tarif ohne Zahlungsmittel).

## Einrichtung

👉 **[ANLEITUNG.md](ANLEITUNG.md) – Schritt für Schritt, ohne Programmierkenntnisse.**

Kurzfassung: Cloudflare-Konto + API-Token, optional SerpApi-Schlüssel, 4 Repository-Secrets
(`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `APP_TOKEN`, `SERPAPI_KEY`), Pages auf „GitHub Actions“,
nach `main` mergen. KV-Speicher und Web-Push-Schlüssel legt das System selbst an.

## Entwicklung
```bash
cd worker && npm test     # 61 Tests: Preis-Extraktion, Shop-Prüfung, Push-Verschlüsselung, Ende-zu-Ende
npx wrangler dev          # API lokal
```

## Grenzen & ehrliche Hinweise
- **Trustpilot** bietet keine kostenlose API. Gelesen wird deshalb die öffentliche Profilseite, und zwar höchstens einmal pro Shop alle 30 Tage. Ob die Nutzungsbedingungen von Trustpilot das erlauben, solltest du selbst prüfen. Ist Trustpilot nicht erreichbar, wird der Shop vorsichtshalber ausgeschlossen und nach 6 Stunden erneut geprüft.
- **Große Shops** (z. B. Amazon) blockieren automatisierte Abrufe teilweise. Solche Angebote erscheinen dann seltener. Abhilfe: das Produkt direkt per **Link** anlegen.
- **Gutscheincodes** stammen nur von der Shopseite selbst. Ob ein Code gültig ist, kann die App nicht garantieren.
- Impressum und Rückgabe werden **automatisch nach Mustern** geprüft. Das ist ein starker Filter, aber keine juristische Prüfung.
