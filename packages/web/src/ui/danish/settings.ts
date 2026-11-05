/* Danish interface text, keyed by the English source exactly as the code
 * passes it to t() / uiText(). One file per area of the app; a key lives in
 * one file only (test/translations.test.ts checks). Wording follows
 * qorpera.com. */
/** Settings: General, Good will, Friends, Company, AI subscriptions, Company connections, Sites. */
export const SETTINGS: Record<string, string> = {
	// Settings dialog (app/views/settings.ts)
	"Search settings": "Søg i indstillinger",
	"No settings found.": "Ingen indstillinger fundet.",
	"Settings sections": "Indstillingssektioner",
	"Close settings": "Luk indstillinger",
	"Open a company to see these settings.": "Åbn en virksomhed for at se disse indstillinger.",

	// Profile picture (app/views/account-picture.ts, ui/picture-file.ts)
	"Profile picture": "Profilbillede",
	"Add a profile picture": "Tilføj et profilbillede",
	"Change profile picture": "Skift profilbillede",
	"Saving your profile picture": "Gemmer dit profilbillede",
	"Opening your picture": "Åbner dit billede",
	"Choose a new picture": "Vælg et nyt billede",
	"Remove picture": "Fjern billede",
	"Fit your picture": "Tilpas dit billede",
	"Drag the picture to move it; zoom to fit.": "Træk i billedet for at flytte det; zoom for at tilpasse.",
	"Picture position": "Billedets placering",
	Zoom: "Zoom",
	Save: "Gem",
	"Your picture could not be changed.": "Dit billede kunne ikke ændres.",
	"Your picture could not be saved. Try again in a moment.": "Dit billede kunne ikke gemmes. Prøv igen om lidt.",
	"Choose a picture file, such as a JPEG, PNG or WebP.": "Vælg en billedfil, for eksempel JPEG, PNG eller WebP.",
	"Choose a picture smaller than 25 MB.": "Vælg et billede, der er mindre end 25 MB.",
	"This browser could not read that picture. Try a JPEG or PNG.":
		"Browseren kunne ikke læse billedet. Prøv en JPEG eller PNG.",
	"This browser cannot prepare pictures.": "Browseren kan ikke klargøre billeder.",
	"That picture is too detailed to upload.": "Billedet er for detaljeret til at blive uploadet.",

	// General (app/views/account.ts, appearance.ts, ui/preference-picker.ts)
	"write your name": "skriv dit navn",
	Username: "Brugernavn",
	"Enter a name between 1 and 64 characters.": "Skriv et navn på mellem 1 og 64 tegn.",
	"Sign in to change your name.": "Log ind for at ændre dit navn.",
	"Your name could not be saved. Try again.": "Dit navn kunne ikke gemmes. Prøv igen.",
	"Your browser could not save the language preference.": "Din browser kunne ikke gemme dit valg af sprog.",
	"Your browser could not save the time zone preference.": "Din browser kunne ikke gemme dit valg af tidszone.",
	"Your browser could not save the theme preference.": "Din browser kunne ikke gemme dit valg af tema.",
	"Your browser could not save the composer color preference.":
		"Din browser kunne ikke gemme dit valg af farve til skrivefeltet.",
	System: "System",
	"Interface size": "Grænsefladens størrelse",
	Big: "Stor",
	Small: "Lille",
	"Your browser could not save the interface size preference.": "Din browser kunne ikke gemme dit valg af størrelse.",
	"Composer color": "Skrivefeltets farve",
	Blue: "Blå",
	Green: "Grøn",
	Grey: "Grå",
	"Language & region": "Sprog og område",
	"Search language": "Søg efter sprog",
	"Time zone": "Tidszone",
	"Message times and new routines use this zone.": "Tidspunkter på beskeder og nye rutiner følger denne zone.",
	"Search time zone": "Søg efter tidszone",
	"No matches": "Ingen resultater",
	"Clear search": "Ryd søgning",

	// Storage (app/views/storage-summary.ts)
	"{used} used of {total}": "{used} brugt af {total}",
	"{used} used": "{used} brugt",
	"Company storage used": "Brugt virksomhedslager",
	"Loading storage…": "Henter lager…",
	"Storage information unavailable": "Lageroplysninger ikke tilgængelige",
	"Open a company to see its storage.": "Åbn en virksomhed for at se dens lager.",

	// Good will (app/views/settings-good-will.ts). The name is one key: change "Goodwill" here to rename it.
	"Good will": "Goodwill",
	"We lend you our machines for free as an investment in your company. In exchange, {company} pays {name} to Qorpera. The more you earn, the smaller the rate.":
		"Vi låner jer vores maskiner gratis som en investering i jeres virksomhed. Til gengæld betaler {company} {name} til Qorpera. Jo mere I tjener, jo lavere er satsen.",
	"Loading {name}…": "Henter {name}…",
	"{name} could not be read just now.": "{name} kunne ikke læses lige nu.",
	Invoices: "Fakturaer",
	"No invoices yet": "Ingen fakturaer endnu",
	"{amount} so far this month": "{amount} indtil videre denne måned",
	"{amount} so far. Final on the 5th": "{amount} indtil videre. Endelig den 5.",
	"{amount} to be charged": "{amount} bliver trukket",
	"{amount}, waiting for a card": "{amount}, venter på et kort",
	"{amount} moves to next month (under 100 kr)": "{amount} flyttes til næste måned (under 100 kr)",
	"Nothing to pay": "Intet at betale",
	"{amount}: the card was declined. Stripe tries again.": "{amount}: kortet blev afvist. Stripe prøver igen.",
	"{amount} charged {date}": "{amount} trukket {date}",
	"{amount} charged": "{amount} trukket",
	Card: "Kort",
	"{brand} ending {last4}": "{brand} der ender på {last4}",
	"Paid with": "Betales med",
	"Your {card}": "Dit {card}",
	"{name}'s card": "{name}s kort",
	"A founder's card": "En stifters kort",
	"No card needed until there are sales": "Intet kort nødvendigt, før der er salg",
	"Add card": "Tilføj kort",
	"Change card": "Skift kort",
	"Opening…": "Åbner…",
	"Only the company's founders add its card.": "Kun virksomhedens stiftere tilføjer dens kort.",
	"Cards can't be added yet. Nothing is charged until then.":
		"Kort kan ikke tilføjes endnu. Intet bliver trukket indtil da.",
	"Payments are unavailable right now. Try again in a moment.":
		"Betaling er ikke tilgængelig lige nu. Prøv igen om lidt.",
	"{rate} of each month's first 100,000 kr from customers, then less. Moms is added on the invoice. Under 100 kr moves to the next month.":
		"{rate} af hver måneds første 100.000 kr fra kunder, derefter mindre. Moms lægges på fakturaen. Under 100 kr flyttes til næste måned.",
	"{name} in your companies": "{name} i dine virksomheder",
	"Each company pays from its own card. Where you only help out, you never pay.":
		"Hver virksomhed betaler med sit eget kort. Hvor du kun hjælper til, betaler du aldrig.",
	"paid on your card in {year}": "betalt med dit kort i {year}",
	"{amount} from customers": "{amount} fra kunder",
	"No sales yet": "Intet salg endnu",
	"Paid by another founder": "Betales af en anden stifter",
	"No card yet": "Intet kort endnu",
	"Card saved. It pays the company's next invoice.": "Kortet er gemt. Det betaler virksomhedens næste faktura.",
	// Shared with other settings pages (agent-routines.ts, settings-hooks.ts, team.ts, settings-connections.ts).
	Paused: "Sat på pause",
	Team: "Team",
	"Busy right now. Try again in a moment.": "Der er travlt lige nu. Prøv igen om lidt.",

	// Friends (app/views/friends.ts)
	"Request sent to {email}.": "Anmodning sendt til {email}.",
	Decline: "Afvis",
	"Search friends, or type an email to add someone": "Søg efter venner, eller skriv en e-mail for at tilføje nogen",
	"Company invitations": "Invitationer til virksomheder",
	"Requests for you": "Anmodninger til dig",
	"asked {date}": "modtaget {date}",
	Sent: "Sendt",
	"sent {date}": "sendt {date}",
	"Friends ({count})": "Venner ({count})",
	"since {date}": "siden {date}",
	"Loading friends": "Henter venner",
	"Nobody here by that address. Send {email} a friend request.":
		"Ingen her med den adresse. Send {email} en venneanmodning.",
	"Nobody here by that name.": "Ingen her med det navn.",
	"No Qorpera account uses {email}.": "Ingen Qorpera-konto bruger {email}.",
	"That is your own address.": "Det er din egen adresse.",
	"Looking up {email}": "Slår {email} op",
	"No friends yet. Add someone by their Qorpera email address.":
		"Ingen venner endnu. Tilføj nogen med deres Qorpera-e-mailadresse.",
	"Invite friends into your companies. Invitations to join other companies show up here too.":
		"Inviter venner ind i dine virksomheder. Invitationer til andre virksomheder vises også her.",
	"Send request": "Send anmodning",

	// Company: members, roles, invitations (app/views/team.ts)
	"Loading team": "Henter team",
	"Company members": "Virksomhedens medlemmer",
	"Role for {name}": "Rolle for {name}",
	"{name} is now {role}.": "{name} er nu {role}.",
	Founder: "Stifter",
	"Step down": "Træd tilbage",
	"Step down as founder of {company}? You stay as an admin.":
		"Træd tilbage som stifter af {company}? Du bliver administrator.",
	"You stepped down as founder.": "Du er trådt tilbage som stifter.",
	"Make founder": "Gør til stifter",
	"Make {name} a founder? Founders can only step down or leave on their own.":
		"Gør {name} til stifter? En stifter kan kun selv træde tilbage eller forlade virksomheden.",
	"Make someone else a founder before you leave.": "Gør en anden til stifter, før du forlader virksomheden.",
	"Company setup must finish before you can leave.": "Virksomheden skal være sat op, før du kan forlade den.",
	Building: "Bygger",
	"Remove {name} from {company}?": "Fjern {name} fra {company}?",
	"{name} was removed.": "{name} blev fjernet.",
	"Invited · email failed": "Inviteret · e-mail mislykkedes",
	Invited: "Inviteret",
	"Retry email": "Send e-mail igen",
	"Delivery retry queued.": "E-mailen er sat i kø igen.",
	"Invitation cancelled.": "Invitationen er annulleret.",
	"Invite a friend": "Inviter en ven",
	"Pick from your friends or add someone first": "Vælg blandt dine venner, eller tilføj nogen først",
	"Friend’s email": "Din vens e-mail",
	"Search friends": "Søg efter venner",
	"Search friends to invite": "Søg efter venner at invitere",
	"Friends to invite": "Venner at invitere",
	"No matching friends.": "Ingen venner fundet.",
	"Your friends could not be loaded. Enter an existing friend’s email below.":
		"Dine venner kunne ikke hentes. Skriv en eksisterende vens e-mail herunder.",
	"Invitation role": "Rolle for invitationen",
	Invite: "Inviter",
	"Invitation created.": "Invitationen er oprettet.",
	"Add a friend": "Tilføj en ven",
	"Delete company": "Slet virksomhed",
	"Leave company": "Forlad virksomhed",
	"Delete {company}? Type the company name to confirm.": "Slet {company}? Skriv virksomhedens navn for at bekræfte.",
	"Leave {company}? You lose access until someone invites you again.":
		"Forlad {company}? Du mister adgangen, indtil nogen inviterer dig igen.",
	Leave: "Forlad",

	// Company: memory (app/views/settings-memory.ts)
	Memory: "Hukommelse",
	"Agent notebooks": "Agenternes notesbøger",
	"Shared context — Beta": "Delt kontekst — beta",
	"Each agent keeps its own notebook of what it learns.": "Hver agent fører sin egen notesbog over det, den lærer.",
	"Agents share one summary of the company's conversations and work.":
		"Agenterne deler ét sammendrag af virksomhedens samtaler og arbejde.",
	"Not available for this company yet.": "Endnu ikke tilgængelig for denne virksomhed.",
	"Shared context — Beta is not available for this company yet.":
		"Delt kontekst — beta er endnu ikke tilgængelig for denne virksomhed.",
	"Shared context — Beta is not available now, so new runs use Agent notebooks.":
		"Delt kontekst — beta er ikke tilgængelig nu, så nye kørsler bruger Agenternes notesbøger.",
	"One run that started before the change still uses {mode} until it finishes.":
		"Én kørsel, der startede før ændringen, bruger stadig {mode}, til den er færdig.",
	"{count} runs that started before the change still use {mode} until they finish.":
		"{count} kørsler, der startede før ændringen, bruger stadig {mode}, til de er færdige.",
	"Saved. New runs use {mode}.": "Gemt. Nye kørsler bruger {mode}.",
	"Owners and admins choose the company's memory.": "Ejere og administratorer vælger virksomhedens hukommelse.",
	"A change applies to new runs. A run already started keeps its memory until it ends. Nothing is deleted or rewritten.":
		"En ændring gælder nye kørsler. En kørsel, der allerede er startet, beholder sin hukommelse, til den slutter. Intet slettes eller skrives om.",

	// Company execution (app/views/company-execution.ts)

	// AI subscriptions and Company connections (app/views/settings.ts)
	"AI subscriptions": "AI-abonnementer",
	"Company connections": "Virksomhedens forbindelser",
	"Your own AI subscriptions. They pay for the work you start, including your routines, and they leave with you.":
		"Dine egne AI-abonnementer. De betaler for det arbejde, du starter, også for dine rutiner, og de følger med dig, når du går.",
	"The company's own accounts, webhooks and mailboxes. Every agent can use them, and they stay when someone leaves.":
		"Virksomhedens egne konti, webhooks og postkasser. Alle agenter kan bruge dem, og de bliver, når nogen går.",

	// AI subscriptions: model accounts (app/views/settings-connections.ts)
	"Continue with ChatGPT": "Fortsæt med ChatGPT",
	"Opening ChatGPT…": "Åbner ChatGPT…",
	"Finishing your ChatGPT sign-in…": "Afslutter dit ChatGPT-login…",
	"Your ChatGPT plan is connected.": "Dit ChatGPT-abonnement er forbundet.",
	"Disconnect your other ChatGPT plan first.": "Afbryd først forbindelsen til dit andet ChatGPT-abonnement.",
	"Signing in with ChatGPT is not available right now.": "Login med ChatGPT er ikke tilgængeligt lige nu.",
	"The ChatGPT sign-in was cancelled.": "ChatGPT-login blev annulleret.",
	"The ChatGPT sign-in took too long. Start it again.": "ChatGPT-login tog for lang tid. Start det igen.",
	"Too many sign-ins are under way. Try again in a few minutes.":
		"Der er for mange login i gang. Prøv igen om et par minutter.",
	"The ChatGPT sign-in did not finish. Try again.": "ChatGPT-login blev ikke gjort færdigt. Prøv igen.",
	"The ChatGPT sign-in could not be started. Try again.": "ChatGPT-login kunne ikke startes. Prøv igen.",
	"ChatGPT plan": "ChatGPT-abonnement",
	"Work while you're away": "Arbejd, mens du er væk",
	"Your agents may use this plan for routines while you're away. Routines that start on a webhook or a file change never use it.":
		"Dine agenter må bruge abonnementet til rutiner, mens du er væk. Rutiner, der starter på en webhook eller en filændring, bruger det aldrig.",
	"“Work while you're away” could not be changed. Try again.":
		"“Arbejd, mens du er væk” kunne ikke ændres. Prøv igen.",
	"{minutes}m": "{minutes} min",
	"{hours}h {minutes}m": "{hours} t {minutes} min",
	"{days}d {hours}h": "{days} d {hours} t",
	"Model accounts": "Modelkonti",
	"Refreshing…": "Opdaterer…",
	Updated: "Opdateret",
	"Usage could not be refreshed. Try again.": "Forbruget kunne ikke opdateres. Prøv igen.",
	"Your model accounts could not be read.": "Dine modelkonti kunne ikke hentes.",
	"Checking…": "Tjekker…",
	"No model accounts connected.": "Ingen modelkonti er forbundet.",
	"Add account": "Tilføj konto",
	"Adding accounts is not available yet.": "Du kan ikke tilføje konti endnu.",
	"Choose a model provider": "Vælg en modeludbyder",
	"Signing out…": "Logger ud…",
	"Email unavailable": "E-mail ikke tilgængelig",
	"Connection {id}": "Forbindelse {id}",
	"Added {time} · {id}": "Tilføjet {time} · {id}",
	"Sign out and add this account again to reconnect.": "Log ud og tilføj kontoen igen for at genoprette forbindelsen.",
	"The account could not be disconnected. Try again.": "Kontoen kunne ikke afbrydes. Prøv igen.",
	"Used in all your companies": "Bruges i alle dine virksomheder",
	"Stop using here": "Stop med at bruge her",
	"Stopping…": "Stopper…",
	"Sign out everywhere": "Log ud overalt",
	"Signing out everywhere…": "Logger ud overalt…",
	"You could not be signed out everywhere. Try again.": "Du kunne ikke logges ud overalt. Prøv igen.",
	"A ChatGPT subscription you add here is used in all your companies.":
		"Et ChatGPT-abonnement, du tilføjer her, bruges i alle dine virksomheder.",
	"Add ChatGPT subscription": "Tilføj ChatGPT-abonnement",
	"This subscription was added to {company} only. Open that company to see it.":
		"Abonnementet blev kun tilføjet til {company}. Åbn virksomheden for at se det.",
	// AI subscriptions with no company open (app/views/settings-ai-subscriptions.ts)
	"Create or join a company first. Then you can add a ChatGPT subscription here.":
		"Opret eller bliv medlem af en virksomhed først. Så kan du tilføje et ChatGPT-abonnement her.",
	"Your AI subscriptions could not be read.": "Dine AI-abonnementer kunne ikke hentes.",
	"Your companies can't share an AI subscription yet. Open a company to add one there.":
		"Dine virksomheder kan ikke dele et AI-abonnement endnu. Åbn en virksomhed for at tilføje et der.",
	"Usage limit reached · resets in {time}": "Forbrugsgrænsen er nået · nulstilles om {time}",
	"Usage unavailable": "Forbrug ikke tilgængeligt",
	"{percent}% left": "{percent}% tilbage",
	"{percent}% at last check": "{percent}% ved sidste tjek",
	"{percent}% at last check · {time}": "{percent}% ved sidste tjek · {time}",
	"Last checked {time}": "Sidst tjekket {time}",
	"Resets in {time}": "Nulstilles om {time}",
	"Reset passed · awaiting updated usage": "Nulstillet · venter på opdateret forbrug",
	"Reset time unavailable": "Tidspunkt for nulstilling ikke tilgængeligt",
	"{label} remaining usage": "{label}: resterende forbrug",
	"Preparing sign-in. The first time can take a minute or two.":
		"Gør login klar. Første gang kan tage et minut eller to.",
	"Waiting for you to finish signing in…": "Venter på, at du afslutter login…",
	"Sign-in has not finished.": "Login er ikke afsluttet.",
	"Sign-in could not be started. If you started one a moment ago, give it a few minutes to clear.":
		"Login kunne ikke startes. Har du lige startet et, så giv det et par minutter.",
	"Your code:": "Din kode:",
	"Open {provider} sign-in": "Åbn login hos {provider}",
	"This page updates by itself when you are done.": "Siden opdaterer sig selv, når du er færdig.",
	// Claude sign-in (coding only, 20260930564000)
	"Open Claude sign-in": "Åbn login hos Claude",
	"Sign in on Claude's page, then paste the code it shows you here.":
		"Log ind på Claudes side, og sæt så den kode, du får vist, ind her.",
	"Paste the code from Claude": "Sæt koden fra Claude ind",
	"Paste the code from Claude first.": "Sæt koden fra Claude ind først.",
	"Connecting Claude…": "Forbinder Claude…",
	"Used only for coding sessions you start. Agents never use it for chats or routines.":
		"Bruges kun til kodesessioner, du starter. Agenter bruger det aldrig til chat eller rutiner.",
	"Used only for coding sessions you start, in all your companies. Agents never use it for chats or routines.":
		"Bruges kun til kodesessioner, du starter, i alle dine virksomheder. Agenter bruger det aldrig til chat eller rutiner.",
	"Claude is connected. It is used only for coding sessions you start.":
		"Claude er forbundet. Det bruges kun til kodesessioner, du starter.",
	"That code did not work. Start the sign-in again.": "Koden virkede ikke. Start login forfra.",
	"The Claude sign-in could not be finished. Try again.": "Login hos Claude kunne ikke afsluttes. Prøv igen.",
	"Claude · coding only": "Claude · kun kode",

	// Company connections: services (app/views/settings-services.ts, texts from cloud/connectors.ts)
	Services: "Tjenester",
	"Only founders and admins can connect or disconnect them.":
		"Kun stiftere og administratorer kan forbinde eller afbryde dem.",
	"Read and search the mailbox, send email.": "Læs og søg i postkassen, send e-mail.",
	"Find, read, create and update documents.": "Find, læs, opret og opdater dokumenter.",
	"Repositories, issues, pull requests and files.": "Repositories, issues, pull requests og filer.",
	"Use a personal access token instead": "Brug et personligt adgangstoken i stedet",
	"A fine-grained token with the repositories the agents may use.":
		"Et fine-grained token med de repositories, agenterne må bruge.",
	Connect: "Forbind",
	"Opening sign-in…": "Åbner login…",
	Disconnect: "Afbryd",
	"Working…": "Arbejder…",
	Connected: "Forbundet",
	"Connected as {account}": "Forbundet som {account}",
	"Connected by {member}": "Forbundet af {member}",
	"Connected as {account} by {member}": "Forbundet som {account} af {member}",
	"Available to every agent in the company, including new hires.":
		"Tilgængelig for alle virksomhedens agenter, også nyansatte.",
	"Paste the token": "Indsæt tokenet",
	"{service} token": "Token til {service}",
	"Save token": "Gem token",
	// Digital Post (app/views/settings-digital-post.ts)
	"Digital Post could not be read.": "Digital Post kunne ikke læses.",
	"This is not a Digital Post API key. Copy the key from the receipt Administrativ Adgang shows.":
		"Det er ikke en API-nøgle til Digital Post. Kopiér nøglen fra kvitteringen i Administrativ Adgang.",
	"Digital Post is connected. Letters arrive in the Mailbox within a few minutes.":
		"Digital Post er forbundet. Breve kommer i Postkassen inden for få minutter.",
	"The key could not be saved. Check it and try again.": "Nøglen kunne ikke gemmes. Tjek den, og prøv igen.",
	"Digital Post is disconnected. Remove the Qorpera system in Administrativ Adgang too, or Digital Post keeps sending to it and moves the letters to Virk after seven days.":
		"Digital Post er afbrudt. Fjern også Qorpera-systemet i Administrativ Adgang, ellers bliver Digital Post ved med at sende til det og flytter brevene til Virk efter syv dage.",
	"Digital Post could not be disconnected. Try again.": "Digital Post kunne ikke afbrydes. Prøv igen.",
	"Connected. Checking Digital Post…": "Forbundet. Tjekker Digital Post …",
	"Digital Post refused the key. Save the key again.": "Digital Post afviste nøglen. Gem nøglen igen.",
	"Digital Post wasn't reached at the last try: {reason}": "Digital Post kunne ikke nås ved sidste forsøg: {reason}",
	"no reason given": "ingen årsag oplyst",
	"Connected · checked {when}": "Forbundet · tjekket {when}",
	"system {id}": "system {id}",
	"{count} letters": "{count} breve",
	"1 letter": "1 brev",
	"Set Qorpera up as the company's Digital Post system, in Digital Post's own Administrativ Adgang:":
		"Opsæt Qorpera som virksomhedens Digital Post-system i Digital Posts egen Administrativ Adgang:",
	"Open Administrativ Adgang": "Åbn Administrativ Adgang",
	"and sign in with MitID Erhverv. You need Digital Post's system administrator right, which the company's rights administrator gives in Rettighedsportalen.":
		"og log ind med MitID Erhverv. Du skal have rettigheden Systemadministrator i Digital Post, som virksomhedens rettighedsadministrator giver i Rettighedsportalen.",
	"Choose Systemtilslutning, Opret system, Opsæt et nyt system. Name it Qorpera and set it up as a Modtagersystem.":
		"Vælg Systemtilslutning, Opret system, Opsæt et nyt system. Kald det Qorpera, og opsæt det som Modtagersystem.",
	"Choose REST PULL and add these IP addresses:": "Vælg REST PULL, og tilføj disse IP-adresser:",
	"Under Giv din systemleverandør fuldmagt, type Qorpera's CVR:":
		"Skriv Qorperas CVR under Giv din systemleverandør fuldmagt:",
	"Activate it now, give a contact email, and press Tilslut.":
		"Aktivér det nu, angiv en kontakt-e-mail, og tryk Tilslut.",
	"Copy the API key from the receipt and paste it here.": "Kopiér API-nøglen fra kvitteringen, og indsæt den her.",
	"From then on, the company's public post comes to Qorpera instead of e-Boks, mit.dk and Virk. A letter Qorpera can't read goes to Virk after seven days.":
		"Herefter kommer virksomhedens offentlige post til Qorpera i stedet for e-Boks, mit.dk og Virk. Et brev, Qorpera ikke kan læse, går til Virk efter syv dage.",
	"Paste the API key": "Indsæt API-nøglen",
	"Digital Post API key": "API-nøgle til Digital Post",
	"Save key": "Gem nøgle",
	"Replace key": "Udskift nøgle",
	"Letters from public authorities, in the Mailbox and the company folder.":
		"Breve fra offentlige myndigheder, i Postkassen og virksomhedens mappe.",
	"Letters from public authorities (Skattestyrelsen, Erhvervsstyrelsen, the municipality) arrive in the Mailbox and the company folder, where the agents read them.":
		"Breve fra offentlige myndigheder (Skattestyrelsen, Erhvervsstyrelsen, kommunen) kommer i Postkassen og virksomhedens mappe, hvor agenterne læser dem.",
	"Not available yet: Qorpera's Digital Post connection is being set up.":
		"Ikke tilgængelig endnu: Qorperas forbindelse til Digital Post er ved at blive sat op.",
	"{count} letters couldn't be read here; Digital Post puts them in the company's Virk mailbox.":
		"{count} breve kunne ikke læses her; Digital Post lægger dem i virksomhedens postkasse på Virk.",
	"1 letter couldn't be read here; Digital Post puts it in the company's Virk mailbox.":
		"1 brev kunne ikke læses her; Digital Post lægger det i virksomhedens postkasse på Virk.",
	"Every agent in the company can read the letters.": "Alle agenter i virksomheden kan læse brevene.",
	"Only founders and admins can connect or disconnect it.":
		"Kun stiftere og administratorer kan forbinde eller afbryde den.",
	"Finishing the {service} connection…": "Afslutter forbindelsen til {service}…",
	"{service} is connected. The company's agents can use it from their next run.":
		"{service} er forbundet. Virksomhedens agenter kan bruge den fra deres næste kørsel.",
	"{service} was not connected.": "{service} blev ikke forbundet.",
	"Try again.": "Prøv igen.",
	"The sign-in was cancelled before access was granted.": "Login blev annulleret, før der blev givet adgang.",
	"The sign-in took too long. Try again.": "Login tog for lang tid. Prøv igen.",
	"Google did not grant lasting access. Try again and allow all requested access.":
		"Google gav ikke varig adgang. Prøv igen, og tillad al den adgang, der bliver bedt om.",
	"The service did not complete the sign-in. Try again.": "Tjenesten gennemførte ikke login. Prøv igen.",
	"This sign-in link is no longer valid. Try again.": "Dette loginlink er ikke længere gyldigt. Prøv igen.",
	"The sign-in was finished in another browser. Start it again here.":
		"Login blev afsluttet i en anden browser. Start det igen her.",
	"The account is connected, but the company's agents could not get it yet. Disconnect it and connect it again.":
		"Kontoen er forbundet, men virksomhedens agenter kunne ikke få adgang til den endnu. Afbryd den, og forbind den igen.",
	"The company's services could not be read.": "Virksomhedens tjenester kunne ikke hentes.",
	"The sign-in could not be started. Try again.": "Login kunne ikke startes. Prøv igen.",
	"The token could not be saved. Try again.": "Tokenet kunne ikke gemmes. Prøv igen.",
	"The service could not be disconnected. Try again.": "Tjenesten kunne ikke afbrydes. Prøv igen.",

	// Company connections: webhooks and mailboxes (app/views/settings-hooks.ts)
	Webhooks: "Webhooks",
	Mailboxes: "Postkasser",
	"Only founders and admins can add, pause or remove them.":
		"Kun stiftere og administratorer kan tilføje, sætte på pause eller fjerne dem.",
	"No webhooks yet. A webhook lets another service, such as a shop or a payment provider, start the company's routines.":
		"Ingen webhooks endnu. Med en webhook kan en anden tjeneste, f.eks. en webshop eller en betalingsudbyder, starte virksomhedens rutiner.",
	"No mailboxes yet. Email sent to a company mailbox can start the company's routines.":
		"Ingen postkasser endnu. E-mail sendt til en af virksomhedens postkasser kan starte virksomhedens rutiner.",
	"The company's webhooks and mailboxes could not be read.": "Virksomhedens webhooks og postkasser kunne ikke hentes.",
	"Waiting for its signing secret": "Venter på sin signeringsnøgle",
	"Last event {time}": "Seneste hændelse {time}",
	"Last refused event {time}: {reason}": "Seneste afviste hændelse {time}: {reason}",
	"No events yet": "Ingen hændelser endnu",
	"Last email {time}": "Seneste e-mail {time}",
	"No email yet": "Ingen e-mail endnu",
	"Signed by Stripe": "Signeret af Stripe",
	"Signed by GitHub": "Signeret af GitHub",
	"Signed by its sender": "Signeret af afsenderen",
	Copy: "Kopiér",
	"Anyone with this address can send to it. Give it only to the service that sends the events.":
		"Alle med denne adresse kan sende til den. Giv den kun til den tjeneste, der sender hændelserne.",
	"The address is copied.": "Adressen er kopieret.",
	"The address could not be copied. Select it and copy it.":
		"Adressen kunne ikke kopieres. Markér den, og kopiér den.",
	Pause: "Sæt på pause",
	Resume: "Genoptag",
	"Remove the webhook {name}? Anything sent to its address afterwards is turned away.":
		"Fjern webhooken {name}? Alt, hvad der sendes til dens adresse bagefter, bliver afvist.",
	"Remove the mailbox {name}? Email sent to it afterwards does not reach the company.":
		"Fjern postkassen {name}? E-mail, der sendes til den bagefter, når ikke frem til virksomheden.",
	"It could not be changed. Try again.": "Den kunne ikke ændres. Prøv igen.",
	"Add webhook": "Tilføj webhook",
	"Add mailbox": "Tilføj postkasse",
	"Webhook name": "Webhookens navn",
	"Mailbox name": "Postkassens navn",
	"e.g. new-orders": "f.eks. nye-ordrer",
	"e.g. invoices": "f.eks. fakturaer",
	"What it is for": "Hvad den er til",
	"What it is for, e.g. new orders from the shop": "Hvad den er til, f.eks. nye ordrer fra webshoppen",
	"What it is for, e.g. invoices from suppliers": "Hvad den er til, f.eks. fakturaer fra leverandører",
	"Lowercase letters, digits and hyphens, starting with a letter. The company's agents read what it is for when something arrives.":
		"Små bogstaver, tal og bindestreger, og den starter med et bogstav. Virksomhedens agenter læser, hvad den er til, når der kommer noget.",
	"The part before the @: lowercase letters, digits, dots, hyphens and underscores.":
		"Delen før @: små bogstaver, tal, punktummer, bindestreger og understregninger.",
	Add: "Tilføj",
	"Adding…": "Tilføjer…",
	"A webhook name is lowercase letters, digits and hyphens, and starts with a letter.":
		"Et webhooknavn består af små bogstaver, tal og bindestreger og starter med et bogstav.",
	"Names beginning with mail- belong to mailboxes.": "Navne, der begynder med mail-, hører til postkasser.",
	"A mailbox name is lowercase letters, digits, dots, hyphens and underscores, and starts and ends with a letter or digit.":
		"Et postkassenavn består af små bogstaver, tal, punktummer, bindestreger og understregninger og starter og slutter med et bogstav eller et tal.",
	"Say what it is for, in one line.": "Skriv på én linje, hvad den er til.",
	"A webhook with this name already exists.": "Der findes allerede en webhook med dette navn.",
	"This address is taken.": "Denne adresse er taget.",
	"This mailbox name is reserved. Choose another.": "Dette postkassenavn er reserveret. Vælg et andet.",
	"Company mail is not set up yet.": "Virksomhedsmail er ikke sat op endnu.",
	"The company has as many webhooks and mailboxes as it can have. Remove one first.":
		"Virksomheden har så mange webhooks og postkasser, som den kan have. Fjern en først.",
	"The webhook could not be added. Try again.": "Webhooken kunne ikke tilføjes. Prøv igen.",
	"The mailbox could not be added. Try again.": "Postkassen kunne ikke tilføjes. Prøv igen.",
	"The webhook is ready. Give its address to the service that sends the events.":
		"Webhooken er klar. Giv dens adresse til den tjeneste, der sender hændelserne.",
	"The mailbox is ready. Email sent to it can start the company's routines.":
		"Postkassen er klar. E-mail sendt til den kan starte virksomhedens rutiner.",

	// Sites: the websites the company's agents published (app/views/settings-sites.ts)
	Sites: "Hjemmesider",
	"Websites the company's agents published. Each has its own link and password; share both with the people who should see it.":
		"Hjemmesider, som virksomhedens agenter har udgivet. Hver har sit eget link og sin egen adgangskode; del begge med dem, der skal se den.",
	"Only founders and admins can see passwords or take sites offline.":
		"Kun stiftere og administratorer kan se adgangskoder eller tage hjemmesider offline.",
	"No sites yet. When an agent publishes a website for the company, it shows here with its link and password.":
		"Ingen hjemmesider endnu. Når en agent udgiver en hjemmeside for virksomheden, vises den her med sit link og sin adgangskode.",
	"The company's sites could not be read.": "Virksomhedens hjemmesider kunne ikke hentes.",
	"Publishing…": "Udgiver…",
	"Published {time} by {agent}": "Udgivet {time} af {agent}",
	"Published {time}": "Udgivet {time}",
	"1 file": "1 fil",
	"From {source}": "Fra {source}",
	"The link is copied.": "Linket er kopieret.",
	"The link could not be copied. Select it and copy it.": "Linket kunne ikke kopieres. Markér det, og kopiér det.",
	"Show password": "Vis adgangskode",
	Hide: "Skjul",
	"The password is copied.": "Adgangskoden er kopieret.",
	"The password could not be copied. Select it and copy it.":
		"Adgangskoden kunne ikke kopieres. Markér den, og kopiér den.",
	"Share the link and this password only with the people who should see the site. A visitor's own link opens the site for 7 days; a new password ends every visit.":
		"Del kun linket og denne adgangskode med dem, der skal se hjemmesiden. En besøgendes eget link åbner hjemmesiden i 7 dage; en ny adgangskode afslutter alle besøg.",
	"The password could not be read. Try again.": "Adgangskoden kunne ikke hentes. Prøv igen.",
	"Change password": "Skift adgangskode",
	"Type a new password, 10 to 128 characters": "Skriv en ny adgangskode på 10 til 128 tegn",
	"New password for {name}": "Ny adgangskode til {name}",
	"Save password": "Gem adgangskode",
	"Make a new password": "Lav en ny adgangskode",
	"Every visitor enters the new password; the old one stops working at once.":
		"Alle besøgende skal skrive den nye adgangskode; den gamle holder op med at virke med det samme.",
	"A site password is 10 to 128 characters.": "En adgangskode til en hjemmeside er på 10 til 128 tegn.",
	"The password is changed. Every visitor enters the new one.":
		"Adgangskoden er skiftet. Alle besøgende skal skrive den nye.",
	"The password could not be changed. Try again.": "Adgangskoden kunne ikke skiftes. Prøv igen.",
	Unpublish: "Tag offline",
	"Take {name} offline? Its link stops working and its password is deleted. The files stay in the Company File.":
		"Tag {name} offline? Linket holder op med at virke, og adgangskoden slettes. Filerne bliver i Virksomhedsfilen.",
	"The site could not be taken offline. Try again.": "Hjemmesiden kunne ikke tages offline. Prøv igen.",
	// An app link: one port of a company machine at a site's link (v195)
	"App on machine {name}, port {port}": "App på maskinen {name}, port {port}",
	"App on port {port} of a machine that was deleted": "App på port {port} på en maskine, der er slettet",
	"Take {name} offline? Its link stops working and its password is deleted. The app keeps running on its machine.":
		"Tag {name} offline? Linket holder op med at virke, og adgangskoden slettes. Appen bliver ved med at køre på sin maskine.",

	// Environment variables for coding, in both connections tabs (app/views/settings-coding-environment.ts)
	"Environment variables for coding": "Miljøvariabler til kodning",
	"Your coding sessions get these in every repository. They leave with you.":
		"Dine kodesessioner får dem i alle repositories. De følger med dig, når du går.",
	"A coding session gets one of these only in a repository it's given to. They stay when someone leaves.":
		"En kodesession får kun en af dem i et repository, den er givet til. De bliver, når nogen går.",
	"Only founders and admins can add, change or remove them.":
		"Kun stiftere og administratorer kan tilføje, ændre eller fjerne dem.",
	"Viewers can see them, but not add or change them.": "Læsere kan se dem, men ikke tilføje eller ændre dem.",
	"Add a variable": "Tilføj en variabel",
	"No variables yet.": "Ingen variabler endnu.",
	"The environment variables could not be read.": "Miljøvariablerne kunne ikke hentes.",
	"Coding sessions in {repositories} get it.": "Kodesessioner i {repositories} får den.",
	"No coding session gets it yet.": "Ingen kodesession får den endnu.",
	"Your coding sessions get it.": "Dine kodesessioner får den.",
	"In {repositories}, the company's {name} is used instead.": "I {repositories} bruges virksomhedens {name} i stedet.",
	"Replace value": "Erstat værdien",
	"Give to a repository": "Giv den til et repository",
	"Once saved, a value is never shown again.": "Når en værdi er gemt, bliver den aldrig vist igen.",
	"Paste the new value": "Indsæt den nye værdi",
	"New value for {name}": "Ny værdi for {name}",
	"Save value": "Gem værdien",
	"Coding sessions in that repository get {name} from their next start.":
		"Kodesessioner i det repository får {name} fra deres næste start.",
	"owner/name": "ejer/navn",
	"Repository for {name}": "Repository til {name}",
	"Remove {repository}": "Fjern {repository}",
	"e.g. NPM_TOKEN": "f.eks. NPM_TOKEN",
	"Variable name": "Variablens navn",
	"Capital letters, digits and underscores, starting with a letter.":
		"Store bogstaver, tal og understregninger, og navnet starter med et bogstav.",
	"What it is for, e.g. installs private packages": "Hvad den er til, f.eks. installerer private pakker",
	"Paste the value": "Indsæt værdien",
	Value: "Værdi",
	"A variable name is capital letters, digits and underscores, and starts with a letter.":
		"Et variabelnavn består af store bogstaver, tal og understregninger og starter med et bogstav.",
	"The value must be at least 8 characters.": "Værdien skal være mindst 8 tegn.",
	"The value can be at most 32 KB.": "Værdien må højst fylde 32 KB.",
	"The value can't contain a null character.": "Værdien må ikke indeholde et nul-tegn.",
	"That name is taken by the coding machine or an AI provider's sign-in. Choose another.":
		"Det navn bruges af kodemaskinen eller af et login hos en AI-udbyder. Vælg et andet.",
	"An earlier try to save this value is still open. Try again in a few minutes.":
		"Et tidligere forsøg på at gemme værdien er stadig åbent. Prøv igen om et par minutter.",
	"Write the repository as owner/name, for example acme/web.": "Skriv repositoriet som ejer/navn, f.eks. acme/web.",
	"{name} is saved. Your coding sessions get it from their next start.":
		"{name} er gemt. Dine kodesessioner får den fra deres næste start.",
	"{name} is saved. Give it to a repository so coding sessions there get it.":
		"{name} er gemt. Giv den til et repository, så kodesessioner der får den.",
	"The value of {name} is replaced. Your coding sessions get the new one from their next start.":
		"Værdien af {name} er erstattet. Dine kodesessioner får den nye fra deres næste start.",
	"The value of {name} is replaced. Coding sessions in {repositories} get the new one from their next start.":
		"Værdien af {name} er erstattet. Kodesessioner i {repositories} får den nye fra deres næste start.",
	"The value of {name} is replaced. No coding session gets it yet.":
		"Værdien af {name} er erstattet. Ingen kodesession får den endnu.",
	"Coding sessions in {repository} get {name} from their next start.":
		"Kodesessioner i {repository} får {name} fra deres næste start.",
	"Remove {name}? New coding sessions won't get it.": "Fjern {name}? Nye kodesessioner får den ikke.",
	"Coding sessions in {repository} will stop getting {name}.":
		"Kodesessioner i {repository} holder op med at få {name}.",

	// Rules, auto-review (Settings → General, settings-rules.ts)
	Rules: "Regler",
	"e.g. reply to emails for me": "f.eks. svare på e-mails for mig",
	"When an agent wants to:": "Når en agent vil:",
	"It should:": "Så skal den:",
	"Allow automatically": "Tillad automatisk",
	"Ask first": "Spørg først",
	"Applies to:": "Gælder for:",
	"Only me": "Kun mig",
	"Everyone in the company": "Alle i virksomheden",
	"Add rule": "Tilføj regel",
	Action: "Handling",
	Behavior: "Adfærd",
	"Applies to": "Gælder for",
	"Edit or remove": "Rediger eller fjern",
	"Edit the rule: {rule}": "Rediger reglen: {rule}",
	"Remove the rule: {rule}": "Fjern reglen: {rule}",
	"Owners and admins change company rules.": "Ejere og administratorer ændrer virksomhedens regler.",
	Locked: "Låst",
	"Rules are not available on this cloud yet.": "Regler er ikke tilgængelige i denne sky endnu.",
	"Built-in safety checks always apply.": "Indbyggede sikkerhedstjek gælder altid.",
	"Open a company to see its rules.": "Åbn en virksomhed for at se dens regler.",
	// Settings → Company → Pages (views/settings-pages.ts)
	Pages: "Sider",
	Mailbox: "Postkasse",
	Members: "Medlemmer",
	"The company's mail, for every member. It shows once the company has a mail address (Company connections → Mailboxes).":
		"Virksomhedens post, for alle medlemmer. Den vises, når virksomheden har en mailadresse (Virksomhedens forbindelser → Postkasser).",
	"Who owns and supervises each agent. It shows once the company has a second member.":
		"Hvem der ejer og har tilsyn med hver agent. Den vises, når virksomheden har mindst to medlemmer.",
	Bank: "Bank",
	"The company's bank account: the saldo, and what comes in and goes out each month.":
		"Virksomhedens bankkonto: saldoen, og hvad der kommer ind og går ud hver måned.",
	"{page} could not be changed. Try again.": "{page} kunne ikke ændres. Prøv igen.",
	"Pages are not available on this cloud yet.": "Sider er ikke tilgængelige i denne sky endnu.",
	"Switching a page off only hides it. Nothing it showed is removed.":
		"At slå en side fra skjuler den kun. Intet af det, den viste, bliver fjernet.",
	"Only owners and admins can switch pages on or off.": "Kun ejere og administratorer kan slå sider til og fra.",
};
