import type { InterfaceBlock, TableFile, TableValue } from "@qorpera/cloud-client/interfaces";
import { presentationLocale, t } from "../ui/preferences.ts";
import type { InterfaceRow } from "./interfaces.ts";

/* A board's lanes (Interfaces step I9a; deploy/first-node/RUNTIME-INTERFACES.md §3.2, proposed). With
 * `lanes = "members"` each card goes in one lane, the first that fits:
 * - Shared, when the block names a `shared` column and the card's row says yes in it, whoever holds it (a part whose
 *   table has no such column has no shared rows);
 * - the open pile, when `open_pile`: a row whose holder cell is empty, or any row of a part whose table has no holder;
 * - its holder's lane, one per current member: the member looking first, then the others by name;
 * - the lane of a holder who is no longer a member, titled with their name where it is known, after every other lane.
 * A row that fits none (an empty holder with no open pile) is not drawn. With `lanes = "<column>"`, a choice column,
 * there is one lane per choice in the column's order, and a card goes in the lane its row's choice names. */

/** A card on the board: one row of one of the block's parts. */
export interface BoardCard {
	/** The part's place among the parts drawn. */
	readonly part: number;
	readonly item: InterfaceRow;
}

export type BoardLaneKind = "member" | "shared" | "open" | "left" | "choice";

export interface BoardLane {
	/** What names the lane on the page, and where a drag lands. */
	readonly id: string;
	readonly kind: BoardLaneKind;
	readonly title: string;
	/** The member a member's lane is for; the holder a departed holder's lane is for, when there is one. */
	readonly member: string | null;
	/** The lane of the member looking. */
	readonly own: boolean;
	readonly cards: readonly BoardCard[];
}

/** One part's rows, as the block's query keeps them, with its table's definition (null when it has none). */
export interface BoardPartRows {
	readonly table: TableFile | null;
	readonly rows: readonly InterfaceRow[];
}

export interface BoardPeople {
	/** The member looking. */
	readonly viewer: string;
	/** The company's members now, with the names they are drawn with. */
	readonly members: readonly { readonly id: string; readonly name: string }[];
	/** A former member's name, where something still knows it. */
	readonly formerName: (id: string) => string | undefined;
}

const has = (table: TableFile | null, column: string | null): column is string =>
	column !== null && table?.columns.some((candidate) => candidate.name === column) === true;

const empty = (value: TableValue | undefined) =>
	value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/** The board's lanes in their order, each with its cards in the order of its parts and their rows. */
export function boardLanes(block: InterfaceBlock, parts: readonly BoardPartRows[], people: BoardPeople): BoardLane[] {
	const lanes = block.lanes ?? "members";
	if (lanes !== "members") return choiceLanes(lanes, parts);
	const collator = new Intl.Collator(presentationLocale(), { sensitivity: "base" });
	const members = [...people.members].sort(
		(a, b) =>
			Number(b.id === people.viewer) - Number(a.id === people.viewer) ||
			collator.compare(a.name, b.name) ||
			(a.id < b.id ? -1 : 1),
	);
	const current = new Set(members.map((member) => member.id));
	const byMember = new Map<string, BoardCard[]>(members.map((member) => [member.id, []]));
	const shared: BoardCard[] = [];
	const open: BoardCard[] = [];
	const left = new Map<string, BoardCard[]>();
	parts.forEach(({ table, rows }, part) => {
		const holder = has(table, table?.holder ?? null) ? (table?.holder ?? null) : null;
		const sharing = has(table, block.shared) ? block.shared : null;
		for (const item of rows) {
			const card = { part, item };
			if (sharing !== null && item.row[sharing] === true) {
				shared.push(card);
				continue;
			}
			const held = holder === null ? undefined : item.row[holder];
			if (holder === null || empty(held)) {
				if (block.openPile) open.push(card);
				continue;
			}
			const id = String(held);
			if (current.has(id)) byMember.get(id)?.push(card);
			else left.set(id, [...(left.get(id) ?? []), card]);
		}
	});
	const drawn: BoardLane[] = members.map((member) => ({
		id: `member:${member.id}`,
		kind: "member",
		title: member.id === people.viewer ? t("You") : member.name,
		member: member.id,
		own: member.id === people.viewer,
		cards: byMember.get(member.id) ?? [],
	}));
	if (block.shared !== null)
		drawn.push({ id: "shared", kind: "shared", title: t("Shared"), member: null, own: false, cards: shared });
	if (block.openPile)
		drawn.push({ id: "open", kind: "open", title: t("Open pile"), member: null, own: false, cards: open });
	// Holders whose names are known get a lane each, by name; the others share one.
	const named: BoardLane[] = [];
	const unknown: BoardCard[] = [];
	for (const [id, cards] of left) {
		const name = people.formerName(id);
		if (name === undefined) unknown.push(...cards);
		else named.push({ id: `left:${id}`, kind: "left", title: name, member: id, own: false, cards });
	}
	named.sort((a, b) => collator.compare(a.title, b.title));
	drawn.push(...named);
	if (unknown.length)
		drawn.push({ id: "left", kind: "left", title: t("Someone who left"), member: null, own: false, cards: unknown });
	return drawn;
}

/** One lane per choice of a choice column, in the column's order, from the first part whose table has it. */
function choiceLanes(column: string, parts: readonly BoardPartRows[]): BoardLane[] {
	const choices =
		parts
			.map(({ table }) => table?.columns.find((candidate) => candidate.name === column))
			.find((found) => found?.type === "choice")?.choices ?? [];
	return choices.map((choice) => ({
		id: `choice:${choice}`,
		kind: "choice",
		title: choice,
		member: null,
		own: false,
		cards: parts.flatMap(({ rows }, part) =>
			rows.filter(({ row }) => row[column] === choice).map((item) => ({ part, item })),
		),
	}));
}
