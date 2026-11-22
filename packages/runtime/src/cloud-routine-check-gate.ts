import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import type { RoutineCheckBeforeWake } from "@qorpera/cloud-client/company-state-files";

export interface RoutineCheckProbeOutcome {
	readonly ok: boolean;
	readonly status: number | null;
	readonly summary: string;
	readonly detail: string | null;
}

export interface RoutineCheckGateDecision {
	readonly healthy: boolean;
	readonly previousHealthy: boolean | null;
	readonly stateChanged: boolean;
	readonly shouldWake: boolean;
	readonly consecutiveFailures: number;
	readonly status: number | null;
	readonly summary: string;
	readonly detail: string | null;
	readonly durationMs: number;
}

export interface RoutineCheckGateOptions {
	readonly fetch?: typeof fetch;
	readonly allowLocalhost?: boolean;
	readonly runCodeChecks?: (
		input: { readonly repo?: string; readonly timeoutMs: number },
		signal: AbortSignal,
	) => Promise<{ readonly ok: boolean; readonly summary: string; readonly detail?: string | null }>;
	readonly recordResult?: (
		input: { readonly healthy: boolean; readonly summary: string; readonly detail: string | null },
		signal: AbortSignal,
	) => Promise<{
		readonly previousHealthy: boolean | null;
		readonly stateChanged: boolean;
		readonly shouldWake: boolean;
		readonly consecutiveFailures: number;
	}>;
}

const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_CODE_CHECKS_TIMEOUT_MS = 60_000;
const BLOCKED_HOSTS = new Set([
	"localhost",
	"metadata.google.internal",
	"metadata.goog",
	"instance-data",
	"169.254.169.254",
]);

function isPrivateOrLinkLocalIp(host: string): boolean {
	const cleaned = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	const version = isIP(cleaned);
	if (version === 4) {
		const parts = cleaned.split(".").map((part) => Number.parseInt(part, 10));
		if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
		const [a, b] = parts as [number, number, number, number];
		if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		if (a === 198 && (b === 18 || b === 19)) return true;
		return false;
	}
	if (version === 6) {
		const lower = cleaned.toLowerCase();
		if (lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd")) return true;
		if (/^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("::ffff:")) return true;
		return false;
	}
	return false;
}

export function validateRoutineProbeUrl(rawUrl: string, allowLocalhost = false): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new RangeError("Probe URL is malformed");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new RangeError("Probe URL must use http or https");
	}
	if (url.username !== "" || url.password !== "") {
		throw new RangeError("Probe URL must not contain credentials");
	}
	const host = url.hostname.toLowerCase().replace(/\.+$/, "");
	const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
	if (isLocal && allowLocalhost) return url;
	if (url.protocol !== "https:") {
		throw new RangeError("Non-local probe URL must use https");
	}
	if (
		BLOCKED_HOSTS.has(host) ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		isPrivateOrLinkLocalIp(host)
	) {
		throw new RangeError("Probe URL target host is blocked");
	}
	return url;
}

export function evaluateCheckGateTransition(
	previousHealthy: boolean | null,
	currentHealthy: boolean,
	previousConsecutiveFailures = 0,
): {
	readonly previousHealthy: boolean | null;
	readonly stateChanged: boolean;
	readonly shouldWake: boolean;
	readonly consecutiveFailures: number;
} {
	const stateChanged = previousHealthy !== null && previousHealthy !== currentHealthy;
	const consecutiveFailures = currentHealthy ? 0 : previousConsecutiveFailures + 1;
	const shouldWake = !currentHealthy || stateChanged;
	return { previousHealthy, stateChanged, shouldWake, consecutiveFailures };
}

function sanitizeSummary(raw: string): string {
	const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return (cleaned || "Check completed").slice(0, 500);
}

async function runHttpProbe(
	check: Extract<RoutineCheckBeforeWake, { kind: "http_probe" }>,
	options: RoutineCheckGateOptions,
	signal: AbortSignal,
): Promise<RoutineCheckProbeOutcome> {
	const expectStatus = check.expectStatus ?? 200;
	const timeoutMs = check.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
	let url: URL;
	try {
		url = validateRoutineProbeUrl(check.url, options.allowLocalhost === true);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Probe URL rejected";
		return { ok: false, status: null, summary: sanitizeSummary(message), detail: message };
	}
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const fetchImpl = options.fetch ?? fetch;
		const response = await fetchImpl(url.toString(), {
			method: "GET",
			redirect: "manual",
			signal: controller.signal,
		});
		await response.body?.cancel().catch(() => undefined);
		const ok = response.status === expectStatus;
		return {
			ok,
			status: response.status,
			summary: ok ? `HTTP ${response.status} OK` : `HTTP ${response.status} (expected ${expectStatus})`,
			detail: ok ? null : `GET ${url.origin}${url.pathname} returned ${response.status}, expected ${expectStatus}`,
		};
	} catch (error) {
		if (signal.aborted) throw error;
		const message = error instanceof Error ? error.message : "HTTP probe error";
		return {
			ok: false,
			status: null,
			summary: sanitizeSummary(`HTTP probe failed: ${message}`),
			detail: message.slice(0, 2000),
		};
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

export async function runRoutineCheckBeforeWake(
	check: RoutineCheckBeforeWake,
	previous: { readonly healthy: boolean | null; readonly consecutiveFailures?: number },
	options: RoutineCheckGateOptions,
	signal: AbortSignal,
): Promise<RoutineCheckGateDecision> {
	signal.throwIfAborted();
	const started = performance.now();
	let outcome: RoutineCheckProbeOutcome;
	if (check.kind === "http_probe") {
		outcome = await runHttpProbe(check, options, signal);
	} else {
		if (!options.runCodeChecks) {
			throw new Error("code_checks runner is not configured");
		}
		const timeoutMs = check.timeoutMs ?? DEFAULT_CODE_CHECKS_TIMEOUT_MS;
		const result = await options.runCodeChecks(
			{ ...(check.repo === undefined ? {} : { repo: check.repo }), timeoutMs },
			signal,
		);
		outcome = {
			ok: result.ok,
			status: null,
			summary: sanitizeSummary(result.summary),
			detail: result.detail === undefined || result.detail === null ? null : result.detail.slice(0, 2000),
		};
	}
	const durationMs = Math.max(0, Math.round(performance.now() - started));
	const transition = options.recordResult
		? await options.recordResult({ healthy: outcome.ok, summary: outcome.summary, detail: outcome.detail }, signal)
		: evaluateCheckGateTransition(previous.healthy, outcome.ok, previous.consecutiveFailures ?? 0);
	return Object.freeze({
		healthy: outcome.ok,
		previousHealthy: transition.previousHealthy,
		stateChanged: transition.stateChanged,
		shouldWake: transition.shouldWake,
		consecutiveFailures: transition.consecutiveFailures,
		status: outcome.status,
		summary: outcome.summary,
		detail: outcome.detail,
		durationMs,
	});
}
