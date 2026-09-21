import { officeCanonical, officeDigest } from "./lxd-office-image-provenance.ts";
import {
	NODE_UPDATE_PHASES,
	type NodeUpdateDrain,
	type NodeUpdateIntent,
	type NodeUpdatePorts,
	type NodeUpdateReceipt,
	type NodeUpdateRelease,
} from "./runtime-node-update.ts";
import type { RuntimeNodeUpdateRegistry } from "./runtime-node-update-registry.ts";

/** The host implementation owns retained physical evidence and fixed enrolled
 * service/artifact paths. This adapter supplies no arbitrary command execution. */
export interface NodeUpdatePhysicalPorts {
	verifyAdmission(
		release: NodeUpdateRelease,
		intent: NodeUpdateIntent,
		drain: NodeUpdateDrain,
		signal: AbortSignal,
	): Promise<void>;
	execute(
		release: NodeUpdateRelease,
		intent: NodeUpdateIntent,
		drain: NodeUpdateDrain | null,
		signal: AbortSignal,
	): Promise<NodeUpdateReceipt>;
	inspect(
		release: NodeUpdateRelease,
		intent: NodeUpdateIntent,
		signal: AbortSignal,
	): Promise<NodeUpdateReceipt | null>;
}

/** Join the controller to the actual scoped SQL RPCs. Preparation and publication
 * are separate from physical dispatch, so a missing HTTP reply cannot cause a
 * second install, stop or start. Exact immutable SQL writes are safe to submit
 * after a read shows them absent; conflicting rows are terminal. */
export function createNodeUpdateRegistryPorts(
	registry: RuntimeNodeUpdateRegistry,
	physical: NodeUpdatePhysicalPorts,
): NodeUpdatePorts {
	const checkedState = async (intent: NodeUpdateIntent, signal: AbortSignal) => {
		const state = await registry.read(intent.releaseSha256, signal),
			retained = state.intents[NODE_UPDATE_PHASES.indexOf(intent.phase)];
		if (!retained || officeCanonical(retained) !== officeCanonical(intent))
			throw new Error("NODE_UPDATE_RETAINED_INTENT_DIFFERS");
		return state;
	};
	const sqlReceipt = (intent: NodeUpdateIntent, drain: NodeUpdateDrain, evidence: unknown): NodeUpdateReceipt => ({
		schema: "qorpera.runtime-node-update-receipt/v1",
		intentSha256: officeDigest(intent),
		state: "succeeded",
		evidenceSha256: officeDigest({
			schema: "qorpera.node-update-sql-evidence/v1",
			intentSha256: officeDigest(intent),
			evidence,
		}),
		drain,
	});
	return {
		observe: async (release, signal) => (await registry.read(officeDigest(release), signal)).observation,
		prepare: async (intent, signal) => {
			const state = await registry.read(intent.releaseSha256, signal),
				retained = state.intents[NODE_UPDATE_PHASES.indexOf(intent.phase)];
			if (retained) {
				if (officeCanonical(retained) !== officeCanonical(intent))
					throw new Error("NODE_UPDATE_RETAINED_INTENT_DIFFERS");
				return;
			}
			await registry.prepare(intent, signal);
		},
		publish: async (intent, receipt, signal) => {
			const state = await checkedState(intent, signal),
				retained = state.receipts[NODE_UPDATE_PHASES.indexOf(intent.phase)];
			if (retained) {
				if (officeCanonical(retained.receipt) !== officeCanonical(receipt))
					throw new Error("NODE_UPDATE_PUBLISHED_RECEIPT_DIFFERS");
				return;
			}
			await registry.record(intent, receipt, signal);
		},
		execute: async (release, intent, drain, signal) => {
			const state = await checkedState(intent, signal);
			if (state.receipts[NODE_UPDATE_PHASES.indexOf(intent.phase)])
				throw new Error("NODE_UPDATE_EFFECT_ALREADY_RECORDED");
			if (intent.phase === "drain") {
				const held = await registry.drain(intent, signal);
				return sqlReceipt(intent, held, held);
			}
			if (intent.phase === "resume") {
				if (!drain) throw new Error("NODE_UPDATE_DRAIN_REQUIRED");
				await physical.verifyAdmission(release, intent, drain, signal);
				return sqlReceipt(intent, drain, await registry.resume(intent, drain, signal));
			}
			if (intent.phase !== "stage") {
				if (!drain) throw new Error("NODE_UPDATE_DRAIN_REQUIRED");
				await registry.check(intent, drain, signal);
			}
			return physical.execute(release, intent, drain, signal);
		},
		inspect: async (release, intent, signal) => {
			const state = await checkedState(intent, signal);
			if (intent.phase === "drain") return state.drain ? sqlReceipt(intent, state.drain, state.drain) : null;
			if (intent.phase === "resume") {
				if (!state.drain || state.resumedVersion === null) return null;
				return sqlReceipt(intent, state.drain, {
					nodeId: release.nodeId,
					releaseSha256: intent.releaseSha256,
					version: state.resumedVersion,
					enabled: state.drain.previousEnabled,
				});
			}
			return physical.inspect(release, intent, signal);
		},
	};
}
