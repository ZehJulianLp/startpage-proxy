# Startpage Transport & RSS Proxy

Lightweight Node.js proxy for transport.rest and RSS feeds with CORS, caching,
timeouts, and in-flight request deduplication.

## Requirements
- Node.js 18+
- npm
- `screen` (optional, for the start helper)

## Install
```sh
npm install
```

## Run (manual)
```sh
npm start
```

The server listens on port `56669` by default (set in `package.json`).

## Run in screen
```sh
./start-screen.sh
screen -r startpage-proxy
```

## Autostart (systemd user service)
```sh
systemctl --user daemon-reload
systemctl --user enable --now startpage-proxy.service
```

Enable lingering to start at boot without login:
```sh
sudo loginctl enable-linger srvmgr
```

## Endpoints
Base prefix: `/api`

### Locations
`GET /api/locations?query=Berlin&results=8&stops=true&addresses=false&poi=false`

### Stop departures
`GET /api/stops/:id/departures`

### Station departures
`GET /api/stations/:id/departures`

### Smart departures
`GET /api/departures?query=Kroepcke&limit=6`

Direct GTFS-RT stop IDs can skip the transport.rest fallback:
`GET /api/departures?stopId=gtfs:000009028694&limit=6`

The endpoint returns a stable JSON shape:
```json
{
  "ok": true,
  "source": "gtfs-rt",
  "fallback": false,
  "stop": { "id": "gtfs:000009028694", "name": "000009028694" },
  "updatedAt": "2026-05-13T15:00:00.000Z",
  "departures": [],
  "diagnostics": { "provider": "vbn-gtfs-rt", "cache": "fresh" }
}
```

If no live data is available, the endpoint returns a structured `ok:false`
response. If a recent good response exists, it returns that response with
`source: "cache"` and `stale: true`.

### Transport locations
`GET /api/transport/locations?query=Kroepcke&limit=8`

Returns deduplicated location candidates with stable IDs and provider IDs.

### RSS fetch
`GET /api/rss?url=<feed-url>`

RSS JSON mode:
`GET /api/rss?url=<feed-url>&format=json`

## CORS
All responses include:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: *`

## Timeouts
General proxy requests time out after 10 seconds. The smart location endpoint
uses a shorter fallback timeout so a slow transport.rest response does not block
otherwise local GTFS matching.

```sh
LOCATION_FALLBACK_TIMEOUT_MS=1200 npm start
```

The location fallback caches successful responses for 30 seconds, empty results
for 10 seconds, and can serve a successful response as stale for another five
minutes when the upstream fails. These durations can be changed with
`LOCATION_FALLBACK_CACHE_MS`, `LOCATION_FALLBACK_NEGATIVE_CACHE_MS`, and
`LOCATION_FALLBACK_STALE_MS`.

## Caching
- `/api/locations`: 30s
- `/api/stops/:id/departures`: 8s
- `/api/stations/:id/departures`: 8s
- `/api/departures`: 10s
- last good `/api/departures` response: 15m
- `/api/rss`: 5m

## GTFS-RT
The smart departures endpoint uses the gtfs.de static and realtime feeds as a
matching pair. VBN GTFS-Realtime and transport.rest remain fallback providers.

Default gtfs.de realtime feed:
`https://realtime.gtfs.de/realtime-free.pb`

Default VBN feed:
`http://gtfsr.vbn.de/gtfsr_connect.json`

Override the feed URL:
```sh
GTFS_DE_REALTIME_URL=https://realtime.gtfs.de/realtime-free.pb npm start
VBN_GTFS_RT_JSON_URL=http://gtfsr.vbn.de/gtfsr_connect.json npm start
```

For query-to-stop matching, the proxy downloads and caches the static GTFS feed,
extracts `stops.txt`, and builds an in-memory stop index.

Default static GTFS feed:
`https://download.gtfs.de/germany/free/latest.zip`

Override the static feed or cache file:
```sh
GTFS_STATIC_URL=https://download.gtfs.de/germany/free/latest.zip npm start
GTFS_STATIC_CACHE_FILE=.cache/gtfs-static.zip npm start
GTFS_HEADSIGN_CACHE_FILE=.cache/gtfs-headsigns.json npm start
GTFS_STATIC_REFRESH_MS=86400000 npm start
```

The static ZIP is refreshed every 24 hours by default and replaced atomically.
If a refresh fails, the last local ZIP remains available as stale fallback.
Headsigns are cached persistently with the matching static-feed version. The
API only waits briefly for missing headsigns so live responses stay fast while
the background cache is being built.

Run checks:
```sh
npm test
npm run check
```

Configure query aliases for known GTFS stop IDs:
```sh
TRANSPORT_STOP_ALIASES='{"kroepcke":["000009028694"]}' npm start
```

## Reverse proxy (Nginx)
Use TLS termination in Nginx and proxy to `localhost:56669`.

Example:
```nginx
location / {
    proxy_pass http://localhost:56669/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
}
```
