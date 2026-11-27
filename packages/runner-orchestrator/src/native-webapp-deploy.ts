import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { isUuid } from "@qorpera/contracts";
import { withTimeoutScope } from "./abort-scope.ts";
import type { CodeChangeRecordsOptions } from "./code-change-records.ts";
import { CODE_SITE_MAX_BYTES, CODE_SITE_MAX_FILES } from "./code-site.ts";
import type { CodeSiteTarget, CodeSiteUploadFile } from "./code-site-uploads.ts";
import { buildAppSecretMask } from "./coding-command-secrets.ts";
import { CodingSecretMask } from "./coding-secret-mask.ts";
import {
	appSecretEnvNameAllowed,
	type CompanyMachineSecretsManager,
	fetchHostedAppSecrets,
	type HostedAppTargetEnv,
	maskAppLogText,
} from "./company-machine-secrets.ts";
import {
	type BlobUploadFetch,
	NATIVE_SITE_MAX_BYTES,
	NATIVE_SITE_MAX_FILES,
	type SiteManifestPayload,
	uploadSiteBlobsToEdge,
} from "./site-blob-upload.ts";

const execFileAsync = promisify(execFile);

export const NATIVE_WEB_HOSTING_RPCS = [
	"qorpera_web_code_deployment_register",
	"qorpera_code_site_for_auto_redeploy",
	"qorpera_code_site_auto_redeploy_switch",
	"qorpera_emit_app_unhealthy_routine_wakes",
] as const;

const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const OCI_DIGEST_REF_PATTERN = /^[^\s\x00-\x1f]+@sha256:[0-9a-f]{64}$/;

export type NativeSiteKind = "static" | "server" | "hybrid";

export interface NativeCodeSiteSpec {
	readonly schema: "qorpera.code-site/v1" | "qorpera.code-site/v2";
	readonly kind: NativeSiteKind;
	readonly tree: string;
	readonly files: number;
	readonly bytes: number;
	readonly folder: string;
	readonly name: string | null;
	readonly title: string | null;
	readonly port: number | null;
	readonly healthPath: string;
	readonly dockerfile: string | null;
	readonly idleTimeoutSec: number;
	readonly memoryMb: number;
	readonly vcpuLimit: number;
	readonly spaFallback: string | null;
}

export interface BuildAppImageInput {
	readonly target: CodeSiteTarget;
	readonly change: number;
	readonly tree: string;
	readonly sourceDir: string;
	readonly dockerfile: string | null;
	readonly port: number;
	readonly registryPrefix: string;
}

export interface BuildAppImageResult {
	readonly ociImageRef: string;
	readonly builtMs: number;
}

export type BuildAppImageFn = (input: BuildAppImageInput, signal: AbortSignal) => Promise<BuildAppImageResult>;

export interface AppHostFetchResponse {
	readonly status: number;
	readonly body: string;
}

export type AppHostFetch = (
	url: string,
	init: {
		method: "GET" | "POST" | "DELETE";
		headers: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<AppHostFetchResponse>;

export interface NativeEdgeBrokerConfig {
	readonly origin: string;
	readonly executorToken: string;
	readonly executorOwner: string;
	readonly machineIdSha256: string;
	readonly fetchImpl?: typeof fetch;
}

export interface NativeEdgeHostingConfig {
	readonly routerInternalUrl: string;
	readonly controlToken: string;
	readonly appHostInternalUrl?: string;
	readonly appHostControlToken?: string;
	readonly builderScriptPath?: string;
	readonly registryPrefix?: string;
	readonly companyDataUrl?: string;
	readonly companyDataDirectLoginToken?: string;
	readonly companyDataPublicUrl?: string;
	readonly objectStorageUrl?: string;
	readonly broker?: NativeEdgeBrokerConfig;
	readonly buildAppImage?: BuildAppImageFn;
	readonly fetchImpl?: BlobUploadFetch;
	readonly appHostFetchImpl?: AppHostFetch;
	readonly companyDataFetchImpl?: AppHostFetch;
}

export interface NativeDeploymentRegistered {
	readonly state: "ready" | "live" | "kept";
	readonly siteId: string;
	readonly slug: string;
	readonly versionId: string;
	readonly deploymentId: string;
	readonly versionNumber: number;
	readonly kind: NativeSiteKind;
	readonly uploadedBlobs: number;
	readonly deduplicatedBlobs: number;
	readonly ociImageRef: string | null;
}

export interface AppLogEntry {
	readonly ts_ms: number;
	readonly stream: string;
	readonly line: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWhole(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function parseNativeCodeSiteSpec(raw: unknown): NativeCodeSiteSpec | null {
	if (!isRecord(raw)) return null;
	const schema = raw.schema;
	if (schema !== "qorpera.code-site/v1" && schema !== "qorpera.code-site/v2") return null;
	if (typeof raw.tree !== "string" || !SHA1_PATTERN.test(raw.tree)) return null;
	if (typeof raw.folder !== "string" || !raw.folder) return null;
	const name = typeof raw.name === "string" ? raw.name : raw.name === null ? null : undefined;
	const title = typeof raw.title === "string" ? raw.title : raw.title === null ? null : undefined;
	if (name === undefined || title === undefined) return null;

	if (schema === "qorpera.code-site/v1") {
		if (!isWhole(raw.files, 1, CODE_SITE_MAX_FILES) || !isWhole(raw.bytes, 0, CODE_SITE_MAX_BYTES)) return null;
		return {
			schema,
			kind: "static",
			tree: raw.tree,
			files: raw.files,
			bytes: raw.bytes,
			folder: raw.folder,
			name,
			title,
			port: null,
			healthPath: "/",
			dockerfile: null,
			idleTimeoutSec: 900,
			memoryMb: 512,
			vcpuLimit: 1,
			spaFallback: null,
		};
	}

	const kind = raw.kind;
	if (kind !== "static" && kind !== "server" && kind !== "hybrid") return null;
	const minFiles = kind === "static" ? 1 : 0;
	if (!isWhole(raw.files, minFiles, NATIVE_SITE_MAX_FILES) || !isWhole(raw.bytes, 0, NATIVE_SITE_MAX_BYTES))
		return null;

	const port =
		raw.port === undefined || raw.port === null
			? kind === "static"
				? null
				: 3000
			: isWhole(raw.port, 1, 65535)
				? raw.port
				: undefined;
	if (port === undefined) return null;

	const healthPath =
		raw.healthPath === undefined || raw.healthPath === null
			? "/"
			: typeof raw.healthPath === "string" && raw.healthPath.startsWith("/") && raw.healthPath.length <= 256
				? raw.healthPath
				: undefined;
	if (healthPath === undefined) return null;

	const dockerfile =
		raw.dockerfile === undefined || raw.dockerfile === null
			? null
			: typeof raw.dockerfile === "string" && raw.dockerfile.length > 0
				? raw.dockerfile
				: undefined;
	if (dockerfile === undefined) return null;

	const idleTimeoutSec =
		raw.idleTimeoutSec === undefined || raw.idleTimeoutSec === null
			? 900
			: isWhole(raw.idleTimeoutSec, 0, 86400)
				? raw.idleTimeoutSec
				: undefined;
	if (idleTimeoutSec === undefined) return null;

	const memoryMb =
		raw.memoryMb === undefined || raw.memoryMb === null
			? 512
			: isWhole(raw.memoryMb, 64, 8192)
				? raw.memoryMb
				: undefined;
	if (memoryMb === undefined) return null;

	const vcpuLimit =
		raw.vcpuLimit === undefined || raw.vcpuLimit === null
			? 1
			: typeof raw.vcpuLimit === "number" &&
					Number.isFinite(raw.vcpuLimit) &&
					raw.vcpuLimit >= 0.25 &&
					raw.vcpuLimit <= 8
				? raw.vcpuLimit
				: undefined;
	if (vcpuLimit === undefined) return null;

	const spaFallback =
		raw.spaFallback === undefined || raw.spaFallback === null
			? null
			: typeof raw.spaFallback === "string" && raw.spaFallback.length > 0
				? raw.spaFallback
				: undefined;
	if (spaFallback === undefined) return null;

	return {
		schema,
		kind,
		tree: raw.tree,
		files: raw.files,
		bytes: raw.bytes,
		folder: raw.folder,
		name,
		title,
		port,
		healthPath,
		dockerfile,
		idleTimeoutSec,
		memoryMb,
		vcpuLimit,
		spaFallback,
	};
}

const RUNTIME_ENV_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const RUNTIME_ENV_PLATFORM_KEYS = new Set(["PORT", "NODE_ENV", "DATABASE_URL"]);
const LINKED_DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export function buildNativeAppEnvSpec(options: {
	readonly port: number;
	readonly repositoryOwner: string;
	readonly repositoryName: string;
	readonly companyDataUrl?: string;
	readonly companyDataPublicUrl?: string;
	readonly objectStorageUrl?: string;
	readonly runtimeEnvConfig?: Readonly<Record<string, string>>;
}): Record<string, string> {
	const merged: Record<string, string> = {};
	if (options.runtimeEnvConfig) {
		for (const key of Object.keys(options.runtimeEnvConfig).sort()) {
			const value = options.runtimeEnvConfig[key];
			if (
				typeof value !== "string" ||
				!appSecretEnvNameAllowed(key) ||
				RUNTIME_ENV_PLATFORM_KEYS.has(key) ||
				value.length > 4096 ||
				RUNTIME_ENV_CONTROL_CHARS.test(value)
			) {
				continue;
			}
			merged[key] = value;
		}
	}
	merged.PORT = String(options.port);
	merged.NODE_ENV = "production";
	merged.QORPERA_REPOSITORY = `${options.repositoryOwner}/${options.repositoryName}`;
	if (options.companyDataUrl) merged.QORPERA_COMPANY_DATA_URL = options.companyDataUrl;
	if (options.companyDataPublicUrl) merged.QORPERA_COMPANY_DATA_PUBLIC_URL = options.companyDataPublicUrl;
	if (options.objectStorageUrl) merged.QORPERA_OBJECT_STORAGE_URL = options.objectStorageUrl;
	return merged;
}

const DIRECT_LOGIN_PRINCIPAL_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/;

export async function provisionCompanyDataDirectLogin(options: {
	readonly companyDataUrl: string;
	readonly directLoginToken: string;
	readonly environmentId: string;
	readonly database: string;
	readonly principal?: string;
	readonly generation?: string;
	readonly access?: "read-write" | "read-only";
	readonly connectionLimit?: number;
	readonly fetchImpl?: AppHostFetch;
	readonly signal?: AbortSignal;
}): Promise<{
	readonly connectionString: string;
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly schema: string;
	readonly user: string;
}> {
	if (!isUuid(options.environmentId)) {
		throw new Error("COMPANY_DATA_DIRECT_LOGIN_ENV_INVALID");
	}
	if (
		!LINKED_DATABASE_NAME_PATTERN.test(options.database) ||
		options.database === "qorpera" ||
		options.database.startsWith("pg_") ||
		options.database.startsWith("qorpera_")
	) {
		throw new Error("COMPANY_DATA_DIRECT_LOGIN_DATABASE_INVALID");
	}
	if (options.principal !== undefined && !DIRECT_LOGIN_PRINCIPAL_PATTERN.test(options.principal)) {
		throw new Error("COMPANY_DATA_DIRECT_LOGIN_PRINCIPAL_INVALID");
	}
	if (options.generation !== undefined) {
		if (options.principal === undefined || !DIRECT_LOGIN_PRINCIPAL_PATTERN.test(options.generation)) {
			throw new Error("COMPANY_DATA_DIRECT_LOGIN_GENERATION_INVALID");
		}
	}
	const base = options.companyDataUrl.replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? defaultAppHostFetch;
	const res = await fetchImpl(
		`${base}/v1/admin/company-data/${encodeURIComponent(options.environmentId)}/direct-login`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${options.directLoginToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				database: options.database,
				access: options.access ?? "read-write",
				connectionLimit: options.connectionLimit ?? 4,
				...(options.principal !== undefined ? { principal: options.principal } : {}),
				...(options.generation !== undefined ? { generation: options.generation } : {}),
			}),
			signal: options.signal,
		},
	);
	if (res.status !== 200) {
		throw new Error(`COMPANY_DATA_DIRECT_LOGIN_FAILED_${res.status}`);
	}
	const parsed = JSON.parse(res.body) as unknown;
	if (
		!isRecord(parsed) ||
		typeof parsed.connectionString !== "string" ||
		!/^postgres(?:ql)?:\/\//.test(parsed.connectionString) ||
		typeof parsed.host !== "string" ||
		typeof parsed.port !== "number" ||
		typeof parsed.database !== "string" ||
		typeof parsed.schema !== "string" ||
		typeof parsed.user !== "string"
	) {
		throw new Error("COMPANY_DATA_DIRECT_LOGIN_INVALID_RESPONSE");
	}
	return {
		connectionString: parsed.connectionString,
		host: parsed.host,
		port: parsed.port,
		database: parsed.database,
		schema: parsed.schema,
		user: parsed.user,
	};
}

export async function revokeCompanyDataDirectLogin(options: {
	readonly companyDataUrl: string;
	readonly directLoginToken: string;
	readonly environmentId: string;
	readonly database?: string | null;
	readonly principal?: string;
	readonly generation?: string;
	readonly fetchImpl?: AppHostFetch;
	readonly signal?: AbortSignal;
}): Promise<boolean> {
	if (!isUuid(options.environmentId)) {
		return false;
	}
	const hasDb = options.database !== undefined && options.database !== null;
	if (hasDb) {
		if (
			!LINKED_DATABASE_NAME_PATTERN.test(options.database!) ||
			options.database === "qorpera" ||
			options.database!.startsWith("pg_") ||
			options.database!.startsWith("qorpera_")
		) {
			return false;
		}
	} else if (options.principal === undefined) {
		return false;
	}
	if (options.principal !== undefined && !DIRECT_LOGIN_PRINCIPAL_PATTERN.test(options.principal)) {
		return false;
	}
	if (options.generation !== undefined) {
		if (options.principal === undefined || !DIRECT_LOGIN_PRINCIPAL_PATTERN.test(options.generation)) {
			return false;
		}
	}
	const base = options.companyDataUrl.replace(/\/+$/, "");
	const params = new URLSearchParams();
	if (options.principal !== undefined) params.set("principal", options.principal);
	if (options.generation !== undefined) params.set("generation", options.generation);
	const qs = params.toString();
	const query = qs ? `?${qs}` : "";
	const dbSegment = hasDb ? `/${encodeURIComponent(options.database!)}` : "";
	const fetchImpl = options.fetchImpl ?? defaultAppHostFetch;
	const res = await fetchImpl(
		`${base}/v1/admin/company-data/${encodeURIComponent(options.environmentId)}/direct-login${dbSegment}${query}`,
		{
			method: "DELETE",
			headers: {
				authorization: `Bearer ${options.directLoginToken}`,
			},
			signal: options.signal,
		},
	);
	return res.status === 200;
}

export async function resolveAppRuntimeEnv(options: {
	readonly baseEnvSpec: Readonly<Record<string, string>>;
	readonly siteId: string;
	readonly environmentId: string;
	readonly deploymentId: string;
	readonly directLoginGeneration?: string;
	readonly targetEnv: HostedAppTargetEnv;
	readonly hasRuntimeSecrets: boolean;
	readonly linkedDatabaseName: string | null;
	readonly nativeEdge: NativeEdgeHostingConfig;
	readonly signal?: AbortSignal;
}): Promise<{
	readonly runtimeEnv: Record<string, string>;
	readonly mask: CodingSecretMask;
	readonly secretNames: readonly string[];
}> {
	const runtimeEnv: Record<string, string> = { ...options.baseEnvSpec };
	const sensitive: Record<string, string> = {};
	const signal = options.signal ?? new AbortController().signal;

	if (options.hasRuntimeSecrets) {
		const broker = options.nativeEdge.broker;
		if (!broker) {
			throw new Error("APP_SECRETS_BROKER_UNAVAILABLE");
		}
		const bundle = await fetchHostedAppSecrets({
			brokerOrigin: broker.origin,
			executorToken: broker.executorToken,
			executorOwner: broker.executorOwner,
			machineIdSha256: broker.machineIdSha256,
			siteId: options.siteId,
			scope: "runtime",
			targetEnv: options.targetEnv,
			deploymentId: options.deploymentId,
			...(broker.fetchImpl ? { fetchImpl: broker.fetchImpl } : {}),
			signal,
		});
		for (const [name, value] of Object.entries(bundle.secrets)) {
			if (!appSecretEnvNameAllowed(name) || name === "PORT" || name === "NODE_ENV") {
				continue;
			}
			runtimeEnv[name] = value;
			sensitive[name] = value;
		}
	}

	if (options.linkedDatabaseName) {
		const companyDataUrl = options.nativeEdge.companyDataUrl;
		const directLoginToken = options.nativeEdge.companyDataDirectLoginToken;
		if (!companyDataUrl || !directLoginToken) {
			throw new Error("COMPANY_DATA_DIRECT_LOGIN_UNAVAILABLE");
		}
		const isProd = options.targetEnv === "prod";
		const direct = await provisionCompanyDataDirectLogin({
			companyDataUrl,
			directLoginToken,
			environmentId: options.environmentId,
			database: options.linkedDatabaseName,
			principal: options.deploymentId,
			...(options.directLoginGeneration !== undefined ? { generation: options.directLoginGeneration } : {}),
			access: isProd ? "read-write" : "read-only",
			connectionLimit: isProd ? 4 : 2,
			...(options.nativeEdge.companyDataFetchImpl ? { fetchImpl: options.nativeEdge.companyDataFetchImpl } : {}),
			signal,
		});
		runtimeEnv.DATABASE_URL = direct.connectionString;
		sensitive.DATABASE_URL = direct.connectionString;
	}

	for (const key of [
		"PORT",
		"NODE_ENV",
		"QORPERA_REPOSITORY",
		"QORPERA_COMPANY_DATA_URL",
		"QORPERA_COMPANY_DATA_PUBLIC_URL",
		"QORPERA_OBJECT_STORAGE_URL",
	] as const) {
		if (options.baseEnvSpec[key] !== undefined) {
			runtimeEnv[key] = options.baseEnvSpec[key]!;
		}
	}

	const secretNames = Object.freeze(Object.keys(sensitive).sort());
	const mask = secretNames.length > 0 ? buildAppSecretMask(sensitive) : new CodingSecretMask();
	return { runtimeEnv, mask, secretNames };
}

export async function buildAppImageWithScript(
	scriptPath: string,
	input: BuildAppImageInput,
	signal: AbortSignal,
): Promise<BuildAppImageResult> {
	const started = performance.now();
	const safeRepo = `${input.target.owner}-${input.target.name}`
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	const imageTag = `${input.registryPrefix.replace(/\/+$/, "")}/${safeRepo}:c${input.change}-${input.tree.slice(0, 12)}`;
	const args = [input.sourceDir, imageTag];
	const { stdout } = await withTimeoutScope(signal, 10 * 60_000, (bounded) =>
		execFileAsync(scriptPath, args, {
			signal: bounded,
			maxBuffer: 4 * 1024 * 1024,
			env: {
				PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
				...(input.dockerfile ? { QORPERA_DOCKERFILE: input.dockerfile } : {}),
				QORPERA_APP_PORT: String(input.port),
			},
		}),
	);
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const digestLine = [...lines].reverse().find((line) => OCI_DIGEST_REF_PATTERN.test(line));
	if (!digestLine) throw new Error("APP_IMAGE_DIGEST_MISSING");
	return {
		ociImageRef: digestLine,
		builtMs: Math.round(performance.now() - started),
	};
}

const defaultAppHostFetch: AppHostFetch = async (url, init) =>
	withTimeoutScope(init.signal, 30_000, async (bounded) => {
		const res = await fetch(url, {
			method: init.method,
			headers: init.headers,
			body: init.body,
			signal: bounded,
		});
		return { status: res.status, body: await res.text() };
	});

export async function emitHostedAppUnhealthy(
	control: CodeChangeRecordsOptions["control"],
	event: {
		readonly environmentId: string;
		readonly siteId: string;
		readonly slug: string;
		readonly status: string;
		readonly restartCount?: number;
		readonly error?: string;
	},
	signal: AbortSignal,
): Promise<void> {
	try {
		await control.call(
			"qorpera_emit_app_unhealthy_routine_wakes",
			{
				p_environment_id: event.environmentId,
				p_site_id: event.siteId,
				p_event: {
					status: event.status,
					restartCount: event.restartCount ?? 0,
					...(event.error !== undefined ? { error: event.error } : {}),
				},
			},
			signal,
		);
	} catch {
		// WHY: routine wake emission is best-effort and must not mask deploy failures.
	}
}

export function isDefiniteAppHostDeployRefusal(error: unknown): boolean {
	return error instanceof Error && /^APP_HOST_DEPLOY_FAILED_(?:4\d\d|5(?:0[0-3]|[1-9]\d))$/.test(error.message);
}

export async function triggerBlueGreenAppDeploy(options: {
	readonly appHostInternalUrl: string;
	readonly controlToken: string;
	readonly deploymentId: string;
	readonly siteId: string;
	readonly slug?: string;
	readonly environmentId?: string;
	readonly control?: CodeChangeRecordsOptions["control"];
	readonly ociImageRef: string;
	readonly healthPath: string;
	readonly idleTimeoutSec: number;
	readonly memoryMb: number;
	readonly vcpuLimit: number;
	readonly env: Record<string, string>;
	readonly isPreview?: boolean;
	readonly fetchImpl?: AppHostFetch;
	readonly signal?: AbortSignal;
}): Promise<{ upstreamAddr: string }> {
	const base = options.appHostInternalUrl.replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? defaultAppHostFetch;
	try {
		const res = await fetchImpl(`${base}/_internal/apps/deploy`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${options.controlToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				deployment_id: options.deploymentId,
				site_id: options.siteId,
				oci_image_ref: options.ociImageRef,
				health_path: options.healthPath,
				idle_timeout_sec: options.idleTimeoutSec,
				memory_mb: options.memoryMb,
				vcpu_limit: options.vcpuLimit,
				env: options.env,
				...(options.isPreview ? { is_preview: true } : {}),
			}),
			signal: options.signal,
		});
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`APP_HOST_DEPLOY_FAILED_${res.status}`);
		}
		const parsed = JSON.parse(res.body) as unknown;
		if (!isRecord(parsed) || typeof parsed.upstream_addr !== "string" || !parsed.upstream_addr) {
			throw new Error("APP_HOST_DEPLOY_INVALID_RESPONSE");
		}
		return { upstreamAddr: parsed.upstream_addr };
	} catch (error) {
		if (options.control && options.environmentId && options.slug) {
			const rawError = error instanceof Error ? error.message : "APP_HOST_DEPLOY_FAILED";
			await emitHostedAppUnhealthy(
				options.control,
				{
					environmentId: options.environmentId,
					siteId: options.siteId,
					slug: options.slug,
					status: "deploy_failed",
					error: rawError,
				},
				options.signal ?? AbortSignal.timeout(5000),
			);
		}
		throw error;
	}
}

export async function stopHostedAppDeployment(options: {
	readonly appHostInternalUrl: string;
	readonly controlToken: string;
	readonly deploymentId: string;
	readonly expectedUpstreamAddr?: string | null;
	readonly fetchImpl?: AppHostFetch;
	readonly signal?: AbortSignal;
}): Promise<{ readonly stopped: boolean }> {
	const base = options.appHostInternalUrl.replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? defaultAppHostFetch;
	const expectedUpstream =
		typeof options.expectedUpstreamAddr === "string" && options.expectedUpstreamAddr.trim().length > 0
			? options.expectedUpstreamAddr.trim()
			: null;
	const res = await fetchImpl(`${base}/_internal/apps/${encodeURIComponent(options.deploymentId)}/stop`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${options.controlToken}`,
			...(expectedUpstream ? { "content-type": "application/json" } : {}),
		},
		...(expectedUpstream ? { body: JSON.stringify({ expected_upstream_addr: expectedUpstream }) } : {}),
		signal: options.signal,
	});
	if (res.status === 409) {
		return { stopped: false };
	}
	if (res.status !== 200 && res.status !== 404) {
		throw new Error(`APP_HOST_STOP_FAILED_${res.status}`);
	}
	return { stopped: true };
}

export async function fetchAppLogs(options: {
	readonly appHostInternalUrl: string;
	readonly controlToken: string;
	readonly deploymentId: string;
	readonly tail?: number;
	readonly mask?: CodingSecretMask;
	readonly secretsManager?: CompanyMachineSecretsManager;
	readonly slug?: string;
	readonly fetchImpl?: AppHostFetch;
	readonly signal?: AbortSignal;
}): Promise<AppLogEntry[]> {
	const base = options.appHostInternalUrl.replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? defaultAppHostFetch;
	const tail = Math.max(1, Math.min(2000, options.tail ?? 200));
	const res = await fetchImpl(`${base}/_internal/apps/${encodeURIComponent(options.deploymentId)}/logs?tail=${tail}`, {
		method: "GET",
		headers: { authorization: `Bearer ${options.controlToken}` },
		signal: options.signal,
	});
	if (res.status !== 200) throw new Error(`APP_HOST_LOGS_FAILED_${res.status}`);
	const parsed = JSON.parse(res.body) as unknown;
	if (!isRecord(parsed) || !Array.isArray(parsed.entries)) throw new Error("APP_HOST_LOGS_INVALID");
	const effectiveMask =
		options.mask ?? (options.secretsManager && options.slug ? options.secretsManager.maskFor(options.slug) : null);
	const out: AppLogEntry[] = [];
	for (const entry of parsed.entries) {
		if (
			isRecord(entry) &&
			typeof entry.ts_ms === "number" &&
			typeof entry.stream === "string" &&
			typeof entry.line === "string"
		) {
			const line = effectiveMask ? maskAppLogText(effectiveMask, entry.line) : entry.line;
			out.push({ ts_ms: entry.ts_ms, stream: entry.stream, line });
		}
	}
	return out;
}

export async function deployCodeSiteToNativeEdge(options: {
	readonly control: CodeChangeRecordsOptions["control"];
	readonly owner: string;
	readonly machineIdSha256: string;
	readonly target: CodeSiteTarget;
	readonly change: number;
	readonly spec: NativeCodeSiteSpec;
	readonly files: readonly CodeSiteUploadFile[];
	readonly sourceDir?: string;
	readonly edge: NativeEdgeHostingConfig;
	readonly signal: AbortSignal;
}): Promise<NativeDeploymentRegistered> {
	const { control, owner, machineIdSha256, target, change, spec, files, edge, signal } = options;

	let manifestSha256: string;
	let manifest: SiteManifestPayload;
	let fileCount = 0;
	let totalBytes = 0;
	let uploadedBlobs = 0;
	let deduplicatedBlobs = 0;
	let hasCredentialInputs = false;

	if (spec.kind === "static" || (spec.kind === "hybrid" && files.length > 0)) {
		const uploaded = await uploadSiteBlobsToEdge({
			routerInternalUrl: edge.routerInternalUrl,
			controlToken: edge.controlToken,
			files,
			spaFallback: spec.spaFallback,
			fetchImpl: edge.fetchImpl,
			signal,
		});
		manifestSha256 = uploaded.manifestSha256;
		manifest = uploaded.manifest;
		fileCount = uploaded.fileCount;
		totalBytes = uploaded.totalBytes;
		uploadedBlobs = uploaded.uploadedBlobs;
		deduplicatedBlobs = uploaded.deduplicatedBlobs;
		hasCredentialInputs = uploaded.hasCredentialInputs;
	} else {
		manifestSha256 = createHash("sha256").update(`server:${spec.tree}`, "utf8").digest("hex");
		manifest = {
			files: {},
			redirects: [],
			headers: [],
			spa_fallback: null,
			not_found_page: null,
		};
	}

	let ociImageRef: string | null = null;
	let envSpec: Record<string, string> = {};
	if (spec.kind === "server" || spec.kind === "hybrid") {
		const port = spec.port ?? 3000;
		const builderFn: BuildAppImageFn =
			edge.buildAppImage ??
			((input, buildSignal) =>
				buildAppImageWithScript(
					edge.builderScriptPath ?? "/usr/local/libexec/qorpera-web-hosting/builder-railpack.sh",
					input,
					buildSignal,
				));
		if (!edge.buildAppImage && !options.sourceDir) {
			throw new Error("APP_SOURCE_DIR_REQUIRED");
		}
		const sourceDir = options.sourceDir ?? ".";
		const built = await builderFn(
			{
				target,
				change,
				tree: spec.tree,
				sourceDir,
				dockerfile: spec.dockerfile,
				port,
				registryPrefix: edge.registryPrefix ?? "127.0.0.1:5000/qorpera-apps",
			},
			signal,
		);
		if (!OCI_DIGEST_REF_PATTERN.test(built.ociImageRef)) {
			throw new Error("APP_IMAGE_REF_INVALID");
		}
		ociImageRef = built.ociImageRef;
		envSpec = buildNativeAppEnvSpec({
			port,
			repositoryOwner: target.owner,
			repositoryName: target.name,
			companyDataUrl: edge.companyDataUrl,
			companyDataPublicUrl: edge.companyDataPublicUrl,
			objectStorageUrl: edge.objectStorageUrl,
		});
	}

	const answer = await control.call(
		"qorpera_web_code_deployment_register",
		{
			p_owner: owner,
			p_machine_id_sha256: machineIdSha256,
			p_environment_id: target.environmentId,
			p_repository_owner: target.owner,
			p_name: target.name,
			p_change: change,
			p_kind: spec.kind,
			p_manifest_sha256: manifestSha256,
			p_manifest_json: manifest,
			p_file_count: fileCount,
			p_total_bytes: totalBytes,
			p_oci_image_ref: ociImageRef,
			p_app_port: spec.port,
			p_health_path: spec.healthPath,
			p_idle_timeout_sec: spec.idleTimeoutSec,
			p_memory_mb: spec.memoryMb,
			p_vcpu_limit: spec.vcpuLimit,
			p_has_credential_inputs: hasCredentialInputs,
			p_upstream_addr: null,
			p_env_spec: envSpec,
		},
		signal,
	);

	if (!isRecord(answer) || answer.schema !== "qorpera.web-code-deployment/v1") {
		throw new Error("WEB_DEPLOYMENT_REGISTER_UNCONFIRMED");
	}
	if (answer.state === "lost") {
		throw new Error("CODE_SITE_LOST");
	}
	if (answer.state === "refused") {
		const code = typeof answer.code === "string" ? answer.code : "SITE_UPLOAD_FAILED";
		throw new Error(code);
	}
	if (
		(answer.state !== "ready" && answer.state !== "live" && answer.state !== "kept") ||
		!isUuid(answer.siteId) ||
		typeof answer.slug !== "string" ||
		!isUuid(answer.versionId) ||
		!isUuid(answer.deploymentId) ||
		!isWhole(answer.versionNumber, 1)
	) {
		throw new Error("WEB_DEPLOYMENT_REGISTER_UNCONFIRMED");
	}

	return {
		state: answer.state,
		siteId: answer.siteId,
		slug: answer.slug,
		versionId: answer.versionId,
		deploymentId: answer.deploymentId,
		versionNumber: answer.versionNumber,
		kind: spec.kind,
		uploadedBlobs,
		deduplicatedBlobs,
		ociImageRef,
	};
}
