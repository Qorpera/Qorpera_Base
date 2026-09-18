import type { CompanyComputerAccessCapabilities } from "@qorpera/cloud-client/cloud-company-computer-access";
import type {
	MemberBrowserGrantStatus,
	MemberBrowserProfileCatalog,
} from "@qorpera/cloud-client/cloud-company-computer-browser-profiles";
import type { CompanyComputerScreenBinding } from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { CompanyComputerPrivacyChallenge } from "@qorpera/cloud-client/cloud-company-computer-privacy";
import type { CloudCompanyComputerPrivacyStatus } from "@qorpera/cloud-client/cloud-company-computer-sign-in";
import type {
	CompanyComputerMemberStatus,
	CompanyComputerMemberView,
} from "@qorpera/cloud-client/cloud-company-computer-views";
import { MemberCompanyBrowserSession } from "@qorpera/cloud-client/member-company-browser-session";
import type { WebCompanySession } from "./account.ts";
import { button, element, input, type Work } from "./dom.ts";

type Viewer = { close(): Promise<void> };
type ViewerOptions = {
	binding: CompanyComputerScreenBinding;
	title: string;
	canControl: boolean;
	privateSignIn: boolean;
	requestConnection(input: {
		binding: CompanyComputerScreenBinding;
		mode: "watch" | "control";
		signal: AbortSignal;
	}): Promise<CompanyComputerMemberView>;
	releaseConnection(input: { connectionId: string }): Promise<void>;
	onClosed(): void;
};
const openViewer = (options: ViewerOptions) =>
	(window as unknown as { qorperaScreenViewer: { open(options: ViewerOptions): Viewer } }).qorperaScreenViewer.open(
		options,
	);

export async function showOfficePanel(options: {
	root: HTMLElement;
	company: WebCompanySession;
	work: Work;
	status(message: string): void;
	current(): void;
}): Promise<() => void> {
	const { root, company, work, status, current } = options,
		stop = new AbortController(),
		signal = AbortSignal.any([stop.signal, company.signal]);
	const live = () => {
		signal.throwIfAborted();
		company.current();
		current();
	};
	let viewer: Viewer | undefined;
	const connections = new Map<string, CompanyComputerMemberView>();
	const close = () => {
		stop.abort();
		void viewer?.close().catch(() => undefined);
		for (const connection of connections.values()) void connection.close().catch(() => undefined);
		connections.clear();
	};
	signal.addEventListener(
		"abort",
		() => {
			void viewer?.close().catch(() => undefined);
		},
		{ once: true },
	);
	try {
		let catalog = await company.computer.catalog(signal);
		live();
		const heading = element("h2", "Company Computer"),
			state = element("p"),
			controls = element("div"),
			access = element("section"),
			screensPanel = element("section"),
			browserPanel = element("section");
		root.replaceChildren(heading, state, controls, access, screensPanel, browserPanel);
		if (!catalog.scope) {
			state.textContent = "A shared computer has not been provisioned for this company.";
			return close;
		}
		const scope = { ...catalog.scope },
			startClient = company.computer.start(scope);
		let start = await startClient.status(signal);
		live();
		let startId: string | undefined;
		const renderStart = () => {
			state.textContent = `Computer: ${start.officeState}${start.intent ? ` · ${start.intent.state}` : ""}. Closing this page preserves its current state.`;
			controls.replaceChildren(
				button(
					"Refresh computer status",
					async () => {
						start = await startClient.status(signal);
						live();
						renderStart();
					},
					work,
				),
			);
			if (catalog.canManage && start.officeState === "provisioning" && !start.intent)
				controls.append(
					button(
						"Start computer",
						async () => {
							startId ??= crypto.randomUUID();
							await startClient.request(start.computerGeneration, startId, signal);
							live();
							start = await startClient.status(signal);
							live();
							renderStart();
						},
						work,
					),
				);
			if (catalog.canManage && start.intent && start.intent.state !== "cancelled" && start.officeState !== "active")
				controls.append(
					button(
						"Cancel pending start",
						async () => {
							await startClient.cancel(start.intent!, signal);
							live();
							start = await startClient.status(signal);
							live();
							renderStart();
						},
						work,
					),
				);
		};
		renderStart();
		const staff = element("select");
		staff.setAttribute("aria-label", "Agent computer access");
		const renderStaff = () => {
			staff.replaceChildren(
				...catalog.staff.map((agent) => {
					const option = element("option", agent.name);
					option.value = agent.staffAgentId;
					return option;
				}),
			);
		};
		renderStaff();
		const grantDetails = element("div");
		async function grantStatus() {
			grantDetails.replaceChildren();
			if (!catalog.canManage || !staff.value) return;
			const target = company.computer.access(scope, staff.value),
				observed = await target.status(signal);
			live();
			const desktop = element("input"),
				shell = element("input");
			desktop.type = shell.type = "checkbox";
			desktop.checked = observed.grant?.capabilities.some((value) => value === "desktop") ?? false;
			shell.checked = observed.grant?.capabilities.some((value) => value === "shell") ?? false;
			grantDetails.append(
				element(
					"p",
					observed.grant?.state === "active"
						? "This agent has the selected access."
						: "No active computer access.",
				),
				element("label", "Desktop", desktop),
				element("label", "Shell", shell),
			);
			for (const enabled of [true, false]) {
				const action = button(
					enabled ? "Update agent access" : "Revoke agent access",
					async () => {
						const capabilities = (
							enabled
								? [...(desktop.checked ? ["desktop"] : []), ...(shell.checked ? ["shell"] : [])]
								: observed.grant!.capabilities
						) as CompanyComputerAccessCapabilities;
						if (!capabilities.length) throw new Error("Select desktop or shell access");
						await target.configure(
							{ enabled, expectedVersion: observed.grant?.version ?? 0, capabilities },
							signal,
						);
						live();
						await grantStatus();
					},
					work,
				);
				action.disabled = !enabled && observed.grant?.state !== "active";
				grantDetails.append(action);
			}
		}
		staff.onchange = () => {
			void work(grantStatus);
		};
		access.hidden = !catalog.canManage;
		access.append(
			element("h2", "Agent access"),
			staff,
			button("Refresh agent access", grantStatus, work),
			grantDetails,
		);
		const moreStaff = button(
			"More agents",
			async () => {
				if (!catalog.nextAfter) return;
				const next = await company.computer.catalog(signal, catalog.nextAfter);
				live();
				if (
					next.scope?.companyComputerId !== scope.companyComputerId ||
					next.scope.logicalComputerId !== scope.logicalComputerId
				)
					throw new Error("Reopen this computer to refresh its identity");
				catalog = next;
				renderStaff();
				moreStaff.hidden = !catalog.nextAfter;
				await grantStatus();
				await profileChanged();
			},
			work,
		);
		moreStaff.hidden = !catalog.nextAfter;
		root.append(moreStaff);
		await grantStatus();
		let views: ReturnType<WebCompanySession["views"]> | undefined;
		try {
			views = company.views(scope);
		} catch {
			screensPanel.append(element("p", "Cloud screen viewing has not been configured."));
		}
		let screens: CompanyComputerMemberStatus | undefined;
		const browserSession = new MemberCompanyBrowserSession({
			profiles: company.computer.browserProfiles(scope, company.memberId),
			signIn: company.computer.signIn(scope, company.memberId),
			current: live,
			signal,
		});
		const browserAction = async <T>(value: unknown): Promise<T> => {
			const result = await browserSession.action(value, {
				staffIds: catalog.staff.map((agent) => agent.staffAgentId),
				screens,
				viewingAvailable: Boolean(views),
			});
			live();
			return result as T;
		};
		const connect = (binding: CompanyComputerScreenBinding, challenge?: CompanyComputerPrivacyChallenge) => {
			if (viewer || !views) return;
			const service = views;
			viewer = openViewer({
				binding,
				title: challenge ? "Your private browser sign-in" : `Company Computer · Screen ${binding.screenOrdinal}`,
				canControl: catalog.canManage,
				privateSignIn: Boolean(challenge),
				requestConnection: async (input) => {
					live();
					const requestSignal = AbortSignal.any([signal, input.signal]);
					const connection = challenge
						? await service.connectPrivate({
								challenge: await browserSession.privateChallenge(challenge.challengeId, requestSignal),
								signal: requestSignal,
							})
						: await service.connectScreen({ ...input, signal: requestSignal });
					try {
						live();
						requestSignal.throwIfAborted();
						connections.set(connection.connectionId, connection);
						return connection;
					} catch (error) {
						void connection.close();
						throw error;
					}
				},
				releaseConnection: async ({ connectionId }) => {
					const connection = connections.get(connectionId);
					connections.delete(connectionId);
					await connection?.close();
				},
				onClosed: () => {
					viewer = undefined;
					if (!signal.aborted) status("Viewer closed. The Company Computer remains running.");
				},
			});
		};
		async function refreshScreens() {
			if (!views) return;
			screens = undefined;
			const result = await views.status(signal);
			live();
			screens = result;
			screensPanel.replaceChildren(element("h2", "Cloud screens"), button("Refresh screens", refreshScreens, work));
			if (result.privacyState !== "shared")
				screensPanel.append(
					element("p", "Private browser sign-in is active or transitioning. Shared viewing is unavailable."),
				);
			else
				for (const screen of result.screens) {
					const action = button(
						`Watch screen ${screen.binding.screenOrdinal} · ${catalog.staff.find((agent) => agent.staffAgentId === screen.binding.staffAgentId)?.name ?? "Agent"}`,
						async () => connect(screen.binding),
						work,
					);
					action.disabled = result.state !== "active";
					screensPanel.append(action);
				}
			for (const connection of result.viewers)
				screensPanel.append(
					button(
						`Cancel ${connection.mode} connection · ${connection.viewerSessionId.slice(-8)}`,
						async () => {
							await views!.cancel(connection.viewerSessionId, signal);
							live();
							await refreshScreens();
						},
						work,
					),
				);
		}
		await refreshScreens();
		let profiles: MemberBrowserProfileCatalog | undefined, privacy: CloudCompanyComputerPrivacyStatus | undefined;
		const profileSelect = element("select"),
			agentSelect = element("select"),
			profileLabel = input("New browser profile name"),
			profileStatus = element("p"),
			browserControls = element("div"),
			consent = element("div");
		profileSelect.setAttribute("aria-label", "Your browser profile");
		agentSelect.setAttribute("aria-label", "Agent browser consent");
		profileLabel.input.maxLength = 80;
		let pendingRegistration: { profileId: string; label: string } | null = null;
		async function grantBrowser() {
			consent.replaceChildren();
			if (!profileSelect.value || !agentSelect.value) return;
			const grant = await browserAction<MemberBrowserGrantStatus>({
				method: "browserGrant",
				profileId: profileSelect.value,
				staffAgentId: agentSelect.value,
			});
			consent.append(
				element(
					"p",
					grant.grant?.state !== "active"
						? "This agent has no browser consent."
						: grant.grant.usable
							? "Consent allows this agent to use this browser profile."
							: "Consent is recorded but currently unusable.",
				),
			);
			for (const enabled of [true, false]) {
				const action = button(
					enabled ? "Allow agent to use this browser" : "Revoke browser consent",
					async () => {
						await browserAction({
							method: "configureBrowser",
							profileId: grant.profile.profileId,
							profileVersion: grant.profile.version,
							staffAgentId: grant.staffAgentId,
							expectedVersion: grant.grant?.version ?? 0,
							enabled,
						});
						await refreshBrowser();
					},
					work,
				);
				action.disabled = enabled
					? !profiles?.canUse ||
						privacy?.state !== "shared" ||
						!grant.profile.prepared ||
						grant.grant?.state === "active"
					: grant.grant?.state !== "active";
				consent.append(action);
			}
		}
		async function profileChanged() {
			const profile = profiles?.profiles.find((profile) => profile.profileId === profileSelect.value);
			agentSelect.replaceChildren();
			const agents = [...catalog.staff];
			if (profile?.activeStaffAgentId && !agents.some((agent) => agent.staffAgentId === profile.activeStaffAgentId))
				agents.push({ staffAgentId: profile.activeStaffAgentId, name: "Previously assigned agent" });
			for (const agent of agents) {
				const option = element("option", agent.name);
				option.value = agent.staffAgentId;
				agentSelect.append(option);
			}
			if (profile?.activeStaffAgentId) agentSelect.value = profile.activeStaffAgentId;
			profileStatus.textContent = profile?.prepared
				? "Private preparation completed. Check the account inside the browser before giving consent."
				: "This profile needs private preparation before agent use.";
			renderBrowserControls();
			await grantBrowser();
		}
		function renderBrowserControls() {
			browserControls.replaceChildren();
			const profile = profiles?.profiles.find((profile) => profile.profileId === profileSelect.value);
			const register = button(
				"Create browser profile",
				async () => {
					await browserAction({ method: "registerProfile", label: profileLabel.input.value });
					profileLabel.input.value = "";
					await refreshBrowser();
				},
				work,
			);
			register.disabled = !profiles?.canUse || privacy?.state !== "shared" || Boolean(pendingRegistration);
			browserControls.append(register);
			if (pendingRegistration)
				browserControls.append(
					button(
						`Retry creation of ${pendingRegistration.label}`,
						async () => {
							await browserAction({ method: "retryProfile" });
							await refreshBrowser();
						},
						work,
					),
				);
			for (const screen of screens?.screens ?? []) {
				const begin = button(
					`Sign in privately on screen ${screen.binding.screenOrdinal}`,
					async () => {
						await browserAction({
							method: "beginPrivate",
							profileId: profileSelect.value,
							screenId: screen.binding.screenId,
						});
						await refreshScreens();
						await refreshBrowser();
					},
					work,
				);
				begin.disabled =
					!views ||
					!profiles?.canUse ||
					!profile ||
					privacy?.state !== "shared" ||
					screens?.privacyState !== "shared";
				browserControls.append(begin);
			}
			if (privacy?.state === "private" && privacy.challenge && views) {
				const challenge = privacy.challenge;
				browserControls.append(
					button(
						"Open your private browser",
						async () =>
							connect(
								challenge.drains.find((drain) => drain.binding.screenId === challenge.screenId)!.binding,
								challenge,
							),
						work,
					),
				);
			}
			if (privacy?.challenge && ["entering", "private"].includes(privacy.state))
				browserControls.append(
					button(
						"Finish private sign-in",
						async () => {
							await browserAction({ method: "finishPrivate" });
							await refreshScreens();
							await refreshBrowser();
						},
						work,
					),
				);
		}
		async function refreshBrowser(after: string | null = null) {
			profiles = undefined;
			privacy = undefined;
			consent.replaceChildren();
			privacy = await browserAction<CloudCompanyComputerPrivacyStatus>({ method: "privacy" });
			const result = await browserAction<{
				catalog: MemberBrowserProfileCatalog;
				pendingRegistration: typeof pendingRegistration;
			}>({ method: "profiles", after });
			profiles = result.catalog;
			pendingRegistration = result.pendingRegistration;
			profileSelect.replaceChildren(
				...profiles.profiles.map((profile) => {
					const option = element("option", profile.label);
					option.value = profile.profileId;
					return option;
				}),
			);
			browserPanel.replaceChildren(
				element("h2", "Your browser profiles"),
				element(
					"p",
					`Privacy: ${privacy.state}. Closing a viewer keeps private sign-in active until you explicitly finish.`,
				),
				button(
					"Refresh browser status",
					async () => {
						await refreshScreens();
						await refreshBrowser();
					},
					work,
				),
				profileSelect,
				profileStatus,
				profileLabel.label,
				browserControls,
				agentSelect,
				consent,
			);
			if (profiles.nextAfter)
				browserPanel.append(button("More browser profiles", async () => refreshBrowser(profiles!.nextAfter), work));
			await profileChanged();
		}
		profileSelect.onchange = () => {
			void work(profileChanged);
		};
		agentSelect.onchange = () => {
			void work(grantBrowser);
		};
		await refreshBrowser();
		return close;
	} catch (error) {
		close();
		throw error;
	}
}
