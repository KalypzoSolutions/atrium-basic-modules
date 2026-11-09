import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modulesDir } from '$testing';
import { resetAreas, resetUsers } from '$modules/events/reset';

/** `tests/unit/module-reset-areas.test.ts` kennt nur members/actions/treasury – hier dasselbe für events. */
const dir = join(modulesDir(), 'events', 'migrations');
const sqlText = readdirSync(dir)
	.filter((f) => f.endsWith('.sql'))
	.map((f) => readFileSync(join(dir, f), 'utf8'))
	.join('\n');

function tables(): Set<string> {
	const out = new Set<string>();
	for (const m of sqlText.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
		out.add(m[1]!.toLowerCase());
	}
	return out;
}

function foreignKeys(): { child: string; parent: string }[] {
	const out: { child: string; parent: string }[] = [];
	const re = /(CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+([a-z_]+)|REFERENCES\s+([a-z_]+)/gi;
	let current = '';
	for (const m of sqlText.matchAll(re)) {
		if (m[2]) current = m[2].toLowerCase();
		else if (m[3] && current) out.push({ child: current, parent: m[3].toLowerCase() });
	}
	return out;
}

describe('Reset-Bereiche events', () => {
	it('hat genau den Bereich all mit Neuaufbau', () => {
		expect(resetAreas.map((a) => a.id)).toEqual(['all']);
		const all = resetAreas[0]!;
		expect(all.rebuild).toBe(true);
		expect(all.label).toBe('Alle Termine');
		expect(all.description.length).toBeGreaterThan(20);
		expect(all.implies ?? []).toEqual([]);
	});

	it('deckt alle Tabellen der Migrationen ab, ohne Duplikate', () => {
		const all = resetAreas[0]!;
		expect(new Set(all.tables).size).toBe(all.tables.length);
		expect(new Set(all.tables)).toEqual(tables());
	});

	it('löscht abhängige Tabellen vor ihren Eltern', () => {
		const fks = foreignKeys();
		expect(fks.length).toBeGreaterThanOrEqual(3);
		const order = resetAreas[0]!.tables;
		for (const fk of fks) {
			expect(order.indexOf(fk.child), `${fk.child} -> ${fk.parent}`).toBeLessThan(
				order.indexOf(fk.parent)
			);
		}
	});

	it('bietet resetUsers an', () => {
		expect(typeof resetUsers).toBe('function');
	});
});
