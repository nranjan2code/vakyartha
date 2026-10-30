import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderConsents, parseConsentSlice, parseConsentReceipt } from "../shared/provider-consent.ts";
const view = () => ({ root_id: "root", session_id: "session", goal: "Review selected source", remaining_seconds: 299, approval: { ticket_id: "provider-request", fingerprint: "a".repeat(64), disclosure: { provider: "ollama", model: "local-model", operation: "ollama_chat", destination: "http://127.0.0.1:11434/api/chat", max_output_tokens: 256, preview: "user-selected context" } } });
test("permission boundaries reject duplicate/unbounded disclosures and foreign decision receipts", () => {
  assert.deepEqual(parseProviderConsents([view()]), [view()]);
  for (const invalid of [[view(), view()], Array.from({ length: 5 }, (_, i) => ({ ...view(), root_id: `r${i}` })), [{ ...view(), remaining_seconds: 301 }], [{ ...view(), approval: { ...view().approval, fingerprint: "wrong" } }]]) assert.throws(() => parseProviderConsents(invalid));
  assert.equal(parseConsentReceipt({ ticket_id: "provider-request", state: "allowed", operation_id: "provider-operation" }, "provider-request").state, "allowed");
  for (const invalid of [{ ticket_id: "foreign", state: "allowed", operation_id: "operation" }, { ticket_id: "provider-request", state: "allowed", operation_id: null }, { ticket_id: "provider-request", state: "allow_chat", operation_id: "operation" }]) assert.throws(() => parseConsentReceipt(invalid, "provider-request"));
});
test("request pages retain exact UTF-8 byte bounds and cannot claim progress without bytes", () => {
  assert.deepEqual(parseConsentSlice({ offset: 0, next: 4, total: 8, text: "😀" }), { offset: 0, next: 4, total: 8, text: "😀" });
  for (const invalid of [{ offset: 0, next: 1, total: 8, text: "😀" }, { offset: 0, next: 0, total: 8, text: "" }, { offset: 0, next: 4097, total: 5000, text: "a".repeat(4097) }, { offset: 0, next: 0, total: 0, text: "" }]) assert.throws(() => parseConsentSlice(invalid));
});
