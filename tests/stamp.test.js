// The deploy workflow stamps a copy of public/ with ?v=<commit> (scripts/stamp-version.mjs).
// Run it here on a temp copy so a missed import fails CI instead of the live site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const VERSION = 'test123';

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsFiles(p)));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('deploy stamping versions every local script, stylesheet and module import', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stamp-'));
  try {
    await cp(join(ROOT, 'public'), dir, { recursive: true });
    execFileSync(process.execPath, [join(ROOT, 'scripts/stamp-version.mjs'), dir, VERSION]);

    const html = await readFile(join(dir, 'index.html'), 'utf8');
    const localRefs = [...html.matchAll(/\s(?:src|href)="((?!https?:|\/\/|data:|#)[^"]+\.(?:js|css)(?:\?[^"]*)?)"/g)].map((m) => m[1]);
    assert.ok(localRefs.length >= 2, 'index.html should load app.js and styles.css');
    for (const ref of localRefs) assert.ok(ref.endsWith(`?v=${VERSION}`), `unstamped in index.html: ${ref}`);

    // Every relative import in the app's modules (including any subfolder) must be stamped.
    for (const file of await jsFiles(join(dir, 'js'))) {
      const src = await readFile(file, 'utf8');
      const imports = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g)].map((m) => m[2]);
      for (const spec of imports) assert.ok(spec.endsWith(`?v=${VERSION}`), `unstamped import in ${file}: ${spec}`);
    }

    // The stamped modules still load and work.
    const { toSimplified } = await import(pathToFileURL(join(dir, 'js/t2s.js')).href);
    assert.equal(toSimplified('為什麼'), '为什么');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
