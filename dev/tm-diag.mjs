/**
 * TM 存活分阶段体检
 *   node dev/tm-diag.mjs
 *
 * 目的：定位「TM 从哪一步开始不再注入任何页面」。
 * 每阶段都查三件事：TM 服务工作线程在不在、扩展页打不打得开、目标页有没有 boot 标记。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SRC = path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data');
const TM = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const PROFILE = path.resolve(`.tm-diag-${Date.now().toString(36)}`);
const PORT = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 复制来的扩展不算商店安装，Chrome 会在一段时间后判为「可能已损坏」并停用。
// 打开开发者模式可保住它，测试环境才稳定（否则测到一半 TM 就没了）。
try {
  const prefPath = path.join(PROFILE, 'Default', 'Preferences');
  const pref = JSON.parse(await fs.readFile(prefPath, 'utf8'));
  pref.extensions = pref.extensions || {};
  pref.extensions.ui = pref.extensions.ui || {};
  pref.extensions.ui.developer_mode = true;
  await fs.writeFile(prefPath, JSON.stringify(pref));
} catch (e) {
  console.log('设置开发者模式失败:', e.message);
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
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) version = await r.json();
  } catch {}
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let seq = 0;
const pending = new Map();
const evs = [];
const swLogs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(`${m.error.message} (${m.error.code})`)) : res(m.result);
    return;
  }
  evs.push(m);
  if (m.method === 'Runtime.exceptionThrown') {
    swLogs.push('EXC ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 200));
  } else if (m.method === 'Runtime.consoleAPICalled') {
    swLogs.push(m.params.type + ' ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
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
const targets = async () => (await send('Target.getTargets')).targetInfos;

/** 读 chrome://extensions 里 TM 的真实状态（启用/停用/报错） */
async function extState() {
  let tid = null;
  try {
    tid = (await send('Target.createTarget', { url: 'chrome://extensions/' })).targetId;
    const s2 = (await send('Target.attachToTarget', { targetId: tid, flatten: true })).sessionId;
    await sleep(900);
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const mgr = document.querySelector('extensions-manager');
        if (!mgr) return { err: 'no-manager' };
        const list = mgr.shadowRoot.querySelector('extensions-item-list');
        const items = list ? [...list.shadowRoot.querySelectorAll('extensions-item')] : [];
        const tm = items.find((i) => (i.getAttribute('id') || '').includes('dhdgffkk'));
        const txt = tm ? (tm.shadowRoot.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140) : '';
        return { total: items.length, tmFound: !!tm, tmText: txt };
      })()`,
      returnByValue: true,
    }, s2);
    return r.result?.value;
  } catch (e) {
    return { err: e.message };
  } finally {
    if (tid) await send('Target.closeTarget', { targetId: tid }).catch(() => {});
  }
}

async function health(label) {
  const ts = await targets();
  const sw = ts.find((t) => (t.url || '').includes(TM));
  const dash = ts.find((t) => t.type === 'page' && (t.url || '').includes('options.html'));
  let dashOk = 'n/a';
  if (dash) {
    try {
      const s = await send('Target.attachToTarget', { targetId: dash.targetId, flatten: true });
      const r = await send('Runtime.evaluate', { expression: `(() => { const b = document.body ? document.body.innerText : ''; return /已被屏蔽|ERR_BLOCKED/.test(b) ? 'BLOCKED' : (b.length > 0 ? 'ok' : 'empty'); })()`, returnByValue: true }, s.sessionId);
      dashOk = r.result?.value;
    } catch { dashOk = 'err'; }
  }
  console.log(`  [${label}] TM-SW=${sw ? 'yes' : 'NO'} 扩展页=${dashOk} 页面数=${ts.filter((t) => t.type === 'page').length}`);
  return !!sw;
}

try {
  const c = await send('Target.createTarget', { url: 'about:blank' });
  await use(c.targetId);

  await goto(`chrome-extension://${TM}/options.html#nav=dashboard`);
  await sleep(2200);
  await health('启动后');

  console.log('\n阶段 0：空白页对照（未做任何下载）');
  await goto(`http://127.0.0.1:8787/dev/plain.html?p0=${Date.now()}`);
  await sleep(2600);
  console.log('  href=', await ev(`location.href`), '| title=', await ev(`document.title`));
  console.log('  href=', await ev(`location.href`), '| boot=', await ev(`document.documentElement.dataset.tssBoot || ''`), 'hosts=', await ev(`document.querySelectorAll('#ts-sniffer-ios-host').length`));
  await health('阶段0后');

  console.log('\n阶段 1：普通页面注入');
  await goto(`http://127.0.0.1:8787/dev/tm.html?a=${Date.now()}`);
  await sleep(3000);
  console.log('  href=', await ev(`location.href`), '| boot=', await ev(`document.documentElement.dataset.tssBoot || ''`), 'hosts=', await ev(`document.querySelectorAll('#ts-sniffer-ios-host').length`));
  await health('阶段1后');

  console.log('\n阶段 2：同源下载保存');
  await ev(`(typeof simulate === 'function' ? (simulate(), true) : false)`).catch(() => {});
  await sleep(2500);
  await ev(`(async () => {
    const sr = document.getElementById('ts-sniffer-ios-host').shadowRoot;
    const sheet = sr.querySelector('.sheet');
    if (!sheet.classList.contains('open')) sr.querySelector('.fab').click();
    await new Promise((r) => setTimeout(r, 400));
    const b = sr.querySelector('.row [data-act="download"]'); if (b) b.click(); return true;
  })()`).catch(() => {});
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const j = await ev(`(() => { const x = (window.__tsSniffer.jobs() || [])[0]; return x ? x.status : ''; })()`).catch(() => '');
    if (j === 'done' || j === 'error') { console.log('  job=', j); break; }
  }
  await health('阶段2后');
  console.log('  扩展状态:', JSON.stringify(await extState()));

  console.log('\n阶段 3：跨域页面注入');
  await goto(`http://127.0.0.1:8787/dev/tm.html?xorigin=1&b=${Date.now()}`);
  await sleep(3200);
  console.log('  href=', await ev(`location.href`), '| boot=', await ev(`document.documentElement.dataset.tssBoot || ''`), 'hosts=', await ev(`document.querySelectorAll('#ts-sniffer-ios-host').length`));
  await health('阶段3后');
  console.log('  扩展状态:', JSON.stringify(await extState()));

  console.log('\n阶段 4：普通页面再注入');
  await goto(`http://127.0.0.1:8787/dev/plain.html?c=${Date.now()}`);
  await sleep(2600);
  console.log('  href=', await ev(`location.href`), '| boot=', await ev(`document.documentElement.dataset.tssBoot || ''`), 'hosts=', await ev(`document.querySelectorAll('#ts-sniffer-ios-host').length`));
  await health('阶段4后');

  console.log('\nTM 服务工作线程日志（最后 10 条）:');
  console.log(swLogs.slice(-10).join('\n') || '  (无)');
} finally {
  try { await send('Browser.close'); } catch {}
  await sleep(500);
  try { child.kill(); } catch {}
  process.exit(0);
}
