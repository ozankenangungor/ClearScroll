/**
 * Image filtering end to end: the built extension (dist/) in real Chromium,
 * with the real image model (SigLIP, ONNX Runtime WebAssembly) and real
 * photographs (tests/fixtures/images, served under neutral URLs, no alt text,
 * no captions). A blurred picture here can only come from its pixels: if the
 * image model were removed or replaced by the text classifier, these tests
 * would fail.
 *
 * Run `npm run build` first. The first image of a run waits for the model to
 * load (several seconds on the CPU backend, longer on slow CI machines).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Page } from "playwright";

import { DIST, MEDIA, attr, extensionPage, launchExtension, setSettings, uiStatus, waitAttr, waitRegistered, type Env } from "../helpers/extension.ts";

const COLD_MS = 180_000;
const REMOTE_HOST = "cdn.example";
let env: Env;

before(async () => {
  // cdn.example resolves to the test server: a second, cross-origin image host.
  env = await launchExtension({ extraArgs: [`--host-resolver-rules=MAP ${REMOTE_HOST} 127.0.0.1`] });
});
after(async () => {
  await env?.close();
});

const topic = (text: string) => [{ id: `t-${text}`, text, enabled: true }];

async function reset(patch: Record<string, unknown> = {}) {
  await env.sw.evaluate(() => chrome.storage.local.clear());
  await setSettings(env, { topics: [], images: false, imageDownloads: false, mode: "precision", ...patch });
  await waitRegistered(env, false);
  for (const p of env.ctx.pages()) await p.close();
}

async function tabState(page: Page): Promise<any> {
  const url = page.url();
  return env.sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: url.split("?")[0] + "*" });
    return chrome.tabs.sendMessage(tab!.id!, { type: "tab:state" });
  }, url);
}

/** Open the fixture page and wait until `n` images have been analysed. */
async function openImages(n: number, query = ""): Promise<Page> {
  const page = await env.ctx.newPage();
  await page.setViewportSize({ width: 1000, height: 1400 });
  await page.goto(`${env.base}/images.html${query}`);
  const deadline = Date.now() + COLD_MS;
  for (;;) {
    const st = await tabState(page).catch(() => null);
    if (st?.images?.analyzed >= n) break;
    if (Date.now() > deadline) throw new Error(`only ${st?.images?.analyzed} images analysed: ${JSON.stringify(st?.images)}`);
    await page.waitForTimeout(250);
  }
  return page;
}

const UNRELATED_TO_CATS = ["dog", "landscape", "football", "rugby", "bitcoin", "gold", "stock", "burger"];

test("cats: a cat photo with no caption is blurred from its pixels; dog, landscape and others stay visible", async () => {
  await reset();
  await setSettings(env, { topics: topic("cats"), images: true });
  await waitRegistered(env, true);
  const page = await openImages(14);
  await waitAttr(page, "#cat", "blurred");
  for (const id of UNRELATED_TO_CATS) assert.equal(await attr(page, `#${id}`), null, `#${id} is not a cat`);
  assert.equal(await attr(page, "#pic-img"), "blurred", "responsive <picture>: the cat source it selected");
  assert.equal(await attr(page, "#shared-a"), "blurred");
  assert.equal(await attr(page, "#shared-b"), "blurred", "a second element with the same picture");
  assert.equal(await attr(page, "#nav-img"), null, "navigation is protected");
  assert.equal(await attr(page, "#icon"), null, "icons are not analysed");
  assert.equal(await attr(page, "#broken"), null);
  // The picture is really obscured (strong media blur from content.css).
  assert.match(await page.evaluate(() => getComputedStyle(document.getElementById("cat")!).filter), /blur\(28px\)/);
  // Card with unrelated text and a dog picture: untouched. Card whose text is about cats: hidden by the text filter.
  assert.equal(await attr(page, "#card-img"), null);
  assert.equal(await attr(page, "#card-txt"), "blurred");
  const st = await tabState(page);
  assert.equal(st.images.enabled, true);
  assert.equal(st.images.vision.state, "ready");
  assert.equal(st.images.vision.backend, "cpu");
  // Pixels were read in the page: the extension downloaded nothing.
  assert.deepEqual(env.mediaRequests.filter((r) => r.referer === null), [], "no image request without a page referrer (= no extension download)");
  const status = await uiStatus(env);
  assert.equal(status.vision.state, "ready");
  assert.equal(status.vision.model, "siglip-base-p16-224-int8");
  // Multi-threaded where the machine allows it: half the logical cores, at most 4.
  const cores = await env.sw.evaluate(() => navigator.hardwareConcurrency);
  assert.equal(status.vision.threads, Math.max(1, Math.min(4, Math.floor(cores / 2))), `threads for ${cores} logical cores`);
});

test("reveal: one click shows the photo (also inside a link, without navigating); keyboard works too", async () => {
  const page = env.ctx.pages().find((p) => p.url().includes("images.html"))!;
  await page.click("#cat");
  assert.equal(await attr(page, "#cat"), "revealed");
  await waitAttr(page, "#linked", "blurred");
  await page.click("#linked");
  assert.equal(await attr(page, "#linked"), "revealed");
  assert.equal(await page.evaluate(() => location.hash), "", "the first click did not follow the link");
  await page.click("#linked");
  assert.equal(await page.evaluate(() => location.hash), "#go");
  await page.focus("#shared-a");
  await page.keyboard.press("Enter");
  assert.equal(await attr(page, "#shared-a"), "revealed");
});

test("a changed image source is re-evaluated from its new pixels", async () => {
  const page = env.ctx.pages().find((p) => p.url().includes("images.html"))!;
  assert.equal(await attr(page, "#swap"), null, "landscape");
  await page.evaluate(() => ((document.getElementById("swap") as HTMLImageElement).src = "/media/k10?swapped"));
  await waitAttr(page, "#swap", "blurred", 60_000);
  await page.evaluate(() => ((document.getElementById("swap") as HTMLImageElement).src = "/media/k2?swapped-back"));
  await waitAttr(page, "#swap", null, 60_000);
});

test("turning image filtering off restores every picture and unloads the image model; text filtering continues", async () => {
  const page = env.ctx.pages().find((p) => p.url().includes("images.html"))!;
  await setSettings(env, { images: false });
  await waitAttr(page, "#pic-img", null);
  assert.equal(await page.locator("img[data-clearscroll], [data-clearscroll-media]").count(), 0);
  assert.equal(await attr(page, "#card-txt"), "blurred", "text-matched card stays hidden");
  for (let i = 0; i < 40 && (await uiStatus(env)).vision.state !== "idle"; i++) await page.waitForTimeout(100);
  assert.equal((await uiStatus(env)).vision.state, "idle");
});

test("football vs rugby and cryptocurrency vs gold/stock market, from pixels", async () => {
  await reset();
  await setSettings(env, { topics: topic("football"), images: true });
  await waitRegistered(env, true);
  let page = await openImages(14);
  await waitAttr(page, "#football", "blurred");
  assert.equal(await attr(page, "#rugby"), null, "a rugby photo is not association football");
  for (const id of ["cat", "dog", "bitcoin", "gold", "burger"]) assert.equal(await attr(page, `#${id}`), null, id);
  await page.close();

  await setSettings(env, { topics: topic("cryptocurrency") });
  page = await openImages(14);
  await waitAttr(page, "#bitcoin", "blurred");
  assert.equal(await attr(page, "#gold"), null, "gold bars are not cryptocurrency");
  assert.equal(await attr(page, "#stock"), null, "a stock-exchange floor is not cryptocurrency");
  for (const id of ["cat", "dog", "football", "burger"]) assert.equal(await attr(page, `#${id}`), null, id);
});

test("other-domain pictures: skipped unless downloads are allowed; then fetched once, without cookies or referrer", async () => {
  await reset();
  // A first-party cookie for the image host: a credentialed request would carry it.
  const setter = await env.ctx.newPage();
  await setter.goto(`http://${REMOTE_HOST}:${env.port}/set-cookie`);
  assert.ok((await env.ctx.cookies(`http://${REMOTE_HOST}:${env.port}/`)).some((c) => c.name === "cs_session"));
  await setter.close();
  await setSettings(env, { topics: topic("cats"), images: true });
  await waitRegistered(env, true);
  const remote = `?remote=http://${REMOTE_HOST}:${env.port}`;
  let page = await openImages(14, remote);
  await page.waitForTimeout(1500);
  assert.equal(await attr(page, "#remote"), null, "cross-origin pixels are not readable: left visible");
  assert.equal(await attr(page, "#poster"), null);
  const st = await tabState(page);
  assert.ok(st.images.skipped["cross-origin"] >= 2, JSON.stringify(st.images.skipped));
  const before = env.mediaRequests.length;
  assert.deepEqual(env.mediaRequests.filter((r) => r.referer === null), [], "nothing downloaded by the extension");
  await page.close();

  await setSettings(env, { imageDownloads: true });
  page = await openImages(16, remote);
  await waitAttr(page, "#remote", "blurred");
  await waitAttr(page, "#poster", "blurred");
  const downloads = env.mediaRequests.slice(before).filter((r) => r.referer === null);
  assert.deepEqual(downloads.map((r) => r.path).sort(), ["/media/k1?poster", "/media/k1?remote"], "exactly the two displayed other-domain pictures");
  for (const d of downloads) {
    assert.equal(d.host, `${REMOTE_HOST}:${env.port}`);
    assert.equal(d.cookie, null, "no cookies");
    assert.equal(d.referer, null, "no referrer");
  }
});

test("the image model's embeddings match the PyTorch reference (browser decoding, int8 model)", async () => {
  // The production worker bundle, in an extension page (same origin and CSP as the offscreen document).
  const page = await extensionPage(env);
  const ref = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/siglip_embedding_parity.json"), "utf8"));
  const files = Object.keys(ref.images);
  const keyOf = (f: string) => Object.entries(MEDIA).find(([, v]) => v === f)![0];
  const bgPrompts = JSON.parse(fs.readFileSync(path.join(DIST, "offscreen/vision/background.json"), "utf8"));
  const result = await page.evaluate(
    async ({ base, keys, prompts, background }) => {
      const spawn = async (role: "image" | "text", threads = 4) => {
        const w = new Worker(chrome.runtime.getURL("offscreen/vision.worker.js"), { type: "module" });
        let next = 1;
        const call = (m: Record<string, unknown>) =>
          new Promise<any>((resolve) => {
            const id = next++;
            const on = (e: MessageEvent) => {
              if (e.data.id === id || (m.type === "init" && !("id" in e.data))) {
                w.removeEventListener("message", on);
                resolve(e.data);
              }
            };
            w.addEventListener("message", on);
            w.postMessage({ ...m, id });
          });
        const u = (p: string) => chrome.runtime.getURL(`offscreen/vision/${p}`);
        const init = await call({ type: "init", role, ortPrefix: u(""), threads, modelUrl: u(role === "image" ? "vision_model_quantized.onnx" : "text_model_quantized.onnx"), tokenizerUrl: role === "text" ? u("tokenizer.json") : undefined });
        if (init.type !== "ready") throw new Error(init.error);
        return { w, call, threads: init.threads as number };
      };
      try {
        const img = await spawn("image");
        const txt = await spawn("text");
        const images: number[][] = [];
        for (const k of keys) {
          const blob = await (await fetch(`${base}/media/${k}`)).blob();
          const r = await img.call({ type: "image", blob, maxPixels: 24e6 });
          images.push(Array.from(r.vector));
        }
        const t = await txt.call({ type: "text", prompts });
        const bg = await txt.call({ type: "text", prompts: background.prompts.slice(0, 3) });
        // The same images on one thread: threading must not change any result.
        const single = await spawn("image", 1);
        const singleImages: number[][] = [];
        for (const k of keys.slice(0, 3)) {
          const blob = await (await fetch(`${base}/media/${k}`)).blob();
          singleImages.push(Array.from((await single.call({ type: "image", blob, maxPixels: 24e6 })).vector));
        }
        img.w.terminate();
        txt.w.terminate();
        single.w.terminate();
        return { images, singleImages, threads: img.threads, singleThreads: single.threads, isolated: crossOriginIsolated, text: Array.from(t.vectors as Float32Array), bg: Array.from(bg.vectors as Float32Array) };
      } catch (err) {
        return { error: String(err) };
      }
    },
    { base: env.base, keys: files.map(keyOf), prompts: Object.keys(ref.prompts), background: bgPrompts }
  );
  await page.close();
  if ("error" in result) assert.fail(String(result.error));
  const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0) / Math.hypot(...a) / Math.hypot(...b);
  const imageCos = files.map((f, i) => cos(result.images[i]!, ref.images[f]));
  // int8 weights + Chrome's resampler vs fp32 + PIL bicubic: measured 0.944–0.976.
  for (const [i, c] of imageCos.entries()) assert.ok(c >= 0.93, `${files[i]}: cosine ${c.toFixed(4)} to the PyTorch embedding`);
  // Decisions agree: each image's best reference prompt is also its best prompt with the extension's embeddings.
  const prompts = Object.keys(ref.prompts);
  const dim = result.text.length / prompts.length;
  const textVec = (j: number) => result.text.slice(j * dim, (j + 1) * dim);
  for (const [i, f] of files.entries()) {
    const best = (sim: (j: number) => number) => prompts.map((_, j) => j).sort((a, b) => sim(b) - sim(a))[0];
    const ours = best((j) => cos(result.images[i]!, textVec(j)));
    const theirs = best((j) => cos(ref.images[f], ref.prompts[prompts[j]!]));
    assert.equal(prompts[ours!], prompts[theirs!], `${f}: best prompt differs from the reference`);
  }
  // Extension pages are cross-origin isolated, so the model really runs on 4
  // threads — with results identical to one thread.
  assert.equal(result.isolated, true, "extension pages are cross-origin isolated (COOP/COEP)");
  assert.equal(result.threads, 4);
  assert.equal(result.singleThreads, 1);
  const singles: number[][] = result.singleImages;
  singles.forEach((v, i) => {
    const maxDiff = Math.max(...v.map((x, j) => Math.abs(x - result.images[i]![j]!)));
    assert.ok(maxDiff < 1e-6, `image ${i}: 1-thread and 4-thread embeddings differ by ${maxDiff}`);
  });
  // The background vectors computed at build time (Node, same WebAssembly runtime) equal the extension's own.
  const bdim = result.bg.length / 3;
  for (let j = 0; j < 3; j++) assert.ok(cos(result.bg.slice(j * bdim, (j + 1) * bdim), bgPrompts.vectors[j]) > 0.9999, `background prompt ${j}`);
  console.log(`  image embedding cosine to PyTorch: min ${Math.min(...imageCos).toFixed(4)}, max ${Math.max(...imageCos).toFixed(4)}`);
});

test("a broken image model is reported as unavailable; pictures stay visible and text filtering keeps working", async () => {
  // A copy of the build whose image model file is corrupt.
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-broken-vision-"));
  fs.cpSync(DIST, broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "offscreen/vision/vision_model_quantized.onnx"), "not an onnx model");
  const env2 = await launchExtension({ dist: broken });
  try {
    await env2.sw.evaluate(() =>
      chrome.storage.local.set({ clearscroll_settings: { schema: 2, enabled: true, mode: "balanced", engine: "cpu", topics: [{ id: "t", text: "cryptocurrency", enabled: true }], excludedSites: [], protectedSelectors: [], images: true, imageDownloads: false } })
    );
    for (let i = 0; i < 100 && (await env2.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)) === 0; i++) await new Promise((r) => setTimeout(r, 50));
    const page = await env2.ctx.newPage();
    await page.goto(`${env2.base}/news.html`);
    await waitAttr(page, "#crypto-1 h2", "blurred");
    await page.goto(`${env2.base}/images.html`);
    let status: any;
    for (let i = 0; i < 240; i++) {
      status = await uiStatus(env2);
      if (status.vision.state === "error") break;
      await page.waitForTimeout(250);
    }
    assert.equal(status.vision.state, "error", JSON.stringify(status.vision));
    assert.ok(status.vision.detail, "the failure is explained in diagnostics");
    assert.equal(await page.locator("img[data-clearscroll]").count(), 0, "nothing is hidden without a working model");
    assert.equal(status.engine.state, "semantic", "the text engine is unaffected");
  } finally {
    await env2.close();
    fs.rmSync(broken, { recursive: true, force: true });
  }
});

// ── Download security and consent lifecycle ─────────────────────────────

async function securityPage(): Promise<Page> {
  const page = await env.ctx.newPage();
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(`${env.base}/security.html`);
  return page;
}

async function addRemoteImage(page: Page, id: string, path: string): Promise<void> {
  await page.evaluate(
    ({ id, src }) =>
      new Promise<void>((resolve) => {
        const img = document.createElement("img");
        img.id = id;
        img.onload = img.onerror = () => resolve();
        img.src = src;
        document.getElementById("slot")!.append(img);
      }),
    { id, src: `http://${REMOTE_HOST}:${env.port}${path}` }
  );
}

async function waitFor(cond: () => Promise<boolean> | boolean, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("a redirect from an image host to a private address is never followed by the extension", async () => {
  await reset();
  await setSettings(env, { topics: topic("cats"), images: true, imageDownloads: true });
  await waitRegistered(env, true);
  const page = await securityPage();
  await waitAttr(page, "#local-cat", "blurred", COLD_MS);
  const forbidden = `http://127.0.0.1:${env.port}/media/k1?forbidden-${Date.now()}`;
  const marker = new URL(forbidden).search;
  await addRemoteImage(page, "redirected", `/redirect/k1?to=${encodeURIComponent(forbidden)}`);
  // The page itself follows the redirect (its own business, with its referrer);
  // the extension's download of /redirect/… must stop at the 302.
  await waitFor(() => env.mediaRequests.some((r) => r.path.startsWith("/redirect/k1") && r.referer === null), "the extension's request to the redirecting URL");
  await waitFor(async () => (await tabState(page)).images.analyzed + Object.values((await tabState(page)).images.skipped as Record<string, number>).reduce((a, b) => a + b, 0) >= 2, "the redirected picture to be handled");
  await page.waitForTimeout(500);
  const extensionHits = env.mediaRequests.filter((r) => r.path.endsWith(marker) && r.referer === null);
  assert.deepEqual(extensionHits, [], "the private redirect target was never requested by the extension");
  assert.ok(env.mediaRequests.some((r) => r.path.endsWith(marker) && r.referer !== null), "control: the page itself did load it");
  assert.equal(await attr(page, "#redirected"), null, "not analysed, left visible");
  const st = await tabState(page);
  assert.ok((st.images.skipped["download-failed"] ?? 0) >= 1, JSON.stringify(st.images.skipped));
});

test("revoking download permission aborts an in-flight download; page pixels and the text engine keep working", async () => {
  await reset();
  await setSettings(env, { topics: topic("cats"), images: true, imageDownloads: true });
  await waitRegistered(env, true);
  const page = await securityPage();
  await waitAttr(page, "#local-cat", "blurred", COLD_MS);
  const contextsBefore = await env.sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })).map((c) => c.documentId));
  const held = `/hold/k1?revoke-${Date.now()}`;
  await addRemoteImage(page, "pending", held);
  await waitFor(() => env.held.waiting.includes(held), "the extension's download to start");
  await setSettings(env, { imageDownloads: false });
  // Well under the 10 s download timeout: aborted by the settings change itself.
  await waitFor(() => env.held.aborted.includes(held), "the in-flight download to be aborted", 2_000);
  env.held.releaseAll();
  await page.waitForTimeout(1000);
  assert.equal(await attr(page, "#pending"), null, "the aborted picture is left visible");
  // Image filtering still works from pixels; the same offscreen document (text engine) is still running.
  await page.evaluate(() => {
    const img = document.createElement("img");
    img.id = "local-cat-2";
    img.src = "/media/k10?after-revoke";
    document.getElementById("slot")!.append(img);
  });
  await waitAttr(page, "#local-cat-2", "blurred", 60_000);
  const contextsAfter = await env.sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })).map((c) => c.documentId));
  assert.deepEqual(contextsAfter, contextsBefore, "no offscreen (text engine) restart");
  const status = await uiStatus(env);
  assert.equal(status.vision.state, "ready", "image model still loaded");
  assert.notEqual(status.engine.state, "error");
  // No later download of the revoked picture either.
  const before = env.mediaRequests.length;
  await addRemoteImage(page, "pending-2", `/hold/k1?after-${Date.now()}`);
  await page.waitForTimeout(2000);
  assert.deepEqual(env.mediaRequests.slice(before).filter((r) => r.referer === null), [], "no download after revocation");
});

test("turning image filtering off aborts an in-flight download and the image model stays unloaded", async () => {
  await reset();
  await setSettings(env, { topics: topic("cats"), images: true, imageDownloads: true });
  await waitRegistered(env, true);
  const page = await securityPage();
  await waitAttr(page, "#local-cat", "blurred", COLD_MS);
  const held = `/hold/k1?disable-${Date.now()}`;
  await addRemoteImage(page, "pending", held);
  await waitFor(() => env.held.waiting.includes(held), "the extension's download to start");
  await setSettings(env, { images: false });
  // Well under the 10 s download timeout: aborted by the settings change itself.
  await waitFor(() => env.held.aborted.includes(held), "the in-flight download to be aborted", 2_000);
  env.held.releaseAll();
  await page.waitForTimeout(2000);
  const status = await uiStatus(env);
  assert.equal(status.vision.state, "idle", "no model resurrection after shutdown");
  assert.equal(await page.locator("img[data-clearscroll]").count(), 0);
});

test("rapid image-filtering toggles: ending off leaves the model unloaded; ending on analyses new pictures", async () => {
  await reset();
  await setSettings(env, { topics: topic("cats"), images: true });
  await waitRegistered(env, true);
  const page = await securityPage();
  await waitAttr(page, "#local-cat", "blurred", COLD_MS);
  const addLocal = (id: string, key: string) =>
    page.evaluate(
      ({ id, key }) => {
        const img = document.createElement("img");
        img.id = id;
        img.src = `/media/${key}?${id}`;
        document.getElementById("slot")!.append(img);
      },
      { id, key }
    );
  // off → on → off in quick succession while new pictures keep arriving.
  await addLocal("t1", "k10");
  await setSettings(env, { images: false });
  await addLocal("t2", "k1");
  await setSettings(env, { images: true });
  await addLocal("t3", "k10");
  await setSettings(env, { images: false });
  await page.waitForTimeout(3000);
  assert.equal((await uiStatus(env)).vision.state, "idle", "ended off: no model loaded by any earlier request");
  assert.equal(await page.locator("img[data-clearscroll]").count(), 0, "ended off: nothing hidden");
  // Back on: legitimate image-only analysis works again.
  await setSettings(env, { images: true });
  await addLocal("t4", "k1");
  await waitAttr(page, "#t4", "blurred", COLD_MS);
  assert.equal((await uiStatus(env)).vision.state, "ready");
});
