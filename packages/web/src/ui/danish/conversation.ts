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
	Dictate: "Indtal",
	"Stop dictation": "Stop indtaling",
	"Qorpera may not use the microphone. Allow it in the browser's settings for this site.":
		"Qorpera må ikke bruge mikrofonen. Tillad den i browserens indstillinger for siden.",
	"No microphone was found.": "Der blev ikke fundet nogen mikrofon.",
	"Speech could not be turned into text. Try again.": "Talen kunne ikke laves om til tekst. Prøv igen.",
	Skills: "Færdigheder",
	"No skills yet. Agents save skills as they learn how the company works.":
		"Ingen færdigheder endnu. Agenter gemmer færdigheder, efterhånden som de lærer, hvordan virksomheden arbejder.",
	"Chat settings and more": "Chatindstillinger og mere",
	"Images are not supported in group chats. Use Company File.":
		"Billeder understøttes ikke i gruppechats. Brug Virksomhedsfilen.",
	"Open agent details": "Åbn agentdetaljer",
	"Open group details": "Åbn gruppedetaljer",
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
	"(erased)": "(slettet)",
	"Erase message": "Slet besked",
	"Show how the erase went": "Vis, hvordan sletningen gik",
	"Copy message": "Kopiér besked",
	"The text could not be copied.": "Teksten kunne ikke kopieres.",
	Erase: "Slet",
	"Erase the message from {author} at {time}? It is erased for everyone: the thread shows (erased) in its place, and the company's memory forgets it. This can't be undone.":
		"Slet beskeden fra {author} kl. {time}? Den slettes for alle: tråden viser (slettet) i stedet, og virksomhedens hukommelse glemmer den. Det kan ikke fortrydes.",
	"Erasing the message from {author} at {time}…": "Sletter beskeden fra {author} kl. {time}…",
	"The message from {author} at {time} is erased from the thread. Clearing it from the company's memory…":
		"Beskeden fra {author} kl. {time} er slettet fra tråden. Fjerner den fra virksomhedens hukommelse…",
	"Erased the message from {author} at {time}: it is gone from the thread and from the company's memory.":
		"Beskeden fra {author} kl. {time} er slettet: den er væk fra tråden og fra virksomhedens hukommelse.",
	"Erased the message from {author} at {time} from the thread and from the company's memory, but not from files that hold a copy of it.":
		"Beskeden fra {author} kl. {time} er slettet fra tråden og fra virksomhedens hukommelse, men ikke fra filer, der har en kopi af den.",
	"A copy stays in {path}.": "En kopi ligger stadig i {path}.",
	"A copy stays in the history of {path}, which is deleted.":
		"En kopi ligger stadig i historikken for {path}, som er slettet.",
	"A copy stays in {path} in another Company File.": "En kopi ligger stadig i {path} i en anden virksomhedsfil.",
	"A copy stays in the history of {path} in another Company File, where it is deleted.":
		"En kopi ligger stadig i historikken for {path} i en anden virksomhedsfil, hvor den er slettet.",
	"The message from {author} at {time} was not erased: only an owner or admin can erase messages.":
		"Beskeden fra {author} kl. {time} blev ikke slettet: kun en ejer eller administrator kan slette beskeder.",
	"Only an owner or admin can erase messages.": "Kun en ejer eller administrator kan slette beskeder.",
	"The message from {author} at {time} can't be erased.": "Beskeden fra {author} kl. {time} kan ikke slettes.",
	"The company is paused, so no message can be erased now.":
		"Virksomheden er sat på pause, så ingen besked kan slettes lige nu.",
	"Could not erase the message from {author} at {time}. Try again.":
		"Kunne ikke slette beskeden fra {author} kl. {time}. Prøv igen.",
	"Could not read how the erase of the message from {author} at {time} is going.":
		"Kunne ikke læse, hvordan sletningen af beskeden fra {author} kl. {time} går.",
	Failed: "Mislykkedes",
	"Failed · {reason}": "Mislykkedes · {reason}",
	Processing: "Behandles",
	Queued: "I kø",
	"a coworker": "en kollega",
	"Left a note for {name}": "Efterlod en note til {name}",
	"Note from {name}": "Note fra {name}",
	"Messaged {name}": "Skrev til {name}",
	"Message from {name}": "Besked fra {name}",
	"Left notes for {names}": "Efterlod noter til {names}",
	"Notes from {names}": "Noter fra {names}",
	"Messaged {names}": "Skrev til {names}",
	"Messages from {names}": "Beskeder fra {names}",
	"Talked with {names}": "Talte med {names}",
	"{count} messages": "{count} beskeder",
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
	"You're a spectator: you read along, and the founders write.": "Du er tilskuer: du læser med, og stifterne skriver.",
	"You can read this conversation. Contributors and above can write.":
		"Du kan læse denne samtale. Bidragydere og derover kan skrive.",
	you: "dig",

	// Agent states (ui/agent-activity.ts)
	Working: "Arbejder",
	Writing: "Skriver",
	"Using its computer": "Bruger sin computer",
	"Needs you": "Venter på dig",
	// The rail when an agent's work waits on the member (app/views/shell.ts)
	"Stopped: {what}": "Stoppet: {what}",
	"Waiting for you: {what}": "Venter på dig: {what}",
	"A run did not finish": "En kørsel blev ikke færdig",
	"{name} is working": "{name} arbejder",
	"{name} is writing": "{name} skriver",
	"{name} is using its computer": "{name} bruger sin computer",
	// A run with no progress for 15 minutes (conversation.ts, interfaces.ts, views/execution-notices.ts)
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
	// An area's supervisor who no longer supervises its agents (views/execution-notices.ts)
	"{member} stopped supervising the agents in {area}.": "{member} holdt op med at have tilsyn med agenterne i {area}.",
	"{member} no longer supervises the agents in {area}.": "{member} har ikke længere tilsyn med agenterne i {area}.",
	"{member} no longer supervises the agents in {area}: the area is gone.":
		"{member} har ikke længere tilsyn med agenterne i {area}: området findes ikke længere.",
	"{member} left the company, so the agents in {area} have no supervisor.":
		"{member} har forladt virksomheden, så agenterne i {area} har ingen tilsynsførende.",
	"the area {name}": "området {name}",
	"an area": "et område",

	// A failed run above the composer (conversation.ts, ui/run-failure.ts)
	"The agent": "Agenten",
	"{name} stopped with changes to review": "{name} stoppede med ændringer, du skal gennemgå",
	"A review did not finish": "En gennemgang blev ikke færdig",
	"{name} did not finish this run": "{name} blev ikke færdig med denne kørsel",
	"An earlier review did not finish": "En tidligere gennemgang blev ikke færdig",
	"An earlier run of {name} did not finish": "{name} blev ikke færdig med en tidligere kørsel",
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
	"The model account paying for this work reached its usage limit, so the work stopped. It does not move to another account. It can run again when the limit resets ({time}).":
		"Modelkontoen, der betaler for dette arbejde, har nået sin forbrugsgrænse, så arbejdet er stoppet. Det flyttes ikke til en anden konto. Det kan køre igen, når grænsen nulstilles ({time}).",
	"The model account paying for this work reached its usage limit, so the work stopped. It can run again when the limit resets ({time}), or you can continue it now with another of your logins.":
		"Modelkontoen, der betaler for dette arbejde, har nået sin forbrugsgrænse, så arbejdet er stoppet. Det kan køre igen, når grænsen nulstilles ({time}), eller du kan fortsætte det nu med et andet af dine logins.",
	"The model account paying for this work reached its usage limit, so the work stopped. It can run again once the limit resets, or you can continue it now with another of your logins.":
		"Modelkontoen, der betaler for dette arbejde, har nået sin forbrugsgrænse, så arbejdet er stoppet. Det kan køre igen, når grænsen er nulstillet, eller du kan fortsætte det nu med et andet af dine logins.",
	"The model account paying for this work reached its usage limit, so the work stopped. It can run again once the limit resets. Only {name} can continue it now with another of their logins.":
		"Modelkontoen, der betaler for dette arbejde, har nået sin forbrugsgrænse, så arbejdet er stoppet. Det kan køre igen, når grænsen er nulstillet. Kun {name} kan fortsætte det nu med et andet af sine logins.",
	"Continue with {account}": "Fortsæt med {account}",
	"{name} is waiting to go on": "{name} venter på at fortsætte",
	"The model account paying for this work reached its usage limit. The work waits and goes on by itself when the limit resets ({time}), or you can continue it now with another of your logins.":
		"Modelkontoen, der betaler for dette arbejde, har nået sin forbrugsgrænse. Arbejdet venter og fortsætter af sig selv, når grænsen nulstilles ({time}), eller du kan fortsætte det nu med et andet af dine logins.",
	"The model account paying for this work reached its usage limit. The work waits and goes on by itself when the limit resets ({time}). Only {name} can continue it now with another of their logins.":
		"Modelkontoen, der betaler for dette arbejde, har nået sin forbrugsgrænse. Arbejdet venter og fortsætter af sig selv, når grænsen nulstilles ({time}). Kun {name} kan fortsætte det nu med et andet af sine logins.",
	"The model account paying for this work reached its usage limit. The work waits and goes on by itself when the limit resets ({time}).":
		"Modelkontoen, der betaler for dette arbejde, har nået sin forbrugsgrænse. Arbejdet venter og fortsætter af sig selv, når grænsen nulstilles ({time}).",
	"The work could not be moved. Try again.": "Arbejdet kunne ikke flyttes. Prøv igen.",
	"Continuing…": "Fortsætter…",
	"Send your message to continue with {account}.": "Send din besked for at fortsætte med {account}.",
	"Your last run stopped because a login reached its usage limit. Please continue that work.":
		"Din seneste kørsel stoppede, fordi et login nåede sin forbrugsgrænse. Fortsæt venligst det arbejde.",
	"ChatGPT refused or could not answer this run's request. Check the login that pays for it in Settings → AI subscriptions, or choose another login for this conversation.":
		"ChatGPT afviste eller kunne ikke besvare kørslens forespørgsel. Tjek det login, der betaler for den, under Indstillinger → AI-abonnementer, eller vælg et andet login til denne samtale.",
	"Your message didn't go through: ChatGPT got too many requests at once. The login is fine.":
		"Din besked gik ikke igennem: ChatGPT fik for mange forespørgsler på én gang. Loginnet er i orden.",
	"ChatGPT turned this run away because too many requests came at once. The login is fine.":
		"ChatGPT afviste kørslen, fordi der kom for mange forespørgsler på én gang. Loginnet er i orden.",
	"ChatGPT is busy with too many requests at once. This work waits a few minutes and then tries again by itself. The login is fine.":
		"ChatGPT har travlt med for mange forespørgsler på én gang. Arbejdet venter et par minutter og prøver så igen af sig selv. Loginnet er i orden.",
	"ChatGPT no longer accepts this login's sign-in, so the work stopped. Sign in again in Settings → AI subscriptions.":
		"ChatGPT godtager ikke længere loginnet, så arbejdet stoppede. Log ind igen under Indstillinger → AI-abonnementer.",
	"ChatGPT no longer accepts the sign-in of the login that pays for this run, so the work stopped. The member whose login it is can sign in again in Settings → AI subscriptions.":
		"ChatGPT godtager ikke længere det login, der betaler for kørslen, så arbejdet stoppede. Det medlem, der ejer loginnet, kan logge ind igen under Indstillinger → AI-abonnementer.",
	"ChatGPT did not accept this login's sign-in. Qorpera is renewing it, and the work tries again by itself in a few minutes.":
		"ChatGPT godtog ikke loginnet. Qorpera fornyer det, og arbejdet prøver igen af sig selv om et par minutter.",
	"The run lost its connection while it was working. This is usually brief.":
		"Kørslen mistede forbindelsen, mens den arbejdede. Det går som regel hurtigt over.",
	"The run could not load the login that pays for it. Check that login in Settings → AI subscriptions, or choose another login for this conversation.":
		"Kørslen kunne ikke hente det login, der betaler for den. Tjek loginnet under Indstillinger → AI-abonnementer, eller vælg et andet login til denne samtale.",
	"ChatGPT refused or could not answer this run's request. The member whose login pays for it can check that login in Settings → AI subscriptions.":
		"ChatGPT afviste eller kunne ikke besvare kørslens forespørgsel. Det medlem, hvis login betaler for den, kan tjekke loginnet under Indstillinger → AI-abonnementer.",
	"The run could not load the login that pays for it. The member whose login it is can check it in Settings → AI subscriptions.":
		"Kørslen kunne ikke hente det login, der betaler for den. Det medlem, der ejer loginnet, kan tjekke det under Indstillinger → AI-abonnementer.",
	"Your model account needs to be connected again.": "Din modelkonto skal forbindes igen.",
	"No computer could be started for this run. The problem is on Qorpera's side.":
		"Der kunne ikke startes en computer til denne kørsel. Fejlen ligger hos Qorpera.",
	"The run ended before all of its work was saved. Send a message to carry on.":
		"Kørslen sluttede, før alt dens arbejde var gemt. Send en besked for at fortsætte.",
	"Qorpera lost contact with this run. The problem is on Qorpera's side.":
		"Qorpera mistede forbindelsen til kørslen. Fejlen ligger hos Qorpera.",
	"One of the run's steps got no answer in time. The problem is on Qorpera's side.":
		"Et af kørslens trin fik ikke svar i tide. Fejlen ligger hos Qorpera.",
	"The run took too long and was stopped.": "Kørslen tog for lang tid og blev stoppet.",
	"The run started, but one of its steps was refused. The problem is on Qorpera's side.":
		"Kørslen startede, men et af dens trin blev afvist. Fejlen ligger hos Qorpera.",
	"The agent finished without sending its answer. The problem is on Qorpera's side.":
		"Agenten blev færdig uden at sende sit svar. Fejlen ligger hos Qorpera.",
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
	"Extra high": "Ekstra høj",
	Max: "Maks",
	Models: "Modeller",
	"Choose model": "Vælg model",
	"Choose model ({name})": "Vælg model ({name})",
	"Switch to Claude": "Skift til Claude",
	"Switch to GPT": "Skift til GPT",
	"GPT answers light messages. Claude Code does the work, on your Claude plan.":
		"GPT svarer på lette beskeder. Claude Code gør arbejdet, på dit Claude-abonnement.",
	Fast: "Hurtig",
	"{model}, Fast": "{model}, hurtig",
	"{speed} speed": "{speed} hastighed",
	"{speed} speed, uses more of your plan": "{speed} hastighed, bruger mere af dit abonnement",
	"Faster replies": "Hurtigere svar",
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
	"Conversation between two agents": "Samtale mellem to agenter",
	"Only the two agents write here": "Kun de to agenter skriver her",

	// An app on its own page or a page beside the chat (app/views/app-panel.ts) and an app's card in a message
	// (ui/markdown.ts)
	"Beside the chat": "Ved siden af chatten",
	"Show in Storage": "Vis i Lager",
	"Made by {name}": "Lavet af {name}",
	"Made by an agent": "Lavet af en agent",
	"A page of the Company File": "En side i Virksomhedsfilen",
	"Qorpera never asks for passwords here": "Qorpera beder aldrig om adgangskoder her",
	"This app isn't in the company anymore.": "Appen er ikke i virksomheden længere.",
	"This app's app.toml has problems: {problems}": "Appens app.toml har fejl: {problems}",
	"This can't be opened right now.": "Det kan ikke åbnes lige nu.",
	"This page can't be shown here.": "Siden kan ikke vises her.",
	"Opening… {percent}%": "Åbner… {percent}%",
	"This page can't be shown live.": "Siden kan ikke vises direkte.",
	"App: {name}": "App: {name}",
	"This program has no version yet.": "Programmet har ingen version endnu.",
	"This program's program.json can't be read.": "Programmets program.json kan ikke læses.",
	"Version {version} · {day}": "Version {version} · {day}",
	Install: "Installér",
	"Download for {kind}": "Hent til {kind}",
	"Download {kind}": "Hent {kind}",
	"Not made for {kind} yet": "Ikke lavet til {kind} endnu",
	"For this computer": "Til denne computer",
	"For this phone": "Til denne telefon",
	"It's in your Downloads.": "Den ligger i dine overførsler.",
	"This file is no longer in the app's folder.": "Filen er ikke længere i appens mappe.",
	"This file changed after version {version} was kept.": "Filen er ændret, efter at version {version} blev gemt.",
	"The download stopped. Try again.": "Hentningen stoppede. Prøv igen.",
	"Earlier versions": "Tidligere versioner",
	"None yet": "Ingen endnu",
	"Back to the newest, {version}": "Tilbage til den nyeste, {version}",
	"{name} on a computer": "{name} på en computer",
	"{name} on a phone": "{name} på en telefon",
	"New program": "Nyt program",
	"Drop a program here": "Slip et program her",
	"or choose a file": "eller vælg en fil",
	"Choose a program": "Vælg et program",
	"Made something yourself? Drop it here and everyone in {company} can get it.":
		"Har du selv lavet noget? Slip det her, så alle i {company} kan hente det.",
	"What is it for?": "Hvad er det til?",
	"Not this one": "Ikke denne",
	"Putting {name} in place… {percent}%": "Lægger {name} på plads … {percent} %",
	"{size}: too large. The most is {most}.": "{size}: for stor. Højst {most}.",
	"Drop at most five files, one for each kind.": "Slip højst fem filer, én til hver slags.",
	"{name} is empty.": "{name} er tom.",
	"{name} can't be used as it is named. Rename the file and drop it again.":
		"{name} kan ikke bruges med det navn. Omdøb filen, og slip den igen.",
	"Two files for {kind}: drop one for each kind.": "To filer til {kind}: slip én til hver slags.",
	"This program holds as many versions as it can.": "Programmet rummer så mange versioner, som det kan.",
	"You can't add programs in this company.": "Du kan ikke tilføje programmer i denne virksomhed.",
	"The company is paused. Add the program when it runs again.":
		"Virksomheden er sat på pause. Tilføj programmet, når den kører igen.",
	"Another program of yours is still going up. Try again in a moment.":
		"Et andet af dine programmer er stadig på vej op. Prøv igen om lidt.",
	"Someone added to this program at the same moment. Try again.":
		"En anden tilføjede til programmet i samme øjeblik. Prøv igen.",
	"The connection dropped.": "Forbindelsen blev afbrudt.",
	"Add a version": "Tilføj en version",
	"Putting it in place for everyone in {company}.": "Lægger det på plads til alle i {company}.",
	"That version already has this file.": "Den version har allerede denne fil.",
	"This is the version that is already here.": "Det er den version, der allerede ligger her.",
	"The company folder refused this file: {reason}.": "Virksomhedens mappe afviste filen: {reason}.",
	"The company folder refused this file.": "Virksomhedens mappe afviste filen.",
	"This file can't be put in place as it is named. Rename it and drop it again.":
		"Filen kan ikke lægges på plads med det navn. Omdøb den, og slip den igen.",
	"Version {version} · added by you": "Version {version} · tilføjet af dig",
	"Version {version} · added by {name}": "Version {version} · tilføjet af {name}",
	"This app reloaded itself. Press Reload to start it again.":
		"Appen genindlæste sig selv. Tryk Genindlæs for at starte den igen.",

	// The agents' open questions on an app's page and in the Concepts viewer (app/views/question-dock.ts)
	"Questions for you": "Spørgsmål til dig",
	"Decisions for you": "Beslutninger til dig",
	"{name} asks you": "{name} spørger dig",
	"{name} is reworking this": "{name} laver det om",
	"Sending to {name}…": "Sender til {name}…",
	"Sent to {name}": "Sendt til {name}",
	"Previous question": "Forrige spørgsmål",
	"Next question": "Næste spørgsmål",
	"Hide the question": "Skjul spørgsmålet",
	"{count} questions for you": "{count} spørgsmål til dig",
	"Your answer could not be sent. Try again.": "Dit svar kunne ikke sendes. Prøv igen.",

	// What an app asks the member to change, on the bar above its page (app/views/app-ask-bar.ts, app/app-actions.ts)
	"This app wants to send your answer to {name}": "Appen vil sende dit svar til {name}",
	"This app wants to add a row to a company table": "Appen vil tilføje en række i en af virksomhedens tabeller",
	"This app wants to change a row in a company table": "Appen vil ændre en række i en af virksomhedens tabeller",
	// A web page a link in the app leads to, shown before it opens (Jonas, 13 November 2026: "Show the address first").
	"This app wants to open a web page": "Appen vil åbne en webside",
	Site: "Websted",
	"Your answer": "Dit svar",
	Table: "Tabel",
	Row: "Række",
	empty: "tom",
	becomes: "bliver til",
	"Send answer": "Send svar",
	"Add row": "Tilføj række",
	"Change row": "Ændr række",
	"This app asked three times. It can ask again after you reload it.":
		"Appen har spurgt tre gange. Den kan spørge igen, når du har genindlæst den.",
	"That could not be saved. Try again.": "Det kunne ikke gemmes. Prøv igen.",
	"The row could not be saved.": "Rækken kunne ikke gemmes.",
	"That table is no longer in the company.": "Tabellen er ikke i virksomheden længere.",
	"The row changed while you were deciding. Nothing was saved.":
		"Rækken blev ændret, mens du tog stilling. Intet blev gemt.",
	"You may not change this table. Nothing was saved.": "Du må ikke ændre denne tabel. Intet blev gemt.",
	// A note to the app's owner, written on the same bar (app/views/app-ask-bar.ts, app/app-actions.ts)
	"This app wants to send your note to {name}": "Appen vil sende din besked til {name}",
	"Your note": "Din besked",
	"Write your note": "Skriv din besked",
	"Send note": "Send besked",
	"Your note waits in {name}'s thread": "Din besked venter i tråden med {name}",
	"Write your note first.": "Skriv din besked først.",
	"Leave the app out": "Udelad appen",
	"Leave the page out": "Udelad siden",
	"Your note could not be sent. Try again.": "Din besked kunne ikke sendes. Prøv igen.",
	"{name}'s thread has a message started. Send or clear it there, then send this note.":
		"Der er en besked i gang i tråden med {name}. Send eller ryd den dér, og send så denne besked.",
	App: "App",

	// The company's concepts of its product, full screen (app/views/concepts.ts), and their entry in the apps drawer
	Concepts: "Koncepter",
	"Show sidebar": "Vis sidepanelet",
	"Hide sidebar": "Skjul sidepanelet",
	"This concept isn't in the company anymore.": "Konceptet er ikke i virksomheden længere.",
	"The company has no concepts yet.": "Virksomheden har ingen koncepter endnu.",
	"Open the newest concept": "Åbn det nyeste koncept",

	"1 message": "1 besked",
	"{count}+ messages": "{count}+ beskeder",
	and: "og",
	"Sent without waking the coworker": "Sendt uden at vække kollegaen",
	"Left for {name}'s next turn": "Til {name} ved næste tur",

	Refresh: "Opdater",

	// The model account (app/views/session-execution.ts)
	"Model accounts are unavailable. Trying again…": "Modelkonti er ikke tilgængelige. Prøver igen…",
	"Retry keeps the original model account and message request. The earlier message may already have been accepted. Starting a new request can send it again.":
		"Prøv igen bruger den samme modelkonto og beskedanmodning. Den tidligere besked kan allerede være modtaget. En ny anmodning kan sende den igen.",
	"Start a new message request": "Start en ny beskedanmodning",
	"This conversation is unavailable for a new request.": "Denne samtale er ikke tilgængelig for en ny anmodning.",
	"ChatGPT no longer accepts the sign-in for {email}. Sign in again in Settings → AI subscriptions.":
		"ChatGPT godtager ikke længere loginnet for {email}. Log ind igen under Indstillinger → AI-abonnementer.",
	"ChatGPT no longer accepts this login's sign-in. Sign in again in Settings → AI subscriptions.":
		"ChatGPT godtager ikke længere loginnet. Log ind igen under Indstillinger → AI-abonnementer.",
	"Your model accounts have reached their usage limits. Sending resumes when an account resets.":
		"Dine modelkonti har nået deres forbrugsgrænser. Du kan sende igen, når en konto nulstilles.",
	"This conversation's model account can't be used right now. Check it in Settings → AI subscriptions.":
		"Samtalens modelkonto kan ikke bruges lige nu. Se den under Indstillinger → AI-abonnementer.",
	"Choose a login to continue.": "Vælg et login for at fortsætte.",
	"Your login {account} reached its usage limit. Work will go on by itself when it resets (about {time}).":
		"Dit login {account} har nået sin forbrugsgrænse. Arbejdet fortsætter af sig selv, når grænsen nulstilles (om cirka {time}).",
	"Your login reached its usage limit. Work will go on by itself when it resets (about {time}).":
		"Dit login har nået sin forbrugsgrænse. Arbejdet fortsætter af sig selv, når grænsen nulstilles (om cirka {time}).",
	"Your login {account} reached its usage limit. Work will go on by itself once it has room again; it is checked at least once a day.":
		"Dit login {account} har nået sin forbrugsgrænse. Arbejdet fortsætter af sig selv, når der er plads igen; det tjekkes mindst én gang om dagen.",
	"Your login {account} reached its usage limit, and the work it paid for stopped. It does not go on by itself.":
		"Dit login {account} har nået sin forbrugsgrænse, og det arbejde, det betalte for, er stoppet. Det fortsætter ikke af sig selv.",
	"Your login reached its usage limit, and the work it paid for stopped. It does not go on by itself.":
		"Dit login har nået sin forbrugsgrænse, og det arbejde, det betalte for, er stoppet. Det fortsætter ikke af sig selv.",
	"Your login reached its usage limit. Work will go on by itself once it has room again; it is checked at least once a day.":
		"Dit login har nået sin forbrugsgrænse. Arbejdet fortsætter af sig selv, når der er plads igen; det tjekkes mindst én gang om dagen.",
	"{count} min": "{count} min.",
	"{count} h": "{count} t.",
	"{count} days": "{count} dage",
	"Use {account}": "Brug {account}",
	"Use {account} for all {count} chats waiting on this login":
		"Brug {account} til alle {count} chats, der venter på dette login",
	"This chat stays on its login: the work waiting in it can't move to {account}.":
		"Denne chat bliver på sit login: det arbejde, der venter i den, kan ikke flyttes til {account}.",
	"Out of usage until {time}": "Forbruget er brugt op indtil {time}",
	"Out of usage": "Forbruget er brugt op",
	"Keep going with {account}": "Fortsæt med {account}",
	"Claude is out of usage until {time}": "Claude-forbruget er brugt op indtil {time}",
	"{account} is used up. Keep going with {other}": "{account} er brugt op. Fortsæt med {other}",
	"New Claude work now uses {account}": "Nyt Claude-arbejde bruger nu {account}",
	"All {count} chats": "Alle {count} chats",
	"Just this one": "Kun denne",
	"Or use {accounts}": "Eller brug {accounts}",
	"A message you send now goes on when it resets.": "En besked, du sender nu, fortsætter, når grænsen nulstilles.",
	"Sending resumes when it resets.": "Du kan sende igen, når grænsen nulstilles.",
	"{count} chats moved to {account}": "{count} chats flyttet til {account}",
	"{count} chat moved to {account}": "{count} chat flyttet til {account}",
	"{count} other chats moved to {account}": "{count} andre chats flyttet til {account}",
	"{count} other chat moved to {account}": "{count} anden chat flyttet til {account}",
	"No chats were waiting on that login any more.": "Ingen chats ventede længere på det login.",
	"The chats could not be moved. Try again.": "Chattene kunne ikke flyttes. Prøv igen.",
	"Model account {number}": "Modelkonto {number}",

	// The Login page of the composer's menu (app/views/composer-logins.ts)
	"Login: {account}": "Login: {account}",
	"Pays for your messages in this conversation. Applies from your next message.":
		"Betaler for dine beskeder i denne samtale. Gælder fra din næste besked.",
	"Pays for your messages in this group chat. Applies from your next message.":
		"Betaler for dine beskeder i denne gruppechat. Gælder fra din næste besked.",

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
	"Image viewer": "Billedvisning",
	"Previous image": "Forrige billede",
	"Next image": "Næste billede",
	"{index} of {count}": "{index} af {count}",
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
	Answering: "Svarer på",
	"Stop answering": "Stop med at svare",
	"Your answer…": "Dit svar…",
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
	"A member stopped the work that raised this card. Answering it starts new work.":
		"Et medlem stoppede det arbejde, der rejste dette kort. Et svar starter nyt arbejde.",
	"A member stopped the work that raised this card.": "Et medlem stoppede det arbejde, der rejste dette kort.",
	"Something else…": "Noget andet…",
	"Your own answer": "Dit eget svar",
	Skip: "Spring over",
	// The take-over card's way to the agent's computer (review r1 F1 of #1812).
	"Open computer": "Åbn computer",
	"I'm done": "Jeg er færdig",
	"The computer could not be given back yet. Press I'm done to try again. It goes back by itself within 5 minutes.":
		"Computeren kunne ikke gives tilbage endnu. Tryk på Jeg er færdig for at prøve igen. Den går tilbage af sig selv inden for 5 minutter.",
	"Paste your {label}": "Indsæt {label}",
	"Save securely": "Gem sikkert",
	"Encrypted in the company vault. The agent never sees the value, only that it was saved.":
		"Krypteret i virksomhedens boks. Agenten ser aldrig værdien, kun at den blev gemt.",
	"Encrypted in the company vault. Coding sessions in {repository} get it as {variable}; it never shows in the chat.":
		"Krypteret i virksomhedens boks. Kodesessioner i {repository} får den som {variable}; den vises aldrig i chatten.",
	"Saved as your own in the company vault: your coding sessions in every repository get it as {variable}. It never shows in the chat.":
		"Gemt som din egen i virksomhedens boks: dine kodesessioner i alle repositorier får den som {variable}. Den vises aldrig i chatten.",
	"{variable} is saved, but it could not be given to {repository}: {error} Try again.":
		"{variable} er gemt, men den kunne ikke gives til {repository}: {error} Prøv igen.",
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

	// Saved changes that wait for review (ui/proposal-card.ts)
	"Archive the agent “{name}”": "Arkivér agenten “{name}”",
	"Make the agent “{name}” active again": "Gør agenten “{name}” aktiv igen",
	"Hire “{name}”": "Ansæt “{name}”",
	"Start the group chat “{name}”": "Start gruppechatten “{name}”",
	"Pause the routine “{name}”": "Sæt rutinen “{name}” på pause",
	"End the routine “{name}”": "Afslut rutinen “{name}”",
	"Set up or change the routine “{name}”": "Opret eller ændr rutinen “{name}”",
	"Set up or change the interface “{name}”": "Opret eller ændr interfacet “{name}”",
	"Set up or change the table “{name}”": "Opret eller ændr tabellen “{name}”",
	"Delete “{name}” from “{parent}”": "Slet “{name}” fra “{parent}”",
	"Rename “{name}” to “{to}”": "Omdøb “{name}” til “{to}”",
	"Move “{name}” to “{to}”": "Flyt “{name}” til “{to}”",
	"Move “{name}” to the top of the Company File": "Flyt “{name}” til toppen af Virksomhedsfilen",
	"Change “{name}”": "Ændr “{name}”",
	"{count} saved changes": "{count} gemte ændringer",
	"And {count} more.": "Og {count} mere.",
	"From {place}. Not in the Company File yet.": "Fra {place}. Ikke i Virksomhedsfilen endnu.",
	"a computer": "en computer",
	"a command on a computer": "en kommando på en computer",
	"a coding session": "en kodesession",
	"a test machine": "en testmaskine",
	"the agent's workspace": "agentens arbejdsområde",
	"More saved changes wait after these.": "Flere gemte ændringer venter efter disse.",

	// An agent's interface change, with Undo (ui/interface-change-line.ts)
	"the interface “{name}”": "interfacet “{name}”",
	"the table “{name}”": "tabellen “{name}”",
	"the order of the interfaces": "rækkefølgen af interfaces",
	"made {things}": "oprettede {things}",
	"changed {things}": "ændrede {things}",
	"deleted {things}": "slettede {things}",
	"1 other change": "1 anden ændring",
	"{count} other changes": "{count} andre ændringer",
	Undo: "Fortryd",
	"Undoing…": "Fortryder…",
	"Undo: {change}": "Fortryd: {change}",
	"Undone.": "Fortrudt.",
	"Not undone: it changed again since.": "Ikke fortrudt: det er ændret igen siden.",
	"This change is too large to undo here. Ask the agent to change it back.":
		"Ændringen er for stor til at fortryde her. Bed agenten om at ændre det tilbage.",
	"This change can't be undone here. Ask the agent to change it back.":
		"Ændringen kan ikke fortrydes her. Bed agenten om at ændre det tilbage.",
	"You don't have access to change this.": "Du har ikke adgang til at ændre dette.",
	"The Company File refused it.": "Virksomhedsfilen afviste det.",
	"It changed again since.": "Det er ændret igen siden.",
	"It wasn't saved.": "Det blev ikke gemt.",
	"Undone in part. {reason}": "Delvist fortrudt. {reason}",
	"Not undone. {reason}": "Ikke fortrudt. {reason}",
	"Could not undo. Try again.": "Kunne ikke fortryde. Prøv igen.",
	// A card's long body (ui/interaction-card.ts).
	"Show more": "Vis mere",
	"Show less": "Vis mindre",
	// A member's chat with another member (app/views/member-chat.ts, app/member-chats.ts) and its row in the rail.
	"Unread: {count}": "Ulæste: {count}",
	"This member is no longer in the company.": "Dette medlem er ikke længere i virksomheden.",
	"Write the first message to {name}.": "Skriv den første besked til {name}.",
	"Message deleted": "Besked slettet",
	Seen: "Set",
	"Delete message": "Slet besked",
	"Delete this message? It is deleted for both of you.": "Slet denne besked? Den slettes for jer begge.",
	"You can no longer write to this member.": "Du kan ikke længere skrive til dette medlem.",
	"Not sent. Check your connection and try again.": "Ikke sendt. Tjek din forbindelse, og prøv igen.",
	"This chat is not available.": "Denne chat er ikke tilgængelig.",
	"Could not open this chat. Check your connection.": "Chatten kunne ikke åbnes. Tjek din forbindelse.",
	"This message is too long to send. Send it in parts.": "Beskeden er for lang til at sende. Send den i dele.",
	"Could not delete the message. Try again.": "Beskeden kunne ikke slettes. Prøv igen.",
	"The company's part of the address": "Virksomhedens del af adressen",
	"Use this address": "Brug denne adresse",
	"The address can be chosen in the chat.": "Adressen kan vælges i chatten.",
	"The address could not be made. Try again.": "Adressen kunne ikke oprettes. Prøv igen.",
	"Only founders and admins can choose the address": "Kun stiftere og administratorer kan vælge adressen",
	Free: "Ledig",
	"Already yours": "Allerede jeres",
	"That one belongs to another company": "Den tilhører en anden virksomhed",
	"Use a–z, 0–9 and hyphens": "Brug a–z, 0–9 og bindestreger",
};
