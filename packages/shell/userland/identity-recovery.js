"use strict";

const element = (id) => document.getElementById(id);
let busy = false;
let identityId = null;
let targetId = null;
let reviewed = null;
let identityAfter = null;
let targetAfter = null;

function status(text, error = false) {
  element("status").textContent = text;
  element("status").classList.toggle("error", error);
}

async function request(input) {
  const response = await window.identityRecovery.request(input);
  if (!response?.ok) throw new Error(response?.error || "Cloud recovery is unavailable");
  return response.cancelled ? null : response.result;
}

function buttons() {
  for (const button of document.querySelectorAll("button")) button.disabled = busy;
  for (const radio of document.querySelectorAll('input[name="source"]')) radio.disabled = busy;
  const body = reviewed?.review;
  element("approve").disabled = busy || !body?.canRequest || !document.querySelector('input[name="source"]:checked');
  element("consent").disabled = busy || !body?.canConsent;
  element("cancel").disabled = busy || !body?.canCancel;
}

async function work(action) {
  if (busy) return;
  busy = true;
  buttons();
  try { await action(); }
  catch (error) { status(error instanceof Error ? error.message : "Cloud recovery is unavailable", true); }
  finally { busy = false; buttons(); }
}

function row(parent, title, value) {
  const label = document.createElement("dt");
  const detail = document.createElement("dd");
  label.textContent = title;
  detail.textContent = String(value ?? "None");
  parent.append(label, detail);
}

function clearReview() {
  reviewed = null;
  element("review").hidden = true;
  element("empty").hidden = false;
  for (const radio of document.querySelectorAll('input[name="source"]')) radio.checked = false;
}

function entry(title, subtitle, selected, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "entry";
  button.setAttribute("aria-pressed", String(selected));
  button.textContent = title;
  const small = document.createElement("small");
  small.textContent = subtitle;
  button.append(small);
  button.onclick = () => work(async () => {
    for (const sibling of button.parentElement.children) sibling.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-pressed", "true");
    await action();
  });
  return button;
}

function identityLabel(item, viewerUserId) {
  const kind = item.ownershipKind === "member" ? (item.ownerUserId === viewerUserId ? "Your identity" : "Member identity") : "Company identity";
  return `${kind} · ${item.blocked ? "Fenced" : item.status}`;
}

async function identities(append = false) {
  const page = await request({ method: "identities", after: append ? identityAfter : null });
  identityAfter = page.nextAfter;
  if (!append) element("identities").replaceChildren();
  for (const item of page.items) {
    element("identities").append(entry(item.displayName, identityLabel(item, page.viewerUserId), identityId === item.computeIdentityId, async () => {
      identityId = item.computeIdentityId;
      targetId = null;
      clearReview();
      await targets();
    }));
  }
  if (!element("identities").children.length) element("identities").textContent = "No cloud identities are available for your membership.";
  element("moreIdentities").hidden = identityAfter === null;
}

async function targets(append = false) {
  const page = await request({ method: "targets", computeIdentityId: identityId, after: append ? targetAfter : null });
  targetAfter = page.nextAfter;
  if (!append) element("targets").replaceChildren();
  for (const item of page.items) element("targets").append(entry(`Node ${item.nodeId.slice(0, 8)}`, `${item.status} · expires ${new Date(item.expiresAt).toLocaleString()}`, targetId === item.targetId, async () => {
    targetId = item.targetId;
    await review();
  }));
  if (!element("targets").children.length) element("targets").textContent = "No replacement is registered. An operator must verify and register the replacement first.";
  element("moreTargets").hidden = targetAfter === null;
  status("Select a registered replacement to inspect its exact identity and backup.");
}

async function review() {
  clearReview();
  const result = await request({ method: "review", computeIdentityId: identityId, targetId });
  reviewed = result;
  const body = result.review;
  const selectedIdentity = element("identities").querySelector('.entry[aria-pressed="true"] small');
  if (selectedIdentity) selectedIdentity.textContent = identityLabel(body.identity, body.viewerUserId);
  element("empty").hidden = true;
  element("review").hidden = false;
  element("identityName").textContent = body.identity.displayName;
  const states = { awaiting_member: "Waiting for the credential owner’s consent", approved: "Approved; waiting for the replacement", released: "Key released; waiting for the recovery receipt", completed: "Recovery receipt recorded", cancelled: "Restore cancelled; prior fencing is retained" };
  element("state").textContent = body.recovery ? states[body.recovery.status] : "No restore has been approved for this replacement.";
  element("details").replaceChildren();
  row(element("details"), "Identity", body.identity.computeIdentityId);
  row(element("details"), "Ownership", body.identity.ownershipKind.replaceAll("_", " "));
  row(element("details"), "Replacement node", body.target.nodeId);
  row(element("details"), "Generation", body.identity.epoch);
  row(element("details"), "Backup revision", body.backup?.revision ?? "No verified backup");
  row(element("details"), "Target expires", new Date(body.target.expiresAt).toLocaleString());
  if (body.recovery) {
    row(element("details"), "Selected source", body.recovery.storageSource === "nas" ? "NAS" : "Supabase backup");
    if (body.recovery.notBefore) row(element("details"), "Release no earlier than", new Date(body.recovery.notBefore).toLocaleString());
    if (body.recovery.receiptId) row(element("details"), "Receipt", body.recovery.receiptId);
  }
  element("fingerprints").replaceChildren();
  row(element("fingerprints"), "Target", body.target.targetId);
  row(element("fingerprints"), "Recipient key", body.target.recipientKeySha256);
  row(element("fingerprints"), "Signed image", body.target.imageSha256);
  row(element("fingerprints"), "Guest manifest", body.target.guestManifestSha256);
  row(element("fingerprints"), "Backup object", body.backup?.objectSha256);
  row(element("fingerprints"), "Review", result.reviewSha256);
  element("source").hidden = !body.canRequest;
  element("approve").hidden = !body.canRequest;
  element("consent").hidden = !body.canConsent;
  element("cancel").hidden = !body.canCancel;
  element("unavailable").textContent = body.canRequest || body.canConsent || body.canCancel ? "The cloud rechecks this exact review and current permissions before accepting a decision." : "No decision is currently available. The backup, target, membership or existing recovery may need attention. Refresh to check current state.";
  status("Review the replacement and backup. No key is released by opening this screen.");
}

async function decide(decision) {
  if (!reviewed) throw new Error("Refresh and inspect this recovery first");
  const previous = reviewed;
  let completed = false;
  try {
    const result = await request({ method: "decision", reviewSha256: previous.reviewSha256, decision,
      storageSource: decision === "request" ? document.querySelector('input[name="source"]:checked')?.value : null });
    if (result === null) { status("No decision submitted."); return; }
    completed = true;
    await review();
    status(decision === "cancel" ? "Restore cancelled. The old node remains fenced." : result.status === "awaiting_member" ? "Requested. The credential owner must separately consent." : "Approved. The cloud replacement must complete the restore; this is not a completion receipt.");
  } catch (error) {
    clearReview();
    if (completed) status("Decision recorded, but status could not be refreshed. Choose Refresh status.", true);
    else throw error;
  }
}

element("refresh").onclick = () => work(async () => {
  if (identityId && targetId) await review();
  else { await identities(); if (identityId) await targets(); }
});
element("moreIdentities").onclick = () => work(() => identities(true));
element("moreTargets").onclick = () => work(() => targets(true));
element("approve").onclick = () => work(() => decide("request"));
element("consent").onclick = () => work(() => decide("consent"));
element("cancel").onclick = () => work(() => decide("cancel"));
for (const radio of document.querySelectorAll('input[name="source"]')) radio.onchange = buttons;
void work(async () => {
  const info = await request({ method: "info" });
  element("title").textContent = `${info.title} · Cloud recovery`;
  await identities();
  status("Select a cloud identity. Recovery never grants new provider permissions.");
});
