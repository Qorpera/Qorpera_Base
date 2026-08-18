/** Fixed desktop-shell navigation. Company files cannot add or replace nodes. */

export type ShellBuiltinId = "qorpera.inbox" | "qorpera.activity" | "qorpera.chats";

export interface ShellNavigationSection {
	id: string;
	kind: "department";
	label: string;
	items: string[];
}

export interface ShellNavigationPage {
	id: string;
	kind: "page";
	label: string;
	view: { type: "builtin"; id: ShellBuiltinId };
}

export type ShellNavigationNode = ShellNavigationSection | ShellNavigationPage;

export interface ShellNavigationState {
	defaultPageId: string;
	sectionIds: string[];
	nodes: ShellNavigationNode[];
}

export const FIXED_SHELL_NAVIGATION: ShellNavigationState = {
	defaultPageId: "q:chats",
	sectionIds: ["q:main"],
	nodes: [
		{ id: "q:main", kind: "department", label: "Main", items: ["q:inbox", "q:activity", "q:chats"] },
		{ id: "q:inbox", kind: "page", label: "Inbox", view: { type: "builtin", id: "qorpera.inbox" } },
		{ id: "q:activity", kind: "page", label: "Agents", view: { type: "builtin", id: "qorpera.activity" } },
		{ id: "q:chats", kind: "page", label: "Chats", view: { type: "builtin", id: "qorpera.chats" } },
	],
};
