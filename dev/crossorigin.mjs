/**
 * 跨域回归：复刻"分片不带 CORS 头"的真实站点
 *   node dev/crossorigin.mjs
 *
 * 两个场景：
 *   无 GM 通道 → 必须失败，并且错误要是网络层的（就是用户看到的 Load failed）
 *   有 GM 通道 → 必须成功走出完整分片
 */
import { launch } from './cdp.mjs';

const SR = `document.getElementById('ts-sniffer-ios-host').shadowRoot`;

async function run(gm) {
  const b = await launch({ width: 390, height: 844, dpr: 1 });
  try {
    const url = `http://127.0.0.1:8787/dev/demo.html?xorigin=1${gm ? '&gm=1' : ''}`;
    await b.goto(url);
    const got = await b
      .waitFor(`window.__tsSniffer && window.__tsSniffer.items().length >= 1`, 12000)
      .catch(() => null);

    if (!got) return { ok: false, reason: '跨域请求没有被资源计时捕获' };

    const items = await b.evaluate(`window.__tsSniffer.items().map(i => ({ kind: i.kind, name: i.name, count: i.count }))`);

    // 点 TS 分组下载
    await b.evaluate(`${SR}.querySelector('.fab').click()`);
    await b.sleep(400);
    const clicked = await b.evaluate(`(() => {
      const rows = [...${SR}.querySelectorAll('.row')];
      const row = rows.find(r => r.querySelector('.tag').textContent === 'TS')
        || rows.find(r => r.querySelector('[data-act="download"]'));
      if (!row) return false;
      row.querySelector('[data-act="download"]').click();
      return true;
    })()`);
    if (!clicked) return { ok: false, reason: '列表里没有可点的行', items };

    await b.waitFor(`${SR}.querySelector('.job .bar.done, .job .job-msg.err')`, 25000).catch(() => null);
    await b.sleep(300);

    const job = await b.evaluate(`(() => {
      const j = window.__tsSniffer.jobs()[0];
      return j ? { status: j.status, msg: j.message, detail: j.detail || j.message, size: j.bytes, total: j.total } : null;
    })()`);
    return { ok: true, items, job };
  } finally {
    await b.close();
  }
}

let fail = 0;
const check = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`, extra === undefined ? '' : extra);
  if (!cond) fail += 1;
};

console.log('\n=== 场景 A：没有 GM 通道（等价于页面直接 fetch） ===');
const a = await run(false);
check(a.ok, '脚本能在跨域源上探测到资源', a.reason || '');
if (a.ok) {
  console.log('  条目:', JSON.stringify(a.items));
  console.log('  任务:', JSON.stringify(a.job));
  check(!!a.job && a.job.status === 'error', '如实报错而不是产出坏文件');
  check(!!a.job && /跨域|Load failed|Failed to fetch|网络/i.test(a.job.msg), '错误信息说清了是跨域问题', a.job && a.job.msg);
}

console.log('\n=== 场景 B：有 GM 通道（等价于装了 Tampermonkey） ===');
const b2 = await run(true);
check(b2.ok, '脚本能在跨域源上探测到资源', b2.reason || '');
if (b2.ok) {
  console.log('  条目:', JSON.stringify(b2.items));
  console.log('  任务:', JSON.stringify(b2.job));
  check(!!b2.job && b2.job.status === 'done', '走 GM 通道成功合并');
  check(!!b2.job && /H\.264/.test(b2.job.detail || b2.job.msg || ''), '产物结构可播', b2.job && b2.job.msg);
}

console.log(`\n${fail ? `✗ ${fail} 项未通过` : '✓ 全部通过'}\n`);
process.exit(fail ? 1 : 0);
