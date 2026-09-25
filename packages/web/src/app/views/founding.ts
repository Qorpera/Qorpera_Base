import { button, h, notice, personAvatar, replace, spinner } from "../../ui/dom.ts";
import { preserveFormDrafts } from "../../ui/forms.ts";
import { t } from "../../ui/preferences.ts";
import type { FoundingController } from "../founding.ts";

export function renderFounding(
	controller: FoundingController,
	container: HTMLElement,
	actions: { connectModel: () => void; addFriend: () => void; openUsage: () => void; openCompany: () => void },
): void {
	const state = controller.store.get();
	const data = state.data;
	const formOwner = `${controller.profileId}:${data?.revision}`;
	const restore = preserveFormDrafts(container, formOwner);
	if (!data) {
		replace(
			container,
			h(
				"section",
				{ class: "page founding" },
				h("h1", null, t("Set up your company")),
				state.error ? notice("danger", state.error) : spinner(t("Opening company setup")),
				state.error ? button(t("Retry"), () => void controller.refresh()) : null,
				h("p", null, h("a", { href: "#/" }, t("Back to companies"))),
			),
		);
		return;
	}
	if (data.phase !== "open") {
		replace(
			container,
			h(
				"section",
				{ class: "page founding" },
				h("h1", null, data.companyName),
				notice(
					"neutral",
					data.phase === "launched" ? t("Your company has started.") : t("This company setup was cancelled."),
				),
				data.phase === "launched"
					? button(t("Open the company"), actions.openCompany, { primary: true })
					: h("a", { href: "#/" }, t("Back to companies")),
			),
		);
		return;
	}
	const busy = Boolean(state.busy);
	const own = data.seats.find((seat) => seat.userId === controller.userId && seat.state === "joined");
	const ready = own?.readyRevision === data.revision && own.modelAccountReady;
	const joined = data.seats.filter((seat) => seat.state === "joined");
	const allReady =
		joined.length > 0 && joined.every((seat) => seat.readyRevision === data.revision && seat.modelAccountReady);
	const owner = data.seats.find((seat) => seat.userId === data.computerUsageOwnerUserId);
	const name = h("input", {
		value: data.companyName,
		maxlength: 120,
		required: true,
		disabled: busy || !data.canManage,
		"data-draft": "name",
	});
	const description = h(
		"textarea",
		{
			rows: 3,
			maxlength: 16384,
			disabled: busy || !data.canManage,
			"data-draft": "description",
			placeholder: t("What is the company here to do? You can develop this with your Co-Founder later."),
		},
		data.description,
	);
	const role = h(
		"textarea",
		{
			rows: 2,
			maxlength: 4096,
			disabled: busy || ready,
			"data-draft": "role",
			placeholder: t("Your background or role, if useful"),
		},
		own?.roleDescription ?? "",
	);
	const previousContribution = container.querySelector<HTMLInputElement>(
		`[data-form-owner="${formOwner}"] .founding-contribution input`,
	);
	const contribute = h("input", {
		type: "checkbox",
		checked: !ready && previousContribution ? previousContribution.checked : own?.computerPoolEnabled === true,
		disabled: busy || ready,
	});
	const candidates = state.friends.filter(
		(friend) => !data.seats.some((seat) => seat.userId === friend.userId && seat.state !== "declined"),
	);
	const friend = h(
		"select",
		{ disabled: busy || !candidates.length, "aria-label": t("Choose a co-founder"), "data-draft": "friend" },
		h("option", { value: "" }, t("Choose a friend")),
		...candidates.map((item) => h("option", { value: item.userId }, item.displayName)),
	);
	const blockers = [
		data.bootstrapState !== "completed" ? t("The company is still being prepared.") : undefined,
		!allReady ? t("Every joined co-founder needs to be Ready before the company starts.") : undefined,
		!data.computerUsage.canStart
			? data.computerUsage.checkoutAvailable === true
				? t("Add an eligible computer subscription to the company pool before starting.")
				: t("Computer usage is not enabled for this company yet. Subscription checkout is not available yet.")
			: undefined,
	].filter((item): item is string => Boolean(item));
	replace(
		container,
		h(
			"section",
			{ class: "page founding", "data-form-owner": formOwner },
			h(
				"div",
				{ class: "row" },
				h("h1", null, t("Set up your company")),
				h("span", { class: "spacer" }),
				h("a", { href: "#/" }, t("Back to companies")),
			),
			h(
				"p",
				{ class: "muted" },
				t(
					"Start on your own or bring your co-founders. Your company begins when everyone who has joined is ready.",
				),
			),
			state.error ? notice("danger", state.error) : null,
			h(
				"form",
				{
					class: "founding-card stack",
					onsubmit: (event: Event) => {
						event.preventDefault();
						void controller.update(name.value, description.value);
					},
				},
				h("h2", null, t("Company")),
				h("label", null, t("Company name"), name),
				h("label", null, t("A little about the company"), description),
				data.canManage
					? h(
							"button",
							{ type: "submit", class: "btn", disabled: busy },
							state.busy === "save" ? t("Saving…") : t("Save company details"),
						)
					: null,
			),
			h(
				"section",
				{ class: "founding-card stack" },
				h("h2", null, t("Co-founders")),
				...data.seats
					.filter((seat) => seat.state !== "declined")
					.map((seat) =>
						h(
							"div",
							{ class: "person-row" },
							personAvatar(seat.displayName, seat.userId),
							h(
								"div",
								{ class: "person-copy" },
								h("strong", null, seat.displayName),
								h("span", { class: "muted small" }, seat.email),
							),
							h(
								"span",
								{ class: "badge" },
								seat.state === "invited"
									? t("Invited")
									: seat.readyRevision === data.revision && seat.modelAccountReady
										? t("Ready")
										: t("Not ready"),
							),
							seat.state === "invited" && data.canManage
								? button(t("Cancel invitation"), () => void controller.remove(seat.userId), {
										small: true,
										disabled: busy,
									})
								: null,
						),
					),
				data.canManage
					? h(
							"form",
							{
								class: "row",
								onsubmit: (event: Event) => {
									event.preventDefault();
									if (friend.value) void controller.invite(friend.value);
								},
							},
							friend,
							h(
								"button",
								{ type: "submit", class: "btn", disabled: busy || !candidates.length },
								t("Invite co-founder"),
							),
							button(t("Add friend"), actions.addFriend),
						)
					: null,
				state.friendsError ? notice("danger", state.friendsError) : null,
				h(
					"p",
					{ class: "muted small" },
					t("Invited friends join explicitly. People who have not joined do not hold up your start."),
				),
			),
			h(
				"section",
				{ class: "founding-card stack" },
				h("h2", null, t("Computer Usage owner")),
				h("strong", null, owner?.displayName ?? t("Unavailable")),
				h(
					"p",
					{ class: "muted" },
					t(
						"The contact for this company's computer usage. Participating co-founders can contribute their Qorpera computer allowance to the company pool.",
					),
				),
				h(
					"p",
					{ role: "status" },
					data.computerUsage.canStart
						? t("Computer capacity is available to start.")
						: t("Computer capacity is not available yet."),
				),
				button(t("Plan & usage"), actions.openUsage),
				own && own.userId !== data.computerUsageOwnerUserId
					? button(t("Take responsibility"), () => void controller.acceptComputerUsageOwnership(), {
							disabled: busy,
						})
					: null,
			),
			own
				? h(
						"section",
						{ class: "founding-card stack" },
						h("h2", null, t("Your setup")),
						h(
							"div",
							{ class: "row" },
							h(
								"span",
								null,
								own.modelAccountReady
									? t("Your ChatGPT account is connected.")
									: t("Connect your own ChatGPT account to be Ready."),
							),
							button(
								own.modelAccountReady ? t("Manage model accounts") : t("Connect ChatGPT"),
								actions.connectModel,
							),
						),
						h("label", null, t("Your role (optional)"), role),
						h(
							"label",
							{ class: "founding-contribution" },
							contribute,
							t("Contribute my Qorpera computer allowance to this company"),
						),
						h(
							"p",
							{ class: "muted small" },
							t(
								"Computer usage prefers the responsible member's available allowance, then other participating co-founders. This shares computer capacity; your ChatGPT or Claude account remains separate.",
							),
						),
						button(
							ready ? t("Not ready yet") : t("I'm Ready"),
							() => void controller.ready(!ready, role.value, contribute.checked),
							{ primary: !ready, disabled: busy || (!ready && !own.modelAccountReady) },
						),
						!data.canManage ? button(t("Leave setup"), () => void controller.leave(), { disabled: busy }) : null,
					)
				: null,
			h(
				"section",
				{ class: "founding-start stack", "aria-live": "polite" },
				...blockers.map((reason) => h("p", { class: "muted" }, reason)),
				own
					? button(
							state.busy === "launch"
								? t("Starting…")
								: state.launchPending
									? t("Retry start")
									: t("Start company"),
							() => void controller.launch(),
							{ primary: true, disabled: busy || blockers.length > 0 },
						)
					: h("p", null, t("A joined co-founder can start once everyone is ready.")),
			),
		),
	);
	restore();
}
