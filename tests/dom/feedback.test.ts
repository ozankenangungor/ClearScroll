import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessPage, launch, waitPending, settle } from "../helpers/dom-page.ts";

test("feedback never copies page-controlled custom tag names, including ancestors", async () => {
  const browser = await launch();
  try {
    const page = await harnessPage(browser, '<authabc123secret style="display:block"><p id="p">Public MATCH item with enough text.</p></authabc123secret><tokenabcsecret style="display:block" id="custom">Another public MATCH item.</tokenabcsecret>');
    await page.evaluate(() => (window as any).harness.apply());
    await waitPending(page, 1);
    await page.evaluate(() => (window as any).harness.respond());
    await settle(page);
    const drafts = await page.evaluate(() => ["p", "custom"].map(id => (window as any).harness.controller.feedbackDraft(document.getElementById(id), "t1", true)));
    assert(drafts.every(Boolean));
    assert(!/authabc123secret|tokenabcsecret/.test(JSON.stringify(drafts)), "page tag names can contain private tokens");
  } finally { await browser.close(); }
});

test("feedback rechecks dynamic targets and consent; scores follow current analyzed text", async () => {
  const browser = await launch();
  try {
    const page = await harnessPage(browser, '<main><p id="a">Public MATCH text with enough length.</p><p id="b">Other public text with enough length.</p><form><p id="form">Password form sentinel</p><input value="secret"></form><div role="log"><p id="log">Private message sentinel</p></div></main>');
    await page.evaluate(() => (window as any).harness.apply({ topics: [{ id: "t1", text: "cats", enabled: true }, { id: "t2", text: "football", enabled: true }] }));
    await waitPending(page, 1);
    await page.evaluate(() => (window as any).harness.respond());
    await settle(page);
    const r = await page.evaluate(() => {
      const c = (window as any).harness.controller;
      const a = document.getElementById("a")!;
      const b = document.getElementById("b")!;
      const first = c.feedbackDraft(a, "t2", true);
      b.before(document.createElement("p"));
      const moved = c.feedbackDraft(b, "t1", false);
      a.textContent = "Changed public text not yet analyzed.";
      const stale = c.feedbackDraft(a, "t1", true);
      const protectedTargets = ["form", "log"].map(id => c.feedbackDraft(document.getElementById(id), "t1", true));
      a.remove();
      return { first, moved, stale, protectedTargets, detached: c.feedbackDraft(a, "t1", true), disabledTopic: c.feedbackDraft(b, "missing", false) };
    });
    assert.equal(r.first.topicId, "t2");
    assert.equal(r.first.kind, "wrongly-hidden");
    assert.equal(r.first.target.ordinal, 1);
    assert.equal(r.moved.target.ordinal, 3);
    assert.equal(r.moved.kind, "should-hide");
    assert.equal(r.stale.diagnostics.analyzed, false);
    assert.equal(r.stale.diagnostics.score, null);
    assert.deepEqual(r.protectedTargets, [null, null]);
    assert.equal(r.detached, null);
    assert.equal(r.disabledTopic, null);
    await page.evaluate(() => (window as any).harness.apply({ enabled: false }));
    assert.equal(await page.evaluate(() => (window as any).harness.controller.feedbackDraft(document.getElementById("b"), "t1", false)), null);
  } finally { await browser.close(); }
});
