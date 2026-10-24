/**
 * @swagger
 * resourcePath: /matches
 * description: Express API router for a match's game server (MatchZy commands over RCON).
 */
import { NextFunction, Request, Response, Router } from "express";

const router = Router();

import {db} from "../../services/db.js";

import Utils from "../../utility/utils.js";

import GameServer, { BackupEntry, parseStatusPlayers, RconArgumentError, restoreFailed } from "../../utility/serverrcon.js";
import { callbackCvars } from "../../services/matchconfig.js";
import config from "config";
import { audited, firstBody } from "../../utility/audit.js";
import { onMatchChanged } from "../../services/tournaments.js";
import { controlCommand } from "../../utility/matchcontrol.js";

/** After a successful forfeit, cancel or restart, the match's tournament bracket is updated. */
const refreshTournamentAfter = (req: Request, res: Response, next: NextFunction) => {
  res.on("finish", () => {
    if (res.statusCode < 400) void onMatchChanged(req.params.match_id);
  });
  next();
};


import { existsSync, readdir } from "fs";
import { AccessMessage } from "../../types/mapstats/AccessMessage.js";
import { RowDataPacket } from "mysql2";
import { MapStats } from "../../types/mapstats/MapStats.js";
import { MatchData } from "../../types/matches/MatchData.js";
import GlobalEmitter from "../../utility/emitter.js";

import logger from "../../utility/logger.js";
import { checkMatch, dismissServerState, getServerState } from "../../services/heartbeat.js";
/**
 * @swagger
 *
 *  /matches/:match_id/forfeit/:winner_id:
 *   post:
 *     description: Forfeits a current match with a given team ID as the winner, if the match is running.
 *     parameters:
 *       - in: path
 *         name: winner_id
 *         schema:
 *           type: integer
 *         required: true
 *       - in: path
 *         name: match_id
 *         schema:
 *           type: integer
 *         required: true
 *     produces:
 *       - application/json
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       412:
 *         $ref: '#/components/responses/MatchInvalidData'
 */
router.post(
  "/:match_id/forfeit/:winner_id",
  Utils.ensureAuthenticated,
  audited("match.forfeit", { detail: (req) => `winner team ${req.params.winner_id}` }),
  refreshTournamentAfter,
  async (req, res, next) => {
    try {
      const errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        false
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else if (req.params.winner_id != "1" && req.params.winner_id != "2") {
        res
          .status(412)
          .json({ message: "Winner number invalid. Please provide 1 or 2." });
      } else {
        const currentMatchInfo: string =
          "SELECT server_id, team1_id, team2_id, is_pug FROM `match` WHERE id = ?";
        const matchRow: RowDataPacket[] = await db.query(
          currentMatchInfo,
          [req.params.match_id]
        );
        let teamIdWinner: number =
          req.params.winner_id == "1"
            ? matchRow[0].team1_id
            : matchRow[0].team2_id;
        let mapStatSql: string =
          "SELECT id FROM map_stats WHERE match_id=? AND map_number=0";
        const mapStat: RowDataPacket[] = await db.query(mapStatSql, [
          req.params.match_id,
        ]);
        let mapStatId: RowDataPacket[];
        let newStatStmt: MapStats = {
          start_time: new Date().toISOString().slice(0, 19).replace("T", " "),
          end_time: new Date().toISOString().slice(0, 19).replace("T", " "),
          winner: teamIdWinner,
          team1_score: req.params.winner_id == "1" ? 16 : 0,
          team2_score: req.params.winner_id == "2" ? 16 : 0,
          match_id: req.params.match_id,
        };
        let matchUpdateStmt: MatchData = {
          team1_score: req.params.winner_id == "1" ? 1 : 0,
          team2_score: req.params.winner_id == "2" ? 1 : 0,
          start_time: new Date().toISOString().slice(0, 19).replace("T", " "),
          end_time: new Date().toISOString().slice(0, 19).replace("T", " "),
          winner: teamIdWinner,
          forfeit: 1,
        };
        if (!mapStat.length) {
          mapStatSql = "INSERT map_stats SET ?";
        } else {
          mapStatSql =
            "UPDATE map_stats SET ? WHERE match_id=? AND map_number=0";
        }
        let matchSql: string = "UPDATE `match` SET ? WHERE id=?";
        let serverUpdateSql: string = "UPDATE game_server SET in_use=0 WHERE id=?";
        if (!mapStat.length) {
          mapStatId = await db.query(mapStatSql, [newStatStmt]);
        }
        else
          await db.query(mapStatSql, [
            newStatStmt,
            req.params.match_id,
          ]);
        await db.query(matchSql, [
          matchUpdateStmt,
          req.params.match_id,
        ]);
        await db.query(serverUpdateSql, [matchRow[0].server_id]);
        if (matchRow[0].is_pug != null && matchRow[0].is_pug == 1) {
          await Utils.updatePugStats(
              req.params.match_id,
              //@ts-ignore
              !mapStat.length ? mapStatId.insertId : mapStat[0].id,
              matchRow[0].team1_id,
              matchRow[0].team2_id,
              teamIdWinner
            );
        }
        if (matchRow[0].server_id != null) {
          let serverUpdate: GameServer = await getGameServer(req.params.match_id);
          // Ends the series on the server with the forfeit winner announced.
          if (!(await serverUpdate.endGet5Match(req.params.winner_id == "1" ? "team1" : "team2"))) {
            logger.warn(
              "Error attempting to stop match on game server side. Will continue."
            );
          }
        }
        res.json({ message: "Match has been forfeitted successfully." });
        return;
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/cancel:
 *   post:
 *     description: Cancels the given match, provided it isn't finished and the user has the ability to do so. The user must either own the match or be an admin.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post(
  "/:match_id/cancel/",
  Utils.ensureAuthenticated,
  audited("match.cancel"),
  refreshTournamentAfter,
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {

        let currentMatchInfo: string =
          "SELECT server_id, team1_id, team2_id, is_pug FROM `match` WHERE id = ?";
        const matchRow: RowDataPacket[] = await db.query(
          currentMatchInfo,
          [req.params.match_id]
        );
        let mapStatSql: string =
          "SELECT id FROM map_stats WHERE match_id=? AND map_number=0";
        const mapStat: RowDataPacket[] = await db.query(mapStatSql, [
          req.params.match_id,
        ]);
        let mapStatId: RowDataPacket[];
        let newStatStmt: MapStats = {
          end_time: new Date().toISOString().slice(0, 19).replace("T", " "),
          winner: null,
          team1_score: 0,
          team2_score: 0,
          match_id: req.params.match_id,
        };
        let matchUpdateStmt: MatchData = {
          team1_score: 0,
          team2_score: 0,
          end_time: new Date().toISOString().slice(0, 19).replace("T", " "),
          winner: null,
          cancelled: 1,
        };
        if (!mapStat.length) {
          mapStatSql = "INSERT map_stats SET ?";
        } else {
          mapStatSql =
            "UPDATE map_stats SET ? WHERE match_id=? AND map_number=0";
        }
        let matchSql: string = "UPDATE `match` SET ? WHERE id=?";
        let serverUpdateSql: string = "UPDATE game_server SET in_use=0 WHERE id=?";
        if (!mapStat.length) {
          mapStatId = await db.query(mapStatSql, [newStatStmt]);
        }
        else
          await db.query(mapStatSql, [
            newStatStmt,
            req.params.match_id,
          ]);
        await db.query(matchSql, [
          matchUpdateStmt,
          req.params.match_id,
        ]);
        await db.query(serverUpdateSql, [matchRow[0].server_id]);
        if (matchRow[0].is_pug != null && matchRow[0].is_pug == 1) {
          await Utils.updatePugStats(
            req.params.match_id,
            //@ts-ignore
            !mapStat.length ? mapStatId.insertId : mapStat[0].id,
            matchRow[0].team1_id,
            matchRow[0].team2_id,
            null
          );
        }
        // Let the server cancel the match first, or attempt to?
        if (matchRow[0].server_id != null) {
          let serverUpdate: GameServer = await getGameServer(req.params.match_id);
          if (!(await serverUpdate.endGet5Match())) {
            logger.warn(
              "Error attempting to stop match on game server side. Will continue."
            );
          }
        }
        res.json({ message: "Match has been cancelled successfully." });
        return;
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/restart:
 *   post:
 *     description: Restarts the given match, provided it isn't finished and the user has the ability to do so. The user must either own the match or be an admin.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post(
  "/:match_id/restart/",
  Utils.ensureAuthenticated,
  audited("match.restart"),
  refreshTournamentAfter,
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {
        let currentMatchInfo: string =
          "SELECT server_id, team1_id, team2_id, is_pug, api_key FROM `match` WHERE id = ?";
        const matchRow: RowDataPacket[] = await db.query(
          currentMatchInfo,
          [req.params.match_id]
        );
        if (matchRow[0].server_id == null) {
          res.status(412).json({ message: "Match has no server to restart on." });
          return;
        }
        let matchUpdateStmt: { [key: string]: any } = {
          start_time: new Date().toISOString().slice(0, 19).replace("T", " "),
          cancelled: 0,
          end_time: null,
          winner: null,
          team1_score: 0,
          team2_score: 0,
          team1_series_score: 0,
          team2_series_score: 0
        };
        let serverUpdate: GameServer = await getGameServer(req.params.match_id);
        if (!(await serverUpdate.endGet5Match())) {
          logger.warn(
            "Error attempting to stop match on game server side. Will continue."
          );
        }
        // Start from a clean slate: every map, stat, kill, bomb, pause and veto of the previous attempt.
        await Utils.deleteMatchProgress(req.params.match_id);
        await db.query("UPDATE `match` SET ? WHERE id=?", [matchUpdateStmt, req.params.match_id]);
        await db.query("UPDATE game_server SET in_use = 1 WHERE id = ?", [matchRow[0].server_id]);
        GlobalEmitter.emit("matchUpdate");
        const loaded: boolean = await serverUpdate.prepareGet5Match(
          Utils.apiUrl("/matches/" + req.params.match_id + "/config"),
          matchRow[0].api_key
        );
        if (!loaded && process.env.NODE_ENV !== "test") {
          res.status(500).json({
            message: "Match data was reset, but MatchZy did not load the match. Check the game server's MatchZy log."
          });
          return;
        }
        res.json({ message: "Match has been restarted successfully." });
        return;
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/rcon:
 *   put:
 *     description: Sends out an RCON Command to the server, and returns the response if retrieved. Super admins can only use this, as you can retrieve RCON Passwords using this.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: object
 *            properties:
 *              rcon_command:
 *                type: string
 *                description: The rcon command that the user has sent in.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.put(
  "/:match_id/rcon/",
  Utils.ensureAuthenticated,
  audited("match.rcon", { detail: (req) => String(firstBody(req).rcon_command ?? "") }),
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {
        let strRconCommand: string = req.body[0].rcon_command;
        let currentMatchInfo: string = "SELECT server_id FROM `match` WHERE id = ?";
        let getServerSQL: string =
          "SELECT user_id FROM game_server WHERE id=?";
        const matchServerId: RowDataPacket[] = await db.query(
          currentMatchInfo,
          [req.params.match_id]
        );
        const serverRow: RowDataPacket[] = await db.query(getServerSQL, [
          matchServerId[0].server_id,
        ]);
        if (
          req.user &&
          !Utils.superAdminCheck(req.user) &&
          serverRow[0].user_id != req.user.id
        ) {
          res
            .status(403)
            .json({ message: "User is not authorized to perform action." });
          return;
        }
        let serverUpdate: GameServer = await getGameServer(req.params.match_id);
        try {
          let rconResponse: string = await serverUpdate.sendRconCommand(
            strRconCommand
          );
          res.json({
            message: "Command Sent Successfully.",
            response: rconResponse,
          });
          return;
        } catch (err) {
          logger.error(
            "Error attempting to send RCON Command. Please check server log."
          );
          res.status(500).json({
            message:
              "Error attempting to send RCON Command. Please check server log.",
          });
          return;
        }
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/pause:
 *   post:
 *     description: Sends the sm_pause command to a given match.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post(
  "/:match_id/pause/",
  Utils.ensureAuthenticated,
  audited("match.pause"),
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {
        let serverUpdate: GameServer = await getGameServer(req.params.match_id);
        let rconResponse: boolean = await serverUpdate.pauseMatch();
        if (rconResponse) {
          res.json({ message: "Match paused." });
        } else {
          res.json({
            message: "Match not paused. Check server log for details.",
          });
        }
        return;
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/unpause:
 *   post:
 *     description: Sends the sm_unpause command to a given match.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post(
  "/:match_id/unpause/",
  Utils.ensureAuthenticated,
  audited("match.unpause"),
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {
        let serverUpdate: GameServer = await getGameServer(req.params.match_id);
        let rconResponse: boolean = await serverUpdate.unpauseMatch();
        if (rconResponse) {
          res.json({ message: "Match unpaused." });
        } else {
          res.json({
            message: "Match not unpaused. Check server log for details.",
          });
        }
        return;
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/adduser:
 *   put:
 *     description: Sends an add user commamd to a given team.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: object
 *            properties:
 *              steam_id:
 *                type: string
 *                description: The formatted Steam ID of a user. Can be url, steam64, ID3, vanity URL.
 *              team_id:
 *                type: string
 *                description: Either the first or second team in the match, team1 or team2.
 *              nickname:
 *                type: string
 *                description: Optional nickname for the user being added into the match.
 *                required: false
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.put(
  "/:match_id/adduser/",
  Utils.ensureAuthenticated,
  audited("match.add_player", { detail: (req) => `${firstBody(req).steam_id ?? ""} -> ${firstBody(req).team_id ?? ""}` }),
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {
        let serverUpdate: GameServer = await getGameServer(req.params.match_id);
        let steamID: string = await Utils.getSteamPID(req.body[0].steam_id);
        let teamId: string = req.body[0].team_id;
        let nickName: string = req.body[0].nickname;
        if (teamId != "team1" && teamId != "team2") {
          res
            .status(400)
            .json({ message: "Please choose either team1 or team2." });
          return;
        }
        try {
          let rconResponse: string = await serverUpdate.addUser(
            teamId,
            steamID,
            nickName
          );
          res.json({
            message: "User added successfully.",
            response: rconResponse,
          });
        } catch (err) {
          if (err instanceof RconArgumentError) {
            res.status(412).json({ message: err.message });
          } else {
            res
              .status(500)
              .json({ message: "Error on game server.", response: err });
          }
        } finally {
          return;
        }
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/addcoach:
 *   put:
 *     description: Sends an add coach commamd to a given team.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: object
 *            properties:
 *              steam_id:
 *                type: string
 *                description: The formatted Steam ID of a user. Can be url, steam64, ID3, vanity URL.
 *              team_id:
 *                type: string
 *                description: Either the first or second team in the match, team1 or team2.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
 router.put(
  "/:match_id/addcoach/",
  Utils.ensureAuthenticated,
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {
        let serverUpdate: GameServer = await getGameServer(req.params.match_id);
        let steamID: string = await Utils.getSteamPID(req.body[0].steam_id);
        let teamId: string = req.body[0].team_id;
        if (teamId != "team1" && teamId != "team2") {
          res
            .status(400)
            .json({ message: "Please choose either team1 or team2." });
          return;
        }
        try {
          let rconResponse: string = await serverUpdate.addCoach(
            teamId,
            steamID
          );
          res.json({
            message: "User added successfully.",
            response: rconResponse,
          });
        } catch (err) {
          if (err instanceof RconArgumentError) {
            res.status(412).json({ message: err.message });
          } else {
            res
              .status(500)
              .json({ message: "Error on game server.", response: err });
          }
        } finally {
          return;
        }
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/addspec:
 *   put:
 *     description: Sends an add player to spectator command.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: object
 *            properties:
 *              user_id:
 *                type: string
 *                description: The formatted Steam ID of a user. Can be url, steam64, ID3, vanity URL.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.put(
  "/:match_id/addspec/",
  Utils.ensureAuthenticated,
  audited("match.add_spectator", { detail: (req) => String(firstBody(req).steam_id ?? "") }),
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {
        let serverUpdate: GameServer = await getGameServer(req.params.match_id);
        let steamID: string = await Utils.getSteamPID(req.body[0].steam_id);
        try {
          let rconResponse: string = await serverUpdate.addUser("spec", steamID);
          res.json({
            message: "User added to spectator successfully.",
            response: rconResponse,
          });
        } catch (err) {
          if (err instanceof RconArgumentError) {
            res.status(412).json({ message: err.message });
          } else {
            res
              .status(500)
              .json({ message: "Error on game server.", response: err });
          }
        } finally {
          return;
        }
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/removeuser:
 *   put:
 *     description: Sends a get5_removeplayer command to the game server with a given steam ID.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: object
 *            properties:
 *              steam_id:
 *                type: string
 *                description: The formatted Steam ID of a user. Can be url, steam64, ID3, vanity URL.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.put(
  "/:match_id/removeuser/",
  Utils.ensureAuthenticated,
  audited("match.remove_player", { detail: (req) => String(firstBody(req).steam_id ?? "") }),
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {
        let serverUpdate: GameServer = await getGameServer(req.params.match_id);
        let steamID: string = await Utils.getSteamPID(req.body[0].steam_id);
        try {
          let rconResponse: string = await serverUpdate.removeUser(steamID);
          res.json({
            message: "User removed from match successfully.",
            response: rconResponse,
          });
        } catch (err) {
          if (err instanceof RconArgumentError) {
            res.status(412).json({ message: err.message });
          } else {
            res
              .status(500)
              .json({ message: "Error on game server.", response: err });
          }
        } finally {
          return;
        }
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/backup:
 *   get:
 *     description: Retrieves the name of backups on the game server.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get(
  "/:match_id/backup/",
  Utils.ensureAuthenticated,
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {
        let serverUpdate: GameServer = await getGameServer(req.params.match_id);
        try {
          let backups: BackupEntry[] = await serverUpdate.getBackups(req.params.match_id);
          res.json({ message: "Backups retrieved.", response: backups });
        } catch (err) {
          if (err instanceof RconArgumentError) {
            res.status(412).json({ message: err.message });
          } else {
            res
              .status(500)
              .json({ message: "Error on game server.", response: err });
          }
        } finally {
          return;
        }
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/backup:
 *   post:
 *     description: Runs a backup file on the game server.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: object
 *            properties:
 *              backup_name:
 *                type: string
 *                description: Filename of the backup located on the game server.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       412:
 *         $ref: '#/components/responses/MatchInvalidData'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.post(
  "/:match_id/backup/",
  Utils.ensureAuthenticated,
  audited("match.restore_backup", { detail: (req) => String(firstBody(req).backup_name ?? "") }),
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {
        let serverUpdate: GameServer = await getGameServer(req.params.match_id);
        const backupName: unknown = req.body[0]?.backup_name;
        if (typeof backupName !== "string" || backupName === "") {
          res
            .status(412)
            .json({ message: "Please provide the backup name." });
          return;
        }
        try {
          // Only restore a file the server actually lists for this match.
          const backups: BackupEntry[] = await serverUpdate.getBackups(req.params.match_id);
          if (process.env.NODE_ENV !== "test" && !backups.some((b) => b.file === backupName)) {
            res.status(412).json({ message: "Backup not found on the game server." });
            return;
          }
          let rconResponse: string = await serverUpdate.restoreBackup(backupName);
          // MatchZy answers even when it restored nothing (e.g. "has no complete round data").
          if (restoreFailed(rconResponse)) {
            res.status(409).json({
              message: "MatchZy did not restore this backup. Try another round.",
              response: rconResponse
            });
            return;
          }
          res.json({ message: "Restored backup.", response: rconResponse });
        } catch (err) {
          if (err instanceof RconArgumentError) {
            res.status(412).json({ message: err.message });
          } else {
            res
              .status(500)
              .json({ message: "Error on game server.", response: err });
          }
        } finally {
          return;
        }
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/backup/remote:
 *   post:
 *     description: Runs a backup stored on the API remotely to a specified game server, provided it is available.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: object
 *            properties:
 *              server_id:
 *                type: integer
 *                description: The ID of the server that you wish to restore to.
 *              backup_file:
 *                type: string
 *                description: The name of the backup file. This can be retrieved via a GET.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       412:
 *         $ref: '#/components/responses/MatchInvalidData'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.post(
  "/:match_id/backup/remote",
  Utils.ensureAuthenticated,
  audited("match.restore_remote_backup", { detail: (req) => `server ${firstBody(req).server_id ?? ""}: ${firstBody(req).backup_file ?? ""}` }),
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {
        let newServerId: number = parseInt(req.body[0].server_id);
        let currentMatchInfo: string = "SELECT server_id, api_key FROM `match` WHERE id = ?";
        let newServerInfo: string =
          "SELECT id, user_id, ip_string, port, rcon_password, public_server FROM game_server WHERE id = ?";
        let configString: string = req.body[0].backup_file;
        const matchServerId: RowDataPacket[] = await db.query(
          currentMatchInfo,
          [req.params.match_id]
        );
        const newServerRow: RowDataPacket[] = await db.query(newServerInfo, [
          newServerId
        ]);
        if (!newServerRow.length) {
          res.status(404).json({ message: "Server not found." });
          return;
        }
        // Check to see if new server row matches for access purposes.
        if (!Utils.adminCheck(req.user!)) {
          if (newServerRow[0].user_id != req.user!.id && !newServerRow[0].public_server) {
            res.status(403).json({ message: "User is not authorized to perform action." });
            return;
          }
        }

        // Only plain file names from our own backup folder (no paths).
        if (
          typeof configString !== "string" ||
          !/^[\w-]+(\.[\w-]+)*\.(json|cfg)$/.test(configString) ||
          !existsSync(`public/backups/${parseInt(req.params.match_id)}/${configString}`)
        ) {
          res
            .status(412)
            .json({ message: "Backup name invalid." });
          return;
        }
        let serverUpdate: GameServer = new GameServer(
          newServerRow[0].ip_string,
          newServerRow[0].port,
          newServerRow[0].rcon_password
        );
        try {
          if (await serverUpdate.isGet5Available()) {
            let rconResponse: string = await serverUpdate.restoreBackupFromURL(
              Utils.apiUrl(`/backups/${parseInt(req.params.match_id)}/${configString}`),
              matchServerId[0].api_key
            );
            currentMatchInfo = "UPDATE `match` SET server_id = ? WHERE id = ?";
            await db.query(currentMatchInfo, [newServerId, req.params.match_id]);
            currentMatchInfo = "UPDATE game_server SET in_use = 1 WHERE id = ?";
            await db.query(currentMatchInfo, [newServerId]);
            currentMatchInfo = "UPDATE game_server SET in_use = 0 WHERE id = ?";
            await db.query(currentMatchInfo, [matchServerId[0].server_id]);
            res.json({ message: "Restored backup.", response: rconResponse });
          } else {
            res
              .status(412)
              .json({ message: "Match is already in progress on chosen server, or get5 is unavailable." });
            return;
          }
        } catch (err) {
          if (err instanceof RconArgumentError) {
            res.status(412).json({ message: err.message });
          } else {
            res
              .status(500)
              .json({ message: "Error on game server.", response: err });
          }
        } finally {
          return;
        }
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "Error on game server." });
    }
  }
);

/**
 * @swagger
 *
 *  /matches/:match_id/backup/remote:
 *   get:
 *     description: Retrieves the name of backups available for a match on the API.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: match_id
 *         description: The current matches identification number.
 *         schema:
 *            type: integer
 *
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Match response.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       401:
 *         $ref: '#/components/responses/MatchFinished'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get(
  "/:match_id/backup/remote",
  Utils.ensureAuthenticated,
  async (req, res, next) => {
    try {
      let errMessage: AccessMessage | null = await Utils.getUserMatchAccess(
        req.params.match_id,
        req.user!,
        true
      );
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      } else {
        let fileArray: Array<string> = [];
        readdir(`public/backups/${req.params.match_id}`, function (err, files) {
          //handling error
          if (err) {
            logger.error(err);
            return res.status(404).json({ message: "No backups found.", response: [] });;
          }
          //listing all files using forEach
          files.forEach(function (file) {
            fileArray.push(file)
          });
          res.json({ message: "Backups retrieved.", response: fileArray });
        });
        return;
      }
    } catch (err) {
      logger.error(err);
      res.status(500).json({ message: "API Error." });
    }
  }
);

async function getGameServer(match_id: string): Promise<GameServer> {
  let currentMatchInfo: string = "SELECT server_id FROM `match` WHERE id = ?";
  const matchServerId: RowDataPacket[] = await db.query(
    currentMatchInfo,
    [match_id]
  );
  let getServerSQL: string =
    "SELECT ip_string, port, rcon_password FROM game_server WHERE id=?";
  const serverRow: RowDataPacket[] = await db.query(getServerSQL, [
    matchServerId[0].server_id,
  ]);
  return new GameServer(
    serverRow[0].ip_string,
    serverRow[0].port,
    serverRow[0].rcon_password
  );
}

/**
 * @swagger
 *
 * /matches/:match_id/callbacks:
 *   post:
 *     description: >
 *       Sends the API's current event, backup and demo upload URLs to the game server of a running match.
 *       Needed when the API's address (server.apiURL) changed after the match was loaded, because MatchZy keeps
 *       the URLs it got with the match config.
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
 *         description: The URLs were sent.
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.post("/:match_id/callbacks", Utils.ensureAuthenticated, audited("match.update_callbacks"), async (req, res, next) => {
  try {
    const errMessage: AccessMessage | null = await Utils.getUserMatchAccess(req.params.match_id, req.user!, true);
    if (errMessage != null) {
      res.status(errMessage.status).json({ message: errMessage.message });
      return;
    }
    const matchRow: RowDataPacket[] = await db.query("SELECT api_key FROM `match` WHERE id = ?", [
      req.params.match_id
    ]);
    const serverUpdate: GameServer = await getGameServer(req.params.match_id);
    const response: string = await serverUpdate.setCvars(
      callbackCvars(matchRow[0].api_key, Boolean(config.get("server.uploadDemos")))
    );
    res.json({ message: "Panel address sent to the game server.", response });
  } catch (err) {
    if (err instanceof RconArgumentError) {
      res.status(412).json({ message: err.message });
      return;
    }
    next(err);
  }
});

/**
 * @swagger
 *
 * /matches/:match_id/control:
 *   post:
 *     description: >
 *       Admin match control over RCON. Body - action (start, skip_veto, toggle_knife, toggle_playout,
 *       toggle_whitelist, change_map + map, team_name + team (1|2)
 *       + name, say + message, cvar + cvar + value from the curated list). Owner or admin; every call is audited.
 *     produces:
 *       - application/json
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: "{ message, response } - response is the game server's reply"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       412:
 *         description: Unknown action or invalid argument.
 */
router.post(
  "/:match_id/control",
  Utils.ensureAuthenticated,
  audited("match.control", {
    detail: (req) => {
      const body = firstBody(req);
      const args = Object.entries(body)
        .filter(([key]) => key !== "action")
        .map(([key, value]) => `${key}=${String(value)}`);
      return [String(body.action ?? ""), ...args].join(" ");
    }
  }),
  async (req, res, next) => {
    try {
      const errMessage: AccessMessage | null = await Utils.getUserMatchAccess(req.params.match_id, req.user!, true);
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      }
      const body = firstBody(req);
      let command: string;
      try {
        command = controlCommand(body.action, body);
      } catch (err) {
        if (err instanceof RconArgumentError) {
          res.status(412).json({ message: err.message });
          return;
        }
        throw err;
      }
      if (process.env.NODE_ENV === "test") {
        res.json({ message: "Command checked (not sent in tests).", response: command });
        return;
      }
      const serverUpdate: GameServer = await getGameServer(req.params.match_id);
      const response: string = await serverUpdate.execute(command);
      res.json({ message: "Command sent.", response });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 *
 * /matches/:match_id/server/status:
 *   get:
 *     description: >
 *       Health of the match's game server - whether RCON answers and MatchZy's get5_status (gamestate, matchid,
 *       map, plugin version, ...). Owner or admin.
 *     produces:
 *       - application/json
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: "{ reachable, status }"
 */
router.get("/:match_id/server/status", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    const errMessage: AccessMessage | null = await Utils.getUserMatchAccess(req.params.match_id, req.user!, true);
    if (errMessage != null) {
      res.status(errMessage.status).json({ message: errMessage.message });
      return;
    }
    if (process.env.NODE_ENV === "test") {
      res.json({ reachable: false, status: null });
      return;
    }
    const serverUpdate: GameServer = await getGameServer(req.params.match_id);
    const reachable: boolean = await serverUpdate.isServerAlive();
    const status: unknown = reachable ? await serverUpdate.getMatchStatus().catch(() => null) : null;
    res.json({ reachable, status });
  } catch (err) {
    next(err);
  }
});

/** The public part of a match's server state (no addresses). */
const publicServerState = (row: RowDataPacket | null) =>
  row
    ? {
        state: row.state,
        reason: row.reason,
        checked_at: row.checked_at,
        last_seen: row.last_seen,
        gamestate: row.gamestate,
        server_matchid: row.server_matchid,
        interrupted_at: row.interrupted_at,
        dismissed: row.dismissed_at != null,
        resynced_at: row.resynced_at
      }
    : null;

/**
 * @swagger
 *
 * /matches/:match_id/server/state:
 *   get:
 *     description: >
 *       What the API's heartbeat (get5_status every 30 s) last saw for the match's game server. state is ok, offline
 *       (no RCON answer twice in a row) or interrupted (no match or another match loaded, e.g. after a restart).
 *       Public. null before the first check, or when the match is over.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: "{ server_state: { state, reason, checked_at, last_seen, gamestate, interrupted_at, dismissed, resynced_at } | null }"
 */
router.get("/:match_id/server/state", async (req, res, next) => {
  try {
    res.json({ server_state: publicServerState(await getServerState(req.params.match_id)) });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /matches/:match_id/server/check:
 *   post:
 *     description: >
 *       Checks the game server now and resyncs scores that differ (the "Resync from server" button). Owner or admin.
 *       A problem is only reported after two checks in a row, so one call can still answer ok.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: "{ message, server_state }"
 */
router.post(
  "/:match_id/server/check",
  Utils.ensureAuthenticated,
  audited("match.server_check"),
  async (req, res, next) => {
    try {
      const errMessage: AccessMessage | null = await Utils.getUserMatchAccess(req.params.match_id, req.user!, true);
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      }
      const row = await checkMatch(Number(req.params.match_id));
      res.json({ message: "Server checked.", server_state: publicServerState(row) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 *
 * /matches/:match_id/server/reload:
 *   post:
 *     description: >
 *       Loads the match onto its server again (matchzy_loadmatch_url) without touching the panel's stats, e.g. after
 *       the server restarted. MatchZy starts the series over; to continue from a round, restore a backup instead
 *       (a backup carries the whole match, so it works on a server with no match loaded). Owner or admin.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Loaded.
 *       502:
 *         description: MatchZy did not load the match.
 */
router.post(
  "/:match_id/server/reload",
  Utils.ensureAuthenticated,
  audited("match.server_reload"),
  async (req, res, next) => {
    try {
      const errMessage: AccessMessage | null = await Utils.getUserMatchAccess(req.params.match_id, req.user!, true);
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      }
      const rows: RowDataPacket[] = await db.query("SELECT api_key FROM `match` WHERE id = ?", [req.params.match_id]);
      const serverUpdate: GameServer = await getGameServer(req.params.match_id);
      const loaded: boolean = await serverUpdate.prepareGet5Match(
        Utils.apiUrl("/matches/" + req.params.match_id + "/config"),
        rows[0].api_key
      );
      if (!loaded && process.env.NODE_ENV !== "test") {
        res.status(502).json({ message: "MatchZy did not load the match. Check the game server's MatchZy log." });
        return;
      }
      await checkMatch(Number(req.params.match_id)).catch(() => null);
      res.json({ message: "Match loaded on the server again." });
    } catch (err) {
      if (err instanceof RconArgumentError) {
        res.status(412).json({ message: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * @swagger
 *
 * /matches/:match_id/server/dismiss:
 *   post:
 *     description: Hides the offline/interrupted warning until the server is fine and then fails again. Owner or admin.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: Dismissed.
 */
router.post(
  "/:match_id/server/dismiss",
  Utils.ensureAuthenticated,
  audited("match.server_dismiss"),
  async (req, res, next) => {
    try {
      const errMessage: AccessMessage | null = await Utils.getUserMatchAccess(req.params.match_id, req.user!, true);
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      }
      await dismissServerState(req.params.match_id);
      res.json({ message: "Warning dismissed." });
    } catch (err) {
      next(err);
    }
  }
);

const READY_CACHE_MS = 5000;
const readyCache = new Map<string, { at: number; body: unknown }>();

/**
 * @swagger
 *
 * /matches/:match_id/ready:
 *   get:
 *     description: >
 *       Whether each team is ready and how many of its players are connected (MatchZy's get5_status, which has no
 *       per-player ready state). Public; null while the match isn't running on a server. Cached for 5 seconds.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: "{ ready: { gamestate, team1: { ready, connected_clients }, team2: {...} } | null }"
 */
router.get("/:match_id/ready", async (req, res, next) => {
  try {
    const rows: RowDataPacket[] = await db.query(
      "SELECT id, server_id, end_time, cancelled FROM `match` WHERE id = ?",
      [req.params.match_id]
    );
    if (!rows.length) {
      res.status(404).json({ message: "Match not found." });
      return;
    }
    const match = rows[0];
    if (!match.server_id || match.end_time || match.cancelled || process.env.NODE_ENV === "test") {
      res.json({ ready: null });
      return;
    }
    const key = String(match.id);
    const cached = readyCache.get(key);
    if (cached && Date.now() - cached.at < READY_CACHE_MS) {
      res.json(cached.body);
      return;
    }
    let ready: unknown = null;
    try {
      const status = await (await getGameServer(key)).getMatchStatus();
      if (status && String(status.matchid) === key) {
        const team = (value: any) =>
          value ? { ready: Boolean(value.ready), connected_clients: Number(value.connected_clients) || 0 } : null;
        ready = { gamestate: String(status.gamestate ?? ""), team1: team(status.team1), team2: team(status.team2) };
      }
    } catch {
      // Unreachable server: shown as unknown.
    }
    const body = { ready };
    for (const [id, entry] of readyCache) if (Date.now() - entry.at > 60000) readyCache.delete(id);
    readyCache.set(key, { at: Date.now(), body });
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /matches/:match_id/server/players:
 *   get:
 *     description: >
 *       Players connected to the match's server, from CS2's `status` (userid, name, ping, state, bot; CS2 doesn't
 *       print Steam IDs there). Owner or admin.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: "{ reachable, players }"
 */
router.get("/:match_id/server/players", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    const errMessage: AccessMessage | null = await Utils.getUserMatchAccess(req.params.match_id, req.user!, true);
    if (errMessage != null) {
      res.status(errMessage.status).json({ message: errMessage.message });
      return;
    }
    if (process.env.NODE_ENV === "test") {
      res.json({ reachable: false, players: [] });
      return;
    }
    const serverUpdate: GameServer = await getGameServer(req.params.match_id);
    try {
      const output: string = await serverUpdate.sendRconCommand("status");
      res.json({ reachable: true, players: parseStatusPlayers(output) });
    } catch {
      res.json({ reachable: false, players: [] });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /matches/:match_id/server/kick:
 *   post:
 *     description: Kicks a connected player by the userid from /server/players (`kickid`). Owner or admin.
 *     tags:
 *       - matches
 *     responses:
 *       200:
 *         description: "{ message, response }"
 *       412:
 *         description: Invalid userid.
 */
router.post(
  "/:match_id/server/kick",
  Utils.ensureAuthenticated,
  audited("match.kick", {
    target: (req) => ({ type: "match", id: Number(req.params.match_id) || null }),
    detail: (req) => `${String(firstBody(req).userid ?? "")} ${String(firstBody(req).name ?? "")}`.trim()
  }),
  async (req, res, next) => {
    try {
      const errMessage: AccessMessage | null = await Utils.getUserMatchAccess(req.params.match_id, req.user!, true);
      if (errMessage != null) {
        res.status(errMessage.status).json({ message: errMessage.message });
        return;
      }
      const userid = Number(firstBody(req).userid);
      if (!Number.isInteger(userid) || userid < 0 || userid >= 65535) {
        res.status(412).json({ message: "Invalid player id." });
        return;
      }
      const serverUpdate: GameServer = await getGameServer(req.params.match_id);
      const response: string = await serverUpdate.sendRconCommand(`kickid ${userid}`);
      res.json({ message: "Player kicked.", response });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
