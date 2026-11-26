// Führt einen Befehl im Core (`.core`) mit den Modulen dieses Repos aus: `bun scripts/core.mjs <befehl> [args…]`
//
// Beispiele (siehe package.json): check · test · build · e2e · demo · lint · format
// Der Core findet die Module über ATRIUM_MODULES_DIR (absoluter Pfad auf ./modules).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, '.core');
const MODULES = join(ROOT, 'modules').replace(/\\/g, '/');

if (!existsSync(join(CORE, 'node_modules'))) {
	console.error('Core nicht eingerichtet – zuerst `bun run setup`.');
	process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
// Läuft unter Bun: `process.execPath` ist die Bun-Binärdatei (Werkzeuge über `bun run`, nicht `bunx`)
const bun = process.execPath;
/** Pfade im Aufruf (z. B. eine Testdatei) ersetzen das ganze Modulverzeichnis */
const hasPath = rest.some((a) => !a.startsWith('-'));

/** Schritte je Befehl: [Programm, Argumente, im Repo statt im Core] */
/** @type {Record<string, [string, string[], boolean?][]>} */
const COMMANDS = {
	check: [[bun, ['run', 'check']]],
	// nur die Tests der Module (Core-Tests laufen im Core-Repo)
	test: [[bun, ['scripts/test.mjs', ...rest, ...(hasPath ? [] : [MODULES])]]],
	build: [[bun, ['run', 'build']]],
	// Biome (Format + Lint, eigene biome.json dieses Repos) und Modulgrenzen (Prüfer des Core)
	lint: [
		[bun, ['run', 'biome', 'check', ...(rest.length ? rest : ['.'])], true],
		[bun, ['.core/tools/module-boundaries.ts'], true]
	],
	format: [[bun, ['run', 'biome', 'check', '--write', ...(rest.length ? rest : ['.'])], true]],
	e2e: [
		[
			bun,
			['run', 'playwright', 'test', '--project', 'modules', '--project', 'integration', ...rest]
		]
	],
	demo: [[bun, ['scripts/demo-server.mjs', ...rest]]]
};

const steps = COMMANDS[cmd ?? ''];
if (!steps) {
	console.error(`Unbekannter Befehl „${cmd ?? ''}“. Möglich: ${Object.keys(COMMANDS).join(', ')}`);
	process.exit(2);
}
for (const [bin, args, inRepo] of steps) {
	const r = spawnSync(bin, args, {
		cwd: inRepo ? ROOT : CORE,
		stdio: 'inherit',
		env: { ...process.env, ATRIUM_MODULES_DIR: MODULES }
	});
	if (r.status !== 0) process.exit(r.status ?? 1);
}
