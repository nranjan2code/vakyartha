import test from "node:test";
import assert from "node:assert/strict";
import { fitTurnControls } from "../sidecar/turn-controls.ts";

test("turn controls keep thinking and effort only where the model can reason", () => {
  assert.deepEqual(fitTurnControls({ think: true, effort: "high" }, { thinking: true }), { think: true, effort: "high" });
  assert.deepEqual(fitTurnControls({ think: true, effort: "high" }, { thinking: false }), { think: false }, "a non-reasoning model gets neither");
  assert.deepEqual(fitTurnControls({ think: true, effort: "medium" }, undefined), { think: true, effort: "medium" }, "unknown capability keeps the decision");
  assert.deepEqual(fitTurnControls({ think: "yes", effort: "max" }, { thinking: true }), { think: false }, "only valid values pass");
});
