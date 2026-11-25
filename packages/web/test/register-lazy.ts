import { registerLazyApplicationModules } from "../src/app/application.ts";
import { ComputerPanels } from "../src/app/views/computer.ts";
import { registerLazyComputerModule } from "../src/app/views/computer-lazy.ts";
import { registerLazyConversationModules } from "../src/app/views/conversation.ts";
import * as secondaryViews from "../src/app/views/lazy-secondary.ts";
import { registerLazyShellModules } from "../src/app/views/shell.ts";
import * as surfaceView from "../src/app/views/surface-view.ts";
import { WebCompanyComputer } from "../src/cloud/computer.ts";

registerLazyApplicationModules({
	secondaryViews,
	surfaceView,
});

registerLazyConversationModules({
	AgentDetails: secondaryViews.agentDetails.AgentDetails,
	GroupDetails: secondaryViews.groupDetails.GroupDetails,
});

registerLazyComputerModule(ComputerPanels, WebCompanyComputer);
registerLazyShellModules({
	SearchWindow: secondaryViews.searchWindow.SearchWindow,
	surfaceMigrationSheet: secondaryViews.surfaceMigrationSheet,
});
