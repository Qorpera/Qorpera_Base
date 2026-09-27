import {
	assertCompanyComputerScope,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	companyComputerRequest,
} from "./cloud-company-computer-contract.ts";

export interface CompanyComputerStartIntent {
	schema: "qorpera.office-start-intent/v1";
	intentId: string;
	companyComputerId: string;
	computerGeneration: number;
	state: "requested" | "reserved" | "cancelled";
}
/** Server-owned maintenance distinguishes idle rest from host recovery. */
export interface CompanyComputerMaintenance {
	reason: "host_reboot" | "idle";
	state: "requested" | "resumed" | "activated";
	transitionId: string;
	requestedAt: string;
	resumedAt: string | null;
	activatedAt: string | null;
}
export function parseCompanyComputerMaintenance(value: unknown): CompanyComputerMaintenance | null {
	if (value === null || value === undefined) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_OFFICE_MAINTENANCE");
	const r = value as Record<string, unknown>;
	if (
		Object.keys(r).sort().join() !== "activatedAt,reason,requestedAt,resumedAt,state,transitionId" ||
		(r.reason !== "host_reboot" && r.reason !== "idle") ||
		!["requested", "resumed", "activated"].includes(r.state as string) ||
		typeof r.transitionId !== "string" ||
		typeof r.requestedAt !== "string" ||
		(r.resumedAt !== null && typeof r.resumedAt !== "string") ||
		(r.activatedAt !== null && typeof r.activatedAt !== "string")
	)
		throw new Error("INVALID_OFFICE_MAINTENANCE");
	return {
		reason: r.reason,
		state: r.state as CompanyComputerMaintenance["state"],
		transitionId: r.transitionId,
		requestedAt: r.requestedAt,
		resumedAt: r.resumedAt as string | null,
		activatedAt: r.activatedAt as string | null,
	};
}
export interface CompanyComputerStartStatus {
	scope: CompanyComputerScope;
	computerGeneration: number;
	officeState: "provisioning" | "active" | "maintenance" | "recovering" | "retired";
	intent: CompanyComputerStartIntent | null;
	maintenance: CompanyComputerMaintenance | null;
}
export type CompanyComputerStartRpc = (
	method:
		| "qorpera_request_runtime_office_start"
		| "qorpera_cancel_runtime_office_start"
		| "qorpera_withdraw_runtime_office_wake"
		| "qorpera_runtime_office_start_status",
	args: Record<string, unknown>,
	signal: AbortSignal,
) => Promise<{ data: unknown; error: unknown }>;

function record(value: unknown, expected: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== expected)
		throw new Error("INVALID_OFFICE_START_RESPONSE");
}
function generation(value: unknown): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("INVALID_OFFICE_START_GENERATION");
}
export function parseCompanyComputerStartIntent(
	value: unknown,
	scope: CompanyComputerScope,
	computerGeneration: number,
): CompanyComputerStartIntent {
	assertCompanyComputerScope(scope, scope);
	generation(computerGeneration);
	record(value, "companyComputerId,computerGeneration,intentId,schema,state");
	if (
		value.schema !== "qorpera.office-start-intent/v1" ||
		value.companyComputerId !== scope.companyComputerId ||
		value.computerGeneration !== computerGeneration ||
		typeof value.intentId !== "string" ||
		!COMPANY_COMPUTER_UUID.test(value.intentId) ||
		!["requested", "reserved", "cancelled"].includes(value.state as string)
	)
		throw new Error("INVALID_OFFICE_START_RESPONSE");
	return structuredClone(value) as unknown as CompanyComputerStartIntent;
}

/** Browser-safe member intent API for desktop and web. The client owns no
 * service/guest lifetime. Request IDs are caller-retained for reconciliation;
 * an unknown response requires status(), not a replacement physical start. */
export class CloudCompanyComputerStart {
	readonly #scope: CompanyComputerScope;
	readonly #rpc: CompanyComputerStartRpc;
	constructor(scope: CompanyComputerScope, rpc: CompanyComputerStartRpc) {
		assertCompanyComputerScope(scope, scope);
		this.#scope = Object.freeze({ ...scope });
		this.#rpc = rpc;
	}
	async #request(
		method: Parameters<CompanyComputerStartRpc>[0],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		try {
			const response = await companyComputerRequest((s) => this.#rpc(method, structuredClone(args), s), signal);
			if (!response || response.error) throw new Error("unconfirmed");
			return response.data;
		} catch {
			throw new Error("OFFICE_START_UNCONFIRMED_REFRESH_STATUS");
		}
	}
	/** SQL gates initial provisioning to managers and idle wake to writers. An accepted intent is not
	 * readiness and does not grant screens, browser profiles or member input. */
	async request(
		computerGeneration: number,
		requestId: string,
		signal: AbortSignal,
	): Promise<CompanyComputerStartIntent> {
		generation(computerGeneration);
		if (typeof requestId !== "string" || !COMPANY_COMPUTER_UUID.test(requestId))
			throw new Error("INVALID_OFFICE_START_REQUEST");
		const intent = parseCompanyComputerStartIntent(
			await this.#request(
				"qorpera_request_runtime_office_start",
				{
					p_scope: this.#scope,
					p_computer_generation: computerGeneration,
					p_request_id: requestId,
				},
				signal,
			),
			this.#scope,
			computerGeneration,
		);
		if (intent.state === "cancelled") throw new Error("OFFICE_START_UNCONFIRMED_REFRESH_STATUS");
		return intent;
	}
	/** Revokes further preparation. Acknowledgement is not physical drain or
	 * capacity release, and closing this SDK/client never calls cancellation. */
	async cancel(value: CompanyComputerStartIntent, signal: AbortSignal): Promise<CompanyComputerStartIntent> {
		const intent = parseCompanyComputerStartIntent(value, this.#scope, value.computerGeneration);
		const result = parseCompanyComputerStartIntent(
			await this.#request(
				"qorpera_cancel_runtime_office_start",
				{
					p_scope: this.#scope,
					p_computer_generation: intent.computerGeneration,
					p_intent_id: intent.intentId,
				},
				signal,
			),
			this.#scope,
			intent.computerGeneration,
		);
		if (result.intentId !== intent.intentId || result.state !== "cancelled")
			throw new Error("INVALID_OFFICE_START_RESPONSE");
		return result;
	}
	/** Takes back this member's own idle wake request when nothing here needs the
	 * computer any more. The wake stands; once every requester has withdrawn and
	 * nothing used the computer, idle stops it sooner. "unavailable" means this
	 * member has no such request (never landed, replaced, or not an idle wake). */
	async withdraw(
		computerGeneration: number,
		requestId: string,
		signal: AbortSignal,
	): Promise<"withdrawn" | "unavailable"> {
		generation(computerGeneration);
		if (typeof requestId !== "string" || !COMPANY_COMPUTER_UUID.test(requestId))
			throw new Error("INVALID_OFFICE_START_REQUEST");
		const result = await this.#request(
			"qorpera_withdraw_runtime_office_wake",
			{ p_scope: this.#scope, p_computer_generation: computerGeneration, p_request_id: requestId },
			signal,
		);
		record(result, "state");
		if (result.state !== "withdrawn" && result.state !== "unavailable")
			throw new Error("INVALID_OFFICE_START_RESPONSE");
		return result.state;
	}
	async status(signal: AbortSignal): Promise<CompanyComputerStartStatus> {
		const result = await this.#request("qorpera_runtime_office_start_status", { p_scope: this.#scope }, signal);
		// `maintenance` arrives from backends at or after the 2026-09-17 amendment.
		const withMaintenance = !!result && typeof result === "object" && "maintenance" in result;
		record(
			result,
			withMaintenance
				? "computerGeneration,intent,maintenance,officeState,scope"
				: "computerGeneration,intent,officeState,scope",
		);
		record(result.scope, "companyComputerId,companyId,environmentId,logicalComputerId");
		assertCompanyComputerScope(result.scope as unknown as CompanyComputerScope, this.#scope);
		generation(result.computerGeneration);
		if (!["provisioning", "active", "maintenance", "recovering", "retired"].includes(result.officeState as string))
			throw new Error("INVALID_OFFICE_START_RESPONSE");
		return {
			scope: { ...this.#scope },
			computerGeneration: result.computerGeneration,
			officeState: result.officeState as CompanyComputerStartStatus["officeState"],
			maintenance: withMaintenance ? parseCompanyComputerMaintenance(result.maintenance) : null,
			intent:
				result.intent === null
					? null
					: parseCompanyComputerStartIntent(result.intent, this.#scope, result.computerGeneration),
		};
	}
}
