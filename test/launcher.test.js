/**
 * dsh-launcher 冒烟测试（零依赖，使用 Node 内置 node:test）。
 *
 * 运行：npm test  或  node --test test/
 *
 * 说明：测试只会启动启动器本身（http + 静态资源 + API），
 * 不会真正拉起 dsh web / headless（那需要真实的 DSH 环境）。
 */
import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(__dirname, "..", "launcher.js");
const TEST_PORT = 32233; // 若被占用启动器会自动回退，测试从启动横幅解析实际端口

/** 启动启动器子进程，解析横幅中的实际端口 */
function startLauncher() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [LAUNCHER, "--port", String(TEST_PORT)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`启动器启动超时\n${out}`));
    }, 20000);
    proc.stdout.on("data", (d) => {
      out += d.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, port: Number(m[1]) });
      }
    });
    proc.stderr.on("data", (d) => { out += d.toString(); });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`启动器提前退出 code=${code}\n${out}`));
    });
  });
}

/** 发送原始路径请求（不经 URL 规范化），用于路径穿越测试 */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("静态首页可访问且包含品牌标记", async () => {
  const { proc, port } = await startLauncher();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("DEEPSEEK"), "首页应包含 DEEPSEEK 品牌");
    assert.ok(html.includes("app.js"), "首页应引用 app.js");
  } finally {
    proc.kill();
  }
});

test("静态资源可访问", async () => {
  const { proc, port } = await startLauncher();
  try {
    for (const p of ["/styles.css", "/app.js", "/favicon.svg"]) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(res.status, 200, `${p} 应返回 200`);
    }
  } finally {
    proc.kill();
  }
});

test("状态 API 返回完整结构", async () => {
  const { proc, port } = await startLauncher();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.ok(typeof s.launcher.version === "string");
    assert.ok(Array.isArray(s.dsh.profiles), "profiles 应为数组");
    assert.ok(Array.isArray(s.dsh.sessions), "sessions 应为数组");
    assert.equal(typeof s.gui.online, "boolean");
    assert.equal(typeof s.child.running, "boolean");
    assert.equal(typeof s.headless.running, "boolean");
    assert.ok(s.config.guiPort > 0, "guiPort 应为正整数");
  } finally {
    proc.kill();
  }
});

test("未知 API 返回 404", async () => {
  const { proc, port } = await startLauncher();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`);
    assert.equal(res.status, 404);
  } finally {
    proc.kill();
  }
});

test("路径穿越被拒绝", async () => {
  const { proc, port } = await startLauncher();
  try {
    // 编码后的 ../ 不应泄露 public 目录之外的任何文件
    const r = await rawGet(port, "/..%2Flauncher.js");
    assert.equal(r.status, 403, "穿越路径应被拒绝（403）");
    assert.ok(!r.body.includes("DeepSeek Harness 启动器"), "不应返回后端源码");
  } finally {
    proc.kill();
  }
});

test("SSE 事件流可连接并推送初始状态", async () => {
  const { proc, port } = await startLauncher();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/events`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    // 读取前几帧（初始 state + 心跳前的数据）
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !buf.includes("event: state")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    assert.ok(buf.includes("event: state"), "应收到初始 state 事件");
    reader.cancel();
  } finally {
    proc.kill();
  }
});

test("未监听端口时强制停止返回 404 no-listener", async () => {
  const { proc, port } = await startLauncher();
  try {
    // 用随机高位端口（40000-49999）测试，几乎不可能被真实进程监听
    const unusedPort = 40000 + Math.floor(Math.random() * 10000);
    const res = await fetch(`http://127.0.0.1:${port}/api/force-stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: unusedPort }),
    });
    const data = await res.json();
    assert.equal(res.status, 404);
    assert.equal(data.code, "no-listener");
  } finally {
    proc.kill();
  }
});
