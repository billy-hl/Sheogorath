'use strict';
/**
 * Everything that can be checked about the code without running it, before a
 * deploy restarts the bot on it.
 *
 * On 2026-09-26 a merge-conflict marker reached the server. The bot died on
 * load with `SyntaxError: Unexpected token '<<'`, and systemd restarted it into
 * the same error every ten seconds. Each check here would have caught something
 * like that while the old process was still running:
 *
 *   - no conflict markers in anything the bot reads
 *   - every .js file compiles
 *   - every relative require() names a file that exists
 *   - every .json file parses
 *
 * Nothing is executed. Loading the bot's modules is not safe from a script:
 * src/index.js logs in, and src/deploy-commands.js re-registers the live slash
 * commands the moment it is required.
 *
 * Run it after pulling and before restarting:
 *
 *   npm run check && sudo systemctl restart sheogorath
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'scripts', 'config', 'data/knowledge'];
const FILES = ['package.json', 'README.md', '.env.example'];
const TEXT = /\.(js|json|md|html|css|txt|example)$/;
const SKIP = new Set(['node_modules', '.git']);

const CONFLICT = /^(<{7}|>{7})(?: |$)/m;
const REQUIRE = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
const CJS_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TEXT.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [
  ...DIRS.flatMap((d) => walk(path.join(ROOT, d))),
  ...FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
];

const problems = [];
const say = (file, what) => problems.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}: ${what}`);
let compiled = 0;

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');

  const marker = CONFLICT.exec(text);
  if (marker) {
    const line = text.slice(0, marker.index).split('\n').length;
    say(file, `conflict marker on line ${line}`);
    continue;
  }

  if (file.endsWith('.json')) {
    try {
      JSON.parse(text);
    } catch (err) {
      say(file, `does not parse: ${err.message}`);
    }
    continue;
  }

  if (!file.endsWith('.js') || file.includes(`${path.sep}public${path.sep}`)) continue;

  // A shebang is fine to Node but not inside a function body. Blanked rather
  // than cut, so line numbers in an error still match the file.
  const source = text.replace(/^#!.*/, '');
  try {
    vm.compileFunction(source, CJS_PARAMS, { filename: file });
    compiled++;
  } catch (err) {
    const where = /:(\d+)/.exec(String(err.stack).split('\n')[0])?.[1];
    say(file, `${err.name}: ${err.message}${where ? ` (line ${where})` : ''}`);
    continue;
  }

  for (const [, , spec] of text.matchAll(REQUIRE)) {
    try {
      require.resolve(path.resolve(path.dirname(file), spec));
    } catch {
      say(file, `require('${spec}') names a file that does not exist`);
    }
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s) — do not restart on this:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`✓ ${files.length} files checked, ${compiled} scripts compile, no conflict markers.`);
