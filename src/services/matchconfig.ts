/**
 * Builds the match config JSON that MatchZy loads with matchzy_loadmatch_url.
 * Pure function (no DB access) so it can be unit tested; the route loads the rows.
 * Field rules follow MatchZy's MatchManagement.cs (ValidateMatchJsonStructure / LoadMatchFromJSON):
 * a config that breaks them is rejected as a whole, so values are normalised here.
 * @module services/matchconfig
 */
import Utils from "../utility/utils.js";

const SIDE_TYPES = ["standard", "always_knife", "never_knife", "random"];
const VETO_FIRST = ["team1", "team2", "random"];
const MAP_SIDES = ["team1_ct", "team1_t", "team2_ct", "team2_t", "knife"];

export interface TeamRow {
  id: number;
  name: string | null;
  tag?: string | null;
  flag?: string | null;
  logo?: string | null;
}

export interface TeamAuthRow {
  auth: string;
  name: string | null;
  coach?: number | boolean | null;
}

export interface MatchConfigInput {
  match: { [key: string]: any };
  team1: { team: TeamRow | undefined; auths: TeamAuthRow[] };
  team2: { team: TeamRow | undefined; auths: TeamAuthRow[] };
  /** Rows of match_cvar (cvar_name, cvar_value). */
  cvars: Array<{ cvar_name: string; cvar_value: any }>;
  /** Rows of match_spectator (auth, spectator_name). */
  spectators: Array<{ auth: string; spectator_name: string | null }>;
  /** Whether demo uploads are enabled on this API (server.uploadDemos). */
  uploadDemos: boolean;
  /** The server's join password (game_server.join_password), sent as sv_password. */
  serverPassword?: string | null;
}

export interface MatchZyTeam {
  id: string;
  name: string;
  tag?: string;
  flag?: string;
  logo?: string;
  series_score: number;
  players: { [steamId: string]: string };
}

export interface MatchZyConfig {
  matchid: number;
  num_maps: number;
  maplist: string[];
  skip_veto: boolean;
  clinch_series: boolean;
  side_type?: string;
  veto_first?: string;
  map_sides?: string[];
  players_per_team: number;
  min_players_to_ready: number;
  min_spectators_to_ready: number;
  wingman: boolean;
  team1: MatchZyTeam;
  team2: MatchZyTeam;
  spectators: { players: { [steamId: string]: string } };
  cvars: { [name: string]: string };
}

/** Thrown when a match can't produce a config MatchZy would accept. */
export class MatchConfigError extends Error {}

/** Splits the stored veto_mappool ("de_mirage de_inferno" or comma separated) into map names. */
export function parseMapPool(pool: string | null | undefined): string[] {
  if (!pool) return [];
  return pool.split(/[\s,]+/).filter((map) => map.length > 0);
}

function buildTeam(
  side: { team: TeamRow | undefined; auths: TeamAuthRow[] },
  teamNumber: 1 | 2,
  match: { [key: string]: any }
): MatchZyTeam {
  // MatchZy has no coach list: coaches join as listed players and type .coach in game.
  const players: { [steamId: string]: string } = {};
  for (const auth of side.auths) {
    if (Utils.isSteamId64(auth.auth)) players[auth.auth] = auth.name ?? "";
  }
  const fallbackName = teamNumber === 1 ? match.team1_string : match.team2_string;
  const team: MatchZyTeam = {
    id: String(side.team?.id ?? (teamNumber === 1 ? match.team1_id : match.team2_id) ?? teamNumber),
    name: side.team?.name || fallbackName || `Team ${teamNumber}`,
    series_score: (teamNumber === 1 ? match.team1_series_score : match.team2_series_score) ?? 0,
    players
  };
  // Not read by MatchZy, kept for tools that understand the Get5 format.
  if (side.team?.tag) team.tag = side.team.tag;
  if (side.team?.flag) team.flag = side.team.flag.toUpperCase();
  if (side.team?.logo) team.logo = side.team.logo;
  return team;
}

/**
 * Builds the MatchZy match config.
 * @param input - The match row, both teams with their members, cvars and spectators.
 * @param apiKey - The match API key; MatchZy sends it back on every event, demo and backup upload.
 * @returns The config object to serve as JSON.
 * @throws MatchConfigError if the match has no usable map pool.
 */
export function buildMatchConfig(input: MatchConfigInput, apiKey: string): MatchZyConfig {
  const { match } = input;
  const wingman: boolean = match.wingman == 1;
  const maplist = parseMapPool(match.veto_mappool);
  const numMaps = Math.max(1, parseInt(match.max_maps) || 1);
  if (maplist.length === 0) {
    throw new MatchConfigError("Match has no map pool.");
  }
  if (maplist.length < numMaps) {
    throw new MatchConfigError(`Map pool has ${maplist.length} maps but the series needs ${numMaps}.`);
  }

  const playersPerTeam: number = match.players_per_team ?? (wingman ? 2 : 5);
  // MatchZy applies min_players_to_ready per team (ReadySystem.cs).
  const minPlayersToReady: number = Math.min(match.min_player_ready ?? playersPerTeam, playersPerTeam);

  const config: MatchZyConfig = {
    matchid: Number(match.id),
    num_maps: numMaps,
    maplist,
    skip_veto: match.skip_veto == 1,
    clinch_series: true,
    players_per_team: playersPerTeam,
    min_players_to_ready: minPlayersToReady,
    min_spectators_to_ready: match.min_spectators_to_ready ?? 0,
    wingman,
    team1: buildTeam(input.team1, 1, match),
    team2: buildTeam(input.team2, 2, match),
    spectators: { players: {} },
    cvars: {}
  };

  if (SIDE_TYPES.includes(match.side_type)) config.side_type = match.side_type;
  if (VETO_FIRST.includes(match.veto_first)) config.veto_first = match.veto_first;

  // MatchZy rejects map_sides with unknown values or fewer entries than num_maps; only send a complete list.
  if (match.map_sides) {
    const sides = String(match.map_sides)
      .split(",")
      .map((side) => side.trim())
      .filter((side) => side.length > 0);
    if (sides.length >= numMaps && sides.every((side) => MAP_SIDES.includes(side))) {
      config.map_sides = sides;
    }
  }

  for (const spectator of input.spectators) {
    if (Utils.isSteamId64(spectator.auth)) {
      config.spectators.players[spectator.auth] = spectator.spectator_name ?? "";
    }
  }

  // User cvars first (validated when stored), then the API's own settings so they always win.
  for (const row of input.cvars) {
    if (Utils.validateCvars({ [row.cvar_name]: row.cvar_value }) === null) {
      config.cvars[row.cvar_name] = String(row.cvar_value);
    }
  }
  if (input.serverPassword) config.cvars.sv_password = input.serverPassword;
  Object.assign(config.cvars, callbackCvars(apiKey, input.uploadDemos));

  return config;
}

/** The cvars that make MatchZy send events, round backups and (optionally) demos to this API.
 * Also sent on their own when the API's address changed while a match was loaded.
 */
export function callbackCvars(apiKey: string, uploadDemos: boolean): Record<string, string> {
  const cvars: Record<string, string> = {
    matchzy_remote_log_url: Utils.gameServerUrl("/v2"),
    matchzy_remote_log_header_key: "Authorization",
    matchzy_remote_log_header_value: apiKey,
    matchzy_remote_backup_url: Utils.gameServerUrl("/v2/backup"),
    matchzy_remote_backup_header_key: "Authorization",
    matchzy_remote_backup_header_value: apiKey
  };
  if (uploadDemos) {
    cvars.matchzy_demo_upload_url = Utils.gameServerUrl("/v2/demo");
    cvars.matchzy_demo_upload_header_key = "Authorization";
    cvars.matchzy_demo_upload_header_value = apiKey;
  }
  return cvars;
}
