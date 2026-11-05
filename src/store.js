"use strict";
const crypto = require("node:crypto");
const mysql = require("mysql2/promise");
const migration = require("node:fs").readFileSync(
  require("node:path").join(__dirname, "../migrations/001.sql"),
  "utf8",
);
class MysqlStore {
  constructor(config) {
    this.pool = mysql.createPool({
      ...config,
      connectionLimit: 5,
      multipleStatements: false,
      charset: "utf8mb4",
    });
  }
  async migrate() {
    for (const sql of migration
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await this.pool.query(sql);
  }
  async secret(key) {
    await this.pool.execute(
      "INSERT IGNORE INTO wallet_settings(setting_key,setting_value) VALUES(?,?)",
      [key, crypto.randomBytes(48).toString("base64url")],
    );
    const [rows] = await this.pool.execute(
      "SELECT setting_value FROM wallet_settings WHERE setting_key=?",
      [key],
    );
    return rows[0].setting_value;
  }
  async health() {
    await this.pool.query("SELECT 1");
  }
  async findUser(email) {
    const [r] = await this.pool.execute(
      "SELECT * FROM wallet_users WHERE email=?",
      [email],
    );
    return r[0];
  }
  async findUserById(id) {
    const [rows] = await this.pool.execute(
      "SELECT id,email,name FROM wallet_users WHERE id=?",
      [id],
    );
    return rows[0];
  }
  async createUser(email, name, passwordHash) {
    const id = crypto.randomUUID();
    await this.pool.execute(
      "INSERT INTO wallet_users(id,email,name,password_hash) VALUES(?,?,?,?)",
      [id, email, name, passwordHash],
    );
    return { id, email, name };
  }
  async read(userId) {
    const [r] = await this.pool.execute(
      "SELECT revision,state,updated_at FROM wallet_ledgers WHERE user_id=?",
      [userId],
    );
    return r.length
      ? {
          revision: Number(r[0].revision),
          state:
            typeof r[0].state === "string"
              ? JSON.parse(r[0].state)
              : r[0].state,
          updatedAt: r[0].updated_at,
        }
      : { revision: 0, state: null, updatedAt: null };
  }
  async write(userId, { baseRevision, requestId, state }, hash) {
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      await c.execute(
        "INSERT IGNORE INTO wallet_ledgers(user_id,revision,state) VALUES(?,0,NULL)",
        [userId],
      );
      const [rows] = await c.execute(
        "SELECT revision,state,updated_at FROM wallet_ledgers WHERE user_id=? FOR UPDATE",
        [userId],
      );
      const [requests] = await c.execute(
        "SELECT payload_hash,response FROM wallet_sync_requests WHERE user_id=? AND request_id=?",
        [userId, requestId],
      );
      if (requests.length) {
        await c.commit();
        return requests[0].payload_hash === hash
          ? {
              status: 200,
              body:
                typeof requests[0].response === "string"
                  ? JSON.parse(requests[0].response)
                  : requests[0].response,
            }
          : {
              status: 409,
              body: {
                error: "idempotency_conflict",
                message: "Esta solicitação já foi usada com outros dados.",
              },
            };
      }
      const row = rows[0];
      if (Number(row.revision) !== baseRevision) {
        await c.rollback();
        return {
          status: 409,
          body: {
            error: "revision_conflict",
            message: "Os dados foram atualizados em outro dispositivo.",
            revision: Number(row.revision),
            state:
              typeof row.state === "string" ? JSON.parse(row.state) : row.state,
            updatedAt: row.updated_at,
          },
        };
      }
      const revision = baseRevision + 1,
        updatedAt = new Date().toISOString(),
        body = { revision, updatedAt };
      await c.execute(
        "UPDATE wallet_ledgers SET revision=?,state=?,updated_at=? WHERE user_id=?",
        [revision, JSON.stringify(state), new Date(updatedAt), userId],
      );
      await c.execute(
        "INSERT INTO wallet_sync_requests(user_id,request_id,payload_hash,response) VALUES(?,?,?,?)",
        [userId, requestId, hash, JSON.stringify(body)],
      );
      await c.commit();
      return { status: 200, body };
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }
}
module.exports = { MysqlStore };
