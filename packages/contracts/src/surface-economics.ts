export const SURFACE_EPISTEMIC_TIERS = ["verified", "benchmark", "hypothesis"] as const;
export type SurfaceEpistemicTier = (typeof SURFACE_EPISTEMIC_TIERS)[number];

export interface EconomicsInputMark {
	readonly value: number;
	readonly label: string;
}

export interface EconomicsInput {
	readonly id: string;
	readonly label: string;
	readonly group?: string;
	readonly unit?: string;
	readonly value: number;
	readonly min: number;
	readonly max: number;
	readonly step?: number;
	readonly tier: SurfaceEpistemicTier;
	readonly source?: string;
	readonly note?: string;
	readonly marks?: readonly EconomicsInputMark[];
}

export interface EconomicsFormula {
	readonly id: string;
	readonly expr: string;
	readonly label?: string;
	readonly unit?: string;
}

export type EconomicsFormat = "currency" | "number" | "percent" | "hours";

export interface EconomicsHeadline {
	readonly id: string;
	readonly label: string;
	readonly unit?: string;
	readonly format?: EconomicsFormat;
	readonly emphasis?: "primary" | "secondary";
	readonly toneWhenNegative?: "danger" | "neutral";
	readonly target?: number;
}

export interface EconomicsWaterfallStep {
	readonly id: string;
	readonly label: string;
	readonly kind?: "income" | "cost" | "total";
}

export interface EconomicsConstraint {
	readonly id?: string;
	readonly label: string;
	readonly expr: string;
	readonly severity: "fatal" | "warning";
	readonly message: string;
}

export interface EconomicsCurve {
	readonly xInput: string;
	readonly yOutput: string;
	readonly xMin?: number;
	readonly xMax?: number;
	readonly steps?: number;
	readonly zeroLine?: boolean;
	readonly label?: string;
	readonly yLabel?: string;
	readonly capacityExpr?: string;
	readonly capacityLabel?: string;
}

export interface EconomicsScenario {
	readonly id: string;
	readonly name: string;
	readonly thesis?: string;
	readonly values: Readonly<Record<string, number>>;
}

export interface EconomicsDocument {
	readonly title?: string;
	readonly subtitle?: string;
	readonly currency?: string;
	readonly period?: string;
	readonly verdict?: string;
	readonly inputs: readonly EconomicsInput[];
	readonly computed: readonly EconomicsFormula[];
	readonly headlines?: readonly EconomicsHeadline[];
	readonly waterfall?: readonly EconomicsWaterfallStep[];
	readonly curve?: EconomicsCurve;
	readonly constraints?: readonly EconomicsConstraint[];
	readonly scenarios?: readonly EconomicsScenario[];
}

export interface EconomicsConstraintStatus {
	readonly constraint: EconomicsConstraint;
	readonly triggered: boolean;
}

export interface EconomicsEvaluation {
	readonly values: Readonly<Record<string, number | null>>;
	readonly constraints: readonly EconomicsConstraintStatus[];
}

export interface EconomicsCurvePoint {
	readonly x: number;
	readonly y: number | null;
}

export interface EconomicsCurveEvaluation {
	readonly points: readonly EconomicsCurvePoint[];
	readonly breakEvenX: number | null;
	readonly capacityX: number | null;
	readonly currentX: number;
	readonly currentY: number | null;
}

type Token =
	| { readonly kind: "num"; readonly value: number }
	| { readonly kind: "id"; readonly name: string }
	| { readonly kind: "op"; readonly op: string }
	| { readonly kind: "lparen" }
	| { readonly kind: "rparen" }
	| { readonly kind: "comma" };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const TWO_CHAR_OPS = new Set(["<=", ">=", "==", "!="]);
const ONE_CHAR_OPS = new Set(["+", "-", "*", "/", "<", ">"]);
const MAX_EXPR_CHARS = 512;
const MAX_TOKENS = 128;

function tokenize(expr: string): Token[] | null {
	if (expr.length === 0 || expr.length > MAX_EXPR_CHARS) return null;
	const tokens: Token[] = [];
	let index = 0;
	while (index < expr.length) {
		if (tokens.length >= MAX_TOKENS) return null;
		const ch = expr[index]!;
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			index += 1;
			continue;
		}
		if (DIGIT.test(ch) || (ch === "." && DIGIT.test(expr[index + 1] ?? ""))) {
			const start = index;
			let sawDot = false;
			while (index < expr.length) {
				const c = expr[index]!;
				if (DIGIT.test(c)) {
					index += 1;
				} else if (c === "." && !sawDot) {
					sawDot = true;
					index += 1;
				} else {
					break;
				}
			}
			const value = Number(expr.slice(start, index));
			if (!Number.isFinite(value)) return null;
			tokens.push({ kind: "num", value });
			continue;
		}
		if (IDENT_START.test(ch)) {
			const start = index;
			while (index < expr.length && IDENT_PART.test(expr[index]!)) index += 1;
			tokens.push({ kind: "id", name: expr.slice(start, index) });
			continue;
		}
		if (ch === "(") {
			tokens.push({ kind: "lparen" });
			index += 1;
			continue;
		}
		if (ch === ")") {
			tokens.push({ kind: "rparen" });
			index += 1;
			continue;
		}
		if (ch === ",") {
			tokens.push({ kind: "comma" });
			index += 1;
			continue;
		}
		const pair = expr.slice(index, index + 2);
		if (TWO_CHAR_OPS.has(pair)) {
			tokens.push({ kind: "op", op: pair });
			index += 2;
			continue;
		}
		if (ONE_CHAR_OPS.has(ch)) {
			tokens.push({ kind: "op", op: ch });
			index += 1;
			continue;
		}
		return null;
	}
	return tokens;
}

class ExpressionEvaluator {
	readonly #tokens: readonly Token[];
	readonly #scope: Readonly<Record<string, number | null | undefined>>;
	#pos = 0;

	constructor(tokens: readonly Token[], scope: Readonly<Record<string, number | null | undefined>>) {
		this.#tokens = tokens;
		this.#scope = scope;
	}

	run(): number | null {
		const value = this.#parseComparison();
		if (this.#pos !== this.#tokens.length) return null;
		return value !== null && Number.isFinite(value) ? value : null;
	}

	#peek(): Token | undefined {
		return this.#tokens[this.#pos];
	}

	#next(): Token | undefined {
		const token = this.#tokens[this.#pos];
		if (token !== undefined) this.#pos += 1;
		return token;
	}

	#parseComparison(): number | null {
		let left = this.#parseAdditive();
		while (true) {
			const token = this.#peek();
			if (
				token?.kind !== "op" ||
				(token.op !== "<" &&
					token.op !== "<=" &&
					token.op !== ">" &&
					token.op !== ">=" &&
					token.op !== "==" &&
					token.op !== "!=")
			) {
				break;
			}
			this.#next();
			const right = this.#parseAdditive();
			if (left === null || right === null) return null;
			switch (token.op) {
				case "<":
					left = left < right ? 1 : 0;
					break;
				case "<=":
					left = left <= right ? 1 : 0;
					break;
				case ">":
					left = left > right ? 1 : 0;
					break;
				case ">=":
					left = left >= right ? 1 : 0;
					break;
				case "==":
					left = left === right ? 1 : 0;
					break;
				case "!=":
					left = left !== right ? 1 : 0;
					break;
			}
		}
		return left;
	}

	#parseAdditive(): number | null {
		let left = this.#parseMultiplicative();
		while (true) {
			const token = this.#peek();
			if (token?.kind !== "op" || (token.op !== "+" && token.op !== "-")) break;
			this.#next();
			const right = this.#parseMultiplicative();
			if (left === null || right === null) return null;
			left = token.op === "+" ? left + right : left - right;
		}
		return left;
	}

	#parseMultiplicative(): number | null {
		let left = this.#parseUnary();
		while (true) {
			const token = this.#peek();
			if (token?.kind !== "op" || (token.op !== "*" && token.op !== "/")) break;
			this.#next();
			const right = this.#parseUnary();
			if (left === null || right === null) return null;
			if (token.op === "/") {
				if (right === 0) return null;
				left = left / right;
			} else {
				left = left * right;
			}
		}
		return left;
	}

	#parseUnary(): number | null {
		const token = this.#peek();
		if (token?.kind === "op" && (token.op === "+" || token.op === "-")) {
			this.#next();
			const inner = this.#parseUnary();
			if (inner === null) return null;
			return token.op === "-" ? -inner : inner;
		}
		return this.#parsePrimary();
	}

	#parsePrimary(): number | null {
		const token = this.#next();
		if (!token) return null;
		if (token.kind === "num") return token.value;
		if (token.kind === "lparen") {
			const inner = this.#parseComparison();
			const close = this.#next();
			if (close?.kind !== "rparen") return null;
			return inner;
		}
		if (token.kind === "id") {
			if (this.#peek()?.kind === "lparen") {
				this.#next();
				const args: (number | null)[] = [];
				if (this.#peek()?.kind !== "rparen") {
					args.push(this.#parseComparison());
					while (this.#peek()?.kind === "comma") {
						this.#next();
						args.push(this.#parseComparison());
					}
				}
				if (this.#next()?.kind !== "rparen") return null;
				return applyMathFunction(token.name, args);
			}
			const resolved = this.#scope[token.name];
			return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : null;
		}
		return null;
	}
}

function applyMathFunction(name: string, args: readonly (number | null)[]): number | null {
	if (name === "if") {
		if (args.length !== 3 || args[0] === null) return null;
		return args[0] !== 0 ? (args[1] ?? null) : (args[2] ?? null);
	}
	if (args.length === 0 || args.some((item) => item === null)) return null;
	const nums = args as number[];
	switch (name) {
		case "min":
			return Math.min(...nums);
		case "max":
			return Math.max(...nums);
		case "abs":
			return nums.length === 1 ? Math.abs(nums[0]!) : null;
		case "round":
			return nums.length === 1 ? Math.round(nums[0]!) : null;
		case "floor":
			return nums.length === 1 ? Math.floor(nums[0]!) : null;
		case "ceil":
			return nums.length === 1 ? Math.ceil(nums[0]!) : null;
		case "clamp":
			return nums.length === 3 ? Math.min(nums[2]!, Math.max(nums[1]!, nums[0]!)) : null;
		default:
			return null;
	}
}

export function evaluateEconomicsExpression(
	expr: string,
	scope: Readonly<Record<string, number | null | undefined>>,
): number | null {
	const tokens = tokenize(expr);
	if (!tokens || tokens.length === 0) return null;
	return new ExpressionEvaluator(tokens, scope).run();
}

export function evaluateEconomicsModel(
	doc: EconomicsDocument,
	overrides?: Readonly<Record<string, number>>,
): EconomicsEvaluation {
	const values: Record<string, number | null> = {};
	for (const input of doc.inputs) {
		const raw = overrides && Object.hasOwn(overrides, input.id) ? overrides[input.id] : input.value;
		values[input.id] = typeof raw === "number" && Number.isFinite(raw) ? raw : input.value;
	}
	for (const formula of doc.computed) {
		values[formula.id] = evaluateEconomicsExpression(formula.expr, values);
	}
	const constraints: EconomicsConstraintStatus[] = (doc.constraints ?? []).map((constraint) => {
		const outcome = evaluateEconomicsExpression(constraint.expr, values);
		return { constraint, triggered: outcome !== null && outcome > 0 };
	});
	return { values, constraints };
}

export function evaluateEconomicsCurve(
	doc: EconomicsDocument,
	overrides?: Readonly<Record<string, number>>,
): EconomicsCurveEvaluation | null {
	const curve = doc.curve;
	if (!curve) return null;
	const xInput = doc.inputs.find((item) => item.id === curve.xInput);
	if (!xInput) return null;
	const xMin = curve.xMin ?? xInput.min;
	const xMax = curve.xMax ?? xInput.max;
	if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMax <= xMin) return null;
	const steps = Math.max(8, Math.min(120, Math.round(curve.steps ?? 48)));
	const baseValues = { ...(overrides ?? {}) };
	const currentEval = evaluateEconomicsModel(doc, baseValues);
	const currentX = currentEval.values[xInput.id] ?? xInput.value;
	const currentY = currentEval.values[curve.yOutput] ?? null;
	const points: EconomicsCurvePoint[] = [];
	let breakEvenX: number | null = null;
	for (let step = 0; step <= steps; step += 1) {
		const x = xMin + ((xMax - xMin) * step) / steps;
		const evalAt = evaluateEconomicsModel(doc, { ...baseValues, [xInput.id]: x });
		const y = evalAt.values[curve.yOutput] ?? null;
		const prev = points.at(-1);
		if (breakEvenX === null && prev && prev.y !== null && y !== null) {
			if (prev.y === 0) breakEvenX = prev.x;
			else if ((prev.y < 0 && y >= 0) || (prev.y > 0 && y <= 0)) {
				const delta = y - prev.y;
				breakEvenX = delta === 0 ? x : prev.x + ((0 - prev.y) / delta) * (x - prev.x);
			}
		}
		points.push({ x, y });
	}
	const capacityX = curve.capacityExpr ? evaluateEconomicsExpression(curve.capacityExpr, currentEval.values) : null;
	return {
		points,
		breakEvenX: breakEvenX !== null && Number.isFinite(breakEvenX) ? breakEvenX : null,
		capacityX: capacityX !== null && Number.isFinite(capacityX) ? capacityX : null,
		currentX,
		currentY,
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTier(value: unknown): SurfaceEpistemicTier {
	if (value === "verified" || value === "benchmark" || value === "hypothesis") return value;
	return "hypothesis";
}

function parseFormat(value: unknown): EconomicsFormat | undefined {
	if (value === "currency" || value === "number" || value === "percent" || value === "hours") return value;
	return undefined;
}

export function parseEconomicsDocument(value: unknown): EconomicsDocument | null {
	if (!isPlainRecord(value) || !Array.isArray(value.inputs)) return null;
	const inputs: EconomicsInput[] = [];
	const seenIds = new Set<string>();
	for (const raw of value.inputs) {
		if (!isPlainRecord(raw)) continue;
		const id = asString(raw.id);
		const label = asString(raw.label);
		const num = asFiniteNumber(raw.value);
		const min = asFiniteNumber(raw.min);
		const max = asFiniteNumber(raw.max);
		if (!id || !label || num === undefined || min === undefined || max === undefined || max < min) continue;
		if (seenIds.has(id)) continue;
		seenIds.add(id);
		const marks = Array.isArray(raw.marks)
			? raw.marks.flatMap((mark): EconomicsInputMark[] => {
					if (!isPlainRecord(mark)) return [];
					const mv = asFiniteNumber(mark.value);
					const ml = asString(mark.label);
					return mv !== undefined && ml ? [{ value: mv, label: ml }] : [];
				})
			: undefined;
		const step = asFiniteNumber(raw.step);
		const group = asString(raw.group);
		const unit = asString(raw.unit);
		const source = asString(raw.source);
		const note = asString(raw.note);
		inputs.push({
			id,
			label,
			value: num,
			min,
			max,
			tier: parseTier(raw.tier),
			...(group ? { group } : {}),
			...(unit ? { unit } : {}),
			...(step !== undefined && step > 0 ? { step } : {}),
			...(source ? { source } : {}),
			...(note ? { note } : {}),
			...(marks && marks.length > 0 ? { marks } : {}),
		});
	}
	if (inputs.length === 0) return null;

	const computed: EconomicsFormula[] = Array.isArray(value.computed)
		? value.computed.flatMap((raw): EconomicsFormula[] => {
				if (!isPlainRecord(raw)) return [];
				const id = asString(raw.id);
				const expr = asString(raw.expr);
				if (!id || !expr) return [];
				const label = asString(raw.label);
				const unit = asString(raw.unit);
				return [{ id, expr, ...(label ? { label } : {}), ...(unit ? { unit } : {}) }];
			})
		: [];

	const headlines: EconomicsHeadline[] | undefined = Array.isArray(value.headlines)
		? value.headlines.flatMap((raw): EconomicsHeadline[] => {
				if (!isPlainRecord(raw)) return [];
				const id = asString(raw.id);
				const label = asString(raw.label);
				if (!id || !label) return [];
				const unit = asString(raw.unit);
				const format = parseFormat(raw.format);
				const emphasis = raw.emphasis === "primary" || raw.emphasis === "secondary" ? raw.emphasis : undefined;
				const toneWhenNegative =
					raw.toneWhenNegative === "danger" || raw.toneWhenNegative === "neutral"
						? raw.toneWhenNegative
						: undefined;
				const target = asFiniteNumber(raw.target);
				return [
					{
						id,
						label,
						...(unit ? { unit } : {}),
						...(format ? { format } : {}),
						...(emphasis ? { emphasis } : {}),
						...(toneWhenNegative ? { toneWhenNegative } : {}),
						...(target !== undefined ? { target } : {}),
					},
				];
			})
		: undefined;

	const waterfall: EconomicsWaterfallStep[] | undefined = Array.isArray(value.waterfall)
		? value.waterfall.flatMap((raw): EconomicsWaterfallStep[] => {
				if (!isPlainRecord(raw)) return [];
				const id = asString(raw.id);
				const label = asString(raw.label);
				if (!id || !label) return [];
				const kind = raw.kind === "income" || raw.kind === "cost" || raw.kind === "total" ? raw.kind : undefined;
				return [{ id, label, ...(kind ? { kind } : {}) }];
			})
		: undefined;

	let curve: EconomicsCurve | undefined;
	if (isPlainRecord(value.curve)) {
		const xInput = asString(value.curve.xInput);
		const yOutput = asString(value.curve.yOutput);
		if (xInput && yOutput) {
			const xMin = asFiniteNumber(value.curve.xMin);
			const xMax = asFiniteNumber(value.curve.xMax);
			const steps = asFiniteNumber(value.curve.steps);
			const label = asString(value.curve.label);
			const yLabel = asString(value.curve.yLabel);
			const capacityExpr = asString(value.curve.capacityExpr);
			const capacityLabel = asString(value.curve.capacityLabel);
			curve = {
				xInput,
				yOutput,
				...(xMin !== undefined ? { xMin } : {}),
				...(xMax !== undefined ? { xMax } : {}),
				...(steps !== undefined ? { steps } : {}),
				...(typeof value.curve.zeroLine === "boolean" ? { zeroLine: value.curve.zeroLine } : {}),
				...(label ? { label } : {}),
				...(yLabel ? { yLabel } : {}),
				...(capacityExpr ? { capacityExpr } : {}),
				...(capacityLabel ? { capacityLabel } : {}),
			};
		}
	}

	const constraints: EconomicsConstraint[] | undefined = Array.isArray(value.constraints)
		? value.constraints.flatMap((raw): EconomicsConstraint[] => {
				if (!isPlainRecord(raw)) return [];
				const label = asString(raw.label);
				const expr = asString(raw.expr);
				const message = asString(raw.message);
				if (!label || !expr || !message) return [];
				const id = asString(raw.id);
				const severity = raw.severity === "warning" ? "warning" : "fatal";
				return [{ ...(id ? { id } : {}), label, expr, severity, message }];
			})
		: undefined;

	const scenarios: EconomicsScenario[] | undefined = Array.isArray(value.scenarios)
		? value.scenarios.flatMap((raw): EconomicsScenario[] => {
				if (!isPlainRecord(raw) || !isPlainRecord(raw.values)) return [];
				const id = asString(raw.id);
				const name = asString(raw.name);
				if (!id || !name) return [];
				const values: Record<string, number> = {};
				for (const [key, item] of Object.entries(raw.values)) {
					const num = asFiniteNumber(item);
					if (num !== undefined) values[key] = num;
				}
				const thesis = asString(raw.thesis);
				return [{ id, name, ...(thesis ? { thesis } : {}), values }];
			})
		: undefined;

	const title = asString(value.title);
	const subtitle = asString(value.subtitle);
	const currency = asString(value.currency);
	const period = asString(value.period);
	const verdict = asString(value.verdict);

	return {
		...(title ? { title } : {}),
		...(subtitle ? { subtitle } : {}),
		...(currency ? { currency } : {}),
		...(period ? { period } : {}),
		...(verdict ? { verdict } : {}),
		inputs,
		computed,
		...(headlines && headlines.length > 0 ? { headlines } : {}),
		...(waterfall && waterfall.length > 0 ? { waterfall } : {}),
		...(curve ? { curve } : {}),
		...(constraints && constraints.length > 0 ? { constraints } : {}),
		...(scenarios && scenarios.length > 0 ? { scenarios } : {}),
	};
}
