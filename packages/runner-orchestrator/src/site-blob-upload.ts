import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { withTimeoutScope } from "./abort-scope.ts";
import type { CodeSiteUploadFile } from "./code-site-uploads.ts";

export const NATIVE_SITE_MAX_FILES = 10_000;
export const NATIVE_SITE_MAX_BYTES = 512 * 1024 * 1024;
export const NATIVE_SITE_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_BLOB_UPLOAD_CONCURRENCY = 8;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
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
}

export type BlobUploadFetch = (
	url: string,
	init: {
		method: "HEAD" | "PUT";
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

export function buildCanonicalSiteManifest(
	files: readonly CodeSiteUploadFile[],
	options?: {
		readonly redirects?: readonly SiteRedirectEntry[];
		readonly headers?: readonly SiteHeaderEntry[];
		readonly spaFallback?: string | null;
		readonly notFoundPage?: string | null;
	},
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
		if (file.bytes !== file.content.byteLength || file.bytes > NATIVE_SITE_MAX_FILE_BYTES) {
			throw new Error(`Invalid byte length for ${file.path}`);
		}
		const computed = createHash("sha256").update(file.content).digest("hex");
		if (computed !== file.sha256) {
			throw new Error(`SHA-256 mismatch for ${file.path}`);
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

	const fetchWithRetry = async (
		url: string,
		init: Parameters<BlobUploadFetch>[1],
	): Promise<BlobUploadFetchResponse> => {
		let lastErr: unknown;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			options.signal?.throwIfAborted();
			try {
				const res = await fetchImpl(url, init);
				if (res.status < 500 || attempt === 2) return res;
				lastErr = new Error(`HTTP ${res.status}`);
			} catch (err) {
				if (options.signal?.aborted || attempt === 2) throw err;
				lastErr = err;
			}
			const delayMs = 100 * 2 ** attempt;
			await delay(delayMs, undefined, options.signal ? { signal: options.signal } : undefined);
		}
		throw lastErr instanceof Error ? lastErr : new Error("Blob upload failed");
	};

	const worker = async (): Promise<void> => {
		while (!failed && cursor < queue.length) {
			options.signal?.throwIfAborted();
			const idx = cursor++;
			const [sha256, content] = queue[idx];
			const url = `${base}/_internal/blobs/${sha256}`;
			const authHeader = { authorization: `Bearer ${options.controlToken}` };
			try {
				const headRes = await fetchWithRetry(url, {
					method: "HEAD",
					headers: authHeader,
					signal: options.signal,
				});
				if (headRes.status === 200) {
					deduplicatedBlobs++;
					continue;
				}
				if (headRes.status !== 404) {
					throw new Error(`Blob HEAD failed for ${sha256} with HTTP ${headRes.status}`);
				}
				const putRes = await fetchWithRetry(url, {
					method: "PUT",
					headers: { ...authHeader, "content-type": "application/octet-stream" },
					body: content,
					signal: options.signal,
				});
				if (putRes.status === 201) {
					uploadedBlobs++;
				} else if (putRes.status === 200) {
					deduplicatedBlobs++;
				} else {
					throw new Error(`Blob PUT failed for ${sha256} with HTTP ${putRes.status}`);
				}
			} catch (err) {
				failed = true;
				throw err;
			}
		}
	};

	const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
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
