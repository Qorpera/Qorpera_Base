import { createHash, sign } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_SERVICE_SOFTWARE_FILES,
	COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
	companyComputerServiceSoftwareChangedFiles,
	companyComputerServiceSoftwareMeasurementText,
	parseCompanyComputerServiceSoftwareInvocationChallenge,
	parseCompanyComputerServiceSoftwareInvocationEvidence,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type LxdInstanceFile,
	type LxdOfficeSoftwareClient,
	OFFICE_SOFTWARE_INSTALLED_SERVICE,
	OFFICE_SOFTWARE_JOURNAL_ROOT,
	OFFICE_SOFTWARE_STAGING_ROOT,
	officeSoftwareCommand,
	officeSoftwareReadPath,
	officeSoftwareStagedPath,
} from "../src/lxd-client.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import type { LxdOfficeSoftwareInstallChallenge } from "../src/lxd-office-software-control.ts";
import type { LxdOfficeSoftwareInvocationRegistry } from "../src/lxd-office-software-invocation-control.ts";
import {
	createLxdOfficeInvocationMeasurement,
	createLxdOfficeSoftwareInstallPhysical,
	createLxdOfficeSoftwareMeasurementPhysical,
	stageLxdOfficeSoftwareInstall,
	stageLxdOfficeSoftwareTools,
} from "../src/lxd-office-software-transport.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";
import { officeServiceRestartFixture } from "./fixtures/office-service-restart.ts";
import { officeGuestCodeFixtureFiles, officeSoftwareFixture } from "./fixtures/office-software.ts";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(options: { guestCode?: boolean } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-software-transport-")));
	await chmod(root, 0o700);
	roots.push(root);
	const restart = officeServiceRestartFixture();
	const stop = restart.request.stop,
		acknowledgement = restart.request.acknowledgement,
		stopCommand = acknowledgement.inspection.stop.command,
		predecessor = stop.revocation.request;
	const software = officeSoftwareFixture();
	const statement = {
		...software.statement,
		base: {
			...software.statement.base,
			imageSha256: predecessor.startup.imageSha256,
			bootstrapSha256: predecessor.startup.bootstrapSha256,
		},
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
	const serviceBytes = Buffer.alloc(statement.next.service.bytes, 7);
	const next = { ...statement.next, service: { ...statement.next.service, sha256: sha(serviceBytes) } };
	const manifestNext = structuredClone(software.next);
	manifestNext.artifacts[0] = { ...manifestNext.artifacts[0], sha256: next.service.sha256 };
	const guestCode = options.guestCode ? officeGuestCodeFixtureFiles(software.previous, manifestNext) : undefined;
	const manifests = { previous: software.manifests.previous, next: Buffer.from(JSON.stringify(manifestNext)) };
	statement.next = {
		packageManifestSha256: sha(manifests.next),
		service: next.service,
		...(guestCode ? { files: guestCode.nextFiles } : {}),
	};
	if (guestCode) {
		statement.previous = { ...statement.previous, files: guestCode.previousFiles };
		statement.acceptance = { ...statement.acceptance, change: "guest-code" };
	}
	const guestBytes: Record<string, Buffer> = guestCode?.bytes ?? {};
	envelope.signature.value = sign(null, Buffer.from(officeCanonical(statement)), software.keys.privateKey).toString(
		"base64",
	);
	plan.statementSha256 = officeDigest(statement);
	trust.statementSha256 = officeDigest(statement);
	trust.planSha256 = officeDigest(plan);
	const binding = { ...officePhysicalFixture().binding, allocationId: predecessor.startup.allocationId };
	const name = lxdOfficeGuestPlan(binding).request.name;
	const tools = { install: Buffer.from("install tool"), measure: Buffer.from("measure tool") };
	const pins = { install: sha(tools.install), measure: sha(tools.measure) };
	const guest = new Map<string, LxdInstanceFile>();
	const executions: Array<{ tool: string; args: readonly string[] }> = [];
	const receipt = {
		schema: "qorpera.office-service-software-receipt/v1",
		plan,
		planSha256: trust.planSha256,
		state: "installed",
		service: { ...statement.next.service },
		...(guestCode ? { files: structuredClone(guestCode.nextFiles) } : {}),
		installedAt: "2026-09-12T01:00:00.000Z",
	};
	let installedBytes: Buffer = serviceBytes;
	let installedMode = 0o444;
	const installedFiles = new Map<string, { content: Buffer; mode: number }>();
	for (const entry of guestCode?.nextFiles ?? [])
		installedFiles.set(entry.path, { content: guestBytes[entry.file]!, mode: entry.mode });
	const client = {
		pushOfficeSoftwareFile: vi.fn<LxdOfficeSoftwareClient["pushOfficeSoftwareFile"]>(
			async (project, instance, fileName, content) => {
				expect([project, instance]).toEqual([binding.project, name]);
				const { path } = officeSoftwareStagedPath(fileName);
				guest.set(path, { content: Buffer.from(content), uid: 0, gid: 0, mode: 0o400 });
			},
		),
		submitOfficeSoftwareControl: vi.fn<LxdOfficeSoftwareClient["submitOfficeSoftwareControl"]>(
			async (project, instance, tool, args) => {
				expect([project, instance]).toEqual([binding.project, name]);
				officeSoftwareCommand(tool, args);
				executions.push({ tool, args });
				const files = await readdir(root);
				expect(
					files.some(
						(file) =>
							file.startsWith(
								`software-${tool === "install" ? "install" : "measurement"}-${binding.allocationId}-`,
							) && !file.includes("-accepted"),
					),
				).toBe(true);
				if (tool === "install") {
					const packet = guest.get(`${OFFICE_SOFTWARE_STAGING_ROOT}/software-incoming-${args[1]}.json`);
					expect(packet && sha(packet.content)).toBe(args[1]);
					expect(
						guest.get(`${OFFICE_SOFTWARE_STAGING_ROOT}/software-control.mjs`)?.content.equals(tools.install),
					).toBe(true);
					guest.set(`${OFFICE_SOFTWARE_JOURNAL_ROOT}/${plan.updateId}/installed.json`, {
						content: Buffer.from(`${JSON.stringify(receipt)}\n`),
						uid: 0,
						gid: 0,
						mode: 0o400,
					});
					guest.set(OFFICE_SOFTWARE_INSTALLED_SERVICE, {
						content: installedBytes,
						uid: 0,
						gid: 0,
						mode: installedMode,
					});
					for (const [path, file] of installedFiles)
						guest.set(path, { content: file.content, uid: 0, gid: 0, mode: file.mode });
				} else {
					const staged = guest.get(
						`${OFFICE_SOFTWARE_STAGING_ROOT}/software-measurement-incoming-${args[1]}.json`,
					);
					expect(staged && sha(staged.content)).toBe(args[1]);
					const challenge = parseCompanyComputerServiceSoftwareInvocationChallenge(
						JSON.parse(staged!.content.toString()),
					);
					expect(companyComputerServiceSoftwareMeasurementText(challenge)).toBe(staged!.content.toString());
					const { validForMs: _remaining, ...bindingValue } = challenge;
					const evidence = parseCompanyComputerServiceSoftwareInvocationEvidence(
						{
							...bindingValue,
							schema: "qorpera.office-software-invocation-evidence/v1",
							mainPid: 700,
							controlGroup: "/system.slice/qorpera-company-computer.service",
							configurationCompletionSha256: "a".repeat(64),
							serviceStartCompletionSha256: "b".repeat(64),
						},
						challenge,
					);
					guest.set(`${OFFICE_SOFTWARE_STAGING_ROOT}/software-measurement-${challenge.challengeId}.json`, {
						content: Buffer.from(
							`${JSON.stringify({ schema: "qorpera.office-software-measurement-receipt/v1", challengeId: challenge.challengeId, evidence, evidenceSha256: sha(companyComputerServiceSoftwareMeasurementText(evidence)) })}\n`,
						),
						uid: 0,
						gid: 0,
						mode: 0o400,
					});
				}
				return { project, instanceName: instance, operationId: "00000000-0000-4000-8000-00000000abcd" };
			},
		),
		inspectOfficeSoftwareControl: vi.fn<LxdOfficeSoftwareClient["inspectOfficeSoftwareControl"]>(
			async () => "succeeded",
		),
		readOfficeSoftwareFile: vi.fn<LxdOfficeSoftwareClient["readOfficeSoftwareFile"]>(
			async (project, instance, path, maximumBytes) => {
				expect([project, instance]).toEqual([binding.project, name]);
				expect(maximumBytes).toBeLessThanOrEqual(officeSoftwareReadPath(path));
				const file = guest.get(path);
				if (!file || file.content.length > maximumBytes)
					throw new Error("LXD_OFFICE_SOFTWARE_READBACK_UNCONFIRMED");
				return { ...file, content: Buffer.from(file.content) };
			},
		),
	};
	const transport = {
		envelope,
		plan,
		trust,
		manifests,
		stop,
		stopCommand,
		acknowledgement,
		toolSha256: pins.install,
		trustSha256: "",
	};
	const stage = async () => {
		await stageLxdOfficeSoftwareTools(client, binding, tools, pins, signal());
		const staged = await stageLxdOfficeSoftwareInstall(
			client,
			binding,
			{ envelope, plan, trust, manifests, serviceBytes, files: guestBytes, providerCapability: "c".repeat(64) },
			signal(),
		);
		transport.trustSha256 = staged.trustSha256;
		return staged;
	};
	const challenge = (
		challengeId = "00000000-0000-4000-8000-0000000000c1",
	): Readonly<LxdOfficeSoftwareInstallChallenge> => ({
		schema: "qorpera.office-software-install-challenge/v1",
		challengeId,
		plan: plan as unknown as LxdOfficeSoftwareInstallChallenge["plan"],
		planSha256: trust.planSha256,
		statement: statement as unknown as LxdOfficeSoftwareInstallChallenge["statement"],
		targetRevision: 1,
		capabilityRevision: 1,
		validForMs: 5000,
	});
	const install = (challengeId?: string, deadline = performance.now() + 5000, caller = signal()) =>
		createLxdOfficeSoftwareInstallPhysical(
			root,
			binding,
			client,
			transport,
		)(challenge(challengeId), deadline, caller);
	return {
		root,
		binding,
		name,
		guest,
		executions,
		client,
		tools,
		pins,
		plan,
		statement,
		envelope,
		trust,
		manifests,
		serviceBytes,
		guestBytes,
		receipt,
		transport,
		stage,
		challenge,
		install,
		setInstalled(bytes: Buffer, mode = 0o444) {
			installedBytes = bytes;
			installedMode = mode;
		},
		setInstalledFile(path: string, content: Buffer, mode: number) {
			installedFiles.set(path, { content, mode });
		},
	};
}
describe("provider software staging", () => {
	it("stages both pinned tools and every signed input as root 0400 files, never the packet or a foreign name", async () => {
		const f = await fixture();
		const staged = await f.stage();
		const names = [...f.guest.keys()].map((path) => path.slice(OFFICE_SOFTWARE_STAGING_ROOT.length + 1)).sort();
		expect(names).toEqual(
			[
				"software-control.mjs",
				"software-measurement-control.mjs",
				`software-capability-${f.plan.updateId}`,
				`software-next-manifest-${staged.planSha256}.json`,
				`software-previous-manifest-${staged.planSha256}.json`,
				`software-service-${f.statement.next.service.sha256}.mjs`,
				`software-trust-${staged.trustSha256}.json`,
			].sort(),
		);
		for (const file of f.guest.values()) expect([file.uid, file.gid, file.mode]).toEqual([0, 0, 0o400]);
		expect(
			f.guest.get(`${OFFICE_SOFTWARE_STAGING_ROOT}/software-capability-${f.plan.updateId}`)?.content.toString(),
		).toBe("c".repeat(64));
		const trust = f.guest.get(`${OFFICE_SOFTWARE_STAGING_ROOT}/software-trust-${staged.trustSha256}.json`)!;
		expect(sha(trust.content)).toBe(staged.trustSha256);
		expect(JSON.parse(trust.content.toString())).toEqual(f.trust);
		expect(() => officeSoftwareStagedPath("software-other.json")).toThrow("INVALID_OFFICE_SOFTWARE_STAGING");
		expect(() => officeSoftwareStagedPath("../software-control.mjs")).toThrow();
	});
	it("refuses a tool whose bytes differ from the operator pin and a service candidate differing from the statement", async () => {
		const f = await fixture();
		await expect(
			stageLxdOfficeSoftwareTools(
				f.client,
				f.binding,
				{ ...f.tools, measure: Buffer.from("other") },
				f.pins,
				signal(),
			),
		).rejects.toThrow("OFFICE_SOFTWARE_TOOL_PIN_DIFFERS");
		expect(f.client.pushOfficeSoftwareFile).toHaveBeenCalledTimes(1);
		await expect(
			stageLxdOfficeSoftwareInstall(
				f.client,
				f.binding,
				{
					envelope: f.envelope,
					plan: f.plan,
					trust: f.trust,
					manifests: f.manifests,
					serviceBytes: Buffer.from("other"),
					providerCapability: "c".repeat(64),
				},
				signal(),
			),
		).rejects.toThrow("OFFICE_SOFTWARE_STAGING_DIFFERS");
		await expect(
			stageLxdOfficeSoftwareInstall(
				f.client,
				f.binding,
				{
					envelope: f.envelope,
					plan: f.plan,
					trust: f.trust,
					manifests: f.manifests,
					serviceBytes: f.serviceBytes,
					providerCapability: "C".repeat(64),
				},
				signal(),
			),
		).rejects.toThrow("OFFICE_SOFTWARE_STAGING_DIFFERS");
		expect(f.client.pushOfficeSoftwareFile).toHaveBeenCalledTimes(1);
	});
});
describe("provider guest-code software staging and installation", () => {
	it("stages every changed guest code entry under its digest and refuses a missing, foreign or altered entry", async () => {
		const f = await fixture({ guestCode: true });
		const changed = companyComputerServiceSoftwareChangedFiles(f.statement as never);
		expect(changed.map((entry) => entry.file)).toEqual(Object.keys(f.guestBytes).sort());
		const staged = await f.stage();
		const names = [...f.guest.keys()].map((path) => path.slice(OFFICE_SOFTWARE_STAGING_ROOT.length + 1)).sort();
		expect(names).toEqual(
			[
				"software-control.mjs",
				"software-measurement-control.mjs",
				`software-capability-${f.plan.updateId}`,
				`software-next-manifest-${staged.planSha256}.json`,
				`software-previous-manifest-${staged.planSha256}.json`,
				`software-service-${f.statement.next.service.sha256}.mjs`,
				`software-trust-${staged.trustSha256}.json`,
				...changed.map((entry) => `software-file-${entry.sha256}`),
			].sort(),
		);
		for (const entry of changed) {
			expect(
				f.guest
					.get(`${OFFICE_SOFTWARE_STAGING_ROOT}/software-file-${entry.sha256}`)
					?.content.equals(f.guestBytes[entry.file]!),
			).toBe(true);
			expect(officeSoftwareStagedPath(`software-file-${entry.sha256}`).maximum).toBe(32 * 1024 ** 2);
			expect(officeSoftwareReadPath(entry.path)).toBe(32 * 1024 ** 2);
		}
		for (const { path } of Object.values(COMPANY_COMPUTER_SERVICE_SOFTWARE_FILES))
			expect(officeSoftwareReadPath(path)).toBe(32 * 1024 ** 2);
		expect(() => officeSoftwareStagedPath("software-file-abc")).toThrow("INVALID_OFFICE_SOFTWARE_STAGING");
		expect(() => officeSoftwareReadPath("/usr/local/bin/other")).toThrow("INVALID_OFFICE_SOFTWARE_READBACK");
		const [first] = changed;
		for (const files of [
			undefined,
			{},
			{ ...f.guestBytes, [first.file]: Buffer.concat([f.guestBytes[first.file]!, Buffer.from([1])]) },
			{ ...f.guestBytes, "qorpera-screen-xfce": Buffer.from("foreign") },
		]) {
			f.client.pushOfficeSoftwareFile.mockClear();
			await expect(
				stageLxdOfficeSoftwareInstall(
					f.client,
					f.binding,
					{
						envelope: f.envelope,
						plan: f.plan,
						trust: f.trust,
						manifests: f.manifests,
						serviceBytes: f.serviceBytes,
						files,
						providerCapability: "c".repeat(64),
					},
					signal(),
				),
			).rejects.toThrow("OFFICE_SOFTWARE_STAGING_DIFFERS");
			expect(f.client.pushOfficeSoftwareFile).not.toHaveBeenCalled();
		}
		// A service-only revision refuses any guest code bytes.
		const plain = await fixture();
		await expect(
			stageLxdOfficeSoftwareInstall(
				plain.client,
				plain.binding,
				{
					envelope: plain.envelope,
					plan: plain.plan,
					trust: plain.trust,
					manifests: plain.manifests,
					serviceBytes: plain.serviceBytes,
					files: f.guestBytes,
					providerCapability: "c".repeat(64),
				},
				signal(),
			),
		).rejects.toThrow("OFFICE_SOFTWARE_STAGING_DIFFERS");
	});
	it("measures every installed guest code entry host-side and withholds evidence when one differs", async () => {
		const f = await fixture({ guestCode: true });
		await f.stage();
		const result = await f.install();
		expect(result.receipt).toEqual(f.receipt);
		expect(result.measuredFiles).toEqual(f.statement.next.files);
		const prefix = `software-install-${f.binding.allocationId}-${f.plan.updateId}-${f.challenge().challengeId}`;
		const evidence = JSON.parse(await readFile(join(f.root, `${prefix}-evidence.json`), "utf8"));
		expect(evidence.evidence.measuredFiles).toEqual(f.statement.next.files);
		expect(officeDigest(evidence.evidence)).toBe(result.evidenceSha256);
		for (const kind of ["different bytes", "writable mode"] as const) {
			const g = await fixture({ guestCode: true });
			await g.stage();
			const entry = g.statement.next.files![1]!;
			if (kind === "different bytes") g.setInstalledFile(entry.path, Buffer.from("other"), entry.mode);
			else g.setInstalledFile(entry.path, g.guestBytes[entry.file]!, 0o644);
			await expect(g.install()).rejects.toThrow("software installed guest code differs");
			const files = await readdir(g.root);
			expect(files.some((file) => file.endsWith("-evidence.json"))).toBe(false);
		}
	});
});
describe("provider software installation transport", () => {
	it("retains dispatch before staging the challenge packet, execs the pinned tool and measures installed bytes independently", async () => {
		const f = await fixture();
		await f.stage();
		const result = await f.install();
		expect(result.receipt).toEqual(f.receipt);
		expect(result.measuredService).toEqual({
			path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
			bytes: f.serviceBytes.length,
			sha256: sha(f.serviceBytes),
		});
		expect(f.executions).toHaveLength(1);
		const [commandId, requestSha256, bootId, toolSha256, trustSha256] = f.executions[0].args;
		expect([bootId, toolSha256, trustSha256]).toEqual([
			f.plan.predecessor.startup.bootId,
			f.pins.install,
			f.transport.trustSha256,
		]);
		expect(commandId).not.toBe(f.challenge().challengeId);
		const packet = JSON.parse(
			f.guest.get(`${OFFICE_SOFTWARE_STAGING_ROOT}/software-incoming-${requestSha256}.json`)!.content.toString(),
		);
		expect(Object.keys(packet).sort()).toEqual(
			[
				"acknowledgement",
				"capabilityRevision",
				"challengeId",
				"envelope",
				"plan",
				"schema",
				"statement",
				"stop",
				"stopCommand",
				"targetRevision",
			].filter((key) => key !== "statement"),
		);
		expect(packet).toMatchObject({
			schema: "qorpera.office-software-control/v1",
			challengeId: f.challenge().challengeId,
			targetRevision: 1,
			capabilityRevision: 1,
			plan: f.plan,
		});
		expect(JSON.stringify(packet)).not.toContain("c".repeat(64));
		const prefix = `software-install-${f.binding.allocationId}-${f.plan.updateId}-${f.challenge().challengeId}`;
		const files = (await readdir(f.root)).sort();
		expect(files).toEqual([`${prefix}-accepted.json`, `${prefix}-evidence.json`, `${prefix}.json`]);
		const dispatch = JSON.parse(await readFile(join(f.root, `${prefix}.json`), "utf8"));
		expect(dispatch).toMatchObject({
			schema: "qorpera.lxd-office-software-install-dispatch/v1",
			updateId: f.plan.updateId,
			command: { commandId, requestSha256, bootId },
			toolSha256,
			trustSha256,
		});
		const evidence = JSON.parse(await readFile(join(f.root, `${prefix}-evidence.json`), "utf8"));
		expect(evidence.schema).toBe("qorpera.lxd-office-software-evidence/v1");
		expect(officeDigest(evidence.evidence)).toBe(result.evidenceSha256);
		expect(evidence.evidence).toMatchObject({
			schema: "qorpera.lxd-office-software-install-evidence/v1",
			installedFile: { uid: 0, gid: 0, mode: 0o444 },
			measuredService: result.measuredService,
		});
		for (const file of files) expect(await readFile(join(f.root, file), "utf8")).not.toContain("c".repeat(64));
	});
	it.each([
		[
			"different bytes",
			(f: Awaited<ReturnType<typeof fixture>>) => f.setInstalled(Buffer.alloc(f.serviceBytes.length, 8)),
		],
		[
			"different length",
			(f: Awaited<ReturnType<typeof fixture>>) => f.setInstalled(Buffer.concat([f.serviceBytes, Buffer.from([1])])),
		],
		["writable mode", (f: Awaited<ReturnType<typeof fixture>>) => f.setInstalled(f.serviceBytes, 0o644)],
	])("withholds evidence when the installed target has %s", async (_name, change) => {
		const f = await fixture();
		await f.stage();
		change(f);
		await expect(f.install()).rejects.toThrow();
		const files = await readdir(f.root);
		expect(files.some((file) => file.endsWith("-evidence.json"))).toBe(false);
		expect(files.some((file) => file.endsWith("-accepted.json"))).toBe(true);
	});
	it("refuses a receipt that does not bind the signed plan and never publishes evidence", async () => {
		const f = await fixture();
		await f.stage();
		const submit = f.client.submitOfficeSoftwareControl.getMockImplementation()!;
		f.client.submitOfficeSoftwareControl.mockImplementationOnce(async (...args) => {
			const reference = await submit(...args);
			f.guest.set(`${OFFICE_SOFTWARE_JOURNAL_ROOT}/${f.plan.updateId}/installed.json`, {
				content: Buffer.from(JSON.stringify({ ...f.receipt, planSha256: "0".repeat(64) })),
				uid: 0,
				gid: 0,
				mode: 0o400,
			});
			return reference;
		});
		await expect(f.install()).rejects.toThrow();
		expect((await readdir(f.root)).some((file) => file.endsWith("-evidence.json"))).toBe(false);
	});
	it("holds a retained nonce, bounds attempts and never deletes records", async () => {
		const f = await fixture();
		await f.stage();
		await f.install();
		await expect(f.install()).rejects.toThrow("already dispatched");
		expect(f.executions).toHaveLength(1);
		for (let i = 1; i <= 64; i++)
			await writeFile(
				join(
					f.root,
					`software-install-${f.binding.allocationId}-${f.plan.updateId}-00000000-0000-4000-8000-${String(i).padStart(12, "0")}.json`,
				),
				"{}",
				{ mode: 0o600 },
			);
		await expect(f.install("00000000-0000-4000-8000-0000000000c2")).rejects.toThrow("budget exhausted");
		expect(f.executions).toHaveLength(1);
		expect(await readdir(f.root)).toHaveLength(67);
	});
	it("counts staging, exec, polling and read-back latency against the original challenge deadline", async () => {
		for (const phase of ["push", "submit", "poll", "read"] as const) {
			const f = await fixture();
			await f.stage();
			let clock = 0;
			const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
			try {
				const expire = <T extends (...args: never[]) => Promise<unknown>>(mock: {
					getMockImplementation(): T | undefined;
					mockImplementationOnce(fn: T): unknown;
				}) => {
					const original = mock.getMockImplementation()!;
					mock.mockImplementationOnce((async (...args: never[]) => {
						const result = await original(...args);
						clock = 5000;
						return result;
					}) as T);
				};
				if (phase === "push") expire(f.client.pushOfficeSoftwareFile);
				else if (phase === "submit") expire(f.client.submitOfficeSoftwareControl);
				else if (phase === "poll") expire(f.client.inspectOfficeSoftwareControl);
				else expire(f.client.readOfficeSoftwareFile);
				await expect(f.install(undefined, 5000)).rejects.toThrow("expired");
				expect((await readdir(f.root)).some((file) => file.endsWith("-evidence.json"))).toBe(false);
			} finally {
				spy.mockRestore();
			}
		}
	});
	it("reports a failed or cancelled tool without evidence and refuses a changed challenge before any record", async () => {
		const f = await fixture();
		await f.stage();
		f.client.inspectOfficeSoftwareControl.mockResolvedValueOnce("pending").mockResolvedValueOnce("failed");
		await expect(f.install()).rejects.toThrow("software tool failed");
		expect((await readdir(f.root)).some((file) => file.endsWith("-evidence.json"))).toBe(false);
		const physical = createLxdOfficeSoftwareInstallPhysical(f.root, f.binding, f.client, f.transport);
		await expect(
			physical(
				{ ...f.challenge("00000000-0000-4000-8000-0000000000c3"), planSha256: "1".repeat(64) },
				performance.now() + 5000,
				signal(),
			),
		).rejects.toThrow("OFFICE_SOFTWARE_CHALLENGE_DIFFERS");
		await expect(physical(f.challenge(f.plan.updateId), performance.now() + 5000, signal())).rejects.toThrow(
			"OFFICE_SOFTWARE_CHALLENGE_DIFFERS",
		);
		expect(
			(await readdir(f.root)).filter(
				(file) => file.includes("0000000000c3") || file.endsWith(`-${f.plan.updateId}.json`),
			),
		).toHaveLength(0);
	});
	it("refuses a transport whose stop acknowledgement does not bind the signed plan", async () => {
		const f = await fixture();
		expect(() =>
			createLxdOfficeSoftwareInstallPhysical(f.root, f.binding, f.client, {
				...f.transport,
				acknowledgement: { ...f.transport.acknowledgement, acknowledgedAtMs: 1 },
			}),
		).toThrow();
		expect(() =>
			createLxdOfficeSoftwareInstallPhysical(
				f.root,
				{ ...f.binding, allocationId: "77777777-7777-4777-8777-777777777777" },
				f.client,
				f.transport,
			),
		).toThrow("OFFICE_SOFTWARE_STOP_DIFFERS");
	});
});
describe("provider software invocation measurement transport", () => {
	function invocation(f: Awaited<ReturnType<typeof fixture>>) {
		const startup = { ...f.plan.predecessor.startup, serviceInvocationId: "d".repeat(32) };
		const challenge = parseCompanyComputerServiceSoftwareInvocationChallenge({
			schema: "qorpera.office-software-invocation-challenge/v1",
			challengeId: "00000000-0000-4000-8000-0000000000d1",
			activationId: f.plan.successorActivationId,
			startup,
			revision: 1,
			capabilityRevision: 2,
			service: { ...f.statement.next.service, path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH },
			validForMs: 4000,
		});
		return { startup, challenge };
	}
	it("stages the exact canonical challenge, execs the pinned measurement tool and reads back the closed receipt", async () => {
		const f = await fixture();
		await f.stage();
		const { challenge } = invocation(f);
		const result = await createLxdOfficeSoftwareMeasurementPhysical(
			f.root,
			f.binding,
			f.client,
			f.pins.measure,
		)(challenge, performance.now() + 4000, signal());
		const evidence = parseCompanyComputerServiceSoftwareInvocationEvidence(result.evidence, challenge);
		expect(sha(companyComputerServiceSoftwareMeasurementText(evidence))).toBe(result.evidenceSha256);
		expect(f.executions).toHaveLength(1);
		expect(f.executions[0].tool).toBe("measure");
		const [commandId, requestSha256, bootId, toolSha256] = f.executions[0].args;
		expect([bootId, toolSha256]).toEqual([challenge.startup.bootId, f.pins.measure]);
		expect(commandId).not.toBe(challenge.challengeId);
		expect(requestSha256).toBe(sha(companyComputerServiceSoftwareMeasurementText(challenge)));
		const prefix = `software-measurement-${f.binding.allocationId}-${challenge.activationId}-${challenge.challengeId}`;
		expect((await readdir(f.root)).sort()).toEqual([
			`${prefix}-accepted.json`,
			`${prefix}-evidence.json`,
			`${prefix}.json`,
		]);
		expect(JSON.parse(await readFile(join(f.root, `${prefix}-evidence.json`), "utf8"))).toMatchObject({
			evidence: { evidenceSha256: result.evidenceSha256, command: { commandId, requestSha256, bootId } },
		});
	});
	it.each([
		[
			"a receipt bound to another challenge",
			(content: string) => content.replace("0000000000d1", "0000000000d2"),
			0o400,
		],
		["a receipt outside root 0400 custody", (content: string) => content, 0o600],
		["an open receipt shape", (content: string) => JSON.stringify({ ...JSON.parse(content), extra: 1 }), 0o400],
	])("withholds %s", async (_name, change, mode) => {
		const f = await fixture();
		await f.stage();
		const { challenge } = invocation(f);
		const submit = f.client.submitOfficeSoftwareControl.getMockImplementation()!;
		f.client.submitOfficeSoftwareControl.mockImplementationOnce(async (...args) => {
			const reference = await submit(...args);
			const path = `${OFFICE_SOFTWARE_STAGING_ROOT}/software-measurement-${challenge.challengeId}.json`;
			const file = f.guest.get(path)!;
			f.guest.set(path, { ...file, content: Buffer.from(change(file.content.toString())), mode });
			return reference;
		});
		await expect(
			createLxdOfficeSoftwareMeasurementPhysical(
				f.root,
				f.binding,
				f.client,
				f.pins.measure,
			)(challenge, performance.now() + 4000, signal()),
		).rejects.toThrow();
		expect((await readdir(f.root)).some((file) => file.endsWith("-evidence.json"))).toBe(false);
	});
	it("composes challenge, protected measurement and acknowledgement for the workers without journaling the capability", async () => {
		const f = await fixture();
		await f.stage();
		const { startup, challenge } = invocation(f);
		const capability = "0123456789abcdef".repeat(4);
		const registry = vi.fn<LxdOfficeSoftwareInvocationRegistry["call"]>(async (method, args) => {
			expect(args.p_provider_capability).toBe(capability);
			if (method === "qorpera_check_office_software_invocation")
				return {
					...challenge,
					challengeId: args.p_challenge_id,
					activationId: args.p_activation_id,
					startup: args.p_startup,
				};
			expect(args.p_measured_service).toEqual(challenge.service);
			return {
				schema: "qorpera.office-software-measurement/v1",
				activationId: args.p_activation_id,
				revision: 1,
				state: "measured",
			};
		});
		const measure = createLxdOfficeInvocationMeasurement({
			root: f.root,
			client: f.client,
			registry: { call: registry },
			binding: (allocationId) => ({ ...f.binding, allocationId }),
			providerCapability: capability,
			expectedRevision: 1,
			expectedService: challenge.service,
			measurementToolSha256: f.pins.measure,
		});
		await expect(
			measure(challenge.activationId, startup, performance.now() + 4000, signal()),
		).resolves.toBeUndefined();
		expect(registry.mock.calls.map((call) => call[0])).toEqual([
			"qorpera_check_office_software_invocation",
			"qorpera_ack_office_software_invocation",
		]);
		for (const file of await readdir(f.root))
			expect(await readFile(join(f.root, file), "utf8")).not.toContain(capability);
		for (const file of f.guest.values()) expect(file.content.toString("latin1")).not.toContain(capability);
		await expect(
			measure(
				challenge.activationId,
				{ ...startup, allocationId: "77777777-7777-4777-8777-777777777777" },
				performance.now() + 4000,
				signal(),
			),
		).rejects.toThrow();
		expect(() =>
			createLxdOfficeInvocationMeasurement({
				root: f.root,
				client: f.client,
				registry: { call: registry },
				binding: () => f.binding,
				providerCapability: "x".repeat(64),
				expectedRevision: 1,
				expectedService: challenge.service,
				measurementToolSha256: f.pins.measure,
			}),
		).toThrow("OFFICE_SOFTWARE_AUTHORITY_INVALID");
	});
});
