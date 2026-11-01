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

test("persisted malformed records cannot survive cleanup or smuggle tag-name secrets", () => {
  const now = Date.now();
  const record = { ...draft, id: crypto.randomUUID(), createdAt: now, topic: '猫 🐈 <script>literal</script>', version: "0.3.1" };
  for (const bad of [null, {}, { ...record, createdAt: NaN }, { ...record, createdAt: Infinity }, { ...record, id: "bad" }, { ...record, target: { tag: "authabc123secret", ordinal: 1 } }]) assert.deepEqual(retainedFeedback([bad], now), []);
  const diagnostics = { path: "authabc123secret:nth-of-type(1) > p:nth-of-type(1)", analyzed: false, matched: null, via: null, score: null, similarity: null, rivalled: null, backend: null, state: "idle" };
  assert.equal(sanitizeFeedback({ ...draft, diagnostics }), null);
  assert.equal(retainedFeedback([{ ...record, createdAt: now - FEEDBACK_TTL_MS + 1 }], now).length, 1);
  assert.equal(retainedFeedback([record], now)[0]?.topic, record.topic);
});

test("idle storage expires only on activity; restart prunes and delete/save ordering stays deterministic", async () => {
  let storage: Record<string, any> = {};
  (globalThis as any).chrome = { runtime: { getManifest: () => ({ version: "0.3.1" }) }, storage: { local: {
    get: async () => structuredClone(storage), set: async (v: object) => { storage = { ...storage, ...v }; }, remove: async (k: string) => { delete storage[k]; },
  } } };
  try {
    const s = { ...defaultSettings(), mode: "balanced" as const, topics: [{ id: "t", text: "cats", enabled: true }, { id: "f", text: "football", enabled: true }] };
    const store = new FeedbackStore();
    const save = (topicId = "t") => store.run("feedback:save", { ...draft, topicId }, async () => s, "https://fixture.example/");
    await save(); await save("f");
    assert.deepEqual(storage.clearscroll_feedback.map((r: any) => r.topic), ["cats", "football"]);
    storage.clearscroll_feedback[0].createdAt = Date.now() - FEEDBACK_TTL_MS;
    assert.equal(storage.clearscroll_feedback.length, 2, "no timer rewrites inactive storage");
    const restarted = new FeedbackStore();
    await restarted.run("feedback:prune", null, async () => s);
    assert.equal(storage.clearscroll_feedback.length, 1);
    const jobs = [save(), store.run("feedback:clear", null, async () => s), save("f")];
    await Promise.all(jobs);
    assert.equal(storage.clearscroll_feedback.length, 1);
    assert.equal(storage.clearscroll_feedback[0].topic, "football");
    await store.run("feedback:clear", null, async () => s);
    assert.equal(storage.clearscroll_feedback, undefined);
  } finally { delete (globalThis as any).chrome; }
});
