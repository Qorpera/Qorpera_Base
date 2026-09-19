import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { type Cloud, CloudRpcError } from "./client.ts";

export interface CompanyExecutionState {
	profileId: string;
	period: "month";
	periodStart: string;
	configured: boolean;
	version: number;
	spendMicrousdPerPeriod: number;
	tokensPerPeriod: number;
	wakesPerHour: number;
	wakesLastHour: number;
	paused: boolean;
	spendMicrousdUsed: number;
	tokensUsed: number;
	trips: number;
}
export interface CompanyExecutionCeilingInput {
	expectedVersion: number;
	spendMicrousdPerPeriod: number;
	tokensPerPeriod: number;
	wakesPerHour: number;
}
export interface CompanyExecutionPause {
	profileId: string;
	paused: boolean;
	changed: boolean;
}
export interface WebCompanyExecution {
	read(signal?: AbortSignal): Promise<CompanyExecutionState>;
	setCeiling(input: CompanyExecutionCeilingInput, signal?: AbortSignal): Promise<CompanyExecutionState>;
	setPause(paused: boolean, reason?: string, signal?: AbortSignal): Promise<CompanyExecutionPause>;
}

const invalid = () =>
	new Error("Company execution returned an invalid response. Refresh its status before trying again.");
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
		throw invalid();
	return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw invalid();
	return value;
}
function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw invalid();
	return value;
}
function date(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 64 ||
		!/^\d{4}-\d{2}-\d{2}T/.test(value) ||
		!Number.isFinite(Date.parse(value))
	)
		throw invalid();
	return value;
}
function reason(value: unknown): string | null {
	if (value === null) return null;
	// PostgreSQL char_length counts Unicode code points, not UTF-16 code units.
	if (typeof value !== "string" || value.length < 1 || [...value].length > 1024) throw invalid();
	return value;
}
function state(value: unknown, profileId: string): CompanyExecutionState {
	const v = record(value);
	if (v.schema !== "qorpera.company-execution-ceiling/v1" || v.profile_id !== profileId || v.period !== "month")
		throw invalid();
	return {
		profileId,
		period: "month",
		periodStart: date(v.period_start),
		configured: boolean(v.configured),
		version: integer(v.version),
		spendMicrousdPerPeriod: integer(v.spend_microusd_per_period, 1),
		tokensPerPeriod: integer(v.tokens_per_period, 1),
		wakesPerHour: integer(v.wakes_per_hour, 1, 1000000),
		wakesLastHour: integer(v.wakes_last_hour),
		paused: boolean(v.paused),
		spendMicrousdUsed: integer(v.spend_microusd_used),
		tokensUsed: integer(v.tokens_used),
		trips: integer(v.trips),
	};
}
/** Public member RPC wire contracts: migrations 19995 and 23000.
 * The cloud alone enforces ceiling and pause authority. The SDK
 * supplies bounded transport; this browser host validates display records only. */
export function createWebCompanyExecution(
	cloud: Cloud,
	profileId: string,
	memberId: string,
	companySignal: AbortSignal,
	current: () => void,
): WebCompanyExecution {
	uuid(profileId);
	uuid(memberId);
	const origin = new URL(cloud.config.projectUrl);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw new Error("Invalid cloud execution configuration.");
	const rpc = (method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
		const body = JSON.stringify(args);
		return withCloudDeadline(
			async (deadline) => {
				const check = () => {
					deadline.throwIfAborted();
					current();
				};
				check();
				const { data, error } = await cloud.supabase.auth.getSession();
				check();
				if (
					error ||
					!data.session ||
					data.session.user.id !== memberId ||
					!/^[A-Za-z0-9._~-]{1,8192}$/.test(data.session.access_token)
				)
					throw new Error("Sign in again to manage company execution.");
				const response = await fetch(`${origin.origin}/rest/v1/rpc/${method}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${data.session.access_token}`,
						apikey: cloud.config.publishableKey,
						"content-type": "application/json",
					},
					body,
					signal: deadline,
					redirect: "error",
					cache: "no-store",
					credentials: "omit",
				});
				try {
					check();
					if (response.status === 401 || response.status === 403)
						throw new CloudRpcError(
							method,
							{ message: "You do not have permission to manage this company execution.", code: "42501" },
							response.status,
						);
					if (response.status === 412)
						throw new CloudRpcError(
							method,
							{ message: "Company execution settings changed. Refresh before saving again.", code: "PT412" },
							412,
						);
					if (response.status !== 200) throw new Error("Company execution response was unavailable.");
					const value: unknown = JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							await readBoundedCloudResponse(response, 1024 * 1024, deadline),
						),
					);
					check();
					return value;
				} finally {
					if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
				}
			},
			10000,
			AbortSignal.any([companySignal, ...(signal ? [signal] : [])]),
		).catch((error: unknown) => {
			if (error instanceof CloudRpcError && (error.denied || error.status === 412)) throw error;
			throw new Error("Company execution could not be confirmed. Refresh its status before trying again.");
		});
	};
	const confirm = <T>(value: T, signal?: AbortSignal): T => {
		try {
			companySignal.throwIfAborted();
			signal?.throwIfAborted();
			current();
			return value;
		} catch {
			throw new Error("Company execution could not be confirmed. Refresh its status before trying again.");
		}
	};
	return {
		read: async (signal) =>
			confirm(
				state(await rpc("qorpera_company_execution_ceiling_json", { p_profile_id: profileId }, signal), profileId),
				signal,
			),
		setCeiling: async (input, signal) =>
			confirm(
				state(
					await rpc(
						"qorpera_set_company_execution_ceiling",
						{
							p_profile_id: profileId,
							p_expected_version: integer(input.expectedVersion),
							p_spend_microusd_per_period: integer(input.spendMicrousdPerPeriod, 1),
							p_tokens_per_period: integer(input.tokensPerPeriod, 1),
							p_wakes_per_hour: integer(input.wakesPerHour, 1, 1000000),
						},
						signal,
					),
					profileId,
				),
				signal,
			),
		setPause: async (paused, pauseReason, signal) => {
			const desired = boolean(paused);
			const v = record(
				await rpc(
					"qorpera_set_company_execution_pause",
					{ p_profile_id: profileId, p_paused: desired, p_reason: reason(pauseReason ?? null) },
					signal,
				),
			);
			if (v.schema !== "qorpera.company-execution-stop/v1" || v.profileId !== profileId || v.paused !== desired)
				throw invalid();
			return confirm({ profileId, paused: desired, changed: boolean(v.changed) }, signal);
		},
	};
}
