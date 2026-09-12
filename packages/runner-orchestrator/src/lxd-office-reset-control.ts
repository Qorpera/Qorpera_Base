import {
	COMPANY_COMPUTER_RESET_PHASES,
	type CompanyComputerResetChallengePhase,
	type CompanyComputerResetPhaseChallenge,
	type CompanyComputerResetPhaseEvidence,
	type CompanyComputerResetPlan,
	type CompanyComputerResetStatus,
	type CompanyComputerResetSuccessor,
	type CompanyComputerResetSuccessorRequest,
	parseCompanyComputerResetPhaseChallenge,
	parseCompanyComputerResetPhaseEvidence,
	parseCompanyComputerResetPlan,
	parseCompanyComputerResetStatus,
	parseCompanyComputerResetSuccessor,
	parseCompanyComputerResetSuccessorRequest,
} from "@qorpera/contracts";
import { officeSha } from "./lxd-office-image-provenance.ts";

export interface LxdOfficeResetRegistry {
	call(
		method:
			| "qorpera_begin_runtime_office_reset"
			| "qorpera_runtime_office_reset_status"
			| "qorpera_prepare_runtime_office_reset_phase"
			| "qorpera_check_runtime_office_reset_phase"
			| "qorpera_ack_runtime_office_reset_phase",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function bounded<T>(
	method: string,
	pending: { value: boolean },
	caller: AbortSignal,
	deadline: number,
	operation: (signal: AbortSignal) => Promise<T>,
	code: string,
): Promise<T> {
	caller.throwIfAborted();
	if (pending.value) throw new Error(`${code}_PENDING`);
	const remaining = Math.ceil(Math.min(5000, deadline - performance.now()));
	if (remaining < 1) throw new Error(`${code}_EXPIRED`);
	const signal = AbortSignal.any([caller, AbortSignal.timeout(remaining)]);
	pending.value = true;
	let abort = () => {};
	const stopped = new Promise<never>((_, reject) => {
		abort = () => reject(new Error(`${code}_UNCONFIRMED`));
		signal.addEventListener("abort", abort, { once: true });
	});
	const work = (async () => {
		signal.throwIfAborted();
		const value = await operation(signal);
		signal.throwIfAborted();
		if (performance.now() >= deadline) throw new Error(`expired ${method}`);
		return value;
	})()
		.catch((error) => {
			throw new Error(`${code}_UNCONFIRMED`, { cause: error });
		})
		.finally(() => {
			pending.value = false;
		});
	try {
		return await Promise.race([work, stopped]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

/** Provider-only reset authority adapter. The plan is retained by the caller
 * before begin. Status is historical metadata; each destructive or new-boot
 * dispatch needs a fresh phase challenge whose remaining five-second window
 * is deducted from RPC latency. Metadata recovery never repeats a dispatch. */
export class LxdOfficeResetControl {
	readonly #plan: CompanyComputerResetPlan;
	readonly #planSha256: string;
	readonly #registry: LxdOfficeResetRegistry;
	readonly #pending = { value: false };
	#previous: CompanyComputerResetStatus | undefined;
	constructor(plan: CompanyComputerResetPlan, planSha256: string, registry: LxdOfficeResetRegistry) {
		this.#plan = parseCompanyComputerResetPlan(plan);
		this.#planSha256 = officeSha(planSha256);
		this.#registry = registry;
	}
	get plan(): CompanyComputerResetPlan {
		return this.#plan;
	}
	begin(caller: AbortSignal) {
		return this.#status("qorpera_begin_runtime_office_reset", { p_plan_sha256: this.#planSha256 }, caller);
	}
	status(caller: AbortSignal) {
		return this.#status("qorpera_runtime_office_reset_status", {}, caller);
	}
	/** Issue or re-read one nonce-bound challenge. The returned signal and
	 * deadline cover the remaining window for the physical action and its ack. */
	async preparePhase(
		phase: CompanyComputerResetChallengePhase,
		challengeId: string,
		evidenceSha256: string,
		caller: AbortSignal,
	) {
		return this.#challenge(
			"qorpera_prepare_runtime_office_reset_phase",
			{ p_phase: phase, p_challenge_id: challengeId, p_evidence_sha256: officeSha(evidenceSha256) },
			phase,
			challengeId,
			evidenceSha256,
			caller,
		);
	}
	async checkPhase(
		phase: CompanyComputerResetChallengePhase,
		challengeId: string,
		evidenceSha256: string,
		caller: AbortSignal,
	) {
		return this.#challenge(
			"qorpera_check_runtime_office_reset_phase",
			{ p_challenge_id: challengeId },
			phase,
			challengeId,
			evidenceSha256,
			caller,
		);
	}
	ackPhase(challengeId: string, evidence: CompanyComputerResetPhaseEvidence, deadline: number, caller: AbortSignal) {
		if (!UUID.test(challengeId)) throw new Error("OFFICE_RESET_CHALLENGE_UNCONFIRMED");
		const parsed = parseCompanyComputerResetPhaseEvidence(evidence, this.#plan, evidence.phase);
		return this.#status(
			"qorpera_ack_runtime_office_reset_phase",
			{ p_challenge_id: challengeId, p_evidence: parsed },
			caller,
			deadline,
		);
	}
	async #challenge(
		method: "qorpera_prepare_runtime_office_reset_phase" | "qorpera_check_runtime_office_reset_phase",
		args: Record<string, unknown>,
		phase: CompanyComputerResetChallengePhase,
		challengeId: string,
		evidenceSha256: string,
		caller: AbortSignal,
	): Promise<{
		challenge: CompanyComputerResetPhaseChallenge;
		validForMs: number;
		deadline: number;
		signal: AbortSignal;
	}> {
		if (!UUID.test(challengeId) || challengeId === this.#plan.resetId)
			throw new Error("OFFICE_RESET_CHALLENGE_UNCONFIRMED");
		const started = performance.now();
		const challenge = await bounded(
			method,
			this.#pending,
			caller,
			started + 5000,
			async (signal) =>
				parseCompanyComputerResetPhaseChallenge(
					await this.#registry.call(method, structuredClone({ p_plan: this.#plan, ...args }), signal),
					this.#plan,
					phase,
					challengeId,
					evidenceSha256,
				),
			"OFFICE_RESET_REQUEST",
		);
		// Conservatively count preparation latency again; SQL's remaining
		// validity is never extended by a fresh client timer.
		const deadline = started + challenge.validForMs,
			validForMs = Math.floor(deadline - performance.now());
		if (validForMs < 1) throw new Error("OFFICE_RESET_REQUEST_EXPIRED");
		caller.throwIfAborted();
		return { challenge, validForMs, deadline, signal: AbortSignal.any([caller, AbortSignal.timeout(validForMs)]) };
	}
	async #status(
		method: Parameters<LxdOfficeResetRegistry["call"]>[0],
		args: Record<string, unknown>,
		caller: AbortSignal,
		deadline = performance.now() + 5000,
	): Promise<CompanyComputerResetStatus> {
		return bounded(
			method,
			this.#pending,
			caller,
			deadline,
			async (signal) => {
				const status = parseCompanyComputerResetStatus(
					await this.#registry.call(method, structuredClone({ p_plan: this.#plan, ...args }), signal),
					this.#plan,
				);
				const previous = this.#previous;
				if (
					previous &&
					(COMPANY_COMPUTER_RESET_PHASES.indexOf(status.phase) <
						COMPANY_COMPUTER_RESET_PHASES.indexOf(previous.phase) ||
						status.revision < previous.revision ||
						(previous.custodySha256 !== null && previous.custodySha256 !== status.custodySha256) ||
						(previous.restoreSha256 !== null && previous.restoreSha256 !== status.restoreSha256) ||
						(previous.stopAcknowledgedAtMs !== null &&
							previous.stopAcknowledgedAtMs !== status.stopAcknowledgedAtMs))
				)
					throw new Error("reset status regressed");
				this.#previous = status;
				return status;
			},
			"OFFICE_RESET_REQUEST",
		);
	}
}

export interface LxdOfficeResetSuccessorRegistry {
	call(
		method:
			| "qorpera_prepare_runtime_office_reset_successor"
			| "qorpera_runtime_office_reset_successor_status"
			| "qorpera_check_runtime_office_reset_successor"
			| "qorpera_activate_runtime_office_reset_successor",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
/** Provider-only handoff for the distinct activation on the recreated root.
 * The caller persists the request before prepare, verifies the restored root,
 * fresh boot and configuration independently, and supplies one fresh
 * end-to-end inspection deadline to activate. Metadata recovery cannot start
 * a service, release capacity or renew readiness. */
export class LxdOfficeResetSuccessorControl {
	readonly #request: CompanyComputerResetSuccessorRequest;
	readonly #registry: LxdOfficeResetSuccessorRegistry;
	readonly #pending = { value: false };
	#previous: CompanyComputerResetSuccessor | undefined;
	constructor(request: CompanyComputerResetSuccessorRequest, registry: LxdOfficeResetSuccessorRegistry) {
		this.#request = parseCompanyComputerResetSuccessorRequest(request);
		this.#registry = registry;
	}
	prepare(signal: AbortSignal) {
		return this.#call("qorpera_prepare_runtime_office_reset_successor", {}, signal);
	}
	status(signal: AbortSignal) {
		return this.#call("qorpera_runtime_office_reset_successor_status", {}, signal);
	}
	async check(caller: AbortSignal) {
		const deadline = performance.now() + 5000;
		const successor = await this.#call("qorpera_check_runtime_office_reset_successor", {}, caller, deadline);
		const validForMs = Math.floor(deadline - performance.now());
		if (validForMs < 1) throw new Error("OFFICE_RESET_SUCCESSOR_REQUEST_EXPIRED");
		caller.throwIfAborted();
		return { successor, validForMs, signal: AbortSignal.any([caller, AbortSignal.timeout(validForMs)]) };
	}
	activate(serviceInvocationId: string, inspectionDeadline: number, signal: AbortSignal) {
		if (
			typeof serviceInvocationId !== "string" ||
			!/^(?!0{32}$)[0-9a-f]{32}$/.test(serviceInvocationId) ||
			serviceInvocationId === this.#request.predecessor.startup.serviceInvocationId ||
			!Number.isFinite(inspectionDeadline) ||
			inspectionDeadline <= performance.now() ||
			inspectionDeadline > performance.now() + 5000
		)
			throw new Error("OFFICE_RESET_SUCCESSOR_INSPECTION_UNCONFIRMED");
		return this.#call(
			"qorpera_activate_runtime_office_reset_successor",
			{ p_service_invocation_id: serviceInvocationId },
			signal,
			inspectionDeadline,
			serviceInvocationId,
		);
	}
	async #call(
		method: Parameters<LxdOfficeResetSuccessorRegistry["call"]>[0],
		args: Record<string, unknown>,
		caller: AbortSignal,
		deadline = performance.now() + 5000,
		expectedInvocation?: string,
	) {
		return bounded(
			method,
			this.#pending,
			caller,
			deadline,
			async (signal) => {
				const result = parseCompanyComputerResetSuccessor(
						await this.#registry.call(method, structuredClone({ p_request: this.#request, ...args }), signal),
						this.#request,
					),
					previous = this.#previous;
				const rank = { prepared: 0, ready: 1, active: 2 };
				if (
					(expectedInvocation !== undefined &&
						(result.state !== "active" || result.serviceInvocationId !== expectedInvocation)) ||
					(previous &&
						(rank[result.state] < rank[previous.state] ||
							(previous.serviceInvocationId !== null &&
								previous.serviceInvocationId !== result.serviceInvocationId) ||
							previous.stopAcknowledgedAtMs !== result.stopAcknowledgedAtMs ||
							previous.officeRevision !== result.officeRevision ||
							previous.privacyVersion !== result.privacyVersion))
				)
					throw new Error("successor changed");
				this.#previous = result;
				return result;
			},
			"OFFICE_RESET_SUCCESSOR_REQUEST",
		);
	}
}
