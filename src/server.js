"use strict";

const net = require("net");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HTTP_PORT = 3777;
const SOCKET_DIR = path.join(os.homedir(), ".vibe-monitor", "run");
const SOCKET_PATH = path.join(SOCKET_DIR, "monitor.sock");
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const ENDED_SESSION_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Session Store
// ---------------------------------------------------------------------------

const Status = Object.freeze({
  WAITING_FOR_INPUT: "waiting_for_input",
  PROCESSING: "processing",
  THINKING: "thinking",
  RUNNING_TOOL: "running_tool",
  WAITING_FOR_APPROVAL: "waiting_for_approval",
  QUESTION: "question",
  COMPACTING: "compacting",
  ENDED: "ended",
});

/** @type {Map<string, object>} */
const sessions = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const removalTimers = new Map();

function createSession(id) {
  return {
    id,
    agentType: "unknown",
    status: Status.WAITING_FOR_INPUT,
    cwd: null,
    projectName: null,
    lastUserPrompt: null,
    lastAssistantMessage: null,
    currentToolName: null,
    approval: null,   // { toolName, command, filePath }
    question: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function deriveAgentType(source) {
  if (!source) return "unknown";
  const s = source.toLowerCase();
  if (s.includes("claude")) return "claude";
  if (s.includes("codex") || s.includes("opencode")) return "codex";
  if (s.includes("gemini")) return "gemini";
  if (s.includes("cursor")) return "cursor";
  if (s.includes("copilot")) return "copilot";
  return "unknown";
}

function deriveProjectName(cwd) {
  if (!cwd) return null;
  return path.basename(cwd);
}

function getOrCreateSession(id) {
  let session = sessions.get(id);
  if (!session) {
    session = createSession(id);
    sessions.set(id, session);
  }
  return session;
}

function scheduleRemoval(id) {
  clearRemovalTimer(id);
  const timer = setTimeout(() => {
    sessions.delete(id);
    removalTimers.delete(id);
    broadcastSessions();
  }, ENDED_SESSION_TTL_MS);
  timer.unref();
  removalTimers.set(id, timer);
}

function clearRemovalTimer(id) {
  const existing = removalTimers.get(id);
  if (existing) {
    clearTimeout(existing);
    removalTimers.delete(id);
  }
}

function sessionsSnapshot() {
  return Array.from(sessions.values());
}

// ---------------------------------------------------------------------------
// Event Handling
// ---------------------------------------------------------------------------

function handleEvent(evt) {
  const sessionId = evt.session_id;
  if (!sessionId) return;

  const hookEvent = evt.hook_event_name;
  const session = getOrCreateSession(sessionId);

  // Common fields — update on every event
  if (evt.cwd) {
    session.cwd = evt.cwd;
    session.projectName = deriveProjectName(evt.cwd);
  }
  if (evt._source) {
    session.agentType = deriveAgentType(evt._source);
  }
  session.updatedAt = new Date().toISOString();

  switch (hookEvent) {
    case "SessionStart":
      session.status = Status.WAITING_FOR_INPUT;
      session.startedAt = new Date().toISOString();
      clearRemovalTimer(sessionId);
      break;

    case "SessionEnd":
      session.status = Status.ENDED;
      scheduleRemoval(sessionId);
      break;

    case "UserPromptSubmit":
      if (evt.prompt != null) {
        session.lastUserPrompt = evt.prompt;
      }
      session.status = Status.PROCESSING;
      break;

    case "PreToolUse":
      if (evt.tool_name != null) {
        session.currentToolName = evt.tool_name;
      }
      session.status = Status.RUNNING_TOOL;
      break;

    case "PostToolUse":
      session.currentToolName = null;
      session.status = Status.PROCESSING;
      break;

    case "PermissionRequest": {
      const input = evt.tool_input || {};
      session.approval = {
        toolName: evt.tool_name || null,
        command: input.command || null,
        filePath: input.file_path || null,
      };
      session.status = Status.WAITING_FOR_APPROVAL;
      break;
    }

    case "QuestionRequest":
      session.question = evt.questions || evt.question || null;
      session.status = Status.QUESTION;
      break;

    case "Stop":
      if (evt.last_assistant_message != null) {
        session.lastAssistantMessage = evt.last_assistant_message;
      }
      session.status = Status.WAITING_FOR_INPUT;
      session.approval = null;
      session.question = null;
      break;

    default:
      // Unknown event — just update timestamp (already done above)
      break;
  }

  broadcastSessions();
}

// ---------------------------------------------------------------------------
// WebSocket — broadcast helper
// ---------------------------------------------------------------------------

/** @type {Set<WebSocket>} */
const wsClients = new Set();

function broadcastSessions() {
  const payload = JSON.stringify({ type: "update", sessions: sessionsSnapshot() });
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(res, urlPath) {
  let filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);
  filePath = path.normalize(filePath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA fallback — serve index.html for unmatched routes
      const indexPath = path.join(PUBLIC_DIR, "index.html");
      fs.readFile(indexPath, (err2, data) => {
        if (err2) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500);
        res.end("Internal Server Error");
        return;
      }
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    });
  });
}

const httpServer = http.createServer((req, res) => {
  // CORS headers for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // API routes
  if (req.method === "GET" && req.url === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(sessionsSnapshot()));
    return;
  }

  // Static files
  serveStatic(res, req.url);
});

// ---------------------------------------------------------------------------
// WebSocket Server (shared with HTTP)
// ---------------------------------------------------------------------------

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws) => {
  wsClients.add(ws);

  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: "update", sessions: sessionsSnapshot() }));

  ws.on("close", () => {
    wsClients.delete(ws);
  });

  ws.on("error", () => {
    wsClients.delete(ws);
  });
});

// ---------------------------------------------------------------------------
// Unix Domain Socket Server
// ---------------------------------------------------------------------------

function ensureSocketDir() {
  fs.mkdirSync(SOCKET_DIR, { recursive: true });
  // Remove stale socket file if it exists
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // Ignore — file may not exist
  }
}

const unixServer = net.createServer((conn) => {
  let buffer = "";

  conn.on("data", (chunk) => {
    buffer += chunk.toString();

    // Support newline-delimited JSON (one event per line)
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      tryParseAndHandle(line);
    }
  });

  conn.on("end", () => {
    // Handle any remaining data in buffer (no trailing newline)
    const remaining = buffer.trim();
    if (remaining.length > 0) {
      tryParseAndHandle(remaining);
    }
  });

  conn.on("error", (err) => {
    console.error("[unix] connection error:", err.message);
  });
});

function tryParseAndHandle(data) {
  try {
    const evt = JSON.parse(data);
    handleEvent(evt);
  } catch (err) {
    console.error("[unix] invalid JSON:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function printBanner() {
  const banner = `
  ╔══════════════════════════════════════════════╗
  ║                                              ║
  ║   ██╗   ██╗██╗██████╗ ███████╗              ║
  ║   ██║   ██║██║██╔══██╗██╔════╝              ║
  ║   ██║   ██║██║██████╔╝█████╗                ║
  ║   ╚██╗ ██╔╝██║██╔══██╗██╔══╝               ║
  ║    ╚████╔╝ ██║██████╔╝███████╗              ║
  ║     ╚═══╝  ╚═╝╚═════╝ ╚══════╝              ║
  ║                                              ║
  ║   M O N I T O R                              ║
  ║   Dynamic Island for AI Coding Sessions      ║
  ║                                              ║
  ╚══════════════════════════════════════════════╝
`;
  console.log(banner);
}

function start() {
  printBanner();
  ensureSocketDir();

  unixServer.listen(SOCKET_PATH, () => {
    // Make socket accessible
    try {
      fs.chmodSync(SOCKET_PATH, 0o777);
    } catch {
      // Best effort
    }
    console.log(`[unix]  Socket listening on ${SOCKET_PATH}`);
  });

  httpServer.listen(HTTP_PORT, () => {
    console.log(`[http]  Server listening on http://localhost:${HTTP_PORT}`);
    console.log(`[ws]    WebSocket available on ws://localhost:${HTTP_PORT}`);
    console.log(`[api]   GET http://localhost:${HTTP_PORT}/api/sessions`);
    console.log("");
    console.log("Waiting for AI coding sessions...");
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    for (const timer of removalTimers.values()) {
      clearTimeout(timer);
    }
    wss.close();
    httpServer.close();
    unixServer.close(() => {
      try {
        fs.unlinkSync(SOCKET_PATH);
      } catch {
        // Ignore
      }
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Demo mode: inject sample sessions
  if (process.argv.includes("--demo")) {
    injectDemoSessions();
  }
}

function injectDemoSessions() {
  console.log("[demo]  Injecting sample sessions...");

  const demoEvents = [
    {
      session_id: "demo-claude-1",
      hook_event_name: "SessionStart",
      cwd: "/Users/dev/projects/evttosds",
      _source: "claude",
    },
    {
      session_id: "demo-claude-1",
      hook_event_name: "UserPromptSubmit",
      cwd: "/Users/dev/projects/evttosds",
      _source: "claude",
      prompt: "Add retry logic to the RocketMQ consumer with exponential backoff",
    },
    {
      session_id: "demo-claude-1",
      hook_event_name: "PermissionRequest",
      cwd: "/Users/dev/projects/evttosds",
      _source: "claude",
      tool_name: "Bash",
      tool_input: { command: "go test -race ./biz/... && make build" },
    },
    {
      session_id: "demo-codex-1",
      hook_event_name: "SessionStart",
      cwd: "/Users/dev/projects/vibe-monitor",
      _source: "codex",
    },
    {
      session_id: "demo-codex-1",
      hook_event_name: "UserPromptSubmit",
      cwd: "/Users/dev/projects/vibe-monitor",
      _source: "codex",
      prompt: "Create the terminal monitor UI",
    },
    {
      session_id: "demo-codex-1",
      hook_event_name: "PreToolUse",
      cwd: "/Users/dev/projects/vibe-monitor",
      _source: "codex",
      tool_name: "Edit",
    },
    {
      session_id: "demo-gemini-1",
      hook_event_name: "SessionStart",
      cwd: "/Users/dev/projects/miot-spec",
      _source: "gemini",
    },
    {
      session_id: "demo-gemini-1",
      hook_event_name: "UserPromptSubmit",
      cwd: "/Users/dev/projects/miot-spec",
      _source: "gemini",
      prompt: "Refactor the device property parser to support new spec format",
    },
    {
      session_id: "demo-ended-1",
      hook_event_name: "SessionStart",
      cwd: "/Users/dev/projects/device-shadow",
      _source: "claude",
    },
    {
      session_id: "demo-ended-1",
      hook_event_name: "UserPromptSubmit",
      cwd: "/Users/dev/projects/device-shadow",
      _source: "claude",
      prompt: "Run all unit tests",
    },
    {
      session_id: "demo-ended-1",
      hook_event_name: "SessionEnd",
      cwd: "/Users/dev/projects/device-shadow",
      _source: "claude",
    },
  ];

  // Stagger events slightly for realistic timestamps
  demoEvents.forEach((evt, i) => {
    setTimeout(() => handleEvent(evt), i * 100);
  });
}

start();
