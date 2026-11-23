import { readBoundedCloudResponse } from "../../packages/cloud-client/src/cloud-request.ts";
import { withTimeoutSignal } from "./timeout-signal.ts";
import { CODING_GUEST } from "../../packages/contracts/src/cloud-coding-guest.ts";
import type {
	CodingEnvironmentAnswer,
	CodingEnvironmentScope,
	CodingEnvironmentSource,
} from "../../packages/runner-orchestrator/src/coding-command-secrets.ts";
import { CODING_SECRET_MASK_MINIMUM_BYTES } from "../../packages/runner-orchestrator/src/coding-secret-mask.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER = /^[A-Za-z0-9_.:-]{1,120}$/;
/** The executor's own broker token: 32 random bytes, base64url. */
const EXECUTOR_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** The vault's name rule in upper case (`qorpera_coding_environment_name_allowed`, 5j-1), kept equal by hand: names
 * the session's own setup, its shell and its tools read are not the vault's. */
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_PREFIX = /^(LC|GIT|LD|DYLD|QORPERA|SSH|XDG|DOCKER|CLAUDE|CODEX)_/;
const RESERVED = new Set([
	"HOME",
	"PATH",
	"TMPDIR",
	"TMP",
	"TEMP",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"OLDPWD",
	"TERM",
	"COLORTERM",
	"COLUMNS",
	"LINES",
	"LANG",
	"LANGUAGE",
	"TZ",
	"BASH_ENV",
	"ENV",
	"IFS",
	"PS1",
	"PS2",
	"PS4",
	"PROMPT_COMMAND",
	"SHELLOPTS",
	"BASHOPTS",
	"CDPATH",
	"GLOBIGNORE",
	"HOSTNAME",
	"SHLVL",
	"MAIL",
	"MAILPATH",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"FTP_PROXY",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
]);
/** A vault value's bytes: at least what the mask takes (the broker's own minimum), at most a vault field's 32 KiB. */
const MAX_VALUE_BYTES = 32 * 1024;
/** The broker bounds each name and value but not how many there are. A command takes its whole environment in one
 * guest run request of at most 64 KiB, so a larger environment could never start one. */
const MAX_ENVIRONMENT_BYTES = CODING_GUEST.maxInputBytes;
/** The most older values one answer masks (5j-4), as the broker and the database cap them. */
const MAX_MASK_VALUES = 64;
/** The answer with its mask: at most 64 older values from at most 256 KiB of envelopes (the database's bound), so
 * 2 MiB holds them even when JSON escapes every character. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// WHY: Fetches session env + machine mask history from the secret broker using the executor-only token;
// CodingMachineCommandSecrets caches answers per (session, vaultEnvVersion), so environment_secret_used
// audit rows are recorded once per session, version, and machine (or per command start without a version).
export class BrokerCodingEnvironment implements CodingEnvironmentSource {
	readonly #origin: string;
	readonly #executorToken: string;
	readonly #owner: string;
	readonly #fetch: typeof fetch;
	constructor(options: { origin: string; executorToken: string; executorOwner: string; fetch?: typeof fetch }) {
		let url: URL;
		try {
			url = new URL(options.origin);
		} catch {
			throw new Error("CODING_ENVIRONMENT_UNAVAILABLE");
		}
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			!EXECUTOR_TOKEN.test(options.executorToken) ||
			!OWNER.test(options.executorOwner)
		)
			throw new Error("CODING_ENVIRONMENT_UNAVAILABLE");
		this.#origin = url.origin;
		this.#executorToken = options.executorToken;
		this.#owner = options.executorOwner;
		this.#fetch = options.fetch ?? fetch;
	}

	async environment(scope: CodingEnvironmentScope, signal: AbortSignal): Promise<CodingEnvironmentAnswer> {
		signal.throwIfAborted();
		if (![scope.companyId, scope.workerId, scope.leaseToken].every((value) => UUID.test(value)))
			throw new Error("CODING_ENVIRONMENT_UNAVAILABLE");
		const answer = await this.#request(scope, signal);
		signal.throwIfAborted();
		return answer;
	}

	async #request(scope: CodingEnvironmentScope, signal: AbortSignal): Promise<CodingEnvironmentAnswer> {
		let bytes: Uint8Array | undefined;
		try {
			return await withTimeoutSignal(signal, 15000, async (checked) => {
				const response = await this.#fetch(
					`${this.#origin}/v1/coding-environment?company=${scope.companyId.toLowerCase()}`,
					{
						method: "POST",
						redirect: "error",
						signal: checked,
						headers: { authorization: `Bearer ${this.#executorToken}`, "content-type": "application/json" },
						body: JSON.stringify({
							schema: "qorpera.coding-environment-request/v1",
							workerId: scope.workerId.toLowerCase(),
							leaseToken: scope.leaseToken.toLowerCase(),
							executorOwner: this.#owner,
						}),
					},
				);
				if (response.status !== 200) {
					await response.body?.cancel().catch(() => undefined);
					throw new Error("refused");
				}
				bytes = await readBoundedCloudResponse(response, MAX_RESPONSE_BYTES, checked);
				const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as unknown;
				// A broker before 5j-4 answers no mask: then there is none.
				if (
					!value ||
					typeof value !== "object" ||
					Array.isArray(value) ||
					!["environment,schema", "environment,mask,schema"].includes(Object.keys(value).sort().join())
				)
					throw new Error("invalid");
				const answer = value as { schema: unknown; environment: unknown; mask?: unknown };
				const environment = answer.environment;
				const mask = Object.hasOwn(answer, "mask") ? answer.mask : [];
				if (
					answer.schema !== "qorpera.coding-environment/v1" ||
					!environment ||
					typeof environment !== "object" ||
					Array.isArray(environment) ||
					Buffer.byteLength(JSON.stringify(environment)) > MAX_ENVIRONMENT_BYTES ||
					!Object.entries(environment).every(
					([name, setting]) =>
						ENVIRONMENT_NAME.test(name) &&
						!RESERVED_PREFIX.test(name) &&
						!RESERVED.has(name) &&
						vaultValue(setting),
				) ||
				!Array.isArray(mask) ||
				mask.length > MAX_MASK_VALUES ||
				!mask.every(vaultValue)
			)
				throw new Error("invalid");
				return Object.freeze({
					environment: Object.freeze({ ...(environment as Record<string, string>) }),
					mask: Object.freeze([...(mask as string[])]),
				});
			});
		} catch {
			throw new Error("CODING_ENVIRONMENT_UNAVAILABLE");
		} finally {
			bytes?.fill(0);
		}
	}
}

/** A value the vault hands out, for the environment or the mask. */
function vaultValue(setting: unknown): boolean {
	return (
		typeof setting === "string" &&
		Buffer.byteLength(setting) >= CODING_SECRET_MASK_MINIMUM_BYTES &&
		Buffer.byteLength(setting) <= MAX_VALUE_BYTES &&
		!setting.includes("\0") &&
		// A lone surrogate is no UTF-8: the guest refuses it, and the mask would look for other bytes.
		!/[\ud800-\udfff]/u.test(setting)
	);
}
