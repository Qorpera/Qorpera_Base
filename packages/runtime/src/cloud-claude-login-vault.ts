import { createHash } from "node:crypto";
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
 * sent, until they are sealed); envelope bytes are zeroed once used.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** As the sign-in reads them: each login file holds 2 to 16 KiB. */
const MAX_CLAUDE_FILE_BYTES = 16 * 1024;

export type ClaudeLoginFileName = (typeof CLAUDE_LOGIN_FILES)[number];
/** Why the run's login cannot be used now: signed out (or replaced), or Claude Code is not open for its member. */
export type ClaudeLoginRefusal = "SIGNED_OUT" | "NOT_OPEN";

/** The database's side (the company's broker authority on the shared vault). */
export interface ClaudeLoginRunAuthority {
	openClaudeLoginForRun(binding: ModelLoginRunBinding, signal: AbortSignal): Promise<unknown>;
	describeClaudeLoginForRun(binding: ModelLoginRunBinding, signal: AbortSignal): Promise<unknown>;
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
	 * when Claude Code keeps one. No other file is sealed. */
	readonly files: Readonly<Record<string, string>>;
}

export type ClaudeLoginSealAnswer =
	| {
			readonly schema: "qorpera.claude-login-seal/v1";
			readonly state: "sealed" | "stale";
			readonly claudeLoginId: string;
			readonly version: number;
	  }
	| {
			readonly schema: "qorpera.claude-login-seal/v1";
			readonly state: "refused";
			readonly reason: ClaudeLoginRefusal;
	  };

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(`${label} is invalid`);
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} is invalid`);
	return value;
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
	const input = record(value, "Claude login files");
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
		const binding = parseModelLoginRunBinding(request.binding);
		const label = "Claude login for a run";
		const answer = record(await this.#authority.openClaudeLoginForRun(binding, signal), label);
		const reason = refused(answer, "qorpera.claude-login-for-run/v1", label);
		if (reason) return { schema: "qorpera.claude-login-files-for-run/v1", state: "refused", reason };
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
			!SHA.test(answer.envelopeSha256) ||
			typeof answer.encryptedEnvelopeBase64 !== "string"
		)
			throw new Error(`${label} is invalid`);
		const claudeLoginId = uuid(answer.claudeLoginId, label);
		const memberId = uuid(answer.ownerUserId, label);
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
						schema: "qorpera.claude-login-files-for-run/v1",
						state: "open",
						claudeLoginId,
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

	/** Seals the files the run host read back as the login's next version, if the version it opened is still the
	 * login's: else `stale`, and the newer envelope stays. */
	async sealBack(request: ClaudeLoginSealRequest, signal: AbortSignal): Promise<ClaudeLoginSealAnswer> {
		const binding = parseModelLoginRunBinding(request.binding);
		const label = "Claude login seal-back";
		const claudeLoginId = uuid(request.claudeLoginId, label);
		const baseVersion = version(request.baseVersion, label);
		if (typeof request.baseEnvelopeSha256 !== "string" || !SHA.test(request.baseEnvelopeSha256))
			throw new Error(`${label} is invalid`);
		const files = claudeLoginSealFiles(request.files);
		const described = record(await this.#authority.describeClaudeLoginForRun(binding, signal), label);
		const reason = refused(described, "qorpera.claude-login-for-run/v1", label);
		if (reason) return { schema: "qorpera.claude-login-seal/v1", state: "refused", reason };
		exactKeys(
			described,
			["schema", "state", "claudeLoginId", "ownerUserId", "keyId", "version", "envelopeSha256"],
			label,
		);
		if (described.state !== "described" || typeof described.keyId !== "string" || !KEY_ID.test(described.keyId))
			throw new Error(`${label} is invalid`);
		if (uuid(described.claudeLoginId, label) !== claudeLoginId)
			throw new Error("Claude login seal-back names another login");
		const memberId = uuid(described.ownerUserId, label);
		const current = version(described.version, label);
		// Another seal came first: nothing is sealed, the newer envelope stays.
		if (current !== baseVersion || described.envelopeSha256 !== request.baseEnvelopeSha256)
			return { schema: "qorpera.claude-login-seal/v1", state: "stale", claudeLoginId, version: current };
		if (!this.#keys.hasMemberKey(described.keyId)) throw new Error("The vault does not keep Claude logins");
		const text = JSON.stringify({ schema: CLAUDE_LOGIN_FILES_SCHEMA, files });
		checkClaudeLoginFiles(text);
		const envelope = this.#keys.sealMember(
			{ [CLAUDE_LOGIN_FIELD]: text },
			{ memberId, loginId: claudeLoginId, version: baseVersion + 1, keyId: described.keyId },
		);
		let answer: Record<string, unknown>;
		try {
			answer = record(
				await this.#authority.sealClaudeLoginBack(
					{
						binding,
						claudeLoginId,
						baseVersion,
						baseEnvelopeSha256: request.baseEnvelopeSha256,
						keyId: described.keyId,
						encryptedEnvelope: envelope,
						envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
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
			if (uuid(answer.claudeLoginId, label) !== claudeLoginId) throw new Error(`${label} is invalid`);
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
			uuid(answer.claudeLoginId, label) !== claudeLoginId ||
			version(answer.version, label) !== baseVersion + 1
		)
			throw new Error(`${label} is invalid`);
		return { schema: "qorpera.claude-login-seal/v1", state: "sealed", claudeLoginId, version: baseVersion + 1 };
	}
}
