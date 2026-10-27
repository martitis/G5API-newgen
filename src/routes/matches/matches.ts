/** Express API router for matches in get5.
 * @module routes/matches/matches
 * @requires express
 * @requires db
 */
import { NextFunction, Request, Response, Router } from "express";

const router = Router();

import { db } from "../../services/db.js";

import { generate } from "randomstring";

import Utils from "../../utility/utils.js";
import { audited, firstBody } from "../../utility/audit.js";

import GameServer from "../../utility/serverrcon.js";

import GlobalEmitter, { forMatch } from "../../utility/emitter.js";

import config from "config";
import {
  buildMatchConfig,
  MatchConfigError,
  MatchZyConfig,
  TeamAuthRow,
  TeamRow
} from "../../services/matchconfig.js";
import { MatchData } from "../../types/matches/MatchData.js";
import { RowDataPacket } from "mysql2";
import { AccessMessage } from "../../types/mapstats/AccessMessage.js";
import { loadSummaries, viewerOf, type SummaryFilters } from "../../services/matchsummary.js";

import logger from "../../utility/logger.js";
/**
 * @swagger
 *
 * components:
 *   schemas:
 *     NewMatch:
 *       type: object
 *       required:
 *         - team1_id
 *         - team2_id
 *         - max_maps
 *         - title
 *         - skip_veto
 *       properties:
 *         match_id:
 *           type: integer
 *           description: The integer ID from the database.
 *         server_id:
 *           type: integer
 *           description: The server ID the match is being designated to. NULL if to be provided later.
 *         team1_id:
 *           type: integer
 *           description: The ID of team one.
 *         team2_id:
 *           type: integer
 *           description: The ID of team two.
 *         season_id:
 *           type: integer
 *           description: The ID of the season. NULL if no season.
 *         start_time:
 *           type: string
 *           format: date-time
 *           description: The starting time of the match.
 *         end_time:
 *           type: string
 *           format: date-time
 *           description: The ending time of the match.
 *         winner:
 *           type: integer
 *           description: The ID of winner of the match.
 *         max_maps:
 *           type: integer
 *           description: The number of max maps played per series.
 *         title:
 *           type: string
 *           description: The title of the match, default is 'Map {MAPNUMBER} of {MAXMAPS}'.
 *         skip_veto:
 *           type: boolean
 *           description: Boolean value representing whether to skip the veto or not.
 *         veto_first:
 *           type: string
 *           description: The string value team1 or team2 on who gets to veto first.
 *         veto_mappool:
 *           type: string
 *           description: The map pool given by the system. Space separated.
 *         side_type:
 *           type: string
 *           description: Decision on what to do for side types. standard, always_knife, etc.
 *         plugin_version:
 *           type: string
 *           description: The plugin version reported by get5_status (MatchZy always reports 0.15.0).
 *         spectator_auths:
 *           type: object
 *           properties:
 *              key:
 *                type: string
 *                description: String reprsentation of a steam64 ID.
 *           description: JSON array of spectator auths.
 *         private_match:
 *           type: boolean
 *           description: Boolean value representing whether the match is limited visibility to users on the team or who is on map stats. Defaults to false.
 *         enforce_teams:
 *           type: boolean
 *           description: Boolean value representing whether the server will enforce teams on match start. Defaults to true.
 *         ignore_server:
 *           type: boolean
 *           description: Boolean value representing whether to integrate a game server.
 *         forfeit:
 *           type: boolean
 *           description: Whether the match was forfeited or not.
 *         cancelled:
 *           type: boolean
 *           description: Whether or not the match was cancelled.
 *         team1_score:
 *           type: integer
 *           description: The score from team 1 during the series.
 *         team2_score:
 *           type: integer
 *           description: The score from team 2 during the series.
 *         onsite_veto:
 *           type: boolean
 *           description: Flag indicating whether you wish to veto on-site, or in-game.
 *         is_pug:
 *           type: boolean
 *           description: Flag that indicates whether teams are required or not and to keep track of stats for pug/non-pug games.
 *         match_cvars:
 *           type: object
 *           description: An object of key-value pairs containing different unique match CVARs.
 *         wingman:
 *           type: boolean
 *           description: Flag indicating whether the gamemode is wingman or not.
 *
 *     MatchConfig:
 *        type: object
 *        properties:
 *           matchid:
 *              type: integer
 *              description: Identifier for the match.
 *           match_title:
 *              type: string
 *              description: Title of the match.
 *           side_type:
 *              type: string
 *              description: Idenitifer for how sides are determined.
 *           veto_first:
 *              type: string
 *              description: Whether team1 or team2 gets the first veto.
 *           skip_veto:
 *              type: integer
 *              description: Integer representing a boolean if to skip vetoes or not.
 *           min_players_to_ready:
 *              type: integer
 *              description: The amount of players on a team required to ready up.
 *           players_per_team:
 *              type: integer
 *              description: The amount of players per team.
 *           team1:
 *              $ref: '#/components/schemas/TeamObject'
 *           team2:
 *              $ref: '#/components/schemas/TeamObject'
 *           cvars:
 *            type: object
 *            description: Any additional cvars sent to the server.
 *           spectators:
 *            type: object
 *            description: Key value pair objects containing steamID64 as key, and nicknames as values.
 *           maplist:
 *            type: object
 *            minProperties: 1
 *            maxProperties: 7
 *            description: Key value pair containing an integer representing map order, and value representing map name.
 *           min_spectators_to_ready:
 *            type: integer
 *            description: Value representing spectators to ready up.
 *           maps_to_win:
 *            type: integer
 *            description: The amount of maps required to win a match.
 *           map_sides:
 *            type: string
 *            description: Determines the starting sides for each map. If this array is shorter than num_maps, side_type will determine the side-behavior of the remaining maps. Ignored if skip_veto is false.
 *
 *     MatchPauseObject:
 *      type: object
 *      properties:
 *        id:
 *          type: integer
 *          description: The internal database primary key for match pausing.
 *        match_id:
 *          type: integer
 *          description: Foreign key to match table.
 *        pause_type:
 *          type: string
 *          description: The type of pause last called.
 *        team_paused:
 *          type: string
 *          description: The team which last called a pause.
 *        paused:
 *          type: boolean
 *          description: Whether the match is currently paused or not with the given previous values.
 *     TeamObject:
 *      type: object
 *      properties:
 *        name:
 *          type: string
 *          description: Name of the team.
 *        tag:
 *          type: string
 *          description: Shorthand tag for the team.
 *        players:
 *          type: object
 *          properties:
 *            steamid:
 *              type: string
 *              description: The key is the Steam64 ID.
 *            nickname:
 *              type: string
 *              description: The value is a preferred nickname if present.
 *     MatchData:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: The integer ID from the database.
 *         user_id:
 *           type: integer
 *           description: The ID of the user that created the match.
 *         server_id:
 *           type: integer
 *           description: The ID of the selected server to play on the match.
 *         team1_id:
 *           type: integer
 *           description: The ID of team one.
 *         team2_id:
 *           type: integer
 *           description: The ID of team two.
 *         winner:
 *           type: integer
 *           description: The foreign key of a team that won the match.
 *         team1_score:
 *           type: integer
 *           description: The score of team 1.
 *         team2_score:
 *           type: integer
 *           description: The score of team 2.
 *         team1_string:
 *           type: string
 *           description: The current name of team 1 in the match.
 *         team2_string:
 *           type: string
 *           description: The current name of team 2 in the match.
 *         cancelled:
 *           type: boolean
 *           description: Whether a match was cancelled or not.
 *         forfeit:
 *           type: boolean
 *           description: Whether the match was forfeit or not.
 *         start_time:
 *           type: string
 *           format: date-time
 *           description: The starting time of the match.
 *         end_time:
 *           type: string
 *           format: date-time
 *           description: The ending time of the match.
 *         max_maps:
 *           type: integer
 *           description: The number of max maps played per series.
 *         title:
 *           type: string
 *           description: The title of the match, default is 'Map {MAPNUMBER} of {MAXMAPS}'.
 *         skip_veto:
 *           type: boolean
 *           description: Boolean value representing whether to skip the veto or not.
 *         private_match:
 *           type: boolean
 *           description: Boolean value representing whether the match is limited visibility to users on the team or who is on map stats. Defaults to false.
 *         enforce_teams:
 *           type: boolean
 *           description: Boolean value representing whether the server will enforce teams on match start. Defaults to true.
 *         min_player_ready:
 *           type: integer
 *           description: The minimum players required to ready up per team.
 *         season_id:
 *           type: integer
 *           description: The ID of the season. NULL if no season.
 *     BombInfo:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: The integer ID from the database.
 *         match_id:
 *           type: integer
 *           description: The match ID that the bomb was defused or planted.
 *         map_id:
 *           type: integer
 *           description: The current Map ID that the bomb was planted/defused.
 *         player_name:
 *           type: string
 *           description: The name of the player that planted/defused the bomb.
 *         round_number:
 *           type: integer
 *           description: The round number where the bomb was planted/defused.
 *         round_time:
 *           type: integer
 *           description: The time in ms during the round that the bomb was planted/defused.
 *         site:
 *           type: string
 *           description: The site the bomb was planted/defused.
 *         defused:
 *           type: boolean
 *           description: Whether the bomb was planted or defused.
 *
 *   responses:
 *     MatchFinished:
 *        description: Match already finished.
 *        content:
 *        application/json:
 *          schema:
 *            $ref: '#/components/schemas/SimpleResponse'
 *     NoMatchData:
 *       description: No match data provided.
 *       content:
 *        application/json:
 *          schema:
 *            $ref: '#/components/schemas/SimpleResponse'
 *     MatchInvalidData:
 *       description: The match data provided is invalid.
 *       content:
 *        application/json:
 *          schema:
 *            $ref: '#/components/schemas/SimpleResponse'
 */

/**
 * @swagger
 *
 * /matches/:
 *   get:
 *     description: Get all match data from the application.
 *     produces:
 *       - application/json
 *     parameters:
 *       - in: query
 *         name: asc
 *         description: Whether to have values in descending order. Defaults to true.
 *         required: false
 *         schema:
 *          type: boolean
 *          default: true
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: All matches within the system.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MatchData'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/", async (req, res, next) => {
  try {
    let isAscending: boolean =
      req.query?.asc === "true";
    let sql: string =
      "SELECT mtch.id, mtch.user_id, mtch.server_id, mtch.team1_id, mtch.team2_id, mtch.winner, mtch.team1_score, " +
      "mtch.team2_score, mtch.team1_series_score, mtch.team2_series_score, mtch.team1_string, mtch.team2_string, " +
      "mtch.cancelled, mtch.forfeit, mtch.start_time, mtch.end_time, mtch.max_maps, mtch.title, mtch.skip_veto, mtch.private_match, " +
      "mtch.enforce_teams, mtch.min_player_ready, mtch.season_id, mtch.is_pug, usr.name as owner, " +
      // Score of the current (latest) map. Subqueries instead of JOIN + GROUP BY, which MySQL 8 rejects (ONLY_FULL_GROUP_BY).
      "(SELECT mp.team1_score FROM map_stats mp WHERE mp.match_id = mtch.id ORDER BY mp.map_number DESC LIMIT 1) as team1_mapscore, " +
      "(SELECT mp.team2_score FROM map_stats mp WHERE mp.match_id = mtch.id ORDER BY mp.map_number DESC LIMIT 1) as team2_mapscore " +
      "FROM `match` mtch JOIN user usr ON mtch.user_id = usr.id " +
      "WHERE cancelled = 0 " +
      "OR cancelled IS NULL " +
      "ORDER BY id DESC";
    const matches: RowDataPacket[] = await db.query(sql);
    if (!matches.length) {
      res.status(404).json({ message: "No matches found." });
      return;
    }
    if (isAscending) {
      res.json({ matches: matches.reverse() });
    } else {
      res.json({ matches });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /matches/mymatches:
 *   get:
 *     description: Set of matches from the logged in user.
 *     produces:
 *       - application/json
 *     parameters:
 *       - in: query
 *         name: asc
 *         description: Whether to have values in descending order. Defaults to true.
 *         required: false
 *         schema:
 *          type: boolean
 *          default: true
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Matches of logged in user.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MatchData'
 *       404:
 *         $ref: '#/components/responses/MatchesNotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/mymatches", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    let isAscending: boolean =
      req.query?.asc === "true";

    let sql: string = `
      SELECT mtch.id, mtch.user_id, mtch.server_id, mtch.team1_id, mtch.team2_id, mtch.winner, 
             mtch.team1_score, mtch.team2_score, mtch.team1_series_score, mtch.team2_series_score, 
             mtch.team1_string, mtch.team2_string, mtch.cancelled, mtch.forfeit, mtch.start_time, 
             mtch.end_time, mtch.max_maps, mtch.title, mtch.skip_veto, mtch.private_match, 
             mtch.enforce_teams, mtch.min_player_ready, mtch.season_id, mtch.is_pug, 
             usr.name AS owner,
             (SELECT mp.team1_score FROM map_stats mp WHERE mp.match_id = mtch.id ORDER BY mp.map_number DESC LIMIT 1) AS team1_mapscore,
             (SELECT mp.team2_score FROM map_stats mp WHERE mp.match_id = mtch.id ORDER BY mp.map_number DESC LIMIT 1) AS team2_mapscore,
             gs.display_name AS server_name, gs.ip_string, gs.port
      FROM \`match\` mtch
      JOIN user usr ON mtch.user_id = usr.id
      LEFT JOIN game_server gs ON mtch.server_id = gs.id
      WHERE mtch.user_id = ?
      ORDER BY id DESC;
    `;

    const matches: RowDataPacket[] = await db.query(sql, [req.user!.id]);
    if (!matches.length) {
      res.status(404).json({ message: "No matches found." });
      return;
    }

    if (isAscending) {
      res.json({ matches: matches.reverse() });
    } else {
      res.json({ matches });
    }
  } catch (err) {
    next(err);
  }
});

/** Parses the shared query parameters of the summary routes. */
const summaryFilters = (query: Record<string, unknown>): SummaryFilters => {
  const int = (value: unknown) => {
    const parsed = typeof value === "string" ? parseInt(value, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  return {
    status: typeof query.status === "string" ? query.status : undefined,
    season_id: int(query.season_id),
    team_id: int(query.team_id),
    server_id: int(query.server_id),
    mine: query.mine === "true" || query.mine === "1",
    q: typeof query.q === "string" && query.q.trim() ? query.q.trim().slice(0, 64) : undefined,
    limit: int(query.limit),
    offset: int(query.offset) ?? 0
  };
};

/**
 * @swagger
 *
 * /matches/summary:
 *   get:
 *     description: >
 *       One page of the match list, live and upcoming matches first. Each entry has the teams (tag, logo, flag),
 *       series and map scores, the live map's round score and sides, pause state and a status
 *       (pending, warmup, live, paused, finished, cancelled). Private matches are only listed for their owner,
 *       admins and team members; the server address only for those who may connect.
 *     produces:
 *       - application/json
 *     parameters:
 *       - { name: status, in: query, schema: { type: string, enum: [active, finished, cancelled, all] } }
 *       - { name: season_id, in: query, schema: { type: integer } }
 *       - { name: team_id, in: query, schema: { type: integer } }
 *       - { name: server_id, in: query, schema: { type: integer } }
 *       - { name: mine, in: query, schema: { type: boolean } }
 *       - { name: q, in: query, description: Team name or title contains, schema: { type: string } }
 *       - { name: limit, in: query, schema: { type: integer, default: 25, maximum: 100 } }
 *       - { name: offset, in: query, schema: { type: integer, default: 0 } }
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: The page and the total number of matching matches.
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/summary", async (req, res, next) => {
  try {
    res.json(await loadSummaries(summaryFilters(req.query), viewerOf(req.user)));
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /matches/summary/stream:
 *   get:
 *     description: >
 *       Server sent events for the match list. Each "summaries" event holds the current summaries of the
 *       requested ids plus every active match, sent on connect and whenever match or map data changes.
 *     produces:
 *       - text/event-stream
 *     parameters:
 *       - { name: ids, in: query, description: Comma separated match ids on screen (up to 100), schema: { type: string } }
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: The stream.
 */
router.get("/summary/stream", async (req, res, next) => {
  try {
    const viewer = viewerOf(req.user);
    const ids: number[] = (typeof req.query.ids === "string" ? req.query.ids : "")
      .split(",")
      .map((id) => parseInt(id, 10))
      .filter((id) => Number.isFinite(id) && id > 0)
      .slice(0, 100);
    res.set({
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();

    let closed = false;
    const send = async () => {
      const [known, active] = await Promise.all([
        loadSummaries({ ids, status: "all", limit: 100 }, viewer),
        loadSummaries({ status: "active", limit: 100 }, viewer)
      ]);
      const byId = new Map<number, unknown>();
      for (const summary of [...known.matches, ...active.matches]) byId.set(summary.id, summary);
      if (!closed) res.write(`event: summaries
data: ${JSON.stringify([...byId.values()])}

`);
    };
    // round_end alone fires several updates; send at most one refresh per half second.
    let timer: NodeJS.Timeout | null = null;
    const onChange = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        send().catch((err) => logger.error({ err }, "Match list stream query failed"));
      }, 500);
    };
    const events = ["matchUpdate", "mapStatUpdate"];
    for (const event of events) GlobalEmitter.on(event, onChange);
    req.on("close", () => {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const event of events) GlobalEmitter.removeListener(event, onChange);
      res.end();
    });
    await send();
  } catch (err) {
    if (res.headersSent) {
      logger.error({ err }, "Match list stream failed");
      res.end();
    } else {
      next(err);
    }
  }
});

/**
 * @swagger
 *
 * /matches/:match_id:
 *   get:
 *     description: Returns a provided matches info.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match info
 *         content:
 *           application/json:
 *             schema:
 *                type: object
 *                properties:
 *                  match:
 *                    $ref: '#/components/schemas/MatchData'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:match_id", async (req, res, next) => {
  try {
    let matchUserId: string = "SELECT user_id FROM `match` WHERE id = ?";
    let sql: string;
    const matchRow: RowDataPacket[] = await db.query(matchUserId, [
      req.params.match_id
    ]);
    if (!matchRow.length) {
      res.status(404).json({ message: "No match found." });
      return;
    } else if (
      req.user !== undefined &&
      (matchRow[0].user_id == req.user!.id || Utils.adminCheck(req.user))
    ) {
      sql = "SELECT * FROM `match` where id=?";
    } else {
      sql =
        "SELECT id, user_id, server_id, team1_id, team2_id, winner, " +
        "team1_score, team2_score, team1_series_score, team2_series_score, " +
        "team1_string, team2_string, cancelled, forfeit, start_time, end_time, " +
        "max_maps, title, skip_veto, private_match, enforce_teams, min_player_ready, " +
        "season_id, is_pug, map_sides FROM `match` where id = ?";
    }
    let matchID: string = req.params.match_id;
    const matches: RowDataPacket[] = await db.query(sql, [matchID]);
    if (!matches.length) {
      res.status(404).json({ message: "No match found." });
      return;
    }
    const match: any = JSON.parse(JSON.stringify(matches[0]));
    res.json({ match });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /matches/:match_id/stream:
 *   get:
 *     description: Returns an event stream of a specified matches info.
 *     produces:
 *       - text/event-stream
 *     parameters:
 *       - name: match_id
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match info
 *         content:
 *           application/json:
 *             schema:
 *                type: object
 *                properties:
 *                  match:
 *                    $ref: '#/components/schemas/MatchData'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:match_id/stream", async (req, res, next) => {
  try {
    let matchUserId: string = "SELECT user_id FROM `match` WHERE id = ?";
    let sql: string;
    const matchRow: RowDataPacket[] = await db.query(matchUserId, [
      req.params.match_id
    ]);
    if (!matchRow.length) {
      res.status(404).json({ message: "No match found." });
      return;
    } else if (
      req.user !== undefined &&
      (matchRow[0].user_id == req.user!.id || Utils.adminCheck(req.user))
    ) {
      sql = "SELECT * FROM `match` where id=?";
    } else {
      sql =
        "SELECT id, user_id, server_id, team1_id, team2_id, winner, " +
        "team1_score, team2_score, team1_series_score, team2_series_score, " +
        "team1_string, team2_string, cancelled, forfeit, start_time, end_time, " +
        "max_maps, title, skip_veto, private_match, enforce_teams, min_player_ready, " +
        "season_id, is_pug, map_sides FROM `match` where id = ?";
    }

    let matchID: string = req.params.match_id;
    let matches: RowDataPacket[] = await db.query(sql, [matchID]);

    res.set({
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();
    matches = matches.map((v) => Object.assign({}, v));
    let matchString: string = `event: matches\ndata:${JSON.stringify(matches[0])}\n\n`;
    // Need to name the function in order to remove it!
    const matchStreamStatus: () => Promise<void> = async () => {
      matches = await db.query(sql, [matchID]);
      matches = matches.map((v) => Object.assign({}, v));
      matchString = `event: matches\ndata: ${JSON.stringify(matches[0])}\n\n`;
      res.write(matchString);
    };

    const matchStreamStatusForMatch = forMatch(matchID, matchStreamStatus);
    GlobalEmitter.on("matchUpdate", matchStreamStatusForMatch);
    res.write(matchString);

    req.on("close", () => {
      GlobalEmitter.removeListener("matchUpdate", matchStreamStatusForMatch);
      res.end();
    });
    req.on("disconnect", () => {
      GlobalEmitter.removeListener("matchUpdate", matchStreamStatusForMatch);
      res.end();
    });
  } catch (err) {
    logger.error(err);
    res
      .status(500)
      .write(`event: error\ndata: Internal server error.\n\n`);
    res.end();
  }
});

/** One dataset of the match page: the SSE event name, its query (match id is the only parameter) and the
 * emitter events after which it is sent again. */
interface LiveDataset {
  event: string;
  sql: string;
  single?: boolean;
  on: string[];
}

/** Round history, kill feed, bomb events and pause state of a match (live stream and /timeline). */
const TIMELINE_DATASETS: LiveDataset[] = [
  {
    event: "rounds",
    sql:
      "SELECT map_id, round_number, event_round, winner, winner_side, reason, team1_score, team2_score, round_time " +
      "FROM match_round WHERE match_id = ? ORDER BY map_id, round_number",
    on: ["mapStatUpdate"]
  },
  {
    event: "kills",
    // Newest first; the page shows a feed, not the whole history of a long series.
    sql:
      "SELECT id, map_id, round_number, round_time, player_steam_id, player_name, player_side, " +
      "attacker_steam_id, attacker_name, attacker_side, weapon, headshot, thru_smoke, attacker_blind, no_scope, " +
      "suicide, friendly_fire, assister_name, flash_assist, bomb " +
      "FROM player_stat_extras WHERE match_id = ? ORDER BY id DESC LIMIT 500",
    on: ["playerStatsExtraUpdate"]
  },
  {
    event: "bombs",
    sql:
      "SELECT b.id, b.map_id, b.round_number, b.round_time, b.site, b.defused, b.bomb_time_remaining, " +
      "ps.name AS player_name FROM match_bomb_plants b LEFT JOIN player_stats ps ON ps.id = b.player_stats_id " +
      "WHERE b.match_id = ? ORDER BY b.id",
    on: ["bombEvent"]
  },
  {
    event: "pause",
    sql: "SELECT paused, pause_type, team_paused FROM match_pause WHERE match_id = ?",
    single: true,
    on: ["matchUpdate"]
  }
];

const queryDataset = async (dataset: LiveDataset, matchID: number): Promise<unknown> => {
  const rows: RowDataPacket[] = await db.query(dataset.sql, [matchID]);
  return dataset.single ? (rows[0] ?? null) : rows;
};

/**
 * @swagger
 *
 * /matches/:match_id/timeline:
 *   get:
 *     description: Round history, kill feed (newest 500), bomb events and pause state of a match.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: "{ rounds, kills, bombs, pause }"
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get("/:match_id/timeline", async (req, res, next) => {
  try {
    const matchID: number = parseInt(req.params.match_id);
    const matchRow: RowDataPacket[] = await db.query("SELECT id FROM `match` WHERE id = ?", [matchID]);
    if (!matchRow.length) {
      res.status(404).json({ message: "No match found." });
      return;
    }
    const result: Record<string, unknown> = {};
    for (const dataset of TIMELINE_DATASETS) result[dataset.event] = await queryDataset(dataset, matchID);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /matches/:match_id/live/stream:
 *   get:
 *     description: >
 *       Everything the match page shows, as one server sent event stream (browsers allow only six
 *       HTTP/1.1 connections per host, so one stream per dataset could stall the page).
 *       Events - matches and pause (objects), mapstats, playerstats, vetodata, vetosidedata, rounds, kills and
 *       bombs (arrays). Each event is sent once on connect and again whenever that data changes.
 *     produces:
 *       - text/event-stream
 *     parameters:
 *       - name: match_id
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: The live match data stream.
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get("/:match_id/live/stream", async (req, res, next) => {
  try {
    const matchID: number = parseInt(req.params.match_id);
    const matchRow: RowDataPacket[] = await db.query("SELECT user_id FROM `match` WHERE id = ?", [matchID]);
    if (!matchRow.length) {
      res.status(404).json({ message: "No match found." });
      return;
    }
    const fullAccess: boolean =
      req.user !== undefined && (matchRow[0].user_id == req.user.id || Utils.adminCheck(req.user));
    const matchSql: string = fullAccess
      ? "SELECT * FROM `match` WHERE id = ?"
      : "SELECT id, user_id, server_id, team1_id, team2_id, winner, " +
        "team1_score, team2_score, team1_series_score, team2_series_score, " +
        "team1_string, team2_string, cancelled, forfeit, start_time, end_time, " +
        "max_maps, title, skip_veto, private_match, enforce_teams, min_player_ready, " +
        "season_id, is_pug, map_sides FROM `match` WHERE id = ?";
    const datasets: LiveDataset[] = [
      { event: "matches", sql: matchSql, single: true, on: ["matchUpdate"] },
      { event: "mapstats", sql: "SELECT * FROM map_stats WHERE match_id = ? ORDER BY map_number", on: ["mapStatUpdate"] },
      { event: "playerstats", sql: "SELECT * FROM player_stats WHERE match_id = ?", on: ["playerStatsUpdate"] },
      { event: "vetodata", sql: "SELECT * FROM veto WHERE match_id = ? ORDER BY id", on: ["vetoUpdate"] },
      { event: "vetosidedata", sql: "SELECT * FROM veto_side WHERE match_id = ? ORDER BY id", on: ["vetoSideUpdate"] },
      ...TIMELINE_DATASETS
    ];

    res.set({
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();

    let closed = false;
    const send = async (dataset: LiveDataset): Promise<void> => {
      const data = await queryDataset(dataset, matchID);
      if (!closed) res.write(`event: ${dataset.event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Game events arrive in bursts (one round_end updates every player), so coalesce them per dataset.
    const timers = new Map<LiveDataset, NodeJS.Timeout>();
    const listeners: Array<[string, () => void]> = [];
    for (const dataset of datasets) {
      const listener = forMatch(matchID, () => {
        if (timers.has(dataset)) return;
        timers.set(
          dataset,
          setTimeout(() => {
            timers.delete(dataset);
            send(dataset).catch((err) => logger.error({ err }, "Live stream query failed"));
          }, 250)
        );
      });
      for (const emitterEvent of dataset.on) {
        GlobalEmitter.on(emitterEvent, listener);
        listeners.push([emitterEvent, listener]);
      }
    }
    const cleanup = () => {
      if (closed) return;
      closed = true;
      for (const [emitterEvent, listener] of listeners) GlobalEmitter.removeListener(emitterEvent, listener);
      for (const timer of timers.values()) clearTimeout(timer);
      res.end();
    };
    req.on("close", cleanup);
    for (const dataset of datasets) await send(dataset);
  } catch (err) {
    if (res.headersSent) {
      logger.error({ err }, "Live stream failed");
      res.end();
    } else {
      next(err);
    }
  }
});

/**
 * @swagger
 *
 * /matches/:match_id/paused/stream:
 *   get:
 *     description: Get the pause information on a match streamed as a server sent event.
 *     produces:
 *       - text/event-stream
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Returns information based on a match if it is paused.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MatchPauseObject'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:match_id/paused/stream", async (req, res, next) => {
  try {
    let matchId: string = req.params.match_id;
    let sql: string =
      "SELECT id, match_id, pause_type, team_paused, paused " +
      "FROM `match_pause` " +
      "WHERE match_id = ? ";
    let matchPauseInfo: RowDataPacket[] = await db.query(sql, [matchId]);

    res.set({
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();

    matchPauseInfo = matchPauseInfo.map((v) => Object.assign({}, v));
    let matchPauseString: string = `event: matches\ndata: ${JSON.stringify(
      matchPauseInfo
    )}\n\n`;
    // Need to name the function in order to remove it!
    const matchPauseStreamStatus: () => Promise<void> = async () => {
      matchPauseInfo = await db.query(sql, [matchId]);
      matchPauseInfo = matchPauseInfo.map((v) => Object.assign({}, v));
      matchPauseString = `event: matches\ndata: ${JSON.stringify(
        matchPauseInfo
      )}\n\n`;
      res.write(matchPauseString);
    };

    const matchPauseStreamStatusForMatch = forMatch(matchId, matchPauseStreamStatus);
    GlobalEmitter.on("matchUpdate", matchPauseStreamStatusForMatch);
    res.write(matchPauseString);

    req.on("close", () => {
      GlobalEmitter.removeListener("matchUpdate", matchPauseStreamStatusForMatch);
      res.end();
    });
    req.on("disconnect", () => {
      GlobalEmitter.removeListener("matchUpdate", matchPauseStreamStatusForMatch);
      res.end();
    });
  } catch (err) {
    logger.error(err);
    res
      .status(500)
      .write(`event: error\ndata: Internal server error.\n\n`);
    res.end();
  }
});

/**
 * @swagger
 *
 * /matches/:match_id/paused:
 *   get:
 *     description: Get the pause information on a match.
 *     produces:
 *       - application/json
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Returns information based on a match if it is paused.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MatchPauseObject'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:match_id/paused", async (req, res, next) => {
  try {
    let sql: string =
      "SELECT id, match_id, pause_type, team_paused, paused " +
      "FROM `match_pause` " +
      "WHERE match_id = ? ";
    const matchPauseInfo: RowDataPacket[] = await db.query(sql, [
      req.params.match_id
    ]);
    if (!matchPauseInfo.length) {
      res.status(404).json({ message: "No match pause info found." });
      return;
    }
    res.json({ matchPauseInfo });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /matches/:match_id/bombs/stream:
 *   get:
 *     description: Returns an bomb plant/defused event stream of a specified match.
 *     produces:
 *       - text/event-stream
 *     parameters:
 *       - name: match_id
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Bomb Info from the match.
 *         content:
 *           application/json:
 *             schema:
 *                type: object
 *                properties:
 *                  match:
 *                    $ref: '#/components/schemas/BombInfo'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:match_id/bombs/stream", async (req, res, next) => {
  try {
    let matchUserId: string = "SELECT user_id FROM `match` WHERE id = ?";
    let sql: string;
    const matchRow: RowDataPacket[] = await db.query(matchUserId, [
      req.params.match_id
    ]);
    if (!matchRow.length) {
      res.status(404).json({ message: "No match found." });
      return;
    } else {
      sql =
        "SELECT mb.id, mb.match_id, mb.map_id, ps.name, mb.round_number, mb.round_time, mb.site, mb.defused, mb.bomb_time_remaining " +
        "FROM match_bomb_plants mb JOIN player_stats ps ON mb.player_stats_id = ps.id WHERE mb.match_id = ?";
    }

    let matchID: string = req.params.match_id;
    let bombInfo: RowDataPacket[] = await db.query(sql, [matchID]);

    res.set({
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();
    bombInfo = bombInfo.map((v) => Object.assign({}, v));
    let bombInfoString: string = `event: bomb_info\ndata: ${JSON.stringify(bombInfo)}\n\n`;
    // Need to name the function in order to remove it!
    const matchStreamStatus: () => Promise<void> = async () => {
      bombInfo = await db.query(sql, [matchID]);
      bombInfo = bombInfo.map((v) => Object.assign({}, v));
      bombInfoString = `event: bomb_info\ndata: ${JSON.stringify(bombInfo)}\n\n`;
      res.write(bombInfoString);
    };

    const matchStreamStatusForMatch = forMatch(matchID, matchStreamStatus);
    GlobalEmitter.on("bombEvent", matchStreamStatusForMatch);
    res.write(bombInfoString);

    req.on("close", () => {
      GlobalEmitter.removeListener("bombEvent", matchStreamStatusForMatch);
      res.end();
    });
    req.on("disconnect", () => {
      GlobalEmitter.removeListener("bombEvent", matchStreamStatusForMatch);
      res.end();
    });
  } catch (err) {
    logger.error(err);
    res
      .status(500)
      .write(`event: error\ndata: Internal server error.\n\n`);
    res.end();
  }
});

/**
 * @swagger
 *
 * /matches/:match_id/bombs:
 *   get:
 *     description: Returns an bomb plant/defused data of a specified match.
 *     produces:
 *       - text/event-stream
 *     parameters:
 *       - name: match_id
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Bomb Info from the match.
 *         content:
 *           application/json:
 *             schema:
 *                type: object
 *                properties:
 *                  match:
 *                    $ref: '#/components/schemas/BombInfo'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:match_id/bombs", async (req, res, next) => {
  try {
    let matchUserId: string = "SELECT user_id FROM `match` WHERE id = ?";
    let sql: string;
    const matchRow: RowDataPacket[] = await db.query(matchUserId, [
      req.params.match_id
    ]);
    if (!matchRow.length) {
      res.status(404).json({ message: "No match found." });
      return;
    } else {
      sql =
        "SELECT mb.id, mb.match_id, mb.map_id, ps.name, mb.round_number, mb.round_time, mb.site, mb.defused, mb.bomb_time_remaining " +
        "FROM match_bomb_plants mb JOIN player_stats ps ON mb.player_stats_id = ps.id WHERE mb.match_id = ?";
    }

    let matchID: string = req.params.match_id;
    let bombInfo: RowDataPacket[] = await db.query(sql, [matchID]);
    res.json({ bombInfo });
  } catch (err) {
    logger.error(err);
    res
      .status(500)
      .write(`event: error\ndata: Internal server error.\n\n`);
    res.end();
  }
});

/**
 * @swagger
 *
 * /matches/limit/:limiter:
 *   get:
 *     description: Returns most recent matches specified by a limit.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: limiter
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match info
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MatchData'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/limit/:limiter", async (req, res, next) => {
  try {
    let lim: number = parseInt(req.params.limiter);
    if (isNaN(lim) || lim < 0) {
      res.status(400).json({ message: "Limit must be a non-negative number." });
      return;
    }
    let sql: string;
    if (req.user !== undefined && Utils.adminCheck(req.user)) {
      sql =
        "SELECT * FROM `match` WHERE cancelled = 0 OR cancelled IS NULL ORDER BY end_time DESC LIMIT ?";
    } else {
      sql =
        "SELECT id, user_id, server_id, team1_id, team2_id, winner, " +
        "team1_score, team2_score, team1_series_score, team2_series_score, " +
        "team1_string, team2_string, cancelled, forfeit, start_time, end_time, " +
        "max_maps, title, skip_veto, private_match, enforce_teams, min_player_ready, " +
        "season_id, is_pug, map_sides FROM `match` WHERE cancelled = 0 " +
        "OR cancelled IS NULL ORDER BY end_time DESC LIMIT ?";
    }
    const matches: RowDataPacket[] = await db.query(sql, [lim]);
    res.json({ matches });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /matches/limit/:firstvalue&:lastvalue:
 *   get:
 *     description: Returns a subset of matches between a range.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: firstvalue
 *         required: true
 *         schema:
 *          type: integer
 *       - name: lastvalue
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match info
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MatchData'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/page/:firstvalue&:lastvalue", async (req, res, next) => {
  try {
    //@ts-ignore
    let firstVal: number = parseInt(req.params.firstvalue);
    //@ts-ignore
    let secondVal: number = parseInt(req.params.lastvalue);
    if (isNaN(firstVal) || isNaN(secondVal) || firstVal < 0 || secondVal < 0) {
      res.status(400).json({ message: "Page values must be non-negative numbers." });
      return;
    }
    let sql: string;
    if (req.user !== undefined && Utils.adminCheck(req.user)) {
      sql =
        "SELECT * FROM `match` WHERE cancelled = 0 OR cancelled IS NULL ORDER BY id DESC LIMIT ?,?";
    } else {
      sql =
        "SELECT id, user_id, server_id, team1_id, team2_id, winner, " +
        "team1_score, team2_score, team1_series_score, team2_series_score, " +
        "team1_string, team2_string, cancelled, forfeit, start_time, end_time, " +
        "max_maps, title, skip_veto, private_match, enforce_teams, min_player_ready, " +
        "season_id, is_pug, map_sides FROM `match` WHERE cancelled = 0 " +
        "OR cancelled IS NULL ORDER BY id DESC LIMIT ?,?";
    }
    const matches: RowDataPacket[] = await db.query(sql, [firstVal, secondVal]);
    res.json({ matches });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /matches/:match_id:/config:
 *   get:
 *     description: Route serving to get match configs from the database for the plugin.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         required: true
 *         schema:
 *            type: integer
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match config
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MatchConfig'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:match_id/config", async (req, res, next) => {
  try {
    let matchID: string = req.params.match_id;
    const matchInfo: RowDataPacket[] = await db.query(
      "SELECT * FROM `match` WHERE id = ?",
      [matchID]
    );
    if (!matchInfo.length) {
      res.status(404).json({ message: "No match found." });
      return;
    }
    const match = matchInfo[0];
    // MatchZy fetches this with the match key. The owner or a super admin may also view it, e.g. to preview.
    const apiKey: string | undefined = req.get("Authorization");
    const hasKey: boolean = Utils.safeCompare(apiKey, match.api_key);
    const isOwner: boolean =
      req.user != null &&
      (req.user.id == match.user_id || Utils.adminCheck(req.user));
    if (!hasKey && !isOwner) {
      res.status(401).json({ message: "Unauthorized to access match config." });
      return;
    }
    const teamSql: string =
      "SELECT id, name, tag, flag, logo FROM team WHERE id = ?";
    const authSql: string =
      "SELECT auth, name, coach FROM team_auth_names WHERE team_id = ? ORDER BY captain DESC";
    const [
      team1Data,
      team2Data,
      team1Auths,
      team2Auths,
      matchCvars,
      matchSpecs,
      matchServer
    ] = await Promise.all([
      db.query(teamSql, [match.team1_id]),
      db.query(teamSql, [match.team2_id]),
      db.query(authSql, [match.team1_id]),
      db.query(authSql, [match.team2_id]),
      db.query(
        "SELECT cvar_name, cvar_value FROM match_cvar WHERE match_id = ?",
        [matchID]
      ),
      db.query(
        "SELECT auth, spectator_name FROM match_spectator WHERE match_id = ?",
        [matchID]
      ),
      db.query("SELECT join_password FROM game_server WHERE id = ?", [match.server_id])
    ]);
    const matchConfig: MatchZyConfig = buildMatchConfig(
      {
        match,
        team1: {
          team: team1Data[0] as TeamRow | undefined,
          auths: team1Auths as TeamAuthRow[]
        },
        team2: {
          team: team2Data[0] as TeamRow | undefined,
          auths: team2Auths as TeamAuthRow[]
        },
        cvars: matchCvars as Array<{ cvar_name: string; cvar_value: any }>,
        spectators: matchSpecs as Array<{
          auth: string;
          spectator_name: string | null;
        }>,
        uploadDemos: Boolean(config.get("server.uploadDemos")),
        serverPassword: (matchServer[0]?.join_password as string | null | undefined) || null
      },
      match.api_key
    );
    res.json(matchConfig);
  } catch (err) {
    if (err instanceof MatchConfigError) {
      res.status(422).json({ message: err.message });
      return;
    }
    next(err);
  }
});

/**
 * @swagger
 *
 * /matches:
 *   post:
 *     description: Create a new match.
 *     produces:
 *       - application/json
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: array
 *            items:
 *              $ref: '#/components/schemas/NewMatch'
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Create successful
 *         content:
 *           application/json:
 *             schema:
 *                $ref: '#/components/schemas/SimpleResponse'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.post("/", Utils.ensureAuthenticated, audited("match.create", { target: (req, body) => ({ type: "match", id: body?.id ?? null }), detail: (req) => `teams ${firstBody(req).team1_id ?? "?"} vs ${firstBody(req).team2_id ?? "?"}, server ${firstBody(req).server_id ?? "?"}` }), createMatchHandler);

/**
 * @swagger
 *
 * /matches:
 *   put:
 *     description: Update player stats in a match/map.
 *     produces:
 *       - application/json
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: array
 *            items:
 *              $ref: '#/components/schemas/NewMatch'
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Update successful.
 *         content:
 *           application/json:
 *             type: object
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       412:
 *         $ref: '#/components/responses/NoMatchData'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.put("/", Utils.ensureAuthenticated, audited("match.update", { target: (req) => ({ type: "match", id: Number(firstBody(req).match_id) || null }), detail: (req) => Object.keys(firstBody(req)).filter((k) => k !== "match_id").join(", ") }), async (req, res, next) => {
  try {
    let diffServer: boolean = false;
    let vetoList: any = null;
    let ourServerSql: string =
      "SELECT ip_string, port, rcon_password FROM game_server WHERE id=?";
    let message: string = "Match updated successfully!";
    let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
      req.body[0].match_id,
      req.user!
    );
    if (errMessage != null) {
      res.status(errMessage.status).json({ message: errMessage.message });
      return;
    }
    const cvarError: string | null = Utils.validateCvars(
      req.body[0]?.match_cvars
    );
    if (cvarError) {
      res.status(412).json({ message: cvarError });
      return;
    } else {
      let currentMatchInfo: string =
        "SELECT id, user_id, server_id, team1_id, team2_id, cancelled, forfeit, end_time, api_key, veto_mappool, max_maps, skip_veto, is_pug FROM `match` WHERE id = ?";
      const matchRow: RowDataPacket[] = await db.query(
        currentMatchInfo,
        req.body[0].match_id
      );
      if (req.body[0].server_id != null) {
        // Check if server is owned, public, or in use by another match.
        let serverCheckSql: string =
          "SELECT in_use, user_id, public_server FROM game_server WHERE id=?";
        const returnedServer: RowDataPacket[] = await db.query(serverCheckSql, [
          req.body[0].server_id
        ]);
        if (!returnedServer.length) {
          res.status(404).json({ message: "Server not found." });
          return;
        }
        if (
          returnedServer[0].user_id != req.user!.id &&
          !Utils.adminCheck(req.user!) &&
          returnedServer[0].public_server == 0
        ) {
          res.status(403).json({ message: "User does not own this server." });
          return;
        }
        if (req.body[0].server_id != matchRow[0].server_id) diffServer = true;
        // The match's own server is "in use" by this match; only a different server must be free.
        if (diffServer && returnedServer[0].in_use) {
          res.status(409).json({
            message:
              "Server is already in use, please select a different server."
          });
          return;
        }
      }
      if (req.body[0].season_id != null) {
        const season: RowDataPacket[] = await db.query(
          "SELECT user_id FROM season WHERE id = ?",
          [req.body[0].season_id]
        );
        if (
          !season.length ||
          (season[0].user_id != req.user!.id && !Utils.adminCheck(req.user!))
        ) {
          res.status(403).json({ message: "User does not own this season." });
          return;
        }
      }

      let vetoSql: string =
        "SELECT map FROM veto WHERE match_id = ? AND pick_or_veto = 'pick'";
      let vetoMapPool: any = null;
      let maxMaps: number | null = null;
      vetoList = await db.query(vetoSql, req.body[0].match_id);
      vetoList = JSON.parse(JSON.stringify(vetoList));
      if (Object.keys(vetoList).length > 0) {
        vetoList.forEach((veto: { map: string }) => {
          //console.log(veto);
          if (vetoMapPool == null) vetoMapPool = veto.map;
          else vetoMapPool = vetoMapPool + " " + veto.map;
        });
        maxMaps = Object.keys(vetoList).length;
        // Remove last two characters.
        // vetoMapPool = vetoMapPool.substring(0, vetoMapPool.length - 2);
        // If we're identical to the matches map pool, it usually means we've begun.
        if (vetoMapPool == matchRow[0].veto_mappool) {
          vetoMapPool = null;
          maxMaps = null;
        }
      }
      let updateStmt: MatchData = {
        user_id: req.body[0].user_id,
        server_id: req.body[0].server_id,
        season_id: req.body[0].season_id,
        start_time: req.body[0].start_time,
        end_time: req.body[0].end_time,
        winner: req.body[0].winner,
        plugin_version: req.body[0].plugin_version,
        forfeit: req.body[0].forfeit,
        cancelled: req.body[0].cancelled,
        team1_score: req.body[0].team1_score,
        team2_score: req.body[0].team2_score,
        private_match: req.body[0].private_match,
        max_maps: maxMaps,
        skip_veto: vetoMapPool == null ? null : 1,
        veto_first: req.body[0].veto_first,
        veto_mappool:
          vetoMapPool == null ? req.body[0].veto_mappool : vetoMapPool,
        side_type: req.body[0].side_type,
        enforce_teams:
          matchRow[0].is_pug != null && matchRow[0].is_pug == 1
            ? 0
            : req.body[0].enforce_teams, // Do not update these unless required.
        players_per_team:
          req.body[0].players_per_team == null
            ? null
            : req.body[0].players_per_team,
        min_spectators_to_ready:
          req.body[0].min_spectators_to_ready !== null
            ? req.body[0].min_spectators_to_ready
            : 0,
        map_sides:
          req.body[0].map_sides !== null ? req.body[0].map_sides : null,
        wingman: req.body[0]?.wingman
      };
      // Remove any values that may not be updated.
      updateStmt = (await db.buildUpdateStatement(updateStmt)) as MatchData;
      if (Object.keys(updateStmt).length === 0) {
        res.status(412).json({ message: "No update data has been provided." });
        return;
      }
      let sql: string = "UPDATE `match` SET ? WHERE id = ?";
      await db.query(sql, [updateStmt, req.body[0].match_id]);
      if (req.body[0].spectator_auths) {
        sql =
          "INSERT match_spectator (match_id, auth, spectator_name) VALUES (?,?,?)";
        for (let key in req.body[0].spectator_auths) {
          // Entries are "<steam id>;<optional name>".
          const [rawAuth, spectatorName] = String(
            req.body[0].spectator_auths[key]
          ).split(";");
          let newAuth: string = await Utils.getSteamPID(rawAuth);
          if (!newAuth) continue;
          await db.query(sql, [
            req.body[0].match_id,
            newAuth,
            spectatorName ?? null
          ]);
        }
      }
      const ourServer: RowDataPacket[] = await db.query(ourServerSql, [
        matchRow[0].server_id
      ]);
      const serverConn: GameServer | null =
        matchRow[0].server_id != null
          ? new GameServer(
              ourServer[0].ip_string,
              ourServer[0].port,
              ourServer[0].rcon_password
            )
          : null;
      if (
        req.body[0].forfeit == 1 ||
        req.body[0].cancelled == 1 ||
        req.body[0].end_time != null
      ) {
        if (serverConn != null) {
          if (!(await serverConn.endGet5Match())) {
            logger.warn(
              "Error attempting to stop match on game server side. Will continue."
            );
          }
          // The match is over in the panel either way, so the server is free again.
          sql = "UPDATE game_server SET in_use=0 WHERE id=?";
          await db.query(sql, [matchRow[0].server_id]);
        }
        if (matchRow[0].is_pug != null && matchRow[0].is_pug == 1) {
          let pugSql: string =
            "DELETE FROM team_auth_names WHERE team_id = ? OR team_id = ?";
          await db.query(pugSql, [matchRow[0].team1_id, matchRow[0].team2_id]);
          pugSql = "DELETE FROM team WHERE id = ? OR id = ?";
          await db.query(pugSql, [matchRow[0].team1_id, matchRow[0].team2_id]);
        }
      } else {
        if (!req.body[0].ignore_server) {
          if (diffServer) {
            if (serverConn != null && (await serverConn.endGet5Match())) {
              sql = "UPDATE game_server SET in_use=0 WHERE id=?";
              await db.query(sql, [matchRow[0].server_id]);
            }
            const newServeInfo = await db.query(ourServerSql, [
              req.body[0].server_id
            ]);
            const newServer = new GameServer(
              newServeInfo[0].ip_string,
              newServeInfo[0].port,
              newServeInfo[0].rcon_password
            );
            if (
              await newServer.prepareGet5Match(
                Utils.apiUrl("/matches/" + matchRow[0].id + "/config"),
                matchRow[0].api_key
              )
            ) {
              sql = "UPDATE game_server SET in_use=1 WHERE id=?";
              await db.query(sql, [req.body[0].server_id]);
              message =
                "Match updated successfully! Please move over the last backup from the old server to the new one!";
            }
          }
        }
      }
      if (req.body[0].match_cvars != null) {
        let newCvars: Array<Object> = req.body[0].match_cvars;
        for (let key in newCvars) {
          // Replace instead of adding a duplicate row for the same cvar.
          await db.query(
            "DELETE FROM match_cvar WHERE match_id = ? AND cvar_name = ?",
            [req.body[0].match_id, key]
          );
          await db.query(
            "INSERT match_cvar (match_id, cvar_name, cvar_value) VALUES (?,?,?)",
            [req.body[0].match_id, key, newCvars[key]]
          );
        }
      }
      res.json({ message: message });
      return;
    }
  } catch (err) {
    next(err);
    logger.error(err);
  }
});

/**
 * @swagger
 *
 * /matches:
 *   delete:
 *     description: Delete a match and all values associated if it is cancelled.
 *     produces:
 *       - application/json
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: object
 *            properties:
 *              match_id:
 *                type: integer
 *              all_cancelled:
 *                type: boolean
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.delete("/", Utils.ensureAuthenticated, audited("match.delete", { target: (req) => ({ type: "match", id: Number(firstBody(req).match_id) || null }), detail: (req) => (firstBody(req).all_cancelled ? "all cancelled matches" : null) }), async (req, res, next) => {
  try {
    let userId: number = req.user!.id;
    // Everything that belongs to a match, then the match itself.
    const deleteMatch = async (matchId: string | number): Promise<number> => {
      await Utils.deleteMatchProgress(matchId);
      await db.query("DELETE FROM match_spectator WHERE match_id = ?", [matchId]);
      await db.query("DELETE FROM match_cvar WHERE match_id = ?", [matchId]);
      const delRows: any = await db.query("DELETE FROM `match` WHERE id = ?", [matchId]);
      return delRows.affectedRows;
    };
    const allCancelled = req.body[0]?.all_cancelled;
    if (allCancelled == false || allCancelled == null) {
      let errMessage = await Utils.getUserMatchAccessNoFinalize(
        req.body[0]?.match_id,
        req.user!
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      }
      let matchId: string = req.body[0].match_id;
      const matchCancelledResult: RowDataPacket[] = await db.query(
        "SELECT cancelled, forfeit, end_time, user_id from `match` WHERE id = ?",
        [matchId]
      );
      if (
        matchCancelledResult[0].cancelled == 1 ||
        matchCancelledResult[0].forfeit == 1 ||
        matchCancelledResult[0].end_time != null
      ) {
        if ((await deleteMatch(matchId)) > 0)
          res.json({ message: "Match deleted successfully!" });
        else throw new Error("We found an issue deleting the match values.");
        return;
      }
      res.status(403).json({
        message: "Cannot delete match as it is not cancelled."
      });
      return;
    } else if (allCancelled == true) {
      const cancelled: RowDataPacket[] = await db.query(
        "SELECT id FROM `match` WHERE cancelled = 1 AND user_id = ?",
        [userId]
      );
      let deleted: number = 0;
      for (const match of cancelled) {
        deleted += await deleteMatch(match.id);
      }
      if (deleted > 0) res.json({ message: "Matches deleted successfully!" });
      else res.json({ message: "No cancelled matches to delete." });
      return;
    }
    res.status(400).json({ message: "all_cancelled must be true or false." });
  } catch (err) {
    next(err);
  }
});

/** POST /matches. A named function, so a PUG queue can create its match the same way (createMatchAs). */
export async function createMatchHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Matches are run by the panel's admins.
    if (!Utils.adminCheck(req.user!)) {
      res.status(403).json({ message: "Only admins can create matches." });
      return;
    }
    // A match for a tournament slot: the slot must be ready, free, and played by exactly these teams.
    const tournamentMatchId: number | null = Number(req.body[0]?.tournament_match_id) || null;
    if (tournamentMatchId) {
      const slot: RowDataPacket[] = await db.query(
        "SELECT tm.*, t.user_id AS tournament_owner, t.season_id AS tournament_season, m.cancelled AS linked_cancelled " +
          "FROM tournament_match tm JOIN tournament t ON t.id = tm.tournament_id " +
          "LEFT JOIN `match` m ON m.id = tm.match_id WHERE tm.id = ?",
        [tournamentMatchId]
      );
      const node = slot[0];
      if (!node) {
        res.status(404).json({ message: "Tournament match not found." });
        return;
      }
      if (node.tournament_owner !== req.user!.id && !Utils.adminCheck(req.user!)) {
        res.status(403).json({ message: "User is not authorized to perform action." });
        return;
      }
      if (node.status !== "ready" || (node.match_id != null && !node.linked_cancelled)) {
        res.status(409).json({ message: "This tournament match isn't ready or already has a match." });
        return;
      }
      // Round robin and group nodes are all ready at once: a team plays one tournament match at a time.
      const busy: RowDataPacket[] = await db.query(
        "SELECT tm.id FROM tournament_match tm JOIN `match` m ON m.id = tm.match_id " +
          "WHERE tm.tournament_id = ? AND tm.id <> ? AND m.end_time IS NULL AND NOT COALESCE(m.cancelled, 0) " +
          "AND NOT COALESCE(m.forfeit, 0) AND (tm.team1_id IN (?, ?) OR tm.team2_id IN (?, ?)) LIMIT 1",
        [node.tournament_id, node.id, node.team1_id, node.team2_id, node.team1_id, node.team2_id]
      );
      if (busy.length) {
        res.status(409).json({ message: "A team of this pairing is still playing another tournament match." });
        return;
      }
      if (Number(req.body[0].team1_id) !== node.team1_id || Number(req.body[0].team2_id) !== node.team2_id) {
        res.status(412).json({ message: "The teams don't match the tournament pairing." });
        return;
      }
      req.body[0].season_id = node.tournament_season ?? req.body[0].season_id;
    }
    const cvarError: string | null = Utils.validateCvars(
      req.body[0]?.match_cvars
    );
    if (cvarError) {
      res.status(412).json({ message: cvarError });
      return;
    }
    // Check if server available, if we are given a server.
    let serverSql: string =
      "SELECT in_use, user_id, public_server FROM game_server WHERE id = ?";
    if (req.body[0].server_id != null) {
      const serverInUse: RowDataPacket[] = await db.query(serverSql, [
        req.body[0].server_id
      ]);
      if (!serverInUse.length) {
        res.status(404).json({ message: "Server not found." });
        return;
      } else if (serverInUse[0].in_use) {
        res.status(409).json({
          message: "Server is already in use, please select a different server."
        });
        return;
      } else if (
        serverInUse[0].user_id != req.user!.id &&
        !Utils.adminCheck(req.user!) &&
        serverInUse[0].public_server == 0
      ) {
        res.status(403).json({ message: "User does not own this server." });
        return;
      }
    } else if (!req.body[0].ignore_server) {
      res.status(412).json({ message: "Please choose a server." });
      return;
    }
    // Season results are pushed to the season owner's Challonge tournament, so only their own seasons.
    if (req.body[0].season_id != null) {
      const season: RowDataPacket[] = await db.query(
        "SELECT user_id FROM season WHERE id = ?",
        [req.body[0].season_id]
      );
      if (!season.length) {
        res.status(404).json({ message: "Season not found." });
        return;
      } else if (
        season[0].user_id != req.user!.id &&
        !Utils.adminCheck(req.user!)
      ) {
        res.status(403).json({ message: "User does not own this season." });
        return;
      }
    }
    let teamNameSql: string = "SELECT name FROM team WHERE id = ?";
    let teamOneName: RowDataPacket[] = await db.query(teamNameSql, [
      req.body[0].team1_id
    ]);
    let teamTwoName: RowDataPacket[] = await db.query(teamNameSql, [
      req.body[0].team2_id
    ]);
    if (!teamOneName.length || !teamTwoName.length) {
      res.status(404).json({ message: "Team not found." });
      return;
    }
    // Reserve the server atomically, so two matches can't be created on it at the same time.
    let serverReserved: boolean = false;
    if (!req.body[0].ignore_server) {
      const reserve: any = await db.query(
        "UPDATE game_server SET in_use = 1 WHERE id = ? AND in_use = 0",
        [req.body[0].server_id]
      );
      if (reserve.affectedRows !== 1) {
        res.status(409).json({
          message: "Server is already in use, please select a different server."
        });
        return;
      }
      serverReserved = true;
    }
    try {
      let apiKey: string = generate({
        length: 24,
        capitalization: "uppercase"
      });
      let skipVeto: boolean =
        req.body[0].skip_veto == null ? false : req.body[0].skip_veto;
      let insertMatch: any;
      let insertSet: MatchData = {
        user_id: req.user!.id,
        server_id: req.body[0].server_id,
        team1_id: req.body[0].team1_id,
        team2_id: req.body[0].team2_id,
        season_id: req.body[0].season_id,
        start_time: req.body[0].start_time,
        max_maps: req.body[0].max_maps,
        title: req.body[0].title,
        skip_veto: skipVeto,
        veto_first: req.body[0].veto_first,
        veto_mappool: req.body[0].veto_mappool,
        side_type:
          req.body[0].side_type == null ? "standard" : req.body[0].side_type,
        plugin_version: req.body[0].plugin_version,
        private_match:
          req.body[0].private_match == null ? 0 : req.body[0].private_match,
        enforce_teams:
          req.body[0].enforce_teams == null ? 1 : req.body[0].enforce_teams,
        api_key: apiKey,
        winner: null,
        team1_string: teamOneName[0].name == null ? null : teamOneName[0].name,
        team2_string: teamTwoName[0].name == null ? null : teamTwoName[0].name,
        is_pug: req.body[0].is_pug,
        min_player_ready: req.body[0].min_players_to_ready,
        players_per_team: req.body[0].players_per_team,
        min_spectators_to_ready:
          req.body[0].min_spectators_to_ready !== null
            ? req.body[0].min_spectators_to_ready
            : 0,
        map_sides:
          req.body[0].map_sides !== null ? req.body[0].map_sides : null,
        wingman: req.body[0]?.wingman
      };
      let sql: string = "INSERT INTO `match` SET ?";
      let cvarSql: string =
        "INSERT match_cvar (match_id, cvar_name, cvar_value) VALUES (?,?,?)";
      insertSet = (await db.buildUpdateStatement(insertSet)) as MatchData;
      insertMatch = await db.query(sql, [insertSet]);
      if (req.body[0].spectator_auths) {
        sql =
          "INSERT match_spectator (match_id, auth, spectator_name) VALUES (?,?,?)";
        for (let key in req.body[0].spectator_auths) {
          // Entries are "<steam id>;<optional name>".
          const [rawAuth, spectatorName] = String(
            req.body[0].spectator_auths[key]
          ).split(";");
          let newAuth: string = await Utils.getSteamPID(rawAuth);
          if (!newAuth) continue;
          await db.query(sql, [
            insertMatch.insertId,
            newAuth,
            spectatorName ?? null
          ]);
        }
      }

      if (req.body[0].match_cvars != null) {
        let cvarInsertSet: Array<Object> = req.body[0].match_cvars;
        // Already validated above: no quotes or separators, so values are stored as-is.
        for (let key in cvarInsertSet) {
          await db.query(cvarSql, [
            insertMatch.insertId,
            key,
            cvarInsertSet[key]
          ]);
        }
      }
      if (!req.body[0].ignore_server) {
        let ourServerSql: string =
          "SELECT rcon_password, ip_string, port FROM game_server WHERE id=?";
        const serveInfo: RowDataPacket[] = await db.query(ourServerSql, [
          req.body[0].server_id
        ]);
        const newServer: GameServer = new GameServer(
          serveInfo[0].ip_string,
          serveInfo[0].port,
          serveInfo[0].rcon_password
        );
        // Removes the match again when it can't be loaded, so no half-created match is left behind.
        const undoMatch = async () => {
          await db.query("DELETE FROM match_spectator WHERE match_id = ?", [
            insertMatch.insertId
          ]);
          await db.query("DELETE FROM match_cvar WHERE match_id = ?", [
            insertMatch.insertId
          ]);
          await db.query("DELETE FROM `match` WHERE id = ?", [
            insertMatch.insertId
          ]);
        };
        if (process.env.NODE_ENV !== "test") {
          if (
            !(await newServer.isServerAlive()) ||
            !(await newServer.isGet5Available())
          ) {
            await undoMatch();
            await db.query("UPDATE game_server SET in_use = 0 WHERE id = ?", [
              req.body[0].server_id
            ]);
            serverReserved = false;
            res.status(412).json({
              message:
                "The server is offline, MatchZy is not answering, or a match is already loaded on it."
            });
            return;
          }
          sql = "UPDATE `match` SET plugin_version = ? WHERE id = ?";
          const get5Version: string = await newServer.getGet5Version();
          await db.query(sql, [get5Version, insertMatch.insertId]);
          if (
            !(await newServer.prepareGet5Match(
              Utils.apiUrl("/matches/" + insertMatch.insertId + "/config"),
              apiKey
            ))
          ) {
            await undoMatch();
            await db.query("UPDATE game_server SET in_use = 0 WHERE id = ?", [
              req.body[0].server_id
            ]);
            serverReserved = false;
            res.status(500).json({
              message:
                "MatchZy did not load the match. Check the game server's MatchZy log; the match was not created."
            });
            return;
          }
        }
      }
      if (tournamentMatchId) {
        await db.query("UPDATE tournament_match SET match_id = ? WHERE id = ?", [insertMatch.insertId, tournamentMatchId]);
        GlobalEmitter.emit("tournamentUpdate");
      }
      res.json({
        message: "Match inserted successfully!",
        id: insertMatch.insertId
      });
    } catch (innerErr) {
      // Give the server back if anything failed after reserving it.
      if (serverReserved) {
        await db.query("UPDATE game_server SET in_use = 0 WHERE id = ?", [
          req.body[0].server_id
        ]);
      }
      throw innerErr;
    }
  } catch (err) {
    next(err);
  }
}

/** Creates a match as the given user, with exactly the checks of POST /matches.
 * @returns The HTTP status and JSON the route would have answered.
 */
export async function createMatchAs(
  user: Express.User,
  body: Record<string, unknown>
): Promise<{ status: number; json: any }> {
  const result = { status: 200, json: null as any };
  const fakeRes = {
    status(code: number) {
      result.status = code;
      return fakeRes;
    },
    json(payload: unknown) {
      result.json = payload;
      return fakeRes;
    }
  };
  let failure: unknown = null;
  await createMatchHandler(
    { user, body: [body], params: {}, query: {} } as unknown as Request,
    fakeRes as unknown as Response,
    (err?: unknown) => {
      failure = err;
    }
  );
  if (failure) throw failure instanceof Error ? failure : new Error("Match creation failed.");
  return result;
}

export default router;
