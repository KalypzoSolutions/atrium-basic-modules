// Einrichtung des Module-Repos (Kalypzo Atrium, Phase 8): `npm run setup`
//
// 1. Core als Git-Submodul `.core` holen (fester Tag, siehe .gitmodules) und dessen Abhängigkeiten installieren
// 2. `node_modules` dieses Repos = Link auf `.core/node_modules` (Junction unter Windows), damit Moduldateien die
//    Pakete des Core finden (Svelte, Zod, bits-ui …)
// 3. modulspezifische npm-Pakete (Feld `npm` der `atrium-module.json`) nach `modules/node_modules` installieren –
//    genau wie der Supervisor beim Neubau im Server
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, '.core');
const MODULES = join(ROOT, 'modules');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd) =>
	execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

if (!existsSync(join(CORE, 'package.json'))) {
	console.log('== Core-Submodul holen');
	run('git', ['submodule', 'update', '--init', '--recursive'], ROOT);
}

const corePkg = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8'));
console.log(`== Core ${corePkg.name}@${corePkg.version}: Abhängigkeiten`);
if (!existsSync(join(CORE, 'node_modules')) || process.argv.includes('--force'))
	run(npm, ['ci'], CORE);

console.log('== node_modules → .core/node_modules');
const link = join(ROOT, 'node_modules');
let stat = null;
try {
	stat = lstatSync(link);
} catch {
	// fehlt noch
}
if (stat && !stat.isSymbolicLink()) {
	console.error('node_modules ist ein echter Ordner – bitte löschen und setup erneut ausführen.');
	process.exit(1);
}
if (stat) rmSync(link, { force: true });
symlinkSync(join(CORE, 'node_modules'), link, 'junction');

console.log('== Pakete der Module');
const known = new Set([
	...Object.keys(corePkg.dependencies ?? {}),
	...Object.keys(corePkg.devDependencies ?? {})
]);
const packages = {};
for (const id of readdirSync(MODULES).sort()) {
	const file = join(MODULES, id, 'atrium-module.json');
	if (!existsSync(file)) continue;
	const pkg = JSON.parse(readFileSync(file, 'utf8'));
	for (const [name, version] of Object.entries(pkg.npm ?? {})) {
		if (known.has(name)) continue;
		if (packages[name] && packages[name] !== version) {
			console.error(`Konflikt: ${name} ${packages[name]} ≠ ${version} (${id})`);
			process.exit(1);
		}
		packages[name] = version;
	}
}
if (Object.keys(packages).length) {
	writeFileSync(
		join(MODULES, 'package.json'),
		JSON.stringify({ private: true, dependencies: packages }, null, '\t') + '\n'
	);
	run(
		npm,
		['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--omit=dev'],
		MODULES
	);
	// gleiche Regel wie der Supervisor im Server: Kopien von Paketen, die der Core schon hat, entfernen
	const { dedupeModulePackages } = await import(
		pathToFileURL(join(CORE, 'scripts', 'supervisor', 'lib.mjs')).href
	);
	const removed = dedupeModulePackages(MODULES, CORE, packages);
	if (removed.length) console.log(`vom Core übernommen: ${removed.join(', ')}`);
} else console.log('keine eigenen Pakete');

console.log('\nFertig. Nächste Schritte: npm run check · npm test · npm run build · npm run demo');
