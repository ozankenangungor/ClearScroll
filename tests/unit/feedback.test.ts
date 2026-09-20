import assert from "node:assert/strict";
import { test } from "node:test";
import { FEEDBACK_TTL_MS, retainedFeedback, sanitizeFeedback } from "../../src/shared/feedback.ts";
import { FeedbackStore } from "../../src/background/feedback-store.ts";
import { defaultSettings } from "../../src/shared/settings.ts";
const draft = { kind: "should-hide", topicId: "t", mode: "balanced", decision: "visible", target: { tag: "p", ordinal: 2 }, diagnostics: null };
test("feedback allowlist strips sensitive fields; rejects malformed diagnostics", () => {
  assert.deepEqual(sanitizeFeedback({ ...draft, text: "secret", url: "private", target: { ...draft.target, id: "account" } }), draft);
  for (const bad of [null, {}, { ...draft, decision: "hidden" }, { ...draft, target: { tag: "private-id", ordinal: 2 } }, { ...draft, diagnostics: { path: "#account" } }]) assert.equal(sanitizeFeedback(bad), null);
  const d = { path: "body:nth-of-type(1) > p:nth-of-type(2)", analyzed: true, matched: false, via: null, score: 0.2, similarity: 0.3, rivalled: false, backend: "cpu", state: "semantic" };
  assert.deepEqual(sanitizeFeedback({ ...draft, diagnostics: { ...d, text: "secret" } })?.diagnostics, d);
  assert.equal(sanitizeFeedback({ ...draft, diagnostics: { ...d, score: Infinity } }), null);
});
test("retention expires old/future records and caps storage", () => {
  const now = Date.now();
  const record = { ...draft, id: crypto.randomUUID(), createdAt: now, topic: "cats", version: "0.3.1" };
  assert.equal(retainedFeedback([{ ...record, createdAt: now - FEEDBACK_TTL_MS }, { ...record, createdAt: now + 1 }], now).length, 0);
  assert.equal(retainedFeedback(Array(150).fill(record), now).length, 100);
});
test("serialized multi-tab saves, deletion, and current site/topic/consent validation", async () => {
  let storage: Record<string, unknown> = {};
  (globalThis as any).chrome = { runtime: { getManifest: () => ({ version: "0.3.1" }) }, storage: { local: {
    get: async () => structuredClone(storage), set: async (v: object) => { storage = { ...storage, ...v }; }, remove: async (k: string) => { delete storage[k]; },
  } } };
  const s = { ...defaultSettings(), mode: "balanced" as const, topics: [{ id: "t", text: "cats", enabled: true }] };
  const store = new FeedbackStore();
  const save = () => store.run("feedback:save", { ...draft, pageText: "private" }, async () => s, "https://public.example/");
  await Promise.all(Array.from({ length: 110 }, save));
  const list = await store.run("feedback:list", null, async () => s) as any;
  assert.equal(list.records.length, 100);
  assert.equal(new Set(list.records.map((r: any) => r.id)).size, 100);
  assert(!JSON.stringify(list).includes("private"));
  await assert.rejects(store.run("feedback:save", draft, async () => ({ ...s, enabled: false }), "https://public.example/"));
  await assert.rejects(store.run("feedback:save", draft, async () => ({ ...s, excludedSites: ["public.example"] }), "https://public.example/"));
  await assert.rejects(store.run("feedback:save", { ...draft, topicId: "disabled" }, async () => s, "https://public.example/"));
  await store.run("feedback:clear", null, async () => s);
  assert.equal((await store.run("feedback:list", null, async () => s) as any).records.length, 0);
  delete (globalThis as any).chrome;
});
