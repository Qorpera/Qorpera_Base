import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { boundedObjectOperation, ObjectDependencyError } from "./dependency.ts";
import { type MemberCompanyAuthority, MemberCompanyHeadConflict } from "./member-company-authority.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const OMITTED = [
	"company-git-history",
	"session-trail",
	"staff-registry",
	"product-git-checkouts",
	"dependency-caches",
	"staff-instructions",
	"system-metadata",
];

interface FileEntry {
	path: string;
	kind: "file";
	executable: boolean;
	file: { manifestSha256: string; fileSha256: string; bytes: number; mediaType: "application/octet-stream" };
}
type Entry = FileEntry | { path: string; kind: "directory" };
interface Plan {
	schema: "qorpera.company-path-mutation/v1";
	operationKey: string;
	path: string;
	expectedVersion: string | null;
	entry: Entry | null;
}
interface Command {
	commandId: string;
	environmentId: string;
	companyId: string;
	plan: Plan;
	planSha256: string;
	state: "ready" | "review_required" | "approved" | "applied" | "rejected";
	expiresAt: string;
	result: Record<string, unknown> | null;
}

export interface MemberCompanyFileOptions {
	authority: MemberCompanyAuthority;
	store: FileSystemObjectStore;
	replication: ObjectGatewayReplication;
	readLegacyObject(companyId: string, sha256: string): Promise<Uint8Array>;
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObjectDependencyError(400);
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
		throw new ObjectDependencyError(400);
}

function id(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new ObjectDependencyError(400);
	return value;
}

function hash(value: unknown): string {
	if (typeof value !== "string" || !SHA.test(value)) throw new ObjectDependencyError(400);
	return value;
}

function path(value: unknown): string {
	if (typeof value !== "string" || !value || Buffer.byteLength(value) > 4096 || /[\0-\x1f\x7f]/.test(value))
		throw new ObjectDependencyError(400);
	return value;
}

function entry(value: unknown): Entry {
	const item = object(value);
	const name = path(item.path);
	if (item.kind === "directory") {
		exact(item, ["path", "kind"]);
		return { path: name, kind: "directory" };
	}
	exact(item, ["path", "kind", "executable", "file"]);
	if (item.kind !== "file" || typeof item.executable !== "boolean") throw new ObjectDependencyError(400);
	const file = object(item.file);
	exact(file, ["manifestSha256", "fileSha256", "bytes", "mediaType"]);
	if (file.mediaType !== "application/octet-stream" || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0)
		throw new ObjectDependencyError(400);
	return {
		path: name,
		kind: "file",
		executable: item.executable,
		file: {
			manifestSha256: hash(file.manifestSha256),
			fileSha256: hash(file.fileSha256),
			bytes: file.bytes as number,
			mediaType: file.mediaType,
		},
	};
}

function plan(value: unknown): Plan {
	const input = object(value);
	exact(input, ["schema", "operationKey", "path", "expectedVersion", "entry"]);
	if (
		input.schema !== "qorpera.company-path-mutation/v1" ||
		typeof input.operationKey !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.operationKey)
	)
		throw new ObjectDependencyError(400);
	const name = path(input.path);
	const next = input.entry === null ? null : entry(input.entry);
	if (next && next.path !== name) throw new ObjectDependencyError(400);
	return {
		schema: input.schema,
		operationKey: input.operationKey,
		path: name,
		expectedVersion: input.expectedVersion === null ? null : id(input.expectedVersion),
		entry: next,
	};
}

function command(value: unknown, environmentId: string): Command {
	const input = object(value);
	const next = plan(input.plan);
	if (
		input.environmentId !== environmentId ||
		!["ready", "review_required", "approved", "applied", "rejected"].includes(String(input.state)) ||
		typeof input.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(input.expiresAt))
	)
		throw new ObjectDependencyError(503);
	const result = input.result === null ? null : object(input.result);
	if (
		(input.state === "applied") !== (result !== null) ||
		(result && (result.state !== "applied" || result.path !== next.path || result.operationKey !== next.operationKey))
	)
		throw new ObjectDependencyError(503);
	if (result) {
		id(result.snapshotId);
		id(result.version);
	}
	return {
		commandId: id(input.commandId),
		environmentId,
		companyId: id(input.companyId),
		plan: next,
		planSha256: hash(input.planSha256),
		state: input.state as Command["state"],
		expiresAt: input.expiresAt,
		result,
	};
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	const length = request.headers["content-length"];
	if (
		!length ||
		!/^[1-9][0-9]{0,5}$/.test(length) ||
		Number(length) > 256 * 1024 ||
		request.headers["content-type"] !== "application/json"
	)
		throw new ObjectDependencyError(400);
	return boundedObjectOperation(async () => {
		const chunks: Buffer[] = [];
		let count = 0;
		for await (const part of request) {
			const chunk = Buffer.from(part);
			count += chunk.length;
			if (count > Number(length)) throw new ObjectDependencyError(413);
			chunks.push(chunk);
		}
		if (count !== Number(length)) throw new ObjectDependencyError(400);
		try {
			return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
		} catch {
			throw new ObjectDependencyError(400);
		}
	});
}

function json(response: ServerResponse, value: unknown): void {
	response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
	response.end(JSON.stringify(value));
}

/** This route accepts human intent only. Whole tree metadata and service
 * credentials never leave this cloud process, and no model is run here. */
export async function serveMemberCompanyFile(
	request: IncomingMessage,
	response: ServerResponse,
	options: MemberCompanyFileOptions,
): Promise<void> {
	const match =
		/^\/v1\/member-company-file\/([0-9a-f-]{36})\/(edits|proposals)(?:\/([0-9a-f-]{36}))?(?:\/(review|content))?$/.exec(
			request.url ?? "",
		);
	if (!match) throw new ObjectDependencyError(404);
	const environmentId = id(match[1]);
	const target = match[3] ? id(match[3]) : undefined;
	const header = request.headers.authorization;
	if (!header?.startsWith("Bearer ") || header.length < 8 || header.length > 8192 || /[\r\n]/.test(header))
		throw new ObjectDependencyError(401);
	const token = header.slice(7);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new ObjectDependencyError(503)), 30_000);
	const signal = controller.signal;
	const authority = options.authority;
	try {
		if (match[2] === "proposals" && target) {
			const describe = async (): Promise<Record<string, unknown>> =>
				object(
					await authority.member(
						"qorpera_describe_member_company_path_proposal",
						token,
						{ p_environment_id: environmentId, p_proposal_id: target },
						signal,
					),
				);
			const proposal = await describe();
			if (proposal.proposalId !== target) throw new ObjectDependencyError(503);
			const proposalPlan = plan(proposal.plan);
			const digest = hash(proposal.planSha256);
			if (request.method === "GET" && match[4] === "content") {
				if (proposalPlan.entry?.kind !== "file" || proposalPlan.entry.file.bytes > 32 * 1024)
					throw new ObjectDependencyError(400);
				const file = proposalPlan.entry.file;
				const authorize = async (): Promise<Record<string, unknown>> =>
					object(
						await authority.member(
							"qorpera_authorize_member_company_proposal_object",
							token,
							{ p_proposal_id: target, p_plan_sha256: digest, p_sha256: file.fileSha256 },
							signal,
						),
					);
				let bytes: Uint8Array = new Uint8Array();
				if (file.bytes) {
					const access = await authorize();
					if (access.sha256 !== file.fileSha256 || access.bytes !== file.bytes)
						throw new ObjectDependencyError(503);
					const companyId = id(access.companyId);
					try {
						bytes = await options.store.get(companyId, file.fileSha256, file.bytes);
					} catch (error) {
						if (
							!(error instanceof Error) ||
							(error.message !== "Object not found" &&
								!(error instanceof ObjectDependencyError && error.unavailable))
						)
							throw error;
						bytes = await options.readLegacyObject(companyId, file.fileSha256);
					}
					if (!isDeepStrictEqual(await authorize(), access)) throw new ObjectDependencyError(403);
				}
				if (
					bytes.length !== file.bytes ||
					createHash("sha256").update(bytes).digest("hex") !== file.fileSha256 ||
					!isDeepStrictEqual(await describe(), proposal)
				)
					throw new ObjectDependencyError(409);
				signal.throwIfAborted();
				json(response, {
					proposalId: target,
					planSha256: digest,
					text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
				});
				return;
			}
			if (request.method !== "POST" || match[4] !== "review") throw new ObjectDependencyError(405);
			const input = await body(request);
			exact(input, ["planSha256", "decision"]);
			if (input.planSha256 !== digest || !["approve", "reject", "skip"].includes(String(input.decision)))
				throw new ObjectDependencyError(400);
			const reviewed = object(
				await authority.member(
					"qorpera_review_company_path_proposal",
					token,
					{ p_proposal_id: target, p_plan_sha256: digest, p_decision: input.decision },
					signal,
				),
			);
			if (reviewed.state === "approved") await applyProposal(options, environmentId, target, digest, signal);
			json(response, await describe());
			return;
		}
		if (match[2] !== "edits") throw new ObjectDependencyError(404);
		let current: Command;
		if (target) {
			current = command(
				await authority.member("qorpera_get_member_company_path_command", token, { p_command_id: target }, signal),
				environmentId,
			);
			if (current.commandId !== target) throw new ObjectDependencyError(503);
			if (request.method === "GET" && !match[4]) {
				json(response, current);
				return;
			}
			if (request.method === "GET" && match[4] === "content") {
				if (
					!["ready", "review_required", "approved"].includes(current.state) ||
					Date.parse(current.expiresAt) <= Date.now() ||
					current.plan.entry?.kind !== "file" ||
					current.plan.entry.file.bytes > 32 * 1024
				)
					throw new ObjectDependencyError(403);
				const file = current.plan.entry.file;
				const authorize = async (): Promise<Record<string, unknown>> =>
					object(
						await authority.member(
							"qorpera_authorize_member_company_command_object",
							token,
							{ p_command_id: target, p_plan_sha256: current.planSha256, p_sha256: file.fileSha256 },
							signal,
						),
					);
				let bytes: Uint8Array = new Uint8Array();
				if (file.bytes) {
					const access = await authorize();
					if (
						access.companyId !== current.companyId ||
						access.sha256 !== file.fileSha256 ||
						access.bytes !== file.bytes
					)
						throw new ObjectDependencyError(503);
					try {
						bytes = await options.store.get(current.companyId, file.fileSha256, file.bytes);
					} catch (error) {
						if (
							!(error instanceof Error) ||
							(error.message !== "Object not found" &&
								!(error instanceof ObjectDependencyError && error.unavailable))
						)
							throw error;
						bytes = await options.readLegacyObject(current.companyId, file.fileSha256);
					}
					if (!isDeepStrictEqual(await authorize(), access)) throw new ObjectDependencyError(403);
				}
				const latest = command(
					await authority.member(
						"qorpera_get_member_company_path_command",
						token,
						{ p_command_id: target },
						signal,
					),
					environmentId,
				);
				if (
					bytes.length !== file.bytes ||
					createHash("sha256").update(bytes).digest("hex") !== file.fileSha256 ||
					!isDeepStrictEqual(latest, current) ||
					Date.parse(latest.expiresAt) <= Date.now()
				)
					throw new ObjectDependencyError(409);
				signal.throwIfAborted();
				json(response, {
					commandId: target,
					planSha256: current.planSha256,
					text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
				});
				return;
			}
			if (request.method !== "POST" || match[4] !== "review") throw new ObjectDependencyError(405);
			const input = await body(request);
			exact(input, ["planSha256", "decision"]);
			if (input.planSha256 !== current.planSha256 || !["approve", "reject", "skip"].includes(String(input.decision)))
				throw new ObjectDependencyError(400);
			// A ready command already carries this human's exact ordinary edit.
			// Explicitly resuming it needs no new approval, but apply still checks
			// its expiry, original member, resource version and path authority.
			if (current.state !== "ready" || input.decision !== "approve") {
				current = command(
					await authority.member(
						"qorpera_review_member_company_path_command",
						token,
						{ p_command_id: target, p_plan_sha256: current.planSha256, p_decision: input.decision },
						signal,
					),
					environmentId,
				);
			}
		} else {
			if (request.method !== "POST" || match[4]) throw new ObjectDependencyError(405);
			const input = await body(request);
			exact(input, [
				"operation",
				"operationKey",
				"path",
				"expectedVersion",
				...(input.operation === "write" ? ["text"] : []),
			]);
			let next: Entry | null;
			let bytes: Buffer | undefined;
			let manifest: Buffer | undefined;
			if (input.operation === "write") {
				if (
					typeof input.text !== "string" ||
					input.text.includes("\0") ||
					Buffer.byteLength(input.text) > 32 * 1024 ||
					Buffer.from(input.text).toString("utf8") !== input.text
				)
					throw new ObjectDependencyError(400);
				bytes = Buffer.from(input.text);
				const sha = createHash("sha256").update(bytes).digest("hex");
				manifest = Buffer.from(
					JSON.stringify({
						schema: "qorpera.cloud-file-manifest/v1",
						fileSha256: sha,
						bytes: bytes.length,
						mediaType: "application/octet-stream",
						chunks: bytes.length ? [{ sha256: sha, bytes: bytes.length }] : [],
					}),
				);
				next = {
					path: path(input.path),
					kind: "file",
					executable: false,
					file: {
						fileSha256: sha,
						manifestSha256: createHash("sha256").update(manifest).digest("hex"),
						bytes: bytes.length,
						mediaType: "application/octet-stream",
					},
				};
			} else if (input.operation === "mkdir") next = { path: path(input.path), kind: "directory" };
			else if (input.operation === "delete") next = null;
			else throw new ObjectDependencyError(400);
			const intended = plan({
				schema: "qorpera.company-path-mutation/v1",
				operationKey: input.operationKey,
				path: input.path,
				expectedVersion: input.expectedVersion,
				entry: next,
			});
			current = command(
				await authority.member(
					"qorpera_begin_member_company_path_command",
					token,
					{ p_environment_id: environmentId, p_plan: intended },
					signal,
				),
				environmentId,
			);
			if (!isDeepStrictEqual(current.plan, intended)) throw new ObjectDependencyError(503);
			if (current.state !== "applied" && current.state !== "rejected" && bytes && manifest) {
				if (bytes.length) await stage(options, current, bytes, false, signal);
				await stage(options, current, manifest, false, signal);
				await authority.publisher(
					"qorpera_verify_company_path_file",
					{ p_profile_id: current.companyId, p_manifest_text: manifest.toString("utf8") },
					signal,
				);
			}
		}
		if (current.state === "ready" || current.state === "approved")
			current = await applyCommand(options, current, signal);
		const visible = command(
			await authority.member(
				"qorpera_get_member_company_path_command",
				token,
				{ p_command_id: current.commandId },
				signal,
			),
			environmentId,
		);
		if (
			visible.commandId !== current.commandId ||
			visible.companyId !== current.companyId ||
			visible.planSha256 !== current.planSha256
		)
			throw new ObjectDependencyError(503);
		signal.throwIfAborted();
		json(response, visible);
	} finally {
		clearTimeout(timer);
	}
}

async function stage(
	options: MemberCompanyFileOptions,
	current: Command,
	bytes: Buffer,
	tree: boolean,
	signal: AbortSignal,
): Promise<string> {
	const sha = createHash("sha256").update(bytes).digest("hex");
	const args = {
		p_command_id: current.commandId,
		p_plan_sha256: current.planSha256,
		p_sha256: sha,
		p_bytes: bytes.length,
		p_tree: tree,
	};
	const check = async (confirm: boolean): Promise<void> => {
		signal.throwIfAborted();
		if (
			(await options.authority.publisher(
				"qorpera_stage_member_company_path_object",
				{ ...args, p_confirm: confirm },
				signal,
			)) !== current.companyId
		)
			throw new ObjectDependencyError(403);
	};
	await options.replication.uploadWithAuthority(current.companyId, sha, bytes, {
		authorize: () => check(false),
		confirm: () => check(true),
	});
	const stored = await options.store.get(current.companyId, sha, bytes.length);
	if (!Buffer.from(stored).equals(bytes)) throw new ObjectDependencyError(503);
	signal.throwIfAborted();
	return sha;
}

function candidate(value: unknown, intended: Plan): Buffer {
	if (!Array.isArray(value) || value.length > 50_000) throw new ObjectDependencyError(503);
	const entries = value.map(entry).filter((item) => item.path !== intended.path);
	if (intended.entry) entries.push(intended.entry);
	entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
	const bytes = Buffer.from(
		JSON.stringify({ schema: "qorpera.company-tree/v1", contractVersion: 3, omittedLayers: OMITTED, entries }),
	);
	if (bytes.length > 8 * 1024 * 1024) throw new ObjectDependencyError(413);
	return bytes;
}

function organizationPath(pathName: string): boolean {
	const key = pathName.normalize("NFKC").toUpperCase().toLowerCase();
	return (
		key === "organization/formation.json" ||
		/^organization\/(?:agents|departments|projects)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(
			key,
		)
	);
}

async function organizationDocument(
	options: MemberCompanyFileOptions,
	companyId: string,
	mutation: Plan,
): Promise<string | null> {
	if (!organizationPath(mutation.path)) return null;
	if (mutation.entry === null) return null;
	if (mutation.entry?.kind !== "file" || mutation.entry.file.bytes > 32 * 1024) throw new ObjectDependencyError(400);
	const file = mutation.entry.file;
	let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
	if (file.bytes) {
		try {
			bytes = await options.store.get(companyId, file.fileSha256, file.bytes);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				(error.message !== "Object not found" && !(error instanceof ObjectDependencyError && error.unavailable))
			)
				throw error;
			bytes = await options.readLegacyObject(companyId, file.fileSha256);
		}
	}
	if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.fileSha256)
		throw new ObjectDependencyError(409);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new ObjectDependencyError(400);
	}
}

async function applyCommand(
	options: MemberCompanyFileOptions,
	initial: Command,
	signal: AbortSignal,
): Promise<Command> {
	const args = { p_command_id: initial.commandId, p_plan_sha256: initial.planSha256 };
	for (let attempt = 0; attempt < 4; attempt++) {
		const prepared = object(
			await options.authority.publisher("qorpera_prepare_member_company_path_command", args, signal),
		);
		const current = command(prepared, initial.environmentId);
		if (
			current.commandId !== initial.commandId ||
			current.companyId !== initial.companyId ||
			current.planSha256 !== initial.planSha256 ||
			!isDeepStrictEqual(current.plan, initial.plan)
		)
			throw new ObjectDependencyError(503);
		if (current.state === "applied") return current;
		if (current.state !== "ready" && current.state !== "approved") throw new ObjectDependencyError(403);
		const bytes = candidate(prepared.entries, current.plan);
		const sha = await stage(options, current, bytes, true, signal);
		if (
			(await options.authority.publisher(
				"qorpera_verify_company_path_tree",
				{ p_profile_id: current.companyId, p_manifest_text: bytes.toString("utf8") },
				signal,
			)) !== sha
		)
			throw new ObjectDependencyError(503);
		try {
			const document = await organizationDocument(options, current.companyId, current.plan);
			const applied = command(
				await options.authority.publisher(
					"qorpera_apply_member_company_path_command_v3",
					{
						...args,
						p_expected_head: id(prepared.snapshotId),
						p_tree_sha256: sha,
						p_document_text: document,
					},
					signal,
				),
				initial.environmentId,
			);
			if (
				applied.state !== "applied" ||
				applied.commandId !== initial.commandId ||
				applied.companyId !== initial.companyId ||
				applied.planSha256 !== initial.planSha256 ||
				!isDeepStrictEqual(applied.plan, initial.plan)
			)
				throw new ObjectDependencyError(503);
			return applied;
		} catch (error) {
			if (!(error instanceof MemberCompanyHeadConflict) || attempt === 3) throw error;
		}
	}
	throw new ObjectDependencyError(409);
}

async function applyProposal(
	options: MemberCompanyFileOptions,
	environmentId: string,
	proposalId: string,
	digest: string,
	signal: AbortSignal,
): Promise<void> {
	const args = { p_proposal_id: proposalId, p_plan_sha256: digest };
	for (let attempt = 0; attempt < 4; attempt++) {
		const prepared = object(await options.authority.publisher("qorpera_prepare_company_path_approval", args, signal));
		if (prepared.environmentId !== environmentId) throw new ObjectDependencyError(403);
		if (prepared.state === "applied") return;
		if (prepared.state !== "approved") throw new ObjectDependencyError(403);
		const companyId = id(prepared.companyId);
		const bytes = candidate(prepared.entries, plan(prepared.plan));
		const sha = createHash("sha256").update(bytes).digest("hex");
		const check = async (confirm: boolean): Promise<void> => {
			signal.throwIfAborted();
			if (
				(await options.authority.publisher(
					"qorpera_stage_company_path_approval_object",
					{ ...args, p_sha256: sha, p_bytes: bytes.length, p_confirm: confirm },
					signal,
				)) !== companyId
			)
				throw new ObjectDependencyError(403);
		};
		await options.replication.uploadWithAuthority(companyId, sha, bytes, {
			authorize: () => check(false),
			confirm: () => check(true),
		});
		if (!Buffer.from(await options.store.get(companyId, sha, bytes.length)).equals(bytes))
			throw new ObjectDependencyError(503);
		if (
			(await options.authority.publisher(
				"qorpera_verify_company_path_tree",
				{ p_profile_id: companyId, p_manifest_text: bytes.toString("utf8") },
				signal,
			)) !== sha
		)
			throw new ObjectDependencyError(503);
		try {
			const document = await organizationDocument(options, companyId, plan(prepared.plan));
			const result = object(
				await options.authority.publisher(
					"qorpera_apply_company_path_approval_v3",
					{
						...args,
						p_expected_head: id(prepared.snapshotId),
						p_tree_sha256: sha,
						p_document_text: document,
					},
					signal,
				),
			);
			if (result.state !== "applied" || result.proposalId !== proposalId) throw new ObjectDependencyError(503);
			id(result.snapshotId);
			return;
		} catch (error) {
			if (!(error instanceof MemberCompanyHeadConflict) || attempt === 3) throw error;
		}
	}
	throw new ObjectDependencyError(409);
}
