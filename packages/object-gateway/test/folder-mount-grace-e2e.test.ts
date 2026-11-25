import { afterEach, describe, expect, it } from "vitest";
import { createLoggedMount, mounted } from "./folder-mount-e2e-harness.ts";

const program = process.env.QORPERA_FOLDER_MOUNT_BIN;
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

describe.skipIf(!program)("live desktop handoff grace through real FUSE", () => {
	it("unmounts a closed desktop after one minute when no accepted successor arrives", async () => {
		const m = await createLoggedMount(program!, cleanup, "computer_desktop");
		m.core.views.get(m.viewId)!.state = "closed";
		const started = Date.now();
		await m.service().renewLeases();
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(await mounted(m.company)).toBe(true);
		await m.exited();
		expect(Date.now() - started).toBeGreaterThanOrEqual(59_000);
		expect(Date.now() - started).toBeLessThan(65_000);
		expect(m.child().exitCode).toBe(3);
		expect(await mounted(m.company)).toBe(false);
	}, 70_000);
});
