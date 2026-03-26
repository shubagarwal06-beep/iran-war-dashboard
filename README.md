# Iran War Dashboard Backend

This workspace now includes a tiny zero-dependency Node server that:

- serves the dashboard at `/`
- exposes live-or-demo news intelligence at `/api/intel`
- keeps secrets on the server side instead of in browser JavaScript
- leaves oil and US 10Y charts entirely to embedded TradingView widgets

## Run

```bash
npm start
```

Then open [http://127.0.0.1:3000](http://127.0.0.1:3000).
The server will automatically read a local `.env` file if you create one.

If you open the HTML file directly instead of through the server, the dashboard will warn that the same-origin `/api` routes are unavailable.

## Endpoints

- `GET /`
- `GET /healthz`
- `GET /api/intel`

Append `?refresh=1` to bypass the in-memory cache for a request.

## Data behavior

`/api/intel`

- first tries NewsAPI if `NEWSAPI_API_KEY` is set
- otherwise uses Google News RSS search feeds for Iran / Hormuz / oil / shipping / treasury headlines
- if `OPENAI_API_KEY` is set, runs a true OpenAI Responses summarization pass over the fetched articles
- otherwise classifies the most relevant items into `deescalation`, `contained`, and `escalation` heuristically
- falls back to demo intelligence if upstream requests fail

## Environment variables

- `PORT=3000`
- `HOST=127.0.0.1`
- `DASHBOARD_FILE=iran-war-dashboard.html`
- `INTEL_CACHE_MS=180000`
- `REQUEST_TIMEOUT_MS=12000`
- `FORCE_DEMO=1`
- `NEWS_QUERIES=Iran Strait of Hormuz oil shipping||Iran Hormuz tanker shipping crude||Middle East oil treasury yields`
- `NEWSAPI_API_KEY=...`
- `NEWSAPI_DOMAINS=reuters.com,bloomberg.com,ft.com,wsj.com,cnbc.com,apnews.com,marketwatch.com,nytimes.com,axios.com`
- `OPENAI_API_KEY=...`
- `OPENAI_MODEL=gpt-5-mini`
- `OPENAI_ENABLE_WEB_SEARCH=1`
- `OPENAI_WEB_SEARCH_DOMAINS=reuters.com,bloomberg.com,ft.com,wsj.com,cnbc.com,apnews.com,spglobal.com,lloydslist.com,marketwatch.com`

See [.env.example](/Users/shubhamagarwal/Documents/Playground/.env.example) for a ready-to-fill template.

## Notes

- Oil and US 10Y charts no longer use any backend market-data API. They are embedded directly from TradingView.
- NewsAPI requires your own key.
- Without `OPENAI_API_KEY`, the intelligence layer remains heuristic even if the article feed is live.
