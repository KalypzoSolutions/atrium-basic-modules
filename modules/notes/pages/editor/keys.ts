/** Anzeige der Modifikatortaste in Tooltips (Mac: ⌘, sonst Strg) */
export const MOD =
	typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Strg';
