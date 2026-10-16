/**
 * VisionGate — the service worker's side of image filtering: it authorises
 * image requests from content scripts against the current settings and
 * forwards them to the offscreen VisionHost, and turns settings changes into
 * consent revocations (unload the model, abort downloads).
 *
 * Separated from background.ts (which only wires it to Chrome APIs) so the
 * ordering between authorisation, offscreen creation, message delivery and
 * revocation can be tested deterministically together with VisionHost
 * (tests/unit/vision-gate.test.ts).
 *
 * Image consent: whenever image filtering stops being active (Images off,
 * filtering paused, no active topic) the gate records a revocation time
 * (session storage) and tells the offscreen document to shut the image model
 * down, passing that time. Every forwarded request carries `visionGrant` =
 * the latest such time known when it was authorised (read *before* the
 * settings check). A request whose authorisation is overtaken by a
 * revocation while it waits — for the offscreen document to be created or
 * for delivery — is dropped here (the check runs inside the offscreen lock
 * right before a document would be created, and before every send), and if
 * it is already on its way the offscreen document refuses its older grant.
 * Either way it cannot restart the model or recreate a closed document.
 *
 * Download consent: when download permission is withdrawn the offscreen
 * document must abort downloads in flight and refuse requests approved
 * earlier. Each approval carries `downloadGrant` = the latest revocation time
 * known here, read *before* the settings check; the offscreen document
 * refuses grants older than the newest revocation it received. Kept in
 * session storage so a restarted service worker continues the sequence (the
 * offscreen document can outlive it).
 */

import { isImageFilteringActive, type Settings } from "../shared/settings.ts";
import { isUrlExcluded } from "../shared/sites.ts";
import { checkImageUrl, initialVisionStatus, type OffscreenVision, type SkipReason, type VisionReply, type VisionStatus } from "../shared/vision.ts";

const REVOKED_KEY = "clearscroll_downloads_revoked_at";
const IMAGES_REVOKED_KEY = "clearscroll_images_revoked_at";

export interface VisionGateDeps {
  loadSettings(): Promise<Settings>;
  /**
   * Create the offscreen document if needed (serialised by the caller).
   * `stillAllowed` is evaluated inside the serialisation lock right before a
   * document would be created or replaced; false → nothing is done and the
   * call returns false.
   */
  ensureOffscreen(settings: Settings, stillAllowed: () => boolean): Promise<boolean>;
  offscreenExists(): Promise<boolean>;
  /** chrome.runtime.sendMessage to the offscreen document. */
  send(msg: unknown): Promise<unknown>;
  sessionGet(key: string): Promise<Record<string, unknown>>;
  sessionSet(items: Record<string, unknown>): Promise<void>;
  now(): number;
  /** Base delay between delivery attempts (default 100 ms). */
  retryDelayMs?: number;
}

/** A request as received from a content script (grants are assigned here, never taken from it). */
export type UnauthorisedVision = Omit<OffscreenVision, "visionGrant" | "downloadGrant">;

export class VisionGate {
  /** Last known image-model status (ui:status, popup). */
  status: VisionStatus = initialVisionStatus();
  private downloadsRevokedAt = 0;
  private imagesRevokedAt = 0;
  private readonly revocationLoaded: Promise<void>;
  private readonly deps: VisionGateDeps;

  constructor(deps: VisionGateDeps) {
    this.deps = deps;
    this.revocationLoaded = Promise.all([deps.sessionGet(REVOKED_KEY), deps.sessionGet(IMAGES_REVOKED_KEY)]).then(
      ([d, i]) => {
        this.downloadsRevokedAt = Math.max(this.downloadsRevokedAt, Number(d[REVOKED_KEY]) || 0);
        this.imagesRevokedAt = Math.max(this.imagesRevokedAt, Number(i[IMAGES_REVOKED_KEY]) || 0);
      },
      () => undefined
    );
  }

  resetStatus(): void {
    this.status = initialVisionStatus();
  }

  skip(generation: number, reason: SkipReason, error: string): VisionReply {
    return { ok: false, generation, reason, error, vision: this.status };
  }

  /** Settings changed from `prev` to `next` (normalised, not equal). */
  settingsChanged(prev: Settings | null, next: Settings): void {
    // Download permission withdrawn (downloads, images or filtering off, no
    // active topic) or a site newly excluded: abort downloads in flight.
    if (prev && downloadsAllowed(prev) && (!downloadsAllowed(next) || next.excludedSites.some((h) => !prev.excludedSites.includes(h)))) this.revokeDownloads();
    // Image filtering stopped (Images off, paused, no active topic): unload
    // the image model and void earlier authorisations; text keeps running.
    // Fire-and-forget: messaging the offscreen document must never delay
    // content-script registration.
    if (prev && isImageFilteringActive(prev) && !isImageFilteringActive(next)) this.unloadImageModel();
  }

  private revokeDownloads(): void {
    this.downloadsRevokedAt = Math.max(this.deps.now(), this.downloadsRevokedAt + 1);
    const revokedAt = this.downloadsRevokedAt;
    void this.deps.sessionSet({ [REVOKED_KEY]: revokedAt }).catch(() => undefined);
    void this.deps
      .offscreenExists()
      .then((exists) => (exists ? this.deps.send({ type: "off:vision-revoke-downloads", target: "offscreen", revokedAt }) : undefined))
      .catch(() => undefined);
  }

  private unloadImageModel(): void {
    this.imagesRevokedAt = Math.max(this.deps.now(), this.imagesRevokedAt + 1);
    const revokedAt = this.imagesRevokedAt;
    this.resetStatus();
    void this.deps.sessionSet({ [IMAGES_REVOKED_KEY]: revokedAt }).catch(() => undefined);
    void this.deps
      .offscreenExists()
      .then((exists) => (exists ? this.deps.send({ type: "off:vision-shutdown", target: "offscreen", revokedAt }) : undefined))
      .catch(() => undefined);
  }

  /** Authorise and forward one image request (frameKey already attached). */
  async forward(request: UnauthorisedVision, frameUrl: string | undefined): Promise<VisionReply> {
    let msg = request as OffscreenVision;
    // The grant is taken before the settings are read: if permission is
    // withdrawn in between, the grant predates the revocation and is refused.
    await this.revocationLoaded;
    const grant = this.downloadsRevokedAt;
    const visionGrant = this.imagesRevokedAt;
    /** No image-filtering revocation since this request was authorised. */
    const stillAllowed = () => this.imagesRevokedAt === visionGrant;
    const settings = await this.deps.loadSettings();
    if (!isImageFilteringActive(settings)) return this.skip(msg.generation, "disabled", "image filtering is off");
    if (!frameUrl || isUrlExcluded(frameUrl, settings.excludedSites)) return this.skip(msg.generation, "disabled", "site excluded");
    if (msg.image.kind === "url") {
      // Downloads are the one network-visible behaviour: re-checked here so a
      // stale or misbehaving content script cannot trigger them.
      if (!settings.imageDownloads) return this.skip(msg.generation, "downloads-off", "image downloads are not allowed");
      const checked = checkImageUrl(msg.image.url);
      if (!checked.ok) return this.skip(msg.generation, "ineligible-url", checked.error);
      msg = { ...msg, visionGrant, downloadGrant: grant };
    } else {
      msg = { ...msg, visionGrant, downloadGrant: undefined };
    }
    const revoked = () => this.skip(msg.generation, "disabled", "image filtering was turned off");
    // Waiting for the offscreen document can take long (creation, the lock
    // held by a close): a revocation meanwhile ends the request here, and no
    // document is created or recreated for it.
    if (!(await this.deps.ensureOffscreen(settings, stillAllowed)) || !stillAllowed()) return revoked();
    for (let attempt = 0; ; attempt++) {
      if (!stillAllowed()) return revoked();
      try {
        const reply = (await this.deps.send(msg)) as VisionReply | undefined;
        if (!reply) throw new Error("no reply from vision host");
        if (reply.vision) this.status = reply.vision;
        return reply;
      } catch (err) {
        if (attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, (this.deps.retryDelayMs ?? 100) * (attempt + 1)));
      }
    }
  }
}

function downloadsAllowed(s: Settings): boolean {
  return isImageFilteringActive(s) && s.imageDownloads;
}
