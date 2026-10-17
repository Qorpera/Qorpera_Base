import { isDeepStrictEqual } from "node:util";
import { CodingSecretMask } from "./coding-secret-mask.ts";

// The hook a member coding machine's commands take their secrets through (F3 5g-3c; the broker's side is 5j-4).
// The executor asks once for each command it starts, and again each time it saves more of the command's output.

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

/** The environment a command gets its secrets in, and a mask for its output, which covers every value the
 * environment holds. Each `mask()` is a new stream. A failure fails the call that asked. */
export interface CodingCommandSecrets {
	resolve(
		request: CodingCommandSecretRequest,
		signal: AbortSignal,
	): Promise<{ environment: Readonly<Record<string, string>>; mask(): CodingCommandSecretMask }>;
}

/** No secrets: an empty environment, and a mask that changes nothing. */
export const noCodingCommandSecrets: CodingCommandSecrets = Object.freeze({
	async resolve() {
		return { environment: Object.freeze({}), mask: () => new CodingSecretMask().stream() };
	},
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

/** The secrets of the sessions attached to this executor's machines (5j-4). A command's first `resolve` asks the
 * source, and its later ones (its reads) reuse that answer, so its mask covers the values it started with even if one
 * changes while it runs. A failed ask is not kept. Each mask covers every value resolved for any session still
 * attached to the command's machine: root on the machine reaches them all. A session's answers go when its attachment
 * ends (`release`); a restarted executor asks again at an old command's next read. */
export class CodingMachineCommandSecrets {
	readonly #source: CodingEnvironmentSource;
	/** Per machine, per session, each command's environment. */
	readonly #machines = new Map<string, Map<string, Map<string, Environment>>>();
	constructor(source: CodingEnvironmentSource) {
		this.#source = source;
	}

	/** One session's secrets on its machine, asked for under `scope`, the claim of the call that uses them. */
	session(machineId: string, scope: CodingEnvironmentScope): CodingCommandSecrets {
		const sessions = this.#machines.get(machineId) ?? new Map<string, Map<string, Environment>>();
		this.#machines.set(machineId, sessions);
		const commands = sessions.get(scope.workerId) ?? new Map<string, Environment>();
		sessions.set(scope.workerId, commands);
		const asked = Object.freeze({
			companyId: scope.companyId,
			workerId: scope.workerId,
			leaseToken: scope.leaseToken,
		});
		return { resolve: (request, signal) => this.#resolve(machineId, asked, commands, request, signal) };
	}

	/** The session's attachment ended: its answers go, and its machine's masks no longer cover them. */
	release(machineId: string, workerId: string): void {
		const sessions = this.#machines.get(machineId);
		sessions?.delete(workerId);
		if (sessions?.size === 0) this.#machines.delete(machineId);
	}

	async #resolve(
		machineId: string,
		scope: CodingEnvironmentScope,
		commands: Map<string, Environment>,
		request: CodingCommandSecretRequest,
		signal: AbortSignal,
	): Promise<{ environment: Environment; mask(): CodingCommandSecretMask }> {
		if (
			request.machineId !== machineId ||
			request.workerId !== scope.workerId ||
			request.companyId !== scope.companyId
		)
			throw new Error("CODING_COMMAND_SECRETS_SCOPE_DIFFERS");
		signal.throwIfAborted();
		const answer =
			commands.get(request.commandId) ?? Object.freeze({ ...(await this.#source.environment(scope, signal)) });
		signal.throwIfAborted();
		// Released (while it asked, or before): nothing is kept or handed out for a session that is gone.
		if (this.#machines.get(machineId)?.get(scope.workerId) !== commands)
			throw new Error("CODING_COMMAND_SECRETS_RELEASED");
		// Every value kept for the machine's sessions, and this answer's. A value the mask refuses fails the call before
		// the answer is kept.
		const values = Object.values(answer);
		for (const sessions of this.#machines.get(machineId)?.values() ?? [])
			for (const kept of new Set(sessions.values())) values.push(...Object.values(kept));
		const mask = new CodingSecretMask(values);
		let environment = commands.get(request.commandId);
		if (!environment) {
			// The same answer as an earlier command's is kept once.
			environment = [...new Set(commands.values())].find((kept) => isDeepStrictEqual(kept, answer)) ?? answer;
			commands.set(request.commandId, environment);
		}
		return { environment, mask: () => mask.stream() };
	}
}
