#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const requiredFiles = [
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/API.md",
  "docs/EXTENDING.md",
  "docs/TROUBLESHOOTING.md",
  "docs/PHASE2_ROADMAP.md",
  "src/control-plane.ts",
  "src/security.ts",
  "src/test.ts",
  "src/phase2b.test.ts",
  "src/phase2d.test.ts"
];

const missing = requiredFiles.filter((rel) => !fs.existsSync(path.join(root, rel)));

if (missing.length > 0) {
  console.error("AAHP check: FAIL");
  for (const f of missing) console.error(`- missing: ${f}`);
  process.exit(1);
}

const roadmap = fs.readFileSync(path.join(root, "docs/PHASE2_ROADMAP.md"), "utf8");
const mustContain = [
  "mandatory security",
  "release gate",
  "observability",
  "failure drills"
];

const missingPhrases = mustContain.filter((p) => !roadmap.toLowerCase().includes(p));
if (missingPhrases.length > 0) {
  console.error("AAHP check: FAIL");
  for (const p of missingPhrases) console.error(`- roadmap missing phrase: ${p}`);
  process.exit(1);
}

console.log("AAHP check: PASS");