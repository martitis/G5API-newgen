/** Express API router for teams in get5.
 * @module routes/teams
 * @requires express
 * @requires db
 */

/**
 * @swagger
 * resourcePath: /teams
 * description: Express API router for teams.
 */
import { Router } from "express";

const router = Router();

import {db} from "../services/db.js";

import Utils from "../utility/utils.js";
import { audited, firstBody } from "../utility/audit.js";

import { generate } from "randomstring";

import { unlink } from "fs";
import { writeFile } from "fs/promises";

import fetch from "node-fetch";
import { importParticipants, type ChallongeParticipant } from "../services/challonge.js";
import { RowDataPacket } from "mysql2";
import { TeamData } from "../types/teams/TeamData.js";
import { AuthData } from "../types/teams/AuthData.js";

import logger from "../utility/logger.js";
/**
 * @swagger
 *
 * components:
 *   schemas:
 *     AuthObject:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Name that the user wishes to be called. Can be left null and will use Steam name.
 *         captain:
 *           type: boolean
 *           description: Boolean value representing if a user is a team captain or not.
 *         coach:
 *           type: boolean
 *           description: Boolean value representing if a user is a coach for the team or not.
 *
 *     TeamData:
 *      type: object
 *      required:
 *        - team_id
 *      properties:
 *        team_id:
 *          type: integer
 *          description: The unique ID of a team.
 *        name:
 *          type: string
 *          description: The name of the team.
 *          required: true
 *        flag:
 *          type: string
 *          description: Country code flag used in game. See https://steamcommunity.com/sharedfiles/filedetails/?id=719079703
 *          required: false
 *        logo:
 *          type: string
 *          format: byte
 *          description: A base64 png or svg to save to disk.
 *          required: false
 *        auth_name:
 *          type: object
 *          additionalProperties:
 *            $ref: "#/components/schemas/AuthObject"
 *
 *        tag:
 *          type: string
 *          description: A string with a shorthand tag for a team.
 *          required: false
 *   responses:
 *     NoTeamData:
 *       description: No team data was provided.
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SimpleResponse'
 */

/**
 * @swagger
 *
 * /teams/:
 *   get:
 *     description: Get all teams registered on the panel.
 *     produces:
 *       - application/json
 *     tags:
 *       - teams
 *     responses:
 *       200:
 *         description: All teams within the system.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/TeamData'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/", async (req, res, next) => {
  try {
    const sql: string =
      "SELECT usr.name as owner, t.id, t.user_id, t.name, t.flag, t.logo, t.tag, t.public_team, " +
      "CONCAT('{', GROUP_CONCAT( DISTINCT CONCAT('\"',ta.auth, '\"', ': " +
      "{ \"name\": ', CAST(JSON_QUOTE(ta.name) AS CHAR CHARACTER SET utf8mb4), ', \"captain\": ', ta.captain, ', \"coach\": ', ta.coach, '}') ORDER BY ta.captain desc, ta.id  SEPARATOR ', '), '}') as auth_name " +
      "FROM team t LEFT OUTER JOIN team_auth_names ta " +
      "ON t.id = ta.team_id JOIN user usr " + 
      "ON usr.id = t.user_id " +
      // Teams generated for PUG queues aren't listed.
      "WHERE t.is_pug = 0 " +
      "GROUP BY t.id " +
      "ORDER BY t.id DESC";
    const teams: RowDataPacket[] = await db.query(sql);
    // Check this and return a 404 if we don't exist.
    if (teams[0] == null) {
      res.status(404).json({ message: "No teams found in the system." });
      return;
    }
    for (let row in teams) {
      if (teams[row].auth_name != null) {
        teams[row].auth_name = JSON.parse(teams[row].auth_name);
        teams[row].auth_name = await getTeamImages(teams[row].auth_name, false);
      }
    }
    res.json({ teams });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /teams/myteams:
 *   get:
 *     description: Set of teams from the logged in user.
 *     produces:
 *       - application/json
 *     tags:
 *       - teams
 *     responses:
 *       200:
 *         description: Set of teams from the logged in user within the system.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/TeamData'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/myteams", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    const sql: string =
      "SELECT usr.name as owner, t.id, t.user_id, t.name, t.flag, t.logo, t.tag, t.public_team, " +
      "CONCAT('{', GROUP_CONCAT( DISTINCT CONCAT('\"',ta.auth, '\"', ': " +
      "{ \"name\": ', CAST(JSON_QUOTE(ta.name) AS CHAR CHARACTER SET utf8mb4), ', \"captain\": ', ta.captain, ', \"coach\": ', ta.coach, '}') ORDER BY ta.captain desc, ta.id  SEPARATOR ', '), '}') as auth_name " +
      "FROM team t LEFT OUTER JOIN team_auth_names ta " +
      "ON t.id = ta.team_id  JOIN user usr " + 
      "ON usr.id = t.user_id " +
      "WHERE t.user_id = ? AND t.is_pug = 0 " +
      "GROUP BY t.id " + 
      "ORDER BY t.id DESC";
    const teams: RowDataPacket[] = await db.query(sql, [req.user?.id]);
    // Check this and return a 404 if we don't exist.
    if (teams[0] == null) {
      res.status(404).json({ message: "No teams found for " + req.user?.name });
      return;
    }
    for (let row in teams) {
      if (teams[row].auth_name != null) {
        teams[row].auth_name = JSON.parse(teams[row].auth_name);
        teams[row].auth_name = await getTeamImages(teams[row].auth_name, false);
      }
    }
    res.json({ teams });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /teams/:team_id:
 *   get:
 *     description: Returns a provided teams info.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: team_id
 *         required: true
 *         schema:
 *            type: integer
 *     tags:
 *       - teams
 *     responses:
 *       200:
 *         description: Team info
 *         content:
 *           application/json:
 *             schema:
 *                type: object
 *                properties:
 *                  team:
 *                    $ref: '#/components/schemas/TeamData'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:team_id", async (req, res, next) => {
  try {
    let teamID: number = parseInt(req.params.team_id);
    let sql: string =
      "SELECT usr.name as owner, t.id, t.user_id, t.name, t.flag, t.logo, t.tag, t.public_team, " +
      "CONCAT('{', GROUP_CONCAT( DISTINCT CONCAT('\"',ta.auth, '\"', ': " +
      "{ \"name\": ', CAST(JSON_QUOTE(ta.name) AS CHAR CHARACTER SET utf8mb4), ', \"captain\": ', ta.captain, ', \"coach\": ', ta.coach, '}') ORDER BY ta.captain desc, ta.id  SEPARATOR ', '), '}') as auth_name " +
      "FROM team t LEFT OUTER JOIN team_auth_names ta " +
      "ON t.id = ta.team_id LEFT JOIN user usr ON usr.id = t.user_id " +
      "WHERE t.id = ? " +
      "GROUP BY t.id";
    let team: RowDataPacket[] = await db.query(sql, [teamID]);
    if (team[0] == null) {
      res.status(404).json({ message: "No team found for id " + teamID });
      return;
    }

    // If we're an empty set, try just getting the team basic info.
    if (team[0].auth_name != null) {
      team[0].auth_name = JSON.parse(team[0].auth_name);
      team[0].auth_name = await getTeamImages(team[0].auth_name);
    }
    team = JSON.parse(JSON.stringify(team[0]));
    res.json({ team });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /teams/:team_id/basic:
 *   get:
 *     description: Returns a provided teams top-level info, no team names/steamid returned..
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: team_id
 *         required: true
 *         schema:
 *            type: integer
 *     tags:
 *       - teams
 *     responses:
 *       200:
 *         description: Team info
 *         content:
 *           application/json:
 *             schema:
 *                type: object
 *                properties:
 *                  team:
 *                    $ref: '#/components/schemas/TeamData'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:team_id/basic", async (req, res, next) => {
  try {
    let teamID: number = parseInt(req.params.team_id);
    let sql: string =
      "SELECT t.id, t.user_id, t.name, t.flag, t.logo, t.tag, t.public_team, '' as auth_name " +
      "FROM team t WHERE t.id = ?";
    let team: RowDataPacket[] = await db.query(sql, [teamID]);
    // Oddly enough, if a team doesn't exist, it still returns null!
    // Check this and return a 404 if we don't exist.
    if (team[0] == null) {
      res.status(404).json({ message: "No team found for id " + teamID });
      return;
    }
    team = JSON.parse(JSON.stringify(team[0]));
    res.json({ team });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /teams:
 *   post:
 *     description: Creates a new team to use.
 *     produces:
 *       - application/json
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: array
 *            items:
 *              $ref: '#/components/schemas/TeamData'
 *     tags:
 *       - teams
 *     responses:
 *       200:
 *         description: Team created successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.post("/", Utils.ensureAuthenticated, audited("team.create", { target: (req, body) => ({ type: "team", id: body?.id ?? null }), detail: (req) => String(firstBody(req).name ?? "") }), async (req, res, next) => {
  try {
    let userID: number = req.user!.id;
    let teamName: string = req.body[0].name;
    let flag: string = req.body[0].flag;
    let logo: string = req.body[0].logo_file;
    let logoName: string | null = null;
    let tag: string = req.body[0].tag;
    let public_team: number = req.body[0].public_team;
    let teamID: number | null = null;
    // Validate every member before writing anything.
    const auths = await resolveTeamAuths(req.body[0].auth_name);
    if (typeof auths === "string") {
      res.status(412).json({ message: auths });
      return;
    }
    if (logo) {
      // Generate a 5 character logo "name".
      logoName = generate({
        length: 5,
        charset: "alphanumeric",
      });
      const logoError = await saveLogo(logo, logoName);
      if (logoError) {
        res.status(412).json({ message: logoError });
        return;
      }
    }
    let newTeam: Array<TeamData> = [
      {
        user_id: userID,
        name: teamName,
        flag: flag,
        logo: logoName,
        tag: tag,
        public_team: public_team,
      },
    ];
    let sql: string =
      "INSERT INTO team (user_id, name, flag, logo, tag, public_team) VALUES ?";

    const insertTeam: RowDataPacket[] = await db.query(sql, [
      newTeam.map((item) => [
        item.user_id,
        item.name,
        item.flag,
        item.logo,
        item.tag,
        item.public_team,
      ]),
    ]);
    //@ts-ignore
    teamID = insertTeam.insertId;
    sql =
      "INSERT INTO team_auth_names (team_id, auth, name, captain, coach) VALUES (?, ?, ?, ?, ?)";
    for (const auth of auths) {
      await db.query(sql, [
        teamID,
        auth.steamId,
        auth.name,
        auth.captain,
        auth.coach
      ]);
    }
    res.json({ message: "Team successfully inserted.", id: teamID });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /teams:
 *   put:
 *     description: Creates a new team to use.
 *     produces:
 *       - application/json
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: array
 *            items:
 *              $ref: '#/components/schemas/TeamData'
 *     tags:
 *       - teams
 *     responses:
 *       200:
 *         description: Team updated successfully.
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
 *         $ref: '#/components/responses/NoTeamData'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.put("/", Utils.ensureAuthenticated, audited("team.update", { target: (req) => ({ type: "team", id: Number(firstBody(req).id) || null }), detail: (req) => `${Object.keys(firstBody(req).auth_name ?? {}).length} players sent` }), async (req, res, next) => {
  try {
    let checkUserSql: string = "SELECT * FROM team WHERE id = ?";
    const checkUser: RowDataPacket[] = await db.query(checkUserSql, [req.body[0]?.id]);
    if (checkUser[0] == null) {
      res.status(404).json({ message: "Team does not exist." });
      return;
    } else if (
      checkUser[0].user_id != req.user!.id &&
      !Utils.adminCheck(req.user!)
    ) {
      res
        .status(403)
        .json({ message: "User is not authorized to perform action." });
      return;
    }
    let teamID: number = req.body[0].id;
    let teamName: string = req.body[0].name;
    let teamFlag: string = req.body[0].flag;
    let teamLogo: string = req.body[0].logo_file;
    let logoName: string | null = null;
    let teamTag: string = req.body[0].tag;
    let publicTeam: number = req.body[0].public_team;
    let userId: number = req.body[0].user_id;
    // Validate every member before writing anything.
    const teamAuths = await resolveTeamAuths(req.body[0].auth_name);
    if (typeof teamAuths === "string") {
      res.status(412).json({ message: teamAuths });
      return;
    }
    let updateTeam: TeamData = {
      user_id: userId,
      name: teamName,
      flag: teamFlag,
      logo: logoName,
      tag: teamTag,
      public_team: publicTeam,
      id: teamID,
    };
    if (teamLogo) {
      // Overwrite the current file.
      if (checkUser[0].logo == null) {
        logoName = generate({
          length: 5,
          charset: "alphanumeric",
        });
      } else {
        logoName = checkUser[0].logo;
      }
      const logoError = await saveLogo(teamLogo, logoName!);
      if (logoError) {
        res.status(412).json({ message: logoError });
        return;
      }
      updateTeam.logo = logoName;
    }
    updateTeam = await db.buildUpdateStatement(updateTeam) as TeamData;
    if (Object.keys(updateTeam).length === 0) {
      res.status(412).json({ message: "No update data has been provided." });
      return;
    }
    let sql: string = "UPDATE team SET ? WHERE id=?";
    await db.query(sql, [updateTeam, teamID]);
    sql =
      "UPDATE team_auth_names SET name = ?, captain = ?, coach = ? WHERE auth = ? AND team_id = ?";
    for (const auth of teamAuths) {
      let updateTeamAuth: RowDataPacket[] = await db.query(sql, [
        auth.name,
        auth.captain,
        auth.coach,
        auth.steamId,
        teamID
      ]);
      //@ts-ignore
      if (updateTeamAuth.affectedRows < 1) {
        // Insert a new auth if it doesn't exist. Technically "updating a team".
        let insertSql: string =
          "INSERT INTO team_auth_names (team_id, auth, name, captain, coach) VALUES (?, ?, ?, ?, ?)";
        await db.query(insertSql, [
          teamID,
          auth.steamId,
          auth.name,
          auth.captain,
          auth.coach
        ]);
      }
    }
    res.json({ message: "Team successfully updated" });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /teams:
 *   delete:
 *     description: Delete a team object if there is no map stats associated with it. Optionally deletes a team member from a team, if a steam ID is provided.
 *     produces:
 *       - application/json
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: object
 *            properties:
 *              team_id:
 *                type: integer
 *                required: true
 *              steam_id:
 *                type: string
 *                required: false
 *     tags:
 *       - teams
 *     responses:
 *       200:
 *         description: Team deleted
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
router.delete("/", Utils.ensureAuthenticated, audited("team.delete", { target: (req) => ({ type: "team", id: Number(firstBody(req).team_id) || null }), detail: (req) => (firstBody(req).steam_id ? `player ${firstBody(req).steam_id}` : "team") }), async (req, res, next) => {
  try {
    let teamID: number = req.body[0]?.team_id;
    let checkUserSql: string = "SELECT * FROM team WHERE id = ?";
    const checkUser: RowDataPacket[] = await db.query(checkUserSql, [teamID]);
    if (checkUser[0] == null) {
      res.status(404).json({ message: "Team does not exist." });
      return;
    } else if (
      checkUser[0].user_id != req.user!.id &&
      !Utils.adminCheck(req.user!)
    ) {
      res
        .status(403)
        .json({ message: "User is not authorized to perform action." });
      return;
    } else if (req.body[0].steam_id != null) {
      let deleteSql: string =
        "DELETE FROM team_auth_names WHERE auth = ? AND team_id = ?";
      await db.query(deleteSql, [req.body[0].steam_id, teamID]);
      res.json({ message: "Team member deleted successfully!" });
      return;
    }
    // Remove the logo file if it exists.
    if (checkUser[0].logo) {
      for (const ext of [".png", ".svg"]) {
        unlink("public/img/logos/" + checkUser[0].logo + ext, (err) => {
          if (err && err.code !== "ENOENT") logger.error(err);
        });
      }
    }
    await db.query("DELETE FROM team_auth_names WHERE team_id = ?", [teamID]);
    await db.query("DELETE FROM team WHERE id = ?", [teamID]);
    res.json({ message: "Team has been deleted successfully!" });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /teams/:team_id/recent:
 *   get:
 *     description: Returns last five recent matches by the team.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: team_id
 *         required: true
 *         schema:
 *            type: integer
 *     tags:
 *       - teams
 *     responses:
 *       200:
 *         description: Last five matches from the team.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                    $ref: '#/components/schemas/MatchData'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:team_id/recent/", async (req, res, next) => {
  try {
    let teamId: number = parseInt(req.params.team_id);
    let recentLimit: number = 
      req.query.limit == null ? 5 : Number(req.query.limit);
    let sql: string =
      "SELECT rec_matches.id, " +
      "rec_matches.user_id, " +
      "rec_matches.team1_id, " +
      "rec_matches.team2_id, " +
      "rec_matches.team1_string, " +
      "rec_matches.team2_string " +
      "FROM team t, `match` rec_matches " +
      "WHERE t.id = ? AND " +
      "(rec_matches.team1_id = ? OR rec_matches.team2_id = ?) " +
      "AND rec_matches.cancelled = 0 " +
      "ORDER BY rec_matches.id DESC LIMIT ?";
    let matches: RowDataPacket[] = await db.query(sql, [teamId, teamId, teamId, recentLimit]);
    res.json({ matches });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /teams/:team_id/result/:match_id:
 *   get:
 *     description: Get the string result of a match that the team played.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: team_id
 *         required: true
 *         schema:
 *            type: integer
 *       - name: match_id
 *         required: true
 *         schema:
 *            type: integer
 *     tags:
 *       - teams
 *     responses:
 *       200:
 *         description: String representation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                    result:
 *                      type: string
 *                      description: Whether a team won, lost, or tied.
 *
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:team_id/result/:match_id", async (req, res, next) => {
  try {
    let myScore: number = 0;
    let otherTeamScore: number = 0;
    let matchId: number = parseInt(req.params.match_id);
    let teamId: number = parseInt(req.params.team_id);
    let matchSql: string = "SELECT * FROM `match` WHERE id = ?";
    let statusString: string = "";
    let otherName: string = "";
    const curMatch: RowDataPacket[] = await db.query(matchSql, [matchId]);
    if (curMatch.length < 1) {
      res.status(404).json({ result: "Team did not participate in match." });
      return;
    }
    if (curMatch[0].team1_id == teamId) {
      myScore = curMatch[0].team1_score;
      otherTeamScore = curMatch[0].team2_score;
      otherName =
        curMatch[0].team2_string == null
          ? "Team Removed From Match"
          : curMatch[0].team2_string;
    } else {
      myScore = curMatch[0].team2_score;
      otherTeamScore = curMatch[0].team1_score;
      otherName =
        curMatch[0].team1_string == null
          ? "Team Removed From Match"
          : curMatch[0].team1_string;
    }
    // If match is a bo1, just get the map score.
    if (curMatch[0].max_maps == 1) {
      let mapSql: string =
        "SELECT team1_score, team2_score FROM map_stats WHERE match_id = ? LIMIT 1";
      const mapStatBo1: RowDataPacket[] = await db.query(mapSql, [matchId]);
      if (mapStatBo1.length > 0) {
        if (curMatch[0].team1_id == teamId) {
          myScore = mapStatBo1[0].team1_score;
          otherTeamScore = mapStatBo1[0].team2_score;
        } else {
          myScore = mapStatBo1[0].team2_score;
          otherTeamScore = mapStatBo1[0].team1_score;
        }
      }
    }
    if (
      curMatch[0].end_time == null &&
      (curMatch[0].cancelled == 0 || curMatch[0].cancelled == null) &&
      curMatch[0].start_time != null
    )
      statusString =
        "Live, " + myScore + ":" + otherTeamScore + " vs " + otherName;
    else if (myScore < otherTeamScore)
      statusString =
        "Lost, " + myScore + ":" + otherTeamScore + " vs " + otherName;
    else if (myScore > otherTeamScore)
      statusString =
        "Won, " + myScore + ":" + otherTeamScore + " vs " + otherName;
    else if (curMatch[0].winner != null)
      statusString = "Forfeit win vs " + otherName;
    else if (curMatch[0].cancelled == 1) {
      statusString = "Cancelled";
    } else
      statusString =
        "Tied, " + myScore + ":" + otherTeamScore + " vs " + otherName;
    res.json({ result: statusString });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /teams/members/resolve:
 *   post:
 *     description: >
 *       Resolves Steam identifiers (SteamID64, STEAM_x:y:z, [U:1:n], profile or vanity URLs) to SteamID64s with
 *       their Steam name and avatar, so the panel can preview players before saving a team. Up to 50 per request.
 *     produces:
 *       - application/json
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *               properties:
 *                 ids:
 *                   type: array
 *                   items:
 *                     type: string
 *     tags:
 *       - teams
 *     responses:
 *       200:
 *         description: >
 *           One entry per input, in order - { input, steam_id, name, image }; steam_id is null when the input is not
 *           a Steam account.
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       412:
 *         description: No ids, or more than 50.
 */
router.post("/members/resolve", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    const ids: unknown = req.body?.[0]?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || !ids.every((id) => typeof id === "string")) {
      res.status(412).json({ message: "Provide between 1 and 50 Steam identifiers." });
      return;
    }
    const members = await Promise.all(
      ids.map(async (input) => {
        const steamId: string = await Utils.getSteamPID(input.slice(0, 200));
        const profile = steamId ? await Utils.getSteamProfile(steamId) : null;
        return { input, steam_id: steamId || null, name: profile?.name ?? null, image: profile?.image ?? null };
      })
    );
    res.json({ members });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /teams/challonge:
 *   post:
 *     description: Bulk create blank teams from a Challonge bracket.
 *     produces:
 *       - application/json
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            type: array
 *            items:
 *              type: object
 *              properties:
 *                tournament_id:
 *                  type: string
 *                  description: The tournament ID or URL of the Challonge tournament, as explained in their [API](https://api.challonge.com/v1/documents/participants/index).
 *     tags:
 *       - teams
 *     responses:
 *       200:
 *         description: Teams created successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.post("/challonge", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    let userID: number = req.user!.id;
    const userInfo: RowDataPacket[] = await db.query("SELECT challonge_api_key FROM user WHERE id = ?", [userID]);
    let challongeAPIKey: string | undefined | null = Utils.decrypt(userInfo[0]?.challonge_api_key);
    let tournamentId: string = String(req.body[0]?.tournament_id ?? "").trim();

    if (!challongeAPIKey) {
      res.status(412).json({ message: "No challonge API key provided for user." });
      return;
    }
    if (!tournamentId) {
      res.status(412).json({ message: "Please provide the Challonge tournament ID." });
      return;
    }

    // Fetch the list of participants (teams) in the tournament
    let challongeResponse = await fetch(
      "https://api.challonge.com/v1/tournaments/" + encodeURIComponent(tournamentId) +
        "/participants.json?api_key=" + encodeURIComponent(challongeAPIKey)
    );
    let challongeData = (await challongeResponse.json()) as ChallongeParticipant[];

    if (!challongeResponse.ok || !Array.isArray(challongeData)) {
      res.status(502).json({ message: "Challonge did not return the participants of tournament " + tournamentId + "." });
      return;
    }
    if (challongeData.length === 0) {
      res.status(404).json({ message: "No teams found for Tournament " + tournamentId + "." });
      return;
    }

    const { imported, updated, skipped: skippedIds } = await importParticipants(userID, challongeData);

    res.json({
      message:
        `Challonge teams imported successfully! ${imported} new, ${updated} updated.` +
        (skippedIds.length ? ` Skipped values that are not Steam IDs: ${skippedIds.join(", ")}` : "")
    });
  } catch (err) {
    next(err);
  }
});



/* Helper Functions */
/** Gets the steam image of each palyer.
 * @function
 * @memberof module:routes/teams
 * @param {Object} idList - An object list of steam IDs.
 */
const getTeamImages = async (idList: any, getImage = true) => {
  for (let steamId of Object.keys(idList)) {
    if (!getImage) {
      if (idList[steamId] == "") {
        idList[steamId] = await Utils.getSteamName(steamId);
      }
    } else {
      if (idList[steamId].name == "") {
        idList[steamId].name = await Utils.getSteamName(steamId);
      }
      idList[steamId].image = await Utils.getSteamImage(steamId);
    }
  }
  return idList;
};

/** Anything in an SVG that can run script or load external content. */
const UNSAFE_SVG_CONTENT =
  /<script|<foreignObject|<iframe|<embed|<object|\bon[a-z]+\s*=|javascript:|\bhref\s*=\s*["']?\s*(?!#|data:image\/(?:png|jpe?g|gif|webp);)/i;

/** Validates an uploaded logo (PNG or SVG data URL) and writes it to public/img/logos.
 * @function
 * @memberof module:routes/teams
 * @param {String} dataUrl - data:image/png;base64,... or data:image/svg+xml;base64,...
 * @param {String} logoName - File name without extension.
 * @returns An error message for the client, or null when the logo was saved.
 */
const saveLogo = async (dataUrl: string, logoName: string): Promise<string | null> => {
  const match = /^data:image\/(png|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl));
  if (!match || !/^[A-Za-z0-9]+$/.test(logoName)) {
    return "Logo must be a PNG or SVG image.";
  }
  const content = Buffer.from(match[2], "base64");
  if (match[1] === "png") {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!content.subarray(0, 8).equals(pngSignature)) {
      return "Logo is not a valid PNG image.";
    }
    await writeFile("public/img/logos/" + logoName + ".png", content);
  } else {
    const svg = content.toString("utf8");
    if (!/<svg[\s>]/i.test(svg) || UNSAFE_SVG_CONTENT.test(svg)) {
      return "SVG logo contains unsupported content (scripts, event handlers or external links).";
    }
    await writeFile("public/img/logos/" + logoName + ".svg", content);
  }
  return null;
};

type ResolvedAuth = { steamId: string; name: string | null; captain: number; coach: number };

/** Resolves every key of an auth_name object to a SteamID64.
 * @function
 * @memberof module:routes/teams
 * @param {Object} auths - { "<any steam id format>": { name, captain, coach } }
 * @returns The resolved members, or an error message naming the first invalid ID.
 */
const resolveTeamAuths = async (auths: Record<string, AuthData> | null | undefined): Promise<ResolvedAuth[] | string> => {
  const resolved: ResolvedAuth[] = [];
  for (const key of Object.keys(auths ?? {})) {
    const steamId: string = await Utils.getSteamPID(key);
    if (!steamId) {
      return "Invalid Steam ID: " + key;
    }
    resolved.push({
      steamId,
      name: auths![key]?.name ?? null,
      captain: auths![key]?.captain == null ? 0 : auths![key].captain!,
      coach: auths![key]?.coach == null ? 0 : auths![key].coach!
    });
  }
  return resolved;
};

export default router;
