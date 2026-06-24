# Fantasy F1 2026

Private fantasy F1 leaderboard. Each team picks two drivers; score = sum of both drivers' championship points across all races and sprints.

Stack: Cloudflare Pages + Pages Worker (API) + standalone cron Worker (data fetching) + KV (storage). No build step — vanilla HTML/CSS/JS.

## Local dev

```sh
npm install
printf 'ADMIN_PASSWORD=dev\nCRON_WORKER_URL=http://localhost:8787\n' > .dev.vars
npm run dev       # http://localhost:8788
npm run dev:cron  # http://localhost:8787 — needed for the admin "Recheck Selected Race" button
npm run seed      # load mock data (both dev servers should be running)
```

Click ⚙️ and enter `dev` to access the team editor.

See [ARCHITECTURE.md](ARCHITECTURE.md) for scoring rules, deployment steps, and project structure.
