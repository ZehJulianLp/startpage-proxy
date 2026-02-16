const express = require("express");
const { XMLParser } = require("fast-xml-parser");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const UPSTREAM_BASE = "https://v6.db.transport.rest";
const TIMEOUT_MS = 10_000;

const cache = new Map();
const inflight = new Map();

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
});

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  next();
});

app.options("*", (req, res) => {
  res.status(204).end();
});

function nowMs() {
  return Date.now();
}

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= nowMs()) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function setCache(key, entry) {
  cache.set(key, entry);
}

function isPrivateIp(ip) {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true;
  if (ip.startsWith("172.")) {
    const second = Number(ip.split(".")[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("100.")) {
    const second = Number(ip.split(".")[1]);
    if (second >= 64 && second <= 127) return true;
  }
  return false;
}

function isBlockedHost(hostname) {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower.endsWith(".local") || lower.endsWith(".internal")) return true;
  const ipv4Match = lower.match(/^\d{1,3}(\.\d{1,3}){3}$/);
  if (ipv4Match && isPrivateIp(lower)) return true;
  return false;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function proxyRequest(upstreamUrl, cacheSeconds) {
  const cacheKey = upstreamUrl;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  if (inflight.has(cacheKey)) {
    return inflight.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const response = await fetchWithTimeout(upstreamUrl);
      const body = Buffer.from(await response.arrayBuffer());
      const entry = {
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") || "application/json",
        },
        body,
        expiresAt: nowMs() + cacheSeconds * 1000,
      };
      setCache(cacheKey, entry);
      return entry;
    } catch (err) {
      if (err.name === "AbortError") {
        return {
          status: 504,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ error: "Upstream timeout" })),
          expiresAt: nowMs() + cacheSeconds * 1000,
        };
      }
      return {
        status: 502,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ error: "Upstream error" })),
        expiresAt: nowMs() + cacheSeconds * 1000,
      };
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, promise);
  return promise;
}

function sendEntry(res, entry) {
  res.status(entry.status);
  if (entry.headers && entry.headers["content-type"]) {
    res.set("Content-Type", entry.headers["content-type"]);
  }
  res.send(entry.body);
}

app.get("/api/locations", async (req, res) => {
  const upstreamUrl = `${UPSTREAM_BASE}/locations?${new URLSearchParams(req.query)}`;
  const entry = await proxyRequest(upstreamUrl, 30);
  sendEntry(res, entry);
});

app.get("/api/stops/:id/departures", async (req, res) => {
  const upstreamUrl = `${UPSTREAM_BASE}/stops/${encodeURIComponent(
    req.params.id
  )}/departures?${new URLSearchParams(req.query)}`;
  const entry = await proxyRequest(upstreamUrl, 8);
  sendEntry(res, entry);
});

app.get("/api/stations/:id/departures", async (req, res) => {
  const upstreamUrl = `${UPSTREAM_BASE}/stations/${encodeURIComponent(
    req.params.id
  )}/departures?${new URLSearchParams(req.query)}`;
  const entry = await proxyRequest(upstreamUrl, 8);
  sendEntry(res, entry);
});

app.get("/api/rss", async (req, res) => {
  const feedUrl = req.query.url;
  const format = req.query.format;
  if (!feedUrl || typeof feedUrl !== "string") {
    res.status(400).json({ error: "Missing url parameter" });
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(feedUrl);
  } catch {
    res.status(400).json({ error: "Invalid url parameter" });
    return;
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    res.status(400).json({ error: "Invalid url protocol" });
    return;
  }

  if (isBlockedHost(parsedUrl.hostname)) {
    res.status(400).json({ error: "Blocked url host" });
    return;
  }

  const upstreamUrl = parsedUrl.toString();
  const cacheKey = `${upstreamUrl}|format=${format || "xml"}`;
  const cached = getCache(cacheKey);
  if (cached) {
    sendEntry(res, cached);
    return;
  }

  if (inflight.has(cacheKey)) {
    const entry = await inflight.get(cacheKey);
    sendEntry(res, entry);
    return;
  }

  const promise = (async () => {
    try {
      const response = await fetchWithTimeout(upstreamUrl);
      const body = Buffer.from(await response.arrayBuffer());
      if (format === "json") {
        const xml = body.toString("utf8");
        const data = parser.parse(xml);
        const feed = data.rss?.channel || data.feed || {};
        const items = feed.item || feed.entry || [];
        const normalized = Array.isArray(items) ? items : [items];
        const jsonBody = {
          title: feed.title?.["#text"] || feed.title || "",
          items: normalized
            .filter(Boolean)
            .map((item) => ({
              title: item.title?.["#text"] || item.title || "",
              link:
                item.link?.href ||
                item.link?.["#text"] ||
                item.link ||
                "",
              published:
                item.pubDate ||
                item.published ||
                item.updated ||
                "",
              summary:
                item.description ||
                item.summary?.["#text"] ||
                item.summary ||
                "",
            })),
        };
        const entry = {
          status: response.status,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(jsonBody)),
          expiresAt: nowMs() + 300 * 1000,
        };
        setCache(cacheKey, entry);
        return entry;
      }

      const entry = {
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") || "application/xml",
        },
        body,
        expiresAt: nowMs() + 300 * 1000,
      };
      setCache(cacheKey, entry);
      return entry;
    } catch (err) {
      if (err.name === "AbortError") {
        return {
          status: 504,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ error: "Upstream timeout" })),
          expiresAt: nowMs() + 300 * 1000,
        };
      }
      return {
        status: 502,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ error: "Upstream error" })),
        expiresAt: nowMs() + 300 * 1000,
      };
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, promise);
  const entry = await promise;
  sendEntry(res, entry);
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`Proxy listening on port ${PORT}`);
});
