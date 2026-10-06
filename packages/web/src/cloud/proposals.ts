import { array, boundedInteger, CloudShapeError, nonEmptyString, oneOf, record, timestamp, uuid } from "./parse.ts";

/* A member's open proposals (P40c, migration 20260930102000): changes an agent saved through a view (a computer, a
 * command, a coding session, a test machine, a run's own folder) that need review. Each waits for the member whose
 * run saved it, until the agent's run applies or declines it, or the member discards it. */

export const MEMBER_FOLDER_PROPOSALS_SCHEMA = "qorpera.member-folder-proposals/v1";
export const FOLDER_PROPOSAL_SCHEMA = "qorpera.folder-proposal/v1";
/** A page lists at most this many proposals, each with at most this many units (as the run's list). */
const PAGE = 4;
const UNITS = 50;

/** A structured file a change writes, with the strings of its parse a card names it by. */
export interface FolderProposalFile {
	path: string;
	kind: string;
	name?: string;
	title?: string;
	role?: string;
	status?: string;
}

export interface FolderProposalUnit {
	/** Its number in the proposal, from 1. */
	unit: number;
	op: string;
	/** The path it writes, or the path a move or delete starts from. */
	path: string;
	/** Where a move goes. */
	to?: string;
	structured: FolderProposalFile[];
}

export interface FolderProposal {
	proposalId: string;
	createdAt: string;
	/** The kind of view that saved it: computer_desktop, computer_shell_command, coding_session, test_machine, run_box. */
	viewKind: string;
	/** Applying it hires an agent. */
	createsAgent: boolean;
	unitCount: number;
	/** The first 50 units, in order. */
	units: FolderProposalUnit[];
	moreUnits: number;
}

export interface FolderProposalPage {
	/** Oldest first. */
	proposals: FolderProposal[];
	/** Open proposals after this page that the member may read. */
	moreProposals: number;
	nextCursor?: string;
}

export type FolderProposalStatus = "applied" | "not_applied" | "declined" | "discarded";

const PARSED = ["name", "title", "role", "status"] as const;

function parseFile(value: unknown): FolderProposalFile {
	const file = record(value, "proposal file");
	const parse = record(file.parse, "proposal file parse");
	const parsed: FolderProposalFile = {
		path: nonEmptyString(file.path, "proposal file path"),
		kind: nonEmptyString(file.kind, "proposal file kind", 64),
	};
	for (const key of PARSED) if (typeof parse[key] === "string") parsed[key] = parse[key];
	return parsed;
}

function parseUnit(value: unknown, index: number): FolderProposalUnit {
	const unit = record(value, "proposal unit");
	if (unit.unit !== index + 1) throw new CloudShapeError("proposal unit number");
	return {
		unit: index + 1,
		op: nonEmptyString(unit.op, "proposal unit op", 32),
		path: nonEmptyString(unit.path, "proposal unit path"),
		...(unit.to === undefined ? {} : { to: nonEmptyString(unit.to, "proposal unit target") }),
		structured: unit.structured === undefined ? [] : array(unit.structured, "proposal files").map(parseFile),
	};
}

function parseProposal(value: unknown): FolderProposal {
	const proposal = record(value, "proposal");
	if (typeof proposal.createsAgent !== "boolean") throw new CloudShapeError("proposal createsAgent");
	const unitCount = boundedInteger(proposal.unitCount, "proposal unit count", 1, Number.MAX_SAFE_INTEGER);
	const units = array(proposal.units, "proposal units").map(parseUnit);
	const moreUnits = boundedInteger(proposal.moreUnits, "proposal more units", 0, Number.MAX_SAFE_INTEGER);
	if (units.length !== Math.min(unitCount, UNITS) || moreUnits !== unitCount - units.length)
		throw new CloudShapeError("proposal units");
	return {
		proposalId: uuid(proposal.proposalId, "proposal id"),
		createdAt: timestamp(proposal.createdAt, "proposal time"),
		viewKind: nonEmptyString(proposal.viewKind, "proposal view kind", 64),
		createsAgent: proposal.createsAgent,
		unitCount,
		units,
		moreUnits,
	};
}

/** One page of the caller's open proposals of one agent. The next page starts after its last proposal. */
export function parseFolderProposalPage(value: unknown): FolderProposalPage {
	const page = record(value, "proposals");
	if (page.schema !== MEMBER_FOLDER_PROPOSALS_SCHEMA) throw new CloudShapeError("proposals schema");
	const proposals = array(page.proposals, "proposals").map(parseProposal);
	const moreProposals = boundedInteger(page.moreProposals, "more proposals", 0, Number.MAX_SAFE_INTEGER);
	const nextCursor = page.nextCursor === null ? undefined : uuid(page.nextCursor, "proposal cursor");
	if (
		proposals.length > PAGE ||
		new Set(proposals.map((proposal) => proposal.proposalId)).size !== proposals.length ||
		moreProposals > 0 !== (nextCursor !== undefined) ||
		(nextCursor !== undefined && (proposals.length !== PAGE || proposals.at(-1)?.proposalId !== nextCursor))
	)
		throw new CloudShapeError("proposals page");
	return { proposals, moreProposals, ...(nextCursor ? { nextCursor } : {}) };
}

/** A discard's answer: the proposal as it stands now, which no longer waits. */
export function parseFolderProposalDiscard(value: unknown, proposalId: string): FolderProposalStatus {
	const answer = record(value, "proposal discard");
	if (answer.schema !== FOLDER_PROPOSAL_SCHEMA || uuid(answer.proposalId, "proposal id") !== proposalId.toLowerCase())
		throw new CloudShapeError("proposal discard");
	return oneOf(answer.status, ["applied", "not_applied", "declined", "discarded"], "proposal status");
}
