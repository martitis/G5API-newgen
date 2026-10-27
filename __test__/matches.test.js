import { agent } from 'supertest';
import app from '../app.js';
import { checkMatch } from '../src/services/heartbeat.js';
import { db } from '../src/services/db.js';
const request = agent(app);

describe("Test the matches routes", () => {
  beforeAll(() => {
    return request.get('/auth/steam/return')
      .expect(302);
  });
  it('Should retrieve all matches, even if none.', () => {
    return request.get('/matches/')
      .expect(404);
  });
  it('Should create a single match that is ready to be played with teams.', () => {
    // Min required data.
    let newMatchData = [
      {
        server_id: 3,
        team1_id: 4,
        team2_id: 3,
        max_maps: 1,
        title: "Map {MAPNUMBER} of {MAXMAPS}",
        veto_mappool: "de_dust2, de_cache, de_mirage",
        skip_veto: 0,
        ignore_server: true
      }
    ];
    return request
      .post("/matches/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(newMatchData)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      })
      .expect(200);
  });
  it('Should update a match with a start time and a test CVAR.', () => {
    let updatedMatchData = [
      {
        match_id: 1,
        start_time: new Date().toISOString().slice(0, 19).replace('T', ' '),
        plugin_version: '0.7.2',
        match_cvars: {
          "mp_autobalanceteams": "1",
          "mp_test_value": 0
        }
      }
    ];
    return request
      .put("/matches/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(updatedMatchData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should retrieve the config for a match.', () => {
    return request.get("/matches/1/config")
      .expect(200)
      .expect((result) => {
        expect(result.body.cvars.matchzy_remote_log_url).toMatch(/http.*\/v2$/);
        expect(result.body.cvars.get5_check_auths).toBeUndefined();
        expect(result.body.cvars.mp_autobalanceteams).toBe("1");
        expect(result.body.maplist).toEqual(["de_dust2", "de_cache", "de_mirage"]);
        expect(result.body.matchid).toBe(1);
        expect(result.body.spectators.players).toEqual({});
      });
  });
  it('Should get the first match.', () => {
    return request.get('/matches/1')
      .expect(200)
      .expect((result) => {
        expect(result.body.match.api_key).not.toBeUndefined();
      });
  });
  it('Should first update the first match to attempt to break things right after.', () => {
    let updatedMatchData = [
      {
        match_id: 1,
        user_id: 2
      }
    ];
    return request
      .put("/matches/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(updatedMatchData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  // Admins manage every match, not only their own.
  it('Should show an admin the API key of a match it does not own.', () => {
    return request.get('/matches/1')
      .expect(200)
      .expect((result) => {
        expect(result.body.match.api_key).not.toBeUndefined();
      });
  });
  it('Should let an admin edit a match it does not own.', () => {
    let updatedMatchData = [
      {
        match_id: 1,
        title: "Edited by another admin"
      }
    ];
    return request
      .put("/matches/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(updatedMatchData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should let an admin hand a match back to its first owner.', () => {
    return request
      .put("/matches/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send([{ match_id: 1, user_id: 1 }])
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should create a single match that is ready to be cancelled.', () => {
    let newMatchData = [
      {
        server_id: 2,
        team1_id: 4,
        team2_id: 3,
        max_maps: 1,
        title: "Map {MAPNUMBER} of {MAXMAPS}",
        veto_mappool: "de_vertigo, de_inferno, de_mirage",
        skip_veto: 1,
        ignore_server: true
      },
    ];
    return request
      .post("/matches/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(newMatchData)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      })
      .expect(200);
  });
  it('Should forfeit the match.', () => {
    let updatedMatchData = [
      {
        match_id: 2,
        forfeit: 1,
        end_time: new Date().toISOString().slice(0, 19).replace('T', ' ')
      },
    ];
    return request
      .put("/matches/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(updatedMatchData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should delete the match.', () => {
    let updatedMatchData = [
      {
        match_id: 2
      },
    ];
    return request
      .delete("/matches/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(updatedMatchData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should create a single match that is ready for further testing.', () => {
    let newMatchData = [
      {
        server_id: 2,
        team1_id: 4,
        team2_id: 3,
        max_maps: 1,
        title: "Map {MAPNUMBER} of {MAXMAPS}",
        veto_mappool: "de_vertigo, de_inferno, de_mirage",
        skip_veto: 1,
        ignore_server: true
      },
    ];
    return request
      .post("/matches/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(newMatchData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });

  describe("tournaments", () => {
    let tournamentId;
    let finalNode;
    it("Should create a single elimination tournament in draft.", async () => {
      const result = await request
        .post("/tournaments")
        .set("Content-Type", "application/json")
        .send([{
          name: "Test Cup",
          format: "single_elim",
          team_ids: [4, 3],
          settings: { best_of: 1, final_best_of: 1, map_pool: ["de_mirage", "de_nuke"] }
        }])
        .expect(200);
      tournamentId = result.body.id;
      expect(tournamentId).toBeGreaterThan(0);
    });
    it("Should refuse a map pool shorter than the longest series.", () => {
      return request
        .post("/tournaments")
        .set("Content-Type", "application/json")
        .send([{ name: "Bad", format: "swiss", team_ids: [4, 3], settings: { final_best_of: 3, map_pool: ["de_mirage"] } }])
        .expect(412);
    });
    it("Should start it with one ready final between the seeds.", async () => {
      await request.post(`/tournaments/${tournamentId}/start`).expect(200);
      await request.get("/tournaments/99999/stream").expect(404);
      const result = await request.get(`/tournaments/${tournamentId}`).expect(200);
      expect(result.body.tournament.status).toBe("running");
      expect(result.body.nodes).toHaveLength(1);
      finalNode = result.body.nodes[0];
      expect(finalNode).toMatchObject({ status: "ready", team1_id: 4, team2_id: 3, final: true });
      await request.post(`/tournaments/${tournamentId}/start`).expect(412);
    });
    it("Should only create the slot's match with the slot's teams.", async () => {
      const base = { max_maps: 1, veto_mappool: "de_mirage de_nuke", ignore_server: true, tournament_match_id: finalNode.id };
      await request.post("/matches/").set("Content-Type", "application/json")
        .send([{ ...base, team1_id: 3, team2_id: 4 }]).expect(412);
      const created = await request.post("/matches/").set("Content-Type", "application/json")
        .send([{ ...base, team1_id: 4, team2_id: 3 }]).expect(200);
      finalNode.match_id = created.body.id;
      await request.post("/matches/").set("Content-Type", "application/json")
        .send([{ ...base, team1_id: 4, team2_id: 3 }]).expect(409);
    });
    it("Should finish the tournament when the final has a winner.", async () => {
      await request.put("/matches/").set("Content-Type", "application/json")
        .send([{ match_id: finalNode.match_id, winner: 3, team1_score: 0, team2_score: 1,
          end_time: new Date().toISOString().slice(0, 19).replace("T", " ") }])
        .expect(200);
      await request.post(`/tournaments/${tournamentId}/refresh`).expect(200);
      const result = await request.get(`/tournaments/${tournamentId}`).expect(200);
      expect(result.body.tournament.status).toBe("finished");
      expect(result.body.nodes[0]).toMatchObject({ status: "done", winner_id: 3, score: [0, 1] });
    });
  });

  describe("PUG queues", () => {
    let queueId;
    it("Should open a queue (admins only) and list it as open.", async () => {
      const created = await request
        .post("/pugs")
        .set("Content-Type", "application/json")
        .send([{ title: "Evening PUG", settings: { players_per_team: 1, formation: "random", map_pool: ["de_mirage"] } }])
        .expect(200);
      queueId = created.body.id;
      const list = await request.get("/pugs").expect(200);
      expect(list.body.queues.find((queue) => queue.id === queueId)).toMatchObject({ joined: 0, size: 2, status: "open" });
    });
    it("Should let a Steam user join once, and refuse an unverified local account.", async () => {
      await request.post(`/pugs/${queueId}/join`).expect(200);
      await request.post(`/pugs/${queueId}/join`).expect(200);
      const detail = await request.get(`/pugs/${queueId}`).expect(200);
      expect(detail.body.players).toHaveLength(1);
      expect(detail.body.players[0].rating).toBeGreaterThan(0);
      const local = agent(app);
      await local
        .post("/register")
        .set("Content-Type", "application/json")
        .send({ username: "pugger", password: "pugger-pass", steam_id: "76561198000000888" })
        .expect(200);
      await local.post(`/pugs/${queueId}/join`).expect(403);
    });
    it("Should refuse a ready when there is no ready check, then leave and cancel.", async () => {
      await request.post(`/pugs/${queueId}/ready`).expect(409);
      await request.post(`/pugs/${queueId}/leave`).expect(200);
      expect((await request.get(`/pugs/${queueId}`)).body.players).toHaveLength(0);
      await request.post(`/pugs/${queueId}/cancel`).expect(200);
      expect((await request.get(`/pugs/${queueId}`)).body.queue.status).toBe("cancelled");
      await request.post(`/pugs/${queueId}/join`).expect(409);
    });
  });

  describe("match control", () => {
    it("Should check control commands for the match owner, and refuse bad ones.", async () => {
      const created = await request.post("/matches/").set("Content-Type", "application/json")
        .send([{ server_id: 2, team1_id: 4, team2_id: 3, max_maps: 1, veto_mappool: "de_nuke", ignore_server: true }])
        .expect(200);
      const id = created.body.id;
      const ok = await request.post(`/matches/${id}/control`).set("Content-Type", "application/json")
        .send([{ action: "say", message: "Match starts in 10 min" }]).expect(200);
      expect(ok.body.response).toBe("css_asay Match starts in 10 min");
      await request.post(`/matches/${id}/control`).set("Content-Type", "application/json")
        .send([{ action: "cvar", cvar: "sv_cheats", value: 1 }]).expect(412);
      const audit = await request.get("/admin/audit?action=match.control");
      // The matches suite runs as an admin (not super admin), so the audit log itself is refused here.
      expect([200, 403]).toContain(audit.status);
    });
    it("Should list connected players and refuse a bad kick id.", async () => {
      const created = await request.post("/matches/").set("Content-Type", "application/json")
        .send([{ server_id: 2, team1_id: 4, team2_id: 3, max_maps: 1, veto_mappool: "de_nuke", ignore_server: true }])
        .expect(200);
      const id = created.body.id;
      const players = await request.get(`/matches/${id}/server/players`).expect(200);
      expect(players.body.players).toEqual([]);
      await request.post(`/matches/${id}/server/kick`).set("Content-Type", "application/json")
        .send([{ userid: "2; quit" }]).expect(412);
      await request.post(`/matches/${id}/server/kick`).set("Content-Type", "application/json")
        .send([{ userid: 2 }]).expect(200);
      const ready = await request.get(`/matches/${id}/ready`).expect(200);
      expect(ready.body.ready).toBeNull();
      await request.get("/matches/99999/ready").expect(404);
    });
  });

  describe("server heartbeat", () => {
    it("Should resync missed scores, then flag a restarted server and let an admin dismiss it.", async () => {
      const created = await request.post("/matches/").set("Content-Type", "application/json")
        .send([{ server_id: 2, team1_id: 4, team2_id: 3, max_maps: 3, veto_mappool: "de_nuke de_inferno de_mirage", ignore_server: true }])
        .expect(200);
      const id = created.body.id;
      // Loaded 10 minutes ago, so "no match loaded" isn't within the loading grace period.
      await db.query("UPDATE `match` SET start_time = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE) WHERE id = ?", [id]);
      const status = (overrides) => async () => ({
        gamestate: "live", matchid: id, map_number: 0, maps: ["de_nuke", "de_inferno", "de_mirage"],
        team1: { series_score: 0, current_map_score: 7 }, team2: { series_score: 0, current_map_score: 4 },
        ...overrides
      });

      // The panel never saw map 0 go live: the row is created from the server's score.
      let state = await checkMatch(id, status());
      expect(state.state).toBe("ok");
      let maps = await db.query("SELECT map_number, team1_score, team2_score, stats_incomplete FROM map_stats WHERE match_id = ?", [id]);
      expect(maps).toEqual([expect.objectContaining({ map_number: 0, team1_score: 7, team2_score: 4, stats_incomplete: 1 })]);

      // A changed score is only taken once the server reported it twice.
      await checkMatch(id, status({ team1: { series_score: 0, current_map_score: 9 } }));
      maps = await db.query("SELECT team1_score FROM map_stats WHERE match_id = ? AND map_number = 0", [id]);
      expect(maps[0].team1_score).toBe(7);
      await checkMatch(id, status({ team1: { series_score: 0, current_map_score: 9 } }));
      maps = await db.query("SELECT team1_score FROM map_stats WHERE match_id = ? AND map_number = 0", [id]);
      expect(maps[0].team1_score).toBe(9);

      // Restarted server: reported after the second check in a row.
      expect((await checkMatch(id, async () => ({ gamestate: "none" }))).state).toBe("ok");
      expect((await checkMatch(id, async () => ({ gamestate: "none" }))).state).toBe("interrupted");
      const read = await request.get(`/matches/${id}/server/state`).expect(200);
      expect(read.body.server_state).toMatchObject({ state: "interrupted", dismissed: false });
      expect(read.body.server_state.reason).toMatch(/No match is loaded/);

      await request.post(`/matches/${id}/server/dismiss`).expect(200);
      expect((await request.get(`/matches/${id}/server/state`)).body.server_state.dismissed).toBe(true);
      // Reload needs a real server; in tests MatchZy "doesn't load", which the route still accepts.
      await request.post(`/matches/${id}/server/reload`).expect(200);
      // Back to normal clears the warning and the dismissal.
      state = await checkMatch(id, status({ team1: { series_score: 0, current_map_score: 9 } }));
      expect(state).toMatchObject({ state: "ok", dismissed_at: null });
      // Later suites expect no map stats and start their ids at 1.
      await db.query("DELETE FROM map_stats WHERE match_id = ?", [id]);
      await db.query("ALTER TABLE map_stats AUTO_INCREMENT = 1");
      await db.query("UPDATE `match` SET cancelled = 1, end_time = UTC_TIMESTAMP() WHERE id = ?", [id]);
    });
    it("Should refuse server actions for anonymous users.", async () => {
      const anonymous = agent(app);
      await anonymous.post("/matches/1/server/check").expect(401);
      await anonymous.post("/matches/1/server/dismiss").expect(401);
    });
  });

  describe("scheduled matches", () => {
    const soon = () => new Date(Date.now() + 5 * 60000).toISOString();
    const match = { team1_id: 4, team2_id: 3, max_maps: 1, veto_mappool: "de_nuke", ignore_server: true };
    it("Should schedule a match, list it, run it now and refuse to cancel it afterwards.", async () => {
      const created = await request.post("/scheduled").set("Content-Type", "application/json")
        .send([{ run_at: soon(), match }]).expect(200);
      const list = await request.get("/scheduled").expect(200);
      const entry = list.body.scheduled.find((row) => row.id === created.body.id);
      expect(entry).toMatchObject({ status: "pending", team1_id: 4, team2_id: 3 });
      expect(entry.run_at).toMatch(/Z$/);
      const run = await request.post(`/scheduled/${created.body.id}/run`).expect(200);
      expect(run.body.scheduled.status).toBe("loaded");
      expect(run.body.scheduled.match_id).toBeGreaterThan(0);
      await request.post(`/scheduled/${created.body.id}/cancel`).expect(409);
    });
    it("Should cancel a waiting one and refuse bad times and teams.", async () => {
      const created = await request.post("/scheduled").set("Content-Type", "application/json")
        .send([{ run_at: soon(), match }]).expect(200);
      await request.post(`/scheduled/${created.body.id}/cancel`).expect(200);
      await request.post("/scheduled").set("Content-Type", "application/json")
        .send([{ run_at: "2020-01-01T00:00:00Z", match }]).expect(412);
      await request.post("/scheduled").set("Content-Type", "application/json")
        .send([{ run_at: soon(), match: { ...match, team2_id: 4 } }]).expect(412);
    });
  });
});