import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import {
	COMPANY_STATE_PARSER_VERSION,
	companyStatePath,
	parseCompanyStateFile,
} from "@qorpera/cloud-client/company-state-files";
import { companyPathKey } from "@qorpera/cloud-client/company-state-shared";
import { boundedObjectOperation, ObjectDependencyError } from "./dependency.ts";
import type { MemberCompanyAuthority } from "./member-company-authority.ts";
import type { MemberRequestObservationSpan } from "./member-observability.ts";
import { UUID } from "./native-objects.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import { type FolderWriterActor, type PlatformFileReference, PlatformFolderWriter } from "./platform-folder-writer.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

/*
 * A member's change to a folder-v2 company (deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §5, P34a):
 * `POST /v1/member-folder-commits/<environmentId>` with the member's own token. The database answers the member's own
 * actor for that token (`qorpera_member_folder_writer`); the gateway stages each file's bytes and commits the change set
 * as that actor with the service key, and the core checks the member's authority on every path, as for any member.
 * Each state file carries its parse from the shared parser, made from the bytes staged, or its problems, as the
 * runtime's commits do. A unit at or under human-tasks/ is refused until P31 delivers the wakes a person's save there
 * queues (H2c). Members share the platform's operation-key scope in the core, so the member's key is sent as
 * `member:<userId>:<key>`, a namespace the platform's writers never use. Every shape, size and the hold are checked
 * before any byte is staged, and a member has at most one change set in flight here. After a commit that saved
 * anything, the route asks the core to follow it up at once (F2's P15: a hire's grants, connectors and first run, an
 * archive's clean-up), one subject a call while it says there is more, as a best effort: the core's own step does
 * whatever is left within seconds.
 */

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UNITS = 16;
const MAX_CONTENTS = 64;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
/** Files staged one after another must fit the member gateway's 25 s; a hire sends two. */
const MAX_FILES = 32;
const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
/** Follow-up calls after one commit, the time they may take, and how late in the request they may still start: the
 * member gateway's bridge gives a request 25 s, and a saved commit's answer must reach the member inside it. */
const MAX_FOLLOW_UPS = 8;
const FOLLOW_UP_MS = 3_000;
const FOLLOW_UP_LATEST_MS = 20_000;
/** The members with a change set in flight on this gateway. */
const inFlight = new Set<string>();
const LONE_SURROGATE = /[\ud800-\udfff]/u;

export interface MemberFolderCommitOptions {
	readonly authority: Pick<MemberCompanyAuthority, "member" | "publisher">;
	/** The follow-up's own database client (its own circuit), so a failing follow-up never refuses members' commits.
	 * Without one there is no follow-up: the core's own step converges each commit within seconds. */
	readonly followUps?: Pick<MemberCompanyAuthority, "publisher">;
	readonly store: Pick<FileSystemObjectStore, "get">;
	readonly replication: Pick<ObjectGatewayReplication, "uploadWithAuthority">;
	readonly readFallback?: (profileId: string, sha256: string) => Promise<Uint8Array>;
	readonly observation?: MemberRequestObservationSpan;
}

/** A new folder's entry; a file keeps its whole stored path too (the folder's path joined with its own). */
type Content =
	| { readonly path: string; readonly kind: "folder" }
	| { readonly path: string; readonly whole: string; readonly kind: "file"; readonly text: string };

/** One unit as the member sends it, checked. */
type Unit =
	| { readonly op: "write"; readonly path: string; readonly text: string; readonly expectedVersion?: string }
	| { readonly op: "mkdir"; readonly path: string }
	| { readonly op: "new_folder"; readonly path: string; readonly contents: readonly Content[] }
	| { readonly op: "delete"; readonly path: string; readonly expectedVersion?: string; readonly asOfSeq?: number }
	| {
			readonly op: "move";
			readonly from: string;
			readonly to: string;
			readonly expectedVersion?: string;
			readonly asOfSeq?: number;
	  };

const invalid = (): never => {
	throw new ObjectDependencyError(400);
};

function object(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input);
	if (keys.some((key) => !required.includes(key) && !optional.includes(key))) invalid();
	if (required.some((key) => !Object.hasOwn(input, key))) invalid();
	return input;
}

function path(value: unknown): string {
	try {
		return parseCloudCompanyPath(value);
	} catch {
		return invalid();
	}
}

function text(value: unknown): string {
	if (typeof value !== "string" || LONE_SURROGATE.test(value)) return invalid();
	if (Buffer.byteLength(value) > MAX_FILE_BYTES) throw new ObjectDependencyError(413);
	return value;
}

function version(input: Record<string, unknown>): { expectedVersion?: string } {
	if (input.expectedVersion === undefined) return {};
	if (typeof input.expectedVersion !== "string" || !UUID.test(input.expectedVersion)) return invalid();
	return { expectedVersion: input.expectedVersion };
}

function asOf(input: Record<string, unknown>): { asOfSeq?: number } {
	if (input.asOfSeq === undefined) return {};
	if (!Number.isSafeInteger(input.asOfSeq) || (input.asOfSeq as number) < 0) return invalid();
	return { asOfSeq: input.asOfSeq as number };
}

function unit(value: unknown): Unit {
	const op = (value as { op?: unknown } | null)?.op;
	switch (op) {
		case "write": {
			const input = object(value, ["op", "path", "text"], ["expectedVersion"]);
			return { op, path: path(input.path), text: text(input.text), ...version(input) };
		}
		case "mkdir":
			return { op, path: path(object(value, ["op", "path"]).path) };
		case "new_folder": {
			const input = object(value, ["op", "path", "contents"]);
			if (!Array.isArray(input.contents) || input.contents.length > MAX_CONTENTS) return invalid();
			const folder = path(input.path);
			return {
				op,
				path: folder,
				contents: input.contents.map((item): Content => {
					const kind = (item as { kind?: unknown } | null)?.kind;
					// Each entry's joined path is checked here too, so a refusal never follows staged bytes.
					if (kind === "folder") {
						const inner = path(object(item, ["path", "kind"]).path);
						path(`${folder}/${inner}`);
						return { path: inner, kind };
					}
					if (kind !== "file") return invalid();
					const file = object(item, ["path", "kind", "text"]);
					const inner = path(file.path);
					return { path: inner, whole: path(`${folder}/${inner}`), kind, text: text(file.text) };
				}),
			};
		}
		case "delete": {
			const input = object(value, ["op", "path"], ["expectedVersion", "asOfSeq"]);
			return { op, path: path(input.path), ...version(input), ...asOf(input) };
		}
		case "move": {
			const input = object(value, ["op", "from", "to"], ["expectedVersion", "asOfSeq"]);
			return { op, from: path(input.from), to: path(input.to), ...version(input), ...asOf(input) };
		}
		default:
			return invalid();
	}
}

/** The member's request, checked: its operation key (the member's part) and units. */
export function memberFolderCommitRequest(value: unknown): { operationKey: string; units: Unit[] } {
	const input = object(value, ["schema", "operationKey", "units"]);
	if (input.schema !== "qorpera.member-folder-commit/v1") invalid();
	if (typeof input.operationKey !== "string" || !OPERATION_KEY.test(input.operationKey)) invalid();
	if (!Array.isArray(input.units) || input.units.length < 1 || input.units.length > MAX_UNITS) invalid();
	const units = (input.units as unknown[]).map(unit);
	let total = 0;
	let files = 0;
	for (const item of units) {
		if (item.op === "write") {
			total += Buffer.byteLength(item.text);
			files++;
		}
		if (item.op === "new_folder")
			for (const content of item.contents)
				if (content.kind === "file") {
					total += Buffer.byteLength(content.text);
					files++;
				}
	}
	if (total > MAX_TEXT_BYTES || files > MAX_FILES) throw new ObjectDependencyError(413);
	return { operationKey: input.operationKey as string, units };
}

/** A unit at or under human-tasks/: a person's save there queues a wake only P31 delivers (H2c), so it waits. */
export function memberFolderUnitHeld(item: Unit): boolean {
	const held = (value: string) => {
		const key = companyPathKey(value);
		return key === "human-tasks" || key.startsWith("human-tasks/");
	};
	return item.op === "move" ? held(item.from) || held(item.to) : held(item.path);
}

/** A state file's entry for the commit's hook, from the text being staged: its parse, or its problems. Null for any
 * other path (RUNTIME-COMPANY-STATE-FILES.md §8, as the runtime's `structured`). */
export function memberFolderStructured(filePath: string, fileText: string): Record<string, unknown> | null {
	const where = companyStatePath(filePath);
	if (!where) return null;
	const parsed = parseCompanyStateFile(filePath, fileText);
	if (!parsed) return null;
	return parsed.ok
		? {
				path: filePath,
				kind: where.kind,
				text: fileText,
				parse: parsed.file,
				parserVersion: COMPANY_STATE_PARSER_VERSION,
			}
		: { path: filePath, kind: where.kind, problems: parsed.problems };
}

const mediaType = (filePath: string) => (filePath.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain");

async function body(request: IncomingMessage, observation?: MemberRequestObservationSpan): Promise<unknown> {
	const length = request.headers["content-length"];
	if (!length || !/^[1-9][0-9]{0,6}$/.test(length) || request.headers["content-type"] !== "application/json")
		throw new ObjectDependencyError(400);
	if (Number(length) > MAX_BODY_BYTES) throw new ObjectDependencyError(413);
	return boundedObjectOperation(async () => {
		const chunks: Buffer[] = [];
		let count = 0;
		for await (const part of request) {
			const chunk = Buffer.from(part);
			count += chunk.length;
			observation?.update({ requestBodyBytes: count });
			if (count > Number(length)) throw new ObjectDependencyError(413);
			chunks.push(chunk);
		}
		if (count !== Number(length)) throw new ObjectDependencyError(400);
		try {
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
		} catch {
			throw new ObjectDependencyError(400);
		}
	});
}

type MemberActor = Extract<FolderWriterActor, { kind: "member" }>;

/** The writer check's answer: the member's own actor and the company. */
function writer(value: unknown): { actor: MemberActor; profileId: string } {
	const input = value as { schema?: unknown; actor?: unknown; profileId?: unknown } | null;
	const actor = input?.actor as { kind?: unknown; userId?: unknown } | null | undefined;
	if (
		!input ||
		typeof input !== "object" ||
		Object.keys(input).length !== 3 ||
		input.schema !== "qorpera.member-folder-writer/v1" ||
		typeof input.profileId !== "string" ||
		!UUID.test(input.profileId) ||
		!actor ||
		typeof actor !== "object" ||
		Object.keys(actor).length !== 2 ||
		actor.kind !== "member" ||
		typeof actor.userId !== "string" ||
		!UUID.test(actor.userId)
	)
		throw new ObjectDependencyError(403);
	return { actor: { kind: "member", userId: actor.userId }, profileId: input.profileId };
}

/** Asks the core to follow a saved commit up now (`qorpera_folder_follow_up_commit`, F2's P15): one subject a call,
 * again while it answers `more`. A best effort: any error, an unexpected answer, the call budget or the time budget ends
 * it, and the core's own step converges the rest. Before P15 the function does not exist and the first call fails. */
export async function followUpMemberCommit(
	authority: Pick<MemberCompanyAuthority, "publisher">,
	environmentId: string,
	commitId: string,
	signal: AbortSignal,
	timeMs = FOLLOW_UP_MS,
): Promise<number> {
	const budget = AbortSignal.any([signal, AbortSignal.timeout(timeMs)]);
	let calls = 0;
	try {
		while (calls < MAX_FOLLOW_UPS && !budget.aborted) {
			calls++;
			const answer = (await authority.publisher(
				"qorpera_folder_follow_up_commit",
				{ p_environment_id: environmentId, p_commit_id: commitId },
				budget,
			)) as { schema?: unknown; more?: unknown } | null;
			if (answer?.schema !== "qorpera.folder-follow-up/v1" || answer.more !== true) break;
		}
	} catch {
		/* Best effort: the core's own step follows the commit up. */
	}
	return calls;
}

export async function serveMemberFolderCommit(
	request: IncomingMessage,
	response: ServerResponse,
	options: MemberFolderCommitOptions,
): Promise<void> {
	const started = Date.now();
	if (request.method !== "POST") throw new ObjectDependencyError(405);
	const match = /^\/v1\/member-folder-commits\/([0-9a-f-]{36})$/.exec(request.url ?? "");
	if (!match || !UUID.test(match[1]!)) throw new ObjectDependencyError(404);
	const header = request.headers.authorization;
	if (!header || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header)) throw new ObjectDependencyError(401);
	const token = header.slice(7);
	const environmentId = match[1]!;
	const observation = options.observation;
	observation?.operation("command_submit");
	const { operationKey, units } = memberFolderCommitRequest(await body(request, observation));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new ObjectDependencyError(503)), 30_000);
	const signal = controller.signal;
	let held: string | undefined;
	try {
		const member = writer(
			await options.authority.member(
				"qorpera_member_folder_writer",
				token,
				{ p_environment_id: environmentId },
				signal,
			),
		);
		observation?.update({ companyId: member.profileId, environmentId });
		if (units.some(memberFolderUnitHeld)) throw new ObjectDependencyError(403);
		if (inFlight.has(member.actor.userId)) throw new ObjectDependencyError(429);
		inFlight.add(member.actor.userId);
		held = member.actor.userId;
		const folder = new PlatformFolderWriter({
			authority: options.authority,
			store: options.store,
			replication: options.replication,
			actor: member.actor,
			...(options.readFallback ? { readFallback: options.readFallback } : {}),
		});
		const stage = (filePath: string, fileText: string): Promise<PlatformFileReference> =>
			folder.stage(
				environmentId,
				new TextEncoder().encode(fileText),
				{ mediaType: mediaType(filePath), executable: false },
				signal,
			);
		const sent: Record<string, unknown>[] = [];
		for (const item of units) {
			switch (item.op) {
				case "write": {
					const entry = memberFolderStructured(item.path, item.text);
					sent.push({
						op: "write",
						path: item.path,
						...(item.expectedVersion ? { expectedVersion: item.expectedVersion } : {}),
						file: await stage(item.path, item.text),
						...(entry ? { structured: [entry] } : {}),
					});
					break;
				}
				case "new_folder": {
					const contents: Record<string, unknown>[] = [];
					const entries: Record<string, unknown>[] = [];
					for (const content of item.contents) {
						if (content.kind === "folder") {
							contents.push({ path: content.path, kind: "folder" });
							continue;
						}
						contents.push({ path: content.path, kind: "file", file: await stage(content.whole, content.text) });
						const entry = memberFolderStructured(content.whole, content.text);
						if (entry) entries.push(entry);
					}
					sent.push({
						op: "new_folder",
						path: item.path,
						contents,
						...(entries.length ? { structured: entries } : {}),
					});
					break;
				}
				default:
					sent.push({ ...item });
			}
		}
		const answer = (await folder.commit(
			environmentId,
			`member:${member.actor.userId}:${operationKey}`,
			sent,
			signal,
		)) as {
			schema?: unknown;
			commitId?: unknown;
			seq?: unknown;
			units?: unknown;
		} | null;
		if (answer?.schema !== "qorpera.folder-commit/v1" || !Array.isArray(answer.units))
			throw new ObjectDependencyError(503);
		// Something was saved (a replay of a saved change set too): what it starts, a hire's first run or an archive's
		// clean-up, is done before the answer, while the request has time left. The member's slot is free meanwhile.
		inFlight.delete(member.actor.userId);
		held = undefined;
		const left = FOLLOW_UP_LATEST_MS - (Date.now() - started);
		if (
			options.followUps &&
			left > 0 &&
			Number.isSafeInteger(answer.seq) &&
			typeof answer.commitId === "string" &&
			UUID.test(answer.commitId)
		)
			await followUpMemberCommit(
				options.followUps,
				environmentId,
				answer.commitId,
				signal,
				Math.min(FOLLOW_UP_MS, left),
			);
		const encoded = JSON.stringify(answer);
		observation?.update({ responseBodyBytes: Buffer.byteLength(encoded) });
		response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
		response.end(encoded);
	} finally {
		clearTimeout(timer);
		if (held) inFlight.delete(held);
	}
}
