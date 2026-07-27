import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODE, THEME_MODES, modeGlyph, modeLabel, nextMode, normalizeMode, resolveThemeMode } from '../public/theme-mode.mjs';

test('THEME_MODES is the ordered cycle and default is auto', () => {
  assert.deepEqual(THEME_MODES, ['auto', 'light', 'dark']);
  assert.equal(DEFAULT_MODE, 'auto');
});

test('normalizeMode accepts known values and falls back to auto for anything else', () => {
  for (const value of THEME_MODES) assert.equal(normalizeMode(value), value);
  assert.equal(normalizeMode(undefined), 'auto');
  assert.equal(normalizeMode(null), 'auto');
  assert.equal(normalizeMode('Auto'), 'auto');
  assert.equal(normalizeMode(''), 'auto');
  assert.equal(normalizeMode('system'), 'auto');
});

test('resolveThemeMode honours explicit choices regardless of system', () => {
  assert.equal(resolveThemeMode('light', true), 'light');
  assert.equal(resolveThemeMode('dark', false), 'dark');
});

test('resolveThemeMode follows the system when set to auto', () => {
  assert.equal(resolveThemeMode('auto', true), 'dark');
  assert.equal(resolveThemeMode('auto', false), 'light');
  assert.equal(resolveThemeMode('auto', true), 'dark');
});

test('resolveThemeMode treats invalid preferences as auto', () => {
  assert.equal(resolveThemeMode('garbage', false), 'light');
  assert.equal(resolveThemeMode('garbage', true), 'dark');
});

test('nextMode cycles auto -> light -> dark -> auto and ignores invalid input', () => {
  assert.equal(nextMode('auto'), 'light');
  assert.equal(nextMode('light'), 'dark');
  assert.equal(nextMode('dark'), 'auto');
  assert.equal(nextMode('unknown'), 'light');
});

test('modeLabel returns the human-readable name for each mode', () => {
  assert.equal(modeLabel('auto'), 'Auto');
  assert.equal(modeLabel('light'), 'Light');
  assert.equal(modeLabel('dark'), 'Dark');
  assert.equal(modeLabel('bogus'), 'Auto');
});

test('modeGlyph returns a distinct glyph per mode', () => {
  const glyphs = new Set([modeGlyph('auto'), modeGlyph('light'), modeGlyph('dark')]);
  assert.equal(glyphs.size, 3);
  assert.equal(modeGlyph('auto'), modeGlyph('invalid'));
});
