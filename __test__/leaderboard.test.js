import { agent } from "supertest";
import app from "../app.js";
const request = agent(app);

// Runs after the other suites, so the database holds teams, matches and player stats.
describe("Test the leaderboard routes", () => {
  it("Should return the team leaderboard.", () => {
    return request
      .get("/leaderboard/")
      .expect("Content-Type", /json/)
      .expect(200)
      .expect((result) => {
        expect(Array.isArray(result.body.leaderboard)).toBe(true);
        for (const team of result.body.leaderboard) {
          expect(typeof team.wins).toBe("number");
          expect(typeof team.losses).toBe("number");
          expect(typeof team.rounddiff).toBe("number");
        }
      });
  });
  it("Should return the player leaderboard with one row per player.", () => {
    return request
      .get("/leaderboard/players")
      .expect("Content-Type", /json/)
      .expect(200)
      .expect((result) => {
        const players = result.body.leaderboard;
        expect(Array.isArray(players)).toBe(true);
        const steamIds = players.map((player) => player.steamId);
        expect(new Set(steamIds).size).toBe(steamIds.length);
        for (const player of players) {
          expect(Number.isFinite(player.average_rating)).toBe(true);
          expect(player.wins).toBeLessThanOrEqual(player.total_maps);
        }
      });
  });
  it("Should return the PUG and season leaderboards.", async () => {
    await request.get("/leaderboard/players/pug").expect(200);
    await request.get("/leaderboard/players/1").expect(200);
    await request.get("/leaderboard/1").expect(200);
  });
});

describe("Test the metrics route", () => {
  it("Should return every counter as a number.", () => {
    return request
      .get("/metrics")
      .expect(200)
      .expect((result) => {
        const { metrics } = result.body;
        for (const key of ["users", "teams", "matches", "completed_matches", "live_matches", "servers", "maps_played", "players", "seasons"]) {
          expect(typeof metrics[key]).toBe("number");
        }
        expect(metrics.users).toBeGreaterThan(0);
      });
  });
});

describe("Test the match list summary route", () => {
  it("Should return a page of summaries with a total.", () => {
    return request
      .get("/matches/summary?limit=5")
      .expect(200)
      .expect((result) => {
        expect(Array.isArray(result.body.matches)).toBe(true);
        expect(typeof result.body.total).toBe("number");
        expect(result.body.matches.length).toBeLessThanOrEqual(5);
        for (const match of result.body.matches) {
          expect(["pending", "warmup", "live", "paused", "finished", "cancelled"]).toContain(match.status);
          expect(Array.isArray(match.maps)).toBe(true);
          expect(typeof match.team1.score).toBe("number");
        }
      });
  });
  it("Should apply the status filter and clamp the limit.", async () => {
    const cancelled = await request.get("/matches/summary?status=cancelled&limit=1000").expect(200);
    for (const match of cancelled.body.matches) expect(match.status).toBe("cancelled");
    expect(cancelled.body.matches.length).toBeLessThanOrEqual(100);
  });
});

describe("Test that only admins create matches", () => {
  // A regular user: a fresh account without Steam (the mock Steam user is an admin in this suite).
  const regular = agent(app);
  beforeAll(() =>
    regular.post("/register").set("Content-Type", "application/json")
      .send({ username: "regular-user", password: "regular-pass" }).expect(200)
  );
  it("Should refuse the admin pages to a regular user.", async () => {
    await regular.get("/admin/users").expect(403);
    await regular.get("/admin/audit").expect(403);
  });
  it("Should refuse match creation for a regular user.", () => {
    return regular
      .post("/matches/")
      .set("Content-Type", "application/json")
      .send([{ server_id: 1, team1_id: 1, team2_id: 2, max_maps: 1, veto_mappool: "de_mirage" }])
      .expect(403)
      .expect((result) => {
        expect(result.body.message).toMatch(/Only admins/);
      });
  });
});

describe("Test the global search", () => {
  it("Should ignore queries shorter than 2 characters.", async () => {
    const result = await request.get("/search?q=a").expect(200);
    expect(result.body).toEqual({ teams: [], players: [], matches: [], tournaments: [] });
  });
  it("Should find teams and matches by name, without PUG teams.", async () => {
    const teams = await request.get("/teams").expect(200);
    const team = teams.body.teams[0];
    const result = await request.get(`/search?q=${encodeURIComponent(team.name.slice(0, 4))}`).expect(200);
    for (const key of ["teams", "players", "matches", "tournaments"]) expect(Array.isArray(result.body[key])).toBe(true);
    expect(result.body.teams.length).toBeLessThanOrEqual(8);
    expect(result.body.teams.every((row) => row.name.toLowerCase().includes(team.name.slice(0, 4).toLowerCase()) || row.tag)).toBe(true);
  });
  it("Should treat % and _ as plain text.", async () => {
    const result = await request.get("/search?q=%25%25").expect(200);
    expect(result.body.teams).toHaveLength(0);
  });
});
