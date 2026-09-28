import type { User } from "@supabase/supabase-js";
import { CloudApi } from "../cloud/api.ts";
import { type Cloud, describeError } from "../cloud/client.ts";
import { createWebCompanyAgents } from "../cloud/company-agents.ts";
import { WebCompanyFiles } from "../cloud/company-files.ts";
import { WebCompanyComputer } from "../cloud/computer.ts";
import { takeConnectorReturn } from "../cloud/connectors.ts";
import { createWebMachines } from "../cloud/machines.ts";
import { createWebMemberNotifications } from "../cloud/member-notifications.ts";
import { createWebNativeSubscription } from "../cloud/native-subscription.ts";
import { createWebRoutines } from "../cloud/routines.ts";
import { createWebSessionAttachments } from "../cloud/session-attachments.ts";
import { createWebSessionInputWriter } from "../cloud/session-input.ts";
import { createWebSessionModel } from "../cloud/session-model.ts";
import { createWebSessionRunControl } from "../cloud/session-run-control.ts";
import type { HostedProfile } from "../cloud/types.ts";
import { button, h, notice, replace } from "../ui/dom.ts";
import { isPhoneLayout } from "../ui/layout.ts";
import { personPictures, setPersonPictures } from "../ui/person-pictures.ts";
import { applyLanguage, presentationLocale, t, watchTheme } from "../ui/preferences.ts";
import { RailLayout } from "../ui/rail-layout.ts";
import { blankSkeleton, pageSkeleton, railSkeleton, threadSkeleton } from "../ui/skeleton.ts";
import { AuthController } from "./auth.ts";
import { CompanyController } from "./company.ts";
import { MemberPictures } from "./member-pictures.ts";
import { currentRoute, navigate, type Route } from "./router.ts";
import { createConversationStarter } from "./start-conversation.ts";
import { debounce } from "./state.ts";
import { createGroupUpdater } from "./update-group.ts";
import { type AccountViewState, renderAccount } from "./views/account.ts";
import { CompanyFileController, renderCompanyFile } from "./views/companyfile.ts";
import { ComputerPanels } from "./views/computer.ts";
import { ConversationView } from "./views/conversation.ts";
import { ExecutionNotices } from "./views/execution-notices.ts";
import { FeedbackView } from "./views/feedback.ts";
import { HubController, renderHub } from "./views/hub.ts";
import { LiveCompanyFileView } from "./views/live-company-file.ts";
import { type MeetState, renderMeet } from "./views/meet.ts";
import { NewConversationView } from "./views/new-conversation.ts";
import { renderPlan } from "./views/plan.ts";
import { type SettingsTab, SettingsView } from "./views/settings.ts";
import { noteConnectorReturn } from "./views/settings-services.ts";
import { renderRail, renderTopbar, type ShellContext } from "./views/shell.ts";
import { renderSignIn } from "./views/signin.ts";
import { renderTeam, type TeamFeedback } from "./views/team.ts";
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
	// Every initials disc on the page shows the person's own picture through this store.
	const pictures = new MemberPictures(api);
	setPersonPictures(pictures);

	const topbar = h("header", { class: "topbar" });
	const rail = h("aside", { id: "company-navigation", class: "rail", "aria-label": t("Company navigation") });
	const main = h("main", { class: "main", tabindex: "-1" });
	// Company notices are no popup: the open conversation places this above its composer.
	const executionNotices = h("div", { class: "company-notices" });
	const backdrop = h("button", {
		type: "button",
		class: "navigation-backdrop",
		"aria-label": t("Close company navigation"),
		onclick: () => setNavigationOpen(false),
	});
	const frame = h("div", { class: "frame" }, topbar, h("div", { class: "body" }, backdrop, rail, main));
	const railLayout = new RailLayout(frame, rail);
	rail.after(railLayout.el);
	applyLanguage();
	// Interface text and times are read when they are drawn: a new language or
	// time zone redraws the screens in place (see redrawScreens).
	window.addEventListener("languagechange", onLanguage);
	window.addEventListener("qorpera-language-change", onLanguage);
	window.addEventListener("qorpera-time-zone-change", redrawScreens);
	const unwatchTheme = watchTheme();
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
	function openSettings(tab?: SettingsTab): void {
		if (settings || feedback || !auth.userId) return;
		settings = new SettingsView(
			api,
			auth,
			hub,
			profiles,
			company?.store.get().accessLost ? undefined : company,
			() => closeSettings(),
			companyRemovedHandler(),
			tab,
		);
		frame.inert = true;
		root.append(settings.el);
		settings.focus();
	}
	let routeRevision = 0;
	let accountRevision = 0;
	// Taken from the page hash once at startup and on every route change; the
	// broker appends it after the provider consent (see cloud/connectors.ts).
	let connectorReturn = takeConnectorReturn();
	let accountUserId: string | undefined;
	let navigationOpen = false;
	let navigationFocus: "rail" | "toggle" | undefined;
	/** Why the app could not start, when reading the cloud session failed. */
	let startError: HTMLElement | undefined;
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
		main.inert = navigationOpen && isPhoneLayout();
	}
	function onEscape(event: KeyboardEvent): void {
		if (event.key === "Escape" && navigationOpen && !settings && !feedback && !event.defaultPrevented) {
			setNavigationOpen(false);
		}
	}
	function onRouteChange(): void {
		connectorReturn = takeConnectorReturn() ?? connectorReturn;
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
	let notices: ExecutionNotices | undefined;
	let computer: WebCompanyComputer | undefined;
	let computerPanels: ComputerPanels | undefined;
	let companyFile: CompanyFileController | undefined;
	let liveFile: LiveCompanyFileView | undefined;
	let conversation: ConversationView | undefined;
	let newConversation: NewConversationView | undefined;
	let startingSession: { sessionId: string } | undefined;
	let profiles: HostedProfile[] = [];
	let teamFeedback: TeamFeedback = {};
	let accountState: AccountViewState = {};
	const accountPlan = h("div");
	let meetState: MeetState = {};
	let unsubscribeCompany: (() => void) | undefined;
	let homeReason: string | undefined;

	const render = debounce(() => void draw(), 10);

	function observeAccount(): void {
		const currentHub = hub;
		hub.store.subscribe(() => {
			if (hub !== currentHub) return;
			profiles = currentHub.store.get().profiles;
			settings?.updateProfiles(profiles);
			render();
		});
	}
	observeAccount();
	auth.store.subscribe(() => {
		const userId = auth.userId;
		if (userId !== accountUserId) {
			closeSettings(false);
			closeFeedback(false);
			accountUserId = userId;
			pictures.reset();
			accountRevision++;
			routeRevision++;
			teardownCompany();
			hub.dispose();
			profiles = [];
			accountState = {};
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

	let shownLocale = presentationLocale();
	/** A new language redraws everything with text in it, Settings included:
	 * it reopens on the same tab with the focus back on the language. */
	function onLanguage(): void {
		applyLanguage();
		if (disposed || presentationLocale() === shownLocale) return;
		shownLocale = presentationLocale();
		rail.setAttribute("aria-label", t("Company navigation"));
		backdrop.setAttribute("aria-label", t("Close company navigation"));
		railLayout.relabel();
		const tab = settings?.tab;
		closeSettings(false);
		redrawScreens();
		if (!tab) return;
		openSettings(tab);
		settings?.el.querySelector<HTMLElement>(".preference-picker-button")?.focus();
	}

	/** Rebuild the route's screens from the stores, which keep drafts,
	 * attachments and edits. A new-conversation draft and unsaved Company File
	 * text live only in their screens, so those stay until they are left. */
	function redrawScreens(): void {
		if (disposed) return;
		notices?.dispose();
		notices = undefined;
		executionNotices.replaceChildren();
		conversation?.dispose();
		conversation = undefined;
		if (newConversation && !newConversation.hasInput) {
			newConversation.dispose();
			newConversation = undefined;
		}
		if (liveFile && !liveFile.leaveMessage()) {
			liveFile.dispose();
			liveFile = undefined;
		}
		render();
	}

	function teardownCompany(): void {
		notices?.dispose();
		notices = undefined;
		executionNotices.replaceChildren();
		unsubscribeCompany?.();
		unsubscribeFile?.();
		conversation?.dispose();
		newConversation?.dispose();
		companyFile?.dispose();
		liveFile?.dispose();
		liveFile = undefined;
		company?.stop();
		pendingCompany = undefined;
		company = undefined;
		computer = undefined;
		computerPanels = undefined;
		companyFile = undefined;
		conversation = undefined;
		newConversation = undefined;
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
				(sessionId, clientInputId, text, signal, files, executionSponsor, roomTarget) =>
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
								!(
									(route.section === "chat" && route.id === target) ||
									(route.section === "new" && startingSession?.sessionId === target)
								)
							)
								throw new Error(t("Company access is unavailable."));
							controller.assertCanSend(target);
							const observedRoom = controller.roomTargetFor(target);
							if (
								observedRoom?.roomId !== roomTarget?.roomId ||
								observedRoom?.environmentId !== roomTarget?.environmentId
							)
								throw new Error(t("The conversation destination changed. Refresh before sending."));
						},
						profile.profileId,
					)(sessionId, clientInputId, text, signal, files, executionSponsor, roomTarget),
			);
			company = controller;
			if (connectorReturn) {
				// A provider sign-in (Step 7 connector) sent the member back to this
				// company: show the outcome where the connection was started.
				noteConnectorReturn(connectorReturn);
				connectorReturn = undefined;
				queueMicrotask(() => {
					if (!disposed && company === controller) openSettings("connections");
				});
			}
			computer = new WebCompanyComputer(cloud, profile, userId, controller.signal, () => {
				if (disposed || company !== controller || auth.userId !== userId || controller.store.get().accessLost)
					throw new Error(t("Company access is unavailable."));
			});
			// Open computers outlive the thread they were opened in; leaving the company ends them.
			computerPanels = new ComputerPanels(computer, controller.signal);
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
			if (!agent) throw new Error(t("This agent is not available in the company."));
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

	/** A company or conversation that is still opening shows the thread's placeholder.
	 * A redraw keeps the one already shown and only renames what it is waiting for. */
	function showThreadSkeleton(label: string): void {
		// On a phone the thread brings its own header, with the rail's button, as an open conversation does.
		frame.classList.add("has-thread");
		const shown = main.childElementCount === 1 ? main.firstElementChild : null;
		if (shown?.classList.contains("thread-skeleton")) {
			const name = shown.querySelector(".visually-hidden");
			if (name && name.textContent !== label) name.textContent = label;
			shown.querySelector(".mobile-navigation-toggle")?.setAttribute("aria-expanded", String(navigationOpen));
			return;
		}
		replace(main, threadSkeleton(label, { open: navigationOpen, toggle: () => setNavigationOpen(!navigationOpen) }));
	}

	async function draw(): Promise<void> {
		if (disposed) return;
		const current = captureRoute();
		const authState = auth.store.get();
		if (!authState.ready) {
			// A start that failed keeps saying so; a redraw (a route change) never blanks it again.
			if (startError) replace(root!, startError);
			else replace(root!, blankSkeleton(t("Connecting to the cloud")));
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
				// The standalone account page shows the plan below the general settings.
				// One panel across renders keeps an opened plan grid open; the general
				// panel above already shows the account error.
				renderPlan(accountPlan, accountState, undefined, {}, { showError: false });
				main.append(accountPlan);
			}
			return;
		}
		if (company?.profile.profileId !== route.profileId) {
			// Opening a company takes a round trip or two. Meanwhile its rail and page stand
			// as placeholders, never a blank frame or the page it came from.
			topbar.classList.remove("topbar-plain");
			topbar.classList.add("topbar-company");
			replace(topbar);
			rail.hidden = route.section === "meet";
			if (!rail.hidden) replace(rail, ...railSkeleton());
			if (
				route.section === "home" ||
				route.section === "chat" ||
				route.section === "staff" ||
				route.section === "new"
			)
				showThreadSkeleton(t("Opening company"));
			else replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
		}
		const controller = await ensureCompany(route.profileId);
		if (!current()) return;
		if (!controller) {
			// A drawer opened from the placeholder closes with the company it was opening.
			navigationOpen = false;
			navigationFocus = undefined;
			syncNavigation();
			frame.classList.remove("navigation-open");
			rail.hidden = true;
			renderTopbar(topbar, shellContext(authState.user, route), undefined);
			replace(
				main,
				h(
					"section",
					{ class: "page" },
					notice("danger", t("This company is not available to your account.")),
					h("a", { href: "#/" }, t("Back to companies")),
				),
			);
			return;
		}
		// Agents are Company File documents. Each write re-checks that this
		// member still holds the authority the company showed when it began.
		const agents = () => {
			const team = controller.store.get().team;
			if (!team?.capabilities.authorize) throw new Error(t("Only an owner or admin can change agents."));
			return createWebCompanyAgents(
				new WebCompanyFiles(cloud, controller.profile, controller.userId, team.role, controller.signal, () => {
					const now = controller.store.get();
					if (
						disposed ||
						company !== controller ||
						auth.userId !== controller.userId ||
						now.accessLost ||
						!now.team?.capabilities.authorize
					)
						throw new Error(t("Company access changed."));
				}),
			);
		};
		const agentActions: WorkspaceActions = {
			createAgent: (_profileId, draft, signal) => agents().create(draft, signal),
			updateAgent: (agent, draft, signal) => agents().update(agent, draft, signal),
			deleteAgent: (agent, signal) => agents().delete(agent, signal),
		};
		// First run is a moment, not a workspace: the rail stays away until the
		// Co-Founder has a face.
		rail.hidden = route.section === "meet" || controller.store.get().accessLost === true;
		const context = shellContext(authState.user, route);
		renderTopbar(topbar, context, rail.hidden ? undefined : controller);
		if (!rail.hidden)
			renderRail(rail, controller, { ...context, agentActions: { ...agentActions, ...workspaceActions } });
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
			notices?.dispose();
			notices = undefined;
			liveFile?.dispose();
			liveFile = undefined;
			closeSettings(false);
			companyFile?.dispose();
			conversation?.dispose();
			newConversation?.dispose();
			// Revoked access ends every retained screen connection, not only the shown one.
			computerPanels?.dispose();
			navigationOpen = false;
			navigationFocus = undefined;
			syncNavigation();
			frame.classList.remove("navigation-open");
			replace(
				main,
				h(
					"section",
					{ class: "page" },
					notice("danger", t("Your access to this company was revoked.")),
					h("a", { href: "#/" }, t("Back to companies")),
				),
			);
			return;
		}
		if (notices && !state.team?.capabilities.read) {
			notices.dispose();
			notices = undefined;
		}
		if (!notices && state.team?.capabilities.read) {
			const client = createWebMemberNotifications(
				cloud,
				controller.profile.profileId,
				controller.userId,
				controller.signal,
				() => {
					const selected = currentRoute();
					if (
						disposed ||
						company !== controller ||
						auth.userId !== controller.userId ||
						controller.store.get().accessLost ||
						!controller.store.get().team?.capabilities.read ||
						selected.name !== "company" ||
						selected.profileId !== controller.profile.profileId
					)
						throw new Error(t("Company notification access changed."));
				},
			);
			notices = new ExecutionNotices(client, controller.signal, () => main.focus({ preventScroll: true }));
			executionNotices.append(notices.el);
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
		if (route.section !== "meet") meetState = {};
		switch (route.section) {
			case "new": {
				if (!newConversation) {
					const current = captureRoute();
					const check = () => {
						if (!current() || company !== controller || controller.store.get().accessLost)
							throw new Error(t("Conversation access changed."));
					};
					const startConversation = createConversationStarter({
						company: controller,
						native: createWebNativeSubscription(
							cloud,
							controller.profile.profileId,
							controller.userId,
							controller.signal,
							check,
						),
						current: check,
						editor: async (signal) => {
							check();
							const team = controller.store.get().team;
							if (!team?.capabilities.authorize)
								throw new Error(t("Only an owner or admin can create a group chat."));
							return new WebCompanyFiles(cloud, controller.profile, controller.userId, team.role, signal, () => {
								check();
								if (!controller.store.get().team?.capabilities.authorize)
									throw new Error(t("Group chat creation access changed."));
							}).files();
						},
						send: async (sessionId, text, signal) => {
							check();
							const attempt = { sessionId };
							startingSession = attempt;
							try {
								return await controller.sendPrompt(sessionId, text, signal);
							} finally {
								// A disposed composer may finish refreshing after a newer send starts.
								if (startingSession === attempt) startingSession = undefined;
							}
						},
					});
					newConversation = new NewConversationView(
						controller,
						{ ...agentActions, startConversation, ...workspaceActions },
						() => navigate({ name: "company", profileId: controller.profile.profileId, section: "home" }),
						() => setNavigationOpen(!navigationOpen),
					);
					replace(main, newConversation.el);
					if (!frame.inert) newConversation.focus();
				}
				newConversation.setNavigationOpen(navigationOpen);
				return;
			}
			case "home": {
				// Home needs organization, membership and sessions, not just staff.
				if (state.loading) {
					showThreadSkeleton(t("Opening company"));
					return;
				}
				if (!homeReason) {
					showThreadSkeleton(t("Opening the Co-Founder"));
					void resolveHome(controller);
					return;
				}
				const first = state.hierarchy.primary.find((node) => node.kind === "agent");
				// One sentence around the agent's link, so Danish can order it its own way.
				const [before, after] = t("Start with {agent} or pick a conversation in the rail.").split("{agent}");
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
									before,
									h(
										"a",
										{ href: `#/c/${controller.profile.profileId}/staff/${first.canonicalId}` },
										first.label,
									),
									after,
								)
							: h("p", { class: "muted" }, t("This company has no staff conversations yet.")),
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
							selected.name !== "company" ||
							selected.profileId !== controller.profile.profileId ||
							selected.section !== "chat" ||
							selected.id !== sessionId
						)
							throw new Error(t("Conversation access changed."));
					};
					conversation = new ConversationView(
						controller,
						route.id ?? "",
						{
							sendMessage: (id, text, signal) => controller.sendPrompt(id, text, signal),
							sessionMachines: (id) => {
								checkConversationAccess();
								return createWebMachines(cloud, controller.profile.profileId).session(id);
							},
							openMachines: () => openSettings("machines"),
							sessionModel: createWebSessionModel(
								cloud,
								controller.userId,
								controller.signal,
								checkConversationAccess,
							),
							updateGroup: createGroupUpdater({
								company: controller,
								current: checkConversationAccess,
								editor: async (signal) => {
									checkConversationAccess();
									const team = controller.store.get().team;
									if (!team?.capabilities.authorize)
										throw new Error(t("Only an owner or admin can edit group chats."));
									return new WebCompanyFiles(
										cloud,
										controller.profile,
										controller.userId,
										team.role,
										signal,
										() => {
											checkConversationAccess();
											if (!controller.store.get().team?.capabilities.authorize)
												throw new Error(t("Group chat editing access changed."));
										},
									).files();
								},
							}),
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
										selected.name !== "company" ||
										selected.profileId !== controller.profile.profileId ||
										selected.section !== "chat" ||
										selected.id !== route.id
									)
										throw new Error(t("Attachment access changed."));
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
								if (!ref) throw new Error(t("This attachment is not available for preview."));
								const bytes = await createWebSessionAttachments(cloud, controller.userId, signal, check).read(
									route.id!,
									messageId,
									ref,
									signal,
								);
								check();
								return new Blob([Uint8Array.from(bytes)], { type: ref.mediaType });
							},
							routines: createWebRoutines(cloud, controller.profile, controller.signal, checkConversationAccess),
							...agentActions,
							...workspaceActions,
							computer,
							computerPanels,
							notificationHost: executionNotices,
						},
						() => setNavigationOpen(!navigationOpen),
					);
					replace(main, conversation.el);
					// Not while Settings covers the frame (a redraw behind it after a language change).
					if (!frame.inert) conversation.focus();
				} else conversation.update();
				conversation.setNavigationOpen(navigationOpen);
				return;
			}
			case "staff": {
				if (state.loading) {
					showThreadSkeleton(t("Opening company"));
					return;
				}
				if (routeError) {
					replace(main, notice("danger", routeError));
					return;
				}
				showThreadSkeleton(t("Opening conversation"));
				void resolveStaff(controller, route.id ?? "");
				return;
			}
			case "file": {
				if (route.id === "history") {
					if (!companyFile) return;
					companyFile.start();
					renderCompanyFile(companyFile, controller, main, {});
					return;
				}
				if (state.loading) {
					replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening Company File"))));
					return;
				}
				if (!state.team) {
					// Company File access follows membership; without it there is nothing to wait for.
					replace(
						main,
						h(
							"section",
							{ class: "page" },
							notice("danger", state.error ?? t("Your membership in this company could not be read.")),
							button(t("Retry company"), () => {
								if (!controller.store.get().loading) void controller.refreshAll();
							}),
						),
					);
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
								throw new Error(t("Company File access changed."));
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
				renderMeet(
					controller,
					(agent, figure, color) =>
						agents().update(
							agent,
							{ displayName: agent.displayName, role: agent.role, charter: agent.charter, figure, color },
							controller.signal,
						),
					main,
					meetState,
					(next) => {
						if (!current() || company !== controller) return;
						meetState = next;
						render();
					},
					current,
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
					{ onCompanyRemoved: companyRemovedHandler(), addFriend: () => openSettings("friends") },
				);
				return;
		}
	}

	void auth.start().then(
		() => render(),
		(error) => {
			if (disposed) return;
			startError = h(
				"section",
				{ class: "page" },
				notice("danger", t("The cloud could not be reached. {error}", { error: describeError(error) })),
				button(t("Try again"), () => location.reload()),
			);
			render();
		},
	);

	return () => {
		disposed = true;
		railLayout.dispose();
		window.removeEventListener("languagechange", onLanguage);
		window.removeEventListener("qorpera-language-change", onLanguage);
		window.removeEventListener("qorpera-time-zone-change", redrawScreens);
		unwatchTheme();
		closeSettings(false);
		closeFeedback(false);
		auth.dispose();
		hub.dispose();
		teardownCompany();
		pictures.reset();
		if (personPictures() === pictures) setPersonPictures(undefined);
		window.removeEventListener("hashchange", onRouteChange);
		window.removeEventListener("keydown", onEscape);
		window.removeEventListener("resize", syncNavigation);
	};
}
