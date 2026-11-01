// Build two clean extension archives from identical locked inputs and verify they match.
import fs from 'node:fs';
import path from 'node:path';
import { run, capture, sha256, fail } from './lib.mjs';
const root = path.resolve(process.argv[2] ?? 'build/production-assembly');
if (fs.existsSync(root)) fail('Output directory already exists; choose a fresh directory.');
fs.mkdirSync(root, { recursive: true });
const version = JSON.parse(fs.readFileSync('package.json')).version;
for (const name of ['a', 'b']) {
  run('node', ['scripts/build-wasm.mjs']);
  run('node', ['scripts/build.mjs', '--out', path.join(root, name)]);
  run('node', ['scripts/package.mjs', path.join(root, name), path.join(root, `clearscroll-${version}-${name}.zip`)]);
}
const a = path.join(root, `clearscroll-${version}-a.zip`), b = path.join(root, `clearscroll-${version}-b.zip`);
if (sha256(a) !== sha256(b)) fail('Independent assemblies differ. Preserve both outputs for investigation.');
const identity = { commit: capture('git', ['rev-parse', 'HEAD']), version,
  status: capture('git', ['status', '--porcelain']), node: process.version,
  rust: capture('rustc', ['--version']), wasmBindgen: capture('wasm-bindgen', ['--version']),
  python: capture('python3', ['--version']), zlib: capture('python3', ['-c', 'import zlib;print(zlib.ZLIB_VERSION)']),
  lockfiles: Object.fromEntries(['package-lock.json', 'Cargo.lock', 'tools/model_lock.json'].map(f => [f, sha256(f)])),
  zipSha256: sha256(a), bytes: fs.statSync(a).size };
fs.writeFileSync(path.join(root, 'identity.json'), JSON.stringify(identity, null, 2) + '\n');
console.log('Assemblies and ZIPs match. Browser, security and license gates must also pass before acceptance.');
