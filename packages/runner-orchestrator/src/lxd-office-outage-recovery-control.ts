import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerOutageRecovery,
	type CompanyComputerOutageRecoveryRequest,
	parseCompanyComputerOutageRecovery,
	parseCompanyComputerOutageRecoveryAuthority,
	parseCompanyComputerOutageRecoveryRequest,
} from "@qorpera/contracts";

export const OFFICE_OUTAGE_RECOVERY_RPCS = [
	"qorpera_prepare_runtime_office_outage_recovery",
	"qorpera_check_runtime_office_outage_recovery",
	"qorpera_runtime_office_outage_recovery_status",
] as const;
export interface LxdOfficeOutageRecoveryRegistry {
	call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

/** A worker cannot surrender its physical/kernel lane while an RPC that may
 * have committed still ignores cancellation. Controls may return a timeout,
 * but the containing worker settles this scope before releasing ownership. */
export function trackLxdOfficeOutageRegistry(source: LxdOfficeOutageRecoveryRegistry) {
	const io = new Set<Promise<unknown>>();
	const registry: LxdOfficeOutageRecoveryRegistry = {
		call(method, args, signal) {
			const work = Promise.resolve().then(() => {
				signal.throwIfAborted();
				return source.call(method, args, signal);
			});
			io.add(work);
			void work.then(
				() => io.delete(work),
				() => io.delete(work),
			);
			return work;
		},
	};
	return { registry, settle: () => Promise.allSettled([...io]) };
}

/** Recoverable preparation never authorizes VM dispatch. Each effect needs a
 * fresh short check, bound to the exact immutable revision/privacy snapshot.
 * A timeout does not release ownership of an uncooperative RPC. */
export class LxdOfficeOutageRecoveryControl {
	readonly #request: CompanyComputerOutageRecoveryRequest;
	readonly #registry: LxdOfficeOutageRecoveryRegistry;
	#pending = false;
	#previous: CompanyComputerOutageRecovery | undefined;
	constructor(request: CompanyComputerOutageRecoveryRequest, registry: LxdOfficeOutageRecoveryRegistry) {
		this.#request = parseCompanyComputerOutageRecoveryRequest(request);
		this.#registry = registry;
	}
	prepare(signal: AbortSignal) {
		return this.#call("qorpera_prepare_runtime_office_outage_recovery", signal);
	}
	status(signal: AbortSignal) {
		return this.#call("qorpera_runtime_office_outage_recovery_status", signal);
	}
	async check(caller: AbortSignal) {
		const started = performance.now();
		const recovery = await this.#call("qorpera_check_runtime_office_outage_recovery", caller);
		const validForMs = Math.floor(5000 - (performance.now() - started));
		if (validForMs < 1) throw new Error("OFFICE_OUTAGE_RECOVERY_AUTHORITY_EXPIRED");
		caller.throwIfAborted();
		return { recovery, validForMs, signal: AbortSignal.any([caller, AbortSignal.timeout(validForMs)]) };
	}
	async #call(method: (typeof OFFICE_OUTAGE_RECOVERY_RPCS)[number], caller: AbortSignal) {
		caller.throwIfAborted();
		if (this.#pending) throw new Error("OFFICE_OUTAGE_RECOVERY_REQUEST_PENDING");
		const deadline = performance.now() + 5000,
			signal = AbortSignal.any([caller, AbortSignal.timeout(5000)]);
		this.#pending = true;
		let abort = () => {};
		const cancelled = new Promise<never>((_, reject) => {
			abort = () => reject(new Error("OFFICE_OUTAGE_RECOVERY_REQUEST_UNCONFIRMED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = (async () => {
			const raw = await this.#registry.call(method, { p_request: structuredClone(this.#request) }, signal);
			signal.throwIfAborted();
			if (performance.now() >= deadline) throw new Error("expired");
			const receipt =
				method === "qorpera_check_runtime_office_outage_recovery"
					? parseCompanyComputerOutageRecoveryAuthority(raw, this.#request).recovery
					: parseCompanyComputerOutageRecovery(raw, this.#request);
			if (this.#previous && !isDeepStrictEqual(this.#previous, receipt)) throw new Error("snapshot changed");
			this.#previous = receipt;
			return receipt;
		})()
			.catch(() => {
				throw new Error("OFFICE_OUTAGE_RECOVERY_REQUEST_UNCONFIRMED");
			})
			.finally(() => {
				this.#pending = false;
			});
		try {
			return await Promise.race([operation, cancelled]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
}
