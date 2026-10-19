import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { extractKeys, mixinKey, wbiSign, resetKeyCache } from "../lib/wbi.js";

// 官方 mixinKey 表是固定的，用一个「按表取值」的独立实现交叉验证，避免自己验自己
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

test("从 nav 的图片地址里取出两段 key", () => {
  const keys = extractKeys({
    img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
    sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
  });
  assert.equal(keys.imgKey, "7cd084941338484aae1ad9425b84077c");
  assert.equal(keys.subKey, "4932caff0ff746eab6f01bf08b70ac45");
});

test("mixinKey 按固定顺序重排后取前 32 位", () => {
  const img = "7cd084941338484aae1ad9425b84077c";
  const sub = "4932caff0ff746eab6f01bf08b70ac45";
  const raw = img + sub;
  const expected = MIXIN.map((i) => raw[i] ?? "").join("").slice(0, 32);
  assert.equal(mixinKey(img, sub), expected);
  assert.equal(mixinKey(img, sub).length, 32);
});

test("签名结果稳定，且与参数顺序无关", () => {
  const keys = { imgKey: "7cd084941338484aae1ad9425b84077c", subKey: "4932caff0ff746eab6f01bf08b70ac45" };
  const at = 1700000000000;
  const a = wbiSign({ bvid: "BV1xx411c7mD", cid: 123 }, keys, at);
  const b = wbiSign({ cid: 123, bvid: "BV1xx411c7mD" }, keys, at);
  assert.equal(a, b, "参数顺序不该影响签名");
  assert.match(a, /^bvid=BV1xx411c7mD&cid=123&wts=1700000000&w_rid=[0-9a-f]{32}$/);
});

test("签名里的 w_rid 就是 query 拼 mixinKey 的 md5", () => {
  const keys = { imgKey: "7cd084941338484aae1ad9425b84077c", subKey: "4932caff0ff746eab6f01bf08b70ac45" };
  const at = 1700000000000;
  const signed = wbiSign({ bvid: "BV1xx411c7mD" }, keys, at);
  const query = signed.split("&w_rid=")[0];
  const expected = createHash("md5").update(query + mixinKey(keys.imgKey, keys.subKey), "utf8").digest("hex");
  assert.equal(signed.split("&w_rid=")[1], expected);
});

test("值里的 !'()* 五个字符会先被去掉", () => {
  const keys = { imgKey: "a", subKey: "b" };
  const signed = wbiSign({ q: "he!l'l(o)*x" }, keys, 1700000000000);
  assert.match(signed, /^q=hellox&wts=/, "! ' ( ) * 五个字符去掉后剩 hellox");
});

test("重置缓存不抛错（用例之间互不影响）", () => {
  assert.doesNotThrow(() => resetKeyCache());
});
