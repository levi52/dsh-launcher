/**
 * 由 public/favicon.svg 生成多尺寸 favicon.ico 与 favicon-512.png
 *
 * 开发期工具（非运行时依赖）：需要本机装有 sharp 才能运行。
 * 找不到 sharp 时会给出提示，不会影响启动器本身。
 *
 * 用法：node scripts/generate-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const svgPath = path.join(root, "public", "favicon.svg");
const icoPath = path.join(root, "public", "favicon.ico");
const png512Path = path.join(root, "public", "favicon-512.png");
const png192Path = path.join(root, "public", "favicon-192.png");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

if (!fs.existsSync(svgPath)) {
  console.error(`找不到 ${svgPath}`);
  process.exit(1);
}

/* ---------- 定位 sharp（本机安装位置不固定，逐个尝试） ---------- */
const require = createRequire(import.meta.url);
function tryRequire(dir) {
  try {
    const pkg = path.join(dir, "package.json");
    if (!fs.existsSync(pkg)) return null;
    const mod = require(dir);
    return mod && mod.default ? mod.default : mod;
  } catch {
    return null;
  }
}

let sharp = null;
const candidates = [
  path.join(root, "node_modules", "sharp"),                                            // 本项目 devDependency
  path.join(process.env.USERPROFILE || "", ".dsh", "profiles", "node_modules", "sharp"), // DSH web profile
  path.join(process.env.LOCALAPPDATA || "", "npm-cache", "_npx"),                       // npx 缓存（下面再展开）
];
for (const base of candidates) {
  if (sharp) break;
  if (path.basename(base) === "_npx") {
    try {
      for (const dir of fs.readdirSync(base)) {
        sharp = tryRequire(path.join(base, dir, "node_modules", "sharp"));
        if (sharp) break;
      }
    } catch { /* ignore */ }
  } else {
    sharp = tryRequire(base);
  }
}

if (!sharp) {
  console.error(
    "未找到 sharp，无法渲染 .ico。\n" +
    "可先执行一次：npm i -D sharp  然后重试本脚本。\n" +
    "（启动器运行时不需要 sharp，这只是图标生成工具）"
  );
  process.exit(1);
}

/* ---------- 渲染各尺寸 PNG ---------- */
const svg = fs.readFileSync(svgPath);
const pngs = [];
for (const size of SIZES) {
  const buf = await sharp(svg).resize(size, size).png().toBuffer();
  pngs.push({ size, buf });
  console.log(`  渲染 ${size}x${size} ... ${buf.length} bytes`);
}

const big512 = await sharp(svg).resize(512, 512).png().toBuffer();
fs.writeFileSync(png512Path, big512);
console.log(`已生成 ${path.relative(root, png512Path)}`);

// PWA 图标：192x192（manifest 安装必需）
const big192 = await sharp(svg).resize(192, 192).png().toBuffer();
fs.writeFileSync(png192Path, big192);
console.log(`已生成 ${path.relative(root, png192Path)}`);

/* ---------- 组装 ICO（PNG 帧，Vista+ 兼容） ---------- */
// 布局：ICONDIR(6B) → 全部 ICONDIRENTRY(16B × N) → 全部图像数据
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type: icon
header.writeUInt16LE(count, 4);  // image count

let offset = 6 + 16 * count;
const entries = [];
const blobs = [];
for (const { size, buf } of pngs) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0);  // width（0 = 256）
  entry.writeUInt8(size === 256 ? 0 : size, 1);  // height
  entry.writeUInt8(0, 2);                        // color count
  entry.writeUInt8(0, 3);                        // reserved
  entry.writeUInt16LE(1, 4);                     // planes
  entry.writeUInt16LE(32, 6);                    // bit count
  entry.writeUInt32LE(buf.length, 8);            // bytes in resource
  entry.writeUInt32LE(offset, 12);               // image offset
  offset += buf.length;
  entries.push(entry);
  blobs.push(buf);
}

fs.writeFileSync(icoPath, Buffer.concat([header, ...entries, ...blobs]));
console.log(`已生成 ${path.relative(root, icoPath)}（${count} 个尺寸：${SIZES.join("/")}px）`);
