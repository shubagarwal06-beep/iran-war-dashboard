const { getCached } = require("../lib/intel");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const start = Date.now();
  try {
    await getCached(true);
    res.status(200).json({ ok: true, warmedAt: new Date().toISOString(), ms: Date.now() - start });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - start });
  }
};
