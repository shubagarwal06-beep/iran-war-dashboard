const https = require("https");

let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// FRED series IDs matching TENORS: 1M,3M,6M,1Y,2Y,3Y,5Y,7Y,10Y,20Y,30Y
const SERIES = [
  "DGS1MO", "DGS3MO", "DGS6MO", "DGS1",
  "DGS2", "DGS3", "DGS5", "DGS7",
  "DGS10", "DGS20", "DGS30"
];

function fetchLatest(seriesId) {
  return new Promise((resolve, reject) => {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
    https.get(url, { headers: { "User-Agent": "iran-war-dashboard/1.0" } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        const lines = body.trim().split("\n");
        // Walk backward to find last non-"." value
        for (let i = lines.length - 1; i >= 1; i--) {
          const parts = lines[i].split(",");
          const date = parts[0] && parts[0].trim();
          const val = parts[1] && parts[1].trim();
          if (val && val !== ".") {
            resolve({ date, value: parseFloat(val) });
            return;
          }
        }
        resolve({ date: null, value: null });
      });
    }).on("error", reject);
  });
}

async function getLiveYields() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL_MS) {
    return cache;
  }

  const results = await Promise.all(SERIES.map((id) => fetchLatest(id, null)));

  if (results.some((r) => r.value === null || isNaN(r.value))) {
    throw new Error("Missing yield data from FRED for one or more tenors");
  }

  const dates = results.map((r) => r.date).filter(Boolean).sort();
  const date = dates[dates.length - 1];
  const curve = results.map((r) => r.value);

  cache = { date, curve };
  cacheTime = now;
  return cache;
}

module.exports = async (req, res) => {
  try {
    const data = await getLiveYields();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
};
