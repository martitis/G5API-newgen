/** Tournaments in the database: loading, starting, and advancing the bracket after each result.
 * The bracket logic itself is in services/bracket.ts.
 * @module services/tournaments
 */
import { RowDataPacket } from "mysql2";
import { db } from "./db.js";
import GlobalEmitter from "../utility/emitter.js";
import logger from "../utility/logger.js";
import {
  BracketNode,
  dependentKeys,
  generateBracket,
  groupOfKey,
  groupSeeds,
  PlayedMatch,
  playoffBracket,
  playoffSeeds,
  resolveBracket,
  Results,
  Source,
  Standing,
  standings,
  swissPairings,
  swissRounds,
  TournamentFormat
} from "./bracket.js";

export const FORMATS: TournamentFormat[] = ["single_elim", "double_elim", "round_robin", "swiss", "groups_playoff"];

export interface TournamentSettings {
  /** Series length of normal matches and of finals (elimination finals, grand final). */
  best_of: number;
  final_best_of: number;
  swiss_rounds?: number;
  /** Groups + playoff: the number of round robin groups and how many of each go to the playoff. */
  group_count: number;
  group_advance: number;
  map_pool: string[];
  players_per_team: number;
  min_players_to_ready: number;
  side_type: string;
  skip_veto: boolean;
  /** Optional Challonge tournament (its URL id, e.g. "abc123" or "sub-abc123") that results are reported to. */
  challonge_url?: string;
}

export const DEFAULT_SETTINGS: TournamentSettings = {
  best_of: 1,
  final_best_of: 3,
  group_count: 2,
  group_advance: 2,
  map_pool: [],
  players_per_team: 5,
  min_players_to_ready: 5,
  side_type: "standard",
  skip_veto: false
};

/** Accepts only known settings with sane values. */
export function cleanSettings(input: unknown): TournamentSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const int = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
  };
  const bestOf = (value: unknown, fallback: number) => {
    const parsed = int(value, fallback, 1, 7);
    return [1, 2, 3, 5, 7].includes(parsed) ? parsed : fallback;
  };
  const players = int(raw.players_per_team, DEFAULT_SETTINGS.players_per_team, 1, 10);
  return {
    best_of: bestOf(raw.best_of, DEFAULT_SETTINGS.best_of),
    final_best_of: bestOf(raw.final_best_of, DEFAULT_SETTINGS.final_best_of),
    swiss_rounds: raw.swiss_rounds == null ? undefined : int(raw.swiss_rounds, 3, 1, 10),
    group_count: int(raw.group_count, DEFAULT_SETTINGS.group_count, 1, 16),
    group_advance: int(raw.group_advance, DEFAULT_SETTINGS.group_advance, 1, 16),
    map_pool: Array.isArray(raw.map_pool)
      ? raw.map_pool.filter((map): map is string => typeof map === "string" && /^[A-Za-z0-9_./-]{1,128}$/.test(map))
      : [],
    players_per_team: players,
    min_players_to_ready: int(raw.min_players_to_ready, players, 1, players),
    side_type: ["standard", "never_knife", "always_knife"].includes(String(raw.side_type))
      ? String(raw.side_type)
      : DEFAULT_SETTINGS.side_type,
    skip_veto: Boolean(raw.skip_veto),
    challonge_url:
      typeof raw.challonge_url === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(raw.challonge_url.trim())
        ? raw.challonge_url.trim()
        : undefined
  };
}

const parseSettings = (text: unknown): TournamentSettings => {
  try {
    return cleanSettings(JSON.parse(typeof text === "string" ? text : "{}"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

const truthy = (value: unknown) => value === true || Number(value) === 1;

/** Rows of a tournament's bracket nodes, in generation (dependency) order. */
async function nodeRows(tournamentId: number): Promise<RowDataPacket[]> {
  return db.query("SELECT * FROM tournament_match WHERE tournament_id = ? ORDER BY id", [tournamentId]);
}

const toNode = (row: RowDataPacket): BracketNode => ({
  key: row.node_key,
  bracket: row.bracket,
  round: row.round,
  position: row.position,
  final: truthy(row.is_final),
  sources: JSON.parse(row.sources) as [Source, Source]
});

async function seededTeamIds(tournamentId: number): Promise<number[]> {
  const rows: RowDataPacket[] = await db.query(
    "SELECT team_id FROM tournament_team WHERE tournament_id = ? ORDER BY seed",
    [tournamentId]
  );
  return rows.map((row) => row.team_id);
}

/** Teams disqualified from the tournament. */
async function disqualifiedTeams(tournamentId: number): Promise<Set<number>> {
  const rows: RowDataPacket[] = await db.query(
    "SELECT team_id FROM tournament_team WHERE tournament_id = ? AND disqualified = 1",
    [tournamentId]
  );
  return new Set(rows.map((row) => row.team_id as number));
}

/** Disqualified teams go to the bottom of a table (they can't qualify or win). */
const disqualifiedLast = (table: Standing[], disqualified: ReadonlySet<number>): Standing[] => [
  ...table.filter((row) => !disqualified.has(row.team_id)),
  ...table.filter((row) => disqualified.has(row.team_id))
];

async function insertNodes(tournamentId: number, nodes: BracketNode[]): Promise<void> {
  for (const node of nodes) {
    await db.query(
      "INSERT INTO tournament_match (tournament_id, node_key, bracket, round, position, is_final, sources) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [tournamentId, node.key, node.bracket, node.round, node.position, node.final ? 1 : 0, JSON.stringify(node.sources)]
    );
  }
}

/** Generates the bracket (Swiss: round 1) and marks the tournament running. */
export async function startTournament(tournamentId: number): Promise<void> {
  const rows: RowDataPacket[] = await db.query("SELECT format, status, settings FROM tournament WHERE id = ?", [
    tournamentId
  ]);
  if (!rows.length) throw new Error("Tournament not found.");
  if (rows[0].status !== "draft") throw new Error("The tournament has already started.");
  const teamIds = await seededTeamIds(tournamentId);
  const settings = parseSettings(rows[0].settings);
  const nodes = generateBracket(rows[0].format as TournamentFormat, teamIds, {
    groups: settings.group_count,
    advance: settings.group_advance
  });
  await insertNodes(tournamentId, nodes);
  await db.query("UPDATE tournament SET status = 'running' WHERE id = ?", [tournamentId]);
  await refreshTournament(tournamentId);
}

/** Played matches of round robin / Swiss nodes, for the standings. */
function playedMatches(rows: RowDataPacket[], matches: Map<number, RowDataPacket>): PlayedMatch[] {
  const played: PlayedMatch[] = [];
  for (const row of rows) {
    if (row.status !== "done" || row.team1_id == null || row.team2_id == null) continue;
    const match = row.match_id ? matches.get(row.match_id) : undefined;
    // The match row's team1 may be either slot; align its series score with the node's teams.
    const same = !match || match.team1_id === row.team1_id;
    played.push({
      team1_id: row.team1_id,
      team2_id: row.team2_id,
      winner_id: row.winner_id,
      team1_maps: match ? Number(same ? match.team1_score : match.team2_score) || 0 : 0,
      team2_maps: match ? Number(same ? match.team2_score : match.team1_score) || 0 : 0
    });
  }
  return played;
}

/** Groups + playoff: each group's table (teams in group order), from its own matches. */
function groupTables(
  seeds: number[],
  settings: TournamentSettings,
  rows: RowDataPacket[],
  matches: Map<number, RowDataPacket>,
  disqualified: ReadonlySet<number>
): { group: number; standings: Standing[] }[] {
  return groupSeeds(seeds.length, settings.group_count).map((members, index) => {
    const own = rows.filter((row) => groupOfKey(row.node_key) === index + 1);
    const teamIds = members.map((seed) => seeds[seed - 1]);
    return { group: index + 1, standings: disqualifiedLast(standings(teamIds, playedMatches(own, matches)), disqualified) };
  });
}

/**
 * Recomputes the bracket from the linked matches: fills in teams, applies results and byes, unlinks cancelled
 * matches, pairs the next Swiss round when one is complete, creates the playoff once the groups are played, and
 * marks the tournament finished at the end.
 */
export async function refreshTournament(tournamentId: number): Promise<void> {
  const tournamentRows: RowDataPacket[] = await db.query("SELECT * FROM tournament WHERE id = ?", [tournamentId]);
  const tournament = tournamentRows[0];
  if (!tournament || tournament.status === "draft") return;
  const settings = parseSettings(tournament.settings);
  const seeds = await seededTeamIds(tournamentId);
  const disqualified = await disqualifiedTeams(tournamentId);

  let complete = false;
  for (let pass = 0; pass < 2; pass++) {
    complete = false;
    const rows = await nodeRows(tournamentId);
    const matchIds = rows.map((row) => row.match_id).filter((id) => id != null);
    const matchRows: RowDataPacket[] = matchIds.length
      ? await db.query(
          "SELECT id, team1_id, team2_id, winner, team1_score, team2_score, end_time, cancelled, forfeit FROM `match` WHERE id IN (?)",
          [matchIds]
        )
      : [];
    const matches = new Map(matchRows.map((match) => [match.id as number, match]));
    const results: Results = {};
    for (const row of rows) {
      const match = row.match_id ? matches.get(row.match_id) : undefined;
      if (!match) continue;
      if (truthy(match.cancelled)) {
        // A cancelled match frees the slot so a new one can be created.
        await db.query("UPDATE tournament_match SET match_id = NULL WHERE id = ?", [row.id]);
        continue;
      }
      if ((match.end_time != null || truthy(match.forfeit)) && match.winner != null) {
        results[row.node_key] = { winner_id: match.winner };
      }
    }
    const resolved = resolveBracket(rows.map(toNode), seeds, results, disqualified);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const node = resolved[i];
      if (
        row.team1_id !== node.team1_id ||
        row.team2_id !== node.team2_id ||
        row.winner_id !== node.winner_id ||
        row.status !== node.status
      ) {
        await db.query(
          "UPDATE tournament_match SET team1_id = ?, team2_id = ?, winner_id = ?, status = ? WHERE id = ?",
          [node.team1_id, node.team2_id, node.winner_id, node.status, row.id]
        );
        Object.assign(row, {
          team1_id: node.team1_id,
          team2_id: node.team2_id,
          winner_id: node.winner_id,
          status: node.status
        });
      }
    }

    const finished = (status: string) => ["done", "bye", "empty"].includes(status);
    if (tournament.format === "swiss") {
      const lastRound = Math.max(...rows.map((row) => row.round));
      const current = rows.filter((row) => row.round === lastRound);
      const totalRounds = settings.swiss_rounds ?? swissRounds(seeds.length);
      if (current.every((row) => finished(row.status))) {
        const byes = rows.filter((row) => row.status === "bye").map((row) => row.winner_id as number);
        // Disqualified teams aren't paired any more.
        const ranking: Standing[] = standings(seeds, playedMatches(rows, matches), true, byes).filter(
          (row) => !disqualified.has(row.team_id)
        );
        if (lastRound < totalRounds && ranking.length >= 2) {
          await insertNodes(tournamentId, swissPairings(lastRound + 1, ranking, byes));
          continue; // resolve the new round (byes) in the second pass
        }
        complete = true;
      }
    } else if (tournament.format === "groups_playoff" && !rows.some((row) => row.bracket !== "group")) {
      // The playoff is seeded from the final group tables, so it only exists once every group match is played.
      if (rows.every((row) => finished(row.status))) {
        const tables = groupTables(seeds, settings, rows, matches, disqualified).map((table) =>
          table.standings.filter((row) => !disqualified.has(row.team_id))
        );
        const qualified = playoffSeeds(tables, settings.group_advance);
        if (qualified.length >= 2) {
          await insertNodes(tournamentId, playoffBracket(qualified));
          continue; // resolve the playoff (byes) in the second pass
        }
        complete = true;
      }
    } else {
      complete = rows.every((row) => finished(row.status));
    }
    break;
  }
  // Undoing a result (unlinking a match, reinstating a team) can reopen a finished tournament.
  const status = complete ? "finished" : "running";
  if (tournament.status !== status) {
    await db.query("UPDATE tournament SET status = ? WHERE id = ?", [status, tournamentId]);
  }
  GlobalEmitter.emit("tournamentUpdate");
}

/** Called when a match ends (series_end, forfeit, cancel): advances its tournament, if it belongs to one. */
export async function onMatchChanged(matchId: number | string): Promise<void> {
  try {
    const rows: RowDataPacket[] = await db.query(
      "SELECT DISTINCT tournament_id FROM tournament_match WHERE match_id = ?",
      [matchId]
    );
    for (const row of rows) await refreshTournament(row.tournament_id);
  } catch (err) {
    // A tournament problem must never fail the game server's event.
    logger.error({ err }, "Tournament update failed");
  }
}

/** Everything the tournament page shows. */
export async function loadTournament(tournamentId: number): Promise<Record<string, unknown> | null> {
  const tournamentRows: RowDataPacket[] = await db.query(
    "SELECT t.*, u.name AS owner FROM tournament t LEFT JOIN user u ON u.id = t.user_id WHERE t.id = ?",
    [tournamentId]
  );
  const tournament = tournamentRows[0];
  if (!tournament) return null;
  const teams: RowDataPacket[] = await db.query(
    "SELECT tt.seed, tt.disqualified, t.id, t.name, t.tag, t.logo, t.flag FROM tournament_team tt JOIN team t ON t.id = tt.team_id " +
      "WHERE tt.tournament_id = ? ORDER BY tt.seed",
    [tournamentId]
  );
  for (const team of teams) team.disqualified = truthy(team.disqualified);
  const disqualified = new Set(teams.filter((team) => team.disqualified).map((team) => team.id as number));
  const rows = await nodeRows(tournamentId);
  const matchIds = rows.map((row) => row.match_id).filter((id) => id != null);
  const matchRows: RowDataPacket[] = matchIds.length
    ? await db.query(
        "SELECT id, team1_id, team2_id, winner, team1_score, team2_score, start_time, end_time, cancelled, forfeit, server_id " +
          "FROM `match` WHERE id IN (?)",
        [matchIds]
      )
    : [];
  const matches = new Map(matchRows.map((match) => [match.id as number, match]));
  const nodes = rows.map((row) => {
    const match = row.match_id ? matches.get(row.match_id) : undefined;
    const same = !match || match.team1_id === row.team1_id;
    return {
      id: row.id,
      key: row.node_key,
      bracket: row.bracket,
      group: groupOfKey(row.node_key),
      round: row.round,
      position: row.position,
      final: truthy(row.is_final),
      team1_id: row.team1_id,
      team2_id: row.team2_id,
      winner_id: row.winner_id,
      // "live" while a linked match is being played.
      status: row.status === "ready" && match && match.end_time == null ? "live" : row.status,
      match_id: row.match_id,
      // An admin set this slot's teams by hand (PUT /tournaments/:id/nodes/:node_id can reset it).
      manual: row.auto_sources != null,
      // Only the id: the address comes from GET /servers/:id, which checks who may see it.
      server_id: match ? match.server_id : null,
      best_of: truthy(row.is_final) ? parseSettings(tournament.settings).final_best_of : parseSettings(tournament.settings).best_of,
      score: match
        ? [Number(same ? match.team1_score : match.team2_score) || 0, Number(same ? match.team2_score : match.team1_score) || 0]
        : null
    };
  });
  let table: Standing[] | null = null;
  if (tournament.format === "round_robin" || tournament.format === "swiss") {
    const seeds = teams.map((team) => team.id as number);
    const byes = rows.filter((row) => row.status === "bye").map((row) => row.winner_id as number);
    table = disqualifiedLast(
      standings(seeds, playedMatches(rows, matches), tournament.format === "swiss", byes),
      disqualified
    );
  }
  const groups =
    tournament.format === "groups_playoff"
      ? groupTables(
          teams.map((team) => team.id as number),
          parseSettings(tournament.settings),
          rows,
          matches,
          disqualified
        )
      : null;
  return {
    tournament: {
      id: tournament.id,
      name: tournament.name,
      format: tournament.format,
      status: tournament.status,
      season_id: tournament.season_id,
      user_id: tournament.user_id,
      owner: tournament.owner,
      created_at: tournament.created_at,
      settings: parseSettings(tournament.settings)
    },
    teams,
    nodes,
    standings: table,
    groups
  };
}

/** A refused tournament edit, with the HTTP status the route sends. */
export class TournamentError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/** The tournament's row for an admin edit (started, not a draft). */
async function startedTournament(tournamentId: number): Promise<RowDataPacket> {
  const rows: RowDataPacket[] = await db.query("SELECT * FROM tournament WHERE id = ?", [tournamentId]);
  if (!rows.length) throw new TournamentError(404, "Tournament not found.");
  if (rows[0].status === "draft") {
    throw new TournamentError(412, "The tournament hasn't started: edit its teams instead.");
  }
  return rows[0];
}

const matchFinished = (match: RowDataPacket | undefined) =>
  match != null && !truthy(match.cancelled) && (match.end_time != null || truthy(match.forfeit)) && match.winner != null;

/**
 * Why the outcome of a node can't change any more, or null: a later slot fed by it already has a match, a later
 * Swiss round was paired from it, or the playoff was drawn from the group it belongs to.
 */
function lockedReason(tournament: RowDataPacket, rows: RowDataPacket[], row: RowDataPacket): string | null {
  const dependents = dependentKeys(rows.map(toNode), row.node_key);
  if (rows.some((other) => dependents.has(other.node_key) && other.match_id != null)) {
    return "A later slot that depends on this one already has a match. Unlink that one first.";
  }
  if (tournament.format === "swiss" && rows.some((other) => other.round > row.round)) {
    return "The next Swiss round was already paired from this result.";
  }
  if (row.bracket === "group" && rows.some((other) => other.bracket !== "group")) {
    return "The playoff was already drawn from the group results.";
  }
  return null;
}

/**
 * Disqualifies a team (it loses every slot it hasn't played; played results stand) or reinstates it.
 * On disqualification, unfinished matches of its slots are unlinked so they can't decide the slot any more;
 * their ids are returned so the admin can cancel them on the server.
 */
export async function setDisqualified(
  tournamentId: number,
  teamId: number,
  disqualified: boolean
): Promise<{ unlinked: number[] }> {
  const tournament = await startedTournament(tournamentId);
  const entry: RowDataPacket[] = await db.query(
    "SELECT disqualified FROM tournament_team WHERE tournament_id = ? AND team_id = ?",
    [tournamentId, teamId]
  );
  if (!entry.length) throw new TournamentError(404, "The team isn't in this tournament.");
  if (truthy(entry[0].disqualified) === disqualified) return { unlinked: [] };

  const rows = await nodeRows(tournamentId);
  const own = rows.filter((row) => row.team1_id === teamId || row.team2_id === teamId);
  const matchIds = own.map((row) => row.match_id).filter((id) => id != null);
  const matchRows: RowDataPacket[] = matchIds.length
    ? await db.query("SELECT id, winner, end_time, cancelled, forfeit FROM `match` WHERE id IN (?)", [matchIds])
    : [];
  const matches = new Map(matchRows.map((match) => [match.id as number, match]));
  const unlinked: number[] = [];

  if (disqualified) {
    for (const row of own) {
      if (row.match_id != null && !matchFinished(matches.get(row.match_id))) {
        await db.query("UPDATE tournament_match SET match_id = NULL WHERE id = ?", [row.id]);
        unlinked.push(row.match_id);
      }
    }
  } else {
    // The slots the disqualification decided (no played match) go back to ready: nothing may depend on them yet.
    for (const row of own) {
      const decidedByDq =
        !matchFinished(row.match_id ? matches.get(row.match_id) : undefined) &&
        ((row.status === "done" && row.winner_id !== teamId) || row.status === "empty");
      const reason = decidedByDq ? lockedReason(tournament, rows, row) : null;
      if (reason) throw new TournamentError(409, `The team can't be reinstated. ${reason}`);
    }
  }
  await db.query("UPDATE tournament_team SET disqualified = ? WHERE tournament_id = ? AND team_id = ?", [
    disqualified ? 1 : 0,
    tournamentId,
    teamId
  ]);
  await refreshTournament(tournamentId);
  return { unlinked };
}

async function tournamentNode(tournamentId: number, nodeId: number): Promise<RowDataPacket> {
  const rows: RowDataPacket[] = await db.query("SELECT * FROM tournament_match WHERE id = ? AND tournament_id = ?", [
    nodeId,
    tournamentId
  ]);
  if (!rows.length) throw new TournamentError(404, "Tournament match not found.");
  return rows[0];
}

/**
 * Sets the two teams of a slot that has no match yet (null = nobody, a bye), or with teams = null puts back the
 * teams the bracket generated for it. A slot set by hand keeps its teams whatever happens before it.
 */
export async function setNodeTeams(
  tournamentId: number,
  nodeId: number,
  teams: [number | null, number | null] | null
): Promise<void> {
  const tournament = await startedTournament(tournamentId);
  const node = await tournamentNode(tournamentId, nodeId);
  if (node.match_id != null) throw new TournamentError(409, "This slot has a match: unlink it first.");
  const rows = await nodeRows(tournamentId);
  const reason = lockedReason(tournament, rows, node);
  if (reason) throw new TournamentError(409, reason);

  if (teams === null) {
    if (node.auto_sources == null) return;
    await db.query("UPDATE tournament_match SET sources = ?, auto_sources = NULL WHERE id = ?", [
      node.auto_sources,
      node.id
    ]);
  } else {
    const chosen = teams.filter((id): id is number => id != null);
    if (chosen.length === 2 && chosen[0] === chosen[1]) {
      throw new TournamentError(412, "A team can't play itself.");
    }
    const entries: RowDataPacket[] = await db.query(
      "SELECT team_id, disqualified FROM tournament_team WHERE tournament_id = ?",
      [tournamentId]
    );
    for (const id of chosen) {
      const entry = entries.find((row) => row.team_id === id);
      if (!entry) throw new TournamentError(412, "A team isn't in this tournament.");
      if (truthy(entry.disqualified)) throw new TournamentError(412, "A disqualified team can't be placed in a slot.");
    }
    const group = groupOfKey(node.node_key);
    if (group != null) {
      // Group standings only count the group's own teams.
      const seeds = await seededTeamIds(tournamentId);
      const members = groupSeeds(seeds.length, parseSettings(tournament.settings).group_count)[group - 1] ?? [];
      const memberIds = members.map((seed) => seeds[seed - 1]);
      if (chosen.some((id) => !memberIds.includes(id))) {
        throw new TournamentError(412, "Both teams must be from this group.");
      }
    }
    const busy = rows.find(
      (row) =>
        row.id !== node.id &&
        row.bracket === node.bracket &&
        row.round === node.round &&
        groupOfKey(row.node_key) === group &&
        chosen.some((id) => row.team1_id === id || row.team2_id === id)
    );
    if (busy) throw new TournamentError(412, "A team already plays another match of this round.");
    const sources: [Source, Source] = [
      teams[0] == null ? null : { type: "team", team_id: teams[0] },
      teams[1] == null ? null : { type: "team", team_id: teams[1] }
    ];
    await db.query("UPDATE tournament_match SET sources = ?, auto_sources = ? WHERE id = ?", [
      JSON.stringify(sources),
      node.auto_sources ?? node.sources,
      node.id
    ]);
  }
  await refreshTournament(tournamentId);
}

/**
 * Links an existing match (e.g. one created by hand on the create match page) to a ready slot with the same
 * teams, or with matchId = null unlinks the slot's match (the match itself stays). A finished match decides the
 * slot at once.
 */
export async function setNodeMatch(tournamentId: number, nodeId: number, matchId: number | null): Promise<void> {
  const tournament = await startedTournament(tournamentId);
  const node = await tournamentNode(tournamentId, nodeId);
  if (matchId === null) {
    if (node.match_id == null) return;
    const reason = lockedReason(tournament, await nodeRows(tournamentId), node);
    if (reason) throw new TournamentError(409, reason);
    await db.query("UPDATE tournament_match SET match_id = NULL WHERE id = ?", [node.id]);
  } else {
    if (node.match_id != null) throw new TournamentError(409, "This slot already has a match: unlink it first.");
    if (node.status !== "ready") {
      throw new TournamentError(409, "Only a slot with both teams and no result can get a match.");
    }
    const found: RowDataPacket[] = await db.query("SELECT id, team1_id, team2_id, cancelled FROM `match` WHERE id = ?", [
      matchId
    ]);
    const match = found[0];
    if (!match) throw new TournamentError(404, "Match not found.");
    if (truthy(match.cancelled)) throw new TournamentError(412, "The match was cancelled.");
    const sameTeams =
      (match.team1_id === node.team1_id && match.team2_id === node.team2_id) ||
      (match.team1_id === node.team2_id && match.team2_id === node.team1_id);
    if (!sameTeams) throw new TournamentError(412, "The match's teams don't match the slot's teams.");
    const linked: RowDataPacket[] = await db.query("SELECT id FROM tournament_match WHERE match_id = ?", [matchId]);
    if (linked.length) throw new TournamentError(409, "That match already belongs to a tournament slot.");
    await db.query("UPDATE tournament_match SET match_id = ? WHERE id = ?", [matchId, node.id]);
  }
  await refreshTournament(tournamentId);
}
