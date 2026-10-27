/** Super admin pages of the panel: users with their roles, and the audit log.
 * @module routes/admin
 */
import { NextFunction, Request, Response, Router } from "express";
import { RowDataPacket } from "mysql2";
import { db } from "../services/db.js";
import Utils from "../utility/utils.js";

const router = Router();

/** Everything here is for super admins only. */
const superAdminOnly = (req: Request, res: Response, next: NextFunction) => {
  if (!Utils.adminCheck(req.user!)) {
    res.status(403).json({ message: "Only super admins can do this." });
    return;
  }
  next();
};
router.use(Utils.ensureAuthenticated, superAdminOnly);

/**
 * @swagger
 *
 * /admin/users:
 *   get:
 *     description: >
 *       All users with their roles. roles_from_config is 1 when the roles come from admins/super_admins.steam_ids
 *       (the next Steam login sets them again); steam_verified is 0 for local accounts whose Steam ID was never
 *       proven by a Steam login. Super admins only.
 *     produces:
 *       - application/json
 *     tags:
 *       - admin
 *     responses:
 *       200:
 *         description: "{ users }"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/users", async (req, res, next) => {
  try {
    const users: RowDataPacket[] = await db.query(
      "SELECT u.id, u.name, u.steam_id, u.small_image, u.admin, u.super_admin, u.steam_verified, " +
        "u.roles_from_config, u.username, u.created_at, " +
        "(SELECT COUNT(*) FROM `match` m WHERE m.user_id = u.id) AS matches, " +
        "(SELECT COUNT(*) FROM team t WHERE t.user_id = u.id) AS teams, " +
        "(SELECT COUNT(*) FROM game_server gs WHERE gs.user_id = u.id) AS servers " +
        "FROM user u ORDER BY u.super_admin DESC, u.admin DESC, u.name"
    );
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 *
 * /admin/audit:
 *   get:
 *     description: The audit log, newest first. Super admins only.
 *     produces:
 *       - application/json
 *     parameters:
 *       - { name: action, in: query, description: Action prefix, e.g. "match." or "user.update", schema: { type: string } }
 *       - { name: user_id, in: query, schema: { type: integer } }
 *       - { name: target_type, in: query, schema: { type: string } }
 *       - { name: target_id, in: query, schema: { type: integer } }
 *       - { name: q, in: query, description: Text in the action, detail or user name, schema: { type: string } }
 *       - { name: limit, in: query, schema: { type: integer, default: 50, maximum: 200 } }
 *       - { name: offset, in: query, schema: { type: integer, default: 0 } }
 *     tags:
 *       - admin
 *     responses:
 *       200:
 *         description: "{ entries, total }"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get("/audit", async (req, res, next) => {
  try {
    const where: string[] = ["a.action IS NOT NULL"];
    const args: unknown[] = [];
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 40) : null);
    const int = (value: unknown) => {
      const parsed = typeof value === "string" ? parseInt(value, 10) : NaN;
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    const action = text(req.query.action);
    if (action) {
      where.push("a.action LIKE ?");
      args.push(action.replace(/[\\%_]/g, (c) => "\\" + c) + "%");
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 64) : "";
    if (q) {
      const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
      where.push("(a.action LIKE ? OR a.cmd_used LIKE ? OR u.name LIKE ?)");
      args.push(like, like, like);
    }
    const userId = int(req.query.user_id);
    if (userId != null) {
      where.push("a.user_id = ?");
      args.push(userId);
    }
    const targetType = text(req.query.target_type);
    if (targetType) {
      where.push("a.target_type = ?");
      args.push(targetType);
    }
    const targetId = int(req.query.target_id);
    if (targetId != null) {
      where.push("a.target_id = ?");
      args.push(targetId);
    }
    const limit = Math.min(int(req.query.limit) || 50, 200);
    const offset = int(req.query.offset) ?? 0;
    const whereSql = "WHERE " + where.join(" AND ");
    const total: RowDataPacket[] = await db.query(
      `SELECT COUNT(*) AS total FROM match_audit a LEFT JOIN user u ON u.id = a.user_id ${whereSql}`,
      args
    );
    const entries: RowDataPacket[] = await db.query(
      "SELECT a.id, a.time_affected AS time, a.user_id, u.name AS user_name, a.action, a.target_type, a.target_id, " +
        "a.status_code, a.cmd_used AS detail FROM match_audit a LEFT JOIN user u ON u.id = a.user_id " +
        `${whereSql} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset]
    );
    res.json({ entries, total: Number(total[0]?.total) || 0 });
  } catch (err) {
    next(err);
  }
});

export default router;
