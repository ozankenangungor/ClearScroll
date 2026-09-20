// Metadata-only review queue from the existing LOCAL Phase 3 ledgers. No holdout access.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const ledgerPath = process.argv[2] ?? "build/phase3b-evidence/candidate-error-ledger.json";
const registerPath = process.argv[3] ?? "build/phase3c-evidence/issue-register.json";
const output = process.argv[4] ?? "build/phase4b-evidence/REVIEW-QUEUE.json";
const ledgerBytes = fs.readFileSync(ledgerPath), registerBytes = fs.readFileSync(registerPath);
const ledger = JSON.parse(ledgerBytes), register = JSON.parse(registerBytes);
if (new Set(ledger.map(r => r.id)).size !== ledger.length || register.length !== ledger.length || register.some(r => !ledger.some(l => l.id === r.id))) throw Error("Ledger IDs disagree");
const rows = register.map(r => ({
  id: r.id, topic: r.topic, candidateType: r.candidateType,
  priorStatus: r.phase3cStatus, priorEvidence: r.evidence,
  mechanicalEvidence: r.phase3cStatus.startsWith("verified ") ? "reproduced-boundary-or-authored-probe" : "observation",
  relevanceReview: /provisional/.test(r.phase3cStatus) ? "provisional-ai-judgment" : "unreviewed",
  humanLabel: null, reviewer: null, reviewedAt: null, publicReproduction: null, scopeNotes: null,
}));
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ schema: 1, phase3bSha256: sha(ledgerBytes), phase3cSha256: sha(registerBytes), rows }, null, 2) + "\n");
console.log(`${rows.length} metadata-only review rows; no human labels created: ${output}`);
