"use strict";
const express = require("express"),
  cors = require("cors"),
  bcrypt = require("bcryptjs"),
  jwt = require("jsonwebtoken"),
  crypto = require("node:crypto");
function createApp({
  store,
  secret,
  commit = "unknown",
  registrationKey = "",
  origins = [],
}) {
  if (typeof secret !== "string" || secret.length < 32)
    throw Error("JWT_SECRET deve ter ao menos 32 caracteres.");
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.set("trust proxy", 1);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
    }),
  );
  app.use(express.json({ limit: "4mb", strict: true }));
  const startedAt = new Date().toISOString();
  app.get("/version.json", (_, res) =>
    res.json({
      app: "minha-carteira-api",
      version: "2.0.0",
      commit,
      commit_short: commit.slice(0, 7),
      server_started_at: startedAt,
    }),
  );
  app.get("/health", async (_, res) => {
    try {
      await store.health();
      res.json({ status: "ok", app: "minha-carteira-api", version: "2.0.0" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  const hits = new Map();
  const limiter = (req, res, next) => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.until < now) hits.delete(k);
    const key = req.ip;
    let hit = hits.get(key);
    if (!hit) {
      hit = { count: 0, until: now + 15 * 60e3 };
      hits.set(key, hit);
    }
    if (++hit.count > 30)
      return res
        .status(429)
        .json({
          error: "rate_limited",
          message: "Aguarde alguns minutos para tentar novamente.",
        });
    next();
  };
  const safeUser = (u) => ({ id: u.id, email: u.email, name: u.name });
  const session = (u) => ({
    token: jwt.sign({}, secret, {
      subject: u.id,
      expiresIn: "7d",
      issuer: "minha-carteira-api",
      audience: "minha-carteira",
    }),
    user: safeUser(u),
  });
  const credentials = (b) =>
    b &&
    typeof b.email === "string" &&
    b.email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) &&
    typeof b.password === "string" &&
    b.password.length >= 12 &&
    Buffer.byteLength(b.password) <= 72;
  app.post("/api/v1/auth/register", limiter, async (req, res, next) => {
    try {
      const b = req.body;
      if (
        !credentials(b) ||
        typeof b.name !== "string" ||
        !b.name.trim() ||
        b.name.length > 100
      )
        return res
          .status(400)
          .json({
            error: "invalid_credentials",
            message: "Informe nome, e-mail válido e senha de 12 a 72 bytes.",
          });
      if (
        registrationKey &&
        !crypto.timingSafeEqual(
          crypto
            .createHash("sha256")
            .update(String(b.registrationKey || ""))
            .digest(),
          crypto.createHash("sha256").update(registrationKey).digest(),
        )
      )
        return res
          .status(403)
          .json({
            error: "registration_closed",
            message: "Informe a chave de cadastro do servidor.",
          });
      const u = await store.createUser(
        b.email.trim().toLowerCase(),
        b.name.trim(),
        await bcrypt.hash(b.password, 12),
      );
      res.status(201).json(session(u));
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY")
        return res
          .status(409)
          .json({
            error: "email_unavailable",
            message: "Não foi possível cadastrar este e-mail.",
          });
      next(e);
    }
  });
  app.post("/api/v1/auth/login", limiter, async (req, res, next) => {
    try {
      const b = req.body;
      if (!credentials(b))
        return res
          .status(401)
          .json({
            error: "invalid_credentials",
            message: "E-mail ou senha inválidos.",
          });
      const u = await store.findUser(b.email.trim().toLowerCase());
      const valid = await bcrypt.compare(
        b.password,
        u
          ? u.password_hash
          : "$2b$12$C6UzMDM.H6dfI/f/IKcEe.5T9tJP7FYQ5kLfZsJrD5KcJQ1kBF8kK",
      );
      if (!u || !valid)
        return res
          .status(401)
          .json({
            error: "invalid_credentials",
            message: "E-mail ou senha inválidos.",
          });
      res.json(session(u));
    } catch (e) {
      next(e);
    }
  });
  const auth = (req, res, next) => {
    try {
      const header = req.headers.authorization || "";
      if (!header.startsWith("Bearer ")) throw Error();
      const t = jwt.verify(header.slice(7), secret, {
        algorithms: ["HS256"],
        issuer: "minha-carteira-api",
        audience: "minha-carteira",
      });
      if (typeof t.sub !== "string") throw Error();
      req.userId = t.sub;
      next();
    } catch {
      res
        .status(401)
        .json({
          error: "unauthorized",
          message: "Entre novamente na sua conta.",
        });
    }
  };
  app.get("/api/v1/ledger", auth, async (req, res, next) => {
    try {
      res.json(await store.read(req.userId));
    } catch (e) {
      next(e);
    }
  });
  app.put("/api/v1/ledger", auth, async (req, res, next) => {
    try {
      const b = req.body;
      if (
        !b ||
        !Number.isSafeInteger(b.baseRevision) ||
        b.baseRevision < 0 ||
        typeof b.requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          b.requestId,
        ) ||
        !validState(b.state)
      )
        return res
          .status(400)
          .json({
            error: "invalid_snapshot",
            message: "Os dados enviados são inválidos.",
          });
      const hash = crypto
        .createHash("sha256")
        .update(
          JSON.stringify({ baseRevision: b.baseRevision, state: b.state }),
        )
        .digest("hex");
      const result = await store.write(req.userId, b, hash);
      res.status(result.status).json(result.body);
    } catch (e) {
      next(e);
    }
  });
  app.use((req, res) => res.status(404).json({ error: "not_found" }));
  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large")
      return res.status(413).json({ error: "snapshot_too_large" });
    if (err instanceof SyntaxError && err.status === 400)
      return res.status(400).json({ error: "invalid_json" });
    console.error("request_failed", err.code || err.name);
    res
      .status(500)
      .json({
        error: "server_error",
        message: "Não foi possível concluir a solicitação.",
      });
  });
  return app;
}
function validState(s) {
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!object(s)) return false;
  for (const key of ["accounts", "expenses", "invoices", "receipts"]) {
    if (!Array.isArray(s[key]) || s[key].length > 50000) return false;
    const ids = new Set();
    for (const r of s[key]) {
      if (
        !object(r) ||
        typeof r.id !== "string" ||
        !r.id ||
        r.id.length > 200 ||
        ids.has(r.id)
      )
        return false;
      ids.add(r.id);
    }
  }
  if (s.income !== null && !object(s.income)) return false;
  if (
    !object(s.budgets) ||
    Object.values(s.budgets).some(
      (n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100,
    )
  )
    return false;
  for (const key of ["incomePlans", "statementCredits", "statementImports"])
    if (s[key] !== undefined && !Array.isArray(s[key])) return false;
  const money = new Set([
    "amount",
    "balance",
    "opening",
    "limit",
    "gross",
    "net",
    "reserve",
    "tax",
    "baseAmount",
    "estimatedAmount",
    "actual",
  ]);
  const dates = new Set(["due", "date", "paidAt", "receivedAt", "closedAt"]);
  function check(v, depth = 0) {
    if (depth > 30) return false;
    if (v === null) return true;
    if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) <= 1e12;
    if (typeof v === "string") return v.length <= 100000;
    if (typeof v === "boolean") return true;
    if (Array.isArray(v))
      return v.length <= 50000 && v.every((x) => check(x, depth + 1));
    if (!object(v)) return false;
    for (const [k, x] of Object.entries(v)) {
      if (["__proto__", "constructor", "prototype"].includes(k)) return false;
      if (
        money.has(k) &&
        x !== null &&
        (typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > 1e12)
      )
        return false;
      if (
        dates.has(k) &&
        x !== null &&
        (typeof x !== "string" ||
          !/^\d{4}-\d{2}-\d{2}/.test(x) ||
          Number.isNaN(Date.parse(x)))
      )
        return false;
      if (!check(x, depth + 1)) return false;
    }
    return true;
  }
  return check(s);
}
module.exports = { createApp, validState };
