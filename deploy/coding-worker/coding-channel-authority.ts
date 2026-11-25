import { type CloudCodingCommandScope, type JsonValue, POSTGRES_UUID_PATTERN } from "@qorpera/contracts";
import type {
	CloudCodingChannelAnswer,
	CloudCodingChannelAuthorized,
	CloudHomeChannelKind,
} from "../../packages/runtime/src/cloud-home-channel.ts";
import type { CloudNativeToolBinding } from "../../packages/runtime/src/cloud-native-tool-authority.ts";

const REFUSALS = new Set(["MACHINE_NOT_RUNNING", "MACHINE_NEW_DISK"]);

function text(value: unknown, pattern?: RegExp): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 200 || (pattern && !pattern.test(value)))
		throw new Error("CODING_CHANNEL_AUTHORITY_INVALID");
	return value;
}

export async function authorizeCodingChannel(
	control: { call(method: string, args: Record<string, JsonValue>, signal: AbortSignal): Promise<unknown> },
	request: { binding: CloudNativeToolBinding; scope: CloudCodingCommandScope; kind: CloudHomeChannelKind },
	signal: AbortSignal,
): Promise<CloudCodingChannelAnswer> {
	const answer = await control.call(
		"qorpera_authorize_coding_channel",
		{
			p_binding: request.binding as unknown as JsonValue,
			p_scope: request.scope as unknown as JsonValue,
			p_kind: request.kind,
		},
		signal,
	);
	if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("CODING_CHANNEL_AUTHORITY_INVALID");
	const record = answer as Record<string, unknown>;
	if (record.schema !== "qorpera.coding-channel-authority/v1") throw new Error("CODING_CHANNEL_AUTHORITY_INVALID");
	if (record.state === "refused") {
		const reason = text(record.reason);
		if (!REFUSALS.has(reason)) throw new Error("CODING_CHANNEL_AUTHORITY_INVALID");
		return { state: "refused", reason };
	}
	if (record.state !== "authorized") throw new Error("CODING_CHANNEL_AUTHORITY_INVALID");
	const turn = record.turn;
	if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 1)
		throw new Error("CODING_CHANNEL_AUTHORITY_INVALID");
	const authority: CloudCodingChannelAuthorized = {
		state: "authorized",
		workerId: text(record.workerId, POSTGRES_UUID_PATTERN),
		vmId: text(record.vmId, POSTGRES_UUID_PATTERN),
		requestId: text(record.requestId, POSTGRES_UUID_PATTERN),
		turn,
		executorOwner: text(record.executorOwner),
		providerId: text(record.providerId),
	};
	if (
		authority.workerId !== request.scope.workerId ||
		authority.vmId !== request.scope.vmId ||
		authority.requestId !== request.scope.requestId ||
		authority.turn !== request.scope.turn
	)
		throw new Error("CODING_CHANNEL_AUTHORITY_INVALID");
	return authority;
}
