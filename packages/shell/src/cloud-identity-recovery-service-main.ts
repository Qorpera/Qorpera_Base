import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CloudIdentityRecoveryAuthority,
	recoveryCapability,
	SupabaseRecoveryControl,
} from "./cloud-identity-recovery.ts";
import { parseRecoveryPrivateKey, readRecoveryCredential } from "./cloud-identity-recovery-config.ts";
import {
	recoveryInteger,
	recoveryPublicKeyText,
	recoveryRecord,
	recoveryUuid,
} from "./cloud-identity-recovery-crypto.ts";
import { openRecoveryFilesystems } from "./cloud-identity-recovery-filesystems.ts";
import { HttpIdentityRecoveryService } from "./cloud-identity-recovery-service.ts";
import { SupabaseRecoveryObjectStore } from "./cloud-identity-recovery-store.ts";

export async function runIdentityRecoveryServiceMain(environment = process.env): Promise<void> {
	if (process.platform !== "linux") throw new Error("The recovery authority runs on a separate cloud Linux service");
	const directory = environment.CREDENTIALS_DIRECTORY;
	if (!directory || !isAbsolute(directory)) throw new Error("Recovery service requires systemd credentials");
	const config = recoveryRecord(JSON.parse(await readRecoveryCredential(directory, "qorpera-recovery-config")), [
		"schema",
		"companyId",
		"authorityId",
		"supabaseUrl",
		"journalRoot",
		"journalMountPoint",
		"nasRoot",
		"nasMountPoint",
		"nasSource",
		"port",
	]);
	if (config.schema !== "qorpera.identity-recovery-service/v2")
		throw new Error("Recovery service configuration is unsupported");
	const companyId = recoveryUuid(config.companyId);
	const authorityId = recoveryUuid(config.authorityId);
	const { journal, nas } = await openRecoveryFilesystems({
		journalRoot: config.journalRoot,
		journalMountPoint: config.journalMountPoint,
		nasRoot: config.nasRoot,
		nasMountPoint: config.nasMountPoint,
		nasSource: config.nasSource,
	});
	const port = recoveryInteger(config.port);
	if (port > 65535) throw new Error("Recovery service port is invalid");
	const serviceKey = await readRecoveryCredential(directory, "qorpera-supabase-service-key");
	const capability = recoveryCapability(await readRecoveryCredential(directory, "qorpera-recovery-control"));
	const operatorCapability = recoveryCapability(await readRecoveryCredential(directory, "qorpera-recovery-operator"));
	if (capability === operatorCapability || capability === serviceKey || operatorCapability === serviceKey)
		throw new Error("Recovery service capabilities must be independent");
	const wrapper = parseRecoveryPrivateKey(
		await readRecoveryCredential(directory, "qorpera-recovery-wrapping-key"),
		"rsa",
	);
	const signer = parseRecoveryPrivateKey(
		await readRecoveryCredential(directory, "qorpera-recovery-signing-key"),
		"ed25519",
	);
	const control = new SupabaseRecoveryControl(String(config.supabaseUrl), serviceKey, authorityId, capability);
	const registered = recoveryRecord(
		await control.call("identity_recovery_service_configuration", {}, AbortSignal.timeout(10_000)),
		["companyId", "authorityId", "signingPublicKey", "wrappingPublicKey"],
	);
	if (
		registered.companyId !== companyId ||
		registered.authorityId !== authorityId ||
		registered.signingPublicKey !== recoveryPublicKeyText(signer) ||
		registered.wrappingPublicKey !== recoveryPublicKeyText(wrapper)
	)
		throw new Error("Recovery service keys do not match the independently registered authority");
	const service = new HttpIdentityRecoveryService(
		new CloudIdentityRecoveryAuthority({
			companyId,
			authorityId,
			signer,
			wrapper,
			control,
			journal,
			nas,
			supabase: new SupabaseRecoveryObjectStore(String(config.supabaseUrl), serviceKey, companyId),
		}),
		operatorCapability,
	);
	const stop = new AbortController();
	const shutdown = (): void => stop.abort();
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	try {
		await service.start(port);
		await new Promise<void>((resolveWait) => {
			if (stop.signal.aborted) resolveWait();
			else stop.signal.addEventListener("abort", () => resolveWait(), { once: true });
		});
	} finally {
		process.removeListener("SIGINT", shutdown);
		process.removeListener("SIGTERM", shutdown);
		await service.close();
	}
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
	if (process.argv.length === 3 && process.argv[2] === "--help") {
		console.log(
			"Cloud identity recovery service. Requires private systemd credentials and independent journal/NAS mounts.",
		);
	} else {
		runIdentityRecoveryServiceMain().catch(() => {
			console.error(
				"Cloud identity recovery service could not start or continue; inspect private configuration and authority.",
			);
			process.exitCode = 1;
		});
	}
}
