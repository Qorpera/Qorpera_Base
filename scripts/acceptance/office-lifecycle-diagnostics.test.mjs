import assert from "node:assert/strict";
import test from "node:test";
import { officeJournalDiagnostic } from "./office-lifecycle-diagnostics.mjs";

test("office failure diagnostics export fixed states without journal credentials or arbitrary strings", () => {
	assert.deepEqual(officeJournalDiagnostic({ schema: "qorpera.lxd-office-operation-event/v2", state: "pending", action: "start", kind: "accepted", startSettled: false,
		secret: "private-token", operationId: "private-value", error: "private error", context: { token: "private-token" } }),
		{ schema: "qorpera.lxd-office-operation-event/v2", state: "pending", kind: "accepted", action: "start", startSettled: false });
	assert.deepEqual(officeJournalDiagnostic({ schema: "private-token", state: "private-token", kind: "private-token", startSettled: "private-token" }), {});
	assert.deepEqual(officeJournalDiagnostic(null), {});
});
