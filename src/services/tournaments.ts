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
  matches: Map<number, RowDataPacket>
): { group: number; standings: Standing[] }[] {
  return groupSeeds(seeds.length, settings.group_count).map((members, index) => {
    const own = rows.filter((row) => groupOfKey(row.node_key) === index + 1);
    const teamIds = members.map((seed) => seeds[seed - 1]);
    return { group: index + 1, standings: standings(teamIds, playedMatches(own, matches)) };
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

  for (let pass = 0; pass < 2; pass++) {
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
    const resolved = resolveBracket(rows.map(toNode), seeds, results);
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
        if (lastRound < totalRounds) {
          const byes = rows.filter((row) => row.status === "bye").map((row) => row.winner_id as number);
          const ranking: Standing[] = standings(seeds, playedMatches(rows, matches), true, byes);
          await insertNodes(tournamentId, swissPairings(lastRound + 1, ranking, byes));
          continue; // resolve the new round (byes) in the second pass
        }
        await db.query("UPDATE tournament SET status = 'finished' WHERE id = ?", [tournamentId]);
      }
    } else if (tournament.format === "groups_playoff" && !rows.some((row) => row.bracket !== "group")) {
      // The playoff is seeded from the final group tables, so it only exists once every group match is played.
      if (rows.every((row) => finished(row.status))) {
        const tables = groupTables(seeds, settings, rows, matches).map((table) => table.standings);
        await insertNodes(tournamentId, playoffBracket(playoffSeeds(tables, settings.group_advance)));
        continue; // resolve the playoff (byes) in the second pass
      }
    } else if (rows.every((row) => finished(row.status))) {
      await db.query("UPDATE tournament SET status = 'finished' WHERE id = ?", [tournamentId]);
    }
    break;
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
    "SELECT tt.seed, t.id, t.name, t.tag, t.logo, t.flag FROM tournament_team tt JOIN team t ON t.id = tt.team_id " +
      "WHERE tt.tournament_id = ? ORDER BY tt.seed",
    [tournamentId]
  );
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
    table = standings(seeds, playedMatches(rows, matches), tournament.format === "swiss", byes);
  }
  const groups =
    tournament.format === "groups_playoff"
      ? groupTables(
          teams.map((team) => team.id as number),
          parseSettings(tournament.settings),
          rows,
          matches
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
