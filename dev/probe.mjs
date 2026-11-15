/**
 * 界面走查：驱动无头 Chrome 跑一遍真实交互，逐帧截图
 *   node dev/probe.mjs
 */
import { launch } from './cdp.mjs';
import fs from 'node:fs/promises';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = '.shots';
await fs.mkdir(OUT, { recursive: true });
const SR = `document.getElementById('ts-sniffer-ios-host').shadowRoot`;
const box = (sel) => `(() => {
  const el = ${SR}.querySelector('${sel}');
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
           right: Math.round(b.right), bottom: Math.round(b.bottom) };
})()`;

const browser = await launch({ width: 390, height: 844, dpr: 1 });
const log = (...a) => console.log(...a);

try {
  await browser.goto(`${BASE}/dev/demo.html`);
  await browser.waitFor(`window.__tsSniffer && window.__tsSniffer.items().length >= 4`, 15000);

  const items = await browser.evaluate(`window.__tsSniffer.items().map(i => ({
    kind: i.kind, name: i.name, count: i.count, size: i.size
  }))`);
  log('\n=== 探测到的条目 ===');
  for (const it of items) log(` ${it.kind.padEnd(5)} ${String(it.count).padStart(3)}  ${it.name}`);

  const view = await browser.evaluate(`({ w: innerWidth, h: innerHeight, scrollW: document.documentElement.scrollWidth })`);
  log('\n=== 视口 ===', JSON.stringify(view));

  await browser.screenshot(`${OUT}/1-fab.png`);

  // === 悬浮窗拖拽 ===
  const fabBefore = await browser.evaluate(`(() => {
    const r = ${SR}.querySelector('.fab').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y) };
  })()`);
  await browser.mouseDrag(fabBefore.x + 25, fabBefore.y + 25, 120, 320);
  await browser.sleep(600); // 拖完有 350ms 的误触抑制，等它过去
  const fabAfter = await browser.evaluate(`(() => {
    const r = ${SR}.querySelector('.fab').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), saved: localStorage.getItem('tss_fab_pos') };
  })()`);
  const dragOk = Math.abs(fabAfter.x - 95) < 6 && Math.abs(fabAfter.y - 295) < 6 && !!fabAfter.saved;
  log(`\n=== 拖拽 ===\n 从 ${JSON.stringify(fabBefore)} 拖到 ${JSON.stringify({ x: fabAfter.x, y: fabAfter.y })}，记录 ${fabAfter.saved}`);
  log(dragOk ? '✓ 位置跟随拖动并已持久化' : '✗ 拖拽未生效');
  if (!dragOk) process.exitCode = 1;
  await browser.screenshot(`${OUT}/2-drag.png`);

  await browser.evaluate(`${SR}.querySelector('.fab').click()`);
  await browser.waitFor(`${SR}.querySelector('.sheet').classList.contains('open')`, 4000);
  await browser.sleep(450);
  await browser.screenshot(`${OUT}/3-panel.png`);
  log('面板', JSON.stringify(await browser.evaluate(box('.sheet'))));

  // 选 master.m3u8（主列表）验证清晰度弹层
  await browser.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.row')];
    const row = rows.find(r => r.querySelector('.row-name').textContent.includes('master'));
    row.querySelector('[data-act="download"]').click();
  })()`);
  await browser.waitFor(`${SR}.querySelector('.mask .modal-body .btn')`, 8000);
  await browser.sleep(400);
  await browser.screenshot(`${OUT}/4-quality.png`);
  log('清晰度弹层', JSON.stringify(await browser.evaluate(box('.modal'))));

  const options = await browser.evaluate(`[...${SR}.querySelectorAll('.mask .modal-body .btn')].map(b => b.innerText.replace(/\\n/g,' '))`);
  log('选项:', JSON.stringify(options));

  // 选最高码率
  await browser.evaluate(`${SR}.querySelector('.mask .modal-body .btn').click()`);
  await browser.sleep(600);
  await browser.screenshot(`${OUT}/4-progress.png`);

  await browser.waitFor(`${SR}.querySelector('.job .bar.done')`, 25000);
  await browser.sleep(500);
  await browser.screenshot(`${OUT}/5-done.png`);
  const done = await browser.evaluate(`(() => {
    const j = ${SR}.querySelector('.job');
    return { text: j.innerText.replace(/\\n+/g, ' | '), w: Math.round(j.getBoundingClientRect().width) };
  })()`);
  log('\n=== 完成卡片 ===\n', done.text, '\n宽度', done.w);
  const codecDetail = await browser.evaluate(
    `window.__tsSniffer.jobs().map((j) => j.detail || '').join(' | ')`
  );
  const codecOk = /H\.264/.test(codecDetail) && /AAC/.test(codecDetail);
  log(codecOk ? '✓ 识别出 H.264 + AAC' : '✗ 没报出编码信息');
  if (!codecOk) process.exitCode = 1;

  // === 端到端：AES-128 轨道，验证浏览器里的 WebCrypto 解密 ===
  await browser.evaluate(`${SR}.querySelector('.job [data-act="dismiss"]').click()`);
  await browser.sleep(200);
  await browser.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.row')];
    // 现在还有 enc2 / enc3 的分片分组，必须精确点到 enc 这条 M3U8
    const row = rows.find((r) => r.querySelector('.tag').textContent === 'M3U8'
      && r.querySelector('.row-name').textContent.trim() === 'enc / index.m3u8');
    row.querySelector('[data-act="download"]').click();
  })()`);
  await browser.waitFor(`${SR}.querySelector('.mask .modal-body .btn')`, 8000);
  await browser.evaluate(`${SR}.querySelector('.mask .modal-body .btn').click()`);
  await browser.waitFor(`${SR}.querySelector('.job .bar.done')`, 25000);
  await browser.sleep(300);

  const verify = await browser.evaluate(`(async () => {
    const job = window.__tsSniffer.jobs().find(j => j.status === 'done' && j.item.url.includes('/enc/'));
    if (!job || !job.blob) return '找不到加密任务';
    const a = new Uint8Array(await job.blob.arrayBuffer());
    const b = new Uint8Array(await (await fetch('/hls/enc/plain.bin?v=1')).arrayBuffer());
    if (a.length !== b.length) return '长度不符 ' + a.length + ' vs ' + b.length;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return '第 ' + i + ' 字节不符';
    return 'MATCH ' + a.length + ' B';
  })()`);
  log('\n=== AES-128 端到端 ===\n', verify, verify.startsWith('MATCH') ? '✓' : '✗');
  if (!verify.startsWith('MATCH')) process.exitCode = 1;

  await browser.screenshot(`${OUT}/7-enc-done.png`);

  // === 回归：204 空响应必须报错，而不是产出一个 0 字节的"视频" ===
  await browser.evaluate(`${SR}.querySelector('.job [data-act="dismiss"]').click()`);
  await browser.sleep(200);
  await browser.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.row')];
    const row = rows.find(r => r.querySelector('.row-name').textContent.includes('zero'));
    if (row) row.querySelector('[data-act="download"]').click();
  })()`);
  await browser.waitFor(`${SR}.querySelector('.mask .modal-body .btn')`, 8000);
  await browser.evaluate(`${SR}.querySelector('.mask .modal-body .btn').click()`);
  await browser.waitFor(`${SR}.querySelector('.job .job-msg.err')`, 20000);
  const zeroCase = await browser.evaluate(`(() => {
    const j = window.__tsSniffer.jobs()[0];
    return { status: j.status, msg: j.message, detail: j.detail || j.message, size: j.bytes, hasUrl: !!j.objectUrl };
  })()`);
  log('\n=== 204 空响应回归 ===\n', JSON.stringify(zeroCase));
  const zeroOk = zeroCase.status === 'error' && /空/.test(zeroCase.msg);
  log(zeroOk ? '✓ 被正确拦下，没有产出坏文件' : '✗ 仍然把空响应当成功了');
  if (!zeroOk) process.exitCode = 1;
  await browser.screenshot(`${OUT}/8-zero-error.png`);

  // === 回归：分片带前缀字节时，包对齐要能自动修复 ===
  await browser.evaluate(`${SR}.querySelector('.job [data-act="dismiss"]').click()`);
  await browser.sleep(200);
  await browser.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.row')];
    const row = rows.find(r => r.querySelector('.row-name').textContent.trim().startsWith('off'));
    if (row) row.querySelector('[data-act="download"]').click();
  })()`);
  await browser.waitFor(`${SR}.querySelector('.mask .modal-body .btn')`, 8000);
  await browser.evaluate(`${SR}.querySelector('.mask .modal-body .btn').click()`);
  await browser.waitFor(`${SR}.querySelector('.job .bar.done')`, 20000);
  const offCase = await browser.evaluate(`(() => {
    const j = window.__tsSniffer.jobs()[0];
    return { status: j.status, msg: j.message, detail: j.detail || j.message, size: j.bytes };
  })()`);
  log('\n=== 逐段杂质修复 ===\n', JSON.stringify(offCase));
  const offOk = offCase.status === 'done' && /已修复/.test(offCase.detail || offCase.msg);
  log(offOk ? '✓ 自动裁齐并提示修复内容' : '✗ 修复未生效');
  if (!offOk) process.exitCode = 1;
  await browser.screenshot(`${OUT}/9-off-repaired.png`);

  // === TS 分组：应自动改走同目录播放列表 ===
  await browser.evaluate(`${SR}.querySelector('.job [data-act="dismiss"]').click()`);
  await browser.sleep(200);
  await browser.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.row')];
    const row = rows.find(r => r.tagName && r.querySelector('.tag').textContent === 'TS'
      && r.querySelector('.row-name').textContent.trim() === '720p');
    if (row) row.querySelector('[data-act="download"]').click();
  })()`);
  await browser.waitFor(`${SR}.querySelector('.job .bar.done')`, 20000);
  const groupCase = await browser.evaluate(`(() => {
    const j = window.__tsSniffer.jobs()[0];
    return { status: j.status, msg: j.message, detail: j.detail || j.message, size: j.bytes, total: j.total };
  })()`);
  log('\n=== TS 分组自动改走播放列表 ===\n', JSON.stringify(groupCase));
  const groupOk = groupCase.status === 'done' && /H\.264/.test(groupCase.detail || groupCase.msg) && groupCase.total === 6;
  log(groupOk ? '✓ 走播放列表、6 片全部拿到、结构可播' : '✗ 分组路径仍然有问题');
  if (!groupOk) process.exitCode = 1;
  await browser.screenshot(`${OUT}/9-group.png`);

  // 设置弹层
  await browser.evaluate(`${SR}.querySelector('.job [data-act="dismiss"]').click()`);
  await browser.sleep(200);
  await browser.evaluate(`${SR}.querySelector('[data-act="settings"]').click()`);
  await browser.sleep(400);
  await browser.screenshot(`${OUT}/6-settings.png`);
  await browser.evaluate(`${SR}.querySelector('.mask [data-close]').click()`);

  // 折叠回去，验证悬浮按钮位置
  await browser.sleep(260);
  await browser.evaluate(`${SR}.querySelector('[data-act="close"]').click()`);
  await browser.sleep(450);
  await browser.screenshot(`${OUT}/8-fab.png`);
  log('悬浮按钮', JSON.stringify(await browser.evaluate(box('.fab'))));
} finally {
  await browser.close();
}
