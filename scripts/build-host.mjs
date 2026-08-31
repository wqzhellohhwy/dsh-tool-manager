/**
 * Build the host half via esbuild's JS API.
 * Avoids CLI-compat issues across esbuild versions (0.21 vs 0.28 arg formats).
 *
 * Usage: ESBUILD_PKG=<path-to-esbuild-package> node scripts/build-host.mjs
 */
import { pathToFileURL } from 'node:url'

const pkgDir = process.env.ESBUILD_PKG
if (!pkgDir) {
  console.error('build-host.mjs: ESBUILD_PKG env required')
  process.exit(1)
}

const { build } = await import(pathToFileURL(pkgDir + '/lib/main.js').href)

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  // Bundled CJS dependencies would call require() at runtime; in ESM scope
  // require does not exist, so provide a real one via createRequire.
  banner: {
    js: "import { createRequire as __dshCreateRequire } from 'node:module';\nconst require = __dshCreateRequire(import.meta.url);",
  },
})

console.log('[build-host] lib/index.js written')