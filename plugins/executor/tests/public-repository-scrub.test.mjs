import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const APPROVED_PHONE_HOME_HOSTS = new Set([
  "glitch.enhasa.cloud",
  "umami.enhasa.cloud",
]);

test("tracked public sources contain no private model-infrastructure references", () => {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const forbiddenTerms = [
    ["ni", "nfer"].join(""),
    ["30", "90"].join(""),
    ["olla", "ma-casa"].join(""),
    ["wey", "oun"].join(""),
    ["cor", "tana"].join(""),
    ["andu", "ril"].join(""),
    ["ae", "rith"].join(""),
    ["/Users/", "ben"].join(""),
    ["auld", "wyrm"].join(""),
  ];
  const violations = [];
  for (const path of paths) {
    let contents;
    try {
      contents = readFileSync(path);
    } catch {
      continue;
    }
    if (contents.includes(0)) continue;
    const text = contents.toString("utf8");
    for (const term of forbiddenTerms) {
      if (text.toLowerCase().includes(term)) violations.push(`${path}: forbidden term ${term}`);
    }
    for (const match of text.matchAll(/\b([a-z0-9.-]+\.enhasa\.cloud)\b/gi)) {
      const host = match[1].toLowerCase();
      if (!APPROVED_PHONE_HOME_HOSTS.has(host)) violations.push(`${path}: private host ${host}`);
    }
  }
  assert.deepEqual(violations, []);
});
