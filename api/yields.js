const https = require("https");

let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const FIELDS = [
  "BC_1MONTH", "BC_3MONTH", "BC_6MONTH", "BC_1YEAR",
  "BC_2YEAR",  "BC_3YEAR",  "BC_5YEAR",  "BC_7YEAR",
  "BC_10YEAR", "BC_20YEAR", "BC_30YEAR"
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

function parseLatestEntry(xml) {
  const parts = xml.split(/<entry[\s>]/);
  const last = parts[parts.length - 1];

  const dateMatch = last.match(/<d:NEW_DATE[^>]*>([^T<]+)/);
  const date = dateMatch ? dateMatch[1].trim() : null;

  const curve = FIELDS.map((field) => {
    const re = new RegExp(`<d:${field}[^>]*>([^<]+)<`);
    const m = last.match(re);
    return m ? parseFloat(m[1]) : null;
  });

  return { date, curve };
}

async function getLiveYields() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL_MS) {
    return cache;
  }

  const year = new Date().getFullYear();
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdes_term=${year}`;
  const xml = await fetchUrl(url);
  const { date, curve } = parseLatestEntry(xml);

  if (!date || curve.some((v) => v === null || isNaN(v))) {
    throw new Error("Could not parse Treasury yield curve XML");
  }

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
