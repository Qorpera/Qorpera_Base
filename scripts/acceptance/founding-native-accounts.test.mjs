import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { openNativeCredentialCapsule } from "../../packages/runtime/src/cloud-native-provider-host.ts";
import { foundingNativeAccounts, assertFoundingSyntheticToken } from "./founding-native-accounts.mjs";

test("synthetic member login uses scoped member RPCs and actual production encrypted capsule format", async () => {
	const privateRoot = await mkdtemp(join(tmpdir(), "qorpera-founding-accounts-"));
	const userId = randomUUID(),
		profileId = randomUUID(),
		identityId = randomUUID(),
		connectionId = randomUUID();
	let completion, stored;
	try {
		const accounts = foundingNativeAccounts({
			privateRoot,
			serviceRpc: async (name, args) => {
				assert.equal(name, "qorpera_complete_native_provider_login");
				completion = args;
				return {
					owner_user_id: userId,
					compute_identity_id: identityId,
					connection_id: connectionId,
					version: 1,
				};
			},
		});
		const called = [];
		await accounts.setup({
			profileId,
			members: [{ userId }],
			invokeMember: async (owner, name, args) => {
				assert.equal(owner, userId);
				assert.equal(args.p_profile_id, profileId);
				called.push(name);
				return {
					status: 200,
					body:
						name === "qorpera_upsert_member_compute_identity"
							? { owner_user_id: owner, compute_identity_id: identityId }
							: name === "qorpera_begin_native_provider_login"
								? { login_id: randomUUID() }
								: {},
				};
			},
		});
		assert.deepEqual(called, [
			"qorpera_upsert_member_compute_identity",
			"qorpera_begin_native_provider_login",
			"qorpera_create_member_execution_sponsor",
		]);
		const masterKey = randomBytes(32).toString("base64url");
		const args = {
			profileId,
			computeIdentityId: identityId,
			userId,
			masterKey,
			store: {
				put: async (reference, bytes) => {
					assert.equal(reference, completion.p_encrypted_capsule_reference);
					stored = bytes;
				},
			},
		};
		await assert.rejects(accounts.sealForGuest({ ...args, userId: randomUUID() }));
		const result = await accounts.sealForGuest(args);
		assert.equal(assertFoundingSyntheticToken(result.token), userId);
		assert(!Buffer.from(stored).toString("utf8").includes(result.token));
		const restored = await mkdtemp(join(privateRoot, "restored-"));
		await openNativeCredentialCapsule(
			stored,
			restored,
			masterKey,
			result.capsuleId,
			new Set(["codex/auth.json"]),
		);
		const auth = JSON.parse(await readFile(join(restored, "codex/auth.json"), "utf8"));
		assert.equal(auth.tokens.access_token, result.token);
		assert.equal(auth.tokens.account_id, userId);
		await assert.rejects(accounts.sealForGuest(args));
		assert.throws(() => assertFoundingSyntheticToken("real-provider-token"));
	} finally {
		await rm(privateRoot, { recursive: true });
	}
});
