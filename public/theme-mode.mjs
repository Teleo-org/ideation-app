export const THEME_MODES = ['auto', 'light', 'dark'];
export const DEFAULT_MODE = 'auto';
const VALID = new Set(THEME_MODES);

export function normalizeMode(value) {
  return VALID.has(value) ? value : DEFAULT_MODE;
}

export function resolveThemeMode(preference, systemPrefersDark) {
  const mode = normalizeMode(preference);
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return systemPrefersDark ? 'dark' : 'light';
}

export function nextMode(current) {
  const mode = normalizeMode(current);
  const index = THEME_MODES.indexOf(mode);
  return THEME_MODES[(index + 1) % THEME_MODES.length];
}

export function modeLabel(mode) {
  const resolved = normalizeMode(mode);
  if (resolved === 'auto') return 'Auto';
  if (resolved === 'light') return 'Light';
  return 'Dark';
}

export function modeGlyph(mode) {
  const resolved = normalizeMode(mode);
  if (resolved === 'auto') return '◐';
  if (resolved === 'light') return '☀';
  return '☾';
}
