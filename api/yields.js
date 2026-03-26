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

function fetchSeries(seriesId, apiKey) {
  return new Promise((resolve, reject) => {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=5&api_key=${apiKey}&file_type=json`;
    https.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (json.error_code) {
            reject(new Error(`FRED API error: ${json.error_message}`));
            return;
          }
          // Walk forward (desc order) to find first non-"." value
          const obs = json.observations || [];
          for (const o of obs) {
            if (o.value && o.value !== ".") {
              resolve({ date: o.date, value: parseFloat(o.value) });
              return;
            }
          }
          resolve({ date: null, value: null });
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

async function getLiveYields() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL_MS) {
    return cache;
  }

  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    throw new Error("FRED_API_KEY environment variable is not set");
  }

  const results = await Promise.all(SERIES.map((id) => fetchSeries(id, apiKey)));

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
