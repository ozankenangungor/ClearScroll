import assert from "node:assert/strict";
import { test } from "node:test";

import { LEXICAL_PARAMS, decide, prepareTopic, type ModeParams } from "../../src/shared/classifier.ts";
import { compileLexicalRule, matchLexical, normalizeLexical, prepareLexicalText } from "../../src/shared/lexical.ts";

test("lexical normalisation strips accents and collapses whitespace", () => {
  assert.equal(normalizeLexical("  Café\n\tRÉSUMÉ  "), "cafe resume");
  assert.equal(normalizeLexical("Şırnak'ta İstanbul"), "sırnak'ta istanbul");
});

test("whole-phrase matches respect word boundaries", () => {
  const rule = compileLexicalRule("web3", LEXICAL_PARAMS.precision);
  assert.ok(matchLexical(rule, prepareLexicalText("All about Web3 today")));
  assert.ok(!matchLexical(rule, prepareLexicalText("All about web30 today")));
});

test("multi-word topics require enough significant words", () => {
  const rule = compileLexicalRule("elections and government", LEXICAL_PARAMS.precision);
  assert.deepEqual(rule.tokens, ["elections", "government"]);
  assert.ok(matchLexical(rule, prepareLexicalText("The government postponed the elections.")));
  assert.ok(!matchLexical(rule, prepareLexicalText("The government met today.")));
  // Short words ("and") are ignored, so they cannot cause matches.
  assert.ok(!matchLexical(rule, prepareLexicalText("Bread and butter")));
});

test("regex metacharacters in topics are treated literally", () => {
  const rule = compileLexicalRule("c++ (lang)", LEXICAL_PARAMS.balanced);
  assert.ok(matchLexical(rule, prepareLexicalText("I write c++ (lang) daily")));
  assert.ok(!matchLexical(rule, prepareLexicalText("I write cxx lang daily")));
});

const dim = 2;
const params: ModeParams = { threshold: 0.5, minSemanticChars: 10, lexical: LEXICAL_PARAMS.precision };
const vec = (x: number, y: number) => Float32Array.from([x, y]);

test("semantic match above threshold selects the best topic", () => {
  const topics = [prepareTopic({ id: "a", text: "alpha" }, vec(1, 0), params), prepareTopic({ id: "b", text: "beta" }, vec(0, 1), params)];
  const texts = ["something long enough", "another long enough text", "a third long enough text"];
  const flat = Float32Array.from([0.9, 0.1, 0.2, 0.8, 0.3, 0.3]);
  const d = decide(texts, flat, dim, topics, params);
  assert.deepEqual(d.map((x) => [x.matched, x.topicId, x.via]), [[true, "a", "semantic"], [true, "b", "semantic"], [false, null, null]]);
  assert.ok(Math.abs(d[0]!.score - 0.9) < 1e-6);
});

test("threshold is inclusive and short texts never match semantically", () => {
  const topics = [prepareTopic({ id: "a", text: "alpha" }, vec(1, 0), params)];
  const d = decide(["exactly at threshold", "short"], Float32Array.from([0.5, 0, 0.99, 0]), dim, topics, params);
  assert.equal(d[0]!.matched, true);
  assert.equal(d[1]!.matched, false);
});

test("lexical rules apply when semantic misses or is unavailable", () => {
  const topics = [prepareTopic({ id: "c", text: "bitcoin" }, null, params)];
  const d = decide(["Bitcoin is up", "nothing here"], null, 0, topics, params);
  assert.deepEqual(d.map((x) => [x.matched, x.via, x.score]), [[true, "lexical", 0], [false, null, 0]]);
});

test("no topics → nothing matches", () => {
  assert.deepEqual(decide(["anything at all here"], vec(1, 0), dim, [], params).map((d) => d.matched), [false]);
});

test("embedding size mismatch is an error, not a silent wrong answer", () => {
  assert.throws(() => decide(["a", "b"], vec(1, 0), dim, [], params), /expected 4/);
});

test("topic templates insert the topic literally ($ patterns are not special)", async () => {
  const { applyTopicTemplate } = await import("../../src/shared/models.ts");
  assert.equal(applyTopicTemplate("Ke$$ha", "about {topic}"), "about Ke$$ha");
  assert.equal(applyTopicTemplate("$&", "about {topic}"), "about $&");
  assert.equal(applyTopicTemplate("a$'b", "{topic}"), "a$'b");
});

test("margin scoring: a text similar to every topic does not match; topic-specific text does", async () => {
  const { decide, prepareTopic, LEXICAL_PARAMS } = await import("../../src/shared/classifier.ts");
  const norm = (v: number[]) => { const n = Math.hypot(...v); return Float32Array.from(v.map((x) => x / n)); };
  const params = { threshold: 0.1, minSemanticChars: 5, lexical: LEXICAL_PARAMS.balanced };
  // dims: [topic, background-1, background-2, generic-ui]
  const topicVec = norm([1, 0, 0, 0.3]);
  const background = { vectors: Float32Array.from([...norm([0, 1, 0, 0.3]), ...norm([0, 0, 1, 0.3])]), count: 2 };
  const topic = prepareTopic({ id: "t", text: "crypto" }, topicVec, params, background);
  assert.deepEqual(topic.background, [0, 1]);
  const generic = norm([0.2, 0.2, 0.2, 1]); // UI-like: mildly similar to everything
  const specific = norm([1, 0.1, 0, 0.2]);
  const flat = Float32Array.from([...generic, ...specific]);
  const raw = decide(["generic ui string", "specific topic text"], flat, 4, [prepareTopic({ id: "t", text: "crypto" }, topicVec, params)], params);
  const margin = decide(["generic ui string", "specific topic text"], flat, 4, [topic], params, background);
  assert.equal(raw[0]!.matched, true, "raw cosine would match the generic text");
  assert.equal(margin[0]!.matched, false, "margin removes the common offset");
  assert.equal(margin[1]!.matched, true);
  assert.ok(Math.abs(margin[1]!.similarity - raw[1]!.score) < 1e-6, "raw similarity is still reported");
});

test("background topics that are near-synonyms of the user topic are not used against it", async () => {
  const { prepareTopic, LEXICAL_PARAMS, BACKGROUND_SIMILARITY_CUTOFF } = await import("../../src/shared/classifier.ts");
  const params = { threshold: 0.1, minSemanticChars: 5, lexical: LEXICAL_PARAMS.balanced };
  const topicVec = Float32Array.from([1, 0]);
  const background = { vectors: Float32Array.from([0.9, Math.sqrt(1 - 0.81), 0, 1]), count: 2 };
  assert.ok(0.9 >= BACKGROUND_SIMILARITY_CUTOFF);
  assert.deepEqual(prepareTopic({ id: "f", text: "football" }, topicVec, params, background).background, [1]);
});

test("a topic similar to every background topic is still scored as a margin, never as raw cosine", async () => {
  const { decide, prepareTopic, LEXICAL_PARAMS } = await import("../../src/shared/classifier.ts");
  const params = { threshold: 0.05, minSemanticChars: 5, lexical: LEXICAL_PARAMS.balanced };
  const norm = (v: number[]) => { const n = Math.hypot(...v); return Float32Array.from(v.map((x) => x / n)); };
  const topicVec = norm([1, 1, 1]); // cos ≥ 0.5 with both backgrounds → no "unrelated" ones
  const background = { vectors: Float32Array.from([...norm([1, 0.8, 0]), ...norm([0, 1, 0.9])]), count: 2 };
  const topic = prepareTopic({ id: "g", text: "news" }, topicVec, params, background);
  assert.ok(topic.background.length >= 1, "falls back to the least similar background topic");
  const text = norm([0.5, 0.6, 0.6]); // raw cosine ≈ 0.98 would be a certain match
  const d = decide(["a generic piece of text"], text, 3, [topic], params, background);
  assert.ok(d[0]!.score < d[0]!.similarity - 0.5, `margin applied (score ${d[0]!.score}, similarity ${d[0]!.similarity})`);
});

test("models scored by raw cosine ignore the background entirely", async () => {
  const { decide, prepareTopic, LEXICAL_PARAMS } = await import("../../src/shared/classifier.ts");
  const params = { threshold: 0.5, minSemanticChars: 5, lexical: LEXICAL_PARAMS.balanced };
  const t = prepareTopic({ id: "t", text: "crypto" }, Float32Array.from([1, 0]), params, null);
  assert.deepEqual(t.background, []);
  const d = decide(["some long text"], Float32Array.from([0.8, 0.6]), 2, [t], params, null);
  assert.equal(d[0]!.score, d[0]!.similarity);
});
