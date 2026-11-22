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
import { type CloudNativeToolIdentity, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import {
	type CloudToolContent,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
	redactCloudWebhookSecrets,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";

export const CODING_PREFLIGHT_LAND_SCHEMA = "qorpera.coding-preflight-land/v1";

const PREFLIGHT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 250;
const MAX_POLL_MS = 1000;
const DEFAULT_TIMEOUT_GRACE_MS = 5000;
const CANCEL_ON_ABORT_MS = 5000;
const MAX_PREFLIGHT_OUTPUT_BYTES = 128 * 1024;
const PAYLOAD_PREFIX = "QORPERA_PREFLIGHT_LAND:";

const PREFLIGHT_LAND_SCRIPT = [
	'const cp=require("node:child_process"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");',
	'const git=(args,gitDir)=>cp.spawnSync("git",gitDir?["--git-dir="+gitDir,...args]:args,{maxBuffer:64*1024*1024});',
	"const shaRe=/^[0-9a-f]{40}$/;",
	'const headRes=git(["rev-parse","--verify","HEAD"]);',
	"if(headRes.status!==0)process.exit(41);",
	'const headSha=headRes.stdout.toString("utf8").trim();',
	"if(!shaRe.test(headSha))process.exit(41);",
	'const stRes=git(["status","--porcelain","-z"]);',
	"if(stRes.status!==0)process.exit(42);",
	'const stRaw=stRes.stdout.toString("utf8");',
	'let uncommittedChanges=0;for(const item of stRaw.split("\\0"))if(item)uncommittedChanges++;',
	'let baseRef="refs/heads/main",baseSha="";',
	'for(const ref of ["refs/heads/main","refs/remotes/origin/main"]){',
	'const r=git(["rev-parse","--verify","--quiet",ref+"^{commit}"]);',
	'if(r.status===0){const s=r.stdout.toString("utf8").trim();if(shaRe.test(s)){baseRef=ref;baseSha=s;break;}}}',
	"if(!baseSha)process.exit(43);",
	'const commonRes=git(["rev-parse","--git-common-dir"]);',
	"if(commonRes.status!==0)process.exit(44);",
	'const commonDir=path.resolve(commonRes.stdout.toString("utf8").trim());',
	'const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"qorpera-preflight-"));',
	"try{",
	'const scratch=path.join(tmp,"scratch.git");',
	'const initRes=git(["init","--quiet","--bare","--template=",scratch]);',
	"if(initRes.status!==0)process.exit(44);",
	'fs.writeFileSync(path.join(scratch,"objects","info","alternates"),path.join(commonDir,"objects")+"\\n");',
	'const mt=git(["merge-tree","--write-tree","-z","--name-only","--messages",baseSha,headSha],scratch);',
	"let mergeClean=false,treeSha=null,conflictedPaths=[],conflictMessages=[];",
	"if(mt.status===0){",
	'const nul=mt.stdout.indexOf(0);treeSha=mt.stdout.subarray(0,nul>=0?nul:mt.stdout.length).toString("latin1").trim();',
	"mergeClean=shaRe.test(treeSha);",
	"}else if(mt.status===1){",
	'const f=mt.stdout.toString("utf8").split("\\0");const pset=new Set();let i=1;',
	'while(i<f.length&&f[i]!==""){pset.add(f[i]);i++;}i++;',
	"const mset=new Set();let mb=0;",
	'while(i<f.length&&f[i]!==""){const cnt=Number(f[i]);if(!Number.isSafeInteger(cnt)||cnt<0||i+cnt+2>=f.length)break;',
	'const t=f[i+cnt+1]||"",m=f[i+cnt+2]||"";i+=cnt+3;',
	'if(!t.startsWith("CONFLICT")&&!m.includes("CONFLICT"))continue;',
	'const c=m.replace(/[\\r\\n\\t]+/g," ").replace(/[\\x00-\\x1f\\x7f]/g,"").trim().slice(0,300);',
	"if(!c||mset.has(c))continue;if(conflictMessages.length>=20||mb+Buffer.byteLength(c)>2048)break;",
	"mset.add(c);conflictMessages.push(c);mb+=Buffer.byteLength(c);}",
	"conflictedPaths=[...pset].slice(0,50);",
	"}else{process.exit(45);}",
	"const targetTree=treeSha||headSha;",
	'const ls=git(["ls-tree","-r","-t","-l","-z","--full-tree",targetTree],treeSha?scratch:undefined);',
	"if(ls.status!==0)process.exit(46);",
	"const nameProblems=[],largeFiles=[],seenCase=new Map();",
	"let off=0;const buf=ls.stdout;",
	"while(off<buf.length){const end=buf.indexOf(0,off);if(end<0)break;",
	"const rec=buf.subarray(off,end);off=end+1;const tab=rec.indexOf(9);if(tab<0)continue;",
	'const hdr=rec.subarray(0,tab).toString("latin1").split(/ +/);if(hdr.length!==4)continue;',
	"const type=hdr[1],size=Number(hdr[3]),raw=rec.subarray(tab+1);",
	'const p=raw.toString("utf8");',
	'if(!Buffer.from(p,"utf8").equals(raw)){if(nameProblems.length<20)nameProblems.push({code:"CODE_HOST_NAMES_NOT_UTF8",path:p});continue;}',
	'if(p.normalize("NFC")!==p&&nameProblems.length<20)nameProblems.push({code:"CODE_HOST_NAMES_NOT_NFC",path:p});',
	'if(type==="blob"&&size>268435456&&largeFiles.length<20)largeFiles.push({path:p,bytes:size});',
	'const slash=p.lastIndexOf("/"),dir=p.slice(0,slash+1),base=p.slice(slash+1),key=dir+"\\0"+base.toLowerCase();',
	'const prev=seenCase.get(key);if(prev!==undefined&&prev!==p&&nameProblems.length<20)nameProblems.push({code:"CODE_HOST_NAMES_DIFFER_BY_CASE",path:p});else seenCase.set(key,p);',
	'const segs=p.split("/");',
	'if(Buffer.byteLength(p)>4000||segs.some((s)=>!s||/[\\\\\\x00-\\x1f\\x7f]/.test(s)||s.endsWith(".")||s.endsWith(" ")||Buffer.byteLength(s)>255)){',
	'if(nameProblems.length<20)nameProblems.push({code:"CODE_HOST_NAMES_FOLDER_REFUSES",path:p});}}',
	'process.stdout.write("QORPERA_PREFLIGHT_LAND:"+JSON.stringify({baseRef,baseSha,headSha,uncommittedChanges,mergeClean,conflictedPaths,conflictMessages,nameProblems,largeFiles})+"\\n");',
	"}finally{fs.rmSync(tmp,{recursive:true,force:true});}",
].join("");

export interface CodingPreflightLandRequest {
	readonly operationKey: string;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildPreflightLandCommand(): string {
	return `if [ -x /usr/bin/node ]; then NODE_BIN=/usr/bin/node; else NODE_BIN=node; fi; NODE_OPTIONS= "$NODE_BIN" -e ${shellQuote(PREFLIGHT_LAND_SCRIPT)} 2>/dev/null`;
}

function preflightSubOperationKey(operationKey: string, suffix: string): string {
	const hash = createHash("sha256").update(operationKey, "utf8").digest("hex").slice(0, 32);
	return `preflight:${hash}:${suffix}`;
}

export interface CodingPreflightLandResult {
	readonly baseRef: string;
	readonly baseSha: string;
	readonly headSha: string;
	readonly uncommittedChanges: number;
	readonly mergeClean: boolean;
	readonly conflictedPaths: readonly string[];
	readonly conflictMessages: readonly string[];
	readonly nameProblems: readonly { readonly code: string; readonly path: string }[];
	readonly largeFiles: readonly { readonly path: string; readonly bytes: number }[];
}

export function decodePreflightLandOutput(rawOutput: string): CodingPreflightLandResult | null {
	const line = rawOutput.split(/\r?\n/).find((entry) => entry.startsWith(PAYLOAD_PREFIX));
	if (!line) return null;
	try {
		const parsed = JSON.parse(line.slice(PAYLOAD_PREFIX.length)) as Record<string, unknown>;
		if (
			typeof parsed.baseRef !== "string" ||
			typeof parsed.baseSha !== "string" ||
			typeof parsed.headSha !== "string" ||
			typeof parsed.uncommittedChanges !== "number" ||
			typeof parsed.mergeClean !== "boolean" ||
			!Array.isArray(parsed.conflictedPaths) ||
			!Array.isArray(parsed.conflictMessages) ||
			!Array.isArray(parsed.nameProblems) ||
			!Array.isArray(parsed.largeFiles)
		)
			return null;
		return {
			baseRef: parsed.baseRef,
			baseSha: parsed.baseSha,
			headSha: parsed.headSha,
			uncommittedChanges: parsed.uncommittedChanges,
			mergeClean: parsed.mergeClean,
			conflictedPaths: parsed.conflictedPaths.filter((p): p is string => typeof p === "string"),
			conflictMessages: parsed.conflictMessages.filter((m): m is string => typeof m === "string"),
			nameProblems: parsed.nameProblems.filter(
				(item): item is { code: string; path: string } =>
					Boolean(item) &&
					typeof item === "object" &&
					typeof (item as { code?: unknown }).code === "string" &&
					typeof (item as { path?: unknown }).path === "string",
			),
			largeFiles: parsed.largeFiles.filter(
				(item): item is { path: string; bytes: number } =>
					Boolean(item) &&
					typeof item === "object" &&
					typeof (item as { path?: unknown }).path === "string" &&
					typeof (item as { bytes?: unknown }).bytes === "number",
			),
		};
	} catch {
		return null;
	}
}

export async function runCodingPreflightLand(options: {
	scope: CloudCodingCommandScope;
	identity: CloudNativeToolIdentity;
	operations: Pick<CloudNativeToolOperations, "execute">;
	gateway: CloudCodingCommandGateway;
	checkAuthority: (context: CloudToolContext) => Promise<void>;
	request: CodingPreflightLandRequest;
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

	const cancelBestEffort = async (commandId: string): Promise<void> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CANCEL_ON_ABORT_MS);
		timer.unref?.();
		try {
			await gateway.cancel(scope, commandId, controller.signal);
		} catch {
			undefined;
		} finally {
			clearTimeout(timer);
		}
	};

	const command = buildPreflightLandCommand();
	const subKey = preflightSubOperationKey(request.operationKey, "run");
	const subArgs = { operationKey: subKey, command, timeoutMs: PREFLIGHT_TIMEOUT_MS };
	const childObservation = context.observation?.child("coding_run_command");
	const content = await operations.execute({
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
						timeoutMs: PREFLIGHT_TIMEOUT_MS,
					},
					receipt.signal,
				),
				receipt.receiptId,
				receipt.inputSha256,
			);
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
	if (content.kind !== "text") throw new Error("Coding command result differs");
	let receipt = parseCloudCodingCommandReceipt(JSON.parse(content.value));
	const deadline = Date.now() + PREFLIGHT_TIMEOUT_MS + timeoutGraceMs;
	let pollDelay = basePollMs;
	while (receipt.state === "running") {
		if (Date.now() >= deadline) {
			await cancelBestEffort(receipt.commandId);
			await checkAuthority(context);
			throw new CloudToolRefusal("Preflight land check timed out before completing.");
		}
		await cloudControlPause(Math.min(pollDelay, Math.max(1, deadline - Date.now())), context.signal);
		pollDelay = Math.min(maxPollMs, pollDelay * 2);
		receipt = checkedReceipt(
			await cloudToolRequest(
				(signal) =>
					gateway.read(
						scope,
						parseCloudCodingCommandRead({
							commandId: receipt.commandId,
							offset: 0,
							limit: CLOUD_CODING_COMMAND_PAGE_BYTES,
						}),
						signal,
					),
				context.signal,
			),
			receipt.commandId,
		);
		await checkAuthority(context);
	}
	if (receipt.state !== "succeeded") {
		await checkAuthority(context);
		throw new CloudToolRefusal(
			`Preflight land check did not succeed (state=${receipt.state}, exitCode=${receipt.exitCode ?? "unknown"}). Ensure git HEAD and main branch exist and try again.`,
		);
	}

	let rawOutput = receipt.log.offset === 0 ? receipt.output : "";
	let offset = receipt.log.offset === 0 ? receipt.log.nextOffset : 0;
	while (offset < receipt.log.totalBytes && rawOutput.length < MAX_PREFLIGHT_OUTPUT_BYTES) {
		const page = checkedReceipt(
			await cloudToolRequest(
				(signal) =>
					gateway.read(
						scope,
						parseCloudCodingCommandRead({
							commandId: receipt.commandId,
							offset,
							limit: CLOUD_CODING_COMMAND_PAGE_BYTES,
						}),
						signal,
					),
				context.signal,
			),
			receipt.commandId,
		);
		await checkAuthority(context);
		if (page.log.nextOffset <= offset) break;
		rawOutput += page.output;
		offset = page.log.nextOffset;
	}

	const decoded = decodePreflightLandOutput(rawOutput);
	if (!decoded) {
		await checkAuthority(context);
		throw new CloudToolRefusal("Preflight land check produced unreadable output.");
	}
	const readyToLand =
		decoded.mergeClean &&
		decoded.uncommittedChanges === 0 &&
		decoded.nameProblems.length === 0 &&
		decoded.largeFiles.length === 0;
	const reasons: string[] = [];
	if (decoded.uncommittedChanges > 0)
		reasons.push(`${decoded.uncommittedChanges} uncommitted change(s) in the worktree`);
	if (!decoded.mergeClean)
		reasons.push(`merge conflicts with ${decoded.baseRef} in ${decoded.conflictedPaths.length} file(s)`);
	if (decoded.nameProblems.length > 0) reasons.push(`${decoded.nameProblems.length} disallowed file name(s)`);
	if (decoded.largeFiles.length > 0) reasons.push(`${decoded.largeFiles.length} file(s) larger than 256 MiB`);
	const summary = readyToLand
		? `Ready to land on ${decoded.baseRef}: merge is clean, working tree is clean, and all file names and sizes pass.`
		: `Not ready to land: ${reasons.join("; ")}. Fix these before calling coding_finish.`;
	const resultText = redactCloudWebhookSecrets(
		cloudToolJsonText({
			schema: CODING_PREFLIGHT_LAND_SCHEMA,
			readyToLand,
			baseRef: decoded.baseRef,
			baseSha: decoded.baseSha,
			headSha: decoded.headSha,
			uncommittedChanges: decoded.uncommittedChanges,
			mergeClean: decoded.mergeClean,
			conflictedPaths: [...decoded.conflictedPaths],
			conflictMessages: [...decoded.conflictMessages],
			nameProblems: decoded.nameProblems as unknown as JsonValue,
			largeFiles: decoded.largeFiles as unknown as JsonValue,
			summary,
		}),
	);
	return { kind: "text", value: resultText };
}
