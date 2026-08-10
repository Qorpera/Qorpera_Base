/* Browser-only bridge for reviewing the production userland without Electron.
 * The real preload bridge always wins. Preview actions never write company data. */
(() => {
	if (window.qorpera) return;

	const previewState = {
		name: "Northstar Works",
		projection: {
			schema: "qorpera.projection/v1",
			default: "category:finance-outlook",
			navigation: ["department:main", "department:financials", "department:support", "department:product"],
			nodes: [
				{
					id: "department:main",
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
					label: "Activity",
					description: "Autonomous controller work and operational history.",
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
					view: { type: "builtin", id: "qorpera.preview", context: { message: "Pull request overview preview." } },
				},
			],
			diagnostics: [],
		},
		inbox: [],
		sessions: [],
		departments: [],
	};

	const activeCompany = {
		backendUrl: "https://qorpera.preview",
		usingBaseFallback: false,
		kickoff: false,
		mergeRunning: false,
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
		openCompany: async () => {},
		authorizedBackendPost: async () => ({ ok: true, status: 200, text: '{"ok":true}' }),
		openChat: async () => ({ ok: true, department: null, worktree: null }),
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
