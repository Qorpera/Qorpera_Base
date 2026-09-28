import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CODING_GUEST_RESOURCES,
	parseCodingGuestConfiguration,
} from "../src/cloud-coding-guest-configuration.ts";

const config = () => {
	const workerId = randomUUID();
	return {
		schema: "qorpera.coding-command-guest/v4",
		workerId,
		vmId: randomUUID(),
		bootId: randomUUID(),
		uid: 200000,
		gid: 200000,
		workspacePath: `/workspace/${workerId}/repository`,
		homePath: `/workspace/${workerId}/home`,
		cachePath: `/workspace/${workerId}/cache`,
		outputRoot: `/var/lib/qorpera-coding/${workerId}/logs`,
		resourceProfile: { ...DEFAULT_CODING_GUEST_RESOURCES },
	};
};
describe("admitted coding guest profile", () => {
	it("retains the session's own layout and explicit resource policy", () => {
		const c = config();
		expect(parseCodingGuestConfiguration(c)).toEqual(c);
	});
	it("refuses another session's folders", () => {
		const c = config(),
			other = config();
		expect(() => parseCodingGuestConfiguration({ ...c, workspacePath: other.workspacePath })).toThrow("PATHS");
		expect(() => parseCodingGuestConfiguration({ ...c, outputRoot: other.outputRoot })).toThrow("PATHS");
	});
	it.each([
		{ homePath: "/workspace/repository/home" },
		{ outputRoot: "/" },
		{ cachePath: "/workspace/../cache" },
		{ homePath: "/workspace/home writable" },
		{ workspacePath: "/workspace/repository" },
		{ uid: 0 },
		{ schema: "qorpera.coding-command-guest/v3" },
		{ token: "hidden" },
	])("rejects unsafe or ambiguous path/identity profile %j", (change) => {
		expect(() => parseCodingGuestConfiguration({ ...config(), ...change })).toThrow();
	});
	it.each([
		{ maxLogBytes: 0 },
		{ maxLogBytes: 1073741825 },
		// The per-command limits are gone: a profile naming one is refused.
		{ memoryBytes: 2147483648 },
		{ maxTimeoutMs: 1800000 },
		{ extra: 1 },
	])("rejects a log bound outside the supported profile, or any other field %j", (change) => {
		const c = config();
		expect(() =>
			parseCodingGuestConfiguration({ ...c, resourceProfile: { ...c.resourceProfile, ...change } }),
		).toThrow();
	});
});
