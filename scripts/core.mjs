// Führt einen Befehl im Core (`.core`) mit den Modulen dieses Repos aus: `node scripts/core.mjs <befehl> [args…]`
//
// Beispiele (siehe package.json): check · test · build · e2e · demo · lint
// Der Core findet die Module über ATRIUM_MODULES_DIR (absoluter Pfad auf ./modules).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, '.core');
const MODULES = join(ROOT, 'modules').replace(/\\/g, '/');

if (!existsSync(join(CORE, 'node_modules'))) {
	console.error('Core nicht eingerichtet – zuerst `npm run setup`.');
	process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** @type {Record<string, [string, string[]]>} */
const COMMANDS = {
	check: [npm, ['run', 'check']],
	// nur die Tests der Module (Core-Tests laufen im Core-Repo)
	test: [npx, ['vitest', 'run', MODULES, ...rest]],
	build: [npm, ['run', 'build']],
	// Lint/Format aus der Wurzel dieses Repos (eigene eslint.config.js lädt die des Core, eigene .prettierrc)
	lint: [npx, ['eslint', 'modules', 'scripts', ...rest]],
	format: [npx, ['prettier', '--check', 'modules', 'scripts', ...rest]],
	e2e: [npx, ['playwright', 'test', '--project', 'modules', '--project', 'integration', ...rest]],
	demo: ['node', ['scripts/demo-server.mjs', ...rest]]
};

/** Befehle, die im Module-Repo selbst laufen (nicht in `.core`) */
const IN_REPO = new Set(['lint', 'format']);

const entry = COMMANDS[cmd ?? ''];
if (!entry) {
	console.error(`Unbekannter Befehl „${cmd ?? ''}“. Möglich: ${Object.keys(COMMANDS).join(', ')}`);
	process.exit(2);
}
const [bin, args] = entry;
const r = spawnSync(bin, args, {
	cwd: IN_REPO.has(cmd) ? ROOT : CORE,
	stdio: 'inherit',
	shell: process.platform === 'win32',
	env: { ...process.env, ATRIUM_MODULES_DIR: MODULES }
});
process.exit(r.status ?? 1);
