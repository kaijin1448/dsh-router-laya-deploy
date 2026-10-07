#!/usr/bin/env node
/**
 * build-guide-html.cjs — render docs/router-laya-install-guide.md -> docs/...html
 *
 * Keeps the "edit the .md, re-run the build" loop. Same visual template as the
 * original page (CSS inlined below).
 *
 * dependency: marked. Resolved from, in order: a local ./node_modules, a global
 * install, or ~/.dsh-router-laya/guide-build/node_modules.
 *   quickest install:  npm i -g marked
 * usage:  node scripts/build-guide-html.cjs   (from anywhere; paths are derived)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function loadMarked() {
  const candidates = [
    "marked", // local ./node_modules or NODE_PATH
    path.join(os.homedir(), ".dsh-router-laya", "guide-build", "node_modules", "marked"),
  ];
  for (const c of candidates) {
    try { return require(c); } catch {}
  }
  console.error("Cannot find 'marked'. Install it:  npm i -g marked  (or set NODE_PATH / add a local dep).");
  process.exit(1);
}
const { marked } = loadMarked();

const DIR = __dirname;
const DOCS = path.join(DIR, "..", "docs");
const MD = path.join(DOCS, "router-laya-install-guide.md");
const OUT = path.join(DOCS, "router-laya-install-guide.html");

const CSS = `:root{
  --bg:#ffffff; --fg:#1f2328; --muted:#59636e; --border:#d1d9e0;
  --code-bg:#f6f8fa; --quote-bg:#f6f8fa; --accent:#0969da; --stripe:#f6f8fa;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --border:#30363d;
    --code-bg:#161b22; --quote-bg:#161b22; --accent:#4493f8; --stripe:#161b22;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--fg);
  font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",
       "PingFang SC","Noto Sans SC",Roboto,Helvetica,Arial,sans-serif;
}
.wrap{max-width:1000px;margin:0 auto;padding:40px 24px 120px}
h1,h2,h3{line-height:1.35;font-weight:650;scroll-margin-top:16px}
h1{font-size:1.9rem;margin:0 0 .5em;padding-bottom:.4em;border-bottom:1px solid var(--border)}
h2{font-size:1.35rem;margin:2.2em 0 .7em;padding-top:.7em;border-top:1px solid var(--border)}
h3{font-size:1.08rem;margin:1.7em 0 .5em}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.anchor{opacity:0;margin-left:.4em;font-weight:400;font-size:.85em;transition:opacity .15s}
h1:hover .anchor,h2:hover .anchor,h3:hover .anchor{opacity:.45}
p,li,td,th{overflow-wrap:anywhere}
code{
  font-family:ui-monospace,SFMono-Regular,Consolas,"Cascadia Mono","Liberation Mono",monospace;
  font-size:.875em;background:var(--code-bg);border:1px solid var(--border);
  border-radius:6px;padding:.12em .38em;
}
pre{
  background:var(--code-bg);border:1px solid var(--border);border-radius:8px;
  padding:14px 16px;overflow-x:auto;line-height:1.6;
}
pre code{background:none;border:0;padding:0;font-size:.85em;white-space:pre}
blockquote{
  margin:1.2em 0;padding:.75em 1.1em;background:var(--quote-bg);
  border-left:4px solid var(--accent);border-radius:0 8px 8px 0;
}
blockquote p{margin:.4em 0}
table{border-collapse:collapse;width:100%;margin:1.2em 0;display:block;overflow-x:auto}
th,td{border:1px solid var(--border);padding:8px 12px;text-align:left;vertical-align:top}
th{background:var(--quote-bg);font-weight:600;white-space:nowrap}
tbody tr:nth-child(2n){background:var(--stripe)}
hr{border:0;border-top:1px solid var(--border);margin:2.6em 0}
ol,ul{padding-left:1.6em}
li{margin:.25em 0}
.toc{background:var(--quote-bg);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin:1.8em 0}
.toc summary{cursor:pointer;font-weight:600}
.toc ol{list-style:none;margin:.7em 0 0;padding-left:0}
.toc li{margin:.16em 0}
.toc .lvl3{padding-left:1.5em;font-size:.94em;opacity:.9}
.meta{color:var(--muted);font-size:.9em;margin:-.2em 0 1.8em}
@media print{
  body{background:#fff;color:#000}
  .wrap{max-width:none;padding:0}
  .anchor{display:none}
  .toc{break-inside:avoid}
  pre,blockquote,table{break-inside:avoid}
}`;

const md = fs.readFileSync(MD, "utf8");
let html = marked.parse(md, { gfm: true });

// 1) ids + anchor links on h1/h2/h3, same s1..sN scheme as the original page
let seq = 0;
html = html.replace(/<(h[123])>([\s\S]*?)<\/\1>/g, (_m, tag, inner) => {
  seq += 1;
  const id = `s${seq}`;
  return `<${tag} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="本节链接">#</a></${tag}>`;
});

// 2) TOC from the rendered h2/h3
const items = [...html.matchAll(/<h([23]) id="(s\d+)">([\s\S]*?)<a class="anchor"/g)].map((m) => ({
  level: m[1],
  id: m[2],
  text: m[3].replace(/<[^>]+>/g, "").trim(),
}));
const toc =
  `<details class="toc" open>\n<summary>目录</summary>\n<ol>\n` +
  items
    .map((t) => `  <li class="${t.level === "3" ? "lvl3" : "lvl2"}"><a href="#${t.id}">${t.text}</a></li>`)
    .join("\n") +
  `\n</ol>\n</details>`;

const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-router-laya 安装 / 移植指南</title>
<meta name="generator" content="build-guide-html.cjs (marked)">
<style>
${CSS}
</style>
</head>
<body>
<div class="wrap">
<p class="meta">本页由 <code>router-laya-install-guide.md</code> 生成 · 生成于 ${stamp} · 修改请改 .md 后重跑 <code>node build-guide-html.cjs</code></p>
${toc}
${html}
</div>
</body>
</html>
`;

fs.writeFileSync(OUT, page, "utf8");
console.log("built:", OUT);
console.log("chars:", page.length, "toc items:", items.length, "headings:", seq);
