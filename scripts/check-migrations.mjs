// Angewendete Migrationen sind unveränderlich: vergleicht jede `modules/<id>/migrations/*.sql` mit dem Stand am
// letzten Tag (oder `--base <ref>`). Geänderte oder gelöschte Dateien → Fehler; neue Dateien sind erlaubt.
// Zeilenenden werden ignoriert (CRLF/LF), wie die Prüfsumme des Core.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const i = process.argv.indexOf('--base');
let base = i > 0 ? process.argv[i + 1] : '';
if (!base) {
	try {
		base = git('describe', '--tags', '--abbrev=0');
	} catch {
		console.log('Kein Tag vorhanden – nichts zu vergleichen.');
		process.exit(0);
	}
}
const norm = (s) => s.replace(/\r\n?/g, '\n');
const files = git('ls-tree', '-r', '--name-only', base, '--', 'modules')
	.split('\n')
	.filter((f) => /^modules\/[^/]+\/migrations\/[^/]+\.sql$/.test(f));
const problems = [];
for (const f of files) {
	const abs = join(ROOT, f);
	if (!existsSync(abs)) {
		problems.push(`gelöscht: ${f}`);
		continue;
	}
	const before = norm(git('show', `${base}:${f}`));
	if (before.trim() !== norm(readFileSync(abs, 'utf8')).trim()) problems.push(`verändert: ${f}`);
}
if (problems.length) {
	console.error(
		`Angewendete Migrationen seit ${base} verändert:\n${problems.map((p) => `✗ ${p}`).join('\n')}`
	);
	process.exit(1);
}
console.log(`Migrationen unverändert seit ${base} (${files.length} Dateien).`);
