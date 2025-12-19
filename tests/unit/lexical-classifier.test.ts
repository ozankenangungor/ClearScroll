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
