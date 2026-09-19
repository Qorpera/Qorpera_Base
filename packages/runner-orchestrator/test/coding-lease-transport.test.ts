import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LxdCodingLeaseTransport } from "../src/coding-lease-transport.ts";
import { type LxdCodingVmBinding, lxdCodingVmPlan } from "../src/coding-vm.ts";
import type { LxdInspectableClient } from "../src/lxd-client.ts";
import { codingStorageFixture } from "./helpers/coding-storage.ts";

function fixture() {
	const storageScope = { workerId: randomUUID(), companyId: randomUUID(), environmentId: randomUUID() };
	const vm: LxdCodingVmBinding = {
		schema: "qorpera.lxd-coding-vm/v2",
		...storageScope,
		storage: codingStorageFixture(storageScope),
		allocationId: randomUUID(),
		providerId: "coding",
		providerPolicySha256: "a".repeat(64),
		repository: { host: "github.com", owner: "Qorpera", name: "test", baseBranch: "main" },
		project: "coding",
		imageFingerprint: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		storagePool: "coding",
		network: "coding",
		cpus: 2,
		memoryBytes: 2147483648,
		rootDiskBytes: 4294967296,
	};
	const plan = lxdCodingVmPlan(vm);
	const bootId = randomUUID();
	const scope = { workerId: vm.workerId, vmId: vm.allocationId, requestId: randomUUID(), turn: 1 };
	const helper = Buffer.from("reviewed bundled helper");
	const config = Buffer.from("reviewed guest configuration");
	let staged = "";
	const instance = {
		name: plan.request.name,
		type: "virtual-machine" as const,
		status: "Running",
		statusCode: 103,
		profiles: [],
		config: { ...plan.request.config, "volatile.base_image": vm.imageFingerprint },
		expandedConfig: { ...plan.request.config, "volatile.base_image": vm.imageFingerprint },
		devices: plan.request.devices,
		expandedDevices: plan.request.devices,
	};
	const client = {
		getInstance: vi.fn<LxdInspectableClient["getInstance"]>().mockResolvedValue(instance),
		pushInstanceFile: vi.fn<LxdInspectableClient["pushInstanceFile"]>(async (_p, _n, _path, text) => {
			staged = text;
		}),
		execInstance: vi.fn<LxdInspectableClient["execInstance"]>().mockResolvedValue(undefined),
		readInstanceFile: vi.fn<LxdInspectableClient["readInstanceFile"]>(async (_p, _n, path) => ({
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: path.endsWith("uptime")
				? Buffer.from("100.00 50.00\n")
				: path.endsWith("boot_id")
					? Buffer.from(`${bootId}\n`)
					: path.endsWith(".mjs")
						? helper
						: path.endsWith("guest.json")
							? config
							: path.endsWith("lease-refresh.json")
								? Buffer.from(staged)
								: Buffer.from(
										JSON.stringify({
											schema: "qorpera.coding-guest-lease/v1",
											...scope,
											bootId,
											leaseTokenSha256: JSON.parse(staged).leaseTokenSha256,
											refreshedAtMonoMs: 100000,
											expiresAtMonoMs: Math.min(
												100000 + JSON.parse(staged).ttlMs,
												JSON.parse(staged).notAfterMonoMs,
											),
										}),
									),
		})),
	};
	const authorize = vi
		.fn<ConstructorParameters<typeof LxdCodingLeaseTransport>[0]["authorize"]>()
		.mockResolvedValue(undefined);
	const transport = new LxdCodingLeaseTransport({
		vm,
		scope,
		bootId,
		helperSha256: createHash("sha256").update(helper).digest("hex"),
		guestConfigSha256: createHash("sha256").update(config).digest("hex"),
		client,
		authorize,
	});
	return { scope, client, authorize, transport, instance };
}
describe("trusted coding guest lease transport", () => {
	it.each(["", "NaN 0\n", "1e3 0\n", "-1.00 0.00\n", "100.00 50.00", "9007199254740.99 0.00\n"])(
		"refuses invalid uptime %j before lease staging",
		async (content) => {
			const f = fixture(),
				original = f.client.readInstanceFile.getMockImplementation()!;
			f.client.readInstanceFile.mockImplementation(async (...args) => ({
				...(await original(...args)),
				...(args[2] === "/proc/uptime" ? { content: Buffer.from(content) } : {}),
			}));
			await expect(
				f.transport.refresh(f.scope, "d".repeat(64), 60000, new AbortController().signal),
			).rejects.toThrow("CLOCK_UNAVAILABLE");
			expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
			expect(f.client.execInstance).not.toHaveBeenCalled();
		},
	);
	it("pins VM/boot/artifacts, stages only a token hash and invokes the fixed root refresh", async () => {
		const f = fixture();
		await f.transport.refresh(f.scope, "d".repeat(64), 60000, new AbortController().signal);
		expect(f.authorize).toHaveBeenCalledTimes(2);
		expect(f.client.execInstance.mock.calls[0][2]).toEqual([
			"/usr/bin/node",
			"/opt/qorpera-coding/cloud-coding-command-guest.mjs",
			"refresh-lease",
		]);
		const staged = JSON.parse(f.client.pushInstanceFile.mock.calls[0][3]);
		expect(staged.leaseTokenSha256).toBe("d".repeat(64));
		expect(staged.ttlMs).toBeLessThanOrEqual(60000);
		expect(staged.leaseToken).toBeUndefined();
	});
	it("fails before guest mutation for revoked admission, scope drift and excessive TTL", async () => {
		const f = fixture();
		await expect(
			f.transport.refresh({ ...f.scope, turn: 2 }, "d".repeat(64), 60000, new AbortController().signal),
		).rejects.toThrow();
		await expect(f.transport.refresh(f.scope, "d".repeat(64), 60001, new AbortController().signal)).rejects.toThrow();
		f.authorize.mockRejectedValueOnce(new Error("revoked"));
		await expect(f.transport.refresh(f.scope, "d".repeat(64), 60000, new AbortController().signal)).rejects.toThrow(
			"revoked",
		);
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
	});
	it("rejects physical drift and an unprotected staged refresh", async () => {
		const f = fixture();
		f.client.getInstance.mockResolvedValueOnce({ ...f.instance, profiles: ["default"] });
		await expect(f.transport.refresh(f.scope, "d".repeat(64), 60000, new AbortController().signal)).rejects.toThrow(
			"DRIFTED",
		);
		const original = f.client.readInstanceFile.getMockImplementation()!;
		f.client.readInstanceFile.mockImplementation(async (...args) => ({
			...(await original(...args)),
			uid: args[2].endsWith("lease-refresh.json") ? 1000 : 0,
		}));
		await expect(f.transport.refresh(f.scope, "d".repeat(64), 60000, new AbortController().signal)).rejects.toThrow(
			"STAGING_UNCONFIRMED",
		);
		expect(f.client.execInstance).not.toHaveBeenCalled();
	});
});
