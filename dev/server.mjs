/**
 * 本地联调服务器：给 userscript 提供假的 HLS 站点
 *   node dev/server.mjs [port]
 *
 * 目录结构（都是内存里现造的，不落盘）：
 *   /dev/demo.html                 测试页面
 *   /media-sniffer.user.js        被直接 <script> 引入的脚本本体
 *   /hls/master.m3u8               主播放列表（720p / 360p）
 *   /hls/<track>/index.m3u8        媒体播放列表（6 个分片，AES-128 可选）
 *   /hls/<track>/seg-N.ts          分片
 *   /media/clip.mp4                mp4 直链
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';

// 真实可解码的夹具（用测试浏览器现场生成，见 dev/fixtures）：
// 缩略图要真的解出画面，假字节（头 + 随机数）会让 <img>/<video> 报错
const REAL_JPG = readFileSync(new URL('./fixtures/pic.jpg', import.meta.url));
const REAL_WEBM = readFileSync(new URL('./fixtures/clip.webm', import.meta.url));
import { tsSegment } from './ts-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = Number(process.argv[2]) || 8787;

const KEY = randomBytes(16);
const SEG_COUNT = 6;
const SEGMENTS = {};
const CIPHERS = {};

for (let i = 0; i < SEG_COUNT; i++) {
  const body = tsSegment(320 + i * 20, i + 1);
  SEGMENTS[i] = body;
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(i, 12);
  const c = createCipheriv('aes-128-cbc', KEY, iv);
  CIPHERS[i] = Buffer.concat([c.update(body), c.final()]);
}

/* ---------- 合法 PNG 夹具 ----------
 * 假 PNG（头部 + 随机字节）会让浏览器解析到一半就断开连接，
 * 资源计时里记到的尺寸只有实际的一小截，"小图过滤"就测不准了。
 */
function pngCrc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

function makePng(w, h, seed = 1) {
  const stride = 1 + w * 3;
  const raw = Buffer.alloc(h * stride);
  let s = seed;
  for (let y = 0; y < h; y++) {
    const off = y * stride;
    raw[off] = 0; // filter: none
    for (let x = 0; x < w * 3; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      raw[off + 1 + x] = (s >> 16) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG_BIG = makePng(120, 120, 7);

/* ---------- fMP4 夹具：媒体分片（styp/moof/mdat）+ 初始化段（ftyp/moov） ---------- */
function box(tag, size) {
  const b = Buffer.alloc(size, 0);
  b.writeUInt32BE(size, 0);
  b.write(tag, 4, 'latin1');
  return b;
}
const FMP4_INIT = Buffer.concat([box('ftyp', 24), box('moov', 64)]);
const FMP4_SEG = [0, 1, 2].map((i) => Buffer.concat([box('styp', 24), box('moof', 96), box('mdat', 900 + i * 40)]));

const playlist = (variant) => `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-PLAYLIST-TYPE:VOD
${variant === 'enc' ? '#EXT-X-KEY:METHOD=AES-128,URI="key.bin?v=1"' : ''}
${Array.from({ length: SEG_COUNT }, (_, i) => `#EXTINF:10,\nseg-${i}.ts`).join('\n')}
#EXT-X-ENDLIST
`;

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.42e01e,mp4a.40.2"
360p/index.m3u8
`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

async function handler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = decodeURIComponent(url.pathname);

  // 同源代理：让测试里的 GM 桩真正具备"服务端抓取"的特权（不受 CORS 约束）
  if (p === '/__proxy') {
    const target = url.searchParams.get('u');
    try {
      const r = await fetch(target, { headers: {} });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, {
        'content-type': r.headers.get('content-type') || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(buf);
    } catch (err) {
      console.error('[proxy]', target, '->', err && err.message);
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('proxy failed: ' + err.message);
    }
    return;
  }

  const seg = /^\/hls\/(\w+)\/seg-(\d+)\.ts$/.exec(p);
  if (seg) {
    const track = seg[1];
    const i = Number(seg[2]);
    if (track === 'zero') {
      // 模拟被 IDM 之类的下载器接管：204 + 空 body
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (track === 'off') {
      // 每个分片都被塞了 3 字节前缀：真实站点偶发，会让后续 TS 包全部错位
      res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' });
      res.end(Buffer.concat([Buffer.from([1, 2, 3]), SEGMENTS[i]]));
      return;
    }
    if (track === 'junk') {
      // 模拟防盗链返回的网页 / 乱码
      res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' });
      res.end(Buffer.from('<html><body>403 forbidden</body></html>'));
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' });
    res.end(track === 'enc' ? CIPHERS[i] : SEGMENTS[i]);
    return;
  }

  // fMP4：播放列表带 #EXT-X-MAP（正常站点的样子）
  if (p === '/hls/fmp4/index.m3u8') {
    const list = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MAP:URI="init.mp4"',
    ];
    for (let i = 0; i < 3; i++) list.push('#EXTINF:10,', `seg-${i}.m4s`);
    list.push('#EXT-X-ENDLIST');
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
    res.end(list.join('\n'));
    return;
  }

  // fMP4 但播放列表**没有** #EXT-X-MAP，分片还在另一个目录：只能靠回找 init.mp4
  if (p === '/hls/fmp4b/index.m3u8') {
    const list = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-PLAYLIST-TYPE:VOD'];
    for (let i = 0; i < 3; i++) list.push('#EXTINF:10,', `/cdn/fmp4b/seg-${i}.m4s`);
    list.push('#EXT-X-ENDLIST');
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
    res.end(list.join('\n'));
    return;
  }

  const f4 = /^\/(?:hls|cdn)\/fmp4b?\/(init\.mp4|seg-(\d+)\.m4s)$/.exec(p);
  if (f4) {
    res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
    res.end(f4[1] === 'init.mp4' ? FMP4_INIT : FMP4_SEG[Number(f4[2])]);
    return;
  }

  const track = /^\/hls\/(\w+)\/index\.m3u8$/.exec(p);
  // enc2 有专门的路由（分片放在 /cdn/ 前缀下），别被通用路由吃掉
  if (track && track[1] !== 'enc2') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
    res.end(playlist(track[1]));
    return;
  }

  // 真实站点最常见的形态：播放列表在 API 域（/hls/…），分片在 CDN 前缀（/cdn/…）。
  // 早先按目录比对的实现永远找不到这种播放列表，于是只能拿到密文。
  if (p === '/hls/enc2/index.m3u8') {
    const list = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-KEY:METHOD=AES-128,URI="/hls/enc2/key.bin?v=1"',
    ];
    for (let i = 0; i < SEG_COUNT; i++) list.push('#EXTINF:10,', `/cdn/enc2/seg-${i}.ts`);
    list.push('#EXT-X-ENDLIST');
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
    res.end(list.join('\n'));
    return;
  }

  if (p === '/hls/enc2/key.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(KEY);
    return;
  }

  const cdn2 = /^\/cdn\/enc2\/seg-(\d+)\.ts$/.exec(p);
  if (cdn2) {
    res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' });
    res.end(CIPHERS[Number(cdn2[1])]);
    return;
  }

  const cdn3 = /^\/cdn\/enc3\/seg-(\d+)\.ts$/.exec(p);
  if (cdn3) {
    res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' });
    res.end(CIPHERS[Number(cdn3[1])]);
    return;
  }

  if (p === '/hls/enc3/key.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(KEY);
    return;
  }

  if (p === '/hls/enc/key.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(KEY);
    return;
  }

  // 明文原件，供联调脚本逐字节比对解密结果
  if (p === '/hls/enc/plain.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(Buffer.concat(Object.values(SEGMENTS)));
    return;
  }

  if (p === '/hls/master.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
    res.end(MASTER);
    return;
  }

  if (p === '/media/clip.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
    res.end(Buffer.concat([Buffer.from('ftyp'), randomBytes(80_000)]));
    return;
  }

  // 直链视频 / 图片夹具（覆盖新增的格式探测）
  if (p === '/media/clip.mov') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypqt  '), randomBytes(60_000)]));
    return;
  }

  if (p === '/media/clip.avi') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(Buffer.concat([Buffer.from('RIFF'), randomBytes(50_000)]));
    return;
  }

  if (p === '/media/pic.jpg') {
    // 真实 JPEG（130 KB，带噪声），缩略图能真正显示出来
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
    res.end(REAL_JPG);
    return;
  }

  if (p === '/media/clip.webm') {
    // 真实 WebM（canvas 录屏产物），<video #t=0.1> 能解出首帧当缩略图
    res.writeHead(200, { 'content-type': 'video/webm', 'cache-control': 'no-store' });
    res.end(REAL_WEBM);
    return;
  }

  if (p === '/media/tiny.gif') {
    // 6 KB：低于图片门槛，应该被过滤掉，不占列表
    res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
    res.end(Buffer.concat([Buffer.from('GIF89a'), randomBytes(6_000)]));
    return;
  }

  if (p === '/media/always403.mp4') {
    // 无论如何都 403：用来验证「交给浏览器下载」这条退路
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('denied');
    return;
  }

  if (p === '/media/hotlink-range.mp4') {
    // 更严的防盗链：必须像播放器那样带 Range 才放行
    res.setHeader('access-control-allow-origin', 'http://127.0.0.1:8787');
    res.setHeader('access-control-allow-headers', 'range');
    if (!req.headers.range) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('need range');
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
    res.end(Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypisom'), randomBytes(90_000)]));
    return;
  }

  if (p === '/media/hotlink.mp4') {
    // 防盗链：要求 Referer 带上完整页面路径；只发 Origin 的请求一律 403
    const ref = String(req.headers.referer || '');
    res.setHeader('access-control-allow-origin', 'http://127.0.0.1:8787');
    if (!/\/dev\/demo\.html/.test(ref)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('hotlink denied');
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
    res.end(Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypisom'), randomBytes(120_000)]));
    return;
  }

  if (p === '/media/inner.mp3') {
    // 只在内嵌页里请求：用来验证 iframe 条目合并到顶层
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
    res.end(Buffer.concat([Buffer.from('ID3'), randomBytes(90_000)]));
    return;
  }

  if (p === '/media/tone.mp3') {
    // 带 ID3 头的假音频：够探测、够下载，不需要真能放
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
    res.end(Buffer.concat([Buffer.from('ID3'), randomBytes(80_000)]));
    return;
  }

  if (p === '/media/voice') {
    // 无扩展名音频：只能靠 Content-Type / initiatorType 认
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
    res.end(Buffer.concat([Buffer.from('ID3'), randomBytes(60_000)]));
    return;
  }

  if (p === '/media/photo') {
    // 无扩展名 + <img> 加载：URL 与 Content-Type 双盲，只能靠 initiatorType/DOM 扫描认出
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
    res.end(REAL_JPG);
    return;
  }

  if (p === '/media/icon.svg') {
    // 16KB 但 24x24：字节过滤放行，分辨率过滤应该拦下
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
    res.end(readFileSync(new URL('./fixtures/icon.svg', import.meta.url)));
    return;
  }

  if (p === '/media/logo.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(PNG_BIG);
    return;
  }

  // 无扩展名：只能靠 Content-Type 认出来
  if (p === '/img') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(PNG_BIG);
    return;
  }

  // 静态文件
  const file = path.join(root, p === '/' ? '/dev/demo.html' : p);
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found: ' + p);
  }
}

const server = http.createServer(handler);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`demo: http://127.0.0.1:${PORT}/dev/demo.html`);
  console.log(`      ?open=1     自动展开面板`);
  console.log(`      ?job=1      自动跑一次合并下载`);
  console.log(`      ?gm=1       注入 GM_xmlhttpRequest 桩，模拟脚本管理器的特权通道`);
  console.log(`      ?xorigin=1  分片改从 127.0.0.1:${PORT + 1} 取（跨域且不带 CORS 头）`);
});

// 再开一个端口，专门用来伪造"跨域且没有 CORS 头"的分片源
http.createServer(handler).listen(PORT + 1, '127.0.0.1', () => {
  console.log(`cross-origin 源: http://127.0.0.1:${PORT + 1}`);
});
