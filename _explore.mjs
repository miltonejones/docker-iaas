import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

function listFiles(dir) {
  try {
    const entries = readdirSync(dir);
    const files = [];
    const dirs = [];
    for (const e of entries) {
      try {
        const full = join(dir, e);
        const s = statSync(full);
        if (s.isDirectory()) dirs.push(e + '/');
        else files.push(e);
      } catch {}
    }
    return { files, dirs };
  } catch (e) {
    return { files: [`ERROR: ${e.message}`], dirs: [] };
  }
}

function grepFiles(dir, patterns, exts = []) {
  const results = [];
  function walk(d) {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const full = join(d, e);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) {
        if (!e.startsWith('.') && e !== 'node_modules') walk(full);
      } else if (s.isFile()) {
        if (exts.length > 0 && !exts.some(ext => e.endsWith(ext))) continue;
        try {
          const content = require('fs').readFileSync(full, 'utf-8');
          const lower = content.toLowerCase();
          for (const p of patterns) {
            if (lower.includes(p.toLowerCase())) {
              results.push(full);
              break;
            }
          }
        } catch {}
      }
    }
  }
  walk(dir);
  return results;
}

// 1. List /workspace/scripts/
console.log('=== 1. /workspace/scripts/ ===');
const scripts = listFiles('/workspace/scripts');
console.log('Files:', scripts.files);
console.log('Dirs:', scripts.dirs);

// 2. List /workspace/web/src/ (first level)
console.log('\n=== 2. /workspace/web/src/ ===');
const src = listFiles('/workspace/web/src');
console.log('Subdirs:', src.dirs);
console.log('Files:', src.files);

// 3. Search for NotificationPanel, NotificationDropdown, notifications in web/src
console.log('\n=== 3. Search in /workspace/web/src/ ===');
const patternResults = grepFiles('/workspace/web/src', ['NotificationPanel', 'NotificationDropdown', 'notifications']);
console.log('Matches:', patternResults.length > 0 ? patternResults : '(none)');

// 4. Test files
console.log('\n=== 4. Test files ===');

console.log('--- scripts/test-*.mjs ---');
const t1 = listFiles('/workspace/scripts').files.filter(f => f.startsWith('test-') && f.endsWith('.mjs'));
console.log(t1.length > 0 ? t1 : '(none)');

console.log('--- scripts/*.test.* ---');
const t2 = listFiles('/workspace/scripts').files.filter(f => f.includes('.test.'));
console.log(t2.length > 0 ? t2 : '(none)');

console.log('--- /*.test.* ---');
const rootFiles = listFiles('/workspace').files.filter(f => f.includes('.test.'));
console.log(rootFiles.length > 0 ? rootFiles : '(none)');

console.log('--- /workspace/e2e/ ---');
if (existsSync('/workspace/e2e')) {
  const e2e = listFiles('/workspace/e2e');
  console.log('Files:', e2e.files);
  console.log('Dirs:', e2e.dirs);
} else {
  console.log('(directory does not exist)');
}

console.log('--- /workspace/test/ ---');
if (existsSync('/workspace/test')) {
  const test = listFiles('/workspace/test');
  console.log('Files:', test.files);
  console.log('Dirs:', test.dirs);
} else {
  console.log('(directory does not exist)');
}

// Also search for test/ e2e/ test-* patterns in the broader workspace
console.log('--- Other test directories ---');
for (const d of ['/workspace/e2e', '/workspace/test', '/workspace/tests', '/workspace/e2e-tests', '/workspace/integration-tests']) {
  if (existsSync(d)) {
    const items = listFiles(d);
    console.log(`${d}/: files=${JSON.stringify(items.files)}, dirs=${JSON.stringify(items.dirs)}`);
  } else {
    console.log(`${d}: (does not exist)`);
  }
}

// Search for test files with "consumer" or "relay" or "notification" in name
console.log('\n=== Extra: test files with consumer/relay/notification in name ===');
const allFiles = [];
function walkAll(d) {
  let entries;
  try { entries = readdirSync(d); } catch { return; }
  for (const e of entries) {
    const full = join(d, e);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) {
      if (!e.startsWith('.') && e !== 'node_modules' && e !== '.git') walkAll(full);
    } else {
      allFiles.push(full);
    }
  }
}
walkAll('/workspace');
const keywords = ['consumer', 'relay', 'notification', 'e2e', 'test-9', 'test9'];
for (const f of allFiles) {
  const lower = f.toLowerCase();
  if (keywords.some(k => lower.includes(k))) {
    console.log(f);
  }
}
