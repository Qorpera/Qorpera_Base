/* Danish interface text, keyed by the English source exactly as the code
 * passes it to t() / uiText(). One file per area of the app; a key lives in
 * one file only (test/translations.test.ts checks). Wording follows
 * qorpera.com and the desktop app (packages/shell/userland/localization.js). */
/** A conversation: thread, composer, cards, runs, attachments. */
export const CONVERSATION: Record<string, string> = {
	"Today {time}": "I dag {time}",
	"Yesterday {time}": "I går {time}",

	// The thread and the composer (app/views/conversation.ts)
	"Attach files": "Vedhæft filer",
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

	// A failed run above the composer (conversation.ts, ui/run-failure.ts)
	"The agent": "Agenten",
	"{name} stopped with changes to review": "{name} stoppede med ændringer, du skal gennemgå",
	"A review did not finish": "En gennemgang blev ikke færdig",
	"{name} did not finish this run": "{name} blev ikke færdig med denne kørsel",
	"Its changes wait for your decision.": "Ændringerne venter på din beslutning.",
	Review: "Gennemgå",
	"Trying again…": "Prøver igen…",
	Dismiss: "Skjul",
	"Your model account has reached its usage limit.": "Din modelkonto har nået sin forbrugsgrænse.",
	"Your model account needs to be connected again.": "Din modelkonto skal forbindes igen.",
	"No computer could be started for this run. The problem is on Qorpera's side.":
		"Der kunne ikke startes en computer til denne kørsel. Fejlen ligger hos Qorpera.",
	"The run took too long and was stopped.": "Kørslen tog for lang tid og blev stoppet.",
	"The run started, but one of its steps was refused. The problem is on Qorpera's side.":
		"Kørslen startede, men et af dens trin blev afvist. Fejlen ligger hos Qorpera.",
	"The run was stopped before it finished.": "Kørslen blev stoppet, før den var færdig.",
	"The run stopped because of an internal error.": "Kørslen stoppede på grund af en intern fejl.",

	// The model menu (app/views/composer-models.ts)
	Model: "Model",
	"Model: {name}": "Model: {name}",
	"Model: {name}, {effort} effort": "Model: {name}, indsats: {effort}",
	"Refresh model": "Opdater model",
	Effort: "Indsats",
	Low: "Lav",
	Medium: "Mellem",
	High: "Høj",
	"Only this conversation. Applies from your next message.": "Kun denne samtale. Gælder fra din næste besked.",
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

	// Company notices above the composer (app/views/execution-notices.ts)
	"Company updates": "Virksomhedsopdateringer",
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
	"Entering a secret here needs a newer version of the app. The value would go to the company vault, never to the agent.":
		"Du skal have en nyere version af appen for at indtaste en hemmelighed her. Værdien ville gå til virksomhedens boks, aldrig til agenten.",
	"Filled on the computer at {domain} only": "Udfyldes kun på computeren på {domain}",
	"Filling this form here needs a newer version of the app.":
		"Du skal have en nyere version af appen for at udfylde formularen her.",
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
	"The computer signs in at {domain} with the company account. Nothing to do here.":
		"Computeren logger ind på {domain} med virksomhedens konto. Du skal ikke gøre noget her.",
	"The computer signs in with the company account. Nothing to do here.":
		"Computeren logger ind med virksomhedens konto. Du skal ikke gøre noget her.",
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
	"No details provided.": "Ingen detaljer angivet.",

	// Message formatting (ui/markdown.ts)
	"Task status": "Opgavestatus",
	"Message table": "Tabel i besked",
	"Image: {name}": "Billede: {name}",
	"Open image": "Åbn billede",
};
