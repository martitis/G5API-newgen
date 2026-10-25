# G5API-newgen: backend for a CS2 tournament panel (MatchZy)

GitHub: `martitis/G5API-newgen` (renamed from G5API; the local folder is still `G5API`).

Express/TypeScript API that manages CS2 matches, teams, servers, seasons and stats, and drives the
**MatchZy** plugin over RCON. It started as a fork of the original Get5-era G5API (credited in README/LICENSE) and now **diverges
freely**, so don't try to stay merge-compatible with upstream.
Frontend: `../G5V` (Vue). Roadmap and progress: [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md). Tick items off as they land.

## Stack
- Node (ESM, `"type": "module"`), Express 4, TypeScript `strict` → `dist/` via `tsc`
- MySQL via `mysql2` (`src/services/db.ts`), migrations via `db-migrate`
- passport: Steam OpenID plus optional local login (`src/utility/auth.ts`), express-session (optional Redis store)
- RCON: `dathost-rcon-client` (`src/utility/serverrcon.ts`)
- Swagger at `/api-docs`, built from the JSDoc `@swagger` blocks in the route files and `app.ts`

## Commands
Yarn 1 is the package manager; `yarn.lock` is the only lockfile. If yarn isn't installed globally, use `npx yarn@1.22.22 <cmd>`.
All scripts are cross-platform (cross-env plus `scripts/test-admin.mjs`, no sed/export).
- `yarn build`: cleans `dist/`, then tsc. It must pass; a failing build blocks `yarn start` and deploys.
- `yarn lint`: ESLint (type-aware, `eslint.config.js`) with `--max-warnings=<current count>`. **Lower the cap when you
  fix warnings, never raise it.** Promote a rule from "warn" to "error" once its category is fixed.
- `yarn format <files>`: Prettier (`.prettierrc.json`). The codebase hasn't been mass-formatted, so format only files you rewrite.
- `yarn start`: dev (tsc-watch + nodemon). `yarn startprod` / `restartprod` / `stopprod` run pm2 with `prodrun.json`.
- Migrations: `yarn migrate-<dev|prod|test>-upgrade`, `migrate-create-*`, `migrate-drop-*`. Migrations are copied in
  `migrations/{development,production,test}`. Keep the three identical, and **don't merge or move them**: db-migrate
  records each applied migration with its scope folder, so live DBs would re-run everything.
- `yarn test:unit`: DB-free unit tests (`__test__/unit.test.js`). Needs a config, e.g. `NODE_CONFIG_DIR` pointing at a copy of `test.json.template`.
- `yarn test`: builds, runs the unit tests, recreates the test DB, then runs the Jest suites in `__test__/` in a fixed order. It needs a live MySQL
  and `config/test.json`. CI (`.github/workflows/ci.yml`) runs it against a MySQL 8 service.
- Don't put files in `docs/`: `yarn doc` writes jsdoc there and `yarn docclean` deletes it.

## Config
- `config/{development,production,test}.json` are created from `*.json.template` and gitignored (they hold secrets).
- `server.dbKey` must be exactly 16 bytes (the AES key that encrypts RCON passwords and API keys in the DB).
- `server.apiURL` is the public base URL that the game server calls back on. Always build URLs from it with
  `Utils.apiUrl("/path")`, which handles trailing slashes.
- `admins.steam_ids` / `super_admins.steam_ids` are read **from the config file at each Steam login** (no restart
  needed; `access.configRoleLists`) and grant their role (`user.roles_from_config = 1`); leaving a list removes the
  role only when it came from the list. Roles a super admin sets in the panel (`PUT /users`, `roles_from_config = 0`)
  survive logins.
- **Permissions:** the session stores only the user id; `access.loadUser` reloads the user and roles from the DB on
  every request, so role changes apply at once. Accounts with `steam_verified = 0` never count as admin. Accounts can
  be registered without a Steam ID (`user.steam_id` is nullable).
- The mock Steam login (every visitor becomes the test user) needs `NODE_ENV=test` **and** `G5API_MOCK_AUTH=1`;
  the jest configs set both.
- Logging: `src/utility/logger.ts` (pino, JSON; `LOG_LEVEL`). HTTP requests are logged by morgan in development and
  pino-http in production. `GET /health` checks the DB (503 when it's down) for uptime monitors.
- Deployment: bare Node + pm2 behind nginx/Caddy. SSE routes need `proxy_buffering off` and long timeouts.

## Layout
- `app.ts`: middleware, auth routes (`/auth/steam`, `/login`, `/register`, `/logout`), router mounts, and static
  `/demos` and `/backups` from `public/`.
- `src/routes/`
  - `matches/matches.ts`: match CRUD, SSE streams, and **`GET /matches/:id/config`**, which serves the MatchZy match JSON
    built by `src/services/matchconfig.ts` (a pure function with unit tests)
  - `matches/matchserver.ts`: RCON actions (pause, forfeit, cancel, restart, add player, backups, rcon)
  - `v2/api.ts`: **MatchZy event webhook** (remote log URL) → `src/services/{seriesflowservices,mapflowservices}.ts`
  - `v2/demoapi.ts`, `v2/backupapi.ts`: demo and round-backup uploads from the game server
  - teams, servers, seasons, users, vetoes, vetosides, mapstats, playerstats (+ `extrastats.ts`), leaderboard, maps
- `src/utility/utils.ts`: auth guards (`ensureAuthenticated`, `adminCheck`, `superAdminCheck`, `getUserMatchAccess*`),
  `checkApiKey` (game-server auth), `encrypt`/`decrypt`, `getRating`, `getSteamPID`, `updatePlayerStats`, `updatePugStats`
- `src/utility/emitter.ts`: a global EventEmitter feeding the SSE streams
- `src/utility/audit.ts`: `audited("area.action", { target, detail })` middleware writes the audit log
  (`match_audit`) after the response; put it on every new write/admin route. `detail` must never hold secrets.
- `src/routes/admin.ts`: super-admin `/admin/users` and `/admin/audit`
- Tournaments: `src/services/bracket.ts` (pure, unit tested: single/double elimination with byes, round robin, Swiss
  pairings, `resolveBracket`, standings), `src/services/tournaments.ts` (DB: start, `refreshTournament`,
  `onMatchChanged` called on series_end/forfeit/cancel/restart), `src/routes/tournaments.ts`. Slot matches are
  created through `POST /matches` with `tournament_match_id` (checked: slot ready and free, same teams).
- PUG queues: `src/services/pugs.ts` (join, ready check with timeout sweep, formation, `loadMatch`),
  `src/services/pugformation.ts` (pure: balanced/random/captains ABBA), `src/routes/pugs.ts`. Joining needs a
  Steam-verified account. The match is created with `createMatchAs()` (the POST /matches handler, exported from
  `routes/matches/matches.ts`); PUG teams have `team.is_pug = 1` and are hidden from team lists.
- `src/services/challonge.ts`: Challonge score sync. `src/types/`: TS types.

## MatchZy integration facts (verified against the MatchZy source)
Docs: https://shobhit-pathak.github.io/MatchZy/ (commands, configuration, match setup, events).
- **Load:** `matchzy_loadmatch_url "<url>" "Authorization" "<match api_key>"` (`get5_*` aliases exist). The fetch is
  **async**: the RCON reply says nothing about success, so confirm via `get5_status` (`matchid`).
  `get5_status` always reports `plugin_version` 0.15.0.
- **Config JSON:**
  - `maplist` must be an array (null fails the load). `num_maps` ≤ maplist length.
  - Team: only `id`, `name` and `players` (`{steamid64: name}`) are read. `tag`/`flag`/`logo`/`coaches` are ignored, so
    coaches must be listed in `players` and use `.coach` in game.
  - Also read: `spectators.players`, `map_sides` (`team1_ct|team1_t|team2_ct|team2_t|knife`), `veto_first`,
    `side_type`, `skip_veto`, `clinch_series`, `wingman`, `players_per_team`, `min_players_to_ready` (**per team**, `ReadySystem.cs`)
    and `cvars`. `match_title` is ignored.
- **Cvars in the config:**
  - name must match `^[A-Za-z0-9_]+$`
  - a value containing `"`, `;`, CR or LF is rejected
  - `rcon_password` and `matchzy_everyone_is_admin` are blocked
  - `matchzy_*` / `get5_*` names must be on MatchZy's allowlist (`*_remote_log_*`, `*_demo_upload_*` and
    `*_remote_backup_*` are; `get5_check_auths` and `get5_web_api_url` are not)
- **Events** (POST JSON to the remote log URL, header auth): series_start, series_end, map_picked, map_vetoed,
  side_picked, going_live, round_start, round_end (team objects with players[].stats), map_result, player_death,
  bomb_planted, bomb_defused, game_paused, game_unpaused, backup_loaded, player_disconnect, demo_upload_ended.
  **`attacker`, `assist` and `weapon` can be null.** `round_number` is the rounds already played when the round
  started (0-based). `winner.side` is the game's team number (`"3"` CT, `"2"` T, `"0"` none); round_end team objects
  have **no side**, only `score_ct`/`score_t` (team 1's side comes from the winner). There's no retry or dedupe, so handlers must be idempotent and must always respond.
- **Uploads:**
  - demos are raw `.dem` (application/octet-stream) with headers `MatchZy-FileName/MatchId/MapNumber/RoundNumber`
    (also sent as `Get5-*`)
  - backups are JSON `matchzy_<matchid>_<map>_round<NN>.json`
- **RCON commands:** `matchzy_addplayer <steam64> <team1|team2|spec> "<name>"`, `matchzy_removeplayer`,
  `css_forcepause`/`css_forceunpause` (`sm_pause`/`sm_unpause` are aliases), `css_endmatch [team1|team2]`,
  `css_restore <round>`, `matchzy_listbackups`, `matchzy_loadbackup <file>`, `matchzy_loadbackup_url`.
  **`get5_addcoach` does not exist.** `listbackups` output contains `\r\n` and noise lines, so parse it strictly.
  `matchzy_loadbackup` reads its argument raw (`ArgString`): send the file name **unquoted**, or the quotes end up
  in the path (`matchzy_loadbackup_url` parses its arguments normally, so quoting is fine there).

## Conventions (must follow)
- SQL uses `?` placeholders only, through `db.query`.
- Writes are **deny by default**: `access.writeGuard` (in `app.ts`, before all routers) lets a POST/PUT/PATCH/DELETE
  through only for a signed-in admin, or for the short `OPEN_WRITES` allowlist (login/register/logout, the MatchZy
  `/v2` callbacks, PUG join/leave/ready, `PUT /users` for your own account). Regular users are read only, and reads
  must not expose sensitive data (server addresses, keys, other users' accounts). Add to `OPEN_WRITES` only deliberately.
- Every mutating route has `Utils.ensureAuthenticated` plus an explicit owner/admin check. Never `req.user && …`, which
  skips the check for anonymous users. State-changing actions are POST/PUT/DELETE, never GET (CSRF).
- Every value interpolated into an RCON command goes through `safeRconArg()` / the SteamID64 check in
  `src/utility/serverrcon.ts`; they throw `RconArgumentError`, which routes map to 412.
- User-supplied cvars go through `Utils.validateCvars()` before they're stored.
- Secrets are compared with `Utils.safeCompare()`. Steam IDs from users go through `Utils.getSteamPID()`, which returns `""`
  when an ID is invalid.
- Async handlers should catch and call `next(err)`. `src/utility/asyncErrors.ts` (imported first in `app.ts`) forwards
  stray rejections to the global error handler, which sends clients a generic message.
- Never return RCON passwords (`GET /servers/:id/rcon` is the only way to read one), password hashes, or other users' API keys.
- `user.steam_verified = 0` marks a local account whose Steam ID was never proven. It must not get admin rights.
- Match the surrounding style (2-space indent, double quotes, JSDoc `@swagger` blocks on routes).
