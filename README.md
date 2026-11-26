# Flash Client

Open-source Minecraft launcher, content API and store.

- `launcher/` — Electron launcher (multi-instance, background running, Rust Edition support).
- `backend/` — content API + store API (Fastify/Node).

No API keys, tokens, webhooks or runtime data are included in this repository.
Copy `backend/.env.example` to `.env` and fill in your own values before running the backend.

## Launcher

```bash
cd launcher
npm install
npm run build:css      # required after changing any Tailwind class
npm start              # development
npm run release        # NSIS installer -> github-release/ + update.json
```

The release script reads `src/update-feed.json` for `owner/repo`; tag the GitHub
release `v<version>` and attach both the installer and `update.json`.

## Backend

```bash
cd backend
npm install
cp .env.example .env   # then set ADMIN_TOKEN and your own providers
npm start
```

The storefront origin must be listed in `CORS_ORIGINS` (comma-separated) or the
browser will reject every API response. Supabase credentials are required in
production; without them the service starts with an empty local JSON catalog.

## About antivirus warnings

This is an **unsigned** Electron application. Windows Defender and other scanners
routinely flag unsigned NSIS installers and Electron binaries that spawn Java, open
network sockets or install to Program Files. False-positive rates are high for new
or newly rebuilt installers.

What you can do:
1. Build from this source yourself and compare the SHA-256 with the published release.
2. Submit the installer to VirusTotal / Microsoft Defender submission portal.
3. Sign the installer with an OV/EV code-signing certificate; this removes most warnings.

Never paste real secrets into issues, screenshots or pull requests. Rotate any key
that has ever been committed, even if it was removed in a later commit.
