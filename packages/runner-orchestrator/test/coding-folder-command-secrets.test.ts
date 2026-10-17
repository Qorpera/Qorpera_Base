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
// executor saves is masked for every session attached to the machine.

const API_KEY = "env-value-api-key-CANARY";
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

describe("a folder-model command with its session's vault environment", () => {
	it("starts with the session's values and saves output masked for every session on the machine", async () => {
		const machine = codingMachineFixture();
		const workerId = randomUUID();
		const otherId = randomUUID();
		const source = {
			environment: vi.fn<CodingEnvironmentSource["environment"]>(
				async (asked): Promise<Record<string, string>> =>
					asked.workerId === workerId ? { API_KEY } : { OTHER_KEY },
			),
		};
		const secrets = new CodingMachineCommandSecrets(source);
		const claim = (worker: string) => ({ companyId: machine.companyId, workerId: worker, leaseToken: randomUUID() });
		// Another session of the member's on the same machine already ran a command.
		const asked = { companyId: machine.companyId, workerId: otherId, machineId: machine.machineId };
		await secrets
			.session(machine.machineId, claim(otherId))
			.resolve({ ...asked, commandId: randomUUID(), kind: "command" }, new AbortController().signal);
		const scope: CloudCodingCommandScope = { workerId, vmId: machine.machineId, requestId: randomUUID(), turn: 3 };
		const custody = await mkdtemp(join(tmpdir(), "qorpera-host-commands-"));
		custodies.push(custody);
		await chmod(custody, 0o700);
		const guest = fakeGuest(workerId);
		const options: LxdCodingFolderCommandTransportOptions = {
			machine,
			scope,
			startOperationId: randomUUID(),
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
			secrets: secrets.session(machine.machineId, claim(workerId)),
		};
		const input = {
			commandId: randomUUID(),
			inputSha256: randomBytes(32).toString("hex"),
			command: "npm test",
			timeoutMs: 600000,
		};
		guest.print(input.commandId, `key=${API_KEY}\n`);
		const started = await new LxdCodingFolderCommandTransport(options).start(scope, input, signal);
		expect(started).toMatchObject({ state: "running", output: "key=***\n" });
		// Its own values only, under the host's names.
		const { environment } = guest.client.run.mock.calls[0][0];
		expect(environment).toMatchObject({ API_KEY, HOME: "/home/qorpera-200001" });
		expect(environment).not.toHaveProperty("OTHER_KEY");
		// A later call, under a later claim, reads it on without asking again.
		guest.print(input.commandId, `other=${OTHER_KEY} key=${API_KEY}\n`);
		guest.end(input.commandId);
		const later = new LxdCodingFolderCommandTransport({
			...options,
			secrets: secrets.session(machine.machineId, claim(workerId)),
		});
		const masked = "key=***\nother=*** key=***\n";
		expect(await later.read(scope, { commandId: input.commandId }, signal)).toMatchObject({
			state: "succeeded",
			exitCode: 0,
			output: masked,
		});
		const saved = await readFile(join(custody, "host-commands", input.commandId.replaceAll("-", ""), "output.log"));
		expect(saved.toString("utf8")).toBe(masked);
		expect(source.environment).toHaveBeenCalledTimes(2);
		expect(source.environment).toHaveBeenLastCalledWith(
			{ companyId: machine.companyId, workerId, leaseToken: expect.any(String) },
			expect.any(AbortSignal),
		);
	});
});
