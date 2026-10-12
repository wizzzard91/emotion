# Emotion

A simple self-hosted substitute for Notion, built for small teams and low-powered machines.
So far it does one thing: a shared team disk with folders, file upload and download, and private folders.

Stack: Node.js (≥ 24, TypeScript runs directly with no build step), Express + EJS, MongoDB, S3-compatible file storage (Alarik, MinIO), pnpm.

## Getting started

```bash
pnpm install
cp .env.example .env   # fill in MONGODB_URI, S3_*, ADMIN_*
pnpm dev               # http://localhost:3000
```

You need a running MongoDB and an S3 server with the bucket already created.

## Users

There are two roles, administrator and member, and no self-registration.

- The first administrator is created on startup from `ADMIN_LOGIN` / `ADMIN_PASSWORD` if no user with that login exists yet. After that the password is changed in the UI and the variables can be removed.
- Everyone else is added by an administrator on the Team page, which is also where forgotten passwords are reset and members are removed.
- Each user changes their own password (the link is their name in the header).

A private folder is visible to its owner only; administrators cannot see it either.

## Configuration

All settings are environment variables, see [.env.example](.env.example).
In production, put the service behind a reverse proxy with HTTPS and set `COOKIE_SECURE=true`.

## Development

```bash
pnpm test        # unit tests (Jest), no external services needed
pnpm typecheck   # type checking
```

Data-layer tests against a real MongoDB (they create and drop a temporary database):

```bash
MONGODB_TEST_URI=mongodb://localhost:27017 pnpm jest src/server/db
```
