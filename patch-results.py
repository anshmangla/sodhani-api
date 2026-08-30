import sys

target = '''// GET /api/recent-ipos'''

insertion = '''// GET /api/recent-results
// Reads the screener_checkpoint.json and returns tickers updated in the last 14 days
router.get('/recent-results', asyncHandler(async (req, res) => {
  const fs = require('fs').promises;
  const checkpointPath = process.env.SCREENER_CHECKPOINT_PATH || '/opt/sodhani-screener/screener_checkpoint.json';
  
  try {
    await fs.access(checkpointPath);
  } catch {
    res.json([]);
    return;
  }

  let checkpoints: Record<string, number>;
  try {
    const fileData = await fs.readFile(checkpointPath, 'utf-8');
    checkpoints = JSON.parse(fileData);
  } catch (err) {
    console.error("Failed to parse screener checkpoint:", err);
    res.status(500).json({ error: "Failed to read screener data" });
    return;
  }

  // Filter for last 14 days
  const twoWeeksAgo = (Date.now() / 1000) - (14 * 24 * 60 * 60);
  
  // Sort descending by timestamp
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
    updated_at: checkpoints[ticker] * 1000 // ms timestamp for frontend
  }));

  res.json(output);
}));

'''

with open('src/routes/market.ts', 'r') as f:
    content = f.read()

content = content.replace(target, insertion + target)

with open('src/routes/market.ts', 'w') as f:
    f.write(content)
