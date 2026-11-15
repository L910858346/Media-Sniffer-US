/**
 * 脚本管理器沙箱模拟
 *   node dev/sandbox.mjs
 *
 * 为什么需要这一套：
 * 声明了 @grant 的脚本在 Tampermonkey 里跑在**沙箱**中，`window` 是代理对象，
 * `unsafeWindow` 才是页面真正的 window。这带来两个只有真实环境才暴露的坑：
 *
 *   1. `window.top === window` 因为代理身份不一致而恒为 false
 *      → 顶层页面被误判成内嵌页 → 界面永不出现（"有时不运行"）
 *   2. 往 `window` 上写属性不保证落到页面
 *      → 所有权令牌 / 拆除入口 / 调试接口在另一个实例或控制台看来不存在
 *
 * 这里用 Proxy 精确复刻这两种失真，并在同页连跑两个实例验证接管。
 */
import { launch } from './cdp.mjs';

let fail = 0;
const check = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`, extra === undefined ? '' : extra);
  if (!cond) fail += 1;
};

/**
 * 在页面里装一个沙箱实例。
 * @param {string} name 实例名（日志用）
 * @param {boolean} withUnsafe 是否提供 unsafeWindow（TM 提供；个别管理器不提供）
 * @param {boolean} dropWrites 是否让写入 window 无效（模拟属性落不到页面）
 */
const INSTALL = (name, withUnsafe, dropWrites) => `(async () => {
  const src = await (await fetch('/media-sniffer.user.js?sb=' + Date.now())).text();
  const real = window;
  const proxy = new Proxy(real, {
    get(t, k) {
      // 沙箱里 top/parent 拿到的是真实顶层，与代理本身 identity 不同
      if (k === 'top' || k === 'parent') return t;
      if (k === 'frameElement') throw new Error('SecurityError: 沙箱禁止 frameElement');
      if (k === 'unsafeWindow') return ${withUnsafe ? 't' : 'undefined'};
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) {
      if (${dropWrites}) return true; // 丢弃：写进沙箱不落到页面
      try { t[k] = v; } catch {}
      return true;
    },
    has() { return true; },
  });
  const store = {};
  const GM_getValue = (k, d) => (k in store ? store[k] : d);
  const GM_setValue = (k, v) => { store[k] = v; };
  const GM_xmlhttpRequest = undefined;
  const factory = new Function(
    'window', 'unsafeWindow', 'GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest',
    '"use strict";\\n' + src
  );
  factory.call(proxy, proxy, ${withUnsafe ? 'real' : 'undefined'}, GM_getValue, GM_setValue, GM_xmlhttpRequest);
  // 证据不足的帧有 2.6s 挂载冷静期（等握手纠正角色），断言要跨过它
  await new Promise((r) => setTimeout(r, 3400));
  return {
    name: ${JSON.stringify(name)},
    // 关键：从"页面世界"读，模拟用户在控制台敲 __tsSniffer
    hookOnPage: typeof real.__tsSniffer,
    diag: real.__tsSniffer && real.__tsSniffer.diag ? real.__tsSniffer.diag() : null,
    gen: real.__tsSnifferGen,
    alive: real.__tsSnifferAlive,
    teardownIsFn: typeof real.__tsSnifferTeardown === 'function',
    hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
  };
})()`;

const b = await launch({ width: 390, height: 844, dpr: 1 });
try {
  /* ---------------- 场景 A：标准 TM 沙箱（有 unsafeWindow） ---------------- */
  console.log('=== A. TM 沙箱：window 是代理，unsafeWindow 可用 ===');
  await b.goto(`http://127.0.0.1:8787/dev/tm.html?a=${Date.now()}`);
  await b.sleep(600);
  const a = await b.evaluate(INSTALL('A', true, true));
  console.log('  ', JSON.stringify(a));
  check(a.hookOnPage === 'object', '页面世界能读到 __tsSniffer（控制台可排查）', a.hookOnPage);
  check(a.diag && a.diag.isTop === true, '代理 window 下仍判定为顶层', a.diag && String(a.diag.isTop));
  check(a.diag && a.diag.topCertain === true, '角色判定为「确定」，握手不可降级', a.diag && String(a.diag.topCertain));
  check(a.diag && a.diag.mounted === true, '界面已挂载', a.diag && String(a.diag.mounted));
  check(a.hosts === 1, '页面上只有一个宿主', String(a.hosts));
  check(a.gen === 1 && a.alive === 1, '所有权令牌 = 1', `${a.gen}/${a.alive}`);
  check(a.teardownIsFn === true, '拆除入口登记到页面世界（下次可接管）', String(a.teardownIsFn));

  /* ---------------- 场景 B：同页第二个实例接管 ---------------- */
  console.log('\n=== B. 同页再注入一个实例：必须接管且只留一个宿主 ===');
  const b2 = await b.evaluate(INSTALL('B', true, true));
  console.log('  ', JSON.stringify(b2));
  check(b2.gen === 2 && b2.alive === 2, '代际递增到 2，令牌同步', `${b2.gen}/${b2.alive}`);
  check(b2.diag && b2.diag.mounted === true, '新实例挂载成功', b2.diag && String(b2.diag.mounted));
  check(b2.hosts === 1, '旧宿主已被拆除，只剩一个', String(b2.hosts));

  /* ---------------- 场景 C：没有 unsafeWindow 的沙箱（最恶劣） ---------------- */
  console.log('\n=== C. 无 unsafeWindow：两路判据都失真，仍须挂出界面 ===');
  await b.goto(`http://127.0.0.1:8787/dev/tm.html?c=${Date.now()}`);
  await b.sleep(500);
  const c = await b.evaluate(INSTALL('C', false, false));
  console.log('  ', JSON.stringify(c));
  check(c.hookOnPage === 'object', '页面世界仍能读到 __tsSniffer', c.hookOnPage);
  check(c.diag && c.diag.mounted === true, '界面仍然挂载（证据不足先挂）', c.diag && String(c.diag.mounted));
  check(c.hosts === 1, '页面上只有一个宿主', String(c.hosts));

  /* ---------------- 场景 D：沙箱内界面功能 ---------------- */
  console.log('\n=== D. 沙箱内功能抽检：面板 / 页签 / 设置 ===');
  const ui = await b.evaluate(`(async () => {
    const host = document.getElementById('ts-sniffer-ios-host');
    const sr = host && host.shadowRoot;
    if (!sr) return { ok: false, why: 'no shadow' };
    sr.querySelector('.fab').click();
    await new Promise((r) => setTimeout(r, 500));
    const open = sr.querySelector('.sheet').classList.contains('open');
    const tabs = [...sr.querySelectorAll('.tabs .tab')].map((t) => t.textContent.trim());
    sr.querySelector('.gear[data-act="settings"]').click();
    await new Promise((r) => setTimeout(r, 500));
    const modal = sr.querySelector('.modal');
    const title = modal ? modal.querySelector('.modal-title').textContent : '';
    if (modal) sr.querySelector('.mask').click();
    return { open, tabs, title };
  })()`);
  check(ui.open === true, '面板可打开', JSON.stringify(ui));
  check(['全部', '视频', '图片', '音频'].every((t) => ui.tabs.includes(t)), '页签完整', JSON.stringify(ui.tabs));
  check(/设置 · v/.test(ui.title), '设置面板可打开', ui.title);

  console.log(fail ? `\n失败 ${fail} 项` : '\n全部通过');
  if (fail) process.exitCode = 1;
} finally {
  await b.close();
}
