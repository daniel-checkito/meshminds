// POST {keyword} → fast keyword analysis via Claude Haiku
// Returns search volume, competition, score, and tips

const _rl = new Map();
function checkRate(ip, limit, windowMs) {
  const now = Date.now();
  const entry = _rl.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count++;
  _rl.set(ip, entry);
  if (_rl.size > 300) { for (const [k, v] of _rl) { if (Date.now() > v.resetAt) _rl.delete(k); } }
  return entry.count <= limit;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const clientIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!checkRate(clientIp, 10, 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }

  const { keyword } = req.body || {};
  if (!keyword || keyword.trim().length < 2) {
    return res.status(400).json({ error: 'keyword is required' });
  }
  if (keyword.trim().length > 80) {
    return res.status(400).json({ error: 'Keyword too long (max 80 chars)' });
  }

  const kw = keyword.trim().toLowerCase();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI not configured' });

  const prompt = `You are an expert in Etsy SEO and 3D printing product market research. Analyse this Etsy/handmade marketplace keyword: "${kw}"

Return ONLY valid JSON - no markdown, no explanation, no code fences.

{
  "keyword": "<the keyword as searched>",
  "monthlySearches": "<estimated monthly Etsy search volume, e.g. '2,400' or '8,100–12,000'>",
  "etsyListings": "<estimated number of competing Etsy listings, e.g. '4,200' or '40,000+'>",
  "competition": "<one of: Very Low | Low | Medium | High | Very High>",
  "score": <integer 0–100, sellability score for this keyword - high search + low competition = high score>,
  "verdict": "<one short sentence verdict>",
  "trend": "<one of: Rising | Stable | Seasonal | Declining>",
  "avgPrice": "<estimated average sell price on Etsy for products with this keyword, e.g. '$18–32'>",
  "topTip": "<one concrete actionable tip for a 3D print seller targeting this keyword, max 2 sentences>",
  "relatedKeywords": ["<3–5 related long-tail keyword suggestions that have lower competition>"]
}

Use your knowledge of Etsy search trends, 3D printing niches, and handmade marketplace dynamics. Be specific and realistic - do not inflate search volumes. If it's a generic commodity keyword (phone holder, cable clip, keychain) reflect the very high competition accurately.`;

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 25000);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ac.signal,
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(502).json({ error: 'AI error: ' + txt.slice(0, 100) });
    }

    const aiData = await r.json();
    const raw = aiData.content?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ error: 'Malformed AI response' });

    const result = JSON.parse(jsonMatch[0]);
    return res.status(200).json(result);
  } catch (e) {
    if (e.name === 'AbortError') return res.status(504).json({ error: 'Request timed out' });
    return res.status(500).json({ error: e.message || 'Unknown error' });
  } finally {
    clearTimeout(timeout);
  }
};
