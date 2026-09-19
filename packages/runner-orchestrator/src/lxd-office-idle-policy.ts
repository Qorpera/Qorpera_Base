import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerLifecycleRequest,
	parseCompanyComputerStopHistoryManifest,
} from "@qorpera/contracts";
import { officeCanonical, officeRecord } from "./lxd-office-image-provenance.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import type { LxdOfficeProviderAssignment } from "./lxd-office-provider-control.ts";

export interface LxdOfficeIdleRegistry {
	call(
		method: "qorpera_reconcile_runtime_office_idle",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
export interface LxdOfficeIdleRecovery {
	request: ReturnType<typeof parseCompanyComputerLifecycleRequest>;
	resume?: ReturnType<typeof parseCompanyComputerBootIntentRequest>;
}
export function parseOfficeIdleMs(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 60000 || (value as number) > 86400000)
		throw new Error("INVALID_OFFICE_IDLE_WINDOW");
	return value as number;
}

/** SQL serializes demand against idle admission. The provider only carries
 * the resulting exact lifecycle request into the existing physical workers.
 * A wake never bypasses their service-stop, VM-stop or new-boot evidence. */
export class LxdOfficeIdlePolicy {
	readonly #assignment: LxdOfficeProviderAssignment;
	readonly #root: string;
	readonly #idleMs: number;
	readonly #registry: LxdOfficeIdleRegistry;
	constructor(root: string, assignment: LxdOfficeProviderAssignment, idleMs: number, registry: LxdOfficeIdleRegistry) {
		this.#root = root;
		this.#assignment = structuredClone(assignment);
		this.#idleMs = parseOfficeIdleMs(idleMs);
		this.#registry = registry;
	}
	async reconcile(intentId: string, signal: AbortSignal): Promise<LxdOfficeIdleRecovery | undefined> {
		const a = this.#assignment;
		const scope = {
			companyId: a.companyId,
			environmentId: a.environmentId,
			companyComputerId: a.companyComputerId,
			logicalComputerId: a.logicalComputerId,
		};
		const result = officeRecord(
			await this.#registry.call(
				"qorpera_reconcile_runtime_office_idle",
				{
					p_scope: scope,
					p_computer_generation: a.computerGeneration,
					p_provider_id: a.providerId,
					p_provider_policy_sha256: a.providerPolicySha256,
					p_idle_ms: this.#idleMs,
				},
				signal,
			),
			["schema", "request", "wakeRequested"],
		);
		signal.throwIfAborted();
		if (result.schema !== "qorpera.office-idle-policy/v1" || typeof result.wakeRequested !== "boolean")
			throw new Error("OFFICE_IDLE_POLICY_UNCONFIRMED");
		if (result.request === null) {
			if (result.wakeRequested) throw new Error("OFFICE_IDLE_POLICY_UNCONFIRMED");
			return undefined;
		}
		const request = parseCompanyComputerLifecycleRequest(result.request);
		if (
			request.action !== "power_off" ||
			request.providerId !== a.providerId ||
			request.providerPolicySha256 !== a.providerPolicySha256 ||
			request.startup.computerGeneration !== a.computerGeneration ||
			!isDeepStrictEqual(request.startup.scope, scope)
		)
			throw new Error("OFFICE_IDLE_POLICY_BINDING_DIFFERS");
		const suffix = `${request.startup.allocationId}-${request.transitionId}`;
		await publish(this.#root, `idle-request-${suffix}.json`, Buffer.from(officeCanonical(request)));
		if (!isDeepStrictEqual((await readRecord(join(this.#root, `idle-request-${suffix}.json`), 65536)).value, request))
			throw new Error("OFFICE_IDLE_REQUEST_DIFFERS");
		if (!result.wakeRequested) return { request };
		const resumeName = `idle-resume-${suffix}.json`;
		let saved: unknown;
		try {
			saved = (await readRecord(join(this.#root, resumeName), 65536)).value;
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
		}
		if (saved !== undefined) {
			const resume = parseCompanyComputerBootIntentRequest(saved);
			if (!isDeepStrictEqual(resume.predecessor, request)) throw new Error("OFFICE_IDLE_RESUME_DIFFERS");
			return { request, resume };
		}
		for (const prefix of [
			"recovery-boot-stage",
			"resume-request",
			"resume-prepared",
			"resume-observation",
			"resume-completed",
		]) {
			try {
				await lstat(join(this.#root, `${prefix}-${suffix}.json`));
				throw new Error("OFFICE_IDLE_RESUME_IDENTITY_LOST");
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
			}
		}
		// Absence of the final physical record means the stop is still pending.
		// Once it exists, every required history record must be present and exact.
		let completion: Awaited<ReturnType<typeof readRecord>>;
		try {
			completion = await readRecord(join(this.#root, `power-off-completed-${suffix}.json`), 65536);
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
			return { request };
		}
		const historyFile = await readRecord(join(this.#root, `power-off-history-${suffix}.json`), 65536);
		const history = parseCompanyComputerStopHistoryManifest(
			historyFile.value,
			request.startup.bootId,
			request.activationId,
		);
		const seed = (await readRecord(join(this.#root, `power-off-request-${suffix}.json`), 65536)).value;
		const done = officeRecord(completion.value, [
			"schema",
			"intentId",
			"allocationId",
			"transitionId",
			"commandId",
			"requestSha256",
			"operationId",
			"instanceSha256",
			"hostBootId",
		]);
		const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
		if (
			!seed ||
			typeof seed !== "object" ||
			Array.isArray(seed) ||
			!("request" in seed) ||
			!isDeepStrictEqual(seed.request, request) ||
			!("stopHistorySha256" in seed) ||
			seed.stopHistorySha256 !== hash(historyFile.bytes) ||
			!("commandId" in seed) ||
			seed.commandId !== done.commandId ||
			done.schema !== "qorpera.lxd-office-power-off-completion/v1" ||
			done.intentId !== intentId ||
			done.allocationId !== request.startup.allocationId ||
			done.transitionId !== request.transitionId ||
			done.instanceSha256 !== request.startup.instanceSha256 ||
			done.requestSha256 !== hash(Buffer.from(officeCanonical(seed))) ||
			history.command.bootId !== request.startup.bootId
		)
			throw new Error("OFFICE_IDLE_STOP_EVIDENCE_DIFFERS");
		const resume = parseCompanyComputerBootIntentRequest({
			schema: "qorpera.office-boot-intent-request/v1",
			bootIntentId: randomUUID(),
			activationId: randomUUID(),
			predecessor: request,
			stopHistorySha256: hash(historyFile.bytes),
			powerOffCompletionSha256: hash(completion.bytes),
		});
		signal.throwIfAborted();
		await publish(this.#root, resumeName, Buffer.from(officeCanonical(resume)));
		if (!isDeepStrictEqual((await readRecord(join(this.#root, resumeName), 65536)).value, resume))
			throw new Error("OFFICE_IDLE_RESUME_DIFFERS");
		return { request, resume };
	}
}
