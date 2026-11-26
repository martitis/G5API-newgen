import Utils from "./utils.js";
import { Rcon } from "dathost-rcon-client";
import fetch from "node-fetch";
import { SteamApiResponse } from "../types/serverrcon/SteamApiResponse.js";

import logger from "./logger.js";
/** Thrown when a value can't safely be passed as an RCON command argument. */
export class RconArgumentError extends Error {}

/** Quotes, semicolons and control characters would let an argument break out into another console command. */
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const UNSAFE_RCON_CHARS = /[";\x00-\x1f\x7f]/;

/**
 * Validates a free-form RCON argument (nickname, URL, key).
 * @param value - The value to check.
 * @param label - Name used in the error message.
 * @param maxLength - Maximum allowed length.
 * @returns The value, if safe.
 */
export function safeRconArg(value: unknown, label: string, maxLength: number = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || UNSAFE_RCON_CHARS.test(value)) {
    throw new RconArgumentError(`Invalid ${label}.`);
  }
  return value;
}

function safeSteamId(value: unknown): string {
  if (typeof value !== "string" || !/^7656\d{13}$/.test(value)) {
    throw new RconArgumentError("Invalid Steam ID.");
  }
  return value;
}

/** MatchZy round backup file name: matchzy_<matchid>_<mapnumber>_round<NN>.json */
const MATCHZY_BACKUP_FILE = /^matchzy_(\d+)_(\d+)_round(\d+)\.json$/;

/** The RCON command that restores a round backup on the game server.
 * MatchZy reads matchzy_loadbackup's argument raw (ArgString), so quotes would become part of the file name;
 * the name is sent bare, which is safe because only names matching MATCHZY_BACKUP_FILE get here.
 * @throws RconArgumentError for anything that isn't a MatchZy backup file name.
 */
export function backupLoadCommand(backupName: unknown): string {
  if (typeof backupName !== "string" || !MATCHZY_BACKUP_FILE.test(backupName)) {
    throw new RconArgumentError("Invalid backup name.");
  }
  return `matchzy_loadbackup ${backupName}`;
}

/** MatchZy's reply when a restore did nothing (missing file, incomplete round data, bad JSON).
 * The RCON reply carries what MatchZy printed for the console caller.
 */
const RESTORE_FAILED = /nothing restored|does not exist|incomplete|fatal|failed|error|could not|unable to/i;

/** Whether the server's reply to matchzy_loadbackup says the restore failed. */
export function restoreFailed(response: string | null | undefined): boolean {
  return RESTORE_FAILED.test(String(response ?? ""));
}

export interface BackupEntry {
  /** Exact file name to pass to matchzy_loadbackup. */
  file: string;
  /** Zero-based map number in the series. */
  map_number: number;
  round: number;
  /** Whatever MatchZy printed after the file name (timestamp, teams, map, score). */
  info: string;
}

/**
 * Parses matchzy_listbackups output. Each line is either
 * "<file> <timestamp> <team1> <team2> <map> <score1> <score2>" or a full path to the file;
 * RCON output can also contain CR characters, padding bytes and message lines.
 * @param output - Raw RCON output.
 * @returns Backups, newest round first.
 */
export function parseBackupList(output: string): BackupEntry[] {
  const backups = new Map<string, BackupEntry>();
  for (const rawLine of output.split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    const line = rawLine.replace(/[\x00-\x1f\x7f]/g, "").trim();
    const firstToken = line.split(/\s+/)[0] ?? "";
    const file = firstToken.split(/[\\/]/).pop() ?? "";
    const match = MATCHZY_BACKUP_FILE.exec(file);
    if (!match || backups.has(file)) continue;
    backups.set(file, {
      file,
      map_number: parseInt(match[2]),
      round: parseInt(match[3]),
      info: line.slice(firstToken.length).trim()
    });
  }
  return [...backups.values()].sort((a, b) => b.map_number - a.map_number || b.round - a.round);
}

export interface StatusPlayer {
  /** The id `kickid` takes. */
  userid: number;
  name: string;
  /** Null for bots. */
  ping: number | null;
  /** active, spawning, connecting, ... */
  state: string;
  bot: boolean;
}

const PLAYER_STATES = /^(active|spawning|spawned|connecting|connected|challenging|loading|new)$/i;

/**
 * The players section of CS2's `status` ("id time ping loss state rate adr 'name'" rows between
 * "---------players--------" and "#end"). CS2 doesn't print Steam IDs there. Slot 65535 (an unfilled or GOTV
 * slot) and rows without a name are skipped.
 */
export function parseStatusPlayers(output: string): StatusPlayer[] {
  const players: StatusPlayer[] = [];
  let inPlayers = false;
  for (const rawLine of output.split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    const line = rawLine.replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (/^-+\s*players\s*-+$/i.test(line)) {
      inPlayers = true;
      continue;
    }
    if (!inPlayers) continue;
    if (line.startsWith("#end")) break;
    const row = /^(\d+)\s+(.*?)\s*'(.*)'$/.exec(line);
    if (!row) continue;
    const userid = parseInt(row[1]);
    const name = row[3];
    if (userid === 65535 || !name) continue;
    const fields = row[2].split(/\s+/);
    const bot = fields.includes("BOT");
    const ping = bot ? null : parseInt(fields[1] ?? "");
    players.push({
      userid,
      name,
      ping: ping === null || Number.isNaN(ping) ? null : ping,
      state: fields.find((field) => PLAYER_STATES.test(field))?.toLowerCase() ?? "",
      bot
    });
  }
  return players;
}

/**
 * Creates a new server object to run various tasks.
 * @class
 */
class ServerRcon {
  host: string;
  port: number;
  password: string;
  rcon: Rcon;

  /**
   * Represents a game server.
   * @constructor
   * @param {string} hostName - IP String or host of server.
   * @param {number} portNumber - Integer port number of the server.
   * @param {string} rconPassword - Rcon password of the server, encrypted.
   */
  constructor(hostName: string, portNumber: number, rconPassword: string) {
    this.host = hostName;
    this.port = portNumber;
    this.password = Utils.decrypt(rconPassword)!;
    this.rcon = new Rcon({
      host: this.host,
      port: this.port,
      password: this.password,
    });
  }

  /**
   * @param quiet - Background probes (heartbeat, server sweep) report a server going down once themselves, so
   *   their failures are only logged at debug level here.
   */
  async execute(commandString: string, quiet = false): Promise<string> {
    try {
      await this.rcon.connect();
      return await this.rcon.send(commandString);
    } catch (error) {
      if (quiet) logger.debug({ err: error, host: this.host, port: this.port }, "[RCON] Probe failed");
      else logger.error({ err: error }, "[RCON] Got error");
      throw error;
    } finally {
      try {
        this.rcon.disconnect();
      } catch {
        // Already closed.
      }
    }
  }

  /**
   * Runs a command that replies with JSON (get5_status, get5_web_available).
   * @returns The parsed reply, or null if the command is unknown or the reply isn't JSON.
   */
  private async executeJson(commandString: string, quiet = false): Promise<any> {
    const response: string = await this.execute(commandString, quiet);
    const start = response.indexOf("{");
    if (start < 0) return null;
    try {
      return JSON.parse(response.slice(start, response.lastIndexOf("}") + 1));
    } catch {
      return null;
    }
  }

  /**
   * MatchZy's get5_status: gamestate, matchid, map_number, team scores...
   * @param quiet - A background probe: a connection failure isn't logged as an error (see execute).
   * @returns The status, or null if MatchZy isn't answering.
   */
  async getMatchStatus(quiet = false): Promise<any> {
    if (process.env.NODE_ENV === "test") {
      return null;
    }
    return this.executeJson("get5_status", quiet);
  }

  /**
   * Retrieve the plugin version from the server (MatchZy reports a Get5-compatible version).
   * @returns The version of the plugin if found, unknown otherwise.
   */
  async getGet5Version(): Promise<string> {
    const status = await this.getMatchStatus();
    return status?.plugin_version ?? "unknown";
  }

  /**
   * Checks that MatchZy is running and has no match loaded.
   * @function
   */
  async isGet5Available(): Promise<boolean> {
    try {
      if (process.env.NODE_ENV === "test") {
        return false;
      }
      const available = await this.executeJson("get5_web_available");
      if (available == null) {
        logger.info("MatchZy did not answer get5_web_available; is the plugin installed?");
        return false;
      }
      if (available.gamestate != 0) {
        logger.info("Server already has a match loaded.");
        return false;
      }
      return true;
    } catch (err) {
      logger.error({ err }, "Error on isAvailable server");
      throw err;
    }
  }

  /**
   * Checks that MatchZy answers on the game server (its get5_web_available command).
   * @function
   */
  async isServerAlive(): Promise<boolean> {
    try {
      if (process.env.NODE_ENV === "test") {
        return false;
      }
      let get5Status = await this.execute("net_public_adr");
      return get5Status != "";
    } catch (err) {
      logger.error({ err }, "Error on game server");
      return false;
    }
  }

  /**
   * Checks if the server is up to date via a steam API call.
   * @returns True if up to date, false otherwise.
   */
  async isServerUpToDate(): Promise<boolean> {
    try {
      if (process.env.NODE_ENV === "test") {
        return false;
      }
      let serverResponse: string = await this.execute("status");
      let serverVersion: string | undefined = serverResponse.match(/(?<=\/)\d+/)?.toString();

      if (!serverVersion) {
        throw new Error("Failed to extract server version from response.");
      }

      let response = await fetch(
        `https://api.steampowered.com/ISteamApps/UpToDateCheck/v0001/?appid=730&version=${serverVersion}&format=json`
      );

      
      let data: SteamApiResponse = await response.json() as SteamApiResponse;
      if (!data.response.up_to_date) {
        logger.warn(
          `Server is not up to date! Current version: ${serverVersion} - Latest version: ${data.response.required_version}`
        );
        return false;
      } else {
        return true;
      }
    } catch (err) {
      logger.error({ err }, "Error on game server");
      return false;
    }
  }

  /**
   * Sends out an rcon command that is passed in. Returns results to be parsed.
   * @function
   * @param rconCommandString - The rcon command being passed to the server.
   * @returns response from the server.
   */
  async sendRconCommand(rconCommandString: string): Promise<string> {
    try {
      if (process.env.NODE_ENV === "test") {
        return "Cannot send rcon commands in a test instance, please use development or production instead.";
      }
      let returnValue = await this.execute(rconCommandString);
      return returnValue;
    } catch (err) {
      logger.error({ err }, "Error on sendRCON to server");
      throw err;
    }
  }

  /**
   * Sets the given URL and API key for a match
   * @function
   * @param get5URLString - The URL MatchZy loads the match config from (GET /matches/:id/config).
   * @param get5APIKeyString - The string API key for the game server to authenticate.
   * @returns True if we set everything, false on failure, throw error if there is a problem.
   */
  async prepareGet5Match(
    get5URLString: string,
    get5APIKeyString: string
  ): Promise<boolean> {
    try {
      if (process.env.NODE_ENV === "test") {
        return false;
      }
      safeRconArg(get5URLString, "match config URL", 512);
      safeRconArg(get5APIKeyString, "match API key");
      const expectedMatchId: string | undefined = /\/matches\/(\d+)\/config/.exec(get5URLString)?.[1];
      const loadMatchResponse: string = await this.execute(
        `matchzy_loadmatch_url "${get5URLString}" "Authorization" "${get5APIKeyString}"`
      );
      // MatchZy only replies on failure (match already set up, invalid URL, HTTP error, invalid config).
      if (/already|invalid|failed|error/i.test(loadMatchResponse)) {
        logger.error("MatchZy refused the match config: " + loadMatchResponse.trim());
        return false;
      }
      // The download and validation happen on the game server; confirm the match actually loaded.
      for (let attempt = 0; attempt < 10; attempt++) {
        const status = await this.getMatchStatus();
        if (status && status.gamestate !== "none" && String(status.matchid) === expectedMatchId) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      logger.error(`MatchZy did not load match ${expectedMatchId}; check the game server's MatchZy log.`);
      return false;
    } catch (err) {
      logger.error({ err }, "Error on preparing match to server");
      throw err;
    }
  }

  /**
   * Function that will call a match to an end, if it has not been completed normally.
   * @function
   * @param winner - "team1" or "team2" to end with that team as the winner (forfeit); omit to end without a winner.
   * @returns True if we succeed, false otherwise.
   */
  async endGet5Match(winner?: "team1" | "team2"): Promise<boolean> {
    try {
      if (process.env.NODE_ENV === "test") {
        return false;
      }
      const response = await this.execute(winner ? `css_endmatch ${winner}` : "css_endmatch");
      // MatchZy prints a usage hint or "no match" message when it refuses; success prints nothing to the console.
      if (/usage|unknown command|no match/i.test(response)) {
        logger.error("MatchZy refused to end the match: " + response.trim());
        return false;
      }
      return true;
    } catch (err) {
      logger.error({ err }, "RCON error on ending match");
      return false;
    }
  }

  /**
   * Function that will call a pause to the current match. This acts as an admin pause, and will have no time limit.
   * @function
   * @returns True if we succeed, false otherwise.
   */
  async pauseMatch(): Promise<boolean> {
    try {
      if (process.env.NODE_ENV === "test") {
        return false;
      }
      await this.execute("css_forcepause");
      return true;
    } catch (err) {
      logger.error({ err }, "RCON error on pause");
      return false;
    }
  }

  /**
   * Function that will call an unpause to the current match. This acts as an admin pause, and will have no time limit.
   * @function
   * @returns True if we succeed, false otherwise.
   */
  async unpauseMatch(): Promise<boolean> {
    try {
      if (process.env.NODE_ENV === "test") {
        return false;
      }
      await this.execute("css_forceunpause");
      return true;
    } catch (err) {
      logger.error({ err }, "RCON error on unpause server");
      return false;
    }
  }

  /**
   * Adds a user to a given team.
   * @function
   * @param {String} teamString - Either team1 or team2.
   * @param {String} steamId - Formatted Steam64 ID.
   * @param {String} [nickName] - Optional nickname for a given steam ID.
   * @returns Returns the response from the server.
   */
  async addUser(teamString: string, steamId: string, nickName: string | null = null): Promise<string> {
    try {
      if (!["team1", "team2", "spec"].includes(teamString)) {
        throw new RconArgumentError("Invalid team.");
      }
      safeSteamId(steamId);
      if (nickName) safeRconArg(nickName, "nickname", 64);
      if (process.env.NODE_ENV === "test") {
        return "Cannot add user on a test instance. Please use a development or production environment.";
      }
      let loadMatchResponse: string;
      if (nickName)
        loadMatchResponse = await this.execute(
          `matchzy_addplayer ${steamId} ${teamString} "${nickName}"`
        );
      else
        loadMatchResponse = await this.execute(
          `matchzy_addplayer ${steamId} ${teamString}`
        );
      return loadMatchResponse;
    } catch (err) {
      logger.error({ err }, "RCON error on addUser");
      throw err;
    }
  }

  /**
   * Adds a coach to a given team.
   * @function
   * @param {String} teamString - Either team1 or team2.
   * @param {String} steamId - Formatted Steam64 ID.
   * @returns Returns the response from the server.
   */
  async addCoach(teamString: string, steamId: string): Promise<string> {
    try {
      if (!["team1", "team2"].includes(teamString)) {
        throw new RconArgumentError("Invalid team.");
      }
      safeSteamId(steamId);
      if (process.env.NODE_ENV === "test") {
        return "Cannot add coaches on a test instance. Please use a development or production environment.";
      }
      // MatchZy has no add-coach command: a coach must be a listed team member and types .coach in game.
      let loadMatchResponse = await this.execute(`matchzy_addplayer ${steamId} ${teamString}`);
      return (
        loadMatchResponse +
        (loadMatchResponse.trim() ? "\n" : "") +
        "Added to the team. The coach must type .coach in game to take the coach slot."
      );
    } catch (err) {
      logger.error({ err }, "RCON error on addCoach");
      throw err;
    }
  }

  /**
   * Removes a user from the match.
   * @function
   * @param {String} steamId - Formatted Steam64 ID.
   * @returns Returns the response from the server.
   */
  async removeUser(steamId: string): Promise<string> {
    try {
      safeSteamId(steamId);
      if (process.env.NODE_ENV === "test") {
        return "Cannot remove users on a test instance. Please use a development or production environment.";
      }
      let loadMatchResponse = await this.execute(`matchzy_removeplayer ${steamId}`);
      return loadMatchResponse;
    } catch (err) {
      logger.error({ err }, "RCON error on removeUser");
      throw err;
    }
  }

  /**
   * Retrieves the list of round backups for a match on the game server.
   * @function
   * @param {String|Number} matchId - The match ID to list backups for.
   * @returns The parsed backups, newest first.
   */
  async getBackups(matchId: string | number): Promise<BackupEntry[]> {
    try {
      if (process.env.NODE_ENV === "test") {
        return [];
      }
      const id = parseInt(String(matchId));
      if (isNaN(id)) throw new RconArgumentError("Invalid match ID.");
      let listResponse = await this.execute(`matchzy_listbackups ${id}`);
      return parseBackupList(listResponse);
    } catch (err) {
      logger.error({ err }, "RCON error on getBackups");
      throw err;
    }
  }

  /**
   * Attempts to restore a given backup on the server
   * @function
   * @param {String} backupName - The filename of the backup on the server, as returned by getBackups.
   * @returns Returns the response from the server.
   */
  async restoreBackup(backupName: string): Promise<string> {
    try {
      const command: string = backupLoadCommand(backupName);
      if (process.env.NODE_ENV === "test") {
        return "Cannot restore backups on a test instance. Please use a development or production environment.";
      }
      let loadMatchResponse = await this.execute(command);
      return loadMatchResponse;
    } catch (err) {
      logger.error({ err }, "RCON error on restore backup");
      throw err;
    }
  }

  /**
   * Sets cvars on the running server (e.g. the callback URLs after the API's address changed).
   * Names and values go through the same checks as every other RCON argument.
   * @function
   * @param {Object} cvars - { cvar_name: value }
   * @returns The server's replies.
   */
  async setCvars(cvars: Record<string, string>): Promise<string> {
    const replies: string[] = [];
    for (const [name, value] of Object.entries(cvars)) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new RconArgumentError(`Invalid cvar name: ${name}`);
      safeRconArg(value, name, 512);
      if (process.env.NODE_ENV === "test") continue;
      replies.push(await this.execute(`${name} "${value}"`));
    }
    return replies.filter(Boolean).join(" ");
  }

  /**
   * Attempts to restore a given backup from the API to a new server.
   * @function
   * @param {String} backupUrl - The URL of the backup on the API.
   * @param {String} matchApiKey - The match API key, sent as the Authorization header when the server downloads it.
   * @returns Returns the response from the server.
   */
  async restoreBackupFromURL(backupUrl: string, matchApiKey: string): Promise<string> {
    try {
      safeRconArg(backupUrl, "backup URL", 512);
      safeRconArg(matchApiKey, "match API key");
      if (process.env.NODE_ENV === "test") {
        return "Cannot restore backups on a test instance. Please use a development or production environment.";
      }
      let loadMatchResponse = await this.execute(
        `matchzy_loadbackup_url "${backupUrl}" "Authorization" "${matchApiKey}"`
      );
      return loadMatchResponse;
    } catch (err) {
      logger.error({ err }, "RCON error on restore backup");
      throw err;
    }
  }
}

export default ServerRcon;
