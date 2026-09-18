import { cloudFileBytesSha256 } from "./cloud-file-bytes.ts";
import type { CompanyFileTransferSelection } from "./cloud-file-transfer.ts";
import type { CloudMemberCompanyFileDownload } from "./cloud-member-company-file.ts";
import { CloudMemberCompanyFileReader } from "./cloud-member-company-file.ts";
import { CloudMemberFileExports } from "./cloud-member-file-exports.ts";
import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";
import { type CloudCompanyPathPlan, parseCloudCompanyPath } from "./company-path-schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

function comparePathBytes(left: string, right: string): number {
	const a = encoder.encode(left),
		b = encoder.encode(right);
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}

export interface CloudMemberCompanyMode {
	companyId: string;
	environmentId: string;
	mode: "governed" | "legacy";
}

export interface CloudMemberCompanyCommand {
	commandId: string;
	environmentId: string;
	companyId: string;
	plan: CloudCompanyPathPlan;
	planSha256: string;
	state: "ready" | "review_required" | "approved" | "applied" | "rejected";
	expiresAt: string;
	result: { snapshotId: string; version: string } | null;
}

export interface CloudMemberCompanyProposal {
	proposalId: string;
	plan: CloudCompanyPathPlan;
	planSha256: string;
	state: "open" | "approved" | "applied" | "rejected" | "withdrawn";
	snapshotId: string | null;
}

export type CloudMemberCompanyEdit = {
	operationKey: string;
	path: string;
	expectedVersion: string | null;
} & ({ operation: "write"; text: string } | { operation: "mkdir" | "delete" });

export interface CloudMemberCompanyUpload {
	operationKey: string;
	path: string;
	expectedVersion: string | null;
	name: string;
	mediaType: string;
	bytes: Uint8Array;
}

export interface CloudMemberCompanyUploadSource {
	realm: "member_file";
	name: string;
	sha256: string;
	bytes: number;
	mediaType: string;
}

export interface CloudMemberCompanyPage {
	snapshotId: string;
	items: Array<{ path: string; version: string; kind: "directory" | "file"; bytes: number | null }>;
	hasMore: boolean;
	nextAfter: string | null;
}

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(keys && (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))))
	)
		throw new Error("Invalid Company File response");
	return value as Record<string, unknown>;
}

function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid Company File identity");
	return value;
}

function hash(value: unknown): string {
	if (typeof value !== "string" || !SHA.test(value)) throw new Error("Invalid Company File digest");
	return value;
}

function plan(value: unknown): CloudCompanyPathPlan {
	const input = record(value, ["schema", "operationKey", "path", "expectedVersion", "entry"]);
	if (
		input.schema !== "qorpera.company-path-mutation/v1" ||
		typeof input.operationKey !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.operationKey)
	)
		throw new Error("Invalid Company File plan");
	const path = parseCloudCompanyPath(input.path);
	const base = {
		schema: input.schema,
		operationKey: input.operationKey,
		path,
		expectedVersion: input.expectedVersion === null ? null : uuid(input.expectedVersion),
	} as const;
	if (input.entry === null) return { ...base, entry: null };
	const entry = record(input.entry);
	if (entry.path !== path) throw new Error("Company File plan target changed");
	if (entry.kind === "directory") {
		record(entry, ["path", "kind"]);
		return { ...base, entry: { path, kind: "directory" } };
	}
	record(entry, ["path", "kind", "executable", "file"]);
	if (entry.kind !== "file" || typeof entry.executable !== "boolean")
		throw new Error("Invalid Company File plan entry");
	const file = record(entry.file, ["manifestSha256", "fileSha256", "bytes", "mediaType"]);
	if (
		!Number.isSafeInteger(file.bytes) ||
		(file.bytes as number) < 0 ||
		(file.bytes as number) > MAX_UPLOAD_BYTES ||
		file.mediaType !== "application/octet-stream"
	)
		throw new Error("Invalid Company File text plan");
	return {
		...base,
		entry: {
			path,
			kind: "file",
			executable: entry.executable,
			file: {
				manifestSha256: hash(file.manifestSha256),
				fileSha256: hash(file.fileSha256),
				bytes: file.bytes as number,
				mediaType: file.mediaType,
			},
		},
	};
}

export function parseCloudMemberCompanyMode(value: unknown, companyId: string): CloudMemberCompanyMode {
	const input = record(value, ["companyId", "environmentId", "mode"]);
	if (input.companyId !== companyId || (input.mode !== "governed" && input.mode !== "legacy"))
		throw new Error("Company File mode is unavailable");
	return { companyId: uuid(input.companyId), environmentId: uuid(input.environmentId), mode: input.mode };
}

/** Shared member display/intent client only. The cloud stages bytes and publishes
 * against current ACLs. This client cannot obtain a tree or service key. */
export class CloudMemberCompanyFileClient {
	readonly exports: CloudMemberFileExports;
	readonly #options: ConstructorParameters<typeof CloudMemberCompanyFileReader>[0];
	readonly #reader: CloudMemberCompanyFileReader;
	readonly #control: string;
	readonly #gateway: string;
	readonly #fetch: typeof fetch;

	constructor(options: ConstructorParameters<typeof CloudMemberCompanyFileReader>[0]) {
		this.exports = new CloudMemberFileExports(options);
		this.#reader = new CloudMemberCompanyFileReader(options);
		this.#options = { ...options };
		this.#control = new URL(options.supabaseUrl).origin;
		this.#gateway = new URL(options.objectGatewayUrl).origin;
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	}

	download(selection: CompanyFileTransferSelection, signal: AbortSignal): Promise<CloudMemberCompanyFileDownload> {
		return this.#reader.download(selection, signal);
	}

	describe(path: string, signal: AbortSignal) {
		return this.#reader.describe(path, signal);
	}

	/** The host supplies only bytes explicitly selected by the member. No file
	 * path, chooser, filesystem or execution capability enters this client. */
	async upload(
		input: CloudMemberCompanyUpload,
		signal: AbortSignal,
	): Promise<{ command: CloudMemberCompanyCommand; source: CloudMemberCompanyUploadSource }> {
		record(input, ["operationKey", "path", "expectedVersion", "name", "mediaType", "bytes"]);
		const path = parseCloudCompanyPath(input.path),
			expectedVersion = input.expectedVersion === null ? null : uuid(input.expectedVersion);
		const { operationKey, name, mediaType } = input;
		if (
			typeof operationKey !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(operationKey) ||
			typeof name !== "string" ||
			encoder.encode(name).length < 1 ||
			encoder.encode(name).length > 255 ||
			/[\x00-\x1f\x7f/\\]/.test(name) ||
			[".", ".."].includes(name) ||
			new TextDecoder().decode(encoder.encode(name)) !== name ||
			typeof mediaType !== "string" ||
			mediaType.length > 256 ||
			!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) ||
			!(input.bytes instanceof Uint8Array) ||
			input.bytes.byteLength > MAX_UPLOAD_BYTES
		)
			throw new Error("Invalid selected Company File upload");
		signal.throwIfAborted();
		const bytes = Uint8Array.from(input.bytes);
		const source: CloudMemberCompanyUploadSource = {
			realm: "member_file",
			name,
			sha256: await cloudFileBytesSha256(bytes),
			bytes: bytes.length,
			mediaType,
		};
		const chunks: Array<{ sha256: string; bytes: number }> = [];
		for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024) {
			signal.throwIfAborted();
			const part = bytes.subarray(offset, offset + 4 * 1024 * 1024);
			chunks.push({ sha256: await cloudFileBytesSha256(part), bytes: part.length });
		}
		const manifest = {
			schema: "qorpera.cloud-file-manifest/v1",
			fileSha256: source.sha256,
			bytes: source.bytes,
			mediaType: "application/octet-stream",
			chunks,
		};
		const intended: CloudCompanyPathPlan = {
			schema: "qorpera.company-path-mutation/v1",
			operationKey,
			path,
			expectedVersion,
			entry: {
				path,
				kind: "file",
				executable: false,
				file: {
					manifestSha256: await cloudFileBytesSha256(encoder.encode(JSON.stringify(manifest))),
					fileSha256: source.sha256,
					bytes: source.bytes,
					mediaType: "application/octet-stream",
				},
			},
		};
		signal.throwIfAborted();
		const metadata = {
			schema: "qorpera.member-file-upload/v1",
			operationKey,
			path,
			expectedVersion,
			source,
			manifest,
		};
		const command = this.#command(await this.#request(true, "uploads", undefined, signal, { bytes, metadata }));
		if (JSON.stringify(command.plan) !== JSON.stringify(intended))
			throw new Error("Selected Company File upload changed");
		signal.throwIfAborted();
		return { command, source };
	}

	async read(
		path: string,
		signal: AbortSignal,
	): Promise<{
		path: string;
		version: string | null;
		kind: "file" | "directory" | "absent";
		executable: boolean;
		text: string;
	}> {
		const file = await this.#reader.read(path, signal, MAX_TEXT_BYTES);
		let text = "";
		if (file.bytes) {
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
			} catch {
				throw new Error("This viewer supports UTF-8 text files only");
			}
			if (text.includes("\0")) throw new Error("This viewer supports UTF-8 text files only");
		}
		return { path: file.path, version: file.version, kind: file.kind, executable: file.executable, text };
	}

	async list(
		pathValue: string,
		signal: AbortSignal,
		after: string | null = null,
		snapshotId: string | null = null,
	): Promise<CloudMemberCompanyPage> {
		const path = parseCloudCompanyPath(pathValue, true);
		if (after !== null) parseCloudCompanyPath(after);
		if (snapshotId !== null) uuid(snapshotId);
		if (after !== null && snapshotId === null) throw new Error("Company File pagination requires its snapshot");
		const input = record(
			await this.#rpc(
				"qorpera_list_company_paths",
				{ p_path: path, p_after: after, p_snapshot_id: snapshotId, p_limit: 50, p_binding: null },
				signal,
			),
			["snapshotId", "items", "hasMore", "nextAfter"],
		);
		if (!Array.isArray(input.items) || input.items.length > 50 || typeof input.hasMore !== "boolean")
			throw new Error("Invalid Company File page");
		let previous = after;
		const items = input.items.map((value): CloudMemberCompanyPage["items"][number] => {
			const item = record(value, ["path", "version", "kind", "bytes"]);
			const name = parseCloudCompanyPath(item.path);
			if (
				name.slice(0, name.lastIndexOf("/") < 0 ? 0 : name.lastIndexOf("/")) !== path ||
				(previous !== null && comparePathBytes(name, previous) <= 0) ||
				(item.kind !== "file" && item.kind !== "directory") ||
				(item.kind === "directory"
					? item.bytes !== null
					: !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0)
			)
				throw new Error("Company File page scope changed");
			previous = name;
			return { path: name, version: uuid(item.version), kind: item.kind, bytes: item.bytes as number | null };
		});
		const head = uuid(input.snapshotId);
		if (
			(snapshotId !== null && head !== snapshotId) ||
			input.nextAfter !== (input.hasMore ? items.at(-1)?.path : null)
		)
			throw new Error("Company File page changed");
		return { snapshotId: head, items, hasMore: input.hasMore, nextAfter: input.nextAfter as string | null };
	}

	async edits(
		signal: AbortSignal,
		after: string | null = null,
	): Promise<{ items: CloudMemberCompanyCommand[]; nextAfter: string | null }> {
		const page = await this.#pending("qorpera_list_member_company_path_commands", after, signal);
		return { items: page.items.map((item) => this.#command(item)), nextAfter: page.nextAfter };
	}

	async proposals(
		signal: AbortSignal,
		after: string | null = null,
	): Promise<{ items: CloudMemberCompanyProposal[]; nextAfter: string | null }> {
		const page = await this.#pending("qorpera_list_company_path_proposals", after, signal);
		return { items: page.items.map((item) => this.#proposal(item)), nextAfter: page.nextAfter };
	}

	async edit(input: CloudMemberCompanyEdit, signal: AbortSignal): Promise<CloudMemberCompanyCommand> {
		record(input, [
			"operation",
			"operationKey",
			"path",
			"expectedVersion",
			...(input.operation === "write" ? ["text"] : []),
		]);
		parseCloudCompanyPath(input.path);
		if (input.expectedVersion !== null) uuid(input.expectedVersion);
		if (
			typeof input.operationKey !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.operationKey) ||
			!["write", "mkdir", "delete"].includes(input.operation)
		)
			throw new Error("Invalid Company File edit");
		if (
			input.operation === "write" &&
			(typeof input.text !== "string" ||
				encoder.encode(input.text).length > MAX_TEXT_BYTES ||
				new TextDecoder().decode(encoder.encode(input.text)) !== input.text ||
				input.text.includes("\0"))
		)
			throw new Error("Company File edits must be UTF-8 text of at most 32 KiB");
		const result = this.#command(await this.#request(true, "edits", input, signal));
		if (
			result.plan.path !== input.path ||
			result.plan.operationKey !== input.operationKey ||
			result.plan.expectedVersion !== input.expectedVersion
		)
			throw new Error("Company File edit identity changed");
		if (input.operation === "write") {
			if (
				result.plan.entry?.kind !== "file" ||
				result.plan.entry.executable ||
				result.plan.entry.file.fileSha256 !== (await cloudFileBytesSha256(encoder.encode(input.text))) ||
				result.plan.entry.file.bytes !== encoder.encode(input.text).length
			)
				throw new Error("Company File edit content changed");
		} else if (input.operation === "delete" ? result.plan.entry !== null : result.plan.entry?.kind !== "directory")
			throw new Error("Company File edit operation changed");
		return result;
	}

	async command(commandId: string, signal: AbortSignal): Promise<CloudMemberCompanyCommand> {
		const result = this.#command(await this.#request(true, `edits/${uuid(commandId)}`, undefined, signal));
		if (result.commandId !== commandId) throw new Error("Company File command changed");
		return result;
	}

	async review(
		target: CloudMemberCompanyCommand | CloudMemberCompanyProposal,
		decision: "approve" | "reject" | "skip",
		signal: AbortSignal,
	): Promise<CloudMemberCompanyCommand | CloudMemberCompanyProposal> {
		if (!["approve", "reject", "skip"].includes(decision)) throw new Error("Invalid Company File review");
		const command = "commandId" in target;
		const id = uuid(command ? target.commandId : target.proposalId);
		const value = await this.#request(
			true,
			`${command ? "edits" : "proposals"}/${id}/review`,
			{ planSha256: hash(target.planSha256), decision },
			signal,
		);
		const result = command ? this.#command(value) : this.#proposal(value);
		if (
			("commandId" in result ? result.commandId : result.proposalId) !== id ||
			result.planSha256 !== target.planSha256 ||
			JSON.stringify(result.plan) !== JSON.stringify(plan(target.plan))
		)
			throw new Error("Company File review identity changed");
		return result;
	}

	async pendingText(
		target: CloudMemberCompanyCommand | CloudMemberCompanyProposal,
		signal: AbortSignal,
	): Promise<string> {
		if (target.plan.entry?.kind !== "file") return "";
		const key = "commandId" in target ? "commandId" : "proposalId";
		const id = uuid("commandId" in target ? target.commandId : target.proposalId);
		const input = record(
			await this.#request(true, `${key === "commandId" ? "edits" : "proposals"}/${id}/content`, undefined, signal),
			[key, "planSha256", "text"],
		);
		if (
			input[key] !== id ||
			input.planSha256 !== target.planSha256 ||
			typeof input.text !== "string" ||
			encoder.encode(input.text).length !== target.plan.entry.file.bytes ||
			(await cloudFileBytesSha256(encoder.encode(input.text))) !== target.plan.entry.file.fileSha256
		)
			throw new Error("Company File review content changed");
		return input.text;
	}

	async pendingFile(
		target: CloudMemberCompanyCommand | CloudMemberCompanyProposal,
		signal: AbortSignal,
	): Promise<{ bytes: Uint8Array; planSha256: string }> {
		const intended = plan(target.plan),
			digest = hash(target.planSha256);
		if (intended.entry?.kind !== "file") throw new Error("This change has no file content");
		const id = uuid("commandId" in target ? target.commandId : target.proposalId);
		const value = await this.#request(
			true,
			`${"commandId" in target ? "edits" : "proposals"}/${id}/file`,
			undefined,
			signal,
			undefined,
			digest,
		);
		if (
			!(value instanceof Uint8Array) ||
			value.length !== intended.entry.file.bytes ||
			(await cloudFileBytesSha256(value)) !== intended.entry.file.fileSha256
		)
			throw new Error("Company File review content changed");
		signal.throwIfAborted();
		return { bytes: value, planSha256: digest };
	}

	#command(value: unknown): CloudMemberCompanyCommand {
		const input = record(value, [
			"commandId",
			"environmentId",
			"companyId",
			"plan",
			"planSha256",
			"state",
			"expiresAt",
			"result",
		]);
		if (
			input.environmentId !== this.#options.environmentId ||
			input.companyId !== this.#options.companyId ||
			!["ready", "review_required", "approved", "applied", "rejected"].includes(String(input.state)) ||
			typeof input.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(input.expiresAt))
		)
			throw new Error("Company File command scope changed");
		const intended = plan(input.plan);
		let result: CloudMemberCompanyCommand["result"] = null;
		if (input.state === "applied") {
			const applied = record(input.result);
			if (
				applied.state !== "applied" ||
				applied.path !== intended.path ||
				applied.operationKey !== intended.operationKey
			)
				throw new Error("Company File receipt changed");
			result = { version: uuid(applied.version), snapshotId: uuid(applied.snapshotId) };
		} else if (input.result !== null) throw new Error("Company File command is not applied");
		return {
			commandId: uuid(input.commandId),
			environmentId: this.#options.environmentId,
			companyId: this.#options.companyId,
			plan: intended,
			planSha256: hash(input.planSha256),
			state: input.state as CloudMemberCompanyCommand["state"],
			expiresAt: input.expiresAt,
			result,
		};
	}

	#proposal(value: unknown): CloudMemberCompanyProposal {
		const input = record(value, ["proposalId", "plan", "planSha256", "state", "snapshotId"]);
		if (!["open", "approved", "applied", "rejected", "withdrawn"].includes(String(input.state)))
			throw new Error("Invalid Company File proposal");
		if ((input.state === "applied") !== (input.snapshotId !== null))
			throw new Error("Invalid Company File proposal receipt");
		return {
			proposalId: uuid(input.proposalId),
			plan: plan(input.plan),
			planSha256: hash(input.planSha256),
			state: input.state as CloudMemberCompanyProposal["state"],
			snapshotId: input.snapshotId === null ? null : uuid(input.snapshotId),
		};
	}

	async #pending(
		method: "qorpera_list_member_company_path_commands" | "qorpera_list_company_path_proposals",
		after: string | null,
		signal: AbortSignal,
	): Promise<{ items: unknown[]; nextAfter: string | null }> {
		if (after !== null) uuid(after);
		const input = record(await this.#rpc(method, { p_after: after, p_limit: 50 }, signal), ["items", "nextAfter"]);
		if (!Array.isArray(input.items) || input.items.length > 50) throw new Error("Invalid Company File review page");
		return { items: input.items, nextAfter: input.nextAfter === null ? null : uuid(input.nextAfter) };
	}

	#rpc(
		method:
			| "qorpera_list_company_paths"
			| "qorpera_list_member_company_path_commands"
			| "qorpera_list_company_path_proposals",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#request(false, method, { p_environment_id: this.#options.environmentId, ...args }, signal);
	}

	#request(
		gateway: boolean,
		endpoint: string,
		body: unknown,
		signal: AbortSignal,
		upload?: { bytes: Uint8Array<ArrayBuffer>; metadata: Record<string, unknown> },
		binaryPlan?: string,
	): Promise<unknown> {
		return withCloudDeadline(
			async (deadline) => {
				let token: string;
				try {
					token = await this.#options.accessToken(deadline);
				} catch {
					throw new Error("Member sign-in is unavailable");
				}
				deadline.throwIfAborted();
				if (typeof token !== "string" || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
					throw new Error("Member sign-in is unavailable");
				const url = gateway
					? `${this.#gateway}/v1/member-company-file/${this.#options.environmentId}/${endpoint}`
					: `${this.#control}/rest/v1/rpc/${endpoint}`;
				const request: RequestInit & Pick<Request, "cache"> = {
					method: upload ? "PUT" : body === undefined ? "GET" : "POST",
					redirect: "error",
					cache: "no-store",
					signal: deadline,
					headers: {
						authorization: `Bearer ${token}`,
						...(gateway ? {} : { apikey: this.#options.publishableKey }),
						...(upload
							? {
									"content-type": "application/octet-stream",
									"x-qorpera-company-upload": btoa(
										String.fromCharCode(...encoder.encode(JSON.stringify(upload.metadata))),
									)
										.replaceAll("+", "-")
										.replaceAll("/", "_")
										.replace(/=+$/, ""),
								}
							: body === undefined
								? {}
								: { "content-type": "application/json" }),
					},
					...(upload ? { body: upload.bytes } : body === undefined ? {} : { body: JSON.stringify(body) }),
				};
				const response = await this.#fetch(url, request);
				if (response.status !== 200) {
					void response.body?.cancel().catch(() => undefined);
					if (response.status === 409)
						throw new Error("Company File changed. Reload this path before editing again.");
					if (response.status === 401 || response.status === 403)
						throw new Error("Company File access was denied. Check your membership or sign in again.");
					// A 400 is a definite refusal before anything was saved (for example a missing folder).
					if (response.status === 400)
						throw new Error(
							"Company File did not accept this change. Check that the folder exists and the name is allowed.",
						);
					throw new Error(
						"Company File is unavailable. A save may already have completed; check its status before retrying.",
					);
				}
				if (
					binaryPlan &&
					(response.headers.get("content-type") !== "application/octet-stream" ||
						response.headers.get("x-qorpera-plan-sha256") !== binaryPlan)
				) {
					void response.body?.cancel().catch(() => undefined);
					throw new Error("Company File review content changed");
				}
				const bytes = await readBoundedCloudResponse(
					response,
					binaryPlan ? MAX_UPLOAD_BYTES : gateway ? 256 * 1024 : 2 * 1024 * 1024,
					deadline,
				);
				deadline.throwIfAborted();
				if (binaryPlan) return bytes;
				try {
					return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
				} catch {
					throw new Error("Invalid Company File response");
				}
			},
			this.#options.timeoutMs ?? 30_000,
			signal,
		);
	}
}
