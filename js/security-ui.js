/** @file security-ui.js — UI layer for the Security module (checkpoints, guards, round schedules) @depends common.js, security-logic.js */

// ═══ GUARD / DEPENDENCY CHECK ═════════════════════════════════════════════
if(typeof _COMMON_LOADED==='undefined'){
  document.body.style.display='';
  document.body.innerHTML='<div style="padding:40px;text-align:center;font-family:sans-serif"><h2 style="color:#dc2626">⚠ Failed to load js/common.js</h2></div>';
  throw new Error('Common.js not loaded');
}

// ═══ NAVIGATION ══════════════════════════════════════════════════════════
// Security page → permission key (in _PERM_KEYS.Security).
var _SEC_PAGE_PERM_KEY={
  pageCheckpoints:'masters.checkpoints',
  pageGuards:'masters.guards',
  pageRoundSchedules:'page.rounds'
};
function _secNavVisible(pageId){
  if(typeof CU==='undefined'||!CU) return false;
  if(CU.roles&&CU.roles.includes('Super Admin')) return true;
  var pk=_SEC_PAGE_PERM_KEY[pageId];
  if(pk&&typeof permConfigured==='function'&&permConfigured('Security')
     &&typeof permCanView==='function'){
    return permCanView('Security',pk);
  }
  return true; // Legacy: no granular gate yet — show everything.
}
function _secApplyNavPermissions(){
  // Hide nav items the user can't view.
  var map={pageCheckpoints:'nCheckpoints',pageGuards:'nGuards',pageRoundSchedules:'nRoundSchedules'};
  Object.keys(map).forEach(function(pid){
    var el=document.getElementById(map[pid]);
    if(el) el.style.display=_secNavVisible(pid)?'':'none';
  });
}
function secGo(pageId){
  // Permission guard — block direct navigation when the user lacks view
  // permission for this page. Runs once perms are in DB.hrmsSettings.
  if(!_secNavVisible(pageId)){
    if(typeof notify==='function') notify('⚠ You do not have access to this page.',true);
    return;
  }
  // Refresh nav visibility each time in case perms changed via realtime sync.
  try{_secApplyNavPermissions();}catch(e){}
  document.querySelectorAll('#secApp .page').forEach(function(p){p.classList.remove('active');p.style.display='none';});
  var pg=document.getElementById(pageId);
  if(pg){pg.classList.add('active');pg.style.display='block';}
  var ptEl=pg&&pg.querySelector('.page-title');
  var tbt=document.getElementById('secPageTitle');
  if(tbt&&ptEl) tbt.textContent=ptEl.textContent;
  document.querySelectorAll('.sec-nav-item').forEach(function(n){n.classList.remove('active');});
  var navMap={pageCheckpoints:'nCheckpoints',pageGuards:'nGuards',pageRoundSchedules:'nRoundSchedules'};
  var ni=document.getElementById(navMap[pageId]);if(ni)ni.classList.add('active');
  closeSecNav();
  var renderMap={
    pageCheckpoints: function(){ if(typeof renderCheckpoints==='function') renderCheckpoints(); },
    pageGuards: function(){ if(typeof renderGuards==='function') renderGuards(); },
    pageRoundSchedules: function(){ if(typeof renderRoundSchedules==='function') renderRoundSchedules(); }
  };
  if(renderMap[pageId]) renderMap[pageId]();
}
function toggleSecNav(){ document.getElementById('secSidebar').classList.toggle('open'); document.getElementById('secOverlay').classList.toggle('show'); }
function closeSecNav(){ document.getElementById('secSidebar').classList.remove('open'); document.getElementById('secOverlay').classList.remove('show'); }
function secLogout(){
  CU=null; _sessionDel('kap_session_user'); _sessionDel('kap_session_token');
  try{localStorage.removeItem('kap_rm_user');localStorage.removeItem('kap_rm_token');}catch(e){}
  _navigateTo('index.html');
}

// ═══ STUBS (portal compatibility) ════════════════════════════════════════
function showPage(pid){ secGo(pid); }
function renderDash(){}
function renderMyTrips(){}
function updBadges(){}

// ═══ MASTERS — CHECKPOINTS / GUARDS / ROUND SCHEDULES ═══════════════════
// ===== SECURITY CHECKPOINT MASTER =====
// _kapLocations() and _cpForLoc() are in security-logic.js
function _populateCPLocFilter(){
  const sel=document.getElementById('cpLocFilter');
  if(!sel) return;
  const cur=sel.value;
  sel.innerHTML='<option value="">All KAP Locations</option>'+_kapLocations().sort((a,b)=>a.name.localeCompare(b.name)).map(l=>`<option value="${l.id}">${l.name}</option>`).join('');
  sel.value=cur;
}
function renderCheckpoints(){
  _populateCPLocFilter();
  const locFilter=document.getElementById('cpLocFilter')?.value||'';
  const locs=locFilter?_kapLocations().filter(l=>l.id===locFilter):_kapLocations();
  const cont=document.getElementById('cpContent');
  if(!cont)return;
  if(!locs.length){ cont.innerHTML='<div class="empty-state">No KAP locations found. Add KAP locations in the Location Master first.</div>'; return; }
  const allCPs=DB.checkpoints||[];
  cont.innerHTML=locs.sort((a,b)=>a.name.localeCompare(b.name)).map(loc=>{
    const cps=_cpForLoc(loc.id);
    const maxCP=25;
    const bg=loc.colour||'var(--surface2)';
    return `<div class="card" style="padding:16px;margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:6px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="background:${bg};color:${colourContrast(bg)};padding:3px 10px;border-radius:6px;font-weight:800;font-size:13px">${loc.name}</span>
          <span style="font-size:11px;color:var(--text3)">${cps.length} / ${maxCP} checkpoints</span>
        </div>
        ${cps.length<maxCP?`<button class="btn btn-primary" style="font-size:11px;padding:5px 12px" onclick="openCPModal(null,'${loc.id}')">+ Add</button>`:'<span style="font-size:11px;color:var(--red);font-weight:600">Max 25 reached</span>'}
      </div>
      ${cps.length?`<div style="display:flex;flex-direction:column;gap:4px">${cps.map((cp,i)=>{
        const activeStyle=cp.active!==false?'':'opacity:.5;';
        const activeBadge=cp.active!==false?'<span style="font-size:9px;font-weight:700;background:rgba(34,197,94,.15);color:#16a34a;padding:1px 6px;border-radius:4px">Active</span>':'<span style="font-size:9px;font-weight:700;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px">Inactive</span>';
        return `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;${activeStyle}">
          <span style="width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0">${cp.sortOrder||i+1}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700">${cp.name} ${activeBadge}</div>
            ${cp.description?`<div style="font-size:11px;color:var(--text2);margin-top:1px">${cp.description}</div>`:''}
          </div>
          <button class="action-btn" onclick="openCPModal('${cp.id}')">✏️</button>
          <button class="action-btn" onclick="del('checkpoints','${cp.id}',renderCheckpoints)">🗑️</button>
        </div>`;
      }).join('')}</div>`:'<div class="empty-state" style="padding:12px;font-size:12px">No checkpoints yet. Click + Add to create one.</div>'}
    </div>`;
  }).join('');
  // Update sidebar count
  const cEl=document.getElementById('cCheckpoints');
  if(cEl) cEl.textContent=allCPs.filter(c=>c.active!==false).length;
}
function openCPModal(id,preLocId){
  const cp=id?byId(DB.checkpoints||[],id):null;
  document.getElementById('eCPid').value=id||'';
  document.getElementById('mCPTitle').textContent=id?'Edit Checkpoint':'Add Checkpoint';
  // Populate loc dropdown
  const locS=document.getElementById('cpLocS');
  locS.innerHTML='<option value="">-- Select Location --</option>'+_kapLocations().sort((a,b)=>a.name.localeCompare(b.name)).map(l=>`<option value="${l.id}">${l.name}</option>`).join('');
  locS.value=cp?.locationId||preLocId||'';
  document.getElementById('cpNameI').value=cp?.name||'';
  document.getElementById('cpDescI').value=cp?.description||'';
  document.getElementById('cpSortI').value=cp?.sortOrder||(_cpForLoc(locS.value).length+1);
  document.getElementById('cpActiveI').checked=cp?cp.active!==false:true;
  om('mCheckpoint');
}
async function saveCP(){
  if(typeof permCanAct==='function'&&typeof permConfigured==='function'
     &&permConfigured('Security')&&!permCanAct('Security','masters.edit')){
    notify('⚠ You do not have permission to edit masters.',true);return;
  }
  const id=document.getElementById('eCPid').value;
  const locId=document.getElementById('cpLocS').value;
  const name=document.getElementById('cpNameI').value.trim();
  const desc=document.getElementById('cpDescI').value.trim();
  const sort=parseInt(document.getElementById('cpSortI').value)||1;
  const active=document.getElementById('cpActiveI').checked;
  if(!locId||!name){modalErr('mCheckpoint','Location and Name are required');return;}
  // Check max 25 per location (only for new)
  if(!id&&_cpForLoc(locId).length>=25){modalErr('mCheckpoint','Maximum 25 checkpoints per location');return;}
  // Check duplicate name within same location
  if((DB.checkpoints||[]).find(c=>c.locationId===locId&&c.name.toLowerCase()===name.toLowerCase()&&c.id!==id)){modalErr('mCheckpoint','Checkpoint name already exists at this location');return;}
  if(!DB.checkpoints) DB.checkpoints=[];
  if(id){
    const cp=byId(DB.checkpoints,id);const bak={...cp};
    Object.assign(cp,{locationId:locId,name,description:desc,sortOrder:sort,active});
    if(!await _dbSave('checkpoints',cp)){Object.assign(cp,bak);return;}
  } else {
    const cp={id:'cp'+uid(),locationId:locId,name,description:desc,sortOrder:sort,active};
    if(!await _dbSave('checkpoints',cp)) return;
  }
  cm('mCheckpoint');renderCheckpoints();notify('Checkpoint saved!');
}

// ===== SECURITY GUARD MASTER =====
function _populateGuardLocDropdown(selId,curVal){
  const sel=document.getElementById(selId);
  if(!sel)return;
  sel.innerHTML='<option value="">-- Select Location --</option>'+_kapLocations().sort((a,b)=>a.name.localeCompare(b.name)).map(l=>`<option value="${l.id}">${l.name}</option>`).join('');
  if(curVal) sel.value=curVal;
}
function renderGuards(){
  const hideInactive=document.getElementById('showInactiveGuard')?.checked;
  const guards=(DB.guards||[]).filter(g=>!hideInactive||!g.inactive).sort((a,b)=>a.name.localeCompare(b.name));
  document.getElementById('guardBody').innerHTML=guards.map(g=>{
    const inactive=g.inactive===true;
    const loc=byId(DB.locations,g.locationId);
    const locBg=loc?.colour||'var(--surface2)';
    const photoHtml=g.photo?`<img src="${g.photo}" onclick="openPhoto(this.src)" style="width:32px;height:32px;object-fit:cover;border-radius:50%;border:2px solid var(--border2);cursor:pointer${inactive?';filter:grayscale(1);opacity:.6':''}">`:'<span style="width:32px;height:32px;border-radius:50%;background:var(--surface2);display:inline-flex;align-items:center;justify-content:center;font-size:14px;color:var(--text3)">💂</span>';
    const inactiveBadge=inactive?'<span style="font-size:9px;font-weight:700;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;margin-left:4px;border:1px solid #fca5a5">Inactive</span>':'';
    const trStyle=inactive?'style="opacity:.6;background:rgba(239,68,68,.03)"':'';
    return `<tr ${trStyle}>
      <td onclick="event.stopPropagation()">${photoHtml}</td>
      <td style="font-weight:600">${g.name}${inactiveBadge}</td>
      <td>${g.mobile||'-'}</td>
      <td>${loc?`<span style="background:${locBg};color:${colourContrast(locBg)};padding:1px 6px;border-radius:4px;font-weight:600;font-size:11px">${loc.name}</span>`:'-'}</td>
      <td>${g.shift||'-'}</td>
      <td style="white-space:nowrap" onclick="event.stopPropagation()"><button class="action-btn" onclick="openGuardModal('${g.id}')">✏️</button><button class="action-btn" onclick="del('guards','${g.id}',renderGuards)">🗑️</button></td>
    </tr>`;
  }).join('');
  const cEl=document.getElementById('cGuards');
  if(cEl) cEl.textContent=(DB.guards||[]).filter(g=>!g.inactive).length;
}
function _guardOnPhoto(inp){
  if(!inp.files[0])return;
  var file=inp.files[0];
  const reader=new FileReader();
  reader.onload=e=>{
    const thumb=document.getElementById('guardPhotoThumb');
    const clear=document.getElementById('guardPhotoClear');
    thumb.innerHTML=`<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;border-radius:6px">`;
    thumb.style.border='2px solid var(--green)';
    if(clear)clear.style.display='inline';
    inp._data=e.target.result;
    // Compress image in background
    compressImage(file,100).then(c=>{if(c)inp._data=c;}).catch(()=>{});
  };
  reader.readAsDataURL(file);
}
function _guardClearPhoto(){
  const thumb=document.getElementById('guardPhotoThumb');
  const clear=document.getElementById('guardPhotoClear');
  const inp=document.getElementById('guardPhotoFile');
  thumb.innerHTML='🧑';thumb.style.border='2px dashed var(--border2)';
  if(clear)clear.style.display='none';
  if(inp){inp.value='';inp._data='__clear__';}
}
function openGuardModal(id){
  const g=id?byId(DB.guards||[],id):null;
  document.getElementById('eGuardId').value=id||'';
  document.getElementById('mGuardTitle').textContent=id?'Edit Guard':'Add Guard';
  document.getElementById('guardNameI').value=g?.name||'';
  document.getElementById('guardMobI').value=g?.mobile||'';
  document.getElementById('guardEmailI').value=g?.email||'';
  document.getElementById('guardShiftS').value=g?.shift||'';
  _populateGuardLocDropdown('guardLocS',g?.locationId||'');
  document.getElementById('guardInactive').checked=g?.inactive===true;
  // Photo
  const thumb=document.getElementById('guardPhotoThumb');
  const clear=document.getElementById('guardPhotoClear');
  const inp=document.getElementById('guardPhotoFile');
  if(inp){inp.value='';inp._data=null;}
  if(g?.photo){
    thumb.innerHTML=`<img src="${g.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:6px">`;thumb.style.border='2px solid var(--green)';
    if(clear)clear.style.display='inline';
  } else {
    thumb.innerHTML='🧑';thumb.style.border='2px dashed var(--border2)';
    if(clear)clear.style.display='none';
  }
  om('mGuard');
}
async function saveGuard(){
  if(typeof permCanAct==='function'&&typeof permConfigured==='function'
     &&permConfigured('Security')&&!permCanAct('Security','masters.edit')){
    notify('⚠ You do not have permission to edit masters.',true);return;
  }
  const id=document.getElementById('eGuardId').value;
  const name=document.getElementById('guardNameI').value.trim();
  const mobile=document.getElementById('guardMobI').value.trim();
  const email=document.getElementById('guardEmailI').value.trim();
  const locId=document.getElementById('guardLocS').value;
  const shift=document.getElementById('guardShiftS').value;
  const inactive=document.getElementById('guardInactive').checked;
  if(!name||!mobile||!locId){modalErr('mGuard','Name, Mobile & Location are required');return;}
  if(mobile.length!==10||!/^\d+$/.test(mobile)){modalErr('mGuard','Mobile must be 10 digits');return;}
  // Photo
  const inp=document.getElementById('guardPhotoFile');
  let photo=id?byId(DB.guards||[],id)?.photo||'':'';
  if(inp?._data==='__clear__') photo='';
  else if(inp?._data) photo=inp._data;
  if(!DB.guards) DB.guards=[];
  if(id){
    const g=byId(DB.guards,id);const bak={...g};
    Object.assign(g,{name,mobile,email,locationId:locId,shift,photo,inactive});
    if(!await _dbSave('guards',g)){Object.assign(g,bak);return;}
  } else {
    const g={id:'gd'+uid(),name,mobile,email,locationId:locId,shift,photo,inactive};
    if(!await _dbSave('guards',g)) return;
  }
  cm('mGuard');renderGuards();notify('Guard saved!');
}

// ===== SECURITY ROUND SCHEDULE MASTER =====
function _populateRSLocFilter(){
  const sel=document.getElementById('rsLocFilter');
  if(!sel) return;
  const cur=sel.value;
  sel.innerHTML='<option value="">All Locations</option>'+_kapLocations().sort((a,b)=>a.name.localeCompare(b.name)).map(l=>`<option value="${l.id}">${l.name}</option>`).join('');
  sel.value=cur;
}
function renderRoundSchedules(){
  _populateRSLocFilter();
  const locFilter=document.getElementById('rsLocFilter')?.value||'';
  const hideInactive=document.getElementById('showInactiveRS')?.checked;
  const schedules=(DB.roundSchedules||[]).filter(rs=>{
    if(hideInactive&&rs.inactive) return false;
    if(locFilter&&rs.locationId!==locFilter) return false;
    return true;
  }).sort((a,b)=>a.name.localeCompare(b.name));
  document.getElementById('rsBody').innerHTML=schedules.length?schedules.map(rs=>{
    const loc=byId(DB.locations,rs.locationId);
    const guard=byId(DB.guards||[],rs.guardId);
    const cps=(rs.checkpointIds||[]).map(cpId=>byId(DB.checkpoints||[],cpId)).filter(Boolean);
    const inactive=rs.inactive===true;
    const inactiveBadge=inactive?'<span style="font-size:9px;font-weight:700;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;margin-left:4px;border:1px solid #fca5a5">Inactive</span>':'';
    const locBg=loc?.colour||'var(--surface2)';
    return `<tr ${inactive?'style="opacity:.6;background:rgba(239,68,68,.03)"':''}>
      <td style="font-weight:600">${rs.name}${inactiveBadge}</td>
      <td>${loc?`<span style="background:${locBg};color:${colourContrast(locBg)};padding:1px 6px;border-radius:4px;font-weight:600;font-size:11px">${loc.name}</span>`:'-'}</td>
      <td>${guard?guard.name:'-'}</td>
      <td>${cps.length?cps.map(cp=>`<span style="display:inline-block;background:rgba(42,154,160,.1);color:var(--accent);font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;margin:1px 2px">${cp.name}</span>`).join(''):'<span style="color:var(--text3);font-size:11px">None</span>'}</td>
      <td><span class="badge badge-amber">${rs.frequency}</span></td>
      <td style="white-space:nowrap;font-family:var(--mono);font-size:12px">${rs.startTime||'—'} – ${rs.endTime||'—'}</td>
      <td style="white-space:nowrap"><button class="action-btn" onclick="openRSModal('${rs.id}')">✏️</button><button class="action-btn" onclick="del('roundSchedules','${rs.id}',renderRoundSchedules)">🗑️</button></td>
    </tr>`;
  }).join(''):'<tr><td colspan="7" class="empty-state">No round schedules yet.</td></tr>';
  const cEl=document.getElementById('cRoundSched');
  if(cEl) cEl.textContent=(DB.roundSchedules||[]).filter(rs=>!rs.inactive).length;
}
function onRSLocChange(){
  const locId=document.getElementById('rsLocS').value;
  // Populate guard dropdown filtered by location
  const gSel=document.getElementById('rsGuardS');
  const guards=(DB.guards||[]).filter(g=>g.locationId===locId&&!g.inactive);
  gSel.innerHTML='<option value="">-- Unassigned --</option>'+guards.sort((a,b)=>a.name.localeCompare(b.name)).map(g=>`<option value="${g.id}">${g.name}</option>`).join('');
  // Populate checkpoint list
  const cpList=document.getElementById('rsCPList');
  const cps=_cpForLoc(locId).filter(cp=>cp.active!==false);
  if(!cps.length){
    cpList.innerHTML='<div style="color:var(--text3);font-size:12px;text-align:center;padding:8px">'+(locId?'No active checkpoints at this location':'Select a location first')+'</div>';
    return;
  }
  cpList.innerHTML=cps.map(cp=>`<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;transition:background .15s;border:1px solid transparent" onmouseenter="this.style.background='rgba(42,154,160,.06)'" onmouseleave="this.style.background=''">
    <input type="checkbox" class="rsCPCheck" value="${cp.id}" style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex-shrink:0" onchange="this.closest('label').style.borderColor=this.checked?'var(--accent)':'transparent'">
    <span style="width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0">${cp.sortOrder||''}</span>
    <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600">${cp.name}</div>${cp.description?`<div style="font-size:10px;color:var(--text3)">${cp.description}</div>`:''}</div>
  </label>`).join('');
}
function openRSModal(id){
  const rs=id?byId(DB.roundSchedules||[],id):null;
  document.getElementById('eRSid').value=id||'';
  document.getElementById('mRSTitle').textContent=id?'Edit Round Schedule':'Add Round Schedule';
  document.getElementById('rsNameI').value=rs?.name||'';
  // Populate loc dropdown
  const locS=document.getElementById('rsLocS');
  locS.innerHTML='<option value="">-- Select Location --</option>'+_kapLocations().sort((a,b)=>a.name.localeCompare(b.name)).map(l=>`<option value="${l.id}">${l.name}</option>`).join('');
  locS.value=rs?.locationId||'';
  document.getElementById('rsFreqS').value=rs?.frequency||'Daily';
  document.getElementById('rsStartI').value=rs?.startTime||'06:00';
  document.getElementById('rsEndI').value=rs?.endTime||'18:00';
  document.getElementById('rsInactive').checked=rs?.inactive===true;
  // Trigger loc change to populate guards & checkpoints
  onRSLocChange();
  // Restore guard selection
  if(rs?.guardId) document.getElementById('rsGuardS').value=rs.guardId;
  // Restore checkpoint selections
  if(rs?.checkpointIds?.length){
    setTimeout(()=>{
      document.querySelectorAll('.rsCPCheck').forEach(cb=>{
        if(rs.checkpointIds.includes(cb.value)){
          cb.checked=true;
          cb.closest('label').style.borderColor='var(--accent)';
        }
      });
    },50);
  }
  om('mRoundSchedule');
}
async function saveRS(){
  var _act=document.getElementById('eRSid').value?'action.editRound':'action.createRound';
  if(typeof permCanAct==='function'&&typeof permConfigured==='function'
     &&permConfigured('Security')&&!permCanAct('Security',_act)){
    notify('⚠ You do not have permission to '+(_act==='action.editRound'?'edit':'create')+' round schedules.',true);return;
  }
  const id=document.getElementById('eRSid').value;
  const name=document.getElementById('rsNameI').value.trim();
  const locId=document.getElementById('rsLocS').value;
  const guardId=document.getElementById('rsGuardS').value;
  const freq=document.getElementById('rsFreqS').value;
  const startTime=document.getElementById('rsStartI').value;
  const endTime=document.getElementById('rsEndI').value;
  const inactive=document.getElementById('rsInactive').checked;
  const cpIds=[...document.querySelectorAll('.rsCPCheck:checked')].map(cb=>cb.value);
  if(!name||!locId){modalErr('mRoundSchedule','Name and Location are required');return;}
  if(!startTime||!endTime){modalErr('mRoundSchedule','Start and End time are required');return;}
  if(!cpIds.length){modalErr('mRoundSchedule','Select at least one checkpoint');return;}
  if(!DB.roundSchedules) DB.roundSchedules=[];
  if(id){
    const rs=byId(DB.roundSchedules,id);const bak={...rs};
    Object.assign(rs,{name,locationId:locId,guardId,checkpointIds:cpIds,frequency:freq,startTime,endTime,inactive});
    if(!await _dbSave('roundSchedules',rs)){Object.assign(rs,bak);return;}
  } else {
    const rs={id:'rs'+uid(),name,locationId:locId,guardId,checkpointIds:cpIds,frequency:freq,startTime,endTime,inactive};
    if(!await _dbSave('roundSchedules',rs)) return;
  }
  cm('mRoundSchedule');renderRoundSchedules();notify('Schedule saved!');
}

// Live border update for location checkbox groups
['locTripBook','locMatRecv','locApprover'].forEach(groupId=>{
  document.addEventListener('change',function(e){
    if(e.target.type==='checkbox'&&e.target.closest('#'+groupId)){
      e.target.closest('label').style.borderColor=e.target.checked?'var(--accent)':'var(--border)';
    }
  });
});


// ═══ BOOT / INITIALISATION ═══════════════════════════════════════════════
async function _secBoot(){
  var splash=document.getElementById('dbSplash');
  var _hasCache=false;try{_hasCache=!!localStorage.getItem('kap_db_cache');}catch(e){}
  if(!_hasCache && splash) splash.style.display='flex';
  // Load only Security tables — not VMS/HWMS tables
  // hrmsSettings holds role-permission data (shared across apps); required
  // for permCanView / permCanAct to work in Security nav + page enforcement.
  if(typeof _APP_TABLES!=='undefined') _APP_TABLES=['users','locations','checkpoints','guards','roundSchedules','hrmsSettings'];
  try{ await bootDB(); }catch(e){ console.error('bootDB error',e); }
  if(splash) splash.style.display='none';
  var su=_sessionGet('kap_session_user')||localStorage.getItem('kap_rm_user');
  var sp=_sessionGet('kap_session_token')||localStorage.getItem('kap_rm_token');
  if(su&&sp){
    var user=null;
    try{var _cu=localStorage.getItem('kap_current_user');if(_cu)user=JSON.parse(_cu);if(!user||user.name.toLowerCase()!==su.toLowerCase())user=null;}catch(e){user=null;}
    // Prefer the live DB record over the cached one — admin may have
    // updated roles/apps since this session was created.
    var freshU=(DB.users||[]).find(function(x){return x&&x.name&&x.name.toLowerCase()===su.toLowerCase();});
    if(freshU) user=freshU;
    if(user&&!user.inactive){
      // Role gate — Security roles are KAP Security / Guard / Viewer /
      // Super Admin (stored in CU.roles). Users without any of these
      // shouldn't be able to reach security.html by URL.
      var _secRoles=['Super Admin','KAP Security','Guard','Viewer'];
      var _hasSec=(user.roles||[]).some(function(r){return _secRoles.indexOf(r)>=0;});
      if(!_hasSec){
        if(typeof notify==='function') notify('⚠ You do not have access to Security.',true);
        _navigateTo('index.html');
        return;
      }
      CU=user;
      _enrichCU();
      var initials=(CU.fullName||CU.name||'').trim().split(/\s+/).map(function(w){return w[0]||'';}).slice(0,2).join('').toUpperCase()||'\u{1F464}';
      var av=document.getElementById('secAvatar');
      if(av){ if(CU.photo){av.innerHTML='<img src="'+CU.photo+'" style="width:100%;height:100%;object-fit:cover;border-radius:8px">';}else{av.textContent=initials;} }
      var fn=document.getElementById('secUserFullName'); if(fn) fn.textContent=CU.fullName||CU.name||'\u2014';
      var rl=document.getElementById('secUserRole'); if(rl) rl.textContent=(CU.roles&&CU.roles.includes('Super Admin'))?'Super Admin':'Security';
      document.getElementById('secTopbar').style.display='flex';
      document.getElementById('secApp').style.display='block';
      secGo('pageCheckpoints');
      _onRefreshViews = function(){
        try{ var ap=document.querySelector('.sec-page.active'); if(ap) secGo(ap.id); }catch(e){}
      };
      return;
    }
  }
  _navigateTo('index.html');
}

var _secBootDone=false;
setTimeout(function(){if(!_secBootDone){var sp=document.getElementById('dbSplash');if(sp)sp.style.display='none';_navigateTo('index.html');}},12000);
// Global Enter key handler for Security form submission
document.addEventListener('keydown', function(e){
  if(e.key!=='Enter') return;
  var el=e.target;
  if(!el||el.tagName==='TEXTAREA'||el.tagName==='BUTTON') return;
  var modal=el.closest('.modal-overlay')||el.closest('[id^="mSec"]');
  if(modal){var btn=modal.querySelector('.btn-primary');if(btn&&!btn.disabled){e.preventDefault();btn.click();return;}}
  var card=el.closest('.card');
  if(card){var btn2=card.querySelector('.btn-primary');if(btn2&&!btn2.disabled){e.preventDefault();btn2.click();return;}}
});

document.addEventListener('DOMContentLoaded', function(){
  _secBoot().then(function(){_secBootDone=true;}).catch(function(e){
    console.error('Security boot failed:',e);
    _navigateTo('index.html');
  });
});
