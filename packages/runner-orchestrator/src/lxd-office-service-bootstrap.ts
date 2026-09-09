import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { createSecureContext } from "node:tls";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	type CompanyComputerPreparationCommand,
	type CompanyComputerPreparationRequest,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerConfigurationRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { readLxdOfficeCredentialFile, readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";
import { lxdOfficeProviderBindingSha256 } from "./lxd-office-start-control.ts";

export const OFFICE_SERVICE_CREDENTIALS = ["registry", "native", "objects", "tlsCert", "tlsKey"] as const;
type Credential = (typeof OFFICE_SERVICE_CREDENTIALS)[number];
/** Root-owned provider input for one existing allocation. The signed image's
 * bootstrap hash remains an image identity; this document has its own digest
 * retained by the configuration journal before any guest mutation. */
export interface LxdOfficeServiceBootstrap {
	schema: "qorpera.lxd-office-service-bootstrap/v1";
	providerBindingSha256: string;
	registryUrl: string;
	captureObjectGatewayUrl: string;
	native: { host: string; port: number };
	viewer: { host: string; port: number; origins: string[] };
	credentials: Record<Credential, { path: string; bytes: number; sha256: string }>;
}
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function endpoint(value: unknown): void {
	if (typeof value !== "string" || value.length > 2048) throw new Error("endpoint");
	const url = new URL(value);
	if (url.protocol !== "https:" || url.origin !== value) throw new Error("endpoint");
}
export function parseLxdOfficeServiceBootstrap(
	value: unknown,
	binding: LxdOfficeGuestBinding,
): LxdOfficeServiceBootstrap {
	try {
		const input = officeRecord(value, [
			"schema",
			"providerBindingSha256",
			"registryUrl",
			"captureObjectGatewayUrl",
			"native",
			"viewer",
			"credentials",
		]);
		if (
			input.schema !== "qorpera.lxd-office-service-bootstrap/v1" ||
			officeSha(input.providerBindingSha256) !== lxdOfficeProviderBindingSha256(binding)
		)
			throw new Error("binding");
		endpoint(input.registryUrl);
		endpoint(input.captureObjectGatewayUrl);
		const native = officeRecord(input.native, ["host", "port"]),
			viewer = officeRecord(input.viewer, ["host", "port", "origins"]);
		for (const listener of [native, viewer]) {
			if (
				typeof listener.host !== "string" ||
				!isIP(listener.host) ||
				!Number.isSafeInteger(listener.port) ||
				(listener.port as number) < 1 ||
				(listener.port as number) > 65535
			)
				throw new Error("listener");
		}
		if (
			native.port === viewer.port ||
			!Array.isArray(viewer.origins) ||
			viewer.origins.length < 1 ||
			viewer.origins.length > 16 ||
			new Set(viewer.origins).size !== viewer.origins.length
		)
			throw new Error("listeners");
		for (const origin of viewer.origins) endpoint(origin);
		const credentials = officeRecord(input.credentials, OFFICE_SERVICE_CREDENTIALS);
		const paths = new Set<string>();
		for (const name of OFFICE_SERVICE_CREDENTIALS) {
			const ref = officeRecord(credentials[name], ["path", "bytes", "sha256"]);
			const path = officePhysicalPath(ref.path);
			if (
				paths.has(path) ||
				!Number.isSafeInteger(ref.bytes) ||
				(ref.bytes as number) < 1 ||
				(ref.bytes as number) > COMPANY_COMPUTER_CONFIGURATION_LIMITS[name]
			)
				throw new Error("credential");
			paths.add(path);
			officeSha(ref.sha256);
		}
		if (Buffer.byteLength(JSON.stringify(input)) > 16384) throw new Error("size");
		return structuredClone(input) as unknown as LxdOfficeServiceBootstrap;
	} catch {
		throw new Error("INVALID_OFFICE_SERVICE_BOOTSTRAP");
	}
}

/** Resolves only protected local files. Raw credential buffers are cleared on
 * every exit; the caller owns and must clear the returned confidential body.
 * No secrets are returned in diagnostics or retained public observations. */
export async function createLxdOfficeConfigurationPayload(
	path: string,
	binding: LxdOfficeGuestBinding,
	preparationRequest: CompanyComputerPreparationRequest,
	preparationCommand: CompanyComputerPreparationCommand,
	signal: AbortSignal,
	ports: {
		readProtected?: typeof readLxdOfficeProtectedFile;
		readCredential?: typeof readLxdOfficeCredentialFile;
	} = {},
) {
	const buffers: Buffer[] = [];
	try {
		signal.throwIfAborted();
		const planBytes = await (ports.readProtected ?? readLxdOfficeProtectedFile)(path, 16384);
		const plan = parseLxdOfficeServiceBootstrap(
			JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(planBytes)),
			binding,
		);
		const request = parseCompanyComputerPreparationRequest(preparationRequest),
			preparation = parseCompanyComputerPreparationCommand(preparationCommand);
		if (
			request.bootId !== preparation.bootId ||
			request.allocationId !== binding.allocationId ||
			request.instanceSha256 !== lxdOfficeGuestPlan(binding).instanceSha256 ||
			request.bootstrapSha256 !== binding.bootstrapSha256 ||
			request.imageSha256 !== binding.imageFingerprint ||
			request.computerGeneration !== binding.computerGeneration ||
			Object.entries(request.scope).some(([key, value]) => binding[key as keyof LxdOfficeGuestBinding] !== value)
		)
			throw new Error("preparation");
		const secrets = {} as Record<Credential, string>;
		for (const name of OFFICE_SERVICE_CREDENTIALS) {
			signal.throwIfAborted();
			const ref = plan.credentials[name];
			const bytes = await (ports.readCredential ?? readLxdOfficeCredentialFile)(
				ref.path,
				COMPANY_COMPUTER_CONFIGURATION_LIMITS[name],
			);
			buffers.push(bytes);
			if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) throw new Error("credential");
			secrets[name] = new TextDecoder("utf8", { fatal: true }).decode(bytes);
		}
		createSecureContext({ cert: secrets.tlsCert, key: secrets.tlsKey, minVersion: "TLSv1.3" });
		const receipt = companyComputerPreparationAdoptionReceipt(request);
		const configuration = JSON.stringify({
			schema: "qorpera.company-computer-service/v1",
			scope: request.scope,
			computerGeneration: request.computerGeneration,
			registryUrl: plan.registryUrl,
			captureObjectGatewayUrl: plan.captureObjectGatewayUrl,
			native: plan.native,
			viewer: plan.viewer,
			linux: {
				layout: receipt.layout,
				limits: request.limits,
				workbenchMount: request.workbenchMount,
				privateWorkbenchMount: {
					filesystem: "tmpfs",
					source: "tmpfs",
					root: "/",
					mountPoint: "/run/qorpera-office/private",
				},
				displayRuntimeRoot: "/run/qorpera-office/display",
				browserRuntimeRoot: "/run/qorpera-office/browser",
				captureRoot: "/run/qorpera-office/captures",
				attestation: {
					allocationId: request.allocationId,
					instanceSha256: request.instanceSha256,
					imageSha256: request.imageSha256,
					bootstrapSha256: request.bootstrapSha256,
					bootId: request.bootId,
					adoptionReceiptPath: COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
					adoptionReceiptSha256: hash(`${JSON.stringify(receipt)}\n`),
				},
			},
		});
		const payload = parseCompanyComputerConfigurationRequest({
			schema: "qorpera.office-configuration-request/v1",
			preparation,
			configuration,
			...secrets,
		});
		signal.throwIfAborted();
		return { plan, planBytesSha256: hash(planBytes), bytes: Buffer.from(JSON.stringify(payload)) };
	} catch {
		throw new Error("OFFICE_CONFIGURATION_CREDENTIALS_UNCONFIRMED");
	} finally {
		for (const bytes of buffers) bytes.fill(0);
	}
}
