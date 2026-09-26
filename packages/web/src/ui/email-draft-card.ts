import type { EmailDraftContent, EmailDraftEditor, EmailDraftState } from "../cloud/email-drafts.ts";
import { interactionState } from "../cloud/interactions.ts";
import { button, h } from "./dom.ts";
import type { InteractionCardContext, InteractionCardItem } from "./interaction-card.ts";
import { t } from "./preferences.ts";

function recipients(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: typeof value === "string"
			? value
					.split(/[,;]/)
					.map((entry) => entry.trim())
					.filter(Boolean)
			: [];
}

/** The editor belongs to the conversation controller, so polling cannot erase edits
 * or submit a second action while the first is still in flight. */
export function renderEmailDraftCard(item: InteractionCardItem, context: InteractionCardContext): HTMLElement {
	const editor: EmailDraftEditor = context.emailDraft ?? {};
	const answerContent = item.answer?.answer.content;
	const payload =
		answerContent && typeof answerContent === "object" && !Array.isArray(answerContent)
			? answerContent
			: item.request.payload;
	const initial = editor.content ??
		editor.state?.content ?? {
			to: recipients(payload.to),
			cc: recipients(payload.cc),
			subject: typeof payload.subject === "string" ? payload.subject : "",
			body: typeof payload.body === "string" ? payload.body : "",
		};
	editor.fields ??= { ...initial, to: initial.to.join(", "), cc: initial.cc.join(", ") };
	// A final transcript receipt can arrive from another tab while this editor
	// still holds unsent local changes. Show exactly what was delivered.
	const finalOutcome =
		!item.answer?.pending && (item.answer?.outcome === "sent" || item.answer?.outcome === "discarded")
			? item.answer.outcome
			: undefined;
	const confirmedFrom =
		finalOutcome && typeof item.answer?.answer.from === "string" ? item.answer.answer.from : undefined;
	if (finalOutcome && answerContent && typeof answerContent === "object" && !Array.isArray(answerContent)) {
		const content: EmailDraftContent = {
			to: recipients(answerContent.to),
			cc: recipients(answerContent.cc),
			subject: typeof answerContent.subject === "string" ? answerContent.subject : "",
			body: typeof answerContent.body === "string" ? answerContent.body : "",
		};
		editor.content = content;
		editor.fields = { ...content, to: content.to.join(", "), cc: content.cc.join(", ") };
		editor.state = {
			...editor.state,
			from: confirmedFrom || editor.state?.from || "",
			content,
			status: finalOutcome,
		};
		editor.error = undefined;
		editor.unconfirmedAction = undefined;
		editor.recoveryBase = undefined;
	}
	const card = h("article", {
		class: "interaction-card email-draft-card surface-draft",
		dataset: { interactionId: item.id, surface: "draft" },
		"aria-label": t("Email draft from {name}", { name: context.agentName }),
	});
	const accept = (state: EmailDraftState) => {
		const unchangedReceipt =
			Boolean(editor.unconfirmedAction) &&
			editor.recoveryBase &&
			(state.status === "ready" || state.status === "saved") &&
			state.actionId === editor.recoveryBase.actionId &&
			JSON.stringify(state.content) === JSON.stringify(editor.recoveryBase.content);
		// An older read may finish after another tab's final transcript arrives.
		// Keep the final letter while accepting the verified sender from the read.
		if (
			editor.state &&
			(editor.state.status === "sent" || editor.state.status === "discarded") &&
			state.status !== "sent" &&
			state.status !== "discarded"
		)
			state = { ...state, content: editor.state.content, status: editor.state.status, error: undefined };
		if (
			unchangedReceipt &&
			state.status === "saved" &&
			JSON.stringify(editor.content) !== JSON.stringify(state.content)
		)
			state = { ...state, status: "ready" };
		editor.state = state;
		editor.unconfirmedAction = undefined;
		editor.recoveryBase = undefined;
		editor.error = state.error;
		if (!unchangedReceipt || state.status === "sent" || state.status === "discarded") {
			editor.content = state.content;
			editor.fields = { ...state.content, to: state.content.to.join(", "), cc: state.content.cc.join(", ") };
		}
		editor.loaded = true;
	};
	const load = () => {
		if (!context.loadEmailDraft || editor.pending) return;
		editor.busy = "load";
		editor.error = undefined;
		editor.loaded = true;
		editor.pending = context
			.loadEmailDraft()
			.then(accept, (error: unknown) => {
				editor.error = error instanceof Error ? error.message : t("The email draft could not be loaded.");
			})
			.finally(() => {
				editor.busy = undefined;
				editor.pending = undefined;
			});
		void editor.pending.then(draw);
	};
	const draw = () => {
		const fields = editor.fields!;
		const state = interactionState(item.request, item.answer, context.now);
		const status = editor.state?.status;
		const terminal = status === "sent" || status === "discarded" || state !== "waiting";
		const uncertain = Boolean(editor.unconfirmedAction) || status === "sending" || status === "unconfirmed";
		const editable = context.canAnswer && !terminal && !uncertain && !editor.busy;
		const connected = Boolean(editor.state?.from);
		const content = (): EmailDraftContent => ({
			to: recipients(fields.to),
			cc: recipients(fields.cc),
			subject: fields.subject,
			body: fields.body,
		});
		const valid = () => {
			const value = content();
			return (
				value.to.length > 0 &&
				value.to.length <= 20 &&
				value.cc.length <= 20 &&
				[...value.to, ...value.cc].every(
					(address) => address.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address),
				) &&
				!/[\r\n]/.test(fields.to + fields.cc + fields.subject) &&
				Boolean(value.subject.trim() && value.body.trim()) &&
				new TextEncoder().encode(value.subject).length <= 500 &&
				new TextEncoder().encode(value.body).length <= 50_000
			);
		};
		const act = (action: "save" | "send" | "discard") => {
			if (!editable || editor.pending || !context.actEmailDraft || !connected || (action !== "discard" && !valid()))
				return;
			editor.content = content();
			const previousReceipt = editor.state;
			editor.busy = action;
			editor.error = undefined;
			editor.pending = context
				.actEmailDraft(action, editor.content)
				.then(accept, (error: unknown) => {
					if (editor.state?.status === "sent" || editor.state?.status === "discarded") return;
					editor.error = error instanceof Error ? error.message : t("The email action could not be confirmed.");
					// Any lost response can leave an admitted action pending. Recover that
					// exact action before accepting edits or a different member click.
					editor.unconfirmedAction = action;
					editor.recoveryBase = previousReceipt
						? { actionId: previousReceipt.actionId, content: structuredClone(previousReceipt.content) }
						: undefined;
					if (action === "send" && editor.state) editor.state = { ...editor.state, status: "unconfirmed" };
				})
				.finally(() => {
					editor.busy = undefined;
					editor.pending = undefined;
				});
			void editor.pending.then(draw);
			draw();
		};
		const statusText = () => {
			if (status === "sent" || finalOutcome === "sent") return t("Sent");
			if (editor.busy === "load") return t("Loading email…");
			if (editor.busy === "save") return t("Saving to Gmail…");
			if (editor.busy === "send" || status === "sending") return t("Sending…");
			if (editor.busy === "discard") return t("Discarding…");
			if (editor.unconfirmedAction && editor.unconfirmedAction !== "send") return t("Action unconfirmed");
			if (status === "unconfirmed") return t("Send unconfirmed");
			if (status === "discarded" || item.answer?.outcome === "discarded") return t("Discarded");
			if (state === "expired") return t("Expired");
			if (item.answer?.pending) return t("Sending…");
			if (editor.state?.status === "saved") return t("Saved to Gmail");
			if (!connected) return t("Account unavailable");
			return valid() ? t("Ready to send") : t("Draft");
		};
		const statusLabel = h("span", { class: "email-draft-status", role: "status" }, statusText());
		const send = button(t("Send email"), () => act("send"));
		send.classList.add("email-draft-send");
		const discard = button(t("Discard"), () => act("discard"));
		const save = button(t("Save to Gmail"), () => act("save"));
		save.classList.add("email-draft-save");
		const update = () => {
			editor.content = content();
			send.disabled = save.disabled = !editable || !connected || !context.actEmailDraft || !valid();
			discard.disabled = !editable || !connected || !context.actEmailDraft;
			statusLabel.textContent = statusText();
		};
		const input = (key: "to" | "cc" | "subject", label: string) => {
			const field = h("input", {
				class: "email-draft-input",
				type: key === "subject" ? "text" : "email",
				multiple: key !== "subject",
				value: fields[key],
				"aria-label": label,
				readonly: !editable,
				autocomplete: "off",
				spellcheck: key === "subject",
				oninput: (event: Event) => {
					fields[key] = (event.currentTarget as HTMLInputElement).value;
					if (editor.state?.status === "saved") editor.state = { ...editor.state, status: "ready" };
					update();
				},
			});
			return h("label", { class: "email-draft-row" }, h("span", { class: "email-draft-label" }, label), field);
		};
		const body = h("textarea", {
			class: "email-draft-body",
			"aria-label": t("Email body"),
			value: fields.body,
			readonly: !editable,
			rows: Math.max(7, Math.min(18, fields.body.split("\n").length + 1)),
			oninput: (event: Event) => {
				fields.body = (event.currentTarget as HTMLTextAreaElement).value;
				if (editor.state?.status === "saved") editor.state = { ...editor.state, status: "ready" };
				update();
			},
		});
		const cc = input("cc", t("Cc"));
		cc.hidden = !fields.cc;
		const addCc = button(t("Cc"), () => {
			cc.hidden = false;
			addCc.hidden = true;
			cc.querySelector("input")?.focus();
		});
		addCc.classList.add("email-draft-add-cc");
		addCc.hidden = Boolean(fields.cc) || !editable;
		const to = input("to", t("To"));
		if (editable) to.append(addCc);
		card.dataset.state = state;
		card.setAttribute("aria-busy", String(Boolean(editor.busy)));
		const sent = status === "sent" || finalOutcome === "sent";
		card.dataset.emailState = sent ? "sent" : (status ?? "loading");
		card.setAttribute(
			"aria-label",
			sent
				? t("Email sent by {name}", { name: context.agentName })
				: t("Email draft from {name}", { name: context.agentName }),
		);
		card.replaceChildren(
			h(
				"header",
				{ class: "email-draft-heading" },
				h("h3", null, sent ? t("Email sent") : t("New email")),
				statusLabel,
			),
		);
		if (sent) {
			const receipt = editor.state?.content ?? initial;
			const details = h("details", {
				class: "email-sent-details",
				open: editor.receiptExpanded,
				ontoggle: (event: Event) => {
					if (card.contains(event.currentTarget as Node))
						editor.receiptExpanded = (event.currentTarget as HTMLDetailsElement).open;
				},
			});
			details.append(
				h("summary", null, t("View email")),
				h(
					"div",
					{ class: "email-sent-from" },
					h("span", { class: "email-draft-label" }, t("From")),
					h("span", { class: "email-draft-from" }, editor.state?.from || t("Account unavailable")),
				),
				h("div", { class: "email-sent-body" }, receipt.body),
			);
			card.append(
				h(
					"p",
					{ class: "email-sent-to" },
					h("span", { class: "email-draft-label" }, t("To")),
					" ",
					receipt.to.join(", "),
				),
				...(receipt.cc.length
					? [
							h(
								"p",
								{ class: "email-sent-cc" },
								h("span", { class: "email-draft-label" }, t("Cc")),
								" ",
								receipt.cc.join(", "),
							),
						]
					: []),
				h("p", { class: "email-sent-subject" }, receipt.subject),
				details,
			);
		} else
			card.append(
				h(
					"div",
					{ class: "email-draft-panel" },
					h(
						"div",
						{ class: "email-draft-row" },
						h("span", { class: "email-draft-label" }, t("From")),
						h(
							"span",
							{ class: "email-draft-from" },
							editor.state?.from ||
								(editor.busy === "load" ? t("Checking connected account…") : t("Account unavailable")),
						),
					),
					to,
					cc,
					input("subject", t("Subject")),
					body,
				),
			);
		if (editor.error) card.append(h("p", { class: "email-draft-error", role: "alert" }, editor.error));
		if (uncertain)
			card.append(
				h(
					"p",
					{ class: "email-draft-note" },
					editor.unconfirmedAction && editor.unconfirmedAction !== "send"
						? t("Refresh to confirm the previous email action before making changes.")
						: t("Check Gmail before sending again. Delivery has not been confirmed."),
				),
			);
		if (!terminal && context.canAnswer) {
			const actions = h("div", { class: "email-draft-actions" }, send, discard, save);
			if ((uncertain || !connected || editor.error) && context.loadEmailDraft) {
				const refresh = button(
					t("Refresh"),
					() => {
						load();
						draw();
					},
					{ disabled: Boolean(editor.busy) },
				);
				actions.append(refresh);
			}
			card.append(actions);
		}
		if (terminal && editor.state?.notificationPending) {
			card.append(
				h(
					"p",
					{ class: "email-draft-note", role: "status" },
					t("Your email action is complete. The agent has not been notified yet."),
				),
			);
			if (context.canAnswer && context.loadEmailDraft)
				card.append(
					h(
						"div",
						{ class: "email-draft-actions" },
						button(
							t("Retry notifying agent"),
							() => {
								load();
								draw();
							},
							{ disabled: Boolean(editor.busy) },
						),
					),
				);
		}
		update();
	};
	if (!editor.loaded && !editor.state?.from && !editor.pending) load();
	else if (editor.pending) void editor.pending.then(draw);
	draw();
	return card;
}
