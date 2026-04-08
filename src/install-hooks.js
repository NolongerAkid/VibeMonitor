#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const BACKUP_PATH = path.join(CLAUDE_DIR, 'settings.json.backup');
const BRIDGE_PATH = path.resolve(__dirname, 'bridge.js');

const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'TaskCompleted',
];

const MARKER = 'vibe-monitor-bridge';

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to read ${SETTINGS_PATH}: ${err.message}`);
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

function backupSettings() {
  if (fs.existsSync(SETTINGS_PATH)) {
    fs.copyFileSync(SETTINGS_PATH, BACKUP_PATH);
    console.log(`Backup created: ${BACKUP_PATH}`);
  }
}

function isVibeMonitorHook(hook) {
  if (!hook) return false;
  // Direct format: {type, command}
  if (typeof hook.command === 'string' && hook.command.includes(MARKER)) return true;
  // Nested format: {hooks: [{type, command}]}
  if (Array.isArray(hook.hooks)) {
    return hook.hooks.some(h => typeof h.command === 'string' && h.command.includes(MARKER));
  }
  return false;
}

function buildHookCommand() {
  // Embed marker in a comment-style suffix so detection works
  // The command itself runs bridge.js; the marker is part of the string
  return `node ${BRIDGE_PATH} # ${MARKER}`;
}

function install() {
  // Ensure ~/.claude/ exists
  if (!fs.existsSync(CLAUDE_DIR)) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    console.log(`Created directory: ${CLAUDE_DIR}`);
  }

  // Verify bridge.js exists
  if (!fs.existsSync(BRIDGE_PATH)) {
    console.error(`ERROR: Bridge script not found at ${BRIDGE_PATH}`);
    process.exit(1);
  }

  // Read current settings
  const settings = readSettings();

  // Backup before modifying
  backupSettings();

  // Ensure hooks object exists
  if (!settings.hooks) {
    settings.hooks = {};
  }

  const command = buildHookCommand();
  const added = [];
  const skipped = [];

  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Check if already configured
    const existing = settings.hooks[event].find(isVibeMonitorHook);
    if (existing) {
      skipped.push(event);
      continue;
    }

    settings.hooks[event].push({
      hooks: [{
        type: 'command',
        command,
      }],
    });
    added.push(event);
  }

  // Write back
  writeSettings(settings);

  // Report
  console.log('');
  console.log('Vibe Monitor hooks configuration complete.');
  console.log(`Settings file: ${SETTINGS_PATH}`);
  console.log(`Bridge script: ${BRIDGE_PATH}`);
  console.log('');

  if (added.length > 0) {
    console.log('Added hooks for:');
    for (const event of added) {
      console.log(`  - ${event}`);
    }
  }

  if (skipped.length > 0) {
    console.log('Already configured (skipped):');
    for (const event of skipped) {
      console.log(`  - ${event}`);
    }
  }

  if (added.length === 0 && skipped.length === HOOK_EVENTS.length) {
    console.log('All hooks were already configured. No changes made.');
  }

  console.log('');
}

install();
