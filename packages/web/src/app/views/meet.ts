import { describeError } from "../../cloud/client.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentColor, FIGURE_IDS, type FigureId, figureElement, figureFor, nativeColorOf } from "../../ui/avatar.ts";
import { h, notice, replace, spinner } from "../../ui/dom.ts";
import type { CompanyController } from "../company.ts";
import { navigate } from "../router.ts";

/* First run: the company is made, the cloud has seeded its Co-Founder, and
 * this is where the founder gives it a face. The screen is the approved design
 * in `packages/web/design/cofounder-first-run.html`.
 *
 * Every choice here is real cloud state: the figure and colour are the staff
 * record's `appearance_creature` and `appearance_color`, written through
 * qorpera_put_profile_staff. Nothing is rendered when there is no Co-Founder
 * to dress — the screen says so instead of showing a picker that writes
 * nowhere. */

export interface MeetState {
	figure?: FigureId;
	color?: string;
	saving?: boolean;
	error?: string;
}

/** The Co-Founder, from the organization kernel when it answers and from the
 * staff list's template otherwise, so the screen works on a cloud that has
 * seeded the agent but not the kernel. */
export function cofounderOf(company: CompanyController): HostedStaffAgent | undefined {
	const state = company.store.get();
	const fromKernel = state.organization ? company.staffById(state.organization.cofounder.staffAgentId) : undefined;
	return fromKernel ?? state.staff.find((agent) => agent.templateId === "co-founder");
}

export function renderMeet(
	company: CompanyController,
	saveAppearance: (agent: HostedStaffAgent, figure: string, color: string) => Promise<unknown>,
	container: HTMLElement,
	state: MeetState,
	setState: (next: MeetState) => void,
): void {
	const companyState = company.store.get();
	const cofounder = cofounderOf(company);
	const profileId = company.profile.profileId;
	const open = () => navigate({ name: "company", profileId, section: "home" });

	if (!cofounder) {
		// Never a picker with nowhere to write: say what is missing instead.
		replace(
			container,
			h(
				"section",
				{ class: "page" },
				h("h1", null, company.profile.profileName),
				companyState.loading
					? spinner("Opening company")
					: notice(
							"neutral",
							"This company has no Co-Founder yet. The cloud seeds one when Order 0 bootstraps the company; until then there is no agent to dress.",
						),
				h("p", null, h("a", { href: `#/c/${profileId}` }, "Open the company")),
			),
		);
		return;
	}

	// A staff record is a projection of the Company File, so the figure is
	// saved as a governed write of the agent's document. A refusal is reported
	// without automatic retries, and opening the company never depends on it.
	const figure = state.figure ?? figureFor(cofounder);
	// Each figure brings its own shade here, as in the trailer; the colour is
	// chosen later in the agent's details. Until a figure is picked on this
	// page, the Co-Founder keeps the colour it has, so returning here and
	// saving never replaces a colour chosen in the details.
	const color = state.figure ? nativeColorOf(figure) : agentColor(cofounder, figure);
	const canWrite = companyState.team?.capabilities.authorize === true;
	const save = () => {
		if (!canWrite || state.saving) return;
		const route = location.hash;
		setState({ ...state, saving: true, error: undefined });
		void saveAppearance(cofounder, figure, color)
			.then(async () => {
				await company.refreshStaff();
				if (!company.signal.aborted && location.hash === route && container.isConnected) open();
			})
			.catch((error) => setState({ ...state, saving: false, error: describeError(error) }));
	};

	replace(
		container,
		h(
			"section",
			{ class: "meet" },
			h(
				"div",
				{ class: "meet-inner" },
				h("h1", null, "Your journey starts here"),
				h("div", { class: "meet-stage" }, figureElement(figure, color, { size: 190 })),
				h("div", { class: "meet-name" }, cofounder.displayName),
				state.error ? notice("danger", state.error) : null,
				h(
					"div",
					{ class: "figure-grid", role: "radiogroup", "aria-label": "Choose a figure" },
					...FIGURE_IDS.map((id) => {
						const chosen = id === figure;
						const choice = h(
							"button",
							{
								type: "button",
								class: "figure-choice",
								role: "radio",
								"aria-checked": String(chosen),
								"aria-label": id,
								disabled: state.saving === true,
								// Picking a figure brings its own shade with it, as the
								// workspace's own picker does.
								// The figure already shown is no new choice: it keeps its colour.
								onclick: () => (id === figure ? undefined : setState({ ...state, figure: id })),
							},
							// Unchosen figures wear their native shade; only the chosen
							// one carries the selected colour.
							figureElement(id, chosen ? color : undefined, { size: 32, still: true }),
						);
						return choice;
					}),
				),
				canWrite
					? h(
							"button",
							{ type: "button", class: "meet-start", disabled: state.saving === true, onclick: save },
							state.saving ? "Saving…" : "Save appearance and continue",
						)
					: h("button", { type: "button", class: "meet-start", onclick: open }, "Open the company"),
				canWrite
					? h("p", null, h("a", { href: `#/c/${profileId}` }, "Open the company without changing appearance"))
					: null,
			),
		),
	);
}
