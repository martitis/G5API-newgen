/** Express API router for game server updates in get5.
 * @module routes/v2
 * @requires express
 * @requires db
 */

/**
 * @swagger
 * resourcePath: /v2
 * description: Express API for v2 API calls in G5API.
 */

import { Router } from "express";
/** Express module
 * @const
 */
const router: Router = Router();

/** Rate limit includes.
 * @const
 */
import rateLimit from "express-rate-limit";

import { db } from "../../services/db.js";
import { RowDataPacket } from "mysql2";
import { Get5_OnEvent } from "../../types/Get5_OnEvent.js";
import SeriesFlowService from "../../services/seriesflowservices.js";
import { Get5_OnSeriesResult } from "../../types/series_flow/Get5_OnSeriesResult.js";
import { Get5_OnMapResult } from "../../types/series_flow/Get5_OnMapResult.js";
import { Get5_OnMapVetoed } from "../../types/series_flow/veto/Get5_OnMapVetoed.js";
import { Get5_OnMapPicked } from "../../types/series_flow/veto/Get5_OnMapPicked.js";
import { Get5_OnSidePicked } from "../../types/series_flow/veto/Get5_OnSidePicked.js";
import { Get5_OnBackupRestore } from "../../types/series_flow/Get5_OnBackupRestore.js";
import { Get5_OnGoingLive } from "../../types/map_flow/Get5_OnGoingLive.js";
import MapFlowService from "../../services/mapflowservices.js";
import { Get5_OnMatchPausedUnpaused } from "../../types/map_flow/Get5_OnMatchPausedUnpaused.js";
import { Get5_OnPlayerDeath } from "../../types/map_flow/Get5_OnPlayerDeath.js";
import { Get5_OnBombEvent } from "../../types/map_flow/Get5_OnBombEvent.js";
import { Get5_OnRoundStart } from "../../types/map_flow/Get5_OnRoundStart.js";
import Utils from "../../utility/utils.js";
import { eventProblem } from "../../services/eventschemas.js";
import GlobalEmitter from "../../utility/emitter.js";
import { Get5_OnRoundEnd } from "../../types/map_flow/Get5_OnRoundEnd.js";

import logger from "../../utility/logger.js";
/** Basic Rate limiter.
 * @const
 */
const basicRateLimit = rateLimit({
  windowMs: 30 * 30 * 1000, // 15 mins per 30k requests seems like a fair amount.
  max: 30000,
  message: "Too many requests from this IP. Please try again in 15 minutes.",
  // One bucket per match key (each game server sends its own); no DB lookup per request.
  keyGenerator: (req) => req.get("Authorization") || req.ip || "unknown"
});

/**
 * @swagger
 *
 * /v2:
 *   post:
 *     description: MatchZy's event webhook (matchzy_remote_log_url), authenticated with the match API key in the
 *                  Authorization header. See [MatchZy events](https://shobhit-pathak.github.io/MatchZy/events/);
 *                  each event's shape is checked in src/services/eventschemas.ts.
 *     produces:
 *       - application/json
 *     tags:
 *       - v2
 *     responses:
 *       200:
 *         description: Success.
 *         content:
 *             text/plain:
 *                schema:
 *                  type: string
 *       401:
 *         $ref: '#/components/responses/Error'
 */
router.post("/", basicRateLimit, async (req, res) => {
  let matchId: string = req.body?.matchid;
  const apiKey: string | undefined = req.get("Authorization");
  const eventType: Get5_OnEvent = req.body;

  try {
    if (!apiKey) {
      return res.status(401).send({ message: "API key not provided." });
    }

    if (!matchId) {
      // Retrieve Match ID from the database.
      const dbMatchKey: RowDataPacket[] = await db.query(
        "SELECT id FROM `match` WHERE api_key = ?",
        [apiKey]
      );
      if (!dbMatchKey[0]?.id) {
        res.status(401).send({ message: "Match ID has not been provided." });
        return;
      }
      matchId = dbMatchKey[0].id;
    }

    const matchApiCheck: number = await Utils.checkApiKey(apiKey, matchId);
    if (matchApiCheck == 1) {
      logger.warn({ match_id: matchId, event: eventType.event }, "Refused a MatchZy event: invalid API key");
      return res.status(401).send({ message: "Invalid API key has been given." });
    }
    // Demo uploads end after the match did, so this one is taken for finished matches too.
    if (eventType.event == "demo_upload_ended") {
      // The demo itself arrives on /v2/demo; only failures are worth noting here.
      const demoEvent = req.body as { success?: boolean; filename?: string; map_number?: number };
      if (demoEvent.success === false) {
        logger.error(
          `MatchZy failed to upload demo ${demoEvent.filename ?? ""} (match ${matchId}, map ${demoEvent.map_number}).`
        );
        // Shown on the match page; a later successful upload sets demoFile and clears it.
        await db.query(
          "UPDATE map_stats SET demo_status = 'failed' WHERE match_id = ? AND map_number = ? AND demoFile IS NULL",
          [matchId, Number(demoEvent.map_number) || 0]
        );
        GlobalEmitter.emit("mapStatUpdate");
      }
      return res.status(200).send({message: "Success"});
    }
    // A finished or cancelled match: MatchZy still sends what happens afterwards (players leaving, the map_result of
    // a match ended from the panel). Nothing to record, and refusing it would only fill both logs with errors.
    if (matchApiCheck == 2) {
      logger.debug({ match_id: matchId, event: eventType.event }, "Ignored a MatchZy event for a finished match");
      return res.status(200).send({ message: "Match already finalized; event ignored." });
    }

    // A malformed event would fail halfway through a handler; refuse it whole instead.
    const problem: string | null = eventProblem(req.body);
    if (problem) {
      logger.error(`Malformed MatchZy event for match ${matchId}: ${problem}`);
      return res.status(400).send({ message: problem });
    }

    switch (eventType.event) {
      // Series Flows
      case "map_picked":
        await SeriesFlowService.OnMapPicked(req.body as Get5_OnMapPicked, res);
        break;
      case "map_vetoed":
        await SeriesFlowService.OnMapVetoed(req.body as Get5_OnMapVetoed, res);
        break;
      case "side_picked":
        await SeriesFlowService.OnSidePicked(req.body as Get5_OnSidePicked, res);
        break;
      case "backup_loaded":
        await SeriesFlowService.OnBackupRestore(
          req.body as Get5_OnBackupRestore,
          res
        );
        break;
      case "map_result":
        await SeriesFlowService.OnMapResult(req.body as Get5_OnMapResult, res);
        break;
      case "series_end":
        await SeriesFlowService.OnSeriesResult(req.body as Get5_OnSeriesResult, res);
        break;
      // Map Flows
      case "going_live":
        await MapFlowService.OnGoingLive(req.body as Get5_OnGoingLive, res);
        break;
      case "round_start":
        await MapFlowService.OnRoundStart(req.body as Get5_OnRoundStart, res);
        break;
      case "round_end":
        await MapFlowService.OnRoundEnd(req.body as Get5_OnRoundEnd, res);
        break;
      case "player_death":
        await MapFlowService.OnPlayerDeath(req.body as Get5_OnPlayerDeath, res);
        break;
      case "bomb_planted":
        await MapFlowService.OnBombEvent(req.body as Get5_OnBombEvent, res, false);
        break;
      case "bomb_defused":
        await MapFlowService.OnBombEvent(req.body as Get5_OnBombEvent, res, true);
        break;
      case "game_paused":
        await MapFlowService.OnMatchPausedUnPaused(
          req.body as Get5_OnMatchPausedUnpaused,
          res
        );
        break;
      case "game_unpaused":
        await MapFlowService.OnMatchPausedUnPaused(
          req.body as Get5_OnMatchPausedUnpaused,
          res
        );
        break;
      // Informational events: the match row already holds the series setup, and
      // connections are visible on the server itself. Acknowledge so MatchZy logs no error.
      case "series_start":
        GlobalEmitter.emit("matchUpdate");
        res.status(200).send({ message: "Success" });
        break;
      case "player_disconnect":
        res.status(200).send({ message: "Success" });
        break;
      default:
        res.status(202).send({message: `Event ${eventType.event} is not implemented.`});
        break;
    }
    // Responses are taken care of in the case statements.
    return;
  } catch (error: unknown) {
    logger.error({ err: error }, `Error handling ${eventType?.event} event for match ${matchId}`);
    if (!res.headersSent) {
      res.status(500).send({ message: "Failed to process event." });
    }
    return;
  }
});

export { router };
