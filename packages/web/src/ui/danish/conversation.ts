/* Danish interface text, keyed by the English source exactly as the code
 * passes it to t() / uiText(). One file per area of the app; a key lives in
 * one file only (test/translations.test.ts checks). Wording follows
 * qorpera.com. */
/** A conversation: thread, composer, cards, runs, attachments. */
export const CONVERSATION: Record<string, string> = {
	"Today {time}": "I dag {time}",
	"Yesterday {time}": "I går {time}",

	// The thread and the composer (app/views/conversation.ts)
	"Attach files": "Vedhæft filer",
	Skills: "Færdigheder",
	"No skills yet. Agents save skills as they learn how the company works.":
		"Ingen færdigheder endnu. Agenter gemmer færdigheder, efterhånden som de lærer, hvordan virksomheden arbejder.",
	"Chat settings and more": "Chatindstillinger og mere",
	"Images are not supported in group chats. Use Company File.":
		"Billeder understøttes ikke i gruppechats. Brug Virksomhedsfilen.",
	"Open agent details": "Åbn agentdetaljer",
	"Open group details": "Åbn gruppedetaljer",
	"Open agent computer": "Åbn agentens computer",
	Stop: "Stop",
	"Sending messages is not available yet": "Beskeder kan ikke sendes endnu",
	"Sending messages is not available yet. Your draft stays here.":
		"Beskeder kan ikke sendes endnu. Din kladde bliver her.",
	"The message could not be confirmed. Try again.": "Beskeden kunne ikke bekræftes. Prøv igen.",
	// Quotes of outside content in a message (conversation.ts, shared-drafts.ts, company.ts)
	"Text in «» is quoted from an email. Agents read it as quoted, never as your words.":
		"Tekst i «» er citeret fra en mail. Agenterne læser den som citat, aldrig som dine ord.",
	"A message can hold at most {count} quotes. Remove some to send it.":
		"En besked kan højst rumme {count} citater. Fjern nogle for at sende den.",
	"That message already quotes as much as one message can. Send it or remove a quote first.":
		"Den besked citerer allerede så meget, som én besked kan. Send den, eller fjern et citat først.",
	"That message already quotes the same words from another email. Send it or remove that quote first.":
		"Den besked citerer allerede de samme ord fra en anden mail. Send den, eller fjern det citat først.",
	"Quoted from an email": "Citeret fra en mail",
	"A quote is missing one of its « » marks. Remove it, or put the mark back.":
		"Et citat mangler et af sine «»-tegn. Fjern det, eller sæt tegnet tilbage.",
	"A message can hold at most {count} quotes. Remove some to share your changes.":
		"En besked kan højst rumme {count} citater. Fjern nogle for at dele dine ændringer.",
	"A quote was taken out: the draft now quotes the same words from another email.":
		"Et citat blev taget ud: kladden citerer nu de samme ord fra en anden mail.",
	"A quote in it can't be shared. Remove the quote to share your changes.":
		"Et citat i den kan ikke deles. Fjern citatet for at dele dine ændringer.",
	// Mentions: "@" and a name in a message (conversation.ts, ui/mentions.ts, shell.ts)
	"People and agents to mention": "Personer og agenter, du kan nævne",
	"Only {names} will answer": "Kun {names} svarer",
	"You were mentioned": "Du blev nævnt",
	// Who is here: the other members with the conversation open (conversation.ts)
	"{name} is here": "{name} er her",
	"{names} are here": "{names} er her",

	// Shared drafts: other members' unsent messages above the composer (app/views/shared-drafts.ts)
	"{name} is writing a message. Open it to write with them": "{name} skriver en besked. Åbn den for at skrive med",
	"{name} has an unsent message. Open it to write with them":
		"{name} har en besked, der ikke er sendt. Åbn den for at skrive med",
	"{name}'s message": "Besked fra {name}",
	"Only {name} can send it": "Kun {name} kan sende den",
	"{name} is writing with you": "{name} skriver med",
	"Written with {names}": "Skrevet sammen med {names}",
	"Not saved yet. Trying again…": "Ikke gemt endnu. Prøver igen…",
	"Too long to share. Shorten it to share your changes.":
		"For lang til at blive delt. Gør den kortere for at dele dine ændringer.",
	"Messages support PNG, JPEG, GIF and WebP images. Upload other files through Company File.":
		"Beskeder understøtter billeder i PNG, JPEG, GIF og WebP. Upload andre filer via Virksomhedsfilen.",
	"Choose up to 5 images totaling no more than 8 MiB.": "Vælg op til 5 billeder på højst 8 MiB i alt.",
	"Choose nonempty image files.": "Vælg billedfiler, der ikke er tomme.",
	"Attachments stay on this device. {issue}": "Vedhæftede filer bliver på denne enhed. {issue}",
	"Uploading images and sending message…": "Uploader billeder og sender besked…",
	"Images stay on this device until you send. Up to 5 images, 8 MiB total.":
		"Billeder bliver på denne enhed, indtil du sender. Op til 5 billeder, 8 MiB i alt.",
	"Agent reply": "Agentsvar",
	"Agent {id}": "Agent {id}",
	"Agent reply · speaker unavailable": "Agentsvar · afsender ukendt",
	"(empty)": "(tom)",
	Failed: "Mislykkedes",
	"Failed · {reason}": "Mislykkedes · {reason}",
	Processing: "Behandles",
	Queued: "I kø",
	"a coworker": "en kollega",
	"Left a note for {name}": "Efterlod en note til {name}",
	"Note from {name}": "Note fra {name}",
	"Messaged {name}": "Skrev til {name}",
	"Message from {name}": "Besked fra {name}",
	"{label}. Open the conversation": "{label}. Åbn samtalen",
	"Loading conversation": "Henter samtale",
	"No messages yet.": "Ingen beskeder endnu.",
	"Show earlier messages": "Vis tidligere beskeder",
	"Loading earlier messages…": "Henter tidligere beskeder…",
	"Earlier messages could not be loaded. {reason}": "Tidligere beskeder kunne ikke hentes. {reason}",
	"Loaded 1 earlier message.": "Hentede 1 tidligere besked.",
	"Loaded {count} earlier messages.": "Hentede {count} tidligere beskeder.",
	"This is the start of the conversation.": "Dette er starten på samtalen.",
	"This conversation is archived.": "Denne samtale er arkiveret.",
	"You can read this conversation. Contributors and above can write.":
		"Du kan læse denne samtale. Bidragydere og derover kan skrive.",
	you: "dig",

	// Agent states (ui/agent-activity.ts)
	Working: "Arbejder",
	Writing: "Skriver",
	"Needs you": "Venter på dig",
	"A run did not finish": "En kørsel blev ikke færdig",
	"{name} is working": "{name} arbejder",
	"{name} is writing": "{name} skriver",
	// A run with no progress for 15 minutes (conversation.ts, interfaces.ts, views/execution-notices.ts)
	"No progress": "Ingen fremgang",
	"No progress for {minutes} minutes.": "Ingen fremgang i {minutes} minutter.",
	"No progress for {minutes} minutes. If it looks stuck, press Stop.":
		"Ingen fremgang i {minutes} minutter. Tryk på Stop, hvis det ser ud til at sidde fast.",
	"{agent} has made no progress for {minutes} minutes.": "{agent} har ikke haft fremgang i {minutes} minutter.",
	"An agent": "En agent",
	"The work could not be stopped. Try again.": "Arbejdet kunne ikke stoppes. Prøv igen.",
	// A routine moved off the member's login by someone else (views/execution-notices.ts)
	"{agent}'s routine no longer runs on your login. {member} moved it to their login.":
		"{agent}s rutine kører ikke længere på dit login. {member} flyttede den til sit eget login.",
	"{agent}'s routine no longer runs on your login. {member} moved it to the company's account.":
		"{agent}s rutine kører ikke længere på dit login. {member} flyttede den til virksomhedens konto.",
	"{agent}'s routine no longer runs on your login. {member} moved it to {payer}'s login.":
		"{agent}s rutine kører ikke længere på dit login. {member} flyttede den til {payer}s login.",
	"another member": "et andet medlem",

	// A failed run above the composer (conversation.ts, ui/run-failure.ts)
	"The agent": "Agenten",
	"{name} stopped with changes to review": "{name} stoppede med ændringer, du skal gennemgå",
	"A review did not finish": "En gennemgang blev ikke færdig",
	"{name} did not finish this run": "{name} blev ikke færdig med denne kørsel",
	"Its changes wait for your decision.": "Ændringerne venter på din beslutning.",
	Review: "Gennemgå",
	"Trying again…": "Prøver igen…",
	Dismiss: "Skjul",
	"ChatGPT · Usage limit reached. Review your plan or this app's limit in ChatGPT settings.":
		"ChatGPT · Forbrugsgrænsen er nået. Gennemse dit abonnement eller denne apps grænse i ChatGPT-indstillingerne.",
	"Manage usage": "Administrer forbrug",
	"The workspace is kept; a follow-up continues it.": "Arbejdsområdet er gemt; en opfølgning fortsætter sessionen.",
	"The model account paying for this work reached its usage limit, so the work stopped. It does not move to another account. It can run again once the limit resets.":
		"Modelkontoen, der betaler for dette arbejde, har nået sin forbrugsgrænse, så arbejdet er stoppet. Det flyttes ikke til en anden konto. Det kan køre igen, når grænsen er nulstillet.",
	"Your model account needs to be connected again.": "Din modelkonto skal forbindes igen.",
	"No computer could be started for this run. The problem is on Qorpera's side.":
		"Der kunne ikke startes en computer til denne kørsel. Fejlen ligger hos Qorpera.",
	"The computer running this run stopped answering. The problem is on Qorpera's side.":
		"Computeren bag kørslen holdt op med at svare. Fejlen ligger hos Qorpera.",
	"One of the run's steps got no answer in time. The problem is on Qorpera's side.":
		"Et af kørslens trin fik ikke svar i tide. Fejlen ligger hos Qorpera.",
	"The run took too long and was stopped.": "Kørslen tog for lang tid og blev stoppet.",
	"The run started, but one of its steps was refused. The problem is on Qorpera's side.":
		"Kørslen startede, men et af dens trin blev afvist. Fejlen ligger hos Qorpera.",
	"The run was stopped before it finished.": "Kørslen blev stoppet, før den var færdig.",
	"The run stopped because of an internal error.": "Kørslen stoppede på grund af en intern fejl.",
	"The company is out of computer hours. New work starts again once hours are added.":
		"Virksomheden har ikke flere computertimer. Nyt arbejde starter igen, når der er tilføjet timer.",

	// The model menu (app/views/composer-models.ts)
	Model: "Model",
	"Model: {name}": "Model: {name}",
	"Model: {name}, {effort} effort": "Model: {name}, indsats: {effort}",
	"Refresh model": "Opdater model",
	Effort: "Indsats",
	Low: "Lav",
	Medium: "Mellem",
	High: "Høj",
	Speed: "Hastighed",
	Fast: "Hurtig",
	"{model}, Fast": "{model}, hurtig",
	"{speed} speed": "{speed} hastighed",
	"{speed} speed, uses more of your plan": "{speed} hastighed, bruger mere af dit abonnement",
	"Faster replies": "Hurtigere svar",
	"Only this conversation. Applies from your next message.": "Kun denne samtale. Gælder fra din næste besked.",
	"Each agent's own": "Hver agents egen",
	"Every agent in this group chat. Applies from your next message.":
		"Alle agenter i denne gruppechat. Gælder fra din næste besked.",
	"The model is unavailable. Refresh to try again.": "Modellen er ikke tilgængelig. Opdater for at prøve igen.",
	"The change could not be confirmed. Refresh the model before sending.":
		"Ændringen kunne ikke bekræftes. Opdater modellen, før du sender.",
	"Change unconfirmed": "Ændring ikke bekræftet",
	Unavailable: "Ikke tilgængelig",
	"Saving model…": "Gemmer model…",
	"Loading model…": "Henter model…",

	// Two agents' transcript (app/views/pair-transcript.ts)
	"Close Chat": "Luk chat",
	"Conversation between two agents": "Samtale mellem to agenter",
	"This chat is view-only": "Denne chat kan kun læses",
	and: "og",
	"Sent without waking the coworker": "Sendt uden at vække kollegaen",
	"Left for {name}'s next turn": "Til {name} ved næste tur",

	// The run status line (app/views/session-run.ts)
	"Cloud run": "Kørsel i skyen",
	"Cloud run status is unavailable.": "Status for kørslen i skyen er ikke tilgængelig.",
	"Cloud run status is unavailable. Refresh to try again.":
		"Status for kørslen i skyen er ikke tilgængelig. Opdater for at prøve igen.",
	"Checking cloud run…": "Tjekker kørsel i skyen…",
	"Cloud run queued.": "Kørsel i skyen er i kø.",
	"Cloud run in progress.": "Kørsel i skyen er i gang.",
	"No active cloud run.": "Ingen aktiv kørsel i skyen.",
	"Stop could not be confirmed. Refresh run status before trying again.":
		"Stop kunne ikke bekræftes. Opdater kørselsstatus, før du prøver igen.",
	"Stopping selected cloud run…": "Stopper den valgte kørsel i skyen…",
	"Refresh run status": "Opdater kørselsstatus",
	Refresh: "Opdater",
	"Stop cloud run": "Stop kørsel i skyen",
	"Stop run": "Stop kørsel",

	// The model account (app/views/session-execution.ts)
	"Model accounts are unavailable. Refresh to try again.":
		"Modelkonti er ikke tilgængelige. Opdater for at prøve igen.",
	"Execution history is unavailable.": "Kørselshistorikken er ikke tilgængelig.",
	"Retry keeps the original model account and message request. The earlier message may already have been accepted. Starting a new request can send it again.":
		"Prøv igen bruger den samme modelkonto og beskedanmodning. Den tidligere besked kan allerede være modtaget. En ny anmodning kan sende den igen.",
	"Start a new message request": "Start en ny beskedanmodning",
	"This conversation is unavailable for a new request.": "Denne samtale er ikke tilgængelig for en ny anmodning.",
	"Your model accounts have reached their usage limits. Sending resumes when an account resets.":
		"Dine modelkonti har nået deres forbrugsgrænser. Du kan sende igen, når en konto nulstilles.",
	"This conversation's model account has reached its usage limit. Sending resumes when it resets.":
		"Samtalens modelkonto har nået sin forbrugsgrænse. Du kan sende igen, når den nulstilles.",
	"This conversation's model account can't be used right now. Check it in Settings → My connections.":
		"Samtalens modelkonto kan ikke bruges lige nu. Se den under Indstillinger → Mine forbindelser.",
	"Choose a login to continue.": "Vælg et login for at fortsætte.",
	"Use {account}": "Brug {account}",
	"Model account {number}": "Modelkonto {number}",

	// Company notices above the composer (app/views/execution-notices.ts)
	"Company updates": "Virksomhedsopdateringer",
	"{title} can run while you're away.": "{title} kan køre, mens du er væk.",
	"{count} routines can run while you're away.": "{count} rutiner kan køre, mens du er væk.",
	"Turn on “Work while you're away” so your ChatGPT plan can run it.":
		"Slå “Arbejd, mens du er væk” til, så dit ChatGPT-abonnement kan køre den.",
	"Turn on “Work while you're away” so your ChatGPT plan can run them.":
		"Slå “Arbejd, mens du er væk” til, så dit ChatGPT-abonnement kan køre dem.",
	"Your ChatGPT plan now works while you're away. Ask the agent to set {title} up again.":
		"Dit ChatGPT-abonnement arbejder nu, mens du er væk. Bed agenten om at sætte {title} op igen.",
	"Your ChatGPT plan now works while you're away. Ask the agents to set those routines up again.":
		"Dit ChatGPT-abonnement arbejder nu, mens du er væk. Bed agenterne om at sætte rutinerne op igen.",
	"Your ChatGPT plan now works while you're away. Ask the agent to set those routines up again.":
		"Dit ChatGPT-abonnement arbejder nu, mens du er væk. Bed agenten om at sætte rutinerne op igen.",
	"“Work while you're away” is on, but the routine could not be started. Try again.":
		"“Arbejd, mens du er væk” er slået til, men rutinen kunne ikke startes. Prøv igen.",
	"“Work while you're away” is on, but your routines could not be checked. Try again.":
		"“Arbejd, mens du er væk” er slået til, men dine rutiner kunne ikke tjekkes. Prøv igen.",
	"“Work while you're away” is on, but the routines could not be started. Try again.":
		"“Arbejd, mens du er væk” er slået til, men rutinerne kunne ikke startes. Prøv igen.",
	"Turn on": "Slå til",
	"Turning on…": "Slår til…",
	"Not now": "Ikke nu",
	"“Work while you're away” could not be turned on. Try again.":
		"“Arbejd, mens du er væk” kunne ikke slås til. Prøv igen.",
	"All {count} company computers are in use. Close one to open another.":
		"Alle {count} virksomhedscomputere er i brug. Luk én for at åbne en ny.",

	// Attachments (ui/received-attachments.ts, ui/attachments.ts)
	"Message attachments": "Vedhæftede filer i beskeden",
	Attachment: "Vedhæftet fil",
	"Click to preview": "Klik for at se",
	"Preview unavailable": "Ingen forhåndsvisning",
	"Preview {name}": "Forhåndsvis {name}",
	"Attachment preview": "Forhåndsvisning af vedhæftet fil",
	"Loading preview…": "Henter forhåndsvisning…",
	"Preview is not available yet.": "Forhåndsvisning er ikke tilgængelig endnu.",
	"File size unavailable": "Filstørrelse ikke tilgængelig",
	"Preview is not available for this file.": "Forhåndsvisning er ikke tilgængelig for denne fil.",
	"Preview failed · retry": "Forhåndsvisning mislykkedes · prøv igen",
	"Open preview": "Åbn forhåndsvisning",
	"This image could not be displayed.": "Billedet kunne ikke vises.",
	"The preview could not be loaded. Close and reopen it to retry.":
		"Forhåndsvisningen kunne ikke hentes. Luk og åbn den igen for at prøve igen.",
	"Selected attachments": "Valgte vedhæftede filer",
	"Empty files cannot be attached.": "Tomme filer kan ikke vedhæftes.",
	"Each file must be 10 MB or smaller.": "Hver fil må højst fylde 10 MB.",
	"Choose up to 8 files, totaling no more than 25 MB.": "Vælg op til 8 filer på højst 25 MB i alt.",
	"File preview": "Forhåndsvisning af fil",
	"Preview is not available for this file type.": "Forhåndsvisning er ikke tilgængelig for denne filtype.",
	"{size} · Selected on this device": "{size} · Valgt på denne enhed",
	"Attachments stay on this device. Sending attachments is not available yet.":
		"Vedhæftede filer bliver på denne enhed. De kan ikke sendes endnu.",

	// Cards an agent raises (ui/interaction-card.ts)
	"Waiting for you": "Venter på dig",
	Answered: "Besvaret",
	Declined: "Afvist",
	Expired: "Udløbet",
	Question: "Spørgsmål",
	Secret: "Hemmelighed",
	Form: "Formular",
	Computer: "Computer",
	Draft: "Kladde",
	"Sign-in": "Login",
	"Filled in": "Udfyldt",
	"Saved to the company vault": "Gemt i virksomhedens boks",
	"Handed back": "Givet tilbage",
	Approved: "Godkendt",
	Skipped: "Sprunget over",
	Discarded: "Kasseret",
	You: "Dig",
	Sending: "Sender",
	"This card is past its time. The agent will ask again if it still needs it.":
		"Kortet er udløbet. Agenten spørger igen, hvis den stadig har brug for det.",
	"Your answer did not reach the agent. Answer again.": "Dit svar nåede ikke frem til agenten. Svar igen.",
	"Something else…": "Noget andet…",
	"Your own answer": "Dit eget svar",
	Skip: "Spring over",
	"Take over": "Overtag",
	"I'm done": "Jeg er færdig",
	"Paste your {label}": "Indsæt {label}",
	"Save securely": "Gem sikkert",
	"Encrypted in the company vault. The agent never sees the value, only that it was saved.":
		"Krypteret i virksomhedens boks. Agenten ser aldrig værdien, kun at den blev gemt.",
	"Saving a secret to the company vault is unavailable here. Do not paste it into chat.":
		"Du kan ikke gemme en hemmelighed i virksomhedens boks her. Indsæt den ikke i chatten.",
	"Website: {domain}": "Websted: {domain}",
	"Filling a webpage through this card is unavailable.": "Du kan ikke udfylde en webside via dette kort.",
	Discard: "Kassér",
	"Sending this draft from here needs a newer version of the app.":
		"Du skal have en nyere version af appen for at sende kladden herfra.",
	"Email draft from {name}": "Mailkladde fra {name}",
	"Email sent by {name}": "Mail sendt af {name}",
	"Email sent": "Mail sendt",
	"View email": "Vis mail",
	"The email draft could not be loaded.": "Mailkladden kunne ikke hentes.",
	"The email action could not be confirmed.": "Mailhandlingen kunne ikke bekræftes.",
	"Loading email…": "Henter mail…",
	"Saving to Gmail…": "Gemmer i Gmail…",
	"Discarding…": "Kasserer…",
	"Send unconfirmed": "Afsendelse ikke bekræftet",
	"Action unconfirmed": "Handling ikke bekræftet",
	"Refresh to confirm the previous email action before making changes.":
		"Opdater for at bekræfte den forrige mailhandling, før du foretager ændringer.",
	"Saved to Gmail": "Gemt i Gmail",
	"Account unavailable": "Konto ikke tilgængelig",
	"Ready to send": "Klar til afsendelse",
	"Send email": "Send mail",
	"Save to Gmail": "Gem i Gmail",
	"Email body": "Mailtekst",
	Cc: "Cc",
	To: "Til",
	From: "Fra",
	Subject: "Emne",
	"New email": "Ny mail",
	"Checking connected account…": "Tjekker tilsluttet konto…",
	"Your email action is complete. The agent has not been notified yet.":
		"Din mailhandling er gennemført. Agenten har endnu ikke fået besked.",
	"Retry notifying agent": "Prøv at give agenten besked igen",
	"Check Gmail before sending again. Delivery has not been confirmed.":
		"Tjek Gmail, før du sender igen. Leveringen er ikke bekræftet.",
	"Signing in to {domain} through this card is unavailable.": "Du kan ikke logge ind på {domain} via dette kort.",
	"Signing in through this card is unavailable.": "Du kan ikke logge ind via dette kort.",
	"{kind} from {name}: {title}": "{kind} fra {name}: {title}",

	// Approval cards (ui/authorization-card.ts)
	Approval: "Godkendelse",
	"Awaiting decision": "Afventer beslutning",
	"Decision recorded": "Beslutning registreret",
	"Approval requested": "Anmodning om godkendelse",
	"Authorization decision": "Beslutning om godkendelse",
	Recipient: "Modtager",
	File: "Fil",
	Amount: "Beløb",
	Currency: "Valuta",
	Reason: "Årsag",
	"Only an owner or admin of this company can decide.": "Kun en ejer eller administrator i virksomheden kan beslutte.",
	Approve: "Godkend",
	"Event details": "Hændelsesdetaljer",

	// Approval cards of agents' actions, auto-review (ui/authorization-card.ts, app/company.ts)
	"It moves money.": "Den flytter penge.",
	"It accepts terms or signs for the company.": "Den accepterer vilkår eller skriver under for virksomheden.",
	"It deletes data outside Qorpera.": "Den sletter data uden for Qorpera.",
	"It changes who can access something.": "Den ændrer, hvem der har adgang til noget.",
	"It does not match what was asked.": "Den passer ikke til det, der blev bedt om.",
	"Waiting for {name} to approve.": "Venter på, at {name} godkender.",
	"the member": "medlemmet",
	"Waiting for an owner or admin to approve.": "Venter på, at en ejer eller administrator godkender.",
	"Company rule: {rule}": "Virksomhedsregel: {rule}",
	"Personal rule: {rule}": "Personlig regel: {rule}",
	"Always allow when an agent wants to": "Tillad altid, når en agent vil",
	"Save rule and allow": "Gem regel og tillad",
	"Don't send": "Send ikke",
	Bcc: "Bcc",
	"Delete “{name}”": "Slet “{name}”",
	Deny: "Afvis",
	"Always allow…": "Tillad altid…",
	"Allow once": "Tillad én gang",
	"Always allowed by {name}.": "Altid tilladt af {name}.",
	"The safety check could not run.": "Sikkerhedstjekket kunne ikke køre.",
	"That answer did not reach the agent. Answer again.": "Svaret nåede ikke frem til agenten. Svar igen.",
	"Allowed once by {name}.": "Tilladt én gang af {name}.",
	"Declined by {name}.": "Afvist af {name}.",
	"a member": "et medlem",
	"Approvals are not available here yet. Reply in a message instead.":
		"Godkendelser er ikke tilgængelige her endnu. Svar i en besked i stedet.",
	"No details provided.": "Ingen detaljer angivet.",

	// Message formatting (ui/markdown.ts)
	"Task status": "Opgavestatus",
	"Message table": "Tabel i besked",
	"Image: {name}": "Billede: {name}",
	"Open image": "Åbn billede",
};
