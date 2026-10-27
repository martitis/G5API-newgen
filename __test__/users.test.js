import { agent } from 'supertest';
import app from '../app.js'
import { hashSync } from 'bcrypt';
import { db } from '../src/services/db.js';
const request = agent(app);
let adminCheck = 0;

describe("Test the user routes", () => {
  beforeAll(async () => {
    await request.get('/auth/steam/return')
      .expect(302);
      return;
  });
  it("Should get 200 from all users", () => {
    return request
      .get('/users')
      .expect(200);
  });
  it('Should return all users.', () => {
    return request.get('/users')
      .expect('Content-Type', /json/)
      .expect(200);
  });
  it('Should setup a new user only if we are an admin or super_admin.', () => {
    let newUserData = [{
      id: 1,
      steam_id: 1234,
      name: "Test User",
      admin: 0,
      super_admin: 0
    }];
    return request.post('/users').
      set('Content-Type', 'application/json').
      set('Accept', 'application/json').
      send(newUserData).
      expect(200);
  });
  it('Should get a user with a given database ID.', () => {
    return request.get('/users/1')
      .expect('Content-Type', /json/)
      .expect((res) => {
        expect(res.body.user.id).toEqual(1);
      })
      .expect(200);
    adminCheck = result.body.user.admin + result.body.user.super_admin;
  });
  it('Should get a users steam url from database ID or Steam ID.', () => {
    return request.get('/users/1/steam')
      .expect('Content-Type', /json/)
      .expect(200)
      .expect((res) => {
        expect(res.body.url).toMatch(/steamcommunity/);
      });
  });
  it('Should refuse admin rights for an account that never signed in with Steam.', async () => {
    // A separate client, so the super admin's session stays logged in.
    await agent(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ username: "localonly", password: "localonly-pass", steam_id: "76561198000000777" })
      .expect(200);
    return request.put('/users')
      .set('Content-Type', 'application/json')
      .send([{ steam_id: "76561198000000777", admin: 1 }])
      .expect(412)
      .expect((res) => {
        expect(res.body.message).toMatch(/never confirmed by a Steam login/);
      });
  });
  it('Should explain what is wrong with a registration.', async () => {
    const client = agent(app);
    const register = (body) => client.post('/register').set('Content-Type', 'application/json').send(body);
    expect((await register({ username: "shortpw", password: "short", steam_id: "76561198000000778" }).expect(401)).body.message)
      .toMatch(/at least 8/);
    expect((await register({ username: "x y", password: "long enough", steam_id: "76561198000000778" }).expect(401)).body.message)
      .toMatch(/3 to 32/);
    expect((await register({ username: "nosteam", password: "long enough", steam_id: "STEAM_0:1:not-a-number" }).expect(401)).body.message)
      .toMatch(/SteamID64 or Steam profile link/);
    expect((await register({ username: "localonly", password: "long enough", steam_id: "76561198000000778" }).expect(401)).body.message)
      .toMatch(/username is taken/);
    expect((await register({ username: "sameacct", password: "long enough", steam_id: "76561198000000777" }).expect(401)).body.message)
      .toMatch(/already has a panel account/);
    // A profile link works as well as the bare SteamID64.
    await register({ username: "viaprofile", password: "long enough", steam_id: "https://steamcommunity.com/profiles/76561198000000779/" })
      .expect(200);
    const me = await client.get('/isloggedin').expect(200);
    expect(me.body.steam_id).toBe("76561198000000779");
  });
  it('Should sign in with a local login, and refuse a wrong password with one message.', async () => {
    const client = agent(app);
    const login = (password) => client.post('/login').set('Content-Type', 'application/json').send({ username: "localonly", password });
    expect((await login("wrong password").expect(401)).body.message).toBe("Wrong username or password.");
    await login("localonly-pass").expect(200);
  });
  it('Should tell the panel how users can sign in.', async () => {
    const res = await request.get('/auth/options').expect(200);
    expect(res.body).toEqual({ steam: true, local_login: true, password_min: 8, password_max: 72 });
  });
  it('Should let a Steam user add a username and password, then sign in with them.', async () => {
    await request.put('/users').set('Content-Type', 'application/json')
      .send([{ steam_id: "76561198000000042", username: "localonly", password: "steamuser-pass" }])
      .expect(409);
    await request.put('/users').set('Content-Type', 'application/json')
      .send([{ steam_id: "76561198000000042", username: "testadmin", password: "short" }])
      .expect(412);
    await request.put('/users').set('Content-Type', 'application/json')
      .send([{ steam_id: "76561198000000042", username: "testadmin", password: "steamuser-pass" }])
      .expect(200);
    await agent(app).post('/login').set('Content-Type', 'application/json')
      .send({ username: "testadmin", password: "steamuser-pass" })
      .expect(200);
  });
  it('Should let a super admin make an account without Steam an admin.', async () => {
    const local = agent(app);
    await local.post('/register').set('Content-Type', 'application/json')
      .send({ username: "nosteam-admin", password: "nosteam-admin-pass" }).expect(200);
    const me = (await local.get('/isloggedin').expect(200)).body;
    expect(me.steam_id).toBeNull();
    await request.put('/users').set('Content-Type', 'application/json').send([{ id: me.id, admin: 1 }]).expect(200);
    // Promoted on its next request: a write that only fails validation passes the admin check.
    expect((await local.post('/templates').set('Content-Type', 'application/json').send([{}])).status).toBe(412);
  });
  it('Should list users with their roles for a super admin.', () => {
    return request.get('/admin/users')
      .expect(200)
      .expect((res) => {
        const me = res.body.users.find((user) => user.id === 1);
        expect(me.super_admin).toBe(1);
        expect(me.roles_from_config).toBe(1);
      });
  });
  it('Should save, replace, list and delete match templates.', async () => {
    const body = { name: "Scrim BO1", settings: { maps_to_win: 1, map_pool: ["de_nuke"], cvars: { mp_overtime_enable: 0 } } };
    const first = await request.post('/templates').set('Content-Type', 'application/json').send([body]).expect(200);
    const again = await request.post('/templates').set('Content-Type', 'application/json')
      .send([{ ...body, settings: { ...body.settings, maps_to_win: 3 } }]).expect(200);
    expect(again.body.id).toBe(first.body.id);
    const list = await request.get('/templates').expect(200);
    expect(list.body.templates).toHaveLength(1);
    expect(list.body.templates[0].settings).toMatchObject({ maps_to_win: 3, map_pool: ["de_nuke"], cvars: { mp_overtime_enable: "0" } });
    await request.post('/templates').set('Content-Type', 'application/json')
      .send([{ name: "Bad", settings: { cvars: { rcon_password: "x" } } }]).expect(412);
    await request.delete(`/templates/${first.body.id}`).expect(200);
    await request.delete(`/templates/${first.body.id}`).expect(404);
  });
  it('Should search the audit log text.', async () => {
    const hit = await request.get('/admin/audit?q=user.create').expect(200);
    expect(hit.body.total).toBeGreaterThan(0);
    const miss = await request.get('/admin/audit?q=no-such-entry-xyz').expect(200);
    expect(miss.body.total).toBe(0);
  });
  it('Should have written the user creation to the audit log.', () => {
    return request.get('/admin/audit?action=user.')
      .expect(200)
      .expect((res) => {
        expect(res.body.total).toBeGreaterThan(0);
        expect(res.body.entries[0]).toMatchObject({ action: expect.stringMatching(/^user\./), user_id: 1 });
      });
  });
  it('Should update the existing test user to remove admin privileges.', () => {
    let updatedUserData = [{
      id: 1,
      steam_id: '76561198000000042',
      name: "Get Updated Kid",
      admin: 0,
      super_admin: 0
    }];
    return request.put('/users')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json')
    .send(updatedUserData)
    .expect(200);
  });
  it('Should attempt to create a user without permission.', async () => {
    let newUserData = [{
      id: 1,
      steam_id: 10001,
      name: "Bad Act0r",
      admin: 1,
      super_admin: 1
    }];
    return request.post('/users')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json')
    .send(newUserData)
    .expect(403);
  });
  afterAll(async () => {
    // The later suites run as a regular admin (not a super admin). Roles are read on every request now, so the
    // demotion above would otherwise stick; a role set in the panel (roles_from_config = 0) survives their logins.
    await db.query("UPDATE user SET admin = 1, super_admin = 0, roles_from_config = 0 WHERE steam_id = ?", ["76561198000000042"]);
  });
  describe("permissions", () => {
    it("Should register without a Steam account, and leave that user read only.", async () => {
      const player = agent(app);
      await player.post('/register').set('Content-Type', 'application/json')
        .send({ username: "nosteam", password: "nosteam-pass" }).expect(200);
      const me = (await player.get('/isloggedin').expect(200)).body;
      expect(me).toMatchObject({ steam_id: null, admin: 0, super_admin: 0 });
      // Reads work; every write except the account itself is refused by the guard.
      await player.get('/teams').expect((res) => expect([200, 404]).toContain(res.status));
      for (const [method, path] of [["post", "/teams"], ["put", "/teams"], ["post", "/servers"], ["delete", "/seasons"],
        ["post", "/matches"], ["post", "/templates"], ["post", "/tournaments"], ["post", "/maps"]]) {
        const res = await player[method](path).set('Content-Type', 'application/json').send([{}]);
        expect([method, path, res.status, res.body.message]).toEqual([method, path, 403, "Only admins can change things on this panel."]);
      }
      // Server addresses aren't for regular users.
      await player.get('/servers/available').expect(403);
      // Their own account is theirs to change.
      await player.put('/users').set('Content-Type', 'application/json')
        .send([{ id: me.id, old_password: "nosteam-pass", password: "nosteam-pass2" }]).expect(200);
    });
    it("Should apply a role change to a signed-in user on their next request, and sign out a deleted account.", async () => {
      const insert = await db.query("INSERT INTO user SET ?", [{
        steam_id: "76561198000000555", name: "Promoted", admin: 0, super_admin: 0, steam_verified: 1,
        username: "promoted", password: hashSync("promoted-pass", 4), api_key: null
      }]);
      const id = insert.insertId;
      const user = agent(app);
      await user.post('/login').set('Content-Type', 'application/json')
        .send({ username: "promoted", password: "promoted-pass" }).expect(200);
      // A write that would only fail validation shows whether the guard let it through.
      const tryWrite = () => user.post('/templates').set('Content-Type', 'application/json').send([{}]);
      expect((await tryWrite()).status).toBe(403);
      await db.query("UPDATE user SET admin = 1 WHERE id = ?", [id]);
      expect((await tryWrite()).status).toBe(412);
      await db.query("UPDATE user SET admin = 0 WHERE id = ?", [id]);
      expect((await tryWrite()).status).toBe(403);
      // An account whose Steam ID was never proven is never an admin, whatever its flags say.
      await db.query("UPDATE user SET admin = 1, steam_verified = 0 WHERE id = ?", [id]);
      expect((await tryWrite()).status).toBe(403);
      await db.query("DELETE FROM map_list WHERE user_id = ?", [id]);
      await db.query("DELETE FROM user WHERE id = ?", [id]);
      expect((await user.get('/isloggedin').expect(200)).body).toBe(false);
    });
  });
});