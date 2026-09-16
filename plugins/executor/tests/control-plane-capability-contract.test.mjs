import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const registry = JSON.parse(await readFile(resolve(root, "docs/research/006-control-plane-host-matrix.json"), "utf8"));
const plugins = JSON.parse(await readFile(resolve(root, "plugins/capabilities.json"), "utf8"));
const expectedSurfaces = [
  "codex-tui-standalone", "codex-tui-companion", "codex-desktop", "claude-code-tui",
  "claude-desktop-code-local", "claude-desktop-chat", "claude-desktop-cowork", "claude-agent-sdk-custom-host",
  "codex-windows-native-tui", "claude-windows-native-tui", "codex-windows-wsl-tui", "claude-windows-wsl-tui",
  "codex-windows-desktop", "claude-windows-desktop-code-local", "claude-windows-desktop-code-wsl",
  "opencode-tui", "pi-tui", "cursor-agent", "omx-codex-tui",
];
const capabilityFields = ["tool_policy", "native_approval", "approval_resume", "model_routing", "live_approval_journey"];

function validateOperatingEvidence(inventory) {
  for (const row of inventory.surfaces) {
    if (!["implemented", "experimental", "partial"].includes(row.live_approval_journey)) continue;
    const receipts = row.evidence.map(id => inventory.evidence[id]).filter(entry => entry?.kind === "live_approval_receipt");
    assert.ok(receipts.length, `${row.id} requires a live approval receipt`);
    const required = row.live_approval_journey === "partial" ? row.verified_cases : inventory.required_acceptance_cases;
    assert.ok(Array.isArray(required) && required.length > 0, `${row.id} needs an explicit verified scope`);
    for (const receipt of receipts) {
      assert.equal(receipt.surface_id, row.id);
      for (const field of ["host_version", "environment", "source_revision", "observed_at"]) {
        assert.ok(typeof receipt[field] === "string" && receipt[field].trim(), `${row.id}/${field}`);
      }
      assert.match(receipt.source_tree_digest, /^[a-f0-9]{64}$/);
      assert.equal(receipt.outcome, "pass");
      assert.ok(receipt.url || receipt.path, `${row.id} receipt locator`);
      assert.ok(Array.isArray(receipt.cases), `${row.id} receipt cases`);
    }
    for (const name of required) {
      assert.ok(inventory.required_acceptance_cases.includes(name), `${row.id} unknown case ${name}`);
      assert.ok(receipts.some(receipt => receipt.cases.includes(name)), `${row.id} lacks ${name}`);
    }
  }
}

test("control-plane inventory keeps every released plugin and distinct host boundary visible", () => {
  assert.equal(registry.schema, "statewright/control-plane-host-matrix/v1");
  assert.deepEqual(registry.surfaces.map(row => row.id).sort(), [...expectedSurfaces].sort());
  assert.deepEqual([...new Set(registry.surfaces.map(row => row.plugin))].sort(), Object.keys(plugins.plugins).sort());
  for (const row of registry.surfaces) {
    assert.equal(typeof row.companion_required, "boolean", row.id);
    assert.ok(row.runtime_owner && row.scope, row.id);
    for (const field of capabilityFields) assert.ok(Object.hasOwn(registry.definitions, row[field]), `${row.id}/${field}`);
  }
});

test("evidence references exist and external protocol evidence is not local implementation proof", async () => {
  for (const row of registry.surfaces) {
    assert.ok(row.evidence.length > 0, row.id);
    for (const id of row.evidence) assert.ok(Object.hasOwn(registry.evidence, id), `${row.id}/${id}`);
    if (["implemented", "experimental"].includes(row.native_approval)) {
      assert.ok(row.evidence.some(id => ["source", "external_source"].includes(registry.evidence[id].kind)), row.id);
    }
  }
  validateOperatingEvidence(registry);
  for (const entry of Object.values(registry.evidence)) {
    if (["source", "test_source"].includes(entry.kind)) {
      assert.ok(!entry.path.startsWith("/") && !entry.path.split("/").includes(".."));
      await access(resolve(root, entry.path));
    } else {
      assert.ok(entry.url || (entry.kind === "external_source" && entry.repository && entry.revision));
    }
  }
});

test("standalone, companion and Windows evidence cannot be conflated", () => {
  const byId = Object.fromEntries(registry.surfaces.map(row => [row.id, row]));
  assert.equal(byId["codex-tui-standalone"].companion_required, false);
  assert.equal(byId["codex-tui-companion"].companion_required, true);
  assert.ok(!byId["codex-tui-standalone"].evidence.some(id => registry.evidence[id].kind === "external_source"));
  for (const id of ["codex-windows-native-tui", "claude-windows-native-tui"]) {
    assert.ok(byId[id].evidence.includes("windows_ci"));
    assert.notEqual(registry.evidence.windows_ci.kind, "live_approval_receipt");
  }
});

test("partial live support cannot borrow transport evidence or a bare receipt URL", () => {
  const inventory = structuredClone(registry);
  const row = inventory.surfaces.find(value => value.id === "codex-windows-native-tui");
  row.live_approval_journey = "partial";
  row.verified_cases = ["authorized-native-approve"];
  assert.throws(() => validateOperatingEvidence(inventory), /requires a live approval receipt/);
  inventory.evidence.stub = { kind: "live_approval_receipt", url: "https://example.invalid/receipt" };
  row.evidence.push("stub");
  assert.throws(() => validateOperatingEvidence(inventory));
});

test("live support receipts bind exact surface, source and declared acceptance scope", () => {
  const inventory = structuredClone(registry);
  const row = inventory.surfaces.find(value => value.id === "claude-desktop-chat");
  row.live_approval_journey = "partial";
  row.verified_cases = ["cancel-remains-pending"];
  const receipt = {kind: "live_approval_receipt", surface_id: row.id, host_version: "fixture-version",
    environment: "fixture-macos", source_revision: "fixture-revision", observed_at: inventory.as_of,
    source_tree_digest: "a".repeat(64), outcome: "pass", url: "https://example.invalid/receipt",
    cases: [...row.verified_cases]};
  inventory.evidence.fixture = receipt;
  row.evidence.push("fixture");
  assert.doesNotThrow(() => validateOperatingEvidence(inventory));
  receipt.surface_id = "claude-desktop-cowork";
  assert.throws(() => validateOperatingEvidence(inventory));
  receipt.surface_id = row.id;
  receipt.cases = [];
  assert.throws(() => validateOperatingEvidence(inventory), /lacks cancel-remains-pending/);
});

test("audit retains release hold and ownership/security acceptance cases", () => {
  assert.equal(registry.production_promotion, "held");
  for (const name of ["blocked-effect-before-decision", "unauthorized-no-decision-controls",
    "cold-resume-reopens-pending", "newer-input-invalidates-stale-release", "parent-child-session-isolation",
    "artifact-change-invalidates-decision", "duplicate-reply-single-release"]) {
    assert.ok(registry.required_acceptance_cases.includes(name), name);
  }
});
