import { describe, expect, it } from "vitest";
import { errorCode, parseCodingExecutorConfiguration } from "../../../deploy/coding-worker/executor.ts";

function fixture() {
	return {
		schema: "qorpera.coding-executor-service/v4",
		owner: "node-coding",
		supabaseUrl: "https://project.supabase.co",
		commandPort: 8789,
		storagePolicy: {
			schema: "qorpera.coding-nas-policy/v1",
			mountPoint: "/srv/coding",
			rootPath: "/srv/coding/executor",
			source: "192.168.1.40:/coding",
			serverAddress: "192.168.1.40",
		},
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
			workspacePath: "/workspace/repository",
			homePath: "/workspace/home",
			cachePath: "/workspace/cache",
			outputRoot: "/var/lib/qorpera-coding/logs",
			storageHelperSha256: "d".repeat(64),
			resourceProfile: {
				maxTimeoutMs: 1800000,
				memoryBytes: 2147483648,
				tasksMax: 256,
				cpuQuotaPercent: 200,
				maxLogBytes: 67108864,
			},
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
const broker = { origin: "https://secrets.qorpera.test", executorTokenCredential: "qorpera-coding-broker-executor" };
describe("coding executor service configuration", () => {
	it("accepts pinned VM policy with repository-specific systemd credentials", () => {
		const config = parseCodingExecutorConfiguration(fixture());
		expect(config.repositories[0].credential).toBe("qorpera-coding-repository-test");
		expect(config.broker).toBeNull();
	});
	it("serves a repository through the company's GitHub connection when it names no static credential", () => {
		const config = fixture();
		const parsed = parseCodingExecutorConfiguration({
			...config,
			broker,
			repositories: [
				{ repository: config.repositories[0].repository },
				{
					repository: { host: "github.com", owner: "Qorpera", name: "proof", baseBranch: "main" },
					credential: "qorpera-coding-repository-proof",
				},
			],
		});
		expect(parsed.broker).toEqual(broker);
		expect(parsed.repositories.map((entry) => entry.credential)).toEqual([null, "qorpera-coding-repository-proof"]);
		// Without a broker there is no path for a repository without a static file.
		expect(() =>
			parseCodingExecutorConfiguration({
				...config,
				repositories: [{ repository: config.repositories[0].repository }],
			}),
		).toThrow("CONFIG_INVALID");
	});
	it("refuses a broker that is not an HTTPS origin or reuses another credential's name", () => {
		const config = fixture();
		for (const origin of [
			"http://secrets.qorpera.test",
			"https://user:secret@secrets.qorpera.test",
			"https://secrets.qorpera.test/v1",
			"https://secrets.qorpera.test/?company=x",
		])
			expect(() => parseCodingExecutorConfiguration({ ...config, broker: { ...broker, origin } })).toThrow();
		for (const executorTokenCredential of [
			"qorpera-coding-registry",
			"qorpera-coding-command",
			"qorpera-coding-executor-config",
			"qorpera-coding-repository-test",
			"../broker",
			"broker-runtime",
		])
			expect(() =>
				parseCodingExecutorConfiguration({ ...config, broker: { ...broker, executorTokenCredential } }),
			).toThrow("CONFIG_INVALID");
		expect(() =>
			parseCodingExecutorConfiguration({ ...config, broker: { ...broker, token: "inline-secret" } }),
		).toThrow("CONFIG_INVALID");
	});
	it("refuses the previous schema and unknown keys", () => {
		expect(() =>
			parseCodingExecutorConfiguration({ ...fixture(), schema: "qorpera.coding-executor-service/v3" }),
		).toThrow("CONFIG_INVALID");
		expect(() => parseCodingExecutorConfiguration({ ...fixture(), token: "inline-secret" })).toThrow(
			"CONFIG_INVALID",
		);
		const config = fixture();
		expect(() =>
			parseCodingExecutorConfiguration({
				...config,
				broker,
				repositories: [{ repository: config.repositories[0].repository, credential: null }],
			}),
		).toThrow("CONFIG_INVALID");
	});
	it.each(["supabaseUrl"])("rejects secret-bearing or non-origin %s", (key) => {
		expect(() =>
			parseCodingExecutorConfiguration({ ...fixture(), [key]: "https://user:secret@example.com" }),
		).toThrow();
		expect(() =>
			parseCodingExecutorConfiguration({ ...fixture(), [key]: "https://example.com/arbitrary" }),
		).toThrow();
	});
	it("rejects local workspace paths, missing NAS policy and resources above the VM", () => {
		const config = fixture();
		expect(() => parseCodingExecutorConfiguration({ ...config, storagePolicy: undefined })).toThrow();
		expect(() =>
			parseCodingExecutorConfiguration({ ...config, guest: { ...config.guest, workspacePath: "/tmp/repo" } }),
		).toThrow();
		expect(() =>
			parseCodingExecutorConfiguration({
				...config,
				guest: { ...config.guest, resourceProfile: { ...config.guest.resourceProfile, cpuQuotaPercent: 300 } },
			}),
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

describe("executor error codes", () => {
	it("logs only the fixed CODING_* and LXD codes, never other text", () => {
		expect(errorCode(new Error("CODING_HOST_GUEST_NOT_READY"))).toBe("CODING_HOST_GUEST_NOT_READY");
		expect(errorCode(new Error("LXD instance command failed"))).toBe("LXD instance command failed");
		expect(errorCode(new Error("token ghp_abcdefghijklmnopqrstuvwxyz0123 refused"))).toBe("UNCLASSIFIED");
		expect(errorCode(new Error("LXD request failed: https://x/?token=abc"))).toBe("UNCLASSIFIED");
		expect(errorCode("CODING_X")).toBe("UNCLASSIFIED");
	});
});
