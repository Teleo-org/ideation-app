# Ideation Workbench

Ideation Workbench is a private, portable planning board hosted at `https://ideation.teleoflexuous.com`.

- **Guest mode:** runs in the browser without sign-up or server-side storage.
- **Cloud mode:** Clerk-authenticated users receive an isolated D1-backed workspace and R2-backed attachments.
- **Portability:** projects export as readable `ideation-project.json` directories or ZIP archives suitable for source control. Markdown import/export remains available for sharing prose.

The first 20 self-service Clerk registrations receive cloud storage permanently. Clerk invitations bypass that cap. Guest projects are never uploaded until a signed-in user chooses to import them.

## Development

```powershell
npm ci
npm run check
npm run dev
```

`npm run dev` builds browser assets and starts the Cloudflare Worker locally. Copy `.dev.vars.example` to `.dev.vars` and add development Clerk values before testing authenticated paths.

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
| Deploy target | Cloudflare Worker with D1 and R2 |
