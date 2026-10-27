import { agent } from "supertest";
import app from "../app.js";
import { checkServer } from "../src/services/heartbeat.js";
import { db } from "../src/services/db.js";
const request = agent(app);
const password = "SUPER SECRET DON'T TELL";
const mockSteamId = "76561198000000042";
const setSuperAdmin = (on) =>
  db.query("UPDATE user SET admin = 1, super_admin = ?, roles_from_config = 0 WHERE steam_id = ?", [on ? 1 : 0, mockSteamId]);

describe("Test the game server routes.", () => {
  // Game servers are managed by super admins only; the users suite left the test user a plain admin.
  beforeAll(async () => {
    await request.get("/auth/steam/return").expect(302);
    await setSuperAdmin(true);
  });
  afterAll(() => setSuperAdmin(false));
  it("Should return all servers depending on permission of user.", () => {
    return request
      .get("/servers")
      .expect("Content-Type", /json/)
      .expect(200);
  });
  it("Should setup a new server with the given values.", () => {
    let newServerData = [
      {
        ip_string: "192.168.0.1",
        port: 27015,
        display_name: "Temp Server",
        rcon_password: password,
        public_server: 1,
      },
    ];
    return request
      .post("/servers/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(newServerData)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      })
      .expect(200);
  });
  it("Should setup a new server with the given values.", () => {
    let newServerData = [
      {
        ip_string: "192.168.0.1",
        port: 27016,
        display_name: "Temp Server #2",
        rcon_password: password,
        public_server: 1,
      },
    ];
    return request
      .post("/servers/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(newServerData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it("Should setup a new server so we can play with it later.", () => {
    let newServerData = [
      {
        ip_string: "192.168.0.1",
        port: 27020,
        display_name: "Permanent Server",
        rcon_password: password,
        public_server: 1,
      },
    ];
    return request
      .post("/servers/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(newServerData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it("Request the information of the inserted server.", () => {
    return request
      .get("/servers/1")
      .expect("Content-Type", /json/)
      .expect(200)
      // RCON passwords are never part of the server info.
      .expect((result) => {
        expect(result.body.server.rcon_password).toEqual(undefined);
      });
  });
  it("Reveal the RCON password of our own server.", () => {
    return request
      .get("/servers/1/rcon")
      .expect("Content-Type", /json/)
      .expect(200)
      // Test to decrypt the password, if it matches then we decrypt/encrypt properly!
      .expect((result) => {
        expect(result.body.rcon_password).toBe(password);
      });
  });
  it("Request the information of all users servers.", () => {
    return request
      .get("/servers/myservers")
      .expect("Content-Type", /json/)
      .expect(200)
      .expect((result) => {
        expect(result.body.servers.length).toBeGreaterThanOrEqual(1);
      });
  });
  it("Should transfer ownership to the second user.", () => {
    let updatedServerData = [
      {
        display_name: "Temp Server #2 EDITED",
        user_id: 2,
        server_id: 2,
      },
    ];
    return request
      .put("/servers/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(updatedServerData)
      .expect(200)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      });
  });
  it("Should delete the information of the first server.", () => {
    let deleteData = [{ server_id: 1 }];
    return request
      .delete("/servers/")
      .set("Content-Type", "application/json")
      .set("Accept", "application/json")
      .send(deleteData)
      .expect((result) => {
        expect(result.body.message).toMatch(/successfully/);
      })
      .expect(200);
  });
  it("Request the information of the second server, now no longer owned by us.", () => {
    return request
      .get("/servers/2")
      .expect("Content-Type", /json/)
      .expect(200)
      .expect((result) => {
        expect(result.body.rcon_password).toEqual(undefined);
      });
  });
  it("Should reveal the RCON password of a server we don't own to a super admin.", () => {
    return request
      .get("/servers/2/rcon")
      .expect("Content-Type", /json/)
      .expect(200);
  });
  it("Should keep a plain admin away from RCON passwords and server management.", async () => {
    await setSuperAdmin(false);
    try {
      const refused = "Only super admins can manage game servers.";
      let res = await request.get("/servers/2/rcon").expect(403);
      expect(res.body.message).toBe(refused);
      res = await request
        .put("/servers/")
        .set("Content-Type", "application/json")
        .send([{ display_name: "Temp Server #2 EDITED BAD ACT0R", user_id: 1, server_id: 2 }])
        .expect(403);
      expect(res.body.message).toBe(refused);
      res = await request
        .post("/servers/")
        .set("Content-Type", "application/json")
        .send([{ ip_string: "10.0.0.8", port: 27015, rcon_password: "x", display_name: "Nope" }])
        .expect(403);
      expect(res.body.message).toBe(refused);
      await request.delete("/servers/").set("Content-Type", "application/json").send([{ server_id: 2 }]).expect(403);
    } finally {
      await setSuperAdmin(true);
    }
  });
  it("Should reject an unknown practice action.", () => {
    return request
      .post("/servers/2/practice")
      .set("Content-Type", "application/json")
      .send([{ action: "restart" }])
      .expect(412);
  });
  it("Should not start practice mode on a missing server.", () => {
    return request
      .post("/servers/999/practice")
      .set("Content-Type", "application/json")
      .send([{ action: "start" }])
      .expect(404);
  });
  it("Should refuse a join password that would break the connect link.", () => {
    return request
      .post("/servers/")
      .set("Content-Type", "application/json")
      .send([{ ip_string: "10.0.0.9", port: 27015, rcon_password: "x", display_name: "Bad", join_password: "pass word;quit" }])
      .expect(412);
  });
  it("Should report health with a working database.", () => {
    return request.get("/health").expect(200).expect((result) => expect(result.body).toMatchObject({ status: "ok", db: true }));
  });
  it("Should record when a server last answered.", async () => {
    await checkServer(2);
    const rows = await db.query("SELECT last_seen, last_checked FROM game_server WHERE id = 2");
    expect(rows[0].last_checked).toBeTruthy();
    expect(rows[0].last_seen).toBeTruthy();
  });
});