/** Shape checks for MatchZy's webhook events (remote log URL).
 * Only the fields the handlers read are checked, and values are not converted: a handler still gets the body
 * MatchZy sent. Extra fields are allowed, and events without a schema pass.
 * @module services/eventschemas
 */
import { z } from "zod";

/** MatchZy sends ids and numbers as JSON numbers; strings of digits are accepted too. */
const idLike = z.union([z.string().min(1), z.number()]);
const count = z.union([z.number().int().min(0), z.string().regex(/^\d+$/)]);
const optionalNumber = z.union([z.number(), z.string()]).optional();

const player = z.object({ steamid: idLike, name: z.string().nullish() }).passthrough();
const team = z
  .object({
    id: idLike.nullish(),
    score: optionalNumber,
    players: z.array(player.partial().passthrough()).nullish()
  })
  .passthrough();
/** A kill assist wraps the assisting player: { player, friendly_fire, flash_assist }. */
const assist = z
  .object({ player: player.nullish(), friendly_fire: z.boolean().nullish(), flash_assist: z.boolean().nullish() })
  .passthrough();
const winner = z.object({ team: z.string(), side: z.union([z.string(), z.number()]).nullish() }).passthrough();

const base = z.object({ event: z.string(), matchid: idLike.optional() }).passthrough();
const onMap = base.extend({ map_number: count });
const inRound = onMap.extend({ round_number: count });

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  map_picked: base.extend({ team: z.string(), map_name: z.string(), map_number: count.optional() }),
  map_vetoed: base.extend({ team: z.string(), map_name: z.string() }),
  side_picked: base.extend({ team: z.string(), map_name: z.string(), side: z.string(), map_number: count.optional() }),
  backup_loaded: onMap.extend({ round_number: count.optional() }),
  map_result: onMap.extend({ team1: team, team2: team, winner }),
  series_end: base.extend({ team1_series_score: count, team2_series_score: count, winner }),
  going_live: onMap,
  round_start: inRound,
  round_end: inRound.extend({ team1: team, team2: team, winner, reason: optionalNumber, round_time: optionalNumber }),
  // attacker, assist and weapon are null for world damage, the bomb and suicides.
  player_death: inRound.extend({
    player,
    attacker: player.nullish(),
    assist: assist.nullish(),
    weapon: z.object({ name: z.string().nullish() }).passthrough().nullish()
  }),
  bomb_planted: inRound.extend({ player, site: z.union([z.string(), z.number()]).nullish() }),
  bomb_defused: inRound.extend({ player, site: z.union([z.string(), z.number()]).nullish() }),
  game_paused: onMap.extend({ team: z.string().nullish(), pause_type: z.string().nullish() }),
  game_unpaused: onMap.extend({ team: z.string().nullish(), pause_type: z.string().nullish() })
};

/**
 * Checks a webhook body against its event's schema.
 * @returns null when it is fine (or the event has no schema), else what is wrong, e.g. "round_end: team1.players.0.steamid: Required".
 */
export function eventProblem(body: unknown): string | null {
  const event = body && typeof body === "object" ? (body as { event?: unknown }).event : undefined;
  if (typeof event !== "string") return "The body has no event name.";
  const schema = SCHEMAS[event];
  if (!schema) return null;
  const result = schema.safeParse(body);
  if (result.success) return null;
  const issue = result.error.issues[0];
  return `${event}: ${issue.path.join(".") || "body"}: ${issue.message}`;
}
