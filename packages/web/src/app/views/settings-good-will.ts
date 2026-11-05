import { CloudRpcError, describeError } from "../../cloud/client.ts";
import {
	type CompanyGoodWill,
	GoodWillCardError,
	type GoodWillMonth,
	type MyGoodWill,
	type MyGoodWillCompany,
} from "../../cloud/good-will.ts";
import { button, fmtDate, h, notice, replace } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";

/** The good will's name, one string so it is easy to change (Danish "Goodwill" for now, Jonas has not chosen). */
export const goodWillName = () => t("Good will");

const locale = () => (presentationLocale() === "da" ? "da-DK" : "en-GB");

/** Øre as kroner: whole kroner, øre only when there are some. */
export function kroner(ore: number): string {
	return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(ore / 100)} kr`;
}

const percent = (rateBp: number) =>
	`${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(rateBp / 100)} %`;

/** "November 2026" for "2026-11". */
function monthName(month: string): string {
	const [year, number] = month.split("-").map(Number);
	return new Date(Date.UTC(year!, number! - 1, 1)).toLocaleDateString(locale(), {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
}

/** What became of a month, in a line. */
function monthLine(month: GoodWillMonth, card: boolean, minChargeOre: number | null): string {
	const amount = kroner(month.dueOre);
	switch (month.status) {
		case "open":
			return t("{amount} so far this month", { amount });
		case "sorting":
			return t("{amount} so far. Final on the 5th", { amount });
		case "closed":
			return card ? t("{amount} to be charged", { amount }) : t("{amount}, waiting for a card", { amount });
		case "carried":
			return minChargeOre === null
				? t("{amount} moves to next month", { amount })
				: t("{amount} moves to next month (under {least})", { amount, least: kroner(minChargeOre) });
		case "zero":
			return t("Nothing to pay");
		case "failed":
			return t("{amount}: the card was declined. Stripe tries again.", { amount });
		case "charged":
			return month.chargedAt
				? t("{amount} charged {date}", { amount, date: fmtDate(month.chargedAt) })
				: t("{amount} charged", { amount });
	}
}

function cardLine(card: { brand: string | null; last4: string | null }): string {
	const brand = card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : t("Card");
	return card.last4 ? t("{brand} ending {last4}", { brand, last4: card.last4 }) : brand;
}

const OPENING_RESET_MS = 10_000;

/** What a founder's card page needs of the cloud. */
export interface WebGoodWill {
	read(): Promise<CompanyGoodWill>;
	/** Stripe's page for the company's card. */
	cardPage(): Promise<string>;
	/** Opens Stripe's page in this window. */
	open(url: string): void;
}

function cardRefusal(error: unknown): string {
	if (error instanceof GoodWillCardError && error.refusal === "not_a_founder")
		return t("Only the company's founders add its card.");
	if (error instanceof GoodWillCardError && error.refusal === "not_open")
		return t("Cards can't be added yet. Nothing is charged until then.");
	return t("Payments are unavailable right now. Try again in a moment.");
}

/**
 * Settings → Company → Good will (design A, 5 Nov): what the company pays Qorpera, its invoices and the card that
 * pays them. Every member sees it; founders add the card. On a cloud without good will the section stays hidden.
 */
export class GoodWillView {
	readonly el = h("section", { class: "settings-group settings-good-will", hidden: true });
	readonly #client: WebGoodWill;
	readonly #lifetime = new AbortController();
	readonly #companyName: () => string;
	#goodWill: CompanyGoodWill | undefined;
	#loading = true;
	#error: string | undefined;
	#cardError: string | undefined;
	#opening = false;

	constructor(client: WebGoodWill, signal: AbortSignal, companyName: () => string) {
		this.#client = client;
		this.#companyName = companyName;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		void this.#refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
	}

	async #refresh(): Promise<void> {
		this.#loading = true;
		this.#draw();
		try {
			const goodWill = await this.#client.read();
			if (this.#lifetime.signal.aborted) return;
			this.#goodWill = goodWill;
			this.#error = undefined;
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			// A cloud without good will hides the section.
			this.#error = error instanceof CloudRpcError && error.missing ? "" : describeError(error);
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#loading = false;
				this.#draw();
			}
		}
	}

	async #addCard(): Promise<void> {
		if (this.#opening) return;
		this.#opening = true;
		this.#cardError = undefined;
		this.#draw();
		try {
			const url = await this.#client.cardPage();
			if (this.#lifetime.signal.aborted) return;
			this.#client.open(url);
			// A page that did not open (the member stayed when the browser asked, or came back from its cache) frees the
			// button again.
			setTimeout(() => {
				if (this.#lifetime.signal.aborted) return;
				this.#opening = false;
				this.#draw();
			}, OPENING_RESET_MS);
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			this.#cardError = cardRefusal(error);
			this.#opening = false;
			this.#draw();
		}
	}

	#draw(): void {
		const goodWill = this.#goodWill;
		// Hidden until the first answer, so a cloud without good will never shows it.
		this.el.hidden = this.#error === "" || (!goodWill && this.#error === undefined);
		const name = goodWill?.companyName || this.#companyName();
		const head = [
			h("h2", null, goodWillName()),
			h(
				"p",
				{ class: "settings-lead" },
				t(
					"We lend you our machines for free as an investment in your company. In exchange, {company} pays a good will tax to Qorpera. The more you earn, the smaller the tax rate.",
					{ company: name },
				),
			),
		];
		if (!goodWill) {
			replace(
				this.el,
				...head,
				this.#loading
					? h("p", { class: "muted small" }, t("Loading {name}…", { name: goodWillName() }))
					: h(
							"div",
							null,
							notice("danger", this.#error ?? t("{name} could not be read just now.", { name: goodWillName() })),
							button(t("Retry"), () => void this.#refresh(), { small: true }),
						),
			);
			return;
		}
		const shown = goodWill.months.filter((month) => month.status !== "zero" || month.dueOre > 0);
		const invoices = h(
			"div",
			{ class: "settings-card good-will-invoices" },
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, t("Invoices")),
				shown.length
					? h(
							"ul",
							{ class: "good-will-months" },
							...shown.map((month) =>
								h(
									"li",
									{ "data-month": month.month, "data-status": month.status },
									h("span", { class: "good-will-month" }, monthName(month.month)),
									h("small", null, monthLine(month, Boolean(goodWill.card), goodWill.minChargeOre)),
									month.invoiceUrl
										? h(
												"a",
												{
													class: "btn btn-small",
													href: month.invoiceUrl,
													target: "_blank",
													rel: "noopener noreferrer",
													"aria-label": t("Open the invoice for {month}", {
														month: monthName(month.month),
													}),
												},
												t("Open"),
											)
										: null,
								),
							),
						)
					: h("small", null, t("No invoices yet")),
			),
		);
		const card = goodWill.card;
		const paidWith = h(
			"div",
			{ class: "settings-card good-will-card" },
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, t("Paid with")),
				h(
					"small",
					null,
					card
						? card.mine
							? t("Your {card}", { card: cardLine(card) })
							: card.payerName
								? t("{name}'s card", { name: card.payerName })
								: t("A founder's card")
						: t("No card needed until there are sales"),
				),
			),
			goodWill.canAddCard
				? button(
						this.#opening ? t("Opening…") : card ? t("Change card") : t("Add card"),
						() => void this.#addCard(),
						{ small: true, disabled: this.#opening },
					)
				: null,
		);
		const first = goodWill.steps[0];
		const least = goodWill.minChargeOre;
		replace(
			this.el,
			...head,
			invoices,
			paidWith,
			this.#cardError ? notice("danger", this.#cardError) : null,
			first && first.toOre !== null
				? h(
						"p",
						{ class: "settings-rule-note" },
						t("{rate} of each month's first {amount} from customers, then less. Moms is added on the invoice.", {
							rate: percent(first.rateBp),
							amount: kroner(first.toOre),
						}),
						least ? ` ${t("Under {least} moves to the next month.", { least: kroner(least) })}` : null,
					)
				: null,
		);
	}
}

function payerLine(company: MyGoodWillCompany): string {
	if (company.payer === "me") return t("Your {card}", { card: cardLine(company) });
	if (company.payer === "other") return t("Paid by another founder");
	return t("No card yet");
}

const CARD_REFRESH_MS = 5000;

/**
 * Settings → General with no company open, and the account page: what each of the member's companies sold and paid
 * this year, and whose card pays it. Contributors never pay.
 */
export class MyGoodWillView {
	readonly el = h("section", { class: "settings-group settings-good-will-account", hidden: true });
	readonly #read: () => Promise<MyGoodWill>;
	readonly #lifetime = new AbortController();
	#note: string | undefined;

	constructor(read: () => Promise<MyGoodWill>, signal: AbortSignal, note?: string) {
		this.#read = read;
		this.#note = note;
		// Back from Stripe, the card is saved a moment later (Stripe's word to the cloud): read once more.
		if (note)
			setTimeout(() => {
				if (!this.#lifetime.signal.aborted) void this.refresh();
			}, CARD_REFRESH_MS);
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		void this.refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
	}

	async refresh(): Promise<void> {
		try {
			const mine = await this.#read();
			if (this.#lifetime.signal.aborted) return;
			this.#draw(mine);
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			if (error instanceof CloudRpcError && error.missing) {
				this.el.hidden = true;
				return;
			}
			this.el.hidden = false;
			replace(
				this.el,
				h("h2", null, t("{name} in your companies", { name: goodWillName() })),
				notice("danger", describeError(error)),
				button(t("Retry"), () => void this.refresh(), { small: true }),
			);
		}
	}

	#draw(mine: MyGoodWill): void {
		this.el.hidden = mine.companies.length === 0;
		replace(
			this.el,
			h("h2", null, t("{name} in your companies", { name: goodWillName() })),
			h(
				"p",
				{ class: "settings-lead" },
				t("Each company pays from its own card. Where you only help out, you never pay."),
			),
			this.#note ? notice("ok", this.#note) : null,
			h(
				"p",
				{ class: "good-will-total" },
				h("strong", null, kroner(mine.paidByMeOre)),
				h("small", null, t("paid on your card in {year}", { year: String(mine.year) })),
			),
			h(
				"ul",
				{ class: "good-will-companies" },
				...mine.companies.map((company) =>
					h(
						"li",
						{ class: "settings-card", "data-profile-id": company.profileId },
						h(
							"div",
							{ class: "settings-copy" },
							h("strong", null, company.name),
							h(
								"small",
								null,
								company.netOre > 0
									? t("{amount} from customers", { amount: kroner(company.netOre) })
									: t("No sales yet"),
							),
							h("small", null, payerLine(company)),
						),
						h("span", { class: "good-will-fee" }, kroner(company.feeOre)),
					),
				),
			),
		);
	}
}

/** Stripe sends the founder back to "#/account?good-will=card-saved" (or "=card-cancelled"): read once, then removed
 * from the address, like a connector's return (cloud/connectors.ts). */
export function takeGoodWillReturn(): "card-saved" | "card-cancelled" | undefined {
	const hash = location.hash;
	const at = hash.indexOf("?");
	if (at < 0) return undefined;
	const value = new URLSearchParams(hash.slice(at + 1)).get("good-will");
	if (value !== "card-saved" && value !== "card-cancelled") return undefined;
	history.replaceState(null, "", hash.slice(0, at) || "#/");
	return value;
}
