import type { Cloud } from "./client.ts";
import {
	array,
	boundedInteger,
	CloudShapeError,
	nonEmptyString,
	parseCreatedCompany,
	record,
	timestamp,
	uuid,
} from "./parse.ts";
import type { CreatedCompanyResult } from "./types.ts";

export interface FounderSeat {
	userId: string;
	displayName: string;
	email: string;
	state: "invited" | "joined" | "declined";
	roleDescription: string;
	readyRevision: number | null;
	modelAccountReady: boolean;
	computerPoolEnabled: boolean;
}

export interface CompanyFounding {
	schema: "qorpera.company-founding/v1";
	profileId: string;
	environmentId: string;
	companyName: string;
	description: string;
	phase: "open" | "launched" | "cancelled";
	revision: number;
	bootstrapState: "queued" | "leased" | "completed" | "blocked";
	computerUsageOwnerUserId: string;
	seats: FounderSeat[];
	computerUsage: { canStart: boolean; checkoutAvailable?: boolean };
	launch: {
		receiptId: string;
		revision: number;
		launchedByUserId: string;
		launchedAt: string;
		kickoffInputId: string;
		turnRequestId: string;
	} | null;
	canManage: boolean;
}

export interface FoundingInvitation {
	profileId: string;
	companyName: string;
	invitedByDisplayName: string;
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw new CloudShapeError("founding permission");
	return value;
}

function prose(value: unknown): string {
	if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 16384)
		throw new CloudShapeError("founding description");
	return value;
}

function revision(value: unknown): number {
	return boundedInteger(value, "founding revision", 0, Number.MAX_SAFE_INTEGER);
}

export function parseCompanyFounding(value: unknown): CompanyFounding {
	const input = record(value, "company founding");
	if (
		input.schema !== "qorpera.company-founding/v1" ||
		(input.phase !== "open" && input.phase !== "launched" && input.phase !== "cancelled") ||
		(input.bootstrapState !== "queued" &&
			input.bootstrapState !== "leased" &&
			input.bootstrapState !== "completed" &&
			input.bootstrapState !== "blocked")
	)
		throw new CloudShapeError("company founding state");
	const seats = array(input.seats, "founder seats").map((value): FounderSeat => {
		const seat = record(value, "founder seat");
		if (seat.state !== "invited" && seat.state !== "joined" && seat.state !== "declined")
			throw new CloudShapeError("founder participation");
		return {
			userId: uuid(seat.userId, "founder id"),
			displayName: nonEmptyString(seat.displayName, "founder name", 256),
			email: nonEmptyString(seat.email, "founder email", 320),
			state: seat.state,
			roleDescription: prose(seat.roleDescription),
			readyRevision: seat.readyRevision === null ? null : revision(seat.readyRevision),
			modelAccountReady: boolean(seat.modelAccountReady),
			computerPoolEnabled: boolean(seat.computerPoolEnabled),
		};
	});
	if (new Set(seats.map((seat) => seat.userId)).size !== seats.length) throw new CloudShapeError("duplicate founder");
	const launch = input.launch === null ? null : record(input.launch, "founding launch");
	const computerUsage = record(input.computerUsage, "computer usage");
	return {
		schema: input.schema,
		profileId: uuid(input.profileId, "founding company"),
		environmentId: uuid(input.environmentId, "founding environment"),
		companyName: nonEmptyString(input.companyName, "company name", 120),
		description: prose(input.description),
		phase: input.phase,
		revision: revision(input.revision),
		bootstrapState: input.bootstrapState,
		computerUsageOwnerUserId: uuid(input.computerUsageOwnerUserId, "Computer Usage owner"),
		seats,
		computerUsage: {
			canStart: boolean(computerUsage.canStart),
			...(computerUsage.checkoutAvailable === undefined
				? {}
				: { checkoutAvailable: boolean(computerUsage.checkoutAvailable) }),
		},
		launch: launch
			? {
					receiptId: uuid(launch.receiptId, "launch receipt"),
					revision: revision(launch.revision),
					launchedByUserId: uuid(launch.launchedByUserId, "launcher"),
					launchedAt: timestamp(launch.launchedAt, "launch time"),
					kickoffInputId: uuid(launch.kickoffInputId, "kickoff input"),
					turnRequestId: uuid(launch.turnRequestId, "kickoff request"),
				}
			: null,
		canManage: boolean(input.canManage),
	};
}

/** Founding is server authority; the client never grants ownership or queues an agent itself. */
export class CompanyFoundingApi {
	readonly #cloud: Cloud;
	constructor(cloud: Cloud) {
		this.#cloud = cloud;
	}
	begin(clientCreationId: string, companyName: string): Promise<CreatedCompanyResult> {
		return this.#cloud
			.rpc("qorpera_begin_company_founding", {
				p_client_creation_id: uuid(clientCreationId, "creation id"),
				p_company_name: companyName.trim(),
				p_contract_version: 2,
			})
			.then(parseCreatedCompany);
	}
	read(profileId: string): Promise<CompanyFounding> {
		return this.#call("qorpera_read_company_founding", profileId);
	}
	update(profileId: string, expectedRevision: number, name: string, description: string): Promise<CompanyFounding> {
		return this.#call("qorpera_update_company_founding", profileId, {
			p_expected_revision: revision(expectedRevision),
			p_name: name.trim(),
			p_description: description.trim(),
		});
	}
	invite(profileId: string, expectedRevision: number, friendUserId: string): Promise<CompanyFounding> {
		return this.#call("qorpera_invite_company_founder", profileId, {
			p_expected_revision: revision(expectedRevision),
			p_friend_user_id: uuid(friendUserId, "friend id"),
		});
	}
	async respond(profileId: string, accept: boolean): Promise<void> {
		const id = uuid(profileId, "company id");
		const result = await this.#cloud.rpc("qorpera_respond_company_founding", { p_profile_id: id, p_accept: accept });
		if (accept) {
			if (parseCompanyFounding(result).profileId !== id) throw new CloudShapeError("joined company");
		} else {
			const receipt = record(result, "declined founding invitation");
			if (receipt.state !== "declined" || uuid(receipt.profileId, "declined company") !== id)
				throw new CloudShapeError("declined company");
		}
	}
	ready(
		profileId: string,
		expectedRevision: number,
		ready: boolean,
		roleDescription: string,
	): Promise<CompanyFounding> {
		return this.#call("qorpera_set_founder_ready", profileId, {
			p_expected_revision: revision(expectedRevision),
			p_ready: ready,
			p_role_description: roleDescription.trim(),
		});
	}
	async setComputerPool(profileId: string, enabled: boolean): Promise<void> {
		await this.#cloud.rpc("qorpera_set_company_computer_pool", {
			p_profile_id: uuid(profileId, "company id"),
			p_enabled: enabled,
		});
	}
	async acceptComputerUsageOwnership(profileId: string, expectedOwnerUserId: string): Promise<void> {
		const id = uuid(profileId, "company id");
		const receipt = record(
			await this.#cloud.rpc("qorpera_accept_computer_usage_ownership", {
				p_profile_id: id,
				p_expected_owner_user_id: uuid(expectedOwnerUserId, "current Computer Usage owner"),
			}),
			"Computer Usage ownership receipt",
		);
		if (uuid(receipt.profile_id, "company id") !== id) throw new CloudShapeError("Computer Usage company");
		uuid(receipt.computer_usage_owner_user_id, "Computer Usage owner");
	}
	async leave(profileId: string, expectedRevision: number, userId: string): Promise<void> {
		const id = uuid(profileId, "company id");
		const receipt = record(
			await this.#cloud.rpc("qorpera_remove_company_founder", {
				p_profile_id: id,
				p_expected_revision: revision(expectedRevision),
				p_user_id: uuid(userId, "founder id"),
			}),
			"founding departure",
		);
		if (receipt.state !== "left" || uuid(receipt.profileId, "departed company") !== id)
			throw new CloudShapeError("founding departure");
	}
	remove(profileId: string, expectedRevision: number, userId: string): Promise<CompanyFounding> {
		return this.#call("qorpera_remove_company_founder", profileId, {
			p_expected_revision: revision(expectedRevision),
			p_user_id: uuid(userId, "founder id"),
		});
	}
	launch(profileId: string, expectedRevision: number, clientLaunchId: string): Promise<CompanyFounding> {
		return this.#call("qorpera_launch_company_founding", profileId, {
			p_expected_revision: revision(expectedRevision),
			p_client_launch_id: uuid(clientLaunchId, "launch id"),
		});
	}
	async invitations(): Promise<FoundingInvitation[]> {
		return array(await this.#cloud.rpc("qorpera_list_company_founding_invitations"), "founding invitations").map(
			(value) => {
				const invite = record(value, "founding invitation");
				return {
					profileId: uuid(invite.profileId, "invited company"),
					companyName: nonEmptyString(invite.companyName, "company name", 120),
					invitedByDisplayName: nonEmptyString(invite.invitedByDisplayName, "inviter", 256),
				};
			},
		);
	}
	async #call(method: string, profileId: string, args: Record<string, unknown> = {}): Promise<CompanyFounding> {
		const id = uuid(profileId, "company id");
		const result = parseCompanyFounding(await this.#cloud.rpc(method, { p_profile_id: id, ...args }));
		if (result.profileId !== id) throw new CloudShapeError("founding company identity");
		return result;
	}
}
