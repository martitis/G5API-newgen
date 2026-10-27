# Deploying G5API

How to run the API in production: bare Node with pm2, behind nginx or Caddy, on the same host as the panel (G5V).
The panel repo has matching proxy configs (`default.conf` for nginx, `Caddyfile`).

## Requirements
- **Node 22 LTS** (`.nvmrc`), Yarn 1 (`npx yarn@1.22.22` works without a global install)
- **MySQL 8** (or MariaDB 10.6+). All times are stored in UTC; the API sets the session time zone itself.
- Optional: **Redis** for sessions (`server.useRedis`), so logins survive API restarts
- A CS2 server with MatchZy that can reach `server.apiURL` (see [Game server](#game-server))

## First install
```sh
git clone https://github.com/martitis/G5API-newgen.git && cd G5API-newgen
npx yarn@1.22.22 install --frozen-lockfile
cp config/production.json.template config/production.json   # then fill it in (below)
npx yarn@1.22.22 build
NODE_ENV=production npx yarn@1.22.22 prod                   # creates the database and runs every migration
npx yarn@1.22.22 startprod                                  # pm2, from prodrun.json
pm2 save && pm2 startup                                     # restart on reboot
```

### config/production.json
| Key | Notes |
| --- | --- |
| `server.port` | 3301 unless the proxy points elsewhere |
| `server.dbKey` | **exactly 16 bytes**. It encrypts RCON passwords and API keys in the DB, so keep it: changing it makes them unreadable |
| `server.steamAPIKey` | from https://steamcommunity.com/dev/apikey |
| `server.sharedSecret` | long random string (session cookie secret) |
| `server.apiURL` | public base URL of the API **as the game server sees it**, e.g. `https://panel.example.com/api/` |
| `server.clientHome` | the panel URL; Steam login returns there |
| `server.uploadDemos` | `true` to have MatchZy upload demos to `public/demos` |
| `server.localLoginEnabled` | `false` unless you want username/password accounts |
| `production.*` | MySQL connection; `connectionLimit` 15 is plenty |
| `admins.steam_ids`, `super_admins.steam_ids` | comma-separated SteamID64s. They overwrite the role flags on every Steam login |

## Updating
```sh
git pull
npx yarn@1.22.22 install --frozen-lockfile
npx yarn@1.22.22 build                       # must pass; it cleans dist/ first
npx yarn@1.22.22 migrate-prod-upgrade
npx yarn@1.22.22 restartprod
```
Migrations are never merged or moved: db-migrate records each one with its folder, so they only ever get added.
If a migration prints a warning (for example, the `map_stats` unique key is skipped when old duplicate rows exist),
it explains what to fix by hand.

## Reverse proxy
Serve the panel and the API from one origin, with the API under `/api/` (the panel's default `apiUrl`). The API needs:
- **no response buffering and long read timeouts** for the live server-sent event streams (`/matches/summary/stream`,
  `/matches/:id/live/stream`, `/tournaments/:id/stream`, `/pugs/:id/stream`, ...). The API sends a heartbeat every 25 s.
- **a 2 GB request body limit** on `/api/v2/demo` (demo uploads).
- `X-Forwarded-For` / `X-Forwarded-Proto` headers. The app trusts one proxy hop (`trust proxy 1`), which the rate
  limits and secure cookies rely on.

nginx, inside the panel's `server` block (also commented out in the panel's `default.conf`):
```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3301/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 1h;
    client_max_body_size 2g;
}
```
Caddy (in the panel's `Caddyfile`) streams without buffering by default:
```caddy
handle_path /api/* {
    reverse_proxy 127.0.0.1:3301
}
```

## Monitoring and logs
- `GET /api/health` returns `{"status":"ok","db":true}`, or 503 when the database doesn't answer. It needs no login
  and creates no session, so it suits uptime monitors and load balancer checks.
- Logs are JSON lines (pino) on stdout: `pm2 logs G5API`. Set `LOG_LEVEL` (`debug`, `info`, `warn`) in `prodrun.json`.
  Authorization headers and cookies are redacted.
- Rejected MatchZy events appear as "Malformed MatchZy event" with the field that was wrong.

## Game server
- **MatchZy 0.9.2 or newer** (released 2026-10-18). On CS2 1.41.9.1, older MatchZy builds write no round backup
  files, so restoring a round fails with "no complete round data" (fixed by PR #422, part of 0.9.2).
- The game server must reach `server.apiURL`. MatchZy loads the match config from it and posts events, demos and
  backups back to it. A match keeps the URLs it was loaded with: after changing `apiURL`, use **Send panel address to
  server** in the match menu for running matches.
- RCON: add the server in the panel with its RCON password. The panel only sends sanitized arguments, and it never
  shows the password except through `GET /servers/:id/rcon` to the owner or a super admin.
- A **join password** set on the server in the panel is applied as `sv_password` when a match loads, and added to
  connect links. It stays set on the server after the match.

## Docker (optional)
`docker-compose.yml` builds this repo (`build: .`) and uses the panel image from your GHCR (`ghcr.io/martitis/g5v-newgen`).
The image runs the same migrations at start. `config/*.json` never goes into the image (`.dockerignore`), and the
container builds `production.json` from environment variables (`config/production.json.template`).

## Security checklist
- Use your own Steam API key. Upstream's history has the original author's key in an old `config/production.json`
  (commit `1916f7b`). Never copy it, and never commit a `config/*.json` (they're gitignored).
- Never run production with `NODE_ENV=test`. The mock login also needs `G5API_MOCK_AUTH=1`, so it stays off, but the
  test config isn't meant for real data.
- Keep `config/production.json` readable only by the user running pm2 (`chmod 600`).
