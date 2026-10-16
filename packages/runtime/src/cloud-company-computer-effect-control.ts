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
import { CloudToolAuthorizeRefusal } from "./cloud-native-tool-boundary.ts";
import { cloudNativeToolOperationEnvelope } from "./cloud-native-tool-operations.ts";

export interface CompanyComputerEffectRegistry {
	call(
		method: "qorpera_native_office_operation" | "qorpera_native_office_hook_capture",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** Where a vault_capture's box goes (E3c-3), as the database answered for this one call. */
export interface CompanyComputerHookCaptureTarget {
	readonly hookId: string;
	/** The hook's address: the page the secret is read on must show it. */
	readonly address: string;
	/** The hook's site: the page must be on it. */
	readonly site: string;
	readonly companyId: string;
	readonly companyComputerId: string;
	readonly computerGeneration: number;
	readonly receiptId: string;
	readonly field: "signing_secret";
	/** The hook's capture key (X25519, base64url): the box is sealed to it, and only the vault holds its private half. */
	readonly capturePublicKey: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

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

	/** A copy of `input`, checked against this run: its screen lease, its identity, and a receipt where one is needed. */
	#checked(input: CompanyComputerGuestEffectInput, receipt: boolean): CompanyComputerGuestEffectInput {
		input = structuredClone(input);
		assertCompanyComputerScope(input.lease.binding, this.#scope);
		assertCompanyComputerLease(input.lease, input.lease.binding, {
			kind: "agent",
			runId: this.#run.identity.runId,
			staffAgentId: this.#run.identity.staffAgentId,
		});
		if (!isDeepStrictEqual(input.identity, this.#run.identity) || (receipt && !input.receipt)) {
			throw new Error("OFFICE_EFFECT_IDENTITY_MISMATCH");
		}
		return input;
	}

	/** The call as the database checks it: this run, this screen lease, the operation's envelope and its receipt. */
	#args(input: CompanyComputerGuestEffectInput): Record<string, unknown> {
		return {
			p_binding: this.#run.binding,
			p_scope: this.#scope,
			p_lease: structuredClone(input.lease),
			p_envelope: cloudNativeToolOperationEnvelope(this.#run.identity, input.operation),
			p_receipt_id: input.receipt?.receiptId ?? null,
			p_idempotency_sha256: input.receipt
				? createHash("sha256").update(input.receipt.idempotencyKey).digest("hex")
				: null,
		};
	}

	/** The resource this receipt's begin made, while it still holds. */
	#live(input: CompanyComputerGuestEffectInput) {
		const previous = input.receipt ? this.#resources.get(input.receipt.receiptId) : undefined;
		if (!previous || previous.stop.signal.aborted || performance.now() >= previous.deadline) {
			throw new Error("OFFICE_RESOURCE_EXPIRED");
		}
		return previous;
	}

	async #call(
		action: "authorize" | "begin" | "check" | "finish",
		input: CompanyComputerGuestEffectInput,
		signal: AbortSignal,
	): Promise<void> {
		input = this.#checked(input, action !== "authorize");
		const previous =
			action === "check"
				? this.#live(input)
				: input.receipt
					? this.#resources.get(input.receipt.receiptId)
					: undefined;
		if (action === "begin" && previous) throw new Error("OFFICE_EFFECT_ALREADY_ATTEMPTED");
		const started = performance.now();
		const result = await cloudToolRequest(
			(requestSignal) =>
				this.#control.call(
					"qorpera_native_office_operation",
					{ ...this.#args(input), p_action: action },
					requestSignal,
				),
			action === "finish" ? signal : AbortSignal.any([signal, this.#run.signal]),
		);
		if (!result || typeof result !== "object" || Array.isArray(result))
			throw new Error("INVALID_OFFICE_EFFECT_RESPONSE");
		const response = result as Record<string, unknown>;
		// A refusal worded for the model (C1c-3l part 3: no screenshot on folder-v2 yet). Only an authorize answers one,
		// before any receipt; the operation executor relays it to the model as the tool's answer.
		if (
			action === "authorize" &&
			Object.keys(response).sort().join() === "message,state" &&
			response.state === "refused" &&
			typeof response.message === "string" &&
			/^[ -~]{1,512}$/.test(response.message)
		) {
			throw new CloudToolAuthorizeRefusal(response.message);
		}
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
			!UUID.test(response.resourceLeaseId) ||
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

	/**
	 * E3c-3: where this vault_capture's box goes, read by the office itself through its own registry, never from the
	 * native host (which could swap in a key of its own and read the value). The database first checks the call as a
	 * check does (the executing receipt of exactly this call, this run's screen lease, the resource its begin made),
	 * then the hook and its capture key; it writes nothing. Only inside this receipt, after its begin.
	 */
	async hookCaptureTarget(
		input: CompanyComputerGuestEffectInput,
		signal: AbortSignal,
	): Promise<CompanyComputerHookCaptureTarget> {
		input = this.#checked(input, true);
		this.#live(input);
		const call = input.operation.arguments as { action?: unknown; hook?: unknown; field?: unknown };
		if (input.operation.tool !== "computer_browser" || call.action !== "vault_capture")
			throw new Error("OFFICE_HOOK_CAPTURE_INVALID");
		const result = await cloudToolRequest(
			(requestSignal) => this.#control.call("qorpera_native_office_hook_capture", this.#args(input), requestSignal),
			AbortSignal.any([signal, this.#run.signal]),
		);
		const target = (result && typeof result === "object" && !Array.isArray(result) ? result : {}) as Record<
			string,
			unknown
		>;
		if (
			Object.keys(target).sort().join() !==
				"address,capturePublicKey,companyComputerId,companyId,computerGeneration,field,hookId,receiptId,schema,site" ||
			target.schema !== "qorpera.event-hook-capture-target/v1" ||
			target.hookId !== call.hook ||
			target.field !== call.field ||
			target.field !== "signing_secret" ||
			target.receiptId !== input.receipt!.receiptId ||
			target.companyId !== this.#scope.companyId ||
			target.companyComputerId !== input.lease.binding.companyComputerId ||
			target.computerGeneration !== input.lease.binding.computerGeneration ||
			typeof target.hookId !== "string" ||
			!UUID.test(target.hookId) ||
			typeof target.address !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/.test(target.address) ||
			typeof target.capturePublicKey !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/.test(target.capturePublicKey) ||
			typeof target.site !== "string" ||
			target.site.length > 253 ||
			!HOST.test(target.site)
		)
			throw new Error("OFFICE_HOOK_CAPTURE_UNCONFIRMED");
		return Object.freeze(target) as unknown as CompanyComputerHookCaptureTarget;
	}
}
