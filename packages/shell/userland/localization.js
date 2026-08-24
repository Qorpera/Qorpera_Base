/* Qorpera Base interface localization. English remains the source language so
 * renderer-created controls and the static shell use the same translations. */
(() => {
	const STORAGE_KEY = "qorpera-language";
	const ATTRIBUTE_NAMES = ["aria-label", "placeholder", "title"];
	const NO_TRANSLATE_SELECTOR = "script, style, #messages, #attachStrip, [data-i18n-ignore]";
	const DANISH_TRANSLATIONS = Object.freeze({
		"A software product connected to its source workspace.":
			"Et softwareprodukt, der er forbundet til sit kildearbejdsområde.",
		Account: "Konto",
		"Add account": "Tilføj konto",
		"Add agent": "Tilføj agent",
		"Add department": "Tilføj afdeling",
		"Add friend": "Tilføj ven",
		"Adjust height": "Juster højde",
		Agent: "Agent",
		"Agent actions": "Agenthandlinger",
		"Agent artifacts": "Agentartefakter",
		"Agent character": "Agentfigur",
		"Agent color": "Agentfarve",
		"Agent details": "Agentdetaljer",
		"Agent face shape": "Agentens ansigtsform",
		"Agent name": "Agentnavn",
		"An empty department with no categories or pages.": "En tom afdeling uden kategorier eller sider.",
		Appearance: "Udseende",
		"Archive agent?": "Arkivér agent?",
		"Archive is a durable company action. This frontend flow does not delete, move, or modify company data.":
			"Arkivering er en varig virksomhedshandling. Denne proces sletter, flytter eller ændrer ikke virksomhedsdata.",
		"Archive chat": "Arkivér chat",
		"Archive item?": "Arkivér element?",
		Archive: "Arkivér",
		"Archived group chats": "Arkiverede gruppechats",
		"Attach files": "Vedhæft filer",
		Back: "Tilbage",
		Browse: "Gennemse",
		Cancel: "Annuller",
		"Cash position, commitments, forecasting, and reporting.":
			"Likviditet, forpligtelser, prognoser og rapportering.",
		"Change icon": "Skift ikon",
		"Chat settings and more": "Chatindstillinger og mere",
		"Check for updates": "Søg efter opdateringer",
		"Choose a starting point": "Vælg et udgangspunkt",
		"Choose picture": "Vælg billede",
		"Choose the intelligence provider your staff will use.":
			"Vælg den intelligensudbyder, dine agenter skal bruge.",
		"Clone into a local folder": "Klon til en lokal mappe",
		"Clone repository": "Klon repository",
		Close: "Luk",
		"Close agent side panel": "Luk agentpanelet",
		"Close friends": "Luk venner",
		"Close inactive agents": "Luk inaktive agenter",
		"Close new conversation": "Luk ny samtale",
		"Close room settings": "Luk rumindstillinger",
		"Close settings": "Luk indstillinger",
		Company: "Virksomhed",
		"Company Interface": "Virksomhedsgrænseflade",
		"Company navigation": "Virksomhedsnavigation",
		"Company name": "Virksomhedsnavn",
		"Company structure": "Virksomhedsstruktur",
		"Company workspace": "Virksomhedens arbejdsområde",
		Connect: "Forbind",
		"Connect intelligence": "Forbind intelligens",
		"Connect an existing folder": "Forbind en eksisterende mappe",
		"Connect an existing local Git repository or clone a remote repository into company-managed storage.":
			"Forbind et eksisterende lokalt Git-repository, eller klon et eksternt repository til virksomhedens lager.",
		"Connect the product workspace": "Forbind produktets arbejdsområde",
		Connections: "Forbindelser",
		Continue: "Fortsæt",
		Conversation: "Samtale",
		"Conversation recipients": "Samtalens deltagere",
		"Copy conversation ID": "Kopiér samtale-id",
		Create: "Opret",
		"Create a company": "Opret en virksomhed",
		"Create company": "Opret virksomhed",
		"Create department": "Opret afdeling",
		"Customer Support": "Kundeservice",
		Default: "Standard",
		"Delete permanently": "Slet permanent",
		"Department icon": "Afdelingsikon",
		"Department name": "Afdelingsnavn",
		"Display name in this panel": "Vis navn i dette panel",
		Done: "Færdig",
		"Edit agent": "Rediger agent",
		"Email address": "E-mailadresse",
		"Email unavailable": "E-mail ikke tilgængelig",
		English: "Engelsk",
		"Execution sponsor": "Kørselssponsor",
		"Fast responses": "Hurtige svar",
		"Financial Operations": "Finansdrift",
		"Focus department": "Fokusér på afdeling",
		Friends: "Venner",
		General: "Generelt",
		"Group chat": "Gruppechat",
		"Height offset": "Højdeforskydning",
		"Hiring, onboarding, policies, and team operations.":
			"Rekruttering, onboarding, retningslinjer og teamdrift.",
		"Hidden departments": "Skjulte afdelinger",
		Hide: "Skjul",
		"Hide from sidebar": "Skjul fra sidepanelet",
		"Inactive agents": "Inaktive agenter",
		"Inbox, issue handling, feedback, and service quality.":
			"Indbakke, håndtering af henvendelser, feedback og servicekvalitet.",
		"Install Qorpera Base update": "Installér opdatering til Qorpera Base",
		"Keep this agent’s artifacts": "Behold denne agents artefakter",
		"Intelligence providers": "Intelligensudbydere",
		Language: "Sprog",
		"Language & region": "Sprog og område",
		Light: "Lys",
		"Local repository path": "Sti til lokalt repository",
		"Local or cloned repository": "Lokalt eller klonet repository",
		Medium: "Mellem",
		Message: "Besked",
		"Model & effort": "Model og indsats",
		"Model and effort": "Model og indsats",
		"Model control": "Modelstyring",
		"Move out of active use": "Flyt ud af aktiv brug",
		Name: "Navn",
		"Name the department": "Navngiv afdelingen",
		"Navigation item height offset in pixels": "Navigationselementets højdeforskydning i pixels",
		"Navigation panel": "Navigationspanel",
		"New Agent": "Ny agent",
		"New conversation": "Ny samtale",
		"New worktree": "Nyt worktree",
		"No settings found": "Ingen indstillinger fundet",
		Open: "Åbn",
		"Open agent computer and routines": "Åbn agentens computer og rutiner",
		"Open agent settings": "Åbn agentindstillinger",
		"Open group chat settings": "Åbn gruppechatindstillinger",
		"Operating views for a function, team, or responsibility inside the company.":
			"Arbejdsvisninger for en funktion, et team eller et ansvarsområde i virksomheden.",
		"or": "eller",
		Participants: "Deltagere",
		"People & Culture": "Mennesker og kultur",
		"Pick the department glyph": "Vælg afdelingens symbol",
		Pin: "Fastgør",
		Policy: "Retningslinjer",
		"PNG, JPEG, or WebP. The picture is private to your account on this computer.":
			"PNG, JPEG eller WebP. Billedet er privat for din konto på denne computer.",
		"If permanently deleted, preserve its artifact files in the company without an active owner.":
			"Bevar artefaktfilerne i virksomheden uden en aktiv ejer, hvis agenten slettes permanent.",
		"Preserve its artifact files in the company without an active owner.":
			"Bevar artefaktfilerne i virksomheden uden en aktiv ejer.",
		"Product Development": "Produktudvikling",
		"Qorpera sign-in methods": "Loginmetoder til Qorpera",
		"Qorpera reviews the exact department and source before copying or cloning it.":
			"Qorpera gennemgår den præcise afdeling og kilde, før den kopieres eller klones.",
		"Reasoning effort": "Ræsonneringsindsats",
		"Remember me": "Husk mig",
		"Remove from this panel": "Fjern fra dette panel",
		Rename: "Omdøb",
		"Repository URL": "Repository-URL",
		"Restore a room to return it to the sidebar. Its transcript remains intact.":
			"Gendan et rum for at føre det tilbage til sidepanelet. Samtalehistorikken bevares.",
		Reset: "Nulstil",
		"Reset workspace view": "Nulstil visning af arbejdsområde",
		"Resize agent navigation": "Tilpas bredden på agentnavigationen",
		"Room settings": "Rumindstillinger",
		Save: "Gem",
		Search: "Søg",
		"Search or create agents": "Søg efter eller opret agenter",
		"Search settings": "Søg i indstillinger",
		"Search staff": "Søg efter agenter",
		"Select a kit from the department library or begin with an empty department.":
			"Vælg en skabelon fra afdelingsbiblioteket, eller begynd med en tom afdeling.",
		"Select a company": "Vælg en virksomhed",
		"Select one agent for a direct conversation, or several for a group chat.":
			"Vælg én agent til en direkte samtale eller flere til en gruppechat.",
		Send: "Send",
		Setup: "Opsætning",
		Settings: "Indstillinger",
		"Settings sections": "Indstillingssektioner",
		"Show only this department": "Vis kun denne afdeling",
		"Sign in to keep your companies and agents connected to you.":
			"Log ind for at holde dine virksomheder og agenter knyttet til dig.",
		"Sign out": "Log ud",
		Staff: "Agenter",
		"Start from scratch": "Start fra bunden",
		"Stop the agent": "Stop agenten",
		"Suggested agents": "Foreslåede agenter",
		"Switch company or open company settings": "Skift virksomhed eller åbn virksomhedsindstillinger",
		"System default": "Systemstandard",
		"System default follows your computer's language.": "Systemstandarden følger sproget på din computer.",
		"Template library or scratch": "Skabelonbibliotek eller tom afdeling",
		"This becomes the department title in the navigation.": "Dette bliver afdelingens titel i navigationen.",
		"This becomes their persistent identity in the company.":
			"Dette bliver deres vedvarende identitet i virksomheden.",
		"This changes the setup options shown next. It does not constrain the work the staff can do.":
			"Dette ændrer de næste opsætningsmuligheder. Det begrænser ikke det arbejde, agenterne kan udføre.",
		"This item will be removed from active navigation.": "Dette element fjernes fra den aktive navigation.",
		Theme: "Tema",
		"To:": "Til:",
		Type: "Type",
		"Unhide active agents or restore archived agents to the company roster.":
			"Vis aktive agenter igen, eller gendan arkiverede agenter til virksomhedens agentliste.",
		Update: "Opdater",
		"Use anonymous icon": "Brug anonymt ikon",
		"Use local repository": "Brug lokalt repository",
		"Use the name people expect to see in the company interface.":
			"Brug det navn, som folk forventer at se i virksomheden.",
		"What kind of department is this?": "Hvilken type afdeling er dette?",
		"Your company and Company File are created in the cloud. The first 50 GB is included.":
			"Din virksomhed og Company File oprettes i skyen. De første 50 GB er inkluderet.",
	});

	const textSources = new WeakMap();
	const attributeSources = new WeakMap();
	let preference = readPreference();
	let locale = resolveLocale(preference);
	let observer;

	function readPreference() {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			return stored === "da" || stored === "en" ? stored : "system";
		} catch {
			return "system";
		}
	}

	function resolveLocale(value, languages = navigator.languages ?? [navigator.language]) {
		if (value === "da" || value === "en") return value;
		return String(languages[0] ?? navigator.language)
			.toLowerCase()
			.startsWith("da")
			? "da"
			: "en";
	}

	function danishTranslation(source) {
		const trimmed = source.trim();
		const replacement = Object.hasOwn(DANISH_TRANSLATIONS, trimmed) ? DANISH_TRANSLATIONS[trimmed] : undefined;
		if (!replacement) return source;
		return `${source.slice(0, source.indexOf(trimmed))}${replacement}${source.slice(source.indexOf(trimmed) + trimmed.length)}`;
	}

	function translated(source) {
		return locale === "da" ? danishTranslation(source) : source;
	}

	function excluded(element) {
		return element && typeof element.closest === "function" && Boolean(element.closest(NO_TRANSLATE_SELECTOR));
	}

	function translateText(node) {
		if (!node.data.trim() || excluded(node.parentElement)) return;
		let source = textSources.get(node);
		if (!source || (node.data !== source && node.data !== danishTranslation(source))) {
			source = node.data;
			textSources.set(node, source);
		}
		node.data = translated(source);
	}

	function translateAttribute(element, name) {
		if (!name) return;
		const value = element.getAttribute(name);
		if (!value) return;
		let sources = attributeSources.get(element);
		if (!sources) {
			sources = new Map();
			attributeSources.set(element, sources);
		}
		let source = sources.get(name);
		if (!source || (value !== source && value !== danishTranslation(source))) {
			source = value;
			sources.set(name, source);
		}
		element.setAttribute(name, translated(source));
	}

	function translateNode(node) {
		if (node.nodeType === 3) {
			translateText(node);
			return;
		}
		if (node.nodeType !== 1 || excluded(node)) return;
		for (const name of ATTRIBUTE_NAMES) translateAttribute(node, name);
		for (const child of node.childNodes) translateNode(child);
	}

	function apply(root = document.documentElement) {
		document.documentElement.lang = locale;
		translateNode(root);
		observer?.takeRecords();
	}

	function setPreference(value) {
		if (value !== "system" && value !== "da" && value !== "en") return;
		preference = value;
		locale = resolveLocale(preference);
		try {
			if (preference === "system") localStorage.removeItem(STORAGE_KEY);
			else localStorage.setItem(STORAGE_KEY, preference);
		} catch {
			// A blocked storage area should not prevent the in-memory preference.
		}
		apply();
	}

	window.qorperaI18n = {
		get locale() {
			return locale;
		},
		get preference() {
			return preference;
		},
		resolveLocale,
		setPreference,
		t: translated,
	};

	observer = new MutationObserver((records) => {
		for (const record of records) {
			if (record.type === "attributes") translateAttribute(record.target, record.attributeName);
			else if (record.type === "characterData") translateText(record.target);
			else for (const node of record.addedNodes) translateNode(node);
		}
		observer.takeRecords();
	});
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ATTRIBUTE_NAMES,
		characterData: true,
		childList: true,
		subtree: true,
	});
	window.addEventListener("languagechange", () => {
		if (preference !== "system") return;
		locale = resolveLocale(preference);
		apply();
	});
	apply();
})();
