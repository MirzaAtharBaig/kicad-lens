import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [here('src/extension.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: here('dist/extension.js'),
  sourcemap: true,
  minify: process.argv.includes('--minify'),
  // Bundle core from source so no separate build step is needed.
  alias: { '@kicad-lens/core': here('../core/src/index.ts') },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
