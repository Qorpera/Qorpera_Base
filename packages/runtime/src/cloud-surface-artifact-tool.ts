import { createHash } from "node:crypto";
import { APP_ICONS_FOLDER } from "@qorpera/cloud-client/app-icons";
import {
	CLOUD_CODING_COMMAND_PAGE_BYTES,
	type CloudCodingCommandReceipt,
	isSurfaceOptionGroupKey,
	isUuid,
	type JsonValue,
	parseCloudCodingCommandRead,
	parseCloudCodingCommandReceipt,
	type StudioBinaryRef,
	SURFACE_LAYOUT_PATH,
	SURFACE_MAX_CHANGE_SUMMARY_CHARS,
	SURFACE_MAX_CHANGE_TITLE_CHARS,
	SURFACE_MAX_OPTION_GROUP_TITLE_CHARS,
} from "@qorpera/contracts";
import { cloudControlPause } from "./cloud-control-errors.ts";
import { FolderImageRefusal, type FolderImageView, folderImageView, oneImageAtATime } from "./cloud-folder-images.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
	relayControlRefusal,
} from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import type { StudioChatGptVoiceMachine } from "./cloud-studio-voice-recorder.ts";
import type { SurfacePatchSessionTracker, SurfacePatchToolPort } from "./cloud-surface-tools.ts";

export const STUDIO_STAGE_ARTIFACT_SCHEMA = "qorpera.studio-surface-artifact/v1";
export const MAX_STUDIO_ARTIFACT_BINARY_BYTES = 8 * 1024 * 1024;
export const MAX_STUDIO_ARTIFACT_TEXT_BYTES = 480 * 1024;

const MAX_ARTIFACT_PATH_CHARS = 256;
const MAX_SOURCE_PATH_CHARS = 512;
const MAX_BASE64_BYTES = Math.ceil(MAX_STUDIO_ARTIFACT_BINARY_BYTES / 3) * 4 + 128;
const READ_TIMEOUT_MS = 30_000;
const CANCEL_ON_ABORT_MS = 5_000;
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ARTIFACT_PAYLOAD = /^QORPERA_ART:([1-9][0-9]{0,7}):([0-9a-f]{64}):\n([A-Za-z0-9+/]*={0,2})$/;

interface ArtifactFormatSpec {
	readonly mediaType: string;
	readonly kind: "raster" | "text" | "binary";
	readonly maxBytes: number;
}

const ARTIFACT_FORMATS: Readonly<Record<string, ArtifactFormatSpec>> = {
	".png": { mediaType: "image/png", kind: "raster", maxBytes: MAX_STUDIO_ARTIFACT_BINARY_BYTES },
	".jpg": { mediaType: "image/jpeg", kind: "raster", maxBytes: MAX_STUDIO_ARTIFACT_BINARY_BYTES },
	".jpeg": { mediaType: "image/jpeg", kind: "raster", maxBytes: MAX_STUDIO_ARTIFACT_BINARY_BYTES },
	".webp": { mediaType: "image/webp", kind: "raster", maxBytes: MAX_STUDIO_ARTIFACT_BINARY_BYTES },
	".svg": { mediaType: "image/svg+xml", kind: "text", maxBytes: MAX_STUDIO_ARTIFACT_TEXT_BYTES },
	".html": { mediaType: "text/html", kind: "text", maxBytes: MAX_STUDIO_ARTIFACT_TEXT_BYTES },
	".pdf": { mediaType: "application/pdf", kind: "binary", maxBytes: MAX_STUDIO_ARTIFACT_BINARY_BYTES },
	".glb": { mediaType: "model/gltf-binary", kind: "binary", maxBytes: MAX_STUDIO_ARTIFACT_BINARY_BYTES },
	".mp3": { mediaType: "audio/mpeg", kind: "binary", maxBytes: MAX_STUDIO_ARTIFACT_BINARY_BYTES },
	".wav": { mediaType: "audio/wav", kind: "binary", maxBytes: MAX_STUDIO_ARTIFACT_BINARY_BYTES },
};

const READ_ARTIFACT_SCRIPT = [
	'const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");',
	"const max=Number(process.argv[1]),src=process.argv[2];",
	'const inside=(root,p)=>{const r=path.relative(root,p);return r!==""&&r!==".."&&!r.startsWith(".."+path.sep)&&!path.isAbsolute(r);};',
	"(async()=>{let fd=-1;try{",
	'const cwd=fs.realpathSync(".");',
	'let tmpRoot="/tmp";try{tmpRoot=fs.realpathSync("/tmp");}catch{}',
	"const allowed=(p)=>inside(cwd,p)||inside(tmpRoot,p);",
	"let real;",
	'try{real=fs.realpathSync(src);}catch(e){if(e&&e.code==="ENOENT")process.exit(44);if(e&&(e.code==="ELOOP"||e.code==="ENOTDIR"))process.exit(45);process.exit(49);}',
	"if(!allowed(real))process.exit(43);",
	"try{fd=fs.openSync(real,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}catch(e){",
	'if(e&&e.code==="ENOENT")process.exit(44);',
	'if(e&&(e.code==="ELOOP"||e.code==="EISDIR"||e.code==="ENXIO"||e.code==="ENODEV"||e.code==="EOPNOTSUPP"))process.exit(45);',
	"process.exit(49);}",
	"const st=fs.fstatSync(fd);if(!st.isFile())process.exit(45);",
	'try{const fdPath=fs.readlinkSync("/proc/self/fd/"+fd);if(!path.isAbsolute(fdPath)||fdPath.endsWith(" (deleted)")||!allowed(fdPath))process.exit(43);}catch(e){if(!e||(e.code!=="ENOENT"&&e.code!=="ENOTDIR"&&e.code!=="EACCES"))process.exit(49);}',
	"if(st.size===0)process.exit(48);if(st.size>max)process.exit(46);",
	"const chunks=[],part=Buffer.allocUnsafe(65536);let total=0;",
	"for(;;){const n=fs.readSync(fd,part,0,part.length,null);if(n===0)break;total+=n;if(total>max)process.exit(46);chunks.push(Buffer.from(part.subarray(0,n)));}",
	"if(total===0)process.exit(48);const data=Buffer.concat(chunks,total);",
	'const hash=crypto.createHash("sha256").update(data).digest("hex");',
	'const writeAll=async(s)=>{if(!process.stdout.write(s))await new Promise((r)=>process.stdout.once("drain",r));};',
	'await writeAll("QORPERA_ART:"+total+":"+hash+":\\n");',
	'for(let i=0;i<total;i+=49152)await writeAll(data.subarray(i,Math.min(total,i+49152)).toString("base64"));',
	"}catch{process.exit(49);}finally{if(fd>=0){try{fs.closeSync(fd);}catch{}}}} )().catch(()=>process.exit(49));",
].join("");

export interface StageSurfaceArtifactToolOptions {
	readonly sessionId: string;
	readonly folderRoot: string;
	readonly machine: StudioChatGptVoiceMachine;
	readonly stageBytes: (bytes: Uint8Array, mediaType: string, signal: AbortSignal) => Promise<StudioBinaryRef>;
	readonly surfacePatch: SurfacePatchToolPort;
	readonly patchTracker?: SurfacePatchSessionTracker;
	readonly pollMs?: number;
}

interface StageArtifactArgs {
	readonly sourcePath: string;
	readonly destPath: string;
	readonly ext: string;
	readonly spec: ArtifactFormatSpec;
	readonly title: string;
	readonly summary: string;
	readonly changeId?: string;
	readonly createNew: boolean;
	readonly optionGroup?: string;
	readonly optionGroupTitle?: string;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function fileExt(path: string): string {
	const base = path.split("/").pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

export function normalizeArtifactSourcePath(raw: unknown): { readonly sourcePath: string; readonly ext: string } {
	if (
		typeof raw !== "string" ||
		raw.length === 0 ||
		raw.trim() !== raw ||
		Buffer.byteLength(raw, "utf8") > MAX_SOURCE_PATH_CHARS ||
		CONTROL_CHAR.test(raw) ||
		raw.includes("\\")
	) {
		throw new CloudToolArgumentRefusal(
			"sourcePath must be a path under /tmp/... or a relative workspace path (no .., no backslashes)",
		);
	}
	const isTmp = raw.startsWith("/tmp/");
	if (raw.startsWith("/") && !isTmp) {
		throw new CloudToolArgumentRefusal("sourcePath may only read from /tmp/... or a relative workspace path");
	}
	const body = isTmp ? raw.slice("/tmp/".length) : raw;
	const parts = body.split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || part.trim() === "")) {
		throw new CloudToolArgumentRefusal("sourcePath contains invalid path segments");
	}
	const ext = fileExt(raw);
	if (!Object.hasOwn(ARTIFACT_FORMATS, ext)) {
		throw new CloudToolArgumentRefusal(
			`Unsupported artifact extension "${ext || "(none)"}". Allowed: ${Object.keys(ARTIFACT_FORMATS).join(", ")}`,
		);
	}
	return { sourcePath: raw, ext };
}

export function normalizeArtifactDestPath(raw: unknown, folderRoot: string, expectedMediaType: string): string {
	if (typeof raw !== "string" || raw.includes("\\") || raw.includes("\0") || CONTROL_CHAR.test(raw)) {
		throw new CloudToolArgumentRefusal("destPath must be a clean relative path inside the interface folder");
	}
	let trimmed = raw.trim().replace(/^\/+/, "");
	const prefix = `${folderRoot.replace(/^\/+|\/+$/g, "")}/`;
	if (prefix.length > 1 && trimmed.startsWith(prefix)) {
		trimmed = trimmed.slice(prefix.length);
	}
	if (!trimmed || trimmed.length > MAX_ARTIFACT_PATH_CHARS) {
		throw new CloudToolArgumentRefusal("destPath must be a clean relative path inside the interface folder");
	}
	const parts = trimmed.split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || part.trim() === "")) {
		throw new CloudToolArgumentRefusal("destPath must be a clean relative path inside the interface folder");
	}
	if (trimmed.toLowerCase() === SURFACE_LAYOUT_PATH.toLowerCase()) {
		throw new CloudToolArgumentRefusal("destPath cannot overwrite layout.json");
	}
	const ext = fileExt(trimmed);
	const destSpec = ARTIFACT_FORMATS[ext];
	if (!destSpec) {
		throw new CloudToolArgumentRefusal(`destPath must end in one of: ${Object.keys(ARTIFACT_FORMATS).join(", ")}`);
	}
	if (destSpec.mediaType !== expectedMediaType) {
		throw new CloudToolArgumentRefusal(
			`destPath extension "${ext}" (${destSpec.mediaType}) does not match source file type (${expectedMediaType})`,
		);
	}
	if (parts[0]?.toLowerCase() === APP_ICONS_FOLDER && ext !== ".svg") {
		throw new CloudToolArgumentRefusal(
			"icons/ is reserved for SVG icons; place other artifacts in visuals/, charts/, or assets/",
		);
	}
	return trimmed;
}

export function validateArtifactBytes(bytes: Buffer, ext: string): string | null {
	if (bytes.byteLength === 0) return "file is empty";
	switch (ext) {
		case ".png":
			return bytes.byteLength >= 8 &&
				bytes[0] === 0x89 &&
				bytes[1] === 0x50 &&
				bytes[2] === 0x4e &&
				bytes[3] === 0x47 &&
				bytes[4] === 0x0d &&
				bytes[5] === 0x0a &&
				bytes[6] === 0x1a &&
				bytes[7] === 0x0a
				? null
				: "file is not a valid PNG image";
		case ".jpg":
		case ".jpeg":
			return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
				? null
				: "file is not a valid JPEG image";
		case ".webp":
			return bytes.byteLength >= 12 &&
				bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
				bytes.subarray(8, 12).toString("ascii") === "WEBP"
				? null
				: "file is not a valid WebP image";
		case ".pdf":
			return bytes.byteLength >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-"
				? null
				: "file is not a valid PDF document";
		case ".glb":
			return bytes.byteLength >= 12 && bytes.subarray(0, 4).toString("ascii") === "glTF"
				? null
				: "file is not a valid GLB 3D model";
		case ".wav":
			return bytes.byteLength >= 12 &&
				bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
				bytes.subarray(8, 12).toString("ascii") === "WAVE"
				? null
				: "file is not a valid WAV audio file";
		case ".mp3":
			return (bytes.byteLength >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3") ||
				(bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
				? null
				: "file is not a valid MP3 audio file";
		case ".svg": {
			const text = bytes.toString("utf8");
			if (text.includes("\0") || !/<svg[\s>]/i.test(text)) {
				return "file is not a valid UTF-8 SVG document";
			}
			return null;
		}
		case ".html": {
			const text = bytes.toString("utf8");
			if (text.includes("\0") || text.trim().length === 0) {
				return "file is not a valid UTF-8 HTML document";
			}
			return null;
		}
		default:
			return "unsupported artifact type";
	}
}

export function decodeArtifactOutput(rawOutput: string): Buffer | null {
	const match = ARTIFACT_PAYLOAD.exec(rawOutput.trim());
	if (!match) return null;
	const declaredBytes = Number(match[1]);
	const declaredSha256 = match[2];
	const base64 = match[3] ?? "";
	if (
		!Number.isSafeInteger(declaredBytes) ||
		declaredBytes < 1 ||
		declaredBytes > MAX_STUDIO_ARTIFACT_BINARY_BYTES ||
		base64.length % 4 !== 0 ||
		base64.length !== Math.ceil(declaredBytes / 3) * 4
	) {
		return null;
	}
	const decoded = Buffer.from(base64, "base64");
	if (decoded.byteLength !== declaredBytes) return null;
	if (createHash("sha256").update(decoded).digest("hex") !== declaredSha256) return null;
	return decoded;
}

async function readFileFromCodingMachine(options: {
	readonly machine: StudioChatGptVoiceMachine;
	readonly sourcePath: string;
	readonly maxBytes: number;
	readonly callId: string;
	readonly context: CloudToolContext;
	readonly pollMs: number;
}): Promise<Buffer> {
	const { machine, sourcePath, maxBytes, callId, context, pollMs } = options;
	const { scope, identity, operations, gateway } = machine;
	const target = { schema: "qorpera.coding-command-target/v1", ...scope };
	const key = `studio-art:${createHash("sha256").update(`${identity.runId}:${callId}:${sourcePath}`).digest("hex").slice(0, 28)}`;
	const command = `if [ -x /usr/bin/node ]; then NODE_BIN=/usr/bin/node; else NODE_BIN=node; fi; NODE_OPTIONS= "$NODE_BIN" -e ${shellQuote(READ_ARTIFACT_SCRIPT)} -- ${maxBytes} ${shellQuote(sourcePath)} 2>/dev/null`;

	const checkedReceipt = (value: unknown, commandId: string, inputSha256?: string): CloudCodingCommandReceipt => {
		const receipt = parseCloudCodingCommandReceipt(value);
		if (
			receipt.workerId !== scope.workerId ||
			receipt.commandId !== commandId ||
			(inputSha256 !== undefined && receipt.inputSha256 !== inputSha256)
		) {
			throw new Error("Coding command result differs");
		}
		return receipt;
	};

	const cancelOnAbort = async (commandId: string): Promise<void> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CANCEL_ON_ABORT_MS);
		timer.unref?.();
		try {
			await gateway.cancel(scope, commandId, controller.signal);
		} catch {
			return;
		} finally {
			clearTimeout(timer);
		}
	};

	const childObservation = context.observation?.child("coding_run_command");
	let startedRunningId: string | null = null;
	let startContent: { kind: string; value?: unknown };
	try {
		startContent = await operations.execute({
			operation: {
				tool: "coding_run_command",
				toolVersion: "v1",
				logicalOperationKey: key,
				arguments: { operationKey: key, command, timeoutMs: READ_TIMEOUT_MS },
				target,
				requiresCompanyRevision: false,
			},
			authorize: (_operation, admitted, authSignal) => gateway.authorize(scope, admitted, authSignal),
			perform: async (_operation, effect) => {
				const started = checkedReceipt(
					await gateway.start(
						scope,
						{
							commandId: effect.receiptId,
							inputSha256: effect.inputSha256,
							command,
							timeoutMs: READ_TIMEOUT_MS,
						},
						effect.signal,
					),
					effect.receiptId,
					effect.inputSha256,
				);
				if (started.state === "running") startedRunningId = started.commandId;
				return { content: { kind: "json", value: started as unknown as JsonValue } };
			},
			signal: context.signal,
			...(childObservation ? { observation: childObservation } : {}),
		});
	} catch (error) {
		if (context.signal.aborted && startedRunningId !== null) await cancelOnAbort(startedRunningId);
		throw error;
	}
	if (startContent.kind !== "json") throw new Error("Coding command result differs");
	let current = parseCloudCodingCommandReceipt(startContent.value);

	const readReceipt = async (commandId: string, offset: number, limit: number): Promise<CloudCodingCommandReceipt> => {
		const parsed = parseCloudCodingCommandRead({ commandId, offset, limit });
		return checkedReceipt(
			await cloudToolRequest((requestSignal) => gateway.read(scope, parsed, requestSignal), context.signal),
			commandId,
		);
	};

	const deadline = Date.now() + READ_TIMEOUT_MS + 5_000;
	let delay = pollMs;
	while (current.state === "running") {
		if (context.signal.aborted) {
			await cancelOnAbort(current.commandId);
			context.signal.throwIfAborted();
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			await cancelOnAbort(current.commandId);
			throw new CloudToolRefusal("ARTIFACT_TIMEOUT: reading the artifact from the coding machine timed out.");
		}
		try {
			await cloudControlPause(Math.min(delay, remaining), context.signal);
		} catch (error) {
			if (context.signal.aborted) await cancelOnAbort(current.commandId);
			throw error;
		}
		delay = Math.min(1000, Math.max(pollMs, Math.round(delay * 1.5)));
		current = await readReceipt(current.commandId, current.log.totalBytes, 4);
	}

	if (current.state === "failed") {
		if (current.exitCode === 43) {
			throw new CloudToolRefusal(
				"ARTIFACT_OUTSIDE_ALLOWED_PATHS: sourcePath resolves outside /tmp and the coding workspace.",
			);
		}
		if (current.exitCode === 44) {
			throw new CloudToolRefusal(`ARTIFACT_NOT_FOUND: no file found at "${sourcePath}".`);
		}
		if (current.exitCode === 45) {
			throw new CloudToolRefusal(`ARTIFACT_NOT_A_FILE: "${sourcePath}" is not a regular file.`);
		}
		if (current.exitCode === 46) {
			throw new CloudToolRefusal(
				`ARTIFACT_TOO_LARGE: "${sourcePath}" exceeds the ${(maxBytes / 1024 / 1024).toFixed(1)} MiB limit.`,
			);
		}
		if (current.exitCode === 48) {
			throw new CloudToolRefusal(`ARTIFACT_EMPTY: "${sourcePath}" is empty.`);
		}
		throw new CloudToolRefusal(`ARTIFACT_UNREADABLE: could not read "${sourcePath}" from the coding machine.`);
	}
	if (current.state !== "succeeded") {
		throw new CloudToolRefusal(`ARTIFACT_UNAVAILABLE: reading "${sourcePath}" did not complete (${current.state}).`);
	}
	if (current.log.limitReached || current.log.gapBytes !== undefined || current.log.totalBytes > MAX_BASE64_BYTES) {
		throw new CloudToolRefusal("ARTIFACT_TOO_LARGE: artifact output exceeded transfer limit.");
	}

	const chunks: string[] = [];
	let cursor = 0;
	let collectedBytes = 0;
	if (current.log.offset === 0 && current.output.length > 0) {
		chunks.push(current.output);
		collectedBytes = Buffer.byteLength(current.output, "utf8");
		cursor = current.log.nextOffset;
	}
	const total = current.log.totalBytes;
	while (cursor < total) {
		context.signal.throwIfAborted();
		const page = await readReceipt(
			current.commandId,
			cursor,
			Math.max(4, Math.min(CLOUD_CODING_COMMAND_PAGE_BYTES, total - cursor)),
		);
		if (page.log.limitReached || page.log.gapBytes !== undefined || page.log.totalBytes !== total) {
			throw new CloudToolRefusal("ARTIFACT_UNAVAILABLE: artifact output changed while reading.");
		}
		if (page.log.offset !== cursor || page.log.nextOffset <= cursor) {
			throw new CloudToolRefusal("ARTIFACT_UNAVAILABLE: artifact output could not be read completely.");
		}
		collectedBytes += Buffer.byteLength(page.output, "utf8");
		if (collectedBytes > MAX_BASE64_BYTES) {
			throw new CloudToolRefusal("ARTIFACT_TOO_LARGE: artifact output exceeded transfer limit.");
		}
		chunks.push(page.output);
		cursor = page.log.nextOffset;
	}

	const bytes = decodeArtifactOutput(chunks.join(""));
	if (!bytes) {
		throw new CloudToolRefusal("ARTIFACT_UNREADABLE: artifact transfer payload was invalid or truncated.");
	}
	return bytes;
}

export function createStageSurfaceArtifactTool(options: StageSurfaceArtifactToolOptions): CloudNativeTool {
	const parseArgs = (value: unknown): StageArtifactArgs => {
		const allowed = [
			"sourcePath",
			"destPath",
			"title",
			"summary",
			"changeId",
			"createNew",
			"optionGroup",
			"optionGroupTitle",
		];
		if (
			value === null ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).some((key) => !allowed.includes(key)) ||
			!Object.hasOwn(value, "sourcePath") ||
			!Object.hasOwn(value, "destPath")
		) {
			throw new CloudToolArgumentRefusal(
				"stage_surface_artifact takes sourcePath and destPath, plus optional title, summary, changeId, createNew, optionGroup, and optionGroupTitle",
			);
		}
		const rec = value as Record<string, unknown>;
		const { sourcePath, ext } = normalizeArtifactSourcePath(rec.sourcePath);
		const spec = ARTIFACT_FORMATS[ext]!;
		const destPath = normalizeArtifactDestPath(rec.destPath, options.folderRoot, spec.mediaType);
		const base = destPath.split("/").pop() ?? "artifact";
		const title =
			rec.title === undefined
				? `Add ${base}`.slice(0, SURFACE_MAX_CHANGE_TITLE_CHARS)
				: typeof rec.title === "string" &&
						rec.title.trim().length > 0 &&
						rec.title.trim().length <= SURFACE_MAX_CHANGE_TITLE_CHARS
					? rec.title.trim()
					: null;
		if (title === null) {
			throw new CloudToolArgumentRefusal(`title must be 1..${SURFACE_MAX_CHANGE_TITLE_CHARS} characters`);
		}
		const summary =
			rec.summary === undefined
				? `Staged ${base} in Preview.`.slice(0, SURFACE_MAX_CHANGE_SUMMARY_CHARS)
				: typeof rec.summary === "string" &&
						rec.summary.trim().length > 0 &&
						rec.summary.trim().length <= SURFACE_MAX_CHANGE_SUMMARY_CHARS
					? rec.summary.trim()
					: null;
		if (summary === null) {
			throw new CloudToolArgumentRefusal(`summary must be 1..${SURFACE_MAX_CHANGE_SUMMARY_CHARS} characters`);
		}
		const changeId =
			rec.changeId === undefined
				? undefined
				: typeof rec.changeId === "string" && isUuid(rec.changeId.trim())
					? rec.changeId.trim().toLowerCase()
					: null;
		if (changeId === null) {
			throw new CloudToolArgumentRefusal("changeId must be a valid UUID");
		}
		const createNew = rec.createNew === undefined ? false : typeof rec.createNew === "boolean" ? rec.createNew : null;
		if (createNew === null) {
			throw new CloudToolArgumentRefusal("createNew must be a boolean");
		}
		if (changeId && createNew) {
			throw new CloudToolArgumentRefusal(
				"Pass either changeId to update an existing change in place or createNew: true to add a separate new change, not both.",
			);
		}
		const optionGroup =
			rec.optionGroup === undefined
				? undefined
				: typeof rec.optionGroup === "string" && isSurfaceOptionGroupKey(rec.optionGroup.trim())
					? rec.optionGroup.trim()
					: null;
		if (optionGroup === null) {
			throw new CloudToolArgumentRefusal("optionGroup must be a lowercase slug");
		}
		const optionGroupTitle =
			rec.optionGroupTitle === undefined
				? undefined
				: typeof rec.optionGroupTitle === "string" &&
						rec.optionGroupTitle.trim().length > 0 &&
						rec.optionGroupTitle.trim().length <= SURFACE_MAX_OPTION_GROUP_TITLE_CHARS
					? rec.optionGroupTitle.trim()
					: null;
		if (optionGroupTitle === null) {
			throw new CloudToolArgumentRefusal(
				`optionGroupTitle must be 1..${SURFACE_MAX_OPTION_GROUP_TITLE_CHARS} characters`,
			);
		}
		if (optionGroupTitle && !optionGroup) {
			throw new CloudToolArgumentRefusal("optionGroupTitle requires optionGroup");
		}
		return {
			sourcePath,
			destPath,
			ext,
			spec,
			title,
			summary,
			...(changeId ? { changeId } : {}),
			createNew,
			...(optionGroup ? { optionGroup } : {}),
			...(optionGroupTitle ? { optionGroupTitle } : {}),
		};
	};

	return {
		name: "stage_surface_artifact" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		images: true,
		description: [
			"Stage a visual or binary artifact you generated on the coding machine (under /tmp/... or the workspace) into this Studio interface's Preview folder.",
			"Supports PNG, JPG, JPEG, WebP (returned inline so you can visually verify immediately), SVG, HTML, PDF, GLB 3D models, MP3, and WAV up to 8 MiB (480 KiB for SVG/HTML).",
			"Use this after rendering custom plots, diagrams, PDFs, 3D models, or raster mockups with Python, Node, Blender, or Chromium on the coding machine.",
		].join("\n"),
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["sourcePath", "destPath"],
			properties: {
				sourcePath: {
					type: "string",
					minLength: 3,
					maxLength: MAX_SOURCE_PATH_CHARS,
					description: "Path on the coding machine (/tmp/... or relative workspace path).",
				},
				destPath: {
					type: "string",
					minLength: 3,
					maxLength: MAX_ARTIFACT_PATH_CHARS,
					description:
						"Relative destination path inside this interface folder (for example visuals/cohort.png or briefs/deck.pdf).",
				},
				title: {
					type: "string",
					minLength: 1,
					maxLength: SURFACE_MAX_CHANGE_TITLE_CHARS,
					description: "Short founder-facing change title shown in Changes.",
				},
				summary: {
					type: "string",
					minLength: 1,
					maxLength: SURFACE_MAX_CHANGE_SUMMARY_CHARS,
					description: "Concise founder-facing summary of the staged artifact.",
				},
				changeId: {
					type: "string",
					description: "Optional open change UUID to update in place.",
				},
				createNew: {
					type: "boolean",
					description:
						"Set true when intentionally staging a separate new change alongside existing open changes in this session.",
				},
				optionGroup: {
					type: "string",
					description: "Optional option-group slug when staging competing visual options.",
				},
				optionGroupTitle: {
					type: "string",
					minLength: 1,
					maxLength: SURFACE_MAX_OPTION_GROUP_TITLE_CHARS,
					description: "Optional option-group heading shown in Changes.",
				},
			},
		},
		parseArguments(value) {
			const args = parseArgs(value);
			const targetChangeId = options.patchTracker
				? options.patchTracker.resolveTargetChangeId({
						explicitChangeId: args.changeId ?? null,
						createNew: args.createNew,
						optionGroup: args.optionGroup ?? null,
					})
				: (args.changeId ?? null);
			return {
				sourcePath: args.sourcePath,
				destPath: args.destPath,
				title: args.title,
				summary: args.summary,
				...(targetChangeId ? { changeId: targetChangeId } : {}),
				...(args.createNew ? { createNew: true } : {}),
				...(args.optionGroup ? { optionGroup: args.optionGroup } : {}),
				...(args.optionGroupTitle ? { optionGroupTitle: args.optionGroupTitle } : {}),
			};
		},
		async execute(rawArgs, context: CloudToolContext) {
			const args = parseArgs(rawArgs);
			const targetChangeId = options.patchTracker
				? options.patchTracker.resolveTargetChangeId({
						explicitChangeId: args.changeId ?? null,
						createNew: args.createNew,
						optionGroup: args.optionGroup ?? null,
					})
				: (args.changeId ?? null);
			const rawBytes = await readFileFromCodingMachine({
				machine: options.machine,
				sourcePath: args.sourcePath,
				maxBytes: args.spec.maxBytes,
				callId: context.callId,
				context,
				pollMs: options.pollMs ?? 150,
			});
			const invalid = validateArtifactBytes(rawBytes, args.ext);
			if (invalid) {
				throw new CloudToolRefusal(`ARTIFACT_INVALID: ${invalid}.`);
			}

			if (args.spec.kind === "text") {
				const textContent = rawBytes.toString("utf8");
				const ops = [{ op: "write_text" as const, path: args.destPath, content: textContent }];
				let staged: { readonly changeId: string; readonly seq: number; readonly updated?: boolean };
				try {
					staged = await options.surfacePatch.stageSurfacePatch(
						options.sessionId,
						{
							title: args.title,
							summary: args.summary,
							ops,
							notePaths: [],
							finishSession: false,
							...(targetChangeId ? { changeId: targetChangeId } : {}),
							...(args.optionGroup ? { optionGroup: args.optionGroup } : {}),
							...(args.optionGroupTitle ? { optionGroupTitle: args.optionGroupTitle } : {}),
						},
						context,
					);
				} catch (error) {
					relayControlRefusal(error);
				}
				options.patchTracker?.recordStaged({
					targetChangeId,
					resultChangeId: staged.changeId,
					ops,
					optionGroup: args.optionGroup ?? null,
				});
				return {
					kind: "text",
					value: cloudToolJsonText({
						schema: STUDIO_STAGE_ARTIFACT_SCHEMA,
						ok: true,
						kind: "artifact",
						changeId: staged.changeId,
						seq: staged.seq,
						...(staged.updated === true ? { updated: true } : {}),
						path: args.destPath,
						mediaType: args.spec.mediaType,
						bytes: rawBytes.byteLength,
						next: "Staged for Preview. Reference it from layout.json (or an artifacts block) and call inspect_surface to verify the rendered page.",
					}),
				};
			}

			let view: FolderImageView | null = null;
			if (args.spec.kind === "raster") {
				try {
					view = await oneImageAtATime(context.signal, async () => folderImageView(rawBytes));
				} catch (error) {
					if (!(error instanceof FolderImageRefusal)) throw error;
					throw new CloudToolRefusal(
						`${error.reason === "too_large" ? "ARTIFACT_TOO_LARGE" : "ARTIFACT_INVALID"}: ${error.message}.`,
					);
				}
			}

			const binaryView = new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
			const ref = await options.stageBytes(binaryView, args.spec.mediaType, context.signal);
			const closedRef: StudioBinaryRef = {
				manifestSha256: ref.manifestSha256,
				fileSha256: ref.fileSha256,
				bytes: ref.bytes,
				mediaType: ref.mediaType,
			};
			const ops = [{ op: "write_file" as const, path: args.destPath, file: closedRef }];
			let staged: { readonly changeId: string; readonly seq: number; readonly updated?: boolean };
			try {
				staged = await options.surfacePatch.stageSurfacePatch(
					options.sessionId,
					{
						title: args.title,
						summary: args.summary,
						ops,
						notePaths: [],
						finishSession: false,
						...(targetChangeId ? { changeId: targetChangeId } : {}),
						...(args.optionGroup ? { optionGroup: args.optionGroup } : {}),
						...(args.optionGroupTitle ? { optionGroupTitle: args.optionGroupTitle } : {}),
					},
					context,
				);
			} catch (error) {
				relayControlRefusal(error);
			}
			options.patchTracker?.recordStaged({
				targetChangeId,
				resultChangeId: staged.changeId,
				ops,
				optionGroup: args.optionGroup ?? null,
			});

			if (view) {
				const answer: Record<string, JsonValue> = {
					schema: STUDIO_STAGE_ARTIFACT_SCHEMA,
					ok: true,
					kind: "artifact_image",
					changeId: staged.changeId,
					seq: staged.seq,
					...(staged.updated === true ? { updated: true } : {}),
					path: args.destPath,
					mediaType: args.spec.mediaType,
					bytes: rawBytes.byteLength,
					fileSha256: closedRef.fileSha256,
					width: view.width,
					height: view.height,
					shownWidth: view.shownWidth,
					shownHeight: view.shownHeight,
					imageSha256: view.sha256,
					next: "Staged for Preview and attached inline. Call inspect_surface once your layout references it to verify the full page.",
				};
				return {
					kind: "json",
					value: answer,
					image: { png: view.png, sha256: view.sha256 },
				};
			}

			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: STUDIO_STAGE_ARTIFACT_SCHEMA,
					ok: true,
					kind: "artifact",
					changeId: staged.changeId,
					seq: staged.seq,
					...(staged.updated === true ? { updated: true } : {}),
					path: args.destPath,
					mediaType: args.spec.mediaType,
					bytes: rawBytes.byteLength,
					fileSha256: closedRef.fileSha256,
					next: "Staged for Preview. Reference it from layout.json (or an artifacts/report/stage_3d block) and call inspect_surface to check layout.",
				}),
			};
		},
	};
}
