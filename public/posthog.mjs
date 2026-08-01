import posthog from 'posthog-js';

const isProduction = typeof location !== 'undefined' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';

async function initializePostHog() {
  const response = await fetch('/api/config');
  const config = await response.json();
  const token = config.posthogProjectToken;
  const host = config.posthogHost;
  const missingVariable = !token ? 'POSTHOG_PROJECT_TOKEN' : !host ? 'POSTHOG_HOST' : null;
  if (missingVariable) {
    if (!isProduction) throw new Error(`${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`);
    return null;
  }
  posthog.init(token, { api_host: host });
  posthog.startExceptionAutocapture({
    capture_unhandled_errors: true,
    capture_unhandled_rejections: true,
  });
  return posthog;
}

export const posthogReady = initializePostHog();
