import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerCodePackageProvisionPlan,
	type CompanyComputerCodePackageProvisionRequest,
	type CompanyComputerCodePackageProvisionStatement,
	type CompanyComputerResetPlan,
	parseCompanyComputerCodePackageProvisionPlan,
	parseCompanyComputerCodePackageProvisionReceipt,
	parseCompanyComputerCodePackageProvisionRequest,
	parseCompanyComputerCodePackageProvisionStatement,
	parseCompanyComputerResetPlan,
	parseCompanyComputerStartupIdentity,
} from "@qorpera/contracts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";

export interface LxdOfficeCodePackageRegistry {
	call(
		method:
			| "qorpera_enroll_office_package_provision"
			| "qorpera_check_office_package_provision"
			| "qorpera_check_office_package_provision_observation"
			| "qorpera_ack_office_package_provision"
			| "qorpera_office_package_provision_status"
			| "qorpera_check_office_package_invocation"
			| "qorpera_ack_office_package_invocation",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
export interface LxdOfficeCodePackageAuthority {
	readonly plan: CompanyComputerCodePackageProvisionPlan;
	readonly statement: CompanyComputerCodePackageProvisionStatement;
	readonly resetPlan: CompanyComputerResetPlan;
	readonly inventorySha256: string;
	/** Separate provider capability; never returned, logged or sent to the guest. */
	readonly providerCapability: string;
}
const integer = (value: unknown, min = 1) => {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > Number.MAX_SAFE_INTEGER)
		throw new Error("OFFICE_CODE_PACKAGE_REVISION_UNCONFIRMED");
	return value as number;
};
const same = (a: unknown, b: unknown) => {
	if (!isDeepStrictEqual(a, b)) throw new Error("OFFICE_CODE_PACKAGE_AUTHORITY_UNCONFIRMED");
};

/** SQL authority only. Signature verification, protected staging and physical
 * root/invocation evidence are mandatory independent caller responsibilities. */
export class LxdOfficeCodePackageControl {
	readonly #registry: LxdOfficeCodePackageRegistry;
	readonly #plan;
	readonly #statement;
	readonly #resetPlan;
	readonly #inventory;
	readonly #capability;
	constructor(options: LxdOfficeCodePackageAuthority, registry: LxdOfficeCodePackageRegistry) {
		this.#plan = parseCompanyComputerCodePackageProvisionPlan(options.plan);
		this.#statement = parseCompanyComputerCodePackageProvisionStatement(options.statement);
		this.#resetPlan = parseCompanyComputerResetPlan(options.resetPlan);
		same(this.#plan.resetPlanSha256, officeDigest(this.#resetPlan));
		same(this.#plan.statementSha256, officeDigest(this.#statement));
		same(this.#plan.resetId, this.#resetPlan.resetId);
		same(this.#plan.rootIncarnationId, this.#resetPlan.rootIncarnationId);
		same(this.#plan.successorActivationId, this.#resetPlan.successorActivationId);
		same(this.#plan.providerBindingSha256, this.#resetPlan.providerBindingSha256);
		this.#inventory = officeSha(options.inventorySha256);
		if (!/^[0-9a-f]{64}$/.test(options.providerCapability))
			throw new Error("OFFICE_CODE_PACKAGE_CAPABILITY_UNCONFIRMED");
		this.#capability = options.providerCapability;
		this.#registry = registry;
	}
	async #call(
		method: Parameters<LxdOfficeCodePackageRegistry["call"]>[0],
		args: Record<string, unknown>,
		signal: AbortSignal,
	) {
		signal.throwIfAborted();
		const result = await this.#registry.call(method, { ...args, p_provider_capability: this.#capability }, signal);
		signal.throwIfAborted();
		return result;
	}
	#request(value: unknown) {
		const request = parseCompanyComputerCodePackageProvisionRequest(value);
		same(request.plan, this.#plan);
		same(request.planSha256, officeDigest(this.#plan));
		same(request.targetManifestSha256, this.#statement.target.packageManifestSha256);
		return request;
	}
	#receipt(value: unknown, request: CompanyComputerCodePackageProvisionRequest) {
		const receipt = parseCompanyComputerCodePackageProvisionReceipt(value);
		same(receipt, {
			schema: "qorpera.office-code-package-provision-receipt/v1",
			planSha256: officeDigest(this.#plan),
			provisionId: this.#plan.provisionId,
			resetId: this.#plan.resetId,
			rootIncarnationId: this.#plan.rootIncarnationId,
			bootId: request.bootId,
			commandId: this.#plan.installCommandId,
			requestSha256: officeDigest(request),
			restoreSha256: request.restoreSha256,
			state: "installed",
			targetRevision: this.#plan.targetRevision,
			packageManifestSha256: this.#statement.target.packageManifestSha256,
			installedInventorySha256: this.#inventory,
			sourceCommit: this.#statement.target.sourceCommit,
			runtimeBundle: this.#statement.target.runtimeBundle,
			service: this.#statement.target.service,
		});
		return receipt;
	}
	#status(value: unknown) {
		const r = officeRecord(value, [
			"schema",
			"plan",
			"planSha256",
			"statement",
			"state",
			"targetRevision",
			"currentPackageRevision",
			"capabilityRevision",
			"request",
			"requestSha256",
			"receipt",
			"receiptSha256",
			"installationEvidenceSha256",
		]);
		same(r.schema, "qorpera.office-code-package-provision-status/v1");
		same(r.plan, this.#plan);
		same(r.planSha256, officeDigest(this.#plan));
		same(r.statement, this.#statement);
		same(r.targetRevision, this.#plan.targetRevision);
		if (!["enrolled", "authorized", "installed"].includes(r.state as string))
			throw new Error("OFFICE_CODE_PACKAGE_STATE_UNCONFIRMED");
		const state = r.state as "enrolled" | "authorized" | "installed",
			currentPackageRevision = integer(r.currentPackageRevision, 0),
			capabilityRevision = integer(r.capabilityRevision);
		if (
			state === "installed"
				? currentPackageRevision < this.#plan.targetRevision
				: currentPackageRevision !== this.#plan.targetRevision - 1
		)
			throw new Error("OFFICE_CODE_PACKAGE_REVISION_UNCONFIRMED");
		const request = r.request === null ? null : this.#request(r.request);
		same(r.requestSha256, request === null ? null : officeDigest(request));
		if ((state === "enrolled") !== (request === null)) throw new Error("OFFICE_CODE_PACKAGE_STATE_UNCONFIRMED");
		const receipt = r.receipt === null ? null : this.#receipt(r.receipt, request!);
		same(r.receiptSha256, receipt === null ? null : officeDigest(receipt));
		if ((state === "installed") !== (receipt !== null)) throw new Error("OFFICE_CODE_PACKAGE_STATE_UNCONFIRMED");
		if (state === "installed") {
			officeSha(r.installationEvidenceSha256);
		} else same(r.installationEvidenceSha256, null);
		return {
			state,
			currentPackageRevision,
			capabilityRevision,
			request,
			requestSha256: request === null ? null : officeDigest(request),
			receipt,
			receiptSha256: receipt === null ? null : officeDigest(receipt),
			installationEvidenceSha256: r.installationEvidenceSha256 as string | null,
		};
	}
	async enroll(signal: AbortSignal) {
		return this.#status(
			await this.#call(
				"qorpera_enroll_office_package_provision",
				{
					p_reset_plan_text: officeCanonical(this.#resetPlan),
					p_plan_text: officeCanonical(this.#plan),
					p_statement_text: officeCanonical(this.#statement),
					p_plan_sha256: officeDigest(this.#plan),
				},
				signal,
			),
		);
	}
	async status(signal: AbortSignal) {
		return this.#status(
			await this.#call(
				"qorpera_office_package_provision_status",
				{ p_provision_id: this.#plan.provisionId },
				signal,
			),
		);
	}
	#challenge(
		value: unknown,
		request: CompanyComputerCodePackageProvisionRequest,
		started: number,
		observationId?: string,
	) {
		const r = officeRecord(
			value,
			observationId
				? [
						"schema",
						"provisionId",
						"observationId",
						"request",
						"requestSha256",
						"statement",
						"targetRevision",
						"capabilityRevision",
						"validForMs",
					]
				: ["schema", "request", "requestSha256", "statement", "targetRevision", "capabilityRevision", "validForMs"],
		);
		same(
			r.schema,
			observationId
				? "qorpera.office-code-package-observation-challenge/v1"
				: "qorpera.office-code-package-dispatch-challenge/v1",
		);
		if (observationId) {
			same(r.provisionId, this.#plan.provisionId);
			same(r.observationId, observationId);
		}
		same(r.request, request);
		same(r.requestSha256, officeDigest(request));
		same(r.statement, this.#statement);
		same(r.targetRevision, this.#plan.targetRevision);
		same(r.capabilityRevision, request.capabilityRevision);
		const validForMs = integer(r.validForMs);
		if (validForMs > 5000) throw new Error("OFFICE_CODE_PACKAGE_CHALLENGE_UNCONFIRMED");
		const deadline = started + validForMs;
		if (performance.now() >= deadline) throw new Error("OFFICE_CODE_PACKAGE_CHALLENGE_EXPIRED");
		return {
			wire: { ...r },
			request,
			requestSha256: officeDigest(request),
			deadline,
			validForMs: Math.floor(deadline - performance.now()),
		};
	}
	async dispatch(value: unknown, signal: AbortSignal) {
		const request = this.#request(value),
			started = performance.now();
		return this.#challenge(
			await this.#call(
				"qorpera_check_office_package_provision",
				{ p_provision_id: this.#plan.provisionId, p_request_text: officeCanonical(request) },
				signal,
			),
			request,
			started,
		);
	}
	async observe(value: unknown, observationId: string, signal: AbortSignal) {
		const request = this.#request(value),
			started = performance.now();
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(observationId))
			throw new Error("OFFICE_CODE_PACKAGE_OBSERVATION_UNCONFIRMED");
		return this.#challenge(
			await this.#call(
				"qorpera_check_office_package_provision_observation",
				{
					p_provision_id: this.#plan.provisionId,
					p_observation_id: observationId,
					p_original_request_sha256: officeDigest(request),
				},
				signal,
			),
			request,
			started,
			observationId,
		);
	}
	async acknowledge(
		value: unknown,
		requestValue: unknown,
		observationId: string,
		evidenceSha256: string,
		signal: AbortSignal,
	) {
		const request = this.#request(requestValue),
			receipt = this.#receipt(value, request);
		const result = this.#status(
			await this.#call(
				"qorpera_ack_office_package_provision",
				{
					p_provision_id: this.#plan.provisionId,
					p_observation_id: observationId,
					p_receipt_text: officeCanonical(receipt),
					p_inventory_sha256: this.#inventory,
					p_evidence_sha256: officeSha(evidenceSha256),
				},
				signal,
			),
		);
		same(result.state, "installed");
		same(result.receipt, receipt);
		same(result.installationEvidenceSha256, evidenceSha256);
		return result;
	}
	async invocation(startupValue: unknown, activationId: string, challengeId: string, signal: AbortSignal) {
		const startup = parseCompanyComputerStartupIdentity(startupValue),
			started = performance.now();
		const r = officeRecord(
			await this.#call(
				"qorpera_check_office_package_invocation",
				{ p_startup: startup, p_activation_id: activationId, p_challenge_id: challengeId },
				signal,
			),
			[
				"schema",
				"challengeId",
				"activationId",
				"startup",
				"provisionId",
				"planSha256",
				"revision",
				"receiptSha256",
				"installedInventorySha256",
				"service",
				"runtimeBundle",
				"capabilityRevision",
				"validForMs",
			],
		);
		same(r.schema, "qorpera.office-code-package-invocation-challenge/v1");
		same(r.challengeId, challengeId);
		same(r.activationId, activationId);
		same(r.startup, startup);
		same(r.provisionId, this.#plan.provisionId);
		same(r.planSha256, officeDigest(this.#plan));
		same(r.revision, this.#plan.targetRevision);
		same(r.installedInventorySha256, this.#inventory);
		same(r.service, this.#statement.target.service);
		same(r.runtimeBundle, this.#statement.target.runtimeBundle);
		const validForMs = integer(r.validForMs);
		if (validForMs > 5000 || performance.now() >= started + validForMs)
			throw new Error("OFFICE_CODE_PACKAGE_CHALLENGE_EXPIRED");
		return {
			wire: { ...r },
			startup,
			activationId,
			challengeId,
			provisionId: this.#plan.provisionId,
			planSha256: officeDigest(this.#plan),
			revision: this.#plan.targetRevision,
			receiptSha256: officeSha(r.receiptSha256),
			installedInventorySha256: this.#inventory,
			service: this.#statement.target.service,
			runtimeBundle: this.#statement.target.runtimeBundle,
			capabilityRevision: integer(r.capabilityRevision),
			deadline: started + validForMs,
		};
	}
	async acknowledgeInvocation(
		challenge: Awaited<ReturnType<LxdOfficeCodePackageControl["invocation"]>>,
		evidenceSha256: string,
		signal: AbortSignal,
	) {
		if (performance.now() >= challenge.deadline) throw new Error("OFFICE_CODE_PACKAGE_CHALLENGE_EXPIRED");
		const r = officeRecord(
			await this.#call(
				"qorpera_ack_office_package_invocation",
				{
					p_startup: challenge.startup,
					p_activation_id: challenge.activationId,
					p_challenge_id: challenge.challengeId,
					p_receipt_sha256: challenge.receiptSha256,
					p_inventory_sha256: this.#inventory,
					p_measured_service: this.#statement.target.service,
					p_runtime_bundle: this.#statement.target.runtimeBundle,
					p_evidence_sha256: officeSha(evidenceSha256),
				},
				signal,
			),
			["schema", "activationId", "provisionId", "revision", "state"],
		);
		same(r, {
			schema: "qorpera.office-code-package-invocation-measurement/v1",
			activationId: challenge.activationId,
			provisionId: this.#plan.provisionId,
			revision: this.#plan.targetRevision,
			state: "measured",
		});
		return {
			activationId: challenge.activationId,
			provisionId: this.#plan.provisionId,
			revision: this.#plan.targetRevision,
			state: "measured" as const,
		};
	}
}
