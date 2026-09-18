import {
	type CompanyComputerBootIntent,
	type CompanyComputerBootIntentRequest,
	parseCompanyComputerBootIntent,
	parseCompanyComputerBootIntentRequest,
} from "@qorpera/contracts";

export interface LxdOfficeBootIntentRegistry {
	call(
		method:
			| "qorpera_reserve_runtime_node_machine"
			| "qorpera_prepare_runtime_office_boot_intent"
			| "qorpera_runtime_office_boot_intent_status"
			| "qorpera_check_runtime_office_boot_intent",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
/** Provider-only pre-boot authority. Persist the explicit request before
 * prepare. Status/prepare recover metadata only. Check must precede each
 * physical dispatch; verify shutdown/history and submit within its remaining
 * window, under the retained operation journal/host lock. Never retry an
 * unknown VM submission. An admitted intent cannot authorize another boot. */
export class LxdOfficeBootIntentControl {
	readonly #request;
	readonly #registry: LxdOfficeBootIntentRegistry;
	#pending = false;
	#previous: CompanyComputerBootIntent | undefined;
	constructor(request: CompanyComputerBootIntentRequest, registry: LxdOfficeBootIntentRegistry) {
		this.#request = parseCompanyComputerBootIntentRequest(request);
		this.#registry = registry;
	}
	prepare(signal: AbortSignal) {
		return this.#call("qorpera_prepare_runtime_office_boot_intent", signal);
	}
	status(signal: AbortSignal) {
		return this.#call("qorpera_runtime_office_boot_intent_status", signal);
	}
	async check(caller: AbortSignal) {
		const deadline = performance.now() + 5000;
		const intent = await this.#call("qorpera_check_runtime_office_boot_intent", caller, deadline);
		const validForMs = Math.floor(deadline - performance.now());
		if (validForMs < 1) throw new Error("OFFICE_BOOT_INTENT_REQUEST_EXPIRED");
		caller.throwIfAborted();
		return { intent, validForMs, signal: AbortSignal.any([caller, AbortSignal.timeout(validForMs)]) };
	}
	async #call(
		method: Parameters<LxdOfficeBootIntentRegistry["call"]>[0],
		caller: AbortSignal,
		deadline = performance.now() + 5000,
	) {
		caller.throwIfAborted();
		if (this.#pending) throw new Error("OFFICE_BOOT_INTENT_REQUEST_PENDING");
		const remaining = Math.ceil(Math.min(5000, deadline - performance.now()));
		if (remaining < 1) throw new Error("OFFICE_BOOT_INTENT_REQUEST_EXPIRED");
		const signal = AbortSignal.any([caller, AbortSignal.timeout(remaining)]);
		this.#pending = true;
		let abort = () => {};
		const stopped = new Promise<never>((_, reject) => {
			abort = () => reject(new Error("OFFICE_BOOT_INTENT_REQUEST_UNCONFIRMED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = (async () => {
			signal.throwIfAborted();
			const value = await this.#registry.call(method, structuredClone({ p_request: this.#request }), signal);
			signal.throwIfAborted();
			if (performance.now() >= deadline) throw new Error("expired");
			const result = parseCompanyComputerBootIntent(value, this.#request),
				previous = this.#previous;
			if (
				(method === "qorpera_check_runtime_office_boot_intent" && result.state !== "prepared") ||
				(previous &&
					((previous.state === "admitted" && result.state !== "admitted") ||
						previous.stopAcknowledgedAtMs !== result.stopAcknowledgedAtMs ||
						previous.officeRevision !== result.officeRevision ||
						previous.privacyVersion !== result.privacyVersion))
			)
				throw new Error("intent changed");
			this.#previous = result;
			return result;
		})()
			.catch((error) => {
				throw new Error("OFFICE_BOOT_INTENT_REQUEST_UNCONFIRMED", { cause: error });
			})
			.finally(() => {
				this.#pending = false;
			});
		try {
			return await Promise.race([operation, stopped]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
}
