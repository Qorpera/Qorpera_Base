/* The Bank page (supabase/CLIENT-CONTRACT.md "Pages", migration 20260930520000_interface_page_bank): the third page a
 * company may show. Its definition lives here, not in the cloud client's interface library: the folder never holds it
 * and no agent edits it, so the interface format the runtime reads stays as it is. The definition gives the page its
 * name, words and access for the Interfaces tab, and names the bank summary (app/bank-summary.ts) as a file source, so
 * the folder reader (app/interface-folder.ts) reads and follows it as it does any page's file. views/bank.ts draws the
 * page itself. The first block's own text keeps the page listed while the company has no summary yet. */

/** Where the company folder keeps the bank summary. */
export const BANK_SUMMARY_PATH = "bank/summary.json";

export const BANK_INTERFACE = `# The Bank page, shipped by the web client
format = "qorpera.interface/v0"

[interface]
id = "4f1c8a2e-7b3d-4e9a-a6c5-2d8f0b1e9c37"
name = "Bank"
about = "The company's bank account: the saldo, and what comes in and goes out."
emblem = "coin"
colour = "green"
status = "active"

[access]
members = "all"
agents = "all"
edit = "anyone"

[[view]]
name = "Overview"

[[view.block]]
id = "bank"
kind = "text"
text = "The company's bank account."

[[view.block]]
id = "summary"
kind = "text"
from = "file:bank/summary.json"
`;
