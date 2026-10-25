/**
 * @swagger
 * resourcePath: /servers
 * description: Express API router for game servers.
 */

import { Router } from "express";

const router = Router();

/** Whether the user plays in (or spectates) a match that is running on this server. */
async function playsOnServer(user: Express.User, serverId: number): Promise<boolean> {
  const steamId = (user as { steam_id?: string | null }).steam_id;
  if (!steamId) return false;
  const rows: RowDataPacket[] = await db.query(
    "SELECT m.id FROM `match` m WHERE m.server_id = ? AND m.end_time IS NULL AND (m.cancelled IS NULL OR m.cancelled = 0) " +
      "AND (EXISTS (SELECT 1 FROM team_auth_names ta WHERE ta.auth = ? AND ta.team_id IN (m.team1_id, m.team2_id)) " +
      "OR EXISTS (SELECT 1 FROM match_spectator ms WHERE ms.match_id = m.id AND ms.auth = ?)) LIMIT 1",
    [serverId, steamId, steamId]
  );
  return rows.length > 0;
}

/** Characters that are safe in sv_password and in a steam://connect/ip:port/password link. */
const JOIN_PASSWORD = /^[A-Za-z0-9_.\-!@*+=~]{1,64}$/;

/** The join password from a request: "" = none, undefined = not given, null = invalid. */
function joinPassword(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return "";
  return typeof value === "string" && JOIN_PASSWORD.test(value) ? value : null;
}

import {db} from "../services/db.js";

import GameServer from "../utility/serverrcon.js";

import Utils from "../utility/utils.js";
import { audited, firstBody } from "../utility/audit.js";
import { RowDataPacket } from "mysql2";
import { GameServerObject } from "../types/servers/GameServerObject.js";

/**
 * @swagger
 *
 * components:
 *   schemas:
 *    ServerData:
 *      type: object
 *      required:
 *        - server_id
 *        - ip_string
 *        - port
 *        - rcon_password
 *      properties:
 *        server_id:
 *          type: integer
 *          description: Unique Server ID.
 *        ip_string:
 *          type: string
 *          description: The IP or host name of the server.
 *        port:
 *          type: integer
 *          description: Port of the server.
 *        display_name:
 *          type: string
 *          description: Visible name of the server.
 *        rcon_password:
 *          type: string
 *          description: RCON password of the server.
 *        public_server:
 *          type: boolean
 *          description: Whether a server can be publically used.
 *        flag:
 *          type: string
 *          description: Two character code representing a flag, like teams.
 *        gotv_port:
 *          type: integer
 *          description: The optional GOTV port for a server.
 *
 *   responses:
 *     NoServerData:
 *       description: No server data was provided.
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SimpleResponse'
 */

/**
 * @swagger
 *
 * /servers/:
 *   get:
 *     description: Get all servers from the application. RCON passwords, too, if an admin.
 *     produces:
 *       - application/json
 *     tags:
 *       - servers
 *     responses:
 *       200:
 *         description: All visible server information
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ServerData'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    // Check if admin or super admin, adjust by providing rcon password or not.
    let sql: string;
    if (req.user && Utils.superAdminCheck(req.user)) {
      sql =
        "SELECT gs.id, gs.in_use, gs.practice_mode, gs.last_seen, gs.last_checked, gs.last_gamestate, gs.ip_string, gs.port, gs.display_name, gs.public_server, usr.name, usr.id as user_id, gs.flag, gs.gotv_port, gs.join_password FROM game_server gs, user usr WHERE usr.id = gs.user_id";
    } else if (req.user && Utils.adminCheck(req.user)) {
      sql =
        "SELECT gs.id, gs.in_use, gs.practice_mode, gs.last_seen, gs.last_checked, gs.last_gamestate, gs.display_name, gs.ip_string, gs.port, gs.public_server, usr.name, usr.id as user_id, gs.flag, gs.gotv_port, gs.join_password FROM game_server gs, user usr WHERE usr.id = gs.user_id";
    } else {
      sql =
        "SELECT gs.id, gs.in_use, gs.practice_mode, gs.last_seen, gs.last_checked, gs.last_gamestate, gs.display_name, usr.name, gs.public_server, gs.flag FROM game_server gs, user usr WHERE gs.public_server=1 AND usr.id = gs.user_id";
    }
    let servers: RowDataPacket[] = await db.query(sql);
    res.json({ servers });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /servers/publiccount:
 *   get:
 *     description: Get a count of all public servers available.
 *     produces:
 *       - application/json
 *     tags:
 *       - servers
 *     responses:
 *       200:
 *         description: An integrer representing the amount of publically usable servers.
 *         content:
 *           application/json:
 *             schema:
 *               type: integer
 *               description: Count of all public servers.
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
 router.get("/publiccount", async (req, res, next) => {
  try {
    let sql: string = 
      "SELECT COUNT(*) as cnt FROM game_server gs WHERE gs.public_server=1";
    let servers: RowDataPacket[] = await db.query(sql);
    res.json({ "servers": servers[0].cnt });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /servers/available:
 *   get:
 *     description: Get all available servers depending on access level.
 *     produces:
 *       - application/json
 *     tags:
 *       - servers
 *     responses:
 *       200:
 *         description: All visible server information
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ServerData'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/available", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    // Only admins create matches, so only they need the free servers (and their addresses).
    if (!Utils.adminCheck(req.user!)) {
      res.status(403).json({ message: "Only admins can list free servers." });
      return;
    }
    let sql: string;
    let servers: RowDataPacket[];
    if (req.user && Utils.superAdminCheck(req.user)) {
      sql =
        "SELECT gs.id, gs.ip_string, gs.port, gs.display_name, gs.public_server, usr.name, usr.id as user_id, gs.flag, gs.gotv_port, gs.join_password FROM game_server gs, user usr WHERE usr.id = gs.user_id AND gs.in_use=0";
    } else if (req.user && Utils.adminCheck(req.user)) {
      sql =
        "SELECT gs.id, gs.display_name, gs.ip_string, gs.port, gs.public_server, usr.name, usr.id as user_id, gs.flag, gs.gotv_port, gs.join_password FROM game_server gs, user usr WHERE usr.id = gs.user_id AND gs.in_use=0";
    } else if (req.user) {
      sql =
        "SELECT gs.id, gs.display_name, gs.ip_string, gs.port, gs.public_server, usr.name, usr.id as user_id, gs.flag, gs.gotv_port, IF(gs.user_id = ?, gs.join_password, NULL) AS join_password FROM game_server gs, user usr WHERE usr.id = gs.user_id AND (gs.public_server=1 OR gs.user_id = ?) AND gs.in_use=0";
    } else {
      sql =
        "SELECT gs.id, gs.display_name, usr.name, usr.id as user_id, gs.flag FROM game_server gs, user usr WHERE gs.public_server=1 AND usr.id = gs.user_id AND gs.in_use=0";
    }
    if (req.user) servers = await db.query(sql, [req.user.id, req.user.id]);
    else servers = await db.query(sql);
    res.json({ servers });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /servers/myservers:
 *   get:
 *     description: Set of servers from the logged in user.
 *     produces:
 *       - application/json
 *     tags:
 *       - servers
 *     responses:
 *       200:
 *         description: Server information
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ServerData'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/myservers", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    // Check if admin, if they are use this query.
    let sql: string =
      "SELECT gs.id, gs.in_use, gs.practice_mode, gs.last_seen, gs.last_checked, gs.last_gamestate, gs.ip_string, gs.port, gs.display_name, gs.public_server, usr.name, usr.id as user_id, gs.flag, gs.gotv_port, gs.join_password FROM game_server gs, user usr WHERE usr.id = gs.user_id AND usr.id=?";
    let servers: RowDataPacket[] = await db.query(sql, [req.user?.id]);
    res.json({ servers });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /servers/:server_id:
 *   get:
 *     description: Returns a provided server info.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: server_id
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - servers
 *     responses:
 *       200:
 *         description: Specific server information
 *         content:
 *           application/json:
 *             schema:
 *                type: object
 *                properties:
 *                  server:
 *                    $ref: '#/components/schemas/ServerData'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:server_id", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    let serverID: number = parseInt(req.params.server_id);
    let sql: string;
    let server: RowDataPacket[];
    if (req.user && Utils.superAdminCheck(req.user)) {
      sql =
        "SELECT gs.id, gs.in_use, gs.practice_mode, gs.last_seen, gs.last_checked, gs.last_gamestate, gs.ip_string, gs.port, gs.display_name, gs.public_server, usr.name, gs.flag, gs.gotv_port, gs.join_password FROM game_server gs, user usr WHERE usr.id = gs.user_id AND gs.id = ?";
      server = await db.query(sql, [serverID]);
    } else {
      sql =
        "SELECT gs.id, gs.in_use, gs.practice_mode, gs.last_seen, gs.last_checked, gs.last_gamestate, gs.ip_string, gs.port, gs.display_name, gs.public_server, usr.name, gs.flag, gs.gotv_port, gs.join_password FROM game_server gs, user usr WHERE usr.id = gs.user_id AND gs.id = ? AND usr.id = ?";
      server = await db.query(sql, [serverID, req.user?.id]);
    }
    if (server.length < 1) {
      // Someone else's server: the address (to connect) only for admins, or a player or spectator of a match
      // that is running on it. Everyone else gets nothing, not even whether it exists.
      const exists: RowDataPacket[] = await db.query("SELECT id FROM game_server WHERE id = ?", [serverID]);
      if (!exists.length) {
        res.status(404).json({ message: "Server not found." });
        return;
      }
      if (!Utils.adminCheck(req.user!) && !(await playsOnServer(req.user!, serverID))) {
        res.status(403).json({ message: "User is not authorized to see this server." });
        return;
      }
      sql = "SELECT gs.id, gs.ip_string, gs.port, gs.gotv_port, gs.display_name FROM game_server gs WHERE gs.id = ?";
      server = await db.query(sql, [serverID]);
      res.json({ server: JSON.parse(JSON.stringify(server[0])) });
    } else {
      server = JSON.parse(JSON.stringify(server[0]));
      res.json({ server });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /servers/:server_id/rcon:
 *   get:
 *     description: Reveals the RCON password of a server. Only for the server owner or a super admin.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: server_id
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - servers
 *     responses:
 *       200:
 *         description: The RCON password.
 *         content:
 *           application/json:
 *             schema:
 *                type: object
 *                properties:
 *                  rcon_password:
 *                    type: string
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get("/:server_id/rcon", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    const server: RowDataPacket[] = await db.query(
      "SELECT user_id, rcon_password FROM game_server WHERE id = ?",
      [parseInt(req.params.server_id)]
    );
    if (!server.length) {
      res.status(404).json({ message: "Server not found." });
      return;
    }
    if (server[0].user_id != req.user!.id && !Utils.superAdminCheck(req.user!)) {
      res.status(403).json({ message: "User is not authorized to perform action." });
      return;
    }
    res.json({ rcon_password: Utils.decrypt(server[0].rcon_password) });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /servers/:server_id:/status:
 *   get:
 *     description: Returns a provided server status.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: server_id
 *         required: true
 *         schema:
 *            type: integer
 *     tags:
 *       - servers
 *     responses:
 *       200:
 *         description: Server info, if available.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get(
  "/:server_id/status",
  Utils.ensureAuthenticated,
  async (req, res, next) => {
    try {
      let userCheckSql: string =
        "SELECT user_id, ip_string, port, rcon_password FROM game_server WHERE id=?";
      let userId: number = req.user!.id;
      let serverInfo: RowDataPacket[] = await db.query(userCheckSql, [req.params.server_id]);
      if (!serverInfo.length) {
        res.status(404).json({ message: "Server does not exist." });
        return;
      } else if (
        req.user && 
        serverInfo[0].user_id != userId &&
        !Utils.superAdminCheck(req.user)
      ) {
        res.status(403).json({
          message: "User is not authorized to perform action.",
        });
        return;
      } else {
        let ourServer: GameServer = new GameServer(
          serverInfo[0].ip_string,
          serverInfo[0].port,
          serverInfo[0].rcon_password
        );
        let serverUp: boolean = await ourServer.isServerAlive();
        let serverUpToDate: boolean = await ourServer.isServerUpToDate();
        if (!serverUp) {
          res.status(408).json({
            message:
              "Server did not respond in 2500 ms. Please check if server is online and password is correct.",
          });
        } else if (!serverUpToDate) {
          res.status(412).json({
            message:
              "Server is not up to date - please update your game server instance.",
          });
        } else {
          res.json({ message: "Server is alive and up to date." });
        }
      }
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 *
 * /servers/:server_id/practice:
 *   post:
 *     description: >
 *       Starts (css_prac) or stops (css_exitprac) MatchZy practice mode. Body - action ("start" or "stop"). Starting
 *       needs a free server and marks it in use, so no match is loaded onto it; stopping frees it. Owner, super admin,
 *       or an admin on a public server.
 *     tags:
 *       - servers
 *     responses:
 *       200:
 *         description: "{ message, response } - response is the server's RCON reply"
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         description: The server is in use (start) or not in practice mode (stop).
 */
router.post(
  "/:server_id/practice",
  Utils.ensureAuthenticated,
  audited("server.practice", {
    target: (req) => ({ type: "server", id: Number(req.params.server_id) || null }),
    detail: (req) => String(firstBody(req).action ?? "")
  }),
  async (req, res, next) => {
    try {
      const action = firstBody(req).action;
      if (action !== "start" && action !== "stop") {
        res.status(412).json({ message: 'Action must be "start" or "stop".' });
        return;
      }
      const rows: RowDataPacket[] = await db.query(
        "SELECT id, user_id, ip_string, port, rcon_password, public_server, in_use, practice_mode FROM game_server WHERE id = ?",
        [parseInt(req.params.server_id)]
      );
      if (!rows.length) {
        res.status(404).json({ message: "Server not found." });
        return;
      }
      const server = rows[0];
      const allowed =
        server.user_id == req.user!.id ||
        Utils.superAdminCheck(req.user!) ||
        (Boolean(server.public_server) && Utils.adminCheck(req.user!));
      if (!allowed) {
        res.status(403).json({ message: "User is not authorized to perform action." });
        return;
      }
      const gameServer = new GameServer(server.ip_string, server.port, server.rcon_password);
      if (action === "start") {
        // Claim the server first, so a match can't be loaded onto it in between.
        const claim: any = await db.query(
          "UPDATE game_server SET in_use = 1, practice_mode = 1 WHERE id = ? AND in_use = 0",
          [server.id]
        );
        if (!claim.affectedRows) {
          res.status(409).json({ message: "The server is in use." });
          return;
        }
        try {
          const response = await gameServer.sendRconCommand("css_prac");
          res.json({ message: "Practice mode started.", response });
        } catch {
          await db.query("UPDATE game_server SET in_use = 0, practice_mode = 0 WHERE id = ?", [server.id]);
          res.status(502).json({ message: "The server did not respond. Check that it is online and the RCON password is correct." });
        }
        return;
      }
      if (!server.practice_mode) {
        res.status(409).json({ message: "The server is not in practice mode." });
        return;
      }
      let response = "";
      try {
        response = await gameServer.sendRconCommand("css_exitprac");
      } catch {
        // Freed anyway: an offline server is not practicing any more.
        response = "The server did not respond.";
      }
      await db.query("UPDATE game_server SET in_use = 0, practice_mode = 0 WHERE id = ?", [server.id]);
      res.json({ message: "Practice mode stopped.", response });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 *
 * /servers:
 *   post:
 *     description: Creates a new server to use.
 *     produces:
 *       - application/json
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: array
 *            items:
 *              $ref: '#/components/schemas/ServerData'
 *     tags:
 *       - servers
 *     responses:
 *       200:
 *         description: Server created successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.post("/", Utils.ensureAuthenticated, audited("server.create", { target: (req, body) => ({ type: "server", id: body?.id ?? null }), detail: (req) => `${firstBody(req).display_name ?? ""} ${firstBody(req).ip_string ?? ""}:${firstBody(req).port ?? ""}` }), async (req, res, next) => {
  try {
    let insertServer: RowDataPacket[];
    let userId: number = req.user!.id;
    let ipString: string = req.body[0].ip_string;
    let port: number = req.body[0].port;
    let displayName: string = req.body[0].display_name;
    let rconPass: string = Utils.encrypt(req.body[0].rcon_password)!;
    let publicServer: number = req.body[0].public_server;
    let flagCode: string = req.body[0].flag;
    let gotvPort: number = req.body[0].gotv_port;
    const join = joinPassword(req.body[0].join_password);
    if (join === null) {
      res.status(412).json({ message: "The join password may use letters, digits and _ . - ! @ * + = ~ (up to 64)." });
      return;
    }
    let sql: string =
      "INSERT INTO game_server (user_id, ip_string, port, rcon_password, display_name, public_server, flag, gotv_port, join_password) VALUES (?,?,?,?,?,?,?,?,?)";
    insertServer = await db.query(sql, [
      userId,
      ipString,
      port,
      rconPass,
      displayName,
      publicServer,
      flagCode,
      gotvPort,
      join || null,
    ]);
    let ourServer: GameServer = new GameServer(
      req.body[0].ip_string,
      req.body[0].port,
      rconPass
    );
    let serverUp: boolean = await ourServer.isServerAlive();
    if (!serverUp) {
      res.json({
        message:
          "Game Server did not respond in time. However, we have still inserted the server successfully.",
      });
    } else {
      res.json({
        message: "Game server inserted successfully!",
        //@ts-ignore
        id: insertServer.insertId,
      });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /servers:
 *   put:
 *     description: Updates an existing server.
 *     produces:
 *       - application/json
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: array
 *            items:
 *              $ref: '#/components/schemas/ServerData'
 *     tags:
 *       - servers
 *     responses:
 *       200:
 *         description: Server updated successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       412:
 *         $ref: '#/components/responses/NoServerData'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.put("/", Utils.ensureAuthenticated, audited("server.update", { target: (req) => ({ type: "server", id: Number(firstBody(req).server_id) || null }), detail: (req) => Object.keys(firstBody(req)).filter((k) => k !== "server_id" && k !== "rcon_password").join(", ") + (firstBody(req).rcon_password ? ", rcon password" : "") }), async (req, res, next) => {
  try {
    let userCheckSql: string = "SELECT user_id FROM game_server WHERE id = ?";
    let userId: number = req.user!.id;
    const checkUser: RowDataPacket[] = await db.query(userCheckSql, [req.body[0].server_id]);
    if (checkUser[0] == null) {
      res.status(404).json({ message: "Server does not exist." });
      return;
    } else if (
      req.user &&
      checkUser[0].user_id != userId &&
      !Utils.superAdminCheck(req.user)
    ) {
      res.status(403).json({
        message: "User is not authorized to perform action.",
      });
      return;
    } else {
      let serverId: number = req.body[0].server_id;
      const join = joinPassword(req.body[0].join_password);
      if (join === null) {
        res.status(412).json({ message: "The join password may use letters, digits and _ . - ! @ * + = ~ (up to 64)." });
        return;
      }
      let updateStmt: GameServerObject = {
        ip_string: req.body[0].ip_string,
        port: req.body[0].port,
        display_name: req.body[0].display_name,
        // RCON passwords are never sent to the client, so an empty field means "keep the current one".
        rcon_password: !req.body[0].rcon_password
          ? null
          : Utils.encrypt(req.body[0].rcon_password),
        public_server: req.body[0].public_server,
        user_id: req.body[0].user_id,
        flag: req.body[0].flag,
        gotv_port: req.body[0].gotv_port,
        // "" clears it (stored as an empty string, read as none).
        join_password: join,
      };
      // Remove any unwanted nulls.
      updateStmt = await db.buildUpdateStatement(updateStmt);
      if (Object.keys(updateStmt).length === 0) {
        res.status(412).json({
          message: "No update data has been provided.",
        });
        return;
      }
      let sql: string = "UPDATE game_server SET ? WHERE id = ?";
      let updatedServer: RowDataPacket[];
      let serveInfo: RowDataPacket[];
      updatedServer = await db.query(sql, [updateStmt, serverId]);
      //@ts-ignore
      if (updatedServer.affectedRows > 0) {
        // Get all server info
        sql =
          "SELECT ip_string, port, rcon_password FROM game_server WHERE id = ?";
        serveInfo = await db.query(sql, [serverId]);
        let ourServer: GameServer = new GameServer(
          req.body[0].ip_string == null
            ? serveInfo[0].ip_string
            : req.body[0].ip_string,
          req.body[0].port == null ? serveInfo[0].port : req.body[0].port,
          !req.body[0].rcon_password
            ? serveInfo[0].rcon_password
            : Utils.encrypt(req.body[0].rcon_password)
        );
        let serverUp: boolean = await ourServer.isServerAlive();
        if (!serverUp) {
          res.json({
            message:
              "Game Server did not respond in time. However, we have still updated the server successfully.",
          });
        } else {
          res.json({ message: "Game server updated successfully!" });
        }
      } else throw "ERROR - Game server not updated.";
    }
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /servers:
 *   delete:
 *     description: Delete a server object.
 *     produces:
 *       - application/json
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: object
 *            properties:
 *              server_id:
 *                type: integer
 *                required: true
 *     tags:
 *       - servers
 *     responses:
 *       200:
 *         description: Server deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.delete("/", Utils.ensureAuthenticated, audited("server.delete", { target: (req) => ({ type: "server", id: Number(firstBody(req).server_id) || null }) }), async (req, res, next) => {
  try {
    let userCheckSql: string = "SELECT user_id, in_use FROM game_server WHERE id = ?";
    const checkUser: RowDataPacket[] = await db.query(userCheckSql, [req.body[0].server_id]);
    if (checkUser[0] == null) {
      res.status(404).json({ message: "Server does not exist." });
      return;
    } else if (
      req.user &&
      checkUser[0].user_id != req.user.id &&
      !Utils.superAdminCheck(req.user)
    ) {
      res.status(403).json({
        message: "User is not authorized to perform action.",
      });
      return;
    } else if (checkUser[0].in_use == 1) {
      res.status(403).json({
        message: "Please cancel the match before deleting this server.",
      });
    } else {
      let userId: number = req.user!.id;
      let serverId: number = parseInt(req.body[0].server_id);
      let sql: string;
      let delRows: RowDataPacket[];
      if (req.user && Utils.superAdminCheck(req.user)) {
        sql = "DELETE FROM game_server WHERE id = ?";
        delRows = await db.query(sql, [serverId]);
      } else {
        sql = "DELETE FROM game_server WHERE id = ? AND user_id = ?";
        delRows = await db.query(sql, [serverId, userId]);
      }
      //@ts-ignore
      if (delRows.affectedRows > 0)
        res.json({ message: "Game server deleted successfully!" });
      else {
        throw "Error! Unable to delete record.";
      }
    }
  } catch (err) {
    next(err);
  }
});

export default router;
