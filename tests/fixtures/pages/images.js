// Points the "remote" images at the cross-origin image host the test passes
// as ?remote=http://host:port (a different origin: pixels are not readable).
const remote = new URLSearchParams(location.search).get("remote");
for (const el of document.querySelectorAll("[src^='REMOTE'], [poster^='REMOTE']")) {
  const attr = el.hasAttribute("poster") ? "poster" : "src";
  if (remote) el.setAttribute(attr, el.getAttribute(attr).replace("REMOTE", remote));
  else el.remove();
}
