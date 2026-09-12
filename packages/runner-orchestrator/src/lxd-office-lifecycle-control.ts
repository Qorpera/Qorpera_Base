import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerLifecycleRequest,
	type CompanyComputerLifecycleTransition,
	parseCompanyComputerLifecycleRequest,
	parseCompanyComputerLifecycleTransition,
} from "@qorpera/contracts";

export interface LxdOfficeLifecycleControlRegistry {
	call(
		method: "qorpera_begin_runtime_office_lifecycle" | "qorpera_runtime_office_lifecycle_status",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
/** One durable recovery identity, supplied by the owning provider journal.
 * No retry, stop, reboot, deletion or replacement is performed here. A
 * revocation receipt never establishes that physical work has stopped. */
export class LxdOfficeLifecycleControl {
	readonly #request;
	readonly #registry: LxdOfficeLifecycleControlRegistry;
	#pending = false;
	#receipt: CompanyComputerLifecycleTransition | undefined;
	constructor(request: CompanyComputerLifecycleRequest, registry: LxdOfficeLifecycleControlRegistry) {
		this.#request = parseCompanyComputerLifecycleRequest(request);
		this.#registry = registry;
	}
	begin(signal: AbortSignal) {
		return this.#call("qorpera_begin_runtime_office_lifecycle", signal);
	}
	status(signal: AbortSignal) {
		return this.#call("qorpera_runtime_office_lifecycle_status", signal);
	}
	async #call(
		method: Parameters<LxdOfficeLifecycleControlRegistry["call"]>[0],
		caller: AbortSignal,
	): Promise<CompanyComputerLifecycleTransition> {
		caller.throwIfAborted();
		if (this.#pending) throw new Error("OFFICE_LIFECYCLE_REQUEST_PENDING");
		const signal = AbortSignal.any([caller, AbortSignal.timeout(5000)]),
			started = performance.now();
		this.#pending = true;
		let abort = () => {};
		const stopped = new Promise<never>((_, reject) => {
			abort = () => reject(new Error("OFFICE_LIFECYCLE_REQUEST_UNCONFIRMED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = (async () => {
			signal.throwIfAborted();
			const result = await this.#registry.call(method, { p_request: structuredClone(this.#request) }, signal);
			signal.throwIfAborted();
			if (performance.now() - started >= 5000) throw new Error("expired");
			const receipt = parseCompanyComputerLifecycleTransition(result, this.#request);
			if (this.#receipt && !isDeepStrictEqual(this.#receipt, receipt)) throw new Error("revocation changed");
			this.#receipt = receipt;
			return receipt;
		})()
			.catch((error) => {
				throw new Error("OFFICE_LIFECYCLE_REQUEST_UNCONFIRMED", { cause: error });
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
