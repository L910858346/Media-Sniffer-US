/**
 * 真实 Chrome + Tampermonkey 环境驱动。
 *
 * 目的：不再只跑临时 profile 的无头浏览器，而是在**本机真实 Chrome 配置**里验证，
 * 让脚本跑在 Tampermonkey 的沙箱与注入链路下——正是"偶发不运行"最容易暴露的地方。
 *
 * 做法：
 *   1. 复制本机 Chrome 的 Default 配置中 Tampermonkey 需要的那几项
 *      （扩展本体、扩展存储、Preferences、Secure Preferences、Local State）
 *   2. 用副本启动一个独立 Chrome（带 --remote-debugging-port），**不加 --disable-extensions**
 *   3. 用 CDP 驱动：装脚本、开页面、收控制台错误
 *
 * 只读用户原配置，所有改动都落在副本里，不会影响日常浏览器。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

export const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const USER_DATA = path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把 Tampermonkey 相关配置复制到独立目录（幂等） */
export async function prepareProfile(dir) {
  const root = path.resolve(dir);
  const def = path.join(root, 'Default');
  const src = path.join(USER_DATA, 'Default');
  await fs.mkdir(def, { recursive: true });
  await fs.mkdir(path.join(def, 'Extensions'), { recursive: true });
  await fs.mkdir(path.join(def, 'Local Extension Settings'), { recursive: true });

  const copies = [
    ['Local State', path.join(USER_DATA, 'Local State'), path.join(root, 'Local State')],
    ['Preferences', path.join(src, 'Preferences'), path.join(def, 'Preferences')],
    ['Secure Preferences', path.join(src, 'Secure Preferences'), path.join(def, 'Secure Preferences')],
    ['Local State 副本', path.join(src, 'Local State'), path.join(def, 'Local State')],
  ];
  for (const [label, from, to] of copies) {
    if (!existsSync(from)) continue;
    await fs.copyFile(from, to).catch(() => {});
    void label;
  }

  const trees = [
    [path.join(src, 'Extensions', TM_ID), path.join(def, 'Extensions', TM_ID)],
    [
      path.join(src, 'Local Extension Settings', TM_ID),
      path.join(def, 'Local Extension Settings', TM_ID),
    ],
  ];
  for (const [from, to] of trees) {
    if (!existsSync(from)) continue;
    await fs.cp(from, to, { recursive: true, force: true }).catch(() => {});
  }

  // 把 LevelDB 的锁文件删掉，否则副本会被当成"正在被另一个进程占用"
  for (const rel of ['Local Extension Settings', 'Local Storage/leveldb', 'Session Storage']) {
    const d = path.join(def, rel, TM_ID);
    for (const f of ['LOCK', 'LOG']) {
      await fs.rm(path.join(d, f), { force: true }).catch(() => {});
    }
  }
  return root;
}

async function waitForPort(port, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('Chrome 调试端口没起来');
}

/**
 * 启动真实 Chrome（带扩展）并返回一个精简 CDP 客户端。
 * @param {{profile:string, port?:number, width?:number, height?:number, headed?:boolean}} opts
 */
export async function launchReal({ profile, port = 9333, width = 430, height = 900, headed = true } = {}) {
  const args = [
    `--user-data-dir=${path.resolve(profile)}`,
    '--profile-directory=Default',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    `--window-size=${width},${height}`,
    '--window-position=60,40',
    '--allow-running-insecure-content',
    'about:blank',
  ];
  if (!headed) args.unshift('--headless=new');

  const child = spawn(CHROME, args, { stdio: 'ignore', detached: false });
  const version = await waitForPort(port);

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  const events = [];
  /** 控制台/异常日志，按 target 混在一起，排查时按文本看即可 */
  const logs = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    events.push(msg);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const t = (msg.params.args || [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ');
      logs.push({ type: msg.params.type, text: t, url: msg.params.stackTrace?.callFrames?.[0]?.url || '' });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push({
        type: 'exception',
        text: d.exception?.description || d.text,
        url: d.url || d.stackTrace?.callFrames?.[0]?.url || '',
      });
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      logs.push({ type: e.level, text: e.text, url: e.url || '' });
    }
  });

  const send = (method, params = {}, sessionId) => {
    const id = ++seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  // 用浏览器级会话；每次 goto 前重建 Page 会话，保证切页后事件仍可用
  let sessionId = null;
  let attachedTarget = null;

  async function attach(targetId) {
    if (attachedTarget === targetId) return;
    const r = await send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = r.sessionId;
    attachedTarget = targetId;
    await send('Page.enable', {}, sessionId).catch(() => {});
    await send('Runtime.enable', {}, sessionId).catch(() => {});
    await send('Log.enable', {}, sessionId).catch(() => {});
  }

  /** 启动时浏览器已经开了一个 about:blank，先接管它，避免首次 goto 找不到会话 */
  async function attachExistingPage() {
    const { targetInfos } = await send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (page) await attach(page.targetId);
    return page ? page.targetId : null;
  }
  await attachExistingPage();

  async function newTab(url = 'about:blank') {
    const { targetId } = await send('Target.createTarget', { url });
    await attach(targetId);
    await send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 2, mobile: false },
      sessionId
    ).catch(() => {});
    return targetId;
  }

  async function goto(url, timeout = 20000) {
    const loaded = new Promise((resolve) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        const i = events.findIndex((e) => e.method === 'Page.loadEventFired');
        if (i >= 0) {
          events.splice(i, 1);
          clearInterval(tick);
          resolve(true);
        } else if (Date.now() - t0 > timeout) {
          clearInterval(tick);
          resolve(false);
        }
      }, 60);
    });
    await send('Page.navigate', { url }, sessionId);
    await loaded;
  }

  async function evaluate(expression) {
    const res = await send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      sessionId
    );
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result && res.result.value;
  }

  async function waitFor(expression, timeout = 15000, interval = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const v = await evaluate(expression);
        if (v) return v;
      } catch {
        /* 页面可能还没就绪 */
      }
      await sleep(interval);
    }
    throw new Error('waitFor 超时: ' + expression);
  }

  /** 真实输入事件（Tampermonkey 沙箱下 click() 与真实点击可能不同，尽量用真的） */
  async function realClick(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await sleep(50);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
  }

  async function screenshot(file) {
    const res = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await fs.writeFile(file, Buffer.from(res.data, 'base64'));
    return file;
  }

  async function targets() {
    const { targetInfos } = await send('Target.getTargets');
    return targetInfos;
  }

  async function close() {
    try {
      await send('Browser.close');
    } catch {
      /* 忽略 */
    }
    try {
      ws.close();
    } catch {
      /* 忽略 */
    }
    await sleep(300);
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  }

  return {
    evaluate,
    goto,
    waitFor,
    newTab,
    attach,
    send,
    realClick,
    screenshot,
    targets,
    close,
    sleep,
    logs: () => logs.slice(),
    clearLogs: () => logs.splice(0, logs.length),
    port,
    version,
  };
}

/** 用 TM 的 dashboard 页面判断装了什么（读页面里的脚本列表文本） */
export async function tmSummary(b) {
  const list = await b.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#script-list .script, .script-list .script')];
    return rows.slice(0, 20).map((r) => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120));
  })()`);
  return list;
}
