import { readBoundedCloudResponse } from "../../packages/cloud-client/src/cloud-request.ts";
import { CODING_GUEST } from "../../packages/contracts/src/cloud-coding-guest.ts";
import type {
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
const RESERVED_PREFIX = /^(LC|GIT|LD|DYLD|QORPERA|SSH|XDG|DOCKER|ANTHROPIC|CLAUDE|CODEX|OPENAI)_/;
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
 * guest run request of at most 64 KiB, so a larger answer could never start one. */
const MAX_RESPONSE_BYTES = CODING_GUEST.maxInputBytes;

/**
 * A session's vault environment through the company's secret broker (F3 5j-4). For each command it starts, the
 * executor asks the broker (`POST /v1/coding-environment?company=<profileId>`, the shared origin routes by company)
 * for the environment of one session it holds, with the executor's own broker token (a value no guest holds; the
 * brokers' runtime token does not open this route). The broker asks the kernel, which checks the lease. The values go
 * to the command's processes and its output's mask only: kept in the executor's memory while the session is attached,
 * never written, logged or put in an error. Every failure is the same opaque error.
 */
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

	async environment(scope: CodingEnvironmentScope, signal: AbortSignal): Promise<Readonly<Record<string, string>>> {
		signal.throwIfAborted();
		if (![scope.companyId, scope.workerId, scope.leaseToken].every((value) => UUID.test(value)))
			throw new Error("CODING_ENVIRONMENT_UNAVAILABLE");
		const environment = await this.#request(scope, signal);
		signal.throwIfAborted();
		return environment;
	}

	async #request(scope: CodingEnvironmentScope, signal: AbortSignal): Promise<Readonly<Record<string, string>>> {
		const checked = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
		let bytes: Uint8Array | undefined;
		try {
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
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.keys(value).sort().join() !== "environment,schema"
			)
				throw new Error("invalid");
			const answer = value as { schema: unknown; environment: unknown };
			const environment = answer.environment;
			if (
				answer.schema !== "qorpera.coding-environment/v1" ||
				!environment ||
				typeof environment !== "object" ||
				Array.isArray(environment) ||
				!Object.entries(environment).every(
					([name, setting]) =>
						ENVIRONMENT_NAME.test(name) &&
						!RESERVED_PREFIX.test(name) &&
						!RESERVED.has(name) &&
						typeof setting === "string" &&
						Buffer.byteLength(setting) >= CODING_SECRET_MASK_MINIMUM_BYTES &&
						Buffer.byteLength(setting) <= MAX_VALUE_BYTES &&
						!setting.includes("\0") &&
						// A lone surrogate is no UTF-8: the guest refuses it, and the mask would look for other bytes.
						!/[\ud800-\udfff]/u.test(setting),
				)
			)
				throw new Error("invalid");
			return Object.freeze({ ...(environment as Record<string, string>) });
		} catch {
			throw new Error("CODING_ENVIRONMENT_UNAVAILABLE");
		} finally {
			bytes?.fill(0);
		}
	}
}
