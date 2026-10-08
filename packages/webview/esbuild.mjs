import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const outdir = fileURLToPath(new URL('../extension/dist/webview', import.meta.url));

await esbuild.build({
  entryPoints: [fileURLToPath(new URL('src/main.ts', import.meta.url))],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: process.argv.includes('--minify'),
  sourcemap: true,
  outdir,
  entryNames: 'webview',
  alias: { '@kicad-lens/protocol': fileURLToPath(new URL('../core/src/protocol.ts', import.meta.url)) },
  logLevel: 'info',
});
