import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import {
	type NodeUpdateEnrollment,
	type NodeUpdatePorts,
	RuntimeNodeUpdateController,
	verifyNodeUpdateRelease,
} from "./runtime-node-update.ts";

const refuse = async (): Promise<never> => {
	throw new Error("NODE_UPDATE_COMPLETION_INCOMPLETE");
};
const completedOnly: NodeUpdatePorts = {
	observe: refuse,
	prepare: refuse,
	publish: refuse,
	execute: refuse,
	inspect: refuse,
};
async function optional(path: string) {
	return readRecord(path).catch((error) => {
		if (code(error, "ENOENT")) return null;
		throw error;
	});
}

/** Must run under the enrolled root kernel lock. Remote state never advances
 * the predecessor: each step is authenticated by its locally retained signed
 * envelope and all eight completed/published controller phases. An incomplete
 * resume keeps its original predecessor enrollment for explicit backend reads. */
export async function selectNodeUpdateJournal(
	root: string,
	initial: Readonly<NodeUpdateEnrollment>,
	desired: (enrollment: Readonly<NodeUpdateEnrollment>, signal: AbortSignal) => Promise<unknown | null>,
	signal: AbortSignal,
) {
	await checkDirectory(root);
	const baseline = Buffer.from(`${officeCanonical(initial)}\n`);
	await publish(root, "baseline.json", baseline);
	if (!(await readRecord(join(root, "baseline.json"))).bytes.equals(baseline))
		throw new Error("NODE_UPDATE_BASELINE_CHANGED");
	let enrollment = { ...initial };
	for (let history = 0; history < 1024; history++) {
		signal.throwIfAborted();
		const revisionRoot = join(root, `revision-${enrollment.previousRevision + 1}`);
		const exists = await checkDirectory(revisionRoot)
			.then(() => true)
			.catch((error) => {
				if (code(error, "ENOENT")) return false;
				throw error;
			});
		let encoded = exists ? await optional(join(revisionRoot, "envelope.json")) : null;
		if (!encoded) {
			if (exists && (await readdir(revisionRoot)).length !== 0) throw new Error("NODE_UPDATE_ENVELOPE_MISSING");
			const envelope = await desired(enrollment, signal);
			if (envelope === null) return null;
			verifyNodeUpdateRelease(envelope, enrollment);
			if (!exists) {
				await mkdir(revisionRoot, { mode: 0o700 });
				await syncDirectory(root);
			}
			await checkDirectory(revisionRoot);
			await publish(revisionRoot, "envelope.json", Buffer.from(`${officeCanonical(envelope)}\n`));
			encoded = await readRecord(join(revisionRoot, "envelope.json"));
		}
		const envelope: unknown = encoded.value,
			release = verifyNodeUpdateRelease(envelope, enrollment),
			completion = await optional(join(revisionRoot, "completion.json"));
		if (!completion) return { root: revisionRoot, envelope, release, enrollment };
		const c = officeRecord(completion.value, ["schema", "releaseSha256", "lastReceiptSha256"]);
		if (
			c.schema !== "qorpera.node-update-completion/v1" ||
			c.releaseSha256 !== officeDigest(release) ||
			c.lastReceiptSha256 !== officeDigest((await readRecord(join(revisionRoot, "resume-result.json"))).value) ||
			(await new RuntimeNodeUpdateController(revisionRoot, envelope, enrollment, completedOnly).reconcile(signal))
				.state !== "completed"
		)
			throw new Error("NODE_UPDATE_COMPLETION_INVALID");
		enrollment = {
			...enrollment,
			previousRevision: release.revision,
			previousReleaseSha256: officeDigest(release),
			previousArtifactSha256: release.artifact.sha256,
		};
	}
	throw new Error("NODE_UPDATE_HISTORY_LIMIT_REACHED");
}

export async function sealNodeUpdateCompletion(
	root: string,
	envelope: unknown,
	enrollment: Readonly<NodeUpdateEnrollment>,
	signal: AbortSignal,
): Promise<void> {
	const release = verifyNodeUpdateRelease(envelope, enrollment);
	if (
		(await new RuntimeNodeUpdateController(root, envelope, enrollment, completedOnly).reconcile(signal)).state !==
		"completed"
	)
		throw new Error("NODE_UPDATE_COMPLETION_INCOMPLETE");
	const completion = {
			schema: "qorpera.node-update-completion/v1",
			releaseSha256: officeDigest(release),
			lastReceiptSha256: officeDigest((await readRecord(join(root, "resume-result.json"))).value),
		},
		bytes = Buffer.from(`${officeCanonical(completion)}\n`);
	await publish(root, "completion.json", bytes);
	if (!(await readRecord(join(root, "completion.json"))).bytes.equals(bytes))
		throw new Error("NODE_UPDATE_COMPLETION_CONFLICT");
}
