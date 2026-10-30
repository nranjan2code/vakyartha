import assert from "node:assert/strict";
import { test } from "node:test";
import { compatibleSandboxHelper } from "../sidecar/sandbox-status.ts";

const runHelp = "--workspace --cwd --timeout-seconds --max-output-bytes";

test("sandbox helper compatibility requires the current supervised-process contract", () => {
  assert.equal(compatibleSandboxHelper({ contract: 2, supervised_processes: true, detachment_denied: true }, runHelp), false);
  assert.equal(compatibleSandboxHelper({ contract: 3, supervised_processes: true, detachment_denied: true }, runHelp), true);
  assert.equal(compatibleSandboxHelper({ contract: 3, supervised_processes: false, detachment_denied: true }, runHelp), false);
  assert.equal(compatibleSandboxHelper({ contract: 3, supervised_processes: true, detachment_denied: true }, "--workspace --cwd"), false);
});
