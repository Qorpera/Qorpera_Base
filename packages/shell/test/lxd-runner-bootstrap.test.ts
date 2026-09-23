import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoveryPublicKeyText } from "@qorpera/runtime/cloud-identity-recovery-crypto";
import type { IdentityRecoveryRuntimeState } from "@qorpera/runtime/cloud-identity-recovery-guest";
import {
	type LxdNativeLoginBootstrapPaths,
	type LxdRunnerBootstrapPaths,
	parseLxdNativeLoginBootstrapConfig,
	parseLxdRunnerBootstrapConfig,
	runLxdNativeLoginBootstrap,
	runLxdRunnerBootstrap,
} from "@qorpera/runtime/lxd-runner-bootstrap";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const computeIdentityId = "90000000-0000-4000-8000-000000000001";
const fixtureKey = Buffer.alloc(32, 7).toString("base64url");
const identityRecoveryCa = readFileSync(
	new URL("../../../deploy/cloud-secret-broker/supabase-prod-ca-2021.crt", import.meta.url),
	"utf-8",
);
const identityRecoveryCaSha256 = createHash("sha256").update(identityRecoveryCa).digest("hex");
const fixtureState: IdentityRecoveryRuntimeState = {
	companyId: "90000000-0000-4000-8000-000000000004",
	computeIdentityId,
	epoch: 0,
	blocked: false,
	policySha256: "a".repeat(64),
	keySha256: createHash("sha256").update(Buffer.alloc(32, 7)).digest("hex"),
	canInitialize: false,
	recoveryConfiguration: {
		authorityId: "90000000-0000-4000-8000-000000000005",
		serviceOrigin: "https://recovery.example.test",
		signingPublicKey: recoveryPublicKeyText(generateKeyPairSync("ed25519").publicKey),
		wrappingPublicKey: recoveryPublicKeyText(generateKeyPairSync("rsa", { modulusLength: 3072 }).publicKey),
	},
};

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{
	root: string;
	paths: LxdRunnerBootstrapPaths;
	sharedGid: number;
}> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-lxd-bootstrap-"));
	roots.push(root);
	const paths: LxdRunnerBootstrapPaths = {
		bootstrapConfig: join(root, "bootstrap.json"),
		runnerConfig: join(root, "runner-config.json"),
		nativeProviderEnvironment: join(root, "native-provider.env"),
		credentialSource: join(root, "credentials"),
		identityVolume: join(root, "identity"),
		identityMarker: join(root, "identity", "qorpera-compute-identity.json"),
		identityMasterKey: join(root, "identity", "qorpera-native-provider-master-key"),
		runnerHomeDirectory: join(root, "runner"),
		runnerConfigDestination: join(root, "runner", ".config", "qorpera-runner", "config.json"),
		runnerStateDirectory: join(root, "runner", ".local", "state", "qorpera-runner"),
		runnerTemporaryDirectory: join(root, "native-workspace"),
		nativeProviderTemporaryDirectory: join(root, "native", "tmp"),
		mountInfo: join(root, "mountinfo"),
	};
	const currentGid = process.getgid?.() ?? 1;
	const sharedGid = currentGid > 0 ? currentGid : 1;
	await mkdir(paths.credentialSource, { recursive: true, mode: 0o700 });
	await mkdir(paths.identityVolume, { recursive: true, mode: 0o700 });
	await writeFile(paths.identityMasterKey, `${fixtureKey}\n`, { mode: 0o600 });
	await writeFile(
		paths.identityMarker,
		JSON.stringify({
			schema: "qorpera.compute-identity-volume/v1",
			compute_identity_id: computeIdentityId,
		}),
		{ mode: 0o600 },
	);
	await writeFile(
		paths.bootstrapConfig,
		`${JSON.stringify({
			schema: "qorpera.lxd-runner-bootstrap/v1",
			compute_identity_id: computeIdentityId,
			compute_template_key: "qorpera-member-linux",
			compute_template_version: "v1",
			compute_policy_sha256: "a".repeat(64),
			runner_config_path: "/var/lib/qorpera-bootstrap/runner-config.json",
			native_provider_environment_path: "/var/lib/qorpera-bootstrap/native-provider.env",
			credential_source: "/var/lib/qorpera-bootstrap/credentials",
			identity_volume_path: "/var/lib/qorpera/identity",
		})}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		paths.runnerConfig,
		`${JSON.stringify({
			schema: "qorpera.ephemeral-runner-service/v1",
			base_url: "https://project.test",
			publishable_key: "publishable-test",
			runner_id: "90000000-0000-4000-8000-000000000002",
			authority_state_path: join(root, "runner", "authority.json"),
			temporary_root: paths.runnerTemporaryDirectory,
			image: `registry.test/qorpera@sha256:${"b".repeat(64)}`,
			podman_path: "/usr/bin/podman",
			entrypoint: "/qorpera/bin/run-job",
			capabilities: ["agent_turn"],
			job_types: ["agent_turn"],
			platform: "linux-x64",
			runner_version: "test",
			native_bridge_url: "http://127.0.0.1:8083/",
			native_bridge_boundary: "virtual_machine",
			native_bridge_shared_gid: sharedGid,
			assignment_host: "0.0.0.0",
			assignment_port: 8082,
			assignment_trusted_source: "10.41.0.1",
			max_assignments: 1,
			environment: {},
		})}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		paths.nativeProviderEnvironment,
		[
			"QORPERA_SUPABASE_URL=https://project.test",
			"QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY=virtual_machine",
			`QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID=${computeIdentityId}`,
			"QORPERA_NATIVE_PROVIDER_HOST=127.0.0.1",
			"QORPERA_NATIVE_PROVIDER_PORT=8083",
			"QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT=/var/lib/qorpera-native-provider/tmp",
			"QORPERA_CODEX_PATH=/usr/local/bin/codex",
			"QORPERA_CLAUDE_PATH=/usr/local/bin/claude",
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	for (const [name, value] of [
		["qorpera-native-bridge", "c".repeat(43)],
		["qorpera-runner-activation", "d".repeat(43)],
		["qorpera-runner-assignment", "e".repeat(43)],
		["qorpera-supabase-service-key", "service-key-test"],
	] as const) {
		await writeFile(join(paths.credentialSource, name), `${value}\n`, { mode: 0o600 });
	}
	const escapedMount = paths.identityVolume.replaceAll(" ", "\\040");
	await writeFile(paths.mountInfo, `42 1 0:99 / ${escapedMount} rw - virtiofs identity rw\n`);
	return { root, paths, sharedGid };
}

async function loginFixture(): Promise<{ root: string; paths: LxdNativeLoginBootstrapPaths }> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-lxd-native-login-bootstrap-"));
	roots.push(root);
	const paths: LxdNativeLoginBootstrapPaths = {
		bootstrapConfig: join(root, "login-bootstrap.json"),
		nativeProviderEnvironment: join(root, "native-provider.env"),
		credentialSource: join(root, "credentials"),
		identityVolume: join(root, "identity"),
		identityMarker: join(root, "identity", "qorpera-compute-identity.json"),
		identityMasterKey: join(root, "identity", "qorpera-native-provider-master-key"),
		nativeProviderTemporaryDirectory: join(root, "native", "tmp"),
		mountInfo: join(root, "mountinfo"),
	};
	await mkdir(paths.credentialSource, { recursive: true, mode: 0o700 });
	await mkdir(paths.identityVolume, { recursive: true, mode: 0o700 });
	await writeFile(
		paths.bootstrapConfig,
		`${JSON.stringify({
			schema: "qorpera.lxd-native-login-bootstrap/v1",
			compute_identity_id: computeIdentityId,
			supabase_url: "https://project.test",
			native_bridge_url: "http://127.0.0.1:8083/",
			trusted_source: "10.41.0.1",
			identity_recovery_ca_sha256: identityRecoveryCaSha256,
			native_provider_environment_path: "/var/lib/qorpera-bootstrap/native-provider.env",
			credential_source: "/var/lib/qorpera-bootstrap/credentials",
			identity_volume_path: "/var/lib/qorpera/identity",
		})}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		paths.nativeProviderEnvironment,
		[
			"QORPERA_SUPABASE_URL=https://project.test",
			"QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY=virtual_machine",
			`QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID=${computeIdentityId}`,
			"QORPERA_NATIVE_PROVIDER_HOST=0.0.0.0",
			"QORPERA_NATIVE_PROVIDER_TRUSTED_SOURCE=10.41.0.1",
			"QORPERA_NATIVE_PROVIDER_PORT=8083",
			"QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT=/var/lib/qorpera-native-provider/tmp",
			"QORPERA_CODEX_PATH=/usr/local/bin/codex",
			"QORPERA_CLAUDE_PATH=/usr/local/bin/claude",
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	await writeFile(join(paths.credentialSource, "qorpera-identity-recovery-ca"), identityRecoveryCa, { mode: 0o600 });
	await writeFile(join(paths.credentialSource, "qorpera-native-bridge"), `${"c".repeat(43)}\n`, { mode: 0o600 });
	await writeFile(join(paths.credentialSource, "qorpera-supabase-service-key"), "service-key-test\n", {
		mode: 0o600,
	});
	const escapedMount = paths.identityVolume.replaceAll(" ", "\\040");
	await writeFile(paths.mountInfo, `42 1 0:99 / ${escapedMount} rw - virtiofs identity rw\n`);
	return { root, paths };
}

async function companyFixture(): Promise<LxdRunnerBootstrapPaths> {
	const { root, paths } = await fixture();
	const secretBrokerCa = await readFile(
		new URL("../../../deploy/cloud-secret-broker/supabase-prod-ca-2021.crt", import.meta.url),
		"utf-8",
	);
	const binary = join(root, "codex-pinned");
	const content = "synthetic native executable, never executed by bootstrap tests\n";
	await writeFile(binary, content, { mode: 0o500 });
	const digest = createHash("sha256").update(content).digest("hex");
	const bootstrap = JSON.parse(await readFile(paths.bootstrapConfig, "utf-8")) as Record<string, unknown>;
	bootstrap.schema = "qorpera.lxd-company-runner-bootstrap/v1";
	bootstrap.company_runtime = {
		mode: "company-path-v1",
		run_id: "90000000-0000-4000-8000-000000000003",
		profile_id: "90000000-0000-4000-8000-000000000004",
		runner_id: "90000000-0000-4000-8000-000000000002",
		codex_path: binary,
		binary_sha256: digest,
		object_gateway_url: "https://objects.test",
		secret_broker_url: "https://secrets.test",
		secret_broker_ca_sha256: createHash("sha256").update(secretBrokerCa).digest("hex"),
		recovery_volume_path: "/var/lib/qorpera-runner",
	};
	await writeFile(paths.bootstrapConfig, `${JSON.stringify(bootstrap)}\n`, { mode: 0o600 });
	const config = JSON.parse(await readFile(paths.runnerConfig, "utf-8")) as Record<string, unknown>;
	delete config.native_bridge_shared_gid;
	config.authority_state_path = join(paths.runnerStateDirectory, "authority.json");
	await writeFile(paths.runnerConfig, `${JSON.stringify(config)}\n`, { mode: 0o600 });
	await writeFile(
		paths.nativeProviderEnvironment,
		`${await readFile(paths.nativeProviderEnvironment, "utf-8")}QORPERA_NATIVE_RUNTIME=company-path-v1\nQORPERA_NATIVE_CODEX_FENCE_PATH=${binary}\nQORPERA_NATIVE_CODEX_FENCE_SHA256=${digest}\nQORPERA_NATIVE_OBJECT_GATEWAY_URL=https://objects.test\nQORPERA_CLOUD_SECRET_BROKER_URL=https://secrets.test\n`,
		{ mode: 0o600 },
	);
	await writeFile(join(paths.credentialSource, "qorpera-native-object-token"), `${"q".repeat(43)}\n`, { mode: 0o600 });
	await writeFile(join(paths.credentialSource, "qorpera-office-native"), "", { mode: 0o600 });
	await writeFile(join(paths.credentialSource, "qorpera-coding-command"), "", { mode: 0o600 });
	await writeFile(join(paths.credentialSource, "qorpera-cloud-secret-runtime"), `${"s".repeat(43)}\n`, {
		mode: 0o600,
	});
	await writeFile(join(paths.credentialSource, "qorpera-cloud-secret-ca"), secretBrokerCa, { mode: 0o600 });
	await mkdir(paths.runnerHomeDirectory, { mode: 0o700 });
	await writeFile(
		paths.mountInfo,
		`1 0 8:1 / / rw - ext4 root rw\n${await readFile(paths.mountInfo, "utf-8")}43 1 0:100 / ${paths.runnerHomeDirectory.replaceAll(" ", "\\040")} rw - virtiofs recovery rw\n`,
	);
	return paths;
}

async function startCompanyFixture(paths: LxdRunnerBootstrapPaths, started: string[]): Promise<void> {
	const uid = process.getuid?.() ?? 0;
	const gid = process.getgid?.() ?? 0;
	await runLxdRunnerBootstrap({
		paths,
		identityRuntimeState: async () => fixtureState,
		expectedRootUid: uid,
		expectedRootGid: gid,
		serviceIdentity: { uid, gid },
		nativeServiceIdentity: { uid, gid },
		startService: async (service) => {
			started.push(service);
		},
	});
}

describe("LXD runner guest bootstrap", () => {
	it("strictly binds the guest to one Compute Identity and starts native then runner services", async () => {
		const { root, paths, sharedGid } = await fixture();
		const uid = process.getuid?.() ?? 0;
		const gid = process.getgid?.() ?? 0;
		const started: string[] = [];

		await runLxdRunnerBootstrap({
			paths,
			identityRuntimeState: async () => fixtureState,
			expectedRootUid: uid,
			expectedRootGid: gid,
			serviceIdentity: { uid, gid },
			nativeServiceIdentity: { uid, gid: sharedGid },
			runnerSupplementaryGids: [sharedGid],
			startService: async (service) => {
				started.push(service);
			},
		});

		expect(started).toEqual(["qorpera-native-provider-host.service", "qorpera-ephemeral-runner.service"]);
		expect(JSON.parse(await readFile(paths.identityMarker, "utf-8"))).toEqual({
			schema: "qorpera.compute-identity-volume/v1",
			compute_identity_id: computeIdentityId,
		});
		expect((await readFile(paths.identityMasterKey, "utf-8")).trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(JSON.parse(await readFile(paths.runnerConfigDestination, "utf-8"))).toMatchObject({
			runner_id: "90000000-0000-4000-8000-000000000002",
			native_bridge_shared_gid: sharedGid,
		});
		expect((await stat(paths.runnerConfigDestination)).mode & 0o777).toBe(0o600);
		expect((await stat(paths.runnerTemporaryDirectory)).mode & 0o777).toBe(0o700);
		expect((await stat(paths.runnerTemporaryDirectory)).uid).toBe(uid);
		for (const directory of [join(root, "runner", ".local"), join(root, "runner", ".config"), join(root, "native")]) {
			expect((await stat(directory)).mode & 0o777).toBe(0o700);
			expect((await stat(directory)).uid).toBe(uid);
		}
	});

	it("refuses a runner temporary root outside the dedicated native workspace", async () => {
		const { root, paths, sharedGid } = await fixture();
		const config = JSON.parse(await readFile(paths.runnerConfig, "utf-8")) as Record<string, unknown>;
		config.temporary_root = join(root, "runner", "tmp");
		await writeFile(paths.runnerConfig, `${JSON.stringify(config)}\n`, { mode: 0o600 });

		await expect(
			runLxdRunnerBootstrap({
				paths,
				identityRuntimeState: async () => fixtureState,
				expectedRootUid: process.getuid?.() ?? 0,
				expectedRootGid: process.getgid?.() ?? 0,
				serviceIdentity: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
				nativeServiceIdentity: { uid: process.getuid?.() ?? 0, gid: sharedGid },
				runnerSupplementaryGids: [sharedGid],
				startService: async () => undefined,
			}),
		).rejects.toThrow("does not enforce the single-lane private assignment boundary");
	});

	it("refuses an identity volume already bound to another Compute Identity", async () => {
		const { paths, sharedGid } = await fixture();
		const uid = process.getuid?.() ?? 0;
		const gid = process.getgid?.() ?? 0;
		await writeFile(
			paths.identityMarker,
			`${JSON.stringify({
				schema: "qorpera.compute-identity-volume/v1",
				compute_identity_id: "90000000-0000-4000-8000-000000000099",
			})}\n`,
			{ mode: 0o600 },
		);

		await expect(
			runLxdRunnerBootstrap({
				paths,
				identityRuntimeState: async () => fixtureState,
				expectedRootUid: uid,
				expectedRootGid: gid,
				serviceIdentity: { uid, gid },
				nativeServiceIdentity: { uid, gid: sharedGid },
				runnerSupplementaryGids: [sharedGid],
				startService: async () => undefined,
			}),
		).rejects.toThrow("does not match bootstrap authority");
	});

	it("rejects unknown bootstrap fields and non-contract paths", () => {
		const base = {
			schema: "qorpera.lxd-runner-bootstrap/v1",
			compute_identity_id: computeIdentityId,
			compute_template_key: "qorpera-member-linux",
			compute_template_version: "v1",
			compute_policy_sha256: "a".repeat(64),
			runner_config_path: "/var/lib/qorpera-bootstrap/runner-config.json",
			native_provider_environment_path: "/var/lib/qorpera-bootstrap/native-provider.env",
			credential_source: "/var/lib/qorpera-bootstrap/credentials",
			identity_volume_path: "/var/lib/qorpera/identity",
		};
		expect(() => parseLxdRunnerBootstrapConfig({ ...base, typo: true })).toThrow("unknown field");
		expect(() => parseLxdRunnerBootstrapConfig({ ...base, identity_volume_path: "/tmp/identity" })).toThrow(
			"outside the guest-image contract",
		);
	});
});

describe("LXD native login guest bootstrap", () => {
	it("pins one Compute Identity, initializes its key inside the volume and starts only the native host", async () => {
		const { root, paths } = await loginFixture();
		const uid = process.getuid?.() ?? 0;
		const gid = process.getgid?.() ?? 0;
		const started: string[] = [];

		await runLxdNativeLoginBootstrap({
			paths,
			identityRuntimeState: async () => ({ ...fixtureState, keySha256: null, canInitialize: true }),
			expectedRootUid: uid,
			expectedRootGid: gid,
			nativeServiceIdentity: { uid, gid },
			startService: async (service) => {
				started.push(service);
			},
		});

		expect(started).toEqual(["qorpera-native-login-provider-host.service"]);
		expect(JSON.parse(await readFile(paths.identityMarker, "utf-8"))).toEqual({
			schema: "qorpera.compute-identity-volume/v1",
			compute_identity_id: computeIdentityId,
		});
		expect((await readFile(paths.identityMasterKey, "utf-8")).trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect((await stat(join(root, "native"))).mode & 0o777).toBe(0o700);
	});

	it("stops before key initialization or provider sign-in when recovery is not configured", async () => {
		const { paths } = await loginFixture();
		const uid = process.getuid?.() ?? 0;
		const gid = process.getgid?.() ?? 0;
		const started: string[] = [];
		await expect(
			runLxdNativeLoginBootstrap({
				paths,
				expectedRootUid: uid,
				expectedRootGid: gid,
				nativeServiceIdentity: { uid, gid },
				identityRuntimeState: async () => ({
					...fixtureState,
					keySha256: null,
					canInitialize: true,
					recoveryConfiguration: null,
				}),
				startService: async (service) => {
					started.push(service);
				},
			}),
		).rejects.toThrow("configured cloud recovery authority");
		expect(started).toEqual([]);
		await expect(readFile(paths.identityMasterKey)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects unknown configuration fields and extra guest credentials", async () => {
		const base = {
			schema: "qorpera.lxd-native-login-bootstrap/v1",
			compute_identity_id: computeIdentityId,
			supabase_url: "https://project.test",
			native_bridge_url: "http://127.0.0.1:8083/",
			trusted_source: "10.41.0.1",
			identity_recovery_ca_sha256: identityRecoveryCaSha256,
			native_provider_environment_path: "/var/lib/qorpera-bootstrap/native-provider.env",
			credential_source: "/var/lib/qorpera-bootstrap/credentials",
			identity_volume_path: "/var/lib/qorpera/identity",
		};
		expect(() => parseLxdNativeLoginBootstrapConfig({ ...base, typo: true })).toThrow("unknown field");

		const { paths } = await loginFixture();
		await writeFile(join(paths.credentialSource, "qorpera-runner-assignment"), `${"d".repeat(43)}\n`, {
			mode: 0o600,
		});
		const uid = process.getuid?.() ?? 0;
		const gid = process.getgid?.() ?? 0;
		await expect(
			runLxdNativeLoginBootstrap({
				paths,
				identityRuntimeState: async () => fixtureState,
				expectedRootUid: uid,
				expectedRootGid: gid,
				nativeServiceIdentity: { uid, gid },
				startService: async () => undefined,
			}),
		).rejects.toThrow("unexpected entries");
	});

	it("rejects a recovery-authority CA that differs from the pinned bootstrap", async () => {
		const { paths } = await loginFixture();
		await writeFile(join(paths.credentialSource, "qorpera-identity-recovery-ca"), "not the pinned CA\n", {
			mode: 0o600,
		});
		const started: string[] = [];
		await expect(
			runLxdNativeLoginBootstrap({
				paths,
				identityRuntimeState: async () => ({ ...fixtureState, keySha256: null, canInitialize: true }),
				expectedRootUid: process.getuid?.() ?? 0,
				expectedRootGid: process.getgid?.() ?? 0,
				nativeServiceIdentity: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
				startService: async (service) => {
					started.push(service);
				},
			}),
		).rejects.toThrow("does not match immutable bootstrap authority");
		expect(started).toEqual([]);
	});
});

describe("governed native company guest bootstrap", () => {
	it("does not create a replacement key when established identity material is missing", async () => {
		const paths = await companyFixture();
		await rm(paths.identityMasterKey);
		const started: string[] = [];
		await expect(startCompanyFixture(paths, started)).rejects.toThrow("master key is missing");
		expect(started).toEqual([]);
		await expect(readFile(paths.identityMasterKey)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects old volumes after the cloud recovery generation advances", async () => {
		const paths = await companyFixture();
		const uid = process.getuid?.() ?? 0;
		const gid = process.getgid?.() ?? 0;
		const started: string[] = [];
		await expect(
			runLxdRunnerBootstrap({
				paths,
				expectedRootUid: uid,
				expectedRootGid: gid,
				serviceIdentity: { uid, gid },
				nativeServiceIdentity: { uid, gid },
				identityRuntimeState: async () => ({ ...fixtureState, epoch: 1 }),
				startService: async (service) => {
					started.push(service);
				},
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(started).toEqual([]);
	});

	it("rejects a missing login key when cloud credential history already exists", async () => {
		const { paths } = await loginFixture();
		const uid = process.getuid?.() ?? 0;
		const gid = process.getgid?.() ?? 0;
		await expect(
			runLxdNativeLoginBootstrap({
				paths,
				expectedRootUid: uid,
				expectedRootGid: gid,
				nativeServiceIdentity: { uid, gid },
				identityRuntimeState: async () => fixtureState,
				startService: async () => {
					throw new Error("Must not start");
				},
			}),
		).rejects.toThrow("master key is missing");
	});

	it("selects private service identities and retains outcome state across restart", async () => {
		const paths = await companyFixture();
		const started: string[] = [];
		await startCompanyFixture(paths, started);
		expect(started).toEqual(["qorpera-native-company-host.service", "qorpera-company-runner.service"]);
		const marker = join(paths.runnerHomeDirectory, ".qorpera-native-company-recovery.json");
		expect(JSON.parse(await readFile(marker, "utf-8"))).toMatchObject({
			schema: "qorpera.native-company-recovery-volume/v1",
			compute_identity_id: computeIdentityId,
			run_id: "90000000-0000-4000-8000-000000000003",
			profile_id: "90000000-0000-4000-8000-000000000004",
		});
		const outcome = join(paths.runnerStateDirectory, "outcome.json");
		await writeFile(outcome, "private retained outcome", { mode: 0o600 });
		await startCompanyFixture(paths, started);
		expect(await readFile(outcome, "utf-8")).toBe("private retained outcome");
		expect((await stat(marker)).mode & 0o777).toBe(0o600);
	});

	it.each(["missing", "same-device", "shared", "nested"])(
		"blocks %s recovery/mount authority before service startup",
		async (kind) => {
			const paths = await companyFixture();
			let mounts = await readFile(paths.mountInfo, "utf-8");
			if (kind === "missing")
				mounts = mounts
					.split("\n")
					.filter((line) => !line.startsWith("43 "))
					.join("\n");
			if (kind === "same-device") mounts = mounts.replace("43 1 0:100", "43 1 0:99");
			if (kind === "shared") mounts += "44 1 0:101 / /foreign-company rw - nfs4 remote rw\n";
			if (kind === "nested") mounts += `44 1 0:101 / ${paths.runnerHomeDirectory}/private rw - tmpfs overlay rw\n`;
			await writeFile(paths.mountInfo, mounts);
			const started: string[] = [];
			await expect(startCompanyFixture(paths, started)).rejects.toThrow(/mount/);
			expect(started).toEqual([]);
		},
	);

	it("rejects a recovery marker from another company and does not erase retained data", async () => {
		const paths = await companyFixture();
		await startCompanyFixture(paths, []);
		const marker = join(paths.runnerHomeDirectory, ".qorpera-native-company-recovery.json");
		const data = JSON.parse(await readFile(marker, "utf-8")) as Record<string, unknown>;
		data.profile_id = "90000000-0000-4000-8000-000000000099";
		await writeFile(marker, JSON.stringify(data), { mode: 0o600 });
		const started: string[] = [];
		await expect(startCompanyFixture(paths, started)).rejects.toThrow("immutable company and run authority");
		expect(started).toEqual([]);
		expect(JSON.parse(await readFile(marker, "utf-8"))).toEqual(data);
	});

	it("rejects an unmarked nonempty recovery volume", async () => {
		const paths = await companyFixture();
		await writeFile(join(paths.runnerHomeDirectory, "unreconciled.json"), "uncertain outcome");
		await expect(startCompanyFixture(paths, [])).rejects.toThrow("operator reconciliation");
	});

	it("rejects mismatched binary pins and shared native credentials", async () => {
		const paths = await companyFixture();
		const bootstrap = JSON.parse(await readFile(paths.bootstrapConfig, "utf-8")) as {
			company_runtime: { binary_sha256: string };
		};
		const original = bootstrap.company_runtime.binary_sha256;
		bootstrap.company_runtime.binary_sha256 = "f".repeat(64);
		await writeFile(paths.bootstrapConfig, JSON.stringify(bootstrap), { mode: 0o600 });
		await writeFile(
			paths.nativeProviderEnvironment,
			(await readFile(paths.nativeProviderEnvironment, "utf-8")).replace(original, "f".repeat(64)),
			{ mode: 0o600 },
		);
		await expect(startCompanyFixture(paths, [])).rejects.toThrow("checksum mismatch");
		const other = await companyFixture();
		await writeFile(join(other.credentialSource, "qorpera-native-object-token"), `${"c".repeat(43)}\n`, {
			mode: 0o600,
		});
		await expect(startCompanyFixture(other, [])).rejects.toThrow("credentials must be independent");
		const sharedSecretBroker = await companyFixture();
		await writeFile(
			join(sharedSecretBroker.credentialSource, "qorpera-cloud-secret-runtime"),
			`${"c".repeat(43)}\n`,
			{
				mode: 0o600,
			},
		);
		await expect(startCompanyFixture(sharedSecretBroker, [])).rejects.toThrow("credentials must be independent");
		const tamperedBrokerCa = await companyFixture();
		await writeFile(join(tamperedBrokerCa.credentialSource, "qorpera-cloud-secret-ca"), "not the pinned CA\n", {
			mode: 0o600,
		});
		await expect(startCompanyFixture(tamperedBrokerCa, [])).rejects.toThrow(
			"does not match immutable bootstrap authority",
		);
	});

	it.each(["valid", "url-drift", "digest-drift", "missing", "shared", "unconfigured", "unknown-field"])(
		"checks native office transport authority before service startup (%s)",
		async (kind) => {
			const paths = await companyFixture();
			const token = (kind === "shared" ? "c" : "o").repeat(43);
			const url = "https://office.example.test/office/90000000-0000-4000-8000-000000000099/native";
			const bootstrap = JSON.parse(await readFile(paths.bootstrapConfig, "utf-8")) as {
				company_runtime: Record<string, unknown>;
			};
			if (kind !== "unconfigured") {
				bootstrap.company_runtime.office = {
					environment_id: "90000000-0000-4000-8000-000000000098",
					url,
					token_sha256:
						kind === "digest-drift" ? "f".repeat(64) : createHash("sha256").update(token).digest("hex"),
					...(kind === "unknown-field" ? { token } : {}),
				};
				await writeFile(
					paths.nativeProviderEnvironment,
					`${await readFile(paths.nativeProviderEnvironment, "utf-8")}QORPERA_COMPANY_COMPUTER_URL=${kind === "url-drift" ? url.replace("0099", "0097") : url}\n`,
				);
			}
			await writeFile(paths.bootstrapConfig, JSON.stringify(bootstrap));
			const credential = join(paths.credentialSource, "qorpera-office-native");
			if (kind === "missing") await rm(credential);
			else await writeFile(credential, `${token}\n`, { mode: 0o600 });
			const started: string[] = [];
			if (kind === "valid") {
				await startCompanyFixture(paths, started);
				expect(started).toEqual(["qorpera-native-company-host.service", "qorpera-company-runner.service"]);
			} else {
				await expect(startCompanyFixture(paths, started)).rejects.toThrow();
				expect(started).toEqual([]);
			}
		},
	);

	it.each(["valid", "url-drift", "digest-drift", "missing", "shared", "unconfigured", "unknown-field", "http"])(
		"checks the coding command gateway authority before service startup (%s)",
		async (kind) => {
			const paths = await companyFixture();
			const token = (kind === "shared" ? "s" : "k").repeat(43);
			const url = "https://coding.example.test:8789";
			const bootstrap = JSON.parse(await readFile(paths.bootstrapConfig, "utf-8")) as {
				company_runtime: Record<string, unknown>;
			};
			if (kind !== "unconfigured") {
				bootstrap.company_runtime.coding_command = {
					url: kind === "http" ? "http://coding.example.test:8789" : url,
					token_sha256:
						kind === "digest-drift" ? "f".repeat(64) : createHash("sha256").update(token).digest("hex"),
					...(kind === "unknown-field" ? { token } : {}),
				};
				await writeFile(
					paths.nativeProviderEnvironment,
					`${await readFile(paths.nativeProviderEnvironment, "utf-8")}QORPERA_CODING_COMMAND_URL=${kind === "url-drift" ? "https://other.example.test:8789" : url}\n`,
				);
			}
			await writeFile(paths.bootstrapConfig, JSON.stringify(bootstrap));
			const credential = join(paths.credentialSource, "qorpera-coding-command");
			if (kind === "missing") await rm(credential);
			else await writeFile(credential, `${token}\n`, { mode: 0o600 });
			const started: string[] = [];
			if (kind === "valid") {
				await startCompanyFixture(paths, started);
				expect(started).toEqual(["qorpera-native-company-host.service", "qorpera-company-runner.service"]);
			} else {
				await expect(startCompanyFixture(paths, started)).rejects.toThrow();
				expect(started).toEqual([]);
			}
		},
	);

	it("refuses a stray coding command credential without gateway authority", async () => {
		const paths = await companyFixture();
		await writeFile(join(paths.credentialSource, "qorpera-coding-command"), `${"k".repeat(43)}\n`, { mode: 0o600 });
		await expect(startCompanyFixture(paths, [])).rejects.toThrow("must be empty");
	});

	it("rejects shared workspace or direct company environment settings in the governed lane", async () => {
		const paths = await companyFixture();
		const config = JSON.parse(await readFile(paths.runnerConfig, "utf-8")) as Record<string, unknown>;
		config.native_bridge_shared_gid = 42041;
		await writeFile(paths.runnerConfig, JSON.stringify(config), { mode: 0o600 });
		await expect(startCompanyFixture(paths, [])).rejects.toThrow("without a shared workspace");
	});
});
