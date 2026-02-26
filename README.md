# Fantasy F1 2026

Private fantasy F1 leaderboard. Each team picks two drivers; score = sum of both drivers' championship points across all races and sprints.

Stack: Cloudflare Pages + Pages Worker (API) + standalone cron Worker (data fetching) + KV (storage). No build step — vanilla HTML/CSS/JS.

## Scoring

- Race: 25-18-15-12-10-8-6-4-2-1 (P1–P10)
- Sprint: 8-7-6-5-4-3-2-1 (P1–P8)
- Team total = both drivers' points across all rounds + optional manual adjustment

## Local dev

```sh
npm install
echo "ADMIN_PASSWORD=dev" > .dev.vars
npm run dev     # http://localhost:8788
npm run seed    # load mock data (server must be running)
```

Click ⚙️ and enter `dev` to access the team editor.

## Deployment

Requires a Cloudflare account and `npx wrangler login`.

```sh
# First time only — paste the printed IDs into wrangler.toml
npx wrangler kv:namespace create F1_DATA
npx wrangler kv:namespace create F1_DATA --preview
npx wrangler pages secret put ADMIN_PASSWORD

# Deploy
npm run deploy:pages   # repeat on every change to public/
npm run deploy:cron    # repeat only when cron-worker/ changes
```

After deploying, open the live site, click ⚙️, and add your teams.

## Project structure

```
public/
  _worker.js          Pages Worker: /api/data, /api/teams, /api/seed
  app.js, admin.js    Frontend logic
  index.html, styles.css

cron-worker/
  worker.js           Fetches OpenF1 results every 10 min, writes to KV
  wrangler.toml

scripts/
  push-calendar.js    Manually push race calendar to KV
  seed-dev-kv.js      Load mock data in local dev
```

## Future considerations

**Git integration:** Cloudflare Pages can auto-deploy on every push to `main` and generate preview URLs for PRs. Set up via Workers & Pages → your project → Settings → Builds & Deployments → Connect to Git. Note: covers Pages only — the cron worker still needs `npm run deploy:cron` manually.
