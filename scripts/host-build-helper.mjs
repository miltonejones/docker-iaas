#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const socketPath = process.env.HOST_BUILD_HELPER_SOCKET || '/tmp/dockyard-host-build.sock';
const maxOutputChars = 64_000;

function presets() {
  const raw = process.env.HOST_COMMAND_PRESETS || '[]';
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('HOST_COMMAND_PRESETS must be a JSON array.');
  return parsed.map((preset) => {
    if (
      !preset ||
      !/^[a-z0-9][a-z0-9-]*$/.test(preset.name || '') ||
      !path.isAbsolute(preset.cwd || '') ||
      typeof preset.command !== 'string' ||
      !preset.command ||
      !Array.isArray(preset.args) ||
      !preset.args.every((arg) => typeof arg === 'string') ||
      typeof preset.artifacts !== 'string' ||
      !preset.artifacts ||
      path.isAbsolute(preset.artifacts) ||
      preset.artifacts.split('/').includes('..')
    ) {
      throw new Error('Each preset needs name, absolute cwd, command, string args, and relative artifacts.');
    }
    return preset;
  });
}

function run(preset) {
  return new Promise((resolve, reject) => {
    const child = spawn(preset.command, preset.args, {
      cwd: preset.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk) => {
      output = `${output}${chunk}`.slice(-maxOutputChars);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve({ artifactPath: path.join(preset.cwd, preset.artifacts) });
      } else {
        console.error(`Preset "${preset.name}" failed (${signal || `exit ${code}`}):\n${output}`);
        reject(new Error(`Preset "${preset.name}" failed (${signal || `exit ${code}`}).`));
      }
    });
  });
}

function send(socket, body) {
  socket.end(`${JSON.stringify(body)}\n`);
}

try {
  fs.rmSync(socketPath, { force: true });
  const configured = presets();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let request = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      request += chunk;
      if (request.length > 4096) {
        send(socket, { ok: false, error: 'Request is too large.' });
        socket.destroy();
      }
    });
    socket.on('end', async () => {
      try {
        const { preset } = JSON.parse(request);
        const selected = configured.find((item) => item.name === preset);
        if (!selected) throw new Error(`Unknown build preset "${preset}".`);
        await run(selected);
        send(socket, { ok: true });
      } catch (err) {
        send(socket, { ok: false, error: err.message });
      }
    });
  });
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o660));
  server.on('error', (err) => {
    console.error(`Host build helper failed: ${err.message}`);
    process.exitCode = 1;
  });
} catch (err) {
  console.error(`Host build helper failed: ${err.message}`);
  process.exitCode = 1;
}
