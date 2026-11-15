/**
 * 新格式与外观设置回归
 *   node dev/formats.mjs
 *
 * 覆盖：
 *   · 直链视频 .mov / .avi 能被探测并下载成对应扩展名
 *   · 图片 .jpg / .png 能被探测；6KB 的小图会被过滤；无扩展名的靠 Content-Type 认出来
 *   · 设置里的五套主题、透明度滑块可用，且没有多余的入口
 */
import { launch } from './cdp.mjs';
import fs from 'node:fs/promises';

// 截图目录必须自己建：删掉 .shots 后整套测试不该因此中断
await fs.mkdir('.shots', { recursive: true });

const SR = `document.getElementById('ts-sniffer-ios-host').shadowRoot`;

let fail = 0;
const check = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`, extra === undefined ? '' : extra);
  if (!cond) fail += 1;
};

const b = await launch({ width: 390, height: 844, dpr: 1 });

const rows = () =>
  b.evaluate(`[...${SR}.querySelectorAll('.row')].map((r) => ({
    tag: r.querySelector('.tag').textContent,
    name: r.querySelector('.row-name').textContent.trim(),
  }))`);

const clickRow = (tag, name) =>
  b.evaluate(`(() => {
    const list = [...${SR}.querySelectorAll('.row')];
    const row = list.find((r) => r.querySelector('.tag').textContent === ${JSON.stringify(tag)}
      && r.querySelector('.row-name').textContent.trim() === ${JSON.stringify(name)});
    if (!row) return 'missing';
    row.querySelector('[data-act="download"]').click();
    return 'ok';
  })()`);

const waitDone = () =>
  b
    .waitFor(`(() => { const j = window.__tsSniffer.jobs()[0]; return j && j.status !== 'running'; })()`, 30000)
    .catch(() => null);

const job = () =>
  b.evaluate(`(() => {
    const j = window.__tsSniffer.jobs()[0];
    return j ? { status: j.status, msg: j.message, name: j.filename, size: j.bytes } : null;
  })()`);

try {
  await b.goto('http://127.0.0.1:8787/dev/demo.html');
  await b.waitFor(`window.__tsSniffer && window.__tsSniffer.items().length >= 6`, 15000);
  await b.sleep(600);

  await b.evaluate(`${SR}.querySelector('.fab').click()`);
  await b.sleep(450);

  /* ---------------- 1. 格式探测 ---------------- */
  console.log('\n=== 1. 视频 / 图片探测 ===');
  const list = await rows();
  const has = (tag, name) => list.some((r) => r.tag === tag && r.name === name);

  check(has('VIDEO', 'clip.mov'), '识别 .mov', JSON.stringify(list.filter((r) => r.tag === 'VIDEO')));
  check(has('VIDEO', 'clip.avi'), '识别 .avi');
  check(has('IMG', 'pic.jpg'), '识别 .jpg');
  check(has('IMG', 'logo.png'), '识别 .png');
  check(has('IMG', 'img'), '无扩展名靠 Content-Type 认出图片');
  check(!has('IMG', 'tiny.gif'), '6KB 小图被过滤，不占列表');

  /* ---------------- 2. 下载扩展名 ---------------- */
  console.log('\n=== 2. 直链下载 ===');
  check((await clickRow('IMG', 'pic.jpg')) === 'ok', '点到 JPEG');
  await waitDone();
  await b.sleep(300);
  const imgJob = await job();
  console.log('  任务:', JSON.stringify(imgJob));
  check(!!imgJob && imgJob.status === 'done', '图片下载成功');
  check(!!imgJob && /^\d{14}\.jpg$/.test(imgJob.name || ''), '扩展名按实际格式给 .jpg', imgJob && imgJob.name);

  await b.evaluate(`${SR}.querySelector('.job [data-act="dismiss"]').click()`);
  await b.sleep(200);

  check((await clickRow('VIDEO', 'clip.mov')) === 'ok', '点到 MOV');
  await waitDone();
  await b.sleep(300);
  const movJob = await job();
  console.log('  任务:', JSON.stringify(movJob));
  check(!!movJob && movJob.status === 'done', 'MOV 下载成功');
  check(!!movJob && /^\d{14}\.mov$/.test(movJob.name || ''), '扩展名 .mov', movJob && movJob.name);

  await b.evaluate(`${SR}.querySelector('.job [data-act="dismiss"]').click()`);
  await b.sleep(250);

  /* ---------------- 3. 设置面板 ---------------- */
  console.log('\n=== 3. 设置面板（主题 / 透明度） ===');
  await b.evaluate(`${SR}.querySelector('[data-act="settings"]').click()`);
  await b.waitFor(`${SR}.querySelector('.mask .swatches')`, 4000);
  await b.sleep(300);

  const panel = await b.evaluate(`(() => {
    const mask = ${SR}.querySelector('.mask');
    return {
      swatches: mask.querySelectorAll('.swatch').length,
      hasRange: !!mask.querySelector('.range'),
      rows: mask.querySelectorAll('[data-set]').length,
      text: mask.innerText.replace(/\\n+/g, ' | '),
    };
  })()`);
  console.log('  面板:', panel.text.slice(0, 160));
  check(panel.swatches === 10, '十套主题色块', panel.swatches);
  check(panel.hasRange, '有透明度滑块');
  check(panel.rows === 4, '设置分组为 主题 / 不透明度 / 开关与工具 / 恢复默认', panel.rows);

  // 默认主题：悬浮窗应是蓝紫渐变
  const fabDefault = await b.evaluate(`(() => {
    const f = ${SR}.querySelector('.fab');
    return { img: getComputedStyle(f).backgroundImage, icon: getComputedStyle(f.querySelector('svg')).fill };
  })()`);
  check(/linear-gradient/.test(fabDefault.img), '默认主题悬浮窗是蓝紫渐变', fabDefault.img.slice(0, 48));

  // 切到棕色
  await b.evaluate(`(${SR}.querySelector('.swatch[data-theme="brown"]')).click()`);
  await b.sleep(250);
  const brown = await b.evaluate(`(() => {
    const root = ${SR}.querySelector('.root');
    return {
      theme: root.dataset.theme,
      panel: getComputedStyle(root).getPropertyValue('--panel').trim(),
      accent: getComputedStyle(root).getPropertyValue('--accent').trim(),
      on: ${SR}.querySelector('.swatch.on').dataset.theme,
    };
  })()`);
  console.log('  棕色:', JSON.stringify(brown));
  check(brown.theme === 'brown' && brown.on === 'brown', '主题切到「棕」');
  check(brown.panel === '#2e2420', '棕色底色生效', brown.panel);
  await b.screenshot('.shots/theme-brown.png');

  // 切到白色
  await b.evaluate(`(${SR}.querySelector('.swatch[data-theme="white"]')).click()`);
  await b.sleep(250);
  const white = await b.evaluate(`(() => {
    const root = ${SR}.querySelector('.root');
    return { theme: root.dataset.theme, panel: getComputedStyle(root).getPropertyValue('--panel').trim(), text: getComputedStyle(${SR}.querySelector('.row-name')).color };
  })()`);
  console.log('  白色:', JSON.stringify(white));
  check(white.panel === '#ffffff', '白色底色生效', white.panel);
  check(/rgb\(23, 32, 44\)/.test(white.text), '白色主题下文字为深色', white.text);

  // 白主题下悬浮窗必须也是白的（之前它一直吃 --accent，仍是蓝紫）
  const fabWhite = await b.evaluate(`(() => {
    const f = ${SR}.querySelector('.fab');
    const cs = getComputedStyle(f);
    return { bg: cs.backgroundColor, img: cs.backgroundImage, icon: getComputedStyle(f.querySelector('svg')).fill };
  })()`);
  console.log('  白主题悬浮窗:', JSON.stringify(fabWhite));
  check(fabWhite.bg === 'rgb(255, 255, 255)' && fabWhite.img === 'none', '白主题悬浮窗是白色', fabWhite.bg);
  check(/rgb\(27, 36, 49\)/.test(fabWhite.icon), '白主题悬浮窗图标为深色', fabWhite.icon);
  await b.screenshot('.shots/theme-white.png');

  // 透明度
  await b.evaluate(`(() => {
    const r = ${SR}.querySelector('.range');
    r.value = 40;
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await b.sleep(300);
  const op = await b.evaluate(`(() => {
    const root = ${SR}.querySelector('.root');
    return {
      css: root.style.getPropertyValue('--fab-opacity'),
      fab: getComputedStyle(${SR}.querySelector('.fab')).opacity,
      label: ${SR}.querySelector('[data-op-val]').textContent,
    };
  })()`);
  console.log('  透明度:', JSON.stringify(op));
  check(op.css === '0.4', '滑到 40% 写入变量', op.css);
  check(Number(op.fab) <= 0.45, '悬浮钮实际变透明', op.fab);
  check(op.label === '40%', '数值同步显示', op.label);

  // 1% 步进：滑到 41 也能生效
  await b.evaluate(`(() => {
    const r = ${SR}.querySelector('.range');
    r.value = 41;
    r.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await b.sleep(250);
  const op41 = await b.evaluate(`(${SR}.querySelector('[data-op-val]')).textContent`);
  check(op41 === '41%', '透明度支持 1% 步进', op41);

  // 持久化
  const saved = await b.evaluate(`localStorage.getItem('tss_ios_settings_v2')`);
  check(/"theme":"white"/.test(saved || '') && /"fabOpacity":0.41/.test(saved || ''), '设置已写入本地', saved);

  /* ---------------- 4. 换页只留当前页 ---------------- */
  console.log('\n=== 4. 换页重置 ===');
  await b.evaluate(`${SR}.querySelector('.mask [data-close]')?.click()`);
  await b.sleep(250);
  const beforeCount = await b.evaluate(`window.__tsSniffer.items().length`);
  await b.evaluate(`history.pushState({}, '', location.pathname + '?ep=2')`);
  await b.sleep(1300);
  const afterCount = await b.evaluate(`window.__tsSniffer.items().length`);
  console.log('  条目数:', beforeCount, '->', afterCount);
  check(beforeCount > 5 && afterCount === 0, 'URL 变化后列表清空（只留当前页）', `${beforeCount} -> ${afterCount}`);

  // 新页面的资源还能正常进来
  await b.evaluate(`fetch('/media/pic.jpg?ep=2').catch(() => {})`);
  await b.sleep(700);
  const afterNew = await b.evaluate(`window.__tsSniffer.items().length`);
  check(afterNew >= 1, '新页面的资源照常记录', afterNew);
} finally {
  await b.close();
}

console.log(fail ? `\n✗ ${fail} 项未通过\n` : '\n✓ 全部通过\n');
process.exit(fail ? 1 : 0);
