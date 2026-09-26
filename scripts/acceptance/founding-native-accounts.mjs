import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sealNativeCredentialCapsule } from "../../packages/runtime/src/cloud-native-provider-host.ts";
import { sqlUuid } from "./founding-fixtures.mjs";

const syntheticSignature = "qorpera-acceptance-not-a-provider-signature";
const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Valid Codex auth.json shape, deliberately not a valid provider identity.
 * The isolated TLS fixture recognizes only this issuer/signature. */
export function foundingNativeSyntheticAuth(userId, now = Date.now()) {
	sqlUuid(userId);
	const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({
		iss: "https://founding.example.test",
		sub: userId,
		exp: Math.floor(now / 1000) + 3600,
		email: "model@founding.example.test",
		"https://api.openai.com/auth": {
			chatgpt_plan_type: "plus",
			chatgpt_user_id: userId,
			chatgpt_account_id: userId,
		},
	})}.${syntheticSignature}`;
	return {
		auth_mode: "chatgpt",
		OPENAI_API_KEY: null,
		tokens: {
			id_token: token,
			access_token: token,
			refresh_token: "qorpera-no-real-refresh",
			account_id: userId,
		},
		last_refresh: new Date(now).toISOString(),
	};
}

export function assertFoundingSyntheticToken(token) {
	assert(typeof token === "string" && token.length < 4096);
	const parts = token.split(".");
	assert.equal(parts.length, 3);
	assert.equal(parts[2], syntheticSignature);
	const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	assert.equal(claims.iss, "https://founding.example.test");
	sqlUuid(claims.sub);
	return claims.sub;
}

/** Member operations use the real browser's existing bearer through
 * invokeMember. Only external OAuth completion is replaced by the explicit
 * synthetic login fixture. The reference is sealed under the actual VM key
 * before assignment; this object never returns or logs that key. */
export function foundingNativeAccounts({ serviceRpc, privateRoot }) {
	const identities = new Map();
	return {
		async setup({ profileId, members, invokeMember }) {
			sqlUuid(profileId);
			assert(members.length >= 1 && members.length <= 2);
			for (const { userId } of members) {
				sqlUuid(userId);
				const member = async (name, args) => {
					const result = await invokeMember(userId, name, args);
					assert.equal(result.status, 200, `Synthetic model member operation failed: ${name}`);
					return result.body;
				};
				const identity = await member("qorpera_upsert_member_compute_identity", {
					p_profile_id: profileId,
					p_client_identity_id: randomUUID(),
					p_display_name: "Isolated member model fixture",
					p_template_key: "qorpera-member-linux",
					p_template_version: "v1",
					p_capabilities: ["agent_turn"],
					p_policy: {},
				});
				assert.equal(identity.owner_user_id, userId);
				const capability = randomBytes(32).toString("base64url"),
					capsuleId = randomUUID();
				const digest = createHash("sha256").update(capability).digest("hex");
				const login = await member("qorpera_begin_native_provider_login", {
					p_profile_id: profileId,
					p_client_login_id: randomUUID(),
					p_client_connection_id: randomUUID(),
					p_compute_identity_id: identity.compute_identity_id,
					p_provider: "openai",
					p_native_harness: "codex-cli",
					p_capability_sha256: digest,
					p_login_seconds: 900,
				});
				const reference = `native-capsule/${capsuleId}`;
				const connection = await serviceRpc("qorpera_complete_native_provider_login", {
					p_login_id: login.login_id,
					p_capability_sha256: digest,
					p_capsule_id: capsuleId,
					p_encrypted_capsule_reference: reference,
					p_attestation_policy_sha256: createHash("sha256")
						.update("qorpera.native-provider-host/v1")
						.digest("hex"),
					p_provider_account_reference: userId,
					p_billing_source: "isolated-synthetic-model",
					p_consent_version: "qorpera-native-provider-consent/v1",
					p_quota_policy: {
						monthly_microusd: 1000000,
						reservation_microusd: 100000,
						max_calls_per_run: 32,
						max_input_tokens_per_run: 2000000,
						max_output_tokens_per_run: 500000,
						max_concurrent_runs: 1,
					},
				});
				assert.equal(connection.owner_user_id, userId);
				assert.equal(connection.compute_identity_id, identity.compute_identity_id);
				await member("qorpera_create_member_execution_sponsor", {
					p_profile_id: profileId,
					p_client_binding_id: randomUUID(),
					p_provider_connection_id: connection.connection_id,
					p_provider_connection_version: connection.version,
					p_allow_autonomous: false,
				});
				assert(!identities.has(identity.compute_identity_id));
				identities.set(identity.compute_identity_id, {
					profileId,
					userId,
					capsuleId,
					reference,
					sealed: false,
				});
			}
			return {
				boundary:
					"Real member-authenticated model identity/login/sponsor RPCs; external OAuth completion is synthetic. Actual encrypted capsule must be installed under the created VM identity key before dispatch.",
			};
		},
		async sealForGuest({ profileId, computeIdentityId, userId, masterKey, store }) {
			const identity = identities.get(computeIdentityId);
			assert(
				identity && identity.profileId === profileId && identity.userId === userId && !identity.sealed,
				"Only this actual member identity can be sealed once",
			);
			assert(/^[A-Za-z0-9_-]{43}$/.test(masterKey));
			const root = await mkdtemp(join(privateRoot, "synthetic-model-"));
			try {
				const auth = foundingNativeSyntheticAuth(userId);
				await mkdir(join(root, "codex"), { mode: 0o700 });
				await writeFile(join(root, "codex/auth.json"), JSON.stringify(auth), { mode: 0o600 });
				const bytes = await sealNativeCredentialCapsule(
					root,
					masterKey,
					identity.capsuleId,
					new Set(["codex/auth.json"]),
				);
				await store.put(identity.reference, bytes);
				identity.sealed = true;
				return {
					token: auth.tokens.access_token,
					capsuleId: identity.capsuleId,
					reference: identity.reference,
					bytes: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				};
			} finally {
				await rm(root, { recursive: true });
			}
		},
	};
}
