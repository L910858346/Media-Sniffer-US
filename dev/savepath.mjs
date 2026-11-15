/**
 * 落盘回归：验证"磁盘上的文件"和"内存里的 Blob"逐字节一致
 *   node dev/savepath.mjs
 * 这一步专门排除"浏览器下载把文件写坏"的可能。
 */
import { launch } from './cdp.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const SR = `document.getElementById('ts-sniffer-ios-host').shadowRoot`;
const DIR = path.resolve('.dl');
await fs.rm(DIR, { recursive: true, force: true });
await fs.mkdir(DIR, { recursive: true });

const b = await launch({ width: 390, height: 844, dpr: 1 });
try {
  await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DIR, eventsEnabled: true });
  await b.goto('http://127.0.0.1:8787/dev/demo.html');
  await b.waitFor(`window.__tsSniffer && window.__tsSniffer.items().length >= 6`, 15000);
  await b.evaluate(`${SR}.querySelector('.fab').click()`);
  await b.sleep(400);
  await b.evaluate(`(() => {
    const rows=[...${SR}.querySelectorAll('.row')];
    rows.find(r=>r.querySelector('.tag').textContent==='TS' && r.querySelector('.row-name').textContent.trim()==='enc2')
      .querySelector('[data-act="download"]').click();
  })()`);
  await b.waitFor(`(() => { const j=window.__tsSniffer.jobs()[0]; return j && j.status==='done'; })()`, 40000);
  await b.sleep(500);

  const meta = await b.evaluate(`(async () => {
    const j = window.__tsSniffer.jobs()[0];
    const buf = new Uint8Array(await j.blob.arrayBuffer());
    return { name: j.filename, size: buf.length, type: j.blob.type, head: [...buf.slice(0,4)].map(x=>x.toString(16)).join(' ') };
  })()`);
  console.log('内存里的 blob:', JSON.stringify(meta));

  // headless 里 showSaveFilePicker 会挂起（原生对话框不弹），删掉它验证 a[download] 这条路
  await b.evaluate(`delete window.showSaveFilePicker`);
  await b.evaluate(`${SR}.querySelector('.job [data-act="save"]').click()`);
  await b.sleep(600);
  console.log('toast:', await b.evaluate(`${SR}.querySelector('.toast').innerText`));
  // 等文件落盘
  let file = null;
  for (let i = 0; i < 40; i++) {
    await b.sleep(250);
    const list = await fs.readdir(DIR).catch(() => []);
    const done = list.find((f) => !f.endsWith('.crdownload'));
    if (done) { file = done; break; }
  }
  if (!file) { console.log('✗ 没有文件落盘'); process.exitCode = 1; }
  else {
    const buf = await fs.readFile(path.join(DIR, file));
    console.log('磁盘文件:', file, buf.length, '字节, 头', [...buf.subarray(0,4)].map(x=>x.toString(16)).join(' '));
    console.log(buf.length === meta.size ? '✓ 磁盘字节数与内存一致' : `✗ 大小不符 ${buf.length} vs ${meta.size}`);
    console.log(buf[0] === 0x47 && buf[188] === 0x47 ? '✓ 落盘后仍是包对齐的 TS' : '✗ 落盘后不是 TS');
    if (buf.length !== meta.size || buf[0] !== 0x47) process.exitCode = 1;
  }
} finally { await b.close(); }
