import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	companyComputerServiceSoftwareMeasurementText,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceSoftwareInvocationChallenge,
} from "../../packages/contracts/src/index.ts";
import { verifyLxdOfficeCodePackageProvisionReceipt } from "../../packages/runner-orchestrator/src/lxd-office-code-package-provision-verification.ts";
import {
	officeCanonical,
	officeDigest,
	officeRecord,
	officeSha,
} from "../../packages/runner-orchestrator/src/lxd-office-image-provenance.ts";
import { assertCompanyComputerPreparationLockAndBoot } from "../../packages/runtime/src/cloud-company-computer-preparation-control.ts";
import { measureCompanyComputerServiceSoftware } from "../../packages/runtime/src/cloud-company-computer-service-software-measurement.ts";
import {
	type OfficeCodePackageProbe,
	officeCodePackageDeadline,
	parseOfficeCodePackageProbe,
} from "./office-code-package-control.ts";
import {
	assertPackageInventoryStamps,
	assertPackageStamp,
	claimPackageFile,
	packageHash,
	packageMissing,
	readPackageFile,
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

/** Independent observation/actual-invocation measurement. No code write,
 * service start, SQL call, capability or installation replay is possible. */
export async function runOfficeCodePackageTool(purpose: string, id: string, args: readonly string[]) {
	const [mode, packetSha, trustSha, challengeId, nonceOrBoot, lifetime, challengeSha] = args;
	if (
		purpose !== "measure" ||
		!["probe", "observation", "invocation"].includes(mode) ||
		args.length !== (mode === "probe" ? 5 : 7)
	)
		throw new Error("CODE_PACKAGE_MEASURE_ARGUMENTS");
	const m = await loadOfficeCodePackageMaterial(id, packetSha, trustSha),
		signal = AbortSignal.timeout(110000);
	parseCompanyComputerPreparationCommand({
		commandId: challengeId,
		requestSha256: packetSha,
		bootId: m.request.bootId,
	});
	const probePath = `${m.root}/probe-${challengeId}.json`;
	if (mode === "probe") {
		const command = parseCompanyComputerPreparationCommand({ ...packageCommand(m), bootId: nonceOrBoot });
		await assertCompanyComputerPreparationLockAndBoot(command);
		const probe: OfficeCodePackageProbe = {
			schema: "qorpera.office-code-package-probe/v1",
			purpose: "measure",
			probeId: challengeId,
			provisionId: id,
			packetSha256: packetSha,
			bootId: command.bootId,
			challengeId,
			nonce: randomUUID(),
			monotonicNs: String(process.hrtime.bigint()),
		};
		await claimPackageFile(probePath, packageEncode(probe));
		process.stdout.write(`${officeCanonical(probe)}\n`);
		return probe;
	}
	const probe = parseOfficeCodePackageProbe(packageDecode((await readPackageFile(probePath, 4096, 0o400)).bytes));
	if (
		probe.purpose !== "measure" ||
		probe.probeId !== challengeId ||
		probe.challengeId !== challengeId ||
		probe.provisionId !== id ||
		probe.packetSha256 !== packetSha ||
		!/^[1-9][0-9]{0,3}$/.test(lifetime)
	)
		throw new Error("CODE_PACKAGE_MEASURE_PROBE");
	const assertDeadline = officeCodePackageDeadline(probe, nonceOrBoot, Number(lifetime));
	assertDeadline();
	const command = packageCommand(m, probe.bootId);
	await assertCompanyComputerPreparationLockAndBoot(command);
	const challengeBytes = (await readPackageFile(`${m.root}/challenge-${challengeId}.json`, 65536, 0o400)).bytes;
	if (packageHash(challengeBytes) !== officeSha(challengeSha)) throw new Error("CODE_PACKAGE_MEASURE_CHALLENGE");
	const challengeValue = packageDecode(challengeBytes);
	const journal = packageJournal(id);
	const claimBytes = (await readPackageFile(`${journal}/claim.json`, 16384, 0o400)).bytes;
	const installClaim = officeRecord(packageDecode(claimBytes), ["schema", "requestSha256", "packetSha256", "probe"]);
	if (!claimBytes.equals(packageEncode(installClaim))) throw new Error("CODE_PACKAGE_INSTALL_CLAIM_ENCODING");
	const installProbe = parseOfficeCodePackageProbe(installClaim.probe);
	if (
		installClaim.schema !== "qorpera.office-code-package-install-claim/v1" ||
		installClaim.requestSha256 !== officeDigest(m.request) ||
		installClaim.packetSha256 !== packetSha ||
		installProbe.provisionId !== id ||
		installProbe.bootId !== m.request.bootId ||
		installProbe.purpose !== "install" ||
		installProbe.packetSha256 !== packetSha ||
		installProbe.challengeId !== m.request.challengeId
	)
		throw new Error("CODE_PACKAGE_INSTALL_CLAIM");
	let installedFile: Awaited<ReturnType<typeof readPackageFile>> | undefined;
	try {
		installedFile = await readPackageFile(`${journal}/installed.json`, 65536, 0o400);
	} catch (error) {
		if (mode !== "observation" || !packageMissing(error)) throw error;
	}
	const receipt = verifyLxdOfficeCodePackageProvisionReceipt(
		installedFile ? packageDecode(installedFile.bytes) : officeCodePackageReceipt(m),
		m.request,
		m.verified,
	);
	if (installedFile && !installedFile.bytes.equals(packageEncode(receipt)))
		throw new Error("CODE_PACKAGE_RECEIPT_ENCODING");
	const receiptSha256 = officeDigest(receipt);
	let fresh: Awaited<ReturnType<typeof openOfficeCodePackageFreshRoot>> | undefined;
	try {
		let output: Record<string, unknown>;
		const outputPath = `${m.root}/${mode}-${challengeId}.json`;
		if (mode === "observation") {
			const c = officeRecord(challengeValue, [
				"schema",
				"provisionId",
				"observationId",
				"request",
				"requestSha256",
				"statement",
				"targetRevision",
				"capabilityRevision",
				"validForMs",
			]);
			if (
				c.schema !== "qorpera.office-code-package-observation-challenge/v1" ||
				c.provisionId !== id ||
				c.observationId !== challengeId ||
				!isDeepStrictEqual(c.request, m.request) ||
				c.requestSha256 !== officeDigest(m.request) ||
				!isDeepStrictEqual(c.statement, m.verified.statement) ||
				c.targetRevision !== m.request.targetRevision ||
				c.capabilityRevision !== m.request.capabilityRevision ||
				c.validForMs !== Number(lifetime) ||
				probe.bootId !== m.request.bootId
			)
				throw new Error("CODE_PACKAGE_OBSERVATION_BINDING");
			fresh = await openOfficeCodePackageFreshRoot(m, signal);
			assertDeadline();
			await claimPackageFile(
				`${m.root}/measurement-claim-${challengeId}.json`,
				packageEncode({
					schema: "qorpera.office-code-package-measurement-claim/v1",
					mode,
					challengeSha256: challengeSha,
					probe,
				}),
			);
			await measureOfficeCodePackageInventory(m.verified.targetInstalledArtifacts, signal);
			await fresh.verify();
			output = {
				schema: "qorpera.office-code-package-observation/v1",
				observationId: challengeId,
				provisionId: id,
				requestSha256: officeDigest(m.request),
				receipt,
				receiptSha256,
				inventorySha256: m.verified.inventorySha256,
			};
		} else {
			const c = officeRecord(challengeValue, [
				"schema",
				"challengeId",
				"activationId",
				"startup",
				"provisionId",
				"planSha256",
				"revision",
				"receiptSha256",
				"installedInventorySha256",
				"service",
				"runtimeBundle",
				"capabilityRevision",
				"validForMs",
			]);
			if (
				c.schema !== "qorpera.office-code-package-invocation-challenge/v1" ||
				c.challengeId !== challengeId ||
				c.provisionId !== id ||
				c.planSha256 !== m.verified.planSha256 ||
				c.revision !== receipt.targetRevision ||
				c.receiptSha256 !== receiptSha256 ||
				c.installedInventorySha256 !== m.verified.inventorySha256 ||
				!isDeepStrictEqual(c.service, m.verified.statement.target.service) ||
				!isDeepStrictEqual(c.runtimeBundle, m.verified.statement.target.runtimeBundle) ||
				c.validForMs !== Number(lifetime)
			)
				throw new Error("CODE_PACKAGE_INVOCATION_BINDING");
			// Reuse only the physical measurement implementation. This projection
			// does not enroll, acknowledge or authorize a service-only revision.
			const physical = parseCompanyComputerServiceSoftwareInvocationChallenge({
				schema: "qorpera.office-software-invocation-challenge/v1",
				challengeId,
				activationId: c.activationId,
				startup: c.startup,
				revision: c.revision,
				capabilityRevision: c.capabilityRevision,
				service: c.service,
				validForMs: c.validForMs,
			});
			if (
				physical.startup.bootId !== probe.bootId ||
				physical.startup.allocationId !== m.original.allocationId ||
				physical.startup.imageSha256 !== m.original.imageSha256 ||
				physical.startup.bootstrapSha256 !== m.original.bootstrapSha256 ||
				physical.startup.instanceSha256 !== m.original.instanceSha256 ||
				!isDeepStrictEqual(physical.startup.scope, m.original.scope) ||
				physical.startup.computerGeneration !== m.original.computerGeneration
			)
				throw new Error("CODE_PACKAGE_INVOCATION_STARTUP");
			assertDeadline();
			await claimPackageFile(
				`${m.root}/measurement-claim-${challengeId}.json`,
				packageEncode({
					schema: "qorpera.office-code-package-measurement-claim/v1",
					mode,
					challengeSha256: challengeSha,
					probe,
				}),
			);
			const before = await measureOfficeCodePackageInventory(m.verified.targetInstalledArtifacts, signal);
			const measured = await measureCompanyComputerServiceSoftware(
				{ ...command, requestSha256: packageHash(companyComputerServiceSoftwareMeasurementText(physical)) },
				physical,
				signal,
			);
			await assertPackageInventoryStamps(before);
			output = {
				schema: "qorpera.office-code-package-invocation/v1",
				challengeId,
				provisionId: id,
				activationId: c.activationId,
				startup: physical.startup,
				receiptSha256,
				inventorySha256: m.verified.inventorySha256,
				service: physical.service,
				runtimeBundle: m.verified.statement.target.runtimeBundle,
				evidence: measured.evidence,
			};
		}
		assertDeadline();
		await measureOfficeCodePackageExternal(m);
		assertDeadline();
		await m.verifyMaterial();
		if (!installedFile) {
			// Complete target plus the original claim may recover only a missing
			// receipt. Partial code and corrupt existing records stay fenced.
			await fresh!.verify();
			assertDeadline();
			await claimPackageFile(`${journal}/installed.json`, packageEncode(receipt));
			installedFile = await readPackageFile(`${journal}/installed.json`, 65536, 0o400);
		}
		await assertPackageStamp(`${journal}/installed.json`, installedFile.stamp);
		if (!(await readPackageFile(`${journal}/claim.json`, claimBytes.length, 0o400)).bytes.equals(claimBytes))
			throw new Error("CODE_PACKAGE_INSTALL_CLAIM_CHANGED");
		await assertCompanyComputerPreparationLockAndBoot(command);
		assertDeadline();
		const result = { ...output, evidenceSha256: officeDigest(output) };
		await claimPackageFile(outputPath, packageEncode(result));
		assertDeadline();
		process.stdout.write(`${officeCanonical(result)}\n`);
		return result;
	} finally {
		await fresh?.close();
	}
}
