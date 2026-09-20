import { FEEDBACK_KEY, FEEDBACK_LIMIT, retainedFeedback, sanitizeFeedback } from "../shared/feedback.ts";
import { activeTopics, type Settings } from "../shared/settings.ts";
import { isUrlExcluded } from "../shared/sites.ts";

/** One writer in the service worker; delete/export/save are serialized across tabs. */
export class FeedbackStore {
  private chain: Promise<unknown> = Promise.resolve();
  run(type: string, value: unknown, settings: () => Promise<Settings>, url?: string): Promise<unknown> {
    const job = this.chain.then(async () => {
      if (type === "feedback:clear") {
        await chrome.storage.local.remove(FEEDBACK_KEY);
        return { ok: true, records: [] };
      }
      const raw = (await chrome.storage.local.get(FEEDBACK_KEY))[FEEDBACK_KEY];
      const records = retainedFeedback(raw, Date.now());
      if (type === "feedback:save") {
        const draft = sanitizeFeedback(value);
        const s = await settings();
        const topic = activeTopics(s).find(t => t.id === draft?.topicId);
        if (!draft || !topic || !s.enabled || s.mode !== draft.mode || !url || !/^https?:\/\//.test(url) || isUrlExcluded(url, s.excludedSites)) throw Error("Settings changed; reopen feedback on an active page.");
        records.push({ ...draft, topic: topic.text, id: crypto.randomUUID(), createdAt: Date.now(), version: chrome.runtime.getManifest().version, reviewStatus: "unreviewed-user-report" });
      }
      const bounded = records.slice(-FEEDBACK_LIMIT);
      if (JSON.stringify(raw) !== JSON.stringify(bounded)) await chrome.storage.local.set({ [FEEDBACK_KEY]: bounded });
      // Content scripts never receive the user's other reports.
      return type === "feedback:save" ? { ok: true } : { ok: true, records: bounded };
    });
    this.chain = job.catch(() => undefined);
    return job;
  }
}
