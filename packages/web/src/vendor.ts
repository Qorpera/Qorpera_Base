/* Third-party code that changes only with its package version. The build
 * adds this file as a second entry beside main.js; code splitting then puts
 * what both use into one shared chunk that main.js imports. That chunk's name
 * stays the same across deploys that change only app code, so browsers keep
 * it cached. No page loads this entry itself. List every symbol the app (and
 * @qorpera/cloud-client) imports from these packages: one left out lands in
 * main.js, and scripts/bundle.test.mjs says so. */
export { createClient, navigatorLock, processLock, REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
export { Lexer } from "marked";
