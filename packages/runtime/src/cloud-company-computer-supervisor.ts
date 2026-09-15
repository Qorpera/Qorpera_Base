import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	companyComputerRequest,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import { parseCompanyComputerPrivacyChallenge } from "@qorpera/cloud-client/cloud-company-computer-privacy";
import type { CompanyComputerDrainChallenge, CompanyComputerDrainSupervisor } from "./cloud-company-computer-drain.ts";
import type { CompanyComputerPrivacySupervisor } from "./cloud-company-computer-privacy.ts";
import type { CompanyComputerViewerConnections } from "./cloud-company-computer-viewer-gateway.ts";

export interface CompanyComputerSupervisorRegistry {
	call(
		method: "qorpera_runtime_office_supervisor_status",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
function keys(value: unknown, expected: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== expected)
		throw new Error("INVALID_OFFICE_SUPERVISOR_STATE");
}
function positive(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}
/** Never invoke getters or stringifiers on an error while classifying it. */
function data(value: unknown, key: string): unknown {
	try {
		if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}
const transportCodes = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EPIPE",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
]);
/** A status poll whose outcome is unknown at the transport level: the request
 * deadline (COMPUTER_REQUEST_STOPPED, contract §12 cloud operations continue
 * independently of every member client) or a socket failure below the
 * registry boundary. An authority refusal (`denied`), a malformed body, an
 * inactive office (OFFICE_SERVICE_UNAVAILABLE) or invalid state is a confirmed
 * answer and never counts as transport-unconfirmed. */
function transportUnconfirmed(error: unknown): boolean {
	const message = data(error, "message");
	if (message !== "OFFICE_REGISTRY_UNCONFIRMED" && message !== "COMPUTER_REQUEST_STOPPED") return false;
	let current: unknown = error;
	for (let depth = 0; current && depth < 4; depth++) {
		if (data(current, "message") === "COMPUTER_REQUEST_STOPPED") return true;
		if (transportCodes.has(data(current, "code") as string)) return true;
		current = data(current, "cause");
	}
	return false;
}
/** Consecutive transport-unconfirmed status polls tolerated before the
 * fail-closed path runs: about fifteen polls at the 1 s cadence with the 5 s
 * per-request deadline. Measured on the wall clock from the first unconfirmed
 * poll; a confirmed poll resets it. */
export const COMPANY_COMPUTER_SUPERVISOR_STALE_BUDGET_MS = 90_000;
const stale: unique symbol = Symbol("stale");

/** The long-lived runtime calls reconcile independently of every member client.
 * Reads durable transitions/expiry, fences actual viewer streams first, then
 * delegates physical drain/privacy work to the shared guest supervisors. A
 * restored already-private state installs its barrier without replaying entry
 * preparation over a member's current sign-in browser. */
export class CompanyComputerOfficeSupervisor {
	readonly #scope: CompanyComputerScope;
	readonly #generation: number;
	readonly #control: CompanyComputerSupervisorRegistry;
	readonly #viewers: Pick<CompanyComputerViewerConnections, "fencePrivacy" | "fenceScreen" | "close">;
	readonly #drains: Pick<CompanyComputerDrainSupervisor, "drain">;
	readonly #privacy: Pick<CompanyComputerPrivacySupervisor, "transition">;
	#active: Promise<void> | undefined;
	#revision = 0;
	#privacyVersion = 0;
	#failed = false;
	#running = false;
	#unconfirmedSince: number | undefined;
	#unconfirmedPolls = 0;

	constructor(options: {
		scope: CompanyComputerScope;
		computerGeneration: number;
		control: CompanyComputerSupervisorRegistry;
		viewers: Pick<CompanyComputerViewerConnections, "fencePrivacy" | "fenceScreen" | "close">;
		drains: Pick<CompanyComputerDrainSupervisor, "drain">;
		privacy: Pick<CompanyComputerPrivacySupervisor, "transition">;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		if (!positive(options.computerGeneration)) throw new Error("INVALID_OFFICE_GENERATION");
		this.#scope = Object.freeze({ ...options.scope });
		this.#generation = options.computerGeneration;
		this.#control = options.control;
		this.#viewers = options.viewers;
		this.#drains = options.drains;
		this.#privacy = options.privacy;
	}

	/** One status poll. A transport-unconfirmed poll after at least one confirmed
	 * reconciliation keeps the last confirmed state, performs no physical effect
	 * and is retried on the next tick (contract §19 observability: an uncertain
	 * interval stays visible through `unconfirmedSince`, never reported healthy).
	 * The first reconciliation, an aborted lifetime, an authority refusal, an
	 * invalid body and an exhausted budget all keep the fail-closed path. */
	async #poll(signal: AbortSignal): Promise<unknown> {
		try {
			return await companyComputerRequest(
				(s) =>
					this.#control.call(
						"qorpera_runtime_office_supervisor_status",
						{ p_scope: this.#scope, p_computer_generation: this.#generation },
						s,
					),
				signal,
			);
		} catch (error) {
			if (this.#revision === 0 || signal.aborted || !transportUnconfirmed(error)) throw error;
			const now = Date.now();
			this.#unconfirmedSince ??= now;
			this.#unconfirmedPolls++;
			const unconfirmedMs = Math.max(0, now - this.#unconfirmedSince);
			if (unconfirmedMs < COMPANY_COMPUTER_SUPERVISOR_STALE_BUDGET_MS) return stale;
			throw Object.assign(new Error("OFFICE_SUPERVISOR_STATUS_STALE", { cause: error }), {
				unconfirmedPolls: this.#unconfirmedPolls,
				unconfirmedMs,
			});
		}
	}

	async #reconcile(signal: AbortSignal): Promise<void> {
		if (this.#failed) throw new Error("OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
		try {
			const value = await this.#poll(signal);
			if (value === stale) return;
			keys(value, "computerGeneration,drains,privacyChallenge,privacyState,privacyVersion,revision,scope,state");
			keys(value.scope, "companyComputerId,companyId,environmentId,logicalComputerId");
			assertCompanyComputerScope(value.scope as unknown as CompanyComputerScope, this.#scope);
			if (
				value.computerGeneration !== this.#generation ||
				!positive(value.revision) ||
				value.revision < this.#revision ||
				!Number.isSafeInteger(value.privacyVersion) ||
				(value.privacyVersion as number) < this.#privacyVersion ||
				!["shared", "entering", "private", "leaving"].includes(value.privacyState as string) ||
				!["provisioning", "active", "maintenance", "recovering", "retired"].includes(value.state as string) ||
				!Array.isArray(value.drains) ||
				value.drains.length > 32
			)
				throw new Error("INVALID_OFFICE_SUPERVISOR_STATE");
			const challenge =
				value.privacyChallenge === null
					? null
					: parseCompanyComputerPrivacyChallenge(value.privacyChallenge, this.#scope);
			// Without a retained challenge the office must be shared; the version may
			// be positive when a retired generation's challenge was cleared by the
			// provider's correction path (the monotonic check above still holds).
			if (
				(!challenge && value.privacyState !== "shared") ||
				(challenge &&
					(challenge.computerGeneration !== this.#generation ||
						challenge.version !== value.privacyVersion ||
						(challenge.state === "entering"
							? !["entering", "private"].includes(value.privacyState as string)
							: !["leaving", "shared"].includes(value.privacyState as string))))
			)
				throw new Error("INVALID_OFFICE_SUPERVISOR_STATE");
			const screens = new Set<string>();
			const ordinals = new Set<number>();
			const drains = value.drains.map((drain): CompanyComputerDrainChallenge => {
				keys(drain, "binding,drainId,epoch,state");
				keys(
					drain.binding,
					"companyComputerId,companyId,computerGeneration,environmentId,logicalComputerId,screenGeneration,screenId,screenOrdinal,staffAgentId",
				);
				const parsed = drain as unknown as CompanyComputerDrainChallenge;
				assertCompanyComputerScope(parsed.binding, this.#scope);
				assertCompanyComputerScreenBinding(parsed.binding, parsed.binding);
				if (
					parsed.state !== "draining" ||
					!COMPANY_COMPUTER_UUID.test(parsed.drainId) ||
					!positive(parsed.epoch) ||
					parsed.binding.computerGeneration !== this.#generation ||
					screens.has(parsed.binding.screenId) ||
					ordinals.has(parsed.binding.screenOrdinal)
				)
					throw new Error("INVALID_OFFICE_SUPERVISOR_STATE");
				screens.add(parsed.binding.screenId);
				ordinals.add(parsed.binding.screenOrdinal);
				return structuredClone(parsed);
			});
			this.#revision = value.revision;
			this.#privacyVersion = value.privacyVersion as number;
			this.#unconfirmedSince = undefined;
			this.#unconfirmedPolls = 0;
			// All stream barriers precede every physical side effect. SQL alone
			// cannot erase pixels or cancel an already-running process.
			if (challenge) await this.#viewers.fencePrivacy(challenge, signal);
			for (const drain of drains) await this.#viewers.fenceScreen(drain, signal);
			if (value.state !== "active") {
				await this.#viewers.close();
				return;
			}
			if (value.privacyState === "entering" || value.privacyState === "leaving") {
				await this.#privacy.transition(challenge!, signal);
			} else {
				for (const drain of drains) await this.#drains.drain(drain, signal);
			}
		} catch (error) {
			this.#failed = true;
			await this.#viewers.close();
			throw new Error("OFFICE_SUPERVISOR_RECONCILIATION_FAILED", { cause: error });
		}
	}

	/** Wall-clock time of the first poll in the current transport-unconfirmed
	 * gap, or `undefined` while the latest poll confirmed the durable state.
	 * Admission gates consult this to refuse new work on stale state. */
	get unconfirmedSince(): number | undefined {
		return this.#unconfirmedSince;
	}
	get unconfirmedPolls(): number {
		return this.#unconfirmedPolls;
	}
	/** New viewer admission and new native work require a currently confirmed
	 * durable state (contract §11.2: every effect is checked against the
	 * current grant and resource scope, never against a stale observation). */
	assertConfirmed(): void {
		if (this.#failed) throw new Error("OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
		if (this.#unconfirmedSince !== undefined) throw new Error("OFFICE_SUPERVISOR_STATUS_STALE");
	}

	/** Concurrent callers share one attempt. Failure requires service recovery;
	 * it never silently reopens viewer admission or retries ambiguous effects. */
	reconcile(signal: AbortSignal): Promise<void> {
		if (!this.#active) {
			this.#active = companyComputerRequest((s) => this.#reconcile(s), signal, 30000).finally(() => {
				this.#active = undefined;
			});
		}
		const active = this.#active;
		return companyComputerRequest(() => active, signal, 30000);
	}

	/** Host service lifetime. Never driven by a viewer window. Unexpected state
	 * or physical failure terminates supervision with viewer admission closed.
	 * A transport-unconfirmed poll only pauses new admission until the next
	 * confirmed poll or the stale budget (see `#poll`); the cadence is fixed. */
	async run(signal: AbortSignal): Promise<void> {
		if (this.#running) throw new Error("OFFICE_SUPERVISOR_ALREADY_RUNNING");
		this.#running = true;
		try {
			while (!signal.aborted) {
				await this.reconcile(signal);
				await new Promise<void>((resolve) => {
					const done = (): void => {
						clearTimeout(timer);
						signal.removeEventListener("abort", done);
						resolve();
					};
					const timer = setTimeout(done, 1000);
					signal.addEventListener("abort", done, { once: true });
					if (signal.aborted) done();
				});
			}
		} catch (error) {
			if (!signal.aborted) throw error;
		} finally {
			this.#failed = true;
			await this.#viewers.close();
		}
	}
}
