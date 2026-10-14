import assert from "node:assert/strict";
import { test } from "node:test";

import { hostMatchesRule, isUrlExcluded, parseSiteRule, parseSiteRules, ruleToMatchPatterns, rulesToExcludeMatches } from "../../src/shared/sites.ts";

const ok = (input: string, host: string) => assert.deepEqual(parseSiteRule(input), { ok: true, host }, input);
const bad = (input: string) => assert.equal(parseSiteRule(input).ok, false, input);

test("normalises plain domains, URLs, ports, paths and case", () => {
  ok("example.com", "example.com");
  ok("  Example.COM  ", "example.com");
  ok("https://www.example.com/path?q=1#x", "www.example.com");
  ok("http://example.com:8080", "example.com");
  ok("example.com.", "example.com");
  ok("user:pw@example.com", "example.com");
});

test("leading *. means the domain and its subdomains", () => {
  ok("*.example.com", "example.com");
  ok("https://*.example.com/", "example.com");
});

test("internationalised domains are converted to punycode", () => {
  ok("bücher.de", "xn--bcher-kva.de");
  ok("xn--bcher-kva.de", "xn--bcher-kva.de");
  ok("şirket.com.tr", "xn--irket-idb.com.tr");
  // Normalisation follows WHATWG URL/IDNA exactly, like the browser: Turkish
  // capital İ maps to "i̇" (i + U+0307), which is a *different* domain.
  ok("ŞİRKET.com.tr", new URL("http://ŞİRKET.com.tr/").hostname);
});

test("localhost and IPv4 are accepted", () => {
  ok("localhost", "localhost");
  ok("http://127.0.0.1:3000/x", "127.0.0.1");
});

test("rejects invalid wildcards, bare labels, IPv6 and garbage", () => {
  for (const s of ["", "   ", "*", "*.", "*foo.com", "foo.*.com", "foo.*", "com", "uk", "[::1]", "exa mple.com", "-bad.com", "bad-.com", "a..b", "1.2.3.999.5"]) bad(s);
  assert.match((parseSiteRule("*foo.com") as { error: string }).error, /leading/);
});

test("parseSiteRules de-duplicates after normalisation and reports errors", () => {
  const r = parseSiteRules(["example.com", "*.example.com", "https://EXAMPLE.com/a", "", "bad*", "news.example.com"]);
  assert.deepEqual(r.hosts, ["example.com", "news.example.com"]);
  assert.deepEqual(r.errors.map((e) => e.input), ["bad*"]);
});

test("a rule matches the host and subdomains only at a label boundary", () => {
  assert.ok(hostMatchesRule("example.com", "example.com"));
  assert.ok(hostMatchesRule("www.example.com", "example.com"));
  assert.ok(hostMatchesRule("a.b.example.com", "example.com"));
  assert.ok(hostMatchesRule("EXAMPLE.com.", "example.com"));
  assert.ok(!hostMatchesRule("badexample.com", "example.com"));
  assert.ok(!hostMatchesRule("example.com.evil.net", "example.com"));
  assert.ok(!hostMatchesRule("example.co", "example.com"));
  // A more specific rule does not cover the parent.
  assert.ok(!hostMatchesRule("example.com", "news.example.com"));
  // IPs and localhost match exactly.
  assert.ok(hostMatchesRule("127.0.0.1", "127.0.0.1"));
  assert.ok(!hostMatchesRule("x.127.0.0.1", "127.0.0.1"));
});

test("isUrlExcluded handles schemes and invalid URLs", () => {
  assert.ok(isUrlExcluded("https://news.example.com/a", ["example.com"]));
  assert.ok(isUrlExcluded("http://example.com:81/", ["example.com"]));
  assert.ok(!isUrlExcluded("https://other.com/", ["example.com"]));
  assert.ok(!isUrlExcluded("chrome://settings", ["settings"]));
  assert.ok(!isUrlExcluded("not a url", ["example.com"]));
});

test("Chrome match patterns are generated for each rule", () => {
  assert.deepEqual(ruleToMatchPatterns("example.com"), ["*://example.com/*", "*://*.example.com/*"]);
  assert.deepEqual(ruleToMatchPatterns("127.0.0.1"), ["*://127.0.0.1/*"]);
  assert.deepEqual(rulesToExcludeMatches(["a.com", "a.com"]), ["*://a.com/*", "*://*.a.com/*"]);
});

/** Reference implementation of Chrome's host matching for "*://<host>/*" patterns. */
function chromeHostMatches(pattern: string, hostname: string): boolean {
  const host = pattern.slice("*://".length, -"/*".length);
  if (host.startsWith("*.")) {
    const base = host.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return hostname === host;
}

test("content-script check and generated excludeMatches agree", () => {
  const rules = ["example.com", "news.site.org", "127.0.0.1", "xn--bcher-kva.de"];
  const hosts = ["example.com", "www.example.com", "notexample.com", "site.org", "news.site.org", "a.news.site.org", "127.0.0.1", "xn--bcher-kva.de", "shop.xn--bcher-kva.de", "other.net"];
  const patterns = rulesToExcludeMatches(rules);
  for (const h of hosts) {
    const byRule = rules.some((r) => hostMatchesRule(h, r));
    const byPattern = patterns.some((p) => chromeHostMatches(p, h));
    assert.equal(byPattern, byRule, h);
  }
});
