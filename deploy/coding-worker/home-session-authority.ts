// The executor's authority for one run's home session (lanes/agent-box-20261113, slice 1).
//
// A channel to a home is authorized exactly as a machine command is: SQL answers whether this run may have this
// session on this machine now, and the executor never decides it from what the run said. The answer is the same shape
// as a machine command's, so the ingress refuses with words the model can act on (the machine is not running, this
// boot is over) instead of a failure it cannot read.

import { type JsonValue, POSTGRES_UUID_PATTERN } from "@qorpera/contracts";
import type { CloudHomeSessionAuthorized } from "../../packages/runtime/src/cloud-home-channel.ts";
import type { CloudNativeToolBinding } from "../../packages/runtime/src/cloud-native-tool-authority.ts";

/** The ingress's own types, so the executor and the service agree on one shape (cloud-home-channel.ts). */
export type HomeSessionAuthority = CloudHomeSessionAuthorized & { readonly bootId: string; readonly runId: string };
export type HomeSessionAnswer = HomeSessionAuthority | { readonly state: "refused"; readonly reason: string };

const REFUSALS = new Set(["MACHINE_NOT_RUNNING", "HOME_SESSION_ENDED", "HOME_SESSION_OPEN"]);

function text(value: unknown, pattern?: RegExp): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 200 || (pattern && !pattern.test(value)))
		throw new Error("HOME_SESSION_AUTHORITY_INVALID");
	return value;
}

/** `qorpera_authorize_home_session`, as the ingress asks it before a byte reaches the machine. */
export async function authorizeHomeSession(
	control: { call(method: string, args: Record<string, JsonValue>, signal: AbortSignal): Promise<unknown> },
	request: { binding: CloudNativeToolBinding; machineId: string; sessionId: string },
	signal: AbortSignal,
): Promise<HomeSessionAnswer> {
	const answer = await control.call(
		"qorpera_authorize_home_session",
		{
			p_binding: request.binding as unknown as JsonValue,
			p_scope: { machineId: request.machineId },
			p_session_id: request.sessionId,
		},
		signal,
	);
	if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("HOME_SESSION_AUTHORITY_INVALID");
	const record = answer as Record<string, unknown>;
	if (record.schema !== "qorpera.home-session-authority/v1") throw new Error("HOME_SESSION_AUTHORITY_INVALID");
	if (record.state === "refused") {
		const reason = text(record.reason);
		if (!REFUSALS.has(reason)) throw new Error("HOME_SESSION_AUTHORITY_INVALID");
		return { state: "refused", reason };
	}
	if (record.state !== "authorized") throw new Error("HOME_SESSION_AUTHORITY_INVALID");
	const authority: HomeSessionAuthority = {
		state: "authorized",
		sessionId: text(record.sessionId, POSTGRES_UUID_PATTERN),
		machineId: text(record.machineId, POSTGRES_UUID_PATTERN),
		machine: text(record.machine),
		placementId: text(record.placementId, POSTGRES_UUID_PATTERN),
		bootId: text(record.bootId, POSTGRES_UUID_PATTERN),
		runId: text(record.runId, POSTGRES_UUID_PATTERN),
		executorOwner: text(record.executorOwner),
		providerId: text(record.providerId),
	};
	if (authority.sessionId !== request.sessionId || authority.machineId !== request.machineId)
		throw new Error("HOME_SESSION_AUTHORITY_INVALID");
	return authority;
}
