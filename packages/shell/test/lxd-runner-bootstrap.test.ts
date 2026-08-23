import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type LxdRunnerBootstrapPaths,
	parseLxdRunnerBootstrapConfig,
	runLxdRunnerBootstrap,
} from "../src/lxd-runner-bootstrap.ts";

const roots: string[] = [];
const computeIdentityId = "90000000-0000-4000-8000-000000000001";

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
		runnerConfigDestination: join(root, "runner", ".config", "qorpera-runner", "config.json"),
		runnerStateDirectory: join(root, "runner", ".local", "state", "qorpera-runner"),
		runnerTemporaryDirectory: join(root, "runner", "tmp"),
		nativeProviderTemporaryDirectory: join(root, "native", "tmp"),
		mountInfo: join(root, "mountinfo"),
	};
	const currentGid = process.getgid?.() ?? 1;
	const sharedGid = currentGid > 0 ? currentGid : 1;
	await mkdir(paths.credentialSource, { recursive: true, mode: 0o700 });
	await mkdir(paths.identityVolume, { recursive: true, mode: 0o700 });
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

describe("LXD runner guest bootstrap", () => {
	it("strictly binds the guest to one Compute Identity and starts native then runner services", async () => {
		const { root, paths, sharedGid } = await fixture();
		const uid = process.getuid?.() ?? 0;
		const gid = process.getgid?.() ?? 0;
		const started: string[] = [];

		await runLxdRunnerBootstrap({
			paths,
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
		for (const directory of [join(root, "runner", ".local"), join(root, "runner", ".config"), join(root, "native")]) {
			expect((await stat(directory)).mode & 0o777).toBe(0o700);
			expect((await stat(directory)).uid).toBe(uid);
		}
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
