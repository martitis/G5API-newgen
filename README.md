# G5API-newgen

The backend of a CS2 tournament panel. It manages matches, teams, servers, seasons, tournaments and PUG queues,
drives the [MatchZy](https://shobhit-pathak.github.io/MatchZy/) plugin over RCON, and keeps the stats MatchZy reports
back. The panel itself is [G5V-newgen](https://github.com/martitis/G5V-newgen) (Vue 3).

This started as a fork of [PhlexPlexico/G5API](https://github.com/PhlexPlexico/G5API), which was written for Get5. It
now targets MatchZy only and has diverged a long way from upstream.

## What it does
- **Matches:** creates a match and loads it onto a free server (`matchzy_loadmatch_url`, and checks it actually
  loaded), with a veto, map sides, spectators, coaches and cvars. Matches can be scheduled, and presets and saved
  templates speed up creation. Only admins create matches.
- **Live data:** MatchZy posts its events to the API, which turns them into a live scoreboard, round history, kill
  feed, bomb and pause state, and player stats. The panel gets updates over server-sent events.
- **Server heartbeat:** every 30 s the API reads `get5_status` from each live match's server. It reports an offline
  server or an interrupted match (a restarted server, or another match loaded), offers recovery actions, and corrects
  scores missed while the panel was down.
- **Match control:** pause, end with a winner, cancel, restart, restore round backups, add or remove players, kick,
  change server, MatchZy admin commands, live cvars, practice mode, and an RCON console. Every action is audited.
- **Tournaments:** single and double elimination, round robin and Swiss, with brackets that advance on their own.
  Optional Challonge sync.
- **PUG queues:** players join, pass a ready check, and get balanced, random or captain-picked teams; the match then
  loads by itself.
- **Seasons, leaderboards, demo uploads**, and Steam login (plus optional local accounts).

## Quick start (development)
Requirements: Node 22, MySQL 8 (or MariaDB 10.6+), and Yarn 1 (`npx yarn@1.22.22` works without installing it).

```sh
npx yarn@1.22.22 install
cp config/development.json.template config/development.json   # fill it in (see below)
npx yarn@1.22.22 migrate-create-dev && npx yarn@1.22.22 migrate-dev-upgrade
npx yarn@1.22.22 start                                         # API on http://localhost:3301
```
Then run the panel (G5V) with `yarn dev`. It proxies `/api` to port 3301.

Config keys that matter most:
- `server.dbKey`: **exactly 16 bytes**. It encrypts RCON passwords and API keys in the database, so keep it.
- `server.steamAPIKey`: your own key from https://steamcommunity.com/dev/apikey.
- `server.apiURL`: the API's address **as the game server sees it** (e.g. `http://192.168.1.10:5173/api/`), because
  MatchZy loads match configs from it and posts events back to it.
- `server.clientHome`: the panel's address (Steam login returns there).
- `admins.steam_ids` / `super_admins.steam_ids`: comma-separated SteamID64s.

`config/*.json` hold secrets and are gitignored. Only the `*.json.template` files are committed.

## Game server
CS2 with [CounterStrikeSharp](https://docs.cssharp.dev/) and [MatchZy](https://shobhit-pathak.github.io/MatchZy/).
Add the server in the panel with its RCON password. Round backups on CS2 1.41.9.1 need MatchZy 0.9.2 or
newer. See [DEPLOY.md](DEPLOY.md#game-server).

## Commands
| | |
| --- | --- |
| `yarn start` | dev server (tsc-watch + nodemon) |
| `yarn build` | type-check and compile to `dist/` (must pass) |
| `yarn lint` | ESLint (warnings capped; the cap only goes down) |
| `yarn test` | all suites against a test database (needs MySQL and `config/test.json`) |
| `yarn test:unit` | the database-free unit tests |
| `yarn migrate-<dev\|prod\|test>-upgrade` | run migrations |
| `yarn startprod` / `restartprod` / `stopprod` | production with pm2 |

API docs (Swagger) are served at `/api-docs`; `GET /health` checks the database.

## Production
Bare Node with pm2 behind nginx or Caddy, on the same origin as the panel. [DEPLOY.md](DEPLOY.md) covers install,
config, updates, the proxy settings that server-sent events and demo uploads need, logs, Docker and a security
checklist.

## Contributing
[CLAUDE.md](CLAUDE.md) is the short guide to the code: stack, layout, verified MatchZy facts and the conventions
every change must follow (parameterized SQL, owner/admin checks, sanitized RCON arguments, no errors leaked to
clients). [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) tracks what has landed and what's open. CI runs build, lint and
the full test suite on MySQL 8.

## License
[MIT](LICENSE). The original G5API is © 2019 PhlexPlexico; the license must be kept with the software.
