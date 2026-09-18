import {
	type CompanyComputerStartupIdentity,
	parseCompanyComputerStartupIdentity,
} from "./company-computer-activation.ts";

/** Infrastructure recovery intent. Persist before submission. This revokes
 * admission; it does not authorize a new invocation, boot or allocation. */
export interface CompanyComputerLifecycleRequest {
	readonly schema: "qorpera.office-lifecycle-request/v1";
	readonly transitionId: string;
	readonly action: "service_restart" | "reboot" | "power_off" | "replace";
	readonly activationId: string;
	readonly providerId: string;
	readonly providerPolicySha256: string;
	readonly startup: CompanyComputerStartupIdentity;
}
export interface CompanyComputerLifecycleDrain {
	readonly state: "draining";
	readonly drainId: string;
	readonly epoch: number;
	readonly binding: CompanyComputerStartupIdentity["scope"] & {
		readonly computerGeneration: number;
		readonly screenId: string;
		readonly screenOrdinal: number;
		readonly screenGeneration: number;
		readonly staffAgentId: string;
	};
}
/** Immutable revocation receipt, not physical drain/stop confirmation. Even
 * acknowledged screen drains cannot prove the ordinary service cgroup gone. */
export interface CompanyComputerLifecycleTransition {
	readonly schema: "qorpera.office-lifecycle-transition/v1";
	readonly request: CompanyComputerLifecycleRequest;
	readonly state: "draining";
	readonly revocationRevision: number;
	readonly requestedAtMs: number;
	readonly drains: readonly CompanyComputerLifecycleDrain[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== keys.sort().join()
	)
		throw new Error("record");
	return value as Record<string, unknown>;
}
function uuid(value: unknown) {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error("identity");
}
function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new Error("number");
}
export function parseCompanyComputerLifecycleRequest(value: unknown): Readonly<CompanyComputerLifecycleRequest> {
	try {
		const input = record(value, [
			"schema",
			"transitionId",
			"action",
			"activationId",
			"providerId",
			"providerPolicySha256",
			"startup",
		]);
		for (const id of [input.transitionId, input.activationId, input.providerId]) uuid(id);
		if (
			input.schema !== "qorpera.office-lifecycle-request/v1" ||
			!["service_restart", "reboot", "power_off", "replace"].includes(input.action as string) ||
			typeof input.providerPolicySha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(input.providerPolicySha256)
		)
			throw new Error("schema");
		return Object.freeze({
			schema: input.schema,
			transitionId: input.transitionId,
			action: input.action,
			activationId: input.activationId,
			providerId: input.providerId,
			providerPolicySha256: input.providerPolicySha256,
			startup: parseCompanyComputerStartupIdentity(input.startup),
		}) as CompanyComputerLifecycleRequest;
	} catch {
		throw new Error("INVALID_OFFICE_LIFECYCLE_REQUEST");
	}
}
export function parseCompanyComputerLifecycleTransition(
	value: unknown,
	expected: CompanyComputerLifecycleRequest,
): Readonly<CompanyComputerLifecycleTransition> {
	try {
		const input = record(value, ["schema", "request", "state", "revocationRevision", "requestedAtMs", "drains"]);
		const request = parseCompanyComputerLifecycleRequest(input.request),
			target = parseCompanyComputerLifecycleRequest(expected);
		// Identity parsers retain no references but may preserve startup key order.
		for (const key of ["transitionId", "action", "activationId", "providerId", "providerPolicySha256"] as const)
			if (request[key] !== target[key]) throw new Error("binding");
		for (const key of Object.keys(target.startup) as (keyof CompanyComputerStartupIdentity)[])
			if (key !== "scope" && request.startup[key] !== target.startup[key]) throw new Error("binding");
		for (const key of Object.keys(target.startup.scope) as (keyof CompanyComputerStartupIdentity["scope"])[])
			if (request.startup.scope[key] !== target.startup.scope[key]) throw new Error("scope");
		if (
			input.schema !== "qorpera.office-lifecycle-transition/v1" ||
			input.state !== "draining" ||
			!Array.isArray(input.drains) ||
			input.drains.length > 32
		)
			throw new Error("schema");
		positive(input.revocationRevision);
		positive(input.requestedAtMs);
		let ordinal = 0;
		const ids = new Set<string>(),
			staff = new Set<string>(),
			challenges = new Set<string>();
		const drains = input.drains.map((value) => {
			const drain = record(value, ["state", "drainId", "epoch", "binding"]);
			const binding = record(drain.binding, [
				"companyId",
				"environmentId",
				"companyComputerId",
				"logicalComputerId",
				"computerGeneration",
				"screenId",
				"screenOrdinal",
				"screenGeneration",
				"staffAgentId",
			]);
			uuid(drain.drainId);
			uuid(binding.screenId);
			uuid(binding.staffAgentId);
			positive(drain.epoch);
			positive(binding.screenGeneration);
			positive(binding.screenOrdinal, 32);
			if (
				drain.state !== "draining" ||
				binding.computerGeneration !== request.startup.computerGeneration ||
				(binding.screenOrdinal as number) <= ordinal ||
				ids.has(binding.screenId as string) ||
				staff.has(binding.staffAgentId as string) ||
				challenges.has(drain.drainId as string)
			)
				throw new Error("drain");
			for (const [key, value] of Object.entries(request.startup.scope))
				if (binding[key] !== value) throw new Error("scope");
			ordinal = binding.screenOrdinal as number;
			ids.add(binding.screenId as string);
			staff.add(binding.staffAgentId as string);
			challenges.add(drain.drainId as string);
			return Object.freeze({
				...drain,
				binding: Object.freeze({ ...binding }),
			}) as unknown as CompanyComputerLifecycleDrain;
		});
		return Object.freeze({
			schema: input.schema,
			request,
			state: input.state,
			revocationRevision: input.revocationRevision,
			requestedAtMs: input.requestedAtMs,
			drains: Object.freeze(drains),
		}) as CompanyComputerLifecycleTransition;
	} catch {
		throw new Error("OFFICE_LIFECYCLE_TRANSITION_UNCONFIRMED");
	}
}
