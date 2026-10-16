import { describe, expect, it } from "vitest";
import {
	CODING_GUEST,
	CODING_GUEST_VERBS,
	type CodingGuestOutputRequest,
	type CodingGuestRunRequest,
	parseCodingGuestAnswer,
	parseCodingGuestRefusal,
	parseCodingGuestRequest,
} from "../src/cloud-coding-guest.ts";

const workerId = "12345678-1234-4234-8234-000000000001";
const commandId = "12345678-1234-4234-8234-0000000000c1";
const run = {
	schema: "qorpera.coding-guest-run/v1",
	workerId,
	commandId,
	uid: 200001,
	gid: 200001,
	command: "npm test",
	cwd: "/company/Code/app",
	environment: { HOME: "/home/qorpera", TOKEN: "secret-token-value" },
	timeoutMs: 60000,
};
const mount = {
	schema: "qorpera.coding-guest-mount/v1",
	workerId,
	uid: 200001,
	gid: 200001,
	view: { environmentId: "environment-1", viewId: "view-1", pass: "secret-pass-value" },
};
const output = {
	schema: "qorpera.coding-guest-output/v1",
	workerId,
	commandId,
	offset: 100,
	maxBytes: 4096,
	waitMs: 1000,
};

describe("coding guest requests", () => {
	it("parses each verb's request, closed and frozen", () => {
		expect(parseCodingGuestRequest("run", run)).toEqual(run);
		expect(Object.isFrozen(parseCodingGuestRequest("run", run).environment)).toBe(true);
		expect(parseCodingGuestRequest("mount", mount)).toEqual(mount);
		expect(Object.isFrozen(parseCodingGuestRequest("mount", mount).view)).toBe(true);
		expect(parseCodingGuestRequest("output", output)).toEqual(output);
		const cancel = { schema: "qorpera.coding-guest-cancel/v1", workerId, commandId };
		expect(parseCodingGuestRequest("cancel", cancel)).toEqual(cancel);
		const session = { schema: "qorpera.coding-guest-session/v1", workerId };
		expect(parseCodingGuestRequest("stop-session", session)).toEqual(session);
		expect(Object.isFrozen(parseCodingGuestRequest("status", session))).toBe(true);
		expect(parseCodingGuestRequest("run", { ...run, timeoutMs: null }).timeoutMs).toBeNull();
		expect(CODING_GUEST_VERBS).toEqual(["mount", "run", "output", "cancel", "stop-session", "status"]);
	});
	it.each<[string, (typeof CODING_GUEST_VERBS)[number], unknown]>([
		["an unknown verb", "exec" as never, run],
		["another verb's schema", "cancel", { schema: "qorpera.coding-guest-session/v1", workerId, commandId }],
		["an extra key", "run", { ...run, user: "root" }],
		["a missing key", "run", Object.fromEntries(Object.entries(run).filter(([key]) => key !== "timeoutMs"))],
		["an upper-case worker id", "run", { ...run, workerId: "ABCDEF12-1234-4234-8234-000000000001" }],
		["a root uid", "run", { ...run, uid: 0 }],
		["a uid above the session range", "mount", { ...mount, gid: CODING_GUEST.maxUid + 1 }],
		["a blank command", "run", { ...run, command: " \n" }],
		["a command over 16 KiB", "run", { ...run, command: "x".repeat(16385) }],
		["a command with a NUL", "run", { ...run, command: "a\0b" }],
		["a lone surrogate", "run", { ...run, command: "a\ud800" }],
		["a relative cwd", "run", { ...run, cwd: "company" }],
		["a cwd with ..", "run", { ...run, cwd: "/company/../etc" }],
		["a cwd with a trailing slash", "run", { ...run, cwd: "/company/" }],
		["an environment name with =", "run", { ...run, environment: { "A=B": "1" } }],
		["a number in the environment", "run", { ...run, environment: { A: 1 } }],
		["an environment array", "run", { ...run, environment: ["A"] }],
		[
			"too many environment entries",
			"run",
			{ ...run, environment: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`V${i}`, "1"])) },
		],
		["a timeout under a second", "run", { ...run, timeoutMs: 999 }],
		["a view with a space", "mount", { ...mount, view: { ...mount.view, pass: "a b" } }],
		["a view with an extra key", "mount", { ...mount, view: { ...mount.view, path: "/" } }],
		["an empty page", "output", { ...output, maxBytes: 0 }],
		["a page over 1 MiB", "output", { ...output, maxBytes: CODING_GUEST.maxPageBytes + 1 }],
		["a wait over 20 s", "output", { ...output, waitMs: CODING_GUEST.maxWaitMs + 1 }],
		["a negative offset", "output", { ...output, offset: -1 }],
	])("refuses %s", (_name, verb, value) => {
		expect(() => parseCodingGuestRequest(verb, value)).toThrow("Invalid coding guest request");
	});
	it("never quotes the request in its error", () => {
		for (const [verb, value] of [
			["run", { ...run, uid: 0 }],
			["mount", { ...mount, uid: 0 }],
		] as const) {
			try {
				parseCodingGuestRequest(verb, value);
				expect.unreachable();
			} catch (error) {
				expect(String(error)).not.toMatch(/secret/);
			}
		}
	});
});

describe("coding guest answers", () => {
	const runRequest = parseCodingGuestRequest("run", run) as CodingGuestRunRequest;
	const outputRequest = parseCodingGuestRequest("output", output) as CodingGuestOutputRequest;
	const command = {
		schema: "qorpera.coding-guest-command/v1",
		workerId,
		commandId,
		state: "exited",
		exit: { code: 0, signal: null },
		end: 120,
	};
	it("reads each verb's answer", () => {
		expect(parseCodingGuestAnswer("run", runRequest, command)).toEqual(command);
		expect(
			parseCodingGuestAnswer(
				"cancel",
				{ schema: "qorpera.coding-guest-cancel/v1", workerId, commandId },
				{
					...command,
					state: "cancelled",
					exit: { code: null, signal: "SIGTERM" },
				},
			).exit,
		).toEqual({ code: null, signal: "SIGTERM" });
		expect(
			parseCodingGuestAnswer("mount", parseCodingGuestRequest("mount", mount), {
				schema: "qorpera.coding-guest-mounted/v1",
				workerId,
				viewId: "view-1",
				mount: "mounted",
			}).mount,
		).toBe("mounted");
		const page = { ...command, schema: "qorpera.coding-guest-output/v1", offset: 110, bytes: 10, gap: 10 };
		expect(parseCodingGuestAnswer("output", outputRequest, page)).toEqual(page);
		const session = { schema: "qorpera.coding-guest-session/v1", workerId } as const;
		expect(
			parseCodingGuestAnswer("stop-session", session, {
				schema: "qorpera.coding-guest-session-stopped/v1",
				workerId,
			}),
		).toEqual({ schema: "qorpera.coding-guest-session-stopped/v1", workerId });
		const status = parseCodingGuestAnswer("status", session, {
			schema: "qorpera.coding-guest-status/v1",
			workerId,
			commands: [
				{ commandId, state: "running", exit: null, end: 0 },
				{ commandId: workerId, state: "lost", exit: null, end: 5 },
			],
		});
		expect(status.commands.map((entry) => entry.state)).toEqual(["running", "lost"]);
		expect(Object.isFrozen(status.commands)).toBe(true);
	});
	it.each<[string, unknown]>([
		["another worker's answer", { ...command, workerId: commandId }],
		["another command's answer", { ...command, commandId: workerId }],
		["an exited command without its exit", { ...command, exit: null }],
		["a running command with an exit", { ...command, state: "running" }],
		["a lost command with an exit", { ...command, state: "lost" }],
		["an unknown state", { ...command, state: "paused" }],
		["a state in an array", { ...command, state: ["exited"], exit: null }],
		["an exit code above 255", { ...command, exit: { code: 256, signal: null } }],
		["an exit with both a code and a signal", { ...command, exit: { code: 1, signal: "SIGKILL" } }],
		["a made-up signal", { ...command, exit: { code: null, signal: "KILL" } }],
		["a negative end", { ...command, end: -1 }],
		["an extra key", { ...command, pid: 1 }],
		["the output schema", { ...command, schema: "qorpera.coding-guest-output/v1" }],
	])("refuses %s to run", (_name, value) => {
		expect(() => parseCodingGuestAnswer("run", runRequest, value)).toThrow("Invalid coding guest answer");
	});
	it.each<[string, Record<string, unknown>]>([
		["an offset that is not the asked one plus the gap", { offset: 120, gap: 10 }],
		["more bytes than asked", { offset: 100, gap: 0, bytes: 4097, end: 5000 }],
		["bytes past the end", { offset: 100, gap: 0, bytes: 30, end: 120 }],
	])("refuses an output page with %s", (_name, change) => {
		const page = { ...command, schema: "qorpera.coding-guest-output/v1", offset: 100, bytes: 10, gap: 0, ...change };
		expect(() => parseCodingGuestAnswer("output", outputRequest, page)).toThrow("Invalid coding guest answer");
	});
	it("refuses a mount answer for another view or not one string, and a status with repeated, too many or malformed commands", () => {
		for (const [viewId, state] of [
			["view-2", "mounted"],
			["view-1", ["mounted"]],
		])
			expect(() =>
				parseCodingGuestAnswer("mount", parseCodingGuestRequest("mount", mount), {
					schema: "qorpera.coding-guest-mounted/v1",
					workerId,
					viewId,
					mount: state,
				}),
			).toThrow("Invalid coding guest answer");
		const session = { schema: "qorpera.coding-guest-session/v1", workerId } as const;
		const entry = { commandId, state: "running", exit: null, end: 0 };
		for (const commands of [
			[entry, entry],
			Array.from({ length: CODING_GUEST.maxStatusCommands + 1 }, () => entry),
			[{ ...entry, state: ["lost"] }],
		])
			expect(() =>
				parseCodingGuestAnswer("status", session, { schema: "qorpera.coding-guest-status/v1", workerId, commands }),
			).toThrow("Invalid coding guest answer");
	});
	it("reads a refusal's code and nothing else", () => {
		expect(parseCodingGuestRefusal({ schema: "qorpera.coding-guest-refusal/v1", code: "COMMAND_CONFLICT" })).toEqual({
			schema: "qorpera.coding-guest-refusal/v1",
			code: "COMMAND_CONFLICT",
		});
		expect(parseCodingGuestRefusal(command)).toBeUndefined();
		expect(parseCodingGuestRefusal(null)).toBeUndefined();
		for (const value of [
			{ schema: "qorpera.coding-guest-refusal/v1", code: "lower case" },
			{ schema: "qorpera.coding-guest-refusal/v1", code: "FOLDER_UNMOUNTED", detail: "x" },
		])
			expect(() => parseCodingGuestRefusal(value)).toThrow("Invalid coding guest refusal");
	});
});
