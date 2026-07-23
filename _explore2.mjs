import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

let output = '';

function out(s) {
  output += s + '\n';
  console.log(s);
}

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

// 1. List /workspace/scripts/
out('=== 1. /workspace/scripts/ ===');
const scripts = listFiles('/workspace/scripts');
out('Files:');
scripts.files.forEach(f => out('  ' + f));
out('Dirs:');
scripts.dirs.forEach(d => out('  ' + d));

// 2. List /workspace/web/src/ (first level)
out('\n=== 2. /workspace/web/src/ ===');
const src = listFiles('/workspace/web/src');
out('Subdirs:');
src.dirs.forEach(d => out('  ' + d));
out('Files:');
src.files.forEach(f => out('  ' + f));

// 2b. List /workspace/web/src/components/
out('\n=== 2b. /workspace/web/src/components/ ===');
const comp = listFiles('/workspace/web/src/components');
out('Files:');
comp.files.forEach(f => out('  ' + f));

// 2c. List /workspace/web/src/pages/
out('\n=== 2c. /workspace/web/src/pages/ ===');
const pages = listFiles('/workspace/web/src/pages');
out('Files:');
pages.files.forEach(f => out('  ' + f));

// 3. Search for NotificationPanel, NotificationDropdown, notifications in web/src
out('\n=== 3. Search in /workspace/web/src/ for notification-related ===');
function searchInFile(fullPath, patterns) {
  try {
    const content = readFileSync(fullPath, 'utf-8').toLowerCase();
    return patterns.some(p => content.includes(p.toLowerCase()));
  } catch { return false; }
}

function walkAndSearch(dir, patterns, results = []) {
  try {
    const entries = readdirSync(dir);
    for (const e of entries) {
      const full = join(dir, e);
      try {
        const s = statSync(full);
        if (s.isDirectory()) {
          if (!e.startsWith('.') && e !== 'node_modules') walkAndSearch(full, patterns, results);
        } else if (s.isFile()) {
          if (searchInFile(full, patterns)) results.push(full);
        }
      } catch {}
    }
  } catch {}
  return results;
}

const patterns = ['NotificationPanel', 'NotificationDropdown', 'notifications'];
const matches = walkAndSearch('/workspace/web/src', patterns);
matches.forEach(m => out('  ' + m));

// Check also in server/src
out('\n=== 3b. Search in /workspace/server/src/ for notification-related ===');
const serverMatches = walkAndSearch('/workspace/server/src', patterns);
serverMatches.forEach(m => out('  ' + m));

// Check in relay/src
out('\n=== 3c. Search in /workspace/relay/src/ for notification-related ===');
const relayMatches = walkAndSearch('/workspace/relay/src', patterns);
relayMatches.forEach(m => out('  ' + m));

// 4. Test files
out('\n=== 4. Test files ===');

// Search for any test files in the whole workspace
out('\n--- All files matching *test* or *.spec.* ---');
function findAllTestFiles(dir) {
  const results = [];
  function walk(d) {
    try {
      const entries = readdirSync(d);
      for (const e of entries) {
        const full = join(d, e);
        try {
          const s = statSync(full);
          if (s.isDirectory()) {
            if (!e.startsWith('.') && e !== 'node_modules' && e !== '.git') walk(full);
          } else if (s.isFile()) {
            const lower = e.toLowerCase();
            if (lower.includes('test') || lower.includes('spec')) results.push(full);
          }
        } catch {}
      }
    } catch {}
  }
  walk(dir);
  return results;
}
const testFiles = findAllTestFiles('/workspace');
testFiles.forEach(f => out('  ' + f));

if (testFiles.length === 0) {
  out('  (none found)');
}

// 4b. Check patterns specifically
out('\n--- Check specific patterns ---');
out('scripts/test-*.mjs: ' + JSON.stringify(listFiles('/workspace/scripts').files.filter(f => f.startsWith('test-') && f.endsWith('.mjs'))));
out('scripts/*.test.*: ' + JSON.stringify(listFiles('/workspace/scripts').files.filter(f => f.includes('.test.'))));
out('/*.test.*: ' + JSON.stringify(listFiles('/workspace').files.filter(f => f.includes('.test.'))));
out('e2e/ exists: ' + existsSync('/workspace/e2e'));
out('test/ exists: ' + existsSync('/workspace/test'));
out('tests/ exists: ' + existsSync('/workspace/tests'));

// 5. Search for "Test 9" or "test 9" (case insensitive)
out('\n=== 5. Search for "test 9" or "Test 9" (case insensitive) ===');
function searchTextInFiles(dir, searchText) {
  const results = [];
  const lowerSearch = searchText.toLowerCase();
  function walk(d) {
    try {
      const entries = readdirSync(d);
      for (const e of entries) {
        const full = join(d, e);
        try {
          const s = statSync(full);
          if (s.isDirectory()) {
            if (!e.startsWith('.') && e !== 'node_modules' && e !== '.git' && e !== 'dist' && e !== 'issue-logs') walk(full);
          } else if (s.isFile()) {
            try {
              const content = readFileSync(full, 'utf-8').toLowerCase();
              if (content.includes(lowerSearch)) results.push(full);
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }
  walk(dir);
  return results;
}

const test9Matches = searchTextInFiles('/workspace', 'test 9');
test9Matches.forEach(m => out('  ' + m));
if (test9Matches.length === 0) out('  (none found)');

// Extra: check what's at root level
out('\n=== Root level listing ===');
const root = listFiles('/workspace');
out('Dirs:');
root.dirs.forEach(d => out('  ' + d));
out('Files:');
root.files.forEach(f => out('  ' + f));

// Write output to file
writeFileSync('/workspace/_report.txt', output, 'utf-8');
console.log('\n=== Report written to /workspace/_report.txt ===');
