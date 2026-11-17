/* Danish interface text, keyed by the English source exactly as the code
 * passes it to t() / uiText(). One file per area of the app; a key lives in
 * one file only (test/translations.test.ts checks). Wording follows
 * qorpera.com. */
/** Settings: General, Good will, Friends, Company, AI subscriptions, Sites. */
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
	"{used} in total": "{used} i alt",
	"Loading storage…": "Henter lager…",
	"Storage information unavailable": "Lageroplysninger ikke tilgængelige",
	"Open a company to see its storage.": "Åbn en virksomhed for at se dens lager.",

	// Good will (app/views/settings-good-will.ts). The name is one key: change "Goodwill" here to rename it.
	"Good will": "Goodwill",
	"We lend you our machines for free as an investment in your company. In exchange, {company} pays a good will tax to Qorpera. The more you earn, the smaller the tax rate.":
		"Vi låner jer vores maskiner gratis som en investering i jeres virksomhed. Til gengæld betaler {company} en goodwill-skat til Qorpera. Jo mere I tjener, jo lavere er satsen.",
	"Loading {name}…": "Henter {name}…",
	"{name} could not be read just now.": "{name} kunne ikke læses lige nu.",
	Invoices: "Fakturaer",
	"No invoices yet": "Ingen fakturaer endnu",
	"{amount} so far this month": "{amount} indtil videre denne måned",
	"{amount} so far. Final on the 5th": "{amount} indtil videre. Endelig den 5.",
	"{amount} to be charged": "{amount} bliver trukket",
	"{amount}, waiting for a card": "{amount}, venter på et kort",
	"{amount} moves to next month": "{amount} flyttes til næste måned",
	"{amount} moves to next month (under {least})": "{amount} flyttes til næste måned (under {least})",
	"Nothing to pay": "Intet at betale",
	"Not charged: payments were not open yet": "Ikke trukket: betaling var ikke åbnet endnu",
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
	"{rate} of each month's first {amount} from customers, then less. Moms is added on the invoice.":
		"{rate} af hver måneds første {amount} fra kunder, derefter mindre. Moms lægges på fakturaen.",
	"Under {least} moves to the next month.": "Under {least} flyttes til næste måned.",
	"Open the invoice for {month}": "Åbn fakturaen for {month}",
	"{name} in your companies": "{name} i dine virksomheder",
	"Each company pays from its own card. Where you only help out, you never pay.":
		"Hver virksomhed betaler med sit eget kort. Hvor du kun hjælper til, betaler du aldrig.",
	"paid on your card in {year}": "betalt med dit kort i {year}",
	"{amount} from customers": "{amount} fra kunder",
	"No sales yet": "Intet salg endnu",
	"Paid by another founder": "Betales af en anden stifter",
	"No card yet": "Intet kort endnu",
	"Card saved. It pays the company's next invoice.": "Kortet er gemt. Det betaler virksomhedens næste faktura.",
	"Your card could not pay {month}'s {name} of {amount}. Stripe tries again, or open the invoice to pay it another way.":
		"Dit kort kunne ikke betale {name} for {month} på {amount}. Stripe prøver igen, eller åbn fakturaen og betal på en anden måde.",
	"The company's card could not pay {month}'s {name} of {amount}. Stripe tries again, or open the invoice to pay it another way.":
		"Virksomhedens kort kunne ikke betale {name} for {month} på {amount}. Stripe prøver igen, eller åbn fakturaen og betal på en anden måde.",
	"Open the invoice": "Åbn fakturaen",
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

	// Company execution (app/views/company-execution.ts)

	// AI subscriptions (app/views/settings.ts)
	"AI subscriptions": "AI-abonnementer",
	"Your own AI subscriptions. They pay for the work you start, including your routines, and they leave with you.":
		"Dine egne AI-abonnementer. De betaler for det arbejde, du starter, også for dine rutiner, og de følger med dig, når du går.",

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

	// Connect, Disconnect, Working… and Connected (several pages)
	Connect: "Forbind",
	Disconnect: "Afbryd",
	"Working…": "Arbejder…",
	Connected: "Forbundet",
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
	"The sign-in took too long. Try again.": "Login tog for lang tid. Prøv igen.",
	"This sign-in link is no longer valid. Try again.": "Dette loginlink er ikke længere gyldigt. Prøv igen.",
	"The sign-in was finished in another browser. Start it again here.":
		"Login blev afsluttet i en anden browser. Start det igen her.",
	"The sign-in could not be started. Try again.": "Login kunne ikke startes. Prøv igen.",

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
	"Lowercase letters, digits and hyphens, starting with a letter. The company's agents read what it is for when something arrives.":
		"Små bogstaver, tal og bindestreger, og den starter med et bogstav. Virksomhedens agenter læser, hvad den er til, når der kommer noget.",
	"The first part of the address: lowercase letters, digits, hyphens and underscores.":
		"Adressens første del: små bogstaver, tal, bindestreger og understregninger.",
	"The first part, then the company's part, which every address of the company ends with.":
		"Den første del og så virksomhedens del, som alle virksomhedens adresser slutter med.",
	"e.g. acme": "f.eks. acme",
	"Your email address waits for a name": "Jeres e-mailadresse venter på et navn",
	"The company's part of its addresses could not be read.": "Virksomhedens del af dens adresser kunne ikke hentes.",
	Add: "Tilføj",
	"Adding…": "Tilføjer…",
	"A webhook name is lowercase letters, digits and hyphens, and starts with a letter.":
		"Et webhooknavn består af små bogstaver, tal og bindestreger og starter med et bogstav.",
	"Names beginning with mail- belong to mailboxes.": "Navne, der begynder med mail-, hører til postkasser.",
	"A mailbox name is lowercase letters, digits, hyphens and underscores, and starts and ends with a letter or digit.":
		"Et postkassenavn består af små bogstaver, tal, bindestreger og understregninger og starter og slutter med et bogstav eller et tal.",
	"A new address is a name, a dot and the company's handle, like hello.acme.":
		"En ny adresse er et navn, et punktum og virksomhedens del, som hello.acme.",
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
	"Share a site with its link and password.": "Del en hjemmeside med dens link og adgangskode.",
	"Only founders and admins can see passwords or take sites offline.":
		"Kun stiftere og administratorer kan se adgangskoder eller tage hjemmesider offline.",
	"No sites yet": "Ingen hjemmesider endnu",
	"Ask an agent for a website and it shows up here.": "Bed en agent om en hjemmeside, så dukker den op her.",
	"The company's sites could not be read.": "Virksomhedens hjemmesider kunne ikke hentes.",
	"Publishing…": "Udgiver…",
	"Published {time} by {agent}": "Udgivet {time} af {agent}",
	"Published {time}": "Udgivet {time}",
	"Copy the link": "Kopiér linket",
	"The link": "Linket",
	"The link is copied.": "Linket er kopieret.",
	"Show password": "Vis adgangskode",
	"Hide password": "Skjul adgangskode",
	"Copy the password": "Kopiér adgangskoden",
	"The password": "Adgangskoden",
	"The password is copied.": "Adgangskoden er kopieret.",
	"Press ⌘C to copy.": "Tryk ⌘C for at kopiere.",
	"Press Ctrl+C to copy.": "Tryk Ctrl+C for at kopiere.",
	"The password could not be read. Try again.": "Adgangskoden kunne ikke hentes. Prøv igen.",
	"More options for {name}": "Flere muligheder for {name}",
	"Change password": "Skift adgangskode",
	"Type a new password, 10 to 128 characters": "Skriv en ny adgangskode på 10 til 128 tegn",
	"New password for {name}": "Ny adgangskode til {name}",
	"Save password": "Gem adgangskode",
	"Make a new password": "Lav en ny adgangskode",
	"Every visitor enters the new password; the old one stops working at once.":
		"Alle besøgende skal skrive den nye adgangskode; den gamle holder op med at virke med det samme.",
	"A site password is 10 to 128 characters.": "En adgangskode til en hjemmeside er på 10 til 128 tegn.",
	"The password is changed.": "Adgangskoden er skiftet.",
	"The password could not be changed. Try again.": "Adgangskoden kunne ikke skiftes. Prøv igen.",
	"Take offline": "Tag offline",
	"Take {name} offline? Its link stops working and its password is deleted. The files stay in the Company File.":
		"Tag {name} offline? Linket holder op med at virke, og adgangskoden slettes. Filerne bliver i Virksomhedsfilen.",
	"{name} is offline.": "{name} er offline.",
	"The site could not be taken offline. Try again.": "Hjemmesiden kunne ikke tages offline. Prøv igen.",
	// An app link: one port of a company machine at a site's link (v195)
	"Take {name} offline? Its link stops working and its password is deleted. The app keeps running on its machine.":
		"Tag {name} offline? Linket holder op med at virke, og adgangskoden slettes. Appen bliver ved med at køre på sin maskine.",
	// A project's site made from its code kept in Qorpera: its version goes live from What's new (own code storage step 4)
	"Version {version}": "Version {version}",
	"Take {name} offline? Its earlier versions go with it. The newest one waits in What's new, with a new password, until you put it live.":
		"Tag {name} offline? Dens tidligere versioner forsvinder med den. Den nyeste venter under Nyheder med en ny adgangskode, til du sætter den live.",
	// A site Qorpera took down: why, in place of its link and password (own code storage step 5.1)
	"Taken down": "Taget ned",
	"Qorpera took this site down: {reason}. If you think this is wrong, tell us with {feedback} in your menu.":
		"Qorpera har taget hjemmesiden ned: {reason}. Hvis du mener, det er forkert, så skriv til os under {feedback} i din menu.",

	// What's new: the changes to the company's sites made from its code, ready to go live (app/views/whats-new.ts)
	"What's new": "Nyheder",
	"What's new could not be read.": "Nyheder kunne ikke hentes.",
	"Live now": "Live nu",
	"Not live yet": "Ikke live endnu",
	"Version {version} · since {time}": "Version {version} · siden {time}",
	"Version {version} · since {time} · {name} said go": "Version {version} · siden {time} · {name} sagde ja",
	"Version {version} · since {time} · {name} went back":
		"Version {version} · siden {time} · {name} satte den live igen",
	"The password is in Sites.": "Adgangskoden står under Hjemmesider.",
	"Open the site": "Åbn hjemmesiden",
	"Go back to version {version}": "Gå tilbage til version {version}",
	"Put version {version} back up? Version {current} comes off the site at once; its changes stay ready.":
		"Sæt version {version} live igen? Version {current} tages af hjemmesiden med det samme; dens ændringer er stadig klar.",
	"Go back": "Gå tilbage",
	"1 change is ready": "1 ændring er klar",
	"{count} changes are ready": "{count} ændringer er klar",
	"and 1 change behind the scenes": "og 1 ændring bag kulisserne",
	"and {count} changes behind the scenes": "og {count} ændringer bag kulisserne",
	"1 change behind the scenes": "1 ændring bag kulisserne",
	"{count} changes behind the scenes": "{count} ændringer bag kulisserne",
	"Was live before": "Har været live før",
	"Put it live": "Sæt live",
	"Put the first version live": "Sæt den første version live",
	"Not yet": "Ikke endnu",
	"Not yet: ": "Ikke endnu: ",
	"Putting it live…": "Sætter den live…",
	"Version {version} is live.": "Version {version} er live.",
	"Nothing new is ready.": "Intet nyt er klar.",
	"1 more change is not ready yet.": "1 ændring mere er ikke klar endnu.",
	"{count} more changes are not ready yet.": "{count} ændringer mere er ikke klar endnu.",
	"Founders and admins put changes live.": "Stiftere og administratorer sætter ændringer live.",
	"Something changed while you looked. Here is what is ready now.":
		"Noget har ændret sig, mens du kiggede. Her er det, der er klar nu.",
	"Something changed while you looked. Here is what is live now.":
		"Noget har ændret sig, mens du kiggede. Her er det, der er live nu.",
	"It did not go live: {why}. Nothing changed.": "Det blev ikke sat live: {why}. Intet er ændret.",
	"It did not go back: {why}. Nothing changed.": "Den blev ikke sat live igen: {why}. Intet er ændret.",
	"only founders and admins can put a version live": "kun stiftere og administratorer kan sætte en version live",
	"Qorpera was busy for a moment": "Qorpera havde travlt et øjeblik",
	"the project is no longer there": "projektet findes ikke længere",
	"something went wrong on Qorpera's side": "noget gik galt hos Qorpera",
	"This project can't get a site: the company has 10. Take one offline in Sites.":
		"Projektet kan ikke få en hjemmeside: virksomheden har allerede 10. Tag en offline under Hjemmesider.",
	"The newest version could not be prepared. Qorpera is trying again.":
		"Den nyeste version kunne ikke gøres klar. Qorpera prøver igen.",
	"The newest version could not be prepared. The next change that is saved gets a new try.":
		"Den nyeste version kunne ikke gøres klar. Den næste ændring, der gemmes, får et nyt forsøg.",
	"It may not have gone live: Qorpera could not be reached. Checking…":
		"Den er måske ikke blevet sat live: Qorpera kunne ikke nås. Tjekker…",
	"It may not have gone back: Qorpera could not be reached. Checking…":
		"Den er måske ikke blevet sat live igen: Qorpera kunne ikke nås. Tjekker…",
	"Qorpera could not be reached, so it is not known whether it went live. Open this page again in a moment.":
		"Qorpera kunne ikke nås, så det vides ikke, om den blev sat live. Åbn denne side igen om lidt.",
	"Qorpera could not be reached, so it is not known whether it went back. Open this page again in a moment.":
		"Qorpera kunne ikke nås, så det vides ikke, om den blev sat live igen. Åbn denne side igen om lidt.",
	// Look first: the ready version at the site's next address, before it goes live; and a site Qorpera took down (own
	// code storage step 5.1)
	"Look first": "Se den først",
	// "A change is ready" in the agent's thread (app/views/thread-ready.ts)
	"Ready to go live": "Klar til at gå live",
	"and 1 more change": "og 1 ændring mere",
	"and {count} more changes": "og {count} ændringer mere",
	"The next version could not be opened. Try again.": "Den næste version kunne ikke åbnes. Prøv igen.",
	"The next version could not be opened: Qorpera could not be reached. Try again.":
		"Den næste version kunne ikke åbnes: Qorpera kunne ikke nås. Prøv igen.",
	"Qorpera took this site down, so it can't be opened. See why in Sites.":
		"Qorpera har taget hjemmesiden ned, så den kan ikke åbnes. Se hvorfor under Hjemmesider.",
	"Only founders and admins can look at a version before it goes live.":
		"Kun stiftere og administratorer kan se en version, før den går live.",
	"Qorpera took this site down": "Qorpera har taget hjemmesiden ned",

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

	// Agent rules, auto-review (Settings → Company, settings-rules.ts)
	"Agent rules": "Agentregler",
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
	// The pages, hidden and shown from the rail (views/shell.ts)
	Mailbox: "Postkasse",
	Bank: "Bank",
	"{page} could not be changed. Try again.": "{page} kunne ikke ændres. Prøv igen.",
	// The Friends window and Settings → Leaderboard (views/friends-window.ts, views/leaderboard.ts)
	"Online now": "Online nu",
	"Last online {when}": "Sidst online {when}",
	"Last online 2+ weeks ago": "Sidst online for over 2 uger siden",
	"Friends {since}": "Venner {since}",
	"Close friends": "Luk venner",
	"Friends: {count} company invitations waiting": "Venner: {count} virksomhedsinvitationer venter",
	Leaderboard: "Rangliste",
	"Show me on my friends' leaderboards": "Vis mig på mine venners ranglister",
	"The leaderboard isn't available yet.": "Ranglisten er ikke tilgængelig endnu.",
	"Loading leaderboard": "Indlæser rangliste",
	"Place {place}": "Plads {place}",
	"Better with friends": "Sjovere med venner",
	"Add friends": "Tilføj venner",
	"All sales so far, without VAT.": "Alt salg indtil nu, uden moms.",
	"Your friends see you and your companies.": "Dine venner ser dig og dine virksomheder.",
	"No companies yet.": "Ingen virksomheder endnu.",
	"Your friends don't see you now. You still see yourself here.":
		"Dine venner kan ikke se dig nu. Du ser stadig dig selv her.",
	"Add friends to see how you and your companies compare.":
		"Tilføj venner for at se, hvordan du og dine virksomheder klarer jer.",
	"Busiest friends": "Travleste venner",
	"This week": "Denne uge",
	"Busiest companies": "Travleste virksomheder",
	"Top-earning friends": "Venner med mest omsætning",
	"All time": "Altid",
	"Top-earning companies": "Virksomheder med mest omsætning",
	"1 task": "1 opgave",
	"{count} tasks": "{count} opgaver",
	Leaderboards: "Ranglister",
	"{amount} behind {name}": "{amount} efter {name}",
	"{count} to pass {name}": "{count} for at overhale {name}",
	"Up {count} since last week": "{count} op siden sidste uge",
	"Down {count} since last week": "{count} ned siden sidste uge",
	"Same place as last week": "Samme plads som sidste uge",
	"Week {week} ends tonight at midnight. Last chance to catch up.":
		"Uge {week} slutter i nat ved midnat. Sidste chance for at indhente.",
	"Week {week} ends Sunday at midnight. {days} days left to catch up.":
		"Uge {week} slutter søndag ved midnat. {days} dage tilbage til at indhente.",
	"Most revenue": "Mest omsætning",
	"Busiest this week": "Travlest denne uge",
	"Nobody is ahead yet": "Ingen fører endnu",
	"The first sale takes the lead.": "Det første salg tager føringen.",
	"The first task this week takes the lead.": "Ugens første opgave tager føringen.",
	"{amount} ahead of {name}": "{amount} foran {name}",
	"Most revenue so far": "Mest omsætning indtil nu",
	"Busiest this week, so far": "Travlest denne uge indtil nu",
	"{amount} each": "{amount} hver",
	"Sharing the lead": "Deler føringen",
	// Settings → Company → Brand (views/settings-brand.ts) and company logos (app/company-logos.ts)
	"The logo could not be removed. Try again.": "Logoet kunne ikke fjernes. Prøv igen.",
	"The logo could not be saved. Try again.": "Logoet kunne ikke gemmes. Prøv igen.",
	"Add a company logo": "Tilføj et logo",
	Brand: "Brand",
	"Change the company logo": "Skift logoet",
	"Choose a new logo": "Vælg et nyt logo",
	"Company logo": "Virksomhedens logo",
	"Remove logo": "Fjern logo",
	"The logo could not be removed.": "Logoet kunne ikke fjernes.",
	"The logo could not be saved.": "Logoet kunne ikke gemmes.",
};
