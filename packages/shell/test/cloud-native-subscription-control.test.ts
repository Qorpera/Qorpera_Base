import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	NativeSubscriptionControlPlane,
	type NativeSubscriptionControlTransport,
} from "../src/cloud-native-subscription-control.ts";

const profileId = "10000000-0000-4000-8000-000000000001";
const identityId = "10000000-0000-4000-8000-000000000002";
const loginId = "10000000-0000-4000-8000-000000000003";
const connectionId = "10000000-0000-4000-8000-000000000004";
const bindingId = "10000000-0000-4000-8000-000000000005";
const sessionId = "10000000-0000-4000-8000-000000000006";
const requestId = "10000000-0000-4000-8000-000000000007";
const inputId = "10000000-0000-4000-8000-000000000008";
const ownerUserId = "10000000-0000-4000-8000-000000000009";
const scopedIdentityId = "10000000-0000-4000-8000-000000000010";
const logicalComputerId = "10000000-0000-4000-8000-000000000011";

function transport() {
	const calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];
	const rpc = vi.fn<NativeSubscriptionControlTransport["rpc"]>(async (name, args) => {
		calls.push({ name, args });
		switch (name) {
			case "qorpera_upsert_member_compute_identity":
				return {
					compute_identity_id: identityId,
					ownership_kind: "member",
					owner_user_id: ownerUserId,
					owner_scope_key: null,
					display_name: "Jonas compute identity",
					template_key: "qorpera-member-linux",
					template_version: "v1",
					capabilities: ["agent_turn", "company_substrate"],
					policy: { credentialExport: false },
					status: "active",
					created_at: "2026-08-21T10:00:00.000Z",
					updated_at: "2026-08-21T10:00:00.000Z",
				};
			case "qorpera_upsert_scoped_compute_identity":
				return {
					compute_identity_id: scopedIdentityId,
					ownership_kind: args.p_ownership_kind,
					owner_user_id: null,
					owner_scope_key: args.p_owner_scope_key,
					display_name: "Finance boundary",
					template_key: "qorpera-company-linux",
					template_version: "v1",
					capabilities: ["agent_turn", "company_substrate"],
					policy: { credentialExport: false },
					status: "active",
					created_at: "2026-08-21T10:00:00.000Z",
					updated_at: "2026-08-21T10:00:00.000Z",
				};
			case "qorpera_begin_native_provider_login":
				return {
					login_id: loginId,
					compute_identity_id: identityId,
					compute_identity_ownership_kind: "member",
					compute_identity_owner_user_id: ownerUserId,
					compute_identity_owner_scope_key: null,
					provider: "openai",
					native_harness: "codex-cli",
					status: "pending",
					expires_at: "2026-08-21T10:15:00.000Z",
				};
			case "qorpera_create_member_execution_sponsor":
				return { binding_id: bindingId, version: 1 };
			case "qorpera_create_execution_sponsor_binding":
				return { binding_id: bindingId, version: 2 };
			case "qorpera_request_session_turn_v2":
				return {
					turn_request_id: requestId,
					input_id: inputId,
					status: "queued",
					sponsor_mode: args.p_sponsor_mode,
				};
			case "qorpera_approve_session_turn_sponsorship":
				return { turn_request_id: requestId, status: "queued" };
			case "qorpera_list_member_native_execution_connections":
				return { compute_identity: null, connections: [] };
			case "qorpera_list_compute_identities":
				return [
					{
						compute_identity_id: scopedIdentityId,
						ownership_kind: "security_boundary",
						owner_user_id: null,
						owner_scope_key: "finance-prod",
						display_name: "Finance boundary",
						template_key: "qorpera-company-linux",
						template_version: "v1",
						capabilities: ["agent_turn", "company_substrate"],
						policy: { credentialExport: false },
						status: "active",
						created_at: "2026-08-21T10:00:00.000Z",
						updated_at: "2026-08-21T10:00:00.000Z",
					},
				];
			case "qorpera_list_session_turn_requests":
				return [];
			case "qorpera_revoke_native_provider_connection":
				return { connection_id: connectionId, status: "revoked" };
		}
	});
	return { calls, client: new NativeSubscriptionControlPlane({ rpc }) };
}

describe("native subscription product control", () => {
	it("creates a cloud compute identity and begins official native login without accepting provider credentials", async () => {
		const { calls, client } = transport();
		await expect(
			client.createMemberComputeIdentity({
				profileId,
				displayName: "Jonas compute identity",
				policy: { credentialExport: false },
			}),
		).resolves.toMatchObject({
			computeIdentityId: identityId,
			ownershipKind: "member",
			ownerUserId,
			status: "active",
		});
		const login = await client.beginNativeProviderLogin({
			profileId,
			computeIdentityId: identityId,
			provider: "openai",
			nativeHarness: "codex-cli",
		});

		expect(login).toMatchObject({
			loginId,
			provider: "openai",
			nativeHarness: "codex-cli",
			computeIdentityOwnershipKind: "member",
			computeIdentityOwnerUserId: ownerUserId,
		});
		expect(login.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const loginCall = calls.find((call) => call.name === "qorpera_begin_native_provider_login");
		expect(loginCall?.args.p_capability_sha256).toBe(createHash("sha256").update(login.capability).digest("hex"));
		expect(JSON.stringify(calls)).not.toMatch(
			/access[_-]?token|refresh[_-]?token|oauth[_-]?token|provider[_-]?secret/i,
		);
		expect(JSON.stringify(loginCall)).not.toContain(login.capability);
	});

	it("creates and lists company security-boundary compute identities without assigning member ownership", async () => {
		const { calls, client } = transport();
		await expect(
			client.createScopedComputeIdentity({
				profileId,
				ownershipKind: "security_boundary",
				ownerScopeKey: "finance-prod",
				displayName: "Finance boundary",
			}),
		).resolves.toMatchObject({
			computeIdentityId: scopedIdentityId,
			ownershipKind: "security_boundary",
			ownerScopeKey: "finance-prod",
		});
		await expect(client.listComputeIdentities(profileId)).resolves.toMatchObject([
			{ computeIdentityId: scopedIdentityId, ownershipKind: "security_boundary", ownerScopeKey: "finance-prod" },
		]);
		expect(calls.find((call) => call.name === "qorpera_upsert_scoped_compute_identity")?.args).toMatchObject({
			p_ownership_kind: "security_boundary",
			p_owner_scope_key: "finance-prod",
		});
	});

	it("submits one explicitly sponsored immutable turn instead of selecting a connection implicitly", async () => {
		const { calls, client } = transport();
		const sponsor = await client.createMemberSponsor({
			profileId,
			providerConnectionId: connectionId,
			providerConnectionVersion: 4,
		});
		await expect(
			client.requestSessionTurn({
				sessionId,
				body: { schema: "qorpera.session-prompt/v1", text: "Use my Codex subscription.", images: [] },
				sponsorMode: "member_connection",
				sponsorBindingId: sponsor.bindingId,
				sponsorVersion: sponsor.version,
				computeIdentityId: identityId,
				workerClass: "managed_sandbox",
			}),
		).resolves.toEqual({
			turnRequestId: requestId,
			inputId,
			status: "queued",
			sponsorMode: "member_connection",
		});

		const request = calls.find((call) => call.name === "qorpera_request_session_turn_v2");
		expect(request?.args).toMatchObject({
			p_sponsor_mode: "member_connection",
			p_sponsor_binding_id: bindingId,
			p_sponsor_version: 1,
			p_compute_identity_id: identityId,
			p_worker_class: "managed_sandbox",
		});
	});

	it("creates explicit company sponsorship without relabeling it as a member connection", async () => {
		const { calls, client } = transport();
		await expect(
			client.createCompanySponsor({
				profileId,
				sponsorKind: "company_service_account",
				providerConnectionId: connectionId,
				providerConnectionVersion: 3,
				allowAutonomous: true,
			}),
		).resolves.toEqual({ bindingId, version: 2 });
		expect(calls.find((call) => call.name === "qorpera_create_execution_sponsor_binding")?.args).toMatchObject({
			p_sponsor_kind: "company_service_account",
			p_provider_connection_id: connectionId,
			p_provider_connection_version: 3,
			p_allow_autonomous: true,
		});
	});

	it("submits the shared Company Computer as explicit company-owned governed work", async () => {
		const { calls, client } = transport();
		const sponsor = await client.createCompanySponsor({
			profileId,
			sponsorKind: "company_service_account",
			providerConnectionId: connectionId,
			providerConnectionVersion: 3,
			allowAutonomous: true,
		});

		await expect(
			client.requestSessionTurn({
				sessionId,
				body: { schema: "qorpera.session-prompt/v1", text: "Use the Company Computer.", images: [] },
				sponsorMode: "company_connection",
				sponsorBindingId: sponsor.bindingId,
				sponsorVersion: sponsor.version,
				computeIdentityId: scopedIdentityId,
				logicalComputerId,
				workerClass: "company_computer",
			}),
		).resolves.toMatchObject({ sponsorMode: "company_connection", status: "queued" });

		expect(calls.find((call) => call.name === "qorpera_request_session_turn_v2")?.args).toMatchObject({
			p_sponsor_mode: "company_connection",
			p_compute_identity_id: scopedIdentityId,
			p_logical_computer_id: logicalComputerId,
			p_worker_class: "company_computer",
		});
	});

	it("revokes the exact member-owned native connection without handling provider credentials", async () => {
		const { calls, client } = transport();
		await expect(client.revokeConnection({ profileId, providerConnectionId: connectionId })).resolves.toEqual({
			connectionId,
			status: "revoked",
		});
		expect(calls.at(-1)).toEqual({
			name: "qorpera_revoke_native_provider_connection",
			args: { p_profile_id: profileId, p_connection_id: connectionId },
		});
		expect(JSON.stringify(calls)).not.toMatch(/access[_-]?token|refresh[_-]?token|oauth[_-]?token/i);
	});
});
