import type { User } from "@supabase/supabase-js";
import { CloudApi } from "../cloud/api.ts";
import { forgetChatGptPlanSignIn, takeChatGptPlanReturn } from "../cloud/chatgpt-plan-sign-in.ts";
import { type Cloud, describeError } from "../cloud/client.ts";
import { createWebCompanyAgents } from "../cloud/company-agents.ts";
import { WebCompanyFiles } from "../cloud/company-files.ts";
import { WebCompanyComputer } from "../cloud/computer.ts";
import { createWebConnectors, takeConnectorReturn } from "../cloud/connectors.ts";
import { interfaceOfferCalls } from "../cloud/interface-offers.ts";
import { interfacePageCalls } from "../cloud/interface-pages.ts";
import { interfaceSupervisionCalls } from "../cloud/interface-supervisions.ts";
import { createWebMemberNotifications } from "../cloud/member-notifications.ts";
import { createWebNativeSubscription } from "../cloud/native-subscription.ts";
import { createWebRoutines } from "../cloud/routines.ts";
import { createWebSessionAttachments } from "../cloud/session-attachments.ts";
import { createWebSessionInputWriter } from "../cloud/session-input.ts";
import { createWebSessionModel } from "../cloud/session-model.ts";
import { createWebSessionRunControl } from "../cloud/session-run-control.ts";
import { loadSkillSuggestions, SkillLists } from "../cloud/skills.ts";
import type { HostedProfile } from "../cloud/types.ts";
import { nativeColorOf } from "../ui/avatar.ts";
import { button, h, notice, replace } from "../ui/dom.ts";
import { interfaceEmblem } from "../ui/interface-emblem.ts";
import { isPhoneLayout } from "../ui/layout.ts";
import { personPictures, setPersonPictures } from "../ui/person-pictures.ts";
import { applyLanguage, presentationLocale, t, watchTheme } from "../ui/preferences.ts";
import { RailLayout } from "../ui/rail-layout.ts";
import { blankSkeleton, pageSkeleton, railSkeleton, threadSkeleton } from "../ui/skeleton.ts";
import { agentWallReader } from "./agent-wall.ts";
import { AuthController, displayName } from "./auth.ts";
import { CompanyController } from "./company.ts";
import { CompanyMail } from "./company-mail.ts";
import { FoundingController } from "./founding.ts";
import { CompanyApps, sharedFolderHints } from "./interface-apps.ts";
import { CompanyInterfaceFolder } from "./interface-folder.ts";
import { CompanyInterfaceOffers } from "./interface-offers.ts";
import { CompanyInterfacePages } from "./interface-pages.ts";
import { pagesOn } from "./interfaces.ts";
import { MemberPictures } from "./member-pictures.ts";
import { newVersionNotice, runningBuildFiles, watchNewVersion } from "./new-version.ts";
import { currentRoute, navigate, type Route, routeHash } from "./router.ts";
import { createConversationStarter } from "./start-conversation.ts";
import { debounce } from "./state.ts";
import { createGroupDeleter, createGroupUpdater } from "./update-group.ts";
import { type AccountViewState, renderAccount } from "./views/account.ts";
import { AgentDetails } from "./views/agent-details.ts";
import { savedAgentDraft } from "./views/agent-edits.ts";
import { AppPanel, type SidePanelTarget, sameTarget } from "./views/app-panel.ts";
import { noteBankReturn } from "./views/bank.ts";
import { ComputerPanels } from "./views/computer.ts";
import { type AgentPage, ConversationView } from "./views/conversation.ts";
import { ExecutionNotices } from "./views/execution-notices.ts";
import { FeedbackView } from "./views/feedback.ts";
import { FoundingView } from "./views/founding.ts";
import { GroupDetails } from "./views/group-details.ts";
import { HubController, renderHub } from "./views/hub.ts";
import { renderInterface } from "./views/interface.ts";
import { type MeetState, renderMeet } from "./views/meet.ts";
import {
	hasWebsiteIdea,
	keepWebsiteIdea,
	relabelNewCompany,
	renderNewCompany,
	type Viewer,
} from "./views/new-company.ts";
import { NewConversationView } from "./views/new-conversation.ts";
import { type SettingsTab, SettingsView } from "./views/settings.ts";
import { finishPlanSignIn, memberPlanSignIn } from "./views/settings-connections.ts";
import { MyGoodWillView, takeGoodWillReturn } from "./views/settings-good-will.ts";
import { noteConnectorReturn } from "./views/settings-services.ts";
import { renderRail, renderTopbar, type ShellContext } from "./views/shell.ts";
import { renderSignIn } from "./views/signin.ts";
import { renderTeam, type TeamFeedback } from "./views/team.ts";
import type { WorkspaceActions } from "./workspace-actions.ts";

/* Entry point. One cloud client, one auth controller, one company controller
 * at a time. The route decides the view; every view renders from cloud state
 * and re-renders on store changes. */

/** Each company's skill lists, shared by its conversations' composers. */
const skillLists = new WeakMap<CompanyController, SkillLists>();

export function mountApplication(
	root: HTMLElement,
	cloud: Cloud,
	api = new CloudApi(cloud),
	workspaceActions: WorkspaceActions = {},
): () => void {
	const auth = new AuthController(cloud);
	let hub = new HubController(api);
	/** The founding table on screen, if any; one at a time, like the company. */
	let founding: { controller: FoundingController; view: FoundingView } | undefined;
	function teardownFounding(): void {
		if (!founding) return;
		founding.controller.dispose();
		founding = undefined;
		// Leaving a table's page: joins, answers and closes made there show on the hub.
		void hub.refresh();
	}
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
	// A deploy since this tab loaded: one quiet line offers the new build (app/new-version.ts).
	const versionLine = h("div", { class: "app-version-notice", hidden: true });
	const versionWatch = new AbortController();
	const frame = h("div", { class: "frame" }, topbar, h("div", { class: "body" }, backdrop, rail, main), versionLine);
	watchNewVersion(
		runningBuildFiles(),
		() => {
			versionLine.replaceChildren(
				newVersionNotice(root, () =>
					[...(company?.conversations.values() ?? [])].some((store) => (store.get().draft ?? "").trim() !== ""),
				),
			);
			versionLine.hidden = false;
		},
		versionWatch.signal,
	);
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
	/** Settings was opened from a folder link in the open conversation: closing it gives the composer focus again,
	 * so what the founder types next goes into their message. */
	let settingsFromConversation = false;
	function closeSettings(restoreFocus = true): void {
		settings?.dispose();
		settings = undefined;
		frame.inert = false;
		const toComposer = settingsFromConversation;
		settingsFromConversation = false;
		if (!restoreFocus) return;
		if (toComposer && conversation?.el.isConnected) conversation.focus();
		else frame.querySelector<HTMLElement>(".account-trigger")?.focus();
	}
	/** `folderPath`: a folder link's path (ui/folder-links.ts), shown in Storage. */
	function openSettings(tab?: SettingsTab, folderPath?: string): void {
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
			// A page switched on or off in the open company shows or leaves its Interfaces tab at once.
			(environmentId) => {
				if (company?.profile.environmentId === environmentId) void interfacePages?.refresh();
			},
		);
		frame.inert = true;
		root.append(settings.el);
		if (folderPath !== undefined) settings.openFolderPath(folderPath);
		settings.focus();
	}
	/** Shows an app or a page beside the open chat; with none open, opens the app's owner's chat (or the Co-Founder's)
	 * and shows it there. Again on what is shown already, it reads it again. */
	function openSide(target: SidePanelTarget): void {
		const controller = company;
		if (!controller || !sidePanel) return;
		if (conversation?.el.isConnected) {
			const shown = conversation.beside;
			if (shown instanceof AppPanel && sameTarget(shown.target, target)) {
				void shown.reload(true);
				shown.focus();
				return;
			}
			conversation.showBeside(sidePanel(target));
			return;
		}
		pendingSide = target;
		const owner =
			target.kind === "app" ? companyApps?.apps.find((app) => app.name === target.name)?.manifest?.owner : undefined;
		const agent = owner ? controller.staffById(owner) : undefined;
		navigate(
			agent && agent.id !== controller.cofounderId()
				? { name: "company", profileId: controller.profile.profileId, section: "staff", id: agent.id }
				: { name: "company", profileId: controller.profile.profileId, section: "home" },
		);
	}
	// A folder link in an agent's message opens Storage at what it names, over the page it is on: the conversation
	// stays where it was below Settings. Storage answers the links in the documents it shows itself.
	function onFolderLink(event: MouseEvent): void {
		const app = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-app-name]") : null;
		if (app?.dataset.appName && !event.defaultPrevented) {
			event.preventDefault();
			openSide({ kind: "app", name: app.dataset.appName });
			return;
		}
		const link = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-folder-path]") : null;
		const path = link?.dataset.folderPath;
		if (path === undefined || event.defaultPrevented) return;
		event.preventDefault();
		const fromConversation = conversation !== undefined && main.contains(link);
		// An HTML page in an agent's message opens beside the chat, live, as an app does.
		if (fromConversation && sidePanel && /\.html?$/i.test(path)) {
			openSide({ kind: "page", path });
			return;
		}
		const open = settings;
		openSettings("storage", path);
		if (settings && settings !== open) settingsFromConversation = fromConversation;
	}
	root.addEventListener("click", onFolderLink);
	// An app's card in a message names it by its folder; once the company's apps are read it shows the app's own emblem
	// and line (ui/markdown.ts draws it plain, as it has no company).
	const decorateAppCards = () => {
		const apps = company?.store.get().apps;
		if (!apps) return;
		for (const card of main.querySelectorAll<HTMLElement>(".app-card[data-app-name]")) {
			const manifest = apps.find((app) => app.name === card.dataset.appName)?.manifest;
			const shown = manifest ? JSON.stringify([manifest.emblem, manifest.colour, manifest.about]) : "";
			if (!manifest || card.dataset.shown === shown) continue;
			card.dataset.shown = shown;
			card.querySelector(".app-card-emblem")?.replaceChildren(interfaceEmblem(manifest.emblem, manifest.colour, 30));
			const note = card.querySelector(".app-card-note");
			if (note && manifest.about) note.textContent = `${manifest.about} · ${t("App")}`;
		}
	};
	let decorating = false;
	new MutationObserver(() => {
		if (decorating) return;
		decorating = true;
		queueMicrotask(() => {
			decorating = false;
			decorateAppCards();
		});
	}).observe(main, { childList: true, subtree: true });
	let routeRevision = 0;
	let accountRevision = 0;
	holdWebsiteIdea();
	// Taken from the page hash once at startup and on every route change; the
	// broker appends it after the provider consent (see cloud/connectors.ts).
	let connectorReturn = takeConnectorReturn();
	// "Continue with ChatGPT": OpenAI's callback sends the member back with a one-time confirmation.
	let planReturn = takeChatGptPlanReturn();
	// Stripe's card page sends the member back to the account page.
	let checkoutReturn = takeGoodWillReturn();
	let accountUserId: string | undefined;
	let navigationOpen = false;
	let navigationFocus: "rail" | "toggle" | undefined;
	/** Why the app could not start, when reading the cloud session failed. */
	let startError: HTMLElement | undefined;
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
		if (
			event.key === "Escape" &&
			!event.isComposing &&
			navigationOpen &&
			!settings &&
			!feedback &&
			!event.defaultPrevented
		) {
			setNavigationOpen(false);
		}
	}
	function onRouteChange(): void {
		holdWebsiteIdea();
		connectorReturn = takeConnectorReturn() ?? connectorReturn;
		planReturn = takeChatGptPlanReturn() ?? planReturn;
		checkoutReturn = takeGoodWillReturn() ?? checkoutReturn;
		closeSettings(false);
		closeFeedback(false);
		settingsAfterHome = undefined;
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
	/** Which of the open company's two pages are on (Interfaces C6a), read with its folder. */
	let interfacePages: CompanyInterfacePages | undefined;
	/** What the open company's pages read from its folder, its tables and files, followed there (Interfaces step I7). */
	let interfaceFolder: CompanyInterfaceFolder | undefined;
	/** The company's open offers of claimed cells, read with its interfaces (Interfaces step I9c). */
	let interfaceOffers: CompanyInterfaceOffers | undefined;
	/** The agents' interface apps in the open company's folder, followed there (RUNTIME-INTERFACE-APPS.md §4). */
	let companyApps: CompanyApps | undefined;
	/** The agents' walls on top of their threads, told of each change hint of the folder through whichever apps reader
	 * the open company has now (it is made again when the company opens again). */
	const wallListeners = new Set<() => void>();
	/** Makes the side panel of an app or page for the open company: set while one is drawn. */
	let sidePanel: ((target: SidePanelTarget) => AppPanel) | undefined;
	/** An app or page asked for while no chat was open: shown beside the chat once it is. */
	let pendingSide: SidePanelTarget | undefined;
	/** The open company's mail as the member reads it, for the Mailbox page (Interfaces step I5c). */
	let mail: CompanyMail | undefined;
	let computer: WebCompanyComputer | undefined;
	let computerPanels: ComputerPanels | undefined;
	let conversation: ConversationView | undefined;
	/** The agent or group chat card opened from the rail, and what an agent card asked for once its chat is on screen. */
	let agentCard: AgentDetails | GroupDetails | undefined;
	let agentPage: { agentId: string; page: AgentPage } | undefined;
	/** Each company's walls as the rail's agent cards read them, for their "Latest notes" row. */
	const cardWalls = new WeakMap<CompanyController, ReturnType<typeof agentWallReader>>();
	let newConversation: NewConversationView | undefined;
	let startingSession: { sessionId: string } | undefined;
	let profiles: HostedProfile[] = [];
	let teamFeedback: TeamFeedback = {};
	let accountState: AccountViewState = {};
	let accountPayments: MyGoodWillView | undefined;
	let meetState: MeetState = {};
	let unsubscribeCompany: (() => void) | undefined;
	let homeReason: string | undefined;
	/** A Settings tab to open once the company home has resolved: home moves on to the Co-Founder's
	 * conversation, and that route change would close Settings opened before it. */
	let settingsAfterHome: SettingsTab | undefined;

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
			// A return from Stripe belongs to the member who paid, not to whoever signs in next;
			// the first sign-in of the page (back from Stripe) keeps it.
			if (accountUserId !== undefined) checkoutReturn = undefined;
			// So does a ChatGPT plan sign-in: it is finished only for the member who started it.
			if (accountUserId !== undefined && planReturn) {
				planReturn = undefined;
				forgetChatGptPlanSignIn();
			}
			closeSettings(false);
			closeFeedback(false);
			accountUserId = userId;
			pictures.reset();
			accountRevision++;
			routeRevision++;
			teardownCompany();
			teardownFounding();
			hub.dispose();
			profiles = [];
			accountState = {};
			accountPayments?.dispose();
			accountPayments = undefined;
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
	 * attachments and edits. A new-conversation draft lives only in its screen,
	 * so that stays until it is left. */
	function redrawScreens(): void {
		if (disposed) return;
		// The founding table's page and the new-company box keep their text between refreshes; a new language
		// builds them again.
		relabelNewCompany(hub);
		if (founding)
			founding = {
				controller: founding.controller,
				view: new FoundingView(founding.controller, founding.view.drafts()),
			};
		notices?.dispose();
		notices = undefined;
		executionNotices.replaceChildren();
		conversation?.dispose();
		conversation = undefined;
		if (newConversation && !newConversation.hasInput) {
			newConversation.dispose();
			newConversation = undefined;
		}
		render();
	}

	function teardownCompany(): void {
		settingsAfterHome = undefined;
		notices?.dispose();
		notices = undefined;
		interfacePages?.dispose();
		interfacePages = undefined;
		interfaceFolder?.dispose();
		interfaceFolder = undefined;
		interfaceOffers?.dispose();
		interfaceOffers = undefined;
		companyApps?.dispose();
		companyApps = undefined;
		sidePanel = undefined;
		pendingSide = undefined;
		mail?.dispose();
		mail = undefined;
		executionNotices.replaceChildren();
		unsubscribeCompany?.();
		conversation?.dispose();
		newConversation?.dispose();
		company?.stop();
		pendingCompany = undefined;
		company = undefined;
		agentPage = undefined;
		computer = undefined;
		computerPanels = undefined;
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
			const controller: CompanyController = new CompanyController(
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
			// The company's sections are QorperaOS/agents/sections.md: the rail's moves are the member's edits of it.
			controller.useSectionsFile((signal) => {
				const current = () => {
					if (disposed || company !== controller || auth.userId !== userId || controller.store.get().accessLost)
						throw new Error(t("Company access changed."));
				};
				current();
				const role = controller.store.get().team?.role;
				if (!role) throw new Error(t("Company access changed."));
				return new WebCompanyFiles(cloud, profile, userId, role, signal, current).folder();
			});
			if (planReturn && planReturn.signIn.companyId === controller.profile.profileId) {
				const outcome = planReturn;
				planReturn = undefined;
				if (outcome.signIn.memberId !== userId) forgetChatGptPlanSignIn();
				else {
					// A ChatGPT plan sign-in for this company. Its confirm belongs to the member, not to a
					// page: it finishes while Settings closes or the route changes, stopping only if the
					// account changes, and AI subscriptions shows the outcome.
					const plan = createWebNativeSubscription(
						cloud,
						profile.profileId,
						userId,
						new AbortController().signal,
						() => {
							if (auth.userId !== userId) throw new Error("The account changed.");
						},
					);
					void finishPlanSignIn(memberPlanSignIn(userId, profile.profileId), plan, outcome);
					queueMicrotask(() => {
						if (disposed || company !== controller) return;
						const route = currentRoute();
						if (route.name === "company" && route.section === "home") settingsAfterHome = "ai-subscriptions";
						else openSettings("ai-subscriptions");
					});
				}
			}
			if (connectorReturn?.connector === "bank") {
				// The bank's sign-in sent the member back to the Bank page they started it on, which finishes it.
				noteBankReturn(connectorReturn);
				connectorReturn = undefined;
			} else if (connectorReturn) {
				// A provider sign-in (Step 7 connector) sent the member back to this
				// company: show the outcome where the connection was started.
				noteConnectorReturn(connectorReturn);
				connectorReturn = undefined;
				queueMicrotask(() => {
					if (!disposed && company === controller) openSettings("company-connections");
				});
			}
			computer = new WebCompanyComputer(cloud, profile, userId, controller.signal, () => {
				if (disposed || company !== controller || auth.userId !== userId || controller.store.get().accessLost)
					throw new Error(t("Company access is unavailable."));
			});
			// Open computers outlive the thread they were opened in; leaving the company ends them.
			computerPanels = new ComputerPanels(computer, controller.signal);
			unsubscribeCompany = controller.store.subscribe(() => render());
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
			const tab = settingsAfterHome;
			settingsAfterHome = undefined;
			if (result.sessionId)
				navigate(
					{ name: "company", profileId: controller.profile.profileId, section: "chat", id: result.sessionId },
					true,
				);
			else {
				homeReason = result.reason;
				render();
			}
			if (tab) openSettings(tab);
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
		// The account page's good will lives while it shows: its notice goes with it, and a failed
		// read is tried again on the next visit.
		if (route.name !== "account" && accountPayments) {
			accountPayments.dispose();
			accountPayments = undefined;
		}
		frame.classList.toggle(
			"has-thread",
			route.name === "company" && (route.section === "chat" || route.section === "new"),
		);
		if (route.name !== "company") {
			teardownCompany();
			rail.hidden = true;
			renderTopbar(topbar, shellContext(authState.user, route), undefined);
			if (route.name !== "found") teardownFounding();
			const viewer: Viewer | undefined =
				authState.user && auth.userId ? { userId: auth.userId, name: displayName(authState.user) } : undefined;
			if (route.name === "hub" && hasWebsiteIdea()) {
				// qorpera.com's idea is waiting (a sign-in came back to the app's root): show it in its box.
				navigate({ name: "new" }, true);
			} else if (route.name === "hub") {
				renderHub(hub, main, viewer);
			} else if (route.name === "new") {
				renderNewCompany(hub, main, viewer);
			} else if (route.name === "found") {
				const userId = auth.userId!;
				if (founding?.controller.profileId !== route.profileId) {
					teardownFounding();
					const profileId = route.profileId;
					const controller = new FoundingController(api, userId, profileId, {
						currentUserId: () => auth.userId,
						onSeatChanged: () => void hub.refresh(),
						// Still on this table's page: open the company, which opens its Co-Founder's thread. The table's
						// page leaves the history, so Back does not return to a table that is done. A company list read
						// before the company was made may still be out, and opening a company it leaves out would fail:
						// open only after a read that started after this one, and only once it lists the company (else
						// the table's own Open button stays).
						onCompanyReady: () => {
							const page = routeHash({ name: "found", profileId });
							const currentHub = hub;
							void currentHub.refreshAfter().then(() => {
								if (disposed || hub !== currentHub || location.hash !== page) return;
								if (currentHub.store.get().profiles.some((item) => item.profileId === profileId))
									navigate({ name: "company", profileId, section: "home" }, true);
							});
						},
					});
					founding = { controller, view: new FoundingView(controller) };
					let companyListed = false;
					controller.store.subscribe(() => {
						if (founding?.controller !== controller) return;
						// A started table's company joins the hub's list once it is ready.
						if (!companyListed && controller.store.get().table?.start?.companyReady) {
							companyListed = true;
							void hub.refresh();
						}
						render();
					});
				}
				// The table's page is kept and updated in place, never rebuilt (typing, focus and scroll).
				if (!main.contains(founding.view.el)) replace(main, founding.view.el);
				founding.view.update();
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
				// The standalone account page shows the good will of the member's companies below the general settings.
				if (checkoutReturn) {
					accountPayments?.dispose();
					accountPayments = undefined;
				}
				accountPayments ??= new MyGoodWillView(
					() => api.getMyGoodWill(),
					new AbortController().signal,
					checkoutReturn === "card-saved" ? t("Card saved. It pays the company's next invoice.") : undefined,
				);
				checkoutReturn = undefined;
				main.append(accountPayments.el);
			}
			return;
		}
		teardownFounding();
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
		// Agents are company folders (QorperaOS/agents/<handle>/agent.md). Each write re-checks
		// that this member still holds the authority the company showed when it began.
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
				// A field the member did not touch keeps the file's own value; a figure's own shade is no colour.
				{ saved: savedAgentDraft, native: nativeColorOf },
			);
		};
		const agentActions: WorkspaceActions = {
			createAgent: (_profileId, draft, signal) => agents().create(draft, signal),
			updateAgent: (agent, draft, signal) => agents().update(agent, draft, signal),
			deleteAgent: (agent, signal) => agents().delete(agent, signal),
		};
		// The rail renames and deletes group chats from their menu, with the same rechecks.
		const companyCurrent = () => {
			const now = controller.store.get();
			if (disposed || company !== controller || auth.userId !== controller.userId || now.accessLost)
				throw new Error(t("Company access changed."));
		};
		const groupFolder = (signal: AbortSignal) => {
			companyCurrent();
			const team = controller.store.get().team;
			if (!team?.capabilities.authorize) throw new Error(t("Only an owner or admin can edit group chats."));
			return new WebCompanyFiles(cloud, controller.profile, controller.userId, team.role, signal, () => {
				companyCurrent();
				if (!controller.store.get().team?.capabilities.authorize)
					throw new Error(t("Group chat editing access changed."));
			}).folder();
		};
		// The member's own client for the company's folder under a caller's checks: a routine's file is read and written
		// with the access its routine calls have (P34r).
		const memberFolder = (current: () => void, lost: string) => {
			current();
			const role = controller.store.get().team?.role;
			if (!role) throw new Error(lost);
			return new WebCompanyFiles(
				cloud,
				controller.profile,
				controller.userId,
				role,
				controller.signal,
				current,
			).folder();
		};
		// An agent's app or a Company File page beside the chat (RUNTIME-INTERFACE-APPS.md §4, §5): read with the member's
		// own folder client, under the company's checks.
		sidePanel = (target) =>
			new AppPanel(
				{
					folder: () => memberFolder(companyCurrent, t("Company access changed.")),
					agents: () =>
						controller.store
							.get()
							.staff.filter((agent) => agent.employmentStatus === "active")
							.map((agent) => {
								const now = controller.agentState(agent.id);
								return {
									name: agent.displayName,
									role: agent.role,
									working: now === "working" || now === "writing",
								};
							}),
					readApps: () => companyApps?.read() ?? Promise.resolve([]),
					apps: () => companyApps?.apps ?? [],
					agentName: (agentId) => (agentId ? (controller.staffById(agentId)?.displayName ?? null) : null),
					onFolderChange: (listener) => companyApps?.onChange(listener) ?? (() => {}),
					// As a folder link in the chat: closing Storage gives the composer focus again.
					openInStorage: (path) => {
						const open = settings;
						openSettings("storage", path);
						if (settings && settings !== open) settingsFromConversation = conversation !== undefined;
					},
					budgetKey: controller.profile.profileId,
				},
				target,
				() => conversation?.closeBeside(true),
			);
		// The member's erases of single messages under a caller's checks (summary trees M3c).
		const messageErases = (current: () => void) => {
			current();
			const role = controller.store.get().team?.role;
			if (!role) throw new Error(t("Conversation access changed."));
			return new WebCompanyFiles(
				cloud,
				controller.profile,
				controller.userId,
				role,
				controller.signal,
				current,
			).messageErases();
		};
		const groupActions: Pick<WorkspaceActions, "updateGroup" | "deleteGroup"> = {
			updateGroup: createGroupUpdater({ company: controller, current: companyCurrent, folder: groupFolder }),
			deleteGroup: createGroupDeleter({ company: controller, current: companyCurrent, folder: groupFolder }),
		};
		// First run is a moment, not a workspace: the rail stays away until the
		// Co-Founder has a face.
		rail.hidden = route.section === "meet" || controller.store.get().accessLost === true;
		const context = shellContext(authState.user, route);
		renderTopbar(topbar, context, rail.hidden ? undefined : controller);
		// The card's Computer and Latest notes open in the agent's own chat: here when it is on screen, else once it opens.
		const showAgentPage = (agentId: string, page: AgentPage) => {
			if (conversation?.show(agentId, page)) return;
			agentPage = { agentId, page };
			navigate({ name: "company", profileId: controller.profile.profileId, section: "staff", id: agentId });
		};
		let cardWall = cardWalls.get(controller);
		if (!cardWall) {
			cardWall = agentWallReader(() => memberFolder(companyCurrent, t("Company access changed.")));
			cardWalls.set(controller, cardWall);
		}
		const openAgentCard: ShellContext["openAgentCard"] = (agent, anchor, card, findAnchor) => {
			agentCard?.dispose();
			const opened = new AgentDetails(
				controller,
				agent,
				{
					...agentActions,
					...workspaceActions,
					// The card's routines page: routines are files, written through the member's own folder client, with
					// the company's own checks (the chat's routines check the conversation instead).
					routines: createWebRoutines(cloud, controller.profile, controller.signal, companyCurrent, () =>
						memberFolder(companyCurrent, t("Company access changed.")),
					),
					nativeSubscription: createWebNativeSubscription(
						cloud,
						controller.profile.profileId,
						controller.userId,
						controller.signal,
						companyCurrent,
					),
				},
				() => {
					if (agentCard === opened) agentCard = undefined;
				},
				anchor,
				controller.signal,
				{
					computer: () => showAgentPage(agent.id, "computer"),
					notes: { open: () => showAgentPage(agent.id, "wall"), read: (signal) => cardWall(agent.id, signal) },
					...card,
				},
				"beside",
			);
			opened.dialog.findOpener = findAnchor;
			agentCard = opened;
		};
		const openGroupCard: ShellContext["openGroupCard"] = (session, anchor, card, findAnchor) => {
			agentCard?.dispose();
			const opened = new GroupDetails(
				controller,
				session.sessionId,
				() => {
					if (agentCard === opened) agentCard = undefined;
				},
				anchor,
				controller.signal,
				{ ...agentActions, ...groupActions, ...workspaceActions },
				card,
				"beside",
			);
			opened.dialog.findOpener = findAnchor;
			agentCard = opened;
		};
		if (!rail.hidden)
			renderRail(rail, controller, {
				...context,
				agentActions: { ...agentActions, ...groupActions, ...workspaceActions },
				openAgentCard,
				openGroupCard,
			});
		if (navigationFocus) {
			// The drawer opens on its first control: the company's name, or the search field when it is open (the
			// name is inert under it).
			const target =
				navigationFocus === "rail"
					? (rail.querySelector<HTMLElement>(".rail-toolbar:not(.is-searching) .rail-company") ??
						rail.querySelector<HTMLInputElement>(".rail-search input"))
					: (frame.querySelector<HTMLButtonElement>(".main .mobile-navigation-toggle:not([hidden])") ??
						topbar.querySelector<HTMLButtonElement>(".mobile-navigation-toggle"));
			target?.focus();
			navigationFocus = undefined;
		}
		const state = controller.store.get();
		if (state.accessLost) {
			notices?.dispose();
			notices = undefined;
			interfacePages?.dispose();
			interfacePages = undefined;
			interfaceFolder?.dispose();
			interfaceFolder = undefined;
			interfaceOffers?.dispose();
			interfaceOffers = undefined;
			companyApps?.dispose();
			companyApps = undefined;
			mail?.dispose();
			mail = undefined;
			closeSettings(false);
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
			const noticeAccess = () => {
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
			};
			const client = createWebMemberNotifications(
				cloud,
				controller.profile.profileId,
				controller.userId,
				controller.signal,
				noticeAccess,
			);
			// A ChatGPT plan's member is asked once to turn on work while away for an agent's routine.
			const native = createWebNativeSubscription(
				cloud,
				controller.profile.profileId,
				controller.userId,
				controller.signal,
				noticeAccess,
			);
			const plan =
				native.setWorkWhileAway && native.recordRoutineOffer && native.chatGptPlanAvailable
					? {
							native: {
								listConnections: native.listConnections,
								setWorkWhileAway: native.setWorkWhileAway,
								recordRoutineOffer: native.recordRoutineOffer,
								chatGptPlanAvailable: native.chatGptPlanAvailable,
							},
							// A routine is a file: its resume writes it through the member's own folder client.
							routines: createWebRoutines(cloud, controller.profile, controller.signal, noticeAccess, () =>
								memberFolder(noticeAccess, t("Company notification access changed.")),
							),
							memberId: controller.userId,
							canManage: () => controller.store.get().team?.capabilities.authorize === true,
						}
					: undefined;
			notices = new ExecutionNotices(
				client,
				controller.signal,
				() => main.focus({ preventScroll: true }),
				plan,
				(staffAgentId) => controller.store.get().staff.find((agent) => agent.id === staffAgentId)?.displayName,
				api,
				(userId) => controller.store.get().team?.members.find((member) => member.userId === userId)?.displayName,
			);
			executionNotices.append(notices.el);
		}
		// The company's pages are the two the web ships, shown once they are on (Interfaces C6a). What they read comes from
		// its folder, read with the member's own access as the Company File page reads it, and followed while the
		// company is open.
		if (interfaceFolder && !state.team?.capabilities.read) {
			interfacePages?.dispose();
			interfacePages = undefined;
			controller.store.set({ interfacePages: undefined });
			interfaceFolder.dispose();
			interfaceFolder = undefined;
			interfaceOffers?.dispose();
			interfaceOffers = undefined;
			companyApps?.dispose();
			companyApps = undefined;
		}
		if (!interfaceFolder && state.team?.capabilities.read) {
			const files = new WebCompanyFiles(
				cloud,
				controller.profile,
				controller.userId,
				state.team.role,
				controller.signal,
				() => {
					const now = controller.store.get();
					if (
						disposed ||
						company !== controller ||
						auth.userId !== controller.userId ||
						now.accessLost ||
						!now.team?.capabilities.read
					)
						throw new Error(t("Company access changed."));
				},
			);
			// The offers of claimed cells are read with them, and again each time the folder the pages read changes,
			// since the save that changes a cell settles its offers (step I9c) and makes or ends a supervision (I9b).
			const offers = new CompanyInterfaceOffers(
				interfaceOfferCalls(cloud, controller.profile.environmentId),
				interfaceSupervisionCalls(cloud, controller.profile.environmentId),
				(next) => {
					if (interfaceOffers === offers) controller.store.set({ interfaceOffers: next });
				},
				controller.signal,
			);
			// The pages' reader and the apps' share one hint channel.
			const hints = sharedFolderHints(files);
			const shared = {
				signal: files.signal,
				current: () => files.current(),
				folder: () => files.folder(),
				folderHints: hints,
			};
			const reader = new CompanyInterfaceFolder(shared, (folder) => {
				if (interfaceFolder !== reader) return;
				controller.store.set({ interfaceFolder: folder });
				void offers.refresh();
			});
			// The folder is read for the pages that are on: a page switched on is read for at the next sync.
			const pages = new CompanyInterfacePages(
				interfacePageCalls(cloud, controller.profile.environmentId),
				(next) => {
					if (interfacePages !== pages) return;
					controller.store.set({ interfacePages: next });
					reader.read(pagesOn(next));
				},
				controller.signal,
			);
			interfacePages = pages;
			interfaceFolder = reader;
			interfaceOffers = offers;
			offers.open();
			pages.open();
			void reader.open();
			// The agents' apps, for the apps drawer and the panel beside the chat (RUNTIME-INTERFACE-APPS.md §4).
			const apps = new CompanyApps(shared, (next) => {
				if (companyApps !== apps) return;
				controller.store.set({ apps: next });
				decorateAppCards();
			});
			companyApps = apps;
			apps.onChange(() => {
				for (const listener of [...wallListeners]) listener();
			});
			apps.open();
		}
		// The company's mail, read the same way: whether it is on (the Mailbox's `mail` need) and what waits for a person.
		if (mail && !state.team?.capabilities.read) {
			mail.dispose();
			mail = undefined;
		}
		if (!mail && state.team?.capabilities.read) {
			// A waiting send's answer runs its agent on the member's model account, chosen as the agent's thread chooses it.
			const accounts = createWebNativeSubscription(
				cloud,
				controller.profile.profileId,
				controller.userId,
				controller.signal,
				() => {
					const now = controller.store.get();
					if (
						disposed ||
						company !== controller ||
						auth.userId !== controller.userId ||
						now.accessLost ||
						!now.team?.capabilities.read
					)
						throw new Error(t("Company access changed."));
				},
			);
			// The company's Digital Post letters are files of its folder, read with the member's own access.
			const mailFolder = (signal: AbortSignal) => {
				const current = () => {
					const now = controller.store.get();
					if (disposed || company !== controller || auth.userId !== controller.userId || now.accessLost)
						throw new Error(t("Company access changed."));
				};
				current();
				const role = controller.store.get().team?.role;
				if (!role) throw new Error(t("Company access changed."));
				return new WebCompanyFiles(cloud, controller.profile, controller.userId, role, signal, current).folder();
			};
			const reader = new CompanyMail(
				controller,
				cloud,
				accounts,
				(read) => {
					if (mail === reader) controller.store.set({ mail: read });
				},
				mailFolder,
			);
			mail = reader;
			void reader.open();
		}
		if (route.section !== "chat") {
			conversation?.dispose();
			conversation = undefined;
			controller.setOpenSession(undefined);
		}
		// A card's request waits only while its agent's chat is on the way.
		if (route.section !== "chat" && route.section !== "staff") agentPage = undefined;
		if (route.section !== "chat" && route.section !== "staff" && route.section !== "home") pendingSide = undefined;
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
						folder: (signal) => {
							check();
							const team = controller.store.get().team;
							if (!team?.capabilities.authorize)
								throw new Error(t("Only an owner or admin can create a group chat."));
							return new WebCompanyFiles(cloud, controller.profile, controller.userId, team.role, signal, () => {
								check();
								if (!controller.store.get().team?.capabilities.authorize)
									throw new Error(t("Group chat creation access changed."));
							}).folder();
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
							// One read serves the company's threads for a minute, so it lives with the company,
							// not with this thread; a thread that closes simply stops listening.
							skills: async (agentId) => {
								checkConversationAccess();
								const lists = skillLists.get(controller) ?? new SkillLists();
								skillLists.set(controller, lists);
								const current = () => {
									const state = controller.store.get();
									if (
										disposed ||
										company !== controller ||
										auth.userId !== controller.userId ||
										state.accessLost ||
										!state.team?.capabilities.read
									)
										throw new Error(t("Conversation access changed."));
								};
								return lists.get(agentId, async () => {
									current();
									const role = controller.store.get().team?.role;
									if (!role) throw new Error(t("Conversation access changed."));
									// Read with the member's own access to the company's folder, as the Company File page reads.
									const folder = new WebCompanyFiles(
										cloud,
										controller.profile,
										controller.userId,
										role,
										controller.signal,
										current,
									).folder();
									return loadSkillSuggestions(folder, agentId, controller.signal);
								});
							},
							sessionModel: createWebSessionModel(
								cloud,
								controller.userId,
								controller.signal,
								checkConversationAccess,
							),
							updateGroup: createGroupUpdater({
								company: controller,
								current: checkConversationAccess,
								folder: (signal) => {
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
									).folder();
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
							// Routines are files (QorperaOS/agents/<handle>/routines/<key>.md): the editor and the switch
							// write them through the member's own folder client, with the same checks as every other routine
							// call.
							routines: createWebRoutines(
								cloud,
								controller.profile,
								controller.signal,
								checkConversationAccess,
								() => memberFolder(() => checkConversationAccess(), t("Conversation access changed.")),
							),
							// No Undo on an agent's interface change: agents don't make pages (Interfaces C6a), and the save
							// check refuses an agent's change under QorperaOS/interfaces/ or to a table's definition (C6c).
							// A message is erased for the whole company through the member's own route; the route checks the
							// role, and the thread offers it to the roles that route takes (M3c).
							// The agent's wall on top of its thread, read with the member's own folder client and again after
							// each change hint of the company's folder (the apps' hint channel).
							agentWall: {
								read: agentWallReader(() =>
									memberFolder(() => checkConversationAccess(), t("Conversation access changed.")),
								),
								onFolderChange: (listener) => {
									wallListeners.add(listener);
									return () => wallListeners.delete(listener);
								},
								show: (agentId) => showAgentPage(agentId, "wall"),
							},
							messageErases: {
								request: (sessionId, eventId, signal) =>
									messageErases(() => checkConversationAccess(sessionId)).request(sessionId, eventId, signal),
								status: (erase, signal) =>
									messageErases(() => checkConversationAccess(erase.sessionId)).status(erase, signal),
							},
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
				// Asked for from an agent's card before its chat was open: shown once the chat knows its agent.
				if (agentPage && conversation.show(agentPage.agentId, agentPage.page)) agentPage = undefined;
				// An app asked for from the apps drawer while no chat was open: beside the chat it opened.
				if (pendingSide && sidePanel) {
					const target = pendingSide;
					pendingSide = undefined;
					conversation.showBeside(sidePanel(target));
				}
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
				// Existing Company File links open Storage in Settings. Resolve the company's
				// home first, so its redirect cannot close the new Settings session.
				navigate({ name: "company", profileId: controller.profile.profileId, section: "home" }, true);
				settingsAfterHome = "storage";
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
			case "interface":
				// A board's take and release write the member's own rows with the same rechecks (step I9a); its offers go
				// through the company's offers reader (step I9c). A change that could not be made reads the folder again.
				renderInterface(main, controller, route.id ?? "", {
					folder: () => memberFolder(companyCurrent, t("Company access changed.")),
					current: companyCurrent,
					...(interfaceOffers ? { offers: interfaceOffers } : {}),
					...(interfaceFolder ? { reread: interfaceFolder.sync.bind(interfaceFolder) } : {}),
					openSettings: () => openSettings("company-connections"),
					bankConnection: () => createWebConnectors(cloud, controller.profile),
				});
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
		teardownFounding();
		teardownCompany();
		accountPayments?.dispose();
		pictures.reset();
		if (personPictures() === pictures) setPersonPictures(undefined);
		window.removeEventListener("hashchange", onRouteChange);
		root.removeEventListener("click", onFolderLink);
		window.removeEventListener("keydown", onEscape);
		window.removeEventListener("resize", syncNavigation);
		versionWatch.abort();
	};
}

/** The query keys qorpera.com's box sends (landing/src/site/site.js): the idea, and the kind of company picked.
 * "kind", not "type": the sign-in callback takes a type parameter. */
const WEBSITE_KEYS = ["ide", "idea", "kind"] as const;

/** qorpera.com's arrow opens `app.qorpera.com/?ide=…&kind=…`; a link may also say `#/new?idea=…`. What it carries
 * is kept for the new-company box (a sign-in may come first), the page goes to that box, and the words leave the
 * address at once, so they never stay in the history or a copied link. */
function holdWebsiteIdea(): void {
	const route = currentRoute();
	const url = new URL(location.href);
	const fromLink = route.name === "new" && location.hash !== routeHash(route);
	const fromQuery = WEBSITE_KEYS.some((key) => url.searchParams.has(key));
	if (!fromLink && !fromQuery) return;
	const idea =
		(route.name === "new" ? route.idea : undefined) || url.searchParams.get("ide") || url.searchParams.get("idea");
	const kind = url.searchParams.get("kind");
	keepWebsiteIdea({ ...(idea ? { idea } : {}), ...(kind ? { kind } : {}) });
	for (const key of WEBSITE_KEYS) url.searchParams.delete(key);
	url.hash = routeHash({ name: "new" });
	history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
