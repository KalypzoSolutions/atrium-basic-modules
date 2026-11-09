import { describe, expect, it } from 'vitest';
import { isDarkSurface, luminance, surfaceStyle, surfaceVars } from '$modules/notes/pages/surface';
import { DEFAULT_USER_PREFS } from '$modules/notes/schemas';

describe('notes: persönlicher Hintergrund', () => {
	it('Leuchtdichte und hell/dunkel', () => {
		expect(luminance('#ffffff')).toBeCloseTo(1);
		expect(luminance('#000000')).toBeCloseTo(0);
		expect(isDarkSurface('#111827')).toBe(true);
		expect(isDarkSurface('#fbf6ea')).toBe(false);
		// ungültig → als hell behandeln
		expect(isDarkSurface('red')).toBe(false);
	});

	it('Theme-Modus setzt nichts', () => {
		expect(surfaceVars(DEFAULT_USER_PREFS)).toBeNull();
		expect(surfaceStyle(null)).toBe('');
	});

	it('feste helle Farbe → dunkle Schrift', () => {
		const vars = surfaceVars({ surface: { mode: 'fixed', color: '#FFFFFF' } })!;
		expect(vars['--background']).toBe('#ffffff');
		expect(vars['--foreground']).toBe('#111827');
		expect(vars['color-scheme']).toBe('light');
	});

	it('feste dunkle Farbe → helle Schrift, Töne Richtung Weiß', () => {
		const vars = surfaceVars({ surface: { mode: 'fixed', color: '#111827' } })!;
		expect(vars['--foreground']).toBe('#f3f4f6');
		expect(vars['--border']).toContain('white');
		expect(surfaceStyle({ surface: { mode: 'fixed', color: '#111827' } })).toContain(
			'background-color: var(--background)'
		);
	});

	it('ungültige Farbe im Speicher wird ignoriert', () => {
		expect(surfaceVars({ surface: { mode: 'fixed', color: 'url(x)' } })).toBeNull();
	});
});
