// Builds the native addon against Electron's headers for the current (or a
// given) architecture and copies it to native/build-out/<platform>-<arch>/.
//   node scripts/build-native.mjs            # host arch
//   node scripts/build-native.mjs --arch x64
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const argIdx = process.argv.indexOf('--arch');
const arch = argIdx > 0 ? process.argv[argIdx + 1] : process.arch;
const electronVersion = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version;
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');

console.log(`→ Building native addon for Electron ${electronVersion} (${process.platform}-${arch})`);
execFileSync(
  process.execPath,
  [nodeGyp, 'rebuild', `--target=${electronVersion}`, `--arch=${arch}`,
   '--dist-url=https://electronjs.org/headers', '--release'],
  { cwd: path.join(root, 'native'), stdio: 'inherit', env: { ...process.env, npm_config_runtime: 'electron' } },
);
const outDir = path.join(root, 'native', 'build-out', `${process.platform}-${arch}`);
mkdirSync(outDir, { recursive: true });
copyFileSync(path.join(root, 'native', 'build', 'Release', 'minsoundfx_native.node'),
             path.join(outDir, 'minsoundfx_native.node'));
console.log(`✓ ${path.relative(root, outDir)}/minsoundfx_native.node`);
