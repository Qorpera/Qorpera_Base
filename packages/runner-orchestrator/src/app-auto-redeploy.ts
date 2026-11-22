import { isIP } from "node:net";
import { parseBoundedText, parseClosedRecord, parseInteger } from "@qorpera/contracts";
import { CodingSecretMask } from "./coding-secret-mask.ts";
import {
	APP_SLUG_PATTERN,
	type CompanyMachineSecretsManager,
	type HostedAppSecretBundle,
	type HostedAppTargetEnv,
	maskAppLogText,
} from "./company-machine-secrets.ts";

export const APP_DEPLOY_CONFIG_SCHEMA = "qorpera.app-deploy/v1";
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export interface AppAutoRedeployConfig {
	readonly schema: typeof APP_DEPLOY_CONFIG_SCHEMA;
	readonly autoRedeploy: boolean;
	readonly site: string;
	readonly targetEnv: HostedAppTargetEnv;
	readonly paths: readonly string[];
	readonly buildCommand: string;
	readonly reloadCommand: string;
	readonly rollbackCommand?: string;
	readonly healthUrl: string;
	readonly healthExpectStatus: number;
	readonly healthTimeoutMs: number;
	readonly healthAttempts: number;
	readonly healthIntervalMs: number;
	readonly injectRuntimeSecrets: boolean;
	readonly injectDatabaseUrl: boolean;
}

export interface CodeChangeLandedEvent {
	readonly kind: "landed" | "undone" | "checks_failed" | "conflict";
	readonly repo: string;
	readonly change: string;
	readonly mainBefore: string | null;
	readonly mainAfter: string;
	readonly paths: readonly string[];
}

export interface AppAutoRedeployHooks {
	currentReleaseId(site: string, signal: AbortSignal): Promise<string | null>;
	loadRuntimeSecrets?(
		site: string,
		targetEnv: HostedAppTargetEnv,
		signal: AbortSignal,
	): Promise<HostedAppSecretBundle>;
	build(
		input: {
			readonly site: string;
			readonly commitSha: string;
			readonly command: string;
			readonly envPath: string | null;
		},
		signal: AbortSignal,
	): Promise<{ readonly releaseId: string }>;
	reload(
		input: {
			readonly site: string;
			readonly commitSha: string;
			readonly releaseId: string;
			readonly command: string;
			readonly envPath: string | null;
		},
		signal: AbortSignal,
	): Promise<void>;
	rollback(
		input: {
			readonly site: string;
			readonly previousReleaseId: string | null;
			readonly failedReleaseId: string;
			readonly command: string | undefined;
		},
		signal: AbortSignal,
	): Promise<void>;
	probeHealth?(
		input: { readonly url: string; readonly expectStatus: number; readonly timeoutMs: number },
		signal: AbortSignal,
	): Promise<{ readonly ok: boolean; readonly status: number | null; readonly error?: string }>;
	emitAppUnhealthy?(
		input: {
			readonly site: string;
			readonly status: string;
			readonly restartCount: number;
			readonly error: string;
		},
		signal: AbortSignal,
	): Promise<void>;
}

export type AppAutoRedeployResult =
	| { readonly status: "skipped"; readonly reason: "disabled" | "event_kind" | "paths_unmatched" }
	| {
			readonly status: "deployed";
			readonly site: string;
			readonly commitSha: string;
			readonly releaseId: string;
			readonly healthStatus: number | null;
			readonly attempts: number;
	  }
	| {
			readonly status: "build_failed";
			readonly site: string;
			readonly commitSha: string;
			readonly rolledBack: false;
			readonly error: string;
	  }
	| {
			readonly status: "rolled_back";
			readonly site: string;
			readonly commitSha: string;
			readonly failedReleaseId: string;
			readonly restoredReleaseId: string | null;
			readonly error: string;
	  };

const BLOCKED_HEALTH_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "instance-data", "169.254.169.254"]);

function isBlockedNonLocalIp(host: string): boolean {
	const cleaned = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	const version = isIP(cleaned);
	if (version === 4) {
		const parts = cleaned.split(".").map((part) => Number.parseInt(part, 10));
		if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
		const [a, b] = parts as [number, number, number, number];
		if (a === 0 || a === 10 || a >= 224) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		return false;
	}
	if (version === 6) {
		const lower = cleaned.toLowerCase();
		if (lower === "::" || lower.startsWith("fc") || lower.startsWith("fd")) return true;
		if (/^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("::ffff:")) return true;
		return false;
	}
	return false;
}

function parseHealthUrl(raw: unknown): string {
	const value = parseBoundedText(raw, "deploy.json healthUrl", 1024);
	if (CONTROL_CHARS.test(value)) throw new RangeError("deploy.json healthUrl contains control characters");
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new RangeError("deploy.json healthUrl is not a valid URL");
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new RangeError("deploy.json healthUrl must be http or https without embedded credentials");
	}
	const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
	const isLocal = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
	if (parsed.protocol === "http:" && !isLocal) {
		throw new RangeError("deploy.json http healthUrl is restricted to localhost or 127.0.0.1");
	}
	if (!isLocal && (BLOCKED_HEALTH_HOSTS.has(host) || host.endsWith(".internal") || isBlockedNonLocalIp(host))) {
		throw new RangeError("deploy.json healthUrl target host is blocked");
	}
	return parsed.toString();
}

export function parseAppDeployConfig(raw: string | unknown): AppAutoRedeployConfig {
	let decoded: unknown = raw;
	if (typeof raw === "string") {
		if (Buffer.byteLength(raw, "utf8") > 32 * 1024) {
			throw new RangeError("deploy.json exceeds maximum size");
		}
		try {
			decoded = JSON.parse(raw) as unknown;
		} catch {
			throw new SyntaxError("deploy.json is not valid JSON");
		}
	}
	const input = parseClosedRecord(
		decoded,
		"deploy.json",
		["site", "buildCommand", "reloadCommand", "healthUrl"],
		[
			"schema",
			"autoRedeploy",
			"targetEnv",
			"paths",
			"rollbackCommand",
			"healthExpectStatus",
			"healthTimeoutMs",
			"healthAttempts",
			"healthIntervalMs",
			"injectRuntimeSecrets",
			"injectDatabaseUrl",
		],
	);
	const schema = input.schema ?? APP_DEPLOY_CONFIG_SCHEMA;
	if (schema !== APP_DEPLOY_CONFIG_SCHEMA) throw new RangeError("deploy.json schema is unsupported");
	const autoRedeploy = input.autoRedeploy === undefined ? false : input.autoRedeploy;
	if (typeof autoRedeploy !== "boolean") throw new RangeError("deploy.json autoRedeploy must be boolean");
	const site = parseBoundedText(input.site, "deploy.json site", 48);
	if (!APP_SLUG_PATTERN.test(site)) throw new RangeError("deploy.json site slug is invalid");
	const targetEnv = input.targetEnv === undefined ? "prod" : input.targetEnv;
	if (targetEnv !== "dev" && targetEnv !== "prod") throw new RangeError("deploy.json targetEnv must be dev or prod");
	let paths: readonly string[] = ["**"];
	if (input.paths !== undefined) {
		if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 20) {
			throw new RangeError("deploy.json paths must have 1 to 20 glob entries");
		}
		const seen = new Set<string>();
		const parsedPaths: string[] = [];
		for (const item of input.paths) {
			const pat = parseBoundedText(item, "deploy.json path glob", 256);
			if (CONTROL_CHARS.test(pat) || seen.has(pat)) {
				throw new RangeError("deploy.json paths contains an invalid or duplicate glob");
			}
			seen.add(pat);
			parsedPaths.push(pat);
		}
		paths = Object.freeze(parsedPaths);
	}
	const buildCommand = parseBoundedText(input.buildCommand, "deploy.json buildCommand", 2048);
	const reloadCommand = parseBoundedText(input.reloadCommand, "deploy.json reloadCommand", 2048);
	if (buildCommand.includes("\0") || reloadCommand.includes("\0")) {
		throw new RangeError("deploy.json command contains NUL byte");
	}
	const rollbackCommand =
		input.rollbackCommand === undefined
			? undefined
			: parseBoundedText(input.rollbackCommand, "deploy.json rollbackCommand", 2048);
	if (rollbackCommand?.includes("\0")) throw new RangeError("deploy.json rollbackCommand contains NUL byte");
	const healthUrl = parseHealthUrl(input.healthUrl);
	const healthExpectStatus =
		input.healthExpectStatus === undefined
			? 200
			: parseInteger(input.healthExpectStatus, "deploy.json healthExpectStatus", 100, 599);
	const healthTimeoutMs =
		input.healthTimeoutMs === undefined
			? 5000
			: parseInteger(input.healthTimeoutMs, "deploy.json healthTimeoutMs", 500, 30_000);
	const healthAttempts =
		input.healthAttempts === undefined ? 3 : parseInteger(input.healthAttempts, "deploy.json healthAttempts", 1, 10);
	const healthIntervalMs =
		input.healthIntervalMs === undefined
			? 500
			: parseInteger(input.healthIntervalMs, "deploy.json healthIntervalMs", 0, 10_000);
	const injectRuntimeSecrets = input.injectRuntimeSecrets === undefined ? true : input.injectRuntimeSecrets;
	if (typeof injectRuntimeSecrets !== "boolean") {
		throw new RangeError("deploy.json injectRuntimeSecrets must be boolean");
	}
	const injectDatabaseUrl = input.injectDatabaseUrl === undefined ? false : input.injectDatabaseUrl;
	if (typeof injectDatabaseUrl !== "boolean") {
		throw new RangeError("deploy.json injectDatabaseUrl must be boolean");
	}
	return Object.freeze({
		schema: APP_DEPLOY_CONFIG_SCHEMA,
		autoRedeploy,
		site,
		targetEnv,
		paths,
		buildCommand,
		reloadCommand,
		...(rollbackCommand === undefined ? {} : { rollbackCommand }),
		healthUrl,
		healthExpectStatus,
		healthTimeoutMs,
		healthAttempts,
		healthIntervalMs,
		injectRuntimeSecrets,
		injectDatabaseUrl,
	});
}

function matchSegment(pattern: string, value: string): boolean {
	let p = 0;
	let v = 0;
	let star = -1;
	let match = 0;
	while (v < value.length) {
		if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
			p += 1;
			v += 1;
		} else if (p < pattern.length && pattern[p] === "*") {
			star = p;
			match = v;
			p += 1;
		} else if (star !== -1) {
			p = star + 1;
			match += 1;
			v = match;
		} else {
			return false;
		}
	}
	while (p < pattern.length && pattern[p] === "*") p += 1;
	return p === pattern.length;
}

export function globMatchesPath(pattern: string, targetPath: string): boolean {
	if (!pattern || !targetPath || pattern.length > 256 || targetPath.length > 4096) return false;
	if (CONTROL_CHARS.test(pattern) || CONTROL_CHARS.test(targetPath)) return false;
	const normPattern = pattern.replace(/\*{3,}/g, "**");
	const pSegs = normPattern.split("/");
	const tSegs = targetPath.split("/");
	const rows = pSegs.length + 1;
	const cols = tSegs.length + 1;
	const dp = new Uint8Array(rows * cols);
	dp[0] = 1;
	for (let i = 1; i <= pSegs.length; i += 1) {
		if (pSegs[i - 1] === "**") dp[i * cols] = dp[(i - 1) * cols]!;
	}
	for (let i = 1; i <= pSegs.length; i += 1) {
		const pSeg = pSegs[i - 1]!;
		for (let j = 1; j <= tSegs.length; j += 1) {
			if (pSeg === "**") {
				dp[i * cols + j] = dp[(i - 1) * cols + j]! | dp[i * cols + (j - 1)]!;
			} else if (matchSegment(pSeg, tSegs[j - 1]!)) {
				dp[i * cols + j] = dp[(i - 1) * cols + (j - 1)]!;
			}
		}
	}
	return dp[pSegs.length * cols + tSegs.length] === 1;
}

export function shouldAutoRedeployOnCodeChange(
	config: AppAutoRedeployConfig,
	event: CodeChangeLandedEvent,
): { readonly matched: boolean; readonly reason?: "disabled" | "event_kind" | "paths_unmatched" } {
	if (!config.autoRedeploy) return { matched: false, reason: "disabled" };
	if (event.kind !== "landed") return { matched: false, reason: "event_kind" };
	const hit = event.paths.some((filePath) => config.paths.some((pattern) => globMatchesPath(pattern, filePath)));
	if (!hit) return { matched: false, reason: "paths_unmatched" };
	return { matched: true };
}

async function defaultHttpProbe(
	input: { readonly url: string; readonly expectStatus: number; readonly timeoutMs: number },
	signal: AbortSignal,
): Promise<{ readonly ok: boolean; readonly status: number | null; readonly error?: string }> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), input.timeoutMs);
	try {
		const response = await fetch(input.url, { method: "GET", redirect: "manual", signal: controller.signal });
		await response.body?.cancel().catch(() => undefined);
		const ok = response.status === input.expectStatus;
		return ok
			? { ok: true, status: response.status }
			: {
					ok: false,
					status: response.status,
					error: `Expected HTTP ${input.expectStatus}, received ${response.status}`,
				};
	} catch (error) {
		if (signal.aborted) throw error;
		const message = error instanceof Error ? error.message : "Health probe failed";
		return { ok: false, status: null, error: message };
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolvePromise, rejectPromise) => {
		if (signal.aborted) {
			rejectPromise(signal.reason ?? new Error("Aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			rejectPromise(signal.reason ?? new Error("Aborted"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export async function runPostLandAppAutoRedeploy(options: {
	readonly config: AppAutoRedeployConfig;
	readonly event: CodeChangeLandedEvent;
	readonly hooks: AppAutoRedeployHooks;
	readonly secretsManager?: CompanyMachineSecretsManager;
	readonly signal: AbortSignal;
}): Promise<AppAutoRedeployResult> {
	const { config, event, hooks, secretsManager, signal } = options;
	const check = shouldAutoRedeployOnCodeChange(config, event);
	if (!check.matched) {
		return { status: "skipped", reason: check.reason ?? "paths_unmatched" };
	}
	if (!COMMIT_SHA.test(event.mainAfter)) {
		throw new RangeError("Code change mainAfter SHA is invalid");
	}
	signal.throwIfAborted();
	const previousReleaseId = await hooks.currentReleaseId(config.site, signal);
	let envPath: string | null = null;
	let mask = new CodingSecretMask();
	if (config.injectRuntimeSecrets && hooks.loadRuntimeSecrets && secretsManager) {
		const loaded = await hooks.loadRuntimeSecrets(config.site, config.targetEnv, signal);
		const bundle: HostedAppSecretBundle = config.injectDatabaseUrl
			? loaded
			: {
					siteId: loaded.siteId,
					slug: loaded.slug,
					scope: loaded.scope,
					targetEnv: loaded.targetEnv,
					secrets: loaded.secrets,
					...(loaded.config === undefined ? {} : { config: loaded.config }),
					...(loaded.maskHistory === undefined ? {} : { maskHistory: loaded.maskHistory }),
				};
		const delivered = await secretsManager.deliver(bundle);
		envPath = delivered.envPath;
		mask = delivered.mask;
	}
	let releaseId: string;
	try {
		const built = await hooks.build(
			{ site: config.site, commitSha: event.mainAfter, command: config.buildCommand, envPath },
			signal,
		);
		releaseId = built.releaseId;
	} catch (error) {
		if (signal.aborted) throw error;
		const rawMessage = error instanceof Error ? error.message : "Build failed";
		return {
			status: "build_failed",
			site: config.site,
			commitSha: event.mainAfter,
			rolledBack: false,
			error: maskAppLogText(mask, rawMessage),
		};
	}
	let lastError = "Health check failed";
	let reloadFailed = false;
	try {
		await hooks.reload(
			{ site: config.site, commitSha: event.mainAfter, releaseId, command: config.reloadCommand, envPath },
			signal,
		);
	} catch (error) {
		if (signal.aborted) throw error;
		reloadFailed = true;
		lastError = error instanceof Error ? error.message : "Reload failed";
	}
	if (!reloadFailed) {
		const probe = hooks.probeHealth ?? defaultHttpProbe;
		for (let attempt = 1; attempt <= config.healthAttempts; attempt += 1) {
			signal.throwIfAborted();
			const result = await probe(
				{ url: config.healthUrl, expectStatus: config.healthExpectStatus, timeoutMs: config.healthTimeoutMs },
				signal,
			);
			if (result.ok) {
				return {
					status: "deployed",
					site: config.site,
					commitSha: event.mainAfter,
					releaseId,
					healthStatus: result.status,
					attempts: attempt,
				};
			}
			lastError = result.error ?? `Unhealthy response (${String(result.status ?? "no status")})`;
			if (attempt < config.healthAttempts) {
				await pause(config.healthIntervalMs, signal);
			}
		}
	}
	const maskedError = maskAppLogText(mask, lastError);
	await hooks.rollback(
		{
			site: config.site,
			previousReleaseId,
			failedReleaseId: releaseId,
			command: config.rollbackCommand,
		},
		signal,
	);
	if (hooks.emitAppUnhealthy) {
		await hooks.emitAppUnhealthy(
			{
				site: config.site,
				status: "rollback_triggered",
				restartCount: config.healthAttempts,
				error: maskedError,
			},
			signal,
		);
	}
	return {
		status: "rolled_back",
		site: config.site,
		commitSha: event.mainAfter,
		failedReleaseId: releaseId,
		restoredReleaseId: previousReleaseId,
		error: maskedError,
	};
}
