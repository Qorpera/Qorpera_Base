import { setTimeout as delay } from "node:timers/promises";
import { companyComputerRequest } from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	type CompanyComputerStartupIdentity,
	parseCompanyComputerStartupAuthority,
	parseCompanyComputerStartupIdentity,
} from "@qorpera/contracts";
import {
	type HttpCloudCompanyComputerRegistry,
	OfficeComputerMeteringPending,
} from "./cloud-company-computer-registry-http.ts";

/** A service invocation can report readiness, never activate itself. Both
 * listeners stay closed to work while this controller waits for the provider.
 * The first response pins the immutable activation ID for this lifetime. */
export class CompanyComputerStartupControl {
	readonly #identity;
	readonly #registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
	#activationId: string | undefined;
	constructor(identity: CompanyComputerStartupIdentity, registry: Pick<HttpCloudCompanyComputerRegistry, "call">) {
		this.#identity = parseCompanyComputerStartupIdentity(identity);
		this.#registry = registry;
	}
	get identity(): CompanyComputerStartupIdentity {
		return this.#identity;
	}
	async check(signal: AbortSignal) {
		return this.#waitForMetering(
			(checked) => this.#call("qorpera_check_runtime_office_startup", {}, checked),
			signal,
		);
	}
	/** Used only while both listeners remain closed to work. Ordinary effects
	 * fail immediately on a metering gap and are never replayed here. */
	async waitForWorkReady(verify: (signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
		await this.#waitForMetering(verify, signal);
	}
	async #waitForMetering<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
		const deadline = performance.now() + 30000;
		const budget = AbortSignal.timeout(30000);
		const checked = AbortSignal.any([signal, budget]);
		while (true) {
			signal.throwIfAborted();
			try {
				checked.throwIfAborted();
				const result = await operation(checked);
				checked.throwIfAborted();
				return result;
			} catch (error) {
				signal.throwIfAborted();
				if (budget.aborted) throw new Error("OFFICE_STARTUP_METERING_TIMEOUT");
				if (!(error instanceof OfficeComputerMeteringPending)) throw error;
				if (performance.now() >= deadline) throw new Error("OFFICE_STARTUP_METERING_TIMEOUT");
			}
			try {
				await delay(1000, undefined, { signal: checked });
			} catch (error) {
				signal.throwIfAborted();
				if (budget.aborted) throw new Error("OFFICE_STARTUP_METERING_TIMEOUT");
				throw error;
			}
		}
	}
	async #call(
		method: "qorpera_check_runtime_office_startup" | "qorpera_report_runtime_office_ready",
		args: Record<string, unknown>,
		signal: AbortSignal,
	) {
		return companyComputerRequest(
			async (checked) => {
				const started = performance.now();
				const response = await this.#registry.call(
					method,
					{ p_startup: structuredClone(this.#identity), ...args },
					checked,
				);
				const authority = parseCompanyComputerStartupAuthority(response, this.#identity, this.#activationId);
				checked.throwIfAborted();
				if (performance.now() - started >= authority.validForMs)
					throw new Error("OFFICE_STARTUP_AUTHORITY_EXPIRED");
				this.#activationId = authority.activationId;
				return authority;
			},
			signal,
			5000,
		);
	}
	async waitForActivation(
		listeners: { nativePort: number; viewerPort: number },
		verifyPhysical: (signal: AbortSignal) => Promise<void>,
		signal: AbortSignal,
	): Promise<void> {
		if (
			![listeners.nativePort, listeners.viewerPort].every(
				(port) => Number.isSafeInteger(port) && port > 0 && port <= 65535,
			) ||
			listeners.nativePort === listeners.viewerPort
		)
			throw new Error("OFFICE_STARTUP_LISTENERS_UNCONFIRMED");
		if (!this.#activationId) throw new Error("OFFICE_STARTUP_NOT_CHECKED");
		const ports = { ...listeners };
		while (true) {
			signal.throwIfAborted();
			const authority = await this.#waitForMetering(async (checked) => {
				await verifyPhysical(checked);
				checked.throwIfAborted();
				return this.#call(
					"qorpera_report_runtime_office_ready",
					{
						p_activation_id: this.#activationId,
						p_native_port: ports.nativePort,
						p_viewer_port: ports.viewerPort,
					},
					checked,
				);
			}, signal);
			if (authority.state === "prepared") throw new Error("OFFICE_STARTUP_READINESS_UNCONFIRMED");
			if (authority.state === "active") return;
			await delay(1000, undefined, { signal });
		}
	}
}
