/** NetLog attribution, not a domain allowlist. Unknown traffic remains subject to the differential gate. */
export interface NetEvent {
  type: number;
  phase?: number;
  source?: { id: number; type: number };
  params?: { url?: string; initiator?: string; method?: string; traffic_annotation?: number; request_headers?: { headers?: string[] } };
}
export interface NetLog {
  constants: { logEventTypes: Record<string, number> };
  events: NetEvent[];
}
export function networkRequests(log: NetLog) {
  const types = log.constants.logEventTypes;
  return log.events.flatMap(e => {
    if (e.type !== types.URL_REQUEST_START_JOB || !e.params?.url) return [];
    const url = new URL(e.params.url);
    const related = log.events.filter(r => r.source?.id === e.source?.id && r.source?.type === e.source?.type);
    const extension = e.params.initiator?.startsWith("chrome-extension://") === true;
    const headers = related.find(r => r.type === types.CORS_REQUEST && r.params?.request_headers)?.params?.request_headers?.headers ?? [];
    // Measured Chrome 157 activity reporter. The annotation identifies update_client,
    // headers identify its specific caller. An extension fetch cannot choose that annotation.
    // Any fingerprint change fails closed as unknown; the hostname alone grants nothing.
    const activityReporter = !extension && e.params.initiator === "not an origin" && e.params.method === "POST" &&
      url.protocol === "https:" && url.hostname === "update.googleapis.com" && url.pathname === "/service/update2/json" &&
      related.some(r => r.type === types.REQUEST_ALIVE && r.params?.traffic_annotation === 54845618) &&
      headers.includes("X-Goog-Update-AppId: {cd7cc169-013a-4c79-94bc-cf5c8d78cccf}") &&
      headers.some(h => /^X-Goog-Update-Updater: activity_reporter-\d+\.\d+\.\d+\.\d+$/.test(h)) &&
      headers.includes("X-Goog-Update-Interactivity: bg");
    return [{ url: e.params.url, initiator: e.params.initiator ?? "?", source: e.source, extension, activityReporter,
      external: ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && url.hostname !== "127.0.0.1" }];
  });
}
