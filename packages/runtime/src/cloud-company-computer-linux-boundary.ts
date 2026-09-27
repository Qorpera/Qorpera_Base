import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScreenBinding,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	type CompanyComputerStartupIdentity,
	companyComputerBootAdoptionReceiptPath,
	companyComputerResetAdoptionReceiptPath,
	parseCompanyComputerBootAdoptionReceipt,
	parseCompanyComputerOutageAdoptionReceipt,
	parseCompanyComputerResetAdoptionReceipt,
	parseCompanyComputerStartupIdentity,
} from "@qorpera/contracts";
import type { CompanyComputerGuestBoundary } from "./cloud-company-computer-guest.ts";
import { assertCompanyComputerGuestLayout } from "./cloud-company-computer-layout.ts";
import type { CompanyComputerLinuxGuestOptions } from "./cloud-company-computer-linux-guest.ts";
import {
	assertCompanyComputerImageArtifact,
	assertCompanyComputerLinuxHost,
	assertCompanyComputerWorkbenchMount,
	openCompanyComputerLinuxDirectory,
	readCompanyComputerLinuxMetadata,
} from "./cloud-company-computer-linux-host.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

const SHA256 = /^[0-9a-f]{64}$/;

/** Protected provider bootstrap configuration, never member/model input.
 * Reboot or replacement requires a fresh boot attestation. */
export interface CompanyComputerLinuxGuestAttestation {
	allocationId: string;
	instanceSha256: string;
	imageSha256: string;
	bootstrapSha256: string;
	bootId: string;
	adoptionReceiptPath: string;
	adoptionReceiptSha256: string;
}

type BoundaryOptions = Pick<
	CompanyComputerLinuxGuestOptions,
	| "scope"
	| "computerGeneration"
	| "layout"
	| "limits"
	| "workbenchMount"
	| "privateWorkbenchMount"
	| "displayRuntimeRoot"
	| "browserRuntimeRoot"
	| "captureRoot"
	| "registry"
> & { attestation: CompanyComputerLinuxGuestAttestation; startupIdentity?: CompanyComputerStartupIdentity };

/** Current cloud allocation plus protected adoption and physical Linux checks.
 * No copying, directory creation or activation. The completed receipt records
 * separately authorized inventory review; it cannot grant browser access. */
export class CompanyComputerLinuxBoundary implements CompanyComputerGuestBoundary {
	readonly #options: BoundaryOptions;
	constructor(options: BoundaryOptions) {
		assertCompanyComputerScope(options.scope, options.scope);
		assertCompanyComputerGuestLayout(options.layout);
		const attestation = options.attestation;
		const roots = [
			...Object.values(options.layout),
			options.privateWorkbenchMount.mountPoint,
			options.displayRuntimeRoot,
			options.browserRuntimeRoot,
			options.captureRoot,
		];
		for (const mount of [options.workbenchMount, options.privateWorkbenchMount]) {
			if (
				Object.keys(mount).sort().join() !== "filesystem,mountPoint,root,source" ||
				Object.values(mount).some(
					(value) => typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value),
				) ||
				mount.root !== resolve(mount.root) ||
				mount.mountPoint !== resolve(mount.mountPoint) ||
				mount.mountPoint === "/"
			)
				throw new Error("INVALID_OFFICE_STORAGE_BINDING");
		}
		if (
			!["nfs", "nfs4", "virtiofs", "ext4", "xfs", "btrfs", "zfs"].includes(options.workbenchMount.filesystem) ||
			options.privateWorkbenchMount.filesystem !== "tmpfs" ||
			options.privateWorkbenchMount.source !== "tmpfs" ||
			options.privateWorkbenchMount.root !== "/" ||
			roots.some(
				(root, index) =>
					root !== resolve(root) ||
					root === "/" ||
					root.length > 4096 ||
					/[\x00-\x1f\x7f\\]/.test(root) ||
					roots.some(
						(other, otherIndex) => index !== otherIndex && (root === other || root.startsWith(`${other}/`)),
					),
			)
		)
			throw new Error("INVALID_OFFICE_STORAGE_BINDING");
		if (
			!Number.isSafeInteger(options.computerGeneration) ||
			options.computerGeneration < 1 ||
			!attestation ||
			Object.keys(attestation).sort().join() !==
				"adoptionReceiptPath,adoptionReceiptSha256,allocationId,bootId,bootstrapSha256,imageSha256,instanceSha256" ||
			!COMPANY_COMPUTER_UUID.test(attestation.allocationId) ||
			!COMPANY_COMPUTER_UUID.test(attestation.bootId) ||
			![
				attestation.instanceSha256,
				attestation.imageSha256,
				attestation.bootstrapSha256,
				attestation.adoptionReceiptSha256,
			].every((value) => typeof value === "string" && SHA256.test(value)) ||
			typeof attestation.adoptionReceiptPath !== "string" ||
			attestation.adoptionReceiptPath !== resolve(attestation.adoptionReceiptPath) ||
			attestation.adoptionReceiptPath === "/" ||
			attestation.adoptionReceiptPath.length > 4096 ||
			/[\x00-\x1f\x7f\\]/.test(attestation.adoptionReceiptPath) ||
			roots.some(
				(root) =>
					attestation.adoptionReceiptPath === root || attestation.adoptionReceiptPath.startsWith(`${root}/`),
			)
		)
			throw new Error("INVALID_OFFICE_GUEST_ATTESTATION");
		this.#options = {
			...options,
			...(options.startupIdentity
				? { startupIdentity: parseCompanyComputerStartupIdentity(options.startupIdentity) }
				: {}),
			scope: { ...options.scope },
			layout: { ...options.layout },
			limits: { ...options.limits },
			workbenchMount: { ...options.workbenchMount },
			privateWorkbenchMount: { ...options.privateWorkbenchMount },
			attestation: { ...attestation },
		};
	}

	async assertReady(binding: CompanyComputerScreenBinding, signal: AbortSignal): Promise<void> {
		assertCompanyComputerScreenBinding(binding, binding);
		assertCompanyComputerScope(binding, this.#options.scope);
		if (binding.computerGeneration !== this.#options.computerGeneration)
			throw new Error("OFFICE_GENERATION_MISMATCH");
		await this.assertOfficeReady(signal);
	}

	/** Startup has no screen yet. Effects and shared/private idle renewals use
	 * the same check again; a previous successful read is never cached authority. */
	async assertOfficeReady(signal: AbortSignal): Promise<void> {
		return this.#assertReady(signal, false);
	}
	/** Read-only physical preflight for a separately authorized startup. This
	 * grants no screen/effect/viewer authority; those always use assertOfficeReady. */
	async assertPhysicalReady(signal: AbortSignal): Promise<void> {
		return this.#assertReady(signal, true);
	}
	async #assertReady(signal: AbortSignal, physicalOnly: boolean): Promise<void> {
		const options = this.#options;
		const attestation = options.attestation;
		try {
			await cloudToolRequest(
				async (checked) => {
					await assertCompanyComputerLinuxHost(options.limits, checked);
					if (
						(await readCompanyComputerLinuxMetadata("/proc/sys/kernel/random/boot_id", 64)).trim() !==
						attestation.bootId
					)
						throw new Error("boot differs");
					await assertCompanyComputerImageArtifact(attestation.adoptionReceiptPath);
					const text = await readCompanyComputerLinuxMetadata(attestation.adoptionReceiptPath, 16384);
					if (createHash("sha256").update(text).digest("hex") !== attestation.adoptionReceiptSha256)
						throw new Error("adoption receipt changed");
					const receipt = JSON.parse(text) as Record<string, unknown>;
					if (
						receipt?.schema === "qorpera.office-state-retained/v1" ||
						receipt?.schema === "qorpera.office-state-outage-retained/v1"
					) {
						const retained =
							receipt.schema === "qorpera.office-state-outage-retained/v1"
								? parseCompanyComputerOutageAdoptionReceipt(receipt)
								: parseCompanyComputerBootAdoptionReceipt(receipt);
						if (
							attestation.adoptionReceiptPath !== companyComputerBootAdoptionReceiptPath(attestation.bootId) ||
							!isDeepStrictEqual(
								{
									scope: retained.scope,
									computerGeneration: retained.computerGeneration,
									allocationId: retained.allocationId,
									instanceSha256: retained.instanceSha256,
									imageSha256: retained.imageSha256,
									bootstrapSha256: retained.bootstrapSha256,
									bootId: retained.bootId,
									layout: retained.layout,
									workbenchMount: retained.workbenchMount,
								},
								{
									scope: options.scope,
									computerGeneration: options.computerGeneration,
									allocationId: attestation.allocationId,
									instanceSha256: attestation.instanceSha256,
									imageSha256: attestation.imageSha256,
									bootstrapSha256: attestation.bootstrapSha256,
									bootId: attestation.bootId,
									layout: options.layout,
									workbenchMount: options.workbenchMount,
								},
							)
						)
							throw new Error("retained adoption differs");
					} else {
						// A reset-born boot keeps the original attested receipt (the registry
						// pins its digest); its boot is bound through the recreated root's
						// retained reset receipt, which must name this boot and this origin.
						let originBootId = attestation.bootId;
						if (receipt?.bootId !== attestation.bootId) {
							const retainedPath = companyComputerResetAdoptionReceiptPath(attestation.bootId);
							await assertCompanyComputerImageArtifact(retainedPath);
							const retained = parseCompanyComputerResetAdoptionReceipt(
								JSON.parse(await readCompanyComputerLinuxMetadata(retainedPath, 16384)),
							);
							if (
								retained.bootId !== attestation.bootId ||
								retained.origin.adoptionReceiptSha256 !== attestation.adoptionReceiptSha256 ||
								retained.origin.bootId !== receipt?.bootId ||
								!isDeepStrictEqual(
									{
										scope: retained.scope,
										computerGeneration: retained.computerGeneration,
										allocationId: retained.allocationId,
										instanceSha256: retained.instanceSha256,
										imageSha256: retained.imageSha256,
										bootstrapSha256: retained.bootstrapSha256,
										layout: retained.layout,
										workbenchMount: retained.workbenchMount,
									},
									{
										scope: options.scope,
										computerGeneration: options.computerGeneration,
										allocationId: attestation.allocationId,
										instanceSha256: attestation.instanceSha256,
										imageSha256: attestation.imageSha256,
										bootstrapSha256: attestation.bootstrapSha256,
										layout: options.layout,
										workbenchMount: options.workbenchMount,
									},
								)
							)
								throw new Error("reset retained receipt differs");
							originBootId = retained.origin.bootId;
						}
						const expected = {
							schema: "qorpera.office-state-adoption/v1",
							state: "complete",
							scope: options.scope,
							computerGeneration: options.computerGeneration,
							allocationId: attestation.allocationId,
							instanceSha256: attestation.instanceSha256,
							imageSha256: attestation.imageSha256,
							bootstrapSha256: attestation.bootstrapSha256,
							bootId: originBootId,
							layout: options.layout,
							workbenchMount: options.workbenchMount,
							disposition: receipt?.disposition,
							inventorySha256: receipt?.inventorySha256,
							reviewSha256: receipt?.reviewSha256,
						};
						if (
							!isDeepStrictEqual(receipt, expected) ||
							!["verified_empty", "migration_completed"].includes(receipt.disposition as string) ||
							typeof receipt.inventorySha256 !== "string" ||
							!SHA256.test(receipt.inventorySha256) ||
							typeof receipt.reviewSha256 !== "string" ||
							!SHA256.test(receipt.reviewSha256)
						)
							throw new Error("adoption incomplete");
					}
					const roots = Object.values(options.layout);
					for (const path of roots) {
						const directory = await openCompanyComputerLinuxDirectory(path, true);
						try {
							await assertCompanyComputerWorkbenchMount(directory, options.workbenchMount, roots);
						} finally {
							await directory.close();
						}
					}
					const privateRoot = await openCompanyComputerLinuxDirectory(
						options.privateWorkbenchMount.mountPoint,
						true,
					);
					try {
						await assertCompanyComputerWorkbenchMount(privateRoot, options.privateWorkbenchMount, [
							options.privateWorkbenchMount.mountPoint,
						]);
					} finally {
						await privateRoot.close();
					}
					checked.throwIfAborted();
					if (physicalOnly) return;
					const startup = options.startupIdentity;
					if (
						!startup ||
						!isDeepStrictEqual(startup.scope, options.scope) ||
						startup.computerGeneration !== options.computerGeneration ||
						startup.allocationId !== attestation.allocationId ||
						startup.instanceSha256 !== attestation.instanceSha256 ||
						startup.imageSha256 !== attestation.imageSha256 ||
						startup.bootstrapSha256 !== attestation.bootstrapSha256 ||
						startup.bootId !== attestation.bootId
					)
						throw new Error("work startup identity differs");
					const started = performance.now();
					const response = await options.registry.call(
						"qorpera_check_runtime_office_work_binding",
						{ p_startup: structuredClone(startup) },
						checked,
					);
					if (
						!response ||
						typeof response !== "object" ||
						Array.isArray(response) ||
						Object.keys(response).sort().join() !== "computerGeneration,state,validForMs" ||
						!("state" in response) ||
						response.state !== "authorized" ||
						!("computerGeneration" in response) ||
						response.computerGeneration !== options.computerGeneration ||
						!("validForMs" in response) ||
						!Number.isSafeInteger(response.validForMs) ||
						(response.validForMs as number) < 1 ||
						(response.validForMs as number) > 5000 ||
						started + (response.validForMs as number) <= performance.now()
					)
						throw new Error("authority unavailable");
					checked.throwIfAborted();
				},
				signal,
				5000,
			);
		} catch {
			throw new Error("OFFICE_GUEST_READINESS_UNCONFIRMED");
		}
	}
}
