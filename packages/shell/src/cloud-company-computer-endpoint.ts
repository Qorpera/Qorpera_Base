import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@qorpera/contracts";
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
} from "./cloud-company-computer-contract.ts";
import type { CompanyComputerGuestAutomation } from "./cloud-company-computer-guest.ts";
import type { CompanyComputerScreenActionGate } from "./cloud-company-computer-leases.ts";
import {
	type CompanyComputerAction,
	type CompanyComputerCloudEndpoint,
	parseCompanyComputerToolArguments,
} from "./cloud-company-computer-tools.ts";

/**
 * Adapt the existing Step 2 effect check here. It must validate live run,
 * principal, resource/profile grants, sign-in privacy and exact occupancy at
 * dispatch AND result release. A non-null receipt must be the existing ledger's
 * admitted, unfinished effect for this exact operation/identity. This adapter
 * owns no credentials, queue, work journal or alternative authorization policy.
 */
export interface CompanyComputerGuestEffectCheck {
	assertAuthorized(
		input: {
			operation: CompanyComputerOperation;
			identity: CompanyComputerRunIdentity;
			lease: CompanyComputerScreenLease;
			receipt: { receiptId: string; idempotencyKey: string } | null;
		},
		signal: AbortSignal,
	): Promise<void>;
}

/** Guest-side receiver behind the existing authenticated cloud transport. Never instantiate in the app. */
export class CompanyComputerGuestEndpoint implements CompanyComputerCloudEndpoint {
	readonly capabilities: readonly ("browser" | "desktop" | "shell")[];
	readonly #resources: { [key: string]: JsonValue };
	readonly #binding: CompanyComputerScreenBinding;
	readonly #effects: CompanyComputerGuestEffectCheck;
	readonly #gate: CompanyComputerScreenActionGate;
	readonly #automation: Pick<CompanyComputerGuestAutomation, "perform" | "stopBrowser">;
	readonly #assertScreenReady: (binding: CompanyComputerScreenBinding, signal: AbortSignal) => Promise<void>;

	constructor(options: {
		binding: CompanyComputerScreenBinding;
		capabilities: readonly ("browser" | "desktop" | "shell")[];
		resourceTarget: { [key: string]: JsonValue };
		effects: CompanyComputerGuestEffectCheck;
		/** One shared gate per physical guest, also used by takeover fencing. */
		gate: CompanyComputerScreenActionGate;
		automation: Pick<CompanyComputerGuestAutomation, "perform" | "stopBrowser">;
		assertScreenReady: (binding: CompanyComputerScreenBinding, signal: AbortSignal) => Promise<void>;
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
		this.#assertScreenReady = options.assertScreenReady;
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
				!this.capabilities.includes(action.kind === "screenshot" ? action.surface : action.kind))
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
		await this.#assertScreenReady(this.#binding, signal);
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
		return this.#gate.perform({
			lease,
			operation,
			signal: context.signal,
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
				await this.#assertScreenReady(this.#binding, signal);
			},
			execute: async (signal): Promise<CompanyComputerToolContent> => {
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
				return this.#automation.perform(action, lease, { identity, ...receipt, signal });
			},
		});
	}
}
