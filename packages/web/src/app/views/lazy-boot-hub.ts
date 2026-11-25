// WHY: Re-exporting boot modules already loaded by main.ts collapses esbuild's combinatorial preload split across lazy barrels.
import { takeChatGptPlanReturn } from "../../cloud/chatgpt-plan-sign-in.ts";
import { createWebCompanyAgents } from "../../cloud/company-agents.ts";
import { WebCompanyFiles } from "../../cloud/company-files.ts";
import { createWebConnectors } from "../../cloud/connectors.ts";
import { createWebEventHooks } from "../../cloud/event-hooks.ts";
import { GeminiKeyInvalidError } from "../../cloud/gemini-key.ts";
import { createWebNativeSubscription } from "../../cloud/native-subscription.ts";
import { createWebRoutines } from "../../cloud/routines.ts";
import { createWebSessionAttachments } from "../../cloud/session-attachments.ts";
import { createWebSessionModel } from "../../cloud/session-model.ts";
import { installHoverGlides } from "../../ui/hover-glide.ts";
import { PICTURE_SIZE } from "../../ui/picture-file.ts";
import { RailLayout } from "../../ui/rail-layout.ts";
import { AuthController } from "../auth.ts";
import { CompanyController } from "../company.ts";
import { CompanyMail } from "../company-mail.ts";
import { DATA_PAGE } from "../data-page.ts";
import { folderImageReader } from "../folder-images.ts";
import { setFoundingIntent } from "../founding-intent.ts";
import { CompanyApps } from "../interface-apps.ts";
import { companyInterfaces } from "../interfaces.ts";
import { OpenQuestions } from "../open-questions.ts";
import { SurfacesStore } from "../surfaces-store.ts";
import { createGroupUpdater } from "../update-group.ts";
import { savedAgentDraft } from "./agent-edits.ts";
import { AppPanel } from "./app-panel.ts";
import { ConversationView } from "./conversation.ts";
import { takeGoodWillReturn } from "./good-will-format.ts";
import { renderNewCompany } from "./new-company.ts";
import { whatsNewEntry } from "./release-desk.ts";
import { renderRail } from "./shell.ts";
import { landStartCrown } from "./start-crown.ts";

export const _bootHub = [
	AuthController,
	CompanyController,
	CompanyMail,
	CompanyApps,
	SurfacesStore,
	OpenQuestions,
	RailLayout,
	AppPanel,
	ConversationView,
	WebCompanyFiles,
	renderRail,
	renderNewCompany,
	landStartCrown,
	takeChatGptPlanReturn,
	takeGoodWillReturn,
	createWebCompanyAgents,
	createWebConnectors,
	createWebEventHooks,
	createWebNativeSubscription,
	createWebRoutines,
	createWebSessionAttachments,
	createWebSessionModel,
	companyInterfaces,
	createGroupUpdater,
	folderImageReader,
	installHoverGlides,
	whatsNewEntry,
	DATA_PAGE,
	GeminiKeyInvalidError,
	PICTURE_SIZE,
	setFoundingIntent,
	savedAgentDraft,
] as const;
