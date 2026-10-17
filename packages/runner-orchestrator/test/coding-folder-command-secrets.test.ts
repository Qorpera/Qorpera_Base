import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CloudCodingCommandScope,
	type CodingGuestCommandState,
	type CodingGuestExit,
	parseCodingGuestAnswer,
	parseCodingGuestRequest,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodingEnvironmentSource, CodingMachineCommandSecrets } from "../src/coding-command-secrets.ts";
import {
	LxdCodingFolderCommandTransport,
	type LxdCodingFolderCommandTransportOptions,
} from "../src/coding-folder-command-transport.ts";
import type { CodingFolderBoundary } from "../src/coding-folder-control.ts";
import { CodingGuestRefused, type LxdCodingGuestClient } from "../src/coding-guest-client.ts";
import { codingMachineFixture } from "./helpers/coding-machine.ts";

// 5j-4: a folder-model command gets its session's vault environment, asked from the broker once, and the output the
// executor saves is masked for every session attached to the machine. Output the executor can't mask is not kept.

const API_KEY = "env-value-api-key-CANARY";
const ROTATED = "env-value-api-key-ROTATED";
const OTHER_KEY = "env-value-other-session-CANARY";
const signal = new AbortController().signal;

const custodies: string[] = [];
afterEach(async () => {
	for (const custody of custodies.splice(0)) {
		await chmod(custody, 0o700).catch(() => undefined);
		await rm(custody, { recursive: true, force: true });
	}
});

interface GuestCommand {
	state: CodingGuestCommandState;
	exit: CodingGuestExit | null;
	printed: Buffer;
}

/** The guest agent for one session, answering like the real one; every answer passes the contract's parser. */
function fakeGuest(workerId: string) {
	const commands = new Map<string, GuestCommand>();
	const find = (commandId: string) => {
		const found: GuestCommand = commands.get(commandId) ?? { state: "running", exit: null, printed: Buffer.alloc(0) };
		commands.set(commandId, found);
		return found;
	};
	const stateOf = (commandId: string) => {
		const found = find(commandId);
		return { commandId, state: found.state, exit: found.exit, end: found.printed.length };
	};
	const client = {
		run: vi.fn<LxdCodingGuestClient["run"]>(async (request) => {
			const asked = parseCodingGuestRequest("run", request);
			return { schema: "qorpera.coding-guest-command/v1", workerId, ...stateOf(asked.commandId) };
		}),
		output: vi.fn<LxdCodingGuestClient["output"]>(async (request) => {
			const asked = parseCodingGuestRequest("output", request);
			if (!commands.has(asked.commandId)) throw new CodingGuestRefused("CODING_GUEST_COMMAND_UNKNOWN");
			const printed = find(asked.commandId).printed;
			const bytes = Buffer.from(printed.subarray(asked.offset, asked.offset + asked.maxBytes));
			const answer = parseCodingGuestAnswer("output", asked, {
				schema: "qorpera.coding-guest-output/v1",
				workerId,
				...stateOf(asked.commandId),
				offset: asked.offset,
				bytes: bytes.length,
				gap: 0,
			});
			return { answer, bytes };
		}),
		cancel: vi.fn<LxdCodingGuestClient["cancel"]>(async () => {
			throw new Error("unused");
		}),
	};
	return {
		client,
		print(commandId: string, output: string) {
			const found = find(commandId);
			found.printed = Buffer.concat([found.printed, Buffer.from(output)]);
		},
		end(commandId: string) {
			Object.assign(find(commandId), { state: "exited", exit: { code: 0, signal: null } });
		},
	};
}

/** A session's folder-model transport on a member machine, whose broker answers API_KEY for the session's worker
 * and OTHER_KEY for any other. */
async function fixture() {
	const machine = codingMachineFixture();
	const workerId = randomUUID();
	const source = {
		environment: vi.fn<CodingEnvironmentSource["environment"]>(
			async (asked): Promise<Record<string, string>> => (asked.workerId === workerId ? { API_KEY } : { OTHER_KEY }),
		),
	};
	const claim = (worker = workerId) => ({ companyId: machine.companyId, workerId: worker, leaseToken: randomUUID() });
	const scope: CloudCodingCommandScope = { workerId, vmId: machine.machineId, requestId: randomUUID(), turn: 3 };
	const custody = await mkdtemp(join(tmpdir(), "qorpera-host-commands-"));
	custodies.push(custody);
	await chmod(custody, 0o700);
	const guest = fakeGuest(workerId);
	const startOperationId = randomUUID();
	/** A call's transport, with the session's secrets under a claim of its own. */
	const transport = (secrets: CodingMachineCommandSecrets) =>
		new LxdCodingFolderCommandTransport({
			machine,
			scope,
			startOperationId,
			session: { uid: 200001, gid: 200002, cwd: "/run/qorpera-folder/mounts/0123/repository", environment: {} },
			custody,
			limitBytes: 4 * 1048576,
			guest: guest.client,
			control: {
				boundary: async (machineId: string): Promise<CodingFolderBoundary> => ({
					machine: machineId,
					reads: "released",
					views: [],
				}),
			},
			authorize: vi.fn<LxdCodingFolderCommandTransportOptions["authorize"]>(async () => undefined),
			secrets: secrets.session(machine.machineId, claim()),
		});
	const input = () => ({
		commandId: randomUUID(),
		inputSha256: randomBytes(32).toString("hex"),
		command: "npm test",
		timeoutMs: 600000,
	});
	const saved = (commandId: string) =>
		readFile(join(custody, "host-commands", commandId.replaceAll("-", ""), "output.log"), "utf8");
	return { machine, workerId, source, claim, scope, guest, transport, input, saved };
}

describe("a folder-model command with its session's vault environment", () => {
	it("starts with the session's values and saves output masked for every session on the machine", async () => {
		const at = await fixture();
		const secrets = new CodingMachineCommandSecrets(at.source);
		// Another session of the member's on the same machine already ran a command.
		const otherId = randomUUID();
		const asked = { companyId: at.machine.companyId, workerId: otherId, machineId: at.machine.machineId };
		await secrets
			.session(at.machine.machineId, at.claim(otherId))
			.resolve({ ...asked, commandId: randomUUID(), kind: "command" }, new AbortController().signal);
		const input = at.input();
		at.guest.print(input.commandId, `key=${API_KEY}\n`);
		const started = await at.transport(secrets).start(at.scope, input, signal);
		expect(started).toMatchObject({ state: "running", output: "key=***\n" });
		// Its own values only, under the host's names.
		const { environment } = at.guest.client.run.mock.calls[0][0];
		expect(environment).toMatchObject({ API_KEY, HOME: "/home/qorpera-200001" });
		expect(environment).not.toHaveProperty("OTHER_KEY");
		// A later call, under a later claim, reads it on without asking again.
		at.guest.print(input.commandId, `other=${OTHER_KEY} key=${API_KEY}\n`);
		at.guest.end(input.commandId);
		const masked = "key=***\nother=*** key=***\n";
		expect(await at.transport(secrets).read(at.scope, { commandId: input.commandId }, signal)).toMatchObject({
			state: "succeeded",
			exitCode: 0,
			output: masked,
		});
		expect(await at.saved(input.commandId)).toBe(masked);
		expect(at.source.environment).toHaveBeenCalledTimes(2);
		expect(at.source.environment).toHaveBeenLastCalledWith(
			{ companyId: at.machine.companyId, workerId: at.workerId, leaseToken: expect.any(String) },
			expect.any(AbortSignal),
		);
	});

	it("keeps none of a command's output once the executor that started it is gone, and counts it lost", async () => {
		const at = await fixture();
		const input = at.input();
		at.guest.print(input.commandId, `key=${API_KEY}\n`);
		const first = at.transport(new CodingMachineCommandSecrets(at.source));
		expect(await first.start(at.scope, input, signal)).toMatchObject({ state: "running", output: "key=***\n" });
		// The executor starts again, and the secret was rotated meanwhile: the broker's answer no longer has the value
		// the command runs with.
		at.source.environment.mockResolvedValue({ API_KEY: ROTATED });
		const restarted = new CodingMachineCommandSecrets(at.source);
		const unread = `again=${API_KEY}\n`;
		at.guest.print(input.commandId, unread);
		at.guest.end(input.commandId);
		expect(await at.transport(restarted).read(at.scope, { commandId: input.commandId }, signal)).toMatchObject({
			state: "succeeded",
			exitCode: 0,
			output: "key=***\n",
			log: { gapBytes: unread.length },
		});
		expect(await at.saved(input.commandId)).toBe("key=***\n");
		expect(at.source.environment).toHaveBeenCalledOnce();
	});

	it("keeps none of a command's output when the guest runs it with an earlier start's environment", async () => {
		const at = await fixture();
		const input = at.input();
		// An executor before this one started it with a value since rotated, and stopped before it noted the start.
		at.source.environment.mockResolvedValue({ API_KEY: ROTATED });
		const printed = `key=${API_KEY}\n`;
		at.guest.print(input.commandId, printed);
		at.guest.client.run.mockRejectedValueOnce(new CodingGuestRefused("CODING_GUEST_COMMAND_CONFLICT"));
		const transport = at.transport(new CodingMachineCommandSecrets(at.source));
		expect(await transport.start(at.scope, input, signal)).toMatchObject({
			state: "running",
			output: "",
			log: { gapBytes: printed.length },
		});
		at.guest.print(input.commandId, "done\n");
		at.guest.end(input.commandId);
		expect(await transport.read(at.scope, { commandId: input.commandId }, signal)).toMatchObject({
			state: "succeeded",
			exitCode: 0,
			output: "",
			log: { gapBytes: printed.length + 5 },
		});
		expect(await at.saved(input.commandId)).toBe("");
	});
});
