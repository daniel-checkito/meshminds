/* ── In-memory rate limiter (resets on cold start; good enough for serverless abuse prevention) ── */
const _rl = new Map();
function checkRate(ip, limit, windowMs) {
  const now = Date.now();
  const entry = _rl.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count++;
  _rl.set(ip, entry);
  /* Clean up old entries occasionally */
  if (_rl.size > 500) { for (const [k, v] of _rl) { if (Date.now() > v.resetAt) _rl.delete(k); } }
  return entry.count <= limit;
}

/* Known 3D print platform hostnames */
const ALLOWED_HOSTS = ['makerworld.com', 'printables.com', 'cults3d.com', 'thingiverse.com',
  'myminifactory.com', 'thangs.com', 'cgtrader.com', 'turbosquid.com', 'grabcad.com'];
function isAllowedUrl(raw) {
  if (!raw) return false;
  try {
    const u = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
    return ALLOWED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  /* ── Bot protection ── */
  const clientIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();

  /* Rate limit: max 8 requests per IP per 10 minutes (burst protection) */
  if (!checkRate(clientIp, 8, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a few minutes before trying again.' });
  }

  /* Reject requests not from a browser (no Accept header with text/html) */
  const ua = req.headers['user-agent'] || '';
  const isBotUa = !ua || /^(curl|wget|python|go-http|java|ruby|php|axios|node-fetch|undici|httpie)/i.test(ua);
  if (isBotUa) {
    return res.status(403).json({ error: 'Automated requests are not allowed.' });
  }

  /* Daily quota: anonymous 25/day, free logged-in 50/day, pro unlimited */
  let _quotaUser = null, _quotaIsPro = false;
  let _quotaIpHash = '';
  try {
    const { getUser, extractToken, hashIp, checkDailyLimit, adminQuery } = require('./_supabase');
    _quotaIpHash = hashIp(clientIp);
    const _tok = extractToken(req);
    if (_tok) {
      _quotaUser = await getUser(_tok);
      if (_quotaUser?.id) {
        try {
          const profiles = await adminQuery({
            table: 'profiles',
            filters: `id=eq.${_quotaUser.id}`,
            select: 'is_premium,premium_until',
          });
          const p = profiles?.[0];
          _quotaIsPro = !!(p && p.is_premium && (!p.premium_until || new Date(p.premium_until) > new Date()));
        } catch {}
      }
    }
    const quota = await checkDailyLimit({
      userId: _quotaUser?.id || null,
      ipHash: _quotaIpHash,
      isPro: _quotaIsPro,
    });
    if (!quota.allowed) {
      const upgradeMsg = _quotaUser
        ? `You've used all ${quota.limit} free scans today. Upgrade to Pro for unlimited scans.`
        : `You've used all ${quota.limit} free scans today. Sign up for a free account to get 50 scans/day, or upgrade to Pro for unlimited.`;
      return res.status(429).json({ error: upgradeMsg, quotaExceeded: true, used: quota.used, limit: quota.limit, isLoggedIn: !!_quotaUser });
    }
  } catch { /* fail open if Supabase is unreachable */ }

  const body = req.body || {};
  const isIdeaMode = body.mode === 'idea';

  /* Validate URL is from a supported platform (URL mode only) */
  const rawBodyUrl = body.url || '';
  if (!isIdeaMode && rawBodyUrl && !isAllowedUrl(rawBodyUrl)) {
    return res.status(400).json({ error: 'URL must be from a supported 3D model platform (MakerWorld, Printables, Cults3D, etc.)' });
  }

  /* Validate idea mode */
  if (isIdeaMode) {
    const ideaText = (body.ideaText || '').trim();
    if (ideaText.length < 15) {
      return res.status(400).json({ error: 'idea_too_short: Please describe your idea in more detail (at least 15 characters) so we can give you an accurate score.' });
    }
  }

  const {
    url = '',
    description = '',
    mode = 'url',
    ideaText = '',
    ideaType = '',
    ideaBuyer = '',
    ideaUsp = '',
    ideaChannels = '',
    category,
    marketplace,
    priceRange,
    printTime,
    material,
    sellerGoal,
    printerCount,
    printerType,
    experience,
    weeklyTime,
    activeMarkets,
    socialMedia,
    sellFrom,
    sellTo,
    legalFlags,
  } = body;

  const activeMarketsStr = Array.isArray(activeMarkets)
    ? activeMarkets.join(', ')
    : activeMarkets || 'none';
  const socialMediaStr = Array.isArray(socialMedia)
    ? socialMedia.join(', ')
    : socialMedia || 'none';
  const legalFlagsStr = Array.isArray(legalFlags)
    ? legalFlags.join(', ')
    : legalFlags || 'none';

  // ── 1. Firecrawl scrape (product + Etsy search in parallel when possible) ──
  let productContext = '';
  let imageUrl = '';
  let sourceUrl = '';
  let etsyRealData = '';

  const rawUrl = url || '';
  const scrapeUrl = rawUrl.startsWith('http')
    ? rawUrl
    : rawUrl
    ? 'https://' + rawUrl
    : '';

  // Extract keywords from the URL slug so we can run Etsy search in parallel
  function keywordsFromUrl(u) {
    try {
      const path = new URL(u).pathname;
      // Most 3D model platforms use slugs like /model/123456-fidget-cube-v2
      const slug = path.split('/').pop() || '';
      // Remove leading ID (digits + hyphen) and version suffixes
      const cleaned = slug
        .replace(/^\d+-/, '')         // leading "123456-"
        .replace(/-v\d+(\.\d+)?$/, '') // trailing "-v2" or "-v1.2"
        .replace(/-/g, ' ')
        .replace(/[^a-zA-Z0-9\s]/g, ' ')
        .trim();
      const words = cleaned
        .split(/\s+/)
        .filter(w => w.length > 2 && !/^(the|and|for|with|that|this|from|into|your|model|print|3d|stl)$/i.test(w))
        .slice(0, 4);
      return words.join(' ');
    } catch (_) { return ''; }
  }

  // Keyword cache — survives within a hot lambda instance, ~24h TTL.
  // Hit rate is meaningful for popular categories without growing memory.
  if (!global.__SCRAPE_CACHE__) global.__SCRAPE_CACHE__ = new Map();
  const scrapeCache = global.__SCRAPE_CACHE__;
  const SCRAPE_TTL_MS = 24 * 60 * 60 * 1000;
  async function cachedScrape(cacheKey, url, waitMs, abortMs) {
    const now = Date.now();
    const hit = scrapeCache.get(cacheKey);
    if (hit && now - hit.at < SCRAPE_TTL_MS) return hit.md;
    const data = await firecrawlScrape(url, waitMs, abortMs);
    const md = data?.data?.markdown || '';
    if (md) {
      scrapeCache.set(cacheKey, { md, at: now });
      if (scrapeCache.size > 400) {
        const firstKey = scrapeCache.keys().next().value;
        scrapeCache.delete(firstKey);
      }
    }
    return md;
  }
  async function fetchEtsy(kw) {
    if (!kw) return '';
    return cachedScrape('etsy:' + kw.toLowerCase().trim(),
      `https://www.etsy.com/search?q=${encodeURIComponent(kw)}&explicit=1&sort_on=most_relevant`,
      500, 10000);
  }
  // eBay sold listings — real completed-sale prices, gold for spec/technical items
  async function fetchEbay(kw) {
    if (!kw) return '';
    return cachedScrape('ebay:' + kw.toLowerCase().trim(),
      `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(kw)}&LH_Sold=1&LH_Complete=1&_sop=13`,
      500, 9000);
  }
  // Amazon Handmade — cross-platform demand check on similar gift items
  async function fetchAmazon(kw) {
    if (!kw) return '';
    return cachedScrape('amzn:' + kw.toLowerCase().trim(),
      `https://www.amazon.com/s?k=${encodeURIComponent(kw)}&i=handmade`,
      500, 9000);
  }

  /* ── Direct HTML fetch + parse for known platforms (skips Firecrawl) ──
   * Returns { productContext, imageUrl, sourceUrl } in the same shape as
   * extractProductContext, or null on any failure so caller can fall back. */
  async function directFetchProduct(targetUrl) {
    let host = '';
    try { host = new URL(targetUrl).hostname.replace(/^www\./, ''); } catch { return null; }
    const isMakerWorld = /(^|\.)makerworld\.com$/.test(host);
    const isPrintables = /(^|\.)printables\.com$/.test(host);
    const isCults = /(^|\.)cults3d\.com$/.test(host);
    if (!isMakerWorld && !isPrintables && !isCults) return null;

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6000);
    let html = '';
    try {
      const r = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: ac.signal,
        redirect: 'follow',
      });
      if (!r.ok) return null;
      html = await r.text();
    } catch { return null; } finally { clearTimeout(t); }
    if (!html || html.length < 500) return null;

    try {
      const meta = (prop) => {
        // og:* / twitter:* / name=description meta tags (any attribute order)
        const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i');
        const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
        const m = html.match(re1) || html.match(re2);
        return m ? decodeEntities(m[1].trim()) : '';
      };
      const decodeEntities = (s) => s
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
      const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      const title = meta('og:title') || meta('twitter:title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').trim();
      const description = meta('og:description') || meta('twitter:description') || meta('description') || '';
      const imageUrl = meta('og:image') || meta('twitter:image') || '';
      const sourceURL = meta('og:url') || targetUrl;

      // Strip scripts/styles for body-text scanning
      const bodyText = stripTags(
        html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      );
      const bodyTextDecoded = decodeEntities(bodyText);

      // ── Stat extraction (works across all 3 platforms with platform-specific tweaks) ──
      const stats = {};

      // Author / designer
      let author = '';
      if (isMakerWorld) {
        const m = html.match(/"(?:userName|nickName|nick_name|name)"\s*:\s*"([^"]{2,60})"/);
        if (m) author = decodeEntities(m[1]);
      }
      if (!author) {
        const m = html.match(/<meta[^>]+(?:name|property)=["'](?:author|article:author|og:article:author)["'][^>]*content=["']([^"']+)["']/i);
        if (m) author = decodeEntities(m[1]);
      }
      if (!author && isCults) {
        const m = html.match(/by\s+<[^>]*>\s*([^<\s][^<]{1,40})</i);
        if (m) author = m[1].trim();
      }

      // Numeric counters — match labels like "Downloads", "Likes", "Makes", "Collections"
      const num = (re) => {
        const m = bodyTextDecoded.match(re);
        if (!m) return null;
        return m[1].replace(/\s+/g, '');
      };
      const fmtNum = (s) => s; // keep "8.4k" as-is; integers stay integers

      let downloads = num(/([\d.,]+\s*[kKmM]?)\s*(?:Downloads?|Downloaded by|downloads)/) || null;
      let likes = num(/([\d.,]+\s*[kKmM]?)\s*(?:Likes?|Liked by)/) || null;
      let makes = num(/([\d.,]+\s*[kKmM]?)\s*Makes?/) || null;
      let collections = num(/([\d.,]+\s*[kKmM]?)\s*(?:Collections?|Collected)/) || null;

      // License — broad scan covers CC, MakerWorld Standard/Commercial, Personal Use, Print-for-Sale
      let license = '';
      const licMatch = bodyTextDecoded.match(/(Creative Commons[^.\n]{0,80}|CC0[^.\n]{0,40}|CC BY[^.\n]{0,40}|Standard MakerWorld License[^.\n]{0,40}|Commercial(?: Use)? License[^.\n]{0,40}|Personal Use(?: Only)?[^.\n]{0,40}|Non-?Commercial[^.\n]{0,40}|Print[- ]for[- ]Sale[^.\n]{0,40})/i);
      if (licMatch) license = licMatch[0].trim().replace(/\s+/g, ' ');

      // Cults3D price (or "Free")
      let price = '';
      if (isCults) {
        const m = bodyTextDecoded.match(/(Free|US\$\s?[\d.,]+|€\s?[\d.,]+|£\s?[\d.,]+|\$\s?[\d.,]+)/);
        if (m) price = m[1];
      }

      // Build context block — same shape as extractProductContext output
      let productContext = `URL: ${sourceURL}\nTITLE: ${title}\nDESCRIPTION: ${description}\n`;
      if (author) productContext += `AUTHOR: ${author}\n`;
      if (downloads) productContext += `DOWNLOADS: ${downloads}\n`;
      if (likes) productContext += `LIKES: ${likes}\n`;
      if (makes) productContext += `MAKES: ${makes}\n`;
      if (collections) productContext += `COLLECTIONS: ${collections}\n`;
      if (price) productContext += `PRICE: ${price}\n`;
      if (license) productContext += `LICENSE: ${license}\n`;

      // Add a short slice of body text for Claude's context (cleaned, capped)
      const cleanedBody = bodyTextDecoded
        .replace(/\b(Follow|Boost|Post|Sign in|Sign up|Log in|Cookie|cookies|Subscribe|Newsletter)\b[^.\n]{0,40}/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      productContext += `\nPAGE CONTENT (cleaned):\n${cleanedBody.substring(0, 2500)}`;

      if (!title && !description) return null; // nothing useful parsed
      return { productContext, imageUrl, sourceUrl: sourceURL };
    } catch { return null; }
  }

  /* Race direct fetch against a 6s timeout — guarantees we never block longer than that */
  async function directFetchProductRaced(targetUrl) {
    return Promise.race([
      directFetchProduct(targetUrl),
      new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
    ]).catch(() => null);
  }

  async function firecrawlScrape(targetUrl, waitMs, abortMs) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), abortMs);
    try {
      const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
        body: JSON.stringify({ url: targetUrl, formats: ['markdown'], waitFor: waitMs }),
        signal: ac.signal,
      });
      return r.ok ? await r.json() : null;
    } catch (_) { return null; } finally { clearTimeout(t); }
  }

  function parseEtsyData(md, query) {
    const countMatch = md.match(/(\d[\d,]+)\s*results?/i);
    let result = '';
    if (countMatch) {
      const n = parseInt(countMatch[1].replace(/,/g, ''), 10);
      if (n > 0) {
        result = `REAL ETSY SEARCH DATA (live scrape for "${query}"): ${n.toLocaleString()} total listings found. Use this as the primary anchor for market.etsyListings — do not estimate lower than this number.`;
      }
    }
    // Extract price signals from top listings (Etsy shows USD $ by default)
    const priceMatches = [...md.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)];
    if (priceMatches.length >= 3) {
      const prices = priceMatches.slice(0, 10).map(m => parseFloat(m[1])).filter(p => p > 1 && p < 500);
      if (prices.length >= 2) {
        const avgUsd = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
        const avgEur = Math.round(avgUsd * 0.93);
        if (result) result += ` Average sell price from top listings: ~$${avgUsd} / ~€${avgEur}.`;
      }
    }
    return result;
  }

  // Parse competitor listings from Etsy + eBay + Amazon Handmade markdown
  function parseCompetitorRaw(etsyMd, extraMd) {
    const seen = new Set();
    const items = [];

    // Match [Title](etsy_listing_url) together so title is never from a different listing
    const etsyListingRe = /\[([^\]]{5,120})\]\((https?:\/\/(?:www\.)?etsy\.com\/listing\/(\d+)\/[a-z0-9-]+)[^)]*\)/gi;

    // Extract Etsy listing URLs + context from Etsy search markdown
    if (etsyMd) {
      let m;
      while ((m = etsyListingRe.exec(etsyMd)) !== null && items.length < 4) {
        const listingId = m[3];
        if (seen.has(listingId)) continue;
        seen.add(listingId);
        const url = m[2].split('?')[0];
        // Price and reviews come AFTER the URL line
        const after = etsyMd.slice(m.index + m[0].length, m.index + m[0].length + 300);
        const priceMatch = after.match(/\$\s*(\d+(?:\.\d{2})?)/);
        const reviewMatch = after.match(/\((\d[\d,]+)\s*(?:reviews?|sales?|ratings?)?\)/i);
        const soldMatch = after.match(/(\d[\d,]+)\s*sold/i);
        items.push({
          url,
          title: m[1].replace(/\s+/g, ' ').trim(),
          price: priceMatch ? `$${priceMatch[1]}` : null,
          reviews: reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, ''), 10) : null,
          sold: soldMatch ? parseInt(soldMatch[1].replace(/,/g, ''), 10) : null,
          source: 'etsy',
        });
      }
    }

    // Extract results from eBay sold + Amazon Handmade markdown
    if (extraMd) {
      const linkRe = /\[([^\]]{5,140})\]\((https?:\/\/(?:www\.)?(?:ebay\.com\/itm|ebay\.co\.uk\/itm|amazon\.com\/(?:[^)]*?\/dp\/|dp\/|gp\/product\/)|amazon\.co\.uk\/(?:[^)]*?\/dp\/|dp\/))[^)\s]+)\)/gi;
      let d;
      while ((d = linkRe.exec(extraMd)) !== null && items.length < 6) {
        const rawUrl = d[2].split('?')[0];
        const key = rawUrl.replace(/https?:\/\/(www\.)?/, '').substring(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        const after = extraMd.slice(d.index + d[0].length, d.index + d[0].length + 400);
        const priceMatch = after.match(/(?:US\s*)?\$\s*(\d+(?:[.,]\d{2})?)/);
        const reviewMatch = after.match(/(\d[\d,]+)\s*(?:ratings?|reviews?)/i);
        const soldMatch = after.match(/(\d[\d,]+)\s*sold/i);
        const domain = rawUrl.match(/https?:\/\/(?:www\.)?([^/]+)/)?.[1] || 'unknown';
        const isEbay = domain.includes('ebay');
        items.push({
          url: rawUrl,
          title: d[1].replace(/\s+/g, ' ').trim(),
          price: priceMatch ? `$${priceMatch[1].replace(',', '.')}` : null,
          reviews: reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, ''), 10) : null,
          sold: soldMatch ? parseInt(soldMatch[1].replace(/,/g, ''), 10) : null,
          source: isEbay ? 'ebay-sold' : 'amazon-handmade',
        });
      }
    }

    return items.slice(0, 5);
  }

  const urlKeywords = scrapeUrl ? keywordsFromUrl(scrapeUrl) : '';

  let competitorRaw = [];

  // ── Idea mode: skip product scrape, use user description as context ──
  if (isIdeaMode) {
    const ideaKeywords = ideaText.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !/^(the|and|for|with|that|this|from|into|your|model|print|3d|stl|want|make|sell|idea)$/i.test(w))
      .slice(0, 5).join(' ');
    productContext = `PRODUCT IDEA DESCRIPTION (not a real listing yet):
"${ideaText.trim()}"
- Product type: ${ideaType || 'not specified'}
- Target buyer: ${ideaBuyer || 'not specified'}
- Unique selling point: ${ideaUsp || 'not specified'}
- Preferred sales channels (seller-stated): ${ideaChannels || 'not specified — pick the best channel for this product'}
${ideaChannels ? '- IMPORTANT: tailor strategy.bestPlatform and strategy.platformAdvice to these specific channels. If "not-sure" is among them, recommend the single best fit and briefly justify; if multiple specific channels are picked, prioritise them in order of fit and explain why.' : ''}`;
    if (ideaKeywords) {
      const [etsyMd, ebayMd, amazonMd] = await Promise.all([
        fetchEtsy(ideaKeywords), fetchEbay(ideaKeywords), fetchAmazon(ideaKeywords),
      ]);
      if (etsyMd) etsyRealData = parseEtsyData(etsyMd, ideaKeywords);
      competitorRaw = parseCompetitorRaw(etsyMd, ebayMd + '\n\n' + amazonMd);
    }
  } else if (scrapeUrl && urlKeywords) {
    // Product page + 3 demand sources in parallel.
    // Try direct HTML fetch+parse first (MakerWorld/Printables/Cults3D) — saves ~3-6s and ~$0.005.
    const [direct, etsyMd, ebayMd, amazonMd] = await Promise.all([
      directFetchProductRaced(scrapeUrl),
      fetchEtsy(urlKeywords), fetchEbay(urlKeywords), fetchAmazon(urlKeywords),
    ]);
    if (direct) {
      productContext = direct.productContext;
      imageUrl = direct.imageUrl;
      sourceUrl = direct.sourceUrl;
    } else {
      const fcData = await firecrawlScrape(scrapeUrl, 1000, 16000);
      if (fcData) {
        const extracted = extractProductContext(fcData);
        productContext = extracted.productContext;
        imageUrl = extracted.imageUrl;
        sourceUrl = extracted.sourceUrl;
      }
    }
    if (etsyMd) etsyRealData = parseEtsyData(etsyMd, urlKeywords);
    competitorRaw = parseCompetitorRaw(etsyMd, ebayMd + '\n\n' + amazonMd);
  } else if (scrapeUrl) {
    // No URL keywords — scrape product first, derive keywords, then search.
    // Try direct fetch first for known platforms; fall back to Firecrawl.
    const direct = await directFetchProductRaced(scrapeUrl);
    if (direct) {
      productContext = direct.productContext;
      imageUrl = direct.imageUrl;
      sourceUrl = direct.sourceUrl;
    } else {
      const fcData = await firecrawlScrape(scrapeUrl, 1000, 16000);
      if (fcData) {
        const extracted = extractProductContext(fcData);
        productContext = extracted.productContext;
        imageUrl = extracted.imageUrl;
        sourceUrl = extracted.sourceUrl;
      }
    }
    const titleMatch = productContext.match(/TITLE:\s*(.+)/);
    const rawTitle = (titleMatch?.[1] || description || '').trim();
    const postScrapeKeywords = rawTitle
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !/^(the|and|for|with|that|this|from|into|your|model|print|3d|stl)$/i.test(w))
      .slice(0, 4)
      .join(' ');
    if (postScrapeKeywords) {
      const [etsyMd, ebayMd, amazonMd] = await Promise.all([
        fetchEtsy(postScrapeKeywords), fetchEbay(postScrapeKeywords), fetchAmazon(postScrapeKeywords),
      ]);
      if (etsyMd) etsyRealData = parseEtsyData(etsyMd, postScrapeKeywords);
      competitorRaw = parseCompetitorRaw(etsyMd, ebayMd + '\n\n' + amazonMd);
    }
  }

  // Fall back to description text if no scraped context
  if (!productContext) {
    const fallback = description || url || '';
    if (fallback) productContext = `DESCRIPTION: ${fallback}`;
  }

  // ── 2. Build the Claude prompt (ported from n8n "Message a model" node) ──
  // Build competitor context string for the prompt
  const competitorContext = competitorRaw.length > 0
    ? 'LIVE COMPETITOR LISTINGS (scraped from Etsy + eBay sold listings + Amazon Handmade — these are REAL results. eBay-sold prices are completed-sale data, not asking prices):\n' +
      competitorRaw.map((c, i) =>
        `${i + 1}. URL: ${c.url}\n   Title: "${c.title}"` +
        (c.price ? `\n   Price: ${c.price}` : '') +
        (c.reviews ? `\n   Reviews: ${c.reviews}` : '') +
        (c.sold ? `\n   Sold: ${c.sold}` : '') +
        `\n   Source: ${c.source}`
      ).join('\n\n') +
      '\nFor each competitor above, include it in the "competitors" array with your analysis of why it works and estimated monthly sales.'
    : '';

  // ── Category match against /data/market-data.json ─────────────────────────
  // Picks the single best category and injects its real numbers into the prompt
  // so the AI cites ground-truth Etsy averages instead of guessing.
  const matchResult = matchMarketCategoryWithConfidence({
    sellerCategory: category,
    productContext,
    ideaText,
    title: (productContext.match(/TITLE:\s*(.+)/) || [])[1],
  });
  const matchedMarket = matchResult?.category || null;
  const matchConfidence = matchResult?.confidence || 0;

  // Live blend: pull recent observation medians for this category from Supabase
  // (cached 10 min in-memory, defensive timeout, falls back to baseline silently)
  const recentObs = matchedMarket ? await getRecentObservations(matchedMarket.id) : null;

  const marketBlock = matchedMarket
    ? `MATCHED CATEGORY DATA (use these as anchors for market.searchVolume, market.etsyListings, market.etsyAvgPrice, and revenue.sellPrice ceiling):
- Category: ${matchedMarket.name}
- Baseline Etsy average price: €${matchedMarket.etsy_avg_price}
- Baseline monthly search volume: ${matchedMarket.search_volume_monthly}
- Baseline competition level: ${matchedMarket.competition_level}
- Price ceiling: €${matchedMarket.price_ceiling}
- Top-converting keywords: ${matchedMarket.top_keywords.join(', ')}
- Category notes: ${matchedMarket.notes}
${recentObs && recentObs.count >= 5 ? `RECENT OBSERVED DATA (median across ${recentObs.count} real scans of this category in the last 90 days — weight these heavily, they reflect the live market):
- Median Etsy listings: ${recentObs.medianListings ?? 'n/a'}
- Median average price: ${recentObs.medianPrice != null ? '€' + recentObs.medianPrice : 'n/a'}
- Median monthly search volume: ${recentObs.medianSearch ?? 'n/a'}
` : ''}`
    : '';

  const prompt = `You are an expert Etsy seller, 3D printing business analyst, and product compliance specialist. Your job is to evaluate whether a 3D printed model is worth selling — and whether 3D printing is even the right manufacturing method.
Analyse the product data below and return ONLY a valid JSON object — no markdown, no explanation, no code fences.
Product data:
${productContext}
${marketBlock}${etsyRealData ? etsyRealData + '\n' : ''}${competitorContext ? competitorContext + '\n' : ''}
Image URL (use as product.image if valid, otherwise null):
${imageUrl}
Source URL: ${sourceUrl}
SELLER INPUTS (from questionnaire — use ALL of these to personalise every section of the analysis):
- Category: ${category || 'not specified'}
- Target marketplace: ${marketplace || 'Etsy'}
- Price range: ${priceRange || 'not specified'}
- Print time per unit: ${printTime || 'not specified'}
- Material: ${material || 'not specified'}
- Seller goal: ${sellerGoal || 'not specified'}
- Number of printers: ${printerCount || 'not specified'}
- Printer type: ${printerType || 'not specified'}
- Seller experience level: ${experience || 'not specified'}
- Weekly time available: ${weeklyTime || 'not specified'}
- Already selling on: ${activeMarketsStr}
- Social media channels: ${socialMediaStr}
- Selling from (country): ${sellFrom || 'not specified'}
- Selling to (markets): ${sellTo || 'WORLDWIDE'}
- Legal / IP flags noted by seller: ${legalFlagsStr}
WHAT MAKES A 3D PRINT WORTH SELLING — use this to calibrate score, verdict, and strategy:
GREEN FLAGS (boosts score): high personalisation or customisation potential (names, sizes, colours); complex geometry that injection-moulding cannot do cheaply; strong gifting angle (personalised items for weddings, babies, pets); passionate niche community (DnD players, mechanical keyboard enthusiasts, specific game fandoms); replacement parts for discontinued products; items where the maker or craft story adds perceived value; clear functional problem being solved; Etsy top sellers in this niche earning more than €1k/month; low filament cost relative to sell price (more than 70% gross margin); designer or sculptural aesthetic that repositions a utility item as a lifestyle or décor object (bathroom accessories, planters, desk organisers) — 'shelfie-worthy' design commands a 2–3× premium over generic equivalents; strong visual appeal for social media and influencer photography; boutique retail or gift shop potential — independent home stores and interior boutiques offer high margins and no Etsy fees.
RED FLAGS (lowers score): commodity item available cheaper on Amazon or AliExpress (phone holders, cable clips below €5); character or logo from Disney, Nintendo, Marvel, Harry Potter, Pokémon, or any other major IP (Etsy enforcement is aggressive and well-documented); item where plastic appearance is a disadvantage (premium jewellery, food contact); truly commodity design where the top Etsy listings are visually interchangeable — high listing count alone is NOT a red flag if the design is clearly differentiated or has a strong aesthetic identity; print time over 12h at sell price under €20 (bad hourly return); bulky or heavy item with high shipping cost relative to sell price; product that exceeds the seller's stated printer build volume without an elegant split strategy.
MARKET KNOWLEDGE — treat as ground truth for calibrating estimates:
- Filament cost: approx. €0.02–0.03/g PLA. Use €0.025/g as the default when estimating print cost unless seller provided different values. Factor 30–50g average for small desk and functional items; scale up for larger prints.
- Print failure rate: assume 5–8% on complex geometries. Add ~6% to raw print cost as failure overhead.
- Platform that converts best: Etsy strongly outperforms eBay for gift, décor, and novelty items — estimated 3:1 ratio or higher. eBay is only relevant for technical parts, replacement components, or items buyers search by specification.
- Etsy audience: 55% of Etsy traffic is USA-based. 58% female. Over 50% under 35. Products must appeal to a US gift-buyer mindset to maximise reach.
- Price ceiling by category (market-verified): functional desk items (monitor stands, organisers) — buyers resist above €35–40. Novelty and gift items — ceiling is higher, €20–55 depending on personalisation. Dice and DnD accessories — strong buyer willingness up to €30. Planters — generic designs struggle on Etsy; designer or character-themed planters command €15–30 and perform well in boutique retail and via influencer gifting. Bathroom accessories (toothbrush holders, soap dispensers, cotton jar lids) — purely functional designs top out at €20–25; designer or sculptural pieces positioned as décor reach €30–50 in boutique stores or own shop. Lamps — €60–150 possible but require brand trust and an own website.
- Products that flop: generic phone holders and cable clips below €10 (Amazon undercuts at €2–6). Generic articulated dragons and flexi animals (10,000+ identical Etsy listings). Any item where drop-shipped versions exist at lower price. These are strong red flags — penalise score accordingly.
- COMPETITION CALIBRATION — real Etsy listing counts for known saturated categories. ALWAYS use these as hard anchors when estimating etsyListings — do not guess lower than these ranges: Fidget toys, fidget cubes, fidget spinners, fidget rings, sensory toys: 60,000–120,000 listings (extreme competition — score must reflect this). Articulated/flexi animals (dragons, fish, cats, dogs, octopus, sharks): 30,000–80,000 listings. Generic keychains with no character angle: 100,000+ listings. Generic cable clips, cord management: 20,000–40,000 listings. Generic phone stands/holders: 40,000–70,000 listings. Generic bookmarks: 50,000+ listings. Generic planters: 40,000–60,000 listings. Laptop stands/risers (generic): 10,000–15,000 listings. Dice towers and DnD accessories: 5,000–12,000 listings. Monitor stands/risers with unique angle: 3,000–8,000 listings. Miniatures (tabletop, busts): 8,000–20,000 listings. Custom name signs: 200,000+ listings but high personalisation differentiates effectively. AirPods/Apple Watch holders without IP: 8,000–15,000 listings. Bathroom accessories (toothbrush holders, dispensers): 25,000–50,000 listings. When the product clearly falls into a known-saturated category above, set etsyListings to the upper half of the range or higher — underestimating competition is the most common calibration error.
- Top-performing product patterns (market-verified): (1) Dice and DnD accessories — evergreen, passionate buyers, strong search volume. (2) Tech accessory holders (Echo Dot, AirPods, Apple Watch chargers) with pop-culture or character angle — high revenue but significant IP risk. (3) Personalised name items — evergreen, highest conversion rate, justifies €6–14 premium per order. (4) Planters with a twist (animal, food-themed, character-adjacent without licensed IP) — low competition relative to view counts. (5) Monitor stands and risers — very low competition vs. strong search volume, strong B2B angle for offices.
- Revenue benchmarks: top performers earn €500–€5,000/month. Mid-tier: €150–€500/month. Beginners with a proven product: €50–€200/month in first 6 months.
- Etsy SEO reality: keyword-dense titles, all 13 tags used, and long-tail descriptions matter as much as product quality. Review accumulation is a compounding moat — a new seller needs a strategy to get first reviews fast.
- Sales and discounts strategy: 25–30% off flash sales for 1–2 day windows create FOMO. Etsy notifies customers when a sale ends. Many top stores run a permanent 20% off to boost perceived value.
- B2B and retail angle: one B2B client (restaurant, office, event planner, interior designer, boutique home store) can equal weeks of B2C sales. Flag this when relevant — especially for monitor risers, table signs, menu holders, display stands, cable management, geometric décor, designer planters, and bathroom accessories. For visually striking décor items, also flag influencer gifting as a high-ROI launch tactic: 2–3 samples sent to home décor or bathroom micro-influencers (10k–100k followers) typically costs under €30 and can drive hundreds of Etsy visits.
- Etsy policy (March 2026): reselling prints is permitted when the seller has an appropriate commercial/print-for-sale license from the designer. Check the license shown in the scraped data. If the file is explicitly licensed for commercial use or selling prints: low Etsy ban risk. If the license is unclear or not visible: set etsyBanRisk to "medium" and tell the seller to check the model page license tab and consider messaging the designer directly to request a commercial license. If the file is marked personal use only / non-commercial: set etsyBanRisk to "high". Do NOT auto-flag as high simply because the URL is on MakerWorld, Printables, or another external repository.
SCORING CALIBRATION based on seller inputs:
- Seller goal = "testing": use conservative revenue projections (50% of median). goal = "side-hustle": median projections. goal = "business" or "scaling": optimistic projections (120–150% of median).
- Printer count: cap revenue at what the stated number of printers can realistically produce given the stated print time and a 16–18 hour usable print day. Do not project more units than the printers can physically output.
- Printer type = "resin": adjust manufacturing section to reflect resin strengths (detail, miniatures) and weaknesses (post-processing time, smaller build volume, REACH chemical compliance for skin-contact items). FDM: note layer-line visibility and how it affects buyer perception in this specific category.
- Experience = "new": reduce estimated sales velocity by 40%, add beginner strategy tips. Experience = "pro": full projected sales velocity.
- Weekly time = "<5h": apply a feasibility score penalty if the product requires more than 2h print time plus fulfilment per unit.
- Single-printer constraint: if print time per unit exceeds 4h and only 1 printer is available, flag the production bottleneck in strategy.topTips and cap monthly unit output accordingly (e.g. a 6h print on 1 printer = max ~2–3 units/day accounting for bed changes and failure rate).
- Décor positioning bonus: if the product has a strong designer or sculptural aesthetic that positions it as a lifestyle object rather than a generic utility item, add 8–10 points to the base score. Buyers pay significant premiums for 'shelfie-worthy' pieces regardless of material cost — this is a real market signal, not a soft factor.
SCORING CALIBRATION FOR "GENERIC BUT FIXABLE" PRODUCTS (this is the most common scoring mistake — read carefully):
- Many products look generic at first glance but become winners with the right niche angle. Do NOT score these in the 40–55 "marginal" band by default. Score them 55–70 ("Good for the right audience") IF you can name a specific, plausible repositioning angle in topTips. Score them lower only if no angle is realistically available.
- MODULAR / SYSTEM PRODUCTS (Gridfinity cases, IKEA Skadis holders, pegboard accessories, drawer organisers, modular wall systems): the platform itself is proven and has buyers. The scoring question is "is the SPECIFIC variant differentiated?" A generic Gridfinity case scores 50. The same case repositioned for handymen, photographers, fishing tackle, watchmakers, dental tools, tattoo supplies, electronics repair, or another defined audience scores 65–75. Always suggest 2–3 specific audiences to specialise for in topTips.
- HOST-PLATFORM ACCESSORIES (IKEA Skadis, Echo Dot, AirPods, GoPro, DJI, Apple Watch, Bambu/Prusa printer mods): the host platform brings buyers; the question is whether your add-on is more interesting than what IKEA/Apple/the manufacturer already sell themselves. Recommend a unique, hard-to-copy attachment angle. Mention that bestsellers exist on Etsy as proof of demand.
- DECORATIVE-ONLY PRODUCTS (wall letters, signs, sculptures, ornamental pieces): pure décor without a USE CASE underperforms. Always recommend converting them into something functional or giftable: fridge magnets (add magnet slot), adhesive-mountable wall pieces (recess for command strips), door signs, custom name gift sets, nursery personalised décor, wedding signage. Score 60–70 if a strong gift / personalisation angle exists, 40–50 if it's purely "looks nice on a shelf".
- NICHE / SPECIALIST CRAFT TOOLS (mending loom, darning loom, weaving tools, knitting accessories, leatherworking jigs, bookbinding presses): targeted niche audiences are GOOD, not bad. The scoring question is "does 3D printing offer a real advantage over what crafters already use (wood, metal, traditional makers on Etsy)?" If the design has a unique feature impossible in wood/metal (adjustable mechanism, integrated measurement, unusual geometry), score 60–70. If it's just a plastic version of an existing wooden tool with no advantage, score 35–50 and explicitly say the fix is to add a unique feature 3D printing enables.
- TOOTHBRUSH HOLDERS, BATHROOM ACCESSORIES, KITCHEN ORGANISERS: surprisingly low competition vs. search volume in many sub-niches. A generic version scores 50; a version targeted at a specific popular electric toothbrush model (Oral-B iO, Philips Sonicare DiamondClean, etc.) with eco/recycled-PETG marketing and useful extras (drip tray, replaceable insert, hygienic snap-clean design) scores 65–75. Always suggest these specific angles.
- WALL ORGANISERS / INTERIOR DÉCOR SYSTEMS: print time over 8h is a concern but not a killer if the product is strong on Pinterest/Instagram. These products sell on aesthetic — recommend Pinterest and interior-design influencer marketing in topTips. Score 60–70 if visually striking.
TOPTIPS QUALITY BAR — write like a friend who has actually sold this kind of product, not like a generic SEO blog:
- Be opinionated. State directly what the product is missing and what specific change would unlock it.
- Always name a specific niche, persona, or use case — never "find your audience" or "differentiate yourself".
- Compare to what's already on Etsy. Reference real-feeling buyer behaviour ("buyers searching 'Oral-B iO holder' bypass the generic toothbrush listings entirely").
- For marginal scores (40–60): one tip MUST name 2–3 concrete repositioning angles the seller could pick from. Another tip MUST identify the single biggest weakness (genericness, no use case, no 3D-printing advantage, license risk) and the exact fix.
- Avoid vague phrases: "make it unique", "stand out", "find a niche", "improve quality", "use better photos". Replace each with a concrete instruction.
COMPLIANCE CONTEXT — apply when generating copyright.legalDesc and the certificates array:
- EU (DE, FR, NL, etc.): GPSR (Dec 2024) always applies — EU Responsible Person + Declaration of Conformity required. CE for toys (EN 71), electronics (LVD+EMC), PPE. REACH for skin-contact/electrical. RoHS for electronics. Etsy requires GPSR statement for EU sellers.
- GB: UKCA replaces CE. UK Toys Regs 2011. REACH UK. Technical files 10 years.
- US: CPSC/CPSIA for children's products (third-party lab + Children's Product Certificate). ASTM F963-23. FCC Part 15. California Prop 65.
- CA: CCPSA. Health Canada toys regs. Bilingual labelling.
- AU: RCM mark for electrical. ACCC standards.
- JP: PSE for electrical. ST mark for toys.
- WORLDWIDE: apply strictest standard across all target markets.
- Use sellFrom and sellTo to determine which compliance frameworks apply. Flag international shipping cost impact when relevant to the seller's specific country and target markets.
PLATFORM STRATEGY:
- Etsy: best for handmade gifts, décor, novelty (~60% US buyers). CRITICAL (March 2026): seller must have personally designed or substantially hand-finished the item — reselling downloaded STL prints is prohibited and risks suspension. Fees: ~10% + €0.20/listing.
- eBay: better for parts/components buyers search by spec. No handmade requirement. Sellers shipping domestically or regionally can undercut international competitors on shipping time and cost.
- STL marketplaces (MakerWorld, Printables, Cults3D): passive income, no fulfilment.
- Local marketplaces (Kleinanzeigen, Facebook Marketplace, Craigslist, etc.): best for heavy/bulky where shipping kills margin. Zero CAC.
- B2B cold outreach: identify local businesses relevant to the product (offices, restaurants, event planners, interior designers, boutique home stores, bathroom accessory shops) and reach out with a product photo and price list. One B2B client = weeks of B2C revenue. For décor-forward products, also flag influencer gifting (2–3 samples to micro-influencers in home décor or bathroom aesthetics niches, 10k–100k followers) as a high-ROI launch tactic.
- Own shop: best long-term margins but needs traffic; viable only after proven product + audience.
MANUFACTURING METHOD ANALYSIS — assess whether FDM/SLA is the right method:
1. 3D printing excels for: high customisation/personalisation, complex geometry, low volumes (<200/month), zero tooling cost.
2. Wrong method when: flat/2D design (laser cutting faster), food-safe smooth surface required (FDM layer lines fail EU Reg 10/2011 + FDA 21 CFR 177), high simple-geometry volumes (injection mould cost-effective above ~500/month), commodity available cheaper off-shelf.
3. Buyer perception: handcrafted/unique → 3D printing fits. Mass-manufactured look expected → disappoints.
4. Printer build volume: if the seller specified a printer type, flag products that may exceed its typical build volume and note whether a split/join line would affect aesthetics or strength.
Your analysis must follow this EXACT JSON schema. Every field is required.
{
  "score": <integer 0–100, overall seller potential>,
  "verdict": <string — pick exactly: 80-100 → "Start selling this right now", 60-79 → "Good for the right audience", 40-59 → "Promising — one fix away", 0-39 → "Don't sell — [2-3 word specific reason]">,
  "product": {
    "title": <string>,
    "description": <string, 1–2 sentences>,
    "author": <string or null>,
    "printTime": <string, use seller input if given, else estimate e.g. "4h 20m">,
    "material": <string, use seller input if given, else estimate weight in grams at €0.025/g PLA e.g. "38g PLA">,
    "sourceHost": <string, hostname+path>,
    "image": <string URL or null>,
    "likes": <integer or null>,
    "saves": <integer or null>,
    "downloads": <string formatted like "8.4k" or null>,
    "prints": <string formatted like "2.1k" or null>,
    "tags": [<string>, ...up to 4 tags],
    "note": <string, one punchy sentence with <b> tags about COMMERCIAL buyer demand — cite Etsy search volume, proven seller revenue, or buyer category trends ONLY. Never cite maker-platform saves/likes/downloads/prints as buyer signals — those reflect printer community engagement, not purchasing intent>
  },
  "market": {
    "searchVolume": <integer, estimated monthly searches>,
    "searchTrend": <string e.g. "↑ 34% YoY" or "→ Stable" or "↓ 12% YoY">,
    "etsyListings": <integer>,
    "etsyAvgPrice": <string e.g. "€18">,
    "topSellerSales": <integer>,
    "printTime": <string>,
    "unitsPerDay": <string — calculate based on the seller's stated printer setup and print time; if printer type is not specified, estimate for a typical single FDM printer e.g. "≈3 units/day">,
    "insight": <string, 2–3 sentence HTML with <b>: demand vs competition ratio, seasonality, buyer perception of 3D-printed items in this category, and any production constraints based on the seller's setup>
  },
  "revenue": {
    "unitsPerMonth": <integer — must be consistent with the seller's printer output ceiling given print time, failure rate, and seller goal>,
    "grossRevenue": <integer>,
    "printCost": <integer — calculated at €0.025/g PLA plus 6% failure rate overhead unless seller provided different values>,
    "etsyFees": <integer — 6.5% transaction + 3.5% payment processing + €0.20 listing amortised>,
    "netProfit": <integer>,
    "sellPrice": <string e.g. "€22.40">
  },
  "manufacturing": {
    "is3DPrintingOptimal": <boolean>,
    "verdict": <string — EXACTLY one of: "Ideal method" | "Works, but has limits" | "Wrong method — consider alternatives">,
    "reason": <string, ONE sentence, plain text — state the single most important fit or misfit reason for this product>,
    "alternatives": [<string>, ...up to 2 better methods if is3DPrintingOptimal is false. Empty array [] if 3D printing is optimal.],
    "breakEvenUnits": <integer, monthly volume at which injection-mold tooling cost is recovered within 18 months; 0 if not applicable>,
    "printingAdvantage": <string, the single most compelling advantage of 3D printing for THIS specific product — be concrete e.g. "Personalisation — buyers pay 2–3× premium for custom name inserts" or "Geometry — hollow organic lattice impossible to injection-mold economically" or "Zero tooling — test market viability at €0 upfront">
  },
  "copyright": {
    "etsyBanRisk": <"low" | "medium" | "high">,
    "etsyBanReason": <string, 1 sentence — base this on the actual license found in the scraped data. If the file has a commercial/print-for-sale license: state that and set risk low. If license is unclear or not visible: warn the seller to verify and mention they can message the creator to request a commercial license. If license is explicitly personal-use-only: set high and cite March 2026 Etsy policy. Never flag as high solely because the URL is an external repo.>,
    "legalRisk": <"low" | "medium" | "high">,
    "legalDesc": <string, 1–2 sentences — name the SPECIFIC regulation relevant to the seller's country (sellFrom) and target markets (sellTo). State the action required if risk is medium or high.>,
    "copyrightRisk": <"low" | "medium" | "high">,
    "copyrightDesc": <string, 1 sentence — name the IP holder if identifiable>,
    "insight": <string, 1–2 sentence HTML with <b>>
  },
  "strategy": {
    "bestPlatform": <string, single best channel for this seller e.g. "Etsy (USA gift buyers)" | "eBay (spec search)" | "Local marketplace (bulky, shipping kills margin)" | "B2B cold outreach (offices, restaurants)">,
    "platformAdvice": <string, 2–3 sentence HTML with <b>: platform priority + trade-offs; flag March 2026 Etsy reselling policy if Etsy + STL repo source; B2B angle if relevant; flag shipping cost impact based on seller's country and target markets if relevant>,
    "realWorldExample": {
      "name": <string or null — a REAL, VERIFIABLE business doing something genuinely similar. Only include if confident. null if no strong match — do NOT invent.>,
      "url": <string or null — their actual public website URL>,
      "whatTheyDo": <string or null — one sentence: what they make, approximate price point, and why it is relevant to this seller>
    },
    "topTips": [<string>, <string>, <string>]
  },
  "certificates": [
    {
      "flag": <string, which seller flag triggered this — "kids" | "electronics" | "food" | "wearable" | "battery" | "magnetic" | "gpsr">,
      "name": <string, official cert or standard name e.g. "CE EN 71-1" or "ASTM F963-23" or "GPSR Declaration of Conformity">,
      "region": <string, with flag emoji e.g. "🇪🇺 EU" or "🇺🇸 USA" or "🇬🇧 UK">,
      "required": <"required" | "recommended" | "check-with-lawyer">,
      "desc": <string, one plain-English sentence describing what this cert covers and why it applies to this seller>,
      "cost": <string, realistic cost range e.g. "€500–€2,000" or "self-declaration possible">,
      "difficulty": <"low" | "medium" | "high">,
      "note": <string, one practical tip — supplier data sheet, self-declaration eligibility, lead time, or a common pitfall>
    }
  ],
  "competitors": [
    {
      "url": <string — exact URL from the LIVE COMPETITOR LISTINGS above; use only URLs provided, do not invent>,
      "name": <string — listing title, max 60 chars, truncate with ... if needed>,
      "platform": <string — "Etsy" | "Amazon Handmade" | "Not on the High Street" | "Folksy" | other marketplace name>,
      "estPrice": <string — price from the scraped data if available, else estimate e.g. "$18–$28">,
      "estMonthlySales": <string — estimate based on reviews/sold count: if reviews > 1000 say "100–200/mo", reviews 500–1000 say "50–100/mo", reviews 100–500 say "20–60/mo", reviews < 100 say "5–20/mo". If no review data, estimate from category averages>,
      "whyItWorks": <string — 1–2 concrete sentences: what specifically makes this listing win — title SEO, first photo style, personalisation hook, price positioning, review velocity, niche angle. Be specific, not generic>
    }
  ]
}
IMPORTANT RULES:
- copyright.etsyBanRisk, legalRisk, copyrightRisk must be EXACTLY "low", "medium", or "high"
- manufacturing.verdict must be EXACTLY one of the three options listed
- All revenue values are plain integers (no symbols, no commas)
- revenue.sellPrice must include the euro symbol and decimal e.g. "€22.40"
- revenue.printCost must reflect €0.025/g PLA + 6% failure overhead unless seller overrides
- market.insight must be valid HTML (only <b> tags)
- strategy.topTips: exactly 3 items, each <b>action</b> + one concrete sentence tailored to this product and the seller's stated setup, markets, and experience level
- When score is 40–59, strategy.topTips MUST name the exact gap holding the score back — never use vague phrases; specify the fix (e.g. 'the design is strong but bathroom décor sells on lifestyle photography — invest in a styled shoot before launching' or 'multi-colour ready is a genuine selling point — lead with that in your listing title')
- Before finalising the score, ask: "is this product generic, or is it generic-but-fixable?" If a clear repositioning angle exists (specific audience, host platform, gift use case, unique 3D-printing advantage), score 60–70 and put the angles in topTips. Reserve scores below 50 for products where no realistic angle exists OR where a hard blocker applies (saturated commodity with no differentiation possible, IP infringement, wrong manufacturing method).
- License-based "Don't sell" verdicts (score < 40): only use when the file is explicitly personal-use-only AND no equivalent commercial-licensed file exists. If the format has commercial demand on Etsy, recommend buying a commercial license, finding a similar commercial-licensed file, or designing a derivative — do NOT just dead-end the seller. Score 35–50 with a clear path forward instead of a flat "don't sell".
- strategy.realWorldExample.name must be null if you are not certain the business exists — do NOT invent names
- strategy.platformAdvice: if the source is an external STL repo, note the license status found in scraped data. If license is unclear, advise checking the model page and contacting the creator for a commercial license. Only flag as a hard blocker if the file is explicitly personal-use-only.
- certificates: include GPSR if sellFrom is an EU country. Add category certs for any legalFlags set.
- Adjust revenue.unitsPerMonth for seller experience level and printer output ceiling — never project more units than the stated printer setup can realistically print given the stated print time
- Extract product.likes/saves/downloads/prints/author from scraped data; set to null if not found
- On MakerWorld (makerworld.bambulab.com): look for "Downloaded by X", "Liked by X", "Collected X times", "X Makes"
- On Printables (printables.com): look for "Downloads", "Likes", "Makes", "Collections"
- On Thingiverse (thingiverse.com): look for "Downloads", "Likes", "Remixes", "Collectors"
- On Cults3D (cults3d.com): look for "Downloads" and "Likes" near the designer name; check if free or paid
- On MyMiniFactory (myminifactory.com): look for "Downloads", "Likes", "Makes" and whether free or paid
- On CGTrader (cgtrader.com): look for product type, price, star rating, and review count
- On Thangs (thangs.com): look for "Downloads", "Views", "Likes"
- Never include a literal double-quote character inside any JSON string value — rephrase or use single quotes
- competitors: use ONLY URLs from the LIVE COMPETITOR LISTINGS section. If no competitor data was provided, return an empty array []. Never invent URLs or listing IDs.
- Return ONLY the JSON object. No other text.`;

  // ── 3. Call Claude ───────────────────────────────────────────────────────
  // Split prompt into cacheable static part + dynamic product context
  const staticPromptEnd = prompt.indexOf('Product data:');
  const staticPart = staticPromptEnd > 0 ? prompt.slice(0, staticPromptEnd).trimEnd() : prompt;
  const dynamicPart = staticPromptEnd > 0 ? prompt.slice(staticPromptEnd) : '';

  let claudeJson;
  const clAbort = new AbortController();
  const clTimeout = setTimeout(() => clAbort.abort(), 42000);
  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3072,
        system: [{ type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: imageUrl && /^https?:\/\//i.test(imageUrl)
            ? [
                { type: 'image', source: { type: 'url', url: imageUrl } },
                { type: 'text', text: 'Above is the product image. Use it to judge design quality, photo-friendliness, and "shelfie-worthiness" — these directly affect score, especially the décor positioning bonus. Then analyse the product data below.\n\n' + (dynamicPart || prompt) },
              ]
            : (dynamicPart || prompt),
        }],
      }),
      signal: clAbort.signal,
    });

    if (!claudeResp.ok) {
      const errText = await claudeResp.text();
      return res.status(502).json({ error: 'analysis_failed', message: errText });
    }

    claudeJson = await claudeResp.json();
  } catch (e) {
    return res.status(502).json({ error: 'analysis_failed', message: e.message });
  } finally {
    clearTimeout(clTimeout);
  }

  const rawText = (claudeJson.content?.[0]?.text || '').trim();
  if (!rawText) {
    return res.status(502).json({ error: 'analysis_failed', message: 'Empty response from Claude' });
  }

  // ── 4. Parse Claude response (ported from n8n "Parse Claude Response") ──
  let parsed;
  try {
    parsed = parseClaudeResponse(rawText);
  } catch (e) {
    return res.status(502).json({ error: 'analysis_failed', message: e.message });
  }

  // Log usage for daily-quota enforcement (skipped for pro users — uncapped)
  if (!_quotaIsPro) {
    try {
      const { logUsage } = require('./_supabase');
      logUsage({ userId: _quotaUser?.id || null, ipHash: _quotaIpHash, kind: 'scan' });
    } catch {}
  }

  // Persist every successful scan (anonymous + logged-in) for the dataset.
  let savedScanId = null;
  try {
    const { adminQuery } = require('./_supabase');
    const profitNum = parsed?.revenue?.netProfit;
    const row = {
      user_id: _quotaUser?.id || null,
      url: String(rawBodyUrl || sourceUrl || '').slice(0, 500),
      title: parsed?.product?.title ? String(parsed.product.title).slice(0, 200) : null,
      score: parsed?.score != null ? Number(parsed.score) : null,
      verdict: parsed?.verdict ? String(parsed.verdict).slice(0, 200) : null,
      image_url: parsed?.product?.image || null,
      profit_est: profitNum ? `~€${Math.round(profitNum)}/mo` : null,
      is_public: false,
      pro_locked: !!_quotaIsPro,
      full_data: parsed,
      ip_hash: _quotaUser?.id ? null : _quotaIpHash,
    };
    const result = await adminQuery({ method: 'POST', table: 'scans', body: row });
    savedScanId = result?.[0]?.id || null;
  } catch { /* swallow — saving the dataset must never break the response */ }

  if (savedScanId) parsed.scanId = savedScanId;

  // Fire-and-forget: log this scan's market data so the system improves over time.
  // We always log — even when no category matched — so the promotion script can
  // surface candidate new categories from the uncategorized pool.
  try {
    const { adminQuery } = require('./_supabase');
    const obsRow = {
      scan_id: savedScanId,
      category_id: matchedMarket?.id || null,
      category_name: matchedMarket?.name || null,
      etsy_listings: parsed?.market?.etsyListings != null ? Number(parsed.market.etsyListings) : null,
      etsy_avg_price: parseEur(parsed?.market?.etsyAvgPrice),
      search_volume: parsed?.market?.searchVolume != null ? Number(parsed.market.searchVolume) : null,
      match_confidence: matchConfidence,
      product_title: parsed?.product?.title ? String(parsed.product.title).slice(0, 200) : null,
    };
    // Don't await — this should never delay the response
    adminQuery({ method: 'POST', table: 'market_observations', body: obsRow }).catch(() => {});
  } catch {}

  return res.status(200).json(parsed);
};

// ── Helpers ────────────────────────────────────────────────────────────────

// Lazy-load market data once per lambda warm instance
let _marketData = null;
function loadMarketData() {
  if (_marketData) return _marketData;
  try {
    const path = require('path');
    const fs = require('fs');
    const file = path.join(__dirname, '..', 'data', 'market-data.json');
    _marketData = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { _marketData = { categories: [] }; }
  return _marketData;
}

// Compatibility shim: old callers
function matchMarketCategory(args) {
  const r = matchMarketCategoryWithConfidence(args);
  return r ? r.category : null;
}

// Pick the single most relevant category and report match confidence (0..1).
function matchMarketCategoryWithConfidence({ sellerCategory, productContext, ideaText, title }) {
  const md = loadMarketData();
  if (!md.categories?.length) return null;
  const cats = md.categories;

  const sellerSlug = (sellerCategory || '').toLowerCase().trim();
  if (sellerSlug) {
    // Common synonyms map seller chips to category ids
    const synonyms = {
      decor: 'decor', decorative: 'decor', art: 'decor',
      gaming: 'dnd_gaming', dnd: 'dnd_gaming', games: 'dnd_gaming',
      desk: 'desk_office', office: 'desk_office',
      gift: 'personalized_gifts', personalized: 'personalized_gifts', personalised: 'personalized_gifts',
      tech: 'tech_accessories', electronics: 'tech_accessories',
      lighting: 'lighting_lamps', lamp: 'lighting_lamps', lamps: 'lighting_lamps',
      wedding: 'wedding_events', event: 'wedding_events',
      miniatures: 'miniatures_terrain', miniature: 'miniatures_terrain', terrain: 'miniatures_terrain',
      jewelry: 'jewelry_wearables', jewellery: 'jewelry_wearables', wearable: 'jewelry_wearables',
      planter: 'planters_garden', planters: 'planters_garden', garden: 'planters_garden',
      toy: 'toys_fidgets', toys: 'toys_fidgets', fidget: 'toys_fidgets',
      replacement: 'replacement_parts', parts: 'replacement_parts',
      pet: 'pet_accessories', dog: 'pet_accessories', cat: 'pet_accessories',
      kids: 'kids_nursery', baby: 'kids_nursery', nursery: 'kids_nursery',
      home: 'home_organization', organization: 'home_organization', organizer: 'home_organization',
      cable: 'cable_management',
      storage: 'storage_bins', bin: 'storage_bins', gridfinity: 'storage_bins',
      fashion: 'fashion_accessories',
      tool: 'tools_workshop_jigs', tools: 'tools_workshop_jigs', jig: 'tools_workshop_jigs',
      cosplay: 'cosplay_props', prop: 'cosplay_props', costume: 'cosplay_props',
      keychain: 'keychains', keychains: 'keychains',
      candle: 'candle_wax_accessories', wax: 'candle_wax_accessories', mold: 'candle_wax_accessories',
      automotive: 'automotive_bike', car: 'automotive_bike', bike: 'automotive_bike', bicycle: 'automotive_bike',
      music: 'musical_instruments_accessories', musical: 'musical_instruments_accessories', guitar: 'musical_instruments_accessories',
      functional: 'home_organization', // a sensible default for the seller's "functional" chip
    };
    const targetId = synonyms[sellerSlug];
    if (targetId) {
      const hit = cats.find(c => c.id === targetId);
      if (hit) return { category: hit, confidence: 1.0 };
    }
  }

  // Fallback: score each category by keyword overlap against the product text
  const haystack = ((productContext || '') + ' ' + (ideaText || '') + ' ' + (title || '')).toLowerCase();
  if (!haystack.trim()) return null;
  let best = null, bestScore = 0;
  for (const cat of cats) {
    let score = 0;
    for (const kw of cat.top_keywords) {
      if (haystack.includes(kw.toLowerCase())) score += kw.split(' ').length;
    }
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  if (bestScore < 2) return null;
  // Confidence scales with keyword overlap — 2 hits = 0.5, 4+ = 0.8
  const confidence = Math.min(0.85, 0.4 + bestScore * 0.1);
  return { category: best, confidence };
}

// ── Recent market observations cache ──────────────────────────────────────
// Per-category in-memory cache of the last-90-day medians from Supabase.
// 10-minute TTL; defensive 1.5s timeout; silently falls back to null on error.
const _OBS_CACHE = new Map();
const _OBS_TTL_MS = 10 * 60 * 1000;
async function getRecentObservations(categoryId) {
  if (!categoryId) return null;
  const hit = _OBS_CACHE.get(categoryId);
  if (hit && Date.now() - hit.at < _OBS_TTL_MS) return hit.data;
  const env = process.env;
  const url = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) return null;
  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(
      `${url}/rest/v1/market_observations?category_id=eq.${encodeURIComponent(categoryId)}&created_at=gte.${since}&select=etsy_listings,etsy_avg_price,search_volume&order=created_at.desc&limit=200`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: ctrl.signal }
    );
    clearTimeout(t);
    if (!res.ok) throw new Error('rest ' + res.status);
    const rows = await res.json();
    const data = (rows || []).length >= 5 ? {
      count: rows.length,
      medianListings: median(rows.map(r => r.etsy_listings).filter(Number.isFinite)),
      medianPrice: median(rows.map(r => parseFloat(r.etsy_avg_price)).filter(Number.isFinite)),
      medianSearch: median(rows.map(r => r.search_volume).filter(Number.isFinite)),
    } : null;
    _OBS_CACHE.set(categoryId, { at: Date.now(), data });
    return data;
  } catch {
    _OBS_CACHE.set(categoryId, { at: Date.now(), data: null });
    return null;
  }
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100;
}
function parseEur(s) {
  if (typeof s === 'number') return s;
  if (!s) return null;
  const m = String(s).match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

function extractProductContext(fcData) {
  const metadata = fcData.data?.metadata || {};
  const markdown = fcData.data?.markdown || '';

  const title = metadata.title || '';
  const description = metadata.description || '';
  const sourceURL = metadata.sourceURL || metadata.url || '';
  const imageUrl = metadata.ogImage || '';

  function extractProductInfo(md) {
    let text = md;
    text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, '');

    const relatedIdx = text.indexOf('### Related Models');
    if (relatedIdx !== -1) text = text.substring(0, relatedIdx);

    const commentIdx = text.indexOf('### Comment');
    if (commentIdx !== -1) text = text.substring(0, commentIdx);

    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    const noiseLines = new Set([
      'Follow','Boost','Post','All','Designer',
      'Open in Bambu Studio','IP Report',
      'TopMost LikesNewest FirstMost Replies','No more',
      'Drag & drop, paste with Ctrl+v, or upload a file',
      'Add Photo','(0/1000)','* * *',"Maker's Supply",
    ]);

    text = text.split('\n').filter(line => {
      const t = line.trim();
      if (!t || t === '*') return false;
      if (noiseLines.has(t)) return false;
      if (/^(P1P|P1S|X1|X1 Carbon|X1E|A1|H2D|A1 mini|H2S|P2S|H2C|X2D|H2D Pro)$/.test(t)) return false;
      if (/^\d+$/.test(t)) return false;
      return true;
    }).join('\n');

    return text.replace(/\n{3,}/g, '\n\n').trim();
  }

  function extractStats(md) {
    const s = {};
    // Match "6h 30m", "6h", "6.5h", "6 hours 30 minutes"
    const timeMatch = md.match(/(\d+\.?\d*)\s*h(?:ours?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
    if (timeMatch) {
      s.printTime = timeMatch[1] + 'h' + (timeMatch[2] ? ' ' + timeMatch[2] + 'm' : '');
    }
    const platesMatch = md.match(/(\d+)\s*plates?\b/i);
    if (platesMatch) s.plates = platesMatch[1];
    const layerMatch = md.match(/(\d+\.?\d*mm)\s*layer/);
    if (layerMatch) s.layerHeight = layerMatch[1];
    const infillMatch = md.match(/(\d+%)\s*infill/);
    if (infillMatch) s.infill = infillMatch[1];
    const wallsMatch = md.match(/(\d+)\s*walls?/);
    if (wallsMatch) s.walls = wallsMatch[1];
    const dateMatch = md.match(/Released\s+(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) s.releaseDate = dateMatch[1];
    // Broad license detection: Creative Commons, MakerWorld Standard/Commercial, CC0, etc.
    const licenseMatch = md.match(/(Creative Commons[^\n]+|CC0[^\n]*|CC BY[^\n]*|Standard MakerWorld License[^\n]*|Commercial License[^\n]*|Personal Use[^\n]*|Non-Commercial[^\n]*|Print-for-Sale[^\n]*)/i);
    if (licenseMatch) s.license = licenseMatch[0].trim();
    return s;
  }

  const cleanedContent = extractProductInfo(markdown);
  const stats = extractStats(markdown);

  let productContext = `URL: ${sourceURL}\nTITLE: ${title}\nDESCRIPTION: ${description}\n`;
  if (stats.releaseDate) productContext += `RELEASE DATE: ${stats.releaseDate}\n`;
  if (stats.printTime) productContext += `PRINT TIME: ${stats.printTime}\n`;
  if (stats.plates) productContext += `PLATES: ${stats.plates}\n`;
  if (stats.layerHeight) productContext += `LAYER HEIGHT: ${stats.layerHeight}\n`;
  if (stats.infill) productContext += `INFILL: ${stats.infill}\n`;
  if (stats.walls) productContext += `WALLS: ${stats.walls}\n`;
  if (stats.license) productContext += `LICENSE: ${stats.license}\n`;
  productContext += `\nPAGE CONTENT (cleaned):\n${cleanedContent.substring(0, 2500)}`;

  return { productContext, imageUrl, sourceUrl: sourceURL };
}

function repairTruncatedJson(s) {
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') stack.pop();
    }
  }
  if (stack.length === 0 && !inStr) return { repaired: s, truncated: false };
  let repaired = s;
  if (inStr) repaired += '"';
  repaired = repaired.replace(/,\s*$/, '');
  if (/:\s*$/.test(repaired)) repaired += 'null';
  while (stack.length > 0) {
    repaired += stack.pop() === '{' ? '}' : ']';
  }
  return { repaired, truncated: true };
}

function parseClaudeResponse(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const clean = fenceMatch ? fenceMatch[1].trim() : text;
  const start = clean.indexOf('{');
  if (start === -1) throw new Error('No JSON object found');

  let jsonStr = clean.slice(start);
  const { repaired, truncated } = repairTruncatedJson(jsonStr);
  if (truncated) jsonStr = repaired;

  function parseWithFixes(s) {
    try { return JSON.parse(s); } catch (_) {}
    try {
      const fixed = s.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(fixed);
    } catch (_) {}
    try {
      let sanitized = '';
      let inString = false, escaped = false;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (escaped) {
          const validEscapes = '"\\/bfnrtu';
          sanitized += validEscapes.includes(c) ? '\\' + c : c;
          escaped = false;
        } else if (c === '\\' && inString) {
          escaped = true;
        } else if (c === '"') {
          sanitized += c;
          inString = !inString;
        } else if (inString && c === '\n') {
          sanitized += '\\n';
        } else if (inString && c === '\r') {
          // skip
        } else if (inString && c === '\t') {
          sanitized += '\\t';
        } else {
          sanitized += c;
        }
      }
      return JSON.parse(sanitized);
    } catch (e) {
      throw new Error('All parse attempts failed: ' + e.message);
    }
  }

  const parsed = parseWithFixes(jsonStr);
  parsed._truncated = truncated;
  return JSON.parse(JSON.stringify(parsed));
}
