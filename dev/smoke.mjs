/**
 * 启动冒烟测试（改动后先跑这个，5 秒出结果）
 *   node dev/smoke.mjs
 *
 * 专门抓"node --check 过了但浏览器里 IIFE 直接炸掉"的错误
 * （例如 const 声明顺序造成的 TDZ——语法检查不报错，脚本一注入就死）。
 */
import { launch } from './cdp.mjs';

const b = await launch({ width: 390, height: 844, dpr: 1 });
let fail = 0;
try {
  await b.goto(`http://127.0.0.1:8787/dev/demo.html?smoke=${Date.now()}`);
  await b.sleep(1600);
  const st = await b.evaluate(`(() => ({
    ver: window.__tsSnifferVersion || '',
    hosts: document.querySelectorAll('#ts-sniffer-ios-host').length,
    mounted: (window.__tsSniffer && window.__tsSniffer.diag) ? window.__tsSniffer.diag().mounted : null,
    boot: document.documentElement.dataset.tssBoot || '',
  }))()`);
  console.log('  ', JSON.stringify(st));
  const ok =
    st.ver !== '' &&
    st.hosts === 1 &&
    st.mounted === true;
  console.log(ok ? '冒烟通过' : '冒烟失败：脚本没有正常启动');
  if (!ok) fail = 1;
} catch (e) {
  console.log('冒烟失败：', e.message);
  fail = 1;
} finally {
  await b.close();
}
process.exit(fail);
