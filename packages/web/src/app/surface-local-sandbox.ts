import {
	type StudioPatchOp,
	SURFACE_INSPECTOR_MODE_MESSAGE,
	SURFACE_INSPECTOR_PICK_MESSAGE,
	type SurfaceChangeUnit,
	type SurfaceSummary,
} from "@qorpera/contracts";
import type { SurfaceKind } from "./surface-kinds.ts";

export interface LocalStagedChangePlan {
	readonly changes: readonly SurfaceChangeUnit[];
	readonly studioPatches: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly replyText: string;
}

const ACCENT_PALETTE: readonly { readonly match: RegExp; readonly name: string; readonly hex: string }[] = [
	{ match: /terracotta|warm|copper|rust|amber|clay|orange/i, name: "Terracotta", hex: "#c65d3b" },
	{ match: /forest|sage|green|olive|moss|pine/i, name: "Forest Sage", hex: "#2d6a57" },
	{ match: /cobalt|ocean|navy|blue|fjord|indigo/i, name: "Nordic Fjord", hex: "#2a5d9e" },
	{ match: /plum|violet|purple|berry|lilac/i, name: "Evening Plum", hex: "#6f4a8e" },
	{ match: /charcoal|ink|mono|slate|dark|black/i, name: "Graphite Ink", hex: "#232321" },
];

const NAME_STOP_WORDS = new Set([
	"him",
	"her",
	"them",
	"the",
	"a",
	"an",
	"again",
	"back",
	"our",
	"my",
	"us",
	"me",
	"everyone",
	"all",
	"ham",
	"hende",
	"dem",
	"igen",
]);

export function slugifySurfaceTitle(title: string, taken: ReadonlySet<string>): string {
	const raw = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 34);
	const base = raw && /^[a-z0-9]/.test(raw) ? raw : "surface";
	if (!taken.has(base)) return base;
	let index = 2;
	while (taken.has(`${base}-${index}`)) index += 1;
	return `${base}-${index}`;
}

function isSpecSurface(surface: Pick<SurfaceSummary, "slug">, kind: SurfaceKind | undefined): boolean {
	if (kind) return kind === "product";
	return surface.slug.includes("product") || surface.slug.includes("hardware") || surface.slug.includes("spec");
}

export function starterStudioFiles(
	surface: Pick<SurfaceSummary, "slug" | "title" | "folderRoot">,
	companyName: string,
	kind?: SurfaceKind,
	description?: string,
): Record<string, string> {
	const root = (surface.folderRoot || surface.slug || "studio").replace(/^\/+|\/+$/g, "");
	const name = companyName.trim() || "Company";
	if (kind === "database" || kind === "data") {
		return {
			[`${root}/tables.json`]: JSON.stringify(
				{
					customers: [
						{ name: "Mette Holm", plan: "Complete", country: "DK", since: "2026-03-14" },
						{ name: "Asger Sønder", plan: "Starter", country: "DK", since: "2026-05-02" },
						{ name: "Lina Berg", plan: "Team", country: "SE", since: "2026-06-19" },
					],
					orders: [
						{ order: "#1042", customer: "Mette Holm", total: "1.995 kr.", status: "Shipped" },
						{ order: "#1043", customer: "Lina Berg", total: "4.900 kr.", status: "Paid" },
						{ order: "#1044", customer: "Asger Sønder", total: "1.495 kr.", status: "Pending" },
					],
				},
				null,
				2,
			),
			[`${root}/schema.md`]: `# ${surface.title}\n\n${description?.trim() || `The tables ${name} runs on: customers, orders, and what ties them together.`}\n`,
		};
	}
	if (kind === "custom") {
		return {
			[`${root}/brief.md`]: `# ${surface.title}\n\n${description?.trim() || `A shared space for ${name}. Describe what belongs here and an agent will shape it.`}\n`,
			[`${root}/overview.json`]: JSON.stringify(
				{ overview: { owner: name, status: "Getting started", nextStep: "Describe the first change below" } },
				null,
				2,
			),
		};
	}
	if (isSpecSurface(surface, kind)) {
		return {
			[`${root}/specs.json`]: JSON.stringify(
				{
					overview: { product: `${name} Core`, status: "Prototype v1", targetWeight: "44 g" },
					colorways: [
						{ name: "Sandstone", hex: "#e6dfd3" },
						{ name: "Nordic Slate", hex: "#3c4a54" },
						{ name: "Warm Clay", hex: "#c65d3b" },
					],
					bom: [
						{ part: "Outer shell", material: "Recycled knit", unitCost: "$9.50" },
						{ part: "Sensor module", material: "Low-power BLE", unitCost: "$14.00" },
						{ part: "Battery pack", material: "LiPo 280 mAh", unitCost: "$4.20" },
					],
				},
				null,
				2,
			),
			[`${root}/brief.md`]: `# ${surface.title}\n\n${description?.trim() || `Built for **${name}** with calm industrial craft, clear pricing, and zero clutter.`}\n`,
		};
	}
	return {
		[`${root}/tokens.json`]: JSON.stringify(
			{
				colors: {
					paper: "#f8f7f4",
					surface: "#efede8",
					ink: "#171715",
					accent: "#2a5d9e",
				},
				typography: {
					display: "Georgia, 'Iowan Old Style', serif",
					body: "'Source Sans 3', system-ui, sans-serif",
				},
			},
			null,
			2,
		),
		[`${root}/voice.md`]: `# ${name} voice\n\nDirect, calm, and grounded. Lead with what the customer actually gets instead of buzzwords.\n`,
	};
}

function summarizeTitle(prompt: string, fallback: string): string {
	const clean = prompt.replace(/\s+/g, " ").trim();
	if (!clean) return fallback;
	const clause = clean.split(/[.!?\n]/)[0]?.trim() || clean;
	return clause.length <= 44 ? clause : `${clause.slice(0, 41).trimEnd()}…`;
}

function splitMultiPrompt(prompt: string): [string, string] | null {
	const trimmed = prompt.trim();
	if (trimmed.length < 26) return null;
	const byAnd = trimmed.split(/\s+(?:and|og|\+|,)\s+/i).filter((part) => part.trim().length >= 8);
	if (byAnd.length >= 2)
		return [summarizeTitle(byAnd[0]!, "First update"), summarizeTitle(byAnd[1]!, "Second update")];
	return null;
}

function capitalize(word: string): string {
	return word ? word.charAt(0).toLocaleUpperCase() + word.slice(1) : word;
}

export function recipientOf(prompt: string): string | null {
	const pattern =
		/\b(?:reach out to|write to|email|e-mail|mail|reply to|respond to|follow up with|contact|ping|message|ask|tell|thank|remind|skriv til|svar|kontakt|spørg)\s+([A-Za-zÀ-ÖØ-öø-ÿ][\wÀ-ÖØ-öø-ÿ.'-]*)/gi;
	for (const match of prompt.matchAll(pattern)) {
		const word = match[1]?.replace(/[.'-]+$/, "") ?? "";
		if (word && !NAME_STOP_WORDS.has(word.toLowerCase())) return capitalize(word.toLowerCase());
	}
	return null;
}

interface EmailDraft {
	readonly subject: string;
	readonly body: string;
}

function emailDraft(prompt: string, recipient: string | null, company: string): EmailDraft {
	const hello = recipient ? `Hi ${recipient},` : "Hi,";
	const sign = `Best regards,\n${company || "The team"}`;
	const lower = prompt.toLowerCase();
	if (/elaborat|explain|detail|more about|uddyb|forklar/.test(lower))
		return {
			subject: "Could you elaborate?",
			body: `${hello}\n\nThanks again for your message. Could you elaborate a little on what you had in mind? A couple of concrete examples would help us come back to you with something genuinely useful.\n\n${sign}`,
		};
	if (/invoice|payment|pay|faktura|betal/.test(lower))
		return {
			subject: "A friendly reminder about the invoice",
			body: `${hello}\n\nI hope all is well. This is a friendly reminder that the latest invoice is still open. Let me know if anything is unclear or if you need a copy.\n\n${sign}`,
		};
	if (/meet|call|schedule|møde|ring/.test(lower))
		return {
			subject: "Finding a time to talk",
			body: `${hello}\n\nWould you have 20 minutes this week for a quick call? Tuesday or Thursday afternoon works well on our side — just reply with what suits you.\n\n${sign}`,
		};
	if (/thank|tak/.test(lower))
		return {
			subject: "Thank you",
			body: `${hello}\n\nJust a short note to say thank you — it made a real difference for us, and we wanted you to know.\n\n${sign}`,
		};
	return {
		subject: summarizeTitle(prompt, "Following up"),
		body: `${hello}\n\nI wanted to follow up on our last conversation. ${capitalize(prompt.trim().replace(/[?.!]+$/, ""))}.\n\nLooking forward to hearing from you.\n\n${sign}`,
	};
}

function opsAction(
	kind: SurfaceKind | undefined,
	surface: SurfaceSummary,
	prompt: string,
	company: string,
): { title: string; summary: string; paths: string[]; reply: string } {
	if (kind === "inbox") {
		const recipient = recipientOf(prompt);
		const draft = emailDraft(prompt, recipient, company);
		return {
			title: draft.subject,
			summary: draft.body,
			paths: recipient ? [`mailto:${recipient.toLowerCase()}`] : [],
			reply: recipient
				? `Drafted an email to ${recipient}. Read it through, then press Send — nothing goes out before you do.`
				: "Drafted the email. Read it through, then press Send — nothing goes out before you do.",
		};
	}
	if (kind === "money")
		return {
			title: summarizeTitle(prompt, "Payment prepared"),
			summary: `Prepared for your approval: ${prompt.trim()}\n\nNothing is paid or moved until you approve.`,
			paths: [],
			reply: "Prepared it for your approval. Check the details, then approve when it looks right.",
		};
	if (kind === "members")
		return {
			title: summarizeTitle(prompt, "Team update"),
			summary: `Ready to apply: ${prompt.trim()}\n\nRoles and invitations change only after you approve.`,
			paths: [],
			reply: "The team update is ready. Approve it and I'll apply it right away.",
		};
	if (kind === "data")
		return {
			title: summarizeTitle(prompt, "Table update"),
			summary: `Ready to run: ${prompt.trim()}\n\nRows are written only after you approve.`,
			paths: [],
			reply: "The table update is ready. Approve it to write the rows.",
		};
	if (kind === "files")
		return {
			title: summarizeTitle(prompt, "File update"),
			summary: `Ready to apply: ${prompt.trim()}\n\nFiles are created or moved only after you approve.`,
			paths: [],
			reply: "The file update is ready. Approve it and I'll put everything in place.",
		};
	return {
		title: summarizeTitle(prompt, surface.title),
		summary: `Ready to carry out on ${surface.title}: ${prompt.trim()}`,
		paths: [],
		reply: "It's ready. Approve it to carry it out.",
	};
}

function stagedChange(
	id: string,
	sessionId: string,
	surface: SurfaceSummary,
	seq: number,
	kind: SurfaceChangeUnit["kind"],
	title: string,
	summary: string,
	paths: readonly string[],
	diffStats: SurfaceChangeUnit["diffStats"],
	now: string,
): SurfaceChangeUnit {
	return {
		id,
		sessionId,
		surfaceId: surface.id,
		seq,
		kind,
		title,
		summary,
		status: "staged",
		parentSha: null,
		headSha: null,
		dependsOnChangeIds: [],
		diffStats,
		affectedPaths: [...paths],
		conflictPaths: null,
		landedChangeNumber: null,
		canUndo: false,
		createdAt: now,
		resolvedAt: null,
	};
}

export function synthesizeLocalChanges(
	surface: SurfaceSummary,
	sessionId: string,
	prompt: string,
	nextId: () => string,
	companyName: string,
	kind?: SurfaceKind,
): LocalStagedChangePlan {
	const now = new Date().toISOString();
	const root = (surface.folderRoot || surface.slug || "studio").replace(/^\/+|\/+$/g, "");
	const pickedColor = ACCENT_PALETTE.find((entry) => entry.match.test(prompt)) ?? ACCENT_PALETTE[0]!;
	const parts = splitMultiPrompt(prompt);

	if (surface.archetype === "ops") {
		const action = opsAction(kind, surface, prompt, companyName);
		return {
			changes: [
				stagedChange(
					nextId(),
					sessionId,
					surface,
					1,
					"ops_action",
					action.title,
					action.summary,
					action.paths,
					null,
					now,
				),
			],
			studioPatches: {},
			replyText: action.reply,
		};
	}

	if (surface.archetype === "studio" && (kind === "database" || kind === "data")) {
		const id = nextId();
		const path = `${root}/tables.json`;
		const title = summarizeTitle(prompt, "Update tables");
		return {
			changes: [
				stagedChange(
					id,
					sessionId,
					surface,
					1,
					"folder_patch",
					title,
					`Updated ${path} based on “${title}”.`,
					[path],
					{ filesChanged: 1, additions: 6, deletions: 0 },
					now,
				),
			],
			studioPatches: {
				[id]: [
					{
						op: "merge_json",
						path,
						patch: {
							segments: [
								{ segment: "Early adopters", customers: "2", revenue: "3.490 kr.", note: title },
								{ segment: "Teams", customers: "1", revenue: "4.900 kr.", note: "Priority onboarding" },
							],
						},
					},
				],
			},
			replyText: `Staged “${title}”. Toggle it to see the tables with the change, then approve it into Base.`,
		};
	}

	if (surface.archetype === "studio") {
		const isSpec = isSpecSurface(surface, kind);
		const isCustom = kind === "custom";
		const firstId = nextId();
		const secondId = nextId();
		const firstTitle =
			parts?.[0] ??
			(isCustom
				? summarizeTitle(prompt, `Shape ${surface.title}`)
				: isSpec
					? `Refine ${surface.title} colorways`
					: `${pickedColor.name} accent & palette`);
		const secondTitle =
			parts?.[1] ??
			(isCustom ? "Tighten the brief" : isSpec ? "Tighten product brief" : "Refine typography & voice");
		const firstPath = isCustom ? `${root}/overview.json` : isSpec ? `${root}/specs.json` : `${root}/tokens.json`;
		const secondPath = isCustom || isSpec ? `${root}/brief.md` : `${root}/voice.md`;
		const changes: SurfaceChangeUnit[] = [
			stagedChange(
				firstId,
				sessionId,
				surface,
				1,
				"folder_patch",
				firstTitle,
				`Updated ${firstPath} based on “${summarizeTitle(prompt, surface.title)}”.`,
				[firstPath],
				{ filesChanged: 1, additions: 4, deletions: 2 },
				now,
			),
			stagedChange(
				secondId,
				sessionId,
				surface,
				2,
				"folder_patch",
				secondTitle,
				`Updated ${secondPath} so copy stays aligned across ${companyName || "the company"}.`,
				[secondPath],
				{ filesChanged: 1, additions: 3, deletions: 1 },
				now,
			),
		];
		const studioPatches: Record<string, readonly StudioPatchOp[]> = isCustom
			? {
					[firstId]: [
						{
							op: "merge_json",
							path: firstPath,
							patch: { overview: { status: "In progress", focus: firstTitle } },
						},
					],
					[secondId]: [
						{
							op: "write_text",
							path: secondPath,
							content: `# ${surface.title}\n\n${prompt.trim()}\n\nShaped for **${companyName || "your team"}**.\n`,
						},
					],
				}
			: isSpec
				? {
						[firstId]: [
							{ op: "merge_json", path: firstPath, patch: { overview: { status: "Ready for pilot" } } },
						],
						[secondId]: [
							{
								op: "write_text",
								path: secondPath,
								content: `# ${surface.title}\n\n${prompt.trim()}\n\nPrepared for **${companyName || "your team"}** — ready to sync across surfaces.\n`,
							},
						],
					}
				: {
						[firstId]: [
							{
								op: "merge_json",
								path: firstPath,
								patch: { colors: { accent: pickedColor.hex, surface: "#f3efe8" } },
							},
						],
						[secondId]: [
							{
								op: "merge_json",
								path: firstPath,
								patch: { typography: { display: "Newsreader, Georgia, serif" } },
							},
							{
								op: "write_text",
								path: secondPath,
								content: `# ${companyName || "Company"} voice\n\n${prompt.trim()}\n\nKeep headlines concise, warm, and unmistakably clear.\n`,
							},
						],
					};
		return {
			changes,
			studioPatches,
			replyText: `Staged 2 changes for ${surface.title}. Toggle each switch in the rail or drawer to inspect them live, then approve individually or all at once.`,
		};
	}

	const firstId = nextId();
	const secondId = nextId();
	const primaryTitle = parts?.[0] ?? summarizeTitle(prompt, `Update ${surface.title}`);
	const secondaryTitle = parts?.[1] ?? "Polish spacing & mobile rhythm";
	const changes: SurfaceChangeUnit[] = [
		stagedChange(
			firstId,
			sessionId,
			surface,
			1,
			"git_range",
			primaryTitle,
			`Applied “${summarizeTitle(prompt, surface.title)}” on the ${surface.title} surface.`,
			["src/sections/Hero.tsx", "src/styles/theme.css"],
			{ filesChanged: 2, additions: 38, deletions: 12 },
			now,
		),
		...(parts || prompt.trim().length >= 24
			? [
					stagedChange(
						secondId,
						sessionId,
						surface,
						2,
						"git_range",
						secondaryTitle,
						"Adjusted type scale, CTA contrast, and mobile viewport layout.",
						["src/styles/layout.css"],
						{ filesChanged: 1, additions: 19, deletions: 6 },
						now,
					),
				]
			: []),
	];
	return {
		changes,
		studioPatches: {},
		replyText:
			changes.length > 1
				? `Staged ${changes.length} separate changes on ${surface.title}. Toggle either change in Preview, approve one while keeping the other open, or steer me below.`
				: `Staged “${primaryTitle}” on ${surface.title}. Toggle it in Preview to compare against Live, or approve it into Base.`,
	};
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

interface PreviewTheme {
	readonly name: string;
	readonly title: string;
	readonly accent: string;
	readonly ctaInk: string;
	readonly bg: string;
	readonly card: string;
	readonly ink: string;
	readonly muted: string;
	readonly border: string;
	readonly pillBg: string;
	readonly pillInk: string;
	readonly dark: boolean;
	readonly hasPricing: boolean;
	readonly hasBrandSync: boolean;
	readonly badges: string;
	readonly notes: string;
	readonly modeLabel: string;
	readonly applied: number;
}

function previewTheme(
	companyName: string,
	surface: SurfaceSummary,
	appliedChanges: readonly SurfaceChangeUnit[],
	mode: "live" | "preview",
	baseAccent: string,
): PreviewTheme {
	const joined = appliedChanges.map((change) => `${change.title} ${change.summary}`).join(" ");
	const hasPricing = /pric|plan|tier|cost|kr\.|eur|\$/i.test(joined);
	const dark = /\bdark\b|night|evening|aften/i.test(joined);
	const hasBrandSync = /brand|token|voice|palette|terracotta/i.test(joined);
	const matched = ACCENT_PALETTE.find((entry) => entry.match.test(joined) && !(dark && entry.hex === "#232321"));
	const accent =
		appliedChanges.length > 0 ? (dark ? (matched?.hex ?? "#e8a85a") : (matched?.hex ?? "#c65d3b")) : baseAccent;
	const notes = [...new Set(appliedChanges.map((change) => change.summary.trim()).filter(Boolean))].slice(0, 2);
	return {
		name: escapeHtml(companyName || surface.title),
		title: escapeHtml(surface.title),
		accent,
		ctaInk: dark && accent === "#e8a85a" ? "#151514" : "#ffffff",
		bg: dark ? "#131312" : "#faf9f6",
		card: dark ? "#1d1d1b" : "#ffffff",
		ink: dark ? "#f5f4f0" : "#171715",
		muted: dark ? "#b8b5ad" : "#62615c",
		border: dark ? "rgba(255,255,255,0.14)" : "rgba(23,23,21,0.10)",
		pillBg: dark ? "rgba(232,168,90,0.18)" : `color-mix(in srgb, ${accent} 13%, transparent)`,
		pillInk: dark ? "#f4c27f" : accent,
		dark,
		hasPricing,
		hasBrandSync,
		badges: appliedChanges
			.map((change) => `<span class="pill" data-component="ChangeBadge">${escapeHtml(change.title)}</span>`)
			.join(""),
		notes: escapeHtml(notes.join(" ")),
		modeLabel:
			mode === "live"
				? "Live baseline"
				: appliedChanges.length === 0
					? "Preview · matches Base"
					: `Preview · ${appliedChanges.length} change${appliedChanges.length === 1 ? "" : "s"} active`,
		applied: appliedChanges.length,
	};
}

function baseStyles(theme: PreviewTheme): string {
	return `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: ${theme.bg}; color: ${theme.ink}; line-height: 1.5; transition: background .2s ease, color .2s ease; }
  .pill { display: inline-flex; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; background: ${theme.pillBg}; color: ${theme.pillInk}; }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; }
  .status { font-size: 12px; font-weight: 600; color: ${theme.muted}; padding: 4px 10px; border-radius: 999px; border: 1px solid ${theme.border}; white-space: nowrap; }
  .cta { display: inline-flex; align-items: center; justify-content: center; height: 42px; padding: 0 20px; border-radius: 999px; border: 0; background: ${theme.accent}; color: ${theme.ctaInk}; font-weight: 650; font-size: 14px; cursor: pointer; }
  .cta.ghost { background: transparent; color: ${theme.ink}; border: 1px solid ${theme.border}; }
  [data-qorpera-inspect="on"] [data-component] { cursor: crosshair !important; }
  [data-qorpera-inspect="on"] [data-component]:hover { outline: 2px solid ${theme.accent}; outline-offset: 3px; border-radius: 10px; }`;
}

const INSPECTOR_SCRIPT = `
  <script>
    let inspect = false;
    window.addEventListener("message", (event) => {
      if (event.data && event.data.type === ${JSON.stringify(SURFACE_INSPECTOR_MODE_MESSAGE)}) {
        inspect = Boolean(event.data.active);
        document.documentElement.dataset.qorperaInspect = inspect ? "on" : "off";
      }
    });
    document.addEventListener("click", (event) => {
      if (!inspect) return;
      const el = event.target instanceof Element ? event.target.closest("[data-component]") || event.target : null;
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = el.getBoundingClientRect();
      window.parent.postMessage({
        type: ${JSON.stringify(SURFACE_INSPECTOR_PICK_MESSAGE)},
        target: {
          selector: el.getAttribute("data-component") ? '[data-component="' + el.getAttribute("data-component") + '"]' : el.tagName.toLowerCase(),
          tagName: el.tagName.toLowerCase(),
          textSnippet: (el.textContent || "").trim().slice(0, 140),
          route: "/",
          componentHint: el.getAttribute("data-component") || el.tagName.toLowerCase(),
          boundingBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          viewport: { width: window.innerWidth, height: window.innerHeight }
        }
      }, "*");
    }, true);
  </script>`;

function documentOf(theme: PreviewTheme, styles: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${baseStyles(theme)}
${styles}
</style>
</head>
<body>
${body}
${INSPECTOR_SCRIPT}
</body>
</html>`;
}

function websitePreview(theme: PreviewTheme, brief: string | undefined): string {
	const headline =
		theme.applied === 0
			? `${theme.name} — built clearly, shipped continuously.`
			: theme.dark
				? `${theme.name} — calm focus, designed for quiet evenings.`
				: theme.hasPricing
					? `${theme.name} — simple pricing for early adopters.`
					: theme.hasBrandSync
						? `${theme.name} — warm Nordic craft, aligned end to end.`
						: `${theme.name} — refined for clarity and speed.`;
	const lead =
		theme.applied > 0
			? theme.notes ||
				`Previewing ${theme.applied} active change${theme.applied === 1 ? "" : "s"} on ${theme.title}.`
			: brief
				? escapeHtml(brief)
				: `Live baseline for ${theme.title}. Describe a change in the floating composer below or press P to point at any block.`;
	const card = (title: string, copy: string, price: string) =>
		`<article class="card" data-component="HighlightCard"><h3>${title}</h3><p>${copy}</p>${theme.hasPricing ? `<div class="price">${price}</div>` : ""}</article>`;
	return documentOf(
		theme,
		`
  body { padding: 28px 24px 120px; }
  .shell { max-width: 900px; margin: 0 auto; display: grid; gap: 28px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 18px; border-bottom: 1px solid ${theme.border}; }
  .brand { font-size: 16px; font-weight: 700; letter-spacing: -0.02em; display: flex; align-items: center; gap: 10px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: ${theme.accent}; }
  .hero { display: grid; gap: 16px; padding: 36px 32px; border-radius: 22px; background: ${theme.card}; border: 1px solid ${theme.border}; box-shadow: 0 12px 36px -20px rgba(0,0,0,0.22); }
  .eyebrow { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${theme.pillInk}; }
  h1 { font-size: clamp(28px, 4.4vw, 44px); line-height: 1.08; letter-spacing: -0.03em; font-weight: 750; max-width: 20ch; }
  .lead { font-size: 16px; color: ${theme.muted}; max-width: 58ch; }
  .cta-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
  .card { padding: 20px; border-radius: 16px; background: ${theme.card}; border: 1px solid ${theme.border}; display: grid; gap: 6px; }
  .card h3 { font-size: 15px; font-weight: 650; }
  .card p { font-size: 13.5px; color: ${theme.muted}; }
  .price { font-size: 24px; font-weight: 750; color: ${theme.pillInk}; margin-top: 4px; }`,
		`  <div class="shell">
    <header data-component="SiteHeader">
      <div class="brand"><span class="dot"></span>${theme.name}</div>
      <span class="status">${escapeHtml(theme.modeLabel)}</span>
    </header>
    <section class="hero" data-component="HeroSection">
      <span class="eyebrow">${theme.title}</span>
      <h1 data-component="HeroHeadline">${headline}</h1>
      <p class="lead" data-component="HeroSubcopy">${lead}</p>
      ${theme.badges ? `<div class="pills">${theme.badges}</div>` : ""}
      <div class="cta-row">
        <button class="cta" type="button" data-component="PrimaryCta">Get started</button>
        <button class="cta ghost" type="button" data-component="SecondaryCta">See how it works</button>
      </div>
    </section>
    <section class="grid" data-component="${theme.hasPricing ? "PricingGrid" : "FeatureGrid"}">
      ${card(theme.hasPricing ? "Starter" : "Calm craft", theme.hasPricing ? "Everything needed for early adopters and pilot customers." : "Designed for clarity from first visit to checkout.", "1.495 kr.")}
      ${card(theme.hasPricing ? "Complete" : "Live iteration", theme.hasPricing ? "Full hardware &amp; app bundle with direct founder support." : "Every session previews on the real surface before publishing.", "1.995 kr.")}
      ${card(theme.hasPricing ? "Team" : "Always in sync", theme.hasPricing ? "Volume pricing and priority onboarding for studios." : "Brand tokens, copy, and live site stay connected.", "4.900 kr.")}
    </section>
  </div>`,
	);
}

function webAppPreview(theme: PreviewTheme): string {
	return documentOf(
		theme,
		`
  body { height: 100vh; display: grid; grid-template-columns: 220px 1fr; }
  aside { padding: 22px 14px; border-right: 1px solid ${theme.border}; background: ${theme.card}; display: grid; align-content: start; gap: 4px; }
  .logo { display: flex; align-items: center; gap: 9px; padding: 4px 10px 18px; font-weight: 700; letter-spacing: -0.02em; }
  .logo i { width: 22px; height: 22px; border-radius: 7px; background: ${theme.accent}; }
  nav a { display: block; padding: 8px 10px; border-radius: 9px; color: ${theme.muted}; font-size: 13.5px; font-weight: 550; text-decoration: none; }
  nav a.on { background: ${theme.pillBg}; color: ${theme.pillInk}; font-weight: 650; }
  main { padding: 26px 30px 120px; display: grid; align-content: start; gap: 20px; overflow: auto; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h1 { font-size: 24px; letter-spacing: -0.02em; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .card { padding: 16px 18px; border-radius: 14px; background: ${theme.card}; border: 1px solid ${theme.border}; }
  .card small { color: ${theme.muted}; font-size: 12px; font-weight: 600; }
  .card strong { display: block; margin-top: 4px; font-size: 24px; letter-spacing: -0.02em; }
  table { width: 100%; border-collapse: collapse; background: ${theme.card}; border: 1px solid ${theme.border}; border-radius: 14px; overflow: hidden; font-size: 13.5px; }
  th, td { padding: 11px 14px; text-align: left; border-bottom: 1px solid ${theme.border}; }
  th { color: ${theme.muted}; font-size: 12px; font-weight: 650; }
  .tag { padding: 2px 8px; border-radius: 999px; background: ${theme.pillBg}; color: ${theme.pillInk}; font-size: 11.5px; font-weight: 650; }`,
		`  <aside data-component="AppSidebar">
    <div class="logo"><i></i>${theme.name}</div>
    <nav>
      <a class="on" href="#" data-component="NavOverview">Overview</a>
      <a href="#" data-component="NavCustomers">Customers</a>
      <a href="#" data-component="NavProjects">Projects</a>
      <a href="#" data-component="NavSettings">Settings</a>
    </nav>
  </aside>
  <main>
    <div class="top" data-component="AppHeader">
      <h1 data-component="PageTitle">${theme.title}</h1>
      <span class="status">${escapeHtml(theme.modeLabel)}</span>
    </div>
    ${theme.badges ? `<div class="pills">${theme.badges}</div>` : ""}
    <section class="cards" data-component="StatCards">
      <div class="card"><small>Active users</small><strong>1.284</strong></div>
      <div class="card"><small>Open projects</small><strong>36</strong></div>
      <div class="card"><small>Satisfaction</small><strong>4.8</strong></div>
    </section>
    <table data-component="ActivityTable">
      <thead><tr><th>Customer</th><th>Project</th><th>Status</th></tr></thead>
      <tbody>
        <tr><td>Mette Holm</td><td>Onboarding</td><td><span class="tag">Live</span></td></tr>
        <tr><td>Lina Berg</td><td>Team rollout</td><td><span class="tag">In review</span></td></tr>
        <tr><td>Asger Sønder</td><td>Pilot</td><td><span class="tag">Starting</span></td></tr>
      </tbody>
    </table>
    <button class="cta" type="button" data-component="PrimaryAction">New project</button>
  </main>`,
	);
}

function mobileAppPreview(theme: PreviewTheme): string {
	return documentOf(
		theme,
		`
  body { min-height: 100vh; display: flex; justify-content: center; background: ${theme.dark ? theme.bg : "#f3f2ef"}; }
  .app { position: relative; width: 100%; max-width: 420px; min-height: 100vh; background: ${theme.bg}; display: flex; flex-direction: column; }
  .statusbar { display: flex; justify-content: space-between; padding: 14px 26px 6px; font-size: 13px; font-weight: 650; }
  .bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 22px 6px; }
  .bar h1 { font-size: 28px; letter-spacing: -0.03em; }
  .avatar { width: 34px; height: 34px; border-radius: 50%; background: ${theme.pillBg}; color: ${theme.pillInk}; display: grid; place-items: center; font-weight: 700; font-size: 13px; }
  .content { flex: 1; padding: 10px 18px 120px; display: grid; align-content: start; gap: 14px; }
  .hero { padding: 20px; border-radius: 24px; background: ${theme.accent}; color: ${theme.ctaInk}; display: grid; gap: 6px; }
  .hero small { opacity: .8; font-weight: 600; font-size: 12px; }
  .hero strong { font-size: 30px; letter-spacing: -0.03em; }
  .hero p { opacity: .85; font-size: 13px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 14px; border-radius: 18px; background: ${theme.card}; border: 1px solid ${theme.border}; }
  .row i { width: 40px; height: 40px; border-radius: 13px; background: ${theme.pillBg}; flex: none; }
  .row div { flex: 1; min-width: 0; }
  .row b { display: block; font-size: 14.5px; }
  .row span { color: ${theme.muted}; font-size: 12.5px; }
  .tabs { position: sticky; bottom: 0; display: flex; justify-content: space-around; padding: 10px 10px 26px; border-top: 1px solid ${theme.border}; background: ${theme.card}; }
  .tabs a { display: grid; justify-items: center; gap: 4px; color: ${theme.muted}; font-size: 11px; font-weight: 600; text-decoration: none; }
  .tabs a i { width: 22px; height: 22px; border-radius: 7px; background: currentColor; opacity: .35; }
  .tabs a.on { color: ${theme.pillInk}; }
  .tabs a.on i { opacity: 1; }`,
		`  <div class="app">
    <div class="statusbar"><span>9:41</span><span>●●● ▮</span></div>
    <div class="bar" data-component="AppBar">
      <h1 data-component="ScreenTitle">${theme.name}</h1>
      <span class="avatar">${theme.name.slice(0, 1)}</span>
    </div>
    <div class="content">
      ${theme.badges ? `<div class="pills">${theme.badges}</div>` : ""}
      <section class="hero" data-component="TodayCard">
        <small>Today</small>
        <strong>${theme.hasPricing ? "1.995 kr." : "12 min"}</strong>
        <p>${theme.notes || (theme.hasPricing ? "Your plan renews in 9 days." : "A calm session to start your evening.")}</p>
      </section>
      <div class="row" data-component="ListItem"><i></i><div><b>Morning routine</b><span>5 steps · 8 min</span></div></div>
      <div class="row" data-component="ListItem"><i></i><div><b>Focus timer</b><span>Last used yesterday</span></div></div>
      <div class="row" data-component="ListItem"><i></i><div><b>Weekly progress</b><span>4 of 5 days</span></div></div>
      <button class="cta" type="button" data-component="PrimaryAction">Start session</button>
    </div>
    <nav class="tabs" data-component="TabBar">
      <a class="on" href="#"><i></i>Home</a>
      <a href="#"><i></i>Explore</a>
      <a href="#"><i></i>Progress</a>
      <a href="#"><i></i>Profile</a>
    </nav>
  </div>`,
	);
}

function desktopAppPreview(theme: PreviewTheme): string {
	return documentOf(
		theme,
		`
  body { min-height: 100vh; padding: 34px 32px 120px; background: ${theme.dark ? "#0d0d0c" : "linear-gradient(160deg, #dfe4ea, #eceae5)"}; }
  .window { max-width: 980px; margin: 0 auto; border-radius: 14px; overflow: hidden; background: ${theme.bg}; border: 1px solid ${theme.border}; box-shadow: 0 28px 70px -24px rgba(0,0,0,.4), 0 0 0 .5px rgba(0,0,0,.12); }
  .titlebar { position: relative; display: flex; align-items: center; height: 40px; padding: 0 14px; border-bottom: 1px solid ${theme.border}; background: ${theme.card}; }
  .lights { display: flex; gap: 8px; }
  .lights i { width: 12px; height: 12px; border-radius: 50%; }
  .lights i:nth-child(1) { background: #ff5f57; } .lights i:nth-child(2) { background: #febc2e; } .lights i:nth-child(3) { background: #28c840; }
  .titlebar strong { position: absolute; left: 50%; transform: translateX(-50%); font-size: 13px; font-weight: 650; color: ${theme.muted}; }
  .body { display: grid; grid-template-columns: 200px 1fr; min-height: 460px; }
  aside { padding: 14px 10px; border-right: 1px solid ${theme.border}; background: ${theme.dark ? "#181817" : "#f4f3f0"}; display: grid; align-content: start; gap: 2px; }
  aside small { padding: 8px 10px 4px; color: ${theme.muted}; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  aside a { padding: 6px 10px; border-radius: 7px; font-size: 13px; color: ${theme.ink}; text-decoration: none; }
  aside a.on { background: ${theme.pillBg}; color: ${theme.pillInk}; font-weight: 650; }
  main { padding: 22px 26px; display: grid; align-content: start; gap: 16px; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  h1 { font-size: 22px; letter-spacing: -0.02em; }
  .doc { padding: 18px 20px; border-radius: 12px; background: ${theme.card}; border: 1px solid ${theme.border}; display: grid; gap: 8px; }
  .doc p { color: ${theme.muted}; font-size: 13.5px; }
  .line { height: 9px; border-radius: 5px; background: ${theme.border}; }
  .w92 { width: 92%; } .w78 { width: 78%; } .w64 { width: 64%; }`,
		`  <div class="window" data-component="AppWindow">
    <div class="titlebar" data-component="TitleBar"><span class="lights"><i></i><i></i><i></i></span><strong>${theme.title}</strong></div>
    <div class="body">
      <aside data-component="Sidebar">
        <small>Library</small>
        <a class="on" href="#">All documents</a>
        <a href="#">Recent</a>
        <a href="#">Shared</a>
        <small>Workspace</small>
        <a href="#">${theme.name}</a>
      </aside>
      <main>
        <div class="toolbar" data-component="Toolbar">
          <h1 data-component="DocumentTitle">All documents</h1>
          <span class="status">${escapeHtml(theme.modeLabel)}</span>
        </div>
        ${theme.badges ? `<div class="pills">${theme.badges}</div>` : ""}
        <article class="doc" data-component="DocumentCard">
          <strong>Quarterly plan</strong>
          <p>${theme.notes || "Edited 2 hours ago · synced across devices"}</p>
          <div class="line w92"></div><div class="line w78"></div><div class="line w64"></div>
        </article>
        <div><button class="cta" type="button" data-component="PrimaryAction">New document</button></div>
      </main>
    </div>
  </div>`,
	);
}

function dashboardPreview(theme: PreviewTheme): string {
	const cash = [42, 44, 43, 47, 49, 48, 52, 55, 54, 58, 61, 64];
	const max = Math.max(...cash);
	const points = cash.map((value, index) => `${(index / (cash.length - 1)) * 600},${170 - (value / max) * 150}`);
	const line = `M${points.join(" L")}`;
	return documentOf(
		theme,
		`
  body { padding: 28px 28px 120px; }
  .shell { max-width: 1040px; margin: 0 auto; display: grid; gap: 18px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h1 { font-size: 24px; letter-spacing: -0.02em; }
  header p { color: ${theme.muted}; font-size: 13px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
  .kpi { padding: 16px 18px; border-radius: 16px; background: ${theme.card}; border: 1px solid ${theme.border}; display: grid; gap: 4px; }
  .kpi small { color: ${theme.muted}; font-size: 12px; font-weight: 650; }
  .kpi strong { font-size: 26px; letter-spacing: -0.03em; }
  .up { color: #12a467; font-size: 12px; font-weight: 650; } .down { color: #dc3545; font-size: 12px; font-weight: 650; }
  .panel { padding: 18px 20px; border-radius: 16px; background: ${theme.card}; border: 1px solid ${theme.border}; display: grid; gap: 12px; }
  .panel h2 { font-size: 15px; }
  svg { width: 100%; height: 190px; display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; font-variant-numeric: tabular-nums; }
  td, th { padding: 9px 4px; border-bottom: 1px solid ${theme.border}; text-align: right; }
  td:first-child, th:first-child { text-align: left; }
  th { color: ${theme.muted}; font-size: 12px; font-weight: 650; }`,
		`  <div class="shell">
    <header data-component="DashboardHeader">
      <div><h1 data-component="DashboardTitle">${theme.title}</h1><p>${theme.name} · ${escapeHtml(theme.modeLabel)}</p></div>
      ${theme.badges ? `<div class="pills">${theme.badges}</div>` : ""}
    </header>
    <section class="kpis" data-component="KpiRow">
      <div class="kpi" data-component="KpiMrr"><small>MRR</small><strong>184.200 kr.</strong><span class="up">+8,4% this month</span></div>
      <div class="kpi" data-component="KpiRunway"><small>Runway</small><strong>19 months</strong><span class="up">+2 since Q2</span></div>
      <div class="kpi" data-component="KpiCash"><small>Cash</small><strong>2,41 mio. kr.</strong><span class="up">+132.000 kr.</span></div>
      <div class="kpi" data-component="KpiBurn"><small>Net burn</small><strong>126.000 kr.</strong><span class="down">+3,1%</span></div>
    </section>
    <section class="panel" data-component="CashflowChart">
      <h2>Cashflow · last 12 months</h2>
      <svg viewBox="0 0 600 180" preserveAspectRatio="none" aria-hidden="true">
        <path d="${line} L600,180 L0,180 Z" fill="${theme.accent}" fill-opacity="0.12"></path>
        <path d="${line}" fill="none" stroke="${theme.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    </section>
    <section class="panel" data-component="ProfitAndLoss">
      <h2>Profit &amp; loss</h2>
      <table>
        <thead><tr><th>Line</th><th>This month</th><th>Last month</th></tr></thead>
        <tbody>
          <tr><td>Revenue</td><td>231.400 kr.</td><td>214.900 kr.</td></tr>
          <tr><td>Cost of goods</td><td>−61.200 kr.</td><td>−58.100 kr.</td></tr>
          <tr><td>Operating costs</td><td>−148.900 kr.</td><td>−143.300 kr.</td></tr>
          <tr><td><b>Net</b></td><td><b>21.300 kr.</b></td><td><b>13.500 kr.</b></td></tr>
        </tbody>
      </table>
    </section>
  </div>`,
	);
}

// WHY: Renders a real interactive preview document for local dev live_build surfaces before cloud migrations deploy.
export function renderLocalSitePreviewHtml(
	companyName: string,
	surface: SurfaceSummary,
	appliedChanges: readonly SurfaceChangeUnit[],
	mode: "live" | "preview",
	kind: SurfaceKind = "website",
	brief?: string,
	accent?: string,
): string {
	const baseAccent = accent ?? (kind === "website" ? "#1d1d1b" : kind === "dashboard" ? "#12a467" : "#4f5bd5");
	const theme = previewTheme(companyName, surface, appliedChanges, mode, baseAccent);
	switch (kind) {
		case "web_app":
			return webAppPreview(theme);
		case "mobile_app":
			return mobileAppPreview(theme);
		case "desktop_app":
			return desktopAppPreview(theme);
		case "dashboard":
			return dashboardPreview(theme);
		default:
			return websitePreview(theme, brief ?? undefined);
	}
}
