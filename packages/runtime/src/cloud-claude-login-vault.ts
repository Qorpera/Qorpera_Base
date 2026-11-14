import { createHash } from "node:crypto";
import { parseRecord, parseUuid, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import { CLAUDE_LOGIN_FILES, CLAUDE_LOGIN_FILES_SCHEMA } from "./cloud-model-login-sign-in.ts";
import { type ModelLoginRunBinding, parseModelLoginRunBinding } from "./cloud-model-login-vault.ts";
import { CLAUDE_LOGIN_FIELD, checkClaudeLoginFiles } from "./cloud-model-login-vault-sign-in.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

/**
 * A member's Claude sign-in for ONE run of a Claude Code worker (agent-box slice C4b, migration 20260930771000; the
 * founder's word for his own first test). The shared vault keeps the sign-in Claude Code wrote at #1428's sign-in, sealed
 * under the member's key (`qorpera.claude-login-files/v1`). For a run the database names (the run host's binding, the
 * worker's recorded login, the member's lease), the vault opens it and hands the run host its files, and seals back the
 * files Claude Code changed (it renews its own token at start and rewrites `.credentials.json`), with a
 * compare-and-swap on the version the run opened.
 *
 * Nothing here renews a token, calls Anthropic or reads the files for its own use: their shape is checked
 * (checkClaudeLoginFiles) and nothing else. Nothing here logs. The plaintext exists only inside `open` (the opened
 * envelope's field, as the keyring hands it, and the answer built from it) and inside `sealBack` (the files the run host
 * sent and the version it opened, opened once more, until the next version is sealed); envelope bytes are zeroed once
 * used.
 */

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** As the sign-in reads them: each login file holds 2 to 16 KiB. */
const MAX_CLAUDE_FILE_BYTES = 16 * 1024;

export type ClaudeLoginFileName = (typeof CLAUDE_LOGIN_FILES)[number];
/** Why the run's login cannot be used now: signed out (or replaced), or Claude Code is not open for its member. */
export type ClaudeLoginRefusal = "SIGNED_OUT" | "NOT_OPEN";

/** The database's side (the company's broker authority on the shared vault). */
export interface ClaudeLoginRunAuthority {
	/** The open route's: only while the worker is at work. */
	openClaudeLoginForRun(binding: ModelLoginRunBinding, signal: AbortSignal): Promise<unknown>;
	/** The seal-back's re-open, and only the seal-back's: every check of the open but the worker at work. */
	openClaudeLoginForSealBack(binding: ModelLoginRunBinding, signal: AbortSignal): Promise<unknown>;
	sealClaudeLoginBack(
		seal: {
			binding: ModelLoginRunBinding;
			claudeLoginId: string;
			baseVersion: number;
			baseEnvelopeSha256: string;
			keyId: string;
			encryptedEnvelope: Uint8Array;
			envelopeSha256: string;
		},
		signal: AbortSignal,
	): Promise<unknown>;
}

/** What the run host receives: the login files (base64, as sealed), or why not. Exactly these keys. */
export type ClaudeLoginForRun =
	| {
			readonly schema: "qorpera.claude-login-files-for-run/v1";
			readonly state: "open";
			readonly claudeLoginId: string;
			readonly version: number;
			readonly envelopeSha256: string;
			readonly files: Readonly<Partial<Record<ClaudeLoginFileName, string>>>;
	  }
	| {
			readonly schema: "qorpera.claude-login-files-for-run/v1";
			readonly state: "refused";
			readonly reason: ClaudeLoginRefusal;
	  };

export interface ClaudeLoginSealRequest {
	readonly binding: ModelLoginRunBinding;
	readonly claudeLoginId: string;
	/** The version and envelope the run opened. */
	readonly baseVersion: number;
	readonly baseEnvelopeSha256: string;
	/** The login files as the run host read them back from the box, base64: `.credentials.json`, and `.claude.json`
	 * when the run host sends one. No other file is sealed; a login file it does not send stays as the run opened it. */
	readonly files: Readonly<Record<string, string>>;
}

/** A seal-back's answer. `sealed` names the new version and its envelope's digest, the base a later seal of the same
 * run starts from. `stale`: the login is not at the version the run named, so nothing was sealed; after a lost answer
 * the retry of a seal that was saved answers `stale` too, with the version named plus one. */
export type ClaudeLoginSealAnswer =
	| {
			readonly schema: "qorpera.claude-login-seal/v1";
			readonly state: "sealed";
			readonly claudeLoginId: string;
			readonly version: number;
			readonly envelopeSha256: string;
	  }
	| {
			readonly schema: "qorpera.claude-login-seal/v1";
			readonly state: "stale";
			readonly claudeLoginId: string;
			readonly version: number;
	  }
	| {
			readonly schema: "qorpera.claude-login-seal/v1";
			readonly state: "refused";
			readonly reason: ClaudeLoginRefusal;
	  };

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(`${label} is invalid`);
}

function version(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
	return value;
}

function refusal(value: unknown, label: string): ClaudeLoginRefusal {
	if (value !== "SIGNED_OUT" && value !== "NOT_OPEN") throw new Error(`${label} is invalid`);
	return value;
}

/** A database answer that refuses the login now, or null. */
function refused(answer: Record<string, unknown>, schema: string, label: string): ClaudeLoginRefusal | null {
	if (answer.schema !== schema) throw new Error(`${label} is invalid`);
	if (answer.state !== "refused") return null;
	exactKeys(answer, ["schema", "state", "reason"], label);
	return refusal(answer.reason, label);
}

/** The login files a run host may send back: only Claude Code's login files, `.credentials.json` among them, each a
 * base64 file of 2 bytes to 16 KiB, in the order the sign-in keeps them. */
export function claudeLoginSealFiles(value: unknown): Partial<Record<ClaudeLoginFileName, string>> {
	const input = parseRecord(value, "Claude login files");
	const names = Object.keys(input);
	if (
		!names.includes(".credentials.json") ||
		names.some((name) => !(CLAUDE_LOGIN_FILES as readonly string[]).includes(name))
	)
		throw new Error("Only Claude Code's login files are sealed back");
	const files: Partial<Record<ClaudeLoginFileName, string>> = {};
	for (const name of CLAUDE_LOGIN_FILES) {
		const text = input[name];
		if (text === undefined) continue;
		if (typeof text !== "string" || !BASE64.test(text) || text.length > Math.ceil(MAX_CLAUDE_FILE_BYTES / 3) * 4)
			throw new Error("Claude login files are invalid");
		const bytes = Buffer.from(text, "base64");
		const size = bytes.byteLength;
		bytes.fill(0);
		if (size < 2 || size > MAX_CLAUDE_FILE_BYTES) throw new Error("Claude login files are invalid");
		files[name] = text;
	}
	return files;
}

/** The shared vault's side: opens a run's Claude login and seals back what Claude Code changed. */
export class CloudClaudeLoginVault {
	readonly #authority: ClaudeLoginRunAuthority;
	readonly #keys: CloudSecretKeyring;

	constructor(options: { authority: ClaudeLoginRunAuthority; keyring: CloudSecretKeyring }) {
		this.#authority = options.authority;
		this.#keys = options.keyring;
	}

	/** The run's login files, only when the database says this run may have them now. */
	async open(request: { readonly binding: ModelLoginRunBinding }, signal: AbortSignal): Promise<ClaudeLoginForRun> {
		const opened = await this.#opened(
			parseModelLoginRunBinding(request.binding),
			"open",
			"Claude login for a run",
			signal,
		);
		if ("reason" in opened)
			return { schema: "qorpera.claude-login-files-for-run/v1", state: "refused", reason: opened.reason };
		return {
			schema: "qorpera.claude-login-files-for-run/v1",
			state: "open",
			claudeLoginId: opened.claudeLoginId,
			version: opened.version,
			envelopeSha256: opened.envelopeSha256,
			files: opened.files,
		};
	}

	/** Seals the files the run host read back as the login's next version, if the version it named is still the
	 * login's: else `stale`, and the newer envelope stays (a retry after a lost answer included: the vault opens the
	 * login again first and finds the version it sealed). A login file the run host did not send is kept as it was in
	 * the version it opened (C4c sends only `.credentials.json`). */
	async sealBack(request: ClaudeLoginSealRequest, signal: AbortSignal): Promise<ClaudeLoginSealAnswer> {
		const binding = parseModelLoginRunBinding(request.binding);
		const label = "Claude login seal-back";
		const claudeLoginId = parseUuid(request.claudeLoginId, label);
		const baseVersion = version(request.baseVersion, label);
		if (typeof request.baseEnvelopeSha256 !== "string" || !SHA256_HEX_PATTERN.test(request.baseEnvelopeSha256))
			throw new Error(`${label} is invalid`);
		const sent = claudeLoginSealFiles(request.files);
		// Its own re-open: a worker that has reported or was cancelled still seals back while its lease holds.
		const current = await this.#opened(binding, "seal-back", label, signal);
		if ("reason" in current)
			return { schema: "qorpera.claude-login-seal/v1", state: "refused", reason: current.reason };
		if (current.claudeLoginId !== claudeLoginId) throw new Error("Claude login seal-back names another login");
		// Another seal came first: nothing is sealed, the newer envelope stays.
		if (current.version !== baseVersion || current.envelopeSha256 !== request.baseEnvelopeSha256)
			return { schema: "qorpera.claude-login-seal/v1", state: "stale", claudeLoginId, version: current.version };
		const files: Partial<Record<ClaudeLoginFileName, string>> = {};
		for (const name of CLAUDE_LOGIN_FILES) {
			const text = sent[name] ?? current.files[name];
			if (text !== undefined) files[name] = text;
		}
		const text = JSON.stringify({ schema: CLAUDE_LOGIN_FILES_SCHEMA, files });
		checkClaudeLoginFiles(text);
		const envelope = this.#keys.sealMember(
			{ [CLAUDE_LOGIN_FIELD]: text },
			{ memberId: current.memberId, loginId: claudeLoginId, version: baseVersion + 1, keyId: current.keyId },
		);
		const envelopeSha256 = createHash("sha256").update(envelope).digest("hex");
		let answer: Record<string, unknown>;
		try {
			answer = parseRecord(
				await this.#authority.sealClaudeLoginBack(
					{
						binding,
						claudeLoginId,
						baseVersion,
						baseEnvelopeSha256: request.baseEnvelopeSha256,
						keyId: current.keyId,
						encryptedEnvelope: envelope,
						envelopeSha256,
					},
					signal,
				),
				label,
			);
		} finally {
			envelope.fill(0);
		}
		const sealReason = refused(answer, "qorpera.claude-login-seal/v1", label);
		if (sealReason) return { schema: "qorpera.claude-login-seal/v1", state: "refused", reason: sealReason };
		if (answer.state === "stale") {
			exactKeys(answer, ["schema", "state", "claudeLoginId", "version"], label);
			if (parseUuid(answer.claudeLoginId, label) !== claudeLoginId) throw new Error(`${label} is invalid`);
			return {
				schema: "qorpera.claude-login-seal/v1",
				state: "stale",
				claudeLoginId,
				version: version(answer.version, label),
			};
		}
		exactKeys(answer, ["schema", "state", "claudeLoginId", "version", "envelopeSha256"], label);
		if (
			answer.state !== "sealed" ||
			parseUuid(answer.claudeLoginId, label) !== claudeLoginId ||
			version(answer.version, label) !== baseVersion + 1 ||
			answer.envelopeSha256 !== envelopeSha256
		)
			throw new Error(`${label} is invalid`);
		return {
			schema: "qorpera.claude-login-seal/v1",
			state: "sealed",
			claudeLoginId,
			version: baseVersion + 1,
			envelopeSha256,
		};
	}

	/** The run's login as the database hands it now, opened under the member's key with the version in its identity; or
	 * the database's refusal of the login now. A run the database does not let have it is refused before (an error).
	 * `open` asks as the open route does; `seal-back` through the seal-back's own re-open. */
	async #opened(
		binding: ModelLoginRunBinding,
		purpose: "open" | "seal-back",
		label: string,
		signal: AbortSignal,
	): Promise<
		| { readonly reason: ClaudeLoginRefusal }
		| {
				readonly claudeLoginId: string;
				readonly memberId: string;
				readonly keyId: string;
				readonly version: number;
				readonly envelopeSha256: string;
				readonly files: Partial<Record<ClaudeLoginFileName, string>>;
		  }
	> {
		const answer = parseRecord(
			await (purpose === "open"
				? this.#authority.openClaudeLoginForRun(binding, signal)
				: this.#authority.openClaudeLoginForSealBack(binding, signal)),
			label,
		);
		const reason = refused(answer, "qorpera.claude-login-for-run/v1", label);
		if (reason) return { reason };
		exactKeys(
			answer,
			[
				"schema",
				"state",
				"claudeLoginId",
				"ownerUserId",
				"keyId",
				"version",
				"envelopeSha256",
				"encryptedEnvelopeBase64",
			],
			label,
		);
		if (
			answer.state !== "open" ||
			typeof answer.keyId !== "string" ||
			!KEY_ID.test(answer.keyId) ||
			typeof answer.envelopeSha256 !== "string" ||
			!SHA256_HEX_PATTERN.test(answer.envelopeSha256) ||
			typeof answer.encryptedEnvelopeBase64 !== "string"
		)
			throw new Error(`${label} is invalid`);
		const claudeLoginId = parseUuid(answer.claudeLoginId, label);
		const memberId = parseUuid(answer.ownerUserId, label);
		const loginVersion = version(answer.version, label);
		const keyId = answer.keyId;
		const envelopeSha256 = answer.envelopeSha256;
		if (!this.#keys.hasMemberKey(keyId)) throw new Error("The vault does not keep Claude logins");
		const envelope = Buffer.from(answer.encryptedEnvelopeBase64, "base64");
		try {
			if (envelope.byteLength < 1 || createHash("sha256").update(envelope).digest("hex") !== envelopeSha256)
				throw new Error(`${label} is invalid`);
			return await this.#keys.useMember(
				envelope,
				{ memberId, loginId: claudeLoginId, version: loginVersion, keyId },
				async (fields) => {
					const text = fields[CLAUDE_LOGIN_FIELD];
					if (Object.keys(fields).length !== 1 || typeof text !== "string")
						throw new Error("Claude login envelope is another kind of login");
					checkClaudeLoginFiles(text);
					return {
						claudeLoginId,
						memberId,
						keyId,
						version: loginVersion,
						envelopeSha256,
						files: claudeLoginSealFiles((JSON.parse(text) as { files: unknown }).files),
					};
				},
			);
		} finally {
			envelope.fill(0);
		}
	}
}
