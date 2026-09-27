import { createHash, randomUUID } from "node:crypto";
import { parseCloudCodingCommandRead } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import { LxdCodingCommandTransport } from "../src/coding-command-transport.ts";
import type { LxdInspectableClient } from "../src/lxd-client.ts";
import { codingMachineFixture, codingMachineInstance, codingMachineStorage } from "./helpers/coding-machine.ts";

function fixture() {
	const workerId = randomUUID();
	const machine = codingMachineFixture();
	const scope = { workerId, vmId: machine.machineId, requestId: randomUUID(), turn: 1 };
	const bootId = randomUUID();
	const input = {
		commandId: randomUUID(),
		inputSha256: "d".repeat(64),
		command: "printf 'untrusted\n'\nnpm run check",
		timeoutMs: 600000,
	};
	const receipt = {
		schema: "qorpera.coding-command-result/v2",
		workerId,
		commandId: input.commandId,
		inputSha256: input.inputSha256,
		state: "running",
		exitCode: null,
		output: "untrusted",
		truncated: false,
		log: { offset: 0, nextOffset: 9, totalBytes: 9, limitBytes: 67108864, limitReached: false },
	};
	const helper = Buffer.from("pinned helper");
	const config = Buffer.from("pinned configuration");
	let request = "";
	let readQuery: unknown;
	const instance = codingMachineInstance(machine, [workerId, randomUUID()]);
	const client = {
		getInstance: vi.fn<LxdInspectableClient["getInstance"]>().mockResolvedValue(instance),
		pushInstanceFile: vi.fn<LxdInspectableClient["pushInstanceFile"]>(async (_project, _name, _path, content) => {
			request = content;
		}),
		execInstance: vi.fn<LxdInspectableClient["execInstance"]>(async (_project, _name, args) => {
			if (args[2] === "read")
				readQuery = parseCloudCodingCommandRead({
					commandId: args[4],
					...(args[5] === "tail" ? { tail: true } : { offset: Number(args[5]) }),
					limit: Number(args[6]),
				});
		}),
		readInstanceFile: vi.fn<LxdInspectableClient["readInstanceFile"]>(async (_project, _name, path, maximum) => {
			if (maximum > 65536) throw new Error("LXD_FILE_LIMIT_INVALID");
			return {
				uid: 0,
				gid: 0,
				mode: path.endsWith("status.json") || /read-page-[0-9]+\.json$/.test(path) ? 0o400 : 0o444,
				content: path.endsWith("boot_id")
					? Buffer.from(`${bootId}\n`)
					: path.endsWith(".mjs")
						? helper
						: path.endsWith("guest.json")
							? config
							: path.endsWith("status.json") || /read-page-[0-9]+\.json$/.test(path)
								? Buffer.from(
										JSON.stringify(
											path.endsWith("status.json")
												? receipt
												: { schema: "qorpera.coding-command-page/v1", query: readQuery, receipt },
										),
									)
								: Buffer.from(request),
			};
		}),
	};
	const authorize = vi
		.fn<ConstructorParameters<typeof LxdCodingCommandTransport>[0]["authorize"]>()
		.mockResolvedValue(undefined);
	const transport = new LxdCodingCommandTransport({
		machine,
		storage: codingMachineStorage,
		scope,
		bootId,
		helperSha256: createHash("sha256").update(helper).digest("hex"),
		guestConfigSha256: createHash("sha256").update(config).digest("hex"),
		client,
		authorize,
	});
	return {
		machine,
		workerId,
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
			f.machine.project,
			f.instance.name,
			[
				"/usr/bin/node",
				"/opt/qorpera-coding/cloud-coding-command-guest.mjs",
				"start",
				f.workerId,
				f.input.commandId,
			],
			f.signal,
		);
		const push = f.client.pushInstanceFile.mock.calls[0];
		expect(push[2]).toBe(`/var/lib/qorpera-coding/${f.workerId}/inbox/${f.input.commandId}.json`);
		// The session's own configuration, on its member's machine.
		expect(f.client.readInstanceFile.mock.calls.map((call) => call[2])).toContain(
			`/run/qorpera-coding/${f.workerId}/configuration/guest.json`,
		);
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
	it("refuses a session whose folders are not attached to the machine", async () => {
		const f = fixture();
		f.client.getInstance.mockResolvedValue(codingMachineInstance(f.machine, [randomUUID()]));
		await expect(f.transport.start(f.scope, f.input, f.signal)).rejects.toThrow("CODING_SESSION_DETACHED");
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
		f.client.getInstance.mockResolvedValue({ ...f.instance, status: "Stopped", statusCode: 102 });
		await expect(f.transport.start(f.scope, f.input, f.signal)).rejects.toThrow("CODING_MACHINE_NOT_RUNNING");
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
		await expect(f.transport.read(f.scope, { commandId: f.input.commandId }, f.signal)).rejects.toThrow("revoked");
		expect(f.client.execInstance).not.toHaveBeenCalled();
	});
	it("reads and cancels through the same fixed helper", async () => {
		const f = fixture();
		await f.transport.read(f.scope, { commandId: f.input.commandId }, f.signal);
		await f.transport.cancel(f.scope, f.input.commandId, f.signal);
		expect(f.client.execInstance.mock.calls.map((call) => call[2][2])).toEqual(["read", "cancel"]);
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
	});
	it("uses separate protected page paths and bounded numeric arguments", async () => {
		const f = fixture();
		f.receipt.output = "rust";
		f.receipt.truncated = true;
		f.receipt.log = { offset: 3, nextOffset: 7, totalBytes: 9, limitBytes: 67108864, limitReached: false };
		await f.transport.read(f.scope, { commandId: f.input.commandId, offset: 3, limit: 4 }, f.signal);
		expect(f.client.execInstance.mock.calls[0][2]).toEqual([
			"/usr/bin/node",
			"/opt/qorpera-coding/cloud-coding-command-guest.mjs",
			"read",
			f.workerId,
			f.input.commandId,
			"3",
			"4",
		]);
		expect(f.client.readInstanceFile.mock.calls.some((call) => /read-page-[0-9]+\.json$/.test(call[2]))).toBe(true);
		f.client.execInstance.mockClear();
		await expect(f.transport.read(f.scope, { commandId: f.input.commandId, offset: -1 }, f.signal)).rejects.toThrow();
		expect(f.client.execInstance).not.toHaveBeenCalled();
	});
	it("refuses a ring slot overwritten by a concurrent different query", async () => {
		const f = fixture(),
			read = f.client.readInstanceFile.getMockImplementation()!;
		f.client.readInstanceFile.mockImplementation(async (...args) => {
			const file = await read(...args);
			if (/read-page-[0-9]+\.json$/.test(args[2])) {
				const value = JSON.parse(file.content.toString());
				value.query.offset = 99;
				return { ...file, content: Buffer.from(JSON.stringify(value)) };
			}
			return file;
		});
		await expect(f.transport.read(f.scope, { commandId: f.input.commandId }, f.signal)).rejects.toThrow(
			"PAGE_REPLACED",
		);
	});
});
