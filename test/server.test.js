const assert = require("node:assert/strict");
const test = require("node:test");

const { _internal } = require("../server");

const {
  clampNumber,
  isCacheFileFresh,
  makeDeparturesCacheKey,
  mergeDepartureAttempts,
  normalizeSearchText,
  parseCanonicalStopId,
  parseCsvLine,
  scoreGtfsStop,
} = _internal;

test("normalizes German stop names consistently", () => {
  assert.equal(normalizeSearchText("Königsberger-Ring"), "koenigsberger ring");
  assert.equal(normalizeSearchText("  Kröpcke, Hannover  "), "kroepcke hannover");
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
