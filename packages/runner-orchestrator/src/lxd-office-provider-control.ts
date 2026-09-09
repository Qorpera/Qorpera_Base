import { isDeepStrictEqual } from "node:util";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";

export type LxdOfficeProviderAssignment = Pick<
	LxdOfficeGuestBinding,
	| "companyId"
	| "environmentId"
	| "companyComputerId"
	| "logicalComputerId"
	| "computerGeneration"
	| "providerId"
	| "providerPolicySha256"
	| "imageFingerprint"
	| "bootstrapSha256"
>;

export interface LxdOfficeProviderStatus {
	providerVersion: number;
	preparationEnabled: boolean;
	officeState: "provisioning" | "active" | "maintenance" | "recovering" | "retired";
	intent: { intentId: string; state: "requested" | "reserved" | "cancelled" } | null;
	reservation: { allocationId: string; instanceSha256: string; providerBindingSha256: string } | null;
}
export interface LxdOfficeProviderRegistry {
	call(
		method: "qorpera_runtime_office_provider_status",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
function record(value: unknown, keys: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("INVALID_OFFICE_PROVIDER_STATUS");
}
function uuid(value: unknown): boolean {
	return typeof value === "string" && UUID.test(value);
}
function sha(value: unknown): boolean {
	return typeof value === "string" && SHA.test(value);
}

/** Discovery for one infrastructure-enrolled provider assignment. Registration
 * is an operator action, not self-enrollment by a polling worker. Metadata is
 * still readable when preparation is disabled or an intent is cancelled so
 * pending physical operations can be reconciled. It grants no effects. */
export class LxdOfficeProviderControl {
	readonly #assignment: LxdOfficeProviderAssignment;
	readonly #scope: Record<string, string>;
	readonly #registry: LxdOfficeProviderRegistry;
	constructor(value: LxdOfficeProviderAssignment, registry: LxdOfficeProviderRegistry) {
		record(
			value,
			"bootstrapSha256,companyComputerId,companyId,computerGeneration,environmentId,imageFingerprint,logicalComputerId,providerId,providerPolicySha256",
		);
		if (
			![
				value.companyId,
				value.environmentId,
				value.companyComputerId,
				value.logicalComputerId,
				value.providerId,
			].every(uuid) ||
			![value.imageFingerprint, value.bootstrapSha256, value.providerPolicySha256].every(sha) ||
			!Number.isSafeInteger(value.computerGeneration) ||
			value.computerGeneration < 1
		)
			throw new Error("INVALID_OFFICE_PROVIDER_ASSIGNMENT");
		this.#assignment = Object.freeze({ ...value });
		this.#scope = Object.freeze({
			companyId: value.companyId,
			environmentId: value.environmentId,
			companyComputerId: value.companyComputerId,
			logicalComputerId: value.logicalComputerId,
		});
		this.#registry = registry;
	}
	async status(signal: AbortSignal): Promise<LxdOfficeProviderStatus> {
		signal.throwIfAborted();
		const a = this.#assignment;
		const result = await this.#registry.call(
			"qorpera_runtime_office_provider_status",
			{
				p_scope: { ...this.#scope },
				p_computer_generation: a.computerGeneration,
				p_provider_id: a.providerId,
				p_provider_policy_sha256: a.providerPolicySha256,
			},
			signal,
		);
		signal.throwIfAborted();
		record(
			result,
			"bootstrapSha256,computerGeneration,imageSha256,intent,officeState,preparationEnabled,providerId,providerPolicySha256,providerVersion,reservation,schema,scope",
		);
		if (
			result.schema !== "qorpera.office-provider-status/v1" ||
			!isDeepStrictEqual(result.scope, this.#scope) ||
			result.computerGeneration !== a.computerGeneration ||
			result.providerId !== a.providerId ||
			result.providerPolicySha256 !== a.providerPolicySha256 ||
			result.imageSha256 !== a.imageFingerprint ||
			result.bootstrapSha256 !== a.bootstrapSha256 ||
			!Number.isSafeInteger(result.providerVersion) ||
			(result.providerVersion as number) < 1 ||
			typeof result.preparationEnabled !== "boolean" ||
			!["provisioning", "active", "maintenance", "recovering", "retired"].includes(result.officeState as string)
		)
			throw new Error("OFFICE_PROVIDER_ASSIGNMENT_DIFFERS");
		let intent: LxdOfficeProviderStatus["intent"] = null;
		let reservation: LxdOfficeProviderStatus["reservation"] = null;
		if (result.intent !== null) {
			record(result.intent, "companyComputerId,computerGeneration,intentId,schema,state");
			if (
				result.intent.schema !== "qorpera.office-start-intent/v1" ||
				result.intent.companyComputerId !== a.companyComputerId ||
				result.intent.computerGeneration !== a.computerGeneration ||
				!uuid(result.intent.intentId) ||
				!["requested", "reserved", "cancelled"].includes(result.intent.state as string)
			)
				throw new Error("INVALID_OFFICE_PROVIDER_INTENT");
			intent = {
				intentId: result.intent.intentId as string,
				state: result.intent.state as NonNullable<LxdOfficeProviderStatus["intent"]>["state"],
			};
		}
		if (result.reservation !== null) {
			record(result.reservation, "allocationId,instanceSha256,providerBindingSha256");
			if (
				!uuid(result.reservation.allocationId) ||
				!sha(result.reservation.instanceSha256) ||
				!sha(result.reservation.providerBindingSha256)
			)
				throw new Error("INVALID_OFFICE_PROVIDER_RESERVATION");
			reservation = { ...result.reservation } as NonNullable<LxdOfficeProviderStatus["reservation"]>;
		}
		if (
			(!intent && reservation) ||
			(intent?.state === "requested" && reservation) ||
			(intent?.state === "reserved" && !reservation)
		)
			throw new Error("INVALID_OFFICE_PROVIDER_RESERVATION");
		return {
			providerVersion: result.providerVersion as number,
			preparationEnabled: result.preparationEnabled,
			officeState: result.officeState as LxdOfficeProviderStatus["officeState"],
			intent,
			reservation,
		};
	}
}
