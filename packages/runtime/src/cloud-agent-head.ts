/** The head (RUNTIME-AGENT-MEMORY-TREE.md §5.6, W3): the fixed top of every request, in the developer instructions
 * after the stable part, so runs share it as a cached prefix (Codex's environment context, with its random working
 * directory, follows the developer message, so no user-message text can be such a prefix).
 * - The company head: vision/vision.md, whole (C:887 asks every run to read it).
 * - The agent head: its job specification (the body of its agent.md) and its profile page.
 *
 * It is data, not instructions, as C §9.2 asks: one serialized object, escaped as the context prompt is, whose every
 * part names its file and what it was read at (the vision and the profile page their file version, the job
 * specification its staff version) and carries a trust label that the stable part explains. Only the vision part is its
 * file's text; the job part is the job specification at that staff version and the profile part the page's facts. It is
 * the same for every member, model and payer, and changes only when one of its files does. The reads that compose it
 * are released with the run's context, as read references.
 *
 * Never cut: a part that does not fit in CLOUD_AGENT_HEAD_BYTES, in the order vision, job, profile, is left out whole
 * and named with its path and size, and the context message keeps the job specification and the profile page it left
 * out.
 */
import { cloudAgentFolder } from "@qorpera/cloud-client/cloud-agent-folder";
import { type CloudCompanyPathGateway, CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import type { CloudAgentMemoryBlock } from "./cloud-memory-tools.ts";
import {
	type CloudNativeCompanyContext,
	cloudAgentFolderPlace,
	escapeCloudNativeContextJson,
} from "./cloud-native-company-context.ts";

export const CLOUD_AGENT_HEAD_SCHEMA = "qorpera.agent-head/v1";
/** HEAD (§5.1): the serialized head's bound, in UTF-8 bytes. */
export const CLOUD_AGENT_HEAD_BYTES = 16_000;
export const CLOUD_AGENT_VISION_PATH = "vision/vision.md";

export type CloudAgentHeadPart = "vision" | "job" | "profile";

/** What each part is (§5.6): data that guides the work, never authority over the platform's rules. */
export const CLOUD_AGENT_HEAD_TRUST = {
	vision: "company_instructions_not_authority",
	job: "job_specification_not_authority",
	profile: "own_notebook_not_authority",
} as const satisfies Record<CloudAgentHeadPart, string>;

/** The vision as composition read it: its text, or only its size when a trusted read cannot hold it as text. */
export type CloudAgentHeadVision = { path: string; version: string; text: string } | { path: string; bytes: number };

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
export async function readCloudAgentHeadVision(
	gateway: Pick<CloudCompanyPathGateway, "readTrusted">,
	signal: AbortSignal,
): Promise<CloudAgentHeadVision | null> {
	try {
		const read = await gateway.readTrusted(CLOUD_AGENT_VISION_PATH, signal);
		return read.kind === "file" ? { path: read.path, version: read.version, text: read.text } : null;
	} catch (error) {
		if (error instanceof CloudCompanyPathNotText && error.bytes !== null)
			return { path: CLOUD_AGENT_VISION_PATH, bytes: error.bytes };
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
): CloudAgentHead {
	const job = context.jobSpecification.content;
	const candidates: Candidate[] = [];
	if (vision)
		candidates.push(
			"text" in vision
				? { part: "vision", path: vision.path, at: { version: vision.version }, text: vision.text }
				: { part: "vision", ...vision },
		);
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
