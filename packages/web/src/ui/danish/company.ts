/* Danish interface text, keyed by the English source exactly as the code
 * passes it to t() / uiText(). One file per area of the app; a key lives in
 * one file only (test/translations.test.ts checks). Wording follows
 * qorpera.com. */
/** Company File, organization and the company controller. */
export const COMPANY: Record<string, string> = {
	// Company File on folder-v2: the read-only file browser and its history (app/views/company-folder.ts)
	"A member": "Et medlem",
	"An earlier version, from {when}.": "En tidligere version fra {when}.",
	Changed: "Ændret",
	"Copied here": "Kopieret hertil",
	Created: "Oprettet",
	Deleted: "Slettet",
	Download: "Hent",
	"Downloading {name}.": "Henter {name}.",
	"Folder path": "Mappesti",
	"History of {name}": "Historik for {name}",
	History: "Historik",
	"Link to {target}": "Link til {target}",
	"Moved away": "Flyttet væk",
	"Moved here from {path}": "Flyttet hertil fra {path}",
	"Moved here": "Flyttet hertil",
	"Moved to {path}": "Flyttet til {path}",
	"No history to show.": "Der er ingen historik at vise.",
	"Nothing has changed yet.": "Der er ikke ændret noget endnu.",
	"Nothing in this folder matches “{query}”.": "Intet i denne mappe matcher “{query}”.",
	"Recent changes": "Seneste ændringer",
	"Search this folder": "Søg i denne mappe",
	"Show older": "Vis ældre",
	"Show the latest": "Vis den nyeste",
	"The Company File could not be read just now.": "Virksomhedsfilen kunne ikke læses lige nu.",
	"There's no preview for this file.": "Der er ingen forhåndsvisning af denne fil.",
	"This folder is empty.": "Mappen er tom.",
	View: "Vis",
	"and more": "og flere",
	"{name} is no longer in this folder.": "{name} er ikke længere i denne mappe.",
	"{size}: too large to download here.": "{size}: for stor til at hente her.",
	"View the version from {when}": "Vis versionen fra {when}",
	Files: "Filer",
	"More files": "Flere filer",

	// The live Company File (app/views/live-company-file.ts)
	"Retry opening Company File": "Prøv at åbne Virksomhedsfilen igen",

	// Organization (app/views/organization.ts)

	// The company controller's own messages (app/company.ts)
	"Only the person who wrote the message can try it again.": "Kun den, der skrev beskeden, kan prøve igen.",
	"Select an active model account, then try again.": "Vælg en aktiv modelkonto, og prøv igen.",
	"Answering cards here is not available yet. Reply in a message instead.":
		"Det er endnu ikke muligt at besvare kort her. Svar i en besked i stedet.",
	"This run was already handled.": "Denne kørsel er allerede håndteret.",
	"This run already did part of its work, so it cannot be repeated. Send the message again instead.":
		"Kørslen har allerede gjort en del af sit arbejde, så den kan ikke gentages. Send beskeden igen i stedet.",
	"It could not be tried again. Send the message again instead.":
		"Den kunne ikke prøves igen. Send beskeden igen i stedet.",
	"Sponsored message transport is unavailable.": "Afsendelse af beskeder er ikke tilgængelig.",
	"This group chat is no longer available.": "Denne gruppechat er ikke længere tilgængelig.",
	"This group chat has changed. Open its details again.": "Gruppechatten er ændret. Åbn dens detaljer igen.",
	"Trying again is not available yet. Send the message again instead.":
		"Det er endnu ikke muligt at prøve igen. Send beskeden igen i stedet.",
	"This company is no longer open.": "Denne virksomhed er ikke længere åben.",
	"The organization kernel (Order 0) is not deployed on this cloud yet, so there is no Co-Founder home here.":
		"Organisationskernen (Order 0) er ikke sat op i denne sky endnu, så her er intet Co-Founder-hjem.",
	"This company has no Co-Founder yet. The cloud seeds one when Order 0 bootstraps the company.":
		"Denne virksomhed har ingen Co-Founder endnu. Skyen opretter en, når Order 0 starter virksomheden op.",
	"This company is not readable.": "Denne virksomhed kan ikke læses.",
	"Agent threads are not deployed on this cloud yet.": "Agenttråde er ikke sat op i denne sky endnu.",
	"The transcript cursor did not advance.": "Samtalens markør rykkede ikke frem.",
	"The input cursor did not advance.": "Beskedkøens markør rykkede ikke frem.",
	"This conversation is not available for sending.": "Der kan ikke sendes i denne samtale.",
	"Wait for message submission before starting a new request.":
		"Vent, til beskeden er sendt, før du starter en ny anmodning.",
	"The team room conversation is unavailable.": "Teamrummets samtale er ikke tilgængelig.",
	"The earlier message may already have been accepted. Choose {action} before sending changed text or images.":
		"Den tidligere besked kan allerede være modtaget. Vælg {action}, før du sender ændret tekst eller billeder.",
	"The conversation destination changed. Refresh before starting a new request.":
		"Samtalens modtager er ændret. Opdater, før du starter en ny anmodning.",
	"Add a message to send with the images.": "Skriv en besked, der kan sendes med billederne.",
	"Could not check whether this group chat takes images. Try again.":
		"Det kunne ikke tjekkes, om denne gruppechat tager imod billeder. Prøv igen.",
	"Images are not supported in team rooms. Use Company File.":
		"Billeder understøttes ikke i teamrum. Brug Virksomhedsfilen.",
	"Select an active model account before sending.": "Vælg en aktiv modelkonto, før du sender.",
	"Agents are paused for a moment while Qorpera updates. Try again shortly.":
		"Agenterne holder en kort pause, mens Qorpera opdateres. Prøv igen om lidt.",
};
