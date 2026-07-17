# Startpage Transport Proxy SRS

## Ziel

Der bestehende Node.js-Proxy soll die Nahverkehrsdaten fuer die Julianverse-News-Startpage stabiler, genauer und display-tauglicher liefern. Die Frontend-App soll keine HAFAS-/GTFS-/TRIAS-Sonderlogik kennen muessen, sondern einfache, robuste JSON-Endpunkte nutzen.

## Ausgangslage

Aktueller Proxy:

- Base: `https://api-startpage.julianverse.de`
- Prefix: `/api`
- Bestehende Endpunkte:
  - `GET /api/locations?query=Berlin&results=8&stops=true&addresses=false&poi=false`
  - `GET /api/stops/:id/departures`
  - `GET /api/stations/:id/departures`
  - `GET /api/rss?url=<feed-url>`

Die Startpage nutzt aktuell:

- Vorschlaege in den Einstellungen ueber `/api/locations`
- Abfahrten ueber `/api/stops/:id/departures`
- Fallback auf `/api/stations/:id/departures`

Problem:

- `v6.db.transport.rest` / HAFAS ist bequem, aber bei lokalen Haltestellen wie Hannover/UESTRA teils unzuverlaessig.
- Haltestellen werden uneinheitlich als `stop`, `station` oder anderes Location-Objekt geliefert.
- IDs funktionieren nicht immer konsistent fuer Departures.
- Mehrere reale Haltestellen koennen denselben oder sehr aehnliche Namen haben.
- Rate-Limits oder Upstream-Fehler fuehren direkt zu leeren/kaputten Anzeigen.

## Zielbild

Der Proxy soll fuer die Startpage einen neuen, hoeherwertigen Transport-Endpunkt bereitstellen:

```http
GET /api/departures?query=Kroepcke&limit=6
```

Optional:

```http
GET /api/departures?stopId=<canonical-stop-id>&limit=6
GET /api/departures?query=Koenigsberger%20Ring%2C%20Hannover&limit=6
```

Antwort:

```json
{
  "ok": true,
  "source": "gtfs-rt",
  "fallback": false,
  "stop": {
    "id": "string",
    "name": "Kroepcke",
    "locality": "Hannover",
    "lat": 52.0,
    "lon": 9.0
  },
  "updatedAt": "2026-05-13T15:00:00.000Z",
  "departures": [
    {
      "line": "5",
      "product": "STB",
      "direction": "Stoecken",
      "plannedWhen": "2026-05-13T15:04:00.000Z",
      "when": "2026-05-13T15:06:00.000Z",
      "delaySeconds": 120,
      "platform": "2",
      "cancelled": false,
      "status": "+2 min"
    }
  ],
  "diagnostics": {
    "candidateCount": 4,
    "provider": "vbn-gtfs-rt",
    "cache": "fresh"
  }
}
```

Bei Fehlern soll der Proxy, wenn moeglich, die letzte gute Antwort liefern:

```json
{
  "ok": true,
  "source": "cache",
  "fallback": true,
  "stale": true,
  "updatedAt": "2026-05-13T14:58:00.000Z",
  "departures": []
}
```

Nur wenn gar keine Daten vorhanden sind:

```json
{
  "ok": false,
  "error": "NO_DEPARTURES_AVAILABLE",
  "message": "Keine Live-Abfahrten verfuegbar."
}
```

## Datenquellen

### Primaer: GTFS / GTFS-Realtime

Bevorzugte Datenquellen:

- VBN / Connect OpenData fuer Bremen und Niedersachsen
- Alternativ oder ergaenzend: `gtfs.de` deutschlandweiter GTFS-RT Stream

Anforderung:

- Static GTFS fuer Stops, Routes, Trips, StopTimes cachen.
- GTFS-Realtime TripUpdates einlesen.
- Abfahrten pro Stop aus Static GTFS und Realtime-Prognosen zusammenfuehren.
- Daten regelmaessig im Proxy aktualisieren, nicht pro Frontend-Request teuer neu laden.

### Fallback: transport.rest

`v6.db.transport.rest` soll als Fallback erhalten bleiben.

Fallback-Strategie:

1. Erst neue GTFS/GTFS-RT Pipeline probieren.
2. Wenn keine brauchbaren Daten gefunden werden: transport.rest Locations nutzen.
3. Fuer mehrere Kandidaten parallel `stops/:id/departures` und `stations/:id/departures` testen.
4. Beste Antwort nach Qualitaet waehlen.
5. Letzte gute Antwort cachen.

## Haltestellensuche

Neuer Endpoint:

```http
GET /api/transport/locations?query=Kroepcke&limit=8
```

Antwort:

```json
{
  "ok": true,
  "locations": [
    {
      "id": "canonical-id",
      "name": "Kroepcke",
      "locality": "Hannover",
      "type": "stop",
      "lat": 52.0,
      "lon": 9.0,
      "providerIds": {
        "gtfs": "string",
        "transportRest": "string"
      },
      "score": 0.98
    }
  ]
}
```

Anforderungen:

- Query normalisieren: Umlaute, Gross-/Kleinschreibung, Leerzeichen, Bindestriche.
- Kandidaten deduplizieren.
- Kandidaten mit Ort bevorzugen, wenn Query Ort enthaelt.
- Hannover/UESTRA-Haltestellen muessen sauber auffindbar sein.
- Ausgabe soll eine stabile `canonical-id` enthalten, die die Startpage speichern kann.

## Departure-Auswahl

Der Proxy soll fuer eine Query nicht blind den ersten Kandidaten nehmen.

Bewertung:

- Kandidat hat aktuelle Abfahrten: hoher Score.
- Kandidat hat Realtime-Prognosen: hoher Score.
- Kandidat hat nur leere Antwort: niedriger Score.
- Kandidat liegt im erwarteten Ort: hoher Score.
- Kandidat passt exakt auf Namen: hoher Score.
- Fehlerhafte Provider-Antwort: ignorieren, nicht direkt Request failen.

Sortierung der Abfahrten:

- Cancelled Departures ausblenden oder deutlich markieren.
- Nach effektiver Zeit `when || plannedWhen` sortieren.
- Nur zukuenftige Abfahrten anzeigen.
- Default `limit=6`.

## Caching

Bestehende Cache-Ziele:

- `/api/locations`: 30 Sekunden
- Departures: 8 Sekunden
- RSS: 5 Minuten

Neue Anforderungen:

- GTFS Static Cache: langfristig, mit regelmaessigem Refresh.
- GTFS-RT Cache: 10 bis 60 Sekunden, je nach Quelle.
- Departures pro Stop/Query: 8 bis 15 Sekunden.
- Letzte gute Departure-Antwort pro Stop/Query: mindestens 15 Minuten halten.

Wenn Live-Daten fehlschlagen:

- Letzte gute Antwort mit `stale: true` zurueckgeben.
- Keine Dummy-Abfahrten generieren.
- Diagnostics mitsenden.

## Timeouts und Robustheit

- Upstream-Timeout: maximal 10 Sekunden, besser 3 bis 5 Sekunden pro Quelle.
- In-flight Request Deduplication beibehalten.
- Parallelisierung:
  - Mehrere Kandidaten parallel testen.
  - `stops` und `stations` bei transport.rest parallel testen.
- Einzelne Provider-Fehler duerfen nicht den gesamten Request killen, solange eine andere Quelle Daten liefert.

## Rueckwaertskompatibilitaet

Bestehende Endpunkte sollen vorerst erhalten bleiben:

- `/api/locations`
- `/api/stops/:id/departures`
- `/api/stations/:id/departures`
- `/api/rss`

Die Startpage kann spaeter auf den neuen Endpunkt wechseln:

```http
GET /api/departures?query=<settings.transportStop>&limit=6
```

## Nicht-Ziele

- Kein Routing.
- Keine Ticketpreise.
- Keine komplette Fahrplanauskunft.
- Keine komplexe Frontend-Logik.
- Keine gefakten Dummy-Abfahrten.

## Akzeptanzkriterien

- `GET /api/departures?query=Kroepcke&limit=6` liefert echte aktuelle Abfahrten.
- `GET /api/departures?query=Koenigsberger%20Ring%2C%20Hannover&limit=6` liefert echte aktuelle Abfahrten oder einen sauberen `ok:false` Fehler, aber keine erfundenen Daten.
- Wenn GTFS-RT kurz nicht erreichbar ist, wird die letzte gute Antwort mit `stale:true` geliefert.
- Wenn transport.rest Rate-Limits hat, bleibt der Proxy stabil und nutzt Cache/Fallback.
- Antwortschema bleibt fuer die Startpage stabil.
- CORS bleibt offen:
  - `Access-Control-Allow-Origin: *`
  - `Access-Control-Allow-Headers: *`

## Empfohlene Implementierungsreihenfolge

1. Neuen Endpoint `/api/departures` als Wrapper um bestehendes transport.rest bauen.
2. Candidate-Scoring fuer mehrere Locations implementieren.
3. `stops` und `stations` parallel testen.
4. Letzte gute Antwort pro Query/Stop cachen.
5. GTFS Static Import fuer VBN/gtfs.de einbauen.
6. GTFS-RT Updates einbauen.
7. Provider-Priorisierung: GTFS-RT zuerst, transport.rest als Fallback.
8. Diagnostics ergaenzen.
