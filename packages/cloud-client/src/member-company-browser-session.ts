import type {
	CloudCompanyComputerBrowserProfiles,
	MemberBrowserGrantStatus,
	MemberBrowserProfileCatalog,
} from "./cloud-company-computer-browser-profiles.ts";
import type { CompanyComputerPrivacyChallenge } from "./cloud-company-computer-privacy.ts";
import type {
	CloudCompanyComputerPrivacyStatus,
	CloudCompanyComputerSignIn,
} from "./cloud-company-computer-sign-in.ts";
import type { CompanyComputerMemberStatus } from "./cloud-company-computer-views.ts";

function request(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("Invalid browser profile action");
	return value as Record<string, unknown>;
}

/** A member host composes metadata/consent and explicit privacy intent. It
 * never receives passwords or performs a physical privacy acknowledgement. */
export class MemberCompanyBrowserSession {
	readonly #profiles: CloudCompanyComputerBrowserProfiles;
	readonly #signIn: CloudCompanyComputerSignIn;
	readonly #current: () => void;
	readonly #signal: AbortSignal;
	#catalog?: MemberBrowserProfileCatalog;
	#privacy?: CloudCompanyComputerPrivacyStatus;
	#grant?: MemberBrowserGrantStatus;
	#registration?: { profileId: string; label: string };
	#busy = false;
	constructor(options: {
		profiles: CloudCompanyComputerBrowserProfiles;
		signIn: CloudCompanyComputerSignIn;
		current(): void;
		signal: AbortSignal;
	}) {
		this.#profiles = options.profiles;
		this.#signIn = options.signIn;
		this.#current = options.current;
		this.#signal = options.signal;
	}
	async action(
		value: unknown,
		context: { staffIds: readonly string[]; screens?: CompanyComputerMemberStatus; viewingAvailable: boolean },
	): Promise<unknown> {
		this.#current();
		this.#signal.throwIfAborted();
		if (this.#busy) throw new Error("Wait for the current browser action");
		if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 4096)
			throw new Error("Invalid browser profile action");
		this.#busy = true;
		try {
			const method = (value as Record<string, unknown>).method,
				signal = this.#signal;
			let result: unknown;
			if (method === "profiles") {
				const input = request(value, "after,method");
				if (input.after !== null && (typeof input.after !== "string" || input.after !== this.#catalog?.nextAfter))
					throw new Error("Refresh browser profiles");
				this.#catalog = undefined;
				this.#grant = undefined;
				const catalog = await this.#profiles.catalog(signal, input.after as string | null);
				this.#current();
				this.#catalog = catalog;
				if (
					this.#registration &&
					catalog.profiles.some((profile) => profile.profileId === this.#registration!.profileId)
				)
					this.#registration = undefined;
				result = { catalog, pendingRegistration: this.#registration ? { ...this.#registration } : null };
			} else if (method === "privacy") {
				request(value, "method");
				this.#privacy = undefined;
				const privacy = await this.#signIn.status(signal);
				this.#current();
				this.#privacy = privacy;
				result = privacy;
			} else if (method === "registerProfile" || method === "retryProfile") {
				if (!this.#catalog?.canUse || this.#privacy?.state !== "shared")
					throw new Error("Refresh browser profiles and privacy status");
				if (method === "registerProfile") {
					const input = request(value, "label,method");
					if (this.#registration) throw new Error("Recover the pending browser registration");
					if (
						typeof input.label !== "string" ||
						input.label.length < 1 ||
						input.label.length > 80 ||
						input.label !== input.label.trim() ||
						/[\u0000-\u001f\u007f-\u009f]/u.test(input.label)
					)
						throw new Error("Invalid browser profile name");
					this.#registration = { profileId: crypto.randomUUID(), label: input.label };
				} else {
					request(value, "method");
					if (!this.#registration) throw new Error("No pending browser registration");
				}
				const registration = this.#registration!;
				const profile = await this.#profiles.register(registration.profileId, registration.label, signal);
				this.#current();
				this.#registration = undefined;
				this.#catalog = undefined;
				this.#grant = undefined;
				result = profile;
			} else if (method === "browserGrant") {
				const input = request(value, "method,profileId,staffAgentId");
				const profile = this.#catalog?.profiles.find((profile) => profile.profileId === input.profileId);
				if (
					!profile ||
					(profile.activeStaffAgentId !== input.staffAgentId &&
						!context.staffIds.includes(input.staffAgentId as string))
				)
					throw new Error("Refresh the selected browser and agent");
				this.#grant = undefined;
				const grant = await this.#profiles.grantStatus(profile.profileId, input.staffAgentId as string, signal);
				this.#current();
				this.#grant = grant;
				result = grant;
			} else if (method === "configureBrowser") {
				const input = request(value, "enabled,expectedVersion,method,profileId,profileVersion,staffAgentId"),
					observed = this.#grant;
				if (
					!observed ||
					input.profileId !== observed.profile.profileId ||
					input.profileVersion !== observed.profile.version ||
					input.staffAgentId !== observed.staffAgentId ||
					input.expectedVersion !== (observed.grant?.version ?? 0) ||
					typeof input.enabled !== "boolean" ||
					(input.enabled && (!this.#catalog?.canUse || this.#privacy?.state !== "shared"))
				)
					throw new Error("Refresh browser consent");
				this.#grant = undefined;
				result = await this.#profiles.configure(
					{
						profileId: observed.profile.profileId,
						profileVersion: observed.profile.version,
						staffAgentId: observed.staffAgentId,
						expectedVersion: input.expectedVersion as number,
						enabled: input.enabled,
					},
					signal,
				);
				this.#catalog = undefined;
			} else if (method === "beginPrivate") {
				const input = request(value, "method,profileId,screenId");
				const profile = this.#catalog?.profiles.find((profile) => profile.profileId === input.profileId),
					privacy = this.#privacy;
				if (
					!profile ||
					!this.#catalog?.canUse ||
					!context.viewingAvailable ||
					privacy?.state !== "shared" ||
					context.screens?.privacyState !== "shared" ||
					context.screens.computerGeneration !== privacy.computerGeneration ||
					context.screens.privacyVersion !== privacy.version ||
					!context.screens.screens.some((screen) => screen.binding.screenId === input.screenId)
				)
					throw new Error("Refresh the browser and selected screen");
				this.#privacy = undefined;
				this.#catalog = undefined;
				this.#grant = undefined;
				result = await this.#signIn.request(
					profile.profileId,
					input.screenId as string,
					privacy.version,
					true,
					signal,
				);
			} else if (method === "finishPrivate") {
				request(value, "method");
				const privacy = this.#privacy,
					challenge = privacy?.challenge;
				if (
					!challenge ||
					(privacy.state !== "entering" && privacy.state !== "private") ||
					challenge.state !== "entering"
				)
					throw new Error("Refresh your private sign-in");
				this.#privacy = undefined;
				this.#catalog = undefined;
				this.#grant = undefined;
				result = await this.#signIn.request(
					challenge.profileId,
					challenge.screenId,
					privacy.version,
					false,
					signal,
				);
			} else throw new Error("Unknown browser profile action");
			this.#current();
			signal.throwIfAborted();
			return result;
		} finally {
			this.#busy = false;
		}
	}
	async privateChallenge(challengeId: string, signal: AbortSignal): Promise<CompanyComputerPrivacyChallenge> {
		this.#current();
		const previous = this.#privacy;
		if (previous?.state !== "private" || previous.challenge?.challengeId !== challengeId)
			throw new Error("Refresh private sign-in status");
		const current = await this.#signIn.status(signal);
		this.#current();
		if (
			current.state !== "private" ||
			current.version !== previous.version ||
			current.challenge?.challengeId !== challengeId
		)
			throw new Error("Private sign-in changed");
		await this.#signIn.checkPrivateAccess(current.challenge, signal);
		this.#current();
		return current.challenge;
	}
}
