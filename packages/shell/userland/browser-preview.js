/* Browser-only bridge for reviewing the production userland without Electron.
 * The real preload bridge always wins. Preview actions never write company data. */
(() => {
	// Electron must fail closed when its privileged preload bridge is missing.
	// Only a regular browser may install the local review bridge below.
	if (window.qorpera || /\bElectron\//.test(navigator.userAgent)) return;

	const previewState = {
		name: "Northstar Works",
		projection: {
			schema: "qorpera.projection/v1",
			default: "category:finance-outlook",
			navigation: ["q:main", "department:financials", "department:support", "department:product"],
			nodes: [
				{
					id: "q:main",
					kind: "department",
					label: "Main",
					items: ["q:inbox", "q:activity", "q:chats"],
				},
				{
					id: "q:inbox",
					kind: "page",
					label: "Inbox",
					description: "Decisions and questions requiring founder attention.",
					view: { type: "builtin", id: "qorpera.inbox" },
				},
				{
					id: "q:activity",
					kind: "page",
					label: "Agents",
					description: "Every agent working for the company — live, scheduled, and past.",
					view: { type: "builtin", id: "qorpera.activity" },
				},
				{
					id: "q:chats",
					kind: "page",
					label: "Chats",
					description: "Founder conversations with the company controller.",
					view: { type: "builtin", id: "qorpera.chats" },
				},
				{
					id: "department:financials",
					kind: "department",
					label: "Financials",
					items: ["page:cashflow", "category:finance-outlook", "page:pricing", "page:projections"],
				},
				{
					id: "page:cashflow",
					kind: "page",
					label: "Cashflow Overview",
					description: "Cash position, movement, and operating runway.",
					view: {
						type: "builtin",
						id: "qorpera.preview",
						context: {
							title: "Cashflow Overview",
							message: "This direct page would render the company's cashflow surface.",
						},
					},
				},
				{
					id: "category:finance-outlook",
					kind: "category",
					label: "Outlook & Commitments",
					description: "Forward-looking reports, plans, and financial commitments.",
					items: ["page:q3-report", "page:runway", "page:commitments"],
				},
				{
					id: "page:q3-report",
					kind: "page",
					label: "Q3 Earnings Report",
					description: "Quarterly performance, variances, and management commentary.",
					view: {
						type: "builtin",
						id: "qorpera.preview",
						context: { message: "This page would render the Q3 earnings report surface." },
					},
				},
				{
					id: "page:runway",
					kind: "page",
					label: "Runway Scenarios",
					description: "Base, upside, and downside cash runway planning.",
					view: {
						type: "builtin",
						id: "qorpera.preview",
						context: { message: "This page would render the runway scenario surface." },
					},
				},
				{
					id: "page:commitments",
					kind: "page",
					label: "Supplier Commitments",
					description: "Committed spend and upcoming renewal exposure.",
					view: {
						type: "builtin",
						id: "qorpera.preview",
						context: { message: "This page would render the supplier commitments surface." },
					},
				},
				{
					id: "page:pricing",
					kind: "page",
					label: "Price Analysis",
					description: "Pricing, margin, and packaging intelligence.",
					view: {
						type: "builtin",
						id: "qorpera.preview",
						context: { message: "This direct page would render the pricing analysis surface." },
					},
				},
				{
					id: "page:projections",
					kind: "page",
					label: "Projections",
					description: "Operating plan projections and variance analysis.",
					view: {
						type: "builtin",
						id: "qorpera.preview",
						context: { message: "This direct page would render the projections surface." },
					},
				},
				{
					id: "department:support",
					kind: "department",
					label: "Support & Communications",
					items: ["category:customer-conversations", "page:email"],
				},
				{
					id: "category:customer-conversations",
					kind: "category",
					label: "Customer Conversations",
					description: "Customer-facing support and feedback channels.",
					items: ["page:tickets", "page:help", "page:feedback"],
				},
				{
					id: "page:tickets",
					kind: "page",
					label: "Tickets",
					description: "Open and recently resolved service requests.",
					view: { type: "builtin", id: "qorpera.preview", context: { message: "Ticket queue preview." } },
				},
				{
					id: "page:help",
					kind: "page",
					label: "Q & A / Help",
					description: "Reusable customer guidance and common questions.",
					view: { type: "builtin", id: "qorpera.preview", context: { message: "Help center preview." } },
				},
				{
					id: "page:feedback",
					kind: "page",
					label: "Bugs & Feedback",
					description: "Product feedback and reported problems.",
					view: { type: "builtin", id: "qorpera.preview", context: { message: "Feedback queue preview." } },
				},
				{
					id: "page:email",
					kind: "page",
					label: "Email",
					description: "Company email overview.",
					view: { type: "builtin", id: "qorpera.preview", context: { message: "Company email preview." } },
				},
				{
					id: "department:product",
					kind: "department",
					label: "Qorpera Base Development",
					items: ["page:pull-requests"],
				},
				{
					id: "page:pull-requests",
					kind: "page",
					label: "Pull Requests",
					description: "Current product changes awaiting review.",
					view: {
						type: "builtin",
						id: "qorpera.preview",
						context: { message: "Pull request overview preview.", departmentId: "dept-product" },
					},
				},
			],
			diagnostics: [],
		},
		inbox: [],
		// Enough sessions that the review build shows the pile under each
		// department: page-scoped, product worktree, and unscoped chats.
		sessions: [
			{
				file: "trail/scheduled-reliability.jsonl",
				title: "Reliability sweep",
				mtimeMs: Date.now() - 22 * 60000,
				kind: "autonomous",
				category: "wake",
				group: "job:preview-reliability",
				scheduledJobId: "preview-reliability",
				scheduledJobTitle: "Reliability sweep",
				outcome: "succeeded",
				durationMs: 91000,
				calls: 4,
				costUsd: 0.12,
			},
			{ file: "trail/founder-1.jsonl", title: "Kickoff — company goals and constraints", mtimeMs: Date.now() - 16 * 60000, kind: "chat" },
			{ file: "trail/founder-2.jsonl", title: "Q3 numbers walkthrough", mtimeMs: Date.now() - 14 * 3600000, kind: "chat", page: "page:q3-report" },
			{ file: "trail/founder-3.jsonl", title: "Runway: downside scenario", mtimeMs: Date.now() - 15 * 3600000, kind: "chat", page: "page:runway" },
			{ file: "trail/founder-4.jsonl", title: "Ticket backlog triage", mtimeMs: Date.now() - 2 * 86400000, kind: "chat", page: "page:tickets" },
			{ file: "trail/founder-5.jsonl", title: "Fix the release pipeline", mtimeMs: Date.now() - 3 * 86400000, kind: "chat", department: "C:/Products/qorpera-base", worktree: "release-fix" },
			{ file: "trail/founder-6.jsonl", title: "Pricing page copy review", mtimeMs: Date.now() - 4 * 86400000, kind: "chat", page: "page:pricing" },
		],
		departments: [{ id: "dept-product", path: "C:/Products/qorpera-base", name: "Qorpera Base Development" }],
		runtime: { revision: 0, generatedAt: new Date().toISOString(), sessions: [] },
	};
	window.EventSource = class PreviewEventSource {
		addEventListener(type, handler) {
			if (type === "snapshot") {
				queueMicrotask(() => handler({ data: JSON.stringify(previewState.runtime) }));
			}
		}
		close() {}
	};

	const activeCompany = {
		backendUrl: "https://qorpera.preview",
		sessionFile: "trail/founder-1.jsonl",
		usingBaseFallback: false,
		kickoff: false,
		mergeRunning: false,
		wakeRunning: false,
		scheduledJobs: [
			{
				id: "preview-reliability",
				title: "Reliability sweep",
				prompt: "Inspect the reliability dashboard, validate the controller, and repair the highest-impact outstanding issue.",
				intervalMinutes: 10,
				enabled: true,
				createdAt: "2026-08-12T08:00:00.000Z",
				updatedAt: "2026-08-13T16:00:00.000Z",
				lastRunAt: new Date(Date.now() - 22 * 60000).toISOString(),
				lastFinishedAt: new Date(Date.now() - 20 * 60000).toISOString(),
				lastOutcome: "succeeded",
				nextRunAt: new Date(Date.now() + 8 * 60000).toISOString(),
				failureStreak: 0,
				running: false,
			},
			{
				id: "preview-digest",
				title: "Weekly digest",
				prompt: "Summarize the week across departments and post one digest to the inbox.",
				intervalMinutes: 10080,
				enabled: false,
				createdAt: "2026-08-01T08:00:00.000Z",
				updatedAt: "2026-08-10T16:00:00.000Z",
				failureStreak: 0,
				running: false,
			},
			{
				id: "preview-outreach",
				title: "Outreach follow-ups",
				prompt: "Check outreach replies and draft follow-ups for anything stale.",
				intervalMinutes: 240,
				enabled: true,
				suspendedReason: "3 consecutive scheduled-job failures",
				createdAt: "2026-08-05T08:00:00.000Z",
				updatedAt: "2026-08-13T09:00:00.000Z",
				lastOutcome: "failed",
				failureStreak: 3,
				running: false,
			},
		],
		userland: { baseVersion: "preview" },
		activeApp: "fork",
		versions: [],
		evolved: true,
	};
	const nativeFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input.url;
		if (url === `${activeCompany.backendUrl}/api/state`) {
			return new Response(JSON.stringify(previewState), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url === `${activeCompany.backendUrl}/api/authority/config`) {
			return new Response(
				JSON.stringify({
					classes: {
						money: { mode: "notify", limitUsd: 50 },
						identity: { mode: "gate" },
						irreversible: { mode: "gate" },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		if (url === `${activeCompany.backendUrl}/api/authority`) {
			return new Response("[authority]\nmode = \"gate\"\n", { status: 200 });
		}
		if (url.startsWith(`${activeCompany.backendUrl}/`)) {
			return new Response("Not available in browser preview", { status: 404 });
		}
		return nativeFetch(input, init);
	};

	const noop = () => {};
	window.qorpera = {
		appInfo: async () => ({ version: "preview", activeCompany }),
		listCompanies: async () => [],
		newCompany: async () => "",
		integrateCompany: async () => ({ ok: false, root: "" }),
		addProduct: async () => ({ ok: false, error: "browser preview" }),
		chooseProductSource: async () => ({ ok: false }),
		createScheduledJob: async () => ({ ok: false, error: "browser preview" }),
		updateScheduledJob: async () => ({ ok: false, error: "browser preview" }),
		deleteScheduledJob: async () => ({ ok: false, error: "browser preview" }),
		runScheduledJob: async () => ({ ok: false, error: "browser preview" }),
		openCompany: async () => {},
		authorizedBackendPost: async () => ({ ok: true, status: 200, text: '{"ok":true}' }),
		openChat: async (sessionFile) => ({
			ok: true,
			sessionFile: sessionFile ?? `trail/preview-${Date.now()}.jsonl`,
			department: null,
			worktree: null,
		}),
		rpcSend: noop,
		onRpcEvent: noop,
		onRpcLog: noop,
		onRpcExit: noop,
		settingsInfo: async () => ({
			version: "preview",
			packaged: false,
			providers: ["Browser preview"],
			agentDir: "No credentials are used in browser preview",
		}),
		updateInstall: noop,
		setActiveApp: noop,
		chooseIcon: async () => ({ ok: false }),
		favoriteVersion: async () => {},
		restoreVersion: async () => {},
		updateCheck: noop,
		onUpdateStatus: noop,
		onUpdateReady: noop,
		onOpenCompany: noop,
		onMergeDone: noop,
		mergeUserland: async () => ({ ok: false }),
	};

	document.body.classList.add("browser-preview");
	const previewBadge = document.createElement("span");
	previewBadge.className = "preview-mode-badge";
	previewBadge.textContent = "Browser preview · local only";
	document.querySelector("#titlebar > div")?.appendChild(previewBadge);
})();
