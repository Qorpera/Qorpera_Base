import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudIdentityRecoveryAuthority } from "../packages/runtime/src/cloud-identity-recovery.ts";
import { recoveryDigest, recoveryPublicKeyText } from "../packages/runtime/src/cloud-identity-recovery-crypto.ts";
import {
	assertIdentityRecoveryMarker, backupNativeIdentityKey, HttpIdentityRecoveryGuestTransport,
	identityRecoveryEpochFilename, parseIdentityRecoveryRuntimeState, restoreNativeIdentityKey,
} from "../packages/runtime/src/cloud-identity-recovery-guest.ts";
import { HttpIdentityRecoveryService } from "../packages/runtime/src/cloud-identity-recovery-service.ts";
import { FileRecoveryObjectStore } from "../packages/runtime/src/cloud-identity-recovery-store.ts";
import { openNativeCredentialCapsule, sealNativeCredentialCapsule } from "../packages/runtime/src/cloud-native-provider-host.ts";

function literal(value) {
	if (typeof value === "string") return "'" + value.replaceAll("'", "''") + "'";
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	throw new Error("Unsupported recovery fixture RPC argument");
}

/** Synthetic keys only. Exercises the actual SQL authority, service HTTP loop,
 * signed envelopes, durable guest install and native capsule format together.
 * Local directories stand in for remote replicas; no live cloud claim. */
export async function verifyIdentityRecoveryRoundTrip({ sql, source, actor }) {
	const ids = {
		company: "29810000-0000-4000-8000-000000000010", identity: "29810000-0000-4000-8000-000000000020",
		authority: "29810000-0000-4000-8000-000000000030", owner: "29810000-0000-4000-8000-000000000001",
		member: "29810000-0000-4000-8000-000000000002", target: "29810000-0000-4000-8000-000000000040",
		node: "29810000-0000-4000-8000-000000000041", capsule: "29810000-0000-4000-8000-000000000052",
		client: "29810000-0000-4000-8000-000000000060",
	};
	const wrapper = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const signer = generateKeyPairSync("ed25519");
	const recipient = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const masterKey = randomBytes(32);
	const loginCapability = randomBytes(32).toString("base64url");
	const serviceCapability = randomBytes(32).toString("base64url");
	const operatorCapability = randomBytes(32).toString("base64url");
	const targetCapability = randomBytes(32).toString("base64url");
	const fixture = (await source("supabase/tests/298_compute_identity_recovery.test.sql"))
		.split("-- RECOVERY_NATIVE_LOGIN_FIXTURE_READY");
	assert.equal(fixture.length, 2);
	assert.ok(fixture[0].includes("repeat('A',59),repeat('A',550)"));
	sql(fixture[0].replaceAll("29800000", "29810000")
		.replace("repeat('A',59),repeat('A',550)", literal(recoveryPublicKeyText(signer.publicKey)) + "," + literal(recoveryPublicKeyText(wrapper.publicKey)))
		.replace("repeat('c',64)", literal(recoveryDigest(serviceCapability)))
		.replaceAll("repeat('d',64)", literal(recoveryDigest(loginCapability))) + "\ncommit;");
	const loginId = sql(`select id from public.qorpera_native_provider_login_sessions where compute_identity_id='${ids.identity}'`);
	assert.match(loginId, /^[0-9a-f-]{36}$/);
	const serviceSql = (statement) => actor("service_role", undefined, statement);
	const operations = new Set([
		"identity_recovery_service_configuration", "prepare_identity_key_backup", "complete_identity_key_backup",
		"register_identity_recovery_target", "prepare_identity_key_release", "commit_identity_key_release",
		"identity_recovery_completion_authority", "complete_identity_recovery",
	]);
	const control = {
		async call(operation, args, signal) {
			signal.throwIfAborted();
			assert.ok(operations.has(operation));
			const parameters = { ...args, p_authority_id: ids.authority, p_service_capability_sha256: recoveryDigest(serviceCapability) };
			const encoded = Object.entries(parameters).map(([name, value]) => {
				assert.match(name, /^p_[a-z0-9_]+$/);
				return name + " => " + literal(value);
			}).join(",");
			return JSON.parse(sql(serviceSql(`select public.qorpera_${operation}(${encoded})`)));
		},
	};
	const runtimeState = () => parseIdentityRecoveryRuntimeState(JSON.parse(sql(serviceSql(
		`select public.qorpera_identity_recovery_runtime_state('${ids.identity}')`))));
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-recovery-sql-round-trip-"));
	const service = new HttpIdentityRecoveryService(new CloudIdentityRecoveryAuthority({
		companyId: ids.company, authorityId: ids.authority, wrapper: wrapper.privateKey, signer: signer.privateKey,
		control, journal: new FileRecoveryObjectStore(join(temporary, "journal")),
		nas: new FileRecoveryObjectStore(join(temporary, "nas")), supabase: new FileRecoveryObjectStore(join(temporary, "backup")),
	}), operatorCapability);
	try {
		for (const name of ["journal", "nas", "backup", "identity", "original", "decrypted"])
			await mkdir(join(temporary, name), { mode: 0o700 });
		const url = await service.start();
		const transport = new HttpIdentityRecoveryGuestTransport("https://recovery.example.test",
			(input, init) => fetch(new URL(new URL(String(input)).pathname, url), init));
		const signal = AbortSignal.timeout(60_000);
		await backupNativeIdentityKey({
			state: runtimeState(), masterKey: masterKey.toString("base64url"), loginId, loginCapability, transport, signal,
		});
		const backup = JSON.parse(sql(serviceSql(`select public.qorpera_prepare_identity_key_backup(
			'${ids.authority}','${recoveryDigest(serviceCapability)}','${loginId}',
			'${recoveryDigest(loginCapability)}','${recoveryDigest(masterKey)}')`)));
		assert.equal(backup.status, "ready");
		assert.equal(backup.binding.keySha256, recoveryDigest(masterKey));
		assert.deepEqual(await readFile(join(temporary, "nas", backup.objectSha256)),
			await readFile(join(temporary, "backup", backup.objectSha256)));
		await mkdir(join(temporary, "original", "codex"), { mode: 0o700 });
		await writeFile(join(temporary, "original", "codex", "auth.json"), '{"syntheticCredential":true}', { mode: 0o600 });
		const capsule = await sealNativeCredentialCapsule(join(temporary, "original"), masterKey.toString("base64url"), ids.capsule);
		sql(serviceSql(`select public.qorpera_complete_native_provider_login(
			'${loginId}','${recoveryDigest(loginCapability)}','${ids.capsule}','native-capsule/${ids.capsule}',
			repeat('e',64),'synthetic','test','recovery-fixture/v1',
			'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}')`));
		const registration = await fetch(url + "/operator/target", {
			method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + operatorCapability },
			body: JSON.stringify({
				targetId: ids.target, computeIdentityId: ids.identity, nodeId: ids.node,
				imageSha256: "1".repeat(64), guestManifestSha256: "2".repeat(64),
				recipientPublicKey: recoveryPublicKeyText(recipient.publicKey), targetCapability,
			}), signal,
		});
		assert.equal(registration.status, 200);
		assert.equal((await registration.json()).targetId, ids.target);
		const requested = JSON.parse(sql(actor("authenticated", ids.owner,
			`select public.qorpera_request_identity_recovery('${ids.identity}','${ids.target}','${ids.client}',
			${backup.binding.revision},'${backup.objectSha256}','supabase')`)));
		assert.equal(requested.status, "awaiting_member");
		await assert.rejects(transport.post("release", { recoveryId: requested.recoveryId, targetCapability }, signal));
		const approval = JSON.parse(sql(actor("authenticated", ids.member,
			`select public.qorpera_consent_identity_recovery('${requested.recoveryId}')`)));
		assert.equal(approval.epoch, 1);
		assert.equal(runtimeState().blocked, true);
		await assert.rejects(transport.post("release", { recoveryId: approval.recoveryId, targetCapability }, signal));
		// Move only this synthetic fixture's quiet-period clock after proving it denies.
		sql(`update public.qorpera_identity_recoveries set not_before=clock_timestamp()-interval '1 second'
			where id='${approval.recoveryId}'`);
		let loseAcknowledgement = true;
		const retryTransport = {
			async post(path, body, requestSignal) {
				const value = await transport.post(path, body, requestSignal);
				if (path === "complete" && loseAcknowledgement) {
					loseAcknowledgement = false;
					throw new Error("Synthetic lost completion acknowledgement");
				}
				return value;
			},
		};
		const restore = {
			directory: join(temporary, "identity"), companyId: ids.company, computeIdentityId: ids.identity,
			authorityId: ids.authority, recoveryId: approval.recoveryId, targetId: ids.target, epoch: approval.epoch,
			backupSha256: backup.objectSha256, recipientKey: recipient.privateKey, signingKey: signer.publicKey,
			targetCapability, transport: retryTransport, signal,
		};
		await assert.rejects(restoreNativeIdentityKey(restore), /Synthetic lost completion/);
		const receipt = await restoreNativeIdentityKey(restore);
		assert.deepEqual(await restoreNativeIdentityKey(restore), receipt);
		assert.equal(receipt.storageSource, "supabase");
		assert.equal(runtimeState().blocked, false);
		const restored = (await readFile(join(restore.directory, "qorpera-native-provider-master-key"), "utf8")).trim();
		assert.equal(restored, masterKey.toString("base64url"));
		assertIdentityRecoveryMarker(JSON.parse(await readFile(join(restore.directory, identityRecoveryEpochFilename(1)), "utf8")), runtimeState());
		await openNativeCredentialCapsule(capsule, join(temporary, "decrypted"), restored, ids.capsule);
		assert.equal(await readFile(join(temporary, "decrypted", "codex", "auth.json"), "utf8"), '{"syntheticCredential":true}');
		assert.equal(sql(`select count(*) from public.qorpera_execution_runs where profile_id='${ids.company}'`), "0");
		assert.equal(sql("select count(*) from public.qorpera_agent_sends"), "0");
		assert.equal(sql(`select count(*) from public.qorpera_provider_connection_versions version
			join public.qorpera_provider_connections connection on connection.id=version.connection_id
			where connection.profile_id='${ids.company}' and version.allow_autonomous`), "0");
		return { synthetic: true, sqlCryptoRoundTrip: true, guestLostAckReplay: true, noWorkOrSend: true };
	} finally {
		await service.close();
		masterKey.fill(0);
		await rm(temporary, { recursive: true, force: true });
	}
}
