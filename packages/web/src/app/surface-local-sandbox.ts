import {
	type StudioPatchOp,
	SURFACE_INSPECTOR_MODE_MESSAGE,
	SURFACE_INSPECTOR_PICK_MESSAGE,
	type SurfaceChangeUnit,
	type SurfaceSummary,
} from "@qorpera/contracts";

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

export function starterStudioFiles(
	surface: Pick<SurfaceSummary, "slug" | "title" | "folderRoot">,
	companyName: string,
): Record<string, string> {
	const root = (surface.folderRoot || surface.slug || "studio").replace(/^\/+|\/+$/g, "");
	const name = companyName.trim() || "Company";
	if (surface.slug.includes("product") || surface.slug.includes("hardware") || surface.slug.includes("spec")) {
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
			[`${root}/brief.md`]: `# ${surface.title}\n\nBuilt for **${name}** with calm industrial craft, clear pricing, and zero clutter.\n`,
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

export function synthesizeLocalChanges(
	surface: SurfaceSummary,
	sessionId: string,
	prompt: string,
	nextId: () => string,
	companyName: string,
): LocalStagedChangePlan {
	const now = new Date().toISOString();
	const root = (surface.folderRoot || surface.slug || "studio").replace(/^\/+|\/+$/g, "");
	const pickedColor = ACCENT_PALETTE.find((entry) => entry.match.test(prompt)) ?? ACCENT_PALETTE[0]!;
	const parts = splitMultiPrompt(prompt);

	if (surface.archetype === "studio") {
		const isSpec =
			surface.slug.includes("product") || surface.slug.includes("hardware") || surface.slug.includes("spec");
		const firstId = nextId();
		const secondId = nextId();
		const firstTitle =
			parts?.[0] ?? (isSpec ? `Refine ${surface.title} colorways` : `${pickedColor.name} accent & palette`);
		const secondTitle = parts?.[1] ?? (isSpec ? "Tighten product brief" : "Refine typography & voice");
		const firstPath = isSpec ? `${root}/specs.json` : `${root}/tokens.json`;
		const secondPath = isSpec ? `${root}/brief.md` : `${root}/voice.md`;
		const changes: SurfaceChangeUnit[] = [
			{
				id: firstId,
				sessionId,
				surfaceId: surface.id,
				seq: 1,
				kind: "folder_patch",
				title: firstTitle,
				summary: `Updated ${firstPath} based on “${summarizeTitle(prompt, surface.title)}”.`,
				status: "staged",
				parentSha: null,
				headSha: null,
				dependsOnChangeIds: [],
				diffStats: { filesChanged: 1, additions: 4, deletions: 2 },
				affectedPaths: [firstPath],
				conflictPaths: null,
				landedChangeNumber: null,
				canUndo: false,
				createdAt: now,
				resolvedAt: null,
			},
			{
				id: secondId,
				sessionId,
				surfaceId: surface.id,
				seq: 2,
				kind: "folder_patch",
				title: secondTitle,
				summary: `Updated ${secondPath} so copy stays aligned across ${companyName || "the company"}.`,
				status: "staged",
				parentSha: null,
				headSha: null,
				dependsOnChangeIds: [],
				diffStats: { filesChanged: 1, additions: 3, deletions: 1 },
				affectedPaths: [secondPath],
				conflictPaths: null,
				landedChangeNumber: null,
				canUndo: false,
				createdAt: now,
				resolvedAt: null,
			},
		];
		const studioPatches: Record<string, readonly StudioPatchOp[]> = isSpec
			? {
					[firstId]: [
						{
							op: "merge_json",
							path: firstPath,
							patch: { overview: { status: "Ready for pilot" } },
						},
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
							patch: {
								colors: { accent: pickedColor.hex, surface: "#f3efe8" },
							},
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
	const kind: SurfaceChangeUnit["kind"] = surface.archetype === "ops" ? "ops_action" : "git_range";
	const changes: SurfaceChangeUnit[] = [
		{
			id: firstId,
			sessionId,
			surfaceId: surface.id,
			seq: 1,
			kind,
			title: primaryTitle,
			summary: `Applied “${summarizeTitle(prompt, surface.title)}” on the ${surface.title} surface.`,
			status: "staged",
			parentSha: null,
			headSha: null,
			dependsOnChangeIds: [],
			diffStats: { filesChanged: 2, additions: 38, deletions: 12 },
			affectedPaths: ["src/sections/Hero.tsx", "src/styles/theme.css"],
			conflictPaths: null,
			landedChangeNumber: null,
			canUndo: false,
			createdAt: now,
			resolvedAt: null,
		},
		...(parts || prompt.trim().length >= 24
			? [
					{
						id: secondId,
						sessionId,
						surfaceId: surface.id,
						seq: 2,
						kind,
						title: secondaryTitle,
						summary: "Adjusted type scale, CTA contrast, and mobile viewport layout.",
						status: "staged" as const,
						parentSha: null,
						headSha: null,
						dependsOnChangeIds: [],
						diffStats: { filesChanged: 1, additions: 19, deletions: 6 },
						affectedPaths: ["src/styles/layout.css"],
						conflictPaths: null,
						landedChangeNumber: null,
						canUndo: false,
						createdAt: now,
						resolvedAt: null,
					},
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

// WHY: Renders a real interactive preview document for local dev live_build surfaces before cloud migrations deploy.
export function renderLocalSitePreviewHtml(
	companyName: string,
	surface: SurfaceSummary,
	appliedChanges: readonly SurfaceChangeUnit[],
	mode: "live" | "preview",
): string {
	const name = escapeHtml(companyName || surface.title);
	const title = escapeHtml(surface.title);
	const joined = appliedChanges.map((change) => `${change.title} ${change.summary}`).join(" ");
	const hasPricing = /pric|plan|tier|cost|kr\.|eur|\$/i.test(joined);
	const hasDark = /\bdark\b|night|evening|aften/i.test(joined);
	const hasBrandSync = /brand|token|voice|palette|terracotta/i.test(joined);
	const matchedPalette = ACCENT_PALETTE.find(
		(entry) => entry.match.test(joined) && !(hasDark && entry.hex === "#232321"),
	);
	const accent =
		appliedChanges.length > 0
			? hasDark
				? (matchedPalette?.hex ?? "#e8a85a")
				: (matchedPalette?.hex ?? "#c65d3b")
			: "#1d1d1b";
	const ctaInk = hasDark && accent === "#e8a85a" ? "#151514" : "#ffffff";
	const bg = hasDark ? "#131312" : "#faf9f6";
	const cardBg = hasDark ? "#1d1d1b" : "#ffffff";
	const ink = hasDark ? "#f5f4f0" : "#171715";
	const muted = hasDark ? "#b8b5ad" : "#62615c";
	const border = hasDark ? "rgba(255,255,255,0.14)" : "rgba(23,23,21,0.10)";
	const pillBg = hasDark ? "rgba(232,168,90,0.18)" : `color-mix(in srgb, ${accent} 13%, transparent)`;
	const pillInk = hasDark ? "#f4c27f" : accent;
	const heroHeadline =
		appliedChanges.length === 0
			? `${name} — built clearly, shipped continuously.`
			: hasDark
				? `${name} — calm focus, designed for quiet evenings.`
				: hasPricing
					? `${name} — simple pricing for early adopters.`
					: hasBrandSync
						? `${name} — warm Nordic craft, aligned end to end.`
						: `${name} — refined for clarity and speed.`;
	const uniqueNotes = [...new Set(appliedChanges.map((change) => change.summary.trim()).filter(Boolean))].slice(0, 2);
	const heroCopy =
		appliedChanges.length > 0
			? escapeHtml(
					uniqueNotes.join(" ") ||
						`Previewing ${appliedChanges.length} active change${appliedChanges.length === 1 ? "" : "s"} on ${surface.title}.`,
				)
			: `Live baseline for ${title}. Describe a change in the floating composer below or press P to point at any block.`;
	const badges = appliedChanges
		.map((change) => `<span class="pill" data-component="ChangeBadge">${escapeHtml(change.title)}</span>`)
		.join("");
	const modeLabel =
		mode === "live"
			? "Live baseline"
			: appliedChanges.length === 0
				? "Preview · matches Base"
				: `Preview · ${appliedChanges.length} change${appliedChanges.length === 1 ? "" : "s"} active`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: ${bg}; color: ${ink}; line-height: 1.5; padding: 28px 24px 120px; transition: background .2s ease, color .2s ease; }
  .shell { max-width: 900px; margin: 0 auto; display: grid; gap: 28px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 18px; border-bottom: 1px solid ${border}; }
  .brand { font-size: 16px; font-weight: 700; letter-spacing: -0.02em; display: flex; align-items: center; gap: 10px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: ${accent}; }
  .status { font-size: 12px; font-weight: 600; color: ${muted}; padding: 4px 10px; border-radius: 999px; border: 1px solid ${border}; }
  .hero { display: grid; gap: 16px; padding: 36px 32px; border-radius: 22px; background: ${cardBg}; border: 1px solid ${border}; box-shadow: 0 12px 36px -20px rgba(0,0,0,0.22); }
  .eyebrow { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${pillInk}; }
  h1 { font-size: clamp(28px, 4.4vw, 44px); line-height: 1.08; letter-spacing: -0.03em; font-weight: 750; max-width: 20ch; color: ${ink}; }
  .lead { font-size: 16px; color: ${muted}; max-width: 58ch; }
  .cta-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
  .cta { display: inline-flex; align-items: center; height: 42px; padding: 0 20px; border-radius: 999px; border: 0; background: ${accent}; color: ${ctaInk}; font-weight: 650; font-size: 14px; cursor: pointer; }
  .cta.ghost { background: transparent; color: ${ink}; border: 1px solid ${border}; }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; }
  .pill { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; background: ${pillBg}; color: ${pillInk}; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
  .card { padding: 20px; border-radius: 16px; background: ${cardBg}; border: 1px solid ${border}; display: grid; gap: 6px; }
  .card h3 { font-size: 15px; font-weight: 650; color: ${ink}; }
  .card p { font-size: 13.5px; color: ${muted}; }
  .price { font-size: 24px; font-weight: 750; color: ${pillInk}; margin-top: 4px; }
  [data-qorpera-inspect="on"] [data-component] { cursor: crosshair !important; }
  [data-qorpera-inspect="on"] [data-component]:hover { outline: 2px solid ${accent}; outline-offset: 3px; border-radius: 10px; }
</style>
</head>
<body>
  <div class="shell">
    <header data-component="SiteHeader">
      <div class="brand"><span class="dot"></span>${name}</div>
      <span class="status">${escapeHtml(modeLabel)}</span>
    </header>
    <section class="hero" data-component="HeroSection">
      <span class="eyebrow">${title}</span>
      <h1 data-component="HeroHeadline">${heroHeadline}</h1>
      <p class="lead" data-component="HeroSubcopy">${heroCopy}</p>
      ${badges ? `<div class="pills">${badges}</div>` : ""}
      <div class="cta-row">
        <button class="cta" type="button" data-component="PrimaryCta">Get started</button>
        <button class="cta ghost" type="button" data-component="SecondaryCta">See how it works</button>
      </div>
    </section>
    <section class="grid" data-component="${hasPricing ? "PricingGrid" : "FeatureGrid"}">
      <article class="card" data-component="HighlightCard">
        <h3>${hasPricing ? "Starter" : "Calm craft"}</h3>
        <p>${hasPricing ? "Everything needed for early adopters and pilot customers." : "Designed for clarity from first visit to checkout."}</p>
        ${hasPricing ? `<div class="price">1.495 kr.</div>` : ""}
      </article>
      <article class="card" data-component="HighlightCard">
        <h3>${hasPricing ? "Complete" : "Live iteration"}</h3>
        <p>${hasPricing ? "Full hardware & app bundle with direct founder support." : "Every session previews on the real surface before publishing."}</p>
        ${hasPricing ? `<div class="price">1.995 kr.</div>` : ""}
      </article>
      <article class="card" data-component="HighlightCard">
        <h3>${hasPricing ? "Team" : "Always in sync"}</h3>
        <p>${hasPricing ? "Volume pricing and priority onboarding for studios." : "Brand tokens, copy, and live site stay connected."}</p>
        ${hasPricing ? `<div class="price">4.900 kr.</div>` : ""}
      </article>
    </section>
  </div>
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
  </script>
</body>
</html>`;
}
