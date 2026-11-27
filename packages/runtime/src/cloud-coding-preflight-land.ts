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
export const CODING_FINISH_CONFLICT_SCHEMA = "qorpera.coding-finish-conflict/v1";

const PREFLIGHT_TIMEOUT_MS = 30_000;
const FINISH_PREFLIGHT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 250;
const FINISH_PREFLIGHT_POLL_MS = 50;
const MAX_POLL_MS = 1000;
const FINISH_PREFLIGHT_MAX_POLL_MS = 500;
const DEFAULT_TIMEOUT_GRACE_MS = 5000;
const CANCEL_ON_ABORT_MS = 5000;
const MAX_PREFLIGHT_OUTPUT_BYTES = 128 * 1024;
const PAYLOAD_PREFIX = "QORPERA_PREFLIGHT_LAND:";
const FINISH_PAYLOAD_PREFIX = "QORPERA_FINISH_PREFLIGHT:";
const SHA40 = /^[0-9a-f]{40}$/;
const CODE_FOLDER_KEY_BYTES = 2600;
const CODE_FOLDER_ANY_SESSION = "worktrees/00000000-0000-0000-0000-000000000000";
// WHY: Reserve worst-case code/<39-byte owner>/<100-byte name>/worktrees/<36-byte uuid>/ prefix when repositoryArea is omitted.
const MAX_DEFAULT_WORKTREE_PREFIX_BYTES = 5 + 39 + 1 + 100 + 1 + CODE_FOLDER_ANY_SESSION.length + 1;

function maxPreflightPathBytes(repositoryArea?: string): number {
	const prefixBytes =
		typeof repositoryArea === "string" && repositoryArea.length > 0
			? Buffer.byteLength(`${repositoryArea}/${CODE_FOLDER_ANY_SESSION}/`, "utf8")
			: MAX_DEFAULT_WORKTREE_PREFIX_BYTES;
	return Math.max(0, CODE_FOLDER_KEY_BYTES - prefixBytes);
}

function buildPreflightLandScript(maxKeyBytes: number): string {
	return [
		'const cp=require("node:child_process"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");',
		'const git=(args,gitDir)=>cp.spawnSync("git",gitDir?["--git-dir="+gitDir,...args]:args,{maxBuffer:64*1024*1024});',
		"const shaRe=/^[0-9a-f]{40}$/;",
		`const maxKeyBytes=${maxKeyBytes};`,
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
		"const nameProblems=[],largeFiles=[],seenCase=new Map(),folderRefusedTrees=new Set();",
		"let off=0;const buf=ls.stdout;",
		"while(off<buf.length){const end=buf.indexOf(0,off);if(end<0)break;",
		"const rec=buf.subarray(off,end);off=end+1;const tab=rec.indexOf(9);if(tab<0)continue;",
		'const hdr=rec.subarray(0,tab).toString("latin1").split(/ +/);if(hdr.length!==4)continue;',
		"const type=hdr[1],size=Number(hdr[3]),raw=rec.subarray(tab+1);",
		'const p=raw.toString("utf8");',
		'if(!Buffer.from(p,"utf8").equals(raw)){if(nameProblems.length<20)nameProblems.push({code:"CODE_HOST_NAMES_NOT_UTF8",path:p});continue;}',
		'if(p.normalize("NFC")!==p&&nameProblems.length<20)nameProblems.push({code:"CODE_HOST_NAMES_NOT_NFC",path:p});',
		'if(type==="blob"&&size>268435456&&largeFiles.length<20)largeFiles.push({path:p,bytes:size});',
		'const slash=p.lastIndexOf("/"),dir=p.slice(0,slash+1),parent=slash>=0?p.slice(0,slash):"",base=p.slice(slash+1),key=dir+"\\0"+base.toLowerCase();',
		'const prev=seenCase.get(key);if(prev!==undefined&&prev!==p&&nameProblems.length<20)nameProblems.push({code:"CODE_HOST_NAMES_DIFFER_BY_CASE",path:p});else seenCase.set(key,p);',
		'if(parent&&folderRefusedTrees.has(parent)){if(type==="tree")folderRefusedTrees.add(p);continue;}',
		'const segs=p.split("/");',
		'const folded=p.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");',
		'const foldedSegs=folded.split("/");',
		'if(Buffer.byteLength(p)>maxKeyBytes||Buffer.byteLength(folded)>maxKeyBytes||foldedSegs.length!==segs.length||[segs,foldedSegs].some((parts)=>parts.some((s)=>!s||s==="."||s===".."||/[\\\\\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]/.test(s)||s.endsWith(".")||s.endsWith(" ")))||segs.some((s)=>Buffer.byteLength(s)>255)){',
		'if(nameProblems.length<20)nameProblems.push({code:"CODE_HOST_NAMES_FOLDER_REFUSES",path:p});if(type==="tree")folderRefusedTrees.add(p);}}',
		'process.stdout.write("QORPERA_PREFLIGHT_LAND:"+JSON.stringify({baseRef,baseSha,headSha,uncommittedChanges,mergeClean,conflictedPaths,conflictMessages,nameProblems,largeFiles})+"\\n");',
		"}finally{fs.rmSync(tmp,{recursive:true,force:true});}",
	].join("");
}

export interface CodingPreflightLandRequest {
	readonly operationKey: string;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildPreflightLandCommand(repositoryArea?: string): string {
	const script = buildPreflightLandScript(maxPreflightPathBytes(repositoryArea));
	return `if [ -x /usr/bin/node ]; then NODE_BIN=/usr/bin/node; else NODE_BIN=node; fi; NODE_OPTIONS= "$NODE_BIN" -e ${shellQuote(script)} 2>/dev/null`;
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
	repositoryArea?: string;
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

	const command = buildPreflightLandCommand(options.repositoryArea);
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

function buildFinishConflictPreflightScript(baseBranch: string, headSha: string): string {
	return [
		'const cp=require("node:child_process"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");',
		'const git=(args,gitDir)=>cp.spawnSync("git",gitDir?["--git-dir="+gitDir,...args]:args,{maxBuffer:64*1024*1024});',
		"const shaRe=/^[0-9a-f]{40}$/;",
		`const baseBranch=${JSON.stringify(baseBranch)};`,
		`const headSha=${JSON.stringify(headSha)};`,
		'const emit=(obj)=>process.stdout.write("QORPERA_FINISH_PREFLIGHT:"+JSON.stringify(obj)+"\\n");',
		'const headRes=git(["rev-parse","--verify","--quiet",headSha+"^{commit}"]);',
		"if(headRes.status!==0){emit({mergeClean:true,baseSha:headSha,headSha,conflictedPaths:[],conflictMessages:[]});process.exit(0);}",
		'let baseSha="";',
		'for(const ref of ["refs/heads/"+baseBranch,"refs/remotes/origin/"+baseBranch]){',
		'const r=git(["rev-parse","--verify","--quiet",ref+"^{commit}"]);',
		'if(r.status===0){const s=r.stdout.toString("utf8").trim();if(shaRe.test(s)){baseSha=s;break;}}}',
		"if(!baseSha||baseSha===headSha){emit({mergeClean:true,baseSha:baseSha||headSha,headSha,conflictedPaths:[],conflictMessages:[]});process.exit(0);}",
		'if(git(["merge-base","--is-ancestor",baseSha,headSha]).status===0||git(["merge-base","--is-ancestor",headSha,baseSha]).status===0){emit({mergeClean:true,baseSha,headSha,conflictedPaths:[],conflictMessages:[]});process.exit(0);}',
		'const commonRes=git(["rev-parse","--git-common-dir"]);',
		"if(commonRes.status!==0)process.exit(44);",
		'const commonDir=path.resolve(commonRes.stdout.toString("utf8").trim());',
		'const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"qorpera-finish-preflight-"));',
		"try{",
		'const scratch=path.join(tmp,"scratch.git");',
		'const initRes=git(["init","--quiet","--bare","--template=",scratch]);',
		"if(initRes.status!==0)process.exit(44);",
		'fs.writeFileSync(path.join(scratch,"objects","info","alternates"),path.join(commonDir,"objects")+"\\n");',
		'const mt=git(["merge-tree","--write-tree","-z","--name-only","--messages",baseSha,headSha],scratch);',
		"if(mt.status===0){emit({mergeClean:true,baseSha,headSha,conflictedPaths:[],conflictMessages:[]});}",
		"else if(mt.status===1){",
		'const f=mt.stdout.toString("utf8").split("\\0");const pset=new Set();let i=1;',
		'while(i<f.length&&f[i]!==""){pset.add(f[i]);i++;}i++;',
		"const mset=new Set(),conflictMessages=[];let mb=0;",
		'while(i<f.length&&f[i]!==""){const cnt=Number(f[i]);if(!Number.isSafeInteger(cnt)||cnt<0||i+cnt+2>=f.length)break;',
		'const t=f[i+cnt+1]||"",m=f[i+cnt+2]||"";i+=cnt+3;',
		'if(!t.startsWith("CONFLICT")&&!m.includes("CONFLICT"))continue;',
		'const c=m.replace(/[\\r\\n\\t]+/g," ").replace(/[\\x00-\\x1f\\x7f]/g,"").trim().slice(0,300);',
		"if(!c||mset.has(c))continue;if(conflictMessages.length>=20||mb+Buffer.byteLength(c)>2048)break;",
		"mset.add(c);conflictMessages.push(c);mb+=Buffer.byteLength(c);}",
		"const conflictedPaths=[...pset].slice(0,50);",
		"emit({mergeClean:false,baseSha,headSha,conflictedPaths,conflictMessages});",
		"}else{process.exit(45);}",
		"}finally{fs.rmSync(tmp,{recursive:true,force:true});}",
	].join("");
}

export function buildFinishConflictPreflightCommand(baseBranch: string, headSha: string): string {
	if (!baseBranch.trim() || !SHA40.test(headSha)) throw new Error("Invalid finish preflight arguments");
	const script = buildFinishConflictPreflightScript(baseBranch, headSha);
	return `if [ -x /usr/bin/node ]; then NODE_BIN=/usr/bin/node; else NODE_BIN=node; fi; NODE_OPTIONS= "$NODE_BIN" -e ${shellQuote(script)} 2>/dev/null`;
}

export interface CodingFinishConflictPreflightDecoded {
	readonly mergeClean: boolean;
	readonly baseSha: string;
	readonly headSha: string;
	readonly conflictedPaths: readonly string[];
	readonly conflictMessages: readonly string[];
}

export function decodeFinishConflictPreflightOutput(rawOutput: string): CodingFinishConflictPreflightDecoded | null {
	const line = rawOutput.split(/\r?\n/).find((entry) => entry.startsWith(FINISH_PAYLOAD_PREFIX));
	if (!line) return null;
	try {
		const parsed = JSON.parse(line.slice(FINISH_PAYLOAD_PREFIX.length)) as Record<string, unknown>;
		if (
			typeof parsed.mergeClean !== "boolean" ||
			typeof parsed.baseSha !== "string" ||
			typeof parsed.headSha !== "string" ||
			!Array.isArray(parsed.conflictedPaths) ||
			!Array.isArray(parsed.conflictMessages)
		)
			return null;
		return {
			mergeClean: parsed.mergeClean,
			baseSha: parsed.baseSha,
			headSha: parsed.headSha,
			conflictedPaths: parsed.conflictedPaths.filter((p): p is string => typeof p === "string"),
			conflictMessages: parsed.conflictMessages.filter((m): m is string => typeof m === "string"),
		};
	} catch {
		return null;
	}
}

export type CodingFinishConflictPreflightResult =
	| { readonly conflicted: false }
	| {
			readonly conflicted: true;
			readonly baseBranch: string;
			readonly baseSha: string;
			readonly headSha: string;
			readonly conflictedPaths: readonly string[];
			readonly conflictMessages: readonly string[];
	  };

function formatConflictPaths(paths: readonly string[]): string {
	const shown: string[] = [];
	let used = 0;
	for (const path of paths.slice(0, 20)) {
		const quoted = JSON.stringify(path);
		const size = Buffer.byteLength(quoted) + 2;
		if (used + size > 1500) break;
		shown.push(quoted);
		used += size;
	}
	const more = paths.length - shown.length;
	if (!shown.length) return more ? `${more} path${more === 1 ? "" : "s"}` : "";
	return `${shown.join(", ")}${more ? ` and ${more} more` : ""}`;
}

export function formatCodingFinishConflictFeedback(
	conflict: Extract<CodingFinishConflictPreflightResult, { readonly conflicted: true }>,
): string {
	const named = formatConflictPaths(conflict.conflictedPaths);
	const details =
		conflict.conflictMessages.length > 0
			? ` Conflict details: ${conflict.conflictMessages.join("; ").slice(0, 1200)}.`
			: "";
	const summary = `Cannot finish yet: ${conflict.headSha.slice(0, 12)} conflicts with ${conflict.baseBranch}${named ? ` in ${named}` : ""}.${details} Run \`git merge ${conflict.baseBranch}\` on this session's branch, resolve the conflicts, re-run the checks, commit, and call coding_finish again with a new operationKey and the new headSha.`;
	return redactCloudWebhookSecrets(
		cloudToolJsonText({
			schema: CODING_FINISH_CONFLICT_SCHEMA,
			state: "conflict",
			baseBranch: conflict.baseBranch,
			baseSha: conflict.baseSha,
			headSha: conflict.headSha,
			conflictedPaths: [...conflict.conflictedPaths],
			conflictMessages: [...conflict.conflictMessages],
			summary,
		}),
	);
}

const FINISH_PREFLIGHT_FATAL_ERRORS = new Set([
	"CODING_TURN_AUTHORITY_CHANGED",
	"CODING_COMMAND_AFTER_SUBMISSION",
	"CODING_COMMAND_SCOPE_DIFFERS",
	"CODING_SUBMISSION_IDENTITY_DIFFERS",
]);

export async function runCodingFinishConflictPreflight(options: {
	scope: CloudCodingCommandScope;
	operations: Pick<CloudNativeToolOperations, "execute">;
	gateway: CloudCodingCommandGateway;
	checkAuthority: (context: CloudToolContext) => Promise<void>;
	baseBranch: string;
	headSha: string;
	operationKey: string;
	context: CloudToolContext;
	pollMs?: number;
	timeoutMs?: number;
}): Promise<CodingFinishConflictPreflightResult> {
	const { scope, operations, gateway, checkAuthority, baseBranch, headSha, operationKey, context } = options;
	const target = { schema: "qorpera.coding-command-target/v1", ...scope };
	const timeoutMs = options.timeoutMs ?? FINISH_PREFLIGHT_TIMEOUT_MS;
	const basePollMs = options.pollMs ?? FINISH_PREFLIGHT_POLL_MS;
	const maxPollMs = Math.max(basePollMs, Math.min(FINISH_PREFLIGHT_MAX_POLL_MS, basePollMs * 4));
	const command = buildFinishConflictPreflightCommand(baseBranch, headSha);
	const subKey = preflightSubOperationKey(`${operationKey}:${headSha}`, "finish-conflict");
	const subArgs = { operationKey: subKey, command, timeoutMs };

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

	try {
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
				const started = parseCloudCodingCommandReceipt(
					await gateway.start(
						scope,
						{
							commandId: receipt.receiptId,
							inputSha256: receipt.inputSha256,
							command,
							timeoutMs,
						},
						receipt.signal,
					),
				);
				if (
					started.workerId !== scope.workerId ||
					started.commandId !== receipt.receiptId ||
					started.inputSha256 !== receipt.inputSha256
				)
					throw new Error("Coding command result differs");
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
		if (content.kind !== "text") return { conflicted: false };
		let receipt = parseCloudCodingCommandReceipt(JSON.parse(content.value));
		const deadline = Date.now() + timeoutMs + DEFAULT_TIMEOUT_GRACE_MS;
		let pollDelay = basePollMs;
		while (receipt.state === "running") {
			if (Date.now() >= deadline) {
				await cancelBestEffort(receipt.commandId);
				return { conflicted: false };
			}
			await cloudControlPause(Math.min(pollDelay, Math.max(1, deadline - Date.now())), context.signal);
			pollDelay = Math.min(maxPollMs, pollDelay * 2);
			receipt = parseCloudCodingCommandReceipt(
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
			);
			await checkAuthority(context);
		}
		if (receipt.state !== "succeeded") return { conflicted: false };
		let rawOutput = receipt.log.offset === 0 ? receipt.output : "";
		let offset = receipt.log.offset === 0 ? receipt.log.nextOffset : 0;
		while (offset < receipt.log.totalBytes && rawOutput.length < MAX_PREFLIGHT_OUTPUT_BYTES) {
			const page = parseCloudCodingCommandReceipt(
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
			);
			await checkAuthority(context);
			if (page.log.nextOffset <= offset) break;
			rawOutput += page.output;
			offset = page.log.nextOffset;
		}
		const decoded = decodeFinishConflictPreflightOutput(rawOutput);
		if (!decoded || decoded.mergeClean) return { conflicted: false };
		if (decoded.conflictedPaths.length === 0 && decoded.conflictMessages.length === 0) return { conflicted: false };
		return {
			conflicted: true,
			baseBranch,
			baseSha: decoded.baseSha,
			headSha: decoded.headSha,
			conflictedPaths: decoded.conflictedPaths,
			conflictMessages: decoded.conflictMessages,
		};
	} catch (error) {
		if (context.signal.aborted) throw error;
		if (error instanceof Error && FINISH_PREFLIGHT_FATAL_ERRORS.has(error.message)) throw error;
		// WHY: Fail open on preflight transport/environment errors so the authoritative code-host landing check still governs submission.
		return { conflicted: false };
	}
}

const CHANGE_DIFF_TIMEOUT_MS = 15_000;
const CHANGE_DIFF_MAX_OUTPUT_BYTES = 256 * 1024;
const CHANGE_DIFF_MAX_PATHS = 500;
const CHANGE_DIFF_MAX_PATH_CHARS = 512;
const CHANGE_DIFF_MARKER = "__QORPERA_CHANGE_DIFF_V1__";
const CHANGE_DIFF_SHA_RE = /^[0-9a-f]{40}$/;

export interface CodingChangeDiffSummary {
	readonly affectedPaths: readonly string[];
	readonly diffStats: {
		readonly filesChanged: number;
		readonly additions: number;
		readonly deletions: number;
	};
}

export function parseGitNumstatZ(raw: string): CodingChangeDiffSummary | null {
	if (!raw) {
		return {
			affectedPaths: [],
			diffStats: { filesChanged: 0, additions: 0, deletions: 0 },
		};
	}
	const entries = raw.split("\0").filter(Boolean);
	const allPaths: string[] = [];
	let additions = 0;
	let deletions = 0;
	for (const entry of entries) {
		const parts = entry.split("\t");
		if (parts.length < 3) continue;
		const add = Number.parseInt(parts[0] ?? "0", 10);
		const del = Number.parseInt(parts[1] ?? "0", 10);
		if (Number.isFinite(add) && add > 0) additions += add;
		if (Number.isFinite(del) && del > 0) deletions += del;
		const filePath = parts.slice(2).join("\t");
		if (filePath) allPaths.push(filePath);
	}
	return {
		affectedPaths: allPaths.slice(0, CHANGE_DIFF_MAX_PATHS).map((p) => p.slice(0, CHANGE_DIFF_MAX_PATH_CHARS)),
		diffStats: { filesChanged: allPaths.length, additions, deletions },
	};
}

export function decodeChangeDiffOutput(output: string): CodingChangeDiffSummary | null {
	const prefix = `${CHANGE_DIFF_MARKER}:`;
	const index = output.indexOf(prefix);
	if (index < 0) return null;
	const encoded = output
		.slice(index + prefix.length)
		.split(/\r?\n/, 1)[0]
		?.trim();
	if (encoded === undefined) return null;
	if (!encoded) {
		return {
			affectedPaths: [],
			diffStats: { filesChanged: 0, additions: 0, deletions: 0 },
		};
	}
	try {
		const raw = Buffer.from(encoded, "base64").toString("utf8");
		return parseGitNumstatZ(raw);
	} catch {
		return null;
	}
}

export async function inspectCodingChangeDiff(options: {
	scope: CloudCodingCommandScope;
	operations: Pick<CloudNativeToolOperations, "execute">;
	gateway: CloudCodingCommandGateway;
	checkAuthority: (context: CloudToolContext) => Promise<void>;
	parentSha: string;
	commitSha: string;
	context: CloudToolContext;
	pollMs?: number;
	timeoutMs?: number;
}): Promise<CodingChangeDiffSummary | null> {
	const { scope, operations, gateway, checkAuthority, parentSha, commitSha, context } = options;
	if (!CHANGE_DIFF_SHA_RE.test(parentSha) || !CHANGE_DIFF_SHA_RE.test(commitSha) || parentSha === commitSha) {
		return null;
	}
	const target = { schema: "qorpera.coding-command-target/v1", ...scope };
	const timeoutMs = options.timeoutMs ?? CHANGE_DIFF_TIMEOUT_MS;
	const basePollMs = options.pollMs ?? FINISH_PREFLIGHT_POLL_MS;
	const maxPollMs = Math.max(basePollMs, Math.min(FINISH_PREFLIGHT_MAX_POLL_MS, basePollMs * 4));
	const command = `set -o pipefail; git rev-parse --verify -q ${parentSha}^{commit} >/dev/null && git rev-parse --verify -q ${commitSha}^{commit} >/dev/null && out="$(git diff --numstat --no-renames -z ${parentSha} ${commitSha} | base64 | tr -d '\\r\\n')" && printf '${CHANGE_DIFF_MARKER}:%s\\n' "$out"`;
	const subKey = preflightSubOperationKey(`${parentSha}:${commitSha}`, "change-diff");
	const subArgs = { operationKey: subKey, command, timeoutMs };

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

	try {
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
				const started = parseCloudCodingCommandReceipt(
					await gateway.start(
						scope,
						{
							commandId: receipt.receiptId,
							inputSha256: receipt.inputSha256,
							command,
							timeoutMs,
						},
						receipt.signal,
					),
				);
				if (
					started.workerId !== scope.workerId ||
					started.commandId !== receipt.receiptId ||
					started.inputSha256 !== receipt.inputSha256
				) {
					throw new Error("Coding command result differs");
				}
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
		if (content.kind !== "text") return null;
		let receipt = parseCloudCodingCommandReceipt(JSON.parse(content.value));
		const deadline = Date.now() + timeoutMs + DEFAULT_TIMEOUT_GRACE_MS;
		let pollDelay = basePollMs;
		while (receipt.state === "running") {
			if (Date.now() >= deadline) {
				await cancelBestEffort(receipt.commandId);
				return null;
			}
			await cloudControlPause(Math.min(pollDelay, Math.max(1, deadline - Date.now())), context.signal);
			pollDelay = Math.min(maxPollMs, pollDelay * 2);
			receipt = parseCloudCodingCommandReceipt(
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
			);
			await checkAuthority(context);
		}
		if (receipt.state !== "succeeded") return null;
		let rawOutput = receipt.log.offset === 0 ? receipt.output : "";
		let offset = receipt.log.offset === 0 ? receipt.log.nextOffset : 0;
		while (offset < receipt.log.totalBytes && rawOutput.length < CHANGE_DIFF_MAX_OUTPUT_BYTES) {
			const page = parseCloudCodingCommandReceipt(
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
			);
			await checkAuthority(context);
			if (page.log.nextOffset <= offset) break;
			rawOutput += page.output;
			offset = page.log.nextOffset;
		}
		return decodeChangeDiffOutput(rawOutput);
	} catch (error) {
		if (context.signal.aborted) throw error;
		if (error instanceof Error && FINISH_PREFLIGHT_FATAL_ERRORS.has(error.message)) throw error;
		return null;
	}
}
