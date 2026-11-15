// ==UserScript==
// @name         网媒探测 · Media Sniffer
// @name:en      Media Sniffer
// @namespace    media-sniffer
// @version      1.0.0
// @description  探测网页里的视频与图片：HLS(m3u8/ts)、mp4/mov/avi/mkv/webm/flv，以及 jpg/png/gif/webp/avif 等。分片自动合并、AES-128 解密、按下载时间命名保存。为 iOS Safari（Userscripts / Tampermonkey）优化，桌面端同样可用。
// @author       media-sniffer
// @match        *://*/*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

/**
 * Media Sniffer · 网媒探测
 * ==================================================================
 * 为 iOS Safari（Userscripts / Tampermonkey）设计，桌面端同样可用。
 * iOS Safari 没有 webRequest / downloads / offscreen 这些扩展底座，
 * 本脚本用纯页面能力实现了等价的三层结构：
 *
 *   探测层  PerformanceObserver(resource) + fetch/XHR 钩子 + 媒体地址监听
 *           —— 资源计时能看到页面发出的每一个资源请求（含原生 HLS 播放）
 *           —— 扩展名认不出的地址（/img?id=1）用响应的 Content-Type 兜底
 *   下载层  HLS 分片并发抓取 → 内存顺序拼装 → 产物体检/修复；
 *           直链视频与图片直接单文件下载 → Blob → 另存为 / Web Share
 *   解密层  WebCrypto AES-CBC，按 #EXT-X-KEY 的 IV 规则解密
 *
 * 四条硬约束：
 *   · 特权通道：声明 GM_xmlhttpRequest + @connect *，跨域资源读不到时走脚本管理器
 *     的通道；同时用 GM_getValue / GM_setValue 保存设置，换站点也不会丢。
 *     脚本管理器不提供这些 API 时（例如部分 iOS 环境）自动退回页面 fetch 与
 *     localStorage，功能不中断
 *   · 只读探测：不 patch HTMLMediaElement，只做捕获阶段监听 + MutationObserver
 *   · 下载走页面 fetch：同源带 cookie，跨域必须 omit —— 带 cookie 的跨域请求
 *     会和 Access-Control-Allow-Origin: * 冲突，直接 "Load failed"
 *   · 落盘前必须先回答"播放器认不认"：包对齐（188/192/208）→ 是否密文 →
 *     PAT/PMT → 编码。认不出来就报错并给出下一步，绝不产出打不开的文件
 *
 * 使用边界写在 README 里，请先读一遍再用。
 */
(() => {
  'use strict';

  /* ---------------- 实例所有权 ----------------
   * 同一页面被再次注入（更新脚本、脚本管理器重复注入）时，必须保证
   * "旧实例彻底停手、新实例独占界面"。三个机制配合：
   *
   *   1) window.__tsSnifferAlive —— 单调递增的"在世实例"编号，
   *      只有编号与之相等的实例才允许干活（挂界面、记条目、回消息）
   *   2) window.__tsSnifferTeardown —— 旧实例登记的自毁入口，
   *      新实例启动时先调它，把旧界面、监听、定时器清干净
   *   3) 所有写入路径都先问一句 superseded()
   *
   * 关键教训：这两个全局名必须完全一致。之前登记的是
   * __mediaSnifferTeardown、调用的是 __tsSnifferTeardown，
   * 于是"先拆旧实例"从来没生效过——旧实例的 message 监听会替新实例的握手
   * 回 ack，新实例误判自己是内嵌页而拒绝挂界面，表现就是"脚本不运行"。
   */
  /**
   * 同时写入"沙箱 window"与"页面真实 window"。
   *
   * 声明 @grant 之后，脚本管理器会把 window 换成代理对象：往里写属性不保证
   * 落到页面上，读回来的也可能不是同一个对象。所有权令牌要是只写进沙箱，
   * 另一个实例（或页面里的调试调用）就看不见它——"旧实例没停手"于是以概率
   * 形式复现。两边都写、读的时候取最大值，才是可靠的。
   */
  function exposeGlobal(name, value) {
    for (const w of [window, pageWindow()]) {
      try {
        if (w) w[name] = value;
      } catch {
        /* 页面被冻结等极端情况：忽略 */
      }
    }
  }

  /** 从沙箱与页面两侧读同一个全局值，取较大者（代际/编号只增不减） */
  function readGlobal(name) {
    let best = 0;
    for (const w of [window, pageWindow()]) {
      try {
        const v = Number(w && w[name]);
        if (Number.isFinite(v) && v > best) best = v;
      } catch {
        /* 忽略 */
      }
    }
    return best;
  }

  const GEN = (() => {
    try {
      const next = readGlobal('__tsSnifferGen') + 1;
      exposeGlobal('__tsSnifferGen', next);
      // 只允许代际更大的一方接管，两个实例同时初始化时不会互相覆盖
      if (readGlobal('__tsSnifferAlive') < next) exposeGlobal('__tsSnifferAlive', next);
      return next;
    } catch {
      return 1;
    }
  })();

  // 最早期的存活标记：用来区分「脚本根本没注入」与「注入了但没挂起来」。
  // 只能写在 documentElement 上——它在脚本执行时一定存在，且不依赖任何后续逻辑。
  try {
    const root = document.documentElement;
    if (root) {
      root.dataset.tssBoot = String(GEN);
      root.dataset.tssBootAt = String(Date.now());
    }
  } catch {
    /* 忽略 */
  }

  /** 自己是否已被更新的实例取代 */
  function superseded() {
    try {
      // 用数值比较：全局值万一被写成字符串，严格不等会把"自己"误判成"已被取代"
      return readGlobal('__tsSnifferAlive') !== GEN;
    } catch {
      return false;
    }
  }

  // 先接管所有权，再拆旧实例：即使拆解过程抛错，旧实例也已经停手
  try {
    const seen = new Set();
    for (const key of ['__tsSnifferTeardown', '__mediaSnifferTeardown']) {
      for (const w of [window, pageWindow()]) {
        const prev = w && w[key];
        // 同一个拆除函数可能同时登记在两侧，只能调一次
        if (typeof prev === 'function' && !seen.has(prev)) {
          seen.add(prev);
          prev();
        }
      }
    }
  } catch {
    /* 忽略 */
  }
  exposeGlobal('__tsSnifferTeardown', null);
  exposeGlobal('__mediaSnifferTeardown', null);

  // 已有更新的实例在跑（并发注入），本实例直接退出，不参与任何工作
  if (superseded()) return;

  /* ================================================================== *
   * 0. 运行环境
   * ================================================================== */

  /**
   * 自己在不在最外层。用两条互不依赖的证据判断，任一条失真还有另一条：
   *
   *   · window.top === window —— 常规做法；但脚本管理器沙箱里 window 是代理，
   *     这个比较可能为 false 甚至抛错
   *   · window.frameElement —— 规范属性：顶层为 null，子帧返回 iframe 元素，
   *     跨域子帧访问会抛错（抛错即说明必定是子帧）
   *
   * 两条都指向"顶层"时记为 certain。**确定是顶层就永不自降为子帧**——
   * 这是"偶发不运行"的最后一环：旧实例残留的监听回一句 ack，
   * 就能把已经挂好的界面撤掉，页面于是什么都看不到。
   */
  const FRAME = (() => {
    // 必须用页面真实 window 判断：沙箱里 window 是代理对象，
    // window.top === window 会因为两侧身份不一致而恒为 false，
    // 顶层页面就被误判成"内嵌页"——界面永远不出现，正是"有时不运行"。
    //
    // 两条证据的**真实语义**（跨域内嵌页实测）：
    //   · w.top === w      —— 真顶层必然成立；任何内嵌页（跨域与否）必然不成立。
    //                          这一条本身就是可靠的"顶层"证据。
    //   · w.frameElement   —— **顶层和跨域内嵌页都返回 null**（跨域不抛错，实测）；
    //                          只有**同源**内嵌页返回 iframe 元素。
    //                          所以它只能用来确认"同源子帧"，绝不能反过来确认顶层。
    //
    // 判定表：
    //   top === self                      → 确定顶层（握手都省了）
    //   frameElement 是元素               → 确定同源子帧（不挂界面）
    //   其余（跨域子帧 / 沙箱里证据失真） → 证据不足：交给握手纠正，
    //                                          挂载走 2.6s 冷静期（mountHoldUntil）
    const w = pageWindow();
    let byTop = null;
    try {
      byTop = w.top === w;
    } catch {
      byTop = null;
    }
    let byFrame = null; // true=顶层特征(null) / false=同源子帧(拿到元素) / null=不可用
    try {
      if (w.frameElement === null) byFrame = true;
      else if (w.frameElement) byFrame = false;
    } catch {
      byFrame = null;
    }
    if (byTop === true) return { top: true, certain: true };
    if (byFrame === false) return { top: false, certain: true };
    if (byTop === false) return { top: false, certain: false }; // 跨域子帧或沙箱失真 → 握手
    return { top: true, certain: false }; // 两路都不可用：先按顶层挂，握手纠正
  })();
  const IS_TOP = FRAME.top;
  /** 能确定自己在最外层：此时任何握手消息都不许再把自己降级 */
  const TOP_CERTAIN = IS_TOP && FRAME.certain;
  /**
   * 要不要挂界面。
   * 只有**确定是子帧**才不挂；证据不足时先挂上，再由握手纠正。
   * 反过来（证据不足就不挂）正是"脚本不运行"的来源：沙箱里两个判据同时
   * 不可用并不罕见，那时宁可多一个按钮，也不能什么都不显示。
   */
  const SHOULD_MOUNT = IS_TOP || !FRAME.certain;

  // 脚本管理器能力探测：Tampermonkey 给的是 GM_* 同步 API，
  // Userscripts 等给的是 GM.* 异步 API，两套都认，缺了就用页面能力兜底
  const GM_API = (() => {
    try {
      return typeof GM !== 'undefined' && GM ? GM : null;
    } catch {
      return null;
    }
  })();
  const GMXHR =
    typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : GM_API && typeof GM_API.xmlHttpRequest === 'function'
        ? GM_API.xmlHttpRequest.bind(GM_API)
        : null;
  const HAS_GM_XHR = !!GMXHR;
  const HAS_GM_STORE = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const HAS_GM_STORE_ASYNC =
    !!GM_API && typeof GM_API.getValue === 'function' && typeof GM_API.setValue === 'function';

  const HOST_ID = 'ts-sniffer-ios-host';
  // 版本号与文件头 @version 保持一致：设置标题、控制台日志、__tsSnifferVersion
  // 都用它。两处必须一起改，否则用户无法分辨自己跑的是不是修复后的构建。
  const VERSION = '1.0.0';

  const MAX_ITEMS = 120;          // 列表最多保留的资源条目
  const MAX_SEGMENTS = 4000;      // 单个分片分组最多记录的 URL 数

  const IS_IOS = (() => {
    try {
      const ua = navigator.userAgent || '';
      if (/iPad|iPhone|iPod/.test(ua)) return true;
      return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    } catch {
      return false;
    }
  })();
  /**
   * iOS 上一律**不读写**站点的 localStorage。
   *
   * 原因：在这里写设置/悬浮球位置，会变成"该网站的网站数据"的一部分；
   * 而 WebKit 在页面经历过下载/分享之后，对这个站点存储区的处理有已知的
   * 翻车模式——下一次加载时第一次访问存储就可能卡死或抛错，页面看起来
   * 就是"脚本没运行"，用户必须去 Safari 设置里"移除网站数据"才能恢复。
   * 清掉的数据正是我们写进去的那几条。
   *
   * 所以 iOS 的持久化全部走脚本管理器的 GM 存储（属于脚本本身，
   * 不属于任何站点，也天然跨站点共享设置）；站点 localStorage 只留给桌面。
   */
  const SITE_STORAGE = !IS_IOS;

  /* 脚本自己发请求用原生 fetch；拿不到就只走 GM 通道 */
  const RAW_FETCH = (() => {
    try {
      return typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
    } catch {
      return null;
    }
  })();

  /* #region CORE */
  /* ------------------------------------------------------------------ *
   * 1. 纯函数核心：解析 / 规划 / 抓取合并
   *    —— 这一整段不依赖 DOM，可以在 Node 里直接跑测试
   * ------------------------------------------------------------------ */

  const PROGRESS_INTERVAL = 220;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function cancelError() {
    const err = new Error('已取消');
    err.canceled = true;
    return err;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function safeUrl(url, base) {
    try {
      return new URL(url, base || undefined);
    } catch {
      return null;
    }
  }

  /* 常见的直链媒体扩展名。顺序有讲究：.ts / .m4s 必须先于通用视频判断 */
  const VIDEO_EXT = /\.(flv|mkv|webm|mov|qt|avi|divx|wmv|asf|mpg|mpeg|mpe|m2v|m2ts|mts|m1v|3gp|3g2|ogv|rmvb|rm|f4v|vob)$/;
  const IMAGE_EXT = /\.(jpe?g|jfif|png|apng|gif|webp|bmp|avif|ico|cur|svg|tiff?|heic|heif)$/;

  /** 依据 URL 路径判断资源类型 */
  function classifyByUrl(url) {
    const u = safeUrl(url);
    if (!u) return null;
    const path = u.pathname.toLowerCase();
    if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'm3u8';
    if (path.endsWith('.ts')) return 'ts';
    if (path.endsWith('.m4s')) return 'm4s';
    if (/\.(mp4|m4v)$/.test(path)) return 'mp4';
    if (path.endsWith('.mpd')) return 'mpd';
    if (/\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav|aiff?|wma|amr|ape|ac3|dts|midi?)$/.test(path)) return 'audio';
    if (IMAGE_EXT.test(path)) return 'image';
    if (VIDEO_EXT.test(path)) return 'video';
    return null;
  }

  /** 依据 Content-Type 判断（应对无扩展名的地址，例如 /img?id=123、/play?vid=9） */
  function classifyByContentType(contentType) {
    if (!contentType) return null;
    const ct = String(contentType).toLowerCase();
    if (ct.includes('mpegurl')) return 'm3u8';
    if (ct.includes('mp2t')) return 'ts';
    if (ct.includes('dash+xml')) return 'mpd';
    if (ct.includes('image/svg')) return 'image';
    if (ct.startsWith('image/')) return 'image';
    if (ct.includes('video/mp4')) return 'mp4';
    if (ct.startsWith('video/')) return 'video';
    if (ct.startsWith('audio/')) return 'audio';
    return null;
  }

  /** 从 URL 里取扩展名（只认 2~5 位字母数字，避免把 ?a=b 当扩展名） */
  function extFromUrl(url) {
    const u = safeUrl(url);
    if (!u) return '';
    const base = u.pathname.split('/').pop();
    const m = /\.([a-z0-9]{2,5})$/i.exec(base || '');
    if (m) return m[1].toLowerCase();
    // 路径里没有扩展名时看 query：腾讯 / 部分 CDN 把真名放在 ?fname=hd.mp4
    for (const key of ['fname', 'filename', 'file', 'name']) {
      const v = u.searchParams.get(key);
      if (!v) continue;
      const qm = /\.([a-z0-9]{2,5})$/i.exec(v);
      if (qm) return qm[1].toLowerCase();
    }
    return '';
  }

  const EXT_BY_TYPE = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/webm': 'webm',
    'video/x-flv': 'flv',
    'video/mp2t': 'ts',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/webm': 'weba',
  };

  const MIME_BY_EXT = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    flv: 'video/x-flv',
    wmv: 'video/x-ms-wmv',
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
    ts: 'video/mp2t',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg; codecs=opus',
    flac: 'audio/flac',
    weba: 'audio/webm',
    aiff: 'audio/aiff',
  };

  function mimeForExt(ext) {
    return MIME_BY_EXT[String(ext || '').toLowerCase()] || 'application/octet-stream';
  }

  function extFromContentType(contentType) {
    if (!contentType) return '';
    const ct = String(contentType).toLowerCase().split(';')[0].trim();
    return EXT_BY_TYPE[ct] || '';
  }

  /** 下载后的真实扩展名：URL 优先，其次 Content-Type，最后按类型兜底 */
  function resolveExt(url, contentType, kind) {
    const fromUrl = extFromUrl(url);
    if (fromUrl) return fromUrl;
    const fromType = extFromContentType(contentType);
    if (fromType) return fromType;
    if (kind === 'image') return 'jpg';
    if (kind === 'audio') return 'm4a';
    return 'mp4';
  }

  /** 解析属性列表，如：BANDWIDTH=1280000,RESOLUTION=1280x720 */
  function parseAttributes(input) {
    const out = {};
    if (!input) return out;
    const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(input)) !== null) {
      let value = m[2];
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      out[m[1].toUpperCase()] = value.trim();
    }
    return out;
  }

  function resolveUrl(uri, baseUrl) {
    const u = safeUrl(uri, baseUrl);
    return u ? u.href : uri;
  }

  function parseByterange(value) {
    if (!value) return null;
    const [len, offset] = String(value).split('@');
    const length = Number(len);
    if (!Number.isFinite(length) || length <= 0) return null;
    const start = Number(offset);
    return { length, offset: Number.isFinite(start) ? start : 0 };
  }

  function variantLabel(v, index) {
    const parts = [];
    if (v.resolution) {
      const h = Number(String(v.resolution).split('x')[1]);
      parts.push(h ? `${h}p` : v.resolution);
    }
    if (v.bandwidth) parts.push(`${(v.bandwidth / 1000).toFixed(0)}kbps`);
    if (!parts.length) parts.push(`轨道 ${index + 1}`);
    return parts.join(' · ');
  }

  /**
   * 解析 m3u8
   * @returns {{type:'master',variants:Array,audioRenditions:Array} |
   *           {type:'media',segments:Array,map:Object|null,isFMP4:boolean,
   *            hasEndList:boolean,totalDuration:number,targetDuration:number}}
   */
  function parseM3U8(text, baseUrl) {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('播放列表内容为空');
    }
    const lines = text
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (!lines[0] || !lines[0].startsWith('#EXTM3U')) {
      throw new Error('不是有效的 m3u8 播放列表');
    }
    if (/#EXT-X-STREAM-INF/.test(text)) return parseMaster(lines, baseUrl);
    return parseMedia(lines, baseUrl);
  }

  function parseMaster(lines, baseUrl) {
    const variants = [];
    const audioRenditions = [];
    let pending = null;

    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        pending = parseAttributes(line.slice(line.indexOf(':') + 1));
      } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
        pending = null; // 仅关键帧轨道，忽略
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
        if (attrs.TYPE === 'AUDIO' && attrs.URI) {
          audioRenditions.push({
            url: resolveUrl(attrs.URI, baseUrl),
            groupId: attrs['GROUP-ID'] || '',
            name: attrs.NAME || 'audio',
            language: attrs.LANGUAGE || '',
            isDefault: attrs.DEFAULT === 'YES',
          });
        }
      } else if (!line.startsWith('#') && pending) {
        variants.push({
          url: resolveUrl(line, baseUrl),
          bandwidth: Number(pending.BANDWIDTH) || 0,
          averageBandwidth: Number(pending['AVERAGE-BANDWIDTH']) || 0,
          resolution: pending.RESOLUTION || '',
          codecs: pending.CODECS || '',
          frameRate: Number(pending['FRAME-RATE']) || 0,
          name: pending.NAME || '',
        });
        pending = null;
      }
    }

    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    variants.forEach((v, i) => {
      v.index = i;
      v.label = variantLabel(v, i);
    });

    return { type: 'master', variants, audioRenditions };
  }

  function parseMedia(lines, baseUrl) {
    const segments = [];
    let key = null;
    let map = null;
    let seq = 0;
    let duration = 0;
    let pendingByterange = null;
    let hasEndList = false;
    let targetDuration = 0;
    let isFMP4 = false;
    let lastUrl = '';

    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        seq = parseInt(line.slice(line.indexOf(':') + 1), 10) || 0;
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = parseFloat(line.slice(line.indexOf(':') + 1)) || 0;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
        const method = (attrs.METHOD || 'NONE').toUpperCase();
        if (method === 'NONE') {
          key = null;
        } else {
          const format = (attrs.KEYFORMAT || 'identity').toLowerCase();
          key = {
            method,
            format,
            uri: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : null,
            iv: attrs.IV || null,
            unsupported: format !== 'identity' || (method !== 'AES-128' && method !== 'NONE'),
          };
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
        if (attrs.URI) {
          map = {
            url: resolveUrl(attrs.URI, baseUrl),
            byterange: parseByterange(attrs.BYTERANGE),
            key,
          };
          isFMP4 = true;
        }
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingByterange = parseByterange(line.slice(line.indexOf(':') + 1));
      } else if (line.startsWith('#EXTINF:')) {
        const raw = line.slice(line.indexOf(':') + 1);
        const value = parseFloat(raw.split(',')[0]);
        duration = Number.isFinite(value) ? value : 0;
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        hasEndList = true;
      } else if (!line.startsWith('#')) {
        const url = resolveUrl(line, baseUrl);
        segments.push({
          url,
          duration,
          seq: seq + segments.length,
          byterange: pendingByterange,
          key,
          map,
        });
        if (/\.(m4s|m4v|m4a|mp4)(\?|#|$)/i.test(url)) isFMP4 = true;
        lastUrl = url;
        pendingByterange = null;
        duration = 0;
      }
    }

    // 无 #EXT-X-MAP 但出现 fMP4 分片时，推断同目录 init.mp4
    if (!map && isFMP4 && lastUrl) {
      map = { url: lastUrl.replace(/[^/]*$/, 'init.mp4'), byterange: null, key: null, guessed: true };
    }

    const totalDuration = segments.reduce((sum, s) => sum + (s.duration || 0), 0);

    return { type: 'media', segments, map, isFMP4, hasEndList, totalDuration, targetDuration };
  }

  /** 媒体播放列表 → 抓取单元清单 */
  function buildUnits(parsed) {
    const units = [];
    if (parsed.map) {
      units.push({
        url: parsed.map.url,
        byterange: parsed.map.byterange,
        key: parsed.map.key,
        seq: 0,
        isInit: true,
      });
    }
    for (const segment of parsed.segments) {
      if (segment.key && segment.key.unsupported) {
        throw new Error(`暂不支持该加密方式（${segment.key.method}），请改用其他工具`);
      }
      units.push({
        url: segment.url,
        byterange: segment.byterange,
        key: segment.key,
        seq: segment.seq,
      });
    }
    return units;
  }

  function pathOf(url) {
    const u = safeUrl(url);
    return u ? u.pathname : String(url || '').split('?')[0];
  }

  /**
   * 分片排序：按 URL 路径里最后一段数字升序。
   * 并发探测时分片到达顺序会轻微错乱，直接按到达顺序合并会花屏。
   * 若无法提取出唯一数字序列，则保留原顺序。
   */
  function orderSegments(urls) {
    const list = Array.isArray(urls) ? urls : [];
    if (list.length < 2) return list.slice();

    const parsed = list.map((url, i) => {
      const m = /(\d+)(?!.*\d)/.exec(pathOf(url));
      return { url, i, n: m ? Number(m[1]) : NaN };
    });
    if (parsed.some((p) => !Number.isFinite(p.n))) return list.slice();

    const sorted = parsed.slice().sort((a, b) => a.n - b.n || a.i - b.i);
    const seen = new Set();
    for (const p of sorted) {
      if (seen.has(p.n)) return list.slice(); // 序号重复，排序不可靠
      seen.add(p.n);
    }
    return sorted.map((p) => p.url);
  }

  /** 已观察到的分片 URL 直接组成下载计划 */
  function planForSegments(urls) {
    const ordered = orderSegments(urls);
    if (!ordered.length) throw new Error('没有可下载的分片');
    const units = ordered.map((url, i) => ({ url, byterange: null, key: null, seq: i }));
    const isFMP4 = /\.(m4s|m4v|m4a)(\?|#|$)/i.test(ordered[0]);
    return { units, isFMP4, quality: '', live: false };
  }

  function hexToBytes(hex) {
    const clean = String(hex).replace(/^0x/i, '');
    const out = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  /** 无 IV 属性时，HLS 规定用媒体序列号推导 128 位 IV */
  function sequenceIv(seq) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, seq >>> 0, false);
    return iv;
  }

  function base64ToBytes(base64) {
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * 粗略判断一段数据是不是网页 / JSON 错误响应。
   * 真正的 TS 分片以 0x47 同步字节开头，fMP4 以 box 长度 + ftyp 开头。
   */
  function looksLikeWebPage(u8) {
    const len = Math.min(u8.byteLength, 512);
    let head = '';
    for (let i = 0; i < len; i++) head += String.fromCharCode(u8[i]);
    const lower = head.toLowerCase();
    if (lower.includes('<!doctype') || lower.includes('<html') || lower.includes('<head')) return true;
    const trimmed = head.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return /"(error|code|message|msg)"\s*:/.test(trimmed);
    }
    return false;
  }

  /* ---- 合并产物体检：TS 包对齐 / fMP4 box 头 ---- */

  const TS_PACKET_SIZE = 188;

  /** 在字节流里找 MPEG-TS 同步起点（连续三个 0x47 对齐），找不到返回 -1 */
  function findTsSync(u8) {
    const len = u8.byteLength;
    if (len < TS_PACKET_SIZE * 3) return -1;
    const limit = Math.min(len - TS_PACKET_SIZE * 2, TS_PACKET_SIZE);
    for (let start = 0; start < limit; start++) {
      if (u8[start] !== 0x47) continue;
      if (u8[start + TS_PACKET_SIZE] !== 0x47) continue;
      if (u8[start + TS_PACKET_SIZE * 2] !== 0x47) continue;
      return start;
    }
    return -1;
  }

  /** 头部若干字节的十六进制，报错时用来判断"这到底是什么东西" */
  function headHex(u8, len = 16) {
    const out = [];
    for (let i = 0; i < Math.min(len, u8.byteLength); i++) {
      out.push(u8[i].toString(16).padStart(2, '0'));
    }
    return out.join(' ');
  }

  /* ---- 容器识别：先判断"这是什么"，再决定怎么修 ---- */

  // TS 不止 188 一种：苹果自己的 HLS 用 188，蓝光/DVB 录制的常见 192（多 4 字节时间戳）
  // 和 208（尾部 20 字节 RS 校验）。只认 188 会把后两种误判成"不是 TS"。
  const TS_LAYOUTS = [
    { packetSize: 188, syncOffset: 0, label: 'MPEG-TS（188 字节包）' },
    { packetSize: 192, syncOffset: 4, label: 'M2TS（192 字节包）' },
    { packetSize: 208, syncOffset: 0, label: 'MPEG-TS（208 字节包）' },
  ];

  /** 连续三个包都能对上同步字节，才算真的 TS 结构 */
  function detectTsLayout(u8) {
    if (!u8 || u8.byteLength < TS_PACKET_SIZE * 3) return null;
    for (const layout of TS_LAYOUTS) {
      const { packetSize, syncOffset } = layout;
      if (u8.byteLength < packetSize * 3) continue;
      const limit = Math.min(u8.byteLength - packetSize * 2, packetSize);
      for (let start = 0; start < limit; start++) {
        const base = start + syncOffset;
        if (u8[base] !== 0x47) continue;
        if (u8[base + packetSize] !== 0x47) continue;
        if (u8[base + packetSize * 2] !== 0x47) continue;
        return { packetSize, syncOffset, offset: start, label: layout.label };
      }
    }
    return null;
  }

  /** 香农熵（bit/byte）：加密数据接近 8，普通视频明显更低 */
  function byteEntropy(u8, limit = 8192) {
    const n = Math.min(u8.byteLength, limit);
    if (!n) return 0;
    const counts = new Uint32Array(256);
    for (let i = 0; i < n; i++) counts[u8[i]] += 1;
    let h = 0;
    for (let i = 0; i < 256; i++) {
      if (!counts[i]) continue;
      const p = counts[i] / n;
      h -= p * Math.log2(p);
    }
    return h;
  }

  const MP4_BOX_TAGS = ['ftyp', 'styp', 'moov', 'moof', 'sidx', 'mdat', 'free', 'emsg'];

  /** 在前若干字节里找 MP4 box 类型（有的封装会在前面多几个字节） */
  function findBoxTag(u8, scan = 64) {
    if (!u8 || u8.byteLength < 8) return null;
    const limit = Math.min(u8.byteLength - 8, scan);
    for (let off = 0; off <= limit; off++) {
      const tag = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
      if (MP4_BOX_TAGS.indexOf(tag) >= 0) return { tag, offset: off };
    }
    return null;
  }

  /** 在前几个分片里找某个 MP4 box（moov 是初始化段的核心） */
  function hasBox(parts, name, maxParts = 3, scan = 65536) {
    const tag = name;
    for (let i = 0; i < Math.min(parts.length, maxParts); i++) {
      const u8 = parts[i];
      if (!u8) continue;
      const limit = Math.min(u8.byteLength - 8, scan);
      for (let off = 0; off <= limit; off++) {
        if (
          u8[off + 4] === tag.charCodeAt(0) &&
          u8[off + 5] === tag.charCodeAt(1) &&
          u8[off + 6] === tag.charCodeAt(2) &&
          u8[off + 7] === tag.charCodeAt(3)
        ) {
          const size = ((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]) >>> 0;
          if (size === 0 || size === 1 || (size >= 8 && off + size <= u8.byteLength)) return true;
        }
      }
    }
    return false;
  }

  const MAGIC_SIGS = [
    { sig: [0x89, 0x50, 0x4e, 0x47], kind: 'image', label: 'PNG 图片' },
    { sig: [0xff, 0xd8, 0xff], kind: 'image', label: 'JPEG 图片' },
    { sig: [0x47, 0x49, 0x46, 0x38], kind: 'image', label: 'GIF 图片' },
    { sig: [0x1f, 0x8b], kind: 'archive', label: 'gzip 压缩数据' },
    { sig: [0x50, 0x4b, 0x03, 0x04], kind: 'archive', label: 'zip 压缩包' },
    { sig: [0x49, 0x44, 0x33], kind: 'audio', label: 'ID3 音频' },
  ];

  /**
   * 判断合并后的字节到底是什么。
   * 这一步是"播放器认不认"的第一道判据，比盲猜有用得多：
   * 密文和"私有封装"在字节层面长得完全不一样，处理方式也不同。
   */
  function detectContainer(parts) {
    const first = parts && parts[0];
    if (!first || !first.byteLength) return { kind: 'empty', label: '空内容', head: '' };

    const head = headHex(first);
    const entropy = byteEntropy(first);

    const ts = detectTsLayout(first);
    if (ts) {
      return {
        kind: ts.packetSize === 188 ? 'ts' : 'm2ts',
        label: ts.label,
        packetSize: ts.packetSize,
        syncOffset: ts.syncOffset,
        offset: ts.offset,
        entropy,
        head,
      };
    }

    if (looksLikeWebPage(first)) return { kind: 'web', label: '网页 / 错误页', entropy, head };

    const box = findBoxTag(first);
    if (box) return { kind: 'mp4', label: `MP4 分片（${box.tag}）`, box: box.tag, entropy, head };

    for (const m of MAGIC_SIGS) {
      if (m.sig.every((b, i) => first[i] === b)) return { kind: m.kind, label: m.label, entropy, head };
    }

    // 加密数据的特征：熵接近 8（每字节都接近均匀随机），且整段找不到任何同步结构
    if (entropy >= 7.2) return { kind: 'encrypted', label: 'AES 加密后的密文', entropy, head };
    return { kind: 'unknown', label: '无法识别的数据', entropy, head };
  }

  /** M2TS / 208 字节包先转回 188，后续合并逻辑才能统一处理 */
  function toTs188(parts, packetSize) {
    if (packetSize === TS_PACKET_SIZE) return parts;
    const out = [];
    for (const part of parts) {
      const packets = Math.floor(part.byteLength / packetSize);
      if (!packets) continue;
      const buf = new Uint8Array(packets * TS_PACKET_SIZE);
      const skip = packetSize === 192 ? 4 : 0; // 192 包前面 4 字节是时间戳
      for (let i = 0; i < packets; i++) {
        const from = i * packetSize + skip;
        buf.set(part.subarray(from, from + TS_PACKET_SIZE), i * TS_PACKET_SIZE);
      }
      out.push(buf);
    }
    return out;
  }

  /**
   * MPEG-TS 是 188 字节定长包。只要有一段长度不是 188 的整数倍，后面的包就全部错位，
   * 播放器会直接报"无法解析影音播放信息"。这里做三件事：
   *   1. 跳过首个分片前面的垃圾字节，让 0x47 对齐
   *   2. 把长度不对齐的分片裁到整包边界
   *   3. 总长再裁一次，末尾不留半个包
   * 修复是"丢极少字节换整条流可解析"，比直接产出坏文件强。
   */
  function normalizeTs(parts) {
    const notes = [];
    if (!parts.length) return { ok: false, reason: '没有分片' };

    let skipped = 0;
    let trimmed = 0;
    let dropped = 0;

    // 逐段对齐：TS 的每一段都必须从 0x47 包边界开始，
    // 否则从这一段起后面的所有包都会错位，播放器直接罢工。
    for (let i = 0; i < parts.length; i++) {
      let part = parts[i];
      if (part.byteLength && part[0] !== 0x47) {
        const off = findTsSync(part.subarray(0, Math.min(part.byteLength, TS_PACKET_SIZE * 4)));
        if (off > 0) {
          part = part.subarray(off);
          skipped += off;
        } else if (i === 0) {
          return { ok: false, reason: '内容不是 MPEG-TS 流', head: headHex(parts[0]) };
        } else {
          // 中间段连同步点都找不到，留着会把后面全带歪，只能丢掉
          skipped += part.byteLength;
          dropped += 1;
          part = part.subarray(0, 0);
        }
      }
      const rem = part.byteLength % TS_PACKET_SIZE;
      if (rem) {
        part = part.subarray(0, part.byteLength - rem);
        trimmed += 1;
      }
      parts[i] = part;
    }

    if (skipped) notes.push(`跳过 ${skipped} 字节前置杂质`);
    if (dropped) notes.push(`丢弃 ${dropped} 个无法对齐的分片`);
    if (trimmed) notes.push(`${trimmed} 个分片裁到整包边界`);

    let total = 0;
    for (const part of parts) total += part.byteLength;
    const tail = total % TS_PACKET_SIZE;
    if (tail) {
      let need = tail;
      for (let i = parts.length - 1; i >= 0 && need > 0; i--) {
        const cut = Math.min(need, parts[i].byteLength);
        parts[i] = parts[i].subarray(0, parts[i].byteLength - cut);
        need -= cut;
      }
      notes.push('裁掉末尾残包');
    }

    for (let i = parts.length - 1; i >= 0; i--) {
      if (!parts[i].byteLength) parts.splice(i, 1);
    }
    if (!parts.length) return { ok: false, reason: '修复后没有剩余数据' };

    // 抽检：确认修复后首段确实从包边界开始
    if (parts[0][0] !== 0x47) {
      return { ok: false, reason: '对齐修复失败', head: headHex(parts[0]) };
    }
    return { ok: true, notes };
  }

  /* ---- MPEG-TS 结构分析：直接回答"这个文件能不能播" ---- */

  const TS_STREAM_TYPES = {
    0x01: 'MPEG-1 Video',
    0x02: 'MPEG-2 Video',
    0x03: 'MPEG-1 Audio',
    0x04: 'MPEG-2 Audio',
    0x0f: 'AAC',
    0x11: 'AAC',
    0x15: 'ID3',
    0x1b: 'H.264',
    0x24: 'HEVC',
    0x27: 'AV1',
    0x81: 'AC-3',
    0x87: 'E-AC-3',
  };

  /** MPEG-2 CRC32（节目表末尾 4 字节）。CRC 不对的表，播放器会直接丢掉 */
  function crc32Mpeg(u8, start, end) {
    let crc = 0xffffffff;
    for (let i = start; i < end; i++) {
      crc = (crc ^ (u8[i] << 24)) >>> 0;
      for (let b = 0; b < 8; b++) {
        crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
      }
    }
    return crc >>> 0;
  }

  /**
   * 扫前若干个包，把 PAT / PMT 解出来，并做三件和播放器一致的检查：
   *   1. 节目表 CRC —— CRC 不对等于没有节目表
   *   2. 加扰标志 —— 置位就说明这条流是加扰的，任何播放器都解不了
   *   3. 声明的 ES 流到底有没有数据 —— 只有声明没有数据，播放器会说"无法解析"
   */
  function analyzeTs(parts, limitPackets = 6000) {
    const pids = new Set();
    const streams = [];
    const payloadCount = new Map();
    const pesCount = new Map();
    const lastCc = new Map();

    let packets = 0;
    let hasPat = false;
    let hasPmt = false;
    let patCrcOk = null;
    let pmtCrcOk = null;
    let pmtPid = -1;
    let scrambled = false;
    let ccErrors = 0;
    let ccChecked = 0;

    outer: for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      // 分片之间连续计数器本来就会重置，跨片比较没有意义，逐片清零
      lastCc.clear();
      for (let off = 0; off + TS_PACKET_SIZE <= p.byteLength; off += TS_PACKET_SIZE) {
        if (p[off] !== 0x47) continue;
        packets += 1;
        if (packets > limitPackets) break outer;

        const b1 = p[off + 1];
        const b3 = p[off + 3];
        const pusi = (b1 & 0x40) !== 0;
        const pid = ((b1 & 0x1f) << 8) | p[off + 2];
        pids.add(pid);
        if ((b3 & 0xc0) !== 0) scrambled = true;

        const afc = (b3 >> 4) & 0x03;
        const hasPayload = afc === 1 || afc === 3;

        if (hasPayload) {
          // 连续计数器只在有负载的包里递增，断了就说明丢包或被重排
          const cc = b3 & 0x0f;
          if (lastCc.has(pid)) {
            ccChecked += 1;
            if (((lastCc.get(pid) + 1) & 0x0f) !== cc) ccErrors += 1;
          }
          lastCc.set(pid, cc);
          payloadCount.set(pid, (payloadCount.get(pid) || 0) + 1);
        }

        if (afc === 0 || afc === 2) continue;
        let cursor = off + 4;
        if (afc === 3) cursor = off + 5 + p[off + 4];
        if (cursor >= off + TS_PACKET_SIZE) continue;

        if (pusi) {
          // PES 起始码 00 00 01：说明这条 ES 真的在送数据
          if (p[cursor] === 0x00 && p[cursor + 1] === 0x00 && p[cursor + 2] === 0x01) {
            pesCount.set(pid, (pesCount.get(pid) || 0) + 1);
          }
        }
        if (!pusi) continue;

        // PSI 段前面还有一个 pointer_field
        const sec = cursor + 1 + p[cursor];
        if (sec + 3 > off + TS_PACKET_SIZE) continue;
        const tableId = p[sec];
        const secLen = ((p[sec + 1] & 0x0f) << 8) | p[sec + 2];
        const end = Math.min(sec + 3 + secLen, off + TS_PACKET_SIZE);
        if (end <= sec + 8) continue;
        const fullSection = sec + 3 + secLen <= off + TS_PACKET_SIZE;

        if (pid === 0 && tableId === 0x00) {
          hasPat = true;
          if (fullSection && secLen >= 9) patCrcOk = crc32Mpeg(p, sec, sec + 3 + secLen) === 0;
          for (let s = sec + 8; s + 4 <= end - 4; s += 4) {
            const program = (p[s] << 8) | p[s + 1];
            const candidate = ((p[s + 2] & 0x1f) << 8) | p[s + 3];
            if (program !== 0 && candidate) {
              pmtPid = candidate;
              break;
            }
          }
        } else if (tableId === 0x02 && (pmtPid === -1 || pid === pmtPid)) {
          hasPmt = true;
          if (fullSection && secLen >= 13) pmtCrcOk = crc32Mpeg(p, sec, sec + 3 + secLen) === 0;
          const infoLen = ((p[sec + 10] & 0x0f) << 8) | p[sec + 11];
          let s = sec + 12 + infoLen;
          while (s + 5 <= end - 4) {
            const type = p[s];
            const ePid = ((p[s + 1] & 0x1f) << 8) | p[s + 2];
            const esLen = ((p[s + 3] & 0x0f) << 8) | p[s + 4];
            if (!streams.some((x) => x.pid === ePid)) {
              streams.push({ pid: ePid, type, name: TS_STREAM_TYPES[type] || `0x${type.toString(16)}` });
            }
            s += 5 + esLen;
          }
        }
      }
    }

    const codecs = [...new Set(streams.map((x) => x.name))];
    const silent = streams.filter((x) => !payloadCount.get(x.pid));
    return {
      packets,
      pids: [...pids],
      hasPat,
      hasPmt,
      patCrcOk,
      pmtCrcOk,
      pmtPid,
      streams,
      codecs,
      scrambled,
      ccErrors,
      ccChecked,
      payloadCount,
      pesCount,
      silentPids: silent.map((x) => x.pid),
    };
  }

  /** 把体检结果压成一行给人看的说明 */
  function tsSummary(info) {
    if (!info) return '';
    const bits = [`${info.packets} 包`];
    if (info.ccChecked > 20) {
      const good = 1 - info.ccErrors / info.ccChecked;
      bits.push(`连续性 ${(good * 100).toFixed(good > 0.999 ? 0 : 1)}%`);
    }
    return bits.join(' · ');
  }

  /** 取 URL 所在目录（含结尾斜杠） */
  function dirUrlOf(url) {
    const u = safeUrl(url);
    if (!u) return '';
    const idx = u.pathname.lastIndexOf('/');
    if (idx < 0) return '';
    return u.origin + u.pathname.slice(0, idx + 1);
  }

  /**
   * 合并结果体检：返回 { ok, notes, reason, head, container, isFMP4 }
   *
   * 顺序很重要：先认容器，再决定要不要修。只按 isFMP4 标记走，
   * 会把"其实是 fMP4 但 URL 写 .ts"的站点直接判死。
   */
  function finalizeOutput(parts, isFMP4) {
    if (!parts || !parts.length) return { ok: false, reason: '合并结果为空', container: 'empty' };
    const info = detectContainer(parts);

    if (info.kind === 'mp4') {
      // 媒体分片（styp/moof）本身没有 moov，必须补上初始化段才能播；
      // 少了它，播放器打开就是"无法解析影音播放信息"
      if (!hasBox(parts, 'moov')) {
        return {
          ok: false,
          needInit: true,
          container: 'mp4',
          reason: '缺少 fMP4 初始化段（moov）',
          head: info.head,
        };
      }
      return { ok: true, notes: [], container: 'mp4', isFMP4: true };
    }

    if (info.kind === 'm2ts') {
      const converted = toTs188(parts, info.packetSize);
      parts.splice(0, parts.length, ...converted);
      const fixed = normalizeTs(parts);
      if (fixed.ok) {
        fixed.notes = fixed.notes || [];
        fixed.notes.push(`${info.label} 已转为 188 字节包`);
        fixed.container = 'ts';
      }
      return fixed;
    }

    if (info.kind === 'ts') {
      const fixed = normalizeTs(parts);
      if (fixed.ok) fixed.container = 'ts';
      return fixed;
    }

    if (isFMP4 && info.kind !== 'encrypted') {
      // 标了 fMP4 但认不出 box 头，也认不出别的东西 → 按 fMP4 失败处理
      return { ok: false, reason: '开头不是 MP4 的 box 头', head: info.head, container: info.kind, entropy: info.entropy };
    }

    return {
      ok: false,
      reason: info.kind === 'encrypted' ? '内容不是 MPEG-TS 流' : `${info.label}，不是视频分片`,
      detail: info.label,
      head: info.head,
      container: info.kind,
      entropy: info.entropy,
    };
  }

  function sanitize(input, fallback = 'video') {
    const cleaned = String(input || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.slice(0, 80) || fallback;
  }

  /** 下载时间戳：年月日时分秒，例 20261114104410 */
  function timeStamp(date) {
    const d = date instanceof Date ? date : new Date();
    const pad = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(
      d.getMinutes()
    )}${pad(d.getSeconds())}`;
  }

  /**
   * 文件名 = 下载时间（年月日时分秒）+ 扩展名，例如 20261114104410.ts
   *
   * 同一页面反复下载时，用页面标题命名会得到完全相同的文件名，
   * 浏览器会自动加 (1)(2) 或直接覆盖。用下载时间戳命名可以从根上避免。
   */
  function buildFilename(ctx) {
    const ext = ctx.ext || (ctx.isFMP4 ? 'mp4' : 'ts');
    return `${timeStamp(ctx.at)}.${ext}`;
  }

  /**
   * 单分片抓取：Range → 解密 → 返回明文
   * @param io {{bytes: (url, headers, isCancelled) => Promise<{bytes:Uint8Array,partial:boolean}>}}
   */
  async function fetchUnit(unit, io, keyCache, isCancelled) {
    if (unit.key && unit.key.unsupported) {
      throw new Error(`暂不支持该加密方式（${unit.key.method}）`);
    }
    const headers = {};
    if (unit.byterange) {
      const { offset, length } = unit.byterange;
      headers.Range = `bytes=${offset}-${offset + length - 1}`;
    }

    const res = await io.bytes(unit.url, headers, isCancelled);
    let view = res.bytes;

    // 服务器忽略 Range 时自行截取
    if (unit.byterange && !res.partial) {
      view = view.subarray(unit.byterange.offset, unit.byterange.offset + unit.byterange.length);
    }

    if (unit.key && unit.key.method === 'AES-128') {
      view = await decryptBytes(view, unit.key, unit.seq, keyCache, io, isCancelled);
    }
    return view;
  }

  function importAesKey(raw) {
    if (!raw || !raw.byteLength) {
      throw new Error(
        '密钥返回为空。常见原因：需要登录、触发了防盗链，或被 IDM/迅雷一类的下载器接管了请求（可把站点加入其排除列表）'
      );
    }
    if (raw.byteLength !== 16 && raw.byteLength !== 32) {
      throw new Error(`密钥长度异常（${raw.byteLength} 字节，应为 16 或 32），可能拿到的是错误页`);
    }
    return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
  }

  async function decryptBytes(u8, key, seq, keyCache, io, isCancelled) {
    if (!key.uri) throw new Error('播放列表缺少密钥地址');
    if (!(typeof crypto !== 'undefined' && crypto.subtle)) {
      throw new Error('当前环境不支持 WebCrypto 解密（页面需为 HTTPS）');
    }

    let cryptoKey = keyCache.get(key.uri);
    if (!cryptoKey) {
      let raw;
      if (key.uri.startsWith('data:')) {
        raw = base64ToBytes(key.uri.slice(key.uri.indexOf(',') + 1));
      } else {
        raw = (await io.bytes(key.uri, {}, isCancelled, { noStore: true })).bytes;
      }

      try {
        cryptoKey = await importAesKey(raw);
      } catch (err) {
        if (key.uri.startsWith('data:')) throw err;
        // 浏览器可能缓存过一条坏响应（空 body / 登录页），绕开缓存再取一次
        const bust = key.uri + (key.uri.includes('?') ? '&' : '?') + '_tsk=' + Date.now();
        raw = (await io.bytes(bust, {}, isCancelled, { noStore: true })).bytes;
        cryptoKey = await importAesKey(raw);
      }
      keyCache.set(key.uri, cryptoKey);
    }

    const iv = key.iv ? hexToBytes(key.iv) : sequenceIv(seq);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, u8);
    return new Uint8Array(plain);
  }

  /**
   * 并发抓取 + 按序拼装。
   * 返回 parts（有序的 Uint8Array 数组），由调用方拼成 Blob。
   */
  async function runPlan(plan, io, opts = {}) {
    const units = (plan && plan.units) || [];
    const total = units.length;
    if (!total) throw new Error('没有可下载的分片');

    // 夹持范围必须与设置里的档位一致，否则界面给了 12/16 却被默默压回 8
    const concurrency = clamp(Number(opts.concurrency) || 4, 1, 16);
    const isCancelled = opts.isCancelled || (() => false);
    const onProgress = opts.onProgress || (() => {});

    const parts = new Array(total);
    // 密钥缓存可由调用方传入：同一次任务里先下密文再回头重下时不必再取一遍 key
    const keyCache = opts.keyCache instanceof Map ? opts.keyCache : new Map();
    const startedAt = Date.now();

    let cursor = 0;
    let done = 0;
    let bytes = 0;
    let lastEmit = 0;

    const emit = (force) => {
      const now = Date.now();
      if (!force && now - lastEmit < PROGRESS_INTERVAL) return;
      lastEmit = now;
      const elapsed = Math.max(0.2, (now - startedAt) / 1000);
      onProgress({
        done,
        total,
        bytes,
        speed: bytes / elapsed,
        elapsed: now - startedAt,
        percent: total ? done / total : 0,
      });
    };

    async function worker() {
      for (;;) {
        if (isCancelled()) throw cancelError();
        const index = cursor++;
        if (index >= total) return;

        const buf = await fetchUnit(units[index], io, keyCache, isCancelled);
        if (isCancelled()) throw cancelError();
        // 首个分片做内容体检，避免把登录页/错误页当视频合并
        if (done === 0 && looksLikeWebPage(buf)) {
          throw new Error('服务器返回的是网页而不是视频分片（可能需登录、链接已过期或触发了防盗链）');
        }
        parts[index] = buf;
        done += 1;
        bytes += buf.byteLength;
        emit(false);
      }
    }

    emit(true);
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    emit(true);

    const kept = parts.filter(Boolean);
    if (!kept.length) throw new Error('合并结果为空，可能所有分片都下载失败');
    return { parts: kept, bytes, total };
  }

  /** 播放列表预解析：给「选择清晰度」用 */
  async function inspectPlaylist(url, io) {
    const text = await io.text(url);
    const parsed = parseM3U8(text, url);
    if (parsed.type === 'master') {
      if (!parsed.variants.length) throw new Error('主播放列表中没有可用码率');
      return {
        type: 'master',
        variants: parsed.variants.map((v) => ({
          index: v.index,
          label: v.label,
          resolution: v.resolution,
          bandwidth: v.bandwidth,
        })),
      };
    }
    return {
      type: 'media',
      segments: parsed.segments.length,
      duration: Math.round(parsed.totalDuration),
      isFMP4: parsed.isFMP4,
      encrypted: parsed.segments.some((s) => s.key && s.key.method === 'AES-128'),
      live: !parsed.hasEndList,
    };
  }

  /** 播放列表 → 下载计划（主列表会自动降级到选中码率） */
  async function planFromPlaylist(url, variantIndex, io) {
    let playlistUrl = url;
    let text = await io.text(playlistUrl);
    let parsed = parseM3U8(text, playlistUrl);
    let quality = '';

    if (parsed.type === 'master') {
      let index = Number(variantIndex);
      if (!Number.isFinite(index) || index < 0 || index >= parsed.variants.length) index = 0;
      const variant = parsed.variants[index];
      quality = variant.label;
      playlistUrl = variant.url;
      text = await io.text(playlistUrl);
      parsed = parseM3U8(text, playlistUrl);
    }

    if (parsed.type !== 'media') throw new Error('该播放列表不含分片');
    if (!parsed.segments.length) throw new Error('播放列表里没有可用分片');

    return {
      units: buildUnits(parsed),
      isFMP4: parsed.isFMP4,
      quality,
      live: !parsed.hasEndList,
      playlistUrl,
    };
  }

  /* #endregion CORE */

  /* ================================================================== *
   * 2. 网络层：fetch 优先，GM_xmlhttpRequest 兜底
   * ------------------------------------------------------------------
   * fetch 的优势是自动带上页面 Referer 与 Cookie —— 分片服务器查防盗链时
   * 认的就是这个。但跨域分片会被 CORS 拦下，此时退到 GM_xmlhttpRequest
   * （走脚本管理器的后台，不受页面 CORS 限制，代价是没有 Referer）。
   * ================================================================== */

  const selfUrls = new Set();

  /** 把浏览器的网络错误翻成人话，别让用户只看到 "Load failed" */
  function friendlyError(err) {
    if (!err) return '请求失败';
    const raw = String(err.message || err);
    if (/failed to fetch|load failed|networkerror|network request failed|网络请求失败|请求超时/i.test(raw)) {
      if (HAS_GM_XHR) {
        return '分片请求失败：页面 side 被跨域拦截，GM 通道也没拿到数据（可能是防盗链或需要登录）';
      }
      return (
        '资源请求被跨域（CORS）拦截：这个站不允许网页直接读取文件内容。' +
        '脚本已声明特权通道但当前环境没有提供 GM_xmlhttpRequest（部分 iOS 版本如此）——' +
        '可复制直链交给 VLC / ffmpeg，或换用支持特权请求的脚本管理器'
      );
    }
    return raw;
  }

  function httpError(status, url) {
    const err = new Error(
      `HTTP ${status}${status === 403 ? ' 请「复制直链」后自行下载' : ''}`
    );
    err.httpStatus = status;
    err.url = url;
    return err;
  }

  /** 204 / 零字节响应：多半是被下载器接管、被拦截，或碰到了登录页 */
  function emptyError(url, status) {
    const err = new Error(`服务器返回了空内容（HTTP ${status || 0}）`);
    err.emptyBody = true;
    err.url = url;
    return err;
  }

  function isArrayBufferLike(v) {
    return Object.prototype.toString.call(v) === '[object ArrayBuffer]';
  }

  async function fetchRaw(url, headers, isCancelled, opts) {
    if (!RAW_FETCH) throw new Error('当前环境没有 fetch');
    const parsed = safeUrl(url);
    const sameOrigin = !!parsed && parsed.origin === location.origin;
    const init = {
      // 跨域带 cookie 会和 Access-Control-Allow-Origin: * 冲突，默认不带；
      // 遇到防盗链再按 opts.cookies 重试一次
      credentials: opts && opts.cookies ? 'include' : sameOrigin ? 'include' : 'omit',
      cache: opts && opts.noStore ? 'no-store' : 'default',
      headers: { ...(headers || {}) },
    };
    if (opts && opts.range) init.headers.Range = 'bytes=0-';
    if (opts && opts.clean) {
      init.headers = { ...(headers || {}) };
      delete init.referrer;
      delete init.referrerPolicy;
    }
    // 防盗链常拿 Referer 做判断：默认只发 Origin，这里显式补上整页地址
    if (!opts || opts.referer !== false) {
      try {
        init.referrer = location.href;
        init.referrerPolicy = 'unsafe-url';
      } catch {
        /* 老浏览器忽略 */
      }
    }
    // 单个请求内部不轮询取消，靠调用方的分批检查；这里只加长超时保护
    try {
      if (isCancelled && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        init.signal = AbortSignal.timeout(90000);
      }
    } catch {
      /* 老版本 Safari 没有 AbortSignal.timeout */
    }
    const res = await RAW_FETCH(url, init);
    if (res.status === 204) throw emptyError(url, res.status);
    if (!res.ok) throw httpError(res.status, url);
    const buf = await res.arrayBuffer();
    if (!buf || !buf.byteLength) throw emptyError(url, res.status);
    return { bytes: new Uint8Array(buf), status: res.status, partial: res.status === 206 };
  }

  function gmRaw(url, headers, opts) {
    return new Promise((resolve, reject) => {
      if (!GMXHR) {
        reject(new Error('网络请求失败'));
        return;
      }
      const sendHeaders = { ...(headers || {}) };
      if (opts && opts.navigate) {
        // 完全伪装成"地址栏打开"：这类 CDN 只认浏览器导航那一套头。
        // 也只有特权通道能设这些（fetch 里它们是 forbidden header）
        sendHeaders.Accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
        sendHeaders['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
        sendHeaders['Upgrade-Insecure-Requests'] = '1';
        sendHeaders['Sec-Fetch-Dest'] = 'document';
        sendHeaders['Sec-Fetch-Mode'] = 'navigate';
        sendHeaders['Sec-Fetch-Site'] = 'none';
      } else if (opts && opts.clean) {
        /* clean：一个自定义头都不加，交给管理器用自己的默认行为 */
      } else {
        sendHeaders.Accept = sendHeaders.Accept || '*/*';
        // 默认不带来源（更像直接打开）；需要 Referer 的那一档由重试阶梯补
        if (opts && opts.referer !== false && opts.referer) sendHeaders.Referer = location.href;
        if (opts && opts.range) sendHeaders.Range = 'bytes=0-';
      }
      let req;
      try {
        req = GMXHR({
          method: 'GET',
          url,
          headers: sendHeaders,
          responseType: 'arraybuffer',
          timeout: 90000,
          onload: (res) => {
          if (res.status === 204) {
            reject(emptyError(url, 204));
            return;
          }
          if (res.status < 200 || res.status >= 300) {
            reject(httpError(res.status || 0, url));
            return;
          }
          // 不同脚本管理器给的 response 类型不一致，逐个认
          const raw = res.response;
          let bytes = null;
          if (isArrayBufferLike(raw)) bytes = new Uint8Array(raw);
          else if (raw && ArrayBuffer.isView(raw)) {
            bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
          } else if (typeof raw === 'string') {
            bytes = new TextEncoder().encode(raw);
          }
          if (!bytes || !bytes.byteLength) {
            reject(emptyError(url, res.status));
            return;
          }
          resolve({ bytes, status: res.status, partial: res.status === 206 });
        },
        onerror: () => reject(new Error('网络请求失败')),
        ontimeout: () => reject(new Error('请求超时')),
        onabort: () => reject(cancelError()),
        });
      } catch (err) {
        // 个别管理器禁止改 Referer，退回不带的版本再试
        try {
          req = GMXHR({
            method: 'GET',
            url,
            headers: headers || {},
            responseType: 'arraybuffer',
            timeout: 90000,
            onload: (res) => {
              if (res.status === 204) return reject(emptyError(url, 204));
              if (res.status < 200 || res.status >= 300) return reject(httpError(res.status || 0, url));
              const raw = res.response;
              let bytes = null;
              if (isArrayBufferLike(raw)) bytes = new Uint8Array(raw);
              else if (raw && ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
              else if (typeof raw === 'string') bytes = new TextEncoder().encode(raw);
              if (!bytes || !bytes.byteLength) return reject(emptyError(url, res.status));
              resolve({ bytes, status: res.status, partial: res.status === 206 });
            },
            onerror: () => reject(new Error('网络请求失败')),
            ontimeout: () => reject(new Error('请求超时')),
            onabort: () => reject(cancelError()),
          });
        } catch (err2) {
          reject(err2);
        }
        return;
      }
      // GM.* 异步 API 可能以 Promise 形式返回同样的结果，两条路都收
      try {
        if (req && typeof req.then === 'function') {
          req.then(
            (res) => {
              if (!res) return;
              const raw = res.response;
              let bytes = null;
              if (isArrayBufferLike(raw)) bytes = new Uint8Array(raw);
              else if (raw && ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
              if (bytes && bytes.byteLength) resolve({ bytes, status: res.status || 200, partial: false });
            },
            () => {}
          );
        }
      } catch {
        /* 忽略 */
      }
    });
  }

  /**
   * 两条通道，按同源/跨域决定先后：
   *
   *   同源  → fetch 优先：自带 Cookie 和 Referer，最贴近播放器本身的请求
   *   跨域  → GM 优先：iOS 原生 HLS 的分片绝大多数不带 CORS 头，页面里的 fetch
   *           必定 "Load failed"；先试 fetch 只是白多一轮失败请求
   *
   * 任一条失败都会换另一条再试，最后把更有信息量的错误抛出去。
   */
  async function requestBuffer(url, headers, isCancelled, opts) {
    // 自己发出的请求不进探测列表，否则下载时会把自己抓的分片重复记一遍
    if (selfUrls.size > 6000) selfUrls.clear();
    selfUrls.add(url);

    const parsed = safeUrl(url);
    const sameOrigin = !!parsed && parsed.origin === location.origin;
    const order = sameOrigin ? ['fetch', 'gm'] : ['gm', 'fetch'];

    let firstError = null;
    for (const channel of order) {
      if (channel === 'fetch' && !RAW_FETCH) continue;
      if (channel === 'gm' && !HAS_GM_XHR) continue;
      try {
        return channel === 'fetch'
          ? await fetchRaw(url, headers, isCancelled, opts)
          : await gmRaw(url, headers, opts);
      } catch (err) {
        if (err && err.canceled) throw err;
        if (!firstError) firstError = err;

        // 401/403 多半是防盗链：按三种"更像播放器"的姿势依次重试
        if (err && (err.httpStatus === 403 || err.httpStatus === 401)) {
          const retries = [{ cookies: true, referer: true }];
          // 跨域带 Range 会触发预检，很多站点的 OPTIONS 直接 403，所以只对同源用
          if (sameOrigin) retries.push({ cookies: true, referer: true, range: true });
          // 有的 WAF 反而讨厌多余的头：一个自定义头都不加
          retries.push({ cookies: false, referer: false, clean: true });
          // 最后：装成地址栏导航。腾讯系 ftn_handler 这类 CDN 只放行导航形态
          if (channel === 'gm') retries.push({ navigate: true });
          for (const extra of retries) {
            try {
              const merged = { ...(opts || {}), ...extra };
              const res =
                channel === 'fetch'
                  ? await fetchRaw(url, headers, isCancelled, merged)
                  : await gmRaw(url, headers, merged);
              return res;
            } catch (retryErr) {
              if (retryErr && retryErr.canceled) throw retryErr;
              firstError = retryErr;
            }
          }
        }
        // 继续换通道
      }
    }

    throw firstError || new Error('请求失败（fetch 与 GM 通道都不可用）');
  }

  const io = {
    async bytes(url, headers, isCancelled, opts) {
      let lastError = null;
      for (let attempt = 0; attempt <= 2; attempt++) {
        if (isCancelled && isCancelled()) throw cancelError();
        try {
          return await requestBuffer(url, headers, isCancelled, opts);
        } catch (err) {
          if (err && err.canceled) throw err;
          lastError = err;
          // 空响应已经换过通道了，再重试也是白搭
          if (err && err.emptyBody) throw err;
          // 4xx 是确定性失败，重试没有意义
          if (err && err.httpStatus && err.httpStatus < 500) throw err;
          if (attempt < 2) await sleep(250 * (attempt + 1));
        }
      }
      throw lastError || new Error('请求失败');
    },

    async text(url, isCancelled) {
      const res = await this.bytes(url, {}, isCancelled, { noStore: true });
      return new TextDecoder('utf-8').decode(res.bytes);
    },
  };

  /* ================================================================== *
   * 3. 探测层
   * ================================================================== */

  /** 运行统计：用来回答"脚本到底看到东西没有" */
  const stats = { seen: 0, perfSeen: 0, fetchHooked: false, xhrHooked: false, mediaWatched: false, domScanned: 0 };

  // 资源计时的读取水位。换页时把它推到末尾，避免把上一页的条目又捞回来
  let perfWatermark = 0;
  let perfRef = null;

  const store = new Map(); // id -> item

  /* --------------------- 内嵌页（iframe）合并 ---------------------
   * 内嵌页里的实例不挂界面，只负责探测，把条目快照上报给顶层；
   * 顶层把本地条目与各内嵌页条目合并成一张列表，下载再派回对应内嵌页执行
   * （下载必须在内嵌页自己的上下文里做，才能带上它的 Cookie / Referer）。
   */
  const remoteItems = new Map(); // 伪条目 id -> item（带 remote/frameId/remoteId）
  const remoteFrames = new Map(); // frameId -> WindowProxy
  const remoteJobs = new Map(); // `${frameId}:${itemId}` -> 顶层 job id
  let framePost = null; // 内嵌页里的上报函数
  let frameBridgeReady = false;
  // 本实例注册过的 window message 监听与定时器：拆实例时一并清掉
  // 本实例的随机标识：握手的 ack 会带上它，自己回的 ack 因此能被识别并丢弃
  const TAB_ID = Math.random().toString(36).slice(2, 10);
  // 每次 hello 带一个随机数：只有真正收到这条 hello 的一方才能原样回传。
  // 旧版本实例的 ack 不带这个字段，会被直接忽略——它们再也不能把新实例降级。
  const HS_NONCE = Math.random().toString(36).slice(2, 10);
  const frameCleanup = [];
  function onWindowMessage(fn) {
    try {
      window.addEventListener('message', fn);
      frameCleanup.push(() => window.removeEventListener('message', fn));
    } catch {
      /* 忽略 */
    }
  }
  let forceChild = false; // 握手确认有父帧：即便 IS_TOP 误判也不许挂界面
  /**
   * 证据不足时的挂载冷静期。
   * 角色判据失真的帧（跨域内嵌页、或证据不足的顶层）先等握手 2.6 秒：
   * 真内嵌页在这期间会收到父帧的 ack，从此不再挂界面——页面上就只有一个悬浮球；
   * 真顶层等不到 ack（hello 发给自己会被丢弃），冷静期一过照常挂出。
   */
  let mountHoldUntil = 0;
  let frameHostReady = false; // 顶层消息处理只装一次

  function allItems() {
    return [...store.values(), ...remoteItems.values()];
  }

  function installFrameBridge(force) {
    if (IS_TOP && !force) return;
    if (frameBridgeReady) return;
    frameBridgeReady = true;
    let frameId = '';
    try {
      frameId = Math.random().toString(36).slice(2, 9);
    } catch {
      frameId = 'f';
    }
    framePost = (msg) => {
      try {
        window.parent.postMessage({ ...msg, frameId }, '*');
      } catch {
        /* 忽略 */
      }
    };
    const snapshot = () => {
      try {
        if (!window.parent || window.parent === window) return;
        const list = [...store.values()].slice(0, 80).map((it) => ({
          id: it.id,
          kind: it.kind,
          url: it.url,
          urls: it.urls ? it.urls.slice(0, 400) : null,
          count: it.count,
          size: it.size,
          host: it.host,
          name: it.name,
          contentType: it.contentType,
          firstSeen: it.firstSeen,
          active: it.id === activeMediaId,
        }));
        framePost({ tss: 'sniff:items', items: list });
      } catch {
        /* 忽略 */
      }
    };
    snapshot();
    const snapTimer = setInterval(snapshot, 1200);
    frameCleanup.push(() => clearInterval(snapTimer));
    const childSources = new Map();
    onWindowMessage((e) => {
      if (superseded()) return; // 被新实例取代的旧实例不许再参与帧间通信
      const d = e.data;
      if (!d || typeof d.tss !== 'string' || d.tss.indexOf('sniff:') !== 0) return;

      if (d.tss === 'sniff:hello') {
        // 自己发的 hello 不能回：否则等于自己给自己发 ack
        if (e.source === window) return;
        try {
          e.source.postMessage({ tss: 'sniff:ack', from: TAB_ID, n: d.n }, '*');
        } catch {
          /* 忽略 */
        }
        return;
      }

      // 派单：自己处理自己的，别人的往下转（父帧发来的也要看是不是孙辈的活）
      if (d.tss === 'sniff:download') {
        if (!d.frameId || d.frameId === frameId) return; // 自己的交给下一个监听器
        const child = childSources.get(d.frameId);
        if (child) {
          try {
            child.postMessage(d, '*');
          } catch {
            /* 忽略 */
          }
        }
        return;
      }

      if (e.source === window.parent) return; // 其余来自上层，忽略
      if (d.frameId) childSources.set(d.frameId, e.source);
      // 条目与任务进度继续向上冒泡，多层嵌套才能到顶层
      try {
        window.parent.postMessage(d, '*');
      } catch {
        /* 忽略 */
      }
    });

    onWindowMessage((e) => {
      if (superseded()) return;
      const d = e.data;
      if (!d || d.tss !== 'sniff:download' || d.frameId !== frameId) return;
      if (e.source !== window.parent) return;
      const item = store.get(d.itemId);
      if (!item) {
        framePost({ tss: 'sniff:job', itemId: d.itemId, status: 'error', message: '条目已失效，请刷新内嵌页' });
        return;
      }
      runItem(item, { relayItemId: d.itemId }).catch(() => {
        /* 失败也会在 runItem 里上报 */
      });
    });
  }

  // 当前正在播放的媒体对应的条目 id。
  // 列表按它置顶并挂「播放中」标记——列表里几十条时，用户一眼能认出正在看的那个。
  let activeMediaId = '';
  let revision = 0;
  let lastRenderRevision = -1;

  const countedSegments = new Set();

  /**
   * 分片名的"前缀"：seg-0.ts / seg-1.ts → seg；video-0.ts → video；0.ts → ''
   * 用来避免把同一目录下的不同轨道（video-0.ts / audio-0.ts）混成一组——
   * 混在一起按序号排序合并，出来的文件就变成"两条流交错"，播放器直接罢工。
   */
  function segmentStem(url) {
    const u = safeUrl(url);
    const base = (u ? u.pathname.split('/').pop() : String(url || '').split('/').pop()) || '';
    const noExt = base.replace(/\.[a-z0-9]+$/i, '');
    return noExt.replace(/[\s._-]*\d+$/, '');
  }

  function dirGroupKey(url, kind) {
    const u = safeUrl(url);
    if (!u) return `${kind}|${url}`;
    const path = u.pathname;
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    return `${kind}|${u.origin}${dir}|${segmentStem(url)}`;
  }

  const GENERIC_STEM = /^(seg|segments?|chunk|chunks|part|parts|frag|fragments?|slice|ts|media|index|file|files|hls|video|audio|main|playlist)$/i;

  function groupName(url) {
    const u = safeUrl(url);
    if (!u) return '分片分组';
    const segs = u.pathname.split('/').filter(Boolean);
    segs.pop();
    const tail = segs[segs.length - 1] || u.hostname;
    let dirName = tail;
    try {
      dirName = decodeURIComponent(tail);
    } catch {
      /* 保持原样 */
    }
    const stem = segmentStem(url);
    // 只有当前缀有信息量时才拼上去，避免满屏 "720p / seg"
    return stem && !GENERIC_STEM.test(stem) ? `${dirName} / ${stem}` : dirName;
  }

  /**
   * 列表里显示的名字。
   * HLS 站点的播放列表几乎都叫 index.m3u8 / playlist.m3u8，
   * 光看文件名分不出是哪条轨道，所以补上父目录（通常就是码率目录）。
   */
  const GENERIC_NAME = /^(index|playlist|main|chunklist|manifest|prog_index|media)\.(m3u8|mpd)$/i;

  function displayName(url) {
    const u = safeUrl(url);
    if (!u) return String(url).slice(0, 60);
    const segs = u.pathname.split('/').filter(Boolean);
    const file = segs.pop() || u.hostname;
    let decoded = file;
    try {
      decoded = decodeURIComponent(file);
    } catch {
      /* 保留原样 */
    }
    if (!GENERIC_NAME.test(decoded) || !segs.length) return decoded;
    const dir = segs[segs.length - 1];
    let dirName = dir;
    try {
      dirName = decodeURIComponent(dir);
    } catch {
      /* 保留原样 */
    }
    return `${dirName} / ${decoded}`;
  }

  const GROUPED_KINDS = new Set(['ts', 'm4s']);

  // 图片噪声大：太小的多半是图标、统计像素、占位图，直接不记
  const IMAGE_MIN_BYTES = 12 * 1024;
  const MAX_IMAGES = 40;

  function record(rawUrl, source, size, hint) {
    // 旧实例（已被新实例取代）必须停手，否则会重复记录、越记越多
    if (superseded()) return;
    stats.seen += 1;
    if (!rawUrl || typeof rawUrl !== 'string') return;
    if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return;

    const u = safeUrl(rawUrl, location.href);
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return;
    // 剥掉 #fragment：缩略图 <video src="…#t=0.1"> 的请求会带着片段进资源计时，
    // 不剥的话同一资源会变成两个条目——而新条目的缩略图又会被记成
    // …#t=0.1#t=0.1，无限自我繁殖
    u.hash = '';
    const url = u.href;
    if (selfUrls.has(url)) return;

    // URL 判断优先；没有扩展名的地址（/img?id=1、/play?vid=9）再靠 Content-Type 兜底
    const contentType = hint && hint.contentType ? String(hint.contentType) : '';
    const kind = classifyByUrl(url) || classifyByContentType(contentType) || (hint && hint.kind) || null;
    if (!kind) return;

    if (kind === 'image') {
      if (size && size < IMAGE_MIN_BYTES) return;
      // 图片单独限流，别把视频条目挤出列表
      if (!store.has(`s:image:${url}`)) {
        const images = [...store.values()].filter((it) => it.kind === 'image');
        if (images.length >= MAX_IMAGES) {
          let oldest = images[0];
          for (const it of images) if (it.firstSeen < oldest.firstSeen) oldest = it;
          store.delete(oldest.id);
        }
      }
    }

    const grouped = GROUPED_KINDS.has(kind);
    const id = grouped ? `g:${dirGroupKey(url, kind)}` : `s:${kind}:${url}`;

    let item = store.get(id);
    let touched = false;

    if (!item) {
      item = {
        id,
        kind,
        url,
        urls: grouped ? [] : null,
        count: 0,
        size: 0,
        host: u.hostname,
        name: grouped ? groupName(url) : displayName(url),
        contentType,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        source: source || '',
      };
      store.set(id, item);
      trimItems();
      touched = true;
    }

    if (grouped) {
      if (!item.urls.includes(url)) {
        if (item.urls.length < MAX_SEGMENTS) {
          item.urls.push(url);
          item.count = item.urls.length;
          touched = true;
        } else {
          item.truncated = true;
        }
      }
    } else {
      item.count += 1;
      touched = true;
    }

    if (contentType && !item.contentType) item.contentType = contentType;
    // 「正在播放」的判定：
    //   · source === 'media' 来自真实播放的媒体元素（loadstart / playing）；
    //   · m3u8 / ts / m4s / mpd 的网络流量是流式播放（MSE 场景元素 src 是 blob:，只能靠它认）。
    // 排除两类：直接的 mp4 请求（预加载、缩略图都会产生）；2 秒一次的 dom 扫描
    // （页面里躺着个播不了的死视频，不能让它永远霸着「播放中」）。
    const marksActive =
      source === 'media' ||
      ((kind === 'm3u8' || kind === 'ts' || kind === 'm4s' || kind === 'mpd') && source !== 'dom');
    if (marksActive) activeMediaId = item.id;
    if (size) addSize(item, url, size);
    // 资源计时里的尺寸可能晚于 URL 到达：这时才发现是图标，就把条目摘掉
    if (kind === 'image' && item.size && item.size < IMAGE_MIN_BYTES) {
      store.delete(item.id);
      bump();
      return;
    }
    item.lastSeen = Date.now();
    if (touched) bump();
  }

  function addSize(item, url, size) {
    const n = Number(size) || 0;
    if (!n) return;
    if (item.urls) {
      const key = `${item.id}|${url}`;
      if (countedSegments.has(key)) return;
      countedSegments.add(key);
      item.size += n;
    } else {
      item.size = Math.max(item.size, n);
    }
  }

  function trimItems() {
    while (store.size > MAX_ITEMS) {
      const oldest = [...store.values()].sort((a, b) => a.firstSeen - b.firstSeen)[0];
      if (!oldest) break;
      store.delete(oldest.id);
      for (const key of countedSegments) {
        if (key.startsWith(oldest.id + '|')) countedSegments.delete(key);
      }
    }
  }

  let bumpTimer = null;
  /**
   * 只显示"当前这一页"的资源。
   *
   * 单页应用里 pushState 换集数时，旧的资源会一直留在列表里，几十条堆在一起，
   * 根本看不出哪条属于正在看的这一集。所以 URL 一变就清空列表。
   *
   * 只用轮询 + popstate/hashchange，不去改写 history —— 之前吃过改写页面原型的亏。
   */
  function resetList(notice) {
    activeMediaId = '';
    if (!store.size) {
      // 列表本来就是空的，只需把水位推到末尾
      try {
        perfWatermark = perfRef ? perfRef.getEntriesByType('resource').length : 0;
      } catch {
        perfWatermark = 0;
      }
      return;
    }
    const had = store.size;
    store.clear();
    countedSegments.clear();
    selfUrls.clear();
    revision += 1;
    try {
      perfWatermark = perfRef ? perfRef.getEntriesByType('resource').length : 0;
    } catch {
      perfWatermark = 0;
    }
    if (uiReady) {
      render();
      if (open) renderBody();
    }
    if (settings.toast && had) toast(notice);
  }

  function resetForNewPage() {
    resetList('页面已切换，列表已重置');
  }

  /**
   * 播放器在同一个 URL 下换了视频（SPA 内部切换，地址栏纹丝不动）。
   * 信号是「同一个媒体元素开始加载新的源」——换台必然换源，
   * 这比 URL 灵敏得多。
   */
  function resetForNewMedia() {
    resetList('媒体已切换，列表已重置');
  }

  /**
   * 手动刷新：清空探测列表和任务卡片（不动已保存到本地的文件），
   * 然后把资源计时历史与页面里的媒体/图片元素重新扫一遍。
   * 与 resetList 的关键区别：水位清零而不是推到末尾——历史请求要重新捞回来。
   */
  function refreshMedia() {
    activeMediaId = '';
    // 清空任务列表前先把每个成品的 blob URL 撤销：
    // 直接 jobs.length = 0 会让这些 URL 一直挂在文档上，白占内存
    for (const job of jobs) releaseJobMemory(job);
    jobs.length = 0;
    store.clear();
    // 内嵌页的条目也要清，它们一秒内会重新上报，否则刷新后看着像没清干净
    remoteItems.clear();
    countedSegments.clear();
    selfUrls.clear();
    perfWatermark = 0;
    try {
      for (const api of perfApis) {
        try {
          api.drain();
        } catch {
          /* 忽略 */
        }
      }
    } catch {
      /* 忽略 */
    }
    scanMediaElements();
    scanImages();
    scanBackgroundImages();
    revision += 1;
    bump();
    toast('列表已刷新');
  }

  let lastHref = '';

  function installNavWatcher() {
    lastHref = location.href;
    const check = () => {
      if (superseded()) return; // 旧实例已停手
      if (location.href === lastHref) return;
      lastHref = location.href;
      resetForNewPage();
    };
    try {
      window.addEventListener('popstate', check);
      window.addEventListener('hashchange', check);
    } catch {
      /* 忽略 */
    }
    // 兜底：有些站点直接改 location，或者用框架自己的路由。
    // 句柄必须登记到 frameCleanup：以前这里是个永不停的 700ms 轮询，
    // 旧实例被新实例取代后仍在跑，属于实打实的泄漏。
    const navTimer = setInterval(check, 700);
    frameCleanup.push(() => clearInterval(navTimer));
  }

  function bump() {
    revision += 1;
    if (bumpTimer) return;
    bumpTimer = setTimeout(() => {
      bumpTimer = null;
      if (revision === lastRenderRevision) return;
      lastRenderRevision = revision;
      render();
    }, 200);
  }

  /** 顶层：接收各内嵌页上报，合并列表；下载派回对应内嵌页执行 */
  const frameSeen = new Map(); // frameId -> 最后一次上报时间

  /** 整帧作废：条目、映射、派发中的任务一起清掉 */
  function dropFrame(frameId) {
    remoteFrames.delete(frameId);
    frameSeen.delete(frameId);
    let changed = false;
    for (const [id, it] of [...remoteItems]) {
      if (it.frameId === frameId) {
        remoteItems.delete(id);
        changed = true;
      }
    }
    for (const key of [...remoteJobs.keys()]) {
      if (key.indexOf(frameId + ':') === 0) remoteJobs.delete(key);
    }
    return changed;
  }

  /**
   * 内嵌页脚本重新注入后 frameId 会变、窗口还是同一个：
   * 旧身份的条目必须作废，否则列表里会留下永远点不动的幽灵条目。
   */
  function dropStaleFrames(source, frameId) {
    if (!source) return false;
    let changed = false;
    for (const [fid, src] of [...remoteFrames]) {
      if (fid !== frameId && src === source) changed = dropFrame(fid) || changed;
    }
    return changed;
  }

  function installFrameHost() {
    if (!SHOULD_MOUNT) return;
    if (frameHostReady) return;
    frameHostReady = true;
    // 内嵌页被移除后不会再上报，定时清掉长期没动静的帧
    const sweep = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [fid, ts] of [...frameSeen]) {
        if (now - ts > 45000) changed = dropFrame(fid) || changed;
      }
      if (changed) {
        revision += 1;
        bump();
      }
    }, 15000);
    frameCleanup.push(() => clearInterval(sweep));

    onWindowMessage((e) => {
      // 关键：旧实例收到 hello 会回 ack，新实例就会误判自己是内嵌页。
      // 已被取代的实例必须完全闭嘴。
      if (superseded()) return;
      const d = e.data;
      if (!d || typeof d.tss !== 'string' || d.tss.indexOf('sniff:') !== 0) return;

      if (d.tss === 'sniff:hello') {
        if (e.source === window) return;
        if (d.frameId) dropStaleFrames(e.source, d.frameId);
        try {
          e.source.postMessage({ tss: 'sniff:ack', from: TAB_ID, n: d.n }, '*');
        } catch {
          /* 忽略 */
        }
        return;
      }
      if (!d.frameId) return;

      if (d.tss === 'sniff:items') {
        dropStaleFrames(e.source, d.frameId);
        remoteFrames.set(d.frameId, e.source);
        frameSeen.set(d.frameId, Date.now());
        for (const [id, it] of remoteItems) {
          if (it.frameId === d.frameId) remoteItems.delete(id);
        }
        for (const raw of d.items || []) {
          if (!raw || !raw.id || !raw.kind) continue;
          const id = `r:${d.frameId}:${raw.id}`;
          remoteItems.set(id, { ...raw, id, remote: true, frameId: d.frameId, remoteId: raw.id });
        }
        revision += 1;
        bump();
        return;
      }

      const key = `${d.frameId}:${d.itemId}`;
      const jobId = remoteJobs.get(key);
      if (!jobId) return;
      const job = jobs.find((j) => j.id === jobId);
      if (!job) return;

      if (d.tss === 'sniff:progress') {
        job.done = d.done || 0;
        job.total = d.total || 0;
        job.bytes = d.bytes || 0;
        job.percent = d.percent || 0;
        job.speed = d.speed || 0;
        job.message = d.total ? `内嵌页抓取 ${job.done}/${job.total}` : '内嵌页下载中…';
        scheduleJobRender();
      } else if (d.tss === 'sniff:job') {
        job.status = d.status === 'done' ? 'done' : d.status === 'canceled' ? 'canceled' : 'error';
        job.message = d.message || (job.status === 'done' ? '已保存' : '下载失败');
        job.bytes = d.bytes || job.bytes;
        job.percent = job.status === 'done' ? 1 : job.percent;
        job.filename = d.name || job.filename;
        activeJob = null;
        remoteJobs.delete(key);
        renderBody();
      }
    });
  }

  /** 顶层点「下载」：把活派给条目所属的内嵌页，并在顶层显示任务卡 */
  function startRemoteDownload(item) {
    const frame = remoteFrames.get(item.frameId);
    if (!frame) {
      toast('内嵌页已失效，刷新页面后重试');
      return;
    }
    const key = `${item.frameId}:${item.remoteId}`;
    if (remoteJobs.has(key)) {
      toast('这个条目正在下载');
      return;
    }
    try {
      frame.postMessage({ tss: 'sniff:download', frameId: item.frameId, itemId: item.remoteId }, '*');
    } catch {
      toast('无法联系内嵌页');
      return;
    }
    const job = {
      id: newJobId(),
      item,
      title: item.name,
      filename: '',
      status: 'running',
      phase: '内嵌页下载中…',
      message: '内嵌页下载中…',
      done: 0,
      total: 0,
      bytes: 0,
      percent: 0,
      speed: 0,
      eta: 0,
      cancelled: false,
      remote: true,
      startedAt: Date.now(),
    };
    jobs.unshift(job);
    if (jobs.length > 4) removeJob(jobs[jobs.length - 1].id);
    remoteJobs.set(key, job.id);
    renderBody();
  }

  /* ------------------------------ 探测手段 ------------------------------ */

  /**
   * 页面世界。
   * 声明了 GM grant 后，脚本通常跑在沙箱里，unsafeWindow 才是页面真正的 window；
   * 不支持 unsafeWindow 的环境退回 window。fetch / XHR 钩子必须打在页面世界上，
   * 否则探测不到站点自己发起的请求。
   */
  function pageWindow() {
    try {
      return (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    } catch {
      return window;
    }
  }

  /**
   * 为什么还需要这两个钩子：
   * 资源计时并不是万能的 —— 实测在某些 Chromium 上 fetch() 压根不产生
   * resource timing 条目（XHR 和媒体请求才会），只靠资源计时会漏掉用 fetch
   * 拉分片的播放器。钩子只读 URL，不改写返回值，也不碰任何响应。
   */
  function installFetchHook() {
    try {
      const target = pageWindow();
      const orig = target.fetch;
      if (typeof orig !== 'function') return;
      if (orig.__tssWrapped) return;
      const wrapped = function (input, init) {
        let url = '';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url) record(url, 'fetch');
        } catch {
          /* 探测失败绝不能影响页面 */
        }
        const self = this === undefined || this === null ? target : this;
        const res = orig.apply(self, arguments);
        // 顺手读一眼 Content-Type：无扩展名的图片/视频（/img?id=1）只能靠它认出来。
        // 这里只是旁挂一个 then，不改变原 promise 的返回值。
        try {
          if (url && res && typeof res.then === 'function') {
            res
              .then((r) => {
                try {
                  const ct = r && r.headers && r.headers.get ? r.headers.get('content-type') : '';
                  if (ct) record(url, 'fetch', 0, { contentType: ct });
                } catch {
                  /* 忽略 */
                }
              })
              .catch(() => {});
          }
        } catch {
          /* 忽略 */
        }
        return res;
      };
      wrapped.__tssWrapped = true;
      target.fetch = wrapped;
      stats.fetchHooked = true;
    } catch {
      /* 某些环境不允许改写，资源计时兜底 */
    }
  }

  function installXhrHook() {
    try {
      const target = pageWindow();
      const XHR = target.XMLHttpRequest;
      if (!XHR || !XHR.prototype || typeof XHR.prototype.open !== 'function') return;
      const orig = XHR.prototype.open;
      if (orig.__tssWrapped) return;
      const wrapped = function (method, url) {
        try {
          if (url) {
            this.__tssUrl = String(url);
            record(this.__tssUrl, 'xhr');
          }
        } catch {
          /* 忽略 */
        }
        return orig.apply(this, arguments);
      };
      wrapped.__tssWrapped = true;
      XHR.prototype.open = wrapped;
      stats.xhrHooked = true;

      // XHR 也能读到 Content-Type，用来认无扩展名的资源
      const origSend = XHR.prototype.send;
      if (origSend && !origSend.__tssWrapped) {
        const sendWrapped = function () {
          try {
            this.addEventListener(
              'load',
              () => {
                try {
                  const ct = this.getResponseHeader('content-type');
                  const url = this.__tssUrl || this.responseURL;
                  if (ct && url) record(url, 'xhr', 0, { contentType: ct });
                } catch {
                  /* 忽略 */
                }
              },
              { once: true }
            );
          } catch {
            /* 忽略 */
          }
          return origSend.apply(this, arguments);
        };
        sendWrapped.__tssWrapped = true;
        XHR.prototype.send = sendWrapped;
      }
    } catch {
      /* 忽略 */
    }
  }

  let mediaObserver = null;

  /**
   * 媒体地址监听 —— 只读，不改页面。
   * 早先的版本直接改写 HTMLMediaElement.prototype.src 的 setter，
   * 在部分播放器上会让赋错，进而把整页视频搞挂。现在改成纯监听：
   *   · 捕获阶段听 loadstart（video/audio/source 都会冒上来）
   *   · MutationObserver 盯 src 属性变化
   *   · 再加一个低频轮询兜底
   */
  function installMediaWatchers() {
    // 每个媒体元素上一次加载的地址。
    // 同一个元素换了源 = 播放器切了视频——哪怕地址栏一点没变（SPA 内部切换）。
    // 这是「实时只跟踪当前媒体」的核心信号。
    const lastSrcByEl = new WeakMap();

    const pick = (el) => {
      if (!el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'video' && tag !== 'audio' && tag !== 'source') return;
      // 面板里自己的缩略图 <video>：别当成分页媒体，也别抢「正在播放」
      if (el.hasAttribute && el.hasAttribute('data-tss-thumb')) return;
      const src = el.currentSrc || el.src || el.getAttribute('src') || '';
      if (!src) return;

      const prev = lastSrcByEl.get(el);
      lastSrcByEl.set(el, src);

      if (prev && prev !== src) {
        // 静音的几乎都是自动播放的预览小窗（商品页 / 推荐位轮播），
        // 它们换源不该清用户的列表；用户正片即使静音，列表也能靠
        // 「正在播放」标记对上，不至于两眼一抹黑
        const muted = typeof el.muted === 'boolean' ? el.muted : true;
        if (!muted) resetForNewMedia();
      }

      record(src, 'media');
    };

    try {
      // 媒体事件不冒泡，捕获阶段在 document 上接
      document.addEventListener('loadstart', (e) => pick(e.target), true);
      // 恢复播放也会刷新「正在播放」的归属（缓存的视频重播不再发网络请求）
      document.addEventListener('playing', (e) => pick(e.target), true);
    } catch {
      /* 忽略 */
    }

    try {
      const root = document.documentElement || document;
      mediaObserver = new MutationObserver((list) => {
        for (const m of list) pick(m.target);
      });
      mediaObserver.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src'],
      });
      stats.mediaWatched = true;
      return mediaObserver;
    } catch {
      return null;
    }
  }

  const perfApis = [];
  let drainTimer = 0;
  let scanTimer = 0;
  let bgTimer = 0;
  let mediaWatched = false;
  let navWatched = false;
  let sniffingSuspended = false;

  /**
   * 资源计时是这里最重要的一路信号：
   * iOS 原生 HLS 播放由系统网络栈发起，fetch/XHR 钩子看不到，
   * 但每一条 .ts / .m3u8 请求都会出现在 resource timing 里。
   */
  function installPerfObserver() {
    // 可重入：恢复时先拆掉上一轮的观察器与轮询，避免重复记录
    for (const old of perfApis) {
      try {
        old.po.disconnect();
      } catch {
        /* 忽略 */
      }
    }
    perfApis.length = 0;
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = 0;
    }

    const perf = (() => {
      try {
        return window.performance;
      } catch {
        return null;
      }
    })();
    if (!perf) return;
    perfRef = perf;

    try {
      perf.setResourceTimingBufferSize && perf.setResourceTimingBufferSize(4000);
    } catch {
      /* Safari 旧版本可能不支持 */
    }

    function drain() {
      try {
        const entries = perf.getEntriesByType('resource');
        if (entries.length < perfWatermark) perfWatermark = 0; // 缓冲区被清空过
        for (let i = perfWatermark; i < entries.length; i++) {
          const e = entries[i];
          if (!e || !e.name) continue;
          stats.perfSeen += 1;
          record(e.name, 'perf', e.transferSize || e.encodedBodySize || 0, perfHint(e));
        }
        perfWatermark = entries.length;
      } catch {
        /* 忽略 */
      }
    }

    try {
      const Observer =
        window.PerformanceObserver || (typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null);
      if (Observer) {
        const po = new Observer((list) => {
          try {
            for (const e of list.getEntries()) {
              if (e && e.name) record(e.name, 'perf', e.transferSize || e.encodedBodySize || 0, perfHint(e));
            }
          } catch {
            /* 忽略 */
          }
        });
        po.observe({ entryTypes: ['resource'] });
        perfApis.push({ po, drain });
      }
    } catch {
      /* 忽略 */
    }

    // 缓冲区写满后新条目会被丢弃，读完再清空
    try {
      perf.addEventListener('resourcetimingbufferfull', () => {
        drain();
        try {
          perf.clearResourceTimings();
          perfWatermark = 0;
        } catch {
          /* 忽略 */
        }
      });
    } catch {
      /* 忽略 */
    }

    // 立刻把注入之前已经发生的请求捞一遍（document-end 注入时这段历史很关键）
    try {
      drain();
    } catch {
      /* 忽略 */
    }
    drainTimer = setInterval(drain, 2000);
  }

  /**
   * 资源计时条目的 initiatorType 能告诉我们"这是 <img> 拉的"——
   * 无扩展名的图片地址（CDN 常见：/photo/123、?imageMogr2=…）URL 认不出、
   * <img> 加载又不走 fetch/XHR 钩子拿不到 Content-Type，全靠它兜底。
   */
  function perfHint(e) {
    const t = e && e.initiatorType;
    if (t === 'img' || t === 'image') return { kind: 'image' };
    if (t === 'audio') return { kind: 'audio' };
    if (t === 'video') return { kind: 'video' };
    return undefined;
  }

  /**
   * 扫描页面里的 <img>：真照片（尤其无扩展名 CDN 地址）补探测，
   * 图标类小图按实际分辨率过滤（naturalWidth/Height 都小于 64 的不要）。
   */
  // 图标类小图的判定：任一边小于 96px 就算。缩略头像一般 96~200，
  // 真内容图（文章配图、商品图）基本都在 300 以上，不会误伤
  const IMAGE_MIN_PIXELS = 96;
  function scanImages() {
    try {
      const nodes = document.querySelectorAll('img');
      for (const img of nodes) {
        // currentSrc 覆盖 srcset 选中的实际地址；懒加载站点常把真地址放在
        // data-src / data-original 里，src 只是个占位图——这些也要认
        const src =
          img.currentSrc ||
          img.src ||
          img.getAttribute('data-src') ||
          img.getAttribute('data-original') ||
          img.getAttribute('data-lazy-src') ||
          '';
        if (!src) continue;
        const w = img.naturalWidth || 0;
        const h = img.naturalHeight || 0;
        // 已加载完成且确定是小图标 → 跳过；还没加载完（0）的先记上，不冤枉
        if (w > 0 && h > 0 && Math.min(w, h) < IMAGE_MIN_PIXELS) {
          // 网络路径（资源计时 / initiatorType）拿不到分辨率，可能已经先收进来了：
          // 这里按 DOM 实测尺寸把它清掉——图标不该占列表
          const u = safeUrl(src, location.href);
          if (u) {
            u.hash = '';
            if (store.delete(`s:image:${u.href}`)) bump();
          }
          continue;
        }
        record(src, 'dom', 0, { kind: 'image' });
      }
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 背景图扫描：CSS 背景里的图不进 <img>，也拿不到 Content-Type，
   * 资源计时里 initiatorType 是 'css'（还混着字体），只能从计算样式里认。
   * 按元素尺寸滤掉小图标，元素总扫描量设上限，避免在巨型页面里拖慢滚动。
   */
  function scanBackgroundImages() {
    try {
      const nodes = document.querySelectorAll('body *');
      const limit = Math.min(nodes.length, 1500);
      for (let i = 0; i < limit; i++) {
        const el = nodes[i];
        let bg = '';
        try {
          bg = getComputedStyle(el).backgroundImage || '';
        } catch {
          continue;
        }
        if (!bg || bg === 'none' || bg.indexOf('url(') === -1) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && Math.min(r.width, r.height) < 96) continue;
        const re = /url\((['"]?)(.*?)\1\)/g;
        let m;
        while ((m = re.exec(bg)) !== null) {
          const src = m[2];
          if (!src || src.startsWith('data:')) continue;
          record(src, 'dom', 0, { kind: 'image' });
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  function scanMediaElements() {
    stats.domScanned += 1;
    try {
      const nodes = document.querySelectorAll('video, audio, source');
      for (const node of nodes) {
        const src = node.currentSrc || node.src || node.getAttribute('src') || '';
        if (!src) continue;
        const tag = node.tagName ? node.tagName.toLowerCase() : '';
        record(src, 'dom', 0, tag === 'audio' ? { kind: 'audio' } : tag === 'video' ? { kind: 'video' } : undefined);
      }
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 资源计时先装：它不碰页面任何函数，也不依赖 DOM。
   * fetch/XHR 钩子稍后再装 —— 就算晚一步也不影响，早先发生的请求
   * 依然躺在资源计时的历史记录里，drain 时会被捞回来。
   */
  function startPerfSniffing() {
    installPerfObserver();
  }

  /**
   * 角色握手。
   * IS_TOP 靠 window.top === window 判断，在脚本管理器的沙箱里可能失真，
   * 导致内嵌页以为自己是最外层（于是挂了界面、也不上报，顶层就永远看不到内嵌页资源）。
   * 这里直接问父帧：450ms 内收到 ack 就认定自己是子帧——撤掉界面、转为上报模式。
   */
  function startFrameHandshake() {
    // 已经能确定自己在最外层：不发 hello、也不接受 ack。
    // 这一条是"偶发不运行"的根治点——旧实例残留的监听再也撤不掉我们的界面。
    if (TOP_CERTAIN) return;
    // 进入冷静期：真内嵌页会在这段时间里收到 ack，从而根本不挂界面
    mountHoldUntil = Date.now() + 2600;
    // 冷静期一过：没等到 ack（父帧没有脚本，或自己确实是顶层）就立刻挂载，
    // 不必再等看门狗的 2 秒节拍——没有父帧的页面也能尽快看到悬浮球
    const holdTimer = setTimeout(() => {
      if (superseded() || forceChild) return;
      if (SHOULD_MOUNT && !(uiReady && hostEl && hostEl.isConnected)) {
        try {
          mountUI();
        } catch (err) {
          console.warn('[Media Sniffer] 冷静期后挂载失败', err);
        }
      }
    }, 2700);
    frameCleanup.push(() => clearTimeout(holdTimer));

    /**
     * 确认自己是子帧后的动作：撤掉可能已经挂出的界面，转为上报模式。
     * 关键在「随时可用」——父帧的脚本可能比本帧晚注入，只要 ack 到了就纠正；
     * 否则内嵌页会一直以为自己是顶层，页面上就多出一个悬浮窗。
     */
    const becomeChild = () => {
      if (forceChild) return;
      forceChild = true;
      if (uiReady) {
        // 撤掉误挂的界面（只摘节点，探测继续跑）
        try {
          if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
        } catch {
          /* 忽略 */
        }
        hostEl = null;
        uiReady = false;
      }
      try {
        installFrameBridge(true);
      } catch {
        /* 忽略 */
      }
    };

    // 只认父帧的 ack：同窗口（旧实例残留监听、或自己回的）一律不算
    onWindowMessage((e) => {
      if (superseded()) return;
      const d = e.data;
      if (!d || d.tss !== 'sniff:ack') return;
      if (TOP_CERTAIN) return; // 能确定是顶层，任何 ack 都不认
      // 必须原样回传本次 hello 的随机数：旧版本实例的 ack 没这个字段，直接忽略
      if (d.n !== HS_NONCE) return;
      // 自己回的 ack（沙箱里 proxy 可能让 e.source 看起来像父帧）带的就是自己的标识
      if (d.from === TAB_ID) return;
      // 不再比较 e.source 与 window.parent：跨域内嵌页的沙箱里这两个对象的身份
      // 对不上，ack 会被永远拒收——内嵌页于是各自挂出悬浮球。随机数才是凭证：
      // 它只随本帧发出的 hello 传播，能原样回传的一定是父帧里的脚本。
      try {
        if (e.source === window) return;
      } catch {
        /* 忽略 */
      }
      becomeChild();
    });

    const sayHello = () => {
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ tss: 'sniff:hello', n: HS_NONCE }, '*');
        }
      } catch {
        /* 忽略 */
      }
    };

    sayHello();
    // 父帧可能晚于本帧就绪：多发几次，任一次拿到 ack 就转为子帧
    for (const delay of [600, 1500, 3000, 5000, 8000]) {
      const timer = setTimeout(sayHello, delay);
      frameCleanup.push(() => clearTimeout(timer));
    }
  }

  /**
   * DOM 侧的补充探测。
   * 主通道始终是资源计时——它能看到页面发出的每一个请求，包括原生 HLS 播放器
   * 由系统网络栈发出的分片请求，而且不需要动页面一根手指。
   */
  function startDomSniffing() {
    installFetchHook();
    installXhrHook();
    // 监听器只装一次：重复装会让同一次媒体事件被记录两遍
    if (!mediaWatched) {
      installMediaWatchers();
      mediaWatched = true;
    }
    if (!navWatched) {
      installNavWatcher();
      navWatched = true;
    }
    scanMediaElements();
    scanImages();
    if (!scanTimer) {
      scanTimer = setInterval(() => {
        scanMediaElements();
        scanImages();
      }, 2000);
    }
    // 背景图变化不频繁，单独给一个更慢的节奏
    scanBackgroundImages();
    if (!bgTimer) bgTimer = setInterval(scanBackgroundImages, 8000);
  }

  /**
   * 挂起 / 恢复探测。
   *
   * iOS Safari 切后台或跳到别的页面时会触发 pagehide，页面进 bfcache；
   * 我们在这里把观察器断开（否则系统会一直提示页面在运行），
   * 但过去没有对应的 pageshow 恢复逻辑——回到页面后观察器永远是断的，
   * 看着就像"脚本第二次不运行"。这里补齐恢复路径。
   */
  function suspendSniffing() {
    sniffingSuspended = true;
    try {
      if (mediaObserver) mediaObserver.disconnect();
    } catch {
      /* 忽略 */
    }
    for (const api of perfApis) {
      try {
        api.po.disconnect();
      } catch {
        /* 忽略 */
      }
    }
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = 0;
    }
    if (bgTimer) {
      clearInterval(bgTimer);
      bgTimer = 0;
    }
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = 0;
    }
  }

  function resumeSniffing() {
    if (!sniffingSuspended) return;
    sniffingSuspended = false;
    try {
      startPerfSniffing();
    } catch {
      /* 忽略 */
    }
    try {
      startDomSniffing();
    } catch {
      /* 忽略 */
    }
  }

  /* ================================================================== *
   * 4. 设置
   * ================================================================== */

  // 读取时做字段校验：任何脏数据都不会影响启动
  const SETTINGS_KEY = 'tss_ios_settings_v2';
  const DEFAULT_SETTINGS = { concurrency: 4, toast: true, maxMB: 900, theme: 'default', fabOpacity: 1, autoSave: true };

  // 深色主题共用一套状态色 / 标签色；白色主题单独覆盖
  const STATUS = { ok: '#3ddc97', warn: '#ffb020', danger: '#ff5c7a' };
  const TAGS_DARK = {
    '--tag-bg': 'rgba(79,140,255,.14)',
    '--tag-fg': '#7aa8ff',
    '--tag-ts-bg': 'rgba(139,92,246,.16)',
    '--tag-ts-fg': '#b79cff',
    '--tag-mp4-bg': 'rgba(61,220,151,.14)',
    '--tag-mp4-fg': '#4fdca8',
    '--tag-img-bg': 'rgba(56,189,248,.14)',
    '--tag-img-fg': '#67d1f5',
    '--tag-dash-bg': 'rgba(255,176,32,.14)',
    '--tag-dash-fg': '#ffb020',
  };

  /**
   * 主题 = 一组 CSS 变量。
   *
   * 关键点：悬浮窗的底色单独用 --fab-bg / --fab-fg 描述。
   * 之前悬浮窗直接吃 --accent 渐变，所以切到白/黑/灰主题时它还是蓝紫的。
   */
  function theme(spec) {
    return {
      id: spec.id,
      name: spec.name,
      swatch: spec.swatch,
      vars: {
        '--bg': spec.bg,
        '--panel': spec.panel,
        '--card': spec.card,
        '--card-hi': spec.cardHi,
        '--line': spec.line,
        '--text': spec.text,
        '--muted': spec.muted,
        '--faint': spec.faint,
        '--accent': spec.accent,
        '--accent2': spec.accent2,
        '--ok': spec.ok || STATUS.ok,
        '--warn': spec.warn || STATUS.warn,
        '--danger': spec.danger || STATUS.danger,
        '--glow': spec.glow,
        '--fab-bg': spec.fabBg,
        '--fab-fg': spec.fabFg,
        '--fab-border': spec.fabBorder || 'transparent',
        ...(spec.tags || TAGS_DARK),
      },
    };
  }

  const THEMES = [
    theme({
      id: 'default',
      name: '默认',
      swatch: 'linear-gradient(140deg,#4f8cff,#8b5cf6)',
      bg: '#0e1320',
      panel: '#151c2b',
      card: '#1b2333',
      cardHi: '#212b3e',
      line: '#283349',
      text: '#e8edf7',
      muted: '#8b95ab',
      faint: '#61708a',
      accent: '#4f8cff',
      accent2: '#8b5cf6',
      glow: 'rgba(79,140,255,.6)',
      fabBg: 'linear-gradient(140deg,#4f8cff,#8b5cf6)',
      fabFg: '#ffffff',
    }),
    theme({
      id: 'white',
      name: '白',
      swatch: '#ffffff',
      bg: '#eef1f6',
      panel: '#ffffff',
      card: '#ffffff',
      cardHi: '#f1f4f9',
      line: '#e3e8f1',
      text: '#17202c',
      muted: '#5a6678',
      faint: '#8a95a6',
      accent: '#2563eb',
      accent2: '#7c3aed',
      ok: '#059669',
      warn: '#b45309',
      danger: '#dc2626',
      glow: 'rgba(37,99,235,.22)',
      fabBg: '#ffffff',
      fabFg: '#1b2431',
      fabBorder: 'rgba(23,32,44,.16)',
      tags: {
        '--tag-bg': 'rgba(37,99,235,.10)',
        '--tag-fg': '#1d4ed8',
        '--tag-ts-bg': 'rgba(124,58,237,.10)',
        '--tag-ts-fg': '#6d28d9',
        '--tag-mp4-bg': 'rgba(5,150,105,.12)',
        '--tag-mp4-fg': '#047857',
        '--tag-img-bg': 'rgba(2,132,199,.12)',
        '--tag-img-fg': '#0369a1',
        '--tag-dash-bg': 'rgba(180,83,9,.12)',
        '--tag-dash-fg': '#b45309',
      },
    }),
    theme({
      id: 'black',
      name: '黑',
      swatch: 'linear-gradient(140deg,#2a2b31,#0a0a0c)',
      bg: '#000000',
      panel: '#0a0a0c',
      card: '#131316',
      cardHi: '#1c1d21',
      line: '#24252a',
      text: '#f2f3f5',
      muted: '#9aa1ad',
      faint: '#6b7280',
      accent: '#3b82f6',
      accent2: '#8b5cf6',
      ok: '#34d399',
      warn: '#fbbf24',
      danger: '#f87171',
      glow: 'rgba(255,255,255,.16)',
      fabBg: 'linear-gradient(140deg,#26272d,#0b0b0e)',
      fabFg: '#f2f3f5',
      fabBorder: 'rgba(255,255,255,.14)',
    }),
    theme({
      id: 'gray',
      name: '灰',
      swatch: 'linear-gradient(140deg,#98a2b3,#4b5563)',
      bg: '#1b1e23',
      panel: '#24272d',
      card: '#2b2f36',
      cardHi: '#343941',
      line: '#3b414a',
      text: '#eef1f5',
      muted: '#a4acb9',
      faint: '#7b8494',
      accent: '#94a3b8',
      accent2: '#64748b',
      ok: '#4ade80',
      warn: '#fbbf24',
      danger: '#fb7185',
      glow: 'rgba(148,163,184,.4)',
      fabBg: 'linear-gradient(140deg,#98a2b3,#4b5563)',
      fabFg: '#ffffff',
    }),
    theme({
      id: 'brown',
      name: '棕',
      swatch: 'linear-gradient(140deg,#c08a5e,#6d4a33)',
      bg: '#241c18',
      panel: '#2e2420',
      card: '#372b26',
      cardHi: '#42342d',
      line: '#4b3b33',
      text: '#f6ece4',
      muted: '#bfa898',
      faint: '#93796a',
      accent: '#cf8b5c',
      accent2: '#a9633f',
      ok: '#86bf8b',
      warn: '#e0a852',
      danger: '#e07a5f',
      glow: 'rgba(207,139,92,.45)',
      fabBg: 'linear-gradient(140deg,#c08a5e,#7a4c30)',
      fabFg: '#ffffff',
    }),
    theme({
      id: 'blue',
      name: '蓝',
      swatch: 'linear-gradient(140deg,#4f9cff,#1d4ed8)',
      bg: '#0a1420',
      panel: '#0f1c2e',
      card: '#14243a',
      cardHi: '#1a2e49',
      line: '#223a58',
      text: '#e6eefb',
      muted: '#8aa0bd',
      faint: '#5f7896',
      accent: '#3b82f6',
      accent2: '#2563eb',
      glow: 'rgba(59,130,246,.55)',
      fabBg: 'linear-gradient(140deg,#4f9cff,#1d4ed8)',
      fabFg: '#ffffff',
    }),
    theme({
      id: 'purple',
      name: '紫',
      swatch: 'linear-gradient(140deg,#b06bff,#6d28d9)',
      bg: '#120e1f',
      panel: '#191430',
      card: '#221a40',
      cardHi: '#2b2150',
      line: '#362a61',
      text: '#efe9fb',
      muted: '#a99cc8',
      faint: '#7d6fa3',
      accent: '#a855f7',
      accent2: '#7c3aed',
      glow: 'rgba(168,85,247,.5)',
      fabBg: 'linear-gradient(140deg,#b06bff,#6d28d9)',
      fabFg: '#ffffff',
    }),
    theme({
      id: 'red',
      name: '红',
      swatch: 'linear-gradient(140deg,#f2607a,#b91c1c)',
      bg: '#1c0d10',
      panel: '#261115',
      card: '#33161b',
      cardHi: '#401c22',
      line: '#4d2229',
      text: '#fbeaec',
      muted: '#c99a9f',
      faint: '#9a6f76',
      accent: '#f43f5e',
      accent2: '#b91c1c',
      glow: 'rgba(244,63,94,.5)',
      fabBg: 'linear-gradient(140deg,#f2607a,#b91c1c)',
      fabFg: '#ffffff',
    }),
    theme({
      id: 'green',
      name: '绿',
      swatch: 'linear-gradient(140deg,#3ddc84,#15803d)',
      bg: '#08170f',
      panel: '#0c1f16',
      card: '#10281c',
      cardHi: '#163323',
      line: '#1d422d',
      text: '#e6f7ed',
      muted: '#93b8a3',
      faint: '#648c74',
      accent: '#22c55e',
      accent2: '#15803d',
      glow: 'rgba(34,197,94,.5)',
      fabBg: 'linear-gradient(140deg,#3ddc84,#15803d)',
      fabFg: '#ffffff',
    }),
    theme({
      id: 'orange',
      name: '橙',
      swatch: 'linear-gradient(140deg,#ffb340,#c2410c)',
      bg: '#1b1206',
      panel: '#241807',
      card: '#2f2009',
      cardHi: '#3b280c',
      line: '#4a3310',
      text: '#fdf1de',
      muted: '#c8a878',
      faint: '#9b7d52',
      accent: '#f59e0b',
      accent2: '#c2410c',
      glow: 'rgba(245,158,11,.5)',
      fabBg: 'linear-gradient(140deg,#ffb340,#c2410c)',
      fabFg: '#ffffff',
    }),
  ];

  const THEME_IDS = THEMES.map((t) => t.id);
  let settings = { ...DEFAULT_SETTINGS };

  function sanitizeSettings(raw) {
    const conc = Number(raw && raw.concurrency);
    const maxMB = Number(raw && raw.maxMB);
    const opacity = Number(raw && raw.fabOpacity);
    const theme = String((raw && raw.theme) || '');
    return {
      concurrency: Number.isFinite(conc) ? clamp(Math.round(conc), 1, 16) : DEFAULT_SETTINGS.concurrency,
      toast: !(raw && raw.toast === false),
      autoSave: !(raw && raw.autoSave === false),
      maxMB: Number.isFinite(maxMB) && maxMB >= 100 ? Math.min(Math.round(maxMB), 4096) : DEFAULT_SETTINGS.maxMB,
      theme: THEME_IDS.indexOf(theme) >= 0 ? theme : DEFAULT_SETTINGS.theme,
      fabOpacity: Number.isFinite(opacity) ? clamp(opacity, 0.2, 1) : DEFAULT_SETTINGS.fabOpacity,
    };
  }

  async function loadSettings() {
    settings = { ...DEFAULT_SETTINGS };
    let raw = null;
    let fromLocal = false;
    try {
      if (HAS_GM_STORE) raw = GM_getValue(SETTINGS_KEY, null);
      if (!raw && HAS_GM_STORE_ASYNC) {
        try {
          raw = await GM_API.getValue(SETTINGS_KEY, null);
        } catch {
          /* 读不到就走本地 */
        }
      }
      if (!raw && SITE_STORAGE) {
        raw = localStorage.getItem(SETTINGS_KEY);
        fromLocal = !!raw;
      }
      if (typeof raw === 'string' && raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') settings = sanitizeSettings(parsed);
      }
      // 首次升级：本地有配置、脚本管理器里没有 → 推一份上去，之后换站点也跟着走
      if (fromLocal && (HAS_GM_STORE || HAS_GM_STORE_ASYNC)) {
        try {
          saveSettings();
        } catch {
          /* 忽略 */
        }
      }
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    const raw = JSON.stringify(settings);
    // 三处都写：脚本管理器的存储负责跨站点，localStorage 作为本页兜底
    try {
      if (HAS_GM_STORE) GM_setValue(SETTINGS_KEY, raw);
    } catch {
      /* 忽略 */
    }
    if (!HAS_GM_STORE && HAS_GM_STORE_ASYNC) {
      try {
        Promise.resolve(GM_API.setValue(SETTINGS_KEY, raw)).catch(() => {});
      } catch {
        /* 忽略 */
      }
    }
    if (SITE_STORAGE) {
      try {
        localStorage.setItem(SETTINGS_KEY, raw);
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 主题和悬浮窗透明度都写成 CSS 变量，改完立即生效 */
  function applyLook() {
    if (!rootEl) return;
    const t = THEMES.find((x) => x.id === settings.theme) || THEMES[0];
    rootEl.dataset.theme = t.id;
    for (const key of Object.keys(t.vars)) rootEl.style.setProperty(key, t.vars[key]);
    rootEl.style.setProperty('--fab-opacity', String(clamp(Number(settings.fabOpacity) || 1, 0.2, 1)));
  }

  /* ================================================================== *
   * 5. 界面
   * ================================================================== */

  let hostEl = null;
  let shadow = null;
  let rootEl = null;
  let sheetEl = null;
  let fabEl = null;
  let open = false;
  let filter = 'all';
  let uiReady = false;

  /* ---------- 悬浮按钮：可自由拖动 ---------- */

  const FAB_SIZE = 50;
  const FAB_MARGIN = 8;
  const FAB_POS_KEY = 'tss_fab_pos';

  let fabPos = null;
  let fabDrag = null;
  let suppressFabClick = false;

  function clampFab(x, y) {
    const maxX = Math.max(FAB_MARGIN, window.innerWidth - FAB_SIZE - FAB_MARGIN);
    const maxY = Math.max(FAB_MARGIN, window.innerHeight - FAB_SIZE - FAB_MARGIN);
    return { x: clamp(Math.round(x), FAB_MARGIN, maxX), y: clamp(Math.round(y), FAB_MARGIN, maxY) };
  }

  function applyFabPos(x, y) {
    const next = clampFab(x, y);
    fabPos = next;
    if (!fabEl) return;
    fabEl.style.left = next.x + 'px';
    fabEl.style.top = next.y + 'px';
  }

  function loadFabPos() {
    try {
      let raw = null;
      if (HAS_GM_STORE) raw = GM_getValue(FAB_POS_KEY, null);
      if (!raw && SITE_STORAGE) raw = localStorage.getItem(FAB_POS_KEY);
      if (!raw) return null;
      const pos = JSON.parse(raw);
      if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) return pos;
    } catch {
      /* 忽略 */
    }
    return null;
  }

  function saveFabPos() {
    if (!fabPos) return;
    try {
      const raw = JSON.stringify(fabPos);
      if (HAS_GM_STORE) GM_setValue(FAB_POS_KEY, raw);
      else if (SITE_STORAGE) localStorage.setItem(FAB_POS_KEY, raw);
    } catch {
      /* 忽略 */
    }
  }

  function initFabPos() {
    const saved = loadFabPos();
    if (saved) {
      applyFabPos(saved.x, saved.y);
      return;
    }
    applyFabPos(window.innerWidth - FAB_SIZE - 14, window.innerHeight - FAB_SIZE - 14);
  }

  function onFabDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const rect = fabEl.getBoundingClientRect();
    fabDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top, moved: false };
    fabEl.classList.add('dragging');
    try {
      fabEl.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  }

  function onFabMove(e) {
    if (!fabDrag || e.pointerId !== fabDrag.id) return;
    const dx = e.clientX - fabDrag.sx;
    const dy = e.clientY - fabDrag.sy;
    if (!fabDrag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
    fabDrag.moved = true;
    applyFabPos(fabDrag.ox + dx, fabDrag.oy + dy);
    if (open) positionSheet();
  }

  function onFabUp(e) {
    if (!fabDrag || e.pointerId !== fabDrag.id) return;
    const moved = fabDrag.moved;
    fabDrag = null;
    fabEl.classList.remove('dragging');
    try {
      fabEl.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    if (!moved) return;
    saveFabPos();
    // 拖完这一下不要顺手把面板打开
    suppressFabClick = true;
    setTimeout(() => {
      suppressFabClick = false;
    }, 350);
  }

  /** 桌面端：把面板摆在悬浮钮旁边，跟着它走 */
  function positionSheet() {
    if (!sheetEl || !fabEl) return;
    if (window.innerWidth < 620) {
      sheetEl.style.left = '';
      sheetEl.style.top = '';
      return; // 手机端仍是底部抽屉
    }
    const rect = fabEl.getBoundingClientRect();
    const width = sheetEl.offsetWidth || 392;
    const height = Math.min(sheetEl.offsetHeight || 360, Math.round(window.innerHeight * 0.7));
    const gap = 12;

    // 悬浮钮在右半边就把面板放它左边，在左半边就放右边——总之别压住按钮，
    // 否则用户点开面板后就再也点不到那个按钮了。
    const fabCenter = rect.left + rect.width / 2;
    let left;
    if (fabCenter > window.innerWidth / 2) left = rect.left - width - gap;
    else left = rect.right + gap;
    // 两侧都放不下时，退回"贴着按钮上沿"的老办法
    if (left < 8 || left + width > window.innerWidth - 8) {
      left = clamp(rect.right - width, 8, Math.max(8, window.innerWidth - width - 8));
    }

    let top = Math.round(rect.bottom - height); // 底边跟按钮对齐，视觉上连在一起
    top = clamp(top, 8, Math.max(8, window.innerHeight - height - 8));

    sheetEl.style.left = Math.round(clamp(left, 8, Math.max(8, window.innerWidth - width - 8))) + 'px';
    sheetEl.style.top = top + 'px';
  }

  const CSS = `
:host {
  all: initial;
  --bg: #0e1320;
  --panel: #151c2b;
  --card: #1b2333;
  --card-hi: #212b3e;
  --line: #283349;
  --text: #e8edf7;
  --muted: #8b95ab;
  --faint: #61708a;
  --accent: #4f8cff;
  --accent2: #8b5cf6;
  --ok: #3ddc97;
  --warn: #ffb020;
  --danger: #ff5c7a;
  --glow: rgba(79,140,255,.6);
  --tag-bg: rgba(79,140,255,.14);
  --tag-fg: #7aa8ff;
  --tag-ts-bg: rgba(139,92,246,.16);
  --tag-ts-fg: #b79cff;
  --tag-mp4-bg: rgba(61,220,151,.14);
  --tag-mp4-fg: #4fdca8;
  --tag-img-bg: rgba(56,189,248,.14);
  --tag-img-fg: #67d1f5;
  --tag-dash-bg: rgba(255,176,32,.14);
  --tag-dash-fg: #ffb020;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  color: var(--text);
  -webkit-text-size-adjust: 100%;
}
* { box-sizing: border-box; }
.root {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  -webkit-tap-highlight-color: transparent;
  /* 主题变量挂在 .root 上，颜色必须在这里落地，否则子元素会继承页面/宿主的颜色 */
  color: var(--text);
}

/* ---------- 悬浮按钮 ---------- */
.fab {
  position: fixed;
  z-index: 3;
  left: 0; top: 0;               /* 实际位置由脚本按拖拽结果写入 */
  width: 50px; height: 50px;
  border-radius: 16px;
  background: var(--fab-bg);
  border: 1px solid var(--fab-border, transparent);
  box-shadow: 0 10px 24px -8px var(--glow), 0 2px 10px rgba(0,0,0,.28);
  display: grid; place-items: center;
  pointer-events: auto;
  cursor: grab;
  opacity: 0; transform: translateY(12px) scale(.94);
  transition: opacity .22s ease, transform .22s cubic-bezier(.2,.8,.3,1);
  touch-action: none;            /* 拖动时别让页面跟着滚 */
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.fab.dragging {
  cursor: grabbing;
  opacity: 1;
  transition: none;
}
.fab.dragging svg { transform: scale(.9); }
.fab.show { opacity: var(--fab-opacity, 1); transform: none; }
.fab:not(.show) { pointer-events: none; }
/* 还没探测到资源时也留在页面上，只是压暗——否则用户完全看不出脚本在跑 */
.fab.idle .badge { display: none; }
.fab svg { width: 24px; height: 24px; fill: var(--fab-fg); display: block; }
.fab .badge {
  position: absolute; top: -5px; right: -5px;
  min-width: 20px; height: 20px; padding: 0 5px;
  border-radius: 10px; background: var(--danger); color: #fff;
  font-size: 11px; font-weight: 800; letter-spacing: -.2px;
  display: grid; place-items: center;
  border: 2px solid var(--bg);
}
/* 上面的 display:grid 会压过 [hidden] 的 UA 样式——属性设置了但视觉不消失，就是这个坑 */
.fab .badge[hidden] { display: none; }
.fab .pulse {
  position: absolute; inset: 0; border-radius: 16px;
  box-shadow: 0 0 0 0 rgba(79,140,255,.6);
  animation: pulse .9s ease-out 1;
}
@keyframes pulse {
  from { box-shadow: 0 0 0 0 rgba(79,140,255,.55); }
  to { box-shadow: 0 0 0 16px rgba(79,140,255,0); }
}

/* ---------- 面板 ---------- */
.sheet {
  position: fixed;
  z-index: 2;
  left: 0; right: 0; bottom: 0;
  max-height: 80vh;
  display: flex; flex-direction: column;
  background: var(--panel);
  border-top: 1px solid var(--line);
  border-radius: 18px 18px 0 0;
  box-shadow: 0 -24px 60px -24px rgba(0,0,0,.75);
  pointer-events: auto;
  transform: translateY(104%);
  transition: transform .3s cubic-bezier(.2,.8,.3,1);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  overflow: hidden;
}
.sheet.open { transform: translateY(0); }
@media (min-width: 620px) {
  .sheet {
    /* 位置由脚本按悬浮按钮当前位置算出来，跟着拖动走 */
    left: 0; top: 0; right: auto; bottom: auto;
    width: 392px; max-height: 70vh;
    border-radius: 16px; border: 1px solid var(--line);
  }
}
.head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--line);
}
.logo {
  width: 32px; height: 32px; flex: none;
  border-radius: 10px;
  background: linear-gradient(140deg, var(--accent), var(--accent2));
  display: grid; place-items: center;
  font-size: 11px; font-weight: 800; color: #fff; letter-spacing: -.3px;
}
.head { touch-action: none; cursor: grab; }
.head-main { min-width: 0; flex: 1; }
.sheet.dragging { transition: none; }
.sheet.dragging .head { cursor: grabbing; }
/* 下拉时标题淡出、提示淡入，正文跟着变淡——拖多少变多少，实时反馈 */
.sheet.dragging .head-main { opacity: calc(1 - var(--pull, 0)); }
.sheet .body, .sheet .tabs { opacity: calc(1 - (var(--pull, 0) * .35)); }
.sheet:not(.dragging) .body, .sheet:not(.dragging) .tabs { transition: opacity .18s; }
.pull-hint {
  position: absolute;
  top: 12px; left: 0; right: 0;
  text-align: center;
  font-size: 12px; font-weight: 500;
  color: var(--muted);
  opacity: 0;
  pointer-events: none;
  z-index: 5;
}
.sheet.dragging .pull-hint { opacity: var(--pull, 0); }
.pull-hint.ready { color: var(--accent); font-weight: 600; }
.sheet.dragging .pull-hint.ready { opacity: 1; }
.head-t1 { font-size: 14px; font-weight: 700; letter-spacing: -.2px; }
.head-t2 {
  font-size: 11.5px; color: var(--muted); margin-top: 1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.icon-btn {
  all: unset;
  box-sizing: border-box;
  width: 30px; height: 30px; flex: none;
  display: grid; place-items: center;
  border-radius: 9px; color: var(--muted);
  font-size: 15px; cursor: pointer;
  touch-action: manipulation;
}
.icon-btn:active { background: var(--card-hi); }

.tabs {
  display: flex; gap: 6px; align-items: center;
  /* flex: none + 固定 padding：列表排满时不许把这栏挤扁，上下间距恒定 */
  flex: none;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar { display: none; }
.tab {
  all: unset;
  box-sizing: border-box;
  padding: 5px 11px; border-radius: 999px;
  font-size: 12px; font-weight: 600; color: var(--muted);
  background: var(--card); border: 1px solid var(--line);
  white-space: nowrap; cursor: pointer;
  touch-action: manipulation;
}
.tab.on { color: #fff; background: linear-gradient(140deg, var(--accent), var(--accent2)); border-color: transparent; }
.tabs .spacer { flex: 1; }
.gear {
  all: unset;
  box-sizing: border-box;
  width: 30px; height: 30px; flex: none;
  border-radius: 9px;
  background: linear-gradient(140deg, var(--accent), var(--accent2));
  display: grid; place-items: center;
  cursor: pointer;
  touch-action: manipulation;
}
.gear svg { width: 16px; height: 16px; fill: #fff; display: block; }
.gear:active { opacity: .8; }

.body {
  flex: 1; min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  padding: 10px 12px 14px;
}
.empty {
  padding: 26px 14px 30px;
  text-align: center; color: var(--faint); font-size: 12.5px; line-height: 1.7;
}
.empty b { color: var(--muted); font-weight: 600; }

/* ---------- 资源行 ---------- */
.row {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 11px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 13px;
  margin-bottom: 8px;
}
.row-main { min-width: 0; flex: 1; }
.row-top { display: flex; align-items: center; gap: 7px; }
.row.on { border-color: var(--accent); }
.thumb {
  flex: none;
  width: 46px; height: 46px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--card-hi);
  border: 1px solid var(--line);
  display: flex; align-items: center; justify-content: center;
}
.thumb-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb-ic { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
.thumb-ic svg { width: 17px; height: 17px; fill: var(--faint); }
.live {
  flex: none;
  padding: 1px 6px; border-radius: 5px;
  font-size: 9.5px; font-weight: 800; letter-spacing: .2px;
  background: var(--tag-mp4-bg); color: var(--tag-mp4-fg);
}
.tag {
  flex: none;
  padding: 1px 6px; border-radius: 5px;
  font-size: 9.5px; font-weight: 800; letter-spacing: .2px;
  background: var(--tag-bg); color: var(--tag-fg);
}
.tag.ts { background: var(--tag-ts-bg); color: var(--tag-ts-fg); }
.tag.mp4 { background: var(--tag-mp4-bg); color: var(--tag-mp4-fg); }
.tag.img { background: var(--tag-img-bg); color: var(--tag-img-fg); }
.tag.dash { background: var(--tag-dash-bg); color: var(--tag-dash-fg); }
.row-name {
  font-size: 13px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row-sub {
  margin-top: 2px;
  font-size: 11px; color: var(--faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row-actions { display: flex; gap: 6px; flex: none; }
.btn {
  all: unset;
  box-sizing: border-box;
  padding: 6px 11px; border-radius: 9px;
  font-size: 12px; font-weight: 600;
  text-align: center; cursor: pointer;
  background: var(--card-hi); color: var(--text);
  border: 1px solid var(--line);
  white-space: nowrap;
  touch-action: manipulation;
}
.btn:active { opacity: .72; }
.btn.primary {
  color: #fff; border-color: transparent;
  background: linear-gradient(140deg, var(--accent), var(--accent2));
}
.btn.ghost { background: none; color: var(--muted); }
.btn.block {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  width: 100%; padding: 11px 13px; font-size: 13px; border-radius: 11px;
}
.btn.block em { font-style: normal; font-size: 11px; color: var(--faint); font-weight: 500; }
.btn.primary em { color: rgba(255,255,255,.74); }
.btn.danger { color: var(--danger); }

/* ---------- 任务 ---------- */
.job {
  padding: 11px 12px; margin-bottom: 9px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 13px;
}
.job-head { display: flex; align-items: center; gap: 8px; }
.job-title {
  flex: 1; min-width: 0;
  font-size: 13px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.job-pct { font-size: 12px; font-weight: 700; color: var(--accent); flex: none; }
.job-x { width: 22px; height: 22px; font-size: 12px; }
.bar {
  height: 5px; margin: 8px 0 6px;
  border-radius: 3px; background: var(--card-hi);
  overflow: hidden;
}
.bar i {
  display: block; height: 100%; width: 0;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--accent), var(--accent2));
  transition: width .25s ease;
}
.bar.done i { background: var(--ok); }
.job-sub { font-size: 11px; color: var(--faint); display: flex; gap: 8px; flex-wrap: wrap; }
.job-msg { font-size: 11.5px; color: var(--muted); margin-top: 5px; line-height: 1.5; }
.job-msg.err { color: var(--danger); }
.job-msg.ok { color: var(--ok); }
.job-actions { display: flex; gap: 6px; margin-top: 9px; flex-wrap: wrap; }

/* ---------- 弹层 ---------- */
.mask {
  position: fixed; inset: 0; z-index: 5;
  background: rgba(6,9,16,.55);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
  display: flex; align-items: flex-end; justify-content: center;
  pointer-events: auto;
  opacity: 0; transition: opacity .2s ease;
}
.mask.show { opacity: 1; }
@media (min-width: 620px) { .mask { align-items: center; } }
.modal {
  width: 100%; max-width: 420px;
  max-height: 82vh; overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  background: var(--panel);
  border-radius: 18px 18px 0 0;
  border-top: 1px solid var(--line);
  padding: 14px 14px calc(14px + env(safe-area-inset-bottom, 0px));
  transform: translateY(20px);
  transition: transform .24s cubic-bezier(.2,.8,.3,1);
}
.mask.show .modal { transform: none; }
@media (min-width: 620px) {
  .modal { border-radius: 16px; border: 1px solid var(--line); max-width: 400px; }
}
.modal-title {
  font-size: 14.5px; font-weight: 700;
  margin: -6px -6px 0;
  padding: 6px 6px 4px;
}
/* 整张卡片都能起手：光标与滚动手感跟着改，标题不再独占 */
.modal { cursor: grab; overscroll-behavior: contain; }
.modal.dragging { transition: none; cursor: grabbing; }
.modal.dragging .modal-title { cursor: grabbing; }
.modal.dragging .modal-body,
.modal.dragging .modal-sub { opacity: calc(1 - (var(--pull, 0) * .45)); }
.modal-sub { font-size: 11.5px; color: var(--muted); margin-top: 3px; line-height: 1.55; white-space: pre-line; }
.modal-input {
  box-sizing: border-box;
  width: 100%;
  margin-top: 10px;
  padding: 10px 11px;
  font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text);
  background: var(--card-hi);
  border: 1px solid var(--line);
  border-radius: 10px;
  outline: none;
  -webkit-appearance: none;
}
.modal-input:focus { border-color: var(--accent); }
.modal-body { margin: 12px 0 10px; display: flex; flex-direction: column; gap: 10px; }

/* ---------- 设置面板 ---------- */
.set-group { display: flex; flex-direction: column; gap: 7px; }
.set-label {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11.5px; font-weight: 600; color: var(--muted); letter-spacing: .2px;
}
.set-val { color: var(--faint); font-weight: 500; font-variant-numeric: tabular-nums; }
.swatches { display: flex; flex-wrap: wrap; gap: 7px; }
.swatch {
  all: unset;
  box-sizing: border-box;
  flex: 0 0 calc(20% - 6px);
  min-width: 0;
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  padding: 8px 2px 6px;
  border-radius: 11px;
  border: 1px solid var(--line);
  background: var(--card);
  cursor: pointer;
  touch-action: manipulation;
}
.swatch i {
  width: 22px; height: 22px; border-radius: 50%;
  border: 1px solid var(--line);
  box-shadow: 0 1px 4px rgba(0,0,0,.28);
}
.swatch span { font-size: 10.5px; color: var(--muted); font-weight: 600; }
.swatch.on { border-color: var(--accent); background: var(--card-hi); }
.swatch.on span { color: var(--text); }
.swatch:active { opacity: .75; }
.range {
  -webkit-appearance: none;
  appearance: none;
  box-sizing: border-box;
  width: 100%; height: 26px; margin: 0;
  background: transparent;
  touch-action: manipulation;
}
.range::-webkit-slider-runnable-track {
  height: 6px; border-radius: 3px;
  background: var(--card-hi);
  border: 1px solid var(--line);
}
.range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px; height: 18px;
  margin-top: -7px;
  border-radius: 50%;
  background: linear-gradient(140deg, var(--accent), var(--accent2));
  border: 2px solid var(--panel);
  box-shadow: 0 2px 6px rgba(0,0,0,.35);
}
.range::-moz-range-track { height: 6px; border-radius: 3px; background: var(--card-hi); border: 1px solid var(--line); }
.range::-moz-range-thumb {
  width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--panel);
  background: var(--accent);
}

/* ---------- 提示气泡 ---------- */
.toast {
  position: fixed;
  z-index: 4;
  right: calc(14px + env(safe-area-inset-right, 0px));
  bottom: calc(74px + env(safe-area-inset-bottom, 0px));
  max-width: 260px;
  padding: 9px 12px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  box-shadow: 0 14px 36px -14px rgba(0,0,0,.7);
  font-size: 12px; line-height: 1.5;
  color: var(--text);
  pointer-events: auto;
  opacity: 0; transform: translateY(8px);
  transition: opacity .22s ease, transform .22s ease;
}
.toast.show { opacity: 1; transform: none; }
/* 面板展开时气泡挪到顶部，否则会盖住列表 */
.toast.top {
  top: calc(12px + env(safe-area-inset-top, 0px));
  bottom: auto;
}
.toast b { color: var(--accent); }
`;

  const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24"><path d="M12 3a1 1 0 0 1 1 1v9.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4L11 13.6V4a1 1 0 0 1 1-1Zm-7 15a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v1.5A1.5 1.5 0 0 1 18.5 22h-13A1.5 1.5 0 0 1 4 20.5V19a1 1 0 0 1 1-1Z"/></svg>';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function fmtSpeed(bps) {
    return `${fmtBytes(bps)}/s`;
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  const KIND_META = {
    m3u8: { badge: 'M3U8', cls: '', action: '解析下载' },
    ts: { badge: 'TS', cls: 'ts', action: '合并下载' },
    m4s: { badge: 'M4S', cls: 'ts', action: '合并下载' },
    mp4: { badge: 'MP4', cls: 'mp4', action: '下载' },
    mpd: { badge: 'DASH', cls: 'dash', action: '复制' },
    audio: { badge: 'AUDIO', cls: 'mp4', action: '下载' },
    video: { badge: 'VIDEO', cls: 'mp4', action: '下载' },
    image: { badge: 'IMG', cls: 'img', action: '保存' },
  };

  /**
   * 拆掉本实例：断开探测、清定时器、移除宿主节点。
   * 重新运行脚本（更新版本、或管理器重复注入）时，新实例会先调它，
   * 否则旧宿主还挂在 DOM 上，新实例直接 return——表现就是"第二次不运行"。
   */
  function teardown() {
    try {
      suspendSniffing();
    } catch {
      /* 忽略 */
    }
    // 自己的 window 监听与上报定时器必须摘掉，否则会干扰下一个实例
    while (frameCleanup.length) {
      try {
        frameCleanup.pop()();
      } catch {
        /* 忽略 */
      }
    }
    frameBridgeReady = false;
    // 看门狗也要停：否则被拆掉的实例还会每 2 秒醒一次（虽然会被 superseded 挡住）
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = 0;
    }
    uiReady = false;
    try {
      if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    } catch {
      /* 忽略 */
    }
    hostEl = null;
  }

  function mountUI() {
    if (uiReady) return;
    if (superseded()) return; // 被新实例取代：不许再挂界面
    if (!SHOULD_MOUNT || forceChild) return; // 确定是内嵌页才不挂，证据不足先挂上
    if (!TOP_CERTAIN && Date.now() < mountHoldUntil) return; // 冷静期：等握手纠正角色
    const stale = document.getElementById(HOST_ID);
    if (stale && Number(stale.dataset.gen || 0) > GEN) {
      // 已经有更新的实例接管了界面，本实例安静退出即可
      uiReady = false;
      return;
    }
    if (stale) {
      // 旧实例可能是上一个版本注入的：能拆就拆，拆不掉也要把宿主摘掉，
      // 绝不能因为"已经有一个宿主"就让新实例原地退出
      try {
        if (typeof window.__mediaSnifferTeardown === 'function') window.__mediaSnifferTeardown();
      } catch {
        /* 忽略 */
      }
      try {
        stale.remove();
      } catch {
        /* 忽略 */
      }
      shadow = null;
      hostEl = null;
    }

    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.dataset.gen = String(GEN);
    hostEl.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0;';
    shadow = hostEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;

    rootEl = document.createElement('div');
    rootEl.className = 'root';
    rootEl.innerHTML = `
      <button class="fab" type="button" aria-label="打开 Media Sniffer" title="Media Sniffer v${VERSION} · 可拖动">
        ${ICON_DOWNLOAD}
        <span class="badge" hidden>0</span>
      </button>
      <div class="sheet">
        <div class="head">
          <div class="logo">MS</div>
          <div class="head-main">
            <div class="head-t1">Media Sniffer</div>
            <div class="head-t2"></div>
          </div>
          <button class="icon-btn" data-act="close" type="button" aria-label="关闭">✕</button>
        </div>
        <div class="tabs">
          <button class="tab on" data-filter="all" type="button">全部</button>
          <button class="tab" data-filter="video" type="button">视频</button>
          <button class="tab" data-filter="img" type="button">图片</button>
          <button class="tab" data-filter="audio" type="button">音频</button>
          <span class="spacer"></span>
          <button class="gear" data-act="refresh" type="button" aria-label="刷新" title="刷新列表">
            <svg viewBox="0 0 24 24"><path d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08a6 6 0 1 1-1.41-6.24L13 11h7V4l-2.35 2.35z"/></svg>
          </button>
          <button class="gear" data-act="settings" type="button" aria-label="设置" title="设置">
            <svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
          </button>
        </div>
        <div class="body"></div>
      </div>
      <div class="toast"></div>
    `;
    shadow.append(style, rootEl);
    applyLook();

    try {
      // 只用这一个名字作为登记入口（旧名字保留写入，兼容上一版调用方）
      exposeGlobal('__tsSnifferTeardown', teardown);
      exposeGlobal('__mediaSnifferTeardown', teardown);
    } catch {
      /* 忽略 */
    }

    fabEl = rootEl.querySelector('.fab');
    sheetEl = rootEl.querySelector('.sheet');

    fabEl.addEventListener('pointerdown', onFabDown);
    fabEl.addEventListener('pointermove', onFabMove);
    fabEl.addEventListener('pointerup', onFabUp);
    fabEl.addEventListener('pointercancel', onFabUp);
    fabEl.addEventListener('click', (e) => {
      if (suppressFabClick) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      setOpen(!open);
    });

    initFabPos();
    window.addEventListener('resize', () => {
      if (fabPos) applyFabPos(fabPos.x, fabPos.y);
      if (open) positionSheet();
    });

    rootEl.querySelector('[data-act="close"]').addEventListener('click', () => setOpen(false));
    installPullToClose();

    rootEl.querySelectorAll('.tab[data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        filter = btn.dataset.filter;
        rootEl.querySelectorAll('.tab[data-filter]').forEach((b) => b.classList.toggle('on', b === btn));
        renderBody();
      });
    });

    rootEl.querySelector('[data-act="settings"]').addEventListener('click', showSettings);
    rootEl.querySelector('[data-act="refresh"]').addEventListener('click', refreshMedia);

    // 事件委托：列表里的按钮
    rootEl.querySelector('.body').addEventListener('click', onBodyClick);

    (document.documentElement || document.body).appendChild(hostEl);
    uiReady = true;
    mountRetry = 0; // 挂上了就恢复重试预算，后续再被摘掉还有 60 次机会
    render();
  }

  function onBodyClick(e) {
    const btn = e.target.closest && e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const row = btn.closest('.row');
    const jobCard = btn.closest('.job');

    if (act === 'clear') {
      store.clear();
      remoteItems.clear();
      countedSegments.clear();
      revision += 1;
      render();
      return;
    }
    if (act === 'settings') {
      showSettings();
      return;
    }
    if (act === 'cancel' && jobCard) {
      const job = jobs.find((j) => j.id === jobCard.dataset.job);
      if (job) cancelJob(job);
      return;
    }
    if (act === 'dismiss' && jobCard) {
      removeJob(jobCard.dataset.job);
      return;
    }
    if (act === 'save' && jobCard) {
      const job = jobs.find((j) => j.id === jobCard.dataset.job);
      if (job) saveJob(job, { gesture: true }).catch((err) => toast(err.message || '保存失败'));
      return;
    }
    if (act === 'share' && jobCard) {
      const job = jobs.find((j) => j.id === jobCard.dataset.job);
      if (job) shareJob(job);
      return;
    }
    if (act === 'copyurl' && jobCard) {
      const job = jobs.find((j) => j.id === jobCard.dataset.job);
      if (job && job.item) copyText(job.item.url || '');
      return;
    }
    if (act === 'key' && jobCard) {
      const job = jobs.find((j) => j.id === jobCard.dataset.job);
      if (job) showKeyModal(job);
      return;
    }
    if (act === 'open' && jobCard) {
      const job = jobs.find((j) => j.id === jobCard.dataset.job);
      if (job) openJob(job);
      return;
    }
    if (!row) return;

    const item = store.get(row.dataset.id) || remoteItems.get(row.dataset.id);
    if (!item) return;
    if (act === 'download') {
      Promise.resolve(item.remote ? startRemoteDownload(item) : startItem(item)).catch((err) =>
        toast(err.message || '操作失败')
      );
    } else if (act === 'more') {
      showItemActions(item);
    }
  }

  /**
   * 头部卡片（Media Sniffer · 域名那一块）按住下滑 = 快捷收起面板。
   * 面板实时跟手（带阻尼），拖过阈值松手就整页收起，否则弹回。
   * 只认竖直方向：横向滑动不打扰；从右上角 ✕ 按钮起手的拖动不参与。
   */
  function installPullToClose() {
    if (!sheetEl) return;
    const head = sheetEl.querySelector('.head');
    if (!head) return;

    const THRESHOLD = 90;
    const hint = document.createElement('div');
    hint.className = 'pull-hint';
    hint.textContent = '下拉关闭';
    sheetEl.prepend(hint);

    let pid = -1;
    let startY = 0;
    let startX = 0;
    let armed = false;
    let dragging = false;

    const reset = () => {
      pid = -1;
      armed = false;
      dragging = false;
      sheetEl.classList.remove('dragging');
      sheetEl.style.transform = '';
      sheetEl.style.setProperty('--pull', '0');
      hint.classList.remove('ready');
      hint.textContent = '下拉关闭';
    };

    head.addEventListener('pointerdown', (e) => {
      if (!open || modalEl) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest && e.target.closest('[data-act]')) return;
      armed = true;
      pid = e.pointerId;
      startY = e.clientY;
      startX = e.clientX;
    });

    document.addEventListener('pointermove', (e) => {
      if (!armed || e.pointerId !== pid) return;
      const dy = e.clientY - startY;
      const dx = e.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy)) {
          reset(); // 横向滑动，不是下拉
          return;
        }
        if (dy > 10) {
          dragging = true;
          sheetEl.classList.add('dragging');
        } else {
          return;
        }
      }
      // 阻尼：拖得越远越沉，面板不会一甩就飞出屏幕
      const raw = Math.max(0, dy);
      const eased = raw > 140 ? 140 + (raw - 140) * 0.35 : raw;
      const p = Math.min(1, eased / THRESHOLD);
      sheetEl.style.transform = `translateY(${Math.round(eased)}px)`;
      sheetEl.style.setProperty('--pull', String(p));
      hint.textContent = p >= 1 ? '松开关闭' : '下拉关闭';
      hint.classList.toggle('ready', p >= 1);
    });

    const finish = (e) => {
      if (!armed || (e && e.pointerId !== pid)) return;
      const m = /translateY\((\d+(?:\.\d+)?)px\)/.exec(sheetEl.style.transform || '');
      const eased = m ? Number(m[1]) : 0;
      if (dragging && eased >= THRESHOLD) {
        armed = false;
        dragging = false;
        sheetEl.classList.remove('dragging'); // 恢复过渡，让收起有动画
        sheetEl.style.transform = 'translateY(104%)';
        hint.classList.remove('ready');
        setTimeout(() => {
          setOpen(false);
          sheetEl.style.transform = '';
          sheetEl.style.setProperty('--pull', '0');
          hint.textContent = '下拉关闭';
        }, 300);
        pid = -1;
      } else {
        reset();
      }
    };

    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }

  function setOpen(next) {
    open = next;
    if (!sheetEl) return;
    if (open) {
      // 顺序很重要：先填内容再量高度，否则按空面板的高度算位置，会跑到屏幕外
      renderBody();
      positionSheet();
      sheetEl.classList.add('open');
      requestAnimationFrame(positionSheet);
    } else {
      sheetEl.classList.remove('open');
    }
  }

  function render() {
    if (!uiReady) return;

    const count = allItems().length;
    const badge = fabEl.querySelector('.badge');
    fabEl.classList.add('show');
    fabEl.classList.toggle('idle', count === 0);
    // 「探测提示」关掉后，toast 和角标一起消失（角标立即生效，不等下次渲染）
    if (count > 0 && settings.toast) {
      badge.hidden = false;
      badge.textContent = count > 99 ? '99+' : String(count);
    } else {
      badge.hidden = true;
    }

    const sub = rootEl.querySelector('.head-t2');
    if (sub) {
      sub.textContent = location.hostname + (IS_TOP ? '' : ' · 内嵌页');
    }

    if (open) renderBody();
  }

  function matchesFilter(item) {
    if (filter === 'all') return true;
    // 「视频」= 播放列表 + 分片 + 直链视频（mp4/webm/mov…），mpd 也算视频
    if (filter === 'video') {
      return (
        item.kind === 'm3u8' ||
        item.kind === 'ts' ||
        item.kind === 'm4s' ||
        item.kind === 'mp4' ||
        item.kind === 'video' ||
        item.kind === 'mpd'
      );
    }
    if (filter === 'img') return item.kind === 'image';
    if (filter === 'audio') return item.kind === 'audio';
    return true;
  }

  let bodySections = null;

  function ensureBodySections(body) {
    if (bodySections && bodySections.jobs.isConnected) return bodySections;
    body.innerHTML = '<div class="jobs"></div><div class="list"></div><div class="tail"></div>';
    bodySections = {
      jobs: body.querySelector('.jobs'),
      list: body.querySelector('.list'),
      tail: body.querySelector('.tail'),
    };
    return bodySections;
  }

  function renderBody() {
    if (!uiReady) return;
    const body = rootEl.querySelector('.body');
    const scrollTop = body.scrollTop;

    // 正在播放的置顶；其余按发现时间倒序
    const isLive = (it) => it.active || it.id === activeMediaId;
    const items = allItems()
      .filter(matchesFilter)
      .sort((a, b) => (isLive(a) ? -1 : isLive(b) ? 1 : 0) || b.firstSeen - a.firstSeen);

    const sec = ensureBodySections(body);
    // 任务卡没有缩略图，全量重建没成本
    sec.jobs.innerHTML = renderJobs();
    // 行必须键控复用：缩略图是真实的 <img>/<video>，整表重刷会反复重新请求
    syncRows(sec.list, items);
    sec.tail.innerHTML = items.length
      ? `<div style="text-align:center;margin-top:6px"><button class="btn ghost" data-act="clear" type="button">清空列表</button></div>`
      : '<div class="empty">还没有探测到媒体资源</div>';

    body.scrollTop = scrollTop;
  }

  function rowBits(item) {
    const grouped = item.kind === 'ts' || item.kind === 'm4s';
    const bits = [item.host];
    if (grouped && item.count > 1) bits.push(`${item.count} 片`);
    if (item.size) bits.push(fmtBytes(item.size));
    if (item.remote) bits.push('内嵌页');
    if (item.truncated) bits.push('已达记录上限');
    return bits;
  }

  /** 缩略图内容：图片直接用原地址，直链视频用 #t=0.1 取首帧，流式类型用图标 */
  function thumbHtml(item) {
    if (item.kind === 'image') {
      return `<img class="thumb-img" src="${esc(item.url)}" alt="" loading="lazy" decoding="async">`;
    }
    if (item.kind === 'mp4' || item.kind === 'video') {
      // media fragment：浏览器会解到该时间点，把这帧显示出来当预览
      return `<video class="thumb-img" src="${esc(item.url)}#t=0.1" preload="metadata" muted playsinline></video>`;
    }
    return `<div class="thumb-ic">${thumbIcon(item.kind)}</div>`;
  }

  function thumbIcon(kind) {
    if (kind === 'audio')
      return '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
    if (kind === 'm3u8' || kind === 'mpd')
      return '<svg viewBox="0 0 24 24"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z"/></svg>';
    return '<svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v10h14V7H5zm2 2h6v2H7V9zm0 4h6v2H7v-2zm8-4h2v2h-2V9zm0 4h2v2h-2v-2z"/></svg>';
  }

  /** 缩略图拿不到（防盗链 / 网络慢）就退回图标，别留一个空格子 */
  function wireThumb(node, item) {
    const media = node.querySelector('.thumb-img');
    if (!media) return;
    media.setAttribute('data-tss-thumb', '1');
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      const box = node.querySelector('.thumb');
      if (box) box.innerHTML = `<div class="thumb-ic">${thumbIcon(item.kind)}</div>`;
    };
    media.addEventListener('error', fail);
    if (media.tagName === 'VIDEO') {
      media.addEventListener('loadeddata', () => {
        settled = true;
      });
      setTimeout(fail, 5000);
    }
  }

  function renderRow(item) {
    const meta = KIND_META[item.kind] || { badge: '?', cls: '', action: '下载' };
    const active = item.id === activeMediaId;
    const primary = item.kind === 'mpd' ? '复制' : meta.action;

    return `
      <div class="row${active ? ' on' : ''}" data-id="${esc(item.id)}">
        <div class="thumb">${thumbHtml(item)}</div>
        <div class="row-main">
          <div class="row-top">
            <span class="tag ${meta.cls}">${meta.badge}</span>
            <span class="row-name">${esc(item.name)}</span>
            <span class="live" ${active ? '' : 'hidden'}>▶ 播放中</span>
          </div>
          <div class="row-sub">${esc(rowBits(item).join(' · '))}</div>
        </div>
        <div class="row-actions">
          <button class="btn primary" data-act="download" type="button">${primary}</button>
          <button class="btn ghost" data-act="more" type="button" aria-label="更多">⋯</button>
        </div>
      </div>`;
  }

  function buildRowNode(item) {
    const tpl = document.createElement('div');
    tpl.innerHTML = renderRow(item);
    const node = tpl.firstElementChild;
    wireThumb(node, item);
    return node;
  }

  /** 已有行只更新文字与「播放中」状态，缩略图 DOM 原地不动 */
  function updateRowNode(node, item) {
    node.classList.toggle('on', item.id === activeMediaId);
    const live = node.querySelector('.live');
    if (live) live.hidden = item.id !== activeMediaId;
    const nameEl = node.querySelector('.row-name');
    if (nameEl && nameEl.textContent !== item.name) nameEl.textContent = item.name;
    const subEl = node.querySelector('.row-sub');
    const text = rowBits(item).join(' · ');
    if (subEl && subEl.textContent !== text) subEl.textContent = text;
  }

  function syncRows(listEl, items) {
    const existing = new Map();
    for (const node of Array.from(listEl.children)) existing.set(node.dataset.id, node);

    const seen = new Set();
    const frag = document.createDocumentFragment();
    for (const item of items) {
      seen.add(item.id);
      let node = existing.get(item.id);
      if (node) {
        updateRowNode(node, item);
        // append 到 frag 是「移动」不是「销毁」：已有节点的缩略图不会重新请求
        frag.append(node);
      } else {
        frag.append(buildRowNode(item));
      }
    }
    for (const [id, node] of existing) if (!seen.has(id)) node.remove();
    listEl.append(frag);
  }

  function renderJobs() {
    if (!jobs.length) return '';
    // 跟着页签走：视频/图片/音频各自只显示本类任务，类内仍是最新在最上
    return jobs
      .filter((job) => matchesFilter(job.item))
      .slice()
      .reverse()
      .map((job) => {
        const pct = job.status === 'done' ? 100 : Math.round((job.percent || 0) * 100);
        const running = job.status === 'running';
        const bits = [];
        if (job.total) bits.push(`${job.done}/${job.total} 片`);
        if (job.bytes) bits.push(fmtBytes(job.bytes));
        if (running && job.speed) bits.push(fmtSpeed(job.speed));
        if (running && job.eta) bits.push('剩余 ' + fmtDuration(job.eta));

        let msgCls = '';
        if (job.status === 'error') msgCls = 'err';
        if (job.status === 'done') msgCls = 'ok';

        const actions = [];
        if (running && !job.remote) actions.push('<button class="btn" data-act="cancel" type="button">取消</button>');
        if (job.status === 'done' && job.objectUrl) {
          actions.push('<button class="btn primary" data-act="save" type="button">保存文件</button>');
          actions.push('<button class="btn" data-act="open" type="button">新标签打开</button>');
        }
        if (job.status === 'error' && job.copyHint) {
          actions.push('<button class="btn primary" data-act="copyurl" type="button">复制直链</button>');
        }
        if (job.status === 'error' && job.encrypted) {
          actions.push('<button class="btn primary" data-act="key" type="button">输入密钥解密</button>');
        }

        return `
          <div class="job" data-job="${esc(job.id)}">
            <div class="job-head">
              <div class="job-title">${esc(job.filename || job.title || '视频')}</div>
              <div class="job-pct">${pct}%</div>
              ${
                running
                  ? ''
                  : '<button class="icon-btn job-x" data-act="dismiss" type="button" aria-label="移除">✕</button>'
              }
            </div>
            <div class="bar ${job.status === 'done' ? 'done' : ''}"><i style="width:${pct}%"></i></div>
            <div class="job-sub">${esc(bits.join(' · '))}</div>
            ${job.message ? `<div class="job-msg ${msgCls}">${esc(job.message)}</div>` : ''}
            ${actions.length ? `<div class="job-actions">${actions.join('')}</div>` : ''}
          </div>`;
      })
      .join('');
  }

  /* ------------------------------ 弹层实现 ------------------------------ */

  let modalEl = null;

  function closeModal() {
    if (!modalEl) return;
    const node = modalEl;
    modalEl = null;
    node.classList.remove('show');
    setTimeout(() => node.remove(), 220);
  }

  function showModal(cfg) {
    closeModal();
    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${esc(cfg.title || '')}</div>
        ${cfg.subtitle ? `<div class="modal-sub">${esc(cfg.subtitle)}</div>` : ''}
        ${
          cfg.input
            ? `<input class="modal-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(
                cfg.input.placeholder || ''
              )}" value="${esc(cfg.input.value || '')}">`
            : ''
        }
        <div class="modal-body"></div>
        ${cfg.hideCancel ? '' : '<button class="btn block ghost" data-close type="button"><span>取消</span></button>'}
      </div>`;
    modalEl = mask;

    const body = mask.querySelector('.modal-body');
    const inputEl = mask.querySelector('.modal-input');
    const cancel = mask.querySelector('[data-close]');
    if (cancel) cancel.addEventListener('click', closeModal);
    mask.addEventListener('click', (e) => {
      if (e.target === mask) closeModal();
    });

    const paint = (actions) => {
      if (modalEl !== mask) return;
      body.innerHTML = '';
      for (const a of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn block' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '');
        btn.innerHTML = `<span>${esc(a.label)}</span>${a.hint ? `<em>${esc(a.hint)}</em>` : ''}`;
        btn.addEventListener('click', () => {
          const value = inputEl ? inputEl.value.trim() : undefined;
          closeModal();
          try {
            const ret = a.onClick && a.onClick(value);
            if (ret && ret.catch) ret.catch((err) => toast(err.message || '操作失败'));
          } catch (err) {
            toast(err.message || '操作失败');
          }
        });
        body.appendChild(btn);
      }
    };

    if (typeof cfg.render === 'function') {
      try {
        cfg.render(body, { close: closeModal });
      } catch (err) {
        body.innerHTML = `<div class="job-msg err">${esc(err.message || '设置面板渲染失败')}</div>`;
      }
    } else if (Array.isArray(cfg.actions)) {
      paint(cfg.actions);
    } else {
      body.innerHTML = '<div class="job-msg">正在读取播放列表…</div>';
      Promise.resolve(cfg.actions)
        .then((actions) => paint(actions || []))
        .catch((err) => {
          if (modalEl !== mask) return;
          body.innerHTML = `<div class="job-msg err">${esc(err.message || '读取失败')}</div>`;
        });
    }

    rootEl.appendChild(mask);
    installModalPullToClose(mask);
    requestAnimationFrame(() => mask.classList.add('show'));
  }

  /**
   * 设置弹窗顶部（标题行整行）按住下滑 = 快捷关闭，手势与主面板一致：
   * 实时跟手带阻尼，过阈值松手关闭，否则弹回。
   */
  /**
   * 设置卡片的下拉关闭。
   *
   * 手势从"整张卡片任意位置"都能起手——之前只绑在标题行上，手指落在设置项之间
   * 就没反应。两点约束保证不影响正常操作：
   *   · 落在输入控件（不透明度滑杆）上不起手，滑杆自己要用拖拽
   *   · 内容还能往上滚时（scrollTop > 0），下滑是滚动，不接管
   * 监听挂在卡片自己身上并配合 setPointerCapture：卡片被移除时监听随之回收，
   * 不会像以前那样每开一次设置就往 document 上叠三个永远不摘的监听。
   */
  function installModalPullToClose(mask) {
    const modal = mask.querySelector('.modal');
    if (!modal) return;

    const THRESHOLD = 90;
    let pid = -1;
    let startY = 0;
    let startX = 0;
    let armed = false;
    let dragging = false;

    const reset = () => {
      pid = -1;
      armed = false;
      dragging = false;
      modal.classList.remove('dragging');
      modal.style.transform = '';
      modal.style.setProperty('--pull', '0');
    };

    const onControl = (el) =>
      !!(el && el.closest && el.closest('input, textarea, select, [contenteditable="true"]'));

    // 页面自己的 CSS（例如 body { touch-action: pan-y }）或触摸监听会让浏览器
    // 接管竖向手势——我们的下拉还没开始就收到 pointercancel。这正是
    // "同一个手势，有的网页能关弹窗、有的不能"的原因。
    // 对策：在弹窗顶部时拦下向下的 touchmove，浏览器就抢不走；
    // 向上（要看下面的设置项）仍让给原生滚动，弹窗内容照样能滚。
    modal.addEventListener(
      'touchmove',
      (e) => {
        if (!armed || e.touches.length !== 1) return;
        if (dragging) {
          if (e.cancelable) e.preventDefault();
          return;
        }
        if (modal.scrollTop <= 0 && e.touches[0].clientY > startY + 6 && e.cancelable) {
          e.preventDefault();
        }
      },
      { passive: false }
    );

    modal.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (onControl(e.target)) return;
        // 还有内容可上滚时，下滑是滚动，不抢
        if (modal.scrollTop > 0) return;
        armed = true;
        pid = e.pointerId;
        startY = e.clientY;
        startX = e.clientX;
        try {
          modal.setPointerCapture(e.pointerId);
        } catch {
          /* 老浏览器不支持指针捕获，靠事件冒泡也能用 */
        }
      },
      { passive: true }
    );

    modal.addEventListener(
      'pointermove',
      (e) => {
        if (!armed || e.pointerId !== pid) return;
        const dy = e.clientY - startY;
        const dx = e.clientX - startX;
        if (!dragging) {
          if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy)) {
            reset(); // 横向滑动，不是下拉
            return;
          }
          if (dy > 10) {
            dragging = true;
            modal.classList.add('dragging');
          } else {
            return;
          }
        }
        // 接管后别再让页面/卡片跟着滚
        if (e.cancelable) e.preventDefault();
        // 阻尼：拖得越远越沉
        const raw = Math.max(0, dy);
        const eased = raw > 140 ? 140 + (raw - 140) * 0.35 : raw;
        const p = Math.min(1, eased / THRESHOLD);
        modal.style.transform = `translateY(${Math.round(eased)}px)`;
        modal.style.setProperty('--pull', String(p));
      },
      { passive: false }
    );

    const finish = (e) => {
      if (!armed || (e && e.pointerId !== pid)) return;
      const m = /translateY\((\d+(?:\.\d+)?)px\)/.exec(modal.style.transform || '');
      const eased = m ? Number(m[1]) : 0;
      try {
        modal.releasePointerCapture(pid);
      } catch {
        /* 忽略 */
      }
      if (dragging && eased >= THRESHOLD) {
        armed = false;
        dragging = false;
        modal.classList.remove('dragging');
        modal.style.transform = 'translateY(110%)';
        pid = -1;
        setTimeout(() => closeModal(), 240);
      } else {
        reset();
      }
    };

    modal.addEventListener('pointerup', finish);
    modal.addEventListener('pointercancel', finish);
  }

  function showSettings() {
    showModal({
      title: `设置 · v${VERSION}`,
      hideCancel: true,
      render: (body) => {
        const current = THEMES.find((t) => t.id === settings.theme) || THEMES[0];

        body.innerHTML = `
          <div class="set-group">
            <div class="set-label">主题<span class="set-val" data-theme-name>${esc(current.name)}</span></div>
            <div class="swatches">
              ${THEMES.map(
                (t) =>
                  `<button class="swatch${t.id === settings.theme ? ' on' : ''}" data-theme="${t.id}" type="button" aria-label="${
                    t.name
                  }"><i style="background:${t.swatch}"></i><span>${t.name}</span></button>`
              ).join('')}
            </div>
          </div>

          <div class="set-group">
            <div class="set-label">悬浮窗不透明度<span class="set-val" data-op-val>${Math.round(
              settings.fabOpacity * 100
            )}%</span></div>
            <input class="range" type="range" min="20" max="100" step="1" value="${Math.round(
              settings.fabOpacity * 100
            )}" aria-label="悬浮窗不透明度">
          </div>

          <div class="set-group">
            <button class="btn block" data-set="conc" type="button"><span>并发数</span><em>${settings.concurrency}</em></button>
            <button class="btn block" data-set="mem" type="button"><span>内存提醒</span><em>${fmtBytes(
              settings.maxMB * 1024 * 1024
            )}</em></button>
            <button class="btn block" data-set="toast" type="button"><span>悬浮窗标记</span><em>${
              settings.toast ? '开' : '关'
            }</em></button>
            <button class="btn block" data-set="autosave" type="button"><span>自动保存</span><em>${
              settings.autoSave ? '开' : '关'
            }</em></button>
            <button class="btn block" data-act="clearcache" type="button"><span>清理缓存</span></button>
          </div>

          <div class="set-group">
            <button class="btn block" data-act="reset" type="button"><span>恢复默认配置</span></button>
          </div>`;

        body.querySelectorAll('.swatch').forEach((btn) => {
          btn.addEventListener('click', () => {
            settings.theme = btn.dataset.theme;
            saveSettings();
            applyLook();
            body.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b === btn));
            const nameEl = body.querySelector('[data-theme-name]');
            if (nameEl) nameEl.textContent = btn.querySelector('span').textContent;
          });
        });

        const range = body.querySelector('.range');
        const valEl = body.querySelector('[data-op-val]');
        if (range) {
          let saveTimer = null;
          range.addEventListener('input', () => {
            settings.fabOpacity = clamp(Number(range.value) / 100, 0.2, 1);
            applyLook();
            if (valEl) valEl.textContent = `${range.value}%`;
            clearTimeout(saveTimer);
            saveTimer = setTimeout(saveSettings, 250);
          });
          range.addEventListener('change', () => {
            clearTimeout(saveTimer);
            saveSettings();
          });
        }

        body.querySelectorAll('[data-set]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const em = btn.querySelector('em');
            if (btn.dataset.set === 'conc') {
              const concList = [2, 4, 6, 8, 12, 16];
              const ci = concList.indexOf(settings.concurrency);
              settings.concurrency = concList[(ci + 1) % concList.length];
              if (em) em.textContent = String(settings.concurrency);
            } else if (btn.dataset.set === 'toast') {
              settings.toast = !settings.toast;
              if (em) em.textContent = settings.toast ? '开' : '关';
              // 角标立即消失 / 恢复，不用等下一条网络请求
              render();
            } else if (btn.dataset.set === 'autosave') {
              settings.autoSave = !settings.autoSave;
              if (em) em.textContent = settings.autoSave ? '开' : '关';
            } else {
              const list = [400, 700, 900, 1400, 2048, 3072, 4096];
              const i = list.indexOf(settings.maxMB);
              settings.maxMB = list[(i + 1) % list.length];
              if (em) em.textContent = fmtBytes(settings.maxMB * 1024 * 1024);
            }
            saveSettings();
          });
        });

        const cacheBtn = body.querySelector('[data-act="clearcache"]');
        if (cacheBtn) cacheBtn.addEventListener('click', clearCache);

        const resetBtn = body.querySelector('[data-act="reset"]');
        if (resetBtn) resetBtn.addEventListener('click', resetSettings);
      },
    });
  }

  /**
   * 清理缓存：只清「没下完 / 被取消」任务留在内存里的东西——
   * 半截分片、密文副本、objectURL，以及这些任务卡片本身。
   * 已完成任务的成品、探测列表、设置都不动。
   */
  function clearCache() {
    let cleared = 0;
    for (let i = jobs.length - 1; i >= 0; i--) {
      const job = jobs[i];
      if (job.status !== 'error' && job.status !== 'canceled') continue;
      try {
        if (job.objectUrl) URL.revokeObjectURL(job.objectUrl);
      } catch {
        /* 忽略 */
      }
      job.objectUrl = '';
      job.blob = null;
      if (job.cipher) {
        try {
          job.cipher.length = 0;
        } catch {
          /* 忽略 */
        }
        job.cipher = null;
      }
      jobs.splice(i, 1);
      cleared += 1;
    }
    renderBody();
    toast(cleared ? `已清理 ${cleared} 项缓存` : '没有可清理的缓存');
  }

  /** 恢复默认配置：主题、并发数、内存提醒等全部回到首次启动的状态 */
  function resetSettings() {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    try {
      applyLook();
    } catch {
      /* 忽略 */
    }
    render();
    showSettings();
    toast('已恢复默认配置');
  }

  let toastTimer = null;

  function toast(text) {
    if (!uiReady) return;
    const el = rootEl.querySelector('.toast');
    el.innerHTML = text;
    el.classList.toggle('top', open);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }



  /* ================================================================== *
   * 6. 任务
   * ================================================================== */

  const jobs = [];
  let activeJob = null;
  let jobRenderTimer = null;

  function scheduleJobRender() {
    if (jobRenderTimer) return;
    jobRenderTimer = setTimeout(() => {
      jobRenderTimer = null;
      if (open) renderJobsInPlace();
    }, 260);
  }

  /** 只更新任务卡片，避免整表重绘打断列表滚动 */
  function renderJobsInPlace() {
    if (!uiReady) return;
    // 任务区固定在 .jobs 分节里，与 renderBody 画的是同一份
    const sec = ensureBodySections(rootEl.querySelector('.body'));
    sec.jobs.innerHTML = renderJobs();
  }

  function newJobId() {
    return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function removeJob(id) {
    const i = jobs.findIndex((j) => j.id === id);
    if (i < 0) return;
    const [job] = jobs.splice(i, 1);
    if (job.objectUrl) {
      try {
        URL.revokeObjectURL(job.objectUrl);
      } catch {
        /* 忽略 */
      }
    }
    if (activeJob === job) activeJob = null;
    renderBody();
  }

  function cancelJob(job) {
    if (!job || job.status !== 'running') return;
    job.cancelled = true;
    job.message = '正在取消…';
    renderJobsInPlace();
  }

  async function startItem(item) {
    if (activeJob && activeJob.status === 'running') {
      toast('已有任务在进行中，请先等待或取消');
      return;
    }
    if (item.kind === 'mpd') {
      showItemActions(item);
      return;
    }
    if (item.kind === 'm3u8') {
      let info;
      try {
        info = await inspectPlaylist(item.url, io);
      } catch (err) {
        showModal({
          title: '读取播放列表失败',
          subtitle: err.message || '',
          actions: [
            { label: '复制播放列表地址', hint: '可在 VLC / nPlayer 中打开', primary: true, onClick: () => copyText(item.url) },
            { label: '重试', onClick: () => startItem(item) },
          ],
        });
        return;
      }

      if (info.type === 'master') {
        const actions = info.variants.map((v, i) => ({
          label: v.label,
          hint: i === 0 ? '最高码率' : v.resolution || '',
          primary: i === 0,
          onClick: () => runItem(item, { variantIndex: v.index, quality: v.label }),
        }));
        showModal({
          title: '选择清晰度',
          subtitle: `共 ${info.variants.length} 条轨道，已按码率从高到低排列`,
          actions,
        });
        return;
      }

      const bits = [`${info.segments} 片`];
      if (info.duration) bits.push(`${Math.round(info.duration / 60)} 分钟`);
      if (info.encrypted) bits.push('AES-128 加密');
      if (info.live) bits.push('直播流');
      showModal({
        title: '开始合并下载？',
        subtitle: `媒体播放列表 · ${bits.join(' · ')}`,
        actions: [
          { label: '开始下载', primary: true, onClick: () => runItem(item, {}) },
          { label: '复制播放列表地址', hint: 'VLC / nPlayer 可直接播放', onClick: () => copyText(item.url) },
        ],
      });
      return;
    }

    if (item.kind === 'ts' || item.kind === 'm4s') {
      if (!item.urls || !item.urls.length) {
        toast('这一组还没有分片，先播放一会儿再试');
        return;
      }
      // 分片分组只包含"页面真正请求过的那些"，天然不全；而且没有播放列表就拿不到
      // 密钥和初始化段。所以只要能找到同目录的播放列表，就自动改走它。
      toast('正在确认播放列表…');
      const found = await findPlaylistFor(item);
      if (found) {
        toast(`已改用播放列表：${found.name}`);
        runItem(item, { playlistUrl: found.url });
        return;
      }
    }

    runItem(item, {});
  }

  /* ---------------- 播放列表兜底发现 ---------------- */

  const playlistCache = new Map();
  const PLAYLIST_NAMES = [
    'index.m3u8',
    'playlist.m3u8',
    'prog_index.m3u8',
    'main.m3u8',
    'chunklist.m3u8',
    'master.m3u8',
    'media.m3u8',
  ];

  /**
   * 分片的"身份"。
   * 只取文件名、丢掉查询串：同一批分片经常被挂在多个 CDN 域名下，
   * 或者每次请求都换一个鉴权 token，按完整 URL 比对永远对不上。
   */
  function segKey(url) {
    const u = safeUrl(url);
    if (!u) return String(url || '').split('?')[0];
    const segs = u.pathname.split('/').filter(Boolean);
    return segs.length ? segs[segs.length - 1] : u.pathname;
  }

  async function readPlaylist(url) {
    if (playlistCache.has(url)) return playlistCache.get(url);
    let parsed = null;
    try {
      const text = await io.text(url, null);
      if (text && text.indexOf('#EXTM3U') >= 0) parsed = parseM3U8(text, url);
    } catch {
      parsed = null;
    }
    playlistCache.set(url, parsed);
    return parsed;
  }

  function playlistOverlap(parsed, keys) {
    if (!parsed || parsed.type !== 'media') return 0;
    let hit = 0;
    for (const seg of parsed.segments) {
      if (keys.has(segKey(seg.url))) hit += 1;
    }
    return hit;
  }

  function playlistHasKey(parsed) {
    return !!(parsed && parsed.type === 'media' && parsed.segments.some((s) => s.key && s.key.method === 'AES-128'));
  }

  /**
   * 找"能覆盖这批分片"的播放列表。
   *
   * 早先的实现按目录严格比对，在真实站点上几乎必然失败：
   *   · 播放列表常在 API 域名，分片在 CDN 域名
   *   · 分片 URL 常带每次变化的 token
   * 现在改成按分片文件名算重合度，重合越多越可信；一个都对不上时，
   * 才退而接受"同目录的媒体播放列表"（可能只是另一条码率轨）。
   */
  /**
   * 分片目录 → 已知能解密的播放列表。
   *
   * 这是"同一媒体有时要密钥、有时不要"的根治手段：以前能不能自动解密取决于
   * 点下载那一刻列表里是否还留着那条 m3u8（列表会被换页/刷新/上限裁掉），
   * 找不到就只能把密文交给用户、要求手填密钥。现在只要某个播放列表成功解开过
   * 这个目录，就记下来，后续同目录的分片一律先按它走——结果可复现。
   */
  const playlistMemo = new Map();

  function memoPlaylist(plan) {
    if (!plan || !plan.playlistUrl) return;
    const units = plan.units || [];
    const first = units.find((u) => u && u.url);
    if (!first) return;
    const dir = dirUrlOf(first.url);
    if (!dir) return;
    const hasKey = units.some((u) => u.key && u.key.method === 'AES-128' && u.key.uri);
    const prev = playlistMemo.get(dir);
    // 已经记过"带密钥"的，不要被同一目录里无密钥的播放列表覆盖
    if (prev && prev.hasKey && !hasKey) return;
    playlistMemo.set(dir, { url: plan.playlistUrl, hasKey, at: Date.now() });
  }

  async function findPlaylistFor(item, opts = {}) {
    const urls = (item.urls && item.urls.length ? item.urls : [item.url]).filter(Boolean);
    if (!urls.length) return null;

    const keys = new Set(urls.map(segKey));
    const dir = dirUrlOf(urls[0]);
    const allowWeak = opts.allowWeak !== false;

    const seen = new Set();
    const candidates = [];
    const push = (url, label) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      candidates.push({ url, label: label || '' });
    };

    // 0) 本目录此前已经用它解开过：优先复用，结果可复现
    const memo = dir ? playlistMemo.get(dir) : null;
    if (memo && memo.url) push(memo.url, '已用过的播放列表');

    // 1) 已探测到的播放列表，不限目录
    for (const other of store.values()) {
      if (other.kind !== 'm3u8') continue;
      push(other.url, other.name);
    }

    // 2) 分片目录及其上一级的常见文件名
    const dirs = [];
    if (dir) {
      dirs.push(dir);
      const parent = dirUrlOf(dir.replace(/\/$/, ''));
      if (parent && parent !== dir) dirs.push(parent);
    }
    for (const d of dirs) {
      for (const name of PLAYLIST_NAMES) push(d + name, name);
    }

    if (!candidates.length) return null;

    let best = null;
    let budget = 16; // 一次最多拉这么多个播放列表，别点一下就发几十个请求

    /**
     * 分档匹配，而不是简单算分：
     *   3 档：分片目录也对得上，而且分片文件名有重合 —— 基本可以确定就是它
     *   2 档：文件名有重合，但目录不同（跨 CDN 域名，或播放列表在 API 域）
     *   1 档：只是同目录的媒体播放列表，一个分片名都对不上（可能是另一条码率轨）
     * 同一档里再按重合数量和"带不带密钥"排序。
     */
    const itemOrigin = (safeUrl(urls[0]) || {}).origin || '';

    const consider = (parsed, url, label) => {
      const hit = playlistOverlap(parsed, keys);
      const first = parsed.segments[0] && parsed.segments[0].url;
      const segDir = first ? dirUrlOf(first) : '';
      const segOrigin = (safeUrl(first) || {}).origin || '';

      let tier = 0;
      if (hit > 0) {
        if (segDir && segDir === dir) {
          tier = 3; // 分片目录和文件名都对得上
        } else if (segOrigin && itemOrigin && segOrigin !== itemOrigin) {
          // 只有"分片被指向了另一个域名"时才放宽：这时目录天然对不上，
          // 而同一个站里两个不同视频用同名分片的概率又很低
          tier = 2;
        }
      } else if (allowWeak && segDir && segDir === dir) {
        tier = 1;
      }
      if (!tier) return;

      const hasKey = playlistHasKey(parsed);
      const score = tier * 10000 + hit * 10 + (hasKey ? 1 : 0);
      if (!best || score > best.score) {
        best = {
          url,
          name: label || '播放列表',
          score,
          tier,
          hit,
          hasKey,
          segments: parsed.segments.length,
        };
      }
    };

    for (const cand of candidates) {
      if (budget <= 0) break;
      if (opts.isCancelled && opts.isCancelled()) break;
      budget -= 1;

      const parsed = await readPlaylist(cand.url);
      if (!parsed) continue;

      if (parsed.type === 'media') {
        consider(parsed, cand.url, cand.label);
        continue;
      }

      // 主列表：往下钻一层，最多看 4 条码率
      for (const variant of parsed.variants.slice(0, 4)) {
        if (budget <= 0) break;
        budget -= 1;
        const sub = await readPlaylist(variant.url);
        if (!sub || sub.type !== 'media') continue;
        consider(sub, variant.url, variant.label || cand.label);
      }
    }

    return best;
  }

  let relayItemId = '';

  /** 内嵌页把任务结果回传顶层 */
  function reportRemoteJob(job) {
    if (!framePost || !relayItemId) return;
    framePost({
      tss: 'sniff:job',
      itemId: relayItemId,
      status: job.status,
      message: job.message,
      bytes: job.bytes || 0,
      name: job.filename || '',
    });
    relayItemId = '';
  }

  async function runItem(item, opts = {}) {
    if (!IS_TOP && opts.relayItemId) relayItemId = opts.relayItemId;
    let isDirectPlan = false;
    const jobKeyCache = new Map(); // 同一任务内的 AES 密钥只取一次
    if (activeJob && activeJob.status === 'running') {
      toast('已有任务在进行中，请先等待或取消');
      return;
    }
    const job = {
      id: newJobId(),
      item,
      title: item.name,
      filename: '',
      status: 'running',
      phase: '解析播放列表…',
      message: '正在解析播放列表…',
      done: 0,
      total: 0,
      bytes: 0,
      percent: 0,
      speed: 0,
      eta: 0,
      cancelled: false,
      startedAt: Date.now(),
    };
    jobs.unshift(job);
    if (jobs.length > 4) removeJob(jobs[jobs.length - 1].id);
    activeJob = job;
    renderBody();

    try {
      let plan;
      if (item.kind === 'm3u8') {
        plan = await planFromPlaylist(item.url, opts.variantIndex, io);
      } else if (opts.playlistUrl) {
        plan = await planFromPlaylist(opts.playlistUrl, opts.variantIndex, io);
        if (!plan.quality) plan.quality = '';
      } else if (item.kind === 'ts' || item.kind === 'm4s') {
        plan = planForSegments(item.urls || []);
      } else {
        // 图片 / 直链视频 / 音频：本来就是一个完整文件，不做合并，
        // 也不该拿去套 TS 包对齐或 fMP4 moov 那套校验
        plan = {
          units: [{ url: item.url, byterange: null, key: null, seq: 0 }],
          isFMP4: false,
          direct: true,
          quality: '',
          ext: resolveExt(item.url, item.contentType, item.kind),
        };
      }

      // 这条播放列表以后能复用：记下它对应的分片目录
      if (plan && plan.playlistUrl) memoPlaylist(plan);

      // 分片直下时，若同目录已经知道"哪个播放列表带密钥"，直接按播放列表下。
      // 以前是"先下一遍密文、失败后再回头找播放列表"，能不能找到取决于
      // 列表当时的状态，于是同一媒体时好时坏；提前复用后结果稳定。
      if (!plan.direct && !opts.playlistUrl && (item.kind === 'ts' || item.kind === 'm4s')) {
        const segDir = dirUrlOf(item.url);
        const memo = segDir ? playlistMemo.get(segDir) : null;
        if (memo && memo.hasKey && memo.url) {
          try {
            const via = await planFromPlaylist(memo.url, undefined, io);
            if (via && via.units.length && via.units.some((u) => u.key && u.key.uri)) {
              via.quality = via.quality || plan.quality;
              plan = via;
              memoPlaylist(plan);
              job.usedPlaylist = { url: memo.url, name: '已用过的播放列表', hasKey: true };
              job.message = '已按播放列表里的密钥解密…';
            }
          } catch {
            /* 记录过期就按原计划走，后面还有失败后的补救 */
          }
        }
      }

      isDirectPlan = !!plan.direct;
      if (job.cancelled) throw cancelError();

      const grab = (p) => {
        job.total = p.units.length;
        job.done = 0;
        job.bytes = 0;
        job.percent = 0;
        job.speed = 0;
        job.eta = 0;
        job.message = p.direct ? '正在下载…' : `抓取分片 1/${p.units.length}`;
        renderJobsInPlace();
        return runPlan(p, io, {
          concurrency: settings.concurrency,
          keyCache: jobKeyCache,
          isCancelled: () => job.cancelled,
          onProgress: (prog) => {
            job.done = prog.done;
            job.total = prog.total;
            job.bytes = prog.bytes;
            job.percent = prog.percent;
            job.speed = prog.speed;
            job.eta =
              prog.speed > 0
                ? ((prog.total - prog.done) * (prog.bytes / Math.max(1, prog.done)) / prog.speed) * 1000
                : 0;
            job.message = p.direct ? '正在下载…' : `抓取分片 ${prog.done}/${prog.total}`;
            scheduleJobRender();
            if (!IS_TOP && framePost && relayItemId) {
              framePost({
                tss: 'sniff:progress',
                itemId: relayItemId,
                done: prog.done,
                total: prog.total,
                bytes: prog.bytes,
                percent: prog.percent,
                speed: prog.speed,
              });
            }

            const limit = settings.maxMB * 1024 * 1024;
            if (prog.bytes > limit && !job.warned) {
              job.warned = true;
              toast(`已累计 ${fmtBytes(prog.bytes)}，已超过内存提醒阈值，建议改用「复制直链」在 VLC 中下载`);
            }
          },
        });
      };

      let result = await grab(plan);

      job.phase = 'saving';
      job.message = '正在合并分片…';
      renderJobsInPlace();

      // 落盘前体检：容器 → 包对齐 → 节目表 → 有没有可解码的流
      // 直链文件（图片 / mp4 / mov / avi）没有分片概念，跳过这套检查
      let check = plan.direct ? { ok: true, container: 'file', notes: [] } : finalizeOutput(result.parts, plan.isFMP4);

      // 首轮拿到密文（或认不出的东西）→ 自动找能解密的播放列表重下一次。
      // 分片是 AES-128 密文时，只有播放列表里的 #EXT-X-KEY 能救。
      // 不再限定 item.kind：分类器把分片认成 video/mp4 时，以前永远不走补救，
      // 于是"明明有 #EXT-X-KEY 却还是要求手填密钥"。体检本身已经限定只有
      // 密文/认不出/缺初始化段才会进来，放宽不会带来多余请求。
      if (!plan.direct && !check.ok && !opts.playlistUrl && !opts.retried) {
        const diag = detectContainer(result.parts);
        if (diag.kind === 'encrypted' || diag.kind === 'unknown' || check.needInit) {
          job.message = `这批分片是${diag.label}，正在查找能解密的播放列表…`;
          job.phase = 'retry';
          renderJobsInPlace();

          const found = await findPlaylistFor(item, { allowWeak: true, isCancelled: () => job.cancelled });
          if (found) {
            const nextPlan = await planFromPlaylist(found.url, undefined, io);
            if (nextPlan && nextPlan.units.length) {
              nextPlan.quality = nextPlan.quality || '';
              plan = nextPlan;
              memoPlaylist(plan);
              job.usedPlaylist = found;
              job.message = `已改用播放列表（${found.name}${found.hasKey ? ' · 含密钥' : ''}），重新下载…`;
              renderJobsInPlace();
              result = await grab(plan);
              check = finalizeOutput(result.parts, plan.isFMP4);
            }
          }
        }
      }

      // 扩展名和 mime 只认"实际进到文件里的字节"，不认 playlist 里的猜测：
      // 把 TS 命名成 .mp4，PotPlayer 会直接报"无法解析影音播放信息"
      // fMP4 分片本身不带 moov，必须补一个初始化段，否则播放器打不开
      if (!check.ok && check.needInit) {
        job.message = '这批分片是 fMP4，缺少初始化段，正在查找 init.mp4…';
        job.phase = 'retry';
        renderJobsInPlace();
        const init = await findFmp4Init(item, (plan.units || []).map((u) => u.url));
        if (init) {
          result.parts.unshift(init);
          const again = finalizeOutput(result.parts, true);
          if (again.ok) {
            again.notes = (again.notes || []).concat('已补上初始化段 init.mp4');
            check = again;
          }
        }
      }

      const isFmp4Final = !plan.direct && (check.ok ? !!check.isFMP4 : !!plan.isFMP4);
      const analysis = !plan.direct && check.ok && !isFmp4Final ? analyzeTs(result.parts) : null;

      const mime = plan.direct ? mimeForExt(plan.ext) : isFmp4Final ? 'video/mp4' : 'video/mp2t';
      const blob = new Blob(result.parts, { type: mime });

      job.bytes = blob.size;
      job.percent = 1;
      job.filename = buildFilename({
        pageTitle: document.title,
        host: item.host,
        title: item.name,
        quality: plan.quality,
        isFMP4: isFmp4Final,
        ext: plan.ext,
      });
      activeJob = null;

      const verdict = plan.direct
        ? blob.size
          ? { ok: true, short: '已保存', message: `已下载 · ${fmtBytes(blob.size)}` }
          : { ok: false, short: '下载结果是空的', message: '服务器返回了空内容，可能触发了防盗链或需要登录' }
        : judgeResult(check, analysis, blob.size, detectContainer(result.parts));

      // 密文先留着：用户手工填一个密钥就能就地解开，不用重下
      if (!verdict.ok && verdict.encrypted && result.parts.length) {
        job.cipher = result.parts.slice();
        job.cipherUrls = (plan.units || []).map((u) => u.url);
        job.encrypted = true;
      } else {
        result.parts.length = 0;
      }
      if (verdict.ok) {
        job.blob = blob;
        job.objectUrl = URL.createObjectURL(blob);
        job.status = 'done';
        job.message = verdict.message;
        job.detail = verdict.detail || verdict.message;
        job.encrypted = false;
      } else {
        // 宁可明确报错，也不把一个打不开的文件塞给用户
        job.blob = null;
        job.objectUrl = '';
        job.status = 'error';
        job.message = verdict.message;
      }

      renderBody();
      if (verdict.ok) {
        toast(plan.direct ? `已下载 · ${fmtBytes(blob.size)}` : `合并完成 · ${fmtBytes(blob.size)}`);
        // 自动保存：完成即交给浏览器落盘，用户不用再点一次。
        // 内嵌页没有界面，无论设置如何都要落盘，否则文件留在 iframe 里拿不到
        if (settings.autoSave || framePost) {
          setTimeout(() => {
            if (!job.released && job.blob) {
              saveJob(job, { auto: true })
                .then(() => {
                  if (!IS_TOP) reportRemoteJob(job);
                })
                .catch(() => {
                  if (!IS_TOP) reportRemoteJob(job);
                });
            } else if (!IS_TOP) {
              reportRemoteJob(job);
            }
          }, 80);
        } else if (!IS_TOP) {
          reportRemoteJob(job);
        }
      } else {
        toast(verdict.short);
        if (!IS_TOP) reportRemoteJob(job);
      }
    } catch (err) {
      if (err && err.canceled) {
        job.status = 'canceled';
        job.message = '已取消';
        activeJob = null;
        renderBody();
        reportRemoteJob(job);
        return;
      }
      job.status = 'error';
      job.message = friendlyError(err);
      // 单文件被 403/401 拒时，留一个「复制直链」按钮：文案已经说明该怎么做
      if (isDirectPlan && err && (err.httpStatus === 403 || err.httpStatus === 401)) {
        job.copyHint = true;
      }
      activeJob = null;
      renderBody();
      reportRemoteJob(job);
    }
  }

  /**
   * 给合并结果下结论。
   * 判据是"播放器能不能认出来"：容器对不对 → 包对齐 → 有 PAT/PMT → 有可解码的流。
   * 结论必须能指导下一步，不能只说"失败"。
   */
  function judgeResult(check, analysis, size, diag) {
    const kind = (check && check.container) || (diag && diag.kind) || 'unknown';
    const head = (check && check.head) || (diag && diag.head) || '';
    const ent = diag && Number.isFinite(diag.entropy) ? `熵 ${diag.entropy.toFixed(2)}` : '';

    if (!size) {
      return {
        ok: false,
        short: '合并结果是空的',
        message: '合并结果是空的：分片都没拿到内容。多半被下载器（IDM / 迅雷）接管，或触发了防盗链',
      };
    }

    if (!check.ok) {
      if (kind === 'encrypted') {
        return {
          ok: false,
          encrypted: true,
          short: '分片是 AES 密文，需要密钥',
          message:
            `已下载到 ${fmtBytes(size)}，但内容是 AES 加密后的密文（${ent}，开头 ${head}），不是 MPEG-TS 流。` +
            '这类站点必须用播放列表里的 #EXT-X-KEY 才能解开。「输入密钥解密」可以就地解密，不用重新下载。',
        };
      }
      if (check.needInit) {
        return {
          ok: false,
          short: '缺 fMP4 初始化段，播放器打不开',
          message:
            '这批分片是 fMP4（MP4 分片），本身不含 moov 初始化段——播放器拿不到它就会报"无法解析影音播放信息"。' +
            '已尝试从同目录找 init.mp4 但没找到。请改用带 #EXT-X-MAP 的 m3u8 播放列表下载，' +
            '或手动把该视频的 init.mp4 一起提供',
        };
      }
      if (kind === 'web') {
        return {
          ok: false,
          short: '服务器返回的是网页',
          message: '服务器返回的是网页而不是视频分片：多半需要登录、链接已过期，或触发了防盗链（校验 Referer / UA）',
        };
      }
      if (kind === 'image' || kind === 'archive' || kind === 'audio') {
        return {
          ok: false,
          short: '返回的不是视频分片',
          message: `服务器返回的是${(diag && diag.label) || '其它类型的数据'}（开头 ${head}），说明这个地址不是视频分片`,
        };
      }
      if (kind === 'empty') {
        return { ok: false, short: '合并结果是空的', message: '合并结果是空的：所有分片都返回了空内容' };
      }
      return {
        ok: false,
        short: '认不出这批数据',
        message:
          `合并结果认不出来：${(diag && diag.label) || check.reason || '未知格式'}（${ent}，开头 ${head}）。` +
          '既不是 TS，也不是 fMP4，也不是密文。可能是站点用了私有封装，或分片被换成了占位数据',
      };
    }

    if (analysis && !analysis.hasPmt) {
      return {
        ok: false,
        short: '缺少节目表，播放器认不出',
        message:
          '合并结果没有节目表（PAT/PMT），播放器会报"无法解析影音播放信息"。' +
          `已扫到 ${analysis.packets} 个包、PID ${analysis.pids.slice(0, 6).join('/')}${analysis.pids.length > 6 ? '…' : ''}。` +
          '常见原因是漏了开头的分片（尤其是 init 段）、分片被加密，或站点用了私有封装',
      };
    }

    if (analysis && analysis.scrambled) {
      return {
        ok: false,
        short: '这条流是加扰的',
        message:
          '合并结果的 TS 包头里"加扰标志"是置位的——这不是普通加密，而是广播级的加扰（CA）。' +
          '任何播放器都会拒绝解码。这类站点通常需要专门的解密模块，本工具无法处理',
      };
    }

    if (analysis && analysis.hasPat && analysis.patCrcOk === false) {
      return {
        ok: false,
        short: '节目表 CRC 校验失败',
        message:
          '合并结果里找到了 PAT，但它的 CRC 校验不通过——播放器会把这张表直接丢掉，于是报"无法解析影音播放信息"。' +
          '说明分片被改写或加扰过（每个包都保留 0x47 同步字节，所以看起来像 TS）',
      };
    }

    if (analysis && analysis.hasPmt && analysis.pmtCrcOk === false) {
      return {
        ok: false,
        short: '节目表 CRC 校验失败',
        message:
          '合并结果里找到了 PMT，但 CRC 校验不通过，播放器会忽略它。' +
          '这类文件在结构上像 TS，实际无法解析——分片很可能被加扰或做过私有封装',
      };
    }

    if (analysis && analysis.streams.length && analysis.silentPids.length === analysis.streams.length) {
      return {
        ok: false,
        short: '节目表声明的流没有数据',
        message:
          `节目表声明了 ${analysis.streams.length} 条流（${analysis.codecs.join('/') || '未知编码'}），` +
          '但在实际数据里，这些 PID 一个包都没有——播放器只能解析出"空节目"。' +
          '常见原因是只下到了音频/视频其中一条轨，或分片被换成了占位数据',
      };
    }

    const codec = analysis && analysis.codecs.length ? ` · ${analysis.codecs.join(' + ')}` : '';
    const health = tsSummary(analysis);
    const notes = check.notes && check.notes.length ? `（已修复：${check.notes.join('、')}）` : '';
    return {
      ok: true,
      short: '合并完成',
      // 界面只显示「结果 · 文件大小」；编码与体检细节留在 detail 里备查
      message: `合并完成 · ${fmtBytes(size)}`,
      detail: `合并完成 · ${fmtBytes(size)}${codec}${health ? ' · ' + health : ''}${notes}`,
    };
  }

  /**
   * fMP4 的初始化段（ftyp + moov）。
   * 播放列表里有 #EXT-X-MAP 时根本用不到这个函数；能走到这里，
   * 说明是"分片其实是 fMP4、但播放列表没给 MAP"的站，只能去同一个目录碰运气。
   */
  async function findFmp4Init(item, unitUrls) {
    const first = (unitUrls && unitUrls[0]) || item.url || '';
    const dir = dirUrlOf(first);
    if (!dir) return null;
    const names = ['init.mp4', 'init-1.mp4', 'header.mp4', 'init.m4s', 'init.mp4?'];
    for (const name of names) {
      if (name.endsWith('?')) continue;
      try {
        const res = await io.bytes(dir + name, {}, null, { noStore: true });
        if (hasBox([res.bytes], 'moov')) return res.bytes;
      } catch {
        /* 404 → 试下一个 */
      }
    }
    return null;
  }

  /* ================================================================== *
   * 6.5 手工密钥解密：密文已经在手上，只差一把钥匙
   * ================================================================== */

  /** 输入可以是密钥地址、data: URI、或 32 位十六进制 */
  async function resolveKeyBytes(input) {
    const text = String(input || '').trim();
    if (!text) throw new Error('请填入密钥地址，或直接粘贴 32 位十六进制密钥');
    if (/^(0x)?[0-9a-f]{32}$/i.test(text)) return hexToBytes(text.replace(/^0x/i, ''));
    if (text.startsWith('data:')) return base64ToBytes(text.slice(text.indexOf(',') + 1));
    const url = resolveUrl(text, location.href);
    const res = await io.bytes(url, {}, null, { noStore: true });
    return res.bytes;
  }

  /**
   * 解一个分片。IV 不靠猜——靠"解出来第一个字节是不是 0x47"来验证。
   * AES-CBC 只有第一块受 IV 影响，所以首字节对上基本就说明 IV 选对了。
   */
  async function decryptOneSegment(part, key, url, index) {
    const tries = [];

    // 变体 A：分片开头自带 16 字节 IV（部分站点这么干）
    if (part.byteLength > 64) {
      tries.push({ name: '分片内嵌 IV', data: part.subarray(16), iv: part.subarray(0, 16) });
    }

    // 变体 B：HLS 默认 IV = 媒体序列号。序列号可能来自文件名，也可能就是下标
    const nums = [];
    const m = /(\d+)(?!.*\d)/.exec(String(url).split('?')[0]);
    if (m) {
      const v = Number(m[1]);
      nums.push(v, v + 1, v - 1);
    }
    nums.push(index, index + 1, 0);

    const seen = new Set();
    for (const num of nums) {
      if (num < 0 || seen.has(num)) continue;
      seen.add(num);
      tries.push({ name: `序列号 ${num}`, data: part, iv: sequenceIv(num) });
    }

    for (const t of tries) {
      if (t.data.byteLength < 16 || t.data.byteLength % 16 !== 0) continue;
      try {
        const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: t.iv }, key, t.data));
        if (plain[0] !== 0x47) continue;
        if (plain.byteLength >= 376 && (plain[188] !== 0x47 || plain[376] !== 0x47)) continue;
        return { bytes: plain, scheme: t.name };
      } catch {
        /* 填充校验失败 → 这个 IV 不对，换下一个 */
      }
    }
    return null;
  }

  async function decryptSegmentsWithKey(parts, urls, rawKey) {
    if (!(typeof crypto !== 'undefined' && crypto.subtle)) {
      throw new Error('当前环境不支持 WebCrypto 解密（页面必须是 HTTPS）');
    }
    const key = await importAesKey(rawKey);
    const out = [];
    const schemes = new Set();
    for (let i = 0; i < parts.length; i++) {
      if (i % 4 === 0) await sleep(0); // 让出主线程，别把页面卡死
      const res = await decryptOneSegment(parts[i], key, urls[i] || '', i);
      if (!res) return { ok: false, reason: `第 ${i + 1}/${parts.length} 个分片用这个密钥解不开` };
      out.push(res.bytes);
      schemes.add(res.scheme);
    }
    // 每个分片的 IV 通常各不相同，只有一个值时才有信息量
    const scheme = schemes.size === 1 ? [...schemes][0] : `按分片序号推导（${schemes.size} 种）`;
    return { ok: true, parts: out, scheme };
  }

  async function decryptJobWithKey(job, rawInput) {
    if (!job) return;
    if (!job.cipher || !job.cipher.length) {
      toast('密文已经释放，请重新下载一次');
      return;
    }
    toast('正在解密…');

    const rawKey = await resolveKeyBytes(rawInput);
    if (!rawKey || (rawKey.byteLength !== 16 && rawKey.byteLength !== 32)) {
      throw new Error(`密钥长度异常（${rawKey ? rawKey.byteLength : 0} 字节），应为 16 或 32 字节`);
    }

    const res = await decryptSegmentsWithKey(job.cipher, job.cipherUrls || [], rawKey);
    if (!res.ok) throw new Error(`${res.reason}，请确认密钥地址或内容是否正确`);

    const parts = res.parts;
    const check = finalizeOutput(parts, false);
    const isFmp4 = !!(check.ok && check.isFMP4);
    const analysis = check.ok && !isFmp4 ? analyzeTs(parts) : null;
    const blob = new Blob(parts, { type: isFmp4 ? 'video/mp4' : 'video/mp2t' });
    const verdict = judgeResult(check, analysis, blob.size, detectContainer(parts));
    if (!verdict.ok) throw new Error(verdict.message);

    job.blob = blob;
    job.bytes = blob.size;
    job.percent = 1;
    job.objectUrl = URL.createObjectURL(blob);
    job.status = 'done';
    job.encrypted = false;
    job.cipher = null;
    if (!isFmp4 && /\.mp4$/i.test(job.filename || '')) job.filename = job.filename.replace(/\.mp4$/i, '.ts');
    job.message = verdict.message;
    // 解密方式这类细节留在 detail，界面上只显示「结果 · 大小」
    job.detail = `${verdict.detail || verdict.message}（密钥解密 · IV ${res.scheme}）`;
    renderBody();
    toast(`解密成功 · ${fmtBytes(blob.size)}`);
  }

  function showKeyModal(job) {
    showModal({
      title: '输入解密密钥',
      subtitle:
        '在浏览器里打开这个视频的 m3u8 播放列表，找到 #EXT-X-KEY 那一行，URI="…" 里就是密钥地址；也可以直接粘贴 32 位十六进制密钥。已下载的密文会就地解开，不重新下载。',
      input: { placeholder: 'https://…/key 或 32 位 hex', value: job.keyGuess || '' },
      actions: [
        {
          label: '解密',
          primary: true,
          hint: '密钥通常只有 16 字节',
          onClick: (value) =>
            decryptJobWithKey(job, value).catch((err) => toast(err.message || '解密失败')),
        },
      ],
    });
  }

  /* ================================================================== *
   * 7. 保存 / 分享 / 导出
   * ================================================================== */

  function triggerDownload(url, filename, opts = {}) {
    // iOS 上没有用户手势就点 blob: 链接，Safari 会把**当前标签页**换成 blob: 文档，
    // 页面连同用户脚本一起消失（刷新也回不来）。这道闸放在函数自己身上，
    // 任何调用方（自动保存 / 手动保存 / 导出播放列表）都绕不过去。
    const hasGesture =
      opts.gesture === true || !!(navigator.userActivation && navigator.userActivation.isActive);
    if (IS_IOS && !hasGesture) {
      console.warn('[Media Sniffer] iOS 无手势，跳过下载链接（避免整页被替换）');
      return false;
    }
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      // target=_blank 是最后一道保险：万一浏览器把下载退化成导航，
      // 也只会在新标签里打开 blob:，当前页面（以及脚本）不受影响。
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1500);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 只释放这一个任务占用的内存（Blob 与它的 blob URL）。
   * 绝不批量清理：没保存成功的任务必须原样留着，用户还能再存一次。
   */
  function releaseJobMemory(job) {
    if (!job) return;
    try {
      if (job.objectUrl) URL.revokeObjectURL(job.objectUrl);
    } catch {
      /* 忽略 */
    }
    job.objectUrl = '';
    job.blob = null;
    job.cipher = null;
    job.released = true;
  }

  /**
   * 保存一个已完成任务，返回「是否真的交出去了」。
   * auto = true 时不带用户手势，showSaveFilePicker 与 navigator.share 都会被
   * 浏览器拒绝，所以只走 a[download]——浏览器下载管理器接收即算落盘。
   */
  /**
   * iOS：把「已完成、但当下没有用户手势」的保存先挂起。
   *
   * 为什么必须这么做：
   * 自动保存发生在下载完成之后，那时早已没有用户手势。Safari 不允许无手势的
   * 程序化下载，于是 `<a download>` 指向 blob: 时会**退化成普通链接导航**——
   * 当前标签页被换成 blob: 文档，文件确实存下来了，但原页面已经没了。
   * 那个 blob: 文档既不在 @match 范围、也没有页面上下文，用户脚本永远不可能注入；
   * 用户再刷新，刷新的就是 blob: —— 表现正是「下载保存之后脚本不运行了」。
   *
   * 所以 iOS 上一律等真实手势（点「保存文件」）再走分享面板，页面永不替换。
   */
  function queueGestureSave(job) {
    if (!job) return;
    // iOS 上"待保存"会把合并后的 Blob 一直留在内存里。两个大文件同时挂着，
    // Safari 极易因内存压力把页面干掉——那又会表现为"脚本没了"。
    // 所以只保留最新一个：旧的立即释放，并把话说明白。
    for (const other of jobs) {
      if (other === job || !other.pendingSave) continue;
      other.pendingSave = false;
      releaseJobMemory(other);
      other.message = '已释放（有更新的文件待保存）';
    }
    job.pendingSave = true;
    try {
      renderJobsInPlace();
    } catch {
      /* 忽略 */
    }
  }

  async function saveJob(job, opts = {}) {
    if (!job) return false;
    const filename = job.filename || 'video.ts';
    const auto = !!(opts && opts.auto);
    const savedText = `已保存 · ${fmtBytes(job.bytes)}`;
    // 「另存为」与分享面板都要求用户手势；没有手势时调用会一直挂着不返回，
    // 先判断激活状态，没有就直接走 a[download]
    // 点击事件本身就是"有手势"的事实：旧版 Safari 没有 navigator.userActivation，
    // 只靠它判断会把用户的手动保存也当成无手势，从而白白降级。
    const activated =
      opts.gesture === true ||
      !!(navigator.userActivation && navigator.userActivation.isActive);
    if (!auto) job.pendingSave = false;

    const finish = () => {
      job.message = savedText;
      releaseJobMemory(job);
      renderJobsInPlace();
      return true;
    };

    // iOS 无手势时绝不点下载链接：会把整个页面导航到 blob:，脚本随之消失
    if (auto && IS_IOS && IS_TOP && !activated) {
      queueGestureSave(job);
      return false;
    }

    // 桌面 Chromium：系统「另存为」对话框，写入成功才算保存
    if (!auto && activated && !IS_IOS && typeof window.showSaveFilePicker === 'function' && job.blob) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: filename });
        const writable = await handle.createWritable();
        await writable.write(job.blob);
        await writable.close();
        toast('已保存');
        return finish();
      } catch (err) {
        if (err && err.name === 'AbortError') return false; // 用户自己取消，内存不动
        /* 其它情况退回普通下载 */
      }
    }

    // 分享面板：系统级写入「文件」/ 下载目录，resolve 代表用户完成了保存
    if (!auto && activated && job.blob && navigator.share && navigator.canShare) {
      try {
        const file = new File([job.blob], filename, {
          type: job.blob.type || 'application/octet-stream',
        });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
          toast('已保存');
          return finish();
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return false;
        /* 继续退回普通下载 */
      }
    }

    if (!job.objectUrl) {
      if (!auto) toast('文件已经释放，请重新下载一次');
      return false;
    }
    const ok = triggerDownload(job.objectUrl, filename, { gesture: activated });
    if (!ok) {
      if (!auto) toast('保存失败，试试「分享 / 存到文件」');
      return false;
    }
    job.message = savedText;
    job.saved = true;
    renderJobsInPlace();
    // 立刻 revoke 可能让还没开始的下载落空，等浏览器接管后再释放
    setTimeout(() => {
      if (!job.released) {
        releaseJobMemory(job);
        renderJobsInPlace();
      }
    }, 1500);
    if (!auto) toast('已发送到下载');
    return true;
  }

  /**
   * 用浏览器打开直链。
   *
   * 为什么不是"下载"：iOS Safari 只对 Content-Disposition: attachment 或同源
   * blob 走下载管理器；跨域 mp4 被打开时一定进播放器。这是平台限制，
   * 所以这里把话说清楚，并给出能真正保存的下一步（分享 → 存储到文件）。
   * 浏览器自己发起的导航带完整 Referer / Cookie，不受页面 CORS 限制。
   */
  async function shareJob(job) {
    if (!job || !job.blob) return;
    const file = new File([job.blob], job.filename || 'video.ts', { type: job.blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: job.filename });
      } catch (err) {
        if (err && err.name !== 'AbortError') toast('分享失败：' + (err.message || ''));
      }
      return;
    }
    toast('当前浏览器不支持分享文件，请用「保存文件」或「新标签打开」');
  }

  function openJob(job) {
    if (!job || !job.objectUrl) return;
    try {
      const win = window.open(job.objectUrl, '_blank');
      if (!win) toast('弹窗被拦截，请改用「分享 / 存到文件」');
    } catch {
      toast('打开失败，请用「保存文件」');
    }
  }

  function buildPlaylistText(item) {
    const urls = orderSegments(item.urls || []);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-PLAYLIST-TYPE:VOD',
    ];
    for (const u of urls) {
      lines.push('#EXTINF:10,');
      lines.push(u);
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
  }

  function exportPlaylist(item) {
    const text = buildPlaylistText(item);
    const name = sanitize(document.title || item.name, 'playlist') + '.m3u8';
    const blob = new Blob([text], { type: 'application/vnd.apple.mpegurl' });
    const url = URL.createObjectURL(blob);
    const ok = triggerDownload(url, name, { gesture: true }); // 只会从按钮点击进入
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(ok ? '已导出播放列表，可用 VLC 打开' : '导出失败，请改用复制链接');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
      return;
    } catch {
      /* 退回到 execCommand */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      document.execCommand('copy');
      ta.remove();
      toast('已复制');
    } catch {
      toast('复制失败，请长按文件名手动选择');
    }
  }

  function showItemActions(item) {
    const meta = KIND_META[item.kind] || { action: '下载' };
    const actions = [];
    const runDownload = () => (item.remote ? startRemoteDownload(item) : startItem(item));

    if (item.kind !== 'mpd') {
      actions.push({ label: meta.action, primary: true, onClick: runDownload });
    }
    if (item.urls && item.urls.length > 1) {
      actions.push({
        label: '复制全部 ' + item.urls.length + ' 条分片链接',
        hint: '可喂给 aria2 / ffmpeg',
        onClick: () => copyText(orderSegments(item.urls).join('\n')),
      });
      actions.push({
        label: '导出 .m3u8 播放列表',
        hint: '保存到「文件」后用 VLC 打开，可绕过内存限制',
        onClick: () => exportPlaylist(item),
      });
    }
    actions.push({
      label: item.urls && item.urls.length > 1 ? '复制首条分片链接' : '复制直链',
      onClick: () => copyText(item.urls && item.urls.length ? item.urls[0] : item.url),
    });
    if (item.kind !== 'm3u8' && !(item.urls && item.urls.length > 1)) {
      actions.push({
        label: '在新标签打开',
        hint: '适合 mp4 直链',
        onClick: () => window.open(item.url, '_blank'),
      });
    }

    showModal({
      title: item.name,
      subtitle: `${(KIND_META[item.kind] || {}).badge || item.kind} · ${item.host}${
        item.count > 1 ? ` · ${item.count} 片` : ''
      }`,
      actions,
    });
  }

  /* ================================================================== *
   * 8. 启动
   * ================================================================== */

  let started = false;

  let watchdogTimer = 0;
  let mountRetry = 0;
  let lastMountError = '';

  /**
   * 看门狗：负责"最终一定有界面"。
   *
   * 在 boot 最开始就装上，后面任何一步抛错都不会让它失效；每 2 秒检查一次，
   * 连续失败最多 60 次（两分钟），既不会永久静默，也不会无限刷屏。
   */
  function armWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (superseded()) return;
      if (!SHOULD_MOUNT || forceChild) return;
      if (uiReady && hostEl && hostEl.isConnected) return;
      if (!uiReady && !hostEl && mountRetry >= 60) return;
      mountRetry += 1;
      uiReady = false;
      hostEl = null;
      try {
        mountUI();
      } catch (err) {
        lastMountError = String((err && err.message) || err);
        console.warn('[Media Sniffer] 界面重挂失败', err);
      }
    }, 2000);
  }

  async function boot() {
    // 第一件事就是装看门狗：即便后面任何一步抛错，界面仍有救
    armWatchdog();
    try {
      // GM 存储在个别环境下会一直不 resolve，不能让它把启动拖死
      await Promise.race([
        loadSettings(),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }

    const start = () => {
      if (started) return;
      started = true;
      try {
        startDomSniffing();
      } catch (err) {
        console.warn('[Media Sniffer] 监听器安装失败', err);
      }
      // 先握一次手：确认自己是不是真的顶层（沙箱里 IS_TOP 会误判）
      try {
        startFrameHandshake();
      } catch {
        /* 忽略 */
      }
      if (SHOULD_MOUNT) {
        try {
          installFrameHost();
        } catch {
          /* 忽略 */
        }
        try {
          mountUI();
        } catch (err) {
          console.error('[Media Sniffer] 界面挂载失败', err);
        }
      }
      {
        // 内嵌页（或握手判定为子帧）：只做探测，把结果上报给顶层合并显示
        try {
          installFrameBridge();
        } catch (err) {
          console.warn('[Media Sniffer] 内嵌页上报失败', err);
        }
      }
    };

    // 资源计时不依赖 DOM，也不改页面任何东西，最先装
    try {
      startPerfSniffing();
    } catch (err) {
      console.warn('[Media Sniffer] 资源计时不可用', err);
    }

    const safeStart = () => {
      try {
        start();
      } catch (err) {
        // 启动步骤出错也不能让 boot 中断：看门狗还在等，2 秒后会再试
        lastMountError = String((err && err.message) || err);
        console.warn('[Media Sniffer] 启动失败，交由看门狗重试', err);
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', safeStart, { once: true });
      setTimeout(safeStart, 2000);
    } else {
      safeStart();
    }

    // 兜底：某些站点的 DOM 结构会晚到
    if (SHOULD_MOUNT) {
      setTimeout(() => {
        try {
          mountUI();
        } catch (err) {
          console.error('[Media Sniffer] 界面挂载失败', err);
        }
      }, 2500);
      try {
        installFrameHost();
      } catch {
        /* 忽略 */
      }
    }

    window.addEventListener('pagehide', () => {
      try {
        suspendSniffing();
      } catch {
        /* 忽略 */
      }
    });

    // 从 bfcache 回来（iOS 切后台 / 前进后退）必须把探测与界面都重新装起来。
    // 只看 resumeSniffing 不够：有些环境下 DOM 节点会被还原成"未挂载"的状态，
    // 那时探测恢复了、按钮却不在。
    const wake = () => {
      try {
        resumeSniffing();
      } catch {
        /* 忽略 */
      }
      if (SHOULD_MOUNT && !forceChild && !(uiReady && hostEl && hostEl.isConnected)) {
        try {
          uiReady = false;
          hostEl = null;
          mountUI();
        } catch (err) {
          lastMountError = String((err && err.message) || err);
        }
      }
    };
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      wake();
    });

    console.log(
      `[Media Sniffer] v${VERSION} 已注入 ${location.host}` +
        `${IS_TOP ? (TOP_CERTAIN ? '（顶层）' : '（疑似顶层）') : '（内嵌页）'}`
    );
  }

  // 启动入口：boot 内部已逐步 try/catch，这里再兜一层，
  // 保证"脚本已注入但什么都没发生"这种状态不会再出现
  Promise.resolve()
    .then(boot)
    .catch((err) => {
      lastMountError = String((err && err.message) || err);
      console.error('[Media Sniffer] 启动异常', err);
      try {
        armWatchdog();
      } catch {
        /* 忽略 */
      }
    });

  // 暴露少量调试接口，方便在 Safari 控制台排查
  try {
    const debugApi = {
      items: () => [...store.values()],
      jobs: () => jobs.slice(),
      parse: parseM3U8,
      stats: () => ({ ...stats, items: store.size }),
      version: VERSION,
      // 自动化测试用：走「无手势」保存路径，避开需要人点的「另存为」对话框
      save: (i) => saveJob(jobs[i || 0], { auto: true }),
      /**
       * 运行状态快照。排查"脚本没出现"时先看这个：
       *   mounted=false + retry 已封顶  → 挂载一直失败，看 lastError
       *   top=true 但 mounted=false     → 被误判成子帧（forceChild）
       */
      diag: () => ({
        version: VERSION,
        gen: GEN,
        alive: readGlobal('__tsSnifferAlive'),
        superseded: superseded(),
        isTop: IS_TOP,
        topCertain: TOP_CERTAIN,
        shouldMount: SHOULD_MOUNT,
        forceChild,
        mounted: !!(uiReady && hostEl && hostEl.isConnected),
        retry: mountRetry,
        lastError: lastMountError,
        frameBridge: frameBridgeReady,
        isIOS: IS_IOS,
        activated: !!(navigator.userActivation && navigator.userActivation.isActive),
      }),
    };
    // 页面控制台里 __tsSniffer 必须真的能取到：沙箱 window 上赋值不一定落到页面。
    // 这里传的是局部变量，不能回读 window.__tsSniffer——写入被沙箱丢弃时它已是 undefined。
    try {
      window.__tsSniffer = debugApi;
    } catch {
      /* 沙箱拒绝写入：exposeGlobal 会写到页面世界 */
    }
    exposeGlobal('__tsSniffer', debugApi);
    exposeGlobal('__tsSnifferVersion', VERSION);
  } catch {
    /* 忽略 */
  }
})();
