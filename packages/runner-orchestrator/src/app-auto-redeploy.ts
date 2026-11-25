import { createHash } from "node:crypto";
import {
	type CloudCodingRepository,
	isUuid,
	parseBoundedText,
	parseClosedRecord,
	parseInteger,
} from "@qorpera/contracts";
import type { CodeHostJob } from "./code-host-jobs.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import type { CodingAutoRedeployContext, CodingExecutorPublication, CodingSessionClaim } from "./coding-executor.ts";
import { CodingSecretMask } from "./coding-secret-mask.ts";
import {
	APP_SLUG_PATTERN,
	type CompanyMachineSecretsManager,
	type HostedAppSecretBundle,
	type HostedAppTargetEnv,
	maskAppLogText,
} from "./company-machine-secrets.ts";
import {
	type BuildAppImageFn,
	buildAppImageWithScript,
	buildNativeAppEnvSpec,
	type NativeEdgeHostingConfig,
	triggerBlueGreenAppDeploy,
} from "./native-webapp-deploy.ts";
import {
	type RoutineProbeDnsLookup,
	resolveAndValidateProbeAddress,
	sendPinnedIpProbe,
	validateRoutineProbeUrl,
} from "./routine-check-gate.ts";

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
	loadBuildSecrets?(
		site: string,
		targetEnv: HostedAppTargetEnv,
		signal: AbortSignal,
	): Promise<HostedAppSecretBundle | null>;
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
	lookup?: RoutineProbeDnsLookup;
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
	  }
	| {
			readonly status: "rollback_failed";
			readonly site: string;
			readonly commitSha: string;
			readonly failedReleaseId: string;
			readonly restoredReleaseId: string | null;
			readonly error: string;
			readonly rollbackError: string;
	  };

function parseHealthUrl(raw: unknown): string {
	const value = parseBoundedText(raw, "deploy.json healthUrl", 1024);
	if (CONTROL_CHARS.test(value)) throw new RangeError("deploy.json healthUrl contains control characters");
	const parsed = validateRoutineProbeUrl(value, true);
	return parsed.toString();
}

export function parseAppDeployConfig(
	raw: string | unknown,
	options?: { readonly allowRuntimeSecretInjection?: boolean },
): AppAutoRedeployConfig {
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
	const injectRuntimeSecrets = input.injectRuntimeSecrets === undefined ? false : input.injectRuntimeSecrets;
	if (typeof injectRuntimeSecrets !== "boolean") {
		throw new RangeError("deploy.json injectRuntimeSecrets must be boolean");
	}
	const injectDatabaseUrl = input.injectDatabaseUrl === undefined ? false : input.injectDatabaseUrl;
	if (typeof injectDatabaseUrl !== "boolean") {
		throw new RangeError("deploy.json injectDatabaseUrl must be boolean");
	}
	if ((injectRuntimeSecrets || injectDatabaseUrl) && !options?.allowRuntimeSecretInjection) {
		throw new RangeError("deploy.json runtime secret injection is not yet supported by app-host");
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
	lookup?: RoutineProbeDnsLookup,
): Promise<{ readonly ok: boolean; readonly status: number | null; readonly error?: string }> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), input.timeoutMs);
	try {
		const parsed = validateRoutineProbeUrl(input.url, true);
		const resolved = await resolveAndValidateProbeAddress(parsed, { allowLocalhost: true, lookup });
		const answer = await sendPinnedIpProbe(parsed, resolved, controller.signal);
		const ok = answer.status === input.expectStatus;
		return ok
			? { ok: true, status: answer.status }
			: {
					ok: false,
					status: answer.status,
					error: `Expected HTTP ${input.expectStatus}, received ${answer.status}`,
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

	let buildEnvPath: string | null = null;
	let buildMask = new CodingSecretMask();
	let deliveredBuild: Awaited<ReturnType<CompanyMachineSecretsManager["deliverBuild"]>> | null = null;
	if (hooks.loadBuildSecrets && secretsManager) {
		const buildBundle = await hooks.loadBuildSecrets(config.site, config.targetEnv, signal);
		if (buildBundle !== null) {
			deliveredBuild = await secretsManager.deliverBuild(buildBundle);
			buildEnvPath = deliveredBuild.envPath;
			buildMask = deliveredBuild.mask;
		}
	}

	let releaseId: string;
	try {
		const built = await hooks.build(
			{ site: config.site, commitSha: event.mainAfter, command: config.buildCommand, envPath: buildEnvPath },
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
			error: maskAppLogText(buildMask, rawMessage),
		};
	} finally {
		if (deliveredBuild) {
			await deliveredBuild.scrub().catch(() => undefined);
		}
	}

	let runtimeEnvPath: string | null = null;
	let runtimeMask = new CodingSecretMask();
	let runtimeEnvUpdated = false;
	let previousRuntimeEnv: Buffer | null = null;
	try {
		if (config.injectRuntimeSecrets) {
			if (!hooks.loadRuntimeSecrets || !secretsManager) {
				throw new Error("APP_SECRETS_DELIVERY_UNAVAILABLE");
			}
			previousRuntimeEnv = await secretsManager.snapshot(config.site);
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
			runtimeEnvPath = delivered.envPath;
			runtimeMask = delivered.mask;
			runtimeEnvUpdated = true;
		}

		let lastError = "Health check failed";
		let reloadFailed = false;
		try {
			await hooks.reload(
				{
					site: config.site,
					commitSha: event.mainAfter,
					releaseId,
					command: config.reloadCommand,
					envPath: runtimeEnvPath,
				},
				signal,
			);
		} catch (error) {
			if (signal.aborted) throw error;
			reloadFailed = true;
			lastError = error instanceof Error ? error.message : "Reload failed";
		}

		if (!reloadFailed) {
			const probe = hooks.probeHealth ?? ((input, s) => defaultHttpProbe(input, s, hooks.lookup));
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

		const maskedError = maskAppLogText(runtimeMask, lastError);
		if (runtimeEnvUpdated && secretsManager) {
			await secretsManager.restore(config.site, previousRuntimeEnv).catch(() => undefined);
		}
		try {
			await hooks.rollback(
				{
					site: config.site,
					previousReleaseId,
					failedReleaseId: releaseId,
					command: config.rollbackCommand,
				},
				signal,
			);
		} catch (rollbackFailure) {
			if (signal.aborted) throw rollbackFailure;
			const rawRollbackError = rollbackFailure instanceof Error ? rollbackFailure.message : "Rollback failed";
			const maskedRollbackError = maskAppLogText(runtimeMask, rawRollbackError);
			if (hooks.emitAppUnhealthy) {
				await hooks.emitAppUnhealthy(
					{
						site: config.site,
						status: "rollback_failed",
						restartCount: config.healthAttempts,
						error: `${maskedError}; rollback failed: ${maskedRollbackError}`,
					},
					signal,
				);
			}
			return {
				status: "rollback_failed",
				site: config.site,
				commitSha: event.mainAfter,
				failedReleaseId: releaseId,
				restoredReleaseId: previousReleaseId,
				error: maskedError,
				rollbackError: maskedRollbackError,
			};
		}

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
	} finally {
		previousRuntimeEnv?.fill(0);
	}
}

export interface NativeEdgeAutoRedeployOptions {
	readonly control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	readonly codeHostJobs: Pick<CodeHostJobs, "run">;
	readonly nativeEdge: NativeEdgeHostingConfig;
	readonly owner: string;
	readonly machineIdSha256: string;
	readonly readDeployConfig: (
		job: CodeHostJob,
		value: { repository: CloudCodingRepository; commitSha: string },
	) => Promise<{ rawConfig: string; paths: string[] } | null>;
	readonly exportSource: (
		job: CodeHostJob,
		value: { repository: CloudCodingRepository; tree: string; kind?: "static" | "server" | "hybrid" },
	) => Promise<{ sourceDir: string; cleanup?: () => Promise<void> }>;
	readonly serialize?: <T>(repoKey: string, fn: () => Promise<T>) => Promise<T>;
	readonly onRegistered?: (changeKey: string) => void;
}

const OCI_DIGEST_REF = /^[^\s\x00-\x1f]+@sha256:[0-9a-f]{64}$/;

export function createNativeEdgeAutoRedeploy(
	options: NativeEdgeAutoRedeployOptions,
): (
	claim: CodingSessionClaim,
	landed: NonNullable<CodingExecutorPublication["landed"]>,
	signal: AbortSignal,
) => Promise<CodingAutoRedeployContext | null> {
	return async (claim, landed, signal) => {
		const repository = claim.repository;
		if (!repository || repository.host !== "qorpera" || landed.state === "unchanged") return null;
		const change = landed.change;
		if (change === null || !Number.isSafeInteger(change) || change < 1) return null;
		const appHostInternalUrl = options.nativeEdge.appHostInternalUrl;
		const appHostControlToken = options.nativeEdge.appHostControlToken;
		if (!appHostInternalUrl || !appHostControlToken) return null;

		const configResult = await options.codeHostJobs.run(
			claim.profileId,
			claim.environmentId,
			signal,
			(job) => options.readDeployConfig(job, { repository, commitSha: landed.mainSha }),
			{ yields: true },
		);
		if (!configResult) return null;

		const parsedConfig = parseAppDeployConfig(JSON.parse(configResult.rawConfig));
		const match = shouldAutoRedeployOnCodeChange(parsedConfig, {
			kind: "landed",
			repo: `${repository.owner}/${repository.name}`,
			change: String(change),
			mainBefore: landed.mainBefore ?? null,
			mainAfter: landed.mainSha,
			paths: configResult.paths,
		});
		if (!match.matched) return null;

		const lookupSite = async (hookSignal: AbortSignal) =>
			(await options.control.call(
				"qorpera_code_site_for_auto_redeploy",
				{
					p_owner: options.owner,
					p_machine_id_sha256: options.machineIdSha256,
					p_environment_id: claim.environmentId,
					p_repository_owner: repository.owner,
					p_name: repository.name,
					p_change: change,
				},
				hookSignal,
			)) as Record<string, unknown> | null;

		const lookup = await lookupSite(signal);
		if (
			!lookup ||
			lookup.schema !== "qorpera.code-site-auto-redeploy/v1" ||
			lookup.found !== true ||
			lookup.kind !== "server" ||
			!isUuid(lookup.siteId) ||
			typeof lookup.slug !== "string" ||
			lookup.slug !== parsedConfig.site ||
			!isUuid(lookup.currentDeploymentId) ||
			typeof lookup.currentImageRef !== "string" ||
			!OCI_DIGEST_REF.test(lookup.currentImageRef)
		) {
			return null;
		}
		const siteId = lookup.siteId;
		const slug = lookup.slug;
		const currentDeploymentId = lookup.currentDeploymentId;
		const currentImageRef = lookup.currentImageRef;
		const tree = typeof lookup.tree === "string" && COMMIT_SHA.test(lookup.tree) ? lookup.tree : landed.mainSha;
		const dockerfile =
			typeof lookup.dockerfile === "string" && lookup.dockerfile.length > 0 ? lookup.dockerfile : null;
		const appPort =
			typeof lookup.appPort === "number" && Number.isSafeInteger(lookup.appPort) ? lookup.appPort : 3000;
		const healthPath = typeof lookup.healthPath === "string" ? lookup.healthPath : "/";
		const idleTimeoutSec =
			typeof lookup.idleTimeoutSec === "number" && Number.isSafeInteger(lookup.idleTimeoutSec)
				? lookup.idleTimeoutSec
				: 900;
		const memoryMb =
			typeof lookup.memoryMb === "number" && Number.isSafeInteger(lookup.memoryMb) ? lookup.memoryMb : 512;
		const vcpuLimit =
			typeof lookup.vcpuLimit === "number" && Number.isFinite(lookup.vcpuLimit) ? lookup.vcpuLimit : 1;

		const releaseImages = new Map<string, string>([[currentDeploymentId, currentImageRef]]);
		let startedNewOnAppHost = false;
		let promotedNewInDb = false;
		const envSpec = buildNativeAppEnvSpec({
			port: appPort,
			repositoryOwner: repository.owner,
			repositoryName: repository.name,
			companyDataUrl: options.nativeEdge.companyDataUrl,
			objectStorageUrl: options.nativeEdge.objectStorageUrl,
		});
		const repoKey = `${claim.environmentId}:${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
		const changeKey = `${repoKey}:${change}`;

		const switchLiveDeployment = async (
			deploymentId: string,
			upstreamAddr: string,
			mode: "release" | "back",
			hookSignal: AbortSignal,
		): Promise<void> => {
			const switched = (await options.control.call(
				"qorpera_code_site_auto_redeploy_switch",
				{
					p_owner: options.owner,
					p_machine_id_sha256: options.machineIdSha256,
					p_environment_id: claim.environmentId,
					p_site_id: siteId,
					p_deployment_id: deploymentId,
					p_upstream_addr: upstreamAddr,
					p_mode: mode,
				},
				hookSignal,
			)) as Record<string, unknown> | null;
			if (
				!switched ||
				switched.schema !== "qorpera.code-site-auto-redeploy-switch/v1" ||
				switched.state !== "live"
			) {
				const code = typeof switched?.code === "string" ? switched.code : String(switched?.state ?? "UNCONFIRMED");
				throw new Error(`AUTO_REDEPLOY_SWITCH_FAILED_${code}`);
			}
		};

		return {
			rawConfig: configResult.rawConfig,
			siteId,
			paths: configResult.paths,
			hooks: {
				currentReleaseId: async () => currentDeploymentId,
				build: async (_input, hookSignal) => {
					const runBuild = async (): Promise<{ releaseId: string }> => {
						const fresh = await lookupSite(hookSignal);
						if (
							fresh &&
							fresh.schema === "qorpera.code-site-auto-redeploy/v1" &&
							fresh.found === true &&
							isUuid(fresh.existingDeploymentId) &&
							typeof fresh.existingImageRef === "string" &&
							OCI_DIGEST_REF.test(fresh.existingImageRef)
						) {
							if (fresh.existingDeploymentId === currentDeploymentId) {
								throw new Error("AUTO_REDEPLOY_UNCHANGED_DEPLOYMENT");
							}
							releaseImages.set(fresh.existingDeploymentId, fresh.existingImageRef);
							return { releaseId: fresh.existingDeploymentId };
						}
						const exported = await options.codeHostJobs.run(
							claim.profileId,
							claim.environmentId,
							hookSignal,
							(job) =>
								options.exportSource(job, {
									repository,
									tree,
									kind: "server",
								}),
							{ yields: true },
						);
						try {
							const builderFn: BuildAppImageFn =
								options.nativeEdge.buildAppImage ??
								((buildInput, buildSignal) =>
									buildAppImageWithScript(
										options.nativeEdge.builderScriptPath ??
											"/usr/local/libexec/qorpera-web-hosting/builder-railpack.sh",
										buildInput,
										buildSignal,
									));
							const built = await builderFn(
								{
									target: {
										companyId: claim.profileId,
										environmentId: claim.environmentId,
										owner: repository.owner,
										name: repository.name,
									},
									change,
									tree,
									sourceDir: exported.sourceDir,
									dockerfile,
									port: appPort,
									registryPrefix: options.nativeEdge.registryPrefix ?? "127.0.0.1:5000/qorpera-apps",
								},
								hookSignal,
							);
							if (!OCI_DIGEST_REF.test(built.ociImageRef)) {
								throw new Error("APP_IMAGE_REF_INVALID");
							}
							const manifestSha256 = createHash("sha256").update(`server:${tree}`, "utf8").digest("hex");
							const registered = (await options.control.call(
								"qorpera_web_code_deployment_register",
								{
									p_owner: options.owner,
									p_machine_id_sha256: options.machineIdSha256,
									p_environment_id: claim.environmentId,
									p_repository_owner: repository.owner,
									p_name: repository.name,
									p_change: change,
									p_kind: "server",
									p_manifest_sha256: manifestSha256,
									p_manifest_json: {
										files: {},
										redirects: [],
										headers: [],
										spa_fallback: null,
										not_found_page: null,
									},
									p_file_count: 0,
									p_total_bytes: 0,
									p_oci_image_ref: built.ociImageRef,
									p_app_port: appPort,
									p_health_path: healthPath,
									p_idle_timeout_sec: idleTimeoutSec,
									p_memory_mb: memoryMb,
									p_vcpu_limit: vcpuLimit,
									p_has_credential_inputs: false,
									p_upstream_addr: null,
									p_env_spec: envSpec,
								},
								hookSignal,
							)) as Record<string, unknown> | null;
							if (
								!registered ||
								registered.schema !== "qorpera.web-code-deployment/v1" ||
								(registered.state !== "ready" && registered.state !== "live" && registered.state !== "kept") ||
								!isUuid(registered.deploymentId)
							) {
								const code =
									typeof registered?.code === "string"
										? registered.code
										: String(registered?.state ?? "UNCONFIRMED");
								throw new Error(`AUTO_REDEPLOY_REGISTER_FAILED_${code}`);
							}
							if (registered.deploymentId === currentDeploymentId) {
								throw new Error("AUTO_REDEPLOY_UNCHANGED_DEPLOYMENT");
							}
							options.onRegistered?.(changeKey);
							releaseImages.set(registered.deploymentId, built.ociImageRef);
							return { releaseId: registered.deploymentId };
						} finally {
							if (exported.cleanup) {
								await exported.cleanup().catch(() => undefined);
							}
						}
					};
					return options.serialize ? await options.serialize(repoKey, runBuild) : await runBuild();
				},
				reload: async (input, hookSignal) => {
					const ociImageRef = releaseImages.get(input.releaseId);
					if (!ociImageRef) throw new Error("AUTO_REDEPLOY_IMAGE_MISSING");
					const deployed = await triggerBlueGreenAppDeploy({
						appHostInternalUrl,
						controlToken: appHostControlToken,
						deploymentId: input.releaseId,
						siteId,
						slug,
						ociImageRef,
						healthPath,
						idleTimeoutSec,
						memoryMb,
						vcpuLimit,
						env: envSpec,
						...(options.nativeEdge.appHostFetchImpl ? { fetchImpl: options.nativeEdge.appHostFetchImpl } : {}),
						signal: hookSignal,
					});
					startedNewOnAppHost = true;
					await switchLiveDeployment(input.releaseId, deployed.upstreamAddr, "release", hookSignal);
					promotedNewInDb = true;
				},
				rollback: async (input, hookSignal) => {
					if (!input.previousReleaseId || (!startedNewOnAppHost && !promotedNewInDb)) return;
					const previousImage = releaseImages.get(input.previousReleaseId);
					if (!previousImage) throw new Error("AUTO_REDEPLOY_PREVIOUS_IMAGE_MISSING");
					const restored = await triggerBlueGreenAppDeploy({
						appHostInternalUrl,
						controlToken: appHostControlToken,
						deploymentId: input.previousReleaseId,
						siteId,
						slug,
						ociImageRef: previousImage,
						healthPath,
						idleTimeoutSec,
						memoryMb,
						vcpuLimit,
						env: envSpec,
						...(options.nativeEdge.appHostFetchImpl ? { fetchImpl: options.nativeEdge.appHostFetchImpl } : {}),
						signal: hookSignal,
					});
					if (promotedNewInDb) {
						await switchLiveDeployment(input.previousReleaseId, restored.upstreamAddr, "back", hookSignal);
					}
				},
			},
		};
	};
}
