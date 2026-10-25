/**
 * @swagger
 * resourcePath: /users
 * description: Express API router for users.
 */
import { Router } from "express";

import { hashSync, compare } from "bcrypt";

const router = Router();

import {db} from "../services/db.js";

import Utils from "../utility/utils.js";
import { audited, firstBody } from "../utility/audit.js";

import { generate } from "randomstring";
import { RowDataPacket } from "mysql2";
import { UserObject } from "../types/users/UserObject.js";
import config from "config";
import { passwordProblem, usernameProblem } from "../utility/credentials.js";
import { canHoldRoles } from "../utility/access.js";

/* Swagger shared definitions */

/**
 * @swagger
 *
 * components:
 *   schemas:
 *     NewUser:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: System identifier of a user.
 *         steam_id:
 *           type: string
 *           description: Steam ID of the user being created
 *         name:
 *           type: string
 *           description: Name gathered from Steam. Can be updated
 *         admin:
 *           type: integer
 *           description: Integer determining if a user is an admin of the system. Either 1 or 0.
 *         super_admin:
 *           type: integer
 *           description: Integer determining if a user is an  admin of the system. Either 1 or 0.
 *         small_image:
 *           type: string
 *           description: Akamai Steam URL to the small profile image
 *         medium_image:
 *           type: string
 *           description: Akamai Steam URL to the small profile image
 *         large_image:
 *           type: string
 *           description: Akamai Steam URL to the small profile image
 *         new_api:
 *           type: boolean
 *           description: Whether the user is requesting a new API key.
 *         password:
 *           type: string
 *           description: A new password to reset a user.
 *         old_password:
 *           type: string
 *           description: The old password provided by the user to check validity.
 *         challonge_api_key:
 *           type: string
 *           description: A [challonge API](https://challonge.com/settings/developer) key
 *     User:
 *       allOf:
 *         - $ref: '#/components/schemas/NewUser'
 *         - type: object
 *           properties:
 *             id:
 *               type: integer
 */

/**
 * @swagger
 *
 * /users/:
 *   get:
 *     description: Get all users
 *     produces:
 *       - application/json
 *     tags:
 *       - users
 *     responses:
 *       200:
 *         description: List of users
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/NewUser'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/", async (req, res, next) => {
  try {
    let sql: string =
      "SELECT id, name, steam_id, small_image, medium_image, large_image FROM user";
    const users: RowDataPacket[] = await db.query(sql);
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

/** @swagger
 *
 * /users/:user_id:
 *   get:
 *     description: Get specific user
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: user_id
 *         description: The database or steam ID of the user
 *         required: true
 *         schema:
 *            type: integer
 *     tags:
 *       - users
 *     responses:
 *       200:
 *         description: Get a specific user.
 *         content:
 *           application/json:
 *             schema:
 *                type: object
 *                properties:
 *                  user:
 *                      $ref: '#/components/schemas/NewUser'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:user_id", async (req, res, next) => {
  try {
    let userOrSteamID: string = req.params.user_id;
    let sql: string =
      "SELECT id, name, steam_id, small_image, medium_image, large_image, admin, super_admin, username, api_key, challonge_api_key FROM user where id = ? OR steam_id = ?";

    let user: any = await db.query(sql, [userOrSteamID, userOrSteamID]);
    if (user[0] != null) {
      user = JSON.parse(JSON.stringify(user[0]));
      const isSelf: boolean = req.user != null && req.user.id == user.id;
      // Secrets are only ever shown to their owner; the password hash is never selected.
      if (isSelf && user.api_key != null) {
        user.api_key = user.id + ":" + Utils.decrypt(user.api_key);
      } else {
        delete user.api_key;
      }
      if (isSelf && user.challonge_api_key != null) {
        user.challonge_api_key = Utils.decrypt(user.challonge_api_key);
      } else {
        delete user.challonge_api_key;
      }
      if (!isSelf && !(req.user && Utils.superAdminCheck(req.user))) {
        delete user.username;
      }
      res.json({ user });
    } else {
      res.status(404).json({ message: "User does not exist in the system." });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /users:
 *   post:
 *     description: Create user
 *     produces:
 *       - application/json
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            $ref: '#/components/schemas/NewUser'
 *     tags:
 *       - users
 *     responses:
 *       200:
 *         description: Create successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.post("/", Utils.ensureAuthenticated, audited("user.create", { target: (req, body) => ({ type: "user", id: body?.id ?? null }) }), async (req, res, next) => {
  try {
    if (req.user && Utils.adminCheck(req.user)) {
      let steamId: string = req.body[0].steam_id;
      let steamName: string = req.body[0].name;
      // Only super admins may create privileged accounts.
      let isSuperAdminCaller: boolean = Utils.superAdminCheck(req.user);
      let isAdmin: number = isSuperAdminCaller ? req.body[0].admin : 0;
      let isSuperAdmin: number = isSuperAdminCaller ? req.body[0].super_admin : 0;
      let smallImage: string = req.body[0].small_image;
      let mediumImage: string = req.body[0].medium_image;
      let largeImage: string = req.body[0].large_image;
      let challongeApiKey: string | null | undefined =
        req.body[0].challonge_api_key == null
          ? null
          : Utils.encrypt(req.body[0].challonge_api_key);
      let apiKey: string | undefined = generate({
        length: 64,
        capitalization: "uppercase",
      });
      let userId = null;
      apiKey = Utils.encrypt(apiKey);
      // Check if user is allowed to create?
      let sql: string =
        "INSERT INTO user SET ?";
      let userObject: UserObject = {
        steam_id: steamId,
        name: steamName,
        admin: isAdmin,
        super_admin: isSuperAdmin,
        small_image: smallImage,
        medium_image: mediumImage,
        large_image: largeImage,
        api_key: apiKey,
        challonge_api_key: challongeApiKey
      };
      userObject = await db.buildUpdateStatement(userObject) as UserObject;
      let newUser: RowDataPacket[] = await db.query(sql, [userObject]);
      //@ts-ignore
      userId = newUser.insertId;
      res.json({ message: "User created successfully.", id: userId });
    } else {
      res.status(403).json({ message: "You are not authorized to do this." });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /users:
 *   put:
 *     description: Update a user
 *     produces:
 *       - application/json
 *     requestBody:
 *      required: true
 *      content:
 *        application/json:
 *          schema:
 *            $ref: '#/components/schemas/NewUser'
 *     tags:
 *       - users
 *     responses:
 *       200:
 *         description: User update successful.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       412:
 *         description: Nothing to update
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SimpleResponse'
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.put("/", Utils.ensureAuthenticated, audited("user.update", { target: (req) => ({ type: "user", id: Number(firstBody(req).id) || null }), detail: (req) => { const b = firstBody(req); return [b.admin != null ? `admin=${b.admin}` : "", b.super_admin != null ? `super_admin=${b.super_admin}` : "", b.username ? "local login added" : "", b.password ? "password changed" : "", b.new_api ? "new API key" : "", b.challonge_api_key != null ? "Challonge key" : "", b.name != null ? "name" : ""].filter(Boolean).join(", ") || null; } }), async (req, res, next) => {
  try {
    // Resolve exactly one target user; every later check and the update use this row.
    let userToBeUpdated: RowDataPacket[] =
      req.body[0]?.id != null
        ? await db.query(
            "SELECT id, steam_id, name, admin, super_admin, username, password, steam_verified FROM user WHERE id = ?",
            [req.body[0].id]
          )
        : await db.query(
            "SELECT id, steam_id, name, admin, super_admin, username, password, steam_verified FROM user WHERE steam_id = ?",
            [req.body[0]?.steam_id]
          );
    if (!userToBeUpdated.length) {
      res.status(404).json({ message: "User does not exist in the system." });
      return;
    }
    const target = userToBeUpdated[0];
    const caller = req.user!;
    const isSelf: boolean = caller.id == target.id;
    const callerIsSuperAdmin: boolean = Utils.superAdminCheck(caller);
    const callerIsAdmin: boolean = Utils.adminCheck(caller);

    let isAdmin: number =
      req.body[0].admin == null ? target.admin : req.body[0].admin;
    let isSuperAdmin: number =
      req.body[0].super_admin == null
        ? target.super_admin
        : req.body[0].super_admin;
    let displayName: string =
      req.body[0].name == null ? target.name : req.body[0].name;
    let smallImage: string = req.body[0].small_image;
    let mediumImage: string = req.body[0].medium_image;
    let largeImage: string = req.body[0].large_image;
    let apiKey: string | null | undefined =
      req.body[0].new_api == 1
        ? generate({
          length: 64,
          capitalization: "uppercase",
        })
        : null;
    let challongeApiKey: string | undefined | null =
      req.body[0].challonge_api_key == null
        ? null
        : Utils.encrypt(req.body[0].challonge_api_key);
    const password: string | undefined = req.body[0].password;
    const oldPassword: string = req.body[0].old_password;
    // A user without a local login (signed up with Steam) may add a username and password.
    const newUsername: string | undefined =
      typeof req.body[0].username === "string" ? req.body[0].username.trim() : undefined;
    if (password) {
      const problem = passwordProblem(password);
      if (problem) {
        res.status(412).json({ message: problem });
        return;
      }
    }
    if (apiKey != null) apiKey = Utils.encrypt(apiKey);
    // Only for your own profile, and only once (usernames don't change afterwards).
    let setUsername: string | undefined;
    if (isSelf && newUsername != null && !target.username) {
      if (!config.get("server.localLoginEnabled")) {
        res.status(412).json({ message: "Username and password logins are turned off on this panel." });
        return;
      }
      const problem = usernameProblem(newUsername) ?? (password ? null : "Choose a password too.");
      if (problem) {
        res.status(412).json({ message: problem });
        return;
      }
      const taken: RowDataPacket[] = await db.query("SELECT id FROM user WHERE username = ? AND id <> ?", [
        newUsername,
        target.id
      ]);
      if (taken.length) {
        res.status(409).json({ message: "That username is taken." });
        return;
      }
      setUsername = newUsername;
    }
    let updateUser: UserObject;
    if (callerIsSuperAdmin) {
      // A super admin locked out by mistake gets the role back from super_admins.steam_ids at the next Steam login.
      const rolesChanged: boolean = req.body[0].admin != null || req.body[0].super_admin != null;
      // A local account that claimed a Steam ID it never proved must not get admin rights (the ID may be someone
      // else's); accounts without a Steam ID can (see access.canHoldRoles).
      if (rolesChanged && (Number(isAdmin) > 0 || Number(isSuperAdmin) > 0) && !canHoldRoles(target)) {
        res.status(412).json({
          message: "This account's Steam ID was never confirmed by a Steam login, so it can't be an admin."
        });
        return;
      }
      // Super admins manage roles and can force-set passwords, e.g. for locked out users.
      updateUser = {
        admin: isAdmin,
        super_admin: isSuperAdmin,
        // Set here, so a Steam login no longer resets them from the config lists.
        roles_from_config: rolesChanged ? 0 : undefined,
        name: displayName,
        small_image: smallImage,
        medium_image: mediumImage,
        large_image: largeImage,
        api_key: apiKey,
        username: setUsername,
        password: password ? hashSync(password, 10) : null,
        challonge_api_key: isSelf ? challongeApiKey : null
      };
    } else if (isSelf) {
      // Changing an existing password always needs the old one (the old panel's force_reset
      // flag used to skip this check). Only super admins can force-set a password.
      if (password && target.password) {
        const isOldPassMatching = await compare(String(oldPassword), target.password);
        if (!isOldPassMatching) {
          res.status(403).json({ message: "Old password does not match." });
          return;
        }
      }
      updateUser = {
        // Admins may still edit their own display name and images.
        name: callerIsAdmin ? displayName : undefined,
        small_image: callerIsAdmin ? smallImage : undefined,
        medium_image: callerIsAdmin ? mediumImage : undefined,
        large_image: callerIsAdmin ? largeImage : undefined,
        api_key: apiKey,
        username: setUsername,
        password: (target.username != null || setUsername != null) && password ? hashSync(password, 10) : null,
        challonge_api_key: challongeApiKey
      };
    } else if (callerIsAdmin && !target.admin && !target.super_admin) {
      // Admins can tidy up regular users' profiles, nothing more.
      updateUser = {
        name: displayName,
        small_image: smallImage,
        medium_image: mediumImage,
        large_image: largeImage
      };
    } else {
      res.status(403).json({ message: "You are not authorized to do this." });
      return;
    }
    updateUser = await db.buildUpdateStatement(updateUser);
    if (Object.keys(updateUser).length === 0) {
      res.status(412).json({ message: "No update data has been provided." });
      return;
    }
    let sql: string = "UPDATE user SET ? WHERE id = ?";
    await db.query(sql, [updateUser, target.id]);
    // A super admin changing their own roles: the session gets the new roles. Only roles that were sent change,
    // and the reply waits for the new session (req.login starts a new one; answering first logged the user out).
    if (isSelf && callerIsSuperAdmin && (req.body[0].admin != null || req.body[0].super_admin != null)) {
      if (req.body[0].super_admin != null) caller.super_admin = isSuperAdmin;
      if (req.body[0].admin != null) caller.admin = isAdmin;
      await new Promise<void>((resolve, reject) =>
        req.login(caller, (err: unknown) => (err ? reject(err instanceof Error ? err : new Error("Could not update the session.")) : resolve()))
      );
    }
    res.status(200).json({ message: "User successfully updated!" });
  } catch (err) {
    next(err);
  }
});

/** @swagger
 *
 * /users/:user_id/steam:
 *   get:
 *     description:  get a users' steam URL
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: user_id
 *         description: The database or steam ID of the user
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - users
 *     responses:
 *       200:
 *         description: Update successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *       500:
 *         $ref: '#/components/responses/Error'
 */
router.get("/:user_id/steam", async (req, res, next) => {
  try {
    let userOrSteamID: string | number = req.params.user_id;
    let sql: string = "SELECT steam_id FROM user where id = ? OR steam_id = ?";
    const allUsers: RowDataPacket[] = await db.query(sql, [userOrSteamID, userOrSteamID]);
    res.json({
      url: "https://steamcommunity.com/profiles/" + allUsers[0].steam_id,
    });
  } catch (err) {
    next(err);
  }
});

/** @swagger
 *
 * /users/:user_id/recent:
 *   get:
 *     description: Get a users' recent matches
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: user_id
 *         description: The database or steam ID of the user
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - users
 *     responses:
 *       200:
 *         description: Last five matches from the user.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MatchData'
 *       500:
 *         $ref: '#/components/responses/Error'
 */

router.get("/:user_id/recent", async (req, res, next) => {
  try {
    let userOrSteamID: string | number = req.params.user_id;
    let sql: string =
      "SELECT DISTINCT rec_matches.id, " +
      "rec_matches.user_id, " +
      "rec_matches.team1_id, " +
      "rec_matches.team2_id, " +
      "rec_matches.team1_string, " +
      "rec_matches.team2_string " +
      "FROM `match` rec_matches JOIN player_stats ps " +
      "ON ps.match_id = rec_matches.id JOIN user us ON " +
      "us.steam_id = ps.steam_id " +
      "WHERE (rec_matches.cancelled = 0 OR rec_matches.cancelled IS NULL) " +
      "AND (us.id=? OR us.steam_id=?) " +
      "ORDER BY rec_matches.id DESC LIMIT 5";
    const matches: RowDataPacket[] = await db.query(sql, [userOrSteamID, userOrSteamID]);
    res.json({ matches });
  } catch (err) {
    next(err);
  }
});

export default router;
