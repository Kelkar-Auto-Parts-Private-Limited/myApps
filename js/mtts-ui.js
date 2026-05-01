// ═══ MAINTENANCE TICKET TRACKING SYSTEM (MTTS) ═════════════════════════════
// Phase 1: Asset Master CRUD + transfer history.
// Phase 2 (planned): ticket lifecycle (raise → allocate → act → close → approve)
// Phase 3 (planned): dashboard (counts / costs / PM-AMC-warranty due-overdue)

// Tables this app needs at boot. hrmsSettings is included because the
// shared rolePermissions blob lives there (used by permCanView /
// permCanAct against MTTS keys).
if(typeof _APP_TABLES!=='undefined') _APP_TABLES=['users','hrmsSettings','mttsPlants','mttsAssetTypes','mttsAssetPrimaryNames','mttsAgencies','mttsAssets','mttsTickets'];

// ── Boot: re-auth from session, then launch ────────────────────────────────
(function(){
  document.body.style.display='block';
  var splash=document.getElementById('dbSplash');if(splash) splash.style.display='flex';
  // Wait for Supabase + DB to load (handled in common.js bootDB).
  if(typeof bootDB==='function'){
    bootDB().then(function(){
      var u=_sessionGet('kap_session_user');
      var t=_sessionGet('kap_session_token');
      if(!u||!t){_navigateTo('index.html');return;}
      var uobj=(DB.users||[]).find(function(x){return x&&x.name&&x.name.toLowerCase()===String(u).toLowerCase();});
      if(!uobj){_navigateTo('index.html');return;}
      CU=uobj;
      if(typeof _enrichCU==='function') _enrichCU();
      _mttsLaunch();
    }).catch(function(e){console.error('mtts boot',e);_navigateTo('index.html');});
  }
})();

function _mttsLaunch(){
  var splash=document.getElementById('dbSplash');if(splash) splash.style.display='none';
  document.getElementById('mttsApp').style.display='block';
  // Avatar / name
  var av=document.getElementById('mttsAvatar');
  var nm=document.getElementById('mttsUserFullName');
  var rl=document.getElementById('mttsUserRole');
  if(av) av.textContent=(CU.fullName||CU.name||'?').slice(0,1).toUpperCase();
  if(nm) nm.textContent=CU.fullName||CU.name||'';
  if(rl) rl.textContent=((CU.mttsRoles||[]).join(' · '))||((CU.roles||[]).indexOf('Super Admin')>=0?'Super Admin':'—');
  // Mirror name to the topbar so it stays visible when the sidebar is hidden.
  var tbu=document.getElementById('mttsTopbarUser');
  if(tbu) tbu.textContent=CU.fullName||CU.name||'';
  _mttsEnforcePermissions();
  // First-run seed: populate the Plant Master from the legacy PLANTS
  // constant so existing assets / tickets (created before the master
  // existed) keep resolving by code. Re-render dropdowns afterwards.
  _mttsSeedPlantsIfEmpty().then(function(){_mttsPopulatePlantOptions();}).catch(function(e){console.warn('seed plants',e);_mttsPopulatePlantOptions();});
  _mttsPopulatePlantOptions();
  _mttsSeedAssetTypesIfEmpty().then(function(){_mttsPopulateAssetTypeOptions();}).catch(function(e){console.warn('seed asset types',e);_mttsPopulateAssetTypeOptions();});
  _mttsPopulateAssetTypeOptions();
  _mttsSeedAssetPrimaryNamesIfEmpty().then(function(){_mttsPopulateAssetPrimaryNameOptions();}).catch(function(e){console.warn('seed primary names',e);_mttsPopulateAssetPrimaryNameOptions();});
  _mttsPopulateAssetPrimaryNameOptions();
  if(typeof _mttsUpdateTicketBadge==='function') _mttsUpdateTicketBadge();
  // Default landing — Dashboard for everyone with access, with sensible
  // fallbacks (assets, tickets) for users who don't have dashboard view.
  if(_mttsHasAccess('page.dashboard')) mttsGo('pageMttsDashboard');
  else if(_mttsHasAccess('page.tickets')) mttsGo('pageMttsTickets');
  else if(_mttsHasAccess('page.assets')) mttsGo('pageMttsAssets');
  else _mttsRenderNoAccessShell();
}

// Pull every MTTS table fresh from Supabase and re-render whichever page
// is active. Mirrors _hrmsManualRefresh — single button on the topbar.
async function _mttsManualRefresh(){
  var btn=document.querySelector('.mtts-topbar-refresh');
  if(btn){btn.disabled=true;}
  notify('🔄 Refreshing data…');
  try{
    if(_sb&&_sbReady){
      await Promise.all((_APP_TABLES||[]).map(async function(tbl){
        var sbTbl=SB_TABLES[tbl];if(!sbTbl) return;
        var sel=typeof _syncSelect==='function'?_syncSelect(sbTbl):'*';
        var res=await _sb.from(sbTbl).select(sel).limit(10000);
        if(!res.error&&res.data) DB[tbl]=res.data.map(function(r){return _fromRow(tbl,r);}).filter(Boolean);
      }));
    }
    var active=document.querySelector('.page.active');
    var pid=active?active.id:'';
    if(pid==='pageMttsDashboard') _mttsDashboardRender();
    else if(pid==='pageMttsPlants') _mttsRenderPlants();
    else if(pid==='pageMttsAssetTypes') _mttsRenderAssetTypes();
    else if(pid==='pageMttsAssetPrimaryNames') _mttsRenderAssetPrimaryNames();
    else if(pid==='pageMttsAgencies') _mttsRenderAgencies();
    else if(pid==='pageMttsAssets') _mttsRenderAssets();
    else if(pid==='pageMttsTickets') _mttsRenderTickets();
    if(typeof _mttsUpdateTicketBadge==='function') _mttsUpdateTicketBadge();
    notify('✅ Data refreshed');
  }catch(e){notify('⚠ Refresh failed: '+(e.message||e),true);}
  if(btn) btn.disabled=false;
}

function mttsLogout(){
  try{CU=null;}catch(e){}
  try{_sessionDel('kap_session_user');_sessionDel('kap_session_token');}catch(e){}
  try{
    localStorage.removeItem('kap_rm_user');
    localStorage.removeItem('kap_rm_token');
    localStorage.removeItem('kap_current_user');
    localStorage.removeItem('kap_db_cache');
  }catch(e){}
  try{window.location.href='index.html';}
  catch(e){try{window.location.replace('index.html');}catch(e2){}}
}

// ── Permission helpers ────────────────────────────────────────────────────
function _mttsIsSA(){
  return CU&&((CU.roles||[]).indexOf('Super Admin')>=0||(CU.mttsRoles||[]).indexOf('Super Admin')>=0);
}
function _mttsIsManager(){
  return CU&&(CU.mttsRoles||[]).indexOf('Maintenance Manager')>=0;
}
function _mttsHasAccess(featureKey){
  if(_mttsIsSA()) return true;
  if(_mttsIsManager()) return true; // module-admin equivalent
  // Permissions configured? respect them.
  if(typeof permConfigured==='function'&&permConfigured('MTTS')){
    if(/^action\./.test(featureKey)){
      return typeof permCanAct==='function'&&permCanAct('MTTS',featureKey);
    }
    return typeof permCanView==='function'&&permCanView('MTTS',featureKey);
  }
  // Fallback role defaults — no permissions configured for this user.
  if(!CU) return false;
  var r=CU.mttsRoles||[];
  if(r.indexOf('Technician')>=0){
    // Technician: tickets + assets (read).
    var TECH={'page.assets':1,'page.tickets':1,'action.actOnTicket':1};
    return !!TECH[featureKey];
  }
  if(r.indexOf('Ticket Raiser')>=0){
    var RAISER={'page.assets':1,'page.tickets':1,'action.raiseTicket':1};
    return !!RAISER[featureKey];
  }
  return false;
}

function _mttsEnforcePermissions(){
  var navMap={
    nMttsDashboard:'page.dashboard',
    nMttsPlants:'page.plants',
    nMttsAssetTypes:'page.assetTypes',
    nMttsAssetPrimaryNames:'page.assetPrimaryNames',
    nMttsAgencies:'page.agencies',
    nMttsAssets:'page.assets',
    nMttsTickets:'page.tickets'
  };
  Object.keys(navMap).forEach(function(navId){
    var el=document.getElementById(navId);
    if(el) el.style.display=_mttsHasAccess(navMap[navId])?'':'none';
  });
}

// ── Page navigation ────────────────────────────────────────────────────────
function mttsGo(pid){
  var permKey={pageMttsDashboard:'page.dashboard',pageMttsPlants:'page.plants',pageMttsAssetTypes:'page.assetTypes',pageMttsAssetPrimaryNames:'page.assetPrimaryNames',pageMttsAgencies:'page.agencies',pageMttsAssets:'page.assets',pageMttsTickets:'page.tickets'}[pid];
  if(permKey&&!_mttsHasAccess(permKey)){notify('Access denied',true);return;}
  document.querySelectorAll('.page').forEach(function(p){p.style.display='none';p.classList.remove('active');});
  document.querySelectorAll('.mtts-nav-item').forEach(function(n){n.classList.remove('active');});
  var pg=document.getElementById(pid);if(pg){pg.style.display='block';pg.classList.add('active');}
  var navMap={pageMttsDashboard:'nMttsDashboard',pageMttsPlants:'nMttsPlants',pageMttsAssetTypes:'nMttsAssetTypes',pageMttsAssetPrimaryNames:'nMttsAssetPrimaryNames',pageMttsAgencies:'nMttsAgencies',pageMttsAssets:'nMttsAssets',pageMttsTickets:'nMttsTickets'};
  var nav=document.getElementById(navMap[pid]);if(nav) nav.classList.add('active');
  var titleMap={pageMttsDashboard:'Dashboard',pageMttsPlants:'Plant Master',pageMttsAssetTypes:'Asset Type Master',pageMttsAssetPrimaryNames:'Asset Primary Name',pageMttsAgencies:'Agency / Vendor',pageMttsAssets:'Asset Master',pageMttsTickets:'Tickets'};
  var t=document.getElementById('mttsPageTitle');if(t) t.textContent=titleMap[pid]||'MTTS';
  if(pid==='pageMttsPlants') _mttsRenderPlants();
  if(pid==='pageMttsAssetTypes') _mttsRenderAssetTypes();
  if(pid==='pageMttsAssetPrimaryNames') _mttsRenderAssetPrimaryNames();
  if(pid==='pageMttsAgencies') _mttsRenderAgencies();
  if(pid==='pageMttsAssets') _mttsRenderAssets();
  if(pid==='pageMttsTickets') _mttsRenderTickets();
  if(pid==='pageMttsDashboard') _mttsDashboardRender();
  if(window.innerWidth<=900) closeMttsNav();
}

// Hamburger behaviour:
//   - Mobile (≤700px): the sidebar is hidden by default. Toggle 'open' on
//     the sidebar (and 'show' on the dim overlay) to slide it in.
//   - Desktop (>700px): the sidebar is visible by default. Toggle a
//     'mtts-nav-collapsed' class on <body> so the sidebar slides off and
//     the topbar / main content reclaim the freed width.
function toggleMttsNav(){
  var sb=document.getElementById('mttsSidebar');
  var ov=document.getElementById('mttsOverlay');
  var isMobile=window.innerWidth<=700;
  if(isMobile){
    if(sb) sb.classList.toggle('open');
    if(ov) ov.classList.toggle('show',sb&&sb.classList.contains('open'));
  } else {
    document.body.classList.toggle('mtts-nav-collapsed');
  }
}
function closeMttsNav(){
  var sb=document.getElementById('mttsSidebar');
  var ov=document.getElementById('mttsOverlay');
  if(sb) sb.classList.remove('open');
  if(ov) ov.classList.remove('show');
  // Desktop collapse stays sticky — only the mobile drawer auto-closes.
}

function _mttsRenderNoAccessShell(){
  var app=document.getElementById('mttsApp');if(!app) return;
  app.innerHTML='<div class="card" style="padding:48px 32px;text-align:center;max-width:560px;margin:48px auto"><div style="font-size:48px;margin-bottom:16px">🔒</div>'+
    '<div style="font-size:18px;font-weight:800;color:var(--text);margin-bottom:8px">No MTTS access yet</div>'+
    '<div style="font-size:13px;color:var(--text2);line-height:1.6">You\'re signed in as <b>'+(CU&&CU.fullName||CU&&CU.name||'')+'</b>, but no MTTS pages have been enabled for your role. Please ask an administrator to grant access via <b>Configure Access</b>.</div></div>';
}

// ── Plant lookup helpers ───────────────────────────────────────────────────
// Active plants from the MTTS Plant Master, sorted by name. Falls back to
// the legacy global PLANTS constant only if the master is empty (covers
// first-run before any plant has been added).
function _mttsPlantList(includeInactive){
  var list=(DB.mttsPlants||[]).slice().filter(function(p){return p&&(includeInactive||!p.inactive);});
  if(list.length){
    return list.sort(function(a,b){return(a.name||'').localeCompare(b.name||'');})
      .map(function(p){return {value:p.id,label:p.name||p.id,color:p.color||'',_plant:p};});
  }
  // Empty master → legacy seed.
  var legacy=(typeof PLANTS!=='undefined'&&Array.isArray(PLANTS))?PLANTS:[];
  return legacy.map(function(p){return {value:p.value,label:p.label,color:p.colour||''};});
}
function _mttsPlantLabel(code){
  if(!code) return '—';
  var p=(DB.mttsPlants||[]).find(function(x){return x&&x.id===code;});
  if(p) return p.name||code;
  // Legacy fallback — match the constant's value→label mapping.
  var leg=(typeof PLANTS!=='undefined'?PLANTS:[]).find(function(x){return x.value===code;});
  return leg?leg.label:code;
}
function _mttsPlantColor(code){
  if(!code) return '';
  var p=(DB.mttsPlants||[]).find(function(x){return x&&x.id===code;});
  if(p) return p.color||'';
  var leg=(typeof PLANTS!=='undefined'?PLANTS:[]).find(function(x){return x.value===code;});
  return leg?(leg.colour||''):'';
}
// Inline badge (chip) showing plant name on its master-defined background
// colour. Picks readable text colour by simple luminance check so dark
// backgrounds get white text.
function _mttsPlantBadge(code){
  var lbl=_mttsPlantLabel(code);
  var bg=_mttsPlantColor(code);
  if(!bg) return '<span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:700;background:#f1f5f9;color:#1a2033;border:1px solid #e2e8f0">'+lbl+'</span>';
  // Detect dark bg (#rrggbb) for white text.
  var hex=String(bg).replace('#','').trim();
  var fg='#1a2033';
  if(/^[0-9a-f]{6}$/i.test(hex)){
    var r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
    var lum=(0.299*r+0.587*g+0.114*b);
    if(lum<150) fg='#fff';
  }
  return '<span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:800;background:'+bg+';color:'+fg+';border:1px solid rgba(0,0,0,.08)">'+lbl+'</span>';
}

function _mttsPopulatePlantOptions(){
  var list=_mttsPlantList(false);
  var opts=list.map(function(p){return '<option value="'+p.value+'">'+p.label+'</option>';}).join('');
  // Filter dropdowns
  var f=document.getElementById('mttsAssetPlantFilter');
  if(f) f.innerHTML='<option value="">All plants</option>'+opts;
  var f2=document.getElementById('mttsTicketPlantFilter');
  if(f2){f2.innerHTML='<option value="">All plants</option>'+opts;f2._populated=true;}
  var f3=document.getElementById('mttsDashPlantFilter');
  if(f3) f3.innerHTML='<option value="">All plants</option>'+opts;
  // Edit modals — Transfer modal still uses a select; asset edit modal
  // is now chip-driven and re-renders on demand.
  var t=document.getElementById('mttsTransferTo');
  if(t) t.innerHTML='<option value="">— Select —</option>'+opts;
  if(document.getElementById('mttsRaisePlantBtns')&&typeof _mttsRaiseRenderPlantBtns==='function') _mttsRaiseRenderPlantBtns();
  if(document.getElementById('mttsAssetPlantBtns')&&typeof _mttsAssetRenderPlantBtns==='function') _mttsAssetRenderPlantBtns();
}

// ── Asset Master ──────────────────────────────────────────────────────────
// In-table filter state — preserved across renders since the per-column
// dropdowns live inside the thead and get rebuilt on every _mttsRenderAssets
// call.
var _mttsAssetState={plant:'',type:'',status:'Active',search:''};
function _mttsRenderAssets(){
  // Hide "+ Add Asset" when the user can't edit assets.
  var addBtn=document.getElementById('btnMttsAddAsset');
  if(addBtn) addBtn.style.display=_mttsHasAccess('action.editAsset')?'':'none';
  var wrap=document.getElementById('mttsAssetTableWrap');if(!wrap) return;
  // Capture any currently-selected values (from a previous render) so the
  // user's choice survives the rebuild. Also capture which filter element
  // had focus + its selection range, so typing into the search box doesn't
  // lose the cursor on every keystroke when the table re-renders.
  var pEl0=document.getElementById('mttsAssetPlantFilter');
  if(pEl0) _mttsAssetState.plant=pEl0.value;
  var tEl0=document.getElementById('mttsAssetTypeFilter');
  if(tEl0) _mttsAssetState.type=tEl0.value;
  var sEl0=document.getElementById('mttsAssetStatusFilter');
  if(sEl0) _mttsAssetState.status=sEl0.value;
  var srchEl0=document.getElementById('mttsAssetSearch');
  if(srchEl0) _mttsAssetState.search=srchEl0.value;
  var activeId=document.activeElement&&document.activeElement.id;
  var caretStart=null,caretEnd=null;
  if(activeId==='mttsAssetSearch'&&srchEl0){
    try{caretStart=srchEl0.selectionStart;caretEnd=srchEl0.selectionEnd;}catch(e){}
  }
  var fPlant=_mttsAssetState.plant;
  var fType=_mttsAssetState.type;
  var fStatus=_mttsAssetState.status;
  var fSearch=String(_mttsAssetState.search||'').toLowerCase().trim();
  var assets=(DB.mttsAssets||[]).filter(function(a){
    if(!a) return false;
    if(fPlant&&a.plant!==fPlant) return false;
    if(fType&&a.assetType!==fType) return false;
    if(fStatus&&a.status!==fStatus) return false;
    if(fSearch){
      var hay=((a.name||'')+' '+(a.serialNo||'')+' '+(a.make||'')+' '+(a.model||'')).toLowerCase();
      if(hay.indexOf(fSearch)<0) return false;
    }
    return true;
  });
  // Summary
  var sumEl=document.getElementById('mttsAssetSummary');
  if(sumEl){
    var counts={Machinery:0,Building:0,Furniture:0,'IT Devices':0,'Electrical Devices':0};
    (DB.mttsAssets||[]).forEach(function(a){if(a&&counts.hasOwnProperty(a.assetType)) counts[a.assetType]++;});
    sumEl.innerHTML='Total: <b>'+(DB.mttsAssets||[]).length+'</b> · Showing: <b>'+assets.length+'</b> · '+
      Object.keys(counts).map(function(k){return k+': <b>'+counts[k]+'</b>';}).join(' · ');
  }
  // Note: we no longer early-return on empty results — losing the table
  // would also lose the filter / search inputs and trap the user. Instead
  // we render the filter + header rows as usual and inject a single
  // "no matches" row inside tbody.
  var critClr={High:'#dc2626',Medium:'#f59e0b',Low:'#16a34a'};
  var statusClr={Active:'#16a34a',Inactive:'#94a3b8',Scrap:'#dc2626'};
  var plantLbl=function(v){return _mttsPlantLabel(v);};
  var rows=assets.slice().sort(function(a,b){
    var pl=String(a.plant||'').localeCompare(String(b.plant||''));if(pl) return pl;
    var tp=String(a.assetType||'').localeCompare(String(b.assetType||''));if(tp) return tp;
    return String(a.name||'').localeCompare(String(b.name||''));
  });
  // Filter row sits ABOVE the column headers; the header row is sticky to
  // top:0 of the scroll container so it always stays visible while the
  // filter row scrolls away with the rest of the content.
  var thFilter='padding:6px 8px;background:#fff;border-bottom:1px solid var(--border);text-align:left';
  var th='padding:9px 12px;font-size:13px;font-weight:800;background:#f1f5f9;border-top:1px solid var(--border);border-bottom:2px solid var(--border);text-align:left;position:sticky;top:0;z-index:2;box-shadow:0 1px 0 rgba(0,0,0,.04)';
  var td='padding:8px 12px;font-size:14px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  // Build per-column filter dropdown options for Plant / Type / Status,
  // plus the Name search input that lives above the Asset column.
  var plantList=_mttsPlantList(true);
  var plantOpts='<option value="">All</option>'+plantList.map(function(p){
    return '<option value="'+p.value+'"'+(p.value===fPlant?' selected':'')+'>'+p.label+'</option>';
  }).join('');
  var typesArr=_mttsAssetTypeList(true);
  var typeOpts='<option value="">All</option>'+typesArr.map(function(t){
    return '<option value="'+t.value+'"'+(t.value===fType?' selected':'')+'>'+t.label+'</option>';
  }).join('');
  var statusArr=['Active','Inactive','Scrap'];
  var statusOpts='<option value="">All</option>'+statusArr.map(function(s){
    return '<option value="'+s+'"'+(s===fStatus?' selected':'')+'>'+s+'</option>';
  }).join('');
  var inlineSel='font-size:11px;padding:5px 7px;border:1px solid var(--border2);border-radius:5px;background:#fff;color:var(--text);width:100%';
  var inlineSearchVal=String(fSearch||'').replace(/"/g,'&quot;');
  var html='<div style="overflow:auto;border:1.5px solid var(--border);border-radius:8px;background:#fff;max-height:calc(100vh - 240px);width:fit-content;max-width:100%">'+
    '<table style="width:auto;border-collapse:collapse;font-size:14px"><thead>'+
      // FILTER ROW — first; scrolls away with content.
      '<tr>'+
        '<th style="'+thFilter+'"></th>'+
        '<th style="'+thFilter+'"><select id="mttsAssetPlantFilter" onchange="_mttsRenderAssets()" style="'+inlineSel+'">'+plantOpts+'</select></th>'+
        '<th style="'+thFilter+'"><select id="mttsAssetTypeFilter" onchange="_mttsRenderAssets()" style="'+inlineSel+'">'+typeOpts+'</select></th>'+
        // Search-by-name input sits above the Asset column.
        '<th style="'+thFilter+'"><input type="search" id="mttsAssetSearch" placeholder="🔍 name / serial / make…" oninput="_mttsRenderAssets()" value="'+inlineSearchVal+'" style="'+inlineSel+'"></th>'+
        '<th style="'+thFilter+'"></th>'+
        '<th style="'+thFilter+'"></th>'+
        '<th style="'+thFilter+'"></th>'+
        '<th style="'+thFilter+'"><select id="mttsAssetStatusFilter" onchange="_mttsRenderAssets()" style="'+inlineSel+'">'+statusOpts+'</select></th>'+
        '<th style="'+thFilter+'"></th>'+
      '</tr>'+
      // HEADER ROW — sticky to top of scroll container.
      '<tr>'+
        '<th style="'+th+'">#</th>'+
        '<th style="'+th+'">Plant</th>'+
        '<th style="'+th+'">Type</th>'+
        '<th style="'+th+'">Asset</th>'+
        '<th style="'+th+'">Serial / Model</th>'+
        '<th style="'+th+'">Installed</th>'+
        '<th style="'+th+'">Priority</th>'+
        '<th style="'+th+'">Status</th>'+
        '<th style="'+th+';text-align:center;width:100px">Actions</th>'+
      '</tr>'+
    '</thead><tbody>'+
    (rows.length?'':'<tr><td colspan="9" style="padding:30px 20px;text-align:center;color:var(--text3);font-size:13px">No assets match the current filters.</td></tr>');
  rows.forEach(function(a,i){
    var idEsc=String(a.id||'').replace(/'/g,"\\'");
    var sm=a.serialNo?'SN: '+a.serialNo:'';
    var mm=[a.make,a.model].filter(Boolean).join(' / ');
    html+='<tr class="clickable-row" onclick="_mttsAssetOpen(\''+idEsc+'\')">'+
      '<td style="'+td+';color:var(--text3);font-family:var(--mono)">'+(i+1)+'</td>'+
      '<td style="'+td+'">'+_mttsPlantBadge(a.plant)+'</td>'+
      '<td style="'+td+'">'+(a.assetType||'—')+'</td>'+
      '<td style="'+td+'"><div style="font-weight:800;color:var(--text)">'+(a.name||'—')+'</div>'+
        (a.description?'<div style="font-size:12px;color:var(--text3);margin-top:1px">'+String(a.description).replace(/</g,'&lt;')+'</div>':'')+'</td>'+
      '<td style="'+td+';font-size:13px">'+(sm?sm+'<br>':'')+(mm||'')+'</td>'+
      '<td style="'+td+';font-family:var(--mono);font-size:12px;color:var(--text3)">'+(a.installDate||'—')+'</td>'+
      '<td style="'+td+'"><span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:12px;font-weight:800;background:'+critClr[a.criticality]+'22;color:'+critClr[a.criticality]+'">'+(a.criticality||'Medium')+'</span></td>'+
      '<td style="'+td+'"><span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:12px;font-weight:800;background:'+statusClr[a.status]+'22;color:'+statusClr[a.status]+'">'+(a.status||'Active')+'</span></td>'+
      '<td style="'+td+';text-align:center;white-space:nowrap">'+
        '<button onclick="event.stopPropagation();_mttsAssetOpen(\''+idEsc+'\')" title="Edit asset" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer">✎</button>'+
        (function(){
          var canEd=_mttsHasAccess('action.editAsset');
          var refs=(DB.mttsTickets||[]).filter(function(t){return t&&t.assetCode===a.id;}).length;
          if(canEd&&refs===0) return '<button onclick="event.stopPropagation();_mttsAssetDeleteFromTable(\''+idEsc+'\')" title="Delete asset" style="font-size:12px;padding:4px 9px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer;margin-left:3px">🗑</button>';
          if(canEd&&refs>0) return '<button disabled title="In use — '+refs+' ticket(s) reference this asset" style="font-size:12px;padding:4px 9px;font-weight:700;background:#f1f5f9;border:1px solid var(--border);color:#cbd5e1;border-radius:4px;cursor:not-allowed;margin-left:3px">🗑</button>';
          return '';
        })()+
      '</td>'+
    '</tr>';
  });
  html+='</tbody></table></div>';
  wrap.innerHTML=html;
  // Restore focus + caret on the filter row's currently-edited input so
  // typing in the search box doesn't lose the cursor on every keystroke.
  if(activeId){
    var newActive=document.getElementById(activeId);
    if(newActive&&typeof newActive.focus==='function'){
      newActive.focus();
      if(activeId==='mttsAssetSearch'&&caretStart!=null){
        try{newActive.setSelectionRange(caretStart,caretEnd!=null?caretEnd:caretStart);}catch(e){}
      }
    }
  }
}

// ── Asset edit modal ──────────────────────────────────────────────────────
function _mttsAssetOpen(id){
  var canEdit=_mttsHasAccess('action.editAsset');
  if(!canEdit&&id===''){notify('You do not have permission to add assets',true);return;}
  var a=id?(byId(DB.mttsAssets||[],id)||null):null;
  document.getElementById('mttsAssetTitle').textContent=a?(canEdit?'🛠 Edit Asset':'🛠 View Asset'):'🛠 Add Asset';
  document.getElementById('mttsAssetId').value=a?a.id:'';
  document.getElementById('mttsAssetPlant').value=a?(a.plant||''):'';
  document.getElementById('mttsAssetType').value=a?(a.assetType||''):'';
  document.getElementById('mttsAssetCrit').value=a?(a.criticality||'Medium'):'Medium';
  // Render the three chip rows (plant, asset type, priority).
  _mttsAssetRenderPlantBtns();
  _mttsAssetRenderTypeBtns();
  _mttsAssetRenderCritBtns();
  // Primary name select — refreshed every open so newly-added master rows
  // are immediately pickable. Falls back to the legacy `name` field when an
  // imported/old asset has no primaryName set yet.
  _mttsPopulateAssetPrimaryNameOptions();
  var primSel=document.getElementById('mttsAssetPrimary');
  if(primSel){
    var primVal=a?(a.primaryName||''):'';
    primSel.value=primVal;
    // If the asset's stored primaryName isn't in the master list (legacy
    // data), fall back to blank and let the user pick. The legacy
    // composite name still shows below for reference.
    if(a&&primVal&&primSel.value!==primVal){primSel.value='';}
  }
  var extEl=document.getElementById('mttsAssetNameExt');
  if(extEl) extEl.value=a?(a.nameExtension||''):'';
  document.getElementById('mttsAssetName').value=a?(a.name||''):'';
  document.getElementById('mttsAssetDesc').value=a?(a.description||''):'';
  document.getElementById('mttsAssetSerial').value=a?(a.serialNo||''):'';
  document.getElementById('mttsAssetInstall').value=a?(a.installDate||'2020-01-01'):'2020-01-01';
  document.getElementById('mttsAssetMake').value=a?(a.make||''):'';
  document.getElementById('mttsAssetModel').value=a?(a.model||''):'';
  document.getElementById('mttsAssetWarranty').value=a&&a.warranty?(a.warranty.until||''):'';
  document.getElementById('mttsAssetAmc').value=a&&a.amc?(a.amc.until||''):'';
  document.getElementById('mttsAssetCrit').value=a?(a.criticality||'Medium'):'Medium';
  document.getElementById('mttsAssetStatus').value=a?(a.status||'Active'):'Active';
  // Transfer history + button visibility (edit-only).
  var transferWrap=document.getElementById('mttsAssetTransferWrap');
  var transferBtn=document.getElementById('mttsAssetTransferBtn');
  if(a&&Array.isArray(a.transferHistory)&&a.transferHistory.length){
    var plantLbl2=function(v){return _mttsPlantLabel(v);};
    var listHtml=a.transferHistory.slice().reverse().map(function(t){
      return '<div>📅 '+(t.date||'—')+' · '+plantLbl2(t.from)+' → <b>'+plantLbl2(t.to)+'</b>'+(t.note?' · '+String(t.note).replace(/</g,'&lt;'):'')+(t.by?' <span style="color:var(--text3)">by '+t.by+'</span>':'')+'</div>';
    }).join('');
    document.getElementById('mttsAssetTransferList').innerHTML=listHtml;
    transferWrap.style.display='block';
  } else {
    transferWrap.style.display='none';
  }
  if(transferBtn) transferBtn.style.display=(a&&canEdit)?'inline-flex':'none';
  var err=document.getElementById('mttsAssetErr');if(err){err.style.display='none';err.textContent='';}
  // When the user lacks edit permission, lock every input/select/textarea
  // in the modal and hide the Save button so the modal effectively becomes
  // a read-only viewer. The Cancel/× still works.
  var modalEl=document.getElementById('mMttsAsset');
  if(modalEl){
    Array.prototype.forEach.call(modalEl.querySelectorAll('input,select,textarea'),function(el){
      // Don't touch the hidden id field — readOnly is harmless on it but
      // makes intent clearer to keep edits explicit.
      if(canEdit){el.disabled=false;el.readOnly=false;}
      else {el.disabled=true;}
    });
    var saveBtn=modalEl.querySelector('button.btn-primary');
    if(saveBtn) saveBtn.style.display=canEdit?'':'none';
    if(modalEl._mttsKeyHandler) modalEl.removeEventListener('keydown',modalEl._mttsKeyHandler);
    modalEl._mttsKeyHandler=function(ev){
      if(modalEl.style.display==='none'||!modalEl.classList.contains('open')) return;
      if(ev.key==='Escape'){ev.preventDefault();cm('mMttsAsset');return;}
      if(ev.key==='Enter'){
        if(!canEdit){ev.preventDefault();cm('mMttsAsset');return;}
        var tag=ev.target&&ev.target.tagName;
        if(tag==='TEXTAREA') return;
        ev.preventDefault();_mttsAssetSave();
      }
    };
    modalEl.addEventListener('keydown',modalEl._mttsKeyHandler);
  }
  if(typeof om==='function') om('mMttsAsset'); else { document.getElementById('mMttsAsset').classList.add('open'); }
}

async function _mttsAssetDeleteFromTable(id){
  if(!_mttsHasAccess('action.editAsset')){notify('Access denied',true);return;}
  var a=byId(DB.mttsAssets||[],id);if(!a) return;
  var refs=(DB.mttsTickets||[]).filter(function(t){return t&&t.assetCode===a.id;}).length;
  if(refs){notify('⚠ Cannot delete — '+refs+' ticket(s) reference this asset',true);return;}
  if(!confirm('Delete asset "'+(a.name||a.id)+'"? This cannot be undone.')) return;
  var idx=(DB.mttsAssets||[]).indexOf(a);
  var ok=await _dbDel('mttsAssets',a.id);
  if(!ok){notify('Delete failed',true);return;}
  if(idx>=0) DB.mttsAssets.splice(idx,1);
  notify('🗑 Asset deleted');
  _mttsRenderAssets();
}

async function _mttsAssetSave(){
  if(!_mttsHasAccess('action.editAsset')){notify('Access denied',true);return;}
  var err=document.getElementById('mttsAssetErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  // Trim every text field (collapse leading/trailing whitespace and stray
  // newlines from paste) before validation + save.
  var _t=function(elId){
    var el=document.getElementById(elId);
    if(!el) return '';
    var v=String(el.value||'').replace(/^[\s ]+|[\s ]+$/g,'');
    el.value=v;
    return v;
  };
  var id=document.getElementById('mttsAssetId').value;
  var plant=document.getElementById('mttsAssetPlant').value;
  var type=document.getElementById('mttsAssetType').value;
  var primaryCode=document.getElementById('mttsAssetPrimary').value;
  var ext=_t('mttsAssetNameExt');
  if(!plant){_showErr('Plant is required');return;}
  if(!type){_showErr('Asset Type is required');return;}
  if(!primaryCode){_showErr('Primary Name is required');return;}
  // Compose the full asset name from the master's display label + the
  // free-text extension. Stored alongside primaryName/nameExtension so the
  // table & ticket displays can keep using `name` directly.
  var primLbl=_mttsAssetPrimaryNameLabel(primaryCode)||primaryCode;
  var name=ext?(primLbl+'-'+ext):primLbl;
  // Reflect the composed name into the hidden field for any consumers that
  // still read it.
  var nameEl=document.getElementById('mttsAssetName');if(nameEl) nameEl.value=name;
  // Per-plant uniqueness on the (primaryName + extension) combo, case-
  // insensitive. The same primary at a different plant is fine.
  var primKey=String(primaryCode).toLowerCase();
  var extKey=ext.toLowerCase().replace(/\s+/g,' ');
  var dupAsset=(DB.mttsAssets||[]).find(function(a){
    if(!a||a.id===id) return false;
    if(a.plant!==plant) return false;
    var aPrim=String(a.primaryName||'').toLowerCase();
    var aExt=String(a.nameExtension||'').toLowerCase().replace(/\s+/g,' ');
    return aPrim===primKey&&aExt===extKey;
  });
  if(dupAsset){
    _showErr('"'+name+'" already exists at '+_mttsPlantLabel(plant)+' — primary name + extension must be unique within a plant');
    return;
  }
  var data={
    plant:plant,
    assetType:type,
    primaryName:primaryCode,
    nameExtension:ext,
    name:name,
    description:_t('mttsAssetDesc'),
    serialNo:_t('mttsAssetSerial'),
    installDate:document.getElementById('mttsAssetInstall').value||'2020-01-01',
    make:_t('mttsAssetMake'),
    model:_t('mttsAssetModel'),
    warranty:{until:document.getElementById('mttsAssetWarranty').value||''},
    amc:{until:document.getElementById('mttsAssetAmc').value||''},
    criticality:document.getElementById('mttsAssetCrit').value||'Medium',
    status:document.getElementById('mttsAssetStatus').value||'Active'
  };
  if(id){
    var existing=byId(DB.mttsAssets||[],id);
    if(!existing){_showErr('Asset not found');return;}
    var bak=Object.assign({},existing);
    Object.assign(existing,data);
    var ok=await _dbSave('mttsAssets',existing);
    if(!ok){Object.assign(existing,bak);_showErr('Save failed');return;}
    notify('✓ Asset updated');
  } else {
    var newAsset=Object.assign({id:'a'+uid(),transferHistory:[]},data);
    if(!DB.mttsAssets) DB.mttsAssets=[];
    DB.mttsAssets.push(newAsset);
    var ok2=await _dbSave('mttsAssets',newAsset);
    if(!ok2){
      DB.mttsAssets=DB.mttsAssets.filter(function(x){return x!==newAsset;});
      _showErr('Save failed');return;
    }
    notify('✓ Asset added');
  }
  cm('mMttsAsset');
  _mttsRenderAssets();
}

// ── Transfer flow ─────────────────────────────────────────────────────────
function _mttsAssetTransferOpen(){
  var id=document.getElementById('mttsAssetId').value;
  if(!id){notify('Save the asset first',true);return;}
  var a=byId(DB.mttsAssets||[],id);if(!a){notify('Asset not found',true);return;}
  var plantLbl=function(v){return _mttsPlantLabel(v);};
  document.getElementById('mttsTransferAssetLbl').innerHTML='Transferring <b>'+(a.name||'')+'</b> from <b>'+plantLbl(a.plant)+'</b>';
  document.getElementById('mttsTransferTo').value='';
  document.getElementById('mttsTransferDate').value=(new Date()).toISOString().slice(0,10);
  document.getElementById('mttsTransferNote').value='';
  var err=document.getElementById('mttsTransferErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsTransfer'); else { document.getElementById('mMttsTransfer').classList.add('open'); }
}

async function _mttsAssetTransferConfirm(){
  if(!_mttsHasAccess('action.editAsset')){notify('Access denied',true);return;}
  var err=document.getElementById('mttsTransferErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var id=document.getElementById('mttsAssetId').value;
  var a=byId(DB.mttsAssets||[],id);if(!a){_showErr('Asset not found');return;}
  var to=document.getElementById('mttsTransferTo').value;
  var date=document.getElementById('mttsTransferDate').value;
  var note=document.getElementById('mttsTransferNote').value.trim();
  if(!to){_showErr('Target plant is required');return;}
  if(!date){_showErr('Transfer date is required');return;}
  if(to===a.plant){_showErr('Target plant is the same as current plant');return;}
  var bak=Object.assign({},a);
  a.transferHistory=Array.isArray(a.transferHistory)?a.transferHistory.slice():[];
  a.transferHistory.push({from:a.plant,to:to,date:date,note:note,by:CU?(CU.fullName||CU.name||''):'',at:new Date().toISOString()});
  a.plant=to;
  var ok=await _dbSave('mttsAssets',a);
  if(!ok){Object.assign(a,bak);_showErr('Save failed');return;}
  cm('mMttsTransfer');
  notify('📦 Asset transferred');
  // Re-open the edit modal so the user sees the updated history immediately.
  _mttsAssetOpen(a.id);
  _mttsRenderAssets();
}

// ═══ TICKET LIFECYCLE ════════════════════════════════════════════════════════
// Statuses: open → assigned → (awaiting_spares|awaiting_agency)* → repair_done
//           → closed. Terminal alts: scrapped (from any active state).

var _MTTS_STATUS_LABEL={
  open:'Open',
  assigned:'Assigned',
  awaiting_spares:'Awaiting spares',
  awaiting_agency:'Awaiting agency',
  repair_done:'Repair done',
  closed:'Closed',
  scrapped:'Scrapped'
};
var _MTTS_STATUS_CLR={
  open:'#dc2626',          // red — needs allocation
  assigned:'#0ea5e9',      // blue — in tech queue
  awaiting_spares:'#f59e0b',
  awaiting_agency:'#a855f7',
  repair_done:'#16a34a',   // green — awaiting manager
  closed:'#64748b',        // grey — terminal
  scrapped:'#7f1d1d'       // dark red — terminal
};
var _MTTS_BREAKDOWN_LABEL={stopped:'Stopped working',partial:'Partially working',pm:'PM Required'};

function _mttsStatusBadge(s){
  var clr=_MTTS_STATUS_CLR[s]||'#94a3b8';
  return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800;background:'+clr+'22;color:'+clr+'">'+(_MTTS_STATUS_LABEL[s]||s)+'</span>';
}

// "1d 4h" / "32m" elapsed-since formatter for the breakdown timer.
function _mttsTimerSince(iso){
  if(!iso) return '—';
  var t0=new Date(iso).getTime();if(isNaN(t0)) return '—';
  var ms=Date.now()-t0;
  if(ms<0) ms=0;
  var mins=Math.floor(ms/60000),hrs=Math.floor(mins/60),days=Math.floor(hrs/24);
  if(days>=1) return days+'d '+(hrs%24)+'h';
  if(hrs>=1) return hrs+'h '+(mins%60)+'m';
  return Math.max(mins,1)+'m';
}

// Users with Technician role assigned. Used by the manager's allocate modal.
function _mttsTechnicians(){
  return (DB.users||[]).filter(function(u){
    if(!u||u.inactive) return false;
    var r=u.mttsRoles||[];
    return r.indexOf('Technician')>=0;
  }).sort(function(a,b){return(a.fullName||a.name||'').localeCompare(b.fullName||b.name||'');});
}
function _mttsUserDisp(uid){
  if(!uid) return '';
  var u=(DB.users||[]).find(function(x){return x&&(x.name===uid||x.id===uid);});
  return u?(u.fullName||u.name||uid):uid;
}

function _mttsCanRaise(){return _mttsIsSA()||_mttsIsManager()||_mttsHasAccess('action.raiseTicket')||(CU&&(CU.mttsRoles||[]).indexOf('Ticket Raiser')>=0);}
function _mttsCanAllocate(){return _mttsIsSA()||_mttsIsManager()||_mttsHasAccess('action.allocateTicket');}
function _mttsCanApprove(){return _mttsIsSA()||_mttsIsManager()||_mttsHasAccess('action.approveTicket');}
function _mttsIsTechnicianOnTicket(t){
  if(!CU||!t) return false;
  var me=CU.name||CU.id;
  return Array.isArray(t.assignedTo)&&t.assignedTo.indexOf(me)>=0;
}

// ── Ticket list render ────────────────────────────────────────────────────
var _mttsTicketState={plant:'',breakdown:'',status:'',assigned:'',search:''};
function _mttsRenderTickets(){
  var wrap=document.getElementById('mttsTicketTableWrap');if(!wrap) return;
  // Show / hide "Raise Ticket" based on role.
  var btnRaise=document.getElementById('btnMttsRaise');
  if(btnRaise) btnRaise.style.display=_mttsCanRaise()?'':'none';

  // Capture current inline-filter values + active focus before re-render.
  var fPlantEl=document.getElementById('mttsTicketPlantFilter');
  var fBdEl=document.getElementById('mttsTicketBreakdownFilter');
  var fStatusEl=document.getElementById('mttsTicketStatusFilter');
  var fAssignEl=document.getElementById('mttsTicketAssignedFilter');
  var fSearchEl=document.getElementById('mttsTicketSearch');
  if(fPlantEl) _mttsTicketState.plant=fPlantEl.value;
  if(fBdEl) _mttsTicketState.breakdown=fBdEl.value;
  if(fStatusEl) _mttsTicketState.status=fStatusEl.value;
  if(fAssignEl) _mttsTicketState.assigned=fAssignEl.value;
  if(fSearchEl) _mttsTicketState.search=fSearchEl.value;
  var activeId=document.activeElement&&document.activeElement.id;
  var caretStart=null,caretEnd=null;
  if(activeId==='mttsTicketSearch'&&fSearchEl){
    try{caretStart=fSearchEl.selectionStart;caretEnd=fSearchEl.selectionEnd;}catch(e){}
  }

  var scope=(document.getElementById('mttsTicketScope')||{}).value||'all';
  var fStatus=_mttsTicketState.status||'';
  var fPlant=_mttsTicketState.plant||'';
  var fBd=_mttsTicketState.breakdown||'';
  var fAssign=_mttsTicketState.assigned||'';
  var fSearch=(_mttsTicketState.search||'').toLowerCase().trim();
  var meKey=CU?(CU.name||CU.id):'';

  var rows=(DB.mttsTickets||[]).filter(function(t){
    if(!t) return false;
    if(scope==='mine'&&!_mttsIsTechnicianOnTicket(t)) return false;
    if(scope==='raised'&&t.raisedBy!==meKey) return false;
    if(scope==='pending_alloc'&&t.status!=='open') return false;
    if(scope==='pending_approval'&&t.status!=='repair_done') return false;
    if(fStatus&&t.status!==fStatus) return false;
    if(fPlant&&t.plant!==fPlant) return false;
    if(fBd&&t.breakdownType!==fBd) return false;
    if(fAssign){
      var assignedCount=(t.assignedTo||[]).length;
      if(fAssign==='unassigned'&&assignedCount>0) return false;
      else if(fAssign==='assigned'&&assignedCount===0) return false;
      else if(fAssign!=='unassigned'&&fAssign!=='assigned'){
        // Specific technician filter
        if((t.assignedTo||[]).indexOf(fAssign)<0) return false;
      }
    }
    if(fSearch){
      var asset=byId(DB.mttsAssets||[],t.assetCode);
      var hay=((asset&&asset.name)||'')+' '+((asset&&asset.serialNo)||'')+' '+(t.assetCode||'')+' '+_mttsPlantLabel(t.plant);
      if(hay.toLowerCase().indexOf(fSearch)<0) return false;
    }
    return true;
  });
  // Always sort by raisedAt descending (most recent first).
  rows.sort(function(a,b){return (b.raisedAt||'').localeCompare(a.raisedAt||'');});

  // Tab label — reflect scope so the user knows what they're viewing.
  var tabLbl=document.getElementById('mttsTicketTabLbl');
  if(tabLbl){
    var lblMap={all:'All Tickets',mine:'My Queue (Technician)',raised:'Raised by me',pending_alloc:'Pending Allocation',pending_approval:'Pending Approval'};
    tabLbl.textContent=lblMap[scope]||'Tickets';
  }

  // Summary
  var sumEl=document.getElementById('mttsTicketSummary');
  if(sumEl){
    var counts={open:0,assigned:0,awaiting_spares:0,awaiting_agency:0,repair_done:0,closed:0,scrapped:0};
    (DB.mttsTickets||[]).forEach(function(t){if(t&&counts.hasOwnProperty(t.status)) counts[t.status]++;});
    sumEl.innerHTML='Total: <b>'+(DB.mttsTickets||[]).length+'</b> · Showing: <b>'+rows.length+'</b> · '+
      Object.keys(counts).map(function(k){return _MTTS_STATUS_LABEL[k]+': <b>'+counts[k]+'</b>';}).join(' · ');
  }

  // Build inline filter dropdown options (column-aligned, kept as part of thead).
  var plantsList=_mttsPlantList(false);
  var plantOpts='<option value="">All plants</option>'+plantsList.map(function(p){return '<option value="'+p.value+'"'+(fPlant===p.value?' selected':'')+'>'+p.label+'</option>';}).join('');
  var bdOpts='<option value="">All</option>'+Object.keys(_MTTS_BREAKDOWN_LABEL).map(function(k){return '<option value="'+k+'"'+(fBd===k?' selected':'')+'>'+_MTTS_BREAKDOWN_LABEL[k]+'</option>';}).join('');
  var statusKeys=['open','assigned','awaiting_spares','awaiting_agency','repair_done','closed','scrapped'];
  var statusOpts='<option value="">All statuses</option>'+statusKeys.map(function(k){return '<option value="'+k+'"'+(fStatus===k?' selected':'')+'>'+(_MTTS_STATUS_LABEL[k]||k)+'</option>';}).join('');
  // Assigned filter — All / Unassigned / Assigned + each technician name.
  var techsList=(typeof _mttsTechnicians==='function')?_mttsTechnicians():[];
  var techOpts=techsList.map(function(u){
    var key=u.name||u.id;
    var disp=(u.fullName||u.name||u.id);
    return '<option value="'+String(key).replace(/"/g,'&quot;')+'"'+(fAssign===key?' selected':'')+'>'+disp+'</option>';
  }).join('');
  var assignOpts='<option value="">All</option>'+
    '<option value="unassigned"'+(fAssign==='unassigned'?' selected':'')+'>Unassigned</option>'+
    '<option value="assigned"'+(fAssign==='assigned'?' selected':'')+'>Any assigned</option>'+
    (techOpts?'<option disabled>—— Technicians ——</option>'+techOpts:'');
  var inlineSearchVal=(_mttsTicketState.search||'').replace(/"/g,'&quot;');

  var critClr={High:'#dc2626',Medium:'#f59e0b',Low:'#16a34a'};
  var plantLbl=function(v){return _mttsPlantLabel(v);};
  var inlineSel='font-size:13px;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:#fff;color:var(--text);width:100%;min-width:0';
  var thFilter='padding:5px 6px;background:#f8fafc;border-bottom:1px solid var(--border);text-align:left;position:sticky;top:0;z-index:3';
  var th='padding:8px 12px;font-size:13px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;position:sticky;top:38px;z-index:2';
  var td='padding:8px 12px;font-size:14px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var emptyRow=rows.length?'':'<tr><td colspan="10" style="padding:30px 20px;text-align:center;color:var(--text3);font-size:15px">No tickets match the current filters.</td></tr>';
  var html='<div style="overflow:auto;border:1.5px solid var(--border);border-radius:8px;background:#fff;max-height:calc(100vh - 240px)">'+
    '<table style="width:100%;border-collapse:collapse;font-size:14px"><thead>'+
      // FILTER ROW — column-aligned, sticky above header row.
      '<tr>'+
        '<th style="'+thFilter+'"></th>'+
        '<th style="'+thFilter+'"><select id="mttsTicketPlantFilter" onchange="_mttsRenderTickets()" style="'+inlineSel+'">'+plantOpts+'</select></th>'+
        '<th style="'+thFilter+'"><input type="search" id="mttsTicketSearch" placeholder="🔍 asset / serial / plant…" oninput="_mttsRenderTickets()" value="'+inlineSearchVal+'" style="'+inlineSel+'"></th>'+
        '<th style="'+thFilter+'"><select id="mttsTicketBreakdownFilter" onchange="_mttsRenderTickets()" style="'+inlineSel+'">'+bdOpts+'</select></th>'+
        '<th style="'+thFilter+'"></th>'+
        '<th style="'+thFilter+'"></th>'+
        '<th style="'+thFilter+'"></th>'+
        '<th style="'+thFilter+'"><select id="mttsTicketAssignedFilter" onchange="_mttsRenderTickets()" style="'+inlineSel+'">'+assignOpts+'</select></th>'+
        '<th style="'+thFilter+'"><select id="mttsTicketStatusFilter" onchange="_mttsRenderTickets()" style="'+inlineSel+'">'+statusOpts+'</select></th>'+
        '<th style="'+thFilter+'"></th>'+
      '</tr>'+
      // HEADER ROW
      '<tr>'+
        '<th style="'+th+'">#</th>'+
        '<th style="'+th+'">Plant</th>'+
        '<th style="'+th+'">Asset</th>'+
        '<th style="'+th+'">Breakdown</th>'+
        '<th style="'+th+'">Priority</th>'+
        '<th style="'+th+'">Raised</th>'+
        '<th style="'+th+'">Down for</th>'+
        '<th style="'+th+'">Assigned</th>'+
        '<th style="'+th+'">Status</th>'+
        '<th style="'+th+';text-align:center">Action</th>'+
      '</tr></thead><tbody>'+emptyRow;
  rows.forEach(function(t,i){
    var asset=byId(DB.mttsAssets||[],t.assetCode);
    var assetName=asset?asset.name:(t.assetCode||'(missing)');
    var assetType=asset?asset.assetType:'';
    var crit=asset?asset.criticality:'Medium';
    var techList=(t.assignedTo||[]).map(function(u){return _mttsUserDisp(u);}).join(', ')||'—';
    var idEsc=String(t.id||'').replace(/'/g,"\\'");
    var raised=t.raisedAt?t.raisedAt.slice(0,10):'—';
    var raiser=t.raisedBy?_mttsUserDisp(t.raisedBy):'';
    // Action buttons by role / status.
    var act='';
    if(t.status==='open'&&_mttsCanAllocate()){
      act='<button onclick="_mttsTicketAllocateOpen(\''+idEsc+'\')" style="font-size:12px;padding:4px 10px;font-weight:700;background:#0ea5e9;color:#fff;border:none;border-radius:4px;cursor:pointer">👥 Allocate</button>';
    } else if((t.status==='assigned'||t.status==='awaiting_spares'||t.status==='awaiting_agency')&&(_mttsIsTechnicianOnTicket(t)||_mttsIsSA()||_mttsIsManager())){
      act='<button onclick="_mttsTicketActionOpen(\''+idEsc+'\')" style="font-size:12px;padding:4px 10px;font-weight:700;background:#16a34a;color:#fff;border:none;border-radius:4px;cursor:pointer">🔧 Update</button>';
    } else if(t.status==='repair_done'&&_mttsCanApprove()){
      act='<button onclick="_mttsTicketApproveOpen(\''+idEsc+'\')" style="font-size:12px;padding:4px 10px;font-weight:700;background:#16a34a;color:#fff;border:none;border-radius:4px;cursor:pointer">✓ Approve</button>';
    }
    // Manager can reassign technicians on any non-scrapped ticket — even
    // closed ones — which lets them re-open work after approval. Opens
    // the allocation modal which also exposes a Revoke (back to open)
    // action.
    if((t.status==='assigned'||t.status==='awaiting_spares'||t.status==='awaiting_agency'||t.status==='repair_done'||t.status==='closed')&&_mttsCanAllocate()){
      act+='<button onclick="_mttsTicketAllocateOpen(\''+idEsc+'\')" title="Reassign technicians" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid #0ea5e9;color:#0369a1;border-radius:4px;cursor:pointer;margin-left:3px">👥 Reassign</button>';
    }
    // Closed tickets — manager can revoke the approval, dropping the
    // status back to repair_done so it can be edited / costs revised.
    if(t.status==='closed'&&_mttsCanApprove()){
      act+='<button onclick="_mttsTicketRevokeApproval(\''+idEsc+'\')" title="Revoke approval — back to Repair done" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid #f59e0b;color:#92400e;border-radius:4px;cursor:pointer;margin-left:3px">↩ Revoke ✓</button>';
    }
    act+='<button onclick="_mttsTicketDetail(\''+idEsc+'\')" title="View details" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer;margin-left:3px">👁</button>';
    html+='<tr>'+
      '<td style="'+td+';color:var(--text3);font-family:var(--mono);font-size:12px">'+(t.id||'').slice(-6)+'</td>'+
      '<td style="'+td+'">'+_mttsPlantBadge(t.plant)+'</td>'+
      '<td style="'+td+'"><div style="font-weight:800">'+assetName+'</div>'+
        (assetType?'<div style="font-size:12px;color:var(--text3)">'+assetType+'</div>':'')+'</td>'+
      '<td style="'+td+'">'+(_MTTS_BREAKDOWN_LABEL[t.breakdownType]||t.breakdownType||'—')+'</td>'+
      '<td style="'+td+'"><span style="display:inline-block;padding:2px 8px;border-radius:8px;font-size:11px;font-weight:800;background:'+critClr[crit]+'22;color:'+critClr[crit]+'">'+crit+'</span></td>'+
      '<td style="'+td+';font-family:var(--mono);font-size:12px">'+raised+(raiser?'<div style="color:var(--text3)">'+raiser+'</div>':'')+'</td>'+
      '<td style="'+td+';font-family:var(--mono);font-size:12px;color:'+(t.status==='closed'||t.status==='scrapped'?'var(--text3)':'#dc2626')+';font-weight:700">'+
        ((t.status==='closed'||t.status==='scrapped')?'—':_mttsTimerSince(t.breakdownSince||t.raisedAt))+'</td>'+
      '<td style="'+td+';font-size:13px">'+techList+'</td>'+
      '<td style="'+td+'">'+_mttsStatusBadge(t.status)+'</td>'+
      '<td style="'+td+';text-align:center;white-space:nowrap">'+act+'</td>'+
    '</tr>';
  });
  html+='</tbody></table></div>';
  wrap.innerHTML=html;
  // Restore focus + caret on the filter row's currently-edited input so
  // typing in the search box doesn't lose the cursor on every keystroke.
  if(activeId){
    var newActive=document.getElementById(activeId);
    if(newActive&&typeof newActive.focus==='function'){
      newActive.focus();
      if(activeId==='mttsTicketSearch'&&caretStart!=null){
        try{newActive.setSelectionRange(caretStart,caretEnd!=null?caretEnd:caretStart);}catch(e){}
      }
    }
  }
  // Refresh sidebar count badge
  _mttsUpdateTicketBadge();
}

function _mttsUpdateTicketBadge(){
  var nav=document.getElementById('cMttsTickets');if(!nav) return;
  var meKey=CU?(CU.name||CU.id):'';
  var n=0;
  (DB.mttsTickets||[]).forEach(function(t){
    if(!t) return;
    if(_mttsIsSA()||_mttsIsManager()){
      if(t.status==='open'||t.status==='repair_done') n++;
    } else if((CU&&(CU.mttsRoles||[]).indexOf('Technician')>=0)){
      if((t.status==='assigned'||t.status==='awaiting_spares'||t.status==='awaiting_agency')&&_mttsIsTechnicianOnTicket(t)) n++;
    } else {
      // Ticket Raiser: show their own pending tickets.
      if(t.raisedBy===meKey&&t.status!=='closed'&&t.status!=='scrapped') n++;
    }
  });
  nav.textContent=n;nav.style.display=n?'':'none';
}

// ── Photo helpers (compress + preview) ────────────────────────────────────
var _mttsRaisePhotosBuf=[];
var _mttsTechActPhotosBuf=[];
var _mttsApprovePhotosBuf=[];

function _mttsRenderPhotoStrip(targetId,buf,onRemove){
  var el=document.getElementById(targetId);if(!el) return;
  // Bigger thumbnails on touch — easier to inspect what was captured.
  var isMobile=window.innerWidth<=640;
  var sz=isMobile?96:72;
  el.innerHTML=buf.map(function(src,idx){
    return '<div style="position:relative;width:'+sz+'px;height:'+sz+'px;border:1px solid var(--border);border-radius:8px;overflow:hidden">'+
      '<img src="'+src+'" style="width:100%;height:100%;object-fit:cover">'+
      '<button onclick="'+onRemove+'('+idx+')" title="Remove" style="position:absolute;top:2px;right:2px;width:24px;height:24px;padding:0;font-size:14px;font-weight:900;background:rgba(0,0,0,.7);color:#fff;border:none;border-radius:50%;cursor:pointer;line-height:1">×</button>'+
    '</div>';
  }).join('');
}

async function _mttsCompressFiles(files,maxKB){
  var out=[];
  for(var i=0;i<files.length;i++){
    try{var d=await compressImage(files[i],maxKB||100);if(d) out.push(d);}catch(e){}
  }
  return out;
}

// Generic photo-tile renderer: 3 fixed square slots. Empty slots act as a
// "Take photo" button (taps the underlying file input → opens camera);
// filled slots show the thumbnail with a × remove button. All callers keep
// the buffer at ≤3 entries and compress every captured file to ~100KB
// before storing the data URL — see _mttsCompressFiles below.
function _mttsRenderPhotoTiles(targetId,buf,removeFnName,fileInputId){
  var el=document.getElementById(targetId);if(!el) return;
  el.classList.add('mtts-photo-thumbs');
  var slots=[];
  for(var i=0;i<3;i++){
    if(buf[i]){
      slots.push('<div class="mtts-photo-tile has-img">'+
        '<img src="'+buf[i]+'">'+
        '<button type="button" class="mtts-photo-rm" onclick="'+removeFnName+'('+i+')" title="Remove">×</button>'+
      '</div>');
    } else {
      slots.push('<div class="mtts-photo-tile" onclick="document.getElementById(\''+fileInputId+'\').click()">'+
        '<span class="mtts-photo-cam">📷</span><span>Take photo</span>'+
      '</div>');
    }
  }
  el.innerHTML=slots.join('');
}

function _mttsRenderRaisePhotoTiles(){
  _mttsRenderPhotoTiles('mttsRaisePhotoPreview',_mttsRaisePhotosBuf,'_mttsRaiseRemovePhoto','mttsRaisePhotos');
}
function _mttsRaisePickPhotos(ev){
  var files=Array.from(ev.target.files||[]);
  ev.target.value='';
  if(!files.length) return;
  _mttsCompressFiles(files,100).then(function(arr){
    arr.forEach(function(d){if(_mttsRaisePhotosBuf.length<3) _mttsRaisePhotosBuf.push(d);});
    if(_mttsRaisePhotosBuf.length>3) _mttsRaisePhotosBuf=_mttsRaisePhotosBuf.slice(0,3);
    _mttsRenderRaisePhotoTiles();
  });
}
function _mttsRaiseRemovePhoto(i){_mttsRaisePhotosBuf.splice(i,1);_mttsRenderRaisePhotoTiles();}

function _mttsRenderTechActPhotoTiles(){
  _mttsRenderPhotoTiles('mttsTechActPhotoPreview',_mttsTechActPhotosBuf,'_mttsTechActRemovePhoto','mttsTechActPhotos');
}
function _mttsTechActPickPhotos(ev){
  var files=Array.from(ev.target.files||[]);
  ev.target.value='';
  if(!files.length) return;
  _mttsCompressFiles(files,100).then(function(arr){
    arr.forEach(function(d){if(_mttsTechActPhotosBuf.length<3) _mttsTechActPhotosBuf.push(d);});
    if(_mttsTechActPhotosBuf.length>3) _mttsTechActPhotosBuf=_mttsTechActPhotosBuf.slice(0,3);
    _mttsRenderTechActPhotoTiles();
  });
}
function _mttsTechActRemovePhoto(i){_mttsTechActPhotosBuf.splice(i,1);_mttsRenderTechActPhotoTiles();}

function _mttsRenderApprovePhotoTiles(){
  _mttsRenderPhotoTiles('mttsApprovePhotoPreview',_mttsApprovePhotosBuf,'_mttsApproveRemovePhoto','mttsApprovePhotos');
}
function _mttsApprovePickPhotos(ev){
  var files=Array.from(ev.target.files||[]);
  ev.target.value='';
  if(!files.length) return;
  _mttsCompressFiles(files,100).then(function(arr){
    arr.forEach(function(d){if(_mttsApprovePhotosBuf.length<3) _mttsApprovePhotosBuf.push(d);});
    if(_mttsApprovePhotosBuf.length>3) _mttsApprovePhotosBuf=_mttsApprovePhotosBuf.slice(0,3);
    _mttsRenderApprovePhotoTiles();
  });
}
function _mttsApproveRemovePhoto(i){_mttsApprovePhotosBuf.splice(i,1);_mttsRenderApprovePhotoTiles();}

// ── Raise ticket flow ─────────────────────────────────────────────────────
// Snap any HH:MM string to the nearest 30-minute multiple (rounds down).
function _mttsSnapTo30(timeStr){
  if(!timeStr||!/^\d{1,2}:\d{2}$/.test(timeStr)) return timeStr||'';
  var parts=timeStr.split(':');
  var h=parseInt(parts[0],10)||0;
  var m=parseInt(parts[1],10)||0;
  m=Math.floor(m/30)*30;
  var pad=function(n){return n<10?'0'+n:''+n;};
  return pad(h)+':'+pad(m);
}

// Today (local) as YYYY-MM-DD — used to clamp date stepper to non-future.
function _mttsTodayStr(){
  var d=new Date();
  var pad=function(n){return n<10?'0'+n:''+n;};
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
}

// Build 96 options (00:00 → 23:45) at 15-minute intervals for the
// breakdown-time select. Slots in the future (when the date is today)
// are disabled so the user can't pick a time after now.
function _mttsPopulateBdTimeOptions(){
  var sel=document.getElementById('mttsRaiseBdTime');if(!sel) return;
  var pad=function(n){return n<10?'0'+n:''+n;};
  var dateEl=document.getElementById('mttsRaiseBdDate');
  var dateStr=dateEl?dateEl.value:'';
  var isToday=(dateStr===_mttsTodayStr());
  var nowMins=isToday?(new Date().getHours()*60+new Date().getMinutes()):null;
  var prev=sel.value;
  var html='';
  for(var h=0;h<24;h++){
    for(var m=0;m<60;m+=15){
      var v=pad(h)+':'+pad(m);
      var disabled=(isToday&&(h*60+m)>nowMins)?' disabled':'';
      html+='<option value="'+v+'"'+disabled+'>'+v+'</option>';
    }
  }
  sel.innerHTML=html;
  // Re-apply prior selection if still valid.
  if(prev) sel.value=prev;
}

// Move the breakdown time by ±15 minutes. If the underlying date is
// today, refuses to step into the future. Wraps midnight by stepping
// the date as well (forward or back) so the user can scrub freely.
function _mttsRaiseShiftTime(deltaMin){
  var sel=document.getElementById('mttsRaiseBdTime');
  var dateEl=document.getElementById('mttsRaiseBdDate');
  if(!sel||!dateEl||!sel.value||!dateEl.value) return;
  var d=new Date(dateEl.value+'T'+sel.value+':00');
  d.setMinutes(d.getMinutes()+deltaMin);
  if(d.getTime()>Date.now()) return;
  var pad=function(n){return n<10?'0'+n:''+n;};
  var newDate=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  var newTime=pad(d.getHours())+':'+pad(d.getMinutes());
  if(newDate!==dateEl.value){
    dateEl.value=newDate;
    _mttsRaiseRefreshDateNextBtn();
  }
  _mttsPopulateBdTimeOptions();
  sel.value=newTime;
  _mttsRaiseRefreshTimeNextBtn();
}

// Disable the › time button when the current selection is at "now"
// (no future slot available). Always-enabled when the date is in the past.
function _mttsRaiseRefreshTimeNextBtn(){
  var btn=document.getElementById('mttsRaiseTimeNextBtn');if(!btn) return;
  var sel=document.getElementById('mttsRaiseBdTime');
  var dateEl=document.getElementById('mttsRaiseBdDate');
  if(!sel||!dateEl||!sel.value||!dateEl.value){btn.disabled=false;return;}
  var d=new Date(dateEl.value+'T'+sel.value+':00');
  d.setMinutes(d.getMinutes()+15);
  btn.disabled=(d.getTime()>Date.now());
}

// Called when the user picks a time from the select directly. Clamps to
// the past if somehow set into the future, then refreshes the › button.
function _mttsRaiseTimeChanged(){
  var sel=document.getElementById('mttsRaiseBdTime');
  var dateEl=document.getElementById('mttsRaiseBdDate');
  if(!sel||!dateEl||!sel.value||!dateEl.value) return;
  var d=new Date(dateEl.value+'T'+sel.value+':00');
  if(d.getTime()>Date.now()){
    // Snap to nearest past 15-min boundary.
    var now=new Date();
    now.setMinutes(Math.floor(now.getMinutes()/15)*15,0,0);
    var pad=function(n){return n<10?'0'+n:''+n;};
    sel.value=pad(now.getHours())+':'+pad(now.getMinutes());
  }
  _mttsRaiseRefreshTimeNextBtn();
}

// Shift the breakdown date by N days, clamped to today (no future dates).
// Refreshes the next-button enabled state after the change.
function _mttsRaiseShiftDate(delta){
  var dateEl=document.getElementById('mttsRaiseBdDate');if(!dateEl) return;
  var cur=dateEl.value||_mttsTodayStr();
  var d=new Date(cur+'T00:00:00');
  d.setDate(d.getDate()+delta);
  var pad=function(n){return n<10?'0'+n:''+n;};
  var nextStr=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  // Block any move into the future.
  if(nextStr>_mttsTodayStr()) return;
  dateEl.value=nextStr;
  _mttsRaiseRefreshDateNextBtn();
}

function _mttsRaiseRefreshDateNextBtn(){
  var btn=document.getElementById('mttsRaiseDateNextBtn');if(!btn) return;
  var dateEl=document.getElementById('mttsRaiseBdDate');if(!dateEl) return;
  btn.disabled=(dateEl.value>=_mttsTodayStr());
}

function _mttsTicketRaiseOpen(){
  if(!_mttsCanRaise()){notify('You do not have permission to raise tickets',true);return;}
  _mttsRaisePhotosBuf=[];
  _mttsRenderRaisePhotoTiles();
  // Reset form. Default plant = the user's home plant when set, so a
  // technician on the floor can raise without picking from the list.
  var plantHidden=document.getElementById('mttsRaisePlant');
  plantHidden.value='';
  var plants=_mttsPlantList(false);
  if(CU&&CU.plant&&plants.some(function(p){return p.value===CU.plant;})){
    plantHidden.value=CU.plant;
  }
  _mttsRaiseRenderPlantBtns();
  // Default Asset Type to "Machinery" when present (legacy seed).
  var typeHidden=document.getElementById('mttsRaiseType');
  typeHidden.value='';
  var typesArr=_mttsAssetTypeList(false);
  if(typesArr.some(function(t){return t.value==='Machinery';})) typeHidden.value='Machinery';
  _mttsRaiseRenderTypeBtns();
  // If we defaulted a plant, refresh the asset list for it immediately.
  if(plantHidden.value){_mttsRaiseRefreshAssets();}
  else {document.getElementById('mttsRaiseAsset').innerHTML='<option value="">— Select plant first —</option>';}
  // Clear breakdown radio selection.
  Array.prototype.forEach.call(document.querySelectorAll('input[name="mttsRaiseBreakdown"]'),function(r){r.checked=false;});
  // Default Breakdown Since to current local date and time, rounded down
  // to the nearest 15-minute multiple (matches the time-select's options).
  var _now=new Date();
  _now.setMinutes(Math.floor(_now.getMinutes()/15)*15,0,0);
  var _pad=function(n){return n<10?'0'+n:''+n;};
  var _dStr=_now.getFullYear()+'-'+_pad(_now.getMonth()+1)+'-'+_pad(_now.getDate());
  var _tStr=_pad(_now.getHours())+':'+_pad(_now.getMinutes());
  var _bdDate=document.getElementById('mttsRaiseBdDate');
  if(_bdDate){
    _bdDate.value=_dStr;
    // Native date picker: prevent picking a future date.
    _bdDate.max=_mttsTodayStr();
    // Refresh the next-day button whenever the user types/picks a date.
    if(!_bdDate._mttsDateChange){
      _bdDate._mttsDateChange=function(){
        // Clamp typed values that fell into the future back to today.
        if(_bdDate.value&&_bdDate.value>_mttsTodayStr()) _bdDate.value=_mttsTodayStr();
        _mttsRaiseRefreshDateNextBtn();
        // Re-populate time slots so future slots get re-disabled when
        // jumping back to today's date.
        _mttsPopulateBdTimeOptions();
        _mttsRaiseRefreshTimeNextBtn();
      };
      _bdDate.addEventListener('change',_bdDate._mttsDateChange);
    }
  }
  // (Re)populate the 15-min time slots and select the rounded current value.
  _mttsPopulateBdTimeOptions();
  var _bdTime=document.getElementById('mttsRaiseBdTime');
  if(_bdTime) _bdTime.value=_tStr;
  _mttsRaiseRefreshDateNextBtn();
  _mttsRaiseRefreshTimeNextBtn();
  document.getElementById('mttsRaiseDesc').value='';
  document.getElementById('mttsRaisePhotos').value='';
  var err=document.getElementById('mttsRaiseErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsRaise'); else { document.getElementById('mMttsRaise').classList.add('open'); }
  // Enter saves / Escape cancels (Enter inside textarea inserts newline as
  // expected). Listener is rebound on every open so closed-state keys
  // don't fire stale handlers.
  var modalEl=document.getElementById('mMttsRaise');
  if(modalEl){
    if(modalEl._mttsKeyHandler) modalEl.removeEventListener('keydown',modalEl._mttsKeyHandler);
    modalEl._mttsKeyHandler=function(ev){
      if(modalEl.style.display==='none'||!modalEl.classList.contains('open')) return;
      if(ev.key==='Escape'){ev.preventDefault();cm('mMttsRaise');return;}
      if(ev.key==='Enter'){
        var tag=ev.target&&ev.target.tagName;
        if(tag==='TEXTAREA') return;
        ev.preventDefault();_mttsTicketRaiseSubmit();
      }
    };
    modalEl.addEventListener('keydown',modalEl._mttsKeyHandler);
  }
}
// Render the Plant chip row from the master list. Each chip is a tap
// target that sets the hidden input + refreshes the asset dropdown.
function _mttsRaiseRenderPlantBtns(){
  var wrap=document.getElementById('mttsRaisePlantBtns');if(!wrap) return;
  var hidden=document.getElementById('mttsRaisePlant');
  var current=hidden?hidden.value:'';
  var plants=_mttsPlantList(false);
  if(!plants.length){
    wrap.innerHTML='<div style="font-size:11px;color:var(--text3);font-style:italic;padding:4px 0">No plants — add one in Plant Master first</div>';
    return;
  }
  wrap.innerHTML=plants.map(function(p){
    var idEsc=String(p.value).replace(/'/g,"\\'").replace(/"/g,'&quot;');
    var lblEsc=String(p.label).replace(/</g,'&lt;');
    var swatch=p.color?'<span class="mtts-chip-swatch" style="background:'+p.color+'"></span>':'';
    var act=p.value===current?' is-active':'';
    return '<button type="button" class="mtts-chip'+act+'" onclick="_mttsRaisePickPlant(\''+idEsc+'\')" title="'+lblEsc+'">'+swatch+'<span>'+(p.value||'?')+'</span></button>';
  }).join('');
}
function _mttsRaisePickPlant(code){
  var hidden=document.getElementById('mttsRaisePlant');
  if(hidden) hidden.value=code;
  _mttsRaiseRenderPlantBtns();
  _mttsRaiseRefreshAssets();
}

// Render the Asset Type chip row. "All" comes first (clears type filter).
function _mttsRaiseRenderTypeBtns(){
  var wrap=document.getElementById('mttsRaiseTypeBtns');if(!wrap) return;
  var hidden=document.getElementById('mttsRaiseType');
  var current=hidden?hidden.value:'';
  var typesArr=_mttsAssetTypeList(false);
  var html='<button type="button" class="mtts-chip'+(current===''?' is-active':'')+'" onclick="_mttsRaisePickType(\'\')">All</button>';
  html+=typesArr.map(function(t){
    var idEsc=String(t.value).replace(/'/g,"\\'").replace(/"/g,'&quot;');
    var lblEsc=String(t.label).replace(/</g,'&lt;');
    var act=t.value===current?' is-active':'';
    return '<button type="button" class="mtts-chip'+act+'" onclick="_mttsRaisePickType(\''+idEsc+'\')">'+lblEsc+'</button>';
  }).join('');
  wrap.innerHTML=html;
}
function _mttsRaisePickType(code){
  var hidden=document.getElementById('mttsRaiseType');
  if(hidden) hidden.value=code;
  _mttsRaiseRenderTypeBtns();
  _mttsRaiseRefreshAssets();
}

// ── Asset edit modal — chip pickers for Plant / Asset Type / Priority ───
function _mttsAssetRenderPlantBtns(){
  var wrap=document.getElementById('mttsAssetPlantBtns');if(!wrap) return;
  var hidden=document.getElementById('mttsAssetPlant');
  var current=hidden?hidden.value:'';
  var plants=_mttsPlantList(true);
  if(!plants.length){
    wrap.innerHTML='<div style="font-size:11px;color:var(--text3);font-style:italic;padding:4px 0">No plants — add one in Plant Master first</div>';
    return;
  }
  wrap.innerHTML=plants.map(function(p){
    var idEsc=String(p.value).replace(/'/g,"\\'").replace(/"/g,'&quot;');
    var lblEsc=String(p.label).replace(/</g,'&lt;');
    var swatch=p.color?'<span class="mtts-chip-swatch" style="background:'+p.color+'"></span>':'';
    var act=p.value===current?' is-active':'';
    return '<button type="button" class="mtts-chip'+act+'" onclick="_mttsAssetPickPlant(\''+idEsc+'\')" title="'+lblEsc+'">'+swatch+'<span>'+(p.value||'?')+'</span></button>';
  }).join('');
}
function _mttsAssetPickPlant(code){
  var hidden=document.getElementById('mttsAssetPlant');
  if(hidden) hidden.value=code;
  _mttsAssetRenderPlantBtns();
}

function _mttsAssetRenderTypeBtns(){
  var wrap=document.getElementById('mttsAssetTypeBtns');if(!wrap) return;
  var hidden=document.getElementById('mttsAssetType');
  var current=hidden?hidden.value:'';
  var typesArr=_mttsAssetTypeList(true);
  if(!typesArr.length){
    wrap.innerHTML='<div style="font-size:11px;color:var(--text3);font-style:italic;padding:4px 0">No asset types — add one in Asset Type Master first</div>';
    return;
  }
  wrap.innerHTML=typesArr.map(function(t){
    var idEsc=String(t.value).replace(/'/g,"\\'").replace(/"/g,'&quot;');
    var lblEsc=String(t.label).replace(/</g,'&lt;');
    var act=t.value===current?' is-active':'';
    return '<button type="button" class="mtts-chip'+act+'" onclick="_mttsAssetPickType(\''+idEsc+'\')">'+lblEsc+'</button>';
  }).join('');
}
function _mttsAssetPickType(code){
  var hidden=document.getElementById('mttsAssetType');
  if(hidden) hidden.value=code;
  _mttsAssetRenderTypeBtns();
  // Primary name list is type-scoped — refresh when type changes.
  _mttsPopulateAssetPrimaryNameOptions();
}

function _mttsAssetRenderCritBtns(){
  var wrap=document.getElementById('mttsAssetCritBtns');if(!wrap) return;
  var hidden=document.getElementById('mttsAssetCrit');
  var current=(hidden&&hidden.value)||'Medium';
  var opts=[{v:'High',c:'#dc2626'},{v:'Medium',c:'#f59e0b'},{v:'Low',c:'#16a34a'}];
  wrap.innerHTML=opts.map(function(o){
    var act=o.v===current?' is-active':'';
    var style=o.v===current?'background:'+o.c+';border-color:'+o.c+';color:#fff':'';
    return '<button type="button" class="mtts-chip'+act+'" onclick="_mttsAssetPickCrit(\''+o.v+'\')" style="'+style+'">'+o.v+'</button>';
  }).join('');
}
function _mttsAssetPickCrit(v){
  var hidden=document.getElementById('mttsAssetCrit');
  if(hidden) hidden.value=v;
  _mttsAssetRenderCritBtns();
}

function _mttsRaiseRefreshAssets(){
  var plant=document.getElementById('mttsRaisePlant').value;
  var type=document.getElementById('mttsRaiseType').value;
  var sel=document.getElementById('mttsRaiseAsset');
  if(!plant){sel.innerHTML='<option value="">— Select plant first —</option>';return;}
  var assets=(DB.mttsAssets||[]).filter(function(a){
    if(!a||a.status==='Scrap') return false;
    if(a.plant!==plant) return false;
    if(type&&a.assetType!==type) return false;
    return true;
  }).sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});
  if(!assets.length){sel.innerHTML='<option value="">No assets at this plant</option>';return;}
  sel.innerHTML='<option value="">— Select asset —</option>'+assets.map(function(a){
    return '<option value="'+a.id+'">'+(a.name||'')+(a.serialNo?' · SN '+a.serialNo:'')+'</option>';
  }).join('');
}
async function _mttsTicketRaiseSubmit(){
  if(!_mttsCanRaise()){notify('Access denied',true);return;}
  var err=document.getElementById('mttsRaiseErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var plant=document.getElementById('mttsRaisePlant').value;
  var assetCode=document.getElementById('mttsRaiseAsset').value;
  var bdRadio=document.querySelector('input[name="mttsRaiseBreakdown"]:checked');
  var bd=bdRadio?bdRadio.value:'';
  var bdDate=document.getElementById('mttsRaiseBdDate').value;
  // Time comes from a 30-min interval select, so it's already snapped.
  var _bdTimeEl=document.getElementById('mttsRaiseBdTime');
  var bdTime=_bdTimeEl?_bdTimeEl.value:'';
  var desc=document.getElementById('mttsRaiseDesc').value.trim();
  if(!plant){_showErr('Plant is required');return;}
  if(!assetCode){_showErr('Asset is required');return;}
  if(!bd){_showErr('Breakdown type is required');return;}
  if(!bdDate){_showErr('Breakdown Since date is required');return;}
  if(!bdTime){_showErr('Breakdown Since time is required');return;}
  if(!desc){_showErr('Description / Symptoms is required');return;}
  var bdSinceLocal=bdDate+'T'+bdTime;
  var bdSinceISO=new Date(bdSinceLocal).toISOString();
  if(new Date(bdSinceISO).getTime()>Date.now()){_showErr('Breakdown Since cannot be in the future');return;}
  var ticket={
    id:'t'+uid(),
    assetCode:assetCode,plant:plant,breakdownType:bd,
    breakdownSince:bdSinceISO,
    status:'open',
    raisedBy:CU?(CU.name||CU.id||''):'',
    raisedAt:new Date().toISOString(),
    photosRaise:_mttsRaisePhotosBuf.slice(),
    assignedTo:[],assignedAt:'',assignedBy:'',
    techActions:[{action:'raised',by:CU?(CU.name||CU.id||''):'',at:new Date().toISOString(),note:desc||''}],
    closePhotos:[],rootCause:'',
    costService:0,costSpares:0,invoicePhotos:[],
    approvedBy:'',approvedAt:''
  };
  if(!DB.mttsTickets) DB.mttsTickets=[];
  DB.mttsTickets.push(ticket);
  var ok=await _dbSave('mttsTickets',ticket);
  if(!ok){
    DB.mttsTickets=DB.mttsTickets.filter(function(x){return x!==ticket;});
    _showErr('Save failed');return;
  }
  cm('mMttsRaise');
  notify('🎫 Ticket raised — awaiting allocation');
  _mttsRenderTickets();
}

// ── Allocate flow (manager) ────────────────────────────────────────────────
function _mttsTicketAllocateOpen(id){
  if(!_mttsCanAllocate()){notify('Only Maintenance Manager can allocate',true);return;}
  var t=byId(DB.mttsTickets||[],id);if(!t){notify('Ticket not found',true);return;}
  document.getElementById('mttsAllocTicketId').value=id;
  var asset=byId(DB.mttsAssets||[],t.assetCode);

  document.getElementById('mttsAllocTicketLbl').innerHTML=
    '<b>'+(asset?asset.name:'(missing)')+'</b> at '+_mttsPlantLabel(t.plant)+
    ' · '+(_MTTS_BREAKDOWN_LABEL[t.breakdownType]||'')+' · raised '+(t.raisedAt?t.raisedAt.slice(0,10):'—');
  // Tech checkbox list
  var techs=_mttsTechnicians();
  var pre=t.assignedTo||[];
  var listEl=document.getElementById('mttsAllocTechList');
  if(!techs.length){
    listEl.innerHTML='<div style="padding:10px;font-size:11px;color:var(--text3)">No users with Technician role found. Assign the role to users first via the portal.</div>';
  } else {
    listEl.innerHTML=techs.map(function(u){
      var key=u.name||u.id;
      var checked=pre.indexOf(key)>=0?'checked':'';
      return '<label style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid #f1f5f9;cursor:pointer;font-size:12px"><input type="checkbox" class="mtts-alloc-cb" value="'+key+'" '+checked+' style="width:auto!important;height:auto!important;flex:0 0 auto;margin:0"><span style="flex:1">'+(u.fullName||u.name)+(u.plant?' <span style="color:var(--text3)">· '+u.plant+'</span>':'')+'</span></label>';
    }).join('');
  }
  document.getElementById('mttsAllocNote').value='';
  // Revoke is only meaningful when the ticket is already assigned to
  // someone — clears all assignees and returns to open status.
  var revBtn=document.getElementById('mttsAllocRevokeBtn');
  if(revBtn) revBtn.style.display=(pre&&pre.length)?'inline-flex':'none';
  var err=document.getElementById('mttsAllocErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsAllocate'); else { document.getElementById('mMttsAllocate').classList.add('open'); }
}

async function _mttsTicketAllocateRevoke(){
  if(!_mttsCanAllocate()){notify('Access denied',true);return;}
  var id=document.getElementById('mttsAllocTicketId').value;
  var t=byId(DB.mttsTickets||[],id);if(!t){notify('Ticket not found',true);return;}
  if(!confirm('Revoke assignment for this ticket?\n\nAll '+(t.assignedTo||[]).length+' assigned technician(s) will be removed and the ticket goes back to Open status. Proceed?')) return;
  var bak=Object.assign({},t);
  var note=(document.getElementById('mttsAllocNote').value||'').trim();
  var prev=(t.assignedTo||[]).slice();
  t.assignedTo=[];
  t.status='open';
  t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
  t.techActions.push({action:'revoked',by:CU?(CU.name||CU.id||''):'',at:new Date().toISOString(),note:note,techs:prev});
  var ok=await _dbSave('mttsTickets',t);
  if(!ok){Object.assign(t,bak);notify('Save failed',true);return;}
  cm('mMttsAllocate');
  notify('↩ Assignment revoked — ticket back to Open');
  _mttsRenderTickets();
}

async function _mttsTicketAllocateConfirm(){
  if(!_mttsCanAllocate()){notify('Access denied',true);return;}
  var err=document.getElementById('mttsAllocErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var id=document.getElementById('mttsAllocTicketId').value;
  var t=byId(DB.mttsTickets||[],id);if(!t){_showErr('Ticket not found');return;}
  var picked=Array.from(document.querySelectorAll('.mtts-alloc-cb:checked')).map(function(cb){return cb.value;});
  if(!picked.length){_showErr('Pick at least one technician');return;}
  var note=document.getElementById('mttsAllocNote').value.trim();
  var bak=Object.assign({},t);
  var prevTechs=(t.assignedTo||[]).slice();
  var isReassign=prevTechs.length>0;
  var wasClosed=(t.status==='closed');
  t.assignedTo=picked;
  t.assignedAt=new Date().toISOString();
  t.assignedBy=CU?(CU.name||CU.id||''):'';
  if(wasClosed){
    // Reassigning a previously-closed ticket re-opens it from scratch:
    // status=open, approval cleared, so manager + tech step through the
    // full lifecycle again.
    t.status='open';
    t.approvedBy='';t.approvedAt='';
  } else if(!isReassign||t.status==='open'){
    // First-time allocation, or re-allocation of an open ticket.
    t.status='assigned';
  }
  // Otherwise keep existing in-progress status (assigned / awaiting_*).
  t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
  t.techActions.push({action:isReassign?'reassigned':'allocated',by:t.assignedBy,at:t.assignedAt,note:note,techs:picked,prevTechs:isReassign?prevTechs:undefined});
  var ok=await _dbSave('mttsTickets',t);
  if(!ok){Object.assign(t,bak);_showErr('Save failed');return;}
  cm('mMttsAllocate');
  notify((isReassign?'👥 Reassigned to ':'👥 Allocated to ')+picked.length+' technician(s)');
  _mttsRenderTickets();
}

// 96 slots at 15-min intervals for the Update Ticket time picker.
// Future slots are disabled when the date is today.
function _mttsPopulateTechActTimeOptions(){
  var sel=document.getElementById('mttsTechActTime');if(!sel) return;
  var pad=function(n){return n<10?'0'+n:''+n;};
  var dateEl=document.getElementById('mttsTechActDate');
  var dateStr=dateEl?dateEl.value:'';
  var isToday=(dateStr===_mttsTodayStr());
  var nowMins=isToday?(new Date().getHours()*60+new Date().getMinutes()):null;
  var prev=sel.value;
  var html='';
  for(var h=0;h<24;h++){
    for(var m=0;m<60;m+=15){
      var v=pad(h)+':'+pad(m);
      var disabled=(isToday&&(h*60+m)>nowMins)?' disabled':'';
      html+='<option value="'+v+'"'+disabled+'>'+v+'</option>';
    }
  }
  sel.innerHTML=html;
  if(prev) sel.value=prev;
}

function _mttsTechActShiftDate(delta){
  var dateEl=document.getElementById('mttsTechActDate');if(!dateEl) return;
  var cur=dateEl.value||_mttsTodayStr();
  var d=new Date(cur+'T00:00:00');
  d.setDate(d.getDate()+delta);
  var pad=function(n){return n<10?'0'+n:''+n;};
  var nextStr=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  if(nextStr>_mttsTodayStr()) return;
  dateEl.value=nextStr;
  _mttsPopulateTechActTimeOptions();
  _mttsTechActRefreshDateNextBtn();
  _mttsTechActRefreshTimeNextBtn();
}

function _mttsTechActRefreshDateNextBtn(){
  var btn=document.getElementById('mttsTechActDateNextBtn');if(!btn) return;
  var dateEl=document.getElementById('mttsTechActDate');if(!dateEl) return;
  btn.disabled=(dateEl.value>=_mttsTodayStr());
}

function _mttsTechActShiftTime(deltaMin){
  var sel=document.getElementById('mttsTechActTime');
  var dateEl=document.getElementById('mttsTechActDate');
  if(!sel||!dateEl||!sel.value||!dateEl.value) return;
  var d=new Date(dateEl.value+'T'+sel.value+':00');
  d.setMinutes(d.getMinutes()+deltaMin);
  if(d.getTime()>Date.now()) return;
  var pad=function(n){return n<10?'0'+n:''+n;};
  var newDate=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  var newTime=pad(d.getHours())+':'+pad(d.getMinutes());
  if(newDate!==dateEl.value){
    dateEl.value=newDate;
    _mttsTechActRefreshDateNextBtn();
  }
  _mttsPopulateTechActTimeOptions();
  sel.value=newTime;
  _mttsTechActRefreshTimeNextBtn();
}

function _mttsTechActRefreshTimeNextBtn(){
  var btn=document.getElementById('mttsTechActTimeNextBtn');if(!btn) return;
  var sel=document.getElementById('mttsTechActTime');
  var dateEl=document.getElementById('mttsTechActDate');
  if(!sel||!dateEl||!sel.value||!dateEl.value){btn.disabled=false;return;}
  var d=new Date(dateEl.value+'T'+sel.value+':00');
  d.setMinutes(d.getMinutes()+15);
  btn.disabled=(d.getTime()>Date.now());
}

function _mttsTechActTimeChanged(){
  var sel=document.getElementById('mttsTechActTime');
  var dateEl=document.getElementById('mttsTechActDate');
  if(!sel||!dateEl||!sel.value||!dateEl.value) return;
  var d=new Date(dateEl.value+'T'+sel.value+':00');
  if(d.getTime()>Date.now()){
    var now=new Date();
    now.setMinutes(Math.floor(now.getMinutes()/15)*15,0,0);
    var pad=function(n){return n<10?'0'+n:''+n;};
    sel.value=pad(now.getHours())+':'+pad(now.getMinutes());
  }
  _mttsTechActRefreshTimeNextBtn();
}

// Render the in-modal history panel showing every existing techAction
// for the current ticket (who / when / what / photos), with an inline
// Edit link on each editable entry. Highlights the entry currently being
// edited (if editIdx is set) so the user knows which row the form maps to.
function _mttsRenderTechActHistory(t,currentEditIdx){
  var wrap=document.getElementById('mttsTechActHistory');if(!wrap) return;
  var entries=Array.isArray(t.techActions)?t.techActions:[];
  if(!entries.length){
    wrap.innerHTML='<div style="padding:8px 10px;font-size:11px;color:var(--text3);font-style:italic">No previous updates yet.</div>';
    return;
  }
  var idEsc=String(t.id||'').replace(/'/g,"\\'");
  var actLbls={raised:'🎫 Raised',allocated:'👥 Allocated',reassigned:'👥 Reassigned',revoked:'↩ Revoked',assigned:'👥 Assigned',awaiting_spares:'🔩 Awaiting spares',awaiting_agency:'🔧 Awaiting agency',repair_done:'✓ Repair done',scrapped:'🚫 Scrapped',closed:'✅ Closed'};
  var canEditEntry=function(a){
    if(!a) return false;
    var locked={raised:1,allocated:1,reassigned:1,revoked:1};
    if(locked[a.action]) return false;
    // Closed (approved) tickets are frozen — to edit, manager must revoke
    // approval first via the ↩ Revoke ✓ action on the tickets list.
    if(t.status==='closed') return false;
    if(_mttsIsSA()||_mttsIsManager()) return true;
    if(_mttsIsTechnicianOnTicket(t)){
      var me=CU?(CU.name||CU.id||''):'';
      return a.by===me;
    }
    return false;
  };
  // Sort chronologically (newest first for in-modal scan).
  var sorted=entries.map(function(a,i){return {a:a,i:i};});
  sorted.sort(function(x,y){return String(y.a.at||'').localeCompare(String(x.a.at||''));});
  wrap.innerHTML=sorted.map(function(p){
    var a=p.a,i=p.i;
    var ts=a.at?(a.at.slice(0,10)+' '+a.at.slice(11,16)):'—';
    var who=a.by?_mttsUserDisp(a.by):'—';
    var noteBlock=a.note?'<div style="color:var(--text2);font-size:11px;margin-top:2px">'+String(a.note).replace(/</g,'&lt;')+'</div>':'';
    var etaBlock=a.eta?'<div style="font-size:10px;color:#92400e;margin-top:1px">ETA: '+a.eta+'</div>':'';
    var photos=(a.photos&&a.photos.length)?'<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:3px">'+a.photos.map(function(src){return '<a href="'+src+'" target="_blank" onclick="event.stopPropagation()"><img src="'+src+'" style="width:36px;height:36px;object-fit:cover;border-radius:4px;border:1px solid var(--border)"></a>';}).join('')+'</div>':'';
    var edited=a.editedAt?' <span style="font-size:9px;color:var(--text3);font-style:italic">(edited '+a.editedAt.slice(0,10)+')</span>':'';
    var editBtn=canEditEntry(a)?'<button onclick="event.stopPropagation();_mttsTicketActionOpen(\''+idEsc+'\','+i+')" title="Edit this update" style="float:right;font-size:10px;padding:2px 7px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer">✎</button>':'';
    var isCurrent=(currentEditIdx!=null&&currentEditIdx===i);
    var bg=isCurrent?'#fef3c7':'#f8fafc';
    var border=isCurrent?'2px solid #f59e0b':'2px solid var(--accent)';
    return '<div style="font-size:11px;border-left:'+border+';padding:5px 8px;margin-bottom:3px;background:'+bg+';border-radius:0 4px 4px 0">'+editBtn+
      '<b>'+(actLbls[a.action]||a.action)+'</b>'+(isCurrent?' <span style="color:#92400e;font-weight:800">· editing</span>':'')+
      '<div style="font-size:10px;color:var(--text3);margin-top:1px">'+ts+' · by '+who+edited+'</div>'+
      noteBlock+etaBlock+photos+
    '</div>';
  }).join('');
}

// ── Technician action flow — supports both "add new update" and "edit
// existing update" modes. editIdx, when supplied, points at an existing
// techActions[] entry; the form pre-fills with that entry and submit
// patches it instead of appending.
function _mttsTicketActionOpen(id,editIdx){
  var t=byId(DB.mttsTickets||[],id);if(!t){notify('Ticket not found',true);return;}
  if(!(_mttsIsTechnicianOnTicket(t)||_mttsIsSA()||_mttsIsManager())){notify('You are not assigned to this ticket',true);return;}
  document.getElementById('mttsTechActTicketId').value=id;
  document.getElementById('mttsTechActEditIdx').value=(editIdx==null?'':String(editIdx));
  var asset=byId(DB.mttsAssets||[],t.assetCode);

  var titleEl=document.querySelector('#mMttsTechAct .modal-title');
  if(titleEl) titleEl.textContent=(editIdx==null)?'🔧 Add Update':'🔧 Edit Update';

  document.getElementById('mttsTechActTicketLbl').innerHTML=
    '<b>'+(asset?asset.name:'(missing)')+'</b> at '+_mttsPlantLabel(t.plant)+' · '+_MTTS_STATUS_LABEL[t.status]+
    ' · down for <b style="color:#dc2626">'+_mttsTimerSince(t.raisedAt)+'</b>';

  // Inline history of every prior update — who/when/what/photos — with
  // ✎ Edit links. Highlights the entry currently being edited (if any).
  _mttsRenderTechActHistory(t,(editIdx==null?null:Number(editIdx)));

  var existing=null;
  if(editIdx!=null) existing=(t.techActions||[])[editIdx]||null;

  // Status — pre-fill from edited entry or default.
  document.getElementById('mttsTechActStatus').value=existing?(existing.action||'awaiting_spares'):'awaiting_spares';
  document.getElementById('mttsTechActNote').value=existing?(existing.note||''):'';
  document.getElementById('mttsTechActEta').value=existing?(existing.eta||''):'';
  document.getElementById('mttsTechActRoot').value=existing?'':'';

  // Date / time: from existing entry's `at` (ISO) or current local time.
  var d=existing&&existing.at?new Date(existing.at):new Date();
  // Snap minutes down to 15-min boundary so the value matches a select option.
  d.setMinutes(Math.floor(d.getMinutes()/15)*15,0,0);
  var pad=function(n){return n<10?'0'+n:''+n;};
  var dateEl=document.getElementById('mttsTechActDate');
  dateEl.value=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  dateEl.max=_mttsTodayStr();
  if(!dateEl._mttsDateChange){
    dateEl._mttsDateChange=function(){
      if(dateEl.value&&dateEl.value>_mttsTodayStr()) dateEl.value=_mttsTodayStr();
      _mttsPopulateTechActTimeOptions();
      _mttsTechActRefreshDateNextBtn();
      _mttsTechActRefreshTimeNextBtn();
    };
    dateEl.addEventListener('change',dateEl._mttsDateChange);
  }
  _mttsPopulateTechActTimeOptions();
  document.getElementById('mttsTechActTime').value=pad(d.getHours())+':'+pad(d.getMinutes());
  _mttsTechActRefreshDateNextBtn();
  _mttsTechActRefreshTimeNextBtn();

  _mttsTechActPhotosBuf=existing&&Array.isArray(existing.photos)?existing.photos.slice(0,3):[];
  _mttsRenderTechActPhotoTiles();
  document.getElementById('mttsTechActPhotos').value='';
  _mttsTechActRefreshFields();
  var err=document.getElementById('mttsTechActErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsTechAct'); else { document.getElementById('mMttsTechAct').classList.add('open'); }
}
function _mttsTechActRefreshFields(){
  var st=document.getElementById('mttsTechActStatus').value;
  var rootWrap=document.getElementById('mttsTechActRootWrap');
  var etaWrap=document.getElementById('mttsTechActEtaWrap');
  // Photos are always available on the Update Ticket form (up to 3).
  // Required only when closing the ticket as repair_done.
  var showRoot=(st==='repair_done'||st==='scrapped');
  var showEta=(st==='awaiting_spares'||st==='awaiting_agency');
  if(rootWrap) rootWrap.style.display=showRoot?'':'none';
  if(etaWrap) etaWrap.style.display=showEta?'':'none';
  var photoLbl=document.getElementById('mttsTechActPhotoLbl');
  if(photoLbl) photoLbl.textContent=(st==='repair_done')?'Closure photos (max 3) *':'Photos (max 3)';
}
async function _mttsTicketActionSubmit(){
  var err=document.getElementById('mttsTechActErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var id=document.getElementById('mttsTechActTicketId').value;
  var t=byId(DB.mttsTickets||[],id);if(!t){_showErr('Ticket not found');return;}
  if(!(_mttsIsTechnicianOnTicket(t)||_mttsIsSA()||_mttsIsManager())){_showErr('You are not assigned to this ticket');return;}
  var newStatus=document.getElementById('mttsTechActStatus').value;
  var note=document.getElementById('mttsTechActNote').value.trim();
  var eta=document.getElementById('mttsTechActEta').value;
  var root=document.getElementById('mttsTechActRoot').value.trim();
  var dateStr=document.getElementById('mttsTechActDate').value;
  var timeStr=document.getElementById('mttsTechActTime').value;
  var editIdxRaw=document.getElementById('mttsTechActEditIdx').value;
  var editIdx=editIdxRaw===''?null:parseInt(editIdxRaw,10);
  if(!dateStr){_showErr('Update date is required');return;}
  if(!timeStr){_showErr('Update time is required');return;}
  var atIso=new Date(dateStr+'T'+timeStr).toISOString();
  if(new Date(atIso).getTime()>Date.now()+60000){_showErr('Update date/time cannot be in the future');return;}
  if(newStatus==='repair_done'&&_mttsTechActPhotosBuf.length===0){_showErr('At least one closure photo is required for "Repair done"');return;}
  var bak=Object.assign({},t);
  t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
  var stepPhotos=_mttsTechActPhotosBuf.slice(0,3);
  var entry={
    action:newStatus,by:CU?(CU.name||CU.id||''):'',at:atIso,
    note:note,eta:eta||'',photos:stepPhotos
  };
  if(editIdx!=null&&editIdx>=0&&editIdx<t.techActions.length){
    // Edit existing update — preserve original author + add edit metadata.
    var orig=t.techActions[editIdx]||{};
    entry.by=orig.by||entry.by;
    entry.editedBy=CU?(CU.name||CU.id||''):'';
    entry.editedAt=new Date().toISOString();
    t.techActions[editIdx]=entry;
  } else {
    t.techActions.push(entry);
  }
  // Sort techActions chronologically by their stored `at` so out-of-order
  // backdated entries still appear in the right place on the timeline.
  t.techActions.sort(function(x,y){return String(x.at||'').localeCompare(String(y.at||''));});
  // The latest non-historical action sets the ticket's current status.
  var last=t.techActions[t.techActions.length-1]||entry;
  if(last.action&&last.action!=='raised'&&last.action!=='allocated'&&last.action!=='reassigned'&&last.action!=='revoked'){
    t.status=last.action;
  }
  if(newStatus==='repair_done'||newStatus==='scrapped'){
    if(stepPhotos.length) t.closePhotos=(t.closePhotos||[]).concat(stepPhotos);
    if(root) t.rootCause=root;
  }
  var ok=await _dbSave('mttsTickets',t);
  if(!ok){Object.assign(t,bak);_showErr('Save failed');return;}
  cm('mMttsTechAct');
  notify((editIdx!=null?'✓ Update edited':'🔧 Status updated to ')+(editIdx!=null?'':_MTTS_STATUS_LABEL[newStatus]));
  _mttsRenderTickets();
  // If the detail overlay is open for this ticket, refresh it to show the change.
  var ov=document.getElementById('mttsTicketDetailOverlay');
  if(ov&&ov.style.display!=='none') _mttsTicketDetail(id);
}

// ── Manager approval flow ─────────────────────────────────────────────────
function _mttsTicketApproveOpen(id){
  if(!_mttsCanApprove()){notify('Only Maintenance Manager can approve',true);return;}
  var t=byId(DB.mttsTickets||[],id);if(!t){notify('Ticket not found',true);return;}
  document.getElementById('mttsApproveTicketId').value=id;
  var asset=byId(DB.mttsAssets||[],t.assetCode);

  document.getElementById('mttsApproveTicketLbl').innerHTML=
    '<b>'+(asset?asset.name:'(missing)')+'</b> at '+_mttsPlantLabel(t.plant)+
    ' · marked <b>Repair done</b>'+(t.rootCause?' · root cause: '+t.rootCause:'')+
    ' · down for '+_mttsTimerSince(t.raisedAt);
  document.getElementById('mttsApproveCostSvc').value=t.costService||'';
  document.getElementById('mttsApproveCostSpr').value=t.costSpares||'';
  _mttsApprovePhotosBuf=(t.invoicePhotos||[]).slice(0,3);
  _mttsRenderApprovePhotoTiles();
  document.getElementById('mttsApprovePhotos').value='';
  document.getElementById('mttsApproveNote').value='';
  var err=document.getElementById('mttsApproveErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsApprove'); else { document.getElementById('mMttsApprove').classList.add('open'); }
}
async function _mttsTicketApproveConfirm(){
  if(!_mttsCanApprove()){notify('Access denied',true);return;}
  var err=document.getElementById('mttsApproveErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var id=document.getElementById('mttsApproveTicketId').value;
  var t=byId(DB.mttsTickets||[],id);if(!t){_showErr('Ticket not found');return;}
  var costSvc=parseFloat(document.getElementById('mttsApproveCostSvc').value)||0;
  var costSpr=parseFloat(document.getElementById('mttsApproveCostSpr').value)||0;
  var note=document.getElementById('mttsApproveNote').value.trim();
  var bak=Object.assign({},t);
  t.costService=costSvc;
  t.costSpares=costSpr;
  t.invoicePhotos=_mttsApprovePhotosBuf.slice();
  t.status='closed';
  t.approvedBy=CU?(CU.name||CU.id||''):'';
  t.approvedAt=new Date().toISOString();
  t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
  t.techActions.push({action:'closed',by:t.approvedBy,at:t.approvedAt,note:note,costService:costSvc,costSpares:costSpr});
  var ok=await _dbSave('mttsTickets',t);
  if(!ok){Object.assign(t,bak);_showErr('Save failed');return;}
  cm('mMttsApprove');
  notify('✓ Ticket closed · ₹'+(costSvc+costSpr).toFixed(2)+' total');
  _mttsRenderTickets();
}
// Manager can undo their own approval — drops the ticket back to 'open'
// so the lifecycle re-runs from allocation onward. Logs the revoke
// action with an optional reason.
async function _mttsTicketRevokeApproval(id){
  if(!_mttsCanApprove()){notify('Only Maintenance Manager can revoke approval',true);return;}
  var t=byId(DB.mttsTickets||[],id);if(!t){notify('Ticket not found',true);return;}
  if(t.status!=='closed'){notify('Only closed tickets can have approval revoked',true);return;}
  var note=prompt('Revoke approval for this ticket?\n\nThe ticket will go back to Open and need re-allocation.\n\nReason (optional):','');
  if(note===null) return;
  var bak=Object.assign({},t);
  t.status='open';
  t.approvedBy='';t.approvedAt='';
  t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
  t.techActions.push({action:'approval_revoked',by:CU?(CU.name||CU.id||''):'',at:new Date().toISOString(),note:note||''});
  var ok=await _dbSave('mttsTickets',t);
  if(!ok){Object.assign(t,bak);notify('Save failed',true);return;}
  notify('↩ Approval revoked — ticket re-opened');
  _mttsRenderTickets();
  var ov=document.getElementById('mttsTicketDetailOverlay');
  if(ov&&ov.style.display!=='none') _mttsTicketDetail(id);
}

async function _mttsTicketApproveReject(){
  if(!_mttsCanApprove()){notify('Access denied',true);return;}
  var id=document.getElementById('mttsApproveTicketId').value;
  var t=byId(DB.mttsTickets||[],id);if(!t) return;
  var note=prompt('Send back to technician — reason:','');
  if(note===null) return;
  var bak=Object.assign({},t);
  t.status='assigned';
  t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
  t.techActions.push({action:'rework_requested',by:CU?(CU.name||CU.id||''):'',at:new Date().toISOString(),note:note||''});
  var ok=await _dbSave('mttsTickets',t);
  if(!ok){Object.assign(t,bak);notify('Save failed',true);return;}
  cm('mMttsApprove');
  notify('↩ Sent back to technician');
  _mttsRenderTickets();
}

// ── Detail viewer (read-only quick look) ──────────────────────────────────
// Image lightbox — full-screen overlay with the clicked image scaled to
// fit. Click anywhere or press Escape to dismiss.
function _mttsLightbox(src){
  var existing=document.getElementById('mttsLightbox');if(existing) existing.remove();
  var ov=document.createElement('div');
  ov.id='mttsLightbox';
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:200001;display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:20px';
  ov.innerHTML='<button onclick="event.stopPropagation();var e=document.getElementById(\'mttsLightbox\');if(e)e.remove();" style="position:absolute;top:16px;right:16px;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.15);color:#fff;border:none;font-size:24px;font-weight:900;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center">×</button>'+
    '<img src="'+String(src).replace(/"/g,'&quot;')+'" style="max-width:96vw;max-height:92vh;object-fit:contain;border-radius:8px;box-shadow:0 30px 80px rgba(0,0,0,.6)">';
  ov.onclick=function(){ov.remove();document.removeEventListener('keydown',escHandler);};
  var escHandler=function(ev){if(ev.key==='Escape'){ov.remove();document.removeEventListener('keydown',escHandler);}};
  document.addEventListener('keydown',escHandler);
  document.body.appendChild(ov);
}

function _mttsTicketDetail(id){
  var t=byId(DB.mttsTickets||[],id);if(!t) return;
  var asset=byId(DB.mttsAssets||[],t.assetCode);

  var actLbls={raised:'🎫 Raised',allocated:'👥 Allocated',reassigned:'👥 Reassigned',revoked:'↩ Revoked',assigned:'👥 Assigned',awaiting_spares:'🔩 Awaiting spares',awaiting_agency:'🔧 Awaiting agency',repair_done:'✓ Repair done',scrapped:'🚫 Scrapped',closed:'✅ Closed',approval_revoked:'↩ Approval revoked',rework_requested:'↩ Rework requested'};
  // Stitch each row's photo source: the entry's own photos win; fall
  // back to the ticket-level buckets so older records — where photos
  // weren't stored on the entry — still appear in the right row.
  var resolveRowPhotos=function(a){
    if(a.photos&&a.photos.length) return a.photos.slice();
    if(a.action==='raised'&&t.photosRaise&&t.photosRaise.length) return t.photosRaise.slice();
    if((a.action==='repair_done'||a.action==='scrapped')&&t.closePhotos&&t.closePhotos.length) return t.closePhotos.slice();
    if(a.action==='closed'&&t.invoicePhotos&&t.invoicePhotos.length) return t.invoicePhotos.slice();
    return [];
  };
  var idEsc=String(t.id||'').replace(/'/g,"\\'");
  // Editable entries: any techAction with an action that came from the
  // Update Ticket form (not raise/allocate/reassign/revoke). Manager / SA
  // can edit any; assigned techs can edit their own.
  var canEditEntry=function(a){
    if(!a) return false;
    var locked={raised:1,allocated:1,reassigned:1,revoked:1};
    if(locked[a.action]) return false;
    // Closed (approved) tickets are frozen — to edit, manager must revoke
    // approval first via the ↩ Revoke ✓ action on the tickets list.
    if(t.status==='closed') return false;
    if(_mttsIsSA()||_mttsIsManager()) return true;
    if(_mttsIsTechnicianOnTicket(t)){
      var me=CU?(CU.name||CU.id||''):'';
      return a.by===me;
    }
    return false;
  };
  // Activity is shown as a proper table: SR# | Date / Time | Action |
  // By | Notes / ETA | Photos | Edit. Sort newest-first so the latest
  // update is at the top.
  var actEntries=(t.techActions||[]).map(function(a,i){return {a:a,i:i};});
  actEntries.sort(function(x,y){return String(y.a.at||'').localeCompare(String(x.a.at||''));});
  var actTh='padding:7px 10px;font-size:11px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)';
  var actTd='padding:8px 10px;font-size:12px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var actBodyRows=actEntries.map(function(p,n){
    var a=p.a,i=p.i;
    var dateStr=a.at?a.at.slice(0,10):'—';
    var timeStr=a.at?a.at.slice(11,16):'';
    var rowPhotos=resolveRowPhotos(a);
    var photos=rowPhotos.length
      ?'<div style="display:flex;gap:4px;flex-wrap:wrap">'+rowPhotos.map(function(src){return '<img src="'+src+'" onclick="event.stopPropagation();_mttsLightbox(\''+String(src).replace(/'/g,"\\'")+'\')" style="width:44px;height:44px;object-fit:cover;border-radius:4px;border:1px solid var(--border);cursor:pointer">';}).join('')+'</div>'
      :'<span style="color:var(--text3)">—</span>';
    var editBtn=canEditEntry(a)?'<button onclick="_mttsTicketActionOpen(\''+idEsc+'\','+i+')" title="Edit this update" style="font-size:10px;padding:3px 8px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer">✎ Edit</button>':'<span style="color:var(--text3);font-size:11px">—</span>';
    var editedBadge=a.editedAt?'<div style="font-size:9px;color:var(--text3);font-style:italic;margin-top:2px">edited '+a.editedAt.slice(0,10)+'</div>':'';
    var notesCell='';
    if(a.note) notesCell+='<div style="color:var(--text);font-size:13px;line-height:1.4;white-space:pre-wrap">'+String(a.note).replace(/</g,'&lt;')+'</div>';
    if(a.eta) notesCell+='<div style="font-size:10px;color:#92400e;margin-top:3px;font-weight:700">ETA: '+a.eta+'</div>';
    if(a.techs&&a.techs.length) notesCell+='<div style="font-size:10px;color:var(--text3);margin-top:3px">Techs: <b>'+a.techs.map(function(u){return _mttsUserDisp(u);}).join(', ')+'</b></div>';
    if(!notesCell) notesCell='<span style="color:var(--text3)">—</span>';
    return '<tr>'+
      '<td style="'+actTd+';font-family:var(--mono);color:var(--text3);text-align:center">'+(actEntries.length-n)+'</td>'+
      '<td style="'+actTd+';white-space:nowrap"><div style="font-size:13px;font-weight:800;color:var(--text);font-family:var(--mono)">'+dateStr+'</div><div style="font-size:13px;font-weight:700;color:var(--accent);font-family:var(--mono)">'+timeStr+'</div></td>'+
      '<td style="'+actTd+';font-weight:700">'+(actLbls[a.action]||a.action)+'</td>'+
      '<td style="'+actTd+';font-size:11px">'+(a.by?_mttsUserDisp(a.by):'—')+editedBadge+'</td>'+
      '<td style="'+actTd+'">'+notesCell+'</td>'+
      '<td style="'+actTd+'">'+photos+'</td>'+
      '<td style="'+actTd+';text-align:center">'+editBtn+'</td>'+
    '</tr>';
  }).join('');
  var actHtml=actEntries.length
    ? '<div style="overflow:auto;border:1px solid var(--border);border-radius:8px;background:#fff"><table style="width:100%;border-collapse:collapse"><thead><tr>'+
        '<th style="'+actTh+';width:40px;text-align:center">#</th>'+
        '<th style="'+actTh+'">Date / Time</th>'+
        '<th style="'+actTh+'">Action</th>'+
        '<th style="'+actTh+'">By</th>'+
        '<th style="'+actTh+'">Notes / ETA</th>'+
        '<th style="'+actTh+'">Photos</th>'+
        '<th style="'+actTh+';text-align:center;width:70px"></th>'+
      '</tr></thead><tbody>'+actBodyRows+'</tbody></table></div>'
    : '<div style="padding:18px;text-align:center;color:var(--text3);font-size:12px;font-style:italic">No activity yet.</div>';
  var html='<div style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:10000" onclick="if(event.target===this)document.getElementById(\'mttsTicketDetailOverlay\').style.display=\'none\'">'+
    '<div style="background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);width:min(900px,96vw);max-height:90vh;overflow:auto;padding:18px 20px">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:10px">'+
        '<div><div style="font-size:16px;font-weight:900">🎫 Ticket Details</div>'+
        '<div style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-top:2px">ID '+(t.id||'').slice(-10)+'</div></div>'+
        '<button onclick="document.getElementById(\'mttsTicketDetailOverlay\').style.display=\'none\'" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--text3);padding:0 4px">×</button>'+
      '</div>'+
      '<div style="font-size:14px"><b>'+(asset?asset.name:'(missing)')+'</b> · '+_mttsPlantLabel(t.plant)+'</div>'+
      '<div style="font-size:12px;color:var(--text3);margin-top:2px">'+(_MTTS_BREAKDOWN_LABEL[t.breakdownType]||t.breakdownType)+' · '+_mttsStatusBadge(t.status)+' · down for '+_mttsTimerSince(t.raisedAt)+'</div>'+
      '<div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;padding:8px 10px;background:#f8fafc;border:1px solid var(--border);border-radius:8px">'+
        '<div><div style="font-size:9px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Raised by</div><div style="font-size:13px;font-weight:700;color:var(--text);margin-top:2px">'+_mttsUserDisp(t.raisedBy)+'</div><div style="font-size:10px;color:var(--text3)">'+(t.raisedAt?t.raisedAt.slice(0,10)+' '+t.raisedAt.slice(11,16):'—')+'</div></div>'+
        '<div><div style="font-size:9px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Assigned to</div><div style="font-size:13px;font-weight:700;color:'+((t.assignedTo||[]).length?'var(--accent)':'var(--text3)')+';margin-top:2px">'+((t.assignedTo||[]).length?(t.assignedTo||[]).map(function(u){return _mttsUserDisp(u);}).join(', '):'— Not assigned —')+'</div>'+(t.assignedAt?'<div style="font-size:10px;color:var(--text3)">since '+t.assignedAt.slice(0,10)+'</div>':'')+'</div>'+
        ((t.approvedBy||t.approvedAt)?'<div><div style="font-size:9px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Approved by</div><div style="font-size:13px;font-weight:700;color:#16a34a;margin-top:2px">'+_mttsUserDisp(t.approvedBy||'—')+'</div><div style="font-size:10px;color:var(--text3)">'+(t.approvedAt?t.approvedAt.slice(0,10)+' '+t.approvedAt.slice(11,16):'—')+'</div></div>':'')+
      '</div>'+
      (t.rootCause?'<div style="font-size:11px;margin-top:6px;padding:6px 10px;background:#fef3c7;border-left:3px solid #fbbf24;border-radius:0 6px 6px 0"><b>Root cause:</b> '+String(t.rootCause).replace(/</g,'&lt;')+'</div>':'')+
      ((t.costService||t.costSpares)?'<div style="font-size:12px;margin-top:6px;padding:6px 10px;background:#dcfce7;border-radius:6px"><b>Cost:</b> Service ₹'+(t.costService||0)+' · Spares ₹'+(t.costSpares||0)+' · Total ₹'+((t.costService||0)+(t.costSpares||0)).toFixed(2)+'</div>':'')+
      '<div style="margin-top:12px;font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px">Activity</div>'+
      '<div style="margin-top:6px">'+actHtml+'</div>'+
    '</div>'+
  '</div>';
  var ov=document.getElementById('mttsTicketDetailOverlay');
  ov.innerHTML=html;ov.style.display='block';
}


// ═══ DASHBOARD ════════════════════════════════════════════════════════════
// Period-scoped maintenance overview:
//   1. Top-line counters (raised / open / in progress / awaiting approval / closed)
//   2. Plant-wise ticket breakdown
//   3. Monthly trend (raised vs closed) — last N months
//   4. Technician load (open + closed-in-period per technician)
//   5. Cost rollups (plant / asset-type / top items)
//   6. PM / Warranty / AMC due-or-overdue tracking
// All filters honour the current period + plant selector.

function _mttsDashboardRender(){
  var body=document.getElementById('mttsDashBody');if(!body) return;
  var period=(document.getElementById('mttsDashPeriod')||{}).value||'12m';
  var fPlant=(document.getElementById('mttsDashPlantFilter')||{}).value||'';
  var win=_mttsDashWindow(period);
  // Update sub-header label.
  var sub=document.getElementById('mttsDashSub');
  if(sub){
    var lbl={'12m':'Last 12 months · monthwise','6m':'Last 6 months · monthwise','3m':'Last 3 months · monthwise','ytd':'Year to date','all':'All time'}[period]||'';
    sub.textContent=lbl+(fPlant?(' · '+_mttsPlantLabel(fPlant)):'');
  }
  var tickets=(DB.mttsTickets||[]).filter(function(t){
    if(!t) return false;
    if(fPlant&&t.plant!==fPlant) return false;
    if(win.from&&(t.raisedAt||'')<win.from) return false;
    return true;
  });
  var assets=(DB.mttsAssets||[]).filter(function(a){
    if(!a) return false;
    if(fPlant&&a.plant!==fPlant) return false;
    return true;
  });

  body.innerHTML=
    _mttsDashTiles(tickets)+
    _mttsDashTechLoad(tickets)+
    _mttsDashPlantTable(tickets)+
    _mttsDashTicketTable(tickets)+
    _mttsDashTrend(tickets,win)+
    _mttsDashCosts(tickets)+
    _mttsDashUpkeep(assets);
}

function _mttsDashWindow(period){
  var now=new Date();
  var pad=function(n){return String(n).padStart(2,'0');};
  if(period==='all') return {from:'',label:'All time'};
  if(period==='ytd') return {from:now.getFullYear()+'-01-01',label:'YTD'};
  var months={ '3m':3,'6m':6,'12m':12 }[period]||12;
  var d=new Date(now.getFullYear(),now.getMonth()-(months-1),1);
  return {from:d.getFullYear()+'-'+pad(d.getMonth()+1)+'-01',label:'Last '+months+'m'};
}

function _mttsDashTiles(tickets){
  var c={raised:tickets.length,open:0,inprog:0,awaitingApp:0,closed:0,scrapped:0};
  // Priority breakdown — only counts tickets that are still in the
  // active pipeline (open / in-progress / awaiting approval), not the
  // ones already closed or scrapped.
  var pri={High:0,Medium:0,Low:0,Unset:0};
  tickets.forEach(function(t){
    if(t.status==='open') c.open++;
    else if(t.status==='assigned'||t.status==='awaiting_spares'||t.status==='awaiting_agency') c.inprog++;
    else if(t.status==='repair_done') c.awaitingApp++;
    else if(t.status==='closed') c.closed++;
    else if(t.status==='scrapped') c.scrapped++;
    var isActive=(t.status!=='closed'&&t.status!=='scrapped');
    if(isActive){
      var asset=byId(DB.mttsAssets||[],t.assetCode);
      var p=asset&&asset.criticality?asset.criticality:'Unset';
      if(pri[p]==null) p='Unset';
      pri[p]++;
    }
  });
  var totalCost=0;
  tickets.forEach(function(t){if(t.status==='closed') totalCost+=(+t.costService||0)+(+t.costSpares||0);});
  var tile=function(lbl,val,clr,bg){
    return '<div style="flex:1;min-width:140px;padding:14px 16px;background:'+bg+';border:1px solid '+clr+'33;border-left:4px solid '+clr+';border-radius:8px">'+
      '<div style="font-size:11px;font-weight:800;color:'+clr+';text-transform:uppercase;letter-spacing:0.5px">'+lbl+'</div>'+
      '<div style="font-size:24px;font-weight:900;color:var(--text);margin-top:2px">'+val+'</div></div>';
  };
  // Compact priority chip strip — sits beside the top-line tiles so the
  // open vs. priority breakdown is visible at a glance.
  var priTile='<div style="flex:1;min-width:200px;padding:10px 14px;background:#fff;border:1px solid var(--border);border-radius:8px">'+
    '<div style="font-size:11px;font-weight:800;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Active by Priority</div>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'+
      '<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca"><span style="font-size:10px;font-weight:800;color:#dc2626;text-transform:uppercase;letter-spacing:.5px">High</span><b style="font-size:16px;color:#7f1d1d">'+pri.High+'</b></span>'+
      '<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a"><span style="font-size:10px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:.5px">Medium</span><b style="font-size:16px;color:#78350f">'+pri.Medium+'</b></span>'+
      '<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;background:#f0fdf4;border:1px solid #bbf7d0"><span style="font-size:10px;font-weight:800;color:#16a34a;text-transform:uppercase;letter-spacing:.5px">Low</span><b style="font-size:16px;color:#14532d">'+pri.Low+'</b></span>'+
      (pri.Unset?'<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;background:#f8fafc;border:1px solid var(--border)"><span style="font-size:10px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Unset</span><b style="font-size:16px;color:var(--text2)">'+pri.Unset+'</b></span>':'')+
    '</div>'+
  '</div>';
  return '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">'+
    tile('Raised',c.raised,'#0ea5e9','#f0f9ff')+
    tile('Open',c.open,'#dc2626','#fef2f2')+
    tile('In Progress',c.inprog,'#f59e0b','#fffbeb')+
    tile('Awaiting Approval',c.awaitingApp,'#16a34a','#f0fdf4')+
    tile('Closed',c.closed,'#64748b','#f8fafc')+
    tile('Scrapped',c.scrapped,'#7f1d1d','#fef2f2')+
    tile('Total Cost (₹)',totalCost.toLocaleString('en-IN',{maximumFractionDigits:0}),'#7c3aed','#faf5ff')+
    priTile+
  '</div>';
}

function _mttsDashTicketTable(tickets){
  if(!tickets||!tickets.length) return _mttsDashCard('Tickets in period','<div style="padding:18px;color:var(--text3);font-size:12px;text-align:center">No tickets in this period.</div>');
  // Sort by raisedAt descending — newest first.
  var rows=tickets.slice().sort(function(a,b){return String(b.raisedAt||'').localeCompare(String(a.raisedAt||''));});
  var statusClr={open:'#0ea5e9',assigned:'#0ea5e9',awaiting_spares:'#f59e0b',awaiting_agency:'#f59e0b',repair_done:'#16a34a',closed:'#16a34a',scrapped:'#dc2626'};
  var bdLbl=_MTTS_BREAKDOWN_LABEL||{};
  var statusLbl=_MTTS_STATUS_LABEL||{};
  var th='padding:6px 10px;font-size:11px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;position:sticky;top:0;z-index:1';
  var td='padding:6px 10px;font-size:12px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var rowsHtml=rows.map(function(t){
    var asset=byId(DB.mttsAssets||[],t.assetCode);
    var assetName=asset?asset.name:(t.assetCode||'(missing)');
    var raised=t.raisedAt?(t.raisedAt.slice(0,10)+' '+t.raisedAt.slice(11,16)):'—';
    var techs=(t.assignedTo||[]).map(function(u){return _mttsUserDisp(u);}).join(', ')||'—';
    var clr=statusClr[t.status]||'#64748b';
    var stLbl=statusLbl[t.status]||t.status;
    var bd=bdLbl[t.breakdownType]||t.breakdownType||'';
    var idEsc=String(t.id||'').replace(/'/g,"\\'");
    return '<tr onclick="_mttsTicketDetail(\''+idEsc+'\')" style="cursor:pointer" onmouseover="this.style.background=\'#f8fafc\'" onmouseout="this.style.background=\'\'">'+
      '<td style="'+td+';font-family:var(--mono);font-size:11px;color:var(--text3)">'+raised+'</td>'+
      '<td style="'+td+'">'+_mttsPlantBadge(t.plant)+'</td>'+
      '<td style="'+td+';font-weight:700">'+String(assetName).replace(/</g,'&lt;')+'</td>'+
      '<td style="'+td+';font-size:11px">'+bd+'</td>'+
      '<td style="'+td+';font-size:11px">'+(t.raisedBy?_mttsUserDisp(t.raisedBy):'—')+'</td>'+
      '<td style="'+td+';font-size:11px">'+techs+'</td>'+
      '<td style="'+td+'"><span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:10px;font-weight:800;background:'+clr+'18;color:'+clr+';text-transform:uppercase;letter-spacing:.3px">'+stLbl+'</span></td>'+
    '</tr>';
  }).join('');
  return _mttsDashCard('Tickets raised — '+rows.length,
    '<div style="overflow:auto;max-height:420px"><table style="width:100%;border-collapse:collapse"><thead><tr>'+
      '<th style="'+th+'">Raised</th>'+
      '<th style="'+th+'">Plant</th>'+
      '<th style="'+th+'">Asset</th>'+
      '<th style="'+th+'">Breakdown</th>'+
      '<th style="'+th+'">Raised by</th>'+
      '<th style="'+th+'">Assigned to</th>'+
      '<th style="'+th+'">Status</th>'+
    '</tr></thead><tbody>'+rowsHtml+'</tbody></table></div>'
  );
}

function _mttsDashPlantTable(tickets){
  var plantLbl=function(v){return _mttsPlantLabel(v);};
  var byPlant={};
  tickets.forEach(function(t){
    var k=t.plant||'_';
    if(!byPlant[k]) byPlant[k]={raised:0,open:0,inprog:0,awaitingApp:0,closed:0,scrapped:0,cost:0};
    byPlant[k].raised++;
    if(t.status==='open') byPlant[k].open++;
    else if(t.status==='assigned'||t.status==='awaiting_spares'||t.status==='awaiting_agency') byPlant[k].inprog++;
    else if(t.status==='repair_done') byPlant[k].awaitingApp++;
    else if(t.status==='closed'){byPlant[k].closed++;byPlant[k].cost+=(+t.costService||0)+(+t.costSpares||0);}
    else if(t.status==='scrapped') byPlant[k].scrapped++;
  });
  var keys=Object.keys(byPlant).sort();
  if(!keys.length) return _mttsDashCard('Plant-wise breakdown','<div style="padding:18px;color:var(--text3);font-size:12px;text-align:center">No tickets in this period.</div>');
  var th='padding:6px 10px;font-size:11px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left';
  var td='padding:6px 10px;font-size:12px;border-bottom:1px solid #f1f5f9';
  var rowsHtml=keys.map(function(k){
    var c=byPlant[k];
    return '<tr><td style="'+td+';font-weight:800">'+plantLbl(k)+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+c.raised+'</td>'+
      '<td style="'+td+';text-align:right;color:#dc2626;font-weight:700">'+c.open+'</td>'+
      '<td style="'+td+';text-align:right;color:#f59e0b;font-weight:700">'+c.inprog+'</td>'+
      '<td style="'+td+';text-align:right;color:#16a34a;font-weight:700">'+c.awaitingApp+'</td>'+
      '<td style="'+td+';text-align:right;color:var(--text3)">'+c.closed+'</td>'+
      '<td style="'+td+';text-align:right;color:#7f1d1d">'+c.scrapped+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono);font-weight:700">₹'+c.cost.toLocaleString('en-IN',{maximumFractionDigits:0})+'</td>'+
    '</tr>';
  }).join('');
  return _mttsDashCard('Plant-wise breakdown',
    '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>'+
      '<th style="'+th+'">Plant</th>'+
      '<th style="'+th+';text-align:right">Raised</th>'+
      '<th style="'+th+';text-align:right">Open</th>'+
      '<th style="'+th+';text-align:right">In progress</th>'+
      '<th style="'+th+';text-align:right">Awaiting approval</th>'+
      '<th style="'+th+';text-align:right">Closed</th>'+
      '<th style="'+th+';text-align:right">Scrapped</th>'+
      '<th style="'+th+';text-align:right">Cost</th>'+
    '</tr></thead><tbody>'+rowsHtml+'</tbody></table></div>'
  );
}

function _mttsDashTrend(tickets,win){
  // Build month buckets (YYYY-MM) for the window's month range.
  var now=new Date();
  var pad=function(n){return String(n).padStart(2,'0');};
  var months=[];
  var monthsCount=12;
  if(win.from){
    var p=win.from.split('-');
    var d=new Date(+p[0],+p[1]-1,1);
    while(d<=now){months.push(d.getFullYear()+'-'+pad(d.getMonth()+1));d.setMonth(d.getMonth()+1);}
  } else {
    // 'all' fallback — last 12 months window for the chart.
    for(var i=11;i>=0;i--){var d2=new Date(now.getFullYear(),now.getMonth()-i,1);months.push(d2.getFullYear()+'-'+pad(d2.getMonth()+1));}
  }
  var raised={},closed={};
  months.forEach(function(m){raised[m]=0;closed[m]=0;});
  tickets.forEach(function(t){
    var rm=(t.raisedAt||'').slice(0,7);
    if(raised.hasOwnProperty(rm)) raised[rm]++;
    var cm=(t.approvedAt||'').slice(0,7);
    if(t.status==='closed'&&closed.hasOwnProperty(cm)) closed[cm]++;
  });
  var max=Math.max.apply(null,months.map(function(m){return Math.max(raised[m],closed[m]);}).concat([1]));
  var bars=months.map(function(m){
    var rH=Math.max(2,Math.round(raised[m]/max*100));
    var cH=Math.max(2,Math.round(closed[m]/max*100));
    return '<div style="flex:1;min-width:42px;display:flex;flex-direction:column;align-items:center;gap:2px">'+
      '<div style="display:flex;gap:2px;align-items:flex-end;height:120px">'+
        '<div title="Raised: '+raised[m]+'" style="width:14px;background:#0ea5e9;height:'+rH+'%;border-radius:3px 3px 0 0"></div>'+
        '<div title="Closed: '+closed[m]+'" style="width:14px;background:#16a34a;height:'+cH+'%;border-radius:3px 3px 0 0"></div>'+
      '</div>'+
      '<div style="font-size:9px;color:var(--text3);font-family:var(--mono)">'+m.slice(2)+'</div>'+
    '</div>';
  }).join('');
  return _mttsDashCard('Monthly trend (raised vs closed)',
    '<div style="display:flex;gap:6px;align-items:flex-end;padding:10px 4px;overflow-x:auto;border-bottom:1px solid var(--border)">'+bars+'</div>'+
    '<div style="display:flex;gap:14px;justify-content:center;margin-top:8px;font-size:11px;color:var(--text2)">'+
      '<span><span style="display:inline-block;width:10px;height:10px;background:#0ea5e9;border-radius:2px;vertical-align:middle"></span> Raised</span>'+
      '<span><span style="display:inline-block;width:10px;height:10px;background:#16a34a;border-radius:2px;vertical-align:middle"></span> Closed</span>'+
    '</div>'
  );
}

function _mttsDashTechLoad(tickets){
  // Group every ticket by each technician it's assigned to. A ticket
  // assigned to multiple technicians appears under each one (with a
  // "Shared" tag) so each card shows that tech's full plate.
  var byTech={};
  tickets.forEach(function(t){
    var assignees=t.assignedTo||[];
    assignees.forEach(function(u){
      if(!u) return;
      if(!byTech[u]) byTech[u]={open:[],closed:[]};
      var bucket=(t.status==='closed'||t.status==='scrapped')?'closed':'open';
      byTech[u][bucket].push(t);
    });
  });
  var keys=Object.keys(byTech).sort(function(a,b){
    var ad=(byTech[a].open.length)-(byTech[b].open.length);
    if(ad) return -ad;
    return _mttsUserDisp(a).localeCompare(_mttsUserDisp(b));
  });
  if(!keys.length) return _mttsDashCard('Technician allocations','<div style="padding:18px;color:var(--text3);font-size:12px;text-align:center">No allocated tickets in this period.</div>');

  var statusClr={open:'#0ea5e9',assigned:'#0ea5e9',awaiting_spares:'#f59e0b',awaiting_agency:'#f59e0b',repair_done:'#16a34a',closed:'#16a34a',scrapped:'#dc2626'};
  var bdLbl=_MTTS_BREAKDOWN_LABEL||{};
  var statusLbl=_MTTS_STATUS_LABEL||{};

  var renderTicketRow=function(t){
    var asset=byId(DB.mttsAssets||[],t.assetCode);
    var assetName=asset?asset.name:(t.assetCode||'(missing)');
    var raised=t.raisedAt?t.raisedAt.slice(0,10):'—';
    var shared=(t.assignedTo||[]).length>1;
    var sharedTag=shared?'<span title="Allocated to '+(t.assignedTo||[]).length+' technicians" style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:800;background:#fef3c7;color:#92400e;border:1px solid #fcd34d">Shared</span>':'';
    var clr=statusClr[t.status]||'#64748b';
    var stLbl=statusLbl[t.status]||t.status;
    var bd=bdLbl[t.breakdownType]||t.breakdownType||'';
    var idEsc=String(t.id||'').replace(/'/g,"\\'");
    return '<div onclick="_mttsTicketDetail(\''+idEsc+'\')" style="display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-bottom:1px solid #f1f5f9;cursor:pointer;font-size:11px" onmouseover="this.style.background=\'#f8fafc\'" onmouseout="this.style.background=\'\'">'+
      '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+clr+';flex-shrink:0;margin-top:5px"></span>'+
      '<div style="flex:1;min-width:0">'+
        '<div style="font-weight:700;color:var(--text)">'+String(assetName).replace(/</g,'&lt;')+sharedTag+'</div>'+
        '<div style="color:var(--text3);font-size:10px;margin-top:1px">'+_mttsPlantLabel(t.plant)+(bd?' · '+bd:'')+' · raised '+raised+'</div>'+
      '</div>'+
      '<span style="font-size:9px;font-weight:800;color:'+clr+';background:'+clr+'18;padding:2px 8px;border-radius:8px;flex-shrink:0;text-transform:uppercase;letter-spacing:.3px">'+stLbl+'</span>'+
    '</div>';
  };

  var cardsHtml=keys.map(function(k){
    var c=byTech[k];
    // Each technician: their tickets sorted by raisedAt desc (newest first).
    // Open tickets come first, then a small "Closed" section underneath.
    var sortByRaisedDesc=function(a,b){return String(b.raisedAt||'').localeCompare(String(a.raisedAt||''));};
    var openTickets=c.open.slice().sort(sortByRaisedDesc);
    var closedTickets=c.closed.slice().sort(sortByRaisedDesc);
    var openHtml=openTickets.length?openTickets.map(renderTicketRow).join(''):'<div style="padding:8px;font-size:11px;color:var(--text3);font-style:italic;text-align:center">No open tickets</div>';
    var closedHtml='';
    if(closedTickets.length){
      closedHtml='<div style="font-size:9px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:1px;padding:6px 8px 3px;background:#fafafa;border-top:1px solid var(--border)">Closed in period · '+closedTickets.length+'</div>'+
        closedTickets.map(renderTicketRow).join('');
    }
    return '<div style="background:#fff;border:1px solid var(--border);border-radius:10px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)">'+
      '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(to right,rgba(42,154,160,.08),#fff);border-bottom:1px solid var(--border)">'+
        '<span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:var(--accent);color:#fff;font-weight:800;font-size:13px;flex-shrink:0">'+(_mttsUserDisp(k)||'?').slice(0,1).toUpperCase()+'</span>'+
        '<div style="flex:1;min-width:0">'+
          '<div style="font-weight:800;font-size:13px;color:var(--text)">'+_mttsUserDisp(k)+'</div>'+
          '<div style="font-size:10px;color:var(--text3);margin-top:1px">'+openTickets.length+' open · '+closedTickets.length+' closed in period</div>'+
        '</div>'+
        (openTickets.length?'<span style="font-family:var(--mono);font-size:14px;font-weight:800;color:#dc2626;background:#fee2e2;padding:3px 10px;border-radius:8px">'+openTickets.length+'</span>':'')+
      '</div>'+
      '<div style="max-height:240px;overflow-y:auto">'+openHtml+closedHtml+'</div>'+
    '</div>';
  }).join('');

  return _mttsDashCard('Technician allocations',
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">'+cardsHtml+'</div>'
  );
}

function _mttsDashCosts(tickets){
  var closed=tickets.filter(function(t){return t.status==='closed';});
  if(!closed.length) return _mttsDashCard('Cost rollups','<div style="padding:18px;color:var(--text3);font-size:12px;text-align:center">No closed tickets in this period — no cost data yet.</div>');
  var byPlant={},byType={},byItem={};
  closed.forEach(function(t){
    var asset=byId(DB.mttsAssets||[],t.assetCode);
    var cost=(+t.costService||0)+(+t.costSpares||0);
    var pK=t.plant||'_';
    var tyK=asset?asset.assetType:'_';
    var iK=t.assetCode||'_';
    if(!byPlant[pK]) byPlant[pK]={cost:0,svc:0,spr:0,n:0};
    byPlant[pK].cost+=cost;byPlant[pK].svc+=(+t.costService||0);byPlant[pK].spr+=(+t.costSpares||0);byPlant[pK].n++;
    if(!byType[tyK]) byType[tyK]={cost:0,n:0};
    byType[tyK].cost+=cost;byType[tyK].n++;
    if(!byItem[iK]) byItem[iK]={cost:0,n:0,name:asset?asset.name:'(missing)',plant:t.plant};
    byItem[iK].cost+=cost;byItem[iK].n++;
  });
  var plantLbl=function(v){return _mttsPlantLabel(v);};
  var fmt=function(n){return '₹'+(+n||0).toLocaleString('en-IN',{maximumFractionDigits:0});};
  var th='padding:6px 10px;font-size:11px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left';
  var td='padding:5px 10px;font-size:12px;border-bottom:1px solid #f1f5f9';

  var plantRows=Object.keys(byPlant).sort(function(a,b){return byPlant[b].cost-byPlant[a].cost;}).map(function(k){
    var c=byPlant[k];
    return '<tr><td style="'+td+';font-weight:700">'+plantLbl(k)+'</td>'+
      '<td style="'+td+';text-align:right;color:var(--text3)">'+c.n+'</td>'+
      '<td style="'+td+';text-align:right;color:var(--text3);font-family:var(--mono)">'+fmt(c.svc)+'</td>'+
      '<td style="'+td+';text-align:right;color:var(--text3);font-family:var(--mono)">'+fmt(c.spr)+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono);font-weight:800">'+fmt(c.cost)+'</td></tr>';
  }).join('');
  var typeRows=Object.keys(byType).sort(function(a,b){return byType[b].cost-byType[a].cost;}).map(function(k){
    var c=byType[k];
    return '<tr><td style="'+td+';font-weight:700">'+(k==='_'?'(unknown)':k)+'</td>'+
      '<td style="'+td+';text-align:right;color:var(--text3)">'+c.n+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono);font-weight:800">'+fmt(c.cost)+'</td></tr>';
  }).join('');
  var itemRows=Object.keys(byItem).sort(function(a,b){return byItem[b].cost-byItem[a].cost;}).slice(0,10).map(function(k){
    var c=byItem[k];
    return '<tr><td style="'+td+';font-weight:700">'+c.name+'</td>'+
      '<td style="'+td+';color:var(--text3);font-size:11px">'+plantLbl(c.plant)+'</td>'+
      '<td style="'+td+';text-align:right;color:var(--text3)">'+c.n+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono);font-weight:800">'+fmt(c.cost)+'</td></tr>';
  }).join('');

  var html=
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">'+
      '<div><div style="font-size:11px;font-weight:800;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">By Plant</div>'+
        '<table style="width:100%;border-collapse:collapse"><thead><tr>'+
          '<th style="'+th+'">Plant</th>'+
          '<th style="'+th+';text-align:right">#</th>'+
          '<th style="'+th+';text-align:right">Service</th>'+
          '<th style="'+th+';text-align:right">Spares</th>'+
          '<th style="'+th+';text-align:right">Total</th>'+
        '</tr></thead><tbody>'+plantRows+'</tbody></table></div>'+
      '<div><div style="font-size:11px;font-weight:800;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">By Asset Type</div>'+
        '<table style="width:100%;border-collapse:collapse"><thead><tr>'+
          '<th style="'+th+'">Type</th>'+
          '<th style="'+th+';text-align:right">#</th>'+
          '<th style="'+th+';text-align:right">Total</th>'+
        '</tr></thead><tbody>'+typeRows+'</tbody></table></div>'+
    '</div>'+
    '<div style="margin-top:14px"><div style="font-size:11px;font-weight:800;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Top 10 Items by Cost</div>'+
      '<table style="width:100%;border-collapse:collapse"><thead><tr>'+
        '<th style="'+th+'">Item</th>'+
        '<th style="'+th+'">Plant</th>'+
        '<th style="'+th+';text-align:right">#</th>'+
        '<th style="'+th+';text-align:right">Total</th>'+
      '</tr></thead><tbody>'+itemRows+'</tbody></table></div>';
  return _mttsDashCard('Cost rollups (closed tickets)',html);
}

function _mttsDashUpkeep(assets){
  // PM, warranty, AMC tracking — flagged due (within 30 days) or overdue.
  var todayStr=(new Date()).toISOString().slice(0,10);
  var in30=new Date();in30.setDate(in30.getDate()+30);var in30Str=in30.toISOString().slice(0,10);
  var addMonths=function(dateStr,m){
    if(!dateStr) return '';
    var p=dateStr.split('-');var d=new Date(+p[0],+p[1]-1,+p[2]);
    d.setMonth(d.getMonth()+m);
    return d.toISOString().slice(0,10);
  };
  var rows=[];
  assets.forEach(function(a){
    if(a.status==='Scrap') return;
    // Warranty
    if(a.warranty&&a.warranty.until){
      var w=a.warranty.until;
      var wState=null;
      if(w<todayStr) wState='expired';
      else if(w<=in30Str) wState='due';
      if(wState) rows.push({asset:a,kind:'Warranty',due:w,state:wState});
    }
    // AMC
    if(a.amc&&a.amc.until){
      var m=a.amc.until;
      var mState=null;
      if(m<todayStr) mState='expired';
      else if(m<=in30Str) mState='due';
      if(mState) rows.push({asset:a,kind:'AMC',due:m,state:mState});
    }
  });
  if(!rows.length) return _mttsDashCard('Upkeep alerts (Warranty / AMC)','<div style="padding:18px;color:var(--text3);font-size:12px;text-align:center">No warranty / AMC items due or overdue. ✅</div>');
  rows.sort(function(a,b){
    var rk={overdue:0,expired:0,due:1};
    var ra=rk[a.state],rb=rk[b.state];
    if(ra!==rb) return ra-rb;
    return (a.due||'').localeCompare(b.due||'');
  });
  var plantLbl=function(v){return _mttsPlantLabel(v);};
  var th='padding:6px 10px;font-size:11px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left';
  var td='padding:5px 10px;font-size:12px;border-bottom:1px solid #f1f5f9';
  var stateClr={overdue:'#dc2626',expired:'#dc2626',due:'#f59e0b'};
  var stateLbl={overdue:'Overdue',expired:'Expired',due:'Due ≤ 30d'};
  var html=
    '<div style="overflow:auto;max-height:320px"><table style="width:100%;border-collapse:collapse"><thead><tr>'+
      '<th style="'+th+'">Asset</th>'+
      '<th style="'+th+'">Plant</th>'+
      '<th style="'+th+'">Kind</th>'+
      '<th style="'+th+'">Due</th>'+
      '<th style="'+th+'">State</th>'+
    '</tr></thead><tbody>'+
    rows.map(function(r){
      return '<tr><td style="'+td+';font-weight:700">'+(r.asset.name||'—')+
        '<div style="font-size:10px;color:var(--text3)">'+(r.asset.assetType||'')+'</div></td>'+
        '<td style="'+td+'">'+plantLbl(r.asset.plant)+'</td>'+
        '<td style="'+td+'">'+r.kind+'</td>'+
        '<td style="'+td+';font-family:var(--mono)">'+r.due+'</td>'+
        '<td style="'+td+'"><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800;background:'+stateClr[r.state]+'22;color:'+stateClr[r.state]+'">'+stateLbl[r.state]+'</span></td></tr>';
    }).join('')+
    '</tbody></table></div>';
  return _mttsDashCard('Upkeep alerts (Warranty / AMC)',html);
}

function _mttsDashCard(title,inner){
  return '<div class="card" style="margin-bottom:12px"><div class="card-header" style="border-bottom:1px solid var(--border)"><div class="card-title">'+title+'</div></div><div style="padding:6px 12px 10px">'+inner+'</div></div>';
}


// ═══ PLANT MASTER ═══════════════════════════════════════════════════════════
// CRUD for the MTTS plant list. Plants are stored in mtts_plants and used
// throughout MTTS (assets, tickets, dashboard filters). Delete is blocked
// when any asset or ticket still references the plant code.

function _mttsRenderPlants(){
  var wrap=document.getElementById('mttsPlantTableWrap');if(!wrap) return;
  var hideInactive=!!(document.getElementById('mttsPlantHideInactive')||{}).checked;
  var rows=(DB.mttsPlants||[]).slice().filter(function(p){return p&&(!hideInactive||!p.inactive);});
  rows.sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});

  // Reference counts so the user can see at a glance which plants are in use.
  var refsAsset={},refsTicket={};
  (DB.mttsAssets||[]).forEach(function(a){if(a&&a.plant) refsAsset[a.plant]=(refsAsset[a.plant]||0)+1;});
  (DB.mttsTickets||[]).forEach(function(t){if(t&&t.plant) refsTicket[t.plant]=(refsTicket[t.plant]||0)+1;});

  var sumEl=document.getElementById('mttsPlantSummary');
  if(sumEl) sumEl.innerHTML='Total: <b>'+(DB.mttsPlants||[]).length+'</b> · Active: <b>'+(DB.mttsPlants||[]).filter(function(p){return p&&!p.inactive;}).length+'</b> · Showing: <b>'+rows.length+'</b>';
  if(!rows.length){
    wrap.innerHTML='<div class="empty-state" style="padding:30px 20px;text-align:center;color:var(--text3)">No plants yet. Click <b>+ Add Plant</b> to create one.</div>';
    return;
  }
  var th='padding:8px 12px;font-size:13px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;position:sticky;top:0;z-index:1';
  var td='padding:8px 12px;font-size:14px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var html='<div style="overflow:auto;border:1.5px solid var(--border);border-radius:8px;background:#fff;width:fit-content;max-width:100%">'+
    '<table style="width:auto;border-collapse:collapse;font-size:14px"><thead><tr>'+
      '<th style="'+th+'">#</th>'+
      '<th style="'+th+'">Code</th>'+
      '<th style="'+th+'">Name</th>'+
      '<th style="'+th+'">Address</th>'+
      '<th style="'+th+';text-align:right">Assets</th>'+
      '<th style="'+th+';text-align:right">Tickets</th>'+
      '<th style="'+th+'">Status</th>'+
      '<th style="'+th+';text-align:center;width:90px">Actions</th>'+
    '</tr></thead><tbody>';
  var canEditPlant=_mttsHasAccess('action.editPlant');
  rows.forEach(function(p,i){
    var idEsc=String(p.id||'').replace(/'/g,"\\'");
    var swatch=p.color?'<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:'+p.color+';border:1px solid rgba(0,0,0,.1);vertical-align:middle;margin-right:6px"></span>':'';
    var aRef=refsAsset[p.id]||0,tRef=refsTicket[p.id]||0;
    var canDelete=canEditPlant&&aRef===0&&tRef===0;
    var deleteBtn=canDelete
      ? '<button onclick="event.stopPropagation();_mttsPlantDeleteFromTable(\''+idEsc+'\')" title="Delete plant" style="font-size:12px;padding:4px 9px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer;margin-left:3px">🗑</button>'
      : '<button disabled title="In use — cannot delete (referenced by '+aRef+' asset(s) / '+tRef+' ticket(s))" style="font-size:12px;padding:4px 9px;font-weight:700;background:#f1f5f9;border:1px solid var(--border);color:#cbd5e1;border-radius:4px;cursor:not-allowed;margin-left:3px">🗑</button>';
    // Row click anywhere opens view / edit. Buttons inside stop propagation.
    html+='<tr onclick="_mttsPlantOpen(\''+idEsc+'\')" style="cursor:pointer" onmouseover="this.style.background=\'#f8fafc\'" onmouseout="this.style.background=\'\'">'+
      '<td style="'+td+';color:var(--text3);font-family:var(--mono)">'+(i+1)+'</td>'+
      '<td style="'+td+';font-family:var(--mono);font-weight:800;color:var(--accent)">'+swatch+(p.id||'')+'</td>'+
      '<td style="'+td+';font-weight:700">'+(p.name||'—')+'</td>'+
      '<td style="'+td+';font-size:13px;color:var(--text2);max-width:320px">'+String(p.address||'').replace(/</g,'&lt;').replace(/\n/g,'<br>')+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+aRef+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+tRef+'</td>'+
      '<td style="'+td+'">'+(p.inactive?'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#fee2e2;color:#7f1d1d">Inactive</span>':'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#dcfce7;color:#15803d">Active</span>')+'</td>'+
      '<td style="'+td+';text-align:center;white-space:nowrap">'+
        '<button onclick="event.stopPropagation();_mttsPlantOpen(\''+idEsc+'\')" title="Edit plant" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer">✎</button>'+
        deleteBtn+
      '</td>'+
    '</tr>';
  });
  html+='</tbody></table></div>';
  wrap.innerHTML=html;
}

// 100-swatch colour palette for the Plant edit modal — 10 hues × 10
// shades each. Lighter tints first so the picker reads warm → cool
// left-to-right and pale → saturated top-to-bottom.
var _MTTS_PLANT_PALETTE=(function(){
  var hues=[
    ['#fee2e2','#fecaca','#fca5a5','#f87171','#ef4444','#dc2626','#b91c1c','#991b1b','#7f1d1d','#450a0a'],//red
    ['#ffedd5','#fed7aa','#fdba74','#fb923c','#f97316','#ea580c','#c2410c','#9a3412','#7c2d12','#431407'],//orange
    ['#fef3c7','#fde68a','#fcd34d','#fbbf24','#f59e0b','#d97706','#b45309','#92400e','#78350f','#451a03'],//amber
    ['#fef9c3','#fef08a','#fde047','#facc15','#eab308','#ca8a04','#a16207','#854d0e','#713f12','#422006'],//yellow
    ['#dcfce7','#bbf7d0','#86efac','#4ade80','#22c55e','#16a34a','#15803d','#166534','#14532d','#052e16'],//green
    ['#cffafe','#a5f3fc','#67e8f9','#22d3ee','#06b6d4','#0891b2','#0e7490','#155e75','#164e63','#083344'],//cyan
    ['#dbeafe','#bfdbfe','#93c5fd','#60a5fa','#3b82f6','#2563eb','#1d4ed8','#1e40af','#1e3a8a','#172554'],//blue
    ['#ede9fe','#ddd6fe','#c4b5fd','#a78bfa','#8b5cf6','#7c3aed','#6d28d9','#5b21b6','#4c1d95','#2e1065'],//violet
    ['#fce7f3','#fbcfe8','#f9a8d4','#f472b6','#ec4899','#db2777','#be185d','#9d174d','#831843','#500724'],//pink
    ['#f1f5f9','#e2e8f0','#cbd5e1','#94a3b8','#64748b','#475569','#334155','#1e293b','#0f172a','#020617'] //slate
  ];
  return hues.flat();
})();

function _mttsRenderPlantColorGrid(currentHex){
  // The grid lives inside the popup; we still call this on modal open so
  // the preview swatch + hex label refresh immediately, even before the
  // popup is shown.
  var current=String(currentHex||'').toLowerCase();
  var swatch=document.getElementById('mttsPlantColorSwatch');if(swatch) swatch.style.background=currentHex;
  var hex=document.getElementById('mttsPlantColorHex');if(hex) hex.textContent=current;
  var grid=document.getElementById('mttsPlantColorGrid');if(!grid) return;
  grid.innerHTML=_MTTS_PLANT_PALETTE.map(function(c){
    var isOn=c.toLowerCase()===current;
    return '<div onclick="_mttsPlantPickColor(\''+c+'\')" title="'+c+'" '+
      'style="width:28px;height:28px;border-radius:4px;background:'+c+';cursor:pointer;'+
      'border:'+(isOn?'2px solid #1e293b':'1px solid rgba(0,0,0,.08)')+';'+
      'box-shadow:'+(isOn?'0 0 0 2px #fff inset, 0 0 0 3px var(--accent)':'none')+';"></div>';
  }).join('');
}
function _mttsPlantPickColor(hex){
  document.getElementById('mttsPlantColor').value=hex;
  _mttsRenderPlantColorGrid(hex);
  _mttsPlantColorPopupClose();
}

// Pop-up swatch picker — overlays the plant edit modal so the colour grid
// doesn't permanently take up space in the form. Esc closes; click outside
// the box closes (handled by the overlay's own onclick).
function _mttsPlantColorPopupOpen(){
  var pop=document.getElementById('mttsPlantColorPopup');if(!pop) return;
  // Refresh grid with the latest selection before showing.
  var cur=document.getElementById('mttsPlantColor').value||'#fed7aa';
  _mttsRenderPlantColorGrid(cur);
  pop.style.display='flex';
  if(!pop._mttsKey){
    pop._mttsKey=function(ev){if(ev.key==='Escape'){_mttsPlantColorPopupClose();}};
    document.addEventListener('keydown',pop._mttsKey);
  }
}
function _mttsPlantColorPopupClose(){
  var pop=document.getElementById('mttsPlantColorPopup');if(!pop) return;
  pop.style.display='none';
  if(pop._mttsKey){document.removeEventListener('keydown',pop._mttsKey);pop._mttsKey=null;}
}

// Inline delete helper — confirms then routes through the same path the
// modal's Delete button uses. Reference check is repeated server-side too.
async function _mttsPlantDeleteFromTable(id){
  if(!_mttsHasAccess('action.editPlant')){notify('Access denied',true);return;}
  var p=byId(DB.mttsPlants||[],id);if(!p) return;
  var refsAsset=(DB.mttsAssets||[]).filter(function(a){return a&&a.plant===p.id;}).length;
  var refsTicket=(DB.mttsTickets||[]).filter(function(t){return t&&t.plant===p.id;}).length;
  if(refsAsset||refsTicket){
    notify('⚠ Cannot delete — '+refsAsset+' asset(s) and '+refsTicket+' ticket(s) reference this plant',true);
    return;
  }
  if(!confirm('Delete plant "'+(p.name||p.id)+'"? This cannot be undone.')) return;
  var idx=(DB.mttsPlants||[]).indexOf(p);
  var ok=await _dbDel('mttsPlants',p.id);
  if(!ok){notify('Delete failed',true);return;}
  if(idx>=0) DB.mttsPlants.splice(idx,1);
  notify('🗑 Plant deleted');
  _mttsRenderPlants();
  _mttsPopulatePlantOptions();
}

function _mttsPlantOpen(id){
  if(!_mttsHasAccess('action.editPlant')&&id===''){notify('You do not have permission to add plants',true);return;}
  var p=id?(byId(DB.mttsPlants||[],id)||null):null;
  document.getElementById('mttsPlantTitle').textContent=p?'🏭 Edit Plant':'🏭 Add Plant';
  document.getElementById('mttsPlantIdHidden').value=p?p.id:'';
  // Short Code: always editable. If references exist, save() will cascade
  // the rename to assets/tickets after a confirmation prompt.
  var codeInput=document.getElementById('mttsPlantCode');
  codeInput.value=p?p.id:'';
  codeInput.readOnly=false;
  codeInput.style.background='';
  codeInput.title='Short Code — editable. Renaming will update all referencing assets / tickets.';
  document.getElementById('mttsPlantName').value=p?(p.name||''):'';
  document.getElementById('mttsPlantAddress').value=p?(p.address||''):'';
  var initialColor=(p&&p.color)?p.color:'#fed7aa';
  document.getElementById('mttsPlantColor').value=initialColor;
  _mttsRenderPlantColorGrid(initialColor);
  document.getElementById('mttsPlantInactive').checked=!!(p&&p.inactive);
  // Delete is exposed only on the Plant Master table row (not in this
  // modal) so the modal stays focused on add / edit.
  var err=document.getElementById('mttsPlantErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsPlant'); else { document.getElementById('mMttsPlant').classList.add('open'); }
  // Keyboard shortcuts: Enter saves (unless inside the multi-line address
  // textarea, where Enter inserts a newline as expected), Escape cancels.
  // Listener is attached once per modal-open so closed-state keys don't
  // fire stale handlers.
  var modalEl=document.getElementById('mMttsPlant');
  if(modalEl){
    if(modalEl._mttsKeyHandler) modalEl.removeEventListener('keydown',modalEl._mttsKeyHandler);
    modalEl._mttsKeyHandler=function(ev){
      if(modalEl.style.display==='none'||!modalEl.classList.contains('open')) return;
      if(ev.key==='Escape'){ev.preventDefault();cm('mMttsPlant');return;}
      if(ev.key==='Enter'){
        var tag=ev.target&&ev.target.tagName;
        if(tag==='TEXTAREA') return;// allow newlines in address
        ev.preventDefault();_mttsPlantSave();
      }
    };
    modalEl.addEventListener('keydown',modalEl._mttsKeyHandler);
  }
  // Auto-focus the first empty required field for fast keyboard entry.
  setTimeout(function(){
    var first=document.getElementById(p?'mttsPlantName':'mttsPlantCode');
    if(first&&typeof first.focus==='function') first.focus();
  },50);
}

async function _mttsPlantSave(){
  if(!_mttsHasAccess('action.editPlant')){notify('Access denied',true);return;}
  var err=document.getElementById('mttsPlantErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var _t=function(elId){var el=document.getElementById(elId);if(!el) return '';var v=String(el.value||'').replace(/^[\s ]+|[\s ]+$/g,'');el.value=v;return v;};
  var existingId=document.getElementById('mttsPlantIdHidden').value;
  var code=_t('mttsPlantCode');
  var name=_t('mttsPlantName');
  var address=_t('mttsPlantAddress');
  var color=document.getElementById('mttsPlantColor').value||'';
  var inactive=document.getElementById('mttsPlantInactive').checked;
  if(!code){_showErr('Code is required');return;}
  if(!/^[A-Za-z0-9_-]{1,20}$/.test(code)){_showErr('Code must be alphanumeric (- and _ allowed), max 20 chars');return;}
  if(!name){_showErr('Name is required');return;}
  // Code uniqueness — check against all plants OTHER than this one.
  var dup=(DB.mttsPlants||[]).find(function(x){return x&&x.id===code&&x.id!==existingId;});
  if(dup){_showErr('Code "'+code+'" already exists');return;}
  if(existingId){
    var p=byId(DB.mttsPlants||[],existingId);
    if(!p){_showErr('Plant not found');return;}
    var bak=Object.assign({},p);
    var oldCode=p.id;
    var codeChanged=(code!==oldCode);
    // Cascade rename: when the Short Code changes and other rows reference
    // the old code, update each referrer's foreign-key field, then delete
    // the old master row from the DB. Confirm with the user since this is
    // a multi-row update that can't be cleanly rolled back if interrupted.
    var refAssets=(DB.mttsAssets||[]).filter(function(a){return a&&a.plant===oldCode;});
    var refTickets=(DB.mttsTickets||[]).filter(function(t){return t&&t.plant===oldCode;});
    if(codeChanged&&(refAssets.length||refTickets.length)){
      if(!confirm('Rename Short Code "'+oldCode+'" → "'+code+'"?\n\n'+refAssets.length+' asset(s) and '+refTickets.length+' ticket(s) will be updated to the new code.\n\nProceed?')) return;
    }
    p.id=code;p.name=name;p.address=address;p.color=color;p.inactive=inactive;
    var ok=await _dbSave('mttsPlants',p);
    if(!ok){Object.assign(p,bak);_showErr('Save failed');return;}
    if(codeChanged){
      // Cascade-update referencing rows.
      for(var i=0;i<refAssets.length;i++){
        refAssets[i].plant=code;
        try{await _dbSave('mttsAssets',refAssets[i]);}catch(e){console.warn('cascade asset',e);}
      }
      for(var j=0;j<refTickets.length;j++){
        refTickets[j].plant=code;
        try{await _dbSave('mttsTickets',refTickets[j]);}catch(e){console.warn('cascade ticket',e);}
      }
      // Delete the old master row from the DB (in-memory record was
      // re-id'd in place above, so just drop the stale code from the
      // server).
      try{await _dbDel('mttsPlants',oldCode);}catch(e){console.warn('drop old plant',e);}
    }
    notify('✓ Plant updated'+(codeChanged?(' · '+(refAssets.length+refTickets.length)+' reference(s) updated'):''));
  } else {
    var newP={id:code,name:name,address:address,color:color,inactive:inactive};
    if(!DB.mttsPlants) DB.mttsPlants=[];
    DB.mttsPlants.push(newP);
    var ok2=await _dbSave('mttsPlants',newP);
    if(!ok2){
      DB.mttsPlants=DB.mttsPlants.filter(function(x){return x!==newP;});
      _showErr('Save failed');return;
    }
    notify('✓ Plant added');
  }
  cm('mMttsPlant');
  _mttsRenderPlants();
  _mttsPopulatePlantOptions();// refresh dropdowns elsewhere
}

async function _mttsPlantDelete(){
  if(!_mttsHasAccess('action.editPlant')){notify('Access denied',true);return;}
  var existingId=document.getElementById('mttsPlantIdHidden').value;
  if(!existingId) return;
  var p=byId(DB.mttsPlants||[],existingId);if(!p) return;
  var refsAsset=(DB.mttsAssets||[]).filter(function(a){return a&&a.plant===p.id;}).length;
  var refsTicket=(DB.mttsTickets||[]).filter(function(t){return t&&t.plant===p.id;}).length;
  if(refsAsset||refsTicket){
    notify('⚠ Cannot delete — '+refsAsset+' asset(s) and '+refsTicket+' ticket(s) reference this plant',true);
    return;
  }
  if(!confirm('Delete plant "'+(p.name||p.id)+'"? This cannot be undone.')) return;
  var idx=(DB.mttsPlants||[]).indexOf(p);
  var ok=await _dbDel('mttsPlants',p.id);
  if(!ok){notify('Delete failed',true);return;}
  if(idx>=0) DB.mttsPlants.splice(idx,1);
  cm('mMttsPlant');
  notify('🗑 Plant deleted');
  _mttsRenderPlants();
  _mttsPopulatePlantOptions();
}

// One-time legacy seed: when mttsPlants is completely empty AND the global
// PLANTS constant is populated, copy each entry into the master so existing
// asset / ticket records (whose `plant` was P1, P2…) keep resolving. Runs
// silently on launch; subsequent launches skip the seed once any plant
// exists.
async function _mttsSeedPlantsIfEmpty(){
  if(Array.isArray(DB.mttsPlants)&&DB.mttsPlants.length) return;
  if(typeof PLANTS==='undefined'||!Array.isArray(PLANTS)||!PLANTS.length) return;
  if(!_mttsHasAccess('action.editPlant')) return;
  if(!DB.mttsPlants) DB.mttsPlants=[];
  for(var i=0;i<PLANTS.length;i++){
    var src=PLANTS[i];
    var rec={id:src.value,name:src.label||src.value,address:'',color:src.colour||'',inactive:false};
    DB.mttsPlants.push(rec);
    try{await _dbSave('mttsPlants',rec);}catch(e){console.warn('seed plant',e);}
  }
  console.log('mtts: seeded '+PLANTS.length+' plants from legacy PLANTS constant');
}


// ═══ ASSET TYPE MASTER ══════════════════════════════════════════════════════
// CRUD for the MTTS asset type list. Asset types live in mtts_asset_types
// and are used by the Asset Master form, Raise Ticket form, and asset filters.
// Delete is blocked when any asset still uses the type code. Mirrors Plant
// Master functionality (popup colour palette, row-click, Enter/Esc, etc.).

// Helper: list all asset types (sorted by name) — optionally include inactive.
function _mttsAssetTypeList(includeInactive){
  return (DB.mttsAssetTypes||[])
    .filter(function(t){return t&&(includeInactive||!t.inactive);})
    .slice()
    .sort(function(a,b){return(a.name||'').localeCompare(b.name||'');})
    .map(function(t){return {value:t.id,label:t.name||t.id,color:t.color||''};});
}
function _mttsAssetTypeLabel(code){
  if(!code) return '';
  var t=byId(DB.mttsAssetTypes||[],code);
  return t?(t.name||code):code;
}
function _mttsAssetTypeColor(code){
  if(!code) return '';
  var t=byId(DB.mttsAssetTypes||[],code);
  return t?(t.color||''):'';
}

function _mttsRenderAssetTypes(){
  var wrap=document.getElementById('mttsAtypeTableWrap');if(!wrap) return;
  var hideInactive=!!(document.getElementById('mttsAtypeHideInactive')||{}).checked;
  var rows=(DB.mttsAssetTypes||[]).slice().filter(function(t){return t&&(!hideInactive||!t.inactive);});
  rows.sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});

  // Reference counts: assets that use each type code AND primary names
  // that are tagged to it. Either being non-zero blocks delete.
  var refsAsset={};
  (DB.mttsAssets||[]).forEach(function(a){if(a&&a.assetType) refsAsset[a.assetType]=(refsAsset[a.assetType]||0)+1;});
  var refsPrim={};
  (DB.mttsAssetPrimaryNames||[]).forEach(function(p){if(p&&p.assetType) refsPrim[p.assetType]=(refsPrim[p.assetType]||0)+1;});

  var sumEl=document.getElementById('mttsAtypeSummary');
  if(sumEl) sumEl.innerHTML='Total: <b>'+(DB.mttsAssetTypes||[]).length+'</b> · Active: <b>'+(DB.mttsAssetTypes||[]).filter(function(t){return t&&!t.inactive;}).length+'</b> · Showing: <b>'+rows.length+'</b>';
  if(!rows.length){
    wrap.innerHTML='<div class="empty-state" style="padding:30px 20px;text-align:center;color:var(--text3)">No asset types yet. Click <b>+ Add Asset Type</b> to create one.</div>';
    return;
  }
  var th='padding:8px 12px;font-size:13px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;position:sticky;top:0;z-index:1';
  var td='padding:8px 12px;font-size:14px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var html='<div style="overflow:auto;border:1.5px solid var(--border);border-radius:8px;background:#fff;width:fit-content;max-width:100%">'+
    '<table style="width:auto;border-collapse:collapse;font-size:14px"><thead><tr>'+
      '<th style="'+th+'">#</th>'+
      '<th style="'+th+'">Code</th>'+
      '<th style="'+th+'">Name</th>'+
      '<th style="'+th+';text-align:right">Assets</th>'+
      '<th style="'+th+';text-align:right">Primary Names</th>'+
      '<th style="'+th+'">Status</th>'+
      '<th style="'+th+';text-align:center;width:90px">Actions</th>'+
    '</tr></thead><tbody>';
  var canEdit=_mttsHasAccess('action.editAssetType');
  rows.forEach(function(t,i){
    var idEsc=String(t.id||'').replace(/'/g,"\\'");
    var swatch=t.color?'<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:'+t.color+';border:1px solid rgba(0,0,0,.1);vertical-align:middle;margin-right:6px"></span>':'';
    var aRef=refsAsset[t.id]||0;
    var pRef=refsPrim[t.id]||0;
    var canDelete=canEdit&&aRef===0&&pRef===0;
    var blockMsg=[];
    if(aRef) blockMsg.push(aRef+' asset(s)');
    if(pRef) blockMsg.push(pRef+' primary name(s)');
    var deleteBtn=canDelete
      ? '<button onclick="event.stopPropagation();_mttsAtypeDeleteFromTable(\''+idEsc+'\')" title="Delete asset type" style="font-size:12px;padding:4px 9px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer;margin-left:3px">🗑</button>'
      : '<button disabled title="In use — referenced by '+blockMsg.join(' + ')+'" style="font-size:12px;padding:4px 9px;font-weight:700;background:#f1f5f9;border:1px solid var(--border);color:#cbd5e1;border-radius:4px;cursor:not-allowed;margin-left:3px">🗑</button>';
    html+='<tr onclick="_mttsAtypeOpen(\''+idEsc+'\')" style="cursor:pointer" onmouseover="this.style.background=\'#f8fafc\'" onmouseout="this.style.background=\'\'">'+
      '<td style="'+td+';color:var(--text3);font-family:var(--mono)">'+(i+1)+'</td>'+
      '<td style="'+td+';font-family:var(--mono);font-weight:800;color:var(--accent)">'+swatch+(t.id||'')+'</td>'+
      '<td style="'+td+';font-weight:700">'+(t.name||'—')+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+aRef+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+pRef+'</td>'+
      '<td style="'+td+'">'+(t.inactive?'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#fee2e2;color:#7f1d1d">Inactive</span>':'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#dcfce7;color:#15803d">Active</span>')+'</td>'+
      '<td style="'+td+';text-align:center;white-space:nowrap">'+
        '<button onclick="event.stopPropagation();_mttsAtypeOpen(\''+idEsc+'\')" title="Edit asset type" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer">✎</button>'+
        deleteBtn+
      '</td>'+
    '</tr>';
  });
  html+='</tbody></table></div>';
  wrap.innerHTML=html;
}

function _mttsRenderAtypeColorGrid(currentHex){
  var current=String(currentHex||'').toLowerCase();
  var swatch=document.getElementById('mttsAtypeColorSwatch');if(swatch) swatch.style.background=currentHex;
  var hex=document.getElementById('mttsAtypeColorHex');if(hex) hex.textContent=current;
  var grid=document.getElementById('mttsAtypeColorGrid');if(!grid) return;
  grid.innerHTML=_MTTS_PLANT_PALETTE.map(function(c){
    var isOn=c.toLowerCase()===current;
    return '<div onclick="_mttsAtypePickColor(\''+c+'\')" title="'+c+'" '+
      'style="width:28px;height:28px;border-radius:4px;background:'+c+';cursor:pointer;'+
      'border:'+(isOn?'2px solid #1e293b':'1px solid rgba(0,0,0,.08)')+';'+
      'box-shadow:'+(isOn?'0 0 0 2px #fff inset, 0 0 0 3px var(--accent)':'none')+';"></div>';
  }).join('');
}
function _mttsAtypePickColor(hex){
  document.getElementById('mttsAtypeColor').value=hex;
  _mttsRenderAtypeColorGrid(hex);
  _mttsAtypeColorPopupClose();
}
function _mttsAtypeColorPopupOpen(){
  var pop=document.getElementById('mttsAtypeColorPopup');if(!pop) return;
  var cur=document.getElementById('mttsAtypeColor').value||'#dbeafe';
  _mttsRenderAtypeColorGrid(cur);
  pop.style.display='flex';
  if(!pop._mttsKey){
    pop._mttsKey=function(ev){if(ev.key==='Escape'){_mttsAtypeColorPopupClose();}};
    document.addEventListener('keydown',pop._mttsKey);
  }
}
function _mttsAtypeColorPopupClose(){
  var pop=document.getElementById('mttsAtypeColorPopup');if(!pop) return;
  pop.style.display='none';
  if(pop._mttsKey){document.removeEventListener('keydown',pop._mttsKey);pop._mttsKey=null;}
}

async function _mttsAtypeDeleteFromTable(id){
  if(!_mttsHasAccess('action.editAssetType')){notify('Access denied',true);return;}
  var t=byId(DB.mttsAssetTypes||[],id);if(!t) return;
  var aRef=(DB.mttsAssets||[]).filter(function(a){return a&&a.assetType===t.id;}).length;
  var pRef=(DB.mttsAssetPrimaryNames||[]).filter(function(p){return p&&p.assetType===t.id;}).length;
  if(aRef||pRef){
    var msgs=[];
    if(aRef) msgs.push(aRef+' asset(s)');
    if(pRef) msgs.push(pRef+' primary name(s)');
    notify('⚠ Cannot delete — referenced by '+msgs.join(' + '),true);
    return;
  }
  if(!confirm('Delete asset type "'+(t.name||t.id)+'"? This cannot be undone.')) return;
  var idx=(DB.mttsAssetTypes||[]).indexOf(t);
  var ok=await _dbDel('mttsAssetTypes',t.id);
  if(!ok){notify('Delete failed',true);return;}
  if(idx>=0) DB.mttsAssetTypes.splice(idx,1);
  notify('🗑 Asset type deleted');
  _mttsRenderAssetTypes();
  _mttsPopulateAssetTypeOptions();
}

function _mttsAtypeOpen(id){
  if(!_mttsHasAccess('action.editAssetType')&&id===''){notify('You do not have permission to add asset types',true);return;}
  var t=id?(byId(DB.mttsAssetTypes||[],id)||null):null;
  document.getElementById('mttsAtypeTitle').textContent=t?'🏷 Edit Asset Type':'🏷 Add Asset Type';
  document.getElementById('mttsAtypeIdHidden').value=t?t.id:'';
  var codeInput=document.getElementById('mttsAtypeCode');
  codeInput.value=t?t.id:'';
  codeInput.readOnly=false;
  codeInput.style.background='';
  codeInput.title='Short Code — editable. Renaming will update all referencing assets.';
  document.getElementById('mttsAtypeName').value=t?(t.name||''):'';
  var initialColor=(t&&t.color)?t.color:'#dbeafe';
  document.getElementById('mttsAtypeColor').value=initialColor;
  _mttsRenderAtypeColorGrid(initialColor);
  document.getElementById('mttsAtypeInactive').checked=!!(t&&t.inactive);
  var err=document.getElementById('mttsAtypeErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsAtype'); else { document.getElementById('mMttsAtype').classList.add('open'); }
  var modalEl=document.getElementById('mMttsAtype');
  if(modalEl){
    if(modalEl._mttsKeyHandler) modalEl.removeEventListener('keydown',modalEl._mttsKeyHandler);
    modalEl._mttsKeyHandler=function(ev){
      if(modalEl.style.display==='none'||!modalEl.classList.contains('open')) return;
      if(ev.key==='Escape'){ev.preventDefault();cm('mMttsAtype');return;}
      if(ev.key==='Enter'){
        var tag=ev.target&&ev.target.tagName;
        if(tag==='TEXTAREA') return;
        ev.preventDefault();_mttsAtypeSave();
      }
    };
    modalEl.addEventListener('keydown',modalEl._mttsKeyHandler);
  }
  setTimeout(function(){
    var first=document.getElementById(t?'mttsAtypeName':'mttsAtypeCode');
    if(first&&typeof first.focus==='function') first.focus();
  },50);
}

async function _mttsAtypeSave(){
  if(!_mttsHasAccess('action.editAssetType')){notify('Access denied',true);return;}
  var err=document.getElementById('mttsAtypeErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var _t=function(elId){var el=document.getElementById(elId);if(!el) return '';var v=String(el.value||'').replace(/^[\s ]+|[\s ]+$/g,'');el.value=v;return v;};
  var existingId=document.getElementById('mttsAtypeIdHidden').value;
  var code=_t('mttsAtypeCode');
  var name=_t('mttsAtypeName');
  var color=document.getElementById('mttsAtypeColor').value||'';
  var inactive=document.getElementById('mttsAtypeInactive').checked;
  if(!code){_showErr('Code is required');return;}
  if(!/^[A-Za-z0-9 _-]{1,30}$/.test(code)){_showErr('Code must be alphanumeric (- _ space allowed), max 30 chars');return;}
  if(!name){_showErr('Name is required');return;}
  var dup=(DB.mttsAssetTypes||[]).find(function(x){return x&&x.id===code&&x.id!==existingId;});
  if(dup){_showErr('Code "'+code+'" already exists');return;}
  if(existingId){
    var t=byId(DB.mttsAssetTypes||[],existingId);
    if(!t){_showErr('Asset type not found');return;}
    var bak=Object.assign({},t);
    var oldCode=t.id;
    var codeChanged=(code!==oldCode);
    var refAssets=(DB.mttsAssets||[]).filter(function(a){return a&&a.assetType===oldCode;});
    if(codeChanged&&refAssets.length){
      if(!confirm('Rename Short Code "'+oldCode+'" → "'+code+'"?\n\n'+refAssets.length+' asset(s) will be updated to the new code.\n\nProceed?')) return;
    }
    t.id=code;t.name=name;t.color=color;t.inactive=inactive;
    var ok=await _dbSave('mttsAssetTypes',t);
    if(!ok){Object.assign(t,bak);_showErr('Save failed');return;}
    if(codeChanged){
      for(var i=0;i<refAssets.length;i++){
        refAssets[i].assetType=code;
        try{await _dbSave('mttsAssets',refAssets[i]);}catch(e){console.warn('cascade asset',e);}
      }
      try{await _dbDel('mttsAssetTypes',oldCode);}catch(e){console.warn('drop old atype',e);}
    }
    notify('✓ Asset type updated'+(codeChanged?(' · '+refAssets.length+' asset(s) updated'):''));
  } else {
    var newT={id:code,name:name,color:color,inactive:inactive};
    if(!DB.mttsAssetTypes) DB.mttsAssetTypes=[];
    DB.mttsAssetTypes.push(newT);
    var ok2=await _dbSave('mttsAssetTypes',newT);
    if(!ok2){
      DB.mttsAssetTypes=DB.mttsAssetTypes.filter(function(x){return x!==newT;});
      _showErr('Save failed');return;
    }
    notify('✓ Asset type added');
  }
  cm('mMttsAtype');
  _mttsRenderAssetTypes();
  _mttsPopulateAssetTypeOptions();
}

// Refresh any open Asset Type <select> dropdowns elsewhere in the app.
function _mttsPopulateAssetTypeOptions(){
  // Asset edit modal + Raise-ticket form both use chip pickers now —
  // re-render them so newly-added types appear immediately.
  if(document.getElementById('mttsAssetTypeBtns')&&typeof _mttsAssetRenderTypeBtns==='function') _mttsAssetRenderTypeBtns();
  if(document.getElementById('mttsRaiseTypeBtns')&&typeof _mttsRaiseRenderTypeBtns==='function') _mttsRaiseRenderTypeBtns();
}

// One-time legacy seed: populate from the historical hard-coded list when
// the table is empty so existing assets keep resolving.
async function _mttsSeedAssetTypesIfEmpty(){
  if(Array.isArray(DB.mttsAssetTypes)&&DB.mttsAssetTypes.length) return;
  if(!_mttsHasAccess('action.editAssetType')) return;
  if(!DB.mttsAssetTypes) DB.mttsAssetTypes=[];
  var seed=[
    {id:'Machinery',name:'Machinery',color:'#bfdbfe'},
    {id:'Building',name:'Building',color:'#fde68a'},
    {id:'Furniture',name:'Furniture',color:'#fed7aa'},
    {id:'IT Devices',name:'IT Devices',color:'#a5f3fc'},
    {id:'Electrical Devices',name:'Electrical Devices',color:'#ddd6fe'}
  ];
  for(var i=0;i<seed.length;i++){
    var rec=Object.assign({inactive:false},seed[i]);
    DB.mttsAssetTypes.push(rec);
    try{await _dbSave('mttsAssetTypes',rec);}catch(e){console.warn('seed asset type',e);}
  }
  console.log('mtts: seeded '+seed.length+' asset types');
}


// ═══ ASSET PRIMARY NAME MASTER ══════════════════════════════════════════════
// Curated list of base asset names. The Asset edit form picks a Primary
// Name from this list and adds a free-text Name Extension (e.g. "8KW",
// "Top Coat") so users avoid misspelling the common stem. Uniqueness on
// (plant + primary + extension) is enforced in _mttsAssetSave.

function _mttsAssetPrimaryNameList(includeInactive,typeFilter){
  return (DB.mttsAssetPrimaryNames||[])
    .filter(function(p){
      if(!p) return false;
      if(!includeInactive&&p.inactive) return false;
      if(typeFilter&&p.assetType!==typeFilter) return false;
      return true;
    })
    .slice()
    .sort(function(a,b){return(a.name||'').localeCompare(b.name||'');})
    .map(function(p){return {value:p.id,label:p.name||p.id,assetType:p.assetType||'',color:p.color||''};});
}
function _mttsAssetPrimaryNameLabel(code){
  if(!code) return '';
  var p=byId(DB.mttsAssetPrimaryNames||[],code);
  return p?(p.name||code):code;
}

function _mttsRenderAssetPrimaryNames(){
  var wrap=document.getElementById('mttsAprimTableWrap');if(!wrap) return;
  var hideInactive=!!(document.getElementById('mttsAprimHideInactive')||{}).checked;
  var rows=(DB.mttsAssetPrimaryNames||[]).slice().filter(function(p){return p&&(!hideInactive||!p.inactive);});
  rows.sort(function(a,b){
    var t=String(_mttsAssetTypeLabel(a.assetType)||'').localeCompare(String(_mttsAssetTypeLabel(b.assetType)||''));
    if(t) return t;
    return(a.name||'').localeCompare(b.name||'');
  });
  // Reference counts: assets that use each primary name AND agencies
  // that tag this primary name in their handled-list. Either blocks delete.
  var refsAsset={};
  (DB.mttsAssets||[]).forEach(function(a){if(a&&a.primaryName) refsAsset[a.primaryName]=(refsAsset[a.primaryName]||0)+1;});
  var refsAgency={};
  (DB.mttsAgencies||[]).forEach(function(ag){
    if(!ag||!Array.isArray(ag.primaryNames)) return;
    ag.primaryNames.forEach(function(pn){if(pn) refsAgency[pn]=(refsAgency[pn]||0)+1;});
  });
  var sumEl=document.getElementById('mttsAprimSummary');
  if(sumEl) sumEl.innerHTML='Total: <b>'+(DB.mttsAssetPrimaryNames||[]).length+'</b> · Active: <b>'+(DB.mttsAssetPrimaryNames||[]).filter(function(p){return p&&!p.inactive;}).length+'</b> · Showing: <b>'+rows.length+'</b>';
  // Hide "+ Add" when the user can't edit.
  var addBtn=document.getElementById('btnMttsAddAprim');
  if(addBtn) addBtn.style.display=_mttsHasAccess('action.editAssetPrimaryName')?'':'none';
  if(!rows.length){
    wrap.innerHTML='<div class="empty-state" style="padding:30px 20px;text-align:center;color:var(--text3)">No primary names yet. Click <b>+ Add Primary Name</b> to create one.</div>';
    return;
  }
  var th='padding:8px 12px;font-size:13px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;position:sticky;top:0;z-index:1';
  var td='padding:8px 12px;font-size:14px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var html='<div style="overflow:auto;border:1.5px solid var(--border);border-radius:8px;background:#fff;width:fit-content;max-width:100%">'+
    '<table style="width:auto;border-collapse:collapse;font-size:14px"><thead><tr>'+
      '<th style="'+th+'">#</th>'+
      '<th style="'+th+'">Asset Type</th>'+
      '<th style="'+th+'">Name</th>'+
      '<th style="'+th+';text-align:right">Assets</th>'+
      '<th style="'+th+';text-align:right">Agencies</th>'+
      '<th style="'+th+'">Status</th>'+
      '<th style="'+th+';text-align:center;width:90px">Actions</th>'+
    '</tr></thead><tbody>';
  var canEdit=_mttsHasAccess('action.editAssetPrimaryName');
  rows.forEach(function(p,i){
    var idEsc=String(p.id||'').replace(/'/g,"\\'");
    var swatch=p.color?'<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:'+p.color+';border:1px solid rgba(0,0,0,.1);vertical-align:middle;margin-right:6px"></span>':'';
    var aRef=refsAsset[p.id]||0;
    var gRef=refsAgency[p.id]||0;
    var canDelete=canEdit&&aRef===0&&gRef===0;
    var blockMsg=[];
    if(aRef) blockMsg.push(aRef+' asset(s)');
    if(gRef) blockMsg.push(gRef+' agency(s)');
    var deleteBtn=canDelete
      ? '<button onclick="event.stopPropagation();_mttsAprimDeleteFromTable(\''+idEsc+'\')" title="Delete" style="font-size:12px;padding:4px 9px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer;margin-left:3px">🗑</button>'
      : '<button disabled title="In use — referenced by '+blockMsg.join(' + ')+'" style="font-size:12px;padding:4px 9px;font-weight:700;background:#f1f5f9;border:1px solid var(--border);color:#cbd5e1;border-radius:4px;cursor:not-allowed;margin-left:3px">🗑</button>';
    html+='<tr onclick="_mttsAprimOpen(\''+idEsc+'\')" style="cursor:pointer" onmouseover="this.style.background=\'#f8fafc\'" onmouseout="this.style.background=\'\'">'+
      '<td style="'+td+';color:var(--text3);font-family:var(--mono)">'+(i+1)+'</td>'+
      '<td style="'+td+';font-weight:600;color:var(--text2)">'+(p.assetType?_mttsAssetTypeLabel(p.assetType):'—')+'</td>'+
      '<td style="'+td+';font-weight:700">'+swatch+(p.name||'—')+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+aRef+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+gRef+'</td>'+
      '<td style="'+td+'">'+(p.inactive?'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#fee2e2;color:#7f1d1d">Inactive</span>':'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#dcfce7;color:#15803d">Active</span>')+'</td>'+
      '<td style="'+td+';text-align:center;white-space:nowrap">'+
        '<button onclick="event.stopPropagation();_mttsAprimOpen(\''+idEsc+'\')" title="Edit" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer">✎</button>'+
        deleteBtn+
      '</td>'+
    '</tr>';
  });
  html+='</tbody></table></div>';
  wrap.innerHTML=html;
}

function _mttsRenderAprimColorGrid(currentHex){
  var current=String(currentHex||'').toLowerCase();
  var swatch=document.getElementById('mttsAprimColorSwatch');if(swatch) swatch.style.background=currentHex;
  var hex=document.getElementById('mttsAprimColorHex');if(hex) hex.textContent=current;
  var grid=document.getElementById('mttsAprimColorGrid');if(!grid) return;
  grid.innerHTML=_MTTS_PLANT_PALETTE.map(function(c){
    var isOn=c.toLowerCase()===current;
    return '<div onclick="_mttsAprimPickColor(\''+c+'\')" title="'+c+'" '+
      'style="width:28px;height:28px;border-radius:4px;background:'+c+';cursor:pointer;'+
      'border:'+(isOn?'2px solid #1e293b':'1px solid rgba(0,0,0,.08)')+';'+
      'box-shadow:'+(isOn?'0 0 0 2px #fff inset, 0 0 0 3px var(--accent)':'none')+';"></div>';
  }).join('');
}
function _mttsAprimPickColor(hex){
  document.getElementById('mttsAprimColor').value=hex;
  _mttsRenderAprimColorGrid(hex);
  _mttsAprimColorPopupClose();
}
function _mttsAprimColorPopupOpen(){
  var pop=document.getElementById('mttsAprimColorPopup');if(!pop) return;
  var cur=document.getElementById('mttsAprimColor').value||'#bbf7d0';
  _mttsRenderAprimColorGrid(cur);
  pop.style.display='flex';
  if(!pop._mttsKey){
    pop._mttsKey=function(ev){if(ev.key==='Escape'){_mttsAprimColorPopupClose();}};
    document.addEventListener('keydown',pop._mttsKey);
  }
}
function _mttsAprimColorPopupClose(){
  var pop=document.getElementById('mttsAprimColorPopup');if(!pop) return;
  pop.style.display='none';
  if(pop._mttsKey){document.removeEventListener('keydown',pop._mttsKey);pop._mttsKey=null;}
}

async function _mttsAprimDeleteFromTable(id){
  if(!_mttsHasAccess('action.editAssetPrimaryName')){notify('Access denied',true);return;}
  var p=byId(DB.mttsAssetPrimaryNames||[],id);if(!p) return;
  var aRef=(DB.mttsAssets||[]).filter(function(a){return a&&a.primaryName===p.id;}).length;
  var gRef=(DB.mttsAgencies||[]).filter(function(ag){return ag&&Array.isArray(ag.primaryNames)&&ag.primaryNames.indexOf(p.id)>=0;}).length;
  if(aRef||gRef){
    var msgs=[];
    if(aRef) msgs.push(aRef+' asset(s)');
    if(gRef) msgs.push(gRef+' agency(s)');
    notify('⚠ Cannot delete — referenced by '+msgs.join(' + '),true);
    return;
  }
  if(!confirm('Delete primary name "'+(p.name||p.id)+'"? This cannot be undone.')) return;
  var idx=(DB.mttsAssetPrimaryNames||[]).indexOf(p);
  var ok=await _dbDel('mttsAssetPrimaryNames',p.id);
  if(!ok){notify('Delete failed',true);return;}
  if(idx>=0) DB.mttsAssetPrimaryNames.splice(idx,1);
  notify('🗑 Primary name deleted');
  _mttsRenderAssetPrimaryNames();
  _mttsPopulateAssetPrimaryNameOptions();
}

function _mttsAprimOpen(id){
  if(!_mttsHasAccess('action.editAssetPrimaryName')&&id===''){notify('You do not have permission to add primary names',true);return;}
  var p=id?(byId(DB.mttsAssetPrimaryNames||[],id)||null):null;
  document.getElementById('mttsAprimTitle').textContent=p?'🔤 Edit Primary Name':'🔤 Add Primary Name';
  document.getElementById('mttsAprimIdHidden').value=p?p.id:'';
  // Populate the Asset Type dropdown freshly (so newly-added types are
  // pickable) and reflect the current value if editing.
  var typeSel=document.getElementById('mttsAprimAssetType');
  if(typeSel){
    var typesArr=_mttsAssetTypeList(true);
    typeSel.innerHTML='<option value="">— Select —</option>'+typesArr.map(function(t){
      return '<option value="'+t.value+'">'+t.label+'</option>';
    }).join('');
    typeSel.value=p?(p.assetType||''):'';
  }
  document.getElementById('mttsAprimName').value=p?(p.name||''):'';
  var initialColor=(p&&p.color)?p.color:'#bbf7d0';
  document.getElementById('mttsAprimColor').value=initialColor;
  _mttsRenderAprimColorGrid(initialColor);
  document.getElementById('mttsAprimInactive').checked=!!(p&&p.inactive);
  var err=document.getElementById('mttsAprimErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsAprim'); else { document.getElementById('mMttsAprim').classList.add('open'); }
  var modalEl=document.getElementById('mMttsAprim');
  if(modalEl){
    if(modalEl._mttsKeyHandler) modalEl.removeEventListener('keydown',modalEl._mttsKeyHandler);
    modalEl._mttsKeyHandler=function(ev){
      if(modalEl.style.display==='none'||!modalEl.classList.contains('open')) return;
      if(ev.key==='Escape'){ev.preventDefault();cm('mMttsAprim');return;}
      if(ev.key==='Enter'){
        var tag=ev.target&&ev.target.tagName;
        if(tag==='TEXTAREA') return;
        ev.preventDefault();_mttsAprimSave();
      }
    };
    modalEl.addEventListener('keydown',modalEl._mttsKeyHandler);
  }
  setTimeout(function(){
    var first=document.getElementById('mttsAprimName');
    if(first&&typeof first.focus==='function') first.focus();
  },50);
}

async function _mttsAprimSave(){
  if(!_mttsHasAccess('action.editAssetPrimaryName')){notify('Access denied',true);return;}
  var err=document.getElementById('mttsAprimErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var _t=function(elId){var el=document.getElementById(elId);if(!el) return '';var v=String(el.value||'').replace(/^[\s ]+|[\s ]+$/g,'');el.value=v;return v;};
  var existingId=document.getElementById('mttsAprimIdHidden').value;
  var assetType=document.getElementById('mttsAprimAssetType').value;
  var name=_t('mttsAprimName');
  // Name doubles as the row's identifier — there's no separate short code.
  var code=name;
  var color=document.getElementById('mttsAprimColor').value||'';
  var inactive=document.getElementById('mttsAprimInactive').checked;
  if(!assetType){_showErr('Asset Type is required');return;}
  if(!name){_showErr('Name is required');return;}
  var dup=(DB.mttsAssetPrimaryNames||[]).find(function(x){return x&&String(x.id||'').toLowerCase()===code.toLowerCase()&&x.id!==existingId;});
  if(dup){_showErr('"'+name+'" already exists');return;}
  if(existingId){
    var p=byId(DB.mttsAssetPrimaryNames||[],existingId);
    if(!p){_showErr('Primary name not found');return;}
    var bak=Object.assign({},p);
    var oldCode=p.id;
    var codeChanged=(code!==oldCode);
    var refAssets=(DB.mttsAssets||[]).filter(function(a){return a&&a.primaryName===oldCode;});
    if(codeChanged&&refAssets.length){
      if(!confirm('Rename "'+oldCode+'" → "'+name+'"?\n\n'+refAssets.length+' asset(s) will be updated.\n\nProceed?')) return;
    }
    p.id=code;p.name=name;p.assetType=assetType;p.color=color;p.inactive=inactive;
    var ok=await _dbSave('mttsAssetPrimaryNames',p);
    if(!ok){Object.assign(p,bak);_showErr('Save failed');return;}
    if(codeChanged){
      for(var i=0;i<refAssets.length;i++){
        refAssets[i].primaryName=code;
        // Recompose the asset's stored name field so display stays in sync.
        var ext=refAssets[i].nameExtension||'';
        refAssets[i].name=ext?(name+'-'+ext):name;
        try{await _dbSave('mttsAssets',refAssets[i]);}catch(e){console.warn('cascade asset',e);}
      }
      try{await _dbDel('mttsAssetPrimaryNames',oldCode);}catch(e){console.warn('drop old aprim',e);}
    }
    notify('✓ Primary name updated'+(codeChanged?(' · '+refAssets.length+' asset(s) updated'):''));
  } else {
    var newP={id:code,name:name,assetType:assetType,color:color,inactive:inactive};
    if(!DB.mttsAssetPrimaryNames) DB.mttsAssetPrimaryNames=[];
    DB.mttsAssetPrimaryNames.push(newP);
    var ok2=await _dbSave('mttsAssetPrimaryNames',newP);
    if(!ok2){
      DB.mttsAssetPrimaryNames=DB.mttsAssetPrimaryNames.filter(function(x){return x!==newP;});
      _showErr('Save failed');return;
    }
    notify('✓ Primary name added');
  }
  cm('mMttsAprim');
  _mttsRenderAssetPrimaryNames();
  _mttsPopulateAssetPrimaryNameOptions();
}

function _mttsPopulateAssetPrimaryNameOptions(typeFilter){
  // When called without a typeFilter, default to whatever the asset
  // edit modal's Asset Type select currently shows so the dropdown is
  // always scoped to the relevant type.
  if(typeFilter===undefined){
    var typeEl=document.getElementById('mttsAssetType');
    typeFilter=typeEl?typeEl.value:'';
  }
  var list=_mttsAssetPrimaryNameList(false,typeFilter);
  var sel=document.getElementById('mttsAssetPrimary');
  if(sel){
    var cur=sel.value;
    var placeholder=typeFilter?'— Select —':'— Select Asset Type first —';
    sel.innerHTML='<option value="">'+placeholder+'</option>'+list.map(function(p){
      return '<option value="'+p.value+'">'+p.label+'</option>';
    }).join('');
    // Keep the current selection only if it still belongs to the active type.
    var stillValid=Array.prototype.some.call(sel.options||[],function(o){return o.value===cur;});
    sel.value=stillValid?cur:'';
  }
}

// First-run seed: derive initial primary names from each unique existing
// asset name, so legacy assets resolve cleanly under the new schema.
async function _mttsSeedAssetPrimaryNamesIfEmpty(){
  if(Array.isArray(DB.mttsAssetPrimaryNames)&&DB.mttsAssetPrimaryNames.length) return;
  if(!_mttsHasAccess('action.editAssetPrimaryName')) return;
  if(!DB.mttsAssetPrimaryNames) DB.mttsAssetPrimaryNames=[];
  var seen={};
  var seed=[];
  (DB.mttsAssets||[]).forEach(function(a){
    if(!a||!a.name) return;
    var nm=String(a.name).trim();if(!nm) return;
    var key=nm.toLowerCase();
    if(seen[key]) return;
    seen[key]=true;
    seed.push({id:nm,name:nm,assetType:a.assetType||'',color:'#bbf7d0',inactive:false});
  });
  if(!seed.length) return;
  for(var i=0;i<seed.length;i++){
    DB.mttsAssetPrimaryNames.push(seed[i]);
    try{await _dbSave('mttsAssetPrimaryNames',seed[i]);}catch(e){console.warn('seed primary name',e);}
  }
  console.log('mtts: seeded '+seed.length+' primary names from existing asset names');
}


// ═══ AGENCY / VENDOR MASTER ════════════════════════════════════════════════
// External service vendors (electricals, fabricators, agencies). Each row
// captures contact details + a multi-select list of primary asset names
// the agency handles, so a manager allocating a job can find candidates.

function _mttsRenderAgencies(){
  var wrap=document.getElementById('mttsAgencyTableWrap');if(!wrap) return;
  var hideInactive=!!(document.getElementById('mttsAgencyHideInactive')||{}).checked;
  var searchEl=document.getElementById('mttsAgencySearch');
  var search=String((searchEl&&searchEl.value)||'').toLowerCase().trim();
  // Hide "+ Add" when the user can't edit.
  var addBtn=document.getElementById('btnMttsAddAgency');
  if(addBtn) addBtn.style.display=_mttsHasAccess('action.editAgency')?'':'none';

  var rows=(DB.mttsAgencies||[]).slice().filter(function(a){return a&&(!hideInactive||!a.inactive);});
  if(search){
    rows=rows.filter(function(a){
      var prims=(a.primaryNames||[]).join(' ');
      var hay=(a.name||'')+' '+(a.contactName||'')+' '+(a.email||'')+' '+(a.contact1||'')+' '+(a.contact2||'')+' '+(a.address||'')+' '+prims;
      return hay.toLowerCase().indexOf(search)>=0;
    });
  }
  rows.sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});

  var sumEl=document.getElementById('mttsAgencySummary');
  if(sumEl) sumEl.innerHTML='Total: <b>'+(DB.mttsAgencies||[]).length+'</b> · Active: <b>'+(DB.mttsAgencies||[]).filter(function(a){return a&&!a.inactive;}).length+'</b> · Showing: <b>'+rows.length+'</b>';
  if(!rows.length){
    wrap.innerHTML='<div class="empty-state" style="padding:30px 20px;text-align:center;color:var(--text3)">'+(search?'No agencies match the search.':'No agencies yet. Click <b>+ Add Agency</b> to create one.')+'</div>';
    return;
  }
  var th='padding:8px 12px;font-size:13px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;position:sticky;top:0;z-index:1';
  var td='padding:8px 12px;font-size:14px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var html='<div style="overflow:auto;border:1.5px solid var(--border);border-radius:8px;background:#fff">'+
    '<table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr>'+
      '<th style="'+th+'">#</th>'+
      '<th style="'+th+'">Agency / Vendor</th>'+
      '<th style="'+th+'">Contact</th>'+
      '<th style="'+th+'">Email / Phone</th>'+
      '<th style="'+th+'">Primary Names</th>'+
      '<th style="'+th+'">Status</th>'+
      '<th style="'+th+';text-align:center;width:100px">Actions</th>'+
    '</tr></thead><tbody>';
  var canEdit=_mttsHasAccess('action.editAgency');
  rows.forEach(function(a,i){
    var idEsc=String(a.id||'').replace(/'/g,"\\'");
    var prims=(a.primaryNames||[]);
    var primChips=prims.length?prims.map(function(p){return '<span style="display:inline-block;padding:1px 8px;border-radius:8px;font-size:11px;font-weight:700;background:#eef2ff;color:#4338ca;margin:1px 2px">'+String(p).replace(/</g,'&lt;')+'</span>';}).join(''):'<span style="color:var(--text3);font-style:italic">—</span>';
    var phones=[a.contact1,a.contact2].filter(Boolean).join(' · ');
    var deleteBtn=canEdit
      ? '<button onclick="event.stopPropagation();_mttsAgencyDeleteFromTable(\''+idEsc+'\')" title="Delete" style="font-size:12px;padding:4px 9px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer;margin-left:3px">🗑</button>'
      : '';
    html+='<tr onclick="_mttsAgencyOpen(\''+idEsc+'\')" style="cursor:pointer" onmouseover="this.style.background=\'#f8fafc\'" onmouseout="this.style.background=\'\'">'+
      '<td style="'+td+';color:var(--text3);font-family:var(--mono)">'+(i+1)+'</td>'+
      '<td style="'+td+';font-weight:800">'+(a.name||'—')+
        (a.address?'<div style="font-size:11px;color:var(--text3);font-weight:500;margin-top:2px">'+String(a.address).replace(/</g,'&lt;').replace(/\n/g,', ')+'</div>':'')+'</td>'+
      '<td style="'+td+';font-size:13px">'+(a.contactName||'—')+'</td>'+
      '<td style="'+td+';font-size:12px">'+
        (a.email?'<div>📧 '+a.email+'</div>':'')+
        (phones?'<div>📞 '+phones+'</div>':'')+
        (!a.email&&!phones?'<span style="color:var(--text3)">—</span>':'')+'</td>'+
      '<td style="'+td+'">'+primChips+'</td>'+
      '<td style="'+td+'">'+(a.inactive?'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#fee2e2;color:#7f1d1d">Inactive</span>':'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#dcfce7;color:#15803d">Active</span>')+'</td>'+
      '<td style="'+td+';text-align:center;white-space:nowrap">'+
        (canEdit?'<button onclick="event.stopPropagation();_mttsAgencyOpen(\''+idEsc+'\')" title="Edit" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer">✎</button>':'<span style="color:var(--text3)">—</span>')+
        deleteBtn+
      '</td>'+
    '</tr>';
  });
  html+='</tbody></table></div>';
  wrap.innerHTML=html;
}

// Selected primary-name set carried across the modal lifecycle. Stored as
// an array on the modal element so it survives re-renders of the list.
function _mttsAgencyRefreshPrimList(){
  var listEl=document.getElementById('mttsAgencyPrimList');if(!listEl) return;
  var modal=document.getElementById('mMttsAgency');
  var picked=(modal&&modal._mttsPrim)||[];
  var filterEl=document.getElementById('mttsAgencyPrimFilter');
  var filter=String((filterEl&&filterEl.value)||'').toLowerCase().trim();
  var groups={};
  (DB.mttsAssetPrimaryNames||[]).forEach(function(p){
    if(!p||p.inactive) return;
    if(filter&&String(p.name||'').toLowerCase().indexOf(filter)<0) return;
    var t=p.assetType||'(Unspecified)';
    if(!groups[t]) groups[t]=[];
    groups[t].push(p);
  });
  var keys=Object.keys(groups).sort();
  if(!keys.length){
    listEl.innerHTML='<div style="padding:10px;font-size:11px;color:var(--text3)">No primary names match.</div>';
  } else {
    listEl.innerHTML=keys.map(function(t){
      var items=groups[t].sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});
      return '<div style="font-size:10px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:1px;padding:6px 8px 3px">'+t+'</div>'+
        items.map(function(p){
          var checked=picked.indexOf(p.id)>=0?'checked':'';
          var idAttr=String(p.id||'').replace(/"/g,'&quot;');
          return '<label style="display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:1px solid #f1f5f9;cursor:pointer;font-size:13px"><input type="checkbox" class="mtts-agency-prim-cb" data-pid="'+idAttr+'" onchange="_mttsAgencyTogglePrim(this)" '+checked+' style="width:auto!important;height:auto!important;flex:0 0 auto;margin:0;cursor:pointer"><span>'+(p.name||p.id)+'</span></label>';
        }).join('');
    }).join('');
  }
  var selEl=document.getElementById('mttsAgencyPrimSel');
  if(selEl) selEl.innerHTML='Selected: <b>'+picked.length+'</b>'+(picked.length?' — '+picked.map(function(x){return String(x).replace(/</g,'&lt;');}).join(', '):'');
}
function _mttsAgencyTogglePrim(cb){
  var modal=document.getElementById('mMttsAgency');if(!modal) return;
  if(!modal._mttsPrim) modal._mttsPrim=[];
  var pid=cb.getAttribute('data-pid');
  var idx=modal._mttsPrim.indexOf(pid);
  if(cb.checked){if(idx<0) modal._mttsPrim.push(pid);}
  else if(idx>=0){modal._mttsPrim.splice(idx,1);}
  // Just refresh the summary line — no need to re-render the whole list.
  var selEl=document.getElementById('mttsAgencyPrimSel');
  if(selEl) selEl.innerHTML='Selected: <b>'+modal._mttsPrim.length+'</b>'+(modal._mttsPrim.length?' — '+modal._mttsPrim.map(function(x){return String(x).replace(/</g,'&lt;');}).join(', '):'');
}

function _mttsAgencyOpen(id){
  if(!_mttsHasAccess('action.editAgency')&&id===''){notify('You do not have permission to add agencies',true);return;}
  var a=id?(byId(DB.mttsAgencies||[],id)||null):null;
  document.getElementById('mttsAgencyTitle').textContent=a?'🤝 Edit Agency':'🤝 Add Agency';
  document.getElementById('mttsAgencyIdHidden').value=a?a.id:'';
  document.getElementById('mttsAgencyName').value=a?(a.name||''):'';
  document.getElementById('mttsAgencyAddress').value=a?(a.address||''):'';
  document.getElementById('mttsAgencyContact').value=a?(a.contactName||''):'';
  document.getElementById('mttsAgencyEmail').value=a?(a.email||''):'';
  document.getElementById('mttsAgencyPhone1').value=a?(a.contact1||''):'';
  document.getElementById('mttsAgencyPhone2').value=a?(a.contact2||''):'';
  document.getElementById('mttsAgencyInactive').checked=!!(a&&a.inactive);
  document.getElementById('mttsAgencyPrimFilter').value='';
  var modal=document.getElementById('mMttsAgency');
  modal._mttsPrim=(a&&Array.isArray(a.primaryNames))?a.primaryNames.slice():[];
  _mttsAgencyRefreshPrimList();
  var err=document.getElementById('mttsAgencyErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsAgency'); else { document.getElementById('mMttsAgency').classList.add('open'); }
  if(modal){
    if(modal._mttsKeyHandler) modal.removeEventListener('keydown',modal._mttsKeyHandler);
    modal._mttsKeyHandler=function(ev){
      if(modal.style.display==='none'||!modal.classList.contains('open')) return;
      if(ev.key==='Escape'){ev.preventDefault();cm('mMttsAgency');return;}
      if(ev.key==='Enter'){
        var tag=ev.target&&ev.target.tagName;
        if(tag==='TEXTAREA') return;
        ev.preventDefault();_mttsAgencySave();
      }
    };
    modal.addEventListener('keydown',modal._mttsKeyHandler);
  }
  setTimeout(function(){
    var first=document.getElementById('mttsAgencyName');
    if(first&&typeof first.focus==='function') first.focus();
  },50);
}

async function _mttsAgencySave(){
  if(!_mttsHasAccess('action.editAgency')){notify('Access denied',true);return;}
  var err=document.getElementById('mttsAgencyErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var _t=function(elId){var el=document.getElementById(elId);if(!el) return '';var v=String(el.value||'').replace(/^[\s ]+|[\s ]+$/g,'');el.value=v;return v;};
  var existingId=document.getElementById('mttsAgencyIdHidden').value;
  var name=_t('mttsAgencyName');
  var address=_t('mttsAgencyAddress');
  var contactName=_t('mttsAgencyContact');
  var email=_t('mttsAgencyEmail');
  var contact1=_t('mttsAgencyPhone1');
  var contact2=_t('mttsAgencyPhone2');
  var inactive=document.getElementById('mttsAgencyInactive').checked;
  var modal=document.getElementById('mMttsAgency');
  var prims=(modal&&Array.isArray(modal._mttsPrim))?modal._mttsPrim.slice():[];
  if(!name){_showErr('Agency name is required');return;}
  // Name uniqueness (case-insensitive) across all agencies.
  var nameKey=name.toLowerCase();
  var dup=(DB.mttsAgencies||[]).find(function(x){
    if(!x||x.id===existingId) return false;
    return String(x.name||'').toLowerCase()===nameKey;
  });
  if(dup){_showErr('"'+name+'" already exists');return;}
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){_showErr('Email looks invalid');return;}
  if(existingId){
    var ag=byId(DB.mttsAgencies||[],existingId);
    if(!ag){_showErr('Agency not found');return;}
    var bak=Object.assign({},ag);
    ag.name=name;ag.address=address;ag.contactName=contactName;ag.email=email;
    ag.contact1=contact1;ag.contact2=contact2;ag.primaryNames=prims;ag.inactive=inactive;
    var ok=await _dbSave('mttsAgencies',ag);
    if(!ok){Object.assign(ag,bak);_showErr('Save failed');return;}
    notify('✓ Agency updated');
  } else {
    var newAg={id:'ag'+uid(),name:name,address:address,contactName:contactName,email:email,
      contact1:contact1,contact2:contact2,primaryNames:prims,inactive:inactive};
    if(!DB.mttsAgencies) DB.mttsAgencies=[];
    DB.mttsAgencies.push(newAg);
    var ok2=await _dbSave('mttsAgencies',newAg);
    if(!ok2){
      DB.mttsAgencies=DB.mttsAgencies.filter(function(x){return x!==newAg;});
      _showErr('Save failed');return;
    }
    notify('✓ Agency added');
  }
  cm('mMttsAgency');
  _mttsRenderAgencies();
}

async function _mttsAgencyDeleteFromTable(id){
  if(!_mttsHasAccess('action.editAgency')){notify('Access denied',true);return;}
  var ag=byId(DB.mttsAgencies||[],id);if(!ag) return;
  if(!confirm('Delete agency "'+(ag.name||ag.id)+'"? This cannot be undone.')) return;
  var idx=(DB.mttsAgencies||[]).indexOf(ag);
  var ok=await _dbDel('mttsAgencies',ag.id);
  if(!ok){notify('Delete failed',true);return;}
  if(idx>=0) DB.mttsAgencies.splice(idx,1);
  notify('🗑 Agency deleted');
  _mttsRenderAgencies();
}

