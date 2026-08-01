# Production provisioning inputs

This file records the values and account configuration needed before the Cloudflare/Clerk migration is deployed. Keep real secrets only in ignored local files, Cloudflare Worker secrets, or the GitHub `production` environment.

## 1. Local placeholders

Copy the tracked templates without committing the copies:

```powershell
Copy-Item .env.example .env
Copy-Item .dev.vars.example .dev.vars
Copy-Item .cloudflare.env.example .cloudflare.env
```

Fill `.dev.vars` with **development** Clerk values. Fill `.cloudflare.env` only when provisioning Cloudflare resources locally. The committed examples must remain placeholders.

## 2. Clerk: create a dedicated Ideation application

Create separate Clerk Development and Production instances for this app. In the Production instance:

- configure `https://ideation.teleoflexuous.com` as the application origin and redirect URL;
- enable self-service sign-up and Clerk invitations;
- create a webhook endpoint after the Worker is live, then provide its signing secret;
- supply the production publishable key, secret key, and webhook signing secret.

The application will allocate the first 20 webhook-confirmed, self-service users a permanent cloud workspace. Invited users bypass that allocation. User data is not shared between accounts.

## 3. Cloudflare

Provide a scoped API token and account ID. The token must allow only this account/zone to:

- create and edit Workers;
- create and edit the Ideation D1 database;
- create and edit the private Ideation R2 bucket (**Workers R2 Storage Read/Write must be scoped to the entire Cloudflare account; R2 buckets are not zone resources**);
- edit DNS/custom-domain records for `ideation.teleoflexuous.com` and read the zone.

The deployment creates the Worker, D1 database, and R2 bucket. Cloudflare-managed custom-domain TLS is used for `ideation.teleoflexuous.com`.

## 4. GitHub Actions production environment

In the canonical `Teleo-org/ideation-app` repository, create a `production` environment and add these secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | CI deployment token scoped to this application |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account hosting the Worker |
| `CLERK_PUBLISHABLE_KEY` | Browser authentication configuration supplied to the Worker |
| `CLERK_SECRET_KEY` | Worker-side production Clerk authentication |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Verifies Clerk provisioning webhooks |

Set these as production Worker configuration during deployment:

| Value | Classification |
| --- | --- |
| `CLERK_PUBLISHABLE_KEY` | Public runtime configuration |
| `APP_ORIGIN=https://ideation.teleoflexuous.com` | Public runtime configuration |

The workflow will be added with the Worker implementation. It will validate pull requests and deploy successful `main` pushes directly to production.

## Optional PostHog analytics

Analytics is off until each browser opts in. Add these bindings directly to the production Worker in **Settings → Variables and Secrets**; they persist across the existing deploy workflow:

| Name | Value | Classification |
| --- | --- | --- |
| `POSTHOG_PROJECT_TOKEN` | `phc_...` project token | Plain Worker text variable; the browser receives it and it is not an administrative API secret. |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | Plain Worker variable. Use the EU host only for an EU-region PostHog project. |

For `wrangler dev`, add the same values to the ignored `.dev.vars` file. Do not use a PostHog personal API key. In PostHog, disable autocapture, heatmaps, session replay, error tracking, and IP capture unless separately required; the browser client enforces the same automatic-capture restrictions.

## 5. Values to provide before deployment

- Cloudflare account ID and scoped API token.
- Clerk production publishable key, secret key, and webhook signing secret (the latter may follow Worker deployment if the endpoint does not yet exist).
- Confirmation that the GitHub repository is `Teleo-org/ideation-app` and that GitHub Actions can use the production environment above.
