import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { decide, LEXICAL_PARAMS, prepareTopic, type ModeParams } from "../../src/shared/classifier.ts";
import { planSiblings, rivalled, SIBLING_GROUPS, SIBLING_PHRASES, topicParts, type SiblingTable } from "../../src/shared/siblings.ts";

// Synthetic geometry: every sibling phrase is its own axis, so a topic vector
// can be placed exactly relative to members and group labels.
const DIM = SIBLING_PHRASES.length + 2;
const axis = (phrase: string) => {
  const i = SIBLING_PHRASES.indexOf(phrase);
  assert.ok(i >= 0, `unknown phrase ${phrase}`);
  return i;
};
function vec(weights: Record<string, number>, extra: number[] = []): Float32Array {
  const v = new Float32Array(DIM);
  for (const [p, w] of Object.entries(weights)) v[axis(p)] = w;
  extra.forEach((w, i) => (v[SIBLING_PHRASES.length + i] = w));
  let n = 0;
  for (const x of v) n += x * x;
  return v.map((x) => x / Math.sqrt(n));
}
const table: SiblingTable = { vectors: Float32Array.from(SIBLING_PHRASES.flatMap((p) => [...vec({ [p]: 1 })])), count: SIBLING_PHRASES.length };
const animals = SIBLING_GROUPS.find((g) => g.members.includes("cats"))!;
const sports = SIBLING_GROUPS.find((g) => g.members.includes("soccer"))!;

test("topicParts splits compound topics only", () => {
  assert.deepEqual(topicParts("football and basketball"), ["football", "basketball"]);
  assert.deepEqual(topicParts("cats, dogs"), ["cats", "dogs"]);
  assert.deepEqual(topicParts("crypto & web3"), ["crypto", "web3"]);
  assert.deepEqual(topicParts("TV/film"), ["TV", "film"]);
  assert.deepEqual(topicParts("Brandon Sanderson"), ["Brandon Sanderson"]);
  assert.deepEqual(topicParts(" cats "), ["cats"]);
});

test("a topic anchored to a member competes with that member's siblings only", () => {
  const cats = vec({ cats: 1 });
  const plan = planSiblings(cats, [cats], table, DIM)!;
  assert.deepEqual(plan.anchors, ["cats"]);
  assert.deepEqual(plan.rivalNames.toSorted(), animals.members.filter((m) => m !== "cats").toSorted());
  assert.equal(plan.ownCount, 2, "the topic and its anchor");
});

test("no anchor (nothing similar enough), or a broad topic → no plan", () => {
  assert.equal(planSiblings(vec({}, [1]), [vec({}, [1])], table, DIM), null, "unrelated topic");
  const weak = vec({ cats: 0.5 }, [0.866]); // cosine 0.5 to "cats" < ANCHOR_MIN
  assert.equal(planSiblings(weak, [weak], table, DIM), null);
  // "pets": close to the member "dogs" but closer to the group label.
  const pets = vec({ "pets and animals": 0.8, dogs: 0.6 });
  assert.equal(planSiblings(pets, [pets], table, DIM), null);
});

test("members nearly as close as the anchor stay on the topic's side", () => {
  // "football": 0.74 to soccer, 0.67 to American football (within NEAR_ANCHOR).
  const football = vec({ soccer: 0.74, "American football": 0.67 });
  const plan = planSiblings(football, [football], table, DIM)!;
  assert.ok(!plan.rivalNames.includes("American football"));
  assert.ok(!plan.rivalNames.includes("soccer"));
  assert.ok(plan.rivalNames.includes("rugby") && plan.rivalNames.includes("basketball"));
});

test("each part of a compound topic is on the topic's side; a broad part removes its group", () => {
  const f = vec({ soccer: 1 }), b = vec({ basketball: 1 });
  const both = planSiblings(vec({ soccer: 1, basketball: 1 }), [f, b], table, DIM)!;
  assert.ok(!both.rivalNames.includes("basketball") && !both.rivalNames.includes("soccer"));
  assert.equal(both.rivalNames.length, sports.members.length - 2);
  const s = vec({ sports: 0.75, soccer: 0.66 }); // like the real "sports": anchors to soccer, closer to its label
  assert.equal(planSiblings(vec({ sports: 1, soccer: 1 }), [s, f], table, DIM), null, "football and sports: the sports group is the user's");
  const c = vec({ cats: 1 });
  const mixed = planSiblings(vec({ cats: 1, soccer: 1 }), [c, f], table, DIM)!;
  assert.ok(mixed.rivalNames.includes("dogs") && mixed.rivalNames.includes("rugby"));
});

test("a mismatched table (other phrases or dimension) gives no plan instead of wrong rivals", () => {
  const cats = vec({ cats: 1 });
  assert.equal(planSiblings(cats, [cats], { vectors: table.vectors.subarray(0, DIM * 3), count: 3 }, DIM), null);
});

test("rivalled: a text is vetoed only when a rival is clearly closer (ratio)", () => {
  const cats = vec({ cats: 1 });
  const plan = planSiblings(cats, [cats], table, DIM)!;
  assert.ok(rivalled(vec({ cats: 0.3, dogs: 0.5 }), plan, 1.3, DIM), "dog text");
  assert.ok(!rivalled(vec({ cats: 0.4, dogs: 0.5 }), plan, 1.3, DIM), "mixed cats-and-dogs text: 0.5 < 1.3 × 0.4");
  assert.ok(!rivalled(vec({ cats: 0.5 }), plan, 1.3, DIM));
});

const params = (siblingRatio?: number): ModeParams => ({ threshold: 0.1, minSemanticChars: 5, lexical: LEXICAL_PARAMS.balanced, siblingRatio });

test("decide(): the veto withholds semantic matches, never keyword matches, and is off without a ratio", () => {
  const cats = vec({ cats: 1 });
  const plan = planSiblings(cats, [cats], table, DIM)!;
  const texts = ["a puppy learns to sit", "puppies and kittens", "Cats asleep on the sofa"];
  const vecs = [vec({ cats: 0.3, dogs: 0.6 }), vec({ cats: 0.45, dogs: 0.5 }), vec({ cats: 0.2, dogs: 0.6 })];
  const flat = Float32Array.from(vecs.flatMap((v) => [...v]));
  const on = decide(texts, flat, DIM, [prepareTopic({ id: "c", text: "cats" }, cats, params(1.3), null, undefined, plan)], params(1.3));
  assert.deepEqual(on.map((d) => [d.matched, d.via, d.rivalled]), [[false, null, true], [true, "semantic", false], [true, "lexical", true]]);
  const off = decide(texts, flat, DIM, [prepareTopic({ id: "c", text: "cats" }, cats, params(), null, undefined, plan)], params());
  assert.deepEqual(off.map((d) => [d.matched, d.via, d.rivalled]), [[true, "semantic", false], [true, "semantic", false], [true, "semantic", false]]);
});

test("decide(): with two topics, a vetoed topic yields to one that is not", () => {
  const cats = vec({ cats: 1 }), dogs = vec({ dogs: 1 });
  const p = params(1.3);
  const topics = [
    prepareTopic({ id: "c", text: "cats" }, cats, p, null, undefined, planSiblings(cats, [cats], table, DIM)),
    prepareTopic({ id: "d", text: "dogs" }, dogs, p, null, undefined, planSiblings(dogs, [dogs], table, DIM)),
  ];
  const d = decide(["a dog fetching a stick"], vec({ cats: 0.35, dogs: 0.6 }), DIM, topics, p);
  assert.deepEqual([d[0]!.matched, d[0]!.topicId, d[0]!.rivalled], [true, "d", false]);
});

// Real model: the plans the shipped encoder produces for the phrases themselves
// (model.json carries their PyTorch vectors). Required in CI's build job.
const MODEL_JSON = path.resolve(import.meta.dirname, "../../build/models/minilm-l6-f16/model.json");
const required = process.env.CLEARSCROLL_REQUIRE_MODEL !== undefined;
test("real model: football-like, animal, finance and spoiler topics get the intended rivals; broad ones none", { skip: !required && !fs.existsSync(MODEL_JSON) && "model not prepared (npm run setup:model)" }, () => {
  const meta = JSON.parse(fs.readFileSync(MODEL_JSON, "utf8"));
  assert.deepEqual(meta.siblings.phrases, [...SIBLING_PHRASES], "model.json siblings match topic-siblings.json (re-run tools/prepare_model.py)");
  const dim = meta.siblings.embeddings[0].length;
  const t: SiblingTable = { vectors: Float32Array.from(meta.siblings.embeddings.flat()), count: SIBLING_PHRASES.length };
  const v = (p: string) => Float32Array.from(meta.siblings.embeddings[SIBLING_PHRASES.indexOf(p)]);
  const plan = (p: string) => planSiblings(v(p), [v(p)], t, dim);
  for (const [topic, must, mustNot] of [
    ["soccer", ["rugby", "basketball"], ["soccer"]],
    ["cats", ["dogs", "horses"], ["cats"]],
    ["cryptocurrency", ["stock market", "gold and silver prices"], ["cryptocurrency"]],
    ["movie and TV spoilers", ["movie trailers", "film reviews"], ["movie and TV spoilers"]],
  ] as const) {
    const p = plan(topic);
    assert.ok(p, `${topic} has a plan`);
    for (const m of must) assert.ok(p!.rivalNames.includes(m), `${topic}: ${m} is a rival`);
    for (const m of mustNot) assert.ok(!p!.rivalNames.includes(m), `${topic}: ${m} is not a rival`);
  }
  for (const broad of ["sports", "animals", "pets and animals", "finance", "movies", "music", "technology"]) assert.equal(plan(broad), null, `${broad} is broad`);
});
