# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

A simple self-hosted substitute for Notion, aimed at low-powered machines and smaller teams. The first (and so far only) feature is a shared team disk. The UI is in Russian; code, comments and test names are in English.

## Commands

- `pnpm dev` — run with `node --watch` on http://localhost:3000 (reads `.env`; needs MongoDB and an S3 bucket)
- `pnpm test` — Jest unit tests, no external services (`pnpm jest src/server/drive` for one area, `pnpm jest -t "name"` for one test)
- `MONGODB_TEST_URI=... pnpm jest src/server/db` — also runs the store contract against a real MongoDB (throwaway database)
- `pnpm typecheck` — `tsc --noEmit`
- `docker compose up -d --build` — production-like run from `Dockerfile` + `compose.yaml` (app only; MongoDB and S3 are external)

There is no build step: Node runs the `.ts` sources directly via type stripping. That imposes rules:

- only erasable TypeScript syntax (no enums, parameter properties, namespaces);
- relative imports carry the `.ts` extension; type imports use `import type`;
- no `import.meta` / `__dirname` — Jest transpiles to CommonJS via swc; filesystem locations come from `src/server/paths.ts`.

## Layout

- `src/server/` — the Node backend.
- `src/web/` — what the browser gets: `views/` (EJS templates rendered by the server) and `public/` (CSS and JS served at `/static`).

## Architecture

`src/server/main.ts` builds the dependencies (`config`, `stores`, `storage`) and passes them to `createApp` in `app.ts`, which wires global middleware (security headers, same-origin CSRF check, user loading, error page) and mounts the feature routers. Features receive `AppDeps`; nothing reads globals.

- `db/` — persistence. `types.ts` defines the store interfaces (`UserStore`, `SessionStore`, `NodeStore`); `mongo.ts` implements them on MongoDB and creates indexes; `memory.ts` is the in-memory twin used by unit tests. `contract.ts` is one test suite run against both — extend it whenever a store method is added, so the two cannot drift. Stores do plain data access and never check permissions. Ids are 24-hex strings.
- `auth/` — scrypt password hashes, cookie sessions (only a hash of the token is stored; MongoDB expires them via a TTL index), login rate limiting, team administration. Two roles, administrator and member; no self-registration. `bootstrap.ts` seeds the first administrator from `ADMIN_*`.
- `storage/` — the `Storage` interface (`types.ts`) and its S3 implementation. Everything streams; never buffer file bodies.
- `drive/` — the tree of folders and files. Each node stores its `ancestors` (nodes are never moved). Access control lives in `nodes.ts` (`hides` / `findAccessible` / `visibleChildren`): a private folder hides itself and everything below it from everyone but its owner, administrators included, and hidden nodes must behave as nonexistent (404). Route every new operation through these functions.
- `src/web` pages work without JS; `drive.js` only enhances. CSP is `default-src 'self'`: no inline scripts, styles or handlers.

Feature routers define their own error classes and render the shared `error` view themselves, to avoid importing from `app.ts` (circular).

## Design constraint worth preserving

The project's stated purpose is to run well on low-powered machines, so prefer built-ins and lightweight dependencies and avoid heavy runtime or bundle costs.
