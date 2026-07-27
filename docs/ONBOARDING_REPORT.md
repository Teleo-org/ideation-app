# Teleo onboarding report

- **Repository:** `Teleo-org/ideation-app`
- **Cloudflare Worker:** Yes — `ideation-workbench`
- **Production target:** `https://ideation.teleoflexuous.com`
- **Install:** `npm ci`
- **Test:** `npm test` (48 passing tests at initial deployment)
- **Build:** `npm run build`
- **Deployment:** GitHub Actions validates pull requests and deploys `main` to production.
- **Wrangler:** `wrangler.jsonc` is present; D1 migration `0001_initial.sql` has been applied and the private R2 bucket is bound.

## Required configuration

- Public: `APP_ORIGIN`, `CLERK_PUBLISHABLE_KEY`
- Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`

## Provider readiness

- **Clerk:** Dedicated production instance, Google sign-in, production domain, and webhook are configured. The Worker verifies Clerk session tokens and Svix webhook signatures. The first 20 self-service webhook-provisioned users receive cloud storage; Clerk invitations bypass the cap.
- **Sentry:** Not configured; no application-specific DSN or source-map credentials have been requested.
- **Stripe:** Not configured; payments are outside this application’s scope.

## Remaining operational checks

Run one real sign-up/sign-in to confirm Clerk webhook delivery provisions the first cloud workspace, then upload and retrieve one attachment. These checks require a real user session and are intentionally not simulated with credentials.
