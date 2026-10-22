# Rollback

Do not replace or load the candidate into either protected private-alpha installation/profile. Keep both launchers, source, ZIPs, models and evidence intact.

Canonical 0.3.5 source: a15a9136610fe4d0a132656e22397573f9cefa3d. ZIP: build/alpha035-evidence/clearscroll-0.3.5-private-alpha.zip, SHA-256 620ac498bca0dbad138ddeeae2ba43f3ceac6f6c4641cfb9baf60ded4c045b60. Canonical 0.3.4 ZIP SHA-256 e77c3522318655d2c85bfac718a7afe922b27ae678383751e30066b9e608070e.

For local candidate testing, pause filtering, close only the disposable test browser, then delete its disposable profile if unwanted. Continue using the untouched 0.3.5 launcher/profile. Do not downgrade a populated personal Chrome profile or copy test settings into it. Page reload restores normal browsing after removal if needed.

For future published rollback, Chrome Web Store updates require a greater numeric version: do not attempt to publish 0.3.5 over 0.4.0. Review the frozen source, carry a focused rollback into a new higher version on a separate authorized release branch, rerun the release gates and obtain publisher authorization. No public rollback or deployment was performed here.
