import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { isUuid } from "@qorpera/contracts";
import type { CodeChangeRecordsOptions } from "./code-change-records.ts";
import { CODE_SITE_MAX_BYTES, CODE_SITE_MAX_FILES } from "./code-site.ts";
import type { CodeSiteTarget, CodeSiteUploadFile } from "./code-site-uploads.ts";
import type { CodingSecretMask } from "./coding-secret-mask.ts";
import {
	type CompanyMachineSecretsManager,
	fetchHostedAppSecrets,
	type HostedAppDeliveredSecrets,
	type HostedAppSecretBundle,
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
	readonly buildEnvPath?: string;
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
		method: "GET" | "POST";
		headers: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<AppHostFetchResponse>;

export interface AppSecretsBrokerConfig {
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
	readonly objectStorageUrl?: string;
	readonly buildAppImage?: BuildAppImageFn;
	readonly fetchImpl?: BlobUploadFetch;
	readonly appHostFetchImpl?: AppHostFetch;
	readonly appSecretsBroker?: AppSecretsBrokerConfig;
	readonly secretsManager?: CompanyMachineSecretsManager;
	readonly appTargetEnv?: HostedAppTargetEnv;
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
	readonly upstreamAddr?: string;
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

export function buildNativeAppEnvSpec(options: {
	readonly port: number;
	readonly repositoryOwner: string;
	readonly repositoryName: string;
	readonly companyDataUrl?: string;
	readonly objectStorageUrl?: string;
}): Record<string, string> {
	return {
		PORT: String(options.port),
		NODE_ENV: "production",
		QORPERA_REPOSITORY: `${options.repositoryOwner}/${options.repositoryName}`,
		...(options.companyDataUrl ? { QORPERA_COMPANY_DATA_URL: options.companyDataUrl } : {}),
		...(options.objectStorageUrl ? { QORPERA_OBJECT_STORAGE_URL: options.objectStorageUrl } : {}),
	};
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
	const { stdout } = await execFileAsync(scriptPath, args, {
		signal,
		maxBuffer: 4 * 1024 * 1024,
		env: {
			PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			...(input.dockerfile ? { QORPERA_DOCKERFILE: input.dockerfile } : {}),
			...(input.buildEnvPath ? { QORPERA_BUILD_SECRETS_FILE: input.buildEnvPath } : {}),
			QORPERA_APP_PORT: String(input.port),
		},
	});
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

const defaultAppHostFetch: AppHostFetch = async (url, init) => {
	const res = await fetch(url, {
		method: init.method,
		headers: init.headers,
		body: init.body,
		signal: init.signal,
	});
	return { status: res.status, body: await res.text() };
};

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

export async function triggerBlueGreenAppDeploy(options: {
	readonly appHostInternalUrl: string;
	readonly controlToken: string;
	readonly deploymentId: string;
	readonly siteId: string;
	readonly slug?: string;
	readonly companyId?: string;
	readonly environmentId?: string;
	readonly control?: CodeChangeRecordsOptions["control"];
	readonly ociImageRef: string;
	readonly healthPath: string;
	readonly idleTimeoutSec: number;
	readonly memoryMb: number;
	readonly vcpuLimit: number;
	readonly env: Record<string, string>;
	readonly envPath?: string;
	readonly secretsManager?: CompanyMachineSecretsManager;
	readonly appSecrets?: HostedAppSecretBundle;
	readonly appSecretsBroker?: AppSecretsBrokerConfig;
	readonly appTargetEnv?: HostedAppTargetEnv;
	readonly fetchImpl?: AppHostFetch;
	readonly signal?: AbortSignal;
}): Promise<{ upstreamAddr: string; envPath?: string }> {
	const base = options.appHostInternalUrl.replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? defaultAppHostFetch;
	let delivered: HostedAppDeliveredSecrets | undefined;
	let previousBytes: Buffer | null = null;
	let deliveredSlug = options.slug;
	if (options.secretsManager && (options.appSecrets || options.appSecretsBroker)) {
		const bundle =
			options.appSecrets ??
			(await fetchHostedAppSecrets({
				brokerOrigin: options.appSecretsBroker!.origin,
				executorToken: options.appSecretsBroker!.executorToken,
				executorOwner: options.appSecretsBroker!.executorOwner,
				machineIdSha256: options.appSecretsBroker!.machineIdSha256,
				deploymentId: options.deploymentId,
				...(options.companyId ? { companyId: options.companyId } : {}),
				siteId: options.siteId,
				scope: "runtime",
				targetEnv: options.appTargetEnv ?? "prod",
				fetchImpl: options.appSecretsBroker!.fetchImpl,
				signal: options.signal ?? AbortSignal.timeout(10_000),
			}));
		deliveredSlug = bundle.slug;
		previousBytes = await options.secretsManager.snapshot(bundle.slug);
		delivered = await options.secretsManager.deliver(bundle);
	}
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
				...(delivered ? { env_path: delivered.envPath } : options.envPath ? { env_path: options.envPath } : {}),
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
		return delivered
			? { upstreamAddr: parsed.upstream_addr, envPath: delivered.envPath }
			: { upstreamAddr: parsed.upstream_addr };
	} catch (error) {
		if (options.secretsManager && delivered) {
			await options.secretsManager.restore(delivered.slug, previousBytes).catch(() => undefined);
		}
		if (options.control && options.environmentId && deliveredSlug) {
			const rawError = error instanceof Error ? error.message : "APP_HOST_DEPLOY_FAILED";
			const maskedError = delivered ? maskAppLogText(delivered.mask, rawError) : rawError;
			await emitHostedAppUnhealthy(
				options.control,
				{
					environmentId: options.environmentId,
					siteId: options.siteId,
					slug: deliveredSlug,
					status: "deploy_failed",
					error: maskedError,
				},
				options.signal ?? AbortSignal.timeout(5000),
			);
		}
		throw error;
	}
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
	readonly siteId?: string;
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
		let buildSecrets: HostedAppDeliveredSecrets | undefined;
		if (options.siteId && edge.appSecretsBroker && edge.secretsManager) {
			const bundle = await fetchHostedAppSecrets({
				brokerOrigin: edge.appSecretsBroker.origin,
				executorToken: edge.appSecretsBroker.executorToken,
				executorOwner: edge.appSecretsBroker.executorOwner,
				machineIdSha256: edge.appSecretsBroker.machineIdSha256,
				companyId: target.companyId,
				siteId: options.siteId,
				scope: "build",
				targetEnv: edge.appTargetEnv ?? "prod",
				fetchImpl: edge.appSecretsBroker.fetchImpl,
				signal,
			});
			buildSecrets = await edge.secretsManager.deliverBuild(bundle);
		}
		let built: BuildAppImageResult;
		try {
			built = await builderFn(
				{
					target,
					change,
					tree: spec.tree,
					sourceDir,
					dockerfile: spec.dockerfile,
					port,
					registryPrefix: edge.registryPrefix ?? "127.0.0.1:5000/qorpera-apps",
					...(buildSecrets ? { buildEnvPath: buildSecrets.envPath } : {}),
				},
				signal,
			);
		} finally {
			if (buildSecrets) {
				await buildSecrets.scrub().catch(() => undefined);
			}
		}
		if (!OCI_DIGEST_REF_PATTERN.test(built.ociImageRef)) {
			throw new Error("APP_IMAGE_REF_INVALID");
		}
		ociImageRef = built.ociImageRef;
		envSpec = buildNativeAppEnvSpec({
			port,
			repositoryOwner: target.owner,
			repositoryName: target.name,
			companyDataUrl: edge.companyDataUrl,
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

	let upstreamAddr: string | undefined;
	if (
		(spec.kind === "server" || spec.kind === "hybrid") &&
		ociImageRef &&
		edge.appHostInternalUrl &&
		edge.appHostControlToken
	) {
		const deployed = await triggerBlueGreenAppDeploy({
			appHostInternalUrl: edge.appHostInternalUrl,
			controlToken: edge.appHostControlToken,
			deploymentId: answer.deploymentId,
			siteId: answer.siteId,
			slug: answer.slug,
			companyId: target.companyId,
			environmentId: target.environmentId,
			control,
			ociImageRef,
			healthPath: spec.healthPath,
			idleTimeoutSec: spec.idleTimeoutSec,
			memoryMb: spec.memoryMb,
			vcpuLimit: spec.vcpuLimit,
			env: envSpec,
			...(edge.secretsManager ? { secretsManager: edge.secretsManager } : {}),
			...(edge.appSecretsBroker ? { appSecretsBroker: edge.appSecretsBroker } : {}),
			...(edge.appTargetEnv ? { appTargetEnv: edge.appTargetEnv } : {}),
			...(edge.appHostFetchImpl ? { fetchImpl: edge.appHostFetchImpl } : {}),
			signal,
		});
		upstreamAddr = deployed.upstreamAddr;
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
		...(upstreamAddr !== undefined ? { upstreamAddr } : {}),
	};
}
