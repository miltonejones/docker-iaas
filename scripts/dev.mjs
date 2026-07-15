// Tiny dev launcher: runs the API server and the Vite dev server together so a
// single `npm run dev` at the repo root brings the whole console up. No extra
// dependency (concurrently/etc.) needed.
import { spawn } from 'node:child_process';

const procs = [
  { name: 'server', cmd: 'npm', args: ['--workspace', 'server', 'run', 'dev'], color: '\x1b[36m' },
  { name: 'web', cmd: 'npm', args: ['--workspace', 'web', 'run', 'dev'], color: '\x1b[35m' },
];

const children = procs.map(({ name, cmd, args, color }) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(tag + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
});

function shutdown() {
  for (const c of children) c.kill('SIGINT');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const c of children) c.on('exit', shutdown);
