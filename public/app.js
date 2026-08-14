/* ============================================================
   DeepSeek Harness · 启动器 —— 前端逻辑
   ============================================================ */

"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const els = {
  launcherVersion: $("#launcherVersion"),
  guiDot: $("#guiDot"),
  guiStateText: $("#guiStateText"),
  statusTag: $("#statusTag"),
  beacon: $("#beacon"),
  heroState: $("#heroState"),
  heroTitle: $("#heroTitle"),
  heroSub: $("#heroSub"),
  guiUrl: $("#guiUrl"),
  btnCopyUrl: $("#btnCopyUrl"),
  btnStart: $("#btnStart"),
  btnStop: $("#btnStop"),
  btnOpen: $("#btnOpen"),
  btnForceStop: $("#btnForceStop"),
  btnAdopt: $("#btnAdopt"),
  btnShutdown: $("#btnShutdown"),
  infoPid: $("#infoPid"),
  infoPort: $("#infoPort"),
  infoWorkspace: $("#infoWorkspace"),
  infoSince: $("#infoSince"),
  metaDshVersion: $("#metaDshVersion"),
  metaNode: $("#metaNode"),
  metaHome: $("#metaHome"),
  metaProfiles: $("#metaProfiles"),
  updateRow: $("#updateRow"),
  updateText: $("#updateText"),
  btnCheckUpdate: $("#btnCheckUpdate"),
  btnInstallDsh: $("#btnInstallDsh"),
  dshList: $("#dshList"),
  btnScanDsh: $("#btnScanDsh"),
  tabbar: $("#tabbar"),
  tabs: $$(".tab"),
  tabUnderline: $("#tabUnderline"),
  log: $("#log"),
  logEmpty: $("#logEmpty"),
  chkAutoscroll: $("#chkAutoscroll"),
  btnClearLog: $("#btnClearLog"),
  taskInput: $("#taskInput"),
  btnRunTask: $("#btnRunTask"),
  btnCancelTask: $("#btnCancelTask"),
  taskStatus: $("#taskStatus"),
  taskOutput: $("#taskOutput"),
  taskExit: $("#taskExit"),
  taskLog: $("#taskLog"),
  sessList: $("#sessList"),
  btnRefreshSessions: $("#btnRefreshSessions"),
  setGuiPort: $("#setGuiPort"),
  setGuiHost: $("#setGuiHost"),
  setWorkspace: $("#setWorkspace"),
  setDshCommand: $("#setDshCommand"),
  setDshHome: $("#setDshHome"),
  setAutoOpen: $("#setAutoOpen"),
  btnSaveConfig: $("#btnSaveConfig"),
  saveStatus: $("#saveStatus"),
  themeSelect: $("#themeSelect"),
  toasts: $("#toasts"),
};

/* ---------- 主题切换 ---------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("dsh-theme", theme); } catch { /* 隐私模式下忽略 */ }
}

/* ---------- 状态 ---------- */

let state = null;
let lastLogTime = 0;
let firstSnapshotDone = false;

function fmtTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function fmtClock(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.floor(s / 60)}m 前`;
  if (s < 86400) return `${Math.floor(s / 3600)}h 前`;
  return `${Math.floor(s / 86400)}d 前`;
}

/* ---------- 渲染状态 ---------- */

function renderState(s) {
  state = s;
  const guiOnline = s.gui.online;
  const childRunning = s.child.running;
  const stopping = s.stopping && childRunning;
  const starting = childRunning && !guiOnline && !stopping;

  els.launcherVersion.textContent = "v" + s.launcher.version;

  // GUI 状态点
  els.guiDot.className = "dot" + (guiOnline ? " on" : childRunning ? " warn" : " off");
  els.guiStateText.textContent = guiOnline ? `在线 ${s.gui.latencyMs}ms` : stopping ? "停止中" : starting ? "启动中" : "离线";

  // 状态标签与英雄区
  els.statusTag.className = "panel-tag" + (guiOnline ? " live" : starting ? " boot" : stopping ? " boot" : " off");
  els.statusTag.textContent = guiOnline ? "ONLINE" : starting ? "BOOTING" : stopping ? "STOPPING" : "STANDBY";

  els.beacon.className = "beacon" + (guiOnline ? " on" : starting || stopping ? " boot" : " off");
  els.heroState.className = "hero-state" + (guiOnline ? " on" : starting || stopping ? " boot" : " off");
  els.heroState.textContent = guiOnline ? "ONLINE" : starting ? "BOOTING" : stopping ? "STOPPING" : "OFFLINE";
  els.heroTitle.textContent = guiOnline
    ? "DeepSeek Harness 图形界面运行中"
    : starting
      ? "正在拉起 dsh web 服务…"
      : stopping
        ? "正在停止服务…"
        : "服务未运行";
  els.heroSub.textContent = guiOnline
    ? (s.managedBy && !childRunning
        ? `由启动器 PID ${s.managedBy.launcherPid} 管理 · dsh pid ${s.managedBy.dshPid} · 可接管`
        : !childRunning
          ? `外部启动（如 npx）· 可「接管控制」或「强制停止」`
          : `已在 ${s.gui.url} 响应 · HTTP ${s.gui.status}`)
    : starting
      ? `等待 ${s.gui.url} 就绪…`
      : stopping
        ? "正在终止由启动器拉起的进程"
        : "点击「启动服务」拉起 dsh web";

  // GUI 地址
  els.guiUrl.textContent = s.gui.url;

  // 接管按钮：GUI 在线、本实例未管理时显示（有登记=接管实例；无登记=按端口接管外部进程）
  const adoptable = guiOnline && !childRunning;
  els.btnAdopt.hidden = !adoptable;

  // 按钮
  els.btnStart.disabled = guiOnline;
  els.btnStop.disabled = !childRunning;
  els.btnOpen.disabled = !guiOnline;
  els.btnStart.classList.toggle("btn-spin", starting);

  // 信息格
  els.infoPid.textContent = childRunning ? String(s.child.pid) : "—";
  els.infoPort.textContent = s.config.guiPort;
  els.infoWorkspace.textContent = s.config.workspace || "—";
  els.infoWorkspace.title = s.config.workspace || "";
  els.infoSince.textContent = childRunning ? fmtClock(s.child.startedAt) : "—";

  // 元信息
  els.metaDshVersion.textContent = s.dsh.version || "未检测到";
  els.metaDshVersion.title = s.dsh.bin || "";
  els.metaDshVersion.classList.toggle("has-update", !!s.dsh.updateAvailable);
  els.metaNode.textContent = s.dsh.nodeVersion || "—";
  els.metaHome.textContent = s.dsh.home;
  els.metaHome.title = s.dsh.home;
  els.metaProfiles.textContent = s.dsh.profiles.length ? s.dsh.profiles.join(" · ") : "—";

  // DSH 更新状态行
  els.updateRow.hidden = false;
  const srcLabel = { config: "自定义", "npx-cache": "npx 缓存", "global-npm": "全局安装", none: "未安装" }[s.dsh.source] || s.dsh.source;
  // 安装按钮：仅在明确未安装时显示
  els.btnInstallDsh.hidden = !(s.dsh.installed === false);
  els.btnInstallDsh.disabled = !!s.dsh.installing;
  els.btnCheckUpdate.disabled = !!s.dsh.installing;
  if (s.dsh.installing) {
    els.updateText.textContent = "正在安装 dsh……（实时输出见日志面板）";
    els.updateText.className = "update-text warn";
  } else if (typeof s.dsh.installed !== "boolean") {
    // 后端进程早于前端代码（文件已更新但启动器未重启）
    els.updateText.textContent = "检测信息缺失：启动器后端进程较旧，请重启启动器后生效";
    els.updateText.className = "update-text warn";
  } else if (s.dsh.installed) {
    if (s.dsh.updateAvailable) {
      els.updateText.textContent = `发现新版本 v${s.dsh.latest}（当前 ${s.dsh.version} · ${srcLabel}）`;
      els.updateText.className = "update-text warn";
    } else if (s.dsh.latest) {
      els.updateText.textContent = `已是最新 v${s.dsh.version}（${srcLabel}）`;
      els.updateText.className = "update-text ok";
    } else {
      els.updateText.textContent = `更新检查不可用（离线？）· 当前 ${s.dsh.version}（${srcLabel}）`;
      els.updateText.className = "update-text";
    }
  } else {
    els.updateText.textContent = `未检测到本机安装（最新 v${s.dsh.latest || "未知"}）· 可点「安装 dsh」一键全局安装，或直接启动（npx 按需拉取）`;
    els.updateText.className = "update-text warn";
  }

  // dsh 安装列表
  renderDshList(s.dsh.installs);

  // 快捷任务状态（仅在任务视图可见时更新文字）
  if (s.headless.running) {
    els.taskStatus.textContent = "运行中 RUNNING…";
    els.taskStatus.className = "task-status run";
    els.btnRunTask.disabled = true;
    els.btnCancelTask.disabled = false;
  } else if (s.headless.exitCode !== null) {
    els.btnRunTask.disabled = false;
    els.btnCancelTask.disabled = true;
    if (s.headless.exitCode === 0) {
      els.taskStatus.textContent = "完成 DONE";
      els.taskStatus.className = "task-status done";
    } else {
      els.taskStatus.textContent = `失败 EXIT ${s.headless.exitCode}`;
      els.taskStatus.className = "task-status fail";
    }
  } else {
    els.btnRunTask.disabled = false;
    els.btnCancelTask.disabled = true;
    els.taskStatus.textContent = "空闲 IDLE";
    els.taskStatus.className = "task-status";
  }

  // 设置表单（仅首次快照填充，避免覆盖用户输入）
  if (!firstSnapshotDone) {
    els.setGuiPort.value = s.config.guiPort;
    els.setGuiHost.value = s.config.guiHost;
    els.setWorkspace.value = s.config.workspace || "";
    els.setDshCommand.value = s.config.dshCommand || "";
    els.setDshHome.value = s.config.dshHome || "";
    els.setAutoOpen.checked = !!s.config.autoOpenGui;
  }

  if (!firstSnapshotDone) {
    firstSnapshotDone = true;
    renderSessions(s.dsh.sessions);
  }
}

/* ---------- 日志渲染 ---------- */

// 极简 ANSI 解析：仅处理常见前景色/粗体/重置
function ansiToHtml(text) {
  let out = "";
  let bold = false;
  const tokens = text.split(/(\x1b\[[0-9;]*m)/g);
  for (const tok of tokens) {
    if (!tok) continue;
    const m = tok.match(/^\x1b\[([0-9;]*)m$/);
    if (m) {
      const codes = m[1] ? m[1].split(";").map(Number) : [0];
      for (const c of codes) {
        if (c === 0) { bold = false; out += "</span>".repeat(0); }
        if (c === 1) bold = true;
      }
      continue;
    }
    let html = tok.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (bold) html = `<span class="b">${html}</span>`;
    out += html;
  }
  return out;
}

function appendLogLine(line, target) {
  const streamLabel = { sys: "SYS", out: "OUT", err: "ERR" }[line.stream] || "·";
  const div = document.createElement("div");
  div.className = `log-line stream-${line.stream}`;
  div.innerHTML =
    `<span class="log-time">${fmtTime(line.t)}</span>` +
    `<span class="log-stream">${streamLabel}</span>` +
    `<span class="log-body">${ansiToHtml(line.text)}</span>`;
  target.appendChild(div);

  const empty = target.querySelector(".log-empty");
  if (empty) empty.remove();
}

function appendLog(line) {
  appendLogLine(line, els.log);
  if (els.chkAutoscroll.checked) els.log.scrollTop = els.log.scrollHeight;
}

function clearLog() {
  els.log.innerHTML = "";
}

/* ---------- 标签页 ---------- */

function setTab(name) {
  els.tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.view === name));
  $$(".view").forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  const active = els.tabs.find((t) => t.dataset.view === name);
  const parent = els.tabbar.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  els.tabUnderline.style.transform = `translateX(${rect.left - parent.left}px)`;
  els.tabUnderline.style.width = `${rect.width}px`;
  if (name === "sessions" && state) renderSessions(state.dsh.sessions);
  if (name === "settings" && state) fillSettings();
}

els.tabs.forEach((t) => t.addEventListener("click", () => setTab(t.dataset.view)));

/* ---------- 会话 ---------- */

function renderSessions(sessions) {
  if (!sessions || !sessions.length) {
    els.sessList.innerHTML = `<div class="sess-empty">暂无会话记录<br/><span style="font-size:9px;letter-spacing:.3em;opacity:.6">NO SESSIONS FOUND</span></div>`;
    return;
  }
  els.sessList.innerHTML = "";
  sessions.forEach((sess, i) => {
    const item = document.createElement("div");
    item.className = "sess-item";
    item.style.animationDelay = `${Math.min(i * 0.04, 0.4)}s`;
    item.innerHTML = `
      <div class="sess-icon">☰</div>
      <div class="sess-main">
        <div class="sess-name" title="${sess.key}">${esc(sess.name)}</div>
        <div class="sess-sub">${esc(sess.path)}</div>
      </div>
      <div class="sess-meta">
        <span class="sess-time">${fmtAgo(sess.mtime)}</span>
        <span class="sess-count">${sess.sessions} 次会话</span>
      </div>
      <button class="mini-btn" data-explore="${esc(sess.path)}">打开</button>
    `;
    item.querySelector("[data-explore]").addEventListener("click", (e) => {
      explore(e.currentTarget.dataset.explore);
    });
    els.sessList.appendChild(item);
  });
}

/* ---------- dsh 安装列表 ---------- */

const DSH_SRC_LABEL = { config: "自定义", "global-npm": "全局安装", "npx-cache": "npx 缓存", none: "未安装" };

function renderDshList(installs) {
  if (!installs || !installs.length) {
    els.dshList.innerHTML = `<div class="dsh-empty">未发现任何 dsh 安装（启动时将用 npx 按需拉取）</div>`;
    return;
  }
  els.dshList.innerHTML = "";
  installs.forEach((it, i) => {
    const item = document.createElement("div");
    item.className = "dsh-item" + (it.inUse ? " in-use" : "");
    item.style.animationDelay = `${Math.min(i * 0.04, 0.3)}s`;
    const src = DSH_SRC_LABEL[it.source] || it.source || "未知";
    item.innerHTML = `
      <div class="dsh-ver">v${it.version || "?"}</div>
      <div class="dsh-main">
        <div class="dsh-src">${src}${it.inUse ? ' <span class="dsh-badge">使用中</span>' : ""}</div>
        <div class="dsh-path" title="${esc(it.bin)}">${esc(it.bin)}</div>
      </div>
    `;
    els.dshList.appendChild(item);
  });
}

/* ---------- 重新扫描 dsh ---------- */

async function doScanDsh() {
  els.btnScanDsh.disabled = true;
  try {
    const data = await post("/api/scan-dsh", {});
    const count = (data.installs || []).length;
    toast(`扫描完成：发现 ${count} 个 dsh 安装`, "ok");
  } catch (err) {
    toast(err.message, "err");
  } finally {
    els.btnScanDsh.disabled = false;
  }
}

/* ---------- 设置 ---------- */

function fillSettings() {
  if (!state) return;
  els.setGuiPort.value = state.config.guiPort;
  els.setGuiHost.value = state.config.guiHost;
  els.setWorkspace.value = state.config.workspace || "";
  els.setDshCommand.value = state.config.dshCommand || "";
  els.setDshHome.value = state.config.dshHome || "";
  els.setAutoOpen.checked = !!state.config.autoOpenGui;
}

async function saveConfig() {
  const patch = {
    guiPort: Number(els.setGuiPort.value),
    guiHost: els.setGuiHost.value.trim() || "127.0.0.1",
    workspace: els.setWorkspace.value.trim(),
    dshCommand: els.setDshCommand.value.trim(),
    dshHome: els.setDshHome.value.trim(),
    autoOpenGui: els.setAutoOpen.checked,
  };
  els.saveStatus.textContent = "保存中…";
  try {
    const res = await fetch("/api/save-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "保存失败");
    els.saveStatus.textContent = "已保存 ✓";
    toast("配置已保存", "ok");
    setTimeout(() => { els.saveStatus.textContent = ""; }, 3000);
  } catch (err) {
    els.saveStatus.textContent = "保存失败";
    toast(err.message, "err");
  }
}

/* ---------- 动作 ---------- */

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.ok) throw Object.assign(new Error(data.message || `HTTP ${res.status}`), { code: data.code });
  return data;
}

async function doStart() {
  if (!state || state.gui.online) return;
  els.btnStart.disabled = true;
  toast("正在启动 dsh web …", "ok");
  try {
    await post("/api/start", {});
  } catch (err) {
    if (err.code === "port-busy") {
      toast("端口已被占用，GUI 似乎已在运行，可直接打开界面", "ok");
      openGui();
    } else {
      toast(err.message, "err");
      els.btnStart.disabled = false;
    }
  }
}

async function doStop() {
  if (!state || !state.child.running) return;
  if (!confirm("确定要停止由启动器拉起的 dsh web 进程吗？")) return;
  try {
    await post("/api/stop", {});
    toast("已发送停止信号", "ok");
  } catch (err) {
    toast(err.message, "err");
  }
}

async function doForceStop() {
  if (!state) return;
  const port = state.config.guiPort;
  const target = state.child.running
    ? `由启动器拉起的进程（PID ${state.child.pid}）`
    : `占用端口 ${port} 的进程`;
  const msg =
    `即将强制终止${target}。\n\n` +
    `⚠ 注意：如果该进程是当前正在使用的 Harness 会话，` +
    `终止后会话会立即断开、数据可能丢失！\n\n确定要继续吗？`;
  if (!confirm(msg)) return;
  try {
    const data = await post("/api/force-stop", { port });
    toast(`已终止：${data.killed.join(", ")}`, "ok");
  } catch (err) {
    if (err.code === "no-listener") toast(err.message, "warn");
    else toast(err.message, "err");
  }
}

async function doAdopt() {
  if (!state || !state.gui.online) return;
  if (!state.managedBy) {
    // 无登记（npx / 手动启动）：接管前明确说明后果
    const msg =
      "该 GUI 不是由启动器实例启动的（可能是 npx 或手动启动）。\n" +
      "接管后将按端口查找并跟踪其进程，之后可用「停止服务」一键控制。\n\n" +
      "⚠ 如果该进程是正在使用的 Harness 会话，停止它会断开会话。\n\n继续？";
    if (!confirm(msg)) return;
  }
  try {
    const data = await post("/api/adopt", {});
    toast(`已接管进程 ${data.pid}，现在可以停止或继续管理`, "ok");
  } catch (err) {
    toast(err.message, "err");
  }
}

async function openGui() {
  if (!state || !state.gui.online) return;
  window.open(state.gui.url, "_blank");
}

function copyUrl() {
  if (!state) return;
  navigator.clipboard?.writeText(state.gui.url).then(
    () => toast("地址已复制", "ok"),
    () => toast("复制失败，请手动选择复制", "err")
  );
}

async function runTask() {
  const task = els.taskInput.value.trim();
  if (!task) { toast("请先输入任务内容", "err"); return; }
  els.btnRunTask.disabled = true;
  els.taskStatus.textContent = "运行中 RUNNING…";
  els.taskStatus.className = "task-status run";
  els.taskOutput.hidden = false;
  els.taskLog.innerHTML = "";
  els.taskExit.textContent = "EXIT —";
  els.taskExit.className = "exit-chip";
  try {
    await post("/api/headless", { task });
  } catch (err) {
    toast(err.message, "err");
    els.btnRunTask.disabled = false;
    els.taskStatus.textContent = "启动失败";
    els.taskStatus.className = "task-status fail";
  }
}

async function cancelTask() {
  if (!state || !state.headless.running) return;
  if (!confirm("确定要取消正在运行的 headless 任务吗？")) return;
  try {
    const data = await post("/api/headless-cancel", {});
    if (!data.ok) throw new Error(data.message || "取消失败");
    toast("已发送取消信号", "ok");
  } catch (err) {
    toast(err.message, "err");
  }
}

async function explore(pathToOpen) {
  try {
    const data = await post("/api/explore", { path: pathToOpen });
    if (!data.ok) toast(data.message || "无法打开", "err");
  } catch (err) {
    toast(err.message, "err");
  }
}

/* ---------- 关闭启动器 ---------- */

function showShutdownOverlay() {
  document.getElementById("shutdownOverlay").hidden = false;
  document.body.classList.add("shutdown");
}

async function doShutdown() {
  if (!state) return;
  const stopsOwned = state.child.running && !state.child.adopted;
  const msg =
    "确定要关闭启动器吗？关闭后：\n" +
    "· 启动器后端进程将退出，本页面无法再控制服务\n" +
    (stopsOwned ? "· 由启动器拉起的 dsh web 会一并停止\n" : "· 已接管的 dsh web 会保持运行\n") +
    "· 所有权登记将被释放\n\n继续？";
  if (!confirm(msg)) return;
  try {
    await post("/api/shutdown", {});
  } catch { /* 后端已退出，请求失败属正常 */ }
  showShutdownOverlay();
}

/* ---------- 检查 dsh 更新 ---------- */

async function doCheckUpdate() {
  els.btnCheckUpdate.disabled = true;
  els.updateText.textContent = "检查中……";
  try {
    const data = await post("/api/check-update", {});
    if (data.updateAvailable) toast(`发现新版本 v${data.latest}`, "ok");
    else if (data.latest) toast(`已是最新 v${data.installedVersion}`, "ok");
    else toast("更新检查失败（可能离线）", "warn");
  } catch (err) {
    toast(err.message, "err");
  } finally {
    els.btnCheckUpdate.disabled = false;
  }
}

/* ---------- 一键安装 dsh ---------- */

async function doInstallDsh() {
  if (!state || state.dsh.installed !== false) return;
  const msg =
    "将通过 npm 全局安装 @deepseek-ai/dsh（npm i -g @deepseek-ai/dsh@latest）。\n" +
    "需要网络；安装过程输出会实时显示在日志面板。\n\n继续？";
  if (!confirm(msg)) return;
  try {
    const data = await post("/api/install-dsh", {});
    if (data.code === "busy") { toast(data.message, "warn"); return; }
    toast("开始安装 dsh……", "ok");
  } catch (err) {
    toast(err.message, "err");
  }
}

/* ---------- Toast ---------- */

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 320);
  }, 3800);
}

/* ---------- 工具 ---------- */

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ---------- SSE ---------- */

function connectSSE() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => {
    renderState(JSON.parse(e.data));
  });
  es.addEventListener("line", (e) => {
    const line = JSON.parse(e.data);
    lastLogTime = Math.max(lastLogTime, line.t);
    appendLog(line);
    // headless 输出同时进任务面板
    if (!els.taskOutput.hidden && els.taskLog) appendLogLine(line, els.taskLog);
  });
  es.addEventListener("headless-start", (e) => {
    const d = JSON.parse(e.data);
    appendLogLine({ t: Date.now(), stream: "sys", text: `[任务] 已启动 pid=${d.pid}：${d.task}` }, els.taskLog);
  });
  es.addEventListener("headless-result", (e) => {
    const d = JSON.parse(e.data);
    els.btnRunTask.disabled = false;
    const ok = d.exitCode === 0;
    els.taskStatus.textContent = ok ? "完成 DONE" : `失败 EXIT ${d.exitCode}`;
    els.taskStatus.className = ok ? "task-status done" : "task-status fail";
    els.taskExit.textContent = `EXIT ${d.exitCode}`;
    els.taskExit.className = "exit-chip " + (ok ? "ok" : "fail");
    toast(ok ? "任务执行完成" : `任务退出码 ${d.exitCode}`, ok ? "ok" : "err");
  });
  es.onerror = () => {
    // 断线时提示一次；EventSource 会自动重连
  };
}

/* ---------- 绑定事件 ---------- */

els.btnStart.addEventListener("click", doStart);
els.btnStop.addEventListener("click", doStop);
els.btnForceStop.addEventListener("click", doForceStop);
els.btnAdopt.addEventListener("click", doAdopt);
els.btnShutdown.addEventListener("click", doShutdown);
els.btnOpen.addEventListener("click", openGui);
els.btnCopyUrl.addEventListener("click", copyUrl);
els.btnClearLog.addEventListener("click", clearLog);
els.btnRunTask.addEventListener("click", runTask);
els.btnCancelTask.addEventListener("click", cancelTask);
els.btnRefreshSessions.addEventListener("click", async () => {
  const res = await fetch("/api/state");
  const s = await res.json();
  renderSessions(s.dsh.sessions);
  toast("会话列表已刷新", "ok");
});
els.btnSaveConfig.addEventListener("click", saveConfig);
els.btnCheckUpdate.addEventListener("click", doCheckUpdate);
els.btnInstallDsh.addEventListener("click", doInstallDsh);
els.btnScanDsh.addEventListener("click", doScanDsh);
els.infoWorkspace.addEventListener("click", () => explore(els.infoWorkspace.textContent));
els.metaHome.addEventListener("click", () => explore(els.metaHome.textContent));

// 设置页「打开」按钮
$$("[data-explore]").forEach((btn) => {
  if (btn.dataset.explore === "workspace") btn.addEventListener("click", () => explore(els.setWorkspace.value || state?.config.workspace));
  else if (btn.dataset.explore === "home") btn.addEventListener("click", () => explore(els.setDshHome.value || state?.dsh.home));
  else if (btn.dataset.explore === "dsh") {
    btn.addEventListener("click", () => {
      const bin = state?.dsh.bin || els.setDshCommand.value;
      if (bin && /^[A-Za-z]:[\\/]/.test(bin)) {
        // 浏览器环境没有 path 模块：手动去掉文件名取所在目录
        const dir = bin.replace(/[\\/][^\\/]+$/, "");
        explore(dir || bin);
      } else {
        toast("当前 dsh CLI 不是本地路径（可能是 npx 命令）", "err");
      }
    });
  }
});

// 快捷键：Ctrl+Enter 运行任务
els.taskInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") runTask();
});

window.addEventListener("resize", () => {
  const active = els.tabs.find((t) => t.classList.contains("is-active"));
  if (active) setTab(active.dataset.view);
});

// PWA：注册 Service Worker（本地 http 属安全上下文，注册失败静默忽略）
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => { /* 不支持时忽略 */ });
  });
}

/* ---------- 初始化 ---------- */

// 主题：同步切换器与当前生效主题，监听变更
els.themeSelect.value = document.documentElement.dataset.theme || "abyss";
els.themeSelect.addEventListener("change", (e) => applyTheme(e.target.value));

setTab("log");
connectSSE();

// 兜底轮询（EventSource 之外的保险）
setInterval(async () => {
  try {
    const res = await fetch("/api/state");
    const s = await res.json();
    renderState(s);
  } catch { /* 后端暂时不可达 */ }
}, 15000);
