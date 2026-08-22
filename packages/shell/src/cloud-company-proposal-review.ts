import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { mergeCloudCompanySnapshotsForReview } from "./cloud-company-merge.ts";
import {
	type CloudCompanyTreeEntry,
	captureCloudCompanyTree,
	currentCloudCompanyTreeReference,
	materializeCloudCompanyTree,
	readCloudCompanyTreeManifest,
} from "./cloud-company-snapshot.ts";
import { publishCompanySnapshotRestoreProof } from "./cloud-object-reachability.ts";
import type { CloudContentAddressedStore } from "./cloud-object-store.ts";
import type { HostedCompanyProposal, HostedCompanySnapshot, QorperaHostedPrimary } from "./hosted-primary.ts";

const REVIEW_SCHEMA = "qorpera.cloud-company-proposal-review/v2";
const CONFLICT_REVIEW_SCHEMA = "qorpera.cloud-company-conflict-review/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface ProposalReviewState {
	schema: typeof REVIEW_SCHEMA;
	profileId: string;
	environmentId: string;
	proposalId: string;
	proposalSnapshotId: string;
	headSnapshotId: string;
	conflictCount: number;
	conflicts: ProposalReviewConflict[];
	createdAt: string;
	pending?: {
		clientRevisionId: string;
		tree: ReturnType<typeof currentCloudCompanyTreeReference>;
	};
}

interface ProposalReviewConflict {
	id: string;
	path: string;
	reason: "both-changed" | "structural";
}

export interface PrepareCompanyProposalReviewInput {
	userData: string;
	profileId: string;
	environmentId: string;
	proposal: HostedCompanyProposal;
	head: HostedCompanySnapshot;
	primary: QorperaHostedPrimary;
	objects: CloudContentAddressedStore;
}

export interface PreparedCompanyProposalReview {
	path: string;
	companyFilePath: string;
	conflictCount: number;
	hasUnresolvedConflicts: boolean;
	existing: boolean;
}

function proposalRoot(userData: string, profileId: string, proposalId: string): string {
	const parent = resolve(userData, "cloud-company-proposal-reviews");
	const key = createHash("sha256").update(`${profileId}:${proposalId}`).digest("hex").slice(0, 32);
	const result = resolve(parent, key);
	if (!result.startsWith(`${parent}${process.platform === "win32" ? "\\" : "/"}`)) {
		throw new Error("Company proposal review path escaped its owned directory");
	}
	return result;
}

function reviewRoot(input: PrepareCompanyProposalReviewInput): string {
	const key = createHash("sha256")
		.update(`${input.proposal.proposalSnapshot.snapshotId}:${input.head.snapshotId}`)
		.digest("hex")
		.slice(0, 32);
	return join(proposalRoot(input.userData, input.profileId, input.proposal.proposalId), key);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function sameTree(
	left: ReturnType<typeof currentCloudCompanyTreeReference>,
	right: ReturnType<typeof currentCloudCompanyTreeReference>,
): boolean {
	return (
		left.manifestSha256 === right.manifestSha256 &&
		left.manifestBytes === right.manifestBytes &&
		left.contractVersion === right.contractVersion &&
		left.fileCount === right.fileCount &&
		left.totalBytes === right.totalBytes
	);
}

function parseState(value: unknown, input: PrepareCompanyProposalReviewInput): ProposalReviewState {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Company proposal review state is invalid");
	}
	const state = value as Partial<ProposalReviewState>;
	if (
		state.schema !== REVIEW_SCHEMA ||
		state.profileId !== input.profileId ||
		state.environmentId !== input.environmentId ||
		state.proposalId !== input.proposal.proposalId ||
		state.proposalSnapshotId !== input.proposal.proposalSnapshot.snapshotId ||
		state.headSnapshotId !== input.head.snapshotId ||
		!Number.isSafeInteger(state.conflictCount) ||
		(state.conflictCount ?? -1) < 0 ||
		!Array.isArray(state.conflicts) ||
		state.conflicts.length !== state.conflictCount ||
		state.conflicts.some(
			(conflict) =>
				!conflict ||
				typeof conflict !== "object" ||
				!/^[0-9a-f]{16}$/.test(conflict.id) ||
				typeof conflict.path !== "string" ||
				conflict.path.length < 1 ||
				(conflict.reason !== "both-changed" && conflict.reason !== "structural"),
		) ||
		typeof state.createdAt !== "string" ||
		!Number.isFinite(Date.parse(state.createdAt))
	) {
		throw new Error("Company proposal review state does not match this immutable review");
	}
	if (new Set(state.conflicts.map((conflict) => conflict.id)).size !== state.conflicts.length) {
		throw new Error("Company proposal review conflict identities are invalid");
	}
	if (
		state.pending &&
		(!UUID_PATTERN.test(state.pending.clientRevisionId) ||
			!SHA256_PATTERN.test(state.pending.tree.manifestSha256) ||
			!Number.isSafeInteger(state.pending.tree.manifestBytes) ||
			state.pending.tree.manifestBytes < 1 ||
			state.pending.tree.contractVersion !== 3 ||
			!Number.isSafeInteger(state.pending.tree.fileCount) ||
			state.pending.tree.fileCount < 0 ||
			!Number.isSafeInteger(state.pending.tree.totalBytes) ||
			state.pending.tree.totalBytes < 0)
	) {
		throw new Error("Company proposal review pending revision is invalid");
	}
	return state as ProposalReviewState;
}

async function writeState(path: string, state: ProposalReviewState): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf-8", flag: "wx" });
	await rename(temporary, path);
}

async function readState(
	path: string,
	input: PrepareCompanyProposalReviewInput,
): Promise<ProposalReviewState | undefined> {
	try {
		return parseState(JSON.parse(await readFile(path, "utf-8")) as unknown, input);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function reviewPaths(input: PrepareCompanyProposalReviewInput): {
	root: string;
	work: string;
	state: string;
	conflictReview: string;
	conflictSentinel: string;
	unresolved: string;
} {
	const root = reviewRoot(input);
	const work = join(root, "Company File");
	const conflictReview = join(root, "Conflict Review");
	return {
		root,
		work,
		state: join(root, "review.json"),
		conflictReview,
		conflictSentinel: join(conflictReview, "Unresolved", "KEEP THIS FOLDER.txt"),
		unresolved: join(conflictReview, "Unresolved"),
	};
}

function conflictId(path: string, reason: ProposalReviewConflict["reason"]): string {
	return createHash("sha256").update(`${reason}\0${path}`).digest("hex").slice(0, 16);
}

function conflictMarkerPath(paths: ReturnType<typeof reviewPaths>, conflict: ProposalReviewConflict): string {
	return join(paths.unresolved, `${conflict.id}.json`);
}

function entryDescription(entry: CloudCompanyTreeEntry | undefined): Record<string, unknown> {
	if (!entry) return { kind: "missing" };
	if (entry.kind === "directory") return { kind: "directory" };
	return {
		kind: "file",
		bytes: entry.file.bytes,
		sha256: entry.file.fileSha256,
		executable: entry.executable,
	};
}

async function writeConflictEntryEvidence(
	directory: string,
	label: "ancestor" | "proposal" | "current",
	entry: CloudCompanyTreeEntry | undefined,
	profileId: string,
	objects: CloudContentAddressedStore,
): Promise<void> {
	if (entry?.kind === "file") {
		await writeFile(join(directory, `${label}.bin`), await objects.getFile(profileId, entry.file), { flag: "wx" });
		return;
	}
	await writeFile(join(directory, `${label}.txt`), `${entry ? "directory" : "missing"}\n`, {
		encoding: "utf-8",
		flag: "wx",
	});
}

async function materializeConflictReview(
	input: PrepareCompanyProposalReviewInput,
	paths: ReturnType<typeof reviewPaths>,
	conflicts: ProposalReviewConflict[],
	ancestorSnapshotId: string,
): Promise<void> {
	if (conflicts.length === 0) return;
	const ancestor = await input.primary.getCompanySnapshot(ancestorSnapshotId);
	const [ancestorManifest, proposalManifest, currentManifest] = await Promise.all([
		readCloudCompanyTreeManifest(input.profileId, currentCloudCompanyTreeReference(ancestor.tree), input.objects),
		readCloudCompanyTreeManifest(
			input.profileId,
			currentCloudCompanyTreeReference(input.proposal.proposalSnapshot.tree),
			input.objects,
		),
		readCloudCompanyTreeManifest(input.profileId, currentCloudCompanyTreeReference(input.head.tree), input.objects),
	]);
	const ancestorEntries = new Map(ancestorManifest.entries.map((entry) => [entry.path, entry]));
	const proposalEntries = new Map(proposalManifest.entries.map((entry) => [entry.path, entry]));
	const currentEntries = new Map(currentManifest.entries.map((entry) => [entry.path, entry]));
	await mkdir(paths.unresolved, { recursive: true });
	await writeFile(
		join(paths.conflictReview, "README.txt"),
		[
			"Resolve each listed path in the Company File folder.",
			"Each JSON marker describes the ancestor, proposed, and current cloud state.",
			"After resolving one path, delete only its matching JSON marker from Unresolved.",
			"Keep KEEP THIS FOLDER.txt. Submit revision is blocked while any JSON marker remains.",
			"",
		].join("\n"),
		{ encoding: "utf-8", flag: "wx" },
	);
	await writeFile(paths.conflictSentinel, "Required review integrity marker. Do not delete.\n", {
		encoding: "utf-8",
		flag: "wx",
	});
	for (const conflict of conflicts) {
		const ancestorEntry = ancestorEntries.get(conflict.path);
		const proposalEntry = proposalEntries.get(conflict.path);
		const currentEntry = currentEntries.get(conflict.path);
		const evidence = join(paths.conflictReview, "Evidence", conflict.id);
		await mkdir(evidence, { recursive: true });
		await Promise.all([
			writeConflictEntryEvidence(evidence, "ancestor", ancestorEntry, input.profileId, input.objects),
			writeConflictEntryEvidence(evidence, "proposal", proposalEntry, input.profileId, input.objects),
			writeConflictEntryEvidence(evidence, "current", currentEntry, input.profileId, input.objects),
		]);
		await writeFile(
			conflictMarkerPath(paths, conflict),
			`${JSON.stringify({
				schema: CONFLICT_REVIEW_SCHEMA,
				id: conflict.id,
				path: conflict.path,
				reason: conflict.reason,
				ancestor: entryDescription(ancestorEntry),
				proposal: entryDescription(proposalEntry),
				current: entryDescription(currentEntry),
			})}\n`,
			{ encoding: "utf-8", flag: "wx" },
		);
	}
}

async function hasUnresolvedConflictReview(
	paths: ReturnType<typeof reviewPaths>,
	state: ProposalReviewState,
): Promise<boolean> {
	if (state.conflicts.length === 0) return false;
	if (!(await pathExists(paths.conflictSentinel))) {
		throw new Error("Company proposal conflict review metadata is missing; reopen the review before publishing");
	}
	return (await Promise.all(state.conflicts.map((conflict) => pathExists(conflictMarkerPath(paths, conflict))))).some(
		Boolean,
	);
}

export async function prepareCompanyProposalReview(
	input: PrepareCompanyProposalReviewInput,
): Promise<PreparedCompanyProposalReview> {
	if (
		input.proposal.profileId !== input.profileId ||
		input.proposal.environmentId !== input.environmentId ||
		input.head.profileId !== input.profileId ||
		input.head.environmentId !== input.environmentId
	) {
		throw new Error("Company proposal review is outside this company");
	}
	const paths = reviewPaths(input);
	const existing = await readState(paths.state, input);
	if (existing) {
		if (!(await pathExists(paths.work))) throw new Error("Company proposal review folder is missing");
		return {
			path: paths.root,
			companyFilePath: paths.work,
			conflictCount: existing.conflictCount,
			hasUnresolvedConflicts: await hasUnresolvedConflictReview(paths, existing),
			existing: true,
		};
	}
	await rm(paths.root, { recursive: true, force: true });
	await mkdir(paths.root, { recursive: true });
	const staging = join(paths.root, `.staging-${randomUUID()}`);
	try {
		await materializeCloudCompanyTree(
			staging,
			input.profileId,
			currentCloudCompanyTreeReference(input.proposal.proposalSnapshot.tree),
			input.objects,
		);
		const initialized = spawnSync("git", ["-C", staging, "init", "--quiet", "--template="], {
			encoding: "utf-8",
			shell: false,
		});
		if (initialized.status !== 0) {
			throw new Error(`Company proposal review Git initialization failed: ${initialized.stderr.trim()}`);
		}
		const merged = await mergeCloudCompanySnapshotsForReview({
			companyRoot: staging,
			profileId: input.profileId,
			environmentId: input.environmentId,
			localSnapshotId: input.proposal.proposalSnapshot.snapshotId,
			remoteSnapshotId: input.head.snapshotId,
			primary: input.primary,
			objects: input.objects,
		});
		const conflicts = merged.plan.conflicts.map((conflict) => ({
			id: conflictId(conflict.path, conflict.reason),
			path: conflict.path,
			reason: conflict.reason,
		}));
		await rename(staging, paths.work);
		await materializeConflictReview(input, paths, conflicts, merged.plan.ancestorSnapshotId);
		await writeState(paths.state, {
			schema: REVIEW_SCHEMA,
			profileId: input.profileId,
			environmentId: input.environmentId,
			proposalId: input.proposal.proposalId,
			proposalSnapshotId: input.proposal.proposalSnapshot.snapshotId,
			headSnapshotId: input.head.snapshotId,
			conflictCount: conflicts.length,
			conflicts,
			createdAt: new Date().toISOString(),
		});
		return {
			path: paths.root,
			companyFilePath: paths.work,
			conflictCount: conflicts.length,
			hasUnresolvedConflicts: conflicts.length > 0,
			existing: false,
		};
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

export async function finalizeCompanyProposalReview(
	input: PrepareCompanyProposalReviewInput,
): Promise<HostedCompanyProposal> {
	const paths = reviewPaths(input);
	const state = await readState(paths.state, input);
	if (!state || !(await pathExists(paths.work))) throw new Error("Prepare the Company File merge review first");
	if (await hasUnresolvedConflictReview(paths, state)) {
		throw new Error(
			`Resolve the ${state.conflictCount} conflicting Company File path${state.conflictCount === 1 ? "" : "s"} and delete each resolved JSON marker, then publish again.`,
		);
	}
	const tree = await captureCloudCompanyTree(paths.work, input.profileId, input.objects, { userData: input.userData });
	const clientRevisionId =
		state.pending && sameTree(state.pending.tree, tree) ? state.pending.clientRevisionId : randomUUID();
	if (!state.pending || state.pending.clientRevisionId !== clientRevisionId) {
		state.pending = { clientRevisionId, tree };
		await writeState(paths.state, state);
	}
	const prepared = await input.primary.prepareCompanyFileProposal({
		environmentId: input.environmentId,
		clientRevisionId,
		baseSnapshotId: input.head.snapshotId,
		tree,
	});
	await publishCompanySnapshotRestoreProof(prepared, input.objects, input.primary);
	const proposal = await input.primary.rebaseCompanyProposal(
		input.proposal.proposalId,
		input.proposal.proposalSnapshot.snapshotId,
		input.head.snapshotId,
		prepared.snapshotId,
	);
	await rm(paths.root, { recursive: true, force: true });
	return proposal;
}

export async function discardCompanyProposalReviews(
	userData: string,
	profileId: string,
	proposalId: string,
): Promise<void> {
	await rm(proposalRoot(userData, profileId, proposalId), { recursive: true, force: true });
}
