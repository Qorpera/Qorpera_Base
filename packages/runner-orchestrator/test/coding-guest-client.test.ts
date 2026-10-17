import { randomUUID } from "node:crypto";
import { CODING_GUEST } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import { CodingGuestRefused, LxdCodingGuestClient } from "../src/coding-guest-client.ts";
import { lxdCodingMachineName } from "../src/coding-machine.ts";
import type { LxdInstanceExecStreamClient } from "../src/lxd-client.ts";
import { codingMachineFixture } from "./helpers/coding-machine.ts";

const PASS = "pass-that-must-never-be-quoted";
const SECRET = "secret-that-must-never-be-quoted";

function line(value: unknown, bytes: Buffer = Buffer.alloc(0)): Buffer {
	return Buffer.concat([Buffer.from(`${JSON.stringify(value)}\n`), bytes]);
}
function fixture() {
	const machine = codingMachineFixture();
	// Each test sets the agent's answers; a call it did not expect gets an empty stdout.
	const execInstanceStream = vi.fn<LxdInstanceExecStreamClient["execInstanceStream"]>(async () => ({
		exitCode: 0,
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
	}));
	// Like the LXD client, the exec fails when stdout goes past its bound.
	const bounded: LxdInstanceExecStreamClient["execInstanceStream"] = async (project, name, request, signal) => {
		const result = await execInstanceStream(project, name, request, signal);
		if (result.stdout.byteLength > request.maxStdoutBytes)
			throw new Error("LXD exec stream output exceeded its bound");
		return result;
	};
	const guest = new LxdCodingGuestClient({ machine, client: { execInstanceStream: bounded } });
	const workerId = randomUUID();
	const commandId = randomUUID();
	const view = { environmentId: randomUUID(), viewId: randomUUID(), pass: PASS };
	return {
		machine,
		guest,
		execInstanceStream,
		workerId,
		commandId,
		mount: { schema: "qorpera.coding-guest-mount/v1", workerId, uid: 200001, gid: 200001, view } as const,
		run: {
			schema: "qorpera.coding-guest-run/v1",
			workerId,
			commandId,
			uid: 200001,
			gid: 200001,
			command: "npm test",
			cwd: "/company/repository",
			environment: { HOME: "/home/session", TOKEN: SECRET },
			timeoutMs: null,
		} as const,
		output: {
			schema: "qorpera.coding-guest-output/v1",
			workerId,
			commandId,
			offset: 10,
			maxBytes: 4096,
			waitMs: 5000,
		} as const,
		session: { schema: "qorpera.coding-guest-session/v1", workerId } as const,
		command: { commandId, state: "running", exit: null, end: 16 } as const,
	};
}
async function rejection(work: Promise<unknown>): Promise<Error> {
	const error = await work.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(Error);
	expect(String((error as Error).message)).not.toContain(PASS);
	expect(String((error as Error).message)).not.toContain(SECRET);
	return error as Error;
}

describe("LxdCodingGuestClient", () => {
	it("runs one verb as one exec of the agent, with its request on stdin, and reads its answer", async () => {
		const at = fixture();
		const answer = {
			schema: "qorpera.coding-guest-mounted/v1",
			workerId: at.workerId,
			viewId: at.mount.view.viewId,
			mount: "mounted",
		};
		at.execInstanceStream.mockImplementationOnce(async () => ({
			exitCode: 0,
			stdout: line(answer),
			stderr: Buffer.from("a warning on stderr is never read"),
		}));
		const signal = new AbortController().signal;
		await expect(at.guest.mount(at.mount, signal)).resolves.toEqual(answer);
		expect(at.execInstanceStream).toHaveBeenCalledOnce();
		const [project, name, request, passed] = at.execInstanceStream.mock.calls[0]!;
		expect([project, name]).toEqual([at.machine.project, lxdCodingMachineName(at.machine.machineId)]);
		expect(passed).toBe(signal);
		expect(request.command).toEqual(["/usr/bin/node", "/opt/qorpera-guest/agent.mjs", "mount"]);
		expect(JSON.parse(request.stdin.toString("utf8"))).toEqual(at.mount);
		expect(request).toMatchObject({ maxStdoutBytes: 131072, maxStderrBytes: 16384, timeoutMs: 120000 });
	});

	it("answers each verb against its own request", async () => {
		const at = fixture();
		const signal = new AbortController().signal;
		const command = { schema: "qorpera.coding-guest-command/v1", workerId: at.workerId, ...at.command };
		at.execInstanceStream.mockResolvedValueOnce({ exitCode: 0, stdout: line(command), stderr: Buffer.alloc(0) });
		await expect(at.guest.run(at.run, signal)).resolves.toEqual(command);
		expect(JSON.parse(at.execInstanceStream.mock.calls[0]![2].stdin.toString("utf8"))).toEqual(at.run);
		const cancelled = { ...command, state: "cancelled", exit: { code: null, signal: "SIGTERM" } };
		at.execInstanceStream.mockResolvedValueOnce({ exitCode: 0, stdout: line(cancelled), stderr: Buffer.alloc(0) });
		await expect(
			at.guest.cancel(
				{ schema: "qorpera.coding-guest-cancel/v1", workerId: at.workerId, commandId: at.commandId },
				signal,
			),
		).resolves.toEqual(cancelled);
		const status = {
			schema: "qorpera.coding-guest-status/v2",
			workerId: at.workerId,
			commands: [at.command],
			usage: { bootId: at.commandId, uptimeMs: 60000, cpuUsageUsec: 1500000, ioBytes: 4096, ioComplete: true },
		};
		at.execInstanceStream.mockResolvedValueOnce({ exitCode: 0, stdout: line(status), stderr: Buffer.alloc(0) });
		await expect(at.guest.status(at.session, signal)).resolves.toEqual(status);
		const quiesced = { schema: "qorpera.coding-guest-session-quiesced/v1", workerId: at.workerId };
		at.execInstanceStream.mockResolvedValueOnce({ exitCode: 0, stdout: line(quiesced), stderr: Buffer.alloc(0) });
		await expect(at.guest.quiesce(at.session, signal)).resolves.toEqual(quiesced);
		const stopped = { schema: "qorpera.coding-guest-session-stopped/v1", workerId: at.workerId };
		at.execInstanceStream.mockResolvedValueOnce({ exitCode: 0, stdout: line(stopped), stderr: Buffer.alloc(0) });
		await expect(at.guest.stopSession(at.session, signal)).resolves.toEqual(stopped);
		expect(at.execInstanceStream.mock.calls.map(([, , request]) => [request.command[2], request.timeoutMs])).toEqual([
			["run", 120000],
			["cancel", 60000],
			["status", 60000],
			["quiesce", 120000],
			["stop-session", 120000],
		]);
	});

	it("reads an output page's exact bytes after its line, bounded by the page and the wait", async () => {
		const at = fixture();
		const page = Buffer.from([0x00, 0xff, 0x0a, 0x41]);
		const answer = {
			schema: "qorpera.coding-guest-output/v1",
			workerId: at.workerId,
			...at.command,
			offset: 12,
			bytes: page.byteLength,
			gap: 2,
		};
		at.execInstanceStream.mockResolvedValue({ exitCode: 0, stdout: line(answer, page), stderr: Buffer.alloc(0) });
		const read = await at.guest.output(at.output, new AbortController().signal);
		expect(read.answer).toEqual(answer);
		expect(read.bytes.equals(page)).toBe(true);
		expect(at.execInstanceStream.mock.calls[0]![2]).toMatchObject({
			command: ["/usr/bin/node", "/opt/qorpera-guest/agent.mjs", "output"],
			maxStdoutBytes: 131072 + 4096,
			timeoutMs: 30000 + 5000,
		});
		for (const stdout of [
			line(answer, page.subarray(1)),
			line(answer, Buffer.concat([page, Buffer.from("x")])),
			line({ ...answer, offset: 11 }, page),
			line({ ...answer, bytes: 4097 }, Buffer.alloc(4097)),
		]) {
			at.execInstanceStream.mockResolvedValueOnce({ exitCode: 0, stdout, stderr: Buffer.alloc(0) });
			expect((await rejection(at.guest.output(at.output, new AbortController().signal))).message).toBe(
				"CODING_GUEST_ANSWER_INVALID",
			);
		}
	});

	it("rejects a refusal with its code, and a refusal that is not exactly one as an invalid answer", async () => {
		const at = fixture();
		const refusal = { schema: "qorpera.coding-guest-refusal/v1", code: "CODING_GUEST_SESSION_BUSY" };
		at.execInstanceStream.mockResolvedValueOnce({ exitCode: 0, stdout: line(refusal), stderr: Buffer.alloc(0) });
		const refused = await rejection(at.guest.run(at.run, new AbortController().signal));
		expect(refused).toBeInstanceOf(CodingGuestRefused);
		expect((refused as CodingGuestRefused).code).toBe("CODING_GUEST_SESSION_BUSY");
		expect(refused.message).toBe("CODING_GUEST_REFUSED:CODING_GUEST_SESSION_BUSY");
		for (const stdout of [
			line(refusal, Buffer.from("x")),
			line({ ...refusal, code: "not a code" }),
			line({ ...refusal, workerId: at.workerId }),
		]) {
			at.execInstanceStream.mockResolvedValueOnce({ exitCode: 0, stdout, stderr: Buffer.alloc(0) });
			const error = await rejection(at.guest.output(at.output, new AbortController().signal));
			expect(error).not.toBeInstanceOf(CodingGuestRefused);
			expect(error.message).toBe("CODING_GUEST_ANSWER_INVALID");
		}
	});

	it("fails a call whose agent did not exit 0, whatever it printed", async () => {
		const at = fixture();
		const answer = { schema: "qorpera.coding-guest-session-stopped/v1", workerId: at.workerId };
		for (const exitCode of [1, 137, -1]) {
			at.execInstanceStream.mockResolvedValueOnce({
				exitCode,
				stdout: line(answer),
				stderr: Buffer.from("CODING_GUEST_REFUSED\n"),
			});
			expect((await rejection(at.guest.stopSession(at.session, new AbortController().signal))).message).toBe(
				"CODING_GUEST_FAILED",
			);
		}
	});

	it("refuses an answer that is not one line answering this request", async () => {
		const at = fixture();
		const mounted = {
			schema: "qorpera.coding-guest-mounted/v1",
			workerId: at.workerId,
			viewId: at.mount.view.viewId,
			mount: "mounted",
		};
		const text = JSON.stringify(mounted);
		for (const stdout of [
			Buffer.alloc(0),
			Buffer.from(text),
			Buffer.from(`${text}\n\n`),
			Buffer.from(`${text}\n${text}\n`),
			Buffer.from(`﻿${text}\n`),
			Buffer.concat([Buffer.from(text.slice(0, -1)), Buffer.from([0xc3, 0x28]), Buffer.from("}\n")]),
			line({ ...mounted, workerId: randomUUID() }),
			line({ ...mounted, viewId: randomUUID() }),
			line({ ...mounted, mount: "maybe" }),
			line({ ...mounted, extra: true }),
			line({ schema: "qorpera.coding-guest-session-stopped/v1", workerId: at.workerId }),
			line([mounted]),
			line(null),
		]) {
			at.execInstanceStream.mockResolvedValueOnce({ exitCode: 0, stdout, stderr: Buffer.alloc(0) });
			expect((await rejection(at.guest.mount(at.mount, new AbortController().signal))).message).toBe(
				"CODING_GUEST_ANSWER_INVALID",
			);
		}
		// The bound is the whole line, its newline included: a line of exactly 131072 bytes is read, and one byte more is
		// refused, by the exec's own bound as by the line's.
		const atBound = Buffer.from(`${" ".repeat(131071 - text.length)}${text}\n`);
		expect(atBound.byteLength).toBe(131072);
		at.execInstanceStream.mockResolvedValueOnce({ exitCode: 0, stdout: atBound, stderr: Buffer.alloc(0) });
		await expect(at.guest.mount(at.mount, new AbortController().signal)).resolves.toEqual(mounted);
		at.execInstanceStream.mockResolvedValueOnce({
			exitCode: 0,
			stdout: Buffer.from(` ${atBound.toString("utf8")}`),
			stderr: Buffer.alloc(0),
		});
		expect((await rejection(at.guest.mount(at.mount, new AbortController().signal))).message).toBe(
			"LXD exec stream output exceeded its bound",
		);
	});
	it("refuses an output line over its bound even when its page leaves room for it", async () => {
		const at = fixture();
		const answer = {
			schema: "qorpera.coding-guest-output/v1",
			workerId: at.workerId,
			...at.command,
			offset: 10,
			bytes: 0,
			gap: 0,
		};
		const text = JSON.stringify(answer);
		// 131073 bytes with the newline: within the exec's bound of the line plus the page, past the line's own.
		at.execInstanceStream.mockResolvedValueOnce({
			exitCode: 0,
			stdout: Buffer.from(`${" ".repeat(131072 - text.length)}${text}\n`),
			stderr: Buffer.alloc(0),
		});
		expect((await rejection(at.guest.output(at.output, new AbortController().signal))).message).toBe(
			"CODING_GUEST_ANSWER_INVALID",
		);
	});

	it("refuses an invalid or oversized request before any exec, without quoting it", async () => {
		const at = fixture();
		const signal = new AbortController().signal;
		for (const request of [
			{ ...at.mount, uid: 1000 },
			{ ...at.mount, view: { ...at.mount.view, pass: `${PASS} with a space` } },
			{ ...at.mount, extra: PASS },
		])
			expect((await rejection(at.guest.mount(request as never, signal))).message).toBe(
				"CODING_GUEST_REQUEST_INVALID",
			);
		expect((await rejection(at.guest.run({ ...at.run, cwd: "relative" }, signal))).message).toBe(
			"CODING_GUEST_REQUEST_INVALID",
		);
		expect((await rejection(at.guest.output({ ...at.output, waitMs: 20001 }, signal))).message).toBe(
			"CODING_GUEST_REQUEST_INVALID",
		);
		// Each value is within the contract's bound, but the request is over the agent's 64 KiB of stdin.
		const environment = Object.fromEntries(
			Array.from({ length: 3 }, (_, index) => [`SECRET_${index}`, `${SECRET}${"x".repeat(30000)}`]),
		);
		expect(Buffer.byteLength(JSON.stringify({ ...at.run, environment }))).toBeGreaterThan(CODING_GUEST.maxInputBytes);
		expect((await rejection(at.guest.run({ ...at.run, environment }, signal))).message).toBe(
			"CODING_GUEST_REQUEST_INVALID",
		);
		expect(at.execInstanceStream).not.toHaveBeenCalled();
	});

	it("passes the exec's own failure and the caller's stop through", async () => {
		const at = fixture();
		at.execInstanceStream.mockRejectedValueOnce(new Error("LXD exec stream was stopped"));
		const controller = new AbortController();
		controller.abort();
		expect((await rejection(at.guest.status(at.session, controller.signal))).message).toBe(
			"LXD exec stream was stopped",
		);
		expect(at.execInstanceStream.mock.calls[0]![3]).toBe(controller.signal);
	});
});
