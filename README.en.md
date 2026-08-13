<div align="center">

# 🐋 DeepSeek Harness Launcher

**A local launcher for DeepSeek Harness (DSH): start/stop `dsh web` with one click, run headless tasks, view logs — wrapped in a deep-sea console UI.**

English · [中文](README.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-blue.svg)
![Zero Dependency](https://img.shields.io/badge/dependencies-0-brightgreen.svg)
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
- 🧩 **Auto-detects the dsh CLI**: npx cache → global npm install → `npx -y @deepseek-ai/dsh` fallback; fully overridable
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

## Security Notes

- Listens on `127.0.0.1` only.
- Never reads or transmits credentials; config stays local.
- "Force stop" kills whatever holds the port (including a live Harness session) — the UI always asks for confirmation first.

## Tests

Zero-dependency smoke tests (Node built-in `node:test`, never actually spawns dsh):

```bash
npm test
```

Zero-dependency, offline-friendly: no network or real dsh environment required.

## Contributing

PRs and issues are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## 🤖 AI Statement

This project was developed with [DeepSeek Harness](https://www.deepseek.com/harness/).

## License

[MIT](LICENSE) © dsh-launcher contributors
