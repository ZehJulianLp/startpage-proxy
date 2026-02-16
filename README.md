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

### RSS fetch
`GET /api/rss?url=<feed-url>`

RSS JSON mode:
`GET /api/rss?url=<feed-url>&format=json`

## CORS
All responses include:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: *`

## Timeouts
Upstream requests time out after 10 seconds.

## Caching
- `/api/locations`: 30s
- `/api/stops/:id/departures`: 8s
- `/api/stations/:id/departures`: 8s
- `/api/rss`: 5m

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
