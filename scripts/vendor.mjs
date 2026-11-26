// Copies browser-ready third-party files from node_modules into public/vendor/, so the
// static site needs no build step and no CDN at runtime.
//   npm install && npm run vendor
// Commit the result. To upgrade: bump the version in package.json, npm install, rerun.
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const pkg = (p) => resolve(ROOT, 'node_modules', p);
const out = (p) => resolve(ROOT, 'public/vendor', p);

const FILES = [
  // opencc-js: Traditional → Simplified Chinese (MIT code, Apache-2.0 dictionary data)
  ['opencc-js/dist/esm/t2cn.js', 'opencc-js/t2cn.js'],
  ['opencc-js/LICENSE', 'opencc-js/LICENSE'],
  ['opencc-js/LICENSES/Apache-2.0.txt', 'opencc-js/LICENSES/Apache-2.0.txt'],
  ['opencc-js/THIRD_PARTY_LICENSES.md', 'opencc-js/THIRD_PARTY_LICENSES.md'],
  // suncalc: sun position, for switching light/dark at sunrise/sunset (BSD-2-Clause)
  ['suncalc/index.js', 'suncalc/suncalc.js'],
  ['suncalc/LICENSE', 'suncalc/LICENSE'],
];

for (const [from, to] of FILES) {
  await mkdir(dirname(out(to)), { recursive: true });
  await copyFile(pkg(from), out(to));
}
for (const name of ['opencc-js', 'suncalc']) {
  const { version } = JSON.parse(await readFile(pkg(`${name}/package.json`), 'utf8'));
  console.log(`Vendored ${name} ${version} → public/vendor/${name}/`);
}
