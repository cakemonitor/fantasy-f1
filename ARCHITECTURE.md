# Architecture

## Scoring

- Race: 25-18-15-12-10-8-6-4-2-1 (P1–P10)
- Sprint: 8-7-6-5-4-3-2-1 (P1–P8)
- Team total = both drivers' points across all rounds + optional manual adjustment

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

After the first `npm run deploy:cron`, copy the printed `*.workers.dev` URL into `CRON_WORKER_URL` in the root `wrangler.toml`'s `[vars]` block, then redeploy Pages so the admin panel's "Recheck Selected Race" button can reach it.

The cron Worker needs its own copy of the admin password (the admin panel reuses one password end-to-end):
```sh
npx wrangler secret put ADMIN_PASSWORD --config cron-worker/wrangler.toml
```

After deploying, open the live site, click ⚙️, and add your teams.

## Project structure

```
public/
  _worker.js          Pages Worker: /api/data, /api/teams, /api/seed, /api/refresh-standings
  app.js, admin.js    Frontend logic
  index.html, styles.css

cron-worker/
  worker.js           Scheduled: fetches OpenF1 results every 10 min, writes to KV
                      HTTP: POST /refresh — force-recheck one past event (called via the
                      Pages Worker's /api/refresh-standings proxy)
  wrangler.toml

scripts/
  push-calendar.js    Manually push race calendar to KV
  seed-dev-kv.js      Load mock data in local dev
```

## Future considerations

**Git integration:** Cloudflare Pages can auto-deploy on every push to `main` and generate preview URLs for PRs. Set up via Workers & Pages → your project → Settings → Builds & Deployments → Connect to Git. Note: covers Pages only — the cron worker still needs `npm run deploy:cron` manually.
