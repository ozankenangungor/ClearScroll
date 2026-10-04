# ClearScroll 0.3.4 private alpha

Use the **ClearScroll 0.3.4 Private Alpha** launcher. It opens Chrome Stable
with a separate persistent profile. The launcher's Settings link lets you
choose topics; no topics or exclusions are preconfigured. Normal browser
profiles and the default browser are unchanged.

Click blurred content to reveal it. Pause filtering when needed. Optional
per-topic text exclusions use literal phrases, not semantic negative prompts.
They can also leave mixed relevant content visible. See
[scope controls](PHASE4E-QUALITY.md).

Images are a separate opt-in mode. Other-domain picture downloads have a
second, separate permission toggle and are off by default. Text inference
remains local. Feedback is optional, stored locally, and can be exported or
deleted from Settings. Explicit downloads from the private window are saved
in its `user-exports` directory; they are not automatically copied elsewhere.

The launcher has an optional NVIDIA action. Close the private window before
switching launcher modes. Automatic mode keeps working through CPU fallback
when Chrome does not expose a usable hardware adapter.

This remains a conditional private alpha. Known classification limits include
unrelated-topic matches, ambiguous football/cats meanings, short-heading
misses, truncated long text and context-dependent metadata. Reveal, pause and
explicit topic scope are practical controls, not guarantees of relevance.

The stabilization corrects an E2E diagnostic assumption: a software-GPU worker
can fail before returning self-test numbers, so safe CPU fallback need not
contain the words “canary” or “self-test.” The harness accepts only the observed
`Uncaught RuntimeError: unreachable` alternative and additionally verifies
fresh CPU parity and truthful semantic status. Numerical safety tests remain
strict. No production engine, classifier, weights, thresholds or 0.3.4 artifact
changed. The underlying intermittent software-GPU trap is not claimed fixed.

Full test accounting, private installation/launcher paths, validation and
hashes are retained under `build/alpha034-stabilization/`.
