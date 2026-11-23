import type { PresenceMember } from "../cloud/presence.ts";
import { t } from "../ui/preferences.ts";
import { parsePresenceValue } from "./presence-place.ts";
import { routeHash } from "./router.ts";

export interface PlaceNames {
	surface(slug: string): { readonly slug: string; readonly title: string } | undefined;
	agent(id: string): { readonly id: string; readonly name: string; readonly home: boolean } | undefined;
	room(id: string): { readonly sessionId: string; readonly title: string } | undefined;
	page(name: string): string | undefined;
}

export interface PersonWhere {
	readonly label: string;
	readonly href: string;
}

export function personPlaces(here: readonly PresenceMember[] | undefined, userId: string): string[] {
	return (here ?? []).flatMap((member) => {
		if (member.userId !== userId) return [];
		const place = parsePresenceValue(member.staffAgentId).place;
		return place ? [place] : [];
	});
}

export function placeTarget(profileId: string, place: string, names: PlaceNames): PersonWhere | undefined {
	const colon = place.indexOf(":");
	if (colon < 0) return undefined;
	const kind = place.slice(0, colon);
	const id = place.slice(colon + 1);
	const at = (section: "surface" | "staff" | "chat" | "interface", target: string) =>
		routeHash({ name: "company", profileId, section, id: target });
	if (kind === "surface") {
		const surface = names.surface(id);
		return surface
			? { label: t("On {place}", { place: surface.title }), href: at("surface", surface.slug) }
			: undefined;
	}
	if (kind === "agent") {
		const agent = names.agent(id);
		if (!agent) return undefined;
		return {
			label: t("With {name}", { name: agent.name }),
			href: agent.home ? routeHash({ name: "company", profileId, section: "home" }) : at("staff", agent.id),
		};
	}
	if (kind === "room") {
		const room = names.room(id);
		return room ? { label: t("In {place}", { place: room.title }), href: at("chat", room.sessionId) } : undefined;
	}
	if (kind === "page") {
		const title = names.page(id);
		return title ? { label: t("On {place}", { place: title }), href: at("interface", id) } : undefined;
	}
	return undefined;
}

export function personWhere(
	profileId: string,
	here: readonly PresenceMember[] | undefined,
	userId: string,
	names: PlaceNames,
): PersonWhere | undefined {
	for (const place of personPlaces(here, userId)) {
		const where = placeTarget(profileId, place, names);
		if (where) return where;
	}
	return undefined;
}
