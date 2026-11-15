/**
 * 极简 CDP 客户端：用来在没有 Playwright 的环境里驱动无头 Chrome。
 * 只实现本项目需要的那几个命令。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(120);
  }
  throw new Error('Chrome 调试端口没起来');
}

export async function launch({ width = 390, height = 844, dpr = 1, port = 9333, mobile = width < 620 } = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tsniff-'));
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  const version = await waitForPort(port);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  const events = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  const send = (method, params = {}, sessionId) => {
    const id = ++seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: dpr, mobile },
    sessionId
  );

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

  async function goto(url) {
    const loaded = new Promise((resolve) => {
      const check = setInterval(() => {
        const i = events.findIndex((e) => e.method === 'Page.loadEventFired');
        if (i >= 0) {
          events.splice(i, 1);
          clearInterval(check);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 15000);
    });
    await send('Page.navigate', { url }, sessionId);
    await loaded;
  }

  async function waitFor(expression, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const v = await evaluate(expression);
        if (v) return v;
      } catch {
        /* 页面可能还没就绪 */
      }
      await sleep(120);
    }
    throw new Error('waitFor 超时: ' + expression);
  }

  /** 真实鼠标事件（会同时产生 pointer 事件），用来测拖拽 */
  async function mouseDrag(x0, y0, x1, y1, steps = 8) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 }, sessionId);
    for (let i = 1; i <= steps; i++) {
      await send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, button: 'left', buttons: 1 },
        sessionId
      );
      await sleep(16);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 }, sessionId);
  }

  async function screenshot(file, clip) {
    const params = { format: 'png', captureBeyondViewport: false };
    if (clip) params.clip = { scale: 1, ...clip };
    const res = await send('Page.captureScreenshot', params, sessionId);
    await fs.writeFile(file, Buffer.from(res.data, 'base64'));
    return file;
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
    child.kill();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  return { evaluate, goto, waitFor, screenshot, close, sleep, send, sessionId, mouseDrag, events: () => events.slice() };
}
