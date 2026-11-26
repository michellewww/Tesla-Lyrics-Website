// Run by the deploy workflow on the files about to be published (not on the repo):
//   node scripts/stamp-version.mjs <dir> <version>
// Adds ?v=<version> to every local script/stylesheet URL and module import, so each
// deploy gets its own cache entries. GitHub Pages lets browsers cache files for 10
// minutes; this makes it much less likely that a cached old file is combined with a new
// one. It is not a guarantee: Pages ignores the query, so a stale page asking for an
// old ?v= that isn't cached (e.g. a lazily loaded module) still gets the newest file.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [dir, version] = process.argv.slice(2);
if (!dir || !/^[\w.-]+$/.test(version || '')) {
  console.error('usage: node scripts/stamp-version.mjs <dir> <version>');
  process.exit(1);
}

const stamp = (url) => `${url}?v=${version}`;
// import … from './x.js'   |   import('./x.js')   (relative paths only)
const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"?]+\.js)\2/g;
// <script src="js/app.js">   |   <link href="styles.css">   (local .js/.css only)
const HTML_RE = /(\s(?:src|href)=")((?!https?:|\/\/|data:|#)[^"?]+\.(?:js|css))"/g;

let count = 0;
async function stampFile(path, re, replace) {
  const before = await readFile(path, 'utf8');
  const after = before.replace(re, (...m) => {
    count++;
    return replace(...m);
  });
  if (after !== before) await writeFile(path, after);
}

await stampFile(join(dir, 'index.html'), HTML_RE, (_, attr, url) => `${attr}${stamp(url)}"`);
for (const name of await readdir(join(dir, 'js'))) {
  if (!name.endsWith('.js')) continue;
  await stampFile(join(dir, 'js', name), IMPORT_RE, (_, kw, q, url) => `${kw}${q}${stamp(url)}${q}`);
}
console.log(`Stamped ${count} URLs with v=${version}`);
