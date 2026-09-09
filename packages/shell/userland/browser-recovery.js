const element=id=>document.getElementById(id);
let catalog=null,selected=null,profiles=null,privacy=null,grant=null,busy=false;
async function request(input){const response=await window.browserRecovery.request(input);if(!response?.ok)throw new Error(response?.error||"Refresh browser cleanup.");return response.result;}
function buttons(){
	for(const id of ["refresh","office","profile","moreOffices","moreProfiles"])element(id).disabled=busy;
	element("moreOffices").hidden=!catalog?.nextAfter;element("moreProfiles").hidden=!profiles?.nextAfter;
	element("finish").disabled=busy||!privacy?.challenge||!["entering","private"].includes(privacy.state);
	element("revoke").disabled=busy||grant?.grant?.state!=="active";
}
async function work(action){if(busy)return;busy=true;buttons();try{await action();element("status").textContent="Your cleanup status is refreshed.";}catch(error){privacy=null;grant=null;element("status").textContent=error instanceof Error?error.message:"Refresh browser cleanup.";}finally{busy=false;buttons();}}
async function refresh(after=null){
	const previous=element("office").value;selected=null;profiles=null;privacy=null;grant=null;
	catalog=await request({method:"offices",after});element("office").replaceChildren();
	for(const office of catalog.offices){const option=document.createElement("option");option.value=office.scope.companyComputerId;option.textContent=`Computer ${office.scope.companyComputerId.slice(-12)}`;element("office").append(option);}
	if(catalog.offices.some(office=>office.scope.companyComputerId===previous))element("office").value=previous;
	await selectOffice();
}
async function selectOffice(){
	selected=null;profiles=null;privacy=null;grant=null;element("profile").replaceChildren();
	if(!element("office").value){element("company").textContent="No computers with your browser profiles on this page.";element("privacy").textContent="No private sign-in to finish.";element("consent").textContent="No profile selected.";return;}
	selected=await request({method:"selectOffice",companyComputerId:element("office").value});
	element("company").textContent=`Company ${selected.scope.companyId}`;
	await refreshSelected();
}
async function refreshSelected(after=null){
	privacy=null;grant=null;privacy=await request({method:"privacy"});
	element("privacy").textContent=!privacy||privacy.state==="shared"?"You have no active private sign-in here.":privacy.state==="leaving"?"Your exit is draining. Refresh to check when shared access resumes.":"Your private sign-in is keeping this computer private. You can explicitly finish it here.";
	const previous=element("profile").value;profiles=(await request({method:"profiles",after})).catalog;element("profile").replaceChildren();
	for(const profile of profiles.profiles){const option=document.createElement("option");option.value=profile.profileId;option.textContent=profile.label;element("profile").append(option);}
	if(profiles.profiles.some(profile=>profile.profileId===previous))element("profile").value=previous;
	await selectProfile();
}
async function selectProfile(){
	grant=null;const profile=profiles?.profiles.find(profile=>profile.profileId===element("profile").value);
	if(!profile?.activeStaffAgentId){element("consent").textContent="This profile has no active agent consent.";return;}
	grant=await request({method:"browserGrant",profileId:profile.profileId,staffAgentId:profile.activeStaffAgentId});
	element("consent").textContent=grant.grant?.state==="active"?`Consent is recorded for agent ${grant.staffAgentId}. You can revoke it here.`:"This agent no longer has active consent.";
}
element("refresh").onclick=()=>work(()=>refresh());element("office").onchange=()=>work(selectOffice);element("profile").onchange=()=>work(selectProfile);
element("moreOffices").onclick=()=>work(()=>refresh(catalog.nextAfter));element("moreProfiles").onclick=()=>work(()=>refreshSelected(profiles.nextAfter));
element("finish").onclick=()=>work(async()=>{privacy=null;await request({method:"finishPrivate"});await refreshSelected();});
element("revoke").onclick=()=>work(async()=>{const observed=grant;grant=null;await request({method:"configureBrowser",enabled:false,profileId:observed.profile.profileId,profileVersion:observed.profile.version,staffAgentId:observed.staffAgentId,expectedVersion:observed.grant.version});await refreshSelected();});
void work(()=>refresh());
