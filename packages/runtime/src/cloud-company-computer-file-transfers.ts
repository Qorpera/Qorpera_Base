import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerLease,
	assertCompanyComputerScope,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerEffectContext,
	type CompanyComputerOperation,
	type CompanyComputerScope,
	type CompanyComputerScreenLease,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	CLOUD_FILE_TRANSFER_MAX_BYTES,
	type CompanyComputerFileExportAsset,
	parseCompanyComputerFileExport,
	parseCompanyComputerFileExportAsset,
} from "@qorpera/cloud-client/cloud-file-transfer";
import type { CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";
import type { HttpCloudCompanyComputerRegistry } from "./cloud-company-computer-registry-http.ts";
import { HttpNativeCompanyObjectTransport } from "./cloud-native-company-objects.ts";
import { type CloudNativeToolRun, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import { cloudNativeToolOperationEnvelope } from "./cloud-native-tool-operations.ts";

export interface CompanyComputerFileExportPublisher {
	publish(
		bytes: Uint8Array,
		lease: CompanyComputerScreenLease,
		context: CompanyComputerEffectContext,
		operation: CompanyComputerOperation,
	): Promise<CompanyComputerFileExportAsset>;
}

/** Staging is immutable and does not publish. SQL binds publication to the
 * original admitted operation, current authority, source path and stored bytes. */
export class CloudCompanyComputerFileExports implements CompanyComputerFileExportPublisher {
	readonly #run: CloudNativeToolRun;
	readonly #scope: CompanyComputerScope;
	readonly #registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
	readonly #objects: (signal: AbortSignal) => Pick<CloudObjectTransport, "put">;
	constructor(options: {
		run: CloudNativeToolRun;
		scope: CompanyComputerScope;
		registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
		objects: (signal: AbortSignal) => Pick<CloudObjectTransport, "put">;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		if (
			options.run.identity.companyId !== options.scope.companyId ||
			options.run.identity.environmentId !== options.scope.environmentId ||
			options.run.identity.audienceKind !== "company" ||
			options.run.identity.audienceUserId !== null
		)
			throw new Error("COMPUTER_RUN_MISMATCH");
		this.#run = options.run;
		this.#scope = Object.freeze({ ...options.scope });
		this.#registry = options.registry;
		this.#objects = options.objects;
	}
	async publish(
		bytes: Uint8Array,
		lease: CompanyComputerScreenLease,
		context: CompanyComputerEffectContext,
		operation: CompanyComputerOperation,
	): Promise<CompanyComputerFileExportAsset> {
		bytes = Uint8Array.from(bytes);
		lease = structuredClone(lease);
		operation = structuredClone(operation);
		const { receiptId, idempotencyKey } = context;
		assertCompanyComputerScope(lease.binding, this.#scope);
		assertCompanyComputerLease(lease, lease.binding, {
			kind: "agent",
			runId: this.#run.identity.runId,
			staffAgentId: this.#run.identity.staffAgentId,
		});
		const action = parseCompanyComputerFileExport(operation.arguments);
		if (
			!isDeepStrictEqual(context.identity, this.#run.identity) ||
			!COMPANY_COMPUTER_UUID.test(receiptId) ||
			!/^[0-9a-f]{64}$/.test(idempotencyKey) ||
			operation.tool !== "computer_transfer" ||
			!isDeepStrictEqual(operation.target.binding, lease.binding) ||
			bytes.length > CLOUD_FILE_TRANSFER_MAX_BYTES
		)
			throw new Error("INVALID_OFFICE_FILE_EXPORT");
		const file = {
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length,
			mediaType: action.mediaType,
		};
		const args = {
			p_binding: this.#run.binding,
			p_scope: this.#scope,
			p_lease: lease,
			p_envelope: cloudNativeToolOperationEnvelope(this.#run.identity, operation),
			p_receipt_id: receiptId,
			p_idempotency_sha256: createHash("sha256").update(idempotencyKey).digest("hex"),
			p_file: file,
		};
		return cloudToolRequest(
			async (signal) => {
				await this.#run.assertActive(signal);
				const authorized = await this.#registry.call(
					"qorpera_native_office_file_export",
					{ ...args, p_action: "authorize" },
					signal,
				);
				if (!isDeepStrictEqual(authorized, { state: "authorized" }))
					throw new Error("OFFICE_FILE_EXPORT_UNCONFIRMED");
				signal.throwIfAborted();
				const stored = await this.#objects(signal).put(
					`${this.#scope.companyId}/${file.sha256}`,
					bytes,
					file.mediaType,
				);
				if (stored !== "stored" && stored !== "exists") throw new Error("OFFICE_FILE_EXPORT_UNCONFIRMED");
				signal.throwIfAborted();
				const asset = parseCompanyComputerFileExportAsset(
					await this.#registry.call("qorpera_native_office_file_export", { ...args, p_action: "publish" }, signal),
				);
				if (
					!isDeepStrictEqual(asset, {
						schema: "qorpera.file-transfer-asset/v1",
						assetId: asset.assetId,
						...file,
						source: {
							...action.source,
							companyComputerId: this.#scope.companyComputerId,
							screenId: lease.binding.screenId,
						},
						destination: action.destination,
					})
				)
					throw new Error("OFFICE_FILE_EXPORT_UNCONFIRMED");
				signal.throwIfAborted();
				return asset;
			},
			AbortSignal.any([context.signal, this.#run.signal]),
			15000,
		);
	}
}

export function createHttpCompanyComputerFileExports(options: {
	run: CloudNativeToolRun;
	scope: CompanyComputerScope;
	registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
	objectGateway: { baseUrl: string; token: string; fetch?: typeof fetch };
}): CloudCompanyComputerFileExports {
	return new CloudCompanyComputerFileExports({
		...options,
		objects: (signal) =>
			new HttpNativeCompanyObjectTransport({
				...options.objectGateway,
				companyId: options.scope.companyId,
				binding: options.run.binding,
				signal,
			}),
	});
}
