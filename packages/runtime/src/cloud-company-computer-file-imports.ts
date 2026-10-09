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
	type CompanyComputerFileImportResult,
	parseCompanyComputerFileExportAsset,
	parseCompanyComputerFileImport,
	parseCompanyComputerFileImportResult,
	parseCompanyFileTransferSource,
} from "@qorpera/cloud-client/cloud-file-transfer";
import type { CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";
import type { HttpCloudCompanyComputerRegistry } from "./cloud-company-computer-registry-http.ts";
import { readCompanyFileTransfer } from "./cloud-company-file-transfer-reader.ts";
import { type CloudNativeToolRun, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import { cloudNativeToolOperationEnvelope } from "./cloud-native-tool-operations.ts";

export interface CompanyComputerFileImporter {
	perform(
		lease: CompanyComputerScreenLease,
		context: CompanyComputerEffectContext,
		operation: CompanyComputerOperation,
		write: (file: { path: string; bytes: Uint8Array; sha256: string }, signal: AbortSignal) => Promise<unknown>,
	): Promise<CompanyComputerFileImportResult>;
}

/** Current receipt-bound read permission selects one completed shared export.
 * An arbitrary hash or artifact ID grants nothing. The physical writer is bound
 * to this office; SQL records provenance only after its confirmed publication.
 * The office no longer wires it: its bytes came through company objects, which are gone (legacy removal, step C). */
export class CloudCompanyComputerFileImports implements CompanyComputerFileImporter {
	readonly #run: CloudNativeToolRun;
	readonly #scope: CompanyComputerScope;
	readonly #registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
	readonly #objects: (signal: AbortSignal) => Pick<CloudObjectTransport, "get">;
	constructor(options: {
		run: CloudNativeToolRun;
		scope: CompanyComputerScope;
		registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
		objects: (signal: AbortSignal) => Pick<CloudObjectTransport, "get">;
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
	async perform(
		lease: CompanyComputerScreenLease,
		context: CompanyComputerEffectContext,
		operation: CompanyComputerOperation,
		write: Parameters<CompanyComputerFileImporter["perform"]>[3],
	): Promise<CompanyComputerFileImportResult> {
		lease = structuredClone(lease);
		operation = structuredClone(operation);
		const { receiptId, idempotencyKey } = context,
			action = parseCompanyComputerFileImport(operation.arguments);
		assertCompanyComputerScope(lease.binding, this.#scope);
		assertCompanyComputerLease(lease, lease.binding, {
			kind: "agent",
			runId: this.#run.identity.runId,
			staffAgentId: this.#run.identity.staffAgentId,
		});
		if (
			!isDeepStrictEqual(context.identity, this.#run.identity) ||
			!COMPANY_COMPUTER_UUID.test(receiptId) ||
			!/^[a-f0-9]{64}$/.test(idempotencyKey) ||
			operation.tool !== "computer_transfer" ||
			!isDeepStrictEqual(operation.target.binding, lease.binding)
		)
			throw new Error("INVALID_OFFICE_FILE_IMPORT");
		const args = {
			p_binding: this.#run.binding,
			p_scope: this.#scope,
			p_lease: lease,
			p_envelope: cloudNativeToolOperationEnvelope(this.#run.identity, operation),
			p_receipt_id: receiptId,
			p_idempotency_sha256: createHash("sha256").update(idempotencyKey).digest("hex"),
		};
		return cloudToolRequest(
			async (signal) => {
				await this.#run.assertActive(signal);
				const authorize = async () => {
					const value = await this.#registry.call(
						"qorpera_native_office_file_import",
						{ ...args, p_action: "authorize" },
						signal,
					);
					return action.source.realm === "company_file"
						? parseCompanyFileTransferSource(value)
						: parseCompanyComputerFileExportAsset(value);
				};
				const asset = await authorize();
				if (
					asset.schema === "qorpera.company-file-transfer-source/v1"
						? asset.companyId !== this.#scope.companyId ||
							asset.environmentId !== this.#scope.environmentId ||
							!isDeepStrictEqual(asset.source, action.source)
						: action.source.realm !== "object_storage" ||
							asset.assetId !== action.source.assetId ||
							asset.sha256 !== action.source.sha256
				)
					throw new Error("OFFICE_IMPORT_SOURCE_CHANGED");
				signal.throwIfAborted();
				const bytes =
					asset.schema === "qorpera.company-file-transfer-source/v1"
						? await readCompanyFileTransfer(asset, this.#objects(signal), signal)
						: Uint8Array.from(await this.#objects(signal).get(`${this.#scope.companyId}/${asset.sha256}`));
				if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
					throw new Error("OFFICE_IMPORT_SOURCE_CHANGED");
				if (!isDeepStrictEqual(await authorize(), asset)) throw new Error("OFFICE_IMPORT_SOURCE_CHANGED");
				signal.throwIfAborted();
				await write({ path: action.destination.path, bytes, sha256: asset.sha256 }, signal);
				signal.throwIfAborted();
				const result = parseCompanyComputerFileImportResult(
					await this.#registry.call("qorpera_native_office_file_import", { ...args, p_action: "confirm" }, signal),
				);
				if (
					!isDeepStrictEqual(result, {
						schema: "qorpera.file-import-result/v1",
						transferId: receiptId,
						source:
							asset.schema === "qorpera.company-file-transfer-source/v1"
								? {
										...action.source,
										assetId: result.source.assetId,
										sha256: asset.sha256,
										manifestSha256: asset.manifestSha256,
									}
								: action.source,
						destination: {
							...action.destination,
							companyComputerId: this.#scope.companyComputerId,
							screenId: lease.binding.screenId,
						},
						bytes: asset.bytes,
						mediaType: asset.mediaType,
					})
				)
					throw new Error("OFFICE_IMPORT_UNCONFIRMED");
				signal.throwIfAborted();
				return result;
			},
			AbortSignal.any([context.signal, this.#run.signal]),
			15000,
		);
	}
}
