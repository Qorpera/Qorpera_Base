/** Provider/guest startup handoff. Data never authorizes ordinary office work;
 * current SQL authority and measured physical readiness remain mandatory. */
export interface CompanyComputerActivationAttestation {
	readonly schema: "qorpera.office-activation-attestation/v1";
	readonly activationId: string;
	readonly bootId: string;
	readonly preparationObservationSha256: string;
	readonly configurationObservationSha256: string;
	readonly configurationSha256: string;
	readonly adoptionReceiptSha256: string;
	readonly nativePort: number;
	readonly viewerPort: number;
}
export interface CompanyComputerStartupIdentity {
	readonly scope: {
		readonly companyId: string;
		readonly environmentId: string;
		readonly companyComputerId: string;
		readonly logicalComputerId: string;
	};
	readonly computerGeneration: number;
	readonly allocationId: string;
	readonly instanceSha256: string;
	readonly imageSha256: string;
	readonly bootstrapSha256: string;
	readonly bootId: string;
	readonly configurationSha256: string;
	readonly serviceInvocationId: string;
}
export interface CompanyComputerStartupAuthority {
	readonly schema: "qorpera.office-startup-authority/v1";
	readonly activationId: string;
	readonly bootId: string;
	readonly configurationSha256: string;
	readonly state: "prepared" | "ready" | "active";
	readonly serviceInvocationId: string | null;
	readonly validForMs: 5000;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const INVOCATION = /^(?!0{32}$)[0-9a-f]{32}$/;
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
function match(value: unknown, pattern: RegExp): void {
	if (typeof value !== "string" || !pattern.test(value)) throw new Error("identity");
}
function positive(value: unknown, max: number): void {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error("number");
}
export function parseCompanyComputerActivationAttestation(
	value: unknown,
): Readonly<CompanyComputerActivationAttestation> {
	try {
		const input = record(value, [
			"schema",
			"activationId",
			"bootId",
			"preparationObservationSha256",
			"configurationObservationSha256",
			"configurationSha256",
			"adoptionReceiptSha256",
			"nativePort",
			"viewerPort",
		]);
		if (input.schema !== "qorpera.office-activation-attestation/v1") throw new Error("schema");
		for (const id of [input.activationId, input.bootId]) match(id, UUID);
		for (const sha of [
			input.preparationObservationSha256,
			input.configurationObservationSha256,
			input.configurationSha256,
			input.adoptionReceiptSha256,
		])
			match(sha, SHA);
		positive(input.nativePort, 65535);
		positive(input.viewerPort, 65535);
		if (input.nativePort === input.viewerPort) throw new Error("ports");
		return Object.freeze({ ...input }) as unknown as Readonly<CompanyComputerActivationAttestation>;
	} catch {
		throw new Error("INVALID_OFFICE_ACTIVATION_ATTESTATION");
	}
}
export function parseCompanyComputerStartupIdentity(value: unknown): Readonly<CompanyComputerStartupIdentity> {
	try {
		const input = record(value, [
			"scope",
			"computerGeneration",
			"allocationId",
			"instanceSha256",
			"imageSha256",
			"bootstrapSha256",
			"bootId",
			"configurationSha256",
			"serviceInvocationId",
		]);
		const scope = record(input.scope, ["companyId", "environmentId", "companyComputerId", "logicalComputerId"]);
		for (const id of [...Object.values(scope), input.allocationId, input.bootId]) match(id, UUID);
		for (const sha of [input.instanceSha256, input.imageSha256, input.bootstrapSha256, input.configurationSha256])
			match(sha, SHA);
		match(input.serviceInvocationId, INVOCATION);
		positive(input.computerGeneration, Number.MAX_SAFE_INTEGER);
		return Object.freeze({
			...input,
			scope: Object.freeze({ ...scope }),
		}) as unknown as Readonly<CompanyComputerStartupIdentity>;
	} catch {
		throw new Error("INVALID_OFFICE_STARTUP_IDENTITY");
	}
}
export function parseCompanyComputerStartupAuthority(
	value: unknown,
	identity: CompanyComputerStartupIdentity,
	activationId?: string,
): Readonly<CompanyComputerStartupAuthority> {
	try {
		const input = record(value, [
			"schema",
			"activationId",
			"bootId",
			"configurationSha256",
			"state",
			"serviceInvocationId",
			"validForMs",
		]);
		const expected = parseCompanyComputerStartupIdentity(identity);
		match(input.activationId, UUID);
		if (
			input.schema !== "qorpera.office-startup-authority/v1" ||
			input.bootId !== expected.bootId ||
			input.configurationSha256 !== expected.configurationSha256 ||
			(activationId !== undefined && input.activationId !== activationId) ||
			!["prepared", "ready", "active"].includes(input.state as string) ||
			input.validForMs !== 5000 ||
			(input.state === "prepared"
				? input.serviceInvocationId !== null
				: input.serviceInvocationId !== expected.serviceInvocationId)
		)
			throw new Error("authority");
		return Object.freeze({ ...input }) as unknown as Readonly<CompanyComputerStartupAuthority>;
	} catch {
		throw new Error("OFFICE_STARTUP_AUTHORITY_UNCONFIRMED");
	}
}
