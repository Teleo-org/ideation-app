import posthog from 'posthog-js';

const EVENT_PROPERTIES = {
  idea_created: ['group_count'],
  idea_create_attempted: ['group_count'],
  implementation_created: ['idea_count', 'theme_count', 'group_count'],
  implementation_create_attempted: ['idea_count', 'theme_count', 'group_count'],
  conflict_created: ['member_count', 'scope', 'is_override', 'conflict_mode'],
  conflict_create_attempted: ['member_count', 'scope', 'is_override', 'conflict_mode'],
  requirements_created: ['requirement_count', 'source'],
  requirements_create_attempted: ['requirement_count', 'source'],
  saved_view_created: ['view_kind', 'locked_implementation_count'],
  saved_view_create_attempted: ['view_kind', 'locked_implementation_count'],
  decision_lock_updated: ['action', 'locked_implementation_count', 'rejected_implementation_count'],
  decision_lock_update_attempted: ['action', 'locked_implementation_count', 'rejected_implementation_count'],
  project_created: ['storage_mode'],
  project_create_attempted: ['storage_mode'],
  project_shared: ['share_mode', 'has_expiry'],
  project_share_attempted: ['share_mode', 'has_expiry'],
  project_exported: ['export_format'],
  project_export_attempted: ['export_format'],
  project_imported: ['import_format', 'attachment_count'],
  project_import_attempted: ['import_format', 'attachment_count'],
  attachment_uploaded: ['storage_mode', 'mime_type', 'size_bucket'],
  attachment_upload_attempted: ['storage_mode', 'mime_type', 'size_bucket'],
};
const REQUIRED_PROPERTIES = new Set(['token', 'distinct_id', '$device_id', '$session_id', '$window_id', '$insert_id', '$time', '$lib', '$lib_version', '$process_person_profile']);

function safeProperties(event, properties = {}) {
  const permitted = EVENT_PROPERTIES[event];
  if (!permitted) return null;
  return Object.fromEntries(permitted.filter((key) => properties[key] !== undefined).map((key) => [key, properties[key]]));
}

export function initializePostHog(config) {
  if (config?.selfHosted || !config?.posthogProjectToken || !config?.posthogHost) return null;
  posthog.init(config.posthogProjectToken, {
    api_host: config.posthogHost,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    disable_surveys: true,
    opt_out_capturing_by_default: true,
    before_send(event) {
      if (event.event === '$identify') return event;
      const properties = safeProperties(event.event, event.properties);
      if (!properties) return null;
      const required = Object.fromEntries(Object.entries(event.properties || {}).filter(([key]) => REQUIRED_PROPERTIES.has(key)));
      return { ...event, properties: { ...required, ...properties } };
    },
  });
  posthog.opt_in_capturing();
  return {
    capture(event, properties) {
      const safe = safeProperties(event, properties);
      if (safe) posthog.capture(event, safe);
    },
    identify(userId) { if (userId) posthog.identify(userId); },
    reset() { posthog.reset(); posthog.opt_out_capturing(); },
  };
}

export { EVENT_PROPERTIES, safeProperties };
