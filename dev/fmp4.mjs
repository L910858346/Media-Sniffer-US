/**
 * fMP4 回归：最容易被误判成"下载成功但打不开"的形态
 *   node dev/fmp4.mjs
 *
 * 场景 A：播放列表带 #EXT-X-MAP（正常站点）→ 初始化段随播放列表一起下
 * 场景 B：播放列表没有 #EXT-X-MAP，分片还在别的目录
 *         → 只能回找同目录的 init.mp4，补不上就必须明确报错
 */
import { launch } from './cdp.mjs';

const SR = `document.getElementById('ts-sniffer-ios-host').shadowRoot`;

let fail = 0;
const check = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`, extra === undefined ? '' : extra);
  if (!cond) fail += 1;
};

const b = await launch({ width: 390, height: 844, dpr: 1 });

const jobOf = () =>
  b.evaluate(`(() => {
    const j = window.__tsSniffer.jobs()[0];
    return j ? { status: j.status, msg: j.message, detail: j.detail || j.message, size: j.bytes, name: j.filename } : null;
  })()`);

const clickRow = (tag, name) =>
  b.evaluate(`(() => {
    const rows = [...${SR}.querySelectorAll('.row')];
    const row = rows.find((r) => r.querySelector('.tag').textContent === ${JSON.stringify(tag)}
      && r.querySelector('.row-name').textContent.trim() === ${JSON.stringify(name)});
    if (!row) {
      return 'missing: ' + rows.map((r) => r.querySelector('.tag').textContent + ':' + r.querySelector('.row-name').textContent).join(' | ');
    }
    row.querySelector('[data-act="download"]').click();
    return 'ok';
  })()`);

const waitJobDone = () =>
  b
    .waitFor(`(() => { const j = window.__tsSniffer.jobs()[0]; return j && (j.status === 'done' || j.status === 'error'); })()`, 40000)
    .catch(() => null);

try {
  await b.goto('http://127.0.0.1:8787/dev/demo.html');
  await b.waitFor(`window.__tsSniffer && window.__tsSniffer.items().length >= 6`, 15000);
  await b.evaluate(`${SR}.querySelector('.fab').click()`);
  await b.sleep(400);

  /* ---------------- A. 带 EXT-X-MAP 的播放列表 ---------------- */
  console.log('\n=== A. fMP4 + #EXT-X-MAP ===');
  const a1 = await clickRow('M3U8', 'fmp4 / index.m3u8');
  check(a1 === 'ok', '点到 fmp4 播放列表', a1 === 'ok' ? '' : a1);
  await b.waitFor(`${SR}.querySelector('.mask .modal-body .btn')`, 8000);
  await b.evaluate(`${SR}.querySelector('.mask .modal-body .btn').click()`);
  await waitJobDone();
  await b.sleep(300);

  const a = await jobOf();
  console.log('  任务:', JSON.stringify(a));
  check(!!a && a.status === 'done', '合并成功');
  check(!!a && /^\d{14}\.mp4$/.test(a.name || ''), '按实际容器命名为「时间戳.mp4」', a && a.name);

  await b.evaluate(`${SR}.querySelector('.job [data-act="dismiss"]').click()`);
  await b.sleep(300);

  /* ---------------- B. 没有 MAP，只能回找 init.mp4 ---------------- */
  console.log('\n=== B. fMP4 无 MAP（回找 init.mp4） ===');
  const b1 = await clickRow('M4S', 'fmp4b');
  check(b1 === 'ok', '点到 fmp4b 分片分组', b1 === 'ok' ? '' : b1);
  await waitJobDone();
  await b.sleep(300);

  const bJob = await jobOf();
  console.log('  任务:', JSON.stringify(bJob));
  check(!!bJob && bJob.status === 'done', '自动补上初始化段后成功');
  check(!!bJob && /初始化段/.test(bJob.detail || bJob.msg || ''), '卡片注明补了初始化段', bJob && (bJob.detail || bJob.msg));
  check(!!bJob && /^\d{14}\.mp4$/.test(bJob.name || ''), '扩展名为 .mp4 且名称为时间戳', bJob && bJob.name);

  // 产物头部必须是 ftyp，且包含 moov
  const head = await b.evaluate(`(async () => {
    const j = window.__tsSniffer.jobs()[0];
    const u = new Uint8Array(await j.blob.slice(0, 120).arrayBuffer());
    const s = String.fromCharCode(...u);
    return { ftyp: s.indexOf('ftyp') >= 0, moov: s.indexOf('moov') >= 0 };
  })()`);
  console.log('  产物头部:', JSON.stringify(head));
  check(head.ftyp && head.moov, '产物开头带 ftyp + moov');
} finally {
  await b.close();
}

console.log(fail ? `\n✗ ${fail} 项未通过\n` : '\n✓ 全部通过\n');
process.exit(fail ? 1 : 0);
