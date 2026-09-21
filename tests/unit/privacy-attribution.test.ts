import assert from "node:assert/strict";
import { test } from "node:test";
import { networkRequests, type NetLog } from "../../scripts/privacy-attribution.ts";
const fixture = (): NetLog => ({ constants: { logEventTypes: { URL_REQUEST_START_JOB: 1, REQUEST_ALIVE: 2, CORS_REQUEST: 3 } }, events: [
  { type: 1, source: { id: 1, type: 1 }, params: { url: "https://update.googleapis.com/service/update2/json?cup2key=test", initiator: "not an origin", method: "POST" } },
  { type: 2, source: { id: 1, type: 1 }, params: { traffic_annotation: 54845618 } },
  { type: 3, source: { id: 1, type: 1 }, params: { request_headers: { headers: ["X-Goog-Update-Updater: activity_reporter-157.0.8103.38", "X-Goog-Update-AppId: {cd7cc169-013a-4c79-94bc-cf5c8d78cccf}", "X-Goog-Update-Interactivity: bg"] } } },
] });
test("only measured browser activity reporter fingerprint is separated; extension and unknown Google traffic fail closed", () => {
  assert.equal(networkRequests(fixture())[0]?.activityReporter, true);
  const variants = [
    (d: NetLog) => { d.events[0]!.params!.initiator = "chrome-extension://test"; },
    (d: NetLog) => { d.events[0]!.params!.url = "https://other.googleapis.com/service/update2/json"; },
    (d: NetLog) => { d.events[0]!.params!.url = "https://update.googleapis.com/collect"; },
    (d: NetLog) => { d.events[1]!.params!.traffic_annotation = 123; },
    (d: NetLog) => { d.events.pop(); },
    (d: NetLog) => { d.events[2]!.source!.id = 2; },
    (d: NetLog) => { d.events[0]!.params!.method = "GET"; },
  ];
  for (const mutate of variants) { const d = fixture(); mutate(d); assert.equal(networkRequests(d)[0]?.activityReporter, false); }
  const ext = fixture(); ext.events[0]!.params!.initiator = "chrome-extension://test";
  assert.equal(networkRequests(ext)[0]?.extension, true);
});
