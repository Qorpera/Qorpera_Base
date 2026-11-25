import { h } from "../../ui/dom.ts";

const HUES = 6;
const SHADES = [100, 74, 52] as const;
const SMALL_SHARE = 0.12;
const EMPTY_SHARE = 0.09;
const FALLBACK_BOX = { x: 0, y: 0, w: 1200, h: 800 } as const;

export interface DataBox {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

export interface DataGroupMember {
	readonly name: string;
	readonly short: string;
}

export interface DataGroup {
	readonly title: string;
	readonly members: readonly DataGroupMember[];
}

export interface DataField {
	readonly name: string;
	readonly title: string;
	readonly rows: number | undefined;
	readonly count: string | undefined;
}

interface LaidGroup {
	readonly el: HTMLElement;
	readonly weight: number;
	readonly slots: readonly HTMLElement[];
	readonly weights: readonly number[];
}

const firstWord = (words: string) => words.split(" ", 1)[0] ?? words;

const capital = (words: string) => (words ? words.charAt(0).toLocaleUpperCase() + words.slice(1) : words);

export function dataGroups(names: readonly string[], human: (name: string) => string): DataGroup[] {
	const shared = new Map<string, number>();
	for (const name of names) {
		const word = firstWord(human(name)).toLocaleLowerCase();
		shared.set(word, (shared.get(word) ?? 0) + 1);
	}
	const groups: { title: string; members: DataGroupMember[] }[] = [];
	const byWord = new Map<string, { title: string; members: DataGroupMember[] }>();
	for (const name of names) {
		const words = human(name);
		const word = firstWord(words);
		const key = word.toLocaleLowerCase();
		if ((shared.get(key) ?? 0) < 2) {
			groups.push({ title: words, members: [{ name, short: words }] });
			continue;
		}
		let group = byWord.get(key);
		if (!group) {
			group = { title: capital(word), members: [] };
			byWord.set(key, group);
			groups.push(group);
		}
		group.members.push({ name, short: capital(words.slice(word.length).trim()) || words });
	}
	return groups;
}

export function fieldWeights(rows: readonly (number | undefined)[]): number[] {
	const roots = rows.map((count) => Math.sqrt(Math.max(count ?? 0, 0)));
	const top = Math.max(1, ...roots);
	return rows.map((count, index) => (count === 0 ? top * EMPTY_SHARE : Math.max(roots[index] ?? 0, top * SMALL_SHARE)));
}

export function squarify(weights: readonly number[], box: DataBox): DataBox[] {
	const out: DataBox[] = [];
	let { x, y, w, h: tall } = box;
	let rest = weights.reduce((sum, one) => sum + one, 0);
	let start = 0;
	while (start < weights.length && rest > 0 && w > 0 && tall > 0) {
		const area = w * tall;
		const short = Math.min(w, tall);
		let end = start;
		let rowSum = 0;
		let worst = Number.POSITIVE_INFINITY;
		while (end < weights.length) {
			const sum = rowSum + (weights[end] ?? 0);
			const thick = ((sum / rest) * area) / short;
			let ratio = 0;
			for (let index = start; index <= end; index++) {
				const long = ((weights[index] ?? 0) / sum) * short;
				ratio = Math.max(ratio, thick / long, long / thick);
			}
			if (ratio > worst) break;
			worst = ratio;
			rowSum = sum;
			end++;
		}
		const thick = ((rowSum / rest) * area) / short;
		let at = 0;
		for (let index = start; index < end; index++) {
			const long = ((weights[index] ?? 0) / rowSum) * short;
			out.push(w >= tall ? { x, y: y + at, w: thick, h: long } : { x: x + at, y, w: long, h: thick });
			at += long;
		}
		if (w >= tall) {
			x += thick;
			w -= thick;
		} else {
			y += thick;
			tall -= thick;
		}
		rest -= rowSum;
		start = end;
	}
	return out;
}

const place = (el: HTMLElement, box: DataBox, within: DataBox) => {
	el.style.setProperty("--plot-x", `${((box.x - within.x) / within.w) * 100}%`);
	el.style.setProperty("--plot-y", `${((box.y - within.y) / within.h) * 100}%`);
	el.style.setProperty("--plot-w", `${(box.w / within.w) * 100}%`);
	el.style.setProperty("--plot-h", `${(box.h / within.h) * 100}%`);
};

export class DataHome {
	readonly el = h("div", { class: "data-plots" });
	readonly #resized: ResizeObserver | undefined;
	#laid: LaidGroup[] = [];

	constructor() {
		this.#resized = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.#layout()) : undefined;
		this.#resized?.observe(this.el);
	}

	dispose(): void {
		this.#resized?.disconnect();
	}

	show(groups: readonly DataGroup[], fields: ReadonlyMap<string, DataField>, pick: (name: string) => void): void {
		const all = groups.flatMap((group) => group.members.map((member) => fields.get(member.name)));
		const weights = fieldWeights(all.map((field) => field?.rows));
		let at = 0;
		const ranked = groups
			.map((group) => {
				const members = group.members
					.map((member) => ({ field: fields.get(member.name), weight: weights[at++] ?? 0 }))
					.filter((one): one is { field: DataField; weight: number } => one.field !== undefined)
					.sort((a, b) => b.weight - a.weight);
				return { members, weight: members.reduce((sum, one) => sum + one.weight, 0) };
			})
			.filter((group) => group.members.length > 0)
			.sort((a, b) => b.weight - a.weight);
		this.#laid = ranked.map(({ members, weight }, hue) => {
			const slots = members.map(({ field }, rank) => {
				const empty = field.rows === 0;
				const button = h(
					"button",
					{
						type: "button",
						class: empty ? "data-plot is-empty" : "data-plot",
						style: `--data-hue: var(--data-hue-${hue % HUES}); --data-shade: ${SHADES[Math.min(rank, SHADES.length - 1)]}%`,
						dataset: { focusKey: `field:${field.name}`, table: field.name },
						onclick: () => pick(field.name),
					},
					h(
						"span",
						{ class: "data-plot-words" },
						h("span", { class: "data-plot-name" }, field.title),
						field.count === undefined ? null : h("span", { class: "data-plot-count" }, field.count),
					),
				);
				return h("div", { class: "data-plot-slot" }, button);
			});
			return {
				el: h("div", { class: "data-plot-group" }, h("div", { class: "data-plot-group-in" }, ...slots)),
				weight,
				slots,
				weights: members.map((one) => one.weight),
			};
		});
		this.el.replaceChildren(...this.#laid.map((group) => group.el));
		this.#layout();
	}

	#layout(): void {
		const box =
			this.el.clientWidth > 0 && this.el.clientHeight > 0
				? { x: 0, y: 0, w: this.el.clientWidth, h: this.el.clientHeight }
				: FALLBACK_BOX;
		const boxes = squarify(
			this.#laid.map((group) => group.weight),
			box,
		);
		this.#laid.forEach((group, index) => {
			const mine = boxes[index];
			if (!mine) return;
			place(group.el, mine, box);
			squarify(group.weights, mine).forEach((slot, at) => {
				const el = group.slots[at];
				if (el) place(el, slot, mine);
			});
		});
	}
}
