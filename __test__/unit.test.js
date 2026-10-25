// Unit tests that need no database or game server.
import { agent } from "supertest";
import app from "../app.js";
import { backupLoadCommand, parseBackupList, parseStatusPlayers, restoreFailed, safeRconArg, RconArgumentError } from "../src/utility/serverrcon.js";
import Utils from "../src/utility/utils.js";
import { buildMatchConfig, callbackCvars, parseMapPool, MatchConfigError } from "../src/services/matchconfig.js";
import { buildSummary } from "../src/services/matchsummary.js";
import { normalizeSide } from "../src/services/mapflowservices.js";
import { cleanSettings } from "../src/services/tournaments.js";
import { eventProblem } from "../src/services/eventschemas.js";
import { forMatch } from "../src/utility/emitter.js";
import { assessServerState, nextState } from "../src/services/serverstate.js";
import { passwordProblem, usernameProblem } from "../src/utility/credentials.js";
import { configRoleLists, writeAllowed } from "../src/utility/access.js";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  doubleElimination,
  resolveBracket,
  roundRobin,
  seedOrder,
  singleElimination,
  standings,
  swissPairings
} from "../src/services/bracket.js";
import { balancedTeams, chooseCaptains, nextPickingTeam, randomTeams } from "../src/services/pugformation.js";
import { controlCommand } from "../src/utility/matchcontrol.js";

const request = agent(app);

describe("buildMatchConfig (MatchZy match config)", () => {
  const baseInput = (matchOverrides = {}) => ({
    match: {
      id: 7,
      max_maps: 3,
      veto_mappool: "de_mirage de_inferno, de_nuke de_ancient de_anubis",
      skip_veto: 0,
      side_type: "standard",
      veto_first: "team2",
      players_per_team: null,
      min_player_ready: null,
      wingman: 0,
      team1_id: 1,
      team2_id: 2,
      team1_series_score: 1,
      team2_series_score: 0,
      ...matchOverrides
    },
    team1: {
      team: { id: 1, name: "Alpha", tag: "ALP", flag: "lt", logo: null },
      auths: [
        { auth: "76561198000000001", name: "Captain", coach: 0 },
        { auth: "76561198000000002", name: "", coach: 1 },
        { auth: "not-a-steam-id", name: "Broken", coach: 0 }
      ]
    },
    team2: { team: { id: 2, name: "Bravo" }, auths: [{ auth: "76561198000000003", name: null }] },
    cvars: [
      { cvar_name: "mp_maxrounds", cvar_value: 24 },
      { cvar_name: "matchzy_remote_log_url", cvar_value: "http://evil.example" }
    ],
    spectators: [{ auth: "76561198000000009", spectator_name: "Caster" }],
    uploadDemos: true
  });

  it("produces the fields MatchZy requires", () => {
    const config = buildMatchConfig(baseInput(), "secret-key");
    expect(config.matchid).toBe(7);
    expect(config.num_maps).toBe(3);
    expect(config.maplist).toEqual(["de_mirage", "de_inferno", "de_nuke", "de_ancient", "de_anubis"]);
    expect(config.skip_veto).toBe(false);
    expect(config.clinch_series).toBe(true);
    expect(config.veto_first).toBe("team2");
    expect(config.team1.name).toBe("Alpha");
    expect(config.team1.id).toBe("1");
    expect(config.team1.flag).toBe("LT");
    expect(config.team1.series_score).toBe(1);
  });

  it("sends spectators and lists coaches as players", () => {
    const config = buildMatchConfig(baseInput(), "k");
    expect(config.spectators.players).toEqual({ "76561198000000009": "Caster" });
    expect(config.team1.players).toEqual({ "76561198000000001": "Captain", "76561198000000002": "" });
    expect(config.team2.players).toEqual({ "76561198000000003": "" });
  });

  it("defaults the per-team ready count to the team size", () => {
    expect(buildMatchConfig(baseInput(), "k").min_players_to_ready).toBe(5);
    const wingman = buildMatchConfig(baseInput({ wingman: 1 }), "k");
    expect(wingman.players_per_team).toBe(2);
    expect(wingman.min_players_to_ready).toBe(2);
    expect(buildMatchConfig(baseInput({ min_player_ready: 9 }), "k").min_players_to_ready).toBe(5);
  });

  it("only sends a complete, valid map_sides list", () => {
    expect(buildMatchConfig(baseInput({ map_sides: "team1_ct,knife" }), "k").map_sides).toBeUndefined();
    expect(buildMatchConfig(baseInput({ map_sides: "team1_ct,bogus,knife" }), "k").map_sides).toBeUndefined();
    expect(buildMatchConfig(baseInput({ map_sides: "team1_ct, team2_t, knife" }), "k").map_sides).toEqual([
      "team1_ct",
      "team2_t",
      "knife"
    ]);
  });

  it("uses matchzy_* remote settings that user cvars can't override", () => {
    const config = buildMatchConfig(baseInput(), "secret-key");
    expect(config.cvars.mp_maxrounds).toBe("24");
    expect(config.cvars.matchzy_remote_log_url).toMatch(/\/v2$/);
    expect(config.cvars.matchzy_remote_log_header_value).toBe("secret-key");
    expect(config.cvars.matchzy_demo_upload_url).toMatch(/\/v2\/demo$/);
    expect(config.cvars.matchzy_remote_backup_url).toMatch(/\/v2\/backup$/);
    expect(Object.keys(config.cvars).some((name) => name.startsWith("get5_"))).toBe(false);
    const noDemos = buildMatchConfig({ ...baseInput(), uploadDemos: false }, "k");
    expect(noDemos.cvars.matchzy_demo_upload_url).toBeUndefined();
  });

  it("sends the server's join password as sv_password", () => {
    expect(buildMatchConfig(baseInput(), "k").cvars.sv_password).toBeUndefined();
    expect(buildMatchConfig({ ...baseInput(), serverPassword: "scrim-42" }, "k").cvars.sv_password).toBe("scrim-42");
  });

  it("refuses matches MatchZy could not load", () => {
    expect(() => buildMatchConfig(baseInput({ veto_mappool: null }), "k")).toThrow(MatchConfigError);
    expect(() => buildMatchConfig(baseInput({ veto_mappool: "de_mirage" }), "k")).toThrow(MatchConfigError);
    expect(parseMapPool("de_dust2, de_cache,de_mirage")).toEqual(["de_dust2", "de_cache", "de_mirage"]);
  });
});

describe("Routes refuse anonymous and malformed requests before touching the database", () => {
  it.each([
    ["delete", "/seasons"],
    ["delete", "/playerstats"],
    ["delete", "/playerstatsextra"],
    ["get", "/servers/1/rcon"],
    ["post", "/matches/1/cancel"],
    ["post", "/matches/1/pause"],
    ["post", "/matches"],
    ["post", "/teams/members/resolve"],
    ["post", "/matches/1/callbacks"],
    ["get", "/admin/users"],
    ["get", "/admin/audit"],
    ["post", "/matches/1/control"],
    ["get", "/matches/1/server/status"],
    ["get", "/templates"],
    ["post", "/templates"],
    ["get", "/scheduled"],
    ["post", "/scheduled"]
  ])("%s %s without login gives 401 JSON", (method, path) => {
    return request[method](path)
      .send([{ season_id: 1, match_id: 1 }])
      .expect("Content-Type", /json/)
      .expect(401);
  });

  it.each([
    ["get", "/matches/1/cancel"],
    ["get", "/matches/1/pause"],
    ["get", "/logout"]
  ])("%s %s no longer exists", (method, path) => {
    return request[method](path).expect(404);
  });

  it("refuses an anonymous write to any path, even one that doesn't exist", () => {
    return request.post("/match/1/finish").expect(401);
  });

  it("rejects backup uploads with a path in the headers", () => {
    return request
      .post("/v2/backup")
      .set("Authorization", "key")
      .set("MatchZy-MatchId", "../../etc")
      .set("MatchZy-MapNumber", "0")
      .set("MatchZy-RoundNumber", "1")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("{}"))
      .expect(412);
  });

  it("rejects demo uploads with a path as the file name", () => {
    return request
      .post("/v2/demo")
      .set("Authorization", "key")
      .set("MatchZy-MatchId", "1")
      .set("MatchZy-MapNumber", "0")
      .set("MatchZy-FileName", "..\\..\\app.js")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("demo"))
      .expect((res) => {
        // 403 when demo uploads are disabled in the config, otherwise the name is refused.
        expect([403, 412]).toContain(res.status);
      });
  });
});

describe("parseBackupList", () => {
  // Shaped like MatchZy's matchzy_listbackups reply: "<file> <timestamp> <team1> <team2> <map> <score1> <score2>",
  // or the full path when the backup info can't be read, with CRLF line endings and padding bytes.
  const output =
    "matchzy_12_0_round05.json 2026-10-20 18:00:00 Team A Team B de_mirage 3 2\r\n" +
    "\u0000/home/cs2/game/csgo/MatchZyDataBackup/matchzy_12_0_round04.json\r\n" +
    "matchzy_12_1_round01.json 2026-10-20 19:00:00 Team A Team B de_inferno 0 1\r\n" +
    "matchzy_12_0_round05.json 2026-10-20 18:00:00 Team A Team B de_mirage 3 2\r\n" +
    "Found no backup files matching the provided parameters.\r\n" +
    "\r\n";

  it("returns only real backup file names, without CR, padding or details", () => {
    const backups = parseBackupList(output);
    expect(backups.map((b) => b.file)).toEqual([
      "matchzy_12_1_round01.json",
      "matchzy_12_0_round05.json",
      "matchzy_12_0_round04.json"
    ]);
  });

  it("keeps map, round and the info MatchZy printed", () => {
    const [latest] = parseBackupList(output);
    expect(latest).toEqual({
      file: "matchzy_12_1_round01.json",
      map_number: 1,
      round: 1,
      info: "2026-10-20 19:00:00 Team A Team B de_inferno 0 1"
    });
  });

  it("returns nothing for output without backups", () => {
    expect(parseBackupList("Found no backup files matching the provided parameters.\r\n")).toEqual([]);
    expect(parseBackupList("")).toEqual([]);
  });
});

describe("safeRconArg", () => {
  it("accepts ordinary values", () => {
    expect(safeRconArg("Player O'Neil", "nickname")).toBe("Player O'Neil");
    expect(safeRconArg("https://example.com/api/matches/1/config", "url", 512)).toMatch(/^https/);
  });

  it.each([
    ['name" ; rcon_password hacked', "quote and semicolon"],
    ["name; quit", "semicolon"],
    ["name\nquit", "newline"],
    ["", "empty"],
    ["x".repeat(65), "too long"]
  ])("rejects %j (%s)", (value) => {
    expect(() => safeRconArg(value, "nickname", 64)).toThrow(RconArgumentError);
  });

  it("rejects non-strings", () => {
    expect(() => safeRconArg(undefined, "nickname")).toThrow(RconArgumentError);
    expect(() => safeRconArg(123, "nickname")).toThrow(RconArgumentError);
  });
});

describe("Utils.validateCvars", () => {
  it("accepts normal cvars", () => {
    expect(Utils.validateCvars({ mp_maxrounds: 24, mp_overtime_enable: "1", sv_cheats: false })).toBeNull();
    expect(Utils.validateCvars(null)).toBeNull();
  });

  it.each([
    [{ rcon_password: "x" }, /cannot be set/],
    [{ matchzy_everyone_is_admin: "true" }, /cannot be set/],
    [{ matchzy_remote_log_url: "http://evil" }, /cannot be set/],
    [{ get5_demo_upload_header_value: "x" }, /cannot be set/],
    [{ "mp_maxrounds;quit": "1" }, /Invalid cvar name/],
    [{ hostname: 'a" ; rcon_password b' }, /Invalid value/],
    [{ hostname: "a\nb" }, /Invalid value/],
    [{ hostname: { nested: 1 } }, /Invalid value/],
    [["mp_maxrounds"], /must be an object/]
  ])("rejects %j", (cvars, message) => {
    expect(Utils.validateCvars(cvars)).toMatch(message);
  });
});

describe("Utils.isSteamId64 / safeCompare", () => {
  it("validates SteamID64s", () => {
    expect(Utils.isSteamId64("76561198000000042")).toBe(true);
    expect(Utils.isSteamId64("12345")).toBe(false);
    expect(Utils.isSteamId64("76561198000000042; quit")).toBe(false);
    expect(Utils.isSteamId64(76561198000000042)).toBe(false);
  });

  it("never matches missing keys", () => {
    expect(Utils.safeCompare("abc", "abc")).toBe(true);
    expect(Utils.safeCompare("abc", "abd")).toBe(false);
    expect(Utils.safeCompare("abc", undefined)).toBe(false);
    expect(Utils.safeCompare(undefined, undefined)).toBe(false);
    expect(Utils.safeCompare("undefined", undefined)).toBe(false);
  });
});

describe("buildSummary (match list)", () => {
  const match = (overrides = {}) => ({
    id: 5,
    user_id: 1,
    owner_name: "Owner",
    team1_id: 10,
    team2_id: 20,
    team1_string: "Alpha",
    team2_string: "Bravo",
    team1_score: 0,
    team2_score: 0,
    winner: null,
    cancelled: 0,
    forfeit: 0,
    start_time: "2026-10-01T10:00:00.000Z",
    end_time: null,
    max_maps: 3,
    title: null,
    ip_string: "10.0.0.5",
    port: 27015,
    gotv_port: 27020,
    server_name: "Box",
    ...overrides
  });
  const map = (overrides = {}) => ({
    map_number: 0,
    map_name: "de_mirage",
    team1_score: 0,
    team2_score: 0,
    winner: null,
    end_time: null,
    team1_side: "ct",
    round_number: 0,
    ...overrides
  });
  const now = new Date("2026-10-02T00:00:00.000Z");

  it("is warmup while no map is running, counting how long it has waited", () => {
    const summary = buildSummary({ match: match(), maps: [], pause: null, canConnect: true, now });
    expect(summary.status).toBe("warmup");
    // Loaded 2026-10-01 10:00, now 2026-10-02 00:00.
    expect(summary.waiting_minutes).toBe(14 * 60);
    expect(summary.current_map).toBeNull();
    expect(summary.server).toEqual({ name: "Box", ip: "10.0.0.5", port: 27015, gotv_port: 27020, password: null });
  });

  it("shows the live map with its round score and sides, and maps already played", () => {
    const summary = buildSummary({
      match: match({ team1_score: 1 }),
      maps: [
        map({ map_number: 1, map_name: "de_nuke", team1_score: 9, team2_score: 7, team1_side: "t", round_number: 16 }),
        map({ map_number: 0, team1_score: 13, team2_score: 9, winner: 10, end_time: "2026-10-01T11:00:00.000Z" })
      ],
      pause: null,
      canConnect: false,
      now
    });
    expect(summary.status).toBe("live");
    expect(summary.current_map).toEqual({
      number: 1,
      name: "de_nuke",
      team1_score: 9,
      team2_score: 7,
      round: 16,
      team1_side: "t"
    });
    expect(summary.maps.map((m) => [m.number, m.winner, m.finished])).toEqual([
      [0, 1, true],
      [1, null, false]
    ]);
    expect(summary.team1.score).toBe(1);
    // Not a participant: no server address.
    expect(summary.server).toBeNull();
  });

  it("is paused when the pause row says so", () => {
    const summary = buildSummary({
      match: match(),
      maps: [map()],
      pause: { paused: 1, pause_type: "tech", team_paused: "Alpha" },
      canConnect: true,
      now
    });
    expect(summary.status).toBe("paused");
    expect(summary.pause).toEqual({ type: "tech", team: "Alpha" });
  });

  it("reports the winner side of finished and forfeited matches, without connect info", () => {
    const finished = buildSummary({
      match: match({ end_time: "2026-10-01T12:00:00.000Z", winner: 20, team2_score: 2 }),
      maps: [],
      pause: null,
      canConnect: true,
      now
    });
    expect(finished.status).toBe("finished");
    expect(finished.winner).toBe(2);
    expect(finished.server).toBeNull();
    const forfeit = buildSummary({ match: match({ forfeit: 1, winner: 10 }), maps: [], pause: null, canConnect: true, now });
    expect(forfeit.status).toBe("finished");
    expect(forfeit.forfeit).toBe(true);
    expect(forfeit.winner).toBe(1);
  });

  it("knows cancelled and scheduled matches, and drops Get5 title templates", () => {
    expect(buildSummary({ match: match({ cancelled: 1 }), maps: [], pause: null, canConnect: true, now }).status).toBe(
      "cancelled"
    );
    const pending = buildSummary({
      match: match({ start_time: "2026-10-05T00:00:00.000Z", title: "Map {MAPNUMBER} of {MAXMAPS}" }),
      maps: [],
      pause: null,
      canConnect: true,
      now
    });
    expect(pending.status).toBe("pending");
    expect(pending.title).toBeNull();
    expect(buildSummary({ match: match({ title: "Grand final" }), maps: [], pause: null, canConnect: true, now }).title).toBe(
      "Grand final"
    );
  });
});

describe("Utils.adminCheck / superAdminCheck", () => {
  it("only counts flags that are set", () => {
    for (const flags of [{ admin: 0, super_admin: 0 }, { admin: false, super_admin: false }, { admin: "0", super_admin: "0" }, {}]) {
      expect(Utils.adminCheck(flags)).toBe(false);
      expect(Utils.superAdminCheck(flags)).toBe(false);
    }
    expect(Utils.adminCheck(null)).toBe(false);
    expect(Utils.superAdminCheck(undefined)).toBe(false);
  });
  it("accepts numeric, boolean and string flags", () => {
    expect(Utils.adminCheck({ admin: 1, super_admin: 0 })).toBe(true);
    expect(Utils.adminCheck({ admin: false, super_admin: true })).toBe(true);
    expect(Utils.superAdminCheck({ super_admin: "1" })).toBe(true);
    expect(Utils.superAdminCheck({ admin: 1, super_admin: 0 })).toBe(false);
  });
});

describe("backupLoadCommand", () => {
  it("sends the file name without quotes (MatchZy would keep them in the path)", () => {
    expect(backupLoadCommand("matchzy_3_0_round05.json")).toBe("matchzy_loadbackup matchzy_3_0_round05.json");
  });
  it.each([['"matchzy_3_0_round05.json"'], ["matchzy_3_0_round05.json; quit"], ["../x.json"], [null]])(
    "rejects %p",
    (name) => {
      expect(() => backupLoadCommand(name)).toThrow(RconArgumentError);
    }
  );
});

describe("restoreFailed", () => {
  it.each([
    "[MatchZy] [RestoreRoundBackup] matchzy_3_0_round04.json has no complete round data, nothing restored.",
    "[MatchZy] [RestoreRoundBackup FATAL] Required backup data file does not exist! File: x"
  ])("recognises %p", (reply) => {
    expect(restoreFailed(reply)).toBe(true);
  });
  it("accepts a normal reply", () => {
    expect(restoreFailed("[MatchZy] Restoring round 5")).toBe(false);
    expect(restoreFailed("")).toBe(false);
  });
});

describe("callbackCvars", () => {
  it("points MatchZy's event, backup and demo uploads at this API with the match key", () => {
    const cvars = callbackCvars("KEY123", true);
    expect(cvars.matchzy_remote_log_url).toMatch(/\/v2$/);
    expect(cvars.matchzy_remote_backup_url).toMatch(/\/v2\/backup$/);
    expect(cvars.matchzy_demo_upload_url).toMatch(/\/v2\/demo$/);
    expect(cvars.matchzy_remote_log_header_value).toBe("KEY123");
    expect(callbackCvars("KEY123", false).matchzy_demo_upload_url).toBeUndefined();
  });
});

describe("normalizeSide (MatchZy side values)", () => {
  it.each([
    ["3", "ct"],
    ["2", "t"],
    [3, "ct"],
    ["ct", "ct"],
    ["T", "t"],
    ["0", null],
    ["none", null],
    [undefined, null]
  ])("%p -> %p", (input, expected) => {
    expect(normalizeSide(input)).toBe(expected);
  });
});

describe("brackets", () => {
  const teams = (n) => Array.from({ length: n }, (_, i) => 100 + i);
  /** Plays every ready match, the lower team id (the better seed) winning, until nothing is ready. */
  const playOut = (nodes, seeds, pick = (a, b) => Math.min(a, b)) => {
    const results = {};
    for (let i = 0; i < 100; i++) {
      const ready = resolveBracket(nodes, seeds, results).filter((node) => node.status === "ready");
      if (!ready.length) break;
      for (const node of ready) results[node.key] = { winner_id: pick(node.team1_id, node.team2_id) };
    }
    return resolveBracket(nodes, seeds, results);
  };

  it("seeds 1 and 2 can only meet in the final", () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it("gives byes to the top seeds in single elimination", () => {
    const seeds = teams(6);
    const nodes = singleElimination(6);
    expect(nodes.filter((n) => n.round === 1)).toHaveLength(4);
    const resolved = resolveBracket(nodes, seeds, {});
    const byes = resolved.filter((n) => n.status === "bye").map((n) => n.winner_id);
    expect(byes.sort()).toEqual([100, 101]);
    // Seed 1's next match waits for the 4 v 5 winner.
    const final = playOut(nodes, seeds).find((n) => n.final);
    expect(final).toMatchObject({ status: "done", team1_id: 100, team2_id: 101, winner_id: 100 });
  });

  it("runs a double elimination to a grand final between both bracket winners", () => {
    for (const n of [3, 4, 5, 8, 12, 16]) {
      const seeds = teams(n);
      const nodes = doubleElimination(n);
      const done = playOut(nodes, seeds);
      const final = done.find((node) => node.bracket === "grand_final");
      // The best seed wins the upper bracket; seed 2 comes through the lower bracket.
      expect(final).toMatchObject({ status: "done", team1_id: 100, team2_id: 101, winner_id: 100 });
      // Every team except the winner is eliminated exactly twice or reaches the final.
      const losses = new Map();
      for (const node of done.filter((x) => x.status === "done")) losses.set(node.loser_id, (losses.get(node.loser_id) ?? 0) + 1);
      for (const team of seeds.slice(2)) expect(losses.get(team) ?? 0).toBeLessThanOrEqual(2);
      expect(done.some((node) => node.status === "ready" || node.status === "pending")).toBe(false);
    }
  });

  it("plays every pairing once in a round robin", () => {
    for (const n of [4, 5]) {
      const nodes = roundRobin(n);
      const pairs = new Set(nodes.map((node) => [node.sources[0].seed, node.sources[1].seed].sort().join("-")));
      expect(pairs.size).toBe((n * (n - 1)) / 2);
      expect(nodes).toHaveLength((n * (n - 1)) / 2);
      // Nobody plays twice in a round.
      for (const round of new Set(nodes.map((node) => node.round))) {
        const seen = nodes.filter((node) => node.round === round).flatMap((node) => node.sources.map((s) => s.seed));
        expect(new Set(seen).size).toBe(seen.length);
      }
    }
  });

  it("ranks by wins, then map difference, counting byes as wins", () => {
    const table = standings(
      [1, 2, 3],
      [
        { team1_id: 1, team2_id: 2, winner_id: 2, team1_maps: 1, team2_maps: 2 },
        { team1_id: 3, team2_id: 1, winner_id: 1, team1_maps: 0, team2_maps: 2 }
      ],
      false,
      [3]
    );
    expect(table.map((row) => [row.team_id, row.wins])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1]
    ]);
    expect(table[0].maps_won - table[0].maps_lost).toBe(1);
  });

  it("pairs Swiss rounds by record without rematches and gives one bye for odd counts", () => {
    const ids = teams(5);
    const ranking = standings(ids, [
      { team1_id: 100, team2_id: 101, winner_id: 100, team1_maps: 1, team2_maps: 0 },
      { team1_id: 102, team2_id: 103, winner_id: 102, team1_maps: 1, team2_maps: 0 }
    ], true, [104]);
    const round2 = swissPairings(2, ranking, [104]);
    const real = round2.filter((node) => node.sources[1] != null);
    expect(real).toHaveLength(2);
    for (const node of real) {
      const [a, b] = node.sources.map((s) => s.team_id);
      expect([a, b].sort().join()).not.toBe("100,101");
      expect([a, b].sort().join()).not.toBe("102,103");
    }
    const bye = round2.find((node) => node.sources[1] == null);
    expect(bye.sources[0].team_id).not.toBe(104);
  });
});

describe("PUG team formation", () => {
  const players = [1.6, 1.2, 1.1, 1.0, 1.0, 0.9, 0.9, 0.8, 0.7, 0.5].map((rating, i) => ({ user_id: i + 1, rating }));
  const sum = (team) => team.reduce((total, player) => total + player.rating, 0);

  it("balances 5v5 to the closest possible rating totals", () => {
    const [a, b] = balancedTeams(players);
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    // The ratings total 9.7 in steps of 0.1, so 0.1 apart is the best split there is.
    expect(Math.abs(sum(a) - sum(b))).toBeLessThan(0.1 + 1e-9);
    expect(new Set([...a, ...b].map((p) => p.user_id)).size).toBe(10);
  });
  it("uses a snake draft for big queues", () => {
    const many = Array.from({ length: 16 }, (_, i) => ({ user_id: i, rating: 2 - i * 0.1 }));
    const [a, b] = balancedTeams(many);
    expect(a).toHaveLength(8);
    expect(b).toHaveLength(8);
    expect(Math.abs(sum(a) - sum(b))).toBeLessThan(0.3);
  });
  it("splits randomly into equal halves", () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const [a, b] = randomTeams(players, random);
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
  });
  it("lets captains pick in ABBA order, the two best players being captains", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(nextPickingTeam)).toEqual([1, 2, 2, 1, 1, 2, 2, 1]);
    expect(chooseCaptains(players).map((p) => p.user_id)).toEqual([1, 2]);
  });
});

describe("controlCommand (admin match control)", () => {
  it.each([
    ["start", {}, "css_start"],
    ["skip_veto", {}, "css_skipveto"],
    ["toggle_knife", {}, "css_roundknife"],
    ["toggle_playout", {}, "css_playout"],
    ["toggle_whitelist", {}, "css_whitelist"],
    ["change_map", { map: "de_nuke" }, "css_map de_nuke"],
    ["team_name", { team: 2, name: " Team Liquid " }, "css_team2 Team Liquid"],
    ["say", { message: "Tech pause, 5 min" }, "css_asay Tech pause, 5 min"],
    ["cvar", { cvar: "mp_maxrounds", value: 30 }, "mp_maxrounds 30"]
  ])("%s -> %s", (action, args, command) => {
    expect(controlCommand(action, args)).toBe(command);
  });
  it.each([
    ["rcon_password", {}],
    ["say", { message: 'hi"; quit' }],
    ["say", { message: "x".repeat(121) }],
    ["team_name", { team: 3, name: "A" }],
    ["ready_required", { count: 2 }],
    ["change_map", { map: "de_nuke; quit" }],
    ["cvar", { cvar: "sv_cheats", value: 1 }],
    ["cvar", { cvar: "mp_freezetime", value: 61 }]
  ])("refuses %s %p", (action, args) => {
    expect(() => controlCommand(action, args)).toThrow(RconArgumentError);
  });
});

describe("parseStatusPlayers", () => {
  // Shaped like CS2's `status` reply (CRLF, a GOTV/unfilled slot, a bot, a connecting player).
  const output =
    "hostname: Test Server\r\n" +
    "---------spawngroups----\r\n" +
    "loaded spawngroup(  1)  : SV:  [1: de_mirage | main lump | mapload]\r\n" +
    "---------players--------\r\n" +
    "  id     time ping loss      state   rate adr name\r\n" +
    "65535 [NoChan]    0    0 challenging      0unknown ''\r\n" +
    "    2    05:21   25    0     active 786432 192.168.1.5:27005 'Player One'\r\n" +
    "    3      BOT    0    0     active      0 'Bot Name'\r\n" +
    "    4    00:03   61    3 connecting 786432 10.0.0.2:27005 'It''s me'\r\n" +
    "#end\r\n" +
    "    9    01:00   10    0     active 786432 1.2.3.4:27005 'After end'\r\n";

  it("lists connected players with id, name, ping and state", () => {
    expect(parseStatusPlayers(output)).toEqual([
      { userid: 2, name: "Player One", ping: 25, state: "active", bot: false },
      { userid: 3, name: "Bot Name", ping: null, state: "active", bot: true },
      { userid: 4, name: "It''s me", ping: 61, state: "connecting", bot: false }
    ]);
  });

  it("returns nothing without a players section", () => {
    expect(parseStatusPlayers("Unknown command\r\n")).toEqual([]);
  });
});

describe("tournament settings", () => {
  it("keeps a Challonge tournament id and drops anything that isn't one", () => {
    expect(cleanSettings({ challonge_url: " sub-abc_123 " }).challonge_url).toBe("sub-abc_123");
    expect(cleanSettings({ challonge_url: "../matches?x=1" }).challonge_url).toBeUndefined();
    expect(cleanSettings({}).challonge_url).toBeUndefined();
  });
});

describe("MatchZy event schemas", () => {
  const roundTeam = (id) => ({
    id,
    name: "Team " + id,
    series_score: 0,
    score: 3,
    score_ct: 2,
    score_t: 1,
    players: [{ steamid: "76561198000000001", name: "A", stats: { kills: 1 } }]
  });
  it("accepts real-shaped events, including null attacker, assist and weapon", () => {
    expect(eventProblem({ event: "going_live", matchid: 12, map_number: 0 })).toBeNull();
    expect(
      eventProblem({
        event: "round_end", matchid: 12, map_number: 0, round_number: 4, round_time: 51234, reason: 9,
        winner: { side: "3", team: "team1" }, team1: roundTeam("1"), team2: roundTeam(2)
      })
    ).toBeNull();
    expect(
      eventProblem({
        event: "player_death", matchid: "12", map_number: 0, round_number: 4, round_time: 1000,
        player: { steamid: 0, name: "BOT Bob", is_bot: true }, attacker: null, assist: null, weapon: null,
        headshot: false
      })
    ).toBeNull();
    expect(eventProblem({ event: "series_start", matchid: 12, num_maps: 3 })).toBeNull();
  });
  it("names the field that is wrong", () => {
    expect(eventProblem({ event: "going_live", matchid: 12 })).toMatch(/^going_live: map_number/);
    expect(
      eventProblem({ event: "player_death", matchid: 12, map_number: 0, round_number: 1, player: { name: "x" } })
    ).toMatch(/^player_death: player\.steamid/);
    expect(eventProblem({ event: "round_start", matchid: 12, map_number: -1, round_number: 0 })).toMatch(/map_number/);
    expect(eventProblem({ matchid: 12 })).toMatch(/no event name/);
  });
});

describe("forMatch (per-match stream listeners)", () => {
  it("skips other matches' events and keeps unscoped ones", () => {
    const calls = [];
    const listener = forMatch("7", () => calls.push("x"));
    listener(7);
    listener("8");
    listener();
    expect(calls).toEqual(["x", "x"]);
  });
});

describe("server heartbeat assessment", () => {
  const panel = (overrides = {}) => ({
    id: 12,
    team1_series_score: 0,
    team2_series_score: 0,
    maps: [{ map_number: 0, team1_score: 5, team2_score: 3, ended: false }],
    age_s: 600,
    ...overrides
  });
  const live = (overrides = {}) => ({
    gamestate: "live",
    matchid: 12,
    map_number: 0,
    maps: ["de_mirage", "de_inferno", "de_nuke"],
    team1: { series_score: 0, current_map_score: 5 },
    team2: { series_score: 0, current_map_score: 3 },
    ...overrides
  });

  it("is fine when the server matches the panel", () => {
    expect(assessServerState(panel(), live())).toEqual({ seen: "ok", reason: null, resync: null });
  });
  it("sees an offline server and a restarted or reloaded one", () => {
    expect(assessServerState(panel(), null).seen).toBe("offline");
    expect(assessServerState(panel(), { gamestate: "none" }).seen).toBe("interrupted");
    expect(assessServerState(panel(), live({ matchid: 99 })).reason).toMatch(/match 99/);
  });
  it("gives a new match time to load before 'no match loaded' counts", () => {
    expect(assessServerState(panel({ age_s: 20 }), { gamestate: "none" }).seen).toBe("ok");
  });
  it("resyncs a score, missed map ends and the series after missed events", () => {
    const { resync } = assessServerState(
      panel({ maps: [{ map_number: 0, team1_score: 9, team2_score: 6, ended: false }] }),
      live({ map_number: 1, team1: { series_score: 1, current_map_score: 4 }, team2: { series_score: 0, current_map_score: 2 } })
    );
    expect(resync).toEqual({
      map: { map_number: 1, map_name: "de_inferno", team1_score: 4, team2_score: 2, insert: true },
      close_maps: [0],
      series: { team1: 1, team2: 0 }
    });
  });
  it("doesn't compare scores before the map is live", () => {
    expect(assessServerState(panel(), live({ gamestate: "warmup", team1: { current_map_score: 0 } })).resync).toBeNull();
  });
  it("reports a problem only after two checks in a row", () => {
    const once = nextState({ state: "ok", strikes: 0 }, "offline");
    expect(once).toEqual({ state: "ok", strikes: 1 });
    expect(nextState(once, "offline")).toEqual({ state: "offline", strikes: 2 });
    expect(nextState({ state: "offline", strikes: 4 }, "ok")).toEqual({ state: "ok", strikes: 0 });
  });
});

describe("local login rules", () => {
  it("accepts sensible usernames and passwords and explains the rest", () => {
    expect(usernameProblem("martin_92")).toBeNull();
    expect(usernameProblem("ab")).toMatch(/3 to 32/);
    expect(usernameProblem("has space")).toMatch(/letters, digits/);
    expect(passwordProblem("long enough")).toBeNull();
    expect(passwordProblem("short")).toMatch(/at least 8/);
    expect(passwordProblem("x".repeat(73))).toMatch(/at most 72/);
  });
});

describe("write guard (deny by default)", () => {
  const admin = { admin: 1, super_admin: 0 };
  const player = { admin: 0, super_admin: 0 };
  it("lets anyone read, sign in and reach the game-server callbacks", () => {
    expect(writeAllowed("GET", "/teams", undefined).ok).toBe(true);
    expect(writeAllowed("POST", "/login", undefined).ok).toBe(true);
    expect(writeAllowed("POST", "/register", undefined).ok).toBe(true);
    expect(writeAllowed("POST", "/v2", undefined).ok).toBe(true);
    expect(writeAllowed("POST", "/v2/demo", undefined).ok).toBe(true);
  });
  it("lets signed-in users join PUGs and edit their own account, nothing else", () => {
    expect(writeAllowed("POST", "/pugs/4/join", player).ok).toBe(true);
    expect(writeAllowed("PUT", "/users", player).ok).toBe(true);
    for (const [method, path] of [["POST", "/teams"], ["PUT", "/teams"], ["DELETE", "/servers"], ["POST", "/matches"],
      ["POST", "/matches/3/pause"], ["POST", "/users"], ["POST", "/templates"], ["POST", "/pugs"], ["POST", "/v2/other"]]) {
      expect(writeAllowed(method, path, player)).toMatchObject({ ok: false, status: 403 });
    }
  });
  it("needs a login for anything else, and an admin to write", () => {
    expect(writeAllowed("POST", "/pugs/4/join", undefined)).toMatchObject({ ok: false, status: 401 });
    expect(writeAllowed("POST", "/teams", undefined)).toMatchObject({ ok: false, status: 401 });
    expect(writeAllowed("POST", "/teams", admin).ok).toBe(true);
    expect(writeAllowed("DELETE", "/servers", { admin: 0, super_admin: 1 }).ok).toBe(true);
  });
});

describe("config role lists", () => {
  it("are read from the config file each time, without a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "g5cfg-"));
    const before = process.env.NODE_CONFIG_DIR;
    process.env.NODE_CONFIG_DIR = dir;
    try {
      const write = (admins) => writeFileSync(join(dir, "test.json"), JSON.stringify({
        admins: { steam_ids: admins }, super_admins: { steam_ids: "76561198000000001" }
      }));
      write("76561198000000002");
      expect(configRoleLists()).toEqual({ admins: ["76561198000000002"], superAdmins: ["76561198000000001"] });
      write("76561198000000003, not-a-steam-id");
      expect(configRoleLists().admins).toEqual(["76561198000000003"]);
    } finally {
      process.env.NODE_CONFIG_DIR = before;
    }
  });
});
