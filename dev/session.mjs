/**
 * 会话级回归：v2.2.0 的「实时跟随当前媒体」
 *   node dev/session.mjs
 *
 * 覆盖：
 *   1. 同一个 URL 下播放器换源 → 列表自动重置（SPA 内部切换场景）
 *   2. 静音的预览小窗换源 → 不清列表（防误杀）
 *   3. 正在播放的条目置顶 + 「▶ 播放中」标记
 *   4. 缩略图：图片=原图 / 直链视频=首帧 / 流式=图标
 *   5. 行键控复用：重渲染不重新请求缩略图
 *   6. 「探测提示」开关 → 红色角标立即消失/恢复
 */
import { launch } from './cdp.mjs';

const SR = `document.getElementById('ts-sniffer-ios-host').shadowRoot`;
let pass = 0;
let fail = 0;
function check(ok, label, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail !== undefined ? ' · ' + detail : ''}`);
  }
}

const b = await launch({ width: 390, height: 844, dpr: 1 });
try {
  await b.goto('http://127.0.0.1:8787/dev/demo.html');
  await b.waitFor(`window.__tsSniffer && window.__tsSniffer.items().length >= 6`, 15000);
  await b.sleep(800);

  /* ---------------- 1. 换源重置（URL 不变） ---------------- */
  console.log('=== 1. 同 URL 换媒体 ===');
  const before = await b.evaluate(`window.__tsSniffer.items().length`);
  check(before >= 6, '切换前有多个条目', before);

  // 非静音的 <video>：先播 A，再换 B —— URL 全程不变
  await b.evaluate(`(() => {
    window.__probe = document.createElement('video');
    window.__probe.muted = false; // 静音的会被当预览小窗跳过
    window.__probe.src = '/media/clip.mp4';
    document.body.append(window.__probe);
  })()`);
  await b.sleep(900);
  const hasA = await b.evaluate(`window.__tsSniffer.items().some(i => i.name === 'clip.mp4')`);
  check(hasA, '视频 A 的条目存在（demo 早已抓过它，元素事件刷新即可）', String(hasA));

  // 换源：同一个元素、同一个页面 URL
  await b.evaluate(`window.__probe.src = '/media/clip.mp4?v=2'`);
  await b.sleep(1200);

  const afterSwitch = await b.evaluate(`window.__tsSniffer.items().map(i => i.name)`);
  check(
    afterSwitch.length <= 6 && afterSwitch.includes('clip.mp4') && !afterSwitch.includes('clip.webm'),
    '换源后列表重置（旧条目清空，页面自身媒体由扫描补回属正常）',
    JSON.stringify(afterSwitch)
  );

  /* ---------------- 2. 静音预览不误杀 ---------------- */
  console.log('=== 2. 静音预览 ===');
  await b.evaluate(`(() => {
    window.__muted = document.createElement('video');
    window.__muted.muted = true;
    window.__muted.src = '/media/clip.mp4?v=3';
    document.body.append(window.__muted);
  })()`);
  await b.sleep(800);
  await b.evaluate(`window.__muted.src = '/media/clip.mp4?v=4'`);
  await b.sleep(1200);
  const afterMuted = await b.evaluate(`window.__tsSniffer.items().map(i => i.name)`);
  check(
    afterMuted.length >= 2,
    '静音元素换源不清列表',
    JSON.stringify(afterMuted)
  );

  /* ---------------- 3. 正在播放置顶 + 标记 ---------------- */
  console.log('=== 3. 正在播放 ===');
  await b.evaluate(`${SR}.querySelector('.fab').click()`);
  await b.sleep(400);
  // 让 v=2 的那个继续当「正在播放」
  await b.evaluate(`window.__probe.src = '/media/clip.mp4?v=2'`);
  await b.sleep(900);
  const top = await b.evaluate(`(() => {
    const row = ${SR}.querySelector('.list .row');
    return {
      name: row.querySelector('.row-name').textContent,
      live: !row.querySelector('.live').hidden,
      on: row.classList.contains('on'),
    };
  })()`);
  check(top.name === 'clip.mp4' && top.live && top.on, '正在播放的条目置顶并带标记', JSON.stringify(top));

  /* ---------------- 4. 缩略图 ---------------- */
  console.log('=== 4. 缩略图 ===');
  await b.evaluate(`(() => {
    const img = new Image(); img.src = '/media/pic.jpg?round=1';
  })()`);
  // 重置把 demo 抓的 webm 清掉了，重新请求一个真实可解码的直链视频
  await b.evaluate(`fetch('/media/clip.webm?round=1').catch(() => {})`);
  await b.sleep(1000);
  const thumbs = await b.evaluate(`(() => {
    const out = {};
    for (const row of ${SR}.querySelectorAll('.list .row')) {
      const name = row.querySelector('.row-name').textContent;
      const v = row.querySelector('.thumb video');
      const i = row.querySelector('.thumb img');
      out[name] = v ? { kind: 'video', src: v.getAttribute('src') }
        : i ? { kind: 'img', src: i.getAttribute('src') }
        : { kind: 'icon' };
    }
    return out;
  })()`);
  check(
    thumbs['clip.webm'] && thumbs['clip.webm'].kind === 'video' && /#t=0\.1$/.test(thumbs['clip.webm'].src || ''),
    '真实视频用首帧缩略图',
    JSON.stringify(thumbs['clip.webm'])
  );
  check(thumbs['pic.jpg'] && thumbs['pic.jpg'].kind === 'img', '图片用原图当缩略图', JSON.stringify(thumbs['pic.jpg']));
  check(
    thumbs['clip.mp4'] && thumbs['clip.mp4'].kind === 'icon',
    '解不出来的假 mp4 正确回退成图标',
    JSON.stringify(thumbs['clip.mp4'])
  );

  // 真的解出画面了吗
  await b.sleep(1800);
  const frameOk = await b.evaluate(`(() => {
    for (const row of ${SR}.querySelectorAll('.list .row')) {
      if (row.querySelector('.row-name').textContent === 'clip.webm') {
        const v = row.querySelector('.thumb video');
        return v ? v.readyState : -1;
      }
    }
    return -2;
  })()`);
  check(frameOk >= 2, '视频缩略图已解出首帧', `readyState=${frameOk}`);
  const imgOk = await b.evaluate(`(() => {
    for (const row of ${SR}.querySelectorAll('.list .row')) {
      if (row.querySelector('.row-name').textContent === 'pic.jpg') {
        const i = row.querySelector('.thumb img');
        return i ? i.naturalWidth : 0;
      }
    }
    return 0;
  })()`);
  check(imgOk > 0, '图片缩略图已加载', `naturalWidth=${imgOk}`);

  /* ---------------- 5. 键控复用：不重新请求 ---------------- */
  console.log('=== 5. 键控复用 ===');
  await b.evaluate(`(() => {
    for (const row of ${SR}.querySelectorAll('.list .row')) {
      if (row.querySelector('.row-name').textContent === 'pic.jpg') {
        const img = row.querySelector('.thumb img');
        if (img) img.dataset.marker = 'kept';
      }
    }
  })()`);
  // 触发一次全量重渲染（新来一张图）
  await b.evaluate(`fetch('/media/logo.png?round=1').catch(() => {})`);
  await b.sleep(900);
  const kept = await b.evaluate(`(() => {
    for (const row of ${SR}.querySelectorAll('.list .row')) {
      if (row.querySelector('.row-name').textContent === 'pic.jpg') {
        const img = row.querySelector('.thumb img');
        return img ? img.dataset.marker || '' : '';
      }
    }
    return '';
  })()`);
  check(kept === 'kept', '重渲染后缩略图元素未被销毁重建', kept);

  /* ---------------- 6. 角标开关立即生效 ---------------- */
  console.log('=== 6. 探测提示开关 ===');
  const count = await b.evaluate(`window.__tsSniffer.items().length`);
  check(count > 0, '列表非空（角标应有数字）', count);
  const badgeOn = await b.evaluate(`(() => {
    const el = ${SR}.querySelector('.fab .badge');
    return { hidden: el.hidden, display: getComputedStyle(el).display };
  })()`);
  check(
    badgeOn.hidden === false && badgeOn.display !== 'none',
    '开关开启时角标可见（以计算样式为准）',
    JSON.stringify(badgeOn)
  );

  await b.evaluate(`${SR}.querySelector('[data-act="settings"]').click()`);
  await b.sleep(400);
  await b.evaluate(`${SR}.querySelector('[data-set="toast"]').click()`);
  await b.sleep(300);
  const badgeOff = await b.evaluate(`(() => {
    const el = ${SR}.querySelector('.fab .badge');
    return { hidden: el.hidden, display: getComputedStyle(el).display, label: ${SR}.querySelector('[data-set="toast"] em').textContent };
  })()`);
  check(
    badgeOff.hidden === true && badgeOff.display === 'none' && badgeOff.label === '关',
    '关闭后角标立即消失（display:grid 的坑已修，计算样式为 none）',
    JSON.stringify(badgeOff)
  );

  await b.evaluate(`${SR}.querySelector('[data-set="toast"]').click()`);
  await b.sleep(300);
  const badgeBack = await b.evaluate(`(() => {
    const el = ${SR}.querySelector('.fab .badge');
    return getComputedStyle(el).display;
  })()`);
  check(badgeBack !== 'none', '重新打开后角标恢复', String(badgeBack));
  await b.evaluate(`${SR}.querySelector('.mask')?.click()`);
  await b.sleep(250);

  /* ---------------- 7. 页签合并：HLS + 分片 → 视频 ---------------- */
  console.log('=== 7. 页签合并 ===');
  const tabs = await b.evaluate(
    `[...${SR}.querySelectorAll('.tabs .tab')].map((t) => t.dataset.filter)`
  );
  check(
    JSON.stringify(tabs) === JSON.stringify(['all', 'video', 'img', 'audio']),
    '页签为 全部/视频/图片/音频',
    JSON.stringify(tabs)
  );
  await b.evaluate(`${SR}.querySelector('.tab[data-filter="video"]').click()`);
  await b.sleep(300);
  const videoTags = await b.evaluate(
    `[...${SR}.querySelectorAll('.list .row .tag')].map((t) => t.textContent)`
  );
  check(
    videoTags.length > 0 && videoTags.every((t) => ['M3U8', 'TS', 'M4S', 'MP4', 'VIDEO', 'MPD'].includes(t)),
    '「视频」页含播放列表、分片与直链视频',
    JSON.stringify(videoTags)
  );
  await b.evaluate(`${SR}.querySelector('.tab[data-filter="all"]').click()`);
  await b.sleep(250);

  /* ---------------- 8. 设置按钮：与左侧同款的渐变气泡 ---------------- */
  console.log('=== 8. 设置按钮气泡 ===');
  const gear = await b.evaluate(`(() => {
    const g = ${SR}.querySelector('.gear[data-act="settings"]');
    const cs = getComputedStyle(g);
    return { bg: cs.backgroundImage, w: parseFloat(cs.width), icon: !!g.querySelector('svg') };
  })()`);
  check(
    /linear-gradient/.test(gear.bg) && gear.w === 30 && gear.icon,
    '设置按钮是渐变气泡 + 齿轮图标',
    JSON.stringify(gear)
  );

  /* ---------------- 9. 任务卡片：最新在最上 ---------------- */
  console.log('=== 9. 任务最新在最上 ===');
  const dl = async (name) =>
    b.evaluate(`(() => {
      const rows = [...${SR}.querySelectorAll('.list .row')];
      const row = rows.find((r) => r.querySelector('.row-name').textContent.trim() === '${name}');
      if (row) row.querySelector('[data-act="download"]').click();
      return !!row;
    })()`);
  check((await dl('clip.webm')) === true, '第一个任务已开始（webm）', '');
  await b.waitFor(
    `(() => { const js = window.__tsSniffer.jobs(); return js.length === 1 && js[0].status === 'done'; })()`,
    30000
  );
  check((await dl('pic.jpg')) === true, '第二个任务已开始（jpg）', '');
  await b.waitFor(
    `(() => { const js = window.__tsSniffer.jobs(); return js.length === 2 && js.every((j) => j.status === 'done'); })()`,
    30000
  );
  const jobOrder = await b.evaluate(`(() => {
    const cards = [...${SR}.querySelectorAll('.jobs .job')];
    const js = window.__tsSniffer.jobs();
    return {
      dom: cards.map((c) => c.dataset.job),
      arr: js.map((j) => j.id),
    };
  })()`);
  check(
    JSON.stringify(jobOrder.dom) === JSON.stringify(jobOrder.arr.slice().reverse()),
    '任务卡片按时间倒序，最新的在最上面',
    JSON.stringify(jobOrder)
  );

  // 任务卡片跟随页签分类：视频、图片各自只看本类
  await b.evaluate(`${SR}.querySelector('.tab[data-filter="video"]').click()`);
  await b.sleep(300);
  const videoJobs = await b.evaluate(`${SR}.querySelectorAll('.jobs .job').length`);
  await b.evaluate(`${SR}.querySelector('.tab[data-filter="img"]').click()`);
  await b.sleep(300);
  const imgJobs = await b.evaluate(`${SR}.querySelectorAll('.jobs .job').length`);
  await b.evaluate(`${SR}.querySelector('.tab[data-filter="all"]').click()`);
  await b.sleep(300);
  const allJobs = await b.evaluate(`${SR}.querySelectorAll('.jobs .job').length`);
  check(
    videoJobs === 1 && imgJobs === 1 && allJobs === 2,
    '任务卡片按「视频/图片」分类，全部页显示两者',
    JSON.stringify({ videoJobs, imgJobs, allJobs })
  );

  /* ---------------- 10. 头部下拉关闭 ---------------- */
  console.log('=== 10. 下拉关闭 ===');
  // 小拖：面板跟手，松手弹回
  await b.evaluate(`(() => {
    const head = ${SR}.querySelector('.head');
    head.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 21, clientX: 190, clientY: 130, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 21, clientX: 190, clientY: 170, bubbles: true }));
  })()`);
  const midDrag = await b.evaluate(`${SR}.querySelector('.sheet').style.transform`);
  check(/translateY\(\d+px\)/.test(midDrag) && midDrag !== 'translateY(0px)', '拖动时面板实时跟手', midDrag);
  await b.evaluate(`document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 21, bubbles: true }))`);
  await b.sleep(400);
  const afterSmall = await b.evaluate(`(() => ({
    open: ${SR}.querySelector('.sheet').classList.contains('open'),
    transform: ${SR}.querySelector('.sheet').style.transform,
  }))()`);
  check(afterSmall.open && !afterSmall.transform, '未过阈值松手弹回，面板保持打开', JSON.stringify(afterSmall));

  // 大拖：提示切换，松手关闭
  await b.evaluate(`(() => {
    const head = ${SR}.querySelector('.head');
    head.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 22, clientX: 190, clientY: 130, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 22, clientX: 190, clientY: 330, bubbles: true }));
  })()`);
  const bigDrag = await b.evaluate(`(() => ({
    transform: ${SR}.querySelector('.sheet').style.transform,
    hint: ${SR}.querySelector('.pull-hint').textContent,
  }))()`);
  check(/松开关闭/.test(bigDrag.hint), '过阈值时提示切换为「松开关闭」', JSON.stringify(bigDrag));
  await b.evaluate(`document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 22, bubbles: true }))`);
  await b.sleep(600);
  const afterBig = await b.evaluate(`${SR}.querySelector('.sheet').classList.contains('open')`);
  check(afterBig === false, '下拉过阈值松手后面板关闭', String(afterBig));

  /* ---------------- 11. 设置弹窗：文案与下拉关闭 ---------------- */
  console.log('=== 11. 设置弹窗 ===');
  await b.evaluate(`${SR}.querySelector('.gear[data-act="settings"]').click()`);
  await b.sleep(400);
  const setMeta = await b.evaluate(`(() => ({
    sub: !!${SR}.querySelector('.modal .modal-sub'),
    labels: [...${SR}.querySelectorAll('.modal .set-label')].map((l) => l.textContent),
  }))()`);
  check(setMeta.sub === false, '副标题提示已删除', JSON.stringify(setMeta));
  check(
    setMeta.labels.some((t) => /不透明度/.test(t)) && !setMeta.labels.some((t) => /(?<!不)透明度/.test(t)),
    '设置项名为「悬浮窗不透明度」',
    JSON.stringify(setMeta.labels)
  );

  // 从卡片中部（不是标题行）起手：应实时跟手 —— 手势已扩展到整张卡片
  await b.evaluate(`(() => {
    const modal = ${SR}.querySelector('.modal');
    const mid = ${SR}.querySelector('.modal .modal-body') || modal;
    mid.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 31, clientX: 190, clientY: 300, bubbles: true }));
    modal.dispatchEvent(new PointerEvent('pointermove', { pointerId: 31, clientX: 190, clientY: 350, bubbles: true }));
  })()`);
  const mDrag = await b.evaluate(`${SR}.querySelector('.modal').style.transform`);
  check(/translateY\(\d+px\)/.test(mDrag) && mDrag !== 'translateY(0px)', '卡片中部起手也能实时跟手', mDrag);
  await b.evaluate(`${SR}.querySelector('.modal').dispatchEvent(new PointerEvent('pointerup', { pointerId: 31, bubbles: true }))`);
  await b.sleep(400);
  const mSmall = await b.evaluate(`(() => ({
    open: !!${SR}.querySelector('.modal'),
    transform: (${SR}.querySelector('.modal') || {}).style ? ${SR}.querySelector('.modal').style.transform : '',
  }))()`);
  check(mSmall.open && !mSmall.transform, '未过阈值松手弹回，弹窗保持打开', JSON.stringify(mSmall));

  // 从设置项（按钮行）上起手大拖：应关闭
  await b.evaluate(`(() => {
    const modal = ${SR}.querySelector('.modal');
    const row = ${SR}.querySelector('.modal [data-set="conc"]') || modal;
    row.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 32, clientX: 190, clientY: 300, bubbles: true }));
    modal.dispatchEvent(new PointerEvent('pointermove', { pointerId: 32, clientX: 190, clientY: 520, bubbles: true }));
    modal.dispatchEvent(new PointerEvent('pointerup', { pointerId: 32, bubbles: true }));
  })()`);
  await b.sleep(700);
  const mGone = await b.evaluate(`!!${SR}.querySelector('.modal')`);
  check(mGone === false, '在设置项上起手下拉，同样能关闭弹窗', String(mGone));

  // 滑杆上起手不应被当成下拉（否则调不透明度会误关）
  await b.evaluate(`${SR}.querySelector('.gear[data-act="settings"]').click()`);
  await b.sleep(450);
  await b.evaluate(`(() => {
    const modal = ${SR}.querySelector('.modal');
    const range = ${SR}.querySelector('.modal .range') || modal;
    range.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 33, clientX: 190, clientY: 300, bubbles: true }));
    modal.dispatchEvent(new PointerEvent('pointermove', { pointerId: 33, clientX: 190, clientY: 520, bubbles: true }));
    modal.dispatchEvent(new PointerEvent('pointerup', { pointerId: 33, bubbles: true }));
  })()`);
  await b.sleep(600);
  const sliderSafe = await b.evaluate(`(() => {
    const m = ${SR}.querySelector('.modal');
    return { open: !!m, transform: m ? m.style.transform : 'gone' };
  })()`);
  check(sliderSafe.open === true && !sliderSafe.transform, '滑杆上起手不会误关弹窗', JSON.stringify(sliderSafe));
  await b.evaluate(`${SR}.querySelector('.mask')?.click()`);
  await b.sleep(300);

  /* ---------------- 12. tabs 栏固定间距 ---------------- */
  console.log('=== 12. tabs 栏固定间距 ===');
  await b.evaluate(`${SR}.querySelector('.fab').click()`);
  await b.sleep(400);
  const tabsCss = await b.evaluate(`(() => {
    const cs = getComputedStyle(${SR}.querySelector('.tabs'));
    return { shrink: cs.flexShrink, pt: cs.paddingTop, pb: cs.paddingBottom, h: ${SR}.querySelector('.tabs').offsetHeight };
  })()`);
  check(
    tabsCss.shrink === '0' && tabsCss.pt === '9px' && tabsCss.pb === '9px',
    'tabs 栏不可压缩、上下内边距恒定 9px',
    JSON.stringify(tabsCss)
  );

  /* ---------------- 13. 刷新按钮 ---------------- */
  console.log('=== 13. 刷新按钮 ===');
  const btns = await b.evaluate(
    `[...${SR}.querySelectorAll('.tabs .gear')].map((g) => g.dataset.act)`
  );
  check(JSON.stringify(btns) === JSON.stringify(['refresh', 'settings']), '设置左侧是刷新按钮', JSON.stringify(btns));
  const gearSize = await b.evaluate(`(() => {
    const el = ${SR}.querySelector('[data-act="refresh"]');
    const cs = getComputedStyle(el);
    return { w: parseFloat(cs.width), svg: parseFloat(getComputedStyle(el.querySelector('svg')).width) };
  })()`);
  check(gearSize.w === 30 && gearSize.svg === 16, '刷新图标与设置同尺寸（30px 气泡 / 16px 图标）', JSON.stringify(gearSize));

  // 刷新：列表与任务卡片清空后重新探测
  const preRefresh = await b.evaluate(`window.__tsSniffer.items().length`);
  check(preRefresh > 0, '刷新前列表非空', preRefresh);
  await b.evaluate(`${SR}.querySelector('[data-act="refresh"]').click()`);
  await b.sleep(1200);
  const postRefresh = await b.evaluate(`(() => ({
    items: window.__tsSniffer.items().length,
    jobs: window.__tsSniffer.jobs().length,
  }))()`);
  check(postRefresh.items > 0, '刷新后重新探测到当前页资源', JSON.stringify(postRefresh));
  check(postRefresh.jobs === 0, '已完成的任务卡片被清空（不动本地文件）', postRefresh.jobs);

  /* ---------------- 14. 图片探测：无扩展名可认、小图标被滤 ---------------- */
  console.log('=== 14. 图片探测 ===');
  await b.sleep(800);
  const imgs = await b.evaluate(`(() => {
    const names = window.__tsSniffer.items().map((it) => it.name + '|' + it.kind);
    return {
      hasPhoto: names.some((n) => n === 'photo|image'),
      noIcon: !names.some((n) => n.startsWith('icon.svg')),
    };
  })()`);
  check(imgs.hasPhoto, '无扩展名的 <img> 图片（/media/photo）被探测到', JSON.stringify(imgs));
  check(imgs.noIcon, '24x24 小图标被分辨率过滤', JSON.stringify(imgs));

  /* ---------------- 15. 音频：探测与分类 ---------------- */
  console.log('=== 15. 音频 ===');
  await b.sleep(900);
  const audioState = await b.evaluate(`(() => {
    const items = window.__tsSniffer.items();
    const audios = items.filter((it) => it.kind === 'audio').map((it) => it.name);
    return { audios, total: items.length };
  })()`);
  check(audioState.audios.includes('tone.mp3'), '有扩展名的音频被探测到（tone.mp3）', JSON.stringify(audioState));
  check(audioState.audios.includes('voice'), '无扩展名的 <audio> 被探测到（voice）', JSON.stringify(audioState));

  await b.evaluate(`${SR}.querySelector('.tab[data-filter="audio"]').click()`);
  await b.sleep(350);
  const audioTags = await b.evaluate(
    `[...${SR}.querySelectorAll('.list .row .tag')].map((t) => t.textContent)`
  );
  check(
    audioTags.length > 0 && audioTags.every((t) => t === 'AUDIO'),
    '「音频」页只含音频条目',
    JSON.stringify(audioTags)
  );
  await b.evaluate(`${SR}.querySelector('.tab[data-filter="all"]').click()`);
  await b.sleep(250);

  /* ---------------- 16. 主题名 ---------------- */
  console.log('=== 16. 主题名 ===');
  await b.evaluate(`${SR}.querySelector('.gear[data-act="settings"]').click()`);
  await b.sleep(400);
  const themeName = await b.evaluate(`(() => {
    const el = ${SR}.querySelector('[data-theme-name]');
    const first = ${SR}.querySelector('.swatch[data-theme="default"]');
    return { label: el ? el.textContent.trim() : '', firstOn: !!first && first.classList.contains('on') };
  })()`);
  check(themeName.label === '默认', '默认主题名为「默认」', JSON.stringify(themeName));

  // 并发的循环档位：4 → 6 → 8 → 12 → 16 → 2
  const concSeq = [];
  for (let i = 0; i < 5; i++) {
    await b.evaluate(`${SR}.querySelector('[data-set="conc"]').click()`);
    concSeq.push(await b.evaluate(`${SR}.querySelector('[data-set="conc"] em').textContent`));
  }
  check(
    JSON.stringify(concSeq) === JSON.stringify(['6', '8', '12', '16', '2']),
    '并发数最高可到 16',
    JSON.stringify(concSeq)
  );

  const memLabel = await b.evaluate(`${SR}.querySelector('[data-set="mem"] span').textContent.trim()`);
  check(memLabel === '内存提醒', '设置项名为「内存提醒」', memLabel);

  // 内存提醒档位：900 → 1400 → 2048 → 3072 → 4096
  const memSeq = [];
  for (let i = 0; i < 4; i++) {
    await b.evaluate(`${SR}.querySelector('[data-set="mem"]').click()`);
    memSeq.push(await b.evaluate(`${SR}.querySelector('[data-set="mem"] em').textContent`));
  }
  check(
    /^4\.0+ GB$/.test(memSeq[3]),
    '内存提醒档位最高可到 4GB',
    JSON.stringify(memSeq)
  );
  check(themeName.firstOn, '首次启动使用该主题（默认选中）', JSON.stringify(themeName));
  await b.evaluate(`${SR}.querySelector('.mask')?.click()`);
  await b.sleep(300);

  /* ---------------- 17. 设置项改名 + 跨页面持久化 ---------------- */
  console.log('=== 17. 设置保存 ===');
  await b.evaluate(`${SR}.querySelector('.gear[data-act="settings"]').click()`);
  await b.sleep(400);
  const toastLabel = await b.evaluate(`(() => {
    const btn = ${SR}.querySelector('[data-set="toast"] span');
    return btn ? btn.textContent.trim() : '';
  })()`);
  check(toastLabel === '悬浮窗标记', '设置项名为「悬浮窗标记」', toastLabel);

  // 换主题后刷新页面，设置应保留
  await b.evaluate(`${SR}.querySelector('.swatch[data-theme="white"]').click()`);
  await b.sleep(400);
  const beforeReload = await b.evaluate(`${SR}.querySelector('.root')?.dataset.theme || ''`);
  check(beforeReload === 'white', '切换主题立即生效', beforeReload);

  await b.goto('http://127.0.0.1:8787/dev/demo.html');
  await b.waitFor(`window.__tsSniffer && window.__tsSniffer.items().length >= 6`, 15000);
  await b.sleep(600);
  const afterReload = await b.evaluate(`${SR}.querySelector('.root')?.dataset.theme || ''`);
  check(afterReload === 'white', '重新打开页面后主题设置保留', afterReload);

  // 收尾：恢复默认主题
  await b.evaluate(`${SR}.querySelector('.fab').click()`);
  await b.sleep(300);
  await b.evaluate(`${SR}.querySelector('.gear[data-act="settings"]').click()`);
  await b.sleep(350);
  await b.evaluate(`${SR}.querySelector('.swatch[data-theme="default"]').click()`);
  await b.sleep(300);

  /* ---------------- 18. 清理缓存 / 恢复默认配置 ---------------- */
  console.log('=== 18. 清理缓存与恢复默认 ===');
  await b.evaluate(`${SR}.querySelector('.mask')?.click()`);
  await b.sleep(250);
  await b.evaluate(`${SR}.querySelector('.gear[data-act="settings"]').click()`);
  await b.sleep(400);

  const layout = await b.evaluate(`(() => {
    const modal = ${SR}.querySelector('.modal');
    const labels = [...modal.querySelectorAll('[data-set], [data-act="clearcache"], [data-act="reset"]')]
      .map((el) => (el.querySelector('span') || el).textContent.trim());
    return {
      labels,
      hints: modal.querySelectorAll('[data-act="clearcache"] em, [data-act="reset"] em').length,
      hasCancel: !!modal.querySelector('[data-close]'),
      last: labels[labels.length - 1],
    };
  })()`);
  check(layout.hasCancel === false, '设置页已无「取消」按钮', JSON.stringify(layout));
  check(layout.last === '恢复默认配置', '「恢复默认配置」位于设置页最下方', JSON.stringify(layout.labels));
  check(
    JSON.stringify(layout.labels) ===
      JSON.stringify(['并发数', '内存提醒', '悬浮窗标记', '自动保存', '清理缓存', '恢复默认配置']),
    '顺序为 并发数 → 内存提醒 → 悬浮窗标记 → 自动保存 → 清理缓存 → 恢复默认配置',
    JSON.stringify(layout.labels)
  );
  check(layout.hints === 0, '清理缓存与恢复默认配置已无小字说明', layout.hints);

  // 改几项再恢复默认
  await b.evaluate(`${SR}.querySelector('.swatch[data-theme="black"]').click()`);
  await b.sleep(200);
  await b.evaluate(`${SR}.querySelector('[data-set="conc"]').click()`);
  await b.sleep(200);
  await b.evaluate(`${SR}.querySelector('[data-set="autosave"]').click()`);
  await b.sleep(200);
  await b.evaluate(`${SR}.querySelector('[data-act="reset"]').click()`);
  await b.sleep(700);
  const afterReset = await b.evaluate(`(() => {
    const root = ${SR}.querySelector('.root');
    return {
      theme: root.dataset.theme,
      conc: ${SR}.querySelector('[data-set="conc"] em').textContent,
      mem: ${SR}.querySelector('[data-set="mem"] em').textContent,
      autoSave: ${SR}.querySelector('[data-set="autosave"] em').textContent,
    };
  })()`);
  check(
    afterReset.theme === 'default' && afterReset.conc === '4' && /900(\.0+)? MB/.test(afterReset.mem),
    '恢复默认：主题「默认」、并发 4、内存提醒 900MB',
    JSON.stringify(afterReset)
  );
  check(afterReset.autoSave === '开', '恢复默认后「自动保存」回到开', afterReset.autoSave);

  // 清理缓存：当前没有失败任务，应给出「没有可清理的缓存」
  await b.evaluate(`${SR}.querySelector('[data-act="clearcache"]').click()`);
  await b.sleep(400);
  const cacheMsg = await b.evaluate(`${SR}.querySelector('.toast').textContent`);
  check(/缓存/.test(cacheMsg), '清理缓存有明确反馈', cacheMsg);
  await b.evaluate(`${SR}.querySelector('.mask')?.click()`);
  await b.sleep(250);

  /* ---------------- 19. 自动保存与内存释放 ---------------- */
  console.log('=== 19. 自动保存与内存释放 ===');
  await b.evaluate(`${SR}.querySelector('.gear[data-act="settings"]').click()`);
  await b.sleep(350);
  const autoDefault = await b.evaluate(`${SR}.querySelector('[data-set="autosave"] em').textContent.trim()`);
  check(autoDefault === '开', '自动保存默认开启', autoDefault);

  // 关掉自动保存：下载完成后必须保留内存
  await b.evaluate(`${SR}.querySelector('[data-set="autosave"]').click()`);
  await b.sleep(250);
  const autoOff = await b.evaluate(`${SR}.querySelector('[data-set="autosave"] em').textContent.trim()`);
  check(autoOff === '关', '可以关闭自动保存', autoOff);
  await b.evaluate(`${SR}.querySelector('.mask').click()`);
  await b.sleep(250);

  check((await dl('pic.jpg')) === true, '关闭自动保存后开始一次下载', '');
  await b.waitFor(`window.__tsSniffer.jobs().some((j) => j.status === 'done')`, 30000);
  await b.sleep(2200);
  const keptJob = await b.evaluate(`(() => {
    const j = window.__tsSniffer.jobs().find((x) => x.status === 'done');
    return { released: !!j.released, hasUrl: !!j.objectUrl, hasBlob: !!j.blob };
  })()`);
  check(
    keptJob.released === false && keptJob.hasUrl === true && keptJob.hasBlob === true,
    '自动保存关闭时，完成的任务保留内存',
    JSON.stringify(keptJob)
  );

  // 手动保存成功后，只释放这一个任务
  const saveResult = await b.evaluate(`window.__tsSniffer.save(0)`);
  check(saveResult === true, '保存流程返回成功', String(saveResult));
  await b.sleep(2200);
  const savedOne = await b.evaluate(`(() => {
    const j = window.__tsSniffer.jobs().find((x) => x.status === 'done');
    return { released: !!j.released, hasUrl: !!j.objectUrl, hasBlob: !!j.blob, msg: j.message };
  })()`);
  check(
    savedOne.released === true && savedOne.hasUrl === false && savedOne.hasBlob === false,
    '手动保存成功后释放该任务内存',
    JSON.stringify(savedOne)
  );

  // 打开自动保存：完成即自动保存并释放
  await b.evaluate(`${SR}.querySelector('.gear[data-act="settings"]').click()`);
  await b.sleep(350);
  await b.evaluate(`${SR}.querySelector('[data-set="autosave"]').click()`);
  await b.sleep(200);
  await b.evaluate(`${SR}.querySelector('.mask').click()`);
  await b.sleep(250);

  check((await dl('logo.png')) === true, '开启自动保存后再下载一次', '');
  await b.waitFor(`window.__tsSniffer.jobs().filter((j) => j.status === 'done').length >= 2`, 30000);
  await b.sleep(2600);
  const autoSaved = await b.evaluate(`(() => {
    const newest = window.__tsSniffer.jobs().find((x) => x.status === 'done');
    return { released: !!newest.released, hasBlob: !!newest.blob, msg: newest.message };
  })()`);
  check(
    autoSaved.released === true && autoSaved.hasBlob === false,
    '自动保存成功后立即释放该任务内存',
    JSON.stringify(autoSaved)
  );

  /* ---------------- 20. 重复运行脚本（第二次注入） ---------------- */
  console.log('=== 20. 重复运行脚本 ===');
  const hostBefore = await b.evaluate(`document.querySelectorAll('#ts-sniffer-ios-host').length`);
  check(hostBefore === 1, '注入前只有一个界面宿主', hostBefore);

  await b.evaluate(`(() => {
    const src = document.createElement('script');
    src.src = '/media-sniffer.user.js';
    document.documentElement.appendChild(src);
    return true;
  })()`);
  await b.sleep(1800);

  const afterRun = await b.evaluate(`(() => {
    const hosts = document.querySelectorAll('#ts-sniffer-ios-host');
    const host = hosts[hosts.length - 1];
    const SR2 = host && host.shadowRoot;
    const fab = SR2 && SR2.querySelector('.fab');
    if (fab) fab.click();
    return {
      hosts: hosts.length,
      hasUi: !!fab,
      open: !!(SR2 && SR2.querySelector('.sheet').classList.contains('open')),
      items: window.__tsSniffer ? window.__tsSniffer.items().length : -1,
    };
  })()`);
  check(afterRun.hosts === 1, '重复注入后没有留下第二个宿主', JSON.stringify(afterRun));
  check(afterRun.hasUi && afterRun.open, '第二次运行后界面可正常打开', JSON.stringify(afterRun));
  check(afterRun.items > 0, '第二次运行后探测列表仍可用', JSON.stringify(afterRun));

  // 所有权令牌必须指向最新实例：旧实例据此彻底停手（不再回 ack、不再记条目）
  const owner = await b.evaluate(`(() => ({
    alive: window.__tsSnifferAlive,
    gen: window.__tsSnifferGen,
    hasTeardown: typeof window.__tsSnifferTeardown === 'function',
  }))()`);
  check(owner.alive === owner.gen, '所有权令牌指向最新实例', JSON.stringify(owner));
  check(owner.hasTeardown, '新实例登记了拆除入口（下次注入可接管）', JSON.stringify(owner));

  // 再连续注入两次：每次都必须重新挂出可用的界面（模拟反复更新脚本）
  for (let round = 0; round < 2; round++) {
    await b.evaluate(`(() => {
      const src = document.createElement('script');
      src.src = '/media-sniffer.user.js?r=${round}';
      document.documentElement.appendChild(src);
      return true;
    })()`);
    await b.sleep(1600);
    const again = await b.evaluate(`(() => {
      const hosts = document.querySelectorAll('#ts-sniffer-ios-host');
      const host = hosts[hosts.length - 1];
      const SR2 = host && host.shadowRoot;
      const fab = SR2 && SR2.querySelector('.fab');
      const hadOpen = !!(SR2 && SR2.querySelector('.sheet').classList.contains('open'));
      if (fab && !hadOpen) fab.click();
      return { hosts: hosts.length, hasUi: !!fab, open: !!(SR2 && SR2.querySelector('.sheet').classList.contains('open')) };
    })()`);
    check(
      again.hosts === 1 && again.hasUi && again.open,
      `第 ${round + 2} 次运行仍能挂出可用界面`,
      JSON.stringify(again)
    );
  }

  /* ---------------- 21. 悬浮窗不透明度与看门狗 ---------------- */
  console.log('=== 21. 悬浮窗不透明度与自动重挂 ===');
  await b.evaluate(`${SR}.querySelector('.fab').click()`);
  await b.sleep(300);
  // 设成 100%，清空列表进入待机态，检查没有被压暗
  await b.evaluate(`${SR}.querySelector('[data-act="settings"]').click()`);
  await b.sleep(350);
  await b.evaluate(`(() => {
    const r = ${SR}.querySelector('.range');
    r.value = '100';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await b.sleep(300);
  await b.evaluate(`${SR}.querySelector('.mask').click()`);
  await b.sleep(300);
  const clearBtn = await b.evaluate(`(() => {
    const btn = ${SR}.querySelector('[data-act="clear"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await b.sleep(600);
  const idleOpacity = await b.evaluate(`(() => {
    const fab = ${SR}.querySelector('.fab');
    return { idle: fab.classList.contains('idle'), opacity: getComputedStyle(fab).opacity };
  })()`);
  check(
    clearBtn === true && idleOpacity.idle === true && Number(idleOpacity.opacity) === 1,
    '待机状态下仍按设置的不透明度显示（100% 不被压暗）',
    JSON.stringify(idleOpacity)
  );

  // 恢复列表，供后续使用
  await b.evaluate(`${SR}.querySelector('[data-act="refresh"]').click()`);
  await b.sleep(1500);

  // 看门狗：宿主被外部摘掉后应自动重挂
  await b.evaluate(`(() => {
    const h = document.getElementById('ts-sniffer-ios-host');
    if (h) h.remove();
    return true;
  })()`);
  await b.sleep(4600);
  const remounted = await b.evaluate(`(() => {
    const h = document.getElementById('ts-sniffer-ios-host');
    return { hosts: document.querySelectorAll('#ts-sniffer-ios-host').length, ui: !!(h && h.shadowRoot && h.shadowRoot.querySelector('.fab')) };
  })()`);
  check(remounted.hosts === 1 && remounted.ui, '界面被摘掉后自动重挂', JSON.stringify(remounted));

  /* ---------------- 22. 内嵌页合并为唯一悬浮窗 ---------------- */
  console.log('=== 22. 内嵌页合并 ===');
  await b.evaluate(`(() => {
    const f = document.createElement('iframe');
    f.id = 'embed-test';
    f.src = '/dev/embed.html?t=1';
    f.style.cssText = 'width:320px;height:180px;border:0';
    document.body.appendChild(f);
    return true;
  })()`);
  await b.sleep(3200);

  const frameState = await b.evaluate(`(() => {
    const f = document.getElementById('embed-test');
    const doc = f && f.contentDocument;
    return {
      topHosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
      innerHosts: doc ? doc.querySelectorAll('#ts-sniffer-ios-host').length : -1,
    };
  })()`);
  check(frameState.topHosts === 1, '顶层仍只有一个悬浮窗宿主', JSON.stringify(frameState));
  check(frameState.innerHosts === 0, '内嵌页里不再出现第二个悬浮窗', JSON.stringify(frameState));

  // 展开面板，列表才会渲染
  await b.evaluate(`(() => {
    const fab = ${SR}.querySelector('.fab');
    if (!${SR}.querySelector('.sheet').classList.contains('open')) fab.click();
    return true;
  })()`);
  await b.sleep(500);

  const merged = await b.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.list .row')];
    const row = rows.find((r) => /内嵌页/.test((r.querySelector('.row-sub') || {}).textContent || ''));
    return row
      ? { found: true, sub: (row.querySelector('.row-sub') || {}).textContent || '', name: (row.querySelector('.row-name') || {}).textContent }
      : { found: false, names: rows.map((r) => (r.querySelector('.row-name') || {}).textContent) };
  })()`);
  check(merged.found, '内嵌页的媒体出现在顶层列表', JSON.stringify(merged));
  check(/内嵌页/.test(merged.sub), '条目标注了「内嵌页」', merged.sub);

  // 从顶层点下载，内嵌页执行并回传结果
  await b.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.list .row')];
    const row = rows.find((r) => /内嵌页/.test((r.querySelector('.row-sub') || {}).textContent || ''));
    if (row) row.querySelector('[data-act="download"]').click();
    return true;
  })()`);
  await b.waitFor(
    `window.__tsSniffer.jobs().some((j) => j.remote && (j.status === 'done' || j.status === 'error'))`,
    30000
  );
  await b.sleep(1200);
  const remoteJob = await b.evaluate(`(() => {
    const j = window.__tsSniffer.jobs().find((x) => x.remote);
    return { status: j.status, message: j.message, bytes: j.bytes };
  })()`);
  check(
    remoteJob.status === 'done' && /已保存/.test(remoteJob.message || ''),
    '内嵌页下载成功并回传顶层任务卡',
    JSON.stringify(remoteJob)
  );

  /* ---------------- 23. 多层嵌套内嵌页 ---------------- */
  console.log('=== 23. 多层嵌套 ===');
  await b.evaluate(`(() => {
    const f = document.createElement('iframe');
    f.id = 'nest-test';
    f.src = '/dev/embed-nest.html?t=1';
    f.style.cssText = 'width:340px;height:220px;border:0';
    document.body.appendChild(f);
    return true;
  })()`);
  await b.sleep(4000);

  const nestState = await b.evaluate(`(() => {
    const mid = document.getElementById('nest-test');
    const rows = [...${SR}.querySelectorAll('.list .row')];
    const remote = rows.filter((r) => /内嵌页/.test((r.querySelector('.row-sub') || {}).textContent || ''));
    return {
      hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
      midHosts: mid && mid.contentDocument ? mid.contentDocument.querySelectorAll('#ts-sniffer-ios-host').length : -1,
      remote: remote.length,
    };
  })()`);
  check(nestState.hosts === 1 && nestState.midHosts === 0, '嵌套场景仍只有一个悬浮窗', JSON.stringify(nestState));
  check(nestState.remote > 0, '嵌套内嵌页的条目冒泡到顶层', JSON.stringify(nestState));

  await b.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.list .row')];
    const row = rows.find((r) => /内嵌页/.test((r.querySelector('.row-sub') || {}).textContent || ''));
    if (row) row.querySelector('[data-act="download"]').click();
    return true;
  })()`);
  await b.waitFor(
    `window.__tsSniffer.jobs().filter((j) => j.remote && j.status === 'done').length >= 1`,
    30000
  );
  const nestJob = await b.evaluate(`(() => {
    const j = window.__tsSniffer.jobs().find((x) => x.remote && x.status === 'done');
    return { message: j.message };
  })()`);
  check(/已保存/.test(nestJob.message || ''), '嵌套内嵌页也能下载并回传', JSON.stringify(nestJob));

  /* ---------------- 24. 防盗链（403）修复 ---------------- */
  console.log('=== 24. 防盗链 ===');
  await b.evaluate(`(() => {
    const fab = ${SR}.querySelector('.fab');
    if (!${SR}.querySelector('.sheet').classList.contains('open')) fab.click();
    return true;
  })()`);
  await b.sleep(400);
  const hotRow = await b.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.list .row')];
    const row = rows.find((r) => (r.querySelector('.row-name') || {}).textContent === 'hotlink.mp4');
    if (!row) return { found: false, names: rows.map((r) => (r.querySelector('.row-name') || {}).textContent) };
    row.querySelector('[data-act="download"]').click();
    return { found: true };
  })()`);
  check(hotRow.found, '防盗链条目在列表里', JSON.stringify(hotRow));

  await b.waitFor(
    `window.__tsSniffer.jobs().some((j) => j.status === 'done' || j.status === 'error')`,
    30000
  );
  await b.sleep(2500);
  const hotJob = await b.evaluate(`(() => {
    const j = window.__tsSniffer.jobs()[0];
    return { status: j.status, message: j.message, bytes: j.bytes };
  })()`);
  check(
    hotJob.status === 'done' && hotJob.bytes > 1000,
    '带 Referer 重试后下载成功，不再 403',
    JSON.stringify(hotJob)
  );

  /* ---------------- 25. 更严的防盗链：靠 Range 放行 ---------------- */
  console.log('=== 25. Range 防盗链 ===');
  const rangeRow = await b.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.list .row')];
    const row = rows.find((r) => (r.querySelector('.row-name') || {}).textContent === 'hotlink-range.mp4');
    if (!row) return { found: false, names: rows.map((r) => (r.querySelector('.row-name') || {}).textContent) };
    row.querySelector('[data-act="download"]').click();
    return { found: true };
  })()`);
  check(rangeRow.found, 'Range 防盗链条目在列表里', JSON.stringify(rangeRow));

  await b.waitFor(
    `window.__tsSniffer.jobs().some((j) => (j.status === 'done' && j.bytes > 1000) || j.status === 'error')`,
    30000
  );
  await b.sleep(2000);
  const rangeJob = await b.evaluate(`(() => {
    const j = window.__tsSniffer.jobs()[0];
    return { status: j.status, message: j.message, bytes: j.bytes };
  })()`);
  check(
    rangeJob.status === 'done' && rangeJob.bytes > 1000,
    '带 Range 重试后成功，视频类不再被 403 挡住',
    JSON.stringify(rangeJob)
  );

  /* ---------------- 26. 403 后的浏览器退路 ---------------- */
  /* ---------------- 26. 403：只给「复制直链」 ---------------- */
  console.log('=== 26. 403 只留复制直链 ===');
  const deniedRow = await b.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.list .row')];
    const row = rows.find((r) => (r.querySelector('.row-name') || {}).textContent === 'always403.mp4');
    if (!row) return { found: false, names: rows.map((r) => (r.querySelector('.row-name') || {}).textContent) };
    row.querySelector('[data-act="download"]').click();
    return { found: true };
  })()`);
  check(deniedRow.found, '被拒条目的行存在', JSON.stringify(deniedRow));

  await b.waitFor(`window.__tsSniffer.jobs().some((j) => j.status === 'error')`, 30000);
  await b.sleep(400);
  const denied = await b.evaluate(`(() => {
    const cards = [...${SR}.querySelectorAll('.job')];
    const card = cards.find((c) => c.querySelector('[data-act="copyurl"]')) || cards[0];
    return {
      hasCopy: !!(card && card.querySelector('[data-act="copyurl"]')),
      hasBrowser: !!(card && card.querySelector('[data-act="browser"]')),
      msg: card ? (card.querySelector('.job-msg') || {}).textContent || '' : '',
    };
  })()`);
  check(denied.hasCopy === true, '403 后提供「复制直链」按钮', JSON.stringify(denied));
  check(denied.hasBrowser === false, '不再有「改用浏览器保存」按钮', JSON.stringify(denied));
  check(denied.msg === 'HTTP 403 请「复制直链」后自行下载', '403 文案精简为一句', denied.msg);

  // 点「复制直链」：不弹任何保存卡片，只给出复制反馈
  await b.evaluate(`${SR}.querySelector('[data-act="copyurl"]').click()`);
  await b.sleep(500);
  const afterCopy = await b.evaluate(`(() => ({
    modal: !!${SR}.querySelector('.modal'),
    card: !!${SR}.querySelector('.dl-card'),
    toast: (${SR}.querySelector('.toast') || {}).textContent || '',
  }))()`);
  check(afterCopy.modal === false && afterCopy.card === false, '复制直链不弹保存卡片', JSON.stringify(afterCopy));
  check(/复制|直链/.test(afterCopy.toast), '复制后有反馈', afterCopy.toast);
  await b.sleep(300);

  /* ---------------- 27. 内嵌页重新注入：不留幽灵条目 ---------------- */
  console.log('=== 27. 内嵌页重新注入 ===');
  const beforeReinject = await b.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.list .row')];
    return rows.filter((r) => /内嵌页/.test((r.querySelector('.row-sub') || {}).textContent || '')).length;
  })()`);
  check(beforeReinject > 0, '注入前存在内嵌页条目', beforeReinject);

  // 在内嵌页里再跑一次脚本：模拟"脚本更新后重新注入"，frameId 会变
  const reinjected = await b.evaluate(`(() => {
    const f = document.getElementById('embed-test');
    const doc = f && f.contentDocument;
    if (!doc) return false;
    const s = doc.createElement('script');
    s.src = '/media-sniffer.user.js?reinject=1';
    doc.documentElement.appendChild(s);
    return true;
  })()`);
  check(reinjected === true, '可以在内嵌页里重新注入脚本', String(reinjected));
  await b.sleep(3000);

  const afterReinject = await b.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.list .row')];
    const remote = rows.filter((r) => /内嵌页/.test((r.querySelector('.row-sub') || {}).textContent || ''));
    const f = document.getElementById('embed-test');
    const doc = f && f.contentDocument;
    return {
      remote: remote.length,
      innerHosts: doc ? doc.querySelectorAll('#ts-sniffer-ios-host').length : -1,
      hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
    };
  })()`);
  check(
    afterReinject.remote <= beforeReinject && afterReinject.remote > 0,
    '重新注入后条目没有翻倍（旧 frameId 已作废）',
    JSON.stringify({ beforeReinject, afterReinject })
  );
  check(afterReinject.hosts === 1 && afterReinject.innerHosts === 0, '重新注入后仍然只有顶层一个悬浮窗', JSON.stringify(afterReinject));

  /* ---------------- 28. 启动稳定性：外部消息不得撤掉界面 ---------------- */
  console.log('=== 28. 启动稳定性（抗降级） ===');
  const diag0 = await b.evaluate(`window.__tsSniffer.diag()`);
  check(diag0.mounted === true, '界面处于挂载状态', JSON.stringify(diag0));
  check(diag0.isTop === true && diag0.topCertain === true, '顶层判定为「确定」', JSON.stringify(diag0));
  check(diag0.gen === diag0.alive, '所有权令牌一致', JSON.stringify(diag0));

  // 模拟旧实例残留的 ack（没有正确 nonce）：绝不能把界面撤掉
  await b.evaluate(`(() => {
    window.postMessage({ tss: 'sniff:ack', from: 'stale-instance', n: 'wrong' }, '*');
    window.postMessage({ tss: 'sniff:ack', from: 'stale-instance' }, '*');
    return true;
  })()`);
  await b.sleep(600);
  const afterAck = await b.evaluate(`window.__tsSniffer.diag()`);
  check(
    afterAck.mounted === true && afterAck.forceChild === false,
    '收到伪造 ack 后界面仍在（不再被判成子帧）',
    JSON.stringify(afterAck)
  );

  // 冒充子帧来握手：顶层不该把自己降级
  await b.evaluate(`window.postMessage({ tss: 'sniff:hello', n: 'x', frameId: 'fake' }, '*')`);
  await b.sleep(600);
  const afterHello = await b.evaluate(`window.__tsSniffer.diag()`);
  check(afterHello.mounted === true, '收到伪造 hello 后界面仍在', JSON.stringify(afterHello));

  // 看门狗：节点被摘掉后 2 秒内自愈
  await b.evaluate(`(() => {
    const h = document.getElementById('ts-sniffer-ios-host');
    if (h) h.remove();
    return true;
  })()`);
  await b.sleep(3200);
  const healed = await b.evaluate(`(() => ({
    hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
    mounted: window.__tsSniffer.diag().mounted,
  }))()`);
  check(healed.hosts === 1 && healed.mounted === true, '宿主被摘除后自动重挂', JSON.stringify(healed));

  /* ---------------- 29. 保存后刷新（回归） ---------------- */
  console.log('=== 29. 保存后刷新（回归：下载并保存 → 刷新页面 → 必须仍能启动） ===');
  await b.goto(`http://127.0.0.1:8787/dev/demo.html?savereload=${Date.now()}`);
  await b.sleep(1800);
  const verNow = await b.evaluate(`window.__tsSnifferVersion || (window.__tsSniffer ? window.__tsSniffer.version : '')`);
  check(verNow === '1.0.0', '运行的是当前构建（版本可从页面读出）', verNow);

  // 自动保存必须开着（上一节关过）
  await b.evaluate(`${SR}.querySelector('.gear[data-act="settings"]').click()`);
  await b.sleep(350);
  if ((await b.evaluate(`${SR}.querySelector('[data-set="autosave"] em').textContent.trim()`)) !== '开') {
    await b.evaluate(`${SR}.querySelector('[data-set="autosave"]').click()`);
    await b.sleep(250);
  }
  await b.evaluate(`${SR}.querySelector('.mask').click()`);
  await b.sleep(250);

  await b.evaluate(`simulate()`);
  await b.sleep(2400);
  // 关掉设置弹窗后主面板可能也收起了：确保面板开着再点下载
  await b.evaluate(`(() => {
    const sheet = ${SR}.querySelector('.sheet');
    if (!sheet.classList.contains('open')) ${SR}.querySelector('.fab').click();
    return true;
  })()`);
  await b.sleep(400);
  check((await dl('pic.jpg')) === true, '开始一次下载（自动保存开启）', '');
  await b.waitFor(
    `(() => { const j = window.__tsSniffer.jobs()[0]; return j && j.status === 'done'; })()`,
    30000
  );
  await b.sleep(1200);
  const savedState = await b.evaluate(`(() => {
    const j = window.__tsSniffer.jobs()[0];
    return { released: !!j.released, msg: j.message, proto: location.protocol };
  })()`);
  check(savedState.proto === 'http:', '保存动作后页面未被替换', savedState.proto);
  check(/已保存|已发送|合并完成|已下载/.test(savedState.msg || ''), '保存流程已执行', savedState.msg);

  // 关键：刷新之后，脚本必须重新启动
  await b.goto(`http://127.0.0.1:8787/dev/demo.html?savereload2=${Date.now()}`);
  await b.sleep(2400);
  const reloadedState = await b.evaluate(`(() => ({
    hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
    ver: window.__tsSnifferVersion || '',
    mounted: (window.__tsSniffer && window.__tsSniffer.diag) ? window.__tsSniffer.diag().mounted : null,
    proto: location.protocol,
  }))()`);
  check(reloadedState.hosts === 1, '刷新后界面重新挂载', reloadedState.hosts);
  check(reloadedState.ver === '1.0.0', '刷新后运行的仍是当前构建', reloadedState.ver);
  check(reloadedState.mounted === true, '刷新后 diag.mounted 为真', JSON.stringify(reloadedState));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  await b.close();
}
