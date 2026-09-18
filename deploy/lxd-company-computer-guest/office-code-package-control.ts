import { randomUUID } from "node:crypto";
import { parseCompanyComputerPreparationCommand } from "../../packages/contracts/src/index.ts";
import {
	officeCanonical,
	officeDigest,
	officeRecord,
} from "../../packages/runner-orchestrator/src/lxd-office-image-provenance.ts";
import { assertCompanyComputerPreparationLockAndBoot } from "../../packages/runtime/src/cloud-company-computer-preparation-control.ts";
import {
	assertPackageAbsent,
	assertPackageInventoryStamps,
	claimPackageFile,
	packageDirectory,
	packageHash,
	readPackageFile,
	replacePackageCode,
} from "./office-code-package-files.ts";
import {
	loadOfficeCodePackageMaterial,
	measureOfficeCodePackageExternal,
	measureOfficeCodePackageInventory,
	officeCodePackageReceipt,
	openOfficeCodePackageFreshRoot,
	packageCommand,
	packageDecode,
	packageEncode,
	packageJournal,
} from "./office-code-package-material.ts";

export interface OfficeCodePackageProbe {
	readonly schema: "qorpera.office-code-package-probe/v1";
	readonly purpose: "install" | "measure";
	readonly probeId: string;
	readonly provisionId: string;
	readonly packetSha256: string;
	readonly bootId: string;
	readonly challengeId: string;
	readonly nonce: string;
	readonly monotonicNs: string;
}
export function parseOfficeCodePackageProbe(value: unknown): OfficeCodePackageProbe {
	const r = officeRecord(value, [
		"schema",
		"purpose",
		"probeId",
		"provisionId",
		"packetSha256",
		"bootId",
		"challengeId",
		"nonce",
		"monotonicNs",
	]);
	if (
		r.schema !== "qorpera.office-code-package-probe/v1" ||
		!["install", "measure"].includes(String(r.purpose)) ||
		typeof r.monotonicNs !== "string" ||
		!/^[1-9][0-9]{0,23}$/.test(r.monotonicNs)
	)
		throw new Error("CODE_PACKAGE_PROBE");
	for (const id of [r.probeId, r.provisionId, r.challengeId, r.nonce])
		parseCompanyComputerPreparationCommand({ commandId: id, requestSha256: r.packetSha256, bootId: r.bootId });
	return r as unknown as OfficeCodePackageProbe;
}
/** Guest monotonic origin is sampled BEFORE provider SQL admission. Thus the
 * local deadline can be earlier, never later, than that SQL permission. */
export function officeCodePackageDeadline(
	probe: OfficeCodePackageProbe,
	nonce: string,
	validForMs: number,
	now = () => process.hrtime.bigint(),
) {
	parseOfficeCodePackageProbe(probe);
	if (nonce !== probe.nonce || !Number.isSafeInteger(validForMs) || validForMs < 1 || validForMs > 5000)
		throw new Error("CODE_PACKAGE_AUTHORITY");
	const start = BigInt(probe.monotonicNs),
		deadline = start + BigInt(validForMs) * 1000000n;
	return () => {
		const current = now();
		if (current < start || current >= deadline) throw new Error("CODE_PACKAGE_AUTHORITY_EXPIRED");
	};
}
export async function runOfficeCodePackageTool(purpose: string, id: string, args: readonly string[]) {
	if (
		purpose !== "bootstrap" ||
		!["preflight", "install"].includes(args[0]) ||
		args.length !== (args[0] === "preflight" ? 4 : 6)
	)
		throw new Error("CODE_PACKAGE_ARGUMENTS");
	const [mode, packetSha, trustSha, probeId, nonce, lifetime] = args;
	const m = await loadOfficeCodePackageMaterial(id, packetSha, trustSha),
		command = packageCommand(m);
	parseCompanyComputerPreparationCommand({ ...command, commandId: probeId });
	const signal = AbortSignal.timeout(110000);
	await assertCompanyComputerPreparationLockAndBoot(command);
	const fresh = await openOfficeCodePackageFreshRoot(m, signal);
	try {
		const journal = packageJournal(id),
			preflightPath = `${m.root}/preflight-${probeId}.json`;
		if (mode === "preflight") {
			await assertPackageAbsent(`${journal}/claim.json`);
			await assertPackageAbsent(`${journal}/installed.json`);
			await measureOfficeCodePackageExternal(m);
			await measureOfficeCodePackageInventory(m.verified.baseInstalledArtifacts, signal);
			const base = new Set(m.verified.baseInstalledArtifacts.map((a) => a.path));
			for (const a of m.verified.changedArtifacts) {
				if (!base.has(a.path)) await assertPackageAbsent(a.path);
				const staged = (await readPackageFile(`${m.root}/artifacts/${a.file}`, a.bytes, 0o400)).bytes;
				if (staged.length !== a.bytes || packageHash(staged) !== a.sha256) throw new Error("CODE_PACKAGE_STAGING");
			}
			await packageDirectory("/etc/qorpera-office/code-packages", 0o700, true);
			await packageDirectory(journal, 0o700, true);
			await fresh.verify();
			const probe: OfficeCodePackageProbe = {
				schema: "qorpera.office-code-package-probe/v1",
				purpose: "install",
				probeId,
				provisionId: id,
				packetSha256: packetSha,
				bootId: command.bootId,
				challengeId: m.request.challengeId,
				nonce: randomUUID(),
				monotonicNs: String(process.hrtime.bigint()),
			};
			await claimPackageFile(preflightPath, packageEncode(probe));
			process.stdout.write(`${officeCanonical(probe)}\n`);
			return probe;
		}
		const probe = parseOfficeCodePackageProbe(
			packageDecode((await readPackageFile(preflightPath, 4096, 0o400)).bytes),
		);
		if (
			probe.purpose !== "install" ||
			probe.probeId !== probeId ||
			probe.provisionId !== id ||
			probe.packetSha256 !== packetSha ||
			probe.bootId !== command.bootId ||
			probe.challengeId !== m.request.challengeId ||
			!/^[1-9][0-9]{0,3}$/.test(lifetime)
		)
			throw new Error("CODE_PACKAGE_PROBE_BINDING");
		const assertDeadline = officeCodePackageDeadline(probe, nonce, Number(lifetime));
		const authorize = async () => {
			assertDeadline();
			await fresh.verify();
			assertDeadline();
		};
		await authorize();
		await packageDirectory(journal, 0o700);
		await assertPackageAbsent(`${journal}/claim.json`);
		await assertPackageAbsent(`${journal}/installed.json`);
		const stamps = await measureOfficeCodePackageInventory(m.verified.baseInstalledArtifacts, signal);
		const previous = new Map(stamps.map((s) => [s.path, s.stamp]));
		const candidates = new Map<string, Buffer>();
		for (const a of m.verified.changedArtifacts) {
			const bytes = (await readPackageFile(`${m.root}/artifacts/${a.file}`, a.bytes, 0o400)).bytes;
			if (bytes.length !== a.bytes || packageHash(bytes) !== a.sha256) throw new Error("CODE_PACKAGE_STAGING");
			if (!previous.has(a.path)) await assertPackageAbsent(a.path);
			candidates.set(a.file, bytes);
		}
		await authorize();
		await measureOfficeCodePackageExternal(m);
		assertDeadline();
		const claim = {
			schema: "qorpera.office-code-package-install-claim/v1",
			requestSha256: officeDigest(m.request),
			packetSha256: packetSha,
			probe,
		};
		await claimPackageFile(`${journal}/claim.json`, packageEncode(claim));
		for (const a of m.verified.changedArtifacts) {
			await replacePackageCode(
				a.file,
				candidates.get(a.file)!,
				previous.get(a.path) ?? null,
				authorize,
				assertDeadline,
			);
		}
		assertDeadline();
		await measureOfficeCodePackageInventory(m.verified.targetInstalledArtifacts, signal);
		const changed = new Set(m.verified.changedArtifacts.map((a) => a.path));
		await assertPackageInventoryStamps(stamps.filter((s) => !changed.has(s.path)));
		await authorize();
		const receipt = officeCodePackageReceipt(m);
		assertDeadline();
		await claimPackageFile(`${journal}/installed.json`, packageEncode(receipt));
		assertDeadline();
		process.stdout.write(`${officeCanonical(receipt)}\n`);
		return receipt;
	} finally {
		await fresh.close();
	}
}
