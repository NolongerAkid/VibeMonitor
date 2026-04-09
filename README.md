# Vibe Monitor

A Dynamic Island-style macOS menu bar app that monitors your AI coding sessions in real time. Inspired by [Vibe Island](https://vibeisland.app/).

Track multiple Claude Code / Codex / Gemini sessions at a glance, get notified when tasks complete or need approval, and jump to the right terminal with one click.

## Features

- **Dynamic Island UI** — Sits at the top of your screen as a thin line, expands on hover or when attention is needed
- **Smart auto-expand** — Island stays expanded when sessions need approval or have unread completions, collapses when all clear
- **Pop animation** — Bounce alert when new items need your attention
- **macOS notifications** — Native system notifications for task completions and approval requests, click to jump directly
- **Terminal jumping** — Click a session to jump to the exact iTerm2 tab, GoLand terminal, VS Code, or Cursor window
- **Session rename** — Double-click or use the edit icon to give sessions custom names
- **Unread tracking** — Blue indicator for unread completions, orange for pending approvals
- **New session** — Quick-launch a new Claude Code session from the + button
- **Multi-agent support** — Works with Claude Code, Codex, Gemini, Cursor, and more

## Requirements

- macOS
- Node.js >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (or other supported AI coding tools)

## Quick Start

```bash
# Clone
git clone https://github.com/NolongerAkid/VibeMonitor.git
cd VibeMonitor

# Install dependencies
npm install

# Install Claude Code hooks
npm run install-hooks

# Start the monitor
npm start
```

That's it. The monitor will appear at the top of your screen. Open a Claude Code session in any terminal and it will be automatically detected.

## How It Works

```
Claude Code hooks → bridge.js → Unix socket → Electron app → Dynamic Island UI
```

1. **Hooks** — `install-hooks` registers a bridge script in `~/.claude/settings.json` for all Claude Code lifecycle events (session start/end, tool use, approvals, completions, etc.)
2. **Bridge** — Each hook event is captured with environment info (terminal app, session ID, TTY) and sent to a Unix domain socket at `~/.vibe-monitor/run/monitor.sock`
3. **Monitor** — The Electron app receives events, maintains session state, and renders the Dynamic Island UI
4. **Notifications** — macOS native notifications fire on task completion and approval requests

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the monitor |
| `npm run demo` | Start with sample demo sessions |
| `npm run install-hooks` | Install/update Claude Code hooks |

## Supported Terminals

| Terminal | Jump to session | Auto-detect |
|----------|:-:|:-:|
| iTerm2 | Exact tab | Yes |
| GoLand / JetBrains | Window | Yes |
| VS Code | Window | Yes |
| Cursor | Window | Yes |
| Apple Terminal | Window | Yes |

## Session States

| State | Island | Indicator |
|-------|--------|-----------|
| Running tool | Collapsed (thin line) | Green dot |
| Processing | Collapsed | Green dot |
| Needs approval | **Expanded + pop animation** | Orange dot + orange border |
| Completed (unread) | **Expanded** | Blue dot + blue border |
| Completed (read) | Collapsed | Blue dot |
| Waiting for input | Collapsed | Blue dot |

## Configuration

Hooks are stored in `~/.claude/settings.json`. To uninstall, remove entries containing `vibe-monitor-bridge` from the hooks section, or delete the hooks section entirely.

The Unix socket is created at `~/.vibe-monitor/run/monitor.sock`.

## Development

```bash
# Run with DevTools
npm start -- --dev

# Run with demo data
npm run demo
```

## License

MIT
