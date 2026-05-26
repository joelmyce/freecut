import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';

const DEV_PORT = 5173;
const AGENT_PORT = 5174;

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function toWindowsCommand(command, args) {
  return [command, ...args].map(quoteWindowsArg).join(' ');
}

function quoteWindowsArg(value) {
  if (value.length === 0) return '""';
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function runCommand(command, args, label) {
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', toWindowsCommand(command, args)], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    : spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  pipeWithPrefix(child.stdout, process.stdout, `[${label}] `);
  pipeWithPrefix(child.stderr, process.stderr, `[${label}] `);

  return child;
}

function pipeWithPrefix(stream, output, prefix) {
  let pending = '';

  stream.on('data', (chunk) => {
    pending += chunk.toString();

    while (true) {
      const newlineIndex = pending.indexOf('\n');
      if (newlineIndex < 0) break;
      const line = pending.slice(0, newlineIndex + 1);
      pending = pending.slice(newlineIndex + 1);
      output.write(prefix + line);
    }
  });

  stream.on('end', () => {
    if (pending.length > 0) {
      output.write(prefix + pending + '\n');
      pending = '';
    }
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function assertPortsAvailable() {
  const unavailable = [];
  if (!(await isPortAvailable(DEV_PORT))) unavailable.push(DEV_PORT);
  if (!(await isPortAvailable(AGENT_PORT))) unavailable.push(AGENT_PORT);

  if (unavailable.length === 0) return;

  console.error(`[dev:all] port(s) already in use: ${unavailable.join(', ')}`);
  console.error('[dev:all] close the existing dev/agent process, then rerun `npm run dev:all`.');
  process.exit(1);
}

function terminateChild(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

await assertPortsAvailable();

console.log('[dev:all] starting Vite dev server + agent server');
console.log(`[dev:all] vite  -> http://localhost:${DEV_PORT}`);
console.log(`[dev:all] agent -> ws://localhost:${AGENT_PORT}`);
console.log('[dev:all] press Ctrl+C to stop both');

const npmCommand = getNpmCommand();
const children = [
  runCommand(npmCommand, ['run', 'dev'], 'vite'),
  runCommand(npmCommand, ['run', 'dev:agent'], 'agent'),
];

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) terminateChild(child);
  process.exit(exitCode);
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
      shutdown(0);
      return;
    }
    shutdown(code ?? 1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
