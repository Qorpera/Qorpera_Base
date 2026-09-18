import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import { publish } from "../src/lxd-office-journal-files.ts";
import { LxdOfficeLifecycleJournal } from "../src/lxd-office-lifecycle-journal.ts";
import {
	type LxdOfficePreparationIdentity,
	LxdOfficePreparationJournal,
} from "../src/lxd-office-preparation-journal.ts";
import { LxdOfficePreparationWorker } from "../src/lxd-office-preparation-worker.ts";
import { createOfficeActivationWorkerFixture } from "./fixtures/office-activation-worker.ts";
import { createOfficeBootActivationWorkerFixture } from "./fixtures/office-boot-activation-worker.ts";
import { createOfficeBootConfigurationWorkerFixture } from "./fixtures/office-boot-configuration-worker.ts";
import { officeConfigurationWorkerFixture } from "./fixtures/office-configuration-worker.ts";
import { createOfficePowerOffWorkerFixture } from "./fixtures/office-power-off-worker.ts";
import { createOfficeResumeWorkerFixture } from "./fixtures/office-resume-worker.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";
import { createOfficeStopWorkerFixture } from "./fixtures/office-stop-worker.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function recoveredConfiguration() {
	const f = await officeConfigurationWorkerFixture(roots, false);
	const poll = vi.mocked(f.client.inspectOfficePreparation);
	poll.mockImplementation(async (reference) => {
		if (reference.operationId === id(20)) throw new Error("original operation expired");
		return "succeeded";
	});
	const worker = new LxdOfficePreparationWorker(
		{ policy: f.policy, check: f.check },
		{ call: f.call },
		{ client: f.client, kernelLock: f.kernelLock, readProtected: f.readProtected },
	);
	expect((await worker.reconcile(f.request, signal())).state).toBe("unknown");
	const originalDirectory = join(f.root, f.preparation.names.journal);
	const original = await readFile(join(originalDirectory, "000001.json"));
	const { schema: _schema, ...identity } = JSON.parse(
		await readFile(join(originalDirectory, "authority.json"), "utf8"),
	) as LxdOfficePreparationIdentity & { schema: string };
	const review = {
		schema: "qorpera.lxd-office-preparation-recovery/v1",
		recoveryId: id(50),
		identitySha256: officeDigest(identity),
		originalOperationId: id(20),
		acceptedSha256: createHash("sha256").update(original).digest("hex"),
	};
	const recoveryRoot = join(f.root, `preparation-recovery-${f.binding.allocationId}-${review.recoveryId}`);
	await mkdir(recoveryRoot, { mode: 0o700 });
	const previous = f.preparation.exec.getMockImplementation()!;
	f.preparation.exec.mockImplementation(async (...args) => ({ ...(await previous(...args)), operationId: id(29) }));
	const journal = await LxdOfficePreparationJournal.open(recoveryRoot, identity, f.client, false);
	expect((await journal.reconcile(signal())).state).toBe("succeeded");
	const read = f.readProtected.getMockImplementation()!;
	f.readProtected.mockImplementation(async (path) =>
		path === `${f.request.reviewPath}.preparation-recovery` ? Buffer.from(JSON.stringify(review)) : read(path),
	);
	expect((await worker.reconcile(f.request, signal())).state).toBe("awaiting_activation");
	await f.worker.reconcile(f.request, signal());
	// The real supervisor retains this forward-only request before activation.
	await publish(
		f.root,
		`lifecycle-${f.request.intentId}-0.json`,
		Buffer.from(
			officeCanonical({
				schema: "qorpera.lxd-office-lifecycle-phase/v1",
				intentId: f.request.intentId,
				configurationSha256: "a".repeat(64),
				phase: "creation",
				previousSha256: null,
				context: { allocationId: null, observationSha256: null, request: null },
			}),
		),
	);
	const lifecycle = await LxdOfficeLifecycleJournal.open(f.root, f.request.intentId, "a".repeat(64), true);
	await lifecycle.advance({ allocationId: f.binding.allocationId, observationSha256: null, request: null });
	await lifecycle.advance({
		allocationId: f.binding.allocationId,
		observationSha256: f.request.observationSha256,
		request: null,
	});
	await lifecycle.advance({
		allocationId: f.binding.allocationId,
		observationSha256: f.request.observationSha256,
		request: f.request,
	});
	while (lifecycle.phase !== "activation") await lifecycle.advance();
	return { f, review, recoveryRoot, original, originalDirectory };
}

it.each(["intact", "review-changed", "lifecycle-missing"])(
	"validates preparation recovery across activation, shutdown and a later boot: %s",
	async (fault) => {
		const { f, review, original, originalDirectory } = await recoveredConfiguration();
		const activation = createOfficeActivationWorkerFixture(f);
		expect((await activation.worker.reconcile(f.request, signal())).state).toBe("active");
		const stop = { ...activation, ...(await createOfficeStopWorkerFixture(activation, "power_off")), activation };
		await stop.worker.reconcile(f.request.intentId, stop.request, signal());
		const power = await createOfficePowerOffWorkerFixture(stop);
		await power.run();
		const resume = await createOfficeResumeWorkerFixture(power);
		await resume.run();
		const configuration = await createOfficeBootConfigurationWorkerFixture(resume);
		await configuration.run();
		const boot = await createOfficeBootActivationWorkerFixture(configuration);
		if (fault === "review-changed") review.identitySha256 = "0".repeat(64);
		if (fault === "lifecycle-missing") await unlink(join(f.root, `lifecycle-${f.request.intentId}-7.json`));
		if (fault === "intact") {
			expect((await boot.run()).state).toBe("active");
			expect((await boot.run()).state).toBe("active");
		} else {
			await expect(boot.run()).rejects.toThrow("UNCONFIRMED");
			expect(boot.exec).not.toHaveBeenCalled();
		}
		expect(f.preparation.exec).toHaveBeenCalledTimes(2);
		expect(await readFile(join(originalDirectory, "000001.json"))).toEqual(original);
		expect(await readdir(originalDirectory)).not.toContain("000002.json");
	},
);

it.each(["review", "identity", "missing-journal"])(
	"refuses initial activation after recovery evidence changes: %s",
	async (fault) => {
		const { f, review, recoveryRoot } = await recoveredConfiguration();
		if (fault === "review") review.acceptedSha256 = "0".repeat(64);
		if (fault === "identity") review.identitySha256 = "0".repeat(64);
		if (fault === "missing-journal") await unlink(join(recoveryRoot, f.preparation.names.journal, "000002.json"));
		if (fault === "missing-journal")
			vi.mocked(f.client.inspectOfficePreparation).mockRejectedValue(new Error("expired"));
		const activation = createOfficeActivationWorkerFixture(f);
		await expect(activation.worker.reconcile(f.request, signal())).rejects.toThrow("OFFICE_ACTIVATION_UNCONFIRMED");
		expect(activation.exec).not.toHaveBeenCalled();
		expect(f.preparation.exec).toHaveBeenCalledTimes(2);
	},
);
