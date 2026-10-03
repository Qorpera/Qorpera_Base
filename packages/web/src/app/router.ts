/* Hash routes. Company routes carry the profile UUID so a reload rebuilds the
 * same view from cloud state alone (runtime contract §14.5). */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** "interface" is a page in the rail's Interfaces tab, `#/c/{id}/i/{name}` (contract, 2026-10-02 interfaces amendment). */
export type CompanySection =
	| "home"
	| "chat"
	| "staff"
	| "file"
	| "team"
	| "new"
	| "meet"
	| "interface";

const INTERFACE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Route =
	| { name: "hub" }
	| { name: "account" }
	/** A founding table: a company row whose founders have not pressed Start yet. */
	| { name: "found"; profileId: string }
	| { name: "company"; profileId: string; section: CompanySection; id?: string };

export function parseRoute(hash: string): Route {
	const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
	if (parts.length === 0) return { name: "hub" };
	if (parts[0] === "account") return { name: "account" };
	if (parts[0] === "found" && parts[1] && UUID.test(parts[1]))
		return { name: "found", profileId: parts[1].toLowerCase() };
	if (parts[0] === "c" && parts[1] && UUID.test(parts[1])) {
		const profileId = parts[1].toLowerCase();
		const section = parts[2];
		const id = parts[3];
		if (!section) return { name: "company", profileId, section: "home" };
		if (section === "i" && id && id.length <= 64 && INTERFACE_NAME.test(id)) {
			return { name: "company", profileId, section: "interface", id };
		}
		if ((section === "chat" || section === "staff") && id) {
			return { name: "company", profileId, section, id };
		}
		if (section === "file" || section === "team" || section === "new" || section === "meet") {
			return { name: "company", profileId, section };
		}
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
		case "found":
			return `#/found/${route.profileId}`;
		case "company":
			if (route.section === "home") return `#/c/${route.profileId}`;
			if (route.section === "interface") return `#/c/${route.profileId}/i/${route.id ?? ""}`;
			return route.id
				? `#/c/${route.profileId}/${route.section}/${route.id}`
				: `#/c/${route.profileId}/${route.section}`;
	}
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
