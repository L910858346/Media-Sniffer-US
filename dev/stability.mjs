/**
 * 启动稳定性压测
 *   node dev/stability.mjs
 *
 * 三组场景，全部必须通过：
 *   ① 连续冷启动 —— 每次都要出界面（对应"打开网页有时不运行"）
 *   ② 同一页面连续重注入 —— 每次都要只剩一个宿主且可用（对应"第二次不运行"）
 *   ③ 连续摘除宿主 —— 看门狗要在 2 秒内自愈
 */
import { launch } from './cdp.mjs';

let fail = 0;
const check = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`, extra === undefined ? '' : extra);
  if (!cond) fail += 1;
};

const b = await launch({ width: 390, height: 844, dpr: 1 });

try {
  console.log('=== 1. 连续冷启动 ===');
  for (let i = 1; i <= 6; i++) {
    await b.goto(`http://127.0.0.1:8787/dev/demo.html?cold=${i}&t=${Date.now()}`);
    await b.sleep(1300);
    const d = await b.evaluate(`(window.__tsSniffer && window.__tsSniffer.diag) ? window.__tsSniffer.diag() : null`);
    check(!!d && d.mounted === true, `第 ${i} 次冷启动界面出现`, d ? JSON.stringify(d) : '未注入');
  }

  console.log('\n=== 2. 同一页面连续重注入 ===');
  await b.goto(`http://127.0.0.1:8787/dev/demo.html?rep=1&t=${Date.now()}`);
  await b.sleep(1300);
  for (let i = 2; i <= 5; i++) {
    await b.evaluate(`(() => {
      const s = document.createElement('script');
      s.src = '/media-sniffer.user.js?r=${i}';
      document.documentElement.appendChild(s);
      return true;
    })()`);
    await b.sleep(1500);
    const st = await b.evaluate(`(() => ({
      hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
      diag: window.__tsSniffer.diag(),
    }))()`);
    check(
      st.hosts === 1 && st.diag.mounted === true,
      `第 ${i} 次注入后：唯一宿主且已挂载`,
      JSON.stringify(st)
    );
  }

  console.log('\n=== 3. 宿主被摘除后自愈 ===');
  for (let i = 1; i <= 2; i++) {
    await b.evaluate(`(() => {
      const h = document.getElementById('ts-sniffer-ios-host');
      if (h) h.remove();
      return true;
    })()`);
    await b.sleep(2700);
    const st = await b.evaluate(`(() => ({
      hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
      mounted: window.__tsSniffer.diag().mounted,
    }))()`);
    check(st.hosts === 1 && st.mounted === true, `第 ${i} 次摘除后自动恢复`, JSON.stringify(st));
  }

  console.log(fail ? `\n失败 ${fail} 项` : '\n全部通过');
  if (fail) process.exitCode = 1;
} finally {
  await b.close();
}
