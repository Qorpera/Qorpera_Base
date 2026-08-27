import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPANY_COMPUTER_NATIVE_PROVIDER_SERVICE,
	COMPANY_COMPUTER_RUNNER_SERVICE,
	COMPANY_COMPUTER_SCREENS_SERVICE,
	type CompanyComputerGuestBootstrapPaths,
	companyComputerObjectTransport,
	parseCompanyComputerGuestBootstrap,
	parseCompanyComputerRunnerServiceConfig,
	parseCompanyComputerServiceBaseUrl,
	type RunCompanyComputerGuestBootstrapOptions,
	runCompanyComputerGuestBootstrap,
	safeCompanyComputerGuestError,
} from "../src/cloud-company-computer-guest.ts";
import { screenSessionCommand } from "../src/cloud-company-computer-screens-main.ts";
import { HttpCloudObjectTransport, SupabaseCloudObjectTransport } from "../src/cloud-object-store.ts";

const companyComputerId = "30000000-0000-4000-8000-000000000002";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-company-computer-guest-"));
	temporaryDirectories.push(directory);
	return directory;
}

const computeIdentityId = "30000000-0000-4000-8000-000000000005";
const testGid = process.getgid?.() ?? 100;

function bootstrapFixture(
	datasetPath: string,
	credentialSource: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schema: "qorpera.company-computer-bootstrap/v2",
		company_computer_id: companyComputerId,
		logical_computer_id: "30000000-0000-4000-8000-000000000001",
		profile_id: "30000000-0000-4000-8000-000000000003",
		environment_id: "30000000-0000-4000-8000-000000000004",
		compute_identity_id: computeIdentityId,
		compute_template_key: "qorpera-company-computer-linux",
		compute_template_version: "v1",
		compute_policy_sha256: "e".repeat(64),
		dataset_path: datasetPath,
		nas_shared_gid: testGid,
		dataset_layout: {
			liveDirectory: "live",
			profilesDirectory: "profiles",
			stateDirectory: ".qorpera-computer",
		},
		screens: {
			viewer_host: "0.0.0.0",
			viewer_port: 8446,
			viewer_trusted_source: "10.41.0.1",
			poll_seconds: 30,
		},
		runner_config_path: "/var/lib/qorpera-bootstrap/runner-config.json",
		native_provider_environment_path: "/var/lib/qorpera-bootstrap/native-provider.env",
		credential_source: credentialSource,
		identity_volume_path: "/var/lib/qorpera/identity",
		...overrides,
	};
}

function companyRunnerConfigFixture(
	temporaryRoot: string,
	liveCompanyRoot: string,
	sharedGid: number,
): Record<string, unknown> {
	return {
		schema: "qorpera.company-computer-service/v2",
		base_url: "https://control.example.com",
		publishable_key: "publishable-key",
		runner_id: "30000000-0000-4000-8000-000000000006",
		authority_state_path: "/var/lib/qorpera-runner/.local/state/qorpera-runner/authority.json",
		temporary_root: temporaryRoot,
		image: `ghcr.io/qorpera/runner@sha256:${"b".repeat(64)}`,
		podman_path: "/usr/bin/podman",
		entrypoint: "/usr/local/bin/qorpera-runner",
		capabilities: ["agent_turn"],
		platform: "linux-x64",
		runner_version: "v1",
		native_bridge_url: "http://127.0.0.1:8445/",
		native_bridge_boundary: "virtual_machine",
		native_bridge_shared_gid: sharedGid,
		assignment_host: "0.0.0.0",
		assignment_port: 8444,
		assignment_trusted_source: "10.41.0.1",
		max_assignments: 1,
		environment: {
			QORPERA_LIVE_COMPANY_ROOT: liveCompanyRoot,
			QORPERA_LIVE_COMPANY_PROFILE_ID: "30000000-0000-4000-8000-000000000003",
		},
	};
}

interface BootstrapEnvironment {
	paths: CompanyComputerGuestBootstrapPaths;
	options: RunCompanyComputerGuestBootstrapOptions;
	datasetPath: string;
	credentialSource: string;
	identityVolume: string;
	runnerHome: string;
	runnerConfig: Record<string, unknown>;
	restoreMountInfo: () => Promise<void>;
}

async function bootstrapEnvironment(): Promise<BootstrapEnvironment> {
	const root = await temporaryDirectory();
	const uid = process.getuid?.() ?? 0;
	const gid = process.getgid?.() ?? 0;
	const datasetPath = join(root, "dataset");
	await mkdir(datasetPath);
	await mkdir(join(datasetPath, "live"), { mode: 0o770 });
	await chmod(join(datasetPath, "live"), 0o770);
	const identityVolume = join(root, "identity");
	await mkdir(identityVolume, { mode: 0o700 });
	const runnerHome = join(root, "runner-home");
	await mkdir(runnerHome, { mode: 0o700 });
	const nativeProviderHome = join(root, "native-provider");
	await mkdir(nativeProviderHome, { mode: 0o700 });
	const credentialSource = join(root, "credentials");
	await mkdir(credentialSource, { mode: 0o700 });
	for (const name of [
		"qorpera-native-bridge",
		"qorpera-runner-activation",
		"qorpera-runner-assignment",
		"qorpera-screen-viewer",
	]) {
		await writeFile(join(credentialSource, name), `${"A".repeat(43)}\n`, { mode: 0o600 });
	}
	await writeFile(join(credentialSource, "qorpera-supabase-service-key"), "service-key\n", { mode: 0o600 });
	const paths: CompanyComputerGuestBootstrapPaths = {
		bootstrapConfig: join(root, "company-computer.json"),
		credentialSource,
		runnerConfig: join(root, "runner-config.json"),
		nativeProviderEnvironment: join(root, "native-provider.env"),
		identityVolume,
		identityMarker: join(identityVolume, "qorpera-compute-identity.json"),
		identityMasterKey: join(identityVolume, "qorpera-native-provider-master-key"),
		runnerHomeDirectory: runnerHome,
		runnerConfigDestination: join(runnerHome, ".config", "qorpera-runner", "config.json"),
		nativeProviderTemporaryDirectory: join(nativeProviderHome, "tmp"),
		mountInfo: join(root, "mountinfo"),
	};
	await writeFile(
		paths.bootstrapConfig,
		JSON.stringify(
			bootstrapFixture(datasetPath, credentialSource, {
				runner_config_path: paths.runnerConfig,
				native_provider_environment_path: paths.nativeProviderEnvironment,
				identity_volume_path: identityVolume,
			}),
		),
		{ mode: 0o600 },
	);
	const runnerConfig = {
		...companyRunnerConfigFixture(join(datasetPath, ".qorpera-computer", "runner"), join(datasetPath, "live"), gid),
		authority_state_path: join(runnerHome, ".local", "state", "qorpera-runner", "authority.json"),
	};
	await writeFile(paths.runnerConfig, JSON.stringify(runnerConfig), { mode: 0o600 });
	await writeFile(
		paths.nativeProviderEnvironment,
		[
			"QORPERA_SUPABASE_URL=https://control.example.com",
			"QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY=virtual_machine",
			`QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID=${computeIdentityId}`,
			"QORPERA_NATIVE_PROVIDER_HOST=127.0.0.1",
			"QORPERA_NATIVE_PROVIDER_PORT=8445",
			`QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT=${paths.nativeProviderTemporaryDirectory}`,
			"QORPERA_CODEX_PATH=/usr/local/bin/codex",
			"QORPERA_CLAUDE_PATH=/usr/local/bin/claude",
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	const mountInfoContent = [
		`36 25 0:32 / ${datasetPath} rw,relatime shared:7 - zfs pool/company rw`,
		`37 25 0:33 / ${identityVolume} rw,relatime shared:8 - ext4 /dev/sdb rw`,
		"",
	].join("\n");
	await writeFile(paths.mountInfo, mountInfoContent, "utf-8");
	return {
		paths,
		options: {
			paths,
			expectedRootUid: uid,
			expectedRootGid: gid,
			workIdentity: { uid, gid },
			nativeIdentity: { uid, gid },
			workSupplementaryGids: [gid],
			startService: async () => {},
		},
		datasetPath,
		credentialSource,
		identityVolume,
		runnerHome,
		runnerConfig,
		restoreMountInfo: () => writeFile(paths.mountInfo, mountInfoContent, "utf-8"),
	};
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud company computer guest composition", () => {
	it("parses the provider bootstrap file and tolerates newer provider fields", () => {
		const parsed = parseCompanyComputerGuestBootstrap({
			...bootstrapFixture("/srv/qorpera/dataset", "/var/lib/qorpera-bootstrap/credentials"),
			future_field: true,
		});
		expect(parsed.companyComputerId).toBe(companyComputerId);
		expect(parsed.datasetPath).toBe("/srv/qorpera/dataset");
		expect(parsed.datasetLayout.stateDirectory).toBe(".qorpera-computer");
		expect(parsed.datasetLayout.liveDirectory).toBe("live");
		expect(parsed.screens.viewerPort).toBe(8446);
		expect(parsed.credentialSource).toBe("/var/lib/qorpera-bootstrap/credentials");
		expect(() =>
			parseCompanyComputerGuestBootstrap({
				...bootstrapFixture("/srv/qorpera/dataset", "/var/lib/qorpera-bootstrap/credentials"),
				schema: "qorpera.company-computer-bootstrap/v1",
			}),
		).toThrow("schema is not supported");
		expect(() =>
			parseCompanyComputerGuestBootstrap(
				bootstrapFixture("relative/dataset", "/var/lib/qorpera-bootstrap/credentials"),
			),
		).toThrow("dataset path is invalid");
	});

	it("parses the runner service configuration for the control-plane URL", () => {
		expect(
			parseCompanyComputerServiceBaseUrl({
				schema: "qorpera.company-computer-service/v2",
				base_url: "https://control.example.com",
				publishable_key: "publishable",
			}),
		).toBe("https://control.example.com");
		expect(() =>
			parseCompanyComputerServiceBaseUrl({ schema: "qorpera.runner-service/v1", base_url: "https://x" }),
		).toThrow("schema is not supported");
	});

	it("selects the object backend explicitly and fails closed otherwise", () => {
		expect(
			companyComputerObjectTransport({
				storagePrimary: "supabase",
				supabaseUrl: "https://control.example.com",
				supabaseServiceKey: "service-key",
			}),
		).toBeInstanceOf(SupabaseCloudObjectTransport);
		expect(
			companyComputerObjectTransport({
				storagePrimary: "nas",
				supabaseUrl: "https://control.example.com",
				supabaseServiceKey: "service-key",
				objectGatewayUrl: "https://nas.example.com",
				objectGatewayToken: "gateway-token",
			}),
		).toBeInstanceOf(HttpCloudObjectTransport);
		expect(() =>
			companyComputerObjectTransport({
				storagePrimary: "nas",
				supabaseUrl: "https://control.example.com",
				supabaseServiceKey: "service-key",
			}),
		).toThrow("requires the gateway URL and access token");
		expect(() =>
			companyComputerObjectTransport({
				storagePrimary: "",
				supabaseUrl: "https://control.example.com",
				supabaseServiceKey: "service-key",
			}),
		).toThrow("missing or unsupported");
	});

	it("maps the company runner service configuration onto the ephemeral pipeline", () => {
		const parsed = parseCompanyComputerRunnerServiceConfig({
			...companyRunnerConfigFixture(
				"/srv/qorpera/dataset/.qorpera-computer/runner",
				"/srv/qorpera/dataset/live",
				42_041,
			),
			future_field: true,
		});
		expect(parsed.schema).toBe("qorpera.ephemeral-runner-service/v1");
		expect(parsed.temporaryRoot).toBe("/srv/qorpera/dataset/.qorpera-computer/runner");
		expect(parsed.environment.QORPERA_LIVE_COMPANY_ROOT).toBe("/srv/qorpera/dataset/live");
		expect(parsed.jobTypes).toEqual(["agent_turn"]);
		expect(parsed.maxAssignments).toBe(1);
		expect(parsed.nativeBridgeBoundary).toBe("virtual_machine");
		expect(() =>
			parseCompanyComputerRunnerServiceConfig({
				...companyRunnerConfigFixture(
					"/srv/qorpera/dataset/.qorpera-computer/runner",
					"/srv/qorpera/dataset/live",
					42_041,
				),
				schema: "qorpera.ephemeral-runner-service/v1",
			}),
		).toThrow("schema is not supported");
	});

	it("prepares the dataset, the runner lane, and starts every standing service", async () => {
		const fixture = await bootstrapEnvironment();
		const started: string[] = [];
		await runCompanyComputerGuestBootstrap({
			...fixture.options,
			startService: async (service) => {
				started.push(service);
			},
		});
		expect(started).toEqual([
			COMPANY_COMPUTER_NATIVE_PROVIDER_SERVICE,
			COMPANY_COMPUTER_RUNNER_SERVICE,
			COMPANY_COMPUTER_SCREENS_SERVICE,
		]);
		for (const directory of ["live", "profiles", ".qorpera-computer"]) {
			await expect(mkdir(join(fixture.datasetPath, directory))).rejects.toMatchObject({ code: "EEXIST" });
		}
		expect((await stat(join(fixture.datasetPath, "live"))).mode & 0o7777).toBe(0o770);
		for (const directory of ["desktop-home", "runner", "screens"]) {
			await expect(mkdir(join(fixture.datasetPath, ".qorpera-computer", directory))).rejects.toMatchObject({
				code: "EEXIST",
			});
		}
		const installed = JSON.parse(
			await readFile(join(fixture.runnerHome, ".config", "qorpera-runner", "config.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(installed.schema).toBe("qorpera.company-computer-service/v2");
		const marker = JSON.parse(
			await readFile(join(fixture.identityVolume, "qorpera-compute-identity.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(marker).toEqual({ schema: "qorpera.compute-identity-volume/v1", compute_identity_id: computeIdentityId });
		await expect(
			readFile(join(fixture.identityVolume, "qorpera-native-provider-master-key"), "utf-8"),
		).resolves.toMatch(/^[A-Za-z0-9_-]{43}\n$/);

		const restarted: string[] = [];
		await runCompanyComputerGuestBootstrap({
			...fixture.options,
			startService: async (service) => {
				restarted.push(service);
			},
		});
		expect(restarted).toHaveLength(3);
	});

	it("fails closed when the dataset is unmounted, credentials drift, or the runner boundary weakens", async () => {
		const fixture = await bootstrapEnvironment();
		await writeFile(
			fixture.paths.mountInfo,
			`36 25 0:32 / ${fixture.identityVolume} rw shared:7 - ext4 /dev/sdb rw\n`,
			"utf-8",
		);
		await expect(runCompanyComputerGuestBootstrap(fixture.options)).rejects.toThrow(
			"Company computer dataset is not a mounted filesystem",
		);
		await fixture.restoreMountInfo();

		await writeFile(join(fixture.credentialSource, "unexpected-secret"), "nope\n", { mode: 0o600 });
		await expect(runCompanyComputerGuestBootstrap(fixture.options)).rejects.toThrow("unexpected entries");
		await rm(join(fixture.credentialSource, "unexpected-secret"));

		await writeFile(fixture.paths.runnerConfig, JSON.stringify({ ...fixture.runnerConfig, max_assignments: 2 }), {
			mode: 0o600,
		});
		await expect(runCompanyComputerGuestBootstrap(fixture.options)).rejects.toThrow("private assignment boundary");

		await writeFile(
			fixture.paths.runnerConfig,
			JSON.stringify({ ...fixture.runnerConfig, temporary_root: join(fixture.datasetPath, "elsewhere") }),
			{ mode: 0o600 },
		);
		await expect(runCompanyComputerGuestBootstrap(fixture.options)).rejects.toThrow(
			"does not use the declared live Company File",
		);
	});

	it("keeps the screen session command overridable and redacts tokens from errors", () => {
		expect(screenSessionCommand({})).toEqual([
			"/usr/local/bin/qorpera-screen-session",
			"{ordinal}",
			"{display}",
			"{vnc_port}",
		]);
		expect(screenSessionCommand({ QORPERA_SCREEN_SESSION_COMMAND: '["/opt/custom-session", "{display}"]' })).toEqual([
			"/opt/custom-session",
			"{display}",
		]);
		expect(() => screenSessionCommand({ QORPERA_SCREEN_SESSION_COMMAND: "not json" })).toThrow("invalid JSON");
		expect(() => screenSessionCommand({ QORPERA_SCREEN_SESSION_COMMAND: "[1]" })).toThrow(
			"command override is invalid",
		);
		expect(safeCompanyComputerGuestError(new Error(`attach failed for ${"A".repeat(43)} token`))).toBe(
			"attach failed for [redacted] token",
		);
	});
});
