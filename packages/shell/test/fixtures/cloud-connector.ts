import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonValue } from "@qorpera/contracts";
import { CloudConnectorCatalog } from "../../src/cloud-connector-catalog.ts";
import {
	CLOUD_CONNECTOR_CONTINUATION_SCHEMA,
	type ConnectorAccountBinding,
	type ConnectorAuthority,
	type ConnectorContent,
	type ConnectorContinuationHandle,
	type ConnectorContinuationPort,
	type ConnectorContinuationScope,
	type ConnectorCredentialVault,
	ConnectorFailure,
	type ConnectorInstallation,
	type ConnectorInvocation,
	type ConnectorJsonObject,
	type ConnectorNativeOperations,
	type ConnectorResolvedContinuation,
	type ConnectorRunIdentity,
	type ConnectorSourceSystemAuthority,
	connectorDigest,
	connectorJsonText,
} from "../../src/cloud-connector-contract.ts";
import { createGitHubCloudConnectorAdapter } from "../../src/cloud-connector-github.ts";
import { connectorContinuationScopeSha256 } from "../../src/cloud-connector-source.ts";
import { createCloudConnectorTools } from "../../src/cloud-connector-tools.ts";

export const SYNTHETIC_CONNECTOR_TOKEN = "ghp_SYNTHETIC_CONNECTOR_TOKEN_NOT_A_REAL_CREDENTIAL";
export const ISSUE_FIXTURE = {
	id: 3240012345,
	node_id: "I_kwDOSYNTHETIC",
	url: "https://api.github.com/repos/acme/roadmap/issues/42",
	html_url: "https://github.com/acme/roadmap/issues/42",
	repository_url: "https://api.github.com/repos/acme/roadmap",
	number: 42,
	title: "Cloud connector acceptance",
	state: "open",
	body: "Verify authorization before creating a comment.",
	user: { login: "fixture-member", id: 800001, type: "User" },
	labels: [{ name: "integration", color: "112233" }],
	comments: 1,
	created_at: "2026-08-27T10:00:00Z",
	updated_at: "2026-08-28T10:00:00Z",
};
export const COMMENT_FIXTURE = {
	id: 3240012346,
	node_id: "IC_kwDOSYNTHETIC",
	url: "https://api.github.com/repos/acme/roadmap/issues/comments/3240012346",
	html_url: "https://github.com/acme/roadmap/issues/42#issuecomment-3240012346",
	issue_url: ISSUE_FIXTURE.url,
	body: "Verified with controlled fixtures.",
	user: { login: "fixture-member", id: 800001, type: "User" },
	created_at: "2026-08-28T10:01:00Z",
	updated_at: "2026-08-28T10:01:00Z",
};

export interface ConnectorFixtureIdentity extends ConnectorRunIdentity {
	readonly environmentId: string;
	readonly jobId: string;
	readonly runnerId: string;
	readonly assignmentId: string;
	readonly leaseId: string;
	readonly computeIdentityId: string;
	readonly staffVersion: number;
	readonly sessionId: string;
	readonly sponsorUserId: string;
	readonly sponsorBindingId: string;
	readonly sponsorVersion: number;
	readonly providerConnectionId: string;
	readonly providerConnectionVersion: number;
	readonly provider: "openai";
	readonly nativeHarness: "codex-cli";
	readonly model: string;
}

export interface ConnectorTestReceipt {
	id: string;
	key: string;
	digest: string;
	operationDigest: string;
	idempotencyKey: string;
	state: "executing" | "completed";
	content?: ConnectorContent;
}

/** TEST ONLY. Shared records simulate durable recovery; production must use Step 2's ledger. */
export class ConnectorTestOperations<I extends ConnectorRunIdentity> implements ConnectorNativeOperations<I> {
	readonly records: Map<string, ConnectorTestReceipt>;
	readonly #identity: I;
	readonly #pending = new Map<string, { digest: string; result: Promise<ConnectorContent> }>();
	readonly #stop = new AbortController();
	readonly signal: AbortSignal = this.#stop.signal;
	#checking: Promise<void> = Promise.resolve();
	#queue: Promise<void> = Promise.resolve();
	failCompletion = false;

	constructor(identity: I, records = new Map<string, ConnectorTestReceipt>()) {
		this.#identity = identity;
		this.records = records;
	}

	// Match CloudNativeToolRun: a cancelled native authority check closes the whole run.
	async #assertActive(signal: AbortSignal): Promise<void> {
		const combined = AbortSignal.any([signal, this.signal]);
		const check = this.#checking.then(() => combined.throwIfAborted());
		this.#checking = check.catch(() => this.close());
		try {
			await check;
		} catch {
			this.close();
			throw new Error("test native run authority unavailable");
		}
	}

	close(): void {
		this.#stop.abort();
	}

	async execute(options: Parameters<ConnectorNativeOperations<I>["execute"]>[0]): Promise<ConnectorContent> {
		const { operation, authorize } = options;
		const signal = AbortSignal.any([options.signal, this.signal]);
		const key = `${operation.tool}:${operation.logicalOperationKey}`;
		const digest = connectorDigest({ identity: this.#identity, operation });
		const previous = this.#pending.get(key);
		if (previous && previous.digest !== digest) throw new Error("test ledger input conflict");
		const result =
			previous?.result ??
			this.#queue.then(async () => {
				await this.#assertActive(signal);
				await authorize(operation, this.#identity, signal);
				const existing = this.records.get(key);
				if (existing?.digest !== undefined && existing.digest !== digest)
					throw new Error("test ledger input conflict");
				if (existing?.state === "completed" && existing.content) return structuredClone(existing.content);
				if ([...this.records.values()].some((record) => record.state === "executing"))
					throw new Error("test ledger requires reconciliation");
				const receipt: ConnectorTestReceipt = {
					id: randomUUID(),
					key,
					digest,
					operationDigest: connectorDigest(operation),
					idempotencyKey: connectorDigest([this.#identity.runId, key]),
					state: "executing",
				};
				this.records.set(key, receipt);
				await this.#assertActive(signal);
				await authorize(operation, this.#identity, signal);
				const output = await options.perform(operation, {
					identity: this.#identity,
					receiptId: receipt.id,
					idempotencyKey: receipt.idempotencyKey,
					signal,
				});
				signal.throwIfAborted();
				await this.#assertActive(signal);
				if (this.failCompletion) throw new Error("test completion response lost");
				receipt.state = "completed";
				receipt.content = structuredClone(output.content);
				return structuredClone(output.content);
			});
		if (!previous) {
			this.#pending.set(key, { digest, result });
			this.#queue = result.then(
				() => undefined,
				() => undefined,
			);
		}
		const content = await result;
		await this.#assertActive(signal);
		await authorize(operation, this.#identity, signal);
		signal.throwIfAborted();
		return structuredClone(content);
	}
}

/** TEST ONLY. Simulates opaque host continuation state without exposing a provider cursor. */
export class ConnectorTestContinuations implements ConnectorContinuationPort {
	readonly records = new Map<
		string,
		{ handle: ConnectorContinuationHandle; scopeSha256: string; cursor: ConnectorJsonObject }
	>();
	resolveCalls = 0;
	issueCalls = 0;

	async resolve(
		scope: ConnectorContinuationScope,
		handle: ConnectorContinuationHandle,
		signal: AbortSignal,
	): Promise<ConnectorResolvedContinuation> {
		signal.throwIfAborted();
		this.resolveCalls++;
		const record = this.records.get(handle.id);
		if (
			!record ||
			record.handle.version !== handle.version ||
			record.scopeSha256 !== connectorContinuationScopeSha256(scope)
		)
			throw new ConnectorFailure("authority_denied");
		return {
			schema: CLOUD_CONNECTOR_CONTINUATION_SCHEMA,
			handle: { ...record.handle },
			scopeSha256: record.scopeSha256,
			cursor: structuredClone(record.cursor),
		};
	}

	async issue(
		scope: ConnectorContinuationScope,
		cursor: ConnectorJsonObject,
		signal: AbortSignal,
	): Promise<Omit<ConnectorResolvedContinuation, "cursor">> {
		signal.throwIfAborted();
		this.issueCalls++;
		const handle = { id: randomUUID(), version: 1 };
		const scopeSha256 = connectorContinuationScopeSha256(scope);
		this.records.set(handle.id, {
			handle,
			scopeSha256,
			cursor: structuredClone(cursor),
		});
		return {
			schema: CLOUD_CONNECTOR_CONTINUATION_SCHEMA,
			handle,
			scopeSha256,
		};
	}
}

export interface CloudConnectorFixtureOptions {
	readonly enabledOperations?: readonly string[];
	readonly accountOwner?: "member" | "company";
	readonly audience?: "member" | "company";
	readonly credential?: "active" | "missing";
	readonly grant?: "active" | "missing";
}

export function cloudConnectorFixture(
	repository = "roadmap",
	repositoryOwner = "acme",
	options: CloudConnectorFixtureOptions = {},
) {
	const identity: ConnectorFixtureIdentity = {
		companyId: randomUUID(),
		environmentId: randomUUID(),
		runId: randomUUID(),
		jobId: randomUUID(),
		runnerId: randomUUID(),
		assignmentId: randomUUID(),
		leaseId: randomUUID(),
		computeIdentityId: randomUUID(),
		staffAgentId: randomUUID(),
		staffVersion: 2,
		sessionId: randomUUID(),
		requesterUserId: randomUUID(),
		sponsorUserId: randomUUID(),
		sponsorBindingId: randomUUID(),
		sponsorVersion: 3,
		providerConnectionId: randomUUID(),
		providerConnectionVersion: 4,
		provider: "openai",
		nativeHarness: "codex-cli",
		model: "offline-fixture",
	};
	const adapter = createGitHubCloudConnectorAdapter();
	const installation: ConnectorInstallation = {
		companyId: identity.companyId,
		object: {
			companyFileId: randomUUID(),
			objectId: randomUUID(),
			logicalPath: "connectors/qorpera.github/manifest.json",
			objectVersion: "version-7",
			ownerPrincipalId: randomUUID(),
			policyClass: "connector-installation",
		},
		manifest: adapter.manifest,
		enabledOperations: [...(options.enabledOperations ?? ["issues.get", "issues.create_comment"])],
	};
	const account: ConnectorAccountBinding = {
		companyId: identity.companyId,
		connectionId: randomUUID(),
		connectionVersion: 2,
		providerAccountId: "github:800001",
		owner:
			options.accountOwner === "company"
				? { kind: "company", id: identity.companyId }
				: { kind: "member", id: identity.requesterUserId },
		credential: options.credential === "missing" ? null : { id: randomUUID(), version: 3 },
		grant:
			options.grant === "missing"
				? null
				: { id: randomUUID(), version: 4, approverUserId: identity.requesterUserId },
	};
	const operations = new ConnectorTestOperations(identity);
	const continuations = new ConnectorTestContinuations();
	const state = {
		revoked: false,
		writeApproved: true,
		active: true,
		installationVersion: installation.object.objectVersion,
		connectionVersion: account.connectionVersion,
		credentialVersion: account.credential?.version ?? 0,
		grantVersion: account.grant?.version ?? 0,
		vaultCalls: 0,
	};
	const checks: Array<{ phase: string; invocation: ConnectorInvocation<ConnectorFixtureIdentity> }> = [];
	const sourceSystemAuthority: ConnectorSourceSystemAuthority<ConnectorFixtureIdentity> = {
		async status(status, signal) {
			signal.throwIfAborted();
			if (
				!state.active ||
				connectorJsonText(status.identity) !== connectorJsonText(identity) ||
				connectorDigest(status.installation) !== connectorDigest(installation) ||
				connectorDigest(status.account) !== connectorDigest(account) ||
				status.installation.object.objectVersion !== state.installationVersion ||
				status.account.connectionVersion !== state.connectionVersion ||
				(status.account.credential?.version ?? 0) !== state.credentialVersion ||
				(status.account.grant?.version ?? 0) !== state.grantVersion ||
				new Set(status.operationIds).size !== status.operationIds.length ||
				status.operationIds.some((operationId) => !installation.enabledOperations.includes(operationId))
			)
				throw new ConnectorFailure("authority_denied");
			return {
				state: state.revoked
					? "revoked"
					: status.account.credential === null
						? "authentication_required"
						: "connected",
				authorizations: status.operationIds.map((operationId) => ({
					operationId,
					state: status.account.grant === null ? "authorization_required" : "live_check_required",
				})),
			};
		},
	};
	const authority: ConnectorAuthority<ConnectorFixtureIdentity> = {
		async assertAuthorized(invocation, phase, receipt, signal) {
			signal.throwIfAborted();
			checks.push({ phase, invocation });
			if (state.revoked) throw new ConnectorFailure("revoked");
			if (
				!state.active ||
				connectorJsonText(invocation.identity) !== connectorJsonText(identity) ||
				connectorDigest(invocation.account) !== connectorDigest(account) ||
				invocation.installation.companyId !== identity.companyId ||
				invocation.installation.object.objectVersion !== state.installationVersion ||
				invocation.account.connectionVersion !== state.connectionVersion ||
				(invocation.account.credential?.version ?? 0) !== state.credentialVersion ||
				(invocation.account.grant?.version ?? 0) !== state.grantVersion ||
				(typeof invocation.request.resource.repository === "string" &&
					invocation.request.resource.repository !== `${repositoryOwner}/${repository}`) ||
				(invocation.operation.access === "write" && !state.writeApproved)
			)
				throw new ConnectorFailure("authority_denied");
			if (!invocation.account.credential) throw new ConnectorFailure("authentication_required");
			if (!invocation.account.grant) throw new ConnectorFailure("authorization_required");
			if (phase !== "admission") {
				const admitted = [...operations.records.values()].find((record) => record.id === receipt?.receiptId);
				if (
					!admitted ||
					admitted.state !== "executing" ||
					admitted.idempotencyKey !== receipt?.idempotencyKey ||
					admitted.operationDigest !== connectorDigest(invocation.nativeOperation)
				)
					throw new ConnectorFailure("authority_denied");
			}
		},
	};
	const vault: ConnectorCredentialVault<ConnectorFixtureIdentity> = {
		async withBearer(invocation, _receipt, consume, signal) {
			state.vaultCalls++;
			signal.throwIfAborted();
			if (state.revoked || connectorDigest(invocation.account) !== connectorDigest(account))
				throw new ConnectorFailure("revoked");
			await consume(SYNTHETIC_CONNECTOR_TOKEN);
		},
	};
	const catalog = new CloudConnectorCatalog([{ installation, account }], [adapter]);
	const createSession = (
		fetchImpl: typeof fetch,
		overrides: Partial<Parameters<typeof createCloudConnectorTools<ConnectorFixtureIdentity>>[0]> = {},
	) =>
		createCloudConnectorTools({
			identity,
			runtimeBundleVersion: "runtime-fixture/v7",
			catalog,
			operations,
			authority,
			sourceSystemAuthority,
			vault,
			continuations,
			fetchImpl,
			audience: {
				kind: options.audience ?? "company",
				id: options.audience === "member" ? identity.requesterUserId : identity.companyId,
			},
			...overrides,
		});
	const context = (signal: AbortSignal = new AbortController().signal) => ({
		companyId: identity.companyId,
		runId: identity.runId,
		callId: randomUUID(),
		argumentSha256: "a".repeat(64),
		identity,
		signal,
	});
	return {
		identity,
		adapter,
		installation,
		account,
		operations,
		continuations,
		state,
		checks,
		authority,
		sourceSystemAuthority,
		vault,
		catalog,
		createSession,
		context,
	};
}

export function connectorCall(
	write = false,
	key = "issue-42-review",
	repository = "roadmap",
	repositoryOwner = "acme",
): JsonValue {
	return {
		connectorId: "qorpera.github",
		operationId: write ? "issues.create_comment" : "issues.get",
		logicalOperationKey: key,
		input: {
			repositoryOwner,
			repository,
			issueNumber: 42,
			...(write ? { body: COMMENT_FIXTURE.body } : {}),
		},
	};
}

export interface ControlledConnectorRequest {
	url: string;
	method: string;
	headers: IncomingHttpHeaders;
	body: string;
}

export async function controlledGitHubServer() {
	const requests: ControlledConnectorRequest[] = [];
	const state = {
		handler: (request: ControlledConnectorRequest, response: ServerResponse): void => {
			response.writeHead(request.method === "POST" ? 201 : 200, { "content-type": "application/json" });
			response.end(JSON.stringify(request.method === "POST" ? COMMENT_FIXTURE : ISSUE_FIXTURE));
		},
	};
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("error", () => undefined);
		response.on("error", () => undefined);
		request.on("data", (chunk: string) => {
			body += chunk;
			if (Buffer.byteLength(body) > 8192) request.destroy();
		});
		request.on("end", () => {
			const record = { url: request.url ?? "", method: request.method ?? "", headers: request.headers, body };
			requests.push(record);
			state.handler(record, response);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.origin !== "https://api.github.com") throw new Error("test transport rejected non-GitHub destination");
		const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
		// The logical provider URL remains GitHub; the loopback mapping exists ONLY in this fixture.
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
	return {
		requests,
		state,
		fetchImpl,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
