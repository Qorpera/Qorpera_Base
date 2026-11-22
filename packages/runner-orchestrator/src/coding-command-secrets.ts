import { createHash } from "node:crypto";
import { CODING_SECRET_MASK_MINIMUM_BYTES, CodingSecretMask } from "./coding-secret-mask.ts";

const MAX_SESSION_COMMANDS = 1024;

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
	readonly vaultEnvVersion?: string;
}

/** A command's secrets. Each `mask()` is a new stream. A failure fails the call that asked. */
export interface CodingCommandSecrets {
	/** At the command's start: the environment it gets its secrets in, and a mask for its output, which covers every
	 * value the environment holds. */
	resolve(
		request: CodingCommandSecretRequest,
		signal: AbortSignal,
	): Promise<{ environment: Readonly<Record<string, string>>; mask(): CodingCommandSecretMask }>;
	/** At each read: the mask for the output of a command whose start the guest `accepted`, or `null` when the values
	 * the command runs with are not known here. Then none of its output may be kept. */
	output(request: CodingCommandSecretRequest, signal: AbortSignal): Promise<(() => CodingCommandSecretMask) | null>;
	/** The guest took the command's start with the environment `resolve` gave. Until then, it may run the command with
	 * another one: an earlier start's. */
	accepted(request: CodingCommandSecretRequest): void;
}

/** No secrets: an empty environment, and a mask that changes nothing. */
export const noCodingCommandSecrets: CodingCommandSecrets = Object.freeze({
	async resolve() {
		return { environment: Object.freeze({}), mask: () => new CodingSecretMask().stream() };
	},
	async output() {
		return () => new CodingSecretMask().stream();
	},
	accepted() {},
});

/** The leased session a vault environment is asked for (5j-4): the company whose secret broker holds it, and the
 * worker and lease the kernel checks before the broker releases anything. */
export interface CodingEnvironmentScope {
	readonly companyId: string;
	readonly workerId: string;
	readonly leaseToken: string;
	readonly vaultEnvVersion?: string;
}

/** A session's environment from the vault. `mask` holds the older values used on the session's machine by its member,
 * from the vault too: masked in the machine's output, never put in an environment. */
export interface CodingEnvironmentAnswer {
	readonly environment: Readonly<Record<string, string>>;
	readonly mask: readonly string[];
}

/** Where a session's environment secrets come from: the company's secret broker (deploy/coding-worker). Each call
 * asks again; a failure fails the call. */
export interface CodingEnvironmentSource {
	environment(scope: CodingEnvironmentScope, signal: AbortSignal): Promise<CodingEnvironmentAnswer>;
}

type Environment = Readonly<Record<string, string>>;

interface CommandRef {
	readonly envHash: string;
	accepted: boolean;
}

interface CachedEnvironment {
	readonly version: string;
	readonly envHash: string;
	readonly environment: Environment;
	readonly history: readonly string[];
}

interface Session {
	readonly commands: Map<string, CommandRef>;
	readonly envByHash: Map<string, Environment>;
	readonly values: Set<string>;
	cached?: CachedEnvironment;
}

interface Machine {
	readonly sessions: Map<string, Session>;
	readonly released: Set<string>;
	readonly history: Set<string>;
	readonly mask: CodingSecretMask;
}

function environmentHash(environment: Environment): string {
	const entries = Object.entries(environment).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function touchSessionCommand(session: Session, commandId: string, ref: CommandRef): void {
	session.commands.delete(commandId);
	session.commands.set(commandId, ref);
}

function recordSessionCommand(session: Session, commandId: string, envHash: string): void {
	const existing = session.commands.get(commandId);
	if (existing) {
		touchSessionCommand(session, commandId, existing);
		return;
	}
	if (session.commands.size >= MAX_SESSION_COMMANDS) {
		const oldest = session.commands.keys().next().value;
		if (oldest !== undefined) session.commands.delete(oldest);
	}
	session.commands.set(commandId, { envHash, accepted: false });
}

/** The secrets of the sessions attached to this executor's machines (5j-4). A command's start asks the source, and
 * its reads' masks cover the values it started with, even if one changes while it runs. A failed ask is not kept.
 * Each mask covers every value resolved for any session attached to the command's machine, and for any released while
 * another stayed: root on the machine reaches them all, and the other's commands may not have had their output kept
 * yet. It also covers the older values the vault's answers name for the machine, so a value from before a rotation and
 * an executor restart is masked too. A machine's values go once its last session is released. A command has no mask
 * until the guest takes the start this process resolved: one that started before the executor did, or whose start's
 * answer was lost or refused, may run with an earlier start's environment. */
export class CodingMachineCommandSecrets {
	readonly #source: CodingEnvironmentSource;
	readonly #machines = new Map<string, Machine>();
	/** The machines with a vault answer in this process since their first session attached. */
	readonly #answered = new Set<string>();
	constructor(source: CodingEnvironmentSource) {
		this.#source = source;
	}

	session(machineId: string, scope: CodingEnvironmentScope): CodingCommandSecrets {
		const session = this.#session(machineId, scope.workerId);
		const asked = Object.freeze({
			companyId: scope.companyId,
			workerId: scope.workerId,
			leaseToken: scope.leaseToken,
			...(scope.vaultEnvVersion === undefined ? {} : { vaultEnvVersion: scope.vaultEnvVersion }),
		});
		return {
			resolve: (request, signal) => this.#resolve(machineId, asked, session, request, signal),
			output: (request, signal) => this.#output(machineId, asked, session, request, signal),
			accepted: (request) => {
				this.#check(machineId, asked, request);
				const ref = session.commands.get(request.commandId);
				if (ref) {
					ref.accepted = true;
					touchSessionCommand(session, request.commandId, ref);
				}
			},
		};
	}

	/** What the session's publication is checked against (5j-5 b): its environment asked again now, which no command
	 * keeps, the older values that answer names, and every value kept for the machine, as a command's mask has. So a
	 * value added since its commands started is in, and one removed since. A failed ask fails the publication. */
	async publication(machineId: string, scope: CodingEnvironmentScope, signal: AbortSignal): Promise<CodingSecretMask> {
		const session = this.#session(machineId, scope.workerId);
		const asked = Object.freeze({
			companyId: scope.companyId,
			workerId: scope.workerId,
			leaseToken: scope.leaseToken,
		});
		signal.throwIfAborted();
		const answer = await this.#source.environment(asked, signal);
		signal.throwIfAborted();
		const machine = this.#activeMachine(machineId, asked, session);
		const envValues = Object.values(answer.environment);
		checkMaskValues(envValues);
		checkMaskValues(answer.mask);
		// WHY: Publication's own environment values are not kept on the machine, so they are added only to a clone.
		for (const value of answer.mask) {
			machine.history.add(value);
			machine.mask.add(value);
		}
		const mask = machine.mask.clone();
		for (const value of envValues) mask.add(value);
		return mask;
	}

	release(machineId: string, workerId: string): void {
		const machine = this.#machines.get(machineId);
		const session = machine?.sessions.get(workerId);
		if (!machine || !session) return;
		session.cached = undefined;
		machine.sessions.delete(workerId);
		if (machine.sessions.size === 0) {
			this.#machines.delete(machineId);
			this.#answered.delete(machineId);
			return;
		}
		for (const value of session.values) machine.released.add(value);
	}

	// WHY: Every attachment on the machine already ended in SQL; like an executor restart, the next attach asks the vault again.
	releaseMachine(machineId: string): void {
		this.#machines.delete(machineId);
		this.#answered.delete(machineId);
	}

	/** The session attached (5j-5 (a)): its environment is asked for now, under `scope`, so the machine's values are
	 * known before a command starts with them, also when there are none. No command takes this answer; the machine's
	 * masks cover it, as its older values. A failed ask is not kept and fails the call. */
	async attached(machineId: string, scope: CodingEnvironmentScope, signal: AbortSignal): Promise<void> {
		const session = this.#session(machineId, scope.workerId);
		const asked = Object.freeze({
			companyId: scope.companyId,
			workerId: scope.workerId,
			leaseToken: scope.leaseToken,
		});
		signal.throwIfAborted();
		const answer = await this.#source.environment(asked, signal);
		signal.throwIfAborted();
		const machine = this.#activeMachine(machineId, asked, session);
		const kept = [...Object.values(answer.environment), ...answer.mask];
		// A value the mask refuses fails the call before the answer is kept, as does a release while it asked.
		checkMaskValues(kept);
		for (const value of kept) {
			machine.history.add(value);
			machine.mask.add(value);
		}
		this.#answered.add(machineId);
	}

	values(machineId: string): string[] | undefined {
		const machine = this.#machines.get(machineId);
		if (!machine || !this.#answered.has(machineId)) return undefined;
		const combined = new Set<string>([...machine.released, ...machine.history]);
		for (const session of machine.sessions.values()) {
			for (const value of session.values) combined.add(value);
		}
		return [...combined];
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
		const existing = session.commands.get(request.commandId);
		if (existing) {
			const environment = session.envByHash.get(existing.envHash);
			if (environment) {
				touchSessionCommand(session, request.commandId, existing);
				const machine = this.#activeMachine(machineId, scope, session);
				this.#answered.add(machineId);
				const mask = machine.mask;
				return { environment, mask: () => mask.stream() };
			}
		}
		const version = request.vaultEnvVersion ?? scope.vaultEnvVersion;
		let environment: Environment;
		let envHash: string;
		let history: readonly string[];
		let fromCache = false;
		if (version !== undefined && session.cached?.version === version) {
			environment = session.cached.environment;
			envHash = session.cached.envHash;
			history = session.cached.history;
			fromCache = true;
		} else {
			if (version !== undefined) session.cached = undefined;
			const asked = await this.#source.environment(scope, signal);
			const frozen = Object.freeze({ ...asked.environment });
			envHash = environmentHash(frozen);
			environment = session.envByHash.get(envHash) ?? frozen;
			history = Object.freeze([...asked.mask]);
		}
		signal.throwIfAborted();
		const machine = this.#activeMachine(machineId, scope, session);
		if (!fromCache) {
			const envValues = Object.values(environment);
			checkMaskValues(envValues);
			checkMaskValues(history);
			for (const value of history) {
				machine.history.add(value);
				machine.mask.add(value);
			}
			for (const value of envValues) {
				session.values.add(value);
				machine.mask.add(value);
			}
			session.envByHash.set(envHash, environment);
			if (version !== undefined) {
				session.cached = { version, envHash, environment, history };
			}
		}
		const raced = session.commands.get(request.commandId);
		if (raced) {
			const kept = session.envByHash.get(raced.envHash);
			if (kept) environment = kept;
		} else {
			recordSessionCommand(session, request.commandId, envHash);
		}
		this.#answered.add(machineId);
		const mask = machine.mask;
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
		const ref = session.commands.get(request.commandId);
		if (!ref || !ref.accepted) return null;
		touchSessionCommand(session, request.commandId, ref);
		const machine = this.#activeMachine(machineId, scope, session);
		const mask = machine.mask;
		return () => mask.stream();
	}

	#session(machineId: string, workerId: string): Session {
		const machine: Machine = this.#machines.get(machineId) ?? {
			sessions: new Map<string, Session>(),
			released: new Set<string>(),
			history: new Set<string>(),
			mask: new CodingSecretMask(),
		};
		this.#machines.set(machineId, machine);
		const session: Session = machine.sessions.get(workerId) ?? {
			commands: new Map<string, CommandRef>(),
			envByHash: new Map<string, Environment>(),
			values: new Set<string>(),
		};
		machine.sessions.set(workerId, session);
		return session;
	}

	#check(machineId: string, scope: CodingEnvironmentScope, request: CodingCommandSecretRequest): void {
		if (
			request.machineId !== machineId ||
			request.workerId !== scope.workerId ||
			request.companyId !== scope.companyId
		)
			throw new Error("CODING_COMMAND_SECRETS_SCOPE_DIFFERS");
	}

	#activeMachine(machineId: string, scope: CodingEnvironmentScope, session: Session): Machine {
		const machine = this.#machines.get(machineId);
		// Released (while it asked, or before): nothing is kept or handed out for a session that is gone.
		if (!machine || machine.sessions.get(scope.workerId) !== session)
			throw new Error("CODING_COMMAND_SECRETS_RELEASED");
		return machine;
	}
}

function checkMaskValues(candidates: Iterable<string>): void {
	for (const value of candidates) {
		if (Buffer.byteLength(value, "utf8") < CODING_SECRET_MASK_MINIMUM_BYTES) {
			throw new RangeError(`a coding secret shorter than ${CODING_SECRET_MASK_MINIMUM_BYTES} bytes can't be masked`);
		}
	}
}
