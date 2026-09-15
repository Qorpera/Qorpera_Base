import { createHash, sign } from "node:crypto";
import { chmod, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type LxdInstanceFile,
	type LxdOfficeSoftwareClient,
	OFFICE_SOFTWARE_INSTALLED_SERVICE,
	OFFICE_SOFTWARE_JOURNAL_ROOT,
	OFFICE_SOFTWARE_STAGING_ROOT,
	officeSoftwareStagedPath,
} from "../src/lxd-client.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import { lxdOfficePhysicalPolicySha256 } from "../src/lxd-office-physical-policy.ts";
import type { LxdOfficeSoftwareRegistry } from "../src/lxd-office-software-control.ts";
import {
	type LxdOfficeSoftwareUpdatePorts,
	parseLxdOfficeSoftwareUpdateConfig,
	runLxdOfficeSoftwareUpdate,
} from "../src/lxd-office-software-update.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";
import { officeServiceRestartFixture } from "./fixtures/office-service-restart.ts";
import { officeGuestCodeFixtureFiles, officeSoftwareFixture } from "./fixtures/office-software.ts";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const signal = () => new AbortController().signal;
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const CONFIG_PATH = "/etc/qorpera/office-provider/software-update.json";
const CAPABILITY = "1234567890abcdef".repeat(4);
const REGISTRY_KEY = "registry-service-key-0123456789abcdef";

function config(journalRoot: string, override: Record<string, unknown> = {}) {
	return {
		schema: "qorpera.lxd-office-software-update/v1",
		policyPath: "/etc/qorpera/office-provider/policy.json",
		provenancePath: "/etc/qorpera/office-provider/provenance.json",
		registryUrl: "https://control.example",
		registryCredential: {
			path: "/etc/qorpera/office-provider/registry.credential",
			bytes: REGISTRY_KEY.length,
			sha256: sha(REGISTRY_KEY),
		},
		capabilityCredential: {
			path: "/etc/qorpera/office-provider/software.capability",
			bytes: 64,
			sha256: sha(CAPABILITY),
		},
		expectedRevision: 0,
		tools: { install: sha("install tool"), measure: sha("measure tool") },
		toolPackageDir: "/etc/qorpera/office-provider/software-control",
		envelopePath: "/etc/qorpera/office-provider/revision-1/envelope.json",
		planPath: "/etc/qorpera/office-provider/revision-1/plan.json",
		trustPath: "/etc/qorpera/office-provider/revision-1/trust.json",
		previousManifestPath: "/etc/qorpera/office-provider/revision-1/previous-manifest.json",
		nextManifestPath: "/etc/qorpera/office-provider/revision-1/next-manifest.json",
		servicePath: "/etc/qorpera/office-provider/revision-1/qorpera-company-computer-service.mjs",
		journalRoot,
		...override,
	};
}

/** One complete, internally consistent update: policy, retained stop records
 * in a real 0700 journal, signed statement/plan/trust, exact bytes, tool
 * package, in-memory protected files, SQL and LXD fakes. */
async function fixture(options: { guestCode?: boolean } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-software-update-")));
	await chmod(root, 0o700);
	roots.push(root);
	const physical = officePhysicalFixture();
	const restart = officeServiceRestartFixture();
	const original = restart.request.stop.revocation.request;
	const policy = {
		...physical.policy,
		guest: {
			...physical.policy.guest,
			providerId: original.providerId,
			companyId: original.startup.scope.companyId,
			environmentId: original.startup.scope.environmentId,
			companyComputerId: original.startup.scope.companyComputerId,
			logicalComputerId: original.startup.scope.logicalComputerId,
			computerGeneration: original.startup.computerGeneration,
			imageFingerprint: original.startup.imageSha256,
			bootstrapSha256: original.startup.bootstrapSha256,
		},
		journal: { ...physical.policy.journal, mountPoint: root, path: root },
	};
	const predecessor = { ...original, providerPolicySha256: lxdOfficePhysicalPolicySha256(policy) };
	const stop = { ...restart.request.stop, revocation: { ...restart.request.stop.revocation, request: predecessor } };
	const acknowledgement = { ...restart.request.acknowledgement, request: predecessor };
	const stopCommand = acknowledgement.inspection.stop.command;
	const software = officeSoftwareFixture();
	const serviceBytes = Buffer.alloc(234, 7);
	const manifestNext = structuredClone(software.next);
	manifestNext.artifacts[0] = { ...manifestNext.artifacts[0], bytes: serviceBytes.length, sha256: sha(serviceBytes) };
	const guestCode = options.guestCode ? officeGuestCodeFixtureFiles(software.previous, manifestNext) : undefined;
	const manifests = { previous: software.manifests.previous, next: Buffer.from(JSON.stringify(manifestNext)) };
	const statement = {
		...software.statement,
		base: {
			...software.statement.base,
			imageSha256: predecessor.startup.imageSha256,
			bootstrapSha256: predecessor.startup.bootstrapSha256,
		},
		...(guestCode ? { previous: { ...software.statement.previous, files: guestCode.previousFiles } } : {}),
		next: {
			packageManifestSha256: sha(manifests.next),
			service: { ...software.statement.next.service, bytes: serviceBytes.length, sha256: sha(serviceBytes) },
			...(guestCode ? { files: guestCode.nextFiles } : {}),
		},
		...(guestCode ? { acceptance: { ...software.statement.acceptance, change: "guest-code" } } : {}),
	};
	const envelope = {
		schema: "qorpera.office-service-software-envelope/v1",
		statement,
		signature: {
			algorithm: "ed25519",
			value: sign(null, Buffer.from(officeCanonical(statement)), software.keys.privateKey).toString("base64"),
		},
	};
	const plan = {
		...software.plan,
		predecessor,
		stopAcknowledgementSha256: officeDigest(acknowledgement),
		statementSha256: officeDigest(statement),
	};
	const trust = { ...software.trust, statementSha256: officeDigest(statement), planSha256: officeDigest(plan) };
	const receipt = {
		schema: "qorpera.office-service-software-receipt/v1",
		plan,
		planSha256: trust.planSha256,
		state: "installed",
		service: { ...statement.next.service },
		...(guestCode ? { files: structuredClone(guestCode.nextFiles) } : {}),
		installedAt: "2026-09-12T01:00:00.000Z",
	};
	const tools = { install: Buffer.from("install tool"), measure: Buffer.from("measure tool") };
	const toolManifest = {
		schema: "qorpera.office-software-control-package/v2",
		platform: "linux",
		minimumNode: "22.19.0",
		artifacts: [
			{
				purpose: "install",
				file: "software-control.mjs",
				path: "/run/qorpera-office-preparation/software-control.mjs",
				bytes: tools.install.length,
				sha256: sha(tools.install),
				mode: 256,
			},
			{
				purpose: "measure",
				file: "software-measurement-control.mjs",
				path: "/run/qorpera-office-preparation/software-measurement-control.mjs",
				bytes: tools.measure.length,
				sha256: sha(tools.measure),
				mode: 256,
			},
		],
		purpose: "temporary-provider-root-control",
		historicalOfficeImageUnchanged: true,
	};
	const suffix = `${predecessor.startup.allocationId}-${predecessor.transitionId}`;
	const retain = (name: string, value: unknown) =>
		writeFile(join(root, name), officeCanonical(value), { mode: 0o600 });
	await retain(`service-stop-request-${suffix}.json`, {
		schema: "qorpera.lxd-office-stop-request/v1",
		request: stop,
		command: stopCommand,
	});
	await retain(`service-stop-completed-${suffix}.json`, {
		schema: "qorpera.lxd-office-stop-completion/v1",
		intentId: "00000000-0000-4000-8000-0000000000aa",
		allocationId: predecessor.startup.allocationId,
		transitionId: predecessor.transitionId,
		commandId: stopCommand.commandId,
		receipt: acknowledgement,
	});
	const filesDir = "/etc/qorpera/office-provider/revision-1";
	const c = config(root, guestCode ? { filesDir } : {});
	const files = new Map<string, Buffer>([
		...Object.entries(guestCode?.bytes ?? {}).map(
			([file, bytes]) => [join(filesDir, file), bytes] as [string, Buffer],
		),
		[CONFIG_PATH, Buffer.from(JSON.stringify(c))],
		[c.envelopePath, Buffer.from(JSON.stringify(envelope))],
		[c.planPath, Buffer.from(JSON.stringify(plan))],
		[c.trustPath, Buffer.from(JSON.stringify(trust))],
		[c.previousManifestPath, manifests.previous],
		[c.nextManifestPath, manifests.next],
		[c.servicePath, serviceBytes],
		[join(c.toolPackageDir, "manifest.json"), Buffer.from(JSON.stringify(toolManifest))],
		[join(c.toolPackageDir, "software-control.mjs"), tools.install],
		[join(c.toolPackageDir, "software-measurement-control.mjs"), tools.measure],
	]);
	const credentials = new Map<string, Buffer>([
		[c.registryCredential.path, Buffer.from(REGISTRY_KEY)],
		[c.capabilityCredential.path, Buffer.from(CAPABILITY)],
	]);
	const read = (store: Map<string, Buffer>) =>
		vi.fn(async (path: string, limit: number) => {
			const bytes = store.get(path);
			if (!bytes || bytes.length > limit) throw new Error("OFFICE_HOST_FILE_UNPROTECTED");
			return Buffer.from(bytes);
		});
	const binding = {
		schema: "qorpera.lxd-office-guest/v2" as const,
		...policy.guest,
		allocationId: predecessor.startup.allocationId,
		providerPolicySha256: predecessor.providerPolicySha256,
	};
	const name = lxdOfficeGuestPlan(binding).request.name;
	const calls: string[] = [];
	let installed = false,
		challengeId: string | null = null;
	const evidenceSha256 = "e".repeat(64);
	const registry: LxdOfficeSoftwareRegistry = {
		async call(method, args) {
			calls.push(method);
			expect(args.p_provider_capability).toBe(CAPABILITY);
			if (method === "qorpera_enroll_office_software")
				return {
					schema: "qorpera.office-software-baseline/v1",
					allocationId: predecessor.startup.allocationId,
					base: statement.base,
					revision: 0,
				};
			if (method === "qorpera_begin_office_software") {
				expect(officeDigest(JSON.parse(args.p_stop_text as string))).toBe(plan.stopAcknowledgementSha256);
				return { updateId: plan.updateId, state: "begun", targetRevision: 1 };
			}
			if (method === "qorpera_check_office_software_install") {
				challengeId = args.p_challenge_id as string;
				return {
					schema: "qorpera.office-software-install-challenge/v1",
					challengeId,
					plan,
					planSha256: trust.planSha256,
					statement,
					targetRevision: 1,
					capabilityRevision: 1,
					validForMs: 5000,
				};
			}
			if (method === "qorpera_ack_office_software_install") {
				installed = true;
				return {
					schema: "qorpera.office-software-installation/v1",
					updateId: plan.updateId,
					state: "installed",
					targetRevision: 1,
				};
			}
			return {
				schema: "qorpera.office-software-status/v1",
				plan,
				statement,
				base: statement.base,
				state: installed ? "installed" : "begun",
				currentRevision: installed ? 1 : 0,
				targetRevision: 1,
				receipt: installed ? receipt : null,
				installationChallengeId: installed ? challengeId : null,
				installationEvidenceSha256: installed ? evidenceSha256 : null,
			};
		},
	};
	const guest = new Map<string, LxdInstanceFile>();
	const client = {
		pushOfficeSoftwareFile: vi.fn<LxdOfficeSoftwareClient["pushOfficeSoftwareFile"]>(
			async (project, instance, fileName, content) => {
				expect([project, instance]).toEqual([binding.project, name]);
				guest.set(officeSoftwareStagedPath(fileName).path, {
					content: Buffer.from(content),
					uid: 0,
					gid: 0,
					mode: 0o400,
				});
			},
		),
		submitOfficeSoftwareControl: vi.fn<LxdOfficeSoftwareClient["submitOfficeSoftwareControl"]>(
			async (project, instance, tool, args) => {
				expect([project, instance, tool]).toEqual([binding.project, name, "install"]);
				expect(guest.get(`${OFFICE_SOFTWARE_STAGING_ROOT}/software-control.mjs`)?.content).toEqual(tools.install);
				expect(args[3]).toBe(sha(tools.install));
				guest.set(`${OFFICE_SOFTWARE_JOURNAL_ROOT}/${plan.updateId}/installed.json`, {
					content: Buffer.from(JSON.stringify(receipt)),
					uid: 0,
					gid: 0,
					mode: 0o400,
				});
				guest.set(OFFICE_SOFTWARE_INSTALLED_SERVICE, { content: serviceBytes, uid: 0, gid: 0, mode: 0o444 });
				for (const entry of guestCode?.nextFiles ?? [])
					guest.set(entry.path, { content: guestCode!.bytes[entry.file]!, uid: 0, gid: 0, mode: entry.mode });
				return { project, instanceName: instance, operationId: "00000000-0000-4000-8000-00000000abcd" };
			},
		),
		inspectOfficeSoftwareControl: vi.fn<LxdOfficeSoftwareClient["inspectOfficeSoftwareControl"]>(
			async () => "succeeded",
		),
		readOfficeSoftwareFile: vi.fn<LxdOfficeSoftwareClient["readOfficeSoftwareFile"]>(
			async (_project, _instance, path, maximumBytes) => {
				const file = guest.get(path);
				if (!file || file.content.length > maximumBytes)
					throw new Error("LXD_OFFICE_SOFTWARE_READBACK_UNCONFIRMED");
				return { ...file, content: Buffer.from(file.content) };
			},
		),
	};
	const gate = {
		policy,
		check: vi.fn(async () => ({ signal: signal(), validForMs: 5000, hostBootId: "b".repeat(36) })),
	};
	const ports = {
		readProtected: read(files),
		readCredential: read(credentials),
		readArtifact: read(files),
		kernelLock: vi.fn(async (journalRoot: string) => {
			expect(journalRoot).toBe(root);
		}),
		openGate: vi.fn(async () => gate),
		registry: vi.fn((url: string, key: string) => {
			expect([url, key]).toEqual(["https://control.example", REGISTRY_KEY]);
			return registry;
		}),
		client: vi.fn((socketPath: string) => {
			expect(socketPath).toBe(policy.host.socketPath);
			return client;
		}),
	} satisfies Required<LxdOfficeSoftwareUpdatePorts>;
	const run = (step: Parameters<typeof runLxdOfficeSoftwareUpdate>[1], evidence?: string) =>
		runLxdOfficeSoftwareUpdate(CONFIG_PATH, step, evidence, signal(), ports);
	return {
		root,
		config: c,
		files,
		credentials,
		policy,
		predecessor,
		plan,
		statement,
		receipt,
		serviceBytes,
		tools,
		binding,
		calls,
		guest,
		gate,
		client,
		ports,
		run,
		suffix,
		retain,
		evidenceSha256,
		guestCode,
		filesDir,
	};
}
const secretFree = (value: unknown) => {
	const text = JSON.stringify(value);
	expect(text).not.toContain(CAPABILITY);
	expect(text).not.toContain(REGISTRY_KEY);
	return JSON.parse(text);
};

describe("software update configuration", () => {
	it("parses one closed protected document and refuses anything else", () => {
		const parsed = parseLxdOfficeSoftwareUpdateConfig(config("/mnt/office-journal/state"));
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(parsed.journalRoot).toBe("/mnt/office-journal/state");
		expect(parsed.capabilityCredential.bytes).toBe(64);
		expect(parsed.tools).toEqual({ install: sha("install tool"), measure: sha("measure tool") });
		for (const broken of [
			{ schema: "qorpera.lxd-office-software-update/v2" },
			{ registryUrl: "http://control.example" },
			{ registryUrl: "https://control.example/rest" },
			{ journalRoot: "relative/journal" },
			{ servicePath: "/etc/qorpera/../service.mjs" },
			{ expectedRevision: -1 },
			{ expectedRevision: 1.5 },
			{ capabilityCredential: { path: "/etc/qorpera/c", bytes: 63, sha256: "a".repeat(64) } },
			{ registryCredential: { path: "/etc/qorpera/r", bytes: 16, sha256: "a".repeat(64) } },
			{ tools: { install: "a".repeat(64) } },
			{ tools: { install: "A".repeat(64), measure: "b".repeat(64) } },
			{ extra: true },
			{ filesDir: "relative/revision" },
			{ filesDir: "/etc/qorpera/office-provider/../revision" },
			{ filesDir: 7 },
		])
			expect(() => parseLxdOfficeSoftwareUpdateConfig({ ...config("/mnt/j"), ...broken })).toThrow(
				"OFFICE_SOFTWARE_UPDATE_CONFIG_INVALID",
			);
		// The guest code directory is the one optional key.
		const withFiles = parseLxdOfficeSoftwareUpdateConfig(
			config("/mnt/j", { filesDir: "/etc/qorpera/office-provider/revision-2" }),
		);
		expect(withFiles.filesDir).toBe("/etc/qorpera/office-provider/revision-2");
		expect("filesDir" in parsed).toBe(false);
		const missing = config("/mnt/j") as Record<string, unknown>;
		delete missing.journalRoot;
		expect(() => parseLxdOfficeSoftwareUpdateConfig(missing)).toThrow("OFFICE_SOFTWARE_UPDATE_CONFIG_INVALID");
	});
});

describe("software update steps", () => {
	it("stages and installs a guest-code revision from the revision directory and refuses one without it", async () => {
		const f = await fixture({ guestCode: true });
		await f.run("enroll", f.evidenceSha256);
		await f.run("begin");
		const staged = secretFree(await f.run("stage"));
		const stagedNames = [...f.guest.keys()].map((path) => path.slice(OFFICE_SOFTWARE_STAGING_ROOT.length + 1)).sort();
		expect(stagedNames).toEqual(
			[
				"software-control.mjs",
				"software-measurement-control.mjs",
				`software-capability-${f.plan.updateId}`,
				`software-next-manifest-${staged.result.planSha256}.json`,
				`software-previous-manifest-${staged.result.planSha256}.json`,
				`software-service-${f.statement.next.service.sha256}.mjs`,
				`software-trust-${staged.result.trustSha256}.json`,
				...f.guestCode!.nextFiles.map((entry) => `software-file-${entry.sha256}`),
			].sort(),
		);
		const installed = secretFree(await f.run("install"));
		expect(installed.result).toMatchObject({ receipt: f.receipt, targetRevision: 1 });
		expect(installed.result.measuredFiles).toEqual(f.guestCode!.nextFiles);
		for (const entry of f.guestCode!.nextFiles)
			expect(f.ports.readArtifact).toHaveBeenCalledWith(join(f.filesDir, entry.file), entry.bytes);
		// A missing directory, a missing entry and altered entry bytes all refuse before any credential is read.
		const first = f.guestCode!.nextFiles[0]!;
		for (const change of [
			(g: Awaited<ReturnType<typeof fixture>>) =>
				g.files.set(CONFIG_PATH, Buffer.from(JSON.stringify(config(g.root)))),
			(g: Awaited<ReturnType<typeof fixture>>) => g.files.delete(join(g.filesDir, first.file)),
			(g: Awaited<ReturnType<typeof fixture>>) => g.files.set(join(g.filesDir, first.file), Buffer.from("altered")),
		]) {
			const g = await fixture({ guestCode: true });
			change(g);
			await expect(g.run("status")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_INPUTS_UNCONFIRMED");
			expect(g.ports.readCredential).not.toHaveBeenCalled();
		}
	});
	it("composes enroll, begin, stage, install and status one invocation at a time without secrets", async () => {
		const f = await fixture();
		const enrolled = secretFree(await f.run("enroll", f.evidenceSha256));
		expect(enrolled).toMatchObject({
			schema: "qorpera.lxd-office-software-update-result/v1",
			step: "enroll",
			updateId: f.plan.updateId,
			allocationId: f.predecessor.startup.allocationId,
			expectedRevision: 0,
			targetRevision: 1,
			result: { schema: "qorpera.office-software-baseline/v1", revision: 0 },
		});
		expect(f.calls).toEqual(["qorpera_enroll_office_software"]);
		expect(f.gate.check).not.toHaveBeenCalled();
		expect(f.ports.client).not.toHaveBeenCalled();
		const begun = secretFree(await f.run("begin"));
		expect(begun.result).toEqual({ updateId: f.plan.updateId, state: "begun", targetRevision: 1 });
		expect(secretFree(await f.run("status")).result).toMatchObject({ state: "begun", currentRevision: 0 });
		expect(f.gate.check).not.toHaveBeenCalled();
		const staged = secretFree(await f.run("stage"));
		expect(f.gate.check).toHaveBeenCalledTimes(1);
		expect(staged.result).toMatchObject({
			tools: { install: sha(f.tools.install), measure: sha(f.tools.measure) },
			planSha256: officeDigest(f.plan),
		});
		const stagedNames = [...f.guest.keys()].map((path) => path.slice(OFFICE_SOFTWARE_STAGING_ROOT.length + 1)).sort();
		expect(stagedNames).toEqual(
			[
				"software-control.mjs",
				"software-measurement-control.mjs",
				`software-capability-${f.plan.updateId}`,
				`software-next-manifest-${staged.result.planSha256}.json`,
				`software-previous-manifest-${staged.result.planSha256}.json`,
				`software-service-${f.statement.next.service.sha256}.mjs`,
				`software-trust-${staged.result.trustSha256}.json`,
			].sort(),
		);
		expect(f.calls.slice(-1)).toEqual(["qorpera_office_software_status"]);
		const installed = secretFree(await f.run("install"));
		expect(f.gate.check).toHaveBeenCalledTimes(2);
		expect(installed.result).toMatchObject({ receipt: f.receipt, targetRevision: 1 });
		expect(installed.result.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(f.calls.slice(-2)).toEqual([
			"qorpera_check_office_software_install",
			"qorpera_ack_office_software_install",
		]);
		const records = (await readdir(f.root)).filter((name) => name.startsWith("software-install-")).sort();
		expect(records).toEqual(
			[
				`software-install-${f.binding.allocationId}-${f.plan.updateId}-${installed.result.challengeId}.json`,
				`software-install-${f.binding.allocationId}-${f.plan.updateId}-${installed.result.challengeId}-accepted.json`,
				`software-install-${f.binding.allocationId}-${f.plan.updateId}-${installed.result.challengeId}-evidence.json`,
			].sort(),
		);
		expect(f.client.submitOfficeSoftwareControl).toHaveBeenCalledTimes(1);
		expect(secretFree(await f.run("status")).result).toMatchObject({
			state: "installed",
			currentRevision: 1,
			receipt: f.receipt,
			challengeId: installed.result.challengeId,
		});
		expect(f.ports.kernelLock).toHaveBeenCalledTimes(6);
		expect(f.ports.openGate).toHaveBeenCalledTimes(6);
	});
	it("refuses without the lifecycle's process-owned kernel lock before any credential, SQL or LXD access", async () => {
		const f = await fixture();
		f.ports.kernelLock.mockRejectedValueOnce(new Error("OFFICE_ADOPTION_KERNEL_LOCK_REQUIRED"));
		await expect(f.run("begin")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_LOCK_REQUIRED");
		expect(f.ports.readCredential).not.toHaveBeenCalled();
		expect(f.ports.registry).not.toHaveBeenCalled();
		expect(f.calls).toEqual([]);
		expect(f.gate.check).not.toHaveBeenCalled();
	});
	it("refuses malformed invocations, foreign journal roots and unreadable configuration", async () => {
		const f = await fixture();
		await expect(f.run("enroll")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_ARGUMENTS_INVALID");
		await expect(f.run("begin", f.evidenceSha256)).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_ARGUMENTS_INVALID");
		await expect(f.run("enroll", "not-a-digest")).rejects.toThrow("INVALID_OFFICE_SHA256");
		expect(f.ports.readProtected).toHaveBeenCalledTimes(1);
		f.files.set(CONFIG_PATH, Buffer.from(JSON.stringify(config("/mnt/other-journal"))));
		await expect(f.run("status")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_CONFIG_INVALID");
		f.files.delete(CONFIG_PATH);
		await expect(f.run("status")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_CONFIG_INVALID");
		expect(f.ports.kernelLock).not.toHaveBeenCalled();
		expect(f.calls).toEqual([]);
	});
	it("refuses changed service bytes, tool pins or stop records before loading any credential", async () => {
		const f = await fixture();
		const service = f.files.get(f.config.servicePath)!;
		f.files.set(f.config.servicePath, Buffer.concat([service, Buffer.from([0])]));
		await expect(f.run("begin")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_INPUTS_UNCONFIRMED");
		f.files.set(f.config.servicePath, service);
		const tool = f.files.get(join(f.config.toolPackageDir, "software-control.mjs"))!;
		f.files.set(join(f.config.toolPackageDir, "software-control.mjs"), Buffer.from("other tool"));
		await expect(f.run("begin")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_INPUTS_UNCONFIRMED");
		f.files.set(join(f.config.toolPackageDir, "software-control.mjs"), tool);
		f.files.set(
			CONFIG_PATH,
			Buffer.from(
				JSON.stringify(config(f.root, { tools: { install: "1".repeat(64), measure: sha("measure tool") } })),
			),
		);
		await expect(f.run("begin")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_INPUTS_UNCONFIRMED");
		f.files.set(CONFIG_PATH, Buffer.from(JSON.stringify(config(f.root))));
		await rm(join(f.root, `service-stop-completed-${f.suffix}.json`));
		await expect(f.run("begin")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_INPUTS_UNCONFIRMED");
		await f.retain(`service-stop-completed-${f.suffix}.json`, {
			schema: "qorpera.lxd-office-stop-completion/v1",
			intentId: "00000000-0000-4000-8000-0000000000aa",
			allocationId: f.predecessor.startup.allocationId,
			transitionId: f.predecessor.transitionId,
			commandId: "00000000-0000-4000-8000-0000000000ab",
			receipt: officeServiceRestartFixture().request.acknowledgement,
		});
		await expect(f.run("begin")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_INPUTS_UNCONFIRMED");
		expect(f.ports.readCredential).not.toHaveBeenCalled();
		expect(f.calls).toEqual([]);
	});
	it("refuses a credential whose digest differs and reports an unconfirmed step without retrying", async () => {
		const f = await fixture();
		f.credentials.set(f.config.capabilityCredential.path, Buffer.from("0".repeat(64)));
		await expect(f.run("begin")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_CREDENTIAL_UNCONFIRMED");
		expect(f.calls).toEqual([]);
		f.credentials.set(f.config.capabilityCredential.path, Buffer.from(CAPABILITY));
		f.credentials.set(f.config.registryCredential.path, Buffer.from(REGISTRY_KEY.replace("0", "1")));
		await expect(f.run("begin")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_CREDENTIAL_UNCONFIRMED");
		expect(f.ports.registry).toHaveBeenCalledTimes(1);
		expect(f.calls).toEqual([]);
		f.credentials.set(f.config.registryCredential.path, Buffer.from(REGISTRY_KEY));
		f.ports.registry.mockImplementationOnce(() => ({
			async call() {
				f.calls.push("failed");
				throw new Error("OFFICE_PROVIDER_RPC_UNCONFIRMED");
			},
		}));
		await expect(f.run("begin")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_BEGIN_UNCONFIRMED");
		expect(f.calls).toEqual(["failed"]);
		f.gate.check.mockRejectedValueOnce(new Error("OFFICE_PROVIDER_HOST_CHANGED"));
		await expect(f.run("stage")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_STAGE_UNCONFIRMED");
		expect(f.client.pushOfficeSoftwareFile).not.toHaveBeenCalled();
		f.gate.check.mockRejectedValueOnce(new Error("OFFICE_PROVIDER_HOST_CHANGED"));
		await expect(f.run("install")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_INSTALL_UNCONFIRMED");
		expect(f.calls).toEqual(["failed"]);
		expect((await readdir(f.root)).filter((name) => name.startsWith("software-install-"))).toEqual([]);
	});
	it("refuses a plan whose predecessor is not this policy's office", async () => {
		const f = await fixture();
		f.policy.guest.computerGeneration = 2;
		await expect(f.run("status")).rejects.toThrow("OFFICE_SOFTWARE_UPDATE_INPUTS_UNCONFIRMED");
		expect(f.ports.readCredential).not.toHaveBeenCalled();
	});
});
