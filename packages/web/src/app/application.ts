import { CloudSurfacesClient } from "@qorpera/cloud-client/surfaces";
import type { SurfaceSummary } from "@qorpera/contracts";
import type { User } from "@supabase/supabase-js";
import { withAbortScopes } from "../cloud/abort-scope.ts";
import { CloudApi } from "../cloud/api.ts";
import { forgetChatGptPlanSignIn, takeChatGptPlanReturn } from "../cloud/chatgpt-plan-sign-in.ts";
import { type Cloud, CloudRpcError, describeError, translateCloudErrors } from "../cloud/client.ts";
import { createWebCompanyAgents } from "../cloud/company-agents.ts";
import { WebCompanyFiles } from "../cloud/company-files.ts";
import { askCompanyNumbers } from "../cloud/company-numbers.ts";
import { WebCompanyComputer } from "../cloud/computer.ts";
import { createWebConnectors, takeConnectorReturn } from "../cloud/connectors.ts";
import { createDigitalPostKeys, readDigitalPost } from "../cloud/digital-post.ts";
import { createWebEventHooks } from "../cloud/event-hooks.ts";
import { interfacePageCalls } from "../cloud/interface-pages.ts";
import { createWebMemberNotifications } from "../cloud/member-notifications.ts";
import { createWebNativeSubscription } from "../cloud/native-subscription.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import { type CodeReleases, codeReleaseCalls } from "../cloud/releases.ts";
import { createWebRoutines } from "../cloud/routines.ts";
import { createWebSessionAttachments } from "../cloud/session-attachments.ts";
import { createWebSessionInputWriter } from "../cloud/session-input.ts";
import { createWebSessionModel } from "../cloud/session-model.ts";
import { createWebSessionRunControl } from "../cloud/session-run-control.ts";
import { createWebSiteHosting } from "../cloud/site-hosting.ts";
import { type CompanySite, createWebSites, siteOfLink } from "../cloud/sites.ts";
import { loadSkillSuggestions, SkillLists } from "../cloud/skills.ts";
import type { HostedProfile } from "../cloud/types.ts";
import { agentFigure, nativeColorOf } from "../ui/avatar.ts";
import { watchBrowserBar } from "../ui/browser-bar.ts";
import { companyLogos, setCompanyLogos } from "../ui/company-logos.ts";
import { companyInSentence, companyNameText } from "../ui/company-name.ts";
import { button, h, icon, notice, replace } from "../ui/dom.ts";
import { installHoverGlides } from "../ui/hover-glide.ts";
import { disposeCardPictures, type InteractionCardApp, refreshAppPreviews } from "../ui/interaction-card.ts";
import { interfaceEmblem } from "../ui/interface-emblem.ts";
import { isPhoneLayout } from "../ui/layout.ts";
import { personPictures, setPersonPictures } from "../ui/person-pictures.ts";
import { applyLanguage, presentationLocale, t, watchTheme } from "../ui/preferences.ts";
import { RailLayout } from "../ui/rail-layout.ts";
import { blankSkeleton, pageSkeleton, railSkeleton, threadSkeleton } from "../ui/skeleton.ts";
import { deferOffFrame } from "../ui/time-slice.ts";
import { AgentNotes } from "./agent-notes.ts";
import type { AppTellSource, HeldNote } from "./app-actions.ts";
import { AuthController, accountName, displayName, needsPassword } from "./auth.ts";
import { agentWorks, CompanyController } from "./company.ts";
import { CompanyDatabases } from "./company-data.ts";
import { CompanyLogos } from "./company-logos.ts";
import { CompanyMail } from "./company-mail.ts";
import { CompanyReading, readCompanyStanding } from "./company-reading.ts";
import { DATA_PAGE, wantDataList } from "./data-page.ts";
import { folderImageReader } from "./folder-images.ts";
import { FoundingController } from "./founding.ts";
import {
	type CompanyApp,
	CompanyApps,
	CompanyData,
	CompanyNumbers,
	companyConcepts,
	sharedFolderHints,
} from "./interface-apps.ts";
import type { InterfaceWrites } from "./interface-claims.ts";
import { CompanyInterfaceFolder } from "./interface-folder.ts";
import { CompanyInterfacePages } from "./interface-pages.ts";
import { companyInterfaces, pagesOn } from "./interfaces.ts";
import { MemberPictures } from "./member-pictures.ts";
import { newVersionNotice, runningBuildFiles, watchNewVersion } from "./new-version.ts";
import { watchOnline } from "./online-mark.ts";
import { OpenQuestions } from "./open-questions.ts";
import { COMPANY_PRESENCE_PLACE } from "./presence-place.ts";
import { type CompanyReleaseReads, companyReleaseReads } from "./release-reads.ts";
import { currentRoute, navigate, type Route, routeHash } from "./router.ts";
import { createConversationStarter } from "./start-conversation.ts";
import { debounce } from "./state.ts";
import { inferSurfaceKind } from "./surface-kinds.ts";
import {
	attachSurfaces,
	isLocalSurfaceId,
	readSurfaceFolderFiles,
	SurfacesStore,
	surfacesDisabledOf,
	surfacesOf,
} from "./surfaces-store.ts";
import { showWaitingInTitle } from "./tab-title.ts";
import { noteReceiver, type TellAccounts, tellAgent } from "./tell-agent.ts";
import { createGroupDeleter, createGroupUpdater } from "./update-group.ts";
import { type AccountViewState, renderAccount } from "./views/account.ts";
import { AgentDetails } from "./views/agent-details.ts";
import { savedAgentDraft } from "./views/agent-edits.ts";
import { AppPanel, type AppPanelHost, type SidePanelTarget, sameTarget } from "./views/app-panel.ts";
import { noteBankReturn } from "./views/bank.ts";
import { CompanyFolderBrowser } from "./views/company-folder.ts";
import { chooseInCompanyFolder } from "./views/company-folder-choose.ts";
import { ComputerPanels } from "./views/computer.ts";
import { ConceptsView } from "./views/concepts.ts";
import { type AgentPage, ConversationView } from "./views/conversation.ts";
import { ExecutionNotices } from "./views/execution-notices.ts";
import { FeedbackView } from "./views/feedback.ts";
import { FoundingView } from "./views/founding.ts";
import { FriendsWindow } from "./views/friends-window.ts";
import { GroupDetails } from "./views/group-details.ts";
import { HubController, renderHub } from "./views/hub.ts";
import { disposeInterface, renderInterface } from "./views/interface.ts";
import { type MeetState, renderMeet } from "./views/meet.ts";
import { MemberChatView } from "./views/member-chat.ts";
import {
	hasWebsiteIdea,
	keepWebsiteIdea,
	relabelNewCompany,
	renderNewCompany,
	type Viewer,
} from "./views/new-company.ts";
import { NewConversationView } from "./views/new-conversation.ts";
import { NewProgramPage, type ProgramAddHost } from "./views/program-add.ts";
import type { QuestionDockHost } from "./views/question-dock.ts";
import { type SettingsTab, SettingsView } from "./views/settings.ts";
import { finishPlanSignIn, memberPlanSignIn } from "./views/settings-connections.ts";
import { MyGoodWillView, takeGoodWillReturn } from "./views/settings-good-will.ts";
import { SitesView } from "./views/settings-sites.ts";
import {
	appLook,
	clearShellCompanyState,
	installSearchShortcut,
	renderRail,
	renderTopbar,
	type ShellContext,
} from "./views/shell.ts";
import { renderNameAsk, renderPasswordAsk, renderSignIn } from "./views/signin.ts";
import { SiteView } from "./views/site-view.ts";
import { landStartCrown, settleStartCrown } from "./views/start-crown.ts";
import { openMigrationSheet } from "./views/surface-migration-sheet.ts";
import { type SurfaceMount, SurfaceView } from "./views/surface-view.ts";
import { renderTeam, type TeamFeedback } from "./views/team.ts";
import { liveVersions, WhatsNewView, whatsNewEntry } from "./views/whats-new.ts";
import type { WorkspaceActions } from "./workspace-actions.ts";

/* Entry point. One cloud client, one auth controller, one company controller
 * at a time. The route decides the view; every view renders from cloud state
 * and re-renders on store changes. */

/** Each company's skill lists, shared by its conversations' composers. */
const skillLists = new WeakMap<CompanyController, SkillLists>();

/** What the company's store keeps of its sites as read: how many, for the drawer's Sites entry, and the list, for the
 * owed row's websites and their views. */
function sitesListed(list: readonly CompanySite[]): { siteCount: number; siteList: readonly CompanySite[] } {
	return { siteCount: list.length, siteList: list };
}

const appsByNameCache = new WeakMap<readonly CompanyApp[], Map<string, CompanyApp>>();
function appsByName(apps: readonly CompanyApp[]): Map<string, CompanyApp> {
	let index = appsByNameCache.get(apps);
	if (!index) {
		index = new Map(apps.map((app) => [app.name, app]));
		appsByNameCache.set(apps, index);
	}
	return index;
}

/** An app of the company a question option's preview names (`app:<name>`): its title, emblem and cover, from the
 * company's apps as last read. Undefined while they have not been read, or when no such app is there. */
function cardAppOf(apps: readonly CompanyApp[] | undefined, name: string): InteractionCardApp | undefined {
	const found = apps ? appsByName(apps).get(name) : undefined;
	const manifest = found?.manifest;
	return manifest
		? {
				title: manifest.name,
				emblem: manifest.emblem,
				cover: manifest.cover ? `${found.path}/${manifest.cover}` : null,
			}
		: undefined;
}

export function mountApplication(
	root: HTMLElement,
	cloud: Cloud,
	api = new CloudApi(cloud),
	workspaceActions: WorkspaceActions = {},
): () => void {
	translateCloudErrors(t);
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
	// Every company figure shows the company's own logo through this store, once it has one.
	const logos = new CompanyLogos(api);
	setCompanyLogos(logos);

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
	const reopenRailBtn = h(
		"button",
		{
			type: "button",
			class: "icon-button rail-reopen-btn",
			"aria-label": t("Show sidebar"),
			title: t("Show sidebar"),
			"aria-controls": "company-navigation",
			"aria-expanded": "false",
			hidden: true,
			onclick: () => {
				railLayout.setHidden(false);
				syncRailReopen();
				render();
			},
		},
		icon("navigation"),
	);
	// A deploy since this tab loaded: one quiet line offers the new build (app/new-version.ts).
	const versionLine = h("div", { class: "app-version-notice", hidden: true });
	const versionWatch = new AbortController();
	const frame = h(
		"div",
		{ class: "frame" },
		topbar,
		h("div", { class: "body" }, backdrop, rail, reopenRailBtn, main),
		versionLine,
	);
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
	function syncRailReopen(): void {
		const show = !rail.hidden && railLayout.hidden && !isPhoneLayout();
		reopenRailBtn.hidden = !show;
		reopenRailBtn.setAttribute("aria-expanded", String(!railLayout.hidden));
	}
	window.addEventListener("qorpera-rail-resize", syncRailReopen, { signal: versionWatch.signal });
	installHoverGlides(versionWatch.signal);
	syncRailReopen();
	applyLanguage();
	// Interface text and times are read when they are drawn: a new language or
	// time zone redraws the screens in place (see redrawScreens).
	window.addEventListener("languagechange", onLanguage);
	window.addEventListener("qorpera-language-change", onLanguage);
	window.addEventListener("qorpera-time-zone-change", redrawScreens);
	const unwatchTheme = watchTheme();
	const unwatchBrowserBar = watchBrowserBar(root);
	let disposed = false;
	let settings: SettingsView | undefined;
	let feedback: FeedbackView | undefined;
	let friendsWindow: FriendsWindow | undefined;
	/** Friends see this account online while a tab is in front (online-mark.ts). */
	const online = watchOnline(
		() => api.markOnline(),
		() => Boolean(auth.userId),
	);
	function closeFriends(restoreFocus = true): void {
		if (!friendsWindow) return;
		friendsWindow.dispose();
		friendsWindow = undefined;
		if (!restoreFocus) return;
		// Opened over Settings, Friends give the focus back to Settings' own Friends button.
		(
			settings?.el.querySelector<HTMLElement>(".settings-friends") ??
			frame.querySelector<HTMLElement>(".account-friends")
		)?.focus();
	}
	/** Friends as a window of its own, over whatever is open: Settings stay open behind it (Jonas, 9 Nov 2026). */
	function openFriends(): void {
		if (friendsWindow || feedback || !auth.userId) return;
		// Over Settings it shares their friends list, so the invitation picker behind it follows every change.
		friendsWindow = new FriendsWindow(api, hub, () => closeFriends(), settings?.friends);
		root.append(friendsWindow.el);
		friendsWindow.open();
	}
	function closeFeedback(restoreFocus = true): void {
		if (!feedback) return;
		feedback.dispose();
		feedback = undefined;
		if (restoreFocus) frame.querySelector<HTMLElement>(".account-trigger")?.focus();
	}
	function openFeedback(): void {
		if (feedback || settings || friendsWindow || !auth.userId) return;
		feedback = new FeedbackView(api, () => closeFeedback());
		root.append(feedback.el);
		feedback.open();
	}
	function closeSettings(restoreFocus = true): void {
		// A Friends window over Settings uses their friends list: it closes with them (access to the company lost).
		if (settings) closeFriends(false);
		settings?.dispose();
		settings = undefined;
		frame.inert = false;
		if (restoreFocus) frame.querySelector<HTMLElement>(".account-trigger")?.focus();
	}
	let filesShown: { owner: CompanyController; browser: CompanyFolderBrowser } | undefined;
	let filesPending: { owner: CompanyController; path: string } | undefined;
	function filesSlug(controller: CompanyController): string {
		return (
			surfacesOf(controller)?.state.surfaces.find(
				(surface) => surface.archetype === "ops" && inferSurfaceKind(surface) === "files",
			)?.slug ?? "files"
		);
	}
	function openInFiles(path: string): void {
		const controller = company;
		if (!controller) return;
		if (settings) closeSettings(false);
		const shown = filesShown?.owner === controller ? filesShown.browser : undefined;
		shown?.reveal(path);
		filesPending = shown?.opened || surfacesDisabledOf(controller) ? undefined : { owner: controller, path };
		navigate({
			name: "company",
			profileId: controller.profile.profileId,
			section: "surface",
			id: filesSlug(controller),
		});
	}
	function openSettings(tab?: SettingsTab): void {
		if (settings || feedback || !auth.userId) return;
		closeFriends(false);
		settings = new SettingsView(
			api,
			auth,
			hub,
			profiles,
			company?.store.get().accessLost ? undefined : company,
			() => closeSettings(),
			companyRemovedHandler(),
			tab,
			openFriends,
		);
		frame.inert = true;
		root.append(settings.el);
		settings.focus();
	}
	/** Shows a Company File page beside the open chat. Again on what is shown already, it reads it again. */
	function openSide(target: SidePanelTarget): void {
		if (!conversation?.el.isConnected || !sidePanel) return;
		const shown = conversation.beside;
		if (shown instanceof AppPanel && sameTarget(shown.target, target)) {
			void shown.reload(true);
			shown.focus();
			return;
		}
		conversation.showBeside(sidePanel(target));
	}
	/** Opens an agent's app as a page of its own (`#/c/{id}/a/{name}`), or a concept of the company's product in the
	 * Concepts viewer (`#/c/{id}/concepts/{name}`); shown already, it reads it again. */
	function openApp(name: string): void {
		const controller = company;
		if (!controller) return;
		const route = currentRoute();
		if (isConcept(controller, name)) {
			if (
				conceptsView &&
				route.name === "company" &&
				route.profileId === controller.profile.profileId &&
				route.section === "concepts" &&
				conceptsView.selected === name
			) {
				conceptsView.reload();
				return;
			}
			navigate({ name: "company", profileId: controller.profile.profileId, section: "concepts", id: name });
			return;
		}
		if (
			appPage &&
			route.name === "company" &&
			route.profileId === controller.profile.profileId &&
			route.section === "app" &&
			route.id === name
		) {
			void appPage.reload(true);
			appPage.focus();
			return;
		}
		navigate({ name: "company", profileId: controller.profile.profileId, section: "app", id: name });
	}
	/** Whether the open company's app `name` is a concept of its product, as its apps were last read. */
	function isConcept(controller: CompanyController, name: string): boolean {
		return companyConcepts(controller.store.get().apps ?? []).some((app) => app.name === name);
	}
	function onFolderLink(event: MouseEvent): void {
		const page = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-open-page]") : null;
		if (page?.dataset.openPage && company && !event.defaultPrevented) {
			event.preventDefault();
			const profileId = company.profile.profileId;
			wantDataList(profileId, page.dataset.openAt);
			navigate({ name: "company", profileId, section: "interface", id: page.dataset.openPage });
			return;
		}
		const app = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-app-name]") : null;
		if (app?.dataset.appName && !event.defaultPrevented) {
			event.preventDefault();
			openApp(app.dataset.appName);
			return;
		}
		// A link to the page of the app that is already open (its icon in the rail) leads nowhere new, and the app's page
		// has no Reload of its own: an ordinary press on it reads the app again, which also lets it ask again (§5). A
		// modified click stays the link's own (a new tab), and a link to any other place goes there by itself.
		const here = event.target instanceof Element ? event.target.closest<HTMLElement>("a[data-href]") : null;
		if (here && !event.defaultPrevented && appPage && here.getAttribute("data-href") === location.hash) {
			const route = currentRoute();
			const ordinary = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
			if (ordinary && route.name === "company" && route.section === "app" && route.id) {
				event.preventDefault();
				openApp(route.id);
				return;
			}
		}
		const link = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-folder-path]") : null;
		const path = link?.dataset.folderPath;
		if (path === undefined || event.defaultPrevented) return;
		event.preventDefault();
		const fromConversation = conversation !== undefined && main.contains(link);
		// An HTML page in an agent's message opens beside the chat, live.
		if (fromConversation && conversation?.el.isConnected && sidePanel && /\.html?$/i.test(path)) {
			openSide({ kind: "page", path });
			return;
		}
		openInFiles(path);
	}
	root.addEventListener("click", onFolderLink);
	installSearchShortcut();
	// An app's card in a message names it by its folder; once the company's apps are read it shows the app as the drawer
	// does (its emblem in its colour there, views/shell.ts `appLook`) and what it is about in one line, whole on a
	// hover (ui/markdown.ts draws the card plain, as it has no company). The card a note from an app opens with keeps
	// what the note is about as its line, and takes the app's own name as its title.
	// A question card's option that previews an app gets the app's cover, or its emblem and title, the same way: in a
	// thread, in an app's page and in the Concepts viewer's dock, all on this page, and without redrawing the card, so
	// a pick or an answer being typed stays (ui/interaction-card.ts refreshAppPreviews; review r1 of #1763, F1).
	const APP_CARD_SELECTOR = ".app-card[data-app-name], [data-preview-app]";
	const hasDecoratableCard = (records: readonly MutationRecord[]): boolean => {
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (!(node instanceof Element)) continue;
				if (node.matches(APP_CARD_SELECTOR) || node.querySelector(APP_CARD_SELECTOR) !== null) return true;
			}
		}
		return false;
	};
	const decorateAppCards = () => {
		const apps = company?.store.get().apps;
		if (!company || !apps) return;
		const byName = appsByName(apps);
		refreshAppPreviews(main, (name) => cardAppOf(apps, name), cardImages.get(company));
		for (const card of main.querySelectorAll<HTMLElement>(".app-card[data-app-name]")) {
			const app = card.dataset.appName ? byName.get(card.dataset.appName) : undefined;
			const look = app && appLook(company, app);
			if (!app?.manifest || !look) continue;
			const about = app.manifest.about ?? "";
			const shown = JSON.stringify([look.key, about, app.manifest.name]);
			if (card.dataset.shown === shown) continue;
			card.dataset.shown = shown;
			card.querySelector(".app-card-emblem")?.replaceChildren(look.emblem());
			if (look.colour) card.style.setProperty("--app-colour", look.colour);
			else card.style.removeProperty("--app-colour");
			if (card.classList.contains("is-note")) {
				const title = card.querySelector<HTMLElement>(".app-card-title");
				if (title) title.textContent = app.manifest.name;
				continue;
			}
			const note = card.querySelector<HTMLElement>(".app-card-note");
			if (!note) continue;
			note.textContent = about || t("App");
			if (about) note.title = about;
			else note.removeAttribute("title");
		}
	};
	let decorating = false;
	const appCardObserver = new MutationObserver((records) => {
		if (decorating || !hasDecoratableCard(records)) return;
		decorating = true;
		queueMicrotask(() => {
			try {
				if (!disposed) decorateAppCards();
			} finally {
				appCardObserver.takeRecords();
				decorating = false;
			}
		});
	});
	appCardObserver.observe(main, { childList: true, subtree: true });
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
		// An accepted company invitation opens the company: the Friends window gives way to it.
		closeFriends(false);
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
	let companyDatabases: CompanyDatabases | undefined;
	/** What the open company's pages read from its folder, its tables and files, followed there (Interfaces step I7). */
	let interfaceFolder: CompanyInterfaceFolder | undefined;
	let surfaceFolderHints: { close(): Promise<void> } | undefined;
	/** The agents' interface apps in the open company's folder, followed there (RUNTIME-INTERFACE-APPS.md §4). */
	let companyApps: CompanyApps | undefined;
	/** The agents' next runs for the rail's line under each name (app/agent-notes.ts), while the company is open. */
	let agentNotes: AgentNotes | undefined;
	/** Makes the side panel of a Company File page for the open company: set while one is drawn. */
	let sidePanel: ((target: SidePanelTarget) => AppPanel) | undefined;
	/** The agent's app on its own page (`#/c/{id}/a/{name}`), while that route shows. */
	let appPage: AppPanel | undefined;
	/** The open company's last conversation, where an app's page leads back to. */
	let appReturn: string | undefined;
	/** The company's concepts, full screen (`#/c/{id}/concepts`), while that route shows. */
	let conceptsView: ConceptsView | undefined;
	/** The company's Sites page (`#/c/{id}/sites`), kept while that route shows. */
	let sitesPage:
		| { readonly company: CompanyController; readonly view: SitesView; readonly el: HTMLElement }
		| undefined;
	/** The company whose sites were read for the apps drawer. */
	let sitesRead: CompanyController | undefined;
	/** One of the company's websites, live with its numbers (`#/c/{id}/site/{slug}`), kept while that route shows. */
	let siteView:
		| {
				readonly company: CompanyController;
				readonly slug: string;
				readonly view: SiteView;
				readonly el: HTMLElement;
		  }
		| undefined;
	/** The company's What's new page (`#/c/{id}/whats-new`), kept while that route shows, and the company read for the
	 * apps drawer's entry. */
	let whatsNewPage:
		| { readonly company: CompanyController; readonly view: WhatsNewView; readonly el: HTMLElement }
		| undefined;
	let newProgramPage: { readonly company: CompanyController; readonly view: NewProgramPage } | undefined;
	let surfaceView: { readonly company: CompanyController; readonly view: SurfaceView } | undefined;
	const pendingSurfaceDisposals = new Set<() => void>();
	const flushPendingSurfaceDisposals = (): void => {
		for (const run of [...pendingSurfaceDisposals]) run();
	};
	const deferSurfaceDisposal = (view: SurfaceView): void => {
		view.deactivate();
		let cancel: (() => void) | undefined;
		const finish = () => {
			if (!pendingSurfaceDisposals.delete(finish)) return;
			cancel?.();
			cancel = undefined;
			view.dispose();
		};
		pendingSurfaceDisposals.add(finish);
		cancel = deferOffFrame(finish);
	};
	let releasesRead: CompanyController | undefined;
	/** The open company's mail as the member reads it, for the Mailbox page (Interfaces step I5c). */
	let mail: CompanyMail | undefined;
	let computer: WebCompanyComputer | undefined;
	let computerPanels: ComputerPanels | undefined;
	let conversation: ConversationView | undefined;
	/** The chat with another member on screen, and the company it is in. */
	let memberChat: { view: MemberChatView; company: CompanyController } | undefined;
	/** The agent or group chat card opened from the rail, and what an agent card asked for once its chat is on screen. */
	let agentCard: AgentDetails | GroupDetails | undefined;
	let agentPage: { agentId: string; page: AgentPage; until: number } | undefined;
	const cardImages = new WeakMap<CompanyController, ReturnType<typeof folderImageReader>>();
	/** Each company's What's new reads and writes, as the apps drawer, What's new's page and the threads' "a change is
	 * ready" cards make them: numbered as they start, one shared read out at a time for the drawer and the threads, never
	 * across a write from any of them, and the latest-started answer as the company's last read (app/release-reads.ts). */
	const releaseReads = new WeakMap<CompanyController, CompanyReleaseReads>();
	const companyReleases = (controller: CompanyController): CompanyReleaseReads => {
		let reads = releaseReads.get(controller);
		if (!reads) {
			reads = companyReleaseReads(codeReleaseCalls(cloud, controller.profile.profileId), controller.signal);
			releaseReads.set(controller, reads);
		}
		return reads;
	};
	/** The drawer's entry and the versions the Sites page names, from the company's latest-started read that answered:
	 * an answer that comes back after a newer one changes neither. `read` stands in until one did. */
	const showReleases = (controller: CompanyController, read: CodeReleases) => {
		const newest = companyReleases(controller).last ?? read;
		const nextWhatsNew = whatsNewEntry(controller, newest);
		const nextVersions = liveVersions(newest);
		const prev = controller.store.get();
		if (
			JSON.stringify(prev.whatsNew) === JSON.stringify(nextWhatsNew) &&
			JSON.stringify(prev.siteVersions) === JSON.stringify(nextVersions)
		)
			return;
		controller.store.set({ whatsNew: nextWhatsNew, siteVersions: nextVersions });
	};
	/** Each company's open questions for its app pages and Concepts viewer, read only while one is on screen. */
	const appQuestions = new WeakMap<CompanyController, OpenQuestions>();
	/** Each company's databases for its app pages: one held watch call for all of them, while the company is open. */
	const appData = new WeakMap<CompanyController, CompanyData>();
	/** Each company's platform numbers for its app pages (`qorpera/*`), while the company is open. */
	const appNumbers = new WeakMap<CompanyController, CompanyNumbers>();
	/** Notes held for the company's apps, by app, while their thread could not take them (app/app-actions.ts
	 * `HeldNote`): kept while the company is open, whichever page the member goes to meanwhile. */
	const heldNotes = new WeakMap<
		CompanyController,
		{ readonly notes: Map<string, HeldNote>; readonly back: Map<string, () => void> }
	>();
	const askAccounts = new WeakMap<CompanyController, TellAccounts>();
	/** Each company's reading of itself for its app pages that read `reading` (the map kit), while the company is open. */
	const appReading = new WeakMap<CompanyController, CompanyReading>();
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
			closeFriends(false);
			accountUserId = userId;
			online.mark();
			pictures.reset();
			logos.reset();
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
			openFriends,
			invitations: hub.store.get().invitations.length,
			...(route.name === "company" && route.section !== "meet" && company && !company.store.get().accessLost
				? {
						navigation: { open: navigationOpen, toggle: () => setNavigationOpen(!navigationOpen) },
						sidebar: {
							hidden: railLayout.hidden,
							toggle: () => {
								railLayout.toggleHidden();
								syncRailReopen();
								render();
							},
						},
					}
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
		reopenRailBtn.setAttribute("aria-label", t("Show sidebar"));
		reopenRailBtn.title = t("Show sidebar");
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
		memberChat?.view.dispose();
		memberChat = undefined;
		appPage?.dispose();
		appPage = undefined;
		conceptsView?.dispose();
		conceptsView = undefined;
		sitesPage?.view.dispose();
		sitesPage = undefined;
		siteView?.view.dispose();
		siteView = undefined;
		whatsNewPage?.view.dispose();
		whatsNewPage = undefined;
		newProgramPage?.view.dispose();
		newProgramPage = undefined;
		surfaceView?.view.dispose();
		surfaceView = undefined;
		flushPendingSurfaceDisposals();
		if (newConversation && !newConversation.hasInput) {
			newConversation.dispose();
			newConversation = undefined;
		}
		render();
	}

	function disposeCompanyViews(): void {
		disposeInterface(main);
		notices?.dispose();
		notices = undefined;
		interfacePages?.dispose();
		interfacePages = undefined;
		companyDatabases?.dispose();
		companyDatabases = undefined;
		interfaceFolder?.dispose();
		interfaceFolder = undefined;
		void surfaceFolderHints?.close();
		surfaceFolderHints = undefined;
		companyApps?.dispose();
		companyApps = undefined;
		agentNotes?.dispose();
		agentNotes = undefined;
		sidePanel = undefined;
		appPage?.dispose();
		appPage = undefined;
		appReturn = undefined;
		sitesPage?.view.dispose();
		sitesPage = undefined;
		siteView?.view.dispose();
		siteView = undefined;
		whatsNewPage?.view.dispose();
		whatsNewPage = undefined;
		newProgramPage?.view.dispose();
		newProgramPage = undefined;
		surfaceView?.view.dispose();
		surfaceView = undefined;
		flushPendingSurfaceDisposals();
		conceptsView?.dispose();
		conceptsView = undefined;
		mail?.dispose();
		mail = undefined;
		agentCard?.dispose();
		agentCard = undefined;
		conversation?.dispose();
		conversation = undefined;
		memberChat?.view.dispose();
		memberChat = undefined;
		newConversation?.dispose();
		newConversation = undefined;
		computerPanels?.dispose();
		computerPanels = undefined;
	}

	function teardownCompany(): void {
		settingsAfterHome = undefined;
		clearShellCompanyState(company);
		disposeCompanyViews();
		executionNotices.replaceChildren();
		unsubscribeCompany?.();
		unsubscribeCompany = undefined;
		company?.stop();
		pendingCompany = undefined;
		company = undefined;
		sitesRead = undefined;
		releasesRead = undefined;
		showWaitingInTitle(0);
		agentPage = undefined;
		computer = undefined;
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
		if (pendingCompany?.profileId === profileId && pendingCompany.revision === routeRevision) {
			if (!profiles.some((item) => item.profileId === profileId)) return pendingCompany.promise;
			pendingCompany = undefined;
		}
		teardownCompany();
		const current = captureRoute();
		const currentHub = hub;
		if (!profiles.find((item) => item.profileId === profileId) && currentHub.store.get().connectionLost)
			return undefined;
		let settled = false;
		let clearOnFinish = true;
		let pending: { profileId: string; revision: number; promise: Promise<CompanyController | undefined> } | undefined;
		const promise = (async () => {
			try {
				let profile = profiles.find((item) => item.profileId === profileId);
				if (!profile) {
					await currentHub.refresh();
					if (!current()) return undefined;
					profile = currentHub.store.get().profiles.find((item) => item.profileId === profileId);
				}
				const userId = auth.userId;
				if (!current() || !profile || !userId) {
					if (current() && userId && !currentHub.store.get().connectionLost) clearOnFinish = false;
					return undefined;
				}
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
										(route.section === "new" && startingSession?.sessionId === target) ||
										// A note the member sent from elsewhere in the company (an app's page, the Mailbox, Generate icon
										// in the apps drawer), on its way: their press, which named the agent, stands for the thread on
										// screen (CompanyController.sendNote).
										controller.noteOnItsWay(target)
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
					online,
				);
				company = controller;
				const localDev =
					typeof location !== "undefined" &&
					(location.hostname === "127.0.0.1" || location.hostname === "localhost");
				const sandboxParam =
					typeof location !== "undefined" && new URLSearchParams(location.search).get("sandbox") === "1";
				const loadSurfaceCloudFiles = async (
					surface: SurfaceSummary,
					signal: AbortSignal,
				): Promise<Readonly<Record<string, string>> | undefined> => {
					const team = controller.store.get().team;
					if (!team) return undefined;
					const roots = [
						surface.folderRoot?.replace(/^\/+|\/+$/g, ""),
						`QorperaOS/surfaces/${surface.slug}/notes`,
					].filter((item): item is string => Boolean(item));
					if (!roots.length) return {};
					const readScope = new AbortController();
					const forwardAbort = () => readScope.abort();
					if (controller.signal.aborted || signal.aborted) {
						readScope.abort();
					} else {
						controller.signal.addEventListener("abort", forwardAbort, { once: true });
						signal.addEventListener("abort", forwardAbort, { once: true });
					}
					try {
						const folder = new WebCompanyFiles(
							cloud,
							controller.profile,
							controller.userId,
							team.role,
							readScope.signal,
							() => {
								if (
									disposed ||
									company !== controller ||
									auth.userId !== userId ||
									controller.store.get().accessLost
								)
									throw new Error(t("Company access changed."));
							},
							team.capabilities.write,
						).folder();
						return await readSurfaceFolderFiles(folder, roots, readScope.signal);
					} finally {
						controller.signal.removeEventListener("abort", forwardAbort);
						signal.removeEventListener("abort", forwardAbort);
					}
				};
				const surfaces = new SurfacesStore({
					companyId: profile.profileId,
					companyName: profile.profileName,
					localInteractive: localDev,
					...(sandboxParam ? { sandboxMode: true } : {}),
					client: new CloudSurfacesClient(cloud.supabase),
					synthesize: () => ({
						companyId: profile.profileId,
						sites: controller.store.get().siteList ?? [],
						pages: companyInterfaces(controller).map((entry) => entry.name),
					}),
					migration: () => {
						const state = controller.store.get();
						const cofounderId = controller.cofounderId();
						return {
							companyId: profile.profileId,
							agents: state.staff
								.filter((agent) => agent.employmentStatus === "active" && agent.id !== cofounderId)
								.map((agent) => ({
									id: agent.id,
									handle: agent.displayName,
									name: agent.displayName,
									role: agent.role,
								})),
							boards: (state.apps ?? [])
								.filter((app) => app.manifest?.posted === true && !app.manifest.concept)
								.map((app) => ({
									name: app.name,
									title: app.manifest?.name ?? app.name,
									kit: app.manifest?.kit ?? null,
								})),
						};
					},
					signal: controller.signal,
					unavailableMessage: t("Surfaces aren't enabled for this company yet."),
					onNavigateSurface: (slug) =>
						navigate({ name: "company", profileId: profile.profileId, section: "surface", id: slug }),
					realtimeLive: () => controller.store.get().realtime === "connected",
					memberName: (memberId) => {
						const found = controller.store.get().team?.members.find((member) => member.userId === memberId);
						return found?.displayName || found?.email;
					},
					teammates: () =>
						(controller.store.get().team?.members ?? [])
							.filter((member) => member.userId !== controller.userId)
							.map((member) => ({ userId: member.userId, name: member.displayName || member.email })),
					peopleAtSurface: (slug) => controller.peopleByPlace().get(`surface:${slug.toLowerCase()}`) ?? [],
					loadCloudFiles: loadSurfaceCloudFiles,
					uploadImage: async (surfaceId, clientInputId, file, signal) => {
						const current = () => {
							signal.throwIfAborted();
							if (
								disposed ||
								company !== controller ||
								auth.userId !== userId ||
								controller.store.get().accessLost
							)
								throw new Error(t("Company access changed."));
						};
						const bytes = new Uint8Array(await file.arrayBuffer());
						current();
						if (bytes.length !== file.size) throw new Error(t("The selected image changed."));
						const saved = await createWebSessionAttachments(cloud, userId, signal, current).uploadSurface(
							surfaceId,
							clientInputId,
							bytes,
							file.type,
							signal,
						);
						return { sha256: saved.sha256, bytes: saved.bytes, mediaType: saved.mediaType };
					},
					readImage: async (sessionId, clientInputId, image, signal) => {
						const current = () => {
							signal.throwIfAborted();
							if (
								disposed ||
								company !== controller ||
								auth.userId !== userId ||
								controller.store.get().accessLost
							)
								throw new Error(t("Company access changed."));
						};
						const bytes = await createWebSessionAttachments(cloud, userId, signal, current).readSurface(
							sessionId,
							clientInputId,
							{ sha256: image.sha256, bytes: image.bytes, mediaType: image.mediaType },
							signal,
						);
						current();
						return new Blob([new Uint8Array(bytes)], { type: image.mediaType });
					},
				});
				attachSurfaces(controller, surfaces);
				surfaces.store.subscribe(() => render());
				controller.store.subscribe(() => surfaces.resynthesize());
				const stopSurfaceHints = controller.onInvalidate((resource) => {
					if (resource === "surfaces" || resource === "company-file") surfaces.onRealtimeHint(resource);
				});
				controller.signal.addEventListener("abort", stopSurfaceHints, { once: true });
				void surfaces.load();
				// A member who may write the folder brings the logo everyone sees in step with QorperaOS/brand/logo.svg once
				// the company has opened: its Branding & Identity agent may have drawn a new one meanwhile.
				const syncLogo = controller.store.subscribe(() => {
					const team = controller.store.get().team;
					if (!team || controller.store.get().accessLost) return;
					syncLogo();
					surfaces.refreshPendingCloudFiles();
					if (!team.capabilities.write) return;
					const current = () => {
						if (disposed || company !== controller || auth.userId !== userId || controller.store.get().accessLost)
							throw new Error(t("Company access changed."));
					};
					void logos
						.sync(
							profile.profileId,
							() => new WebCompanyFiles(cloud, profile, userId, team.role, controller.signal, current).folder(),
							controller.signal,
						)
						.catch(() => undefined);
				});
				// On a cloud from before each member's own sidebar (20260930727000), the company's sections are
				// QorperaOS/agents/sections.md and the rail's moves are the member's edits of it.
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
				// The bank's sign-in sent the member back to the Bank page they started it on, which finishes it. No other
				// connector is signed in from the web since Company connections left Settings (10 Nov 2026).
				if (connectorReturn?.connector === "bank") noteBankReturn(connectorReturn);
				connectorReturn = undefined;
				computer = new WebCompanyComputer(cloud, profile, userId, controller.signal, () => {
					if (disposed || company !== controller || auth.userId !== userId || controller.store.get().accessLost)
						throw new Error(t("Company access is unavailable."));
				});
				// Open computers outlive the thread they were opened in; leaving the company ends them. A `machines` hint
				// reads an open window's machines at once.
				computerPanels = new ComputerPanels(computer, controller.signal, {
					hints: (listener) => controller.onInvalidate(listener),
					// The machine's clock and backdrop follow the company's time zone (20260930739000).
					timeZone: () => controller.store.get().team?.timeZone,
					// The company's apps a member may open on a computer (20260930758000): each by its name, its entry page's
					// folder when the page is its index.html (the helper serves the folder), else the page itself.
					apps: () =>
						controller.store
							.get()
							.apps?.filter((app) => app.manifest !== null && app.manifest.kit !== "program")
							.map((app) => ({
								name: app.manifest?.name ?? app.name,
								path:
									app.manifest === null || app.manifest.entry === "index.html"
										? app.path
										: `${app.path}/${app.manifest.entry}`,
							})),
					// Open's "A file…": the company folder's own browser in choose mode, read as the member.
					chooseFile: (signal) => {
						const role = controller.store.get().team?.role;
						if (!role) return Promise.resolve(null);
						return chooseInCompanyFolder(
							new WebCompanyFiles(cloud, profile, userId, role, controller.signal, () => {
								if (
									disposed ||
									company !== controller ||
									auth.userId !== userId ||
									controller.store.get().accessLost
								)
									throw new Error(t("Company access changed."));
							}),
							signal,
						);
					},
				});
				unsubscribeCompany = controller.store.subscribe(() => render());
				void controller.start();
				return controller;
			} finally {
				settled = true;
				if (clearOnFinish && pending && pendingCompany === pending) pendingCompany = undefined;
			}
		})();
		if (!settled || !clearOnFinish) {
			pending = { profileId, revision: routeRevision, promise };
			pendingCompany = pending;
		}
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
		settleStartCrown();
		const current = captureRoute();
		const authState = auth.store.get();
		if (!authState.ready) {
			// A start that failed keeps saying so; a redraw (a route change) never blanks it again. index.html's
			// first screen (ui/boot.ts) stands until the app knows which screen to draw.
			if (startError) replace(root!, startError);
			else if (!root!.querySelector(":scope > .boot")) replace(root!, blankSkeleton(t("Connecting to the cloud")));
			return;
		}
		if (!authState.session || (authState.step.name === "reset" && authState.step.verified)) {
			teardownCompany();
			let container = root!.querySelector<HTMLElement>(':scope > .auth:not([data-step="name"])');
			if (!container) {
				container = h("div", { class: "brand-field" });
				replace(root!, container);
			}
			renderSignIn(auth, container);
			return;
		}
		if (!accountName(authState.user)) {
			teardownCompany();
			if (root!.querySelector(':scope > .auth[data-step="name"]')) return;
			const container = h("div", { class: "brand-field" });
			replace(root!, container);
			renderNameAsk(auth, container, () => render());
			return;
		}
		if (needsPassword(authState.user)) {
			teardownCompany();
			if (root!.querySelector(':scope > .auth[data-step="password"]')) return;
			const container = h("div", { class: "brand-field" });
			replace(root!, container);
			renderPasswordAsk(auth, container, () => render());
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
			route.name === "company" &&
				(route.section === "chat" || route.section === "new" || route.section === "member"),
		);
		// The Concepts viewer is full screen: no rail and no top bar, its own side panel instead.
		frame.classList.toggle("has-concepts", route.name === "company" && route.section === "concepts");
		if (route.name !== "company") {
			teardownCompany();
			rail.hidden = true;
			syncRailReopen();
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
								if (currentHub.store.get().profiles.some((item) => item.profileId === profileId)) {
									landStartCrown();
									navigate({ name: "company", profileId, section: "home" }, true);
								}
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
			rail.hidden = route.section === "meet" || route.section === "concepts";
			syncRailReopen();
			if (!rail.hidden) replace(rail, ...railSkeleton());
			if (
				route.section === "home" ||
				route.section === "chat" ||
				route.section === "staff" ||
				route.section === "new" ||
				route.section === "member"
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
			syncRailReopen();
			renderTopbar(topbar, shellContext(authState.user, route), undefined);
			const hubState = hub.store.get();
			const transient = hubState.connectionLost || (!hubState.loaded && !hubState.error);
			replace(
				main,
				h(
					"section",
					{ class: "page" },
					notice(
						transient ? "neutral" : "danger",
						transient
							? t("Can't reach Qorpera. Trying again…")
							: (hubState.error ?? t("This company is not available to your account.")),
					),
					hubState.error && !transient
						? button(t("Try again"), () => {
								pendingCompany = undefined;
								void hub.refresh();
							})
						: null,
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
		// An agent's app on its page, or a Company File page beside the chat (RUNTIME-INTERFACE-APPS.md §4, §5): read with
		// the member's own folder client, under the company's checks.
		// The agents' open questions about an app, answered on its page and in the Concepts viewer as in the chat
		// (app/open-questions.ts): the member's own model account for the thread, chosen as the thread chooses it.
		const questionsHost = (): QuestionDockHost => {
			let questions = appQuestions.get(controller);
			if (!questions) {
				questions = new OpenQuestions(
					controller,
					createWebNativeSubscription(
						cloud,
						controller.profile.profileId,
						controller.userId,
						controller.signal,
						companyCurrent,
					),
				);
				appQuestions.set(controller, questions);
				controller.signal.addEventListener("abort", questions.watch(), { once: true });
			}
			return {
				questions,
				agent: (agentId) => controller.staffById(agentId),
				memberName: (userId) => controller.memberName(userId),
				image: (path, signal) => (cardImage ? cardImage(path, signal) : Promise.resolve(null)),
				app: (name) => cardApp(name),
				conversation: (sessionId) => controller.conversation(sessionId, false),
			};
		};
		questionsHost();
		// The company's databases, asked and watched as the member through the member gateway; none where the build
		// names no member gateway.
		const dataHost = (): CompanyData | undefined => {
			if (!cloud.config.memberCompanyGatewayUrl) return undefined;
			let data = appData.get(controller);
			if (!data) {
				data = new CompanyData(
					() => {
						const role = controller.store.get().team?.role;
						const client = role
							? new WebCompanyFiles(
									cloud,
									controller.profile,
									controller.userId,
									role,
									controller.signal,
									companyCurrent,
								).data()
							: undefined;
						if (!client) throw new Error(t("Company access changed."));
						return client;
					},
					controller.signal,
					companyCurrent,
				);
				appData.set(controller, data);
			}
			return data;
		};
		// The platform's own numbers of the company (`qorpera/money-now` and the like), asked as the member with a plain
		// call to the cloud, so also where the build names no member gateway.
		const numbersHost = (): CompanyNumbers => {
			let numbers = appNumbers.get(controller);
			if (!numbers) {
				numbers = new CompanyNumbers(
					(asked) => askCompanyNumbers(cloud, controller.profile.environmentId, asked),
					controller.signal,
					companyCurrent,
				);
				appNumbers.set(controller, numbers);
			}
			return numbers;
		};
		// A note an app's page asks the member to send to the agent that owns the app (RUNTIME-INTERFACE-APPS.md §5
		// "tell"), written by the member on the bar: their own message in that agent's thread, or the Co-Founder's, on
		// their own model account for the thread, chosen as the thread chooses it (app/tell-agent.ts).
		const appNotes = (): AppTellSource => {
			let accounts: TellAccounts | undefined;
			const kept = () => {
				let found = heldNotes.get(controller);
				if (!found) {
					found = { notes: new Map(), back: new Map() };
					heldNotes.set(controller, found);
				}
				return found;
			};
			return {
				receiver: (owner) => {
					const found = noteReceiver(controller, owner);
					return "agent" in found ? { agentId: found.agent.id } : found;
				},
				agent: (agentId) => controller.staffById(agentId),
				held: (app) => kept().notes.get(app),
				// A note that was on its way and is held again is back for the app's page on screen, whichever sent it. Any
				// other kept note comes back when the app's page is next shown.
				hold: (app, note, isBack) => {
					const { notes, back } = kept();
					if (note) notes.set(app, note);
					else notes.delete(app);
					if (note && isBack) back.get(app)?.();
				},
				listen: (app, listener) => {
					const { back } = kept();
					back.set(app, listener);
					return () => {
						if (back.get(app) === listener) back.delete(app);
					};
				},
				send: (agentId, note) => {
					accounts ??= createWebNativeSubscription(
						cloud,
						controller.profile.profileId,
						controller.userId,
						controller.signal,
						companyCurrent,
					);
					return tellAgent(controller, accounts, agentId, { text: note.text, quotes: [], header: note.header });
				},
			};
		};
		// The company's reading of itself, its agents and its standing, for a page that reads `reading`
		// (app/company-reading.ts): read as the member, handed over as plain names.
		const readingHost = (): CompanyReading => {
			let reading = appReading.get(controller);
			if (!reading) {
				reading = new CompanyReading(
					{
						folder: () => memberFolder(companyCurrent, t("Company access changed.")),
						people: () => {
							const state = controller.store.get();
							return {
								staff: state.staff,
								working: (agentId) => agentWorks(controller.agentState(agentId)),
								cofounderId: controller.cofounderId(),
								members: state.team?.members ?? [],
								viewer: controller.userId,
							};
						},
						standing: () => readCompanyStanding(cloud, controller.profile.profileId),
					},
					controller.signal,
				);
				appReading.set(controller, reading);
			}
			return reading;
		};
		const cofounderFigure = (className: string) =>
			agentFigure(
				controller.staffById(controller.cofounderId()) ?? {
					id: "",
					displayName: "Co-Founder",
					appearance: { color: "", shape: "" },
					templateId: "co-founder",
				},
				"Co-Founder",
				{ size: 96, className },
			);
		const memberFirstName = (userId: string) => {
			const member = controller.store.get().team?.members.find((each) => each.userId === userId);
			const name = member ? member.displayName || member.email : "";
			return name ? (name.split(/\s+/)[0] ?? name) : null;
		};
		const programAdds = (): ProgramAddHost => ({
			writer: () => memberFolder(companyCurrent, t("Company access changed.")),
			userId: controller.userId,
			canWrite: () => controller.store.get().team?.capabilities.write === true,
			companyName: () => companyInSentence(controller.profile.profileName),
			appNames: () => (companyApps?.apps ?? []).map((app) => app.name),
			opened: (folder) => {
				try {
					companyCurrent();
				} catch {
					return;
				}
				navigate({ name: "company", profileId: controller.profile.profileId, section: "app", id: folder }, true);
			},
			cofounder: () => cofounderFigure("program-say-figure"),
		});
		const panelHost = (): AppPanelHost => ({
			programs: { userId: controller.userId, memberName: memberFirstName, adds: programAdds() },
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
							working: agentWorks(now),
						};
					}),
			reading: readingHost(),
			readApps: () => companyApps?.read() ?? Promise.resolve([]),
			apps: () => companyApps?.apps ?? [],
			agentName: (agentId) => (agentId ? (controller.staffById(agentId)?.displayName ?? null) : null),
			onFolderChange: (listener) => companyApps?.onChange(listener) ?? (() => {}),
			openInFiles,
			// A link to an app in an app's page, as its card in a message.
			openApp,
			budgetKey: controller.profile.profileId,
			questions: questionsHost(),
			// A change an app asked for and the member allowed is the member's own save, under the company's checks.
			writer: () => memberFolder(companyCurrent, t("Company access changed.")),
			current: companyCurrent,
			data: dataHost(),
			numbers: numbersHost(),
			tell: appNotes(),
		});
		sidePanel = (target) =>
			new AppPanel(panelHost(), target, { kind: "beside", onClose: () => conversation?.closeBeside(true) });
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
		// The Concepts viewer is full screen: its own side panel leads back.
		rail.hidden =
			route.section === "meet" || route.section === "concepts" || controller.store.get().accessLost === true;
		syncRailReopen();
		const context = shellContext(authState.user, route);
		renderTopbar(topbar, context, rail.hidden ? undefined : controller);
		// The card's Computer opens in the agent's own chat: here when it is on screen, else once it opens.
		const showAgentPage = (agentId: string, page: AgentPage) => {
			// The member's own click: a sleeping computer wakes (computer.ts OPEN_STARTS).
			if (conversation?.show(agentId, page, true)) return;
			// It waits a little while for the chat; a request the member moved away from does not come back later.
			agentPage = { agentId, page, until: Date.now() + AGENT_PAGE_WAIT_MS };
			navigate({ name: "company", profileId: controller.profile.profileId, section: "staff", id: agentId });
		};
		// Pictures of the folder for previews, one reader per company, so what a card read is not read again per thread.
		let cardImage = cardImages.get(controller);
		if (!cardImage) {
			const reader = folderImageReader(() => memberFolder(companyCurrent, t("Company access changed.")));
			cardImage = reader;
			cardImages.set(controller, reader);
			controller.signal.addEventListener("abort", () => disposeCardPictures(reader), { once: true });
		}
		// The apps that question options' previews name, as the company's apps were last read; a card drawn before they
		// were read is brought up to date by decorateAppCards.
		const cardApp = (name: string) => cardAppOf(controller.store.get().apps, name);
		// What's new's calls and what it reads beside them: its page and the "a change is ready" card in an agent's thread
		// share them (views/release-desk.ts).
		const releaseDesk = (shared = false) => ({
			client: shared ? companyReleases(controller).shared : companyReleases(controller).own,
			// The company's last read, which a thread's card starts from.
			last: () => companyReleases(controller).last,
			options: {
				image: (path: string, signal: AbortSignal) => (cardImage ? cardImage(path, signal) : Promise.resolve(null)),
				// Every read, from What's new's page or a thread's card, is numbered as it starts (its client), so the latest
				// to start is the company's last read: a thread opened next starts from what is true now (a change put live on
				// the page is no card), with no read of its own. The drawer counts from it too.
				listed: (read: CodeReleases) => showReleases(controller, read),
				// The sites Qorpera took down (step 5.1): no link to one. Their names come with the access read, so a
				// project's site that never went live is one too (the review of #1774, F4); the list is read only for an
				// entry that names none.
				takenDown: async (signal: AbortSignal) => {
					const sites = createWebSites(cloud, controller.profile);
					const access = await sites.access(signal);
					const slugs = new Set<string>();
					for (const id of access.takenDown.keys()) {
						const named = access.named.get(id);
						if (named) slugs.add(named.slug);
					}
					if ([...access.takenDown.keys()].every((id) => access.named.has(id))) return slugs;
					for (const site of await sites.list(signal)) if (access.takenDown.has(site.id)) slugs.add(site.slug);
					return slugs;
				},
			},
		});
		// Who may see a site's password and change it: owners and admins (the kernel enforces the same rule).
		const managesSites = () => {
			const role = controller.store.get().team?.role;
			return role === "owner" || role === "admin";
		};
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
					eventHooks: createWebEventHooks(cloud, controller.profile),
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
		// The tab counts the agents that wait on the member here (app/tab-title.ts).
		showWaitingInTitle(controller.agentsWaitingOnMe());
		if (!rail.hidden)
			renderRail(rail, controller, {
				...context,
				agentActions: { ...agentActions, ...groupActions, ...workspaceActions },
				openAgentCard,
				openGroupCard,
				hideInterfacePage: (page, hidden) =>
					(interfacePages?.hide(page, hidden) ?? Promise.resolve()).then(() => {
						// Reset sidebar counts hidden pages among the member's changes (20260930727000), and a newer choice
						// is never undone by an older reset's Undo.
						if (controller.ownSidebar()) {
							controller.store.set({ sidebarReset: undefined });
							void controller.refreshSidebar();
						}
					}),
				refreshInterfacePages: () => void interfacePages?.refresh(),
				searchFolder: () => {
					const role = controller.store.get().team?.role;
					const current = () => {
						if (
							disposed ||
							company !== controller ||
							auth.userId !== controller.userId ||
							controller.store.get().accessLost
						)
							throw new Error(t("Company access changed."));
					};
					current();
					if (!role) throw new Error(t("Company access changed."));
					return new WebCompanyFiles(
						cloud,
						controller.profile,
						controller.userId,
						role,
						controller.signal,
						current,
					).folder();
				},
				openInFiles,
				searchBlocked: () => Boolean(settings || feedback || friendsWindow),
			});
		// The drawer may draw an app otherwise now (the member's icon or colour for it, its group's colour): its cards
		// in the messages follow.
		decorateAppCards();
		if (navigationFocus) {
			const target =
				navigationFocus === "rail"
					? rail.querySelector<HTMLElement>(".rail-toolbar .rail-company")
					: (frame.querySelector<HTMLButtonElement>(".main .mobile-navigation-toggle:not([hidden])") ??
						topbar.querySelector<HTMLButtonElement>(".mobile-navigation-toggle"));
			target?.focus();
			navigationFocus = undefined;
		}
		const state = controller.store.get();
		if (state.accessLost) {
			disposeCompanyViews();
			closeSettings(false);
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
			companyDatabases?.dispose();
			companyDatabases = undefined;
			controller.store.set({ interfacePages: undefined, companyData: undefined });
			interfaceFolder.dispose();
			interfaceFolder = undefined;
			void surfaceFolderHints?.close();
			surfaceFolderHints = undefined;
			companyApps?.dispose();
			companyApps = undefined;
			agentNotes?.dispose();
			agentNotes = undefined;
			controller.store.set({ agentNotes: undefined });
		}
		if (!interfaceFolder && state.team?.capabilities.read) {
			const folderCurrent = () => {
				const now = controller.store.get();
				if (
					disposed ||
					company !== controller ||
					auth.userId !== controller.userId ||
					now.accessLost ||
					!now.team?.capabilities.read
				)
					throw new Error(t("Company access changed."));
			};
			const files = new WebCompanyFiles(
				cloud,
				controller.profile,
				controller.userId,
				state.team.role,
				controller.signal,
				folderCurrent,
			);
			// The pages' reader and the apps' share one hint channel.
			const hints = sharedFolderHints(files);
			surfaceFolderHints = hints(() => {
				surfacesOf(controller)?.onFolderHint();
			});
			const shared = {
				signal: files.signal,
				current: () => files.current(),
				folder: () => files.folder(),
				folderHints: hints,
			};
			const reader = new CompanyInterfaceFolder(shared, (folder) => {
				if (interfaceFolder !== reader) return;
				controller.store.set({ interfaceFolder: folder });
			});
			const databases = cloud.config.memberCompanyGatewayUrl
				? new CompanyDatabases(
						() => {
							const client = files.data();
							if (!client) throw new Error(t("Company access changed."));
							return client;
						},
						(described) => {
							if (companyDatabases === databases) controller.store.set({ companyData: described });
						},
						controller.signal,
					)
				: undefined;
			companyDatabases = databases;
			// The folder is read for the pages that are on: a page switched on is read for at the next sync.
			const pages = new CompanyInterfacePages(
				interfacePageCalls(cloud, controller.profile.environmentId),
				(next) => {
					if (interfacePages !== pages) return;
					controller.store.set({ interfacePages: next });
					reader.read(pagesOn(next));
					if (next?.pages.some((page) => page.page === DATA_PAGE)) databases?.open();
				},
				controller.signal,
			);
			interfacePages = pages;
			interfaceFolder = reader;
			pages.open();
			void reader.open();
			// The agents' apps, for the apps drawer and the apps' own pages (RUNTIME-INTERFACE-APPS.md §4).
			const apps = new CompanyApps(
				shared,
				(next) => {
					if (companyApps !== apps) return;
					controller.store.set({ apps: next });
					decorateAppCards();
					// The apps changed: the icons read for some of them may have too (an agent drew new ones).
					controller.refreshAppIcons();
				},
				(groups) => {
					if (companyApps !== apps) return;
					controller.store.set({ appGroups: groups });
				},
			);
			companyApps = apps;
			controller.appIconReader = (app) => apps.icons(app);
			// Generate icon's message takes the thread's own model account, as an answer from an app does.
			controller.appIconAccounts = createWebNativeSubscription(
				cloud,
				controller.profile.profileId,
				controller.userId,
				controller.signal,
				companyCurrent,
			);
			// An agent's icons-only save changes no app's manifest: every read of the apps (a hint, the minute's clock, the tab
			// coming back) reads the icons read before (review F5 on #1696).
			apps.onRead(() => controller.refreshAppIcons());
			// The rail's line under each agent's name: its next planned run, read with the member's own access and again on
			// each change hint of the folder (routines are files of it).
			const routines = createWebRoutines(cloud, controller.profile, files.signal, folderCurrent, () =>
				files.folder(),
			);
			const notes = new AgentNotes(
				{
					agents: () =>
						controller.store
							.get()
							.staff.filter((agent) => agent.employmentStatus === "active")
							.map((agent) => agent.id),
					listRoutines: () => routines.list(),
					signal: files.signal,
				},
				(next) => {
					if (agentNotes === notes) controller.store.set({ agentNotes: next });
				},
			);
			agentNotes = notes;
			window.addEventListener("focus", () => notes.changed(), { signal: files.signal });
			apps.onChange(() => notes.changed());
			apps.open();
			notes.open();
		}
		// The roster arrives after the company opens, and agents are hired and let go: the rail's notes follow it.
		agentNotes?.agentsChanged();
		// The company's sites, for the apps drawer's Sites entry: read once the company opens, and again when the window
		// comes back (an agent may have published one meanwhile). A cloud without the read shows no entry.
		if (sitesRead !== controller && state.team?.capabilities.read) {
			sitesRead = controller;
			const sites = createWebSites(cloud, controller.profile);
			let sitesInFlight = false;
			let sitesPending = false;
			const readSites = () => {
				if (controller.signal.aborted) return;
				if (sitesInFlight) {
					sitesPending = true;
					return;
				}
				sitesInFlight = true;
				void sites
					.list(controller.signal)
					.then(
						async (list) => {
							if (controller.signal.aborted) return;
							const prevList = controller.store.get().siteList;
							if (prevList === undefined || JSON.stringify(prevList) !== JSON.stringify(list))
								controller.store.set(sitesListed(list));
							// WHY: ask for taken-down sites only while a live files site exists; keep the last set on failure.
							if (list.some((site) => site.kind === "files" && site.state === "live")) {
								try {
									const access = await sites.access(controller.signal);
									if (controller.signal.aborted) return;
									const nextTaken = new Set(access.takenDown.keys());
									const prevTaken = controller.store.get().sitesTakenDown;
									if (
										!prevTaken ||
										prevTaken.size !== nextTaken.size ||
										[...nextTaken].some((slug) => !prevTaken.has(slug))
									)
										controller.store.set({ sitesTakenDown: nextTaken });
								} catch {}
							}
						},
						() => {
							if (!controller.signal.aborted && controller.store.get().siteList === undefined)
								controller.store.set({ siteList: [] });
						},
					)
					.finally(() => {
						sitesInFlight = false;
						if (sitesPending && !controller.signal.aborted) {
							sitesPending = false;
							readSites();
						}
					});
			};
			readSites();
			window.addEventListener("focus", readSites, { signal: controller.signal });
		} else if (state.team && !state.team.capabilities.read && state.siteList === undefined)
			// A member the company's sites are never read for: a site's own page says it can't be shown, not waits.
			controller.store.set({ siteList: [] });
		// What's new, read the same way for its entry and badge. A cloud without the read (before 20260930729000), or one
		// that refuses this member, shows no entry; a read that did not answer leaves the entry as it was.
		if (releasesRead !== controller && state.team?.capabilities.read) {
			releasesRead = controller;
			const releases = companyReleases(controller).shared;
			let releasesInFlight = false;
			let releasesPending = false;
			const readReleases = () => {
				if (controller.signal.aborted) return;
				if (releasesInFlight) {
					releasesPending = true;
					return;
				}
				releasesInFlight = true;
				void releases
					.list(controller.signal)
					.then(
						(read) => {
							if (!controller.signal.aborted) showReleases(controller, read);
						},
						(error: unknown) => {
							if (
								!controller.signal.aborted &&
								error instanceof CloudRpcError &&
								(error.missing || error.denied)
							) {
								const prev = controller.store.get();
								if (prev.whatsNew !== undefined || prev.siteVersions !== undefined)
									controller.store.set({ whatsNew: undefined, siteVersions: undefined });
							}
						},
					)
					.finally(() => {
						releasesInFlight = false;
						if (releasesPending && !controller.signal.aborted) {
							releasesPending = false;
							readReleases();
						}
					});
			};
			readReleases();
			window.addEventListener("focus", readReleases, { signal: controller.signal });
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
		if (route.section !== "member") {
			memberChat?.view.dispose();
			memberChat = undefined;
		}
		// Where this tab is in the rail, for the other members' rails (a conversation says its own: company.ts).
		controller.setOpenPlace(
			route.section === "surface" && route.id
				? `surface:${route.id.toLowerCase()}`
				: route.section === "interface" && route.id
					? `page:${route.id}`
					: route.section === "app" && route.id
						? `app:${route.id}`
						: route.section === "staff" && route.id
							? `agent:${route.id.toLowerCase()}`
							: route.section === "site" && route.id
								? `site:${route.id}`
								: route.section === "concepts" || route.section === "sites" || route.section === "whats-new"
									? route.section
									: COMPANY_PRESENCE_PLACE,
		);
		// A card's request waits only while its agent's chat is on the way.
		if (route.section !== "chat" && route.section !== "staff") agentPage = undefined;
		if (route.section === "chat") appReturn = routeHash(route);
		if (route.section !== "app" || (appPage && !sameTarget(appPage.target, { kind: "app", name: route.id ?? "" }))) {
			appPage?.dispose();
			appPage = undefined;
		}
		if (route.section !== "concepts") {
			conceptsView?.dispose();
			conceptsView = undefined;
		}
		if (route.section !== "sites" || sitesPage?.company !== controller) {
			sitesPage?.view.dispose();
			sitesPage = undefined;
		}
		if (route.section !== "site" || siteView?.company !== controller || siteView.slug !== route.id) {
			siteView?.view.dispose();
			siteView = undefined;
		}
		if (route.section !== "whats-new" || whatsNewPage?.company !== controller) {
			whatsNewPage?.view.dispose();
			whatsNewPage = undefined;
		}
		if (route.section !== "new-program" || newProgramPage?.company !== controller) {
			newProgramPage?.view.dispose();
			newProgramPage = undefined;
		}
		if (route.section !== "surface" || surfaceView?.company !== controller || surfaceView.view.slug !== route.id) {
			if (surfaceView) deferSurfaceDisposal(surfaceView.view);
			surfaceView = undefined;
		}
		if (route.section !== "new") {
			newConversation?.dispose();
			newConversation = undefined;
		}
		if (route.section !== "interface") disposeInterface(main);
		if (route.section !== "meet") meetState = {};
		const interfaceWrites = (): InterfaceWrites => ({
			mailManage: () => {
				const environment = {
					profileId: controller.profile.profileId,
					environmentId: controller.profile.environmentId,
				};
				const keys = createDigitalPostKeys(cloud, environment);
				const accounts = createWebNativeSubscription(
					cloud,
					controller.profile.profileId,
					controller.userId,
					controller.signal,
					companyCurrent,
				);
				return {
					hooks: createWebEventHooks(cloud, environment),
					digitalPost: {
						read: () => readDigitalPost(cloud, environment.environmentId),
						save: (apiKey, existingSecretId, abort) => keys.save(apiKey, existingSecretId, abort),
						disconnect: (secretId, abort) => keys.disconnect(secretId, abort),
					},
					// Who answers an address: the agent's routine that starts on its mail, written as the member's own
					// save, on one of the member's own model accounts.
					routines: createWebRoutines(cloud, controller.profile, controller.signal, companyCurrent, () =>
						memberFolder(companyCurrent, t("Company access changed.")),
					),
					accounts: (signal) => accounts.listConnections(signal),
				};
			},
			bankConnection: () => createWebConnectors(cloud, controller.profile),
			openSettings: (tab) => openSettings(tab),
			data: () => companyDatabases,
			dataAsk: (agentId, note) => {
				let accounts = askAccounts.get(controller);
				if (!accounts) {
					accounts = createWebNativeSubscription(
						cloud,
						controller.profile.profileId,
						controller.userId,
						controller.signal,
						companyCurrent,
					);
					askAccounts.set(controller, accounts);
				}
				return tellAgent(controller, accounts, agentId, note);
			},
		});
		const surfaceMount = (surface: SurfaceSummary, signal: AbortSignal): SurfaceMount | undefined => {
			if (surface.archetype === "live_build" && surface.siteSlug) {
				const slug = surface.siteSlug;
				const website = () =>
					controller.store
						.get()
						.siteList?.find((site) => site.slug === slug && site.kind === "files" && site.state === "live");
				if (!website()) return undefined;
				const sites = createWebSites(cloud, controller.profile);
				const view = new SiteView(
					{
						site: website,
						pass: (site, passSignal) => sites.memberPass(site, passSignal),
						numbers: numbersHost(),
						timeZone: () => controller.store.get().team?.timeZone,
					},
					slug,
					AbortSignal.any([controller.signal, signal]),
				);
				let wasPublishing = surface.publishStatus === "publishing";
				let lastUnpublished = surface.unpublishedChangeCount;
				return {
					el: h("div", { class: "surface-site" }, view.el),
					update: () => {
						view.update();
						const latest = surfacesOf(controller)?.state.surfaces.find((item) => item.id === surface.id);
						if (!latest) return;
						const nowPublishing = latest.publishStatus === "publishing";
						const publishFinished =
							(wasPublishing && !nowPublishing && latest.publishStatus !== "failed") ||
							(!wasPublishing && !nowPublishing && lastUnpublished > 0 && latest.unpublishedChangeCount === 0);
						wasPublishing = nowPublishing;
						lastUnpublished = latest.unpublishedChangeCount;
						if (publishFinished) view.reload();
					},
					dispose: () => view.dispose(),
				};
			}
			if (surface.archetype !== "ops") return undefined;
			const page =
				surface.slug === "inbox" || surface.icon === "mail"
					? "mailbox"
					: surface.slug === "money" || surface.icon === "coin" || surface.icon === "bank"
						? "bank"
						: surface.slug === "members" || surface.icon === "members"
							? "members"
							: surface.slug === "data" || surface.icon === "database"
								? "data"
								: undefined;
			if (page) {
				const el = h("div", { class: "surface-ops" });
				const update = () => renderInterface(el, controller, page, interfaceWrites());
				return {
					el,
					update,
					dispose: () => {
						disposeInterface(el);
						el.replaceChildren();
					},
				};
			}
			if (!controller.store.get().team) return undefined;
			const el = h("div", { class: "surface-files" });
			let shown: { browser: CompanyFolderBrowser; stop: AbortController; authority: string } | undefined;
			const close = () => {
				if (!shown) return;
				if (filesShown?.browser === shown.browser) filesShown = undefined;
				shown.stop.abort();
				shown.browser.dispose();
				shown = undefined;
			};
			const draw = () => {
				const team = controller.store.get().team;
				const authority =
					team && !controller.store.get().accessLost
						? JSON.stringify([team.role, team.capabilities.read, team.capabilities.write])
						: "";
				if (shown?.authority === authority) return;
				close();
				el.replaceChildren();
				if (!team || !authority) return;
				const stop = new AbortController();
				const browser = new CompanyFolderBrowser(
					el,
					new WebCompanyFiles(
						cloud,
						controller.profile,
						controller.userId,
						team.role,
						AbortSignal.any([controller.signal, signal, stop.signal]),
						companyCurrent,
						team.capabilities.write,
					),
					() => ({
						me: controller.userId,
						members: controller.store.get().team?.members ?? [],
						staff: controller.store.get().staff,
					}),
					{ usage: () => api.getCompanyFile(controller.profile.environmentId) },
				);
				shown = { browser, stop, authority };
				filesShown = { owner: controller, browser };
				if (filesPending?.owner === controller) browser.reveal(filesPending.path);
				void browser.open().then(
					() => {
						if (filesPending?.owner === controller) filesPending = undefined;
					},
					() => undefined,
				);
			};
			draw();
			return { el, update: draw, dispose: close };
		};
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
						h("h1", null, companyNameText(controller.profile.profileName)),
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
							previewAttachment: async (messageId, index, viewSignal) =>
								await withAbortScopes([controller.signal, viewSignal], async (signal) => {
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
										message?.kind === "member" &&
										!message.pending &&
										Number.isSafeInteger(index) &&
										index >= 0
											? message.attachments?.[index]?.reference
											: undefined;
									if (!ref) throw new Error(t("This attachment is not available for preview."));
									const bytes = await createWebSessionAttachments(
										cloud,
										controller.userId,
										signal,
										check,
									).read(route.id!, messageId, ref, signal);
									check();
									return new Blob([new Uint8Array(bytes)], { type: ref.mediaType });
								}),
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
							eventHooks: createWebEventHooks(cloud, controller.profile),
							// No Undo on an agent's interface change: agents don't make pages (Interfaces C6a), and the save
							// check refuses an agent's change under QorperaOS/interfaces/ or to a table's definition (C6c).
							// A message is erased for the whole company through the member's own route; the route checks the
							// role, and the thread offers it to the roles that route takes (M3c).
							folderImage: cardImage,
							folderApp: cardApp,
							decisions: questionsHost(),
							// A change of this agent's ready to go live, as a card below the thread; a site a message links, as
							// the Sites page's row under the words.
							codeReleases: releaseDesk(true),
							companySites: { client: createWebSites(cloud, controller.profile), canManage: managesSites },
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
				if (
					agentPage &&
					(Date.now() > agentPage.until || conversation.show(agentPage.agentId, agentPage.page, true))
				)
					agentPage = undefined;
				return;
			}
			case "member": {
				// This member's chat with another member of the company. A link to oneself, or to no member's id, leads home.
				const userId = route.id?.toLowerCase() ?? "";
				if (!UUID_PATTERN.test(userId) || userId === controller.userId) {
					navigate({ name: "company", profileId: controller.profile.profileId, section: "home" }, true);
					return;
				}
				if (!state.team) {
					showThreadSkeleton(t("Opening company"));
					return;
				}
				if (memberChat?.view.userId !== userId || memberChat.company !== controller) {
					memberChat?.view.dispose();
					memberChat = {
						view: new MemberChatView(controller, userId, () => setNavigationOpen(!navigationOpen)),
						company: controller,
					};
					replace(main, memberChat.view.el);
					if (!frame.inert) memberChat.view.focus();
				} else {
					if (!main.contains(memberChat.view.el)) replace(main, memberChat.view.el);
					memberChat.view.update();
				}
				memberChat.view.setNavigationOpen(navigationOpen);
				return;
			}
			case "app": {
				// An agent's app as a page of its own, in the frame the app's own folder fills (Jonas, 8 November 2026). It
				// stays as it is through the company's redraws; its page follows the folder itself. A concept of the
				// company's product opens in the Concepts viewer instead, once the apps are read that say it is one.
				if (route.id && isConcept(controller, route.id)) {
					navigate(
						{ name: "company", profileId: controller.profile.profileId, section: "concepts", id: route.id },
						true,
					);
					return;
				}
				if (appPage && main.contains(appPage.el)) return;
				const home = `#/c/${controller.profile.profileId}`;
				// A deep link or a reload: the page waits for the company's first read, so its header names the agent that
				// made it and the app's first `agents()` gets the whole roster (the staff read may land after the folder's).
				if (state.loading) {
					if (!main.querySelector(":scope > .page > .skeleton-page"))
						replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
					return;
				}
				if (!companyApps) {
					replace(
						main,
						h(
							"section",
							{ class: "page" },
							notice("danger", t("This can't be opened right now.")),
							h("a", { href: home }, t("Back to the company")),
						),
					);
					return;
				}
				appPage?.dispose();
				appPage = new AppPanel(
					panelHost(),
					{ kind: "app", name: route.id ?? "" },
					{
						kind: "page",
						back: appReturn
							? { href: appReturn, label: t("Back to the conversation") }
							: { href: home, label: t("Back to the company") },
					},
				);
				replace(main, appPage.el);
				if (!frame.inert) appPage.focus();
				return;
			}
			case "concepts": {
				// The company's concepts, full screen with a side panel to pick one (Jonas, 8 November 2026). The viewer
				// stays through the company's redraws and a change of concept: only the stage's frame changes.
				const home = `#/c/${controller.profile.profileId}`;
				if (state.loading) {
					if (!main.querySelector(":scope > .page > .skeleton-page"))
						replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
					return;
				}
				if (!companyApps) {
					replace(
						main,
						h(
							"section",
							{ class: "page" },
							notice("danger", t("This can't be opened right now.")),
							h("a", { href: home }, t("Back to the company")),
						),
					);
					return;
				}
				// An app the route names that is no concept opens as a page of its own.
				const named = route.id ? (state.apps ?? []).find((app) => app.name === route.id) : undefined;
				if (route.id && named?.manifest && !named.manifest.concept) {
					navigate(
						{ name: "company", profileId: controller.profile.profileId, section: "app", id: route.id },
						true,
					);
					return;
				}
				if (conceptsView && main.contains(conceptsView.el)) {
					conceptsView.update(state.apps ?? [], route.id);
					return;
				}
				conceptsView?.dispose();
				const reader = cardImage;
				conceptsView = new ConceptsView(
					{
						panel: panelHost(),
						profileId: controller.profile.profileId,
						companyName: () => controller.profile.profileName,
						back: () => appReturn ?? home,
						picture: (path, signal) => reader(path, signal),
					},
					state.apps ?? [],
					route.id,
				);
				replace(main, conceptsView.el);
				if (!frame.inert) conceptsView.focus();
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
				navigate(
					{
						name: "company",
						profileId: controller.profile.profileId,
						section: "surface",
						id: filesSlug(controller),
					},
					true,
				);
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
				renderInterface(main, controller, route.id ?? "", interfaceWrites());
				return;
			case "sites": {
				// The websites the company's agents published (Jonas, 9 Nov 2026: out of Settings, into the apps drawer).
				// Every member sees them and their links; owners and admins also read and change their passwords and take
				// them offline (the kernel enforces the same rule).
				if (!sitesPage) {
					const view = new SitesView(createWebSites(cloud, controller.profile), controller.signal, {
						access: { canManage: managesSites },
						hosting: createWebSiteHosting(cloud, controller.profile),
						listed: (list) => controller.store.set(sitesListed(list)),
						// A site made from a project's code names the version What's new has live, and links there.
						releases: {
							href: `#/c/${controller.profile.profileId}/whats-new`,
							version: (site) => controller.store.get().siteVersions?.[site.slug],
						},
						// No site yet: the Co-Founder stands on the page (its crown while the roster is still on its way).
						mascot: () =>
							agentFigure(
								controller.staffById(controller.cofounderId()) ?? {
									id: "",
									displayName: "Co-Founder",
									appearance: { color: "", shape: "" },
									templateId: "co-founder",
								},
								"Co-Founder",
								{ size: 96, className: "sites-mascot" },
							),
					});
					// The page draws its own title and line (views/settings-sites.ts).
					sitesPage = { company: controller, view, el: h("section", { class: "page sites-page" }, view.el) };
				}
				sitesPage.view.update();
				if (sitesPage.el.parentElement !== main) replace(main, sitesPage.el);
				return;
			}
			case "site": {
				// One of the company's websites, live, with its numbers (company views step 4): the site in a frame the member
				// is let into without its password, and the numbers watched while it shows.
				const slug = route.id ?? "";
				const website = () =>
					controller.store
						.get()
						.siteList?.find((site) => site.slug === slug && site.kind === "files" && site.state === "live");
				if (!siteView) {
					// A deep link or a reload: the page waits for the company's sites to be read.
					if (state.siteList === undefined) {
						if (!main.querySelector(":scope > .page > .skeleton-page"))
							replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
						return;
					}
					if (!website()) {
						replace(
							main,
							h(
								"section",
								{ class: "page" },
								notice("danger", t("This website can't be shown here right now.")),
								h("a", { href: `#/c/${controller.profile.profileId}` }, t("Back to the company")),
							),
						);
						return;
					}
					const sites = createWebSites(cloud, controller.profile);
					const view = new SiteView(
						{
							site: website,
							pass: (site, signal) => sites.memberPass(site, signal),
							numbers: numbersHost(),
							timeZone: () => controller.store.get().team?.timeZone,
						},
						slug,
						controller.signal,
					);
					siteView = { company: controller, slug, view, el: h("section", { class: "page site-page" }, view.el) };
				}
				siteView.view.update();
				if (siteView.el.parentElement !== main) replace(main, siteView.el);
				return;
			}
			case "surface": {
				const surfaces = surfacesOf(controller);
				if (!surfaces) {
					if (surfacesDisabledOf(controller)) {
						navigate({ name: "company", profileId: controller.profile.profileId, section: "home" }, true);
					}
					return;
				}
				if (!surfaceView) {
					const loadStudioFiles = async (
						surface: SurfaceSummary,
						signal: AbortSignal,
					): Promise<Readonly<Record<string, string>>> => {
						const roots = [
							surface.folderRoot?.replace(/^\/+|\/+$/g, ""),
							`QorperaOS/surfaces/${surface.slug}/notes`,
						].filter((item): item is string => Boolean(item));
						const team = controller.store.get().team;
						if (!roots.length || !team) return {};
						const readSignal = AbortSignal.any([controller.signal, signal]);
						const folder = new WebCompanyFiles(
							cloud,
							controller.profile,
							controller.userId,
							team.role,
							readSignal,
							companyCurrent,
							team.capabilities.write,
						).folder();
						return await readSurfaceFolderFiles(folder, roots, readSignal);
					};
					const loadSitePassword = async (surface: SurfaceSummary): Promise<string | null> => {
						if (!managesSites() || !surface.liveUrl || isLocalSurfaceId(surface.id)) return null;
						const sites = createWebSites(cloud, controller.profile);
						const matchSite = (list: readonly CompanySite[]): CompanySite | undefined =>
							(surface.siteSlug ? list.find((item) => item.slug === surface.siteSlug) : undefined) ??
							(surface.liveUrl ? siteOfLink(list, surface.liveUrl) : undefined);
						try {
							let site = matchSite(controller.store.get().siteList ?? []);
							if (!site) {
								const listed = await sites.list(controller.signal);
								if (controller.signal.aborted) return null;
								controller.store.set(sitesListed(listed));
								site = matchSite(listed);
							}
							if (!site) return null;
							const result = await sites.password(site.id, controller.signal);
							return result.password || null;
						} catch {
							return null;
						}
					};
					const view = new SurfaceView(
						{
							store: surfaces,
							mount: surfaceMount,
							isMountLoading: (surface) => {
								const currentState = controller.store.get();
								if (currentState.accessLost) return false;
								if (surface.archetype === "live_build" && surface.siteSlug)
									return currentState.siteList === undefined;
								if (surface.archetype === "studio" && !isLocalSurfaceId(surface.id)) return !currentState.team;
								if (surface.archetype === "ops") {
									const isBuiltInPage =
										surface.slug === "inbox" ||
										surface.icon === "mail" ||
										surface.slug === "money" ||
										surface.icon === "coin" ||
										surface.icon === "bank" ||
										surface.slug === "members" ||
										surface.icon === "members" ||
										surface.slug === "data" ||
										surface.icon === "database";
									if (!isBuiltInPage) return !currentState.team;
								}
								return false;
							},
							openMigration: () => openMigrationSheet(surfaces),
							loadStudioFiles,
							loadSitePassword,
						},
						route.id ?? "",
					);
					surfaceView = { company: controller, view };
				}
				if (surfaceView.view.el.parentElement !== main) {
					replace(main, surfaceView.view.el);
					if (!frame.inert) surfaceView.view.focus();
				}
				surfaceView.view.update();
				return;
			}
			case "new-program": {
				if (state.team?.capabilities.write !== true) {
					if (!state.loading && state.team)
						navigate({ name: "company", profileId: controller.profile.profileId, section: "home" }, true);
					else if (!main.querySelector(":scope > .page > .skeleton-page"))
						replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
					return;
				}
				if (!newProgramPage) {
					const view = new NewProgramPage(programAdds());
					newProgramPage = { company: controller, view };
				}
				const shown = newProgramPage.view.el.parentElement;
				if (shown?.parentElement !== main)
					replace(main, h("section", { class: "page program-new-page" }, newProgramPage.view.el));
				return;
			}
			case "whats-new": {
				// The changes to the company's sites made from its code, ready to go live, and what is live (own code storage
				// step 4). Every member sees it; owners and admins put a version live and go back (the kernel's own rule).
				if (!whatsNewPage) {
					const desk = releaseDesk();
					const view = new WhatsNewView(controller, desk.client, controller.signal, desk.options);
					whatsNewPage = {
						company: controller,
						view,
						el: h(
							"section",
							{ class: "page whats-new-page" },
							h(
								"header",
								{ class: "sites-page-heading" },
								interfaceEmblem("spark", 40),
								h("div", null, h("h1", null, t("What's new"))),
							),
							view.el,
						),
					};
				}
				if (whatsNewPage.el.parentElement !== main) replace(main, whatsNewPage.el);
				return;
			}
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
					{ onCompanyRemoved: companyRemovedHandler(), addFriend: openFriends },
				);
				return;
		}
	}

	if (hasWebsiteIdea()) auth.showStep("create");
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
		appCardObserver.disconnect();
		railLayout.dispose();
		window.removeEventListener("languagechange", onLanguage);
		window.removeEventListener("qorpera-language-change", onLanguage);
		window.removeEventListener("qorpera-time-zone-change", redrawScreens);
		unwatchTheme();
		unwatchBrowserBar();
		closeSettings(false);
		closeFeedback(false);
		closeFriends(false);
		online.stop();
		auth.dispose();
		hub.dispose();
		teardownFounding();
		teardownCompany();
		clearShellCompanyState();
		accountPayments?.dispose();
		pictures.reset();
		if (personPictures() === pictures) setPersonPictures(undefined);
		logos.reset();
		if (companyLogos() === logos) setCompanyLogos(undefined);
		window.removeEventListener("hashchange", onRouteChange);
		root.removeEventListener("click", onFolderLink);
		window.removeEventListener("keydown", onEscape);
		window.removeEventListener("resize", syncNavigation);
		versionWatch.abort();
	};
}

/** The query keys qorpera.com's box sends (landing/src/site/site.js): the idea, and the kind of company picked.
 * "kind", not "type": the sign-in callback takes a type parameter. */
export const WEBSITE_KEYS = ["ide", "idea", "kind"] as const;
/** How long a card's request for its agent's computer waits for that agent's chat to open. */
const AGENT_PAGE_WAIT_MS = 20_000;

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
