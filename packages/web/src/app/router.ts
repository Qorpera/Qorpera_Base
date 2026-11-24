/* Hash routes. Company routes carry the profile UUID so a reload rebuilds the
 * same view from cloud state alone (runtime contract §14.5). */

import { UUID_PATTERN } from "@qorpera/contracts";

const UUID = new RegExp(UUID_PATTERN.source, "i");

/** "member" is this member's chat with another member of the company, `#/c/{id}/member/{userId}` (Jonas, 10 November
 * 2026). "interface" is a page in the rail's Interfaces tab, `#/c/{id}/i/{name}` (contract, 2026-10-02 interfaces amendment).
 * "app" is an agent's interface app (`apps/<name>/` of the Company File) as a page of its own, `#/c/{id}/a/{name}`
 * (Jonas, 8 November 2026: an app is a whole product prototype, not a panel beside the chat). "concepts" is the
 * company's concepts of its product, full screen with a side panel to pick one, `#/c/{id}/concepts` (the most
 * recently changed one) or `#/c/{id}/concepts/{name}` (Jonas, 8 November 2026). "whats-new" is What's new, the
 * changes to the company's sites made from its code, ready to go live, `#/c/{id}/whats-new` (own code storage step 4).
 * "site" is one of the company's websites, live, with its numbers, `#/c/{id}/site/{slug}` (company views step 4). */
export type CompanySection =
	| "home"
	| "chat"
	| "staff"
	| "file"
	| "team"
	| "new"
	| "interface"
	| "app"
	| "concepts"
	| "whats-new"
	| "site"
	| "new-program"
	| "member"
	| "surface";

const INTERFACE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Route =
	| { name: "hub" }
	| { name: "account" }
	/** A new company starts from an idea; qorpera.com hands over the one typed there as `#/new?idea=…`. */
	| { name: "new"; idea?: string }
	/** A founding table: a company row whose founders have not pressed Start yet. */
	| { name: "found"; profileId: string }
	| { name: "company"; profileId: string; section: CompanySection; id?: string };

/** The longest idea a link may carry (the website's box takes 280 characters). */
export const IDEA_MAX_CHARACTERS = 1000;

export function parseRoute(hash: string): Route {
	const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?", 2);
	const parts = path.split("/").filter(Boolean);
	if (parts.length === 0) return { name: "hub" };
	if (parts[0] === "account") return { name: "account" };
	if (parts[0] === "new" && parts.length === 1) {
		const idea = new URLSearchParams(query).get("idea")?.trim().slice(0, IDEA_MAX_CHARACTERS);
		return idea ? { name: "new", idea } : { name: "new" };
	}
	if (parts[0] === "found" && parts[1] && UUID.test(parts[1]))
		return { name: "found", profileId: parts[1].toLowerCase() };
	if (parts[0] === "c" && parts[1] && UUID.test(parts[1])) {
		const profileId = parts[1].toLowerCase();
		const section = parts[2];
		const id = parts[3];
		if (!section) return { name: "company", profileId, section: "home" };
		// A page's, an app's and a concept's names keep one rule (cloud-client isInterfaceName). This parse is in
		// theme.js too (ui/boot.ts), whose size is pinned: keep it short.
		const named = id !== undefined && id.length <= 64 && INTERFACE_NAME.test(id);
		// A page (`i`), an app (`a`) and a website (`site`) by its name, in one return: shorter in theme.js.
		const by =
			section === "i"
				? "interface"
				: section === "a"
					? "app"
					: section === "s"
						? "surface"
						: section === "site"
							? section
							: undefined;
		if (by && named) return { name: "company", profileId, section: by, id };
		if (section === "concepts") return { name: "company", profileId, section: "concepts", ...(named && { id }) };
		if ((section === "chat" || section === "staff" || section === "member") && id) {
			return { name: "company", profileId, section, id };
		}
		// The pages named by their section alone, as one pattern: shorter in theme.js than a comparison each.
		if (/^(file|team|new|whats-new|new-program)$/.test(section))
			return { name: "company", profileId, section: section as CompanySection };
		return { name: "company", profileId, section: "home" };
	}
	return { name: "hub" };
}

export function routeHash(route: Route): string {
	switch (route.name) {
		case "hub":
			return "#/";
		case "account":
			return "#/account";
		// The idea never goes back into the address: it is read once, then the box holds it.
		case "new":
			return "#/new";
		case "found":
			return `#/found/${route.profileId}`;
		case "company":
			if (route.section === "home") return `#/c/${route.profileId}`;
			if (route.section === "interface") return `#/c/${route.profileId}/i/${route.id ?? ""}`;
			if (route.section === "app") return appHash(route.profileId, route.id ?? "");
			if (route.section === "surface") return surfaceHash(route.profileId, route.id ?? "");
			if (route.section === "concepts") return conceptsHash(route.profileId, route.id);
			return route.id
				? `#/c/${route.profileId}/${route.section}/${route.id}`
				: `#/c/${route.profileId}/${route.section}`;
	}
}

/** The page of the agent's app `name` in the company `profileId`. */
export function appHash(profileId: string, name: string): string {
	return `#/c/${profileId}/a/${name}`;
}

export function surfaceHash(profileId: string, slug: string): string {
	return `#/c/${profileId}/s/${slug}`;
}

/** The view of the company's website `slug` in the company `profileId`. */
export function siteHash(profileId: string, slug: string): string {
	return `#/c/${profileId}/site/${slug}`;
}

/** The Concepts viewer of the company `profileId`, at the concept `name`, or at its most recently changed one. */
export function conceptsHash(profileId: string, name?: string): string {
	return name ? `#/c/${profileId}/concepts/${name}` : `#/c/${profileId}/concepts`;
}

export function navigate(route: Route, replaceEntry = false): void {
	const hash = routeHash(route);
	if (replaceEntry) history.replaceState(null, "", hash);
	else location.hash = hash;
	if (replaceEntry) window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function currentRoute(): Route {
	return parseRoute(location.hash);
}
