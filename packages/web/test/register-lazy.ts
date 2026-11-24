import { registerLazyApplicationModules } from "../src/app/application.ts";
import * as accountView from "../src/app/views/account.ts";
import * as agentDetails from "../src/app/views/agent-details.ts";
import * as companyFolder from "../src/app/views/company-folder.ts";
import { ComputerPanels } from "../src/app/views/computer.ts";
import { registerLazyComputerModule } from "../src/app/views/computer-lazy.ts";
import * as concepts from "../src/app/views/concepts.ts";
import { registerLazyConversationModules } from "../src/app/views/conversation.ts";
import * as feedbackView from "../src/app/views/feedback.ts";
import * as friendsWindow from "../src/app/views/friends-window.ts";
import * as groupDetails from "../src/app/views/group-details.ts";
import * as memberChat from "../src/app/views/member-chat.ts";
import * as newConversation from "../src/app/views/new-conversation.ts";
import { SearchWindow } from "../src/app/views/search-window.ts";
import * as settingsView from "../src/app/views/settings.ts";
import * as goodWillView from "../src/app/views/settings-good-will.ts";
import { registerLazyShellModules } from "../src/app/views/shell.ts";
import * as surfaceMigrationSheet from "../src/app/views/surface-migration-sheet.ts";
import * as surfaceView from "../src/app/views/surface-view.ts";
import * as teamView from "../src/app/views/team.ts";
import * as whatsNew from "../src/app/views/whats-new.ts";
import { WebCompanyComputer } from "../src/cloud/computer.ts";

registerLazyApplicationModules({
	companyFolder,
	concepts,
	surfaceView,
	settingsView,
	friendsWindow,
	feedbackView,
	accountView: { renderAccount: accountView.renderAccount, MyGoodWillView: goodWillView.MyGoodWillView },
	teamView,
	memberChat,
	newConversation,
	whatsNew,
	agentDetails,
	groupDetails,
});

registerLazyConversationModules({
	AgentDetails: agentDetails.AgentDetails,
	GroupDetails: groupDetails.GroupDetails,
});

registerLazyComputerModule(ComputerPanels, WebCompanyComputer);
registerLazyShellModules({ SearchWindow, surfaceMigrationSheet });
