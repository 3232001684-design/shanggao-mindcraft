#!/usr/bin/env node
// Sync our customized framework files over the installed mindcraft package.
// The framework (mindcraft@0.1.4-2) is a public npm package; we ship only the
// files we changed in framework-overrides/. This script copies them into
// node_modules/mindcraft/ so `npm run bots` uses our build.
//
// Run automatically on `npm install` (postinstall). Re-run `npm run sync` after
// a `npm update` to re-apply the overrides.
const fs = require('fs');
const path = require('path');

const overridesRoot = path.join(__dirname, '..', 'framework-overrides');

// Resolve the installed mindcraft package.
let target;
try {
  target = path.dirname(require.resolve('mindcraft/package.json', { paths: [process.cwd()] }));
} catch (_) {
  target = path.join(__dirname, '..', 'node_modules', 'mindcraft');
}

if (!fs.existsSync(target)) {
  console.warn('[sync-overrides] mindcraft not installed yet; skipping (run after npm install).');
  process.exit(0);
}

let n = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const src = path.join(dir, e.name);
    if (e.isDirectory()) { walk(src); continue; }
    if (e.name.endsWith('.js')) {
      const rel = path.relative(overridesRoot, src);
      const dest = path.join(target, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      n++;
    }
  }
}
walk(overridesRoot);
console.log(`[sync-overrides] applied ${n} customized file(s) to ${target}`);
