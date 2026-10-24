/** The admin match control center: each action of the panel and the MatchZy RCON command it sends.
 * Checked against MatchZy's source: its css_* commands treat the server console (RCON) as an admin, and
 * css_team1/css_team2/css_asay read their text raw (ArgString), so that text is sent unquoted.
 * @module utility/matchcontrol
 */
import { RconArgumentError, safeRconArg } from "./serverrcon.js";

/** Live cvars the panel may change, with the values each accepts. */
export const LIVE_CVARS: Record<string, { min: number; max: number }> = {
  mp_maxrounds: { min: 2, max: 60 },
  mp_overtime_enable: { min: 0, max: 1 },
  mp_overtime_maxrounds: { min: 2, max: 12 },
  mp_freezetime: { min: 0, max: 60 },
  mp_team_timeout_max: { min: 0, max: 10 },
  mp_team_timeout_time: { min: 10, max: 300 },
  matchzy_enable_tech_pause: { min: 0, max: 1 },
  matchzy_stop_command_available: { min: 0, max: 1 },
  matchzy_pause_after_restore: { min: 0, max: 1 }
};

export const CONTROL_ACTIONS = [
  "start",
  "skip_veto",
  "toggle_knife",
  "toggle_playout",
  "toggle_whitelist",
  "change_map",
  "team_name",
  "say",
  "cvar"
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

const integer = (value: unknown, min: number, max: number, label: string): number => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RconArgumentError(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return parsed;
};

/** Text MatchZy reads raw: no quotes, semicolons or line breaks, and a length limit. */
const text = (value: unknown, label: string, maxLength: number): string => {
  const trimmed = typeof value === "string" ? value.trim() : value;
  return safeRconArg(trimmed, label, maxLength);
};

/**
 * The RCON command for a control action.
 * @param args - action arguments: count, seconds, map, team (1|2), name, message, cvar, value
 * @throws RconArgumentError for unknown actions or invalid arguments.
 */
export function controlCommand(action: unknown, args: Record<string, unknown> = {}): string {
  switch (action as ControlAction) {
    case "start":
      return "css_start";
    case "skip_veto":
      return "css_skipveto";
    case "toggle_knife":
      return "css_roundknife";
    case "toggle_playout":
      return "css_playout";
    case "toggle_whitelist":
      return "css_whitelist";
    case "change_map": {
      const map = typeof args.map === "string" ? args.map.trim() : "";
      if (!/^[A-Za-z0-9_./-]{1,128}$/.test(map)) throw new RconArgumentError("Invalid map name.");
      return `css_map ${map}`;
    }
    case "team_name": {
      const team = integer(args.team, 1, 2, "Team");
      return `css_team${team} ${text(args.name, "team name", 32)}`;
    }
    case "say":
      return `css_asay ${text(args.message, "message", 120)}`;
    case "cvar": {
      const name = typeof args.cvar === "string" ? args.cvar : "";
      const limits = LIVE_CVARS[name];
      if (!limits) throw new RconArgumentError("This cvar can't be changed from the panel.");
      return `${name} ${integer(args.value, limits.min, limits.max, name)}`;
    }
    default:
      throw new RconArgumentError("Unknown control action.");
  }
}
