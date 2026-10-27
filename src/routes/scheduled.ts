/** Scheduled matches: created by the API at the chosen time.
 * @module routes/scheduled
 */
import { Router } from "express";
import { RowDataPacket } from "mysql2";
import { db } from "../services/db.js";
import Utils from "../utility/utils.js";
import { audited, firstBody } from "../utility/audit.js";
import { runScheduled } from "../services/scheduler.js";

const router = Router();

const MAX_DAYS_AHEAD = 60;

/** run_at as an ISO time in UTC (DATETIME columns come back in the server's zone otherwise). */
const SELECT =
  "SELECT s.id, s.user_id, u.name AS owner, DATE_FORMAT(s.run_at, '%Y-%m-%dT%H:%i:%sZ') AS run_at, s.status, " +
  "s.match_id, s.error, s.body FROM scheduled_match s LEFT JOIN user u ON u.id = s.user_id";

const shape = (row: RowDataPacket) => {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(String(row.body)) as Record<string, unknown>;
  } catch {
    // shown without details
  }
  return {
    id: row.id,
    user_id: row.user_id,
    owner: row.owner,
    run_at: row.run_at,
    status: row.status,
    match_id: row.match_id,
    error: row.error,
    title: body.title ?? null,
    team1_id: body.team1_id ?? null,
    team2_id: body.team2_id ?? null,
    server_id: body.server_id ?? null,
    max_maps: body.max_maps ?? null
  };
};

async function ownEntry(req: any, res: any): Promise<RowDataPacket | null> {
  const rows: RowDataPacket[] = await db.query("SELECT * FROM scheduled_match WHERE id = ?", [req.params.schedule_id]);
  if (!rows.length) {
    res.status(404).json({ message: "Scheduled match not found." });
    return null;
  }
  if (rows[0].user_id !== req.user.id && !Utils.adminCheck(req.user)) {
    res.status(403).json({ message: "User is not authorized to perform action." });
    return null;
  }
  return rows[0];
}

/**
 * @swagger
 *
 * /scheduled:
 *   get:
 *     description: >
 *       Scheduled matches that are waiting, running or failed, plus the last 20 loaded or cancelled ones. Admins see
 *       their own; super admins see everyone's.
 *     tags:
 *       - scheduled
 *     responses:
 *       200:
 *         description: "{ scheduled: [{ id, run_at, status, match_id, error, title, team1_id, team2_id, ... }] }"
 */
router.get("/", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    const everyone = Utils.adminCheck(req.user!);
    const scope = everyone ? "" : "s.user_id = ? AND ";
    const args = everyone ? [] : [req.user!.id];
    const open: RowDataPacket[] = await db.query(
      `${SELECT} WHERE ${scope}s.status IN ('pending', 'running', 'failed') ORDER BY s.run_at`,
      args
    );
    const done: RowDataPacket[] = await db.query(
      `${SELECT} WHERE ${scope}s.status IN ('loaded', 'cancelled') ORDER BY s.run_at DESC LIMIT 20`,
      args
    );
    res.json({ scheduled: [...open, ...done].map(shape) });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /scheduled:
 *   post:
 *     description: >
 *       Schedules a match (admins only). Body - run_at (ISO time, in the next 60 days) and match (the POST /matches
 *       body; server_id may be empty for the first free server at that time). The match is created with the same
 *       checks as POST /matches when it is due; a failure is kept with its reason and can be retried.
 *     tags:
 *       - scheduled
 *     responses:
 *       200:
 *         description: "{ message, id }"
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       412:
 *         description: Invalid time, teams or cvars.
 */
router.post(
  "/",
  Utils.ensureAuthenticated,
  audited("match.schedule", {
    target: (req, body) => ({ type: "scheduled", id: body?.id ?? null }),
    detail: (req) => String(firstBody(req).run_at ?? "")
  }),
  async (req, res, next) => {
    try {
      if (!Utils.adminCheck(req.user!)) {
        res.status(403).json({ message: "Only admins can create matches." });
        return;
      }
      const body = firstBody(req);
      const runAt = new Date(String(body.run_at ?? ""));
      const now = Date.now();
      if (Number.isNaN(runAt.getTime()) || runAt.getTime() < now - 60000 || runAt.getTime() > now + MAX_DAYS_AHEAD * 86400000) {
        res.status(412).json({ message: `Choose a time in the next ${MAX_DAYS_AHEAD} days.` });
        return;
      }
      const match = body.match && typeof body.match === "object" ? (body.match as Record<string, unknown>) : null;
      if (!match || !match.team1_id || !match.team2_id || match.team1_id === match.team2_id) {
        res.status(412).json({ message: "Choose two different teams." });
        return;
      }
      const cvarError = Utils.validateCvars(match.match_cvars);
      if (cvarError) {
        res.status(412).json({ message: cvarError });
        return;
      }
      // Tournament and PUG matches have their own flow.
      delete match.tournament_match_id;
      delete match.is_pug;
      const insert: any = await db.query("INSERT INTO scheduled_match (user_id, run_at, body) VALUES (?, ?, ?)", [
        req.user!.id,
        runAt.toISOString().slice(0, 19).replace("T", " "),
        JSON.stringify(match)
      ]);
      res.json({ message: "Match scheduled.", id: insert.insertId });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 *
 * /scheduled/:schedule_id/cancel:
 *   post:
 *     description: Cancels a waiting or failed scheduled match (owner or super admin). Also /run - create it now.
 *     tags:
 *       - scheduled
 *     responses:
 *       200:
 *         description: Done.
 *       409:
 *         description: Already loaded, running or cancelled.
 */
router.post(
  "/:schedule_id/cancel",
  Utils.ensureAuthenticated,
  audited("match.schedule_cancel", { target: (req) => ({ type: "scheduled", id: Number(req.params.schedule_id) || null }) }),
  async (req, res, next) => {
    try {
      const entry = await ownEntry(req, res);
      if (!entry) return;
      const update: any = await db.query(
        "UPDATE scheduled_match SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'failed')",
        [entry.id]
      );
      if (!update.affectedRows) {
        res.status(409).json({ message: "This scheduled match can't be cancelled any more." });
        return;
      }
      res.json({ message: "Scheduled match cancelled." });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:schedule_id/run",
  Utils.ensureAuthenticated,
  audited("match.schedule_run", { target: (req) => ({ type: "scheduled", id: Number(req.params.schedule_id) || null }) }),
  async (req, res, next) => {
    try {
      const entry = await ownEntry(req, res);
      if (!entry) return;
      if (!["pending", "failed"].includes(entry.status)) {
        res.status(409).json({ message: "This scheduled match already ran." });
        return;
      }
      await runScheduled(entry.id);
      const rows: RowDataPacket[] = await db.query(`${SELECT} WHERE s.id = ?`, [entry.id]);
      res.json({ message: rows[0]?.status === "loaded" ? "Match created." : "The match could not be created.", scheduled: shape(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
