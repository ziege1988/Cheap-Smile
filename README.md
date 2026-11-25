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
| Trustpilot | TrustScore ≥ 3,5 **und** ≥ 30 Bewertungen; kein Profil → raus |
| Impressum | muss existieren und Firma + Adresse + Kontakt enthalten |
| Herkunft | Firmensitz/Telefon in Fernost (CN, HK, MO, TW, VN, TH, MY, ID, PH, KH, MM, LA) → raus; ebenso Domains wie `.cn` |
| Rückgabe | Widerrufsbelehrung nötig, Frist ≥ 14 Tage, keine Wiedereinlagerungsgebühr, keine Rücksendung nach Fernost |
| Rücksendekosten | > 20 % des Artikelpreises → Angebot raus |
| Domain-Alter | < 1 Jahr → raus (sofern die Registry das Alter per RDAP verrät) |
| Fake-Preis | Preis < 55 % des Marktpreises anderer Shops → „Fake-Shop-Verdacht“ |

**Positivliste:** Große Händler wie Amazon, MediaMarkt oder Otto haben auf Trustpilot oft schlechte Werte, obwohl sie seriös sind. Für diese Händler gilt daher die Trustpilot-Schwelle nicht. Fernost-Sitz und Sperrliste gelten trotzdem. Die Liste lässt sich in den Einstellungen bearbeiten oder leeren.

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

- **Websuche:** DuckDuckGo (ohne Schlüssel). Optional die Brave Search API mit kostenlosem Kontingent (Secret `BRAVE_API_KEY`), das liefert verlässlichere Ergebnisse.
- **Preise:** werden aus den schema.org-Produktdaten der Shopseite gelesen (wie bei Google Shopping), ersatzweise aus Meta-Tags bzw. dem Seitentext.
- **Free-Tarif-Grenzen:** 50 Abrufe pro Worker-Lauf. Der Cron arbeitet deshalb in Portionen; bei vielen Produkten dauert ein kompletter Durchlauf mehrere Läufe.

## Einrichtung (einmalig, ca. 20 Minuten)

### 1. Cloudflare (kostenloses Konto)
```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create DB     # → ausgegebene "id" notieren
npm run vapid                           # → VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY notieren
npm run token                           # → Zugangsschlüssel (APP_TOKEN) notieren
```
Außerdem im Cloudflare-Dashboard einen **API-Token** mit der Vorlage „Edit Cloudflare Workers“ erstellen und die **Account-ID** notieren.

### 2. GitHub-Repository einstellen
*Settings → Secrets and variables → Actions*

| Typ | Name | Wert |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | API-Token aus Schritt 1 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Account-ID |
| Secret | `APP_TOKEN` | Zugangsschlüssel |
| Secret | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | aus `npm run vapid` |
| Secret | `VAPID_SUBJECT` | URL der App, z. B. `https://<user>.github.io/Cheap-Smile/` |
| Variable | `KV_NAMESPACE_ID` | KV-ID aus Schritt 1 |
| Variable | `API_BASE` | Worker-URL, z. B. `https://cheap-smile-api.<subdomain>.workers.dev` (nach dem ersten Deployment bekannt) |
| Variable | `ALLOWED_ORIGIN` | optional, z. B. `https://<user>.github.io` |

*Settings → Pages → Source: „GitHub Actions“.* Hinweis: Mit dem kostenlosen GitHub-Tarif funktioniert Pages nur bei **öffentlichen** Repositories. Der App-Code ist dann öffentlich; deine Daten und Schlüssel liegen nicht im Code, sondern im Worker bzw. auf deinem Gerät.

Nach einem Push auf `main` veröffentlichen die beiden Workflows automatisch App und API.

Optional bessere Suche: `npx wrangler secret put BRAVE_API_KEY`

### 3. iPhone
1. Die Pages-URL in **Safari** öffnen → Teilen → **„Zum Home-Bildschirm“**
2. App vom Home-Bildschirm öffnen → Einstellungen: API-Adresse + Zugangsschlüssel eintragen
3. **Push aktivieren** → „Test senden“ (Voraussetzung: iOS 16.4 oder neuer)

## Entwicklung
```bash
cd worker && npm test     # 27 Tests: Preis-Extraktion, Shop-Prüfung, Push-Verschlüsselung, Ende-zu-Ende
npx wrangler dev          # API lokal
```

## Grenzen & ehrliche Hinweise
- **Trustpilot** bietet keine kostenlose API. Gelesen wird deshalb die öffentliche Profilseite, und zwar höchstens einmal pro Shop alle 30 Tage. Ob die Nutzungsbedingungen von Trustpilot das erlauben, solltest du selbst prüfen. Ist Trustpilot nicht erreichbar, wird der Shop vorsichtshalber ausgeschlossen und nach 6 Stunden erneut geprüft.
- **Große Shops** (z. B. Amazon) blockieren automatisierte Abrufe teilweise. Solche Angebote erscheinen dann seltener. Abhilfe: das Produkt direkt per **Link** anlegen.
- **Gutscheincodes** stammen nur von der Shopseite selbst. Ob ein Code gültig ist, kann die App nicht garantieren.
- Impressum und Rückgabe werden **automatisch nach Mustern** geprüft. Das ist ein starker Filter, aber keine juristische Prüfung.
