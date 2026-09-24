import { readBoundedCloudResponse } from "../../packages/cloud-client/src/cloud-request.ts";
import { type CloudCodingRepository, parseCloudCodingRepository } from "../../packages/contracts/src/cloud-coding.ts";
import type {
	CodingRepositoryCredentialScope,
	CodingRepositoryCredentials,
} from "../../packages/runner-orchestrator/src/coding-executor-host.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER = /^[A-Za-z0-9_.:-]{1,120}$/;
/** The broker's private runtime token: 32 random bytes, base64url. */
const RUNTIME_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** GitHub OAuth, app and personal access tokens: letters, digits, underscores. */
export const REPOSITORY_TOKEN = /^[A-Za-z0-9_]{20,512}$/;
const MAX_RESPONSE_BYTES = 4096;

/**
 * Repository access through the company's GitHub connection (bundle v88). For
 * each Git broker or GitHub API step the executor asks the company's secret
 * broker (`POST /v1/repository-credentials?company=<profileId>`, the shared
 * origin routes by company) for the token of one session it holds; the broker
 * asks the kernel, which checks the lease, the repository grant and the
 * agent's grant on the company connection. The token is lent to `use` only:
 * never cached, stored, logged or passed to the repository VM. Every failure
 * is the same opaque error; a refusal is never retried with another credential.
 */
export class BrokerRepositoryCredentials implements CodingRepositoryCredentials {
	readonly #origin: string;
	readonly #runtimeToken: string;
	readonly #owner: string;
	readonly #fetch: typeof fetch;
	constructor(options: { origin: string; runtimeToken: string; executorOwner: string; fetch?: typeof fetch }) {
		const url = new URL(options.origin);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			!RUNTIME_TOKEN.test(options.runtimeToken) ||
			!OWNER.test(options.executorOwner)
		)
			throw new Error("CODING_REPOSITORY_BROKER_CONFIG_INVALID");
		this.#origin = url.origin;
		this.#runtimeToken = options.runtimeToken;
		this.#owner = options.executorOwner;
		this.#fetch = options.fetch ?? fetch;
	}

	async withRepositoryToken<T>(
		scope: CodingRepositoryCredentialScope,
		repository: CloudCodingRepository,
		use: (token: string) => Promise<T>,
		signal: AbortSignal,
	): Promise<T> {
		signal.throwIfAborted();
		if (![scope.companyId, scope.workerId, scope.leaseToken].every((value) => UUID.test(value)))
			throw new Error("CODING_REPOSITORY_CREDENTIAL_SCOPE_INVALID");
		const token = await this.#request(scope, parseCloudCodingRepository(repository), signal);
		signal.throwIfAborted();
		return use(token);
	}

	async #request(
		scope: CodingRepositoryCredentialScope,
		repository: CloudCodingRepository,
		signal: AbortSignal,
	): Promise<string> {
		const checked = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
		let bytes: Uint8Array | undefined;
		try {
			const response = await this.#fetch(
				`${this.#origin}/v1/repository-credentials?company=${scope.companyId.toLowerCase()}`,
				{
					method: "POST",
					redirect: "error",
					signal: checked,
					headers: { authorization: `Bearer ${this.#runtimeToken}`, "content-type": "application/json" },
					body: JSON.stringify({
						schema: "qorpera.coding-repository-credential-request/v1",
						workerId: scope.workerId.toLowerCase(),
						leaseToken: scope.leaseToken.toLowerCase(),
						executorOwner: this.#owner,
						repository,
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
				Object.keys(value).sort().join() !== "schema,token"
			)
				throw new Error("invalid");
			const answer = value as { schema: unknown; token: unknown };
			if (
				answer.schema !== "qorpera.coding-repository-credential/v1" ||
				typeof answer.token !== "string" ||
				!REPOSITORY_TOKEN.test(answer.token)
			)
				throw new Error("invalid");
			return answer.token;
		} catch {
			throw new Error("CODING_REPOSITORY_CREDENTIAL_UNAVAILABLE");
		} finally {
			bytes?.fill(0);
		}
	}
}
