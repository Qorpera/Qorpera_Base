import assert from "node:assert/strict";
import test from "node:test";
import { OFFICE_IMAGE_SELF_UPDATE_UNITS } from "../packages/runner-orchestrator/src/lxd-office-image-installation.ts";
import { GUEST_IMAGE_SELF_UPDATE_UNITS } from "../packages/runtime/src/lxd-guest-image-updates.ts";

// Two packages that cannot import each other; this keeps their lists equal.
test("the office image installer masks exactly the units the office guest refuses to run without", () => {
	assert.deepEqual([...OFFICE_IMAGE_SELF_UPDATE_UNITS], [...GUEST_IMAGE_SELF_UPDATE_UNITS]);
});
