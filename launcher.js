#!/usr/bin/env node
/**
 * DeepSeek Harness 启动器 —— 零依赖 Node 后端
 *
 * 职责：
 *  - 探测 DSH Web GUI（默认 http://127.0.0.1:3080）是否在线
 *  - 启动 / 停止 `dsh web`（通过 dsh CLI 的 bin.js 以子进程方式拉起）
 *  - 运行一次性 headless 任务（`dsh --profile headless "<task>"`）并流式输出
 *  - 通过 SSE 向前端推送日志与状态快照
 *  - 打开资源管理器 / 浏览器、读写本地配置（launcher-config.json）
 *
 * 用法：node launcher.js [--port 3090]
 */
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER_VERSION = "1.0.0";
const DEFAULT_PORT = 3090;

/* ------------------------------------------------------------------ */
/* 配置                                                               */
/* ------------------------------------------------------------------ */

const CONFIG_PATH = path.join(__dirname, "launcher-config.json");

const DEFAULT_CONFIG = {
  guiHost: "127.0.0.1",   // DSH GUI 监听地址
  guiPort: 3080,          // DSH GUI 端口
  workspace: "",          // dsh 启动时的工作目录（空 = 启动器所在目录）
  dshCommand: "",         // dsh CLI 入口（留空自动探测）
  dshHome: "",            // DSH_HOME 覆盖（留空继承系统环境变量）
  autoOpenGui: true,      // 启动成功后自动打开浏览器
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

let config = loadConfig();
if (!config.workspace) config.workspace = __dirname;

function persistConfig(patch) {
  config = { ...config, ...patch };
  if (!config.workspace) config.workspace = __dirname;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  return config;
}

/* ------------------------------------------------------------------ */
/* dsh CLI 探测                                                       */
/* ------------------------------------------------------------------ */

function npxCacheDirs() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const root = path.join(local, "npm-cache", "_npx");
  try {
    return fs.readdirSync(root).map((d) => path.join(root, d));
  } catch {
    return [];
  }
}

/** 解析 dsh CLI 入口：返回 bin 与来源（config / global-npm / npx-cache / none） */
function resolveDsh() {
  if (config.dshCommand && config.dshCommand.trim()) {
    return { bin: config.dshCommand.trim(), source: "config" };
  }
  const candidates = [];
  // 1) 全局 npm 安装（用户主动安装的版本优先，与终端 dsh 命令保持一致）
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  candidates.push({ bin: path.join(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), source: "global-npm" });
  candidates.push({ bin: path.join(os.homedir(), ".npm-global", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), source: "global-npm" });
  // 2) npx 缓存中的 @deepseek-ai/dsh（按需拉取的副本）
  for (const dir of npxCacheDirs()) {
    candidates.push({ bin: path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), source: "npx-cache" });
  }
  for (const c of candidates) {
    if (fs.existsSync(c.bin)) return c;
  }
  // 3) 兜底：通过 npx 临时拉取（需要网络）
  return { bin: "npx -y @deepseek-ai/dsh", source: "none" };
}

const dshResolved = resolveDsh();
let dshBin = dshResolved.bin;
let dshSource = dshResolved.source;

/** 枚举电脑上发现的所有 dsh 安装（全局 / npx 缓存 / 自定义指定），标注当前使用的 */
function findAllDshInstalls() {
  const found = [];
  const seen = new Set();
  const add = (bin, source) => {
    if (!bin || seen.has(bin)) return;
    if (!fs.existsSync(bin)) return;   // 只列真实存在的安装
    seen.add(bin);
    found.push({
      bin,
      source,
      version: readDshVersion(bin),
      inUse: bin === dshBin,
    });
  };
  // 1) 用户配置指定的入口
  if (config.dshCommand && config.dshCommand.trim()) add(config.dshCommand.trim(), "config");
  // 2) 全局 npm 安装
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  add(path.join(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "global-npm");
  add(path.join(os.homedir(), ".npm-global", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "global-npm");
  // 3) npx 缓存（每个 _npx 目录可能对应不同版本）
  for (const dir of npxCacheDirs()) {
    add(path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "npx-cache");
  }
  return found;
}

function readDshVersion(bin) {
  try {
    if (!path.isAbsolute(bin)) return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(bin), "..", "package.json"), "utf8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* dsh 更新检查（npm registry）                                        */
/* ------------------------------------------------------------------ */

const UPDATE_TTL_MS = 60 * 60 * 1000;   // 自动检查结果缓存 1 小时
const NPM_REGISTRY = process.env.DSH_NPM_REGISTRY || "https://registry.npmjs.org";
let dshLatestCache = null;              // { version, checkedAt }

/** 极简 semver 解析：major.minor.patch[-pre] */
function parseVersion(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : null };
}

/** semver 比较：a<b → -1，相等 → 0，a>b → 1 */
function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;   // 正式版 > 预发布版
  if (!b.pre) return -1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return +x < +y ? -1 : 1;
    if (xn) return -1;   // 数字段 < 字母段
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

async function fetchDshLatest() {
  try {
    const r = await fetch(`${NPM_REGISTRY}/@deepseek-ai/dsh/latest`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    return String(data.version || "") || null;
  } catch {
    return null;   // 离线或 registry 不可达：保持未知
  }
}

/** 查询最新版本（带 TTL 缓存）；force=true 强制刷新 */
async function checkDshUpdate(force = false) {
  if (!force && dshLatestCache && Date.now() - dshLatestCache.checkedAt < UPDATE_TTL_MS) {
    return dshLatestCache.version;
  }
  const version = await fetchDshLatest();
  dshLatestCache = { version, checkedAt: Date.now() };
  return version;
}

/* ------------------------------------------------------------------ */
/* 一键安装 dsh（全局 npm 安装）                                       */
/* ------------------------------------------------------------------ */

let installingDsh = false;

/** 通过 npm 全局安装 @deepseek-ai/dsh；输出实时进入日志面板 */
function installDsh() {
  if (installingDsh) return { ok: false, code: "busy", message: "安装正在进行中" };
  if (isChildRunning()) return { ok: false, code: "busy", message: "请先停止正在运行的 dsh web 再安装" };
  installingDsh = true;
  pushLog("sys", "[安装] 开始全局安装 @deepseek-ai/dsh（npm i -g @deepseek-ai/dsh@latest）...");
  pushLog("sys", "[安装] 需要网络；安装完成后将自动重新识别");
  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  let proc;
  try {
    proc = spawn(cmd, ["i", "-g", "@deepseek-ai/dsh@latest"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
  } catch (err) {
    installingDsh = false;
    pushLog("sys", `[错误] 无法执行 npm：${err.message}`);
    broadcastState();
    return { ok: false, code: "spawn-failed", message: err.message };
  }
  proc.stdout.on("data", (d) => pushLog("out", d.toString()));
  proc.stderr.on("data", (d) => pushLog("err", d.toString()));
  proc.on("error", (err) => {
    installingDsh = false;
    pushLog("sys", `[错误] npm 执行失败：${err.message}`);
    broadcastState();
  });
  proc.on("exit", (code) => {
    installingDsh = false;
    if (code === 0) {
      const resolved = resolveDsh();
      dshBin = resolved.bin;
      dshSource = resolved.source;
      pushLog("sys", `[安装] 完成！dsh 已就绪：${dshBin}`);
      checkDshUpdate(true).then(() => broadcastState()).catch(() => broadcastState());
    } else {
      pushLog("sys", `[安装] 失败，退出码 ${code}（请检查网络与 npm 配置后重试）`);
      broadcastState();
    }
  });
  broadcastState();
  return { ok: true };
}

/** 把可能含参数的命令串拆成 [cmd, ...args]（仅处理简单引号场景） */
function splitCommand(cmd) {
  const m = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return m.map((s) => s.replace(/^["']|["']$/g, ""));
}

/* ------------------------------------------------------------------ */
/* 插件管理（转发 dsh plugin → pnpm）                                  */
/* ------------------------------------------------------------------ */

let pluginBusy = false;

function profileDir(name) {
  return path.join(dshHomeResolved(), "profiles", name);
}

/** 读取某 profile 的已装插件：package.json 依赖 + dsh.profile.bundles 激活状态 */
function readProfilePlugins(profile) {
  const dir = profileDir(profile);
  const result = { profile, dir, initialized: false, bundles: [], plugins: [] };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    result.initialized = true;
    result.bundles = pkg.dsh?.profile?.bundles || [];
    const deps = pkg.dependencies || {};
    result.plugins = Object.keys(deps).map((name) => {
      let version = null;
      let isBundle = false;
      try {
        const depPkg = JSON.parse(fs.readFileSync(path.join(dir, "node_modules", name, "package.json"), "utf8"));
        version = depPkg.version || null;
        isBundle = !!depPkg.dsh?.bundle?.patch;
      } catch { /* link 目标缺失等：保持未知 */ }
      return { name, spec: deps[name], version, isBundle, active: result.bundles.includes(name) };
    });
  } catch { /* profile 未初始化 */ }
  return result;
}

/** 运行一次 dsh plugin 操作（add/remove 等），输出实时进日志面板 */
function runPluginOp(profile, args) {
  if (pluginBusy) return { ok: false, code: "busy", message: "已有插件操作在进行中" };
  pluginBusy = true;
  const action = args[0];
  const target = args[1] || "";
  const label = action === "add" ? "安装" : action === "remove" ? "卸载" : "操作";
  pushLog("sys", `[插件] ${label} ${target} → profile "${profile}"（需 pnpm 在 PATH）`);
  const [cmd, ...rest] = splitCommand(dshBin);
  const isNodeScript = /\.js$/i.test(cmd) && path.isAbsolute(cmd);
  const executable = isNodeScript ? process.execPath : cmd;
  const fullArgs = isNodeScript
    ? [cmd, ...rest, "plugin", "--profile", profile, ...args]
    : [...rest, "plugin", "--profile", profile, ...args];
  let proc;
  try {
    proc = spawn(executable, fullArgs, {
      cwd: config.workspace,
      env: { ...process.env },
      windowsHide: false,
      shell: !isNodeScript && process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    pluginBusy = false;
    pushLog("sys", `[插件] 执行失败：${err.message}`);
    broadcastState();
    return { ok: false, code: "spawn-failed", message: err.message };
  }
  proc.stdout.on("data", (d) => pushLog("out", d.toString()));
  proc.stderr.on("data", (d) => pushLog("err", d.toString()));
  proc.on("error", (err) => {
    pluginBusy = false;
    pushLog("sys", `[插件] 执行失败：${err.message}`);
    broadcastState();
  });
  proc.on("exit", (code) => {
    pluginBusy = false;
    pushLog("sys", `[插件] ${label}结束（退出码 ${code}${code !== 0 ? "，请查看上方错误输出" : "，插件列表已刷新"}）`);
    broadcastState();
  });
  broadcastState();
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 日志环形缓冲 + SSE 广播                                            */
/* ------------------------------------------------------------------ */

const logRing = [];                 // { t, stream: "sys"|"out"|"err", text }
const sseClients = new Set();

/* 日志落盘（launcher.log，已 gitignore；超过 2MB 轮转为 .old） */
const LOG_FILE = path.join(__dirname, "launcher.log");
const LOG_FILE_MAX = 2 * 1024 * 1024;
let logWriteCount = 0;
function appendLogFile(entry, tag) {
  try {
    if (++logWriteCount % 500 === 0) {
      const st = fs.statSync(LOG_FILE, { throwIfNoEntry: false });
      if (st && st.size > LOG_FILE_MAX) {
        fs.renameSync(LOG_FILE, LOG_FILE + ".old");
      }
    }
    fs.appendFileSync(LOG_FILE, `[${fmtTime(entry.t)}] ${tag} ${entry.text}\n`, "utf8");
  } catch { /* 磁盘异常时忽略，不影响运行 */ }
}

function fmtTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function pushLog(stream, text) {
  for (const line of String(text).replace(/\r\n/g, "\n").split("\n")) {
    if (!line) continue;
    const entry = { t: Date.now(), stream, text: line };
    logRing.push(entry);
    if (logRing.length > 3000) logRing.shift();
    const tag = { sys: "SYS", out: "OUT", err: "ERR" }[stream] || "···";
    console.log(`[${fmtTime(entry.t)}] ${tag} ${line}`);   // 控制台实时回声
    appendLogFile(entry, tag);                             // 落盘持久化
    broadcast("line", entry);
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* 连接已断 */ }
  }
}

function heartbeat() {
  for (const res of sseClients) {
    try { res.write(": ping\n\n"); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* 子进程管理：dsh web                                                */
/* ------------------------------------------------------------------ */

let child = null;      // { proc|null, pid, port, startedAt, profile, adopted }
let stopping = false;
let headlessRun = null;

/** 是否正管理着一个 dsh web 进程（自己拉起的或从其他实例接管的） */
function isChildRunning() {
  if (!child) return false;
  if (child.adopted) return true;                 // 接管进程：视为运行中，直到显式停止
  return child.proc.exitCode === null;
}

function spawnDsh(args, onExit) {
  // 命令串可能是 dsh 的 bin.js 完整路径，也可能是 "npx -y @deepseek-ai/dsh" 或用户自定义命令
  const [cmd, ...rest] = splitCommand(dshBin);
  // 若解析到的是本地 node 脚本（bin.js），用当前 Node 解释器执行；否则直接执行命令（Windows 上 .cmd 需 shell）
  const isNodeScript = /\.js$/i.test(cmd) && path.isAbsolute(cmd);
  const executable = isNodeScript ? process.execPath : cmd;
  const fullArgs = isNodeScript ? [cmd, ...rest, ...args] : [...rest, ...args];
  const env = { ...process.env };
  if (config.dshHome && config.dshHome.trim()) env.DSH_HOME = config.dshHome.trim();
  const proc = spawn(executable, fullArgs, {
    cwd: config.workspace,
    env,
    windowsHide: false,
    shell: !isNodeScript && process.platform === "win32", // 兼容 npx.cmd / dsh.cmd
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => pushLog("out", d.toString()));
  proc.stderr.on("data", (d) => pushLog("err", d.toString()));
  proc.on("error", (err) => {
    pushLog("sys", `[错误] 无法启动进程：${err.message}`);
    onExit && onExit(-1, null);
  });
  proc.on("exit", (code, sig) => {
    pushLog("sys", `[退出] 进程结束 code=${code}${sig ? ` sig=${sig}` : ""}`);
    onExit && onExit(code, sig);
  });
  return proc;
}

function startDshWeb(port) {
  if (isChildRunning()) {
    return { ok: false, code: "already-running", message: "dsh web 已在运行中" };
  }
  stopping = false;
  const proc = spawnDsh(["--profile", "web", "--port", String(port), "--host", config.guiHost], (code) => {
    if (child && child.proc === proc) {
      const wasStopping = stopping;
      releaseClaim(port);
      child = null;
      stopping = false;
      // 非用户主动停止的异常退出 → 通知前端弹 toast
      if (!wasStopping) {
        broadcast("child-exited", { pid: proc.pid, code });
        pushLog("sys", `[警告] dsh web 异常退出（code=${code}）`);
      }
      broadcastState();
    }
  });
  child = { proc, pid: proc.pid, port, startedAt: new Date().toISOString(), profile: "web", adopted: false };
  claimPort(port, proc.pid, config.workspace);
  if (dshSource === "none") {
    pushLog("sys", "[提示] 未检测到本机安装的 dsh，将通过 npx 按需拉取（首次需要联网下载，可能较慢）");
  }
  pushLog("sys", `[启动] dsh web  · pid=${proc.pid} · port=${port} · host=${config.guiHost} · cwd=${config.workspace}`);
  pushLog("sys", `[启动] 命令: node ${dshBin} --profile web --port ${port} --host ${config.guiHost}`);
  broadcastState();
  if (config.autoOpenGui) watchGuiReady(port);
  return { ok: true, pid: proc.pid };
}

let guiWatcher = null;
function watchGuiReady(port) {
  clearInterval(guiWatcher);
  const tracked = child?.proc;
  if (!tracked) return;
  let tries = 0;
  guiWatcher = setInterval(async () => {
    // 被跟踪的子进程已退出或被替换：停止等待
    if (!child || child.proc !== tracked || tracked.exitCode !== null) {
      clearInterval(guiWatcher);
      guiWatcher = null;
      return;
    }
    const p = await probeGui(port);
    if (p.online) {
      clearInterval(guiWatcher);
      guiWatcher = null;
      pushLog("sys", `[就绪] GUI 已响应，自动打开浏览器 ${p.url}`);
      openBrowser(p.url);
      broadcastState();
    } else if (++tries > 40) {
      clearInterval(guiWatcher);
      guiWatcher = null;
      pushLog("sys", "[警告] 等待 GUI 就绪超时，请手动打开界面");
    }
  }, 1500);
}

function stopDshWeb(port) {
  if (!isChildRunning()) return { ok: false, code: "not-running", message: "没有由启动器拉起的 dsh web 进程" };
  const targetPort = port ?? child.port ?? config.guiPort;
  const pid = child.pid;
  stopping = true;
  pushLog("sys", `[停止] 正在终止 dsh web (pid=${pid}) ...`);
  if (process.platform === "win32") {
    spawnSystem("taskkill", ["/pid", String(pid), "/T", "/F"], "taskkill(dsh web)");
  } else if (child.proc) {
    child.proc.kill("SIGTERM");
    setTimeout(() => { try { child.proc.kill("SIGKILL"); } catch { /* 已退出 */ } }, 3000);
  } else {
    try { process.kill(pid, "SIGTERM"); } catch { /* 已退出 */ }
    setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ } }, 3000);
  }
  // 所有权立即移交；自己拉起的进程退出时 exit 处理器会兜底清理
  releaseClaim(targetPort);
  if (child.adopted) {
    child = null;
    stopping = false;
  }
  broadcastState();
  return { ok: true };
}

/** 取消正在运行的 headless 任务 */
function cancelHeadless() {
  if (!headlessRun || headlessRun.proc.exitCode !== null) {
    return { ok: false, code: "idle", message: "没有运行中的 headless 任务" };
  }
  const proc = headlessRun.proc;
  pushLog("sys", `[任务] 正在取消 headless (pid=${proc.pid}) ...`);
  if (process.platform === "win32") {
    spawnSystem("taskkill", ["/pid", String(proc.pid), "/T", "/F"], "taskkill(headless)");
  } else {
    proc.kill("SIGTERM");
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* 已退出 */ } }, 3000);
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 跨实例所有权登记（claims）                                          */
/* 多个启动器实例共享 $DSH_HOME/dsh-launcher/claims.json：             */
/* 每个实例启动 dsh web 时登记「端口 → 本实例PID + dshPID」，           */
/* 其他实例据此识别管理者，并可「接管」后停止该进程。                  */
/* ------------------------------------------------------------------ */

function claimsPath() {
  return path.join(dshHomeResolved(), "dsh-launcher", "claims.json");
}

function readClaims() {
  try {
    return JSON.parse(fs.readFileSync(claimsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeClaims(claims) {
  try {
    const dir = path.dirname(claimsPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(claimsPath(), JSON.stringify(claims, null, 2), "utf8");
  } catch (err) {
    pushLog("sys", `[警告] 无法写入所有权登记：${err.message}`);
  }
}

/** 进程是否存活（信号 0 探测：仅检查存在性，不发送任何信号，跨平台安全） */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claimPort(port, dshPid, workspace) {
  const claims = readClaims();
  claims[String(port)] = {
    launcherPid: process.pid,
    dshPid,
    startedAt: new Date().toISOString(),
    workspace: workspace || config.workspace,
    launcherVersion: LAUNCHER_VERSION,
  };
  writeClaims(claims);
}

function releaseClaim(port) {
  const claims = readClaims();
  const claim = claims[String(port)];
  if (claim && claim.launcherPid === process.pid) {
    delete claims[String(port)];
    writeClaims(claims);
  }
}

/** 释放本实例持有的全部登记（进程退出时调用） */
function releaseOwnClaims() {
  const claims = readClaims();
  let changed = false;
  for (const [port, claim] of Object.entries(claims)) {
    if (claim.launcherPid === process.pid) {
      delete claims[port];
      changed = true;
    }
  }
  if (changed) writeClaims(claims);
}

/** 清理陈旧登记：登记方已退出或 dsh 进程已死则移除 */
async function cleanupStaleClaims() {
  const claims = readClaims();
  let changed = false;
  for (const [port, claim] of Object.entries(claims)) {
    const launcherAlive = claim.launcherPid === process.pid || (await isProcessAlive(claim.launcherPid));
    const dshAlive = await isProcessAlive(claim.dshPid);
    if (!launcherAlive || !dshAlive) {
      delete claims[port];
      changed = true;
    }
  }
  if (changed) writeClaims(claims);
}

/* ------------------------------------------------------------------ */
/* 强制停止：查找占用端口的进程并终止                                   */
/* ------------------------------------------------------------------ */

const execFileP = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : -1) : 0,
        out: String(stdout || "") + String(stderr || ""),
      });
    });
  });

/** 运行系统命令并记录失败（taskkill 等关键操作使用，失败时写入日志便于排查） */
function spawnSystem(cmd, args, label) {
  let child;
  try {
    child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (err) {
    // spawn 可能同步抛错（如受限环境禁止管道 stdio）；记录并继续，不让调用方中断
    pushLog("sys", `[错误] ${label} 执行失败：${err.message}`);
    return;
  }
  child.on("error", (err) => pushLog("sys", `[错误] ${label} 执行失败：${err.message}`));
  child.on("exit", (code) => {
    if (code !== 0) pushLog("sys", `[警告] ${label} 非零退出码 ${code}（可能权限不足或进程已退出）`);
  });
  child.unref();
}

/** 查找监听指定端口的 PID 列表（Windows: netstat；macOS/Linux: lsof） */
async function findPidsByPort(port) {
  const pids = new Set();
  try {
    if (process.platform === "win32") {
      const { out } = await execFileP("netstat", ["-ano", "-p", "tcp"]);
      const re = new RegExp(`(:${port}$|\\]:${port}$)`, "i");
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5 || parts[0] !== "TCP") continue;
        const [, local, , state, pid] = parts;
        if (!/LISTENING/i.test(state)) continue;
        if (!re.test(local)) continue;
        const n = Number(pid);
        if (Number.isInteger(n) && n > 0) pids.add(n);
      }
    } else {
      const { out } = await execFileP("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
      for (const pid of out.split(/\s+/)) {
        const n = Number(pid);
        if (Number.isInteger(n) && n > 0) pids.add(n);
      }
    }
  } catch { /* 保持空集 */ }
  return [...pids];
}

/** 强制终止 PID 列表（Windows 用 taskkill 整树；其他平台 SIGKILL） */
async function killPids(pids) {
  if (process.platform === "win32") {
    const results = await Promise.all(pids.map((pid) => execFileP("taskkill", ["/pid", String(pid), "/T", "/F"])));
    for (let i = 0; i < pids.length; i++) {
      if (results[i].code !== 0) {
        const first = results[i].out.trim().split("\n")[0];
        pushLog("sys", `[警告] taskkill 未能终止 pid=${pids[i]}${first ? `：${first}` : ""}`);
      }
    }
  } else {
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
    }
  }
}

function runHeadless(task) {
  if (headlessRun && headlessRun.proc.exitCode === null) {
    return { ok: false, code: "busy", message: "已有一个 headless 任务在运行" };
  }
  headlessRun = { proc: null, task, startedAt: new Date().toISOString(), exitCode: null };
  pushLog("sys", `[任务] 启动 headless 会话`);
  pushLog("sys", `[任务] 命令: node ${dshBin} --profile headless ${JSON.stringify(task)}`);
  const proc = spawnDsh(["--profile", "headless", task], (code) => {
    if (headlessRun && headlessRun.proc === proc) {
      headlessRun.exitCode = code;
      broadcast("headless-result", { task, exitCode: code, finishedAt: new Date().toISOString() });
    }
  });
  headlessRun.proc = proc;
  broadcast("headless-start", { task, pid: proc.pid });
  return { ok: true, pid: proc.pid };
}

/* ------------------------------------------------------------------ */
/* 原生文件夹选择对话框（Windows: COM BrowseForFolder；macOS: osascript；Linux: zenity） */
/* ------------------------------------------------------------------ */

let pickBusy = false;
let pickShell = null;   // Windows 选择器宿主：pwsh（快）或 powershell.exe（兜底）

function pickFolder() {
  if (pickBusy) return Promise.resolve({ ok: false, code: "busy", message: "已有一个文件夹选择对话框" });
  pickBusy = true;
  return new Promise((resolve) => {
    let cmd, args;
    if (process.platform === "win32") {
      // 优先 pwsh（PowerShell 7 冷启动远快于 5.1）；找不到再回退 powershell.exe
      if (pickShell === null) {
        try {
          pickShell = spawnSync("where", ["pwsh"], { encoding: "utf8", windowsHide: true }).status === 0 ? "pwsh" : "powershell.exe";
        } catch {
          pickShell = "powershell.exe";
        }
      }
      cmd = pickShell;
      // COM 文件夹选择器：不依赖 STA；0x41 = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE（现代风格对话框）
      args = ["-NoProfile", "-Command", `
$shell = New-Object -ComObject Shell.Application
$f = $shell.BrowseForFolder(0, '选择文件夹', 0x41)
if ($f) { Write-Output $f.Self.Path }
`];
    } else if (process.platform === "darwin") {
      cmd = "osascript";
      args = ["-e", "POSIX path of (choose folder as alias)"];
    } else {
      cmd = "zenity";
      args = ["--file-selection", "--directory"];
    }
    let out = "";
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: false, timeout: 120000 });
      pushLog("sys", `[选择器] 已启动 ${cmd}（pid=${proc.pid}）`);
    } catch (err) {
      pickBusy = false;
      return resolve({ ok: false, message: `无法打开文件夹选择器：${err.message}` });
    }
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => pushLog("sys", `[选择器] ${d.toString().trim()}`));
    proc.on("error", (err) => {
      pickBusy = false;
      pushLog("sys", `[选择器] 启动失败：${err.message}`);
      resolve({ ok: false, message: `文件夹选择器不可用：${err.message}` });
    });
    proc.on("exit", () => {
      pickBusy = false;
      const path = out.trim().split(/\r?\n/).pop() || "";
      resolve(path ? { ok: true, path } : { ok: false, code: "canceled", message: "未选择文件夹" });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 探测与信息收集                                                     */
/* ------------------------------------------------------------------ */

async function probeGui(portOverride) {
  const host = config.guiHost;
  const port = portOverride ?? config.guiPort;
  const url = `http://${host}:${port}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: "manual" });
    return { online: true, status: r.status, latencyMs: Date.now() - t0, url };
  } catch {
    return { online: false, status: null, latencyMs: null, url };
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function dshHomeResolved() {
  if (config.dshHome && config.dshHome.trim()) return config.dshHome.trim();
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function sessionsInfo() {
  const root = path.join(dshHomeResolved(), "sessions");
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dir = path.join(root, e.name);
        const st = fs.statSync(dir);
        let sessions = 0;
        try { sessions = fs.readdirSync(dir).filter((f) => f.startsWith("session-")).length; } catch { /* ignore */ }
        return {
          name: e.name.replace(/^--/, "").replace(/--$/, "").replace(/--/g, " / "),
          key: e.name,
          path: dir,
          mtime: st.mtimeMs,
          sessions,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

async function snapshot() {
  const [gui] = await Promise.all([probeGui()]);
  const home = dshHomeResolved();
  // 若 GUI 在线但不是本实例拉起的，检查是否有其他启动器实例的登记
  let managedBy = null;
  if (gui.online && !isChildRunning()) {
    const claims = readClaims();
    const claim = claims[String(config.guiPort)];
    if (claim) {
      if (await isProcessAlive(claim.dshPid)) {
        managedBy = {
          launcherPid: claim.launcherPid,
          dshPid: claim.dshPid,
          startedAt: claim.startedAt,
          workspace: claim.workspace,
        };
      } else {
        delete claims[String(config.guiPort)];   // 登记的进程已死：清理
        writeClaims(claims);
      }
    }
  }
  return {
    launcher: { version: LAUNCHER_VERSION, port: LAUNCHER_PORT },
    gui,
    managedBy,
    child: isChildRunning()
      ? { running: true, pid: child.pid, port: child.port, startedAt: child.startedAt, profile: child.profile, adopted: child.adopted }
      : { running: false, pid: null, port: null, startedAt: null, profile: null, adopted: false },
    stopping,
    headless: headlessRun
      ? { running: headlessRun.proc.exitCode === null, task: headlessRun.task, startedAt: headlessRun.startedAt, exitCode: headlessRun.exitCode }
      : { running: false, task: null, startedAt: null, exitCode: null },
    plugins: {
      busy: pluginBusy,
      profiles: listDir(path.join(dshHomeResolved(), "profiles")).filter((p) => p !== "node_modules"),
    },
    dsh: {
      bin: dshBin,
      source: dshSource,
      installed: /\.js$/i.test(dshBin) && path.isAbsolute(dshBin),
      installing: installingDsh,
      installs: findAllDshInstalls(),
      version: readDshVersion(dshBin),
      latest: dshLatestCache?.version ?? null,
      latestCheckedAt: dshLatestCache?.checkedAt ?? null,
      updateAvailable: (() => {
        if (!dshLatestCache?.version) return false;
        const a = parseVersion(readDshVersion(dshBin));
        const b = parseVersion(dshLatestCache.version);
        return !!(a && b && compareVersions(a, b) < 0);
      })(),
      home,
      nodeVersion: process.version,
      profiles: listDir(path.join(home, "profiles")),
      sessions: sessionsInfo(),
    },
    config: { ...config },
  };
}

function broadcastState() {
  snapshot().then((s) => broadcast("state", s)).catch(() => { /* ignore */ });
}

/* ------------------------------------------------------------------ */
/* 系统动作：打开浏览器 / 资源管理器                                   */
/* ------------------------------------------------------------------ */

/** 启动一个忽略错误的辅助进程（浏览器/资源管理器），避免未监听 'error' 或同步抛错导致进程崩溃 */
function spawnDetached(cmd, args) {
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => { /* 环境缺少该命令时静默忽略 */ });
    child.unref();
  } catch { /* 受限环境无法启动时静默忽略 */ }
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawnDetached("cmd", ["/c", "start", "", url]);
  } else {
    spawnDetached(process.platform === "darwin" ? "open" : "xdg-open", [url]);
  }
}

function explore(pathToOpen) {
  const target = path.resolve(pathToOpen);
  if (!fs.existsSync(target)) return { ok: false, message: `路径不存在：${target}` };
  if (process.platform === "win32") {
    spawnDetached("explorer.exe", [target]);
  } else {
    spawnDetached(process.platform === "darwin" ? "open" : "xdg-open", [target]);
  }
  return { ok: true, path: target };
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                          */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(res, urlPath) {
  const root = path.join(__dirname, "public");
  let name;
  try {
    name = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.replace(/^\/+/, ""));
  } catch {
    return sendJson(res, 400, { ok: false, message: "bad path" });
  }
  const file = path.resolve(root, name);
  if (file !== root && !file.startsWith(root + path.sep)) {
    return sendJson(res, 403, { ok: false, message: "forbidden" });
  }
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { ok: false, message: "not found" });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = u.pathname;
  try {
    /* ---------- 状态快照 ---------- */
    if (p === "/api/state" && req.method === "GET") {
      return sendJson(res, 200, await snapshot());
    }

    /* ---------- SSE 事件流 ---------- */
    if (p === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      res.on("error", () => sseClients.delete(res));
      // 立即推一次初始状态与最近日志
      const s = await snapshot();
      res.write(`event: state\ndata: ${JSON.stringify(s)}\n\n`);
      for (const line of logRing.slice(-200)) {
        res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
      }
      return;
    }

    /* ---------- 历史日志 ---------- */
    if (p === "/api/logs" && req.method === "GET") {
      const since = Number(u.searchParams.get("since") || 0);
      return sendJson(res, 200, { lines: logRing.filter((l) => l.t > since) });
    }

    /* ---------- 导出日志（完整持久化文件，回退到环形缓冲） ---------- */
    if (p === "/api/logs/export" && req.method === "GET") {
      let content;
      try {
        content = fs.readFileSync(LOG_FILE, "utf8");
      } catch {
        content = logRing.map((l) => `[${fmtTime(l.t)}] ${l.text}`).join("\n") + "\n";
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="dsh-launcher.log"`,
        "Cache-Control": "no-store",
      });
      return res.end(content);
    }

    /* ---------- 启动 dsh web ---------- */
    if (p === "/api/start" && req.method === "POST") {
      const body = await readBody(req);
      const port = Number(body.port || config.guiPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return sendJson(res, 400, { ok: false, code: "bad-port", message: "端口无效" });
      }
      const gui = await probeGui(port);
      if (gui.online && !isChildRunning()) {
        return sendJson(res, 409, {
          ok: false, code: "port-busy",
          message: `端口 ${port} 已被占用（GUI 似乎已在运行），直接打开界面即可`,
        });
      }
      return sendJson(res, 200, startDshWeb(port));
    }

    /* ---------- 停止 dsh web ---------- */
    if (p === "/api/stop" && req.method === "POST") {
      return sendJson(res, 200, stopDshWeb());
    }

    /* ---------- 接管其他启动器实例的 dsh web ---------- */
    if (p === "/api/adopt" && req.method === "POST") {
      const body = await readBody(req);
      const port = Number(body.port || config.guiPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return sendJson(res, 400, { ok: false, code: "bad-port", message: "端口无效" });
      }
      const gui = await probeGui(port);
      if (!gui.online) {
        return sendJson(res, 409, { ok: false, code: "no-gui", message: "GUI 当前不在线，无需接管" });
      }
      if (isChildRunning()) {
        return sendJson(res, 409, { ok: false, code: "already-running", message: "本启动器已管理该进程" });
      }
      const claims = readClaims();
      let claim = claims[String(port)];
      let prevOwner = null;
      if (!claim) {
        // 无登记（npx / 手动启动的实例）：按端口查找监听进程后接管
        const pids = await findPidsByPort(port);
        if (!pids.length) {
          return sendJson(res, 404, {
            ok: false, code: "no-listener",
            message: `端口 ${port} 上没有发现监听进程，无法接管`,
          });
        }
        claim = {
          launcherPid: process.pid,
          dshPid: pids[0],
          startedAt: new Date().toISOString(),
          workspace: config.workspace,
          launcherVersion: LAUNCHER_VERSION,
        };
        claims[String(port)] = claim;
      } else {
        prevOwner = claim.launcherPid;
        if (!(await isProcessAlive(claim.dshPid))) {
          delete claims[String(port)];
          writeClaims(claims);
          return sendJson(res, 404, { ok: false, code: "stale", message: "登记的进程已不存在，记录已清理" });
        }
        claim.launcherPid = process.pid;
        claim.startedAt = new Date().toISOString();
      }
      writeClaims(claims);
      child = { proc: null, pid: claim.dshPid, port, startedAt: claim.startedAt, profile: "web", adopted: true };
      pushLog("sys", `[接管] 已接管端口 ${port} 的进程（pid=${claim.dshPid}${prevOwner ? `，原属启动器 ${prevOwner}` : "，无登记记录，按端口接管"}）`);
      broadcastState();
      return sendJson(res, 200, { ok: true, pid: claim.dshPid });
    }

    /* ---------- 强制停止占用端口的进程 ---------- */
    if (p === "/api/force-stop" && req.method === "POST") {
      const body = await readBody(req);
      const port = Number(body.port || config.guiPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return sendJson(res, 400, { ok: false, code: "bad-port", message: "端口无效" });
      }
      // 若是启动器拉起的进程，走常规停止即可
      if (isChildRunning()) {
        const r = stopDshWeb(port);
        return sendJson(r.ok ? 200 : 409, r);
      }
      const pids = await findPidsByPort(port);
      if (!pids.length) {
        return sendJson(res, 404, { ok: false, code: "no-listener", message: `端口 ${port} 上未发现监听进程` });
      }
      await killPids(pids);
      pushLog("sys", `[强制停止] 已终止端口 ${port} 的监听进程：${pids.join(", ")}`);
      setTimeout(broadcastState, 800);
      return sendJson(res, 200, { ok: true, killed: pids, port });
    }

    /* ---------- headless 任务 ---------- */
    if (p === "/api/headless" && req.method === "POST") {
      const body = await readBody(req);
      const task = String(body.task || "").trim();
      if (!task) return sendJson(res, 400, { ok: false, code: "task-required", message: "任务内容不能为空" });
      return sendJson(res, 200, runHeadless(task));
    }
    if (p === "/api/headless-cancel" && req.method === "POST") {
      return sendJson(res, 200, cancelHeadless());
    }

    /* ---------- 插件管理 ---------- */
    if (p === "/api/plugins" && req.method === "GET") {
      const profile = String(u.searchParams.get("profile") || "web").replace(/[\\/]/g, "");
      if (!/^[\w@.-]+$/.test(profile)) return sendJson(res, 400, { ok: false, message: "profile 名无效" });
      return sendJson(res, 200, readProfilePlugins(profile));
    }
    if (p === "/api/plugins/op" && req.method === "POST") {
      const body = await readBody(req);
      const profile = String(body.profile || "web").replace(/[\\/]/g, "");
      const action = String(body.action || "");
      const pkg = String(body.pkg || "").trim();
      if (!/^[\w@.-]+$/.test(profile)) return sendJson(res, 400, { ok: false, message: "profile 名无效" });
      if (!["add", "remove"].includes(action)) return sendJson(res, 400, { ok: false, message: "action 仅支持 add / remove" });
      if (!pkg) return sendJson(res, 400, { ok: false, message: "缺少插件包名" });
      return sendJson(res, 200, runPluginOp(profile, [action, pkg]));
    }

    /* ---------- 原生文件夹选择对话框 ---------- */
    if (p === "/api/pick-folder" && req.method === "POST") {
      return sendJson(res, 200, await pickFolder());
    }

    /* ---------- 打开浏览器 / 资源管理器 ---------- */
    if (p === "/api/open-gui" && req.method === "POST") {
      const gui = await probeGui();
      if (!gui.online) return sendJson(res, 409, { ok: false, message: "GUI 当前不在线" });
      openBrowser(gui.url);
      return sendJson(res, 200, { ok: true, url: gui.url });
    }
    if (p === "/api/explore" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.path) return sendJson(res, 400, { ok: false, message: "缺少 path" });
      return sendJson(res, 200, explore(body.path));
    }

    /* ---------- 保存配置 ---------- */
    if (p === "/api/save-config" && req.method === "POST") {
      const body = await readBody(req);
      const patch = {};
      for (const key of ["guiHost", "guiPort", "workspace", "dshCommand", "dshHome", "autoOpenGui"]) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (patch.guiPort !== undefined) {
        patch.guiPort = Number(patch.guiPort);
        if (!Number.isInteger(patch.guiPort) || patch.guiPort < 1 || patch.guiPort > 65535) {
          return sendJson(res, 400, { ok: false, message: "GUI 端口无效" });
        }
      }
      if (patch.guiHost !== undefined) {
        patch.guiHost = String(patch.guiHost).trim() || "127.0.0.1";
        if (patch.guiHost === "0.0.0.0") {
          // dsh web 出于安全原因明确拒绝 --host 0.0.0.0（会向网络暴露远程代码执行）
          return sendJson(res, 400, { ok: false, message: "GUI 主机不能是 0.0.0.0（dsh web 会拒绝该绑定，请使用 127.0.0.1）" });
        }
      }
      if (patch.workspace === "") patch.workspace = __dirname;
      persistConfig(patch);
      const resolved = resolveDsh();
      dshBin = resolved.bin;
      dshSource = resolved.source;
      pushLog("sys", "[配置] 已保存，dsh CLI = " + dshBin);
      if (!fs.existsSync(config.workspace)) pushLog("sys", "[警告] 工作区目录不存在：" + config.workspace);
      if (config.dshHome && !fs.existsSync(config.dshHome)) pushLog("sys", "[警告] DSH_HOME 目录不存在：" + config.dshHome);
      broadcastState();
      return sendJson(res, 200, { ok: true, config: config });
    }

    /* ---------- 检查 dsh 更新 ---------- */
    if (p === "/api/check-update" && req.method === "POST") {
      const version = await checkDshUpdate(true);
      const installed = dshBin && /\.js$/i.test(dshBin) && path.isAbsolute(dshBin);
      const installedVersion = readDshVersion(dshBin);
      let updateAvailable = false;
      if (version && installedVersion) {
        const a = parseVersion(installedVersion);
        const b = parseVersion(version);
        if (a && b) updateAvailable = compareVersions(a, b) < 0;
      }
      broadcastState();
      return sendJson(res, 200, { ok: true, latest: version, installed: installed, installedVersion, updateAvailable });
    }

    /* ---------- 一键安装 dsh ---------- */
    if (p === "/api/install-dsh" && req.method === "POST") {
      return sendJson(res, 200, installDsh());
    }

    /* ---------- 重新扫描 dsh 安装 ---------- */
    if (p === "/api/scan-dsh" && req.method === "POST") {
      const resolved = resolveDsh();
      dshBin = resolved.bin;
      dshSource = resolved.source;
      broadcastState();
      return sendJson(res, 200, { ok: true, bin: dshBin, source: dshSource, installs: findAllDshInstalls() });
    }

    /* ---------- 关闭启动器后端 ---------- */
    if (p === "/api/shutdown" && req.method === "POST") {
      // 只停止自己拉起的 dsh web；接管/外部进程不动
      if (isChildRunning() && !child.adopted) {
        stopDshWeb(child.port);
      }
      releaseOwnClaims();
      pushLog("sys", "[关闭] 启动器后端正在退出……");
      // 先让响应发送完成，再退出进程（taskkill 是独立进程，会继续执行）
      setTimeout(() => process.exit(0), 500);
      return sendJson(res, 200, { ok: true, message: "启动器已关闭" });
    }

    /* ---------- 指定使用某个 dsh 安装（版本选择器；bin 为空则恢复自动检测） ---------- */
    if (p === "/api/use-dsh" && req.method === "POST") {
      const body = await readBody(req);
      const bin = String(body.bin || "").trim();
      if (bin && !fs.existsSync(bin)) {
        return sendJson(res, 400, { ok: false, code: "bad-bin", message: "路径不存在：" + bin });
      }
      persistConfig({ dshCommand: bin });
      const resolved = resolveDsh();
      dshBin = resolved.bin;
      dshSource = resolved.source;
      pushLog("sys", `[配置] 指定使用 dsh：${bin || "（自动检测）"} → ${dshBin}`);
      broadcastState();
      return sendJson(res, 200, { ok: true, bin: dshBin, source: dshSource });
    }

    /* ---------- 静态资源 ---------- */
    if (req.method === "GET") {
      return serveStatic(res, p);
    }

    return sendJson(res, 404, { ok: false, message: "not found" });
  } catch (err) {
    return sendJson(res, 500, { ok: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

/** 从 start 起查找一个空闲端口（用于启动器自身端口被占用时自动回退） */
async function findFreePort(start, maxTries = 20) {
  let port = start;
  for (let i = 0; i < maxTries; i++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => {
        const p = srv.address().port;
        srv.close(() => resolve(true));
      });
    });
    if (free) return port;
    port++;
  }
  return null;
}

const argPort = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) : NaN;
})();
const requestedPort = Number.isInteger(argPort) ? argPort : (Number(process.env.DSH_LAUNCHER_PORT) || DEFAULT_PORT);
const LAUNCHER_PORT = (await findFreePort(requestedPort)) ?? requestedPort;

// 清理其他实例遗留的陈旧登记（避免 stale 记录误导接管）
await cleanupStaleClaims();

// 后台异步检查 dsh 最新版本（不阻塞启动；完成后广播状态供界面刷新）
checkDshUpdate().then(() => broadcastState()).catch(() => { /* 离线时静默 */ });

server.listen(LAUNCHER_PORT, "127.0.0.1", () => {
  setInterval(heartbeat, 25000).unref();
  const url = `http://127.0.0.1:${LAUNCHER_PORT}`;
  console.log("");
  console.log("  ┌─────────────────────────────────────────────┐");
  console.log("  │   DEEPSEEK HARNESS · 启动器 LAUNCHER        │");
  console.log(`  │   v${LAUNCHER_VERSION.padEnd(36)}│`);
  console.log("  └─────────────────────────────────────────────┘");
  if (LAUNCHER_PORT !== requestedPort) {
    console.log(`  ⚠ 端口 ${requestedPort} 被占用，已自动改用 ${LAUNCHER_PORT}`);
  }
  console.log(`  控制台:   ${url}`);
  console.log(`  dsh CLI:  ${dshBin}`);
  console.log(`  DSH_HOME: ${dshHomeResolved()}`);
  if (!fs.existsSync(config.workspace)) {
    console.log(`  ⚠ 工作区不存在: ${config.workspace}（可在「设置」中修改）`);
  }
  console.log(`  按 Ctrl+C 退出启动器（不会停止已拉起的 dsh web）`);
  console.log("");
  openBrowser(url); // 自动打开控制台
});

process.on("SIGINT", () => {
  console.log("\n[启动器] 正在退出……已拉起的 dsh web 子进程会随终端关闭而终止。");
  releaseOwnClaims();
  process.exit(0);
});

// 兜底：任何方式退出时释放本实例的所有权登记
process.on("exit", () => {
  try { releaseOwnClaims(); } catch { /* ignore */ }
});
