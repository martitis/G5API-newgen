/** PUG queues: join, ready check, team formation (random, balanced, captains pick) and loading the match.
 * Team splitting is in services/pugformation.ts; the match is created like POST /matches (createMatchAs).
 * @module services/pugs
 */
import { RowDataPacket } from "mysql2";
import { db } from "./db.js";
import GlobalEmitter from "../utility/emitter.js";
import Utils from "../utility/utils.js";
import { createMatchAs } from "../routes/matches/matches.js";
import logger from "../utility/logger.js";
import {
  balancedTeams,
  chooseCaptains,
  Formation,
  nextPickingTeam,
  QueuedPlayer,
  randomTeams
} from "./pugformation.js";

export interface PugSettings {
  players_per_team: number;
  formation: Formation;
  max_maps: number;
  map_pool: string[];
  side_type: string;
  skip_veto: boolean;
  /** Seconds everyone has to confirm once the queue is full. */
  ready_seconds: number;
}

/** A refused action; routes answer it with `status`. */
export class PugError extends Error {
  constructor(
    message: string,
    public status = 412
  ) {
    super(message);
  }
}

const truthy = (value: unknown) => value === true || Number(value) === 1;
const sqlDate = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

/** Accepts only known settings with sane values. */
export function cleanPugSettings(input: unknown): PugSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const int = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
    return Number.isFinite(parsed) ? Math.min(Math.max(Math.round(parsed), min), max) : fallback;
  };
  const maxMaps = int(raw.max_maps, 1, 1, 5);
  return {
    players_per_team: int(raw.players_per_team, 5, 1, 7),
    formation: ["random", "balanced", "captains"].includes(String(raw.formation))
      ? (raw.formation as Formation)
      : "balanced",
    max_maps: [1, 3, 5].includes(maxMaps) ? maxMaps : 1,
    map_pool: Array.isArray(raw.map_pool)
      ? raw.map_pool.filter((map): map is string => typeof map === "string" && /^[A-Za-z0-9_./-]{1,128}$/.test(map))
      : [],
    side_type: ["standard", "never_knife", "always_knife"].includes(String(raw.side_type))
      ? String(raw.side_type)
      : "standard",
    skip_veto: Boolean(raw.skip_veto),
    ready_seconds: int(raw.ready_seconds, 60, 20, 300)
  };
}

const parseSettings = (text: unknown): PugSettings => {
  try {
    return cleanPugSettings(JSON.parse(typeof text === "string" ? text : "{}"));
  } catch {
    return cleanPugSettings({});
  }
};

async function queueRow(queueId: number): Promise<RowDataPacket> {
  const rows: RowDataPacket[] = await db.query("SELECT * FROM pug_queue WHERE id = ?", [queueId]);
  if (!rows.length) throw new PugError("Queue not found.", 404);
  return rows[0];
}

async function players(queueId: number): Promise<RowDataPacket[]> {
  return db.query("SELECT * FROM pug_queue_player WHERE queue_id = ? ORDER BY joined_at, id", [queueId]);
}

/** Ratings from all of each player's stats (1.0 when there are none). */
async function ratings(steamIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>(steamIds.map((id) => [id, 1]));
  if (!steamIds.length) return result;
  const rows: RowDataPacket[] = await db.query(
    "SELECT steam_id, SUM(kills) AS kills, SUM(deaths) AS deaths, SUM(roundsplayed) AS rounds, SUM(k1) AS k1, " +
      "SUM(k2) AS k2, SUM(k3) AS k3, SUM(k4) AS k4, SUM(k5) AS k5 FROM player_stats WHERE steam_id IN (?) GROUP BY steam_id",
    [steamIds]
  );
  for (const row of rows) {
    if (!Number(row.rounds)) continue;
    const rating = Number(
      Utils.getRating(
        Number(row.kills),
        Number(row.rounds),
        Number(row.deaths),
        Number(row.k1),
        Number(row.k2),
        Number(row.k3),
        Number(row.k4),
        Number(row.k5)
      )
    );
    if (Number.isFinite(rating)) result.set(row.steam_id, rating);
  }
  return result;
}

const changed = () => GlobalEmitter.emit("pugUpdate");

/** Everything the queue page shows. */
export async function loadQueue(queueId: number): Promise<Record<string, unknown>> {
  await tickQueue(queueId);
  const queue = await queueRow(queueId);
  const settings = parseSettings(queue.settings);
  const rows: RowDataPacket[] = await db.query(
    "SELECT p.user_id, p.steam_id, p.name, p.ready, p.team, p.captain, p.joined_at, u.small_image " +
      "FROM pug_queue_player p LEFT JOIN user u ON u.id = p.user_id WHERE p.queue_id = ? ORDER BY p.joined_at, p.id",
    [queueId]
  );
  const ratingMap = await ratings(rows.map((row) => row.steam_id));
  const picksMade = rows.filter((row) => row.team != null && !truthy(row.captain)).length;
  const pickingTeam = queue.status === "picking" ? nextPickingTeam(picksMade) : null;
  return {
    queue: {
      id: queue.id,
      user_id: queue.user_id,
      title: queue.title,
      status: queue.status,
      server_id: queue.server_id,
      season_id: queue.season_id,
      match_id: queue.match_id,
      error: queue.error,
      ready_deadline: queue.ready_deadline,
      expires_at: queue.expires_at,
      created_at: queue.created_at,
      settings,
      size: settings.players_per_team * 2,
      picking_team: pickingTeam,
      picking_captain:
        pickingTeam == null ? null : rows.find((row) => truthy(row.captain) && row.team === pickingTeam)?.user_id ?? null
    },
    players: rows.map((row) => ({
      user_id: row.user_id,
      steam_id: row.steam_id,
      name: row.name,
      image: row.small_image,
      ready: truthy(row.ready),
      team: row.team,
      captain: truthy(row.captain),
      rating: Math.round((ratingMap.get(row.steam_id) ?? 1) * 100) / 100
    }))
  };
}

/** Open queues for the match list ("Open queue 7/10"). */
export interface OpenQueue {
  id: number;
  title: string | null;
  status: string;
  created_at: string;
  joined: number;
  size: number;
}

export async function openQueues(): Promise<OpenQueue[]> {
  const rows: RowDataPacket[] = await db.query(
    "SELECT q.id, q.title, q.status, q.settings, q.created_at, " +
      "(SELECT COUNT(*) FROM pug_queue_player p WHERE p.queue_id = q.id) AS joined " +
      "FROM pug_queue q WHERE q.status IN ('open', 'ready_check', 'picking', 'loading') ORDER BY q.id DESC"
  );
  return rows.map((row) => {
    const settings = parseSettings(row.settings);
    return { id: row.id, title: row.title, status: row.status, created_at: row.created_at, joined: Number(row.joined), size: settings.players_per_team * 2 };
  });
}

export async function createQueue(user: Express.User, body: Record<string, any>): Promise<number> {
  if (!Utils.adminCheck(user)) throw new PugError("Only admins can open a PUG queue.", 403);
  const settings = cleanPugSettings(body.settings);
  if (settings.map_pool.length < settings.max_maps) {
    throw new PugError("The map pool needs at least as many maps as the series.");
  }
  const serverId = Number(body.server_id) || null;
  if (serverId) {
    const server: RowDataPacket[] = await db.query("SELECT user_id, public_server FROM game_server WHERE id = ?", [serverId]);
    if (!server.length) throw new PugError("Server not found.", 404);
    if (server[0].user_id !== user.id && !truthy(server[0].public_server) && !Utils.adminCheck(user)) {
      throw new PugError("User does not own this server.", 403);
    }
  }
  const expiresMinutes = Number(body.expires_minutes) || 0;
  const insert: any = await db.query(
    "INSERT INTO pug_queue (user_id, server_id, season_id, title, settings, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      user.id,
      serverId,
      Number(body.season_id) || null,
      typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 100) : null,
      JSON.stringify(settings),
      expiresMinutes > 0 ? sqlDate(new Date(Date.now() + Math.min(expiresMinutes, 24 * 60) * 60000)) : null
    ]
  );
  changed();
  return insert.insertId;
}

export async function joinQueue(queueId: number, user: Express.User): Promise<void> {
  await tickQueue(queueId);
  const queue = await queueRow(queueId);
  if (queue.status !== "open") throw new PugError("This queue isn't open.", 409);
  // MatchZy only lets roster Steam IDs in, so the Steam ID must be the player's own.
  const account: RowDataPacket[] = await db.query("SELECT steam_verified, steam_id, name FROM user WHERE id = ?", [user.id]);
  if (!truthy(account[0]?.steam_verified) || !Utils.isSteamId64(account[0]?.steam_id)) {
    throw new PugError("Sign in with Steam to join a queue.", 403);
  }
  const settings = parseSettings(queue.settings);
  const current = await players(queueId);
  if (current.some((row) => row.user_id === user.id)) return;
  if (current.length >= settings.players_per_team * 2) throw new PugError("The queue is full.", 409);
  // A player can only wait in one queue at a time.
  const elsewhere: RowDataPacket[] = await db.query(
    "SELECT q.id FROM pug_queue_player p JOIN pug_queue q ON q.id = p.queue_id " +
      "WHERE p.user_id = ? AND q.status IN ('open', 'ready_check', 'picking', 'loading')",
    [user.id]
  );
  if (elsewhere.length) throw new PugError("You are already in another queue.", 409);
  await db.query("INSERT INTO pug_queue_player (queue_id, user_id, steam_id, name) VALUES (?, ?, ?, ?)", [
    queueId,
    user.id,
    account[0].steam_id,
    String(account[0].name ?? "").slice(0, 75)
  ]);
  if (current.length + 1 === settings.players_per_team * 2) {
    await db.query("UPDATE pug_queue SET status = 'ready_check', ready_deadline = ? WHERE id = ?", [
      sqlDate(new Date(Date.now() + settings.ready_seconds * 1000)),
      queueId
    ]);
  }
  changed();
}

export async function leaveQueue(queueId: number, user: Express.User): Promise<void> {
  const queue = await queueRow(queueId);
  if (!["open", "ready_check"].includes(queue.status)) throw new PugError("Teams are already being formed.", 409);
  await db.query("DELETE FROM pug_queue_player WHERE queue_id = ? AND user_id = ?", [queueId, user.id]);
  if (queue.status === "ready_check") await reopen(queueId);
  changed();
}

async function reopen(queueId: number): Promise<void> {
  await db.query("UPDATE pug_queue SET status = 'open', ready_deadline = NULL WHERE id = ?", [queueId]);
  await db.query("UPDATE pug_queue_player SET ready = 0, team = NULL, captain = 0 WHERE queue_id = ?", [queueId]);
}

export async function readyUp(queueId: number, user: Express.User): Promise<void> {
  await tickQueue(queueId);
  const queue = await queueRow(queueId);
  if (queue.status !== "ready_check") throw new PugError("There is no ready check right now.", 409);
  const update: any = await db.query("UPDATE pug_queue_player SET ready = 1 WHERE queue_id = ? AND user_id = ?", [
    queueId,
    user.id
  ]);
  if (!update.affectedRows) throw new PugError("You are not in this queue.", 403);
  const rows = await players(queueId);
  if (rows.every((row) => truthy(row.ready))) await formTeams(queueId);
  changed();
}

/** Ready check timed out: everyone who didn't confirm is removed and the queue opens again. Open queues past
 * their expiry are cancelled. Called before every queue action and by the periodic sweep. */
export async function tickQueue(queueId: number): Promise<void> {
  const rows: RowDataPacket[] = await db.query("SELECT status, ready_deadline, expires_at FROM pug_queue WHERE id = ?", [
    queueId
  ]);
  const queue = rows[0];
  if (!queue) return;
  const now = Date.now();
  if (queue.status === "ready_check" && queue.ready_deadline && new Date(queue.ready_deadline).getTime() <= now) {
    await db.query("DELETE FROM pug_queue_player WHERE queue_id = ? AND ready = 0", [queueId]);
    await reopen(queueId);
    changed();
  } else if (queue.status === "open" && queue.expires_at && new Date(queue.expires_at).getTime() <= now) {
    await db.query("UPDATE pug_queue SET status = 'cancelled' WHERE id = ?", [queueId]);
    changed();
  }
}

/** Checks every waiting queue; started with the API. */
export function startPugSweep(intervalMs = 5000): NodeJS.Timeout {
  const timer = setInterval(() => {
    db.query("SELECT id FROM pug_queue WHERE status IN ('open', 'ready_check')")
      .then(async (rows) => {
        for (const row of rows) await tickQueue(row.id);
      })
      .catch((err) => logger.error({ err }, "PUG sweep failed"));
  }, intervalMs);
  timer.unref();
  return timer;
}

async function formTeams(queueId: number): Promise<void> {
  const queue = await queueRow(queueId);
  const settings = parseSettings(queue.settings);
  const rows = await players(queueId);
  const ratingMap = await ratings(rows.map((row) => row.steam_id));
  const queued: (QueuedPlayer & { steam_id: string })[] = rows.map((row) => ({
    user_id: row.user_id,
    steam_id: row.steam_id,
    rating: ratingMap.get(row.steam_id) ?? 1
  }));
  if (settings.formation === "captains") {
    const [one, two] = chooseCaptains(queued);
    await db.query("UPDATE pug_queue_player SET team = 1, captain = 1 WHERE queue_id = ? AND user_id = ?", [queueId, one.user_id]);
    await db.query("UPDATE pug_queue_player SET team = 2, captain = 1 WHERE queue_id = ? AND user_id = ?", [queueId, two.user_id]);
    await db.query("UPDATE pug_queue SET status = 'picking', ready_deadline = NULL WHERE id = ?", [queueId]);
    // Two players in total: nothing to pick.
    if (rows.length <= 2) await loadMatch(queueId);
    return;
  }
  const [team1, team2] = settings.formation === "random" ? randomTeams(queued) : balancedTeams(queued);
  for (const [team, members] of [[1, team1], [2, team2]] as const) {
    for (const member of members) {
      await db.query("UPDATE pug_queue_player SET team = ? WHERE queue_id = ? AND user_id = ?", [team, queueId, member.user_id]);
    }
  }
  await loadMatch(queueId);
}

/** A captain picks a player for their team, in ABBA order; the last player goes to the team that needs one. */
export async function pickPlayer(queueId: number, user: Express.User, playerUserId: number): Promise<void> {
  const queue = await queueRow(queueId);
  if (queue.status !== "picking") throw new PugError("Captains aren't picking right now.", 409);
  const rows = await players(queueId);
  const picksMade = rows.filter((row) => row.team != null && !truthy(row.captain)).length;
  const team = nextPickingTeam(picksMade);
  const captain = rows.find((row) => truthy(row.captain) && row.team === team);
  if (!captain || captain.user_id !== user.id) throw new PugError("It's not your pick.", 403);
  const target = rows.find((row) => row.user_id === playerUserId);
  if (!target || target.team != null) throw new PugError("That player can't be picked.", 412);
  await db.query("UPDATE pug_queue_player SET team = ? WHERE queue_id = ? AND user_id = ?", [team, queueId, playerUserId]);
  const remaining = rows.filter((row) => row.team == null && row.user_id !== playerUserId);
  if (remaining.length === 1) {
    const size = rows.length / 2;
    const inTeam1 = rows.filter((row) => row.team === 1).length + (team === 1 ? 1 : 0);
    await db.query("UPDATE pug_queue_player SET team = ? WHERE queue_id = ? AND user_id = ?", [
      inTeam1 < size ? 1 : 2,
      queueId,
      remaining[0].user_id
    ]);
  }
  if (remaining.length <= 1) await loadMatch(queueId);
  changed();
}

/** Creates the two PUG teams and the match (on the queue's server, or the creator's first free one). */
export async function loadMatch(queueId: number): Promise<void> {
  const queue = await queueRow(queueId);
  const settings = parseSettings(queue.settings);
  await db.query("UPDATE pug_queue SET status = 'loading', error = NULL WHERE id = ?", [queueId]);
  changed();
  const rows = await players(queueId);
  const creatorRows: RowDataPacket[] = await db.query(
    "SELECT id, steam_id, name, admin, super_admin, small_image, medium_image, large_image FROM user WHERE id = ?",
    [queue.user_id]
  );
  const creator = creatorRows[0] as Express.User | undefined;
  const teamIds: number[] = [];
  try {
    if (!creator) throw new PugError("The queue's creator no longer exists.");
    for (const side of [1, 2]) {
      const members = rows.filter((row) => row.team === side);
      const lead = members.find((row) => truthy(row.captain)) ?? members[0];
      const insert: any = await db.query(
        "INSERT INTO team (user_id, name, tag, flag, public_team, is_pug) VALUES (?, ?, ?, '', 0, 1)",
        [creator.id, `Team ${lead?.name || side}`.slice(0, 40), "PUG"]
      );
      teamIds.push(insert.insertId);
      for (const member of members) {
        await db.query("INSERT INTO team_auth_names (team_id, auth, name, captain) VALUES (?, ?, ?, ?)", [
          insert.insertId,
          member.steam_id,
          member.name ?? "",
          member === lead ? 1 : 0
        ]);
      }
    }
    let serverId: number | null = queue.server_id;
    if (!serverId) {
      const free: RowDataPacket[] = await db.query(
        "SELECT id FROM game_server WHERE in_use = 0 AND (user_id = ? OR public_server = 1) ORDER BY user_id = ? DESC, id",
        [creator.id, creator.id]
      );
      serverId = free[0]?.id ?? null;
    }
    if (!serverId) throw new PugError("No free server for this queue.");
    const result = await createMatchAs(creator, {
      server_id: serverId,
      team1_id: teamIds[0],
      team2_id: teamIds[1],
      season_id: queue.season_id,
      title: queue.title ?? undefined,
      is_pug: 1,
      start_time: sqlDate(new Date()),
      max_maps: settings.max_maps,
      veto_mappool: settings.map_pool.join(" "),
      skip_veto: settings.skip_veto,
      side_type: settings.side_type,
      players_per_team: settings.players_per_team,
      min_players_to_ready: settings.players_per_team,
      min_spectators_to_ready: 0,
      ignore_server: process.env.NODE_ENV === "test"
    });
    if (result.status !== 200 || !result.json?.id) {
      throw new PugError(String(result.json?.message ?? "The match could not be created."));
    }
    await db.query("UPDATE pug_queue SET status = 'loaded', match_id = ?, server_id = ? WHERE id = ?", [
      result.json.id,
      serverId,
      queueId
    ]);
  } catch (err) {
    // Nothing half-made stays behind; the creator can retry once the problem is fixed.
    for (const teamId of teamIds) {
      await db.query("DELETE FROM team_auth_names WHERE team_id = ?", [teamId]);
      await db.query("DELETE FROM team WHERE id = ?", [teamId]).catch(() => undefined);
    }
    const message = err instanceof Error ? err.message : String(err);
    await db.query("UPDATE pug_queue SET status = 'failed', error = ? WHERE id = ?", [message.slice(0, 500), queueId]);
    if (!(err instanceof PugError)) logger.error({ err }, "PUG match load failed");
  }
  changed();
}

/** Owner or super admin: retry a failed load, or cancel the queue. */
export async function manageQueue(queueId: number, user: Express.User, action: "retry" | "cancel"): Promise<void> {
  const queue = await queueRow(queueId);
  if (queue.user_id !== user.id && !Utils.adminCheck(user)) {
    throw new PugError("User is not authorized to perform action.", 403);
  }
  if (action === "retry") {
    if (queue.status !== "failed") throw new PugError("Only a failed queue can be retried.", 409);
    await loadMatch(queueId);
    return;
  }
  if (["loaded", "cancelled"].includes(queue.status)) throw new PugError("This queue is already closed.", 409);
  await db.query("UPDATE pug_queue SET status = 'cancelled' WHERE id = ?", [queueId]);
  changed();
}
