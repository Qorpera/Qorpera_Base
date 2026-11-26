import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { withTimeoutScope } from "./abort-scope.ts";
import type { CodeSiteProblem } from "./code-site.ts";
import type { CodeSiteUploadFile } from "./code-site-uploads.ts";

export const NATIVE_SITE_MAX_FILES = 10_000;
export const NATIVE_SITE_MAX_BYTES = 512 * 1024 * 1024;
export const NATIVE_SITE_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const NATIVE_SITE_MAX_PATH_BYTES = 1024;
export const NATIVE_SITE_MAX_SEGMENTS = 24;
export const NATIVE_SITE_CONTROL_FILE_MAX_BYTES = 256 * 1024;
export const DEFAULT_BLOB_UPLOAD_CONCURRENCY = 16;
export const BLOB_EXISTS_BATCH_SIZE = 512;
export const BLOB_BATCH_CONTENT_TYPE = "application/vnd.qorpera.blob-batch+v1";
export const MAX_BLOB_BATCH_FILES = 1024;
export const MAX_BLOB_BATCH_BYTES = 32 * 1024 * 1024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXTENSION_PATTERN = /\.([A-Za-z0-9]{1,12})$/;
const INPUT_TAG_PATTERN = /<input\b[^>]*>/gi;
const PASSWORD_TYPE_PATTERN = /\btype\s*=\s*(?:"password"|'password'|password(?=\s|>|\/))/i;
const CREDENTIAL_AUTOCOMPLETE_PATTERN = /\bautocomplete\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>/]+))/i;
const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
	"current-password",
	"new-password",
	"cc-number",
	"cc-csc",
	"cc-exp",
	"cc-exp-month",
	"cc-exp-year",
]);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "application/javascript; charset=utf-8",
	mjs: "application/javascript; charset=utf-8",
	cjs: "application/javascript; charset=utf-8",
	json: "application/json; charset=utf-8",
	map: "application/json; charset=utf-8",
	webmanifest: "application/manifest+json; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	vtt: "text/vtt; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	xml: "application/xml; charset=utf-8",
	rss: "application/rss+xml; charset=utf-8",
	atom: "application/atom+xml; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	otf: "font/otf",
	mp4: "video/mp4",
	webm: "video/webm",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	ogg: "audio/ogg",
	wav: "audio/wav",
	pdf: "application/pdf",
	wasm: "application/wasm",
	glb: "model/gltf-binary",
	gltf: "model/gltf+json",
};

export const NATIVE_SITE_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(CONTENT_TYPES));

export function isNativeSitePath(path: string): boolean {
	if (!path || Buffer.byteLength(path, "utf8") > NATIVE_SITE_MAX_PATH_BYTES) return false;
	if (path.startsWith("/") || path.endsWith("/") || path.includes("//")) return false;
	for (const ch of path) {
		const code = ch.codePointAt(0) as number;
		if (
			code < 0x20 ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x2028 ||
			code === 0x2029 ||
			ch === "\\" ||
			ch === "?" ||
			ch === "#" ||
			ch === "%"
		) {
			return false;
		}
	}
	const segments = path.split("/");
	if (segments.length === 0 || segments.length > NATIVE_SITE_MAX_SEGMENTS) return false;
	if ((segments[0] as string).toLowerCase() === "__qorpera") return false;
	return segments.every(
		(segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith("."),
	);
}

export function isNativeServableSitePath(path: string): boolean {
	if (!isNativeSitePath(path)) return false;
	const slash = path.lastIndexOf("/");
	const basename = slash >= 0 ? path.slice(slash + 1) : path;
	const extension = EXTENSION_PATTERN.exec(basename)?.[1]?.toLowerCase();
	return Boolean(extension && NATIVE_SITE_EXTENSIONS.has(extension));
}

export function nativeSiteTreeProblem(
	entries: readonly { readonly path: string; readonly bytes: number }[],
): CodeSiteProblem | null {
	const problem = (code: CodeSiteProblem["code"], path: string | null = null): CodeSiteProblem => ({
		code,
		path,
		variable: null,
	});
	const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	let files = 0;
	let total = 0;
	let hasIndex = false;
	for (const { path, bytes } of sorted) {
		if (path === "_redirects" || path === "_headers") {
			if (bytes > NATIVE_SITE_CONTROL_FILE_MAX_BYTES) return problem("SITE_FILE_TOO_LARGE", path);
			continue;
		}
		if (!isNativeServableSitePath(path)) return problem("SITE_FILE_NAME", path);
		if (bytes > NATIVE_SITE_MAX_FILE_BYTES) return problem("SITE_FILE_TOO_LARGE", path);
		files += 1;
		total += bytes;
		if (files > NATIVE_SITE_MAX_FILES) return problem("SITE_TOO_MANY_FILES");
		if (total > NATIVE_SITE_MAX_BYTES) return problem("SITE_TOO_LARGE");
		if (path === "index.html") hasIndex = true;
	}
	return hasIndex ? null : problem("SITE_NO_INDEX");
}

const HASHED_ASSET_PATTERN = /(?:^|\/)(?:_next\/static|assets)\/|[-.][0-9a-f]{8,}\.[a-z0-9]+$/i;

export interface SiteManifestEntry {
	readonly sha256: string;
	readonly bytes: number;
	readonly content_type: string;
	readonly immutable: boolean;
}

export interface SiteManifestPayload {
	readonly files: Record<string, SiteManifestEntry>;
	readonly redirects: readonly SiteRedirectEntry[];
	readonly headers: readonly SiteHeaderEntry[];
	readonly spa_fallback: string | null;
	readonly not_found_page: string | null;
}

export interface SiteRedirectEntry {
	readonly from: string;
	readonly to: string;
	readonly status: number;
}

export interface SiteHeaderEntry {
	readonly path_prefix: string;
	readonly headers: Record<string, string>;
}

export interface SiteBlobUploadResult {
	readonly manifestSha256: string;
	readonly manifest: SiteManifestPayload;
	readonly fileCount: number;
	readonly totalBytes: number;
	readonly uploadedBlobs: number;
	readonly deduplicatedBlobs: number;
	readonly hasCredentialInputs: boolean;
	readonly credentialInputPaths: readonly string[];
}

export interface BlobUploadFetchResponse {
	readonly status: number;
	json?(): Promise<unknown>;
}

export type BlobUploadFetch = (
	url: string,
	init: {
		method: "HEAD" | "PUT" | "POST";
		headers: Record<string, string>;
		body?: Uint8Array;
		signal?: AbortSignal;
	},
) => Promise<BlobUploadFetchResponse>;

export interface UploadSiteBlobsOptions {
	readonly routerInternalUrl: string;
	readonly controlToken: string;
	readonly files: readonly CodeSiteUploadFile[];
	readonly redirects?: readonly SiteRedirectEntry[];
	readonly headers?: readonly SiteHeaderEntry[];
	readonly spaFallback?: string | null;
	readonly notFoundPage?: string | null;
	readonly concurrency?: number;
	readonly fetchImpl?: BlobUploadFetch;
	readonly signal?: AbortSignal;
}

export function contentTypeForSitePath(path: string): string {
	const dot = path.lastIndexOf(".");
	if (dot < 0 || dot === path.length - 1) return "application/octet-stream";
	const ext = path.slice(dot + 1).toLowerCase();
	return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function htmlContainsCredentialInputs(html: string): boolean {
	INPUT_TAG_PATTERN.lastIndex = 0;
	for (const match of html.matchAll(INPUT_TAG_PATTERN)) {
		const tag = match[0];
		if (PASSWORD_TYPE_PATTERN.test(tag)) return true;
		const ac = CREDENTIAL_AUTOCOMPLETE_PATTERN.exec(tag);
		const rawVal = ac?.[1] ?? ac?.[2] ?? ac?.[3];
		if (rawVal) {
			for (const token of rawVal.toLowerCase().split(/\s+/)) {
				if (SENSITIVE_AUTOCOMPLETE_TOKENS.has(token)) return true;
			}
		}
	}
	return false;
}

export function scanSiteCredentialInputs(files: readonly CodeSiteUploadFile[]): string[] {
	const flagged: string[] = [];
	const decoder = new TextDecoder("utf-8", { fatal: false });
	for (const file of files) {
		const lower = file.path.toLowerCase();
		if (!lower.endsWith(".html") && !lower.endsWith(".htm")) continue;
		const text = decoder.decode(file.content);
		if (htmlContainsCredentialInputs(text)) flagged.push(file.path);
	}
	return flagged.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface CanonicalSiteManifestInput {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}

export interface CanonicalSiteManifestOptions {
	readonly redirects?: readonly SiteRedirectEntry[];
	readonly headers?: readonly SiteHeaderEntry[];
	readonly spaFallback?: string | null;
	readonly notFoundPage?: string | null;
}

export function computeCanonicalSiteManifest(
	files: readonly CanonicalSiteManifestInput[],
	options?: CanonicalSiteManifestOptions,
): { manifestSha256: string; manifest: SiteManifestPayload; totalBytes: number } {
	if (files.length === 0 || files.length > NATIVE_SITE_MAX_FILES) {
		throw new Error(`Site file count must be between 1 and ${NATIVE_SITE_MAX_FILES}`);
	}
	const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const manifestFiles: Record<string, SiteManifestEntry> = {};
	const lines: string[] = [];
	let totalBytes = 0;

	for (const file of sorted) {
		if (!SHA256_PATTERN.test(file.sha256)) {
			throw new Error(`Invalid sha256 for ${file.path}`);
		}
		if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > NATIVE_SITE_MAX_FILE_BYTES) {
			throw new Error(`Invalid byte length for ${file.path}`);
		}
		totalBytes += file.bytes;
		if (totalBytes > NATIVE_SITE_MAX_BYTES) {
			throw new Error(`Site exceeds maximum total size of ${NATIVE_SITE_MAX_BYTES} bytes`);
		}
		if (Object.hasOwn(manifestFiles, file.path)) {
			throw new Error(`Duplicate site path: ${file.path}`);
		}
		manifestFiles[file.path] = {
			sha256: file.sha256,
			bytes: file.bytes,
			content_type: contentTypeForSitePath(file.path),
			immutable: HASHED_ASSET_PATTERN.test(file.path),
		};
		lines.push(`${file.path}\t${file.sha256}\t${file.bytes}`);
	}

	const manifestSha256 = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
	const inferredNotFound =
		options?.notFoundPage !== undefined
			? options.notFoundPage
			: Object.hasOwn(manifestFiles, "404.html")
				? "404.html"
				: null;

	return {
		manifestSha256,
		totalBytes,
		manifest: {
			files: manifestFiles,
			redirects: options?.redirects ?? [],
			headers: options?.headers ?? [],
			spa_fallback: options?.spaFallback ?? null,
			not_found_page: inferredNotFound,
		},
	};
}

export function buildCanonicalSiteManifest(
	files: readonly CodeSiteUploadFile[],
	options?: CanonicalSiteManifestOptions,
): { manifestSha256: string; manifest: SiteManifestPayload; totalBytes: number } {
	for (const file of files) {
		if (file.bytes !== file.content.byteLength || file.bytes > NATIVE_SITE_MAX_FILE_BYTES) {
			throw new Error(`Invalid byte length for ${file.path}`);
		}
		const computed = createHash("sha256").update(file.content).digest("hex");
		if (computed !== file.sha256) {
			throw new Error(`SHA-256 mismatch for ${file.path}`);
		}
	}
	return computeCanonicalSiteManifest(files, options);
}

const defaultFetch: BlobUploadFetch = async (url, init) =>
	withTimeoutScope(init.signal, 30_000, async (bounded) => {
		const res = await fetch(url, {
			method: init.method,
			headers: init.headers,
			body:
				init.body === undefined
					? undefined
					: Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength),
			signal: bounded,
		});
		if (init.method === "POST" && res.status === 200) {
			const data: unknown = await res.json();
			return { status: res.status, json: async () => data };
		}
		await res.body?.cancel().catch(() => undefined);
		return { status: res.status };
	});

export function parseRedirectsFile(text: string): SiteRedirectEntry[] {
	const rules: SiteRedirectEntry[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const parts = line.split(/\s+/);
		if (parts.length < 2) continue;
		const from = parts[0] as string;
		const to = parts[1] as string;
		if (!from.startsWith("/") || to.startsWith("//") || (!to.startsWith("/") && !to.startsWith("https://"))) continue;
		const parsedStatus = parts[2] ? Number.parseInt(parts[2].replace(/!$/, ""), 10) : 301;
		const status = [200, 301, 302, 303, 307, 308].includes(parsedStatus) ? parsedStatus : 301;
		rules.push({ from, to, status });
		if (rules.length >= 200) break;
	}
	return rules;
}

export function parseHeadersFile(text: string): SiteHeaderEntry[] {
	const entries: SiteHeaderEntry[] = [];
	let currentPrefix: string | null = null;
	let currentHeaders: Record<string, string> = {};
	const flush = () => {
		if (currentPrefix !== null && Object.keys(currentHeaders).length > 0) {
			entries.push({ path_prefix: currentPrefix, headers: currentHeaders });
		}
		currentPrefix = null;
		currentHeaders = {};
	};
	for (const rawLine of text.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (!rawLine.startsWith(" ") && !rawLine.startsWith("\t") && (trimmed.startsWith("/") || trimmed === "*")) {
			flush();
			currentPrefix = trimmed.endsWith("/*") ? trimmed.slice(0, -1) : trimmed;
			continue;
		}
		if (currentPrefix !== null) {
			const colon = trimmed.indexOf(":");
			if (colon > 0) {
				const name = trimmed.slice(0, colon).trim().toLowerCase();
				const value = trimmed.slice(colon + 1).trim();
				if (name && value && /^[a-z0-9-]+$/.test(name)) {
					currentHeaders[name] = value;
				}
			}
		}
	}
	flush();
	return entries.slice(0, 100);
}

async function fetchWithRetry(
	fetchImpl: BlobUploadFetch,
	url: string,
	init: Parameters<BlobUploadFetch>[1],
	signal?: AbortSignal,
): Promise<BlobUploadFetchResponse> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		signal?.throwIfAborted();
		try {
			const res = await fetchImpl(url, init);
			if (res.status < 500 || attempt === 2) return res;
			lastErr = new Error(`HTTP ${res.status}`);
		} catch (err) {
			if (signal?.aborted || attempt === 2) throw err;
			lastErr = err;
		}
		const delayMs = 100 * 2 ** attempt;
		await delay(delayMs, undefined, signal ? { signal } : undefined);
	}
	throw lastErr instanceof Error ? lastErr : new Error("Blob upload failed");
}

export async function checkMissingBlobsOnEdge(options: {
	readonly routerInternalUrl: string;
	readonly controlToken: string;
	readonly hashes: readonly string[];
	readonly concurrency?: number;
	readonly fetchImpl?: BlobUploadFetch;
	readonly signal?: AbortSignal;
}): Promise<Set<string>> {
	const unique = [...new Set(options.hashes)];
	if (unique.length === 0) return new Set();
	const base = options.routerInternalUrl.replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const authHeader = { authorization: `Bearer ${options.controlToken}` };
	const uniqueSet = new Set(unique);
	const missing = new Set<string>();
	let fallbackFromIndex: number | null = null;

	const queryExistsChunk = async (chunk: readonly string[]): Promise<Set<string> | null> => {
		const existsRes = await fetchWithRetry(
			fetchImpl,
			`${base}/_internal/blobs/exists`,
			{
				method: "POST",
				headers: { ...authHeader, "content-type": "application/json" },
				body: Buffer.from(JSON.stringify({ hashes: chunk }), "utf8"),
				signal: options.signal,
			},
			options.signal,
		);
		if (existsRes.status === 404 || existsRes.status === 405 || !existsRes.json) {
			return null;
		}
		if (existsRes.status !== 200) {
			throw new Error(`Blob exists batch check failed with HTTP ${existsRes.status}`);
		}
		const parsed = await existsRes.json();
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!("existing" in parsed) ||
			!Array.isArray((parsed as { existing: unknown }).existing)
		) {
			throw new Error("Blob exists batch check returned invalid JSON");
		}
		const existingSet = new Set<string>();
		for (const entry of (parsed as { existing: unknown[] }).existing) {
			if (typeof entry === "string" && uniqueSet.has(entry)) existingSet.add(entry);
		}
		return existingSet;
	};

	// WHY: Batch existence checks via POST /_internal/blobs/exists to collapse N HEADs into parallel batch calls, falling back to HEAD on 404/405 for rolling deploys.
	const chunks: string[][] = [];
	for (let offset = 0; offset < unique.length; offset += BLOB_EXISTS_BATCH_SIZE) {
		chunks.push(unique.slice(offset, offset + BLOB_EXISTS_BATCH_SIZE));
	}
	const firstChunk = chunks[0]!;
	const firstExisting = await queryExistsChunk(firstChunk);
	if (firstExisting === null) {
		fallbackFromIndex = 0;
	} else {
		for (const sha of firstChunk) {
			if (!firstExisting.has(sha)) missing.add(sha);
		}
		if (chunks.length > 1) {
			const restResults = await Promise.all(chunks.slice(1).map((chunk) => queryExistsChunk(chunk)));
			for (let i = 0; i < restResults.length; i += 1) {
				const existingSet = restResults[i]!;
				const chunk = chunks[i + 1]!;
				if (existingSet === null) {
					fallbackFromIndex = (i + 1) * BLOB_EXISTS_BATCH_SIZE;
					break;
				}
				for (const sha of chunk) {
					if (!existingSet.has(sha)) missing.add(sha);
				}
			}
		}
	}

	if (fallbackFromIndex !== null) {
		const remaining = unique.slice(fallbackFromIndex);
		const concurrency = Math.max(1, Math.min(16, options.concurrency ?? DEFAULT_BLOB_UPLOAD_CONCURRENCY));
		let cursor = 0;
		let failed = false;
		const headWorker = async (): Promise<void> => {
			while (!failed && cursor < remaining.length) {
				options.signal?.throwIfAborted();
				const sha256 = remaining[cursor++]!;
				try {
					const headRes = await fetchWithRetry(
						fetchImpl,
						`${base}/_internal/blobs/${sha256}`,
						{ method: "HEAD", headers: authHeader, signal: options.signal },
						options.signal,
					);
					if (headRes.status === 404) {
						missing.add(sha256);
					} else if (headRes.status !== 200) {
						throw new Error(`Blob HEAD failed for ${sha256} with HTTP ${headRes.status}`);
					}
				} catch (err) {
					failed = true;
					throw err;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, remaining.length) }, () => headWorker()));
	}

	return missing;
}

export function encodeBlobBatchFrames(
	items: readonly { readonly sha256: string; readonly content: Uint8Array }[],
): Uint8Array {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (const item of items) {
		const header = Buffer.from(`${item.sha256} ${item.content.byteLength}\n`, "ascii");
		chunks.push(header, item.content);
		total += header.byteLength + item.content.byteLength;
	}
	const out = Buffer.allocUnsafe(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export async function putBlobBatchToEdge(options: {
	readonly routerInternalUrl: string;
	readonly controlToken: string;
	readonly body: Uint8Array;
	readonly fetchImpl?: BlobUploadFetch;
	readonly signal?: AbortSignal;
}): Promise<
	{ readonly supported: true; readonly stored: number; readonly exists: number } | { readonly supported: false }
> {
	const base = options.routerInternalUrl.replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const res = await fetchWithRetry(
		fetchImpl,
		`${base}/_internal/blobs/batch`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${options.controlToken}`,
				"content-type": BLOB_BATCH_CONTENT_TYPE,
			},
			body: options.body,
			signal: options.signal,
		},
		options.signal,
	);
	if (res.status === 404 || res.status === 405 || res.status === 415) {
		return { supported: false };
	}
	if (res.status !== 200 && res.status !== 201) {
		throw new Error(`Blob batch POST failed with HTTP ${res.status}`);
	}
	if (!res.json) {
		return { supported: true, stored: 0, exists: 0 };
	}
	const parsed = await res.json();
	if (
		parsed &&
		typeof parsed === "object" &&
		typeof (parsed as { stored?: unknown }).stored === "number" &&
		typeof (parsed as { exists?: unknown }).exists === "number"
	) {
		return {
			supported: true,
			stored: (parsed as { stored: number }).stored,
			exists: (parsed as { exists: number }).exists,
		};
	}
	return { supported: true, stored: 0, exists: 0 };
}

export async function putBlobToEdge(options: {
	readonly routerInternalUrl: string;
	readonly controlToken: string;
	readonly sha256: string;
	readonly content: Uint8Array;
	readonly fetchImpl?: BlobUploadFetch;
	readonly signal?: AbortSignal;
}): Promise<"stored" | "exists"> {
	const base = options.routerInternalUrl.replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const putRes = await fetchWithRetry(
		fetchImpl,
		`${base}/_internal/blobs/${options.sha256}`,
		{
			method: "PUT",
			headers: {
				authorization: `Bearer ${options.controlToken}`,
				"content-type": "application/octet-stream",
			},
			body: options.content,
			signal: options.signal,
		},
		options.signal,
	);
	if (putRes.status === 201) return "stored";
	if (putRes.status === 200) return "exists";
	throw new Error(`Blob PUT failed for ${options.sha256} with HTTP ${putRes.status}`);
}

export async function uploadSiteBlobsToEdge(options: UploadSiteBlobsOptions): Promise<SiteBlobUploadResult> {
	const base = options.routerInternalUrl.replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const concurrency = Math.max(1, Math.min(16, options.concurrency ?? DEFAULT_BLOB_UPLOAD_CONCURRENCY));
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let inferredRedirects: readonly SiteRedirectEntry[] | undefined = options.redirects;
	let inferredHeaders: readonly SiteHeaderEntry[] | undefined = options.headers;
	const servableFiles: CodeSiteUploadFile[] = [];
	for (const file of options.files) {
		if (file.path === "_redirects") {
			if (inferredRedirects === undefined) inferredRedirects = parseRedirectsFile(decoder.decode(file.content));
			continue;
		}
		if (file.path === "_headers") {
			if (inferredHeaders === undefined) inferredHeaders = parseHeadersFile(decoder.decode(file.content));
			continue;
		}
		servableFiles.push(file);
	}
	const { manifestSha256, manifest, totalBytes } = buildCanonicalSiteManifest(servableFiles, {
		redirects: inferredRedirects,
		headers: inferredHeaders,
		spaFallback: options.spaFallback,
		notFoundPage: options.notFoundPage,
	});
	const credentialInputPaths = scanSiteCredentialInputs(servableFiles);

	const uniqueBlobs = new Map<string, Uint8Array>();
	for (const file of servableFiles) {
		if (!uniqueBlobs.has(file.sha256)) uniqueBlobs.set(file.sha256, file.content);
	}
	const queue = [...uniqueBlobs.entries()];
	let cursor = 0;
	let uploadedBlobs = 0;
	let deduplicatedBlobs = 0;
	let failed = false;

	const authHeader = { authorization: `Bearer ${options.controlToken}` };
	const knownMissing = new Set<string>();
	let uploadQueue: [string, Uint8Array][] = queue;
	let usedExistsFallback = false;

	// WHY: Batch existence checks via POST /_internal/blobs/exists to collapse N HEADs into 1 call, falling back to HEAD on 404/405 for rolling deploys.
	if (queue.length > 1) {
		const nextQueue: [string, Uint8Array][] = [];
		let fallbackFromIndex: number | null = null;
		for (let offset = 0; offset < queue.length; offset += BLOB_EXISTS_BATCH_SIZE) {
			options.signal?.throwIfAborted();
			const chunk = queue.slice(offset, offset + BLOB_EXISTS_BATCH_SIZE);
			const chunkHashes = chunk.map(([sha]) => sha);
			const existsRes = await fetchWithRetry(
				fetchImpl,
				`${base}/_internal/blobs/exists`,
				{
					method: "POST",
					headers: { ...authHeader, "content-type": "application/json" },
					body: Buffer.from(JSON.stringify({ hashes: chunkHashes }), "utf8"),
					signal: options.signal,
				},
				options.signal,
			);
			if (existsRes.status === 404 || existsRes.status === 405) {
				fallbackFromIndex = offset;
				break;
			}
			if (existsRes.status !== 200) {
				throw new Error(`Blob exists batch check failed with HTTP ${existsRes.status}`);
			}
			if (!existsRes.json) {
				fallbackFromIndex = offset;
				break;
			}
			const parsed = await existsRes.json();
			if (
				!parsed ||
				typeof parsed !== "object" ||
				!("existing" in parsed) ||
				!Array.isArray((parsed as { existing: unknown }).existing)
			) {
				throw new Error("Blob exists batch check returned invalid JSON");
			}
			const existingSet = new Set<string>();
			for (const entry of (parsed as { existing: unknown[] }).existing) {
				if (typeof entry === "string" && uniqueBlobs.has(entry)) existingSet.add(entry);
			}
			for (const item of chunk) {
				if (existingSet.has(item[0])) {
					deduplicatedBlobs++;
				} else {
					knownMissing.add(item[0]);
					nextQueue.push(item);
				}
			}
		}
		if (fallbackFromIndex !== null) {
			usedExistsFallback = true;
			for (let i = fallbackFromIndex; i < queue.length; i += 1) {
				nextQueue.push(queue[i]!);
			}
		}
		uploadQueue = nextQueue;
	}

	if (!usedExistsFallback && uploadQueue.length > 1) {
		let idx = 0;
		const remaining: [string, Uint8Array][] = [];
		while (idx < uploadQueue.length) {
			options.signal?.throwIfAborted();
			const batchItems: { sha256: string; content: Uint8Array }[] = [];
			let batchBytes = 0;
			const startIdx = idx;
			while (idx < uploadQueue.length) {
				const [sha, content] = uploadQueue[idx]!;
				if (
					batchItems.length > 0 &&
					(batchItems.length >= MAX_BLOB_BATCH_FILES || batchBytes + content.byteLength > MAX_BLOB_BATCH_BYTES)
				) {
					break;
				}
				batchItems.push({ sha256: sha, content });
				batchBytes += content.byteLength;
				idx += 1;
			}
			if (batchItems.length === 1 && batchItems[0]!.content.byteLength > MAX_BLOB_BATCH_BYTES) {
				remaining.push(uploadQueue[startIdx]!);
				continue;
			}
			const result = await putBlobBatchToEdge({
				routerInternalUrl: base,
				controlToken: options.controlToken,
				body: encodeBlobBatchFrames(batchItems),
				fetchImpl,
				signal: options.signal,
			});
			if (!result.supported) {
				for (let j = startIdx; j < uploadQueue.length; j += 1) remaining.push(uploadQueue[j]!);
				break;
			}
			uploadedBlobs += result.stored;
			deduplicatedBlobs += result.exists;
		}
		uploadQueue = remaining;
	}

	const worker = async (): Promise<void> => {
		while (!failed && cursor < uploadQueue.length) {
			options.signal?.throwIfAborted();
			const idx = cursor++;
			const [sha256, content] = uploadQueue[idx]!;
			const url = `${base}/_internal/blobs/${sha256}`;
			try {
				if (!knownMissing.has(sha256)) {
					const headRes = await fetchWithRetry(
						fetchImpl,
						url,
						{
							method: "HEAD",
							headers: authHeader,
							signal: options.signal,
						},
						options.signal,
					);
					if (headRes.status === 200) {
						deduplicatedBlobs++;
						continue;
					}
					if (headRes.status !== 404) {
						throw new Error(`Blob HEAD failed for ${sha256} with HTTP ${headRes.status}`);
					}
				}
				const result = await putBlobToEdge({
					routerInternalUrl: base,
					controlToken: options.controlToken,
					sha256,
					content,
					fetchImpl,
					signal: options.signal,
				});
				if (result === "stored") {
					uploadedBlobs++;
				} else {
					deduplicatedBlobs++;
				}
			} catch (err) {
				failed = true;
				throw err;
			}
		}
	};

	const workers = Array.from({ length: Math.min(concurrency, uploadQueue.length) }, () => worker());
	await Promise.all(workers);

	return {
		manifestSha256,
		manifest,
		fileCount: servableFiles.length,
		totalBytes,
		uploadedBlobs,
		deduplicatedBlobs,
		hasCredentialInputs: credentialInputPaths.length > 0,
		credentialInputPaths,
	};
}
