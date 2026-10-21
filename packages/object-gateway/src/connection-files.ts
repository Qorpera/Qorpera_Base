import {
	COMPANY_STATE_NAME_MAX_CHARS,
	COMPANY_STATE_PARSER_VERSION,
	type CompanyStateSetting,
	type ConnectionFile,
	HOOK_PROOFS,
	type HookFile,
	type MailboxFile,
	parseCompanyStateFile,
	setCompanyStateSettings,
	WEBSITE_TWO_STEP,
	writeConnectionFile,
	writeHookFile,
	writeMailboxFile,
} from "@qorpera/cloud-client/company-state-files";
import type { MemberCompanyAuthority } from "./member-company-authority.ts";
import { UUID } from "./native-objects.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import {
	commitUnitOutcome,
	drainPlatformClaims,
	PlatformFolderProblem,
	PlatformFolderWriter,
	type PlatformFolderWriterOptions,
	platformFolderProblem,
	platformFolderProblemCode,
	record,
} from "./platform-folder-writer.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

/*
 * The vault's connection-file writer (core C3, P22b; deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2 "How it is
 * written"). The vault marks a company connection's file due in its own transaction (P22a); this writer claims one
 * due connection at a time, brings `connections/<name>.md` to what the claim says (write, or delete when the account
 * is gone), commits it as the platform in one unit, and finishes the claim. The vault stays the authority: no tool
 * reads the file to act, and the file may trail the vault by seconds.
 *
 * Nothing secret ever reaches the file: the settings come from the claim's allow-list only, a claim carrying any
 * other field is refused unread, and the text below the settings is the company's own (kept as it is). Problems are
 * reported as codes, never with a message. Built switched off: the gateway runs it only with
 * QORPERA_CONNECTION_FILE_WRITER=1.
 *
 * Since E1 (folder core C4, 20260930060000) a claim's subject is a vault secret, a hook or a mailbox (`subjectKind`), and
 * the file is connections/<name>.md, connections/hook-<name>.md or connections/mailbox-<name>.md. A hook's file never
 * shows its address (a capability) or a signing secret, and a new one starts with the hook's purpose (`body`). A claim
 * without `subjectKind` (before E1's migration) is a vault secret's.
 */

const SHA256 = /^[0-9a-f]{64}$/;
const OPERATION = /^[a-z][a-z0-9_]{0,63}$/;
/** Each subject's own file names: a vault file never takes a hook's or a mailbox's prefix. */
const SUBJECT_PATHS = {
	vault: /^connections\/(?!hook-|mailbox-)[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
	hook: /^connections\/hook-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
	mailbox: /^connections\/mailbox-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
} as const;
export type ConnectionSubjectKind = keyof typeof SUBJECT_PATHS;
/** Every field a claim may carry; any other refuses it (E1 adds subjectKind, and body for a hook or a mailbox). */
const CLAIM_KEYS = [
	"schema",
	"secretId",
	"environmentId",
	"generation",
	"attempt",
	"operationKey",
	"leaseUntil",
	"marks",
	"present",
	"settings",
	"path",
	"current",
] as const;
/** The allow-list of a connection file's settings (P22a's): nothing else of the vault's rows is written. */
const SETTINGS_KEYS = ["id", "service", "account", "status", "actions", "connectedBy", "connectedAt"] as const;
const WEBSITE_KEYS = ["site", "twoStep", "openedFor"] as const;
const CURRENT_KEYS = ["path", "version", "manifestSha256", "fileSha256", "bytes", "mediaType"] as const;
const STATUSES = new Set(["connected", "broken", "pending", "needs_person"]);
/** The allow-lists of a hook's and a mailbox's settings (E1's state): never an address of a hook, never a secret. */
const HOOK_KEYS = ["id", "name", "proof", "status", "maxBodyBytes", "perMinute", "createdBy", "createdAt"] as const;
const MAILBOX_KEYS = ["id", "address", "status", "createdBy", "createdAt"] as const;
const HOOK_STATUSES = new Set(["active", "paused"]);
const MEDIA_TYPE = "text/markdown";
/** A structured file is at most 64 KiB (core §5). */
const MAX_FILE_BYTES = 64 * 1024;
/** A taken name is numbered -2, -3 …, at most this many times. */
const NAME_TRIES = 20;
/** A claim and a finish get their own short deadline, so a drain that ran out of time still takes and closes a claim
 * whole. */
const FINISH_MS = 15_000;

export type ConnectionSettings = Omit<ConnectionFile, "kind" | "purpose">;
export type HookSettings = Omit<HookFile, "kind" | "purpose">;
export type MailboxSettings = Omit<MailboxFile, "kind" | "purpose">;

interface CurrentFile {
	readonly path: string;
	readonly version: string;
	readonly manifestSha256: string;
	readonly fileSha256: string;
	readonly bytes: number;
	readonly mediaType: string;
}

export interface ConnectionFileClaim {
	readonly subjectKind: ConnectionSubjectKind;
	readonly secretId: string;
	readonly environmentId: string;
	readonly generation: number;
	readonly operationKey: string;
	/** False: the file goes (a revoked secret, a closed account). */
	readonly present: boolean;
	readonly settings: ConnectionSettings | HookSettings | MailboxSettings | null;
	/** A hook's or a mailbox's purpose, which a new file starts with; null for a vault secret's. */
	readonly body: string | null;
	/** A new file's path. */
	readonly path: string | null;
	readonly current: CurrentFile | null;
}

const problem = platformFolderProblem;

/** A commit's reason as a problem code the finish accepts; anything else is `refused`. */
const reasonCode = (reason: string): string => (/^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "refused");

/** Text of 1 to `max` characters, counted as the database and the parser count them (code points). */
const text = (value: unknown, max: number): string =>
	typeof value === "string" && value.length >= 1 && [...value].length <= max ? value : problem("claim_invalid");

/** The claim's settings, by the allow-list: a field outside it, or a value of the wrong shape, refuses the claim. */
export function parseConnectionSettings(value: unknown): ConnectionSettings {
	const website = (value as Record<string, unknown> | null)?.service === "website";
	const input = record(value, website ? [...SETTINGS_KEYS, ...WEBSITE_KEYS] : SETTINGS_KEYS, "claim_invalid");
	const actions = input.actions;
	if (!Array.isArray(actions) || actions.some((action) => typeof action !== "string" || !OPERATION.test(action)))
		problem("claim_invalid");
	const status = text(input.status, 32);
	if (!STATUSES.has(status) || (!website && status !== "connected" && status !== "broken")) problem("claim_invalid");
	const settings = {
		id: UUID.test(text(input.id, 36)) ? (input.id as string) : problem("claim_invalid"),
		service: /^[a-z][a-z0-9_-]{0,63}$/.test(text(input.service, 64))
			? (input.service as string)
			: problem("claim_invalid"),
		account: text(input.account, 254),
		status: status as ConnectionSettings["status"],
		actions: actions as string[],
		connectedBy: UUID.test(text(input.connectedBy, 36)) ? (input.connectedBy as string) : problem("claim_invalid"),
		connectedAt: text(input.connectedAt, 40),
	};
	if (!website) return settings;
	const twoStep = text(input.twoStep, 16);
	if (!(WEBSITE_TWO_STEP as readonly string[]).includes(twoStep)) problem("claim_invalid");
	if (input.openedFor !== null && !(typeof input.openedFor === "string" && UUID.test(input.openedFor)))
		problem("claim_invalid");
	return {
		...settings,
		site: text(input.site, 253),
		twoStep: twoStep as ConnectionSettings["twoStep"],
		openedFor: input.openedFor as string | null,
	};
}

const UUID_TEXT = (value: unknown): string =>
	typeof value === "string" && UUID.test(value) ? value : problem("claim_invalid");
const WHOLE = (value: unknown, min: number, max: number): number =>
	Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
		? (value as number)
		: problem("claim_invalid");

/** A hook's claimed settings, by E1's allow-list. */
export function parseHookSettings(value: unknown): HookSettings {
	const input = record(value, HOOK_KEYS, "claim_invalid");
	const name = text(input.name, 64);
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) problem("claim_invalid");
	if (!(HOOK_PROOFS as readonly unknown[]).includes(input.proof)) problem("claim_invalid");
	if (!HOOK_STATUSES.has(text(input.status, 16))) problem("claim_invalid");
	return {
		id: UUID_TEXT(input.id),
		name,
		proof: input.proof as HookSettings["proof"],
		status: input.status as HookSettings["status"],
		maxBodyBytes: WHOLE(input.maxBodyBytes, 1024, 262144),
		perMinute: WHOLE(input.perMinute, 1, 120),
		createdBy: UUID_TEXT(input.createdBy),
		createdAt: text(input.createdAt, 40),
	};
}

/** A mailbox's claimed settings, by E1's allow-list. */
export function parseMailboxSettings(value: unknown): MailboxSettings {
	const input = record(value, MAILBOX_KEYS, "claim_invalid");
	const address = text(input.address, 254);
	if (!/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?@[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(address))
		problem("claim_invalid");
	if (!HOOK_STATUSES.has(text(input.status, 16))) problem("claim_invalid");
	return {
		id: UUID_TEXT(input.id),
		address,
		status: input.status as MailboxSettings["status"],
		createdBy: UUID_TEXT(input.createdBy),
		createdAt: text(input.createdAt, 40),
	};
}

/** The subject a claim names: `subjectKind` when it carries one (E1), else a vault secret. */
function claimSubjectKind(input: Record<string, unknown> | null): ConnectionSubjectKind {
	if (!input || !Object.hasOwn(input, "subjectKind")) return "vault";
	const kind = input.subjectKind;
	return kind === "vault" || kind === "hook" || kind === "mailbox" ? kind : problem("claim_invalid");
}

/** The operation key the database gives a subject's claim. */
export function connectionFileOperationKey(kind: ConnectionSubjectKind, id: string, generation: number): string {
	return `${kind === "vault" ? "connection" : kind}-file:${id}:${generation}`;
}

/** A claim answer (`qorpera.connection-file-claim/v1`), checked field by field; null when nothing is due. */
export function parseConnectionFileClaim(value: unknown): ConnectionFileClaim | null {
	if (value === null) return null;
	const kind = claimSubjectKind(value && typeof value === "object" ? (value as Record<string, unknown>) : null);
	const keys = [
		...CLAIM_KEYS,
		...(Object.hasOwn(value as object, "subjectKind") ? ["subjectKind"] : []),
		...(kind === "vault" ? [] : ["body"]),
	];
	const input = record(value, keys, "claim_invalid");
	if (
		input.schema !== "qorpera.connection-file-claim/v1" ||
		typeof input.secretId !== "string" ||
		!UUID.test(input.secretId) ||
		typeof input.environmentId !== "string" ||
		!UUID.test(input.environmentId) ||
		!Number.isSafeInteger(input.generation) ||
		(input.generation as number) < 1 ||
		input.operationKey !== connectionFileOperationKey(kind, input.secretId, input.generation as number) ||
		typeof input.present !== "boolean"
	)
		problem("claim_invalid");
	let current: CurrentFile | null = null;
	if (input.current !== null) {
		const file = record(input.current, CURRENT_KEYS, "claim_invalid");
		if (
			typeof file.path !== "string" ||
			!file.path.startsWith("connections/") ||
			typeof file.version !== "string" ||
			!UUID.test(file.version) ||
			typeof file.manifestSha256 !== "string" ||
			!SHA256.test(file.manifestSha256) ||
			typeof file.fileSha256 !== "string" ||
			!SHA256.test(file.fileSha256) ||
			!Number.isSafeInteger(file.bytes) ||
			(file.bytes as number) < 0 ||
			typeof file.mediaType !== "string"
		)
			problem("claim_invalid");
		current = file as unknown as CurrentFile;
	}
	const present = input.present as boolean;
	if (present && (typeof input.path !== "string" || !SUBJECT_PATHS[kind].test(input.path))) problem("claim_invalid");
	if (!present && (input.settings !== null || input.path !== null)) problem("claim_invalid");
	let body: string | null = null;
	if (kind !== "vault") {
		if (present)
			body = typeof input.body === "string" && [...input.body].length <= 512 ? input.body : problem("claim_invalid");
		else if (input.body !== null) problem("claim_invalid");
	}
	const settings = !present
		? null
		: kind === "hook"
			? parseHookSettings(input.settings)
			: kind === "mailbox"
				? parseMailboxSettings(input.settings)
				: parseConnectionSettings(input.settings);
	if (settings && settings.id !== input.secretId) problem("claim_invalid");
	return {
		subjectKind: kind,
		secretId: input.secretId as string,
		environmentId: input.environmentId as string,
		generation: input.generation as number,
		operationKey: input.operationKey as string,
		present,
		settings,
		body,
		path: present ? (input.path as string) : null,
		current,
	};
}

/** The file's settings as setCompanyStateSettings names them. */
function settingsChanges(settings: ConnectionSettings): Record<string, CompanyStateSetting> {
	return {
		id: settings.id,
		service: settings.service,
		account: settings.account,
		status: settings.status,
		actions: [...settings.actions],
		connected_by: settings.connectedBy,
		connected_at: settings.connectedAt,
		site: settings.site ?? null,
		two_step: settings.twoStep ?? null,
		opened_for: settings.openedFor ?? null,
	};
}

/**
 * The file's text for the claim's settings. An existing connection file keeps every byte but the settings that
 * changed (its text below them is the company's, and its layout the writer's or a member's); a file the parser
 * refuses keeps its text below the settings block; a new file is the canonical writer's.
 */
export function connectionFileText(path: string, settings: ConnectionSettings, current: string | null): string {
	if (current !== null) {
		const parsed = parseCompanyStateFile(path, current);
		if (parsed?.ok && parsed.file.kind === "connection") {
			const file = parsed.file;
			const before: Record<string, unknown> = {
				id: file.id,
				service: file.service,
				account: file.account,
				status: file.status,
				actions: file.actions,
				connected_by: file.connectedBy,
				connected_at: file.connectedAt,
				site: file.site,
				two_step: file.twoStep,
				opened_for: file.openedFor,
			};
			const changes = Object.fromEntries(
				Object.entries(settingsChanges(settings)).filter(
					([key, value]) => JSON.stringify(before[key] ?? null) !== JSON.stringify(value ?? null),
				),
			);
			return Object.keys(changes).length ? setCompanyStateSettings(current, changes) : current;
		}
	}
	return writeConnectionFile({ ...settings, purpose: current === null ? "" : bodyOf(current) });
}

/** A hook's settings as setCompanyStateSettings names them. */
function hookChanges(settings: HookSettings): Record<string, CompanyStateSetting> {
	return {
		id: settings.id,
		name: settings.name,
		proof: settings.proof,
		status: settings.status,
		max_body_bytes: settings.maxBodyBytes,
		per_minute: settings.perMinute,
		created_by: settings.createdBy,
		created_at: settings.createdAt,
	};
}

/** A mailbox's settings as setCompanyStateSettings names them. */
function mailboxChanges(settings: MailboxSettings): Record<string, CompanyStateSetting> {
	return {
		id: settings.id,
		address: settings.address,
		status: settings.status,
		created_by: settings.createdBy,
		created_at: settings.createdAt,
	};
}

/**
 * A hook's or a mailbox's file text for the claim's settings (E1), as connectionFileText does a vault file's: an existing
 * file of the kind keeps every byte but the settings that changed; anything else keeps its text below the settings; a new
 * file is the canonical writer's, starting with the hook's purpose.
 */
export function hookFileText(
	kind: "hook" | "mailbox",
	path: string,
	settings: HookSettings | MailboxSettings,
	current: string | null,
	body: string | null,
): string {
	const changes =
		kind === "hook" ? hookChanges(settings as HookSettings) : mailboxChanges(settings as MailboxSettings);
	if (current !== null) {
		const parsed = parseCompanyStateFile(path, current);
		if (parsed?.ok && parsed.file.kind === kind) {
			const before = (
				kind === "hook" ? hookChanges(parsed.file as HookFile) : mailboxChanges(parsed.file as MailboxFile)
			) as Record<string, unknown>;
			const changed = Object.fromEntries(
				Object.entries(changes).filter(
					([key, value]) => JSON.stringify(before[key] ?? null) !== JSON.stringify(value),
				),
			);
			return Object.keys(changed).length ? setCompanyStateSettings(current, changed) : current;
		}
	}
	const purpose = current === null ? (body ?? "") : bodyOf(current);
	return kind === "hook"
		? writeHookFile({ ...(settings as HookSettings), purpose })
		: writeMailboxFile({ ...(settings as MailboxSettings), purpose });
}

/** The text below a settings block, trimmed as a parse keeps it; the whole text when there is no block. */
function bodyOf(text: string): string {
	const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split("\n");
	const bare = (line: string) => line.replace(/\r$/, "");
	const close =
		bare(lines[0] ?? "") === "---" ? lines.findIndex((line, index) => index > 0 && bare(line) === "---") : -1;
	return (close < 0 ? text : lines.slice(close + 1).join("\n")).trim();
}

/** The next name to try after `path` was taken: -2, -3 …, cut so the name stays within the name rule. */
export function numberedConnectionPath(path: string, number: number): string {
	const base = path.slice("connections/".length, -".md".length);
	const suffix = `-${number}`;
	return `connections/${base.slice(0, COMPANY_STATE_NAME_MAX_CHARS - suffix.length).replace(/-$/, "")}${suffix}.md`;
}

export interface ConnectionFileWriterOptions {
	readonly workerId: string;
	readonly authority: Pick<MemberCompanyAuthority, "publisher">;
	readonly store: Pick<FileSystemObjectStore, "get">;
	readonly replication: Pick<ObjectGatewayReplication, "uploadWithAuthority">;
	/** Where a file this gateway's store lacks is read instead (PlatformFolderWriter's). */
	readonly readFallback?: PlatformFolderWriterOptions["readFallback"];
	readonly leaseSeconds?: number;
}

export class ConnectionFileWriter {
	readonly #options: ConnectionFileWriterOptions;
	readonly #folder: PlatformFolderWriter;
	readonly #leaseSeconds: number;

	constructor(options: ConnectionFileWriterOptions) {
		if (!UUID.test(options.workerId)) throw new Error("Connection file writer identity is invalid");
		this.#options = options;
		this.#folder = new PlatformFolderWriter(options);
		this.#leaseSeconds = options.leaseSeconds ?? 120;
		if (!Number.isSafeInteger(this.#leaseSeconds) || this.#leaseSeconds < 30 || this.#leaseSeconds > 900)
			throw new Error("Connection file writer lease is invalid");
	}

	/** Writes due files until none is due or `max` were handled. Returns how many were handled. */
	writeDue(max = 20, signal: AbortSignal = AbortSignal.timeout(240_000)): Promise<number> {
		return drainPlatformClaims(max, () => this.writeOne(signal), signal);
	}

	/** Claims one due connection and brings its file to the claim; false when nothing is due. */
	async writeOne(signal: AbortSignal = AbortSignal.timeout(60_000)): Promise<boolean> {
		// The claim gets its own short deadline, as the finish does: a drain whose budget ends during the call would
		// otherwise reject a claim the database may already have committed.
		const answer = await this.#options.authority.publisher(
			"qorpera_claim_connection_file",
			{ p_worker: this.#options.workerId, p_lease_seconds: this.#leaseSeconds },
			AbortSignal.timeout(FINISH_MS),
		);
		let claim: ConnectionFileClaim | null;
		try {
			claim = parseConnectionFileClaim(answer);
		} catch (error) {
			// A claim that names its connection and generation is finished with the problem; anything else is left to its
			// lease.
			const input = answer as { secretId?: unknown; generation?: unknown } | null;
			if (
				error instanceof PlatformFolderProblem &&
				typeof input?.secretId === "string" &&
				UUID.test(input.secretId) &&
				Number.isSafeInteger(input.generation)
			) {
				let kind: ConnectionSubjectKind;
				try {
					kind = claimSubjectKind(answer as Record<string, unknown>);
				} catch {
					throw error;
				}
				await this.#finish(kind, input.secretId, input.generation as number, error.code);
			}
			throw error;
		}
		if (!claim) return false;
		let code: string | null = null;
		try {
			await this.#converge(claim, signal);
		} catch (error) {
			code = platformFolderProblemCode(error);
		}
		await this.#finish(claim.subjectKind, claim.secretId, claim.generation, code);
		return true;
	}

	async #converge(claim: ConnectionFileClaim, signal: AbortSignal): Promise<void> {
		const { current } = claim;
		if (!claim.present) {
			if (!current) return;
			const unit = commitUnitOutcome(
				await this.#folder.commit(
					claim.environmentId,
					claim.operationKey,
					[{ op: "delete", path: current.path, expectedVersion: current.version }],
					signal,
				),
			);
			// Not saved (a member moved the file meanwhile, say): back off; the next claim finds it through the index.
			if (unit.outcome !== "saved") problem(reasonCode(unit.reason ?? unit.outcome));
			return;
		}
		const fileKind = claim.subjectKind === "vault" ? "connection" : claim.subjectKind;
		let existing: string | null = null;
		if (current) {
			try {
				existing = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
					await this.#folder.read(claim.environmentId, current, MAX_FILE_BYTES, signal),
				);
			} catch (error) {
				if (error instanceof TypeError) problem("file_unreadable");
				throw error;
			}
		}
		let path = current?.path ?? (claim.path as string);
		const next =
			claim.subjectKind === "vault"
				? connectionFileText(path, claim.settings as ConnectionSettings, existing)
				: hookFileText(
						claim.subjectKind,
						path,
						claim.settings as HookSettings | MailboxSettings,
						existing,
						claim.body,
					);
		if (existing !== null && next === existing) return;
		const bytes = new TextEncoder().encode(next);
		if (bytes.byteLength > MAX_FILE_BYTES) return problem("file_too_large");
		// The same bytes under any name: staged once.
		const file = await this.#folder.stage(
			claim.environmentId,
			bytes,
			{ mediaType: MEDIA_TYPE, executable: false },
			signal,
		);
		for (let attempt = 1; attempt <= NAME_TRIES; attempt++) {
			const parsed = parseCompanyStateFile(path, next);
			if (!parsed?.ok || parsed.file.kind !== fileKind) return problem("file_invalid");
			const unit = commitUnitOutcome(
				await this.#folder.commit(
					claim.environmentId,
					attempt === 1 ? claim.operationKey : `${claim.operationKey}:${attempt}`,
					[
						{
							op: "write",
							path,
							file,
							structured: [
								{
									path,
									kind: fileKind,
									text: next,
									parse: parsed.file,
									parserVersion: COMPANY_STATE_PARSER_VERSION,
								},
							],
							...(current ? { expectedVersion: current.version } : {}),
						},
					],
					signal,
				),
			);
			if (unit.outcome === "saved") return;
			// A new file whose name another file took gets the next number; anything else is the claim's problem.
			if (current || unit.reason !== "exists") return problem(reasonCode(unit.reason ?? unit.outcome));
			path = numberedConnectionPath(claim.path as string, attempt + 1);
		}
		problem("name_taken");
	}

	/** Closes a claim on its own short deadline. `finished: false` means another writer holds the connection now: its
	 * claim converges the file, so there is nothing to do. */
	async #finish(
		kind: ConnectionSubjectKind,
		secretId: string,
		generation: number,
		code: string | null,
	): Promise<void> {
		const answer = (await this.#options.authority.publisher(
			"qorpera_finish_connection_file",
			{
				p_worker: this.#options.workerId,
				p_secret_id: secretId,
				p_generation: generation,
				p_problem: code,
				// A vault secret's finish names no kind, so a database from before E1 takes it as before.
				...(kind === "vault" ? {} : { p_subject_kind: kind }),
			},
			AbortSignal.timeout(FINISH_MS),
		)) as { schema?: unknown; finished?: unknown } | null;
		if (answer?.schema !== "qorpera.connection-file-finish/v1" || typeof answer.finished !== "boolean")
			problem("finish_invalid");
	}
}
