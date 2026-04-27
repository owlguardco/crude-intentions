# CRUDE INTENTIONS

Personal AI-powered research dashboard for WTI crude oil futures (CL) on Apex Trader Funding.

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Add your API key
```bash
cp .env.local.example .env.local
# Edit .env.local and add your Anthropic API key
```

### 3. Run dev server
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Pages

| Route | Description |
|-------|-------------|
| `/` | Dashboard — weekly bias, A+ score, recent signals |
| `/pre-trade` | Setup analysis form → Claude scores against A+ checklist |
| `/journal` | Decision ledger — all evaluations with filters |
| `/eia` | EIA countdown + post-report analysis |
| `/prompts` | Prompt library (Phase 1+) |
| `/settings` | Settings (Phase 1+) |

---

## Data Files

| File | Purpose |
|------|---------|
| `src/data/safety_check_log.json` | Trade journal — all signal evaluations |
| `src/data/weekly_bias.json` | Current weekly macro bias |
| `src/data/rules.json` | A+ checklist rules engine (source of truth for API calls) |
| `src/data/eia_history.json` | Past EIA analyses |

---

## Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Add `ANTHROPIC_API_KEY` in Vercel project settings → Environment Variables.
Enable Vercel password protection for personal gating.

---

## Stack

- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS + inline styles
- **Fonts:** JetBrains Mono + Inter
- **API:** Anthropic claude-sonnet-4-20250514 (server-side only)
- **Data:** Local JSON files (Phase 1)
- **Hosting:** Vercel

---

*CRUDE INTENTIONS is a personal research tool. Nothing here constitutes financial advice. All trading decisions are yours alone.*
