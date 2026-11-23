import type { SurfaceAutomationSummary } from "@qorpera/contracts";
import type { HostedProfileMember, HostedProfileRole } from "../cloud/types.ts";
import { t } from "../ui/preferences.ts";

export interface AutomationPerson {
	readonly userId: string;
	readonly name: string;
}

export interface AutomationOwnerView {
	readonly face: AutomationPerson | "nobody" | undefined;
	readonly offeredToYou: { readonly offerId: string; readonly from: AutomationPerson } | undefined;
	readonly note: string | undefined;
	readonly mayTake: boolean;
}

export type AutomationChoice =
	| { readonly kind: "hand"; readonly to: AutomationPerson }
	| { readonly kind: "take" }
	| { readonly kind: "withdraw"; readonly offerId: string };

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

function person(members: readonly HostedProfileMember[], userId: string | null): AutomationPerson | undefined {
	const member = userId ? members.find((each) => each.userId === userId) : undefined;
	return member ? { userId: member.userId, name: member.displayName || member.email } : undefined;
}

export function offerWaitsOn(automation: SurfaceAutomationSummary, viewer: string): boolean {
	return automation.ownable && automation.offer?.status === "open" && automation.offer.toUserId === viewer;
}

export function offersWaitingOn(automations: readonly SurfaceAutomationSummary[], viewer: string): number {
	return automations.filter((automation) => offerWaitsOn(automation, viewer)).length;
}

export function automationOwnerView(
	automation: SurfaceAutomationSummary,
	viewer: string,
	role: HostedProfileRole | undefined,
	members: readonly HostedProfileMember[],
): AutomationOwnerView {
	if (!automation.ownable || members.length === 0)
		return { face: undefined, offeredToYou: undefined, note: undefined, mayTake: false };
	const owner = person(members, automation.ownerUserId);
	const offer = automation.offer;
	const offerer = offer ? person(members, offer.offeredByUserId ?? offer.fromUserId) : undefined;
	if (offer && offerWaitsOn(automation, viewer) && offerer)
		return { face: offerer, offeredToYou: { offerId: offer.id, from: offerer }, note: undefined, mayTake: false };
	const to = offer ? person(members, offer.toUserId) : undefined;
	const note = !owner
		? t("Nobody")
		: offer?.status === "open" && to
			? t("Offered to {name}", { name: firstName(to.name) })
			: offer?.status === "no" && to
				? to.userId === viewer
					? t("You said no")
					: t("{name} said no", { name: firstName(to.name) })
				: automation.status === "needs_attention"
					? t("Paused: no model account pays for it")
					: undefined;
	return {
		face: owner ?? "nobody",
		offeredToYou: undefined,
		note,
		mayTake: !owner && role !== undefined && role !== "viewer" && offer?.status !== "open",
	};
}

export function automationChoices(
	automation: SurfaceAutomationSummary,
	viewer: string,
	role: HostedProfileRole | undefined,
	members: readonly HostedProfileMember[],
): AutomationChoice[] {
	if (!automation.ownable || members.length === 0 || role === undefined || role === "viewer") return [];
	const offer = automation.offer?.status === "open" ? automation.offer : undefined;
	if (offer)
		return viewer === offer.offeredByUserId || viewer === offer.fromUserId
			? [{ kind: "withdraw", offerId: offer.id }]
			: [];
	const owner = automation.ownerUserId;
	const ownerIsMember = members.some((member) => member.userId === owner);
	const choices: AutomationChoice[] = ownerIsMember ? [] : [{ kind: "take" }];
	if (viewer !== owner && role !== "owner" && role !== "admin") return choices;
	for (const member of members)
		if (member.role !== "viewer" && member.userId !== owner && member.userId !== viewer)
			choices.push({ kind: "hand", to: { userId: member.userId, name: member.displayName || member.email } });
	return choices;
}
