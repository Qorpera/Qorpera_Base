import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRecord, parseUuid, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import { CLAUDE_LOGIN_FILES, CLAUDE_LOGIN_FILES_SCHEMA, claudeLoginFile } from "./cloud-model-login-sign-in.ts";
import { CLAUDE_LOGIN_FIELD, checkClaudeLoginFiles } from "./cloud-model-login-vault-sign-in.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

export type ClaudeLoginFileName = (typeof CLAUDE_LOGIN_FILES)[number];
export type ClaudeLoginFiles = Readonly<Partial<Record<ClaudeLoginFileName, string>>>;
export type ClaudeRenewalPurpose = "open" | "poll";

export type ClaudeLoginCheck =
	| { readonly outcome: "renewed"; readonly credentials: string }
	| { readonly outcome: "unchanged" | "refused" | "failed" };

export const CLAUDE_LOGIN_CHECK_SCHEMA = "qorpera.claude-login-check/v1";
export const CLAUDE_LOGIN_CHECK_REQUEST_SCHEMA = "qorpera.claude-login-check-request/v1";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CLAUDE_FILE_BYTES = 16 * 1024;
const OPEN_WAIT_MS = 8_000;
const CHECK_BUDGET_MS = 45_000;
const SAVE_DEADLINE_MS = 15_000;
const IDLE_PER_PASS = 4;
const BUSY_RETRY_MS = 500;

async function zeroFile(path: string, size: number): Promise<void> {
	const handle = await open(path, "r+");
	try {
		const zeros = Buffer.alloc(Math.min(size, 1 << 20));
		for (let at = 0; at < size; at += zeros.length)
			await handle.write(zeros, 0, Math.min(zeros.length, size - at), at);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function wipeClaudeLoginFolder(folder: string): Promise<void> {
	const walk = async (dir: string): Promise<void> => {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(dir, name);
			let metadata: Awaited<ReturnType<typeof lstat>>;
			try {
				metadata = await lstat(path);
			} catch {
				continue;
			}
			if (metadata.isDirectory()) await walk(path);
			else if (metadata.isFile() && metadata.size > 0) await zeroFile(path, metadata.size).catch(() => undefined);
		}
	};
	await walk(folder);
	await rm(folder, { recursive: true, force: true });
}

export function claudeLoginCheckFiles(value: unknown): ClaudeLoginFiles {
	const input = parseRecord(value, "Claude login files");
	const names = Object.keys(input);
	if (
		!names.includes(".credentials.json") ||
		names.some((name) => !(CLAUDE_LOGIN_FILES as readonly string[]).includes(name))
	)
		throw new Error("Claude login files are invalid");
	const files: Partial<Record<ClaudeLoginFileName, string>> = {};
	for (const name of CLAUDE_LOGIN_FILES) {
		const text = input[name];
		if (text === undefined) continue;
		if (typeof text !== "string" || !BASE64.test(text) || text.length > Math.ceil(MAX_CLAUDE_FILE_BYTES / 3) * 4)
			throw new Error("Claude login files are invalid");
		files[name] = text;
	}
	return files;
}

export function parseClaudeLoginCheck(value: unknown): ClaudeLoginCheck {
	const input = parseRecord(value, "Claude login check");
	if (input.schema !== CLAUDE_LOGIN_CHECK_SCHEMA) throw new Error("Claude login check is invalid");
	if (input.outcome === "renewed") {
		if (
			Object.keys(input).length !== 3 ||
			typeof input.credentials !== "string" ||
			!BASE64.test(input.credentials) ||
			input.credentials.length > Math.ceil(MAX_CLAUDE_FILE_BYTES / 3) * 4
		)
			throw new Error("Claude login check is invalid");
		return { outcome: "renewed", credentials: input.credentials };
	}
	if (
		Object.keys(input).length !== 2 ||
		(input.outcome !== "unchanged" && input.outcome !== "refused" && input.outcome !== "failed")
	)
		throw new Error("Claude login check is invalid");
	return { outcome: input.outcome };
}

export function claudeStatusLoggedIn(output: string): boolean | undefined {
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const status = JSON.parse(output.slice(start, end + 1)) as { loggedIn?: unknown };
		return typeof status.loggedIn === "boolean" ? status.loggedIn : undefined;
	} catch {
		return undefined;
	}
}

export interface ClaudeLoginStatusDriver {
	claudeLoginStatus(
		identityRoot: string,
		signal: AbortSignal,
	): Promise<{ readonly exitedOk: boolean; readonly loggedIn: boolean | undefined }>;
}

export async function checkClaudeLogin(
	options: { readonly driver: ClaudeLoginStatusDriver; readonly temporaryRoot: string },
	files: ClaudeLoginFiles,
	signal: AbortSignal,
): Promise<ClaudeLoginCheck> {
	const sent = claudeLoginCheckFiles(files);
	const root = await mkdtemp(join(options.temporaryRoot, "qorpera-claude-check-"));
	const before = Buffer.from(sent[".credentials.json"] as string, "base64");
	let after: Buffer | undefined;
	try {
		await mkdir(join(root, "claude"), { mode: 0o700 });
		for (const name of CLAUDE_LOGIN_FILES) {
			const text = sent[name];
			if (text === undefined) continue;
			const bytes = Buffer.from(text, "base64");
			try {
				await writeFile(join(root, "claude", name), bytes, { mode: 0o600, flag: "wx" });
			} finally {
				bytes.fill(0);
			}
		}
		let status: Awaited<ReturnType<ClaudeLoginStatusDriver["claudeLoginStatus"]>>;
		try {
			status = await options.driver.claudeLoginStatus(root, signal);
		} catch {
			return { outcome: "failed" };
		}
		if (status.loggedIn === false) return { outcome: "refused" };
		if (!status.exitedOk || status.loggedIn !== true) return { outcome: "failed" };
		try {
			after = await claudeLoginFile(join(root, "claude", ".credentials.json"));
		} catch {
			return { outcome: "failed" };
		}
		if (after.byteLength < 2) return { outcome: "failed" };
		return after.equals(before)
			? { outcome: "unchanged" }
			: { outcome: "renewed", credentials: after.toString("base64") };
	} finally {
		before.fill(0);
		after?.fill(0);
		await wipeClaudeLoginFolder(root).catch(() => undefined);
	}
}

export interface ClaudeLoginChecker {
	checkClaudeLogin(files: ClaudeLoginFiles, signal: AbortSignal): Promise<ClaudeLoginCheck>;
}

export interface ClaudeLoginRenewalAuthority {
	takeClaudeLoginRenewal(
		request: { readonly claudeLoginId: string; readonly purpose: ClaudeRenewalPurpose },
		signal: AbortSignal,
	): Promise<unknown>;
	takeIdleClaudeLoginRenewal(signal: AbortSignal): Promise<unknown>;
	commitClaudeLoginRenewal(
		commit: {
			readonly claudeLoginId: string;
			readonly token: string;
			readonly baseVersion: number;
			readonly baseEnvelopeSha256: string;
			readonly keyId: string;
			readonly encryptedEnvelope: Uint8Array;
			readonly envelopeSha256: string;
		},
		signal: AbortSignal,
	): Promise<unknown>;
	releaseClaudeLoginRenewal(
		release: {
			readonly claudeLoginId: string;
			readonly token: string;
			readonly outcome: "unchanged" | "refused" | "failed";
		},
		signal: AbortSignal,
	): Promise<unknown>;
}

interface TakenRenewal {
	readonly claudeLoginId: string;
	readonly memberId: string;
	readonly keyId: string;
	readonly version: number;
	readonly envelopeSha256: string;
	readonly envelope: Buffer;
	readonly token: string;
}

function parseTaken(value: unknown): TakenRenewal | "busy" | null {
	const input = parseRecord(value, "Claude login renewal");
	if (input.schema !== "qorpera.claude-login-renewal/v1") throw new Error("Claude login renewal is invalid");
	if (input.renewal === null) {
		const keys = Object.keys(input).sort().join();
		if (keys === "renewal,schema") return null;
		if (keys !== "busy,renewal,schema" || typeof input.busy !== "boolean")
			throw new Error("Claude login renewal is invalid");
		return input.busy ? "busy" : null;
	}
	if (
		Object.keys(input).sort().join() !==
		"claudeLoginId,encryptedEnvelopeBase64,envelopeSha256,keyId,ownerUserId,renewal,schema,version"
	)
		throw new Error("Claude login renewal is invalid");
	const renewal = parseRecord(input.renewal, "Claude login renewal");
	if (
		Object.keys(renewal).sort().join() !== "baseVersion,token" ||
		typeof input.version !== "number" ||
		!Number.isSafeInteger(input.version) ||
		input.version < 1 ||
		renewal.baseVersion !== input.version ||
		typeof input.keyId !== "string" ||
		!KEY_ID.test(input.keyId) ||
		typeof input.envelopeSha256 !== "string" ||
		!SHA256_HEX_PATTERN.test(input.envelopeSha256) ||
		typeof input.encryptedEnvelopeBase64 !== "string"
	)
		throw new Error("Claude login renewal is invalid");
	const envelope = Buffer.from(input.encryptedEnvelopeBase64, "base64");
	if (envelope.byteLength < 1 || createHash("sha256").update(envelope).digest("hex") !== input.envelopeSha256) {
		envelope.fill(0);
		throw new Error("Claude login renewal is invalid");
	}
	return {
		claudeLoginId: parseUuid(input.claudeLoginId, "Claude login renewal"),
		memberId: parseUuid(input.ownerUserId, "Claude login renewal"),
		keyId: input.keyId,
		version: input.version,
		envelopeSha256: input.envelopeSha256,
		envelope,
		token: parseUuid(renewal.token, "Claude login renewal"),
	};
}

export type ClaudeRenewalResult = "renewed" | "unchanged" | "refused" | "signed_out" | "failed" | "busy" | "none";

export class CloudClaudeLoginRenewer {
	readonly #authority: ClaudeLoginRenewalAuthority;
	readonly #checker: ClaudeLoginChecker;
	readonly #keys: CloudSecretKeyring;
	readonly #openWaitMs: number;
	readonly #inFlight = new Map<string, Promise<ClaudeRenewalResult>>();

	constructor(options: {
		authority: ClaudeLoginRenewalAuthority;
		checker: ClaudeLoginChecker;
		keyring: CloudSecretKeyring;
		openWaitMs?: number;
	}) {
		this.#authority = options.authority;
		this.#checker = options.checker;
		this.#keys = options.keyring;
		this.#openWaitMs = options.openWaitMs ?? OPEN_WAIT_MS;
	}

	check(claudeLoginId: string, purpose: ClaudeRenewalPurpose): Promise<ClaudeRenewalResult> {
		const id = parseUuid(claudeLoginId, "Claude login");
		const running = this.#inFlight.get(id);
		if (running) return running;
		const started = (async (): Promise<ClaudeRenewalResult> => {
			const taken = parseTaken(
				await this.#authority.takeClaudeLoginRenewal(
					{ claudeLoginId: id, purpose },
					AbortSignal.timeout(SAVE_DEADLINE_MS),
				),
			);
			if (taken === "busy") return "busy";
			return taken ? this.#renew(taken) : "none";
		})().finally(() => this.#inFlight.delete(id));
		this.#inFlight.set(id, started);
		return started;
	}

	async checkForRun(claudeLoginId: string, purpose: ClaudeRenewalPurpose): Promise<"renewed" | "not_renewed"> {
		const until = Date.now() + this.#openWaitMs;
		let waitedOnAnother = false;
		for (;;) {
			const checking = this.check(claudeLoginId, purpose).catch((): ClaudeRenewalResult => "failed");
			let timer: ReturnType<typeof setTimeout> | undefined;
			const waited = new Promise<"waited">((resolve) => {
				timer = setTimeout(() => resolve("waited"), Math.max(0, until - Date.now()));
				timer.unref?.();
			});
			let result: ClaudeRenewalResult | "waited";
			try {
				result = await Promise.race([checking, waited]);
			} finally {
				clearTimeout(timer);
			}
			if (result === "renewed") return "renewed";
			if (result !== "busy" || Date.now() + BUSY_RETRY_MS >= until)
				return waitedOnAnother ? "renewed" : "not_renewed";
			waitedOnAnother = true;
			await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS).unref?.());
		}
	}

	async idle(): Promise<number> {
		let checked = 0;
		for (; checked < IDLE_PER_PASS; checked += 1) {
			const taken = parseTaken(
				await this.#authority.takeIdleClaudeLoginRenewal(AbortSignal.timeout(SAVE_DEADLINE_MS)),
			);
			if (!taken || taken === "busy") break;
			await this.#renew(taken);
		}
		return checked;
	}

	async #renew(taken: TakenRenewal): Promise<ClaudeRenewalResult> {
		let files: ClaudeLoginFiles;
		try {
			files = await this.#opened(taken);
		} catch {
			await this.#release(taken, "failed");
			return "failed";
		} finally {
			taken.envelope.fill(0);
		}
		let check: ClaudeLoginCheck;
		try {
			check = await this.#checker.checkClaudeLogin(files, AbortSignal.timeout(CHECK_BUDGET_MS));
		} catch {
			check = { outcome: "failed" };
		}
		if (check.outcome !== "renewed") {
			const released = await this.#release(taken, check.outcome);
			return released === "signed_out" ? "signed_out" : check.outcome;
		}
		const next: Partial<Record<ClaudeLoginFileName, string>> = { ...files, ".credentials.json": check.credentials };
		const text = JSON.stringify({ schema: CLAUDE_LOGIN_FILES_SCHEMA, files: next });
		checkClaudeLoginFiles(text);
		const envelope = this.#keys.sealMember(
			{ [CLAUDE_LOGIN_FIELD]: text },
			{ memberId: taken.memberId, loginId: taken.claudeLoginId, version: taken.version + 1, keyId: taken.keyId },
		);
		const envelopeSha256 = createHash("sha256").update(envelope).digest("hex");
		try {
			for (let attempt = 0; ; attempt += 1) {
				try {
					const answer = parseRecord(
						await this.#authority.commitClaudeLoginRenewal(
							{
								claudeLoginId: taken.claudeLoginId,
								token: taken.token,
								baseVersion: taken.version,
								baseEnvelopeSha256: taken.envelopeSha256,
								keyId: taken.keyId,
								encryptedEnvelope: envelope,
								envelopeSha256,
							},
							AbortSignal.timeout(SAVE_DEADLINE_MS),
						),
						"Claude login renewal commit",
					);
					if (answer.schema !== "qorpera.claude-login-renewal-commit/v1")
						throw new Error("Claude login renewal commit is invalid");
					if (answer.state === "sealed") {
						if (answer.version !== taken.version + 1 || answer.envelopeSha256 !== envelopeSha256)
							throw new Error("Claude login renewal commit is invalid");
						return "renewed";
					}
					if (answer.state === "stale" || answer.state === "refused") return "none";
					throw new Error("Claude login renewal commit is invalid");
				} catch (error) {
					if (attempt >= 2) throw error;
					await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)).unref?.());
				}
			}
		} catch {
			console.error(
				"Claude login renewal: a renewed login could not be saved; its next check reads Claude Code again.",
			);
			return "failed";
		} finally {
			envelope.fill(0);
		}
	}

	async #opened(taken: TakenRenewal): Promise<ClaudeLoginFiles> {
		if (!this.#keys.hasMemberKey(taken.keyId)) throw new Error("The vault does not keep Claude logins");
		return this.#keys.useMember(
			taken.envelope,
			{ memberId: taken.memberId, loginId: taken.claudeLoginId, version: taken.version, keyId: taken.keyId },
			async (fields) => {
				const text = fields[CLAUDE_LOGIN_FIELD];
				if (Object.keys(fields).length !== 1 || typeof text !== "string")
					throw new Error("Claude login envelope is another kind of login");
				checkClaudeLoginFiles(text);
				return claudeLoginCheckFiles((JSON.parse(text) as { files: unknown }).files);
			},
		);
	}

	async #release(
		taken: TakenRenewal,
		outcome: "unchanged" | "refused" | "failed",
	): Promise<"released" | "signed_out" | "stale" | "unknown"> {
		try {
			const answer = parseRecord(
				await this.#authority.releaseClaudeLoginRenewal(
					{ claudeLoginId: taken.claudeLoginId, token: taken.token, outcome },
					AbortSignal.timeout(SAVE_DEADLINE_MS),
				),
				"Claude login renewal release",
			);
			if (
				answer.schema !== "qorpera.claude-login-renewal-release/v1" ||
				(answer.state !== "released" && answer.state !== "signed_out" && answer.state !== "stale")
			)
				return "unknown";
			return answer.state;
		} catch {
			return "unknown";
		}
	}
}
