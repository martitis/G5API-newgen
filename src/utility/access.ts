/** Who is making a request, and whether they may change anything.
 * - The signed-in user is reloaded from the database on every request, so a role a super admin changes (or a
 *   deleted account) applies at once instead of at the next login.
 * - Writes are deny by default: every POST/PUT/PATCH/DELETE needs a signed-in admin, except the short allowlist
 *   below (signing in, game-server callbacks, joining PUG queues, your own account). Routes keep their own
 *   owner/admin checks on top of this.
 * - The admin config lists are read from the config file at each Steam login, so editing them needs no restart.
 * @module utility/access
 */
import { readFileSync } from "fs";
import { join } from "path";
import config from "config";
import { NextFunction, Request, Response } from "express";
import { RowDataPacket } from "mysql2";
import { db } from "../services/db.js";
import Utils from "./utils.js";

/** The session user: what the API and panel need, never secrets other than the user's own API key. */
export interface SessionUser {
  id: number;
  steam_id: string | null;
  name: string;
  admin: number;
  super_admin: number;
  steam_verified: number;
  small_image: string | null;
  medium_image: string | null;
  large_image: string | null;
  /** "<id>:<key>", for the user's own profile page. */
  api_key: string;
}

/**
 * The user as stored now. An account with a Steam ID that was never proven by a Steam login (a local account that
 * claimed it: steam_verified = 0) never counts as an admin, whatever its flags say: the ID may be someone else's.
 * Accounts without a Steam ID can hold roles a super admin gives them (they can't pass as anyone).
 * @returns null when the account no longer exists.
 */
export async function loadUser(id: unknown): Promise<SessionUser | null> {
  const userId = Number(id);
  if (!Number.isInteger(userId) || userId < 1) return null;
  const rows: RowDataPacket[] = await db.query(
    "SELECT id, steam_id, name, admin, super_admin, steam_verified, small_image, medium_image, large_image, api_key " +
      "FROM user WHERE id = ?",
    [userId]
  );
  const row = rows[0];
  if (!row) return null;
  const verified = Number(row.steam_verified) > 0;
  const mayHoldRoles = canHoldRoles(row);
  return {
    id: row.id,
    steam_id: row.steam_id ?? null,
    name: row.name,
    admin: mayHoldRoles && Number(row.admin) > 0 ? 1 : 0,
    super_admin: mayHoldRoles && Number(row.super_admin) > 0 ? 1 : 0,
    steam_verified: verified ? 1 : 0,
    small_image: row.small_image ?? null,
    medium_image: row.medium_image ?? null,
    large_image: row.large_image ?? null,
    api_key: row.id + ":" + (Utils.decrypt(row.api_key) ?? "")
  };
}

/** Whether an account may be an admin: its Steam ID was proven by a Steam login, or it has none. */
export function canHoldRoles(row: Record<string, any>): boolean {
  return Number(row.steam_verified) > 0 || row.steam_id == null || row.steam_id === "";
}

/** The user an API key ("<id>:<key>", header user-api or body[0].user_api) belongs to, or null. */
export async function userFromApiKey(apiKey: unknown): Promise<SessionUser | null> {
  if (typeof apiKey !== "string" || !apiKey.includes(":")) return null;
  const [userId, providedKey] = apiKey.split(":");
  const rows: RowDataPacket[] = await db.query("SELECT api_key FROM user WHERE id = ?", [userId]);
  if (!rows.length || !Utils.safeCompare(Utils.decrypt(rows[0].api_key), providedKey)) return null;
  return loadUser(userId);
}

/** Sets req.user for API-key requests (sessions are already resolved by passport, see auth.ts). */
export async function resolveUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const apiKey = req.get("user-api") || (Array.isArray(req.body) ? req.body[0]?.user_api : undefined);
    if (apiKey) {
      const user = await userFromApiKey(apiKey);
      if (!user) {
        res.status(401).json({ message: "Invalid API key." });
        return;
      }
      req.user = user as unknown as Express.User;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Writes anyone signed in (or the game server) may make; everything else needs an admin. */
const OPEN_WRITES: Array<{ method: string; path: RegExp; signedIn: boolean }> = [
  // Signing in and out.
  { method: "POST", path: /^\/(login|register)\/?$/, signedIn: false },
  { method: "POST", path: /^\/logout\/?$/, signedIn: false },
  // MatchZy's callbacks (events, demos, backups) authenticate with the match API key.
  { method: "POST", path: /^\/v2(\/(demo|backup))?\/?$/, signedIn: false },
  // Taking part in a PUG queue.
  { method: "POST", path: /^\/pugs\/\d+\/(join|leave|ready)\/?$/, signedIn: true },
  // Your own account (password, local login, API key); the route refuses other users' accounts.
  { method: "PUT", path: /^\/users\/?$/, signedIn: true }
];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when the request may go on to its route; otherwise the reply is already sent (401 / 403). */
export function writeAllowed(method: string, path: string, user: { admin?: unknown; super_admin?: unknown } | undefined) {
  if (READ_METHODS.has(method)) return { ok: true as const };
  const open = OPEN_WRITES.find((rule) => rule.method === method && rule.path.test(path));
  if (open && !open.signedIn) return { ok: true as const };
  if (!user) return { ok: false as const, status: 401, message: "Not logged in." };
  if (open) return { ok: true as const };
  if (!Utils.adminCheck(user as Express.User)) {
    return { ok: false as const, status: 403, message: "Only admins can change things on this panel." };
  }
  return { ok: true as const };
}

/** Deny-by-default guard for every write route (mounted in app.ts before the routers). */
export function writeGuard(req: Request, res: Response, next: NextFunction): void {
  const verdict = writeAllowed(req.method, req.path, req.user);
  if (!verdict.ok) {
    res.status(verdict.status).json({ message: verdict.message });
    return;
  }
  next();
}

/**
 * The admins / super_admins Steam ID lists, read from the config file now (not the copy loaded at startup), so
 * editing them takes effect at the next Steam login without restarting the API.
 */
export function configRoleLists(): { admins: string[]; superAdmins: string[] } {
  const env = process.env.NODE_ENV || "development";
  const dir = process.env.NODE_CONFIG_DIR || join(process.cwd(), "config");
  let file: Record<string, any> = {};
  try {
    file = JSON.parse(readFileSync(join(dir, `${env}.json`), "utf8"));
  } catch {
    // No readable file (e.g. settings from environment variables): use the values loaded at startup.
  }
  const list = (fromFile: unknown, key: string) => {
    const value = typeof fromFile === "string" ? fromFile : config.has(key) ? config.get<string>(key) : "";
    return String(value)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => Utils.isSteamId64(id));
  };
  return {
    admins: list(file.admins?.steam_ids, "admins.steam_ids"),
    superAdmins: list(file.super_admins?.steam_ids, "super_admins.steam_ids")
  };
}
