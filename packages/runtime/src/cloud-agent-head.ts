/** The head (RUNTIME-AGENT-MEMORY-TREE.md §5.6, W3): the fixed top of every request, in the developer instructions
 * after the stable part, so runs share it as a cached prefix (Codex's environment context, with its random working
 * directory, follows the developer message, so no user-message text can be such a prefix).
 * - The company head: QorperaOS/vision/vision.md, whole (C:887 asks every run to read it).
 * - The agent head: its job specification (the body of its agent.md) and its profile page.
 * - The company's reading of itself: QorperaOS/vision/reading.md, whole, when the Co-Founder has written one (the
 *   founder, 14 November 2026: "It should feel like the company is conscious almost").
 *
 * It is data, not instructions, as C §9.2 asks: one serialized object, escaped as the context prompt is, whose every
 * part names its file and what it was read at (the vision, the reading and the profile page their file version, the job
 * specification its staff version) and carries a trust label that the stable part explains. Only the vision and the
 * reading parts are their files' text; the job part is the job specification at that staff version and the profile part
 * the page's facts. It is the same for every member, model and payer, and changes only when one of its files does. The
 * reads that compose it are released with the run's context, as read references.
 *
 * Never cut: a part that does not fit in CLOUD_AGENT_HEAD_BYTES, in the order vision, job, reading, profile, is left
 * out whole and named with its path and size (a full head leaves out the profile first, then the reading), and the
 * context message keeps the job specification and the profile page it left out.
 */
import { cloudAgentFolder } from "@qorpera/cloud-client/cloud-agent-folder";
import { osPath, READING_PATH } from "@qorpera/cloud-client/company-state-files";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import type { CloudFolderNotebookGateway } from "./cloud-folder-notebooks.ts";
import type { CloudAgentMemoryBlock } from "./cloud-memory-tools.ts";
import {
	type CloudNativeCompanyContext,
	cloudAgentFolderPlace,
	escapeCloudNativeContextJson,
} from "./cloud-native-company-context.ts";

export const CLOUD_AGENT_HEAD_SCHEMA = "qorpera.agent-head/v1";
/** HEAD (§5.1): the serialized head's bound, in UTF-8 bytes. */
export const CLOUD_AGENT_HEAD_BYTES = 16_000;
export const CLOUD_AGENT_VISION_PATH = osPath("vision/vision.md");

export type CloudAgentHeadPart = "vision" | "job" | "reading" | "profile";

/** What each part is (§5.6): data that guides the work, never authority over the platform's rules. */
export const CLOUD_AGENT_HEAD_TRUST = {
	vision: "company_instructions_not_authority",
	job: "job_specification_not_authority",
	// The company's own account of where it stands, written by the Co-Founder: company information, as the vision is.
	reading: "company_instructions_not_authority",
	profile: "own_notebook_not_authority",
} as const satisfies Record<CloudAgentHeadPart, string>;

/** A company file of the head (the vision, the reading) as composition read it: its text, or only its size when a
 * trusted read cannot hold it as text. */
export type CloudAgentHeadFile = { path: string; version: string; text: string } | { path: string; bytes: number };
export type CloudAgentHeadVision = CloudAgentHeadFile;

/** The vision is agreed once its last line starts "Agreed by" (the Co-Founder's role says so and writes it). A vision
 * too large to read as text counts as not agreed, so its run keeps the founding text. */
export function cloudVisionAgreed(vision: CloudAgentHeadVision | null): boolean {
	if (!vision || !("text" in vision)) return false;
	const lines = vision.text.split("\n").filter((line) => line.trim() !== "");
	return lines.at(-1)?.trim().startsWith("Agreed by") === true;
}

export interface CloudAgentHead {
	/** The serialized head, one line, as the developer instructions carry it. */
	readonly text: string;
	/** The parts it shows whole; the context message leaves those out. */
	readonly shown: ReadonlySet<CloudAgentHeadPart>;
}

type Candidate =
	| { part: CloudAgentHeadPart; path: string; at: { version: string } | { staffVersion: number }; text: string }
	| { part: CloudAgentHeadPart; path: string; bytes: number };

/** The vision file for the company head, or null when there is none. A file a trusted read cannot hold as text (over
 * 32 KiB, or not UTF-8) is named with the size that read found. */
export function readCloudAgentHeadVision(
	gateway: Pick<CloudFolderNotebookGateway, "readTrusted">,
	signal: AbortSignal,
): Promise<CloudAgentHeadVision | null> {
	return readHeadFile(gateway, CLOUD_AGENT_VISION_PATH, signal);
}

/** The company's reading of itself for the head, read as the vision is, or null when the company has none yet. */
export function readCloudAgentHeadReading(
	gateway: Pick<CloudFolderNotebookGateway, "readTrusted">,
	signal: AbortSignal,
): Promise<CloudAgentHeadFile | null> {
	return readHeadFile(gateway, READING_PATH, signal);
}

async function readHeadFile(
	gateway: Pick<CloudFolderNotebookGateway, "readTrusted">,
	path: string,
	signal: AbortSignal,
): Promise<CloudAgentHeadFile | null> {
	try {
		const read = await gateway.readTrusted(path, signal);
		return read.kind === "file" ? { path: read.path, version: read.version, text: read.text } : null;
	} catch (error) {
		if (error instanceof CloudCompanyPathNotText && error.bytes !== null) return { path, bytes: error.bytes };
		throw error;
	}
}

function serialize(parts: readonly Candidate[], omitted: readonly Candidate[]): string {
	return escapeCloudNativeContextJson(
		JSON.stringify({
			schema: CLOUD_AGENT_HEAD_SCHEMA,
			parts: parts.map((part) =>
				"text" in part
					? {
							part: part.part,
							path: part.path,
							...part.at,
							trust: CLOUD_AGENT_HEAD_TRUST[part.part],
							text: part.text,
						}
					: part,
			),
			omitted: omitted.map((part) => ({
				part: part.part,
				path: part.path,
				bytes: "text" in part ? Buffer.byteLength(part.text) : part.bytes,
			})),
		}),
	);
}

/** The run's head: each part whole, in order, while the head stays within CLOUD_AGENT_HEAD_BYTES; every other part
 * named in omitted. The job specification is shown only when the context holds all of it, and the profile page only
 * when the notebook was composed. */
export function composeCloudAgentHead(
	context: CloudNativeCompanyContext,
	vision: CloudAgentHeadVision | null,
	memory: CloudAgentMemoryBlock,
	reading: CloudAgentHeadFile | null = null,
): CloudAgentHead {
	const job = context.jobSpecification.content;
	const candidates: Candidate[] = [];
	const file = (part: "vision" | "reading", read: CloudAgentHeadFile): Candidate =>
		"text" in read ? { part, path: read.path, at: { version: read.version }, text: read.text } : { part, ...read };
	if (vision) candidates.push(file("vision", vision));
	const folder = cloudAgentFolder(
		context.identity.companyId,
		context.identity.staffAgentId,
		cloudAgentFolderPlace(context),
	);
	const jobPath = `${folder}/agent.md`;
	candidates.push(
		job.truncated
			? { part: "job", path: jobPath, bytes: job.originalBytes }
			: { part: "job", path: jobPath, at: { staffVersion: context.agent.version }, text: job.text },
	);
	if (reading) candidates.push(file("reading", reading));
	if (memory.available && memory.profile.version !== null)
		candidates.push({
			part: "profile",
			path: memory.profile.path,
			at: { version: memory.profile.version },
			text: memory.profile.facts.map((fact) => `- (${fact.date}) ${fact.fact}`).join("\n"),
		});
	// Each step's head is exactly what would be sent if the parts after it were left out, so the last one fits too.
	const shown: Candidate[] = [];
	const omitted: Candidate[] = [];
	for (const [index, candidate] of candidates.entries()) {
		const fits = (): boolean =>
			Buffer.byteLength(serialize([...shown, candidate], [...omitted, ...candidates.slice(index + 1)])) <=
			CLOUD_AGENT_HEAD_BYTES;
		if ("text" in candidate && fits()) shown.push(candidate);
		else omitted.push(candidate);
	}
	const text = serialize(shown, omitted);
	if (Buffer.byteLength(text) > CLOUD_AGENT_HEAD_BYTES) throw new Error("Agent head exceeds its bound");
	return { text, shown: new Set(shown.map((part) => part.part)) };
}
