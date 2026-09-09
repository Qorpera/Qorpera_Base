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
import type { JsonValue } from "@qorpera/contracts";
import {
	type CloudCompanyComputerSessionFactory,
	createCloudCompanyComputerSession,
} from "./cloud-company-computer-control.ts";
import { CloudCompanyComputerEffectControl } from "./cloud-company-computer-effect-control.ts";
import type { HttpCloudCompanyComputerRegistry } from "./cloud-company-computer-registry-http.ts";
import {
	createHttpCompanyComputerScreenshots,
	parseCompanyComputerCaptureGateway,
} from "./cloud-company-computer-screenshots.ts";
import {
	createCompanyComputerStartSession,
	parseCompanyComputerStartDescriptor,
} from "./cloud-company-computer-start.ts";
import type { CompanyComputerCloudEndpoint } from "./cloud-company-computer-tools.ts";
import { CloudNativeCaptureImages } from "./cloud-native-capture-images.ts";
import { type CloudNativeToolRun, cloudToolRequest } from "./cloud-native-tool-authority.ts";

export const COMPANY_COMPUTER_NATIVE_SCHEMA = "qorpera.company-computer-native/v1";
export const COMPANY_COMPUTER_NATIVE_MAX_REQUEST = 96 * 1024;
export const COMPANY_COMPUTER_NATIVE_MAX_RESPONSE = 48 * 1024;
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

export function parseCompanyComputerNativeUrl(value: string): { url: string; companyComputerId: string } {
	const url = new URL(value);
	const match = /^\/office\/([^/]+)\/native$/.exec(url.pathname);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.href !== value ||
		!match ||
		!COMPANY_COMPUTER_UUID.test(match[1])
	)
		throw new Error("INVALID_OFFICE_NATIVE_URL");
	return { url: url.href, companyComputerId: match[1] };
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
	readonly #fetch: typeof fetch;
	readonly #leases = new Map<string, CompanyComputerScreenLease>();
	#closed = false;

	constructor(options: {
		run: CloudNativeToolRun;
		descriptor: CompanyComputerNativeDescriptor;
		url: string;
		token: string;
		registry: HttpCloudCompanyComputerRegistry;
		fetch?: typeof fetch;
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
		this.#fetch = options.fetch ?? fetch;
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
	async #call(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		const encoded = JSON.stringify({
			schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
			nativeBinding: this.#run.binding,
			...body,
		});
		if (Buffer.byteLength(encoded) > COMPANY_COMPUTER_NATIVE_MAX_REQUEST)
			throw new Error("OFFICE_NATIVE_REQUEST_TOO_LARGE");
		try {
			return await cloudToolRequest(
				async (s) => {
					const response = await this.#fetch(this.#url, {
						method: "POST",
						redirect: "error",
						signal: s,
						headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
						body: encoded,
					});
					if (!response.ok) {
						void response.body?.cancel().catch(() => undefined);
						throw new Error("unconfirmed");
					}
					const bytes = await readBoundedCloudResponse(response, COMPANY_COMPUTER_NATIVE_MAX_RESPONSE, s);
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
		// Retain cleanup after ambiguous delivery. Never mark a remote session
		// unused just because its response was lost or its caller was cancelled.
		this.#leases.set(lease.leaseId, structuredClone(lease));
		const response = officeNativeRecord(
			await this.#call(
				{
					action: "perform",
					operation,
					lease,
					receipt: { receiptId: context.receiptId, idempotencyKey: context.idempotencyKey },
				},
				signal,
			),
			"content,idempotencyKey,receiptId,schema",
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
	registry: HttpCloudCompanyComputerRegistry;
	fetch?: typeof fetch;
	objectGateway?: { baseUrl: string; token: string; fetch?: typeof fetch };
}): CloudCompanyComputerSessionFactory {
	const endpoint = parseCompanyComputerNativeUrl(options.url);
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
			if (!start) return undefined;
			if (start.scope.companyComputerId !== endpoint.companyComputerId)
				throw new Error("OFFICE_NATIVE_CONFIGURATION_DIFFERS");
			return createCompanyComputerStartSession({ run, operations, descriptor: start, registry: options.registry });
		}
		if (descriptor.scope.companyComputerId !== endpoint.companyComputerId)
			throw new Error("OFFICE_NATIVE_CONFIGURATION_DIFFERS");
		const remote = new HttpCompanyComputerNativeEndpoint({ ...options, run, descriptor });
		const session = createCloudCompanyComputerSession({
			run,
			operations,
			scope: descriptor.scope,
			control: options.registry,
			endpoint: remote,
		});
		return {
			tools: session.tools,
			...(objectGateway
				? {
						captures: new CloudNativeCaptureImages(
							createHttpCompanyComputerScreenshots({
								run,
								scope: descriptor.scope,
								registry: options.registry,
								objectGateway,
							}),
						),
					}
				: {}),
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
