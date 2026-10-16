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
