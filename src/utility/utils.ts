/** Utilities class for help with basic functions.
 * @module utils
 */

/** AES Module for Encryption/Decryption
 * @const
 */
import pkg from "aes-js";
const { utils, ModeOfOperation } = pkg;

/** Crypto for assigning random  */
import { randomBytes, timingSafeEqual } from "crypto";

/** Config to get database key.
 * @const
 */
import config from "config";

/** Steam API Handler for custom URLs
 * @const
 */
import SteamAPI from "steamapi";
const steam = new SteamAPI(config.get("server.steamAPIKey"));
/** Steam ID Handler for other IDs.
 * @const
 */
import { ID } from "@node-steam/id";

import { db } from "../services/db.js";
import { RowDataPacket } from "mysql2";
import { NextFunction, Request, Response } from "express";
import { Get5_Player } from "../types/Get5_Player.js";
import { User } from "../types/User.js";
import { AccessMessage } from "../types/mapstats/AccessMessage.js";

import logger from "./logger.js";
class Utils {
  /** Function to get an HLTV rating for a user.
   * @function
   * @memberof module:utils
   * @param {integer} [kills=0] - Amount of kills.
   * @param {integer} [roundsplayed=0] - Amount of rounds played.
   * @param {integer} [deaths=0] - Amount of deaths.
   * @param {integer} [k1=0] - Amount of 1-kill rounds.
   * @param {integer} [k2=0] - Amount of 2-kill rounds.
   * @param {integer} [k3=0] - Amount of 3-kill rounds.
   * @param {integer} [k4=0] - Amount of 4-kill rounds.
   * @param {integer} [k5=0] - Amount of 5-kill rounds.
   * @function
   * @static */
  static getRating(
    kills: number = 0,
    roundsplayed: number = 0,
    deaths: number = 0,
    k1: number = 0,
    k2: number = 0,
    k3: number = 0,
    k4: number = 0,
    k5: number = 0
  ) {
    try {
      let AverageKPR: number = 0.679;
      let AverageSPR: number = 0.317;
      let AverageRMK: number = 1.277;
      let KillRating: number =
        roundsplayed === 0 ? 0 : kills / roundsplayed / AverageKPR;
      let SurvivalRating: number =
        roundsplayed === 0
          ? 0
          : (roundsplayed - deaths) / roundsplayed / AverageSPR;
      let killcount: number = k1 + 4 * k2 + 9 * k3 + 16 * k4 + 25 * k5;
      let RoundsWithMultipleKillsRating: number =
        roundsplayed === 0 ? 0 : killcount / roundsplayed / AverageRMK;
      let rating: number =
        (KillRating + 0.7 * SurvivalRating + RoundsWithMultipleKillsRating) /
        2.7;

      return +rating.toFixed(2);
    } catch (err) {
      logger.error({ err }, "HELPER getRating Failed");
      return 0;
    }
  }

  /** Builds an absolute URL on the API from server.apiURL, regardless of trailing slashes in the config.
   * @name apiUrl
   * @function
   * @inner
   * @memberof module:utils
   * @param {string} path - Path to append, e.g. "/v2/demo".
   */
  static apiUrl(path: string = ""): string {
    let base: string = config.get<string>("server.apiURL").replace(/\/+$/, "");
    if (!path) return base;
    return base + "/" + path.replace(/^\/+/, "");
  }

  /** Inner function - Supports encryption and decryption for the database keys to get server RCON passwords.
   * @name decrypt
   * @function
   * @inner
   * @memberof module:utils
   * @param {string} source - The source to be decrypted.
   */
  static decrypt(source: string) {
    try {
      if (source === null) return;
      let byteSource = utils.hex.toBytes(source.substring(32));
      let IV = utils.hex.toBytes(source.substring(0, 32));
      let key = utils.utf8.toBytes(config.get("server.dbKey"));
      let aesCbc = new ModeOfOperation.ofb(key, IV);
      let decryptedBytes = aesCbc.decrypt(byteSource);
      let decryptedText = utils.utf8.fromBytes(decryptedBytes);
      return decryptedText;
    } catch (err) {
      logger.error(err);
      // fail silently.
      return null;
    }
  }

  /** Inner function - Supports encryption and decryption for the database keys to get server RCON passwords.
   * @name encrypt
   * @function
   * @inner
   * @memberof module:utils
   * @param {string} source - The source to be decrypted.
   */
  static encrypt(source: string) {
    try {
      if (source === null) return;

      let byteSource = utils.utf8.toBytes(source);
      let IV = randomBytes(16);
      let key = utils.utf8.toBytes(config.get("server.dbKey"));
      let aesCbc = new ModeOfOperation.ofb(key, IV);
      let encryptedBytes = aesCbc.encrypt(byteSource);
      let encryptedHex = utils.hex.fromBytes(encryptedBytes);
      let hexIV = utils.hex.fromBytes(IV);
      encryptedHex = hexIV + encryptedHex;
      return encryptedHex;
    } catch (err) {
      logger.error(err);
      throw err;
    }
  }
  /** Ensures the user was authenticated through steam OAuth.
   * @function
   * @memberof module:utils
   * @inner */
  // this: void - passed to Express as a bare function (it never uses `this`).
  static async ensureAuthenticated(
    this: void,
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    try {
      // req.user is set by passport (session, reloaded from the database) or by access.resolveUser (API key).
      if (req.user) {
        return next();
      }
      res.status(401).json({ message: "Not logged in." });
    } catch (err) {
      next(err);
    }
  }

  /** Constant-time string comparison for secrets (API keys).
   * @function
   * @memberof module:utils
   * @inner
   * @name safeCompare
   * @returns false if either value is missing or they differ.
   */
  static safeCompare(
    a: string | null | undefined,
    b: string | null | undefined
  ): boolean {
    if (!a || !b) return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }

  /** Validates user-supplied cvars before they are stored and sent to MatchZy in the match config.
   * Mirrors MatchZy's own rules (it drops cvars with quotes, semicolons or line breaks) and blocks cvars
   * that would hand over the server or redirect the match's events, demos or backups elsewhere.
   * @function
   * @memberof module:utils
   * @inner
   * @name validateCvars
   * @param {Object} cvars - { cvar_name: value }
   * @returns An error message, or null when every cvar is acceptable.
   */
  static validateCvars(cvars: unknown): string | null {
    if (cvars == null) return null;
    if (typeof cvars !== "object" || Array.isArray(cvars)) return "Cvars must be an object of name/value pairs.";
    const blocked = /^(rcon_password|sv_rcon_.*|matchzy_everyone_is_admin|.*_url|.*_header_(key|value))$/i;
    for (const [name, value] of Object.entries(cvars as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) return `Invalid cvar name: ${name}`;
      if (blocked.test(name)) return `Cvar ${name} cannot be set from a match or season.`;
      if (!["string", "number", "boolean"].includes(typeof value)) return `Invalid value for cvar ${name}.`;
      const text = String(value);
      // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
      if (text.length > 256 || /[";\x00-\x1f\x7f]/.test(text)) {
        return `Invalid value for cvar ${name}: quotes, semicolons and line breaks are not allowed.`;
      }
    }
    return null;
  }

  /** Checks that a value is a SteamID64 of an individual account.
   * @function
   * @memberof module:utils
   * @inner
   * @name isSteamId64
   */
  static isSteamId64(value: unknown): value is string {
    return typeof value === "string" && /^7656\d{13}$/.test(value);
  }

  /** Checks if a user is an admin in the system during their session.
   * @function
   * @memberof module:utils
   * @inner
   * @name adminCheck
   * @param {user} user - the users session object.
   */
  static adminCheck(user: User) {
    // Flags arrive as 0/1 from MySQL but can be booleans or strings in a session; only a set flag counts
    // (the old "=== 0" checks made false, "0" or a missing flag count as admin).
    return Boolean(user) && (Number(user.admin) > 0 || Number(user.super_admin) > 0);
  }

  /** Checks if a user is a super admin in the system during their session.
   * @function
   * @memberof module:utils
   * @inner
   * @name superAdminCheck
   * @param {user} user - the users session object.
   */
  static superAdminCheck(user: User) {
    return Boolean(user) && Number(user.super_admin) > 0;
  }

  /** Converts a Steam ID to Steam64.
   * @function
   * @memberof module:utils
   * @inner
   * @name convertToSteam64
   * @param {String} anySteamID - String value of a Steam ID.
   * @returns A string representing a 64bit steam ID, or nothing if the profile is not found.
   */
  static async convertToSteam64(anySteamID: string) {
    const steam64ID = new ID(anySteamID);
    if (steam64ID.isValid() && steam64ID.getType() == "INDIVIDUAL")
      return steam64ID.get64();
    else return "";
  }
  /** Retrieves a Steam64 value from a given value.
   * @function
   * @memberof module:utils
   * @inner
   * @name getSteamPID
   * @param {String} authString - String value of a steam username/profile/url/steamID.
   * @returns A Steam64 value in string form, or an empty string if it is not a valid individual SteamID64.
   */
  static async getSteamPID(authString: string): Promise<string> {
    if (typeof authString !== "string") return "";
    // Remove any https tags, as they aren't needed.
    authString = authString
      .trim()
      .replace(new RegExp("^(http|https)://", "i"), "");
    let steamID: string;
    try {
      if (authString.includes("steamcommunity.com/id/")) {
        steamID = await steam.resolve(authString);
      } else if (authString.includes("steamcommunity.com/profiles/")) {
        steamID = authString.split("/")[2];
      } else if (authString.startsWith("STEAM_")) {
        steamID = await this.convertToSteam64(authString);
      } else if (
        authString.startsWith("1:0:") ||
        authString.startsWith("1:1:")
      ) {
        steamID = await this.convertToSteam64("STEAM_" + authString);
      } else if (authString.startsWith("[U:1:")) {
        steamID = await this.convertToSteam64(authString);
      } else if (authString.startsWith("U:1:")) {
        steamID = await this.convertToSteam64("[" + authString + "]");
      } else if (authString.startsWith("7656119")) {
        steamID = authString;
      } else {
        steamID = await steam.resolve("steamcommunity.com/id/" + authString);
      }
    } catch {
      // Unknown vanity URL, or the Steam API is unavailable.
      return "";
    }
    return this.isSteamId64(steamID) ? steamID : "";
  }
  /** Retrieves a profile name from steam.
   * @function
   * @memberof module:utils
   * @inner
   * @name getSteamName
   * @param {String} auth64 - String value of a steam 64 ID.
   * @returns A username from a given Steam64 ID.
   */
  static async getSteamName(auth64: string) {
    try {
      let summaryInfo = await steam.getUserSummary(auth64);
      // @ts-expect-error
      return summaryInfo.nickname;
    } catch {
      return null;
    }
  }

  /** Name and medium avatar of a Steam account in one request (null when Steam can't be asked).
   * @function
   * @memberof module:utils
   * @inner
   * @name getSteamProfile
   * @param {String} auth64 - String value of a steam 64 ID.
   */
  static async getSteamProfile(auth64: string): Promise<{ name: string; image: string } | null> {
    try {
      const summary = (await steam.getUserSummary(auth64)) as { nickname: string; avatar: { medium: string } };
      return { name: summary.nickname, image: summary.avatar.medium };
    } catch {
      return null;
    }
  }

  /** Retrieves a profile image from steam.
   * @function
   * @memberof module:utils
   * @inner
   * @name getSteamImage
   * @param {String} auth64 - String value of a steam 64 ID.
   * @returns A profile image link.
   */
  static async getSteamImage(auth64: string) {
    try {
      let summaryInfo = await steam.getUserSummary(auth64);
      // @ts-expect-error
      return summaryInfo.avatar.medium;
    } catch {
      return null;
    }
  }

  /** Checks whether or not a user has access to edit a match. Also checks if a match is currently being played.
   * @function
   * @memberof module:utils
   * @inner
   * @name getUserMatchAccess
   * @param {String|Number} matchid - The ID of a match
   * @param {user} user - the users session object.
   * @param {boolean} [onlyAdmin = false] - Set to true to only check admin status and not super admin status.
   * @param {boolean} [serverCheck = false] - Optional parameter to check if a user owns a server, for elevated calls.
   * @returns An object containing the HTTP error, followed by a message.
   */
  static async getUserMatchAccess(
    matchid: string | number,
    user: User,
    onlyAdmin: boolean = false,
    serverCheck: boolean = false
  ): Promise<AccessMessage | null> {
    try {
      let retMessage: AccessMessage | null;

      retMessage = await this.getUserMatchAccessNoFinalize(
        matchid,
        user,
        onlyAdmin,
        serverCheck
      );
      if (retMessage != null) return retMessage;

      let currentMatchInfo =
        "SELECT cancelled, forfeit, end_time FROM `match` WHERE id = ?";
      const matchRow = await db.query(currentMatchInfo, [matchid]);
      if (
        matchRow[0].cancelled == 1 ||
        matchRow[0].forfeit == 1 ||
        matchRow[0].end_time != null
      ) {
        retMessage = { status: 422, message: "Match is already finished." };
      }
      return retMessage;
    } catch (err) {
      throw err;
    }
  }

  /** Checks whether or not a match exists, ignoring finalized matches.
   * @function
   * @memberof module:utils
   * @inner
   * @name getUserMatchAccessNoFinalize
   * @param {String|Number} matchid - The ID of a match
   * @param {user} user - the users session object.
   * @param {boolean} [onlyAdmin = false] - Set to true to only check admin status and not super admin status.
   * @param {boolean} [serverCheck = false] - Optional parameter to check if a user owns a server, for elevated calls.
   * @returns An object containing the HTTP error, followed by a message.
   */
  static async getUserMatchAccessNoFinalize(
    matchid: string | number,
    user: User,
    onlyAdmin: boolean = false,
    serverCheck: boolean = false
  ): Promise<AccessMessage | null> {
    try {
      let adminCheck: boolean = onlyAdmin
        ? this.adminCheck(user)
        : this.superAdminCheck(user);
      let retMessage: AccessMessage | null = null;
      retMessage = await this.checkIfMatchExists(matchid);

      if (retMessage != null) return retMessage;

      let currentMatchInfo =
        "SELECT user_id, server_id FROM `match` WHERE id = ?";
      let currentServerInfo = "SELECT user_id FROM game_server WHERE id = ?";
      const matchRow = await db.query(currentMatchInfo, [matchid]);

      if (matchRow[0].user_id != user.id && !adminCheck) {
        return {
          status: 403,
          message: "User is not authorized to perform action."
        };
      }
      // Server ownership only matters when the match is on a server.
      if (serverCheck && matchRow[0].server_id) {
        const serverRow = await db.query(currentServerInfo, [
          matchRow[0].server_id
        ]);
        if (!this.superAdminCheck(user) && serverRow[0]?.user_id != user.id) {
          retMessage = {
            status: 403,
            message: "User is not authorized to perform action."
          };
        }
      }
      return retMessage;
    } catch (err) {
      throw err;
    }
  }

  /** Checks whether or not a match exists.
   * @function
   * @memberof module:utils
   * @inner
   * @name checkIfMatchExists
   * @param {String|Number} matchid - The ID of a match
   * @returns An object containing the HTTP error, followed by a message.
   */
  static async checkIfMatchExists(
    matchid: string | number
  ): Promise<AccessMessage | null> {
    try {
      if (matchid == null) {
        return { status: 400, message: "Match ID Not Provided" };
      }

      let currentMatchInfo: string = "SELECT id FROM `match` WHERE id = ?";
      const matchRow: RowDataPacket[] = await db.query(currentMatchInfo, [
        matchid
      ]);
      if (!matchRow.length) {
        return { status: 404, message: "No match found." };
      }
    } catch (err) {
      throw err;
    }
    return null;
  }

  /** Updates the tables accordingly if match was a PUG.
   * @function
   * @memberof module:utils
   * @inner
   * @name updatePugStats
   * @param {String|Number} match_id The ID of a match.
   * @param {Number} map_id The ID of a map in a match.
   * @param {Number} team1_id The internal ID of team 1.
   * @param {Number} team2_id The internal ID of team 2.
   * @param {Number} winner The internal ID of the winning team.
   */
  static async updatePugStats(
    match_id: string | number,
    map_id: number,
    team1_id: number,
    team2_id: number,
    winner: number | null,
    deleteTeams = true
  ) {
    let teamAuthSql: string =
      "SELECT GROUP_CONCAT(ta.auth) as auth_name, GROUP_CONCAT(CONCAT(ta.name)) as name FROM team_auth_names ta WHERE team_id = ?";
    let pugTeamNameSql: string = "SELECT name FROM team WHERE id = ?";
    let playerStatUpdateSql: string =
      "UPDATE player_stats SET team_name = ?, winner = ? WHERE match_id = ? AND map_id = ? AND steam_id IN (?)";
    let pugSql: string =
      "DELETE FROM team_auth_names WHERE team_id = ? OR team_id = ?";
    let playerStatCheckExistsSql =
      "SELECT COUNT(*) as cnt FROM player_stats WHERE match_id = ? AND map_id = ?";
    const teamNameOne: RowDataPacket[] = await db.query(pugTeamNameSql, [
      team1_id
    ]);
    const teamOneAuths: RowDataPacket[] = await db.query(teamAuthSql, [
      team1_id
    ]);
    const teamNameTwo: RowDataPacket[] = await db.query(pugTeamNameSql, [
      team2_id
    ]);
    const teamTwoAuths: RowDataPacket[] = await db.query(teamAuthSql, [
      team2_id
    ]);
    const doPlayerStatsExist: RowDataPacket[] = await db.query(
      playerStatCheckExistsSql,
      [match_id, map_id]
    );
    const teamAuthListOne: string[] = teamOneAuths[0].auth_name.split(",");
    const teamAuthTwoList: string[] = teamTwoAuths[0].auth_name.split(",");
    // Check to see if player stats already exist.
    if (doPlayerStatsExist[0].cnt && doPlayerStatsExist[0].cnt > 0) {
      await db.query(playerStatUpdateSql, [
        teamNameOne[0].name,
        winner == team1_id ? 1 : 0,
        match_id,
        map_id,
        teamAuthListOne
      ]);
      await db.query(playerStatUpdateSql, [
        teamNameTwo[0].name,
        winner == team2_id ? 1 : 0,
        match_id,
        map_id,
        teamAuthTwoList
      ]);
    } else {
      let newPlayerArr: Array<{}> = [];
      let teamNameOneList: string[] = teamOneAuths[0].name.split(",");
      let teamNameTwoList: string[] = teamTwoAuths[0].name.split(",");
      playerStatUpdateSql =
        "INSERT INTO player_stats (match_id, map_id, team_name, steam_id, name, winner) VALUES ?";
      for (let [idx, auth] of teamAuthListOne.entries()) {
        newPlayerArr.push([
          match_id,
          map_id,
          teamNameOne[0].name,
          auth,
          teamNameOneList[idx],
          winner == team1_id ? 1 : 0
        ]);
      }
      for (let [idx, auth] of teamAuthTwoList.entries()) {
        newPlayerArr.push([
          match_id,
          map_id,
          teamNameTwo[0].name,
          auth,
          teamNameTwoList[idx],
          winner == team2_id ? 1 : 0
        ]);
      }
      await db.query(playerStatUpdateSql, [newPlayerArr]);
    }
    if (deleteTeams) {
      await db.query(pugSql, [team1_id, team2_id]);
      pugSql = "DELETE FROM team WHERE id = ? OR id = ?";
      await db.query(pugSql, [team1_id, team2_id]);
    }

    return;
  }

  /**
   * Deletes everything a match produced while being played (maps, stats, kill feed, bombs, pauses, vetoes),
   * children before parents so foreign keys hold. The match row itself is kept.
   * @param {String|Number} matchId The match ID.
   */
  static async deleteMatchProgress(matchId: string | number): Promise<void> {
    for (const table of [
      "player_stat_extras",
      "match_bomb_plants",
      "match_pause",
      "player_stats",
      "veto_side",
      "veto",
      "map_stats"
    ]) {
      await db.query(`DELETE FROM ${table} WHERE match_id = ?`, [matchId]);
    }
  }

  /**
   * Performs a check on the server to see if the provided API key is correct, and if the match has not been finalized.
   * @param {String} providedKey The API key sent by a user/game server.
   * @param {String|Number} matchId The match ID sent by the user/game server.
   * @returns 0 if successful, 1 if provided API key does not match, and 2 if the match has been finalized.
   */
  static async checkApiKey<Number>(
    providedKey: string,
    matchId: string | number
  ) {
    const matchInformation: RowDataPacket[] = await db.query(
      "SELECT api_key, cancelled, end_time FROM `match` WHERE id = ?",
      [matchId]
    );
    // A missing match or key must never pass.
    if (!Utils.safeCompare(providedKey, matchInformation[0]?.api_key)) return 1;
    else if (
      matchInformation[0]?.cancelled === 1 ||
      matchInformation[0]?.end_time != null
    )
      return 2;
    else return 0;
  }

  /**
   * Private helper function to update player stats based on a team.
   * @param {string} matchid The current match ID.
   * @param {string} teamid The team ID of the player being updated.
   * @param {number} mapId The map ID from the database.
   * @param {Get5_Player} player The Get5_Player structure.
   * @param {number} playerId The player ID from the database.
   */
  public static async updatePlayerStats(
    matchid: string,
    teamid: string,
    mapId: number,
    player: Get5_Player,
    playerId: number | null
  ) {
    let insUpdStatement: object;
    let sqlString: string;
    insUpdStatement = {
      match_id: matchid,
      map_id: mapId,
      team_id: teamid,
      steam_id: player.steamid,
      name: player.name,
      kills: player.stats?.kills,
      deaths: player.stats?.deaths,
      roundsplayed: player.stats?.rounds_played,
      assists: player.stats?.assists,
      flashbang_assists: player.stats?.flash_assists,
      teamkills: player.stats?.team_kills,
      knife_kills: player.stats?.knife_kills,
      suicides: player.stats?.suicides,
      headshot_kills: player.stats?.headshot_kills,
      damage: player.stats?.damage,
      util_damage: player.stats?.utility_damage,
      enemies_flashed: player.stats?.enemies_flashed,
      friendlies_flashed: player.stats?.friendlies_flashed,
      bomb_plants: player.stats?.bomb_plants,
      bomb_defuses: player.stats?.bomb_defuses,
      v1: player.stats?.["1v1"],
      v2: player.stats?.["1v2"],
      v3: player.stats?.["1v3"],
      v4: player.stats?.["1v4"],
      v5: player.stats?.["1v5"],
      k1: player.stats?.["1k"],
      k2: player.stats?.["2k"],
      k3: player.stats?.["3k"],
      k4: player.stats?.["4k"],
      k5: player.stats?.["5k"],
      firstdeath_ct: player.stats?.first_deaths_ct,
      firstdeath_t: player.stats?.first_deaths_t,
      firstkill_ct: player.stats?.first_kills_ct,
      firstkill_t: player.stats?.first_kills_t,
      kast: player.stats?.kast,
      trade_kills: player.stats?.trade_kills,
      contribution_score: player.stats?.score,
      mvp: player.stats?.mvp
    };

    insUpdStatement = await db.buildUpdateStatement(insUpdStatement);

    if (playerId) {
      sqlString = "UPDATE player_stats SET ? WHERE id = ?";
      await db.query(sqlString, [insUpdStatement, playerId]);
    } else {
      sqlString = "INSERT INTO player_stats SET ?";
      await db.query(sqlString, insUpdStatement);
    }
  }
}

export default Utils;
