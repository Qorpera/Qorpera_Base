import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface NativeProviderAccountCredits {
	readonly hasCredits?: boolean;
	readonly unlimited?: boolean;
	readonly balance?: number;
	readonly used?: number;
	readonly limit?: number;
	readonly currency?: string;
}

export interface NativeProviderAccountUsage {
	observedAt: string;
	windows: readonly {
		id: "primary" | "secondary";
		label: string;
		usedPercent: number;
		resetAt?: string;
		windowSeconds?: number;
	}[];
	credits?: NativeProviderAccountCredits;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function resetAt(value: unknown): string | undefined {
	const milliseconds =
		typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 8_640_000_000_000_000) return undefined;
	return new Date(milliseconds).toISOString();
}

function usageWindows(value: unknown): NativeProviderAccountUsage["windows"] {
	const root = record(value);
	const limits = record(root?.rate_limit) ?? record(root?.rate_limits);
	const windows: Array<NativeProviderAccountUsage["windows"][number]> = [];
	for (const id of ["primary", "secondary"] as const) {
		const window = record(limits?.[`${id}_window`]) ?? record(limits?.[id]);
		const usedPercent = window?.used_percent;
		// Missing and invalid readings are unknown; they must never become a full or empty bar.
		if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)
			continue;
		const duration =
			typeof window?.limit_window_seconds === "number"
				? window.limit_window_seconds
				: typeof window?.window_minutes === "number"
					? window.window_minutes * 60
					: undefined;
		const windowSeconds =
			typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0 ? duration : undefined;
		const reset = resetAt(window?.reset_at);
		windows.push({
			id,
			label:
				windowSeconds === 18_000
					? "5 hours"
					: windowSeconds === 604_800 || id === "secondary"
						? "Weekly"
						: "Current window",
			usedPercent,
			...(reset ? { resetAt: reset } : {}),
			...(windowSeconds ? { windowSeconds } : {}),
		});
	}
	return windows;
}

function numericCredit(value: unknown): number | undefined {
	const raw =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+(?:\.\d{1,6})?$/.test(value.trim())
				? Number(value.trim())
				: Number.NaN;
	if (!Number.isFinite(raw) || raw < 0 || raw > 1_000_000_000) return undefined;
	return Math.round(raw * 100) / 100;
}

function usageCredits(value: unknown): NativeProviderAccountCredits | undefined {
	const credits = record(record(value)?.credits);
	if (!credits) return undefined;
	const hasCredits = typeof credits.has_credits === "boolean" ? credits.has_credits : undefined;
	const unlimited = typeof credits.unlimited === "boolean" ? credits.unlimited : undefined;
	const balance = numericCredit(credits.balance);
	const used = numericCredit(credits.used);
	const limit = numericCredit(credits.limit);
	const currency =
		typeof credits.currency === "string" && /^[A-Z]{3}$/.test(credits.currency.toUpperCase())
			? credits.currency.toUpperCase()
			: undefined;
	if (unlimited === true) {
		return {
			...(hasCredits !== undefined ? { hasCredits } : {}),
			unlimited: true,
			...(balance !== undefined ? { balance } : {}),
			...(currency ? { currency } : {}),
		};
	}
	if (hasCredits === false && !(balance !== undefined && balance > 0)) return undefined;
	if (balance === undefined && used === undefined && limit === undefined) return undefined;
	return {
		...(hasCredits !== undefined ? { hasCredits } : {}),
		...(unlimited !== undefined ? { unlimited } : {}),
		...(balance !== undefined ? { balance } : {}),
		...(used !== undefined ? { used } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(currency ? { currency } : {}),
	};
}

/** Read account quota inside the credential-owning host. Only sanitized display
 * windows leave this function. Tokens are never refreshed or modified here. */
export async function readNativeProviderAccountUsage(
	metadata: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<NativeProviderAccountUsage | undefined> {
	try {
		if (metadata.length > MAX_RESPONSE_BYTES) return undefined;
		const tokens = record(record(JSON.parse(metadata))?.tokens);
		const token = tokens?.access_token;
		const accountId = tokens?.account_id;
		if (
			typeof token !== "string" ||
			!token ||
			token.length > 64 * 1024 ||
			/[^\x21-\x7e]/.test(token) ||
			typeof accountId !== "string" ||
			!accountId ||
			accountId.length > 256 ||
			/[^\x21-\x7e]/.test(accountId)
		)
			return undefined;
		return await withCloudDeadline(
			async (deadline) => {
				const response = await fetchImpl(USAGE_URL, {
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${token}`,
						"ChatGPT-Account-Id": accountId,
					},
					redirect: "error",
					signal: deadline,
				});
				if (!response.ok || response.redirected || (response.url && response.url !== USAGE_URL)) {
					void response.body?.cancel().catch(() => undefined);
					return undefined;
				}
				const bytes = await readBoundedCloudResponse(response, MAX_RESPONSE_BYTES, deadline);
				deadline.throwIfAborted();
				const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
				const windows = usageWindows(parsed);
				const credits = usageCredits(parsed);
				return windows.length
					? { observedAt: new Date().toISOString(), windows, ...(credits ? { credits } : {}) }
					: undefined;
			},
			10_000,
			signal,
		);
	} catch {
		// Network, expiry, malformed payloads and cancellation all mean unknown usage.
		// Never forward response bodies, credential content, or provider error messages.
		return undefined;
	}
}
