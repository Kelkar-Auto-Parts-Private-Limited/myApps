// ═══ MAINTENANCE TICKET TRACKING SYSTEM (MTTS) ═════════════════════════════
// Phase 1: Asset Master CRUD + transfer history.
// Phase 2 (planned): ticket lifecycle (raise → allocate → act → close → approve)
// Phase 3 (planned): dashboard (counts / costs / PM-AMC-warranty due-overdue)

// Tables this app needs at boot. appSettings is included because the
// shared rolePermissions blob lives there (used by permCanView /
// permCanAct against MTTS keys).
if(typeof _APP_TABLES!=='undefined') _APP_TABLES=['users','locations','appSettings','mttsPlants','mttsAssetTypes','mttsAssetPrimaryNames','mttsAgencies','mttsAssets','mttsTickets'];

// V38 — Strip heavy photo / history JSONB columns at boot. Loaded on-demand
// by _mttsLoadTicketPhotos / _mttsLoadAssetHistory when the user opens the
// detail / approve / edit modals. Before this, MTTS was fetching every
// stored photo (multi-MB per ticket) on every page reload — that was the
// "MTTS is slow to reload" complaint.
//   mtts_tickets: keep status, assignment, tech_actions (for audit /
//     timeline / bdCategory), cost / approval. Skip the three top-level
//     photo arrays (raise / close / invoice) — they're only shown in the
//     detail overlay.
//   mtts_assets: skip transfer_history — only shown in the asset edit
//     modal's history tab.
var _SYNC_SELECT={
  'mtts_tickets':'id,code,asset_code,plant,asset_id,plant_id,breakdown_type,breakdown_since,status,raised_by,raised_at,assigned_to,assigned_at,assigned_by,tech_actions,root_cause,cost_service,cost_spares,approved_by,approved_at,updated_at',
  // V18 (260520) — pm_applicable + pm_schedule included in boot; pm_history
  // intentionally OMITTED (loaded on demand by _mttsLoadAssetPmHistory —
  // base64 job-card photos can be multi-MB per asset).
  'mtts_assets':'id,code,plant,asset_type,primary_name,plant_id,asset_type_id,primary_name_id,name_extension,dashboard_name,name,description,serial_no,install_date,make,model,warranty,amc,criticality,status,pm_applicable,pm_schedule,updated_at',
  // V90 — strip users.photo at MTTS boot.
  'vms_users':'id,code,name,full_name,mobile,email,roles,hwms_roles,hrms_roles,mtts_roles,apps,inactive,updated_at'
};
// V90 — preserve on-demand user photos across MTTS syncs.
var _PHOTO_PRESERVE = { 'users':['photo'] };
var _PHOTO_DB_COLS  = { 'vms_users':['photo'] };

// V92 (260518) — Date-filtered boot for mtts_tickets. Most active work is
// on tickets raised in the last ~90 days; older ones are closed history
// rarely needed except for archival lookup. Boot now pulls only the
// recent window, which dramatically shrinks the boot payload (was ~15 MB
// from tech_actions accumulating over years; cap drops it to ~2-3 MB).
// Older tickets become accessible on demand via the existing search /
// "load older" flows (or a future _mttsLoadOlderTicketsOnce helper).
var _DATE_FILTER_DAYS=90;
var _DATE_FILTER_COL={
  'mtts_tickets':'raised_at'
};

// V38 — Lazy-fetch the three photo arrays for one ticket. Dedup tracker
// avoids re-fetching when the same ticket is opened multiple times.
// Returns the in-memory record once the merge is done (or immediately if
// already loaded). Called by every modal that reads / writes those photos.
var _mttsLoadedTicketPhotos={};
var _mttsInflightTicketPhotos={};
async function _mttsLoadTicketPhotos(id){
  if(!id||!_sbReady||!_sb) return null;
  var rec=byId(DB.mttsTickets||[],id); if(!rec) return null;
  if(_mttsLoadedTicketPhotos[id]) return rec;
  if(_mttsInflightTicketPhotos[id]) return _mttsInflightTicketPhotos[id];
  _mttsInflightTicketPhotos[id]=(async function(){
    try{
      var res=await _sb.from(SB_TABLES['mttsTickets'])
        .select('code,photos_raise,close_photos,invoice_photos')
        .eq('code',id).limit(1);
      if(res.error||!res.data||!res.data.length) return rec;
      var row=res.data[0];
      rec.photosRaise=row.photos_raise||[];
      rec.closePhotos=row.close_photos||[];
      rec.invoicePhotos=row.invoice_photos||[];
      _mttsLoadedTicketPhotos[id]=true;
      return rec;
    }catch(e){ console.warn('_mttsLoadTicketPhotos error:',id,e&&e.message); return rec; }
    finally{ delete _mttsInflightTicketPhotos[id]; }
  })();
  return _mttsInflightTicketPhotos[id];
}

// V38 — Same pattern for asset transfer_history.
var _mttsLoadedAssetHistory={};
var _mttsInflightAssetHistory={};
async function _mttsLoadAssetHistory(id){
  if(!id||!_sbReady||!_sb) return null;
  var rec=byId(DB.mttsAssets||[],id); if(!rec) return null;
  if(_mttsLoadedAssetHistory[id]) return rec;
  if(_mttsInflightAssetHistory[id]) return _mttsInflightAssetHistory[id];
  _mttsInflightAssetHistory[id]=(async function(){
    try{
      var res=await _sb.from(SB_TABLES['mttsAssets'])
        .select('code,transfer_history')
        .eq('code',id).limit(1);
      if(res.error||!res.data||!res.data.length) return rec;
      rec.transferHistory=res.data[0].transfer_history||[];
      _mttsLoadedAssetHistory[id]=true;
      return rec;
    }catch(e){ console.warn('_mttsLoadAssetHistory error:',id,e&&e.message); return rec; }
    finally{ delete _mttsInflightAssetHistory[id]; }
  })();
  return _mttsInflightAssetHistory[id];
}

// ── Boot: re-auth from session, then launch ────────────────────────────────
(function(){
  // V8 — Legacy dark-blue #dbSplash retired. The white overlay from
  // _navigateTo (on the prior page) covers the navigation transition;
  // body stays hidden until _mttsLaunch flips it on, so there's no FOUC
  // while bootDB runs. No second loading screen.
  // Wait for Supabase + DB to load (handled in common.js bootDB).
  // V91 — access gate: users without MTTS access bounce back to portal.
  if(typeof _gateAppAccess==='function' && !_gateAppAccess('mtts')) return;
  if(typeof bootDB==='function'){
    bootDB().then(function(){
      var u=_sessionGet('kap_session_user');
      var t=_sessionGet('kap_session_token');
      console.log('[mtts boot] session user='+u+' token='+(t?'present':'MISSING')+' DB.users.len='+((DB.users||[]).length));
      if(!u||!t){console.warn('[mtts boot] BOUNCE — no session');_navigateTo('index.html');return;}
      var uobj=(DB.users||[]).find(function(x){return x&&x.name&&x.name.toLowerCase()===String(u).toLowerCase();});
      if(!uobj){console.warn('[mtts boot] BOUNCE — user "'+u+'" not in DB.users (have '+((DB.users||[]).length)+' users)');_navigateTo('index.html');return;}
      CU=uobj;
      if(typeof _enrichCU==='function') _enrichCU();
      _mttsLaunch();
    }).catch(function(e){console.error('[mtts boot] BOUNCE — bootDB threw:',e&&e.message);_navigateTo('index.html');});
  } else {
    console.error('[mtts boot] bootDB is not a function — common.js failed to load');
  }
})();

// V8 (260520) — Topbar avatar renderer: writes the user's photo if
// loaded, otherwise the first 1-2 initials of fullName/name.
// Idempotent — call again after a photo load to swap in the image.
function _mttsRenderTopbarAvatar(){
  if(!CU) return;
  var av=document.getElementById('mttsTopbarAvatar');
  if(!av) return;
  if(CU.photo){
    av.innerHTML='<img src="'+String(CU.photo).replace(/"/g,'&quot;')+'" alt="" style="width:100%;height:100%;object-fit:cover">';
    av.style.background='transparent';
    return;
  }
  var initials=(CU.fullName||CU.name||'').trim().split(/\s+/).map(function(w){return w[0]||'';}).slice(0,2).join('').toUpperCase()||'👤';
  av.style.background='linear-gradient(135deg,#2563eb,#7c3aed)';
  av.style.color='#fff';
  av.style.fontWeight='900';
  av.style.fontSize=initials.length>1?'13px':'15px';
  av.textContent=initials;
}

function _mttsLaunch(){
  // V9 — Boot IIFE no longer flips body to visible; it's done here so the
  // page only paints once #mttsApp is ready and the (legacy) blue splash
  // is hidden — i.e., one clean transition from the _navigateTo white
  // overlay straight into the app.
  document.body.style.display='block';
  var splash=document.getElementById('dbSplash');if(splash) splash.style.display='none';
  document.getElementById('mttsApp').style.display='block';
  // V3 — Boot diagnostic so an admin-role mismatch is visible in DevTools.
  try{
    console.log('[mtts launch] user='+(CU&&CU.name)+' platRoles='+JSON.stringify(CU&&CU.roles||[])+' mttsRoles='+JSON.stringify(CU&&CU.mttsRoles||[])+' apps='+JSON.stringify(CU&&CU.apps||[])+' isSA='+_mttsIsSA()+' isMttsAdmin='+_mttsIsMttsAdmin()+' isManager='+_mttsIsManager()+' page.dashboard='+_mttsHasAccess('page.dashboard'));
  }catch(_){}
  // V8 (260520) — Avatar rendering: writes the user's photo (if loaded)
  // or initials to the new topbar avatar widget. The sidebar IDs are
  // now hidden placeholders — written for legacy compatibility only.
  _mttsRenderTopbarAvatar();
  var av=document.getElementById('mttsAvatar');
  var nm=document.getElementById('mttsUserFullName');
  var rl=document.getElementById('mttsUserRole');
  if(av) av.textContent=(CU.fullName||CU.name||'?').slice(0,1).toUpperCase();
  if(nm) nm.textContent=CU.fullName||CU.name||'';
  if(rl) rl.textContent=((CU.mttsRoles||[]).join(' · '))||((CU.roles||[]).indexOf('Super Admin')>=0?'Super Admin':'—');
  var tbu=document.getElementById('mttsTopbarUser');
  if(tbu) tbu.textContent=CU.fullName||CU.name||'';
  _mttsEnforcePermissions();
  // 260519-V33 — Re-run nav visibility whenever CU changes mid-session
  // (admin revokes a role / grants one / changes permissions while the
  // user is already in MTTS). Without this the sidebar stays frozen at
  // boot-time access and shows tabs the user no longer can open.
  _onCurrentUserUpdated=function(){
    try{ _mttsEnforcePermissions(); }catch(_){}
    // V8 (260520) — Refresh topbar avatar so an updated photo / name
    // taken from a fresh DB.users record shows immediately.
    try{ _mttsRenderTopbarAvatar(); }catch(_){}
    // If the user lost access to the currently-active page, route them
    // somewhere safe (or to the no-access shell).
    try{
      var active=document.querySelector('.page.active');
      var pid=active?active.id:'';
      var permKey={pageMttsDashboard:'page.dashboard',pageMttsPlants:'page.plants',pageMttsAssetTypes:'page.assetTypes',pageMttsAssetPrimaryNames:'page.assetPrimaryNames',pageMttsAgencies:'page.agencies',pageMttsAssets:'page.assets',pageMttsTickets:'page.tickets'}[pid];
      if(permKey && !_mttsHasAccess(permKey)){
        if(_mttsHasAccess('page.tickets')) mttsGo('pageMttsTickets');
        else if(_mttsHasAccess('page.dashboard')) mttsGo('pageMttsDashboard');
        else if(_mttsHasAccess('page.assets')) mttsGo('pageMttsAssets');
        else _mttsRenderNoAccessShell();
      }
    }catch(_){}
  };
  // First-run seed: populate the Plant Master from the legacy PLANTS
  // constant so existing assets / tickets (created before the master
  // existed) keep resolving by code. Re-render dropdowns afterwards.
  // Auto-seed disabled: masters now reflect exactly what's in the DB.
  // If a master is empty, it stays empty until the user explicitly adds
  // a row. (Old behaviour re-seeded legacy plants / asset types from a
  // hard-coded list whenever the table was empty — that's been the
  // source of "deleted items reappear" reports.)
  _mttsPopulatePlantOptions();
  _mttsPopulateAssetTypeOptions();
  _mttsPopulateAssetPrimaryNameOptions();
  if(typeof _mttsUpdateTicketBadge==='function') _mttsUpdateTicketBadge();
  // Wire background polling (_bgSyncHot) + on-demand sync to re-render the
  // active MTTS page. Without this, the 60s hot-table poll lands fresh
  // rows in DB but never repaints — so the user only sees updates after
  // a manual refresh. Realtime path already calls _rtRefreshFor.
  _onRefreshViews=function(){
    try{
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
    }catch(e){}
  };
  // V13 — Default landing flipped back to the Tickets page for testing.
  // Dashboard / Assets remain as fallbacks if the user lacks ticket
  // access. (V156 made Dashboard the default; reverted on user request.)
  if(_mttsHasAccess('page.tickets')) mttsGo('pageMttsTickets');
  else if(_mttsHasAccess('page.dashboard')) mttsGo('pageMttsDashboard');
  else if(_mttsHasAccess('page.assets')) mttsGo('pageMttsAssets');
  else _mttsRenderNoAccessShell();
  // Backfill any legacy ticket ids ("tabc12345") to the new <year>T<seq>
  // format. Idempotent: tickets already in the new format are left alone.
  // Runs in the background so it doesn't block the first paint.
  setTimeout(function(){
    if(typeof _mttsBackfillTicketIds==='function') _mttsBackfillTicketIds();
  },800);
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
        // V82/V86 — drop attImportLog + raw import-file rows; MTTS doesn't use either.
        var q=_sb.from(sbTbl).select(sel).limit(10000);
        if(sbTbl==='app_settings'){
          q=q.neq('key','attImportLog')
             .not('key','like','attImpFile_*')
             .not('key','like','altImpFile_*')
             .not('key','like','advImpFile_*');
        }
        var res=await q;
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
function _mttsIsTechnician(){
  return CU&&(CU.mttsRoles||[]).indexOf('Technician')>=0;
}
function _mttsIsManager(){
  return CU&&(CU.mttsRoles||[]).indexOf('Maintenance Manager')>=0;
}
// V1 — MTTS Admin is registered as a module-admin role in _PERM_MODULE_ADMIN
// but was missing from the local helper, so it never got the module-wide
// bypass in _mttsHasAccess. Treated identically to Super Admin / Manager.
function _mttsIsMttsAdmin(){
  return CU&&(CU.mttsRoles||[]).indexOf('MTTS Admin')>=0;
}
// V26 — Detect a WIP ticket that's been "Partial work done" — i.e.
// paused mid-work. Reads techActions backwards looking for the most
// recent activity entry; if it's partial_done (and the ticket is still
// in WIP), the tech needs to Resume before posting another update.
function _mttsIsPartialPaused(t){
  if(!t||t.status!=='work_in_progress') return false;
  var acts=Array.isArray(t.techActions)?t.techActions:[];
  for(var i=acts.length-1;i>=0;i--){
    var a=acts[i]; if(!a) continue;
    if(a.action==='partial_done') return true;
    if(a.action==='work_in_progress') return false;
    // Other actions (raised/allocated/reassigned/etc.) skip.
  }
  return false;
}
// V27 — Effective WIP elapsed (ms) across all start / pause / resume
// cycles. Walks techActions, pairing each work_in_progress with the
// next partial_done; the trailing open work_in_progress (no later
// partial_done) accrues from its `at` up to now (or up to the latest
// partial_done if paused — handled by the loop). Returns 0 if the
// ticket isn't in work_in_progress.
function _mttsWipElapsedMs(t){
  if(!t||t.status!=='work_in_progress') return 0;
  var acts=Array.isArray(t.techActions)?t.techActions:[];
  var total=0, lastStart=null;
  for(var i=0;i<acts.length;i++){
    var a=acts[i]; if(!a) continue;
    if(a.action==='work_in_progress'){
      lastStart=a.at?new Date(a.at).getTime():null;
    } else if(a.action==='partial_done' && lastStart!=null){
      var pauseT=a.at?new Date(a.at).getTime():lastStart;
      total += Math.max(0, pauseT - lastStart);
      lastStart=null;
    }
  }
  // Trailing open interval (currently working — no later partial_done).
  if(lastStart!=null) total += Math.max(0, Date.now() - lastStart);
  return total;
}
// Render a labeled count "chip" used on every master / list page header.
// Each kind gets its own colour so the user can spot Total / Showing /
// Active / Open / Closed / etc. at a glance instead of reading the
// dot-separated text line. Falls back to a neutral slate chip for any
// unrecognised kind.
function _mttsCountChip(label,val,kind){
  var palette={
    total:    {bg:'#1e293b',acc:'#94a3b8'},
    showing:  {bg:'#1d4ed8',acc:'#bfdbfe'},
    active:   {bg:'#16a34a',acc:'#bbf7d0'},
    inactive: {bg:'#dc2626',acc:'#fecaca'},
    machinery:{bg:'#7c3aed',acc:'#ddd6fe'},
    building: {bg:'#0891b2',acc:'#a5f3fc'},
    furniture:{bg:'#ea580c',acc:'#fed7aa'},
    it:       {bg:'#0d9488',acc:'#99f6e4'},
    electrical:{bg:'#ca8a04',acc:'#fde68a'},
    open:     {bg:'#dc2626',acc:'#fecaca'},
    assigned: {bg:'#1d4ed8',acc:'#bfdbfe'},
    spares:   {bg:'#a16207',acc:'#fde68a'},
    agency:   {bg:'#7c3aed',acc:'#ddd6fe'},
    done:     {bg:'#0891b2',acc:'#a5f3fc'},
    closed:   {bg:'#16a34a',acc:'#bbf7d0'},
    scrap:    {bg:'#475569',acc:'#cbd5e1'},
    info:     {bg:'#475569',acc:'#cbd5e1'}
  };
  var c=palette[kind]||palette.info;
  return '<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:7px;background:'+c.bg+';color:#fff;font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;margin:2px 4px 2px 0;border:1.5px solid '+c.acc+'">'+
    '<span style="opacity:.92">'+label+'</span>'+
    '<b style="font-size:13px;font-weight:900;letter-spacing:0">'+val+'</b>'+
    '</span>';
}

// Centralised view-only lock for master modals (asset, plant, asset type,
// primary name, agency). Disables form fields *and* the chip rows + color
// pickers (which are <button> / <div onclick=> elements that escape the
// usual input/select/textarea lock). Cancel / × close buttons stay live so
// the user can still dismiss the modal.
function _mttsLockModal(modalEl,canEdit){
  if(!modalEl) return;
  Array.prototype.forEach.call(modalEl.querySelectorAll('input,select,textarea'),function(el){
    if(canEdit){el.disabled=false;el.readOnly=false;}else{el.disabled=true;}
  });
  Array.prototype.forEach.call(modalEl.querySelectorAll('button'),function(b){
    var oc=b.getAttribute('onclick')||'';
    var isClose=/^cm\(/.test(oc)||/\bcm\('/.test(oc)||b.classList.contains('modal-close')||b.classList.contains('btn-secondary')&&/^cm\(/.test(oc);
    // Treat Cancel and any × close button as always-live regardless of edit
    // permission — also any explicit btn-secondary that triggers cm().
    if(/^cm\(/.test(oc)) isClose=true;
    if(canEdit){b.disabled=false;b.style.pointerEvents='';b.style.opacity='';}
    else if(!isClose){b.disabled=true;b.style.pointerEvents='none';b.style.opacity='0.5';}
    else {b.disabled=false;b.style.pointerEvents='';b.style.opacity='';}
  });
  // Chip rows + color grids — divs with onclick handlers that escape the
  // input/button lock above.
  Array.prototype.forEach.call(modalEl.querySelectorAll('.mtts-chip-row,[id$="ColorGrid"]'),function(c){
    c.style.pointerEvents=canEdit?'':'none';
    c.style.opacity=canEdit?'':'0.7';
  });
}

function _mttsHasAccess(featureKey){
  if(_mttsIsSA()) return true;
  // 260519-V31 — MTTS Admin / Maintenance Manager bypasses removed.
  // Per user request, those module-admin roles are now subject to the
  // same Access Management gates as everyone else. To grant either of
  // them full access, admin must explicitly set every page/action to
  // Full in Access Management → MTTS → <role>. The matching change
  // in _PERM_MODULE_ADMIN.MTTS keeps permConfigured / permLevel from
  // silently auto-granting them either.
  // 260519-V30 — Access Management is the single source of truth once
  // admin has saved anything in MTTS. Earlier code only checked the
  // user's own roles via permConfigured(), so a Ticket Raiser whose
  // row admin hadn't touched still hit the hardcoded fallback below
  // — silently granting page.assets + page.tickets regardless of
  // admin intent ("TR/Tech getting full access" report). Now we ask:
  // has the admin configured ANY role in MTTS? If yes, every user's
  // access is fully driven by permLevel/permCanView/permCanAct — a
  // role with no saved entries gets none. Only when the whole module
  // is unconfigured (first-run / greenfield) do we drop to the legacy
  // role defaults so the app still works out of the box.
  var _mttsModulePerms=((typeof _permLoadData==='function'?_permLoadData():{})['MTTS']||{}).permissions||{};
  var _mttsModuleConfigured=Object.keys(_mttsModulePerms).some(function(r){
    var p=_mttsModulePerms[r];
    return p && typeof p==='object' && Object.keys(p).length>0;
  });
  if(_mttsModuleConfigured){
    if(/^action\./.test(featureKey)){
      return typeof permCanAct==='function' && permCanAct('MTTS',featureKey);
    }
    return typeof permCanView==='function' && permCanView('MTTS',featureKey);
  }
  // Greenfield fallback — admin hasn't configured ANYTHING in MTTS yet.
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
  // Asset / Primary Name / Agency / Tickets pages flex-fill the viewport
  // and scroll only inside their table / card grid — toggle a body flag
  // that the CSS keys off of, instead of letting both the page and the
  // inner content scroll independently.
  // V14 — Tickets page intentionally uses page-level scroll with a
  // sticky-head wrapper (cards grow freely; #pageMttsTickets .table-wrap
  // is overflow:visible in CSS). Keeping it in tightPages caps .mtts-
  // content at overflow:hidden and kills card scrolling entirely.
  var tightPages={pageMttsAssets:1,pageMttsAssetPrimaryNames:1,pageMttsAgencies:1,pageMttsPlants:1,pageMttsAssetTypes:1};
  document.body.classList.toggle('mtts-tight-page',!!tightPages[pid]);
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
// Make / model formatter — used everywhere an asset name appears so the
// reader always sees what kind of equipment it is, not just its tag.
function _mttsAssetMM(asset){
  if(!asset) return '';
  var parts=[asset.make,asset.model].filter(function(x){return x&&String(x).trim();});
  return parts.join(' / ');
}
// Recompose the asset's display name as "Primary - Extension" with spaces
// around the hyphen so legacy records (saved as "Primary-Extension") render
// the same way as new ones. Falls back to the stored asset.name when the
// primary/extension fields aren't both populated.
// V23 (260518) — Prefer the FK id (`primaryNameId` → mtts_asset_primary_names.id)
// when resolving the display label for an asset's primary name; fall
// back to the legacy `primaryName` text code so older data without an
// FK still renders. This makes the relationship genuinely id-driven:
// renaming the user-facing code on the master no longer risks orphaning
// the asset's reference.
function _mttsAssetPrimaryNameLabelByDbId(dbId){
  if(!dbId) return '';
  var arr=DB.mttsAssetPrimaryNames||[];
  for(var i=0;i<arr.length;i++){
    var p=arr[i];
    if(p && p._dbId===dbId) return p.name||p.id||'';
  }
  return '';
}
function _mttsAssetComposedName(asset){
  if(!asset) return '';
  var prim='';
  if(asset.primaryNameId) prim=_mttsAssetPrimaryNameLabelByDbId(asset.primaryNameId);
  if(!prim && asset.primaryName) prim=_mttsAssetPrimaryNameLabel(asset.primaryName)||asset.primaryName;
  var ext=asset.nameExtension||'';
  if(prim&&ext) return prim+' - '+ext;
  if(prim) return prim;
  return asset.name||'';
}
// Asset label = "{name} ({make} / {model})". Make/model is dropped when
// neither is set so the suffix never appears as empty parens.
function _mttsAssetLabel(asset,fallback){
  if(!asset) return fallback||'(missing)';
  var nm=_mttsAssetComposedName(asset)||fallback||'';
  var mm=_mttsAssetMM(asset);
  return mm?(nm+' ('+mm+')'):nm;
}
// Inline badge (chip) showing plant name on its master-defined background
// colour. Picks readable text colour by simple luminance check so dark
// backgrounds get white text.
// Resolve a master's user-facing `code` (e.g. plant 'P1') to its internal
// Postgres `id` (uuid or bigint). Used to populate FK columns on assets /
// tickets so referential integrity is enforced at the DB layer.
function _mttsResolveDbId(arr,code){
  if(!code||!Array.isArray(arr)) return null;
  var hit=arr.find(function(x){return x&&x.id===code;});
  return hit?(hit._dbId||null):null;
}

// In-place rename of a master row's `code` column. Single Postgres
// UPDATE — id-FKs don't need cascading (id is stable), and the
// AFTER-UPDATE-OF-code triggers on each master propagate the new code
// into referring tables' denormalised text columns automatically.
async function _mttsRenameMasterCode(tbl,oldCode,newCode,extraFields){
  if(!_sb||!_sbReady){notify('No DB connection',true);return false;}
  var sbTbl=SB_TABLES[tbl];if(!sbTbl) return false;
  var update=Object.assign({code:newCode},extraFields||{});
  showSpinner('Renaming…');
  try{
    var res=await _sb.from(sbTbl).update(update).eq('code',oldCode).select();
    if(res.error){
      console.error('rename error',tbl,oldCode,'→',newCode,res.error);
      notify('Rename failed: '+res.error.message,true);
      return false;
    }
    if(!res.data||!res.data.length){
      notify('Rename failed: row not found or RLS denied',true);
      return false;
    }
    return true;
  }catch(e){console.error('rename exception',e);notify('Rename failed: '+e.message,true);return false;}
  finally{hideSpinner();}
}

// Re-pull a list of MTTS tables from Supabase and replace the in-memory
// arrays. Use after operations whose effects span multiple tables (e.g.
// FK ON UPDATE CASCADE) so the screen always reflects what's actually
// persisted.
async function _mttsReloadTables(tables){
  if(!_sb||!_sbReady) return;
  for(var i=0;i<tables.length;i++){
    var tbl=tables[i];
    var sbTbl=SB_TABLES[tbl];if(!sbTbl) continue;
    try{
      var sel=typeof _syncSelect==='function'?_syncSelect(sbTbl):'*';
      var res=await _sb.from(sbTbl).select(sel).limit(10000);
      if(!res.error&&res.data) DB[tbl]=res.data.map(function(r){return _fromRow(tbl,r);}).filter(Boolean);
    }catch(e){console.warn('reload',tbl,e);}
  }
}

function _mttsPlantBadge(code){
  var lbl=_mttsPlantLabel(code);
  var bg=_mttsPlantColor(code);
  if(!bg) return '<span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:700;background:#f1f5f9;color:#1a2033;border:1px solid #e2e8f0;white-space:nowrap">'+lbl+'</span>';
  // Detect dark bg (#rrggbb) for white text.
  var hex=String(bg).replace('#','').trim();
  var fg='#1a2033';
  if(/^[0-9a-f]{6}$/i.test(hex)){
    var r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
    var lum=(0.299*r+0.587*g+0.114*b);
    if(lum<150) fg='#fff';
  }
  return '<span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:800;background:'+bg+';color:'+fg+';border:1px solid rgba(0,0,0,.08);white-space:nowrap">'+lbl+'</span>';
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
  if(document.getElementById('mttsAssetPlant')&&typeof _mttsAssetRenderPlantBtns==='function') _mttsAssetRenderPlantBtns();
}

// ── Asset Master ──────────────────────────────────────────────────────────
// In-table filter state — preserved across renders since the per-column
// dropdowns live inside the thead and get rebuilt on every _mttsRenderAssets
// call.
// V32 (260518) — sortKey + sortDir hold the table-sort state. sortKey
// is the column key (name | plant | assetType | dashboardName | mm |
// serial | installDate | criticality | status). sortDir is 'asc' or
// 'desc'. Empty key → fall back to the default plant→type→name sort.
var _mttsAssetState={plant:'',type:'',status:'Active',search:'',view:'',sortKey:'',sortDir:'asc'};
function _mttsAssetSetSort(key){
  if(_mttsAssetState.sortKey===key){
    _mttsAssetState.sortDir=(_mttsAssetState.sortDir==='asc')?'desc':'asc';
  } else {
    _mttsAssetState.sortKey=key;
    _mttsAssetState.sortDir='asc';
  }
  _mttsRenderAssets();
}
var _mttsAprimState={type:'',status:'',search:'',view:''};
// Resolve the saved view preference (cards | table) from localStorage on
// first read; default to cards. Mobile (≤700px) ignores the saved choice
// and always renders cards regardless.
// V38 — Tickets page defaults to TABLE on wide screens (storageKey ===
// 'mtts_view_ticket'); every other list (assets/agencies/plants) keeps
// the cards default. Mobile (≤700px) still ignores the saved choice.
function _mttsViewMode(stateObj,storageKey){
  if(!stateObj.view){
    var defaultView=(storageKey==='mtts_view_ticket')?'table':'cards';
    try{stateObj.view=localStorage.getItem(storageKey)||defaultView;}catch(e){stateObj.view=defaultView;}
  }
  if(window.innerWidth<=700) return 'cards';
  return stateObj.view==='table'?'table':'cards';
}
function _mttsAssetToggleView(){
  _mttsAssetState.view=(_mttsViewMode(_mttsAssetState,'mtts_view_asset')==='table')?'cards':'table';
  try{localStorage.setItem('mtts_view_asset',_mttsAssetState.view);}catch(e){}
  _mttsRenderAssets();
}
function _mttsAprimToggleView(){
  _mttsAprimState.view=(_mttsViewMode(_mttsAprimState,'mtts_view_aprim')==='table')?'cards':'table';
  try{localStorage.setItem('mtts_view_aprim',_mttsAprimState.view);}catch(e){}
  _mttsRenderAssetPrimaryNames();
}
function _mttsTicketToggleView(){
  _mttsTicketState.view=(_mttsViewMode(_mttsTicketState,'mtts_view_ticket')==='table')?'cards':'table';
  try{localStorage.setItem('mtts_view_ticket',_mttsTicketState.view);}catch(e){}
  _mttsRenderTickets();
}
// Plant / Asset Type / Agency master pages also support cards-vs-table.
var _mttsPlantState={view:''};
var _mttsAtypeState={view:''};
var _mttsAgencyState={view:''};
function _mttsPlantToggleView(){
  _mttsPlantState.view=(_mttsViewMode(_mttsPlantState,'mtts_view_plant')==='table')?'cards':'table';
  try{localStorage.setItem('mtts_view_plant',_mttsPlantState.view);}catch(e){}
  _mttsRenderPlants();
}
function _mttsAtypeToggleView(){
  _mttsAtypeState.view=(_mttsViewMode(_mttsAtypeState,'mtts_view_atype')==='table')?'cards':'table';
  try{localStorage.setItem('mtts_view_atype',_mttsAtypeState.view);}catch(e){}
  _mttsRenderAssetTypes();
}
function _mttsAgencyToggleView(){
  _mttsAgencyState.view=(_mttsViewMode(_mttsAgencyState,'mtts_view_agency')==='table')?'cards':'table';
  try{localStorage.setItem('mtts_view_agency',_mttsAgencyState.view);}catch(e){}
  _mttsRenderAgencies();
}
// Reset filters + search on each table page back to "show all" so the
// user can quickly recover from a narrow filter set. Also reset the
// DOM inputs directly — the render functions read DOM values back
// into state at the top, so clearing only state would get clobbered.
function _mttsAssetClearFilters(){
  ['mttsAssetPlantFilter','mttsAssetTypeFilter','mttsAssetSearch'].forEach(function(id){
    var el=document.getElementById(id);if(el) el.value='';
  });
  _mttsAssetState.plant='';_mttsAssetState.type='';_mttsAssetState.status='';_mttsAssetState.search='';
  // V32 (260518) — Also drop the column sort so the table returns to
  // the default plant→type→name ordering.
  _mttsAssetState.sortKey='';_mttsAssetState.sortDir='asc';
  _mttsRenderAssets();
}
function _mttsAprimClearFilters(){
  ['mttsAprimTypeFilter','mttsAprimStatusFilter','mttsAprimSearch'].forEach(function(id){
    var el=document.getElementById(id);if(el) el.value='';
  });
  _mttsAprimState.type='';_mttsAprimState.status='';_mttsAprimState.search='';
  _mttsRenderAssetPrimaryNames();
}
function _mttsTicketClearFilters(){
  ['mttsTicketPlantFilter','mttsTicketBreakdownFilter','mttsTicketStatusFilter','mttsTicketAssignedFilter','mttsTicketSearch'].forEach(function(id){
    var el=document.getElementById(id);if(el) el.value='';
  });
  _mttsTicketState.plant='';_mttsTicketState.breakdown='';_mttsTicketState.status='';_mttsTicketState.assigned='';_mttsTicketState.search='';
  _mttsRenderTickets();
}
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
  // Keep the raw user input for re-rendering the input value (so spaces
  // and casing aren't swallowed mid-typing). Filtering uses a normalised
  // copy.
  var fSearchRaw=String(_mttsAssetState.search||'');
  var fSearch=fSearchRaw.toLowerCase().trim();
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
    var typeKind={Machinery:'machinery',Building:'building',Furniture:'furniture','IT Devices':'it','Electrical Devices':'electrical'};
    sumEl.innerHTML=_mttsCountChip('Total',(DB.mttsAssets||[]).length,'total')+
      _mttsCountChip('Showing',assets.length,'showing')+
      Object.keys(counts).map(function(k){return _mttsCountChip(k,counts[k],typeKind[k]);}).join('');
  }
  // Note: we no longer early-return on empty results — losing the table
  // would also lose the filter / search inputs and trap the user. Instead
  // we render the filter + header rows as usual and inject a single
  // "no matches" row inside tbody.
  var critClr={High:'#dc2626',Medium:'#f59e0b',Low:'#16a34a'};
  var statusClr={Active:'#16a34a',Inactive:'#94a3b8',Scrap:'#dc2626'};
  var plantLbl=function(v){return _mttsPlantLabel(v);};
  // V32 (260518) — Honor the user-selected sort first. Fall back to
  // the default plant→type→name ordering when no header is selected.
  var rows=assets.slice();
  var sortKey=_mttsAssetState.sortKey;
  var sortDir=(_mttsAssetState.sortDir==='desc')?-1:1;
  var _sortVal=function(a){
    switch(sortKey){
      case 'plant':         return _mttsPlantLabel(a.plant)||'';
      case 'assetType':     return a.assetType||'';
      case 'name':          return _mttsAssetComposedName(a)||'';
      case 'dashboardName': return a.dashboardName||'';
      case 'mm':            return [a.make,a.model].filter(Boolean).join(' / ');
      case 'serial':        return a.serialNo||'';
      case 'installDate':   return a.installDate||'';
      case 'criticality':   return ({High:1,Medium:2,Low:3}[a.criticality]||9)+' '+(a.criticality||'');
      case 'status':        return ({Active:1,Inactive:2,Scrap:3}[a.status]||9)+' '+(a.status||'');
    }
    return '';
  };
  if(sortKey){
    rows.sort(function(a,b){
      var av=String(_sortVal(a)).toLowerCase();
      var bv=String(_sortVal(b)).toLowerCase();
      if(av<bv) return -1*sortDir;
      if(av>bv) return  1*sortDir;
      return 0;
    });
  } else {
    rows.sort(function(a,b){
      var pl=String(a.plant||'').localeCompare(String(b.plant||''));if(pl) return pl;
      var tp=String(a.assetType||'').localeCompare(String(b.assetType||''));if(tp) return tp;
      return String(a.name||'').localeCompare(String(b.name||''));
    });
  }
  // Card grid layout — same `.mtts-tcards` / `.mtts-tcard` pattern the
  // tickets page uses. Wider screens can switch to a table layout via
  // the view-mode toggle (saved per page in localStorage). Mobile is
  // always cards regardless of the saved preference.
  var view=_mttsViewMode(_mttsAssetState,'mtts_view_asset');
  var plantList=_mttsPlantList(true);
  var plantOpts='<option value="">All plants</option>'+plantList.map(function(p){
    return '<option value="'+p.value+'"'+(p.value===fPlant?' selected':'')+'>'+p.label+'</option>';
  }).join('');
  var typesArr=_mttsAssetTypeList(true);
  var typeOpts='<option value="">All types</option>'+typesArr.map(function(t){
    return '<option value="'+t.value+'"'+(t.value===fType?' selected':'')+'>'+t.label+'</option>';
  }).join('');
  var inlineSearchVal=fSearchRaw.replace(/"/g,'&quot;');
  var viewBtn='<button type="button" class="btn btn-secondary mtts-view-toggle" onclick="_mttsAssetToggleView()" title="Switch view" style="font-size:12px;padding:6px 10px">'+(view==='table'?'🗂 Cards':'📊 Table')+'</button>';
  // V32 (260518) — Status filter combo removed (rarely used; Status
  // column header now sorts when clicked). X clear button made bigger
  // and red so it reads as the primary "reset" affordance.
  var html='<div class="mtts-tcard-filters">'+
    '<input type="search" id="mttsAssetSearch" placeholder="🔍 name / serial / make…" oninput="_mttsRenderAssets()" value="'+inlineSearchVal+'">'+
    '<select id="mttsAssetPlantFilter" onchange="_mttsRenderAssets()">'+plantOpts+'</select>'+
    '<select id="mttsAssetTypeFilter" onchange="_mttsRenderAssets()">'+typeOpts+'</select>'+
    viewBtn+
    '<button type="button" onclick="_mttsAssetClearFilters()" title="Reset filters, search and sort" style="flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;padding:0;border:2px solid #dc2626;background:#fff;color:#dc2626;border-radius:8px;cursor:pointer;font-weight:900;font-size:20px;line-height:1">✕</button>'+
  '</div>';
  if(view==='table'){
    html+=_mttsAssetTableHtml(rows,critClr,statusClr);
  } else if(!rows.length){
    html+='<div class="mtts-tcards"><div class="mtts-tcard-empty">No assets match the current filters.</div></div>';
  } else {
    html+='<div class="mtts-tcards">';
    rows.forEach(function(a){
      var idEsc=String(a.id||'').replace(/'/g,"\\'");
      var mm=[a.make,a.model].filter(Boolean).join(' / ');
      var crit=a.criticality||'Medium';
      var statusBg=(statusClr[a.status]||'#94a3b8');
      var stop='event.stopPropagation();';
      var canEd=_mttsHasAccess('action.editAsset');
      var refs=(DB.mttsTickets||[]).filter(function(t){return t&&t.assetCode===a.id;}).length;
      var sideAct='<button class="mtts-tcard-iconbtn is-edit" onclick="'+stop+'_mttsAssetOpen(\''+idEsc+'\')" title="'+(canEd?'Edit asset':'View asset')+'">'+(canEd?'✎':'👁')+'</button>';
      if(canEd) sideAct+='<button class="mtts-tcard-iconbtn" style="border-color:#bfdbfe;color:#1d4ed8;background:#eff6ff" onclick="'+stop+'_mttsAssetDuplicate(\''+idEsc+'\')" title="Add a duplicate of this asset">📋</button>';
      if(canEd&&refs===0) sideAct+='<button class="mtts-tcard-iconbtn is-del" onclick="'+stop+'_mttsAssetDeleteFromTable(\''+idEsc+'\')" title="Delete asset">🗑</button>';
      else if(canEd&&refs>0) sideAct+='<button class="mtts-tcard-iconbtn is-del" disabled title="In use — '+refs+' ticket(s) reference this asset" style="opacity:.5;cursor:not-allowed">🗑</button>';
      var plantColor=_mttsPlantColor(a.plant)||'#94a3b8';
      // V26 (260518) — Dashboard Asset Name (DA Name) surfaced under
      // the full asset name so users see how the dashboard chip will
      // render this asset at a glance.
      var _daName=String(a.dashboardName||'').trim();
      var _daHtml=_daName?'<div class="mtts-tcard-daname" title="Dashboard Asset Name">🏷 '+String(_daName).replace(/</g,'&lt;')+'</div>':'';
      html+='<div class="mtts-tcard" style="--plant-color:'+plantColor+'" onclick="_mttsAssetOpen(\''+idEsc+'\')">'+
        '<div class="mtts-tcard-head">'+
          '<div class="mtts-tcard-headline">'+
            '<div class="mtts-tcard-headtop">'+_mttsPlantBadge(a.plant)+'<span class="mtts-tcard-sep">·</span><span class="mtts-tcard-type">'+(a.assetType||'—')+'</span></div>'+
            '<div class="mtts-tcard-asset">'+(_mttsAssetComposedName(a)||'—')+'</div>'+
            _daHtml+
            (mm?'<div class="mtts-tcard-meta">'+mm+'</div>':'')+
          '</div>'+
          '<span class="mtts-tcard-prio '+crit+'">'+crit+'</span>'+
        '</div>'+
        '<div class="mtts-tcard-rows">'+
          (a.serialNo?'<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Serial</span><span class="mtts-tcard-val">'+String(a.serialNo).replace(/</g,'&lt;')+'</span></div>':'')+
          '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Installed</span><span class="mtts-tcard-val is-muted">'+(a.installDate||'—')+'</span></div>'+
          '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Status</span><span class="mtts-tcard-val"><span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:800;background:'+statusBg+'22;color:'+statusBg+'">'+(a.status||'Active')+'</span></span></div>'+
        '</div>'+
        '<div class="mtts-tcard-actions">'+
          '<div class="mtts-tcard-actions-left"></div>'+
          '<div class="mtts-tcard-actions-right">'+sideAct+'</div>'+
        '</div>'+
      '</div>';
    });
    html+='</div>';
  }
  wrap.innerHTML=html;
  // Restore focus + caret on the search box so typing isn't interrupted.
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

// Table view for the Asset Master — used when the user toggles to the
// dense layout on a wide screen. Same data as the cards, just laid out
// as a sticky-header HTML table inside the existing scroll container.
function _mttsAssetTableHtml(rows,critClr,statusClr){
  var th='padding:9px 12px;font-size:12px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;position:sticky;top:0;z-index:2;box-shadow:0 1px 0 rgba(0,0,0,.04)';
  var td='padding:8px 12px;font-size:13px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var canEd=_mttsHasAccess('action.editAsset');
  // V26 (260518) — Added "DA Name" column (Dashboard Asset Name) between
  // Asset and Make/Model so the dashboard short label is visible in the
  // table view too.
  // V31 (260518) — Inner wrap uses overflow-x:auto only (horizontal
  // scroll for wide tables) so wheel events bubble up to the outer
  // #mttsAssetTableWrap, which owns vertical scrolling under the
  // mtts-tight-page flex chain. With overflow:auto here, the inner
  // div was intercepting wheel events and the asset list lost its
  // vertical scrollbar.
  // V32 (260518) — Clickable sortable headers. _mttsAssetSetSort cycles
  // asc↔desc on the same column, switches direction otherwise.
  var sortKey=_mttsAssetState.sortKey;
  var sortDir=_mttsAssetState.sortDir;
  var _arrow=function(k){ return k===sortKey ? (sortDir==='desc' ? ' ▼':' ▲') : ' '; };
  var _hCell=function(k,label){
    return '<th style="'+th+';cursor:pointer;user-select:none" onclick="_mttsAssetSetSort(\''+k+'\')" title="Sort by '+label+'">'+label+_arrow(k)+'</th>';
  };
  var html='<div style="border:1.5px solid var(--border);border-radius:8px;background:#fff;overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>'+
    '<th style="'+th+'">#</th>'+
    _hCell('plant','Plant')+
    _hCell('assetType','Type')+
    _hCell('name','Asset')+
    _hCell('dashboardName','DA Name')+
    _hCell('mm','Make / Model')+
    _hCell('serial','Serial')+
    _hCell('installDate','Installed')+
    _hCell('criticality','Priority')+
    _hCell('status','Status')+
    '<th style="'+th+';text-align:center;width:130px">Actions</th>'+
  '</tr></thead><tbody>';
  if(!rows.length){
    html+='<tr><td colspan="11" style="padding:30px 20px;text-align:center;color:var(--text3);font-size:13px">No assets match the current filters.</td></tr>';
  }
  rows.forEach(function(a,i){
    var idEsc=String(a.id||'').replace(/'/g,"\\'");
    var mm=[a.make,a.model].filter(Boolean).join(' / ');
    var refs=(DB.mttsTickets||[]).filter(function(t){return t&&t.assetCode===a.id;}).length;
    var stop='event.stopPropagation();';
    var actions='<button onclick="'+stop+'_mttsAssetOpen(\''+idEsc+'\')" title="'+(canEd?'Edit':'View')+'" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer">'+(canEd?'✎':'👁')+'</button>';
    if(canEd) actions+='<button onclick="'+stop+'_mttsAssetDuplicate(\''+idEsc+'\')" title="Add a duplicate" style="font-size:12px;padding:4px 9px;font-weight:700;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;border-radius:4px;cursor:pointer;margin-left:3px">📋</button>';
    if(canEd&&refs===0) actions+='<button onclick="'+stop+'_mttsAssetDeleteFromTable(\''+idEsc+'\')" title="Delete" style="font-size:12px;padding:4px 9px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer;margin-left:3px">🗑</button>';
    else if(canEd&&refs>0) actions+='<button disabled title="In use — '+refs+' ticket(s)" style="font-size:12px;padding:4px 9px;font-weight:700;background:#f1f5f9;border:1px solid var(--border);color:#cbd5e1;border-radius:4px;cursor:not-allowed;margin-left:3px">🗑</button>';
    html+='<tr class="clickable-row" onclick="_mttsAssetOpen(\''+idEsc+'\')" style="cursor:pointer">'+
      '<td style="'+td+';color:var(--text3);font-family:var(--mono)">'+(i+1)+'</td>'+
      '<td style="'+td+'">'+_mttsPlantBadge(a.plant)+'</td>'+
      '<td style="'+td+'">'+(a.assetType||'—')+'</td>'+
      '<td style="'+td+';font-weight:700">'+(_mttsAssetComposedName(a)||'—')+'</td>'+
      '<td style="'+td+';font-family:var(--mono);font-size:12px;font-weight:700;color:#0f172a">'+(String(a.dashboardName||'').replace(/</g,'&lt;')||'<span style="color:var(--text3);font-weight:400">—</span>')+'</td>'+
      '<td style="'+td+';color:var(--text2)">'+(mm||'—')+'</td>'+
      '<td style="'+td+';font-family:var(--mono);font-size:12px">'+(a.serialNo||'—')+'</td>'+
      '<td style="'+td+';font-family:var(--mono);font-size:12px;color:var(--text3)">'+(a.installDate||'—')+'</td>'+
      '<td style="'+td+'"><span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:800;background:'+critClr[a.criticality]+'22;color:'+critClr[a.criticality]+'">'+(a.criticality||'Medium')+'</span></td>'+
      '<td style="'+td+'"><span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:800;background:'+statusClr[a.status]+'22;color:'+statusClr[a.status]+'">'+(a.status||'Active')+'</span></td>'+
      '<td style="'+td+';text-align:center;white-space:nowrap">'+actions+'</td>'+
    '</tr>';
  });
  html+='</tbody></table></div>';
  return html;
}

// ── Asset edit modal ──────────────────────────────────────────────────────
// Optional preset: { plant, assetType, criticality } — used by Save & Add
// Next so the next blank form keeps the previous picks for plant +
// asset type (and priority) and the user can land on Primary Name.
// V18 (260520) — PM Applicable toggle handler. Drives the hidden input
// + the schedule wrap visibility + the visual active state of the
// Yes/No buttons. Called from the form's onclick and from
// _mttsAssetOpen during populate.
function _mttsAssetSetPmApp(yes){
  var hidden=document.getElementById('mttsAssetPmApplicable');
  if(hidden) hidden.value=yes?'true':'false';
  var wrap=document.getElementById('mttsAssetPmScheduleWrap');
  if(wrap) wrap.style.display=yes?'block':'none';
  Array.prototype.forEach.call(document.querySelectorAll('#mttsAssetPmAppBtns .mtts-pm-app-btn'),function(b){
    var active=(b.dataset.val==='yes' && yes) || (b.dataset.val==='no' && !yes);
    b.style.background=active?(yes?'#16a34a':'#e2e8f0'):'#fff';
    b.style.color=active?(yes?'#fff':'#0f172a'):'var(--text)';
    b.style.borderColor=active?(yes?'#16a34a':'#94a3b8'):'var(--border)';
  });
}
// V18 (260520) — Show / hide the Custom Interval input based on the
// Frequency dropdown. Custom = exact-day input is enabled.
function _mttsAssetPmFreqChanged(){
  var freq=document.getElementById('mttsAssetPmFreq').value;
  var wrap=document.getElementById('mttsAssetPmIntervalWrap');
  if(wrap) wrap.style.display=(freq==='Custom')?'block':'none';
}

function _mttsAssetOpen(id, preset){
  var canEdit=_mttsHasAccess('action.editAsset');
  if(!canEdit&&id===''){notify('You do not have permission to add assets',true);return;}
  var a=id?(byId(DB.mttsAssets||[],id)||null):null;
  // V38 — transferHistory is stripped at boot; pull it on first edit so
  // the history tab renders and saves don't wipe the existing entries.
  if(a&&typeof _mttsLoadAssetHistory==='function' && !_mttsLoadedAssetHistory[id]){
    _mttsLoadAssetHistory(id).then(function(){ _mttsAssetOpen(id, preset); });
  }
  document.getElementById('mttsAssetTitle').textContent=a?(canEdit?'🛠 Edit Asset':'🛠 View Asset'):'🛠 Add Asset';
  document.getElementById('mttsAssetId').value=a?a.id:'';
  // V52 — Plant + Asset Type are now <select> elements. Their options
  // must exist BEFORE we can set .value, so render first then assign.
  // Criticality stays a hidden input + chip row, so its order is
  // unchanged (set value first, then render reads it to mark the
  // active chip).
  document.getElementById('mttsAssetCrit').value=a?(a.criticality||'Medium'):((preset&&preset.criticality)||'Medium');
  _mttsAssetRenderPlantBtns();
  _mttsAssetRenderTypeBtns();
  _mttsAssetRenderCritBtns();
  document.getElementById('mttsAssetPlant').value=a?(a.plant||''):((preset&&preset.plant)||'');
  document.getElementById('mttsAssetType').value=a?(a.assetType||''):((preset&&preset.assetType)||'');
  // Primary name select — refreshed every open so newly-added master rows
  // are immediately pickable. Falls back to the legacy `name` field when an
  // imported/old asset has no primaryName set yet.
  _mttsPopulateAssetPrimaryNameOptions();
  var primSel=document.getElementById('mttsAssetPrimary');
  if(primSel){
    var primVal=a?(a.primaryName||''):((preset&&preset.primaryName)||'');
    primSel.value=primVal;
    // If the asset's stored primaryName isn't in the master list (legacy
    // data), fall back to blank and let the user pick. The legacy
    // composite name still shows below for reference.
    if(a&&primVal&&primSel.value!==primVal){primSel.value='';}
    // V9 (260518) — bind once: refresh preview when Primary Name changes.
    if(!primSel._mttsPrevBound){
      primSel._mttsPrevBound=true;
      primSel.addEventListener('change',function(){ _mttsAssetUpdatePreview(); });
    }
  }
  var extEl=document.getElementById('mttsAssetNameExt');
  if(extEl) extEl.value=a?(a.nameExtension||''):((preset&&preset.nameExtension)||'');
  document.getElementById('mttsAssetName').value=a?(a.name||''):((preset&&preset.name)||'');
  // V26 (260518) — Auto-fill the Dashboard Asset Name only on FIRST
  // entry. Any stored value (matching auto-fill or not) locks the
  // field so subsequent opens preserve what was saved. The user can
  // clear the field to re-enable the one-time auto-fill on next
  // Primary / Extension change.
  var dashEl=document.getElementById('mttsAssetDashName');
  if(dashEl){
    var dashStored=a?(a.dashboardName||''):((preset&&preset.dashboardName)||'');
    dashEl.value=dashStored;
    _mttsAssetDashNameTouched=!!dashStored;
  } else {
    _mttsAssetDashNameTouched=false;
  }
  document.getElementById('mttsAssetDesc').value=a?(a.description||''):((preset&&preset.description)||'');
  document.getElementById('mttsAssetSerial').value=a?(a.serialNo||''):((preset&&preset.serialNo)||'');
  document.getElementById('mttsAssetInstall').value=a?(a.installDate||'2020-01-01'):((preset&&preset.installDate)||'2020-01-01');
  document.getElementById('mttsAssetMake').value=a?(a.make||''):((preset&&preset.make)||'');
  document.getElementById('mttsAssetModel').value=a?(a.model||''):((preset&&preset.model)||'');
  document.getElementById('mttsAssetWarranty').value=a&&a.warranty?(a.warranty.until||''):((preset&&preset.warrantyUntil)||'');
  document.getElementById('mttsAssetAmc').value=a&&a.amc?(a.amc.until||''):((preset&&preset.amcUntil)||'');
  // V18 (260520) — Populate PM fields from the asset (or preset for
  // brand-new assets). _mttsAssetSetPmApp toggles the schedule wrap
  // visibility AND updates the hidden Yes/No input; _mttsAssetPmFreqChanged
  // shows/hides the Custom interval input.
  var pmApp=a?!!a.pmApplicable:!!(preset&&preset.pmApplicable);
  var pmSched=(a&&a.pmSchedule)||(preset&&preset.pmSchedule)||{};
  _mttsAssetSetPmApp(pmApp);
  document.getElementById('mttsAssetPmFreq').value=pmSched.frequency||'Monthly';
  document.getElementById('mttsAssetPmInterval').value=pmSched.intervalDays||'';
  document.getElementById('mttsAssetPmNextDue').value=pmSched.nextDueAt||'';
  _mttsAssetPmFreqChanged();
  // Last Done note (visible when there's history).
  var pmLast=document.getElementById('mttsAssetPmLastDoneNote');
  if(pmLast){
    if(pmSched.lastDoneAt){
      pmLast.textContent='Last PM done: '+pmSched.lastDoneAt+(pmSched.lastDoneBy?(' by '+pmSched.lastDoneBy):'');
      pmLast.style.display='block';
    } else { pmLast.style.display='none'; }
  }
  // Gate PM section by action.editPm — when the user lacks it, the
  // section displays the values but the buttons / inputs are disabled.
  var canEditPm=_mttsHasAccess('action.editPm');
  ['mttsAssetPmFreq','mttsAssetPmInterval','mttsAssetPmNextDue'].forEach(function(id){
    var el=document.getElementById(id); if(el) el.disabled=!canEditPm;
  });
  Array.prototype.forEach.call(document.querySelectorAll('#mttsAssetPmAppBtns .mtts-pm-app-btn'),function(b){
    b.disabled=!canEditPm;
    b.style.cursor=canEditPm?'pointer':'not-allowed';
    b.style.opacity=canEditPm?'1':'.65';
  });
  // Re-set criticality after the field-by-field reset above (it shares the
  // hidden input style as the early-render one but is a no-op duplicate
  // unless an early-pass cleared it).
  document.getElementById('mttsAssetCrit').value=a?(a.criticality||'Medium'):((preset&&preset.criticality)||'Medium');
  document.getElementById('mttsAssetStatus').value=a?(a.status||'Active'):((preset&&preset.status)||'Active');
  // Save buttons: edit mode shows a single "Save"; add mode shows
  // "Save & Add Next" (secondary, keeps the form open with plant/type
  // pre-filled for the next entry) plus the primary "Save & Close".
  var assetSaveBtn=document.getElementById('mttsAssetSaveBtn');
  if(assetSaveBtn) assetSaveBtn.textContent=a?'Save':'Save & Close';
  var assetSaveNextBtn=document.getElementById('mttsAssetSaveNextBtn');
  if(assetSaveNextBtn) assetSaveNextBtn.style.display=a?'none':'';
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
  // When the user lacks edit permission, lock every input + chip row +
  // color picker in the modal so it becomes a read-only viewer. Cancel/×
  // stays live so they can dismiss it.
  var modalEl=document.getElementById('mMttsAsset');
  if(modalEl){
    _mttsLockModal(modalEl,canEdit);
    // Save & Close button: hidden in view mode (covered by lockModal too,
    // but explicit display:none keeps it from reserving footer width).
    var saveBtn=modalEl.querySelector('button.btn-primary');
    if(saveBtn) saveBtn.style.display=canEdit?'':'none';
    var saveNext=document.getElementById('mttsAssetSaveNextBtn');
    if(saveNext) saveNext.style.display=(canEdit&&!a)?'':'none';
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
  // V11 (260518) — Reset scroll to the top on every open so the user
  // always sees the preview banner + Identity panel first. The inner
  // .modal div is the scrolling container (overflow:auto + max-height
  // 90vh); the overlay itself never scrolls.
  var _scrollHost=document.querySelector('#mMttsAsset .modal');
  if(_scrollHost) _scrollHost.scrollTop=0;
  // V9 (260518) — Paint the live preview once the form is populated.
  _mttsAssetUpdatePreview();
  // Save & Add Next: drop focus straight on the Primary Name select so
  // the user can keep typing without re-picking plant / type / priority.
  if(!a&&preset){
    setTimeout(function(){
      var primFocus=document.getElementById('mttsAssetPrimary');
      if(primFocus&&typeof primFocus.focus==='function') primFocus.focus();
    },50);
  }
}

// Open the Add Asset form pre-populated with another asset's fields. Useful
// when adding several near-identical assets — user only edits what differs
// (typically serial / primary name / extension) and saves.
function _mttsAssetDuplicate(id){
  if(!_mttsHasAccess('action.editAsset')){notify('You do not have permission to add assets',true);return;}
  var a=byId(DB.mttsAssets||[],id);
  if(!a){notify('Asset not found',true);return;}
  _mttsAssetOpen('',{
    plant:a.plant,
    assetType:a.assetType,
    criticality:a.criticality,
    primaryName:a.primaryName,
    nameExtension:a.nameExtension,
    name:a.name,
    description:a.description,
    serialNo:a.serialNo,
    installDate:a.installDate,
    make:a.make,
    model:a.model,
    warrantyUntil:a.warranty?a.warranty.until:'',
    amcUntil:a.amc?a.amc.until:'',
    status:a.status||'Active'
  });
}

async function _mttsAssetDeleteFromTable(id){
  if(!_mttsHasAccess('action.editAsset')){notify('Access denied',true);return;}
  var a=byId(DB.mttsAssets||[],id);if(!a) return;
  var refs=(DB.mttsTickets||[]).filter(function(t){return t&&t.assetCode===a.id;}).length;
  if(refs){notify('⚠ Cannot delete — '+refs+' ticket(s) reference this asset',true);return;}
  if(!confirm('Delete asset "'+(_mttsAssetComposedName(a)||a.id)+'"? This cannot be undone.')) return;
  if(!_sb||!_sbReady){notify('No DB connection',true);return;}
  // Match on the asset's natural composite key — plant + asset_type +
  // primary_name + name_extension + make — instead of the `code` column
  // alone. Legacy data could share `code` across rows that differ only
  // by make, so a `code`-only delete would wipe siblings. The composite
  // key uniquely identifies one asset per the V96 uniqueness rule.
  showSpinner('Deleting…');
  try{
    var q=_sb.from('mtts_assets').delete()
      .eq('plant',a.plant||'')
      .eq('asset_type',a.assetType||'')
      .eq('primary_name',a.primaryName||'')
      .eq('name_extension',a.nameExtension||'')
      .eq('make',a.make||'')
      .select();
    var res=await q;
    if(res&&res.error){
      console.error('asset delete failed',res.error);
      notify('Delete failed: '+(res.error.message||''),true);
      return;
    }
    var deleted=(res&&res.data)||[];
    if(!deleted.length){
      notify('Delete blocked — row not found or denied by RLS policy',true);
      return;
    }
    // Mirror the same composite-key filter when removing from the JS
    // mirror so the UI matches what was actually deleted server-side.
    DB.mttsAssets=(DB.mttsAssets||[]).filter(function(x){
      if(!x) return true;
      return !((x.plant||'')===(a.plant||'')
        &&(x.assetType||'')===(a.assetType||'')
        &&(x.primaryName||'')===(a.primaryName||'')
        &&(x.nameExtension||'')===(a.nameExtension||'')
        &&(x.make||'')===(a.make||''));
    });
    notify('🗑 Asset deleted');
    _mttsRenderAssets();
  }catch(e){
    console.error('asset delete exception',e);
    notify('Delete failed',true);
  }finally{
    hideSpinner();
  }
}

// Flash one or more form fields red to show they're missing or invalid.
// Each id can be the field's actual input/select/textarea, or the visible
// wrapper around a chip-list / radio group. The flash auto-clears after
// ~3.5s or on the user's next interaction with the element.
function _mttsFlashFieldErr(){
  var ids=Array.prototype.slice.call(arguments).filter(Boolean);
  var first=null;
  ids.forEach(function(id){
    var el=document.getElementById(id);
    if(!el) return;
    if(!first) first=el;
    el.classList.remove('mtts-field-flash-err');
    void el.offsetWidth;// force reflow so animation restarts on repeat misses
    el.classList.add('mtts-field-flash-err');
    var clear=function(){
      el.classList.remove('mtts-field-flash-err');
      el.removeEventListener('input',clear);
      el.removeEventListener('change',clear);
      el.removeEventListener('click',clear);
    };
    el.addEventListener('input',clear);
    el.addEventListener('change',clear);
    el.addEventListener('click',clear);
    setTimeout(clear,3500);
  });
  if(first){
    setTimeout(function(){
      try{
        var focusable=(first.tagName==='INPUT'||first.tagName==='SELECT'||first.tagName==='TEXTAREA')?first:first.querySelector('input,select,textarea,button');
        if(focusable&&typeof focusable.focus==='function') focusable.focus();
      }catch(e){}
    },80);
  }
}

// mode: 'close' (default) closes the modal after save; 'next' keeps the
// add-asset form open with plant / asset type / criticality pre-filled
// from the row that was just saved, so the user can rapidly enter a
// batch of similar assets.
async function _mttsAssetSave(mode){
  mode=mode||'close';
  if(!_mttsHasAccess('action.editAsset')){notify('Access denied',true);return;}
  var err=document.getElementById('mttsAssetErr');
  var _showErr=function(m){
    if(!err) return;
    err.textContent=m;err.style.display='block';
    err.classList.remove('mtts-err-flash');void err.offsetWidth;
    err.classList.add('mtts-err-flash');
  };
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
  if(!plant){_showErr('Plant is required');_mttsFlashFieldErr('mttsAssetPlant');return;}
  if(!type){_showErr('Asset Type is required');_mttsFlashFieldErr('mttsAssetType');return;}
  if(!primaryCode){_showErr('Primary Name is required');_mttsFlashFieldErr('mttsAssetPrimary');return;}
  // Compose the full asset name from the master's display label + the
  // free-text extension. Stored alongside primaryName/nameExtension so the
  // table & ticket displays can keep using `name` directly.
  var primLbl=_mttsAssetPrimaryNameLabel(primaryCode)||primaryCode;
  var name=ext?(primLbl+' - '+ext):primLbl;
  // Reflect the composed name into the hidden field for any consumers that
  // still read it.
  var nameEl=document.getElementById('mttsAssetName');if(nameEl) nameEl.value=name;
  // Per-plant uniqueness on the (primaryName + extension + make) combo,
  // case-insensitive. Same primary+ext at a different make is allowed
  // (e.g. two compressors with the same tag from different vendors).
  var makeRaw=_t('mttsAssetMake');
  var primKey=String(primaryCode).toLowerCase();
  var extKey=ext.toLowerCase().replace(/\s+/g,' ');
  var makeKey=makeRaw.toLowerCase().replace(/\s+/g,' ');
  var dupAsset=(DB.mttsAssets||[]).find(function(a){
    if(!a||a.id===id) return false;
    if(a.plant!==plant) return false;
    var aPrim=String(a.primaryName||'').toLowerCase();
    var aExt=String(a.nameExtension||'').toLowerCase().replace(/\s+/g,' ');
    var aMake=String(a.make||'').toLowerCase().replace(/\s+/g,' ');
    return aPrim===primKey&&aExt===extKey&&aMake===makeKey;
  });
  if(dupAsset){
    _showErr('"'+name+(makeRaw?' ('+makeRaw+')':'')+'" already exists at '+_mttsPlantLabel(plant)+' — primary name + extension + make must be unique within a plant');
    _mttsFlashFieldErr('mttsAssetPrimary','mttsAssetNameExt','mttsAssetMake');
    return;
  }
  // V25 (260518) — Dashboard Asset Name: free-text override of what
  // the dashboard chip shows. Empty → falls back to composed name.
  var dashName=_t('mttsAssetDashName');
  // V18 (260520) — Collect PM fields when the user has action.editPm.
  // When they don't, we preserve whatever was on the existing record
  // (read below in the merge) so a non-MM edit doesn't accidentally
  // clear the schedule.
  var canEditPm=_mttsHasAccess('action.editPm');
  var pmApplicable=document.getElementById('mttsAssetPmApplicable').value==='true';
  var pmFreq=document.getElementById('mttsAssetPmFreq').value||'Monthly';
  var pmIntervalRaw=document.getElementById('mttsAssetPmInterval').value;
  var pmNextDue=document.getElementById('mttsAssetPmNextDue').value||'';
  var freqDaysMap={Monthly:30,Quarterly:90,'Half-Yearly':180,Yearly:365};
  var pmIntervalDays=(pmFreq==='Custom')
    ? (parseInt(pmIntervalRaw,10)||0)
    : (freqDaysMap[pmFreq]||30);
  var data={
    plant:plant,
    plantId:_mttsResolveDbId(DB.mttsPlants,plant),
    assetType:type,
    assetTypeId:_mttsResolveDbId(DB.mttsAssetTypes,type),
    primaryName:primaryCode,
    primaryNameId:_mttsResolveDbId(DB.mttsAssetPrimaryNames,primaryCode),
    nameExtension:ext,
    name:name,
    dashboardName:dashName,
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
    // V18 (260520) — Merge PM fields. Users without action.editPm
    // keep the existing PM block unchanged. The schedule preserves
    // lastDoneAt across edits (only the Mark Done flow updates it).
    if(canEditPm){
      data.pmApplicable=pmApplicable;
      var prevSched=existing.pmSchedule||{};
      data.pmSchedule=pmApplicable?{
        frequency:pmFreq,
        intervalDays:pmIntervalDays,
        nextDueAt:pmNextDue||prevSched.nextDueAt||'',
        lastDoneAt:prevSched.lastDoneAt||'',
        lastDoneBy:prevSched.lastDoneBy||''
      }:(prevSched.lastDoneAt?prevSched:{}); // keep history anchor when toggling off
    } else {
      data.pmApplicable=existing.pmApplicable;
      data.pmSchedule=existing.pmSchedule||{};
    }
    var bak=Object.assign({},existing);
    Object.assign(existing,data);
    var ok=await _dbSave('mttsAssets',existing);
    if(!ok){Object.assign(existing,bak);_showErr('Save failed');return;}
    notify('✓ Asset updated');
  } else {
    // V18 (260520) — New asset: take whatever the user typed in the
    // PM section regardless of action.editPm (Add flow already
    // requires action.editAsset which is the broader gate).
    data.pmApplicable=pmApplicable;
    data.pmSchedule=pmApplicable?{
      frequency:pmFreq,
      intervalDays:pmIntervalDays,
      nextDueAt:pmNextDue||'',
      lastDoneAt:'',
      lastDoneBy:''
    }:{};
    var newAsset=Object.assign({id:'a'+uid(),transferHistory:[],pmHistory:[]},data);
    if(!DB.mttsAssets) DB.mttsAssets=[];
    DB.mttsAssets.push(newAsset);
    var ok2=await _dbSave('mttsAssets',newAsset);
    if(!ok2){
      DB.mttsAssets=DB.mttsAssets.filter(function(x){return x!==newAsset;});
      _showErr('Save failed');return;
    }
    notify('✓ Asset added');
    _mttsRenderAssets();
    // V42 — Also repaint tickets list so cards that referenced this
    // asset (e.g. via the SA / MTTS-Admin asset-name link) pick up the
    // new name immediately.
    if(typeof _mttsRenderTickets==='function') _mttsRenderTickets();
    // V20 (260518) — Refresh the dashboard so the HP Asset Status
    // chips reflect the new asset (its composed name + plant block).
    if(typeof _mttsDashboardRender==='function') _mttsDashboardRender();
    if(mode==='next'){
      // Reopen the form with plant / asset type / priority pre-selected
      // so the user can rapidly enter a batch. Focus lands on Primary
      // Name (handled in _mttsAssetOpen).
      _mttsAssetOpen('',{plant:plant,assetType:type,criticality:data.criticality});
    } else {
      cm('mMttsAsset');
    }
    return;
  }
  cm('mMttsAsset');
  _mttsRenderAssets();
  // V42 — Repaint tickets list so the updated asset name is reflected
  // on any ticket card that references this asset (and on the cards
  // open in modal headers via _mttsTicketSummaryHtml).
  if(typeof _mttsRenderTickets==='function') _mttsRenderTickets();
  // V20 (260518) — Dashboard refresh so the HP Asset Status block
  // shows the updated composed name / plant chip immediately.
  if(typeof _mttsDashboardRender==='function') _mttsDashboardRender();
}

// ── Transfer flow ─────────────────────────────────────────────────────────
function _mttsAssetTransferOpen(){
  var id=document.getElementById('mttsAssetId').value;
  if(!id){notify('Save the asset first',true);return;}
  var a=byId(DB.mttsAssets||[],id);if(!a){notify('Asset not found',true);return;}
  var plantLbl=function(v){return _mttsPlantLabel(v);};
  document.getElementById('mttsTransferAssetLbl').innerHTML='Transferring <b>'+_mttsAssetComposedName(a)+'</b> from <b>'+plantLbl(a.plant)+'</b>';
  document.getElementById('mttsTransferTo').value='';
  document.getElementById('mttsTransferDate').value=_mttsTodayStr();
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
// V38 — 6-step explicit flow:
//   1. open                    (TR raises)
//   2. assigned                (MM allocates tech)              "Technician Allocated"
//   3. work_in_progress        (Tech starts work)               NEW
//   4. awaiting_spares | awaiting_agency | scrapped | repair_done  (Tech updates)
//   5. repair_done (+confirmedByRaiser) | repair_done_challenged   (TR confirms/rejects)  NEW
//   6. closed                  (MM approves + cost) OR reallocate → assigned
// Terminal alts: scrapped (from any active state) — labelled "Not Repairable".

var _MTTS_STATUS_LABEL={
  open:'Open',
  assigned:'Technician Allocated',
  work_in_progress:'WIP',
  awaiting_spares:'Waiting for Spares',
  awaiting_agency:'Waiting For Ext. Serv.',
  repair_done:'Repair Done, Confirmation Pending',
  repair_done_challenged:'Repair Done Challenged',
  closed:'Closed',
  scrapped:'Not Repairable'
};
var _MTTS_STATUS_CLR={
  open:'#dc2626',                    // red — needs allocation
  assigned:'#0ea5e9',                // blue — in tech queue
  work_in_progress:'#eab308',        // yellow — actively being worked on
  awaiting_spares:'#ea580c',         // orange — waiting for spares
  awaiting_agency:'#ea580c',         // orange — waiting for external service
  repair_done:'#16a34a',             // green — awaiting raiser confirmation / manager
  repair_done_challenged:'#dc2626',  // red — raiser disputed the fix
  closed:'#64748b',                  // grey — terminal
  scrapped:'#7f1d1d'                 // dark red — terminal (Not Repairable)
};
var _MTTS_BREAKDOWN_LABEL={stopped:'Completely Stopped',partial:'Running with Alert',pm:'PM Required'};
// V38 — Breakdown Type (failure category) labels + small inline pill helper.
// Stored on the techActions "raised" entry as `bdCategory` so no DB schema
// change is needed for the new field.
var _MTTS_BDCAT_LABEL={electrical:'Electrical',mechanical:'Mechanical',unknown:"Don't Know",other:'Other'};
var _MTTS_BDCAT_ICON={electrical:'⚡',mechanical:'🔧',unknown:'❔',other:'❓'};
function _mttsBdCategory(t){
  if(!t||!Array.isArray(t.techActions)) return '';
  var raised=t.techActions.find(function(a){return a&&a.action==='raised';});
  return (raised&&raised.bdCategory)||'';
}
function _mttsBdCategoryBadge(t){
  var c=_mttsBdCategory(t); if(!c) return '';
  var lbl=_MTTS_BDCAT_LABEL[c]||c;
  var icon=_MTTS_BDCAT_ICON[c]||'';
  return '<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:800;background:#e2e8f0;color:#0f172a;border:1px solid #cbd5e1;padding:1px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.3px;margin-left:6px;white-space:nowrap">'+icon+' '+lbl+'</span>';
}

function _mttsStatusBadge(s){
  var clr=_MTTS_STATUS_CLR[s]||'#94a3b8';
  return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800;background:'+clr+'22;color:'+clr+'">'+(_MTTS_STATUS_LABEL[s]||s)+'</span>';
}
// V38 — Prominent status badge for the ticket-card top row. Same colours
// but larger / bolder so the lifecycle stage reads at a glance. When the
// ticket is Work in Progress, an inline elapsed timer (HH:MM) is appended
// and gets live-updated by _mttsLiveTimerTick.
function _mttsStatusBadgeBig(t){
  var s=t.status;
  var lbl=_MTTS_STATUS_LABEL[s]||s;
  // V124 — Per-state styling for the repair-done → close pipeline:
  //   • repair_done + !confirmedByRaiser → "Repair Done, Confirmation Pending"
  //     with a yellow → light-green gradient (the fix landed; waiting on TR).
  //   • repair_done + confirmedByRaiser → "Approval Pending" with a light-
  //     green → dark-green gradient (TR confirmed; waiting on MM close).
  //   • closed → solid dark green.
  //   Other states keep their solid colour from _MTTS_STATUS_CLR.
  var bgStyle, fg='#fff';
  if(s==='repair_done'){
    if(t.confirmedByRaiser){
      lbl='Approval Pending';
      bgStyle='background:linear-gradient(135deg,#a7f3d0 0%,#15803d 100%)';
    } else {
      bgStyle='background:linear-gradient(135deg,#fde68a 0%,#a7f3d0 100%)';
      fg='#0f172a';
    }
  } else if(s==='closed'){
    bgStyle='background:#15803d';
  } else {
    bgStyle='background:'+(_MTTS_STATUS_CLR[s]||'#94a3b8');
  }
  var timer='';
  if(s==='work_in_progress'){
    // V27 — Pause-aware WIP timer. Accumulates time across pause/resume
    // cycles via _mttsWipElapsedMs. When paused (partial_done), shows
    // frozen value without the data-mtts-since hook so the live tick
    // leaves it alone. When active, encodes a "virtual start" so the
    // 10s tick keeps the readout ticking forward.
    var _wipMs=_mttsWipElapsedMs(t);
    var _hm=_mttsTimerHHMMFromMs(_wipMs);
    if(_mttsIsPartialPaused(t)){
      timer=' · <span title="Paused — Partial work done" style="font-family:var(--mono);font-weight:900;letter-spacing:.4px;opacity:.85">⏸ '+_hm+'</span>';
    } else if(t.startedAt){
      var _virt=new Date(Date.now()-_wipMs).toISOString();
      timer=' · <span data-mtts-since="'+_virt+'" style="font-family:var(--mono);font-weight:900;letter-spacing:.4px">'+_hm+'</span>';
    }
  }
  // V29 — Flash the badge while a ticket is in WIP so the status reads
  // at a glance in a card list. Paused (partial_done) WIP doesn't flash
  // — the user's attention should be on the Resume button, not the
  // ticking badge.
  var flashCls=(s==='work_in_progress' && !_mttsIsPartialPaused(t))?' mtts-status-flash':'';
  return '<span class="mtts-status-pill'+flashCls+'" style="display:inline-flex;align-items:center;padding:5px 12px;border-radius:12px;font-size:13px;font-weight:900;'+bgStyle+';color:'+fg+';letter-spacing:.3px;box-shadow:0 1px 3px rgba(0,0,0,.15);white-space:normal;text-align:center;line-height:1.15;max-width:240px">'+lbl+timer+'</span>';
}
// V38 — "Tech: <Names>" pill rendered to the LEFT of the status badge on
// any ticket past the allocation step. Names come from t.assignedTo
// resolved via _mttsUserDisp(). Empty when nothing is assigned yet.
function _mttsTechBadge(t){
  if(!t||!Array.isArray(t.assignedTo)||!t.assignedTo.length) return '';
  // V19 — Compact "First L." form so multi-tech allocations stay on
  // one line on the ticket card. Full name is still available via the
  // detail overlay / history view.
  var names=t.assignedTo.map(function(u){return _mttsUserDispShort(u);}).filter(Boolean).join(', ');
  if(!names) return '';
  // V38 — Slate grey background (was near-black #0f172a — too heavy next to
  // the coloured status badge). Keeps the same prominence with a lighter feel.
  return '<span style="display:inline-flex;align-items:center;padding:5px 12px;border-radius:12px;font-size:13px;font-weight:800;background:#64748b;color:#fff;letter-spacing:.2px;box-shadow:0 1px 3px rgba(0,0,0,.15);white-space:nowrap"><span style="opacity:.8;margin-right:5px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Tech</span>'+names+'</span>';
}

// "1d 4h" / "32m" elapsed-since formatter for the breakdown timer.
function _mttsTimerSince(iso, endIso){
  if(!iso) return '—';
  var t0=new Date(iso).getTime();if(isNaN(t0)) return '—';
  var t1=endIso?new Date(endIso).getTime():Date.now();
  if(isNaN(t1)) t1=Date.now();
  var ms=t1-t0;
  if(ms<0) ms=0;
  var mins=Math.floor(ms/60000),hrs=Math.floor(mins/60),days=Math.floor(hrs/24);
  if(days>=1) return days+'d '+(hrs%24)+'h';
  if(hrs>=1) return hrs+'h '+(mins%60)+'m';
  return Math.max(mins,1)+'m';
}
// V38 — "HH:MM" elapsed formatter for the Work-in-Progress timer.
// Wraps to "DDd HH:MM" once past 24h. Always returns a string.
// V120 — Optional endIso freezes the timer at a fixed end (used for the
// breakdown downtime once the technician submits repair_done).
function _mttsTimerHHMM(iso, endIso){
  if(!iso) return '00:00';
  var t0=new Date(iso).getTime();if(isNaN(t0)) return '00:00';
  var t1=endIso?new Date(endIso).getTime():Date.now();
  if(isNaN(t1)) t1=Date.now();
  return _mttsTimerHHMMFromMs(Math.max(0,t1-t0));
}
// V27 — Format an elapsed-ms duration as "HH:MM" / "DDd HH:MM" (24h+).
function _mttsTimerHHMMFromMs(ms){
  if(!ms||ms<0) ms=0;
  var mins=Math.floor(ms/60000),hrs=Math.floor(mins/60),days=Math.floor(hrs/24);
  var pad=function(n){return n<10?'0'+n:''+n;};
  if(days>=1) return days+'d '+pad(hrs%24)+':'+pad(mins%60);
  return pad(hrs)+':'+pad(mins%60);
}
// V120 — Resolve the asset's downtime end (= moment the breakdown timer
// freezes). Returns null while the ticket is in flight OR after a raiser
// challenge (timer continues). For repair_done / closed / scrapped we
// freeze at the LATEST repair_done | scrapped action's timestamp so a
// challenge → re-fix → close cycle settles on the final repair-done
// moment. No new DB column — purely derived from techActions.
function _mttsDowntimeEnd(t){
  if(!t) return null;
  var s=t.status;
  if(s==='open'||s==='assigned'||s==='work_in_progress'
     ||s==='awaiting_spares'||s==='awaiting_agency'
     ||s==='repair_done_challenged') return null;
  var acts=Array.isArray(t.techActions)?t.techActions:[];
  for(var i=acts.length-1;i>=0;i--){
    var a=acts[i];
    if(a && (a.action==='repair_done'||a.action==='scrapped')) return a.at||null;
  }
  return null;
}
// V38 — "14m left" countdown to a deadline (used for the Start-Work revoke
// window). Returns '' once the deadline has passed so the caller can
// hide the button.
function _mttsCountdownMins(deadlineIso){
  if(!deadlineIso) return '';
  var dl=new Date(deadlineIso).getTime();if(isNaN(dl)) return '';
  var ms=dl-Date.now();
  if(ms<=0) return '';
  var mins=Math.ceil(ms/60000);
  return mins+'m left';
}
// V38 — Live ticker. Every 30s, sweep all elements that carry a
// data-mtts-since (HH:MM elapsed) or data-mtts-until (countdown mins)
// attribute and update their textContent without re-rendering the card.
// Idempotent: starts once on first call. The single global interval is
// cheap (a few nodes once per 30s) and survives across re-renders.
var _mttsLiveTimerStarted=false;
function _mttsLiveTimerTick(){
  try{
    var since=document.querySelectorAll('[data-mtts-since]');
    Array.prototype.forEach.call(since,function(el){
      el.textContent=_mttsTimerHHMM(el.getAttribute('data-mtts-since'));
    });
    var until=document.querySelectorAll('[data-mtts-until]');
    Array.prototype.forEach.call(until,function(el){
      var txt=_mttsCountdownMins(el.getAttribute('data-mtts-until'));
      if(!txt){
        // Window expired — drop the container (button/badge) entirely so
        // the user can't click a stale revoke link.
        var dead=el.closest('[data-mtts-revoke-wrap]')||el;
        if(dead&&dead.parentNode) dead.parentNode.removeChild(dead);
      } else {
        el.textContent=txt;
      }
    });
  }catch(_){}
}
function _mttsStartLiveTimer(){
  if(_mttsLiveTimerStarted) return;
  _mttsLiveTimerStarted=true;
  // V132 — Drop the cadence from 30s → 10s so revoke / countdown buttons
  // disappear within ~10s of crossing the deadline (matters for the
  // 15-min revoke approval window — a 30s gap let stale buttons linger).
  setInterval(_mttsLiveTimerTick, 10000);
}

// ── Indian Standard Time helpers ─────────────────────────────────────────
// All MTTS timestamps must read and write as IST (UTC+5:30) regardless of
// the viewer's machine timezone. ISO strings stored in the DB are still UTC
// (the right canonical form); these helpers shift on the way in/out.
var _MTTS_IST_OFFSET_MS=(5*60+30)*60000;
// Format a UTC ISO timestamp as IST. Returns {date:'YYYY-MM-DD',time:'HH:MM'}
// or null for empty / invalid input.
function _mttsFmtIST(iso){
  if(!iso) return null;
  var t=new Date(iso).getTime();if(isNaN(t)) return null;
  var d=new Date(t+_MTTS_IST_OFFSET_MS);
  var pad=function(n){return n<10?'0'+n:''+n;};
  return {
    date:d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate()),
    time:pad(d.getUTCHours())+':'+pad(d.getUTCMinutes())
  };
}
function _mttsFmtISTDate(iso){var x=_mttsFmtIST(iso);return x?x.date:'—';}
function _mttsFmtISTDateTime(iso){var x=_mttsFmtIST(iso);return x?(x.date+' '+x.time):'—';}
// V32 — Format an IST instant as "dd-Mmm, hh:mm am/pm" — e.g.
// "17-May, 04:32 pm". Used in the ticket-detail activity timeline so
// rows read humanely without the YYYY- prefix.
function _mttsFmtISTDateTimeShort(iso){
  if(!iso) return '—';
  var t=new Date(iso).getTime();if(isNaN(t)) return '—';
  var d=new Date(t+_MTTS_IST_OFFSET_MS);
  var pad=function(n){return n<10?'0'+n:''+n;};
  var months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var day=pad(d.getUTCDate());
  var mon=months[d.getUTCMonth()];
  var h24=d.getUTCHours();
  var mins=pad(d.getUTCMinutes());
  var ampm=h24>=12?'pm':'am';
  var h12=h24%12;if(h12===0) h12=12;
  return day+'-'+mon+', '+pad(h12)+':'+mins+' '+ampm;
}
// Build a UTC ISO from a picker pair (YYYY-MM-DD + HH:MM) treated as IST.
function _mttsIstToISO(dateStr,timeStr){
  return new Date(dateStr+'T'+(timeStr||'00:00')+':00+05:30').toISOString();
}
// Current IST instant as a Date whose UTC-getters return IST fields. Use
// .getUTCHours()/.getUTCMinutes()/etc to read IST values.
function _mttsNowIST(){return new Date(Date.now()+_MTTS_IST_OFFSET_MS);}

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
  var nm=u?(u.fullName||u.name||uid):uid;
  // V140 — Names in this DB are stored as "Last First Middle" (Indian
  // surname-first convention). Reorder to "First Last" for display and
  // drop the middle name entirely. Single-word names pass through.
  var parts=String(nm).trim().split(/\s+/).filter(Boolean);
  if(parts.length<2) return nm;
  return parts[1]+' '+parts[0];
}
// V19 — Compact "First L." form for tight UI (e.g. the tech badge on
// ticket cards). Reuses the same Last-First-Middle reorder as
// _mttsUserDisp but truncates the surname to its first letter + dot.
function _mttsUserDispShort(uid){
  if(!uid) return '';
  var u=(DB.users||[]).find(function(x){return x&&(x.name===uid||x.id===uid);});
  var nm=u?(u.fullName||u.name||uid):uid;
  var parts=String(nm).trim().split(/\s+/).filter(Boolean);
  if(parts.length<2) return nm;
  // parts[0] = Last (stored first); parts[1] = First.
  var lastInitial=parts[0].charAt(0).toUpperCase();
  return parts[1]+' '+lastInitial+'.';
}

function _mttsCanRaise(){return _mttsIsSA()||_mttsIsMttsAdmin()||_mttsIsManager()||_mttsHasAccess('action.raiseTicket')||(CU&&(CU.mttsRoles||[]).indexOf('Ticket Raiser')>=0);}
function _mttsCanAllocate(){return _mttsIsSA()||_mttsIsMttsAdmin()||_mttsIsManager()||_mttsHasAccess('action.allocateTicket');}
function _mttsCanApprove(){return _mttsIsSA()||_mttsIsMttsAdmin()||_mttsIsManager()||_mttsHasAccess('action.approveTicket');}
function _mttsIsTechnicianOnTicket(t){
  if(!CU||!t) return false;
  // V38 — Prefer FK match (CU._dbId vs t.assignedToIds[]) so a username
  // rename in the master doesn't drop historic tickets out of "My
  // Tickets". Falls back to the legacy name-based check for rows that
  // predate the FK backfill.
  if(CU._dbId && Array.isArray(t.assignedToIds) && t.assignedToIds.indexOf(CU._dbId)>=0) return true;
  var me=CU.name||CU.id;
  return Array.isArray(t.assignedTo)&&t.assignedTo.indexOf(me)>=0;
}
// V38 — Did the current user raise this ticket? Used to gate the Step-5
// "Confirm work done / Challenge" action — only the original raiser can
// accept or dispute a technician's repair_done update. Prefer FK match.
function _mttsIsRaiserOnTicket(t){
  if(!CU||!t) return false;
  if(t.raisedById!=null && CU._dbId!=null && t.raisedById===CU._dbId) return true;
  var me=CU.name||CU.id;
  return t.raisedBy===me;
}

// ── Ticket list render ────────────────────────────────────────────────────
// V38 — Filter widgets pared down to two (search + plant). Status / breakdown /
// assigned dropdowns removed. A counter row above the list doubles as a
// status-bucket filter; each bucket button is colour-coded and clicking
// toggles its `bucket` state.
var _mttsTicketState={plant:'',breakdown:'',status:'',assigned:'',search:'',tab:'',view:'',bucket:'all',scope:'all'};

// V38 — Bucket → underlying-status-set mapping. Used both for counting and
// for filtering rows. WIP folds in the three in-flight tech statuses;
// Awaiting Confirmation folds repair_done with repair_done_challenged;
// Closed includes Not Repairable (scrapped) as a terminal alt.
// V26 — "All" bucket now means "all active" — i.e. every status except
// closed / scrapped. Closed tickets only appear when the user explicitly
// taps the Closed bucket. The default landing therefore hides historical
// closures so the user sees outstanding work first.
// V39 — A checkbox on the Closed bucket button lets the user FORCE
// closed tickets into the "All" view; toggled via _mttsTicketSetShowClosed.
var _mttsShowClosed=false;
function _mttsTicketSetShowClosed(checked){
  _mttsShowClosed=!!checked;
  _mttsRenderTickets();
}
var _MTTS_TICKET_BUCKETS={
  all:      {statuses:['open','assigned','work_in_progress','awaiting_spares','awaiting_agency','repair_done','repair_done_challenged'], label:'All', clr:'#0f172a', tip:'All active tickets (closed hidden)'},
  open:     {statuses:['open'], label:'Open', clr:'#dc2626', tip:'Open — awaiting technician allocation'},
  assigned: {statuses:['assigned'], label:'Allotted', clr:'#0ea5e9', tip:'Technician Allocated — work not yet started'},
  wip:      {statuses:['work_in_progress','awaiting_spares','awaiting_agency'], label:'WIP', clr:'#eab308', tip:'Work in Progress · Waiting for Spares · Waiting for External Service'},
  awaiting: {statuses:['repair_done','repair_done_challenged'], label:'Awaiting', clr:'#16a34a', tip:'Waiting for raiser confirmation / manager approval / reallocation'},
  closed:   {statuses:['closed','scrapped'], label:'Closed', clr:'#64748b', tip:'Closed by manager · or Not Repairable (terminal)'}
};
function _mttsTicketBucketSet(bucket){
  if(!_MTTS_TICKET_BUCKETS[bucket]) bucket='all';
  _mttsTicketState.bucket=bucket;
  _mttsRenderTickets();
}
// V119 — Scope toggle (All Tickets / My Work / My Tickets) lives above the
// status-bucket counter row. Switches which subset of mttsTickets the page
// counts and lists. "My Work" = tickets where assignedTo includes the
// current user (technicians only). "My Tickets" = tickets raisedBy the
// current user (anyone who can raise a ticket).
function _mttsTicketScopeSet(scope){
  if(['all','work','raised'].indexOf(scope)<0) scope='all';
  _mttsTicketState.scope=scope;
  // V125 — Switching scope also clears the bucket filter back to "all" so
  // the user sees every status under the new scope by default. Counters
  // are scope-aware so a stale bucket pick on the previous scope would
  // otherwise filter to zero rows on the new one.
  _mttsTicketState.bucket='all';
  _mttsRenderTickets();
}
// V38 — Reset all ticket filters + sorting back to default (bucket=All,
// plant unset, search blank). Triggered by the prominent ✕ button.
// The DOM inputs must be wiped BEFORE _mttsRenderTickets runs, because the
// render captures input/select values back into _mttsTicketState at its
// top — otherwise the just-cleared state would be overwritten with the
// stale DOM values and the user's filters wouldn't actually clear.
function _mttsTicketResetFilters(){
  _mttsTicketState.bucket='all';
  _mttsTicketState.scope='all';
  _mttsTicketState.plant='';
  _mttsTicketState.search='';
  _mttsTicketState.status='';
  _mttsTicketState.breakdown='';
  _mttsTicketState.assigned='';
  var s=document.getElementById('mttsTicketSearch');   if(s) s.value='';
  var p=document.getElementById('mttsTicketPlantFilter'); if(p) p.value='';
  _mttsRenderTickets();
}
// Switch the tickets-page tab. Persists on _mttsTicketState so re-renders
// keep the selection. Updates the active-class on the tab buttons and
// re-renders the card list.
function _mttsTicketTabSet(tab){
  _mttsTicketState.tab=tab;
  Array.prototype.forEach.call(document.querySelectorAll('.mtts-ticket-tab'),function(b){
    b.classList.toggle('is-active',b.getAttribute('data-tab')===tab);
  });
  _mttsRenderTickets();
}
// V138 — Build the list of tickets the current user raised that are
// sitting in repair_done waiting for THEIR confirm/challenge.
function _mttsPendingConfirmTickets(){
  if(!CU) return [];
  var meKey=CU.name||CU.id;
  var meDbId=CU._dbId||null;
  return (DB.mttsTickets||[]).filter(function(t){
    if(!t||t.status!=='repair_done'||t.confirmedByRaiser) return false;
    // V38 — FK match takes priority; legacy text fallback.
    if(meDbId!=null && t.raisedById!=null) return t.raisedById===meDbId;
    return t.raisedBy===meKey;
  });
}
// V138 — Paint the flashing confirmation-pending alert above the Raise
// Ticket button. Shows one combined banner — multiple pending tickets
// are summarised ("3 of your tickets…"); clicking the banner opens the
// review popup for the most recently resolved one.
function _mttsRenderConfirmAlert(){
  var el=document.getElementById('mttsTicketConfirmAlert');
  if(!el) return;
  var pending=_mttsPendingConfirmTickets();
  if(!pending.length){ el.style.display='none'; el.innerHTML=''; return; }
  // Newest-resolved first so the user sees the freshest one if they click.
  pending.sort(function(a,b){
    var ar=(a.techActions||[]).reduce(function(acc,x){return x&&x.action==='repair_done'?(x.at||acc):acc;},'');
    var br=(b.techActions||[]).reduce(function(acc,x){return x&&x.action==='repair_done'?(x.at||acc):acc;},'');
    return String(br).localeCompare(String(ar));
  });
  var first=pending[0];
  var ids=pending.map(function(t){return '<b>'+(t.id||'')+'</b>';});
  var msg;
  if(pending.length===1){
    msg='Your Ticket id '+ids[0]+' has been resolved by tech and your confirmation is required.';
  } else {
    msg=pending.length+' of your tickets — '+ids.join(', ')+' — have been resolved by tech and need your confirmation.';
  }
  el.dataset.firstId=first.id||'';
  el.innerHTML=
    '<span class="mtts-confirm-alert-icon">🔔</span>'+
    '<span class="mtts-confirm-alert-msg">'+msg+'</span>'+
    '<span class="mtts-confirm-alert-cta">Review now ›</span>';
  el.style.display='flex';
}
// V138 — Click handler for the alert banner. Opens the Review popup for
// the most recently resolved pending ticket so the user can confirm or
// challenge in one click. No-op if the list has cleared in the meantime.
function _mttsAlertOpenFirstConfirm(){
  var el=document.getElementById('mttsTicketConfirmAlert');
  var id=el&&el.dataset?el.dataset.firstId:'';
  if(!id) return;
  if(typeof _mttsOpenConfirmPopup==='function') _mttsOpenConfirmPopup(id);
}
// V129 — Pure-presentational summary of a ticket, mirrors the layout used
// on the tickets-list card (ID + raiser/timestamp · Status + Priority ·
// Plant pill + Asset · Tech badge · Asset Condition / Symptoms / Downtime).
// No click target, no action buttons — embed inside any panel that needs
// to show "this ticket in detail" (e.g., the Update Ticket modal header).
// The Downtime chip honours _mttsDowntimeEnd so a frozen repair_done
// ticket renders the static slate pill, mirroring the live list.
function _mttsTicketSummaryHtml(t){
  if(!t) return '';
  var asset=byId(DB.mttsAssets||[],t.assetCode);
  var assetName=_mttsAssetLabel(asset,t.assetCode||'(missing)');
  var crit=(asset&&asset.criticality)||'Medium';
  var critClr={High:'#dc2626',Medium:'#f59e0b',Low:'#16a34a'}[crit]||'#64748b';
  var raiser=t.raisedBy?_mttsUserDisp(t.raisedBy):'';
  var raisedDt=_mttsFmtISTDateTime(t.raisedAt);
  var bdLabel=_MTTS_BREAKDOWN_LABEL[t.breakdownType]||t.breakdownType||'—';
  var raisedAct=(t.techActions||[]).find(function(a){return a&&a.action==='raised';});
  var descTxt=raisedAct?String(raisedAct.note||'').trim():'';
  var descShort=descTxt?(descTxt.length>140?descTxt.slice(0,140).replace(/</g,'&lt;')+'…':descTxt.replace(/</g,'&lt;')):'';
  var isTerminal=(t.status==='closed'||t.status==='scrapped');
  var downEnd=_mttsDowntimeEnd(t);
  var breakdownSinceIso=t.breakdownSince||t.raisedAt||'';
  // V36 — Match the list-card BD chip exactly (label-on-hover via
  // .mtts-bd-chip + smaller font / padding).
  var _bdTip=(t.confirmedByRaiser||isTerminal)?'Downtime':'Breakdown Since';
  var bdsHtml;
  if(isTerminal && !downEnd){
    bdsHtml='<span style="color:var(--text3)">—</span>';
  } else if(downEnd){
    bdsHtml='<span class="mtts-bd-chip" data-mtts-tip="'+_bdTip+'" title="'+_bdTip+'" style="display:inline-flex;align-items:center;font-family:var(--mono);font-weight:900;font-size:18px;color:#0f172a;letter-spacing:.6px;background:#e2e8f0;border:1.5px solid #94a3b8;padding:2px 9px;border-radius:6px;line-height:1;position:relative">'+_mttsTimerHHMM(breakdownSinceIso, downEnd)+'</span>';
  } else {
    bdsHtml='<span class="mtts-bd-chip" data-mtts-since="'+breakdownSinceIso+'" data-mtts-tip="'+_bdTip+'" title="'+_bdTip+'" style="display:inline-flex;align-items:center;font-family:var(--mono);font-weight:900;font-size:18px;color:#dc2626;letter-spacing:.6px;background:#fef2f2;border:1.5px solid #fca5a5;padding:2px 9px;border-radius:6px;line-height:1;position:relative">'+_mttsTimerHHMM(breakdownSinceIso)+'</span>';
  }
  // V29 — Priority flashes pre-repair_done, mirrors list-card behaviour.
  var preRepair=(t.status!=='repair_done'&&t.status!=='closed'&&t.status!=='scrapped');
  var prioFlashCls=(crit==='High'&&preRepair)?' mtts-prio-flash':'';
  // V41 — SA / MTTS Admin get the asset name as a clickable link that
  // opens _mttsAssetOpen (asset-edit modal). Save / Cancel naturally
  // returns the user to the tickets page because the modal overlays
  // it. Other roles see plain text.
  var canEditAssetFromTicket=((typeof _mttsIsSA==='function'&&_mttsIsSA())||(typeof _mttsIsMttsAdmin==='function'&&_mttsIsMttsAdmin()))&&t.assetCode;
  var assetCodeEsc=String(t.assetCode||'').replace(/'/g,"\\'");
  var assetNameHtml=canEditAssetFromTicket
    ? '<span onclick="event.stopPropagation();_mttsAssetOpen(\''+assetCodeEsc+'\')" title="Edit asset" style="font-size:15px;font-weight:800;color:var(--accent);text-decoration:underline;text-underline-offset:2px;cursor:pointer">'+assetName+'</span>'
    : '<span style="font-size:15px;font-weight:800;color:var(--text)">'+assetName+'</span>';
  return '<div class="mtts-tcard-head" style="align-items:flex-start">'+
    '<div class="mtts-tcard-headline" style="flex:1;min-width:0">'+
      // V36 — Head: Ticket ID + BD chip side-by-side. Owner flag is
      // painted by the wrapper (corner triangle); raiser + timestamp
      // appear on the full-width row below the head.
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'+
        '<div style="font-family:var(--mono);font-size:22px;font-weight:900;color:#0f172a;letter-spacing:.4px;line-height:1.1">'+(t.id||'')+'</div>'+
        bdsHtml+
      '</div>'+
    '</div>'+
    '<div style="display:flex;align-items:center;gap:5px;flex-shrink:0">'+
      _mttsStatusBadgeBig(t)+
      '<span class="mtts-prio-pill'+prioFlashCls+'" title="'+crit+' priority" style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;font-size:14px;font-weight:900;background:'+critClr+';color:#fff;box-shadow:0 1px 3px rgba(0,0,0,.15);flex-shrink:0">'+(crit?String(crit).charAt(0).toUpperCase():'?')+'</span>'+
    '</div>'+
  '</div>'+
  // V36 — Full-width row below the head: raiser + timestamp, spanning
  // both the Ticket ID column and the Status/Priority cluster.
  ((raiser||raisedDt)?'<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:12px;color:var(--text2);line-height:1.2">'+
    (raiser?'<span style="display:inline-flex;align-items:center;gap:5px"><span style="color:var(--text3);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.4px">By</span><span style="font-weight:700">'+raiser+'</span></span>':'')+
    (raisedDt?'<span style="font-family:var(--mono);color:var(--text3)">📅 '+raisedDt+'</span>':'')+
  '</div>':'')+
  // Plant short-pill + Asset name flow as one wrapping sentence.
  '<div style="margin-top:8px;line-height:1.25">'+
    _mttsPlantBadgeShort(t.plant)+
    ' '+assetNameHtml+
  '</div>'+
  '<div style="margin-top:6px">'+
    ((Array.isArray(t.assignedTo)&&t.assignedTo.length)
      ? _mttsTechBadge(t)
      : '<span style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:10px;font-size:11px;font-weight:800;background:transparent;color:#64748b;border:1.5px solid #cbd5e1;letter-spacing:.3px;text-transform:uppercase">👥 Allocation not done</span>')+
  '</div>'+
  // V36 — Asset Condition + Symptoms rows match the list card; the
  // Breakdown / Downtime row was retired in V18 (chip moved to the
  // head, label-on-hover).
  '<div class="mtts-tcard-rows" style="margin-top:6px">'+
    '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Asset Condition</span><span class="mtts-tcard-val">'+bdLabel+_mttsBdCategoryBadge(t)+'</span></div>'+
    '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Symptoms</span><span class="mtts-tcard-val" style="white-space:normal;text-align:left;line-height:1.3">'+(descShort||'<span style="color:var(--text3)">—</span>')+'</span></div>'+
  '</div>';
}
function _mttsRenderTickets(){
  var wrap=document.getElementById('mttsTicketTableWrap');if(!wrap) return;
  // Show / hide "Raise Ticket" based on role.
  // V10 — Legacy summary-bar Raise button is now permanently hidden;
  // the inline filter-row "+ Raise Ticket" handles the action.
  var btnRaise=document.getElementById('btnMttsRaise');
  if(btnRaise) btnRaise.style.display='none';
  // V138 — Refresh the flashing "confirmation pending" alert above the
  // Raise Ticket button. Lives in #mttsTicketConfirmAlert; only visible
  // when the current user has at least one repair_done ticket they
  // raised that hasn't been confirmed/challenged yet.
  if(typeof _mttsRenderConfirmAlert==='function') _mttsRenderConfirmAlert();

  // V38 — Only two filter widgets left: search + plant. Capture them
  // before re-render so user input isn't lost on the next paint.
  var fPlantEl=document.getElementById('mttsTicketPlantFilter');
  var fSearchEl=document.getElementById('mttsTicketSearch');
  if(fPlantEl) _mttsTicketState.plant=fPlantEl.value;
  if(fSearchEl) _mttsTicketState.search=fSearchEl.value;
  var activeId=document.activeElement&&document.activeElement.id;
  var caretStart=null,caretEnd=null;
  if(activeId==='mttsTicketSearch'&&fSearchEl){
    try{caretStart=fSearchEl.selectionStart;caretEnd=fSearchEl.selectionEnd;}catch(e){}
  }

  // V38 — Tabs removed. Single unified list; per-ticket "TR by me" /
  // "My Allotted Ticket" tags surface ownership on each row/card instead.
  // The `scope` filter slots are kept (just defaulted to 'all') so any
  // dashboard / dashboard-card deep links that set scope still work.
  _mttsTicketState.tab='all';
  var fPlant=_mttsTicketState.plant||'';
  var fSearch=(_mttsTicketState.search||'').toLowerCase().trim();
  var fBucket=_mttsTicketState.bucket||'all';
  var fScope=_mttsTicketState.scope||'all';
  var bucketCfg=_MTTS_TICKET_BUCKETS[fBucket]||_MTTS_TICKET_BUCKETS.all;
  // V39 — Row filter respects the "show closed" toggle the same way
  // the bucket counter does: the "all" bucket includes closed/scrapped
  // when the checkbox is on.
  var bucketStatuses=(bucketCfg.statuses||[]).slice();
  if(fBucket==='all' && _mttsShowClosed){
    if(bucketStatuses.indexOf('closed')<0) bucketStatuses.push('closed');
    if(bucketStatuses.indexOf('scrapped')<0) bucketStatuses.push('scrapped');
  }
  var meKey=CU?(CU.name||CU.id):'';

  // V119 — Scope subset (All / My Work / My Tickets). Computed first so the
  // bucket counter row and the rendered list both work against the same
  // user-narrowed source. "My Work" = assigned to current user (tech view);
  // "My Tickets" = raised by current user.
  var scopedSource=(DB.mttsTickets||[]).filter(function(t){
    if(!t) return false;
    // V38 — Scope filter: prefer FK id match, fall back to name match.
    var _meDbIdF=CU?CU._dbId:null;
    if(fScope==='work'){
      if(_meDbIdF!=null && Array.isArray(t.assignedToIds) && t.assignedToIds.indexOf(_meDbIdF)>=0) return true;
      return Array.isArray(t.assignedTo)&&t.assignedTo.indexOf(meKey)>=0;
    }
    if(fScope==='raised'){
      if(_meDbIdF!=null && t.raisedById!=null && t.raisedById===_meDbIdF) return true;
      return t.raisedBy===meKey;
    }
    return true;
  });

  // V38 — Search now matches against ticket ID + asset (name/MM/serial/code).
  // Status comes from the bucket counter row, not a dropdown.
  var rows=scopedSource.filter(function(t){
    if(bucketStatuses && bucketStatuses.indexOf(t.status)<0) return false;
    if(fPlant&&t.plant!==fPlant) return false;
    if(fSearch){
      var asset=byId(DB.mttsAssets||[],t.assetCode);
      var hay=((t.id||'')+' '+((asset&&asset.name)||'')+' '+_mttsAssetMM(asset)+' '+((asset&&asset.serialNo)||'')+' '+(t.assetCode||'')+' '+_mttsPlantLabel(t.plant));
      if(hay.toLowerCase().indexOf(fSearch)<0) return false;
    }
    return true;
  });
  // Always sort by raisedAt descending (most recent first).
  rows.sort(function(a,b){return (b.raisedAt||'').localeCompare(a.raisedAt||'');});

  // V38 — Bucket counter row (also the status filter). One button per
  // bucket; numbers only, coloured. Native title attribute provides the
  // hover description. Active bucket = solid filled colour; inactive
  // shows a tinted ghost. All counters fit in one horizontally-scrollable
  // row on narrow screens.
  var sumEl=document.getElementById('mttsTicketSummary');
  if(sumEl){
    var bucketOrder=['all','open','assigned','wip','awaiting','closed'];
    // V119 — counts reflect the active scope subset, not the entire DB.
    // V26/V39 — All buckets have an explicit statuses list. When the
    // "show closed" checkbox is on, the "all" bucket extends its
    // statuses to include closed/scrapped too.
    var _bucketStatusesFor=function(k){
      var st=(_MTTS_TICKET_BUCKETS[k].statuses||[]).slice();
      if(k==='all' && _mttsShowClosed){
        if(st.indexOf('closed')<0) st.push('closed');
        if(st.indexOf('scrapped')<0) st.push('scrapped');
      }
      return st;
    };
    var bucketCounts={};
    bucketOrder.forEach(function(k){
      var statuses=_bucketStatusesFor(k);
      bucketCounts[k]=scopedSource.filter(function(t){return t&&statuses.indexOf(t.status)>=0;}).length;
    });
    var sumHtml='';
    // V120 — Scope toggle row: All Tickets (everyone) · My Allotted Tickets
    // (technicians) · Tickets Raised by me (anyone who can raise). Counts
    // shown on the buttons are the **open** subset for that scope —
    // closed / scrapped tickets are excluded so the buttons highlight
    // outstanding work, not historical volume.
    var _notClosed=function(t){return t && t.status!=='closed' && t.status!=='scrapped';};
    var allOpen=(DB.mttsTickets||[]).filter(_notClosed).length;
    // V38 — Match on FK id when present, else fall back to name (legacy).
    var _meDbId=CU?CU._dbId:null;
    var myAllottedOpen=(DB.mttsTickets||[]).filter(function(t){
      if(!_notClosed(t)) return false;
      if(_meDbId!=null && Array.isArray(t.assignedToIds) && t.assignedToIds.indexOf(_meDbId)>=0) return true;
      return Array.isArray(t.assignedTo) && t.assignedTo.indexOf(meKey)>=0;
    }).length;
    var myRaisedOpen=(DB.mttsTickets||[]).filter(function(t){
      if(!_notClosed(t)) return false;
      if(_meDbId!=null && t.raisedById!=null && t.raisedById===_meDbId) return true;
      return t.raisedBy===meKey;
    }).length;
    // V12 — "My Tickets" was Technician-only; extended to Manager / MTTS
    // Admin / SA so admins who also get allotted tickets can filter to
    // their queue. Tickets are filtered by assignedTo containing meKey,
    // so the chip still shows zero for users who never appear there.
    var canSeeMyWork=(typeof _mttsIsTechnician==='function' && _mttsIsTechnician())
      || (typeof _mttsIsManager==='function' && _mttsIsManager())
      || (typeof _mttsIsMttsAdmin==='function' && _mttsIsMttsAdmin())
      || (typeof _mttsIsSA==='function' && _mttsIsSA());
    var scopes=[{k:'all',l:'All',n:allOpen,tip:'All tickets currently not closed'}];
    if(canSeeMyWork)
      scopes.push({k:'work',l:'My Tickets',n:myAllottedOpen,tip:'Open tickets allotted to you'});
    if(typeof _mttsCanRaise==='function' && _mttsCanRaise())
      scopes.push({k:'raised',l:'Tickets by me',n:myRaisedOpen,tip:'Open tickets you have raised'});
    if(scopes.length>1){
      // V29 — Scope buttons always wear their designated colours; the
      // selected one gets a thick outline (box-shadow halo) so the
      // background tint isn't lost when the button is active. Matches
      // the corner-flag colours on the ticket card so the link reads
      // at a glance: 'work' → grey, 'raised' → pink, 'all' → white.
      var _scopeTheme={
        all:    {bg:'#fff',    fg:'#0f172a', bd:'#cbd5e1', sel:'#0f172a'},
        work:   {bg:'#e2e8f0', fg:'#1e293b', bd:'#94a3b8', sel:'#475569'},
        raised: {bg:'#fce7f3', fg:'#831843', bd:'#f9a8d4', sel:'#db2777'}
      };
      // V1 (260518) — Force single-row layout: `flex-wrap:nowrap` and
      // `min-width:0` so all three scope buttons share a row even on the
      // narrowest phones. Vertical padding bumped + line-height eased so
      // the label inside can wrap to 2 lines (e.g. "Tickets by me") and
      // still read centred.
      sumHtml+='<div style="display:flex;gap:6px;flex-wrap:nowrap;align-items:stretch;margin-bottom:6px">';
      scopes.forEach(function(s){
        var isAct=(fScope===s.k);
        var th=_scopeTheme[s.k]||_scopeTheme.all;
        var bg=th.bg, fg=th.fg, bd=th.bd;
        var selectedRing=isAct?(';box-shadow:0 0 0 3px '+th.sel+';outline:none'):'';
        var pulseCls=(s.n>0)?' mtts-scope-count-pulse':'';
        sumHtml+='<button type="button" onclick="_mttsTicketScopeSet(\''+s.k+'\')" title="'+s.tip+'" '+
          'style="flex:1 1 0;min-width:0;padding:8px 8px;border:1.5px solid '+bd+';background:'+bg+';color:'+fg+';border-radius:8px;font-size:12px;font-weight:800;letter-spacing:.3px;cursor:pointer;line-height:1.2;display:inline-flex;align-items:center;justify-content:center;gap:6px'+selectedRing+'">'+
            '<span style="white-space:normal;text-align:center;flex:1 1 auto;min-width:0">'+s.l+'</span>'+
            '<span class="'+pulseCls.trim()+'" style="flex:0 0 auto;font-family:var(--mono);font-size:13px;font-weight:900;background:#dc2626;color:#fff;padding:1px 8px;border-radius:10px;min-width:24px;text-align:center;box-shadow:0 0 0 1.5px rgba(255,255,255,.5) inset">'+s.n+'</span>'+
          '</button>';
      });
      sumHtml+='</div>';
    }
    // V38 — wrap allowed so on very narrow phones the row breaks onto two
    // lines instead of forcing a horizontal scroll. Buttons inside share
    // row width via flex:1 1 0 with a min-width floor.
    // V125 — Bucket counters: tiny INITIAL stacked above the count number,
    // full label revealed in a prominent wrap-friendly hover tooltip.
    // Initials may collide (All / Allotted / Awaiting all start with A) —
    // the colour pill + tooltip disambiguate. Native `title` stays for
    // accessibility.
    sumHtml+='<div class="mtts-bucket-row" style="display:flex;gap:6px;flex-wrap:wrap;align-items:stretch">';
    bucketOrder.forEach(function(k){
      var cfg=_MTTS_TICKET_BUCKETS[k];
      var n=bucketCounts[k];
      var isActive=(fBucket===k);
      var bg=isActive?cfg.clr:(cfg.clr+'22');
      var fg=isActive?'#fff':cfg.clr;
      var border=isActive?cfg.clr:(cfg.clr+'55');
      // V39 — Closed bucket gets a checkbox above the initial that
      // toggles whether closed/scrapped tickets are merged into the
      // "All" view. Unchecked (default) → All hides closed; checked →
      // All includes closed too.
      var tipText=cfg.label+' — '+cfg.tip+(k==='closed'?' · ☑ Show closed in "All"':'');
      var tipEsc=tipText.replace(/"/g,'&quot;');
      var initial=String(cfg.label||k).slice(0,1).toUpperCase();
      var topRow;
      if(k==='closed'){
        topRow='<label onclick="event.stopPropagation()" title="Show closed tickets in the All view" '+
          'style="display:inline-flex;align-items:center;justify-content:center;gap:3px;font-size:11px;font-weight:800;letter-spacing:.5px;line-height:1;cursor:pointer;color:'+fg+'">'+
            '<input type="checkbox" '+(_mttsShowClosed?'checked':'')+' onchange="event.stopPropagation();_mttsTicketSetShowClosed(this.checked)" style="width:13px;height:13px;margin:0;accent-color:'+cfg.clr+';vertical-align:middle">'+
            '<span style="opacity:.85">'+initial+'</span>'+
          '</label>';
      } else {
        topRow='<span style="font-size:11px;font-weight:800;letter-spacing:.5px;line-height:1;opacity:.85">'+initial+'</span>';
      }
      sumHtml+='<button type="button" class="mtts-bucket-btn" onclick="_mttsTicketBucketSet(\''+k+'\')" '+
        'title="'+tipEsc+'" data-mtts-tip="'+tipEsc+'" '+
        'style="flex:1 1 0;min-width:50px;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:6px 6px;border:1.5px solid '+border+';background:'+bg+';color:'+fg+';border-radius:8px;cursor:pointer;line-height:1;transition:transform .08s;position:relative">'+
          topRow+
          '<span style="font-family:var(--mono);font-size:20px;font-weight:900;line-height:1">'+n+'</span>'+
        '</button>';
    });
    sumHtml+='</div>';
    sumEl.innerHTML=sumHtml;
  }

  // V38 — Filter bar trimmed to just the two controls the user keeps:
  // a search box (Ticket ID / Asset) and a Plant combobox. All other
  // dropdowns moved to the counter row above (status) or were removed
  // (breakdown / assigned). View toggle stays so users can flip between
  // cards and table on wide screens.
  var plantsList=_mttsPlantList(false);
  var plantOpts='<option value="">All plants</option>'+plantsList.map(function(p){return '<option value="'+p.value+'"'+(fPlant===p.value?' selected':'')+'>'+p.label+'</option>';}).join('');
  var inlineSearchVal=(_mttsTicketState.search||'').replace(/"/g,'&quot;');
  // V123 — Tickets page is card-only; the table toggle is hidden so users
  // can't flip to the wide-screen table view here. _mttsViewMode is bypassed
  // (any stale 'table' value in localStorage is ignored) but the toggle
  // helpers stay defined in case we re-enable it later.
  var view='cards';
  // V38 — Filter row rendered into #mttsTicketFiltersHost (sibling of
  // summary-bar inside the one sticky-head panel) so search / plant / ✕
  // all live on the SAME sticky surface as the summary counters.
  // V11 — Filter row layout:
  //   • Search: 20ch wide.
  //   • Plant combo: content-sized (flex:0 0 auto, width:auto) — doesn't
  //     stretch to fill the row.
  //   • ✕ reset button: 34x34 (unchanged).
  //   • Raise Ticket: parked right next to the ✕ button on the filter
  //     row. Hidden when the current user lacks raise permission.
  var canRaise=(typeof _mttsCanRaise==='function')?_mttsCanRaise():true;
  var filterHtml=
    '<div class="mtts-tcard-filters" style="flex-wrap:nowrap;align-items:center;gap:6px">'+
      '<input type="search" id="mttsTicketSearch" placeholder="🔍 Search…" oninput="_mttsRenderTickets()" value="'+inlineSearchVal+'" style="flex:0 0 auto;width:15ch;min-width:0">'+
      '<select id="mttsTicketPlantFilter" onchange="_mttsRenderTickets()" style="flex:0 0 auto;width:auto;min-width:0">'+plantOpts+'</select>'+
      '<button type="button" onclick="_mttsTicketResetFilters()" title="Clear all filters and reset sort order" '+
        'style="flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:2px solid #dc2626;background:#fff;color:#dc2626;border-radius:8px;cursor:pointer;font-weight:900;font-size:18px;line-height:1">'+
        '✕'+
      '</button>'+
      (canRaise?'<button type="button" id="btnMttsRaiseInline" onclick="_mttsTicketRaiseOpen()" style="flex:0 0 auto;font-size:13px;font-weight:900;padding:6px 12px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;letter-spacing:.3px;white-space:nowrap;display:inline-flex;align-items:center;gap:3px;line-height:1"><span style="font-size:22px;font-weight:900;line-height:1">+</span><span>Ticket</span></button>':'')+
    '</div>';
  var filterHost=document.getElementById('mttsTicketFiltersHost');
  if(filterHost) filterHost.innerHTML=filterHtml;
  // V10 — Inline Raise Ticket button replaces the summary-bar one; hide
  // the legacy button so it doesn't double up.
  var btnRaiseOld=document.getElementById('btnMttsRaise');
  if(btnRaiseOld) btnRaiseOld.style.display='none';
  var html='';
  if(view==='table'){
    html+=_mttsTicketTableHtml(rows);
  } else if(!rows.length){
    html+='<div class="mtts-tcards"><div class="mtts-tcard-empty">No tickets match the current filters.</div></div>';
  } else {
    html+='<div class="mtts-tcards">';
    rows.forEach(function(t){
      var asset=byId(DB.mttsAssets||[],t.assetCode);
      var assetName=_mttsAssetLabel(asset,t.assetCode||'(missing)');
      var assetType=asset?asset.assetType:'';
      var crit=(asset&&asset.criticality)||'Medium';
      var techList=(t.assignedTo||[]).map(function(u){return _mttsUserDisp(u);}).join(', ');
      var idEsc=String(t.id||'').replace(/'/g,"\\'");
      var raised=_mttsFmtISTDate(t.raisedAt);
      var raiser=t.raisedBy?_mttsUserDisp(t.raisedBy):'';
      var plantColor=_mttsPlantColor(t.plant)||'#94a3b8';
      var plantName=_mttsPlantLabel(t.plant);
      var bdLabel=_MTTS_BREAKDOWN_LABEL[t.breakdownType]||t.breakdownType||'—';
      var isTerminal=(t.status==='closed'||t.status==='scrapped');
      // V120 — Freeze the breakdown duration at repair_done (asset is back up).
      // On challenge, _mttsDowntimeEnd returns null and the timer resumes.
      var downEnd=_mttsDowntimeEnd(t);
      var downFor=downEnd
        ? _mttsTimerSince(t.breakdownSince||t.raisedAt, downEnd)
        : (isTerminal?'—':_mttsTimerSince(t.breakdownSince||t.raisedAt));
      // Status-driven card background — at-a-glance lifecycle cue.
      // Open=light red, assigned=light blue, awaiting spares/agency
      // (in-progress) = yellow, repair done = light green, closed
      // (approved) = darker green, scrapped = orange.
      var cardBg=({
        open:'#fee2e2',
        assigned:'#dbeafe',
        work_in_progress:'#fef9c3',      // yellow tint
        awaiting_spares:'#ffedd5',        // orange tint
        awaiting_agency:'#ffedd5',        // orange tint
        repair_done:'#dcfce7',
        repair_done_challenged:'#fee2e2',
        closed:'#bbf7d0',
        scrapped:'#fed7aa'
      })[t.status]||'#fff';
      // Description / Symptoms — the note attached to the original
      // 'raised' tech action. Truncate long text on the card so the
      // layout stays compact; full text is visible in the detail view.
      var raisedAct=(t.techActions||[]).find(function(a){return a&&a.action==='raised';});
      var descTxt=raisedAct?String(raisedAct.note||'').trim():'';
      var descShort=descTxt?(descTxt.length>140?descTxt.slice(0,140).replace(/</g,'&lt;')+'…':descTxt.replace(/</g,'&lt;')):'';
      // Actions split: primary status-driven buttons on the left, edit /
      // delete icons pinned to the bottom-right. The whole card is
      // clickable to open detail view, so each button calls
      // event.stopPropagation() to avoid double-firing the card handler.
      var stop="event.stopPropagation();";
      var primaryAct='';
      var sideAct='';
      if(t.status==='open'){
        if(_mttsCanAllocate()){
          // 260519-V35 — Renamed "Allocate" → "Assign" per user request.
          primaryAct+='<button onclick="'+stop+'_mttsTicketAllocateOpen(\''+idEsc+'\')" style="font-size:12px;padding:6px 10px;font-weight:700;background:#0ea5e9;color:#fff;border:none;border-radius:5px;cursor:pointer">👥 Assign</button>';
        }
        if(_mttsCanEditTicket(t)){
          sideAct+='<button class="mtts-tcard-iconbtn is-edit" onclick="'+stop+'_mttsTicketEditOpen(\''+idEsc+'\')" title="Edit ticket" aria-label="Edit ticket">✏</button>';
          sideAct+='<button class="mtts-tcard-iconbtn is-del"  onclick="'+stop+'_mttsTicketDelete(\''+idEsc+'\')" title="Delete ticket" aria-label="Delete ticket">🗑</button>';
        }
      } else if(t.status==='assigned'&&(_mttsIsTechnicianOnTicket(t)||_mttsIsSA()||_mttsIsMttsAdmin()||_mttsIsManager())){
        // V38 — Step 3: tech first marks "Start Work" before posting updates.
        // Pass the click event so the confirm popup can anchor to this button.
        primaryAct+='<button onclick="'+stop+'_mttsTicketStartWork(\''+idEsc+'\',event)" style="font-size:12px;padding:6px 10px;font-weight:700;background:#2563eb;color:#fff;border:none;border-radius:5px;cursor:pointer">▶ Start Work</button>';
      } else if(t.status==='work_in_progress'&&(_mttsIsTechnicianOnTicket(t)||_mttsIsSA()||_mttsIsMttsAdmin()||_mttsIsManager())){
        // V25/V26 — Once a ticket is WIP the only on-card action is
        // Update Status; Reassign hidden because the tech is actively
        // working. If the tech tapped "Partial work done", the card
        // flips to a paused view: Resume Work primary + Update Status
        // disabled until they tap Resume.
        if(_mttsIsPartialPaused(t)){
          primaryAct+='<button onclick="'+stop+'_mttsTicketResumeWork(\''+idEsc+'\',event)" style="font-size:12px;padding:6px 10px;font-weight:700;background:#2563eb;color:#fff;border:none;border-radius:5px;cursor:pointer">▶ Resume Work</button>';
          primaryAct+='<button disabled title="Resume work first to post a status update" style="font-size:12px;padding:6px 10px;font-weight:700;background:#e2e8f0;color:#94a3b8;border:1px solid #cbd5e1;border-radius:5px;cursor:not-allowed">🔧 Update Status</button>';
        } else {
          primaryAct+='<button onclick="'+stop+'_mttsTicketActionOpen(\''+idEsc+'\')" style="font-size:12px;padding:6px 10px;font-weight:700;background:#16a34a;color:#fff;border:none;border-radius:5px;cursor:pointer">🔧 Update Status</button>';
        }
      } else if((t.status==='awaiting_spares'||t.status==='awaiting_agency')&&(_mttsIsTechnicianOnTicket(t)||_mttsIsSA()||_mttsIsMttsAdmin()||_mttsIsManager())){
        // V131 — While the ticket is parked waiting for spares / external
        // service the tech can't post arbitrary status updates. They first
        // tap ▶ Resume Work (mirrors the Start Work flow), which flips the
        // ticket back to Work in Progress; once resumed the Update Status
        // branch above takes over. Update Status is rendered here as a
        // disabled chip so the user knows where the action will surface.
        primaryAct+='<button onclick="'+stop+'_mttsTicketResumeWork(\''+idEsc+'\',event)" style="font-size:12px;padding:6px 10px;font-weight:700;background:#2563eb;color:#fff;border:none;border-radius:5px;cursor:pointer">▶ Resume Work</button>';
        primaryAct+='<button disabled title="Resume work first to post a status update" style="font-size:12px;padding:6px 10px;font-weight:700;background:#e2e8f0;color:#94a3b8;border:1px solid #cbd5e1;border-radius:5px;cursor:not-allowed">🔧 Update Status</button>';
      } else if(t.status==='repair_done'){
        // V120 — Step 5: raiser sees a single ✓ Confirm button that opens
        // a review popup. The popup shows ticket details + repair photos
        // and lets the raiser either confirm the fix or challenge it with
        // mandatory remarks. Inline "⚠ Challenge" button retired.
        if(_mttsIsRaiserOnTicket(t)&&!t.confirmedByRaiser){
          primaryAct+='<button onclick="'+stop+'_mttsOpenConfirmPopup(\''+idEsc+'\')" style="font-size:12px;padding:6px 10px;font-weight:700;background:#16a34a;color:#fff;border:none;border-radius:5px;cursor:pointer">✓ Confirm</button>';
        }
        // V121 — Approve & Close is gated on raiser confirmation. Until the
        // TR has clicked Confirm in the review popup the manager only sees
        // a muted "Waiting for raiser confirmation" hint. Reallocate
        // re-enters via the repair_done_challenged branch below.
        if(_mttsCanApprove()){
          if(t.confirmedByRaiser){
            primaryAct+='<button onclick="'+stop+'_mttsTicketApproveOpen(\''+idEsc+'\')" style="font-size:12px;padding:6px 10px;font-weight:700;background:#16a34a;color:#fff;border:none;border-radius:5px;cursor:pointer">✓ Approve & Close</button>';
          } else {
            primaryAct+='<span title="The raiser has not yet confirmed the repair" style="display:inline-block;font-size:11px;font-weight:700;padding:5px 10px;border-radius:5px;background:#f1f5f9;color:#475569;border:1px dashed #94a3b8">⏳ Awaiting raiser confirmation</span>';
          }
        }
      } else if(t.status==='repair_done_challenged'&&_mttsCanApprove()){
        // V122 — Challenged repair: clicking Reallocate now opens the
        // technician-allocation modal directly so the MM can pick a
        // (possibly different) tech in one step. The modal's confirm
        // handler (_mttsTicketAllocateConfirm) flips the status back to
        // `assigned` and logs a 'reassigned' techAction.
        primaryAct+='<button onclick="'+stop+'_mttsTicketAllocateOpen(\''+idEsc+'\')" style="font-size:12px;padding:6px 10px;font-weight:700;background:#ea580c;color:#fff;border:none;border-radius:5px;cursor:pointer">↩ Reallocate</button>';
      }
      // Reassign suppressed once the ticket reaches Repair done / Closed —
      // work is sealed at that point and reshuffling techs there would
      // just confuse the audit trail.
      // V25 — Reassign hidden while a tech is actively working (WIP).
      // Available again when the ticket is parked (awaiting_spares /
      // awaiting_agency) or hasn't been started yet (assigned).
      if((t.status==='assigned'||t.status==='awaiting_spares'||t.status==='awaiting_agency')&&_mttsCanAllocate()){
        primaryAct+='<button onclick="'+stop+'_mttsTicketAllocateOpen(\''+idEsc+'\')" title="Reassign technicians" style="font-size:12px;padding:6px 10px;font-weight:700;background:#fff;border:1px solid #0ea5e9;color:#0369a1;border-radius:5px;cursor:pointer">👥 Reassign</button>';
      }
      // V136 — Revoke ✓ retired. Closed tickets instead expose an
      // "Expense Data" button that opens the Approve modal in
      // expense-only mode: MM can toggle External Cost Applicable,
      // edit Service / Spares amounts, swap invoice photos, and Save.
      // Send Back / Approve & Close are hidden in that mode so the
      // ticket stays closed.
      if(t.status==='closed'&&_mttsCanApprove()){
        primaryAct+='<button onclick="'+stop+'_mttsTicketExpenseOpen(\''+idEsc+'\')" title="Edit external cost / invoice photos on this closed ticket" style="font-size:12px;padding:6px 10px;font-weight:700;background:#fff;border:1px solid #0891b2;color:#0e7490;border-radius:5px;cursor:pointer">💰 Expense Data</button>';
      }
      // Super Admin can delete any ticket (along with its history) at
      // any status. Don't double-add when the open-ticket branch above
      // already showed the delete button.
      if(_mttsIsSA()&&!_mttsCanEditTicket(t)){
        sideAct+='<button class="mtts-tcard-iconbtn is-del" onclick="'+stop+'_mttsTicketDelete(\''+idEsc+'\')" title="Delete ticket and history (Super Admin)" aria-label="Delete ticket">🗑</button>';
      }
      // V1 (260520) — Share button (replaces Copy): renders the card as
      // a PNG and opens the OS share sheet via Web Share API so the
      // user can send it to WhatsApp / email / any installed app.
      // Falls back to clipboard copy where Web Share with files is
      // unsupported (typical on desktop browsers). V3 swaps the emoji
      // for the standard iOS-style share glyph for cross-platform
      // recognition. Always visible on every card.
      sideAct+='<button class="mtts-tcard-iconbtn mtts-tcard-screencap" onclick="'+stop+'_mttsTicketShareCardImage(this,\''+idEsc+'\')" title="Share card as image" aria-label="Share card as image" style="border-color:#a5b4fc;color:#4338ca;background:#eef2ff">'+_MTTS_SHARE_ICON_SVG+'</button>';
      var hasActions=!!(primaryAct||sideAct);
      // Build the card itself. Header line carries id + plant pill + asset
      // name (the three identifiers in reading order); priority chip is
      // pinned to the top-right corner. Status badge sits in the meta row.
      var idDisp=String(t.id||'');
      // Approved (closed) tickets get a thick green border so they
      // visually stand apart from in-flight cards at a glance.
      var approvedBorder=(t.status==='closed')?';border:3px solid #16a34a':'';
      // V28 — Ownership signal moved off a tag pill onto a corner-flag
      // (bottom-right triangle). The scope filter buttons use the same
      // colours so the link reads at a glance: "My Tickets" ↔ grey
      // (allotted), "Tickets by me" ↔ pink (raised). Both can apply —
      // a ticket allotted to you that you also raised gets the pink
      // flag on top (raised takes priority since it's the rarer signal).
      var meKey2=CU?(CU.name||CU.id):'';
      var isMineRaised=meKey2&&t.raisedBy===meKey2;
      var isMineAllotted=_mttsIsTechnicianOnTicket(t);
      var tagHtml='';
      var ownerFlagHtml='';
      if(isMineRaised){
        ownerFlagHtml='<span class="mtts-tcard-flag is-raised" title="Raised by me"></span>';
      } else if(isMineAllotted){
        ownerFlagHtml='<span class="mtts-tcard-flag is-allotted" title="Allotted to me"></span>';
      }
      // V38 — Restructured top row of the card. Left: big mono Ticket ID +
      // raiser name + timestamp below. Right: PRIORITY chip on top, status
      // pill below — both prominent in the top-right corner.
      var raisedDt=_mttsFmtISTDateTime(t.raisedAt);
      var critClr={High:'#dc2626',Medium:'#f59e0b',Low:'#16a34a'}[crit]||'#64748b';
      // Live HH:MM counter for "breakdown since" — ticks via
      // _mttsLiveTimerTick on the data-mtts-since hook. Terminal tickets
      // show a static dash.
      var breakdownSinceIso=t.breakdownSince||t.raisedAt||'';
      // V120/V18 — When the downtime is frozen (repair_done / closed /
      // scrapped) the chip is rendered without the data-mtts-since hook
      // so the 30-second live-tick leaves it alone. Frozen pill is
      // muted slate; active pill stays the red urgent style. The label
      // ("Breakdown Since" vs "Downtime") is now on hover only — see
      // .mtts-bd-chip rule in mtts.css.
      var _bdTip=(t.confirmedByRaiser||isTerminal)?'Downtime':'Breakdown Since';
      var bdsHtml;
      if(isTerminal && !downEnd){
        bdsHtml='<span style="color:var(--text3)">—</span>';
      } else if(downEnd){
        bdsHtml='<span class="mtts-bd-chip" data-mtts-tip="'+_bdTip+'" title="'+_bdTip+'" style="display:inline-flex;align-items:center;font-family:var(--mono);font-weight:900;font-size:18px;color:#0f172a;letter-spacing:.6px;background:#e2e8f0;border:1.5px solid #94a3b8;padding:2px 9px;border-radius:6px;line-height:1;position:relative">'+_mttsTimerHHMM(breakdownSinceIso, downEnd)+'</span>';
      } else {
        bdsHtml='<span class="mtts-bd-chip" data-mtts-since="'+breakdownSinceIso+'" data-mtts-tip="'+_bdTip+'" title="'+_bdTip+'" style="display:inline-flex;align-items:center;font-family:var(--mono);font-weight:900;font-size:18px;color:#dc2626;letter-spacing:.6px;background:#fef2f2;border:1.5px solid #fca5a5;padding:2px 9px;border-radius:6px;line-height:1;position:relative">'+_mttsTimerHHMM(breakdownSinceIso)+'</span>';
      }
      html+='<div class="mtts-tcard" style="--plant-color:'+plantColor+';background:'+cardBg+approvedBorder+';position:relative" onclick="_mttsTicketDetail(\''+idEsc+'\')" role="button" tabindex="0">'+
        ownerFlagHtml+
        '<div class="mtts-tcard-head" style="align-items:flex-start">'+
          '<div class="mtts-tcard-headline" style="flex:1;min-width:0">'+
            // V18 — Ticket ID + breakdown/downtime chip side-by-side on
            // the left; raiser + timestamp on the full-width row below
            // the head. The chip's label is shown on hover only.
            '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'+
              '<div style="font-family:var(--mono);font-size:22px;font-weight:900;color:#0f172a;letter-spacing:.4px;line-height:1.1">'+idDisp+'</div>'+
              bdsHtml+
            '</div>'+
          '</div>'+
          // Top-right cluster: Status pill + PRIORITY initial chip
          // (H / M / L) sit SIDE-BY-SIDE on one row.
          '<div style="display:flex;align-items:center;gap:5px;flex-shrink:0">'+
            _mttsStatusBadgeBig(t)+
            // V29 — High-priority pill flashes until the tech submits
            // repair_done (i.e. until the ticket leaves the pre-repair
            // pipeline). Other priorities render statically.
            (function(){
              var preRepair=(t.status!=='repair_done'&&t.status!=='closed'&&t.status!=='scrapped');
              var flashCls=(crit==='High'&&preRepair)?' mtts-prio-flash':'';
              return '<span class="mtts-prio-pill'+flashCls+'" title="'+crit+' priority" style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;font-size:14px;font-weight:900;background:'+critClr+';color:#fff;box-shadow:0 1px 3px rgba(0,0,0,.15);flex-shrink:0">'+(crit?String(crit).charAt(0).toUpperCase():'?')+'</span>';
            })()+
          '</div>'+
        '</div>'+
        // V17 — Raiser + timestamp on a full-width row below the head,
        // spanning across both the Ticket ID column AND the Status /
        // Priority cluster so longer names / ISO timestamps don't get
        // cramped.
        ((raiser||raisedDt)?'<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:12px;color:var(--text2);line-height:1.2">'+
          (raiser?'<span style="display:inline-flex;align-items:center;gap:5px"><span style="color:var(--text3);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.4px">By</span><span style="font-weight:700">'+raiser+'</span></span>':'')+
          (raisedDt?'<span style="font-family:var(--mono);color:var(--text3)">📅 '+raisedDt+'</span>':'')+
        '</div>':'')+
        // V38 — Plant short-form pill + asset name flow as one wrapping
        // sentence (display:inline so the asset name wraps naturally
        // alongside / under the pill instead of taking its own row).
        '<div style="margin-top:8px;line-height:1.25">'+
          _mttsPlantBadgeShort(t.plant)+
          ' '+
          // V41 — SA / MTTS Admin get a clickable asset name → opens
          // the asset-edit modal. Save / Cancel returns the user to the
          // tickets page automatically since the modal overlays it.
          (((typeof _mttsIsSA==='function'&&_mttsIsSA())||(typeof _mttsIsMttsAdmin==='function'&&_mttsIsMttsAdmin()))&&t.assetCode
            ? '<span onclick="event.stopPropagation();_mttsAssetOpen(\''+String(t.assetCode||'').replace(/\'/g,"\\\\\'")+'\')" title="Edit asset" style="font-size:15px;font-weight:800;color:var(--accent);text-decoration:underline;text-underline-offset:2px;cursor:pointer">'+assetName+'</span>'
            : '<span style="font-size:15px;font-weight:800;color:var(--text)">'+assetName+'</span>')+
        '</div>'+
        // V38 — Technician detail row. If allotted: show the Tech pill.
        // If not yet allotted (assignedTo empty): show a muted "Allocation
        // not done" chip so the gap is explicit.
        '<div style="margin-top:6px">'+
          ((Array.isArray(t.assignedTo)&&t.assignedTo.length)
            ? _mttsTechBadge(t)
            : '<span style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:10px;font-size:11px;font-weight:800;background:transparent;color:#64748b;border:1.5px solid #cbd5e1;letter-spacing:.3px;text-transform:uppercase">👥 Allocation not done</span>')+
        '</div>'+
        // V16 — Asset condition + symptoms still stack under the tech
        // detail; the Breakdown since / Downtime chip moved to the
        // bottom-right corner (sits next to the action buttons; floats
        // right when there are no actions).
        '<div class="mtts-tcard-rows" style="margin-top:6px">'+
          '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Asset Condition</span><span class="mtts-tcard-val">'+bdLabel+_mttsBdCategoryBadge(t)+'</span></div>'+
          '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Symptoms</span><span class="mtts-tcard-val" style="white-space:normal;text-align:left;line-height:1.3">'+(descShort||'<span style="color:var(--text3)">—</span>')+'</span></div>'+
        '</div>'+
        // V18 — Bottom strip: action buttons only. Breakdown / Downtime
        // chip moved beside the Ticket ID in the head (label-on-hover).
        (hasActions?'<div class="mtts-tcard-actions">'+
          '<div class="mtts-tcard-actions-left">'+primaryAct+'</div>'+
          (sideAct?'<div class="mtts-tcard-actions-right">'+sideAct+'</div>':'')+
        '</div>':'')+
      '</div>';
    });
    html+='</div>';
  }
  wrap.innerHTML=html;
  // V38 — kick the live-timer interval after the first render so HH:MM
  // elapsed timers and revoke-window countdowns auto-update without a
  // full card re-render. Idempotent.
  if(typeof _mttsStartLiveTimer==='function') _mttsStartLiveTimer();
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

// Table view for the Tickets page — wide-screen alternative to the
// card grid. Shows the most-scanned columns; click any row to open
// the detail overlay (same as a card click).
// V38 — "Plant-2" / "Plant 3" / "KAP-2" → "P2" / "P3" / "P2". Strips the
// non-digits and returns "P" + the trailing number. Falls back to the
// original code if no number is found (e.g., custom plant names that
// don't follow the convention).
function _mttsPlantShort(code){
  var lbl=_mttsPlantLabel(code)||code||'';
  var m=lbl.match(/(\d+)/);
  if(m) return 'P'+m[1];
  return lbl;
}
// V38 — Compact coloured plant pill: short form ("P2") on the plant's own
// master colour, white/dark text chosen by luminance for contrast. Reuses
// _mttsBgToFg so it stays in sync with how _mttsPlantBadge picks fg.
function _mttsPlantBadgeShort(code){
  var short=_mttsPlantShort(code);
  var bg=_mttsPlantColor(code);
  if(!bg) return '<span style="display:inline-block;padding:2px 9px;border-radius:8px;font-size:12px;font-weight:900;background:#0f172a;color:#fff;font-family:var(--mono);letter-spacing:.4px;white-space:nowrap">'+short+'</span>';
  var fg=(typeof _mttsBgToFg==='function')?_mttsBgToFg(bg):'#fff';
  return '<span style="display:inline-block;padding:2px 9px;border-radius:8px;font-size:12px;font-weight:900;background:'+bg+';color:'+fg+';font-family:var(--mono);letter-spacing:.4px;white-space:nowrap">'+short+'</span>';
}
function _mttsTicketTableHtml(rows){
  // V38 — Restructured columns per user spec:
  //   ID (prominent, no-wrap) · Asset (combined plant-short + asset-type +
  //   asset-name) · Breakdown · Status (badge with bg colour) · Down · Symptoms ·
  //   Raised · Tech · Tags (TR by me / My Allotted)
  // Status colour also tints the row background lightly so the lifecycle
  // stage reads at a glance even in dense table view.
  var statusClr={open:'#dc2626',assigned:'#1d4ed8',work_in_progress:'#a16207',awaiting_spares:'#c2410c',awaiting_agency:'#c2410c',repair_done:'#0891b2',repair_done_challenged:'#dc2626',closed:'#16a34a',scrapped:'#475569'};
  // Light row tint per status — matches the card-view colour map.
  var rowBg={open:'#fee2e2',assigned:'#dbeafe',work_in_progress:'#fef9c3',awaiting_spares:'#ffedd5',awaiting_agency:'#ffedd5',repair_done:'#dcfce7',repair_done_challenged:'#fee2e2',closed:'#bbf7d0',scrapped:'#fed7aa'};
  // V38 — Table THs are sticky to the page scroll. They sit just below the
  // filter row (which is sticky at top:118px). z-index 7 keeps THs below
  // the filter / summary / page-header sticky layers but above table body.
  // V38 — Table headers are sticky to the PAGE scroll. They join the
  // upper sticky panel: top:104px ≈ sticky-head wrapper (counter row +
  // filter row + 10px panel padding). z-index 7 keeps THs under the
  // filter bar (z:8) and over the table body. Background:#fff so the
  // panel feels continuous; shadow at the bottom signals the edge of
  // the frozen stack.
  var th='padding:9px 12px;font-size:12px;font-weight:800;background:#fff;border-bottom:2px solid var(--border);text-align:left;position:sticky;top:104px;z-index:7;box-shadow:0 2px 4px rgba(0,0,0,.06);white-space:nowrap';
  var td='padding:8px 12px;font-size:13px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var html='<div style="border:1.5px solid var(--border);border-radius:8px;background:#fff"><table style="width:100%;border-collapse:collapse"><thead><tr>'+
    '<th style="'+th+'">Ticket</th>'+
    '<th style="'+th+'">Asset</th>'+
    '<th style="'+th+'">Breakdown &amp; Symptoms</th>'+
    '<th style="'+th+'">Status &amp; Technician</th>'+
    '<th style="'+th+'">Down for</th>'+
    '<th style="'+th+'">Tags</th>'+
  '</tr></thead><tbody>';
  if(!rows.length){
    html+='<tr><td colspan="6" style="padding:30px 20px;text-align:center;color:var(--text3);font-size:13px">No tickets match the current filters.</td></tr>';
  }
  var meKey3=CU?(CU.name||CU.id):'';
  rows.forEach(function(t){
    var asset=byId(DB.mttsAssets||[],t.assetCode);
    var assetName=_mttsAssetLabel(asset,t.assetCode||'(missing)');
    var assetType=asset?asset.assetType:'';
    var plantShort=_mttsPlantShort(t.plant);
    var plantBadgeHtml=_mttsPlantBadgeShort(t.plant);
    var idEsc=String(t.id||'').replace(/'/g,"\\'");
    var raised=_mttsFmtISTDate(t.raisedAt);
    var raisedDt=_mttsFmtISTDateTime(t.raisedAt);
    var raiser=t.raisedBy?_mttsUserDisp(t.raisedBy):'';
    var bdLabel=_MTTS_BREAKDOWN_LABEL[t.breakdownType]||t.breakdownType||'—';
    var isTerminal=(t.status==='closed'||t.status==='scrapped');
    var downEnd=_mttsDowntimeEnd(t);
    var downFor=downEnd
      ? _mttsTimerSince(t.breakdownSince||t.raisedAt, downEnd)
      : (isTerminal?'—':_mttsTimerSince(t.breakdownSince||t.raisedAt));
    var techList=(t.assignedTo||[]).map(function(u){return _mttsUserDisp(u);}).join(', ')||'—';
    var raisedAct=(t.techActions||[]).find(function(a){return a&&a.action==='raised';});
    var descTxt=raisedAct?String(raisedAct.note||'').trim():'';
    var descShort=descTxt?(descTxt.length>80?descTxt.slice(0,80).replace(/</g,'&lt;')+'…':descTxt.replace(/</g,'&lt;')):'—';
    var stClr=statusClr[t.status]||'#64748b';
    var stLbl=(_MTTS_STATUS_LABEL||{})[t.status]||t.status;
    var rBg=rowBg[t.status]||'#fff';
    // Combined Asset cell: <plant-badge> · TYPE · Name. The plant pill uses
    // the plant's own colour (via _mttsPlantBadge) so each plant's tickets
    // are visually grouped at a glance.
    // V38 — Plant short-form pill + asset name only. Asset type chip dropped.
    var assetCell='<span style="margin-right:6px">'+plantBadgeHtml+'</span>'+
      '<span style="font-weight:800;color:var(--text)">'+assetName+'</span>';
    // V38 — Ticket cell: BIG mono ID on top, raiser name + IST timestamp
    // below it. Stacked so the ID is the dominant element in the row.
    var ticketCell='<div style="font-family:var(--mono);font-weight:900;font-size:18px;color:#0f172a;line-height:1.1;letter-spacing:.3px">'+(t.id||'')+'</div>'+
      (raiser?'<div style="font-size:11px;font-weight:700;color:var(--text2);margin-top:3px">'+raiser+'</div>':'')+
      '<div style="font-size:10px;font-family:var(--mono);color:var(--text3);margin-top:1px">'+raisedDt+'</div>';
    // V38 — Breakdown + Symptoms combined: bold type label + small category
    // pill (Electrical / Mechanical / Other), then the full (truncated)
    // symptoms text below it in a smaller muted style.
    var bdCell='<div style="font-weight:700;color:var(--text);white-space:nowrap">'+bdLabel+_mttsBdCategoryBadge(t)+'</div>'+
      (descShort&&descShort!=='—'?'<div style="font-size:11px;color:var(--text2);margin-top:3px;line-height:1.35;white-space:normal">'+descShort+'</div>':'');
    // V38 — Status + Technician combined: status pill on top, allocated
    // tech name(s) below it.
    var statusCell='<div><span style="display:inline-block;padding:3px 10px;border-radius:11px;font-size:11px;font-weight:900;background:'+stClr+';color:#fff;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.12)">'+stLbl+'</span>';
    if(t.status==='work_in_progress' && t.startedAt){
      statusCell+=' <span data-mtts-since="'+t.startedAt+'" style="font-family:var(--mono);font-size:11px;font-weight:900;color:'+stClr+';margin-left:2px">'+_mttsTimerHHMM(t.startedAt)+'</span>';
    }
    statusCell+='</div>';
    if(techList&&techList!=='—'){
      statusCell+='<div style="font-size:11px;font-weight:700;color:var(--text2);margin-top:4px;display:flex;align-items:center;gap:4px"><span style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.3px;font-weight:800">Tech</span>'+techList+'</div>';
    }
    var isMineRaised=meKey3&&t.raisedBy===meKey3;
    var isMineAllotted=_mttsIsTechnicianOnTicket(t);
    var tagCell='';
    // V38 — "TR by me" tag retired. Only "My Allotted" surfaces in the column.
    if(isMineAllotted) tagCell+='<span style="display:inline-block;font-size:9px;font-weight:800;background:#fef3c7;color:#92400e;border:1px solid #fcd34d;padding:1px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap">My Allotted</span>';
    if(!tagCell) tagCell='<span style="color:var(--text3)">—</span>';
    html+='<tr class="clickable-row" onclick="_mttsTicketDetail(\''+idEsc+'\')" style="cursor:pointer;background:'+rBg+'">'+
      '<td style="'+td+';white-space:nowrap">'+ticketCell+'</td>'+
      '<td style="'+td+'">'+assetCell+'</td>'+
      '<td style="'+td+';max-width:300px">'+bdCell+'</td>'+
      '<td style="'+td+'">'+statusCell+'</td>'+
      '<td style="'+td+';font-family:var(--mono);'+((isTerminal||downEnd)?'color:var(--text3)':'color:#dc2626;font-weight:700')+';white-space:nowrap">'+downFor+'</td>'+
      '<td style="'+td+'">'+tagCell+'</td>'+
    '</tr>';
  });
  html+='</tbody></table></div>';
  return html;
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
// Edit-mode marker for the Raise Ticket modal. null = new raise, ticket id =
// editing that ticket. Set by _mttsTicketEditOpen and read by Submit.
var _mttsRaiseEditId=null;

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
function _mttsRenderPhotoTiles(targetId,buf,removeFnName,fileInputId,maxSlots){
  var el=document.getElementById(targetId);if(!el) return;
  el.classList.add('mtts-photo-thumbs');
  var slots=[];
  var _max=(maxSlots>0)?maxSlots:3;
  for(var i=0;i<_max;i++){
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
  // V41 (260518) — Update Ticket limited to 2 photo tiles so the form
  // can sit beside the Notes textarea without overflowing.
  _mttsRenderPhotoTiles('mttsTechActPhotoPreview',_mttsTechActPhotosBuf,'_mttsTechActRemovePhoto','mttsTechActPhotos',2);
}
function _mttsTechActPickPhotos(ev){
  var files=Array.from(ev.target.files||[]);
  ev.target.value='';
  if(!files.length) return;
  _mttsCompressFiles(files,100).then(function(arr){
    arr.forEach(function(d){if(_mttsTechActPhotosBuf.length<2) _mttsTechActPhotosBuf.push(d);});
    if(_mttsTechActPhotosBuf.length>2) _mttsTechActPhotosBuf=_mttsTechActPhotosBuf.slice(0,2);
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

// Today in Indian Standard Time as YYYY-MM-DD — used to clamp date stepper
// to non-future. Always IST so picker bounds match how data is stored.
function _mttsTodayStr(){
  var d=_mttsNowIST();
  var pad=function(n){return n<10?'0'+n:''+n;};
  return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());
}

// V139 — Replaced the 15-min select with a freeform HH:MM text input.
// Defaults to the current minute; the user can type any time, and the
// arrow keys snap-then-step through 15-min boundaries. Clamped on blur
// to a valid HH:MM and never into the future for today's date.
function _mttsPopulateBdTimeOptions(){
  // Kept as a no-op so legacy call sites don't break.
}
function _mttsRaiseTimeChanged(){
  // Legacy hook — the text input uses on{Input,Blur,Keydown} instead.
}
// Arrow-key handler on the time input: ↑/↓ first snap to the nearest
// 15-min boundary, then step ±15. Other keys (digits, colon, backspace)
// behave normally so the user can still type any time manually.
function _mttsRaiseBdTimeKey(ev){
  if(ev.key!=='ArrowUp' && ev.key!=='ArrowDown') return;
  ev.preventDefault();
  _mttsRaiseBdTimeStep(ev.key==='ArrowUp'?1:-1);
}
// V141 — Stepper used by both the ▲/▼ buttons next to the time input
// AND the keyboard ↑/↓ keys. Direction: 1 = up, -1 = down.
// First click snaps the current time to the nearest 15-min boundary
// (up rounds to the NEXT 15-min slot, down rounds to the PREVIOUS one);
// subsequent clicks step ±15 minutes.
function _mttsRaiseBdTimeStep(dir){
  var el=document.getElementById('mttsRaiseBdTime');
  if(!el) return;
  var pad=function(n){return n<10?'0'+n:''+n;};
  var m=/^(\d{1,2}):(\d{1,2})$/.exec(String(el.value||''));
  var h, min;
  if(m){
    h=Math.max(0,Math.min(23,parseInt(m[1],10)));
    min=Math.max(0,Math.min(59,parseInt(m[2],10)));
  } else {
    var nowIst=(typeof _mttsNowIST==='function')?_mttsNowIST():new Date();
    h=nowIst.getUTCHours?nowIst.getUTCHours():nowIst.getHours();
    var rawMin=nowIst.getUTCMinutes?nowIst.getUTCMinutes():nowIst.getMinutes();
    min=Math.floor(rawMin/15)*15;
  }
  var total=h*60+min;
  var alignedDown=Math.floor(total/15)*15;
  if(dir>0){
    total=(total===alignedDown)?(total+15):(alignedDown+15);
  } else {
    total=(total===alignedDown)?(total-15):alignedDown;
  }
  if(total<0) total=0;
  if(total>=24*60) total=24*60-15;
  var nh=Math.floor(total/60), nm=total%60;
  el.value=pad(nh)+':'+pad(nm);
  _mttsRaiseBdTimeClampFuture();
  // Keep the text input focused so the user can keep pressing ▲/▼ /
  // arrows without losing context.
  try{el.focus();}catch(e){}
}
// Live typing: keep only digits + a single colon, auto-insert ":" after
// 2 digits if the user types raw numbers. Doesn't reject anything so
// the field stays responsive even mid-edit.
function _mttsRaiseBdTimeInput(){
  var el=document.getElementById('mttsRaiseBdTime');if(!el) return;
  var v=String(el.value||'').replace(/[^\d:]/g,'');
  // Collapse multiple colons to one (after the first hours block).
  var parts=v.split(':');
  if(parts.length>2) v=parts[0]+':'+parts.slice(1).join('').replace(/:/g,'');
  if(v.length===2 && v.indexOf(':')<0) v=v+':';
  if(v.length>5) v=v.slice(0,5);
  el.value=v;
}
// Blur normalisation: enforce HH:MM 00–23 / 00–59 and clamp future
// times back to "now" when the date is today. Empty / invalid resets
// to the current minute.
function _mttsRaiseBdTimeBlur(){
  var el=document.getElementById('mttsRaiseBdTime');if(!el) return;
  var pad=function(n){return n<10?'0'+n:''+n;};
  var m=/^(\d{1,2}):(\d{1,2})$/.exec(String(el.value||'').trim());
  if(!m){
    var now=(typeof _mttsNowIST==='function')?_mttsNowIST():new Date();
    var hh=now.getUTCHours?now.getUTCHours():now.getHours();
    var mm=now.getUTCMinutes?now.getUTCMinutes():now.getMinutes();
    el.value=pad(hh)+':'+pad(mm);
  } else {
    var h=Math.max(0,Math.min(23,parseInt(m[1],10)));
    var min=Math.max(0,Math.min(59,parseInt(m[2],10)));
    el.value=pad(h)+':'+pad(min);
  }
  _mttsRaiseBdTimeClampFuture();
}
function _mttsRaiseBdTimeClampFuture(){
  var el=document.getElementById('mttsRaiseBdTime');
  var dateEl=document.getElementById('mttsRaiseBdDate');
  if(!el||!dateEl||!el.value||!dateEl.value) return;
  if(typeof _mttsIstToISO!=='function') return;
  if(new Date(_mttsIstToISO(dateEl.value,el.value)).getTime()>Date.now()){
    var now=(typeof _mttsNowIST==='function')?_mttsNowIST():new Date();
    var pad=function(n){return n<10?'0'+n:''+n;};
    var hh=now.getUTCHours?now.getUTCHours():now.getHours();
    var mm=now.getUTCMinutes?now.getUTCMinutes():now.getMinutes();
    el.value=pad(hh)+':'+pad(mm);
  }
}

// Format a YYYY-MM-DD date string as dd-MMM-yy (e.g. 15-Jan-26) for the
// breakdown-since visible label. Empty / invalid input → '—'.
function _mttsFmtDdMmmYy(yyyymmdd){
  if(!yyyymmdd||!/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) return '—';
  var p=yyyymmdd.split('-');
  var months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var d=p[2],m=months[parseInt(p[1],10)-1]||'?',y=p[0].slice(2);
  return d+'-'+m+'-'+y;
}

// Update the dd-MMM-yy label after the user picks a date in the OS picker.
// Clamps any future date back to today, refreshes the time options so
// future slots stay disabled when the date is today.
function _mttsRaiseBdDateChanged(){
  var dateEl=document.getElementById('mttsRaiseBdDate');if(!dateEl) return;
  if(dateEl.value&&dateEl.value>_mttsTodayStr()) dateEl.value=_mttsTodayStr();
  var lbl=document.getElementById('mttsRaiseBdDateLabel');
  if(lbl) lbl.textContent=_mttsFmtDdMmmYy(dateEl.value);
  _mttsPopulateBdTimeOptions();
}

// Force-open the OS date picker when the user clicks the date button.
// In some browsers the transparent input doesn't auto-open the picker
// reliably; calling showPicker() (Chrome 99+) or focus() ensures it
// always opens on tap.
function _mttsRaiseBdDateOpenPicker(){
  var dateEl=document.getElementById('mttsRaiseBdDate');if(!dateEl) return;
  try{
    if(typeof dateEl.showPicker==='function'){dateEl.showPicker();return;}
  }catch(e){}
  dateEl.focus();
  try{dateEl.click();}catch(e){}
}

// Ticket id format: <yearDigit>T<seq>. Year digit = the last digit of the
// current year (2026 → "6"), so 2026's first ticket is "6T1", second "6T2",
// etc. The sequence resets automatically when the year rolls over because
// the prefix changes (Jan 1 2027 → "7T1"). Per-year scan of DB.mttsTickets
// finds the max seq for the current prefix and increments it. Existing
// legacy ids ("tabc12345") are ignored by the prefix filter.
//
// Concurrency caveat: two raisers clicking submit in the same instant
// could both compute the same next seq and produce a duplicate. For a
// single-team install this is acceptable; if it ever bites, move the
// counter to a Postgres sequence.
function _mttsNextTicketId(){
  var yearDigit=String(new Date().getFullYear()%10);
  var prefix=yearDigit+'T';
  var max=0;
  (DB.mttsTickets||[]).forEach(function(t){
    if(!t||!t.id) return;
    var s=String(t.id);
    if(s.indexOf(prefix)!==0) return;
    var n=parseInt(s.substring(prefix.length),10);
    if(!isNaN(n)&&n>max) max=n;
  });
  return prefix+(max+1);
}

// One-time / per-launch backfill: rename any ticket whose id doesn't match
// <yearDigit>T<seq> (e.g. legacy 'tabc12345') to the new format. Numbers
// are assigned in raisedAt-ascending order within each year, and the
// counter respects ids already in the new format so re-runs are
// idempotent and safe. Gated to SA / Manager because RLS will block
// updates from other roles.
async function _mttsBackfillTicketIds(){
  if(!_sb||!_sbReady){console.warn('[MTTS] backfill skip — supabase not ready');return;}
  if(!(_mttsIsSA()||_mttsIsManager())){console.log('[MTTS] backfill skip — only Super Admin / Manager can rename ticket ids');return;}
  var all=Array.isArray(DB.mttsTickets)?DB.mttsTickets:[];
  if(!all.length){console.log('[MTTS] backfill skip — no tickets in memory');return;}
  var legacy=all.filter(function(t){return t&&t.id&&!/^[0-9]T[0-9]+$/.test(String(t.id));});
  if(!legacy.length){console.log('[MTTS] backfill — all ticket ids already in new format');return;}
  // Seed per-year max from already-new-format ids so the seq picks up
  // where natural assignment left off.
  var maxByYear={};
  all.forEach(function(t){
    if(!t||!t.id) return;
    var m=/^([0-9])T([0-9]+)$/.exec(String(t.id));
    if(!m) return;
    var n=parseInt(m[2],10);
    if(!isNaN(n)&&(maxByYear[m[1]]==null||n>maxByYear[m[1]])) maxByYear[m[1]]=n;
  });
  // Walk legacy tickets in chronological order so seq numbering is monotonic.
  legacy.sort(function(a,b){return String(a.raisedAt||'').localeCompare(String(b.raisedAt||''));});
  var sbTbl=SB_TABLES.mttsTickets;
  if(!sbTbl){console.warn('[MTTS] backfill skip — no SB_TABLES.mttsTickets mapping');return;}
  console.log('[MTTS] backfill — '+legacy.length+' legacy ticket id(s) to rename →',legacy.map(function(t){return t.id;}));
  var renamed=0,failed=0,silent=0;
  for(var i=0;i<legacy.length;i++){
    var t=legacy[i];
    var year=new Date(t.raisedAt||Date.now()).getFullYear();
    if(isNaN(year)) year=new Date().getFullYear();
    var y=String(year%10);
    maxByYear[y]=(maxByYear[y]||0)+1;
    var newId=y+'T'+maxByYear[y];
    var oldId=t.id;
    try{
      // The user-visible ticket id (t.id in JS) lives in the `code` text
      // column; the DB's `id` is a real UUID. Update `code`, not `id`.
      // .select() lets us detect RLS no-ops (UPDATE returns 0 rows
      // without raising an error, which would otherwise look successful).
      var res=await _sb.from(sbTbl).update({code:newId}).eq('code',oldId).select();
      if(res.error){
        console.warn('[MTTS] backfill FAILED',oldId,'→',newId,res.error.message||res.error);
        maxByYear[y]--;failed++;continue;
      }
      if(!res.data||!res.data.length){
        console.warn('[MTTS] backfill SILENT (0 rows updated — RLS?)',oldId,'→',newId);
        maxByYear[y]--;silent++;continue;
      }
      t.id=newId;
      renamed++;
      console.log('[MTTS] backfilled',oldId,'→',newId);
    }catch(e){
      console.warn('[MTTS] backfill EXCEPTION',oldId,'→',newId,e.message||e);
      maxByYear[y]--;failed++;
    }
  }
  console.log('[MTTS] backfill done — '+renamed+' renamed, '+failed+' failed, '+silent+' silent (RLS)');
  if(renamed>0&&typeof _mttsRenderTickets==='function') _mttsRenderTickets();
}

function _mttsTicketRaiseOpen(editId){
  // editId === undefined / null → new raise. Otherwise edit that ticket.
  var editTicket=null;
  if(editId){
    editTicket=(DB.mttsTickets||[]).find(function(t){return t&&t.id===editId;});
    if(!editTicket){notify('Ticket not found',true);return;}
    if(!_mttsCanEditTicket(editTicket)){notify('You cannot edit this ticket',true);return;}
    // V38 — photosRaise is stripped at boot; pull it before the edit form
    // populates the photo buffer so saving doesn't wipe the existing raise
    // photos with an empty buffer.
    if(typeof _mttsLoadTicketPhotos==='function' && !_mttsLoadedTicketPhotos[editId]){
      _mttsLoadTicketPhotos(editId).then(function(){ _mttsTicketRaiseOpen(editId); });
    }
  } else {
    if(!_mttsCanRaise()){notify('You do not have permission to raise tickets',true);return;}
  }
  _mttsRaiseEditId=editId||null;
  // Modal title + submit-button text reflect mode.
  var titleEl=document.getElementById('mttsRaiseTitle');
  if(titleEl) titleEl.innerHTML=editTicket?'✏ Edit Ticket':'🎫 Raise New Ticket';
  var submitBtn=document.getElementById('mttsRaiseSubmitBtn');
  if(submitBtn) submitBtn.textContent=editTicket?'Save Changes':'Submit Ticket';
  _mttsRaisePhotosBuf=editTicket&&Array.isArray(editTicket.photosRaise)?editTicket.photosRaise.slice():[];
  _mttsRenderRaisePhotoTiles();
  // V38 — Default plant = user's HRMS active-period location, matched
  // leniently against the mtts_plants master by id, value, and label.
  // HRMS data is lazy-loaded (MTTS doesn't pull hrmsEmployees at boot);
  // when the fetch lands we re-render the chip row + summary so the
  // pick reflects the resolved plant. No diagnostic banner — if HRMS
  // doesn't resolve, the field stays empty and the user picks manually.
  var plantHidden=document.getElementById('mttsRaisePlant');
  plantHidden.value='';
  var allPlants=_mttsPlantList(true); // include inactive
  var diag='';
  if(!allPlants.length) diag='⚠ No plants in the master yet.';
  if(!Array.isArray(DB.hrmsEmployees)||!DB.hrmsEmployees.length){
    if(typeof _mttsEnsureHrmsLoaded==='function'){
      _mttsEnsureHrmsLoaded().then(function(){
        try{
          var _hrmsName2=(CU&&typeof _mttsUserPlantNameFromHrms==='function')?_mttsUserPlantNameFromHrms(CU):'';
          if(_hrmsName2){
            var _all2=_mttsPlantList(true);
            var _hit2=_all2.find(function(p){return p.value===_hrmsName2;})
              ||_all2.find(function(p){return String(p.value||'').toLowerCase()===_hrmsName2.toLowerCase();})
              ||_all2.find(function(p){return String(p.label||'').toLowerCase()===_hrmsName2.toLowerCase();});
            if(_hit2){
              var _ph2=document.getElementById('mttsRaisePlant');
              if(_ph2 && !_ph2.value){ _ph2.value=_hit2.value; }
              if(typeof _mttsRaiseRenderPlantBtns==='function') _mttsRaiseRenderPlantBtns();
              if(typeof _mttsRaiseRefreshPlantSummary==='function') _mttsRaiseRefreshPlantSummary();
              if(typeof _mttsRaiseRefreshAssets==='function') _mttsRaiseRefreshAssets();
            }
          }
        }catch(e){}
      });
    }
  }
  var hrmsPlantName=(CU&&typeof _mttsUserPlantNameFromHrms==='function')?_mttsUserPlantNameFromHrms(CU):'';
  if(allPlants.length && hrmsPlantName){
    var nLow=hrmsPlantName.toLowerCase();
    var hit=allPlants.find(function(p){return p.value===hrmsPlantName;})
      ||allPlants.find(function(p){return String(p.value||'').toLowerCase()===nLow;})
      ||allPlants.find(function(p){return String(p.label||'').toLowerCase()===nLow;});
    if(hit) plantHidden.value=hit.value;
  }
  _mttsRaiseRenderPlantBtns();
  // Render / hide the diagnostic banner under the plant chip row.
  var pBtnsWrap=document.getElementById('mttsRaisePlantBtns');
  if(pBtnsWrap){
    var existing=document.getElementById('mttsRaisePlantDiag');
    if(existing) existing.remove();
    if(diag){
      var d=document.createElement('div');
      d.id='mttsRaisePlantDiag';
      d.style.cssText='font-size:11px;color:#92400e;background:#fef3c7;border:1px solid #fde68a;padding:5px 8px;border-radius:6px;margin-top:6px';
      d.textContent=diag;
      pBtnsWrap.parentNode.insertBefore(d,pBtnsWrap.nextSibling);
    }
  }
  // Default Asset Type to "Machinery" — match exact code first, then by
  // any code/label that starts with "machin" so renamed seeds (MCH,
  // Machine, Machinery, etc.) still resolve.
  var typeHidden=document.getElementById('mttsRaiseType');
  typeHidden.value='';
  var typesArr=_mttsAssetTypeList(false);
  var mhit=typesArr.find(function(t){return t.value==='Machinery';})
        ||typesArr.find(function(t){
            return /^machin/i.test(String(t.value||''))||/^machin/i.test(String(t.label||''));
          });
  if(mhit) typeHidden.value=mhit.value;
  _mttsRaiseRenderTypeBtns();
  // Reset asset pick — defaulting plant doesn't pre-pick an asset.
  var assetHidden=document.getElementById('mttsRaiseAsset');
  if(assetHidden) assetHidden.value='';
  // Build (or clear) the asset chip row scoped to current plant + type.
  _mttsRaiseRefreshAssets();
  // Refresh the three collapsed summary buttons so they reflect defaults.
  _mttsRaiseRefreshPlantSummary();
  _mttsRaiseRefreshTypeSummary();
  _mttsRaiseRefreshAssetSummary();
  // Form opens with all three chip rows collapsed; user taps a summary to expand.
  var _pRow=document.getElementById('mttsRaisePlantBtns'); if(_pRow) _pRow.style.display='none';
  var _tRow=document.getElementById('mttsRaiseTypeBtns');  if(_tRow) _tRow.style.display='none';
  var _aRow=document.getElementById('mttsRaiseAssetBtns'); if(_aRow) _aRow.style.display='none';
  // Default breakdown radio to "Stopped" — most common case for a fresh ticket.
  Array.prototype.forEach.call(document.querySelectorAll('input[name="mttsRaiseBreakdown"]'),function(r){r.checked=(r.value==='stopped');});
  // V38 — Breakdown Type defaults to "Don't Know" so the user can submit
  // a ticket fast without guessing electrical vs mechanical; they can
  // change it if they know better.
  Array.prototype.forEach.call(document.querySelectorAll('input[name="mttsRaiseBdCategory"]'),function(r){r.checked=(r.value==='unknown');});
  // Default Breakdown Since to current IST date and time, rounded down
  // to the nearest 15-minute multiple (matches the time-select's options).
  var _now=_mttsNowIST();
  _now.setUTCMinutes(Math.floor(_now.getUTCMinutes()/15)*15,0,0);
  var _pad=function(n){return n<10?'0'+n:''+n;};
  var _dStr=_now.getUTCFullYear()+'-'+_pad(_now.getUTCMonth()+1)+'-'+_pad(_now.getUTCDate());
  var _tStr=_pad(_now.getUTCHours())+':'+_pad(_now.getUTCMinutes());
  var _bdDate=document.getElementById('mttsRaiseBdDate');
  if(_bdDate){
    _bdDate.value=_dStr;
    _bdDate.max=_mttsTodayStr();
  }
  var _bdLbl=document.getElementById('mttsRaiseBdDateLabel');
  if(_bdLbl) _bdLbl.textContent=_mttsFmtDdMmmYy(_dStr);
  // V139 — Freeform HH:MM input. Default to the current minute; user
  // can type any time, or use arrow keys to snap-then-step in 15-min
  // increments. No select to populate any more.
  var _bdTime=document.getElementById('mttsRaiseBdTime');
  if(_bdTime) _bdTime.value=_tStr;
  document.getElementById('mttsRaiseDesc').value='';
  document.getElementById('mttsRaisePhotos').value='';
  // ── Edit mode overrides ───────────────────────────────────────────────
  // Pre-populate every control from the ticket so the user can change any
  // field. The 'raised' techAction holds the original description.
  if(editTicket){
    plantHidden.value=editTicket.plant||'';
    var editAsset=(DB.mttsAssets||[]).find(function(a){return a&&a.id===editTicket.assetCode;});
    typeHidden.value=editAsset?(editAsset.assetType||''):'';
    if(assetHidden) assetHidden.value=editTicket.assetCode||'';
    Array.prototype.forEach.call(document.querySelectorAll('input[name="mttsRaiseBreakdown"]'),function(r){r.checked=(r.value===editTicket.breakdownType);});
    if(editTicket.breakdownSince){
      try{
        var _bdIst=_mttsFmtIST(editTicket.breakdownSince);
        if(_bdIst){
          var ed=_bdIst.date;
          // V139 — Preserve the original minute (no 15-min rounding)
          // since the time field now accepts any HH:MM the user typed.
          var et=_bdIst.time;
          if(_bdDate) _bdDate.value=ed;
          if(_bdLbl) _bdLbl.textContent=_mttsFmtDdMmmYy(ed);
          if(_bdTime) _bdTime.value=et;
        }
      }catch(e){}
    }
    var raisedAct=(editTicket.techActions||[]).find(function(a){return a&&a.action==='raised';});
    document.getElementById('mttsRaiseDesc').value=raisedAct?(raisedAct.note||''):'';
    // V38 — Restore the saved Breakdown Type (electrical/mechanical/other).
    var _editCat=(raisedAct&&raisedAct.bdCategory)||'';
    Array.prototype.forEach.call(document.querySelectorAll('input[name="mttsRaiseBdCategory"]'),function(r){r.checked=(r.value===_editCat);});
    // Re-render plant + type chip rows / summaries to reflect overrides.
    _mttsRaiseRenderPlantBtns();
    _mttsRaiseRenderTypeBtns();
    _mttsRaiseRefreshAssets();
    _mttsRaiseRefreshPlantSummary();
    _mttsRaiseRefreshTypeSummary();
    _mttsRaiseRefreshAssetSummary();
  }
  var err=document.getElementById('mttsRaiseErr');if(err){err.style.display='none';err.textContent='';}
  // V46 — Close any open Plant / Type / Asset pick-row dropdown on
  // outside click. Bound once and reused across modal opens.
  if(typeof _mttsRaiseBindOutsideClick==='function') _mttsRaiseBindOutsideClick();
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
// Pick black or white text by luminance so the plant code stays readable
// on whatever colour is set in the master.
function _mttsBgToFg(bg){
  var hex=String(bg||'').replace('#','').trim();
  if(!/^[0-9a-f]{6}$/i.test(hex)) return 'var(--text2)';
  var r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
  var lum=0.299*r+0.587*g+0.114*b;
  return lum<150?'#fff':'#1a2033';
}

function _mttsRaiseRenderPlantBtns(){
  var wrap=document.getElementById('mttsRaisePlantBtns');if(!wrap) return;
  var hidden=document.getElementById('mttsRaisePlant');
  var current=hidden?hidden.value:'';
  var plants=_mttsPlantList(false).slice().sort(function(a,b){
    return String(a.label||'').localeCompare(String(b.label||''),undefined,{numeric:true,sensitivity:'base'});
  });
  if(!plants.length){
    wrap.innerHTML='<div style="font-size:11px;color:var(--text3);font-style:italic;padding:4px 0">No plants — add one in Plant Master first</div>';
    return;
  }
  wrap.innerHTML='<div class="mtts-raise-asset-list">'+plants.map(function(p){
    var idEsc=String(p.value).replace(/'/g,"\\'").replace(/"/g,'&quot;');
    var lblEsc=String(p.label).replace(/</g,'&lt;');
    var sel=p.value===current;
    var swatch=p.color?'<span class="mtts-chip-swatch" style="display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid rgba(0,0,0,.1);background:'+p.color+'"></span>':'';
    // onclick fires on every row click — including re-clicking the
    // already-selected radio — which guarantees the list collapses on any
    // tap. (onchange only fires when the value actually changes.)
    return '<label class="mtts-raise-asset-row'+(sel?' is-selected':'')+'" title="'+lblEsc+'" onclick="_mttsRaisePickPlant(\''+idEsc+'\')">'+
      '<input type="radio" name="mttsRaisePlantRadio" value="'+idEsc+'"'+(sel?' checked':'')+'>'+
      swatch+
      '<span>'+lblEsc+'</span>'+
    '</label>';
  }).join('')+'</div>';
}

// Refresh the collapsed summary button for the plant pick. Empty state
// shows "Select Plant" in placeholder style; selected state shows the
// plant's name with its master colour as background.
function _mttsRaiseRefreshPlantSummary(){
  var btn=document.getElementById('mttsRaisePlantSummary');if(!btn) return;
  var hidden=document.getElementById('mttsRaisePlant');
  var code=hidden?hidden.value:'';
  if(!code){
    btn.classList.add('is-empty');
    btn.removeAttribute('style');
    btn.innerHTML='Select Plant';
    return;
  }
  btn.classList.remove('is-empty');
  var label=_mttsPlantLabel(code);
  var bg=_mttsPlantColor(code);
  if(bg){
    var fg=_mttsBgToFg(bg);
    btn.setAttribute('style','background:'+bg+';color:'+fg+';border-color:'+bg);
  } else {
    btn.removeAttribute('style');
  }
  // V38 — Plain selected label, no "Selected Plant" prefix or separator.
  btn.innerHTML='<span class="mtts-pick-value">'+String(label).replace(/</g,'&lt;')+'</span>';
}

// V38 — Close the other two pick dropdowns before opening this one so only
// one listbox is ever expanded at a time.
function _mttsRaiseCloseOtherPickRows(keepId){
  ['mttsRaisePlantBtns','mttsRaiseTypeBtns','mttsRaiseAssetBtns'].forEach(function(id){
    if(id===keepId) return;
    var el=document.getElementById(id);
    if(el) el.style.display='none';
  });
}
// V46 — Close every pick-row dropdown (Plant / Type / Asset). Used by
// the outside-click handler. Selections are stored in hidden inputs
// and the chip rows are just visibility — closing has no effect on
// the prior choice.
function _mttsRaiseCloseAllPickRows(){
  ['mttsRaisePlantBtns','mttsRaiseTypeBtns','mttsRaiseAssetBtns'].forEach(function(id){
    var el=document.getElementById(id);
    if(el) el.style.display='none';
  });
}
// V46 — Document-level click listener: if any pick row is open and the
// click lands outside the surrounding .mtts-raise-pickblock (which
// wraps both the trigger button and the chip-row dropdown), close it.
// Bound once on the first raise-modal open; uses capture phase so a
// child click can still .stopPropagation() if it ever needs to.
var _mttsRaiseOutsideBound=false;
function _mttsRaiseBindOutsideClick(){
  if(_mttsRaiseOutsideBound) return;
  _mttsRaiseOutsideBound=true;
  document.addEventListener('click',function(ev){
    var openIds=['mttsRaisePlantBtns','mttsRaiseTypeBtns','mttsRaiseAssetBtns'].filter(function(id){
      var el=document.getElementById(id);
      return el && el.style.display!=='none';
    });
    if(!openIds.length) return;
    var node=ev.target;
    while(node && node!==document.body){
      if(node.classList && node.classList.contains('mtts-raise-pickblock')) return;
      node=node.parentElement;
    }
    _mttsRaiseCloseAllPickRows();
  },true);
}
function _mttsRaiseTogglePlantBtns(){
  var row=document.getElementById('mttsRaisePlantBtns');if(!row) return;
  var willOpen=(row.style.display==='none');
  if(willOpen) _mttsRaiseCloseOtherPickRows('mttsRaisePlantBtns');
  row.style.display=willOpen?'flex':'none';
}

function _mttsRaisePickPlant(code){
  var hidden=document.getElementById('mttsRaisePlant');
  if(hidden) hidden.value=code;
  _mttsRaiseRenderPlantBtns();
  _mttsRaiseRefreshPlantSummary();
  // Plant change invalidates any prior asset pick — asset list is plant-scoped.
  var aHidden=document.getElementById('mttsRaiseAsset');
  if(aHidden) aHidden.value='';
  // Collapse the chip row after pick so the form stays compact.
  var row=document.getElementById('mttsRaisePlantBtns');
  if(row) row.style.display='none';
  _mttsRaiseRefreshAssets();
  if(typeof _mttsRaiseRefreshAssetSummary==='function') _mttsRaiseRefreshAssetSummary();
}

// Render the Asset Type chip row. "All" comes first (clears type filter).
// Pick an emoji for a given asset-type name. Substring match so renamed
// types (e.g. "Building & Shed", "IT Equipment") still resolve. Falls
// back to a generic icon if nothing matches.
function _mttsAssetTypeIcon(name){
  var n=String(name||'').toLowerCase();
  if(/machin|cnc|mcn|mch/.test(n)) return '⚙️';
  if(/build|shed|bld|civil/.test(n)) return '🏭';
  if(/furniture|chair|table|frn/.test(n)) return '🪑';
  if(/\bit\b|computer|laptop|server|itd/.test(n)) return '💻';
  if(/electric|panel|wiring|eld/.test(n)) return '💡';
  if(/tool|hand|spanner|drill|\bht\b/.test(n)) return '🔧';
  if(/vehic|car|truck|forklift/.test(n)) return '🚚';
  if(/pump|motor|compress/.test(n)) return '🔄';
  if(/safety|fire|extinguish/.test(n)) return '🧯';
  return '🏷';
}

// Sentinel value for the "All" row in the asset-type radio list. Stored
// in the hidden input when the user explicitly picks All so the summary
// can distinguish "user picked All" from "user hasn't picked anything".
// _mttsRaiseRefreshAssets treats __ALL__ the same as empty (no filter).
var _MTTS_TYPE_ALL='__ALL__';
function _mttsRaiseRenderTypeBtns(){
  var wrap=document.getElementById('mttsRaiseTypeBtns');if(!wrap) return;
  var hidden=document.getElementById('mttsRaiseType');
  var current=hidden?hidden.value:'';
  var typesArr=_mttsAssetTypeList(false).slice().sort(function(a,b){
    return String(a.label||'').localeCompare(String(b.label||''),undefined,{numeric:true,sensitivity:'base'});
  });
  var allSel=current===_MTTS_TYPE_ALL;
  var html='<div class="mtts-raise-asset-list">'+
    '<label class="mtts-raise-asset-row'+(allSel?' is-selected':'')+'" onclick="_mttsRaisePickType(\''+_MTTS_TYPE_ALL+'\')">'+
      '<input type="radio" name="mttsRaiseTypeRadio" value="'+_MTTS_TYPE_ALL+'"'+(allSel?' checked':'')+'>'+
      '<span class="mtts-chip-icon">📋</span><span>All</span>'+
    '</label>';
  html+=typesArr.map(function(t){
    var idEsc=String(t.value).replace(/'/g,"\\'").replace(/"/g,'&quot;');
    var lblEsc=String(t.label).replace(/</g,'&lt;');
    var icon=_mttsAssetTypeIcon(t.label);
    var sel=t.value===current;
    return '<label class="mtts-raise-asset-row'+(sel?' is-selected':'')+'" onclick="_mttsRaisePickType(\''+idEsc+'\')">'+
      '<input type="radio" name="mttsRaiseTypeRadio" value="'+idEsc+'"'+(sel?' checked':'')+'>'+
      '<span class="mtts-chip-icon">'+icon+'</span><span>'+lblEsc+'</span>'+
    '</label>';
  }).join('');
  html+='</div>';
  wrap.innerHTML=html;
}
function _mttsRaiseRefreshTypeSummary(){
  var btn=document.getElementById('mttsRaiseTypeSummary');if(!btn) return;
  var hidden=document.getElementById('mttsRaiseType');
  var code=hidden?hidden.value:'';
  if(!code){
    btn.classList.add('is-empty');
    btn.innerHTML='Select Asset Type';
    return;
  }
  btn.classList.remove('is-empty');
  // Sentinel "__ALL__" → show "Selected Asset Type: All" so the user
  // sees their explicit pick (vs. the placeholder when nothing chosen).
  // Icon nested inside the value span to keep the same prefix|value grid
  // layout the labelled types use (otherwise it breaks the two-column
  // split and the prefix lands in the wrong cell).
  // V38 — Plain selected label, no "Selected Asset Type" prefix or separator.
  if(code===_MTTS_TYPE_ALL){
    btn.innerHTML='<span class="mtts-pick-value"><span class="mtts-chip-icon">📋</span>All</span>';
    return;
  }
  var label=_mttsAssetTypeLabel(code);
  var icon=_mttsAssetTypeIcon(label);
  btn.innerHTML='<span class="mtts-pick-value"><span class="mtts-chip-icon">'+icon+'</span>'+String(label).replace(/</g,'&lt;')+'</span>';
}
function _mttsRaiseToggleTypeBtns(){
  var row=document.getElementById('mttsRaiseTypeBtns');if(!row) return;
  var willOpen=(row.style.display==='none');
  if(willOpen) _mttsRaiseCloseOtherPickRows('mttsRaiseTypeBtns');
  row.style.display=willOpen?'flex':'none';
}
function _mttsRaisePickType(code){
  var hidden=document.getElementById('mttsRaiseType');
  if(hidden) hidden.value=code;
  _mttsRaiseRenderTypeBtns();
  _mttsRaiseRefreshTypeSummary();
  // If the currently-picked asset doesn't match the new type filter, clear it.
  // __ALL__ sentinel = no filter, so any prior asset stays valid.
  var aHidden=document.getElementById('mttsRaiseAsset');
  if(aHidden&&aHidden.value&&code&&code!==_MTTS_TYPE_ALL){
    var a=(DB.mttsAssets||[]).find(function(x){return x&&x.id===aHidden.value;});
    if(!a||a.assetType!==code){aHidden.value='';}
  }
  // Collapse the chip row after pick.
  var row=document.getElementById('mttsRaiseTypeBtns');
  if(row) row.style.display='none';
  _mttsRaiseRefreshAssets();
  if(typeof _mttsRaiseRefreshAssetSummary==='function') _mttsRaiseRefreshAssetSummary();
}

// ── Asset edit modal — chip pickers for Plant / Asset Type / Priority ───
// V52 — Plant + Asset Type switched from chip buttons to combo boxes.
// The render functions now populate <select> options (preserving any
// current selection across re-renders triggered by master-list edits)
// and bind a one-shot change handler that fans out to the same pick
// helpers, so existing call sites (`_mttsAssetPickPlant`, asset-type
// → primary-name refresh) keep working unchanged.
function _mttsAssetRenderPlantBtns(){
  var sel=document.getElementById('mttsAssetPlant'); if(!sel) return;
  var current=sel.value;
  var plants=_mttsPlantList(true);
  if(!plants.length){
    sel.innerHTML='<option value="">— No plants — add one in Plant Master first —</option>';
    sel.value='';
    return;
  }
  var html='<option value="">— Select Plant —</option>';
  for(var i=0;i<plants.length;i++){
    var p=plants[i];
    var v=String(p.value||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    var lbl=String(p.label||p.value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
    var label=lbl===v?lbl:(v+' — '+lbl);
    html+='<option value="'+v+'">'+label+'</option>';
  }
  sel.innerHTML=html;
  if(current){
    var found=false;
    for(var j=0;j<sel.options.length;j++){ if(sel.options[j].value===current){found=true;break;} }
    sel.value=found?current:'';
  }
  if(!sel._mttsBound){
    sel._mttsBound=true;
    sel.addEventListener('change',function(){ _mttsAssetPickPlant(sel.value); });
  }
}
function _mttsAssetPickPlant(code){
  var sel=document.getElementById('mttsAssetPlant');
  if(sel && sel.value!==code) sel.value=code;
  // V9 (260518) — refresh the live preview when the plant changes.
  _mttsAssetUpdatePreview();
}

function _mttsAssetRenderTypeBtns(){
  var sel=document.getElementById('mttsAssetType'); if(!sel) return;
  var current=sel.value;
  var typesArr=_mttsAssetTypeList(true);
  if(!typesArr.length){
    sel.innerHTML='<option value="">— No asset types — add one in Asset Type Master first —</option>';
    sel.value='';
    return;
  }
  var html='<option value="">— Select Asset Type —</option>';
  for(var i=0;i<typesArr.length;i++){
    var t=typesArr[i];
    var v=String(t.value||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    var lbl=String(t.label||t.value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
    html+='<option value="'+v+'">'+lbl+'</option>';
  }
  sel.innerHTML=html;
  if(current){
    var found=false;
    for(var j=0;j<sel.options.length;j++){ if(sel.options[j].value===current){found=true;break;} }
    sel.value=found?current:'';
  }
  if(!sel._mttsBound){
    sel._mttsBound=true;
    sel.addEventListener('change',function(){ _mttsAssetPickType(sel.value); });
  }
}
function _mttsAssetPickType(code){
  var sel=document.getElementById('mttsAssetType');
  if(sel && sel.value!==code) sel.value=code;
  // Primary name list is type-scoped — refresh when type changes.
  _mttsPopulateAssetPrimaryNameOptions();
  // V9 (260518) — refresh the live preview (asset type changing may
  // empty the Primary Name pick, which the preview reflects).
  _mttsAssetUpdatePreview();
}

// V9 (260518) — Live preview of the composed asset name shown at the
// top of the Add/Edit Asset modal. Mirrors the composition logic in
// _mttsAssetSave so what the user sees here is exactly what gets
// stored: "<primary label> - <name extension>" (extension optional),
// preceded by the colored short-form plant badge.
// V25 (260518) — Now also drives the editable "Dashboard Asset Name"
// field. Field auto-fills from the composed name until the user
// manually edits it (touched flag), after which Primary / Extension
// changes leave the dashboard name alone. The dashboard chip
// abbreviation uses this name when present.
var _mttsAssetDashNameTouched=false;
function _mttsAssetDashNameTouch(){
  _mttsAssetDashNameTouched=true;
  // Re-render the preview footer so any other dependents pick up the
  // manually-typed name immediately.
  _mttsAssetUpdatePreview();
}
function _mttsAssetUpdatePreview(){
  var plantEl=document.getElementById('mttsAssetPlant');
  var primEl=document.getElementById('mttsAssetPrimary');
  var extEl=document.getElementById('mttsAssetNameExt');
  var dashEl=document.getElementById('mttsAssetDashName');
  var plantOut=document.getElementById('mttsAssetPreviewPlant');
  var nameOut=document.getElementById('mttsAssetPreviewName');
  if(!plantOut || !nameOut) return;
  var plantCode=plantEl?plantEl.value:'';
  plantOut.innerHTML=plantCode?_mttsPlantBadgeShort(plantCode):'';
  var primCode=primEl?primEl.value:'';
  var primLbl=primCode?(_mttsAssetPrimaryNameLabel(primCode)||primCode):'';
  var ext=extEl?String(extEl.value||'').trim():'';
  var composed=primLbl ? (ext?(primLbl+' - '+ext):primLbl) : '';
  // V26 (260518) — Default auto-fill is the **initials** form of the
  // composed name (e.g. "Air Conditioner - 02" → "AC 02"). User can
  // edit it freely; the touched flag stops further auto-overwrites.
  var initialsForm=composed?_mttsShortAssetLabel(composed):'';
  if(dashEl && !_mttsAssetDashNameTouched){
    dashEl.value=initialsForm;
  }
  // V29 (260518) — Preview shows the full composed name (Primary +
  // Extension) followed by the Dashboard Asset Name in parentheses
  // whenever it differs from the composed name. The plant chip already
  // sits next to this label, so the full line reads:
  // [P1] Air Conditioner - 02 (AC 02)
  var dashName=dashEl?String(dashEl.value||'').trim():'';
  var shown=composed||initialsForm||'';
  if(dashName && dashName!==composed) shown = (shown ? (shown+' ') : '') + '('+dashName+')';
  nameOut.textContent=shown;
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

// Render the Asset chip row scoped to the selected plant + (optional) type.
// Each chip sets the hidden #mttsRaiseAsset to the asset id and collapses
// the row. Empty/disabled states show inline guidance instead of chips.
// Search term for the Raise Ticket asset picker — kept at module scope so
// it survives the per-keystroke re-render of the radio list.
var _mttsRaiseAssetSearch='';
function _mttsRaiseRefreshAssets(){
  var plant=document.getElementById('mttsRaisePlant').value;
  var type=document.getElementById('mttsRaiseType').value;
  var wrap=document.getElementById('mttsRaiseAssetBtns');if(!wrap) return;
  var hidden=document.getElementById('mttsRaiseAsset');
  var current=hidden?hidden.value:'';
  // Capture the search box's value + caret position BEFORE re-render so
  // typing into it doesn't lose the cursor on every input event.
  var searchEl=document.getElementById('mttsRaiseAssetSearch');
  if(searchEl) _mttsRaiseAssetSearch=searchEl.value;
  var hadFocus=searchEl&&document.activeElement===searchEl;
  var caretStart=null,caretEnd=null;
  if(hadFocus){try{caretStart=searchEl.selectionStart;caretEnd=searchEl.selectionEnd;}catch(e){}}
  if(!plant){
    wrap.innerHTML='<div style="font-size:11px;color:var(--text3);font-style:italic;padding:4px 0">Select a plant first</div>';
    return;
  }
  var assets=(DB.mttsAssets||[]).filter(function(a){
    if(!a||a.status==='Scrap') return false;
    if(a.plant!==plant) return false;
    // Empty type or __ALL__ sentinel = no filter (show every asset type).
    if(type&&type!==_MTTS_TYPE_ALL&&a.assetType!==type) return false;
    return true;
  });
  // Free-text search filter — matches against the composed name +
  // make/model + serial. Case-insensitive, whitespace-trimmed.
  var srch=String(_mttsRaiseAssetSearch||'').toLowerCase().trim();
  if(srch){
    assets=assets.filter(function(a){
      var hay=((a.name||'')+' '+(_mttsAssetComposedName(a)||'')+' '+(a.make||'')+' '+(a.model||'')+' '+(a.serialNo||'')).toLowerCase();
      return hay.indexOf(srch)>=0;
    });
  }
  assets.sort(function(a,b){
    // Natural, case-insensitive sort by asset name so "Press 2" comes
    // before "Press 10" and casing doesn't push entries to the bottom.
    return String(a.name||'').localeCompare(String(b.name||''),undefined,{numeric:true,sensitivity:'base'});
  });
  // Always show the search box first so the user can keep typing even
  // when a filter trims the list to zero matches.
  var srchVal=String(_mttsRaiseAssetSearch||'').replace(/"/g,'&quot;');
  var searchHtml='<input type="search" id="mttsRaiseAssetSearch" placeholder="🔍 Type to filter assets…" oninput="_mttsRaiseRefreshAssets()" value="'+srchVal+'" style="width:100%;font-size:13px;padding:7px 10px;border:1px solid var(--border2);border-radius:6px;margin-bottom:6px;background:#fff;color:var(--text);box-sizing:border-box">';
  if(!assets.length){
    wrap.innerHTML=searchHtml+'<div style="font-size:11px;color:var(--text3);font-style:italic;padding:4px 0">'+(srch?'No assets match the search.':'No assets at this plant')+'</div>';
  } else {
    // Radio-list layout (replaces chip buttons): one row per asset, sorted
    // alphabetically. Easier to scan than chips when the plant has many
    // assets, and the radio gives a clear single-select affordance.
    wrap.innerHTML=searchHtml+'<div class="mtts-raise-asset-list">'+assets.map(function(a){
      var idEsc=String(a.id).replace(/'/g,"\\'").replace(/"/g,'&quot;');
      var _mm=_mttsAssetMM(a);
      var lbl=String(_mttsAssetComposedName(a)+(_mm?' ('+_mm+')':'')+(a.serialNo?' · SN '+a.serialNo:'')).replace(/</g,'&lt;');
      var sel=a.id===current;
      return '<label class="mtts-raise-asset-row'+(sel?' is-selected':'')+'" title="'+lbl+'" onclick="_mttsRaisePickAsset(\''+idEsc+'\')">'+
        '<input type="radio" name="mttsRaiseAssetRadio" value="'+idEsc+'"'+(sel?' checked':'')+'>'+
        '<span>'+lbl+'</span>'+
      '</label>';
    }).join('')+'</div>';
  }
  // Restore focus + caret on the search input so the user keeps typing.
  if(hadFocus){
    var newSearchEl=document.getElementById('mttsRaiseAssetSearch');
    if(newSearchEl&&typeof newSearchEl.focus==='function'){
      newSearchEl.focus();
      if(caretStart!=null){try{newSearchEl.setSelectionRange(caretStart,caretEnd!=null?caretEnd:caretStart);}catch(e){}}
    }
  }
}
function _mttsRaiseRefreshAssetSummary(){
  var btn=document.getElementById('mttsRaiseAssetSummary');if(!btn) return;
  var hidden=document.getElementById('mttsRaiseAsset');
  var id=hidden?hidden.value:'';
  if(!id){
    btn.classList.add('is-empty');
    btn.innerHTML='Select Asset';
    return;
  }
  var a=(DB.mttsAssets||[]).find(function(x){return x&&x.id===id;});
  if(!a){
    btn.classList.add('is-empty');
    btn.innerHTML='Select Asset';
    return;
  }
  btn.classList.remove('is-empty');
  var _mm=_mttsAssetMM(a);
  var lbl=String(_mttsAssetComposedName(a)+(_mm?' ('+_mm+')':'')+(a.serialNo?' · SN '+a.serialNo:'')).replace(/</g,'&lt;');
  // V38 — Plain selected label, no "Selected Asset" prefix or separator.
  btn.innerHTML='<span class="mtts-pick-value">'+lbl+'</span>';
}
function _mttsRaiseToggleAssetBtns(){
  var row=document.getElementById('mttsRaiseAssetBtns');if(!row) return;
  var willOpen=(row.style.display==='none');
  if(willOpen) _mttsRaiseCloseOtherPickRows('mttsRaiseAssetBtns');
  row.style.display=willOpen?'flex':'none';
  if(willOpen){
    // V47 — Fresh open: clear the visible search input FIRST (so the
    // refresh doesn't re-read the stale DOM value back into state),
    // then clear the in-memory state, then re-render the full list.
    // _mttsRaiseRefreshAssets reads from the DOM input on entry, so
    // the order matters.
    var _s0=document.getElementById('mttsRaiseAssetSearch');
    if(_s0){ try{ _s0.value=''; }catch(e){} }
    _mttsRaiseAssetSearch='';
    _mttsRaiseRefreshAssets();
    setTimeout(function(){
      var s=document.getElementById('mttsRaiseAssetSearch');
      if(s){
        try{s.value='';}catch(e){}
        if(typeof s.focus==='function') s.focus();
      }
    },50);
  }
}
function _mttsRaisePickAsset(id){
  var hidden=document.getElementById('mttsRaiseAsset');
  if(hidden) hidden.value=id;
  // Reset the search filter so reopening starts fresh.
  _mttsRaiseAssetSearch='';
  _mttsRaiseRefreshAssets();
  _mttsRaiseRefreshAssetSummary();
  // Collapse the chip row after pick.
  var row=document.getElementById('mttsRaiseAssetBtns');
  if(row) row.style.display='none';
}
async function _mttsTicketRaiseSubmit(){
  var editId=_mttsRaiseEditId;
  var editTicket=editId?(DB.mttsTickets||[]).find(function(t){return t&&t.id===editId;}):null;
  if(editTicket){
    if(!_mttsCanEditTicket(editTicket)){notify('Access denied',true);return;}
  } else {
    if(!_mttsCanRaise()){notify('Access denied',true);return;}
  }
  var err=document.getElementById('mttsRaiseErr');
  var _showErr=function(m){
    if(!err) return;
    err.textContent=m;err.style.display='block';
    err.classList.remove('mtts-err-flash');void err.offsetWidth;
    err.classList.add('mtts-err-flash');
  };
  var plant=document.getElementById('mttsRaisePlant').value;
  var assetCode=document.getElementById('mttsRaiseAsset').value;
  var bdRadio=document.querySelector('input[name="mttsRaiseBreakdown"]:checked');
  var bd=bdRadio?bdRadio.value:'';
  // V38 — Breakdown Type (electrical / mechanical / other). Required.
  // Persisted inside the techActions "raised" entry so no DB schema change
  // is needed for the new field.
  var bdCatRadio=document.querySelector('input[name="mttsRaiseBdCategory"]:checked');
  var bdCategory=bdCatRadio?bdCatRadio.value:'';
  var bdDate=document.getElementById('mttsRaiseBdDate').value;
  // Time comes from a 30-min interval select, so it's already snapped.
  var _bdTimeEl=document.getElementById('mttsRaiseBdTime');
  var bdTime=_bdTimeEl?_bdTimeEl.value:'';
  var desc=document.getElementById('mttsRaiseDesc').value.trim();
  if(!plant){_showErr('Plant is required');_mttsFlashFieldErr('mttsRaisePlantSummary');return;}
  if(!assetCode){_showErr('Asset is required');_mttsFlashFieldErr('mttsRaiseAssetSummary');return;}
  if(!bd){_showErr('Current asset condition is required');_mttsFlashFieldErr('mttsRaiseBreakdownRadios');return;}
  if(!bdCategory){_showErr('Breakdown type is required');_mttsFlashFieldErr('mttsRaiseBdCategoryRadios');return;}
  if(!bdDate){_showErr('Breakdown Since date is required');_mttsFlashFieldErr('mttsRaiseBdDate');return;}
  if(!bdTime){_showErr('Breakdown Since time is required');_mttsFlashFieldErr('mttsRaiseBdTime');return;}
  if(!desc){_showErr('Description / Symptoms is required');_mttsFlashFieldErr('mttsRaiseDesc');return;}
  // V38 — At least one photo is mandatory so the technician has something
  // visual to work from before they arrive. Flashes the photo preview row
  // and the (label of the) hidden file input wrapper for clarity.
  if(!Array.isArray(_mttsRaisePhotosBuf)||_mttsRaisePhotosBuf.length<1){
    _showErr('Please attach at least one photo of the breakdown.');
    _mttsFlashFieldErr('mttsRaisePhotoPreview');
    return;
  }
  // V43/V45 — Block a second open ticket on an asset that already has
  // an active one. Edit-in-place is allowed (we exclude editTicket
  // from the dup scan). Alert lives in a centred popup dismissed by
  // the red Close button or Esc.
  var _activeDup=(DB.mttsTickets||[]).find(function(x){
    if(!x||x.assetCode!==assetCode) return false;
    if(editTicket && x.id===editTicket.id) return false;
    return x.status!=='closed' && x.status!=='scrapped';
  });
  if(_activeDup){
    _mttsOpenAlertPopup({
      title:'⚠ Cannot Raise Ticket',
      ticketId:_activeDup.id||'?',
      statusLabel:(_MTTS_STATUS_LABEL[_activeDup.status]||_activeDup.status),
      raiser:_activeDup.raisedBy?_mttsUserDisp(_activeDup.raisedBy):'—'
    });
    _mttsFlashFieldErr('mttsRaiseAssetSummary');
    return;
  }
  var bdSinceISO=_mttsIstToISO(bdDate,bdTime);
  if(new Date(bdSinceISO).getTime()>Date.now()){_showErr('Breakdown Since cannot be in the future');_mttsFlashFieldErr('mttsRaiseBdDate','mttsRaiseBdTime');return;}
  if(editTicket){
    // Refuse to edit once allocation has happened — keeps the audit trail
    // consistent with what techs were briefed on.
    if(editTicket.status!=='open'){_showErr('Ticket is already allocated — cannot edit');return;}
    var prevSnapshot={
      plant:editTicket.plant,assetCode:editTicket.assetCode,
      breakdownType:editTicket.breakdownType,breakdownSince:editTicket.breakdownSince,
      photosRaise:(editTicket.photosRaise||[]).slice()
    };
    editTicket.assetCode=assetCode;
    editTicket.assetId=_mttsResolveDbId(DB.mttsAssets,assetCode);
    editTicket.plant=plant;
    editTicket.plantId=_mttsResolveDbId(DB.mttsPlants,plant);
    editTicket.breakdownType=bd;
    editTicket.breakdownSince=bdSinceISO;
    editTicket.photosRaise=_mttsRaisePhotosBuf.slice();
    if(!Array.isArray(editTicket.techActions)) editTicket.techActions=[];
    var raisedIdx=editTicket.techActions.findIndex(function(a){return a&&a.action==='raised';});
    if(raisedIdx>=0){
      editTicket.techActions[raisedIdx].note=desc;
      editTicket.techActions[raisedIdx].bdCategory=bdCategory;
    } else {
      editTicket.techActions.unshift({action:'raised',by:editTicket.raisedBy||'',at:editTicket.raisedAt||new Date().toISOString(),note:desc,bdCategory:bdCategory});
    }
    editTicket.techActions.push({action:'edited',by:CU?(CU.name||CU.id||''):'',at:new Date().toISOString(),note:'Ticket edited before allocation'});
    var ok=await _dbSave('mttsTickets',editTicket);
    if(!ok){
      // Roll back in-memory edits if save failed.
      Object.assign(editTicket,prevSnapshot);
      _showErr('Save failed');return;
    }
    _mttsRaiseEditId=null;
    cm('mMttsRaise');
    notify('✏ Ticket updated');
    _mttsRenderTickets();
    return;
  }
  var ticket={
    id:_mttsNextTicketId(),
    assetCode:assetCode,
    assetId:_mttsResolveDbId(DB.mttsAssets,assetCode),
    plant:plant,
    plantId:_mttsResolveDbId(DB.mttsPlants,plant),
    breakdownType:bd,
    breakdownSince:bdSinceISO,
    status:'open',
    raisedBy:CU?(CU.name||CU.id||''):'',
    raisedAt:new Date().toISOString(),
    photosRaise:_mttsRaisePhotosBuf.slice(),
    assignedTo:[],assignedAt:'',assignedBy:'',
    techActions:[{action:'raised',by:CU?(CU.name||CU.id||''):'',at:new Date().toISOString(),note:desc||'',bdCategory:bdCategory}],
    closePhotos:[],rootCause:'',
    costService:0,costSpares:0,invoicePhotos:[],
    approvedBy:'',approvedAt:''
  };
  if(!DB.mttsTickets) DB.mttsTickets=[];
  DB.mttsTickets.push(ticket);
  var ok2=await _dbSave('mttsTickets',ticket);
  if(!ok2){
    DB.mttsTickets=DB.mttsTickets.filter(function(x){return x!==ticket;});
    _showErr('Save failed');return;
  }
  cm('mMttsRaise');
  notify('🎫 Ticket raised — awaiting allocation');
  // V137 — A just-raised ticket is hidden if the user is currently on a
  // bucket / scope / plant / search filter that doesn't include it. Reset
  // the filters that would suppress an Open ticket the user just created
  // so it appears at the top of the list right away. Scope flips to
  // "Tickets Raised by me" so the user lands directly on their own queue.
  _mttsTicketState.bucket='all';
  _mttsTicketState.scope=(typeof _mttsCanRaise==='function'&&_mttsCanRaise())?'raised':'all';
  _mttsTicketState.search='';
  // Clear the plant filter only if it would suppress this ticket.
  if(_mttsTicketState.plant && _mttsTicketState.plant!==ticket.plant){
    _mttsTicketState.plant='';
  }
  var _sEl=document.getElementById('mttsTicketSearch');   if(_sEl) _sEl.value='';
  var _pEl=document.getElementById('mttsTicketPlantFilter'); if(_pEl) _pEl.value=_mttsTicketState.plant||'';
  _mttsRenderTickets();
}

// Edit / delete are allowed only while the ticket is still 'open' (i.e. not
// yet allocated). Manager + Super Admin can act on any open ticket; the
// raiser can act on their own open tickets.
function _mttsCanEditTicket(t){
  if(!t||t.status!=='open') return false;
  if(_mttsIsSA()||_mttsIsManager()) return true;
  var meKey=CU?String(CU.name||CU.id||''):'';
  return !!meKey&&String(t.raisedBy||'')===meKey;
}
function _mttsTicketEditOpen(id){
  _mttsTicketRaiseOpen(id);
}

// V3 (260520) — Standard share glyph used on the card share button
// and the Confirm Update share button. V6 swaps the iOS box-with-
// up-arrow for the Material/Android share icon: three nodes arranged
// at the corners of a `<` (one left, two on the right) connected
// by two lines — the universally recognized Android share affordance.
var _MTTS_SHARE_ICON_SVG='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:middle"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

// V36 (260518) — Render a ticket card to a PNG so the user can send
// it to WhatsApp / email / any chat app. Uses html2canvas (lazy-
// loaded from CDN, same source HWMS uses for its PDF export).
// V1 (260520) — Card button now prefers the Web Share API
// (navigator.share with files) so mobile users get the native share
// sheet. Falls back to clipboard copy when Web Share with files
// isn't available (typical on desktop browsers), and finally to
// opening the PNG in a new tab.
var _mttsTicketCopyLibsLoaded=false;
async function _mttsLoadHtml2Canvas(){
  if(_mttsTicketCopyLibsLoaded && typeof html2canvas==='function') return true;
  if(typeof html2canvas==='function'){ _mttsTicketCopyLibsLoaded=true; return true; }
  try{
    await new Promise(function(res,rej){
      var s=document.createElement('script');
      s.src='https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload=res; s.onerror=rej; document.head.appendChild(s);
    });
    _mttsTicketCopyLibsLoaded=(typeof html2canvas==='function');
    return _mttsTicketCopyLibsLoaded;
  }catch(e){
    return false;
  }
}
async function _mttsTicketShareCardImage(btn, id){
  var t=(DB.mttsTickets||[]).find(function(x){return x&&x.id===id;});
  if(!t){ notify('Ticket not found',true); return; }
  var cardEl=btn && btn.closest('.mtts-tcard');
  if(!cardEl){ notify('Card not found',true); return; }
  // Visual feedback on the button while we work. V3 — preserve the
  // share-icon SVG by swapping innerHTML (not textContent).
  var origHtml=btn.innerHTML;
  btn.disabled=true; btn.innerHTML='⏳';
  try{
    var ok=await _mttsLoadHtml2Canvas();
    if(!ok){ notify('⚠ Screenshot library failed to load — check internet',true); return; }
    // Snapshot the card. scale:2 gives a crisp image for retina
    // screens + smaller share targets.
    var canvas=await html2canvas(cardEl,{
      backgroundColor:'#ffffff',
      scale:2,
      useCORS:true,
      logging:false
    });
    var blob=await new Promise(function(res){ canvas.toBlob(res,'image/png'); });
    if(!blob){ notify('⚠ Could not encode image',true); return; }
    var fname='ticket-'+String(t.id||'card').replace(/[^A-Za-z0-9_-]/g,'_')+'.png';
    var file=null;
    try{ file=new File([blob],fname,{type:'image/png'}); }catch(_){ file=null; }
    // Preferred path — Web Share API with files. Opens the OS share
    // sheet (WhatsApp / Gmail / Drive / etc.) on Android Chrome,
    // iOS Safari, and any desktop browser that advertises file
    // share support.
    if(file && navigator.share && navigator.canShare && navigator.canShare({files:[file]})){
      try{
        await navigator.share({files:[file],title:'Ticket '+(t.id||''),text:'Ticket '+(t.id||'')});
        notify('📤 Shared');
        return;
      }catch(e){
        // AbortError = user cancelled the share sheet — silent exit.
        if(e && (e.name==='AbortError' || /abort/i.test(String(e.message||'')))) return;
        // Anything else — fall through to clipboard fallback below.
        try{ console.warn('[mtts] share failed, falling back to clipboard',e); }catch(_){}
      }
    }
    // Fallback 1 — copy to clipboard so user can paste anywhere.
    if(navigator.clipboard && window.ClipboardItem){
      try{
        await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
        notify('📋 Sharing not supported here — copied to clipboard instead');
        return;
      }catch(e){ try{ console.warn('[mtts] clipboard fallback failed',e); }catch(_){} }
    }
    // Fallback 2 — open the PNG in a new tab so the user can save /
    // share manually.
    var url=URL.createObjectURL(blob);
    window.open(url,'_blank');
    notify('Sharing & clipboard unavailable — opened image in new tab',true);
  }catch(e){
    try{ console.warn('[mtts] share card failed',e); }catch(_){}
    notify('⚠ Share failed: '+(e && e.message ? e.message : 'unknown'),true);
  }finally{
    btn.disabled=false; btn.innerHTML=origHtml;
  }
}

async function _mttsTicketDelete(id){
  var t=(DB.mttsTickets||[]).find(function(x){return x&&x.id===id;});
  if(!t){notify('Ticket not found',true);return;}
  // Super Admin can delete any ticket at any status (including its
  // history). Other roles only delete tickets that pass the regular
  // can-edit gate (i.e. open tickets where they're the raiser/manager).
  var isSA=_mttsIsSA();
  if(!_mttsCanEditTicket(t)&&!isSA){notify('Access denied',true);return;}
  var hCount=(t.techActions||[]).length;
  var msg='Delete ticket "'+(t.id||'')+'"?\n\n';
  if(isSA&&!_mttsCanEditTicket(t)){
    msg+='All '+hCount+' history entr'+(hCount===1?'y':'ies')+' will also be deleted.\n\n';
  }
  msg+='This cannot be undone.';
  if(!confirm(msg)) return;
  var ok=await _dbDel('mttsTickets',t.id);
  if(!ok){notify('Delete failed',true);return;}
  DB.mttsTickets=(DB.mttsTickets||[]).filter(function(x){return x&&x.id!==t.id;});
  notify('🗑 Ticket deleted');
  _mttsRenderTickets();
}

// ── Allocate flow (manager) ────────────────────────────────────────────────
// Count the tickets currently assigned to a technician that are still in
// flight. Excludes 'open' (not yet allocated), 'closed' and 'scrapped'.
// 'repair_done' is included — work isn't sealed until the manager
// approves, and a technician's plate isn't actually clear yet.
function _mttsTechActiveTicketCount(techKey){
  if(!techKey) return 0;
  var n=0;
  (DB.mttsTickets||[]).forEach(function(t){
    if(!t||!Array.isArray(t.assignedTo)) return;
    if(t.status==='open'||t.status==='closed'||t.status==='scrapped') return;
    if(t.assignedTo.indexOf(techKey)>=0) n++;
  });
  return n;
}
// Resolve a user.plant value (which is a VMS location code like "l1") to
// the human-readable location name. Falls back to mtts_plants by id/name,
// and finally returns the raw code if nothing matches.
// V117+ — kept only for legacy callers; new code paths use the HRMS-based
// derivation below (see _mttsUserPlantNameFromHrms).
function _mttsResolveUserPlantName(code){
  if(!code) return '';
  var s=String(code).trim();
  if(Array.isArray(DB.locations)){
    var loc=DB.locations.find(function(l){return l&&l.id===s;});
    if(loc&&loc.name) return loc.name;
  }
  var p=(DB.mttsPlants||[]).find(function(x){return x&&(x.id===s||x.name===s);});
  if(p) return p.name||s;
  return s;
}

// ── V117+ HRMS-driven user plant resolution ──────────────────────────
// MTTS no longer reads user.plant from User Management — the user's
// plant is sourced from the matching hrms_employees row (active period
// location, with flat fallback). hrms_employees is lazy-loaded on first
// access (without the heavy photo column) and cached.
var _mttsHrmsLoading=false;
async function _mttsEnsureHrmsLoaded(){
  if(_mttsHrmsLoading) return;
  if(Array.isArray(DB.hrmsEmployees) && DB.hrmsEmployees.length) return;
  if(typeof _sb==='undefined'||!_sb) return;
  _mttsHrmsLoading=true;
  try{
    var res=await _sb.from('hrms_employees')
      .select('code,emp_code,name,first_name,last_name,location,periods,status,extra')
      .limit(10000);
    if(!res.error){
      DB.hrmsEmployees=(res.data||[]).map(function(r){return _fromRow('hrmsEmployees',r);}).filter(Boolean);
    }
  }catch(e){ console.warn('MTTS: HRMS lazy-load failed:',e.message); }
  finally{ _mttsHrmsLoading=false; }
}
// Loose user → HRMS emp resolver: empCode (== user.name) → fullName → user.id.
function _mttsResolveEmp(u){
  if(!u||!Array.isArray(DB.hrmsEmployees)) return null;
  var emps=DB.hrmsEmployees;
  var uname=String(u.name||'').trim().toUpperCase();
  if(uname){
    var byCode=emps.find(function(e){return e&&String(e.empCode||'').trim().toUpperCase()===uname;});
    if(byCode) return byCode;
  }
  var full=String(u.fullName||'').trim().toLowerCase();
  if(full){
    var byName=emps.find(function(e){
      var nm=String((e.firstName||'')+' '+(e.lastName||'')).trim().toLowerCase();
      if(nm===full) return true;
      return String(e.name||'').trim().toLowerCase()===full;
    });
    if(byName) return byName;
  }
  if(u.id){
    var byUid=emps.find(function(e){return e&&e.userId===u.id;});
    if(byUid) return byUid;
  }
  return null;
}
// Returns the user's plant NAME (e.g. "Plant 1") from HRMS, or '' if no
// match. Active-period location preferred, flat location fallback.
function _mttsUserPlantNameFromHrms(u){
  var e=_mttsResolveEmp(u); if(!e) return '';
  var ap=(e.periods||[]).find(function(p){return p&&!p.to&&(!p._wfStatus||p._wfStatus==='approved');});
  return String((ap&&ap.location)||e.location||'').trim();
}
// Toggle a technician button on the allocation modal. Flips the hidden
// checkbox + the visual selection class so the existing confirm handler
// (which reads .mtts-alloc-cb:checked) keeps working unchanged.
function _mttsAllocToggleTech(btnEl){
  if(!btnEl) return;
  var cb=btnEl.querySelector('input.mtts-alloc-cb');
  if(!cb) return;
  cb.checked=!cb.checked;
  btnEl.classList.toggle('is-selected',cb.checked);
}

function _mttsTicketAllocateOpen(id){
  if(!_mttsCanAllocate()){notify('Only Maintenance Manager can allocate',true);return;}
  var t=byId(DB.mttsTickets||[],id);if(!t){notify('Ticket not found',true);return;}
  document.getElementById('mttsAllocTicketId').value=id;
  // V117+ — kick off lazy HRMS load so technician plant chips populate.
  if(!Array.isArray(DB.hrmsEmployees)||!DB.hrmsEmployees.length){
    _mttsEnsureHrmsLoaded().then(function(){ try{ _mttsTicketAllocateOpen(id); }catch(e){} });
  }
  var asset=byId(DB.mttsAssets||[],t.assetCode);

  // Prominent ticket-info block on the allocate modal: id + plant pill on
  // the top line, asset name big, the raised description quoted below,
  // V1 (260518) — Replaced the bespoke .mtts-alloc-info panel with the
  // shared _mttsTicketSummaryHtml replica so the Allocate Technician
  // modal opens with the **exact** same card the user clicked. The
  // wrapper mirrors the list-card chrome (plant-colour stripe, status
  // tint, owner corner-flag) so the link reads as one continuous card.
  var _allocSummary=_mttsTicketSummaryHtml(t);
  var _allocPlantColor=_mttsPlantColor(t.plant)||'#94a3b8';
  var _allocBgMap={open:'#fee2e2',assigned:'#dbeafe',work_in_progress:'#fef9c3',awaiting_spares:'#ffedd5',awaiting_agency:'#ffedd5',repair_done:'#dcfce7',repair_done_challenged:'#fee2e2',closed:'#bbf7d0',scrapped:'#fed7aa'};
  var _allocCardBg=_allocBgMap[t.status]||'#fff';
  var _allocMeKey=CU?(CU.name||CU.id):'';
  var _allocIsMineRaised=_allocMeKey && t.raisedBy===_allocMeKey;
  var _allocIsMineAllotted=_mttsIsTechnicianOnTicket(t);
  var _allocOwnerFlag='';
  if(_allocIsMineRaised) _allocOwnerFlag='<span class="mtts-tcard-flag is-raised" title="Raised by me"></span>';
  else if(_allocIsMineAllotted) _allocOwnerFlag='<span class="mtts-tcard-flag is-allotted" title="Allotted to me"></span>';
  document.getElementById('mttsAllocTicketLbl').innerHTML=
    '<div class="mtts-tcard" style="--plant-color:'+_allocPlantColor+';background:'+_allocCardBg+';position:relative;cursor:default" onclick="event.stopPropagation()">'+
      _allocOwnerFlag+
      _allocSummary+
    '</div>';
  // Reassign mode = the ticket already has technicians on it. The
  // header flips to "Reassign Technician". 260519-V35 — pre-selection
  // restored: when opening Reassign, the currently-assigned techs are
  // shown as ticked so the manager can see who's already on the
  // ticket. They can untick to remove, tick others to add. Earlier
  // versions cleared the picks to force a fresh selection, but that
  // hid the existing assignment from the manager.
  var isReassignMode=!!(t.assignedTo&&t.assignedTo.length);
  var titleEl=document.getElementById('mttsAllocTitle');
  if(titleEl) titleEl.textContent=isReassignMode?'👥 Reassign Technician':'👥 Assign Technician(s)';
  // Tech picker: tap-target buttons rather than a tight checkbox list, with
  // each button surfacing the technician's current in-progress ticket
  // count so the manager can spread load. The hidden checkbox inside each
  // button keeps the existing confirm-handler (which reads
  // .mtts-alloc-cb:checked) working unchanged.
  var techs=_mttsTechnicians();
  var pre=(t.assignedTo||[]);
  var listEl=document.getElementById('mttsAllocTechList');
  if(!techs.length){
    listEl.innerHTML='<div style="padding:10px;font-size:11px;color:var(--text3)">No users with Technician role found. Assign the role to users first via the portal.</div>';
  } else {
    listEl.innerHTML='<div class="mtts-alloc-techgrid">'+techs.map(function(u){
      var key=u.name||u.id;
      var keyEsc=String(key).replace(/"/g,'&quot;');
      var isOn=pre.indexOf(key)>=0;
      var n=_mttsTechActiveTicketCount(key);
      var loadCls=n===0?'is-free':(n<=2?'is-busy':'is-overloaded');
      var loadTxt=n===0?'Free':(n+' active');
      // V117+ — derive each tech's plant from HRMS employee, not u.plant.
      var plantNm=_mttsUserPlantNameFromHrms(u);
      var meta=[(u.fullName&&u.fullName!==u.name)?u.fullName:'',plantNm].filter(Boolean).join(' · ');
      return '<button type="button" class="mtts-alloc-techbtn'+(isOn?' is-selected':'')+'" onclick="_mttsAllocToggleTech(this)" data-key="'+keyEsc+'">'+
        '<input type="checkbox" class="mtts-alloc-cb" value="'+keyEsc+'"'+(isOn?' checked':'')+' tabindex="-1" style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px">'+
        '<span class="mtts-alloc-name">'+(u.name||u.id)+'</span>'+
        (meta?'<span class="mtts-alloc-meta">'+meta+'</span>':'')+
        '<span class="mtts-alloc-load '+loadCls+'">'+loadTxt+'</span>'+
      '</button>';
    }).join('')+'</div>';
  }
  document.getElementById('mttsAllocNote').value='';
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
  // V126 — Saving with no technician selected is treated as "deallocate":
  // the modal closes, any earlier technician(s) are cleared, the ticket
  // returns to Open status, and the user gets a "Ticket not allocated"
  // toast. Eliminates the dead-end inline error path.
  if(!picked.length){
    var note0=(document.getElementById('mttsAllocNote').value||'').trim();
    var hadTechs=(Array.isArray(t.assignedTo)&&t.assignedTo.length>0);
    if(hadTechs){
      var bak0=Object.assign({},t);
      var prev0=(t.assignedTo||[]).slice();
      t.assignedTo=[];
      t.assignedAt=''; t.assignedBy='';
      t.status='open';
      t.confirmedByRaiser=false; t.confirmedAt=''; t.confirmedBy='';
      t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
      t.techActions.push({action:'revoked',by:CU?(CU.name||CU.id||''):'',at:new Date().toISOString(),note:note0,techs:prev0});
      var ok0=await _dbSave('mttsTickets',t);
      if(!ok0){Object.assign(t,bak0);_showErr('Save failed');return;}
    }
    cm('mMttsAllocate');
    notify('⚠ Ticket not allocated',true);
    _mttsRenderTickets();
    return;
  }
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
  } else if(!isReassign||t.status==='open'||t.status==='repair_done'||t.status==='repair_done_challenged'){
    // First-time allocation, re-allocation of an open ticket, sending a
    // Repair-done ticket back to the technician (Approve modal → Send
    // Back), or reassigning after a raiser challenge (V122) — all flow
    // back to `assigned` so the lifecycle restarts from Step 2.
    t.status='assigned';
    t.confirmedByRaiser=false;
    t.confirmedAt=''; t.confirmedBy='';
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
  var _istNow=isToday?_mttsNowIST():null;
  var nowMins=_istNow?(_istNow.getUTCHours()*60+_istNow.getUTCMinutes()):null;
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
  // Treat the picker date as IST when stepping by days so the result stays
  // a calendar-day shift in IST regardless of the viewer's timezone.
  var d=new Date(cur+'T00:00:00+05:30');
  d.setUTCDate(d.getUTCDate()+delta);
  var ist=new Date(d.getTime()+_MTTS_IST_OFFSET_MS);
  var pad=function(n){return n<10?'0'+n:''+n;};
  var nextStr=ist.getUTCFullYear()+'-'+pad(ist.getUTCMonth()+1)+'-'+pad(ist.getUTCDate());
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
  // Picker pair is IST; do the math in real UTC ms to compare with Date.now().
  var t=new Date(_mttsIstToISO(dateEl.value,sel.value)).getTime()+deltaMin*60000;
  if(t>Date.now()) return;
  var ist=new Date(t+_MTTS_IST_OFFSET_MS);
  var pad=function(n){return n<10?'0'+n:''+n;};
  var newDate=ist.getUTCFullYear()+'-'+pad(ist.getUTCMonth()+1)+'-'+pad(ist.getUTCDate());
  var newTime=pad(ist.getUTCHours())+':'+pad(ist.getUTCMinutes());
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
  var t=new Date(_mttsIstToISO(dateEl.value,sel.value)).getTime()+15*60000;
  btn.disabled=(t>Date.now());
}

function _mttsTechActTimeChanged(){
  var sel=document.getElementById('mttsTechActTime');
  var dateEl=document.getElementById('mttsTechActDate');
  if(!sel||!dateEl||!sel.value||!dateEl.value) return;
  if(new Date(_mttsIstToISO(dateEl.value,sel.value)).getTime()>Date.now()){
    var now=_mttsNowIST();
    now.setUTCMinutes(Math.floor(now.getUTCMinutes()/15)*15,0,0);
    var pad=function(n){return n<10?'0'+n:''+n;};
    sel.value=pad(now.getUTCHours())+':'+pad(now.getUTCMinutes());
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
    wrap.innerHTML='<div style="padding:8px 10px;font-size:11px;color:var(--text3);font-style:italic">No ticket history yet.</div>';
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
    var ts=_mttsFmtISTDateTime(a.at);
    var who=a.by?_mttsUserDisp(a.by):'—';
    var noteBlock=a.note?'<div style="color:var(--text2);font-size:11px;margin-top:2px">'+String(a.note).replace(/</g,'&lt;')+'</div>':'';
    var etaBlock=a.eta?'<div style="font-size:10px;color:#92400e;margin-top:1px">ETA: '+a.eta+'</div>':'';
    var photos=(a.photos&&a.photos.length)?'<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:3px">'+a.photos.map(function(src){return '<a href="'+src+'" target="_blank" onclick="event.stopPropagation()"><img src="'+src+'" style="width:36px;height:36px;object-fit:cover;border-radius:4px;border:1px solid var(--border)"></a>';}).join('')+'</div>':'';
    var edited=a.editedAt?' <span style="font-size:9px;color:var(--text3);font-style:italic">(edited '+_mttsFmtISTDate(a.editedAt)+')</span>':'';
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

// V130 — Pop the ticket history out of the Update Ticket modal as a
// separate overlay. Triggered by the "📜 History" button in the modal
// header. Renders into the same #mttsTechActHistory container (so the
// Edit-this-entry buttons still wire back into the form) and shows it
// inside a centered overlay.
// V37 — "📜 History" button on the Update Ticket modal now opens the
// same full ticket-detail overlay shown when a user taps a card on
// the tickets list, so the history view matches everywhere.
function _mttsTechActShowDetail(){
  var id=(document.getElementById('mttsTechActTicketId')||{}).value||'';
  if(!id){notify('Ticket not found',true);return;}
  if(typeof _mttsTicketDetail==='function') _mttsTicketDetail(id);
}
function _mttsTechActOpenHistory(){
  var id=(document.getElementById('mttsTechActTicketId')||{}).value||'';
  var t=id?byId(DB.mttsTickets||[],id):null;
  if(!t){notify('Ticket not found',true);return;}
  _mttsTechActCloseHistory();
  var editRaw=(document.getElementById('mttsTechActEditIdx')||{}).value;
  var editIdx=(editRaw==null||editRaw==='')?null:Number(editRaw);
  // Re-render the history list into the existing (hidden) container so any
  // ✎ Edit buttons keep their existing onclick wiring.
  _mttsRenderTechActHistory(t,editIdx);
  var src=document.getElementById('mttsTechActHistory');
  var ov=document.createElement('div');
  ov.id='mttsTechActHistoryOverlay';
  ov.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:100001;padding:16px';
  ov.onclick=function(e){if(e.target===ov) _mttsTechActCloseHistory();};
  var box=document.createElement('div');
  box.style.cssText='background:#fff;border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.32);width:min(700px,96vw);max-height:88vh;display:flex;flex-direction:column;border:1.5px solid #64748b';
  box.innerHTML=
    '<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1.5px solid #64748b;padding:12px 16px">'+
      '<div style="font-size:15px;font-weight:900;color:#0f172a">📜 Ticket History — '+(t.id||'')+'</div>'+
      '<button type="button" onclick="_mttsTechActCloseHistory()" aria-label="Close" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--text3);padding:0 4px;line-height:1">×</button>'+
    '</div>'+
    '<div id="mttsTechActHistoryHost" style="overflow:auto;padding:12px 14px;background:#f1f5f9"></div>';
  ov.appendChild(box);
  document.body.appendChild(ov);
  // Move the rendered history into the overlay host. Done with appendChild
  // to preserve event listeners attached by _mttsRenderTechActHistory.
  var host=ov.querySelector('#mttsTechActHistoryHost');
  if(src && host) host.appendChild(src);
}
function _mttsTechActCloseHistory(){
  var ov=document.getElementById('mttsTechActHistoryOverlay');
  if(!ov) return;
  // Put the history list back into its hidden wrap inside the form modal
  // so subsequent opens / submits can still find it.
  var wrap=document.getElementById('mttsTechActHistoryWrap');
  var host=ov.querySelector('#mttsTechActHistoryHost');
  if(wrap && host && host.firstChild) wrap.appendChild(host.firstChild);
  ov.parentNode.removeChild(ov);
}

// ── Technician action flow — supports both "add new update" and "edit
// existing update" modes. editIdx, when supplied, points at an existing
// techActions[] entry; the form pre-fills with that entry and submit
// patches it instead of appending.
function _mttsTicketActionOpen(id,editIdx){
  var t=byId(DB.mttsTickets||[],id);if(!t){notify('Ticket not found',true);return;}
  if(!(_mttsIsTechnicianOnTicket(t)||_mttsIsSA()||_mttsIsMttsAdmin()||_mttsIsManager())){notify('You are not assigned to this ticket',true);return;}
  // V38 — closePhotos is stripped at boot; if the tech submits repair_done
  // with new photos, the save concats new onto existing — we need the
  // existing array loaded first or it'd be replaced with just the new ones.
  if(typeof _mttsLoadTicketPhotos==='function' && !_mttsLoadedTicketPhotos[id]){
    _mttsLoadTicketPhotos(id);
  }
  document.getElementById('mttsTechActTicketId').value=id;
  document.getElementById('mttsTechActEditIdx').value=(editIdx==null?'':String(editIdx));
  var asset=byId(DB.mttsAssets||[],t.assetCode);

  var titleEl=document.querySelector('#mMttsTechAct .modal-title');
  if(titleEl) titleEl.textContent=(editIdx==null)?'🔧 Give Update about Ticket':'🔧 Edit Update';

  // V129 — Reuse the same summary block that renders on the tickets-list
  // card so the technician sees the ticket in its familiar layout (ID +
  // raiser/timestamp · Status + Priority · Plant pill + Asset · Tech ·
  // Asset Condition / Symptoms / Downtime) before composing an update.
  document.getElementById('mttsTechActTicketLbl').innerHTML=_mttsTicketSummaryHtml(t);
  // Kick the live-timer interval so the breakdown HH:MM chip ticks while
  // the modal is open (idempotent — already running on the tickets page).
  if(typeof _mttsStartLiveTimer==='function') _mttsStartLiveTimer();

  // V130 — History moved behind a "📜 History" button at the top of the
  // modal (rendered on demand inside a popup so the form stays compact).
  // The wrap stays in the DOM (hidden) so old call paths that look for
  // #mttsTechActHistory keep finding it.

  var existing=null;
  if(editIdx!=null) existing=(t.techActions||[])[editIdx]||null;

  // Status — when ADDING a new update no button is preselected (user
  // must explicitly pick). When EDITING, pre-fill from the entry.
  if(existing){
    _mttsTechActPickStatus(existing.action||'awaiting_spares');
  } else {
    _mttsTechActPickStatus('');
  }
  document.getElementById('mttsTechActRoot').value=existing?'':'';
  // V38 (260518) — Notes textarea re-added (was retired in V134). When
  // editing an existing entry we seed the textarea with its prior note
  // so the user can review / amend; for new updates the field starts
  // empty.
  var _noteEl=document.getElementById('mttsTechActNote');
  if(_noteEl) _noteEl.value=existing?(existing.note||''):'';

  // Date / time fields removed — every update now stamps the current
  // system clock at submit time (or preserves the original `at` when
  // editing an existing entry).
  _mttsTechActPhotosBuf=existing&&Array.isArray(existing.photos)?existing.photos.slice(0,2):[];
  _mttsRenderTechActPhotoTiles();
  document.getElementById('mttsTechActPhotos').value='';
  _mttsTechActRefreshFields();
  var err=document.getElementById('mttsTechActErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsTechAct'); else { document.getElementById('mMttsTechAct').classList.add('open'); }
  // Enter saves, Escape cancels — typing in the Notes textarea still
  // gets a literal newline. Listener is attached once per open and
  // tagged on the modal element so we can remove the prior copy.
  var modalTA=document.getElementById('mMttsTechAct');
  if(modalTA){
    if(modalTA._mttsKeyHandler) modalTA.removeEventListener('keydown',modalTA._mttsKeyHandler);
    modalTA._mttsKeyHandler=function(ev){
      if(modalTA.style.display==='none'||!modalTA.classList.contains('open')) return;
      if(ev.key==='Escape'){ev.preventDefault();cm('mMttsTechAct');return;}
      if(ev.key==='Enter'){
        var tag=ev.target&&ev.target.tagName;
        if(tag==='TEXTAREA') return;
        ev.preventDefault();_mttsTicketActionSubmit();
      }
    };
    modalTA.addEventListener('keydown',modalTA._mttsKeyHandler);
  }
}
// Status picker — single-select. Updates the hidden input the submit
// reads, syncs the .is-selected class on the four buttons, and lets
// _mttsTechActRefreshFields toggle the conditional Root-cause field
// based on the new selection.
function _mttsTechActPickStatus(st){
  var hidden=document.getElementById('mttsTechActStatus');
  if(hidden) hidden.value=st;
  var btns=document.querySelectorAll('#mttsTechActStatusBtns .mtts-status-btn');
  Array.prototype.forEach.call(btns,function(b){
    b.classList.toggle('is-selected',b.getAttribute('data-st')===st);
  });
  _mttsTechActRefreshFields();
}
function _mttsTechActRefreshFields(){
  var st=document.getElementById('mttsTechActStatus').value;
  var rootWrap=document.getElementById('mttsTechActRootWrap');
  // Photos are always available on the Update Ticket form (up to 3).
  // Required only when closing the ticket as repair_done.
  var showRoot=(st==='repair_done'||st==='scrapped');
  if(rootWrap) rootWrap.style.display=showRoot?'':'none';
  var photoLbl=document.getElementById('mttsTechActPhotoLbl');
  if(photoLbl) photoLbl.textContent=(st==='repair_done')?'Closure photos (max 2) *':'Photos (max 2)';
}
// V36 (260518) — Confirmation popup shown when the user clicks Save in
// the Update Ticket modal. Surfaces the ticket card replica + a
// summary of the new update, with a "Copy Screenshot" affordance for
// pasting into a chat / email and a "Post Update" button that actually
// persists the change via _mttsTicketActionSubmit.
function _mttsTicketActionConfirm(){
  var err=document.getElementById('mttsTechActErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var id=document.getElementById('mttsTechActTicketId').value;
  var t=byId(DB.mttsTickets||[],id);
  if(!t){ _showErr('Ticket not found'); return; }
  if(!(_mttsIsTechnicianOnTicket(t)||_mttsIsSA()||_mttsIsMttsAdmin()||_mttsIsManager())){
    _showErr('You are not assigned to this ticket'); return;
  }
  var newStatus=document.getElementById('mttsTechActStatus').value;
  if(!newStatus){ _showErr('Please select a status'); _mttsFlashFieldErr('mttsTechActStatusBtns'); return; }
  var root=document.getElementById('mttsTechActRoot').value.trim();
  var photoCount=(_mttsTechActPhotosBuf||[]).length;
  if(newStatus==='repair_done' && photoCount===0){
    _showErr('At least one closure photo is required for "Repair done"');
    return;
  }
  // V38 (260518) — Pick up the user's note so the confirmation popup
  // can echo it back before posting.
  var _noteElC=document.getElementById('mttsTechActNote');
  var noteVal=_noteElC?String(_noteElC.value||'').trim():'';
  // Build the popup.
  var statusLbl=(_MTTS_STATUS_LABEL && _MTTS_STATUS_LABEL[newStatus])||newStatus;
  var summaryCard=_mttsTicketSummaryHtml(t);
  var plantColor=_mttsPlantColor(t.plant)||'#94a3b8';
  var cardBgMap={open:'#fee2e2',assigned:'#dbeafe',work_in_progress:'#fef9c3',awaiting_spares:'#ffedd5',awaiting_agency:'#ffedd5',repair_done:'#dcfce7',repair_done_challenged:'#fee2e2',closed:'#bbf7d0',scrapped:'#fed7aa'};
  var cardBg=cardBgMap[t.status]||'#fff';
  // V43 (260518) — Photos rendered as a side-column (right) on the
  // confirmation popup so they sit beside the text (status, meta,
  // note, root) instead of below — Notes column on the left, Photos
  // column on the right, stacked vertically inside.
  var photoCol='';
  if(photoCount){
    photoCol='<div style="display:flex;flex-direction:column;gap:4px;flex:0 0 auto;align-self:flex-start">'+
      _mttsTechActPhotosBuf.slice(0,2).map(function(src){
        return '<img src="'+String(src).replace(/"/g,'&quot;')+'" style="width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid var(--border)">';
      }).join('')+
    '</div>';
  }
  var rootHtml=root?'<div style="margin-top:6px;font-size:12px;background:#fef3c7;border-left:3px solid #fbbf24;padding:6px 10px;border-radius:0 6px 6px 0"><b>Root cause:</b> '+root.replace(/</g,'&lt;')+'</div>':'';
  var noteHtml=noteVal?'<div style="margin-top:6px;font-size:13px;color:var(--text);line-height:1.4;white-space:pre-wrap;padding:6px 10px;background:#fff;border:1px solid var(--border);border-radius:6px"><b style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;display:block;margin-bottom:3px">Notes</b>'+noteVal.replace(/</g,'&lt;')+'</div>':'';
  var by=CU?(CU.name||CU.id||''):'';
  var ov=document.createElement('div');
  ov.id='mttsActionConfirmOverlay';
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;z-index:2147483646;padding:10px;overflow:auto';
  // V38 (260518) — Wrap the ticket card + update summary in a
  // dedicated `mttsActionConfirmContent` block so the screenshot copy
  // can target just the content (excluding the popup header and the
  // action buttons row).
  ov.innerHTML=
    '<div id="mttsActionConfirmBox" style="background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);width:min(720px,98vw);max-height:calc(100vh - 20px);overflow:auto;padding:14px 14px 12px;position:relative;display:flex;flex-direction:column;gap:10px">'+
      '<div style="display:flex;align-items:center;gap:10px">'+
        '<div style="font-size:13px;font-weight:900;color:var(--accent);text-transform:uppercase;letter-spacing:.5px;flex:1">📤 Confirm Update</div>'+
        '<button type="button" onclick="_mttsTicketActionConfirmClose()" aria-label="Close" title="Close" style="width:30px;height:30px;border:none;border-radius:50%;background:#dc2626;color:#fff;font-size:16px;font-weight:900;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;flex-shrink:0">✕</button>'+
      '</div>'+
      '<div id="mttsActionConfirmContent" style="display:flex;flex-direction:column;gap:10px;background:#fff;padding:4px">'+
        // Ticket card replica
        '<div class="mtts-tcard" style="--plant-color:'+plantColor+';background:'+cardBg+';position:relative;cursor:default;margin:0">'+
          summaryCard+
        '</div>'+
        // Update summary — two columns: text on the left, photos on
        // the right.
        '<div style="background:#f8fafc;border:1.5px solid #cbd5e1;border-radius:10px;padding:8px 12px">'+
          '<div style="font-size:10px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">This update</div>'+
          '<div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">'+
            '<div style="flex:1 1 220px;min-width:0">'+
              '<div style="font-size:14px;font-weight:800;color:var(--text)">'+statusLbl+'</div>'+
              '<div style="font-size:11px;color:var(--text3);margin-top:2px">by '+_mttsUserDisp(by)+' · '+_mttsFmtISTDateTime(new Date().toISOString())+(photoCount?(' · '+photoCount+' photo'+(photoCount>1?'s':'')):'')+'</div>'+
              noteHtml+
              rootHtml+
            '</div>'+
            photoCol+
          '</div>'+
        '</div>'+
      '</div>'+
      // Action row (excluded from screenshot)
      '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:2px">'+
        '<button type="button" onclick="_mttsTicketActionConfirmShare(this)" style="font-size:13px;padding:8px 14px;font-weight:800;background:#eef2ff;border:1.5px solid #a5b4fc;color:#4338ca;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:6px">'+_MTTS_SHARE_ICON_SVG+'<span>Share</span></button>'+
        '<button type="button" onclick="_mttsTicketActionConfirmClose()" style="font-size:13px;padding:8px 14px;font-weight:800;background:#fff;border:1.5px solid var(--border);color:var(--text);border-radius:6px;cursor:pointer">Cancel</button>'+
        '<button type="button" onclick="_mttsTicketActionConfirmPost(this)" style="font-size:13px;padding:8px 16px;font-weight:900;background:var(--accent);border:none;color:#fff;border-radius:6px;cursor:pointer">📤 Confirm Ticket Update</button>'+
      '</div>'+
    '</div>';
  ov.addEventListener('click',function(e){ if(e.target===ov) _mttsTicketActionConfirmClose(); });
  document.body.appendChild(ov);
  // Esc closes the confirmation popup (NOT the underlying Update modal).
  var escH=function(ev){ if(ev.key==='Escape'){ ev.preventDefault(); _mttsTicketActionConfirmClose(); document.removeEventListener('keydown',escH); } };
  ov._escH=escH;
  document.addEventListener('keydown',escH);
}
function _mttsTicketActionConfirmClose(){
  var ov=document.getElementById('mttsActionConfirmOverlay');
  if(!ov) return;
  if(ov._escH) try{ document.removeEventListener('keydown',ov._escH); }catch(_){}
  ov.remove();
}
async function _mttsTicketActionConfirmShare(btn){
  // V38 (260518) — Snapshot only the ticket card + update summary
  // (excludes the popup header and the Cancel / Post Update buttons
  // so the shared image is just the relevant content).
  // V3 (260520) — Share-first flow mirroring the card button:
  // navigator.share with files → clipboard copy → new-tab fallback.
  var box=document.getElementById('mttsActionConfirmContent');
  if(!box){ notify('Nothing to share',true); return; }
  var origHtml=btn.innerHTML;
  btn.disabled=true; btn.innerHTML='⏳';
  try{
    var ok=await _mttsLoadHtml2Canvas();
    if(!ok){ notify('⚠ Screenshot library failed to load — check internet',true); return; }
    var canvas=await html2canvas(box,{backgroundColor:'#ffffff',scale:2,useCORS:true,logging:false});
    var blob=await new Promise(function(res){ canvas.toBlob(res,'image/png'); });
    if(!blob){ notify('⚠ Could not encode image',true); return; }
    var ticketId=(document.getElementById('mttsTechActTicketId')||{}).value||'update';
    var fname='ticket-'+String(ticketId).replace(/[^A-Za-z0-9_-]/g,'_')+'-update.png';
    var file=null;
    try{ file=new File([blob],fname,{type:'image/png'}); }catch(_){ file=null; }
    if(file && navigator.share && navigator.canShare && navigator.canShare({files:[file]})){
      try{
        await navigator.share({files:[file],title:'Ticket '+ticketId+' update',text:'Ticket '+ticketId+' update'});
        notify('📤 Shared');
        return;
      }catch(e){
        if(e && (e.name==='AbortError' || /abort/i.test(String(e.message||'')))) return;
        try{ console.warn('[mtts] share failed, falling back to clipboard',e); }catch(_){}
      }
    }
    if(navigator.clipboard && window.ClipboardItem){
      try{
        await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
        notify('📋 Sharing not supported here — copied to clipboard instead');
        return;
      }catch(e){ try{ console.warn('[mtts] clipboard fallback failed',e); }catch(_){} }
    }
    var url=URL.createObjectURL(blob);
    window.open(url,'_blank');
    notify('Sharing & clipboard unavailable — opened image in new tab',true);
  }catch(e){
    try{ console.warn('[mtts] share confirm failed',e); }catch(_){}
    notify('⚠ Share failed: '+(e && e.message ? e.message : 'unknown'),true);
  }finally{
    btn.disabled=false; btn.innerHTML=origHtml;
  }
}
async function _mttsTicketActionConfirmPost(btn){
  btn.disabled=true; btn.textContent='⏳ Posting…';
  try{
    await _mttsTicketActionSubmit();
  } finally {
    btn.disabled=false; btn.textContent='📤 Confirm Ticket Update';
  }
  // _mttsTicketActionSubmit closes the Update Ticket modal on success.
  // Close the confirmation popup too.
  _mttsTicketActionConfirmClose();
}

async function _mttsTicketActionSubmit(){
  var err=document.getElementById('mttsTechActErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var id=document.getElementById('mttsTechActTicketId').value;
  var t=byId(DB.mttsTickets||[],id);if(!t){_showErr('Ticket not found');return;}
  if(!(_mttsIsTechnicianOnTicket(t)||_mttsIsSA()||_mttsIsMttsAdmin()||_mttsIsManager())){_showErr('You are not assigned to this ticket');return;}
  var newStatus=document.getElementById('mttsTechActStatus').value;
  if(!newStatus){_showErr('Please select a status');_mttsFlashFieldErr('mttsTechActStatusBtns');return;}
  // V38 (260518) — Notes textarea brought back. Read the user-typed
  // value; for new entries this is the fresh note, for edits it's
  // whatever the user kept or amended (prior value was pre-seeded in
  // _mttsTicketActionOpen, so untouched edits preserve audit trail).
  var _noteEl0=document.getElementById('mttsTechActNote');
  var note=_noteEl0?String(_noteEl0.value||'').trim():'';
  var root=document.getElementById('mttsTechActRoot').value.trim();
  var editIdxRaw=document.getElementById('mttsTechActEditIdx').value;
  var editIdx=editIdxRaw===''?null:parseInt(editIdxRaw,10);
  // Update timestamp comes from the system clock — when editing an
  // existing entry the original `at` is preserved unless missing.
  var origAt=(editIdx!=null&&editIdx>=0)?((t.techActions||[])[editIdx]||{}).at:null;
  var atIso=origAt||new Date().toISOString();
  if(newStatus==='repair_done'&&_mttsTechActPhotosBuf.length===0){_showErr('At least one closure photo is required for "Repair done"');return;}
  var bak=Object.assign({},t);
  t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
  var stepPhotos=_mttsTechActPhotosBuf.slice(0,2);
  var entry={
    action:newStatus,by:CU?(CU.name||CU.id||''):'',at:atIso,
    note:note,photos:stepPhotos
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
  // V38 — Reset the raiser-confirmation flags whenever the technician
  // re-opens the ticket past repair_done (e.g., goes back to awaiting_*
  // after a challenge). Keeps the Step-5 gate honest.
  if(newStatus!=='repair_done'){
    t.confirmedByRaiser=false;
    t.confirmedAt=''; t.confirmedBy='';
  }
  // The latest non-historical action sets the ticket's current status.
  // V26 — 'partial_done' is a paused-mid-WIP signal; the ticket should
  // STAY in work_in_progress until the tech taps Resume Work. The
  // partial_done techAction itself is the marker for the paused state
  // (see _mttsIsPartialPaused).
  var last=t.techActions[t.techActions.length-1]||entry;
  var _statusSkip={raised:1,allocated:1,reassigned:1,revoked:1,partial_done:1};
  if(last.action && !_statusSkip[last.action]){
    t.status=last.action;
  }
  if(newStatus==='partial_done' && t.status==='work_in_progress'){
    // explicit no-op — ensure status stays WIP
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

// ═══ V38 — STEP 3: Technician "Start Work" ═════════════════════════════════
// Transitions an `assigned` ticket → `work_in_progress`. The technician
// can't post any Step-4 status update until they've started work, so this
// captures a clean "I'm on it" timestamp on the timeline.
//
// Confirmation is shown via a small popup anchored to the clicked button
// (NOT browser confirm()) so the user sees the ticket details inline.
// Anchor element is taken from the click event when available; otherwise
// the popup centres on the viewport as a fallback.
function _mttsTicketStartWork(id, evtOrAnchor){
  var t=byId(DB.mttsTickets||[],id);
  if(!t){notify('Ticket not found',true);return;}
  if(!(_mttsIsTechnicianOnTicket(t)||_mttsIsSA()||_mttsIsMttsAdmin()||_mttsIsManager())){notify('You are not assigned to this ticket',true);return;}
  if(t.status!=='assigned'){notify('Start Work only available from "Technician Allocated".',true);return;}
  var asset=byId(DB.mttsAssets||[],t.assetCode);
  var assetLbl=_mttsAssetLabel(asset,t.assetCode||'');
  var bdLabel=_MTTS_BREAKDOWN_LABEL[t.breakdownType]||t.breakdownType||'—';
  // Resolve anchor: prefer the clicked button via event.currentTarget /
  // event.target / explicit element argument. Fall back to viewport-centre
  // when nothing usable was passed.
  var anchor=null;
  if(evtOrAnchor){
    if(evtOrAnchor.currentTarget) anchor=evtOrAnchor.currentTarget;
    else if(evtOrAnchor.target) anchor=evtOrAnchor.target;
    else if(evtOrAnchor.getBoundingClientRect) anchor=evtOrAnchor;
  }
  _mttsOpenStartWorkConfirmPopup(id, t.id||'', assetLbl, bdLabel, anchor, 'start');
}
// V131 — Resume Work mirrors Start Work but for tickets parked at
// awaiting_spares / awaiting_agency. Reuses the same anchored confirm
// popup with mode='resume' so the look-and-feel matches Start Work.
function _mttsTicketResumeWork(id, evtOrAnchor){
  var t=byId(DB.mttsTickets||[],id);
  if(!t){notify('Ticket not found',true);return;}
  if(!(_mttsIsTechnicianOnTicket(t)||_mttsIsSA()||_mttsIsMttsAdmin()||_mttsIsManager())){notify('You are not assigned to this ticket',true);return;}
  // V23 — Resume also accepted from work_in_progress so a tech can
  // re-stamp a start moment on a long-running ticket.
  if(t.status!=='awaiting_spares'&&t.status!=='awaiting_agency'&&t.status!=='work_in_progress'){
    notify('Resume Work only applies to tickets in progress / waiting for spares / external service.',true);return;
  }
  var asset=byId(DB.mttsAssets||[],t.assetCode);
  var assetLbl=_mttsAssetLabel(asset,t.assetCode||'');
  var bdLabel=_MTTS_BREAKDOWN_LABEL[t.breakdownType]||t.breakdownType||'—';
  var anchor=null;
  if(evtOrAnchor){
    if(evtOrAnchor.currentTarget) anchor=evtOrAnchor.currentTarget;
    else if(evtOrAnchor.target) anchor=evtOrAnchor.target;
    else if(evtOrAnchor.getBoundingClientRect) anchor=evtOrAnchor;
  }
  _mttsOpenStartWorkConfirmPopup(id, t.id||'', assetLbl, bdLabel, anchor, 'resume');
}
// Internal: render the click-anchored confirm popup. One DOM node is
// reused across opens (removed-and-recreated each time so positioning
// is fresh). Backdrop captures clicks-outside to dismiss.
function _mttsOpenStartWorkConfirmPopup(internalId, displayId, assetLbl, bdLabel, anchor, mode){
  mode=(mode==='resume')?'resume':'start';
  // Close any previous instance.
  var prev=document.getElementById('mttsStartWorkPop');
  if(prev) prev.parentNode.removeChild(prev);
  var prevB=document.getElementById('mttsStartWorkPopBackdrop');
  if(prevB) prevB.parentNode.removeChild(prevB);
  // Backdrop — full-screen transparent layer; click anywhere outside
  // the popup dismisses it.
  var backdrop=document.createElement('div');
  backdrop.id='mttsStartWorkPopBackdrop';
  backdrop.style.cssText='position:fixed;inset:0;z-index:99998;background:rgba(15,23,42,.18)';
  backdrop.onclick=_mttsCloseStartWorkConfirmPopup;
  document.body.appendChild(backdrop);
  // Popup
  var pop=document.createElement('div');
  pop.id='mttsStartWorkPop';
  pop.style.cssText='position:fixed;z-index:99999;background:#fff;border:2px solid #2563eb;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.22);padding:12px 14px;min-width:260px;max-width:320px;font-size:13px;color:var(--text)';
  var safeId=String(displayId||'').replace(/'/g,"\\'");
  var titleTxt=(mode==='resume')?'▶ Resume Work?':'▶ Start Work?';
  var bodyMsg=(mode==='resume')
    ? 'This flips the ticket back to <strong style="color:#2563eb">Work in Progress</strong> so you can post status updates again.'
    : 'This marks the timer and changes status to <strong style="color:#2563eb">Work in Progress</strong>. You have 15 min to undo.';
  var confirmFn=(mode==='resume')?'_mttsResumeWorkConfirmed':'_mttsStartWorkConfirmed';
  var confirmLbl=(mode==='resume')?'▶ Resume Now':'▶ Start Now';
  pop.innerHTML=
    '<div style="font-weight:900;color:#2563eb;font-size:14px;margin-bottom:8px;display:flex;align-items:center;gap:6px">'+titleTxt+'</div>'+
    '<div style="display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:1.4;margin-bottom:10px">'+
      '<div><span style="color:var(--text3);font-weight:700;display:inline-block;min-width:60px">Ticket</span><span style="font-family:var(--mono);font-weight:900;background:#dbeafe;color:#1e3a8a;padding:1px 8px;border-radius:5px">'+displayId+'</span></div>'+
      '<div><span style="color:var(--text3);font-weight:700;display:inline-block;min-width:60px">Asset</span><span style="font-weight:700">'+assetLbl+'</span></div>'+
      '<div><span style="color:var(--text3);font-weight:700;display:inline-block;min-width:60px">Issue</span><span>'+bdLabel+'</span></div>'+
    '</div>'+
    '<div style="font-size:11px;color:var(--text3);margin-bottom:10px">'+bodyMsg+'</div>'+
    '<div style="display:flex;gap:6px;justify-content:flex-end">'+
      '<button onclick="_mttsCloseStartWorkConfirmPopup()" style="font-size:12px;padding:6px 12px;font-weight:700;background:#f1f5f9;border:1px solid #cbd5e1;color:var(--text);border-radius:6px;cursor:pointer">Cancel</button>'+
      '<button onclick="'+confirmFn+'(\''+String(internalId).replace(/'/g,"\\'")+'\')" style="font-size:12px;padding:6px 14px;font-weight:800;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer">'+confirmLbl+'</button>'+
    '</div>';
  document.body.appendChild(pop);
  // Position: try to sit just below the anchor button. Flip above if it
  // overflows the viewport. Horizontal-centre on the anchor with viewport
  // clamping so it stays on screen on narrow phones.
  var pad=8;
  var vw=window.innerWidth||document.documentElement.clientWidth;
  var vh=window.innerHeight||document.documentElement.clientHeight;
  var pw=pop.offsetWidth, ph=pop.offsetHeight;
  var left, top;
  if(anchor&&typeof anchor.getBoundingClientRect==='function'){
    var r=anchor.getBoundingClientRect();
    left=r.left+(r.width-pw)/2;
    top=r.bottom+pad;
    if(top+ph>vh-pad) top=Math.max(pad, r.top-ph-pad);
  } else {
    left=(vw-pw)/2; top=(vh-ph)/2;
  }
  if(left<pad) left=pad;
  if(left+pw>vw-pad) left=vw-pw-pad;
  if(top<pad) top=pad;
  pop.style.left=Math.round(left)+'px';
  pop.style.top=Math.round(top)+'px';
}
function _mttsCloseStartWorkConfirmPopup(){
  var p=document.getElementById('mttsStartWorkPop'); if(p) p.parentNode.removeChild(p);
  var b=document.getElementById('mttsStartWorkPopBackdrop'); if(b) b.parentNode.removeChild(b);
}
async function _mttsStartWorkConfirmed(id){
  _mttsCloseStartWorkConfirmPopup();
  var t=byId(DB.mttsTickets||[],id);
  if(!t){notify('Ticket not found',true);return;}
  if(t.status!=='assigned'){notify('Status changed — refresh and try again.',true);return;}
  var nowIso=new Date().toISOString();
  var bak=Object.assign({},t);
  t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
  t.techActions.push({action:'work_in_progress',by:CU?(CU.name||CU.id||''):'',at:nowIso,note:'',photos:[]});
  t.techActions.sort(function(x,y){return String(x.at||'').localeCompare(String(y.at||''));});
  t.status='work_in_progress';
  t.startedAt=nowIso; t.startedBy=CU?(CU.name||CU.id||''):'';
  var ok=await _dbSave('mttsTickets',t);
  if(!ok){Object.assign(t,bak);notify('Save failed',true);return;}
  notify('▶ Work in Progress');
  _mttsRenderTickets();
  var ov=document.getElementById('mttsTicketDetailOverlay');
  if(ov&&ov.style.display!=='none') _mttsTicketDetail(id);
}
// V131 — Confirm handler for Resume Work. Same mechanics as Start Work:
// log a 'work_in_progress' techAction with the resume timestamp and flip
// the status back to work_in_progress. startedAt is bumped so the 15-min
// revoke window restarts from this resume click (intentional — gives the
// tech a fresh undo if they tapped Resume by accident).
async function _mttsResumeWorkConfirmed(id){
  _mttsCloseStartWorkConfirmPopup();
  var t=byId(DB.mttsTickets||[],id);
  if(!t){notify('Ticket not found',true);return;}
  // V23 — Allow resuming a WIP ticket too (re-stamps start moment).
  if(t.status!=='awaiting_spares'&&t.status!=='awaiting_agency'&&t.status!=='work_in_progress'){
    notify('Status changed — refresh and try again.',true);return;
  }
  var nowIso=new Date().toISOString();
  var bak=Object.assign({},t);
  t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
  t.techActions.push({action:'work_in_progress',by:CU?(CU.name||CU.id||''):'',at:nowIso,note:'Work resumed',photos:[]});
  t.techActions.sort(function(x,y){return String(x.at||'').localeCompare(String(y.at||''));});
  t.status='work_in_progress';
  t.startedAt=nowIso; t.startedBy=CU?(CU.name||CU.id||''):'';
  var ok=await _dbSave('mttsTickets',t);
  if(!ok){Object.assign(t,bak);notify('Save failed',true);return;}
  notify('▶ Work resumed');
  _mttsRenderTickets();
  var ov=document.getElementById('mttsTicketDetailOverlay');
  if(ov&&ov.style.display!=='none') _mttsTicketDetail(id);
}

// V127 — 15-minute window for the MM to revoke their own approval. Once a
// ticket has been closed longer than this, the Revoke ✓ button hides and
// the action is blocked at the handler too.
var _MTTS_APPROVAL_REVOKE_MS = 15 * 60 * 1000;

// ═══ V38 — STEP 5: Raiser "Confirm Work Done" / "Challenge" ════════════════
// Only the original ticket raiser can accept or dispute a technician's
// repair_done update. Confirm marks confirmedByRaiser=true (status stays
// repair_done — MM Step-6 closes it). Challenge transitions to
// repair_done_challenged with mandatory remarks for the timeline.
// V120 — Remarks are now collected by _mttsOpenConfirmPopup (modal) and
// passed in as the third arg, so this function no longer raises native
// confirm/prompt dialogs. Direct callers (legacy / SA) can still pass
// remarks explicitly. Challenge also clears confirmedByRaiser so the
// MM-side gate stays honest if the ticket cycles back into repair_done.
async function _mttsTicketConfirmWork(id, mode, remarks){
  var t=byId(DB.mttsTickets||[],id);
  if(!t){notify('Ticket not found',true);return;}
  if(!(_mttsIsRaiserOnTicket(t)||_mttsIsSA())){notify('Only the original raiser can confirm or challenge this fix.',true);return;}
  if(t.status!=='repair_done'){notify('Confirm/Challenge only available from "Repair Done".',true);return;}
  var nowIso=new Date().toISOString();
  var note=String(remarks||'').trim();
  var bak=Object.assign({},t);
  t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
  if(mode==='confirm'){
    t.confirmedByRaiser=true;
    t.confirmedAt=nowIso;
    t.confirmedBy=CU?(CU.name||CU.id||''):'';
    t.techActions.push({action:'raiser_confirmed',by:t.confirmedBy,at:nowIso,note:note,photos:[]});
    notify('✓ Repair confirmed — waiting for manager to close.');
  } else if(mode==='challenge'){
    if(!note){notify('Please enter a reason to challenge the repair.',true);return;}
    // V135 — Challenge treats the ticket like a brand-new Open ticket:
    // flip status to 'open' and clear the prior tech assignment so the
    // MM goes through the standard Allocate flow (not Approve). The
    // audit trail keeps the 'repair_done_challenged' techAction so the
    // history reads honestly.
    t.confirmedByRaiser=false;
    t.challengedReason=note;
    t.challengedAt=nowIso;
    t.challengedBy=CU?(CU.name||CU.id||''):'';
    t.status='open';
    t.assignedTo=[]; t.assignedAt=''; t.assignedBy='';
    t.startedAt=''; t.startedBy='';
    t.techActions.push({action:'repair_done_challenged',by:t.challengedBy,at:nowIso,note:note,photos:[]});
    notify('⚠ Repair challenged — back to Open for reassignment.');
  } else {
    notify('Unknown action.',true); return;
  }
  t.techActions.sort(function(x,y){return String(x.at||'').localeCompare(String(y.at||''));});
  var ok=await _dbSave('mttsTickets',t);
  if(!ok){Object.assign(t,bak);notify('Save failed',true);return;}
  _mttsRenderTickets();
  var ov=document.getElementById('mttsTicketDetailOverlay');
  if(ov&&ov.style.display!=='none') _mttsTicketDetail(id);
}

// V120 — Raiser review popup. Triggered by the single ✓ Confirm button on
// a repair_done ticket. Renders ticket details + closure photos pulled
// in via _mttsLoadTicketPhotos, then lets the raiser:
//   • Confirm → calls _mttsTicketConfirmWork(id,'confirm',remarks) — remarks optional.
//   • Challenge → remarks REQUIRED. Status flips to repair_done_challenged
//     so the MM can reassign. Asset downtime resumes automatically because
//     _mttsDowntimeEnd treats the challenged state as live.
function _mttsOpenConfirmPopup(id){
  var t=byId(DB.mttsTickets||[],id);
  if(!t){notify('Ticket not found',true);return;}
  if(!(_mttsIsRaiserOnTicket(t)||_mttsIsSA())){notify('Only the original raiser can confirm or challenge this fix.',true);return;}
  if(t.status!=='repair_done'){notify('Confirm/Challenge only available from "Repair Done".',true);return;}
  // Lazy-pull closure photos — boot strips them. Re-open once they land.
  if(typeof _mttsLoadTicketPhotos==='function' && !_mttsLoadedTicketPhotos[id]){
    _mttsLoadTicketPhotos(id).then(function(){ _mttsOpenConfirmPopup(id); });
  }
  _mttsCloseConfirmPopup();
  var asset=byId(DB.mttsAssets||[],t.assetCode);
  var assetLbl=_mttsAssetLabel(asset);
  var plantLbl=_mttsPlantLabel(t.plant);
  var raiser=t.raisedBy?_mttsUserDisp(t.raisedBy):'—';
  var techList=(t.assignedTo||[]).map(function(u){return _mttsUserDisp(u);}).join(', ')||'—';
  // Locate the latest repair_done techAction to surface its note + photos.
  var rdAct=null;
  (t.techActions||[]).forEach(function(a){if(a&&a.action==='repair_done') rdAct=a;});
  var rdNote=rdAct?String(rdAct.note||''):'';
  var rdAt=rdAct?_mttsFmtISTDateTime(rdAct.at):'';
  var rdBy=rdAct?_mttsUserDisp(rdAct.by||''):'';
  var photos=(rdAct&&rdAct.photos&&rdAct.photos.length)?rdAct.photos.slice():(t.closePhotos||[]).slice();
  var photosHtml=photos.length
    ? '<div style="display:flex;gap:6px;flex-wrap:wrap">'+photos.map(function(src){
        var s=String(src||'').replace(/'/g,"\\'");
        return '<img src="'+src+'" onclick="event.stopPropagation();_mttsLightbox(\''+s+'\')" style="width:84px;height:84px;object-fit:cover;border-radius:6px;border:1px solid var(--border);cursor:pointer">';
      }).join('')+'</div>'
    : '<div style="color:var(--text3);font-size:12px;font-style:italic">No closure photos.</div>';
  var rootHtml=t.rootCause
    ? '<div style="font-size:12px;margin-top:6px;padding:6px 10px;background:#fef3c7;border-left:3px solid #fbbf24;border-radius:0 6px 6px 0"><b>Root cause:</b> '+String(t.rootCause).replace(/</g,'&lt;')+'</div>'
    : '';
  var bdLbl=_MTTS_BREAKDOWN_LABEL[t.breakdownType]||t.breakdownType||'—';
  var bdSinceDur=_mttsTimerSince(t.breakdownSince||t.raisedAt, rdAct?rdAct.at:null);
  var idEsc=String(t.id||'').replace(/'/g,"\\'");
  // Modal markup. _kapModalPortal isn't strictly needed here (no parent
  // isolation:isolate barrier on the tickets page) but we use a high
  // z-index + portal-to-body anyway to be safe across pages.
  var ov=document.createElement('div');
  ov.id='mttsConfirmPopupOverlay';
  ov.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:100000;padding:16px';
  ov.onclick=function(e){if(e.target===ov) _mttsCloseConfirmPopup();};
  ov.innerHTML=
    '<div style="background:#fff;border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.32);width:min(640px,96vw);max-height:92vh;overflow:auto;padding:18px 20px;font-size:13px;color:var(--text)">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:12px">'+
        '<div>'+
          '<div style="font-size:16px;font-weight:900;color:#0f172a">✓ Review Repair</div>'+
          '<div style="font-size:11px;color:var(--text3);margin-top:2px">Confirm the fix, or challenge it back to the manager.</div>'+
        '</div>'+
        '<button onclick="_mttsCloseConfirmPopup()" aria-label="Close" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--text3);padding:0 4px;line-height:1">×</button>'+
      '</div>'+
      // Identity row
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">'+
        '<span style="font-family:var(--mono);font-weight:900;font-size:16px;background:#dbeafe;color:#1e3a8a;padding:3px 10px;border-radius:6px">'+(t.id||'')+'</span>'+
        _mttsPlantBadgeShort(t.plant)+
        '<span style="font-size:14px;font-weight:800;color:var(--text)">'+assetLbl+'</span>'+
      '</div>'+
      // Meta grid
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 14px;background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-top:8px">'+
        '<div><div style="font-size:9px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Breakdown</div><div style="font-size:12px;font-weight:700;color:var(--text);margin-top:2px">'+bdLbl+'</div></div>'+
        '<div><div style="font-size:9px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Down for</div><div style="font-size:12px;font-weight:800;color:#0f172a;margin-top:2px;font-family:var(--mono)">'+bdSinceDur+'</div></div>'+
        '<div><div style="font-size:9px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Raised by</div><div style="font-size:12px;font-weight:700;color:var(--text);margin-top:2px">'+raiser+'</div></div>'+
        '<div><div style="font-size:9px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Technician(s)</div><div style="font-size:12px;font-weight:700;color:var(--text);margin-top:2px">'+techList+'</div></div>'+
        (rdAt?'<div><div style="font-size:9px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Repair done</div><div style="font-size:12px;font-weight:700;color:var(--text);margin-top:2px">'+rdAt+'</div><div style="font-size:10px;color:var(--text3)">by '+rdBy+'</div></div>':'')+
      '</div>'+
      rootHtml+
      // Tech repair note (from the repair_done techAction)
      (rdNote?'<div style="font-size:12px;margin-top:8px;padding:8px 10px;background:#ecfdf5;border-left:3px solid #16a34a;border-radius:0 6px 6px 0;white-space:pre-wrap"><b style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#15803d;margin-bottom:3px">Technician notes</b>'+String(rdNote).replace(/</g,'&lt;')+'</div>':'')+
      // Repair photos
      '<div style="margin-top:10px">'+
        '<div style="font-size:10px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Repair photos</div>'+
        photosHtml+
      '</div>'+
      // Remarks
      '<div style="margin-top:12px">'+
        '<label for="mttsConfirmRemarks" style="display:block;font-size:11px;font-weight:800;color:var(--text2);margin-bottom:4px">Remarks <span style="font-weight:600;color:var(--text3)">(mandatory for Challenge)</span></label>'+
        '<textarea id="mttsConfirmRemarks" rows="3" placeholder="Add a remark — required if you challenge the repair." style="width:100%;padding:8px 10px;border:1.5px solid #94a3b8;border-radius:6px;font-size:13px;resize:vertical;font-family:inherit"></textarea>'+
        '<div id="mttsConfirmRemarksErr" style="display:none;margin-top:4px;font-size:11px;color:#dc2626;font-weight:700"></div>'+
      '</div>'+
      // Action buttons
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;border-top:1px solid var(--border);padding-top:12px">'+
        '<button onclick="_mttsCloseConfirmPopup()" style="font-size:13px;padding:8px 14px;font-weight:700;background:#f1f5f9;border:1px solid #cbd5e1;color:var(--text);border-radius:7px;cursor:pointer">Cancel</button>'+
        '<button onclick="_mttsConfirmPopupSubmit(\''+idEsc+'\',\'challenge\')" style="font-size:13px;padding:8px 14px;font-weight:800;background:#fff;border:1.5px solid #ea580c;color:#9a3412;border-radius:7px;cursor:pointer">⚠ Challenge</button>'+
        '<button onclick="_mttsConfirmPopupSubmit(\''+idEsc+'\',\'confirm\')" style="font-size:13px;padding:8px 16px;font-weight:800;background:#16a34a;color:#fff;border:none;border-radius:7px;cursor:pointer">✓ Confirm</button>'+
      '</div>'+
    '</div>';
  document.body.appendChild(ov);
  // Focus the textarea so keyboard users land directly on the remarks.
  setTimeout(function(){var ta=document.getElementById('mttsConfirmRemarks');if(ta) ta.focus();},20);
}
function _mttsCloseConfirmPopup(){
  var ov=document.getElementById('mttsConfirmPopupOverlay');
  if(ov&&ov.parentNode) ov.parentNode.removeChild(ov);
}
// V45 — Generic centred alert popup used by the "duplicate ticket on
// same asset" check (and any future warn-and-block flows). Dismissed
// by the red Close button or Escape. Reparented to <body> so it sits
// on top of any open modal (.modal-overlay is z-index 100000; this
// popup uses max-int).
function _mttsOpenAlertPopup(opts){
  opts=opts||{};
  _mttsCloseAlertPopup();
  var ov=document.createElement('div');
  ov.id='mttsAlertPopupOverlay';
  ov.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:2147483646;padding:16px';
  ov.onclick=function(e){/* backdrop click does NOT dismiss — user must use Close / Esc */};
  var title=String(opts.title||'⚠ Alert');
  var tid=String(opts.ticketId||'?').replace(/</g,'&lt;');
  var stat=String(opts.statusLabel||'').replace(/</g,'&lt;');
  var by=String(opts.raiser||'—').replace(/</g,'&lt;');
  ov.innerHTML=
    '<div style="background:#fff;border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.32);width:min(480px,96vw);border:2px solid #dc2626;overflow:hidden">'+
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#fee2e2;border-bottom:1.5px solid #fca5a5">'+
        '<div style="font-size:15px;font-weight:900;color:#7f1d1d">'+title+'</div>'+
        '<button type="button" onclick="_mttsCloseAlertPopup()" aria-label="Close" title="Close (Esc)" style="background:#dc2626;color:#fff;border:none;width:32px;height:32px;border-radius:50%;font-size:18px;font-weight:900;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(220,38,38,.4)">✕</button>'+
      '</div>'+
      '<div style="padding:16px 18px;font-size:14px;line-height:1.5;color:var(--text)">'+
        'There is already a Ticket No <b style="font-family:var(--mono);color:#0f172a">'+tid+'</b>, with TS <b style="color:#7f1d1d">'+stat+'</b>, raised by <b>'+by+'</b>.'+
        '<div style="margin-top:10px;font-weight:700;color:#0f172a">Please contact Maintenance Manager.</div>'+
      '</div>'+
      '<div style="padding:10px 14px 14px;display:flex;justify-content:flex-end">'+
        '<button type="button" onclick="_mttsCloseAlertPopup()" style="font-size:13px;padding:8px 18px;font-weight:800;background:#dc2626;color:#fff;border:none;border-radius:8px;cursor:pointer">Close</button>'+
      '</div>'+
    '</div>';
  document.body.appendChild(ov);
  if(!_mttsAlertEscBound){
    _mttsAlertEscBound=true;
    document.addEventListener('keydown',function(ev){
      if(ev.key!=='Escape') return;
      var _ov=document.getElementById('mttsAlertPopupOverlay');
      if(_ov){ ev.preventDefault(); _mttsCloseAlertPopup(); }
    });
  }
}
var _mttsAlertEscBound=false;
function _mttsCloseAlertPopup(){
  var ov=document.getElementById('mttsAlertPopupOverlay');
  if(ov&&ov.parentNode) ov.parentNode.removeChild(ov);
}
async function _mttsConfirmPopupSubmit(id, mode){
  var taEl=document.getElementById('mttsConfirmRemarks');
  var errEl=document.getElementById('mttsConfirmRemarksErr');
  var remarks=taEl?String(taEl.value||'').trim():'';
  if(mode==='challenge' && !remarks){
    if(errEl){errEl.textContent='Remarks are required to challenge the repair.';errEl.style.display='block';}
    if(taEl){taEl.style.borderColor='#dc2626';taEl.focus();}
    return;
  }
  if(errEl){errEl.style.display='none';}
  // Disable buttons so the user can't double-submit while the save is in flight.
  var ov=document.getElementById('mttsConfirmPopupOverlay');
  if(ov){
    Array.prototype.forEach.call(ov.querySelectorAll('button'),function(b){b.disabled=true;});
  }
  try{
    await _mttsTicketConfirmWork(id, mode, remarks);
  } finally {
    _mttsCloseConfirmPopup();
  }
}

// ═══ V38 — STEP 6: Manager "Reallocate" ════════════════════════════════════
// Sends the ticket back to `assigned` so the same (or a different) technician
// can re-attempt the fix. Used when the raiser has challenged the repair,
// or when the manager isn't satisfied with the repair_done update.
async function _mttsTicketReallocate(id){
  var t=byId(DB.mttsTickets||[],id);
  if(!t){notify('Ticket not found',true);return;}
  if(!_mttsCanApprove()){notify('Only the manager can reallocate.',true);return;}
  if(t.status!=='repair_done'&&t.status!=='repair_done_challenged'){
    notify('Reallocate is only available once the technician has marked Repair Done.',true);return;
  }
  if(!confirm('Reallocate ticket '+(t.id||'')+' back to the technician(s)?')) return;
  var nowIso=new Date().toISOString();
  var bak=Object.assign({},t);
  t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
  t.status='assigned';
  t.confirmedByRaiser=false;
  t.confirmedAt=''; t.confirmedBy='';
  t.techActions.push({action:'reallocated',by:CU?(CU.name||CU.id||''):'',at:nowIso,note:'',photos:[]});
  t.techActions.sort(function(x,y){return String(x.at||'').localeCompare(String(y.at||''));});
  var ok=await _dbSave('mttsTickets',t);
  if(!ok){Object.assign(t,bak);notify('Save failed',true);return;}
  notify('↩ Reallocated — back to Technician Allocated.');
  _mttsRenderTickets();
  var ov=document.getElementById('mttsTicketDetailOverlay');
  if(ov&&ov.style.display!=='none') _mttsTicketDetail(id);
}

// ── Manager approval flow ─────────────────────────────────────────────────
function _mttsTicketApproveOpen(id, mode){
  if(!_mttsCanApprove()){notify('Only Maintenance Manager can approve',true);return;}
  var t=byId(DB.mttsTickets||[],id);if(!t){notify('Ticket not found',true);return;}
  // V136 — Two modes on the same modal:
  //   'approve' (default): repair_done → close flow. Send Back + Approve.
  //   'expense'           : closed ticket. Edit external cost + invoice
  //                         photos; ticket stays closed. Save Expense only.
  mode=(mode==='expense')?'expense':'approve';
  // V38 — invoicePhotos is stripped at boot; pull it before populating the
  // photo buffer so existing photos aren't wiped when the approve form
  // saves with a stale (empty) buffer.
  if(typeof _mttsLoadTicketPhotos==='function' && !_mttsLoadedTicketPhotos[id]){
    _mttsLoadTicketPhotos(id).then(function(){ _mttsTicketApproveOpen(id, mode); });
  }
  document.getElementById('mttsApproveTicketId').value=id;
  var modeEl=document.getElementById('mttsApproveMode');
  if(modeEl) modeEl.value=mode;
  // Toggle the footer buttons + title per mode.
  var titleEl=document.getElementById('mttsApproveTitle');
  if(titleEl) titleEl.textContent=(mode==='expense')?'💰 Expense Data':'✅ Approve / Close Ticket';
  var sendBackBtn=document.getElementById('mttsApproveSendBack');
  var submitBtn  =document.getElementById('mttsApproveSubmit');
  var saveExpBtn =document.getElementById('mttsApproveSaveExp');
  if(sendBackBtn) sendBackBtn.style.display=(mode==='expense')?'none':'';
  if(submitBtn)   submitBtn.style.display  =(mode==='expense')?'none':'';
  if(saveExpBtn)  saveExpBtn.style.display =(mode==='expense')?'':'none';
  // V22 — Replicate the tickets-list card layout in the Approve /
  // Expense Data header so the manager sees the same summary they
  // clicked from. Uses _mttsTicketSummaryHtml (ID + raiser/timestamp,
  // Status + Priority, Plant + Asset, Tech badge, Asset Condition /
  // Symptoms / Downtime).
  document.getElementById('mttsApproveTicketLbl').innerHTML=_mttsTicketSummaryHtml(t);
  if(typeof _mttsStartLiveTimer==='function') _mttsStartLiveTimer();
  document.getElementById('mttsApproveCostSvc').value=t.costService||'';
  document.getElementById('mttsApproveCostSpr').value=t.costSpares||'';
  _mttsApprovePhotosBuf=(t.invoicePhotos||[]).slice(0,3);
  _mttsRenderApprovePhotoTiles();
  document.getElementById('mttsApprovePhotos').value='';
  document.getElementById('mttsApproveNote').value='';
  // V23 — External Cost Details defaults to enabled (checkbox checked)
  // in both Approve and Expense Data modes. Manager unchecks it if the
  // repair was internal-only.
  _mttsApprovePickExt('yes');
  var err=document.getElementById('mttsApproveErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsApprove'); else { document.getElementById('mMttsApprove').classList.add('open'); }
}
// V136 — Open the same modal in expense-edit mode for a closed ticket.
function _mttsTicketExpenseOpen(id){ _mttsTicketApproveOpen(id, 'expense'); }
// V136 — Save changes to External Cost / Spares / Invoice Photos on a
// closed ticket WITHOUT changing the ticket's status, approved-by, or
// approved-at fields. No 'closed' techAction is appended; an
// 'expense_updated' entry logs the edit so the audit trail is honest.
async function _mttsTicketExpenseSave(){
  if(!_mttsCanApprove()){notify('Access denied',true);return;}
  var err=document.getElementById('mttsApproveErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var id=document.getElementById('mttsApproveTicketId').value;
  var t=byId(DB.mttsTickets||[],id);if(!t){_showErr('Ticket not found');return;}
  if(t.status!=='closed'){_showErr('Ticket is not closed — open the standard Approve flow instead.');return;}
  var ext=(document.getElementById('mttsApproveExt')||{}).value||'no';
  var costSvc=parseFloat(document.getElementById('mttsApproveCostSvc').value)||0;
  var costSpr=parseFloat(document.getElementById('mttsApproveCostSpr').value)||0;
  var note=document.getElementById('mttsApproveNote').value.trim();
  if(ext==='yes'){
    if(costSvc<=0&&costSpr<=0){
      _showErr('Enter External Service Cost or Spares Cost (or pick "No external cost")');
      _mttsFlashFieldErr('mttsApproveCostSvc','mttsApproveCostSpr');return;
    }
    if(!_mttsApprovePhotosBuf.length){
      _showErr('At least 1 invoice photo is required when external cost applies');
      _mttsFlashFieldErr('mttsApproveExtFields');return;
    }
  } else {
    costSvc=0; costSpr=0; _mttsApprovePhotosBuf=[];
  }
  var bak=Object.assign({},t);
  t.costService=costSvc;
  t.costSpares=costSpr;
  t.invoicePhotos=_mttsApprovePhotosBuf.slice();
  t.techActions=Array.isArray(t.techActions)?t.techActions.slice():[];
  t.techActions.push({action:'expense_updated',by:CU?(CU.name||CU.id||''):'',at:new Date().toISOString(),note:note,costService:costSvc,costSpares:costSpr});
  var ok=await _dbSave('mttsTickets',t);
  if(!ok){Object.assign(t,bak);_showErr('Save failed');return;}
  cm('mMttsApprove');
  notify('💾 Expense data updated · ₹'+(costSvc+costSpr).toFixed(2)+' total');
  _mttsRenderTickets();
}
// External-cost toggle: 'yes' shows the cost / invoice fields and makes
// at least one cost + at least one invoice photo mandatory; 'no' hides
// the section and the manager can approve without any inputs.
function _mttsApprovePickExt(v){
  var hidden=document.getElementById('mttsApproveExt');
  if(hidden) hidden.value=v;
  // V21 — Yes/No button group retired. The legend checkbox is the
  // single source of truth; keep it in sync when this is called
  // programmatically (e.g. on modal open).
  var chk=document.getElementById('mttsApproveExtChk');
  if(chk) chk.checked=(v==='yes');
  // V20 — Panel stays visible; only its enabled state flips. The
  // fieldset[disabled] cascade auto-greys the inner inputs / photo
  // trigger. .is-disabled class adds a stronger visual cue (muted bg,
  // dashed border, no-drop cursor) on top of the native disabled look.
  var fields=document.getElementById('mttsApproveExtFields');
  if(fields){
    var disabled=(v!=='yes');
    fields.disabled=disabled;
    fields.classList.toggle('is-disabled',disabled);
  }
}
async function _mttsTicketApproveConfirm(){
  if(!_mttsCanApprove()){notify('Access denied',true);return;}
  var err=document.getElementById('mttsApproveErr');
  var _showErr=function(m){if(err){err.textContent=m;err.style.display='block';}};
  var id=document.getElementById('mttsApproveTicketId').value;
  var t=byId(DB.mttsTickets||[],id);if(!t){_showErr('Ticket not found');return;}
  // V38 — Step-6 gate: manager can only close once the raiser has confirmed
  // the repair (Step 5). Challenged repairs must be reallocated first.
  if(t.status==='repair_done_challenged'){
    _showErr('Repair was challenged by the raiser. Reallocate the ticket and let the technician re-attempt before closing.');
    return;
  }
  if(t.status==='repair_done' && !t.confirmedByRaiser && !_mttsIsSA()){
    _showErr('Waiting for the raiser to confirm the repair before this can be closed.');
    return;
  }
  var ext=(document.getElementById('mttsApproveExt')||{}).value||'no';
  var costSvc=parseFloat(document.getElementById('mttsApproveCostSvc').value)||0;
  var costSpr=parseFloat(document.getElementById('mttsApproveCostSpr').value)||0;
  var note=document.getElementById('mttsApproveNote').value.trim();
  if(ext==='yes'){
    // External-cost mode — at least one cost + at least one invoice
    // photo required so the closure stands up to audit.
    if(costSvc<=0&&costSpr<=0){
      _showErr('Enter External Service Cost or Spares Cost (or pick "No external cost")');
      _mttsFlashFieldErr('mttsApproveCostSvc','mttsApproveCostSpr');return;
    }
    if(!_mttsApprovePhotosBuf.length){
      _showErr('At least 1 invoice photo is required when external cost applies');
      _mttsFlashFieldErr('mttsApproveExtFields');return;
    }
  } else {
    // No external cost — clear any leftover values so the saved ticket
    // doesn't carry stale numbers from an earlier draft.
    costSvc=0;costSpr=0;_mttsApprovePhotosBuf=[];
  }
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
  // V127/V132 — Enforce the 15-min window for everyone (no role bypass).
  // Legacy closed tickets with no approvedAt timestamp are also blocked —
  // they're past the window by definition.
  if(!t.approvedAt){notify('15-minute revoke window has passed.',true);return;}
  var _leftMs=(new Date(t.approvedAt).getTime()+_MTTS_APPROVAL_REVOKE_MS)-Date.now();
  if(_leftMs<=0){notify('15-minute revoke window has passed.',true);return;}
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

// Send back to technician — close the Approve modal and jump straight
// into the Allocate modal pre-filled with the existing assignees so the
// manager can confirm or change the technician(s). The Allocate save
// (_mttsTicketAllocateConfirm) will set status='assigned' and log a
// 'reassigned' (or 'allocated') techAction.
function _mttsTicketApproveReject(){
  if(!_mttsCanApprove()){notify('Access denied',true);return;}
  var id=document.getElementById('mttsApproveTicketId').value;
  var t=byId(DB.mttsTickets||[],id);if(!t) return;
  cm('mMttsApprove');
  _mttsTicketAllocateOpen(id);
}

// ── Detail viewer (read-only quick look) ──────────────────────────────────
// Image lightbox — full-screen overlay with the clicked image scaled to
// fit. Click anywhere or press Escape to dismiss.
function _mttsLightbox(src){
  var existing=document.getElementById('mttsLightbox');if(existing) existing.remove();
  var ov=document.createElement('div');
  ov.id='mttsLightbox';
  // V1 (260518) — z-index bumped to the max 32-bit value so the lightbox
  // ALWAYS sits on top of the Ticket Detail overlay (which itself uses
  // 2147483646 to escape modal stacking contexts). Was 200001 — anything
  // less than the detail overlay loses to it.
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:2147483647;display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:20px';
  // Prominent red ✕ matching the Ticket Detail close button.
  // V1 (260518) — onclick routes through _lbClose (declared below) via
  // addEventListener so the history-stack pop runs too.
  ov.innerHTML='<button id="_mttsLbClose" aria-label="Close" title="Close (Esc)" style="position:absolute;top:14px;right:14px;width:46px;height:46px;border-radius:50%;background:#dc2626;color:#fff;border:none;font-size:26px;font-weight:900;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(220,38,38,.55),0 0 0 3px rgba(255,255,255,.85);z-index:1">✕</button>'+
    '<img src="'+String(src).replace(/"/g,'&quot;')+'" style="max-width:96vw;max-height:92vh;object-fit:contain;border-radius:8px;box-shadow:0 30px 80px rgba(0,0,0,.6)">';
  // V5 (260518) — Lightbox stays independent of the history stack —
  // the same round-trip pattern caused issues on the Ticket Detail
  // overlay, so we keep the lightbox simple: click anywhere / Esc / ✕
  // closes it directly.
  // V8 (260518) — Esc handler registered on WINDOW in capture phase so
  // it fires BEFORE the document-bound global Esc handler in common.js.
  // Without this, the global handler (which closes the Ticket Detail
  // behind the lightbox) ran first and called stopPropagation —
  // swallowing Esc#1 entirely, so the user needed Esc#2 to actually
  // dismiss the photo. We also call stopImmediatePropagation so the
  // ticket-detail behind the lightbox doesn't close as a side effect.
  var _lbClose=function(){
    if(!ov.parentNode) return;
    ov.remove();
    window.removeEventListener('keydown',escHandler,true);
  };
  ov.onclick=function(){ _lbClose(); };
  var escHandler=function(ev){
    if(ev.key!=='Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    if(typeof ev.stopImmediatePropagation==='function') ev.stopImmediatePropagation();
    _lbClose();
  };
  window.addEventListener('keydown',escHandler,true);
  // Wire the prominent ✕ button to _lbClose with stopPropagation so the
  // click doesn't bubble to the overlay's onclick (which would also
  // close, but via a duplicate path).
  var _xBtn=ov.querySelector('#_mttsLbClose');
  if(_xBtn){ _xBtn.addEventListener('click',function(ev){ ev.stopPropagation(); _lbClose(); }); }
  // V1 (260518) — Append to <body> end so no ancestor stacking context
  // (e.g. an opener overlay that itself has transform/filter set) can
  // trap us behind it. The z-index above only beats peers in the same
  // stacking context — the reparent guarantees we're a top-level peer.
  document.body.appendChild(ov);
}

function _mttsTicketDetail(id){
  var t=byId(DB.mttsTickets||[],id);if(!t) return;
  var idEsc=String(id).replace(/'/g,"\\'");
  // V38 — Boot strips the three photo arrays for speed; pull them in now so
  // the timeline shows raise / close / invoice photos. Re-renders the
  // overlay once the fetch lands (it's a no-op when already loaded).
  if(typeof _mttsLoadTicketPhotos==='function' && !_mttsLoadedTicketPhotos[id]){
    _mttsLoadTicketPhotos(id).then(function(){
      var ov=document.getElementById('mttsTicketDetailOverlay');
      if(ov && ov.style.display!=='none') _mttsTicketDetail(id);
    });
  }
  var actLbls={raised:'🎫 Raised',allocated:'👥 Allocated',reassigned:'👥 Reassigned',revoked:'↩ Revoked',assigned:'👥 Assigned',work_in_progress:'▶ Work in progress',partial_done:'⏸ Partial work done',awaiting_spares:'🔩 Awaiting spares',awaiting_agency:'🔧 Awaiting agency',repair_done:'✓ Repair done',raiser_confirmed:'✓ Raiser confirmed',repair_done_challenged:'⚠ Repair challenged',reallocated:'↩ Reallocated',scrapped:'🚫 Scrapped',closed:'✅ Closed',approval_revoked:'↩ Approval revoked',rework_requested:'↩ Rework requested',expense_updated:'💰 Expense updated',start_work_revoked:'↩ Start work revoked'};
  // Per-row photo source: entry photos win; fall back to ticket-level
  // buckets so older records still surface the right thumbnails.
  var resolveRowPhotos=function(a){
    if(a.photos&&a.photos.length) return a.photos.slice();
    if(a.action==='raised'&&t.photosRaise&&t.photosRaise.length) return t.photosRaise.slice();
    if((a.action==='repair_done'||a.action==='scrapped')&&t.closePhotos&&t.closePhotos.length) return t.closePhotos.slice();
    if(a.action==='closed'&&t.invoicePhotos&&t.invoicePhotos.length) return t.invoicePhotos.slice();
    return [];
  };
  // V32 — Activity timeline: no Edit column; date in "dd-Mmm, hh:mm am/pm"
  // single-line format. Sort newest-first.
  var actEntries=(t.techActions||[]).map(function(a,i){return {a:a,i:i};});
  actEntries.sort(function(x,y){return String(y.a.at||'').localeCompare(String(x.a.at||''));});
  // V1 (260518) — Compact 2-column layout for NMS visibility:
  //   • # column dropped (entries are time-ordered anyway).
  //   • When/Action and Notes/ETA folded into a single Activity column
  //     (when on row 1, action+by on row 2, note/eta/techs below).
  //   • Photos pinned to the last column with smaller thumbs (36×36)
  //     so the table fits a narrow screen without horizontal scroll.
  var actTh='padding:5px 7px;font-size:10px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;text-transform:uppercase;letter-spacing:.4px;color:var(--text2)';
  var actTd='padding:6px 7px;font-size:12px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var actBodyRows=actEntries.map(function(p){
    var a=p.a;
    var when=_mttsFmtISTDateTimeShort(a.at);
    var rowPhotos=resolveRowPhotos(a);
    // V5 (260518) — Photos stacked vertically (one above the other).
    // When the row has NO photos, show a single empty placeholder
    // frame so the column keeps its rhythm without leaving an obvious
    // empty hole. When the row HAS photos, stack them; no extra
    // placeholder.
    var _photoFrame='width:36px;height:36px;object-fit:cover;border-radius:4px;border:1px solid var(--border);cursor:pointer;display:block';
    var _frameBlank='width:36px;height:36px;border-radius:4px;border:1px dashed var(--border);background:#f8fafc;display:block';
    var photos=rowPhotos.length
      ?'<div style="display:flex;flex-direction:column;gap:3px">'+rowPhotos.map(function(src){return '<img src="'+src+'" onclick="event.stopPropagation();_mttsLightbox(\''+String(src).replace(/'/g,"\\'")+'\')" style="'+_photoFrame+'">';}).join('')+'</div>'
      :'<span style="'+_frameBlank+'"></span>';
    var editedBadge=a.editedAt?'<div style="font-size:9px;color:var(--text3);font-style:italic;margin-top:1px">edited '+_mttsFmtISTDate(a.editedAt)+'</div>':'';
    var noteHtml='';
    if(a.note) noteHtml+='<div style="color:var(--text);font-size:12px;line-height:1.35;white-space:pre-wrap;margin-top:2px">'+String(a.note).replace(/</g,'&lt;')+'</div>';
    if(a.eta) noteHtml+='<div style="font-size:10px;color:#92400e;margin-top:2px;font-weight:700">ETA: '+a.eta+'</div>';
    if(a.techs&&a.techs.length) noteHtml+='<div style="font-size:10px;color:var(--text3);margin-top:2px">Techs: <b>'+a.techs.map(function(u){return _mttsUserDisp(u);}).join(', ')+'</b></div>';
    return '<tr>'+
      '<td style="'+actTd+';line-height:1.3">'+
        '<div style="font-family:var(--mono);font-size:10.5px;font-weight:700;color:var(--text3);word-break:break-word">'+when+'</div>'+
        '<div style="font-size:12px;font-weight:800;color:var(--text);margin-top:1px">'+(actLbls[a.action]||a.action)+(a.by?' <span style="font-size:10px;color:var(--text3);font-weight:600">· by '+_mttsUserDisp(a.by)+'</span>':'')+'</div>'+
        noteHtml+
        editedBadge+
      '</td>'+
      '<td style="'+actTd+';width:40px;min-width:40px;max-width:40px;text-align:center;padding:6px 2px">'+photos+'</td>'+
    '</tr>';
  }).join('');
  // V6 (260518) — Photos column hard-locked to 40px (one 36px thumb
  // plus 2px of breathing room on each side). Photos stack vertically
  // inside that fixed-width slot. Header collapses to a tiny camera
  // emoji so "Photos" text can't widen the column.
  var actHtml=actEntries.length
    ? '<div style="overflow:auto;border:1px solid var(--border);border-radius:8px;background:#fff"><table style="width:100%;border-collapse:collapse;table-layout:fixed">'+
        '<colgroup>'+
          '<col>'+
          '<col style="width:40px">'+
        '</colgroup>'+
        '<thead><tr>'+
          '<th style="'+actTh+'">Activity</th>'+
          '<th style="'+actTh+';text-align:center;padding:5px 2px" title="Photos">📷</th>'+
        '</tr></thead><tbody>'+actBodyRows+'</tbody></table></div>'
    : '<div style="padding:18px;text-align:center;color:var(--text3);font-size:12px;font-style:italic">No activity yet.</div>';
  // V32/V34 — Top header is a 1:1 replica of the tickets-list card via
  // _mttsTicketSummaryHtml. The wrapper now also mirrors the list-card
  // chrome (plant colour stripe, status-driven background tint, owner
  // corner-flag), so the detail page reads as the exact same card the
  // user clicked. A prominent red ✕ button sits in the top-right;
  // Escape also dismisses the overlay (wired below).
  var summary=_mttsTicketSummaryHtml(t);
  var plantColor=_mttsPlantColor(t.plant)||'#94a3b8';
  var cardBgMap={open:'#fee2e2',assigned:'#dbeafe',work_in_progress:'#fef9c3',awaiting_spares:'#ffedd5',awaiting_agency:'#ffedd5',repair_done:'#dcfce7',repair_done_challenged:'#fee2e2',closed:'#bbf7d0',scrapped:'#fed7aa'};
  var cardBg=cardBgMap[t.status]||'#fff';
  var approvedBorder=(t.status==='closed')?';border:3px solid #16a34a':'';
  var _meKey=CU?(CU.name||CU.id):'';
  var _isMineRaised=_meKey && t.raisedBy===_meKey;
  var _isMineAllotted=_mttsIsTechnicianOnTicket(t);
  var ownerFlagHtml='';
  if(_isMineRaised) ownerFlagHtml='<span class="mtts-tcard-flag is-raised" title="Raised by me"></span>';
  else if(_isMineAllotted) ownerFlagHtml='<span class="mtts-tcard-flag is-allotted" title="Allotted to me"></span>';
  var costStrip=(t.costService||t.costSpares)
    ? '<div style="font-size:12px;margin-top:10px;padding:6px 10px;background:#dcfce7;border-radius:6px"><b>Cost:</b> Service ₹'+(t.costService||0)+' · Spares ₹'+(t.costSpares||0)+' · Total ₹'+((t.costService||0)+(t.costSpares||0)).toFixed(2)+'</div>'
    : '';
  var rootStrip=t.rootCause
    ? '<div style="font-size:12px;margin-top:10px;padding:6px 10px;background:#fef3c7;border-left:3px solid #fbbf24;border-radius:0 6px 6px 0"><b>Root cause:</b> '+String(t.rootCause).replace(/</g,'&lt;')+'</div>'
    : '';
  // V39 — z-index bumped above .modal-overlay (100000) so the History
  // popup (opened from inside the Update Ticket modal) sits on top of
  // it instead of hiding behind.
  // V2 (260518) — Overlay padding tightened (16px → 6px) and inner card
  // padding cut from 20px 22px → 12px 10px so the activity table can
  // use the full mobile viewport width. The right edge no longer shows
  // a wide blank gutter that read like an unused trailing column.
  var html='<div style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;z-index:2147483646;padding:6px;overflow:auto" onclick="if(event.target===this)_mttsCloseTicketDetail()">'+
    '<div style="background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);width:min(900px,98vw);max-height:calc(100vh - 12px);overflow:auto;padding:12px 10px;position:relative">'+
      // V7 (260520) — Share button alongside the ✕. Snapshots the
      // detail panel (excludes the buttons themselves since they sit
      // outside the mttsTicketDetailContent wrapper) and runs the
      // share-first flow: Web Share API → clipboard → new-tab fallback.
      '<button type="button" onclick="_mttsTicketDetailShare(this,\''+idEsc+'\')" aria-label="Share ticket details" title="Share ticket details" style="position:absolute;top:6px;right:34px;width:24px;height:24px;border:1.5px solid #a5b4fc;border-radius:50%;background:#eef2ff;color:#4338ca;cursor:pointer;line-height:1;box-shadow:0 1px 4px rgba(99,102,241,.25);display:flex;align-items:center;justify-content:center;z-index:1;padding:0">'+_MTTS_SHARE_ICON_SVG+'</button>'+
      '<button type="button" onclick="_mttsCloseTicketDetail()" aria-label="Close" title="Close (Esc)" style="position:absolute;top:8px;right:8px;width:20px;height:20px;border:none;border-radius:50%;background:#dc2626;color:#fff;font-size:12px;font-weight:900;cursor:pointer;line-height:1;box-shadow:0 1px 4px rgba(220,38,38,.4);display:flex;align-items:center;justify-content:center;z-index:1">✕</button>'+
      '<div id="mttsTicketDetailContent">'+
        '<div style="font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;padding-right:64px">🎫 Ticket Details</div>'+
        // V34 — Ticket-card replica with full chrome (plant-colour stripe,
        // status-tinted bg, owner corner-flag).
        '<div class="mtts-tcard" style="--plant-color:'+plantColor+';background:'+cardBg+approvedBorder+';position:relative;cursor:default" onclick="event.stopPropagation()">'+
          ownerFlagHtml+
          summary+
        '</div>'+
        rootStrip+
        costStrip+
        '<div style="margin-top:14px;font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Activity</div>'+
        '<div style="margin-top:6px">'+actHtml+'</div>'+
      '</div>'+
    '</div>'+
  '</div>';
  var ov=document.getElementById('mttsTicketDetailOverlay');
  // V39 — Reparent to <body> so no ancestor stacking context (e.g. the
  // .mtts-content / .page chain) caps the overlay's z-index when it's
  // opened on top of the Update Ticket modal.
  if(ov.parentNode!==document.body){
    try{ document.body.appendChild(ov); }catch(e){}
  }
  ov.innerHTML=html;ov.style.display='block';
  // V5 (260518) — Reverted the history-stack hook here too; the round-
  // trip was breaking the second open. Standard modals (om/cm path)
  // still support the OS back button.
  // Live-tick the breakdown timer inside the summary block.
  if(typeof _mttsStartLiveTimer==='function') _mttsStartLiveTimer();
  // V32 — Wire Escape-to-close, bound once and reused across opens.
  if(!_mttsTicketDetailEscBound){
    _mttsTicketDetailEscBound=true;
    document.addEventListener('keydown',function(ev){
      if(ev.key!=='Escape') return;
      var _ov=document.getElementById('mttsTicketDetailOverlay');
      if(_ov && _ov.style.display!=='none'){ ev.preventDefault(); _mttsCloseTicketDetail(); }
    });
  }
}
var _mttsTicketDetailEscBound=false;
function _mttsCloseTicketDetail(){
  var ov=document.getElementById('mttsTicketDetailOverlay');
  if(ov) ov.style.display='none';
  // V5 (260518) — Reverted history-stack hook. The push/back round-trip
  // was interfering with subsequent opens (second click failed to
  // re-show). The overlay stays independent of the back-button stack
  // for now; Esc + ✕ + outside-click still close it.
}

// V12 (260520) — Read-only popup that opens on left-click of an Asset
// Status pill. Shows the asset's current status (latest open ticket
// if any, otherwise "Healthy") + a structured asset details table.
// SA / users with edit permission get an "Edit Asset" button at the
// bottom; mobile users (where right-click isn't reliable) reach the
// edit modal through that button.
function _mttsAssetStatusInfo(id){
  var a=byId(DB.mttsAssets||[],id);
  if(!a){ notify('Asset not found',true); return; }
  // Latest open ticket on this asset, if any. "Open" excludes
  // closed/scrapped — repair_done stays here as "awaiting confirmation".
  var openTickets=(DB.mttsTickets||[]).filter(function(t){
    return t&&t.assetCode===id&&t.status!=='closed'&&t.status!=='scrapped';
  }).sort(function(p,q){return String(q.raisedAt||'').localeCompare(String(p.raisedAt||''));});
  var activeTicket=openTickets[0]||null;
  var statusClr, statusFg, statusLbl, statusSub;
  if(activeTicket){
    if(activeTicket.status==='repair_done'){
      statusClr='#f59e0b'; statusFg='#0f172a';
      statusLbl='⏸ Repair done — awaiting confirmation';
    } else if(activeTicket.status==='repair_done_challenged'){
      statusClr='#dc2626'; statusFg='#fff';
      statusLbl='⚠ Repair challenged';
    } else {
      statusClr='#dc2626'; statusFg='#fff';
      statusLbl='⚠ Active ticket — '+(activeTicket.status||'open');
    }
    statusSub=activeTicket.id||'';
  } else {
    statusClr='#16a34a'; statusFg='#fff';
    statusLbl='✓ Healthy — no open tickets';
    statusSub='';
  }
  var fullName=(typeof _mttsAssetComposedName==='function'?_mttsAssetComposedName(a):'')||a.id||'';
  var plantName=(typeof _mttsPlantLabel==='function'?(_mttsPlantLabel(a.plant)||a.plant):a.plant)||'—';
  var typeRec=(DB.mttsAssetTypes||[]).find(function(t){return t&&t.id===a.assetType;});
  var typeName=(typeRec&&typeRec.name)||a.assetType||'—';
  var fmtDate=function(d){ return d||'—'; };
  var rows=[
    ['Plant', plantName],
    ['Asset Type', typeName],
    ['Primary Name', a.primaryName||'—'],
    ['Name Extension', a.nameExtension||'—'],
    ['Make', a.make||'—'],
    ['Model', a.model||'—'],
    ['Serial No', a.serialNo||'—'],
    ['Install Date', fmtDate(a.installDate)],
    ['Criticality', a.criticality||'Medium'],
    ['Warranty Until', fmtDate(a.warranty&&a.warranty.until)],
    ['AMC Until', fmtDate(a.amc&&a.amc.until)],
    ['Lifecycle Status', a.status||'Active'],
    ['Description', a.description||'—']
  ];
  var esc=function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
  var rowsHtml=rows.map(function(r){
    return '<tr><td style="padding:5px 10px;font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #f1f5f9;white-space:nowrap;vertical-align:top">'+esc(r[0])+'</td>'+
      '<td style="padding:5px 10px;font-size:13px;font-weight:600;color:var(--text);border-bottom:1px solid #f1f5f9;word-break:break-word">'+esc(r[1])+'</td></tr>';
  }).join('');
  var idEsc=String(id).replace(/'/g,"\\'");
  var ticketIdEsc=activeTicket?String(activeTicket.id).replace(/'/g,"\\'"):'';
  var canEdit=(typeof _mttsHasAccess==='function')&&_mttsHasAccess('action.editAsset');
  var ov=document.getElementById('mttsAssetInfoOverlay');
  if(!ov){
    ov=document.createElement('div');
    ov.id='mttsAssetInfoOverlay';
    document.body.appendChild(ov);
  }
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;z-index:2147483647;padding:10px;overflow:auto';
  ov.innerHTML='<div style="background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);width:min(560px,98vw);max-height:calc(100vh - 20px);overflow:auto;padding:12px 14px;position:relative" onclick="event.stopPropagation()">'+
    '<button type="button" onclick="_mttsCloseAssetInfo()" aria-label="Close" title="Close (Esc)" style="position:absolute;top:8px;right:8px;width:22px;height:22px;border:none;border-radius:50%;background:#dc2626;color:#fff;font-size:13px;font-weight:900;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center">✕</button>'+
    '<div style="font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;padding-right:32px">🛠 Asset Status & Details</div>'+
    '<div style="font-size:16px;font-weight:900;color:var(--text);line-height:1.25;margin-bottom:10px;word-break:break-word;padding-right:32px">'+esc(fullName)+'</div>'+
    '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:'+statusClr+';color:'+statusFg+';margin-bottom:12px">'+
      '<div style="font-size:14px;font-weight:900;flex:1">'+statusLbl+(statusSub?'<div style="font-size:11px;font-weight:700;opacity:.92;font-family:var(--mono);margin-top:2px">'+esc(statusSub)+'</div>':'')+'</div>'+
      (activeTicket?'<button type="button" onclick="_mttsCloseAssetInfo();_mttsTicketDetail(\''+ticketIdEsc+'\')" style="font-size:11px;font-weight:800;padding:6px 10px;background:rgba(255,255,255,.18);border:1.5px solid rgba(255,255,255,.5);color:'+statusFg+';border-radius:6px;cursor:pointer;white-space:nowrap">🎫 View Ticket</button>':'')+
    '</div>'+
    '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">'+
      '<table style="width:100%;border-collapse:collapse">'+rowsHtml+'</table>'+
    '</div>'+
    (canEdit?'<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px"><button type="button" onclick="_mttsCloseAssetInfo();_mttsAssetOpen(\''+idEsc+'\')" style="font-size:13px;font-weight:800;padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer">✎ Edit Asset</button></div>':'')+
  '</div>';
  ov.onclick=function(e){ if(e.target===ov) _mttsCloseAssetInfo(); };
  var escH=function(ev){ if(ev.key==='Escape'){ ev.preventDefault(); _mttsCloseAssetInfo(); } };
  if(ov._escH){ try{ document.removeEventListener('keydown',ov._escH); }catch(_){} }
  ov._escH=escH;
  document.addEventListener('keydown',escH);
}
function _mttsCloseAssetInfo(){
  var ov=document.getElementById('mttsAssetInfoOverlay');
  if(!ov) return;
  if(ov._escH){ try{ document.removeEventListener('keydown',ov._escH); }catch(_){} ov._escH=null; }
  ov.remove();
}

// V7 (260520) — Share the entire ticket detail panel (card + cost /
// root-cause strips + activity timeline) as a PNG. If lazy-loaded
// photos haven't landed yet, await them and re-render the overlay
// so the snapshot includes the timeline thumbnails. Share-first
// flow: navigator.share with files → clipboard → new-tab fallback.
async function _mttsTicketDetailShare(btn, id){
  var t=(DB.mttsTickets||[]).find(function(x){return x&&x.id===id;});
  if(!t){ notify('Ticket not found',true); return; }
  if(typeof _mttsLoadTicketPhotos==='function' && !_mttsLoadedTicketPhotos[id]){
    btn.disabled=true; btn.innerHTML='⏳';
    try{ await _mttsLoadTicketPhotos(id); }catch(_){}
    try{ _mttsTicketDetail(id); }catch(_){}
    var ov2=document.getElementById('mttsTicketDetailOverlay');
    btn=ov2?ov2.querySelector('button[aria-label="Share ticket details"]'):null;
    if(!btn){ return; }
  }
  var origHtml=btn.innerHTML;
  btn.disabled=true; btn.innerHTML='⏳';
  try{
    var box=document.getElementById('mttsTicketDetailContent');
    if(!box){ notify('Nothing to share',true); return; }
    var ok=await _mttsLoadHtml2Canvas();
    if(!ok){ notify('⚠ Screenshot library failed to load — check internet',true); return; }
    var canvas=await html2canvas(box,{backgroundColor:'#ffffff',scale:2,useCORS:true,logging:false});
    var blob=await new Promise(function(res){ canvas.toBlob(res,'image/png'); });
    if(!blob){ notify('⚠ Could not encode image',true); return; }
    var fname='ticket-'+String(t.id||'detail').replace(/[^A-Za-z0-9_-]/g,'_')+'-details.png';
    var file=null;
    try{ file=new File([blob],fname,{type:'image/png'}); }catch(_){ file=null; }
    if(file && navigator.share && navigator.canShare && navigator.canShare({files:[file]})){
      try{
        await navigator.share({files:[file],title:'Ticket '+(t.id||'')+' details',text:'Ticket '+(t.id||'')+' details'});
        notify('📤 Shared');
        return;
      }catch(e){
        if(e && (e.name==='AbortError' || /abort/i.test(String(e.message||'')))) return;
        try{ console.warn('[mtts] share failed, falling back to clipboard',e); }catch(_){}
      }
    }
    if(navigator.clipboard && window.ClipboardItem){
      try{
        await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
        notify('📋 Sharing not supported here — copied to clipboard instead');
        return;
      }catch(e){ try{ console.warn('[mtts] clipboard fallback failed',e); }catch(_){} }
    }
    var url=URL.createObjectURL(blob);
    window.open(url,'_blank');
    notify('Sharing & clipboard unavailable — opened image in new tab',true);
  }catch(e){
    try{ console.warn('[mtts] share detail failed',e); }catch(_){}
    notify('⚠ Share failed: '+(e && e.message ? e.message : 'unknown'),true);
  }finally{
    if(btn){ btn.disabled=false; btn.innerHTML=origHtml; }
  }
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

  // V18 (260518) — Top summary counter strip removed per user request.
  // The same counts are visible inside each downstream section (HP
  // Asset cards, plant table, tickets table), so a separate header
  // strip was redundant.
  body.innerHTML=
    _mttsDashHpStatus(assets)+
    // V17 (260520) — Plant-wise Asset Status (calendar panel) replaced
    // with a single plant × criticality reliability table.
    _mttsDashReliabilityTable(assets)+
    _mttsDashTechLoad(tickets)+
    _mttsDashPlantTable(tickets)+
    _mttsDashTicketTable(tickets)+
    _mttsDashTrend(tickets,win)+
    _mttsDashCosts(tickets)+
    _mttsDashUpkeep(assets);
}

// V13 (260518) — Abbreviate an asset display name to its compact form
// for chip labels. Letter-only words contribute their initial (joined
// into a run when consecutive); digit-bearing tokens and ALL-CAPS
// acronyms pass through verbatim. Single-word names stay readable
// (initial alone would be too cryptic).
//   "Air compressor 50HP shot blasting" → "AC 50HP SB"
//   "CNC Laser"                         → "CNC L"
//   "Compressor"                        → "Compressor"
function _mttsShortAssetLabel(name){
  var n=String(name||'').trim();
  if(!n) return '';
  var tokens=n.split(/\s+/);
  // Filter out punctuation-only tokens like "-" or "/".
  tokens=tokens.filter(function(tk){return tk && /[A-Za-z0-9]/.test(tk);});
  if(!tokens.length) return n;
  if(tokens.length===1){
    var only=tokens[0];
    return only.length>12?only.slice(0,12)+'…':only;
  }
  var out=[];
  var initials='';
  var flush=function(){ if(initials){ out.push(initials); initials=''; } };
  tokens.forEach(function(tk){
    var hasDigit=/\d/.test(tk);
    var isAcronym=tk.length>1 && /[A-Za-z]/.test(tk) && tk===tk.toUpperCase();
    if(hasDigit||isAcronym){ flush(); out.push(tk); }
    else { initials+=(tk.charAt(0).toUpperCase()); }
  });
  flush();
  return out.join(' ')||n;
}

// V33 — Dashboard "HP Asset Status — <date>" panel. One row per plant;
// each row has a chip cluster of every High-priority asset showing its
// status for the SELECTED day. Tap a chip → ticket detail. Date picker
// at the top steps day-by-day; defaults to today. Plant filter from
// the dashboard widget still applies when set.
var _mttsDashHpDate='';// 'YYYY-MM-DD'; '' = today
function _mttsDashHpSetDate(v){_mttsDashHpDate=v||'';_mttsDashboardRender();}
// V8 (260520) — Per-plant criticality filter for the Asset Status panel.
// Each plant card has H/M/L buttons; clicking one swaps the chip grid
// to assets of that criticality at that plant. Default = 'High' for
// every plant (matches the prior HP-only behaviour on first render).
var _mttsDashAssetStatusPrio={};
function _mttsDashSetAssetStatusPrio(plant, prio){
  _mttsDashAssetStatusPrio[plant]=prio;
  _mttsDashboardRender();
}
function _mttsDashHpShiftDay(delta){
  var d=_mttsDashHpResolveDate();
  d.setDate(d.getDate()+delta);
  var pad=function(n){return String(n).padStart(2,'0');};
  _mttsDashHpDate=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  _mttsDashboardRender();
}
function _mttsDashHpResolveDate(){
  if(_mttsDashHpDate && /^\d{4}-\d{2}-\d{2}$/.test(_mttsDashHpDate)){
    var p=_mttsDashHpDate.split('-');
    return new Date(parseInt(p[0],10),parseInt(p[1],10)-1,parseInt(p[2],10));
  }
  var n=new Date();return new Date(n.getFullYear(),n.getMonth(),n.getDate());
}
function _mttsDashHpStatus(assets){
  var fPlant=(document.getElementById('mttsDashPlantFilter')||{}).value||'';
  var pad=function(n){return String(n).padStart(2,'0');};
  var sel=_mttsDashHpResolveDate();
  var dayStart=sel.getTime();
  var dayEnd=dayStart+86400000;
  var today=new Date();today.setHours(0,0,0,0);
  var isToday=(sel.getTime()===today.getTime());
  var isFuture=(sel.getTime()>today.getTime());
  var dateValue=sel.getFullYear()+'-'+pad(sel.getMonth()+1)+'-'+pad(sel.getDate());
  var _dateLblForTip=sel.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
  // V8 (260520) — Group ALL assets by plant (not just High). Per-plant
  // criticality selection is driven by _mttsDashAssetStatusPrio with a
  // 'High' default so the first render matches the prior HP-only view.
  var assetsByPlant={};
  (assets||[]).forEach(function(a){
    if(!a) return;
    if(fPlant&&a.plant!==fPlant) return;
    (assetsByPlant[a.plant]=assetsByPlant[a.plant]||[]).push(a);
  });
  Object.keys(assetsByPlant).forEach(function(p){
    assetsByPlant[p].sort(function(a,b){
      return String(_mttsAssetLabel(a)||a.id).localeCompare(String(_mttsAssetLabel(b)||b.id));
    });
  });
  var plantKeys=Object.keys(assetsByPlant).sort();
  // V8 (260520) — Open-ticket counts per (plant × criticality) for the
  // H/M/L button badges. "Open" = anything not closed/scrapped.
  var openByPlantPrio={};
  (DB.mttsTickets||[]).forEach(function(t){
    if(!t||t.status==='closed'||t.status==='scrapped') return;
    if(fPlant&&t.plant!==fPlant) return;
    var a=(DB.mttsAssets||[]).find(function(x){return x&&x.id===t.assetCode;});
    if(!a) return;
    var k=a.plant+'|'+(a.criticality||'Medium');
    openByPlantPrio[k]=(openByPlantPrio[k]||0)+1;
  });
  // V36 — Date picker inline with the panel title (in the card header).
  // Picker width is content-driven, no min-width floor.
  var picker='<div style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">'+
    '<button type="button" onclick="_mttsDashHpShiftDay(-1)" title="Previous day" style="width:30px;height:30px;border:1.5px solid var(--border);background:#fff;border-radius:6px;font-size:15px;font-weight:800;cursor:pointer;color:var(--text);padding:0">‹</button>'+
    '<input type="date" value="'+dateValue+'" max="'+(today.getFullYear()+'-'+pad(today.getMonth()+1)+'-'+pad(today.getDate()))+'" onchange="_mttsDashHpSetDate(this.value)" title="'+_dateLblForTip+'" style="font-size:13px;padding:5px 8px;border:1.5px solid var(--accent);border-radius:6px;background:#fff;color:#0f172a;font-family:var(--mono);font-weight:800;width:auto;letter-spacing:.3px">'+
    '<button type="button" onclick="_mttsDashHpShiftDay(1)" title="Next day" '+(isToday?'disabled':'')+' style="width:30px;height:30px;border:1.5px solid var(--border);background:#fff;border-radius:6px;font-size:15px;font-weight:800;cursor:'+(isToday?'not-allowed;opacity:.35':'pointer')+';color:var(--text);padding:0">›</button>'+
    (!isToday?'<button type="button" onclick="_mttsDashHpSetDate(\'\')" style="font-size:11px;padding:5px 8px;border:1.5px solid var(--border);background:#fff;border-radius:6px;cursor:pointer;color:var(--text2);font-weight:800">↩ Today</button>':'')+
  '</div>';
  // V36 — Custom card frame so the date picker can sit BESIDE the
  // title in the card header (rather than below it as a separate row).
  // V35 (260518) — Side padding stripped down so the plant cards
  // inside this panel get the full viewport width. Top/bottom kept
  // for breathing room with the header + the dashboard above/below.
  var _mkCard=function(inner){
    return '<div class="card" style="margin-bottom:12px;padding:12px 4px 8px">'+
      '<div class="card-header" style="border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:0 6px 8px">'+
        '<div class="card-title">Asset Status</div>'+
        picker+
      '</div>'+
      '<div style="padding:6px 4px 4px">'+inner+'</div>'+
    '</div>';
  };
  if(!plantKeys.length){
    return _mkCard('<div style="padding:18px;color:var(--text3);font-size:12px;text-align:center">No assets configured'+(fPlant?' for the selected plant':'')+'.</div>');
  }
  var legend='<div style="display:flex;align-items:center;gap:14px;font-size:10px;color:var(--text2);padding:0 2px 8px">'+
    '<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:12px;height:12px;border-radius:50%;background:#f87171;border:1px solid rgba(0,0,0,.15)"></span>Active ticket</span>'+
    '<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:12px;height:12px;border-radius:50%;background:#f59e0b;border:1px solid rgba(0,0,0,.15)"></span>Repair done — awaiting</span>'+
    '<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:12px;height:12px;border-radius:50%;background:#4ade80;border:1px solid rgba(0,0,0,.15)"></span>Healthy</span>'+
    (isFuture?'<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:12px;height:12px;border-radius:50%;background:#e2e8f0;border:1px solid rgba(0,0,0,.15)"></span>Future</span>':'')+
  '</div>';
  // Per-asset status for the selected day. Walks the asset's tickets.
  var fmtHM=function(ms){
    if(!ms||ms<0) ms=0;
    var mins=Math.floor(ms/60000),hrs=Math.floor(mins/60);
    return hrs+'h '+(mins%60)+'m';
  };
  var statusForDay=function(aid){
    if(isFuture) return {clr:'#e2e8f0',sev:0,ticket:null};
    var tArr=(DB.mttsTickets||[]).filter(function(t){return t&&t.assetCode===aid;});
    var R=null, Y=null;
    for(var i=0;i<tArr.length;i++){
      var t=tArr[i];
      var raised=t.raisedAt?new Date(t.raisedAt).getTime():0;
      if(raised>=dayEnd) continue;
      var end=_mttsDowntimeEnd(t);
      var endMs=end?new Date(end).getTime():Date.now();
      if(endMs<dayStart) continue;
      var s=t.status;
      if(s==='repair_done') Y=Y||t;
      else if(s!=='closed' && s!=='scrapped') R=R||t;
    }
    // V21 (260518) — Active-ticket red softened from #dc2626 → #f87171
    // so the block is less aggressive on the eye while still reading
    // as "red". White chip text stays legible against this tone.
    if(R) return {clr:'#f87171',sev:2,ticket:R};
    if(Y) return {clr:'#f59e0b',sev:1,ticket:Y};
    // V22 (260518) — Healthy green softened from #16a34a → #4ade80 to
    // match the lighter red and yellow tones in the same panel.
    return {clr:'#4ade80',sev:0,ticket:null};
  };
  // Per-plant downtime for the day (HP-asset sum, clipped).
  var assetDtForDay=function(aid){
    var tot=0;
    (DB.mttsTickets||[]).forEach(function(t){
      if(!t||t.assetCode!==aid) return;
      var start=t.breakdownSince?new Date(t.breakdownSince).getTime():new Date(t.raisedAt||0).getTime();
      var end=_mttsDowntimeEnd(t);
      var endMs=end?new Date(end).getTime():Date.now();
      var clipS=Math.max(dayStart,start);
      var clipE=Math.min(dayEnd,endMs);
      if(clipE>clipS) tot+=(clipE-clipS);
    });
    return tot;
  };
  // V9 (260520) — 30-day day-by-day downtime + status bars for the
  // selected day's strip. bars[0] = oldest day, bars[29] = selected
  // day; each bar is `true` if any downtime fell on that day.
  // `total` is the sum of downtime ms across the 30-day window. The
  // window ends on the selected day so navigating the date picker
  // shifts the strip with it.
  var MS_DAY=86400000;
  var assetThirtyDay=function(aid){
    var bars=new Array(30);
    var total=0;
    var startCutoff=dayStart-29*MS_DAY;
    var perTicket=(DB.mttsTickets||[]).filter(function(t){return t&&t.assetCode===aid;});
    for(var i=29;i>=0;i--){
      var dS=dayStart-i*MS_DAY;
      var dE=dS+MS_DAY;
      var dt=0;
      for(var j=0;j<perTicket.length;j++){
        var t=perTicket[j];
        var start=t.breakdownSince?new Date(t.breakdownSince).getTime():new Date(t.raisedAt||0).getTime();
        var end=_mttsDowntimeEnd(t);
        var endMs=end?new Date(end).getTime():Date.now();
        if(endMs<dS||start>=dE) continue;
        var clipS=Math.max(dS,start);
        var clipE=Math.min(dE,endMs);
        if(clipE>clipS) dt+=(clipE-clipS);
      }
      bars[29-i]=(dt>0);
      total+=dt;
    }
    return {bars:bars,total:total};
  };
  // V14 (260520) — Per-plant reliability stats over the 30-day window
  // ending on the selected day. Numerator/denominator follow standard
  // reliability definitions:
  //   • Downtime  = Σ clipped downtime across this plant's assets
  //                 (at the selected criticality) in the window.
  //   • Failures  = count of tickets raised in the window for these
  //                 assets (one ticket = one failure event).
  //   • Available = assetCount × 30 days  (total possible run-time).
  //   • Uptime%   = (Available − Downtime) / Available × 100.
  //   • MTTR      = Downtime / Failures   (mean time to repair).
  //   • MTBF      = (Available − Downtime) / Failures  (mean time
  //                 between failures, using operational time as the
  //                 numerator). Returns '—' when failures = 0.
  var WINDOW_MS=30*MS_DAY;
  var winStart=dayStart-29*MS_DAY;
  var winEnd=dayEnd;
  var plantStats=function(plantAssets){
    var dt=0, failures=0;
    var ids={};
    plantAssets.forEach(function(a){ if(a&&a.id) ids[a.id]=1; });
    (DB.mttsTickets||[]).forEach(function(t){
      if(!t||!ids[t.assetCode]) return;
      var raisedMs=t.raisedAt?new Date(t.raisedAt).getTime():0;
      if(raisedMs>=winStart&&raisedMs<winEnd) failures++;
      var start=t.breakdownSince?new Date(t.breakdownSince).getTime():raisedMs;
      var end=_mttsDowntimeEnd(t);
      var endMs=end?new Date(end).getTime():Date.now();
      if(endMs<winStart||start>=winEnd) return;
      var clipS=Math.max(winStart,start);
      var clipE=Math.min(winEnd,endMs);
      if(clipE>clipS) dt+=(clipE-clipS);
    });
    var available=plantAssets.length*WINDOW_MS;
    var uptimeMs=Math.max(0, available-dt);
    var uptimePct=available>0?(uptimeMs/available)*100:100;
    return {
      downtimeMs:dt,
      failures:failures,
      uptimePct:uptimePct,
      mttrMs:failures>0?(dt/failures):null,
      mtbfMs:failures>0?(uptimeMs/failures):null
    };
  };
  // Day+hour formatter for MTBF (can run into days). Falls back to
  // hrs+mins for sub-day durations.
  var fmtHMD=function(ms){
    if(ms==null) return '—';
    if(ms<=0) return '0h';
    var mins=Math.floor(ms/60000);
    var hrs=Math.floor(mins/60);
    var days=Math.floor(hrs/24);
    if(days>=1) return days+'d '+(hrs%24)+'h';
    return hrs+'h '+(mins%60)+'m';
  };
  // V12 (260518) — Each plant rendered as a self-contained card so
  // multiple plants seat side by side on wide screens (auto-fill grid,
  // 280px min track). On narrow viewports the grid collapses to a
  // single column so each plant card still gets a full row.
  // V8 (260520) — Color map matches existing criticality semantics
  // (red=High, amber=Medium, green=Low). Used by the H/M/L button row.
  var _prioClr={High:'#dc2626',Medium:'#f59e0b',Low:'#16a34a'};
  var _prioLbl={High:'H',Medium:'M',Low:'L'};
  var _prioOrder=['High','Medium','Low'];
  var laneCards=plantKeys.map(function(plant){
    // V8 (260520) — Per-plant selected criticality (default High).
    // Plant's assets are filtered to the selected criticality for
    // the chip grid + downtime totals; the H/M/L buttons show open-
    // ticket counts for every criticality so the user can see what's
    // available before switching.
    var selPrio=_mttsDashAssetStatusPrio[plant]||'High';
    var arr=(assetsByPlant[plant]||[]).filter(function(a){return (a.criticality||'Medium')===selPrio;});
    var plantEsc=String(plant).replace(/'/g,"\\'");
    var prioBtnsHtml=_prioOrder.map(function(pp){
      var cnt=openByPlantPrio[plant+'|'+pp]||0;
      var active=(pp===selPrio);
      var bg=active?_prioClr[pp]:'#fff';
      var fg=active?'#fff':'#0f172a';
      var bd=active?_prioClr[pp]:'var(--border)';
      var badgeBg=active?'rgba(255,255,255,.28)':_prioClr[pp];
      // V13 (260520) — H/M/L button + badge fonts bumped +2 px per request.
      return '<button type="button" onclick="event.stopPropagation();_mttsDashSetAssetStatusPrio(\''+plantEsc+'\',\''+pp+'\')" title="'+pp+' · '+cnt+' open ticket'+(cnt===1?'':'s')+'" style="display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border:1.5px solid '+bd+';background:'+bg+';color:'+fg+';font-size:13px;font-weight:800;border-radius:6px;cursor:pointer;line-height:1">'+_prioLbl[pp]+'<span style="background:'+badgeBg+';color:#fff;font-size:12px;font-weight:900;padding:1px 6px;border-radius:8px;min-width:16px;text-align:center;line-height:1.3">'+cnt+'</span></button>';
    }).join('');
    var statuses=arr.map(function(a){return {a:a,st:statusForDay(a.id)};});
    // V15 (260518) — Sort alphabetically by asset name (irrespective of
    // status) so the layout is stable day-to-day.
    statuses.sort(function(x,y){
      var na=String(x.a&&x.a.dashboardName||_mttsAssetComposedName(x.a)||x.a.id||'');
      var nb=String(y.a&&y.a.dashboardName||_mttsAssetComposedName(y.a)||y.a.id||'');
      return na.localeCompare(nb);
    });
    var nDown=statuses.filter(function(x){return x.st.sev>=1;}).length;
    var dtMs=arr.reduce(function(s,a){return s+assetDtForDay(a.id);},0);
    // V14 (260520) — 30-day reliability stats for the plant footer.
    var pStats=plantStats(arr);
    var chips=statuses.map(function(x){
      // V15 (260518) — Short name uses ONLY primary name + extension
      // (no make/model/serial appended). Equal-size square blocks per
      // asset so the cluster reads as a uniform grid.
      // V26 (260518) — Dashboard Asset Name is the short form itself
      // (auto-filled with initials, user-overridable). Use it verbatim;
      // tooltip carries the full composed name. Only fall back to the
      // composed-name abbreviation when DA Name is missing (legacy).
      var fullName=_mttsAssetComposedName(x.a) || x.a.id;
      var dash=String(x.a&&x.a.dashboardName||'').trim();
      var short=dash || _mttsShortAssetLabel(fullName);
      var name=fullName;
      var nameEsc=String(name).replace(/"/g,'&quot;');
      var statusLbl=x.st.sev===2?'Active ticket':x.st.sev===1?'Repair done — awaiting':isFuture?'Future':'Healthy';
      var tip=name+' · '+statusLbl+(x.st.ticket?' · '+x.st.ticket.id:'');
      // V12 (260520) — Click behaviour split:
      //   • Left-click  → _mttsAssetStatusInfo (asset's current status
      //                   + full details in a read-only popup, with a
      //                   "View Ticket" shortcut when a ticket is open
      //                   and an "Edit" button for users with edit
      //                   permission).
      //   • Right-click (contextmenu) → _mttsAssetOpen (the edit form,
      //                   same modal that was previously the left-click
      //                   target on green/yellow chips).
      // The popup is the only affordance for mobile users (long-press
      // contextmenu is unreliable on touch); the popup's Edit button
      // covers them.
      var assetIdEsc=String(x.a.id||'').replace(/'/g,"\\'");
      var click=' onclick="event.stopPropagation();_mttsAssetStatusInfo(\''+assetIdEsc+'\')"'+
        ' oncontextmenu="event.stopPropagation();event.preventDefault();_mttsAssetOpen(\''+assetIdEsc+'\');return false;"';
      // V22 (260518) — Healthy bg lightened to #4ade80 — switch text
      // to dark slate so the short label stays legible (white on the
      // lighter green is borderline).
      var fg='#fff';
      if(x.st.sev===0 && !isFuture) fg='#0f172a';
      else if(x.st.sev===1) fg='#0f172a';
      else if(isFuture) fg='#475569';
      // V9 (260520) — Enlarged chip (5-col grid; aspect-ratio:1/1 so it
      // scales with the plant card width, ~80% larger than the prior
      // 62×62 on a typical desktop plant card). Three vertical bands:
      // asset short name, 30-day day-by-day status strip (red = had
      // downtime, green = healthy), and 30-day total downtime.
      var info=assetThirtyDay(x.a.id);
      var barCells=info.bars.map(function(hasDt){
        return '<span style="background:'+(hasDt?'#dc2626':'#16a34a')+';border-radius:1px;display:block"></span>';
      }).join('');
      var thirtyDtLbl=fmtHM(info.total);
      var thirtyTipDt=info.total>0?(' · 30d DT '+thirtyDtLbl):' · 30d clean';
      return '<div class="mtts-hp-chip" data-mtts-tip="'+nameEsc+' · '+statusLbl+thirtyTipDt+'" title="'+(tip+thirtyTipDt).replace(/"/g,'&quot;')+'" '+click+' style="aspect-ratio:1/1;display:flex;flex-direction:column;justify-content:space-between;padding:6px 5px;border-radius:8px;background:'+x.st.clr+';color:'+fg+';font-size:12px;font-weight:800;letter-spacing:.1px;border:1.5px solid rgba(0,0,0,.15);cursor:pointer;line-height:1.15;text-align:center;overflow:hidden;box-sizing:border-box;gap:3px;min-width:0">'+
        '<div style="font-size:12px;line-height:1.15;font-weight:800;word-break:break-word;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;flex:0 0 auto">'+short+'</div>'+
        // V12 (260520) — 30 status bars now span THREE rows of 10
        // (older 10 days on the top row, most-recent 10 on the bottom).
        // Downtime total font bumped 11 → 13 px per user request.
        '<div style="font-size:13px;font-weight:800;font-family:var(--mono);line-height:1;opacity:.95;flex:0 0 auto" title="30-day downtime total">'+thirtyDtLbl+'</div>'+
        '<div title="Last 30 days · daily status (oldest top-left → newest bottom-right)" style="display:grid;grid-template-columns:repeat(10,minmax(0,1fr));grid-template-rows:repeat(3,1fr);gap:1px;height:24px;flex:0 0 auto">'+barCells+'</div>'+
      '</div>';
    }).join('');
    var plantNm=_mttsPlantLabel(plant)||plant;
    var plantBg=_mttsPlantColor(plant)||'#94a3b8';
    var plantFg=(typeof _mttsBgToFg==='function')?_mttsBgToFg(plantBg):'#0f172a';
    // V36 (260518) — Plant header simplified to a single full-width
    // pill that uses the plant's color as its background. Short-form
    // badge dropped to declutter; the down/total count sits on the
    // right inside the same pill.
    // V8 (260520) — chipsRow handles the empty case (no assets at the
    // selected criticality) so the panel doesn't look broken; the H/M/L
    // buttons remain visible so the user can switch.
    var chipsRow=chips
      ?chips
      :'<span style="font-size:11px;color:var(--text3);font-style:italic">No '+selPrio.toLowerCase()+'-criticality assets at this plant.</span>';
    // V15 (260520) — Reliability stats row sits below the plant header.
    // V16 (260520) — Made prominent: each stat is its own light-slate
    // tile with a thick top accent stripe in the metric's colour, an
    // uppercase label, and the value at 18 px mono. Tile background +
    // colour-coded value make them stand out as the panel's headline
    // numbers.
    var statsRow=(function(){
      var up=pStats.uptimePct;
      var upClr=up>=95?'#16a34a':up>=90?'#f59e0b':'#dc2626';
      var dtClr=pStats.downtimeMs>0?'#dc2626':'#16a34a';
      var mkStat=function(lbl,val,clr,tip){
        return '<div title="'+tip+'" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-width:0;padding:8px 6px;background:#f8fafc;border:1px solid var(--border);border-top:3px solid '+(clr||'#94a3b8')+';border-radius:8px">'+
          '<div style="font-size:10px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;line-height:1">'+lbl+'</div>'+
          '<div style="font-family:var(--mono);font-weight:900;font-size:18px;color:'+(clr||'#0f172a')+';line-height:1.05;white-space:nowrap">'+val+'</div>'+
        '</div>';
      };
      return '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;padding-bottom:2px">'+
        mkStat('Uptime', up.toFixed(1)+'%', upClr, 'Uptime % over the last 30 days = (available − downtime) / available')+
        mkStat('MTTR', pStats.mttrMs==null?'—':fmtHM(pStats.mttrMs), '#0ea5e9', 'Mean Time To Repair = total downtime / number of failures (last 30 days)')+
        mkStat('MTBF', pStats.mtbfMs==null?'—':fmtHMD(pStats.mtbfMs), '#8b5cf6', 'Mean Time Between Failures = operational time / number of failures (last 30 days)')+
        mkStat('Downtime', fmtHM(pStats.downtimeMs), dtClr, 'Total downtime in the last 30 days for shown assets')+
      '</div>';
    })();
    return '<div style="border:1.5px solid var(--border);border-radius:10px;padding:8px 10px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.04);display:flex;flex-direction:column;gap:6px;min-width:0">'+
      // V13 (260520) — Plant pill + H/M/L buttons now share a single
      // horizontal row. Pill grows to fill, buttons sit to its right;
      // on narrow widths the buttons wrap below via flex-wrap.
      // Plant-name + count fonts bumped +2 px per request.
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0">'+
        '<div style="display:flex;align-items:center;gap:8px;padding:4px 10px;border-radius:6px;background:'+plantBg+';color:'+plantFg+';min-width:0;flex:1 1 220px">'+
          '<span style="font-size:15px;font-weight:900;letter-spacing:.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0" title="'+plantNm.replace(/"/g,'&quot;')+'">'+plantNm+'</span>'+
          '<span style="flex:0 0 auto;font-size:13px;font-weight:800"><b style="font-size:15px">'+nDown+'</b>/'+arr.length+'</span>'+
        '</div>'+
        '<div style="display:flex;align-items:center;gap:5px;flex:0 0 auto">'+prioBtnsHtml+'</div>'+
      '</div>'+
      // V15 (260520) — Stats row immediately under the header.
      statsRow+
      // V9 (260520) — 5-column responsive grid for the asset chips. Chip
      // size scales with the plant card width (aspect-ratio:1/1); the
      // outer plant grid widens to ensure desktop chips are ~80% bigger
      // than the prior 62×62. Empty-priority fallback uses a flex row
      // so the italic placeholder doesn't get squeezed into 1 of 5 cols.
      (chips
        ?'<div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;min-height:24px">'+chipsRow+'</div>'
        :'<div style="display:flex;align-items:center;min-height:24px">'+chipsRow+'</div>')+
    '</div>';
  }).join('');
  // V9 (260520) — Plant grid widened (280px → 560px min track) so the
  // enlarged 5-chip row inside each plant card has room to breathe.
  // `min(560px,100%)` clamps to the viewport width on narrow mobile.
  var lanes='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(560px,100%),1fr));gap:8px">'+laneCards+'</div>';
  // V8 (260520) — Total DT for the day across each plant's currently-
  // selected criticality. With per-plant priority selection, this is a
  // mixed-criticality total — relabelled accordingly below.
  var totalDt=0;
  plantKeys.forEach(function(p){
    var pSel=_mttsDashAssetStatusPrio[p]||'High';
    (assetsByPlant[p]||[]).filter(function(a){return (a.criticality||'Medium')===pSel;}).forEach(function(a){
      totalDt+=assetDtForDay(a.id);
    });
  });
  var totalLine='<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:var(--text2)">'+
    '<span style="margin-left:auto;font-weight:800">Total DT for day (shown assets):</span>'+
    '<span style="font-family:var(--mono);font-weight:900;font-size:14px;color:'+(totalDt>0?'#dc2626':'#16a34a')+'">'+fmtHM(totalDt)+'</span>'+
  '</div>';
  return _mkCard(legend+lanes+totalLine);
}

// V17 (260520) — Plant × Criticality reliability table.
// Replaces the prior calendar-style "Plant-wise Asset Status" panel.
// One row per (plant, criticality) bucket that has any asset; columns
// are the four reliability KPIs over a rolling 30-day window ending
// today: Uptime%, MTTR, MTBF, Downtime, plus a failure count.
function _mttsDashReliabilityTable(assets){
  var fPlant=(document.getElementById('mttsDashPlantFilter')||{}).value||'';
  var MS_DAY=86400000;
  var WIN_DAYS=30;
  var today=new Date(); today.setHours(0,0,0,0);
  var winEnd=today.getTime()+MS_DAY; // end of today (exclusive)
  var winStart=winEnd-WIN_DAYS*MS_DAY;
  var fmtHM=function(ms){
    if(ms==null) return '—';
    if(!ms||ms<0) ms=0;
    var mins=Math.floor(ms/60000),hrs=Math.floor(mins/60);
    return hrs+'h '+(mins%60)+'m';
  };
  var fmtHMD=function(ms){
    if(ms==null) return '—';
    if(ms<=0) return '0h';
    var mins=Math.floor(ms/60000),hrs=Math.floor(mins/60),days=Math.floor(hrs/24);
    if(days>=1) return days+'d '+(hrs%24)+'h';
    return hrs+'h '+(mins%60)+'m';
  };
  // Group assets into plant × criticality buckets.
  var groups={};
  (assets||[]).forEach(function(a){
    if(!a) return;
    if(fPlant&&a.plant!==fPlant) return;
    var c=a.criticality||'Medium';
    var k=(a.plant||'')+'|'+c;
    if(!groups[k]) groups[k]={plantId:a.plant||'',crit:c,assets:[]};
    groups[k].assets.push(a);
  });
  // Compute stats per bucket (30-day window).
  var rows=Object.keys(groups).map(function(k){
    var g=groups[k];
    var ids={};
    g.assets.forEach(function(a){ if(a&&a.id) ids[a.id]=1; });
    var dt=0,failures=0;
    (DB.mttsTickets||[]).forEach(function(t){
      if(!t||!ids[t.assetCode]) return;
      var raisedMs=t.raisedAt?new Date(t.raisedAt).getTime():0;
      if(raisedMs>=winStart&&raisedMs<winEnd) failures++;
      var start=t.breakdownSince?new Date(t.breakdownSince).getTime():raisedMs;
      var end=_mttsDowntimeEnd(t);
      var endMs=end?new Date(end).getTime():Date.now();
      if(endMs<winStart||start>=winEnd) return;
      var clipS=Math.max(winStart,start);
      var clipE=Math.min(winEnd,endMs);
      if(clipE>clipS) dt+=(clipE-clipS);
    });
    var available=g.assets.length*WIN_DAYS*MS_DAY;
    var uptimeMs=Math.max(0,available-dt);
    var uptimePct=available>0?(uptimeMs/available)*100:100;
    return {
      plantId:g.plantId,
      plantName:_mttsPlantLabel(g.plantId)||g.plantId||'—',
      plantColor:_mttsPlantColor(g.plantId)||'#94a3b8',
      crit:g.crit,
      assetCount:g.assets.length,
      downtimeMs:dt,
      failures:failures,
      uptimePct:uptimePct,
      mttrMs:failures>0?(dt/failures):null,
      mtbfMs:failures>0?(uptimeMs/failures):null
    };
  });
  var critOrder={High:1,Medium:2,Low:3};
  rows.sort(function(a,b){
    var p=String(a.plantName).localeCompare(String(b.plantName));
    if(p) return p;
    return (critOrder[a.crit]||9)-(critOrder[b.crit]||9);
  });
  if(!rows.length){
    return _mttsDashCard('Asset Reliability — last 30 days',
      '<div style="padding:18px;color:var(--text3);font-size:12px;text-align:center">No assets configured'+(fPlant?' for the selected plant':'')+'.</div>');
  }
  var critPill={High:'#dc2626',Medium:'#f59e0b',Low:'#16a34a'};
  var critLbl={High:'H',Medium:'M',Low:'L'};
  var th='padding:8px 10px;font-size:11px;font-weight:800;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;background:var(--surface2);border-bottom:1.5px solid var(--border);text-align:left';
  var thR='padding:8px 10px;font-size:11px;font-weight:800;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;background:var(--surface2);border-bottom:1.5px solid var(--border);text-align:right';
  var td='padding:7px 10px;font-size:13px;border-bottom:1px solid #f1f5f9;vertical-align:middle';
  var tdR='padding:7px 10px;font-size:13px;border-bottom:1px solid #f1f5f9;vertical-align:middle;text-align:right;font-family:var(--mono);font-weight:800;white-space:nowrap';
  var bodyHtml=rows.map(function(r){
    var upClr=r.uptimePct>=95?'#16a34a':r.uptimePct>=90?'#f59e0b':'#dc2626';
    var dtClr=r.downtimeMs>0?'#dc2626':'#16a34a';
    var critBg=critPill[r.crit]||'#94a3b8';
    return '<tr>'+
      '<td style="'+td+';white-space:nowrap">'+
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+r.plantColor+';margin-right:6px;vertical-align:middle"></span>'+
        '<span style="font-weight:700;color:var(--text)">'+String(r.plantName).replace(/</g,'&lt;')+'</span>'+
      '</td>'+
      '<td style="'+td+';text-align:center;width:60px"><span style="display:inline-block;background:'+critBg+';color:#fff;font-weight:900;font-size:12px;padding:2px 9px;border-radius:5px;letter-spacing:.5px">'+critLbl[r.crit]+'</span></td>'+
      '<td style="'+tdR+';color:var(--text2);font-weight:700">'+r.assetCount+'</td>'+
      '<td style="'+tdR+';color:'+upClr+'">'+r.uptimePct.toFixed(1)+'%</td>'+
      '<td style="'+tdR+';color:#0ea5e9">'+fmtHM(r.mttrMs)+'</td>'+
      '<td style="'+tdR+';color:#8b5cf6">'+fmtHMD(r.mtbfMs)+'</td>'+
      '<td style="'+tdR+';color:'+dtClr+'">'+fmtHM(r.downtimeMs)+'</td>'+
      '<td style="'+tdR+';color:var(--text2)">'+r.failures+'</td>'+
    '</tr>';
  }).join('');
  var tableHtml='<div style="overflow:auto;border:1px solid var(--border);border-radius:8px">'+
    '<table style="width:100%;border-collapse:collapse;background:#fff">'+
      '<thead><tr>'+
        '<th style="'+th+'">Plant</th>'+
        '<th style="'+th+';text-align:center">Crit</th>'+
        '<th style="'+thR+'">Assets</th>'+
        '<th style="'+thR+'" title="Uptime % = (available − downtime) / available">Uptime</th>'+
        '<th style="'+thR+'" title="Mean Time To Repair = total downtime / failures">MTTR</th>'+
        '<th style="'+thR+'" title="Mean Time Between Failures = operational time / failures">MTBF</th>'+
        '<th style="'+thR+'">Downtime</th>'+
        '<th style="'+thR+'" title="Failures = tickets raised in the last 30 days">Fails</th>'+
      '</tr></thead>'+
      '<tbody>'+bodyHtml+'</tbody>'+
    '</table>'+
  '</div>';
  return _mttsDashCard('Asset Reliability — last 30 days', tableHtml);
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
  // V12 (260518) — Summary tiles shrunk ~50%: padding halved, value
  // font 24→14, label font 11→9, min-width 140→90, border-left 4→3.
  // Priority strip tightened in proportion.
  var tile=function(lbl,val,clr,bg){
    return '<div style="flex:1;min-width:90px;padding:6px 9px;background:'+bg+';border:1px solid '+clr+'33;border-left:3px solid '+clr+';border-radius:6px">'+
      '<div style="font-size:9px;font-weight:800;color:'+clr+';text-transform:uppercase;letter-spacing:.4px">'+lbl+'</div>'+
      '<div style="font-size:14px;font-weight:900;color:var(--text);margin-top:1px;line-height:1.1">'+val+'</div></div>';
  };
  var priTile='<div style="flex:1;min-width:160px;padding:5px 9px;background:#fff;border:1px solid var(--border);border-radius:6px">'+
    '<div style="font-size:9px;font-weight:800;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px">Active by Priority</div>'+
    '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">'+
      '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:6px;background:#fef2f2;border:1px solid #fecaca"><span style="font-size:8px;font-weight:800;color:#dc2626;text-transform:uppercase;letter-spacing:.4px">High</span><b style="font-size:11px;color:#7f1d1d">'+pri.High+'</b></span>'+
      '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:6px;background:#fffbeb;border:1px solid #fde68a"><span style="font-size:8px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:.4px">Medium</span><b style="font-size:11px;color:#78350f">'+pri.Medium+'</b></span>'+
      '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:6px;background:#f0fdf4;border:1px solid #bbf7d0"><span style="font-size:8px;font-weight:800;color:#16a34a;text-transform:uppercase;letter-spacing:.4px">Low</span><b style="font-size:11px;color:#14532d">'+pri.Low+'</b></span>'+
      (pri.Unset?'<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:6px;background:#f8fafc;border:1px solid var(--border)"><span style="font-size:8px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.4px">Unset</span><b style="font-size:11px;color:var(--text2)">'+pri.Unset+'</b></span>':'')+
    '</div>'+
  '</div>';
  return '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">'+
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
    var assetName=_mttsAssetLabel(asset,t.assetCode||'(missing)');
    var raised=_mttsFmtISTDateTime(t.raisedAt);
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
    var assetName=_mttsAssetLabel(asset,t.assetCode||'(missing)');
    var raised=_mttsFmtISTDate(t.raisedAt);
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
    if(!byItem[iK]) byItem[iK]={cost:0,n:0,name:_mttsAssetLabel(asset),plant:t.plant};
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
  // V18 (260520) — Upkeep alerts now cover PM in addition to Warranty
  // and AMC. A "due" PM is one whose nextDueAt is ≤ today+30d;
  // "overdue" when the date has already passed. Skipped assets:
  // status='Scrap' OR pmApplicable=false (for the PM rows).
  var todayStr=_mttsTodayStr();
  var _in30Ist=_mttsNowIST();_in30Ist.setUTCDate(_in30Ist.getUTCDate()+30);
  var _in30Pad=function(n){return n<10?'0'+n:''+n;};
  var in30Str=_in30Ist.getUTCFullYear()+'-'+_in30Pad(_in30Ist.getUTCMonth()+1)+'-'+_in30Pad(_in30Ist.getUTCDate());
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
    // V18 (260520) — Preventive Maintenance.
    if(a.pmApplicable && a.pmSchedule && a.pmSchedule.nextDueAt){
      var pm=a.pmSchedule.nextDueAt;
      var pmState=null;
      if(pm<todayStr) pmState='overdue';
      else if(pm<=in30Str) pmState='due';
      if(pmState) rows.push({asset:a,kind:'PM',due:pm,state:pmState,freq:a.pmSchedule.frequency||''});
    }
  });
  if(!rows.length) return _mttsDashCard('Upkeep alerts (PM / Warranty / AMC)','<div style="padding:18px;color:var(--text3);font-size:12px;text-align:center">No PM / warranty / AMC items due or overdue. ✅</div>');
  rows.sort(function(a,b){
    // PM overdue first, then expired/overdue of other kinds, then due-soon.
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
  var kindIcon={Warranty:'🛡',AMC:'📋',PM:'🔧'};
  var html=
    '<div style="overflow:auto;max-height:340px"><table style="width:100%;border-collapse:collapse"><thead><tr>'+
      '<th style="'+th+'">Asset</th>'+
      '<th style="'+th+'">Plant</th>'+
      '<th style="'+th+'">Kind</th>'+
      '<th style="'+th+'">Due</th>'+
      '<th style="'+th+'">State</th>'+
    '</tr></thead><tbody>'+
    rows.map(function(r){
      var idEsc=String(r.asset.id||'').replace(/'/g,"\\'");
      var kindCell=(kindIcon[r.kind]||'')+' '+r.kind+(r.kind==='PM'&&r.freq?(' <span style="font-size:10px;color:var(--text3)">· '+r.freq+'</span>'):'');
      return '<tr><td style="'+td+';font-weight:700;cursor:pointer" onclick="_mttsAssetStatusInfo(\''+idEsc+'\')" title="Click to open status & details">'+(r.asset.name||'—')+
        '<div style="font-size:10px;color:var(--text3)">'+(r.asset.assetType||'')+'</div></td>'+
        '<td style="'+td+'">'+plantLbl(r.asset.plant)+'</td>'+
        '<td style="'+td+'">'+kindCell+'</td>'+
        '<td style="'+td+';font-family:var(--mono)">'+r.due+'</td>'+
        '<td style="'+td+'"><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800;background:'+stateClr[r.state]+'22;color:'+stateClr[r.state]+'">'+stateLbl[r.state]+'</span></td></tr>';
    }).join('')+
    '</tbody></table></div>';
  return _mttsDashCard('Upkeep alerts (PM / Warranty / AMC)',html);
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
  var refsAsset={},refsTicket={};
  (DB.mttsAssets||[]).forEach(function(a){if(a&&a.plant) refsAsset[a.plant]=(refsAsset[a.plant]||0)+1;});
  (DB.mttsTickets||[]).forEach(function(t){if(t&&t.plant) refsTicket[t.plant]=(refsTicket[t.plant]||0)+1;});
  var sumEl=document.getElementById('mttsPlantSummary');
  if(sumEl){
    var _allP=(DB.mttsPlants||[]),_actP=_allP.filter(function(p){return p&&!p.inactive;}).length;
    sumEl.innerHTML=_mttsCountChip('Total',_allP.length,'total')+
      _mttsCountChip('Active',_actP,'active')+
      _mttsCountChip('Inactive',_allP.length-_actP,'inactive')+
      _mttsCountChip('Showing',rows.length,'showing');
  }
  var canEditPlant=_mttsHasAccess('action.editPlant');
  var view=_mttsViewMode(_mttsPlantState,'mtts_view_plant');
  var viewBtn='<button type="button" class="btn btn-secondary mtts-view-toggle" onclick="_mttsPlantToggleView()" title="Switch view" style="font-size:12px;padding:6px 10px">'+(view==='table'?'🗂 Cards':'📊 Table')+'</button>';
  var html='<div class="mtts-tcard-filters">'+viewBtn+'</div>';
  if(view==='table'){
    html+=_mttsPlantTableHtml(rows,refsAsset,refsTicket,canEditPlant);
  } else if(!rows.length){
    html+='<div class="mtts-tcards"><div class="mtts-tcard-empty">No plants yet. Click <b>+ Add Plant</b> to create one.</div></div>';
  } else {
    html+='<div class="mtts-tcards">';
    rows.forEach(function(p){
      var idEsc=String(p.id||'').replace(/'/g,"\\'");
      var swatch=p.color?'<span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:'+p.color+';border:1px solid rgba(0,0,0,.1);vertical-align:middle;margin-right:6px"></span>':'';
      var aRef=refsAsset[p.id]||0,tRef=refsTicket[p.id]||0;
      var canDelete=canEditPlant&&aRef===0&&tRef===0;
      var stop='event.stopPropagation();';
      var sideAct='<button class="mtts-tcard-iconbtn is-edit" onclick="'+stop+'_mttsPlantOpen(\''+idEsc+'\')" title="'+(canEditPlant?'Edit':'View')+'">'+(canEditPlant?'✎':'👁')+'</button>';
      if(canDelete) sideAct+='<button class="mtts-tcard-iconbtn is-del" onclick="'+stop+'_mttsPlantDeleteFromTable(\''+idEsc+'\')" title="Delete">🗑</button>';
      else if(canEditPlant) sideAct+='<button class="mtts-tcard-iconbtn is-del" disabled title="In use — referenced by '+aRef+' asset(s) / '+tRef+' ticket(s)" style="opacity:.5;cursor:not-allowed">🗑</button>';
      var statusBadge=p.inactive
        ?'<span class="mtts-tcard-prio" style="background:#fee2e2;color:#7f1d1d">Inactive</span>'
        :'<span class="mtts-tcard-prio" style="background:#dcfce7;color:#15803d">Active</span>';
      html+='<div class="mtts-tcard" style="--plant-color:'+(p.color||'#94a3b8')+'" onclick="_mttsPlantOpen(\''+idEsc+'\')">'+
        '<div class="mtts-tcard-head">'+
          '<div class="mtts-tcard-headline">'+
            '<div class="mtts-tcard-asset">'+swatch+(p.name||'—')+'</div>'+
          '</div>'+
          statusBadge+
        '</div>'+
        '<div class="mtts-tcard-rows">'+
          (p.address?'<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Address</span><span class="mtts-tcard-val" style="white-space:normal;text-align:left;line-height:1.3">'+String(p.address).replace(/</g,'&lt;').replace(/\n/g,', ')+'</span></div>':'')+
          '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Assets</span><span class="mtts-tcard-val">'+aRef+'</span></div>'+
          '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Tickets</span><span class="mtts-tcard-val">'+tRef+'</span></div>'+
        '</div>'+
        '<div class="mtts-tcard-actions">'+
          '<div class="mtts-tcard-actions-left"></div>'+
          '<div class="mtts-tcard-actions-right">'+sideAct+'</div>'+
        '</div>'+
      '</div>';
    });
    html+='</div>';
  }
  wrap.innerHTML=html;
}
function _mttsPlantTableHtml(rows,refsAsset,refsTicket,canEditPlant){
  var th='padding:8px 12px;font-size:13px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;position:sticky;top:0;z-index:2;box-shadow:0 1px 0 rgba(0,0,0,.04)';
  var td='padding:8px 12px;font-size:14px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var html='<div style="border:1.5px solid var(--border);border-radius:8px;background:#fff;overflow:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>'+
    '<th style="'+th+'">#</th>'+
    '<th style="'+th+'">Name</th>'+
    '<th style="'+th+'">Address</th>'+
    '<th style="'+th+';text-align:right">Assets</th>'+
    '<th style="'+th+';text-align:right">Tickets</th>'+
    '<th style="'+th+'">Status</th>'+
    '<th style="'+th+';text-align:center;width:90px">Actions</th>'+
  '</tr></thead><tbody>';
  if(!rows.length){
    html+='<tr><td colspan="7" style="padding:30px 20px;text-align:center;color:var(--text3);font-size:13px">No plants match the current filter.</td></tr>';
  }
  rows.forEach(function(p,i){
    var idEsc=String(p.id||'').replace(/'/g,"\\'");
    var swatch=p.color?'<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:'+p.color+';border:1px solid rgba(0,0,0,.1);vertical-align:middle;margin-right:6px"></span>':'';
    var aRef=refsAsset[p.id]||0,tRef=refsTicket[p.id]||0;
    var canDelete=canEditPlant&&aRef===0&&tRef===0;
    var stop='event.stopPropagation();';
    var actions='<button onclick="'+stop+'_mttsPlantOpen(\''+idEsc+'\')" title="'+(canEditPlant?'Edit plant':'View plant')+'" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer">'+(canEditPlant?'✎':'👁')+'</button>';
    if(canDelete) actions+='<button onclick="'+stop+'_mttsPlantDeleteFromTable(\''+idEsc+'\')" title="Delete plant" style="font-size:12px;padding:4px 9px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer;margin-left:3px">🗑</button>';
    else if(canEditPlant) actions+='<button disabled title="In use — '+aRef+' asset(s) / '+tRef+' ticket(s)" style="font-size:12px;padding:4px 9px;font-weight:700;background:#f1f5f9;border:1px solid var(--border);color:#cbd5e1;border-radius:4px;cursor:not-allowed;margin-left:3px">🗑</button>';
    html+='<tr onclick="_mttsPlantOpen(\''+idEsc+'\')" style="cursor:pointer">'+
      '<td style="'+td+';color:var(--text3);font-family:var(--mono)">'+(i+1)+'</td>'+
      '<td style="'+td+';font-weight:700">'+swatch+(p.name||'—')+'</td>'+
      '<td style="'+td+';font-size:13px;color:var(--text2);max-width:320px">'+String(p.address||'').replace(/</g,'&lt;').replace(/\n/g,'<br>')+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+aRef+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+tRef+'</td>'+
      '<td style="'+td+'">'+(p.inactive?'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#fee2e2;color:#7f1d1d">Inactive</span>':'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#dcfce7;color:#15803d">Active</span>')+'</td>'+
      '<td style="'+td+';text-align:center;white-space:nowrap">'+actions+'</td>'+
    '</tr>';
  });
  html+='</tbody></table></div>';
  return html;
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
  var canEdit=_mttsHasAccess('action.editPlant');
  if(!canEdit&&id===''){notify('You do not have permission to add plants',true);return;}
  var p=id?(byId(DB.mttsPlants||[],id)||null):null;
  document.getElementById('mttsPlantTitle').textContent=p?(canEdit?'🏭 Edit Plant':'🏭 View Plant'):'🏭 Add Plant';
  document.getElementById('mttsPlantIdHidden').value=p?p.id:'';
  // Code field is hidden — name doubles as the identifier. Pre-fill the
  // hidden code input so the rename pipeline still has a value to compare
  // against on save.
  var codeInput=document.getElementById('mttsPlantCode');
  if(codeInput) codeInput.value=p?p.id:'';
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
    _mttsLockModal(modalEl,canEdit);
    var saveBtn=modalEl.querySelector('button.btn-primary');
    if(saveBtn) saveBtn.style.display=canEdit?'':'none';
    if(modalEl._mttsKeyHandler) modalEl.removeEventListener('keydown',modalEl._mttsKeyHandler);
    modalEl._mttsKeyHandler=function(ev){
      if(modalEl.style.display==='none'||!modalEl.classList.contains('open')) return;
      if(ev.key==='Escape'){ev.preventDefault();cm('mMttsPlant');return;}
      if(ev.key==='Enter'){
        if(!canEdit){ev.preventDefault();cm('mMttsPlant');return;}
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
  var name=_t('mttsPlantName');
  // Plant code is no longer a separate field — name doubles as the
  // user-facing identifier. Mirror it to the hidden code input so the
  // rest of the save / rename pipeline keeps working unchanged.
  var code=name;
  var codeEl=document.getElementById('mttsPlantCode');if(codeEl) codeEl.value=code;
  var address=_t('mttsPlantAddress');
  var color=document.getElementById('mttsPlantColor').value||'';
  var inactive=document.getElementById('mttsPlantInactive').checked;
  if(!name){_showErr('Name is required');return;}
  if(name.length>60){_showErr('Name max 60 chars');return;}
  // Name uniqueness — case-insensitive, against all plants OTHER than this one.
  var nLow=name.toLowerCase();
  var dup=(DB.mttsPlants||[]).find(function(x){return x&&String(x.id||'').toLowerCase()===nLow&&x.id!==existingId;});
  if(dup){_showErr('"'+name+'" already exists');return;}
  if(existingId){
    var p=byId(DB.mttsPlants||[],existingId);
    if(!p){_showErr('Plant not found');return;}
    var bak=Object.assign({},p);
    var oldCode=p.id;
    var codeChanged=(code!==oldCode);
    var refAssets=(DB.mttsAssets||[]).filter(function(a){return a&&a.plant===oldCode;});
    var refTickets=(DB.mttsTickets||[]).filter(function(t){return t&&t.plant===oldCode;});
    if(codeChanged&&(refAssets.length||refTickets.length)){
      if(!confirm('Rename Short Code "'+oldCode+'" → "'+code+'"?\n\n'+refAssets.length+' asset(s) and '+refTickets.length+' ticket(s) will be updated to the new code.\n\nProceed?')) return;
    }
    if(codeChanged){
      // In-place UPDATE so the row keeps its identity and FK ON UPDATE
      // CASCADE (when configured) propagates to referring tables atomically.
      var ok=await _mttsRenameMasterCode('mttsPlants',oldCode,code,
        {name:name,address:address,color:color,inactive:inactive});
      if(!ok){_showErr('Save failed — rename rolled back');return;}
      // Sync in-memory: master + referrers (DB now has cascaded refs).
      await _mttsReloadTables(['mttsPlants','mttsAssets','mttsTickets']);
    } else {
      // Same code — straightforward upsert is sufficient.
      p.name=name;p.address=address;p.color=color;p.inactive=inactive;
      var okSimple=await _dbSave('mttsPlants',p);
      if(!okSimple){Object.assign(p,bak);_showErr('Save failed');return;}
    }
    notify('✓ Plant updated'+(codeChanged?' · '+(refAssets.length+refTickets.length)+' reference(s) cascaded':''));
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
  if(sumEl){
    var _allT=(DB.mttsAssetTypes||[]),_actT=_allT.filter(function(t){return t&&!t.inactive;}).length;
    sumEl.innerHTML=_mttsCountChip('Total',_allT.length,'total')+
      _mttsCountChip('Active',_actT,'active')+
      _mttsCountChip('Inactive',_allT.length-_actT,'inactive')+
      _mttsCountChip('Showing',rows.length,'showing');
  }
  var canEdit=_mttsHasAccess('action.editAssetType');
  var view=_mttsViewMode(_mttsAtypeState,'mtts_view_atype');
  var viewBtn='<button type="button" class="btn btn-secondary mtts-view-toggle" onclick="_mttsAtypeToggleView()" title="Switch view" style="font-size:12px;padding:6px 10px">'+(view==='table'?'🗂 Cards':'📊 Table')+'</button>';
  var html='<div class="mtts-tcard-filters">'+viewBtn+'</div>';
  if(view==='table'){
    html+=_mttsAtypeTableHtml(rows,refsAsset,refsPrim,canEdit);
  } else if(!rows.length){
    html+='<div class="mtts-tcards"><div class="mtts-tcard-empty">No asset types yet. Click <b>+ Add Asset Type</b> to create one.</div></div>';
  } else {
    html+='<div class="mtts-tcards">';
    rows.forEach(function(t){
      var idEsc=String(t.id||'').replace(/'/g,"\\'");
      var swatch=t.color?'<span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:'+t.color+';border:1px solid rgba(0,0,0,.1);vertical-align:middle;margin-right:6px"></span>':'';
      var aRef=refsAsset[t.id]||0,pRef=refsPrim[t.id]||0;
      var canDelete=canEdit&&aRef===0&&pRef===0;
      var blockMsg=[];if(aRef) blockMsg.push(aRef+' asset(s)');if(pRef) blockMsg.push(pRef+' primary name(s)');
      var stop='event.stopPropagation();';
      var sideAct='<button class="mtts-tcard-iconbtn is-edit" onclick="'+stop+'_mttsAtypeOpen(\''+idEsc+'\')" title="'+(canEdit?'Edit':'View')+'">'+(canEdit?'✎':'👁')+'</button>';
      if(canDelete) sideAct+='<button class="mtts-tcard-iconbtn is-del" onclick="'+stop+'_mttsAtypeDeleteFromTable(\''+idEsc+'\')" title="Delete">🗑</button>';
      else if(canEdit) sideAct+='<button class="mtts-tcard-iconbtn is-del" disabled title="In use — '+blockMsg.join(' + ')+'" style="opacity:.5;cursor:not-allowed">🗑</button>';
      var statusBadge=t.inactive
        ?'<span class="mtts-tcard-prio" style="background:#fee2e2;color:#7f1d1d">Inactive</span>'
        :'<span class="mtts-tcard-prio" style="background:#dcfce7;color:#15803d">Active</span>';
      html+='<div class="mtts-tcard" style="--plant-color:'+(t.color||'#94a3b8')+'" onclick="_mttsAtypeOpen(\''+idEsc+'\')">'+
        '<div class="mtts-tcard-head">'+
          '<div class="mtts-tcard-headline">'+
            '<div class="mtts-tcard-asset">'+swatch+(t.name||'—')+'</div>'+
          '</div>'+
          statusBadge+
        '</div>'+
        '<div class="mtts-tcard-rows">'+
          '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Assets</span><span class="mtts-tcard-val">'+aRef+'</span></div>'+
          '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Primary Names</span><span class="mtts-tcard-val">'+pRef+'</span></div>'+
        '</div>'+
        '<div class="mtts-tcard-actions">'+
          '<div class="mtts-tcard-actions-left"></div>'+
          '<div class="mtts-tcard-actions-right">'+sideAct+'</div>'+
        '</div>'+
      '</div>';
    });
    html+='</div>';
  }
  wrap.innerHTML=html;
}
function _mttsAtypeTableHtml(rows,refsAsset,refsPrim,canEdit){
  var th='padding:8px 12px;font-size:13px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;position:sticky;top:0;z-index:2;box-shadow:0 1px 0 rgba(0,0,0,.04)';
  var td='padding:8px 12px;font-size:14px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var html='<div style="border:1.5px solid var(--border);border-radius:8px;background:#fff;overflow:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>'+
    '<th style="'+th+'">#</th>'+
    '<th style="'+th+'">Name</th>'+
    '<th style="'+th+';text-align:right">Assets</th>'+
    '<th style="'+th+';text-align:right">Primary Names</th>'+
    '<th style="'+th+'">Status</th>'+
    '<th style="'+th+';text-align:center;width:90px">Actions</th>'+
  '</tr></thead><tbody>';
  if(!rows.length){
    html+='<tr><td colspan="6" style="padding:30px 20px;text-align:center;color:var(--text3);font-size:13px">No asset types match the current filter.</td></tr>';
  }
  rows.forEach(function(t,i){
    var idEsc=String(t.id||'').replace(/'/g,"\\'");
    var swatch=t.color?'<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:'+t.color+';border:1px solid rgba(0,0,0,.1);vertical-align:middle;margin-right:6px"></span>':'';
    var aRef=refsAsset[t.id]||0,pRef=refsPrim[t.id]||0;
    var canDelete=canEdit&&aRef===0&&pRef===0;
    var blockMsg=[];if(aRef) blockMsg.push(aRef+' asset(s)');if(pRef) blockMsg.push(pRef+' primary name(s)');
    var stop='event.stopPropagation();';
    var actions='<button onclick="'+stop+'_mttsAtypeOpen(\''+idEsc+'\')" title="'+(canEdit?'Edit':'View')+'" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer">'+(canEdit?'✎':'👁')+'</button>';
    if(canDelete) actions+='<button onclick="'+stop+'_mttsAtypeDeleteFromTable(\''+idEsc+'\')" title="Delete" style="font-size:12px;padding:4px 9px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer;margin-left:3px">🗑</button>';
    else if(canEdit) actions+='<button disabled title="In use — '+blockMsg.join(' + ')+'" style="font-size:12px;padding:4px 9px;font-weight:700;background:#f1f5f9;border:1px solid var(--border);color:#cbd5e1;border-radius:4px;cursor:not-allowed;margin-left:3px">🗑</button>';
    html+='<tr onclick="_mttsAtypeOpen(\''+idEsc+'\')" style="cursor:pointer">'+
      '<td style="'+td+';color:var(--text3);font-family:var(--mono)">'+(i+1)+'</td>'+
      '<td style="'+td+';font-weight:700">'+swatch+(t.name||'—')+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+aRef+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+pRef+'</td>'+
      '<td style="'+td+'">'+(t.inactive?'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#fee2e2;color:#7f1d1d">Inactive</span>':'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#dcfce7;color:#15803d">Active</span>')+'</td>'+
      '<td style="'+td+';text-align:center;white-space:nowrap">'+actions+'</td>'+
    '</tr>';
  });
  html+='</tbody></table></div>';
  return html;
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
  var canEdit=_mttsHasAccess('action.editAssetType');
  if(!canEdit&&id===''){notify('You do not have permission to add asset types',true);return;}
  var t=id?(byId(DB.mttsAssetTypes||[],id)||null):null;
  document.getElementById('mttsAtypeTitle').textContent=t?(canEdit?'🏷 Edit Asset Type':'🏷 View Asset Type'):'🏷 Add Asset Type';
  document.getElementById('mttsAtypeIdHidden').value=t?t.id:'';
  // Code field is hidden — name is the user-facing identifier.
  var codeInput=document.getElementById('mttsAtypeCode');
  if(codeInput) codeInput.value=t?t.id:'';
  document.getElementById('mttsAtypeName').value=t?(t.name||''):'';
  var initialColor=(t&&t.color)?t.color:'#dbeafe';
  document.getElementById('mttsAtypeColor').value=initialColor;
  _mttsRenderAtypeColorGrid(initialColor);
  document.getElementById('mttsAtypeInactive').checked=!!(t&&t.inactive);
  var err=document.getElementById('mttsAtypeErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsAtype'); else { document.getElementById('mMttsAtype').classList.add('open'); }
  var modalEl=document.getElementById('mMttsAtype');
  if(modalEl){
    _mttsLockModal(modalEl,canEdit);
    var saveBtn=modalEl.querySelector('button.btn-primary');
    if(saveBtn) saveBtn.style.display=canEdit?'':'none';
    if(modalEl._mttsKeyHandler) modalEl.removeEventListener('keydown',modalEl._mttsKeyHandler);
    modalEl._mttsKeyHandler=function(ev){
      if(modalEl.style.display==='none'||!modalEl.classList.contains('open')) return;
      if(ev.key==='Escape'){ev.preventDefault();cm('mMttsAtype');return;}
      if(ev.key==='Enter'){
        if(!canEdit){ev.preventDefault();cm('mMttsAtype');return;}
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
  var name=_t('mttsAtypeName');
  // Asset type code dropped — name doubles as the user-facing identifier.
  var code=name;
  var codeEl=document.getElementById('mttsAtypeCode');if(codeEl) codeEl.value=code;
  var color=document.getElementById('mttsAtypeColor').value||'';
  var inactive=document.getElementById('mttsAtypeInactive').checked;
  if(!name){_showErr('Name is required');return;}
  if(name.length>60){_showErr('Name max 60 chars');return;}
  var nLow=name.toLowerCase();
  var dup=(DB.mttsAssetTypes||[]).find(function(x){return x&&String(x.id||'').toLowerCase()===nLow&&x.id!==existingId;});
  if(dup){_showErr('"'+name+'" already exists');return;}
  if(existingId){
    var t=byId(DB.mttsAssetTypes||[],existingId);
    if(!t){_showErr('Asset type not found');return;}
    var bak=Object.assign({},t);
    var oldCode=t.id;
    var codeChanged=(code!==oldCode);
    var refAssets=(DB.mttsAssets||[]).filter(function(a){return a&&a.assetType===oldCode;});
    var refPrim=(DB.mttsAssetPrimaryNames||[]).filter(function(p){return p&&p.assetType===oldCode;});
    if(codeChanged&&(refAssets.length||refPrim.length)){
      if(!confirm('Rename Short Code "'+oldCode+'" → "'+code+'"?\n\n'+refAssets.length+' asset(s) and '+refPrim.length+' primary name(s) will be updated to the new code.\n\nProceed?')) return;
    }
    if(codeChanged){
      var ok=await _mttsRenameMasterCode('mttsAssetTypes',oldCode,code,
        {name:name,color:color,inactive:inactive});
      if(!ok){_showErr('Save failed — rename rolled back');return;}
      await _mttsReloadTables(['mttsAssetTypes','mttsAssetPrimaryNames','mttsAssets']);
    } else {
      t.name=name;t.color=color;t.inactive=inactive;
      var okSimple=await _dbSave('mttsAssetTypes',t);
      if(!okSimple){Object.assign(t,bak);_showErr('Save failed');return;}
    }
    notify('✓ Asset type updated'+(codeChanged?' · '+(refAssets.length+refPrim.length)+' reference(s) cascaded':''));
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
  if(document.getElementById('mttsAssetType')&&typeof _mttsAssetRenderTypeBtns==='function') _mttsAssetRenderTypeBtns();
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
  // Pull the latest filter inputs into state before rebuilding so the
  // user's choices survive a re-render. Capture caret on the search box
  // so typing doesn't lose the cursor each keystroke.
  var tEl0=document.getElementById('mttsAprimTypeFilter');
  if(tEl0) _mttsAprimState.type=tEl0.value;
  var sEl0=document.getElementById('mttsAprimStatusFilter');
  if(sEl0) _mttsAprimState.status=sEl0.value;
  var srchEl0=document.getElementById('mttsAprimSearch');
  if(srchEl0) _mttsAprimState.search=srchEl0.value;
  var activeId=document.activeElement&&document.activeElement.id;
  var caretStart=null,caretEnd=null;
  if(activeId==='mttsAprimSearch'&&srchEl0){
    try{caretStart=srchEl0.selectionStart;caretEnd=srchEl0.selectionEnd;}catch(e){}
  }
  // Hide-Inactive checkbox is the broad "show only Active" shortcut and
  // continues to live in the page header. The status dropdown inside the
  // filter row offers finer control (All / Active / Inactive). When the
  // checkbox is on, it overrides any "Inactive" selection.
  var hideInactive=!!(document.getElementById('mttsAprimHideInactive')||{}).checked;
  var fType=_mttsAprimState.type;
  var fStatus=_mttsAprimState.status;
  var fSearchRaw=String(_mttsAprimState.search||'');
  var fSearch=fSearchRaw.toLowerCase().trim();
  var rows=(DB.mttsAssetPrimaryNames||[]).slice().filter(function(p){
    if(!p) return false;
    if(hideInactive&&p.inactive) return false;
    if(fType&&p.assetType!==fType) return false;
    if(fStatus==='active'&&p.inactive) return false;
    if(fStatus==='inactive'&&!p.inactive) return false;
    if(fSearch&&String(p.name||'').toLowerCase().indexOf(fSearch)<0) return false;
    return true;
  });
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
  if(sumEl){
    var _allPn=(DB.mttsAssetPrimaryNames||[]),_actPn=_allPn.filter(function(p){return p&&!p.inactive;}).length;
    sumEl.innerHTML=_mttsCountChip('Total',_allPn.length,'total')+
      _mttsCountChip('Active',_actPn,'active')+
      _mttsCountChip('Inactive',_allPn.length-_actPn,'inactive')+
      _mttsCountChip('Showing',rows.length,'showing');
  }
  // Hide "+ Add" when the user can't edit.
  var addBtn=document.getElementById('btnMttsAddAprim');
  if(addBtn) addBtn.style.display=_mttsHasAccess('action.editAssetPrimaryName')?'':'none';
  // Card grid layout — same `.mtts-tcards` / `.mtts-tcard` pattern the
  // tickets page uses. Wider screens can switch to a compact table via
  // the view-mode toggle (saved per page in localStorage).
  var view=_mttsViewMode(_mttsAprimState,'mtts_view_aprim');
  var typesArr=_mttsAssetTypeList(true);
  var typeOpts='<option value="">All types</option>'+typesArr.map(function(t){
    return '<option value="'+t.value+'"'+(t.value===fType?' selected':'')+'>'+t.label+'</option>';
  }).join('');
  var statusOpts='<option value=""'+(fStatus===''?' selected':'')+'>All</option>'+
    '<option value="active"'+(fStatus==='active'?' selected':'')+'>Active</option>'+
    '<option value="inactive"'+(fStatus==='inactive'?' selected':'')+'>Inactive</option>';
  var inlineSearchVal=fSearchRaw.replace(/"/g,'&quot;');
  var canEdit=_mttsHasAccess('action.editAssetPrimaryName');
  var viewBtn='<button type="button" class="btn btn-secondary mtts-view-toggle" onclick="_mttsAprimToggleView()" title="Switch view" style="font-size:12px;padding:6px 10px">'+(view==='table'?'🗂 Cards':'📊 Table')+'</button>';
  var html='<div class="mtts-tcard-filters">'+
    '<input type="search" id="mttsAprimSearch" placeholder="🔍 name…" oninput="_mttsRenderAssetPrimaryNames()" value="'+inlineSearchVal+'">'+
    '<select id="mttsAprimTypeFilter" onchange="_mttsRenderAssetPrimaryNames()">'+typeOpts+'</select>'+
    '<select id="mttsAprimStatusFilter" onchange="_mttsRenderAssetPrimaryNames()">'+statusOpts+'</select>'+
    viewBtn+
    '<button type="button" class="btn btn-secondary" onclick="_mttsAprimClearFilters()" title="Reset filters and search" style="font-size:12px;padding:6px 10px">✕ Clear</button>'+
  '</div>';
  if(view==='table'){
    html+=_mttsAprimTableHtml(rows,refsAsset,refsAgency,canEdit);
  } else if(!rows.length){
    html+='<div class="mtts-tcards"><div class="mtts-tcard-empty">No primary names match the current filters.</div></div>';
  } else {
    html+='<div class="mtts-tcards">';
    rows.forEach(function(p){
      var idEsc=String(p.id||'').replace(/'/g,"\\'");
      var swatch=p.color?'<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:'+p.color+';border:1px solid rgba(0,0,0,.1);vertical-align:middle;margin-right:6px"></span>':'';
      var aRef=refsAsset[p.id]||0;
      var gRef=refsAgency[p.id]||0;
      var canDelete=canEdit&&aRef===0&&gRef===0;
      var blockMsg=[];if(aRef) blockMsg.push(aRef+' asset(s)');if(gRef) blockMsg.push(gRef+' agency(s)');
      var stop='event.stopPropagation();';
      var sideAct='<button class="mtts-tcard-iconbtn is-edit" onclick="'+stop+'_mttsAprimOpen(\''+idEsc+'\')" title="'+(canEdit?'Edit':'View')+'">'+(canEdit?'✎':'👁')+'</button>';
      if(canDelete) sideAct+='<button class="mtts-tcard-iconbtn is-del" onclick="'+stop+'_mttsAprimDeleteFromTable(\''+idEsc+'\')" title="Delete">🗑</button>';
      else if(canEdit) sideAct+='<button class="mtts-tcard-iconbtn is-del" disabled title="In use — referenced by '+blockMsg.join(' + ')+'" style="opacity:.5;cursor:not-allowed">🗑</button>';
      var statusBadge=p.inactive
        ?'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:800;background:#fee2e2;color:#7f1d1d">Inactive</span>'
        :'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:800;background:#dcfce7;color:#15803d">Active</span>';
      html+='<div class="mtts-tcard" style="--plant-color:'+(p.color||'#94a3b8')+'" onclick="_mttsAprimOpen(\''+idEsc+'\')">'+
        '<div class="mtts-tcard-head">'+
          '<div class="mtts-tcard-headline">'+
            '<div class="mtts-tcard-headtop"><span class="mtts-tcard-type">'+(p.assetType?_mttsAssetTypeLabel(p.assetType):'—')+'</span></div>'+
            '<div class="mtts-tcard-asset">'+swatch+(p.name||'—')+'</div>'+
          '</div>'+
          statusBadge+
        '</div>'+
        '<div class="mtts-tcard-rows">'+
          '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Assets</span><span class="mtts-tcard-val">'+aRef+'</span></div>'+
          '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Agencies</span><span class="mtts-tcard-val">'+gRef+'</span></div>'+
        '</div>'+
        '<div class="mtts-tcard-actions">'+
          '<div class="mtts-tcard-actions-left"></div>'+
          '<div class="mtts-tcard-actions-right">'+sideAct+'</div>'+
        '</div>'+
      '</div>';
    });
    html+='</div>';
  }
  wrap.innerHTML=html;
  // Restore focus + caret on the search box so typing isn't interrupted
  // by the re-render on every keystroke.
  if(activeId){
    var newActive=document.getElementById(activeId);
    if(newActive&&typeof newActive.focus==='function'){
      newActive.focus();
      if(activeId==='mttsAprimSearch'&&caretStart!=null){
        try{newActive.setSelectionRange(caretStart,caretEnd!=null?caretEnd:caretStart);}catch(e){}
      }
    }
  }
}

// Table view for the Asset Primary Name master — sticky-header HTML
// table mirrors the original layout for wide-screen users who prefer
// dense scanning.
function _mttsAprimTableHtml(rows,refsAsset,refsAgency,canEdit){
  var th='padding:9px 12px;font-size:12px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;position:sticky;top:0;z-index:2;box-shadow:0 1px 0 rgba(0,0,0,.04)';
  var td='padding:8px 12px;font-size:13px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var html='<div style="border:1.5px solid var(--border);border-radius:8px;background:#fff;overflow:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>'+
    '<th style="'+th+'">#</th>'+
    '<th style="'+th+'">Asset Type</th>'+
    '<th style="'+th+'">Name</th>'+
    '<th style="'+th+';text-align:right">Assets</th>'+
    '<th style="'+th+';text-align:right">Agencies</th>'+
    '<th style="'+th+'">Status</th>'+
    '<th style="'+th+';text-align:center;width:90px">Actions</th>'+
  '</tr></thead><tbody>';
  if(!rows.length){
    html+='<tr><td colspan="7" style="padding:30px 20px;text-align:center;color:var(--text3);font-size:13px">No primary names match the current filters.</td></tr>';
  }
  rows.forEach(function(p,i){
    var idEsc=String(p.id||'').replace(/'/g,"\\'");
    var swatch=p.color?'<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:'+p.color+';border:1px solid rgba(0,0,0,.1);vertical-align:middle;margin-right:6px"></span>':'';
    var aRef=refsAsset[p.id]||0;
    var gRef=refsAgency[p.id]||0;
    var canDelete=canEdit&&aRef===0&&gRef===0;
    var blockMsg=[];if(aRef) blockMsg.push(aRef+' asset(s)');if(gRef) blockMsg.push(gRef+' agency(s)');
    var stop='event.stopPropagation();';
    var actions='<button onclick="'+stop+'_mttsAprimOpen(\''+idEsc+'\')" title="'+(canEdit?'Edit':'View')+'" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer">'+(canEdit?'✎':'👁')+'</button>';
    if(canDelete) actions+='<button onclick="'+stop+'_mttsAprimDeleteFromTable(\''+idEsc+'\')" title="Delete" style="font-size:12px;padding:4px 9px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer;margin-left:3px">🗑</button>';
    else if(canEdit) actions+='<button disabled title="In use — '+blockMsg.join(' + ')+'" style="font-size:12px;padding:4px 9px;font-weight:700;background:#f1f5f9;border:1px solid var(--border);color:#cbd5e1;border-radius:4px;cursor:not-allowed;margin-left:3px">🗑</button>';
    html+='<tr onclick="_mttsAprimOpen(\''+idEsc+'\')" style="cursor:pointer">'+
      '<td style="'+td+';color:var(--text3);font-family:var(--mono)">'+(i+1)+'</td>'+
      '<td style="'+td+';color:var(--text2);font-weight:600">'+(p.assetType?_mttsAssetTypeLabel(p.assetType):'—')+'</td>'+
      '<td style="'+td+';font-weight:700">'+swatch+(p.name||'—')+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+aRef+'</td>'+
      '<td style="'+td+';text-align:right;font-family:var(--mono)">'+gRef+'</td>'+
      '<td style="'+td+'">'+(p.inactive?'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:800;background:#fee2e2;color:#7f1d1d">Inactive</span>':'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:800;background:#dcfce7;color:#15803d">Active</span>')+'</td>'+
      '<td style="'+td+';text-align:center;white-space:nowrap">'+actions+'</td>'+
    '</tr>';
  });
  html+='</tbody></table></div>';
  return html;
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

// Optional preset object: { assetType: '<typeCode>' } — used by the
// Save & Add Next flow to pre-select the previous entry's asset type so
// the user can rattle off several primary names without re-picking it.
function _mttsAprimOpen(id, preset){
  var canEdit=_mttsHasAccess('action.editAssetPrimaryName');
  if(!canEdit&&id===''){notify('You do not have permission to add primary names',true);return;}
  var p=id?(byId(DB.mttsAssetPrimaryNames||[],id)||null):null;
  document.getElementById('mttsAprimTitle').textContent=p?(canEdit?'🔤 Edit Primary Name':'🔤 View Primary Name'):'🔤 Add Primary Name';
  document.getElementById('mttsAprimIdHidden').value=p?p.id:'';
  // Populate the Asset Type dropdown freshly (so newly-added types are
  // pickable) and reflect the current value if editing.
  var typeSel=document.getElementById('mttsAprimAssetType');
  if(typeSel){
    var typesArr=_mttsAssetTypeList(true);
    typeSel.innerHTML='<option value="">— Select Asset Type first —</option>'+typesArr.map(function(t){
      return '<option value="'+t.value+'">'+t.label+'</option>';
    }).join('');
    typeSel.value=p?(p.assetType||''):((preset&&preset.assetType)||'');
  }
  document.getElementById('mttsAprimName').value=p?(p.name||''):'';
  var initialColor=(p&&p.color)?p.color:'#bbf7d0';
  document.getElementById('mttsAprimColor').value=initialColor;
  _mttsRenderAprimColorGrid(initialColor);
  document.getElementById('mttsAprimInactive').checked=!!(p&&p.inactive);
  // Save buttons: edit mode shows a single "Save"; add mode shows
  // "Save & Add Next" (secondary, keeps the form open) plus the primary
  // "Save & Close". Both hidden in view-only mode.
  var saveBtn=document.getElementById('mttsAprimSaveBtn');
  if(saveBtn) saveBtn.textContent=p?'Save':'Save & Close';
  var saveNextBtn=document.getElementById('mttsAprimSaveNextBtn');
  if(saveNextBtn) saveNextBtn.style.display=(canEdit&&!p)?'':'none';
  var err=document.getElementById('mttsAprimErr');if(err){err.style.display='none';err.textContent='';}
  if(typeof om==='function') om('mMttsAprim'); else { document.getElementById('mMttsAprim').classList.add('open'); }
  var modalEl=document.getElementById('mMttsAprim');
  if(modalEl){
    _mttsLockModal(modalEl,canEdit);
    if(saveBtn) saveBtn.style.display=canEdit?'':'none';
    if(modalEl._mttsKeyHandler) modalEl.removeEventListener('keydown',modalEl._mttsKeyHandler);
    modalEl._mttsKeyHandler=function(ev){
      if(modalEl.style.display==='none'||!modalEl.classList.contains('open')) return;
      if(ev.key==='Escape'){ev.preventDefault();cm('mMttsAprim');return;}
      if(ev.key==='Enter'){
        if(!canEdit){ev.preventDefault();cm('mMttsAprim');return;}
        var tag=ev.target&&ev.target.tagName;
        if(tag==='TEXTAREA') return;
        ev.preventDefault();_mttsAprimSave();
      }
    };
    modalEl.addEventListener('keydown',modalEl._mttsKeyHandler);
  }
  // Focus jumps to whichever field still needs input: Asset Type when
  // empty (the prompt-first behaviour), Name otherwise.
  setTimeout(function(){
    var first=(typeSel&&!typeSel.value)?typeSel:document.getElementById('mttsAprimName');
    if(first&&typeof first.focus==='function') first.focus();
  },50);
}

// mode: 'close' (default) closes the modal after save; 'next' keeps the
// add form open with the same Asset Type pre-selected so the user can
// rapidly enter several primary names under the same type.
async function _mttsAprimSave(mode){
  mode=mode||'close';
  if(!_mttsHasAccess('action.editAssetPrimaryName')){notify('Access denied',true);return;}
  var err=document.getElementById('mttsAprimErr');
  var _showErr=function(m){
    if(!err) return;
    err.textContent=m;err.style.display='block';
    err.classList.remove('mtts-err-flash');void err.offsetWidth;
    err.classList.add('mtts-err-flash');
  };
  var _t=function(elId){var el=document.getElementById(elId);if(!el) return '';var v=String(el.value||'').replace(/^[\s ]+|[\s ]+$/g,'');el.value=v;return v;};
  var existingId=document.getElementById('mttsAprimIdHidden').value;
  var assetType=document.getElementById('mttsAprimAssetType').value;
  var name=_t('mttsAprimName');
  // Name doubles as the row's identifier — there's no separate short code.
  var code=name;
  var color=document.getElementById('mttsAprimColor').value||'';
  var inactive=document.getElementById('mttsAprimInactive').checked;
  if(!assetType){_showErr('Asset Type is required');_mttsFlashFieldErr('mttsAprimAssetType');return;}
  if(!name){_showErr('Name is required');_mttsFlashFieldErr('mttsAprimName');return;}
  var dup=(DB.mttsAssetPrimaryNames||[]).find(function(x){return x&&String(x.id||'').toLowerCase()===code.toLowerCase()&&x.id!==existingId;});
  if(dup){_showErr('"'+name+'" already exists');_mttsFlashFieldErr('mttsAprimName');return;}
  if(existingId){
    var p=byId(DB.mttsAssetPrimaryNames||[],existingId);
    if(!p){_showErr('Primary name not found');return;}
    var bak=Object.assign({},p);
    var oldCode=p.id;
    var codeChanged=(code!==oldCode);
    var refAssets=(DB.mttsAssets||[]).filter(function(a){return a&&a.primaryName===oldCode;});
    var refAgencies=(DB.mttsAgencies||[]).filter(function(ag){return ag&&Array.isArray(ag.primaryNames)&&ag.primaryNames.indexOf(oldCode)>=0;});
    if(codeChanged&&(refAssets.length||refAgencies.length)){
      if(!confirm('Rename "'+oldCode+'" → "'+name+'"?\n\n'+refAssets.length+' asset(s) and '+refAgencies.length+' agency(s) will be updated.\n\nProceed?')) return;
    }
    if(codeChanged){
      var ok=await _mttsRenameMasterCode('mttsAssetPrimaryNames',oldCode,code,
        {name:name,asset_type:assetType,color:color,inactive:inactive});
      if(!ok){_showErr('Save failed — rename rolled back');return;}
      // Asset.name is composed from primary + extension — recompute on the
      // server side after rename is impractical, so do a JS pass to refresh
      // the cached display field. FK ON UPDATE CASCADE has already moved
      // primary_name pointers; this just keeps the cached name in sync.
      for(var i=0;i<refAssets.length;i++){
        var ext=refAssets[i].nameExtension||'';
        refAssets[i].primaryName=code;
        refAssets[i].name=ext?(name+' - '+ext):name;
        try{await _dbSave('mttsAssets',refAssets[i]);}catch(e){console.warn('refresh asset name',e);}
      }
      // Agency.primaryNames is a text[] — FK doesn't reach inside arrays,
      // so update each agency's array in JS.
      for(var k=0;k<refAgencies.length;k++){
        refAgencies[k].primaryNames=(refAgencies[k].primaryNames||[]).map(function(x){return x===oldCode?code:x;});
        try{await _dbSave('mttsAgencies',refAgencies[k]);}catch(e){console.warn('refresh agency primaryNames',e);}
      }
      await _mttsReloadTables(['mttsAssetPrimaryNames','mttsAssets','mttsAgencies']);
    } else {
      p.name=name;p.assetType=assetType;p.color=color;p.inactive=inactive;
      var okSimple=await _dbSave('mttsAssetPrimaryNames',p);
      if(!okSimple){Object.assign(p,bak);_showErr('Save failed');return;}
    }
    notify('✓ Primary name updated'+(codeChanged?' · '+(refAssets.length+refAgencies.length)+' reference(s) cascaded':''));
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
    _mttsRenderAssetPrimaryNames();
    _mttsPopulateAssetPrimaryNameOptions();
    if(mode==='next'){
      // Reopen the form with the same Asset Type pre-selected and Name
      // cleared so the user can keep typing names without re-picking
      // the type each time.
      _mttsAprimOpen('',{assetType:assetType});
    } else {
      cm('mMttsAprim');
    }
    return;
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
  if(sumEl){
    var _allAg=(DB.mttsAgencies||[]),_actAg=_allAg.filter(function(a){return a&&!a.inactive;}).length;
    sumEl.innerHTML=_mttsCountChip('Total',_allAg.length,'total')+
      _mttsCountChip('Active',_actAg,'active')+
      _mttsCountChip('Inactive',_allAg.length-_actAg,'inactive')+
      _mttsCountChip('Showing',rows.length,'showing');
  }
  var canEdit=_mttsHasAccess('action.editAgency');
  var view=_mttsViewMode(_mttsAgencyState,'mtts_view_agency');
  var viewBtn='<button type="button" class="btn btn-secondary mtts-view-toggle" onclick="_mttsAgencyToggleView()" title="Switch view" style="font-size:12px;padding:6px 10px">'+(view==='table'?'🗂 Cards':'📊 Table')+'</button>';
  var html='<div class="mtts-tcard-filters">'+viewBtn+'</div>';
  if(view==='table'){
    html+=_mttsAgencyTableHtml(rows,canEdit);
  } else if(!rows.length){
    html+='<div class="mtts-tcards"><div class="mtts-tcard-empty">'+(search?'No agencies match the search.':'No agencies yet. Click <b>+ Add Agency</b> to create one.')+'</div></div>';
  } else {
    html+='<div class="mtts-tcards">';
    rows.forEach(function(a){
      var idEsc=String(a.id||'').replace(/'/g,"\\'");
      var prims=(a.primaryNames||[]);
      var primChips=prims.length?prims.map(function(p){return '<span style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:10px;font-weight:700;background:#eef2ff;color:#4338ca;margin:1px 2px">'+String(p).replace(/</g,'&lt;')+'</span>';}).join(''):'<span style="color:var(--text3);font-style:italic">—</span>';
      var phones=[a.contact1,a.contact2].filter(Boolean).join(' · ');
      var stop='event.stopPropagation();';
      var sideAct='<button class="mtts-tcard-iconbtn is-edit" onclick="'+stop+'_mttsAgencyOpen(\''+idEsc+'\')" title="'+(canEdit?'Edit':'View')+'">'+(canEdit?'✎':'👁')+'</button>';
      if(canEdit) sideAct+='<button class="mtts-tcard-iconbtn is-del" onclick="'+stop+'_mttsAgencyDeleteFromTable(\''+idEsc+'\')" title="Delete">🗑</button>';
      var statusBadge=a.inactive
        ?'<span class="mtts-tcard-prio" style="background:#fee2e2;color:#7f1d1d">Inactive</span>'
        :'<span class="mtts-tcard-prio" style="background:#dcfce7;color:#15803d">Active</span>';
      html+='<div class="mtts-tcard" style="--plant-color:#94a3b8" onclick="_mttsAgencyOpen(\''+idEsc+'\')">'+
        '<div class="mtts-tcard-head">'+
          '<div class="mtts-tcard-headline">'+
            '<div class="mtts-tcard-asset">'+(a.name||'—')+'</div>'+
            (a.address?'<div class="mtts-tcard-meta">'+String(a.address).replace(/</g,'&lt;').replace(/\n/g,', ')+'</div>':'')+
          '</div>'+
          statusBadge+
        '</div>'+
        '<div class="mtts-tcard-rows">'+
          (a.contactName?'<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Contact</span><span class="mtts-tcard-val">'+String(a.contactName).replace(/</g,'&lt;')+'</span></div>':'')+
          (a.email?'<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Email</span><span class="mtts-tcard-val">'+String(a.email).replace(/</g,'&lt;')+'</span></div>':'')+
          (phones?'<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Phone</span><span class="mtts-tcard-val">'+phones+'</span></div>':'')+
          '<div class="mtts-tcard-row"><span class="mtts-tcard-lbl">Handles</span><span class="mtts-tcard-val" style="white-space:normal;text-align:right">'+primChips+'</span></div>'+
        '</div>'+
        '<div class="mtts-tcard-actions">'+
          '<div class="mtts-tcard-actions-left"></div>'+
          '<div class="mtts-tcard-actions-right">'+sideAct+'</div>'+
        '</div>'+
      '</div>';
    });
    html+='</div>';
  }
  wrap.innerHTML=html;
}
function _mttsAgencyTableHtml(rows,canEdit){
  var th='padding:8px 12px;font-size:13px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;position:sticky;top:0;z-index:2;box-shadow:0 1px 0 rgba(0,0,0,.04)';
  var td='padding:8px 12px;font-size:14px;border-bottom:1px solid #f1f5f9;vertical-align:top';
  var html='<div style="border:1.5px solid var(--border);border-radius:8px;background:#fff;overflow:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>'+
    '<th style="'+th+'">#</th>'+
    '<th style="'+th+'">Agency / Vendor</th>'+
    '<th style="'+th+'">Contact</th>'+
    '<th style="'+th+'">Email / Phone</th>'+
    '<th style="'+th+'">Primary Names</th>'+
    '<th style="'+th+'">Status</th>'+
    '<th style="'+th+';text-align:center;width:100px">Actions</th>'+
  '</tr></thead><tbody>';
  if(!rows.length){
    html+='<tr><td colspan="7" style="padding:30px 20px;text-align:center;color:var(--text3);font-size:13px">No agencies match the current filter.</td></tr>';
  }
  rows.forEach(function(a,i){
    var idEsc=String(a.id||'').replace(/'/g,"\\'");
    var prims=(a.primaryNames||[]);
    var primChips=prims.length?prims.map(function(p){return '<span style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:11px;font-weight:700;background:#eef2ff;color:#4338ca;margin:1px 2px">'+String(p).replace(/</g,'&lt;')+'</span>';}).join(''):'<span style="color:var(--text3);font-style:italic">—</span>';
    var phones=[a.contact1,a.contact2].filter(Boolean).join(' · ');
    var stop='event.stopPropagation();';
    var actions='<button onclick="'+stop+'_mttsAgencyOpen(\''+idEsc+'\')" title="'+(canEdit?'Edit':'View')+'" style="font-size:12px;padding:4px 10px;font-weight:700;background:#fff;border:1px solid var(--border);color:var(--text2);border-radius:4px;cursor:pointer">'+(canEdit?'✎':'👁')+'</button>';
    if(canEdit) actions+='<button onclick="'+stop+'_mttsAgencyDeleteFromTable(\''+idEsc+'\')" title="Delete" style="font-size:12px;padding:4px 9px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer;margin-left:3px">🗑</button>';
    html+='<tr onclick="_mttsAgencyOpen(\''+idEsc+'\')" style="cursor:pointer">'+
      '<td style="'+td+';color:var(--text3);font-family:var(--mono)">'+(i+1)+'</td>'+
      '<td style="'+td+';font-weight:700">'+(a.name||'—')+
        (a.address?'<div style="font-size:11px;color:var(--text3);font-weight:500;margin-top:2px">'+String(a.address).replace(/</g,'&lt;').replace(/\n/g,', ')+'</div>':'')+'</td>'+
      '<td style="'+td+';font-size:13px">'+(a.contactName||'—')+'</td>'+
      '<td style="'+td+';font-size:12px">'+(a.email?'<div>📧 '+a.email+'</div>':'')+(phones?'<div>📞 '+phones+'</div>':'')+(!a.email&&!phones?'<span style="color:var(--text3)">—</span>':'')+'</td>'+
      '<td style="'+td+'">'+primChips+'</td>'+
      '<td style="'+td+'">'+(a.inactive?'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#fee2e2;color:#7f1d1d">Inactive</span>':'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:800;background:#dcfce7;color:#15803d">Active</span>')+'</td>'+
      '<td style="'+td+';text-align:center;white-space:nowrap">'+actions+'</td>'+
    '</tr>';
  });
  html+='</tbody></table></div>';
  return html;
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
  var canEdit=_mttsHasAccess('action.editAgency');
  if(!canEdit&&id===''){notify('You do not have permission to add agencies',true);return;}
  var a=id?(byId(DB.mttsAgencies||[],id)||null):null;
  document.getElementById('mttsAgencyTitle').textContent=a?(canEdit?'🤝 Edit Agency':'🤝 View Agency'):'🤝 Add Agency';
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
    _mttsLockModal(modal,canEdit);
    var saveBtn=modal.querySelector('button.btn-primary');
    if(saveBtn) saveBtn.style.display=canEdit?'':'none';
    if(modal._mttsKeyHandler) modal.removeEventListener('keydown',modal._mttsKeyHandler);
    modal._mttsKeyHandler=function(ev){
      if(modal.style.display==='none'||!modal.classList.contains('open')) return;
      if(ev.key==='Escape'){ev.preventDefault();cm('mMttsAgency');return;}
      if(ev.key==='Enter'){
        if(!canEdit){ev.preventDefault();cm('mMttsAgency');return;}
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

