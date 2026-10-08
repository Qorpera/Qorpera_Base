import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerLease,
	assertCompanyComputerScope,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerEffectContext,
	type CompanyComputerOperation,
	type CompanyComputerScope,
	type CompanyComputerScreenLease,
	type CompanyComputerToolContent,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import { readBoundedCloudResponse } from "@qorpera/cloud-client/cloud-request";
import { type JsonValue, parseCompanyComputerNativeRoute, parseCompanyComputerNativeUrl } from "@qorpera/contracts";

export { parseCompanyComputerNativeRoute, parseCompanyComputerNativeUrl } from "@qorpera/contracts";

import type {
	CompanyAccountFillAnswer,
	CompanyAccountFillRequest,
	CompanyAccountRefusal,
} from "./cloud-company-account-vault.ts";
import {
	type CloudCompanyComputerSessionFactory,
	createCloudCompanyComputerSession,
} from "./cloud-company-computer-control.ts";
import { CloudCompanyComputerEffectControl } from "./cloud-company-computer-effect-control.ts";
import type { HttpCloudCompanyComputerRegistry } from "./cloud-company-computer-registry-http.ts";
import {
	type CloudCompanyComputerScreenshots,
	createHttpCompanyComputerScreenshots,
	parseCompanyComputerCaptureGateway,
	parseCompanyComputerScreenshotAsset,
} from "./cloud-company-computer-screenshots.ts";
import {
	createCompanyComputerStartSession,
	parseCompanyComputerStartDescriptor,
} from "./cloud-company-computer-start.ts";
import type { CompanyComputerCloudEndpoint } from "./cloud-company-computer-tools.ts";
import { CloudNativeCaptureImages } from "./cloud-native-capture-images.ts";
import { type CloudNativeToolRun, cloudToolRequest, isNativeJobHolder } from "./cloud-native-tool-authority.ts";
import { cloudNativeToolOperationEnvelope } from "./cloud-native-tool-operations.ts";

/** The vault, for a vault_fill (company accounts A1-3): HttpCloudSecretBrokerClient. */
export interface CompanyComputerAccountFills {
	companyAccountFill(
		request: CompanyAccountFillRequest,
		signal: AbortSignal,
	): Promise<CompanyAccountFillAnswer | CompanyAccountRefusal>;
}

export const COMPANY_COMPUTER_NATIVE_SCHEMA = "qorpera.company-computer-native/v1";
export const COMPANY_COMPUTER_NATIVE_MAX_REQUEST = 96 * 1024;
export const COMPANY_COMPUTER_NATIVE_MAX_RESPONSE = 48 * 1024;
/** A screenshot's perform answer may carry its PNG (at most 8 MiB, as base64) when nothing stores it (folder-v2, P06d). */
export const COMPANY_COMPUTER_NATIVE_MAX_SCREENSHOT_RESPONSE = 11 * 1024 * 1024;
export function officeNativeRecord(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("INVALID_OFFICE_NATIVE_MESSAGE");
	return value as Record<string, unknown>;
}

export interface CompanyComputerNativeDescriptor {
	state: "available";
	scope: CompanyComputerScope;
	capabilities: ("shell" | "browser" | "desktop")[];
	resources: { [key: string]: JsonValue };
}

/** Closed authoritative metadata. Descriptors never supply transport URLs,
 * tokens, filesystem paths, guest code, or identity from an execution prompt. */
export function parseCompanyComputerNativeDescriptor(
	value: unknown,
	run: CloudNativeToolRun,
): CompanyComputerNativeDescriptor | undefined {
	if (value && typeof value === "object" && "state" in value && value.state === "unavailable") {
		officeNativeRecord(value, "state");
		return undefined;
	}
	const record = officeNativeRecord(value, "capabilities,resources,scope,state");
	const scope = officeNativeRecord(
		record.scope,
		"companyComputerId,companyId,environmentId,logicalComputerId",
	) as unknown as CompanyComputerScope;
	assertCompanyComputerScope(scope, scope);
	if (
		record.state !== "available" ||
		scope.companyId !== run.identity.companyId ||
		scope.environmentId !== run.identity.environmentId ||
		run.identity.audienceKind !== "company" ||
		!Array.isArray(record.capabilities) ||
		record.capabilities.length > 3 ||
		new Set(record.capabilities).size !== record.capabilities.length ||
		record.capabilities.some((value) => !["shell", "browser", "desktop"].includes(value))
	)
		throw new Error("INVALID_OFFICE_NATIVE_DESCRIPTOR");
	const browser = record.capabilities.includes("browser");
	const resources = officeNativeRecord(
		record.resources,
		browser
			? "browserGrantId,browserGrantVersion,browserProfileId,officeGrantId,officeGrantVersion,officePrivacyVersion"
			: "officeGrantId,officeGrantVersion,officePrivacyVersion",
	);
	for (const key of browser ? ["officeGrantId", "browserGrantId", "browserProfileId"] : ["officeGrantId"])
		if (typeof resources[key] !== "string" || !COMPANY_COMPUTER_UUID.test(resources[key]))
			throw new Error("INVALID_OFFICE_NATIVE_DESCRIPTOR");
	for (const key of browser
		? ["officeGrantVersion", "browserGrantVersion", "officePrivacyVersion"]
		: ["officeGrantVersion", "officePrivacyVersion"])
		if (
			!Number.isSafeInteger(resources[key]) ||
			(resources[key] as number) < (key === "officePrivacyVersion" ? 0 : 1)
		)
			throw new Error("INVALID_OFFICE_NATIVE_DESCRIPTOR");
	return structuredClone(record) as unknown as CompanyComputerNativeDescriptor;
}

/** Private native-host -> office-supervisor transport. Guest dispatch still
 * consumes the original native effect receipt at the receiving boundary.
 * No retries or fallback local execution after an unknown result. */
export class HttpCompanyComputerNativeEndpoint implements CompanyComputerCloudEndpoint {
	readonly capabilities: readonly ("shell" | "browser" | "desktop")[];
	readonly #descriptor: CompanyComputerNativeDescriptor;
	readonly #run: CloudNativeToolRun;
	readonly #effects: CloudCompanyComputerEffectControl;
	readonly #url: string;
	readonly #token: string;
	readonly #holder: () => string;
	readonly #fetch: typeof fetch;
	readonly #accountFills: CompanyComputerAccountFills | undefined;
	readonly #screenshots: Pick<CloudCompanyComputerScreenshots, "holdInline"> | undefined;
	readonly #leases = new Map<string, CompanyComputerScreenLease>();
	#closed = false;

	constructor(options: {
		run: CloudNativeToolRun;
		descriptor: CompanyComputerNativeDescriptor;
		url: string;
		token: string;
		/** G2-6c: the run's holder credential, read per request (NativeHostDispatch.holderHeader). */
		holder: () => string;
		registry: HttpCloudCompanyComputerRegistry;
		fetch?: typeof fetch;
		accountFills?: CompanyComputerAccountFills;
		/** The run's capture reader, which keeps a screenshot's pixels from its perform answer for the model. */
		screenshots?: Pick<CloudCompanyComputerScreenshots, "holdInline">;
	}) {
		const descriptor = parseCompanyComputerNativeDescriptor(options.descriptor, options.run);
		const endpoint = parseCompanyComputerNativeUrl(options.url);
		if (
			!descriptor ||
			endpoint.companyComputerId !== descriptor.scope.companyComputerId ||
			!/^[A-Za-z0-9_-]{43}$/.test(options.token)
		)
			throw new Error("INVALID_OFFICE_NATIVE_CONFIGURATION");
		this.#descriptor = descriptor;
		this.capabilities = Object.freeze([...descriptor.capabilities]);
		this.#run = options.run;
		this.#url = endpoint.url;
		this.#token = options.token;
		this.#holder = options.holder;
		this.#fetch = options.fetch ?? fetch;
		this.#accountFills = options.accountFills;
		this.#screenshots = options.screenshots;
		this.#effects = new CloudCompanyComputerEffectControl({
			run: options.run,
			scope: descriptor.scope,
			control: options.registry,
		});
	}
	get resourceTarget(): { [key: string]: JsonValue } {
		return structuredClone(this.#descriptor.resources);
	}
	#validate(operation: CompanyComputerOperation, lease: CompanyComputerScreenLease): void {
		if (this.#closed) throw new Error("OFFICE_NATIVE_CLOSED");
		assertCompanyComputerScope(lease.binding, this.#descriptor.scope);
		assertCompanyComputerLease(lease, lease.binding, {
			kind: "agent",
			runId: this.#run.identity.runId,
			staffAgentId: this.#run.identity.staffAgentId,
		});
		if (
			!isDeepStrictEqual(operation.target, {
				realm: "company_computer",
				binding: lease.binding,
				resources: this.#descriptor.resources,
			})
		)
			throw new Error("OFFICE_NATIVE_RESOURCES_CHANGED");
	}
	async authorize(
		operation: CompanyComputerOperation,
		identity: CompanyComputerEffectContext["identity"],
		lease: CompanyComputerScreenLease,
		signal: AbortSignal,
	): Promise<void> {
		this.#validate(operation, lease);
		if (!isDeepStrictEqual(identity, this.#run.identity)) throw new Error("OFFICE_NATIVE_IDENTITY_CHANGED");
		await this.#effects.assertAuthorized({ operation, identity, lease, receipt: null }, signal);
	}
	async #call(
		body: Record<string, unknown>,
		signal: AbortSignal,
		maxResponse = COMPANY_COMPUTER_NATIVE_MAX_RESPONSE,
	): Promise<unknown> {
		const encoded = JSON.stringify({
			schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
			nativeBinding: this.#run.binding,
			...body,
		});
		if (Buffer.byteLength(encoded) > COMPANY_COMPUTER_NATIVE_MAX_REQUEST)
			throw new Error("OFFICE_NATIVE_REQUEST_TOO_LARGE");
		// G2-6c: a perform proves the run's lease; a release needs no proof, so it carries no credential. Only the job's
		// own holder goes to the computer, never the identity credential the dispatch gives between jobs.
		const holder = body.action === "perform" ? this.#holder() : undefined;
		try {
			return await cloudToolRequest(
				async (s) => {
					const response = await this.#fetch(this.#url, {
						method: "POST",
						redirect: "error",
						signal: s,
						headers: {
							authorization: `Bearer ${this.#token}`,
							"content-type": "application/json",
							...(isNativeJobHolder(holder) ? { "x-qorpera-identity": holder } : {}),
						},
						body: encoded,
					});
					if (!response.ok) {
						void response.body?.cancel().catch(() => undefined);
						throw new Error("unconfirmed");
					}
					const bytes = await readBoundedCloudResponse(response, maxResponse, s);
					s.throwIfAborted();
					return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
				},
				signal,
				25000,
			);
		} catch {
			throw new Error("OFFICE_NATIVE_UNCONFIRMED");
		}
	}
	async perform(
		operation: CompanyComputerOperation,
		lease: CompanyComputerScreenLease,
		context: CompanyComputerEffectContext,
	): Promise<CompanyComputerToolContent> {
		this.#validate(operation, lease);
		if (
			!isDeepStrictEqual(context.identity, this.#run.identity) ||
			!COMPANY_COMPUTER_UUID.test(context.receiptId) ||
			!/^[0-9a-f]{64}$/.test(context.idempotencyKey)
		)
			throw new Error("OFFICE_NATIVE_IDENTITY_CHANGED");
		const signal = AbortSignal.any([context.signal, this.#run.signal]);
		await this.#run.assertActive(signal);
		// A vault_fill: the vault seals the value to the boot key of the computer this lease holds, for exactly
		// this call (the receipt's input digest is this envelope's), and this host only carries the box. A
		// refusal (accounts switched off, no such account, an older computer) is the call's answer, unsent.
		let fill: Readonly<Record<string, string>> | undefined;
		const action = operation.arguments as { kind?: unknown; action?: unknown };
		if (action.kind === "browser" && action.action === "vault_fill") {
			const answer = this.#accountFills
				? await this.#accountFills.companyAccountFill(
						{
							binding: this.#run.binding,
							receiptId: context.receiptId,
							idempotencyKey: context.idempotencyKey,
							envelope: cloudNativeToolOperationEnvelope(this.#run.identity, operation),
						},
						signal,
					)
				: ({
						schema: "qorpera.company-account-refusal/v1",
						code: "0A000",
						message: "Company accounts are not set up for this company's computers",
					} as const);
			if (answer.schema !== "qorpera.company-account-fill-answer/v1")
				return {
					kind: "json",
					value: {
						action: "vault_fill",
						completed: false,
						refused: { code: answer.code, message: answer.message },
					},
				};
			fill = answer.box;
		}
		// Retain cleanup after ambiguous delivery. Never mark a remote session
		// unused just because its response was lost or its caller was cancelled.
		this.#leases.set(lease.leaseId, structuredClone(lease));
		const screenshot = operation.tool === "computer_screenshot";
		const answer = await this.#call(
			{
				action: "perform",
				operation,
				lease,
				receipt: { receiptId: context.receiptId, idempotencyKey: context.idempotencyKey },
				...(fill ? { fill } : {}),
			},
			signal,
			screenshot ? COMPANY_COMPUTER_NATIVE_MAX_SCREENSHOT_RESPONSE : COMPANY_COMPUTER_NATIVE_MAX_RESPONSE,
		);
		// Only a screenshot's answer may carry its pixels (folder-v2: the PNG is stored nowhere).
		const inline = screenshot && !!answer && typeof answer === "object" && "image" in answer;
		const response = officeNativeRecord(
			answer,
			inline ? "content,idempotencyKey,image,receiptId,schema" : "content,idempotencyKey,receiptId,schema",
		);
		if (
			response.schema !== COMPANY_COMPUTER_NATIVE_SCHEMA ||
			response.receiptId !== context.receiptId ||
			response.idempotencyKey !== context.idempotencyKey
		)
			throw new Error("OFFICE_NATIVE_RESULT_CHANGED");
		const content = officeNativeRecord(response.content, "kind,value");
		if (
			(content.kind !== "text" && content.kind !== "json") ||
			(content.kind === "text" && typeof content.value !== "string")
		)
			throw new Error("INVALID_OFFICE_NATIVE_RESULT");
		if (inline) {
			// Kept for the model only when they are exactly the published capture's, under this operation's receipt.
			if (
				typeof response.image !== "string" ||
				response.image.length % 4 !== 0 ||
				!/^[A-Za-z0-9+/]*={0,2}$/.test(response.image) ||
				content.kind !== "json"
			)
				throw new Error("INVALID_OFFICE_NATIVE_RESULT");
			const asset = parseCompanyComputerScreenshotAsset(content.value);
			if (asset.assetId !== context.receiptId || !this.#screenshots) throw new Error("INVALID_OFFICE_NATIVE_RESULT");
			this.#screenshots.holdInline(asset, Buffer.from(response.image, "base64"));
		}
		await this.#run.assertActive(signal);
		return structuredClone(content) as unknown as CompanyComputerToolContent;
	}
	async close(): Promise<void> {
		this.#closed = true;
		for (const [id, lease] of this.#leases) {
			const response = officeNativeRecord(
				await this.#call({ action: "release", lease }, new AbortController().signal),
				"leaseId,schema,state",
			);
			if (
				response.schema !== COMPANY_COMPUTER_NATIVE_SCHEMA ||
				response.state !== "released" ||
				response.leaseId !== id
			)
				throw new Error("OFFICE_NATIVE_RELEASE_UNCONFIRMED");
			this.#leases.delete(id);
		}
	}
}

export function createHttpCompanyComputerSessionFactory(options: {
	url: string;
	token: string;
	/** G2-6c: the run's holder credential, read per request (NativeHostDispatch.holderHeader). */
	holder: () => string;
	registry: HttpCloudCompanyComputerRegistry;
	fetch?: typeof fetch;
	objectGateway?: { baseUrl: string; token: string; holder?: () => string; fetch?: typeof fetch };
	/** The vault, for vault_fill (A1-3); without it every fill is refused before the office. */
	accountFills?: CompanyComputerAccountFills;
}): CloudCompanyComputerSessionFactory {
	// One computer, or every computer of the company: the run reaches the one its screen is on.
	const route = parseCompanyComputerNativeRoute(options.url);
	const reaches = (companyComputerId: string) =>
		route.companyComputerId === null || route.companyComputerId === companyComputerId;
	const objectGateway = options.objectGateway ? parseCompanyComputerCaptureGateway(options.objectGateway) : undefined;
	if (!/^[A-Za-z0-9_-]{43}$/.test(options.token)) throw new Error("INVALID_OFFICE_NATIVE_CONFIGURATION");
	return async (run, operations) => {
		if (run.identity.audienceKind !== "company") return undefined;
		const descriptor = parseCompanyComputerNativeDescriptor(
			await options.registry.call("qorpera_native_office_descriptor", { p_binding: run.binding }, run.signal),
			run,
		);
		if (!descriptor) {
			const start = parseCompanyComputerStartDescriptor(
				await options.registry.call(
					"qorpera_native_office_start_descriptor",
					{ p_binding: run.binding },
					run.signal,
				),
				run,
			);
			// A one-computer route cannot reach another of the company's computers: the
			// run goes on without computer tools instead of failing as a whole.
			if (!start || !reaches(start.scope.companyComputerId)) return undefined;
			return createCompanyComputerStartSession({
				run,
				operations,
				descriptor: start,
				registry: options.registry,
				reaches,
			});
		}
		if (!reaches(descriptor.scope.companyComputerId)) return undefined;
		const url = route.urlFor(descriptor.scope.companyComputerId);
		// One capture reader for the run: the endpoint keeps a screenshot's pixels there, and the boundary reads them.
		const screenshots = objectGateway
			? createHttpCompanyComputerScreenshots({
					run,
					scope: descriptor.scope,
					registry: options.registry,
					objectGateway,
				})
			: undefined;
		const remote = new HttpCompanyComputerNativeEndpoint({
			...options,
			url,
			run,
			descriptor,
			...(screenshots ? { screenshots } : {}),
		});
		const session = createCloudCompanyComputerSession({
			run,
			operations,
			scope: descriptor.scope,
			control: options.registry,
			endpoint: remote,
		});
		return {
			tools: session.tools,
			...(screenshots ? { captures: new CloudNativeCaptureImages(screenshots) } : {}),
			close: async () => {
				try {
					await remote.close();
				} finally {
					await session.close();
				}
			},
		};
	};
}
