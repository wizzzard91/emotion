# TODO

Where the project is heading, distilled from the product spec (a free-form brief). Tracked by hand: change the marker when a task moves.

| Marker | Meaning |
| --- | --- |
| `[x]` | done |
| `[~]` | in progress |
| `[ ]` | ready: scoped well enough to start |
| `[?]` | needs a decision or research first |

The spec's proposed tech stack (section 5.1) is deliberately not followed: the stack in use today stays (see [README.md](README.md)). Everything else in the spec is a goal.

## Principles

- Free and open source; no limit on the number of users, only a per-user disk quota set by an administrator.
- One-command deployment, with update and backup also one command each.
- Modular: an administrator enables the modules they need, users never see a disabled one.
- Everything in one window: single sign-on, shared navigation, global search, cross-links (a file attached to a task, a task created from an email).
- Do not reinvent the wheel: embed mature open-source components where possible.
- Data stays on the organisation's server; no mandatory calls to external services.
- Light enough for low-powered machines.

## Core

- [x] Login and password sessions, scrypt hashes, login rate limiting
- [x] Two roles (administrator, member); first administrator seeded from the environment; no self-registration
- [x] Team page: add and remove members, reset passwords; users change their own password
- [x] Basic server-rendered web UI in Russian, works without JS
- [x] Deployment: Docker image, compose setup, health check; running on a remote host
- [ ] Owner role above administrator (appoints administrators, backups, deletes the workspace)
- [ ] Block a user (without deleting)
- [ ] Groups and departments, so rights are granted to groups rather than individuals
- [ ] Module switches: enable and disable modules for the whole workspace
- [ ] Organisation settings: name, logo, domain
- [ ] Bulk invitation by email and CSV import
- [ ] Guest role: access only to what was shared by link, no account or light registration
- [ ] Two-factor authentication, with an option for administrators to make it mandatory
- [ ] Activity log: who created, deleted, or shared what
- [ ] Interface in Russian and English, with room to add more languages
- [ ] Responsive layout for phones
- [ ] Global search across modules
- [ ] Notification mechanism shared by all modules (in-app, later email)
- [?] One organisation per installation, or several workspaces on one server

## Disk

- [x] Folders, upload, download, rename, delete
- [x] Drag-and-drop upload with progress
- [x] Private folders (visible to the owner only, administrators included)
- [x] Shared team disk
- [ ] Personal disk for each user, alongside the shared one
- [ ] Moving files and folders between folders
- [ ] Preview of PDFs, images, and office files
- [ ] Trash (restore deleted items)
- [ ] File version history
- [ ] Disk quotas: default and per user, plus a separate one for the shared disk
- [ ] Permissions on a file or folder for users and groups: view, comment, edit
- [ ] Guest links: view or edit, optional password and expiry, revocable, long random token
- [ ] Administrator view of active guest links
- [?] Collaborative document editing in the browser (embed ONLYOFFICE Docs or Collabora Online); check the free editions' connection limits against "no limits"

## Mail

- [?] Decide how to run it: embed an existing open-source mail server rather than write one
- [ ] Personal mailbox per user on the organisation's domain, created and archived or removed together with the user
- [ ] Web client: inbox, send, attachments, folders, search
- [ ] Attach a file straight from the disk
- [ ] IMAP/SMTP access for phone and desktop clients
- [ ] Platform notifications delivered to the same mailbox
- [ ] Shared mailboxes (info@, hr@) with group access
- [?] Deliverability: many hosts block outgoing port 25, so decide whether an external SMTP relay is the default

## Task board

- [ ] Kanban boards, columns, cards, drag-and-drop
- [ ] Card: title, description, assignees, due date, labels, checklist, comments, attachments from the disk
- [ ] Team and personal boards with board-level permissions
- [ ] Notify the assignee in the platform and by email
- [ ] "My tasks" summary across all boards
- [ ] Templates for non-profits: volunteer boards, folder structure, typical roles

## Administration and operations

- [ ] Delete a user with a choice for their files and mail: hand over to a colleague or archive
- [ ] Scheduled backups and restore, one command each
- [ ] One-command installer: checks the server, installs Docker if missing, asks for domain, admin email and modules, generates secrets, issues HTTPS certificates, prints the DNS records for mail (MX, SPF, DKIM, DMARC)
- [ ] One-command update without data loss
- [?] Measure memory requirements (the document editor and video calls are the heaviest parts)

## Roadmap after the MVP

Phase 2: communication
- [ ] Video calls (Jitsi Meet on the same server), rooms inside the platform, guest link for outsiders
- [ ] Messenger: channels, direct messages, threads, mentions, files from the disk; consider embedding Matrix or Mattermost
- [ ] Calendar: personal and shared, invitations by email, call link in an event

Phase 3: text AI agent (free)
- [ ] Chat tab; the agent's tools are the modules' APIs (create a task, assign, create an event, find a file, draft a letter)
- [ ] The agent acts with the rights of the person it talks to and asks for confirmation with an action card
- [ ] Model supplied by the administrator: an external provider key or a local model

Phase 4: voice agent in calls (paid)
- [ ] Bot joins a call, recognises speech, calls the same tools, asks for missing details by voice, posts the created tasks and a short summary afterwards

## Open questions

- [?] Product name (a working name is not chosen)
- [?] Licence: AGPL protects against closed forks, MIT spreads more easily; affects monetisation
- [?] Who pays for the language model in the free text agent: the organisation's API key, a local model, or a limit from us
- [?] Whether the calendar belongs in the MVP or phase 2 (the agent needs it to create events)

## Monetisation and spread (context, not tasks)

Core, all modules, and the text agent are free. Money comes from the voice agent (subscription), custom work, and possibly turnkey hosting and priority support. For spread: guest links show a small "made with" footer linking to the installation guide, and the repository is public with a one-command install.
