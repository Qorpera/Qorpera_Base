import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LxdCodingCommandTransport } from "../src/coding-command-transport.ts";
import { type LxdCodingVmBinding, lxdCodingVmPlan } from "../src/coding-vm.ts";
import type { LxdInspectableClient } from "../src/lxd-client.ts";

function fixture() {
	const vm: LxdCodingVmBinding = {
		schema: "qorpera.lxd-coding-vm/v1",
		workerId: randomUUID(),
		allocationId: randomUUID(),
		companyId: randomUUID(),
		environmentId: randomUUID(),
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
	const plan = lxdCodingVmPlan(vm);
	const scope = { workerId: vm.workerId, vmId: vm.allocationId, requestId: randomUUID(), turn: 1 };
	const bootId = randomUUID();
	const input = {
		commandId: randomUUID(),
		inputSha256: "d".repeat(64),
		command: "printf 'untrusted\n'\nnpm run check",
		timeoutMs: 600000,
	};
	const receipt = {
		schema: "qorpera.coding-command-result/v1",
		workerId: vm.workerId,
		commandId: input.commandId,
		inputSha256: input.inputSha256,
		state: "running",
		exitCode: null,
		output: "untrusted",
		truncated: false,
	};
	const helper = Buffer.from("pinned helper");
	const config = Buffer.from("pinned configuration");
	let request = "";
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
		pushInstanceFile: vi.fn<LxdInspectableClient["pushInstanceFile"]>(async (_project, _name, _path, content) => {
			request = content;
		}),
		execInstance: vi.fn<LxdInspectableClient["execInstance"]>().mockResolvedValue(undefined),
		readInstanceFile: vi.fn<LxdInspectableClient["readInstanceFile"]>(async (_project, _name, path) => ({
			uid: 0,
			gid: 0,
			mode: path.endsWith("status.json") ? 0o400 : 0o444,
			content: path.endsWith("boot_id")
				? Buffer.from(`${bootId}\n`)
				: path.endsWith(".mjs")
					? helper
					: path.endsWith("guest.json")
						? config
						: path.endsWith("status.json")
							? Buffer.from(JSON.stringify(receipt))
							: Buffer.from(request),
		})),
	};
	const authorize = vi
		.fn<ConstructorParameters<typeof LxdCodingCommandTransport>[0]["authorize"]>()
		.mockResolvedValue(undefined);
	const transport = new LxdCodingCommandTransport({
		vm,
		scope,
		bootId,
		helperSha256: createHash("sha256").update(helper).digest("hex"),
		guestConfigSha256: createHash("sha256").update(config).digest("hex"),
		client,
		authorize,
	});
	return {
		vm,
		scope,
		bootId,
		input,
		receipt,
		instance,
		client,
		authorize,
		transport,
		signal: new AbortController().signal,
	};
}
describe("fixed coding guest transport", () => {
	it("stages exact protected input and invokes only the pinned helper argv", async () => {
		const f = fixture();
		expect(await f.transport.start(f.scope, f.input, f.signal)).toEqual(f.receipt);
		expect(f.client.execInstance).toHaveBeenCalledExactlyOnceWith(
			f.vm.project,
			f.instance.name,
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-command-guest.mjs", "start", f.input.commandId],
			f.signal,
		);
		const push = f.client.pushInstanceFile.mock.calls[0];
		expect(push[2]).toBe(`/var/lib/qorpera-coding/inbox/${f.input.commandId}.json`);
		expect(push[4]).toBe(0o444);
		expect(JSON.parse(push[3])).toEqual({ schema: "qorpera.coding-command-request/v1", ...f.scope, ...f.input });
		expect(f.authorize).toHaveBeenCalledWith("start", f.scope, f.input.commandId, f.input.inputSha256, f.signal);
	});
	it("refuses another VM scope before any guest access", async () => {
		const f = fixture();
		await expect(f.transport.start({ ...f.scope, vmId: randomUUID() }, f.input, f.signal)).rejects.toThrow(
			"SCOPE_DIFFERS",
		);
		expect(f.client.getInstance).not.toHaveBeenCalled();
	});
	it("refuses a rebooted guest before command staging", async () => {
		const f = fixture();
		f.client.readInstanceFile.mockResolvedValueOnce({
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: Buffer.from(`${randomUUID()}\n`),
		});
		await expect(f.transport.start(f.scope, f.input, f.signal)).rejects.toThrow("BOOT_CHANGED");
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
	});
	it("rejects inherited host mounts before dispatch", async () => {
		const f = fixture();
		f.instance.expandedDevices = {
			...f.instance.expandedDevices,
			host: { type: "disk", source: "/", path: "/host" },
		};
		await expect(f.transport.start(f.scope, f.input, f.signal)).rejects.toThrow("DRIFTED");
		expect(f.client.execInstance).not.toHaveBeenCalled();
	});
	it("does not retry a lost guest dispatch", async () => {
		const f = fixture();
		f.client.execInstance.mockRejectedValue(new Error("lost"));
		await expect(f.transport.start(f.scope, f.input, f.signal)).rejects.toThrow();
		expect(f.client.execInstance).toHaveBeenCalledTimes(1);
	});
	it("requires current admission even for reads", async () => {
		const f = fixture();
		f.authorize.mockRejectedValue(new Error("revoked"));
		await expect(f.transport.read(f.scope, f.input.commandId, f.signal)).rejects.toThrow("revoked");
		expect(f.client.execInstance).not.toHaveBeenCalled();
	});
	it("reads and cancels through the same fixed helper", async () => {
		const f = fixture();
		await f.transport.read(f.scope, f.input.commandId, f.signal);
		await f.transport.cancel(f.scope, f.input.commandId, f.signal);
		expect(f.client.execInstance.mock.calls.map((call) => call[2][2])).toEqual(["read", "cancel"]);
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
	});
});
