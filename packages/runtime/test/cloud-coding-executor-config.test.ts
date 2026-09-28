import { describe, expect, it } from "vitest";
import { errorCode, parseCodingExecutorConfiguration } from "../../../deploy/coding-worker/executor.ts";

function fixture() {
	return {
		schema: "qorpera.coding-executor-service/v7",
		owner: "node-coding",
		supabaseUrl: "https://project.supabase.co",
		commandPort: 8789,
		peerCommandPort: 8790,
		commandPeers: [],
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
			storageHelperSha256: "d".repeat(64),
			resourceProfile: {
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
			parseCodingExecutorConfiguration({ ...fixture(), schema: "qorpera.coding-executor-service/v5" }),
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
	it("accepts trusted peer identities and rejects ambiguous routes or credential reuse", () => {
		const peer = {
			owner: "node-other",
			providerId: "native-other",
			origin: "https://peer.qorpera.test",
			tokenCredential: "qorpera-coding-peer-other",
		};
		expect(parseCodingExecutorConfiguration({ ...fixture(), commandPeers: [peer] }).commandPeers).toEqual([peer]);
		for (const commandPeers of [
			[peer, peer],
			[{ ...peer, owner: fixture().owner }],
			[{ ...peer, origin: "http://peer.qorpera.test" }],
			[{ ...peer, origin: "https://peer.qorpera.test/commands" }],
			[{ ...peer, tokenCredential: "qorpera-coding-peer-command" }],
			[{ ...peer, tokenCredential: "qorpera-coding-command" }],
			[{ ...peer, tokenCredential: "qorpera-coding-registry" }],
			[{ ...peer, tokenCredential: "qorpera-coding-repository-test" }],
		])
			expect(() => parseCodingExecutorConfiguration({ ...fixture(), commandPeers })).toThrow();
		expect(() => parseCodingExecutorConfiguration({ ...fixture(), peerCommandPort: 8789 })).toThrow();
		expect(() =>
			parseCodingExecutorConfiguration({
				...fixture(),
				commandPeers: [peer],
				broker: { ...broker, executorTokenCredential: peer.tokenCredential },
			}),
		).toThrow();
	});
	it.each(["supabaseUrl"])("rejects secret-bearing or non-origin %s", (key) => {
		expect(() =>
			parseCodingExecutorConfiguration({ ...fixture(), [key]: "https://user:secret@example.com" }),
		).toThrow();
		expect(() =>
			parseCodingExecutorConfiguration({ ...fixture(), [key]: "https://example.com/arbitrary" }),
		).toThrow();
	});
	it("rejects configured workspace paths, a session-range coding uid, missing NAS policy and resources above the VM", () => {
		const config = fixture();
		expect(() => parseCodingExecutorConfiguration({ ...config, storagePolicy: undefined })).toThrow();
		// Every session's folders derive from the session; none is configured.
		expect(() =>
			parseCodingExecutorConfiguration({ ...config, guest: { ...config.guest, workspacePath: "/tmp/repo" } }),
		).toThrow("CONFIG_INVALID");
		// The image's coding user and group stay below the uids SQL gives sessions.
		for (const ids of [
			{ uid: 200000, gid: 200000 },
			{ uid: 1100, gid: 200000 },
		])
			expect(() => parseCodingExecutorConfiguration({ ...config, guest: { ...config.guest, ...ids } })).toThrow(
				"RESOURCE_POLICY_INVALID",
			);
		expect(() =>
			parseCodingExecutorConfiguration({
				...config,
				guest: { ...config.guest, resourceProfile: { ...config.guest.resourceProfile, cpuQuotaPercent: 200 } },
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
	it("keeps a coded reason and an LXD status, never free text after them", () => {
		expect(errorCode(new Error("CODING_HOST_MACHINE_REFUSED:MACHINE_CAPACITY_EXHAUSTED"))).toBe(
			"CODING_HOST_MACHINE_REFUSED:MACHINE_CAPACITY_EXHAUSTED",
		);
		expect(errorCode(new Error("LXD request failed (404)"))).toBe("LXD request failed (404)");
		expect(errorCode(new Error("CODING_HOST_MACHINE_REFUSED:"))).toBe("UNCLASSIFIED");
		expect(errorCode(new Error("CODING_X:reason with spaces"))).toBe("UNCLASSIFIED");
		expect(errorCode(new Error("CODING_X:A:B"))).toBe("UNCLASSIFIED");
		expect(errorCode(new Error("LXD request failed (4040)"))).toBe("UNCLASSIFIED");
		expect(errorCode(new Error("LXD: VM agent isn't currently running"))).toBe("UNCLASSIFIED");
	});
	it("names aborts and timeouts, preferring their coded reason", () => {
		expect(errorCode(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe(
			"TimeoutError",
		);
		const aborted = new AbortController();
		aborted.abort();
		expect(errorCode(aborted.signal.reason)).toBe("AbortError");
		const lease = Object.assign(new Error("The operation was aborted"), {
			name: "AbortError",
			cause: new Error("CODING_EXECUTOR_LEASE_LOST"),
		});
		expect(errorCode(lease)).toBe("CODING_EXECUTOR_LEASE_LOST");
		const leaky = Object.assign(new Error("aborted"), { name: "AbortError", cause: new Error("secret text") });
		expect(errorCode(leaky)).toBe("AbortError");
	});
	it("keeps a system error's errno code, never its message", () => {
		expect(
			errorCode(Object.assign(new Error("EACCES: permission denied, open '/secret/path'"), { code: "EACCES" })),
		).toBe("ERRNO:EACCES");
		expect(errorCode(Object.assign(new Error("free text"), { code: "not an errno" }))).toBe("UNCLASSIFIED");
	});
});
