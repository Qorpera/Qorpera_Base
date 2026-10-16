import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerLease,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_TOOL_VERSION,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerEffectContext,
	type CompanyComputerOperation,
	type CompanyComputerRunIdentity,
	type CompanyComputerScreenBinding,
	type CompanyComputerScreenLease,
	type CompanyComputerToolContent,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { JsonValue } from "@qorpera/contracts";
import type { CompanyComputerGuestAutomation } from "./cloud-company-computer-guest.ts";
import {
	CompanyComputerActionSettledFailure,
	type CompanyComputerScreenActionGate,
} from "./cloud-company-computer-leases.ts";
import {
	type CompanyComputerAction,
	type CompanyComputerCloudEndpoint,
	type CompanyComputerFolderRefusal,
	companyComputerFolderGiveBack,
	parseCompanyComputerToolArguments,
} from "./cloud-company-computer-tools.ts";

/** From the start of a guest action to its reply: the native call's 25 seconds minus transport margin. */
export const COMPANY_COMPUTER_REPLY_BUDGET_MS = 19_000;

/**
 * Adapt the existing Step 2 effect check here. It must validate live run,
 * principal, resource/profile grants, sign-in privacy and exact occupancy at
 * dispatch AND result release. A non-null receipt must be the existing ledger's
 * admitted, unfinished effect for this exact operation/identity. This adapter
 * owns no credentials, queue, work journal or alternative authorization policy.
 */
export interface CompanyComputerGuestEffectCheck {
	/** Consume this receipt once before guest dispatch; repeated attempts must fail. */
	begin(input: CompanyComputerGuestEffectInput, signal: AbortSignal): Promise<AbortSignal>;
	/** Called only after a confirmed guest drain (success, or a failure that left nothing running), using a fresh cleanup signal. */
	finish(input: CompanyComputerGuestEffectInput, signal: AbortSignal): Promise<void>;
	assertAuthorized(input: CompanyComputerGuestEffectInput, signal: AbortSignal): Promise<void>;
}

export interface CompanyComputerGuestEffectInput {
	operation: CompanyComputerOperation;
	identity: CompanyComputerRunIdentity;
	lease: CompanyComputerScreenLease;
	receipt: { receiptId: string; idempotencyKey: string } | null;
}

/** Guest-side receiver behind the existing authenticated cloud transport. Never instantiate in the app. */
export class CompanyComputerGuestEndpoint implements CompanyComputerCloudEndpoint {
	readonly capabilities: readonly ("browser" | "desktop" | "shell")[];
	readonly #resources: { [key: string]: JsonValue };
	readonly #binding: CompanyComputerScreenBinding;
	readonly #effects: CompanyComputerGuestEffectCheck;
	readonly #gate: CompanyComputerScreenActionGate;
	readonly #automation: Pick<CompanyComputerGuestAutomation, "perform" | "stopBrowser"> &
		Partial<Pick<CompanyComputerGuestAutomation, "settle">>;
	readonly #assertScreenAdmitted: (binding: CompanyComputerScreenBinding, signal: AbortSignal) => Promise<void>;
	readonly #prepareScreen: (
		binding: CompanyComputerScreenBinding,
		signal: AbortSignal,
		replyBy: number,
	) => Promise<CompanyComputerFolderRefusal | undefined>;
	/** Settled actions (failed or successful) whose drain got no confirmation yet, by receipt. */
	readonly #undrained = new Map<string, CompanyComputerGuestEffectInput>();

	constructor(options: {
		binding: CompanyComputerScreenBinding;
		capabilities: readonly ("browser" | "desktop" | "shell")[];
		resourceTarget: { [key: string]: JsonValue };
		effects: CompanyComputerGuestEffectCheck;
		/** One shared gate per physical guest, also used by takeover fencing. */
		gate: CompanyComputerScreenActionGate;
		/** `settle` is an action's passive half (waiting for a shell command), after its effect finished. */
		automation: Pick<CompanyComputerGuestAutomation, "perform" | "stopBrowser"> &
			Partial<Pick<CompanyComputerGuestAutomation, "settle">>;
		/** Pure authority/binding/readiness preflight. Must not launch or mutate a guest. */
		assertScreenAdmitted: (binding: CompanyComputerScreenBinding, signal: AbortSignal) => Promise<void>;
		/** Reuse or start the exact display and await real readiness. Runs only
		 * inside the receipt-admitted screen gate, never during authorization.
		 * `replyBy` is the action's reply deadline (performance.now()). A refusal
		 * means the office gave the screen back for the folder (F3 4d): the
		 * action does nothing and says why. */
		prepareScreen: (
			binding: CompanyComputerScreenBinding,
			signal: AbortSignal,
			replyBy: number,
		) => Promise<CompanyComputerFolderRefusal | undefined>;
	}) {
		assertCompanyComputerScreenBinding(options.binding, options.binding);
		if (options.capabilities.some((capability) => !["browser", "desktop", "shell"].includes(capability))) {
			throw new Error("INVALID_COMPUTER_CAPABILITY");
		}
		this.#binding = Object.freeze({ ...options.binding });
		this.capabilities = Object.freeze([...new Set(options.capabilities)]);
		this.#resources = structuredClone(options.resourceTarget);
		this.#effects = options.effects;
		this.#gate = options.gate;
		this.#automation = options.automation;
		this.#assertScreenAdmitted = options.assertScreenAdmitted;
		this.#prepareScreen = options.prepareScreen;
	}

	/**
	 * Drain again the settled actions whose first drain got no confirmation.
	 * Called before the run's screen lease is released: an open resource at
	 * release makes SQL drain the whole desktop. What still fails stays open.
	 */
	async drainSettled(signal: AbortSignal): Promise<void> {
		for (const [receiptId, effect] of this.#undrained) {
			signal.throwIfAborted();
			try {
				await this.#effects.finish(structuredClone(effect), signal);
				this.#undrained.delete(receiptId);
			} catch {
				/* Retained: the supervisor reaps what cannot be confirmed. */
			}
		}
	}

	get resourceTarget(): { [key: string]: JsonValue } {
		return structuredClone(this.#resources);
	}

	#validate(
		operation: CompanyComputerOperation,
		identity: CompanyComputerRunIdentity,
		lease: CompanyComputerScreenLease,
	): CompanyComputerAction {
		assertCompanyComputerLease(lease, this.#binding, {
			kind: "agent",
			runId: identity.runId,
			staffAgentId: identity.staffAgentId,
		});
		if (identity.companyId !== this.#binding.companyId || identity.environmentId !== this.#binding.environmentId) {
			throw new Error("COMPUTER_RUN_MISMATCH");
		}
		const { action } = parseCompanyComputerToolArguments({
			operationKey: operation.logicalOperationKey,
			action: operation.arguments,
		});
		if (
			operation.tool !== `computer_${action.kind}` ||
			operation.toolVersion !== COMPANY_COMPUTER_TOOL_VERSION ||
			operation.requiresCompanyRevision !== false ||
			!isDeepStrictEqual(operation.target, {
				realm: "company_computer",
				binding: this.#binding,
				resources: this.#resources,
			}) ||
			(action.kind !== "screen" &&
				!this.capabilities.includes(
					action.kind === "screenshot" ? action.surface : action.kind === "transfer" ? "shell" : action.kind,
				))
		) {
			throw new Error("COMPUTER_OPERATION_MISMATCH");
		}
		return action;
	}

	async authorize(
		operation: CompanyComputerOperation,
		identity: CompanyComputerRunIdentity,
		lease: CompanyComputerScreenLease,
		signal: AbortSignal,
	): Promise<void> {
		this.#validate(operation, identity, lease);
		signal.throwIfAborted();
		await this.#effects.assertAuthorized(
			{
				operation: structuredClone(operation),
				identity: structuredClone(identity),
				lease: structuredClone(lease),
				receipt: null,
			},
			signal,
		);
		await this.#assertScreenAdmitted(this.#binding, signal);
		signal.throwIfAborted();
	}

	async perform(
		operation: CompanyComputerOperation,
		lease: CompanyComputerScreenLease,
		context: CompanyComputerEffectContext,
	): Promise<CompanyComputerToolContent> {
		operation = structuredClone(operation);
		lease = structuredClone(lease);
		const identity = structuredClone(context.identity);
		const action = this.#validate(operation, identity, lease);
		if (!COMPANY_COMPUTER_UUID.test(context.receiptId) || !/^[0-9a-f]{64}$/.test(context.idempotencyKey)) {
			throw new Error("COMPUTER_EFFECT_RECEIPT_REQUIRED");
		}
		const receipt = { receiptId: context.receiptId, idempotencyKey: context.idempotencyKey };
		const effect = { operation, identity, lease, receipt };
		// Both ends of the native call give it 25 seconds; keep the rest for the
		// work before this point and the way back.
		const replyBy = performance.now() + COMPANY_COMPUTER_REPLY_BUDGET_MS;
		const resourceSignal = await this.#effects.begin(structuredClone(effect), context.signal);
		let givenBack = false;
		const result = await this.#gate
			.perform({
				lease,
				operation,
				signal: AbortSignal.any([context.signal, resourceSignal]),
				drainOnFailure: () => this.#automation.stopBrowser(),
				authorize: async (signal) => {
					await this.#effects.assertAuthorized(
						{
							operation: structuredClone(operation),
							identity: structuredClone(identity),
							lease: structuredClone(lease),
							receipt: { ...receipt },
						},
						signal,
					);
					await this.#assertScreenAdmitted(this.#binding, signal);
				},
				execute: async (signal): Promise<CompanyComputerToolContent> => {
					if (action.kind !== "screen" || action.action === "open") {
						const refusal = await this.#prepareScreen(this.#binding, signal, replyBy);
						signal.throwIfAborted();
						if (refusal) {
							givenBack = true;
							return companyComputerFolderGiveBack(action, refusal);
						}
					}
					if (action.kind === "screen") {
						// Resource cleanup follows the durable result's final check in createCompanyComputerTools.
						return {
							kind: "json",
							value: {
								screenId: this.#binding.screenId,
								status: action.action === "open" ? "open" : "release_requested",
							},
						};
					}
					return this.#automation.perform(
						action,
						lease,
						{ identity, ...receipt, signal, ...(context.fill ? { fill: context.fill } : {}) },
						operation,
					);
				},
			})
			.catch(async (error: unknown) => {
				// A failure the gate returned knowing nothing of the action still runs
				// is drained like a success, once the gate has let go of the action:
				// an open resource makes releasing the screen drain the whole desktop.
				// Any other error or timeout retains the resource: the guest may still
				// be draining, and only the acknowledged supervisor reaps that.
				if (error instanceof CompanyComputerActionSettledFailure) {
					await this.#effects.finish(structuredClone(effect), new AbortController().signal).catch(() => {
						// Often the same outage that failed the action: try again before release.
						this.#undrained.set(receipt.receiptId, structuredClone(effect));
					});
					throw error.cause;
				}
				throw error;
			});
		await this.#effects.finish(structuredClone(effect), new AbortController().signal).catch((error: unknown) => {
			// Reported as before, and tried again before release.
			this.#undrained.set(receipt.receiptId, structuredClone(effect));
			throw error;
		});
		// The screen went back with nothing done: there is nothing to wait for.
		if (givenBack) return result;
		// Outside the gate and after the resource drained: waiting stops nothing.
		return this.#automation.settle ? this.#automation.settle(action, result, context.signal, replyBy) : result;
	}
}
