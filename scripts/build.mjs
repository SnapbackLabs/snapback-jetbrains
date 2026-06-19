// Bundle the integration into a single self-contained ESM file that the
// Snapback registry serves and the desktop runs. Mirrors how the server builds
// first-party integrations, so a bundle made here behaves identically.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node', // keeps node:* builtins external; the desktop provides them
  target: 'node22',
  legalComments: 'none',
  outfile: 'dist/integration.mjs',
});

console.log('built dist/integration.mjs');
