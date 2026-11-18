import { createHash, type Hash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { programUploadPath } from "@qorpera/cloud-client/app-program";
import { parseCloudMemberFolderRead } from "@qorpera/cloud-client/cloud-member-folder";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { appMediaType } from "@qorpera/cloud-client/interface-apps";
import { boundedObjectOperation, ObjectDependencyError } from "./dependency.ts";
import type { MemberCompanyAuthority, MemberCompanyPublisherRpc } from "./member-company-authority.ts";
import { memberFolderWriter } from "./member-folder-commits.ts";
import type { MemberRequestObservationSpan } from "./member-observability.ts";
import { UUID } from "./native-objects.ts";
import { contentHash } from "./platform-folder-writer.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

const PIECE_BYTES = 4 * 1024 * 1024;
const MAX_PIECES = 64;
export const MEMBER_PROGRAM_MAX_BYTES = PIECE_BYTES * MAX_PIECES;
const MAX_REQUEST_BYTES = 16 * 1024;
const HELD_AHEAD = 4;
const IDLE_MS = 60_000;
const RENEW_MS = 10 * 60_000;
const ALIVE_MS = 13 * 60_000;
const REQUEST_MS = 30_000;
const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PATH =
	/^\/v1\/member-program-uploads\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36})(?:\/(0|[1-9]|[1-5][0-9]|6[0-3]|stop))?)?$/;

export interface MemberProgramUploadOptions {
	readonly authority: Pick<MemberCompanyAuthority, "member" | "publisher">;
	readonly replication: Pick<ObjectGatewayReplication, "uploadWithAuthority">;
	readonly observation?: MemberRequestObservationSpan;
	readonly now?: () => number;
}

interface Upload {
	readonly id: string;
	readonly userId: string;
	readonly environmentId: string;
	readonly path: string;
	readonly bytes: number;
	readonly fileSha256: string;
	readonly pieces: readonly string[];
	readonly mediaType: string;
	readonly manifestSha256: string;
	readonly present: ReadonlySet<string>;
	readonly hash: Hash;
	readonly held: Map<number, Uint8Array>;
	next: number;
	digest: string | null;
	touched: number;
	renewed: number;
	finished: boolean;
	finishing: number;
}

type Publish = (
	method: Extract<
		MemberCompanyPublisherRpc,
		| "qorpera_folder_open_upload"
		| "qorpera_folder_authorize_object_upload"
		| "qorpera_folder_confirm_object"
		| "qorpera_folder_renew_upload"
		| "qorpera_folder_seal_upload"
	>,
	args: Record<string, unknown>,
) => Promise<unknown>;

const uploads = new Map<string, Upload>();
let clock: () => number = Date.now;
let sweeping: ReturnType<typeof setInterval> | undefined;

function drop(userId: string): void {
	uploads.get(userId)?.held.clear();
	uploads.delete(userId);
}

function sweep(now: number): void {
	for (const [user, upload] of uploads) if (now - upload.touched > IDLE_MS) drop(user);
}

export function forgetMemberProgramUploads(): void {
	for (const user of [...uploads.keys()]) drop(user);
	clearInterval(sweeping);
	sweeping = undefined;
}

const invalid = (): never => {
	throw new ObjectDependencyError(400);
};

const pieceBytes = (bytes: number, count: number, index: number) =>
	index < count - 1 ? PIECE_BYTES : bytes - PIECE_BYTES * (count - 1);

function manifestText(fileSha256: string, bytes: number, mediaType: string, pieces: readonly string[]): string {
	return JSON.stringify({
		schema: "qorpera.cloud-file-manifest/v2",
		fileSha256,
		bytes,
		mediaType,
		executable: false,
		chunks: pieces.map((hash, index) => ({ sha256: hash, bytes: pieceBytes(bytes, pieces.length, index) })),
	});
}

export function memberProgramUploadRequest(value: unknown): {
	path: string;
	bytes: number;
	fileSha256: string;
	pieces: string[];
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	const input = value as Record<string, unknown>;
	const keys = ["schema", "path", "bytes", "fileSha256", "pieces"];
	if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) invalid();
	if (input.schema !== "qorpera.member-program-upload/v1") invalid();
	let path: string;
	try {
		path = parseCloudCompanyPath(input.path);
	} catch {
		return invalid();
	}
	if (programUploadPath(path) === null) throw new ObjectDependencyError(403);
	if (!Number.isSafeInteger(input.bytes) || (input.bytes as number) < 1) invalid();
	const bytes = input.bytes as number;
	if (bytes > MEMBER_PROGRAM_MAX_BYTES) throw new ObjectDependencyError(413);
	if (typeof input.fileSha256 !== "string" || !SHA256.test(input.fileSha256)) invalid();
	if (
		!Array.isArray(input.pieces) ||
		input.pieces.length !== Math.ceil(bytes / PIECE_BYTES) ||
		input.pieces.some((hash) => typeof hash !== "string" || !SHA256.test(hash))
	)
		invalid();
	return { path, bytes, fileSha256: input.fileSha256 as string, pieces: input.pieces as string[] };
}

export function memberProgramFolders(path: string): { op: "mkdir"; path: string }[] {
	const parts = path.split("/");
	return [1, 2, 3, 4].map((depth) => ({ op: "mkdir", path: parts.slice(0, depth).join("/") }));
}

function finishKey(value: unknown): string {
	const input = value as Record<string, unknown> | null;
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.keys(input).length !== 2 ||
		input.schema !== "qorpera.member-program-finish/v1" ||
		typeof input.operationKey !== "string" ||
		!OPERATION_KEY.test(input.operationKey)
	)
		return invalid();
	return input.operationKey;
}

function body(request: IncomingMessage, size: number): Promise<Uint8Array> {
	return boundedObjectOperation(async () => {
		const chunks: Buffer[] = [];
		let count = 0;
		for await (const part of request) {
			const chunk = Buffer.from(part);
			count += chunk.length;
			if (count > size) throw new ObjectDependencyError(413);
			chunks.push(chunk);
		}
		if (count !== size) throw new ObjectDependencyError(400);
		return Buffer.concat(chunks);
	}, REQUEST_MS);
}

async function json(request: IncomingMessage, observation?: MemberRequestObservationSpan): Promise<unknown> {
	const length = request.headers["content-length"];
	if (!length || !/^[1-9][0-9]{0,5}$/.test(length) || request.headers["content-type"] !== "application/json")
		throw new ObjectDependencyError(400);
	if (Number(length) > MAX_REQUEST_BYTES) throw new ObjectDependencyError(413);
	const bytes = await body(request, Number(length));
	observation?.update({ requestBodyBytes: bytes.byteLength });
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new ObjectDependencyError(400);
	}
}

function send(response: ServerResponse, status: number, value: unknown): string {
	const encoded = JSON.stringify(value);
	response.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" });
	response.end(encoded);
	return encoded;
}

function schema(value: unknown, expected: string): Record<string, unknown> {
	const item = value as Record<string, unknown> | null;
	if (!item || typeof item !== "object" || Array.isArray(item) || item.schema !== expected)
		throw new ObjectDependencyError(503);
	return item;
}

async function put(
	upload: Upload,
	hash: string,
	bytes: Uint8Array,
	publish: Publish,
	options: MemberProgramUploadOptions,
) {
	const args = { p_intent: upload.id, p_sha256: hash, p_bytes: bytes.byteLength };
	const authorize = async () => {
		const answer = schema(
			await publish("qorpera_folder_authorize_object_upload", args),
			"qorpera.folder-object-upload/v1",
		);
		if (typeof answer.profileId !== "string" || !UUID.test(answer.profileId)) throw new ObjectDependencyError(403);
		return answer.profileId;
	};
	const profileId = await authorize();
	await options.replication.uploadWithAuthority(profileId, hash, bytes, {
		authorize: async () => {
			if ((await authorize()) !== profileId) throw new ObjectDependencyError(403);
		},
		confirm: async () => {
			const confirmed = schema(await publish("qorpera_folder_confirm_object", args), "qorpera.folder-object/v1");
			if (confirmed.sha256 !== hash || confirmed.bytes !== bytes.byteLength) throw new ObjectDependencyError(403);
		},
	});
}

const received = (upload: Upload) =>
	[...Array.from({ length: upload.next }, (_, index) => index), ...upload.held.keys()].sort((a, b) => a - b);

async function open(
	response: ServerResponse,
	userId: string,
	environmentId: string,
	request: ReturnType<typeof memberProgramUploadRequest>,
	publish: Publish,
	options: MemberProgramUploadOptions,
	now: number,
): Promise<void> {
	const mediaType = appMediaType(request.path);
	const text = manifestText(request.fileSha256, request.bytes, mediaType, request.pieces);
	const manifestSha256 = contentHash(text);
	const mine = uploads.get(userId);
	if (mine && (mine.finished || now - mine.renewed >= ALIVE_MS)) drop(userId);
	else if (
		mine &&
		mine.environmentId === environmentId &&
		mine.path === request.path &&
		mine.manifestSha256 === manifestSha256
	) {
		mine.touched = now;
		send(response, 200, { schema: "qorpera.member-program-upload/v1", uploadId: mine.id, have: received(mine) });
		return;
	}
	if (uploads.has(userId)) {
		send(response, 429, { error: "Another file of this member is going up" });
		return;
	}
	const opened = schema(await publish("qorpera_folder_open_upload", { p_manifest: text }), "qorpera.folder-upload/v1");
	if (
		typeof opened.intentId !== "string" ||
		!UUID.test(opened.intentId) ||
		opened.manifestSha256 !== manifestSha256 ||
		!Array.isArray(opened.present)
	)
		throw new ObjectDependencyError(503);
	const upload: Upload = {
		id: opened.intentId,
		userId,
		environmentId,
		path: request.path,
		bytes: request.bytes,
		fileSha256: request.fileSha256,
		pieces: request.pieces,
		mediaType,
		manifestSha256,
		present: new Set(opened.present.filter((hash): hash is string => typeof hash === "string")),
		hash: createHash("sha256"),
		held: new Map(),
		next: 0,
		digest: null,
		touched: now,
		renewed: now,
		finished: false,
		finishing: 0,
	};
	if (!upload.present.has(manifestSha256))
		await put(upload, manifestSha256, new TextEncoder().encode(text), publish, options);
	if (uploads.has(userId)) {
		send(response, 429, { error: "Another file of this member is going up" });
		return;
	}
	uploads.set(userId, upload);
	if (!sweeping) {
		sweeping = setInterval(() => sweep(clock()), IDLE_MS);
		sweeping.unref?.();
	}
	send(response, 200, { schema: "qorpera.member-program-upload/v1", uploadId: upload.id, have: [] });
}

async function piece(
	request: IncomingMessage,
	response: ServerResponse,
	upload: Upload,
	index: number,
	publish: Publish,
	options: MemberProgramUploadOptions,
): Promise<void> {
	const now = options.now ?? Date.now;
	if (upload.finished || index >= upload.pieces.length) throw new ObjectDependencyError(404);
	const size = pieceBytes(upload.bytes, upload.pieces.length, index);
	if (
		request.headers["content-length"] !== String(size) ||
		request.headers["content-type"] !== "application/octet-stream"
	)
		throw new ObjectDependencyError(400);
	const fresh = index >= upload.next && !upload.held.has(index);
	if (fresh && index >= upload.next + HELD_AHEAD) {
		await body(request, size);
		send(response, 409, { error: "Send the earlier pieces first" });
		return;
	}
	const bytes = await body(request, size);
	const hash = upload.pieces[index]!;
	if (contentHash(bytes) !== hash) throw new ObjectDependencyError(400);
	if (now() - upload.renewed > RENEW_MS) {
		schema(await publish("qorpera_folder_renew_upload", { p_intent: upload.id }), "qorpera.folder-upload-renew/v1");
		upload.renewed = now();
	}
	if (!upload.present.has(hash)) await put(upload, hash, bytes, publish, options);
	if (uploads.get(upload.userId) !== upload) throw new ObjectDependencyError(404);
	if (index >= upload.next && !upload.held.has(index)) {
		upload.held.set(index, bytes);
		for (let next = upload.held.get(upload.next); next; next = upload.held.get(upload.next)) {
			upload.hash.update(next);
			upload.held.delete(upload.next);
			upload.next++;
		}
		if (upload.next === upload.pieces.length) upload.digest = upload.hash.digest("hex");
	}
	upload.touched = now();
	send(response, 200, { schema: "qorpera.member-program-piece/v1", piece: index, bytes: size });
}

type Placed = { readonly fileSha256: string; readonly bytes: number; readonly version: string } | null;

export type MemberProgramFinishOutcome = "saved" | "exists" | "denied" | "refused" | "conflict";

async function finish(
	response: ServerResponse,
	upload: Upload,
	operationKey: string,
	publish: Publish,
	commit: (units: unknown[], key: string) => Promise<unknown>,
	read: () => Promise<Placed>,
	observation: MemberRequestObservationSpan | undefined,
): Promise<void> {
	if (upload.digest === null) {
		send(response, 409, { error: "Pieces of the file are missing" });
		return;
	}
	if (upload.digest !== upload.fileSha256) {
		drop(upload.userId);
		throw new ObjectDependencyError(400);
	}
	const sealed = schema(
		await publish("qorpera_folder_seal_upload", { p_intent: upload.id }),
		"qorpera.folder-seal/v1",
	);
	if (sealed.state !== "sealed") {
		drop(upload.userId);
		send(response, 409, { error: "The file must go up again" });
		return;
	}
	const file = sealed.file as Record<string, unknown> | null;
	if (
		file?.manifestSha256 !== upload.manifestSha256 ||
		file.fileSha256 !== upload.fileSha256 ||
		file.bytes !== upload.bytes ||
		file.mediaType !== upload.mediaType ||
		file.executable !== false
	)
		throw new ObjectDependencyError(503);
	const answer = (outcome: MemberProgramFinishOutcome, version: string | null, reason?: unknown) => {
		upload.finished = true;
		const encoded = send(response, 200, {
			schema: "qorpera.member-program-finish/v1",
			outcome,
			version,
			...(typeof reason === "string" ? { reason } : {}),
		});
		observation?.update({ responseBodyBytes: Buffer.byteLength(encoded) });
	};
	const settle = (entry: NonNullable<Placed>) =>
		entry.fileSha256 === upload.fileSha256 && entry.bytes === upload.bytes
			? answer("saved", entry.version)
			: answer("exists", null);
	const before = await read();
	if (before) return settle(before);
	const saved = schema(
		await commit(
			[...memberProgramFolders(upload.path), { op: "write", path: upload.path, file }],
			`member:${upload.userId}:${operationKey}`,
		),
		"qorpera.folder-commit/v1",
	);
	if (!Array.isArray(saved.units) || saved.units.length !== 5) throw new ObjectDependencyError(503);
	const unit = saved.units[4] as { outcome?: unknown; version?: unknown; reason?: unknown } | null;
	if (unit?.outcome === "saved" && typeof unit.version === "string" && UUID.test(unit.version))
		return answer("saved", unit.version);
	if (unit?.outcome === "conflict") {
		const after = await read();
		if (after) return settle(after);
		return answer("conflict", null, unit.reason);
	}
	if (unit?.outcome === "denied") return answer("denied", null, unit.reason);
	if (unit?.outcome === "refused" || unit?.outcome === "waiting_for_review")
		return answer("refused", null, unit.reason);
	throw new ObjectDependencyError(503);
}

export async function serveMemberProgramUpload(
	request: IncomingMessage,
	response: ServerResponse,
	options: MemberProgramUploadOptions,
): Promise<void> {
	const now = options.now ?? Date.now;
	const match = PATH.exec(request.url ?? "");
	if (!match || !UUID.test(match[1]!) || (match[2] !== undefined && !UUID.test(match[2])))
		throw new ObjectDependencyError(404);
	const [, environmentId = "", uploadId, step] = match;
	const kind = uploadId === undefined ? "open" : step === undefined ? "finish" : step === "stop" ? "stop" : "piece";
	if (request.method !== (kind === "piece" ? "PUT" : "POST")) throw new ObjectDependencyError(405);
	const header = request.headers.authorization;
	if (!header || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header)) throw new ObjectDependencyError(401);
	const token = header.slice(7);
	const observation = kind === "finish" ? options.observation : undefined;
	observation?.operation("command_submit");
	const opening = kind === "open" ? memberProgramUploadRequest(await json(request)) : undefined;
	const operationKey = kind === "finish" ? finishKey(await json(request, observation)) : undefined;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new ObjectDependencyError(503)), REQUEST_MS);
	const signal = controller.signal;
	try {
		const member = memberFolderWriter(
			await options.authority.member(
				"qorpera_member_folder_writer",
				token,
				{ p_environment_id: environmentId },
				signal,
			),
		);
		observation?.update({ companyId: member.profileId, environmentId });
		const actor = member.actor;
		const publish: Publish = (method, args) =>
			options.authority.publisher(method, { p_environment_id: environmentId, p_actor: actor, ...args }, signal);
		clock = now;
		sweep(now());
		if (opening) {
			await open(response, actor.userId, environmentId, opening, publish, options, now());
			return;
		}
		const upload = uploads.get(actor.userId);
		if (!upload || upload.id !== uploadId || upload.environmentId !== environmentId)
			throw new ObjectDependencyError(404);
		upload.touched = now();
		if (kind === "stop") {
			if (!upload.finished && upload.finishing === 0) drop(actor.userId);
			response.writeHead(204, { "cache-control": "private, no-store" });
			response.end();
			return;
		}
		const gone = (error: unknown): never => {
			if (error instanceof ObjectDependencyError && error.status === 403 && uploads.get(actor.userId) === upload)
				drop(actor.userId);
			throw error;
		};
		if (kind === "piece") {
			await piece(request, response, upload, Number(step), publish, options).catch(gone);
			return;
		}
		upload.finishing++;
		await finish(
			response,
			upload,
			operationKey!,
			publish,
			(units, key) =>
				options.authority.publisher(
					"qorpera_folder_commit",
					{ p_environment_id: environmentId, p_actor: actor, p_operation_key: key, p_units: units },
					signal,
				),
			async () => {
				const entry = parseCloudMemberFolderRead(
					await options.authority.member(
						"qorpera_member_folder_read",
						token,
						{ p_environment_id: environmentId, p_path: upload.path },
						signal,
					),
				).entry;
				if (!entry) return null;
				return entry.kind === "file" && entry.file
					? { fileSha256: entry.file.fileSha256, bytes: entry.file.bytes, version: entry.version }
					: { fileSha256: "", bytes: -1, version: entry.version };
			},
			observation,
		)
			.catch(gone)
			.finally(() => {
				upload.finishing--;
			});
	} finally {
		clearTimeout(timer);
	}
}
