import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { FileHandle } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { spawnCompanyComputerLinuxProcess } from "@qorpera/runtime/cloud-company-computer-linux-process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function fixture() {
	const child = new EventEmitter() as ChildProcess;
	const permission = new PassThrough();
	const ready = new PassThrough();
	const sent: Buffer[] = [];
	permission.on("data", (bytes: Buffer) => sent.push(bytes));
	Object.assign(child, { stdio: [null, null, null, permission, ready], kill: vi.fn() });
	vi.mocked(spawn).mockReturnValueOnce(child);
	const launched = spawnCompanyComputerLinuxProcess({
		args: [],
		command: ["/usr/bin/true"],
		files: [],
		stdin: "ignore",
	});
	return { ...launched, permission, ready, sent: () => Buffer.concat(sent).toString() };
}

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("Linux namespace startup cancellation", () => {
	it("keeps browser control pipes distinct from directory descriptors and execution permission", async () => {
		const child = new EventEmitter() as ChildProcess;
		const cdpInput = new PassThrough();
		const cdpOutput = new PassThrough();
		const permission = new PassThrough();
		const ready = new PassThrough();
		let sent = "";
		permission.on("data", (bytes: Buffer) => {
			sent += bytes.toString();
		});
		Object.assign(child, {
			stdio: [null, null, null, cdpInput, cdpOutput, null, null, permission, ready],
			kill: vi.fn(),
		});
		vi.mocked(spawn).mockReturnValueOnce(child);
		const launched = spawnCompanyComputerLinuxProcess({
			args: [],
			command: ["/usr/bin/true"],
			files: [{ fd: 51 }, { fd: 52 }] as FileHandle[],
			stdin: "ignore",
			pipeCount: 2,
		});
		expect(vi.mocked(spawn).mock.calls[0][2]?.stdio).toEqual([
			"ignore",
			"pipe",
			"pipe",
			"pipe",
			"pipe",
			51,
			52,
			"pipe",
			"pipe",
		]);
		cdpOutput.write("ready\n");
		expect(sent).toBe("");
		ready.write("ready\n");
		await launched.started;
		expect(sent).toBe("start\n");
		launched.stop();
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		child.emit("close", null, "SIGKILL");
		cdpInput.destroy();
		cdpOutput.destroy();
	});
	it("closes permission without killing the unarmed monitor, then kills when a late gate confirms readiness", async () => {
		const f = fixture();
		f.stop();
		expect(f.permission.writableEnded).toBe(true);
		expect(f.child.kill).not.toHaveBeenCalled();
		expect(f.sent()).toBe("");
		f.ready.write("ready\n");
		await expect(f.started).rejects.toThrow("OFFICE_PROCESS_GATE_CANCELLED");
		expect(f.sent()).toBe("");
		expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
		f.child.emit("close", null, "SIGKILL");
	});
	it("waits for a complete readiness frame before granting execution and enabling monitor kill", async () => {
		const f = fixture();
		f.ready.write("rea");
		expect(f.sent()).toBe("");
		f.ready.write("dy\n");
		await f.started;
		expect(f.sent()).toBe("start\n");
		f.stop();
		expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
		f.child.emit("close", null, "SIGKILL");
	});
	it("treats a stalled pre-exec setup as unknown without signalling an unarmed monitor", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const failed = expect(f.started).rejects.toThrow("OFFICE_PROCESS_GATE_TIMEOUT");
		await vi.advanceTimersByTimeAsync(5000);
		await failed;
		expect(f.permission.writableEnded).toBe(true);
		expect(f.child.kill).not.toHaveBeenCalled();
		expect(f.sent()).toBe("");
		f.ready.write("ready\n");
		expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(f.sent()).toBe("");
		f.child.emit("close", null, "SIGKILL");
	});
	it.each(["wrong\n", "ready\nextra"])(
		"refuses malformed readiness %j without execution permission",
		async (frame) => {
			const f = fixture();
			f.ready.write(frame);
			await expect(f.started).rejects.toThrow("OFFICE_PROCESS_GATE_FAILED");
			expect(f.sent()).toBe("");
			expect(f.child.kill).not.toHaveBeenCalled();
			f.child.emit("close", 125, null);
		},
	);
	it("rejects a setup failure and ignores subsequent stop after confirmed exit", async () => {
		const f = fixture();
		f.child.emit("close", 1, null);
		await expect(f.started).rejects.toThrow("OFFICE_PROCESS_EXITED_BEFORE_START");
		f.stop();
		expect(f.child.kill).not.toHaveBeenCalled();
	});
});
