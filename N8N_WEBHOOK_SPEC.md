# n8n webhook spec — PrintChecker (`/idea`)

The `/idea.html` page POSTs analysis requests to
`https://meshminds.app.n8n.cloud/webhook/idea` and renders whatever JSON the
webhook returns. This document is the contract between the front-end and the
n8n workflow.

## 1. What n8n receives

### `POST` — analysis request
Fires when the user clicks **Start analysis** on step 3.

```json
{
  "url": "https://makerworld.com/en/models/123",      // present if user pasted a link
  "description": "custom name wall sign…",            // present instead of url if free-text
  "type": "idea",                                     // only present with description
  "category": "decor",                                // decor | functional | art | gaming | miniatures | other
  "marketplace": "etsy",                              // etsy | makerworld | printables | own
  "priceRange": "15-30",                              // 5-15 | 15-30 | 30-60 | 60+
  "printTime": "2-6h",                                // <2h | 2-6h | 6-12h | 12h+
  "activeMarkets": ["etsy"],                          // array, same values as marketplace + "none"
  "socialMedia": ["instagram","tiktok"],              // instagram | tiktok | pinterest | facebook | none
  "sellFrom": "NL",                                   // ISO country code
  "sellTo": "US,EU,GB",                               // comma-joined regions or "WORLDWIDE"
  "legalFlags": ["kids","electronics"]                // kids | electronics | food | wearable | battery | magnetic | none
}
```

Either `url` **or** `description`+`type:"idea"` will be present, never both.

### `POST` — email capture
Fires when the user submits their email on step 4.

```json
{ "type": "email", "email": "user@example.com", "url": "<the-url-or-idea>" }
```

Use this to add the lead to a CRM / mailing list. The UI does not wait on a
response.

## 2. What n8n must return (analysis response)

Return a **single JSON object** with the shape below. Every field is optional —
missing values render as `-`. Respond with `Content-Type: application/json`.

```json
{
  "score": 87,
  "verdict": "Strong seller potential",

  "product": {
    "title": "Layered Initial & Name Sign",
    "author": "JCGil",
    "description": "Personalised wood-look PLA name sign…",
    "printTime": "6h 32m",
    "material": "42g PLA",
    "sourceHost": "makerworld.com/…",
    "url": "https://makerworld.com/en/models/…",
    "image": "https://… or data:image/jpeg;base64,…",
    "tags": ["Decor","Personalised","Gift"],
    "likes": 5000,
    "saves": 12006,
    "downloads": "16.6k",
    "prints": "7.5k",
    "note": "<b>Top 3% on MakerWorld.</b> 16.6k downloads & 7.5k prints — strong proof of demand."
  },

  "market": {
    "searchVolume": 22200,
    "searchTrend": "↑ 58% YoY",
    "etsyListings": 1428,
    "etsyAvgPrice": "€22",
    "topSellerSales": 3241,
    "printTime": "~3.5 hrs",
    "unitsPerDay": "≈2 units/day",
    "insight": "<b>Low competition, real demand.</b> Only 1,428 listings but 22k monthly searches."
  },

  "revenue": {
    "unitsPerMonth": 42,
    "grossRevenue": 940,
    "printCost": 38,
    "etsyFees": 113,
    "netProfit": 789,
    "sellPrice": "€22.40"
  },

  "copyright": {
    "etsyBanRisk": "low",
    "etsyBanReason": "No policy violations detected. Original design with no brand ties.",
    "legalRisk": "low",
    "legalDesc": "No country-specific restrictions found for personalised name signs.",
    "copyrightRisk": "low",
    "copyrightDesc": "Fully original design — no trademarks or IP issues identified.",
    "insight": "<b>Clear to sell.</b> This design has no IP conflicts and is safe to list worldwide."
  }
}
```

## 3. Field-by-field research notes

### Top level

| Field | Type | Notes |
|---|---|---|
| `score` | integer 0–100 | Composite: demand + margin + legal. Drives ring colour (≥70 green, 40–69 orange, <40 red). |
| `verdict` | short string | One-liner headline, e.g. `Strong seller potential` / `Risky — IP flagged` / `Low demand, pass`. |

### `product` — scrape the link, or synthesise from the idea text

- `title`, `author`, `description` — direct scrape (og:title, creator name, og:description).
- `printTime`, `material` — from MakerWorld/Printables metadata, e.g. `6h 32m`, `42g PLA`.
- `sourceHost` — hostname string, e.g. `makerworld.com/…`.
- `image` — **https URL preferred**. `data:image/…;base64,…` also works but bloats the payload.
- `tags` — array of short strings, shown as pills.
- `likes`, `saves` — integers (auto-formatted to `1.2k`).
- `downloads`, `prints` — **already-formatted strings** like `"16.6k"`.
- `note` — HTML allowed (`<b>`, `<i>`). One-sentence demand proof.

For **idea mode** (`description` instead of `url`): synthesise plausible values
from the closest comparable products you can find.

### `market` — demand research

- `searchVolume` — monthly Etsy / Google searches (integer).
- `searchTrend` — short string with arrow, e.g. `"↑ 58% YoY"`.
- `etsyListings` — current listing count (integer).
- `etsyAvgPrice` — formatted string, e.g. `"€22"`.
- `topSellerSales` — estimated annual sales of the top seller in this niche.
- `printTime`, `unitsPerDay` — short strings describing realistic throughput.
- `insight` — HTML allowed, one actionable sentence.

**Recommended sources:** erank / EtsyRank / Alura APIs, Google Trends, direct
Etsy search scrape.

### `revenue`

- `unitsPerMonth` — **critical**. The sell-price slider multiplies this × price.
  Return a realistic monthly sales estimate for a new seller in this niche.
- `printCost` — monthly **total** material + energy cost (not per unit). The
  slider keeps this fixed.
- `etsyFees`, `grossRevenue`, `netProfit` — initial values shown before the user
  drags the slider. The slider recomputes them client-side as
  `gross = price × units`, `fees = gross × 0.12`,
  `net = gross − printCost − fees`.
- `sellPrice` — starting slider position. Format `"€22.40"` or plain `22.40`.

### `copyright`

Each risk is `"low" | "medium" | "high"` (drives pill colour).

- `etsyBanRisk` + `etsyBanReason` — Etsy ToS / listing policy check.
- `legalRisk` + `legalDesc` — country-specific regs (use `sellFrom` + `sellTo`
  from the request).
- `copyrightRisk` + `copyrightDesc` — IP / trademark / character check (Disney,
  Pokémon, sports logos…).
- `insight` — one-line summary, HTML allowed.

The banner above the three cards auto-switches based on the highest risk:

- any `"high"` → red **Legal warning — review before listing**
- any `"medium"` → amber **Some risks to be aware of**
- all `"low"` → green **No legal issues found — safe to sell**

### Required-certificates section

**100% client-side** — generated from `legalFlags` in the request. No work on
n8n's side.

## 4. Behaviour notes

- **Timing.** The request fires as soon as the user clicks "Start analysis".
  The user then fills in the email gate (step 4) and reviews the legal check
  (step 5) — roughly 15–45 seconds. Aim to respond inside that window. If the
  response hasn't arrived by the time they hit "See full analysis" the UI
  silently falls back to demo data.
- **Fallback.** Any non-2xx or network error → the UI loads `DEMO_DATA`
  silently. Safe to return nothing while iterating.
- **HTML in `note` / `insight` / descriptions.** Allowed (`<b>`, `<i>`, `<br>`).
  No scripts — keep it simple.
- **CORS.** The webhook must allow requests from the site's origin.
