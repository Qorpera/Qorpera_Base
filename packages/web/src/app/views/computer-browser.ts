import type {
	MemberBrowserGrantStatus,
	MemberBrowserProfileCatalog,
} from "@qorpera/cloud-client/cloud-company-computer-browser-profiles";
import type { CompanyComputerScope } from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { CloudCompanyComputerPrivacyStatus } from "@qorpera/cloud-client/cloud-company-computer-sign-in";
import type { CompanyComputerMemberStatus } from "@qorpera/cloud-client/cloud-company-computer-views";
import type { WebCompanyComputer } from "../../cloud/computer.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import type { ComputerViewHost } from "../../ui/computer-view-host.ts";
import { button, h, replace } from "../../ui/dom.ts";

/** Metadata and explicit consent only. Passwords stay in the private desktop. */
export class ComputerBrowserPanel {
	readonly el = h("section", { class: "stack", "aria-label": "Your browser profiles" });
	readonly #stop = new AbortController();
	#busy = false;
	#poll: ReturnType<typeof setTimeout> | undefined;
	constructor(
		computer: WebCompanyComputer,
		scope: CompanyComputerScope,
		agent: HostedStaffAgent,
		host: ComputerViewHost,
		parentSignal: AbortSignal,
	) {
		const signal = AbortSignal.any([parentSignal, this.#stop.signal]);
		signal.addEventListener(
			"abort",
			() => {
				if (this.#poll) clearTimeout(this.#poll);
				void host.close().catch(() => undefined);
			},
			{ once: true },
		);
		const session = computer.browser(scope, signal);
		let views: ReturnType<WebCompanyComputer["views"]> | undefined;
		try {
			views = computer.views(scope);
		} catch {
			/* Metadata remains available without a viewer endpoint. */
		}
		let profiles: MemberBrowserProfileCatalog | undefined,
			privacy: CloudCompanyComputerPrivacyStatus | undefined,
			screens: CompanyComputerMemberStatus | undefined;
		let pendingRegistration: { profileId: string; label: string } | null = null;
		const status = h("p", { role: "status" }),
			controls = h("div", { class: "stack" });
		const selected = h("select", { "aria-label": "Your browser profile" });
		const target = h("select", { "aria-label": "Agent browser consent" });
		const label = h("input", {
			type: "text",
			maxLength: 80,
			"aria-label": "New browser profile name",
			placeholder: "Browser profile name",
		});
		const consent = h("div", { class: "stack" }),
			preparation = h("div", { class: "stack" });
		this.el.append(
			h("h2", null, "Your browsers"),
			h(
				"p",
				{ class: "muted" },
				"Private sign-in pauses shared viewing. Closing the viewer keeps it private until you finish.",
			),
			status,
			controls,
		);
		const live = () => signal.throwIfAborted();
		const action = async <T>(value: unknown): Promise<T> => {
			const result = await session.action(value, {
				staffIds: [agent.id],
				screens,
				viewingAvailable: Boolean(views),
			});
			live();
			return result as T;
		};
		const run = async (work: () => Promise<void>) => {
			if (this.#busy || signal.aborted) return;
			this.#busy = true;
			controls.inert = true;
			try {
				await work();
			} catch {
				if (!signal.aborted) {
					status.textContent = "Browser access could not be confirmed. Refresh before making another change.";
					replace(
						controls,
						button("Refresh browsers", () => void run(() => refresh())),
					);
				}
			} finally {
				this.#busy = false;
				controls.inert = false;
			}
		};
		const refreshScreens = async () => {
			screens = undefined;
			if (views) {
				const result = await views.status(signal);
				live();
				screens = result;
			}
		};
		const refreshConsent = async () => {
			replace(consent);
			if (!selected.value || !target.value) return;
			const grant = await action<MemberBrowserGrantStatus>({
				method: "browserGrant",
				profileId: selected.value,
				staffAgentId: target.value,
			});
			consent.append(
				h(
					"p",
					{ class: "muted" },
					grant.grant?.state !== "active"
						? "No browser consent for this agent."
						: grant.grant.usable
							? "This agent can use this browser profile."
							: "Consent is recorded but currently unavailable.",
				),
			);
			const occupied =
				grant.profile.activeStaffAgentId !== null && grant.profile.activeStaffAgentId !== grant.staffAgentId;
			if (occupied)
				consent.append(h("p", null, "Revoke the previous agent's consent before assigning this profile."));
			for (const enabled of [true, false])
				consent.append(
					button(
						enabled ? "Allow browser access" : "Revoke browser access",
						() =>
							void run(async () => {
								if (selected.value !== grant.profile.profileId || target.value !== grant.staffAgentId)
									throw new Error("Refresh the selected browser and agent.");
								await action({
									method: "configureBrowser",
									profileId: grant.profile.profileId,
									profileVersion: grant.profile.version,
									staffAgentId: grant.staffAgentId,
									expectedVersion: grant.grant?.version ?? 0,
									enabled,
								});
								await refresh();
							}),
						{
							disabled: enabled
								? !profiles?.canUse ||
									privacy?.state !== "shared" ||
									!grant.profile.prepared ||
									grant.grant?.state === "active" ||
									occupied
								: grant.grant?.state !== "active",
						},
					),
				);
		};
		const renderPreparation = () => {
			replace(preparation);
			const profile = profiles?.profiles.find((profile) => profile.profileId === selected.value);
			if (profile)
				preparation.append(
					h(
						"p",
						{ class: "muted" },
						profile.prepared
							? "Private preparation completed. Check the signed-in account before granting browser access."
							: "Prepare this browser privately before granting access.",
					),
				);
			if (!views) preparation.append(h("p", { class: "muted" }, "Private screen viewing is not configured."));
			for (const screen of screens?.screens.filter((screen) => screen.binding.staffAgentId === agent.id) ?? [])
				preparation.append(
					button(
						`Sign in privately on screen ${screen.binding.screenOrdinal}`,
						() =>
							void run(async () => {
								await host.close();
								live();
								await action({
									method: "beginPrivate",
									profileId: selected.value,
									screenId: screen.binding.screenId,
								});
								await refresh();
							}),
						{
							disabled:
								!views ||
								!profiles?.canUse ||
								!profile ||
								privacy?.state !== "shared" ||
								screens?.state !== "active" ||
								screens.privacyState !== "shared" ||
								screen.drainPending,
						},
					),
				);
			const challenge = privacy?.challenge;
			if (privacy?.state === "private" && challenge && views) {
				const service = views;
				preparation.append(
					button(
						"Open your private browser",
						() =>
							void run(async () => {
								const binding = challenge.drains.find(
									(drain) => drain.binding.screenId === challenge.screenId,
								)?.binding;
								if (!binding) throw new Error("Refresh private browser access.");
								await host.open({
									binding,
									title: "Your private browser sign-in",
									canControl: false,
									privateSignIn: true,
									requestConnection: async (input) =>
										service.connectPrivate({
											challenge: await session.privateChallenge(challenge.challengeId, input.signal),
											signal: input.signal,
										}),
								});
							}),
					),
				);
			}
			if (challenge && (privacy?.state === "entering" || privacy?.state === "private"))
				preparation.append(
					button(
						"Finish private sign-in",
						() =>
							void run(async () => {
								await host.close();
								live();
								await action({ method: "finishPrivate" });
								await refresh();
							}),
					),
				);
		};
		const selectProfile = async () => {
			const profile = profiles?.profiles.find((profile) => profile.profileId === selected.value);
			replace(target, h("option", { value: agent.id }, agent.displayName));
			if (profile?.activeStaffAgentId && profile.activeStaffAgentId !== agent.id) {
				target.append(h("option", { value: profile.activeStaffAgentId }, "Previously assigned agent"));
				target.value = profile.activeStaffAgentId;
			}
			renderPreparation();
			await refreshConsent();
		};
		const refresh = async (after: string | null = null) => {
			if (this.#poll) clearTimeout(this.#poll);
			profiles = undefined;
			privacy = undefined;
			replace(controls);
			replace(consent);
			replace(preparation);
			status.textContent = "Checking your browsers…";
			await refreshScreens();
			privacy = await action<CloudCompanyComputerPrivacyStatus>({ method: "privacy" });
			const result = await action<{
				catalog: MemberBrowserProfileCatalog;
				pendingRegistration: typeof pendingRegistration;
			}>({ method: "profiles", after });
			profiles = result.catalog;
			pendingRegistration = result.pendingRegistration;
			const previous = selected.value;
			replace(
				selected,
				...profiles.profiles.map((profile) => h("option", { value: profile.profileId }, profile.label)),
			);
			if (profiles.profiles.some((profile) => profile.profileId === previous)) selected.value = previous;
			status.textContent =
				privacy.state === "shared"
					? "No private sign-in is active."
					: privacy.state === "private"
						? "Private sign-in is active. Shared viewing is paused."
						: privacy.state === "entering"
							? "Preparing private sign-in. Wait for the computer to confirm privacy."
							: "Finishing private sign-in. Wait for shared viewing to resume.";
			controls.append(
				button("Refresh browsers", () => void run(() => refresh())),
				selected,
				preparation,
				h("label", null, "Browser consent for", target),
				consent,
				h("label", null, "New browser profile", label),
			);
			controls.append(
				button(
					"Create browser profile",
					() =>
						void run(async () => {
							await action({ method: "registerProfile", label: label.value.trim() });
							label.value = "";
							await refresh();
						}),
					{ disabled: !profiles.canUse || privacy.state !== "shared" || Boolean(pendingRegistration) },
				),
			);
			if (pendingRegistration)
				controls.append(
					button(
						`Retry creation of ${pendingRegistration.label}`,
						() =>
							void run(async () => {
								await action({ method: "retryProfile" });
								await refresh();
							}),
						{ disabled: !profiles.canUse || privacy.state !== "shared" },
					),
				);
			if (profiles.nextAfter) {
				const after = profiles.nextAfter;
				controls.append(button("More browser profiles", () => void run(() => refresh(after))));
			}
			await selectProfile();
			if (privacy.state === "entering" || privacy.state === "leaving")
				this.#poll = setTimeout(() => void run(() => refresh()), 1500);
		};
		selected.onchange = () => void run(selectProfile);
		target.onchange = () => void run(refreshConsent);
		void run(() => refresh());
	}
	dispose(): void {
		this.#stop.abort();
		if (this.#poll) clearTimeout(this.#poll);
		this.el.remove();
		this.el.replaceChildren();
	}
}
