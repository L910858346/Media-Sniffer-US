/**
 * 用「v1.0.0 原始版本」在真实 TM 里复现「下载保存后刷新不启动」
 *   node dev/tm-oldbuild.mjs
 *
 * 背景：用户报"这个问题在 v1.0.0 发布前修过、现在又回来了"。而上一轮我们
 * 无法写进用户真实 Chrome（Chrome 157 禁止默认目录开调试端口），覆盖安装
 * 只发生在**副本**里——用户日常浏览器里装的很可能仍是原始 v1.0.0。
 * 这里直接用原始版本跑一遍用户报的流程，验证它是否真的有这个 bug。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SRC = path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data');
const TM = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const PROFILE = path.resolve(`.tm-old-${Date.now().toString(36)}`);
const PORT = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`, extra === undefined ? '' : String(extra));
  if (!cond) fail += 1;
  return cond;
};

await fs.mkdir(path.join(PROFILE, 'Default', 'Extensions'), { recursive: true });
await fs.mkdir(path.join(PROFILE, 'Default', 'Local Extension Settings'), { recursive: true });
for (const [from, to, dir] of [
  [path.join(SRC, 'Local State'), path.join(PROFILE, 'Local State'), false],
  [path.join(SRC, 'Default', 'Preferences'), path.join(PROFILE, 'Default', 'Preferences'), false],
  [path.join(SRC, 'Default', 'Secure Preferences'), path.join(PROFILE, 'Default', 'Secure Preferences'), false],
  [path.join(SRC, 'Default', 'Extensions', TM), path.join(PROFILE, 'Default', 'Extensions', TM), true],
  [path.join(SRC, 'Default', 'Local Extension Settings', TM), path.join(PROFILE, 'Default', 'Local Extension Settings', TM), true],
]) {
  if (!existsSync(from)) continue;
  if (dir) await fs.cp(from, to, { recursive: true });
  else await fs.copyFile(from, to);
}

const child = spawn(CHROME, [
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--window-size=430,900', 'about:blank',
], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 150 && !version; i++) {
  await sleep(200);
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) version = await r.json(); } catch {}
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let seq = 0;
const pending = new Map();
const evs = [];
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(`${m.error.message} (${m.error.code})`)) : res(m.result);
    return;
  }
  evs.push(m);
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160));
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 200));
  }
});
const send = (method, params = {}, sid) =>
  new Promise((res, rej) => { const id = ++seq; ws.send(JSON.stringify(sid ? { id, method, params, sessionId: sid } : { id, method, params })); pending.set(id, { res, rej }); });
let sid = null;
async function use(t) {
  sid = (await send('Target.attachToTarget', { targetId: t, flatten: true })).sessionId;
  await send('Runtime.enable', {}, sid).catch(() => {});
  await send('Page.enable', {}, sid).catch(() => {});
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function goto(url) {
  const p = new Promise((res) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const i = evs.findIndex((e) => e.method === 'Page.loadEventFired');
      if (i >= 0) { evs.splice(i, 1); clearInterval(tick); res(true); }
      else if (Date.now() - t0 > 20000) { clearInterval(tick); res(false); }
    }, 60);
  });
  await send('Page.navigate', { url }, sid);
  await p;
}

try {
  const tab = await send('Target.createTarget', { url: 'about:blank' });
  await use(tab.targetId);

  console.log('=== 1. 安装 v1.0.0 原始版本 ===');
  await goto(`http://127.0.0.1:8787/media-sniffer.user.js?old=${Date.now()}`);
  await sleep(2600);
  const pos = await ev(`(() => {
    const el = [...document.querySelectorAll('button, input[type=button], a')]
      .find((e) => /^(安装|重新安装|更新|Install|Reinstall|Update)$/i.test(((e.textContent || e.value || '').trim())));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: el.textContent.trim() };
  })()`);
  check(!!pos, '安装页出现按钮', pos ? pos.text : '未找到');
  if (pos) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, sid);
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, sid);
    await sleep(2600);
  }

  console.log('\n=== 2. 下载并保存（v1.0.0 流程） ===');
  await goto(`http://127.0.0.1:8787/dev/tm.html?r1=${Date.now()}`);
  await sleep(3000);
  const mounted1 = await ev(`document.querySelectorAll('#ts-sniffer-ios-host').length`);
  check(mounted1 === 1, '初始界面已挂载', mounted1);
  await ev(`(typeof simulate === 'function' ? (simulate(), true) : false)`).catch(() => {});
  await sleep(2500);
  await ev(`(async () => {
    const sr = document.getElementById('ts-sniffer-ios-host').shadowRoot;
    const sheet = sr.querySelector('.sheet');
    if (!sheet.classList.contains('open')) sr.querySelector('.fab').click();
    await new Promise((r) => setTimeout(r, 500));
    const b = sr.querySelector('.row [data-act="download"]'); if (b) b.click();
    return true;
  })()`).catch(() => {});
  // v1.0.0 不暴露 __tsSniffer 到页面，只能盯任务卡的文字
  let savedText = '';
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    savedText = await ev(`(() => {
      const h = document.getElementById('ts-sniffer-ios-host');
      const sr = h && h.shadowRoot;
      if (!sr) return '';
      const j = sr.querySelector('.job, .jobs .job, [class*="job"]');
      return j ? j.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : '';
    })()`).catch(() => '');
    if (/已保存|保存|error|失败|密文/.test(savedText)) break;
  }
  console.log('    任务卡:', savedText || '(未找到)');
  check(!!savedText, '任务卡有内容', savedText || '无');

  console.log('\n=== 3. 刷新页面 ===');
  logs.length = 0;
  await goto(`http://127.0.0.1:8787/dev/tm.html?r2=${Date.now()}`);
  await sleep(3500);
  const after = await ev(`(() => ({
    hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
    href: location.href.slice(0, 60),
    proto: location.protocol,
  }))()`);
  console.log('    刷新后:', JSON.stringify(after));
  check(after.hosts === 1, '刷新后界面仍挂载', after.hosts);
  check(after.proto === 'http:', '仍是 http 文档（未被 blob 导航）', after.href);

  console.log('\n=== 4. 再跳转一次 ===');
  logs.length = 0;
  await goto(`http://127.0.0.1:8787/dev/plain.html?r3=${Date.now()}`);
  await sleep(3000);
  const after2 = await ev(`document.querySelectorAll('#ts-sniffer-ios-host').length`);
  check(after2 === 1, '跳转后界面仍挂载', after2);

  console.log('\n注入日志:', logs.filter((l) => /Sniffer/.test(l)).slice(0, 5).join('\n  ') || '(无)');
  console.log(fail ? `\n失败 ${fail} 项` : '\n全部通过');
} finally {
  try { await send('Browser.close'); } catch {}
  await sleep(500);
  try { child.kill(); } catch {}
  process.exit(0);
}
