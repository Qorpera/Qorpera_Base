/* Danish interface text, keyed by the English source exactly as the code
 * passes it to t() / uiText(). One file per area of the app; a key lives in
 * one file only (test/translations.test.ts checks). Wording follows
 * qorpera.com. */
/** The frame: rail, hub, new conversation, sign-in, approvals, computer, dialogs. */
export const WORKSPACE: Record<string, string> = {
	// app/application.ts
	"Company navigation": "Virksomhedsnavigation",
	"Close company navigation": "Luk virksomhedsnavigation",
	"Company access is unavailable.": "Adgang til virksomheden er ikke tilgængelig.",
	"The conversation destination changed. Refresh before sending.":
		"Samtalens modtager er ændret. Opdater, før du sender.",
	"This agent is not available in the company.": "Denne agent er ikke tilgængelig i virksomheden.",
	"Connecting to the cloud": "Forbinder til skyen",
	"This company is not available to your account.": "Denne virksomhed er ikke tilgængelig for din konto.",
	"Back to companies": "Tilbage til virksomheder",
	"Your access to this company was revoked.": "Din adgang til denne virksomhed er blevet fjernet.",
	"Company notification access changed.": "Adgangen til virksomhedens notifikationer er ændret.",
	"Only an owner or admin can change agents.": "Kun en ejer eller administrator kan ændre agenter.",
	"Company access changed.": "Adgangen til virksomheden er ændret.",
	"Conversation access changed.": "Adgangen til samtalen er ændret.",
	"Only an owner or admin can create a group chat.": "Kun en ejer eller administrator kan oprette en gruppechat.",
	"Group chat creation access changed.": "Adgangen til at oprette gruppechats er ændret.",
	"Opening company": "Åbner virksomhed",
	"Opening the Co-Founder": "Åbner Co-Founder",
	"Start with {agent} or pick a conversation in the rail.": "Start med {agent}, eller vælg en samtale i sidepanelet.",
	"This company has no staff conversations yet.": "Denne virksomhed har ingen samtaler med agenter endnu.",
	"Only an owner or admin can edit group chats.": "Kun en ejer eller administrator kan redigere gruppechats.",
	"Group chat editing access changed.": "Adgangen til at redigere gruppechats er ændret.",
	"Attachment access changed.": "Adgangen til den vedhæftede fil er ændret.",
	"This attachment is not available for preview.": "Denne vedhæftede fil kan ikke vises.",
	"Opening conversation": "Åbner samtale",
	"Company File access changed.": "Adgangen til Virksomhedsfilen er ændret.",

	// app/auth.ts
	"Sign-in could not be completed. Request a new email code in this browser.":
		"Du kunne ikke logges ind. Bed om en ny kode på e-mail i denne browser.",
	"Enter a valid email address.": "Skriv en gyldig e-mailadresse.",
	"Check your email. Enter the code below, or open the sign-in link on this device.":
		"Tjek din e-mail. Skriv koden herunder, eller åbn login-linket på denne enhed.",
	"This sign-in provider is unavailable. Continue with email.":
		"Denne loginmetode er ikke tilgængelig. Fortsæt med e-mail.",
	Member: "Medlem",

	// app/start-conversation.ts
	"Wait for this conversation to finish opening.": "Vent, til samtalen er åbnet.",
	"You do not have permission to send messages in this company.":
		"Du har ikke tilladelse til at sende beskeder i denne virksomhed.",
	"Choose active agents from this company before sending.": "Vælg aktive agenter fra denne virksomhed, før du sender.",
	"Enter a message of no more than 64 KiB.": "Skriv en besked på højst 64 KiB.",
	"Connect a model account in Settings → Connections to send messages.":
		"Forbind en modelkonto i Indstillinger → Forbindelser for at sende beskeder.",
	"Group chat review changed kind.": "Gennemgangen af gruppechatten skiftede type.",
	"The group chat could not be created. Your message is still here.":
		"Gruppechatten kunne ikke oprettes. Din besked er her stadig.",
	"The group chat directory is unavailable.": "Mappen til gruppechats er ikke tilgængelig.",
	"The group chat changed. Start a new conversation.": "Gruppechatten er ændret. Start en ny samtale.",
	"The group chat path is unavailable.": "Stien til gruppechatten er ikke tilgængelig.",
	"The group chat is still opening. Send again to retry the same conversation.":
		"Gruppechatten åbner stadig. Send igen for at prøve den samme samtale igen.",
	"No model account is currently available. Try again after an account resets.":
		"Ingen modelkonto er ledig lige nu. Prøv igen, når en konto nulstilles.",
	"Open the existing conversation to finish its pending message before sending another.":
		"Åbn den eksisterende samtale, og gør dens ventende besked færdig, før du sender en ny.",
	"This conversation has an unsent draft. Open it to finish or clear that draft before sending another.":
		"Denne samtale har en usendt kladde. Åbn den, og gør kladden færdig eller ryd den, før du sender en ny.",

	// app/views/shell.ts
	"Profile: {name}": "Profil: {name}",
	"← Companies": "← Virksomheder",
	"Search agents": "Søg efter agenter",
	"New conversation or agent": "Ny samtale eller agent",
	company: "virksomhed",
	"No matching conversations.": "Ingen samtaler matcher.",
	"No agents yet.": "Ingen agenter endnu.",
	"Retry conversations": "Hent samtaler igen",
	"Retry company": "Hent virksomhed igen",
	connecting: "forbinder",
	"live updates degraded": "liveopdateringer virker ikke helt",

	// app/views/hub.ts
	owner: "ejer",
	admin: "administrator",
	contributor: "bidragyder",
	viewer: "læser",
	"Resume the pending company creation before starting another.":
		"Gør oprettelsen af den ventende virksomhed færdig, før du starter en ny.",
	"The cloud could not provision the company's Company File.": "Skyen kunne ikke oprette Virksomhedsfilen.",
	"The company is still being created. Resume to check its progress.":
		"Virksomheden bliver stadig oprettet. Genoptag for at se, hvor langt den er.",
	"Invited as {role} · expires {date}": "Inviteret som {role} · udløber {date}",
	Accept: "Accepter",
	"{role} · since {date}": "{role} · siden {date}",
	"Company name": "Virksomhedsnavn",
	"Creating {name}": "Opretter {name}",
	"Creating the company": "Opretter virksomheden",
	"Seeding its Company File and Co-Founder.": "Opretter Virksomhedsfilen og Co-Founder.",
	"You have been invited": "Du er blevet inviteret",
	"Start your first company": "Start din første virksomhed",
	"Join a company you have been invited to, or start one of your own.":
		"Bliv en del af en virksomhed, du er inviteret til, eller start din egen.",
	"Give it a name. Qorpera creates its Company File and a Co-Founder who begins work straight away.":
		"Giv den et navn. Qorpera opretter Virksomhedsfilen og en Co-Founder, der går i gang med det samme.",
	or: "eller",
	"Create company": "Opret virksomhed",
	"Resume creating {name}": "Genoptag oprettelsen af {name}",
	"Invited to a company? It appears here the moment someone adds you.":
		"Inviteret til en virksomhed? Den vises her, så snart nogen tilføjer dig.",
	"New company": "Ny virksomhed",
	Create: "Opret",
	"Seeds a Company File and a Co-Founder": "Opretter en Virksomhedsfil og en Co-Founder",
	"Loading companies": "Henter virksomheder",

	// app/views/new-conversation.ts
	"Selected recipients": "Valgte modtagere",
	"Message…": "Besked…",
	"Send message": "Send besked",
	"Search or create agents": "Søg efter eller opret agenter",
	"Search conversation recipients": "Søg efter modtagere til samtalen",
	"To:": "Til:",
	"Close new conversation": "Luk ny samtale",
	"New agent “{name}”": "Ny agent “{name}”",
	"New group chat": "Ny gruppechat",
	"Add agents": "Tilføj agenter",
	"No agents match.": "Ingen agenter matcher.",
	"Remove {name}": "Fjern {name}",
	"Starting conversation…": "Starter samtale…",
	"The conversation could not be started. Your draft is still here.":
		"Samtalen kunne ikke startes. Din kladde er her stadig.",
	"Agent name": "Agentnavn",
	"For example, Research": "For eksempel Forskning",
	"Agent title": "Agentens titel",
	"What should this agent be responsible for?": "Hvad skal denne agent have ansvar for?",
	"Agent responsibilities": "Agentens ansvarsområder",
	Name: "Navn",
	Title: "Titel",
	Responsibilities: "Ansvarsområder",
	"The agent was created. Retry adding it once the agent list is available.":
		"Agenten blev oprettet. Prøv at tilføje den igen, når listen over agenter er klar.",
	"Agent creation is not available yet.": "Oprettelse af agenter er ikke tilgængelig endnu.",
	"Add created agent": "Tilføj den oprettede agent",
	"Create agent": "Opret agent",
	"Create an agent": "Opret en agent",
	"Enter a name and title.": "Skriv et navn og en titel.",
	"Creating agent…": "Opretter agent…",
	"Creation could not be confirmed. Retry to check the same agent.":
		"Oprettelsen kunne ikke bekræftes. Prøv igen for at kontrollere den samme agent.",
	"Check agent creation": "Kontroller agentoprettelse",
	"Agent creation was rejected. Your draft is still here and can be edited.":
		"Agentoprettelsen blev afvist. Din kladde er her stadig og kan redigeres.",
	"Agent details are too long or invalid. Shorten them and try again.":
		"Agentoplysningerne er for lange eller ugyldige. Gør dem kortere, og prøv igen.",

	// app/views/signin.ts
	"Continue with {provider}": "Fortsæt med {provider}",
	"you@company.com": "dig@firma.dk",
	"Code from your email": "Kode fra din e-mail",
	"Verification code": "Bekræftelseskode",
	Email: "E-mail",
	"We sent a code to {email}. Enter it here; the link in the same email works only in this browser.":
		"Vi har sendt en kode til {email}. Skriv den her; linket i samme e-mail virker kun i denne browser.",
	"Verify and sign in": "Bekræft og log ind",
	"Continue with email": "Fortsæt med e-mail",
	"Use a different email": "Brug en anden e-mail",
	"One moment…": "Et øjeblik…",
	"Sign in": "Log ind",
	"Your companies and agents, in one place.": "Dine virksomheder og agenter samlet ét sted.",
	"Only your own session lives in this browser; agents run in the cloud.":
		"Kun din egen session ligger i denne browser; agenter kører i skyen.",

	// app/views/approvals.ts

	// app/views/meet.ts
	"This company has no Co-Founder yet. The cloud seeds one when Order 0 bootstraps the company; until then there is no agent to dress.":
		"Denne virksomhed har ingen Co-Founder endnu. Skyen opretter en, når Order 0 starter virksomheden; indtil da er der ingen agent at give et udseende.",
	"Open the company": "Åbn virksomheden",
	"Your journey starts here": "Din rejse starter her",
	"Choose a figure": "Vælg en figur",
	"Saving…": "Gemmer…",
	"Save appearance and continue": "Gem udseende og fortsæt",
	"The appearance change could not be confirmed. Open the company to check it before saving again.":
		"Ændringen af udseendet kunne ikke bekræftes. Åbn virksomheden og tjek det, før du gemmer igen.",
	"Open the company without changing appearance": "Åbn virksomheden uden at ændre udseende",

	// app/views/computer.ts
	"Connecting…": "Forbinder…",
	"Close computer": "Luk computer",
	"{name} · Computer": "{name} · Computer",
	"{name} · Computer {number}": "{name} · Computer {number}",
	"Agent computer": "Agentens computer",
	"Drag to move, drag an edge to resize. When focused, arrow keys move it and plus or minus resize it.":
		"Træk for at flytte, træk i en kant for at ændre størrelse. Med fokus flytter piletasterne den, og plus eller minus ændrer størrelsen.",
	"Computer access is not available yet.": "Adgang til computeren er ikke tilgængelig endnu.",
	"This company has no computer yet.": "Denne virksomhed har ingen computer endnu.",
	"The computer is restarting. It comes back on its own.": "Computeren genstarter. Den kommer tilbage af sig selv.",
	"This computer has been retired.": "Denne computer er taget ud af brug.",
	"The computer is off. An owner or admin can start it.":
		"Computeren er slukket. En ejer eller administrator kan starte den.",
	"You have read-only access. A company member with write access can wake the computer.":
		"Du har kun læseadgang. Et medlem af virksomheden med skriveadgang kan vække computeren.",
	"Starting the computer…": "Starter computeren…",
	"Screen viewing is not set up here.": "Skærmvisning er ikke sat op her.",
	"All screens on this computer are in use. Try again when one is free.":
		"Alle skærme på denne computer er i brug. Prøv igen, når en er ledig.",
	"{name} does not have access to the computer.": "{name} har ikke adgang til computeren.",
	"{name}'s screen is being handed over. It opens here in a moment.":
		"Skærmen for {name} bliver overdraget. Den åbner her om et øjeblik.",
	"The computer is not ready yet.": "Computeren er ikke klar endnu.",
	"The computer is private right now. Shared viewing returns when that ends.":
		"Computeren er privat lige nu. Delt visning kommer tilbage, når det slutter.",
	"The computer could not be reached. Try again.": "Computeren kunne ikke nås. Prøv igen.",
	"Every computer is in use. An owner or admin can add another one.":
		"Alle computere er i brug. En ejer eller administrator kan tilføje en mere.",
	"Setting up another computer. This can take a while.": "Sætter en computer mere op. Det kan tage et stykke tid.",
	"Waiting for room on our servers. It starts as soon as there is room.":
		"Venter på plads på vores servere. Den starter, så snart der er plads.",

	// app/views/feedback.ts
	"+ Bug": "+ Fejl",
	"+ Bad result": "+ Dårligt resultat",
	"+ Good result": "+ Godt resultat",
	"+ Feature request": "+ Funktionsønske",
	"+ Performance": "+ Ydeevne",
	"+ Other": "+ Andet",
	"Feedback details": "Feedbackdetaljer",
	"Share details (required)": "Del detaljer (påkrævet)",
	Submit: "Send",
	"Feedback category": "Feedbackkategori",
	"Close feedback": "Luk feedback",
	"Sending…": "Sender…",
	"Feedback sent. Thank you.": "Feedback sendt. Tak.",

	// ui/dom.ts, ui/dialog.ts, ui/rail-layout.ts
	Loading: "Henter",
	"Type {name} to confirm": "Skriv {name} for at bekræfte",
	"Close {name}": "Luk {name}",
	"Resize company navigation": "Tilpas bredden på virksomhedsnavigationen",
	Compact: "Kompakt",
	"{width} pixels": "{width} pixel",

	// ui/avatar.ts, ui/figure-picker.ts: figure names are the figure ids.
	"Agent figure": "Agentfigur",
	"Agent color": "Agentfarve",
	planet: "planet",
	acorn: "agern",
	flame: "flamme",
	rocket: "raket",
	crown: "krone",
	heart: "hjerte",
	ghost: "spøgelse",
	Charcoal: "Koksgrå",
	Brown: "Brun",
	Coral: "Koral",
	Orange: "Orange",
	Gold: "Guld",
	Teal: "Blågrøn",
	Purple: "Lilla",
	Pink: "Pink",
	Gray: "Grå",
	// ui/computer-viewer.ts: the desktop's screen viewer, translated where it shows
	"Back to thread": "Tilbage til tråden",
	"Checking your private sign-in access": "Tjekker din private login-adgang",
	"Close screen viewer": "Luk skærmen",
	"Cloud screen unavailable. Reconnect to check access again.":
		"Skærmen er ikke tilgængelig. Forbind igen for at tjekke adgangen.",
	"Connecting to cloud desktop": "Forbinder til computeren",
	Connecting: "Forbinder",
	Disconnected: "Afbrudt",
	Enter: "Gå ind",
	"Full screen unavailable": "Fuld skærm er ikke tilgængelig",
	"Private sign-in · Closing this view leaves the office private":
		"Privat login · Lukker du visningen, forbliver kontoret privat",
	Reconnect: "Forbind igen",
	"Release control": "Giv kontrollen tilbage",
	"Shared with the agent": "Delt med agenten",
	"Starting the screen and connecting…": "Starter skærmen og forbinder…",
	"Take control": "Overtag",
	"Waiting for the cloud screen to release agent control": "Venter på, at agenten slipper kontrollen",
	"Watching only": "Ser kun med",
	"You control this cloud screen": "Du styrer skærmen",
	"Opening Company File": "Åbner Virksomhedsfilen",
	"Your membership in this company could not be read.": "Dit medlemskab af virksomheden kunne ikke læses.",
	"The cloud could not be reached. {error}": "Skyen kunne ikke nås. {error}",
	"Loading agents": "Henter agenter",
	// app/views/shell.ts: sections, pins and the right-click menu
	"Only owners, admins and contributors can change the company's sections.":
		"Kun ejere, administratorer og bidragydere kan ændre virksomhedens sektioner.",
	"The sidebar could not be changed. Try again.": "Sidepanelet kunne ikke ændres. Prøv igen.",
	"Pinned agents": "Fastgjorte agenter",
	"Drop here to pin": "Slip her for at fastgøre",
	Unassigned: "Uden sektion",
	"New section": "Ny sektion",
	"Section name": "Sektionens navn",
	"A section called {name} already exists.": "Der findes allerede en sektion, der hedder {name}.",
	Unpin: "Frigør",
	Pin: "Fastgør",
	"Move to": "Flyt til",
	Rename: "Omdøb",
	"Copy conversation ID": "Kopiér samtale-id",
	"The conversation ID could not be copied.": "Samtale-id’et kunne ikke kopieres.",
	"Show in sidebar": "Vis i sidepanelet",
	"Hidden agents": "Skjulte agenter",
	"Hidden agents: {count}": "Skjulte agenter: {count}",
	"Hide from sidebar": "Skjul fra sidepanelet",
	Delete: "Slet",
	"Rename agent": "Omdøb agent",
	"{name} could not be renamed.": "{name} kunne ikke omdøbes.",
	"Delete {name}? The agent leaves the company for everyone, with its conversations and routines. This cannot be undone.":
		"Slet {name}? Agenten forlader virksomheden for alle, med sine samtaler og rutiner. Det kan ikke fortrydes.",
	"{name} could not be deleted. Hand over the projects it leads first.":
		"{name} kunne ikke slettes. Giv først de projekter, den leder, videre.",
	"{name} could not be deleted.": "{name} kunne ikke slettes.",
	"Rename section": "Omdøb sektion",
	"Delete section": "Slet sektion",
	"Delete the section {name}? Its agents move to Unassigned, for everyone in the company.":
		"Slet sektionen {name}? Dens agenter flyttes til Uden sektion for alle i virksomheden.",
	Sidebar: "Sidepanel",
	"{name} actions": "Handlinger for {name}",
	Section: "Sektion",
};
