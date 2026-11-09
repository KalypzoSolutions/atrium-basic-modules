// Prüft den Katalog `modules/atrium-modules.json`: jedes Modul mit `atrium-module.json` steht darin (und umgekehrt),
// Pfade stimmen, IDs sind eindeutig, harte Abhängigkeiten liegen im Repo oder haben einen `source`-Link.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULES = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'modules');
const catalog = JSON.parse(readFileSync(join(MODULES, 'atrium-modules.json'), 'utf8'));
const problems = [];
const inCatalog = new Map();
for (const e of catalog.modules ?? []) {
	if (inCatalog.has(e.id)) problems.push(`doppelt im Katalog: ${e.id}`);
	inCatalog.set(e.id, e.path);
}
const onDisk = readdirSync(MODULES, { withFileTypes: true })
	.filter((d) => d.isDirectory() && existsSync(join(MODULES, d.name, 'atrium-module.json')))
	.map((d) => d.name);
for (const id of onDisk) if (!inCatalog.has(id)) problems.push(`fehlt im Katalog: ${id}`);
for (const [id, path] of inCatalog) {
	const file = join(MODULES, path, 'atrium-module.json');
	if (!existsSync(file)) {
		problems.push(`Katalogpfad ohne Modul: ${id} → ${path}`);
		continue;
	}
	const pkg = JSON.parse(readFileSync(file, 'utf8'));
	if (pkg.id !== id) problems.push(`ID ${pkg.id} ≠ Katalogeintrag ${id}`);
	for (const [dep, spec] of Object.entries(pkg.dependencies ?? {})) {
		if (!inCatalog.has(dep) && !spec.source)
			problems.push(`${id}: Abhängigkeit ${dep} weder im Repo noch mit source-Link`);
	}
}
if (problems.length) {
	console.error(problems.map((p) => `✗ ${p}`).join('\n'));
	process.exit(1);
}
console.log(`Katalog in Ordnung (${inCatalog.size} Module).`);
