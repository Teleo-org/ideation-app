import { rm, mkdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const source = new URL('../public/', import.meta.url);
const output = new URL('../build/', import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true, filter: (path) => !path.endsWith('app.js') });
await build({
  entryPoints: [fileURLToPath(new URL('../public/app.js', import.meta.url))],
  outfile: fileURLToPath(new URL('app.mjs', output)),
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  sourcemap: true,
  minify: false,
});
