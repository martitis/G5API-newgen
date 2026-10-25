// Must be first: patches Express before any router is created.
import "./src/utility/asyncErrors.js";
import config from "config";
import RedisStore from "connect-redis";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import bearerToken from "express-bearer-token";
import rateLimit from "express-rate-limit";
import session from "express-session";
import helmet from "helmet";
import createError from "http-errors";
import morgan from "morgan";
import { pinoHttp } from "pino-http";
import { createClient } from "redis";
import swaggerJSDoc from "swagger-jsdoc";

import { serve, setup } from "swagger-ui-express";

// Route Files
import indexRouter from "./src/routes/index.js";
import leaderboardRouter from "./src/routes/leaderboard.js";
import mapListRouter from "./src/routes/maps.js";
import mapstatsRouter from "./src/routes/mapstats.js";
import metricsRouter from "./src/routes/metrics.js";
import adminRouter from "./src/routes/admin.js";
import tournamentsRouter from "./src/routes/tournaments.js";
import pugsRouter from "./src/routes/pugs.js";
import searchRouter from "./src/routes/search.js";
import templatesRouter from "./src/routes/templates.js";
import scheduledRouter from "./src/routes/scheduled.js";
import { startScheduleSweep } from "./src/services/scheduler.js";
import { startPugSweep } from "./src/services/pugs.js";
import { startHeartbeatSweep, startServerSweep } from "./src/services/heartbeat.js";
import matchesRouter from "./src/routes/matches/matches.js";
import matchServerRouter from "./src/routes/matches/matchserver.js";
import playerstatsRouter from "./src/routes/playerstats/playerstats.js";
import playerstatsextraRouter from "./src/routes/playerstats/extrastats.js";
import seasonsRouter from "./src/routes/seasons.js";
import serversRouter from "./src/routes/servers.js";
import teamsRouter from "./src/routes/teams.js";
import usersRouter from "./src/routes/users.js";
import vetoesRouter from "./src/routes/vetoes.js";
import vetosidesRouter from "./src/routes/vetosides.js";
import passport from "./src/utility/auth.js";
import Utils from "./src/utility/utils.js";
import logger from "./src/utility/logger.js";
import { resolveUser, writeGuard } from "./src/utility/access.js";
import { db } from "./src/services/db.js";
import {router as v2Router} from "./src/routes/v2/api.js";
import {router as v2DemoRouter} from "./src/routes/v2/demoapi.js";
import { router as v2BackupRouter } from "./src/routes/v2/backupapi.js";
// End Route Files



const app = express();

// Behind nginx/Caddy: needed for correct client IPs (rate limits) and secure cookies.
app.set("trust proxy", 1);

// Security headers first, so they also cover static files (logos, demos, backups).
// Cross-origin resource policy stays open so the panel (often on another origin) can show logos.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// HTTP request log: readable lines while developing, JSON (pino) otherwise; none during tests.
if (app.get("env") === "development") app.use(morgan("dev"));
else if (app.get("env") !== "test") app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));

/**
 * @swagger
 *
 * /health:
 *   get:
 *     description: Liveness and database check for load balancers and uptime monitors. No session, no auth.
 *     tags:
 *       - health
 *     responses:
 *       200:
 *         description: "{ status: 'ok', db: true, uptime_s }"
 *       503:
 *         description: "{ status: 'error', db: false } - the database doesn't answer"
 */
app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ status: "ok", db: true, uptime_s: Math.round(process.uptime()) });
  } catch (err) {
    logger.error({ err }, "Health check: database unreachable");
    res.status(503).json({ status: "error", db: false });
  }
});
// Raw bodies are only accepted on the upload routes; demos are large, round backups are small JSON files.
app.use("/v2/demo", express.raw({ type: "application/octet-stream", limit: "2gb" }));
app.use("/v2/backup", express.raw({ type: "application/octet-stream", limit: "20mb" }));
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use("/demo", express.static("public/demos"));
// Round backups are fetched by the game server (matchzy_loadbackup_url) with the match API key.
app.use("/backups/:match_id", async (req, res, next) => {
  try {
    const keyCheck = await Utils.checkApiKey(req.get("Authorization") ?? "", req.params.match_id);
    if (keyCheck !== 0) {
      res.status(401).json({ message: "Invalid API key has been given." });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
});
app.use("/backups", express.static("public/backups"));
app.use("/static/img/logos", express.static("public/img/logos"));
app.use("/resource/flash/econ/tournaments/teams", express.static("public/img/logos"));
app.use("/materials/panorama/images/tournaments/teams", express.static("public/img/logos"));


// secure: "auto" marks the cookie Secure whenever the request came over HTTPS (via trust proxy).
const sessionCookie: session.CookieOptions = {
  maxAge: 86400000,
  httpOnly: true,
  sameSite: "lax",
  secure: "auto"
};

let sessionType: any;
if (config.get("server.useRedis")) {
  const redisClient = createClient({
    url: config.get("server.redisUrl"),
  });
  
  await redisClient.connect();
  redisClient.on("error", (err) => {
    console.log("Redis error: ", err);
  });

  const redisCfg = {
    client: redisClient,
  };
  sessionType = session({
    secret: config.get("server.sharedSecret"),
    name: "G5API",
    resave: false,
    saveUninitialized: true,
    store: new RedisStore(redisCfg),
    cookie: sessionCookie,
  });
  process.on("exit", function () {
    void redisClient.quit();
  });
} else {
  sessionType = session({
    secret: config.get("server.sharedSecret"),
    name: "G5API",
    resave: false,
    saveUninitialized: true,
    cookie: sessionCookie,
  });
}

app.use(sessionType);

app.use(passport.initialize() as any);
app.use(passport.session());
app.use(bearerToken());

// enabling CORS for all requests
app.use(
  cors({
    origin: config.get("server.clientHome"), // allow to server to accept request
    // from different origin
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    credentials: true, // allow session cookie from browser to pass through
  })
);

// API-key requests get their user here; then every write needs an admin unless it's on the short allowlist.
app.use(resolveUser);
app.use(writeGuard);

// Server-sent event streams: a comment line every 25s keeps idle connections open through nginx/Caddy and
// browsers. SSE clients ignore comment lines.
app.use((req, res, next) => {
  if (req.method === "GET" && req.path.endsWith("/stream")) {
    const heartbeat = setInterval(() => {
      if (res.headersSent && !res.writableEnded) res.write(": keep-alive\n\n");
    }, 25000);
    res.on("close", () => clearInterval(heartbeat));
  }
  next();
});

// swagger UI

const options = {
  definition: {
    openapi: "3.0.0", // Specification (optional, defaults to swagger: '2.0')
    info: {
      title: "G5API", // Title (required)
      version: "3.0.0" // Version (required)
    }
  },
  // Path to the API docs
  apis: [
    "./dist/src/routes/**/*.js",
    "./dist/src/services/**/*.js",
    "./dist/src/routes/*.js",
    "./dist/app.js"
  ]
};
const swaggerSpec = swaggerJSDoc(options);

app.use("/api-docs", serve as any, setup(swaggerSpec) as any);

// END API SETUP

// Begin Routes
app.use("/", indexRouter);
app.use("/users", usersRouter);
app.use("/teams", teamsRouter);
app.use("/servers", serversRouter);
app.use("/vetoes", vetoesRouter);
app.use("/vetosides", vetosidesRouter);
app.use("/matches", matchesRouter, matchServerRouter);
app.use("/mapstats", mapstatsRouter);
app.use("/playerstats", playerstatsRouter);
app.use("/playerstatsextra", playerstatsextraRouter);
app.use("/seasons", seasonsRouter);
app.use("/leaderboard", leaderboardRouter);
app.use("/maps", mapListRouter);
app.use("/metrics", metricsRouter);
app.use("/admin", adminRouter);
app.use("/tournaments", tournamentsRouter);
app.use("/pugs", pugsRouter);
app.use("/search", searchRouter);
app.use("/templates", templatesRouter);
app.use("/scheduled", scheduledRouter);
// Times out PUG ready checks and expires old queues (tests drive queues themselves).
if (process.env.NODE_ENV !== "test") {
  startPugSweep();
  // Creates scheduled matches when they are due.
  startScheduleSweep();
  // Polls the game server of every live match (offline / restarted servers, missed events).
  startHeartbeatSweep();
  // Probes every game server every 10 s (last seen on the servers page; the match checks reuse the answer).
  startServerSweep();
}
app.use("/v2", v2Router);
app.use("/v2/demo", v2DemoRouter);
app.use("/v2/backup", v2BackupRouter);
// END ROUTES

// Steam API Calls.
app.get(
  "/auth/steam",
  passport.authenticate("steam", { failureRedirect: "/" }),
  (req, res) => {
    res.redirect("/");
  }
);

app.get(
  "/auth/steam/return",
  (req, res, next) => {
    req.url = req.originalUrl;
    next();
  },
  passport.authenticate("steam", { failureRedirect: "/" }),
  (req, res) => {
    if (process.env.NODE_ENV == "test") {
      res.redirect("/");
    } else {
      res.redirect(config.get("server.clientHome"));
    }
  }
);
// POST only, so other sites can't log users out with a link or image.
app.post('/logout', function(req, res, next) {
  req.logout(function(err) {
    if (err) { return next(err); }
    res.json({ message: "Logged out." });
  });
});
// END Steam API Calls.

// Local Passport Calls
// Brute-force protection: 10 attempts per IP per 15 minutes.
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  // The test suites sign in and register far more than 10 times from one address.
  limit: process.env.NODE_ENV === "test" ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts, please try again later." }
});

// Express only treats 4-argument middleware as an error handler, so next must stay.
const localAuthFailure = (err: any, req: any, res: any, next: any) => {
  // A real error (database down, ...) goes to the global handler; a refused login answers with its reason.
  if (err?.name !== "AuthenticationError") return next(err);
  const messages: string[] = req.session?.messages ?? [];
  if (req.session) req.session.messages = [];
  return res.status(401).json({ message: messages[messages.length - 1] ?? "Authentication failed." });
};

app.post(
  "/login",
  authRateLimit,
  passport.authenticate("local-login", {
    failWithError: true,
    failureMessage: true,
  }),
  (req: any, res: any) => {
    return res.json({ message: "Success!" });
  },
  localAuthFailure
);

app.post(
  "/register",
  authRateLimit,
  passport.authenticate("local-register", {
    failWithError: true,
    failureMessage: true,
  }),
  (req: any, res: any) => {
    return res.json({ message: "Success!" });
  },
  localAuthFailure
);

// END Local Passport Calls

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler: details go to the log, clients only get a generic message for server errors.
app.use(function (err: any, req: any, res: any, next: any) {
  const status: number = err.status || err.statusCode || 500;
  if (status >= 500) logger.error({ err, method: req.method, url: req.originalUrl }, "Request failed");
  if (res.headersSent) return next(err);
  res.status(status);
  res.json({
    message: status >= 500 ? "Internal server error." : err.message,
    ...(req.app.get("env") === "development" && status >= 500 ? { error: String(err) } : {})
  });
});

// Log instead of crashing the process on a stray async error.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});

export default app;
