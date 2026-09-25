import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	createOfficeLifecycleReporter,
	createOfficeLifecycleWriter,
	parseLxdOfficeLifecycleServiceConfig,
	runOfficeLifecycleLoops,
} from "../src/lxd-office-lifecycle-service.ts";

const config = () => ({
	schema: "qorpera.lxd-office-provider-service/v1",
	policyPath: "/etc/qorpera-office/policy.json",
	provenancePath: "/etc/qorpera-office/provenance.json",
	planPath: "/etc/qorpera-office/plan.json",
	registryUrl: "https://control.example",
	registryCredential: { path: "/etc/qorpera-office/provider.credential", bytes: 64, sha256: "a".repeat(64) },
	inventoryLimits: { maxEntries: 100, maxDepth: 4, maxFileBytes: 1024, maxTotalBytes: 4096, maxManifestBytes: 65536 },
	pollIntervalMs: 2000,
});

const identity = () => ({
	companyId: "30000000-0000-4000-8000-000000000010",
	environmentId: "30000000-0000-4000-8000-000000000020",
	companyComputerId: "30000000-0000-4000-8000-000000000030",
	logicalComputerId: "30000000-0000-4000-8000-000000000040",
	computerGeneration: 1,
	providerId: "30000000-0000-4000-8000-000000000050",
	providerPolicySha256: "a".repeat(64),
	machineIdSha256: "b".repeat(64),
	guestPackageManifestSha256: "c".repeat(64),
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
describe("optional provider lifecycle diagnostics", () => {
	it("contains real Writable callback and error-event failures", async () => {
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
			},
		});
		const writer = createOfficeLifecycleWriter(stream);
		await expect(writer("diagnostic")).rejects.toThrow("broken pipe");
		await settle();
		expect(stream.destroyed).toBe(true);
		await expect(writer("later diagnostic")).rejects.toThrow();
		await settle();
	});
	it("links typed failures to detached public identity and original observation time", async () => {
		const source = identity(),
			writes: string[] = [];
		const report = createOfficeLifecycleReporter(
			source,
			(value) => {
				writes.push(value);
			},
			() => new Date("2026-09-09T00:00:00.000Z"),
		);
		source.companyId = "changed";
		report({ state: "failed", phase: "creation", intentId: "30000000-0000-4000-8000-000000000060" });
		await settle();
		const first = JSON.parse(writes[0]!);
		expect(first).toMatchObject({
			...identity(),
			state: "failed",
			phase: "creation",
			errorCategory: "PHASE_FAILED",
			observedAt: "2026-09-09T00:00:00.000Z",
			physicalTransitionAt: null,
			resourceReleaseInferred: false,
		});
		report({ state: "failed", phase: "creation", intentId: first.intentId });
		await settle();
		expect(writes).toHaveLength(1);
		report();
		await settle();
		expect(JSON.parse(writes[1]!)).toMatchObject({
			state: "unconfirmed",
			phase: null,
			intentId: null,
			errorCategory: "RECONCILIATION_UNCONFIRMED",
		});
	});
	it("bounds a stalled export to one pending record and recovers after rejection", async () => {
		let reject!: (reason: Error) => void;
		const blocked = new Promise<void>((_resolve, fail) => {
			reject = fail;
		});
		const write = vi.fn<(value: string) => Promise<void>>().mockReturnValueOnce(blocked).mockResolvedValue(undefined);
		const report = createOfficeLifecycleReporter(identity(), write);
		report({ state: "pending", phase: "creation" });
		for (let n = 0; n < 1000; n++) report({ state: "active" });
		expect(write).toHaveBeenCalledTimes(1);
		reject(new Error("PRIVATE sink failure"));
		await settle();
		report({ state: "active" });
		await settle();
		expect(write).toHaveBeenCalledTimes(2);
		expect(write.mock.calls.map(([value]) => value).join()).not.toContain("PRIVATE");
	});
	it("contains synchronous sink and clock failures without suppressing later recovery", async () => {
		const write = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("PRIVATE");
			})
			.mockReturnValue(undefined);
		const report = createOfficeLifecycleReporter(identity(), write);
		expect(() => report({ state: "active" })).not.toThrow();
		report({ state: "active" });
		await settle();
		expect(write).toHaveBeenCalledTimes(2);
		const badClock = createOfficeLifecycleReporter(identity(), write, () => new Date(NaN));
		expect(() => badClock({ state: "active" })).not.toThrow();
		expect(write).toHaveBeenCalledTimes(2);
	});
});
describe("protected lifecycle service configuration", () => {
	it("enables paid control only with a local protected credential reference", () => {
		expect(parseLxdOfficeLifecycleServiceConfig(config()).computerExecutorCredentialPath).toBeUndefined();
		expect(
			parseLxdOfficeLifecycleServiceConfig({
				...config(),
				computerExecutorCredentialPath: "/etc/qorpera/office-computer-executor.key",
			}).computerExecutorCredentialPath,
		).toBe("/etc/qorpera/office-computer-executor.key");
		for (const computerExecutorCredentialPath of ["../key", "", "/", "secret bytes"])
			expect(() => parseLxdOfficeLifecycleServiceConfig({ ...config(), computerExecutorCredentialPath })).toThrow();
	});
	it("enables server idle policy with a bounded configurable grace period", () => {
		expect(parseLxdOfficeLifecycleServiceConfig(config()).idleMs).toBe(300000);
		expect(parseLxdOfficeLifecycleServiceConfig({ ...config(), idleMs: 60000 }).idleMs).toBe(60000);
		for (const idleMs of [0, 59999, 86400001, 300000.5, "300000"])
			expect(() => parseLxdOfficeLifecycleServiceConfig({ ...config(), idleMs })).toThrow();
	});
	it("accepts only a protected code-package lane reference", () => {
		expect(
			parseLxdOfficeLifecycleServiceConfig({ ...config(), codePackageLanePath: "/protected/package.json" })
				.codePackageLanePath,
		).toBe("/protected/package.json");
		expect(() =>
			parseLxdOfficeLifecycleServiceConfig({ ...config(), codePackageLanePath: "../package.json" }),
		).toThrow();
		expect(parseLxdOfficeLifecycleServiceConfig(config()).codePackageLanePath).toBeUndefined();
		expect(parseLxdOfficeLifecycleServiceConfig(config()).passthroughPath).toBeUndefined();
		expect(
			parseLxdOfficeLifecycleServiceConfig({ ...config(), passthroughPath: "/protected/passthrough.json" })
				.passthroughPath,
		).toBe("/protected/passthrough.json");
		expect(() =>
			parseLxdOfficeLifecycleServiceConfig({ ...config(), passthroughPath: "relative/passthrough.json" }),
		).toThrow();
	});
	it("contains only protected references and returns detached configuration", () => {
		const input = config(),
			parsed = parseLxdOfficeLifecycleServiceConfig(input);
		input.registryCredential.path = "/changed";
		expect(parsed.registryCredential.path).toBe("/etc/qorpera-office/provider.credential");
		expect(parsed.pollIntervalMs).toBe(2000);
	});
	it.each([0, 999, 60001, 2000.5, NaN])("rejects unbounded polling %s", (pollIntervalMs) => {
		expect(() => parseLxdOfficeLifecycleServiceConfig({ ...config(), pollIntervalMs })).toThrow();
	});
	it.each(["policyPath", "provenancePath", "planPath"])("rejects unprotected %s references", (path) => {
		expect(() => parseLxdOfficeLifecycleServiceConfig({ ...config(), [path]: "relative/path" })).toThrow();
	});
	it("rejects arbitrary settings, embedded keys, guest registry paths and oversized credential references", () => {
		for (const input of [
			{ ...config(), serviceKey: "secret" },
			{ ...config(), registryUrl: "https://control.example/rest/v1" },
			{ ...config(), registryCredential: { ...config().registryCredential, bytes: 4097 } },
		])
			expect(() => parseLxdOfficeLifecycleServiceConfig(input)).toThrow();
	});
});

it("continues funding maintenance while lifecycle work stalls and contains failed samples", async () => {
	const stop = new AbortController();
	let release!: () => void;
	const slow = new Promise<void>((resolve) => {
		release = resolve;
	});
	const lifecycle = {
		reconcile: vi.fn(async () => {
			await slow;
			return { state: "idle" as const };
		}),
		observeControlOperations: vi.fn(async () => {}),
		observeVmOperations: vi.fn(async () => {}),
	};
	let maintained!: () => void;
	const renewed = new Promise<void>((resolve) => {
		maintained = resolve;
	});
	const paidComputer = {
		maintain: vi
			.fn<(signal: AbortSignal) => Promise<void>>()
			.mockRejectedValueOnce(new Error("private failure"))
			.mockImplementation(async () => {
				maintained();
			}),
	};
	const report = vi.fn();
	const running = runOfficeLifecycleLoops(lifecycle, stop.signal, 60000, report, undefined, paidComputer);
	try {
		await renewed;
		expect(lifecycle.reconcile).toHaveBeenCalledTimes(1);
		expect(paidComputer.maintain).toHaveBeenCalledTimes(2);
		expect(report).toHaveBeenCalledWith(
			undefined,
			expect.objectContaining({ message: "OFFICE_COMPUTER_USAGE_UNCONFIRMED" }),
		);
	} finally {
		stop.abort();
		release();
		await running;
	}
}, 15000);

it("accepts only a local protected reset image package path while preserving old config", () => {
	expect(parseLxdOfficeLifecycleServiceConfig(config()).resetImagePackageManifestPath).toBeUndefined();
	expect(
		parseLxdOfficeLifecycleServiceConfig({
			...config(),
			resetImagePackageManifestPath: "/etc/qorpera-office/original-image-manifest.json",
		}).resetImagePackageManifestPath,
	).toBe("/etc/qorpera-office/original-image-manifest.json");
	expect(() =>
		parseLxdOfficeLifecycleServiceConfig({ ...config(), resetImagePackageManifestPath: "../manifest.json" }),
	).toThrow();
});
