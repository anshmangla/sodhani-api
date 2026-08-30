import sys

target = '''// GET /api/top-gainers?limit=10'''

insertion = '''// GET /api/recent-ipos
// Reads the ipo_checkpoint.json and returns IPOs from the last 14 days
router.get('/recent-ipos', asyncHandler(async (req, res) => {
  const fs = require('fs').promises;
  const checkpointPath = process.env.IPO_CHECKPOINT_PATH || '/opt/sodhani-screener/ipo_checkpoint.json';
  
  try {
    await fs.access(checkpointPath);
  } catch {
    // File does not exist or inaccessible
    res.json([]);
    return;
  }

  let checkpoints: Record<string, number>;
  try {
    const fileData = await fs.readFile(checkpointPath, 'utf-8');
    checkpoints = JSON.parse(fileData);
  } catch (err) {
    console.error("Failed to parse IPO checkpoint:", err);
    res.status(500).json({ error: "Failed to read IPO data" });
    return;
  }

  // Filter for last 14 days
  const twoWeeksAgo = (Date.now() / 1000) - (14 * 24 * 60 * 60);
  
  const recentTickers = Object.entries(checkpoints)
    .filter(([ticker, timestamp]) => timestamp >= twoWeeksAgo)
    .sort((a, b) => b[1] - a[1])
    .map(entry => entry[0]);

  if (recentTickers.length === 0) {
    res.json([]);
    return;
  }

  // Fetch names from company_stock
  const result = await pool.query(
    \SELECT "TckrSymb", "FinInstrmNm" FROM company_stock WHERE "TckrSymb" = ANY(\)\,
    [recentTickers]
  );

  const nameMap = new Map();
  for (const row of result.rows) {
    nameMap.set(row.TckrSymb, row.FinInstrmNm);
  }

  const output = recentTickers.map(ticker => ({
    code: ticker,
    name: nameMap.get(ticker) || ticker,
    listed_at: checkpoints[ticker] * 1000
  }));

  res.json(output);
}));

'''

with open('src/routes/market.ts', 'r') as f:
    content = f.read()

content = content.replace(target, insertion + target)

with open('src/routes/market.ts', 'w') as f:
    f.write(content)
