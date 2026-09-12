import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseCompanyComputerServiceSoftwareEnvelope } from "@qorpera/contracts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import {
	verifyLxdOfficeServiceSoftware,
	verifyLxdOfficeServiceSoftwareReceipt,
} from "./lxd-office-service-software.ts";

export interface LxdOfficeSoftwareRegistry {
	call(
		method:
			| "qorpera_enroll_office_software"
			| "qorpera_begin_office_software"
			| "qorpera_check_office_software_install"
			| "qorpera_ack_office_software_install"
			| "qorpera_office_software_status",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
type Verification = Parameters<typeof verifyLxdOfficeServiceSoftware>;
export interface LxdOfficeSoftwareControlOptions {
	envelope: Verification[0];
	plan: Verification[1];
	trust: Verification[2];
	manifests: Verification[3];
	expectedRevision: number;
	/** Separate operator-enrolled provider capability. Never ordinary office credentials. */
	providerCapability: string;
}
export interface LxdOfficeSoftwareInstallChallenge {
	schema: "qorpera.office-software-install-challenge/v1";
	challengeId: string;
	plan: ReturnType<typeof verifyLxdOfficeServiceSoftware>["plan"];
	planSha256: string;
	statement: ReturnType<typeof verifyLxdOfficeServiceSoftware>["statement"];
	targetRevision: number;
	capabilityRevision: number;
	validForMs: number;
}
const revision = (value: unknown) => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 9007199254740990)
		throw new Error("OFFICE_SOFTWARE_REVISION_INVALID");
	return value;
};

/** Provider-only SQL coordination. Physical installation remains an injected
 * protected operation under a continuous kernel lock. Historical metadata is
 * never a dispatch permit. The provider capability stays out of returned data,
 * signatures, journals and diagnostics. No retry of an uncertain physical call. */
export class LxdOfficeSoftwareControl {
	readonly #registry;
	readonly #envelope;
	readonly #verified;
	readonly #trust;
	readonly #manifests;
	readonly #revision;
	readonly #capability;
	#pending = false;
	constructor(options: LxdOfficeSoftwareControlOptions, registry: LxdOfficeSoftwareRegistry) {
		this.#envelope = parseCompanyComputerServiceSoftwareEnvelope(options.envelope);
		this.#trust = { ...options.trust };
		this.#manifests = {
			previous: Buffer.from(options.manifests.previous),
			next: Buffer.from(options.manifests.next),
		};
		this.#verified = verifyLxdOfficeServiceSoftware(this.#envelope, options.plan, this.#trust, this.#manifests);
		this.#revision = revision(options.expectedRevision);
		if (
			this.#revision === 9007199254740990 ||
			typeof options.providerCapability !== "string" ||
			!/^[0-9a-f]{64}$/.test(options.providerCapability)
		)
			throw new Error("OFFICE_SOFTWARE_AUTHORITY_INVALID");
		this.#capability = options.providerCapability;
		this.#registry = registry;
	}
	/** Call only after independent stopped baseline/image/package verification.
	 * This does not provision the separate capability; only the operator can. */
	enroll(evidenceSha256: string, caller: AbortSignal) {
		return this.#exclusive(caller, async (signal) => {
			const { plan, statement } = this.#verified;
			if (
				this.#revision !== 0 ||
				statement.base.packageManifestSha256 !== statement.previous.packageManifestSha256 ||
				statement.base.sourceCommit !== statement.previous.sourceCommit
			)
				throw new Error("baseline differs");
			const result = officeRecord(
				await this.#call(
					"qorpera_enroll_office_software",
					{
						p_predecessor: plan.predecessor,
						p_base: statement.base,
						p_current: statement.previous,
						p_evidence_sha256: officeSha(evidenceSha256),
					},
					signal,
				),
				["schema", "allocationId", "base", "revision"],
			);
			if (
				result.schema !== "qorpera.office-software-baseline/v1" ||
				result.allocationId !== plan.predecessor.startup.allocationId ||
				!isDeepStrictEqual(result.base, statement.base) ||
				revision(result.revision) !== this.#revision
			)
				throw new Error("baseline changed");
			return Object.freeze({ ...result });
		});
	}
	begin(stopAcknowledgement: unknown, caller: AbortSignal) {
		// Canonical serialization is shared by the signed plan and SQL text digest.
		const stopText = officeCanonical(stopAcknowledgement);
		if (
			Buffer.byteLength(stopText) > 65536 ||
			officeDigest(stopAcknowledgement) !== this.#verified.plan.stopAcknowledgementSha256
		)
			throw new Error("OFFICE_SOFTWARE_STOP_CHANGED");
		return this.#exclusive(caller, async (signal) => {
			const result = officeRecord(
				await this.#call(
					"qorpera_begin_office_software",
					{
						p_plan_text: officeCanonical(this.#verified.plan),
						p_statement_text: officeCanonical(this.#verified.statement),
						p_plan_sha256: this.#verified.planSha256,
						p_expected_revision: this.#revision,
						p_stop_text: stopText,
					},
					signal,
				),
				["updateId", "state", "targetRevision"],
			);
			this.#assertState(result);
			return Object.freeze({
				updateId: this.#verified.plan.updateId,
				state: result.state as "begun" | "installed",
				targetRevision: this.#revision + 1,
			});
		});
	}
	/** Recovery is metadata only: it neither grants dispatch nor repeats the
	 * installation after an uncertain response. */
	status(caller: AbortSignal) {
		return this.#exclusive(caller, async (signal) => {
			const result = officeRecord(
				await this.#call("qorpera_office_software_status", { p_plan: this.#verified.plan }, signal),
				[
					"schema",
					"plan",
					"statement",
					"state",
					"base",
					"currentRevision",
					"targetRevision",
					"receipt",
					"installationChallengeId",
					"installationEvidenceSha256",
				],
			);
			if (
				result.schema !== "qorpera.office-software-status/v1" ||
				!isDeepStrictEqual(result.plan, this.#verified.plan) ||
				!isDeepStrictEqual(result.statement, this.#verified.statement) ||
				!isDeepStrictEqual(result.base, this.#verified.statement.base) ||
				revision(result.targetRevision) !== this.#revision + 1
			)
				throw new Error("status changed");
			const currentRevision = revision(result.currentRevision);
			if (result.state === "begun") {
				if (
					currentRevision !== this.#revision ||
					result.receipt !== null ||
					result.installationChallengeId !== null ||
					result.installationEvidenceSha256 !== null
				)
					throw new Error("status changed");
				return Object.freeze({
					state: "begun" as const,
					currentRevision,
					targetRevision: this.#revision + 1,
					receipt: null,
				});
			}
			if (
				result.state !== "installed" ||
				currentRevision < this.#revision + 1 ||
				typeof result.installationChallengeId !== "string" ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
					result.installationChallengeId,
				)
			)
				throw new Error("status changed");
			const receipt = verifyLxdOfficeServiceSoftwareReceipt(
				result.receipt,
				this.#envelope,
				this.#verified.plan,
				this.#trust,
				this.#manifests,
			);
			return Object.freeze({
				state: "installed" as const,
				currentRevision,
				targetRevision: this.#revision + 1,
				receipt,
				challengeId: result.installationChallengeId,
				evidenceSha256: officeSha(result.installationEvidenceSha256),
			});
		});
	}
	/** Callback receives the remaining original check deadline, never a fresh
	 * five seconds. It must independently inspect stopped custody, install/recover
	 * exact bytes, and measure the resulting file before returning evidence. */
	install(
		physical: (
			challenge: Readonly<LxdOfficeSoftwareInstallChallenge>,
			deadline: number,
			signal: AbortSignal,
		) => Promise<{
			receipt: unknown;
			measuredService: unknown;
			evidenceSha256: string;
		}>,
		caller: AbortSignal,
	) {
		return this.#exclusive(caller, async (signal) => {
			const challengeId = randomUUID(),
				started = performance.now();
			const value = officeRecord(
				await this.#call(
					"qorpera_check_office_software_install",
					{
						p_update_id: this.#verified.plan.updateId,
						p_challenge_id: challengeId,
					},
					signal,
					started + 5000,
				),
				[
					"schema",
					"challengeId",
					"plan",
					"planSha256",
					"statement",
					"targetRevision",
					"capabilityRevision",
					"validForMs",
				],
			);
			if (
				value.schema !== "qorpera.office-software-install-challenge/v1" ||
				value.challengeId !== challengeId ||
				!isDeepStrictEqual(value.plan, this.#verified.plan) ||
				!isDeepStrictEqual(value.statement, this.#verified.statement) ||
				value.planSha256 !== this.#verified.planSha256 ||
				revision(value.targetRevision) !== this.#revision + 1 ||
				revision(value.capabilityRevision) < 1 ||
				typeof value.validForMs !== "number" ||
				!Number.isSafeInteger(value.validForMs) ||
				value.validForMs < 1 ||
				value.validForMs > 5000
			)
				throw new Error("challenge changed");
			const deadline = started + value.validForMs;
			const checked = this.#deadline(signal, deadline);
			const challenge: Readonly<LxdOfficeSoftwareInstallChallenge> = Object.freeze({
				schema: "qorpera.office-software-install-challenge/v1",
				challengeId,
				plan: this.#verified.plan,
				planSha256: this.#verified.planSha256,
				statement: this.#verified.statement,
				targetRevision: this.#revision + 1,
				capabilityRevision: value.capabilityRevision as number,
				validForMs: Math.floor(deadline - performance.now()),
			});
			const measured = await physical(challenge, deadline, checked);
			this.#deadline(checked, deadline);
			const receipt = verifyLxdOfficeServiceSoftwareReceipt(
				measured.receipt,
				this.#envelope,
				this.#verified.plan,
				this.#trust,
				this.#manifests,
			);
			if (!isDeepStrictEqual(measured.measuredService, this.#verified.statement.next.service))
				throw new Error("measured bytes changed");
			const evidenceSha256 = officeSha(measured.evidenceSha256);
			const result = officeRecord(
				await this.#call(
					"qorpera_ack_office_software_install",
					{
						p_update_id: this.#verified.plan.updateId,
						p_challenge_id: challengeId,
						p_receipt_text: officeCanonical(receipt),
						p_measured_service: receipt.service,
						p_evidence_sha256: evidenceSha256,
					},
					checked,
					deadline,
				),
				["schema", "updateId", "state", "targetRevision"],
			);
			this.#assertState(result);
			if (result.schema !== "qorpera.office-software-installation/v1" || result.state !== "installed")
				throw new Error("installation changed");
			return Object.freeze({ receipt, challengeId, evidenceSha256, targetRevision: this.#revision + 1 });
		});
	}
	#assertState(value: Record<string, unknown>) {
		if (
			value.updateId !== this.#verified.plan.updateId ||
			(value.state !== "begun" && value.state !== "installed") ||
			revision(value.targetRevision) !== this.#revision + 1
		)
			throw new Error("update changed");
	}
	#deadline(signal: AbortSignal, deadline: number) {
		signal.throwIfAborted();
		const remaining = Math.floor(deadline - performance.now());
		if (remaining < 1) throw new Error("OFFICE_SOFTWARE_AUTHORITY_EXPIRED");
		return AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
	}
	async #call(
		method: Parameters<LxdOfficeSoftwareRegistry["call"]>[0],
		args: Record<string, unknown>,
		caller: AbortSignal,
		deadline = performance.now() + 5000,
	) {
		const signal = this.#deadline(caller, deadline);
		const result = await this.#registry.call(
			method,
			structuredClone({ ...args, p_provider_capability: this.#capability }),
			signal,
		);
		this.#deadline(signal, deadline);
		return result;
	}
	async #exclusive<T>(caller: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		caller.throwIfAborted();
		if (this.#pending) throw new Error("OFFICE_SOFTWARE_CONTROL_PENDING");
		this.#pending = true;
		// Keep serialization until every injected operation settles, even if it
		// ignores cancellation. A timed-out response cannot reopen this instance.
		try {
			return await operation(caller);
		} catch {
			throw new Error("OFFICE_SOFTWARE_CONTROL_UNCONFIRMED");
		} finally {
			this.#pending = false;
		}
	}
}
