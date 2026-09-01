import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	CloudConnectorAuthorizations,
	ConnectorAuthorizationError,
	type ConnectorAuthorizationKey,
	type ConnectorAuthorizationRequest,
	type ConnectorAuthorizationSpec,
	type ConnectorAuthorizationStore,
	type ConnectorMemberSession,
	projectConnectorAuthorization,
} from "../src/cloud-connector-authorization.ts";
import { connectorDigest } from "../src/cloud-connector-contract.ts";
import { type ConnectorFixtureIdentity, cloudConnectorFixture } from "./fixtures/cloud-connector.ts";

function authorizationFixture(purpose: "connect" | "authorize" = "authorize") {
	const fixture = cloudConnectorFixture();
	const spec: ConnectorAuthorizationSpec<ConnectorFixtureIdentity> = {
		identity: fixture.identity,
		purpose,
		logicalOperationKey: "connect-github-issue-42",
		runtimeBundleVersion: "runtime-fixture/v7",
		audience: { kind: "member", id: fixture.identity.requesterUserId },
		installation: fixture.installation.object,
		connectorId: "qorpera.github",
		operationId: "issues.get",
		manifestSha256: connectorDigest(fixture.adapter.manifest),
		implementationSha256: fixture.adapter.manifest.implementation.sha256,
		permission: "issues:read",
		destination: "https://api.github.com",
		resource: { repository: "acme/roadmap", issueNumber: 42 },
		connectionId: purpose === "authorize" ? fixture.account.connectionId : null,
		connectionVersion: purpose === "authorize" ? fixture.account.connectionVersion : null,
		credentialOwner: fixture.account.owner,
		recipientMemberUserId: fixture.identity.requesterUserId,
	};
	const key: ConnectorAuthorizationKey = {
		companyId: fixture.identity.companyId,
		runId: fixture.identity.runId,
		logicalOperationKey: spec.logicalOperationKey,
	};
	const member: ConnectorMemberSession = {
		companyId: fixture.identity.companyId,
		userId: fixture.identity.requesterUserId,
		sessionId: randomUUID(),
	};
	const rows = new Map<string, ConnectorAuthorizationRequest<ConnectorFixtureIdentity>>();
	const state = {
		now: Date.parse("2026-08-28T10:00:00.000Z"),
		memberActive: true,
		requestsAllowed: true,
		consentAllowed: true,
		expiryAllowed: true,
		revokeAllowed: true,
		approveCalls: 0,
		committedApprovals: 0,
		committedRevocations: 0,
		proofMember: member.userId,
		beforeApproval: async (): Promise<void> => undefined,
	};
	let queue: Promise<void> = Promise.resolve();
	const store: ConnectorAuthorizationStore<ConnectorFixtureIdentity> = {
		transact(transactionKey, transition, signal) {
			const operation = queue.then(async () => {
				signal.throwIfAborted();
				const id = connectorDigest(transactionKey);
				const current = rows.get(id);
				let approvals = 0;
				let revocations = 0;
				const next = await transition({
					current: current ? structuredClone(current) : undefined,
					get now() {
						return state.now;
					},
					async assertRequestAllowed(input) {
						if (!state.requestsAllowed || connectorDigest(input) !== connectorDigest(spec))
							throw new Error("test run/scope denied");
					},
					async assertMember(input) {
						if (!state.memberActive || connectorDigest(input) !== connectorDigest(member))
							throw new Error("test member session unauthenticated");
					},
					async approve(_member, request) {
						state.approveCalls++;
						await state.beforeApproval();
						if (!state.consentAllowed || !state.memberActive || state.now >= request.expiresAt)
							throw new Error("test authenticated approval denied");
						approvals++;
						return {
							kind: "connector_authorization",
							approvalId: randomUUID(),
							requestId: request.id,
							companyId: request.spec.identity.companyId,
							memberUserId: state.proofMember,
							scopeSha256: request.scopeSha256,
							policyVersion: 7,
						};
					},
					async revoke() {
						if (!state.revokeAllowed) throw new Error("test revocation denied");
						revocations++;
					},
					async assertExpiryAllowed() {
						if (!state.expiryAllowed) throw new Error("test expiry denied");
					},
				});
				signal.throwIfAborted();
				rows.set(id, structuredClone(next));
				state.committedApprovals += approvals;
				state.committedRevocations += revocations;
				return structuredClone(next);
			});
			queue = operation.then(
				() => undefined,
				() => undefined,
			);
			return operation;
		},
	};
	const service = new CloudConnectorAuthorizations(store);
	const signal = new AbortController().signal;
	const pending = () => service.request(spec, signal);
	const reply = (request: ConnectorAuthorizationRequest<ConnectorFixtureIdentity>, decision = "approve") => ({
		requestId: request.id,
		expectedRevision: request.revision,
		decision,
	});
	return { spec, key, member, rows, state, store, service, signal, pending, reply };
}

describe("connector-specific authorization interactions", () => {
	it("keeps connection consent separate from authentication, source reads, and publication", async () => {
		const fixture = authorizationFixture("connect");
		const pending = await fixture.pending();
		expect(pending).toMatchObject({ status: "pending", approval: null });
		const approved = await fixture.service.respond(
			fixture.key,
			fixture.reply(pending),
			fixture.member,
			fixture.signal,
		);
		const projection = projectConnectorAuthorization(approved.request);
		expect(projection).toMatchObject({
			purpose: "connect",
			status: "approved",
			authentication: "out_of_band_required",
			approvalScope: "connector_access_only",
		});
		expect(approved.request.spec).toMatchObject({ connectionId: null, connectionVersion: null });
		expect(JSON.stringify(projection)).not.toMatch(
			/connectionId|credentialHandle|token|source_inventory|publish|import/i,
		);
		await expect(
			fixture.service.request(
				{
					...fixture.spec,
					purpose: "authorize",
					connectionId: randomUUID(),
					connectionVersion: 1,
				},
				fixture.signal,
			),
		).rejects.toThrow("denied");
	});

	it("treats a dismissed connection request as skip rather than consent", async () => {
		const fixture = authorizationFixture("connect");
		const pending = await fixture.pending();
		const dismissed = await fixture.service.respond(
			fixture.key,
			fixture.reply(pending, "dismiss"),
			fixture.member,
			fixture.signal,
		);
		expect(dismissed.request).toMatchObject({ status: "dismissed", approval: null });
		expect((await fixture.pending()).status).toBe("dismissed");
		expect(fixture.state.committedApprovals).toBe(0);
	});

	it("deduplicates requests in the existing transaction without reopening terminal interactions", async () => {
		const fixture = authorizationFixture();
		const requests = await Promise.all([fixture.pending(), fixture.pending()]);
		expect(requests[0]).toEqual(requests[1]);
		expect(fixture.rows.size).toBe(1);
		const { request } = await fixture.service.respond(
			fixture.key,
			fixture.reply(requests[0], "dismiss"),
			fixture.member,
			fixture.signal,
		);
		expect((await fixture.pending()).id).toBe(request.id);
		expect((await fixture.pending()).status).toBe("dismissed");
	});

	it.each(["approve", "decline", "dismiss"])(
		"records an authenticated %s response with distinct terminal state",
		async (decision) => {
			const fixture = authorizationFixture();
			const request = await fixture.pending();
			const result = await fixture.service.respond(
				fixture.key,
				fixture.reply(request, decision),
				fixture.member,
				fixture.signal,
			);
			expect(result.accepted).toBe(true);
			expect(result.request.status).toBe(
				decision === "approve" ? "approved" : decision === "decline" ? "declined" : "dismissed",
			);
			expect(result.request.revision).toBe(2);
			expect(fixture.state.committedApprovals).toBe(decision === "approve" ? 1 : 0);
			expect(result.request.approval === null).toBe(decision !== "approve");
		},
	);

	it("does not turn consent into provider authentication or external action authority", async () => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		const approved = await fixture.service.respond(
			fixture.key,
			fixture.reply(request),
			fixture.member,
			fixture.signal,
		);
		const projection = projectConnectorAuthorization(approved.request);
		expect(projection).toMatchObject({
			kind: "connector_authorization",
			status: "approved",
			authentication: "out_of_band_required",
			credentialOwner: fixture.spec.credentialOwner,
			resource: fixture.spec.resource,
			audience: fixture.spec.audience,
			scopeSha256: request.scopeSha256,
			approvalScope: "connector_access_only",
		});
		expect(JSON.stringify(projection)).not.toMatch(
			/secret|bearer|token|password|credentialHandle|providerConnectionId|sessionId/,
		);
		expect(approved.request.approval?.kind).toBe("connector_authorization");
	});

	it("requires independent authenticated approval evidence", async () => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		fixture.state.consentAllowed = false;
		await expect(
			fixture.service.respond(fixture.key, fixture.reply(request), fixture.member, fixture.signal),
		).rejects.toThrow("denied");
		expect((await fixture.pending()).status).toBe("pending");
		expect(fixture.state.committedApprovals).toBe(0);
	});

	it("rejects mismatched authenticated approval proof", async () => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		fixture.state.proofMember = randomUUID();
		await expect(
			fixture.service.respond(fixture.key, fixture.reply(request), fixture.member, fixture.signal),
		).rejects.toThrow("denied");
		expect(fixture.state.committedApprovals).toBe(0);
	});

	it.each(["company", "member", "session"])("rejects a response from another %s", async (kind) => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		const member = { ...fixture.member };
		if (kind === "company") member.companyId = randomUUID();
		if (kind === "member") member.userId = randomUUID();
		if (kind === "session") member.sessionId = randomUUID();
		await expect(
			fixture.service.respond(fixture.key, fixture.reply(request), member, fixture.signal),
		).rejects.toThrow();
		expect(fixture.state.approveCalls).toBe(0);
		expect((await fixture.pending()).status).toBe("pending");
	});

	it("never accepts member identifiers, credentials or proof supplied inside the UI response", async () => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		for (const field of ["memberUserId", "token", "approval", "companyId", "credentialHandle"]) {
			await expect(
				fixture.service.respond(
					fixture.key,
					{ ...fixture.reply(request), [field]: "untrusted" },
					fixture.member,
					fixture.signal,
				),
			).rejects.toThrow();
		}
		expect(fixture.state.approveCalls).toBe(0);
	});

	it("rejects stale revisions, changed IDs, and duplicate terminal responses", async () => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		await expect(
			fixture.service.respond(
				fixture.key,
				{ ...fixture.reply(request), expectedRevision: 2 },
				fixture.member,
				fixture.signal,
			),
		).rejects.toThrow("stale");
		await expect(
			fixture.service.respond(
				fixture.key,
				{ ...fixture.reply(request), requestId: randomUUID() },
				fixture.member,
				fixture.signal,
			),
		).rejects.toThrow("stale");
		const approved = await fixture.service.respond(
			fixture.key,
			fixture.reply(request),
			fixture.member,
			fixture.signal,
		);
		await expect(
			fixture.service.respond(fixture.key, fixture.reply(request), fixture.member, fixture.signal),
		).rejects.toThrow("stale");
		await expect(
			fixture.service.respond(fixture.key, fixture.reply(approved.request), fixture.member, fixture.signal),
		).rejects.toThrow("duplicate");
		expect(fixture.state.committedApprovals).toBe(1);
	});

	it("admits only one concurrent response", async () => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		const outcomes = await Promise.allSettled([
			fixture.service.respond(fixture.key, fixture.reply(request), fixture.member, fixture.signal),
			fixture.service.respond(fixture.key, fixture.reply(request), fixture.member, fixture.signal),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
		expect(fixture.state.committedApprovals).toBe(1);
	});

	it("records expiration and refuses late consent", async () => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		fixture.state.now = request.expiresAt;
		const result = await fixture.service.respond(fixture.key, fixture.reply(request), fixture.member, fixture.signal);
		expect(result).toMatchObject({ accepted: false, request: { status: "expired", revision: 2, approval: null } });
		expect(fixture.state.approveCalls).toBe(0);
		expect((await fixture.pending()).status).toBe("expired");
	});

	it("expires pending requests only through the existing authorized control transaction", async () => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		expect((await fixture.service.expire(fixture.key, fixture.signal)).status).toBe("pending");
		fixture.state.now = request.expiresAt + 1;
		fixture.state.expiryAllowed = false;
		await expect(fixture.service.expire(fixture.key, fixture.signal)).rejects.toThrow("denied");
		fixture.state.expiryAllowed = true;
		expect((await fixture.service.expire(fixture.key, fixture.signal)).status).toBe("expired");
	});

	it.each(["pending", "approved"])("revokes %s state with an atomic existing-grant fence", async (status) => {
		const fixture = authorizationFixture();
		let request = await fixture.pending();
		if (status === "approved")
			request = (await fixture.service.respond(fixture.key, fixture.reply(request), fixture.member, fixture.signal))
				.request;
		fixture.state.revokeAllowed = false;
		await expect(
			fixture.service.revoke(fixture.key, request.id, request.revision, fixture.member, fixture.signal),
		).rejects.toThrow("denied");
		fixture.state.revokeAllowed = true;
		const revoked = await fixture.service.revoke(
			fixture.key,
			request.id,
			request.revision,
			fixture.member,
			fixture.signal,
		);
		expect(revoked.status).toBe("revoked");
		expect(fixture.state.committedRevocations).toBe(1);
		await expect(
			fixture.service.respond(fixture.key, fixture.reply(revoked), fixture.member, fixture.signal),
		).rejects.toThrow("duplicate");
		expect((await fixture.pending()).status).toBe("revoked");
	});

	it("rejects an account, recipient, or permission change under a pending request identity", async () => {
		const fixture = authorizationFixture();
		await fixture.pending();
		for (const override of [
			{ recipientMemberUserId: randomUUID() },
			{ connectionId: randomUUID() },
			{ permission: "issues:write" },
			{ manifestSha256: "0".repeat(64) },
			{ credentialOwner: { kind: "company" as const, id: randomUUID() } },
		]) {
			await expect(async () =>
				fixture.service.request({ ...fixture.spec, ...override }, fixture.signal),
			).rejects.toThrow();
		}
		expect(fixture.rows.size).toBe(1);
	});

	it("fences revocation and expiry during authenticated approval", async () => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		fixture.state.beforeApproval = async () => {
			fixture.state.memberActive = false;
			fixture.state.now = request.expiresAt;
		};
		await expect(
			fixture.service.respond(fixture.key, fixture.reply(request), fixture.member, fixture.signal),
		).rejects.toThrow("denied");
		expect(fixture.state.committedApprovals).toBe(0);
	});

	it("cancellation rolls back pending approval and a late result cannot commit", async () => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		const controller = new AbortController();
		let finish: (() => void) | undefined;
		fixture.state.beforeApproval = () =>
			new Promise<void>((resolve) => {
				finish = resolve;
			});
		const pending = fixture.service.respond(fixture.key, fixture.reply(request), fixture.member, controller.signal);
		await vi.waitFor(() => expect(finish).toBeDefined());
		controller.abort();
		await expect(pending).rejects.toThrow("denied");
		finish!();
		expect((await fixture.pending()).status).toBe("pending");
		expect(fixture.state.committedApprovals).toBe(0);
	});

	it("rolls back provisional approval if the request expires before the transition returns", async () => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		const service = new CloudConnectorAuthorizations<ConnectorFixtureIdentity>({
			transact(key, transition, signal) {
				return fixture.store.transact(
					key,
					(transaction) =>
						transition({
							...transaction,
							get now() {
								return fixture.state.now;
							},
							async approve(member, current, checkSignal) {
								const approval = await transaction.approve(member, current, checkSignal);
								fixture.state.now = current.expiresAt;
								return approval;
							},
						}),
					signal,
				);
			},
		});
		await expect(
			service.respond(fixture.key, fixture.reply(request), fixture.member, fixture.signal),
		).rejects.toThrow("expired");
		expect(fixture.state.committedApprovals).toBe(0);
		expect([...fixture.rows.values()][0].status).toBe("pending");
	});

	it.each(["approval-less approved row", "unexpected field", "approval on pending row"])(
		"rejects corrupt stored state: %s",
		async (kind) => {
			const fixture = authorizationFixture();
			const pending = await fixture.pending();
			const approved = (
				await fixture.service.respond(fixture.key, fixture.reply(pending), fixture.member, fixture.signal)
			).request;
			const corrupted =
				kind === "approval-less approved row"
					? { ...approved, approval: null }
					: kind === "unexpected field"
						? { ...approved, token: "forged" }
						: { ...pending, approval: approved.approval };
			fixture.rows.set(connectorDigest(fixture.key), corrupted);
			await expect(fixture.pending()).rejects.toThrow();
		},
	);

	it("rejects missing authority ports instead of trusting a pending row", async () => {
		const fixture = authorizationFixture();
		const request = await fixture.pending();
		const store: ConnectorAuthorizationStore<ConnectorFixtureIdentity> = {
			async transact(key, transition, signal) {
				return fixture.store.transact(
					key,
					(transaction) => transition({ ...transaction, approve: undefined as never }),
					signal,
				);
			},
		};
		const service = new CloudConnectorAuthorizations(store);
		await expect(
			service.respond(fixture.key, fixture.reply(request), fixture.member, fixture.signal),
		).rejects.toThrow(ConnectorAuthorizationError);
		expect(fixture.state.committedApprovals).toBe(0);
	});
});
