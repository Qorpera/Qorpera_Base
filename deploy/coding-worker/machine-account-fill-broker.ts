import { readBoundedCloudResponse } from "../../packages/cloud-client/src/cloud-request.ts";
import type { CloudNativeToolBinding } from "../../packages/runtime/src/cloud-native-tool-authority.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER = /^[A-Za-z0-9_.:-]{1,120}$/;
/** The executor's own broker token: 32 random bytes, base64url. */
const EXECUTOR_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** The database's own refusals the agent can act on (cloud-company-account-vault.ts): a code and its words. */
const REFUSALS = new Set(["0A000", "22023", "23505", "54000"]);

/** One fill_company_account's vault side, as the machine's executor asks it: the run's call (its binding, receipt,
 * downstream key and envelope), where the helper runs and the helper's public key for this call. */
export interface MachineAccountFillSealRequest {
	readonly companyId: string;
	readonly binding: CloudNativeToolBinding;
	readonly receiptId: string;
	readonly idempotencyKey: string;
	readonly envelope: string;
	readonly placementId: string;
	readonly bootId: string;
	readonly fillPublicKey: string;
}

/**
 * fill_company_account's vault side (20260930781000), through the company's secret broker: `POST
 * /v1/machine-account-fills?company=<profileId>` (the shared origin routes by company) with the executor's own broker
 * token, as the coding environment's (coding-environment.ts); the runtime token every guest holds never opens it. The
 * broker asks the database, which checks the call, the machine's placement, boot and executor, and the account, then
 * seals the value to the helper's key. The answer is that box, which only the helper opens, or the database's refusal in
 * its own words. Nothing secret passes here. Every other failure is the same opaque error.
 */
export class BrokerMachineAccountFill {
	readonly #origin: string;
	readonly #executorToken: string;
	readonly #owner: string;
	readonly #fetch: typeof fetch;
	constructor(options: { origin: string; executorToken: string; executorOwner: string; fetch?: typeof fetch }) {
		let url: URL;
		try {
			url = new URL(options.origin);
		} catch {
			throw new Error("MACHINE_ACCOUNT_FILL_BROKER_UNAVAILABLE");
		}
		if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
			!EXECUTOR_TOKEN.test(options.executorToken) || !OWNER.test(options.executorOwner))
			throw new Error("MACHINE_ACCOUNT_FILL_BROKER_UNAVAILABLE");
		this.#origin = url.origin;
		this.#executorToken = options.executorToken;
		this.#owner = options.executorOwner;
		this.#fetch = options.fetch ?? fetch;
	}

	async seal(
		request: MachineAccountFillSealRequest,
		signal: AbortSignal,
	): Promise<{ box: Readonly<Record<string, string>> } | { refused: { code: string; message: string } }> {
		if (![request.companyId, request.receiptId, request.placementId, request.bootId].every((id) => UUID.test(id)))
			throw new Error("MACHINE_ACCOUNT_FILL_BROKER_UNAVAILABLE");
		const checked = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
		try {
			const response = await this.#fetch(`${this.#origin}/v1/machine-account-fills?company=${request.companyId}`, {
				method: "POST",
				redirect: "error",
				signal: checked,
				headers: { authorization: `Bearer ${this.#executorToken}`, "content-type": "application/json" },
				body: JSON.stringify({
					schema: "qorpera.company-account-machine-fill-request/v1",
					binding: request.binding,
					receiptId: request.receiptId,
					idempotencyKey: request.idempotencyKey,
					envelope: request.envelope,
					executorOwner: this.#owner,
					placementId: request.placementId,
					bootId: request.bootId,
					fillPublicKey: request.fillPublicKey,
				}),
			});
			if (response.status !== 200) {
				await response.body?.cancel().catch(() => undefined);
				throw new Error("refused");
			}
			const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(
				await readBoundedCloudResponse(response, 32768, checked))) as unknown;
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
			const answer = value as Record<string, unknown>;
			const keys = Object.keys(answer).sort().join();
			if (answer.schema === "qorpera.company-account-refusal/v1" && keys === "code,message,schema") {
				if (typeof answer.code !== "string" || !REFUSALS.has(answer.code) || typeof answer.message !== "string" ||
					!answer.message || answer.message.length > 512 || /[\0-\x1f\x7f]/.test(answer.message)) throw new Error("invalid");
				return { refused: { code: answer.code, message: answer.message } };
			}
			const box = answer.box;
			if (answer.schema !== "qorpera.company-account-fill-answer/v1" || keys !== "box,schema" || !box || typeof box !== "object" ||
				Array.isArray(box) || Object.keys(box).sort().join() !== "ciphertext,ephemeralPublicKey,iv,schema,tag" ||
				Object.values(box).some((part) => typeof part !== "string" || !/^[A-Za-z0-9_./-]{1,8192}$/.test(part)))
				throw new Error("invalid");
			return { box: Object.freeze({ ...(box as Record<string, string>) }) };
		} catch {
			throw new Error("MACHINE_ACCOUNT_FILL_BROKER_UNAVAILABLE");
		}
	}
}
