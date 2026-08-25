import type {
	CloudRunnerAssignmentDelivery,
	CloudRunnerCapability,
	CloudRunnerInstance,
	CloudRunnerProviderAdapter,
	CloudRunnerWork,
} from "./orchestrator.ts";

const PROVIDER_RESPONSE_LIMIT_BYTES = 64 * 1024;
// A full-VM provider may legitimately spend up to five minutes booting and
// proving guest readiness before acquire returns. Keep the transport boundary
// above that backend contract so the orchestrator can renew its durable claim
// instead of releasing a healthy but still-booting machine.
const PROVIDER_REQUEST_TIMEOUT_MS = 10 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADAPTER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

type CloudRunnerProviderRequest =
	| { schema: "qorpera.runner-provider/v1"; action: "reconcile"; adapter_id: string }
	| {
			schema: "qorpera.runner-provider/v1";
			action: "acquire";
			adapter_id: string;
			acquisition_id: string;
			work: CloudRunnerWork;
	  }
	| {
			schema: "qorpera.runner-provider/v1";
			action: "deliver";
			adapter_id: string;
			runner: CloudRunnerInstance;
			delivery: CloudRunnerAssignmentDelivery;
	  }
	| {
			schema: "qorpera.runner-provider/v1";
			action: "stop";
			adapter_id: string;
			runner: CloudRunnerInstance;
			reason: "delivery_failed" | "idle" | "revoked";
	  };

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Runner provider returned invalid ${label}`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedKeys = new Set(allowed);
	if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
		throw new Error(`Runner provider returned unknown ${label} field`);
	}
}

function parseRunnerInstance(value: unknown, adapterId: string): CloudRunnerInstance {
	const input = record(value, "runner instance");
	exactKeys(
		input,
		[
			"runner_id",
			"logical_computer_id",
			"compute_identity_id",
			"worker_class",
			"provider_adapter",
			"capabilities",
			"template_key",
			"template_version",
			"policy_sha256",
		],
		"runner instance",
	);
	if (
		typeof input.runner_id !== "string" ||
		!UUID_PATTERN.test(input.runner_id) ||
		(input.logical_computer_id !== null &&
			input.logical_computer_id !== undefined &&
			(typeof input.logical_computer_id !== "string" || !UUID_PATTERN.test(input.logical_computer_id))) ||
		(input.compute_identity_id !== null &&
			input.compute_identity_id !== undefined &&
			(typeof input.compute_identity_id !== "string" || !UUID_PATTERN.test(input.compute_identity_id))) ||
		(input.worker_class !== "managed_sandbox" && input.worker_class !== "company_computer") ||
		input.provider_adapter !== adapterId ||
		!Array.isArray(input.capabilities) ||
		input.capabilities.length < 1 ||
		input.capabilities.length > 3 ||
		new Set(input.capabilities).size !== input.capabilities.length ||
		!input.capabilities.every(
			(capability) =>
				capability === "agent_turn" || capability === "git_worktree" || capability === "company_substrate",
		) ||
		typeof input.template_key !== "string" ||
		!/^[a-z][a-z0-9._-]{0,119}$/.test(input.template_key) ||
		typeof input.template_version !== "string" ||
		input.template_version !== input.template_version.trim() ||
		input.template_version.length < 1 ||
		input.template_version.length > 120 ||
		/[\0\r\n]/.test(input.template_version) ||
		typeof input.policy_sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(input.policy_sha256)
	) {
		throw new Error("Runner provider returned invalid runner instance");
	}
	return {
		runnerId: input.runner_id,
		...(typeof input.logical_computer_id === "string" ? { logicalComputerId: input.logical_computer_id } : {}),
		...(typeof input.compute_identity_id === "string" ? { computeIdentityId: input.compute_identity_id } : {}),
		workerClass: input.worker_class,
		providerAdapter: adapterId,
		capabilities: input.capabilities as CloudRunnerCapability[],
		templateKey: input.template_key,
		templateVersion: input.template_version,
		policySha256: input.policy_sha256,
	};
}

export class CloudRunnerProviderRequestError extends Error {
	readonly status: number;

	constructor(status: number) {
		super(`Runner provider request failed (${status})`);
		this.name = "CloudRunnerProviderRequestError";
		this.status = status;
	}
}

/** HTTP boundary to a managed-computer provisioner. The provisioner receives
 * the plaintext job capability only during delivery; Supabase stores its hash. */
export class HttpCloudRunnerProviderAdapter implements CloudRunnerProviderAdapter {
	readonly adapterId: string;
	readonly #url: string;
	readonly #token: string;
	readonly #fetch: typeof fetch;

	constructor(baseUrl: string, adapterId: string, token: string, fetchImplementation: typeof fetch = fetch) {
		const url = new URL("/v1/qorpera-runner-provider", baseUrl);
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
		) {
			throw new Error("Runner provider URL must use HTTPS");
		}
		if (!ADAPTER_PATTERN.test(adapterId)) throw new Error("Runner provider adapter id is invalid");
		if (!token.trim() || token.length > 4096 || /[\0\r\n]/.test(token)) {
			throw new Error("Runner provider service token is invalid");
		}
		this.adapterId = adapterId;
		this.#url = url.href;
		this.#token = token;
		this.#fetch = fetchImplementation;
	}

	async reconcile(signal?: AbortSignal): Promise<void> {
		await this.#request(
			{ schema: "qorpera.runner-provider/v1", action: "reconcile", adapter_id: this.adapterId },
			signal,
		);
	}

	async acquire(work: CloudRunnerWork, signal: AbortSignal): Promise<CloudRunnerInstance> {
		return parseRunnerInstance(
			await this.#request(
				{
					schema: "qorpera.runner-provider/v1",
					action: "acquire",
					adapter_id: this.adapterId,
					acquisition_id: work.runId,
					work: structuredClone(work),
				},
				signal,
			),
			this.adapterId,
		);
	}

	async deliver(
		runner: CloudRunnerInstance,
		delivery: CloudRunnerAssignmentDelivery,
		signal?: AbortSignal,
	): Promise<void> {
		await this.#request(
			{
				schema: "qorpera.runner-provider/v1",
				action: "deliver",
				adapter_id: this.adapterId,
				runner: structuredClone(runner),
				delivery: structuredClone(delivery),
			},
			signal,
		);
	}

	async stop(
		runner: CloudRunnerInstance,
		reason: "delivery_failed" | "idle" | "revoked",
		signal?: AbortSignal,
	): Promise<void> {
		await this.#request(
			{
				schema: "qorpera.runner-provider/v1",
				action: "stop",
				adapter_id: this.adapterId,
				runner: structuredClone(runner),
				reason,
			},
			signal,
		);
	}

	async #request(body: CloudRunnerProviderRequest, signal?: AbortSignal): Promise<unknown> {
		const requestSignal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS)])
			: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
		const response = await this.#fetch(this.#url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.#token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			redirect: "error",
			signal: requestSignal,
		});
		if (!response.ok) throw new CloudRunnerProviderRequestError(response.status);
		const encoded = await response.text();
		if (Buffer.byteLength(encoded) > PROVIDER_RESPONSE_LIMIT_BYTES) {
			throw new Error("Runner provider response exceeds its byte limit");
		}
		let value: unknown;
		try {
			value = JSON.parse(encoded) as unknown;
		} catch (error) {
			throw new Error("Runner provider returned invalid JSON", { cause: error });
		}
		const envelope = record(value, "response envelope");
		exactKeys(envelope, ["value"], "response envelope");
		return envelope.value;
	}
}
