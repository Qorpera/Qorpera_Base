import {
	type IdentityRecoveryRuntimeState,
	parseIdentityRecoveryRuntimeState,
} from "./cloud-identity-recovery-guest.ts";
import { isNativeHostPublishableKey, type NativeHostIdentityCredential } from "./cloud-native-host-dispatch.ts";

/** G2-3: what the node host delivers into a native host's machine for its calls between jobs. */

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The holder's identity credential (G2-3), which the node host minted, bound to this machine and delivered as the
 * systemd credential `qorpera-native-identity`. */
export function parseNativeIdentityCredential(
	text: string | undefined,
	computeIdentityId: string,
): NativeHostIdentityCredential {
	if (!text) throw new Error("The native host needs its identity credential");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("The native identity credential is invalid");
	}
	const input = (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) as Record<
		string,
		unknown
	>;
	if (
		Object.keys(input).sort().join() !== "compute_identity_id,credential,publishable_key,schema" ||
		input.schema !== "qorpera.native-identity-credential/v1" ||
		input.compute_identity_id !== computeIdentityId ||
		typeof input.credential !== "string" ||
		!TOKEN_PATTERN.test(input.credential) ||
		!isNativeHostPublishableKey(input.publishable_key)
	)
		throw new Error("The native identity credential is invalid");
	return { computeIdentityId, credential: input.credential, publishableKey: input.publishable_key };
}

/** A login guest's identity recovery state (G2-3), which the login gateway read node side and delivered as the
 * systemd credential `qorpera-native-identity-state`: a login guest may not read it itself. */
export function parseNativeIdentityState(
	text: string | undefined,
	computeIdentityId: string,
): IdentityRecoveryRuntimeState {
	if (!text) throw new Error("A login guest needs its identity's recovery state");
	const state = parseIdentityRecoveryRuntimeState(JSON.parse(text));
	if (state.computeIdentityId !== computeIdentityId) throw new Error("Native identity authority differs");
	return state;
}
