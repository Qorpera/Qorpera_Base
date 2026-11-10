import {
	MEMBER_CONTACT_RANK_MAX,
	type MemberChatSummary,
	type MemberContactPlace,
	type MemberContactPlacing,
} from "../cloud/member-chats.ts";

/* Where a member's contacts stand in their own rail (Jonas, 10 Nov 2026: "not sure I like the member contacts at the
 * top, undraggable and un-hideable"). A contact is a row like an agent's: it stands in the Members group at the foot
 * of the list until its member drags it, and it drags into the pinned row, a section or among what is in none.
 *
 * The agents' order in a zone is the company's, the same for every member, and each member sees different contacts.
 * So a contact's place is its member's own and says what it stands after: the agent or group chat before it in its
 * zone (none: first), and its rank among the contacts after the same one. When the company's order changes, the
 * contact still stands after the same agent. An anchor that left the zone leaves the contact at the zone's end; a
 * section that is gone, or a rail without the sidebar, leaves it in the Members group. */

/** A rail zone, by the name its drop zone carries: "pinned", "unassigned", "members" or "section:<id>". */
export type RailZone = string;

export const MEMBERS_ZONE = "members";

/** A contact as the rail draws it. */
export interface RailContact {
	readonly userId: string;
	/** The zone it stands in now, whatever its kept place says. */
	readonly zone: RailZone;
	readonly after?: string;
	readonly rank: number;
	readonly hidden: boolean;
	/** Its place as the cloud would keep it: the kept one, or the Members group for one never placed. */
	readonly place: MemberContactPlace;
}

/** Where a contact never placed stands: in the Members group, after the placed ones, in the order the members joined. */
const UNPLACED_RANK = 5000;

function zoneOf(place: MemberContactPlace): RailZone {
	return place.zone === "section" ? `section:${place.sectionId}` : place.zone;
}

/** The place a zone name stands for, with what the contact stands after there. */
function placeIn(zone: RailZone, after: string | undefined, rank: number): MemberContactPlace {
	const bounded = Math.min(MEMBER_CONTACT_RANK_MAX, Math.max(0, rank));
	if (zone === MEMBERS_ZONE) return { zone: "members", rank: bounded };
	const anchor = after ? { after } : {};
	if (zone.startsWith("section:"))
		return { zone: "section", sectionId: zone.slice("section:".length), ...anchor, rank: bounded };
	return { zone: zone === "pinned" ? "pinned" : "unassigned", ...anchor, rank: bounded };
}

/**
 * The member's contacts as the rail draws them. `members` are the other members in the order they joined; `sections`
 * the company's sections, or undefined where the rail has no sidebar (then every contact is in the Members group).
 */
export function railContacts(
	members: readonly string[],
	chats: Readonly<Record<string, MemberChatSummary>>,
	sections: ReadonlySet<string> | undefined,
): RailContact[] {
	return members.flatMap((userId, index): RailContact[] => {
		const chat = chats[userId];
		if (!chat) return [];
		const kept = chat.place;
		const unplaced: MemberContactPlace = {
			zone: "members",
			rank: Math.min(MEMBER_CONTACT_RANK_MAX, UNPLACED_RANK + index),
		};
		const place = kept ?? unplaced;
		const hidden = chat.hidden === true;
		// A kept place that cannot be drawn: its section is gone, or this rail has no zones but the Members group.
		const drawn =
			kept &&
			kept.zone !== "members" &&
			(!sections || (kept.zone === "section" && !sections.has(kept.sectionId ?? "")))
				? unplaced
				: place;
		return [
			{
				userId,
				zone: zoneOf(drawn),
				...(drawn.after ? { after: drawn.after } : {}),
				rank: drawn.rank,
				hidden,
				place,
			},
		];
	});
}

/**
 * A zone's rows in order: its agents and group chats (`items`, in the company's order, pinned and hidden ones too)
 * with the member's contacts woven in, each after the item it stands after. A contact with no anchor stands first; one
 * whose anchor is not in the zone stands last. Contacts after the same item stand by rank, then as given.
 */
export function weave(items: readonly string[], contacts: readonly RailContact[]): string[] {
	if (!contacts.length) return [...items];
	const known = new Set(items);
	const first: RailContact[] = [];
	const last: RailContact[] = [];
	const after = new Map<string, RailContact[]>();
	for (const contact of contacts) {
		if (contact.after === undefined) first.push(contact);
		else if (!known.has(contact.after)) last.push(contact);
		else {
			const list = after.get(contact.after);
			if (list) list.push(contact);
			else after.set(contact.after, [contact]);
		}
	}
	const ranked = (list: readonly RailContact[]) =>
		[...list].sort((a, b) => a.rank - b.rank).map((contact) => contact.userId);
	return [...ranked(first), ...items.flatMap((item) => [item, ...ranked(after.get(item) ?? [])]), ...ranked(last)];
}

/**
 * The places a zone's drawn order gives its contacts, for those whose place or showing changes. `order` is what the
 * member sees in the zone after a drop: agents, group chats and contacts. Each contact stands after the nearest agent
 * or group chat before it, ranked among the contacts since. `show` names a contact that shows again where it lands
 * (dragged out of Hidden).
 */
export function contactPlaces(
	zone: RailZone,
	order: readonly string[],
	chats: Readonly<Record<string, MemberChatSummary>>,
	show?: string,
): MemberContactPlacing[] {
	const changes: MemberContactPlacing[] = [];
	let after: string | undefined;
	let rank = 0;
	for (const id of order) {
		const chat = chats[id];
		if (!chat) {
			after = id;
			rank = 0;
			continue;
		}
		const place = placeIn(zone, after, rank++);
		const hidden = id === show ? false : chat.hidden === true;
		const kept = chat.place;
		if (
			!kept ||
			kept.zone !== place.zone ||
			kept.sectionId !== place.sectionId ||
			kept.after !== place.after ||
			kept.rank !== place.rank ||
			hidden !== (chat.hidden === true)
		)
			changes.push({ userId: id, place, hidden });
	}
	return changes;
}
