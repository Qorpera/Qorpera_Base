import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CODING_GUEST_RESOURCES,
	parseCodingGuestConfiguration,
} from "../src/cloud-coding-guest-configuration.ts";

const config = () => ({
	schema: "qorpera.coding-command-guest/v2",
	workerId: randomUUID(),
	vmId: randomUUID(),
	bootId: randomUUID(),
	uid: 1000,
	gid: 1000,
	workspacePath: "/workspace/repository",
	homePath: "/workspace/home",
	cachePath: "/workspace/cache",
	outputRoot: "/var/lib/qorpera-coding/logs",
	resourceProfile: { ...DEFAULT_CODING_GUEST_RESOURCES },
});
describe("admitted coding guest profile", () => {
	it("retains disjoint NAS projection paths and explicit resource policy", () => {
		const c = config();
		expect(parseCodingGuestConfiguration(c)).toEqual(c);
	});
	it.each([
		{ homePath: "/workspace/repository/home" },
		{ outputRoot: "/" },
		{ cachePath: "/workspace/../cache" },
		{ homePath: "/workspace/home writable" },
		{ uid: 0 },
		{ schema: "qorpera.coding-command-guest/v1" },
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
