// Explicit paths prevent accidentally packaging a historical generic dist/.
import path from 'node:path';
import { REPO, run, fail } from './lib.mjs';
const [dist, zip] = process.argv.slice(2);
if (!dist || !zip) fail('Usage: node scripts/package.mjs <validated-unpacked-directory> <new-output.zip>');
run('node', ['scripts/validate-dist.mjs', path.resolve(dist)]);
run('python3', [path.join(REPO, 'scripts/package-deterministic.py'), path.resolve(dist), path.resolve(zip)]);
