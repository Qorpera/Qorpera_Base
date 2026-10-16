import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type CodingGitTransferReceipt, LxdCodingGitTransfer } from "../src/coding-git-transfer.ts";
import type { LxdInspectableClient } from "../src/lxd-client.ts";
import { codingMachineFixture, codingMachineInstance, codingMachineStorage } from "./helpers/coding-machine.ts";

function fixture() {
	const workerId = randomUUID();
	const machine = codingMachineFixture();
	const repository = { host: "github.com" as const, owner: "Qorpera", name: "test", baseBranch: "main" };
	const bootId = randomUUID(),
		transferId = randomUUID(),
		headSha = "f".repeat(40);
	const helper = Buffer.from("reviewed git helper"),
		config = Buffer.from("bound guest configuration");
	// Two seed chunks (192 KiB and 4 bytes), seven 32 KiB export chunks.
	const bundle = Buffer.alloc(196612, 42);
	const files = new Map<string, Buffer>();
	const receipt: CodingGitTransferReceipt = {
		schema: "qorpera.coding-git-receipt/v1",
		workerId,
		vmId: machine.machineId,
		transferId,
		action: "seed",
		headSha,
		bundleSha256: createHash("sha256").update(bundle).digest("hex"),
		bundleBytes: bundle.length,
		chunkCount: 2,
	};
	const instance = codingMachineInstance(machine, [workerId]);
	const client = {
		getInstance: vi.fn<LxdInspectableClient["getInstance"]>().mockResolvedValue(instance),
		pushInstanceFile: vi.fn<LxdInspectableClient["pushInstanceFile"]>(async (_project, _name, path, text) => {
			files.set(path, Buffer.from(text));
		}),
		execInstance: vi.fn<LxdInspectableClient["execInstance"]>(async (_project, _name, args) => {
			if (args[2] === "export") {
				receipt.action = "export";
				receipt.chunkCount = 7;
				for (let index = 0; index < 7; index++)
					files.set(
						`/var/lib/qorpera-coding/${workerId}/git/${transferId}/${String(index).padStart(6, "0")}.bundle`,
						bundle.subarray(index * 32768, (index + 1) * 32768),
					);
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
		machine,
		storage: codingMachineStorage,
		repository,
		scope: { workerId, vmId: machine.machineId, requestId: randomUUID(), turn: 1 },
		bootId,
		helperSha256: createHash("sha256").update(helper).digest("hex"),
		guestConfigSha256: createHash("sha256").update(config).digest("hex"),
		client,
		authorize,
	});
	return {
		workerId,
		repository,
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
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-git-guest.mjs", "prepare", f.workerId, f.transferId],
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-git-guest.mjs", "seed", f.workerId, f.transferId],
		]);
		const staged = f.client.pushInstanceFile.mock.calls.map((call) => call[2]);
		expect(staged[0]).toBe(`/var/lib/qorpera-coding/${f.workerId}/inbox/${f.transferId}.git.json`);
		expect(JSON.parse(f.client.pushInstanceFile.mock.calls[0][3])).toMatchObject({
			workerId: f.workerId,
			repository: f.repository,
		});
		expect(f.client.pushInstanceFile.mock.calls).toHaveLength(3);
		for (const call of f.client.pushInstanceFile.mock.calls) {
			expect(call[4]).toBe(0o444);
			expect(Buffer.byteLength(call[3])).toBeLessThanOrEqual(262144);
		}
		// Seed chunks are as large as an LXD file push and are never read back;
		// the guest checks each one and the whole digest.
		const chunks = f.client.pushInstanceFile.mock.calls.slice(1);
		expect(chunks.map((call) => call[2])).toEqual([
			`/var/lib/qorpera-coding/${f.workerId}/git/${f.transferId}/000000.base64`,
			`/var/lib/qorpera-coding/${f.workerId}/git/${f.transferId}/000001.base64`,
		]);
		expect(chunks.map((call) => call[3].length)).toEqual([262144, 8]);
		expect(Buffer.concat(chunks.map((call) => Buffer.from(call[3], "base64"))).equals(f.bundle)).toBe(true);
		expect(f.client.readInstanceFile.mock.calls.some((call) => call[2].endsWith(".base64"))).toBe(false);
		// The guest imports the whole seed in one command: it may take 600 s.
		expect(f.client.execInstance.mock.calls.map((call) => call[4])).toEqual([undefined, 600]);
	});
	it("refuses a seed receipt that counts the chunks of another size", async () => {
		const f = fixture();
		f.receipt.chunkCount = 7;
		await expect(f.transfer.seed(f.transferId, f.headSha, f.bundle, f.signal)).rejects.toThrow("RECEIPT_CHANGED");
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
		f.instance.expandedDevices = {
			...f.instance.expandedDevices,
			host: { type: "disk", source: "/", path: "/host" },
		};
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
