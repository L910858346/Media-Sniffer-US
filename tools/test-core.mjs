/**
 * TS Sniffer iOS 核心自测
 *   node tools/test-core.mjs
 *
 * 做两件事：
 *   1. 从 .user.js 里抽出 /* #region CORE *\/ 段，跑解析器断言
 *   2. 起一个本地 HTTP 服务，用真的 AES-128 加密 HLS 跑通
 *      「主列表 → 选码率 → 抓分片 → 解密 → 顺序合并」，逐字节比对明文
 *
 * 这样测的是浏览器里真正会执行的那份代码，而不是复制粘贴的副本。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, randomBytes } from 'node:crypto';
import { tsSegment, TS_PACKET } from '../dev/ts-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const USERJS = path.join(here, '..', 'media-sniffer.user.js');

let pass = 0;
let fail = 0;

function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  ✓', label);
  } else {
    fail++;
    console.error('  ✗', label, extra === undefined ? '' : JSON.stringify(extra));
  }
}

function section(name) {
  console.log(`\n[${name}]`);
}

/* ------------------------------------------------------------------ *
 * 0. 抽取核心段
 * ------------------------------------------------------------------ */

const src = await fs.readFile(USERJS, 'utf8');
const START = '/* #region CORE */';
const END = '/* #endregion CORE */';
const s = src.indexOf(START);
const e = src.indexOf(END);
if (s < 0 || e < 0 || e < s) {
  console.error('找不到 CORE 区域标记');
  process.exit(1);
}

const coreSource = src.slice(s + START.length, e);
const EXPORTS = [
  'parseM3U8',
  'parseAttributes',
  'parseByterange',
  'orderSegments',
  'planForSegments',
  'buildUnits',
  'buildFilename',
  'sanitize',
  'looksLikeWebPage',
  'classifyByUrl',
  'classifyByContentType',
  'extFromUrl',
  'resolveExt',
  'mimeForExt',
  'hexToBytes',
  'sequenceIv',
  'runPlan',
  'inspectPlaylist',
  'planFromPlaylist',
  'findTsSync',
  'normalizeTs',
  'finalizeOutput',
  'analyzeTs',
  'detectContainer',
  'detectTsLayout',
  'byteEntropy',
  'toTs188',
  'findBoxTag',
  'dirUrlOf',
];

const core = new Function(`${coreSource}\nreturn { ${EXPORTS.join(', ')} };`)();
console.log(`核心段 ${coreSource.split('\n').length} 行，导出 ${Object.keys(core).length} 个函数`);

/* ------------------------------------------------------------------ *
 * 1. 资源分类
 * ------------------------------------------------------------------ */

section('1. 资源分类');
ok(core.classifyByUrl('https://a.com/x/seg-1.ts') === 'ts', '识别 .ts');
ok(core.classifyByUrl('https://a.com/x/seg-1.ts?token=abc') === 'ts', '带 query 的 .ts');
ok(core.classifyByUrl('https://a.com/x/index.m3u8') === 'm3u8', '识别 .m3u8');
ok(core.classifyByUrl('https://a.com/x/init.mp4') === 'mp4', '识别 .mp4');
ok(core.classifyByUrl('https://a.com/x/seg.m4s') === 'm4s', '识别 .m4s');
ok(core.classifyByUrl('https://a.com/page.html') === null, '网页不当资源');
ok(core.classifyByContentType('application/vnd.apple.mpegurl') === 'm3u8', 'Content-Type 兜底 m3u8');
ok(core.classifyByContentType('video/mp2t') === 'ts', 'Content-Type 兜底 ts');
ok(core.classifyByContentType('text/html') === null, 'text/html 不认');

/* ------------------------------------------------------------------ *
 * 2. 主播放列表
 * ------------------------------------------------------------------ */

section('1b. 视频 / 图片格式识别');

// 视频：新增 mov / avi / mkv / mpg 等直链格式
ok(core.classifyByUrl('https://a.com/v/clip.mov') === 'video', '.mov');
ok(core.classifyByUrl('https://a.com/v/clip.AVI') === 'video', '.avi（大写）');
ok(core.classifyByUrl('https://a.com/v/clip.mkv') === 'video', '.mkv');
ok(core.classifyByUrl('https://a.com/v/clip.mpg') === 'video', '.mpg');
ok(core.classifyByUrl('https://a.com/v/clip.webm') === 'video', '.webm');
ok(core.classifyByUrl('https://a.com/v/clip.flv') === 'video', '.flv');
ok(core.classifyByUrl('https://a.com/v/clip.wmv') === 'video', '.wmv');
ok(core.classifyByUrl('https://a.com/v/clip.3gp') === 'video', '.3gp');

// 图片
ok(core.classifyByUrl('https://a.com/i/a.jpeg') === 'image', '.jpeg');
ok(core.classifyByUrl('https://a.com/i/a.JPG') === 'image', '.JPG（大写）');
ok(core.classifyByUrl('https://a.com/i/a.png') === 'image', '.png');
ok(core.classifyByUrl('https://a.com/i/a.gif') === 'image', '.gif');
ok(core.classifyByUrl('https://a.com/i/a.webp') === 'image', '.webp');
ok(core.classifyByUrl('https://a.com/i/a.avif') === 'image', '.avif');
ok(core.classifyByUrl('https://a.com/i/a.svg') === 'image', '.svg');

// 老类型不能被新规则打乱
ok(core.classifyByUrl('https://a.com/a.m3u8') === 'm3u8', '.m3u8 仍是播放列表');
ok(core.classifyByUrl('https://a.com/a.ts') === 'ts', '.ts 仍是分片');
ok(core.classifyByUrl('https://a.com/a.m4s') === 'm4s', '.m4s 仍是分片');
ok(core.classifyByUrl('https://a.com/a.mp4') === 'mp4', '.mp4 仍是 mp4');
ok(core.classifyByUrl('https://a.com/a.mp3') === 'audio', '.mp3 仍是音频');
ok(core.classifyByUrl('https://a.com/img?id=1') === null, '无扩展名不瞎猜');

// Content-Type 兜底
ok(core.classifyByContentType('image/jpeg') === 'image', 'CT image/jpeg');
ok(core.classifyByContentType('image/svg+xml') === 'image', 'CT svg');
ok(core.classifyByContentType('video/quicktime') === 'video', 'CT video/quicktime');
ok(core.classifyByContentType('text/html') === null, 'CT html 不算资源');

// 下载扩展名 / MIME
ok(core.resolveExt('https://a.com/a.mov', '', 'video') === 'mov', '扩展名取 URL');
ok(core.resolveExt('https://a.com/img?id=1', 'video/quicktime', 'video') === 'mov', '无扩展名取 CT');
ok(core.resolveExt('https://a.com/x', 'image/png', 'image') === 'png', 'PNG 用 CT');
ok(core.resolveExt('https://a.com/x', '', 'image') === 'jpg', '都缺时图片兜底 jpg');
ok(core.mimeForExt('mov') === 'video/quicktime', 'mov 的 MIME');
ok(core.mimeForExt('jpg') === 'image/jpeg', 'jpg 的 MIME');
ok(core.mimeForExt('weird') === 'application/octet-stream', '未知扩展名兜底');

section('2. 主播放列表');
const master = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="中文",LANGUAGE="zh",DEFAULT=YES,URI="audio/zh.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42e01e,mp4a.40.2"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080
https://cdn.example.com/1080p/index.m3u8
`;
const m = core.parseM3U8(master, 'https://cdn.example.com/hls/master.m3u8');
ok(m.type === 'master', '识别为主播放列表');
ok(m.variants.length === 3, '解析出 3 个码率', m.variants.length);
ok(m.variants[0].bandwidth === 6000000, '按带宽降序排列');
ok(m.variants[0].label.includes('1080p'), '清晰度标签含 1080p', m.variants[0].label);
ok(m.variants[1].url === 'https://cdn.example.com/hls/720p/index.m3u8', '相对路径补全正确', m.variants[1].url);
ok(m.audioRenditions.length === 1 && m.audioRenditions[0].language === 'zh', '解析独立音轨');

/* ------------------------------------------------------------------ *
 * 3. 媒体播放列表
 * ------------------------------------------------------------------ */

section('3. 媒体播放列表（密钥 / 字节范围 / fMP4 初始化段）');
const media = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:42
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0000000000000000000000000000002a
#EXTINF:6.006,
seg-42.m4s
#EXTINF:6.006,
#EXT-X-BYTERANGE:2048@0
seg-43.m4s
#EXTINF:4.2,
seg-44.m4s
#EXT-X-ENDLIST
`;
const p = core.parseM3U8(media, 'https://cdn.example.com/v/playlist.m3u8');
ok(p.type === 'media', '识别为媒体播放列表');
ok(p.segments.length === 3, '解析出 3 个分片', p.segments.length);
ok(p.segments[0].url === 'https://cdn.example.com/v/seg-42.m4s', '分片地址补全');
ok(p.segments[0].seq === 42, '媒体序列号起始正确', p.segments[0].seq);
ok(p.segments[0].key && p.segments[0].key.method === 'AES-128', '密钥作用于后续分片');
ok(p.segments[1].byterange && p.segments[1].byterange.length === 2048, '字节范围解析正确', p.segments[1].byterange);
ok(p.map && p.map.url.endsWith('/v/init.mp4'), '初始化段解析正确');
ok(p.isFMP4 === true, '识别为 fMP4');
ok(p.hasEndList === true, '识别 VOD（有 ENDLIST）');
ok(Math.abs(p.totalDuration - 16.212) < 0.01, '总时长计算正确', p.totalDuration);

/* ------------------------------------------------------------------ *
 * 4. 分片排序（iOS 端的并发探测会打乱到达顺序）
 * ------------------------------------------------------------------ */

section('4. 分片排序');
const shuffled = [
  'https://a.com/v/seg-10.ts',
  'https://a.com/v/seg-2.ts',
  'https://a.com/v/seg-1.ts',
  'https://a.com/v/seg-100.ts',
];
const ordered = core.orderSegments(shuffled);
ok(ordered[0].endsWith('seg-1.ts') && ordered[1].endsWith('seg-2.ts') && ordered[3].endsWith('seg-100.ts'), '按数字升序', ordered);
const noNum = ['https://a.com/v/a.ts', 'https://a.com/v/b.ts'];
ok(core.orderSegments(noNum).join() === noNum.join(), '无数字时保持原序');
const dupNum = ['https://a.com/1/seg-1.ts', 'https://a.com/2/seg-1.ts'];
ok(core.orderSegments(dupNum).join() === dupNum.join(), '序号重复时不乱排');

/* ------------------------------------------------------------------ *
 * 5. 文件名
 * ------------------------------------------------------------------ */

section('5. 文件名（下载时间戳）');

// 例：2026 年 11 月 13 日 21:18:36 → 20261113211836.ts
const fn = core.buildFilename({ at: new Date(2026, 10, 13, 21, 18, 36), isFMP4: false });
ok(fn === '20261113211836.ts', '文件名 = 年月日时分秒', fn);
ok(!/[\\/:*?"<>|]/.test(fn), '文件名不含非法字符', fn);

// 个位数要补零
const early = core.buildFilename({ at: new Date(2026, 0, 2, 3, 4, 5), isFMP4: false });
ok(early === '20260102030405.ts', '年 + 月/日/时/分/秒都补零', early);

ok(core.buildFilename({ at: new Date(2026, 10, 13, 21, 18, 36), isFMP4: true }) === '20261113211836.mp4', 'fMP4 输出 .mp4');
ok(core.buildFilename({ at: new Date(2026, 10, 13, 21, 18, 36), ext: 'm4a' }) === '20261113211836.m4a', 'ext 优先');

// 同一秒的两次下载不该撞名（相隔 1 秒就不同）
const a1 = core.buildFilename({ at: new Date(2026, 10, 13, 21, 18, 36) });
const a2 = core.buildFilename({ at: new Date(2026, 10, 13, 21, 18, 37) });
ok(a1 !== a2, '不同秒的文件名不同', a1 + ' vs ' + a2);

/* 扩展名推断：路径优先，路径没有就看 query（腾讯 ftn_handler 的 ?fname=hd.mp4） */
ok(core.extFromUrl('https://a.com/v/clip.mp4') === 'mp4', '路径里的扩展名', core.extFromUrl('https://a.com/v/clip.mp4'));
ok(
  core.extFromUrl('https://njc-download.ftn.qq.com/ftn_handler/abc123/?fname=hd.mp4') === 'mp4',
  '路径无扩展名时取 ?fname=',
  core.extFromUrl('https://njc-download.ftn.qq.com/ftn_handler/abc123/?fname=hd.mp4')
);
ok(
  core.extFromUrl('https://a.com/dl?filename=movie.mkv') === 'mkv',
  '?filename= 也认',
  core.extFromUrl('https://a.com/dl?filename=movie.mkv')
);
ok(core.extFromUrl('https://a.com/ftn_handler/abc123/') === '', '都没有就返回空串', core.extFromUrl('https://a.com/ftn_handler/abc123/'));

/* ------------------------------------------------------------------ *
 * 6. 合并产物体检：TS 包对齐
 * ------------------------------------------------------------------ */

section('6. 合并产物体检（TS 188 字节包对齐）');

const PACKET = TS_PACKET;

/**
 * 造 count 个包的 TS 分片（带 PAT/PMT），prefix / tail 用来制造脏数据。
 * 用 dev/ts-fixture.mjs 的构造器，保证和联调服务器、真实站点同构。
 */
function makeTs(count, { prefix = 0, tail = 0, withPsi = true } = {}) {
  const body = Buffer.from(tsSegment(count, 3, { withPsi }));
  const pre = Buffer.alloc(prefix, 0xaa);
  const post = Buffer.alloc(tail, 0xbb);
  return new Uint8Array(Buffer.concat([pre, body, post]));
}

// 1) 完全规整
{
  const parts = [makeTs(10), makeTs(8)];
  const r = core.finalizeOutput(parts, false);
  ok(r.ok === true && r.notes.length === 0, '规整的 TS 直接通过');
  ok(parts.reduce((a, b) => a + b.byteLength, 0) === 18 * PACKET, '总长为整包数');
}

// 2) 首个分片前面有垃圾（例如被插了一段广告头/JSON）
{
  const parts = [makeTs(10, { prefix: 5 }), makeTs(8)];
  const r = core.finalizeOutput(parts, false);
  const total = parts.reduce((a, b) => a + b.byteLength, 0);
  ok(r.ok === true, '带垃圾前缀也能修复');
  ok(parts[0].byteLength === 10 * PACKET, '开头垃圾被剥掉');
  ok(total === 18 * PACKET, `修复后总长正确（实际 ${total}）`);
  ok(parts[0][0] === 0x47 && parts[0][PACKET] === 0x47, '修复后仍然包对齐');
}

// 3) 中间某个分片长度不是 188 的倍数 —— 这就是播放器"无法解析"的典型成因
{
  const parts = [makeTs(5), makeTs(5, { tail: 7 }), makeTs(5)];
  const r = core.finalizeOutput(parts, false);
  const total = parts.reduce((a, b) => a + b.byteLength, 0);
  ok(r.ok === true, '长度错位的分片会被裁齐');
  ok(parts[1].byteLength === 5 * PACKET, '错位分片裁到整包');
  ok(total % PACKET === 0, '总长是 188 的整数倍');
  // 关键：裁齐后第三个分片刚好从包边界开始
  const third = parts[0].byteLength + parts[1].byteLength;
  ok(third % PACKET === 0, '后续分片仍然对齐');
}

// 3b) 每个分片前面都带 3 字节杂质 —— 中间段同样会错位
{
  const parts = [makeTs(4, { prefix: 3 }), makeTs(4, { prefix: 3 }), makeTs(4, { prefix: 3 })];
  const r = core.finalizeOutput(parts, false);
  const total = parts.reduce((a, b) => a + b.byteLength, 0);
  ok(r.ok === true, '逐段杂质也能修复');
  ok(total === 12 * PACKET, `逐段修复后总长正确（实际 ${total}）`);
  ok(parts.every((p) => p[0] === 0x47), '每段都回到包边界');
}

// 4) 整体不是 TS
{
  const junk = [new Uint8Array(Buffer.from('{"error":"forbidden"}'))];
  const r = core.finalizeOutput(junk, false);
  ok(r.ok === false, '非 TS 内容会被判定失败');
  ok(typeof r.head === 'string' && r.head.length > 0, '带上开头字节便于定位', r.head);
}

// 5) 空产物
{
  ok(core.finalizeOutput([], false).ok === false, '空产物直接失败');
}

// 6) fMP4
{
  const box = (tag, size) => {
    const b = Buffer.alloc(size);
    b.writeUInt32BE(size, 0);
    b.write(tag, 4, 'latin1');
    return b;
  };
  const withInit = new Uint8Array(Buffer.concat([box('ftyp', 24), box('moov', 64), box('moof', 120)]));
  const noInit = new Uint8Array(Buffer.concat([box('styp', 24), box('moof', 120)]));

  ok(core.finalizeOutput([withInit], true).ok === true, 'fMP4 头识别（带 moov）');

  // 只有媒体分片、没有初始化段 —— 播放器会报"无法解析影音播放信息"
  const bad = core.finalizeOutput([noInit], false);
  ok(bad.ok === false && bad.needInit === true, '缺少 moov 的 fMP4 会被拦下', bad.reason);
  const bad2 = core.finalizeOutput([noInit], true);
  ok(bad2.ok === false && bad2.needInit === true, '标了 fMP4 也一样要 moov');
  // 标了 fMP4 但其实是 TS —— 现在按实际容器走，不再误杀
  const mixed = core.finalizeOutput([makeTs(3)], true);
  ok(mixed.ok === true && mixed.container === 'ts', '标了 fMP4 但数据是 TS 时按 TS 处理');
}

/* ------------------------------------------------------------------ *
 * 6c. 容器识别：密文 / M2TS / MP4 / 网页
 * ------------------------------------------------------------------ */

section('6c. 容器识别（密文 / M2TS / MP4 / 网页）');

// 用户实际遇到的那串头部字节：高熵、无同步结构 → 必须判成密文
{
  const cipher = Buffer.from('003fcb4dadad8fe4a9bdf4d4b1fb93b8', 'hex');
  const body = Buffer.alloc(6000);
  for (let i = 0; i < body.length; i++) body[i] = (i * 73 + 41 + cipher[i % 16]) % 256;
  cipher.copy(body, 0);
  const d = core.detectContainer([new Uint8Array(body)]);
  ok(d.kind === 'encrypted', '高熵无结构数据判为密文', d.kind);
  ok(d.entropy > 7.2, `熵足够高（${d.entropy.toFixed(2)}）`);
  ok(d.head.startsWith('00 3f cb 4d'), '头部字节可回显给用户', d.head);
}

// 真 TS 不会被误判成密文
{
  const d = core.detectContainer([makeTs(40)]);
  ok(d.kind === 'ts', 'TS 判为 ts', d.kind);
  ok(d.entropy < 7.2, `TS 的熵明显更低（${d.entropy.toFixed(2)}）`);
}

// M2TS：192 字节包，0x47 在第 5 个字节
{
  const packets = 40;
  const buf = Buffer.alloc(packets * 192);
  for (let p = 0; p < packets; p++) {
    const off = p * 192;
    buf[off] = p & 0xff; // 时间戳
    buf[off + 4] = 0x47;
    for (let i = 5; i < 192; i++) buf[off + i] = ((p * 11 + i) % 254) + 1;
  }
  const d = core.detectContainer([new Uint8Array(buf)]);
  ok(d.kind === 'm2ts' && d.packetSize === 192, 'M2TS 被识别', d.kind);
  const parts = [new Uint8Array(buf)];
  const r = core.finalizeOutput(parts, false);
  ok(r.ok === true, 'M2TS 能自动转成 188 并合并');
  ok(parts[0].byteLength === packets * 188, `转换后长度正确（${parts[0].byteLength}）`);
  ok(parts[0][0] === 0x47 && parts[0][188] === 0x47, '转换后包对齐');
}

// MP4：box 头不在偏移 4 也要认得（有的封装前面多几个字节）
{
  const buf = Buffer.alloc(200);
  Buffer.from([0, 0, 0, 24]).copy(buf, 2);
  Buffer.from('ftyp', 'latin1').copy(buf, 6);
  Buffer.from([0, 0, 0, 64]).copy(buf, 30);
  Buffer.from('moov', 'latin1').copy(buf, 34);
  const d = core.detectContainer([new Uint8Array(buf)]);
  ok(d.kind === 'mp4', '偏移处也能认 ftyp', d.kind);
  ok(core.finalizeOutput([new Uint8Array(buf)], false).ok === true, '带 moov 的 MP4 放行');
}

// 网页 / 图片
{
  const html = new Uint8Array(Buffer.from('<!doctype html><html><body>403</body></html>'));
  ok(core.detectContainer([html]).kind === 'web', '网页判为 web');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  ok(core.detectContainer([png]).kind === 'image', 'PNG 判为 image');
}

// 7) findTsSync 边界
{
  ok(core.findTsSync(makeTs(1)) === -1, '不足 3 个包时不误判');
  ok(core.findTsSync(makeTs(4)) === 0, '从 0 开始对齐');
}

/* ------------------------------------------------------------------ *
 * 6b. TS 结构分析：判断"播放器认不认"
 * ------------------------------------------------------------------ */

section('6b. TS 结构分析（PAT / PMT / 编码）');

{
  const parts = [makeTs(40), makeTs(40)];
  const info = core.analyzeTs(parts);
  ok(info.packets === 80, `包数统计正确（${info.packets}）`);
  ok(info.hasPat === true, '找到 PAT');
  ok(info.hasPmt === true, '找到 PMT');
  ok(info.pmtPid === 0x1000, 'PMT PID 正确', info.pmtPid);
  ok(info.codecs.includes('H.264') && info.codecs.includes('AAC'), '识别出 H.264 + AAC', info.codecs);
  ok(info.scrambled === false, '未标记加扰');
}

// 没有 PAT/PMT 的 TS —— 正是"无法解析影音播放信息"的那种
{
  const info = core.analyzeTs([makeTs(30, { withPsi: false })]);
  ok(info.packets > 0, '包仍然数得出来');
  ok(info.hasPmt === false, '没有 PMT 会被判为不可播');
}

// 节目表 CRC：真实流必须能过，这是"播放器认不认"的硬门槛
{
  const parts = [makeTs(40), makeTs(40)];
  const info = core.analyzeTs(parts);
  ok(info.patCrcOk === true, 'PAT 的 CRC 校验通过');
  ok(info.pmtCrcOk === true, 'PMT 的 CRC 校验通过');
  ok(info.scrambled === false, '未标记加扰');
  ok(info.silentPids.length === 1 && info.silentPids[0] === 0x101, '没送数据的音频 PID 被点出来', info.silentPids);
  ok(info.ccErrors === 0, `连续计数器无断裂（检查了 ${info.ccChecked} 个包）`);
}

// 把 PAT 里一个字节改掉 → CRC 必须报错
{
  const part = makeTs(20);
  part[9] ^= 0xff;
  const info = core.analyzeTs([part]);
  ok(info.hasPat === true, '仍能认出这是 PAT');
  ok(info.patCrcOk === false, 'CRC 不匹配会被抓出来');
}

// 加扰标志
{
  const part = makeTs(20);
  part[3] = (part[3] & 0x3f) | 0x80;
  const info = core.analyzeTs([part]);
  ok(info.scrambled === true, '加扰标志能被识别');
}

// 加密 / 随机数据：即便凑巧撞上个别 0x47，也绝不可能解出节目表
{
  const fake = new Uint8Array(randomBytes(4096));
  const info = core.analyzeTs([fake]);
  ok(info.hasPmt === false && info.codecs.length === 0, '随机数据解不出节目表与编码');
}

// 目录推导
{
  ok(core.dirUrlOf('https://a.com/hls/1/seg-9.ts') === 'https://a.com/hls/1/', '目录推导正确');
  ok(core.dirUrlOf('https://a.com/x.m3u8') === 'https://a.com/', '根目录下的文件');
}

/* ------------------------------------------------------------------ *
 * 7. 端到端：AES-128 加密 HLS
 * ------------------------------------------------------------------ */

section('7. 端到端：AES-128 加密 + 乱序返回');

const KEY = randomBytes(16);
const SEG_COUNT = 7;
const MEDIA_SEQUENCE = 100;
const plaintexts = [];
const ciphertexts = [];

for (let i = 0; i < SEG_COUNT; i++) {
  const body = Buffer.concat([Buffer.from(`SEG-${i}|`), randomBytes(800 + i * 37)]);
  plaintexts.push(body);
  const iv = Buffer.from(core.sequenceIv(MEDIA_SEQUENCE + i)); // 测试序列号推 IV
  const cipher = createCipheriv('aes-128-cbc', KEY, iv);
  ciphertexts.push(Buffer.concat([cipher.update(body), cipher.final()]));
}

const ALL = Buffer.concat([
  randomBytes(100),
  randomBytes(150),
  randomBytes(200),
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const routes = {
  '/hls/master.m3u8': [200, 'application/vnd.apple.mpegurl', `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
high/index.m3u8
`],
  '/hls/high/index.m3u8': [200, 'application/vnd.apple.mpegurl', `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:${MEDIA_SEQUENCE}
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
${plaintexts.map((_, i) => `#EXTINF:10,\nseg-${i}.ts`).join('\n')}
#EXT-X-ENDLIST
`],
  '/hls/high/key.bin': [200, 'application/octet-stream', KEY],
  '/range/index.m3u8': [200, 'application/vnd.apple.mpegurl', `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:10
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10,
#EXT-X-BYTERANGE:100@0
all.ts
#EXTINF:10,
#EXT-X-BYTERANGE:150@100
all.ts
#EXTINF:10,
#EXT-X-BYTERANGE:200@250
all.ts
#EXT-X-ENDLIST
`],
  // 故意忽略 Range，测试客户端自行截取
  '/range/all.ts': [200, 'video/mp2t', ALL],
  '/html.ts': [200, 'text/html', '<!DOCTYPE html><html><body>login</body></html>'],
};

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://127.0.0.1').pathname;
  const segMatch = /^\/hls\/high\/seg-(\d+)\.ts$/.exec(p);

  if (segMatch) {
    const i = Number(segMatch[1]);
    // 越靠前的分片返回越慢，强制乱序完成
    await sleep(20 * (SEG_COUNT - i));
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    res.end(ciphertexts[i]);
    return;
  }
  if (routes[p]) {
    const [status, type, body] = routes[p];
    res.writeHead(status, { 'content-type': type });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

const io = {
  async bytes(url, headers = {}) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.httpStatus = res.status;
      throw err;
    }
    const ab = await res.arrayBuffer();
    return { bytes: new Uint8Array(ab), status: res.status, partial: res.status === 206 };
  },
  async text(url) {
    const r = await this.bytes(url, {});
    return new TextDecoder().decode(r.bytes);
  },
};

try {
  const info = await core.inspectPlaylist(`${BASE}/hls/master.m3u8`, io);
  ok(info.type === 'master' && info.variants.length === 2, '预解析认出主列表与 2 条轨道');
  ok(info.variants[0].label.includes('720p'), '最高码率排在首位', info.variants[0].label);

  const plan = await core.planFromPlaylist(`${BASE}/hls/master.m3u8`, 0, io);
  ok(plan.units.length === SEG_COUNT, '选中轨道后得到 7 个分片', plan.units.length);
  ok(plan.quality.includes('720p'), '记录清晰度标签', plan.quality);
  ok(plan.isFMP4 === false, '识别为 MPEG-TS');

  const progress = [];
  const result = await core.runPlan(plan, io, {
    concurrency: 4,
    onProgress: (ev) => progress.push(ev.done),
  });

  const merged = Buffer.concat(result.parts.map((u) => Buffer.from(u)));
  const expected = Buffer.concat(plaintexts);
  ok(merged.length === expected.length, `合并体积一致（${merged.length} B）`);
  ok(merged.equals(expected), '解密后逐字节等于原始明文，且顺序正确');
  ok(result.total === 7 && result.parts.length === 7, '分片数量对得上');
  ok(progress.length >= 1, '进度回调有输出', progress.length);

  // ---- 字节范围：服务器忽略 Range，客户端自行截取 ----
  const rangePlan = await core.planFromPlaylist(`${BASE}/range/index.m3u8`, -1, io);
  ok(rangePlan.units.length === 3, 'byterange 列表 3 个分片');
  const rangeResult = await core.runPlan(rangePlan, io, { concurrency: 2 });
  const rangeMerged = Buffer.concat(rangeResult.parts.map((u) => Buffer.from(u)));
  ok(rangeMerged.length === 450, `byterange 合并 450 B（实际 ${rangeMerged.length}）`);
  ok(rangeMerged.equals(ALL.subarray(0, 450)), 'byterange 截取位置正确');

  // ---- 异常路径 ----
  let htmlErr = null;
  try {
    await core.runPlan({ units: [{ url: `${BASE}/html.ts`, seq: 0 }], isFMP4: false }, io, {});
  } catch (err) {
    htmlErr = err;
  }
  ok(htmlErr && /网页而不是视频分片/.test(htmlErr.message), '识别出服务器返回网页', htmlErr && htmlErr.message);

  let missingErr = null;
  try {
    await core.runPlan({ units: [{ url: `${BASE}/missing.ts`, seq: 0 }], isFMP4: false }, io, {});
  } catch (err) {
    missingErr = err;
  }
  ok(missingErr && /HTTP 404/.test(missingErr.message), '404 会明确报错', missingErr && missingErr.message);

  // ---- 取消 ----
  let cancelled = null;
  try {
    const slowPlan = await core.planFromPlaylist(`${BASE}/hls/master.m3u8`, 0, io);
    let n = 0;
    await core.runPlan(slowPlan, io, { concurrency: 1, isCancelled: () => ++n > 2 });
  } catch (err) {
    cancelled = err;
  }
  ok(cancelled && cancelled.canceled === true, '取消会抛 canceled 错误');
} finally {
  server.close();
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
