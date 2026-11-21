import { isUuid, parseClosedRecord, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";
import {
	type CloudRunLogProtection,
	type CloudRunLogStepClassification,
	type CloudRunLogStepInput,
	CloudRunLogUnavailable,
	cloudRunLogStepPaths,
} from "./cloud-run-log.ts";

/** W1b's lease-scoped host calls. The native host holds the lease credential; this adapter holds no company key. */
export type CloudRunLogProtectionCall = (
	method: "qorpera_memory_step_narrow" | "qorpera_memory_step_hashes",
	args: Readonly<Record<string, unknown>>,
	signal: AbortSignal,
) => Promise<unknown>;

/** The concrete protection port for W1c-3. Bind one instance to one live job/run and route `call` through the native
 * host. SQL checks that lease and the run's environment again on every request. This component does not activate
 * logging; production wiring also needs the folder adapter, origin lookup and resumed-run lifecycle. */
export class CloudRunLogRpcProtection implements CloudRunLogProtection {
	readonly #environmentId: string;
	readonly #jobId: string;
	readonly #runId: string;
	readonly #call: CloudRunLogProtectionCall;

	constructor(options: { environmentId: string; jobId: string; runId: string; call: CloudRunLogProtectionCall }) {
		if (![options.environmentId, options.jobId, options.runId].every(isUuid) || typeof options.call !== "function")
			throw new Error("Invalid run log protection binding");
		this.#environmentId = options.environmentId.toLowerCase();
		this.#jobId = options.jobId.toLowerCase();
		this.#runId = options.runId.toLowerCase();
		this.#call = options.call;
	}

	#assertRun(runId: string, signal: AbortSignal): void {
		signal.throwIfAborted();
		if (runId !== this.#runId) throw new CloudRunLogUnavailable("protection_run_mismatch");
	}

	async #request(
		method: Parameters<CloudRunLogProtectionCall>[0],
		args: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<unknown> {
		try {
			return await cloudToolRequest(
				(requestSignal) =>
					this.#call(
						method,
						{
							p_environment_id: this.#environmentId,
							p_job_id: this.#jobId,
							p_run_id: this.#runId,
							...args,
						},
						requestSignal,
					),
				signal,
			);
		} catch {
			// Never persist RPC messages: they can contain arguments or company paths. No local fallback is safe.
			throw new CloudRunLogUnavailable("protection_unavailable");
		}
	}

	async narrow(
		runId: string,
		step: CloudRunLogStepInput,
		signal: AbortSignal,
	): Promise<CloudRunLogStepClassification> {
		const results = await this.narrowBatch(runId, [step], signal);
		return results[0]!;
	}

	async narrowBatch(
		runId: string,
		steps: readonly CloudRunLogStepInput[],
		signal: AbortSignal,
	): Promise<readonly CloudRunLogStepClassification[]> {
		this.#assertRun(runId, signal);
		if (steps.length === 0) return [];
		const stepPaths: (readonly string[])[] = [];
		for (let index = 0; index < steps.length; index++) {
			const step = steps[index];
			if (!step) throw new CloudRunLogUnavailable("paths_invalid");
			stepPaths.push(cloudRunLogStepPaths(step.argumentsText, step.resultPaths, step.readPaths));
		}
		const uniquePaths: string[] = [];
		const seen = new Set<string>();
		for (const paths of stepPaths) {
			for (const path of paths) {
				if (!seen.has(path)) {
					seen.add(path);
					uniquePaths.push(path);
				}
			}
		}
		let log = false;
		let machine = false;
		const restricted = new Set<string>();
		// WHY: even a batch with no paths must call SQL once to re-read current log and machine flags; each RPC takes at most 1,024 paths.
		for (let offset = 0; offset < Math.max(uniquePaths.length, 1); offset += 1024) {
			const batch = uniquePaths.slice(offset, offset + 1024);
			const value = await this.#request("qorpera_memory_step_narrow", { p_paths: batch }, signal);
			let answer: Record<string, unknown>;
			try {
				answer = parseClosedRecord(value, "Run log classification", ["log", "machine", "restricted"]);
			} catch {
				throw new CloudRunLogUnavailable("protection_response_invalid");
			}
			if (
				typeof answer.log !== "boolean" ||
				typeof answer.machine !== "boolean" ||
				!Array.isArray(answer.restricted)
			)
				throw new CloudRunLogUnavailable("protection_response_invalid");
			// WHY: SQL echoes a subset in input order; reject foreign, duplicate, reordered, or sparse entries rather than trusting malformed output.
			let previous = -1;
			for (let index = 0; index < answer.restricted.length; index++) {
				const path: unknown = answer.restricted[index];
				const found = typeof path === "string" ? batch.indexOf(path, previous + 1) : -1;
				if (found < 0) throw new CloudRunLogUnavailable("protection_response_invalid");
				previous = found;
				restricted.add(path as string);
			}
			log ||= answer.log;
			machine ||= answer.machine;
		}
		return stepPaths.map((paths) => ({
			log,
			narrow: machine || paths.some((path) => restricted.has(path)),
		}));
	}

	async hashes(runId: string, digests: readonly string[], signal: AbortSignal): Promise<readonly string[]> {
		this.#assertRun(runId, signal);
		for (let index = 0; index < digests.length; index++) {
			if (typeof digests[index] !== "string" || !SHA256_HEX_PATTERN.test(digests[index] as string))
				throw new CloudRunLogUnavailable("protection_digests_invalid");
		}
		const result: string[] = [];
		for (let offset = 0; offset < digests.length; offset += 128) {
			const batch = digests.slice(offset, offset + 128);
			const answer = await this.#request("qorpera_memory_step_hashes", { p_digests: batch }, signal);
			if (!Array.isArray(answer) || answer.length !== batch.length)
				throw new CloudRunLogUnavailable("protection_response_invalid");
			for (let index = 0; index < batch.length; index++) {
				const hash: unknown = answer[index];
				if (typeof hash !== "string" || !SHA256_HEX_PATTERN.test(hash))
					throw new CloudRunLogUnavailable("protection_response_invalid");
				result.push(hash);
			}
		}
		return result;
	}
}
