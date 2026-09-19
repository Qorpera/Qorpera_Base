import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCodingExecutorConfiguration } from "../../../deploy/coding-worker/executor.ts";

function fixture() {
	return {
		schema: "qorpera.coding-executor-service/v1",
		owner: "node-coding",
		supabaseUrl: "https://project.supabase.co",
		supabasePublishableKey: "publishable",
		orchestratorId: randomUUID(),
		providerUrl: "https://native.example.com",
		providerAdapterId: "native-node",
		commandPort: 8789,
		vmPolicy: {
			providerId: "native-node",
			providerPolicySha256: "a".repeat(64),
			project: "coding",
			imageFingerprint: "b".repeat(64),
			bootstrapSha256: "c".repeat(64),
			storagePool: "coding-disks",
			network: "coding-net",
			cpus: 2,
			memoryBytes: 4096 * 1024 ** 2,
			rootDiskBytes: 64 * 1024 ** 3,
		},
		guest: {
			uid: 1000,
			gid: 1000,
			workspacePath: "/workspace",
			commandHelperSha256: "a".repeat(64),
			gitHelperSha256: "b".repeat(64),
			watchdogHelperSha256: "c".repeat(64),
		},
		repositories: [
			{
				repository: { host: "github.com", owner: "Qorpera", name: "test", baseBranch: "main" },
				credential: "qorpera-coding-repository-test",
			},
		],
	};
}
describe("coding executor service configuration", () => {
	it("accepts pinned VM policy with repository-specific systemd credentials", () => {
		expect(parseCodingExecutorConfiguration(fixture()).repositories[0].credential).toBe(
			"qorpera-coding-repository-test",
		);
	});
	it.each(["supabaseUrl", "providerUrl"])("rejects secret-bearing or non-origin %s", (key) => {
		expect(() =>
			parseCodingExecutorConfiguration({ ...fixture(), [key]: "https://user:secret@example.com" }),
		).toThrow();
		expect(() =>
			parseCodingExecutorConfiguration({ ...fixture(), [key]: "https://example.com/arbitrary" }),
		).toThrow();
	});
	it("rejects arbitrary credential paths, duplicated repositories and missing watchdog pins", () => {
		const config = fixture();
		expect(() =>
			parseCodingExecutorConfiguration({
				...config,
				repositories: [{ ...config.repositories[0], credential: "../secret" }],
			}),
		).toThrow();
		expect(() =>
			parseCodingExecutorConfiguration({
				...config,
				repositories: [...config.repositories, ...config.repositories],
			}),
		).toThrow();
		expect(() =>
			parseCodingExecutorConfiguration({ ...config, guest: { ...config.guest, watchdogHelperSha256: "" } }),
		).toThrow();
	});
});
