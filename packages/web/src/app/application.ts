import type { InterfaceFile } from "@qorpera/cloud-client/interfaces";
import type { User } from "@supabase/supabase-js";
import { CloudApi } from "../cloud/api.ts";
import { forgetChatGptPlanSignIn, takeChatGptPlanReturn } from "../cloud/chatgpt-plan-sign-in.ts";
import { type Cloud, describeError } from "../cloud/client.ts";
import { createWebCompanyAgents } from "../cloud/company-agents.ts";
import { WebCompanyFiles } from "../cloud/company-files.ts";
import { WebCompanyComputer } from "../cloud/computer.ts";
import { takeConnectorReturn } from "../cloud/connectors.ts";
import { undoInterfaceChange } from "../cloud/interface-changes.ts";
import { interfaceOfferCalls } from "../cloud/interface-offers.ts";
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
import { isPhoneLayout } from "../ui/layout.ts";
import { personPictures, setPersonPictures } from "../ui/person-pictures.ts";
import { applyLanguage, presentationLocale, t, watchTheme } from "../ui/preferences.ts";
import { RailLayout } from "../ui/rail-layout.ts";
import { blankSkeleton, pageSkeleton, railSkeleton, threadSkeleton } from "../ui/skeleton.ts";
import { AuthController } from "./auth.ts";
import { CompanyController } from "./company.ts";
import { CompanyMail } from "./company-mail.ts";
import { FoundingController } from "./founding.ts";
import { CompanyInterfaceFolder } from "./interface-folder.ts";
import { CompanyInterfaceOffers } from "./interface-offers.ts";
import { MemberPictures } from "./member-pictures.ts";
import { PlanPayments, takeCheckoutReturn } from "./plan-payments.ts";
import { currentRoute, navigate, type Route, routeHash } from "./router.ts";
import { createConversationStarter } from "./start-conversation.ts";
import { debounce } from "./state.ts";
import { createGroupDeleter, createGroupUpdater } from "./update-group.ts";
import { type AccountViewState, renderAccount } from "./views/account.ts";
import { savedAgentDraft } from "./views/agent-edits.ts";
import { ComputerPanels } from "./views/computer.ts";
import { ConversationView } from "./views/conversation.ts";
import { ExecutionNotices } from "./views/execution-notices.ts";
import { FeedbackView } from "./views/feedback.ts";
import { FoundingView } from "./views/founding.ts";
import { HubController, renderHub } from "./views/hub.ts";
import { renderInterface } from "./views/interface.ts";
import { LiveCompanyFileView } from "./views/live-company-file.ts";
import { type MeetState, renderMeet } from "./views/meet.ts";
import { NewConversationView } from "./views/new-conversation.ts";
import { renderPlan } from "./views/plan.ts";
import { type SettingsTab, SettingsView } from "./views/settings.ts";
import { finishPlanSignIn, memberPlanSignIn } from "./views/settings-connections.ts";
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
	// "Continue with ChatGPT": OpenAI's callback sends the member back with a one-time confirmation.
	let planReturn = takeChatGptPlanReturn();
	// Stripe's checkout page sends the member back to the account page.
	let checkoutReturn = takeCheckoutReturn();
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
		connectorReturn = takeConnectorReturn() ?? connectorReturn;
		planReturn = takeChatGptPlanReturn() ?? planReturn;
		checkoutReturn = takeCheckoutReturn() ?? checkoutReturn;
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
	/** The open company's interfaces and tables, followed in its folder (Interfaces step I7). */
	let interfaceFolder: CompanyInterfaceFolder | undefined;
	/** The pages each thread's review cards preview, which every reader of the folder reads too (Interfaces I10). */
	const interfacePreviews = new Map<object, readonly InterfaceFile[]>();
	/** The company's open offers of claimed cells, read with its interfaces (Interfaces step I9c). */
	let interfaceOffers: CompanyInterfaceOffers | undefined;
	/** The open company's mail as the member reads it, for the Mailbox page (Interfaces step I5c). */
	let mail: CompanyMail | undefined;
	let computer: WebCompanyComputer | undefined;
	let computerPanels: ComputerPanels | undefined;
	let liveFile: LiveCompanyFileView | undefined;
	let conversation: ConversationView | undefined;
	let newConversation: NewConversationView | undefined;
	let startingSession: { sessionId: string } | undefined;
	let profiles: HostedProfile[] = [];
	let teamFeedback: TeamFeedback = {};
	let accountState: AccountViewState = {};
	const accountPlan = h("div");
	let accountPayments: PlanPayments | undefined;
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
	 * attachments and edits. A new-conversation draft and unsaved Company File
	 * text live only in their screens, so those stay until they are left. */
	function redrawScreens(): void {
		if (disposed) return;
		// The founding table's page keeps its text between refreshes; a new language builds it again.
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
		if (liveFile && !liveFile.leaveMessage()) {
			liveFile.dispose();
			liveFile = undefined;
		}
		render();
	}

	function teardownCompany(): void {
		settingsAfterHome = undefined;
		notices?.dispose();
		notices = undefined;
		interfaceFolder?.dispose();
		interfaceFolder = undefined;
		interfaceOffers?.dispose();
		interfaceOffers = undefined;
		mail?.dispose();
		mail = undefined;
		executionNotices.replaceChildren();
		unsubscribeCompany?.();
		conversation?.dispose();
		newConversation?.dispose();
		liveFile?.dispose();
		liveFile = undefined;
		company?.stop();
		pendingCompany = undefined;
		company = undefined;
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
			if (planReturn && planReturn.signIn.companyId === controller.profile.profileId) {
				const outcome = planReturn;
				planReturn = undefined;
				if (outcome.signIn.memberId !== userId) forgetChatGptPlanSignIn();
				else {
					// A ChatGPT plan sign-in for this company. Its confirm belongs to the member, not to a
					// page: it finishes while Settings closes or the route changes, stopping only if the
					// account changes, and My connections shows the outcome.
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
						if (route.name === "company" && route.section === "home") settingsAfterHome = "my-connections";
						else openSettings("my-connections");
					});
				}
			}
			if (connectorReturn) {
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
		// The account page's payments live while it shows: its notices go with it, and a failed
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
			if (route.name === "hub") {
				renderHub(hub, main);
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
				// The standalone account page shows the plan below the general settings.
				// One panel across renders keeps an opened plan grid open; the general
				// panel above already shows the account error.
				if (checkoutReturn) {
					accountPayments?.dispose();
					accountPayments = undefined;
				}
				accountPayments ??= new PlanPayments(api, render, checkoutReturn === "done" ? "done" : undefined);
				checkoutReturn = undefined;
				accountPayments.load();
				const payments = accountPayments;
				renderPlan(
					accountPlan,
					accountState,
					undefined,
					{
						payments: {
							state: payments.state,
							checkout: (itemKey) => payments.checkout(itemKey),
							portal: () => payments.portal(),
							companyName: (profileId) => profiles.find((item) => item.profileId === profileId)?.profileName,
						},
					},
					{ showError: false },
				);
				main.append(accountPlan);
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
		// Agents are company folders (agents/<handle>/agent.md). Each write re-checks
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
		if (!rail.hidden)
			renderRail(rail, controller, {
				...context,
				agentActions: { ...agentActions, ...groupActions, ...workspaceActions },
			});
		if (navigationFocus) {
			// The drawer opens on its first control: the chosen tab, or the search field when it is open (the tabs
			// are inert under it) or there are no tabs.
			const target =
				navigationFocus === "rail"
					? (rail.querySelector<HTMLElement>(
							".rail-toolbar:not(.is-searching) .rail-switch:not([hidden]) [role='tab'][aria-selected='true']",
						) ?? rail.querySelector<HTMLInputElement>(".rail-search input"))
					: (frame.querySelector<HTMLButtonElement>(".main .mobile-navigation-toggle:not([hidden])") ??
						topbar.querySelector<HTMLButtonElement>(".mobile-navigation-toggle"));
			target?.focus();
			navigationFocus = undefined;
		}
		const state = controller.store.get();
		if (state.accessLost) {
			notices?.dispose();
			notices = undefined;
			interfaceFolder?.dispose();
			interfaceFolder = undefined;
			interfaceOffers?.dispose();
			interfaceOffers = undefined;
			mail?.dispose();
			mail = undefined;
			liveFile?.dispose();
			liveFile = undefined;
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
		// The company's interfaces come from its folder, read with the member's own access as the Company File page
		// reads it, and followed while the company is open; until the first read lands the rail draws the library's.
		if (interfaceFolder && !state.team?.capabilities.read) {
			interfaceFolder.dispose();
			interfaceFolder = undefined;
			interfaceOffers?.dispose();
			interfaceOffers = undefined;
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
			// since the save that changes a cell settles its offers (step I9c).
			const offers = new CompanyInterfaceOffers(
				interfaceOfferCalls(cloud, controller.profile.environmentId),
				(next) => {
					if (interfaceOffers === offers) controller.store.set({ interfaceOffers: next });
				},
				controller.signal,
			);
			const reader = new CompanyInterfaceFolder(files, (folder) => {
				if (interfaceFolder !== reader) return;
				controller.store.set({ interfaceFolder: folder });
				void offers.refresh();
			});
			interfaceFolder = reader;
			interfaceOffers = offers;
			for (const [owner, pages] of interfacePreviews) reader.preview(owner, pages);
			offers.open();
			void reader.open();
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
			const reader = new CompanyMail(controller, cloud, accounts, (read) => {
				if (mail === reader) controller.store.set({ mail: read });
			});
			mail = reader;
			void reader.open();
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
							// Routines are files (agents/<handle>/routines/<key>.md): the editor and the switch write them
							// through the member's own folder client, with the same checks as every other routine call.
							routines: createWebRoutines(
								cloud,
								controller.profile,
								controller.signal,
								checkConversationAccess,
								() => memberFolder(() => checkConversationAccess(), t("Conversation access changed.")),
							),
							// An agent's interface change is undone as the member's own change set, by a member who can write.
							undoInterfaceChange: (change, signal) => {
								const check = () => {
									checkConversationAccess();
									if (!controller.store.get().team?.capabilities.write)
										throw new Error(t("Conversation access changed."));
								};
								return undoInterfaceChange(
									memberFolder(check, t("Conversation access changed.")),
									change,
									AbortSignal.any([controller.signal, signal]),
									check,
								);
							},
							// A message is erased for the whole company through the member's own route; the route checks the
							// role, and the thread offers it to the roles that route takes (M3c).
							messageErases: {
								request: (sessionId, eventId, signal) =>
									messageErases(() => checkConversationAccess(sessionId)).request(sessionId, eventId, signal),
								status: (erase, signal) =>
									messageErases(() => checkConversationAccess(erase.sessionId)).status(erase, signal),
							},
							previewInterfaces: (owner, pages) => {
								if (pages.length > 0) interfacePreviews.set(owner, pages);
								else interfacePreviews.delete(owner);
								interfaceFolder?.preview(owner, pages);
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
					liveFile = new LiveCompanyFileView(
						files,
						stop,
						authorityKey,
						// The folder's changes name their members and agents.
						() => ({
							me: controller.userId,
							members: controller.store.get().team?.members ?? [],
							staff: controller.store.get().staff,
						}),
					);
				}
				if (!main.contains(liveFile.el)) replace(main, liveFile.el);
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
				// through the company's offers reader (step I9c).
				renderInterface(main, controller, route.id ?? "", {
					folder: () => memberFolder(companyCurrent, t("Company access changed.")),
					current: companyCurrent,
					...(interfaceOffers ? { offers: interfaceOffers } : {}),
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
		window.removeEventListener("keydown", onEscape);
		window.removeEventListener("resize", syncNavigation);
	};
}
