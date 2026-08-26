import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeCompanyComputerGuestError } from "../src/cloud-company-computer-bootstrap-main.ts";
import {
	COMPANY_COMPUTER_SCREENS_SERVICE,
	COMPANY_COMPUTER_SYNC_SERVICE,
	companyComputerObjectTransport,
	parseCompanyComputerGuestBootstrap,
	parseCompanyComputerServiceBaseUrl,
	runCompanyComputerGuestBootstrap,
	SupabaseCompanyComputerSyncHeadResolver,
} from "../src/cloud-company-computer-guest.ts";
import { screenSessionCommand } from "../src/cloud-company-computer-screens-main.ts";
import { HttpCloudObjectTransport, SupabaseCloudObjectTransport } from "../src/cloud-object-store.ts";

const companyComputerId = "30000000-0000-4000-8000-000000000002";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-company-computer-guest-"));
	temporaryDirectories.push(directory);
	return directory;
}

function bootstrapFixture(datasetPath: string, credentialSource: string): Record<string, unknown> {
	return {
		schema: "qorpera.company-computer-bootstrap/v1",
		company_computer_id: companyComputerId,
		logical_computer_id: "30000000-0000-4000-8000-000000000001",
		profile_id: "30000000-0000-4000-8000-000000000003",
		environment_id: "30000000-0000-4000-8000-000000000004",
		compute_identity_id: "30000000-0000-4000-8000-000000000005",
		compute_template_key: "qorpera-company-computer-linux",
		compute_template_version: "v1",
		compute_policy_sha256: "e".repeat(64),
		dataset_path: datasetPath,
		dataset_layout: {
			companyDirectory: "company",
			workbenchDirectory: "workbench",
			profilesDirectory: "profiles",
			stateDirectory: ".qorpera-computer",
		},
		sync: {
			company_root: `${datasetPath}/company`,
			state_path: `${datasetPath}/.qorpera-computer/company-sync.json`,
			poll_seconds: 30,
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
	};
}

function publishedHeadJson(): Record<string, unknown> {
	return {
		snapshot_id: snapshotId,
		profile_id: "30000000-0000-4000-8000-000000000003",
		environment_id: "30000000-0000-4000-8000-000000000004",
		workspace_id: "22222222-2222-4222-8222-222222222222",
		client_snapshot_id: "66666666-6666-4666-8666-666666666666",
		parent_snapshot_id: null,
		tree_manifest_sha256: "a".repeat(64),
		tree_manifest_bytes: 512,
		tree_contract_version: 3,
		file_count: 12,
		total_bytes: 4_096,
		created_by_user_id: "c98d600e-654a-40da-a07f-f1d54f93cc6c",
		created_at: "2026-08-26T12:00:00.000Z",
		publication_state: "published",
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
		expect(parsed.sync.companyRoot).toBe("/srv/qorpera/dataset/company");
		expect(parsed.screens.viewerPort).toBe(8446);
		expect(parsed.credentialSource).toBe("/var/lib/qorpera-bootstrap/credentials");
		expect(() =>
			parseCompanyComputerGuestBootstrap({
				...bootstrapFixture("/srv/qorpera/dataset", "/var/lib/qorpera-bootstrap/credentials"),
				schema: "qorpera.company-computer-bootstrap/v2",
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
				schema: "qorpera.company-computer-service/v1",
				base_url: "https://control.example.com",
				publishable_key: "publishable",
			}),
		).toBe("https://control.example.com");
		expect(() =>
			parseCompanyComputerServiceBaseUrl({ schema: "qorpera.runner-service/v1", base_url: "https://x" }),
		).toThrow("schema is not supported");
	});

	it("resolves only a published head through the computer-scoped service RPC", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		let response: unknown = null;
		const resolver = new SupabaseCompanyComputerSyncHeadResolver(
			"https://control.example.com",
			"service-key",
			companyComputerId,
			(async (url: unknown, init?: { body?: unknown }) => {
				calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
				return new Response(JSON.stringify(response), { status: 200 });
			}) as typeof fetch,
		);
		await expect(resolver.resolveVerifiedHead()).resolves.toBeUndefined();
		expect(calls).toEqual([
			{
				url: "https://control.example.com/rest/v1/rpc/qorpera_company_computer_sync_head",
				body: { p_company_computer_id: companyComputerId },
			},
		]);

		response = publishedHeadJson();
		await expect(resolver.resolveVerifiedHead()).resolves.toEqual({
			snapshotId,
			tree: {
				manifestSha256: "a".repeat(64),
				manifestBytes: 512,
				contractVersion: 3,
				fileCount: 12,
				totalBytes: 4_096,
			},
		});

		response = { ...publishedHeadJson(), publication_state: "prepared" };
		await expect(resolver.resolveVerifiedHead()).rejects.toThrow("not a published snapshot");

		const failing = new SupabaseCompanyComputerSyncHeadResolver(
			"https://control.example.com",
			"service-key",
			companyComputerId,
			(async () => new Response("nope", { status: 500 })) as typeof fetch,
		);
		await expect(failing.resolveVerifiedHead()).rejects.toThrow("failed (500)");
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

	it("prepares the dataset working world and starts both agents", async () => {
		const root = await temporaryDirectory();
		const datasetPath = join(root, "dataset");
		await mkdir(datasetPath);
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
		const bootstrapConfig = join(root, "company-computer.json");
		await writeFile(bootstrapConfig, JSON.stringify(bootstrapFixture(datasetPath, credentialSource)), {
			mode: 0o600,
		});
		const mountInfo = join(root, "mountinfo");
		await writeFile(mountInfo, `36 25 0:32 / ${datasetPath} rw,relatime shared:7 - zfs pool/company rw\n`, "utf-8");
		const started: string[] = [];
		const uid = process.getuid?.() ?? 0;
		const gid = process.getgid?.() ?? 0;
		await runCompanyComputerGuestBootstrap({
			paths: { bootstrapConfig, credentialSource, mountInfo },
			expectedRootUid: uid,
			workIdentity: { uid, gid },
			startService: async (service) => {
				started.push(service);
			},
		});
		expect(started).toEqual([COMPANY_COMPUTER_SYNC_SERVICE, COMPANY_COMPUTER_SCREENS_SERVICE]);
		for (const directory of ["workbench", "profiles", ".qorpera-computer"]) {
			await expect(mkdir(join(datasetPath, directory))).rejects.toMatchObject({ code: "EEXIST" });
		}
	});

	it("fails closed when the dataset is not mounted or credentials drift", async () => {
		const root = await temporaryDirectory();
		const datasetPath = join(root, "dataset");
		await mkdir(datasetPath);
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
		const bootstrapConfig = join(root, "company-computer.json");
		await writeFile(bootstrapConfig, JSON.stringify(bootstrapFixture(datasetPath, credentialSource)), {
			mode: 0o600,
		});
		const mountInfo = join(root, "mountinfo");
		await writeFile(mountInfo, "36 25 0:32 / /somewhere/else rw,relatime shared:7 - zfs pool rw\n", "utf-8");
		const uid = process.getuid?.() ?? 0;
		const gid = process.getgid?.() ?? 0;
		const options = {
			paths: { bootstrapConfig, credentialSource, mountInfo },
			expectedRootUid: uid,
			workIdentity: { uid, gid },
			startService: async () => {},
		};
		await expect(runCompanyComputerGuestBootstrap(options)).rejects.toThrow("not a mounted filesystem");

		await writeFile(mountInfo, `36 25 0:32 / ${datasetPath} rw shared:7 - zfs pool rw\n`, "utf-8");
		await writeFile(join(credentialSource, "unexpected-secret"), "nope\n", { mode: 0o600 });
		await expect(runCompanyComputerGuestBootstrap(options)).rejects.toThrow("unexpected entries");
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
