const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const zlib = require("zlib");
const express = require("express");
const { XMLParser } = require("fast-xml-parser");
const { transit_realtime: gtfsRealtime } = require("gtfs-realtime-bindings");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const UPSTREAM_BASE = "https://v6.db.transport.rest";
const VBN_GTFS_RT_JSON_URL = process.env.VBN_GTFS_RT_JSON_URL || "http://gtfsr.vbn.de/gtfsr_connect.json";
const GTFS_DE_REALTIME_URL = process.env.GTFS_DE_REALTIME_URL || "https://realtime.gtfs.de/realtime-free.pb";
const GTFS_STATIC_URL = process.env.GTFS_STATIC_URL || "https://download.gtfs.de/germany/free/latest.zip";
const GTFS_STATIC_CACHE_FILE =
  process.env.GTFS_STATIC_CACHE_FILE || path.join(__dirname, ".cache", "gtfs-static.zip");
const GTFS_HEADSIGN_CACHE_FILE =
  process.env.GTFS_HEADSIGN_CACHE_FILE || path.join(__dirname, ".cache", "gtfs-headsigns.json");
const GTFS_STATIC_REFRESH_MS = Number(process.env.GTFS_STATIC_REFRESH_MS) || 24 * 60 * 60 * 1000;
const GTFS_STATIC_REFRESH_CHECK_MS =
  Number(process.env.GTFS_STATIC_REFRESH_CHECK_MS) || 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const TRANSPORT_TIMEOUT_MS = 5_000;
const VBN_TIMEOUT_MS = 5_000;
const GTFS_DE_REALTIME_TIMEOUT_MS = 20_000;
const GTFS_STATIC_TIMEOUT_MS = 60_000;
const DEPARTURES_CACHE_SECONDS = 10;
const LAST_GOOD_DEPARTURES_SECONDS = 15 * 60;
const TRANSPORT_REST_CANDIDATE_LIMIT = 2;
const HEADSIGN_LOOKUP_BUDGET_MS = 250;
const GTFS_REALTIME_REFRESH_MS = 30_000;
const MAX_DEPARTURES_LIMIT = 100;
const DEPARTURE_CANDIDATE_LIMIT = 40;

const cache = new Map();
const inflight = new Map();
const lastGoodDepartures = new Map();
let gtfsStopIndex = null;
let gtfsStopIndexPromise = null;
let gtfsStaticVersion = null;
let gtfsStaticRefreshPromise = null;
const gtfsTripHeadsigns = new Map();
let gtfsHeadsignCacheLoadedVersion = null;
let gtfsHeadsignBuildPromise = null;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
});

const stopAliases = parseStopAliases(process.env.TRANSPORT_STOP_ALIASES);

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

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
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

async function fetchWithTimeout(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/\s+/g, "");
}

function parseStopAliases(value) {
  if (!value) return new Map();

  try {
    const parsed = JSON.parse(value);
    return new Map(
      Object.entries(parsed).map(([alias, stopIds]) => [
        normalizeSearchText(alias),
        Array.isArray(stopIds) ? stopIds.map(String) : [String(stopIds)],
      ])
    );
  } catch {
    console.warn("Ignoring invalid TRANSPORT_STOP_ALIASES JSON.");
    return new Map();
  }
}

function getAliasStopIds(query) {
  const normalizedQuery = normalizeSearchText(query);
  const compactQuery = compactSearchText(query);
  const matches = [];

  for (const [alias, stopIds] of stopAliases.entries()) {
    const compactAlias = compactSearchText(alias);
    if (
      alias === normalizedQuery ||
      compactAlias === compactQuery ||
      normalizedQuery.includes(alias) ||
      alias.includes(normalizedQuery)
    ) {
      matches.push(...stopIds);
    }
  }

  return [...new Set(matches)];
}

function splitQueryParts(query) {
  return String(query || "")
    .split(",")
    .map((part) => normalizeSearchText(part))
    .filter(Boolean);
}

function getLocationCoordinates(location) {
  const source = location.location || location;
  const lat = source.latitude ?? source.lat;
  const lon = source.longitude ?? source.lon;
  return {
    lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
    lon: Number.isFinite(Number(lon)) ? Number(lon) : null,
  };
}

function distanceMeters(aLat, aLon, bLat, bLon) {
  if (![aLat, aLon, bLat, bLon].every((value) => Number.isFinite(Number(value)))) return null;
  const earthRadius = 6371000;
  const lat1 = (Number(aLat) * Math.PI) / 180;
  const lat2 = (Number(bLat) * Math.PI) / 180;
  const deltaLat = ((Number(bLat) - Number(aLat)) * Math.PI) / 180;
  const deltaLon = ((Number(bLon) - Number(aLon)) * Math.PI) / 180;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const value = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function getLocationLocality(location) {
  const candidates = [
    location.locality,
    location.city,
    location.address,
    location.location?.city,
    location.location?.address,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }

  const name = String(location.name || "");
  if (name.includes(",")) {
    return name.split(",").slice(1).join(",").trim() || "";
  }

  return "";
}

function canonicalLocationId(location) {
  const id = String(location.id || location.extId || location.stationId || "").trim();
  const type = String(location.type || "location").trim() || "location";
  if (!id) return "";
  return `transport-rest:${type}:${id}`;
}

function parseCanonicalStopId(stopId) {
  const raw = String(stopId || "").trim();
  const gtfsMatch = raw.match(/^(gtfs|vbn):(.+)$/);
  if (gtfsMatch) {
    return { id: gtfsMatch[2], type: "gtfs", canonicalId: `gtfs:${gtfsMatch[2]}` };
  }

  const match = raw.match(/^transport-rest:([^:]+):(.+)$/);
  if (!match) {
    return { id: raw, type: "unknown", canonicalId: raw ? `transport-rest:unknown:${raw}` : "" };
  }
  return {
    type: match[1],
    id: match[2],
    canonicalId: raw,
  };
}

function scoreLocation(location, query) {
  const queryParts = splitQueryParts(query);
  const normalizedQuery = normalizeSearchText(query);
  const compactQuery = compactSearchText(query);
  const normalizedName = normalizeSearchText(location.name);
  const compactName = compactSearchText(location.name);
  const locality = normalizeSearchText(getLocationLocality(location));
  let score = 0.2;

  if (normalizedName === normalizedQuery || compactName === compactQuery) score += 0.55;
  else if (normalizedName.startsWith(normalizedQuery) || compactName.startsWith(compactQuery)) score += 0.4;
  else if (normalizedName.includes(normalizedQuery) || compactName.includes(compactQuery)) score += 0.25;

  for (const part of queryParts) {
    if (part && locality && locality.includes(part)) score += 0.15;
  }

  if (location.type === "stop" || location.type === "station") score += 0.15;
  if (location.products && Object.values(location.products).some(Boolean)) score += 0.05;
  if (String(location.name || "").toLowerCase().includes("hannover")) score += 0.05;

  return Math.min(score, 1);
}

function normalizeLocation(location, query) {
  const canonicalId = canonicalLocationId(location);
  const { lat, lon } = getLocationCoordinates(location);
  const providerId = String(location.id || location.extId || location.stationId || "");

  return {
    id: canonicalId,
    name: location.name || "",
    locality: getLocationLocality(location),
    type: location.type || "location",
    lat,
    lon,
    providerIds: {
      gtfs: null,
      transportRest: providerId || null,
    },
    score: Number(scoreLocation(location, query).toFixed(3)),
    raw: location,
  };
}

function dedupeLocations(locations) {
  const byKey = new Map();

  for (const location of locations) {
    if (!location.id && !location.providerIds.transportRest) continue;
    const key = [
      location.providerIds.transportRest || location.id,
      compactSearchText(location.name),
      compactSearchText(location.locality),
    ].join("|");
    const existing = byKey.get(key);
    if (!existing || location.score > existing.score) byKey.set(key, location);
  }

  return [...byKey.values()];
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === "\"" && inQuotes && next === "\"") {
      current += "\"";
      index += 1;
    } else if (char === "\"") {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return row;
  });
}

function gtfsRouteTypeName(routeType) {
  const type = String(routeType || "");
  if (type === "0") return "tram";
  if (type === "1") return "subway";
  if (type === "2") return "rail";
  if (type === "3") return "bus";
  if (type === "4") return "ferry";
  if (type === "5") return "cable_tram";
  if (type === "6") return "aerial_lift";
  if (type === "7") return "funicular";
  return "GTFS-RT";
}

function findZipEntryData(buffer, filename) {
  const signature = 0x02014b50;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const centralDirectorySize = buffer.readUInt32LE(offset + 12);
    const centralDirectoryOffset = buffer.readUInt32LE(offset + 16);
    const end = centralDirectoryOffset + centralDirectorySize;

    for (let pointer = centralDirectoryOffset; pointer < end;) {
      if (buffer.readUInt32LE(pointer) !== signature) break;
      const compressionMethod = buffer.readUInt16LE(pointer + 10);
      const compressedSize = buffer.readUInt32LE(pointer + 20);
      const uncompressedSize = buffer.readUInt32LE(pointer + 24);
      const nameLength = buffer.readUInt16LE(pointer + 28);
      const extraLength = buffer.readUInt16LE(pointer + 30);
      const commentLength = buffer.readUInt16LE(pointer + 32);
      const localHeaderOffset = buffer.readUInt32LE(pointer + 42);
      const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);

      if (name === filename || name.endsWith(`/${filename}`)) {
        const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
        const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
        return {
          compressionMethod,
          compressed,
          compressedSize,
          uncompressedSize,
        };
      }

      pointer += 46 + nameLength + extraLength + commentLength;
    }
  }

  throw new Error(`${filename} not found in GTFS zip`);
}

function findZipEntry(buffer, filename) {
  const entry = findZipEntryData(buffer, filename);
  if (entry.compressionMethod === 0) return entry.compressed.toString("utf8");
  if (entry.compressionMethod === 8) {
    return zlib
      .inflateRawSync(entry.compressed, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
      .toString("utf8");
  }
  throw new Error(`Unsupported zip compression method ${entry.compressionMethod} for ${filename}`);
}

function staticVersionFromStat(stat) {
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

function isCacheFileFresh(stat, maxAgeMs = GTFS_STATIC_REFRESH_MS, currentTime = nowMs()) {
  return currentTime - stat.mtimeMs < maxAgeMs;
}

async function getGtfsStaticCacheState() {
  try {
    const stat = await fs.promises.stat(GTFS_STATIC_CACHE_FILE);
    return {
      exists: true,
      fresh: isCacheFileFresh(stat),
      stat,
      version: staticVersionFromStat(stat),
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { exists: false, fresh: false, stat: null, version: null };
    }
    throw err;
  }
}

function validateGtfsStaticZip(buffer) {
  for (const filename of ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"]) {
    findZipEntryData(buffer, filename);
  }
}

function invalidateGtfsDerivedCaches(version) {
  gtfsStaticVersion = version;
  gtfsStopIndex = null;
  gtfsTripHeadsigns.clear();
  gtfsHeadsignCacheLoadedVersion = null;
  cache.clear();
}

async function downloadGtfsStaticZip() {
  const response = await fetchWithTimeout(GTFS_STATIC_URL, GTFS_STATIC_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`GTFS static download failed with HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  validateGtfsStaticZip(buffer);

  await fs.promises.mkdir(path.dirname(GTFS_STATIC_CACHE_FILE), { recursive: true });
  const temporaryFile = `${GTFS_STATIC_CACHE_FILE}.${process.pid}.${nowMs()}.tmp`;
  try {
    await fs.promises.writeFile(temporaryFile, buffer);
    await fs.promises.rename(temporaryFile, GTFS_STATIC_CACHE_FILE);
  } catch (err) {
    await fs.promises.unlink(temporaryFile).catch(() => {});
    throw err;
  }

  const stat = await fs.promises.stat(GTFS_STATIC_CACHE_FILE);
  return {
    buffer,
    version: staticVersionFromStat(stat),
    refreshed: true,
  };
}

async function ensureGtfsStaticZip(forceRefresh = false) {
  if (gtfsStaticRefreshPromise) return gtfsStaticRefreshPromise;

  gtfsStaticRefreshPromise = (async () => {
    const state = await getGtfsStaticCacheState();
    if (state.exists && state.fresh && !forceRefresh) {
      return {
        buffer: await fs.promises.readFile(GTFS_STATIC_CACHE_FILE),
        version: state.version,
        refreshed: false,
      };
    }

    try {
      return await downloadGtfsStaticZip();
    } catch (err) {
      if (!state.exists) throw err;
      console.warn(`GTFS static refresh failed, using stale cache: ${err.message}`);
      return {
        buffer: await fs.promises.readFile(GTFS_STATIC_CACHE_FILE),
        version: state.version,
        refreshed: false,
        stale: true,
      };
    }
  })().finally(() => {
    gtfsStaticRefreshPromise = null;
  });

  const result = await gtfsStaticRefreshPromise;
  if (gtfsStaticVersion && result.version !== gtfsStaticVersion) {
    invalidateGtfsDerivedCaches(result.version);
  } else if (!gtfsStaticVersion) {
    gtfsStaticVersion = result.version;
  }
  return result;
}

async function readGtfsStaticZip() {
  const result = await ensureGtfsStaticZip(false);
  return result.buffer;
}

async function loadGtfsStopIndex() {
  if (gtfsStopIndex) return gtfsStopIndex;
  if (gtfsStopIndexPromise) return gtfsStopIndexPromise;

  gtfsStopIndexPromise = (async () => {
    const zipBuffer = await readGtfsStaticZip();
    const stopsText = findZipEntry(zipBuffer, "stops.txt");
    const routesText = findZipEntry(zipBuffer, "routes.txt");
    const tripsText = findZipEntry(zipBuffer, "trips.txt");
    const stops = parseCsv(stopsText)
      .map((row) => ({
        id: row.stop_id,
        name: row.stop_name,
        locality: row.zone_id || "",
        lat: Number(row.stop_lat),
        lon: Number(row.stop_lon),
        type: row.location_type === "1" ? "station" : "stop",
        normalizedName: normalizeSearchText(row.stop_name),
        compactName: compactSearchText(row.stop_name),
      }))
      .filter((stop) => stop.id && stop.name && Number.isFinite(stop.lat) && Number.isFinite(stop.lon));

    const stopsByName = new Map();
    const stopsByToken = new Map();
    for (const stop of stops) {
      const names = new Set([stop.normalizedName, stop.compactName].filter(Boolean));
      for (const name of names) {
        const matches = stopsByName.get(name) || [];
        matches.push(stop);
        stopsByName.set(name, matches);
      }

      const tokens = new Set(stop.normalizedName.split(" ").filter((token) => token.length >= 3));
      for (const token of tokens) {
        const matches = stopsByToken.get(token) || [];
        matches.push(stop);
        stopsByToken.set(token, matches);
      }
    }

    const routesById = new Map(
      parseCsv(routesText)
        .filter((row) => row.route_id)
        .map((row) => [
          row.route_id,
          {
            id: row.route_id,
            shortName: row.route_short_name || "",
            longName: row.route_long_name || "",
            type: gtfsRouteTypeName(row.route_type),
          },
        ])
    );

    const tripsById = new Map(
      parseCsv(tripsText)
        .filter((row) => row.trip_id)
        .map((row) => [
          row.trip_id,
          {
            id: row.trip_id,
            routeId: row.route_id || "",
            headsign: row.trip_headsign || "",
            shortName: row.trip_short_name || "",
            directionId: row.direction_id || "",
          },
        ])
    );

    gtfsStopIndex = {
      stops,
      stopsByName,
      stopsByToken,
      routesById,
      tripsById,
      version: gtfsStaticVersion,
      loadedAt: new Date().toISOString(),
      source: GTFS_STATIC_URL,
    };
    return gtfsStopIndex;
  })().finally(() => {
    gtfsStopIndexPromise = null;
  });

  return gtfsStopIndexPromise;
}

async function loadTripHeadsigns(tripIds) {
  const staticIndex = await loadGtfsStopIndex();
  await loadTripHeadsignCacheFromDisk(staticIndex.version);
  const missing = [...new Set(tripIds.map(String).filter(Boolean))]
    .filter((tripId) => !gtfsTripHeadsigns.has(tripId));
  if (missing.length === 0) return gtfsTripHeadsigns;

  if (!gtfsHeadsignBuildPromise) {
    gtfsHeadsignBuildPromise = buildTripHeadsignCache(staticIndex.version).catch((err) => {
      console.warn(`GTFS headsign cache build failed: ${err.message}`);
      gtfsHeadsignBuildPromise = null;
    });
  }

  return gtfsTripHeadsigns;
}

async function loadTripHeadsignCacheFromDisk(version) {
  if (gtfsHeadsignCacheLoadedVersion === version) return;
  gtfsTripHeadsigns.clear();
  gtfsHeadsignCacheLoadedVersion = version;

  try {
    const text = await fs.promises.readFile(GTFS_HEADSIGN_CACHE_FILE, "utf8");
    const payload = JSON.parse(text);
    if (!payload.version || payload.version !== version || !payload.entries) return;
    const entries = payload.entries;
    for (const [tripId, headsign] of Object.entries(entries)) {
      gtfsTripHeadsigns.set(tripId, headsign);
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`Ignoring GTFS headsign cache: ${err.message}`);
    }
  }
}

async function waitForHeadsignsWithinBudget(tripIds) {
  const lookup = loadTripHeadsigns(tripIds);
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(gtfsTripHeadsigns), HEADSIGN_LOOKUP_BUDGET_MS);
  });
  return Promise.race([lookup, timeout]);
}

async function buildTripHeadsignCache(version) {
  await loadTripHeadsignCacheFromDisk(version);
  const zipBuffer = await readGtfsStaticZip();
  const entry = findZipEntryData(zipBuffer, "stop_times.txt");
  if (entry.compressionMethod !== 8 && entry.compressionMethod !== 0) {
    throw new Error(`Unsupported zip compression method ${entry.compressionMethod} for stop_times.txt`);
  }

  const input = Readable.from(entry.compressed);
  const stream = entry.compressionMethod === 8 ? input.pipe(zlib.createInflateRaw()) : input;
  let remainder = "";
  let headerIndexes = null;

  for await (const chunk of stream) {
    const text = remainder + chunk.toString("utf8");
    const lines = text.split(/\r?\n/);
    remainder = lines.pop() || "";

    for (const line of lines) {
      if (!line) continue;
      const values = parseCsvLine(line);
      if (!headerIndexes) {
        headerIndexes = {
          tripId: values.indexOf("trip_id"),
          stopHeadsign: values.indexOf("stop_headsign"),
        };
        continue;
      }

      const tripId = values[headerIndexes.tripId];
      const headsign = values[headerIndexes.stopHeadsign] || "";
      if (tripId && headsign && !gtfsTripHeadsigns.has(tripId)) {
        gtfsTripHeadsigns.set(tripId, headsign);
      }
    }
  }

  if (gtfsStaticVersion !== version) {
    throw new Error("GTFS static data changed while building headsign cache");
  }

  const payload = JSON.stringify({
    version,
    generatedAt: new Date().toISOString(),
    entries: Object.fromEntries(gtfsTripHeadsigns),
  });
  await fs.promises.mkdir(path.dirname(GTFS_HEADSIGN_CACHE_FILE), { recursive: true });
  const temporaryFile = `${GTFS_HEADSIGN_CACHE_FILE}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(temporaryFile, payload);
    await fs.promises.rename(temporaryFile, GTFS_HEADSIGN_CACHE_FILE);
  } catch (err) {
    await fs.promises.unlink(temporaryFile).catch(() => {});
    throw err;
  }
  gtfsHeadsignBuildPromise = null;
  console.log(`GTFS headsign cache ready with ${gtfsTripHeadsigns.size} trips.`);
  return gtfsTripHeadsigns;
}

function scoreGtfsStop(stop, query, referenceLocations = []) {
  const normalizedQuery = normalizeSearchText(query);
  const compactQuery = compactSearchText(query);
  const queryParts = splitQueryParts(query);
  let score = 0;

  if (stop.normalizedName === normalizedQuery || stop.compactName === compactQuery) score += 0.75;
  else if (stop.normalizedName.startsWith(normalizedQuery) || stop.compactName.startsWith(compactQuery)) score += 0.55;
  else if (stop.normalizedName.includes(normalizedQuery) || stop.compactName.includes(compactQuery)) score += 0.35;
  else {
    const matchingParts = queryParts.filter((part) => part.length >= 3 && stop.normalizedName.includes(part));
    score += Math.min(matchingParts.length * 0.15, 0.35);
  }

  const distances = referenceLocations
    .map((location) => distanceMeters(stop.lat, stop.lon, location.lat, location.lon))
    .filter((distance) => Number.isFinite(distance));
  const nearestDistance = distances.length ? Math.min(...distances) : null;
  if (nearestDistance !== null) {
    if (nearestDistance <= 120) score += 0.35;
    else if (nearestDistance <= 300) score += 0.22;
    else if (nearestDistance <= 800) score += 0.08;
    else score -= 0.1;
  }

  if (stop.type === "stop") score += 0.05;
  return Math.max(0, Math.min(score, 1));
}

async function findGtfsLocations(query, limit, referenceLocations = []) {
  const index = await loadGtfsStopIndex();
  const normalizedQuery = normalizeSearchText(query);
  const compactQuery = compactSearchText(query);
  const exactMatches = [
    ...(index.stopsByName.get(normalizedQuery) || []),
    ...(index.stopsByName.get(compactQuery) || []),
  ];
  const queryTokenMatches = normalizedQuery.split(" ")
    .filter((token) => token.length >= 3)
    .map((token) => index.stopsByToken.get(token))
    .filter(Boolean)
    .sort((a, b) => a.length - b.length);
  const candidates = exactMatches.length > 0
    ? [...new Map(exactMatches.map((stop) => [stop.id, stop])).values()]
    : queryTokenMatches[0] || index.stops;

  return candidates
    .map((stop) => ({
      id: `gtfs:${stop.id}`,
      name: stop.name,
      locality: stop.locality,
      type: stop.type,
      lat: stop.lat,
      lon: stop.lon,
      providerIds: {
        gtfs: [stop.id],
        transportRest: null,
      },
      score: Number(scoreGtfsStop(stop, query, referenceLocations).toFixed(3)),
      raw: stop,
    }))
    .filter((location) => location.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function fetchJson(url, cacheSeconds, timeoutMs = TRANSPORT_TIMEOUT_MS) {
  const cacheKey = `json:${url}`;
  const cached = getCache(cacheKey);
  if (cached) return cached.value;

  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const promise = (async () => {
    try {
      const response = await fetchWithTimeout(url, timeoutMs);
      const bodyText = await response.text();
      let body = null;
      if (bodyText) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = bodyText;
        }
      }

      const value = {
        ok: response.ok,
        status: response.status,
        body,
      };

      setCache(cacheKey, {
        value,
        expiresAt: nowMs() + cacheSeconds * 1000,
      });
      return value;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, promise);
  return promise;
}

async function fetchGtfsRealtimeFeed(url, cacheSeconds, timeoutMs, forceRefresh = false) {
  const cacheKey = `gtfs-rt:${url}`;
  const cached = getCache(cacheKey);
  if (cached && !forceRefresh) return cached.value;

  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const promise = (async () => {
    try {
      const response = await fetchWithTimeout(url, timeoutMs);
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          body: null,
        };
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const body = gtfsRealtime.FeedMessage.decode(buffer);
      const value = {
        ok: true,
        status: response.status,
        body,
      };

      setCache(cacheKey, {
        value,
        expiresAt: nowMs() + cacheSeconds * 1000,
      });
      return value;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, promise);
  return promise;
}

async function findTransportLocations(query, limit) {
  const searchParams = new URLSearchParams({
    query,
    results: String(Math.max(limit * 3, 12)),
    stops: "true",
    addresses: "false",
    poi: "false",
  });
  const url = `${UPSTREAM_BASE}/locations?${searchParams}`;
  const result = await fetchJson(url, 30);
  if (!result.ok || !Array.isArray(result.body)) return [];

  return dedupeLocations(result.body.map((location) => normalizeLocation(location, query)))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function normalizeDeparture(raw) {
  const lineObject = raw.line || raw.lineName || {};
  const plannedWhen = raw.plannedWhen || raw.scheduledWhen || raw.when || null;
  const when = raw.when || raw.prognosedWhen || plannedWhen;
  const delaySeconds = Number.isFinite(Number(raw.delay)) ? Number(raw.delay) : null;
  const lineName =
    raw.lineName ||
    lineObject.name ||
    lineObject.fahrtNr ||
    lineObject.id ||
    "";

  return {
    line: String(lineName || ""),
    product: raw.product || lineObject.productName || lineObject.product || "",
    direction: raw.direction || raw.destination?.name || "",
    plannedWhen,
    when,
    delaySeconds,
    platform: raw.platform || raw.plannedPlatform || "",
    cancelled: Boolean(raw.cancelled),
    status: formatDepartureStatus(delaySeconds, raw.cancelled),
  };
}

function gtfsDateTimeToIso(startDate, timeValue, delaySeconds = 0) {
  const date = String(startDate || "");
  const time = String(timeValue || "");
  const match = date.match(/^(\d{4})(\d{2})(\d{2})$/);
  const timeMatch = time.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match || !timeMatch) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = Number(timeMatch[3]);
  const localDate = new Date(year, monthIndex, day, hours, minutes, seconds);
  return new Date(localDate.getTime() + delaySeconds * 1000).toISOString();
}

function epochSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

function normalizeVbnDeparture(entity, update, stopId) {
  const trip = entity.tripUpdate?.trip || {};
  const event = update.departure || update.arrival || {};
  const delaySeconds = Number.isFinite(Number(event.delay)) ? Number(event.delay) : 0;
  const cancelled = update.scheduleRelationship === "SKIPPED" || trip.scheduleRelationship === "CANCELED";

  let when = epochSecondsToIso(event.time);
  if (!when && update.stopSequence === 0) {
    when = gtfsDateTimeToIso(trip.startDate, trip.startTime, delaySeconds);
  }

  if (!when) return null;

  const plannedWhen = Number.isFinite(Number(event.time))
    ? new Date(Date.parse(when) - delaySeconds * 1000).toISOString()
    : gtfsDateTimeToIso(trip.startDate, trip.startTime, 0);

  return {
    line: String(trip.routeId || ""),
    product: "GTFS-RT",
    direction: trip.tripId || "",
    plannedWhen,
    when,
    delaySeconds,
    platform: "",
    cancelled,
    status: formatDepartureStatus(delaySeconds, cancelled),
    stopId,
  };
}

function normalizeGtfsRealtimeDeparture(entity, update, stopId, staticIndex, headsigns) {
  const trip = entity.tripUpdate?.trip || {};
  const staticTrip = staticIndex?.tripsById?.get(String(trip.tripId)) || null;
  const routeId = String(trip.routeId || staticTrip?.routeId || "");
  const staticRoute = staticIndex?.routesById?.get(routeId) || null;
  const direction = headsigns?.get(String(trip.tripId)) || staticTrip?.headsign || trip.tripId || "";
  const event = update.departure || update.arrival || {};
  const delaySeconds = Number.isFinite(Number(event.delay)) ? Number(event.delay) : 0;
  const cancelled = update.scheduleRelationship === 1 || trip.scheduleRelationship === 3;

  let when = epochSecondsToIso(event.time);
  if (!when && update.stopSequence === 0) {
    when = gtfsDateTimeToIso(trip.startDate, trip.startTime, delaySeconds);
  }

  if (!when) return null;

  const plannedWhen = Number.isFinite(Number(event.time))
    ? new Date(Date.parse(when) - delaySeconds * 1000).toISOString()
    : gtfsDateTimeToIso(trip.startDate, trip.startTime, 0);

  return {
    line: staticRoute?.shortName || staticTrip?.shortName || staticRoute?.longName || routeId,
    product: staticRoute?.type || "GTFS-RT",
    direction,
    plannedWhen,
    when,
    delaySeconds,
    platform: "",
    cancelled,
    status: formatDepartureStatus(delaySeconds, cancelled),
    stopId,
  };
}

function formatDepartureStatus(delaySeconds, cancelled) {
  if (cancelled) return "cancelled";
  if (!Number.isFinite(delaySeconds) || delaySeconds === 0) return "on time";
  const roundedMinutes = Math.round(delaySeconds / 60);
  if (roundedMinutes > 0) return `+${roundedMinutes} min`;
  return `${roundedMinutes} min`;
}

function effectiveDepartureTime(departure) {
  const time = Date.parse(departure.when || departure.plannedWhen || "");
  return Number.isFinite(time) ? time : 0;
}

function filterAndSortDepartures(departures, limit) {
  const now = nowMs() - 60 * 1000;
  return departures
    .filter((departure) => !departure.cancelled)
    .filter((departure) => {
      const time = effectiveDepartureTime(departure);
      return time > now;
    })
    .sort((a, b) => effectiveDepartureTime(a) - effectiveDepartureTime(b))
    .slice(0, limit);
}

function departureQualityScore(candidate, departures, endpointType) {
  let score = candidate.score;
  if (departures.length > 0) score += 1;
  if (departures.some((departure) => departure.when && departure.when !== departure.plannedWhen)) score += 0.25;
  if (endpointType === "stops") score += 0.05;
  return score;
}

async function fetchVbnRealtimeDepartures(candidate, limit) {
  const stopIds = candidate.providerIds.gtfs || [];
  if (stopIds.length === 0) return null;

  try {
    const result = await fetchJson(VBN_GTFS_RT_JSON_URL, 20, VBN_TIMEOUT_MS);
    if (!result.ok || !Array.isArray(result.body?.entity)) {
      return {
        candidate,
        endpointType: "gtfs-rt",
        ok: false,
        status: result.status,
        departures: [],
        score: candidate.score - 0.2,
      };
    }

    const stopIdSet = new Set(stopIds);
    const departures = [];
    for (const entity of result.body.entity) {
      const updates = entity.tripUpdate?.stopTimeUpdate || [];
      for (const update of updates) {
        if (!stopIdSet.has(String(update.stopId))) continue;
        const departure = normalizeVbnDeparture(entity, update, String(update.stopId));
        if (departure) departures.push(departure);
      }
    }

    const normalized = filterAndSortDepartures(departures, limit);
    return {
      candidate,
      endpointType: "gtfs-rt",
      ok: true,
      status: result.status,
      departures: normalized,
      score: candidate.score + (normalized.length > 0 ? 1.35 : 0),
    };
  } catch (err) {
    return {
      candidate,
      endpointType: "gtfs-rt",
      ok: false,
      status: err.name === "AbortError" ? 504 : 502,
      departures: [],
      score: candidate.score - 0.2,
    };
  }
}

async function fetchGtfsDeRealtimeDepartures(candidate, limit) {
  const stopIds = candidate.providerIds.gtfs || [];
  if (stopIds.length === 0) return null;

  try {
    const staticIndex = await loadGtfsStopIndex();
    const result = await fetchGtfsRealtimeFeed(GTFS_DE_REALTIME_URL, 30, GTFS_DE_REALTIME_TIMEOUT_MS);
    if (!result.ok || !Array.isArray(result.body?.entity)) {
      return {
        candidate,
        endpointType: "gtfs-de-rt",
        ok: false,
        status: result.status,
        departures: [],
        score: candidate.score - 0.2,
      };
    }

    const stopIdSet = new Set(stopIds.map(String));
    const matches = [];
    for (const entity of result.body.entity) {
      const updates = entity.tripUpdate?.stopTimeUpdate || [];
      for (const update of updates) {
        if (!stopIdSet.has(String(update.stopId))) continue;
        matches.push({ entity, update, stopId: String(update.stopId) });
      }
    }

    const matchedTripIds = matches.map((match) => match.entity.tripUpdate?.trip?.tripId);
    const headsigns = await waitForHeadsignsWithinBudget(matchedTripIds);
    const departures = [];
    for (const match of matches) {
        const departure = normalizeGtfsRealtimeDeparture(
          match.entity,
          match.update,
          match.stopId,
          staticIndex,
          headsigns
        );
        if (departure) departures.push(departure);
    }

    const normalized = filterAndSortDepartures(departures, limit);
    return {
      candidate,
      endpointType: "gtfs-de-rt",
      ok: true,
      status: result.status,
      departures: normalized,
      score: candidate.score + (normalized.length > 0 ? 1.45 : 0),
    };
  } catch (err) {
    return {
      candidate,
      endpointType: "gtfs-de-rt",
      ok: false,
      status: err.name === "AbortError" ? 504 : 502,
      departures: [],
      score: candidate.score - 0.2,
    };
  }
}

async function refreshGtfsRealtimeCache() {
  try {
    await fetchGtfsRealtimeFeed(
      GTFS_DE_REALTIME_URL,
      Math.ceil(GTFS_REALTIME_REFRESH_MS / 1000) + 5,
      GTFS_DE_REALTIME_TIMEOUT_MS,
      true
    );
  } catch (err) {
    console.warn(`GTFS realtime refresh failed: ${err.message}`);
  }
}

async function refreshGtfsStaticCache() {
  const previousVersion = gtfsStaticVersion;
  try {
    const result = await ensureGtfsStaticZip(false);
    if (previousVersion && result.version !== previousVersion) {
      await loadGtfsStopIndex();
      console.log(`GTFS static cache refreshed (${result.version}).`);
    }
  } catch (err) {
    console.warn(`GTFS static refresh failed: ${err.message}`);
  }
}

async function fetchTransportDepartures(candidate, endpointType, limit) {
  const providerId = candidate.providerIds.transportRest;
  if (!providerId) return null;

  const searchParams = new URLSearchParams({
    results: String(Math.max(limit * 2, 12)),
    duration: "120",
  });
  const url = `${UPSTREAM_BASE}/${endpointType}/${encodeURIComponent(providerId)}/departures?${searchParams}`;

  try {
    const result = await fetchJson(url, 8);
    const departureRows = Array.isArray(result.body)
      ? result.body
      : Array.isArray(result.body?.departures)
        ? result.body.departures
        : null;

    if (!result.ok || !departureRows) {
      return {
        candidate,
        endpointType,
        ok: false,
        status: result.status,
        departures: [],
        score: candidate.score - 0.2,
      };
    }

    const departures = filterAndSortDepartures(departureRows.map(normalizeDeparture), limit);
    return {
      candidate,
      endpointType,
      ok: true,
      status: result.status,
      departures,
      score: departureQualityScore(candidate, departures, endpointType),
    };
  } catch (err) {
    return {
      candidate,
      endpointType,
      ok: false,
      status: err.name === "AbortError" ? 504 : 502,
      departures: [],
      score: candidate.score - 0.2,
    };
  }
}

async function resolveDepartureCandidates(reqQuery) {
  const stopId = typeof reqQuery.stopId === "string" ? reqQuery.stopId.trim() : "";
  const query = typeof reqQuery.query === "string" ? reqQuery.query.trim() : "";

  if (stopId) {
    const parsed = parseCanonicalStopId(stopId);
    if (!parsed.id) return [];
    if (parsed.type === "gtfs") {
      return [
        {
          id: parsed.canonicalId,
          name: query || parsed.id,
          locality: "",
          type: "stop",
          lat: null,
          lon: null,
          providerIds: {
            gtfs: [parsed.id],
            transportRest: null,
          },
          score: 0.9,
          raw: null,
        },
      ];
    }

    return [
      {
        id: parsed.canonicalId,
        name: query || parsed.id,
        locality: "",
        type: parsed.type,
        lat: null,
        lon: null,
        providerIds: {
          gtfs: null,
          transportRest: parsed.id,
        },
        score: 0.7,
        raw: null,
      },
    ];
  }

  if (!query) return [];

  const aliasStopIds = getAliasStopIds(query);
  if (aliasStopIds.length > 0) {
    return [
      {
        id: `gtfs:${aliasStopIds.join(",")}`,
        name: query,
        locality: "",
        type: "stop",
        lat: null,
        lon: null,
        providerIds: {
          gtfs: aliasStopIds,
          transportRest: null,
        },
        score: 0.95,
        raw: null,
      },
    ];
  }

  try {
    const gtfsLocations = await findGtfsLocations(query, DEPARTURE_CANDIDATE_LIMIT);
    if (gtfsLocations.length > 0) return gtfsLocations;
  } catch (err) {
    console.warn(`GTFS location matching failed: ${err.message}`);
  }

  return findTransportLocations(query, 8);
}

function makeDeparturesCacheKey(reqQuery) {
  const stopId = typeof reqQuery.stopId === "string" ? reqQuery.stopId.trim() : "";
  const query = typeof reqQuery.query === "string" ? reqQuery.query.trim() : "";
  const limit = clampNumber(reqQuery.limit, 6, 1, MAX_DEPARTURES_LIMIT);
  if (stopId) return `stopId:${stopId}|limit:${limit}`;
  return `query:${normalizeSearchText(query)}|limit:${limit}`;
}

function getLastGoodDepartures(cacheKey) {
  const entry = lastGoodDepartures.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= nowMs()) {
    lastGoodDepartures.delete(cacheKey);
    return null;
  }
  return entry.body;
}

function setLastGoodDepartures(cacheKey, body) {
  lastGoodDepartures.set(cacheKey, {
    body,
    expiresAt: nowMs() + LAST_GOOD_DEPARTURES_SECONDS * 1000,
  });
}

function makeDepartureResponse(best, candidateCount, cacheState) {
  const isGtfs = best.endpointType === "gtfs-rt" || best.endpointType === "gtfs-de-rt";
  return {
    ok: true,
    source: isGtfs ? "gtfs-rt" : "transport-rest",
    fallback: !isGtfs,
    stop: {
      id: best.candidate.id,
      name: best.candidate.name,
      locality: best.candidate.locality,
      lat: best.candidate.lat,
      lon: best.candidate.lon,
    },
    updatedAt: new Date().toISOString(),
    departures: best.departures,
    diagnostics: {
      candidateCount,
      provider:
        best.endpointType === "gtfs-de-rt"
          ? "gtfs-de-rt"
          : isGtfs
            ? "vbn-gtfs-rt"
            : `transport-rest/${best.endpointType}`,
      cache: cacheState,
      score: Number(best.score.toFixed(3)),
    },
  };
}

function mergeDepartureAttempts(attempts, endpointType, limit) {
  const usable = attempts
    .filter(Boolean)
    .filter((attempt) => attempt.endpointType === endpointType)
    .filter((attempt) => attempt.ok && attempt.departures.length > 0);

  if (usable.length === 0) return null;

  const departuresByKey = new Map();
  for (const attempt of usable) {
    for (const departure of attempt.departures) {
      const key = [
        departure.stopId,
        departure.line,
        departure.direction,
        departure.plannedWhen,
        departure.when,
      ].join("|");
      if (!departuresByKey.has(key)) departuresByKey.set(key, departure);
    }
  }

  const departures = filterAndSortDepartures([...departuresByKey.values()], limit);
  if (departures.length === 0) return null;

  const best = usable.sort((a, b) => b.score - a.score)[0];
  const stopIds = usable.map((attempt) => attempt.candidate.id).join(",");
  return {
    candidate: {
      ...best.candidate,
      id: `${endpointType}:${stopIds}`,
      name: best.candidate.name,
    },
    endpointType,
    ok: true,
    status: 200,
    departures,
    score: best.score + 0.1,
  };
}

async function buildDeparturesResponse(reqQuery) {
  const limit = clampNumber(reqQuery.limit, 6, 1, MAX_DEPARTURES_LIMIT);
  const cacheKey = makeDeparturesCacheKey(reqQuery);
  const cached = getCache(`departures:${cacheKey}`);
  if (cached) return cached.value;

  if (inflight.has(`departures:${cacheKey}`)) {
    return inflight.get(`departures:${cacheKey}`);
  }

  const promise = (async () => {
    const candidates = await resolveDepartureCandidates(reqQuery);

    if (candidates.length === 0) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "MISSING_LOCATION",
          message: "Bitte query oder stopId angeben.",
        },
      };
    }

    const attempts = [];
    for (const candidate of candidates) {
      if (candidate.providerIds.gtfs?.length) {
        attempts.push(await fetchGtfsDeRealtimeDepartures(candidate, limit));
      }
    }

    let best = mergeDepartureAttempts(attempts, "gtfs-de-rt", limit);

    if (!best) {
      best = attempts
        .filter(Boolean)
        .filter((attempt) => attempt.ok && attempt.departures.length > 0)
        .sort((a, b) => b.score - a.score)[0];
    }

    if (!best) {
      for (const candidate of candidates) {
        if (candidate.providerIds.gtfs?.length) {
          attempts.push(await fetchVbnRealtimeDepartures(candidate, limit));
        }
      }
    }

    best = best || mergeDepartureAttempts(attempts, "gtfs-rt", limit);

    if (!best) {
      best = attempts
      .filter(Boolean)
      .filter((attempt) => attempt.ok && attempt.departures.length > 0)
      .sort((a, b) => b.score - a.score)[0];
    }

    if (!best) {
      const fallbackCandidates = candidates
        .filter((candidate) => candidate.providerIds.transportRest)
        .slice(0, TRANSPORT_REST_CANDIDATE_LIMIT);

      for (const candidate of fallbackCandidates) {
        attempts.push(await fetchTransportDepartures(candidate, "stops", limit));
      }
    }

    if (!best) {
      best = attempts
        .filter(Boolean)
        .filter((attempt) => attempt.ok && attempt.departures.length > 0)
        .sort((a, b) => b.score - a.score)[0];
    }

    if (best) {
      const body = makeDepartureResponse(best, candidates.length, "fresh");
      setCache(`departures:${cacheKey}`, {
        value: { status: 200, body },
        expiresAt: nowMs() + DEPARTURES_CACHE_SECONDS * 1000,
      });
      setLastGoodDepartures(cacheKey, body);
      return { status: 200, body };
    }

    const stale = getLastGoodDepartures(cacheKey);
    if (stale) {
      return {
        status: 200,
        body: {
          ...stale,
          source: "cache",
          fallback: true,
          stale: true,
          diagnostics: {
            ...stale.diagnostics,
            cache: "stale",
            candidateCount: candidates.length,
          },
        },
      };
    }

    return {
      status: 503,
      body: {
        ok: false,
        error: "NO_DEPARTURES_AVAILABLE",
        message: "Keine Live-Abfahrten verfuegbar.",
        diagnostics: {
          candidateCount: candidates.length,
          provider: "transport-rest",
          cache: "miss",
          attemptedRequests: attempts.filter(Boolean).length,
        },
      },
    };
  })().finally(() => {
    inflight.delete(`departures:${cacheKey}`);
  });

  inflight.set(`departures:${cacheKey}`, promise);
  return promise;
}

app.get("/api/locations", async (req, res) => {
  const upstreamUrl = `${UPSTREAM_BASE}/locations?${new URLSearchParams(req.query)}`;
  const entry = await proxyRequest(upstreamUrl, 30);
  sendEntry(res, entry);
});

app.get("/api/transport/locations", async (req, res) => {
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
  const limit = clampNumber(req.query.limit || req.query.results, 8, 1, 20);
  if (!query) {
    res.status(400).json({
      ok: false,
      error: "MISSING_QUERY",
      message: "Bitte query angeben.",
    });
    return;
  }

  try {
    const aliasStopIds = getAliasStopIds(query);
    const aliasLocations = aliasStopIds.length
      ? [
          {
            id: `gtfs:${aliasStopIds.join(",")}`,
            name: query,
            locality: "",
            type: "stop",
            lat: null,
            lon: null,
            providerIds: {
              gtfs: aliasStopIds,
              transportRest: null,
            },
            score: 0.95,
          },
        ]
      : [];
    let gtfsLocations = [];
    try {
      gtfsLocations = await findGtfsLocations(query, limit);
    } catch (err) {
      console.warn(`GTFS location matching failed: ${err.message}`);
    }

    const locations = gtfsLocations.length < limit
      ? await findTransportLocations(query, limit)
      : [];
    res.json({
      ok: true,
      locations: [
        ...aliasLocations,
        ...gtfsLocations.map(({ raw, ...location }) => location),
        ...locations.map(({ raw, ...location }) => location),
      ].slice(0, limit),
    });
  } catch (err) {
    res.status(err.name === "AbortError" ? 504 : 502).json({
      ok: false,
      error: err.name === "AbortError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
      message: "Haltestellensuche ist gerade nicht verfuegbar.",
    });
  }
});

app.get("/api/departures", async (req, res) => {
  try {
    const response = await buildDeparturesResponse(req.query);
    res.status(response.status).json(response.body);
  } catch (err) {
    const cacheKey = makeDeparturesCacheKey(req.query);
    const stale = getLastGoodDepartures(cacheKey);
    if (stale) {
      res.json({
        ...stale,
        source: "cache",
        fallback: true,
        stale: true,
        diagnostics: {
          ...stale.diagnostics,
          cache: "stale",
        },
      });
      return;
    }

    res.status(err.name === "AbortError" ? 504 : 502).json({
      ok: false,
      error: err.name === "AbortError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
      message: "Keine Live-Abfahrten verfuegbar.",
    });
  }
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

function startServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`Proxy listening on port ${port}`);
    loadGtfsStopIndex().catch((err) => {
      console.warn(`GTFS static warmup failed: ${err.message}`);
    });
    refreshGtfsRealtimeCache();
    setInterval(refreshGtfsRealtimeCache, GTFS_REALTIME_REFRESH_MS).unref();
    setInterval(refreshGtfsStaticCache, GTFS_STATIC_REFRESH_CHECK_MS).unref();
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  _internal: {
    clampNumber,
    compactSearchText,
    distanceMeters,
    isCacheFileFresh,
    makeDeparturesCacheKey,
    mergeDepartureAttempts,
    normalizeSearchText,
    parseCanonicalStopId,
    parseCsvLine,
    scoreGtfsStop,
  },
};
