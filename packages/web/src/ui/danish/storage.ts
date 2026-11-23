export const STORAGE: Record<string, string> = {
	"{used} in total": "{used} i alt",
	Documents: "Dokumenter",
	Recents: "Seneste",
	Folder: "Mappe",
	Link: "Link",
	Markdown: "Markdown",
	"Text document": "Tekstdokument",
	"Date modified": "Ændret",
	Size: "Størrelse",
	"File type": "Filtype",
	"Sort files": "Sortér filer",
	"File view": "Filvisning",
	"All types": "Alle typer",
	Folders: "Mapper",
	Spreadsheets: "Regneark",
	Images: "Billeder",
	PDFs: "PDF-filer",
	Links: "Links",
	"Other files": "Andre filer",
	"Icon view": "Ikonvisning",
	"List view": "Listevisning",
	"No files of this type in this folder.": "Ingen filer af denne type i mappen.",
	"{shown} of {count} loaded items": "{shown} af {count} indlæste elementer",
	"1 item": "1 element",
	"{count} items": "{count} elementer",
	"{shown} of {count} items": "{shown} af {count} elementer",
	Yesterday: "I går",
	"No recent changes match your search.": "Ingen seneste ændringer matcher din søgning.",

	// HTML pages and folder links (app/views/company-folder.ts, ui/markdown.ts)
	Page: "Side",
	Source: "Kilde",
	"Show the page or its source": "Vis siden eller dens kilde",
	"Page: {name}": "Side: {name}",
	"Show {name} large": "Vis {name} stort",
	"This page can't be shown live, so its source is shown.": "Siden kan ikke vises direkte, så dens kilde vises.",
	"Open {path} in Files": "Åbn {path} i Filer",
	"{name} could not be found in the Company File.": "{name} findes ikke i Virksomhedsfilen.",

	// "Download the code" on a repository's folder (app/views/code-download.ts). The reader does not know git: no word
	// of it here, in either language.
	"Download the code": "Hent koden",
	"The files": "Filerne",
	"Everything as it is now, in one file": "Alt, som det er nu, i én fil",
	"With full history": "Med hele historikken",
	"For a developer": "Til en udvikler",
	"Getting the code ready…": "Gør koden klar…",
	"Downloading the code…": "Henter koden…",
	"{percent}%": "{percent}%",
	"The code is not ready yet. Try again in a little while.": "Koden er ikke klar endnu. Prøv igen om lidt.",
	"This code is too large to download here (over 200 MB). Write to Qorpera and we will send it.":
		"Koden er for stor til at hente her (over 200 MB). Skriv til Qorpera, så sender vi den.",
	"The agents are working on the code right now. Try again in a little while.":
		"Agenterne arbejder på koden lige nu. Prøv igen om lidt.",
	"The code has been downloaded many times today. Try again tomorrow.":
		"Koden er hentet mange gange i dag. Prøv igen i morgen.",
	"The code could not be made ready just now. Try again.": "Koden kunne ikke gøres klar lige nu. Prøv igen.",
	"The code could not be downloaded just now. Try again.": "Koden kunne ikke hentes lige nu. Prøv igen.",

	// "Bring code in", and the line under the top line of the code's folders (app/views/code-import.ts): what a folder
	// is, how an import stands, and why one was not brought in. No path, branch, commit or repository in either language.
	"Copy of the GitHub project {name}": "Kopi af GitHub-projektet {name}",
	"Bring code in": "Hent kode ind",
	"Bring it into Qorpera": "Hent det ind i Qorpera",
	"Where is the code?": "Hvor ligger koden?",
	"A GitHub address, like github.com/acme/shop": "En GitHub-adresse, fx github.com/acme/shop",
	"Qorpera copies it with its history. Nothing changes on GitHub.":
		"Qorpera kopierer den med hele dens historik. Intet ændres på GitHub.",
	"Bring it in": "Hent den ind",
	"That is not a GitHub address.": "Det er ikke en GitHub-adresse.",
	"Bring {name} into Qorpera?": "Hent {name} ind i Qorpera?",
	"What this folder holds now is kept aside, not deleted.": "Det, mappen rummer nu, lægges til side og slettes ikke.",
	"Bringing in {name}: Getting it from GitHub…": "Henter {name} ind: Henter den fra GitHub…",
	"Bringing in {name}: Reading the file…": "Henter {name} ind: Læser filen…",
	"Bringing in {name}: Checking it…": "Henter {name} ind: Tjekker den…",
	"Bringing in {name}: Waiting for the agents to finish what they are doing…":
		"Henter {name} ind: Venter på, at agenterne bliver færdige med det, de er i gang med…",
	"Bringing in {name}: Putting it in place…": "Henter {name} ind: Lægger den på plads…",
	"Brought in from GitHub on {date}.": "Hentet ind fra GitHub den {date}.",
	"Brought in from a file on {date}.": "Hentet ind fra en fil den {date}.",
	"1 earlier change came with it.": "1 tidligere ændring kom med.",
	"{count} earlier changes came with it.": "{count} tidligere ændringer kom med.",
	// Work that came along outside the main version (migration 20260930741000): "line of work" is "arbejdsspor", the main
	// version "hovedversionen"; never a branch, a commit or a merge.
	"It also brought 1 other line of work, with 1 change that was not in the main version.":
		"Den havde også 1 andet arbejdsspor med, med 1 ændring, som ikke var i hovedversionen.",
	"It also brought 1 other line of work, with {changes} changes that were not in the main version.":
		"Den havde også 1 andet arbejdsspor med, med {changes} ændringer, som ikke var i hovedversionen.",
	"It also brought {lines} other lines of work, with 1 change that was not in the main version.":
		"Den havde også {lines} andre arbejdsspor med, med 1 ændring, som ikke var i hovedversionen.",
	"It also brought {lines} other lines of work, with {changes} changes that were not in the main version.":
		"Den havde også {lines} andre arbejdsspor med, med {changes} ændringer, som ikke var i hovedversionen.",
	"An agent can bring that work into the main version.": "En agent kan føje det arbejde til hovedversionen.",
	"The copy on GitHub stays as it is.": "Kopien på GitHub forbliver, som den er.",
	"{name} is brought in.": "{name} er hentet ind.",
	"{name} was not brought in: {why}.": "{name} blev ikke hentet ind: {why}.",
	"it is larger than 1 GB, the most Qorpera brings in": "den er større end 1 GB, som er det meste, Qorpera henter ind",
	"it is larger than 256 MB, the most Qorpera brings in from a file":
		"den er større end 256 MB, som er det meste, Qorpera henter ind fra en fil",
	"GitHub did not let Qorpera read it; check the address, and that the company's GitHub connection can see it":
		"GitHub lod ikke Qorpera læse den; tjek adressen, og at virksomhedens GitHub-forbindelse kan se den",
	"GitHub says it has moved; use its new address": "GitHub siger, at den er flyttet; brug den nye adresse",
	"it keeps large files outside the code, and Qorpera can't bring those in yet":
		"den gemmer store filer uden for koden, og dem kan Qorpera ikke hente ind endnu",
	"it is made of other projects, and Qorpera can't bring those in yet":
		"den består af andre projekter, og dem kan Qorpera ikke hente ind endnu",
	"its history has damage Qorpera can't take in": "dens historik har skader, som Qorpera ikke kan tage ind",
	"its history is stored in an old way Qorpera can't take in yet":
		"dens historik er gemt på en gammel måde, som Qorpera ikke kan tage ind endnu",
	"it has more files, or names, than Qorpera can keep": "den har flere filer eller navne, end Qorpera kan gemme",
	"there is nothing in it yet": "der er ikke noget i den endnu",
	"it is stored in a new format Qorpera can't bring in yet":
		"den er gemt i et nyt format, som Qorpera ikke kan hente ind endnu",
	"it has a file larger than Qorpera can keep": "den har en fil, der er større, end Qorpera kan gemme",
	"Qorpera could not tell which version of it is the main one":
		"Qorpera kunne ikke se, hvilken version af den der er hovedversionen",
	"the file was not complete": "filen var ikke komplet",
	"an earlier bring-in stopped half way at this place; bring the same project in again to finish it":
		"en tidligere hentning stoppede halvvejs på denne plads; hent det samme projekt ind igen for at gøre den færdig",
	"a project with that name is already kept here": "et projekt med det navn ligger her allerede",
	"other code is being brought in right now; try again when it is done":
		"der hentes allerede anden kode ind; prøv igen, når det er færdigt",
	"agents are still working on it on GitHub; try again when they are done":
		"agenter arbejder stadig på den på GitHub; prøv igen, når de er færdige",
	"it could not be brought in just now; try again": "den kunne ikke hentes ind lige nu; prøv igen",
	"Checking whether {name} started…": "Tjekker, om {name} er gået i gang…",
	"{name} may not have started.": "{name} er måske ikke gået i gang.",
	"Qorpera could not be reached, so it is not known whether {name} started. Open this folder again in a moment.":
		"Qorpera kunne ikke nås, så det vides ikke, om {name} er gået i gang. Åbn mappen igen om lidt.",
};
