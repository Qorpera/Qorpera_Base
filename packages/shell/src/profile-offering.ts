export const PROFILE_OFFERINGS = ["free", "cloud", "computer", "hq"] as const;
export type ProfileOffering = (typeof PROFILE_OFFERINGS)[number];

export interface ProfileOfferingCapabilities {
	sharedSubstrate: boolean;
	managedComputer: boolean;
}

export interface ProfileOfferingDefinition extends ProfileOfferingCapabilities {
	id: ProfileOffering;
	label: string;
	description: string;
}

export const PROFILE_OFFERING_DEFINITIONS: readonly ProfileOfferingDefinition[] = [
	{
		id: "free",
		label: "Free",
		description: "A local company profile with execution on this computer.",
		sharedSubstrate: false,
		managedComputer: false,
	},
	{
		id: "cloud",
		label: "Cloud",
		description: "One shared company profile with execution on each member's computer.",
		sharedSubstrate: true,
		managedComputer: false,
	},
	{
		id: "computer",
		label: "Computer",
		description: "A private company profile with a Qorpera-hosted computer.",
		sharedSubstrate: false,
		managedComputer: true,
	},
	{
		id: "hq",
		label: "HQ",
		description: "One shared company profile with Qorpera-hosted computers.",
		sharedSubstrate: true,
		managedComputer: true,
	},
];

export function isProfileOffering(value: unknown): value is ProfileOffering {
	return PROFILE_OFFERINGS.some((candidate) => candidate === value);
}

export function profileOfferingDefinition(offering: ProfileOffering): ProfileOfferingDefinition {
	return PROFILE_OFFERING_DEFINITIONS.find((candidate) => candidate.id === offering)!;
}

export function profileOfferingCanPromote(from: ProfileOffering, to: ProfileOffering): boolean {
	const current = profileOfferingDefinition(from);
	const target = profileOfferingDefinition(to);
	return (!current.sharedSubstrate || target.sharedSubstrate) && (!current.managedComputer || target.managedComputer);
}

export function cloudPromotionOffering(offering: ProfileOffering): "cloud" | "hq" {
	return profileOfferingDefinition(offering).managedComputer ? "hq" : "cloud";
}
