import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CompanyComputerLifecycleRequest,
	type CompanyComputerPreparationRequest,
	type CompanyComputerResetCustodyBinding,
	type CompanyComputerResetCustodyManifest,
	type CompanyComputerResetOutboxManifest,
	type CompanyComputerResetPlan,
	companyComputerPreparationAdoptionReceipt,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { officeCanonical } from "../src/lxd-office-image-provenance.ts";
import {
	lxdOfficeResetLayoutRoots,
	openLxdOfficeResetArchive,
	openLxdOfficeResetNasCustody,
	readLxdOfficeResetArchive,
	sealLxdOfficeResetArchive,
} from "../src/lxd-office-reset-custody.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const id = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
const sha = (c: string) => c.repeat(64);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const startup = () => ({
	scope: { companyId: id(6), environmentId: id(7), companyComputerId: id(8), logicalComputerId: id(9) },
	computerGeneration: 1,
	allocationId: id(10),
	instanceSha256: sha("a"),
	imageSha256: sha("b"),
	bootstrapSha256: sha("c"),
	bootId: id(11),
	configurationSha256: sha("d"),
	serviceInvocationId: "e".repeat(32),
});
const predecessor = (): CompanyComputerLifecycleRequest => ({
	schema: "qorpera.office-lifecycle-request/v1",
	transitionId: id(2),
	action: "replace",
	activationId: id(3),
	providerId: id(12),
	providerPolicySha256: sha("f"),
	startup: startup(),
});
const preparation = (): CompanyComputerPreparationRequest => ({
	schema: "qorpera.office-guest-preparation/v1",
	scope: startup().scope,
	computerGeneration: 1,
	allocationId: id(10),
	instanceSha256: sha("a"),
	imageSha256: sha("b"),
	bootstrapSha256: sha("c"),
	bootId: id(11),
	uid: process.getuid?.() ?? 1000,
	gid: process.getgid?.() ?? 1000,
	copy: {
		adoptionId: id(15),
		observationSha256: sha("1"),
		planSha256: sha("2"),
		reviewSha256: sha("3"),
		outputInventorySha256: sha("4"),
	},
	workbenchMount: {
		filesystem: "nfs4",
		source: "192.0.2.1:/offices/test",
		root: "/",
		mountPoint: "/var/lib/qorpera-office",
	},
	limits: { memoryBytes: 1024 ** 3, pids: 512, cpuQuota: 200000, cpuPeriod: 100000 },
	entries: [".", "desktop", "profiles", "screens", "workbench"].map((path) => ({
		path,
		kind: "directory" as const,
		mode: 0o700,
		bytes: 0,
		sha256: null,
	})),
});
async function fixture() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "office-reset-custody-")));
	roots.push(base);
	await chmod(base, 0o700);
	const nas = join(base, "nas"),
		journal = join(base, "journal", "state"),
		archiveRoot = join(base, "custody");
	for (const path of [nas, journal, archiveRoot]) await mkdir(path, { recursive: true, mode: 0o700 });
	const { policy } = officePhysicalFixture();
	const bound = {
		...policy,
		guest: { ...policy.guest, workbenchSource: nas },
		journal: { ...policy.journal, path: journal },
	};
	const request = preparation();
	const layout = lxdOfficeResetLayoutRoots(bound, request);
	await mkdir(join(nas, `.qorpera-adopted-${id(15)}`), { mode: 0o700 });
	for (const root of layout) await mkdir(root.host, { mode: 0o700 });
	const plan: CompanyComputerResetPlan = {
		schema: "qorpera.lxd-office-reset-plan/v1",
		resetId: id(1),
		intentId: id(13),
		predecessor: predecessor(),
		preparationObservationSha256: sha("1"),
		providerBindingSha256: sha("2"),
		nodeId: null,
		predecessorRootIncarnationId: null,
		rootIncarnationId: id(5),
		successorActivationId: id(4),
		commands: { stopCommandId: id(20), deleteCommandId: id(21), createCommandId: id(22), startCommandId: id(23) },
		custody: { archiveRoot },
	};
	const binding: CompanyComputerResetCustodyBinding = {
		schema: "qorpera.office-reset-custody-binding/v1",
		resetId: id(1),
		transitionId: id(2),
		predecessorActivationId: id(3),
		successorActivationId: id(4),
		rootIncarnationId: id(5),
		predecessor: startup(),
		outboxUid: 1001,
		outboxGid: 1001,
	};
	const outboxFiles = [
		{ name: `${id(70)}-0000000000000001.json`, bytes: Buffer.from('{"event":1}\n') },
		{ name: "scope.json", bytes: Buffer.from('{"scope":true}\n') },
	];
	const outboxManifest: CompanyComputerResetOutboxManifest = {
		schema: "qorpera.office-reset-outbox/v1",
		binding,
		files: outboxFiles.map((file) => ({
			name: file.name,
			bytes: file.bytes.length,
			sha256: hash(file.bytes),
			uid: 1001,
			gid: 1001,
			mode: 0o600,
		})),
		recordCount: 1,
		totalBytes: outboxFiles.reduce((sum, file) => sum + file.bytes.length, 0),
	};
	const manifestBytes = Buffer.from('{"stop":"history"}'),
		adoptionBytes = Buffer.from(JSON.stringify(companyComputerPreparationAdoptionReceipt(request)));
	const historyRoot = `/etc/qorpera-office/history/${id(11)}/${id(3)}`;
	const files = [
		{ path: "/etc/qorpera-office/adoption.json", bytes: adoptionBytes, mode: 0o444 as const },
		{ path: `${historyRoot}/${hash(adoptionBytes)}.json`, bytes: adoptionBytes, mode: 0o600 as const },
		{ path: `${historyRoot}/claim.json`, bytes: manifestBytes, mode: 0o600 as const },
		{ path: `${historyRoot}/manifest.json`, bytes: manifestBytes, mode: 0o600 as const },
	].sort((a, b) => (a.path < b.path ? -1 : 1));
	const custody: CompanyComputerResetCustodyManifest = {
		schema: "qorpera.office-reset-custody/v1",
		resetId: id(1),
		rootIncarnationId: id(5),
		predecessorActivationId: id(3),
		outbox: {
			manifestSha256: hash(Buffer.from(officeCanonical(outboxManifest))),
			recordCount: 1,
			totalBytes: outboxManifest.totalBytes,
		},
		history: {
			manifestSha256: hash(manifestBytes),
			files: files.map((file) => ({
				path: file.path,
				bytes: file.bytes.length,
				sha256: hash(file.bytes),
				mode: file.mode,
			})),
			totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
		},
		journalHeadSha256: sha("7"),
		nas: { workbenchSource: nas, adoptionId: id(15), layoutSha256: sha("8") },
	};
	const historyFiles = [manifestBytes, adoptionBytes].map((bytes) => ({ name: `${hash(bytes)}.json`, bytes }));
	const seal = (archive: Awaited<ReturnType<typeof openLxdOfficeResetArchive>>) =>
		sealLxdOfficeResetArchive(archive, plan, binding, outboxManifest, outboxFiles, historyFiles, custody);
	return {
		base,
		nas,
		journal,
		archiveRoot,
		policy: bound,
		request,
		layout,
		plan,
		binding,
		outboxManifest,
		outboxFiles,
		historyFiles,
		custody,
		seal,
	};
}

describe("office reset custody archive", () => {
	it("keeps the archive outside the journal, workbench and every model-visible root", async () => {
		const f = await fixture();
		for (const archiveRoot of [f.journal, f.nas, f.layout[0].host, join(f.nas, "elsewhere"), f.base])
			await expect(
				openLxdOfficeResetArchive(f.policy, { ...f.plan, custody: { archiveRoot } }, f.request),
			).rejects.toThrow("OFFICE_RESET_CUSTODY_ROOT_OVERLAPS");
		await expect(
			openLxdOfficeResetArchive(
				f.policy,
				{ ...f.plan, custody: { archiveRoot: join(f.base, "missing") } },
				f.request,
			),
		).rejects.toThrow();
		const link = join(f.base, "link");
		await symlink(f.archiveRoot, link);
		await expect(
			openLxdOfficeResetArchive(f.policy, { ...f.plan, custody: { archiveRoot: link } }, f.request),
		).rejects.toThrow("LXD_OFFICE_JOURNAL_DIRECTORY_UNSAFE");
		const archive = await openLxdOfficeResetArchive(f.policy, f.plan, f.request);
		expect(archive).toEqual({
			root: join(f.archiveRoot, id(1)),
			outbox: join(f.archiveRoot, id(1), "outbox"),
			history: join(f.archiveRoot, id(1), "history"),
		});
		await expect(openLxdOfficeResetArchive(f.policy, f.plan, f.request)).resolves.toEqual(archive);
		await chmod(archive.outbox, 0o750);
		await expect(openLxdOfficeResetArchive(f.policy, f.plan, f.request)).rejects.toThrow(
			"LXD_OFFICE_JOURNAL_DIRECTORY_UNSAFE",
		);
	});
	it("seals byte-exact blobs, rereads them independently and refuses any divergence", async () => {
		const f = await fixture();
		const archive = await openLxdOfficeResetArchive(f.policy, f.plan, f.request);
		const sealed = await f.seal(archive);
		expect(sealed.manifest).toEqual(f.custody);
		const read = await readLxdOfficeResetArchive(archive, f.plan, f.binding);
		expect(read.manifestSha256).toBe(sealed.manifestSha256);
		expect(read.outboxManifest).toEqual(
			f.custody.outbox.manifestSha256 === sealed.manifest.outbox.manifestSha256 ? read.outboxManifest : null,
		);
		expect([...read.outbox.keys()]).toEqual(f.outboxFiles.map((file) => file.name));
		expect(read.outbox.get("scope.json")).toEqual({
			bytes: f.outboxFiles[1].bytes,
			uid: 1001,
			gid: 1001,
			mode: 0o600,
		});
		expect([...read.history.keys()].sort()).toEqual(f.historyFiles.map((file) => hash(file.bytes)).sort());
		expect((await readdir(archive.root)).sort()).toEqual([
			"history",
			"manifest.json",
			"outbox",
			"outbox-manifest.json",
		]);
		// Idempotent re-seal of identical bytes; any changed blob is refused.
		await expect(f.seal(archive)).resolves.toEqual(sealed);
		await expect(
			sealLxdOfficeResetArchive(
				archive,
				f.plan,
				f.binding,
				f.outboxManifest,
				f.outboxFiles.map((file, index) =>
					index === 1 ? { ...file, bytes: Buffer.from('{"scope":1}\n ') } : file,
				),
				f.historyFiles,
				f.custody,
			),
		).rejects.toThrow("OFFICE_RESET_ARCHIVE_OUTBOX_DIFFERS");
		await expect(
			sealLxdOfficeResetArchive(archive, f.plan, f.binding, f.outboxManifest, f.outboxFiles, [], f.custody),
		).rejects.toThrow("OFFICE_RESET_ARCHIVE_HISTORY_DIFFERS");
		await writeFile(join(archive.root, "stray.json"), "{}", { mode: 0o600 });
		await expect(readLxdOfficeResetArchive(archive, f.plan, f.binding)).rejects.toThrow(
			"OFFICE_RESET_ARCHIVE_OUTBOX_DIFFERS",
		);
		await rm(join(archive.root, "stray.json"));
		await chmod(join(archive.outbox, "scope.json"), 0o600);
		await writeFile(join(archive.outbox, "scope.json"), '{"scope":false}');
		await expect(readLxdOfficeResetArchive(archive, f.plan, f.binding)).rejects.toThrow(
			"OFFICE_RESET_ARCHIVE_OUTBOX_DIFFERS",
		);
		await writeFile(join(archive.outbox, "scope.json"), f.outboxFiles[1].bytes);
		const historyName = join(archive.history, f.historyFiles[0].name);
		await chmod(historyName, 0o600);
		await writeFile(historyName, "{}");
		await expect(readLxdOfficeResetArchive(archive, f.plan, f.binding)).rejects.toThrow(
			"OFFICE_RESET_ARCHIVE_HISTORY_DIFFERS",
		);
		await writeFile(historyName, f.historyFiles[0].bytes);
		await expect(readLxdOfficeResetArchive(archive, f.plan, f.binding)).resolves.toMatchObject({
			manifestSha256: sealed.manifestSha256,
		});
		await expect(readLxdOfficeResetArchive(archive, { ...f.plan, resetId: id(99) }, f.binding)).rejects.toThrow();
	});
});

describe("office reset NAS descriptor custody", () => {
	it("holds the four adopted roots by descriptor, binds their identity and detects replacement", async () => {
		const f = await fixture();
		const custody = await openLxdOfficeResetNasCustody(f.policy, f.request);
		expect(custody.adoptionId).toBe(id(15));
		expect(custody.layoutSha256).toMatch(/^[0-9a-f]{64}$/);
		await custody.verify();
		const again = await openLxdOfficeResetNasCustody(f.policy, f.request);
		expect(again.layoutSha256).toBe(custody.layoutSha256);
		await again.close();
		await writeFile(join(f.layout[0].host, "working-file.txt"), "mutable contents", { mode: 0o600 });
		await custody.verify();
		expect((await openLxdOfficeResetNasCustody(f.policy, f.request)).layoutSha256).toBe(custody.layoutSha256);
		await chmod(f.layout[1].host, 0o750);
		await expect(custody.verify()).rejects.toThrow("OFFICE_RESET_NAS_CUSTODY_CHANGED");
		await expect(openLxdOfficeResetNasCustody(f.policy, f.request)).rejects.toThrow(
			"OFFICE_RESET_NAS_CUSTODY_CHANGED",
		);
		await chmod(f.layout[1].host, 0o700);
		await custody.verify();
		await rename(f.layout[2].host, `${f.layout[2].host}.moved`);
		await mkdir(f.layout[2].host, { mode: 0o700 });
		await expect(custody.verify()).rejects.toThrow("OFFICE_RESET_NAS_CUSTODY_CHANGED");
		const replaced = await openLxdOfficeResetNasCustody(f.policy, f.request);
		expect(replaced.layoutSha256).not.toBe(custody.layoutSha256);
		await replaced.close();
		await custody.close();
		await expect(
			openLxdOfficeResetNasCustody(f.policy, { ...f.request, copy: { ...f.request.copy, adoptionId: id(16) } }),
		).rejects.toThrow();
		await rename(f.nas, `${f.nas}.real`);
		await symlink(`${f.nas}.real`, f.nas);
		await expect(openLxdOfficeResetNasCustody(f.policy, f.request)).rejects.toThrow(
			"OFFICE_RESET_NAS_CUSTODY_UNSAFE",
		);
	});
});
