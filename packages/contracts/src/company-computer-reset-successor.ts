import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	type CompanyComputerConfigurationCompletion,
	type CompanyComputerConfigurationMaterial,
	companyComputerBootDirectory,
	parseCompanyComputerConfigurationMaterial,
} from "./company-computer-configuration.ts";
import {
	type CompanyComputerLifecycleRequest,
	parseCompanyComputerLifecycleRequest,
} from "./company-computer-lifecycle.ts";
import {
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	type CompanyComputerPreparationCommand,
	type CompanyComputerPreparationRequest,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationRequest,
} from "./company-computer-preparation.ts";
import { type CompanyComputerResetSuccessor, parseCompanyComputerResetSuccessor } from "./company-computer-reset.ts";

/** The recreated root has no preparation invocation of its own: the packet
 * carries the exact original preparation document so the root helper can bind
 * the restored public receipt and the fresh boot to the permanent identity. */
// The original JSON is carried as a string, so quotes/backslashes/JSON
// whitespace may double in the outer packet. Each credential string keeps
// its own byte limit and may use six-byte JSON control-character escapes.
export const COMPANY_COMPUTER_RESET_CONFIGURATION_MAX_BYTES =
	2 * COMPANY_COMPUTER_PREPARATION_MAX_BYTES +
	6 * Object.values(COMPANY_COMPUTER_CONFIGURATION_LIMITS).reduce((sum, limit) => sum + limit, 0) +
	65536;
export const COMPANY_COMPUTER_RESET_SERVICE_START_MAX_BYTES = 16384;
export const COMPANY_COMPUTER_RESET_CONFIGURATION_CLAIM = "reset-configuration-claim.json";
export const COMPANY_COMPUTER_RESET_CONFIGURATION_COMPLETION = "reset-configuration-completion.json";

/** Confidential fixed provider-to-root packet for a reset successor. It is
 * staged only after the restore phase is acknowledged; parsing it grants no
 * installation or start authority and never restores a historical credential. */
export interface CompanyComputerResetConfigurationRequest {
	readonly schema: "qorpera.office-reset-configuration-request/v1";
	readonly resetId: string;
	readonly rootIncarnationId: string;
	readonly activationId: string;
	readonly predecessor: CompanyComputerLifecycleRequest;
	/** Exact original preparation request bytes; the helper hashes them itself. */
	readonly originPreparation: string;
	readonly originPreparationSha256: string;
	readonly adoptionReceiptSha256: string;
	readonly material: CompanyComputerConfigurationMaterial;
}
export interface CompanyComputerResetConfigurationCompletion {
	readonly schema: "qorpera.office-reset-configuration-completion/v1";
	readonly command: CompanyComputerPreparationCommand;
	readonly resetId: string;
	readonly rootIncarnationId: string;
	readonly activationId: string;
	readonly originPreparationSha256: string;
	readonly adoptionReceiptSha256: string;
	readonly files: CompanyComputerConfigurationCompletion["files"];
}
/** The start packet is the SQL-prepared reset successor itself: public
 * metadata whose canonical bytes the provider's start command already binds. */
export type CompanyComputerResetServiceStartRequest = CompanyComputerResetSuccessor;
export interface CompanyComputerResetServiceStartCompletion {
	readonly schema: "qorpera.office-reset-service-start-completion/v1";
	readonly command: CompanyComputerPreparationCommand;
	readonly resetId: string;
	readonly activationId: string;
	readonly configurationCompletionSha256: string;
	readonly configurationSha256: string;
	readonly serviceInvocationId: string;
	readonly mainPid: number;
	readonly controlGroup: "/system.slice/qorpera-company-computer.service";
}
export interface CompanyComputerResetServiceInspection {
	readonly schema: "qorpera.office-reset-service-inspection/v1";
	readonly inspectionId: string;
	readonly start: CompanyComputerResetServiceStartCompletion;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
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
function sha(value: unknown): string {
	if (typeof value !== "string" || !SHA.test(value)) throw new Error("digest");
	return value;
}
function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error("identity");
	return value;
}
function sameCommand(a: CompanyComputerPreparationCommand, b: CompanyComputerPreparationCommand): boolean {
	return a.commandId === b.commandId && a.requestSha256 === b.requestSha256 && a.bootId === b.bootId;
}
/** The retained replace request reaches this parser through canonical
 * (key-sorted) records while the original preparation keeps its authored key
 * order; the scope is the same identity whatever the order. */
function sameScope(
	a: CompanyComputerPreparationRequest["scope"],
	b: CompanyComputerPreparationRequest["scope"],
): boolean {
	const keys = ["companyId", "environmentId", "companyComputerId", "logicalComputerId"] as const;
	return keys.every((key) => a[key] === b[key]);
}
export function parseCompanyComputerResetConfigurationRequest(
	value: unknown,
): Readonly<CompanyComputerResetConfigurationRequest> {
	try {
		const r = record(value, [
			"schema",
			"resetId",
			"rootIncarnationId",
			"activationId",
			"predecessor",
			"originPreparation",
			"originPreparationSha256",
			"adoptionReceiptSha256",
			"material",
		]);
		if (
			r.schema !== "qorpera.office-reset-configuration-request/v1" ||
			new TextEncoder().encode(JSON.stringify(value)).length > COMPANY_COMPUTER_RESET_CONFIGURATION_MAX_BYTES
		)
			throw new Error("schema");
		const predecessor = parseCompanyComputerLifecycleRequest(r.predecessor),
			ids = [uuid(r.resetId), uuid(r.rootIncarnationId), uuid(r.activationId)];
		if (
			predecessor.action !== "replace" ||
			new Set(ids).size !== ids.length ||
			ids.includes(predecessor.activationId) ||
			ids.includes(predecessor.transitionId) ||
			ids.includes(predecessor.startup.bootId) ||
			ids.includes(predecessor.startup.allocationId)
		)
			throw new Error("identity");
		if (
			typeof r.originPreparation !== "string" ||
			!r.originPreparation ||
			new TextEncoder().encode(r.originPreparation).length > COMPANY_COMPUTER_PREPARATION_MAX_BYTES
		)
			throw new Error("origin");
		const original = parseCompanyComputerPreparationRequest(JSON.parse(r.originPreparation));
		if (
			original.allocationId !== predecessor.startup.allocationId ||
			!sameScope(original.scope, predecessor.startup.scope) ||
			original.computerGeneration !== predecessor.startup.computerGeneration ||
			original.instanceSha256 !== predecessor.startup.instanceSha256 ||
			original.imageSha256 !== predecessor.startup.imageSha256 ||
			original.bootstrapSha256 !== predecessor.startup.bootstrapSha256
		)
			throw new Error("origin binding");
		return Object.freeze({
			schema: "qorpera.office-reset-configuration-request/v1",
			resetId: r.resetId as string,
			rootIncarnationId: r.rootIncarnationId as string,
			activationId: r.activationId as string,
			predecessor,
			originPreparation: r.originPreparation,
			originPreparationSha256: sha(r.originPreparationSha256),
			adoptionReceiptSha256: sha(r.adoptionReceiptSha256),
			material: parseCompanyComputerConfigurationMaterial(r.material),
		});
	} catch {
		throw new Error("INVALID_OFFICE_RESET_CONFIGURATION_REQUEST");
	}
}
export function parseCompanyComputerResetConfigurationCompletion(
	value: unknown,
	expected: CompanyComputerResetConfigurationCompletion,
): Readonly<CompanyComputerResetConfigurationCompletion> {
	try {
		const r = record(value, [
			"schema",
			"command",
			"resetId",
			"rootIncarnationId",
			"activationId",
			"originPreparationSha256",
			"adoptionReceiptSha256",
			"files",
		]);
		const command = parseCompanyComputerPreparationCommand(r.command),
			target = parseCompanyComputerPreparationCommand(expected.command);
		if (
			r.schema !== "qorpera.office-reset-configuration-completion/v1" ||
			expected.schema !== r.schema ||
			!sameCommand(command, target)
		)
			throw new Error("command");
		const ids = [uuid(r.resetId), uuid(r.rootIncarnationId), uuid(r.activationId)];
		for (const key of ["resetId", "rootIncarnationId", "activationId"] as const)
			if (r[key] !== expected[key]) throw new Error("identity");
		if (new Set(ids).size !== ids.length || ids.includes(command.bootId)) throw new Error("identity");
		for (const key of ["originPreparationSha256", "adoptionReceiptSha256"] as const)
			if (sha(r[key]) !== sha(expected[key])) throw new Error("digest");
		const files = { ...record(r.files, Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES)) },
			retained = record(expected.files, Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES));
		for (const [key, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
			const actual = record(files[file], ["bytes", "sha256"]),
				match = record(retained[file], ["bytes", "sha256"]);
			if (
				!Number.isSafeInteger(actual.bytes) ||
				(actual.bytes as number) < 1 ||
				(actual.bytes as number) >
					COMPANY_COMPUTER_CONFIGURATION_LIMITS[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS] ||
				actual.bytes !== match.bytes ||
				sha(actual.sha256) !== sha(match.sha256)
			)
				throw new Error("file");
			files[file] = Object.freeze({ bytes: actual.bytes, sha256: actual.sha256 });
		}
		return Object.freeze({
			schema: "qorpera.office-reset-configuration-completion/v1",
			command,
			resetId: r.resetId as string,
			rootIncarnationId: r.rootIncarnationId as string,
			activationId: r.activationId as string,
			originPreparationSha256: expected.originPreparationSha256,
			adoptionReceiptSha256: expected.adoptionReceiptSha256,
			files: Object.freeze(files) as CompanyComputerResetConfigurationCompletion["files"],
		});
	} catch {
		throw new Error("INVALID_OFFICE_RESET_CONFIGURATION_COMPLETION");
	}
}
/** Only a `prepared` successor may be staged; a ready or active document is
 * evidence of an invocation that already exists and must not be restarted. */
export function parseCompanyComputerResetServiceStartRequest(
	value: unknown,
): Readonly<CompanyComputerResetServiceStartRequest> {
	try {
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			!("request" in value) ||
			new TextEncoder().encode(JSON.stringify(value)).length > COMPANY_COMPUTER_RESET_SERVICE_START_MAX_BYTES
		)
			throw new Error("schema");
		const successor = parseCompanyComputerResetSuccessor(value, (value as CompanyComputerResetSuccessor).request);
		if (successor.state !== "prepared") throw new Error("state");
		return successor;
	} catch {
		throw new Error("INVALID_OFFICE_RESET_SERVICE_START_REQUEST");
	}
}
export function parseCompanyComputerResetServiceStartCompletion(
	value: unknown,
	expectedCommand: CompanyComputerPreparationCommand,
	expectedRequest: CompanyComputerResetServiceStartRequest,
): Readonly<CompanyComputerResetServiceStartCompletion> {
	try {
		const r = record(value, [
				"schema",
				"command",
				"resetId",
				"activationId",
				"configurationCompletionSha256",
				"configurationSha256",
				"serviceInvocationId",
				"mainPid",
				"controlGroup",
			]),
			command = parseCompanyComputerPreparationCommand(r.command),
			target = parseCompanyComputerPreparationCommand(expectedCommand),
			request = parseCompanyComputerResetServiceStartRequest(expectedRequest).request,
			{ attestation } = request;
		if (
			r.schema !== "qorpera.office-reset-service-start-completion/v1" ||
			!sameCommand(command, target) ||
			command.bootId !== attestation.bootId ||
			r.resetId !== request.resetId ||
			r.activationId !== attestation.activationId ||
			sha(r.configurationCompletionSha256) !== r.configurationCompletionSha256 ||
			r.configurationSha256 !== attestation.configurationSha256 ||
			typeof r.serviceInvocationId !== "string" ||
			!/^(?!0{32}$)[0-9a-f]{32}$/.test(r.serviceInvocationId) ||
			r.serviceInvocationId === request.predecessor.startup.serviceInvocationId ||
			!Number.isSafeInteger(r.mainPid) ||
			(r.mainPid as number) < 1 ||
			r.controlGroup !== "/system.slice/qorpera-company-computer.service"
		)
			throw new Error("binding");
		return Object.freeze({ ...r, command }) as unknown as CompanyComputerResetServiceStartCompletion;
	} catch {
		throw new Error("INVALID_OFFICE_RESET_SERVICE_START_COMPLETION");
	}
}
export function parseCompanyComputerResetServiceInspection(
	value: unknown,
	inspectionId: string,
	completion: CompanyComputerResetServiceStartCompletion,
	request: CompanyComputerResetServiceStartRequest,
): Readonly<CompanyComputerResetServiceInspection> {
	try {
		const r = record(value, ["schema", "inspectionId", "start"]),
			expected = parseCompanyComputerResetServiceStartCompletion(completion, completion.command, request),
			nonce = parseCompanyComputerPreparationCommand({ ...expected.command, commandId: inspectionId }),
			start = parseCompanyComputerResetServiceStartCompletion(r.start, expected.command, request);
		if (
			r.schema !== "qorpera.office-reset-service-inspection/v1" ||
			r.inspectionId !== inspectionId ||
			nonce.commandId === expected.command.commandId ||
			start.mainPid !== expected.mainPid ||
			start.serviceInvocationId !== expected.serviceInvocationId ||
			start.configurationCompletionSha256 !== expected.configurationCompletionSha256
		)
			throw new Error("inspection");
		return Object.freeze({ schema: "qorpera.office-reset-service-inspection/v1", inspectionId, start });
	} catch {
		throw new Error("INVALID_OFFICE_RESET_SERVICE_INSPECTION");
	}
}

/** A reset-born boot keeps the original public adoption receipt attested (the
 * registry pins its digest); this retained record binds that origin to the
 * recreated root's boot so the service's readiness check can accept the
 * original receipt under a rebound boot attestation. Reboots use
 * qorpera.office-state-retained/v1 with a boot intent instead. */
export interface CompanyComputerResetAdoptionReceipt {
	readonly schema: "qorpera.office-state-reset-retained/v1";
	readonly state: "complete";
	readonly scope: CompanyComputerPreparationRequest["scope"];
	readonly computerGeneration: number;
	readonly allocationId: string;
	readonly instanceSha256: string;
	readonly imageSha256: string;
	readonly bootstrapSha256: string;
	readonly bootId: string;
	readonly layout: ReturnType<typeof companyComputerPreparationAdoptionReceipt>["layout"];
	readonly workbenchMount: CompanyComputerPreparationRequest["workbenchMount"];
	readonly origin: {
		readonly bootId: string;
		readonly preparationSha256: string;
		readonly adoptionReceiptSha256: string;
	};
	readonly reset: {
		readonly resetId: string;
		readonly rootIncarnationId: string;
		readonly activationId: string;
		readonly predecessor: { readonly transitionId: string; readonly activationId: string; readonly bootId: string };
	};
}
export function companyComputerResetAdoptionReceiptPath(bootId: string): string {
	return `${companyComputerBootDirectory(bootId)}/reset-adoption.json`;
}
export function companyComputerResetAdoptionReceipt(
	request: CompanyComputerResetConfigurationRequest,
	bootId: string,
): Readonly<CompanyComputerResetAdoptionReceipt> {
	const original = parseCompanyComputerPreparationRequest(JSON.parse(request.originPreparation)),
		initial = companyComputerPreparationAdoptionReceipt(original);
	return parseCompanyComputerResetAdoptionReceipt({
		schema: "qorpera.office-state-reset-retained/v1",
		state: "complete",
		scope: initial.scope,
		computerGeneration: initial.computerGeneration,
		allocationId: initial.allocationId,
		instanceSha256: initial.instanceSha256,
		imageSha256: initial.imageSha256,
		bootstrapSha256: initial.bootstrapSha256,
		bootId,
		layout: initial.layout,
		workbenchMount: initial.workbenchMount,
		origin: {
			bootId: initial.bootId,
			preparationSha256: request.originPreparationSha256,
			adoptionReceiptSha256: request.adoptionReceiptSha256,
		},
		reset: {
			resetId: request.resetId,
			rootIncarnationId: request.rootIncarnationId,
			activationId: request.activationId,
			predecessor: {
				transitionId: request.predecessor.transitionId,
				activationId: request.predecessor.activationId,
				bootId: request.predecessor.startup.bootId,
			},
		},
	});
}
export function parseCompanyComputerResetAdoptionReceipt(
	value: unknown,
): Readonly<CompanyComputerResetAdoptionReceipt> {
	try {
		const r = record(value, [
			"schema",
			"state",
			"scope",
			"computerGeneration",
			"allocationId",
			"instanceSha256",
			"imageSha256",
			"bootstrapSha256",
			"bootId",
			"layout",
			"workbenchMount",
			"origin",
			"reset",
		]);
		if (
			r.schema !== "qorpera.office-state-reset-retained/v1" ||
			r.state !== "complete" ||
			new TextEncoder().encode(JSON.stringify(value)).length > 16384
		)
			throw new Error("receipt");
		record(r.scope, ["companyId", "environmentId", "companyComputerId", "logicalComputerId"]);
		for (const key of ["companyId", "environmentId", "companyComputerId", "logicalComputerId"])
			uuid((r.scope as Record<string, unknown>)[key]);
		if (!Number.isSafeInteger(r.computerGeneration) || (r.computerGeneration as number) < 1)
			throw new Error("generation");
		uuid(r.allocationId);
		for (const key of ["instanceSha256", "imageSha256", "bootstrapSha256"]) sha(r[key]);
		record(r.layout, ["workbenchRoot", "desktopHome", "screenStateRoot", "browserProfilesRoot"]);
		record(r.workbenchMount, ["filesystem", "source", "root", "mountPoint"]);
		const origin = record(r.origin, ["bootId", "preparationSha256", "adoptionReceiptSha256"]);
		sha(origin.preparationSha256);
		sha(origin.adoptionReceiptSha256);
		const reset = record(r.reset, ["resetId", "rootIncarnationId", "activationId", "predecessor"]),
			predecessor = record(reset.predecessor, ["transitionId", "activationId", "bootId"]);
		const ids = [
			uuid(r.bootId),
			uuid(origin.bootId),
			uuid(reset.resetId),
			uuid(reset.rootIncarnationId),
			uuid(reset.activationId),
			uuid(predecessor.transitionId),
			uuid(predecessor.activationId),
			uuid(predecessor.bootId),
		];
		if (
			r.bootId === origin.bootId ||
			r.bootId === predecessor.bootId ||
			reset.activationId === predecessor.activationId
		)
			throw new Error("boot reused");
		if (new Set([reset.resetId, reset.rootIncarnationId, reset.activationId]).size !== 3) throw new Error("identity");
		void ids;
		return Object.freeze(JSON.parse(JSON.stringify(r))) as CompanyComputerResetAdoptionReceipt;
	} catch {
		throw new Error("INVALID_OFFICE_RESET_ADOPTION_RECEIPT");
	}
}
