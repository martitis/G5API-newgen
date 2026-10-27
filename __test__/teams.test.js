import { agent } from 'supertest';
import app from '../app.js';
import { importParticipants } from '../src/services/challonge.js';
import { db } from '../src/services/db.js';
const request = agent(app);

describe("Test the team routes", () => {
  beforeAll(() => {
    return request.get('/auth/steam/return')
      .expect(302);
  });
  it('Should return 404 as no teams exist.', () => {
    return request.get('/teams/')
      .expect(404);
  });
  it('Should create a single team under the mock user.', () => {
    let teamData = [{
      name: 'TopShelf Testing',
      flag: 'CA',
      logo: null,
      tag: 'TPSHLF',
      public_team: 1,
      auth_name: {
        "76561198025644200": {
          "name": "Other Player"
        }
      }
    }];
    return request
      .post('/teams/')
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(teamData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should create a single team that is not public.', () => {
    let privateTeamData = [{
      name: 'Private Collection',
      flag: 'US',
      logo: null,
      tag: 'PRVSHLF',
      public_team: 0,
      auth_name: {
        "76561198025644200": {
          "name": "Other Player"
        },
        "76561198000000042": {
          "name": "Test Admin"
        }
      }
    }];
    return request
      .post('/teams/')
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(privateTeamData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should create a single team for later tests.', () => {
    let privateTeamData = [{
      name: 'Private Collection #2',
      flag: 'US',
      logo: null,
      tag: 'PRVSHLF2',
      public_team: 1,
      auth_name: {
        "76561198025644200": {
          "name": "Other Player"
        },
        "76561198000000042": {
          "name": "Test Admin"
        }
      }
    }];
    return request
      .post('/teams/')
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(privateTeamData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should create another single team for later tests.', () => {
    let privateTeamData = [{
      name: 'Private Collection #3',
      flag: 'CA',
      logo: null,
      tag: 'PRVSHLF3',
      public_team: 1,
      auth_name: {
        "76561198025644200": {
          "name": "Other Player",
          "captain": 0,
          "coach": 0
        },
        "76561198025644201": {
          "name": "Test Admin",
          "captain": 0,
          "coach": 0
        }
      }
    }];
    return request
      .post('/teams/')
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(privateTeamData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should get the first team.', () => {
    return request.get('/teams/1')
      .expect(200);
  });
  it('Should update a team to include a new user.', () => {
    let updateTeamData = [{
      id: 1,
      name: 'Bottom Shelf',
      flag: 'US',
      logo: null,
      tag: 'BTMSHLF',
      public_team: 1,
      auth_name: {
        "76561198025644201": {
          "name": "New team member!"
        }
      }
    }];
    return request
      .put("/teams/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(updateTeamData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should update a team to update the new users name.', () => {
    let updateTeamData = [{
      id: 1,
      name: 'Bottom Shelf',
      flag: 'US',
      logo: null,
      tag: 'BTMSHLF',
      public_team: 1,
      auth_name: {
        "76561198025644201": {
          "name": "New team member EDITED!"
        }
      }
    }];
    return request
      .put("/teams/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(updateTeamData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should update the second team to change users.', () => {
    let updateTeamData = [{
      id: 2,
      user_id: 2
    }];
    return request
      .put("/teams/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(updateTeamData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should delete a first team.', () => {
    let deleteTeamData = [{
      team_id: 1
    }];
    return request
      .delete("/teams/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(deleteTeamData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  // Admins manage every team, not only their own.
  it('Should update a team it no longer owns, as an admin.', () => {
    let updateTeamData = [{
      id: 2,
      user_id: 1
    }];
    return request
      .put("/teams/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(updateTeamData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should delete a team it doesn\'t own, as an admin.', async () => {
    await request.put("/teams/").set("Content-Type", "application/json").send([{ id: 2, user_id: 2 }]).expect(200);
    return request
      .delete("/teams/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send([{ team_id: 2 }])
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it('Should delete a team it doesn\'t exist.', () => {
    let deleteTeamData = [{
      team_id: 99
    }];
    return request
      .delete("/teams/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(deleteTeamData)
      .expect(404)
      .expect((result) => {
        expect(result.body.message).toMatch(/does not exist/);
      });
  });
  it("Should resolve pasted Steam identifiers one by one, in order.", () => {
    return request
      .post("/teams/members/resolve")
      .set("Content-Type", "application/json")
      .send([{ ids: ["76561198025644201", "STEAM_0:1:32689236", "!!not a steam id!!"] }])
      .expect(200)
      .expect((result) => {
        const [first, second, third] = result.body.members;
        expect(first).toMatchObject({ input: "76561198025644201", steam_id: "76561198025644201" });
        expect(second.steam_id).toMatch(/^7656\d{13}$/);
        expect(third).toMatchObject({ input: "!!not a steam id!!", steam_id: null });
      });
  });
  it("Should refuse an empty or oversized resolve request.", async () => {
    await request.post("/teams/members/resolve").send([{ ids: [] }]).expect(412);
    await request
      .post("/teams/members/resolve")
      .send([{ ids: Array.from({ length: 51 }, (_, n) => String(76561198000000000 + n)) }])
      .expect(412);
  });
  it('Should import Challonge participants once and roll back a failed import.', async () => {
    const participant = (id, name, fields) => ({ participant: { id, display_name: name, custom_field_response: fields } });
    // Raw Steam IDs only: other values are looked up as vanity URLs on the Steam API.
    const first = await importParticipants(1, [participant(990001, 'Imported A', { a: '76561198000000101' })]);
    expect(first).toEqual({ imported: 1, updated: 0, skipped: [] });
    const again = await importParticipants(1, [participant(990001, 'Imported A2', {})]);
    expect(again.updated).toBe(1);
    // The second participant's id isn't a number, so the whole batch is rolled back.
    await expect(
      importParticipants(1, [participant(990002, 'Rolled back', {}), participant('broken', 'Broken', {})])
    ).rejects.toThrow();
    const rows = await db.query('SELECT name FROM team WHERE challonge_team_id IN (990001, 990002) ORDER BY name');
    expect(rows.map((row) => row.name)).toEqual(['Imported A2']);
  });
});