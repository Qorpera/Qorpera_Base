import { isAbsolute, resolve } from "node:path";
import { FileRunnerOrchestratorControlTokenStore } from "./control-token-store.ts";
import { CloudRunnerOrchestrator, SupabaseCloudRunnerOrchestratorControlPlane } from "./orchestrator.ts";
import { HttpCloudRunnerProviderAdapter } from "./provider-http.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ADAPTER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export interface CloudRunnerOrchestratorServiceConfig {
	supabaseUrl: string;
	supabasePublishableKey: string;
	orchestratorId: string;
	orchestratorControlToken: string;
	orchestratorControlStatePath: string;
	providerUrl: string;
	providerAdapterId: string;
	providerServiceToken: string;
	pollIntervalMs: number;
	dispatchConcurrency: number;
}

export interface CloudRunnerOrchestratorServiceOptions {
	config: CloudRunnerOrchestratorServiceConfig;
	signal: AbortSignal;
	fetchImplementation?: typeof fetch;
	onError?: (error: unknown) => void;
}

function requiredEnvironmentValue(environment: Readonly<Record<string, string | undefined>>, name: string): string {
	const value = environment[name];
	if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) {
		throw new Error(`${name} is required`);
	}
	return value;
}

function serviceUrl(value: string, label: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
	) {
		throw new Error(`${label} must use HTTPS`);
	}
	return url.href;
}

export function cloudRunnerOrchestratorServiceConfigFromEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): CloudRunnerOrchestratorServiceConfig {
	const orchestratorId = requiredEnvironmentValue(environment, "QORPERA_RUNNER_ORCHESTRATOR_ID");
	const orchestratorControlToken = requiredEnvironmentValue(environment, "QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN");
	const orchestratorControlStatePath = requiredEnvironmentValue(
		environment,
		"QORPERA_RUNNER_ORCHESTRATOR_CONTROL_STATE",
	);
	const providerAdapterId = requiredEnvironmentValue(environment, "QORPERA_RUNNER_PROVIDER_ADAPTER");
	const pollValue = environment.QORPERA_RUNNER_ORCHESTRATOR_POLL_MS?.trim() || "2000";
	const pollIntervalMs = Number(pollValue);
	const dispatchConcurrency = Number(environment.QORPERA_RUNNER_ORCHESTRATOR_CONCURRENCY?.trim() || "8");
	if (!UUID_PATTERN.test(orchestratorId)) throw new Error("QORPERA_RUNNER_ORCHESTRATOR_ID is invalid");
	if (!TOKEN_PATTERN.test(orchestratorControlToken)) {
		throw new Error("QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN is invalid");
	}
	if (!isAbsolute(orchestratorControlStatePath)) {
		throw new Error("QORPERA_RUNNER_ORCHESTRATOR_CONTROL_STATE must be an absolute path");
	}
	if (!ADAPTER_PATTERN.test(providerAdapterId)) {
		throw new Error("QORPERA_RUNNER_PROVIDER_ADAPTER is invalid");
	}
	if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
		throw new Error("QORPERA_RUNNER_ORCHESTRATOR_POLL_MS is outside the supported range");
	}
	if (!Number.isSafeInteger(dispatchConcurrency) || dispatchConcurrency < 1 || dispatchConcurrency > 64) {
		throw new Error("QORPERA_RUNNER_ORCHESTRATOR_CONCURRENCY is outside the supported range");
	}
	return {
		supabaseUrl: serviceUrl(requiredEnvironmentValue(environment, "QORPERA_SUPABASE_URL"), "QORPERA_SUPABASE_URL"),
		supabasePublishableKey: requiredEnvironmentValue(environment, "QORPERA_SUPABASE_PUBLISHABLE_KEY"),
		orchestratorId,
		orchestratorControlToken,
		orchestratorControlStatePath: resolve(orchestratorControlStatePath),
		providerUrl: serviceUrl(
			requiredEnvironmentValue(environment, "QORPERA_RUNNER_PROVIDER_URL"),
			"QORPERA_RUNNER_PROVIDER_URL",
		),
		providerAdapterId,
		providerServiceToken: requiredEnvironmentValue(environment, "QORPERA_RUNNER_PROVIDER_TOKEN"),
		pollIntervalMs,
		dispatchConcurrency,
	};
}

export async function runCloudRunnerOrchestratorService(options: CloudRunnerOrchestratorServiceOptions): Promise<void> {
	const transport = options.fetchImplementation ?? fetch;
	const controlTokenStore = new FileRunnerOrchestratorControlTokenStore(options.config.orchestratorControlStatePath);
	const controlTokens = await controlTokenStore.load(options.config.orchestratorControlToken);
	const controlPlane = new SupabaseCloudRunnerOrchestratorControlPlane(
		options.config.supabaseUrl,
		options.config.supabasePublishableKey,
		options.config.orchestratorId,
		controlTokens.current,
		transport,
		{
			...(controlTokens.pending ? { pendingControlToken: controlTokens.pending } : {}),
			persistControlTokens: (state) => controlTokenStore.save(state),
		},
	);
	const providerAdapter = new HttpCloudRunnerProviderAdapter(
		options.config.providerUrl,
		options.config.providerAdapterId,
		options.config.providerServiceToken,
		transport,
	);
	const orchestrator = new CloudRunnerOrchestrator({
		orchestratorId: options.config.orchestratorId,
		controlPlane,
		providerAdapter,
		dispatchConcurrency: options.config.dispatchConcurrency,
	});
	await orchestrator.run(options.signal, {
		pollIntervalMs: options.config.pollIntervalMs,
		...(options.onError ? { onError: options.onError } : {}),
	});
}
