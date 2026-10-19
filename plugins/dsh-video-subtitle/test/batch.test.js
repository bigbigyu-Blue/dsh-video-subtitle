import test from "node:test";
import assert from "node:assert/strict";
import { parseBatchSpec, expandTargets, batchFetch } from "../lib/batch.js";

const BV_A = "BV1GJ411x7h7";
const BV_B = "BV1xx411c7mD";

/** 假的分P接口：确认请求头带了 Referer，返回一份详情。 */
function fakeView(pages, { title = "合集标题", bvid = BV_B, code = 0 } = {}) {
  const calls = [];
  const request = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers });
    return { code, data: { bvid, title, pages } };
  };
  request.calls = calls;
  return request;
}

test("parseBatchSpec：数组、多行、逗号、去重、去空都认", () => {
  assert.deepEqual(parseBatchSpec(["a", "b"]), ["a", "b"]);

  const multi = parseBatchSpec(`https://www.bilibili.com/video/${BV_A}\nhttps://b23.tv/abc`);
  assert.deepEqual(multi, [`https://www.bilibili.com/video/${BV_A}`, "https://b23.tv/abc"]);

  assert.deepEqual(parseBatchSpec(`${BV_A}, ${BV_B}`), [BV_A, BV_B]);

  // 重复项按「小写 + 去首尾空白」归一后只留第一条，顺序不变
  const dup = parseBatchSpec(` ${BV_A} , ${BV_A.toLowerCase()} ,${BV_B}`);
  assert.deepEqual(dup, [BV_A, BV_B]);

  // 空项（连续分隔符、纯空白）直接丢掉，不留空字符串
  assert.deepEqual(parseBatchSpec(" , ,\n\t "), []);
  assert.deepEqual(parseBatchSpec([]), []);
});

test("expandTargets：parts=true 时按 data.pages 展开成 P1/P2/P3", async () => {
  const request = fakeView([
    { page: 1, part: "第一集" },
    { page: 2, part: "第二集" },
    { page: 3, part: "第三集" },
  ]);
  const targets = await expandTargets([`https://www.bilibili.com/video/${BV_B}`], { request, parts: true });

  assert.equal(targets.length, 3);
  assert.deepEqual(
    targets.map((t) => t.url),
    [1, 2, 3].map((n) => `https://www.bilibili.com/video/${BV_B}?p=${n}`),
  );
  assert.deepEqual(targets.map((t) => t.page), [1, 2, 3]);
  assert.equal(targets[0].title, "合集标题 - P1 第一集");
  assert.equal(targets[2].title, "合集标题 - P3 第三集");

  // 请求必须带 Referer，否则 B 站 view 接口会拒绝
  assert.equal(request.calls.length, 1);
  assert.match(request.calls[0].url, /x\/web-interface\/view\?bvid=/);
  assert.equal(request.calls[0].headers.Referer, "https://www.bilibili.com/");
});

test("expandTargets：只有一个分P时只出一条，不重复", async () => {
  const request = fakeView([{ page: 1, part: "正片" }]);
  const targets = await expandTargets([`https://www.bilibili.com/video/${BV_B}`], { request, parts: true });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].url, `https://www.bilibili.com/video/${BV_B}?p=1`);
  assert.equal(targets[0].title, "合集标题 - P1 正片");
});

test("expandTargets：不带 ?p= 记 1，带 ?p= 保留页号", async () => {
  const plain = await expandTargets([`https://www.bilibili.com/video/${BV_A}`]);
  assert.equal(plain.length, 1);
  assert.equal(plain[0].page, 1);

  const p3 = await expandTargets([`https://www.bilibili.com/video/${BV_A}?p=3`]);
  assert.equal(p3[0].page, 3);
});

test("expandTargets：youtube 链接与乱七八糟的字符串只给 skip 原因，不抛错", async () => {
  const targets = await expandTargets([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "随便一段文字",
    `https://www.bilibili.com/video/${BV_A}`,
  ]);

  assert.equal(targets.length, 3);
  assert.match(targets[0].skip, /只支持 bilibili/);
  assert.match(targets[0].skip, /youtube/);
  assert.match(targets[1].skip, /无法识别的视频链接/);
  // 坏输入不影响后面的正常链接
  assert.equal(targets[2].skip, undefined);
  assert.equal(targets[2].page, 1);
});

/** 假的取字幕：url 里带 bad 的一律失败，其它成功。 */
function fakeFetchOne() {
  const calls = [];
  const fetchOne = async (a) => {
    calls.push(a);
    if (String(a.url).includes("bad")) {
      return {
        ok: false,
        cached: false,
        source: null,
        tracks: [],
        attempts: [{ provider: "native", result: "ERROR", detail: "视频不存在" }],
      };
    }
    return {
      ok: true,
      cached: true,
      source: "native",
      bvid: BV_A,
      page: 1,
      title: "某个视频",
      tracks: [
        { lang: "zh", langDesc: "中文", language: "zh", chars: 120, blocks: 8, path: "a.srt", coveragePct: 99, picked: true },
      ],
    };
  };
  fetchOne.calls = calls;
  return fetchOne;
}

test("batchFetch：一条成功一条失败，失败不中断整批", async () => {
  const fetchOne = fakeFetchOne();
  const res = await batchFetch({
    urls: [`https://www.bilibili.com/video/${BV_A}`, "https://www.bilibili.com/video/bad001"],
    fetchOne,
  });

  assert.equal(res.total, 2);
  assert.equal(res.failed, 1);
  assert.equal(res.ok, true, "有一条成功就算整体成功");
  assert.equal(res.items.length, 2);
  assert.equal(res.items[0].ok, true);
  assert.equal(res.items[0].cached, true);
  assert.equal(res.items[0].chars, 120);
  assert.equal(res.items[0].error, null);
  assert.equal(res.items[1].ok, false);
  assert.match(res.items[1].error, /视频不存在/);
  assert.equal(res.totalChars, 120);

  // tracks 只留汇报字段，不把整段字幕正文塞进结果
  assert.deepEqual(Object.keys(res.items[0].tracks[0]).sort(), [
    "blocks",
    "chars",
    "coveragePct",
    "language",
    "path",
  ]);
});

test("batchFetch：超过 maxItems 时如实记录被截掉的条数", async () => {
  const fetchOne = fakeFetchOne();
  const res = await batchFetch({
    urls: [`https://www.bilibili.com/video/${BV_A}?p=1`, `https://www.bilibili.com/video/${BV_A}?p=2`, `https://www.bilibili.com/video/${BV_A}?p=3`],
    fetchOne,
    maxItems: 2,
  });

  assert.equal(res.total, 3);
  assert.equal(res.truncated, 1);
  assert.equal(res.items.length, 2);
  assert.equal(fetchOne.calls.length, 2);
});

test("batchFetch：signal 已取消时立刻返回 aborted，且一次 fetchOne 都不调", async () => {
  const ac = new AbortController();
  ac.abort(new Error("用户取消"));
  const fetchOne = fakeFetchOne();

  const res = await batchFetch({
    urls: [`https://www.bilibili.com/video/${BV_A}`],
    fetchOne,
    signal: ac.signal,
  });

  assert.equal(res.aborted, true);
  assert.equal(res.items.length, 0);
  assert.equal(res.done, 0);
  assert.equal(fetchOne.calls.length, 0);
});

test("batchFetch：跑到一半被取消时保留已完成的结果", async () => {
  const ac = new AbortController();
  const fetchOne = async (a) => {
    ac.abort(new Error("跑一半取消")); // 第一条取完后外层就叫停
    return { ok: true, cached: false, source: "native", tracks: [{ language: "zh", chars: 10, blocks: 1, path: "a.srt", picked: true }] };
  };

  const res = await batchFetch({
    urls: [`https://www.bilibili.com/video/${BV_A}?p=1`, `https://www.bilibili.com/video/${BV_A}?p=2`],
    fetchOne,
  });
  assert.equal(res.items.length, 2, "没有取消开关时两条都跑完");
  assert.equal(res.aborted, false);

  const ac2 = new AbortController();
  const calls = [];
  const fetchOne2 = async (a) => {
    calls.push(a);
    ac2.abort(new Error("跑一半取消"));
    return { ok: true, cached: false, source: "native", tracks: [{ language: "zh", chars: 10, blocks: 1, path: "a.srt", picked: true }] };
  };
  const res2 = await batchFetch({
    urls: [`https://www.bilibili.com/video/${BV_A}?p=1`, `https://www.bilibili.com/video/${BV_A}?p=2`],
    fetchOne: fetchOne2,
    signal: ac2.signal,
  });
  assert.equal(res2.aborted, true);
  assert.equal(calls.length, 1, "取消后不再调下一条");
  assert.equal(res2.items.length, 1, "已完成的那条照常返回");
  assert.equal(res2.items[0].ok, true);
});
