# SRS — Transport & RSS Proxy for Startpage

**Project Name:** Startpage Transport Proxy  
**Purpose:** Provide a reliable, CORS-safe backend proxy for public transport data (transport.rest) and RSS feeds for a personal startpage frontend.

---

## 1. Overview

The system is a lightweight HTTP proxy server that:

1. Forwards requests to https://v6.db.transport.rest  
2. Returns responses with proper CORS headers  
3. Adds basic stability features (caching, request deduplication, timeouts)  
4. Provides an additional endpoint for RSS feed retrieval  

This proxy exists because the upstream APIs sometimes return responses **without CORS headers**, which makes direct browser access unreliable.

---

## 2. Goals

### 2.1 Functional Goals
- Allow frontend to search transport locations  
- Allow frontend to fetch live departures  
- Handle both **stops** and **stations**  
- Filter nothing at proxy level unless specified  
- Provide RSS fetching endpoint  
- Always return responses readable by browsers (CORS)

### 2.2 Non-Functional Goals
- Lightweight and fast  
- No authentication required (private usage assumed)  
- Must tolerate upstream instability (503, timeouts)  
- Must not spam upstream API  

---

## 3. System Architecture

Browser (Startpage)  
↓  
Proxy Server  
↓  
v6.db.transport.rest   +   RSS Sources  

Frontend must only talk to the proxy.

---

## 4. API Endpoints (Proxy)

All endpoints must be prefixed with:

`/api`

---

### 4.1 Location Search

**Endpoint**  
`GET /api/locations`

**Query Parameters (pass through):**

| Param | Example | Required | Description |
|------|---------|----------|-------------|
| query | Kröpcke | yes | Search string |
| results | 8 | no | Max number of results |
| stops | true | no | Forward as-is |
| addresses | false | no | Forward as-is |
| poi | false | no | Forward as-is |

**Upstream**  
`GET https://v6.db.transport.rest/locations`

**Response**
- Forward upstream JSON unchanged  
- Add CORS headers  

---

### 4.2 Stop Departures

**Endpoint**  
`GET /api/stops/:id/departures`

**Upstream**  
`GET https://v6.db.transport.rest/stops/:id/departures`

Query parameters must be forwarded unchanged (duration, results, product filters, etc.).

---

### 4.3 Station Departures

**Endpoint**  
`GET /api/stations/:id/departures`

**Upstream**  
`GET https://v6.db.transport.rest/stations/:id/departures`

**Reason:** Some IDs belong to large DB stations and must use `/stations/` instead of `/stops/`.

---

### 4.4 RSS Fetching

**Endpoint**  
`GET /api/rss?url=<feed-url>`

**Behavior**
- Fetch RSS/Atom feed from given URL  
- Follow redirects  
- Return content with:
  - `Content-Type: application/xml` or `text/xml`
  - `Access-Control-Allow-Origin: *`

**Optional JSON Mode**  
`GET /api/rss?url=<feed-url>&format=json`

Proxy converts RSS → JSON:

```json
{
  "title": "Feed Title",
  "items": [
    { "title": "...", "link": "...", "published": "...", "summary": "..." }
  ]
}
```

---

## 5. CORS Requirements

Every response must include:

Access-Control-Allow-Origin: *  
Access-Control-Allow-Headers: *

This must be true for:
- 200 responses  
- 4xx errors  
- 5xx errors (especially 503)

---

## 6. Error Handling

| Situation | Proxy Behavior |
|----------|----------------|
| Upstream timeout | Return 504 |
| Upstream 503 | Forward 503 body |
| Network error | Return 502 |
| Invalid URL (RSS) | Return 400 |

Errors must still include CORS headers.

---

## 7. Performance & Stability

### 7.1 Request Timeout
Upstream requests must timeout after **10 seconds**.

### 7.2 Micro-Caching

| Endpoint | Cache Time |
|----------|------------|
| /locations | 30 seconds |
| /departures | 5–10 seconds |
| /rss | 5 minutes |

Cache key = full upstream URL including query string.

### 7.3 In-Flight Deduplication

If the same upstream URL is requested while a previous request is still running:
- Do not start another upstream request  
- Await the existing promise and return the same result  

---

## 8. Security Considerations

Since this is for private use:
- No authentication required  

If exposed publicly, RSS endpoint must implement:
- domain allowlist **or**
- API key  

Proxy must **not** allow internal network access via RSS URLs (no `file://`, `localhost`, private IP ranges, etc.).

---

## 9. Non-Goals

The proxy must NOT:
- Modify transport data  
- Apply delay filtering  
- Apply product filtering  
- Store user data  
- Log personal data  

All filtering and UI logic happen in the frontend.

---

## 10. Technology Requirements

Recommended stack:
- Node.js ≥ 18  
- Express  
- Native `fetch` or `node-fetch`  

Server must run on configurable port (default 3000).

---

## 11. Expected Result

After implementation:

✔ Browser never shows CORS errors  
✔ Frontend can read 503 responses  
✔ API load reduced via caching  
✔ transport.rest and RSS usable from browser  
✔ Architecture future-proof for more APIs  