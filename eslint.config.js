// ESLint des Module-Repos = Konfiguration des Core (Modulgrenzen, Core-Interna, Svelte/TS-Regeln),
// Muster relativ zu diesem Ordner. Umgebung zuerst setzen, dann die Core-Konfiguration laden.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
process.env.ATRIUM_ESLINT_ROOT = root;
process.env.ATRIUM_MODULES_DIR ??= join(root, 'modules');

const core = (await import('./.core/eslint.config.js')).default;

export default [
	...core,
	{ ignores: ['.core/', 'modules/node_modules/', '.data/', 'test-results/', 'playwright-report/'] }
];
