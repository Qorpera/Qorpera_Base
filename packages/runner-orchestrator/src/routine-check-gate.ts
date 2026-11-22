import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";

export type RoutineCheckBeforeWake =
	| {
			readonly kind: "http_probe";
			readonly url: string;
			readonly expectStatus?: number;
			readonly timeoutMs?: number;
	  }
	| {
			readonly kind: "code_checks";
			readonly repo?: string;
			readonly timeoutMs?: number;
	  };

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

export interface RoutineProbeResolvedAddress {
	readonly address: string;
	readonly family: number;
}

export type RoutineProbeDnsLookup = (hostname: string) => Promise<readonly RoutineProbeResolvedAddress[]>;

export interface RoutineCheckGateOptions {
	readonly fetch?: typeof fetch;
	readonly lookup?: RoutineProbeDnsLookup;
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
const REPO_PATTERN = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_][a-z0-9_.-]{0,99}$/;
const HTTPS_URL_PATTERN = /^https:\/\/[^/@\s\u0000-\u001f\u007f]+(\/[^\s\u0000-\u001f\u007f]*)?$/;
const BLOCKED_HOSTS = new Set([
	"localhost",
	"metadata.google.internal",
	"metadata.goog",
	"instance-data",
	"169.254.169.254",
]);

function stripBrackets(host: string): string {
	return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function isPrivateOrLinkLocalIp(host: string): boolean {
	const cleaned = stripBrackets(host);
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

function isLocalHostname(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export function parseRoutineCheckBeforeWake(value: unknown): RoutineCheckBeforeWake | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (input.kind === "http_probe") {
		if (Object.keys(input).some((key) => !["kind", "url", "expectStatus", "timeoutMs"].includes(key))) {
			return undefined;
		}
		if (
			typeof input.url !== "string" ||
			input.url.length < 10 ||
			input.url.length > 1024 ||
			!HTTPS_URL_PATTERN.test(input.url)
		) {
			return undefined;
		}
		if (
			input.expectStatus !== undefined &&
			(!Number.isSafeInteger(input.expectStatus) ||
				(input.expectStatus as number) < 100 ||
				(input.expectStatus as number) > 599)
		) {
			return undefined;
		}
		if (
			input.timeoutMs !== undefined &&
			(!Number.isSafeInteger(input.timeoutMs) ||
				(input.timeoutMs as number) < 500 ||
				(input.timeoutMs as number) > 30_000)
		) {
			return undefined;
		}
		return {
			kind: "http_probe",
			url: input.url,
			...(input.expectStatus === undefined ? {} : { expectStatus: input.expectStatus as number }),
			...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs as number }),
		};
	}
	if (input.kind === "code_checks") {
		if (Object.keys(input).some((key) => !["kind", "repo", "timeoutMs"].includes(key))) {
			return undefined;
		}
		if (input.repo !== undefined && (typeof input.repo !== "string" || !REPO_PATTERN.test(input.repo))) {
			return undefined;
		}
		if (
			input.timeoutMs !== undefined &&
			(!Number.isSafeInteger(input.timeoutMs) ||
				(input.timeoutMs as number) < 1000 ||
				(input.timeoutMs as number) > 300_000)
		) {
			return undefined;
		}
		return {
			kind: "code_checks",
			...(input.repo === undefined ? {} : { repo: input.repo }),
			...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs as number }),
		};
	}
	return undefined;
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
	const isLocal = isLocalHostname(host);
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

async function defaultDnsLookup(hostname: string): Promise<readonly RoutineProbeResolvedAddress[]> {
	return await dnsLookup(hostname, { all: true, verbatim: true });
}

export async function resolveAndValidateProbeAddress(
	url: URL,
	options?: { readonly allowLocalhost?: boolean; readonly lookup?: RoutineProbeDnsLookup },
): Promise<RoutineProbeResolvedAddress> {
	const allowLocalhost = options?.allowLocalhost === true;
	const host = url.hostname.toLowerCase().replace(/\.+$/, "");
	const bare = stripBrackets(host);
	const literalVersion = isIP(bare);
	if (literalVersion !== 0) {
		if (!(allowLocalhost && isLocalHostname(host)) && isPrivateOrLinkLocalIp(bare)) {
			throw new RangeError("Probe URL target host is blocked");
		}
		return { address: bare, family: literalVersion };
	}
	const lookup = options?.lookup ?? defaultDnsLookup;
	const resolved = await lookup(bare);
	if (resolved.length === 0) {
		throw new RangeError("Probe URL hostname did not resolve");
	}
	for (const entry of resolved) {
		const version = isIP(entry.address);
		if (version === 0) throw new RangeError("Probe URL resolved to an invalid address");
		const entryLocal = entry.address === "127.0.0.1" || entry.address === "::1";
		if (!(allowLocalhost && isLocalHostname(host) && entryLocal) && isPrivateOrLinkLocalIp(entry.address)) {
			throw new RangeError("Probe URL resolved to a blocked IP address");
		}
	}
	return resolved[0]!;
}

export function sendPinnedIpProbe(
	url: URL,
	target: RoutineProbeResolvedAddress,
	signal: AbortSignal,
): Promise<{ readonly status: number }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const isHttps = url.protocol === "https:";
		const port = url.port ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;
		const path = `${url.pathname}${url.search}`;
		const bareHostname = stripBrackets(url.hostname);
		const req = isHttps
			? httpsRequest(
					{
						host: target.address,
						family: target.family,
						port,
						path,
						method: "GET",
						servername: isIP(bareHostname) === 0 ? bareHostname : undefined,
						headers: { host: url.host, "user-agent": "qorpera-routine-probe/1" },
						signal,
					},
					(res) => {
						const status = res.statusCode ?? 0;
						res.resume();
						res.on("error", () => undefined);
						resolvePromise({ status });
					},
				)
			: httpRequest(
					{
						host: target.address,
						family: target.family,
						port,
						path,
						method: "GET",
						headers: { host: url.host, "user-agent": "qorpera-routine-probe/1" },
						signal,
					},
					(res) => {
						const status = res.statusCode ?? 0;
						res.resume();
						res.on("error", () => undefined);
						resolvePromise({ status });
					},
				);
		req.on("error", rejectPromise);
		req.end();
	});
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
	const allowLocalhost = options.allowLocalhost === true;
	let url: URL;
	try {
		url = validateRoutineProbeUrl(check.url, allowLocalhost);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Probe URL rejected";
		return { ok: false, status: null, summary: sanitizeSummary(message), detail: message };
	}
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		let status: number;
		if (options.fetch) {
			if (options.lookup) {
				await resolveAndValidateProbeAddress(url, { allowLocalhost, lookup: options.lookup });
			}
			const response = await options.fetch(url.toString(), {
				method: "GET",
				redirect: "manual",
				signal: controller.signal,
			});
			await response.body?.cancel().catch(() => undefined);
			status = response.status;
		} else {
			const resolved = await resolveAndValidateProbeAddress(url, { allowLocalhost, lookup: options.lookup });
			const answer = await sendPinnedIpProbe(url, resolved, controller.signal);
			status = answer.status;
		}
		const ok = status === expectStatus;
		return {
			ok,
			status,
			summary: ok ? `HTTP ${status} OK` : `HTTP ${status} (expected ${expectStatus})`,
			detail: ok ? null : `GET ${url.origin}${url.pathname} returned ${status}, expected ${expectStatus}`,
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
