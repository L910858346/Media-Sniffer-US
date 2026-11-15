/**
 * 桌面端交互回归：拖拽定位 + 面板不遮挡按钮 + 可收起
 *   node dev/desktop.mjs
 */
import { launch } from './cdp.mjs';
import fs from 'node:fs/promises';

const SR = `document.getElementById('ts-sniffer-ios-host').shadowRoot`;
const box = (sel) => `(() => {
  const el = ${SR}.querySelector('${sel}');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`;

await fs.mkdir('.shots', { recursive: true });

let fail = 0;
const check = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`, extra === undefined ? '' : extra);
  if (!cond) fail += 1;
};

const W = 1280;
const H = 800;
const b = await launch({ width: W, height: H, dpr: 1 });
try {
  await b.goto('http://127.0.0.1:8787/dev/demo.html');
  await b.waitFor(`window.__tsSniffer && window.__tsSniffer.items().length >= 4`, 15000);

  const f0 = await b.evaluate(box('.fab'));
  await b.mouseDrag(f0.x + 25, f0.y + 25, 700, 400);
  await b.sleep(600);
  const fab = await b.evaluate(box('.fab'));
  check(Math.abs(fab.x - 675) < 6 && Math.abs(fab.y - 375) < 6, '悬浮钮跟手拖到指定位置', JSON.stringify(fab));

  await b.evaluate(`${SR}.querySelector('.fab').click()`);
  await b.waitFor(`${SR}.querySelector('.sheet').classList.contains('open')`, 4000);
  await b.sleep(500);

  const sheet = await b.evaluate(box('.sheet'));
  const inView = sheet.x >= 0 && sheet.y >= 0 && sheet.x + sheet.w <= W && sheet.y + sheet.h <= H;
  const overlap = !(sheet.x + sheet.w <= fab.x || sheet.x >= fab.x + fab.w
    || sheet.y + sheet.h <= fab.y || sheet.y >= fab.y + fab.h);
  const adjacent = Math.abs(sheet.x + sheet.w - fab.x) < 30 || Math.abs(fab.x + fab.w - sheet.x) < 30;

  check(inView, '面板完全在视口内', JSON.stringify(sheet));
  check(!overlap, '面板不遮挡悬浮钮');
  check(adjacent, '面板紧邻悬浮钮');
  await b.screenshot('.shots/desktop.png');

  await b.evaluate(`${SR}.querySelector('.fab').click()`);
  await b.sleep(400);
  const closed = await b.evaluate(`!${SR}.querySelector('.sheet').classList.contains('open')`);
  check(closed, '再点悬浮钮可以收起面板');
} finally {
  await b.close();
}

console.log(fail ? `\n✗ ${fail} 项未通过\n` : '\n✓ 全部通过\n');
process.exit(fail ? 1 : 0);
