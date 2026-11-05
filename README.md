# Minha Carteira API

Node 20+, MySQL/MariaDB with InnoDB. `npm ci`, `npm run build`, `npm start`.
The existing Hostinger entry point remains `src/index.js`. Build validates syntax only; publishing requires Git push and verification of `/version.json` against the deployed commit.

Set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME (optional DB_PORT, PORT). Startup only creates wallet_* tables if missing; it never drops or migrates old Gestão Mob tables. JWT_SECRET may be set (32+ characters), otherwise a cryptographically random durable secret is generated in wallet_settings atomically. Back up this table with financial data. Optional REGISTRATION_KEY closes registration to holders of the key. No key means public registration, with per-IP throttling. CORS_ORIGINS is a comma-separated browser allowlist; native clients need none.

## Contract

POST `/api/v1/auth/register` with email, password (12 characters minimum, 72 UTF-8 bytes maximum), name. POST `/api/v1/auth/login` with email and password. Both return token and user {id,email,name}; JWT expires after 7 days. TLS is mandatory at the hosting edge.

GET `/api/v1/auth/me` validates the stored session against an existing user and returns `{user: {id,email,name}}`. Removed users are rejected by all authenticated routes.

Authenticated Bearer routes GET `/api/v1/ledger` returns {revision,state,updatedAt}. A new account has revision 0 and null state. PUT the same route with {baseRevision,requestId UUID,state}. Success returns {revision,updatedAt}. A repeated request ID and identical payload returns the original receipt, even after later updates. Changed payload with same request ID gives 409 idempotency_conflict. A stale baseRevision gives 409 revision_conflict with current snapshot; clients must ask the user before replacing data. No server side merging of financial snapshots occurs.

Snapshots retain the app model including accounts/cards, expenses, invoices, receipts, budgets, income and OFX metadata. The server validates JSON shapes, IDs, numeric ranges and date types. It stores snapshots, not a second accounting calculation engine. Every read and write uses the authenticated user ID; a supplied user ID cannot change ownership. Requests are bounded to 4 MB. Sync receipts retain only revision/timestamp/hash, avoiding a full historical snapshot per write; each receipt is a small permanent idempotency record.

GET `/health` checks database connectivity. GET `/version.json` identifies process commit/version. No legacy API routes are mounted.

## Tests

`npm test` includes validation and an optional actual MySQL integration test. Set TEST_DB_NAME to a new disposable database on localhost:13316 with root/no password. Never point this test at production. Integration covers registration/login, isolation, concurrent revision writes, replay after reconnect, and legacy endpoint removal.

Deployment must confirm `/health`, served commit and an isolated synthetic authenticated round trip. Keep secrets out of Git. The original repository history contains legacy configuration; rotate any still-valid credentials formerly embedded there separately.
