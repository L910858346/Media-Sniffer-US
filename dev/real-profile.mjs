/**
 * 真实 Chrome profile + Tampermonkey 实测
 *   node dev/real-profile.mjs            # 只探测（不改动已装脚本）
 *   node dev/real-profile.mjs --install  # 探测 + 装入当前目录的脚本再验证
 *
 * 与 dev/cdp.mjs 的区别：那是临时 profile 的无头浏览器，**不装任何扩展**；
 * 这里直接用本机日常配置，脚本跑在 Tampermonkey 真实沙箱里——"有时不运行"
 * 只可能在这种环境里复现。
 *
 * 前置：Chrome 必须完全退出（同一 user-data-dir 不能被两个实例同时占用）。
 * 本脚本不会替你杀进程；检测到 Chrome 在跑就直接退出并提示。
 *
 * 结束后**不关闭浏览器**：它就是你日常的 Chrome，留着继续用即可。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import fs from 'node:fs/promises';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));
const REAL_PROFILE = path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data');
const argOf = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const USER_DATA = path.resolve(argOf('profile', REAL_PROFILE));
const IS_REAL = USER_DATA.toLowerCase() === path.resolve(REAL_PROFILE).toLowerCase();
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const PORT = Number(argOf('port', '9222'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DO_INSTALL = process.argv.includes('--install');

const SR = `(document.getElementById('ts-sniffer-ios-host') || {}).shadowRoot`;

async function chromeRunning() {
  const { execSync } = await import('node:child_process');
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' });
    return (out.match(/chrome\.exe/g) || []).length;
  } catch {
    return 0;
  }
}

async function waitPort(timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* 未就绪 */
    }
    await sleep(200);
  }
  throw new Error('调试端口未就绪');
}

/** 极简 CDP：够用即可 */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
      logs.push({ type: 'exception', text: m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text });
    } else if (m.method === 'Runtime.consoleAPICalled') {
      logs.push({
        type: m.params.type,
        text: (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '),
      });
    }
  });
  const send = (method, params = {}, sid) => {
    const id = ++seq;
    ws.send(JSON.stringify(sid ? { id, method, params, sessionId: sid } : { id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  let sid = null;
  async function use(targetId) {
    const r = await send('Target.attachToTarget', { targetId, flatten: true });
    sid = r.sessionId;
    await send('Page.enable', {}, sid).catch(() => {});
    await send('Runtime.enable', {}, sid).catch(() => {});
  }
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  async function goto(url) {
    const p = new Promise((res) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        const i = events.findIndex((e) => e.method === 'Page.loadEventFired');
        if (i >= 0) {
          events.splice(i, 1);
          clearInterval(tick);
          res(true);
        } else if (Date.now() - t0 > 25000) {
          clearInterval(tick);
          res(false);
        }
      }, 60);
    });
    await send('Page.navigate', { url }, sid);
    await p;
  }
  async function targets() {
    return (await send('Target.getTargets')).targetInfos;
  }
  async function click(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
  }
  async function shot(file) {
    const r = await send('Page.captureScreenshot', { format: 'png' }, sid);
    await fs.writeFile(file, Buffer.from(r.data, 'base64'));
  }
  const close = () => { try { ws.close(); } catch {} };
  return { send, use, evaluate, goto, targets, click, shot, close, logs };
}

const check = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`, extra === undefined ? '' : extra);
  return cond;
};
let fail = 0;

// 用真实配置目录时，必须没有其它 Chrome 实例占用它
if (IS_REAL) {
  const running = await chromeRunning();
  if (running > 0) {
    console.log(`✗ 检测到 ${running} 个 chrome.exe 正在运行。`);
    console.log('  同一 user-data-dir 不能被两个实例共用，请先完全退出 Chrome 再重试。');
    process.exit(2);
  }
  // Chrome 157 拒绝在**默认**配置目录上开调试端口，这里提前讲清楚
  console.log('注意：Chrome 157 不允许在默认配置目录上开调试端口，');
  console.log('      若失败请改用 --profile=<非默认路径的配置副本>。\n');
}

console.log('启动真实 Chrome（配置：', USER_DATA, '）');
const child = spawn(CHROME, [
  `--user-data-dir=${USER_DATA}`,
  `--remote-debugging-port=${PORT}`,
  ...(IS_REAL ? ['--restore-last-session'] : []),
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

let version;
try {
  version = await waitPort();
} catch (e) {
  console.error('✗', e.message);
  process.exit(3);
}
console.log('  Chrome:', version.Browser);

const b = await attach(version.webSocketDebuggerUrl);
let pageId = null;
try {
  const ts = await b.targets();
  const tmTarget = ts.find((t) => (t.url || '').includes(TM_ID));
  console.log(`\n=== 1. 扩展环境 ===`);
  check(!!tmTarget, 'Tampermonkey 已加载', tmTarget ? tmTarget.type : '未找到');

  // 新建一个自己的标签页：不碰用户恢复出来的那些标签，结束时只关自己的
  const created = await b.send('Target.createTarget', { url: 'about:blank' });
  pageId = created.targetId;
  await b.use(pageId);

  console.log(`\n=== 2. 已装脚本（TM 面板） ===`);
  await b.goto(`chrome-extension://${TM_ID}/options.html#nav=dashboard`);
  await sleep(2200);
  const dash = await b.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.script')];
    return {
      blocked: /已被屏蔽|ERR_BLOCKED_BY_CLIENT/.test(document.body.innerText || ''),
      rows: rows.map((r) => ({
        text: r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90),
        disabled: r.classList.contains('disabled') || !!r.querySelector('.disabled'),
      })),
    };
  })()`);
  check(!dash.blocked, '扩展页面可访问（未被 Chrome 屏蔽）', dash.blocked ? '被屏蔽' : '');
  const mine = (dash.rows || []).filter((r) => /Media Sniffer|网媒探测/.test(r.text));
  check(mine.length > 0, 'TM 中确实装有本项目脚本', JSON.stringify(mine));
  if (mine.length) console.log('   ', JSON.stringify(mine));

  console.log(`\n=== 3. 页面注入（仅 TM，不直接引入脚本） ===`);
  await b.goto(`http://127.0.0.1:8787/dev/tm.html?real=${Date.now()}`);
  await sleep(3200);
  const probe = await b.evaluate(`(() => ({
    hook: typeof window.__tsSniffer,
    diag: (window.__tsSniffer && window.__tsSniffer.diag) ? window.__tsSniffer.diag() : null,
    hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
    ver: window.__tsSnifferVersion || '',
  }))()`);
  console.log('   ', JSON.stringify(probe));
  check(probe.hook === 'object', '脚本在 TM 沙箱中执行（页面可取到调试接口）', probe.hook);
  check(probe.diag ? probe.diag.mounted === true : probe.hosts === 1, '界面已挂载', JSON.stringify(probe.diag));

  if (DO_INSTALL) {
    console.log(`\n=== 4. 装入当前脚本 ===`);
    await b.goto(`http://127.0.0.1:8787/media-sniffer.user.js?t=${Date.now()}`);
    await sleep(2500);
    const inst = await b.evaluate(`(() => {
      const btns = [...document.querySelectorAll('button, input[type=button], input[type=submit], a')];
      return btns.map((el) => ({
        text: (el.textContent || el.value || '').trim(),
        id: el.id || '', cls: el.className || '',
      })).filter((x) => x.text).slice(0, 12);
    })()`);
    console.log('    安装页按钮:', JSON.stringify(inst));
    const pick = inst.find((x) => /^(安装|重新安装|更新|Install|Reinstall|Update)$/i.test(x.text));
    check(!!pick, '安装页出现「安装/更新」按钮', pick ? pick.text : '未找到');
    if (pick) {
      const pos = await b.evaluate(`(() => {
        const el = [...document.querySelectorAll('button, input[type=button], input[type=submit], a')]
          .find((e) => /^(安装|重新安装|更新|Install|Reinstall|Update)$/i.test(((e.textContent || e.value || '').trim())));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (pos) await b.click(pos.x, pos.y);
      await sleep(2500);
      console.log(`\n=== 5. 重装后复测 ===`);
      await b.goto(`http://127.0.0.1:8787/dev/tm.html?re=${Date.now()}`);
      await sleep(3200);
      const after = await b.evaluate(`(() => ({
        hook: typeof window.__tsSniffer,
        diag: (window.__tsSniffer && window.__tsSniffer.diag) ? window.__tsSniffer.diag() : null,
        hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
      }))()`);
      console.log('   ', JSON.stringify(after));
      if (!check(after.diag && after.diag.mounted === true, '重装后界面正常', JSON.stringify(after.diag))) fail += 1;
      if (after.diag) {
        if (!check(after.diag.isTop === true && after.diag.topCertain === true, '角色判定为「确定顶层」', `${after.diag.isTop}/${after.diag.topCertain}`)) fail += 1;
        if (!check(after.diag.gen === after.diag.alive, '所有权令牌一致', `${after.diag.gen}/${after.diag.alive}`)) fail += 1;
      }
      await b.shot('.shots/real-tm.png');
      console.log('    截图: .shots/real-tm.png');
    }
  }

  console.log(`\n=== 6. 控制台异常 ===`);
  const errs = b.logs.filter((l) => l.type === 'exception' || l.type === 'error');
  check(errs.length === 0, '无未捕获异常/错误日志', errs.slice(0, 3).map((e) => e.text).join(' | '));
  if (errs.length) fail += 1;

  console.log(fail ? `\n失败 ${fail} 项` : '\n全部通过');
} finally {
  // 只关掉本次自己开的标签页；浏览器保持运行，用户的标签页原样保留
  try {
    if (pageId) await b.send('Target.closeTarget', { targetId: pageId });
  } catch {
    /* 忽略 */
  }
  // 不断开端口、不关闭浏览器：这就是用户日常的 Chrome，留着继续用
  b.close();
  void child;
}
