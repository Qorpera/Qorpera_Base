import { createHash } from "node:crypto";
import {
	CLOUD_CODING_COMMAND_PAGE_BYTES,
	type CloudCodingCommandReceipt,
	type CloudCodingCommandScope,
	type JsonValue,
	parseCloudCodingCommandRead,
	parseCloudCodingCommandReceipt,
} from "@qorpera/contracts";
import type { CloudCodingCommandGateway } from "./cloud-coding-command-tools.ts";
import { cloudCommandFits, fitCloudCommandPage } from "./cloud-command-page-fit.ts";
import { cloudControlPause } from "./cloud-control-errors.ts";
import { type FolderImageFormat, FolderImageRefusal, folderImageView, oneImageAtATime } from "./cloud-folder-images.ts";
import { type CloudNativeToolIdentity, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import {
	CloudToolArgumentRefusal,
	type CloudToolContent,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";

export const CODING_INSPECT_IMAGE_SCHEMA = "qorpera.coding-image-inspection/v1";
export const MAX_CODING_INSPECT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CODING_INSPECT_PATH_BYTES = 512;

const MAX_CODING_INSPECT_BASE64_BYTES = Math.ceil(MAX_CODING_INSPECT_IMAGE_BYTES / 3) * 4 + 128;
const INSPECT_IMAGE_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 250;
const MAX_POLL_MS = 1000;
const DEFAULT_TIMEOUT_GRACE_MS = 5000;
const CANCEL_ON_ABORT_MS = 5000;
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const IMAGE_BASENAME = /^(.+)\.(png|jpg|jpeg|webp)$/i;
const IMAGE_PAYLOAD = /^QORPERA_IMG:([1-9][0-9]{0,7}):([0-9a-f]{64}):\n([A-Za-z0-9+/]*={0,2})$/;
const SUPPORTED_FORMATS: ReadonlySet<FolderImageFormat> = new Set(["png", "jpeg", "webp"]);
const INSPECT_PATH_REFUSAL =
	"inspectImage must be a relative workspace path to a .png, .jpg, .jpeg or .webp file (no leading /, no .., no backslash, at most 512 bytes).";

const INSPECT_IMAGE_SCRIPT = [
	'const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");',
	`const max=${MAX_CODING_INSPECT_IMAGE_BYTES},rel=process.argv[1];`,
	'const inside=(root,p)=>{const r=path.relative(root,p);return r!==""&&r!==".."&&!r.startsWith(".."+path.sep)&&!path.isAbsolute(r);};',
	"(async()=>{let fd=-1;try{",
	'const root=fs.realpathSync(".");let real;',
	'try{real=fs.realpathSync(rel);}catch(e){if(e&&e.code==="ENOENT")process.exit(44);if(e&&(e.code==="ELOOP"||e.code==="ENOTDIR"))process.exit(45);process.exit(49);}',
	"if(!inside(root,real))process.exit(43);",
	"try{fd=fs.openSync(real,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}catch(e){",
	'if(e&&e.code==="ENOENT")process.exit(44);',
	'if(e&&(e.code==="ELOOP"||e.code==="EISDIR"||e.code==="ENXIO"||e.code==="ENODEV"||e.code==="EOPNOTSUPP"))process.exit(45);',
	"process.exit(49);}",
	"const st=fs.fstatSync(fd);if(!st.isFile())process.exit(45);",
	'try{const fdPath=fs.readlinkSync("/proc/self/fd/"+fd);if(!path.isAbsolute(fdPath)||fdPath.endsWith(" (deleted)")||!inside(root,fdPath))process.exit(43);}catch(e){if(!e||(e.code!=="ENOENT"&&e.code!=="ENOTDIR"&&e.code!=="EACCES"))process.exit(49);}',
	"if(st.size===0)process.exit(48);if(st.size>max)process.exit(46);",
	"const chunks=[],part=Buffer.allocUnsafe(65536);let total=0;",
	"for(;;){const n=fs.readSync(fd,part,0,part.length,null);if(n===0)break;total+=n;if(total>max)process.exit(46);chunks.push(Buffer.from(part.subarray(0,n)));}",
	"if(total===0)process.exit(48);const data=Buffer.concat(chunks,total);",
	"const png=total>=8&&data[0]===0x89&&data[1]===0x50&&data[2]===0x4e&&data[3]===0x47&&data[4]===0x0d&&data[5]===0x0a&&data[6]===0x1a&&data[7]===0x0a;",
	"const jpg=total>=3&&data[0]===0xff&&data[1]===0xd8&&data[2]===0xff;",
	"const webp=total>=12&&data[0]===0x52&&data[1]===0x49&&data[2]===0x46&&data[3]===0x46&&data[8]===0x57&&data[9]===0x45&&data[10]===0x42&&data[11]===0x50;",
	"if(!png&&!jpg&&!webp)process.exit(48);",
	'const hash=crypto.createHash("sha256").update(data).digest("hex");',
	'const writeAll=async(s)=>{if(!process.stdout.write(s))await new Promise((r)=>process.stdout.once("drain",r));};',
	'await writeAll("QORPERA_IMG:"+total+":"+hash+":\\n");',
	'for(let i=0;i<total;i+=49152)await writeAll(data.subarray(i,Math.min(total,i+49152)).toString("base64"));',
	"}catch{process.exit(49);}finally{if(fd>=0){try{fs.closeSync(fd);}catch{}}}} )().catch(()=>process.exit(49));",
].join("");

export interface CodingInspectImageRequest {
	readonly operationKey: string;
	readonly inspectImage: string;
}

export function parseCodingInspectImagePath(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.trim() !== value ||
		Buffer.byteLength(value, "utf8") > MAX_CODING_INSPECT_PATH_BYTES ||
		Buffer.from(value).toString("utf8") !== value ||
		CONTROL_CHAR.test(value) ||
		value.startsWith("/") ||
		value.includes("\\")
	)
		throw new CloudToolArgumentRefusal(INSPECT_PATH_REFUSAL);
	const parts = value.split("/");
	if (parts.some((part) => part === "" || part === "." || part === ".." || part.trim() === ""))
		throw new CloudToolArgumentRefusal(INSPECT_PATH_REFUSAL);
	const base = parts[parts.length - 1] ?? "";
	const match = IMAGE_BASENAME.exec(base);
	if (!match || !match[1] || match[1].trim() === "") throw new CloudToolArgumentRefusal(INSPECT_PATH_REFUSAL);
	return value;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildInspectImageCommand(relativePath: string): string {
	return `if [ -x /usr/bin/node ]; then NODE_BIN=/usr/bin/node; else NODE_BIN=node; fi; "$NODE_BIN" -e ${shellQuote(INSPECT_IMAGE_SCRIPT)} -- ${shellQuote(relativePath)}`;
}

export function decodeInspectImageOutput(rawOutput: string): Buffer | null {
	const match = IMAGE_PAYLOAD.exec(rawOutput);
	if (!match) return null;
	const declaredBytes = Number(match[1]);
	const declaredSha256 = match[2];
	const base64 = match[3] ?? "";
	if (
		!Number.isSafeInteger(declaredBytes) ||
		declaredBytes < 1 ||
		declaredBytes > MAX_CODING_INSPECT_IMAGE_BYTES ||
		base64.length % 4 !== 0 ||
		base64.length !== Math.ceil(declaredBytes / 3) * 4
	)
		return null;
	const decoded = Buffer.from(base64, "base64");
	if (decoded.byteLength !== declaredBytes) return null;
	if (createHash("sha256").update(decoded).digest("hex") !== declaredSha256) return null;
	return decoded;
}

function inspectSubOperationKey(operationKey: string, suffix: string): string {
	const hash = createHash("sha256").update(operationKey, "utf8").digest("hex").slice(0, 32);
	return `img:${hash}:${suffix}`;
}

export async function inspectCodingWorkspaceImage(options: {
	scope: CloudCodingCommandScope;
	identity: CloudNativeToolIdentity;
	operations: Pick<CloudNativeToolOperations, "execute">;
	gateway: CloudCodingCommandGateway;
	checkAuthority: (context: CloudToolContext) => Promise<void>;
	request: CodingInspectImageRequest;
	context: CloudToolContext;
	pollMs?: number;
	timeoutGraceMs?: number;
}): Promise<CloudToolContent> {
	const { scope, operations, gateway, checkAuthority, request, context } = options;
	const target = { schema: "qorpera.coding-command-target/v1", ...scope };
	const basePollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const maxPollMs = Math.max(basePollMs, Math.min(MAX_POLL_MS, basePollMs * 4));
	const timeoutGraceMs = options.timeoutGraceMs ?? DEFAULT_TIMEOUT_GRACE_MS;

	const checkedReceipt = (value: unknown, commandId: string, inputSha256?: string): CloudCodingCommandReceipt => {
		const receipt = parseCloudCodingCommandReceipt(value);
		if (
			receipt.workerId !== scope.workerId ||
			receipt.commandId !== commandId ||
			(inputSha256 !== undefined && receipt.inputSha256 !== inputSha256)
		)
			throw new Error("Coding command result differs");
		return receipt;
	};

	const refuse = async (message: string): Promise<never> => {
		await checkAuthority(context);
		throw new CloudToolRefusal(message);
	};

	const cancelThroughOperation = async (
		commandId: string,
		signal: AbortSignal,
	): Promise<CloudCodingCommandReceipt> => {
		const cancelKey = inspectSubOperationKey(request.operationKey, "read:cancel");
		const cancelArgs = { commandId, operationKey: cancelKey };
		const childObservation = context.observation?.child("coding_cancel_command");
		const content = await operations.execute({
			operation: {
				tool: "coding_cancel_command",
				toolVersion: "v1",
				logicalOperationKey: cancelKey,
				arguments: cancelArgs,
				target,
				requiresCompanyRevision: false,
			},
			authorize: (_operation, admitted, authSignal) => gateway.authorize(scope, admitted, authSignal),
			perform: async (_operation, receipt) => {
				const cancelled = checkedReceipt(await gateway.cancel(scope, commandId, receipt.signal), commandId);
				return { content: { kind: "text", value: cloudToolJsonText(cancelled) } };
			},
			signal,
			...(childObservation ? { observation: childObservation } : {}),
		});
		if (content.kind !== "text") throw new Error("Coding command result differs");
		return parseCloudCodingCommandReceipt(JSON.parse(content.value));
	};

	const cancelOnAbort = async (commandId: string): Promise<void> => {
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new DOMException("Cancel timed out", "TimeoutError")),
			CANCEL_ON_ABORT_MS,
		);
		timer.unref?.();
		try {
			await cancelThroughOperation(commandId, controller.signal);
		} catch {
			try {
				await gateway.cancel(scope, commandId, controller.signal);
			} catch {
				return;
			}
		} finally {
			clearTimeout(timer);
		}
	};

	const cancelBestEffort = async (commandId: string): Promise<CloudCodingCommandReceipt | undefined> => {
		if (context.signal.aborted) {
			await cancelOnAbort(commandId);
			context.signal.throwIfAborted();
		}
		try {
			return await cancelThroughOperation(commandId, context.signal);
		} catch {
			if (context.signal.aborted) {
				await cancelOnAbort(commandId);
				context.signal.throwIfAborted();
			}
			return undefined;
		}
	};

	const startReadCommand = async (command: string): Promise<CloudCodingCommandReceipt> => {
		const subKey = inspectSubOperationKey(request.operationKey, "read");
		const subArgs = { operationKey: subKey, command, timeoutMs: INSPECT_IMAGE_TIMEOUT_MS };
		const childObservation = context.observation?.child("coding_run_command");
		let startedRunningId: string | null = null;
		let content: CloudToolContent;
		try {
			content = await operations.execute({
				operation: {
					tool: "coding_run_command",
					toolVersion: "v1",
					logicalOperationKey: subKey,
					arguments: subArgs,
					target,
					requiresCompanyRevision: false,
				},
				authorize: (_operation, admitted, signal) => gateway.authorize(scope, admitted, signal),
				perform: async (_operation, receipt) => {
					const started = checkedReceipt(
						await gateway.start(
							scope,
							{
								commandId: receipt.receiptId,
								inputSha256: receipt.inputSha256,
								command,
								timeoutMs: INSPECT_IMAGE_TIMEOUT_MS,
							},
							receipt.signal,
						),
						receipt.receiptId,
						receipt.inputSha256,
					);
					if (started.state === "running") startedRunningId = started.commandId;
					const fitted = fitCloudCommandPage(started, false, cloudCommandFits);
					const stored =
						fitted && "page" in fitted
							? fitted.page
							: {
									...started,
									output: "",
									log: { ...started.log, nextOffset: started.log.offset },
									truncated: started.log.offset < started.log.totalBytes || started.log.limitReached,
								};
					return { content: { kind: "text", value: cloudToolJsonText(stored) } };
				},
				signal: context.signal,
				...(childObservation ? { observation: childObservation } : {}),
			});
		} catch (error) {
			if (context.signal.aborted && startedRunningId !== null) await cancelOnAbort(startedRunningId);
			throw error;
		}
		if (content.kind !== "text") throw new Error("Coding command result differs");
		return parseCloudCodingCommandReceipt(JSON.parse(content.value));
	};

	const readReceipt = async (commandId: string, offset: number, limit: number): Promise<CloudCodingCommandReceipt> => {
		const parsed = parseCloudCodingCommandRead({ commandId, offset, limit });
		return checkedReceipt(
			await cloudToolRequest((requestSignal) => gateway.read(scope, parsed, requestSignal), context.signal),
			commandId,
		);
	};

	const command = buildInspectImageCommand(request.inspectImage);
	const started = await startReadCommand(command);
	let current = started;
	const deadline = Date.now() + INSPECT_IMAGE_TIMEOUT_MS + timeoutGraceMs;
	let delay = basePollMs;
	while (current.state === "running") {
		if (context.signal.aborted) {
			await cancelOnAbort(current.commandId);
			context.signal.throwIfAborted();
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			await cancelBestEffort(current.commandId);
			return refuse("CODING_IMAGE_UNAVAILABLE: reading the image from the workspace timed out.");
		}
		try {
			await cloudControlPause(Math.min(delay, remaining), context.signal);
		} catch (error) {
			if (context.signal.aborted) await cancelOnAbort(current.commandId);
			throw error;
		}
		delay = Math.min(maxPollMs, Math.max(basePollMs, Math.round(delay * 1.5)));
		try {
			await checkAuthority(context);
			current = await readReceipt(current.commandId, current.log.totalBytes, 4);
		} catch (error) {
			if (context.signal.aborted) await cancelOnAbort(current.commandId);
			throw error;
		}
	}

	if (current.state === "failed") {
		if (current.exitCode === 43)
			return refuse(
				"CODING_IMAGE_OUTSIDE_WORKSPACE: the path resolves outside the repository workspace (for example through a symbolic link).",
			);
		if (current.exitCode === 44) return refuse("CODING_IMAGE_NOT_FOUND: no file was found at that workspace path.");
		if (current.exitCode === 45)
			return refuse("CODING_IMAGE_NOT_A_FILE: the path is not a regular file in the repository workspace.");
		if (current.exitCode === 46)
			return refuse(
				`CODING_IMAGE_TOO_LARGE: the image file is larger than ${MAX_CODING_INSPECT_IMAGE_BYTES / 1024 / 1024} MiB.`,
			);
		if (current.exitCode === 48)
			return refuse("CODING_IMAGE_UNREADABLE: the file is empty or is not a PNG, JPEG, or WebP image.");
		return refuse("CODING_IMAGE_UNAVAILABLE: the image file could not be read from the workspace.");
	}
	if (current.state !== "succeeded")
		return refuse(`CODING_IMAGE_UNAVAILABLE: reading the image did not complete (${current.state}).`);

	if (
		current.log.limitReached ||
		current.log.gapBytes !== undefined ||
		current.log.totalBytes > MAX_CODING_INSPECT_BASE64_BYTES
	)
		return refuse(
			`CODING_IMAGE_TOO_LARGE: the image output exceeded the ${MAX_CODING_INSPECT_IMAGE_BYTES / 1024 / 1024} MiB inspection bound.`,
		);

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
		if (page.log.limitReached || page.log.gapBytes !== undefined || page.log.totalBytes !== total)
			return refuse("CODING_IMAGE_UNAVAILABLE: the image output changed while reading.");
		if (page.log.offset !== cursor || page.log.nextOffset <= cursor)
			return refuse("CODING_IMAGE_UNAVAILABLE: the image output could not be read completely.");
		collectedBytes += Buffer.byteLength(page.output, "utf8");
		if (collectedBytes > MAX_CODING_INSPECT_BASE64_BYTES)
			return refuse(
				`CODING_IMAGE_TOO_LARGE: the image output exceeded the ${MAX_CODING_INSPECT_IMAGE_BYTES / 1024 / 1024} MiB inspection bound.`,
			);
		chunks.push(page.output);
		cursor = page.log.nextOffset;
	}

	const rawBytes = decodeInspectImageOutput(chunks.join(""));
	if (!rawBytes) return refuse("CODING_IMAGE_UNREADABLE: the workspace image payload was invalid or truncated.");

	const view = await oneImageAtATime(context.signal, async () => {
		try {
			return folderImageView(rawBytes);
		} catch (error) {
			if (!(error instanceof FolderImageRefusal)) throw error;
			await checkAuthority(context);
			throw new CloudToolRefusal(
				`${error.reason === "too_large" ? "CODING_IMAGE_TOO_LARGE" : "CODING_IMAGE_UNREADABLE"}: ${error.message}.`,
			);
		}
	});
	if (!SUPPORTED_FORMATS.has(view.format))
		return refuse("CODING_IMAGE_UNSUPPORTED_FORMAT: only PNG, JPEG, and WebP images can be inspected.");

	await checkAuthority(context);
	const answer: Record<string, JsonValue> = {
		schema: CODING_INSPECT_IMAGE_SCHEMA,
		kind: "image",
		path: request.inspectImage,
		mediaType: `image/${view.format}`,
		totalBytes: rawBytes.byteLength,
		width: view.width,
		height: view.height,
		shownWidth: view.shownWidth,
		shownHeight: view.shownHeight,
		imageSha256: view.sha256,
	};
	return {
		kind: "json",
		value: answer,
		image: { png: view.png, sha256: view.sha256 },
	};
}
