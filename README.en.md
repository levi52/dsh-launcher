<div align="center">

# 🐋 DeepSeek Harness Launcher

**A local launcher for DeepSeek Harness (DSH): start/stop `dsh web` with one click, run headless tasks, view logs — wrapped in a deep-sea console UI.**

English · [中文](README.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-blue.svg)
![Zero Dependency](https://img.shields.io/badge/dependencies-0-brightgreen.svg)
[![CI](https://img.shields.io/github/actions/workflow/status/levi52/dsh-launcher/ci.yml?label=CI)](https://github.com/levi52/dsh-launcher/actions)
[![Developed with DeepSeek Harness](https://img.shields.io/badge/Built%20with-DeepSeek%20Harness-4d6bfe.svg)](https://www.deepseek.com/harness/)

</div>

![Launcher UI preview](docs/preview.svg)


---

## Features

- 🚀 **One-click start/stop**: spawns `dsh web` as a child process (`--profile web --port <port> --host <host>`), kills the whole process tree on stop; auto-opens the browser once ready
- 🟢 **Live status**: online / offline / booting / stopping beacon, plus PID, port, DSH version, DSH_HOME and profiles at a glance
- 📡 **Logs**: SSE streaming of stdout/stderr, terminal-style rendering with ANSI colors, auto-scroll and clear
- ⚡ **Quick tasks**: run one-shot persistent sessions via `dsh --profile headless "<task>"`, with live output, exit code, and cancellation
- ☰ **Session browser**: lists workspaces under `$DSH_HOME/sessions`, opens any folder in your file explorer
- ⛔ **Force stop**: "Stop" only affects processes the launcher spawned itself; "Force kill port owner" finds and terminates whatever holds the Web UI port (with confirmation)
- 🧩 **Auto-detects the dsh CLI**: global npm install → npx cache → `npx -y @deepseek-ai/dsh` fallback; fully overridable
- 🔁 **Multi-instance adoption**: launcher instances share a claims registry (`$DSH_HOME/dsh-launcher/claims.json`) to identify who started the Web UI; another instance can take over ("Adopt") and then stop it normally
- 🔔 **Install & update check**: shows whether dsh is installed and its source (npx cache / global install), compares against the npm registry latest version (1h cache), highlights new versions, one-click manual re-check
- 🔒 **Local by design**: binds to `127.0.0.1` only, never touches credentials, config stays on your machine

## Quick Start

### Requirements

- **Node.js ≥ 18** (developed on v22)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) available locally or via npx (`@deepseek-ai/dsh`)

### Run

```bash
git clone https://github.com/levi52/dsh-launcher.git
cd dsh-launcher
npm start
```

The console opens automatically at <http://127.0.0.1:3090>. On Windows you can also double-click `start-launcher.bat`; run `create-desktop-shortcut.bat` to add a desktop shortcut with the whale icon (`public/favicon.ico`).

## UI

| Area | Description |
|---|---|
| **System Status** | Web UI online status (with latency), PID / port / workspace / start time, DSH version / Node / DSH_HOME / profiles |
| **Start / Stop** | Start or stop `dsh web`; "Force kill port owner" closes instances the launcher did not start; the "Shut down launcher" button in the top bar exits the backend |
| **Logs** | Main output stream: all stdout/stderr of dsh web and headless tasks |
| **Quick Tasks** | Run/cancel headless tasks in a dedicated output panel |
| **Sessions** | Workspace session list (name / path / last activity / count), open the folder in your file explorer |
| **Settings** | Web UI port & host, workspace, dsh CLI entry, DSH_HOME override, auto-open browser; the "Found dsh installs" list shows every dsh on the machine (global / npx cache) with the active one marked |
| **Themes** | Switch in the top bar: Deep Sea (default dark) / Neo-Brutalism / Claude; your choice is saved in the browser |

## Configuration

`launcher-config.json` in the launcher directory (created on first save, gitignored) or the in-app **Settings** tab:

```jsonc
{
  "guiHost": "127.0.0.1",   // Web UI bind host ("0.0.0.0" is rejected by dsh for safety)
  "guiPort": 3080,          // Web UI port
  "workspace": "",          // working directory for dsh (empty = launcher dir)
  "dshCommand": "",         // dsh CLI entry (empty = auto-detect)
  "dshHome": "",            // DSH_HOME override (empty = inherit env)
  "autoOpenGui": true       // open the browser once the Web UI responds
}
```

Launcher port: `node launcher.js --port 3100` or `DSH_LAUNCHER_PORT` (default 3090; falls back to a free port when busy).

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/state` | Full state snapshot |
| GET | `/api/events` | SSE stream (`state` / `line` / `headless-start` / `headless-result`) |
| GET | `/api/logs?since=<ms>` | Historical logs |
| POST | `/api/start` | Start dsh web (`{ port? }`) |
| POST | `/api/stop` | Stop the dsh web the launcher spawned |
| POST | `/api/adopt` | Take over a dsh web managed by another launcher instance (then it can be stopped) |
| POST | `/api/force-stop` | Find and kill the process holding a port (`{ port? }` → `{ killed: [pid] }`) |
| POST | `/api/headless` | Run a headless task (`{ task }`) |
| POST | `/api/headless-cancel` | Cancel the running headless task |
| POST | `/api/open-gui` | Open the Web UI in a browser |
| POST | `/api/explore` | Open a path in the file explorer (`{ path }`) |
| POST | `/api/save-config` | Persist configuration |
| POST | `/api/shutdown` | Shut down the launcher backend (stops the dsh web it spawned, releases claims, then exits) |
| POST | `/api/check-update` | Force a dsh update check (returns `{ latest, installed, installedVersion, updateAvailable }`) |

## How It Works

- **dsh CLI detection**: uses the configured `dshCommand` first, then scans global npm installs and the npx cache (`%LOCALAPPDATA%\npm-cache\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js`); finally falls back to `npx -y @deepseek-ai/dsh` (requires network). Global installs win so the launcher matches the `dsh` command in your terminal. Local `bin.js` entries are executed with the current Node runtime.
- **Port in use**: if the target port is already occupied by a process the launcher did not spawn, it reports "Web UI appears to be running" and opens the UI instead of stealing the port.
- **Stop semantics**: "Stop" only affects processes the launcher spawned itself (safe by design). If the Web UI is online but was started another way (another instance, npx, or manually), click "Adopt" first to take control and then stop it (with a claims record it takes over that instance; without one it tracks the port-owning process). If you do not want to adopt, use "Force kill port owner".
- **Shutdown behavior**: clicking "Shut down launcher" (or Ctrl+C) stops the dsh web it spawned and releases claims; adopted processes keep running. Closing the terminal window directly ends the child processes with it — stop the service first.

## Security Notes

- Listens on `127.0.0.1` only.
- Never reads or transmits credentials; config stays local.
- "Force stop" kills whatever holds the port (including a live Harness session) — the UI always asks for confirmation first.
- The update check only queries the public version number from the npm registry; nothing local is uploaded.

## Updating dsh

Once a new version is found, update according to your install source:

```bash
# Global install
npm i -g @deepseek-ai/dsh@latest
# npx on-demand (clear the cache to force the latest)
npx -y @deepseek-ai/dsh@latest web
```

**dsh not installed?** When the launcher detects no local dsh it shows an "Install dsh" button — one click runs `npm i -g @deepseek-ai/dsh@latest` with live output in the log panel, then re-detects automatically. You can also just click "Start" directly: the launcher will pull dsh on demand via npx, no prior install needed.

**Want to uninstall dsh?** The launcher deliberately has no uninstall button (uninstalling would break the tool's own dependency). Do it manually:

```bash
# Remove the global install
npm uninstall -g @deepseek-ai/dsh
```

- After removing the global install, the launcher automatically falls back to the npx cache (if any) or on-demand npx pull — no extra configuration needed.
- **npx cache leftovers (optional cleanup):** ⚠ each `_npx\<hash>\node_modules` may also cache other packages; deleting a whole hash directory can break other tools. Keep them, or clear the npm cache entirely (`npm cache clean --force`) only when you are sure; the next "Start" re-downloads automatically.

## Tests

Zero-dependency smoke tests (Node built-in `node:test`, never actually spawns dsh):

```bash
npm test
```

Zero-dependency, offline-friendly: no network or real dsh environment required.

## 🤖 AI Statement

This project was developed with [DeepSeek Harness](https://www.deepseek.com/harness/).

## License

[MIT](LICENSE) © dsh-launcher contributors
