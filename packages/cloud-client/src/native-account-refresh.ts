export const NATIVE_ACCOUNT_REFRESH_SCHEMA = "qorpera.native-account-refresh/v1";
export const NATIVE_ACCOUNT_REFRESH_RESULT_SCHEMA = "qorpera.native-account-refresh-result/v1";

export interface NativeAccountRefreshRequest {
	requestId: string;
	computeIdentityId: string;
	requestedByUserId: string;
	expiresAt: string;
	capability: string;
}

export interface NativeAccountRefreshDescription extends Omit<NativeAccountRefreshRequest, "capability"> {
	profileId: string;
	status: "pending" | "completed";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid account refresh");
	return value as Record<string, unknown>;
}

function identity(value: Record<string, unknown>): Omit<NativeAccountRefreshRequest, "capability"> {
	for (const key of ["request_id", "compute_identity_id", "requested_by_user_id"])
		if (typeof value[key] !== "string" || !UUID.test(value[key])) throw new Error("Invalid account refresh identity");
	if (typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at)))
		throw new Error("Invalid account refresh expiry");
	return {
		requestId: value.request_id as string,
		computeIdentityId: value.compute_identity_id as string,
		requestedByUserId: value.requested_by_user_id as string,
		expiresAt: new Date(value.expires_at).toISOString(),
	};
}

export function parseNativeAccountRefreshRequest(value: unknown): NativeAccountRefreshRequest {
	const input = object(value);
	if (
		Object.keys(input).sort().join() !==
			"compute_identity_id,expires_at,refresh_capability,request_id,requested_by_user_id,schema" ||
		input.schema !== NATIVE_ACCOUNT_REFRESH_SCHEMA ||
		typeof input.refresh_capability !== "string" ||
		!TOKEN.test(input.refresh_capability)
	)
		throw new Error("Invalid account refresh request");
	const request = { ...identity(input), capability: input.refresh_capability };
	if (Date.parse(request.expiresAt) <= Date.now()) throw new Error("Account refresh expired");
	return request;
}

export function parseNativeAccountRefreshDescription(value: unknown): NativeAccountRefreshDescription {
	const input = object(value);
	if (
		Object.keys(input).sort().join() !==
			"compute_identity_id,expires_at,profile_id,request_id,requested_by_user_id,status" ||
		typeof input.profile_id !== "string" ||
		!UUID.test(input.profile_id) ||
		(input.status !== "pending" && input.status !== "completed")
	)
		throw new Error("Invalid account refresh authority");
	return { ...identity(input), profileId: input.profile_id, status: input.status };
}

export function nativeAccountRefreshBody(request: NativeAccountRefreshRequest): Record<string, string> {
	return {
		schema: NATIVE_ACCOUNT_REFRESH_SCHEMA,
		request_id: request.requestId,
		compute_identity_id: request.computeIdentityId,
		requested_by_user_id: request.requestedByUserId,
		expires_at: request.expiresAt,
		refresh_capability: request.capability,
	};
}

export function parseNativeAccountRefreshResult(value: unknown, requestId: string): "preparing" | "completed" {
	const input = object(value);
	if (
		Object.keys(input).sort().join() !== "request_id,schema,status" ||
		input.schema !== NATIVE_ACCOUNT_REFRESH_RESULT_SCHEMA ||
		input.request_id !== requestId ||
		(input.status !== "preparing" && input.status !== "completed")
	)
		throw new Error("Invalid account refresh result");
	return input.status;
}
