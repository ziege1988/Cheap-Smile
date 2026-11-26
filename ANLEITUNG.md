# 📱 Cheap Smile einrichten – Schritt für Schritt

**Dauer:** ca. 30 Minuten, einmalig. **Am besten am Computer** (Schritte 1–7), zum Schluss am iPhone (Schritt 8).
**Kosten:** keine. Alle Dienste werden im kostenlosen Tarif genutzt.

Du brauchst:
- dein GitHub-Konto (hast du schon)
- ein **Cloudflare**-Konto (kostenlos, legen wir an), dort läuft der „Preis-Wächter“
- ein **SerpApi**-Konto (kostenlos, empfohlen), damit wird über **Google** gesucht
- ein iPhone mit **iOS 16.4 oder neuer** (Einstellungen → Allgemein → Info → iOS-Version)

> 💡 Leg dir eine Notiz an (z. B. in der Notizen-App). Dort trägst du unterwegs **4 Werte** ein: Account-ID, API-Token, SerpApi-Schlüssel und dein App-Passwort.

---

## Schritt 1 – Cloudflare-Konto anlegen

1. Öffne **https://dash.cloudflare.com/sign-up**
2. E-Mail-Adresse und Passwort eingeben → **Sign up**
3. Bestätigungs-E-Mail öffnen und auf den Link klicken.
4. Im Cloudflare-Dashboard links im Menü auf **„Workers & Pages“** klicken (je nach Ansicht unter „Compute“ bzw. „Build“).
   - Fragt Cloudflare nach einer **„workers.dev subdomain“**, gib einen beliebigen Namen ein (z. B. `ziege`) und bestätige.
5. **Account-ID kopieren:** Auf derselben Seite steht rechts **„Account ID“**. Daneben auf *Kopieren* klicken und in deine Notiz einfügen.
   *(Alternativ steht sie in der Adresszeile: `dash.cloudflare.com/`**`diese-lange-Zeichenfolge`**`/…`)*

## Schritt 2 – Cloudflare-API-Token erstellen

Damit darf GitHub den Preis-Wächter automatisch bei Cloudflare installieren.

1. Oben rechts auf das **Personen-Symbol** → **„My Profile“ / „Profil“**
2. Links **„API Tokens“** → Button **„Create Token“**
3. Bei der Vorlage **„Edit Cloudflare Workers“** auf **„Use template“** klicken.
4. Unten bei
   - **Account Resources:** `Include` → dein Konto auswählen
   - **Zone Resources:** `Include` → `All zones`
5. **„Continue to summary“** → **„Create Token“**
6. Den angezeigten Token **sofort kopieren** und in die Notiz einfügen. ⚠️ Er wird nur ein einziges Mal angezeigt.

## Schritt 3 – SerpApi-Konto (Google-Suche) – empfohlen

Ohne diesen Schritt funktioniert die App auch, sucht dann aber nur über DuckDuckGo (weniger zuverlässig).

1. Öffne **https://serpapi.com/users/sign_up** und registriere dich (E-Mail bestätigen; ggf. wird eine Telefonnummer zur Verifizierung verlangt).
2. Wähle den **Free Plan** (250 Suchen pro Monat, keine Kreditkarte).
3. Im Dashboard (**https://serpapi.com/manage-api-key**) steht **„Your Private API Key“** → kopieren → in die Notiz.

> Die App teilt sich die 250 Suchen automatisch übers Monat ein. Sind sie aufgebraucht, sucht sie über DuckDuckGo weiter. Die Preise selbst werden unabhängig davon alle paar Stunden direkt beim Shop geprüft und verbrauchen **keine** Suchen.

## Schritt 4 – App-Passwort ausdenken

Das ist dein persönlicher Schlüssel. Nur wer ihn kennt, kann deine Produktliste sehen.

- Mindestens **20 Zeichen**, nur Buchstaben und Zahlen, z. B. `Smile2026GuenstigKaufenXy7q`
- In die Notiz schreiben. Du brauchst es gleich bei GitHub **und** später auf dem iPhone.

## Schritt 5 – Werte bei GitHub hinterlegen

1. Öffne **https://github.com/ziege1988/Cheap-Smile**
2. Oben auf **„Settings“** (Zahnrad-Reiter ganz rechts)
3. Links **„Secrets and variables“** → **„Actions“**
4. Grüner Button **„New repository secret“**. Lege nacheinander diese **4 Einträge** an.
   Den **Namen exakt so** schreiben (Großbuchstaben, Unterstrich). Nach jedem Eintrag auf **„Add secret“** klicken.

| Name | Wert (Secret) |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Account-ID aus Schritt 1 |
| `CLOUDFLARE_API_TOKEN` | API-Token aus Schritt 2 |
| `SERPAPI_KEY` | SerpApi-Schlüssel aus Schritt 3 (optional) |
| `APP_TOKEN` | dein App-Passwort aus Schritt 4 |

## Schritt 6 – GitHub Pages einschalten (das ist die iPhone-App)

1. Wieder **Settings** → links **„Pages“**
2. Unter **„Build and deployment“ → „Source“** auswählen: **„GitHub Actions“**
3. Fertig, es gibt keinen Speichern-Knopf.

## Schritt 7 – Standard-Zweig festlegen und veröffentlichen

1. Im Repository **Settings** → **General** → Abschnitt **„Default branch“**
2. Auf das Pfeil-Symbol ⇄ tippen → **`main`** auswählen → **„Update“** → **„I understand, update the default branch“**
   *(Ohne diesen Schritt verweigert GitHub Pages die Veröffentlichung.)*
3. Oben auf den Reiter **„Actions“**
4. Links **„API veröffentlichen (Cloudflare Worker)“** → rechts **„Run workflow“** → Branch `main` → grüner Button **„Run workflow“**
5. Links **„App veröffentlichen (GitHub Pages)“** → ebenso **„Run workflow“**
6. Warten, bis beide einen **grünen Haken ✅** haben (gelber Kreis = läuft, ca. 1–3 Minuten).
7. Auf den Lauf **„API veröffentlichen …“** tippen. In der Zusammenfassung steht
   **„API-Adresse für die App: `https://cheap-smile-api.xxxx.workers.dev`“** → in die Notiz kopieren.
8. Die **App-Adresse** lautet: **https://ziege1988.github.io/Cheap-Smile/**

> Spätere Änderungen werden automatisch veröffentlicht, sobald sie auf `main` landen. Die App auf dem iPhone aktualisiert sich dann beim nächsten Öffnen.

## Schritt 8 – Auf dem iPhone installieren

1. Öffne **Safari** (wichtig: nicht Chrome) und rufe **https://ziege1988.github.io/Cheap-Smile/** auf.
2. Unten auf das **Teilen-Symbol** (Quadrat mit Pfeil nach oben) tippen.
3. Runterscrollen → **„Zum Home-Bildschirm“** → **„Hinzufügen“**
4. Safari schließen und **Cheap Smile über das neue Symbol auf dem Home-Bildschirm öffnen.**
5. Oben auf **„Einrichten“** tippen (oder ⚙️):
   - **API-Adresse:** die `https://cheap-smile-api…workers.dev`-Adresse aus Schritt 7
   - **Zugangsschlüssel:** dein App-Passwort aus Schritt 4
   - **Speichern**
6. ⚙️ erneut öffnen → **„Push aktivieren“** → bei der iPhone-Abfrage **„Erlauben“**
7. **„Test senden“** → nach wenigen Sekunden kommt eine Mitteilung „Push funktioniert!“ 🎉

## Schritt 9 – Benutzen

- **＋** unten rechts → Produktname (z. B. `Sony WH-1000XM5`) **oder** einen Link zum Produkt einfügen
- optional **Wunschpreis** (inkl. Versand) eintragen
- **„Gebrauchte Artikel erlauben“** an/aus
- **„Hinzufügen & suchen“** → nach 1–2 Minuten erscheinen die Angebote

In der Kachel:
- **Gebraucht**-Schalter: jederzeit umschalten
- **Code kopieren**: Gutscheincode in die Zwischenablage
- **Zum Shop**: öffnet das günstigste seriöse Angebot
- **Papierkorb**: Produkt **und** zugehörigen Preisalarm löschen
- **Kachel antippen**: alle Angebote, Preisverlauf, **ausgeschlossene Shops mit Begründung**

**Updates:** Neue Versionen installieren sich automatisch beim nächsten Öffnen der App. Du musst nichts tun.

---

## Schritt 10 (optional) – Wächter bei cron-job.org

cron-job.org prüft alle 30 Minuten, ob dein Preis-Wächter erreichbar ist, und schickt dir eine E-Mail, falls nicht. Kostenlos, ein Konto bei cron-job.org genügt.

1. Bei **https://cron-job.org** anmelden → **„Cronjob erstellen“**
2. **Titel:** `Cheap Smile Wächter`
3. **Adresse (URL)** – genau so, ohne Platzhalter:
   ```
   https://cheap-smile-api.ziege-machmaeh.workers.dev/api/health
   ```
4. **Zeitplan:** alle 30 Minuten
5. **Benachrichtigungen:** „bei Fehlschlag“ aktivieren
6. **Speichern**

**Kontrolle:** Die Adresse aus Punkt 3 in Safari öffnen – es muss `{"ok":true,…}` erscheinen. In cron-job.org zeigt der Verlauf („Verlauf“/„History“) nach dem ersten Lauf **„200 OK“**.

> Die Adresse verrät nur „ok“ und die Uhrzeit – deine Produkte und dein Passwort bleiben geschützt.

## Wenn etwas nicht klappt

| Problem | Lösung |
|---|---|
| Rotes ❌ bei „API veröffentlichen“ | Den Lauf anklicken und die rote Meldung lesen. Meist ist ein Secret falsch geschrieben oder fehlt (Schritt 5). Danach im Lauf oben rechts auf **„Re-run all jobs“** klicken. |
| „KV-Speicher konnte nicht angelegt werden“ | Der API-Token hat zu wenig Rechte. Lege ihn neu mit der Vorlage **„Edit Cloudflare Workers“** an (Schritt 2) und ersetze das Secret. |
| Rotes ❌ bei „App veröffentlichen“ | Schritt 6 prüfen (Source = GitHub Actions), dann **„Re-run all jobs“**. |
| „App veröffentlichen“ bricht sofort ab (ohne Protokoll) | **Settings → Environments → github-pages → Deployment branches**: Regel **`main`** hinzufügen. |
| cron-job.org meldet „404 Not Found“ und deaktiviert den Job | Adresse im Cron-Job prüfen (Schritt 10, Punkt 3) – kein Platzhalter wie „xxxx“, danach Job wieder aktivieren. |
| „workers.dev subdomain“-Fehler | Bei Cloudflare unter **Workers & Pages** einmalig eine Subdomain festlegen (Schritt 1.4). |
| App meldet „Nicht autorisiert“ | Das Passwort in der App stimmt nicht mit `APP_TOKEN` überein. Groß-/Kleinschreibung beachten. |
| „Push aktivieren“ geht nicht | Die App muss vom **Home-Bildschirm** geöffnet sein, nicht in Safari. Außerdem iOS 16.4+ und iPhone-Einstellungen → Mitteilungen → Cheap Smile → Erlauben. |
| Keine Angebote gefunden | Kachel antippen → „Ausgeschlossene Shops“ zeigt den Grund. Alternativ das Produkt **per Link** von einem Shop deiner Wahl anlegen. |
| „Google-Kontingent verbraucht“ | Normal gegen Monatsende. Die App sucht dann über DuckDuckGo weiter, Preisprüfungen laufen unverändert. |
