import assert from "node:assert/strict";
import { test } from "node:test";

import { browserMajor, formatDiagnostics, type DiagnosticsInput } from "../../src/options/diagnostics.ts";
import { defaultSettings } from "../../src/shared/settings.ts";

const input = (patch: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  version: "0.3.0",
  browser: "Chrome 153",
  settings: {
    ...defaultSettings(),
    enabled: true,
    topics: [{ id: "a", text: "cats", enabled: true }, { id: "b", text: "my secret topic", enabled: false }],
    excludedSites: ["bank.example.com"],
    images: true,
  },
  engine: { state: "semantic", backend: "cpu", model: "minilm-l6", loadMs: 420, detail: null },
  vision: { state: "ready", model: "siglip", loadMs: 900, detail: null, threads: 4 },
  registered: true,
  includeTopics: false,
  ...patch,
});

test("diagnostics contain status and counts but no topics, sites or addresses by default", () => {
  const t = formatDiagnostics(input());
  assert.match(t, /Version: 0\.3\.0 · Chrome 153/);
  assert.match(t, /Topics: 1 active of 2\n/);
  assert.match(t, /Excluded sites: 1 /);
  assert.match(t, /Text engine: semantic · backend cpu · model minilm-l6/);
  assert.match(t, /Image model: ready · siglip · threads 4/);
  assert.doesNotMatch(t, /cats|secret|bank\.example/);
});

test("topic names only when the user asks for them, and only active ones", () => {
  const t = formatDiagnostics(input({ includeTopics: true }));
  assert.match(t, /Topics: 1 active of 2 — "cats"/);
  assert.doesNotMatch(t, /secret|bank\.example/);
});

test("browserMajor keeps only the Chrome major version", () => {
  assert.equal(browserMajor("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.47 Safari/537.36"), "Chrome 153");
  assert.equal(browserMajor("something else"), "unknown browser");
});
