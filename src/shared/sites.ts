/**
 * Site rules — one policy shared by the content script, the background
 * registration logic and the options UI.
 *
 * Policy (documented in docs/ARCHITECTURE.md#site-rules):
 *   - An entry names a host. It matches that host AND every subdomain:
 *       "example.com"   → example.com, www.example.com, news.example.com
 *   - A leading "*." is accepted and means exactly the same thing. Chrome
 *     match patterns cannot express "subdomains but not the apex", so we do
 *     not pretend to support it.
 *   - Scheme, path, query, port and trailing dots are stripped. Rules apply to
 *     http and https and to every port.
 *   - Internationalised names are converted to punycode (WHATWG URL / IDNA),
 *     so "bücher.de" and "xn--bcher-kva.de" are the same rule.
 *   - IPv4 literals and "localhost" are allowed and match exactly.
 *   - Anything else containing "*" (e.g. "*foo.com", "a.*.com") is rejected,
 *     as is a bare single label like "com" (it would exclude a whole TLD).
 *     Multi-label public suffixes such as "co.uk" cannot be detected without
 *     a public-suffix list and are accepted; see the limitations section.
 */

export type SiteRuleResult =
  | { ok: true; host: string }
  | { ok: false; input: string; error: string };

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function parseSiteRule(raw: string): SiteRuleResult {
  const input = raw;
  let s = raw.trim().toLowerCase();
  if (!s) return { ok: false, input, error: "empty entry" };

  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/[/?#].*$/, "");
  s = s.replace(/^[^@]*@/, ""); // userinfo
  s = s.replace(/:\d*$/, ""); // port
  s = s.replace(/\.+$/, "");
  if (s.startsWith("*.")) s = s.slice(2);

  if (!s) return { ok: false, input, error: "no host name" };
  if (s.includes("*")) {
    return { ok: false, input, error: 'wildcards are only allowed as a leading "*."' };
  }
  if (s.startsWith("[") || s.includes(":")) {
    return { ok: false, input, error: "IPv6 addresses are not supported" };
  }

  let host: string;
  try {
    host = new URL(`http://${s}/`).hostname;
  } catch {
    return { ok: false, input, error: "not a valid host name" };
  }
  if (host === "localhost" || IPV4.test(host)) return { ok: true, host };

  const labels = host.split(".");
  if (labels.length < 2) {
    return { ok: false, input, error: "enter a full domain such as example.com" };
  }
  if (!labels.every((l) => LABEL.test(l))) {
    return { ok: false, input, error: "not a valid host name" };
  }
  if (/^\d+$/.test(labels[labels.length - 1]!)) {
    return { ok: false, input, error: "not a valid host name" };
  }
  return { ok: true, host };
}

/** Validate a list; returns normalised, de-duplicated hosts plus errors. */
export function parseSiteRules(lines: readonly string[]): {
  hosts: string[];
  errors: { input: string; error: string }[];
} {
  const hosts: string[] = [];
  const errors: { input: string; error: string }[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = parseSiteRule(line);
    if (!r.ok) {
      errors.push({ input: r.input.trim(), error: r.error });
    } else if (!seen.has(r.host)) {
      seen.add(r.host);
      hosts.push(r.host);
    }
  }
  return { hosts, errors };
}

function isExactOnly(host: string): boolean {
  return host === "localhost" || IPV4.test(host);
}

/** Does `hostname` fall under the (already normalised) rule `host`? */
export function hostMatchesRule(hostname: string, host: string): boolean {
  const h = hostname.toLowerCase().replace(/\.+$/, "");
  if (h === host) return true;
  return !isExactOnly(host) && h.endsWith(`.${host}`);
}

export function isUrlExcluded(url: string, hosts: readonly string[]): boolean {
  let hostname: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    hostname = u.hostname;
  } catch {
    return false;
  }
  return hosts.some((host) => hostMatchesRule(hostname, host));
}

/**
 * Chrome match patterns equivalent to a normalised rule. `*://*.host/*`
 * already covers the apex domain in Chrome's matcher; the explicit apex
 * pattern is kept for clarity and costs nothing.
 */
export function ruleToMatchPatterns(host: string): string[] {
  if (isExactOnly(host)) return [`*://${host}/*`];
  return [`*://${host}/*`, `*://*.${host}/*`];
}

export function rulesToExcludeMatches(hosts: readonly string[]): string[] {
  return [...new Set(hosts.flatMap(ruleToMatchPatterns))];
}
