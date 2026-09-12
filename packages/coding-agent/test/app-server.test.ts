/**
 * Per-company app server: fixed-shell state, runtime streams, and authorized
 * user actions. Company-authored UI files are deliberately not executable.
 */
import {
	appendFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CompanyConnectionRequestView,
	type CompanyScheduledJobView,
	createCompanyAppServer,
	type SessionRuntimeSnapshot,
	type SessionRuntimeSource,
	type SessionRuntimeUpdate,
} from "../src/core/app-server.ts";
import { discoverAuthority, evaluateToolCall } from "../src/core/authority.ts";
import { COMPANY_MANIFEST_RELATIVE_PATH, scaffoldCompany, scaffoldProductDepartment } from "../src/core/company.ts";
import type { CompanyArtifactRecord } from "../src/core/company-artifacts.ts";
import type { CompanyConnectorManifestRecord } from "../src/core/company-connectors.ts";
import { parseCompanyPolicy } from "../src/core/company-policy.ts";
import type { StaffAgent, StaffAgentMessage } from "../src/core/company-staff.ts";
import { LITELLM_RATES_URL, parseUsageRateTable, type UsageRateCatalog } from "../src/core/usage-pricing.ts";

let root: string;
let fixedShell: string;
let server: Server | undefined;
let base: string;
let runtimeSnapshot: SessionRuntimeSnapshot;
let runtimeListeners: Set<(update: SessionRuntimeUpdate) => void>;
let hiddenTrails: Set<string>;
let staffReadModel: () => readonly StaffAgent[];
let artifactReadModel: () => readonly CompanyArtifactRecord[];
let connectorReadModel: () => readonly CompanyConnectorManifestRecord[];
let artifactUpdateModel: (id: string, update: unknown) => CompanyArtifactRecord;
let connectionRequestReadModel: () => readonly CompanyConnectionRequestView[];
let scheduledJobReadModel: () => readonly CompanyScheduledJobView[];
let staffMessageReadModel: () => readonly StaffAgentMessage[];

const TEST_USAGE_RATE_CATALOG: UsageRateCatalog = {
	rates: parseUsageRateTable({
		"openai/gpt-5.3-codex": {
			input_cost_per_token: 0.000001,
			output_cost_per_token: 0.000002,
			cache_read_input_token_cost: 0.0000001,
		},
		"anthropic/claude-sonnet": {
			input_cost_per_token: 0.000003,
			output_cost_per_token: 0.000015,
			cache_read_input_token_cost: 0.0000003,
			cache_creation_input_token_cost: 0.00000375,
		},
	}),
	pricing: {
		status: "cached",
		source: LITELLM_RATES_URL,
		fetchedAt: "2026-08-09T00:00:00.000Z",
		knownModels: 2,
	},
};

beforeEach(async () => {
	root = join(realpathSync(tmpdir()), `qorpera-app-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fixedShell = join(
		realpathSync(tmpdir()),
		`qorpera-fixed-shell-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	scaffoldCompany(root);
	mkdirSync(fixedShell, { recursive: true });
	writeFileSync(join(fixedShell, "index.html"), "<h1>Qorpera staff shell</h1>", "utf-8");
	runtimeSnapshot = {
		revision: 0,
		generatedAt: "2026-08-14T08:00:00.000Z",
		sessions: [],
	};
	runtimeListeners = new Set();
	hiddenTrails = new Set();
	staffReadModel = () => [];
	artifactReadModel = () => [];
	connectorReadModel = () => [];
	artifactUpdateModel = () => {
		throw new Error("artifact update unavailable");
	};
	connectionRequestReadModel = () => [];
	scheduledJobReadModel = () => [];
	staffMessageReadModel = () => [];
	const sessionRuntime: SessionRuntimeSource = {
		snapshot: () => runtimeSnapshot,
		isTrailVisible: (trailFile) => !hiddenTrails.has(trailFile),
		subscribe: (listener) => {
			runtimeListeners.add(listener);
			return () => runtimeListeners.delete(listener);
		},
	};
	server = createCompanyAppServer({
		root,
		fixedShell: { directory: fixedShell },
		authToken: "test-token",
		usageRateCatalog: async () => TEST_USAGE_RATE_CATALOG,
		sessionRuntime,
		staffReadModel: () => staffReadModel(),
		artifactReadModel: () => artifactReadModel(),
		connectorReadModel: () => connectorReadModel(),
		artifactUpdateModel: (id, update) => artifactUpdateModel(id, update),
		connectionRequestReadModel: () => connectionRequestReadModel(),
		scheduledJobReadModel: () => scheduledJobReadModel(),
		staffMessageReadModel: () => staffMessageReadModel(),
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
	const address = server!.address() as { port: number };
	base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
	if (fixedShell && existsSync(fixedShell)) rmSync(fixedShell, { recursive: true, force: true });
});

describe("company app server", () => {
	it("excludes trails quarantined by the canonical replay", async () => {
		const file = "broken.jsonl";
		writeFileSync(
			join(root, "trail", file),
			`${JSON.stringify({
				type: "session",
				version: 5,
				id: "broken",
				timestamp: "2026-08-14T08:00:00.000Z",
				cwd: root,
				qorpera: { actor: "company-agent", attended: true },
			})}\nnot-json\n`,
			"utf-8",
		);
		hiddenTrails.add(file);

		const state = (await (await fetch(`${base}/api/state`)).json()) as {
			sessions: Array<{ file: string }>;
		};
		expect(state.sessions.map((session) => session.file)).not.toContain(file);
	});

	it("serves one canonical session snapshot and live stream", async () => {
		runtimeSnapshot = {
			revision: 1,
			generatedAt: "2026-08-14T08:01:00.000Z",
			sessions: [
				{
					trailFile: "trail-live.jsonl",
					sessionId: "session-live",
					actor: "company-agent",
					autonomous: false,
					staffAgentId: "staff-night-shift",
					status: "running",
					live: true,
					kernelInstanceId: "kernel-a",
					executorId: "executor-a",
					updatedAt: "2026-08-14T08:01:00.000Z",
					activity: { kind: "thinking" },
				},
			],
		};
		const state = (await (await fetch(`${base}/api/state`)).json()) as {
			runtime: SessionRuntimeSnapshot;
		};
		expect(state.runtime).toEqual(runtimeSnapshot);

		const stream = await fetch(`${base}/api/runtime`);
		expect(stream.headers.get("content-type")).toContain("text/event-stream");
		const reader = stream.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain("event: snapshot");
		expect(first).toContain('"revision":1');

		runtimeSnapshot = {
			...runtimeSnapshot,
			revision: 2,
			generatedAt: "2026-08-14T08:02:00.000Z",
		};
		for (const listener of runtimeListeners) listener({ snapshot: runtimeSnapshot });
		const second = new TextDecoder().decode((await reader.read()).value);
		expect(second).toContain("event: runtime");
		expect(second).toContain('"revision":2');

		const activitySession = {
			...runtimeSnapshot.sessions[0],
			updatedAt: "2026-08-14T08:03:00.000Z",
			activity: { kind: "writing" as const },
		};
		runtimeSnapshot = {
			revision: 3,
			generatedAt: activitySession.updatedAt,
			sessions: [activitySession],
		};
		for (const listener of runtimeListeners) {
			listener({
				event: { kind: "activity", at: activitySession.updatedAt },
				session: activitySession,
				snapshot: runtimeSnapshot,
			});
		}
		const third = new TextDecoder().decode((await reader.read()).value);
		expect(third).toContain('"revision":3');
		expect(third).toContain('"session":');
		expect(third).not.toContain('"snapshot":');
		await reader.cancel();
	});

	it("serves the per-agent model choice and durable agent messages", async () => {
		staffReadModel = () => [
			{
				id: "11111111-1111-4111-8111-111111111111",
				displayName: "Analyst",
				role: "Data analyst",
				charter: "Own analytical measures.",
				appearance: { color: "green", shape: "gem" },
				model: { provider: "anthropic", modelId: "claude-fable-5" },
				employmentStatus: "active",
				lifecycleState: "active",
				createdAt: "2026-08-15T00:00:00.000Z",
				updatedAt: "2026-08-15T00:00:00.000Z",
			},
		];
		staffMessageReadModel = () => [
			{
				id: "33333333-3333-4333-8333-333333333333",
				fromAgentId: "11111111-1111-4111-8111-111111111111",
				toAgentId: "44444444-4444-4444-8444-444444444444",
				subject: "Handoff",
				body: "The supplier report is ready.",
				createdAt: "2026-08-15T00:01:00.000Z",
				status: "queued",
				secret: "leaked",
			} as unknown as StaffAgentMessage,
		];

		const state = (await (await fetch(`${base}/api/state`)).json()) as {
			staff: Array<Record<string, unknown>>;
			agentMessages: Array<Record<string, unknown>>;
		};
		expect(state.staff[0]?.model).toEqual({ provider: "anthropic", modelId: "claude-fable-5" });
		expect(state.agentMessages).toEqual([
			{
				id: "33333333-3333-4333-8333-333333333333",
				fromAgentId: "11111111-1111-4111-8111-111111111111",
				toAgentId: "44444444-4444-4444-8444-444444444444",
				subject: "Handoff",
				body: "The supplier report is ready.",
				createdAt: "2026-08-15T00:01:00.000Z",
				status: "queued",
			},
		]);
		expect(JSON.stringify(state)).not.toContain("leaked");

		staffMessageReadModel = () => {
			throw new Error("messages unavailable");
		};
		const fallback = (await (await fetch(`${base}/api/state`)).json()) as { agentMessages: unknown[] };
		expect(fallback.agentMessages).toEqual([]);
	});

	it("serves safe staff and connection-request read models", async () => {
		const unsafeStaff = {
			id: "11111111-1111-4111-8111-111111111111",
			displayName: "Night Shift",
			role: "Overnight operator",
			charter: "Prepare the morning briefing.",
			templateId: "night-shift",
			departmentId: "operations",
			appearance: { color: "blue", shape: "round" },
			employmentStatus: "active" as const,
			lifecycleState: "setup" as const,
			createdAt: "2026-08-15T00:00:00.000Z",
			updatedAt: "2026-08-15T00:00:00.000Z",
			root: "C:\\private-company-root",
			credentials: { token: "staff-secret-token" },
		};
		const unsafeRequest = {
			id: "22222222-2222-4222-8222-222222222222",
			staffAgentId: unsafeStaff.id,
			sessionFile: "night-shift.jsonl",
			displayName: "GitHub",
			purpose: "Review pull requests",
			destinations: [{ host: "github.com", note: "Repository access", credential: "destination-secret" }],
			providerSuggestions: ["GitHub", "GitLab"],
			recipeId: "github-oauth",
			artifactId: "customer-health",
			dataNeedId: "support-inbox",
			status: "connecting" as const,
			phase: "awaiting_auth" as const,
			guidance: "GitHub is open in your browser. Sign in and approve access.",
			createdAt: "2026-08-15T00:01:00.000Z",
			updatedAt: "2026-08-15T00:01:00.000Z",
			secretNames: ["GITHUB_TOKEN"],
			root: "C:\\private-company-root",
			credentials: { token: "request-secret-token" },
		};
		const unsafeArtifact = {
			schema: "qorpera.artifact/v1" as const,
			id: "customer-health",
			title: "Customer health",
			purpose: "Track support quality.",
			stewardAgentId: unsafeStaff.id,
			status: "waiting-for-data" as const,
			metrics: [
				{
					id: "response-time",
					label: "Response time",
					description: "Time to first useful response.",
					direction: "lower-is-better" as const,
					status: "unknown" as const,
					evidence: [],
					observations: [
						{ at: "2026-08-14T00:00:00.000Z", value: 18 },
						{ at: "2026-08-15T00:00:00.000Z", value: 12 },
					],
				},
			],
			dataNeeds: [
				{
					id: "support-inbox",
					label: "Support inbox",
					purpose: "Read customer messages.",
					connectorHints: ["gmail"],
					status: "missing" as const,
					sourceRefs: [],
					sourceAssessments: [],
					connectionRequestId: unsafeRequest.id,
				},
			],
			createdAt: "2026-08-15T00:00:00.000Z",
			updatedAt: "2026-08-15T00:01:00.000Z",
			relativePath: "artifacts/staff/customer-health.json",
			root: "C:\\private-company-root",
			credentials: { token: "artifact-secret-token" },
		};
		const unsafeConnector = {
			schema: "qorpera.connector/v1" as const,
			id: "support-inbox",
			displayName: "Support inbox",
			purpose: "Read and triage customer support email.",
			ownerAgentId: unsafeStaff.id,
			environment: "sandbox" as const,
			operations: [
				{
					id: "messages.read",
					label: "Read messages",
					description: "Read messages in the support inbox.",
					access: "read" as const,
				},
			],
			destinations: [{ host: "mail.example.com", note: "Support mailbox" }],
			authentication: {
				kind: "oauth2" as const,
				secretName: "support_oauth",
				label: "Support mailbox",
				authorizationUrl: "https://identity.example.com/authorize",
				tokenUrl: "https://identity.example.com/token",
				clientId: "private-client-id",
				scopes: ["messages.read"],
				clientSecretLabel: "OAuth client secret",
			},
			implementation: { kind: "agent-playbook" as const, entry: "README.md" },
			createdAt: "2026-08-15T00:00:00.000Z",
			updatedAt: "2026-08-15T00:01:00.000Z",
			relativePath: "connectors/support-inbox/manifest.json",
			root: "C:\\private-company-root",
			credentials: { token: "connector-secret-token" },
		};
		staffReadModel = () => [unsafeStaff];
		artifactReadModel = () => [unsafeArtifact];
		connectorReadModel = () => [unsafeConnector];
		connectionRequestReadModel = () => [unsafeRequest];

		let state = (await (await fetch(`${base}/api/state`)).json()) as {
			staff: Array<Record<string, unknown>>;
			artifacts: Array<Record<string, unknown>>;
			connectors: Array<Record<string, unknown>>;
			connectionRequests: Array<Record<string, unknown>>;
		};
		expect(state.staff[0]).toMatchObject({
			id: unsafeStaff.id,
			displayName: "Night Shift",
			appearance: { color: "blue", shape: "round" },
		});
		expect(state.staff[0]).not.toHaveProperty("root");
		expect(state.staff[0]).not.toHaveProperty("credentials");
		expect(state.artifacts[0]).toMatchObject({
			id: "customer-health",
			stewardAgentId: unsafeStaff.id,
			metrics: [
				{
					id: "response-time",
					evidence: [],
					observations: [
						{ at: "2026-08-14T00:00:00.000Z", value: 18 },
						{ at: "2026-08-15T00:00:00.000Z", value: 12 },
					],
				},
			],
			dataNeeds: [{ id: "support-inbox", connectorHints: ["gmail"], connectionRequestId: unsafeRequest.id }],
		});
		expect(state.artifacts[0]).not.toHaveProperty("root");
		expect(state.artifacts[0]).not.toHaveProperty("credentials");
		expect(state.connectors[0]).toEqual({
			id: "support-inbox",
			displayName: "Support inbox",
			purpose: "Read and triage customer support email.",
			ownerAgentId: unsafeStaff.id,
			environment: "sandbox",
			operations: [
				{
					id: "messages.read",
					label: "Read messages",
					description: "Read messages in the support inbox.",
					access: "read",
				},
			],
			destinations: [{ host: "mail.example.com", note: "Support mailbox" }],
			authentication: { kind: "oauth2", label: "Support mailbox" },
			createdAt: "2026-08-15T00:00:00.000Z",
			updatedAt: "2026-08-15T00:01:00.000Z",
			relativePath: "connectors/support-inbox/manifest.json",
		});
		expect(state.connectionRequests[0]).toMatchObject({
			id: unsafeRequest.id,
			staffAgentId: unsafeStaff.id,
			destinations: [{ host: "github.com", note: "Repository access" }],
			providerSuggestions: ["GitHub", "GitLab"],
			status: "connecting",
			phase: "awaiting_auth",
			guidance: "GitHub is open in your browser. Sign in and approve access.",
			artifactId: "customer-health",
			dataNeedId: "support-inbox",
		});
		expect(state.connectionRequests[0]).not.toHaveProperty("secretNames");
		expect(state.connectionRequests[0]).not.toHaveProperty("root");
		expect(state.connectionRequests[0]).not.toHaveProperty("credentials");
		expect(JSON.stringify(state)).not.toContain("destination-secret");
		expect(JSON.stringify(state)).not.toContain("private-client-id");
		expect(JSON.stringify(state)).not.toContain("connector-secret-token");

		staffReadModel = () => {
			throw new Error("staff unavailable");
		};
		artifactReadModel = () => {
			throw new Error("artifacts unavailable");
		};
		connectorReadModel = () => {
			throw new Error("connectors unavailable");
		};
		connectionRequestReadModel = () => {
			throw new Error("connection requests unavailable");
		};
		state = (await (await fetch(`${base}/api/state`)).json()) as typeof state;
		expect(state.staff).toEqual([]);
		expect(state.artifacts).toEqual([]);
		expect(state.connectors).toEqual([]);
		expect(state.connectionRequests).toEqual([]);
	});

	it("serves a safe scheduled-job read model with explicit staff ownership", async () => {
		const unsafeJob = {
			id: "morning-digest",
			title: "Morning digest",
			prompt: "Summarize overnight work.",
			triggers: [
				{
					id: "github-prs",
					kind: "github" as const,
					repository: "Qorpera/Qorpera_Base",
					events: ["pull_request.opened" as const],
					actors: [],
				},
			],
			enabled: true,
			effort: "high" as const,
			placement: "cloud" as const,
			createdAt: "2026-08-15T00:00:00.000Z",
			updatedAt: "2026-08-15T00:01:00.000Z",
			suspendedReason: "Awaiting provider reconnection",
			staffAgentId: "11111111-1111-4111-8111-111111111111",
			secretNames: ["GMAIL_TOKEN"],
			webhook: { token: "webhook-secret-token" },
			root: "C:\\private-company-root",
			credentials: { token: "scheduled-job-secret-token" },
		};
		scheduledJobReadModel = () => [unsafeJob];

		let state = (await (await fetch(`${base}/api/state`)).json()) as {
			scheduledJobs: Array<Record<string, unknown>>;
		};
		expect(state.scheduledJobs).toEqual([
			{
				id: "morning-digest",
				title: "Morning digest",
				prompt: "Summarize overnight work.",
				triggers: [
					{
						id: "github-prs",
						kind: "github",
						repository: "Qorpera/Qorpera_Base",
						events: ["pull_request.opened"],
						actors: [],
					},
				],
				enabled: true,
				effort: "high",
				placement: "cloud",
				createdAt: "2026-08-15T00:00:00.000Z",
				updatedAt: "2026-08-15T00:01:00.000Z",
				suspendedReason: "Awaiting provider reconnection",
				staffAgentId: "11111111-1111-4111-8111-111111111111",
			},
		]);
		expect(JSON.stringify(state)).not.toContain("GMAIL_TOKEN");
		expect(JSON.stringify(state)).not.toContain("webhook-secret-token");
		expect(JSON.stringify(state)).not.toContain("private-company-root");
		expect(JSON.stringify(state)).not.toContain("scheduled-job-secret-token");
		scheduledJobReadModel = () => [{ ...unsafeJob, id: "unassigned-job", staffAgentId: undefined }];
		state = (await (await fetch(`${base}/api/state`)).json()) as typeof state;
		expect(state.scheduledJobs[0]).not.toHaveProperty("staffAgentId");

		scheduledJobReadModel = () => {
			throw new Error("scheduled jobs unavailable");
		};
		state = (await (await fetch(`${base}/api/state`)).json()) as typeof state;
		expect(state.scheduledJobs).toEqual([]);
	});

	it("serves only fixed shell navigation and never executes company-authored app files", async () => {
		const chrome = await (await fetch(`${base}/`)).text();
		expect(chrome).toContain("Qorpera staff shell");
		mkdirSync(join(root, "userland"), { recursive: true });
		writeFileSync(join(root, "userland", "index.html"), "<h1>untrusted legacy shell</h1>", "utf-8");
		const legacyShell = await fetch(`${base}/userland/fork/index.html`);
		expect(legacyShell.status).toBe(404);

		let state = (await (await fetch(`${base}/api/state`)).json()) as {
			shellNavigation: {
				defaultPageId: string;
				sectionIds: string[];
				nodes: Array<{
					id: string;
					kind: string;
					label: string;
					view?: { type: string; id: string };
				}>;
			};
			trailSessions: number;
			staff: unknown[];
			connectionRequests: unknown[];
			scheduledJobs: unknown[];
		};
		expect(state.shellNavigation.defaultPageId).toBe("q:chats");
		expect(state.shellNavigation.sectionIds).toEqual(["q:main"]);
		expect(state.shellNavigation.nodes.map((node) => node.id)).toEqual(
			expect.arrayContaining(["q:main", "q:inbox", "q:activity", "q:chats"]),
		);
		expect(state.shellNavigation.nodes.map((node) => node.id)).not.toContain("q:usage");
		expect(state).not.toHaveProperty("surfaces");
		expect(state).not.toHaveProperty("projection");
		expect(state.staff).toEqual([]);
		expect(state.connectionRequests).toEqual([]);
		expect(state.scheduledJobs).toEqual([]);
		mkdirSync(join(root, "app", "surfaces"), { recursive: true });
		writeFileSync(join(root, "app", "surfaces", "hello.html"), "<h1>live surface</h1>", "utf-8");
		writeFileSync(
			join(root, "app", "projection.json"),
			JSON.stringify({
				schema: "qorpera.projection/v1",
				default: "page:main.hello",
				navigation: ["department:published"],
				nodes: [
					{
						id: "department:published",
						kind: "department",
						label: "Published",
						items: ["category:published.examples"],
					},
					{
						id: "category:published.examples",
						kind: "category",
						label: "Examples",
						items: ["page:main.hello"],
					},
					{
						id: "page:main.hello",
						kind: "page",
						label: "Hello",
						view: { type: "surface", entry: "hello.html" },
					},
				],
			}),
			"utf-8",
		);
		state = (await (await fetch(`${base}/api/state`)).json()) as typeof state;
		expect(state.shellNavigation.nodes.some((node) => node.id === "page:main.hello")).toBe(false);

		for (const path of [
			"/surface/hello.html",
			"/assets/surface.css",
			"/assets/surface-kit.js",
			"/assets/theme.css",
			"/api/substrate/beliefs.md",
		]) {
			expect((await fetch(`${base}${path}`)).status, path).toBe(404);
		}
	});

	it("reports active-company trail usage priced with T3-compatible model rates", async () => {
		writeFileSync(
			join(root, "trail", "2026-08-08T10-00-00-000Z_usage.jsonl"),
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "usage",
					timestamp: "2026-08-08T10:00:00Z",
					cwd: root,
				}),
				JSON.stringify({
					type: "message",
					id: "a",
					parentId: null,
					timestamp: "2026-08-08T12:00:00Z",
					message: {
						role: "assistant",
						api: "codex-app-server",
						provider: "openai",
						model: "gpt-5.3-codex",
						usage: {
							input: 50,
							output: 10,
							cacheRead: 20,
							cacheWrite: 0,
							totalTokens: 80,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
					},
				}),
				JSON.stringify({
					type: "message",
					id: "b",
					parentId: "a",
					timestamp: "2026-08-08T22:30:00Z",
					message: {
						role: "assistant",
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet",
						usage: {
							input: 100,
							output: 20,
							cacheRead: 40,
							cacheWrite: 10,
							reasoning: 5,
							totalTokens: 170,
							cost: {
								input: 0.004,
								output: 0.006,
								cacheRead: 0.001,
								cacheWrite: 0.001,
								total: 0.012,
							},
						},
					},
				}),
				JSON.stringify({
					type: "message",
					id: "c",
					parentId: "b",
					timestamp: "2026-08-09T08:00:00Z",
					message: {
						role: "toolResult",
						toolName: "image_generation",
						usage: {
							input: 0,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 1,
							cost: {
								input: 0,
								output: 0.02,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0.02,
							},
						},
					},
				}),
				"not-json",
			].join("\n")}\n`,
			"utf-8",
		);

		const params = new URLSearchParams({
			sinceDay: "2026-08-08",
			untilDay: "2026-08-09",
			timeZone: "Europe/Copenhagen",
		});
		const response = await fetch(`${base}/api/usage?${params}`);
		expect(response.status).toBe(200);
		const usage = (await response.json()) as {
			costUsd: number;
			totalTokens: number;
			records: number;
			sessions: number;
			pricedRecords: number;
			unpricedRecords: number;
			reasoningTokens: number;
			costQuality: {
				cacheSavingsUsd: number;
				modelPricedShare: number;
				unpricedShare: number;
			};
			pricing: { status: string; source: string; knownModels: number };
			providers: Array<{ provider: string; totalTokens: number }>;
			daily: Array<{ day: string; totalTokens: number }>;
			coverage: { cachedSessions: number; malformedLines: number };
		};
		expect(usage).toMatchObject({
			totalTokens: 251,
			records: 3,
			sessions: 1,
			pricedRecords: 2,
			unpricedRecords: 1,
			reasoningTokens: 5,
			pricing: { status: "cached", source: LITELLM_RATES_URL, knownModels: 2 },
			coverage: { malformedLines: 1 },
		});
		expect(usage.costUsd).toBeCloseTo(0.0007215, 10);
		expect(usage.costQuality.cacheSavingsUsd).toBeCloseTo(0.000126, 10);
		expect(usage.costQuality.modelPricedShare).toBeCloseTo(2 / 3, 10);
		expect(usage.costQuality.unpricedShare).toBeCloseTo(1 / 3, 10);
		expect(usage.providers.find((provider) => provider.provider === "codex")?.totalTokens).toBe(80);
		expect(usage.daily).toEqual([
			expect.objectContaining({ day: "2026-08-08", totalTokens: 80 }),
			expect.objectContaining({ day: "2026-08-09", totalTokens: 171 }),
		]);

		const cached = (await (await fetch(`${base}/api/usage?${params}`)).json()) as {
			coverage: { cachedSessions: number };
		};
		expect(cached.coverage.cachedSessions).toBe(1);

		appendFileSync(
			join(root, "trail", "2026-08-08T10-00-00-000Z_usage.jsonl"),
			`${JSON.stringify({
				type: "message",
				id: "d",
				parentId: "c",
				timestamp: "2026-08-09T09:00:00Z",
				message: {
					role: "assistant",
					api: "codex-app-server",
					provider: "openai",
					model: "gpt-5.3-codex",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
					},
				},
			})}\n`,
			"utf-8",
		);
		const invalidated = (await (await fetch(`${base}/api/usage?${params}`)).json()) as {
			records: number;
			coverage: { cachedSessions: number };
		};
		expect(invalidated.records).toBe(4);
		expect(invalidated.coverage.cachedSessions).toBe(0);

		const invalid = await fetch(`${base}/api/usage?sinceDay=2026-08-08&untilDay=2026-08-09&timeZone=not-a-zone`);
		expect(invalid.status).toBe(400);
	});

	it("refuses linked trail sessions instead of parsing files outside the trail boundary", async () => {
		linkSync(join(root, COMPANY_MANIFEST_RELATIVE_PATH), join(root, "trail", "linked.jsonl"));
		const params = new URLSearchParams({
			sinceDay: "2026-08-08",
			untilDay: "2026-08-09",
			timeZone: "UTC",
		});

		const response = await fetch(`${base}/api/usage?${params}`);
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("[irreversible]");
	});

	it("lists trail sessions and serves the agent↔founder message round-trip", async () => {
		// A trail session appears in state with its first user message as title.
		writeFileSync(
			join(root, "trail", "2026-08-04T10-00-00-000Z_abc.jsonl"),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "abc",
					timestamp: "t",
					cwd: root,
				}),
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					message: {
						role: "user",
						content: [{ type: "text", text: "plan the pricing analysis" }],
					},
				}),
			].join("\n"),
			"utf-8",
		);
		// An agent-authored inbox message awaits the founder.
		writeFileSync(
			join(root, "inbox", "messages", "msg-pricing.md"),
			"# Pricing question\n\nWhich currency do customers pay in?\n",
			"utf-8",
		);

		// An autonomous session is distinguished by its kernel-authenticated header.
		writeFileSync(
			join(root, "trail", "2026-08-04T11-00-00-000Z_auto.jsonl"),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "auto",
					timestamp: "2026-08-04T11:00:00.000Z",
					cwd: root,
					qorpera: {
						actor: "company-agent",
						attended: false,
						autonomous: true,
						label: "autonomous — conception",
					},
				}),
				JSON.stringify({
					type: "session_info",
					id: "s1",
					parentId: null,
					name: "autonomous — conception",
				}),
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: "s1",
					message: {
						role: "user",
						content: [{ type: "text", text: "begin conception" }],
					},
				}),
				JSON.stringify({
					type: "model_change",
					timestamp: "2026-08-04T11:00:01.000Z",
					provider: "openai-codex",
					modelId: "gpt-5.6-sol",
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2026-08-04T11:00:05.000Z",
					message: {
						role: "assistant",
						provider: "openai-codex",
						model: "gpt-5.6-sol",
						stopReason: "stop",
						content: [
							{ type: "thinking", thinking: "Do not project private reasoning." },
							{ type: "text", text: "The conception brief is ready." },
						],
					},
				}),
				JSON.stringify({
					type: "custom",
					timestamp: "2026-08-04T11:00:06.000Z",
					customType: "qorpera_kernel_model_request",
					data: {
						event: "intent",
						status: "completed",
						usage: { calls: 3, costUsd: 0.25 },
					},
				}),
			].join("\n"),
			"utf-8",
		);
		writeFileSync(
			join(root, "trail", "2026-08-04T11-30-00-000Z_failed.jsonl"),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "failed",
					timestamp: "2026-08-04T11:30:00.000Z",
					cwd: root,
					qorpera: {
						actor: "company-agent",
						attended: false,
						autonomous: true,
						label: "autonomous — wake — scheduled-job:job-42 — Reliability sweep",
					},
				}),
				JSON.stringify({
					type: "model_change",
					timestamp: "2026-08-04T11:30:01.000Z",
					provider: "anthropic",
					modelId: "claude-opus-4-8",
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2026-08-04T11:30:02.000Z",
					message: {
						role: "assistant",
						provider: "anthropic",
						model: "claude-opus-4-8",
						stopReason: "toolUse",
						content: [
							{
								type: "toolCall",
								id: "edit-1",
								name: "edit",
								arguments: { path: "app/substrates/reliability.json" },
							},
						],
					},
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2026-08-04T11:30:02.500Z",
					message: {
						role: "toolResult",
						toolCallId: "edit-1",
						toolName: "edit",
						isError: false,
					},
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2026-08-04T11:30:03.000Z",
					message: {
						role: "assistant",
						provider: "anthropic",
						model: "claude-opus-4-8",
						stopReason: "error",
						errorMessage: "transport failure: Connection refused",
					},
				}),
				JSON.stringify({
					type: "custom",
					timestamp: "2026-08-04T11:30:04.000Z",
					customType: "qorpera_kernel_model_request",
					data: {
						event: "intent",
						status: "aborted",
						usage: { calls: 1, costUsd: 0 },
					},
				}),
				// Simulates the old inspection path appending child startup metadata.
				// The historical start and finish must remain the original run times.
				JSON.stringify({
					type: "model_change",
					timestamp: "2026-08-04T12:30:00.000Z",
					provider: "anthropic",
					modelId: "claude-opus-4-8",
				}),
			].join("\n"),
			"utf-8",
		);
		writeFileSync(
			join(root, "trail", "2026-08-04T11-45-00-000Z_legacy-wake.jsonl"),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "legacy-wake",
					timestamp: "2026-08-04T11:45:00.000Z",
					cwd: root,
					qorpera: {
						actor: "company-agent",
						attended: false,
						autonomous: true,
						staffAgentId: "staff-night-shift",
						label: "autonomous — wake — schedule",
					},
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2026-08-04T11:45:01.000Z",
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: "Scheduled job: Company orchestration.\n\nSummarize overnight company work.",
							},
						],
					},
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2026-08-04T11:45:05.000Z",
					message: {
						role: "assistant",
						provider: "openai-codex",
						model: "gpt-5.6-sol",
						stopReason: "stop",
						content: [
							{ type: "thinking", thinking: "Do not project private reasoning." },
							{ type: "text", text: "The company briefing is ready." },
						],
					},
				}),
				JSON.stringify({
					type: "custom",
					timestamp: "2026-08-04T11:45:06.000Z",
					customType: "qorpera_kernel_model_request",
					data: { event: "intent", status: "completed", usage: { calls: 1, costUsd: 0.01 } },
				}),
			].join("\n"),
			"utf-8",
		);

		const department = scaffoldProductDepartment(root, "my-product");
		const worktree = join(department.worktreesPath, "task-a");
		// A product chat carries its department and worktree in the authenticated header.
		writeFileSync(
			join(root, "trail", "2026-08-04T12-00-00-000Z_scoped.jsonl"),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "scoped",
					timestamp: "t",
					cwd: root,
					qorpera: {
						actor: "product-worker",
						attended: true,
						staffAgentId: "staff-launcher",
						department: department.path,
						worktree,
					},
				}),
				JSON.stringify({
					type: "session_info",
					id: "s2",
					parentId: null,
					name: `product — ${department.path} — ${worktree}`,
				}),
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: "s2",
					message: {
						role: "user",
						content: [{ type: "text", text: "fix the launcher" }],
					},
				}),
			].join("\n"),
			"utf-8",
		);

		// A sidechat carries its stable page ID in the session name, and its title comes
		// from the founder's words — the chrome's context preamble is stripped.
		writeFileSync(
			join(root, "trail", "2026-08-04T13-00-00-000Z_sidechat.jsonl"),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "sidechat",
					timestamp: "t",
					cwd: root,
				}),
				JSON.stringify({
					type: "session_info",
					id: "s3",
					parentId: null,
					name: "page — page:revenue.overview",
				}),
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: "s3",
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: '[Sidechat context: this chat is docked to the surface "Revenue" — app/surfaces/revenue.html. The founder is looking at it right now; orient from that file before answering.]\n\nwhy did July dip?',
							},
						],
					},
				}),
			].join("\n"),
			"utf-8",
		);
		writeFileSync(
			join(root, "trail", "2026-08-04T13-30-00-000Z_connection-choice.jsonl"),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "connection-choice",
					timestamp: "t",
					cwd: root,
				}),
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: '[Connection choice context: selected "Choose services individually" for data need "Financial ledger" in artifact "Financial health". Use existing company files first.]\n\nChoose services individually',
							},
						],
					},
				}),
			].join("\n"),
			"utf-8",
		);

		// A fresh founder chat holds only its header and the kernel's record of
		// the founder's first input — that record titles it until the child's
		// own message entry lands.
		writeFileSync(
			join(root, "trail", "2026-08-04T14-00-00-000Z_kernelinput.jsonl"),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "ki",
					timestamp: "t",
					cwd: root,
				}),
				JSON.stringify({
					type: "custom",
					id: "c1",
					parentId: null,
					customType: "qorpera_kernel_input",
					data: { message: "review the supplier contracts" },
				}),
			].join("\n"),
			"utf-8",
		);
		// Runtime attachment history must not hide a conversation that receives
		// its first founder message only after many idle reconnects.
		writeFileSync(
			join(root, "trail", "2026-08-04T14-30-00-000Z_late-first-message.jsonl"),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "late-first-message",
					timestamp: "t",
					cwd: root,
				}),
				...Array.from({ length: 450 }, (_, index) =>
					JSON.stringify({
						type: "custom",
						id: `runtime-${index}`,
						customType: "qorpera_kernel_session_runtime",
						data: { kind: "executor_ready" },
					}),
				),
				JSON.stringify({
					type: "message",
					id: "late-user-message",
					parentId: null,
					message: {
						role: "user",
						content: [{ type: "text", text: "preserve this late conversation" }],
					},
				}),
			].join("\n"),
			"utf-8",
		);
		// A chat opened and abandoned before any input is spawn residue — the
		// file stays in the trail but the chat list must not pile up with it.
		writeFileSync(
			join(root, "trail", "2026-08-04T15-00-00-000Z_empty.jsonl"),
			JSON.stringify({
				type: "session",
				version: 3,
				id: "empty",
				timestamp: "t",
				cwd: root,
			}),
			"utf-8",
		);

		const state = (await (await fetch(`${base}/api/state`)).json()) as {
			sessions: Array<{
				file: string;
				title: string;
				kind: string;
				category?: string;
				staffAgentId?: string;
				department?: string;
				worktree?: string;
				page?: string;
				scheduledJobId?: string;
				scheduledJobTitle?: string;
				scheduledJobPrompt?: string;
				outcome?: string;
				modelProvider?: string;
				modelId?: string;
				durationMs?: number;
				calls?: number;
				costUsd?: number;
				startedAtMs?: number;
				finishedAtMs?: number;
				failureCause?: string;
				failureGuidance?: string;
				partialChangeSummary?: string;
				changedFiles?: string[];
				completedSteps?: number;
				resultText?: string;
			}>;
			inbox: Array<{ file: string; kind: string; status: string }>;
		};
		const chat = state.sessions.find((s) => s.file.includes("_abc"));
		const auto = state.sessions.find((s) => s.file.includes("_auto"));
		const failed = state.sessions.find((s) => s.file.includes("_failed"));
		const legacyWake = state.sessions.find((s) => s.file.includes("_legacy-wake"));
		const scoped = state.sessions.find((s) => s.file.includes("_scoped"));
		const sidechat = state.sessions.find((s) => s.file.includes("_sidechat"));
		const connectionChoice = state.sessions.find((s) => s.file.includes("_connection-choice"));
		const lateFirstMessage = state.sessions.find((s) => s.file.includes("_late-first-message"));
		expect(chat?.title).toBe("plan the pricing analysis");
		expect(chat?.kind).toBe("chat");
		expect(chat?.department).toBeUndefined();
		expect(chat?.page).toBeUndefined();
		// The trail categorizes what each session is a trail OF: user-led
		// conversations are different from kernel lanes and product work.
		expect(chat?.category).toBe("conversation");
		expect(auto?.kind).toBe("autonomous");
		expect(auto?.title).toBe("autonomous — conception");
		expect(auto?.category).toBe("conception");
		expect(auto).toMatchObject({
			outcome: "succeeded",
			modelProvider: "openai-codex",
			modelId: "gpt-5.6-sol",
			durationMs: 6_000,
			calls: 3,
			costUsd: 0.25,
		});
		expect(auto).not.toHaveProperty("resultText");
		expect(failed).toMatchObject({
			kind: "autonomous",
			category: "wake",
			title: "Reliability sweep",
			scheduledJobId: "job-42",
			scheduledJobTitle: "Reliability sweep",
			outcome: "failed",
			modelProvider: "anthropic",
			modelId: "claude-opus-4-8",
			durationMs: 4_000,
			startedAtMs: Date.parse("2026-08-04T11:30:00.000Z"),
			finishedAtMs: Date.parse("2026-08-04T11:30:04.000Z"),
			calls: 1,
			costUsd: 0,
			failureCause: "The model service could not be reached.",
			failureGuidance:
				"Retry now. If it happens again, choose another model or check the model connection in Settings.",
			changedFiles: ["app/substrates/reliability.json"],
			completedSteps: 1,
		});
		expect(failed?.partialChangeSummary).toContain("Changed 1 file: app/substrates/reliability.json");
		expect(legacyWake).toMatchObject({
			title: "Company orchestration",
			category: "wake",
			scheduledJobId: "company-orchestration",
			scheduledJobTitle: "Company orchestration",
			scheduledJobPrompt: "Summarize overnight company work.",
			staffAgentId: "staff-night-shift",
			resultText: "The company briefing is ready.",
		});
		expect(legacyWake?.resultText).not.toContain("private reasoning");
		expect(scoped?.kind).toBe("chat");
		expect(scoped?.category).toBe("product");
		expect(scoped?.staffAgentId).toBe("staff-launcher");
		expect(scoped?.department).toBe(department.path);
		expect(scoped?.worktree).toBe(worktree);
		expect(scoped?.title).toBe("fix the launcher");
		expect(sidechat?.kind).toBe("chat");
		expect(sidechat).not.toHaveProperty("page");
		expect(sidechat?.title).toBe("why did July dip?");
		expect(connectionChoice?.title).toBe("Choose services individually");
		expect(lateFirstMessage?.title).toBe("preserve this late conversation");
		const kernelInput = state.sessions.find((s) => s.file.includes("_kernelinput"));
		const empty = state.sessions.find((s) => s.file.includes("_empty"));
		expect(kernelInput?.title).toBe("review the supplier contracts");
		expect(empty).toBeUndefined();

		writeFileSync(
			join(root, department.pullRequestsPath, "42.json"),
			JSON.stringify({
				number: 42,
				title: "Fix the launcher",
				status: "open",
				branch: "qorpera/task-a",
				url: "javascript:alert(1)",
			}),
			"utf-8",
		);
		const withDepartments = (await (await fetch(`${base}/api/state`)).json()) as {
			departments: Array<{
				path: string;
				name: string;
				pullRequests: Array<{ number: number; title: string; url?: string }>;
			}>;
		};
		expect(withDepartments.departments[0].path).toBe(department.path);
		expect(withDepartments.departments[0].pullRequests).toEqual([
			expect.objectContaining({ number: 42, title: "Fix the launcher" }),
		]);
		expect(withDepartments.departments[0].pullRequests[0]).not.toHaveProperty("url");
		const message = state.inbox.find((item) => item.file === "messages/msg-pricing.md");
		expect(message?.kind).toBe("message");
		expect(message?.status).toBe("pending");

		// Body is served; the founder's response lands in the file; status flips.
		const body = await (await fetch(`${base}/api/inbox/messages%2Fmsg-pricing.md`)).text();
		expect(body).toContain("Which currency");
		const respond = await fetch(`${base}/api/inbox/respond`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-qorpera-token": "test-token",
			},
			body: JSON.stringify({
				file: "messages/msg-pricing.md",
				response: "DKK primarily, EUR later.",
			}),
		});
		expect(respond.status).toBe(200);
		expect(readFileSync(join(root, "inbox", "messages", "msg-pricing.md"), "utf-8")).toContain("DKK primarily");
		const after = (await (await fetch(`${base}/api/state`)).json()) as {
			inbox: Array<{ file: string; status: string }>;
		};
		expect(after.inbox.find((item) => item.file === "messages/msg-pricing.md")?.status).toBe("answered");

		// Traversal-shaped names are refused.
		const bad = await fetch(`${base}/api/inbox/..%2Fauthority.toml`);
		expect(bad.status).toBe(400);
	});

	it("resolves gates from the inbox panel and approvals actually authorize", async () => {
		const authority = discoverAuthority(root)!;
		const first = evaluateToolCall(authority, "bash", { command: "rm -rf work" }, root);
		expect(first.kind).toBe("block");
		const gateId = (first as { gateId: string }).gateId;

		const state = (await (await fetch(`${base}/api/state`)).json()) as {
			inbox: Array<{ file: string; status: string }>;
		};
		const gate = state.inbox.find((item) => item.file.startsWith(gateId));
		expect(gate?.status).toBe("pending");

		const post = await fetch(`${base}/api/gate`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-qorpera-token": "test-token",
			},
			body: JSON.stringify({ file: gate!.file, action: "approved" }),
		});
		expect(post.status).toBe(200);
		expect(readFileSync(join(root, "inbox", gate!.file), "utf-8")).toContain("status: approved");

		// The approval is real: the same effect now proceeds (and is consumed).
		const second = evaluateToolCall(authority, "bash", { command: "rm -rf work" }, root);
		expect(second.kind).toBe("allow");

		// Bad requests are refused.
		const bad = await fetch(`${base}/api/gate`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-qorpera-token": "test-token",
			},
			body: JSON.stringify({ file: "../authority.toml", action: "approved" }),
		});
		expect(bad.status).toBe(400);
	});

	it("allows the founder UI to revoke only durable consumed trust", async () => {
		const durableFile = "gate-aaaaaaaa.md";
		writeFileSync(
			join(root, "inbox", durableFile),
			`---\nid: gate-aaaaaaaa\nstatus: consumed\nclass: authority\ntool: behavior_signature\nhash: ${"a".repeat(64)}\ncreated: 2026-08-10T00:00:00.000Z\n---\n`,
			"utf-8",
		);
		const revoked = await fetch(`${base}/api/gate`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-qorpera-token": "test-token",
			},
			body: JSON.stringify({ file: durableFile, action: "denied" }),
		});
		expect(revoked.status).toBe(200);
		expect(readFileSync(join(root, "inbox", durableFile), "utf-8")).toContain("status: denied");

		const actionFile = "gate-bbbbbbbb.md";
		writeFileSync(
			join(root, "inbox", actionFile),
			`---\nid: gate-bbbbbbbb\nstatus: consumed\nclass: irreversible\ntool: bash\nhash: ${"b".repeat(64)}\ncreated: 2026-08-10T00:00:00.000Z\n---\n`,
			"utf-8",
		);
		const rejected = await fetch(`${base}/api/gate`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-qorpera-token": "test-token",
			},
			body: JSON.stringify({ file: actionFile, action: "denied" }),
		});
		expect(rejected.status).toBe(400);
	});

	it("routes authorized artifact definition edits through the host-owned mutation model", async () => {
		const artifact: CompanyArtifactRecord = {
			schema: "qorpera.artifact/v1",
			id: "customer-health",
			title: "Customer trust",
			purpose: "Track support quality.",
			stewardAgentId: "11111111-1111-4111-8111-111111111111",
			status: "waiting-for-data",
			metrics: [],
			dataNeeds: [],
			createdAt: "2026-08-15T00:00:00.000Z",
			updatedAt: "2026-08-15T00:01:00.000Z",
			relativePath: "artifacts/staff/customer-health.json",
		};
		let received: { id: string; update: unknown } | undefined;
		artifactUpdateModel = (id, update) => {
			received = { id, update };
			return artifact;
		};
		const update = {
			expectedUpdatedAt: "2026-08-15T00:00:00.000Z",
			title: "Customer trust",
		};
		const response = await fetch(`${base}/api/artifact/update`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-qorpera-token": "test-token",
			},
			body: JSON.stringify({ id: artifact.id, update }),
		});
		expect(response.status).toBe(200);
		expect(received).toEqual({ id: artifact.id, update });
		expect(await response.json()).toMatchObject({
			ok: true,
			artifact: { id: artifact.id, title: "Customer trust", relativePath: artifact.relativePath },
		});
	});

	it("rejects mutations without the kernel token — the agent cannot curl its own approvals", async () => {
		const authority = discoverAuthority(root)!;
		const blocked = evaluateToolCall(authority, "bash", { command: "rm -rf work" }, root);
		const gateId = (blocked as { gateId: string }).gateId;
		const state = (await (await fetch(`${base}/api/state`)).json()) as {
			inbox: Array<{ file: string }>;
		};
		const gateFile = state.inbox.find((item) => item.file.startsWith(gateId))!.file;

		for (const [path, payload] of [
			["/api/gate", { file: gateFile, action: "approved" }],
			["/api/inbox/respond", { file: gateFile, response: "yes" }],
			["/api/authority/config", { policy: { spending: "act" } }],
			["/api/authority", { content: `[irreversible]\nmode = "auto"\n` }],
			["/api/artifact/update", { id: "customer-health", update: {} }],
		] as const) {
			const res = await fetch(`${base}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status, path).toBe(401);
		}
		// And the gate is still pending — nothing was authorized.
		expect(readFileSync(join(root, "inbox", gateFile), "utf-8")).toContain("status: pending");
		// The bash screen also gates any curl mention of these endpoints.
		expect(
			evaluateToolCall(authority, "bash", { command: `curl -X POST localhost:4700/api/gate -d approved` }, root)
				.kind,
		).toBe("block");
	});

	it("structured policy config auto-saves instructions without changing technical authority", async () => {
		writeFileSync(
			join(root, "authority.toml"),
			`# Founder policy\n[irreversible]\nmode = "gate"\n\n# Keep this mapping\n[tools]\ndeploy = "irreversible"\n`,
			"utf-8",
		);
		const cfg = (await (await fetch(`${base}/api/authority/config`)).json()) as {
			policy: Record<string, string>;
		};
		expect(cfg.policy).toEqual({
			spending: "ask",
			external_communication: "ask",
			hard_to_reverse_changes: "ask",
			information_sharing: "ask",
		});

		const save = await fetch(`${base}/api/authority/config`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-qorpera-token": "test-token",
			},
			body: JSON.stringify({
				policy: {
					spending: "act",
					external_communication: "auto",
				},
			}),
		});
		expect(save.status).toBe(200);
		const written = readFileSync(join(root, "authority.toml"), "utf-8");
		expect(written).toContain("# Founder policy");
		expect(written).toContain("# Keep this mapping");
		expect(written).toContain('[tools]\ndeploy = "irreversible"');
		expect(written).toContain('[irreversible]\nmode = "gate"');
		expect(parseCompanyPolicy(written)).toEqual({
			spending: "act",
			external_communication: "auto",
			hard_to_reverse_changes: "ask",
			information_sharing: "ask",
		});

		const beforeInvalid = written;
		const invalid = await fetch(`${base}/api/authority/config`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-qorpera-token": "test-token",
			},
			body: JSON.stringify({ policy: { spending: "notify" } }),
		});
		expect(invalid.status).toBe(400);
		expect(readFileSync(join(root, "authority.toml"), "utf-8")).toBe(beforeInvalid);
	});

	it("authority editor endpoint: reads, rejects invalid TOML, applies valid edits", async () => {
		const current = await (await fetch(`${base}/api/authority`)).text();
		expect(current).toContain("[irreversible]");

		const invalid = await fetch(`${base}/api/authority`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-qorpera-token": "test-token",
			},
			body: JSON.stringify({ content: "not [valid toml" }),
		});
		expect(invalid.status).toBe(400);

		const valid = await fetch(`${base}/api/authority`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-qorpera-token": "test-token",
			},
			body: JSON.stringify({ content: `[irreversible]\nmode = "notify"\n` }),
		});
		expect(valid.status).toBe(200);
		const authority = discoverAuthority(root)!;
		expect(evaluateToolCall(authority, "bash", { command: "rm -rf scratch" }, root).kind).toBe("allow");
	});
});
