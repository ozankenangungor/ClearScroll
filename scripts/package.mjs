// Create release/clearscroll-<version>.zip from a validated dist/ plus a
// checksum file. Does not publish anything.
import fs from "node:fs";
import path from "node:path";
import { REPO, capture, fail, run, sha256, step } from "./lib.mjs";

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
run("node", ["scripts/validate-dist.mjs"]);
const outDir = path.join(REPO, "release");
fs.mkdirSync(outDir, { recursive: true });
const zip = path.join(outDir, `clearscroll-${pkg.version}.zip`);
fs.rmSync(zip, { force: true });
if (capture("zip", ["-v"]) === null) fail("the 'zip' command is required to package the extension");
step(`Packaging ${path.relative(REPO, zip)}`);
// -X: no extra file attributes, -D: no directory entries → stable archives.
run("zip", ["-q", "-r", "-X", "-D", zip, "."], { cwd: path.join(REPO, "dist") });
const digest = sha256(zip);
fs.writeFileSync(`${zip}.sha256`, `${digest}  ${path.basename(zip)}\n`);
step(`${(fs.statSync(zip).size / 1048576).toFixed(1)} MiB, sha256 ${digest}`);
