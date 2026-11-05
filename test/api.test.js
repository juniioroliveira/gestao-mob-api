"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { MysqlStore } = require("../src/store");
const { createApp, validState } = require("../src/app");
const state = {
  accounts: [],
  expenses: [],
  invoices: [],
  receipts: [],
  income: null,
  budgets: {},
};
test("snapshot structure validation", () => {
  assert.equal(validState(state), true);
  assert.equal(validState({ ...state, accounts: [{}] }), false);
  assert.equal(validState({ ...state, income: [] }), false);
});
test(
  "real MySQL authentication, isolated snapshots, concurrency and persistent replay",
  { skip: !process.env.TEST_DB_NAME },
  async (t) => {
    const store = new MysqlStore({
      host: "127.0.0.1",
      port: 13316,
      user: "root",
      database: process.env.TEST_DB_NAME,
    });
    await store.migrate();
    assert.equal(await store.secret("test"), await store.secret("test"));
    const app = createApp({
      store,
      secret: "test-secret-that-is-long-enough-for-jwt",
      commit: "test",
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(async () => {
      await new Promise((r) => server.close(r));
      await store.pool.end();
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, method = "GET", body, token) => {
      const r = await fetch(url + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await request("/api/v1/ledger")).status, 401);
    const a = await request("/api/v1/auth/register", "POST", {
      email: "a@example.com",
      name: "A",
      password: "testpassword123",
    });
    assert.equal(a.status, 201);
    const b = await request("/api/v1/auth/register", "POST", {
      email: "b@example.com",
      name: "B",
      password: "testpassword123",
    });
    assert.equal(b.status, 201);
    assert.equal(
      (
        await request("/api/v1/auth/login", "POST", {
          email: "a@example.com",
          password: "testpassword123",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/v1/auth/login", "POST", {
          email: "a@example.com",
          password: "wrongpassword123",
        })
      ).status,
      401,
    );
    const token = a.body.token;
    const jwt = require("jsonwebtoken");
    const expired = jwt.sign({}, "test-secret-that-is-long-enough-for-jwt", {
      subject: a.body.user.id,
      issuer: "minha-carteira-api",
      audience: "minha-carteira",
      expiresIn: -1,
    });
    assert.equal(
      (await request("/api/v1/ledger", "GET", undefined, expired)).status,
      401,
    );
    assert.equal(
      (await request("/api/v1/ledger", "GET", undefined, token + "x")).status,
      401,
    );

    assert.equal(
      (await request("/api/v1/ledger", "GET", undefined, token)).body.state,
      null,
    );
    const payload = { baseRevision: 0, requestId: crypto.randomUUID(), state };
    const competing = { ...payload, requestId: crypto.randomUUID() };
    const writes = await Promise.all([
      request("/api/v1/ledger", "PUT", payload, token),
      request("/api/v1/ledger", "PUT", competing, token),
    ]);
    assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (await request("/api/v1/ledger", "GET", undefined, b.body.token)).body
        .revision,
      0,
    );
    assert.equal(
      (await request("/api/v1/ledger", "GET", undefined, token)).body.revision,
      1,
    );
    const win = writes[0].status === 200 ? payload : competing;
    {
      assert.equal(
        (await request("/api/v1/ledger", "PUT", win, token)).status,
        200,
      );
      assert.equal(
        (
          await request(
            "/api/v1/ledger",
            "PUT",
            { ...win, state: { ...state, budgets: { Lazer: 10 } } },
            token,
          )
        ).body.error,
        "idempotency_conflict",
      );
    }
    assert.equal(
      (await request("/api/v1/ledger", "PUT", win, b.body.token)).status,
      200,
    );
    const next = {
      baseRevision: 1,
      requestId: crypto.randomUUID(),
      state: { ...state, budgets: { Lazer: 20 } },
    };
    assert.equal(
      (await request("/api/v1/ledger", "PUT", next, token)).status,
      200,
    );
    const reopened = new MysqlStore({
      host: "127.0.0.1",
      port: 13316,
      user: "root",
      database: process.env.TEST_DB_NAME,
    });
    assert.equal(
      (
        await reopened.write(
          a.body.user.id,
          next,
          crypto
            .createHash("sha256")
            .update(
              JSON.stringify({
                baseRevision: next.baseRevision,
                state: next.state,
              }),
            )
            .digest("hex"),
        )
      ).status,
      200,
    );
    assert.equal((await reopened.read(a.body.user.id)).revision, 2);
    await reopened.pool.end();
    assert.equal(
      (
        await request(
          "/api/v1/ledger",
          "PUT",
          { ...next, state: { accounts: [] } },
          token,
        )
      ).status,
      400,
    );
    assert.equal((await request("/api/auth/debug-db")).status, 404);
  },
);
