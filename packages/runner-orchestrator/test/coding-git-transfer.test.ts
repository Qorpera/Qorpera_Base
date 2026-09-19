import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type CodingGitTransferReceipt, LxdCodingGitTransfer } from "../src/coding-git-transfer.ts";
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
		memoryBytes: 4 * 1024 ** 3,
		rootDiskBytes: 32 * 1024 ** 3,
	};
	const plan = lxdCodingVmPlan(vm),
		bootId = randomUUID(),
		transferId = randomUUID(),
		headSha = "f".repeat(40);
	const helper = Buffer.from("reviewed git helper"),
		config = Buffer.from("bound guest configuration");
	const bundle = Buffer.alloc(32772, 42);
	const files = new Map<string, Buffer>();
	const receipt: CodingGitTransferReceipt = {
		schema: "qorpera.coding-git-receipt/v1",
		workerId: vm.workerId,
		vmId: vm.allocationId,
		transferId,
		action: "seed",
		headSha,
		bundleSha256: createHash("sha256").update(bundle).digest("hex"),
		bundleBytes: bundle.length,
		chunkCount: 2,
	};
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
		pushInstanceFile: vi.fn<LxdInspectableClient["pushInstanceFile"]>(async (_project, _name, path, text) => {
			files.set(path, Buffer.from(text));
		}),
		execInstance: vi.fn<LxdInspectableClient["execInstance"]>(async (_project, _name, args) => {
			if (args[2] === "export") {
				receipt.action = "export";
				files.set(`/var/lib/qorpera-coding/git/${transferId}/000000.bundle`, bundle.subarray(0, 32768));
				files.set(`/var/lib/qorpera-coding/git/${transferId}/000001.bundle`, bundle.subarray(32768));
			}
		}),
		readInstanceFile: vi.fn<LxdInspectableClient["readInstanceFile"]>(async (_project, _name, path, maximum) => {
			if (maximum > 65536) throw new Error("actual LXD public read limit");
			return {
				uid: 0,
				gid: 0,
				mode: 0o444,
				content: path.endsWith("boot_id")
					? Buffer.from(`${bootId}\n`)
					: path.endsWith(".mjs")
						? helper
						: path.endsWith("guest.json")
							? config
							: path.endsWith("receipt.json")
								? Buffer.from(JSON.stringify(receipt))
								: (files.get(path) ?? Buffer.alloc(0)),
			};
		}),
	};
	const authorize = vi.fn().mockResolvedValue(undefined);
	const transfer = new LxdCodingGitTransfer({
		vm,
		scope: { workerId: vm.workerId, vmId: vm.allocationId, requestId: randomUUID(), turn: 1 },
		bootId,
		helperSha256: createHash("sha256").update(helper).digest("hex"),
		guestConfigSha256: createHash("sha256").update(config).digest("hex"),
		client,
		authorize,
	});
	return {
		transfer,
		transferId,
		headSha,
		bundle,
		receipt,
		client,
		files,
		authorize,
		instance,
		signal: new AbortController().signal,
	};
}
describe("protected LXD coding Git byte transfer", () => {
	it("stages bounded root-owned seed chunks and invokes only the fixed helper", async () => {
		const f = fixture();
		expect(await f.transfer.seed(f.transferId, f.headSha, f.bundle, f.signal)).toEqual(f.receipt);
		expect(f.client.execInstance.mock.calls.map((call) => call[2])).toEqual([
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-git-guest.mjs", "prepare", f.transferId],
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-git-guest.mjs", "seed", f.transferId],
		]);
		expect(f.client.pushInstanceFile.mock.calls).toHaveLength(3);
		for (const call of f.client.pushInstanceFile.mock.calls) {
			expect(call[4]).toBe(0o444);
			expect(Buffer.byteLength(call[3])).toBeLessThan(65536);
		}
	});
	it("reads protected export chunks and verifies total length and digest", async () => {
		const f = fixture();
		const result = await f.transfer.export(f.transferId, f.headSha, f.signal);
		expect(result.bundle.equals(f.bundle)).toBe(true);
		expect(result.receipt.action).toBe("export");
	});
	it("refuses changed export bytes", async () => {
		const f = fixture();
		f.receipt.bundleSha256 = "0".repeat(64);
		await expect(f.transfer.export(f.transferId, f.headSha, f.signal)).rejects.toThrow("DIGEST_CHANGED");
	});
	it("refuses transferred result retargeting", async () => {
		const f = fixture();
		f.receipt.vmId = randomUUID();
		await expect(f.transfer.seed(f.transferId, f.headSha, f.bundle, f.signal)).rejects.toThrow("RECEIPT_CHANGED");
	});
	it("rejects VM drift and authority revocation before any write", async () => {
		const f = fixture();
		f.instance.expandedDevices = {};
		await expect(f.transfer.seed(f.transferId, f.headSha, f.bundle, f.signal)).rejects.toThrow("DRIFTED");
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
		const g = fixture();
		g.authorize.mockRejectedValue(new Error("revoked"));
		await expect(g.transfer.export(g.transferId, g.headSha, g.signal)).rejects.toThrow("revoked");
		expect(g.client.pushInstanceFile).not.toHaveBeenCalled();
	});
	it("rejects an unprotected boot/artifact before invoking a helper", async () => {
		const f = fixture();
		f.client.readInstanceFile.mockResolvedValueOnce({
			uid: 1000,
			gid: 1000,
			mode: 0o444,
			content: Buffer.from("forged"),
		});
		await expect(f.transfer.export(f.transferId, f.headSha, f.signal)).rejects.toThrow("BOOT_CHANGED");
		expect(f.client.execInstance).not.toHaveBeenCalled();
	});
});
