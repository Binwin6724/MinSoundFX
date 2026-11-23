// Development: builds the native engine if missing, bundles the main process,
// starts the Vite dev server and launches Electron against it.
//   npm run dev
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const addon = path.join(root, 'native', 'build-out', `${process.platform}-${process.arch}`, 'minsoundfx_native.node');

if (!existsSync(addon)) execFileSync(process.execPath, [path.join(root, 'scripts/build-native.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'scripts/build-main.mjs')], { stdio: 'inherit' });

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`→ Renderer at ${url}`);
console.log(
  process.platform === 'darwin'
    ? '  Note: system-wide capture needs the packaged app (Info.plist usage string). Use "npm run dist:mac" to test processing.'
    : '',
);

const electron = require('electron');
const child = spawn(electron, ['.'], { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' } });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
