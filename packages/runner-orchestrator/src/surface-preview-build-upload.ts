import { createHash } from "node:crypto";
import {
	compileIdentityTokensCss,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	PRODUCT_CATALOG_PATH,
	PRODUCT_SPECS_PATH,
	SURFACE_IDENTITY_CSS_MOUNT_PATH,
	SURFACE_SHARED_DIR,
	sharedProductAssetCandidates,
} from "@qorpera/contracts";
import type { CodeSiteProblem } from "./code-site.ts";
import type { LxdExecPipeRequest, LxdExecPipeResult } from "./lxd-client.ts";
import {
	type BlobUploadFetch,
	checkMissingBlobsOnEdge,
	computeCanonicalSiteManifest,
	DEFAULT_BLOB_UPLOAD_CONCURRENCY,
	isNativeServableSitePath,
	NATIVE_SITE_CONTROL_FILE_MAX_BYTES,
	NATIVE_SITE_EXTENSIONS,
	NATIVE_SITE_MAX_BYTES,
	NATIVE_SITE_MAX_FILE_BYTES,
	NATIVE_SITE_MAX_FILES,
	NATIVE_SITE_MAX_PATH_BYTES,
	NATIVE_SITE_MAX_SEGMENTS,
	nativeSiteTreeProblem,
	parseHeadersFile,
	parseRedirectsFile,
	putBlobToEdge,
} from "./site-blob-upload.ts";
import {
	PREVIEW_BUILD_FAILED,
	previewBuildDetail,
	previewSiteProblemDetail,
	type SurfacePreviewBuildOutcome,
} from "./surface-preview-runner.ts";

const MAX_SHARED_ASSET_READ_BYTES = 32 * 1024;
const MAX_SCAN_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_BATCH_FILES = 256;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface CollectAndUploadPreviewBuildOptions {
	readonly execPipe: (request: LxdExecPipeRequest, signal: AbortSignal) => Promise<LxdExecPipeResult>;
	readonly uid: number;
	readonly gid: number;
	readonly outputDir: string;
	readonly recipeFolder: string;
	readonly companyMountDir: string;
	readonly productFolderRoots?: readonly string[];
	readonly secretValues?: readonly string[];
	readonly routerInternalUrl: string;
	readonly controlToken: string;
	readonly fetchImpl?: BlobUploadFetch;
	readonly concurrency?: number;
	readonly signal: AbortSignal;
}

const NATIVE_PREVIEW_SCAN_PY = String.raw`import hashlib,json,os,re,stat,sys
cfg=json.loads(sys.stdin.read())
uid=int(cfg["uid"])
gid=int(cfg["gid"])
if os.geteuid()==0:
	if uid<=0 or gid<=0:
		sys.exit(2)
	os.setgroups([])
	os.setgid(gid)
	os.setuid(uid)
top=os.fsencode(cfg["outputDir"])
try:
	if not stat.S_ISDIR(os.lstat(top).st_mode):
		print(json.dumps({"problem":{"code":"SITE_FOLDER_MISSING","path":None}}))
		sys.exit(0)
except OSError:
	print(json.dumps({"problem":{"code":"SITE_FOLDER_MISSING","path":None}}))
	sys.exit(0)
SECRETS=[s.encode("utf-8") for s in cfg.get("secretValues",[]) if isinstance(s,str) and len(s.encode("utf-8"))>=8]
MAX_SECRET=max((len(s) for s in SECRETS),default=0)
SERVED=set(cfg["extensions"])
MAX_FILES=int(cfg["maxFiles"])
MAX_FILE_BYTES=int(cfg["maxFileBytes"])
MAX_TOTAL_BYTES=int(cfg["maxTotalBytes"])
MAX_PATH_BYTES=int(cfg["maxPathBytes"])
MAX_SEGMENTS=int(cfg["maxSegments"])
MAX_CTRL_BYTES=int(cfg["maxControlBytes"])
MAX_SHARED_BYTES=int(cfg["maxSharedBytes"])
EXT_RE=re.compile(r"\.([A-Za-z0-9]{1,12})\Z")
INPUT_RE=re.compile(r"<input\b[^>]*>",re.I)
PASS_RE=re.compile(r'\btype\s*=\s*(?:"password"|\'password\'|password(?=\s|>|/))',re.I)
AC_RE=re.compile(r'\bautocomplete\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>/]+))',re.I)
SENSITIVE_AC={"current-password","new-password","cc-number","cc-csc","cc-exp","cc-exp-month","cc-exp-year"}
def valid_path(p):
	b=p.encode("utf-8")
	if not p or len(b)>MAX_PATH_BYTES or p.startswith("/") or p.endswith("/") or "//" in p:
		return False
	for ch in p:
		c=ord(ch)
		if c<0x20 or (0x7f<=c<=0x9f) or c in (0x2028,0x2029) or ch in "\\?#%":
			return False
	segs=p.split("/")
	if not segs or len(segs)>MAX_SEGMENTS or segs[0].lower()=="__qorpera":
		return False
	return all(seg not in ("",".","..") and not seg.startswith(".") for seg in segs)
def safe_path(p):
	pb=p.encode("utf-8","replace")
	for s in SECRETS:
		if s in pb:
			return None
	return p if len(pb)<=512 else None
def has_creds(text):
	for m in INPUT_RE.finditer(text):
		tag=m.group(0)
		if PASS_RE.search(tag):
			return True
		ac=AC_RE.search(tag)
		if ac:
			val=ac.group(1) or ac.group(2) or ac.group(3) or ""
			for tok in val.lower().split():
				if tok in SENSITIVE_AC:
					return True
	return False
def read_small(base,rel,limit):
	if not base or not rel:
		return None
	cur=os.fsencode(base)
	parts=[p for p in rel.split("/") if p]
	if any(p in (".","..") for p in parts):
		return None
	for seg in parts[:-1]:
		cur=os.path.join(cur,os.fsencode(seg))
		try:
			if not stat.S_ISDIR(os.lstat(cur).st_mode):
				return None
		except OSError:
			return None
	target=os.path.join(cur,os.fsencode(parts[-1]))
	try:
		fd=os.open(target,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
	except OSError:
		return None
	try:
		with os.fdopen(fd,"rb") as f:
			if not stat.S_ISREG(os.fstat(fd).st_mode):
				return None
			data=f.read(limit+1)
			if not data or len(data)>limit:
				return None
			return data.decode("utf-8","replace")
	except OSError:
		return None
redirects=None
headers=None
paths=[]
todo=[""]
while todo:
	at=todo.pop()
	cur_dir=os.path.join(top,os.fsencode(at)) if at else top
	with os.scandir(cur_dir) as it:
		for entry in it:
			try:
				name=os.fsdecode(entry.name)
			except UnicodeDecodeError:
				continue
			if name.startswith("."):
				continue
			rel=f"{at}/{name}" if at else name
			if entry.is_dir(follow_symlinks=False):
				todo.append(rel)
			elif entry.is_file(follow_symlinks=False):
				if not at and name in ("_redirects","_headers"):
					fd=os.open(os.path.join(top,entry.name),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
					with os.fdopen(fd,"rb") as f:
						if not stat.S_ISREG(os.fstat(fd).st_mode):
							continue
						raw=f.read(MAX_CTRL_BYTES+1)
					if len(raw)>MAX_CTRL_BYTES:
						print(json.dumps({"problem":{"code":"SITE_FILE_TOO_LARGE","path":name}}))
						sys.exit(0)
					if SECRETS:
						for s in SECRETS:
							if s in raw:
								print(json.dumps({"problem":{"code":"SITE_HOLDS_SECRET","path":None}}))
								sys.exit(0)
					text=raw.decode("utf-8","replace")
					if name=="_redirects":
						redirects=text
					else:
						headers=text
					continue
				m=EXT_RE.search(name)
				if m and m.group(1).lower() in SERVED:
					paths.append(rel)
paths.sort()
files=[]
total=0
has_index=False
has_cred=False
for rel in paths:
	if not valid_path(rel):
		print(json.dumps({"problem":{"code":"SITE_FILE_NAME","path":safe_path(rel)}}))
		sys.exit(0)
	rel_bytes=rel.encode("utf-8")
	for s in SECRETS:
		if s in rel_bytes:
			print(json.dumps({"problem":{"code":"SITE_HOLDS_SECRET","path":None}}))
			sys.exit(0)
	full=os.path.join(top,os.fsencode(rel))
	fd=os.open(full,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
	h=hashlib.sha256()
	size=0
	tail=b""
	is_html=rel.lower().endswith((".html",".htm"))
	html_buf=[]
	with os.fdopen(fd,"rb") as f:
		if not stat.S_ISREG(os.fstat(fd).st_mode):
			sys.exit(4)
		while True:
			chunk=f.read(262144)
			if not chunk:
				break
			size+=len(chunk)
			if size>MAX_FILE_BYTES:
				print(json.dumps({"problem":{"code":"SITE_FILE_TOO_LARGE","path":safe_path(rel)}}))
				sys.exit(0)
			h.update(chunk)
			if SECRETS:
				window=tail+chunk
				for s in SECRETS:
					if s in window:
						print(json.dumps({"problem":{"code":"SITE_HOLDS_SECRET","path":None}}))
						sys.exit(0)
				tail=window[-(MAX_SECRET-1):] if MAX_SECRET>1 else b""
			if is_html and not has_cred and size<=16*1024*1024:
				html_buf.append(chunk)
	total+=size
	if len(files)+1>MAX_FILES:
		print(json.dumps({"problem":{"code":"SITE_TOO_MANY_FILES","path":None}}))
		sys.exit(0)
	if total>MAX_TOTAL_BYTES:
		print(json.dumps({"problem":{"code":"SITE_TOO_LARGE","path":None}}))
		sys.exit(0)
	if is_html and not has_cred and html_buf:
		if has_creds(b"".join(html_buf).decode("utf-8","replace")):
			has_cred=True
	if rel=="index.html":
		has_index=True
	files.append({"path":rel,"bytes":size,"sha256":h.hexdigest()})
if not has_index:
	print(json.dumps({"problem":{"code":"SITE_NO_INDEX","path":None}}))
	sys.exit(0)
mount=cfg.get("companyMountDir") or ""
shared={}
css_text=read_small(mount,cfg.get("identityCssPath"),MAX_SHARED_BYTES)
if css_text:
	shared["css"]=css_text
else:
	json_text=read_small(mount,cfg.get("identityJsonPath"),MAX_SHARED_BYTES)
	if json_text:
		shared["json"]=json_text
specs_text=read_small(mount,cfg.get("productSpecsPath"),MAX_SHARED_BYTES)
if specs_text:
	shared["specs"]=specs_text
catalog_text=read_small(mount,cfg.get("productCatalogPath"),MAX_SHARED_BYTES)
if catalog_text:
	shared["catalog"]=catalog_text
print(json.dumps({"files":files,"redirects":redirects,"headers":headers,"hasCredentialInputs":has_cred,"shared":shared}))`;

const NATIVE_PREVIEW_STREAM_PY = String.raw`import hashlib,json,os,stat,sys
cfg=json.loads(sys.stdin.read())
uid=int(cfg["uid"])
gid=int(cfg["gid"])
if os.geteuid()==0:
	if uid<=0 or gid<=0:
		sys.exit(2)
	os.setgroups([])
	os.setgid(gid)
	os.setuid(uid)
top=os.fsencode(cfg["outputDir"])
out=sys.stdout.buffer
for item in cfg["files"]:
	rel=item["path"]
	expected=item["sha256"]
	parts=rel.split("/")
	if not parts or any(p in ("",".","..") or p.startswith(".") for p in parts):
		sys.exit(4)
	cur=top
	for seg in parts[:-1]:
		cur=os.path.join(cur,os.fsencode(seg))
		if not stat.S_ISDIR(os.lstat(cur).st_mode):
			sys.exit(4)
	full=os.path.join(cur,os.fsencode(parts[-1]))
	fd=os.open(full,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
	with os.fdopen(fd,"rb") as f:
		if not stat.S_ISREG(os.fstat(fd).st_mode):
			sys.exit(4)
		data=f.read()
	if hashlib.sha256(data).hexdigest()!=expected:
		sys.exit(4)
	out.write(f"{expected} {len(data)}\n".encode("ascii"))
	out.write(data)
out.flush()`;

interface ScannedFile {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}

interface ScanOutput {
	readonly problem?: { readonly code: CodeSiteProblem["code"]; readonly path: string | null };
	readonly files?: readonly ScannedFile[];
	readonly redirects?: string | null;
	readonly headers?: string | null;
	readonly hasCredentialInputs?: boolean;
	readonly shared?: {
		readonly css?: string;
		readonly json?: string;
		readonly specs?: string;
		readonly catalog?: string;
	};
}

function buildSharedAssetBlobs(
	shared: ScanOutput["shared"],
): Map<string, { path: string; bytes: number; sha256: string; content: Uint8Array }> {
	const mounted: Record<string, string> = {};
	if (shared?.css) {
		mounted[`${SURFACE_SHARED_DIR}/${IDENTITY_TOKENS_CSS_PATH}`] = shared.css;
		mounted[SURFACE_IDENTITY_CSS_MOUNT_PATH] = shared.css;
	} else if (shared?.json) {
		const compiled = compileIdentityTokensCss(shared.json);
		mounted[`${SURFACE_SHARED_DIR}/${IDENTITY_TOKENS_JSON_PATH}`] = shared.json;
		mounted[`${SURFACE_SHARED_DIR}/${IDENTITY_TOKENS_CSS_PATH}`] = compiled;
		mounted[SURFACE_IDENTITY_CSS_MOUNT_PATH] = compiled;
	}
	if (shared?.specs) {
		mounted[`${SURFACE_SHARED_DIR}/${PRODUCT_SPECS_PATH}`] = shared.specs;
	}
	if (shared?.catalog) {
		mounted[`${SURFACE_SHARED_DIR}/${PRODUCT_CATALOG_PATH}`] = shared.catalog;
	}
	const out = new Map<string, { path: string; bytes: number; sha256: string; content: Uint8Array }>();
	for (const [rawPath, text] of Object.entries(mounted)) {
		const cleanPath = rawPath.replace(/^\/+/, "");
		if (!isNativeServableSitePath(cleanPath)) continue;
		const content = new TextEncoder().encode(text);
		const sha256 = createHash("sha256").update(content).digest("hex");
		out.set(cleanPath, { path: cleanPath, bytes: content.byteLength, sha256, content });
	}
	return out;
}

function parseStreamedBlobs(
	raw: Buffer,
	expected: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[],
): Map<string, Uint8Array> {
	const blobs = new Map<string, Uint8Array>();
	let offset = 0;
	for (const item of expected) {
		const nl = raw.indexOf(0x0a, offset);
		if (nl < 0) throw new Error("PREVIEW_BLOB_STREAM_TRUNCATED");
		const header = raw.toString("ascii", offset, nl);
		const space = header.indexOf(" ");
		if (space < 0) throw new Error("PREVIEW_BLOB_STREAM_HEADER_INVALID");
		const sha256 = header.slice(0, space);
		const byteLen = Number.parseInt(header.slice(space + 1), 10);
		if (
			sha256 !== item.sha256 ||
			!Number.isSafeInteger(byteLen) ||
			byteLen !== item.bytes ||
			nl + 1 + byteLen > raw.byteLength
		) {
			throw new Error("PREVIEW_BLOB_STREAM_MISMATCH");
		}
		const content = new Uint8Array(raw.buffer, raw.byteOffset + nl + 1, byteLen);
		blobs.set(sha256, content);
		offset = nl + 1 + byteLen;
	}
	if (offset !== raw.byteLength) throw new Error("PREVIEW_BLOB_STREAM_TRAILING_BYTES");
	return blobs;
}

export async function collectAndUploadPreviewBuildToEdge(
	options: CollectAndUploadPreviewBuildOptions,
): Promise<SurfacePreviewBuildOutcome> {
	const { specsPaths, catalogPaths } = sharedProductAssetCandidates(options.productFolderRoots);
	const scanConfig = Buffer.from(
		JSON.stringify({
			uid: options.uid,
			gid: options.gid,
			outputDir: options.outputDir,
			companyMountDir: options.companyMountDir,
			identityCssPath: IDENTITY_TOKENS_CSS_PATH,
			identityJsonPath: IDENTITY_TOKENS_JSON_PATH,
			productSpecsPath: specsPaths[0] ?? "",
			productCatalogPath: catalogPaths[0] ?? "",
			secretValues: [...(options.secretValues ?? [])],
			extensions: [...NATIVE_SITE_EXTENSIONS],
			maxFiles: NATIVE_SITE_MAX_FILES,
			maxFileBytes: NATIVE_SITE_MAX_FILE_BYTES,
			maxTotalBytes: NATIVE_SITE_MAX_BYTES,
			maxPathBytes: NATIVE_SITE_MAX_PATH_BYTES,
			maxSegments: NATIVE_SITE_MAX_SEGMENTS,
			maxControlBytes: NATIVE_SITE_CONTROL_FILE_MAX_BYTES,
			maxSharedBytes: MAX_SHARED_ASSET_READ_BYTES,
		}),
		"utf8",
	);

	let scanRes: LxdExecPipeResult;
	try {
		scanRes = await options.execPipe(
			{
				command: ["/usr/bin/python3", "-I", "-c", NATIVE_PREVIEW_SCAN_PY],
				environment: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
				cwd: "/",
				user: 0,
				group: 0,
				stdin: scanConfig,
				maxStdoutBytes: MAX_SCAN_STDOUT_BYTES,
				stderrTailBytes: 8192,
			},
			options.signal,
		);
	} catch (error) {
		if (options.signal.aborted) throw error;
		return {
			outcome: "failed",
			errorDetail: previewBuildDetail(
				PREVIEW_BUILD_FAILED,
				`The build output in "${options.recipeFolder}" could not be scanned. [code=PREVIEW_SCAN_FAILED]`,
			),
		};
	}

	if (scanRes.exitCode !== 0) {
		return {
			outcome: "failed",
			errorDetail: previewBuildDetail(
				PREVIEW_BUILD_FAILED,
				`The build output in "${options.recipeFolder}" could not be scanned (exit ${scanRes.exitCode}). [code=PREVIEW_SCAN_EXIT_${scanRes.exitCode}]`,
			),
		};
	}

	let parsed: ScanOutput;
	try {
		parsed = JSON.parse(scanRes.stdout.toString("utf8")) as ScanOutput;
	} catch {
		return {
			outcome: "failed",
			errorDetail: previewBuildDetail(
				PREVIEW_BUILD_FAILED,
				`The build output in "${options.recipeFolder}" returned an unreadable scan. [code=PREVIEW_SCAN_INVALID]`,
			),
		};
	}

	if (parsed.problem) {
		return {
			outcome: "failed",
			errorDetail: previewSiteProblemDetail(
				{ code: parsed.problem.code, path: parsed.problem.path, variable: null },
				options.recipeFolder,
				{ native: true },
			),
		};
	}

	const scannedFiles = parsed.files ?? [];
	const byPath = new Map<string, ScannedFile>();
	for (const file of scannedFiles) {
		if (
			typeof file.path !== "string" ||
			!Number.isSafeInteger(file.bytes) ||
			file.bytes < 0 ||
			typeof file.sha256 !== "string" ||
			!SHA256_PATTERN.test(file.sha256)
		) {
			return {
				outcome: "failed",
				errorDetail: previewBuildDetail(
					PREVIEW_BUILD_FAILED,
					`The build output in "${options.recipeFolder}" contained an invalid file record. [code=PREVIEW_SCAN_INVALID]`,
				),
			};
		}
		byPath.set(file.path, file);
	}

	const sharedBlobs = buildSharedAssetBlobs(parsed.shared);
	const sharedContentByHash = new Map<string, Uint8Array>();
	for (const sharedFile of sharedBlobs.values()) {
		byPath.set(sharedFile.path, {
			path: sharedFile.path,
			bytes: sharedFile.bytes,
			sha256: sharedFile.sha256,
		});
		if (!sharedContentByHash.has(sharedFile.sha256)) {
			sharedContentByHash.set(sharedFile.sha256, sharedFile.content);
		}
	}

	const mergedEntries = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const treeProblem = nativeSiteTreeProblem(mergedEntries);
	if (treeProblem) {
		return {
			outcome: "failed",
			errorDetail: previewSiteProblemDetail(treeProblem, options.recipeFolder, { native: true }),
		};
	}

	const redirects = typeof parsed.redirects === "string" ? parseRedirectsFile(parsed.redirects) : [];
	const headers = typeof parsed.headers === "string" ? parseHeadersFile(parsed.headers) : [];
	const { manifestSha256, manifest, totalBytes } = computeCanonicalSiteManifest(mergedEntries, {
		redirects,
		headers,
	});

	const uniqueSourceByHash = new Map<string, { readonly path: string; readonly bytes: number }>();
	for (const entry of mergedEntries) {
		if (!uniqueSourceByHash.has(entry.sha256)) {
			uniqueSourceByHash.set(entry.sha256, { path: entry.path, bytes: entry.bytes });
		}
	}

	let missing: Set<string>;
	try {
		missing = await checkMissingBlobsOnEdge({
			routerInternalUrl: options.routerInternalUrl,
			controlToken: options.controlToken,
			hashes: [...uniqueSourceByHash.keys()],
			fetchImpl: options.fetchImpl,
			signal: options.signal,
		});
	} catch (error) {
		if (options.signal.aborted) throw error;
		return {
			outcome: "failed",
			errorDetail: previewBuildDetail(
				PREVIEW_BUILD_FAILED,
				`The built preview could not verify stored blobs on the edge router. [code=PREVIEW_EDGE_CHECK_FAILED]`,
			),
		};
	}

	const concurrency = Math.max(1, Math.min(16, options.concurrency ?? DEFAULT_BLOB_UPLOAD_CONCURRENCY));
	const uploadQueue = async (items: readonly { readonly sha256: string; readonly content: Uint8Array }[]) => {
		let cursor = 0;
		let failed = false;
		const worker = async (): Promise<void> => {
			while (!failed && cursor < items.length) {
				options.signal.throwIfAborted();
				const item = items[cursor++]!;
				try {
					await putBlobToEdge({
						routerInternalUrl: options.routerInternalUrl,
						controlToken: options.controlToken,
						sha256: item.sha256,
						content: item.content,
						fetchImpl: options.fetchImpl,
						signal: options.signal,
					});
				} catch (error) {
					failed = true;
					throw error;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	};

	const missingShared: { sha256: string; content: Uint8Array }[] = [];
	const missingBuilt: { path: string; sha256: string; bytes: number }[] = [];
	for (const sha256 of missing) {
		const sharedBytes = sharedContentByHash.get(sha256);
		if (sharedBytes !== undefined) {
			missingShared.push({ sha256, content: sharedBytes });
			continue;
		}
		const source = uniqueSourceByHash.get(sha256);
		if (source) {
			missingBuilt.push({ path: source.path, sha256, bytes: source.bytes });
		}
	}

	try {
		if (missingShared.length > 0) {
			await uploadQueue(missingShared);
		}

		// WHY: Chunk VM->host blob reads to ~32 MiB batches so large initial sites upload in parallel without buffering 512 MiB in host RAM.
		let batchStart = 0;
		while (batchStart < missingBuilt.length) {
			options.signal.throwIfAborted();
			const batch: { path: string; sha256: string; bytes: number }[] = [];
			let batchBytes = 0;
			let headerBytes = 0;
			while (batchStart < missingBuilt.length) {
				const next = missingBuilt[batchStart]!;
				if (
					batch.length > 0 &&
					(batch.length >= MAX_STREAM_BATCH_FILES || batchBytes + next.bytes > MAX_STREAM_BATCH_BYTES)
				) {
					break;
				}
				batch.push(next);
				batchBytes += next.bytes;
				headerBytes += 80;
				batchStart += 1;
			}
			const streamRes = await options.execPipe(
				{
					command: ["/usr/bin/python3", "-I", "-c", NATIVE_PREVIEW_STREAM_PY],
					environment: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
					cwd: "/",
					user: 0,
					group: 0,
					stdin: Buffer.from(
						JSON.stringify({
							uid: options.uid,
							gid: options.gid,
							outputDir: options.outputDir,
							files: batch.map(({ path, sha256 }) => ({ path, sha256 })),
						}),
						"utf8",
					),
					maxStdoutBytes: batchBytes + headerBytes + 4096,
					stderrTailBytes: 8192,
				},
				options.signal,
			);
			if (streamRes.exitCode !== 0) {
				return {
					outcome: "failed",
					errorDetail: previewBuildDetail(
						PREVIEW_BUILD_FAILED,
						`The build output in "${options.recipeFolder}" could not be read for upload (exit ${streamRes.exitCode}). [code=PREVIEW_BLOB_STREAM_EXIT_${streamRes.exitCode}]`,
					),
				};
			}
			const blobs = parseStreamedBlobs(streamRes.stdout, batch);
			await uploadQueue([...blobs.entries()].map(([sha256, content]) => ({ sha256, content })));
		}
	} catch (error) {
		if (options.signal.aborted) throw error;
		return {
			outcome: "failed",
			errorDetail: previewBuildDetail(
				PREVIEW_BUILD_FAILED,
				`The built preview could not be uploaded to the edge router. [code=PREVIEW_EDGE_UPLOAD_FAILED]`,
			),
		};
	}

	return {
		outcome: "built",
		builtTreeSha: null,
		native: {
			manifestSha256,
			manifest,
			fileCount: mergedEntries.length,
			totalBytes,
			hasCredentialInputs: parsed.hasCredentialInputs === true,
		},
	};
}
