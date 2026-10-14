/// <reference lib="es2024.string" />
import { isUuid, parseClosedRecord, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";
import { type CloudRunLogProtection, CloudRunLogUnavailable, cloudRunLogPaths } from "./cloud-run-log.ts";

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
		step: Parameters<CloudRunLogProtection["narrow"]>[1],
		signal: AbortSignal,
	): Promise<{ readonly log: boolean; readonly narrow: boolean }> {
		this.#assertRun(runId, signal);
		// No clipping: the full arguments, pre-envelope result needles, and all released reads participate. SQL
		// deliberately ignores strings that are not valid company paths. Strip its /company/ prefix before applying
		// the bounds of qorpera_company_path_valid: empty, oversized or control-bearing strings cannot name paths.
		// Unpaired UTF-16 surrogates cannot be PostgreSQL text either. Filter them and NUL before JSONB decoding,
		// which would otherwise refuse the RPC before SQL can ignore the invalid needle, wedging later log steps.
		const needles = [...cloudRunLogPaths(step.argumentsText), ...step.resultPaths, ...step.readPaths];
		if (needles.some((path) => typeof path !== "string"))
			throw new CloudRunLogUnavailable("protection_paths_invalid");
		const paths = [...new Set(needles.map((path) => (path.startsWith("/company/") ? path.slice(9) : path)))].filter(
			(path) =>
				path.length > 0 &&
				path.isWellFormed() &&
				!/[\u0000-\u001f\u007f]/.test(path) &&
				Buffer.byteLength(path) <= 4096,
		);
		let narrow = false;
		let log = false;
		// Even a call with no paths must re-read the log and machine flags. Each RPC accepts at most 1,024 paths.
		for (let offset = 0; offset < Math.max(paths.length, 1); offset += 1024) {
			const batch = paths.slice(offset, offset + 1024);
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
			// SQL echoes a subset in input order. Reject foreign, duplicate, reordered and sparse entries too.
			let previous = -1;
			for (let index = 0; index < answer.restricted.length; index++) {
				const path: unknown = answer.restricted[index];
				const found = typeof path === "string" ? batch.indexOf(path, previous + 1) : -1;
				if (found < 0) throw new CloudRunLogUnavailable("protection_response_invalid");
				previous = found;
			}
			log ||= answer.log;
			narrow ||= answer.machine || answer.restricted.length > 0;
		}
		return { log, narrow };
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
