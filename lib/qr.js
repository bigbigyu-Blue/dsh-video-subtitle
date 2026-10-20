/**
 * 零依赖二维码编码器（ISO/IEC 18004，只用 8 位字节模式）。
 *
 * 用途：设置页要给普通用户做「扫一下就登录」的图形引导，
 * 插件不能依赖 qrcode 那个包，所以这里自己算。
 *
 * 整体流程：文字转字节 -> 挑最小版本 -> 拼比特流（模式 + 长度 + 数据 + 终止符 + 填充）
 * -> 分块算 Reed-Solomon 纠错 -> 交织 -> 铺进矩阵 -> 八种掩码挑罚分最低的
 * -> 写格式信息和版本信息 -> 得到黑点阵。
 *
 * 只用到 JS 自带能力（TextEncoder 和普通数组），不碰 canvas，也不碰 DOM。
 */

/** 四个纠错等级，从低到高。外部做参数校验时也用这个。 */
export const EC_LEVELS = ["L", "M", "Q", "H"];

/** 每个等级在格式信息里的两位编码（标准写死的）。 */
const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/** 每个版本一共多少字节（数据加纠错），下标就是版本号，0 号占位不用。 */
const TOTAL_CODEWORDS = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085, 1156, 1258, 1364,
  1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];

/**
 * 每个版本、每个等级的纠错块数量。每行四个数，顺序是 L、M、Q、H。
 * 行号等于版本号减一，比如第 1 行就是版本 1。
 */
const EC_BLOCKS = [
  1, 1, 1, 1,
  1, 1, 1, 1,
  1, 1, 2, 2,
  1, 2, 2, 4,
  1, 2, 4, 4,
  2, 4, 4, 4,
  2, 4, 6, 5,
  2, 4, 6, 6,
  2, 5, 8, 8,
  4, 5, 8, 8,
  4, 5, 8, 11,
  4, 8, 10, 11,
  4, 9, 12, 16,
  4, 9, 16, 16,
  6, 10, 12, 18,
  6, 10, 17, 16,
  6, 11, 16, 19,
  6, 13, 18, 21,
  7, 14, 21, 25,
  8, 16, 20, 25,
  8, 17, 23, 25,
  9, 17, 23, 34,
  9, 18, 25, 30,
  10, 20, 27, 32,
  12, 21, 29, 35,
  12, 23, 34, 37,
  12, 25, 34, 40,
  13, 26, 35, 42,
  14, 28, 38, 45,
  15, 29, 40, 48,
  16, 31, 43, 51,
  17, 33, 45, 54,
  18, 35, 48, 57,
  19, 37, 51, 60,
  19, 38, 53, 63,
  20, 40, 56, 66,
  21, 43, 59, 70,
  22, 45, 62, 74,
  24, 47, 65, 77,
  25, 49, 68, 81,
];

/**
 * 每个版本、每个等级的纠错字节总数（整张码的，不是每块的）。
 * 每行四个数，顺序是 L、M、Q、H。行号等于版本号减一。
 */
const EC_TOTAL_CODEWORDS = [
  7, 10, 13, 17,
  10, 16, 22, 28,
  15, 26, 36, 44,
  20, 36, 52, 64,
  26, 48, 72, 88,
  36, 64, 96, 112,
  40, 72, 108, 130,
  48, 88, 132, 156,
  60, 110, 160, 192,
  72, 130, 192, 224,
  80, 150, 224, 264,
  96, 176, 260, 308,
  104, 198, 288, 352,
  120, 216, 320, 384,
  132, 240, 360, 432,
  144, 280, 408, 480,
  168, 308, 448, 532,
  180, 338, 504, 588,
  196, 364, 546, 650,
  224, 416, 600, 700,
  224, 442, 644, 750,
  252, 476, 690, 816,
  270, 504, 750, 900,
  300, 560, 810, 960,
  312, 588, 870, 1050,
  336, 644, 952, 1110,
  360, 700, 1020, 1200,
  390, 728, 1050, 1260,
  420, 784, 1140, 1350,
  450, 812, 1200, 1440,
  480, 868, 1290, 1530,
  510, 924, 1350, 1620,
  540, 980, 1440, 1710,
  570, 1036, 1530, 1800,
  570, 1064, 1590, 1890,
  600, 1120, 1680, 1980,
  630, 1204, 1770, 2100,
  660, 1260, 1860, 2220,
  720, 1316, 1950, 2310,
  750, 1372, 2040, 2430,
];

/** 等级在表里的列号。 */
function ecIndex(ec) {
  const i = EC_LEVELS.indexOf(ec);
  if (i < 0) {
    throw new Error("纠错等级只能是 " + EC_LEVELS.join(" / ") + "，收到：" + ec);
  }
  return i;
}

/** 这个版本一共多少字节（数据加纠错）。 */
function totalCodewords(version) {
  return TOTAL_CODEWORDS[version];
}

/** 这个版本加这个等级，纠错字节一共多少。 */
function ecTotalCodewords(version, ec) {
  return EC_TOTAL_CODEWORDS[(version - 1) * 4 + ecIndex(ec)];
}

/** 这个版本加这个等级，要分成几个纠错块。 */
function ecBlockCount(version, ec) {
  return EC_BLOCKS[(version - 1) * 4 + ecIndex(ec)];
}

/** 这个版本加这个等级，能装多少个数据字节。 */
function dataCodewordCount(version, ec) {
  return totalCodewords(version) - ecTotalCodewords(version, ec);
}

/** 边长：版本 1 是 21，每加一个版本多 4。 */
function symbolSize(version) {
  return 17 + 4 * version;
}

// ------------------------------------------------------------------ 比特流

/** 往比特流里按高位先出的顺序塞若干个比特。 */
function putBits(bitBuffer, value, length) {
  for (let i = length - 1; i >= 0; i--) {
    bitBuffer.push((value >>> i) & 1);
  }
}

/** 把一串 0 和 1 拼成字节数组，长度不够由调用方先补齐。 */
function bitsToBytes(bits) {
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bytes.length; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    bytes[i] = b;
  }
  return bytes;
}

/** 字节模式里「数据长度」占几个比特：版本 1 到 9 是 8 位，10 到 40 都是 16 位。 */
function charCountBits(version) {
  return version < 10 ? 8 : 16;
}

/** 这个版本加这个等级，最多能放多少个字节（字节模式）。 */
function byteCapacity(version, ec) {
  return Math.floor((dataCodewordCount(version, ec) * 8 - 4 - charCountBits(version)) / 8);
}

// ---------------------------------------------------------- 里德-所罗门纠错

/** GF(256) 的本原多项式，标准就是 0x11D。 */
const GF_PRIMITIVE = 0x11d;

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function buildGfTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_PRIMITIVE;
  }
  // 表翻倍，乘法时指数相加就不用再取模
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

/** 伽罗华域乘法。 */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 算纠错码用的生成多项式，结果按最高次在前排列，最高次系数固定是 1。 */
function rsGenerator(degree) {
  let poly = [1]; // 先按最低次在前存
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let k = 0; k < poly.length; k++) {
      next[k] ^= gfMul(poly[k], GF_EXP[i]); // 保持次数，系数乘上 α 的 i 次方
      next[k + 1] ^= poly[k]; // 乘 x，次数加一
    }
    poly = next;
  }
  return poly.reverse(); // 翻成最高次在前
}

/** 给一块数据算纠错码，返回正好 degree 个字节。 */
function rsEncode(data, degree) {
  const gen = rsGenerator(degree);
  const buf = new Uint8Array(data.length + degree);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      buf[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return buf.slice(data.length);
}

// -------------------------------------------------------------- 拼数据并交织

/**
 * 把字节数据拼成比特流：模式指示符 0100、长度、数据本身，
 * 然后补终止符、补到整字节、交替补 0xEC 和 0x11。
 */
function buildCodewords(bytes, version, ec) {
  const capacityBits = dataCodewordCount(version, ec) * 8;
  const bits = [];

  putBits(bits, 0b0100, 4); // 8 位字节模式
  putBits(bits, bytes.length, charCountBits(version));
  for (const b of bytes) putBits(bits, b, 8);

  // 终止符最多补四个 0
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  // 补到整字节
  while (bits.length % 8 !== 0) bits.push(0);
  // 还不够就交替补 0xEC 和 0x11
  let pad = 0xec;
  while (bits.length < capacityBits) {
    putBits(bits, pad, 8);
    pad = pad === 0xec ? 0x11 : 0xec;
  }

  return bitsToBytes(bits);
}

/**
 * 按规则分块，每块单独算纠错码，再把数据字节和纠错字节分别交织起来。
 * 返回最终要铺进矩阵的字节流。
 */
function interleave(dataCodewords, version, ec) {
  const total = totalCodewords(version);
  const ecTotal = ecTotalCodewords(version, ec);
  const dataTotal = total - ecTotal;
  const blocks = ecBlockCount(version, ec);

  // 分两组：后面几块比前面几块多一个数据字节，每块的纠错字节数都一样
  const blocksInGroup2 = total % blocks;
  const blocksInGroup1 = blocks - blocksInGroup2;
  const dataSize1 = Math.floor(dataTotal / blocks);
  const dataSize2 = dataSize1 + 1;
  const ecPerBlock = Math.floor(total / blocks) - dataSize1;

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < blocks; b++) {
    const size = b < blocksInGroup1 ? dataSize1 : dataSize2;
    const chunk = dataCodewords.subarray(offset, offset + size);
    dataBlocks.push(chunk);
    ecBlocks.push(rsEncode(chunk, ecPerBlock));
    offset += size;
  }

  const out = new Uint8Array(total);
  let index = 0;

  // 先按列交织所有数据字节
  for (let i = 0; i < dataSize2; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < dataBlocks[b].length) out[index++] = dataBlocks[b][i];
    }
  }
  // 再交织所有纠错字节
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < blocks; b++) out[index++] = ecBlocks[b][i];
  }

  return out;
}

// -------------------------------------------------------------- 格式和版本信息

/** 一个整数的二进制位数。 */
function bitLength(n) {
  let len = 0;
  while (n !== 0) {
    len++;
    n >>>= 1;
  }
  return len;
}

/** 15 位格式信息：2 位等级加 3 位掩码号，后面跟 10 位 BCH 校验，最后异或 0x5412。 */
function formatInfoBits(ec, mask) {
  const data = (EC_FORMAT_BITS[ec] << 3) | mask;
  let rest = data << 10;
  const generator = 0x537; // 10100110111
  while (bitLength(rest) - bitLength(generator) >= 0) {
    rest ^= generator << (bitLength(rest) - bitLength(generator));
  }
  return ((data << 10) | rest) ^ 0x5412;
}

/** 18 位版本信息：6 位版本号加 12 位 BCH 校验，版本 7 及以上才有。 */
function versionInfoBits(version) {
  let rest = version << 12;
  const generator = 0x1f25; // 1111100100101
  while (bitLength(rest) - bitLength(generator) >= 0) {
    rest ^= generator << (bitLength(rest) - bitLength(generator));
  }
  return (version << 12) | rest;
}

// ---------------------------------------------------------------------- 矩阵

/** 对齐图案的中心坐标；版本 1 没有对齐图案。 */
function alignmentCoords(version) {
  if (version === 1) return [];
  const size = symbolSize(version);
  const count = Math.floor(version / 7) + 2;
  // 版本 32 的间距是标准里单独写死的 26，其余按公式算
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < count - 1; i++) positions.push(positions[i - 1] - step);
  positions.push(6);
  return positions.reverse();
}

/** 掩码规则：返回这个位置要不要翻转。 */
function maskBit(mask, y, x) {
  switch (mask) {
    case 0:
      return (y + x) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (y + x) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((y * x) % 2) + ((y * x) % 3) === 0;
    case 6:
      return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0;
    case 7:
      return (((y * x) % 3) + ((y + x) % 2)) % 2 === 0;
    default:
      throw new Error("掩码编号只能是 0 到 7，收到：" + mask);
  }
}

/** 空矩阵：modules 存黑点，reserved 记「这里已经画了功能图形，掩码别碰」。 */
function emptyMatrix(size) {
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  return { modules, reserved };
}

/** 画一个点，默认同时标记成功能区。 */
function put(matrix, y, x, dark, isReserved = true) {
  matrix.modules[y][x] = dark;
  if (isReserved) matrix.reserved[y][x] = true;
}

/** 三个角上的定位图案，外加一圈浅色分隔符。 */
function drawFinderPatterns(matrix) {
  const size = matrix.modules.length;
  const corners = [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ];
  for (const corner of corners) {
    const row = corner[0];
    const col = corner[1];
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = row + r;
        const x = col + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        put(matrix, y, x, dark);
      }
    }
  }
}

/** 第 6 行和第 6 列的黑白相间定时图案。 */
function drawTimingPatterns(matrix) {
  const size = matrix.modules.length;
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    put(matrix, i, 6, dark);
    put(matrix, 6, i, dark);
  }
}

/** 对齐图案：5x5 的小方块，正中间是黑点。 */
function drawAlignmentPatterns(matrix, version) {
  const coords = alignmentCoords(version);
  const last = coords.length - 1;
  for (let i = 0; i < coords.length; i++) {
    for (let j = 0; j < coords.length; j++) {
      // 三个角已经被定位图案占了，跳过
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const row = coords[i];
      const col = coords[j];
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
          put(matrix, row + r, col + c, dark);
        }
      }
    }
  }
}

/** 把 15 位格式信息写到两个规定位置，顺便点上固定暗模块。 */
function drawFormatInfo(matrix, ec, mask) {
  const size = matrix.modules.length;
  const bits = formatInfoBits(ec, mask);

  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1;

    // 竖着那一份（左上角一条，左下角一条）
    if (i < 6) put(matrix, i, 8, dark);
    else if (i < 8) put(matrix, i + 1, 8, dark);
    else put(matrix, size - 15 + i, 8, dark);

    // 横着那一份（右上角一条，左上角一条，注意跳过第 6 列）
    if (i < 8) put(matrix, 8, size - i - 1, dark);
    else if (i === 8) put(matrix, 8, 7, dark);
    else put(matrix, 8, 15 - i - 1, dark);
  }

  // 固定暗模块，标准要求必须是黑的
  put(matrix, size - 8, 8, true);
}

/** 版本 7 及以上要写 18 位版本信息，右上角和左下角各一份。 */
function drawVersionInfo(matrix, version) {
  if (version < 7) return;
  const size = matrix.modules.length;
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = (i % 3) + size - 11;
    put(matrix, row, col, dark);
    put(matrix, col, row, dark);
  }
}

/** 把交织好的字节流从右下角开始蛇形铺进矩阵，跳过功能区。 */
function drawData(matrix, codewords) {
  const size = matrix.modules.length;
  let bitIndex = 0;
  let rising = true;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 第 6 列是定时图案，整列跳过
    for (let step = 0; step < size; step++) {
      const row = rising ? size - 1 - step : step;
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        if (matrix.reserved[row][x]) continue;
        let dark = false;
        if (bitIndex < codewords.length * 8) {
          dark = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
        }
        matrix.modules[row][x] = dark;
        bitIndex++;
      }
    }
    rising = !rising;
  }
}

/** 套一次掩码：只翻数据区，功能区的点保持不动。 */
function applyMask(matrix, mask) {
  const size = matrix.modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (matrix.reserved[y][x]) continue;
      if (maskBit(mask, y, x)) matrix.modules[y][x] = !matrix.modules[y][x];
    }
  }
}

// ---------------------------------------------------------------------- 罚分

/** 规则一：同一行或同一列连着五个以上同色，每多一个加一分。 */
function penaltyN1(modules) {
  const size = modules.length;
  let score = 0;
  for (let i = 0; i < size; i++) {
    for (let horizontal = 0; horizontal < 2; horizontal++) {
      let run = 1;
      let prev = horizontal ? modules[i][0] : modules[0][i];
      for (let j = 1; j < size; j++) {
        const cur = horizontal ? modules[i][j] : modules[j][i];
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          prev = cur;
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }
  return score;
}

/** 规则二：每个 2x2 全是同色的小方块扣 3 分。 */
function penaltyN2(modules) {
  const size = modules.length;
  let score = 0;
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const a = modules[y][x];
      if (a === modules[y][x + 1] && a === modules[y + 1][x] && a === modules[y + 1][x + 1]) score += 3;
    }
  }
  return score;
}

/** 规则三：出现一比一比三比一比一且旁边有四格浅色，每处扣 40 分。 */
function penaltyN3(modules) {
  const size = modules.length;
  let score = 0;
  for (let i = 0; i < size; i++) {
    let rowBits = 0;
    let colBits = 0;
    for (let j = 0; j < size; j++) {
      rowBits = ((rowBits << 1) & 0x7ff) | (modules[i][j] ? 1 : 0);
      colBits = ((colBits << 1) & 0x7ff) | (modules[j][i] ? 1 : 0);
      if (j >= 10) {
        if (rowBits === 0x5d0 || rowBits === 0x05d) score += 40;
        if (colBits === 0x5d0 || colBits === 0x05d) score += 40;
      }
    }
  }
  return score;
}

/** 规则四：黑点比例离一半越远扣分越多，每差百分之五扣 10 分。 */
function penaltyN4(modules) {
  const size = modules.length;
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
  }
  const total = size * size;
  // 标准算的是「黑点比例离一半差了几个完整的百分之五」，往下取整。
  // 用整数算避免小数误差：|20*黑点 - 10*总数| / 总数 就是偏离的百分之五的个数。
  const deviation = Math.abs(20 * dark - 10 * total);
  return Math.floor(deviation / total) * 10;
}

/** 四条规则加起来的总罚分。 */
function penaltyScore(modules) {
  return penaltyN1(modules) + penaltyN2(modules) + penaltyN3(modules) + penaltyN4(modules);
}

// -------------------------------------------------------------------- 主流程

/**
 * 把一段文字编成二维码。
 * @param {string} text 要编码的文字，按 UTF-8 当字节处理
 * @param {{ec?: "L"|"M"|"Q"|"H"}} [options] ec 是纠错等级，默认 M
 * @returns {{version: number, ec: string, size: number, mask: number, modules: boolean[][]}} modules[y][x] 为 true 表示黑点，mask 是最后选中的掩码号
 */
export function encodeQr(text, { ec = "M" } = {}) {
  if (typeof text !== "string") {
    throw new Error("要编码的内容必须是一段文字");
  }
  const level = String(ec).toUpperCase();
  ecIndex(level); // 等级写错直接抛中文错误

  const bytes = new TextEncoder().encode(text);

  // 从版本 1 往上找，第一个装得下的就用它
  let version = 0;
  for (let v = 1; v <= 40; v++) {
    if (bytes.length <= byteCapacity(v, level)) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    throw new Error(
      "内容太长，二维码装不下：一共 " +
        bytes.length +
        " 个字节，最高版本 40 加 " +
        level +
        " 级纠错也只能放 " +
        byteCapacity(40, level) +
        " 个字节",
    );
  }

  const codewords = interleave(buildCodewords(bytes, version, level), version, level);

  const size = symbolSize(version);
  const matrix = emptyMatrix(size);

  drawFinderPatterns(matrix);
  drawTimingPatterns(matrix);
  drawAlignmentPatterns(matrix, version);
  drawFormatInfo(matrix, level, 0); // 先占位，让这些位置被标记成功能区
  drawVersionInfo(matrix, version);
  drawData(matrix, codewords);

  // 八种掩码逐个试，挑罚分最低的那个
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(matrix, mask);
    drawFormatInfo(matrix, level, mask);
    const score = penaltyScore(matrix.modules);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    applyMask(matrix, mask); // 翻回去，好试下一个
  }

  applyMask(matrix, bestMask);
  drawFormatInfo(matrix, level, bestMask);

  return { version, ec: level, size, mask: bestMask, modules: matrix.modules };
}

// -------------------------------------------------------------------- 输出

/** 转义 XML 里的特殊字符，免得标题里带尖括号把 SVG 弄坏。 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 把点阵变成一条紧凑的路径命令。
 * 每一行里连续的几个黑点合成一个矩形，写法就是先移动到左上角，横着走宽度，竖着走一格，再退回起点。
 * @param {boolean[][]} modules 点阵
 * @param {{margin?: number}} [options] margin 是四周留出的静区宽度，单位是模块
 */
export function matrixToPath(modules, { margin = 4 } = {}) {
  const size = modules.length;
  const parts = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!modules[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && modules[y][x + run]) run++;
      parts.push("M" + (x + margin) + " " + (y + margin) + "h" + run + "v1h-" + run + "z");
      x += run;
    }
  }
  return parts.join("");
}

/**
 * 直接输出一段完整的 SVG 二维码，前端拿到就能塞进页面。
 * @param {string} text 要编码的文字
 * @param {{ec?: string, scale?: number, margin?: number, dark?: string, light?: string, title?: string}} [options]
 */
export function toSvg(text, { ec = "M", scale = 8, margin = 4, dark = "#000", light = "#fff", title = "" } = {}) {
  const result = encodeQr(text, { ec });
  const size = result.size;
  const side = size + margin * 2;
  const pixels = side * scale;
  const path = matrixToPath(result.modules, { margin });
  const titleTag = title ? "<title>" + escapeXml(title) + "</title>" : "";
  const darkColor = escapeXml(dark);
  const lightColor = escapeXml(light);

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    pixels +
    '" height="' +
    pixels +
    '" viewBox="0 0 ' +
    side +
    " " +
    side +
    '" shape-rendering="crispEdges" role="img">' +
    titleTag +
    '<rect width="' +
    side +
    '" height="' +
    side +
    '" fill="' +
    lightColor +
    '"/>' +
    '<path d="' +
    path +
    '" fill="' +
    darkColor +
    '"/>' +
    "</svg>"
  );
}