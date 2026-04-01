const https = require("https");

let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function fetchHistory(apiKey) {
  return new Promise((resolve, reject) => {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&sort_order=desc&limit=45&api_key=${apiKey}&file_type=json`;
    https.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (json.error_code) {
            reject(new Error(`FRED error: ${json.error_message}`));
            return;
          }
          const obs = (json.observations || [])
            .filter(o => o.value && o.value !== ".")
            .map(o => ({ date: o.date, value: parseFloat(o.value) }))
            .slice(0, 30)
            .reverse(); // ascending chronological order
          resolve(obs);
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

module.exports = async (req, res) => {
  try {
    const now = Date.now();
    if (cache && now - cacheTime < CACHE_TTL_MS) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).json({ observations: cache });
    }
    const apiKey = process.env.FRED_API_KEY;
    if (!apiKey) throw new Error("FRED_API_KEY not set");
    const obs = await fetchHistory(apiKey);
    cache = obs;
    cacheTime = now;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).json({ observations: obs });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
};
