const assert = require("node:assert/strict");
const test = require("node:test");

const { _internal } = require("../server");

const {
  clampNumber,
  createLocationFallbackClient,
  findGtfsLocationsInIndex,
  isCacheFileFresh,
  makeDeparturesCacheKey,
  mergeDepartureAttempts,
  mergeLocationsByNormalizedName,
  normalizeSearchText,
  parseCanonicalStopId,
  parseCsvLine,
  scoreGtfsStop,
} = _internal;

function makeStop(id, name, lat = 52.36, lon = 9.85) {
  return {
    id,
    name,
    locality: "",
    lat,
    lon,
    type: "stop",
    normalizedName: normalizeSearchText(name),
    compactName: normalizeSearchText(name).replace(/\s+/g, ""),
  };
}

function makeStopIndex(stops) {
  const stopsByName = new Map();
  const stopsByToken = new Map();
  for (const stop of stops) {
    for (const name of new Set([stop.normalizedName, stop.compactName])) {
      stopsByName.set(name, [...(stopsByName.get(name) || []), stop]);
    }
    for (const token of new Set(stop.normalizedName.split(" "))) {
      if (token.length < 3) continue;
      stopsByToken.set(token, [...(stopsByToken.get(token) || []), stop]);
    }
  }
  return {
    stops,
    stopsByName,
    stopsByToken,
    sortedStopTokens: [...stopsByToken.keys()].sort(),
  };
}

const locationIndex = makeStopIndex([
  makeStop("k1", "Hannover Kröpcke"),
  makeStop("k2", "Hannover Kröpcke", 52.3736, 9.7393),
  makeStop("r1", "Hannover Königsberger Ring"),
  makeStop("r2", "Hannover Königsberger Ring", 52.3594, 9.8516),
  makeStop("q1", "König"),
  makeStop("m1", "Hann. Münden"),
]);

test("normalizes German stop names consistently", () => {
  assert.equal(normalizeSearchText("Königsberger-Ring"), "koenigsberger ring");
  assert.equal(normalizeSearchText("  Kröpcke, Hannover  "), "kroepcke hannover");
  assert.equal(normalizeSearchText("Kro\u0308pcke"), "kroepcke");
  assert.equal(normalizeSearchText("Straße / STRASSE"), "strasse strasse");
});

test("matches Kroepcke and Kröpcke identically", () => {
  const ascii = findGtfsLocationsInIndex(locationIndex, "Kroepcke", 8);
  const umlaut = findGtfsLocationsInIndex(locationIndex, "Kröpcke", 8);

  assert.deepEqual(ascii, umlaut);
  assert.equal(ascii.length, 1);
  assert.equal(ascii[0].name, "Hannover Kröpcke");
  assert.deepEqual(ascii[0].providerIds.gtfs, ["k1", "k2"]);
});

test("matches full and prefixed Hannover Königsberger Ring queries", () => {
  const full = findGtfsLocationsInIndex(locationIndex, "Hannover Königsberger Ring", 20);
  const prefix = findGtfsLocationsInIndex(locationIndex, "Hannover König", 20);

  assert.equal(full.length, 1);
  assert.equal(prefix.length, 1);
  assert.equal(full[0].name, "Hannover Königsberger Ring");
  assert.equal(prefix[0].name, "Hannover Königsberger Ring");
  assert.deepEqual(full[0].providerIds.gtfs, ["r1", "r2"]);
  assert.ok(full.every((location) => location.name !== "Hann. Münden"));
  assert.ok(prefix.every((location) => location.name !== "Hann. Münden"));
});

test("merges identical normalized station names and their GTFS IDs", () => {
  const merged = mergeLocationsByNormalizedName([
    {
      id: "gtfs:1",
      name: "Hannover Kröpcke",
      providerIds: { gtfs: ["1"], transportRest: null },
      score: 0.9,
    },
    {
      id: "gtfs:2",
      name: "Hannover Kroepcke",
      providerIds: { gtfs: ["2"], transportRest: "tr-2" },
      score: 0.8,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "gtfs:1,2");
  assert.deepEqual(merged[0].providerIds.gtfs, ["1", "2"]);
  assert.equal(merged[0].providerIds.transportRest, "tr-2");
});

test("parses quoted GTFS CSV values", () => {
  assert.deepEqual(parseCsvLine('123,"Hannover, Hauptbahnhof","A ""quoted"" value"'), [
    "123",
    "Hannover, Hauptbahnhof",
    'A "quoted" value',
  ]);
});

test("clamps departure limits to the configured boundary", () => {
  assert.equal(clampNumber("100", 6, 1, 100), 100);
  assert.equal(clampNumber("500", 6, 1, 100), 100);
  assert.equal(clampNumber("invalid", 6, 1, 100), 6);
});

test("parses canonical GTFS and transport.rest stop IDs", () => {
  assert.deepEqual(parseCanonicalStopId("gtfs:280519"), {
    id: "280519",
    type: "gtfs",
    canonicalId: "gtfs:280519",
  });
  assert.deepEqual(parseCanonicalStopId("transport-rest:station:614085"), {
    id: "614085",
    type: "station",
    canonicalId: "transport-rest:station:614085",
  });
});

test("scores an exact GTFS stop match above an unrelated stop", () => {
  const exact = {
    normalizedName: "hannover koenigsberger ring",
    compactName: "hannoverkoenigsbergerring",
    type: "stop",
    lat: 52.3598,
    lon: 9.8497,
  };
  const unrelated = {
    normalizedName: "hannover hauptbahnhof",
    compactName: "hannoverhauptbahnhof",
    type: "stop",
    lat: 52.3783,
    lon: 9.7425,
  };

  assert.ok(
    scoreGtfsStop(exact, "Hannover Königsberger Ring") >
      scoreGtfsStop(unrelated, "Hannover Königsberger Ring")
  );
});

test("merges, deduplicates and sorts departures across station platforms", () => {
  const baseTime = Date.now() + 60_000;
  const departure = (stopId, minutes, line) => ({
    stopId,
    line,
    direction: "Hannover Zentrum",
    plannedWhen: new Date(baseTime + minutes * 60_000).toISOString(),
    when: new Date(baseTime + minutes * 60_000).toISOString(),
    cancelled: false,
  });
  const candidate = (id) => ({ id, name: "Hannover Hauptbahnhof", score: 0.8 });
  const duplicate = departure("a", 2, "1");
  const attempts = [
    {
      endpointType: "gtfs-de-rt",
      ok: true,
      candidate: candidate("gtfs:a"),
      departures: [departure("a", 4, "2"), duplicate],
      score: 1.8,
    },
    {
      endpointType: "gtfs-de-rt",
      ok: true,
      candidate: candidate("gtfs:b"),
      departures: [departure("b", 3, "3"), duplicate],
      score: 1.7,
    },
  ];

  const merged = mergeDepartureAttempts(attempts, "gtfs-de-rt", 100);
  assert.equal(merged.departures.length, 3);
  assert.deepEqual(merged.departures.map((item) => item.line), ["1", "3", "2"]);
});

test("evaluates static cache freshness from mtime", () => {
  const now = 10_000;
  assert.equal(isCacheFileFresh({ mtimeMs: 9_500 }, 1_000, now), true);
  assert.equal(isCacheFileFresh({ mtimeMs: 8_000 }, 1_000, now), false);
});

test("normalizes query cache keys and preserves the requested limit", () => {
  assert.equal(
    makeDeparturesCacheKey({ query: "Königsberger Ring", limit: "100" }),
    "query:koenigsberger ring|limit:100"
  );
});

test("uses the configured location timeout and serves stale cache on timeout", async () => {
  let now = 0;
  let calls = 0;
  let observedTimeout = null;
  const request = async (_url, timeoutMs) => {
    calls += 1;
    observedTimeout = timeoutMs;
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: "transport-1",
            type: "stop",
            name: "Hannover Königsberger Ring",
            latitude: 52.36,
            longitude: 9.85,
          },
        ],
      };
    }
    const error = new Error("timed out");
    error.name = "AbortError";
    throw error;
  };
  const client = createLocationFallbackClient({
    request,
    now: () => now,
    timeoutMs: 25,
    cacheMs: 10,
    staleMs: 100,
  });

  const fresh = await client.lookup("Hannover Königsberger Ring", 8);
  now = 20;
  const stale = await client.lookup("Hannover Königsberger Ring", 8);

  assert.equal(observedTimeout, 25);
  assert.equal(fresh.stale, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.cache, "stale");
  assert.equal(stale.locations.length, 1);
});

test("caches negative location results briefly", async () => {
  let calls = 0;
  const client = createLocationFallbackClient({
    request: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => [] };
    },
    negativeCacheMs: 50,
  });

  const first = await client.lookup("unknown stop", 8);
  const second = await client.lookup("unknown stop", 8);

  assert.equal(first.cache, "negative");
  assert.equal(second.cache, "fresh");
  assert.equal(calls, 1);
});

test("deduplicates parallel identical location fallback requests", async () => {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const client = createLocationFallbackClient({
    request: async () => {
      calls += 1;
      await blocked;
      return { ok: true, status: 200, json: async () => [] };
    },
  });

  const first = client.lookup("parallel stop", 8);
  const second = client.lookup("parallel stop", 8);
  release();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
});
