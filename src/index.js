"use strict";
require("dotenv").config();
const { MysqlStore } = require("./store");
const { createApp } = require("./app");
const { execFileSync } = require("node:child_process");
async function main() {
  for (const key of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"])
    if (!process.env[key])
      throw Error(`Configuração obrigatória ausente: ${key}`);
  let commit = process.env.APP_COMMIT || "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {}
  const store = new MysqlStore({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306),
    connectTimeout: 10000,
    ssl:
      process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });
  await store.migrate();
  const app = createApp({
    store,
    secret: process.env.JWT_SECRET || (await store.secret("jwt_secret")),
    commit,
    registrationKey: process.env.REGISTRATION_KEY || "",
    origins: (process.env.CORS_ORIGINS || "").split(",").filter(Boolean),
  });
  const server = app.listen(Number(process.env.PORT || 5555), "0.0.0.0", () =>
    console.log("Minha Carteira API ready", commit),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      server.close(async () => {
        await store.pool.end();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    });
}
main().catch((e) => {
  console.error("startup_failed", e.code || e.message);
  process.exit(1);
});
