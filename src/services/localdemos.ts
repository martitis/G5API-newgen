/** Demos read in place from the game servers' demo folder (server.localDemoDir), when the game servers run on
 * the same machine as the API: no upload and no copy. The folder should be mounted read-only for the API
 * (DEPLOY.md: a read-only bind mount of MatchZy's demo folder). Nothing here ever writes or deletes in it.
 *
 * A sweep links each finished map to its demo (MatchZy names them "{TIME}_{MATCH_ID}_{MAP}_{TEAM1}_vs_{TEAM2}"),
 * and marks a linked demo "archived" once it's gone from the folder (cs2manager.sh archive).
 * @module services/localdemos
 */
import config from "config";
import { readdir, stat } from "fs/promises";
import path from "path";
import { RowDataPacket } from "mysql2";
import { db } from "./db.js";
import GlobalEmitter from "../utility/emitter.js";
import logger from "../utility/logger.js";

/** A demo still being written (SourceTV flushes at map end, after tv_delay) is only linked once it's this quiet. */
export const SETTLE_MS = 60_000;

export interface DemoEntry {
  name: string;
  size: number;
  mtimeMs: number;
}

/** The configured folder (absolute), or "" when local demos are off. */
export function localDemoDir(): string {
  const dir = config.has("server.localDemoDir") ? String(config.get("server.localDemoDir") ?? "").trim() : "";
  return dir && path.isAbsolute(dir) ? dir : "";
}

/** A plain demo file name: no folder part, not hidden, ends in .dem. MatchZy names can hold any letters. */
export const isDemoName = (name: string): boolean =>
  /\.dem$/i.test(name) && !name.startsWith(".") && !/[/\\\0]/.test(name) && name === path.basename(name);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The demo of one map: the name holds "<match id>_<map name>" as whole parts (so match 12 never takes match 112's
 * demo), and it's finished writing. A map restarted on the server leaves several; the biggest is the full one.
 */
export function demoFileFor(
  files: DemoEntry[],
  matchId: number,
  mapName: string,
  now = Date.now()
): string | null {
  if (!mapName) return null;
  const pattern = new RegExp(`(?:^|_)${matchId}_${escapeRegExp(mapName)}(?:_|\\.dem$)`, "i");
  const found = files
    .filter((file) => isDemoName(file.name) && pattern.test(file.name) && now - file.mtimeMs >= SETTLE_MS)
    .sort((a, b) => b.size - a.size);
  return found[0]?.name ?? null;
}

/** The demos in the folder, or null when it can't be read (not mounted, no permission). */
async function listDemos(dir: string): Promise<DemoEntry[] | null> {
  try {
    const names = (await readdir(dir)).filter(isDemoName);
    const entries: DemoEntry[] = [];
    for (const name of names) {
      try {
        const info = await stat(path.join(dir, name));
        if (info.isFile()) entries.push({ name, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // Removed while listing (archived): not there.
      }
    }
    return entries;
  } catch (err) {
    logger.warn({ err, dir }, "Local demo folder can't be read; demos aren't linked");
    return null;
  }
}

/** Links finished maps to their demo, and marks linked demos that are gone as archived. */
export async function syncLocalDemos(): Promise<void> {
  const dir = localDemoDir();
  if (!dir) return;
  const files = await listDemos(dir);
  if (!files) return;
  const present = new Set(files.map((file) => file.name));
  let changed = false;

  // Finished maps without a demo (also ones marked archived: a restored demo comes back).
  const waiting: RowDataPacket[] = await db.query(
    "SELECT id, match_id, map_name FROM map_stats WHERE demoFile IS NULL AND end_time IS NOT NULL " +
      "AND (demo_status IS NULL OR demo_status = 'archived') ORDER BY id DESC LIMIT 1000"
  );
  for (const row of waiting) {
    const name = demoFileFor(files, Number(row.match_id), String(row.map_name ?? ""));
    if (!name) continue;
    const result: any = await db.query(
      "UPDATE map_stats SET demoFile = ?, demo_status = NULL WHERE id = ? AND demoFile IS NULL",
      [name, row.id]
    );
    if (result.affectedRows) changed = true;
  }

  // Local demos (.dem; uploaded ones are .zip in public/demos) that have left the folder.
  const linked: RowDataPacket[] = await db.query(
    "SELECT id, demoFile FROM map_stats WHERE demoFile LIKE '%.dem'"
  );
  const gone = linked.filter((row) => !present.has(String(row.demoFile)));
  // An empty folder while demos are linked is far more likely a missing mount than everything archived at once.
  if (gone.length && files.length === 0) {
    logger.warn({ dir, linked: linked.length }, "Local demo folder is empty; not marking demos archived (is it mounted?)");
  } else {
    for (const row of gone) {
      await db.query("UPDATE map_stats SET demoFile = NULL, demo_status = 'archived' WHERE id = ? AND demoFile = ?", [
        row.id,
        row.demoFile
      ]);
      changed = true;
    }
  }
  if (changed) GlobalEmitter.emit("mapStatUpdate");
}

/** The absolute path of a local demo to send, or null (bad name, not in the folder). */
export async function localDemoPath(name: string): Promise<string | null> {
  const dir = localDemoDir();
  if (!dir || !isDemoName(name)) return null;
  const file = path.join(dir, name);
  // path.join with a plain base name can't leave the folder; checked anyway.
  if (path.dirname(file) !== path.resolve(dir)) return null;
  try {
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** Links demos at once, then every 2 minutes. */
export function startLocalDemoSweep(intervalMs = 120_000): NodeJS.Timeout | null {
  if (!localDemoDir()) return null;
  const run = () => syncLocalDemos().catch((err) => logger.error({ err }, "Local demo sweep failed"));
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
