/**
 * The persistent topic-embedding store (src/offscreen/topic-store.ts) on
 * Chromium's real IndexedDB: round trip, unknown keys, and the size bound
 * (least recently used entries are pruned).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as esbuild from "esbuild";
import path from "node:path";
import type { Browser } from "playwright";

import { launch } from "../helpers/dom-page.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

test("topic store: round trip, unknown key, LRU bound", async () => {
  const js = (await esbuild.build({ stdin: { contents: `import { indexedDbTopicStore, MAX_TOPIC_ENTRIES } from "./src/offscreen/topic-store.ts"; (window as any).ts = { indexedDbTopicStore, MAX_TOPIC_ENTRIES };`, resolveDir: REPO, loader: "ts" }, bundle: true, write: false, format: "iife" })).outputFiles[0]!.text;
  const page = await browser.newPage();
  // IndexedDB needs a real origin.
  await page.route("http://store.test/", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>t</title>" }));
  await page.goto("http://store.test/");
  await page.addScriptTag({ content: js });
  const r = await page.evaluate(async () => {
    const { indexedDbTopicStore, MAX_TOPIC_ENTRIES } = (window as any).ts;
    let clock = 0;
    const store = indexedDbTopicStore(indexedDB, () => ++clock);
    await store.set("a", Float32Array.from([1, 2, 3]));
    const a = await store.get("a");
    const missing = await store.get("nope");
    for (let i = 0; i < MAX_TOPIC_ENTRIES + 5; i++) await store.set(`k${i}`, Float32Array.from([i]));
    const firstGone = await store.get("k0");
    const lastKept = await store.get(`k${MAX_TOPIC_ENTRIES + 4}`);
    const aGone = await store.get("a");
    return { a: a && Array.from(a), aIsF32: a instanceof Float32Array, missing, firstGone, lastKept: lastKept && Array.from(lastKept), aGone };
  });
  assert.deepEqual(r.a, [1, 2, 3]);
  assert.equal(r.aIsF32, true);
  assert.equal(r.missing, null);
  assert.equal(r.firstGone, null, "least recently used entries are pruned");
  assert.equal(r.aGone, null);
  assert.ok(r.lastKept);
  await page.close();
});
