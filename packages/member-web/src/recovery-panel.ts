import type {
	MemberBrowserGrantStatus,
	MemberBrowserProfileCatalog,
} from "@qorpera/cloud-client/cloud-company-computer-browser-profiles";
import type { CloudCompanyComputerPrivacyStatus } from "@qorpera/cloud-client/cloud-company-computer-sign-in";
import type { MemberBrowserRecoveryCatalog } from "@qorpera/cloud-client/cloud-member-browser-recovery";
import { MemberBrowserRecoverySession } from "@qorpera/cloud-client/member-browser-recovery-session";
import type { WebMemberAccount } from "./account.ts";
import { button, element, type Work } from "./dom.ts";

export async function showRecoveryPanel(options: {
	root: HTMLElement;
	account: WebMemberAccount;
	work: Work;
	current(): void;
	status(message: string): void;
}): Promise<() => void> {
	const { root, account, work, current, status } = options,
		context = account.recovery(),
		stop = new AbortController(),
		signal = AbortSignal.any([context.signal, stop.signal]);
	const live = () => {
		signal.throwIfAborted();
		context.current();
		current();
	};
	const session = new MemberBrowserRecoverySession({ ...context, signal, current: live });
	const action = async <T>(value: unknown): Promise<T> => {
		const result = await session.action(value);
		live();
		return result as T;
	};
	const offices = element("div"),
		details = element("section");
	let catalog: MemberBrowserRecoveryCatalog;
	async function refresh(after: string | null = null) {
		catalog = await action({ method: "offices", after });
		offices.replaceChildren();
		details.replaceChildren();
		for (const office of catalog.offices)
			offices.append(
				button(
					`Computer ${office.scope.companyComputerId.slice(-12)}`,
					async () => {
						await action({ method: "selectOffice", companyComputerId: office.scope.companyComputerId });
						await profiles();
					},
					work,
				),
			);
		if (!catalog.offices.length)
			offices.append(element("p", "No browser profiles or private sessions need cleanup."));
		if (catalog.nextAfter) offices.append(button("More computers", async () => refresh(catalog.nextAfter), work));
	}
	async function profiles(after: string | null = null) {
		const privacy = await action<CloudCompanyComputerPrivacyStatus | null>({ method: "privacy" });
		const { catalog: page } = await action<{ catalog: MemberBrowserProfileCatalog }>({ method: "profiles", after });
		details.replaceChildren(
			element("h2", "Your browser access"),
			button("Refresh this computer", async () => profiles(), work),
		);
		if (privacy?.challenge && ["entering", "private"].includes(privacy.state))
			details.append(
				button(
					"Finish your private sign-in",
					async () => {
						await action({ method: "finishPrivate" });
						await profiles();
						status("Private sign-in closure requested. Refresh to check completion.");
					},
					work,
				),
			);
		for (const profile of page.profiles) {
			const row = element("div", undefined, element("h3", profile.label));
			details.append(row);
			if (!profile.activeStaffAgentId) {
				row.append(element("p", "No active browser consent."));
				continue;
			}
			const grant = await action<MemberBrowserGrantStatus>({
				method: "browserGrant",
				profileId: profile.profileId,
				staffAgentId: profile.activeStaffAgentId,
			});
			if (grant.grant?.state === "active")
				row.append(
					button(
						"Revoke browser consent",
						async () => {
							// Several rows share this session. Select this exact grant again,
							// retaining the member's displayed observation as the mutation fence.
							const fresh = await action<MemberBrowserGrantStatus>({
								method: "browserGrant",
								profileId: grant.profile.profileId,
								staffAgentId: grant.staffAgentId,
							});
							if (
								fresh.profile.version !== grant.profile.version ||
								fresh.grant?.grantId !== grant.grant!.grantId ||
								fresh.grant?.version !== grant.grant!.version ||
								fresh.grant?.profileVersion !== grant.grant!.profileVersion ||
								fresh.grant?.state !== "active"
							)
								throw new Error("Browser consent changed. Refresh this computer before revoking it.");
							await action({
								method: "configureBrowser",
								profileId: grant.profile.profileId,
								profileVersion: grant.profile.version,
								staffAgentId: grant.staffAgentId,
								expectedVersion: grant.grant!.version,
								enabled: false,
							});
							await profiles();
							status("Browser consent revoked.");
						},
						work,
					),
				);
		}
		if (page.nextAfter) details.append(button("More profiles", async () => profiles(page.nextAfter), work));
	}
	root.replaceChildren(
		element("h2", "Browser access cleanup"),
		element("p", "Revoke your browser consent or finish your private sign-in, including in companies you have left."),
		button("Refresh computers", async () => refresh(), work),
		offices,
		details,
	);
	try {
		await refresh();
		return () => stop.abort();
	} catch (error) {
		stop.abort();
		throw error;
	}
}
