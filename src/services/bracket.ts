/** Tournament brackets as pure data: generation (single/double elimination, round robin, Swiss pairings,
 * round robin groups followed by a single elimination playoff),
 * resolution (which teams play each match once results are known, byes included) and standings.
 * No database access, so everything here is unit tested.
 * @module services/bracket
 */

export type TournamentFormat = "single_elim" | "double_elim" | "round_robin" | "swiss" | "groups_playoff";
export type BracketName = "upper" | "lower" | "grand_final" | "round_robin" | "swiss" | "group";

/** Where a slot's team comes from. null = nobody (a bye). */
export type Source =
  | { type: "seed"; seed: number }
  | { type: "team"; team_id: number }
  | { type: "winner"; key: string }
  | { type: "loser"; key: string }
  | null;

export interface BracketNode {
  /** Unique within a tournament, e.g. "upper-1-0" (bracket-round-position). */
  key: string;
  bracket: BracketName;
  round: number;
  position: number;
  sources: [Source, Source];
  /** Finals of elimination brackets can use a longer series. */
  final: boolean;
}

export type NodeStatus = "pending" | "ready" | "done" | "bye" | "empty";

export interface ResolvedNode extends BracketNode {
  team1_id: number | null;
  team2_id: number | null;
  winner_id: number | null;
  loser_id: number | null;
  status: NodeStatus;
}

/** Played results by node key (from the linked matches). */
export type Results = Record<string, { winner_id: number | null } | undefined>;

const key = (bracket: BracketName, round: number, position: number) => `${bracket}-${round}-${position}`;

/** Standard seeding order for a bracket of size n (power of two): seed 1 meets n, 2 meets n-1, and the top
 * seeds can only meet in the latest rounds. Returns seed numbers (1-based) in bracket order. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const next = order.length * 2 + 1;
    order = order.flatMap((seed) => [seed, next - seed]);
  }
  return order;
}

const nextPowerOfTwo = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(n, 2)));

/** Single elimination; seeds beyond the team count are byes for the top seeds. */
export function singleElimination(teamCount: number): BracketNode[] {
  if (teamCount < 2) throw new Error("A bracket needs at least 2 teams.");
  const size = nextPowerOfTwo(teamCount);
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const nodes: BracketNode[] = [];
  for (let position = 0; position < size / 2; position++) {
    const [a, b] = [order[position * 2], order[position * 2 + 1]];
    nodes.push({
      key: key("upper", 1, position),
      bracket: "upper",
      round: 1,
      position,
      sources: [seedSource(a, teamCount), seedSource(b, teamCount)],
      final: rounds === 1
    });
  }
  for (let round = 2; round <= rounds; round++) {
    const count = size / 2 ** round;
    for (let position = 0; position < count; position++) {
      nodes.push({
        key: key("upper", round, position),
        bracket: "upper",
        round,
        position,
        sources: [
          { type: "winner", key: key("upper", round - 1, position * 2) },
          { type: "winner", key: key("upper", round - 1, position * 2 + 1) }
        ],
        final: round === rounds
      });
    }
  }
  return nodes;
}

const seedSource = (seed: number, teamCount: number): Source => (seed <= teamCount ? { type: "seed", seed } : null);

/**
 * Double elimination: the upper bracket as in single elimination, a lower bracket for its losers, and a grand
 * final between both bracket winners (no bracket reset). Lower round 1 pairs the losers of upper round 1;
 * after that, even lower rounds bring in the losers of the next upper round and odd ones halve the field.
 */
export function doubleElimination(teamCount: number): BracketNode[] {
  if (teamCount < 3) throw new Error("Double elimination needs at least 3 teams.");
  const upper = singleElimination(teamCount).map((node) => ({ ...node, final: false }));
  const size = nextPowerOfTwo(teamCount);
  const upperRounds = Math.log2(size);
  const nodes: BracketNode[] = [...upper];
  const lower: BracketNode[] = [];
  // Lower round 1: losers of upper round 1, paired.
  let count = size / 4;
  for (let position = 0; position < count; position++) {
    lower.push({
      key: key("lower", 1, position),
      bracket: "lower",
      round: 1,
      position,
      sources: [
        { type: "loser", key: key("upper", 1, position * 2) },
        { type: "loser", key: key("upper", 1, position * 2 + 1) }
      ],
      final: false
    });
  }
  let lowerRound = 1;
  for (let upperRound = 2; upperRound <= upperRounds; upperRound++) {
    // Drop-in round: lower winners meet the losers of this upper round (crossed, to avoid early rematches).
    lowerRound++;
    for (let position = 0; position < count; position++) {
      lower.push({
        key: key("lower", lowerRound, position),
        bracket: "lower",
        round: lowerRound,
        position,
        sources: [
          { type: "winner", key: key("lower", lowerRound - 1, position) },
          { type: "loser", key: key("upper", upperRound, count - 1 - position) }
        ],
        final: false
      });
    }
    if (count === 1) break;
    // Reduction round: lower winners play each other.
    lowerRound++;
    count /= 2;
    for (let position = 0; position < count; position++) {
      lower.push({
        key: key("lower", lowerRound, position),
        bracket: "lower",
        round: lowerRound,
        position,
        sources: [
          { type: "winner", key: key("lower", lowerRound - 1, position * 2) },
          { type: "winner", key: key("lower", lowerRound - 1, position * 2 + 1) }
        ],
        final: false
      });
    }
  }
  nodes.push(...lower);
  nodes.push({
    key: key("grand_final", 1, 0),
    bracket: "grand_final",
    round: 1,
    position: 0,
    sources: [
      { type: "winner", key: key("upper", upperRounds, 0) },
      { type: "winner", key: key("lower", lowerRound, 0) }
    ],
    final: true
  });
  return nodes;
}

/** Round robin with the circle method: every team plays every other once; odd counts get a bye each round. */
export function roundRobin(teamCount: number): BracketNode[] {
  if (teamCount < 2) throw new Error("A round robin needs at least 2 teams.");
  const seeds: (number | null)[] = Array.from({ length: teamCount }, (_, i) => i + 1);
  if (seeds.length % 2) seeds.push(null);
  const n = seeds.length;
  const nodes: BracketNode[] = [];
  let rotation = [...seeds];
  for (let round = 1; round < n; round++) {
    let position = 0;
    for (let i = 0; i < n / 2; i++) {
      const a = rotation[i];
      const b = rotation[n - 1 - i];
      if (a == null || b == null) continue; // the bye: no match
      nodes.push({
        key: key("round_robin", round, position),
        bracket: "round_robin",
        round,
        position,
        sources: [
          { type: "seed", seed: a },
          { type: "seed", seed: b }
        ],
        final: false
      });
      position++;
    }
    // Keep the first team in place, rotate the others.
    rotation = [rotation[0], rotation[n - 1], ...rotation.slice(1, n - 1)];
  }
  return nodes;
}

/** Fills in teams, winners and statuses from the seeding and the played results. Nodes must be in dependency
 * order (as the generators return them). A slot whose source can never produce a team is a bye, and a node
 * with one team against a bye is won by that team without a match. */
export function resolveBracket(nodes: BracketNode[], seeds: number[], results: Results): ResolvedNode[] {
  const byKey = new Map<string, ResolvedNode>();
  // A slot is: a team id, null for "nobody, ever" (bye), or undefined for "not known yet".
  const slot = (source: Source): number | null | undefined => {
    if (source == null) return null;
    if (source.type === "seed") return seeds[source.seed - 1] ?? null;
    if (source.type === "team") return source.team_id;
    const from = byKey.get(source.key);
    if (!from) return undefined;
    if (from.status === "empty") return null;
    if (from.status === "bye") return source.type === "winner" ? from.winner_id : null;
    if (from.status !== "done") return undefined;
    return source.type === "winner" ? from.winner_id : from.loser_id;
  };
  const resolved: ResolvedNode[] = [];
  for (const node of nodes) {
    const a = slot(node.sources[0]);
    const b = slot(node.sources[1]);
    const out: ResolvedNode = {
      ...node,
      team1_id: a ?? null,
      team2_id: b ?? null,
      winner_id: null,
      loser_id: null,
      status: "pending"
    };
    if (a === null && b === null) out.status = "empty";
    else if (a === null && b !== undefined) Object.assign(out, { status: "bye", winner_id: b });
    else if (b === null && a !== undefined) Object.assign(out, { status: "bye", winner_id: a });
    else if (a != null && b != null) {
      const result = results[node.key];
      const winner = result?.winner_id;
      if (winner != null && (winner === a || winner === b)) {
        Object.assign(out, { status: "done", winner_id: winner, loser_id: winner === a ? b : a });
      } else {
        out.status = "ready";
      }
    }
    byKey.set(node.key, out);
    resolved.push(out);
  }
  return resolved;
}

export interface Standing {
  team_id: number;
  played: number;
  wins: number;
  losses: number;
  maps_won: number;
  maps_lost: number;
  /** Swiss tiebreak: sum of the wins of every opponent played. */
  buchholz: number;
  /** Teams already played (Swiss avoids rematches). */
  opponents: number[];
}

export interface PlayedMatch {
  team1_id: number;
  team2_id: number;
  winner_id: number | null;
  team1_maps: number;
  team2_maps: number;
}

/** Standings of a round robin or Swiss stage: wins, then map difference, then maps won (and Buchholz in Swiss).
 * @param byes - one team id per bye received (a Swiss bye is a win without an opponent)
 */
export function standings(
  teamIds: number[],
  played: PlayedMatch[],
  useBuchholz = false,
  byes: number[] = []
): Standing[] {
  const table = new Map<number, Standing>(
    teamIds.map((id) => [
      id,
      { team_id: id, played: 0, wins: 0, losses: 0, maps_won: 0, maps_lost: 0, buchholz: 0, opponents: [] }
    ])
  );
  for (const match of played) {
    const one = table.get(match.team1_id);
    const two = table.get(match.team2_id);
    if (!one || !two || match.winner_id == null) continue;
    one.played++;
    two.played++;
    one.opponents.push(two.team_id);
    two.opponents.push(one.team_id);
    one.maps_won += match.team1_maps;
    one.maps_lost += match.team2_maps;
    two.maps_won += match.team2_maps;
    two.maps_lost += match.team1_maps;
    if (match.winner_id === one.team_id) {
      one.wins++;
      two.losses++;
    } else if (match.winner_id === two.team_id) {
      two.wins++;
      one.losses++;
    }
  }
  for (const teamId of byes) {
    const row = table.get(teamId);
    if (row) row.wins++;
  }
  for (const row of table.values()) {
    row.buchholz = row.opponents.reduce((sum, id) => sum + (table.get(id)?.wins ?? 0), 0);
  }
  const order = teamIds; // seeding breaks the last ties
  return [...table.values()].sort(
    (a, b) =>
      b.wins - a.wins ||
      (useBuchholz ? b.buchholz - a.buchholz : 0) ||
      b.maps_won - b.maps_lost - (a.maps_won - a.maps_lost) ||
      b.maps_won - a.maps_won ||
      order.indexOf(a.team_id) - order.indexOf(b.team_id)
  );
}

/** Default number of Swiss rounds: enough to separate an undefeated team. */
export const swissRounds = (teamCount: number) => Math.max(1, Math.ceil(Math.log2(Math.max(teamCount, 2))));

/**
 * Pairs the next Swiss round: teams with the same record meet, rematches are avoided whenever possible, and
 * with an odd count the lowest-ranked team without a bye so far gets one (a free win, stored as a node
 * with a null slot).
 */
export function swissPairings(
  round: number,
  ranking: Standing[],
  byesSoFar: number[] = []
): BracketNode[] {
  const pool = [...ranking];
  let byeTeam: number | null = null;
  if (pool.length % 2) {
    const candidate = [...pool].reverse().find((row) => !byesSoFar.includes(row.team_id)) ?? pool[pool.length - 1];
    byeTeam = candidate.team_id;
    pool.splice(pool.indexOf(candidate), 1);
  }
  // The search is exponential in the worst case; very large fields are simply paired in order.
  const pairs = (pool.length <= 64 ? pairWithoutRematch(pool) : null) ?? greedyPairs(pool);
  const nodes: BracketNode[] = pairs.map(([a, b], position) => ({
    key: key("swiss", round, position),
    bracket: "swiss",
    round,
    position,
    sources: [
      { type: "team", team_id: a.team_id },
      { type: "team", team_id: b.team_id }
    ],
    final: false
  }));
  if (byeTeam != null) {
    nodes.push({
      key: key("swiss", round, nodes.length),
      bracket: "swiss",
      round,
      position: nodes.length,
      sources: [{ type: "team", team_id: byeTeam }, null],
      final: false
    });
  }
  return nodes;
}

/** Backtracking: pair the ranking top-down, each team with the closest-ranked opponent it hasn't played. */
function pairWithoutRematch(pool: Standing[]): [Standing, Standing][] | null {
  if (!pool.length) return [];
  const [first, ...rest] = pool;
  for (let i = 0; i < rest.length; i++) {
    if (first.opponents.includes(rest[i].team_id)) continue;
    const remaining = [...rest.slice(0, i), ...rest.slice(i + 1)];
    const tail = pairWithoutRematch(remaining);
    if (tail) return [[first, rest[i]], ...tail];
  }
  return null;
}

function greedyPairs(pool: Standing[]): [Standing, Standing][] {
  const pairs: [Standing, Standing][] = [];
  for (let i = 0; i + 1 < pool.length; i += 2) pairs.push([pool[i], pool[i + 1]]);
  return pairs;
}

/**
 * Splits seeds 1..teamCount into groups by snake seeding (A gets 1, B 2, ... then back: the last group gets the
 * next seed), so the groups are as even as the seeding allows. Returns the seed numbers of each group.
 */
export function groupSeeds(teamCount: number, groupCount: number): number[][] {
  const groups: number[][] = Array.from({ length: groupCount }, () => []);
  for (let seed = 1; seed <= teamCount; seed++) {
    const lap = Math.floor((seed - 1) / groupCount);
    const index = (seed - 1) % groupCount;
    groups[lap % 2 === 0 ? index : groupCount - 1 - index].push(seed);
  }
  return groups;
}

/** The group number (1-based) of a group stage node, from its key "group<g>-<round>-<position>". */
export const groupOfKey = (nodeKey: string): number | null => {
  const found = /^group(\d+)-/.exec(nodeKey);
  return found ? Number(found[1]) : null;
};

/** Checks a groups + playoff setup: every group plays (2+ teams) and the playoff has 2+ teams. */
export function groupStageError(teamCount: number, groupCount: number, advance: number): string | null {
  if (groupCount < 1 || teamCount < groupCount * 2) return "Every group needs at least 2 teams.";
  const smallest = Math.floor(teamCount / groupCount);
  if (advance < 1 || advance > smallest) return `At most ${smallest} teams per group can go to the playoff.`;
  if (groupCount * advance < 2) return "The playoff needs at least 2 teams.";
  return null;
}

/** The group stage: one round robin per group, keyed "group<g>-<round>-<position>", rounds played in step. */
export function groupStage(teamCount: number, groupCount: number): BracketNode[] {
  const nodes: BracketNode[] = [];
  groupSeeds(teamCount, groupCount).forEach((members, index) => {
    const local = (source: Source): Source =>
      source?.type === "seed" ? { type: "seed", seed: members[source.seed - 1] } : source;
    for (const node of roundRobin(members.length)) {
      nodes.push({
        ...node,
        key: `group${index + 1}-${node.round}-${node.position}`,
        bracket: "group",
        sources: [local(node.sources[0]), local(node.sources[1])]
      });
    }
  });
  return nodes.sort((a, b) => a.round - b.round);
}

/**
 * The playoff seeding from the group tables: every group winner, then every runner-up, and so on. With the
 * standard bracket order a group winner meets a runner-up of another group first (A1 v B2, B1 v A2).
 */
export function playoffSeeds(groupTables: Standing[][], advance: number): number[] {
  const seeds: number[] = [];
  for (let place = 0; place < advance; place++) {
    for (const table of groupTables) if (table[place]) seeds.push(table[place].team_id);
  }
  return seeds;
}

/** The single elimination playoff for the given teams (best first), with fixed team slots. */
export function playoffBracket(teamIds: number[]): BracketNode[] {
  return singleElimination(teamIds.length).map((node) => ({
    ...node,
    sources: node.sources.map((source) =>
      source?.type === "seed" ? { type: "team", team_id: teamIds[source.seed - 1] } : source
    ) as [Source, Source]
  }));
}

/** All nodes of a format at the start (Swiss: only round 1; groups + playoff: the group stage). */
export function generateBracket(
  format: TournamentFormat,
  teamIds: number[],
  options: { groups?: number; advance?: number } = {}
): BracketNode[] {
  switch (format) {
    case "single_elim":
      return singleElimination(teamIds.length);
    case "double_elim":
      return doubleElimination(teamIds.length);
    case "round_robin":
      return roundRobin(teamIds.length);
    case "swiss":
      if (teamIds.length < 2) throw new Error("Swiss needs at least 2 teams.");
      return swissPairings(1, standings(teamIds, []));
    case "groups_playoff": {
      const groups = options.groups ?? 1;
      const error = groupStageError(teamIds.length, groups, options.advance ?? 2);
      if (error) throw new Error(error);
      return groupStage(teamIds.length, groups);
    }
  }
}
