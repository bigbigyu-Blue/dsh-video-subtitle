import test from "node:test";
import assert from "node:assert/strict";
import { EC_LEVELS, encodeQr, matrixToPath, toSvg } from "../lib/qr.js";

// 参照包只在这台机器上可能有，别的机器上没有就跳过比对，绝不让整组测试失败
const REF_PATHS = [
  "file:///C:/Users/Administrator/.dsh/profiles/desktop/node_modules/qrcode/lib/core/qrcode.js",
];

/** 找参照实现，找不到就返回 null。 */
async function loadReference() {
  for (const candidate of REF_PATHS) {
    try {
      const mod = await import(candidate);
      const create = mod.create || (mod.default && mod.default.create);
      if (typeof create === "function") return create;
    } catch {
      // 这个位置没有，继续试下一个
    }
  }
  return null;
}

/**
 * 从自己生成的矩阵里按标准位置读回 15 位格式信息。
 * 两处副本各读一遍，返回 { ec, mask }；两处不一致就抛错。
 */
function readFormatInfo(modules) {
  const size = modules.length;

  // 第一份：绕着左上角那个定位图案摆的那一圈
  const first = [];
  for (let i = 0; i <= 14; i++) {
    let x;
    let y;
    if (i < 6) {
      x = 8;
      y = i;
    } else if (i < 8) {
      x = 8;
      y = i + 1;
    } else if (i < 9) {
      x = 7;
      y = 8;
    } else {
      x = 14 - i;
      y = 8;
    }
    first.push(modules[y][x]);
  }

  // 第二份：右上角横着一条（前 8 位）加左下角竖着一条（后 7 位）
  const second = [];
  for (let i = 0; i <= 14; i++) {
    let x;
    let y;
    if (i < 8) {
      x = size - 1 - i;
      y = 8;
    } else {
      x = 8;
      y = size - 15 + i;
    }
    second.push(modules[y][x]);
  }

  const decode = (cells) => {
    let bits = 0;
    for (let i = 0; i < cells.length; i++) if (cells[i]) bits |= 1 << i;
    const raw = bits ^ 0x5412;
    const ecBits = (raw >>> 13) & 0b11;
    const mask = (raw >>> 10) & 0b111;
    return { ecBits, mask };
  };

  const a = decode(first);
  const b = decode(second);
  assert.equal(a.ecBits, b.ecBits, "两份格式信息里的纠错等级应当一样");
  assert.equal(a.mask, b.mask, "两份格式信息里的掩码号应当一样");

  const ecByBits = { 1: "L", 0: "M", 3: "Q", 2: "H" };
  return { ec: ecByBits[a.ecBits], mask: a.mask };
}

/** 把参照包返回的扁平数组换成二维布尔数组，方便逐格比。 */
function referenceCells(ref) {
  const size = ref.modules.size;
  const data = ref.modules.data;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push(Boolean(data[y * size + x]));
    rows.push(row);
  }
  return rows;
}

/** 逐格比对两块点阵，返回对不上的格子清单（最多留 10 条，免得报错信息太长）。 */
function diffCells(mine, other) {
  const bugs = [];
  const size = mine.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (mine[y][x] !== other[y][x] && bugs.length < 10) bugs.push("(" + x + "," + y + ")");
    }
  }
  return bugs;
}

test("自己算的点阵跟参照包逐格一致（拿不到参照包就跳过）", async (t) => {
  const create = await loadReference();
  if (!create) {
    t.skip("本机没有参照用的 qrcode 包，跳过比对");
    return;
  }

  const samples = [
    "HELLO",
    "https://www.bilibili.com",
    "你好，B站扫码登录",
    "aZ09_x-Y.z~!@#$%^&*()",
    "0123456789".repeat(9),
  ];

  for (const text of samples) {
    for (const ec of EC_LEVELS) {
      const mine = encodeQr(text, { ec });
      // 参照包会自动挑模式，纯数字纯字母会被它切成别的段，所以这里强制它也走字节模式
      // 掩码也强制成我们自己选的那个，这样比的是数据区加纠错区的每一位
      const ref = create([{ data: text, mode: "byte" }], {
        errorCorrectionLevel: ec,
        maskPattern: mine.mask,
      });

      assert.equal(ref.version, mine.version, "版本号应当一样：" + text + " / " + ec);
      assert.equal(ref.modules.size, mine.size, "尺寸应当一样：" + text + " / " + ec);

      const bugs = diffCells(mine.modules, referenceCells(ref));
      assert.deepEqual(bugs, [], "点阵应当逐格一致：" + text + " / " + ec + "，对不上：" + bugs.join(" "));
    }
  }
});

test("版本 1 的 HELLO 是 21 乘 21，尺寸等于 17 加 4 乘版本号", () => {
  const hello = encodeQr("HELLO");
  assert.equal(hello.version, 1);
  assert.equal(hello.size, 21);
  assert.equal(hello.modules.length, 21);
  assert.equal(hello.modules[0].length, 21);

  // 换几段长短不同的内容，尺寸公式都得对得上
  const samples = ["A", "x".repeat(60), "x".repeat(400), "x".repeat(1200)];
  for (const text of samples) {
    const result = encodeQr(text);
    assert.equal(result.size, 17 + 4 * result.version, "尺寸公式不对，版本 " + result.version);
    assert.equal(result.modules.length, result.size);
  }
});

test("toSvg 能给出完整的 SVG 字符串", () => {
  const svg = toSvg("HELLO");
  assert.ok(svg.startsWith("<svg"), "应当以 <svg 开头");
  assert.ok(svg.includes("viewBox="), "应当带 viewBox");
  assert.ok(svg.includes("<path"), "应当有 <path> 画黑点");
  assert.ok(svg.endsWith("</svg>"), "应当以 </svg> 结尾");
  assert.ok(!svg.includes("NaN"), "里面不该出现 NaN");

  // 静区要算进总尺寸：点阵 21 格加两边各 4 格静区等于 29
  assert.ok(svg.includes('viewBox="0 0 29 29"'), "静区算错了");

  // 标题可选，给了就要转义后放进去
  const titled = toSvg("HELLO", { title: "扫码登录 <B站>" });
  assert.ok(titled.includes("<title>扫码登录 &lt;B站&gt;</title>"), "标题转义不对");
  assert.ok(!toSvg("HELLO").includes("<title>"), "没给标题就不该硬塞 title");
});

test("内容太长时抛中文错误", () => {
  assert.throws(() => encodeQr("x".repeat(3000)), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /内容太长，二维码装不下/);
    return true;
  });
});

test("matrixToPath 给的是紧凑路径命令", () => {
  const { modules } = encodeQr("HELLO");
  const path = matrixToPath(modules);
  assert.ok(path.startsWith("M"), "应当以 M 开头");
  assert.ok(!path.includes("NaN"), "里面不该出现 NaN");
  assert.ok(!path.includes("undefined"), "里面不该出现 undefined");
  // 每一段都是「移动 横走 竖走 退回 合拢」这一套
  const commands = path.match(/M\d+ \d+h\d+v1h-\d+z/g) || [];
  assert.ok(commands.length > 0, "应当至少有一个矩形命令");
  assert.equal(commands.join(""), path, "命令之外不该混进别的东西");

  // 所有矩形加起来盖住的格子，正好等于矩阵里黑点的个数
  let covered = 0;
  for (const one of commands) {
    const m = one.match(/^M(\d+) (\d+)h(\d+)v1h-\d+z$/);
    covered += Number(m[3]);
  }
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  assert.equal(covered, dark, "路径盖住的格子数应当等于黑点数");

  // 静区要算进坐标：左上角第一个黑点从 (4,4) 起，连着 7 个点就是定位图案的顶边
  assert.ok(path.startsWith("M4 4h7v1h-7z"), "静区没算进坐标");
});

test("四个纠错等级都能编出结果，H 的版本不低于 L", () => {
  const text = "https://www.bilibili.com/video/BV1xx411c7mD";
  const versions = {};
  for (const ec of EC_LEVELS) {
    const result = encodeQr(text, { ec });
    assert.equal(result.ec, ec);
    assert.ok(result.version >= 1 && result.version <= 40);
    assert.equal(result.modules.length, result.size);
    versions[ec] = result.version;
  }
  assert.ok(versions.H >= versions.L, "纠错要求越高，占的地方只会一样多或更多");
  assert.ok(versions.Q >= versions.M, "纠错要求越高，占的地方只会一样多或更多");
});

test("从自己画的矩阵里读回格式信息，等级与掩码号跟编码时完全一致", () => {
  const samples = ["HELLO", "你好，B站扫码登录", "x".repeat(200)];
  for (const text of samples) {
    for (const ec of EC_LEVELS) {
      const result = encodeQr(text, { ec });
      const decoded = readFormatInfo(result.modules);
      assert.equal(decoded.ec, ec, "读回来的纠错等级不对：" + text + " / " + ec);
      assert.equal(decoded.mask, result.mask, "读回来的掩码号不对：" + text + " / " + ec);
      assert.ok(result.mask >= 0 && result.mask <= 7, "掩码号只能是 0 到 7");
    }
  }
});

test("版本 7 及以上的版本信息写对了（标准值 0x07C94 起）", () => {
  // 标准里 18 位版本信息的已知取值，从版本 7 开始
  const KNOWN = [0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847];

  // 找一个能把版本顶到 7 的内容，纯字母按字节模式算
  let text = "x".repeat(100);
  while (encodeQr(text).version < 7) text += "x";

  const result = encodeQr(text);
  assert.ok(result.version >= 7, "这段内容应当落在版本 7 以上");

  let bits = 0;
  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3);
    const col = result.size - 11 + (i % 3);
    if (result.modules[row][col]) bits |= 1 << i;
    // 左下角那一份要跟右上角那一份完全一样
    assert.equal(result.modules[col][row], result.modules[row][col], "两份版本信息应当一致");
  }

  assert.equal(bits >>> 12, result.version, "版本信息里的版本号不对");
  if (result.version === 7) assert.equal(bits, KNOWN[0], "版本 7 的版本信息应当是 0x07C94");
  // 18 位里剩下的 12 位是 BCH 校验，得跟表里对应的取值对得上
  assert.equal(bits, KNOWN[result.version - 7], "版本 " + result.version + " 的版本信息不对");
});
