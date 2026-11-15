/**
 * 跨域内嵌页：悬浮球必须合并为宿主页唯一一个
 *   node dev/frames.mjs
 *
 * 用户报的场景：网页带内嵌播放器时出现多个悬浮窗，内嵌页的悬浮窗被框死在
 * 内嵌页里。根因是 ack 校验里 `e.source !== window.parent`——跨域子帧的脚本
 * 沙箱里这两个对象身份对不上，ack 永远不认，子帧就各自挂界面。
 * 修复后：子帧等 ack（2.6s 冷静期内收到就根本不挂），宿主页只剩一个悬浮球，
 * 且子帧探测到的媒体会合并进宿主页列表。
 */
import { launch } from './cdp.mjs';

let fail = 0;
const check = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`, extra === undefined ? '' : String(extra));
  if (!cond) fail += 1;
};

const b = await launch({ width: 390, height: 844, dpr: 1 });
try {
  console.log('=== 1. 宿主页只挂一个悬浮球 ===');
  await b.goto(`http://127.0.0.1:8787/dev/embed-cross.html?t=${Date.now()}`);
  await b.sleep(4200); // 跨过 2.6s 冷静期 + ack 往返

  const top = await b.evaluate(`(() => ({
    hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
    childFab: window.__childFabCount,
    ver: window.__tsSnifferVersion || '',
  }))()`);
  console.log('  ', JSON.stringify(top));
  check(top.hosts === 1, '宿主页只有一个宿主节点', top.hosts);
  check(top.childFab === 0, '跨域子帧里没有悬浮球（已合并）', String(top.childFab));
  check(top.ver !== '', '宿主页脚本在运行', top.ver);

  console.log('\n=== 2. 子帧的媒体合并进宿主页列表 ===');
  const merged = await b.evaluate(`(async () => {
    const sr = document.getElementById('ts-sniffer-ios-host').shadowRoot;
    const sheet = sr.querySelector('.sheet');
    if (!sheet.classList.contains('open')) sr.querySelector('.fab').click();
    await new Promise((r) => setTimeout(r, 500));
    const rows = [...sr.querySelectorAll('.list .row')].map((r) => r.textContent.replace(/\s+/g, ' '));
    return {
      rows,
      childMedia: rows.filter((t) => /内嵌页/.test(t)).length,
      mergeBtn: rows.some((t) => /合并下载/.test(t)),
    };
  })()`);
  console.log('  ', JSON.stringify(merged.rows, null, 1));
  check(merged.rows.length > 0, '宿主页探测到媒体', merged.rows.length);
  check(merged.childMedia > 0, '列表里有跨域子帧的媒体（标记「内嵌页」）', merged.childMedia);
  check(merged.mergeBtn === true, '子帧媒体可从宿主页发起下载（「合并下载」按钮）', merged.mergeBtn);

  console.log('\n=== 3. 宿主页悬浮球可自由拖动（顶层坐标） ===');
  const drag = await b.evaluate(`(() => {
    const sr = document.getElementById('ts-sniffer-ios-host').shadowRoot;
    const fab = sr.querySelector('.fab');
    const r = fab.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await b.mouseDrag(drag.x, drag.y, drag.x - 80, drag.y - 120, 10);
  await b.sleep(400);
  const pos = await b.evaluate(`(() => {
    const fab = document.getElementById('ts-sniffer-ios-host').shadowRoot.querySelector('.fab');
    const r = fab.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), inTop: true };
  })()`);
  check(pos.x < drag.x - 40 && pos.y < drag.y - 80, '悬浮球已跟随拖拽', JSON.stringify(pos));

  console.log(fail ? `\\n失败 ${fail} 项` : '\\n全部通过');
  if (fail) process.exitCode = 1;
} finally {
  await b.close();
}
