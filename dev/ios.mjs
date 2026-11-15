/**
 * iOS 保存路径回归
 *   node dev/ios.mjs
 *
 * 复现的条件不是"有没有下载"，而是 **iOS Safari 在无用户手势时点 blob 下载链接
 * 会把当前标签页导航成 blob: 文档**。那个文档永远不会被注入用户脚本，
 * 用户再刷新就是刷新 blob: —— 于是"下载保存之后脚本不运行了"。
 *
 * 这里用 iPhone UA 让脚本走 iOS 分支，验证：
 *   1) 自动保存不再直接触发下载（页面不会被换掉）
 *   2) 任务进入挂起态（不再显示引导文字）
 *   3) 用户点保存后恢复正常保存路径，页面依旧存活
 */
import { launch } from './cdp.mjs';

let fail = 0;
const check = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`, extra === undefined ? '' : String(extra));
  if (!cond) fail += 1;
};
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const b = await launch({ width: 390, height: 844, dpr: 3 });
try {
  await b.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA }, b.sessionId);

  console.log('=== 1. iOS 识别 ===');
  await b.goto(`http://127.0.0.1:8787/dev/demo.html?ios=${Date.now()}`);
  await b.sleep(2000);
  const isIos = await b.evaluate(`(() => ({
    ua: navigator.userAgent.includes('iPhone'),
    boot: document.documentElement.dataset.tssBoot || '',
    hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
  }))()`);
  console.log('  ', JSON.stringify(isIos));
  check(isIos.ua === true, 'UA 已切到 iPhone', isIos.ua);
  check(isIos.hosts === 1, '界面已挂载', isIos.hosts);

  console.log('\n=== 2. 完成一次下载（自动保存开启） ===');
  await b.sleep(6000); // 等此前 CDP 手势产生的瞬态激活态过期（iOS 上同样如此）
  await b.evaluate(`(typeof simulate === 'function' ? (simulate(), true) : false)`).catch(() => {});
  await b.sleep(2200);
  // 模拟"下载结束时手势已过期"：iOS 上自动保存正是发生在这个时刻，
  // 也是它会把页面导航走的前提。CDP 的 userGesture 在无头里不会自然过期，
  // 所以直接在页面里覆盖成失效态，比反复和驱动层博弈可靠。
  const actOff = await b.evaluate(`(() => {
    Object.defineProperty(navigator, 'userActivation', {
      value: { isActive: false, hasBeenActive: true },
      configurable: true,
    });
    return navigator.userActivation.isActive;
  })()`);
  check(actOff === false, '已模拟「手势已过期」', actOff);

  // 关键：用 userGesture:false 触发，等价于"下载跑了几秒后激活态已过期"。
  // iOS 上自动保存正是发生在这个时刻——这也是它会把页面导航走的前提。
  const started = (
    await b.send(
      'Runtime.evaluate',
      {
        expression: `(async () => {
          const sr = document.getElementById('ts-sniffer-ios-host').shadowRoot;
          const sheet = sr.querySelector('.sheet');
          if (!sheet.classList.contains('open')) sr.querySelector('.fab').click();
          await new Promise((r) => setTimeout(r, 400));
          const btn = sr.querySelector('.row [data-act="download"]');
          if (!btn) return 'no-btn';
          btn.click();
          return 'clicked';
        })()`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
      },
      b.sessionId
    )
  ).result.value;
  check(started === 'clicked', '已点下载', started);

  // 轮询必须用 userGesture:false：带手势的 evaluate 会不断续期激活态，
  // 那就永远测不到"下载结束时手势已过期"这个真实前提。
  const rawEval = async (expression) =>
    (
      await b.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, userGesture: false },
        b.sessionId
      )
    ).result.value;

  let job = null;
  for (let i = 0; i < 60; i++) {
    await b.sleep(500);
    job = await rawEval(`(() => {
      const j = (window.__tsSniffer.jobs() || [])[0];
      const d = window.__tsSniffer.diag();
      return j ? { status: j.status, msg: j.message, pending: !!j.pendingSave, href: location.href, proto: location.protocol, isIOS: d.isIOS, act: d.activated } : null;
    })()`);
    if (job && (job.status === 'done' || job.status === 'error')) break;
  }
  console.log('  ', JSON.stringify(job));
  check(!!job && job.status === 'done', '下载任务完成', job && job.status);
  check(job && job.proto === 'http:', '页面仍是 http 文档（没有被导航到 blob:）', job && job.href?.slice(0, 40));
  check(job && job.pending === true, '自动保存转为挂起态', job && job.pending);
  check(job && !/已就绪/.test(job.msg || ''), '卡片上不出现引导文字', job && job.msg);

  console.log('\n=== 3. 页面存活（脚本仍在） ===');
  const alive1 = await b.evaluate(`(() => ({
    hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
    hook: typeof window.__tsSniffer,
    diag: (window.__tsSniffer && window.__tsSniffer.diag) ? window.__tsSniffer.diag().mounted : null,
  }))()`);
  console.log('  ', JSON.stringify(alive1));
  check(alive1.hosts === 1 && alive1.diag === true, '保存动作后界面仍在', JSON.stringify(alive1));

  console.log('\n=== 4. 点「保存文件」→ 恢复正常保存 ===');
  // 恢复真实激活态：用户这一下点击是真手势
  await b.evaluate(`(() => { try { delete navigator.userActivation; } catch (e) {} return true; })()`);
  const tapped = await b.evaluate(`(async () => {
    const sr = document.getElementById('ts-sniffer-ios-host').shadowRoot;
    const btn = sr.querySelector('[data-act="save"]');
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    const j = (window.__tsSniffer.jobs() || [])[0];
    return { pending: !!(j && j.pendingSave), msg: j ? j.message : '', proto: location.protocol };
  })()`);
  console.log('  ', JSON.stringify(tapped));
  check(tapped.pending === false, '挂起态已清除', JSON.stringify(tapped));
  check(tapped.proto === 'http:', '点保存后页面仍是 http 文档', tapped.proto);

  console.log('\n=== 4b. 站点存储足迹必须为零 ===');
  const footprint = await b.evaluate(`(() => ({
    settings: localStorage.getItem('tss_ios_settings_v2'),
    fab: localStorage.getItem('tss_fab_pos'),
    keys: Object.keys(localStorage).filter((k) => k.startsWith('tss_')),
  }))()`);
  console.log('  ', JSON.stringify(footprint));
  check(footprint.keys.length === 0, 'iOS 未向站点 localStorage 写入任何数据（避免"清网站数据"才能恢复）', JSON.stringify(footprint.keys));

  console.log('\n=== 5. 刷新后脚本仍运行 ===');
  await b.goto(`http://127.0.0.1:8787/dev/demo.html?reload=${Date.now()}`);
  await b.sleep(2600);
  const after = await b.evaluate(`(() => ({
    hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
    diag: (window.__tsSniffer && window.__tsSniffer.diag) ? window.__tsSniffer.diag() : null,
  }))()`);
  console.log('  ', JSON.stringify(after && after.diag));
  check(after.hosts === 1 && after.diag && after.diag.mounted === true, '刷新后界面仍正常', after.hosts);

  console.log(fail ? `\n失败 ${fail} 项` : '\n全部通过');
  if (fail) process.exitCode = 1;
} finally {
  await b.close();
}
