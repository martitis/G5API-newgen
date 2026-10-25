/* Passport stuff
This is not required to be modified. 
All this does is check if the user exists in the database and
if they don't will add them with basic user access.
*/
import config from "config";
import { Strategy as SteamStrategy } from "passport-steam";
import passport from 'passport';
import { Strategy as LocalStrategy } from "passport-local";
import { hashSync, compare } from "bcrypt";
import MockStrategy from "./mockstrategy.js";
import {db} from "../services/db.js";
import { RowDataPacket } from "mysql2";
import { generate } from "randomstring";
import Utils from "./utils.js";
import User from "steamapi/dist/src/structures/User.js";

import logger from "./logger.js";
import { passwordProblem, usernameProblem } from "./credentials.js";
import { configRoleLists, loadUser } from "./access.js";

// The session stores only the user id; the user (roles included) is read from the database on every request,
// so a role changed by a super admin, or a deleted account, applies at once.
passport.serializeUser((user: Express.User, done) => {
  done(null, { id: (user as { id: number }).id });
});

passport.deserializeUser((obj: { id?: unknown }, done) => {
  loadUser(obj?.id).then(
    (user) => done(null, (user as unknown as Express.User) ?? false),
    (err) => done(err)
  );
});

/** The mock Steam login (any visitor becomes the test user) needs NODE_ENV=test and G5API_MOCK_AUTH=1 (set by the
 * jest configs), so a server started with NODE_ENV=test by mistake still uses real Steam logins. */
const mockAuth: boolean = process.env.NODE_ENV === "test" && process.env.G5API_MOCK_AUTH === "1";

function strategyForEnvironment() {
  if (mockAuth) {
    //@ts-ignore
    return new MockStrategy({ name: "steam", passAuthentication: true }, returnStrategy);
  }
  return new SteamStrategy(
    {
      returnURL: Utils.apiUrl("/auth/steam/return"),
      realm: Utils.apiUrl("/"),
      apiKey: config.get("server.steamAPIKey"),
    },
    returnStrategy
  );
}

async function returnStrategy(identifier: any, profile: any, done: any) {
  process.nextTick(async () => {
    profile.identifier = identifier;
    try {
      let defaultMaps = [];
      let isAdmin = 0;
      let isSuperAdmin = 0;
      // Read from the config file at each login, so editing the lists needs no API restart.
      const { superAdmins: superAdminList, admins: adminList } = configRoleLists();
      let sql = "SELECT * FROM user WHERE steam_id = ?";
      // If we are an admin, check!
      if (superAdminList.indexOf(profile.id!.toString()) >= 0) {
        isSuperAdmin = 1;
      } else if (adminList.indexOf(profile.id!.toString()) >= 0) {
        isAdmin = 1;
      }
      let curUser = await db.query(sql, profile.id);
      if (curUser.length < 1) {
        //Generate API key in user session to allow posting/getting/etc with
        //an account that's not in a session.
        let apiKey = generate({
          length: 64,
          capitalization: "uppercase",
        });
        sql = "INSERT INTO user SET ?";
        let newUser = {
          steam_id: profile.id,
          name: profile.displayName,
          admin: isAdmin,
          super_admin: isSuperAdmin,
          roles_from_config: isAdmin || isSuperAdmin ? 1 : 0,
          created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
          small_image: profile.photos[0].value,
          medium_image: profile.photos[1].value,
          large_image: profile.photos[2].value,
          api_key: Utils.encrypt(apiKey),
          steam_verified: 1,
        };
        curUser = await db.query(sql, [newUser]);
        sql = "SELECT * FROM user WHERE steam_id = ?";
        curUser = await db.query(sql, [profile.id]);
        defaultMaps.push(['de_inferno', 'Inferno', curUser[0].id]);
        defaultMaps.push(['de_ancient', 'Ancient', curUser[0].id]);
        defaultMaps.push(['de_mirage', 'Mirage', curUser[0].id]);
        defaultMaps.push(['de_nuke', 'Nuke', curUser[0].id]);
        defaultMaps.push(['de_anubis', 'Anubis', curUser[0].id]);
        defaultMaps.push(['de_dust2', 'Dust II', curUser[0].id]);
        defaultMaps.push(['de_vertigo', 'Vertigo', curUser[0].id]);
        sql = "INSERT INTO map_list (map_name, map_display_name, user_id) VALUES ?";
        await db.query(sql, [defaultMaps]);
      } else {
        let updateUser: { [key: string]: any } = {
          small_image: profile.photos[0].value,
          medium_image: profile.photos[1].value,
          large_image: profile.photos[2].value,
          steam_verified: 1
        };
        // The config lists always grant their role. Leaving a list removes the role only when it came
        // from the list; roles a super admin set in the panel (roles_from_config = 0) are kept.
        if (isSuperAdmin || isAdmin) {
          Object.assign(updateUser, { super_admin: isSuperAdmin, admin: isAdmin, roles_from_config: 1 });
        } else if (curUser[0].roles_from_config) {
          Object.assign(updateUser, { super_admin: 0, admin: 0, roles_from_config: 0 });
        }
        if (!curUser[0].steam_verified) {
          // Someone registered locally with this Steam ID before its owner ever logged in.
          // The real owner takes the account over; the local credentials are dropped.
          logger.warn(`Steam login verified user ${curUser[0].id}; clearing unverified local credentials.`);
          updateUser.username = null;
          updateUser.password = null;
        }
        sql = "UPDATE user SET ? WHERE steam_id=?";
        await db.query(sql, [updateUser, profile.id]);
        // Insert default maps.
        sql = "SELECT * FROM map_list WHERE user_id = ?";
        let checkMaps = await db.query(sql, [curUser[0].id]);
        if (checkMaps.length < 1) {
          let defaultMaps = [];
          defaultMaps.push(['de_inferno', 'Inferno', curUser[0].id]);
          defaultMaps.push(['de_ancient', 'Ancient', curUser[0].id]);
          defaultMaps.push(['de_mirage', 'Mirage', curUser[0].id]);
          defaultMaps.push(['de_nuke', 'Nuke', curUser[0].id]);
          defaultMaps.push(['de_anubis', 'Anubis', curUser[0].id]);
          defaultMaps.push(['de_dust2', 'Dust II', curUser[0].id]);
          defaultMaps.push(['de_vertigo', 'Vertigo', curUser[0].id]);
          sql = "INSERT INTO map_list (map_name, map_display_name, user_id) VALUES ?";
          await db.query(sql, [defaultMaps]);
        }
      }
      // The user as stored now (roles from the config list, or set in the panel).
      return done(null, await loadUser(curUser[0].id));
    } catch (err) {
      logger.error({ err, steam_id: profile?.id }, "Steam login failed");
      return done(null, null);
    }
  });
}

passport.use(strategyForEnvironment());

// Local Strategies
/** A loaded user in the shape passport expects (false when the account is gone). */
const asSessionUser = (user: Awaited<ReturnType<typeof loadUser>>) => (user ?? false) as unknown as Express.User | false;

const LOCAL_DISABLED = "Username and password logins are turned off on this panel. Sign in with Steam instead.";

passport.use('local-login', new LocalStrategy(async (username, password, done) => {
  try {
    if (!config.get("server.localLoginEnabled")) return done(null, false, { message: LOCAL_DISABLED });
    const rows: RowDataPacket[] = await db.query("SELECT * FROM user WHERE username = ?", [username.trim()]);
    // Same message for an unknown user and a wrong password, so usernames can't be probed.
    if (!rows.length || !rows[0].password || !(await compare(password, rows[0].password))) {
      return done(null, false, { message: "Wrong username or password." });
    }
    return done(null, asSessionUser(await loadUser(rows[0].id)));
  } catch (err) {
    return done(err);
  }
}));

passport.use('local-register',
  new LocalStrategy({ passReqToCallback: true }, (async (req, rawUsername, password, done) => {
    try {
      if (!config.get("server.localLoginEnabled")) return done(null, false, { message: LOCAL_DISABLED });
      const username = rawUsername.trim();
      const problem = usernameProblem(username) ?? passwordProblem(password);
      if (problem) return done(null, false, { message: problem });
      // Optional: a SteamID64, a profile link or a custom profile name (looked up on Steam). Without one the
      // account has no Steam ID (stats aren't linked to it until one is added).
      const steamInput = String(req.body.steam_id ?? "").trim();
      const steamId: string | null = steamInput ? await Utils.getSteamPID(steamInput) : null;
      if (steamInput && !steamId) {
        return done(null, false, { message: "Enter your SteamID64 or Steam profile link (steamcommunity.com/...), or leave it empty." });
      }
      if ((await db.query("SELECT id FROM user WHERE username = ?", [username])).length) {
        return done(null, false, { message: "That username is taken." });
      }
      if (steamId && (await db.query("SELECT id FROM user WHERE steam_id = ?", [steamId])).length) {
        return done(null, false, {
          message:
            "This Steam account already has a panel account. Sign in with Steam, then add a username and password on your profile page."
        });
      }
      // A local registration doesn't prove ownership of the Steam ID, so it never gets
      // admin rights from the config lists; those apply after a real Steam login.
      const apiKey = generate({ length: 64, capitalization: "uppercase" });
      const insert: any = await db.query("INSERT INTO user SET ?", [
        await db.buildUpdateStatement({
          steam_id: steamId,
          name: (steamId && (await Utils.getSteamName(steamId))) || username,
          admin: 0,
          super_admin: 0,
          steam_verified: 0,
          created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
          api_key: Utils.encrypt(apiKey),
          username,
          password: hashSync(password, 10)
        })
      ]);
      const userId: number = insert.insertId;
      const defaultMaps = [
        ["de_inferno", "Inferno"],
        ["de_ancient", "Ancient"],
        ["de_mirage", "Mirage"],
        ["de_nuke", "Nuke"],
        ["de_anubis", "Anubis"],
        ["de_dust2", "Dust II"],
        ["de_vertigo", "Vertigo"]
      ].map(([map, display]) => [map, display, userId]);
      await db.query("INSERT INTO map_list (map_name, map_display_name, user_id) VALUES ?", [defaultMaps]);
      return done(null, asSessionUser(await loadUser(userId)));
    } catch (err) {
      return done(err);
    }
  })));

export default passport;
