# Ideation Workbench

Ideation Workbench is a private, portable planning board hosted at `https://ideation.teleoflexuous.com`.

- **Guest mode:** runs in the browser without sign-up or server-side storage.
- **Cloud mode:** Clerk-authenticated users receive an isolated D1-backed workspace and R2-backed attachments.
- **Portability:** V2 project archives contain a validated project document, attachment files, and SHA-256 checksums. V1 project documents remain importable.
- **Self-hosting:** the same client and API contracts run on NixOS with SQLite, filesystem attachments, and OIDC or trusted-proxy identity.

The first 20 self-service Clerk registrations receive cloud storage permanently. Clerk invitations bypass that cap. Guest projects are never uploaded until a signed-in user chooses to import them.

## Development

```powershell
npm ci
npm run check
npm run dev
```

`npm run dev` builds browser assets and starts the Cloudflare Worker locally. Copy `.dev.vars.example` to `.dev.vars` and add development Clerk values before testing authenticated paths.

`npm run dev:nixos` runs the provider-neutral Node adapter. It accepts identity
only from configured trusted proxy addresses. See
[docs/NIXOS.md](docs/NIXOS.md) for the NixOS module and OIDC proxy setup.

## Deployment

Pushes to `main` deploy to production after CI succeeds. Pull requests run installation, tests, and build only.

Provisioning, required secrets, Cloudflare permissions, and Clerk setup are documented in [docs/PROVISIONING.md](docs/PROVISIONING.md). Never commit `.env`, `.dev.vars`, `.cloudflare.env`, or real provider credentials.

## Commands and target

| Purpose | Command |
| --- | --- |
| Install | `npm ci` |
| Test | `npm test` |
| Build | `npm run build` |
| Validate | `npm run check` |
| Local Worker | `npm run dev` |
| Local NixOS adapter | `npm run dev:nixos` |
| Back up NixOS data | `npm run backup:nixos -- /path/to/backup` |
| Restore NixOS data | `npm run restore:nixos -- /path/to/backup` |
| Convert legacy folder | `npm run migrate:legacy -- project.sqlite project.zip` |
| Deploy targets | Cloudflare Worker/D1/R2 or NixOS/SQLite/filesystem |
