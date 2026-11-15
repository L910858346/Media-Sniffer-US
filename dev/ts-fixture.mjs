/**
 * MPEG-TS 测试夹具构造器
 * ------------------------------------------------------------
 * 生成结构完整的 TS：PAT + PMT（H.264 + AAC）+ 若干视频包。
 * 之所以要这么较真：缺少 PAT/PMT 的 TS 播放器根本认不出来，
 * 而这正是"无法解析影音播放信息"的典型成因，测试必须覆盖到。
 */

export const TS_PACKET = 188;

/** MPEG-2 CRC32：节目表最后 4 字节。真实流里 CRC 不对的表会被播放器直接丢掉 */
export function crc32Mpeg(buf, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = (crc ^ (buf[i] << 24)) >>> 0;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

/** 把 CRC 写到 section 末尾 4 字节 */
function appendCrc(sec) {
  const at = sec.length - 4;
  const crc = crc32Mpeg(sec, 0, at);
  sec.writeUInt32BE(crc, at);
  return sec;
}

/** 写一个 TS 包：4 字节头 + 负载，负载不足处补 0xff */
export function writePacket(buf, index, pid, payload, pusi, cc) {
  const off = index * TS_PACKET;
  buf[off] = 0x47;
  buf[off + 1] = (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
  buf[off + 2] = pid & 0xff;
  buf[off + 3] = 0x10 | ((cc === undefined ? index : cc) & 0x0f); // 只有负载字段
  const n = Math.min(payload.length, TS_PACKET - 4);
  payload.copy(buf, off + 4, 0, n);
  for (let i = off + 4 + n; i < off + TS_PACKET; i++) buf[i] = 0xff;
}

/** PAT：节目 1 → PMT PID */
export function patPayload(pmtPid) {
  const sec = Buffer.alloc(16);
  sec[0] = 0x00; // table_id = PAT
  sec[1] = 0xb0;
  sec[2] = 13; // section_length
  sec[3] = 0x00;
  sec[4] = 0x01; // transport_stream_id
  sec[5] = 0xc1; // version 0 / current
  sec[6] = 0x00;
  sec[7] = 0x00;
  sec[8] = 0x00;
  sec[9] = 0x01; // program_number 1
  sec[10] = 0xe0 | ((pmtPid >> 8) & 0x1f);
  sec[11] = pmtPid & 0xff;
  appendCrc(sec); // 12..15 = CRC
  const out = Buffer.alloc(1 + sec.length);
  out[0] = 0x00; // pointer_field
  sec.copy(out, 1);
  return out;
}

/** PMT：声明若干条基本流 */
export function pmtPayload(streams) {
  const slen = 13 + streams.length * 5;
  const sec = Buffer.alloc(3 + slen);
  sec[0] = 0x02; // table_id = PMT
  sec[1] = 0xb0;
  sec[2] = slen;
  sec[3] = 0x00;
  sec[4] = 0x01; // program_number
  sec[5] = 0xc1;
  sec[6] = 0x00;
  sec[7] = 0x00;
  sec[8] = 0xe0 | ((streams[0].pid >> 8) & 0x1f); // PCR_PID
  sec[9] = streams[0].pid & 0xff;
  sec[10] = 0xf0;
  sec[11] = 0x00; // program_info_length = 0
  let at = 12;
  for (const st of streams) {
    sec[at] = st.type;
    sec[at + 1] = 0xe0 | ((st.pid >> 8) & 0x1f);
    sec[at + 2] = st.pid & 0xff;
    sec[at + 3] = 0xf0;
    sec[at + 4] = 0x00; // ES_info_length = 0
    at += 5;
  }
  appendCrc(sec);
  const out = Buffer.alloc(1 + sec.length);
  out[0] = 0x00;
  sec.copy(out, 1);
  return out;
}

/**
 * 造一个 TS 分片
 * @param {number} packetCount 包数
 * @param {number} seed 内容种子（保证各分片数据不同）
 * @param {object} opts { withPsi: 是否带 PAT/PMT, videoType: 流类型 }
 */
export function tsSegment(packetCount, seed, opts = {}) {
  const { withPsi = true, videoType = 0x1b } = opts;
  const VPID = 0x100;
  const APID = 0x101;
  const PMT_PID = 0x1000;
  const buf = Buffer.alloc(packetCount * TS_PACKET);

  // 真实流里每个 PID 各有一套连续计数器
  const cc = new Map();
  const nextCc = (pid) => {
    const v = cc.get(pid) || 0;
    cc.set(pid, (v + 1) & 0x0f);
    return v;
  };

  let start = 0;
  if (withPsi) {
    writePacket(buf, 0, 0x0000, patPayload(PMT_PID), true, nextCc(0x0000));
    writePacket(
      buf,
      1,
      PMT_PID,
      pmtPayload([
        { type: videoType, pid: VPID },
        { type: 0x0f, pid: APID },
      ]),
      true,
      nextCc(PMT_PID)
    );
    start = 2;
  }

  for (let i = start; i < packetCount; i++) {
    const pusi = i === start || i % 20 === 0;
    const payload = Buffer.alloc(32);
    if (pusi) {
      payload[0] = 0x00;
      payload[1] = 0x00;
      payload[2] = 0x01;
      payload[3] = 0xe0;
    }
    for (let k = 4; k < payload.length; k++) {
      payload[k] = ((seed * 31 + i * 7 + k * 13) % 255) || 1;
    }
    writePacket(buf, i, VPID, payload, pusi, nextCc(VPID));
  }
  return buf;
}
