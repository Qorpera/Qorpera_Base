import type { Cloud } from "./client.ts";
import { array, CloudShapeError, oneOf, record } from "./parse.ts";

/* Which pages a member's rail shows (Interfaces C6a; migrations 20260930509000_interface_pages,
 * 20260930520000_interface_page_bank and 20260930697000_interface_pages_hidden_per_member, supabase/CLIENT-CONTRACT.md
 * "Pages"). A company has at most three, Mailbox, Members and Bank. Since 20260930697000 each member hides or shows
 * them on their own rail (Jonas, 9 Nov 2026); before it, an owner or admin switched them for everyone. The web draws a
 * page from the definition it ships, never from the folder's QorperaOS/interfaces/. */

export const INTERFACE_PAGES = ["mailbox", "members", "bank"] as const;
export type InterfacePageName = (typeof INTERFACE_PAGES)[number];

export interface MemberInterfacePages {
	/** The pages, in the Interfaces tab's order: the company's switch (`on`), and whether the caller hid the page from
	 * their own rail (`hidden`, absent on a cloud from before 20260930697000). */
	readonly pages: readonly { readonly page: InterfacePageName; readonly on: boolean; readonly hidden?: boolean }[];
	/** The caller is an owner or admin, who may switch them for the company. */
	readonly mayChange: boolean;
	/** The cloud answers each member's own `hidden`: the rail shows a page unless the member hid it, and offers to hide
	 * and show them. Before, the company's `on` decides and nothing is offered. */
	readonly personal?: true;
}

/** The two calls, for one company. */
export interface InterfacePageCalls {
	list(): Promise<MemberInterfacePages>;
	/** Hides a page from the caller's own rail, or shows it again, answering with the pages as they are then. */
	hide(page: InterfacePageName, hidden: boolean): Promise<MemberInterfacePages>;
}

export function parseInterfacePages(value: unknown): MemberInterfacePages {
	const input = record(value, "pages");
	if (input.schema !== "qorpera.member-interface-pages/v1" || typeof input.mayChange !== "boolean")
		throw new CloudShapeError("pages");
	const pages = array(input.pages, "pages").map((entry) => {
		const item = record(entry, "page");
		if (typeof item.on !== "boolean" || (item.hidden !== undefined && typeof item.hidden !== "boolean"))
			throw new CloudShapeError("page");
		const page = oneOf(item.page, INTERFACE_PAGES, "page name");
		return typeof item.hidden === "boolean" ? { page, on: item.on, hidden: item.hidden } : { page, on: item.on };
	});
	if (new Set(pages.map((entry) => entry.page)).size !== pages.length) throw new CloudShapeError("pages");
	const personal = pages.length > 0 && pages.every((entry) => entry.hidden !== undefined);
	return personal ? { pages, mayChange: input.mayChange, personal } : { pages, mayChange: input.mayChange };
}

export function interfacePageCalls(cloud: Cloud, environmentId: string): InterfacePageCalls {
	return {
		list: async () =>
			parseInterfacePages(await cloud.rpc("qorpera_member_interface_pages", { p_environment_id: environmentId })),
		hide: async (page, hidden) =>
			parseInterfacePages(
				await cloud.rpc("qorpera_set_interface_page_hidden", {
					p_environment_id: environmentId,
					p_page: page,
					p_hidden: hidden,
				}),
			),
	};
}
