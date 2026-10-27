/** Tournaments: brackets and groups whose matches are created from their slots and advance on results.
 * @module routes/tournaments
 */
import { Router } from "express";
import { RowDataPacket } from "mysql2";
import { db } from "../services/db.js";
import Utils from "../utility/utils.js";
import { audited, firstBody } from "../utility/audit.js";
import {
  cleanSettings,
  FORMATS,
  loadTournament,
  refreshTournament,
  startTournament
} from "../services/tournaments.js";
import type { TournamentFormat } from "../services/bracket.js";
import GlobalEmitter from "../utility/emitter.js";

import logger from "../utility/logger.js";
const router = Router();

// Every successful change reaches open bracket pages (GET /tournaments/:id/stream).
router.use((req, res, next) => {
  if (req.method !== "GET") {
    res.on("finish", () => {
      if (res.statusCode < 400) GlobalEmitter.emit("tournamentUpdate");
    });
  }
  next();
});

/** The tournament row, or a response already sent (404 / 403). Owners and super admins may change it. */
async function editableTournament(req: any, res: any): Promise<RowDataPacket | null> {
  const rows: RowDataPacket[] = await db.query("SELECT * FROM tournament WHERE id = ?", [req.params.tournament_id]);
  if (!rows.length) {
    res.status(404).json({ message: "Tournament not found." });
    return null;
  }
  if (rows[0].user_id !== req.user.id && !Utils.adminCheck(req.user)) {
    res.status(403).json({ message: "User is not authorized to perform action." });
    return null;
  }
  return rows[0];
}

/** Validates the seeded team list: 2 to 64 distinct existing teams. Returns an error message or null. */
async function checkTeams(teamIds: unknown): Promise<string | null> {
  if (!Array.isArray(teamIds) || teamIds.length < 2 || teamIds.length > 64) return "Choose between 2 and 64 teams.";
  const ids = teamIds.map((id) => Number(id));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    return "Each team can only be entered once.";
  }
  const found: RowDataPacket[] = await db.query("SELECT id FROM team WHERE id IN (?)", [ids]);
  return found.length === ids.length ? null : "A team does not exist.";
}

async function saveTeams(tournamentId: number, teamIds: number[]): Promise<void> {
  await db.query("DELETE FROM tournament_team WHERE tournament_id = ?", [tournamentId]);
  for (let index = 0; index < teamIds.length; index++) {
    await db.query("INSERT INTO tournament_team (tournament_id, team_id, seed) VALUES (?, ?, ?)", [
      tournamentId,
      teamIds[index],
      index + 1
    ]);
  }
}

/**
 * @swagger
 *
 * /tournaments:
 *   get:
 *     description: All tournaments, newest first, with their team count.
 *     produces:
 *       - application/json
 *     tags:
 *       - tournaments
 *     responses:
 *       200:
 *         description: "{ tournaments }"
 */
router.get("/", async (req, res, next) => {
  try {
    const tournaments: RowDataPacket[] = await db.query(
      "SELECT t.id, t.name, t.format, t.status, t.season_id, t.user_id, u.name AS owner, t.created_at, " +
        "(SELECT COUNT(*) FROM tournament_team tt WHERE tt.tournament_id = t.id) AS team_count " +
        "FROM tournament t LEFT JOIN user u ON u.id = t.user_id ORDER BY t.id DESC"
    );
    res.json({ tournaments });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /tournaments/:tournament_id:
 *   get:
 *     description: >
 *       A tournament with its seeded teams, bracket nodes (teams, status pending/ready/live/done/bye/empty,
 *       linked match and series score) and, for round robin and Swiss, the standings. Groups + playoff - each
 *       group node has its group number, groups holds each group's table, and the playoff (upper bracket) nodes
 *       appear once every group match is played.
 *     produces:
 *       - application/json
 *     parameters:
 *       - name: tournament_id
 *         required: true
 *         schema:
 *          type: integer
 *     tags:
 *       - tournaments
 *     responses:
 *       200:
 *         description: "{ tournament, teams, nodes, standings }"
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get("/:tournament_id", async (req, res, next) => {
  try {
    const data = await loadTournament(parseInt(req.params.tournament_id) || 0);
    if (!data) {
      res.status(404).json({ message: "Tournament not found." });
      return;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /tournaments/:tournament_id/stream:
 *   get:
 *     description: >
 *       Server sent events - "tournament" with the same data as GET /tournaments/:tournament_id, on every bracket
 *       change and match update (at most once a second).
 *     produces:
 *       - text/event-stream
 *     tags:
 *       - tournaments
 */
router.get("/:tournament_id/stream", async (req, res, next) => {
  try {
    const id = parseInt(req.params.tournament_id) || 0;
    const first = await loadTournament(id);
    if (!first) {
      res.status(404).json({ message: "Tournament not found." });
      return;
    }
    res.set({
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();
    let closed = false;
    const send = (data: unknown) => {
      if (!closed && data) res.write(`event: tournament\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let timer: NodeJS.Timeout | null = null;
    const onChange = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        loadTournament(id).then(send).catch((err) => logger.error({ err }, "Tournament stream failed"));
      }, 1000);
    };
    GlobalEmitter.on("tournamentUpdate", onChange);
    GlobalEmitter.on("matchUpdate", onChange);
    req.on("close", () => {
      closed = true;
      if (timer) clearTimeout(timer);
      GlobalEmitter.removeListener("tournamentUpdate", onChange);
      GlobalEmitter.removeListener("matchUpdate", onChange);
      res.end();
    });
    send(first);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /tournaments:
 *   post:
 *     description: >
 *       Creates a tournament in draft. Admins only (they run the matches). Body - name, format
 *       (single_elim, double_elim, round_robin, swiss, groups_playoff), season_id, team_ids (in seed order), settings
 *       (best_of, final_best_of, swiss_rounds, group_count and group_advance for groups_playoff, map_pool, players_per_team, min_players_to_ready, side_type, skip_veto,
 *       challonge_url - a Challonge tournament id that results are reported to with your Challonge API key).
 *     produces:
 *       - application/json
 *     tags:
 *       - tournaments
 *     responses:
 *       200:
 *         description: "{ message, id }"
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       412:
 *         description: Invalid name, format, teams or map pool.
 */
router.post(
  "/",
  Utils.ensureAuthenticated,
  audited("tournament.create", {
    target: (req, body) => ({ type: "tournament", id: body?.id ?? null }),
    detail: (req) => String(firstBody(req).name ?? "")
  }),
  async (req, res, next) => {
    try {
      if (!Utils.adminCheck(req.user!)) {
        res.status(403).json({ message: "Only admins can create tournaments." });
        return;
      }
      const body = firstBody(req);
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
      if (!name) {
        res.status(412).json({ message: "A name is required." });
        return;
      }
      if (!FORMATS.includes(body.format)) {
        res.status(412).json({ message: "Unknown tournament format." });
        return;
      }
      const teamError = await checkTeams(body.team_ids);
      if (teamError) {
        res.status(412).json({ message: teamError });
        return;
      }
      const settings = cleanSettings(body.settings);
      if (settings.map_pool.length < Math.max(settings.best_of, settings.final_best_of)) {
        res.status(412).json({ message: "The map pool needs at least as many maps as the longest series." });
        return;
      }
      const insert: any = await db.query(
        "INSERT INTO tournament (user_id, season_id, name, format, settings) VALUES (?, ?, ?, ?, ?)",
        [req.user!.id, body.season_id || null, name, body.format as TournamentFormat, JSON.stringify(settings)]
      );
      await saveTeams(insert.insertId, (body.team_ids as unknown[]).map(Number));
      res.json({ message: "Tournament created successfully.", id: insert.insertId });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 *
 * /tournaments/:tournament_id:
 *   put:
 *     description: >
 *       Updates a tournament. Name, season and settings can always change; format and teams only in draft.
 *       Owner or super admin.
 *     produces:
 *       - application/json
 *     tags:
 *       - tournaments
 *     responses:
 *       200:
 *         description: Updated.
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       412:
 *         description: Invalid values, or teams/format changed after the start.
 */
router.put(
  "/:tournament_id",
  Utils.ensureAuthenticated,
  audited("tournament.update", { target: (req) => ({ type: "tournament", id: Number(req.params.tournament_id) || null }) }),
  async (req, res, next) => {
    try {
      const tournament = await editableTournament(req, res);
      if (!tournament) return;
      const body = firstBody(req);
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) {
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
        if (!name) {
          res.status(412).json({ message: "A name is required." });
          return;
        }
        update.name = name;
      }
      if (body.season_id !== undefined) update.season_id = body.season_id || null;
      if (body.settings !== undefined) update.settings = JSON.stringify(cleanSettings(body.settings));
      const draft = tournament.status === "draft";
      if (body.format !== undefined || body.team_ids !== undefined) {
        if (!draft) {
          res.status(412).json({ message: "Format and teams can't change after the tournament started." });
          return;
        }
        if (body.format !== undefined) {
          if (!FORMATS.includes(body.format)) {
            res.status(412).json({ message: "Unknown tournament format." });
            return;
          }
          update.format = body.format;
        }
        if (body.team_ids !== undefined) {
          const teamError = await checkTeams(body.team_ids);
          if (teamError) {
            res.status(412).json({ message: teamError });
            return;
          }
          await saveTeams(tournament.id, (body.team_ids as unknown[]).map(Number));
        }
      }
      if (Object.keys(update).length) await db.query("UPDATE tournament SET ? WHERE id = ?", [update, tournament.id]);
      res.json({ message: "Tournament updated successfully." });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 *
 * /tournaments/:tournament_id:
 *   delete:
 *     description: Deletes a tournament (its matches stay). Owner or super admin.
 *     tags:
 *       - tournaments
 *     responses:
 *       200:
 *         description: Deleted.
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.delete(
  "/:tournament_id",
  Utils.ensureAuthenticated,
  audited("tournament.delete", { target: (req) => ({ type: "tournament", id: Number(req.params.tournament_id) || null }) }),
  async (req, res, next) => {
    try {
      const tournament = await editableTournament(req, res);
      if (!tournament) return;
      await db.query("DELETE FROM tournament WHERE id = ?", [tournament.id]);
      res.json({ message: "Tournament deleted successfully." });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 *
 * /tournaments/:tournament_id/start:
 *   post:
 *     description: Generates the bracket (Swiss - round 1) from the seeding. Owner or super admin.
 *     tags:
 *       - tournaments
 *     responses:
 *       200:
 *         description: Started.
 *       412:
 *         description: Already started, or too few teams for the format.
 */
router.post(
  "/:tournament_id/start",
  Utils.ensureAuthenticated,
  audited("tournament.start", { target: (req) => ({ type: "tournament", id: Number(req.params.tournament_id) || null }) }),
  async (req, res, next) => {
    try {
      const tournament = await editableTournament(req, res);
      if (!tournament) return;
      try {
        await startTournament(tournament.id);
      } catch (err) {
        res.status(412).json({ message: (err as Error).message });
        return;
      }
      res.json({ message: "Tournament started." });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 *
 * /tournaments/:tournament_id/refresh:
 *   post:
 *     description: Recomputes the bracket from the linked matches (normally automatic). Owner or super admin.
 *     tags:
 *       - tournaments
 *     responses:
 *       200:
 *         description: Done.
 */
router.post("/:tournament_id/refresh", Utils.ensureAuthenticated, async (req, res, next) => {
  try {
    const tournament = await editableTournament(req, res);
    if (!tournament) return;
    await refreshTournament(tournament.id);
    res.json({ message: "Tournament refreshed." });
  } catch (err) {
    next(err);
  }
});

export default router;
