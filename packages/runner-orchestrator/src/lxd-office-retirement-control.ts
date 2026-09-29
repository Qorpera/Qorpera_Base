import { join } from "node:path";
import { type CompanyComputerLifecycleRequest, parseCompanyComputerLifecycleRequest } from "@qorpera/contracts";
import { officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { code, readRecord } from "./lxd-office-journal-files.ts";

export interface LxdOfficeRetirementRegistry {
	call(
		method:
			| "qorpera_runtime_office_retirement"
			| "qorpera_prepare_runtime_office_retirement"
			| "qorpera_retire_runtime_office",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
export interface LxdOfficeRetirement {
	schema: "qorpera.office-retirement/v1";
	companyComputerId: string;
	computerGeneration: number;
	allocationId: string;
	instanceSha256: string;
	transitionId: string;
	deleteCommandId: string;
	deleteOperationId: string | null;
	state: "retiring" | "retired";
}
/** The office this provider serves, as its policy names it. */
export interface LxdOfficeRetirementIdentity {
	scope: { companyId: string; environmentId: string; companyComputerId: string; logicalComputerId: string };
	computerGeneration: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Written once the office is retired; after it the provider makes no call for this office. */
export const OFFICE_RETIRED_MARKER = "office-retired.json";

export function parseLxdOfficeRetirement(value: unknown, identity: LxdOfficeRetirementIdentity): LxdOfficeRetirement {
	const r = officeRecord(value, [
		"schema",
		"companyComputerId",
		"computerGeneration",
		"allocationId",
		"instanceSha256",
		"transitionId",
		"deleteCommandId",
		"deleteOperationId",
		"state",
	]);
	if (
		r.schema !== "qorpera.office-retirement/v1" ||
		r.companyComputerId !== identity.scope.companyComputerId ||
		r.computerGeneration !== identity.computerGeneration ||
		![r.allocationId, r.transitionId, r.deleteCommandId].every((id) => typeof id === "string" && UUID.test(id)) ||
		(r.state !== "retiring" && r.state !== "retired") ||
		(r.state === "retiring"
			? r.deleteOperationId !== null
			: typeof r.deleteOperationId !== "string" || !UUID.test(r.deleteOperationId))
	)
		throw new Error("OFFICE_RETIREMENT_INVALID");
	officeSha(r.instanceSha256);
	return r as unknown as LxdOfficeRetirement;
}

/** The retirement this provider completed, or undefined. Local only: no SQL call. */
export async function readLxdOfficeRetiredMarker(
	root: string,
	identity: LxdOfficeRetirementIdentity,
	read: (path: string, limit?: number) => Promise<{ value: unknown }> = readRecord,
): Promise<LxdOfficeRetirement | undefined> {
	let value: unknown;
	try {
		value = (await read(join(root, OFFICE_RETIRED_MARKER), 8192)).value;
	} catch (error) {
		if (code(error, "ENOENT")) return undefined;
		throw error;
	}
	const marker = officeRecord(value, ["schema", "intentId", "retirement"]);
	const retirement = parseLxdOfficeRetirement(marker.retirement, identity);
	if (
		marker.schema !== "qorpera.lxd-office-retired/v1" ||
		typeof marker.intentId !== "string" ||
		!UUID.test(marker.intentId) ||
		retirement.state !== "retired"
	)
		throw new Error("OFFICE_RETIRED_MARKER_INVALID");
	return retirement;
}

async function bounded<T>(
	caller: AbortSignal,
	deadline: number,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	caller.throwIfAborted();
	const remaining = Math.ceil(Math.min(5000, deadline - performance.now()));
	if (remaining < 1) throw new Error("OFFICE_RETIREMENT_REQUEST_EXPIRED");
	const signal = AbortSignal.any([caller, AbortSignal.timeout(remaining)]);
	let abort = () => {};
	const stopped = new Promise<never>((_, reject) => {
		abort = () => reject(new Error("OFFICE_RETIREMENT_REQUEST_UNCONFIRMED"));
		signal.addEventListener("abort", abort, { once: true });
	});
	const work = (async () => {
		signal.throwIfAborted();
		const value = await operation(signal);
		signal.throwIfAborted();
		if (performance.now() >= deadline) throw new Error("expired");
		return value;
	})().catch((error) => {
		throw new Error("OFFICE_RETIREMENT_REQUEST_UNCONFIRMED", { cause: error });
	});
	try {
		return await Promise.race([work, stopped]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

/** SQL authority for retiring a deleted company's powered-off office
 * (20260929320000). The answer to the power_off request is null while the company
 * lives. After the retirement completed it answers the retired receipt, also
 * after the company's purge. Each call is bounded to five seconds; the delete
 * window is SQL's five-second challenge, counted from before the call. */
export class LxdOfficeRetirementControl {
	readonly #request: CompanyComputerLifecycleRequest;
	readonly #identity: LxdOfficeRetirementIdentity;
	readonly #registry: LxdOfficeRetirementRegistry;
	#pending = false;
	constructor(request: CompanyComputerLifecycleRequest, registry: LxdOfficeRetirementRegistry) {
		this.#request = parseCompanyComputerLifecycleRequest(request);
		if (this.#request.action !== "power_off") throw new Error("OFFICE_RETIREMENT_ACTION_REQUIRED");
		this.#identity = {
			scope: this.#request.startup.scope,
			computerGeneration: this.#request.startup.computerGeneration,
		};
		this.#registry = registry;
	}
	/** Null keeps the office; otherwise the retirement bound to this power_off. */
	async retirement(caller: AbortSignal): Promise<LxdOfficeRetirement | null> {
		const value = await this.#call(
			"qorpera_runtime_office_retirement",
			{ p_request: this.#request },
			caller,
			performance.now() + 5000,
		);
		return value === null ? null : this.#bound(value);
	}
	async prepare(
		challengeId: string,
		deleteCommandId: string,
		caller: AbortSignal,
	): Promise<{ deadline: number; signal: AbortSignal }> {
		if (!UUID.test(challengeId) || challengeId === deleteCommandId)
			throw new Error("OFFICE_RETIREMENT_CHALLENGE_INVALID");
		const started = performance.now();
		const value = officeRecord(
			await this.#call(
				"qorpera_prepare_runtime_office_retirement",
				{ p_request: this.#request, p_challenge_id: challengeId },
				caller,
				started + 5000,
			),
			["schema", "challengeId", "deleteCommandId", "expiresInMs"],
		);
		if (
			value.schema !== "qorpera.office-retirement-challenge/v1" ||
			value.challengeId !== challengeId ||
			value.deleteCommandId !== deleteCommandId ||
			!Number.isSafeInteger(value.expiresInMs) ||
			(value.expiresInMs as number) < 0 ||
			(value.expiresInMs as number) > 5000
		)
			throw new Error("OFFICE_RETIREMENT_CHALLENGE_INVALID");
		// SQL's remaining validity, counted from before the call; never extended locally.
		const deadline = started + (value.expiresInMs as number),
			remaining = Math.floor(deadline - performance.now());
		if (remaining < 1) throw new Error("OFFICE_RETIREMENT_CHALLENGE_EXPIRED");
		return { deadline, signal: AbortSignal.any([caller, AbortSignal.timeout(remaining)]) };
	}
	async retire(
		evidence: { deleteCommandId: string; deleteOperationId: string },
		caller: AbortSignal,
	): Promise<LxdOfficeRetirement> {
		if (!UUID.test(evidence.deleteCommandId) || !UUID.test(evidence.deleteOperationId))
			throw new Error("OFFICE_RETIREMENT_EVIDENCE_INVALID");
		const receipt = this.#bound(
			await this.#call(
				"qorpera_retire_runtime_office",
				{
					p_request: this.#request,
					p_evidence: {
						schema: "qorpera.office-retirement-evidence/v1",
						deleteCommandId: evidence.deleteCommandId,
						deleteOperationId: evidence.deleteOperationId,
					},
				},
				caller,
				performance.now() + 5000,
			),
		);
		if (
			receipt.state !== "retired" ||
			receipt.deleteCommandId !== evidence.deleteCommandId ||
			receipt.deleteOperationId !== evidence.deleteOperationId
		)
			throw new Error("OFFICE_RETIREMENT_RECEIPT_INVALID");
		return receipt;
	}
	#bound(value: unknown): LxdOfficeRetirement {
		const retirement = parseLxdOfficeRetirement(value, this.#identity);
		if (
			retirement.allocationId !== this.#request.startup.allocationId ||
			retirement.instanceSha256 !== this.#request.startup.instanceSha256 ||
			retirement.transitionId !== this.#request.transitionId
		)
			throw new Error("OFFICE_RETIREMENT_DIFFERS");
		return retirement;
	}
	async #call(
		method: Parameters<LxdOfficeRetirementRegistry["call"]>[0],
		args: Record<string, unknown>,
		caller: AbortSignal,
		deadline: number,
	): Promise<unknown> {
		if (this.#pending) throw new Error("OFFICE_RETIREMENT_REQUEST_PENDING");
		this.#pending = true;
		try {
			return await bounded(caller, deadline, (signal) => this.#registry.call(method, structuredClone(args), signal));
		} finally {
			this.#pending = false;
		}
	}
}
