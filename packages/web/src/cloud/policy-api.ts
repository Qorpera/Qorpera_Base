import { parse as parseToml } from "smol-toml";
import { type CompanyPolicyConfig, parseCompanyPolicy, updateCompanyPolicySource } from "./company-policy.ts";
import { array, boundedInteger, oneOf, record, SHA256_PATTERN, timestamp, uuid } from "./parse.ts";
import { boundedResponse, type SettingsApi, sha256 } from "./settings-api.ts";

const PATH = "authority.toml";
const MAX_BYTES = 32 * 1024;
export interface PolicyDocument {
	source: string;
	version: string | null;
	policy: CompanyPolicyConfig;
}
export interface PolicyCommand {
	id: string;
	digest: string;
	state: "ready" | "review_required" | "approved" | "applied" | "rejected";
	plan: Record<string, unknown>;
	expiresAt: string;
}

function hash(value: unknown): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error("Invalid Company File digest.");
	return value;
}

function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
			: item,
	);
}

/** Policy is the protected authority.toml file, published through the human path-command protocol. */
export class PolicyApi {
	readonly #api: SettingsApi;
	constructor(api: SettingsApi) {
		this.#api = api;
	}
	async #descriptor(): Promise<Record<string, unknown>> {
		const input = record(
			await this.#api.rpc("qorpera_read_company_path", {
				p_environment_id: this.#api.profile.environmentId,
				p_binding: null,
				p_path: PATH,
			}),
			"policy file",
		);
		if (input.path !== PATH || input.companyId !== this.#api.profile.profileId)
			throw new Error("The cloud returned another policy file.");
		if (input.version !== null) uuid(input.version, "policy version");
		return input;
	}
	async read(): Promise<PolicyDocument> {
		const first = await this.#descriptor();
		if (first.entry === null && first.manifestBytes === null)
			return {
				source: "",
				version: first.version === null ? null : uuid(first.version, "policy version"),
				policy: parseCompanyPolicy(""),
			};
		const version = uuid(first.version, "policy version"),
			entry = record(first.entry, "policy entry");
		if (entry.path !== PATH || entry.kind !== "file" || entry.executable !== false)
			throw new Error("The policy file cannot be edited in settings.");
		const file = record(entry.file, "policy file reference");
		const bytes = boundedInteger(file.bytes, "policy file size", 0, MAX_BYTES);
		if (file.mediaType !== "application/octet-stream") throw new Error("Invalid policy file type.");
		const manifestSize = boundedInteger(first.manifestBytes, "policy manifest size", 1, MAX_BYTES);
		const manifestBytes = await this.#object(version, hash(file.manifestSha256), manifestSize);
		const manifest = record(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
			"policy manifest",
		);
		if (
			manifest.schema !== "qorpera.cloud-file-manifest/v1" ||
			manifest.bytes !== bytes ||
			manifest.fileSha256 !== hash(file.fileSha256) ||
			manifest.mediaType !== file.mediaType
		)
			throw new Error("The policy manifest does not match its file.");
		const chunks = array(manifest.chunks, "policy chunks");
		if (chunks.length > 1) throw new Error("Invalid policy chunk layout.");
		const content = new Uint8Array(bytes);
		let offset = 0;
		for (const item of chunks) {
			const chunk = record(item, "policy chunk"),
				length = boundedInteger(chunk.bytes, "policy chunk size", 1, bytes);
			const data = await this.#object(version, hash(chunk.sha256), length);
			content.set(data, offset);
			offset += data.length;
		}
		if (offset !== bytes || (await sha256(content)) !== file.fileSha256)
			throw new Error("Policy file integrity verification failed.");
		const source = new TextDecoder("utf-8", { fatal: true }).decode(content);
		if (source.includes("\0")) throw new Error("Policy must be a text file.");
		const current = await this.#descriptor();
		if (JSON.stringify(current) !== JSON.stringify(first))
			throw new Error("Policy changed while loading. Reload it.");
		return { source, version, policy: parseCompanyPolicy(source) };
	}
	async #object(version: string, digest: string, size: number): Promise<Uint8Array> {
		const api = this.#api;
		const { data } = await api.cloud.supabase.auth.getSession();
		api.signal.throwIfAborted();
		if (data.session?.user.id !== api.userId) throw new Error("Sign in again to read policy.");
		const response = await fetch(
			`${api.cloud.config.objectGatewayUrl}/v1/member-company-objects/${api.profile.environmentId}/${version}/${digest}`,
			{
				headers: {
					authorization: `Bearer ${data.session.access_token}`,
					"x-qorpera-company-path": btoa(PATH).replace(/=+$/, ""),
				},
				cache: "no-store",
				redirect: "error",
				signal: AbortSignal.any([api.signal, AbortSignal.timeout(30_000)]),
			},
		);
		if (response.status !== 200 || response.headers.get("x-qorpera-access-mode") !== "live-path-authority") {
			await response.body?.cancel();
			throw new Error("Policy file access is unavailable. Check your membership and try again.");
		}
		const bytes = await boundedResponse(response, size);
		if (bytes.length !== size || (await sha256(bytes)) !== digest)
			throw new Error("Policy file integrity verification failed.");
		return bytes;
	}
	async save(document: PolicyDocument, policy: CompanyPolicyConfig, operationKey: string): Promise<PolicyCommand> {
		const source = updateCompanyPolicySource(document.source, policy);
		const before = parseToml(document.source),
			after = parseToml(source);
		const expected = { ...before, policy: { ...((before.policy as Record<string, unknown>) ?? {}), ...policy } };
		// Reject unusual TOML layouts if the textual edit changed anything beyond the four controls.
		if (canonical(after) !== canonical(expected))
			throw new Error("This policy layout needs the Company File editor.");
		const text = new TextEncoder().encode(source);
		if (text.length > MAX_BYTES) throw new Error("The policy exceeds the settings editor’s size limit.");
		const command = this.#command(
			await this.#api.request(this.#url("edits"), {
				operation: "write",
				operationKey,
				path: PATH,
				expectedVersion: document.version,
				text: source,
			}),
		);
		const entry = record(command.plan.entry, "policy edit"),
			file = record(entry.file, "policy edit file");
		if (
			command.plan.operationKey !== operationKey ||
			command.plan.expectedVersion !== document.version ||
			entry.kind !== "file" ||
			entry.path !== PATH ||
			entry.executable !== false ||
			file.fileSha256 !== (await sha256(text)) ||
			file.bytes !== text.length ||
			file.mediaType !== "application/octet-stream"
		)
			throw new Error("The policy edit content changed.");
		return command;
	}
	async review(command: PolicyCommand, decision: "approve" | "reject"): Promise<PolicyCommand> {
		const result = this.#command(
			await this.#api.request(this.#url(`edits/${command.id}/review`), { planSha256: command.digest, decision }),
		);
		if (
			result.id !== command.id ||
			result.digest !== command.digest ||
			JSON.stringify(result.plan) !== JSON.stringify(command.plan)
		)
			throw new Error("The policy review changed.");
		return result;
	}
	async status(command: PolicyCommand): Promise<PolicyCommand> {
		const result = this.#command(await this.#api.request(this.#url(`edits/${command.id}`)));
		if (
			result.id !== command.id ||
			result.digest !== command.digest ||
			JSON.stringify(result.plan) !== JSON.stringify(command.plan)
		)
			throw new Error("The policy command changed.");
		return result;
	}
	#url(path: string): string {
		return `${this.#api.cloud.config.objectGatewayUrl}/v1/member-company-file/${this.#api.profile.environmentId}/${path}`;
	}
	#command(value: unknown): PolicyCommand {
		const input = record(value, "policy command"),
			plan = record(input.plan, "policy plan");
		if (
			input.companyId !== this.#api.profile.profileId ||
			input.environmentId !== this.#api.profile.environmentId ||
			plan.schema !== "qorpera.company-path-mutation/v1" ||
			plan.path !== PATH
		)
			throw new Error("The policy command scope changed.");
		const state = oneOf(
			input.state,
			["ready", "review_required", "approved", "applied", "rejected"],
			"policy command state",
		);
		if (state === "applied") {
			const result = record(input.result, "policy receipt");
			if (result.state !== "applied" || result.path !== PATH || result.operationKey !== plan.operationKey)
				throw new Error("Invalid policy receipt.");
			uuid(result.version, "applied policy version");
			uuid(result.snapshotId, "policy snapshot");
		} else if (input.result !== null) throw new Error("Policy is not applied.");
		return {
			id: uuid(input.commandId, "policy command"),
			digest: hash(input.planSha256),
			state,
			plan,
			expiresAt: timestamp(input.expiresAt, "policy command expiry"),
		};
	}
}
