import {
	type CompanyComputerOutageSuccessor,
	type CompanyComputerOutageSuccessorRequest,
	parseCompanyComputerOutageSuccessor,
	parseCompanyComputerOutageSuccessorAuthority,
	parseCompanyComputerOutageSuccessorRequest,
} from "@qorpera/contracts";

export interface LxdOfficeOutageSuccessorRegistry {
	call(
		method:
			| "qorpera_prepare_runtime_office_outage_successor"
			| "qorpera_runtime_office_outage_successor_status"
			| "qorpera_check_runtime_office_outage_successor"
			| "qorpera_activate_runtime_office_outage_successor",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
/** Provider-only handoff for a distinct boot after acknowledged abrupt termination.
 * Caller persists request before prepare and verifies retained root history,
 * fresh paid boot, acknowledged abrupt termination and root startup independently,
 * and supplies one fresh end-to-end inspection deadline to activate. Metadata
 * recovery cannot itself start a service, release capacity or renew readiness. */
export class LxdOfficeOutageSuccessorControl {
	readonly #request;
	readonly #registry: LxdOfficeOutageSuccessorRegistry;
	#pending = false;
	#previous: CompanyComputerOutageSuccessor | undefined;
	constructor(request: CompanyComputerOutageSuccessorRequest, registry: LxdOfficeOutageSuccessorRegistry) {
		this.#request = parseCompanyComputerOutageSuccessorRequest(request);
		this.#registry = registry;
	}
	prepare(signal: AbortSignal) {
		return this.#call("qorpera_prepare_runtime_office_outage_successor", {}, signal);
	}
	status(signal: AbortSignal) {
		return this.#call("qorpera_runtime_office_outage_successor_status", {}, signal);
	}
	/** Metadata status is not dispatch authority. This separate check revalidates
	 * current SQL state and gives the caller only the remaining authority window. */
	async check(caller: AbortSignal) {
		const deadline = performance.now() + 5000;
		const successor = await this.#call("qorpera_check_runtime_office_outage_successor", {}, caller, deadline);
		const validForMs = Math.floor(deadline - performance.now());
		if (validForMs < 1) throw new Error("OFFICE_OUTAGE_SUCCESSOR_REQUEST_EXPIRED");
		caller.throwIfAborted();
		return { successor, validForMs, signal: AbortSignal.any([caller, AbortSignal.timeout(validForMs)]) };
	}
	activate(serviceInvocationId: string, inspectionDeadline: number, signal: AbortSignal) {
		if (
			typeof serviceInvocationId !== "string" ||
			!/^(?!0{32}$)[0-9a-f]{32}$/.test(serviceInvocationId) ||
			!Number.isFinite(inspectionDeadline) ||
			inspectionDeadline <= performance.now() ||
			inspectionDeadline > performance.now() + 5000
		)
			throw new Error("OFFICE_OUTAGE_SUCCESSOR_INSPECTION_UNCONFIRMED");
		return this.#call(
			"qorpera_activate_runtime_office_outage_successor",
			{ serviceInvocationId },
			signal,
			inspectionDeadline,
			serviceInvocationId,
		);
	}
	async #call(
		method: Parameters<LxdOfficeOutageSuccessorRegistry["call"]>[0],
		args: Record<string, unknown>,
		caller: AbortSignal,
		deadline = performance.now() + 5000,
		expectedInvocation?: string,
	) {
		caller.throwIfAborted();
		if (this.#pending) throw new Error("OFFICE_OUTAGE_SUCCESSOR_REQUEST_PENDING");
		const remaining = Math.ceil(Math.min(5000, deadline - performance.now()));
		if (remaining < 1) throw new Error("OFFICE_OUTAGE_SUCCESSOR_REQUEST_EXPIRED");
		const signal = AbortSignal.any([caller, AbortSignal.timeout(remaining)]);
		this.#pending = true;
		let abort = () => {};
		const stopped = new Promise<never>((_, reject) => {
			abort = () => reject(new Error("OFFICE_OUTAGE_SUCCESSOR_REQUEST_UNCONFIRMED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = (async () => {
			signal.throwIfAborted();
			const value = await this.#registry.call(
				method,
				structuredClone({
					p_request: expectedInvocation === undefined ? this.#request : { successor: this.#request, ...args },
				}),
				signal,
			);
			signal.throwIfAborted();
			if (performance.now() >= deadline) throw new Error("expired");
			const result =
					method === "qorpera_check_runtime_office_outage_successor"
						? parseCompanyComputerOutageSuccessorAuthority(value, this.#request).successor
						: parseCompanyComputerOutageSuccessor(value, this.#request),
				previous = this.#previous;
			const rank = { prepared: 0, ready: 1, active: 2 };
			if (
				(expectedInvocation !== undefined &&
					(result.state !== "active" || result.serviceInvocationId !== expectedInvocation)) ||
				(previous &&
					(rank[result.state] < rank[previous.state] ||
						(previous.serviceInvocationId !== null &&
							previous.serviceInvocationId !== result.serviceInvocationId) ||
						previous.officeRevision !== result.officeRevision ||
						previous.privacyVersion !== result.privacyVersion))
			)
				throw new Error("successor changed");
			this.#previous = result;
			return result;
		})()
			.catch((error) => {
				throw new Error("OFFICE_OUTAGE_SUCCESSOR_REQUEST_UNCONFIRMED", { cause: error });
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
