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

	// member-web/src/file-panel.ts (the live Company File panel, shared with member-web)
	"Company path": "Sti i Virksomhedsfilen",
	"Company root": "Virksomhedens rodmappe",
	"More files": "Flere filer",
	"File content": "Filens indhold",
	"Recent agent activity · {path}: unavailable.": "Seneste agentaktivitet · {path}: ikke tilgængelig.",
	"Agent {agent} reading within this folder": "Agent {agent} læser i denne mappe",
	"Agent {agent} writing within this folder": "Agent {agent} skriver i denne mappe",
	"Agent {agent} reading on a containing folder": "Agent {agent} læser i en overordnet mappe",
	"Agent {agent} writing on a containing folder": "Agent {agent} skriver i en overordnet mappe",
	"Agent {agent} reading here": "Agent {agent} læser her",
	"Agent {agent} writing here": "Agent {agent} skriver her",
	"{count} more observations": "{count} observationer mere",
	"Recent agent activity · {path}: No recent shared activity observed. Some activity could not be checked.":
		"Seneste agentaktivitet · {path}: Ingen nylig delt aktivitet set. Noget af aktiviteten kunne ikke tjekkes.",
	"Recent agent activity · {path}: No recent shared activity observed.":
		"Seneste agentaktivitet · {path}: Ingen nylig delt aktivitet set.",
	"Recent agent activity · {path}: {summary} Some activity could not be checked.":
		"Seneste agentaktivitet · {path}: {summary} Noget af aktiviteten kunne ikke tjekkes.",
	"Recent agent activity · {path}: {summary}": "Seneste agentaktivitet · {path}: {summary}",
	"The last change is unconfirmed. Retry that exact change before starting another.":
		"Den sidste ændring er ikke bekræftet. Prøv præcis den ændring igen, før du starter en ny.",
	"Discard this unsaved text?": "Vil du kassere denne ugemte tekst?",
	"The last change is unconfirmed. Leave this page? Reopen pending changes to check whether it was accepted.":
		"Den sidste ændring er ikke bekræftet. Vil du forlade siden? Åbn ventende ændringer igen for at se, om den blev accepteret.",
	"Discard this selected upload?": "Vil du kassere den valgte upload?",
	"Save to company": "Gem i virksomheden",
	"Delete…": "Slet…",
	"Delete {path}?": "Vil du slette {path}?",
	"Retry this exact save": "Gem præcis det samme igen",
	Folder: "Mappe",
	"{count} bytes": "{count} bytes",
	"Download…": "Hent…",
	"Download handed to your browser.": "Filen er sendt videre til din browser.",
	"New file — not yet saved": "Ny fil — ikke gemt endnu",
	"Loaded the current company version.": "Virksomhedens aktuelle version er hentet.",
	"Open the exact path first": "Åbn den præcise sti først",
	"Retry the exact pending save": "Gem den ventende ændring igen først",
	"Enter UTF-8 text of at most 32 KiB without NUL characters": "Skriv UTF-8-tekst på højst 32 KiB uden NUL-tegn",
	"Saved to the live company.": "Gemt direkte i virksomheden.",
	"The change is approved.": "Ændringen er godkendt.",
	"The change is rejected.": "Ændringen er afvist.",
	"The change is ready.": "Ændringen er klar.",
	"Your edit · {path}": "Din ændring · {path}",
	"Agent proposal · {path}": "Agentforslag · {path}",
	"Current content could not be displayed. Check the path before applying this change.":
		"Det aktuelle indhold kunne ikke vises. Tjek stien, før du anvender ændringen.",
	"Path does not currently exist.": "Stien findes ikke lige nu.",
	"Current path is a folder.": "Stien er en mappe lige nu.",
	"This path will be deleted.": "Denne sti bliver slettet.",
	"A folder will be created.": "Der bliver oprettet en mappe.",
	"Apply exact change…": "Anvend den præcise ændring…",
	"Apply the exact proposed change to {path}?": "Vil du anvende præcis den foreslåede ændring på {path}?",
	"Applied the exact approved change.": "Præcis den godkendte ændring er anvendt.",
	"Approval recorded. Refresh to check the result.": "Godkendelsen er registreret. Opdater for at se resultatet.",
	"Skip change": "Spring ændringen over",
	"Change skipped.": "Ændringen er sprunget over.",
	"Review exact change": "Gennemgå den præcise ændring",
	Current: "Nuværende",
	Proposed: "Foreslået",
	"Download proposed file…": "Hent den foreslåede fil…",
	"Proposed file handed to your browser. Review it before applying.":
		"Den foreslåede fil er sendt videre til din browser. Gennemgå den, før du anvender den.",
	"More pending changes": "Flere ventende ændringer",
	"More exports": "Flere eksporter",
	"{path} · {count} bytes · Download…": "{path} · {count} bytes · Hent…",
	"Shared export handed to your browser.": "Den delte eksport er sendt videre til din browser.",
	"Select a file to upload": "Vælg en fil til upload",
	"Choose a file of at most 8 MiB.": "Vælg en fil på højst 8 MiB.",
	"Upload destination": "Placering for upload",
	"Upload to company": "Upload til virksomheden",
	"Check the destination first": "Tjek placeringen først",
	"Upload submitted to the live company.": "Upload sendt direkte til virksomheden.",
	"Retry this exact upload": "Upload præcis det samme igen",
	"Reading selected file…": "Læser den valgte fil…",
	"No file selected.": "Ingen fil valgt.",
	"{name} · {count} bytes": "{name} · {count} bytes",
	"Check the destination before uploading.": "Tjek placeringen, før du uploader.",
	"Check destination": "Tjek placering",
	"Retry the exact pending upload": "Prøv den ventende upload igen først",
	"Choose a file first": "Vælg en fil først",
	"Choose a non-executable file destination": "Vælg en placering til en fil, der ikke kan køres",
	"Replace {path} at the checked version.": "Erstat {path} i den tjekkede version.",
	"Create {path}.": "Opret {path}.",
	Open: "Åbn",
	"New file": "Ny fil",
	"Enter the path and choose Open to check it before editing.":
		"Skriv stien, og vælg Åbn for at tjekke den, før du redigerer.",
	"Create folder…": "Opret mappe…",
	"That path already exists": "Den sti findes allerede",
	Up: "Op",
	"Pending changes": "Ventende ændringer",
	"Refresh changes": "Opdater ændringer",
	"Shared exports": "Delte eksporter",
	"Browse exports": "Gennemse eksporter",
	"UTF-8 text · up to 32 KiB": "UTF-8-tekst · op til 32 KiB",
	"Writes use the checked version and current company permissions. Protected changes require review.":
		"Ændringer bruger den tjekkede version og virksomhedens aktuelle tilladelser. Beskyttede ændringer skal gennemgås.",
	"Upload a file": "Upload en fil",
	"Binary or large file. Download and inspect the proposed file before approving.":
		"Binær eller stor fil. Hent og tjek den foreslåede fil, før du godkender.",
	"Agents are paused for a moment while Qorpera updates. Try again shortly.":
		"Agenterne holder en kort pause, mens Qorpera opdateres. Prøv igen om lidt.",
};
