import assert from "node:assert/strict";
import { test } from "node:test";

import { LruCache } from "../../src/offscreen/lru.ts";
import { describeEngine, initialEngineStatus, isClassifyRequest, isOffscreenMessage } from "../../src/shared/protocol.ts";

const valid = { type: "cs:classify", generation: 3, mode: "balanced", topics: [{ id: "t", text: "crypto" }], texts: ["hello world"] };

test("isClassifyRequest accepts well-formed requests", () => {
  assert.ok(isClassifyRequest(valid));
});

test("isClassifyRequest rejects malformed or oversized payloads", () => {
  const cases: unknown[] = [
    null,
    "x",
    { ...valid, type: "other" },
    { ...valid, generation: 1.5 },
    { ...valid, mode: "turbo" },
    { ...valid, topics: [{ id: 1, text: "x" }] },
    { ...valid, topics: Array.from({ length: 21 }, (_, i) => ({ id: String(i), text: "x" })) },
    { ...valid, texts: [42] },
    { ...valid, texts: Array.from({ length: 65 }, () => "x") },
    { ...valid, texts: ["x".repeat(2001)] },
  ];
  for (const c of cases) assert.equal(isClassifyRequest(c), false, JSON.stringify(c)?.slice(0, 80));
});

test("isOffscreenMessage requires the offscreen target", () => {
  assert.ok(isOffscreenMessage({ type: "off:status", target: "offscreen" }));
  assert.ok(isOffscreenMessage({ ...valid, type: "off:classify", target: "offscreen", frameKey: "1:0:x" }));
  assert.ok(!isOffscreenMessage({ ...valid, type: "off:classify", frameKey: "1:0:x" }));
  assert.ok(!isOffscreenMessage({ ...valid, type: "off:classify", target: "offscreen" }));
});

test("engine descriptions are honest about the active mode", () => {
  const s = initialEngineStatus("m");
  assert.match(describeEngine({ ...s, state: "semantic", backend: "cpu" }), /Semantic engine active \(CPU\)/);
  assert.match(describeEngine({ ...s, state: "lexical-fallback" }), /Keyword matching only/);
});

test("LRU evicts least recently used entries", () => {
  const c = new LruCache<string, number>(2);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1); // a is now most recent
  c.set("c", 3);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  assert.equal(c.size, 2);
  assert.throws(() => new LruCache(0));
});
