export const STUDIO_TOUR_PATH = "tour.json";

export const STUDIO_TOUR_EFFECTS = ["spotlight", "pulse", "glow", "pan"] as const;
export type StudioTourEffect = (typeof STUDIO_TOUR_EFFECTS)[number];

export interface StudioTourAction {
	readonly scenario?: string;
	readonly view?: string;
	readonly expand?: string;
	readonly select?: string;
}

export interface StudioTourBeat {
	readonly id: string;
	readonly label?: string;
	readonly tab?: string;
	readonly focus?: string;
	readonly effect: StudioTourEffect;
	readonly action?: StudioTourAction;
	readonly say: string | Readonly<Record<string, string>>;
}

export interface StudioTourDocument {
	readonly title?: string;
	readonly summary?: string;
	readonly beats: readonly StudioTourBeat[];
}

export const STUDIO_TOUR_FORMAT =
	'A guided voice walkthrough (`tour.json`) is {"title","summary","beats":[{"id","label","tab","focus","effect":"spotlight"|"pulse"|"glow"|"pan","action":{"scenario","view","expand","select"},"say":"..." or {"en":"...","da":"..."}}]}. `focus` targets any block (`block:<id>`), play (`play:<id>`), rival (`rival:<id>`), hypothesis (`hypothesis:<id>`), economics zone (`econ:scenarios`, `econ:hero`, `econ:visual`, `econ:levers`), `plays:verdict`, `landscape:wedge`, `landscape:map`, `hypotheses:track`, or custom `data-tour-id`. `action.view` takes `flow`, `waterfall` or `curve`. Call `narrate_explainer` with `scenesPath: "tour.json"` to synthesize spoken audio clips for every beat.';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asEffect(value: unknown): StudioTourEffect {
	if (value === "spotlight" || value === "pulse" || value === "glow" || value === "pan") return value;
	return "spotlight";
}

function parseSay(value: unknown): string | Readonly<Record<string, string>> | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : null;
	}
	if (!isPlainRecord(value)) return null;
	const out: Record<string, string> = {};
	for (const [lang, raw] of Object.entries(value)) {
		const key = lang.trim().toLowerCase();
		const text = asText(raw);
		if (key && text) out[key] = text;
	}
	return Object.keys(out).length > 0 ? out : null;
}

function parseAction(value: unknown): StudioTourAction | undefined {
	if (!isPlainRecord(value)) return undefined;
	const scenario = asText(value.scenario);
	const view = asText(value.view);
	const expand = asText(value.expand);
	const select = asText(value.select);
	if (!scenario && !view && !expand && !select) return undefined;
	return {
		...(scenario ? { scenario } : {}),
		...(view ? { view } : {}),
		...(expand ? { expand } : {}),
		...(select ? { select } : {}),
	};
}

export function resolveTourSay(say: StudioTourBeat["say"], locale: string): string {
	if (typeof say === "string") return say;
	const exact = say[locale.toLowerCase()];
	if (exact) return exact;
	const short = say[locale.toLowerCase().slice(0, 2)];
	if (short) return short;
	return say.en ?? Object.values(say)[0] ?? "";
}

export function studioTourCaptionTexts(doc: StudioTourDocument): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (raw: string) => {
		const text = raw.trim();
		if (!text || seen.has(text)) return;
		seen.add(text);
		out.push(text);
	};
	for (const beat of doc.beats) {
		if (typeof beat.say === "string") push(beat.say);
		else for (const text of Object.values(beat.say)) push(text);
	}
	return out;
}

export function parseStudioTourDocument(value: unknown): StudioTourDocument | null {
	let parsed = value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			return null;
		}
	}
	if (!isPlainRecord(parsed) || !Array.isArray(parsed.beats)) return null;
	const beats: StudioTourBeat[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < parsed.beats.length && beats.length < 40; index += 1) {
		const raw = parsed.beats[index];
		if (!isPlainRecord(raw)) continue;
		const say = parseSay(raw.say);
		if (!say) continue;
		const baseId = asText(raw.id) ?? `beat-${index + 1}`;
		let id = baseId;
		let suffix = 2;
		while (seen.has(id)) id = `${baseId}-${suffix++}`;
		seen.add(id);
		const label = asText(raw.label);
		const tab = asText(raw.tab);
		const focus = asText(raw.focus);
		const action = parseAction(raw.action);
		beats.push({
			id,
			...(label ? { label } : {}),
			...(tab ? { tab } : {}),
			...(focus ? { focus } : {}),
			effect: asEffect(raw.effect),
			...(action ? { action } : {}),
			say,
		});
	}
	if (beats.length === 0) return null;
	const title = asText(parsed.title);
	const summary = asText(parsed.summary);
	return {
		...(title ? { title } : {}),
		...(summary ? { summary } : {}),
		beats,
	};
}
