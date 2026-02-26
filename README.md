# Fantasy F1 2026

A leaderboard for a private fantasy F1 league. Each team picks two drivers; their score is the sum of both drivers' championship points across all completed races and sprint races.

Built on Cloudflare Pages (static frontend) + a Pages Worker (API and scheduled jobs) + Cloudflare KV (data storage). No build step — vanilla HTML, CSS, and JS.

---

## How it works

**Data pipeline:**
A scheduled Worker runs every 10 minutes. On most invocations it does almost nothing — it reads the race calendar from KV, finds no events needing an update, and exits. After a race or sprint session ends (plus a ~30 min delay for OpenF1 free-tier access), it starts fetching standings from the [OpenF1 API](https://openf1.org) and retrying every 10 minutes until the data is confirmed. Once standings for an event are stored, that event is never fetched again.

**Frontend:**
The browser fetches `/api/data` on load and every 5 minutes. The Worker serves calendar, standings, and team config from KV. The page renders a leaderboard (sorted by total points), a points progression chart, and a 3-row event status panel showing the most recent event and the next two upcoming ones.

**Team management:**
Teams are configured through an in-app admin panel (password-protected). No code deploy is needed to add or change teams mid-season.

---

## Scoring

- **Race:** 25-18-15-12-10-8-6-4-2-1 for positions 1–10
- **Sprint:** 8-7-6-5-4-3-2-1 for positions 1–8
- Fastest lap bonus: not used (abolished from 2025 onwards)
- Each team's score = sum of both drivers' points across all completed events + optional manual adjustment

---

## Local development

### Prerequisites

- Node.js 18+

### First-time setup

```sh
npm install
```

Create a `.dev.vars` file in the project root. This is gitignored and is how Wrangler loads secrets in local dev:

```sh
echo "ADMIN_PASSWORD=dev" > .dev.vars
```

### Running the dev server

```sh
npm run dev
```

Starts a local Cloudflare Pages environment at `http://localhost:8788`. The Worker and KV store are simulated locally by Miniflare.

### Loading mock data

With the dev server running, open a second terminal:

```sh
npm run seed
```

This posts mock data to the local Worker's `/api/seed` endpoint (authenticated with the password from `.dev.vars`). The console output describes what scenario has been loaded and what the UI should show.

### Testing the admin panel

Click **⚙** in the top-right corner and enter `dev` as the password. This opens the team editor where you can add, rename, recolour, and remove teams.

---

## Deployment

### 1. Create a Cloudflare account

Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) if you don't have one. The free tier covers everything this project uses.

### 2. Install Wrangler and log in

```sh
npm install   # installs wrangler as a dev dependency
npx wrangler login
```

This opens a browser to authenticate Wrangler with your Cloudflare account.

### 3. Create the KV namespace

```sh
npx wrangler kv:namespace create F1_DATA
npx wrangler kv:namespace create F1_DATA --preview
```

Each command prints an `id`. Open `wrangler.toml` and paste them in:

```toml
[[kv_namespaces]]
binding = "F1_DATA"
id = "<id from first command>"
preview_id = "<id from second command>"
```

### 4. Deploy to Cloudflare Pages

```sh
npx wrangler pages deploy public
```

On first run this creates a new Pages project and deploys. Wrangler will ask you to name the project — this becomes your initial URL (`<project-name>.pages.dev`). Subsequent runs deploy to the same project.

Alternatively, connect the repo to Cloudflare Pages via the dashboard (**Workers & Pages → Create → Pages → Connect to Git**) for automatic deploys on push. Set the build output directory to `public` and leave the build command blank.

### 5. Bind the KV namespace in the dashboard

If you used `wrangler pages deploy` directly, the KV binding in `wrangler.toml` is picked up automatically. If you connected via the dashboard, you need to add it manually:

- **Workers & Pages → your project → Settings → Functions → KV namespace bindings**
- Variable name: `F1_DATA`, Namespace: the one you created above

### 6. Set the admin password

```sh
npx wrangler pages secret put ADMIN_PASSWORD
```

Enter a strong password when prompted. This is stored as an encrypted secret in Cloudflare — it is never in the repository or in any config file.

To use it locally, put the same (or any) password in `.dev.vars`:

```
ADMIN_PASSWORD=dev
```

### 7. Deploy the cron worker

The scheduled data-fetching job runs as a standalone Cloudflare Worker (separate from Pages):

```sh
npm run deploy:cron
```

Check it registered correctly:

- **Workers & Pages → fantasy-f1-cron → Settings → Triggers → Cron Triggers**

To test locally:

```sh
npx wrangler dev cron-worker/worker.js --test-scheduled
# In another terminal:
curl "http://localhost:8787/__scheduled?cron=*%2F10+*+*+*+*"
```

### 8. Add your teams

Navigate to the live site, click **⚙**, enter your admin password, and set up the league teams. No deploy needed.

---

## Project structure

```
public/
  index.html         Page shell
  styles.css         Styles
  app.js             Data fetching and all UI rendering
  admin.js           Admin panel (team editor, auth)
  _worker.js         Pages Worker: API routes (/api/data, /api/teams, /api/seed)

cron-worker/
  worker.js          Standalone Cloudflare Worker: scheduled data fetching from OpenF1
  wrangler.toml      Cron worker config (KV binding, */10 * * * * schedule)

scripts/
  push-calendar.js   Utility: manually push the race calendar to KV
  seed-dev-kv.js     Dev tool: posts mock data to local Worker for testing

wrangler.toml        Pages config (KV binding)
.dev.vars            Local secrets — not committed, create manually (see above)
```

## KV data model

Two keys in the `F1_DATA` namespace:

**`f1-data`** — calendar and per-round driver points (incremental, not cumulative):

```json
{
  "season": 2026,
  "lastUpdated": "2026-03-15T07:42:00Z",
  "calendar": [
    {
      "round": 1,
      "name": "Australian GP",
      "raceStartUtc": "2026-03-15T05:00:00Z",
      "sprintStartUtc": null
    }
  ],
  "standings": {
    "1":        { "VER": { "name": "Max Verstappen", "points": 25 } },
    "2_sprint": { "NOR": { "name": "Lando Norris",   "points": 8  } },
    "2":        { "NOR": { "name": "Lando Norris",   "points": 25 } }
  }
}
```

**`f1-teams`** — fantasy league configuration:

```json
{
  "teams": [
    {
      "name": "My Team",
      "drivers": ["VER", "NOR"],
      "color": "#3b82f6",
      "adjustment": 0
    }
  ]
}
```

`adjustment` is an integer points correction for a team (e.g. to fix a scoring error without rewriting standings data).
