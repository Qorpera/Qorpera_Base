/* Hash routes. Company routes carry the profile UUID so a reload rebuilds the
 * same view from cloud state alone (runtime contract §14.5). */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CompanySection =
	| "home"
	| "chat"
	| "staff"
	| "approvals"
	| "notifications"
	| "file"
	| "snapshot"
	| "proposal"
	| "organization"
	| "responsibility"
	| "project"
	| "team"
	| "new"
	| "meet";

export type Route =
	| { name: "hub" }
	| { name: "account" }
	| { name: "browser-access" }
	| { name: "friends" }
	| { name: "invitations" }
	| { name: "cloud-check" }
	| { name: "company"; profileId: string; section: CompanySection; id?: string };

export function parseRoute(hash: string): Route {
	const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
	if (parts.length === 0) return { name: "hub" };
	if (parts[0] === "account") return { name: "account" };
	if (parts[0] === "browser-access") return { name: "browser-access" };
	if (parts[0] === "friends") return { name: "friends" };
	if (parts[0] === "invitations") return { name: "invitations" };
	if (parts[0] === "cloud-check") return { name: "cloud-check" };
	if (parts[0] === "c" && parts[1] && UUID.test(parts[1])) {
		const profileId = parts[1].toLowerCase();
		const section = parts[2];
		const id = parts[3];
		if (!section) return { name: "company", profileId, section: "home" };
		if (
			(section === "chat" ||
				section === "staff" ||
				section === "snapshot" ||
				section === "proposal" ||
				section === "responsibility" ||
				section === "project") &&
			id
		) {
			return { name: "company", profileId, section, id };
		}
		if (
			section === "approvals" ||
			section === "notifications" ||
			section === "file" ||
			section === "organization" ||
			section === "team" ||
			section === "new" ||
			section === "meet"
		) {
			return { name: "company", profileId, section, ...(section === "file" && id === "history" ? { id } : {}) };
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
		case "browser-access":
			return "#/browser-access";
		case "friends":
			return "#/friends";
		case "invitations":
			return "#/invitations";
		case "cloud-check":
			return "#/cloud-check";
		case "company":
			if (route.section === "home") return `#/c/${route.profileId}`;
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
