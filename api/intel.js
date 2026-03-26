const { getCached } = require("../lib/intel");

module.exports = async (req, res) => {
  const forceRefresh = req.query && req.query.refresh === "1";
  try {
    const payload = await getCached(forceRefresh);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(payload);
  } catch (err) {
    res.status(500).json({
      error: "Internal server error",
      detail: {
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : "Error"
      }
    });
  }
};
