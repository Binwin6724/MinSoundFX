// Compiles and runs the native DSP test-suite with the host C++ compiler.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', process.platform === 'win32' ? 'test_dsp.exe' : 'test_dsp');
mkdirSync(path.dirname(out), { recursive: true });
const srcs = [path.join(root, 'native/tests/test_dsp.cpp'), path.join(root, 'native/src/dsp/engine.cpp')];
if (process.platform === 'win32') {
  execFileSync('cl', ['/nologo', '/std:c++17', '/O2', '/EHsc', '/utf-8', `/Fe:${out}`, `/Fo:${path.dirname(out)}\\`, ...srcs], { stdio: 'inherit' });
} else {
  execFileSync(process.env.CXX || 'c++', ['-std=c++17', '-O2', '-Wall', '-Wextra', '-o', out, ...srcs], { stdio: 'inherit' });
}
execFileSync(out, process.argv.slice(2), { stdio: 'inherit' });
