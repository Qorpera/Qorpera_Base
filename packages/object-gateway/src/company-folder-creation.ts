import {
	COMPANY_STATE_COFOUNDER_HANDLE,
	COMPANY_STATE_PARSER_VERSION,
	type CompanyStateSeedEntry,
	companyStateSeedTree,
	parseCompanyStateFile,
} from "@qorpera/cloud-client/company-state-files";
import type { MemberCompanyAuthority } from "./member-company-authority.ts";
import { UUID } from "./native-objects.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import {
	drainPlatformClaims,
	type PlatformFileReference,
	PlatformFolderProblem,
	PlatformFolderWriter,
	platformFolderProblem,
	platformFolderProblemCode,
	record,
} from "./platform-folder-writer.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

/*
 * Company creation's worker (C2-create, P14b; deploy/first-node/RUNTIME-COMPANY-FOLDER-CREATION.md §2 step 3, §5).
 * Start records one creation (P14a); this worker claims one at a time, builds the seeded tree from the founders' input
 * (companyStateSeedTree, with the ids the creation row holds; the library's interfaces and tables draw new ids on each
 * attempt, which is safe since a creation commits whole and a completed one answers from its row), stages each file
 * as the platform, and calls qorpera_folder_company_create once: one transaction with the creation commit, the
 * Co-Founder and its silent first run. The database sorts the outcome (completed, failed, retry, stale); the worker
 * only backs off (release) or records a failure of its own (fail). A completed creation then kicks the follow-up queue
 * (P15), which gives the Co-Founder its default grant and queues its first-run turn. Built switched off: the gateway
 * runs it only with QORPERA_COMPANY_FOLDER_CREATOR=1.
 */

const CLAIM_KEYS = [
	"schema",
	"creationId",
	"profileId",
	"environmentId",
	"generation",
	"attempt",
	"leaseUntil",
	"operationKey",
	"cofounderId",
	"firstTodoId",
	"kickoffRequestedBy",
	"input",
] as const;
const INPUT_KEYS = ["schema", "companyName", "vision", "kickoffRequestedBy", "founders"] as const;
const FOUNDER_KEYS = ["userId", "displayName", "role"] as const;
const ANSWERS = new Set(["completed", "failed", "retry", "stale"]);
/** A seeded file's media type, by its extension: the state files are Markdown, interfaces and tables plain text. */
function mediaType(path: string): string {
	return path.endsWith(".md") ? "text/markdown" : "text/plain";
}
/** A claim, a release and a fail get their own short deadline, so a drain that ran out of time still closes a claim. */
const CALL_MS = 15_000;
/** The worker's own failures that no retry can fix (design §2 step 3): a seed tree the parser or a writer refuses,
 * or a staging refusal. Any other problem is retried after a back-off, an unreadable claim included: it can only mean
 * the gateway and the database disagree (a release between their deploys), which the next deploy mends. */
const FINAL = new Set(["seed_invalid", "stage_invalid"]);

export interface CompanyCreationClaim {
	readonly creationId: string;
	readonly environmentId: string;
	readonly generation: number;
	readonly cofounderId: string;
	readonly firstTodoId: string;
	readonly kickoffRequestedBy: string | null;
	readonly companyName: string;
	readonly vision: string;
	readonly founders: readonly { readonly userId: string; readonly displayName: string; readonly role: string }[];
}

/** A claim (`qorpera.company-creation-claim/v1`) as a closed record, or null when nothing is due. */
export function parseCompanyCreationClaim(value: unknown): CompanyCreationClaim | null {
	if (value === null) return null;
	const claim = record(value, CLAIM_KEYS, "claim_invalid");
	const input = record(claim.input, INPUT_KEYS, "claim_invalid");
	const founders = Array.isArray(input.founders)
		? input.founders.map((entry) => record(entry, FOUNDER_KEYS, "claim_invalid"))
		: platformFolderProblem("claim_invalid");
	const ids = [claim.creationId, claim.profileId, claim.environmentId, claim.cofounderId, claim.firstTodoId];
	if (
		claim.schema !== "qorpera.company-creation-claim/v1" ||
		input.schema !== "qorpera.company-seed-input/v1" ||
		!Number.isSafeInteger(claim.generation) ||
		(claim.generation as number) < 1 ||
		claim.operationKey !== `company-create:${claim.creationId}` ||
		typeof input.companyName !== "string" ||
		typeof input.vision !== "string" ||
		// The kickoff member is the input's (null when their account was deleted).
		(claim.kickoffRequestedBy !== null && claim.kickoffRequestedBy !== input.kickoffRequestedBy) ||
		![...ids, ...(claim.kickoffRequestedBy === null ? [] : [claim.kickoffRequestedBy])].every(
			(id) => typeof id === "string" && UUID.test(id),
		) ||
		founders.some(
			(founder) =>
				typeof founder.userId !== "string" ||
				!UUID.test(founder.userId) ||
				typeof founder.displayName !== "string" ||
				typeof founder.role !== "string",
		)
	)
		platformFolderProblem("claim_invalid");
	return {
		creationId: claim.creationId as string,
		environmentId: claim.environmentId as string,
		generation: claim.generation as number,
		cofounderId: claim.cofounderId as string,
		firstTodoId: claim.firstTodoId as string,
		kickoffRequestedBy: claim.kickoffRequestedBy as string | null,
		companyName: input.companyName as string,
		vision: input.vision as string,
		founders: founders.map((founder) => ({
			userId: founder.userId as string,
			displayName: founder.displayName as string,
			role: founder.role as string,
		})),
	};
}

/** The seeded tree as the creation commit's units, in the tree's order: the Co-Founder's folder is one new_folder
 * unit with its contents; every other folder is a mkdir and every other file a write. A structured file carries its
 * parse; a file no parser reads (the seeded skill) is written as bytes only. */
export function creationUnits(
	tree: readonly CompanyStateSeedEntry[],
	files: ReadonlyMap<string, PlatformFileReference>,
): unknown[] {
	const cofounder = `agents/${COMPANY_STATE_COFOUNDER_HANDLE}`;
	// Folders made whole, as one new_folder unit: the Co-Founder's (the agent with its first todo), and each interface
	// and table (a table's rows read the definition its own unit brings; P16).
	const whole = new Set(
		tree
			.filter(
				(entry) =>
					entry.kind === "folder" && (entry.path === cofounder || /^(interfaces|tables)\/[^/]+$/.test(entry.path)),
			)
			.map((entry) => entry.path),
	);
	const inWhole = (path: string) => [...whole].some((folder) => path.startsWith(`${folder}/`));
	const structured = (entry: CompanyStateSeedEntry) => {
		const parsed = parseCompanyStateFile(entry.path, entry.text ?? "");
		if (!parsed) return null;
		if (!parsed.ok) return platformFolderProblem("seed_invalid");
		return {
			path: entry.path,
			kind: parsed.file.kind,
			text: entry.text ?? "",
			parse: parsed.file,
			parserVersion: COMPANY_STATE_PARSER_VERSION,
		};
	};
	const file = (path: string) => files.get(path) ?? platformFolderProblem("stage_incomplete");
	const units: unknown[] = [];
	for (const entry of tree) {
		if (whole.has(entry.path)) {
			const inside = tree.filter((other) => other.path.startsWith(`${entry.path}/`));
			units.push({
				op: "new_folder",
				path: entry.path,
				contents: inside.map((other) => ({
					path: other.path.slice(entry.path.length + 1),
					kind: other.kind,
					...(other.kind === "file" ? { file: file(other.path) } : {}),
				})),
				structured: inside.flatMap((other) => {
					const parse = other.kind === "file" ? structured(other) : null;
					return parse ? [parse] : [];
				}),
			});
		} else if (inWhole(entry.path)) {
			// Inside a folder made whole.
		} else if (entry.kind === "folder") {
			units.push({ op: "mkdir", path: entry.path });
		} else {
			const parse = structured(entry);
			units.push({
				op: "write",
				path: entry.path,
				file: file(entry.path),
				...(parse ? { structured: [parse] } : {}),
			});
		}
	}
	return units;
}

export interface CompanyFolderCreatorOptions {
	readonly workerId: string;
	readonly authority: Pick<MemberCompanyAuthority, "publisher">;
	readonly store: Pick<FileSystemObjectStore, "get">;
	readonly replication: Pick<ObjectGatewayReplication, "uploadWithAuthority">;
	readonly leaseSeconds?: number;
}

export class CompanyFolderCreator {
	readonly #options: CompanyFolderCreatorOptions;
	readonly #folder: PlatformFolderWriter;
	readonly #leaseSeconds: number;

	constructor(options: CompanyFolderCreatorOptions) {
		if (!UUID.test(options.workerId)) throw new Error("Company creation worker identity is invalid");
		this.#options = options;
		this.#folder = new PlatformFolderWriter(options);
		this.#leaseSeconds = options.leaseSeconds ?? 300;
		if (!Number.isSafeInteger(this.#leaseSeconds) || this.#leaseSeconds < 30 || this.#leaseSeconds > 900)
			throw new Error("Company creation worker lease is invalid");
	}

	/** Makes due companies until none is due or `max` were handled. Returns how many were handled. */
	createDue(max = 5, signal: AbortSignal = AbortSignal.timeout(240_000)): Promise<number> {
		return drainPlatformClaims(max, () => this.createOne(signal), signal);
	}

	/** Claims one due creation and makes the company; false when nothing is due. */
	async createOne(signal: AbortSignal = AbortSignal.timeout(120_000)): Promise<boolean> {
		const answer = await this.#call("qorpera_folder_company_creation_claim", {
			p_worker: this.#options.workerId,
			p_lease_seconds: this.#leaseSeconds,
		});
		let claim: CompanyCreationClaim | null;
		try {
			claim = parseCompanyCreationClaim(answer);
		} catch (error) {
			// A claim that names its creation and generation is failed with the problem; anything else is left to its
			// lease.
			const input = answer as { creationId?: unknown; generation?: unknown } | null;
			if (
				error instanceof PlatformFolderProblem &&
				typeof input?.creationId === "string" &&
				UUID.test(input.creationId) &&
				Number.isSafeInteger(input.generation)
			)
				await this.#close(input.creationId, input.generation as number, error.code);
			throw error;
		}
		if (!claim) return false;
		let code: string | null = null;
		try {
			code = await this.#create(claim, signal);
		} catch (error) {
			code = platformFolderProblemCode(error);
		}
		if (code) await this.#close(claim.creationId, claim.generation, code);
		return true;
	}

	/** Builds, stages and creates. Returns null when the database answered (completed, failed, stale), or the code the
	 * claim is released or failed with. */
	async #create(claim: CompanyCreationClaim, signal: AbortSignal): Promise<string | null> {
		let tree: CompanyStateSeedEntry[];
		try {
			tree = companyStateSeedTree({
				companyName: claim.companyName,
				cofounderId: claim.cofounderId,
				vision: claim.vision,
				founders: claim.founders,
				firstTodo: { id: claim.firstTodoId, requestedBy: claim.kickoffRequestedBy },
			});
		} catch {
			// The parser refused a seeded file, or a writer refused a value: no retry builds another tree.
			return "seed_invalid";
		}
		const files = new Map<string, PlatformFileReference>();
		for (const entry of tree) {
			if (entry.kind !== "file") continue;
			files.set(
				entry.path,
				await this.#folder.stage(
					claim.environmentId,
					new TextEncoder().encode(entry.text ?? ""),
					{ mediaType: mediaType(entry.path), executable: false },
					signal,
				),
			);
		}
		const units = creationUnits(tree, files);
		const answer = (await this.#options.authority.publisher(
			"qorpera_folder_company_create",
			{
				p_worker: this.#options.workerId,
				p_creation_id: claim.creationId,
				p_generation: claim.generation,
				p_units: units,
			},
			signal,
		)) as { schema?: unknown; state?: unknown; problem?: unknown } | null;
		if (
			answer?.schema !== "qorpera.company-creation/v1" ||
			typeof answer.state !== "string" ||
			!ANSWERS.has(answer.state)
		)
			return "create_invalid";
		if (answer.state === "completed") await this.#followUp(claim);
		// Retry: an object the commit read was being deleted; the next attempt restages it.
		return answer.state === "retry" ? "bytes_unverified" : null;
	}

	/** Converges the new Co-Founder now, in its own transaction (P15's kick). Best effort: the queue's step converges it
	 * within seconds anyway, so a refusal or a failure here changes nothing. */
	async #followUp(claim: CompanyCreationClaim): Promise<void> {
		try {
			await this.#call("qorpera_folder_follow_up_now", {
				p_environment_id: claim.environmentId,
				p_subject_kind: "agent",
				p_subject_id: claim.cofounderId,
			});
		} catch {
			// The step converges it.
		}
	}

	/** Fails a claim for a problem no retry fixes, or releases it with a back-off. */
	async #close(creationId: string, generation: number, code: string): Promise<void> {
		const fail = FINAL.has(code);
		const answer = (await this.#call(
			fail ? "qorpera_folder_company_creation_fail" : "qorpera_folder_company_creation_release",
			{
				p_worker: this.#options.workerId,
				p_creation_id: creationId,
				p_generation: generation,
				...(fail ? { p_code: code } : { p_problem: code }),
			},
		)) as { schema?: unknown } | null;
		if (answer?.schema !== (fail ? "qorpera.company-creation-fail/v1" : "qorpera.company-creation-release/v1"))
			platformFolderProblem("close_invalid");
	}

	#call(method: Parameters<MemberCompanyAuthority["publisher"]>[0], args: Record<string, unknown>) {
		return this.#options.authority.publisher(method, args, AbortSignal.timeout(CALL_MS));
	}
}
