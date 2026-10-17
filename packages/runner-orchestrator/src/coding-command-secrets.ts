import { isDeepStrictEqual } from "node:util";
import { CodingSecretMask } from "./coding-secret-mask.ts";

// The hook a member coding machine's commands take their secrets through (F3 5g-3c; the broker's side is 5j-4).
// The executor asks once for each command it starts, and for its output's mask each time it keeps more of it.

/** What runs: a model's command, a terminal (5g-7) or a setup step (5h). */
export type CodingCommandKind = "command" | "terminal" | "install";

/** One byte stream's masking (a `CodingSecretMaskStream`): `push` holds back the tail that could still start a
 * value (`pending` raw bytes), and `end` lets it through. A new stream takes over at that tail with `resume` and what
 * `masked` said there, so the executor can pull the tail again on a later read. */
export interface CodingCommandSecretMask {
	push(chunk: Uint8Array): Uint8Array;
	end(): Uint8Array;
	pending(): number;
	masked(): number | null;
	resume(masked: number | null): void;
}

export interface CodingCommandSecretRequest {
	readonly companyId: string;
	readonly workerId: string;
	readonly machineId: string;
	readonly commandId: string;
	readonly kind: CodingCommandKind;
}

/** A command's secrets. Each `mask()` is a new stream. A failure fails the call that asked. */
export interface CodingCommandSecrets {
	/** At the command's start: the environment it gets its secrets in, and a mask for its output, which covers every
	 * value the environment holds. */
	resolve(
		request: CodingCommandSecretRequest,
		signal: AbortSignal,
	): Promise<{ environment: Readonly<Record<string, string>>; mask(): CodingCommandSecretMask }>;
	/** At each read: the mask for the output of a command started with `resolve`, or `null` when the values the command
	 * runs with are not known here. Then none of its output may be kept. */
	output(request: CodingCommandSecretRequest, signal: AbortSignal): Promise<(() => CodingCommandSecretMask) | null>;
	/** The guest runs the command with another environment than `resolve` gave: an earlier start's. */
	differs(request: CodingCommandSecretRequest): void;
}

/** No secrets: an empty environment, and a mask that changes nothing. */
export const noCodingCommandSecrets: CodingCommandSecrets = Object.freeze({
	async resolve() {
		return { environment: Object.freeze({}), mask: () => new CodingSecretMask().stream() };
	},
	async output() {
		return () => new CodingSecretMask().stream();
	},
	differs() {},
});

/** The leased session a vault environment is asked for (5j-4): the company whose secret broker holds it, and the
 * worker and lease the kernel checks before the broker releases anything. */
export interface CodingEnvironmentScope {
	readonly companyId: string;
	readonly workerId: string;
	readonly leaseToken: string;
}

/** Where a session's environment secrets come from: the company's secret broker (deploy/coding-worker). Each call
 * asks again; a failure fails the call. */
export interface CodingEnvironmentSource {
	environment(scope: CodingEnvironmentScope, signal: AbortSignal): Promise<Readonly<Record<string, string>>>;
}

type Environment = Readonly<Record<string, string>>;

interface Session {
	/** Each command's environment. */
	readonly commands: Map<string, Environment>;
	/** The commands the guest runs with an earlier start's environment (`differs`). */
	readonly differs: Set<string>;
}

interface Machine {
	/** Per session, by worker. */
	readonly sessions: Map<string, Session>;
	/** The values of the sessions released while another stayed attached. */
	readonly released: Set<string>;
}

/** The secrets of the sessions attached to this executor's machines (5j-4). A command's start asks the source, and
 * its reads' masks cover the values it started with, even if one changes while it runs. A failed ask is not kept.
 * Each mask covers every value resolved for any session attached to the command's machine, and for any released while
 * another stayed: root on the machine reaches them all, and the other's commands may not have had their output kept
 * yet. A machine's values go once its last session is released. A command whose start this process didn't resolve
 * (it started before the executor did), or whose guest runs it with an earlier start's environment, has no mask. */
export class CodingMachineCommandSecrets {
	readonly #source: CodingEnvironmentSource;
	readonly #machines = new Map<string, Machine>();
	constructor(source: CodingEnvironmentSource) {
		this.#source = source;
	}

	/** One session's secrets on its machine, asked for under `scope`, the claim of the call that uses them. */
	session(machineId: string, scope: CodingEnvironmentScope): CodingCommandSecrets {
		const machine: Machine = this.#machines.get(machineId) ?? {
			sessions: new Map<string, Session>(),
			released: new Set<string>(),
		};
		this.#machines.set(machineId, machine);
		const session: Session = machine.sessions.get(scope.workerId) ?? {
			commands: new Map<string, Environment>(),
			differs: new Set<string>(),
		};
		machine.sessions.set(scope.workerId, session);
		const asked = Object.freeze({
			companyId: scope.companyId,
			workerId: scope.workerId,
			leaseToken: scope.leaseToken,
		});
		return {
			resolve: (request, signal) => this.#resolve(machineId, asked, session, request, signal),
			output: (request, signal) => this.#output(machineId, asked, session, request, signal),
			differs: (request) => {
				this.#check(machineId, asked, request);
				if (session.commands.has(request.commandId)) session.differs.add(request.commandId);
			},
		};
	}

	/** The session's attachment ended: its answers go. Until no session is left on the machine, its masks still cover
	 * them, as another session's commands may have printed them. */
	release(machineId: string, workerId: string): void {
		const machine = this.#machines.get(machineId);
		const session = machine?.sessions.get(workerId);
		if (!machine || !session) return;
		machine.sessions.delete(workerId);
		if (machine.sessions.size === 0) {
			this.#machines.delete(machineId);
			return;
		}
		for (const value of values(session.commands.values())) machine.released.add(value);
	}

	async #resolve(
		machineId: string,
		scope: CodingEnvironmentScope,
		session: Session,
		request: CodingCommandSecretRequest,
		signal: AbortSignal,
	): Promise<{ environment: Environment; mask(): CodingCommandSecretMask }> {
		this.#check(machineId, scope, request);
		signal.throwIfAborted();
		const answer =
			session.commands.get(request.commandId) ??
			Object.freeze({ ...(await this.#source.environment(scope, signal)) });
		signal.throwIfAborted();
		// A value the mask refuses fails the call before the answer is kept.
		const mask = this.#mask(machineId, scope, session, answer);
		let environment = session.commands.get(request.commandId);
		if (!environment) {
			// The same answer as an earlier command's is kept once.
			environment =
				[...new Set(session.commands.values())].find((kept) => isDeepStrictEqual(kept, answer)) ?? answer;
			session.commands.set(request.commandId, environment);
		}
		return { environment, mask: () => mask.stream() };
	}

	async #output(
		machineId: string,
		scope: CodingEnvironmentScope,
		session: Session,
		request: CodingCommandSecretRequest,
		signal: AbortSignal,
	): Promise<(() => CodingCommandSecretMask) | null> {
		this.#check(machineId, scope, request);
		signal.throwIfAborted();
		const environment = session.commands.get(request.commandId);
		if (!environment || session.differs.has(request.commandId)) return null;
		const mask = this.#mask(machineId, scope, session, environment);
		return () => mask.stream();
	}

	#check(machineId: string, scope: CodingEnvironmentScope, request: CodingCommandSecretRequest): void {
		if (
			request.machineId !== machineId ||
			request.workerId !== scope.workerId ||
			request.companyId !== scope.companyId
		)
			throw new Error("CODING_COMMAND_SECRETS_SCOPE_DIFFERS");
	}

	/** A mask for `environment`'s values and every value kept for the machine. */
	#mask(
		machineId: string,
		scope: CodingEnvironmentScope,
		session: Session,
		environment: Environment,
	): CodingSecretMask {
		const machine = this.#machines.get(machineId);
		// Released (while it asked, or before): nothing is kept or handed out for a session that is gone.
		if (!machine || machine.sessions.get(scope.workerId) !== session)
			throw new Error("CODING_COMMAND_SECRETS_RELEASED");
		const kept = [...machine.sessions.values()].flatMap((other) => [...other.commands.values()]);
		return new CodingSecretMask([...values([environment, ...kept]), ...machine.released]);
	}
}

/** Every value of the environments, once. */
function values(environments: Iterable<Environment>): Set<string> {
	return new Set([...new Set(environments)].flatMap((environment) => Object.values(environment)));
}
