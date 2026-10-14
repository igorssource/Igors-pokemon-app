# Pokémon-Kartensammlung (Max & Tim)

Web-App für Android-Handys (Phase 1 aus dem Anforderungsdokument): Karten per Foto erfassen,
Sammlung als Bildergalerie ansehen und den Marktpreis auf Knopfdruck abrufen.
Die App läuft im Chrome-Browser und lässt sich wie eine normale App auf den Startbildschirm legen.

## Was die App kann

- **Zwei Sammlungen:** oben zwischen **Max** und **Tim** umschalten.
- **Karten scannen:** Foto direkt in der App aufnehmen (oder aus der Galerie), dann *1 Karte*, *4 Karten* (2×2) oder
  *9 Karten* (3×3 Album-Seite) wählen und mit den gelben Ecken den Rahmen um die Karten legen.
  Die App schneidet jede Karte einzeln aus und liest per Texterkennung die **Kartennummer**
  (z. B. `025/165`), das **Set-Kürzel** (z. B. `MEW`) und den Namen.
- **Suche über die Nummer:** Die Nummer ist in jeder Sprache gleich, deshalb wird primär damit
  in der [Pokémon TCG API](https://pokemontcg.io) gesucht; der Name dient nur zur Sortierung.
  Kommen mehrere Karten in Frage, tippt man einfach das richtige Bild an.
- **Bereits vorhanden:** Doppelte Karten werden markiert („Karte bereits vorhanden“) und nur auf
  Wunsch als weiteres Exemplar (+1) gezählt.
- **Von Hand:** Klappt die Erkennung nicht, kann man die Nummer direkt im Ergebnis oder unter
  *Von Hand* eintippen.
- **Preis anzeigen:** In der Kartenansicht lädt der Knopf den aktuellen Cardmarket-Trendpreis (€)
  und den TCGplayer-Preis ($). Preise werden nie automatisch geladen.
- **Offline-Hinweis:** Ohne Internet erscheint oben ein gelber Hinweis. Ist nur die Kartendatenbank
  langsam oder überlastet, versucht die App es automatisch mehrmals und sagt das auch so.
- **Nichts geht verloren:** Lädt Android den Tab mitten im Scan neu, sind Foto und Ergebnisse danach wieder da.
- **Sicherung:** Unter ⚙️ lässt sich die Sammlung als Datei speichern und wieder laden.

## Auf das Handy bringen

Die App besteht nur aus statischen Dateien (kein Server-Code). Sie muss über **https** erreichbar
sein, damit Kamera und Installation funktionieren. Zwei einfache Wege:

1. **Netlify Drop** (ohne Konto möglich): <https://app.netlify.com/drop> öffnen und den ganzen Ordner
   `pokemon-tracker-app` hineinziehen. Man bekommt sofort eine https-Adresse.
2. **GitHub Pages:** Ordnerinhalt in ein GitHub-Repository legen, unter *Settings → Pages* den
   Branch auswählen.

Dann auf dem Android-Handy die Adresse in **Chrome** öffnen → Menü ⋮ → **„Zum Startbildschirm
hinzufügen“ / „App installieren“**. Danach startet sie wie eine normale App.

Zum Ausprobieren am Computer: im Ordner `npx serve .` (oder `python3 -m http.server`) starten und
`http://localhost:3000` (bzw. `:8000`) öffnen.

## Gut zu wissen

- **Daten:** Es gibt keine lokale Kartendatenbank. Kartendaten, Bilder und Preise kommen immer
  online aus der Pokémon TCG API. Auf dem Handy gespeichert wird nur, *welche* Karten jedes Kind
  besitzt (im Browser-Speicher). Deshalb ab und zu eine Sicherung machen.
- **API-Schlüssel:** Ohne Schlüssel gilt ein kleineres Tageslimit. Ein kostenloser Schlüssel von
  <https://dev.pokemontcg.io> kann unter ⚙️ eingetragen werden.
- **Japanische Karten:** Die Pokémon TCG API enthält nur englische Sets. Deutsche, italienische usw.
  Karten passen über die Nummer; japanische Karten haben oft eigene Nummern und landen dann meist
  bei der manuellen Auswahl.
- **Gute Fotos:** hell, ohne Spiegelung auf den Hüllen, Rahmen eng um die Karten ziehen.
  Die Texterkennung (Tesseract) läuft direkt auf dem Handy; der erste Scan lädt sie einmalig
  (ca. 6 MB).

## Aufbau des Codes

| Datei | Inhalt |
|---|---|
| `index.html`, `styles.css` | Oberfläche (deutsch, große Knöpfe) |
| `js/app.js` | Bildschirme, Scan-Ablauf, Galerie, Kartenansicht |
| `js/scanner.js` | Foto laden, Raster zuschneiden, Texterkennung, Nummer/Name aus dem Text lesen |
| `js/api.js` | Suche und Preise über die Pokémon TCG API |
| `js/store.js` | Sammlungen pro Kind, Sicherung |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installierbarkeit (PWA) |
| `vendor/tesseract/` | Texterkennung Tesseract.js 5.1.1 (Apache-2.0), lokal eingebunden |

## Nächste Schritte (spätere Phasen)

- Deck-Aufbau, fehlende Karten eines Sets, Gesamtwert der Sammlung.
- Optional eine echte APK für den Play Store: die Web-App lässt sich z. B. mit
  [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) oder Capacitor verpacken.
