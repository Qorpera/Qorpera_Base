import type { Cloud } from "./client.ts";
import { array, CloudShapeError, oneOf, record } from "./parse.ts";

/* Which pages a company shows (Interfaces C6a; migration 20260930509000_interface_pages, supabase/CLIENT-CONTRACT.md
 * "Pages"). A company shows at most two, Mailbox and Members, each off until an owner or admin switches it on. The
 * web draws a page from the definition it ships, never from the folder's interfaces/. */

export const INTERFACE_PAGES = ["mailbox", "members"] as const;
export type InterfacePageName = (typeof INTERFACE_PAGES)[number];

export interface MemberInterfacePages {
	/** Both pages, in the Interfaces tab's order. */
	readonly pages: readonly { readonly page: InterfacePageName; readonly on: boolean }[];
	/** The caller is an owner or admin, who may switch them. */
	readonly mayChange: boolean;
}

/** The two calls, for one company. */
export interface InterfacePageCalls {
	list(): Promise<MemberInterfacePages>;
	/** Switches a page, answering with the pages as they are then. */
	set(page: InterfacePageName, on: boolean): Promise<MemberInterfacePages>;
}

export function parseInterfacePages(value: unknown): MemberInterfacePages {
	const input = record(value, "pages");
	if (input.schema !== "qorpera.member-interface-pages/v1" || typeof input.mayChange !== "boolean")
		throw new CloudShapeError("pages");
	const pages = array(input.pages, "pages").map((entry) => {
		const item = record(entry, "page");
		if (typeof item.on !== "boolean") throw new CloudShapeError("page");
		return { page: oneOf(item.page, INTERFACE_PAGES, "page name"), on: item.on };
	});
	if (new Set(pages.map((entry) => entry.page)).size !== pages.length) throw new CloudShapeError("pages");
	return { pages, mayChange: input.mayChange };
}

export function interfacePageCalls(cloud: Cloud, environmentId: string): InterfacePageCalls {
	return {
		list: async () =>
			parseInterfacePages(await cloud.rpc("qorpera_member_interface_pages", { p_environment_id: environmentId })),
		set: async (page, on) =>
			parseInterfacePages(
				await cloud.rpc("qorpera_set_interface_page", { p_environment_id: environmentId, p_page: page, p_on: on }),
			),
	};
}
