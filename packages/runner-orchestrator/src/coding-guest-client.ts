import {
	CODING_GUEST,
	type CodingGuestAnswers,
	type CodingGuestCommandAnswer,
	type CodingGuestMountAnswer,
	type CodingGuestOutputAnswer,
	type CodingGuestRefusal,
	type CodingGuestRequests,
	type CodingGuestSessionStoppedAnswer,
	type CodingGuestStatusAnswer,
	type CodingGuestVerb,
	parseCodingGuestAnswer,
	parseCodingGuestRefusal,
	parseCodingGuestRequest,
} from "@qorpera/contracts";
import { type LxdCodingMachineBinding, lxdCodingMachineName, lxdCodingMachinePlan } from "./coding-machine.ts";
import type { LxdInstanceExecStreamClient } from "./lxd-client.ts";

// The executor's side of the coding guest agent (F3 step 5g-2c; contracts' cloud-coding-guest). One verb is one LXD
// exec of `/usr/bin/node /opt/qorpera-guest/agent.mjs <verb>` as root, with the request as JSON on stdin and one answer
// line on stdout. The agent is root's program in the member's machine, so its answer is bounded, untrusted data: it is
// read only after the exec ended, against the request it answers, and anything else fails the call.

const INVALID = "CODING_GUEST_ANSWER_INVALID";
/** An answer line: a status answer's commands fit well inside it. */
const LINE_BYTES = 131072;
/** Node's own message when the agent crashed; never read. */
const STDERR_BYTES = 16384;
/** Each verb's whole call. The agent waits up to 60 s for its session's lock (mount, run, stop-session), up to 20 s
 * for a folder program's mount, and up to 30 s for each systemctl call; `output` adds the request's own wait. */
const CALL_MS: Readonly<Record<CodingGuestVerb, number>> = Object.freeze({
	mount: 120000,
	run: 120000,
	output: 30000,
	cancel: 60000,
	"stop-session": 120000,
	status: 60000,
});

/** The agent answered with a refusal. Its code is the guest's word: what it says is not proof of anything. */
export class CodingGuestRefused extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`CODING_GUEST_REFUSED:${code}`);
		this.code = code;
	}
}

/** One `output` answer and exactly the bytes it names, which start at `answer.offset`. */
export interface CodingGuestOutputPage {
	readonly answer: CodingGuestOutputAnswer;
	readonly bytes: Buffer;
}

/** Calls the guest agent on one member's coding machine. Each verb may be sent again with the same request: a call
 * that failed or was stopped may have taken effect in the guest, and the repeat reads what it did. A refusal rejects
 * with CodingGuestRefused; a failed exec with the LXD client's error; an agent that crashed with CODING_GUEST_FAILED;
 * and an answer that is not exactly one for this request with CODING_GUEST_ANSWER_INVALID. No error quotes the
 * request or the answer: a view's pass or a command's secrets may be in them. */
export class LxdCodingGuestClient {
	readonly #project: string;
	readonly #name: string;
	readonly #client: LxdInstanceExecStreamClient;
	constructor(options: { machine: LxdCodingMachineBinding; client: LxdInstanceExecStreamClient }) {
		const machine = lxdCodingMachinePlan(options.machine).binding;
		this.#project = machine.project;
		this.#name = lxdCodingMachineName(machine.machineId);
		this.#client = options.client;
	}

	async mount(request: CodingGuestRequests["mount"], signal: AbortSignal): Promise<CodingGuestMountAnswer> {
		return (await this.#call("mount", request, signal)).answer;
	}
	async run(request: CodingGuestRequests["run"], signal: AbortSignal): Promise<CodingGuestCommandAnswer> {
		return (await this.#call("run", request, signal)).answer;
	}
	async output(request: CodingGuestRequests["output"], signal: AbortSignal): Promise<CodingGuestOutputPage> {
		return this.#call("output", request, signal);
	}
	async cancel(request: CodingGuestRequests["cancel"], signal: AbortSignal): Promise<CodingGuestCommandAnswer> {
		return (await this.#call("cancel", request, signal)).answer;
	}
	async stopSession(
		request: CodingGuestRequests["stop-session"],
		signal: AbortSignal,
	): Promise<CodingGuestSessionStoppedAnswer> {
		return (await this.#call("stop-session", request, signal)).answer;
	}
	async status(request: CodingGuestRequests["status"], signal: AbortSignal): Promise<CodingGuestStatusAnswer> {
		return (await this.#call("status", request, signal)).answer;
	}

	async #call<V extends CodingGuestVerb>(
		verb: V,
		request: CodingGuestRequests[V],
		signal: AbortSignal,
	): Promise<{ answer: CodingGuestAnswers[V]; bytes: Buffer }> {
		let asked: CodingGuestRequests[V];
		try {
			asked = parseCodingGuestRequest(verb, request);
		} catch {
			throw new Error("CODING_GUEST_REQUEST_INVALID");
		}
		const stdin = Buffer.from(JSON.stringify(asked));
		if (stdin.byteLength > CODING_GUEST.maxInputBytes) throw new Error("CODING_GUEST_REQUEST_INVALID");
		const page = verb === "output" ? (asked as CodingGuestRequests["output"]) : undefined;
		const result = await this.#client.execInstanceStream(
			this.#project,
			this.#name,
			{
				command: [CODING_GUEST.node, CODING_GUEST.agent, verb],
				stdin,
				maxStdoutBytes: LINE_BYTES + (page?.maxBytes ?? 0),
				maxStderrBytes: STDERR_BYTES,
				timeoutMs: CALL_MS[verb] + (page?.waitMs ?? 0),
			},
			signal,
		);
		// The agent answers every verb, a refusal too, and exits 0: anything else crashed or is not the agent.
		if (result.exitCode !== 0) throw new Error("CODING_GUEST_FAILED");
		return readAnswer(verb, asked, result.stdout);
	}
}

function readAnswer<V extends CodingGuestVerb>(
	verb: V,
	asked: CodingGuestRequests[V],
	stdout: Buffer,
): { answer: CodingGuestAnswers[V]; bytes: Buffer } {
	const end = stdout.indexOf(0x0a);
	if (end < 0 || end > LINE_BYTES) throw new Error(INVALID);
	const bytes = stdout.subarray(end + 1);
	let refusal: CodingGuestRefusal | undefined;
	let answer: CodingGuestAnswers[V] | undefined;
	try {
		// Strict UTF-8, and a byte order mark is not JSON.
		const value: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout.subarray(0, end)),
		);
		refusal = parseCodingGuestRefusal(value);
		answer = refusal ? undefined : parseCodingGuestAnswer(verb, asked, value);
	} catch {
		throw new Error(INVALID);
	}
	// Only `output` follows its line, with exactly the bytes it names.
	if (bytes.byteLength !== (answer && verb === "output" ? (answer as CodingGuestOutputAnswer).bytes : 0))
		throw new Error(INVALID);
	if (refusal) throw new CodingGuestRefused(refusal.code);
	return { answer: answer as CodingGuestAnswers[V], bytes };
}
