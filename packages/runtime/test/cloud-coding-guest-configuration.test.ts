import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CODING_GUEST_RESOURCES,
	parseCodingGuestConfiguration,
} from "../src/cloud-coding-guest-configuration.ts";

const config = () => {
	const workerId = randomUUID();
	return {
		schema: "qorpera.coding-command-guest/v3",
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
		{ schema: "qorpera.coding-command-guest/v2" },
		{ token: "hidden" },
	])("rejects unsafe or ambiguous path/identity profile %j", (change) => {
		expect(() => parseCodingGuestConfiguration({ ...config(), ...change })).toThrow();
	});
	it.each([
		{ maxLogBytes: 0 },
		{ memoryBytes: 1024 },
		{ tasksMax: 100000 },
		{ cpuQuotaPercent: 0 },
		{ maxTimeoutMs: 1800001 },
		{ extra: 1 },
	])("rejects resource ceilings outside the supported profile %j", (change) => {
		const c = config();
		expect(() =>
			parseCodingGuestConfiguration({ ...c, resourceProfile: { ...c.resourceProfile, ...change } }),
		).toThrow();
	});
});
