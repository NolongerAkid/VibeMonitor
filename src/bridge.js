#!/usr/bin/env node
'use strict';

const net = require('net');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const SOCKET_PATH = path.join(os.homedir(), '.vibe-monitor', 'run', 'monitor.sock');
const TIMEOUT_MS = 5000;

const ENV_KEYS = [
  'TERM_PROGRAM',
  'ITERM_SESSION_ID',
  'TERM_SESSION_ID',
  'TMUX',
  'TMUX_PANE',
  'KITTY_WINDOW_ID',
  '__CFBundleIdentifier',
  'CURSOR_TRACE_ID',
  'TERMINAL_EMULATOR',
  'JETBRAINS_TERMINAL',
  'IDEA_INITIAL_DIRECTORY',
];

function collectEnvVars() {
  const collected = {};
  for (const key of ENV_KEYS) {
    if (process.env[key]) {
      collected[key] = process.env[key];
    }
  }
  return collected;
}

function detectTTY() {
  try {
    let pid = process.ppid;
    for (let i = 0; i < 8 && pid > 1; i++) {
      const output = execSync(`ps -o tty=,ppid= -p ${pid}`, {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const parts = output.split(/\s+/);
      if (parts.length >= 1) {
        const tty = parts[0];
        if (tty && tty !== '??' && tty !== '-') {
          return tty;
        }
      }
      if (parts.length >= 2) {
        pid = parseInt(parts[1], 10);
        if (isNaN(pid)) break;
      } else {
        break;
      }
    }
  } catch (_) {
    // ignore
  }
  return null;
}

function buildEvent(input) {
  const sessionId =
    input.session_id ||
    process.env.CLAUDE_SESSION_ID ||
    `pid-${process.ppid}`;

  const hookEventName =
    input.hook_event_name ||
    process.env.CLAUDE_HOOK_EVENT ||
    'unknown';

  const cwd = input.cwd || process.env.PWD || process.cwd();

  return {
    ...input,
    session_id: sessionId,
    hook_event_name: hookEventName,
    cwd,
    _source: 'claude',
    _ppid: process.ppid,
    _tty: detectTTY(),
    _env: collectEnvVars(),
  };
}

function sendToSocket(data) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(data) + '\n';
    const client = net.connect(SOCKET_PATH, () => {
      client.end(payload, () => {
        resolve();
      });
    });
    client.on('error', () => {
      resolve();
    });
    client.on('close', () => {
      resolve();
    });
    client.setTimeout(TIMEOUT_MS, () => {
      client.destroy();
      resolve();
    });
  });
}

async function main() {
  const timer = setTimeout(() => {
    process.exit(0);
  }, TIMEOUT_MS);

  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();

    let input = {};
    if (raw) {
      try {
        input = JSON.parse(raw);
      } catch (_) {
        input = { _raw: raw };
      }
    }

    const event = buildEvent(input);
    await sendToSocket(event);
  } catch (_) {
    // never block the CLI
  }

  clearTimeout(timer);
  process.exit(0);
}

main();
