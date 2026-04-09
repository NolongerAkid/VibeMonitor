"use strict";

const { app, BrowserWindow, Tray, nativeImage, screen, ipcMain, nativeTheme, Notification } = require("electron");
const path = require("path");
const net = require("net");
const fs = require("fs");
const os = require("os");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SOCKET_DIR = path.join(os.homedir(), ".vibe-monitor", "run");
const SOCKET_PATH = path.join(SOCKET_DIR, "monitor.sock");
const COLLAPSED_W = 220;
const COLLAPSED_H = 36;
const EXPANDED_W = 400;
const EXPANDED_H = 580;

// ---------------------------------------------------------------------------
// Session Store (same as server.js but in-process)
// ---------------------------------------------------------------------------
const sessions = new Map();
const removalTimers = new Map();

function createSession(id) {
  return {
    id, agentType: "unknown", status: "waiting_for_input",
    cwd: null, projectName: null, customName: null,
    lastUserPrompt: null, lastAssistantMessage: null,
    currentToolName: null, approval: null, question: null,
    read: false,
    _env: {}, _tty: null, _ppid: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function deriveAgentType(src) {
  if (!src) return "unknown";
  const s = src.toLowerCase();
  if (s.includes("claude")) return "claude";
  if (s.includes("codex") || s.includes("opencode")) return "codex";
  if (s.includes("gemini")) return "gemini";
  if (s.includes("cursor")) return "cursor";
  if (s.includes("copilot")) return "copilot";
  return "unknown";
}

function getOrCreate(id) {
  let s = sessions.get(id);
  if (!s) { s = createSession(id); sessions.set(id, s); }
  return s;
}

function scheduleRemoval(id) {
  const old = removalTimers.get(id);
  if (old) clearTimeout(old);
  const t = setTimeout(() => { sessions.delete(id); removalTimers.delete(id); broadcast(); }, 60000);
  t.unref();
  removalTimers.set(id, t);
}

function handleEvent(evt) {
  const sid = evt.session_id;
  if (!sid) return;
  const s = getOrCreate(sid);
  if (evt.cwd) { s.cwd = evt.cwd; s.projectName = path.basename(evt.cwd); }
  if (evt._source) s.agentType = deriveAgentType(evt._source);
  if (evt._env) s._env = { ...s._env, ...evt._env };
  if (evt._tty) s._tty = evt._tty;
  if (evt._ppid) s._ppid = evt._ppid;
  s.updatedAt = new Date().toISOString();

  // Claude Code hook_event_name mapping
  const hookEvent = evt.hook_event_name || "";

  // Auto-mark as read when session has new activity (except events that explicitly set unread)
  const setsUnread = ["Stop", "PermissionRequest"];
  if (!setsUnread.includes(hookEvent) && !s.read) {
    s.read = true;
  }

  switch (hookEvent) {
    case "SessionStart":
      s.status = "waiting_for_input"; s.startedAt = new Date().toISOString();
      { const old = removalTimers.get(sid); if (old) { clearTimeout(old); removalTimers.delete(sid); } }
      console.log(`[event] SessionStart: ${sid} (${s.projectName || s.cwd})`);
      break;
    case "SessionEnd":
      console.log(`[event] SessionEnd: ${sid}`);
      sessions.delete(sid);
      { const old = removalTimers.get(sid); if (old) { clearTimeout(old); removalTimers.delete(sid); } }
      break;
    case "UserPromptSubmit":
      if (evt.prompt != null) s.lastUserPrompt = evt.prompt;
      s.status = "processing"; s.approval = null; s.question = null; s.read = true;
      break;
    case "PreToolUse":
      if (evt.tool_name) s.currentToolName = evt.tool_name;
      s.status = "running_tool"; break;
    case "PostToolUse":
    case "PostToolUseFailure":
      s.currentToolName = null;
      if (s.status === "running_tool") s.status = "processing";
      break;
    case "PermissionRequest": {
      const inp = evt.tool_input || {};
      const toolName = evt.tool_name || "";
      if (toolName === "AskUserQuestion") {
        // This is a question, not a permission request
        const questions = inp.questions || [];
        s.question = { questions };
        s.status = "question";
        s.read = false;
        const q = questions[0];
        sendNotification(s, "Question", q ? q.question : "Needs your input");
      } else {
        s.approval = { toolName: toolName || null, command: inp.command || null, filePath: inp.file_path || null };
        s.status = "waiting_for_approval";
        s.read = false;
        sendNotification(s, "Needs Approval", `${s.approval.toolName || "Tool"}: ${s.approval.command || s.approval.filePath || ""}`);
      }
      break;
    }
    case "Notification":
      // Claude Code notification - may signal completion
      break;
    case "Stop":
      if (evt.last_assistant_message != null) s.lastAssistantMessage = evt.last_assistant_message;
      s.status = "waiting_for_input"; s.approval = null; s.question = null; s.currentToolName = null;
      s.read = false;
      sendNotification(s, "Completed", s.lastAssistantMessage ? s.lastAssistantMessage.slice(0, 100) : "Task finished");
      break;
    case "PreCompact":
      s.status = "compacting"; break;
    case "SubagentStart":
      s.status = "running_tool"; s.currentToolName = "Agent"; break;
    case "SubagentStop":
      if (s.currentToolName === "Agent") s.currentToolName = null;
      if (s.status === "running_tool") s.status = "processing";
      break;
    case "TaskCompleted":
      // A task in the task list was completed
      break;
    default:
      // Unknown hook event - just update timestamp
      break;
  }
  broadcast();
}

// ---------------------------------------------------------------------------
// Native Notifications
// ---------------------------------------------------------------------------
function sendNotification(session, title, body) {
  const name = session.customName || session.projectName || "Session";
  try {
    const n = new Notification({
      title: `${name} — ${title}`,
      body: body || "",
      silent: false,
    });
    n.on("click", () => {
      session.read = true;
      session.updatedAt = new Date().toISOString();
      broadcast();
      jumpToTerminal(session);
    });
    n.show();
  } catch (err) {
    console.error("[notify] Error:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Unix Socket Server
// ---------------------------------------------------------------------------
let unixServer = null;

function startSocket() {
  fs.mkdirSync(SOCKET_DIR, { recursive: true });
  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  unixServer = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) try { handleEvent(JSON.parse(line)); } catch {}
      }
    });
    conn.on("end", () => {
      const rem = buf.trim();
      if (rem) try { handleEvent(JSON.parse(rem)); } catch {}
    });
    conn.on("error", () => {});
  });

  unixServer.listen(SOCKET_PATH, () => {
    try { fs.chmodSync(SOCKET_PATH, 0o777); } catch {}
    console.log("[socket] Listening on", SOCKET_PATH);
  });
}

// ---------------------------------------------------------------------------
// Broadcast to renderer
// ---------------------------------------------------------------------------
let mainWindow = null;

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sessions-update", Array.from(sessions.values()));
  }
  updateTrayIcon();
}

// ---------------------------------------------------------------------------
// Tray & Window
// ---------------------------------------------------------------------------
let tray = null;
let isExpanded = false;

function createTrayIcon(color) {
  // Create a 32x32 icon programmatically
  const size = 18;
  const canvas = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="9" cy="9" r="7" fill="none" stroke="${color}" stroke-width="1.5"/>
    <circle cx="9" cy="9" r="3" fill="${color}"/>
  </svg>`;
  const img = nativeImage.createFromBuffer(Buffer.from(canvas));
  img.setTemplateImage(false);
  return img;
}

function updateTrayIcon() {
  if (!tray) return;
  const all = Array.from(sessions.values());
  const needsAttention = all.some(s => s.status === "waiting_for_approval" || s.status === "question");
  const hasActive = all.some(s => s.status !== "ended");

  if (needsAttention) {
    tray.setImage(createTrayIcon("#ff9f0a"));
  } else if (hasActive) {
    tray.setImage(createTrayIcon("#34c759"));
  } else {
    tray.setImage(createTrayIcon("#8e8e93"));
  }
}

function getWindowPosition() {
  const displays = screen.getAllDisplays();
  const builtIn = displays.find(d => d.internal) || screen.getPrimaryDisplay();

  const screenW = builtIn.bounds.width;
  const menuBarBottom = builtIn.workArea.y;

  const w = isExpanded ? EXPANDED_W : COLLAPSED_W;
  const h = isExpanded ? EXPANDED_H : COLLAPSED_H;
  const x = builtIn.bounds.x + Math.round(screenW / 2 - w / 2);
  const y = builtIn.bounds.y + Math.max(menuBarBottom - builtIn.bounds.y, 0) + 2;
  return { x, y, w, h };
}

function createWindow() {
  const { x, y, w, h } = getWindowPosition();

  mainWindow = new BrowserWindow({
    x, y, width: w, height: h,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    vibrancy: undefined,
    roundedCorners: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "public", "native.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow.showInactive();
    // Send initial data
    setTimeout(() => broadcast(), 200);
  });

  // Click outside → collapse
  mainWindow.on("blur", () => {
    if (isExpanded) {
      collapsePanel();
    }
  });

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function togglePanel() {
  if (isExpanded) {
    collapsePanel();
  } else {
    expandPanel();
  }
}

function expandPanel() {
  if (isExpanded || !mainWindow) return;
  isExpanded = true;
  const { x, y, w, h } = getWindowPosition();
  mainWindow.setBounds({ x, y, width: w, height: h }, true);
  mainWindow.webContents.send("panel-state", true);
  mainWindow.focus();
}

function collapsePanel() {
  if (!isExpanded || !mainWindow) return;
  isExpanded = false;
  mainWindow.webContents.send("panel-state", false);
  setTimeout(() => {
    if (!isExpanded && mainWindow && !mainWindow.isDestroyed()) {
      const { x, y, w, h } = getWindowPosition();
      mainWindow.setBounds({ x, y, width: w, height: h }, true);
    }
  }, 300);
}

// ---------------------------------------------------------------------------
// New Claude Code Session
// ---------------------------------------------------------------------------
function newClaudeSession() {
  const { execFile } = require("child_process");
  const script = `
    tell application "iTerm"
      activate
      tell current window
        create tab with default profile
        tell current session
          write text "claude"
        end tell
      end tell
    end tell`;
  execFile("osascript", ["-e", script], (err) => {
    if (err) console.error("[new-session] AppleScript error:", err.message);
  });
  collapsePanel();
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------
function setupIPC() {
  ipcMain.on("toggle-panel", () => togglePanel());
  ipcMain.on("collapse-panel", () => collapsePanel());
  ipcMain.on("expand-panel", () => expandPanel());

  ipcMain.on("approval-action", (_, { sessionId, action }) => {
    const s = sessions.get(sessionId);
    if (s) {
      s.approval = null;
      s.status = "processing";
      s.updatedAt = new Date().toISOString();
      broadcast();
    }
  });

  ipcMain.on("jump-to-session", (_, { sessionId }) => {
    const s = sessions.get(sessionId);
    if (s) {
      jumpToTerminal(s);
    }
  });

  ipcMain.on("rename-session", (_, { sessionId, name }) => {
    const s = sessions.get(sessionId);
    if (s) {
      s.customName = name || null;
      s.updatedAt = new Date().toISOString();
      broadcast();
    }
  });

  ipcMain.on("mark-read", (_, { sessionId }) => {
    const s = sessions.get(sessionId);
    if (s) {
      s.read = true;
      s.updatedAt = new Date().toISOString();
      broadcast();
    }
  });

  ipcMain.on("new-session", () => {
    newClaudeSession();
  });

  ipcMain.handle("get-sessions", () => Array.from(sessions.values()));
}

// ---------------------------------------------------------------------------
// Terminal Jumping (AppleScript)
// ---------------------------------------------------------------------------
const JETBRAINS_BUNDLE_MAP = {
  "com.jetbrains.goland": "GoLand",
  "com.jetbrains.intellij": "IntelliJ IDEA",
  "com.jetbrains.intellij.ce": "IntelliJ IDEA CE",
  "com.jetbrains.pycharm": "PyCharm",
  "com.jetbrains.pycharm.ce": "PyCharm CE",
  "com.jetbrains.webstorm": "WebStorm",
  "com.jetbrains.CLion": "CLion",
  "com.jetbrains.rider": "Rider",
  "com.jetbrains.rubymine": "RubyMine",
  "com.jetbrains.phpstorm": "PhpStorm",
  "com.jetbrains.datagrip": "DataGrip",
};

function isJetBrainsEnv(env) {
  const bundleId = env.__CFBundleIdentifier || "";
  const termEmu = env.TERMINAL_EMULATOR || "";
  return bundleId.includes("jetbrains") || termEmu.includes("JetBrains");
}

function getJetBrainsAppName(env) {
  const bundleId = env.__CFBundleIdentifier || "";
  // Try exact match first
  for (const [bid, name] of Object.entries(JETBRAINS_BUNDLE_MAP)) {
    if (bundleId === bid) return name;
  }
  // Try partial match
  for (const [bid, name] of Object.entries(JETBRAINS_BUNDLE_MAP)) {
    if (bundleId.includes(bid.split(".").pop())) return name;
  }
  // Fallback: try to find running JetBrains app
  return "GoLand"; // most likely for this user
}

function jumpToTerminal(session) {
  const { execFile } = require("child_process");
  const env = session._env || {};
  const termProgram = env.TERM_PROGRAM || "";
  const iTermSession = env.ITERM_SESSION_ID || "";

  let script;

  if (termProgram.includes("iTerm") && iTermSession) {
    // ITERM_SESSION_ID format: "w7t0p0:UUID"
    // iTerm2 AppleScript: session id returns "w7t0p0:UUID" (the unique id property)
    // We need to match using "unique ID" which is the UUID part after the colon
    const uuid = iTermSession.includes(":") ? iTermSession.split(":")[1] : iTermSession;
    const fullId = iTermSession; // w7t0p0:UUID

    script = `
      tell application "iTerm"
        activate
        set found to false
        repeat with aWindow in windows
          repeat with aTab in tabs of aWindow
            repeat with aSession in sessions of aTab
              try
                set sid to unique id of aSession
                if sid contains "${uuid}" then
                  select aTab
                  select aSession
                  set index of aWindow to 1
                  set miniaturized of aWindow to false
                  set found to true
                  return
                end if
              end try
            end repeat
          end repeat
        end repeat
        if not found then
          -- Fallback: try matching by session id property
          repeat with aWindow in windows
            repeat with aTab in tabs of aWindow
              repeat with aSession in sessions of aTab
                try
                  set sid to id of aSession
                  if sid is "${fullId}" or sid contains "${uuid}" then
                    select aTab
                    select aSession
                    set index of aWindow to 1
                    set miniaturized of aWindow to false
                    return
                  end if
                end try
              end repeat
            end repeat
          end repeat
        end if
      end tell`;
  } else if (termProgram.includes("iTerm")) {
    script = `
      tell application "iTerm"
        activate
        if (count of windows) > 0 then
          set miniaturized of front window to false
        end if
      end tell`;
  } else if (termProgram === "Apple_Terminal") {
    script = `
      tell application "Terminal"
        activate
        if (count of windows) > 0 then
          set miniaturized of front window to false
        end if
      end tell`;
  } else if (termProgram.includes("vscode") || env.__CFBundleIdentifier === "com.microsoft.VSCode") {
    script = `tell application "Visual Studio Code" to activate`;
  } else if (env.__CFBundleIdentifier === "com.codepilot.app") {
    script = `tell application "Cursor" to activate`;
  } else if (isJetBrainsEnv(env)) {
    const appName = getJetBrainsAppName(env);
    script = `tell application "${appName}" to activate`;
  } else {
    script = `
      try
        tell application "iTerm" to activate
      on error
        tell application "Terminal" to activate
      end try`;
  }

  console.log(`[jump] Jumping to session ${session.id}, ITERM_SESSION_ID=${iTermSession}, TERM_PROGRAM=${termProgram}, __CFBundleIdentifier=${env.__CFBundleIdentifier || ""}, TERMINAL_EMULATOR=${env.TERMINAL_EMULATOR || ""}`);
  execFile("osascript", ["-e", script], (err, stdout, stderr) => {
    if (err) console.error("[jump] AppleScript error:", err.message);
    if (stderr) console.error("[jump] AppleScript stderr:", stderr);
  });

  collapsePanel();
}

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------
function injectDemo() {
  console.log("[demo] Injecting sample sessions...");
  const events = [
    { session_id: "demo-1", hook_event_name: "SessionStart", cwd: "/Users/dev/evttosds", _source: "claude", _env: { TERM_PROGRAM: "iTerm.app" } },
    { session_id: "demo-1", hook_event_name: "UserPromptSubmit", cwd: "/Users/dev/evttosds", _source: "claude", prompt: "Add retry logic to RocketMQ consumer with exponential backoff" },
    { session_id: "demo-1", hook_event_name: "PermissionRequest", cwd: "/Users/dev/evttosds", _source: "claude", tool_name: "Bash", tool_input: { command: "go test -race ./biz/... && make build" } },
    { session_id: "demo-2", hook_event_name: "SessionStart", cwd: "/Users/dev/vibe-monitor", _source: "codex", _env: { TERM_PROGRAM: "iTerm.app" } },
    { session_id: "demo-2", hook_event_name: "UserPromptSubmit", cwd: "/Users/dev/vibe-monitor", _source: "codex", prompt: "Build the terminal monitor UI" },
    { session_id: "demo-2", hook_event_name: "PreToolUse", cwd: "/Users/dev/vibe-monitor", _source: "codex", tool_name: "Edit" },
    { session_id: "demo-3", hook_event_name: "SessionStart", cwd: "/Users/dev/miot-spec", _source: "gemini", _env: { TERM_PROGRAM: "iTerm.app" } },
    { session_id: "demo-3", hook_event_name: "UserPromptSubmit", cwd: "/Users/dev/miot-spec", _source: "gemini", prompt: "Refactor property parser for new spec format" },
  ];
  events.forEach((e, i) => setTimeout(() => handleEvent(e), i * 80));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.dock.hide(); // No dock icon — menu bar only (like Vibe Island)

app.whenReady().then(() => {
  // Tray icon
  tray = new Tray(createTrayIcon("#8e8e93"));
  tray.setToolTip("Vibe Monitor");
  tray.on("click", () => togglePanel());

  setupIPC();
  startSocket();
  createWindow();

  if (process.argv.includes("--demo")) {
    injectDemo();
  }

  console.log("[app] Vibe Monitor running");
});

app.on("will-quit", () => {
  if (unixServer) unixServer.close();
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
});

app.on("window-all-closed", (e) => e.preventDefault()); // Keep running in tray
