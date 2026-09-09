import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerLease,
	assertCompanyComputerScope,
	type CompanyComputerScope,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import type {
	CompanyComputerGuestEffectCheck,
	CompanyComputerGuestEffectInput,
} from "./cloud-company-computer-endpoint.ts";
import { type CloudNativeToolRun, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import { cloudNativeToolOperationEnvelope } from "./cloud-native-tool-operations.ts";

export interface CompanyComputerEffectRegistry {
	call(
		method: "qorpera_native_office_operation",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** Trusted headless runtime adapter; never accepts principals from tool prose. */
export class CloudCompanyComputerEffectControl implements CompanyComputerGuestEffectCheck {
	readonly #run: CloudNativeToolRun;
	readonly #scope: CompanyComputerScope;
	readonly #control: CompanyComputerEffectRegistry;
	readonly #resources = new Map<
		string,
		{ id: string; deadline: number; stop: AbortController; timer: ReturnType<typeof setTimeout> }
	>();

	constructor(options: {
		run: CloudNativeToolRun;
		scope: CompanyComputerScope;
		control: CompanyComputerEffectRegistry;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		if (
			options.scope.companyId !== options.run.identity.companyId ||
			options.scope.environmentId !== options.run.identity.environmentId
		) {
			throw new Error("COMPUTER_RUN_MISMATCH");
		}
		this.#run = options.run;
		this.#scope = Object.freeze({ ...options.scope });
		this.#control = options.control;
	}

	async #call(
		action: "authorize" | "begin" | "check" | "finish",
		input: CompanyComputerGuestEffectInput,
		signal: AbortSignal,
	): Promise<void> {
		input = structuredClone(input);
		assertCompanyComputerScope(input.lease.binding, this.#scope);
		assertCompanyComputerLease(input.lease, input.lease.binding, {
			kind: "agent",
			runId: this.#run.identity.runId,
			staffAgentId: this.#run.identity.staffAgentId,
		});
		if (!isDeepStrictEqual(input.identity, this.#run.identity) || (action !== "authorize" && !input.receipt)) {
			throw new Error("OFFICE_EFFECT_IDENTITY_MISMATCH");
		}
		const previous = input.receipt ? this.#resources.get(input.receipt.receiptId) : undefined;
		if (action === "begin" && previous) throw new Error("OFFICE_EFFECT_ALREADY_ATTEMPTED");
		if (action === "check" && (!previous || previous.stop.signal.aborted || performance.now() >= previous.deadline)) {
			throw new Error("OFFICE_RESOURCE_EXPIRED");
		}
		const started = performance.now();
		const result = await cloudToolRequest(
			(requestSignal) =>
				this.#control.call(
					"qorpera_native_office_operation",
					{
						p_binding: this.#run.binding,
						p_scope: this.#scope,
						p_lease: structuredClone(input.lease),
						p_envelope: cloudNativeToolOperationEnvelope(this.#run.identity, input.operation),
						p_action: action,
						p_receipt_id: input.receipt?.receiptId ?? null,
						p_idempotency_sha256: input.receipt
							? createHash("sha256").update(input.receipt.idempotencyKey).digest("hex")
							: null,
					},
					requestSignal,
				),
			action === "finish" ? signal : AbortSignal.any([signal, this.#run.signal]),
		);
		if (!result || typeof result !== "object" || Array.isArray(result))
			throw new Error("INVALID_OFFICE_EFFECT_RESPONSE");
		const response = result as Record<string, unknown>;
		if (action === "authorize" || action === "finish") {
			if (
				Object.keys(response).join() !== "state" ||
				response.state !== (action === "authorize" ? "authorized" : "drained")
			) {
				throw new Error("OFFICE_EFFECT_UNCONFIRMED");
			}
			if (action === "finish" && previous) {
				clearTimeout(previous.timer);
				previous.stop.abort();
			}
		} else if (
			Object.keys(response).sort().join() !== "resourceLeaseId,state,validForMs" ||
			response.state !== "admitted" ||
			typeof response.resourceLeaseId !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(response.resourceLeaseId) ||
			!Number.isSafeInteger(response.validForMs) ||
			(response.validForMs as number) < 1 ||
			(response.validForMs as number) > 30_000
		) {
			throw new Error("OFFICE_RESOURCE_UNCONFIRMED");
		}
		if (action === "begin" || action === "check") {
			const deadline = Math.min(
				started + (response.validForMs as number),
				previous?.deadline ?? Number.POSITIVE_INFINITY,
			);
			if (
				deadline <= performance.now() ||
				(previous && (previous.id !== response.resourceLeaseId || previous.stop.signal.aborted))
			) {
				previous?.stop.abort();
				throw new Error("OFFICE_RESOURCE_EXPIRED");
			}
			if (previous) clearTimeout(previous.timer);
			const stop = previous?.stop ?? new AbortController();
			const timer = setTimeout(() => stop.abort(), Math.max(1, deadline - performance.now()));
			timer.unref();
			this.#resources.set(input.receipt!.receiptId, {
				id: response.resourceLeaseId as string,
				deadline,
				stop,
				timer,
			});
		}
	}

	assertAuthorized(input: CompanyComputerGuestEffectInput, signal: AbortSignal): Promise<void> {
		return this.#call(input.receipt ? "check" : "authorize", input, signal);
	}
	async begin(input: CompanyComputerGuestEffectInput, signal: AbortSignal): Promise<AbortSignal> {
		await this.#call("begin", input, signal);
		const resource = input.receipt && this.#resources.get(input.receipt.receiptId);
		if (!resource) throw new Error("OFFICE_RESOURCE_UNCONFIRMED");
		return AbortSignal.any([resource.stop.signal, this.#run.signal]);
	}
	finish(input: CompanyComputerGuestEffectInput, signal: AbortSignal): Promise<void> {
		return this.#call("finish", input, signal);
	}
}
