import { randomBytes, randomUUID } from "node:crypto";
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CloudCodingCommandRead,
	type CloudCodingCommandReceipt,
	type CloudCodingCommandScope,
	CODING_GUEST,
	type CodingGuestCommandState,
	type CodingGuestExit,
	parseCodingGuestAnswer,
	parseCodingGuestRequest,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingCommandSecrets } from "../src/coding-command-secrets.ts";
import {
	LxdCodingFolderCommandTransport,
	type LxdCodingFolderCommandTransportOptions,
} from "../src/coding-folder-command-transport.ts";
import type { CodingFolderBoundary, CodingFolderReads } from "../src/coding-folder-control.ts";
import { CodingGuestRefused, type LxdCodingGuestClient } from "../src/coding-guest-client.ts";
import { CodingSecretMask } from "../src/coding-secret-mask.ts";
import { codingMachineFixture } from "./helpers/coding-machine.ts";

const SECRET = "s3cr3t-value";
const UID = 200001;
const GID = 200002;
const CWD = "/run/qorpera-folder/mounts/0123/repository";
const MIB = 1048576;
const LIMIT = 4 * MIB;
const UNPROTECTED = "CODING_COMMAND_CUSTODY_UNPROTECTED";
const signal = new AbortController().signal;

type State = CloudCodingCommandReceipt["state"];
type Input = { commandId: string; inputSha256: string; command: string; timeoutMs: number | null };

const custodies: string[] = [];
afterEach(async () => {
	for (const custody of custodies.splice(0)) {
		await chmod(custody, 0o700).catch(() => undefined);
		await rm(custody, { recursive: true, force: true });
	}
});

function thrown(work: () => unknown): string | undefined {
	try {
		work();
	} catch (error) {
		return (error as Error).message;
	}
	return undefined;
}
async function rejected(work: Promise<unknown>): Promise<string | undefined> {
	return work.then(
		() => undefined,
		(error: unknown) => (error as Error).message,
	);
}
async function json(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}
async function absent(path: string): Promise<void> {
	await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}
/** Each entry of a folder and its mode. */
async function modesOf(folder: string): Promise<Record<string, number>> {
	const names = (await readdir(folder)).sort();
	return Object.fromEntries(
		await Promise.all(names.map(async (name) => [name, (await lstat(join(folder, name))).mode & 0o7777] as const)),
	);
}

/** Secrets whose mask hides SECRET. */
function maskedSecrets(environment: Record<string, string> = { TOKEN: SECRET }) {
	return {
		resolve: vi.fn<CodingCommandSecrets["resolve"]>(async () => ({
			environment,
			mask: () => new CodingSecretMask([SECRET]).stream(),
		})),
	};
}

/** A command as the guest agent keeps it: its state and every byte it printed, of which its ring dropped the first
 * `dropped`. The guest doesn't know it until a run lands. */
interface GuestCommand {
	known: boolean;
	state: CodingGuestCommandState;
	exit: CodingGuestExit | null;
	printed: Buffer;
	dropped: number;
}

/** The guest agent as the transport sees it, answering like the real one; every answer passes the contract's parser. */
function fakeGuest(workerId: string) {
	const commands = new Map<string, GuestCommand>();
	const find = (commandId: string): GuestCommand => {
		let found = commands.get(commandId);
		if (!found) {
			found = { known: false, state: "running", exit: null, printed: Buffer.alloc(0), dropped: 0 };
			commands.set(commandId, found);
		}
		return found;
	};
	const stateOf = (commandId: string, found: GuestCommand) => ({
		commandId,
		state: found.state,
		exit: found.exit,
		end: found.printed.length,
	});
	/** Output calls in flight, per command and in all; their peaks; a delay for each; and the most bytes a page has. */
	const watch = {
		inFlight: new Map<string, number>(),
		all: 0,
		overlap: 0,
		peak: 0,
		delayMs: 0,
		pageBytes: CODING_GUEST.maxPageBytes as number,
	};
	const client = {
		run: vi.fn<LxdCodingGuestClient["run"]>(async (request) => {
			const asked = parseCodingGuestRequest("run", request);
			if (asked.workerId !== workerId) throw new Error("FAKE_GUEST_WORKER_DIFFERS");
			const found = find(asked.commandId);
			found.known = true;
			return { schema: "qorpera.coding-guest-command/v1", workerId, ...stateOf(asked.commandId, found) };
		}),
		output: vi.fn<LxdCodingGuestClient["output"]>(async (request) => {
			const asked = parseCodingGuestRequest("output", request);
			if (asked.workerId !== workerId) throw new Error("FAKE_GUEST_WORKER_DIFFERS");
			const mine = (watch.inFlight.get(asked.commandId) ?? 0) + 1;
			watch.inFlight.set(asked.commandId, mine);
			watch.all++;
			watch.overlap = Math.max(watch.overlap, mine);
			watch.peak = Math.max(watch.peak, watch.all);
			try {
				if (watch.delayMs) await new Promise((done) => setTimeout(done, watch.delayMs));
				const found = commands.get(asked.commandId);
				if (!found?.known) throw new CodingGuestRefused("CODING_GUEST_COMMAND_UNKNOWN");
				const end = found.printed.length;
				const offset = Math.max(asked.offset, found.dropped);
				if (offset > end) throw new Error("FAKE_GUEST_OFFSET_PAST_END");
				const bytes = Buffer.from(
					found.printed.subarray(offset, Math.min(end, offset + Math.min(asked.maxBytes, watch.pageBytes))),
				);
				const answer = parseCodingGuestAnswer("output", asked, {
					schema: "qorpera.coding-guest-output/v1",
					workerId,
					...stateOf(asked.commandId, found),
					offset,
					bytes: bytes.length,
					gap: offset - asked.offset,
				});
				return { answer, bytes };
			} finally {
				watch.inFlight.set(asked.commandId, (watch.inFlight.get(asked.commandId) ?? 1) - 1);
				watch.all--;
			}
		}),
		cancel: vi.fn<LxdCodingGuestClient["cancel"]>(async (request) => {
			const asked = parseCodingGuestRequest("cancel", request);
			if (asked.workerId !== workerId) throw new Error("FAKE_GUEST_WORKER_DIFFERS");
			const found = commands.get(asked.commandId);
			if (!found?.known) throw new CodingGuestRefused("CODING_GUEST_COMMAND_UNKNOWN");
			if (found.state === "running") found.state = "cancelled";
			return { schema: "qorpera.coding-guest-command/v1", workerId, ...stateOf(asked.commandId, found) };
		}),
	};
	return {
		client,
		watch,
		print(commandId: string, output: string | Buffer) {
			const found = find(commandId);
			found.printed = Buffer.concat([found.printed, Buffer.from(output)]);
		},
		end(commandId: string, state: CodingGuestCommandState, exit: CodingGuestExit | null = null) {
			Object.assign(find(commandId), { state, exit });
		},
		/** The ring drops every byte before `offset`. */
		drop(commandId: string, offset: number) {
			find(commandId).dropped = offset;
		},
		/** A run that landed although its answer didn't come back. */
		land(commandId: string) {
			find(commandId).known = true;
		},
		/** The session's records went with the session or the machine. */
		forget(commandId: string) {
			find(commandId).known = false;
		},
		/** The last output request. */
		lastOutput() {
			return client.output.mock.calls.at(-1)?.[0];
		},
	};
}

async function fixture(
	setup: { secrets?: CodingCommandSecrets; limitBytes?: number; environment?: Record<string, string> } = {},
) {
	const machine = codingMachineFixture();
	const workerId = randomUUID();
	const scope: CloudCodingCommandScope = { workerId, vmId: machine.machineId, requestId: randomUUID(), turn: 3 };
	const custody = await mkdtemp(join(tmpdir(), "qorpera-host-commands-"));
	custodies.push(custody);
	await chmod(custody, 0o700);
	const guest = fakeGuest(workerId);
	const held = { reads: "released" as CodingFolderReads };
	const control = {
		boundary: vi.fn(
			async (machineId: string, _final: readonly string[], _signal: AbortSignal): Promise<CodingFolderBoundary> => ({
				machine: machineId,
				reads: held.reads,
				views: [],
			}),
		),
	};
	const authorize = vi.fn<LxdCodingFolderCommandTransportOptions["authorize"]>(async () => undefined);
	const limitBytes = setup.limitBytes ?? LIMIT;
	const session = { uid: UID, gid: GID, cwd: CWD, environment: setup.environment ?? { GIT_CONFIG_COUNT: "0" } };
	const options: LxdCodingFolderCommandTransportOptions = {
		machine,
		scope,
		startOperationId: randomUUID(),
		session,
		custody,
		limitBytes,
		guest: guest.client,
		control,
		authorize,
		...(setup.secrets ? { secrets: setup.secrets } : {}),
	};
	/** A transport on the same custody, as the runtime builds one per request. */
	const another = (more: Partial<LxdCodingFolderCommandTransportOptions> = {}) =>
		new LxdCodingFolderCommandTransport({ ...options, ...more });
	const transport = another();
	return {
		machine,
		workerId,
		scope,
		custody,
		guest,
		held,
		control,
		authorize,
		session,
		transport,
		another,
		input: (command = "npm test", more: Partial<Input> = {}): Input => ({
			commandId: randomUUID(),
			inputSha256: randomBytes(32).toString("hex"),
			command,
			timeoutMs: 600000,
			...more,
		}),
		folder: (commandId: string) => join(custody, "host-commands", commandId.replaceAll("-", "")),
		start: (input: Input) => transport.start(scope, input, signal),
		read: (commandId: string, more: Omit<CloudCodingCommandRead, "commandId"> = {}) =>
			transport.read(scope, { commandId, ...more }, signal),
		cancel: (commandId: string) => transport.cancel(scope, commandId, signal),
		/** The receipt a call should answer: by default a whole log of `output` from offset 0. */
		receipt(
			input: { commandId: string; inputSha256: string },
			fields: {
				state: State;
				exitCode?: number | null;
				output?: string;
				truncated?: boolean;
				log?: Partial<CloudCodingCommandReceipt["log"]>;
			},
		) {
			const output = fields.output ?? "";
			const offset = fields.log?.offset ?? 0;
			const nextOffset = fields.log?.nextOffset ?? offset + Buffer.byteLength(output);
			return {
				schema: "qorpera.coding-command-result/v2",
				workerId,
				commandId: input.commandId,
				inputSha256: input.inputSha256,
				state: fields.state,
				exitCode: fields.exitCode ?? null,
				output,
				truncated: fields.truncated ?? false,
				log: { offset, nextOffset, totalBytes: nextOffset, limitBytes, limitReached: false, ...fields.log },
			};
		},
	};
}

describe("LxdCodingFolderCommandTransport", { timeout: 30_000 }, () => {
	it("refuses a binding that is not one session's on the machine", async () => {
		const at = await fixture();
		expect(thrown(() => at.another())).toBeUndefined();
		expect(
			thrown(() =>
				at.another({ session: { uid: CODING_GUEST.minUid, gid: CODING_GUEST.maxUid, cwd: "/w" }, limitBytes: MIB }),
			),
		).toBeUndefined();
		const bad: Partial<LxdCodingFolderCommandTransportOptions>[] = [
			{ scope: { ...at.scope, vmId: randomUUID() } },
			{ scope: { ...at.scope, turn: 0 } },
			{ scope: { ...at.scope, extra: 1 } as CloudCodingCommandScope },
			{ startOperationId: "not-a-start" },
			{ session: { ...at.session, uid: CODING_GUEST.minUid - 1 } },
			{ session: { ...at.session, uid: CODING_GUEST.maxUid + 1 } },
			{ session: { ...at.session, gid: CODING_GUEST.minUid - 1 } },
			{ session: { ...at.session, cwd: "repository" } },
			{ session: { ...at.session, cwd: "/repository/" } },
			{ session: { ...at.session, cwd: "/run/../repository" } },
			{ custody: "custody" },
			{ custody: `${at.custody}/` },
			{ limitBytes: MIB - 1 },
			{ limitBytes: 1024 * MIB + 1 },
			{ limitBytes: MIB + 0.5 },
		];
		expect(bad.map((more) => thrown(() => at.another(more)))).toStrictEqual(
			bad.map(() => "CODING_COMMAND_BINDING_INVALID"),
		);
	});

	it("refuses a bad input before anything, and a scope that is not the transport's", async () => {
		const at = await fixture();
		const good = at.input();
		const bad = [
			{ ...good, command: "" },
			{ ...good, command: "  \n" },
			{ ...good, command: "echo a\0b" },
			{ ...good, command: "x".repeat(16385) },
			{ ...good, command: "echo \ud800" },
			{ ...good, timeoutMs: 999 },
			{ ...good, timeoutMs: 1000.5 },
			{ ...good, extra: true },
			{ commandId: good.commandId, inputSha256: good.inputSha256, command: good.command },
		];
		const inputs: (string | undefined)[] = [];
		for (const input of bad) inputs.push(await rejected(at.transport.start(at.scope, input as never, signal)));
		expect(inputs).toStrictEqual(bad.map(() => "CODING_COMMAND_INPUT_INVALID"));
		const scopes = [
			{ ...at.scope, requestId: randomUUID() },
			{ ...at.scope, turn: 4 },
			{ ...at.scope, workerId: randomUUID() },
			{ ...at.scope, vmId: randomUUID() },
			{ ...at.scope, extra: 1 },
		] as CloudCodingCommandScope[];
		const differs: (string | undefined)[] = [];
		for (const scope of scopes) {
			differs.push(await rejected(at.transport.start(scope, good, signal)));
			differs.push(await rejected(at.transport.read(scope, { commandId: good.commandId }, signal)));
			differs.push(await rejected(at.transport.cancel(scope, good.commandId, signal)));
		}
		differs.push(await rejected(at.start({ ...good, commandId: "command-1" })));
		differs.push(await rejected(at.start({ ...good, inputSha256: "A".repeat(64) })));
		expect(differs).toStrictEqual(differs.map(() => "CODING_COMMAND_SCOPE_DIFFERS"));
		expect(at.authorize).not.toHaveBeenCalled();
		expect(at.guest.client.run).not.toHaveBeenCalled();
		expect(at.guest.client.output).not.toHaveBeenCalled();
		await absent(join(at.custody, "host-commands"));
	});

	it("runs the guest once as the session's user, with the session's names over the host's over the secrets'", async () => {
		const secrets = maskedSecrets({ TOKEN: SECRET, GIT_CONFIG_COUNT: "9", HOME: "/secret-home", EDITOR: "vi" });
		const at = await fixture({
			secrets,
			environment: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", HOME: "/host-home", PATH: "/host" },
		});
		const input = at.input("npm test", { timeoutMs: null });
		expect(await at.start(input)).toStrictEqual(at.receipt(input, { state: "running" }));
		expect(at.guest.client.run).toHaveBeenCalledTimes(1);
		expect(at.guest.client.run.mock.calls[0][0]).toStrictEqual({
			schema: "qorpera.coding-guest-run/v1",
			workerId: at.workerId,
			commandId: input.commandId,
			uid: UID,
			gid: GID,
			command: "npm test",
			cwd: CWD,
			environment: {
				TOKEN: SECRET,
				EDITOR: "vi",
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "safe.directory",
				HOME: "/home/qorpera-200001",
				USER: "qorpera-200001",
				LOGNAME: "qorpera-200001",
				SHELL: "/bin/bash",
				PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
				LANG: "C.UTF-8",
				TMPDIR: "/tmp",
				XDG_RUNTIME_DIR: "/run/user/200001",
				DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/200001/bus",
				DOCKER_HOST: "unix:///run/user/200001/docker.sock",
			},
			timeoutMs: null,
		});
		expect(at.guest.client.run.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
		expect(secrets.resolve).toHaveBeenCalledWith(
			{
				companyId: at.machine.companyId,
				workerId: at.workerId,
				machineId: at.machine.machineId,
				commandId: input.commandId,
				kind: "command",
			},
			expect.any(AbortSignal),
		);
		const asked = ["start", at.scope, input.commandId, input.inputSha256, signal];
		expect(at.authorize.mock.calls).toStrictEqual([asked, asked]);
		const [before, after] = at.authorize.mock.invocationCallOrder;
		const [ran] = at.guest.client.run.mock.invocationCallOrder;
		expect(before).toBeLessThan(ran);
		expect(ran).toBeLessThan(after);
		at.authorize.mockClear();
		await at.read(input.commandId);
		await at.cancel(input.commandId);
		const read = ["read", at.scope, input.commandId, null, signal];
		const cancel = ["cancel", at.scope, input.commandId, null, signal];
		expect(at.authorize.mock.calls).toStrictEqual([read, read, cancel, cancel]);
	});

	it("does nothing for a call whose authority is refused", async () => {
		const at = await fixture();
		at.authorize.mockRejectedValueOnce(new Error("CODING_LEASE_LOST"));
		expect(await rejected(at.start(at.input()))).toBe("CODING_LEASE_LOST");
		expect(at.guest.client.run).not.toHaveBeenCalled();
		await absent(join(at.custody, "host-commands"));
	});

	it("keeps a released command's output and outcome, and answers later reads from them alone", async () => {
		const at = await fixture();
		const input = at.input("echo hello");
		at.guest.print(input.commandId, "hello\n");
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		const started = await at.start(input);
		const done = at.receipt(input, { state: "succeeded", exitCode: 0, output: "hello\n" });
		expect(started).toStrictEqual(done);
		expect(started.log).toStrictEqual({
			offset: 0,
			nextOffset: 6,
			totalBytes: 6,
			limitBytes: LIMIT,
			limitReached: false,
		});
		expect(at.guest.lastOutput()).toStrictEqual({
			schema: "qorpera.coding-guest-output/v1",
			workerId: at.workerId,
			commandId: input.commandId,
			offset: 0,
			maxBytes: CODING_GUEST.maxPageBytes,
			waitMs: 0,
		});
		expect(at.control.boundary).toHaveBeenCalledWith(at.machine.machineId, [], expect.any(AbortSignal));
		const folder = at.folder(input.commandId);
		expect(await modesOf(at.custody)).toStrictEqual({ "host-commands": 0o700 });
		expect(await modesOf(join(at.custody, "host-commands"))).toStrictEqual({
			[input.commandId.replaceAll("-", "")]: 0o700,
		});
		expect(await modesOf(folder)).toStrictEqual({
			"outcome.json": 0o400,
			"output.log": 0o600,
			"progress.json": 0o600,
			"request.json": 0o400,
		});
		expect(await json(join(folder, "outcome.json"))).toStrictEqual({
			schema: "qorpera.coding-host-command-outcome/v1",
			state: "succeeded",
			exitCode: 0,
		});
		expect(await json(join(folder, "request.json"))).toStrictEqual({
			schema: "qorpera.coding-host-command/v1",
			workerId: at.workerId,
			commandId: input.commandId,
			inputSha256: input.inputSha256,
			command: "echo hello",
			timeoutMs: 600000,
			limitBytes: LIMIT,
			turn: 3,
			startOperationId: expect.any(String),
		});
		expect(await json(join(folder, "progress.json"))).toStrictEqual({
			schema: "qorpera.coding-host-command-progress/v1",
			raw: 6,
			masked: null,
			logBytes: 6,
			gapBytes: 0,
			limitReached: false,
			acknowledged: true,
			cancelled: false,
			end: 6,
		});
		expect(await readFile(join(folder, "output.log"), "utf8")).toBe("hello\n");
		expect(await at.read(input.commandId)).toStrictEqual(done);
		const restarted = at.another({ startOperationId: randomUUID() });
		expect(await restarted.read(at.scope, { commandId: input.commandId }, signal)).toStrictEqual(done);
		expect(at.guest.client.output).toHaveBeenCalledTimes(1);
		expect(at.control.boundary).toHaveBeenCalledTimes(1);
	});

	it("keeps nothing while the boundary holds the machine's reads, and all of it once released", async () => {
		const at = await fixture();
		const input = at.input();
		at.guest.print(input.commandId, "hello\n");
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		at.held.reads = "unanswered";
		const running = at.receipt(input, { state: "running" });
		expect(await at.start(input)).toStrictEqual(running);
		const folder = at.folder(input.commandId);
		await absent(join(folder, "output.log"));
		await absent(join(folder, "outcome.json"));
		for (const reads of ["unproven", "denied", "run_ended"] as const) {
			at.held.reads = reads;
			expect(await at.read(input.commandId)).toStrictEqual(running);
		}
		await absent(join(folder, "output.log"));
		expect(at.control.boundary).toHaveBeenCalledTimes(4);
		at.held.reads = "released";
		expect(await at.read(input.commandId)).toStrictEqual(
			at.receipt(input, { state: "succeeded", exitCode: 0, output: "hello\n" }),
		);
	});

	it("takes a boundary that fails as one that holds", async () => {
		const at = await fixture();
		const input = at.input();
		at.guest.print(input.commandId, "hello\n");
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		at.control.boundary.mockRejectedValueOnce(new Error("CODING_FOLDER_CONTROL_UNAVAILABLE"));
		expect(await at.start(input)).toStrictEqual(at.receipt(input, { state: "running" }));
		await absent(join(at.folder(input.commandId), "output.log"));
		expect(await at.read(input.commandId)).toStrictEqual(
			at.receipt(input, { state: "succeeded", exitCode: 0, output: "hello\n" }),
		);
	});

	it.each([
		{ name: "exit 3", state: "exited", exit: { code: 3, signal: null }, shown: "failed", exitCode: 3 },
		{ name: "exit 255", state: "exited", exit: { code: 255, signal: null }, shown: "failed", exitCode: 255 },
		{ name: "SIGKILL", state: "exited", exit: { code: null, signal: "SIGKILL" }, shown: "failed", exitCode: 137 },
		{ name: "SIGTERM", state: "exited", exit: { code: null, signal: "SIGTERM" }, shown: "failed", exitCode: 143 },
		{
			name: "unknown signal",
			state: "exited",
			exit: { code: null, signal: "SIGNOPE" },
			shown: "failed",
			exitCode: 1,
		},
		{ name: "timeout", state: "timed_out", exit: null, shown: "failed", exitCode: 124 },
		{ name: "cancel", state: "cancelled", exit: null, shown: "cancelled", exitCode: null },
		{ name: "lost command", state: "lost", exit: null, shown: "unconfirmed", exitCode: null },
	] as const)("shows a guest's $name as $shown $exitCode", async ({ state, exit, shown, exitCode }) => {
		const at = await fixture();
		const input = at.input();
		at.guest.print(input.commandId, "out\n");
		at.guest.end(input.commandId, state, exit);
		expect(await at.start(input)).toStrictEqual(at.receipt(input, { state: shown, exitCode, output: "out\n" }));
		expect(await json(join(at.folder(input.commandId), "outcome.json"))).toStrictEqual({
			schema: "qorpera.coding-host-command-outcome/v1",
			state: shown,
			exitCode,
		});
	});

	it("shows a command lost on a machine that started again since as machine_stopped", async () => {
		const at = await fixture();
		const input = at.input();
		at.guest.print(input.commandId, "out\n");
		expect(await at.start(input)).toStrictEqual(at.receipt(input, { state: "running", output: "out\n" }));
		at.guest.end(input.commandId, "lost");
		const stopped = at.receipt(input, { state: "machine_stopped", output: "out\n" });
		const restarted = at.another({ startOperationId: randomUUID() });
		expect(await restarted.read(at.scope, { commandId: input.commandId }, signal)).toStrictEqual(stopped);
		expect(await at.read(input.commandId)).toStrictEqual(stopped);
	});

	it("answers the same command again without running it twice, and refuses another under its id", async () => {
		const at = await fixture();
		const input = at.input();
		const running = await at.start(input);
		expect(running).toStrictEqual(at.receipt(input, { state: "running" }));
		expect(await at.start(input)).toStrictEqual(running);
		const next = { ...at.scope, requestId: randomUUID() };
		expect(await at.another({ scope: next }).start(next, input, signal)).toStrictEqual(running);
		expect(at.guest.client.run).toHaveBeenCalledTimes(1);
		at.guest.print(input.commandId, "done\n");
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		const done = at.receipt(input, { state: "succeeded", exitCode: 0, output: "done\n" });
		expect(await at.start(input)).toStrictEqual(done);
		expect(await at.start(input)).toStrictEqual(done);
		expect(at.guest.client.run).toHaveBeenCalledTimes(1);
		const others = [
			{ ...input, command: "npm run other" },
			{ ...input, inputSha256: randomBytes(32).toString("hex") },
			{ ...input, timeoutMs: null },
		];
		const conflicts: (string | undefined)[] = [];
		for (const other of others) conflicts.push(await rejected(at.start(other)));
		expect(conflicts).toStrictEqual(others.map(() => "CODING_COMMAND_CONFLICT"));
		expect(await json(join(at.folder(input.commandId), "request.json"))).toMatchObject({
			command: "npm test",
			inputSha256: input.inputSha256,
			timeoutMs: 600000,
		});
		expect(at.guest.client.run).toHaveBeenCalledTimes(1);
	});

	it("takes a guest's conflict on run as the command started, and fails on its other refusals", async () => {
		const at = await fixture();
		const input = at.input();
		at.guest.land(input.commandId);
		at.guest.print(input.commandId, "hello\n");
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		at.guest.client.run.mockRejectedValueOnce(new CodingGuestRefused("CODING_GUEST_COMMAND_CONFLICT"));
		expect(await at.start(input)).toStrictEqual(
			at.receipt(input, { state: "succeeded", exitCode: 0, output: "hello\n" }),
		);
		expect(await json(join(at.folder(input.commandId), "progress.json"))).toMatchObject({ acknowledged: true });
		const refused = at.input();
		at.guest.client.run.mockRejectedValueOnce(new CodingGuestRefused("CODING_GUEST_SESSION_UNKNOWN"));
		expect(await rejected(at.start(refused))).toBe("CODING_GUEST_REFUSED:CODING_GUEST_SESSION_UNKNOWN");
		await absent(join(at.folder(refused.commandId), "progress.json"));
	});

	it("refuses to read or cancel a command it never started", async () => {
		const at = await fixture();
		const never = randomUUID();
		expect(await rejected(at.read(never))).toBe("CODING_COMMAND_UNKNOWN");
		expect(await rejected(at.cancel(never))).toBe("CODING_COMMAND_UNKNOWN");
		await at.start(at.input());
		expect(await rejected(at.read(never))).toBe("CODING_COMMAND_UNKNOWN");
		expect(await rejected(at.cancel(never))).toBe("CODING_COMMAND_UNKNOWN");
		// A start that stopped before it linked its request.
		await mkdir(at.folder(never), { mode: 0o700 });
		await chmod(at.folder(never), 0o700);
		expect(await rejected(at.read(never))).toBe("CODING_COMMAND_UNKNOWN");
		expect(await rejected(at.cancel(never))).toBe("CODING_COMMAND_UNKNOWN");
		expect(at.guest.client.output).toHaveBeenCalledTimes(1);
		expect(at.guest.client.cancel).not.toHaveBeenCalled();
	});

	it("cancels in the guest, and shows the guest's cancelled state once the boundary releases it", async () => {
		const at = await fixture();
		const input = at.input();
		at.guest.print(input.commandId, "working\n");
		expect(await at.start(input)).toStrictEqual(at.receipt(input, { state: "running", output: "working\n" }));
		at.held.reads = "unanswered";
		expect(await at.cancel(input.commandId)).toStrictEqual(
			at.receipt(input, { state: "running", output: "working\n" }),
		);
		expect(at.guest.client.cancel.mock.calls).toStrictEqual([
			[
				{ schema: "qorpera.coding-guest-cancel/v1", workerId: at.workerId, commandId: input.commandId },
				expect.any(AbortSignal),
			],
		]);
		const folder = at.folder(input.commandId);
		expect(await json(join(folder, "progress.json"))).toMatchObject({ cancelled: true });
		await absent(join(folder, "outcome.json"));
		at.held.reads = "released";
		const cancelled = at.receipt(input, { state: "cancelled", output: "working\n" });
		expect(await at.read(input.commandId)).toStrictEqual(cancelled);
		expect(await at.cancel(input.commandId)).toStrictEqual(cancelled);
		expect(at.guest.client.cancel).toHaveBeenCalledTimes(1);
		expect(await json(join(folder, "outcome.json"))).toMatchObject({ state: "cancelled", exitCode: null });
	});

	it("tolerates a cancel the guest has no command for, and passes its other refusals on", async () => {
		const at = await fixture();
		const input = at.input();
		at.guest.print(input.commandId, "done\n");
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		at.held.reads = "unanswered";
		expect(await at.start(input)).toStrictEqual(at.receipt(input, { state: "running" }));
		at.held.reads = "released";
		at.guest.client.cancel.mockRejectedValueOnce(new CodingGuestRefused("CODING_GUEST_COMMAND_UNKNOWN"));
		expect(await at.cancel(input.commandId)).toStrictEqual(
			at.receipt(input, { state: "succeeded", exitCode: 0, output: "done\n" }),
		);
		const busy = at.input();
		await at.start(busy);
		at.guest.client.cancel.mockRejectedValueOnce(new CodingGuestRefused("CODING_GUEST_SESSION_BUSY"));
		expect(await rejected(at.cancel(busy.commandId))).toBe("CODING_GUEST_REFUSED:CODING_GUEST_SESSION_BUSY");
		// The cancel was kept first: the next read stops it, and the one after shows how it ended.
		expect(await json(join(at.folder(busy.commandId), "progress.json"))).toMatchObject({ cancelled: true });
		expect(await at.read(busy.commandId)).toStrictEqual(at.receipt(busy, { state: "running" }));
		expect(at.guest.client.cancel).toHaveBeenCalledTimes(3);
		expect(await at.read(busy.commandId)).toStrictEqual(at.receipt(busy, { state: "cancelled" }));
	});

	it("shows a start the guest doesn't have as unconfirmed, or cancelled, until it lands", async () => {
		const at = await fixture();
		const input = at.input();
		const folder = at.folder(input.commandId);
		at.guest.client.run.mockRejectedValueOnce(new Error("LXD_EXEC_FAILED"));
		expect(await rejected(at.start(input))).toBe("LXD_EXEC_FAILED");
		await absent(join(folder, "progress.json"));
		expect(await at.read(input.commandId)).toStrictEqual(at.receipt(input, { state: "unconfirmed" }));
		await absent(join(folder, "outcome.json"));
		const cancelled = at.receipt(input, { state: "cancelled" });
		expect(await at.cancel(input.commandId)).toStrictEqual(cancelled);
		expect(at.guest.client.cancel).toHaveBeenCalledTimes(1);
		await absent(join(folder, "outcome.json"));
		// A start after the cancel doesn't run it.
		expect(await at.start(input)).toStrictEqual(cancelled);
		expect(at.guest.client.run).toHaveBeenCalledTimes(1);
		// The lost start lands after all: the next read stops it, and the one after keeps how it ended.
		at.guest.land(input.commandId);
		expect(await at.read(input.commandId)).toStrictEqual(at.receipt(input, { state: "running" }));
		expect(at.guest.client.cancel).toHaveBeenCalledTimes(2);
		expect(await at.read(input.commandId)).toStrictEqual(cancelled);
		expect(await json(join(folder, "outcome.json"))).toMatchObject({ state: "cancelled", exitCode: null });
	});

	it("runs a start again whose answer was lost, with the same request", async () => {
		const at = await fixture();
		const input = at.input();
		at.guest.client.run.mockRejectedValueOnce(new Error("LXD_EXEC_FAILED"));
		expect(await rejected(at.start(input))).toBe("LXD_EXEC_FAILED");
		at.guest.print(input.commandId, "hello\n");
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		expect(await at.start(input)).toStrictEqual(
			at.receipt(input, { state: "succeeded", exitCode: 0, output: "hello\n" }),
		);
		expect(at.guest.client.run).toHaveBeenCalledTimes(2);
		expect(at.guest.client.run.mock.calls[1][0]).toStrictEqual(at.guest.client.run.mock.calls[0][0]);
	});

	it("never runs a command again on a machine that started again since, and ends it machine_stopped", async () => {
		const at = await fixture();
		const input = at.input();
		at.guest.client.run.mockRejectedValueOnce(new Error("LXD_EXEC_FAILED"));
		expect(await rejected(at.start(input))).toBe("LXD_EXEC_FAILED");
		const restarted = at.another({ startOperationId: randomUUID() });
		const stopped = at.receipt(input, { state: "machine_stopped" });
		expect(await restarted.start(at.scope, input, signal)).toStrictEqual(stopped);
		expect(at.guest.client.run).toHaveBeenCalledTimes(1);
		expect(at.guest.client.output).toHaveBeenCalledTimes(1);
		await expect(at.guest.client.output.mock.results[0].value).rejects.toMatchObject({
			code: "CODING_GUEST_COMMAND_UNKNOWN",
		});
		expect(await json(join(at.folder(input.commandId), "outcome.json"))).toStrictEqual({
			schema: "qorpera.coding-host-command-outcome/v1",
			state: "machine_stopped",
			exitCode: null,
		});
		// A read on the restarted machine ends one the same way.
		const read = at.input();
		at.guest.client.run.mockRejectedValueOnce(new Error("LXD_EXEC_FAILED"));
		expect(await rejected(at.start(read))).toBe("LXD_EXEC_FAILED");
		expect(await restarted.read(at.scope, { commandId: read.commandId }, signal)).toStrictEqual(
			at.receipt(read, { state: "machine_stopped" }),
		);
		expect(at.guest.client.run).toHaveBeenCalledTimes(2);
	});

	it("ends a command the guest lost after taking it: unconfirmed on its start, machine_stopped on another", async () => {
		const at = await fixture();
		const input = at.input();
		at.guest.print(input.commandId, "partial\n");
		const partial = at.receipt(input, { state: "running", output: "partial\n" });
		expect(await at.start(input)).toStrictEqual(partial);
		at.guest.print(input.commandId, "more\n");
		at.held.reads = "unanswered";
		expect(await at.read(input.commandId)).toStrictEqual(partial);
		at.guest.forget(input.commandId);
		at.held.reads = "released";
		// The bytes the guest printed that the host saw but didn't keep are lost.
		const lost = at.receipt(input, { state: "unconfirmed", output: "partial\n", log: { gapBytes: 5 } });
		expect(await at.read(input.commandId)).toStrictEqual(lost);
		expect(await json(join(at.folder(input.commandId), "outcome.json"))).toMatchObject({
			state: "unconfirmed",
			exitCode: null,
		});
		const calls = at.guest.client.output.mock.calls.length;
		expect(await at.read(input.commandId)).toStrictEqual(lost);
		expect(at.guest.client.output).toHaveBeenCalledTimes(calls);
		const moved = at.input();
		at.guest.print(moved.commandId, "x\n");
		await at.start(moved);
		at.guest.forget(moved.commandId);
		const restarted = at.another({ startOperationId: randomUUID() });
		expect(await restarted.read(at.scope, { commandId: moved.commandId }, signal)).toStrictEqual(
			at.receipt(moved, { state: "machine_stopped", output: "x\n" }),
		);
	});

	it("counts what the guest's ring dropped before the host kept it as a gap, once", async () => {
		const at = await fixture();
		const input = at.input();
		const folder = at.folder(input.commandId);
		at.guest.print(input.commandId, "first\n");
		const first = at.receipt(input, { state: "running", output: "first\n" });
		expect(await at.start(input)).toStrictEqual(first);
		at.guest.print(input.commandId, `${"x".repeat(39)}\ntail\n`);
		at.guest.drop(input.commandId, 46);
		at.held.reads = "unanswered";
		expect(await at.read(input.commandId)).toStrictEqual(first);
		expect(at.guest.lastOutput()).toMatchObject({ offset: 6 });
		at.held.reads = "released";
		const gapped = { output: "first\ntail\n", log: { gapBytes: 40 } };
		expect(await at.read(input.commandId)).toStrictEqual(at.receipt(input, { state: "running", ...gapped }));
		expect(at.guest.lastOutput()).toMatchObject({ offset: 6 });
		expect(await json(join(folder, "progress.json"))).toMatchObject({ raw: 51, logBytes: 11, gapBytes: 40, end: 51 });
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		expect(await at.read(input.commandId)).toStrictEqual(
			at.receipt(input, { state: "succeeded", exitCode: 0, ...gapped }),
		);
		expect(await readFile(join(folder, "output.log"), "utf8")).toBe("first\ntail\n");
	});

	it("loses the tail the mask held back with a gap that follows it in the same pull", async () => {
		const at = await fixture({ secrets: maskedSecrets() });
		const input = at.input();
		at.guest.watch.pageBytes = 10;
		at.guest.print(input.commandId, `xxxxxxxxs3${"y".repeat(10)}wwwwwwwww\n`);
		const pull = at.guest.client.output.getMockImplementation() as LxdCodingGuestClient["output"];
		at.guest.client.output.mockImplementationOnce(async (request, budget) => {
			const page = await pull(request, budget);
			at.guest.drop(input.commandId, 20);
			return page;
		});
		// "s3" may start the secret, so the mask holds it; the ring then drops 10 bytes, and both are lost.
		const kept = { output: "xxxxxxxxwwwwwwwww\n", log: { gapBytes: 12 } };
		expect(await at.start(input)).toStrictEqual(at.receipt(input, { state: "running", ...kept }));
		expect(at.guest.client.output.mock.calls.map(([request]) => request.offset)).toStrictEqual([0, 10]);
		expect(await json(join(at.folder(input.commandId), "progress.json"))).toMatchObject({ raw: 30, gapBytes: 12 });
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		expect(await at.read(input.commandId)).toStrictEqual(
			at.receipt(input, { state: "succeeded", exitCode: 0, ...kept }),
		);
	});

	it("pulls the guest's output a page at a time, and pages what it kept as the runtime pages a log", async () => {
		const at = await fixture();
		const input = at.input();
		const text = "0123456789".repeat(1000);
		at.guest.watch.pageBytes = 1000;
		at.guest.print(input.commandId, text);
		const pulled = CODING_GUEST.segments * 1000;
		expect(await at.start(input)).toStrictEqual(
			at.receipt(input, {
				state: "running",
				output: text.slice(0, 4096),
				truncated: true,
				log: { totalBytes: pulled },
			}),
		);
		const asked = () => at.guest.client.output.mock.calls.map(([request]) => [request.offset, request.maxBytes]);
		expect(asked()).toStrictEqual(
			Array.from({ length: CODING_GUEST.segments }, (_, index) => [index * 1000, CODING_GUEST.maxPageBytes]),
		);
		expect(await at.read(input.commandId, { offset: 4096, limit: 4096 })).toStrictEqual(
			at.receipt(input, {
				state: "running",
				output: text.slice(4096, 8192),
				truncated: true,
				log: { offset: 4096, totalBytes: 10000 },
			}),
		);
		expect(asked().slice(CODING_GUEST.segments)).toStrictEqual([
			[pulled, CODING_GUEST.maxPageBytes],
			[pulled + 1000, CODING_GUEST.maxPageBytes],
		]);
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		const done = { state: "succeeded", exitCode: 0 } as const;
		expect(await at.read(input.commandId, { offset: 8192 })).toStrictEqual(
			at.receipt(input, { ...done, output: text.slice(8192), log: { offset: 8192 } }),
		);
		expect(await at.read(input.commandId, { tail: true, limit: 100 })).toStrictEqual(
			at.receipt(input, { ...done, output: text.slice(-100), log: { offset: 9900 } }),
		);
		expect(await at.read(input.commandId, { offset: 10000 })).toStrictEqual(
			at.receipt(input, { ...done, log: { offset: 10000 } }),
		);
		expect(await rejected(at.read(input.commandId, { offset: 10001 }))).toBe("CODING_LOG_OFFSET_UNAVAILABLE");
		expect(await rejected(at.read(input.commandId, { limit: 3 }))).toBe("Invalid coding log read");
		expect(await rejected(at.read(input.commandId, { tail: true, offset: 0 }))).toBe("Invalid coding log read");
	});

	it("never splits a character: a page waits for the rest of one, and an offset inside one is refused", async () => {
		const at = await fixture();
		const input = at.input();
		const euro = Buffer.from("€");
		at.guest.print(input.commandId, Buffer.concat([Buffer.from("a"), euro, euro.subarray(0, 1)]));
		expect(await at.start(input)).toStrictEqual(
			at.receipt(input, { state: "running", output: "a€", truncated: true, log: { totalBytes: 5 } }),
		);
		at.guest.print(input.commandId, Buffer.concat([euro.subarray(1), Buffer.from("\n")]));
		expect(await at.read(input.commandId)).toStrictEqual(at.receipt(input, { state: "running", output: "a€€\n" }));
		expect(await rejected(at.read(input.commandId, { offset: 2 }))).toBe("CODING_LOG_OFFSET_SPLITS_UTF8");
		expect(await rejected(at.read(input.commandId, { offset: 6 }))).toBe("CODING_LOG_OFFSET_SPLITS_UTF8");
		expect(await at.read(input.commandId, { limit: 4 })).toStrictEqual(
			at.receipt(input, { state: "running", output: "a€", truncated: true, log: { totalBytes: 8 } }),
		);
		expect(await at.read(input.commandId, { offset: 4, limit: 4 })).toStrictEqual(
			at.receipt(input, { state: "running", output: "€\n", log: { offset: 4 } }),
		);
		// A tail page that would start inside a character starts after it.
		expect(await at.read(input.commandId, { tail: true, limit: 6 })).toStrictEqual(
			at.receipt(input, { state: "running", output: "€\n", log: { offset: 4 } }),
		);
		// Once the command ended, a character it never finished is shown as one that isn't valid.
		at.guest.print(input.commandId, euro.subarray(0, 1));
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		expect(await at.read(input.commandId)).toStrictEqual(
			at.receipt(input, { state: "succeeded", exitCode: 0, output: "a€€\n�", log: { nextOffset: 9 } }),
		);
	});

	it("keeps output up to the limit, and past it only follows where the command is", async () => {
		const at = await fixture({ limitBytes: MIB });
		const input = at.input();
		const folder = at.folder(input.commandId);
		at.guest.print(input.commandId, Buffer.alloc(MIB + 100, "a"));
		const capped = { output: "a".repeat(4096), truncated: true, log: { totalBytes: MIB, limitReached: true } };
		expect(await at.start(input)).toStrictEqual(at.receipt(input, { state: "running", ...capped }));
		expect(await json(join(folder, "progress.json"))).toMatchObject({
			raw: MIB + 100,
			logBytes: MIB,
			limitReached: true,
			end: MIB + 100,
		});
		expect((await readFile(join(folder, "output.log"))).equals(Buffer.alloc(MIB, "a"))).toBe(true);
		expect(at.control.boundary).toHaveBeenCalledTimes(1);
		at.guest.print(input.commandId, Buffer.alloc(50, "a"));
		expect(await at.read(input.commandId)).toStrictEqual(at.receipt(input, { state: "running", ...capped }));
		expect(at.guest.lastOutput()).toMatchObject({ offset: MIB + 100, maxBytes: 1 });
		expect(at.control.boundary).toHaveBeenCalledTimes(1);
		expect(await json(join(folder, "progress.json"))).toMatchObject({
			raw: MIB + 150,
			logBytes: MIB,
			end: MIB + 150,
		});
		at.guest.end(input.commandId, "exited", { code: 3, signal: null });
		expect(await at.read(input.commandId)).toStrictEqual(
			at.receipt(input, { state: "failed", exitCode: 3, ...capped }),
		);
		expect(at.guest.lastOutput()).toMatchObject({ offset: MIB + 150, maxBytes: 1 });
		expect(at.control.boundary).toHaveBeenCalledTimes(2);
		expect(await at.read(input.commandId, { tail: true, limit: 10 })).toStrictEqual(
			at.receipt(input, {
				state: "failed",
				exitCode: 3,
				output: "aaaaaaaaaa",
				truncated: true,
				log: { offset: MIB - 10, totalBytes: MIB, limitReached: true },
			}),
		);
	});

	it("ends a command at the limit without pulling the rest of its output", async () => {
		const at = await fixture({ limitBytes: MIB });
		at.guest.watch.pageBytes = MIB / 4;
		const input = at.input();
		at.guest.print(input.commandId, Buffer.alloc(3 * MIB, "b"));
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		expect(await at.start(input)).toStrictEqual(
			at.receipt(input, {
				state: "succeeded",
				exitCode: 0,
				output: "b".repeat(4096),
				truncated: true,
				log: { totalBytes: MIB, limitReached: true },
			}),
		);
		expect(at.guest.client.output).toHaveBeenCalledTimes(CODING_GUEST.segments);
		expect(await json(join(at.folder(input.commandId), "progress.json"))).toMatchObject({
			raw: 2 * MIB,
			logBytes: MIB,
			limitReached: true,
			end: 3 * MIB,
		});
	});

	it("counts nothing lost past the limit when the guest loses the command", async () => {
		const at = await fixture({ limitBytes: MIB });
		at.guest.watch.pageBytes = MIB / 4;
		const input = at.input();
		at.guest.print(input.commandId, Buffer.alloc(3 * MIB, "d"));
		const capped = { output: "d".repeat(4096), truncated: true, log: { totalBytes: MIB, limitReached: true } };
		expect(await at.start(input)).toStrictEqual(at.receipt(input, { state: "running", ...capped }));
		at.guest.forget(input.commandId);
		expect(await at.read(input.commandId)).toStrictEqual(at.receipt(input, { state: "unconfirmed", ...capped }));
		expect(await json(join(at.folder(input.commandId), "progress.json"))).toMatchObject({
			raw: 2 * MIB,
			gapBytes: 0,
			end: 3 * MIB,
		});
	});

	it("masks the command's secrets across the guest's pages and across reads", async () => {
		const secrets = maskedSecrets();
		const at = await fixture({ secrets });
		at.guest.watch.pageBytes = 10;
		const input = at.input();
		const base64 = Buffer.from(SECRET).toString("base64");
		const percent = Buffer.from(SECRET).toString("hex").replace(/../g, "%$&");
		at.guest.print(input.commandId, `token=${SECRET} ${base64} ${percent} ok\n`);
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		const masked = "token=*** *** *** ok\n";
		expect(await at.start(input)).toStrictEqual(
			at.receipt(input, { state: "succeeded", exitCode: 0, output: masked }),
		);
		expect(await readFile(join(at.folder(input.commandId), "output.log"), "utf8")).toBe(masked);
		expect(secrets.resolve).toHaveBeenCalledTimes(2);
		// A tail that may start the secret waits for what follows it.
		const next = at.input();
		at.guest.print(next.commandId, `token=${SECRET.slice(0, 5)}`);
		expect(await at.start(next)).toStrictEqual(at.receipt(next, { state: "running", output: "token=" }));
		expect(await json(join(at.folder(next.commandId), "progress.json"))).toMatchObject({
			raw: 6,
			logBytes: 6,
			end: 11,
		});
		at.guest.print(next.commandId, `${SECRET.slice(5)} done\n`);
		at.guest.end(next.commandId, "exited", { code: 0, signal: null });
		const calls = at.guest.client.output.mock.calls.length;
		expect(await at.read(next.commandId)).toStrictEqual(
			at.receipt(next, { state: "succeeded", exitCode: 0, output: "token=*** done\n" }),
		);
		expect(at.guest.client.output.mock.calls.slice(calls).map(([request]) => request.offset)).toStrictEqual([6, 16]);
		expect(await readFile(join(at.folder(next.commandId), "output.log"), "utf8")).not.toContain(SECRET);
	});

	it("keeps a match it already showed as *** masked when a later read pulls the held tail again", async () => {
		// The value overlaps itself: once its eight bytes match, the next seven may start another match, so the mask
		// shows `***` and holds them back for the next read.
		const value = "aaaaaaaa";
		const secrets = {
			resolve: vi.fn<CodingCommandSecrets["resolve"]>(async () => ({
				environment: { TOKEN: value },
				mask: () => new CodingSecretMask([value]).stream(),
			})),
		};
		const at = await fixture({ secrets });
		const ended = at.input();
		at.guest.print(ended.commandId, value);
		expect(await at.start(ended)).toStrictEqual(at.receipt(ended, { state: "running", output: "***" }));
		expect(await json(join(at.folder(ended.commandId), "progress.json"))).toMatchObject({
			raw: 1,
			masked: 7,
			logBytes: 3,
			end: 8,
		});
		at.guest.print(ended.commandId, "\n");
		at.guest.end(ended.commandId, "exited", { code: 0, signal: null });
		const reader = at.another();
		expect(await reader.read(at.scope, { commandId: ended.commandId }, signal)).toStrictEqual(
			at.receipt(ended, { state: "succeeded", exitCode: 0, output: "***\n" }),
		);
		// A match that completes on a later read, overlapping the one already shown, joins it.
		const longer = at.input();
		at.guest.print(longer.commandId, value);
		expect(await at.start(longer)).toStrictEqual(at.receipt(longer, { state: "running", output: "***" }));
		at.guest.print(longer.commandId, "a");
		expect(await at.another().read(at.scope, { commandId: longer.commandId }, signal)).toStrictEqual(
			at.receipt(longer, { state: "running", output: "***" }),
		);
		expect(await json(join(at.folder(longer.commandId), "progress.json"))).toMatchObject({ raw: 2, masked: 7 });
		at.guest.print(longer.commandId, "aaaaaaa ok\n");
		at.guest.end(longer.commandId, "exited", { code: 0, signal: null });
		expect(await at.another().read(at.scope, { commandId: longer.commandId }, signal)).toStrictEqual(
			at.receipt(longer, { state: "succeeded", exitCode: 0, output: "*** ok\n" }),
		);
		for (const commandId of [ended.commandId, longer.commandId]) {
			expect(await readFile(join(at.folder(commandId), "output.log"), "utf8")).not.toContain("a");
		}
	});

	it("refuses custody another user could change", async () => {
		const at = await fixture();
		const input = at.input();
		await chmod(at.custody, 0o777);
		expect(await rejected(at.start(input))).toBe(UNPROTECTED);
		expect(at.guest.client.run).not.toHaveBeenCalled();
		await absent(join(at.custody, "host-commands"));
		await chmod(at.custody, 0o755);
		at.guest.print(input.commandId, "hello\n");
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		const done = at.receipt(input, { state: "succeeded", exitCode: 0, output: "hello\n" });
		expect(await at.start(input)).toStrictEqual(done);
		const commands = join(at.custody, "host-commands");
		const folder = at.folder(input.commandId);
		for (const [path, mode] of [
			[commands, 0o750],
			[commands, 0o711],
			[folder, 0o750],
			[folder, 0o701],
		] as const) {
			await chmod(path, mode);
			expect(await rejected(at.read(input.commandId))).toBe(UNPROTECTED);
			expect(await rejected(at.start(input))).toBe(UNPROTECTED);
			await chmod(path, 0o700);
		}
		expect(await at.read(input.commandId)).toStrictEqual(done);
	});

	it("refuses kept records that are not the host's own, and sweeps a half-written one", async () => {
		const at = await fixture();
		const input = at.input();
		at.guest.print(input.commandId, "hello\n");
		at.guest.end(input.commandId, "exited", { code: 0, signal: null });
		const done = at.receipt(input, { state: "succeeded", exitCode: 0, output: "hello\n" });
		expect(await at.start(input)).toStrictEqual(done);
		const folder = at.folder(input.commandId);
		const named = (name: string) => join(folder, name);
		const elsewhere = join(at.custody, "elsewhere");
		await writeFile(elsewhere, "other\n", { mode: 0o600 });
		const progress = await readFile(named("progress.json"), "utf8");
		// A link to a file elsewhere, by name or by inode.
		for (const name of ["output.log", "progress.json"]) {
			const kept = await readFile(named(name));
			await unlink(named(name));
			await symlink(elsewhere, named(name));
			expect(await rejected(at.read(input.commandId))).toBe(UNPROTECTED);
			await unlink(named(name));
			await writeFile(named(name), kept, { mode: 0o600 });
			expect(await at.read(input.commandId)).toStrictEqual(done);
			await link(named(name), join(at.custody, `${name}.link`));
			expect(await rejected(at.read(input.commandId))).toBe(UNPROTECTED);
			await unlink(join(at.custody, `${name}.link`));
		}
		for (const [name, mode] of [
			["progress.json", 0o644],
			["progress.json", 0o400],
			["outcome.json", 0o600],
			["request.json", 0o440],
			["output.log", 0o640],
		] as const) {
			const was = (await lstat(named(name))).mode & 0o7777;
			await chmod(named(name), mode);
			expect(await rejected(at.read(input.commandId))).toBe(UNPROTECTED);
			await chmod(named(name), was);
		}
		expect(await at.read(input.commandId)).toStrictEqual(done);
		// Records the host would never write.
		const saved = JSON.parse(progress) as Record<string, unknown>;
		await writeFile(named("progress.json"), JSON.stringify({ ...saved, extra: 1 }));
		expect(await rejected(at.read(input.commandId))).toBe("CODING_COMMAND_CUSTODY_INVALID");
		await writeFile(named("progress.json"), JSON.stringify({ ...saved, logBytes: LIMIT + 1 }));
		expect(await rejected(at.read(input.commandId))).toBe("CODING_COMMAND_CUSTODY_INVALID");
		await writeFile(named("progress.json"), JSON.stringify({ ...saved, masked: -1 }));
		expect(await rejected(at.read(input.commandId))).toBe("CODING_COMMAND_CUSTODY_INVALID");
		await writeFile(named("progress.json"), progress);
		await unlink(named("outcome.json"));
		await writeFile(
			named("outcome.json"),
			JSON.stringify({ schema: "qorpera.coding-host-command-outcome/v1", state: "succeeded", exitCode: 1 }),
			{ mode: 0o400 },
		);
		expect(await rejected(at.read(input.commandId))).toBe("CODING_COMMAND_CUSTODY_INVALID");
		await unlink(named("outcome.json"));
		await writeFile(
			named("outcome.json"),
			JSON.stringify({ schema: "qorpera.coding-host-command-outcome/v1", state: "succeeded", exitCode: 0 }),
			{ mode: 0o400 },
		);
		// A temporary file a call left when it stopped half way is removed by the next.
		await writeFile(named(".progress.json.new"), "{", { mode: 0o600 });
		expect(await at.read(input.commandId)).toStrictEqual(done);
		await absent(named(".progress.json.new"));
		expect(at.guest.client.output).toHaveBeenCalledTimes(1);
	});

	it("serializes calls on one command across transports, and not calls on different commands", async () => {
		const at = await fixture();
		const first = at.input();
		const second = at.input();
		const [one, two] = await Promise.all([at.start(first), at.another().start(at.scope, first, signal)]);
		expect(two).toStrictEqual(one);
		expect(at.guest.client.run).toHaveBeenCalledTimes(1);
		await at.start(second);
		at.guest.watch.delayMs = 50;
		at.guest.watch.peak = 0;
		await Promise.all([
			at.read(first.commandId),
			at.another().read(at.scope, { commandId: first.commandId }, signal),
			at.read(first.commandId, { tail: true }),
		]);
		expect(at.guest.watch.overlap).toBe(1);
		expect(at.guest.watch.peak).toBe(1);
		await Promise.all([at.read(first.commandId), at.read(second.commandId)]);
		expect(at.guest.watch.peak).toBe(2);
	});
});
