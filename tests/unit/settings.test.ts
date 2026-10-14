import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LEGACY_TARGET_KEY,
  LEGACY_V1_KEY,
  LIMITS,
  SETTINGS_KEY,
  activeTopics,
  defaultSettings,
  isFilteringActive,
  migrateSettings,
  normalizeSettings,
  parseLines,
  validateSelector,
  validateTopicText,
} from "../../src/shared/settings.ts";

test("defaults: enabled, precision, no topics → inactive", () => {
  const d = defaultSettings();
  assert.equal(d.schema, 2);
  assert.equal(d.enabled, true);
  assert.equal(d.mode, "precision");
  assert.equal(d.engine, "auto");
  assert.equal(isFilteringActive(d), false);
});

test("normalizeSettings tolerates garbage without throwing", () => {
  for (const raw of [null, undefined, 42, "x", [], { topics: "nope", mode: "turbo", engine: 1, excludedSites: [1, null, "*bad"], protectedSelectors: {} }]) {
    const s = normalizeSettings(raw);
    assert.equal(s.schema, 2);
    assert.equal(s.mode, "precision");
    assert.equal(s.engine, "auto");
    assert.deepEqual(s.excludedSites, []);
  }
});

test("topics are trimmed, de-duplicated case-insensitively and capped", () => {
  const s = normalizeSettings({
    topics: [
      { id: "a", text: "  Crypto   news ", enabled: true },
      { id: "b", text: "crypto NEWS" },
      { id: "c", text: "x" },
      { text: "politics", enabled: false },
      { id: 5, text: 7 },
      ...Array.from({ length: 40 }, (_, i) => ({ text: `topic ${i}` })),
    ],
  });
  assert.equal(s.topics[0]!.text, "Crypto news");
  assert.equal(s.topics[0]!.id, "a");
  assert.equal(s.topics[1]!.text, "politics");
  assert.equal(s.topics[1]!.enabled, false);
  assert.ok(s.topics[1]!.id.length > 0);
  assert.equal(s.topics.length, LIMITS.maxTopics);
  assert.deepEqual(activeTopics(s).map((t) => t.text).slice(0, 2), ["Crypto news", "topic 0"]);
});

test("isFilteringActive needs enabled and at least one enabled topic", () => {
  const base = normalizeSettings({ topics: [{ text: "crypto", enabled: false }] });
  assert.equal(isFilteringActive(base), false);
  assert.equal(isFilteringActive({ ...base, topics: [{ ...base.topics[0]!, enabled: true }] }), true);
  assert.equal(isFilteringActive({ ...base, enabled: false, topics: [{ ...base.topics[0]!, enabled: true }] }), false);
});

test("site rules are normalised on load", () => {
  const s = normalizeSettings({ excludedSites: ["https://Example.com/x", "*.example.com", "*bad", "news.example.com"] });
  assert.deepEqual(s.excludedSites, ["example.com", "news.example.com"]);
});

test("migrates IdeaBlocker v1 settings losslessly", () => {
  const r = migrateSettings({
    [LEGACY_V1_KEY]: { target: "crypto and web3", mode: "aggressive", excludedSites: ["chatgpt.com"], protectedSelectors: ["#side"] },
    [LEGACY_TARGET_KEY]: "crypto and web3",
  });
  assert.equal(r.from, "v1");
  assert.equal(r.changed, true);
  assert.equal(r.settings.mode, "aggressive");
  assert.deepEqual(r.settings.topics.map((t) => [t.text, t.enabled]), [["crypto and web3", true]]);
  assert.deepEqual(r.settings.excludedSites, ["chatgpt.com"]);
  assert.deepEqual(r.settings.protectedSelectors, ["#side"]);
});

test("migrates the oldest target-only format", () => {
  const r = migrateSettings({ [LEGACY_TARGET_KEY]: "movie spoilers" });
  assert.equal(r.from, "legacy-target");
  assert.deepEqual(r.settings.topics.map((t) => t.text), ["movie spoilers"]);
  const empty = migrateSettings({ [LEGACY_TARGET_KEY]: "  " });
  assert.deepEqual(empty.settings.topics, []);
});

test("current settings win over legacy keys and unchanged data is not rewritten", () => {
  const current = { ...defaultSettings(), topics: [{ id: "t1", text: "sports", enabled: true }] };
  const r = migrateSettings({ [SETTINGS_KEY]: current, [LEGACY_TARGET_KEY]: "old" });
  assert.equal(r.from, "current");
  assert.equal(r.changed, false);
  assert.deepEqual(r.settings, current);
});

test("empty storage yields defaults", () => {
  assert.deepEqual(migrateSettings({}), { settings: defaultSettings(), changed: false, from: "none", droppedSites: [] });
});

test("validateTopicText", () => {
  const existing = [{ id: "1", text: "Crypto", enabled: true }];
  assert.equal(validateTopicText("politics", existing), null);
  assert.match(validateTopicText(" ", existing)!, /short/);
  assert.match(validateTopicText("x".repeat(LIMITS.maxTopicChars + 1), existing)!, /at most/);
  assert.match(validateTopicText("  CRYPTO ", existing)!, /already exists/);
  assert.equal(validateTopicText("crypto", existing, "1"), null, "editing a topic is not a duplicate of itself");
});

test("validateSelector uses the provided parser and never throws", () => {
  const doc = {
    createDocumentFragment: () => ({
      querySelector: (s: string) => {
        if (s.includes("[[")) throw new SyntaxError("bad");
        return null;
      },
    }),
  } as unknown as Document;
  assert.equal(validateSelector("#side .x", doc), null);
  assert.match(validateSelector("a[[b", doc)!, /Invalid/);
  assert.match(validateSelector("  ", doc)!, /Empty/);
  assert.match(validateSelector("a".repeat(400), doc)!, /long/);
});

test("parseLines", () => {
  assert.deepEqual(parseLines(" a \r\n\n b\n"), ["a", "b"]);
});

test("migration reports legacy site rules it cannot represent instead of dropping them silently", () => {
  const r = migrateSettings({
    [LEGACY_V1_KEY]: { target: "crypto", excludedSites: ["chatgpt.com", "*bank*.com", "intranet", "*.ok.org"] },
  });
  assert.deepEqual(r.settings.excludedSites, ["chatgpt.com", "ok.org"]);
  assert.deepEqual(r.droppedSites.map((d) => d.input), ["*bank*.com", "intranet"]);
  assert.ok(r.droppedSites.every((d) => d.error.length > 0));
});

test("open tabs are injected only when filtering starts or a site rule is removed", async () => {
  const { shouldInjectOpenTabs } = await import("../../src/shared/settings.ts");
  const on = normalizeSettings({ topics: [{ text: "crypto" }], excludedSites: ["a.com", "b.com"] });
  const off = { ...on, enabled: false };
  assert.equal(shouldInjectOpenTabs(null, on), true, "unknown previous state");
  assert.equal(shouldInjectOpenTabs(off, on), true, "filtering became active");
  assert.equal(shouldInjectOpenTabs(on, off), false, "nothing to inject when stopping");
  assert.equal(shouldInjectOpenTabs(on, { ...on, mode: "aggressive" }), false, "mode change reaches scripts via storage");
  assert.equal(shouldInjectOpenTabs(on, { ...on, topics: [{ id: "x", text: "sports", enabled: true }] }), false);
  assert.equal(shouldInjectOpenTabs(on, { ...on, excludedSites: ["a.com"] }), true, "b.com may now need the script");
  assert.equal(shouldInjectOpenTabs(on, { ...on, excludedSites: ["a.com", "b.com", "c.com"] }), false);
});
