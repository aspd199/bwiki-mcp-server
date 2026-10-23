/** Bundle the server into one file.
 *
 * The MCP entry point is expected to be a single file the client can point at,
 * and a checkout with node_modules/ is not that. esbuild inlines the whole
 * module graph, including the CommonJS dependencies (mwn, axios), into one ESM
 * file with a node shebang.
 *
 * The package version is injected as a define so the running server reports the
 * version it was built from. Without it the fallback in constants.ts goes stale
 * every release.
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const result = await build({
	entryPoints: ['src/mediawiki/stdio.ts'],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'cjs',
	outfile: 'dist/bundle.cjs',
	// These are resolved at runtime from the machine the server runs on, and
	// bundling them would pin the values into the file.
	external: ['puppeteer-core'],
	define: {
		'process.env.BWIKI_MCP_VERSION': JSON.stringify(version),
	},
	logLevel: 'info',
});

if (result.errors.length > 0) {
	process.exit(1);
}
console.log(`bundled -> dist/bundle.cjs (version ${version})`);
