/**
 * 加密分片回归：复刻用户实际遇到的那两种站点
 *   node dev/encrypted.mjs
 *
 * 场景 A：播放列表在 /hls/，分片在 /cdn/ —— 按目录比对永远找不到，
 *         必须靠"分片名重合"回找到播放列表 → 拿到密钥 → 自动解密成功
 * 场景 B：页面里只有密文分片，播放列表和密钥都拿不到 ——
 *         必须明确告诉用户"这是密文"，并提供「输入密钥解密」的手工出口
 */
import { launch } from './cdp.mjs';

const SR = `document.getElementById('ts-sniffer-ios-host').shadowRoot`;

let fail = 0;
const check = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`, extra === undefined ? '' : extra);
  if (!cond) fail += 1;
};

const b = await launch({ width: 390, height: 844, dpr: 1 });

const clickGroup = (name) =>
  b.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.row')];
    const row = rows.find((r) => r.querySelector('.tag') && r.querySelector('.tag').textContent === 'TS'
      && r.querySelector('.row-name').textContent.trim() === ${JSON.stringify(name)});
    if (!row) {
      return 'missing: ' + rows.map((r) => (r.querySelector('.tag') || {}).textContent + ':' + r.querySelector('.row-name').textContent).join(' | ');
    }
    row.querySelector('[data-act="download"]').click();
    return 'ok';
  })()`);

const jobOf = () =>
  b.evaluate(`(() => {
    const j = window.__tsSniffer.jobs()[0];
    return j ? { status: j.status, msg: j.message, size: j.bytes, encrypted: !!j.encrypted } : null;
  })()`);

try {
  await b.goto('http://127.0.0.1:8787/dev/demo.html');
  await b.waitFor(`window.__tsSniffer && window.__tsSniffer.items().length >= 6`, 15000);

  await b.evaluate(`${SR}.querySelector('.fab').click()`);
  await b.waitFor(`${SR}.querySelector('.sheet').classList.contains('open')`, 4000);
  await b.sleep(400);

  /* ================= 场景 A：自动回找播放列表 + 自动解密 ================= */
  console.log('\n=== A. 播放列表与分片不同目录（自动回找 + 解密） ===');
  const aClick = await clickGroup('enc2');
  check(aClick === 'ok', '点到 enc2 的 TS 分组', aClick === 'ok' ? '' : aClick);

  await b.waitFor(`(() => {
    const j = window.__tsSniffer.jobs()[0];
    return j && (j.status === 'done' || j.status === 'error');
  })()`, 40000).catch(() => null);
  await b.sleep(300);

  const a = await jobOf();
  console.log('  任务:', JSON.stringify(a));
  check(!!a && a.status === 'done', '自动解密后合并成功');
  check(!!a && /^(合并完成|已保存) · [\d.]+ (KB|MB|B)$/.test(a.msg || ''), '完成提示只含结果与大小', a && a.msg);
  check(!!a && a.size > 0, '产物体积正常', a && a.size);

  // 同一次会话里再下一次同一分组：必须同样自动解密。
  // 这一步专门盯"同一媒体有时要密钥、有时不要"——第二次走的是
  // "分片目录 → 已用过的播放列表"记忆分支，不应再要求手填 key。
  const aAgain = await clickGroup('enc2');
  check(aAgain === 'ok', '再次点到 enc2 的 TS 分组', aAgain === 'ok' ? '' : aAgain);
  await b
    .waitFor(
      `(() => {
        const j = window.__tsSniffer.jobs()[0];
        return j && (j.status === 'done' || j.status === 'error');
      })()`,
      40000
    )
    .catch(() => null);
  await b.sleep(300);
  const a2 = await jobOf();
  console.log('  第二次任务:', JSON.stringify(a2));
  check(
    !!a2 && a2.status === 'done' && a2.encrypted === false,
    '第二次下载同样自动解密，行为一致',
    a2 && a2.msg
  );

  await b.evaluate(`${SR}.querySelector('.job [data-act="dismiss"]').click()`);
  await b.sleep(300);

  /* ================= 场景 B：只能手工填密钥 ================= */
  console.log('\n=== B. 只有密文（手工输入密钥解密） ===');
  const bClick = await clickGroup('enc3');
  check(bClick === 'ok', '点到 enc3 的 TS 分组', bClick === 'ok' ? '' : bClick);

  await b.waitFor(`(() => {
    const j = window.__tsSniffer.jobs()[0];
    return j && (j.status === 'done' || j.status === 'error');
  })()`, 40000).catch(() => null);
  await b.sleep(400);

  const bJob = await jobOf();
  console.log('  任务:', JSON.stringify(bJob));
  check(!!bJob && bJob.status === 'error', '没有密钥时如实失败，不产出坏文件');
  check(!!bJob && bJob.encrypted === true, '被标记为密文');
  check(!!bJob && /密文/.test(bJob.msg || ''), '错误信息说清了是密文', bJob && bJob.msg);

  const hasKeyBtn = await b.evaluate(`!!${SR}.querySelector('.job [data-act="key"]')`);
  check(hasKeyBtn, '卡片上有「输入密钥解密」');

  if (hasKeyBtn) {
    await b.evaluate(`${SR}.querySelector('.job [data-act="key"]').click()`);
    await b.waitFor(`${SR}.querySelector('.mask .modal-input')`, 4000);
    await b.sleep(200);
    await b.evaluate(`(() => {
      const input = ${SR}.querySelector('.mask .modal-input');
      input.value = '/hls/enc3/key.bin?v=1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      ${SR}.querySelector('.mask .modal-body .btn').click();
    })()`);

    await b.waitFor(`(() => {
      const j = window.__tsSniffer.jobs()[0];
      return j && j.status !== 'running';
    })()`, 30000).catch(() => null);
    await b.sleep(400);

    const after = await jobOf();
    console.log('  解密后:', JSON.stringify(after));
    check(!!after && after.status === 'done', '手工密钥解密成功');
    check(!!after && /^(合并完成|已保存) · [\d.]+ (KB|MB|B)$/.test(after.msg || ''), '解密产物可播放且提示精简', after && after.msg);
    check(!!after && after.encrypted === false, '产物不再是密文', after && after.encrypted);
  }
} finally {
  await b.close();
}

console.log(fail ? `\n✗ ${fail} 项未通过\n` : '\n✓ 全部通过\n');
process.exit(fail ? 1 : 0);
