import type { User } from "@supabase/supabase-js";
import { CloudApi } from "../cloud/api.ts";
import { type Cloud, describeError } from "../cloud/client.ts";
import { WebCompanyFiles } from "../cloud/company-files.ts";
import { WebCompanyComputer } from "../cloud/computer.ts";
import { createWebNativeSubscription } from "../cloud/native-subscription.ts";
import { createWebSessionAttachments } from "../cloud/session-attachments.ts";
import { createWebSessionInputWriter } from "../cloud/session-input.ts";
import { createWebSessionRunControl } from "../cloud/session-run-control.ts";
import type { HostedProfile } from "../cloud/types.ts";
import { h, notice, replace, spinner } from "../ui/dom.ts";
import { applyLanguage } from "../ui/preferences.ts";
import { RailLayout } from "../ui/rail-layout.ts";
import { AuthController } from "./auth.ts";
import { CompanyController } from "./company.ts";
import { currentRoute, navigate, type Route } from "./router.ts";
import { debounce } from "./state.ts";
import { type AccountViewState, renderAccount } from "./views/account.ts";
import { ApprovalsView } from "./views/approvals.ts";
import { BrowserRecoveryView } from "./views/browser-recovery.ts";
import { CloudCheckView } from "./views/cloudcheck.ts";
import { CompanyFileController, renderCompanyFile } from "./views/companyfile.ts";
import { ConversationView } from "./views/conversation.ts";
import { FeedbackView } from "./views/feedback.ts";
import { FriendsController, renderFriends } from "./views/friends.ts";
import { HubController, renderHub } from "./views/hub.ts";
import { renderInvitations } from "./views/invitations.ts";
import { LiveCompanyFileView } from "./views/live-company-file.ts";
import { type MeetState, renderMeet } from "./views/meet.ts";
import { NewConversationView } from "./views/new-conversation.ts";
import { renderOrganization } from "./views/organization.ts";
import { SettingsView } from "./views/settings.ts";
import { renderRail, renderTopbar, type ShellContext } from "./views/shell.ts";
import { renderSignIn } from "./views/signin.ts";
import { renderTeam } from "./views/team.ts";
import type { WorkspaceActions } from "./workspace-actions.ts";

/* Entry point. One cloud client, one auth controller, one company controller
 * at a time. The route decides the view; every view renders from cloud state
 * and re-renders on store changes. */

export function mountApplication(
	root: HTMLElement,
	cloud: Cloud,
	api = new CloudApi(cloud),
	workspaceActions: WorkspaceActions = {},
): () => void {
	const auth = new AuthController(cloud);
	let hub = new HubController(api);
	let friends = new FriendsController(api);

	const topbar = h("header", { class: "topbar" });
	const rail = h("aside", { id: "company-navigation", class: "rail", "aria-label": "Company navigation" });
	const main = h("main", { class: "main" });
	const backdrop = h("button", {
		type: "button",
		class: "navigation-backdrop",
		"aria-label": "Close company navigation",
		onclick: () => setNavigationOpen(false),
	});
	const frame = h("div", { class: "frame" }, topbar, h("div", { class: "body" }, backdrop, rail, main));
	const railLayout = new RailLayout(frame);
	rail.after(railLayout.el);
	applyLanguage();
	window.addEventListener("languagechange", applyLanguage);
	let disposed = false;
	let settings: SettingsView | undefined;
	let feedback: FeedbackView | undefined;
	function closeFeedback(restoreFocus = true): void {
		if (!feedback) return;
		feedback.dispose();
		feedback = undefined;
		if (restoreFocus) frame.querySelector<HTMLElement>(".account-trigger")?.focus();
	}
	function openFeedback(): void {
		if (feedback || settings || !auth.userId) return;
		feedback = new FeedbackView(api, () => closeFeedback());
		root.append(feedback.el);
		feedback.open();
	}
	function closeSettings(restoreFocus = true): void {
		settings?.dispose();
		settings = undefined;
		frame.inert = false;
		if (restoreFocus) frame.querySelector<HTMLElement>(".account-trigger")?.focus();
	}
	function openSettings(): void {
		if (settings || feedback || !auth.userId) return;
		settings = new SettingsView(
			api,
			auth,
			profiles,
			company?.store.get().accessLost ? undefined : company,
			() => closeSettings(),
			companyRemovedHandler(),
		);
		frame.inert = true;
		root.append(settings.el);
		settings.focus();
	}
	let routeRevision = 0;
	let accountRevision = 0;
	let accountUserId: string | undefined;
	let navigationOpen = false;
	let navigationFocus: "rail" | "toggle" | undefined;
	let unsubscribeFile: (() => void) | undefined;
	let pendingCompany:
		| { profileId: string; revision: number; promise: Promise<CompanyController | undefined> }
		| undefined;
	let resolvingRoute: number | undefined;
	let routeError: string | undefined;
	function captureRoute(): () => boolean {
		const revision = routeRevision,
			userId = auth.userId,
			hash = location.hash;
		return () => !disposed && revision === routeRevision && userId === auth.userId && hash === location.hash;
	}
	function setNavigationOpen(open: boolean, restoreFocus = true): void {
		navigationFocus = restoreFocus ? (open ? "rail" : navigationOpen ? "toggle" : undefined) : undefined;
		navigationOpen = open;
		frame.classList.toggle("navigation-open", open);
		syncNavigation();
		render();
	}
	function syncNavigation(): void {
		main.inert = navigationOpen && window.matchMedia("(max-width: 760px)").matches;
	}
	function onEscape(event: KeyboardEvent): void {
		if (event.key === "Escape" && navigationOpen && !settings && !feedback && !event.defaultPrevented) {
			setNavigationOpen(false);
		}
	}
	function onRouteChange(): void {
		if (liveFile && liveFile.routeHash !== location.hash) {
			const message = liveFile.leaveMessage();
			if (message && !window.confirm(message)) {
				history.replaceState(null, "", liveFile.routeHash);
				return;
			}
			liveFile.dispose();
			liveFile = undefined;
		}
		closeSettings(false);
		browserRecovery?.dispose();
		browserRecovery = undefined;
		closeFeedback(false);
		routeRevision++;
		resolvingRoute = undefined;
		routeError = undefined;
		homeReason = undefined;
		setNavigationOpen(false, false);
	}
	window.addEventListener("keydown", onEscape);
	window.addEventListener("resize", syncNavigation);

	let company: CompanyController | undefined;
	let computer: WebCompanyComputer | undefined;
	let companyFile: CompanyFileController | undefined;
	let liveFile: LiveCompanyFileView | undefined;
	let conversation: ConversationView | undefined;
	let newConversation: NewConversationView | undefined;
	let approvals: ApprovalsView | undefined;
	let cloudCheck: CloudCheckView | undefined;
	let browserRecovery: BrowserRecoveryView | undefined;
	let profiles: HostedProfile[] = [];
	let teamFeedback: { message?: string; error?: string } = {};
	let accountState: AccountViewState = {};
	let meetState: MeetState = {};
	let unsubscribeCompany: (() => void) | undefined;
	let homeReason: string | undefined;
	let friendsLoaded = false;

	const render = debounce(() => void draw(), 10);

	function observeAccount(): void {
		const currentHub = hub;
		hub.store.subscribe(() => {
			if (hub !== currentHub) return;
			profiles = currentHub.store.get().profiles;
			settings?.updateProfiles(profiles);
			render();
		});
		friends.store.subscribe(() => render());
	}
	observeAccount();
	auth.store.subscribe(() => {
		const userId = auth.userId;
		if (userId !== accountUserId) {
			closeSettings(false);
			closeFeedback(false);
			accountUserId = userId;
			accountRevision++;
			routeRevision++;
			teardownCompany();
			hub.dispose();
			friends.dispose();
			cloudCheck?.dispose();
			cloudCheck = undefined;
			browserRecovery?.dispose();
			browserRecovery = undefined;
			profiles = [];
			accountState = {};
			friendsLoaded = false;
			meetState = {};
			resolvingRoute = undefined;
			routeError = undefined;
			navigationOpen = false;
			navigationFocus = undefined;
			syncNavigation();
			frame.classList.remove("navigation-open");
			topbar.replaceChildren();
			rail.replaceChildren();
			main.replaceChildren();
			hub = new HubController(api, userId);
			friends = new FriendsController(api);
			observeAccount();
			if (userId) void hub.refresh();
		}
		render();
	});
	window.addEventListener("hashchange", onRouteChange);

	function shellContext(user: User | null, route: Route): ShellContext {
		return {
			profiles,
			user,
			route,
			auth,
			openSettings,
			openFeedback,
			invitations: hub.store.get().invitations.length,
			...(route.name === "company" && route.section !== "meet" && company && !company.store.get().accessLost
				? { navigation: { open: navigationOpen, toggle: () => setNavigationOpen(!navigationOpen) } }
				: {}),
		};
	}

	function teardownCompany(): void {
		unsubscribeCompany?.();
		unsubscribeFile?.();
		conversation?.dispose();
		newConversation?.dispose();
		approvals?.dispose();
		companyFile?.dispose();
		liveFile?.dispose();
		liveFile = undefined;
		company?.stop();
		pendingCompany = undefined;
		company = undefined;
		computer = undefined;
		companyFile = undefined;
		conversation = undefined;
		newConversation = undefined;
		approvals = undefined;
		homeReason = undefined;
		teamFeedback = {};
		meetState = {};
	}

	function companyRemovedHandler(): (profileId: string) => void {
		const currentHub = hub;
		return (profileId) => {
			if (disposed || hub !== currentHub) return;
			void currentHub.companyRemoved(profileId);
			const route = currentRoute();
			if (route.name === "company" && route.profileId === profileId) {
				closeSettings(false);
				teardownCompany();
				navigate({ name: "hub" });
			}
		};
	}

	async function ensureCompany(profileId: string): Promise<CompanyController | undefined> {
		if (company?.profile.profileId === profileId) return company;
		if (pendingCompany?.profileId === profileId && pendingCompany.revision === routeRevision)
			return pendingCompany.promise;
		teardownCompany();
		const current = captureRoute();
		const currentHub = hub;
		const promise = (async () => {
			let profile = profiles.find((item) => item.profileId === profileId);
			if (!profile) {
				await currentHub.refresh();
				if (!current()) return undefined;
				profile = currentHub.store.get().profiles.find((item) => item.profileId === profileId);
			}
			const userId = auth.userId;
			if (!current() || !profile || !userId) return undefined;
			const controller = new CompanyController(
				api,
				profile,
				userId,
				(sessionId, clientInputId, text, signal, files, executionSponsor) =>
					createWebSessionInputWriter(
						cloud,
						userId,
						controller.signal,
						(target) => {
							const route = currentRoute();
							if (
								disposed ||
								company !== controller ||
								auth.userId !== userId ||
								route.name !== "company" ||
								route.profileId !== profile.profileId ||
								route.section !== "chat" ||
								route.id !== target
							)
								throw new Error("Company access is unavailable.");
							controller.assertCanSend(target);
						},
						profile.profileId,
					)(sessionId, clientInputId, text, signal, files, executionSponsor),
			);
			company = controller;
			computer = new WebCompanyComputer(cloud, profile, userId, controller.signal, () => {
				if (disposed || company !== controller || auth.userId !== userId || controller.store.get().accessLost)
					throw new Error("Company access is unavailable.");
			});
			companyFile = new CompanyFileController(api, controller);
			unsubscribeCompany = controller.store.subscribe(() => render());
			unsubscribeFile = companyFile.store.subscribe(() => render());
			void controller.start();
			return controller;
		})();
		pendingCompany = { profileId, revision: routeRevision, promise };
		return promise;
	}

	async function resolveHome(controller: CompanyController): Promise<void> {
		if (resolvingRoute === routeRevision) return;
		const revision = routeRevision;
		const current = captureRoute();
		resolvingRoute = revision;
		try {
			const result = await controller.openCofounderConversation();
			if (!current() || company !== controller) return;
			if (result.sessionId)
				navigate(
					{ name: "company", profileId: controller.profile.profileId, section: "chat", id: result.sessionId },
					true,
				);
			else {
				homeReason = result.reason;
				render();
			}
		} finally {
			if (resolvingRoute === revision) resolvingRoute = undefined;
		}
	}

	async function resolveStaff(controller: CompanyController, staffId: string): Promise<void> {
		if (resolvingRoute === routeRevision) return;
		const revision = routeRevision;
		const current = captureRoute();
		resolvingRoute = revision;
		try {
			const agent = controller.staffById(staffId);
			if (!agent) throw new Error("This agent is not available in the company.");
			const sessionId = await controller.openStaffConversation(agent);
			if (current() && company === controller)
				navigate(
					{ name: "company", profileId: controller.profile.profileId, section: "chat", id: sessionId },
					true,
				);
		} catch (error) {
			if (current() && company === controller) {
				routeError = describeError(error);
				render();
			}
		} finally {
			if (resolvingRoute === revision) resolvingRoute = undefined;
		}
	}

	async function draw(): Promise<void> {
		if (disposed) return;
		const current = captureRoute();
		const authState = auth.store.get();
		if (!authState.ready) {
			replace(root!, spinner("Connecting to the cloud"));
			return;
		}
		if (!authState.session) {
			teardownCompany();
			const container = h("div", { class: "brand-field" });
			replace(root!, container);
			renderSignIn(auth, container);
			return;
		}
		if (!root!.contains(frame)) replace(root!, frame);
		const route: Route = currentRoute();
		frame.classList.toggle(
			"has-thread",
			route.name === "company" && (route.section === "chat" || route.section === "new"),
		);
		if (route.name !== "company") {
			teardownCompany();
			rail.hidden = true;
			renderTopbar(topbar, shellContext(authState.user, route), undefined);
			if (route.name === "hub") {
				renderHub(hub, main);
			} else if (route.name === "account") {
				const revision = accountRevision;
				if (!accountState.loading && !accountState.loaded) {
					accountState.loading = true;
					void api
						.getAccountEntitlement()
						.then((entitlement) => {
							if (disposed || accountRevision !== revision) return;
							accountState = { ...accountState, loading: false, loaded: true, entitlement };
							render();
						})
						.catch((error) => {
							if (disposed || accountRevision !== revision) return;
							accountState = { ...accountState, loading: false, loaded: true, error: describeError(error) };
							render();
						});
				}
				renderAccount(auth, main, accountState, (next) => {
					if (disposed || accountRevision !== revision) return;
					accountState = { ...accountState, ...next };
					render();
				});
			} else if (route.name === "browser-access") {
				browserRecovery ??= new BrowserRecoveryView(cloud, auth.userId!, () => {
					if (!current()) throw new Error("Account or browser access view changed.");
				});
				if (!main.contains(browserRecovery.el)) replace(main, browserRecovery.el);
			} else if (route.name === "friends") {
				if (!friendsLoaded) {
					friendsLoaded = true;
					void friends.refresh();
				}
				renderFriends(friends, main);
			} else if (route.name === "invitations") {
				renderInvitations(hub, main);
			} else if (route.name === "cloud-check") {
				cloudCheck ??= new CloudCheckView(cloud);
				replace(main, cloudCheck.el);
			}
			return;
		}
		const controller = await ensureCompany(route.profileId);
		if (!current()) return;
		if (!controller) {
			rail.hidden = true;
			renderTopbar(topbar, shellContext(authState.user, route), undefined);
			replace(
				main,
				h(
					"section",
					{ class: "page" },
					notice("danger", "This company is not available to your account."),
					h("a", { href: "#/" }, "Back to companies"),
				),
			);
			return;
		}
		// First run is a moment, not a workspace: the rail stays away until the
		// Co-Founder has a face.
		rail.hidden = route.section === "meet" || controller.store.get().accessLost === true;
		const context = shellContext(authState.user, route);
		renderTopbar(topbar, context, rail.hidden ? undefined : controller);
		if (!rail.hidden) renderRail(rail, controller, context);
		if (navigationFocus) {
			const target =
				navigationFocus === "rail"
					? rail.querySelector<HTMLInputElement>("input")
					: (frame.querySelector<HTMLButtonElement>(".main .mobile-navigation-toggle:not([hidden])") ??
						topbar.querySelector<HTMLButtonElement>(".mobile-navigation-toggle"));
			target?.focus();
			navigationFocus = undefined;
		}
		const state = controller.store.get();
		if (state.accessLost) {
			liveFile?.dispose();
			liveFile = undefined;
			closeSettings(false);
			companyFile?.dispose();
			conversation?.dispose();
			newConversation?.dispose();
			approvals?.dispose();
			navigationOpen = false;
			navigationFocus = undefined;
			syncNavigation();
			frame.classList.remove("navigation-open");
			replace(
				main,
				h(
					"section",
					{ class: "page" },
					notice("danger", "Your access to this company was revoked."),
					h("a", { href: "#/" }, "Back to companies"),
				),
			);
			return;
		}
		if (route.section !== "chat") {
			conversation?.dispose();
			conversation = undefined;
			controller.setOpenSession(undefined);
		}
		if (route.section !== "new") {
			newConversation?.dispose();
			newConversation = undefined;
		}
		if (route.section !== "approvals") {
			approvals?.dispose();
			approvals = undefined;
		}
		if (route.section !== "meet") meetState = {};
		switch (route.section) {
			case "new": {
				if (!newConversation) {
					newConversation = new NewConversationView(
						controller,
						workspaceActions,
						() => navigate({ name: "company", profileId: controller.profile.profileId, section: "home" }),
						() => setNavigationOpen(!navigationOpen),
					);
					replace(main, newConversation.el);
					newConversation.focus();
				}
				newConversation.setNavigationOpen(navigationOpen);
				return;
			}
			case "home": {
				// Home needs organization, membership and sessions, not just staff.
				if (state.loading) {
					replace(main, spinner("Opening company"));
					return;
				}
				if (!homeReason) {
					replace(main, spinner("Opening the Co-Founder"));
					void resolveHome(controller);
					return;
				}
				const first = state.hierarchy.primary.find((node) => node.kind === "agent");
				replace(
					main,
					h(
						"section",
						{ class: "page" },
						h("h1", null, controller.profile.profileName),
						notice("neutral", homeReason),
						first
							? h(
									"p",
									null,
									"Start with ",
									h(
										"a",
										{ href: `#/c/${controller.profile.profileId}/staff/${first.canonicalId}` },
										first.label,
									),
									" or pick a conversation in the rail.",
								)
							: h("p", { class: "muted" }, "This company has no staff conversations yet."),
					),
				);
				return;
			}
			case "chat": {
				if (!conversation || conversation.sessionId !== route.id) {
					conversation?.dispose();
					const checkConversationAccess = (sessionId = route.id) => {
						const selected = currentRoute(),
							state = controller.store.get();
						const session = state.sessions.find((item) => item.sessionId === sessionId);
						if (
							disposed ||
							company !== controller ||
							auth.userId !== controller.userId ||
							state.accessLost ||
							!state.team?.capabilities.read ||
							!session ||
							session.profileId !== controller.profile.profileId ||
							session.environmentId !== controller.profile.environmentId ||
							(session.audience.kind === "member_private" && session.audience.userId !== controller.userId) ||
							selected.name !== "company" ||
							selected.profileId !== controller.profile.profileId ||
							selected.section !== "chat" ||
							selected.id !== sessionId
						)
							throw new Error("Conversation access changed.");
					};
					conversation = new ConversationView(
						controller,
						route.id ?? "",
						{
							sendMessage: (id, text, signal) => controller.sendPrompt(id, text, signal),
							nativeSubscription: createWebNativeSubscription(
								cloud,
								controller.profile.profileId,
								controller.userId,
								controller.signal,
								checkConversationAccess,
							),
							runControl: createWebSessionRunControl(
								cloud,
								controller.userId,
								controller.signal,
								checkConversationAccess,
							),
							previewAttachment: async (messageId, index, viewSignal) => {
								const signal = AbortSignal.any([controller.signal, viewSignal]);
								const check = () => {
									signal.throwIfAborted();
									const selected = currentRoute(),
										state = controller.store.get();
									const session = state.sessions.find((item) => item.sessionId === route.id);
									if (
										disposed ||
										company !== controller ||
										auth.userId !== controller.userId ||
										state.accessLost ||
										!state.team?.capabilities.read ||
										!session ||
										session.profileId !== controller.profile.profileId ||
										session.environmentId !== controller.profile.environmentId ||
										(session.audience.kind === "member_private" &&
											session.audience.userId !== controller.userId) ||
										selected.name !== "company" ||
										selected.profileId !== controller.profile.profileId ||
										selected.section !== "chat" ||
										selected.id !== route.id
									)
										throw new Error("Attachment access changed.");
								};
								check();
								const message = controller
									.conversation(route.id!)
									.get()
									.projection.items.find((item) => item.id === messageId);
								const ref =
									message?.kind === "member" && !message.pending && Number.isSafeInteger(index) && index >= 0
										? message.attachments?.[index]?.reference
										: undefined;
								if (!ref) throw new Error("This attachment is not available for preview.");
								const bytes = await createWebSessionAttachments(cloud, controller.userId, signal, check).read(
									route.id!,
									messageId,
									ref,
									signal,
								);
								check();
								return new Blob([Uint8Array.from(bytes)], { type: ref.mediaType });
							},
							...workspaceActions,
							computer,
						},
						() => setNavigationOpen(!navigationOpen),
					);
					replace(main, conversation.el);
					conversation.focus();
				} else conversation.update();
				conversation.setNavigationOpen(navigationOpen);
				return;
			}
			case "staff": {
				if (state.loading) {
					replace(main, spinner("Opening company"));
					return;
				}
				if (routeError) {
					replace(main, notice("danger", routeError));
					return;
				}
				replace(main, spinner("Opening conversation"));
				void resolveStaff(controller, route.id ?? "");
				return;
			}
			case "approvals": {
				if (!approvals) {
					approvals = new ApprovalsView(controller);
					replace(main, approvals.el);
				} else approvals.update();
				return;
			}
			case "file": {
				if (route.id === "history") {
					if (!companyFile) return;
					companyFile.start();
					renderCompanyFile(companyFile, controller, main, {});
					return;
				}
				if (state.loading || !state.team) {
					replace(main, spinner("Checking Company File access"));
					return;
				}
				const authorityKey = JSON.stringify([
					state.team.role,
					state.team.capabilities.read,
					state.team.capabilities.write,
				]);
				if (!liveFile || liveFile.authorityKey !== authorityKey) {
					liveFile?.dispose();
					const stop = new AbortController();
					const files = new WebCompanyFiles(
						cloud,
						controller.profile,
						controller.userId,
						state.team.role,
						AbortSignal.any([stop.signal, controller.signal]),
						() => {
							const selected = currentRoute(),
								team = controller.store.get().team;
							if (
								disposed ||
								company !== controller ||
								auth.userId !== controller.userId ||
								controller.store.get().accessLost ||
								!team?.capabilities.read ||
								JSON.stringify([team.role, team.capabilities.read, team.capabilities.write]) !== authorityKey ||
								selected.name !== "company" ||
								selected.profileId !== controller.profile.profileId ||
								selected.section !== "file" ||
								selected.id
							)
								throw new Error("Company File access changed.");
						},
						state.team.capabilities.write,
					);
					liveFile = new LiveCompanyFileView(files, stop, controller.profile.profileId, authorityKey, () => {
						if (stop.signal.aborted) return;
						liveFile?.dispose();
						liveFile = undefined;
						render();
					});
				}
				if (!main.contains(liveFile.el)) replace(main, liveFile.el);
				return;
			}
			case "snapshot":
			case "proposal": {
				if (!companyFile) return;
				companyFile.start();
				renderCompanyFile(companyFile, controller, main, {
					...(route.section === "snapshot" ? { snapshotId: route.id } : {}),
					...(route.section === "proposal" ? { proposalId: route.id } : {}),
				});
				return;
			}
			case "meet":
				renderMeet(controller, api, main, meetState, (next) => {
					if (!current() || company !== controller) return;
					meetState = next;
					render();
				});
				return;
			case "organization":
			case "responsibility":
			case "project":
				renderOrganization(
					controller,
					main,
					route.section === "organization" ? undefined : { kind: route.section, id: route.id ?? "" },
				);
				return;
			case "team":
				renderTeam(
					api,
					controller,
					main,
					teamFeedback,
					(next) => {
						if (!current() || company !== controller) return;
						teamFeedback = next;
						render();
					},
					{ onCompanyRemoved: companyRemovedHandler() },
				);
				return;
		}
	}

	void auth.start().then(() => {
		render();
	});

	return () => {
		disposed = true;
		railLayout.dispose();
		window.removeEventListener("languagechange", applyLanguage);
		closeSettings(false);
		closeFeedback(false);
		auth.dispose();
		hub.dispose();
		friends.dispose();
		teardownCompany();
		cloudCheck?.dispose();
		browserRecovery?.dispose();
		window.removeEventListener("hashchange", onRouteChange);
		window.removeEventListener("keydown", onEscape);
		window.removeEventListener("resize", syncNavigation);
	};
}
