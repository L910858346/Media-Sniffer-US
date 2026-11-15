/**
 * 在「本机 Chrome + 本机 Tampermonkey」里真跑一次
 *   node dev/tm-live.mjs
 *
 * 为什么是"配置副本"而不是直接开你的 Chrome：
 *   Chrome 157 起明确拒绝在**默认配置目录**上开调试端口
 *   （DevTools remote debugging requires a non-default data directory），
 *   而复制配置后 Chrome 又会校验扩展设置、把 TM 剔除。
 *   这里取折中：每次从你的配置里只复制 Tampermonkey 相关的几项到一个
 *   非默认目录，启动的是同一个 chrome.exe、同一个 TM 5.5.1、同一份 TM 脚本库，
 *   因此脚本跑的确实是 TM 的沙箱与注入链路。
 *
 * 流程：唤醒 TM → 读已装脚本 → 探当前注入 → 走官方安装页覆盖为当前构建
 *       → 复测 diag → 界面功能抽检 → 截图 → 优雅关闭。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SRC = path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data');
const TM = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
// 每次用独立目录：本机 Node 有批量删除保护，重复 rm 同一个大目录会被拦下
const PROFILE = path.resolve(`.tm-live-${Date.now().toString(36)}`);
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`, extra === undefined ? '' : String(extra));
  if (!cond) fail += 1;
  return cond;
};

/* ---------------- 0. 前置：测试服务器必须活着 ---------------- */
try {
  const r = await fetch('http://127.0.0.1:8787/dev/tm.html');
  if (!r.ok) throw new Error(String(r.status));
} catch (e) {
  console.log('✗ 测试服务器未运行（先执行 node dev/server.mjs 8787）:', e.message);
  process.exit(2);
}

/* ---------------- 1. 复制最小可用配置 ---------------- */
await fs.mkdir(path.join(PROFILE, 'Default', 'Extensions'), { recursive: true });
await fs.mkdir(path.join(PROFILE, 'Default', 'Local Extension Settings'), { recursive: true });
const pairs = [
  [path.join(SRC, 'Local State'), path.join(PROFILE, 'Local State'), false],
  [path.join(SRC, 'Default', 'Preferences'), path.join(PROFILE, 'Default', 'Preferences'), false],
  [path.join(SRC, 'Default', 'Secure Preferences'), path.join(PROFILE, 'Default', 'Secure Preferences'), false],
  [path.join(SRC, 'Default', 'Extensions', TM), path.join(PROFILE, 'Default', 'Extensions', TM), true],
  [path.join(SRC, 'Default', 'Local Extension Settings', TM), path.join(PROFILE, 'Default', 'Local Extension Settings', TM), true],
];
for (const [from, to, dir] of pairs) {
  if (!existsSync(from)) continue;
  if (dir) await fs.cp(from, to, { recursive: true });
  else await fs.copyFile(from, to);
}

/* ---------------- 2. 启动 ---------------- */
const child = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=430,900',
    '--window-position=80,60',
    'about:blank',
  ],
  { stdio: 'ignore' }
);
console.log('Chrome 已启动（配置副本：.tm-live）');

let version = null;
for (let i = 0; i < 150 && !version; i++) {
  await sleep(200);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) version = await r.json();
  } catch {
    /* 未就绪 */
  }
}
if (!version) {
  console.log('✗ 调试端口未就绪');
  child.kill();
  process.exit(1);
}

/* ---------------- 3. CDP 客户端 ---------------- */
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let seq = 0;
const pending = new Map();
const events = [];
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(`${m.error.message} (${m.error.code})`)) : res(m.result);
    return;
  }
  if (!m.method) return;
  events.push(m);
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push({ k: 'exception', t: m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text });
  } else if (m.method === 'Runtime.consoleAPICalled') {
    logs.push({ k: m.params.type, t: (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ') });
  }
});
const send = (method, params = {}, sid) =>
  new Promise((res, rej) => {
    const id = ++seq;
    ws.send(JSON.stringify(sid ? { id, method, params, sessionId: sid } : { id, method, params }));
    pending.set(id, { res, rej });
  });

let sid = null;
async function use(targetId) {
  sid = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, sid).catch(() => {});
  await send('Page.enable', {}, sid).catch(() => {});
}
async function evaluate(expr) {
  const r = await send(
    'Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true },
    sid
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function goto(url, timeout = 20000) {
  const done = new Promise((res) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const i = events.findIndex((e) => e.method === 'Page.loadEventFired');
      if (i >= 0) {
        events.splice(i, 1);
        clearInterval(tick);
        res(true);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(tick);
        res(false);
      }
    }, 60);
  });
  await send('Page.navigate', { url }, sid);
  await done;
}
const targets = async () => (await send('Target.getTargets')).targetInfos;
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
}

try {
  /* ---------------- 4. 扩展环境 ---------------- */
  console.log('\n=== 1. 扩展环境 ===');
  const created = await send('Target.createTarget', { url: 'about:blank' });
  await use(created.targetId);

  await goto(`chrome-extension://${TM}/options.html#nav=dashboard`);
  await sleep(2600);
  const dash = await evaluate(`(() => {
    const body = document.body ? document.body.innerText : '';
    return {
      blocked: /已被屏蔽|ERR_BLOCKED_BY_CLIENT/.test(body),
      hasScript: /Media Sniffer|网媒探测/.test(body),
      version: (body.match(/v?(1\\.0\\.0)/) || [])[1] || '',
      head: body.replace(/\\s+/g, ' ').slice(0, 160),
    };
  })()`);
  const tmAlive = !dash.blocked;
  check(tmAlive, 'Tampermonkey 可用（扩展页未被打不开）', dash.blocked ? '被屏蔽' : 'ok');
  check(dash.hasScript === true, 'TM 脚本库里存在本项目脚本', dash.version || dash.head);

  /* ---------------- 5. 装脚本前的注入探测 ---------------- */
  console.log('\n=== 2. 注入探测（页面不直接引入脚本，只能靠 TM） ===');
  await goto(`http://127.0.0.1:8787/dev/tm.html?before=${Date.now()}`);
  await sleep(3200);
  const before = await evaluate(`(() => ({
    hook: typeof window.__tsSniffer,
    hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
    ver: window.__tsSnifferVersion || '',
    diag: (window.__tsSniffer && window.__tsSniffer.diag) ? window.__tsSniffer.diag() : null,
  }))()`);
  console.log('   ', JSON.stringify(before));
  check(before.hook === 'object' || before.hosts === 1, '已装脚本能在 TM 中注入执行', `${before.hook}/${before.hosts}`);

  /* ---------------- 6. 覆盖安装当前构建 ---------------- */
  console.log('\n=== 3. 走 TM 官方安装页覆盖为当前构建 ===');
  await goto(`http://127.0.0.1:8787/media-sniffer.user.js?t=${Date.now()}`);
  await sleep(2800);

  // TM 可能把安装页放在当前标签，也可能另开标签
  const pages = (await targets()).filter((t) => t.type === 'page');
  let button = null;
  for (const p of pages) {
    try {
      await use(p.targetId);
      const found = await evaluate(`(() => {
        const els = [...document.querySelectorAll('button, input[type=button], input[type=submit], a')];
        const el = els.find((e) => /^(安装|重新安装|更新|Install|Reinstall|Update)$/i.test(((e.textContent || e.value || '').trim())));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { text: (el.textContent || el.value || '').trim(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (found) {
        button = found;
        break;
      }
    } catch {
      /* 该标签不可读，跳过 */
    }
  }
  check(!!button, '安装页出现「安装/重新安装/更新」按钮', button ? `${button.text} @${button.x},${button.y}` : '未找到');
  if (button) {
    await clickAt(button.x, button.y);
    await sleep(2500);
    // TM 可能在此刻跳转/另开标签，旧 session 会失效；再扫一次是否有二次确认
    for (const p of (await targets()).filter((t) => t.type === 'page')) {
      try {
        await use(p.targetId);
        const again = await evaluate(`(() => {
          const els = [...document.querySelectorAll('button, input[type=button], input[type=submit], a')];
          const el = els.find((e) => /^(确定|确认|安装|OK|Confirm)$/i.test(((e.textContent || e.value || '').trim())));
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        if (again) {
          console.log('    二次确认:', JSON.stringify(again));
          await clickAt(again.x, again.y);
          await sleep(2000);
          break;
        }
      } catch {
        /* 标签已失效，跳过 */
      }
    }
  }

  /* ---------------- 7. 覆盖后复测 ---------------- */
  console.log('\n=== 4. 覆盖后复测（这才代表当前代码） ===');
  const fresh = await send('Target.createTarget', { url: 'about:blank' });
  await use(fresh.targetId);
  await goto(`http://127.0.0.1:8787/dev/tm.html?after=${Date.now()}`);
  await sleep(3400);
  const after = await evaluate(`(() => ({
    hook: typeof window.__tsSniffer,
    ver: window.__tsSnifferVersion || '',
    hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
    diag: (window.__tsSniffer && window.__tsSniffer.diag) ? window.__tsSniffer.diag() : null,
  }))()`);
  console.log('   ', JSON.stringify(after));
  check(after.diag !== null, '当前构建已生效（diag 可取到）', after.ver);
  if (after.diag) {
    check(after.diag.mounted === true, '界面已挂载', JSON.stringify(after.diag.mounted));
    check(after.diag.isTop === true && after.diag.topCertain === true, '沙箱下角色判定为「确定顶层」', `${after.diag.isTop}/${after.diag.topCertain}`);
    check(after.diag.gen === after.diag.alive, '所有权令牌一致', `${after.diag.gen}/${after.diag.alive}`);
    check(after.hosts === 1, '页面上只有一个宿主', after.hosts);
  }

  /* ---------------- 8. 端到端：探测 → 下载 → 结果 ---------------- */
  console.log('\n=== 5. 端到端：触发媒体 → 探测 → 下载 ===');
  // 下载落到项目内的临时目录，不污染用户「下载」文件夹
  const dlDir = path.resolve('.dl-live');
  await fs.rm(dlDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir }).catch(() => {});

  // 页面自带 simulate()：注入后再触发一次，确保请求发生在钩子装好之后
  await evaluate(`(typeof simulate === 'function' ? (simulate(), true) : false)`).catch(() => {});
  await sleep(2600);

  const items = await evaluate(`(() => {
    const api = window.__tsSniffer;
    if (!api || !api.items) return null;
    const list = api.items();
    return { count: list.length, kinds: [...new Set(list.map((i) => i.kind))].slice(0, 6) };
  })()`);
  console.log('    探测结果:', JSON.stringify(items));
  check(items && items.count > 0, '真实 TM 环境下能探测到媒体', items && items.count);
  if (items && items.count) check((items.kinds || []).some((k) => ['ts','m3u8','mp4','video'].includes(k)), '识别出视频类条目', JSON.stringify(items.kinds));

  if (items && items.count) {
    const clicked = await evaluate(`(async () => {
      const host = document.getElementById('ts-sniffer-ios-host');
      const sr = host && host.shadowRoot;
      if (!sr) return 'no-ui';
      const sheet = sr.querySelector('.sheet');
      if (!sheet.classList.contains('open')) sr.querySelector('.fab').click();
      await new Promise((r) => setTimeout(r, 500));
      const btn = sr.querySelector('.row [data-act="download"]') || sr.querySelector('[data-act="download"]');
      if (!btn) return 'no-btn';
      btn.click();
      return 'clicked';
    })()`);
    console.log('    下载触发:', clicked);
    if (clicked === 'clicked') {
      let job = null;
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        job = await evaluate(`(() => { const j = (window.__tsSniffer.jobs() || [])[0]; return j ? { status: j.status, msg: j.message || j.msg || '', bytes: j.received || j.bytes || 0 } : null; })()`);
        if (job && (job.status === 'done' || job.status === 'error')) break;
      }
      console.log('    任务结果:', JSON.stringify(job));
      check(!!job && job.status === 'done', '下载任务完成', job ? `${job.status} ${job.msg}` : '无任务');
      const files = await fs.readdir(dlDir).catch(() => []);
      check(files.length > 0, '文件已落盘', JSON.stringify(files.slice(0, 3)));
      if (files.length) {
        const buf = await fs.readFile(path.join(dlDir, files[0]));
        // MPEG-TS 每个包都以 0x47 开头；AES 密文则是随机字节
        const syncOk = buf.length > 376 && buf[0] === 0x47 && buf[188] === 0x47;
        check(syncOk, '落盘内容是合法 MPEG-TS（非密文）', `head=0x${buf[0].toString(16)} len=${buf.length}`);
      }
    }
  }

  /* ---------------- 8a. 跨域分片（走 GM 特权通道）下载后再刷新 ---------------- */
  console.log('\n=== 5a. 跨域分片（GM 通道）下载 → 刷新（更接近真实站点） ===');
  {
    const xurl = `http://127.0.0.1:8787/dev/tm.html?xorigin=1&x=${Date.now()}`;
    await goto(xurl);
    await sleep(2200);
    await evaluate(`(typeof simulate === 'function' ? (simulate(), true) : false)`).catch(() => {});
    await sleep(4200);
    const xi = await evaluate(`(() => {
      const api = window.__tsSniffer;
      if (!api) return null;
      const list = api.items();
      const hasX = list.some((i) => /8788/.test(i.url || ''));
      return { count: list.length, hasCrossOrigin: hasX };
    })()`);
    console.log('    跨域条目:', JSON.stringify(xi));
    check(!!xi && xi.hasCrossOrigin === true, '抓到跨域分片（必然走 GM 通道）', JSON.stringify(xi));
    const xclick = await evaluate(`(async () => {
      const sr = document.getElementById('ts-sniffer-ios-host').shadowRoot;
      const sheet = sr.querySelector('.sheet');
      if (!sheet.classList.contains('open')) sr.querySelector('.fab').click();
      await new Promise((r) => setTimeout(r, 500));
      const rows = [...sr.querySelectorAll('.row')];
      const row = rows.find((r) => /8788/.test(r.textContent || '')) || rows[0];
      const btn = row && row.querySelector('[data-act="download"]');
      if (!btn) return 'no-btn';
      btn.click();
      return 'clicked';
    })()`);
    console.log('    跨域下载触发:', xclick);
    let xjob = null;
    for (let i = 0; i < 70; i++) {
      await sleep(500);
      xjob = await evaluate(`(() => { const j = (window.__tsSniffer.jobs() || [])[0]; return j ? { status: j.status, msg: j.message || '' } : null; })()`);
      if (xjob && (xjob.status === 'done' || xjob.status === 'error')) break;
    }
    console.log('    跨域任务:', JSON.stringify(xjob));
    check(!!xjob && xjob.status === 'done', '跨域分片下载完成', xjob ? `${xjob.status} ${xjob.msg}` : '无');

    // 关键：保存之后刷新
    logs.length = 0;
    await goto(`http://127.0.0.1:8787/dev/tm.html?xorigin=1&reload=${Date.now()}`);
    await sleep(3400);
    const xr = await evaluate(`(() => ({
      boot: document.documentElement.dataset.tssBoot || '',
      hook: typeof window.__tsSniffer,
      diag: (window.__tsSniffer && window.__tsSniffer.diag) ? window.__tsSniffer.diag() : null,
      hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
    }))()`);
    console.log('    刷新后:', JSON.stringify(xr).slice(0, 320));
    const ok = xr.diag ? xr.diag.mounted === true : xr.hosts === 1;
    if (!check(ok, '跨域下载后刷新仍正常', JSON.stringify(xr))) {
      console.log('      异常日志:', JSON.stringify(logs.filter((l) => l.k === 'exception' || l.k === 'error').slice(0, 4)));
    }
  }

  /* ---------------- 8b. 复现：保存之后刷新 / 跳转 ---------------- */
  console.log('\n=== 5b. 保存后刷新 / 跳转（用户报的失效场景） ===');
  for (const [label, url] of [
    ['刷新同一页', `http://127.0.0.1:8787/dev/tm.html?reload=${Date.now()}`],
    ['跳转到另一页', `http://127.0.0.1:8787/dev/plain.html?nav=${Date.now()}`],
  ]) {
    logs.length = 0;
    await goto(url);
    await sleep(3400);
    const st = await evaluate(`(() => ({
      hook: typeof window.__tsSniffer,
      diag: (window.__tsSniffer && window.__tsSniffer.diag) ? window.__tsSniffer.diag() : null,
      hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
      boot: document.documentElement.dataset.tssBoot || '',
      alive: window.__tsSnifferAlive,
      gen: window.__tsSnifferGen,
      settings: (() => { try { return localStorage.getItem('tss_ios_settings_v2'); } catch (e) { return 'ERR'; } })(),
    }))()`);
    console.log(`    ${label}:`, JSON.stringify(st).slice(0, 400));
    const alive = st.diag ? st.diag.mounted === true : st.hosts === 1;
    if (!check(alive, `${label} 后脚本仍正常运行`, JSON.stringify(st.diag || { hook: st.hook, hosts: st.hosts }))) {
      const errs = logs.filter((l) => l.k === 'exception' || l.k === 'error');
      console.log('      异常日志:', JSON.stringify(errs.slice(0, 4)));
    }
  }

  /* ---------------- 9. 界面上手 ---------------- */
  console.log('\n=== 6. 界面功能抽检 ===');
  const ui = await evaluate(`(async () => {
    const host = document.getElementById('ts-sniffer-ios-host');
    const sr = host && host.shadowRoot;
    if (!sr) return { ok: false };
    const sheet = sr.querySelector('.sheet');
    // 上一步可能已经打开过：只在关闭时才点，避免点成关闭
    if (!sheet.classList.contains('open')) sr.querySelector('.fab').click();
    await new Promise((r) => setTimeout(r, 500));
    const open = sr.querySelector('.sheet').classList.contains('open');
    const tabs = [...sr.querySelectorAll('.tabs .tab')].map((t) => t.textContent.trim());
    const items = sr.querySelectorAll('.item').length;
    sr.querySelector('.gear[data-act="settings"]').click();
    await new Promise((r) => setTimeout(r, 500));
    const modal = sr.querySelector('.modal');
    const title = modal ? modal.querySelector('.modal-title').textContent : '';
    if (modal) sr.querySelector('.mask').click();
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, open, tabs, items, title };
  })()`);
  check(ui.ok === true, 'Shadow DOM 界面可操作', JSON.stringify(ui));
  check(ui.open === true, '面板可打开', String(ui.open));
  check(['全部', '视频', '图片', '音频'].every((t) => (ui.tabs || []).includes(t)), '页签完整', JSON.stringify(ui.tabs));
  check(/设置 · v/.test(ui.title || ''), '设置面板可打开', ui.title);

  const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  await fs.writeFile('.shots/real-tm.png', Buffer.from(shot.data, 'base64'));
  console.log('    截图: .shots/real-tm.png');

  /* ---------------- 9. 控制台 ---------------- */
  console.log('\n=== 7. 控制台异常 ===');
  const errs = logs.filter((l) => l.k === 'exception' || l.k === 'error');
  const snifferLogs = logs.filter((l) => /Media Sniffer/.test(l.t));
  console.log('    注入日志:', snifferLogs.map((l) => l.t).slice(0, 3));
  check(errs.length === 0, '无未捕获异常 / error 日志', errs.slice(0, 2).map((e) => e.t).join(' | '));

  console.log(fail ? `\n失败 ${fail} 项` : '\n全部通过');
} catch (e) {
  console.log('✗ 执行异常:', e.message);
  fail += 1;
} finally {
  try {
    await send('Browser.close');
  } catch {
    /* 忽略 */
  }
  await sleep(600);
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
  process.exit(fail ? 1 : 0);
}
