/** @file vms-ui.js — UI layer for the Vehicle Management System @depends common.js, app-logic.js */

// ═══ GUARD / DEPENDENCY CHECK ═════════════════════════════════════════════
var _commonMissing=(typeof _COMMON_LOADED==='undefined');
if(_commonMissing){
  console.error('js/common.js not loaded');
  document.addEventListener('DOMContentLoaded',function(){
    var lp=document.getElementById('loginPage');if(lp)lp.style.display='flex';
    var err=document.getElementById('loginError');
    if(err){err.textContent='⚠ App file missing: js/common.js not found.';err.style.display='block';}
  });
}

// Update last sync timestamp display
function _vmsUpdateSyncTime(){
  window._vmsLastSyncTs=Date.now();
  var el=document.getElementById('vmsLastSync');
  if(!el) return;
  var d=new Date();
  var h=d.getHours(),m=d.getMinutes();
  var ampm=h>=12?'PM':'AM';
  h=h%12||12;
  var timeStr=h+':'+String(m).padStart(2,'0')+ampm;
  var mon=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var dateStr=d.getDate()+'-'+mon[d.getMonth()];
  el.textContent='⟳ '+dateStr+' '+timeStr;
  el.title='Last synced: '+d.toLocaleString();
}

// Helper: location pill style — colored bg if colour set, border-only if not
function _locPillStyle(colour,fs){
  const sz=fs||13;
  if(colour&&colour!=='var(--accent)')return `background:${colour};color:${colourContrast(colour)};padding:2px 9px;border-radius:4px;font-size:${sz}px;font-weight:700;white-space:nowrap`;
  return `background:transparent;color:var(--text);padding:2px 9px;border-radius:4px;font-size:${sz}px;font-weight:700;white-space:nowrap;border:1.5px solid var(--border2)`;
}
// ── Post-boot migration: fix step 3 skip for KAP→External segments ──────────
// Older segments may have steps[3].skip=false even when destination is External.
// This runs once at boot after all data is loaded.
function _migrateStep3Skip(){
  let fixed=0;
  (DB.segments||[]).forEach(seg=>{
    if(!seg.steps||!seg.steps[3]) return;
    if(seg.steps[3].done) return; // already completed, don't touch
    const dLoc=byId(DB.locations,seg.dLoc);
    const dtype=dLoc?.type||'';
    const shouldSkip=(dtype==='External');
    if(shouldSkip && !seg.steps[3].skip){
      seg.steps[3].skip=true;
      seg.steps[3].users=[];
      seg.steps[3].loc=null;
      seg.steps[3].ownerLoc=null;
      // Recalculate currentStep
      const ns=nextStep(seg);
      if(seg.currentStep!==ns) seg.currentStep=ns;
      if(allStepsDone(seg)&&seg.status!=='Completed') seg.status='Completed';
      _dbSave('segments',seg).catch(()=>{});
      fixed++;
    }
  });
  if(fixed) console.log('_migrateStep3Skip: fixed '+fixed+' segment(s)');
}

let _currentApp='vms'; // 'vms' or 'security' — tracks which app is active
function _showLogin(prefillUser){
  // If running from file://, show login directly (no portal)
  if(location.protocol==='file:'){
    const lp=document.getElementById('loginPage');if(lp)lp.style.display='flex';
    const lu=document.getElementById('loginUser');if(lu&&prefillUser)lu.value=prefillUser;
    return;
  }
  _navigateTo('index.html');
}
function _tryAutoLogin(user){
  try{
    CU=user; _enrichCU();
    document.getElementById('loginPage').style.display='none';
    // Check if launched from Portal with ?app= parameter — skip portal view, go straight to app
    var urlApp=(new URLSearchParams(window.location.search)).get('app');
    if(urlApp){
      // Clean URL (remove ?app= so refresh doesn't re-trigger)
      try{history.replaceState(null,'',window.location.pathname);}catch(e){}
      launchVMS(null, urlApp);
    } else {
      // No app parameter — on file:// launch VMS directly; otherwise go to portal
      if(location.protocol==='file:'){
        launchVMS(null,'vms');
      } else {
        _navigateTo('index.html');
      }
      return true;
    }
    // Password strength check handled at login time (not session restore)
    return true;
  }catch(e){
    console.error('Auto-login error:',e);
    CU=null;
    _showLogin();
    return false;
  }
}
// URL-based force reset: open the file with ?reset in the URL
if(location.search.includes('reset')){
  try{ localStorage.clear(); sessionStorage.clear(); }catch(e){}
  history.replaceState(null,'',location.pathname);
  location.reload();
}

function _applyPhotoInputMode(){
  // Set capture="environment" on ALL devices for all photo inputs
  // (including inputs without data-photo attribute)
  document.querySelectorAll('input[type="file"][accept*="image"]').forEach(inp=>{
    inp.setAttribute('capture','environment');
  });
}
function _photoAccept(){ return 'image/*'; }

// ═══ DATA SYNC (demand-driven, photo-excluded, incremental) ═════════════
var _loadedTables={};

var _PAGE_TABLES={
  'pageDashboard':['trips','segments','locations','drivers','vehicles','vehicleTypes','vendors'],
  'pageTripBooking':['trips','segments','locations','drivers','vehicles','vehicleTypes','vendors','tripRates'],
  'pageKapSecurity':['trips','segments','spotTrips','locations','drivers','vehicles','vehicleTypes','vendors'],
  'pageUsers':[],
  'pageDrivers':['drivers','vendors'],
  'pageVehicles':['vehicles','vehicleTypes','vendors'],
  'pageLocations':['locations'],
  'pageTripRates':['tripRates','vehicleTypes','locations'],
  'pageVTypes':['vehicleTypes'],
  'pageVendors':['vendors'],
  'pageMR':['trips','segments','locations'],
  'pageApprove':['tripRates','vehicleTypes','locations'],
  'pageProfile':[],
  'pageVendorTrips':['trips','segments','vendors'],
  'pageHelper':[]
};

async function _demandLoad(tables){
  if(!_sbReady||!_sb) return;
  var needed=tables.filter(function(t){return !_loadedTables[t]&&SB_TABLES[t];});
  if(!needed.length) return;
  var results=await Promise.all(needed.map(async function(tbl){
    var sbTbl=SB_TABLES[tbl];
    try{
      var sel=_syncSelect(sbTbl);
      var res=await _sb.from(sbTbl).select(sel);
      if(res.error){console.warn('demandLoad '+tbl+':',res.error.message);return null;}
      return {tbl:tbl,rows:res.data||[]};
    }catch(e){return null;}
  }));
  results.filter(Boolean).forEach(function(r){
    var parsed=r.rows.map(function(row){return _fromRow(r.tbl,row);}).filter(Boolean);
    _syncMergeRows(r.tbl,parsed,true);
    _loadedTables[r.tbl]=true;
  });
  console.log('📦 Demand loaded: '+needed.join(', '));
  // Update badges immediately after demand load
  try{if(typeof updBadges==='function') updBadges();}catch(e){}
}

// _getLoadedTables → moved to vms-logic.js

// ═══ PHOTO-EXCLUDED SYNC ═════════════════════════════════════════════════
// Exclude large photo columns from sync queries to reduce egress ~80%.
// Photos loaded on-demand when user opens a record.
// Low-volume tables (users, drivers) keep photos in sync for instant display.
// Only exclude photo columns from tables that have them. Other tables use select('*').
// _SYNC_SELECT → moved to vms-logic.js

// Load full segment steps (with photos) on demand
async function _loadSegmentSteps(segCode){
  if(!_sb||!_sbReady) return null;
  try{
    var {data,error}=await _sb.from('vms_segments').select('steps').eq('code',segCode).single();
    if(error||!data) return null;
    var seg=(DB.segments||[]).find(function(s){return s.id===segCode;});
    if(seg) seg.steps=data.steps||{};
    return data.steps||{};
  }catch(e){return null;}
}
// _stripStepPhotos → moved to vms-logic.js

// ── Date filtering: only fetch recent data, load history on-demand ──
// _DATE_FILTER_DAYS → moved to vms-logic.js

// Auto-load older data if user selects a date beyond loaded range
function _vmsEnsureDataForDate(fromDate,cb){
  if(!fromDate){if(cb)cb();return;}
  var cutoff=_dateCutoff();
  if(fromDate>=cutoff){if(cb)cb();return;}
  var daysNeeded=Math.ceil((new Date(cutoff+'T00:00:00')-new Date(fromDate+'T00:00:00'))/(86400000))+7;
  Promise.all(['trips','segments','spotTrips'].map(function(t){return _loadOlderData(t,daysNeeded);})).then(function(){if(cb)cb();});
}
// Supabase table name → date column name
// _DATE_FILTER_COL → moved to vms-logic.js
var _dateFilterLoaded={}; // tbl → earliest date loaded (ISO string)

// _dateCutoff → moved to vms-logic.js

// _applyDateFilter is in common.js

// Load older data beyond the current cutoff
async function _loadOlderData(localTbl,extraDays){
  var sbTbl=SB_TABLES[localTbl];
  var col=_DATE_FILTER_COL[sbTbl];
  if(!sbTbl||!col||!_sbReady||!_sb) return 0;
  var currentCutoff=_dateFilterLoaded[localTbl]||_dateCutoff();
  var newDays=(extraDays||60)+_DATE_FILTER_DAYS;
  var newCutoff=_dateCutoff(newDays);
  if(newCutoff>=currentCutoff) return 0; // already have this range
  showSpinner('Loading older records…');
  try{
    var sel=_syncSelect(sbTbl);
    // Fetch records between newCutoff and currentCutoff
    var res=await _sb.from(sbTbl).select(sel).gte(col,newCutoff).lt(col,currentCutoff);
    if(res.error||!res.data){hideSpinner();return 0;}
    var parsed=res.data.map(function(row){return _fromRow(localTbl,row);}).filter(Boolean);
    // Merge into existing DB
    var arr=DB[localTbl]||[];
    var idMap={};for(var i=0;i<arr.length;i++)idMap[arr[i].id]=i;
    var added=0;
    parsed.forEach(function(rec){
      if(idMap[rec.id]===undefined){arr.push(rec);added++;}
    });
    DB[localTbl]=arr;
    _dateFilterLoaded[localTbl]=newCutoff;
    _DATE_FILTER_DAYS=newDays; // expand window for future syncs
    if(added>0&&!_kapPopupOpen) _onRefreshViews();
    console.log('📜 Loaded '+added+' older '+localTbl+' records (back to '+newCutoff+')');
    return added;
  }catch(e){console.warn('_loadOlderData error:',e.message);return 0;}
  finally{hideSpinner();}
}
var _PHOTO_PRESERVE={
  'spotTrips':['challanPhoto','driverPhoto','entryVehiclePhoto','exitVehiclePhoto'],
  'trips':['photo1','photo2','photo3']
};
var _PHOTO_DB_COLS={
  'vms_spot_trips':['challan_photo','driver_photo','entry_vehicle_photo','exit_vehicle_photo']
};
// _syncSelect → moved to vms-logic.js

// _syncMergeRows → moved to vms-logic.js

async function _loadPhotos(localTbl,recordId){
  var sbTbl=SB_TABLES[localTbl];var photoCols=_PHOTO_DB_COLS[sbTbl];
  if(!sbTbl||!photoCols||!photoCols.length||!_sbReady||!_sb) return null;
  var rec=byId(DB[localTbl]||[],recordId);if(!rec) return null;
  var jsFields=_PHOTO_PRESERVE[localTbl]||[];
  if(jsFields.length&&jsFields.every(function(f){return !!rec[f];})) return rec;
  try{
    var res=await _sb.from(sbTbl).select('code,'+photoCols.join(',')).eq('code',recordId).limit(1);
    if(res.error||!res.data||!res.data.length) return rec;
    var mapped=_fromRow(localTbl,res.data[0]);
    if(mapped) jsFields.forEach(function(f){if(mapped[f])rec[f]=mapped[f];});
    return rec;
  }catch(e){return rec;}
}

// ═══ INCREMENTAL SYNC OPTIMIZATION ═══════════════════════════════════════
var _vmsIncr={lastTs:{},mode:'unknown',skipCount:0,lastSaveAt:0,probed:false};

var _origDbSave2=typeof _dbSave==='function'?_dbSave:null;
if(_origDbSave2){_dbSave=async function(tbl,record){var result=await _origDbSave2(tbl,record);if(result)_vmsIncr.lastSaveAt=Date.now();return result;};}

async function _vmsProbeIncremental(){
  if(_vmsIncr.probed)return;_vmsIncr.probed=true;
  var sbTbl=SB_TABLES[_HOT_TABLES[0]];
  if(!sbTbl||!_sbReady||!_sb){_vmsIncr.mode='full';return;}
  try{var res=await _sb.from(sbTbl).select('updated_at').limit(1);
    if(res.error){console.warn('⚠ VMS Hot: probe failed →',res.error.message);_vmsIncr.mode='full';}
    else{_vmsIncr.mode='incremental';console.log('✅ VMS Hot: incremental mode active');}
  }catch(e){_vmsIncr.mode='full';}
}

var _origBgSyncHot2=typeof _bgSyncHot==='function'?_bgSyncHot:null;
_bgSyncHot=function(){
  if(!_sbReady||!_sb)return;if(Date.now()-_vmsIncr.lastSaveAt<5000)return;
  if(_vmsIncr.mode==='unknown'){_vmsProbeIncremental().then(function(){if(_vmsIncr.mode==='incremental')_vmsIncrSyncHot();else if(_origBgSyncHot2)_origBgSyncHot2();});return;}
  if(_vmsIncr.mode==='full'){_vmsIncr.skipCount++;if(_vmsIncr.skipCount%3!==0)return;if(_origBgSyncHot2)_origBgSyncHot2();return;}
  _vmsIncrSyncHot();
};

function _vmsIncrSyncHot(){
  var now=new Date().toISOString();
  var hotLoaded=_HOT_TABLES.filter(function(t){return _loadedTables[t];});
  if(!hotLoaded.length) return;
  Promise.all(hotLoaded.map(async function(tbl){
    var sbTbl=SB_TABLES[tbl];if(!sbTbl)return null;
    var lastTs=_vmsIncr.lastTs[tbl]||new Date(Date.now()-35000).toISOString();
    try{var res=await _sb.from(sbTbl).select(_syncSelect(sbTbl)).gt('updated_at',lastTs);
      if(res.error)return null;return{tbl:tbl,rows:res.data||[]};
    }catch(e){return null;}
  })).then(function(results){
    if(!results)return;var tc=0;
    results.filter(Boolean).forEach(function(r){_vmsIncr.lastTs[r.tbl]=now;if(!r.rows.length)return;tc+=r.rows.length;
      var parsed=r.rows.map(function(row){return _fromRow(r.tbl,row);}).filter(Boolean);
      if(r.tbl==='segments') _stripStepPhotos(parsed);
      _syncMergeRows(r.tbl,parsed,false);
    });
    if(tc>0){_bgSyncDone=true;if(_sbStatus!=='ok')_sbSetStatus('ok');_vmsUpdateSyncTime();try{updBadges();}catch(e){}if(!_kapPopupOpen)_onRefreshViews();}
  }).catch(function(e){console.warn('VMS hot sync error:',e.message);});
}

// Full sync override — incremental on all tables, true full every 5th call
var _origBgSyncFull2=typeof _bgSyncFromSupabase==='function'?_bgSyncFromSupabase:null;
var _vmsFullIncr={lastTs:{},callCount:0,mode:'unknown',probed:false};

async function _vmsProbeFullIncr(){
  if(_vmsFullIncr.probed)return;_vmsFullIncr.probed=true;
  try{var res=await _sb.from('vms_users').select('updated_at').limit(1);
    _vmsFullIncr.mode=res.error?'full':'incremental';
    console.log(_vmsFullIncr.mode==='incremental'?'✅ VMS Full: incremental (all tables)':'⚠ VMS Full: standard');
  }catch(e){_vmsFullIncr.mode='full';}
}

_bgSyncFromSupabase=function(){
  if(!_sbReady||!_sb)return;
  if(!_vmsFullIncr.probed){_vmsProbeFullIncr().then(function(){_vmsDoFullSync();});return;}
  _vmsDoFullSync();
};

function _vmsDoFullSync(){
  _vmsFullIncr.callCount++;
  var loaded=_getLoadedTables();
  var at=loaded.length?loaded:_getActiveTables();
  var trueFull=_vmsFullIncr.mode==='full'||_vmsFullIncr.callCount%5===0;

  // Both true-full and incremental use photo-excluded selects
  var now=new Date().toISOString();
  var isIncr=!trueFull;
  var cutoff=_dateCutoff();
  Promise.all(at.map(async function(tbl){
    var sbTbl=SB_TABLES[tbl];if(!sbTbl)return null;
    try{
      var q=_sb.from(sbTbl).select(_syncSelect(sbTbl));
      q=_applyDateFilter(q,sbTbl,cutoff);
      if(isIncr){var lastTs=_vmsFullIncr.lastTs[tbl]||new Date(Date.now()-90000).toISOString();q=q.gt('updated_at',lastTs);}
      var res=await q;if(res.error)return null;return{tbl:tbl,rows:res.data||[]};
    }catch(e){return null;}
  })).then(function(results){
    if(!results)return;var tc=0;
    results.filter(Boolean).forEach(function(r){
      _vmsFullIncr.lastTs[r.tbl]=now;
      if(!r.rows.length&&isIncr)return;
      tc+=r.rows.length;
      var parsed=r.rows.map(function(row){return _fromRow(r.tbl,row);}).filter(Boolean);
      if(r.tbl==='segments') _stripStepPhotos(parsed);
      _syncMergeRows(r.tbl,parsed,trueFull);
    });
    (_HOT_TABLES||[]).forEach(function(t){_vmsIncr.lastTs[t]=now;});
    _bgSyncDone=true;if(_sbStatus!=='ok')_sbSetStatus('ok');
    _vmsUpdateSyncTime();
    // Update badges immediately when data arrives
    try{updBadges();}catch(e){}
    if(!_kapPopupOpen)_onRefreshViews();
    if(tc>0||trueFull)console.log('📡 VMS '+(trueFull?'true full':'incr full')+' sync: '+tc+' rows');
  }).catch(function(e){console.warn('VMS full sync error:',e.message);});
}

// Override bootDB to use photo-excluded selects on initial load
var _origBootDB=typeof bootDB==='function'?bootDB:null;
bootDB=async function(){
  console.log('bootDB(VMS): starting...');

  if(!_origBootDB){
    console.warn('bootDB(VMS): _origBootDB not available');
    return;
  }

  // ── Step 0: Check localStorage cache from Portal ────────────────────────
  try{
    var _cached=localStorage.getItem('kap_db_cache');
    if(_cached){
      var _cObj=JSON.parse(_cached);
      var _age=Date.now()-(_cObj.ts||0);
      if(_age<60000){
        Object.keys(_cObj).forEach(function(t){if(t!=='ts'&&Array.isArray(_cObj[t]))DB[t]=_cObj[t];});
        localStorage.removeItem('kap_db_cache');
        if((DB.users||[]).length>0){
          console.log('bootDB(VMS): instant from cache — users='+(DB.users||[]).length);
          if(typeof _vmsUpdateSyncTime==='function')_vmsUpdateSyncTime();
          if(typeof _initSupabase==='function'&&!_sbReady) _initSupabase();
          if(_sbReady&&_sb){
            if(typeof _sbSetStatus==='function') _sbSetStatus('ok');
            if(typeof _sbStartRealtime==='function') _sbStartRealtime();
            // Immediate full sync — no delay, skip probe for faster data load
            _vmsFullIncr.callCount=4;
            _vmsFullIncr.mode='full'; _vmsFullIncr.probed=true;
            setTimeout(function(){_vmsDoFullSync();},100);
          } else {
            if(typeof _startBgReconnect==='function') _startBgReconnect(true);
          }
          if(typeof _onPostBoot==='function') _onPostBoot();
          return;
        }
      } else { localStorage.removeItem('kap_db_cache'); }
    }
  }catch(e){console.warn('bootDB(VMS): cache error:',e.message);}

  // ── Step 1: Use original bootDB (most reliable) ────────────────────────
  console.log('bootDB(VMS): calling original bootDB...');
  try{
    await _origBootDB();
    console.log('bootDB(VMS): original bootDB completed, users='+(DB.users||[]).length);
    if(typeof _vmsUpdateSyncTime==='function')_vmsUpdateSyncTime();
  }catch(e){
    console.error('bootDB(VMS): original bootDB failed:',e);
  }
};

async function _appBoot(){
  console.log('VMS: _appBoot starting...');
  var splash=document.getElementById('dbSplash');
  // Set all VMS tables before boot
  if(typeof _APP_TABLES!=='undefined') _APP_TABLES=['users','vehicleTypes','drivers','vendors','vehicles','locations','tripRates','trips','segments','spotTrips'];
  // Add essential lookup tables to hot sync so they load immediately
  if(typeof _HOT_TABLES!=='undefined') _HOT_TABLES=['trips','segments','spotTrips','vehicles','drivers','locations','vendors'];

  try{
    await bootDB();
  }catch(e){
    console.error('VMS: bootDB error',e);
  }

  console.log('VMS: bootDB completed, users='+(DB.users||[]).length+' trips='+(DB.trips||[]).length);

  try{
    _getActiveTables().forEach(function(t){
      if(DB[t]&&DB[t].length>0) _loadedTables[t]=true;
    });
  }catch(e){}

  if(splash) splash.style.display='none';
  try{ _applyPhotoInputMode(); }catch(e){}
  
  // Check session — use cached user (synchronous, no RPC needed)
  var ss=_sessionGet('kap_session_user')||localStorage.getItem('kap_rm_user');
  var st=_sessionGet('kap_session_token')||localStorage.getItem('kap_rm_token');
  console.log('VMS: checking session, user=',ss||'none','token=',st?'yes':'no');
  if(ss&&st){
    var user=null;
    // Restore from cached user object (set during portal login)
    try{var _cu=localStorage.getItem('kap_current_user');if(_cu){user=JSON.parse(_cu);if(!user||user.name.toLowerCase()!==ss.toLowerCase())user=null;}}catch(e){user=null;}
    // Fallback: find in DB.users loaded from cache
    if(!user) user=(DB.users||[]).find(function(u){return u&&u.name&&u.name.toLowerCase()===ss.toLowerCase();});
    if(user){
      console.log('VMS: session restored, auto-login');
      if(_tryAutoLogin(user)) return;
    } else {
      console.log('VMS: session user not found, clearing');
      _sessionDel('kap_session_user');_sessionDel('kap_session_token');
      try{localStorage.removeItem('kap_rm_user');localStorage.removeItem('kap_rm_token');}catch(e){}
    }
  }
  _showLogin(ss||'');
}

function launchVMS(targetPage, appId){
  _currentApp = appId || 'vms';
  _sbStopPing();
  // _sbStartRealtime is already called by bootDB — don't call it again here.
  // Calling it twice causes duplicate _startBgPoll timers (stacking 10s polls).
  const appEl = document.getElementById('app');
  const tb = document.getElementById('topbar');
  if(appEl) appEl.style.display = 'block';
  if(tb) tb.style.display = 'flex';
  initApp();
  if(targetPage) showPage(targetPage, targetPage.replace('page',''));
}

// ═══ NAVIGATION / PORTAL ═════════════════════════════════════════════════
function renderMyApps(){
  var wb=document.getElementById('welcomeBanner');
  if(wb) wb.textContent='Welcome, '+(CU.fullName||CU.name);
  var grid=document.getElementById('vmsAppGrid');
  if(!grid) return;
  var userApps=CU.apps||[];
  var isAdmin=(CU.roles||[]).some(function(r){return r==='Super Admin'||r==='Admin';});
  var APP_FILES_MAP={vms:null,hwms:'hwms.html',security:'security.html',maintenance:null,review:null,hrms:'hrms.html'};
  var APP_ACTIVE_MAP={vms:true,hwms:true,security:true,maintenance:false,review:false,hrms:true};
  grid.innerHTML=PORTAL_APPS.map(function(app){
    var file=APP_FILES_MAP[app.id]||null;
    var active=APP_ACTIVE_MAP[app.id]||false;
    var hasAccess=isAdmin||userApps.includes(app.id);
    var enabled=active&&hasAccess;
    var onclick='';
    if(enabled){
      if(app.id==='vms') onclick='onclick="showPage(\'pageDashboard\',\'Dashboard\')"';
      else if(file) onclick='onclick="_navigateTo(\''+file+'\')"';
    }
    return '<div style="background:#fff;border:1.5px solid '+(enabled?'var(--border)':'#e2e8f0')+';border-radius:16px;padding:28px 20px;text-align:center;cursor:'+(enabled?'pointer':'not-allowed')+';opacity:'+(enabled?'1':'.5')+';transition:all .2s;box-shadow:0 1px 3px rgba(0,0,0,.04)" '+(enabled?'onmouseenter="this.style.borderColor=\'var(--accent)\';this.style.boxShadow=\'0 4px 16px rgba(42,154,160,.12)\'" onmouseleave="this.style.borderColor=\'var(--border)\';this.style.boxShadow=\'0 1px 3px rgba(0,0,0,.04)\'"':'')+' '+onclick+'>'
      +'<div style="font-size:36px;margin-bottom:10px">'+app.icon+'</div>'
      +'<div style="font-size:14px;font-weight:800;color:#1a2033;margin-bottom:4px">'+app.label+'</div>'
      +'<div style="font-size:11px;color:#64748b;margin-bottom:10px">'+app.full+'</div>'
      +'<span style="font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;'+(active?(hasAccess?'background:#ecfdf5;color:#059669':'background:#fef3c7;color:#d97706'):'background:#f1f5f9;color:#94a3b8')+'">'+(active?(hasAccess?'Active':'No Access'):'Coming Soon')+'</span>'
      +'</div>';
  }).join('');
  // Update topbar title
  var tbt=document.getElementById('topbarTitle');
  if(tbt) tbt.textContent='My Apps';
}

async function correctData(){
  const btn=document.getElementById('btnCorrectData');
  if(btn){btn.innerHTML='<span>⏳</span><span>Checking…</span>';btn.style.pointerEvents='none';}
  let fixedSegs=0, fixedTrips=0, fixedUsers=0, fixedLocs=0;
  const segs=DB.segments||[];

  // ── STEP 0A: Normalise User IDs → 1, 2, 3… (integer strings) ──────────────
  // Only renumber if any user ID does not already match /^U\d+$/
  const usersNeedRenumber=DB.users.some(u=>!/^\d+$/.test(u.id));
  const locsNeedRenumber=DB.locations.some(l=>!/^\d+$/.test(l.id));
  const userIdMap=new Map(); // oldId → newId
  const locIdMap=new Map();  // oldId → newId

  if(usersNeedRenumber){
    [...DB.users].sort((a,b)=>a.name.localeCompare(b.name)).forEach((u,i)=>{
      const nid=String(i+1);
      if(u.id!==nid) userIdMap.set(u.id,nid);
    });
  }

  // ── STEP 0B: Normalise Location IDs → 1, 2, 3… (integer strings) ────────
  if(locsNeedRenumber){
    [...DB.locations].sort((a,b)=>a.name.localeCompare(b.name)).forEach((l,i)=>{
      const nid=String(i+1);
      if(l.id!==nid) locIdMap.set(l.id,nid);
    });
  }

  if(userIdMap.size>0||locIdMap.size>0){
    const _mu=(id)=>id?(userIdMap.get(id)||id):id;
    const _ml=(id)=>id?(locIdMap.get(id)||id):id;
    const _mua=(arr)=>(arr||[]).map(_mu);

    // ── Apply user ID changes ─────────────────────────────────────────────
    DB.users.forEach(u=>{
      const nid=_mu(u.id);
      if(nid!==u.id){u._oldId=u.id;u.id=nid;fixedUsers++;}
    });

    // ── Apply location ID changes + fix user refs within locations ────────
    DB.locations.forEach(l=>{
      const nid=_ml(l.id);
      if(nid!==l.id){l._oldId=l.id;l.id=nid;fixedLocs++;}
      l.kapSec=_mu(l.kapSec||'')||'';
      l.tripBook=_mua(l.tripBook);
      l.matRecv=_mua(l.matRecv);
      l.approvers=_mua(l.approvers);
    });

    // ── Update tripRates: loc refs + user refs ────────────────────────────
    DB.tripRates.forEach(r=>{
      if(r.start)   r.start  =_ml(r.start);
      if(r.dest1)   r.dest1  =_ml(r.dest1);
      if(r.dest2)   r.dest2  =_ml(r.dest2);
      if(r.dest3)   r.dest3  =_ml(r.dest3);
      if(r.addedBy) r.addedBy=_mu(r.addedBy);
      if(r.approvedBy) r.approvedBy=_mu(r.approvedBy);
    });

    // ── Update trips: loc refs + user refs ───────────────────────────────
    DB.trips.forEach(t=>{
      if(t.startLoc)  t.startLoc =_ml(t.startLoc);
      if(t.dest1)     t.dest1    =_ml(t.dest1);
      if(t.dest2)     t.dest2    =_ml(t.dest2);
      if(t.dest3)     t.dest3    =_ml(t.dest3);
      if(t.bookedBy)  t.bookedBy =_mu(t.bookedBy);
      if(t.editedBy)  t.editedBy =_mu(t.editedBy);
    });

    // ── Update segments: loc refs + step user/loc refs ────────────────────
    DB.segments.forEach(s=>{
      if(s.sLoc) s.sLoc=_ml(s.sLoc);
      if(s.dLoc) s.dLoc=_ml(s.dLoc);
      Object.values(s.steps||{}).forEach(step=>{
        if(!step) return;
        if(step.loc)      step.loc      =_ml(step.loc);
        if(step.ownerLoc) step.ownerLoc =_ml(step.ownerLoc);
        if(step.by)       step.by       =_mu(step.by);
        if(step.users)    step.users    =_mua(step.users);
      });
    });

    // ── Update spotTrips: loc ref + user refs ─────────────────────────────
    DB.spotTrips.forEach(st=>{
      if(st.location) st.location=_ml(st.location);
      if(st.entryBy)  st.entryBy =_mu(st.entryBy);
      if(st.exitBy)   st.exitBy  =_mu(st.exitBy);
    });

    // ── Update CU (logged-in user) if their ID changed ────────────────────
    if(CU&&userIdMap.has(CU.id)) CU.id=userIdMap.get(CU.id);

    // ── Enqueue saves: new records → then delete old ID records ──────────
    // Users with changed IDs: insert new, delete old
    for(const u of DB.users){if(u._oldId){await _dbSave('users',u);await _dbDel('users',u._oldId);delete u._oldId;}}
    // Locations with changed IDs: insert new, delete old
    for(const l of DB.locations){if(l._oldId){await _dbSave('locations',l);await _dbDel('locations',l._oldId);delete l._oldId;}}
    // Re-save all records whose foreign key references may have changed
    for(const r of DB.tripRates){await _dbSave('tripRates',r);}
    for(const t of DB.trips){await _dbSave('trips',t);}
    for(const s of DB.segments){await _dbSave('segments',s);}
    for(const st of DB.spotTrips){await _dbSave('spotTrips',st);}
    // Re-save locations that had user-ref changes (already saved those with new IDs above;
    // also save locations whose IDs were NOT changed but whose user refs may have updated)
    for(const l of DB.locations.filter(l=>!l._oldId)){await _dbSave('locations',l);}
  }

  // ── STEP 1: Group segments by tripId, sorted A→B→C ──────────────────────
  const segsByTrip=new Map();
  segs.forEach(s=>{
    if(!segsByTrip.has(s.tripId)) segsByTrip.set(s.tripId,[]);
    segsByTrip.get(s.tripId).push(s);
  });
  segsByTrip.forEach(arr=>arr.sort((a,b)=>a.label.localeCompare(b.label)));

  // ── STEP 2: Correct TRIP route fields from segment chain ─────────────────
  // Segments are the source of truth for the actual route.
  // Reconstruct trip.startLoc, dest1, dest2, dest3 from the segment chain:
  //   startLoc = segA.sLoc, dest1 = segA.dLoc, dest2 = segB.dLoc, dest3 = segC.dLoc
  const tripsToSave=[];
  segsByTrip.forEach((tripSegs,tid)=>{
    const trip=byId(DB.trips,tid);
    if(!trip) return;
    const segA=tripSegs.find(s=>s.label==='A');
    const segB=tripSegs.find(s=>s.label==='B');
    const segC=tripSegs.find(s=>s.label==='C');
    if(!segA) return;

    const newStart=segA.sLoc||'';
    const newD1=segA.dLoc||'';
    const newD2=segB?(segB.dLoc||''):'';
    const newD3=segC?(segC.dLoc||''):'';
    const newCatId=segA.tripCatId||trip.tripCatId||'';

    let tripChanged=false;
    if(trip.startLoc!==newStart&&newStart){trip.startLoc=newStart;tripChanged=true;}
    if(trip.dest1!==newD1&&newD1){trip.dest1=newD1;tripChanged=true;}
    if((trip.dest2||'')!==newD2){trip.dest2=newD2;tripChanged=true;}
    if((trip.dest3||'')!==newD3){trip.dest3=newD3;tripChanged=true;}
    if(trip.tripCatId!==newCatId&&newCatId){trip.tripCatId=newCatId;tripChanged=true;}

    if(tripChanged){
      tripsToSave.push(trip);
      fixedTrips++;
      console.log('correctData trip',tid,'→ start:'+trip.startLoc,'d1:'+trip.dest1,'d2:'+trip.dest2,'d3:'+trip.dest3);
    }
  });

  // ── STEP 3: Recalculate undone step assignments on every segment ──────────
  // Must run AFTER trip fields are corrected above (recalcSegSteps reads trip.dest2/3)
  const segsToSave=[];
  for(const seg of segs){
    if(!seg.steps||seg.status==='Cancelled') continue;
    const siblings=segsByTrip.get(seg.tripId)||[];
    const changed=recalcSegSteps(seg,siblings);
    // Also save if step 5 was just backfilled (created by _fromRow for old records)
        const hadBackfill=seg.steps[5]?._backfilled;
    if(hadBackfill){delete seg.steps[5]._backfilled;}
    if(changed||hadBackfill){
      segsToSave.push(seg);
      fixedSegs++;
      console.log('correctData seg',seg.id,'→ step',seg.currentStep,'status',seg.status,'s5skip',seg.steps[5]?.skip);
    }
  }

  // ── STEP 4: Enqueue all saves ─────────────────────────────────────────────
  for(const t of tripsToSave){await _dbSave('trips',t);}
  for(const s of segsToSave){await _dbSave('segments',s);}

  if(btn){btn.innerHTML='<span>🔧</span><span>Correct Data</span>';btn.style.pointerEvents='';}
  const total=fixedTrips+fixedSegs+fixedUsers+fixedLocs;
  if(total===0) notify(`✅ All data correct (${DB.users.length} users, ${DB.locations.length} locs, ${DB.trips.length} trips, ${segs.length} segs) — nothing to fix`);
  else{
    const parts=[];
    if(fixedUsers) parts.push(`${fixedUsers} user ID${fixedUsers!==1?'s':''}`);
    if(fixedLocs)  parts.push(`${fixedLocs} location ID${fixedLocs!==1?'s':''}`);
    if(fixedTrips) parts.push(`${fixedTrips} trip route${fixedTrips!==1?'s':''}`);
    if(fixedSegs)  parts.push(`${fixedSegs} segment${fixedSegs!==1?'s':''}`);
    notify(`✅ Corrected ${parts.join(' + ')} — saving to cloud…`);
  }
  if(total>0){updBadges();renderDash();renderDashTrips();renderKap();renderMR();renderApprove();renderMyTrips();}
}
// ═══ PROCESS FLOW ENGINE ═════════════════════════════════════════════════
/*
  Step Ownership Logic (per segment, based on sLoc/dLoc types):
  ┌──────────┬──────────┬───────────────┬────────────────┬─────────────────┬────────────────┐
  │ sLoc     │ dLoc     │ Step1 Exit    │ Step2 Entry    │ Step3 Receipt   │ Step4 Approve  │
  ├──────────┼──────────┼───────────────┼────────────────┼─────────────────┼────────────────┤
  │ KAP      │ KAP      │ Start Loc     │ Dest Loc       │ Dest Loc        │ Start Loc      │
  │ KAP      │ External │ Start Loc     │ SKIP           │ Start Loc       │ Start Loc      │
  │ External │ KAP      │ SKIP          │ Dest Loc       │ Dest Loc        │ Booking User Loc│
  │ External │ External │ SKIP          │ SKIP           │ Booking User Loc│ Booking User Loc│
  └──────────┴──────────┴───────────────┴────────────────┴─────────────────┴────────────────┘
  "Location" means: use that location's assigned role users (kapSec, matRecv, approvers)
  "Booking User Loc" = the trip booker's plant/location from user master
*/
// getCriteria, getTripCatId, buildSegment, nextStep, allStepsDone, stepsOneAndTwoDone, stepsUpTo3Done → moved to vms-logic.js

// recalcSegSteps → moved to vms-logic.js
async function advance(seg){
  seg.currentStep=nextStep(seg);
  if(allStepsDone(seg)) seg.status='Completed';
  // Unlock next segment as soon as Steps 1 & 2 are done
  if(stepsOneAndTwoDone(seg)){
    const nextLabel={A:'B',B:'C'}[seg.label];
    if(nextLabel){
      const next=DB.segments.find(s=>s.tripId===seg.tripId&&s.label===nextLabel);
      if(next&&next.status==='Locked'){
        next.status='Active';next.date=new Date().toISOString();
        // Save the unlocked segment to Supabase — AWAIT so other users see it immediately
        await _dbSave('segments',next);
      }
    }
  }
}

function pfHTML(seg){
  const icons={1:'🚪',2:'🏁',3:'📦',4:'✅',5:'📤'};
  let h='<div class="pflow">';
  const maxStep=seg.steps[5]&&!seg.steps[5].skip?5:4;
  for(let s=1;s<=maxStep;s++){
    const st=seg.steps[s];
    if(!st) continue;
    let cls='wait';
    if(st.skip) cls='skip';
    else if(st.done) cls='done';
    else if(seg.currentStep===s) cls='active';
    const locPart=st.loc?' @ '+lname(st.loc):'';

    // User info line
    let userLine='';
    if(st.skip){
      userLine='<span class="pf-user pf-user-skip">—</span>';
    } else if(st.done && st.by){
      const byUser=byId(DB.users,st.by);
      const byName=byUser?.fullName||byUser?.name||st.by;
      const t=st.time?new Date(st.time).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true}):'';
      userLine=`<span class="pf-user pf-user-done">✓ ${byName}${t?'<br><span class="pf-time">'+t+'</span>':''}</span>`;
    } else if(st.users && st.users.length){
      const names=st.users.map(uid=>{const u=byId(DB.users,uid);return u?.fullName||u?.name||uid;});
      userLine=`<span class="pf-user pf-user-pending">👤 ${names.join(', ')}</span>`;
    }

    h+=`<div class="pf-step-wrap">
      <span class="pf-step ${cls}">${icons[s]} ${st.label}${locPart}</span>
      ${userLine}
    </div>`;
    if(s<maxStep) h+=`<span class="pf-arrow">➜</span>`;
  }
  h+='</div>';
  const cl={1:'KAP→KAP',2:'KAP→Ext',3:'Ext→KAP',4:'Ext→Ext'};
  h+=`<span class="c-badge">Criteria ${seg.criteria}: ${cl[seg.criteria]}</span>`;
  return h;
}

function segBadge(seg){
  if(seg.status==='Locked') return '<span class="badge badge-gray">🔒 Locked</span>';
  if(seg.status==='Completed')return '<span class="badge badge-green">✓ Completed</span>';
  if(seg.steps[4]?.rejected)return '<span class="badge badge-red">⚠ Rejected — Awaiting Re-approval</span>';
  const sl={1:'Gate Exit',2:'Gate Entry',3:'Mat. Receipt',4:'Trip Approval',5:'Empty Vehicle Exit'};
  return `<span class="badge badge-amber">Step ${seg.currentStep}: ${sl[seg.currentStep]||''}</span>`;
}


// ═══ AUTH / LOGIN / CAPTCHA ══════════════════════════════════════════════
function togglePassVis(){
  const el=document.getElementById('loginPass');
  const btn=document.getElementById('passToggle');
  if(el.type==='password'){el.type='text';btn.textContent='🙈';}
  else{el.type='password';btn.textContent='👁';}
}

// ── Math CAPTCHA + Lockout ─────────────────────────────────────────────────
let _captchaAnswer=0;
let _loginFailCount=0;
let _lockoutUntil=0;
let _lockoutInterval=null;
const _LOCKOUT_MAX=3;
const _LOCKOUT_SECS=60;

function _refreshCaptcha(){
  const ops=['+','-','×'];
  const op=ops[Math.floor(Math.random()*3)];
  let a,b,ans;
  if(op==='+'){a=Math.floor(Math.random()*20)+1;b=Math.floor(Math.random()*20)+1;ans=a+b;}
  else if(op==='-'){a=Math.floor(Math.random()*20)+5;b=Math.floor(Math.random()*a)+1;ans=a-b;}
  else{a=Math.floor(Math.random()*9)+2;b=Math.floor(Math.random()*9)+2;ans=a*b;}
  _captchaAnswer=ans;
  const qEl=document.getElementById('captchaQ');
  if(qEl) qEl.textContent=`${a} ${op} ${b}`;
  const aEl=document.getElementById('captchaAns');
  if(aEl){aEl.value='';aEl.classList.remove('input-error');}
  const eEl=document.getElementById('captchaErr');
  if(eEl) eEl.style.display='none';
}

function _startLockout(){
  _lockoutUntil=Date.now()+_LOCKOUT_SECS*1000;
  const banner=document.getElementById('lockoutBanner');
  const btn=document.getElementById('loginBtn');
  if(banner) banner.style.display='block';
  if(btn){btn.disabled=true;btn.style.opacity='.4';btn.style.cursor='not-allowed';}
  _lockoutInterval=setInterval(()=>{
    const rem=Math.max(0,Math.ceil((_lockoutUntil-Date.now())/1000));
    const timer=document.getElementById('lockoutTimer');
    if(timer) timer.textContent=rem;
    if(rem<=0){
      clearInterval(_lockoutInterval);_lockoutInterval=null;
      _loginFailCount=0;
      if(banner) banner.style.display='none';
      if(btn){btn.disabled=false;btn.style.opacity='';btn.style.cursor='';}
      _refreshCaptcha();
    }
  },1000);
}

function _isLockedOut(){ return Date.now()<_lockoutUntil; }

// Init captcha on page load
document.addEventListener('DOMContentLoaded',()=>_refreshCaptcha());

async function doLogin(){
  // Check database connection
  if(_sbStatus!=='ok'){
    document.getElementById('loginError').style.display='block';
    document.getElementById('loginError').textContent='Database not connected. Please wait for connection…';
    return;
  }
  // Stop retry timer
  if(_loginRetryTimer){clearInterval(_loginRetryTimer);_loginRetryTimer=null;}
  // Check lockout
  if(_isLockedOut()){
    document.getElementById('loginError').style.display='block';
    document.getElementById('loginError').textContent='Account locked. Please wait for the timer to expire.';
    return;
  }
  const u=document.getElementById('loginUser').value.toLowerCase().trim();
  const p=document.getElementById('loginPass').value;
  // Validate CAPTCHA first
  const userAns=parseInt(document.getElementById('captchaAns').value,10);
  if(isNaN(userAns)||userAns!==_captchaAnswer){
    document.getElementById('captchaErr').style.display='block';
    document.getElementById('captchaAns').classList.add('input-error');
    _refreshCaptcha();
    return;
  }
  document.getElementById('captchaErr').style.display='none';
  document.getElementById('captchaAns').classList.remove('input-error');
  // Server-side login via RPC
  showSpinner('Logging in…');
  var result=await _authLogin(u,p);
  hideSpinner();
  if(!result||!result.user){
    _loginFailCount++;
    if(_loginFailCount>=_LOCKOUT_MAX){
      _startLockout();
      document.getElementById('loginError').style.display='block';
      document.getElementById('loginError').textContent='Too many failed attempts. Locked for '+_LOCKOUT_SECS+' seconds.';
    } else {
      document.getElementById('loginError').style.display='block';
      document.getElementById('loginError').textContent='Invalid credentials ('+(_LOCKOUT_MAX-_loginFailCount)+' attempt'+((_LOCKOUT_MAX-_loginFailCount)!==1?'s':'')+' remaining)';
    }
    _refreshCaptcha();
    return;
  }
  var user=result.user;var token=result.token;
  if(user.inactive===true){
    document.getElementById('loginError').style.display='block';
    document.getElementById('loginError').textContent='This account has been deactivated. Contact your Admin.';
    _refreshCaptcha();
    return;
  }
  _loginFailCount=0;
  CU=user; _enrichCU();
  _sessionSet('kap_session_user',u);
  _sessionSet('kap_session_token',token);
  try{
    localStorage.setItem('kap_rm_user', u);
    localStorage.setItem('kap_rm_token', token);
    localStorage.setItem('kap_current_user', JSON.stringify(user));
  }catch(e){}
  document.getElementById('loginError').style.display='none';
  document.getElementById('loginPage').style.display='none';
  // Launch VMS app — go to Dashboard
  launchVMS(null, 'vms');
  // Force refresh views after short delay to ensure data renders
  // If core tables are empty, trigger a full reload
  setTimeout(async function(){
    try{
      // Check if core tables are loaded - if not, reload them
      var needsReload=(DB.trips||[]).length===0&&(DB.segments||[]).length===0&&(DB.locations||[]).length===0;
      if(needsReload){
        console.log('[doLogin] Core tables empty, triggering data reload...');
        showSpinner('Loading data…');
        try{
          await bootDB();
          console.log('[doLogin] Reload complete — trips='+((DB.trips||[]).length)+' segments='+((DB.segments||[]).length));
        }catch(e){console.warn('Reload error:',e);}
        hideSpinner();
      }
      updBadges();
      var activePage=document.querySelector('.page.active');
      if(activePage){
        var pid=activePage.id;
        var map={pageDashboard:renderDash,pageUsers:renderUsers,pageVTypes:renderVTypes,pageDrivers:renderDrivers,pageVendors:renderVendors,pageVehicles:renderVehicles,pageLocations:renderLocations,pageTripRates:renderRates,pageTripBooking:renderTripBooking,pageKapSecurity:renderKapPage,pageMR:renderMR,pageApprove:renderApprove,pageVendorTrips:renderVendorTrips,pageHelper:renderHelper};
        if(map[pid]) map[pid]();
      }
      // Auto-skip stale empty exits after data is loaded
      if(typeof _autoSkipStaleEmptyExits==='function') _autoSkipStaleEmptyExits();
    }catch(e){console.warn('Post-login render error:',e);}
  }, 300);
  // Check password strength OR if password is the default reset password — force change if needed
  if(!_isStrongPwd(p)||p===_RESET_PWD){
    _openForcePassModal();
    return;
  }
}

// ── Password Policy ──────────────────────────────────────────────────────────
// _isStrongPwd → moved to vms-logic.js
function _liveValidatePwd(pwd){
  const rules=[
    {id:'fpR1',ok:pwd.length>=6&&pwd.length<=12},
    {id:'fpR2',ok:/[A-Z]/.test(pwd)},
    {id:'fpR3',ok:/[a-z]/.test(pwd)},
    {id:'fpR4',ok:/[0-9]/.test(pwd)},
    {id:'fpR5',ok:/[^A-Za-z0-9]/.test(pwd)}
  ];
  const labels=['6–12 characters','One uppercase letter (A-Z)','One lowercase letter (a-z)','One number (0-9)','One special character'];
  rules.forEach((r,i)=>{
    const el=document.getElementById(r.id);
    if(el){
      el.textContent=(r.ok?'✅':'❌')+' '+labels[i];
      el.style.color=r.ok?'#16a34a':'#dc2626';
      el.style.fontWeight=r.ok?'600':'400';
    }
  });
}
function _toggleFpVis(inputId,btn){
  const inp=document.getElementById(inputId);
  if(!inp)return;
  const isPass=inp.type==='password';
  inp.type=isPass?'text':'password';
  btn.textContent=isPass?'🙈':'👁';
  btn.title=isPass?'Hide password':'Show password';
}
function _openForcePassModal(){
  document.getElementById('forceNewPass').value='';
  document.getElementById('forceConfPass').value='';
  document.getElementById('forcePassMsg').style.display='none';
  // Reset show/hide toggles
  document.getElementById('forceNewPass').type='password';
  document.getElementById('forceConfPass').type='password';
  // Populate user info
  if(CU){
    const fn=document.getElementById('fpFullName');
    const un=document.getElementById('fpUserName');
    const av=document.getElementById('fpUserAvatar');
    if(fn) fn.textContent=CU.fullName||CU.name||'';
    if(un) un.textContent='@'+CU.name;
    if(av){
      if(CU.photo){
        av.textContent='';av.style.backgroundImage='url('+CU.photo+')';av.style.backgroundSize='cover';av.style.backgroundPosition='center';
      } else {
        const initials=(CU.fullName||CU.name||'').trim().split(/\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase()||'👤';
        av.textContent=initials;av.style.backgroundImage='';
      }
    }
  }
  _liveValidatePwd('');
  om('mForcePass');
}
async function _doForceChangePass(){
  const newPwd=document.getElementById('forceNewPass').value;
  const confPwd=document.getElementById('forceConfPass').value;
  const msgEl=document.getElementById('forcePassMsg');
  const showErr=(msg)=>{msgEl.style.display='block';msgEl.style.background='#fee2e2';msgEl.style.color='#dc2626';msgEl.textContent=msg;};
  if(!newPwd||!confPwd){showErr('Please fill both password fields');return;}
  const errs=_pwdErrors(newPwd);
  if(errs.length){showErr('Password requires: '+errs.join(', '));return;}
  if(newPwd!==confPwd){showErr('Passwords do not match');return;}
  if(newPwd===_RESET_PWD){showErr('Cannot use the default password. Please choose a different one.');return;}
  // Server-side password change
  var oldPwd=document.getElementById('loginPass')?.value||_RESET_PWD;
  showSpinner('Updating password…');
  var ok=await _authChangePassword(CU.name,oldPwd,newPwd);
  hideSpinner();
  if(!ok){showErr('Failed to change password. Try again.');return;}
  var result=await _authLogin(CU.name,newPwd);
  if(result&&result.token){
    _sessionSet('kap_session_token',result.token);
    try{localStorage.setItem('kap_rm_token',result.token);localStorage.setItem('kap_current_user',JSON.stringify(result.user));}catch(e){}
  }
  cm('mForcePass');
  notify('🔐 Password updated successfully!');
}
function _forcePassSignOut(){
  cm('mForcePass');
  doLogout();
}

// ── Admin: Reset user password ───────────────────────────────────────────────
const _RESET_PWD='Kappl@123';
async function _resetUserPwd(userId){
  const u=byId(DB.users,userId);if(!u)return;
  if((u.roles||[]).includes('Super Admin')){notify('Cannot reset Super Admin password',true);return;}
  showConfirm(`Reset password for "${u.fullName||u.name}" to "Kappl@123"?\n\nThe user will be forced to change password on next login.`, async ()=>{
    var ok=await _authResetPassword(CU.id,u.id);
    if(!ok){notify('Failed to reset password',true);return;}
    notify(`🔑 Password for "${u.fullName||u.name}" reset to "Kappl@123". They must change it on next login.`);
    cm('mRecordDetail');
    if(typeof renderUsers==='function') try{renderUsers();}catch(e){}
  });
}

let _mobLogoutHideTimer=null;
let _logoutHideTimer=null;
function doLogout(){
  CU=null;
  _adminLocFilter='';
  _sbStopPing();
  _sbStopRealtime();
  _sessionDel('kap_session_user');
  _sessionDel('kap_session_token');
  try{ localStorage.removeItem('kap_rm_user'); localStorage.removeItem('kap_rm_token'); }catch(e){}
  // On file:// show login form directly; otherwise redirect to portal
  if(location.protocol==='file:'){
    const lp=document.getElementById('loginPage');if(lp)lp.style.display='flex';
    const app=document.getElementById('app');if(app)app.style.display='none';
    const tb=document.getElementById('topbar');if(tb)tb.style.display='none';
  } else {
    _navigateTo('index.html');
  }
}
function toggleNav(){
  const isNarrow=window.matchMedia('(max-width:900px)').matches;
  const sb=document.getElementById('sidebar');
  const tb=document.getElementById('topbar');
  const mc=document.querySelector('.main-content');
  if(isNarrow){
    const opening=!sb.classList.contains('nav-open');
    sb.classList.toggle('nav-open',opening);
    const ov=document.getElementById('sidebarOverlay');
    if(ov)ov.classList.toggle('open',opening);
  } else {
    const hiding=!sb.classList.contains('nav-hidden');
    sb.classList.toggle('nav-hidden',hiding);
    if(tb)tb.style.left=hiding?'0':'240px';
    if(mc)mc.style.marginLeft=hiding?'0':'240px';
  }
}
function closeMobNav(){
  const sb=document.getElementById('sidebar');
  const isNarrow=window.matchMedia('(max-width:900px)').matches;
  if(isNarrow){
    sb?.classList.remove('nav-open');
    document.getElementById('sidebarOverlay')?.classList.remove('open');
  }
}
document.addEventListener('DOMContentLoaded',()=>{
  // Reset sidebar state on resize crossing 900px breakpoint
  window.addEventListener('resize',()=>{
    const sb=document.getElementById('sidebar');
    const tb=document.getElementById('topbar');
    const mc=document.querySelector('.main-content');
    const isNarrow=window.matchMedia('(max-width:900px)').matches;
    if(!isNarrow){
      // Wide: remove nav-open/nav-hidden, restore defaults unless manually collapsed
      sb?.classList.remove('nav-open');
      document.getElementById('sidebarOverlay')?.classList.remove('open');
    }
  });
  document.getElementById('loginPass')?.addEventListener('keydown',e=>{if(e.key==='Enter'){document.getElementById('captchaAns')?.focus();e.preventDefault();}});
  document.getElementById('captchaAns')?.addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});
  document.getElementById('roleBoxes')?.addEventListener('change',function(e){
    const checked=e.target;
    if(checked.value==='KAP Security'&&checked.checked){
      // Uncheck all other roles
      this.querySelectorAll('input:checked').forEach(cb=>{if(cb.value!=='KAP Security')cb.checked=false;});
    } else if(checked.checked&&checked.value!=='KAP Security'){
      // If any other role is checked, uncheck KAP Security
      const kapCb=this.querySelector('input[value="KAP Security"]');
      if(kapCb)kapCb.checked=false;
    }
    rboxes([...this.querySelectorAll('input:checked')].map(i=>i.value));
  });
  // Modals close ONLY via Close/Cancel buttons — no click-outside-to-close
  // But allow Escape key to close topmost open modal
  document.addEventListener('keydown',function(e){
    // Don't intercept inside textareas or contenteditable
    if(e.target&&(e.target.tagName==='TEXTAREA'||e.target.isContentEditable)) return;

    if(e.key==='Escape'){
      // Close lightbox first
      const lb=document.getElementById('photoLightbox');
      if(lb&&lb.style.display==='flex'){lb.style.display='none';e.preventDefault();return;}
      // Click Cancel on topmost open modal
      const openModals=[...document.querySelectorAll('.modal-overlay.open')];
      if(openModals.length){
        const top=openModals[openModals.length-1];
        // NEVER allow closing the forced password change modal
        if(top.id==='mForcePass'){e.preventDefault();return;}
        // Try .btn-secondary (Cancel) first, then .modal-close (×)
        const cancelBtn=top.querySelector('.btn-secondary')||top.querySelector('.modal-close');
        if(cancelBtn){cancelBtn.click();}else{top.classList.remove('open');}
        e.preventDefault();
      }
    }

    if(e.key==='Enter'){
      // If a modal is open — click its primary button
      const openModals=[...document.querySelectorAll('.modal-overlay.open')];
      if(openModals.length){
        const top=openModals[openModals.length-1];
        const primaryBtn=top.querySelector('.btn-primary');
        if(primaryBtn&&!primaryBtn.disabled){primaryBtn.click();e.preventDefault();}
        return;
      }
      // Login page — already has per-field Enter; also fire from anywhere on login page
      const loginPage=document.getElementById('loginPage');
      if(loginPage&&loginPage.style.display!=='none'){
        doLogin();e.preventDefault();return;
      }
    }
  });
});

// ═══ NAV / SIDEBAR / PAGE ROUTING ════════════════════════════════════════

// Direct portal navigation — bypasses showPage entirely
function goToPortal(){
  window.location.href='index.html';
}

const NAV=[
  {id:'MyApps',l:'My Apps',i:'🏠',p:'__portal__',action:'goToPortal',r:['Super Admin','Admin','Plant Head','Trip Booking User','KAP Security','Material Receiver','Trip Approver','Vendor'],app:'all'},
  {id:'Dashboard',l:'Dashboard',i:'📊',p:'pageDashboard',r:['Super Admin','Admin','Plant Head'],app:'vms'},
  {sec:'OPERATIONS',app:'vms'},
  {id:'TripBooking',l:'Trip Booking',i:'🚚',p:'pageTripBooking',r:['Trip Booking User','Admin','Plant Head'],badge:'bTB',app:'vms'},
  {id:'KapSec',l:'KAP Security',i:'🔒',p:'pageKapSecurity',r:['KAP Security','Admin','Plant Head'],badge:'bKS',app:'vms'},
  {id:'MR',l:'Material Receipt',i:'📦',p:'pageMR',r:['Material Receiver','Admin','Plant Head'],badge:'bMR',app:'vms'},
  {id:'Approve',l:'Trip Approvals',i:'✅',p:'pageApprove',r:['Trip Approver','Admin','Plant Head'],badge:'bAP',app:'vms'},
  {id:'VendorTrips',l:'My Trips (Vendor)',i:'🏢',p:'pageVendorTrips',r:['Vendor','Admin','Super Admin'],app:'vms'},
  {sec:'MASTERS',app:'vms'},
  {id:'Locations', l:'Locations',     i:'📍',p:'pageLocations', r:['Admin','Plant Head','Trip Booking User','Material Receiver','Trip Approver'],      count:'locations', cid:'cLocations',app:'vms'},
  {id:'VTypes',    l:'Vehicle Types', i:'🏷️',p:'pageVTypes',    r:['Admin'],      count:'vehicleTypes',cid:'cVTypes',app:'vms'},
  {id:'Vendors',   l:'Vendors',       i:'🏢',p:'pageVendors',   r:['Admin'],      count:'vendors',   cid:'cVendors',app:'vms'},
  {id:'Vehicles',  l:'Vehicles',      i:'🚗',p:'pageVehicles',  r:['Admin','Trip Booking User'], count:'vehicles',  cid:'cVehicles',app:'vms'},
  {id:'Drivers',   l:'Drivers',       i:'🪪',p:'pageDrivers',  r:['Admin','Trip Booking User'], count:'drivers',   cid:'cDrivers',app:'vms'},
  {id:'TripRates', l:'Trip Rates',    i:'💰',p:'pageTripRates', r:['Admin','Super Admin'],      count:'tripRates', cid:'cTripRates', badge:'bTR',app:'vms'},
  {sec:'SYSTEM',app:'vms'},
  {id:'Helper',l:'Helper',i:'📖',p:'pageHelper',r:['Super Admin'],app:'vms'},
];

function initApp(){
  try{ _runInitApp(); } catch(e){ console.error('initApp error:',e); notify('⚠ App init error: '+e.message,true); }
}
function _runInitApp(){
  // Ensure all DB arrays exist (may not be loaded yet with lazy boot)
  ['locations','vehicles','vehicleTypes','drivers','vendors','trips','segments','spotTrips','tripRates','users'].forEach(function(t){if(!DB[t])DB[t]=[];});
  // Migrate: tripBook may be old string format → convert to array
  DB.locations.forEach(l=>{
    if(!Array.isArray(l.tripBook)) l.tripBook=l.tripBook?[l.tripBook]:[];
  });
  // Migrate: vehicle numbers to XXXX-XX-XXXX format
  DB.vehicles.forEach(v=>{
    if(v.number&&!/^[A-Z0-9]{4}-[A-Z0-9]{2}-[A-Z0-9]{4}$/.test(v.number)){
      const raw=v.number.replace(/[^a-zA-Z0-9]/g,'').toUpperCase();
      if(raw.length>=10){
        v.number=`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,10)}`;
      }
    }
  });
  // Migrate: trip rates without status → approved (backward compat)
  DB.tripRates.forEach(r=>{if(!r.status)r.status='approved';});
  // Migrate: vehicles without insExpiry field
  DB.vehicles.forEach(v=>{if(v.insExpiry===undefined)v.insExpiry='';});
  // Migrate: users without plant field → default to first KAP location
  DB.users.forEach(u=>{
    if(!u.plant){
      const firstKap=DB.locations.find(l=>l.type==='KAP');
      u.plant=firstKap?.id||'P2';
    }
  });
  // Migrate: trips without vehicleTypeId → derive from vehicle
  DB.trips.forEach(t=>{
    if(!t.vehicleTypeId&&t.vehicleId){
      const v=byId(DB.vehicles,t.vehicleId);
      if(v)t.vehicleTypeId=v.typeId;
    }
    // Migrate: trips without plant → derive from bookedBy user
    if(!t.plant){
      const u=byId(DB.users,t.bookedBy);
      t.plant=u?.plant||'P2';
    }
  });
  // Reset both avatars fully before applying current user
  ['uAvatar','mobAvatar'].forEach(avId=>{
    const av=document.getElementById(avId);
    if(!av)return;
    av.textContent=CU.name[0].toUpperCase();
    av.style.backgroundImage='';av.style.backgroundSize='';av.style.backgroundPosition='';
    if(CU.photo){
      av.style.backgroundImage=`url(${CU.photo})`;av.style.backgroundSize='cover';av.style.backgroundPosition='center';av.textContent='';
    }
  });
  if(CU){document.getElementById('uName2').textContent=CU.fullName||CU.name;
  document.getElementById('uRole2').textContent=(CU.roles||[]).concat(CU.hwmsRoles||[]).join(', ');}
  // Sync admin-only UI visibility
  const _isAdm=CU&&CU.roles.some(r=>['Super Admin','Admin'].includes(r));
  document.body.classList.toggle('is-admin',!!_isAdm);
  const _locEl=document.getElementById('uLoc2');
  if(_locEl&&CU.locName){
    const _loc=getUserLocation(CU.id);
    const _bg=_loc?.colour||'var(--surface2)';
    _locEl.innerHTML=`<span style="background:${_bg};color:#1f2937;padding:1px 6px;border-radius:3px;font-weight:700">${CU.locName}</span>${CU.locType?` <span style="font-size:8px;color:var(--text3)">[${CU.locType}]</span>`:''}`;
  } else if(_locEl){ _locEl.innerHTML=''; }
  // Update sidebar logo text based on current app
  const _logoText=document.querySelector('.sidebar-logo .logo-text h2');
  if(_logoText) _logoText.textContent=_currentApp==='security'?'Security Surveillance':_currentApp==='hwms'?'HGAP Warehouse Management':'Vehicle Management System';
  const nav=document.getElementById('sidebarNav');
  nav.innerHTML='';
  NAV.filter(item=>item.app==='all'||item.app===_currentApp).forEach(item=>{
    if(item.sec){const s=document.createElement('div');s.className='nav-section';s.textContent=item.sec;nav.appendChild(s);}
    else if(hasRole(item.r)||CU.roles.includes('Super Admin')){
      const d=document.createElement('div');d.className='nav-item';d.id='n'+item.id;
      if(item.id==='MyApps') d.style.cssText='background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;border-radius:8px;margin:8px 10px;padding:10px 14px;font-weight:900;font-size:14px;border:none;';
      d.innerHTML=`<span class="nav-icon">${item.i}</span><span class="nav-label">${item.l}</span>`
        +(item.badge?`<span class="nav-badge" id="${item.badge}"></span>`:'')
        +(item.cid?`<span class="nav-count" id="${item.cid}">0</span>`:'');
      d.onclick=()=>{if(item.action){window[item.action]&&window[item.action]();}else showPage(item.p,item.id);};
      nav.appendChild(d);
    }
  });

  // VMS button bindings (only when VMS app)
  if(_currentApp==='vms'){
    const _b=id=>document.getElementById(id);
    if(_b('btnAddUser')) _b('btnAddUser').onclick=()=>openUserModal();
    if(_b('btnAddVT'))   _b('btnAddVT').onclick=()=>openVTModal();
    if(_b('btnAddDrv'))  _b('btnAddDrv').onclick=()=>openDrvModal();
    if(_b('btnAddVnd'))  _b('btnAddVnd').onclick=()=>openVndModal();
    if(_b('btnAddVeh'))  _b('btnAddVeh').onclick=()=>openVehModal();
    if(_b('btnAddLoc'))  _b('btnAddLoc').onclick=()=>openLocModal();
    if(_b('btnAddRate')) _b('btnAddRate').onclick=()=>openRateModal();
  }
  // Set date range BEFORE showPage so dashboard renders with correct month on first call
  setDashMonth(0);
  // Default page based on app and role
  const isAdminOrSA=CU.roles.includes('Admin')||CU.roles.includes('Super Admin');
  const _mc=document.querySelector('.main-content');
  if(_currentApp==='security'){
    // Security Surveillance is a separate app — redirect
    _navigateTo('security.html');
    return;
  } else if(_currentApp==='hwms'){
    // HWMS is now a separate module — redirect
    _navigateTo('hwms.html');
    return;
  } else if(isAdminOrSA){
    showPage('pageDashboard','Dashboard');
    if(_mc)_mc.scrollTop=0;
  } else if(CU.roles.includes('KAP Security')){
    showPage('pageKapSecurity','KapSec');
  } else if(CU.roles.includes('Trip Approver')){
    showPage('pageApprove','Approve');
  } else if(CU.roles.includes('Material Receiver')){
    showPage('pageMR','MR');
  } else if(CU.roles.includes('Trip Booking User')){
    showPage('pageTripBooking','TripBooking');
  } else if(CU.roles.includes('Vendor')){
    showPage('pageVendorTrips','VendorTrips');
  } else {
    showPage('pageDashboard','Dashboard');
  }
  // Populate sidebar counts immediately
  updBadges();
  // Hook: debounced (400ms) — collapses rapid sync/poll events into one render.
  // Skips expensive page render when any modal is open.
  var _rvDebounceTimer=null;
  _onRefreshViews = function(){
    clearTimeout(_rvDebounceTimer);
    _rvDebounceTimer=setTimeout(function(){
      try{
        updBadges();
        if(document.querySelector('.modal-overlay.open')) return;
        var activePage=document.querySelector('.page.active');
        if(activePage){
          var pid=activePage.id;
          var map={pageDashboard:renderDash,pageUsers:renderUsers,pageVTypes:renderVTypes,pageDrivers:renderDrivers,pageVendors:renderVendors,pageVehicles:renderVehicles,pageLocations:renderLocations,pageTripRates:renderRates,pageTripBooking:renderTripBooking,pageKapSecurity:renderKapPage,pageMR:renderMR,pageApprove:renderApprove,pageVendorTrips:renderVendorTrips,pageHelper:renderHelper};
          if(map[pid]) map[pid]();
        }
      }catch(e){ console.warn('_onRefreshViews error:',e); }
    },400);
  };
}

function updBadges(){
  const me=CU.id;
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');
  const kap=DB.segments.filter(s=>{
    if(s.status==='Completed'||s.status==='Locked')return false;
    const cs=s.currentStep;
    if(cs===1||cs===2){if(s.steps[cs]?.skip)return false;return canDoStep(s,cs);}
    // Step 5 parallel
    if(!s.steps[5]?.skip&&!s.steps[5]?.done&&stepsOneAndTwoDone(s))return canDoStep(s,5);
    return false;
  }).length;
  const mr=DB.segments.filter(s=>{
    if(s.status==='Completed'||s.status==='Locked')return false;
    if(s.steps[3]?.done||s.steps[3]?.skip)return false;
    if(!stepsOneAndTwoDone(s))return false;
    return canDoStep(s,3);
  }).length;
  const apSegs=DB.segments.filter(s=>{
    if(s.status==='Completed'||s.status==='Locked')return false;
    const needsApproval=(!s.steps[4]?.done&&!s.steps[4]?.rejected&&!s.steps[4]?.skip)||(s.steps[4]?.rejected&&s.status==='Rejected');
    if(!needsApproval)return false;
    // Step 4 only available after steps 1&2 done
    if(!stepsOneAndTwoDone(s))return false;
    return canDoStep(s,4);
  });
  // Count trips (not segments) — only where ALL segments are ready
  const apTripIds=new Set(apSegs.map(s=>s.tripId));
  let ap=0;
  apTripIds.forEach(tid=>{
    const allSegs=DB.segments.filter(s=>s.tripId===tid);
    if(allSegs.every(s=>s.status==='Completed'||s.status==='Locked'||stepsUpTo3Done(s)||s.status==='Rejected')) ap++;
  });
  const set=(id,n)=>{const el=document.getElementById(id);if(el){el.textContent=n||'';el.style.display=n?'inline':'none';}};
  set('bKS',kap);set('bMR',mr);set('bAP',ap);
  // Spot entries pending exit
  const spotPending=(DB.spotTrips||[]).filter(s=>!s.exitTime).length;
  set('bSpot',spotPending);
  // Pending rate approvals — SA only
  if(CU.roles.includes('Super Admin')){
    const pendingRates=DB.tripRates.filter(r=>r.status==='pending').length;
    set('bTR',pendingRates);
  }
  // Update master record counts in sidebar
  NAV.forEach(item=>{
    if(item.cid && item.count){
      const el=document.getElementById(item.cid);
      if(el) el.textContent=(DB[item.count]||[]).length;
    }
  });
  // Update topbar user widget
  _updTopbarUser();
}

function _updTopbarUser(){
  if(!CU)return;
  const locEl=document.getElementById('topbarLocName');
  const avEl=document.getElementById('topbarAvatar');
  if(!locEl||!avEl)return;
  const loc=byId(DB.locations,CU.plant);
  locEl.textContent=loc?loc.name:'';
  if(CU.photo){
    avEl.innerHTML=`<img src="${CU.photo}" alt="">`;
  } else {
    const initials=(CU.fullName||CU.name||'').trim().split(/\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase()||'👤';
    avEl.style.background='var(--accent)';
    avEl.style.color='#fff';
    avEl.style.fontWeight='800';
    avEl.style.fontSize=initials.length>1?'11px':'14px';
    avEl.textContent=initials;
  }
}

function showPage(pid,nid){
  // Special: navigate back to portal
  if(pid==='__portal__'){
    _navigateTo('index.html'); return;
  }
  closeMobNav();
  // Close any open modal-overlays when navigating pages
  document.querySelectorAll('.modal-overlay.open').forEach(m=>{m.style.display='none';m.classList.remove('open');});
  // Also close spot popup
  if(typeof _kapCloseSpotPopup==='function') try{_kapCloseSpotPopup();}catch(e){}
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const pg=document.getElementById(pid);if(pg)pg.classList.add('active');
  const ni=document.getElementById('n'+nid);if(ni)ni.classList.add('active');
  // Update topbar title from page-title element
  const ptEl=pg?.querySelector('.page-title');
  const tbt=document.getElementById('topbarTitle');
  if(tbt&&ptEl)tbt.textContent=ptEl.textContent;

  // Always scroll to top of content area
  const mc=document.querySelector('.main-content');if(mc)mc.scrollTop=0;
  const map={pageMyApps:renderMyApps,pageDashboard:renderDash,pageUsers:renderUsers,pageVTypes:renderVTypes,pageDrivers:renderDrivers,pageVendors:renderVendors,pageVehicles:renderVehicles,pageLocations:renderLocations,pageTripRates:renderRates,pageTripBooking:renderTripBooking,pageKapSecurity:renderKapPage,pageMR:renderMR,pageApprove:renderApprove,pageProfile:showProfile,pageVendorTrips:renderVendorTrips,pageHelper:renderHelper};
  console.log('[showPage] navigating to:', pid, '| page found:', !!pg, '| render fn:', !!map[pid]);
  if(map[pid]){
    // Demand-load required tables before rendering
    var reqTables=_PAGE_TABLES[pid];
    if(reqTables&&reqTables.length){
      var needed=reqTables.filter(function(t){return !_loadedTables[t]&&SB_TABLES[t];});
      if(needed.length){
        showSpinner('Loading data…');
        _demandLoad(reqTables).then(function(){
          hideSpinner();
          try{map[pid]();}catch(e){console.error('[showPage] render error:',e);notify('⚠ Page render error: '+e.message,true);}
        }).catch(function(){hideSpinner();try{map[pid]();}catch(e){}});
        return;
      }
    }
    try{map[pid]();}
    catch(e){
      console.error('[showPage] render error for '+pid+':', e);
      notify('⚠ Page render error: '+e.message, true);
      if(pg) pg.innerHTML+='<div style="padding:20px;color:#dc2626;font-weight:700">⚠ Render error: '+e.message+'</div>';
    }
  }
}

// ═══ DASHBOARD ══════════════════════════════════════════════════════════
// tripOverallStatus → moved to vms-logic.js
function tripOverallBadge(trip){
  const st=tripOverallStatus(trip);
  if(st==='Cancelled') return '<span class="trip-overall-badge-cancelled">✕ Cancelled</span>';
  if(st==='Completed') return '<span class="trip-overall-badge-done">✓ Completed</span>';
  if(st==='Rejected')  return '<span class="trip-overall-badge-rejected">⚠ Rejected</span>';
  const segs=DB.segments.filter(s=>s.tripId===trip.id);
  const done=segs.filter(s=>s.status==='Completed').length;
  return `<span class="trip-overall-badge-active">In Progress (${done}/${segs.length} segs)</span>`;
}

// ═══ CAMERA / PHOTO CAPTURE ══════════════════════════════════════════════
let _kapStream = null;
let _kapPhotoData = null; // base64 data URL of captured/chosen photo

// Open camera stream — single getUserMedia call, handles all permission errors
function _openCamStream(constraints){
  if(!navigator.mediaDevices?.getUserMedia){
    notify('Camera not supported on this device/browser.',true);
    return Promise.resolve(null);
  }
  return navigator.mediaDevices.getUserMedia(constraints).catch(err=>{
    if(err.name==='NotAllowedError'||err.name==='PermissionDeniedError')
      notify('Camera permission denied. Tap Allow when prompted, or enable camera in your browser/phone settings.',true);
    else if(err.name==='NotFoundError'||err.name==='DevicesNotFoundError')
      notify('No camera found on this device.',true);
    else if(err.name==='NotReadableError'||err.name==='TrackStartError')
      notify('Camera is in use by another app. Please close it and try again.',true);
    else
      notify('Camera error: '+(err.message||err.name||'unknown'),true);
    return null;
  });
}

function openCamera(){
  const inp=document.getElementById('kapFileInput');
  if(!inp) return;
  if(_isMobileOrTablet()){
    inp.setAttribute('capture','environment');
  } else {
    inp.removeAttribute('capture');
  }
  inp.click();
}

function stopCamera(){
  if(_kapStream){ _kapStream.getTracks().forEach(t=>t.stop()); _kapStream=null; }
  const cb=document.getElementById('kapCamBox');if(cb)cb.style.display='none';
  const pb=document.getElementById('kapPhotoButtons');if(pb)pb.style.display='flex';
}

function snapPhoto(){
  const vid = document.getElementById('kapVideo');
  const canvas = document.getElementById('kapCanvas');
  if(!vid||!canvas)return;
  // Cap at 1920px before any canvas op — iOS Safari crashes on large canvases
  const MAX_CAP=1920;
  let cw=vid.videoWidth||1280, ch=vid.videoHeight||720;
  if(cw>MAX_CAP||ch>MAX_CAP){const r=Math.min(MAX_CAP/cw,MAX_CAP/ch);cw=Math.round(cw*r);ch=Math.round(ch*r);}
  canvas.width=cw; canvas.height=ch;
  canvas.getContext('2d').drawImage(vid,0,0,cw,ch);
  _kapPhotoData = canvas.toDataURL('image/jpeg', 0.82);
  stopCamera();
  showPreview(_kapPhotoData);
  // Compress asynchronously — compressImage will further reduce to 900px/100KB
  canvas.toBlob(blob=>{
    if(!blob)return;
    compressImage(blob instanceof File?blob:new File([blob],'snap.jpg',{type:'image/jpeg'}))
      .then(c=>{_kapPhotoData=c;})
      .catch(()=>{}); // keep fullQ preview on compress failure
  },'image/jpeg',0.82);
}

function onFileChosen(input){
  const file = input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    _kapPhotoData = e.target.result; // set immediately for preview
    showPreview(_kapPhotoData);
    compressImage(file).then(c=>{_kapPhotoData=c;}).catch(()=>{});
  };
  reader.readAsDataURL(file);
}

function showPreview(src){
  const pi=document.getElementById('kapPreviewImg');if(pi)pi.src=src;
  const pp=document.getElementById('kapPhotoPreview');if(pp)pp.style.display='block';
  const pb=document.getElementById('kapPhotoButtons');if(pb)pb.style.display='none';
}

function clearPhoto(){
  _kapPhotoData = null;
  const pi=document.getElementById('kapPreviewImg');if(pi)pi.src='';
  const pp=document.getElementById('kapPhotoPreview');if(pp)pp.style.display='none';
  const pb=document.getElementById('kapPhotoButtons');if(pb)pb.style.display='flex';
  const fi=document.getElementById('kapFileInput');if(fi)fi.value='';
}

// ── Reusable Camera Capture (for Trip Booking + KAP Security photo buttons) ──
let _camCaptureStream=null;
let _camCaptureCallback=null;
let _photoChoiceFileId=null;
let _photoChoiceThumbId=null;
let _photoChoiceCb=null;

// Show camera/gallery choice sheet. fileInputId = hidden file input, thumbId = thumbnail element,
// onDone(dataUrl) = callback with compressed photo data
// Detect mobile/tablet (touch + small screen OR iOS/Android user agent)
function _isMobileOrTablet(){
  if('ontouchstart' in window && window.innerWidth<=1024) return true;
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

function _showPhotoChoice(fileInputId, thumbId, onDone){
  _photoChoiceFileId=fileInputId;
  _photoChoiceThumbId=thumbId;
  _photoChoiceCb=onDone;
  const inp=document.getElementById(fileInputId);
  if(!inp) return;
  if(_isMobileOrTablet()){
    // Mobile/Tablet: show Camera vs Gallery choice
    _showMobilePhotoMenu(fileInputId);
  } else {
    // Desktop: open file picker
    inp.removeAttribute('capture');
    inp.click();
  }
}

function _showMobilePhotoMenu(fileInputId){
  // Remove existing menu if any
  var old=document.getElementById('_mobilePhotoMenu');if(old)old.remove();
  var menu=document.createElement('div');
  menu.id='_mobilePhotoMenu';
  menu.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:200000;display:flex;align-items:flex-end;justify-content:center';
  menu.onclick=function(e){if(e.target===menu)menu.remove();};
  menu.innerHTML='<div style="background:#fff;border-radius:16px 16px 0 0;padding:20px;width:100%;max-width:400px;margin-bottom:0">'
    +'<div style="font-size:15px;font-weight:800;margin-bottom:16px;text-align:center">Attach Photo / Document</div>'
    +'<button onclick="document.getElementById(\'_mobilePhotoMenu\').remove();_photoChoiceCam()" style="width:100%;padding:14px;font-size:15px;font-weight:700;background:var(--accent);color:#fff;border:none;border-radius:10px;cursor:pointer;margin-bottom:8px">📷 Take Photo</button>'
    +'<button onclick="document.getElementById(\'_mobilePhotoMenu\').remove();_photoChoiceGallery()" style="width:100%;padding:14px;font-size:15px;font-weight:700;background:#f1f5f9;color:var(--text);border:1.5px solid var(--border);border-radius:10px;cursor:pointer;margin-bottom:8px">🖼 Gallery / Files</button>'
    +'<button onclick="document.getElementById(\'_mobilePhotoMenu\').remove()" style="width:100%;padding:12px;font-size:14px;font-weight:600;background:transparent;color:var(--text3);border:none;cursor:pointer">Cancel</button>'
    +'</div>';
  document.body.appendChild(menu);
}

function _photoChoiceCam(){
  const inp=document.getElementById(_photoChoiceFileId);
  if(inp){ inp.setAttribute('capture','environment'); inp.click(); }
}

function _photoChoiceGallery(){
  const inp=document.getElementById(_photoChoiceFileId);
  if(inp){ inp.removeAttribute('capture'); inp.click(); }
}

function _snapCamCapture(){
  const vid=document.getElementById('_camVid');
  const canvas=document.getElementById('_camCanvas');
  if(!vid||!canvas){_closeCamCapture();return;}
  const MAX_CAP=1920;
  let cw=vid.videoWidth||640, ch=vid.videoHeight||480;
  if(cw>MAX_CAP||ch>MAX_CAP){const r=Math.min(MAX_CAP/cw,MAX_CAP/ch);cw=Math.round(cw*r);ch=Math.round(ch*r);}
  canvas.width=cw; canvas.height=ch;
  canvas.getContext('2d').drawImage(vid,0,0,cw,ch);
  const fullQ=canvas.toDataURL('image/jpeg',0.82);
  _closeCamCapture();
  // Show in thumbnail immediately
  if(_photoChoiceThumbId){
    const thumb=document.getElementById(_photoChoiceThumbId);
    if(thumb){
      thumb.innerHTML='<img src="'+fullQ+'" style="width:100%;height:100%;object-fit:cover">';
      thumb.classList&&thumb.classList.add('has-photo');
      if(thumb.style)thumb.style.border='2px solid var(--green)';
    }
  }
  // Compress in background then call back
  canvas.toBlob(blob=>{
    if(!blob)return;
    const file=new File([blob],'cam.jpg',{type:'image/jpeg'});
    compressImage(file).then(c=>{
      if(_camCaptureCallback)_camCaptureCallback(c);
      // Also store on the file input element for compatibility
      if(_photoChoiceFileId){
        const inp=document.getElementById(_photoChoiceFileId);
        if(inp)inp._compressedData=c;
        if(inp)inp._photoData=c;
      }
    }).catch(()=>{
      if(_camCaptureCallback)_camCaptureCallback(fullQ);
    });
  },'image/jpeg',0.82);
}

function _closeCamCapture(){
  if(_camCaptureStream){_camCaptureStream.getTracks().forEach(t=>t.stop());_camCaptureStream=null;}
  const vid=document.getElementById('_camVid');if(vid)vid.srcObject=null;
  cm('mCamCapture');
}

function closeKapModal(){
  stopCamera();
  clearPhoto();
  cm('mKap');
}

// Returns trips visible to the current user based on role & location assignment
function getVisibleTrips(){
  return tripsForMyPlant();
}

// ═══ DASHBOARD TABS / RENDERING ══════════════════════════════════════════
let _dashTab='overview';
function setDashTab(tab){
  _dashTab=tab;
  const tabs=['overview','trips','reports'];
  tabs.forEach(t=>{
    const btn=document.getElementById('dashTab'+t.charAt(0).toUpperCase()+t.slice(1));
    if(btn) btn.style.cssText='padding:8px 18px;border:none;background:transparent;cursor:pointer;font-size:14px;font-weight:'+(tab===t?'700':'600')+';color:'+(tab===t?'var(--accent)':'var(--text2)')+';border-bottom:3px solid '+(tab===t?'var(--accent)':'transparent')+';margin-bottom:-2px';
  });
  document.getElementById('dashOverviewPanel').style.display=tab==='overview'?'block':'none';
  const tripsPanel=document.getElementById('dashTripsPanel');if(tripsPanel)tripsPanel.style.display=tab==='trips'?'block':'none';
  document.getElementById('dashReportsPanel').style.display=tab==='reports'?'block':'none';
  if(tab==='reports'){initRptDates();renderReports();}
  if(tab==='overview'){initDfMonth('ov','ovFrom','ovTo');initOvDates();renderDashOverview();}
  if(tab==='trips'){initDfMonth('td','tdFrom','tdTo');initTdDates();renderDashTrips();}
}

// ── Date range shortcut helper ────────────────────────────────────────────────
function initTdDates(){
  const _e1=document.getElementById('tdFrom');const _e2=document.getElementById('tdTo');
  if(_e1&&!_e1.value){const _n=new Date();const _d=_n.getFullYear()+'-'+String(_n.getMonth()+1).padStart(2,'0')+'-'+String(_n.getDate()).padStart(2,'0');_e1.value=_d;updDateBtnLbl('tdFrom');_e2.value=_d;updDateBtnLbl('tdTo');}
}

function toggleDashTrip(el){
  // accept element OR string id
  const btn=typeof el==='string'?document.getElementById(el):el;
  if(!btn)return;
  const tid=btn.getAttribute('data-tid');
  const body=document.getElementById('dtb_'+tid);
  if(!body)return;
  const open=body.style.display==='none'||body.style.display==='';
  body.style.display=open?'block':'none';
  btn.setAttribute('data-open',open?'1':'0');
}
function renderDashTrips(){
  initTdDates();
  const el=document.getElementById('dashTripsContent');if(!el)return;
  // Preserve expanded state — cards with data-open="1" should stay open after re-render
  const _openTids=new Set([...el.querySelectorAll('[data-open="1"]')].map(el=>el.getAttribute('data-tid')));
  const from=document.getElementById('tdFrom')?.value||'';
  const to=document.getElementById('tdTo')?.value||'';
  const _dtSrch=(document.getElementById('dashTripSearch')?.value||'').toLowerCase();
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');

  // All trips in date range accessible to user
  let trips2=DB.trips.filter(t=>{
    if(!isSA){const loc=DB.locations.find(l=>(l.tripBook||[]).includes(CU.id));if(loc&&t.startLoc!==loc.id)return false;}
    if(_dtSrch) return t.id.toLowerCase().includes(_dtSrch)||vnum(t.vehicleId).toLowerCase().includes(_dtSrch);
    const d=(t.date||'').slice(0,10);
    if(from&&d<from)return false;
    if(to&&d>to)return false;
    return true;
  }).sort((a,b)=>(b.date||'').localeCompare(a.date||''));

  if(!trips2.length){el.innerHTML='<div class="empty-state">No trips in selected period</div>';return;}

  const thumbD=(src,label,clr)=>{
    if(!src)return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px"><div style="width:48px;height:46px;border-radius:6px;border:2px dashed var(--border2);background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--border2)">📷</div><span style="font-size:7px;color:var(--text3);text-transform:uppercase;font-weight:600">${label}</span></div>`;
    const isPdf=src.startsWith('data:application/pdf');
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">${isPdf
      ?`<div onclick="openPhoto('${src}')" style="width:48px;height:46px;border-radius:6px;border:2px solid ${clr};background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer">📄</div>`
      :`<img src="${src}" onclick="openPhoto(this.src)" style="width:48px;height:46px;object-fit:cover;border-radius:6px;border:2px solid ${clr};cursor:pointer;transition:transform .15s" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform=''">` }<span style="font-size:7px;color:${clr};text-transform:uppercase;font-weight:700">${label}</span></div>`;
  };

  const stepBadge=(done,label,clr)=>`<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:${done?clr+'22':'rgba(0,0,0,0.05)'};color:${done?clr:'var(--text3)'};border:1px solid ${done?clr+'44':'transparent'}">${done?'✓':' '}${label}</span>`;

  el.innerHTML=trips2.map((t,ti)=>{
    const segs=DB.segments.filter(s=>s.tripId===t.id).sort((a,b)=>a.label.localeCompare(b.label));
    const drv=byId(DB.drivers,t.driverId);
    const bu=byId(DB.users,t.bookedBy);const bookedBy=bu?.fullName||bu?.name||'—';
    const eu=byId(DB.users,t.editedBy);const editedBy=eu?.fullName||eu?.name||'';
    const recVt=byId(DB.vehicleTypes,t.vehicleTypeId)?.name||'—';
    const actVt=byId(DB.vehicleTypes,t.actualVehicleTypeId)?.name||(byId(DB.vehicleTypes,byId(DB.vehicles,t.vehicleId)?.typeId)?.name)||'—';
    const vtMismatch=recVt!==actVt&&actVt!=='—'&&recVt!==actVt;
    const isCompleted=segs.length>0&&segs.every(s=>s.status==='Completed');
    const anyAction=segs.some(s=>[1,2,3,4,5].some(n=>s.steps[n]?.done));
    const cardBg=isCompleted?'background:rgba(22,163,74,.08);border:2px solid #000':'background:#ffffff;border:2px solid #000';
    const locs=[t.startLoc,t.dest1,t.dest2,t.dest3].filter(Boolean);
    const routeParts=locs.map((id,i)=>{const l=byId(DB.locations,id);const clr=l?.colour||'var(--accent)';return`<span style="${_locPillStyle(l?.colour,10)}">${l?.name||'?'}</span>`+(i<locs.length-1?'<span style="color:var(--accent);font-weight:900;font-size:14px;margin:0 3px">⟶</span>':'');}).join('');
    const rate=getMatchedRate(t.id);

    const segBlocks=segs.map(s=>{
      const idx=s.label==='A'?1:s.label==='B'?2:3;
      const challans=t?.['challans'+idx]||[];
      const legCh=t?.['challan'+idx]||'';const legWt=t?.['weight'+idx]||'';const legPh=t?.['photo'+idx]||'';
      const chRows=challans.filter(c=>c.no||c.weight||c.photo).length?challans.filter(c=>c.no||c.weight||c.photo):legCh?[{no:legCh,weight:legWt,photo:legPh}]:[];
      const exitPh=s.steps[1]?.photo||'';const entryPh=s.steps[2]?.photo||'';
      const dLoc=byId(DB.locations,s.dLoc);
      const sBg=dLoc?.colour?dLoc.colour+'18':'var(--surface2)';
      const sBorder=dLoc?.colour||'var(--border)';
      const segClr={A:'#35b0b6',B:'#14b8a6',C:'#8b5cf6'}[s.label]||'var(--accent)';
      const stClr=s.status==='Completed'?'#16a34a':s.status==='Rejected'?'#dc2626':s.currentStep===5?'#ea580c':s.currentStep===4?'var(--accent)':'var(--text3)';
      const _dDiscrep=s.steps[3]?.discrepancy;const _dNotRcvd=s.steps[3]?.notReceived;
      const _dDiscTag=_dDiscrep?' <span style="font-size:9px;font-weight:700;background:#ea580c;color:#fff;padding:1px 5px;border-radius:4px">⚠</span>':_dNotRcvd?' <span style="font-size:9px;font-weight:700;background:#dc2626;color:#fff;padding:1px 5px;border-radius:4px">✗</span>':'';
      const _s5AutoSkipped=s.steps[5]?.skip&&(s.steps[5]?.remarks||'').indexOf('Auto-skipped:')===0;
      const stLabel=(s.status==='Completed'?'✓ Done':s.status==='Rejected'?'✗ Rejected':s.currentStep===5?(_s5AutoSkipped?'⏭ Auto Skipped':'📤 Empty Exit Pending'):s.currentStep===4?'⏳ Approval Pending':s.currentStep===3?'📦 MR Pending':s.currentStep===2?'🏁 Entry Pending':s.currentStep===1?'🚪 Exit Pending':'—')+((s.status==='Completed'||s.steps[3]?.done)?_dDiscTag:'');
      const mrByU=byId(DB.users,s.steps[3]?.by);const mrByName=mrByU?.fullName||mrByU?.name||'';
      const apByU=byId(DB.users,s.steps[4]?.by);const apByName=apByU?.fullName||apByU?.name||'';
      const fmtTs=ts=>ts?new Date(ts).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true}):'';
      const _isSADash=CU.roles.some(r=>['Super Admin','Admin'].includes(r));
      const _stepLocName=(stepObj)=>{if(!_isSADash||!stepObj)return '';const loc=byId(DB.locations,stepObj.ownerLoc);return loc?` <span style="font-size:8px;font-weight:600;opacity:.75">(${loc.name})</span>`:stepObj.skip?` <span style="font-size:8px;font-weight:600;opacity:.6">(skip)</span>`:'';};
      const stepBadgeLoc=(done,label,clr,stepObj)=>`<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:${done?clr+'22':'rgba(0,0,0,0.05)'};color:${done?clr:'var(--text3)'};border:1px solid ${done?clr+'44':'transparent'}">${done?'✓':' '}${label}${_stepLocName(stepObj)}</span>`;
      return `<div style="background:${sBg};border:1.5px solid ${sBorder}44;border-radius:8px;padding:8px 10px;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap">
          <span style="width:20px;height:20px;border-radius:50%;background:${segClr};color:#fff;font-size:9px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${s.label}</span>
          <span style="font-size:11px;font-weight:700;flex:1">${lnameText(s.sLoc)} → ${lnameText(s.dLoc)}</span>
          <span style="font-size:10px;font-weight:700;color:${stClr};white-space:nowrap">${stLabel}</span>
        </div>
        <!-- Step badges -->
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">
          ${stepBadgeLoc(s.steps[1]?.done,'Gate Exit','#2a9aa0',s.steps[1])}
          ${stepBadgeLoc(s.steps[2]?.done,'Gate Entry','#0d9488',s.steps[2])}
          ${stepBadgeLoc(s.steps[3]?.done,'Mat. Receipt','#16a34a',s.steps[3])}
          ${stepBadgeLoc(s.steps[4]?.done&&!s.steps[4]?.rejected,'Trip Approval','#7c3aed',s.steps[4])}
          ${s.steps[5]&&!s.steps[5].skip?stepBadgeLoc(s.steps[5]?.done,'Empty Vehicle Exit','#ea580c',s.steps[5]):(s.steps[5]?.skip&&(s.steps[5]?.remarks||'').indexOf('Auto-skipped:')===0?'<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:#fef3c7;color:#a16207;border:1px solid #fde047">⏭ Auto Skipped</span>':'')}
          ${s.steps[3]?.discrepancy?'<span style="font-size:9px;font-weight:700;color:#dc2626;padding:2px 6px;background:#fee2e2;border-radius:4px;border:1px solid #fca5a5">⚠ Discrepancy</span>':''}
        </div>
        <!-- Photos row -->
        <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;margin-bottom:6px">
          <div style="display:flex;gap:6px;flex-shrink:0">
            ${thumbD(exitPh,'Exit','#2a9aa0')}
            ${thumbD(entryPh,'Entry','#0d9488')}
          </div>
          ${chRows.length?`<div style="flex:1;min-width:120px;border-left:1.5px solid var(--border);padding-left:8px">
            <div style="font-size:8px;font-weight:700;color:#000;text-transform:uppercase;margin-bottom:4px">Challans</div>
            <div style="display:flex;gap:5px;flex-wrap:wrap">${chRows.map((ch,ci)=>`<div style="display:flex;align-items:center;gap:5px;background:#fff;border:1.5px solid #7c3aed33;border-radius:6px;padding:3px 7px;flex:1;min-width:100px">${thumbD(ch.photo||'','','#7c3aed')}<div style="flex:1;min-width:0"><div style="font-size:8px;color:#7c3aed;font-weight:700">Ch${chRows.length>1?' '+(ci+1):''}</div><div style="font-size:11px;font-weight:800;font-family:var(--mono)">${ch.no||'—'}</div><div style="font-size:10px;font-weight:700;color:#16a34a;font-family:var(--mono)">${ch.weight||'—'}<span style="font-size:8px;color:var(--text3)"> kg</span></div></div></div>`).join('')}</div>
          </div>`:''}
        </div>
        <!-- Step timeline details -->
        <div style="display:flex;flex-wrap:wrap;gap:6px;font-size:9px">
          ${s.steps[1]?.done?`<div style="padding:3px 7px;background:rgba(42,154,160,.08);border-radius:5px;border:1px solid rgba(42,154,160,.2)"><span style="color:#2a9aa0;font-weight:700">🚪 Exit</span> ${fmtTs(s.steps[1].time)}</div>`:''}
          ${s.steps[2]?.done?`<div style="padding:3px 7px;background:rgba(13,148,136,.08);border-radius:5px;border:1px solid rgba(13,148,136,.2)"><span style="color:#0d9488;font-weight:700">🏁 Entry</span> ${fmtTs(s.steps[2].time)}</div>`:''}
          ${s.steps[3]?.done?`<div style="padding:3px 7px;background:rgba(22,163,74,.08);border-radius:5px;border:1px solid rgba(22,163,74,.2)"><span style="color:#16a34a;font-weight:700">📦 MR</span> ${mrByName?mrByName+' · ':''}${fmtTs(s.steps[3].time)}${s.steps[3]?.remarks?' — '+s.steps[3].remarks.slice(0,40):''}</div>`:''}
          ${s.steps[4]?.done&&!s.steps[4]?.rejected?`<div style="padding:3px 7px;background:rgba(124,58,237,.08);border-radius:5px;border:1px solid rgba(124,58,237,.2)"><span style="color:#7c3aed;font-weight:700">✓ Trip Approval</span> ${apByName?apByName+' · ':''}${fmtTs(s.steps[4].time)}</div>`:''}
          ${s.steps[4]?.rejected?`<div style="padding:3px 7px;background:rgba(220,38,38,.08);border-radius:5px;border:1px solid rgba(220,38,38,.2)"><span style="color:#dc2626;font-weight:700">✗ Rejected</span> ${fmtTs(s.steps[4].time)}${s.steps[4]?.remarks?' — '+s.steps[4].remarks.slice(0,40):''}</div>`:''}\
          ${s.steps[5]?.done?`<div style="padding:3px 7px;background:rgba(234,88,12,.08);border-radius:5px;border:1px solid rgba(234,88,12,.2)"><span style="color:#ea580c;font-weight:700">📤 Empty Exit</span> ${(()=>{const u=byId(DB.users,s.steps[5].by);return u?((u.fullName||u.name)+' · '):'';})()}${fmtTs(s.steps[5].time)}</div>`:(s.steps[5]?.skip&&(s.steps[5]?.remarks||'').indexOf('Auto-skipped:')===0?`<div style="padding:3px 7px;background:#fef3c7;border-radius:5px;border:1px solid #fde047"><span style="color:#a16207;font-weight:700">⏭ Empty Exit — Auto Skipped</span> <span style="font-size:10px;color:#92400e">${s.steps[5].remarks.replace('Auto-skipped: ','')}</span></div>`:'')}
        </div>
      </div>`;
    }).join('');

    return `<div data-tid="${btoa(t.id).replace(/[^a-zA-Z0-9]/g,'')}" data-open="0" onclick="toggleDashTrip(this)" style="${cardBg};border-radius:10px;padding:10px 12px 10px 26px;margin-bottom:10px;position:relative;cursor:pointer;user-select:none">
      <div style="position:absolute;left:0;top:0;bottom:0;width:22px;background:rgba(0,0,0,0.28);border-radius:8px 0 0 8px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900;color:#fff;user-select:none">${trips2.length-ti}</div>
      <!-- Trip header row 1: ID + Vehicle + Rate -->
      <div style="display:flex;align-items:center;gap:7px;flex-wrap:nowrap;margin-bottom:4px;min-width:0">
        <span style="font-family:var(--mono);font-size:clamp(14px,4vw,26px);font-weight:900;color:#fff;background:var(--accent);padding:2px 10px;border-radius:8px;white-space:nowrap;flex-shrink:0">${_cTid(t.id)}</span>
        <span style="font-family:var(--mono);font-size:clamp(14px,4vw,26px);font-weight:900;color:var(--text);background:#fef08a;border:1.5px solid #ca8a04;padding:2px 10px;border-radius:8px;white-space:nowrap;flex-shrink:0;min-width:0;overflow:hidden;text-overflow:ellipsis">${vnum(t.vehicleId)}</span>
        ${drv?.name?`<span style="font-size:11px;color:var(--text2)">🧑 ${drv.name}</span>`:''}
        ${rate?`<span style="font-family:var(--mono);font-size:12px;font-weight:800;color:#16a34a;background:rgba(22,163,74,.1);border:1px solid rgba(22,163,74,.3);padding:2px 8px;border-radius:5px;margin-left:auto">₹${rate.rate.toLocaleString()}</span>`:''}
      </div>
      <!-- Trip header row 2: Booked by -->
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;font-size:12px"><span style="color:var(--text3)">Booked by:</span><span style="font-weight:700;color:var(--text2)">${bookedBy}</span><span style="color:var(--border2)">·</span><span style="color:var(--text3)">📅 ${fdt(t.date)}</span>${editedBy?`<span style="color:var(--border2)">·</span><span style="color:var(--text3)">Edited by:</span><span style="font-weight:600;color:var(--text2)">${editedBy}</span>`:""}</div>
      <!-- Route pills -->
      <div style="display:flex;gap:3px;flex-wrap:wrap;align-items:center;margin-bottom:4px">${routeParts}</div>
      <!-- Info row (rec type) -->
      <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-top:1px solid rgba(0,0,0,0.08);margin-top:4px;font-size:10px">
        <span style="color:var(--text3)">Rec. type: </span><span style="font-weight:700;color:#16a34a">${recVt}</span>${vtMismatch?`<span style="color:var(--text3)"> · Act: </span><span style="font-weight:700;color:#dc2626">${actVt}</span>`:''}
      </div>
      <!-- Collapsible segment blocks -->
      <div id="dtb_${btoa(t.id).replace(/[^a-zA-Z0-9]/g,'')}" style="display:none;margin-top:8px" onclick="event.stopPropagation()">
        ${segBlocks}
      </div>
    </div>`;
  }).join('');
  // Re-expand cards that were open before the re-render
  _openTids.forEach(tid=>{
    const card=el.querySelector('[data-tid="'+tid+'"]');
    const body=document.getElementById('dtb_'+tid);
    if(card&&body){
      body.style.display='block';
      card.setAttribute('data-open','1');
    }
  });
}

function setDateRange(fromId,toId,preset,renderFn,grpId){
  const now=new Date();
  const pad=n=>String(n).padStart(2,'0');
  const fmt=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  let from,to;
  if(preset==='today'){
    from=to=fmt(now);
  } else if(preset==='week'){
    const f=new Date(now);f.setDate(now.getDate()-now.getDay()+1);
    const t=new Date(f);t.setDate(f.getDate()+6);
    from=fmt(f);to=fmt(t);
  } else if(preset==='month'){
    const f=new Date(now.getFullYear(),now.getMonth(),1);
    const t=new Date(now.getFullYear(),now.getMonth()+1,0);
    from=fmt(f);to=fmt(t);
  } else if(preset==='year'){
    const f=new Date(now.getFullYear(),0,1);
    const t=new Date(now.getFullYear(),11,31);
    from=fmt(f);to=fmt(t);
  }
  const fe=document.getElementById(fromId);const te=document.getElementById(toId);
  if(fe){fe.value=from;updDateBtnLbl(fromId);}
  if(te){te.value=to;updDateBtnLbl(toId);}
  if(grpId)updDrBtns(grpId,fromId,toId);
  // Auto-load older data if selected range goes beyond loaded cutoff
  if(from){
    var cutoff=_dateCutoff();
    if(from<cutoff){
      var daysNeeded=Math.ceil((new Date(cutoff+'T00:00:00')-new Date(from+'T00:00:00'))/(86400000))+7;
      Promise.all(['trips','segments','spotTrips'].map(function(t){return _loadOlderData(t,daysNeeded);})).then(function(){
        if(typeof renderFn==='function')renderFn();
      });
      return;// renderFn called after load completes
    }
  }
  if(typeof renderFn==='function')renderFn();
}
function updDrBtns(grpId,fromId,toId){
  const now=new Date();
  const pad=n=>String(n).padStart(2,'0');
  const fmt=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  const fv=document.getElementById(fromId)?.value||'';
  const tv=document.getElementById(toId)?.value||'';
  // Compute expected ranges
  const todayS=fmt(now);
  const wf=new Date(now);wf.setDate(now.getDate()-now.getDay()+1);
  const wt=new Date(wf);wt.setDate(wf.getDate()+6);
  const ranges={
    today:[todayS,todayS],
    week:[fmt(wf),fmt(wt)],
    month:[fmt(new Date(now.getFullYear(),now.getMonth(),1)),fmt(new Date(now.getFullYear(),now.getMonth()+1,0))],
    year:[now.getFullYear()+'-01-01',now.getFullYear()+'-12-31']
  };
  ['today','week','month','year'].forEach(p=>{
    const btn=document.getElementById('drb_'+grpId+'_'+p);
    if(!btn)return;
    const match=fv===ranges[p][0]&&tv===ranges[p][1];
    btn.classList.toggle('dr-btn-active',match);
  });
}
function initDfMonth(pfx,fromId,toId){
  const fe=document.getElementById(fromId);const te=document.getElementById(toId);
  if(!fe||!te||fe.value)return; // already set
  const now=new Date();
  const pad=n=>String(n).padStart(2,'0');
  fe.value=`${now.getFullYear()}-${pad(now.getMonth()+1)}-01`;
  te.value=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(new Date(now.getFullYear(),now.getMonth()+1,0).getDate())}`;
  updDateBtnLbl(fromId);updDateBtnLbl(toId);
  setTimeout(()=>updDrBtns(pfx,fromId,toId),30);
}
function initOvDates(){
  const now=new Date();
  const y=now.getFullYear(),m=String(now.getMonth()+1).padStart(2,'0');
  const last=String(new Date(y,now.getMonth()+1,0).getDate()).padStart(2,'0');
  const fe=document.getElementById('ovFrom');const te=document.getElementById('ovTo');
  if(fe&&!fe.value){fe.value=y+'-'+m+'-01';updDateBtnLbl('ovFrom');}
  if(te&&!te.value){te.value=y+'-'+m+'-'+last;updDateBtnLbl('ovTo');}
}
function setOvMonth(){
  const now=new Date();
  const y=now.getFullYear(),m=String(now.getMonth()+1).padStart(2,'0');
  const last=new Date(y,now.getMonth()+1,0).getDate();
  const fe=document.getElementById('ovFrom');const te=document.getElementById('ovTo');
  if(fe){fe.value=y+'-'+m+'-01';updDateBtnLbl('ovFrom');}
  if(te){te.value=y+'-'+m+'-'+String(last).padStart(2,'0');updDateBtnLbl('ovTo');}
  updDrBtns('ov','ovFrom','ovTo');
  renderDashOverview();
}

function renderDashOverview(){
  initOvDates();
  const el=document.getElementById('dashOverviewContent');
  if(!el) return;

  const fromVal=document.getElementById('ovFrom')?.value||'';
  const toVal=document.getElementById('ovTo')?.value||'';

  // Get all KAP locations sorted alphabetically
  const kapLocs=DB.locations.filter(l=>l.kapSec||l.type==='KAP').sort((a,b)=>a.name.localeCompare(b.name));
  if(!kapLocs.length){
    el.innerHTML='<div class="empty-state">No KAP locations configured</div>';
    return;
  }

  const now=new Date();
  const today=now.toISOString().split('T')[0];
  const inPeriod=(dateStr)=>(!fromVal||dateStr>=fromVal)&&(!toVal||dateStr<=toVal);

  const cards=kapLocs.map(loc=>{
    // ── Trip Bookings ──────────────────────────────────────────────────────────
    const locSegs=DB.segments.filter(s=>{
      const t=byId(DB.trips,s.tripId);
      return t&&(t.startLoc===loc.id||t.dest1===loc.id||t.dest2===loc.id||t.dest3===loc.id);
    });
    // Active trips in period
    const activeTrips=new Set(locSegs.filter(s=>{
      const t=byId(DB.trips,s.tripId);
      return s.status!=='Completed'&&s.status!=='Rejected'&&t&&inPeriod((t.date||'').slice(0,10));
    }).map(s=>s.tripId));
    const totalTrips=activeTrips.size;

    // ── Gate Exit (Pre-booked) ────────────────────────────────────────────────
    const pendingGateExit=locSegs.filter(s=>s.status==='Active'&&!s.steps[1]?.done).length;
    const doneGateExit=locSegs.filter(s=>s.steps[1]?.done&&inPeriod((s.steps[1].time||'').slice(0,10))).length;

    // ── Gate Entry (Pre-booked) ───────────────────────────────────────────────
    const pendingGateEntry=locSegs.filter(s=>s.status==='Active'&&s.steps[1]?.done&&!s.steps[2]?.done).length;
    const doneGateEntry=locSegs.filter(s=>s.steps[2]?.done&&inPeriod((s.steps[2].time||'').slice(0,10))).length;

    // ── Spot trips at this location ───────────────────────────────────────────
    const spotTrips=(DB.spotTrips||[]).filter(s=>s.location===loc.id);
    // Vehicles currently inside — ALWAYS shown regardless of date filter
    const spotInside=spotTrips.filter(s=>!s.exitTime).length;
    // Vehicles exited within the date range
    const spotExitedToday=spotTrips.filter(s=>s.exitTime&&inPeriod(s.exitTime.slice(0,10))).length;

    // ── Material Receipt pending ──────────────────────────────────────────────
    // Segments where step 2 done, step 3 not done, at destination = this location
    const mrSegs=DB.segments.filter(s=>{
      const t=byId(DB.trips,s.tripId);
      if(!t)return false;
      // Destination is this location
      const destForSeg={A:t.dest1,B:t.dest2,C:t.dest3}[s.label];
      return destForSeg===loc.id&&s.steps[2]?.done&&!s.steps[3]?.done;
    });
    const pendingMR=mrSegs.length;
    const doneMR=DB.segments.filter(s=>{
      const t=byId(DB.trips,s.tripId);
      if(!t)return false;
      const destForSeg={A:t.dest1,B:t.dest2,C:t.dest3}[s.label];
      return destForSeg===loc.id&&s.steps[3]?.done&&inPeriod((s.steps[3].time||'').slice(0,10));
    }).length;

    // ── Trip Approvals pending ────────────────────────────────────────────────
    const pendingApprove=DB.segments.filter(s=>{
      const t=byId(DB.trips,s.tripId);if(!t)return false;
      const destForSeg={A:t.dest1,B:t.dest2,C:t.dest3}[s.label];
      return destForSeg===loc.id&&s.steps[3]?.done&&!s.steps[4]?.done;
    }).length;
    const doneApprove=DB.segments.filter(s=>{
      const t=byId(DB.trips,s.tripId);if(!t)return false;
      const destForSeg={A:t.dest1,B:t.dest2,C:t.dest3}[s.label];
      return destForSeg===loc.id&&s.steps[4]?.done&&inPeriod((s.steps[4].time||'').slice(0,10));
    }).length;

    // ── Total Trip Cost ───────────────────────────────────────────────────────
    // Sum matched rate for each unique trip associated with this location in period
    const locTripIds=new Set(locSegs.filter(s=>{
      const t=byId(DB.trips,s.tripId);
      return t&&inPeriod((t.date||'').slice(0,10));
    }).map(s=>s.tripId));
    let totalCost=0;
    locTripIds.forEach(tid=>{
      const rate=getMatchedRate(tid);
      if(rate) totalCost+=rate.rate||0;
    });

    const locColor=loc.colour||'#2a9aa0';
    // Convert hex color to very light bg (10% opacity)
    const hexToRgba=(hex,a)=>{
      const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
      return isNaN(r)?'rgba(42,154,160,'+a+')':'rgba('+r+','+g+','+b+','+a+')';
    };
    const locBg=(locColor.startsWith('#'))?hexToRgba(locColor,0.08):'rgba(42,154,160,0.08)';
    const locBorder=(locColor.startsWith('#'))?hexToRgba(locColor,0.3):'rgba(42,154,160,0.3)';

    // clickable cell — no label (shown in shared header row)
    const cell=(total,pending,page)=>{
      const hasPending=pending>0;
      const base='background:rgba(255,255,255,0.6);border:1px solid rgba(0,0,0,0.07);border-radius:6px;width:36px;height:46px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;box-sizing:border-box;'+(page?'cursor:pointer;':'');
      return '<div style="'+base+'"'+(page?' onclick="'+page+'" title="Click for details" onmouseover="this.style.background=\'rgba(255,255,255,0.9)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.6)\'"':'')+' >'
        +'<div style="font-size:15px;font-weight:900;color:#111;line-height:1;letter-spacing:-1px;margin:0">'+total+'</div>'
        +(hasPending
          ?'<div style="font-size:9px;font-weight:800;color:#dc2626;margin-top:2px">'+pending+' ⏳</div>'
          :'<div style="font-size:8px;color:#bbb;margin-top:2px">—</div>')
      +'</div>';
    };

    // Dual cell for Gate Exit+Entry — no top label
    const dualCell=(total1,pending1,total2,pending2,page)=>{
      return '<div style="background:rgba(255,255,255,0.6);border:1px solid rgba(0,0,0,0.07);border-radius:6px;width:89px;height:46px;text-align:center;display:flex;align-items:center;justify-content:center;box-sizing:border-box;'+(page?'cursor:pointer;':'')
        +'" '+(page?' onclick="'+page+'" onmouseover="this.style.background=\'rgba(255,255,255,0.9)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.6)\'"':'')+' >'
        +'<div style="display:flex;justify-content:space-around;gap:4px">'
          +'<div><div style="font-size:7px;color:#888;margin-bottom:2px;text-transform:uppercase;letter-spacing:.3px">Exit</div><div style="font-size:15px;font-weight:900;color:#111;line-height:1;letter-spacing:-1px">'+total1+'</div>'+(pending1>0?'<div style="font-size:9px;font-weight:800;color:#dc2626">'+pending1+' ⏳</div>':'<div style="font-size:8px;color:#bbb">—</div>')+'</div>'
          +'<div style="width:1px;background:rgba(0,0,0,0.08)"></div>'
          +'<div><div style="font-size:7px;color:#888;margin-bottom:2px;text-transform:uppercase;letter-spacing:.3px">Entry</div><div style="font-size:15px;font-weight:900;color:#111;line-height:1;letter-spacing:-1px">'+total2+'</div>'+(pending2>0?'<div style="font-size:9px;font-weight:800;color:#dc2626">'+pending2+' ⏳</div>':'<div style="font-size:8px;color:#bbb">—</div>')+'</div>'
        +'</div>'
      +'</div>';
    };

    const navKap="showPage('pageKapSecurity','KapSec')";
    const navTrips="showPage('pageTripBooking','TripBooking')";
    const navMR="showPage('pageMR','MR')";
    const navApprove="showPage('pageApprove','Approve')";

    // Vertical strip: location name only
    const vertName='<div style="writing-mode:vertical-rl;text-orientation:mixed;transform:rotate(180deg);background:'+locColor+';color:'+colourContrast(locColor)+';font-size:11px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;padding:8px 6px;display:flex;align-items:center;justify-content:center;cursor:pointer;min-width:26px;flex-shrink:0;white-space:nowrap" onclick="'+navTrips+'" title="View trips">'+loc.name+'</div>';

    return '<div style="border-radius:10px;margin-bottom:6px;overflow:hidden;border:1px solid '+locBorder+';background:'+locBg+';display:flex;width:fit-content">'
      +vertName
      +'<div style="padding:3px 4px;flex-shrink:0">'
        +'<div style="display:grid;grid-template-columns:36px 89px 89px 36px 36px 56px;gap:3px">'
          +cell(totalTrips,0,navTrips)
          +dualCell(doneGateExit,pendingGateExit,doneGateEntry,pendingGateEntry,navKap)
          +(()=>{
  const p=navKap;
  const _bgN='rgba(255,255,255,0.6)',_bgH='rgba(255,255,255,0.9)';
  return '<div style="background:'+_bgN+';border:1px solid rgba(0,0,0,0.07);border-radius:6px;width:89px;height:46px;text-align:center;display:flex;align-items:center;justify-content:center;box-sizing:border-box;cursor:pointer" onclick="'+p+'" onmouseover="this.style.background=\''+_bgH+'\'" onmouseout="this.style.background=\''+_bgN+'\'">'
    +'<div style="display:flex;justify-content:space-around;gap:4px">'
      +'<div><div style="font-size:7px;color:#888;margin-bottom:2px;text-transform:uppercase;letter-spacing:.3px">Exited</div><div style="font-size:15px;font-weight:900;color:#111;line-height:1;letter-spacing:-1px">'+spotExitedToday+'</div><div style="font-size:8px;color:#bbb">today</div></div>'
      +'<div style="width:1px;background:rgba(0,0,0,0.08)"></div>'
      +'<div><div style="font-size:7px;color:#888;margin-bottom:2px;text-transform:uppercase;letter-spacing:.3px">Inside</div><div style="font-size:15px;font-weight:900;color:'+(spotInside>0?'#dc2626':'#111')+';line-height:1;letter-spacing:-1px">'+spotInside+'</div>'+(spotInside>0?'<div style="font-size:8px;font-weight:800;color:#dc2626">'+spotInside+' now</div>':'<div style="font-size:7px;color:#bbb">-</div>')+'</div>'
    +'</div>'
  +'</div>';
})()
          +cell(doneMR,pendingMR,navMR)
          +cell(doneApprove,pendingApprove,navApprove)
          +'<div style="background:rgba(255,255,255,0.6);border:1px solid rgba(0,0,0,0.07);border-radius:6px;width:56px;height:46px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;box-sizing:border-box">'
            +'<div style="font-size:9px;font-weight:900;color:'+(totalCost>0?'#16a34a':'#bbb')+';line-height:1;letter-spacing:-.3px">'+(totalCost>0?'₹'+totalCost.toLocaleString('en-IN'):'—')+'</div>'
          +'</div>'
        +'</div>'
      +'</div>'
    +'</div>';
  });

  // Single shared header row above all location cards
  const headerRow='<div style="display:flex;width:fit-content;align-items:center;margin-bottom:4px;background:rgba(30,30,40,0.82);border:1.5px solid rgba(0,0,0,0.25);border-radius:8px;padding:3px 6px 3px 0">'
    +'<div style="min-width:26px;flex-shrink:0"></div>'
    +'<div style="display:grid;grid-template-columns:36px 89px 89px 36px 36px 56px;gap:3px">'
    +['Bookings','Pre-Booked Gates','Spot Entry','Mat. Rcpt','Trip Approval','Cost ₹'].map((h,i)=>'<div style="text-align:center;font-size:8px;font-weight:900;color:#e2e8f0;text-transform:uppercase;letter-spacing:.5px;padding:2px 2px;border-left:'+(i>0?'1.5px solid rgba(255,255,255,0.15)':'none')+'">'+h+'</div>').join('')
    +'</div></div>';

  el.innerHTML = headerRow + cards.join('');
}

// ═══ REPORTS ════════════════════════════════════════════════════════════
function initRptDates(){
  const now=new Date();
  const from=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const to=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const fe=document.getElementById('rptFrom');const te=document.getElementById('rptTo');
  if(fe&&!fe.value){fe.value=from;updDateBtnLbl('rptFrom');}
  if(te&&!te.value){te.value=to;updDateBtnLbl('rptTo');}
}
// getReportData, rptRow → moved to vms-logic.js

function renderReports(){
  initDfMonth('rpt','rptFrom','rptTo');
  initRptDates();
  const {segs,canSeeAmt}=getReportData();

  // Populate vendor dropdown
  const vndSel=document.getElementById('rptVendor');
  const curVnd=vndSel?.value||'';
  const vendors=[...new Set(segs.map(s=>{const t=byId(DB.trips,s.tripId);return byId(DB.vendors,byId(DB.vehicles,t?.vehicleId)?.vendorId)?.name||t?.vendor||'-';}).filter(Boolean))].sort();
  if(vndSel)vndSel.innerHTML='<option value="">Vendor ▾</option>'+vendors.map(v=>`<option value="${v}"${v===curVnd?' selected':''}>${v}</option>`).join('');

  // Populate vehicle dropdown
  const vehSel=document.getElementById('rptVehicle');
  const curVeh=vehSel?.value||'';
  const vehicles=[...new Set(segs.map(s=>vnum(byId(DB.trips,s.tripId)?.vehicleId)).filter(v=>v&&v!=='-'))].sort();
  if(vehSel)vehSel.innerHTML='<option value="">Vehicle ▾</option>'+vehicles.map(v=>`<option value="${v}"${v===curVeh?' selected':''}>${v}</option>`).join('');

  // Populate location dropdown (start OR destination locations)
  const locSel=document.getElementById('rptLocation');
  const curLoc=locSel?.value||'';
  const locIds=[...new Set(segs.flatMap(s=>[s.sLoc,s.dLoc]).filter(Boolean))];
  const locOpts=sortLocsKapFirst(locIds.map(id=>{const l=byId(DB.locations,id);return {id,name:l?.name||id,type:l?.type||''};}));
  if(locSel)locSel.innerHTML='<option value="">Location ▾</option>'+locOpts.map(l=>`<option value="${l.id}"${l.id===curLoc?' selected':''}>${l.name}</option>`).join('');

  // Apply filters
  let rows=segs.map(rptRow);
  if(curVnd)rows=rows.filter(r=>r.vendor===curVnd);
  if(curVeh)rows=rows.filter(r=>r.vehicleNo===curVeh);
  if(curLoc)rows=rows.filter(r=>r.seg.sLoc===curLoc||r.seg.dLoc===curLoc);

  if(!rows.length){
    document.getElementById('rptContent').innerHTML='<div class="empty-state">No completed trips in selected period</div>';
    const tb=document.getElementById('rptTotal');if(tb)tb.style.display='none';
    return;
  }

  // Group by base trip ID
  const baseTripId=tid=>tid.replace(/-R\d+$/,'');
  const tripGroups={};
  rows.forEach(r=>{
    const base=baseTripId(r.seg.tripId);
    if(!tripGroups[base])tripGroups[base]=[];
    tripGroups[base].push(r);
  });

  // Sort groups by date descending
  const sortedGroups=Object.entries(tripGroups).sort(([,a],[,b])=>(b[0].date||'').localeCompare(a[0].date||''));

  const rateHeader=canSeeAmt?'<th style="padding:4px 6px;white-space:nowrap">Rate</th>':'';
  let grandTotal=0;

  const th=(t,extra)=>`<th style="padding:4px 6px;white-space:nowrap${extra?';'+extra:''}">${t}</th>`;
  const td=(v,extra)=>`<td style="font-size:10px;padding:4px 6px;vertical-align:top${extra?';'+extra:''}">${v||'—'}</td>`;

  const html=sortedGroups.map(([baseId,tripRows])=>{
    tripRows.sort((a,b)=>a.seg.label.localeCompare(b.seg.label));
    const first=tripRows[0];
    const trip2=first.trip;
    const rate=canSeeAmt?getMatchedRate(first.trip?.id):null;
    if(rate)grandTotal+=rate.rate;
    const actVtSame=first.actVehicleType==='-'||first.actVehicleType===first.recVehicleType;
    // Full route: startLoc to dest1 to dest2 to dest3
    const routeLocs=[trip2?.startLoc,trip2?.dest1,trip2?.dest2,trip2?.dest3].filter(Boolean);
    const fullRoute=routeLocs.map(id=>lnameText(id)).join(' to ');
    // Overall status: worst segment status
    const allSegs=DB.segments.filter(s=>s.tripId===first.seg.tripId);
    const isCompleted=allSegs.every(s=>s.status==='Completed');
    const isRejected=allSegs.some(s=>s.status==='Rejected');
    const overallStatus=isCompleted?'Done':isRejected?'Rejected':first.status;
    const overallClr=isCompleted?'#16a34a':isRejected?'#dc2626':'var(--accent)';
    // Gate exit: earliest step1 time; Gate entry: latest step2 time
    const exitTimes=allSegs.map(s=>s.steps[1]?.time).filter(Boolean).sort();
    const entryTimes=allSegs.map(s=>s.steps[2]?.time).filter(Boolean).sort();
    const fmtTs=ts=>ts?new Date(ts).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'2-digit',hour:'2-digit',minute:'2-digit',hour12:true}):'—';
    const gateExit=exitTimes.length?fmtTs(exitTimes[0]):'—';
    const gateEntry=entryTimes.length?fmtTs(entryTimes[entryTimes.length-1]):'—';
    // MR: all segments that have MR done
    const mrDoneSegs=tripRows.filter(r=>r.mrBy!=='-');
    const mrNames=[...new Set(mrDoneSegs.map(r=>r.mrBy))].join(', ')||'—';
    const mrTimes=mrDoneSegs.map(r=>r.mrTime).filter(t=>t!=='—').sort();
    const mrTime=mrTimes.length?mrTimes[mrTimes.length-1]:'—';
    const hasDiscrepancy=tripRows.some(r=>r.mrDiscrepancy);
    // Approval
    const apDoneRows=tripRows.filter(r=>r.approvedBy!=='-');
    const apBy=[...new Set(apDoneRows.map(r=>r.approvedBy))].join(', ')||'—';
    const apTimes=apDoneRows.map(r=>r.approvedTime).filter(t=>t!=='—').sort();
    const apTime=apTimes.length?apTimes[apTimes.length-1]:'—';

    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="font-family:var(--mono);font-size:12px;font-weight:900;color:var(--accent);padding:4px 6px;white-space:nowrap">${baseId}</td>
      <td style="font-family:var(--mono);font-size:12px;font-weight:900;padding:4px 6px;white-space:nowrap">${first.vehicleNo}</td>
      <td style="font-size:10px;padding:4px 6px">${first.vendor}</td>
      <td style="font-size:10px;padding:4px 6px">${first.driver}</td>
      <td style="font-size:10px;padding:4px 6px;white-space:nowrap"><div style="font-weight:700;color:#16a34a">${first.recVehicleType}</div>${!actVtSame?`<div style="color:#dc2626;font-size:9px">Act: ${first.actVehicleType}</div>`:''}</td>
      <td style="font-size:10px;padding:4px 6px">${fullRoute}</td>
      <td style="font-size:10px;padding:4px 6px;color:${overallClr};font-weight:700;white-space:nowrap">${overallStatus}</td>
      <td style="font-size:10px;padding:4px 6px;white-space:nowrap"><div style="font-weight:700">${first.bookedBy}</div><div style="color:var(--text3);font-size:9px">${first.bookedTime}</div></td>
      <td style="font-size:10px;padding:4px 6px;white-space:nowrap">${first.editedBy!=='-'?`<div style="font-weight:700">${first.editedBy}</div><div style="color:var(--text3);font-size:9px">${first.editedTime}</div>`:'<span style="color:var(--text3)">—</span>'}</td>
      <td style="font-size:10px;padding:4px 6px;white-space:nowrap;color:var(--text3)">${gateExit}</td>
      <td style="font-size:10px;padding:4px 6px;white-space:nowrap;color:var(--text3)">${gateEntry}</td>
      <td style="font-size:10px;padding:4px 6px;white-space:nowrap"><div style="font-weight:700;color:#0d9488">${mrNames}</div><div style="color:var(--text3);font-size:9px">${mrTime!=='—'?mrTime:''}</div>${hasDiscrepancy?'<div style="color:#dc2626;font-weight:700;font-size:9px">Discrepancy</div>':''}</td>
      <td style="font-size:10px;padding:4px 6px;white-space:nowrap"><div style="font-weight:700;color:#7c3aed">${apBy}</div><div style="color:var(--text3);font-size:9px">${apTime!=='—'?apTime:''}</div></td>
      ${canSeeAmt?`<td style="font-family:var(--mono);font-weight:700;color:#16a34a;font-size:11px;padding:4px 6px;white-space:nowrap">${rate?'Rs.'+rate.rate.toLocaleString():'—'}</td>`:''}
    </tr>`;
  }).join('');

  const headers=`<tr>
    ${th('Trip ID')}${th('Vehicle')}${th('Vendor')}${th('Driver')}
    ${th('Rec. Type / Actual')}${th('Route')}${th('Status')}
    ${th('Booked By')}${th('Edited By')}
    ${th('Gate Exit')}${th('Gate Entry')}${th('Mat. Receipt')}${th('Approved By')}
    ${rateHeader}</tr>`;
  document.getElementById('rptContent').innerHTML=`<div class="table-wrap"><table style="font-size:11px;border-collapse:collapse"><thead style="position:sticky;top:0;background:var(--surface2);z-index:1">${headers}</thead><tbody>${html}</tbody></table></div>`;

  const tc=document.getElementById('rptTotalCount');const ta=document.getElementById('rptTotalAmt');const tb=document.getElementById('rptTotal');
  if(tc)tc.textContent=`${sortedGroups.length} trip${sortedGroups.length!==1?'s':''}`;
  if(ta)ta.textContent=canSeeAmt&&grandTotal>0?`₹${grandTotal.toLocaleString()}`:'';
  if(tb)tb.style.display=rows.length?'flex':'none';
}

function downloadReportExcel(){
  initRptDates();
  const {segs,canSeeAmt}=getReportData();
  const fromVal=document.getElementById('rptFrom')?.value||'';
  const toVal=document.getElementById('rptTo')?.value||'';

  const headers=['Trip ID','Vehicle No.','Vendor','Driver','Rec. Vehicle Type','Act. Vehicle Type','Route','Status','Booked By','Booked Date','Edited By','Edited Date','Gate Exit','Gate Entry','MR By','MR Date','Discrepancy','MR Remarks','Approved By','Approved Date'];
  if(canSeeAmt)headers.push('Rate (₹)');

  // Group by base trip, one row per trip
  const csvBaseTripId=tid=>tid.replace(/-R\d+$/,'');
  const csvGroups={};
  segs.map(rptRow).forEach(r=>{const b=csvBaseTripId(r.seg.tripId);if(!csvGroups[b])csvGroups[b]=[];csvGroups[b].push(r);});
  let grandTotal=0;
  const dataRows=Object.entries(csvGroups).sort(([,a],[,b])=>(b[0].date||'').localeCompare(a[0].date||'')).map(([baseId,tripRows])=>{
    tripRows.sort((a,b)=>a.seg.label.localeCompare(b.seg.label));
    const first=tripRows[0];const trip2=first.trip;
    const rate=canSeeAmt?getMatchedRate(first.trip?.id):null;
    if(rate)grandTotal+=rate.rate;
    const routeLocs=[trip2?.startLoc,trip2?.dest1,trip2?.dest2,trip2?.dest3].filter(Boolean);
    const fullRoute=routeLocs.map(id=>lnameText(id)).join(' to ');
    const allSegs2=DB.segments.filter(s=>s.tripId===first.seg.tripId);
    const isCompleted2=allSegs2.every(s=>s.status==='Completed');
    const isRejected2=allSegs2.some(s=>s.status==='Rejected');
    const overallStatus2=isCompleted2?'Done':isRejected2?'Rejected':first.status;
    const exitTimes2=allSegs2.map(s=>s.steps[1]?.time).filter(Boolean).sort();
    const entryTimes2=allSegs2.map(s=>s.steps[2]?.time).filter(Boolean).sort();
    const fmtTs2=ts=>ts?new Date(ts).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'2-digit',hour:'2-digit',minute:'2-digit',hour12:true}):'';
    const mrDoneSegs2=tripRows.filter(r=>r.mrBy!=='-');
    const mrNames2=[...new Set(mrDoneSegs2.map(r=>r.mrBy))].join('; ')||'';
    const mrTimes2=mrDoneSegs2.map(r=>r.mrTime).filter(t=>t!=='—').sort();
    const apDoneRows2=tripRows.filter(r=>r.approvedBy!=='-');
    const apBy2=[...new Set(apDoneRows2.map(r=>r.approvedBy))].join('; ')||'';
    const apTimes2=apDoneRows2.map(r=>r.approvedTime).filter(t=>t!=='—').sort();
    const hasDiscrep2=tripRows.some(r=>r.mrDiscrepancy)?'Yes':'';
    const discrRemarks2=tripRows.filter(r=>r.mrRemarks).map(r=>r.mrRemarks).join('; ');
    const row=[baseId,first.vehicleNo,first.vendor,first.driver,first.recVehicleType,first.actVehicleType!=='-'?first.actVehicleType:'',fullRoute,overallStatus2,first.bookedBy,first.bookedTime,first.editedBy!=='-'?first.editedBy:'',first.editedTime||'',exitTimes2.length?fmtTs2(exitTimes2[0]):'',entryTimes2.length?fmtTs2(entryTimes2[entryTimes2.length-1]):'',mrNames2,mrTimes2.length?mrTimes2[mrTimes2.length-1]:'',hasDiscrep2,discrRemarks2,apBy2,apTimes2.length?apTimes2[apTimes2.length-1]:''];
    if(canSeeAmt)row.push(rate?rate.rate:'');
    return row;
  });
  if(canSeeAmt&&grandTotal>0){
    const tot=new Array(headers.length).fill('');tot[0]='Total';if(canSeeAmt)tot[tot.length-1]=grandTotal;
    dataRows.push(tot);
  }

  // Use real OOXML XLSX builder (proper ZIP format readable by all modern apps)
  const xlData=[headers,...dataRows];
  _downloadAsXlsx(xlData,'Trip Report','KAP_TripReport_'+fromVal+'_to_'+toVal+'.xlsx');
  notify('✅ Trip report exported (' + dataRows.length + ' trips)');
}
function downloadReportPDF(){
  initRptDates();
  const {segs,canSeeAmt}=getReportData();
  const fromVal=document.getElementById('rptFrom')?.value||'';
  const toVal=document.getElementById('rptTo')?.value||'';

  const rows=segs.map(rptRow).sort((a,b)=>a.vendor.localeCompare(b.vendor)||a.vehicleType.localeCompare(b.vehicleType)||a.vehicleNo.localeCompare(b.vehicleNo));
  let grandTotal=0;

  // Group for PDF
  const grouped={};
  rows.forEach(r=>{
    const k=r.vendor+'||'+r.vehicleType+'||'+r.vehicleNo;
    if(!grouped[k])grouped[k]=[];
    grouped[k].push(r);
  });

  const rateHeader=canSeeAmt?'<th style="padding:6px 8px;background:#111827;color:#fff;text-align:right">Rate (₹)</th>':'';
  let tableRows='';
  let lastVendor='',lastType='',lastVno='';
  Object.entries(grouped).forEach(([key,trips])=>{
    const [vendor,vtype,vno]=key.split('||');
    if(vendor!==lastVendor){
      tableRows+=`<tr style="background:#1e3a5f"><td colspan="${canSeeAmt?9:8}" style="padding:8px;font-weight:800;color:#5cc4c8;font-size:13px">🏢 ${vendor}</td></tr>`;
      lastVendor=vendor;lastType='';lastVno='';
    }
    if(vtype!==lastType){
      tableRows+=`<tr style="background:#1e293b"><td colspan="${canSeeAmt?9:8}" style="padding:6px 12px;font-weight:700;color:#94a3b8;font-size:12px">📦 ${vtype}</td></tr>`;
      lastType=vtype;lastVno='';
    }
    if(vno!==lastVno){
      tableRows+=`<tr style="background:#0f172a"><td colspan="${canSeeAmt?9:8}" style="padding:5px 20px;font-weight:700;color:#e2e8f0;font-size:11px">🚗 ${vno}</td></tr>`;
      lastVno=vno;
    }
    trips.forEach(r=>{
      const rate=canSeeAmt?getMatchedRate(r.trip?.id):null;
      if(rate)grandTotal+=rate.rate;
      tableRows+=`<tr style="border-bottom:1px solid #e5e7eb">
        <td style="padding:5px 8px;font-size:10px;font-family:monospace;color:#f5a623">${r.segId}</td>
        <td style="padding:5px 8px;font-size:10px">${fdt(r.date)}</td>
        <td style="padding:5px 8px;font-size:10px">${r.route}</td>
        <td style="padding:5px 8px;font-size:10px">${r.driver}</td>
        <td style="padding:5px 8px;font-size:10px;color:#555">${r.startTime}</td>
        <td style="padding:5px 8px;font-size:10px;color:#555">${r.endTime}</td>
        <td style="padding:5px 8px;font-size:10px">${r.approvedBy}</td>
        ${canSeeAmt?`<td style="padding:5px 8px;font-size:10px;text-align:right;font-weight:700;color:#16a34a">${rate?'₹'+rate.rate.toLocaleString():'-'}</td>`:''}
      </tr>`;
    });
  });

  const totalRow=canSeeAmt&&grandTotal>0?`<tr style="background:#f0fdf4"><td colspan="${canSeeAmt?8:7}" style="padding:8px;font-weight:700;text-align:right">Grand Total</td><td style="padding:8px;font-weight:800;font-size:14px;color:#16a34a;text-align:right">₹${grandTotal.toLocaleString()}</td></tr>`:'';
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Trip Report</title>
  <style>body{font-family:Arial,sans-serif;margin:20px;color:#111;font-size:12px}h1{font-size:18px;margin-bottom:2px}h3{color:#555;font-weight:400;margin-bottom:12px;font-size:12px}table{width:100%;border-collapse:collapse}th{background:#111827;color:#fff;padding:6px 8px;text-align:left;font-size:11px}tr:nth-child(even){background:#f9fafb}@media print{button{display:none}}</style>
  </head><body>
  <h1>KELKAR AUTO PARTS PRIVATE LIMITED</h1>
  <h3>Trip History Report &middot; ${fromVal} to ${toVal} &middot; ${segs.length} segment(s)</h3>
  <table><thead><tr><th>Segment</th><th>Date</th><th>Route</th><th>Driver</th><th>Gate Exit</th><th>Approved On</th><th>Approved By</th>${rateHeader}</tr></thead>
  <tbody>${tableRows}${totalRow}</tbody></table>
  <script>window.print();<\/script>
<!-- SPOT ENTRY EDIT MODAL -->
<div class="modal-overlay" id="mSpotEdit" style="align-items:center!important"><div class="modal" style="width:min(420px,95vw);border-radius:16px">
  <div class="modal-header"><div class="modal-title">✏ Edit Spot Entry</div><div class="modal-close" onclick="cm('mSpotEdit')">×</div></div>
  <input type="hidden" id="seEditId">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:4px 0">
    <div class="form-group" style="margin-bottom:0;grid-column:1/-1"><label style="font-size:10px;font-weight:700;color:#000">VEHICLE NO. *</label><input type="text" id="seVehNum" oninput="fmtVehNum(this)" maxlength="13" style="font-family:var(--mono);letter-spacing:1px;text-transform:uppercase;padding:6px 10px;font-size:14px"></div>
    <div class="form-group" style="margin-bottom:0"><label style="font-size:10px;font-weight:700;color:#000">DRIVER NAME</label><input type="text" id="seDriverName" placeholder="Name" style="padding:6px 10px;font-size:13px"></div>
    <div class="form-group" style="margin-bottom:0"><label style="font-size:10px;font-weight:700;color:#000">MOBILE</label><input type="tel" id="seDriverMob" maxlength="10" placeholder="10 digits" style="padding:6px 10px;font-size:13px"></div>
    <div class="form-group" style="margin-bottom:0"><label style="font-size:10px;font-weight:700;color:#000">SUPPLIER</label><input type="text" id="seSupplier" placeholder="Supplier" style="padding:6px 10px;font-size:13px"></div>
    <div class="form-group" style="margin-bottom:0"><label style="font-size:10px;font-weight:700;color:#000">CHALLAN NO.</label><input type="text" id="seChallan" placeholder="Challan" style="padding:6px 10px;font-size:13px"></div>
    <div class="form-group" style="margin-bottom:0;grid-column:1/-1"><label style="font-size:10px;font-weight:700;color:#000">REMARKS</label><input type="text" id="seRemarks" placeholder="Optional" style="padding:6px 10px;font-size:13px"></div>
  </div>
  <div class="modal-footer" style="border-top:1px solid var(--border);padding-top:10px;margin-top:8px">
    <div class="modal-err" id="merr_mSpotEdit"></div>
    <button class="btn btn-secondary" onclick="cm('mSpotEdit')">Cancel</button>
    <button class="btn btn-primary" onclick="saveSpotEdit()">💾 Save</button>
  </div>
</div></div>
</body></html>`;
  const w=window.open('','_blank');
  if(!w){notify('Please allow popups to download the PDF report',true);return;}
  w.document.write(html);w.document.close();
}

// ═══ MY PROFILE ═════════════════════════════════════════════════════════
function togglePassSection(){
  const s=document.getElementById('passSection');
  const ic=document.getElementById('passToggleIcon');
  if(!s)return;
  const open=s.style.display==='none';
  s.style.display=open?'block':'none';
  if(ic)ic.textContent=open?'▲':'▼';
}
async function clearProfilePhoto(){
  CU.photo='';
  const dbU=byId(DB.users,CU.id);
  if(dbU){ dbU.photo=''; await _dbSave('users',dbU); }
  const btn=document.getElementById('profilePhotoClearBtn');if(btn)btn.style.display='none';
  _refreshCurrentUserUI();
}
function showProfile(){
  const u=CU;
  if(!u)return;
  document.getElementById('profileFullName').value=u.fullName||'';
  document.getElementById('profileUsername').value=u.name||'';
  document.getElementById('profileMobile').value=u.mobile||'';
  document.getElementById('profileEmail').value=u.email||'';
  document.getElementById('profileOldPass').value='';
  document.getElementById('profileNewPass').value='';
  document.getElementById('profileConfPass').value='';
  document.getElementById('profileDisplayName').textContent=u.fullName||u.name;
  document.getElementById('profileDisplayRole').textContent=(u.roles||[]).concat(u.hwmsRoles||[]).join(', ');
  const udEl=document.getElementById('profileDisplayUsername');if(udEl)udEl.textContent='@'+u.name;
  // Avatar: photo or initials
  const av=document.getElementById('profileAvatar');
  const clearBtn=document.getElementById('profilePhotoClearBtn');
  if(u.photo){
    av.style.backgroundImage=`url(${u.photo})`;av.style.backgroundSize='cover';av.style.backgroundPosition='center';av.textContent='';
    if(clearBtn)clearBtn.style.display='block';
  } else {
    av.style.backgroundImage='';av.textContent=(u.fullName||u.name)[0].toUpperCase();
    if(clearBtn)clearBtn.style.display='none';
  }
  // Reset password section
  const ps=document.getElementById('passSection');if(ps)ps.style.display='none';
  const pi=document.getElementById('passToggleIcon');if(pi)pi.textContent='▼';
  // Show Save as Seed card only for Super Admin
}

function onProfilePhoto(input){
  const f=input.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=e=>{
    const dataUrl=e.target.result;
    CU.photo=dataUrl; // set immediately for display
    const btn=document.getElementById('profilePhotoClearBtn');if(btn)btn.style.display='block';
    // Immediately update ALL avatars with raw photo
    _refreshCurrentUserUI();
    // Compress and replace stored photo
    compressImage(f).then(async c=>{
      CU.photo=c;
      const dbU=DB.users.find(u=>u.id===CU.id);
      if(dbU){ dbU.photo=c; await _dbSave('users',dbU); }
      _refreshCurrentUserUI();
    }).catch(()=>{});
  };
  r.readAsDataURL(f);
}
async function saveProfile(){
  const fullName=document.getElementById('profileFullName').value.trim();
  const mobile=document.getElementById('profileMobile').value.trim();
  const email=document.getElementById('profileEmail').value.trim();
  const oldPass=document.getElementById('profileOldPass').value;
  const newPass=document.getElementById('profileNewPass').value;
  const confPass=document.getElementById('profileConfPass').value;
  if(!fullName){notify('Full name required',true);return;}
  if(mobile&&mobile.length!==10){notify('Mobile must be 10 digits',true);return;}
  if(newPass||oldPass||confPass){
    const _pwdE=_pwdErrors(newPass);
    if(_pwdE.length){notify('Password requires: '+_pwdE.join(', '),true);return;}
    if(newPass!==confPass){notify('New passwords do not match',true);return;}
    // Server-side password change
    showSpinner('Changing password…');
    var pwdOk=await _authChangePassword(CU.name,oldPass,newPass);
    hideSpinner();
    if(!pwdOk){notify('Current password is incorrect',true);return;}
    // Get new session token
    var r2=await _authLogin(CU.name,newPass);
    if(r2&&r2.token){_sessionSet('kap_session_token',r2.token);try{localStorage.setItem('kap_rm_token',r2.token);}catch(e){}}
  }
  CU.fullName=fullName;CU.mobile=mobile;CU.email=email;
  const dbUser=byId(DB.users,CU.id);
  if(dbUser){
    const _bak={...dbUser};
    Object.assign(dbUser,{fullName,mobile,email,photo:CU.photo||''});
    if(!await _dbSave('users',dbUser)){ Object.assign(dbUser,_bak); CU.fullName=_bak.fullName;CU.mobile=_bak.mobile;CU.email=_bak.email; return; }
  }
  
  // Update sidebar
  document.getElementById('uName2').textContent=fullName||CU.name;
  document.getElementById('profileDisplayName').textContent=fullName||CU.name;
  document.getElementById('profileOldPass').value='';document.getElementById('profileNewPass').value='';document.getElementById('profileConfPass').value='';
  _refreshCurrentUserUI();
  notify('Profile saved!');
}

// Update compact date button label to show dd-MMM-yy format
function updDateBtnLbl(id){
  const inp=document.getElementById(id);
  const lbl=document.getElementById(id+'Lbl');
  if(!inp||!lbl)return;
  if(inp.value){
    const d=new Date(inp.value+'T00:00:00');
    const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    lbl.textContent='📅 '+String(d.getDate()).padStart(2,'0')+'-'+mo[d.getMonth()]+'-'+String(d.getFullYear()).slice(2);
  } else {
    lbl.textContent='📅 —';
  }
}

function setDashMonth(offset){
  // no-op - All Trips tab removed; overview dates handled by setOvMonth
  setOvMonth&&setOvMonth();
}

function renderDash(){
  if(typeof renderDashOverview==='function'){renderDashOverview();}
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');
  const canSeeAmt=(CU.roles.includes('Super Admin')||CU.roles.includes('Admin')||CU.roles.includes('Trip Approver'))
    && !CU.roles.includes('KAP Security')
    && !CU.roles.includes('Material Receiver');
  const visibleTrips=getVisibleTrips();

  // Update page sub-title to reflect active location scope
  const pageSub=document.querySelector('#pageDashboard .page-sub');
  if(pageSub&&isSA){
    if(_adminLocFilter){
      const fl=byId(DB.locations,_adminLocFilter);
      const flName=fl?.name||_adminLocFilter;
      const flColour=fl?.colour||'var(--accent)';
      const tc=colourContrast(fl?.colour||'');
      pageSub.innerHTML=`Vehicle operations overview &nbsp;·&nbsp; <span style="background:${flColour};color:${tc};padding:2px 10px;border-radius:5px;font-weight:700;font-size:12px">${flName}</span>`;
    } else {
      pageSub.textContent='Vehicle operations overview';
    }
  }

  // If Trip Details tab is currently visible, refresh it too
  const tripsPanel=document.getElementById('dashTripsPanel');
  if(tripsPanel&&tripsPanel.style.display!=='none'){
    if(typeof renderDashTrips==='function') renderDashTrips();
  }
}

async function deleteTrip(tripId){
  const trip = byId(DB.trips, tripId);
  if(!trip) return;
  const segs = DB.segments.filter(s=>s.tripId===tripId);
  const drv  = byId(DB.drivers, trip.driverId);
  document.getElementById('delTripInfo').innerHTML =
    `${tripCardHeader(trip)}
     <div style="color:var(--text3);font-size:12px;margin-top:6px">${segs.length} segment(s) will also be deleted</div>`;
  document.getElementById('btnConfirmDelete').dataset.tripId = tripId;
  om('mDeleteTrip');
}

async function confirmDeleteTrip(){
  const tripId = document.getElementById('btnConfirmDelete').dataset.tripId;
  // Rollback any auto-skipped empty exits linked to this trip
  await _rollbackAutoSkippedEmptyExit(tripId);
  for(const s of DB.segments.filter(s=>s.tripId===tripId)){if(!await _dbDel('segments',s.id)) return;}
  for(const t of DB.trips.filter(t=>t.id===tripId)){if(!await _dbDel('trips',t.id)) return;}
  cm('mDeleteTrip');
  notify(`Trip ${tripId} and all related segments deleted.`);
  renderDash();renderMyTrips();renderKap();
  updBadges();
}

// Scan all existing trips and auto-skip empty exit where a newer trip exists with same vehicle at same location
async function _autoSkipStaleEmptyExits(){
  var skipped=0;
  // Find all segments waiting for empty exit (step 5 pending)
  var pendingS5=DB.segments.filter(function(seg){
    if(seg.status==='Completed'||seg.status==='Locked') return false;
    var s5=seg.steps&&seg.steps[5];
    if(!s5||s5.skip||s5.done) return false;
    var t=byId(DB.trips,seg.tripId);
    if(!t||t.cancelled||!t.vehicleId) return false;
    return true;
  });
  for(var i=0;i<pendingS5.length;i++){
    var seg=pendingS5[i];
    var oldTrip=byId(DB.trips,seg.tripId);
    if(!oldTrip) continue;
    var vehId=oldTrip.vehicleId;
    var destLoc=seg.dLoc;
    // Find a newer trip with same vehicle starting from same location
    var newerTrip=DB.trips.find(function(t){
      if(t.id===oldTrip.id||t.cancelled) return false;
      if(t.vehicleId!==vehId) return false;
      if(t.startLoc!==destLoc) return false;
      // Must be booked after the old trip
      return (t.date||'')>(oldTrip.date||'');
    });
    if(newerTrip){
      seg.steps[5].skip=true;
      seg.steps[5].done=false;
      seg.steps[5].remarks='Auto-skipped: new trip '+newerTrip.id+' booked for same vehicle at same location';
      seg.currentStep=nextStep(seg);
      if(allStepsDone(seg)) seg.status='Completed';
      await _dbSave('segments',seg);
      // Complete old trip if all segments done
      var oldTripSegs=DB.segments.filter(function(s){return s.tripId===seg.tripId;});
      if(oldTripSegs.every(function(s){return s.status==='Completed'||s.status==='Rejected';})){
        oldTrip.completedAt=new Date().toISOString();
        await _dbSave('trips',oldTrip);
      }
      skipped++;
      console.log('Auto-skipped stale Empty Exit: seg '+seg.id+' (trip '+seg.tripId+') → newer trip '+newerTrip.id);
    }
  }
  if(skipped){
    notify('⏭ Auto-skipped empty exit on '+skipped+' old trip'+(skipped>1?'s':''));
    updBadges();renderKap();
  }
}

async function _rollbackAutoSkippedEmptyExit(tripId){
  // Find segments where step 5 was auto-skipped because of this trip
  var marker='Auto-skipped: new trip '+tripId+' ';
  var restored=0;
  for(var i=0;i<DB.segments.length;i++){
    var seg=DB.segments[i];
    if(seg.tripId===tripId) continue;// skip the trip's own segments
    var s5=seg.steps&&seg.steps[5];
    if(!s5||!s5.skip) continue;
    if((s5.remarks||'').indexOf(marker)!==0) continue;
    // Restore step 5
    s5.skip=false;
    s5.done=false;
    s5.remarks='';
    seg.currentStep=nextStep(seg);
    if(seg.status==='Completed') seg.status='Active';
    await _dbSave('segments',seg);
    // Undo trip completion if it was marked complete
    var oldTrip=byId(DB.trips,seg.tripId);
    if(oldTrip&&oldTrip.completedAt){
      delete oldTrip.completedAt;
      await _dbSave('trips',oldTrip);
    }
    restored++;
  }
  if(restored) console.log('Restored empty exit on '+restored+' segment(s) after trip '+tripId+' cancelled/deleted');
}
async function cancelTrip(tripId){
  const trip=byId(DB.trips,tripId);
  if(!trip) return;
  const segs=DB.segments.filter(s=>s.tripId===tripId);
  const anyActionDone=segs.some(s=>[1,2,3,4].some(n=>s.steps[n]?.done));
  if(anyActionDone){notify('Cannot cancel — trip already has executed steps',true);return;}
  showConfirm('Cancel trip '+tripId+'?\n\nThis will mark the trip as Cancelled.', async ()=>{
    const bak={...trip};
    trip.cancelled=true;
    if(!await _dbSave('trips',trip)){Object.assign(trip,bak);return;}
    for(const seg of segs){
      const segBak={...seg};
      seg.status='Locked';
      if(!await _dbSave('segments',seg)){Object.assign(seg,segBak);}
    }
    // Rollback any auto-skipped empty exits linked to this trip
    await _rollbackAutoSkippedEmptyExit(tripId);
    notify('Trip '+tripId+' cancelled');
    renderMyTrips();renderDash();renderKap();updBadges();
  });
}

// ═══ TRIP BOOKING ═══════════════════════════════════════════════════════
let _tbPageTab='active';

function initTbHistDates(){
  const now=new Date();
  const to=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const from1=new Date(now.getFullYear(),now.getMonth(),1);
  const from=`${from1.getFullYear()}-${String(from1.getMonth()+1).padStart(2,'0')}-01`;
  const fe=document.getElementById('tbHistFrom');const te=document.getElementById('tbHistTo');
  if(fe&&!fe.value){fe.value=from;updDateBtnLbl('tbHistFrom');}
  if(te&&!te.value){te.value=to;updDateBtnLbl('tbHistTo');}
}

// genTripId, _tripIdPrefix, _cTid → moved to vms-logic.js

let _tbDestCount=1;// how many destinations are visible (1-3)

function openTripBookingModal(editTripId){
  // If vehicleTypes not loaded yet, demand-load first then open
  if(!(DB.vehicleTypes||[]).length&&typeof _demandLoad==='function'){
    showSpinner('Loading vehicle types…');
    _demandLoad(['vehicleTypes','vehicles','drivers','locations','vendors']).then(function(){
      hideSpinner();
      _openTripBookingModalInner(editTripId);
    }).catch(function(){hideSpinner();_openTripBookingModalInner(editTripId);});
    return;
  }
  _openTripBookingModalInner(editTripId);
}
function _openTripBookingModalInner(editTripId){
  _editingTripId=editTripId||null;
  const t=editTripId?byId(DB.trips,editTripId):null;

  // Populate location combos — clear text inputs and hidden values
  _locComboSetValue('tbStart','');
  _locComboSetValue('tbDest1','');
  _locComboSetValue('tbDest2','');
  _locComboSetValue('tbDest3','');
  // driver autocomplete list is populated dynamically via driverAcInput()
  const _vtOpts='<option value="">— Select Type —</option>'+sortBy((DB.vehicleTypes||[]).filter(vt=>!vt.inactive),vt=>vt.name).map(vt=>`<option value="${vt.id}">${vt.name}</option>`).join('');
  document.getElementById('tbVehicleType_sel').innerHTML=_vtOpts;
  const _actSel2=document.getElementById('tbActualVType_sel');
  if(_actSel2) _actSel2.innerHTML=_vtOpts;
  document.getElementById('tbVehicle').innerHTML='<option value="">— Select actual type first —</option>';
  document.getElementById('tbVehicle').disabled=true;
  const _mw=document.getElementById('tbVtMismatchWarn');if(_mw)_mw.classList.remove('show');
  [1,2,3].forEach(n=>clearChallanList(n));

  // Title (set early, re-confirmed after clearTripForm below)
  const titleEl=document.getElementById('tbModalTitle');
  if(titleEl)titleEl.textContent=t?'AMEND TRIP':'BOOK NEW TRIP';

  // Trip ID: for edit show existing ID; for new trips show pending until save
  const tripId=t?t.id:'';
  document.getElementById('tbTripId').value=tripId;
  document.getElementById('tbTripIdDisplay').textContent=tripId||'—';

  // Reset destinations visibility
  _tbDestCount=1;
  document.getElementById('tbDest2Wrap').style.display='none';
  document.getElementById('tbDest3Wrap').style.display='none';
  document.getElementById('tbAddDestBtn').style.display='block';

  // Clear all fields (save editId since clearTripForm resets it)
  const savedEditId=_editingTripId;
  clearTripForm();
  _editingTripId=savedEditId;
  // Restore title and trip ID display after clearTripForm
  if(titleEl)titleEl.textContent=t?'AMEND TRIP':'BOOK NEW TRIP';
  document.getElementById('tbTripIdDisplay').textContent=tripId||'—';
  document.getElementById('tbTripId').value=tripId;

  // Set button label and section visibility AFTER clearTripForm (which resets them)
  const bookBtn=document.getElementById('tbBookBtn');
  if(bookBtn)bookBtn.textContent=t?'Update':'Book Trip';
  document.querySelectorAll('.tb-amend-only').forEach(el=>{
    el.style.display=t?'':'none';
  });

  // If editing, pre-fill
  if(t){
    const segs=DB.segments.filter(s=>s.tripId===editTripId).sort((a,b)=>a.label.localeCompare(b.label));
    const segA=segs.find(s=>s.label==='A');
    const segB=segs.find(s=>s.label==='B');
    const segC=segs.find(s=>s.label==='C');
    const aStarted=segA&&[1,2,3,4].some(n=>segA.steps[n]?.done);
    const bStarted=segB&&[1,2,3,4].some(n=>segB.steps[n]?.done);
    const cStarted=segC&&[1,2,3,4].some(n=>segC.steps[n]?.done);

    _locComboSetValue('tbStart',t.startLoc||'');
    // Enable and set dest1
    _locComboSetValue('tbDest1',t.dest1||'');
    // Add and set dest2/3
    if(t.dest2){addDest();_locComboSetValue('tbDest2',t.dest2);}
    if(t.dest3){addDest();_locComboSetValue('tbDest3',t.dest3);}
    // Vehicle type → filter → set vehicle
    const _editVh=byId(DB.vehicles,t.vehicleId);
    const _vtSel=document.getElementById('tbVehicleType_sel');
    const _actSel=document.getElementById('tbActualVType_sel');
    const storedTypeId=t.vehicleTypeId||(_editVh?_editVh.typeId:'');
    const storedActualTypeId=t.actualVehicleTypeId||(_editVh?_editVh.typeId:storedTypeId);
    if(_vtSel&&storedTypeId) _vtSel.value=storedTypeId;
    if(_actSel&&storedActualTypeId){
      _actSel.value=storedActualTypeId;
      filterActualVehicles();
      if(t.vehicleId){
        document.getElementById('tbVehicle').value=t.vehicleId;
        autoVendor();
      }
    }
    checkVtMismatch();
    // Driver
    const _drv1=byId(DB.drivers,t.driverId);
    document.getElementById('tbDriver').value=_drv1?.name||'';
    showDriverVendor();
    // Challans (multi per destination)
    [1,2,3].forEach(n=>{
      clearChallanList(n);
      // Remove the default empty row before loading saved data
      const savedChallans=t['challans'+n];
      if(savedChallans&&savedChallans.length){
        const list=document.getElementById('tbChallanList'+n);
        if(list)list.innerHTML='';
        savedChallans.forEach(ch=>addChallanRow(n,ch));
      } else {
        // Legacy single challan
        const no=t['challan'+n]||''; const wt=t['weight'+n]||'';
        if(no||wt){
          const list=document.getElementById('tbChallanList'+n);
          if(list)list.innerHTML='';
          addChallanRow(n,{no,weight:wt});
        }
      }
    });
    // Restore photos
    [1,2,3].forEach(n=>{
      const photoData=t['photo'+n];
      if(photoData){
        const thumb=document.getElementById('tbP'+n+'Thumb');
        if(thumb){thumb.innerHTML='';thumb.style.border='2px solid var(--green)';const img=document.createElement('img');img.src=photoData;img.style.cssText='width:100%;height:100%;object-fit:cover;cursor:pointer;display:block';img.onclick=()=>openPhoto(photoData);thumb.appendChild(img);}
        const clearBtn=document.getElementById('tbP'+n+'Clear');if(clearBtn)clearBtn.style.display='block';
        const input=document.getElementById('tbP'+n);if(input)input._compressedData=photoData;
      }
    });

    // Lock fields based on segment progress
    const lockEl=id=>{const el=document.getElementById(id);if(el){el.disabled=true;el.style.opacity='.5';}var tx=document.getElementById(id+'Txt');if(tx){tx.disabled=true;tx.style.opacity='.5';};};
    // Vehicle: locked after first step of seg A
    if(aStarted){
      lockEl('tbVehicleType_sel');lockEl('tbActualVType_sel');lockEl('tbVehicle');lockEl('tbDriver');
    }
    // Start location: locked if seg A started
    if(aStarted) lockEl('tbStart');
    // Dest1 + challans1: locked if seg A first step done
    if(aStarted){lockEl('tbDest1');lockChallanList(1);}
    // Dest2 + challans2: locked if seg B first step done
    if(bStarted){lockEl('tbDest2');lockChallanList(2);}
    // Dest3 + challans3: locked if seg C first step done
    if(cStarted){lockEl('tbDest3');lockChallanList(3);}
    // Hide '+ Add Destination' once any segment of this trip has started
    if(aStarted||bStarted||cStarted){
      document.getElementById('tbAddDestBtn').style.display='none';
    }

    setTimeout(()=>{onLocChange();const _vs2=document.getElementById('tbVehicleSection');if(_vs2)_vs2.classList.remove('challan-section-disabled');},0);
  }

  _kapPopupOpen=false; // ensure bg sync is not blocked while trip booking form is open
  om('mTripBooking');
  setTimeout(()=>{if(typeof updateTbPrompt==='function')updateTbPrompt();},100);
}

function addDest(){
  if(_tbDestCount>=3)return;
  _tbDestCount++;
  if(_tbDestCount>=2)document.getElementById('tbDest2Wrap').style.display='block';
  if(_tbDestCount>=3){document.getElementById('tbDest3Wrap').style.display='block';document.getElementById('tbAddDestBtn').style.display='none';}
  onLocChange();
}

function removeDest(n){
  if(n===3){
    document.getElementById('tbDest3Wrap').style.display='none';
    _locComboSetValue('tbDest3','');clearChallanList(3);
    clearTbPhoto(3);_tbDestCount=2;
    document.getElementById('tbAddDestBtn').style.display='block';
  } else if(n===2){
    // Move dest3 to dest2 if exists, then hide dest3
    if(_tbDestCount===3){
      _locComboSetValue('tbDest2',document.getElementById('tbDest3').value);
      // Move challan rows from dest3 to dest2
      const _ch3rows=getChallanRows(3);clearChallanList(2);_ch3rows.forEach(r=>addChallanRow(2,r));
      _locComboSetValue('tbDest3','');clearChallanList(3);
      clearTbPhoto(3);
      document.getElementById('tbDest3Wrap').style.display='none';
      _tbDestCount=2;document.getElementById('tbAddDestBtn').style.display='block';
    } else {
      document.getElementById('tbDest2Wrap').style.display='none';
      _locComboSetValue('tbDest2','');clearChallanList(2);
      clearTbPhoto(2);_tbDestCount=1;
      document.getElementById('tbAddDestBtn').style.display='block';
    }
  }
  onLocChange();
}

function renderTripBooking(){
  initTbHistDates();
  renderMyTrips();
}

// ── Searchable location combo ────────────────────────────────────────────
function _locComboFilter(baseId){
  var txtEl=document.getElementById(baseId+'Txt');
  var listEl=document.getElementById(baseId+'List');
  if(!txtEl||!listEl) return;
  var q=(txtEl.value||'').toLowerCase();
  var locs=sortLocsKapFirst(DB.locations||[]);
  var html='';
  locs.forEach(function(l){
    var name=l.name||'';
    var type=l.type||'';
    var text=locOptText(l);
    if(q&&name.toLowerCase().indexOf(q)<0&&type.toLowerCase().indexOf(q)<0) return;
    var typeCls=type==='KAP'?'kap':'ext';
    html+='<div class="loc-combo-item" onmousedown="_locComboSelect(\''+baseId+'\',\''+l.id+'\')"><span class="loc-type '+typeCls+'">'+type+'</span><span>'+name+'</span></div>';
  });
  if(!html) html='<div style="padding:8px 12px;font-size:12px;color:var(--text3)">No matching locations</div>';
  listEl.innerHTML=html;
  listEl.classList.add('open');
}
function _locComboSelect(baseId,locId){
  var hiddenEl=document.getElementById(baseId);
  var txtEl=document.getElementById(baseId+'Txt');
  var listEl=document.getElementById(baseId+'List');
  if(hiddenEl) hiddenEl.value=locId;
  var loc=byId(DB.locations||[],locId);
  if(txtEl) txtEl.value=loc?(loc.name||''):'';
  if(listEl) listEl.classList.remove('open');
  onLocChange();
}
function _locComboClose(baseId){
  var listEl=document.getElementById(baseId+'List');
  if(listEl) listEl.classList.remove('open');
  // If text doesn't match any location, clear the hidden value
  var hiddenEl=document.getElementById(baseId);
  var txtEl=document.getElementById(baseId+'Txt');
  if(hiddenEl&&txtEl){
    var curId=hiddenEl.value;
    var curLoc=curId?byId(DB.locations||[],curId):null;
    if(curLoc&&txtEl.value.trim()===curLoc.name){return;}// matches — keep
    // Check if typed text matches a location name exactly
    var typed=txtEl.value.trim().toLowerCase();
    if(typed){
      var match=(DB.locations||[]).find(function(l){return(l.name||'').toLowerCase()===typed;});
      if(match){hiddenEl.value=match.id;txtEl.value=match.name;onLocChange();return;}
    }
    // No match — clear
    hiddenEl.value='';
    if(!typed) txtEl.value='';
    onLocChange();
  }
}
function _locComboSetValue(baseId,locId){
  var hiddenEl=document.getElementById(baseId);
  var txtEl=document.getElementById(baseId+'Txt');
  if(hiddenEl) hiddenEl.value=locId||'';
  var loc=locId?byId(DB.locations||[],locId):null;
  if(txtEl) txtEl.value=loc?(loc.name||''):'';
}

function onLocChange(){
  const s=document.getElementById('tbStart').value;
  const d1=document.getElementById('tbDest1').value;
  const d2=document.getElementById('tbDest2').value;
  const d3=document.getElementById('tbDest3').value;

  // Enable/disable dest text inputs based on chain
  var d1Txt=document.getElementById('tbDest1Txt');
  var d2Txt=document.getElementById('tbDest2Txt');
  var d3Txt=document.getElementById('tbDest3Txt');
  if(d1Txt){d1Txt.disabled=false;} // Dest1 always enabled
  if(d2Txt){
    if(d1){d2Txt.disabled=false;}
    else{d2Txt.disabled=true;d2Txt.value='';document.getElementById('tbDest2').value='';}
  }
  if(d3Txt){
    if(d2){d3Txt.disabled=false;}
    else{d3Txt.disabled=true;d3Txt.value='';document.getElementById('tbDest3').value='';}
  }
  // Trip description uses RECOMMENDED vehicle type (not actual)
  const recVtId=document.getElementById('tbVehicleType_sel')?.value;
  const vtName=recVtId?vtname(recVtId):'';
  const locParts=[s,d1,d2,d3].filter(Boolean).map(lnameText);
  const descParts=vtName?[vtName,...locParts]:locParts;
  const descText=descParts.join(' - ');
  document.getElementById('tbDesc').value=descText;

  // Trip type badge + description row at top
  const descRow=document.getElementById('tbDescRow');
  const typeBadge=document.getElementById('tbTripTypeBadge');
  const descDisplay=document.getElementById('tbDescDisplay');
  if(s&&d1){
    let tripType='🔀 One Way Trip';
    let badgeStyle='background:rgba(59,130,246,.15);color:#35b0b6';
    if(d2||d3){
      const finalDest=d3||d2;
      if(finalDest===s){
        tripType='🔄 Return Trip';
        badgeStyle='background:rgba(34,197,94,.15);color:#16a34a';
      } else {
        tripType='📍 Multi Location Trip';
        badgeStyle='background:rgba(42,154,160,.15);color:var(--accent)';
      }
    }
    if(typeBadge){typeBadge.textContent=tripType;typeBadge.style.cssText=`font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px;${badgeStyle}`;}
    if(descDisplay){
      // Rich display uses RECOMMENDED vehicle type
      const _vtBadge2=vtName?`<span style="background:var(--surface2);border:1px solid var(--border2);color:var(--text);font-size:11px;font-weight:700;padding:1px 7px;border-radius:4px">${vtName}</span> `:'';
      const _arrow2='<span style="color:var(--accent);font-weight:900;font-size:12px;margin:0 3px">⟶</span>';
      const _routeHtml2=[s,d1,d2,d3].filter(Boolean).map(id=>lname(id)).join(_arrow2);
      descDisplay.innerHTML=_vtBadge2+_routeHtml2;
    }
    if(descRow)descRow.style.display='flex';
  } else {
    if(descRow)descRow.style.display='none';
  }

  // Segment preview
  let prev='';
  if(s&&d1){
    const pairs=[[s,d1,'A']];
    if(d2)pairs.push([d1,d2,'B']);
    if(d3)pairs.push([d2,d3,'C']);
    const lastIdx=pairs.length-1;
    prev='<div style="margin-bottom:3px;font-size:10px;font-weight:600;color:var(--text3);letter-spacing:.5px;text-transform:uppercase">Segment Preview</div>';
    const cf={1:'Gate Exit @ [Start] → Gate Entry @ [Dest] → Material Receipt @ [Dest] → Approve @ [Dest]',2:'Gate Exit @ [Start] → <s>Gate Entry</s> → <s>Material Receipt (skipped — Ext dest)</s> → Approve @ [Start]',3:'<s>Gate Exit</s> → Gate Entry @ [Dest] → Material Receipt @ [Dest] → Approve @ [Dest]',4:'<s>Gate Exit</s> → <s>Gate Entry</s> → <s>Material Receipt (skipped — Ext dest)</s> → Approve by Admin'};
    const cl={1:'KAP→KAP',2:'KAP→Ext',3:'Ext→KAP',4:'Ext→Ext'};
    pairs.forEach(([from,to,lbl],idx)=>{
      const c=getCriteria(ltype(from),ltype(to));
      const isLast=idx===lastIdx;
      const flow=cf[c].replace('[Start]',lnameText(from)).replace('[Start]',lnameText(from)).replace('[Dest]',lnameText(to)).replace('[Dest]',lnameText(to));
      const note=!isLast?'<div style="font-size:11px;color:var(--teal);margin-top:5px">🔄 Steps 3 & 4 run in background — next segment unlocks after Steps 1 & 2 complete</div>':'';
      prev+=`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:5px 10px;margin-bottom:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-family:var(--mono);font-size:11px;color:var(--accent);font-weight:800">Seg ${lbl}</span><span class="c-badge" style="font-size:10px">C${c}</span><span style="font-size:11px;color:var(--text2)">${lname(from)} <span style="color:var(--accent)">⟶</span> ${lname(to)}</span><span style="font-size:10px;color:var(--text3);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${flow}</span>${note}</div>`;
    });
  }
  document.getElementById('segPreview').innerHTML=prev;
  // Enable challan section only when destination is selected
  const _cs1=document.getElementById('tbChallanSection1');
  const _cs2=document.getElementById('tbChallanSection2');
  const _cs3=document.getElementById('tbChallanSection3');
  const _cs1WasDisabled=_cs1?.classList.contains('challan-section-disabled');
  if(_cs1) _cs1.classList.toggle('challan-section-disabled', !d1);
  if(_cs2) _cs2.classList.toggle('challan-section-disabled', !d2);
  if(_cs3) _cs3.classList.toggle('challan-section-disabled', !d3);
  // Auto-add first challan row when dest1 is freshly enabled (new trip only)
  const _inEditMode=document.getElementById('tbTripId')?.value;
  if(d1&&_cs1WasDisabled&&!_inEditMode){
    const _list1=document.getElementById('tbChallanList1');
    if(_list1&&!_list1.querySelectorAll('.challan-row').length) addChallanRow(1);
  }
  if(d2&&_cs2?.classList.contains('challan-section-disabled')===false){
    const _list2=document.getElementById('tbChallanList2');
    if(_list2&&!_list2.querySelectorAll('.challan-row').length&&!_inEditMode) addChallanRow(2);
  }
  if(d3&&_cs3?.classList.contains('challan-section-disabled')===false){
    const _list3=document.getElementById('tbChallanList3');
    if(_list3&&!_list3.querySelectorAll('.challan-row').length&&!_inEditMode) addChallanRow(3);
  }
  const _vs=document.getElementById('tbVehicleSection');
  // Vehicle section is always enabled — driver should always be accessible.
  // Only the vehicle number select gets disabled/enabled based on dest selection.
  if(_vs) _vs.classList.remove('challan-section-disabled');
  updateTbHighlight();
  tbDestCascade();
}

function updateTbHighlight(){
  const _tbS=document.getElementById('tbStart');
  const _tbVT=document.getElementById('tbVehicleType_sel');
  const _tbV=document.getElementById('tbVehicle');
  const _tbD=document.getElementById('tbDriver');
  const _tbD1=document.getElementById('tbDest1');
  const _tbD2=document.getElementById('tbDest2');
  const _tbD3=document.getElementById('tbDest3');
  const s=_tbS?.value;
  const vt=_tbVT?.value;
  const v=_tbV?.value;
  const d=_tbD?.value?.trim();
  const d1=_tbD1?.value;
  const d2=_tbD2?.value;
  const d3=_tbD3?.value;
  const startFull=s&&vt&&v&&d;
  setTbSection('tbSectionStart', !startFull, !!startFull);
  setTbSection('tbSectionA', startFull&&!d1, startFull&&!!d1);
  setTbSection('tbSectionB', startFull&&d1&&!d2, startFull&&d1&&!!d2);
  setTbSection('tbSectionC', startFull&&d2&&!d3, startFull&&d2&&!!d3);
  updateTbPrompt();
}
function updateTbPrompt(){
  const g=id=>document.getElementById(id);
  const val=id=>(g(id)?.value||'').trim();
  const secEnabled=id=>{const el=g(id);return el&&!el.classList.contains('challan-section-disabled');};

  // Remove all prompts first
  document.querySelectorAll('.tb-prompt').forEach(el=>el.classList.remove('tb-prompt'));

  // ── STEP 1: Start Location ──────────────────────────────────────
  if(!val('tbStart')){g('tbStartTxt')?.classList.add('tb-prompt');return;}

  // ── STEP 2: Destination 1 (prompt whenever start is picked but dest1 empty) ──
  if(!val('tbDest1')){g('tbDest1Txt')?.classList.add('tb-prompt');return;}

  // ── Helper: prompt challan rows for a destination segment ───────
  // Returns true (and adds prompt) if anything in this segment still needs filling
  function promptChallanSeg(segN){
    if(!secEnabled('tbChallanSection'+segN)) return false;
    const destVal=val('tbDest'+segN);
    if(!destVal) return false;
    const list=g('tbChallanList'+segN);
    const rows=list?[...list.querySelectorAll('.challan-row')]:[];
    // Sequence: Challan No → Weight → Photo → [+Add Challan if more slots available]
    for(const row of rows){
      const inputs=row.querySelectorAll('input[type="text"],input[type="number"]');
      const chNo=inputs[0]; const chWt=inputs[1];
      const thumb=row.querySelector('.challan-photo-thumb');
      if(chNo&&!chNo.value.trim()){chNo.classList.add('tb-prompt');return true;}
      if(chWt&&!chWt.value.trim()){chWt.classList.add('tb-prompt');return true;}
      if(thumb&&!thumb.classList.contains('has-photo')){thumb.classList.add('tb-prompt');return true;}
    }
    // All existing rows complete — offer "+Add Challan" if slots remain and button is visible
    const addBtn=g('tbAddChallan'+segN);
    if(addBtn&&addBtn.style.display!=='none'&&rows.length>0&&rows.length<3){
      addBtn.classList.add('tb-prompt');return true;
    }
    return false;
  }

  // ── STEP 3-5: Challan rows for each active segment ──────────────
  if(promptChallanSeg(1)) return;
  if(val('tbDest2')&&promptChallanSeg(2)) return;
  if(val('tbDest3')&&promptChallanSeg(3)) return;

  // ── STEP 6: Vehicle section ─────────────────────────────────────
  if(secEnabled('tbVehicleSection')){
    if(!val('tbVehicleType_sel')){g('tbVehicleType_sel')?.classList.add('tb-prompt');return;}
    if(!val('tbActualVType_sel')){g('tbActualVType_sel')?.classList.add('tb-prompt');return;}
    if(!val('tbVehicle')||g('tbVehicle')?.disabled){g('tbVehicle')?.classList.add('tb-prompt');return;}
    if(!val('tbDriver')){g('tbDriver')?.classList.add('tb-prompt');return;}
  }
}
function setTbSection(id, active, filled){
  const el=document.getElementById(id);
  if(!el)return;
  el.classList.toggle('tb-active', !!active);
  el.classList.toggle('tb-filled', !!filled);
}

function getDriverByInput(){
  const val=(document.getElementById('tbDriver')?.value||'').trim();
  if(!val)return null;
  return DB.drivers.find(d=>d&&d.name.toLowerCase()===val.toLowerCase())||null;
}

// Trip booking destination cascade — colors + enable/disable
function tbDestCascade(){
  const s=document.getElementById('tbStart')?.value;
  const d1=document.getElementById('tbDest1')?.value;
  const d2=document.getElementById('tbDest2')?.value;
  const d3=document.getElementById('tbDest3')?.value;

  const setCircle=(id,active,dimmed)=>{
    const el=document.getElementById(id);if(!el)return;
    if(active){el.style.background='var(--green)';el.style.color='#fff';el.style.borderColor='var(--green)';el.style.opacity='1';}
    else{el.style.background='var(--surface2)';el.style.color='var(--text3)';el.style.borderColor='var(--border2)';el.style.opacity=dimmed?'.4':'1';}
  };
  const setArrow=(id,active)=>{
    const el=document.getElementById(id);if(!el)return;
    el.style.background=active?'var(--green)':'var(--border2)';
  };
  const setDest=(baseId,enabled,resetText)=>{
    const el=document.getElementById(baseId);if(!el)return;
    const txtEl=document.getElementById(baseId+'Txt');
    if(enabled){
      if(el)el.disabled=false;
      if(txtEl){txtEl.disabled=false;txtEl.style.opacity='1';}
    } else {
      if(el)el.disabled=true;
      if(txtEl){txtEl.disabled=true;txtEl.style.opacity='.5';if(resetText) txtEl.placeholder=resetText;}
    }
  };

  // Start S circle: amber = always
  // Arrow S→1: green if start selected
  setArrow('tbArrow01', !!s);

  // Circle 1: green if D1 selected, active (full opacity) if start selected
  setCircle('tbCircle1', !!d1, !s);
  setDest('tbDest1', !!s, '— select Start first —');

  // Arrow 1→2: green if D1 selected
  setArrow('tbArrow12', !!d1);

  // Circle 2: green if D2 selected, enabled only if D1 selected
  setCircle('tbCircle2', !!d2, !d1);
  setDest('tbDest2', !!d1, '— select Dest 1 first —');

  // Arrow 2→3: green if D2 selected
  setArrow('tbArrow23', !!d2);

  // Circle 3: green if D3 selected, enabled only if D2 selected
  setCircle('tbCircle3', !!d3, !d2);
  setDest('tbDest3', !!d2, '— select Dest 2 first —');
}

function showDriverVendor(){
  const drv=getDriverByInput();
  const vnd=byId(DB.vendors,drv?.vendorId);
  const el=document.getElementById('tbDriverVendor');
  if(el) el.textContent=drv?(vnd?.name?'🏢 '+vnd.name:drv?.mobile?'📱 '+drv.mobile:''):'';
  updateTbHighlight();
  setTimeout(()=>{if(typeof updateTbPrompt==='function')updateTbPrompt();},10);
}

// ══ Multi-Challan helpers ════════════════════════════════════════════════════
function addChallanRow(destNum, data){
  const list=document.getElementById('tbChallanList'+destNum);
  const addBtn=document.getElementById('tbAddChallan'+destNum);
  if(!list)return;
  const rows=list.querySelectorAll('.challan-row');
  if(rows.length>=3)return;
  const rowIdx=rows.length; // 0-based for unique id
  const no=(data&&data.no)||'';
  const wt=(data&&data.weight)||'';
  const photo=(data&&data.photo)||'';
  const uid2=Date.now()+rowIdx;
  const row=document.createElement('div');
  row.className='challan-row';
  row.innerHTML=`
    <input type="text" placeholder="Challan No." value="${no.replace(/"/g,'&quot;')}" oninput="updateTbPrompt&&updateTbPrompt()" style="flex:2">
    <input type="number" placeholder="Wt kg" value="${wt}" oninput="updateTbPrompt&&updateTbPrompt()" style="flex:1">
    <div class="challan-photo-thumb${photo?' has-photo':''}" id="chThumb_${destNum}_${uid2}" onclick="_showPhotoChoice('chPhoto_${destNum}_${uid2}','chThumb_${destNum}_${uid2}')" title="Add challan photo">${photo?'<img src="'+photo+'" style="width:100%;height:100%;object-fit:cover">':'📎'}</div>
    <input type="file" id="chPhoto_${destNum}_${uid2}" accept="image/*,.pdf,.doc,.docx" style="display:none" onchange="onChallanPhoto(this,'chThumb_${destNum}_${uid2}')">
    <button class="ch-del" onclick="removeChallanRow(this,${destNum})" title="Remove">×</button>
  `;
  list.appendChild(row);
  if(list.querySelectorAll('.challan-row').length>=3&&addBtn) addBtn.style.display='none';
  setTimeout(()=>{if(typeof updateTbPrompt==='function')updateTbPrompt();},30);
}

function onChallanPhoto(input, thumbId){
  const file=input.files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=e=>{
    const dataUrl=e.target.result;
    const thumb=document.getElementById(thumbId);
    if(!thumb)return;
    thumb.innerHTML=`<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover">`;
    thumb.classList.add('has-photo');
    input._photoData=dataUrl; // set immediately for preview
    if(typeof updateTbPrompt==='function')updateTbPrompt();
    // Compress in background, update stored data when done
    compressImage(file).then(c=>{input._photoData=c;}).catch(()=>{});
  };
  reader.readAsDataURL(file);
}

function removeChallanRow(btn, destNum){
  const row=btn.closest('.challan-row');
  if(!row)return;
  row.remove();
  const list=document.getElementById('tbChallanList'+destNum);
  const addBtn=document.getElementById('tbAddChallan'+destNum);
  if(addBtn)addBtn.style.display='';
  // Renumber
  list.querySelectorAll('.challan-row').forEach((r,i)=>{
    const lbl=r.querySelector('span');if(lbl)lbl.textContent=(i+1)+'.';
  });
}

function getChallanRows(destNum){
  const list=document.getElementById('tbChallanList'+destNum);
  if(!list)return[];
  return [...list.querySelectorAll('.challan-row')].map(r=>{
    const inputs=r.querySelectorAll('input[type=text],input[type=number]');
    const photoInput=r.querySelector('input[type=file]');
    return{
      no:(inputs[0]?.value||'').trim(),
      weight:(inputs[1]?.value||'').trim(),
      photo:photoInput?._photoData||''
    };
  }).filter(r=>r.no||r.weight||r.photo);
}

function clearChallanList(destNum){
  const list=document.getElementById('tbChallanList'+destNum);
  if(list)list.innerHTML='';
  const addBtn=document.getElementById('tbAddChallan'+destNum);
  if(addBtn)addBtn.style.display='';
  // Add a default empty row
  addChallanRow(destNum);
}

function lockChallanList(destNum){
  const list=document.getElementById('tbChallanList'+destNum);
  if(!list)return;
  list.querySelectorAll('input,button,.challan-photo-thumb').forEach(el=>{
    el.disabled=true;el.style.opacity='.5';el.style.pointerEvents='none';
  });
  const addBtn=document.getElementById('tbAddChallan'+destNum);
  if(addBtn){addBtn.disabled=true;addBtn.style.opacity='.5';}
}
// ════════════════════════════════════════════════════════════════════════════

// ── Custom Driver Autocomplete ────────────────────────────────────────────────
function driverAcInput(inp){
  const q=(inp.value||'').trim().toLowerCase();
  const list=document.getElementById('tbDriverAcList');
  if(!list)return;
  // Positioning is handled by CSS (position:absolute; bottom:100%; left:0)
  // No JS coordinates needed — just populate and show
  const drivers=sortBy(DB.drivers.filter(d=>!d.inactive),d=>d.name);
  const filtered=q?drivers.filter(d=>d.name.toLowerCase().includes(q)):drivers;
  if(!filtered.length){
    if(q){
      list.innerHTML='<div style="padding:8px 12px;font-size:12px;color:var(--accent);font-weight:600">➕ New driver: "'+q.replace(/[<>&"]/g,'')+'"</div>';
      list._driverNames=[];
      list.classList.add('open');
    } else {
      list.classList.remove('open');
    }
    return;
  }
  list._driverNames=filtered.map(d=>d.name);
  list.innerHTML=filtered.map((d,i)=>{
    const safe=d.name.replace(/&/g,'&amp;').replace(/</g,'&lt;');
    return '<div class="driver-ac-item" data-idx="'+i+'" onmousedown="driverAcSelect(event)">'+safe+'</div>';
  }).join('');
  list.classList.add('open');
}
function driverAcSelect(e){
  const el=e.target.closest('[data-idx]');
  if(!el)return;
  const list=document.getElementById('tbDriverAcList');
  const name=list._driverNames&&list._driverNames[+el.dataset.idx];
  if(!name)return;
  const inp=document.getElementById('tbDriver');
  if(inp)inp.value=name;
  driverAcClose();
  showDriverVendor();
}
function driverAcClose(){
  const list=document.getElementById('tbDriverAcList');
  if(list)list.classList.remove('open');
}
// ─────────────────────────────────────────────────────────────────────────────

function filterTbVehicles(){
  // Mirror recommended type to actual type automatically
  const recId=document.getElementById('tbVehicleType_sel')?.value;
  const actSel=document.getElementById('tbActualVType_sel');
  if(actSel&&recId){ actSel.value=recId; }
  // Always reset vehicle number when type changes
  const vehSel=document.getElementById('tbVehicle');
  if(vehSel){ vehSel.value=''; }
  const vvEl=document.getElementById('tbVehicleVendor');
  if(vvEl) vvEl.textContent='';
  filterActualVehicles();
  checkVtMismatch();
  onLocChange(); // rebuilds desc + segment preview using new recommended type
}

function filterActualVehicles(){
  const typeId=document.getElementById('tbActualVType_sel')?.value;
  const vehSel=document.getElementById('tbVehicle');
  if(!vehSel)return;
  vehSel.value='';
  const vvEl=document.getElementById('tbVehicleVendor');
  if(vvEl)vvEl.textContent='';
  if(!typeId){
    vehSel.disabled=true;
    vehSel.innerHTML='<option value="">— Select actual type first —</option>';
    return;
  }
  const filtered=sortBy(DB.vehicles.filter(v=>!v.inactive&&v.typeId===typeId),v=>v.number);
  if(!filtered.length){
    vehSel.disabled=true;
    vehSel.innerHTML='<option value="">No vehicles of this type</option>';
    return;
  }
  vehSel.disabled=false;
  vehSel.innerHTML='<option value="">— Vehicle Number —</option>'+filtered.map(v=>`<option value="${v.id}">${v.number}</option>`).join('');
}

function checkVtMismatch(){
  const recId=document.getElementById('tbVehicleType_sel')?.value;
  const actId=document.getElementById('tbActualVType_sel')?.value;
  const warn=document.getElementById('tbVtMismatchWarn');
  if(!warn)return;
  warn.classList.toggle('show', !!(recId&&actId&&recId!==actId));
}

function autoVendor(){
  const v=byId(DB.vehicles,document.getElementById('tbVehicle').value);
  const vn=byId(DB.vendors,v?.vendorId);
  document.getElementById('tbVendor').value=vn?.name||'';
  const vtEl=document.getElementById('tbVehicleType');
  if(vtEl) vtEl.textContent=v?vtname(v.typeId):'';
  const vvEl=document.getElementById('tbVehicleVendor');
  if(vvEl) vvEl.textContent=vn?.name?'🏢 '+vn.name:'';
  onLocChange();
}

let _editingTripId=null; // null = new trip, string = editing existing

function editTrip(tripId){
  openTripBookingModal(tripId);
}

let _bookingInProgress=false;
async function bookTrip(){
  if(_bookingInProgress)return;
  _bookingInProgress=true;
  const bookBtn=document.querySelector('[onclick="bookTrip()"]');
  if(bookBtn){bookBtn.disabled=true;bookBtn.style.opacity='.6';}
  try{await _doBookTrip();}finally{
    _bookingInProgress=false;
    if(bookBtn){bookBtn.disabled=false;bookBtn.style.opacity='1';}
  }
}
async function _doBookTrip(){
  const s=document.getElementById('tbStart').value;
  const d1=document.getElementById('tbDest1').value;
  const d2=document.getElementById('tbDest2').value;
  const d3=document.getElementById('tbDest3').value;
  const drvInput=(document.getElementById('tbDriver')?.value||'').trim();
  let drvId='';
  if(drvInput){
    let drv=DB.drivers.find(d=>d&&d.name.toLowerCase()===drvInput.toLowerCase());
    if(!drv){
      // Auto-create driver with typed name — save to Supabase first
      drv={id:'d'+uid(),name:drvInput,mobile:'',dlExpiry:'',vendorId:''};
      if(!await _dbSave('drivers',drv)) return; // stop if Supabase save fails
    }
    drvId=drv.id;
  }
  const vehId=document.getElementById('tbVehicle').value;
  if(!s||!d1){notify('Start Location and Destination 1 are required',true);return;}
  const vtypeId=document.getElementById('tbVehicleType_sel')?.value;
  if(!vtypeId){notify('Recommended Vehicle Type is required',true);return;}
  if(s===d1){notify('Start Location and Destination 1 cannot be the same',true);return;}
  if(d2&&d1===d2){notify('Destination 1 and Destination 2 cannot be the same',true);return;}
  if(d3&&d2===d3){notify('Destination 2 and Destination 3 cannot be the same',true);return;}
  const v=byId(DB.vehicles,vehId);const vn=byId(DB.vendors,v?.vendorId);

  if(_editingTripId){
    const t=byId(DB.trips,_editingTripId);
    if(!t){notify('Trip not found',true);return;}

    const existingSegs=DB.segments.filter(seg=>seg.tripId===_editingTripId).sort((a,b)=>a.label.localeCompare(b.label));
    const startedLabels=new Set(existingSegs.filter(seg=>[1,2,3,4].some(n=>seg.steps[n]?.done)).map(seg=>seg.label));

    // Read field values (locked fields retain original values)
    const fv=id=>{ const el=document.getElementById(id); return el&&!el.disabled?(el.value||''):(el?.value||''); };
    const getPhotoData=n=>document.getElementById('tbP'+n)?._compressedData||t['photo'+n]||'';

    // Update trip fields IN-PLACE (same ID, no revision)
    const _ech1=getChallanRows(1),_ech2=getChallanRows(2),_ech3=getChallanRows(3);
    Object.assign(t,{
      startLoc:fv('tbStart'),dest1:fv('tbDest1'),dest2:fv('tbDest2')||'',dest3:fv('tbDest3')||'',
      challans1:_ech1,challan1:_ech1[0]?.no||'',weight1:_ech1[0]?.weight||'',photo1:getPhotoData(1),
      challans2:_ech2,challan2:_ech2[0]?.no||'',weight2:_ech2[0]?.weight||'',photo2:getPhotoData(2),
      challans3:_ech3,challan3:_ech3[0]?.no||'',weight3:_ech3[0]?.weight||'',photo3:getPhotoData(3),
      driverId:drvId,vehicleId:vehId,vehicleTypeId:document.getElementById('tbVehicleType_sel')?.value||t.vehicleTypeId||'',actualVehicleTypeId:document.getElementById('tbActualVType_sel')?.value||t.actualVehicleTypeId||'',vendor:vehId?(vn?.name||t.vendor||''):'',
      desc:fv('tbDesc')});

    // Remove only unstarted segments — call _dbDel for each removed
    const _segsToRemove = DB.segments.filter(seg=>seg.tripId===_editingTripId && !startedLabels.has(seg.label));
    for(const _sr of _segsToRemove){ await _dbDel('segments', _sr.id); }
    DB.segments=DB.segments.filter(seg=>seg.tripId!==_editingTripId || startedLabels.has(seg.label));

    // Build new segments for unstarted destinations
    const allPairs=[[t.startLoc,t.dest1,'A']];
    if(t.dest2) allPairs.push([t.dest1,t.dest2,'B']);
    if(t.dest3) allPairs.push([t.dest2,t.dest3,'C']);

    const _builtSegs=[];
    allPairs.forEach(([from,to,lbl])=>{
      if(startedLabels.has(lbl)) return; // already preserved
      const seg=buildSegment(_editingTripId,lbl,from,to);
      const prevLabel={B:'A',C:'B'}[lbl];
      if(prevLabel){
        const prevSeg=DB.segments.find(s=>s.tripId===_editingTripId&&s.label===prevLabel);
        if(prevSeg&&!stepsOneAndTwoDone(prevSeg)) seg.status='Locked';
      }
      _builtSegs.push(seg); // collect — DO NOT push to DB.segments yet (_dbSave does it)
    });
    _builtSegs.forEach(seg=>DB.segments.push(seg)); // stage in memory for recalcSegSteps below

    // Remove orphaned segments for removed destinations
    const validLabels=new Set(allPairs.map(([,,lbl])=>lbl));
    DB.segments=DB.segments.filter(seg=>{
      if(seg.tripId!==_editingTripId) return true;
      return validLabels.has(seg.label);
    });

    // Recalculate step assignments for ALL segments (including preserved started ones)
    // Pass siblings so recalcSegSteps can determine isLastSeg correctly from full trip
    const _editSegs=DB.segments.filter(s=>s.tripId===_editingTripId);
    _editSegs.forEach(s=>recalcSegSteps(s,_editSegs));

    // Recalculate trip's tripCatId from segment A (may have changed if startLoc/dest1 changed)
    const segA=DB.segments.find(s=>s.tripId===_editingTripId&&s.label==='A');
    if(segA) t.tripCatId=segA.tripCatId;

    const oldId=_editingTripId;
    _editingTripId=null;

    // Only rename trip ID if the plant prefix actually changed (start location moved to different plant)
    // If prefix is the same → keep original trip ID, no renumbering ever
    const oldPrefix=_tripIdPrefix(oldId);
    const wouldBeId=genTripId(t.startLoc,t.dest1,oldId);
    const newPrefix=_tripIdPrefix(wouldBeId);
    const needsRename=oldPrefix&&newPrefix&&oldPrefix!==newPrefix;

    if(needsRename){
      const newId=wouldBeId;
      // Collect segments BEFORE deleting (since _dbDel removes from DB.segments)
      const _segsToRename=DB.segments.filter(s=>s.tripId===oldId).map(s=>({...s}));
      // Delete old trip + old segments from Supabase
      await _dbDel('trips',oldId);
      for(const s of _segsToRename){ await _dbDel('segments',s.id); }
      // Remove any leftover refs with old tripId from memory
      DB.segments=DB.segments.filter(s=>s.tripId!==oldId);
      // Rename and re-stage in memory
      t.id=newId;
      _segsToRename.forEach(function(s){
        s.tripId=newId;
        s.id=newId+s.label;
        DB.segments.push(s);
      });
    }
    await _dbSave('trips',t);
    for(const s of DB.segments.filter(s=>s.tripId===t.id)){if(!await _dbSave('segments',s)) return;}
    notify(`Trip ${t.id} updated`);
    updBadges();renderDash();renderDashTrips();renderTripBooking();renderKap();renderMR();renderApprove();_kapPopupOpen=false;cm('mTripBooking');renderMyTrips();
    return;
  }

  // NEW trip — generate ID at save time to avoid collisions with concurrent users
  const id=genTripId(s,d1);
  const getPhotoData=n=>document.getElementById('tbP'+n)?._compressedData||'';
  const _nc1=getChallanRows(1),_nc2=getChallanRows(2),_nc3=getChallanRows(3);
  const trip={id,bookedBy:CU.id,plant:CU.plant||'P2',date:new Date().toISOString(),
    startLoc:s,dest1:d1,dest2:d2,dest3:d3,
    challans1:_nc1,challan1:_nc1[0]?.no||'',weight1:_nc1[0]?.weight||'',photo1:getPhotoData(1),
    challans2:_nc2,challan2:_nc2[0]?.no||'',weight2:_nc2[0]?.weight||'',photo2:getPhotoData(2),
    challans3:_nc3,challan3:_nc3[0]?.no||'',weight3:_nc3[0]?.weight||'',photo3:getPhotoData(3),
    driverId:drvId,vehicleId:vehId,
    vehicleTypeId:document.getElementById('tbVehicleType_sel')?.value||'',
    actualVehicleTypeId:document.getElementById('tbActualVType_sel')?.value||'',
    vendor:vn?.name||document.getElementById('tbVendor').value,
    desc:document.getElementById('tbDesc').value};
  // Stage trip in-memory so buildSegment can resolve dest2/dest3
  DB.trips.push(trip);
  const pairs=[[s,d1,'A']];
  if(d2)pairs.push([d1,d2,'B']);
  if(d3)pairs.push([d2,d3,'C']);
  const _newSegs=pairs.map(([from,to,lbl],_i)=>{const seg=buildSegment(id,lbl,from,to);if(_i>0)seg.status='Locked';return seg;});
  // Set tripCatId from segment A before saving
  const _newSegA=_newSegs.find(s=>s.label==='A');
  if(_newSegA){trip.tripCatId=_newSegA.tripCatId;}
  // Save to Supabase first — rollback staging on any failure
  const _tripOk=await _dbSave('trips',trip);
  if(!_tripOk){DB.trips=DB.trips.filter(t=>t.id!==id);return;}
  // Save segments to Supabase — _dbSave updates DB.segments in memory on success
  for(const seg of _newSegs){
    if(!await _dbSave('segments',seg)){
      // Partial failure — rollback: remove trip + any saved segments
      DB.trips=DB.trips.filter(t=>t.id!==id);
      DB.segments=DB.segments.filter(s=>s.tripId!==id);
      await _dbDel('trips',id);
      for(const s2 of _newSegs){ await _dbDel('segments',s2.id); }
      return;
    }
  }
  // Auto-skip Empty Vehicle Exit on old trip if same vehicle is at same location
  if(vehId&&s){
    var _oldSegs=DB.segments.filter(function(seg){
      if(seg.tripId===id) return false;// skip new trip's own segments
      if(seg.status==='Completed'||seg.status==='Locked') return false;
      var _oldTrip=byId(DB.trips,seg.tripId);
      if(!_oldTrip||_oldTrip.vehicleId!==vehId||_oldTrip.cancelled) return false;
      // Check if step 5 (Empty Vehicle Exit) is pending and at same location as new trip start
      var s5=seg.steps&&seg.steps[5];
      if(!s5||s5.skip||s5.done) return false;
      // Compare destination of old segment with start of new trip
      var segDest=seg.dLoc;
      return segDest===s||s5.ownerLoc===s||s5.loc===s;
    });
    for(var _oi=0;_oi<_oldSegs.length;_oi++){
      var _os=_oldSegs[_oi];
      _os.steps[5].skip=true;
      _os.steps[5].done=false;
      _os.steps[5].remarks='Auto-skipped: new trip '+id+' booked for same vehicle at same location';
      _os.currentStep=nextStep(_os);
      if(allStepsDone(_os)) _os.status='Completed';
      await _dbSave('segments',_os);
      // Check if old trip is now fully complete
      var _oldTripSegs=DB.segments.filter(function(seg2){return seg2.tripId===_os.tripId;});
      var _allDone=_oldTripSegs.every(function(seg2){return seg2.status==='Completed'||seg2.status==='Rejected';});
      if(_allDone){
        var _oldT=byId(DB.trips,_os.tripId);
        if(_oldT){_oldT.completedAt=new Date().toISOString();await _dbSave('trips',_oldT);}
      }
      console.log('Auto-skipped Empty Exit on seg '+_os.id+' (trip '+_os.tripId+') — new trip '+id+' at same location');
    }
  }
  notify(`Trip ${id} booked — ${pairs.length} segment(s) created!`);
  _kapPopupOpen=false;cm('mTripBooking');
  // Force full re-render to reflect auto-skipped empty exits
  setTimeout(function(){updBadges();renderDash();renderDashTrips();renderTripBooking();renderMyTrips();renderKap();renderMR();renderApprove();},100);
}

// Helper: get trips for current user's plant location
// Check if a location belongs to the current user (via plant, kapSec, tripBook, matRecv, approvers, or plantHead)
function _isMyLocation(locId){
  if(!CU||!locId) return false;
  if(CU.plant===locId) return true;
  var loc=byId(DB.locations,locId);
  if(!loc) return false;
  return loc.kapSec===CU.id||loc.plantHead===CU.id||(loc.tripBook||[]).includes(CU.id)||(loc.matRecv||[]).includes(CU.id)||(loc.approvers||[]).includes(CU.id);
}
function tripsForMyPlant(){
  if(!CU) return [];
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');
  if(isSA){
    // If a specific KAP location is chosen in the sidebar filter, narrow to trips from that location
    if(_adminLocFilter) return DB.trips.filter(t=>t.startLoc===_adminLocFilter);
    return [...DB.trips];
  }
  const myLoc=CU.plant; // Location Master ID
  // Find all locations where this user is assigned (as any role)
  const myAssignedLocs=new Set(DB.locations.filter(l=>
    l.kapSec===CU.id ||
    l.plantHead===CU.id ||
    (l.tripBook||[]).includes(CU.id) ||
    (l.matRecv||[]).includes(CU.id) ||
    (l.approvers||[]).includes(CU.id)
  ).map(l=>l.id));
  if(myLoc) myAssignedLocs.add(myLoc);
  return DB.trips.filter(trip=>{
    // Show trip if user's location is the start location
    if(myAssignedLocs.has(trip.startLoc)) return true;
    // Show trip if user's location is any destination
    if(trip.dest1 && myAssignedLocs.has(trip.dest1)) return true;
    if(trip.dest2 && myAssignedLocs.has(trip.dest2)) return true;
    if(trip.dest3 && myAssignedLocs.has(trip.dest3)) return true;
    // Also show if user booked it
    if(trip.bookedBy===CU.id) return true;
    return false;
  });
}
// Narrower filter for Trip Booking page: only plant/tripBook locations + own bookings
function _tripsForMyBookingPlant(){
  if(!CU) return [];
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');
  if(isSA){
    if(_adminLocFilter) return DB.trips.filter(t=>t.startLoc===_adminLocFilter);
    return [...DB.trips];
  }
  const myPlantLocs=new Set();
  if(CU.plant) myPlantLocs.add(CU.plant);
  DB.locations.filter(l=>(l.tripBook||[]).includes(CU.id)||l.plantHead===CU.id).forEach(l=>myPlantLocs.add(l.id));
  return DB.trips.filter(trip=>{
    if(myPlantLocs.has(trip.startLoc)) return true;
    if(trip.dest1 && myPlantLocs.has(trip.dest1)) return true;
    if(trip.dest2 && myPlantLocs.has(trip.dest2)) return true;
    if(trip.dest3 && myPlantLocs.has(trip.dest3)) return true;
    if(trip.bookedBy===CU.id) return true;
    return false;
  });
}

function renderMyTrips(){
  initDfMonth('tbHist','tbHistFrom','tbHistTo');
  // Preserve which cards are currently expanded
  const _expanded=new Set([...document.querySelectorAll('[id^="myTrip_"]')].filter(el=>el.style.display!=='none').map(el=>el.id.replace('myTrip_','')));
  const fromVal=document.getElementById('tbHistFrom')?.value||'';
  const toVal=document.getElementById('tbHistTo')?.value||'';

  const isSA=(CU.roles||[]).includes('Super Admin')||(CU.roles||[]).includes('Admin');
  let trips=_tripsForMyBookingPlant();
  // Trip ID search filter
  const tbSearch=(document.getElementById('tbTripSearch')?.value||'').toLowerCase();
  if(tbSearch) trips=trips.filter(t=>(t.id||'').toLowerCase().includes(tbSearch));
  if(fromVal)trips=trips.filter(t=>(t.date||'').slice(0,10)>=fromVal);
  if(toVal)trips=trips.filter(t=>(t.date||'').slice(0,10)<=toVal);
  // Sort by date descending (newest first)
  trips.sort((a,b)=>(b.date||'').localeCompare(a.date||''));

  const rows=trips.map(t=>{
    const segs=DB.segments.filter(s=>s.tripId===t.id).sort((a,b)=>a.label.localeCompare(b.label));
    const anyActionDone=segs.some(s=>[1,2,3,4].some(n=>s.steps[n]?.done));
    const isCompleted=segs.length>0&&segs.every(s=>s.status==='Completed');
    const isCancelled=!!t.cancelled;
    const canDelete=isSA;
    const canCancel=!isCancelled&&!isCompleted&&!anyActionDone;
    const tid=t.id.replace(/[^a-zA-Z0-9]/g,'_');

    const vn=vnum(t.vehicleId);
    const hasVeh=vn&&vn!=='-';
    const _locs=[t.startLoc,t.dest1,t.dest2,t.dest3].filter(Boolean);
    const _route=_locs.map(id=>lnameText(id)).join(' ⟶ ');

    // Card background based on trip status
    const cardBg=isCancelled
      ?'background:rgba(107,114,128,.08);border:2px solid #000;opacity:0.7'
      :isCompleted
      ?'background:rgba(22,163,74,.06);border:2px solid #000'
      :anyActionDone
        ?'background:var(--surface);border:2px solid #000'
        :'background:rgba(239,68,68,.06);border:2px solid #000';

    // ── Segment detail rows (shown in expanded view) ──
    const segDests=[[t.startLoc,t.dest1,'A',1]];
    if(t.dest2)segDests.push([t.dest1,t.dest2,'B',2]);
    if(t.dest3)segDests.push([t.dest2,t.dest3,'C',3]);

    const segRows=segDests.map(([from,to,lbl,idx])=>{
      const seg=segs.find(s=>s.label===lbl);
      const ch=t['challan'+idx]||'';
      const wt=t['weight'+idx]||'';
      const ph=t['photo'+idx];
      const segStarted=seg&&[1,2,3,4].some(n=>seg.steps[n]?.done);
      const _segDiscrep=seg&&seg.steps[3]?.discrepancy;
      const _segNotRcvd=seg&&seg.steps[3]?.notReceived;
      const _segMrRem=(seg&&seg.steps[3]?.remarks||'').replace(/^\[(Discrepancy|Not Received)\]\s*/,'');
      const _discBadge=_segDiscrep?`<span style="font-size:10px;font-weight:700;color:#fff;background:#ea580c;padding:2px 7px;border-radius:5px;border:1px solid #fb923c">⚠ Discrepancy</span>${_segMrRem?`<span style="font-size:10px;color:#c2410c;font-style:italic"> — ${_segMrRem.slice(0,40)}${_segMrRem.length>40?'…':''}</span>`:''}`:
        _segNotRcvd?`<span style="font-size:10px;font-weight:700;color:#fff;background:#dc2626;padding:2px 7px;border-radius:5px">✗ Not Received</span>`:'';
      let nextStep='';
      // Full step progress — always shown
      let stepProgress='';
      if(seg){
        // Status badges for completed/rejected/locked
        if(seg.status==='Completed') nextStep=`${_discBadge||''}`;
        else if(seg.status==='Rejected') nextStep='';
        // Build step-by-step progress row — ALWAYS for all segments
        const _stepBdg=(stepNum,label,clr)=>{
          const st=seg.steps[stepNum];
          if(!st) return '';
          if(st.skip){
            if((st.remarks||'').indexOf('Auto-skipped:')===0) return '<span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;font-weight:700;padding:2px 5px;border-radius:4px;background:#fef3c7;color:#a16207;border:1px solid #fde047;white-space:nowrap">⏭ Auto Skipped</span>';
            return '';
          }
          const done=st.done&&(stepNum!==4||!st.rejected);
          const active=!done&&seg.currentStep===stepNum&&seg.status!=='Completed'&&seg.status!=='Locked';
          const loc=byId(DB.locations,st.ownerLoc||st.loc);
          const locName=loc?.name||'';
          const locHtml=locName?` <span style="font-size:7px;font-weight:600;opacity:.75">(${locName})</span>`:'';
          if(done){
            return `<span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;font-weight:700;padding:2px 5px;border-radius:4px;background:${clr}22;color:${clr};border:1px solid ${clr}44;white-space:nowrap">✓ ${label}${locHtml}</span>`;
          }
          if(active){
            return `<span class="flash-green" style="display:inline-flex;align-items:center;gap:2px;font-size:9px;font-weight:700;padding:2px 5px;border-radius:4px;background:${clr}15;color:${clr};border:1.5px solid ${clr}66;white-space:nowrap">● ${label}${locHtml}</span>`;
          }
          // Incomplete / waiting
          return `<span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;font-weight:600;padding:2px 5px;border-radius:4px;background:rgba(0,0,0,0.03);color:var(--text3);border:1px solid transparent;white-space:nowrap">○ ${label}${locHtml}</span>`;
        };
        const lockBdg=seg.status==='Locked'?'<span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;font-weight:700;padding:2px 5px;border-radius:4px;background:rgba(0,0,0,0.04);color:var(--text3);white-space:nowrap">🔒 Locked</span>':'';
        const completeBdg=seg.status==='Completed'?'<span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;font-weight:700;padding:2px 5px;border-radius:4px;background:#dcfce7;color:#16a34a;border:1px solid #86efac;white-space:nowrap">✅ Done</span>':'';
        const rejBdg=seg.status==='Rejected'?'<span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;font-weight:700;padding:2px 5px;border-radius:4px;background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;white-space:nowrap">⚠ Rejected</span>':'';
        stepProgress=[
          lockBdg,
          _stepBdg(1,'Gate Exit','#2a9aa0'),
          _stepBdg(2,'Gate Entry','#0d9488'),
          _stepBdg(3,'Mat. Receipt','#16a34a'),
          _stepBdg(4,'Trip Approval','#7c3aed'),
          _stepBdg(5,'Empty Exit','#ea580c'),
          completeBdg,
          rejBdg
        ].filter(Boolean).join('');
      }
      // Show all challans for this destination (multi-challan support)
      // Suppress warnings for in-progress (step 1 done) or completed segments
      const _tbSegInProgress=seg&&(seg.steps[1]?.done||seg.status==='Completed');
      const challansArr=t['challans'+idx]||[];
      var challanDisplay='';
      if(_tbSegInProgress){
        // In-progress/completed: just show info, no warnings
        challanDisplay=challansArr.length
          ?challansArr.map(ch2=>`<span style="font-size:11px;font-weight:700;background:var(--surface2);border:1px solid var(--border);padding:2px 6px;border-radius:5px;white-space:nowrap">📄 ${ch2.no}</span>`).join(' ')
          :(ch?`<span style="font-size:11px;font-weight:700;background:var(--surface2);border:1px solid var(--border);padding:2px 6px;border-radius:5px">📄 ${ch}</span>`:'');
      } else {
        const _chComplete=function(arr,leg){
          if(!arr.length&&!leg) return 'none';
          if(!arr.length&&leg){
            var m2=[];
            if(!trip?.['weight'+idx]) m2.push('Weight');
            if(!trip?.['photo'+idx]) m2.push('Photo');
            return m2.length?m2:null;
          }
          var missing=[];
          if(arr.some(function(c){return !c.no||!c.no.trim();})) missing.push('Challan');
          if(arr.some(function(c){return !c.weight;})) missing.push('Weight');
          if(arr.some(function(c){return !c.photo;})) missing.push('Photo');
          return missing.length?missing:null;
        };
        var _chStatus=_chComplete(challansArr,ch);
        challanDisplay=_chStatus==='none'
          ?'<span class="flash-red" style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px">⚠ No Challan / Weight / Photo</span>'
          :(!_chStatus)
            ?(challansArr.length
              ?challansArr.map(ch2=>`<span style="font-size:11px;font-weight:700;background:var(--surface2);border:1px solid var(--border);padding:2px 6px;border-radius:5px;white-space:nowrap">📄 ${ch2.no}</span>`).join(' ')
              :`<span style="font-size:11px;font-weight:700;background:var(--surface2);border:1px solid var(--border);padding:2px 6px;border-radius:5px">📄 ${ch}</span>`)
            :'<span class="flash-red" style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px">⚠ Missing: '+_chStatus.join(', ')+'</span>';
      }
      const clr={A:'#35b0b6',B:'#14b8a6',C:'#8b5cf6'}[lbl]||'var(--accent)';
      return `<div style="padding:5px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:${stepProgress||nextStep?'4px':'0'}">
          <span style="width:20px;height:20px;border-radius:50%;background:${clr};color:#fff;font-size:9px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${lbl}</span>
          <span style="font-size:11px;flex:1;min-width:80px">${lname(from)} <span style="color:var(--accent);font-weight:900">⟶</span> ${lname(to)}</span>
          ${challanDisplay}
          ${ph?`<img src="${ph}" onclick="openPhoto(this.src)" style="width:26px;height:26px;object-fit:cover;border-radius:4px;border:2px solid var(--green);cursor:pointer">`:''}
        </div>
        ${stepProgress?`<div style="padding-left:26px;display:flex;flex-wrap:wrap;gap:3px">${stepProgress}</div>`:''}
        ${nextStep?`<div style="padding-left:26px;margin-top:2px">${nextStep}</div>`:''}
      </div>`;
    }).join('');

    const recVtName=t.vehicleTypeId?vtname(t.vehicleTypeId):vtype(t.vehicleId);
    const actVtName=t.actualVehicleTypeId?vtname(t.actualVehicleTypeId):recVtName;
    const vtMismatch=recVtName&&actVtName&&recVtName!==actVtName;
    const vtDisplay=recVtName
      ?(vtMismatch
        ?`${recVtName} <span class="flash-red" style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px">(${actVtName})</span>`
        :recVtName)
      :'';
    const isApproved=segs.some(s=>s.steps[4]?.done&&!s.steps[4]?.rejected);
    const canEdit=!isCompleted&&!isApproved&&!isCancelled;
    const deleteBtn=canDelete
      ?`<button onclick="event.stopPropagation();deleteTrip('${t.id}')" style="background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;border-radius:5px;font-size:10px;padding:2px 6px;cursor:pointer;font-weight:700" title="Delete trip">🗑</button>`
      :'';

    // Location colour strip for route display
    const locCol=(id)=>{const l=byId(DB.locations,id);return l?.colour||'var(--accent)';};
    const routeParts=_locs.map((id,i)=>{
      const l=byId(DB.locations,id);const c=l?.colour||'var(--accent)';
      return `<span style="${_locPillStyle(l?.colour,13)}">${l?.name||'?'}</span>`
        +(i<_locs.length-1?'<span style="color:var(--accent);font-weight:900;font-size:14px;margin:0 3px">⟶</span>':'');
    }).join('');

    const vehLabel=hasVeh
      ?`<span style="font-family:var(--mono);font-size:clamp(14px,4vw,26px);font-weight:900;color:var(--text);background:#fef08a;border:1.5px solid #ca8a04;padding:2px 10px;border-radius:8px;white-space:nowrap">${vn}</span>`
      :`<span class="flash-red" style="font-family:var(--mono);font-size:22px;font-weight:900;padding:2px 8px;border-radius:8px">No Vehicle</span>`;

    return `<div class="trip-card" style="padding:0;overflow:hidden;cursor:pointer;${cardBg};position:relative" onclick="toggleMyTripCard('${tid}')">
      <!-- Row 1: ID + Vehicle + edit/delete top-right -->
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px 0;min-width:0;flex-wrap:nowrap;padding-right:${canDelete||canEdit?'80px':'10px'}">
        <span style="font-family:var(--mono);font-size:clamp(14px,4vw,28px);font-weight:900;color:#fff;background:var(--accent);padding:2px 10px;border-radius:9px;flex-shrink:0;letter-spacing:.5px;white-space:nowrap">${_cTid(t.id)}</span>
        <span style="flex-shrink:0">${vehLabel}</span>
      </div>
      <div style="position:absolute;top:6px;right:6px;display:flex;gap:4px;z-index:2">
        ${canEdit&&!isCancelled?`<button onclick="event.stopPropagation();editTrip('${t.id}')" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:5px 14px;font-size:12px;font-weight:800;cursor:pointer;line-height:1;box-shadow:0 2px 6px rgba(42,154,160,.3)">✏ Edit</button>`:''}
        ${canDelete?`<button onclick="event.stopPropagation();deleteTrip('${t.id}')" style="background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;border-radius:5px;font-size:11px;padding:3px 7px;cursor:pointer;font-weight:700;line-height:1" title="Delete trip">🗑</button>`:''}
      </div>
      <!-- Row 2: Vendor · Driver · Booked by · Date -->
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:3px 10px 6px;font-size:11px">${(()=>{const vendorName=t.vendor||'';const drv2=byId(DB.drivers,t.driverId);const drvName=drv2?.name||'';const bu=byId(DB.users,t.bookedBy);const bn=bu?.fullName||bu?.name||'';const dot='<span style="color:var(--border2)">·</span>';const parts=[];if(vendorName)parts.push(`<span style="font-weight:700;color:var(--accent);background:rgba(42,154,160,.08);padding:1px 8px;border-radius:4px;border:1px solid rgba(42,154,160,.2)">🏢 ${vendorName}</span>`);if(drvName)parts.push(`<span style="color:var(--text2);font-weight:600">🧑 ${drvName}</span>`);parts.push(`<span style="color:var(--text3)">Booked by:</span><span style="font-weight:700;color:var(--text2)">${bn||'—'}</span>`);parts.push(`<span style="color:var(--text3)">📅 ${fdt(t.date)}</span>`);return parts.join(dot);})()}</div>
      <!-- Line 2: Coloured route pills + No Challan flash -->
      <div style="padding:2px 10px 4px;display:flex;flex-wrap:wrap;gap:3px;align-items:center">${(()=>{const dests=[[t.dest1,1],[t.dest2,2],[t.dest3,3]].filter(([d])=>d);const _tripSegs=DB.segments.filter(s=>s.tripId===t.id);const anyIncomplete=dests.some(([d,idx])=>{const lbl='ABC'[idx-1];const _tseg=_tripSegs.find(s=>s.label===lbl);if(_tseg&&(_tseg.steps[1]?.done||_tseg.status==='Completed'))return false;const arr=t['challans'+idx]||[];const leg=t['challan'+idx]||'';if(!arr.length&&!leg)return true;if(!arr.length&&leg)return !t['weight'+idx]||!t['photo'+idx];return arr.some(c=>!c.no||!c.no.trim()||!c.weight||!c.photo);});return anyIncomplete?'<span class="flash-red" style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:5px;margin-right:2px">⚠ No Challan / Weight / Photo</span>':'';})()}${routeParts}</div>
      <!-- Step status summary (collapsed view) -->
      ${(()=>{
        if(isCancelled) return `<div style="padding:2px 10px 6px"><span class="badge" style="font-size:10px;padding:3px 10px;background:rgba(107,114,128,.12);color:#6b7280;border:1px solid rgba(107,114,128,.3)">✕ Cancelled</span></div>`;
        if(isCompleted) return `<div style="padding:2px 10px 6px"><span class="badge badge-green" style="font-size:10px;padding:3px 10px">✅ Trip Completed</span></div>`;
        const statusPills=segs.map(seg=>{
          const clr={A:'#35b0b6',B:'#14b8a6',C:'#8b5cf6'}[seg.label]||'var(--accent)';
          if(seg.status==='Completed') return `<span style="display:inline-flex;align-items:center;gap:3px;background:#f0fdf4;border:1px solid #86efac;padding:2px 6px;border-radius:5px;font-size:10px;font-weight:700"><span style="width:14px;height:14px;border-radius:50%;background:${clr};color:#fff;font-size:7px;font-weight:900;display:inline-flex;align-items:center;justify-content:center">${seg.label}</span><span style="color:#16a34a">✓ Done</span></span>`;
          if(seg.status==='Rejected') return `<span style="display:inline-flex;align-items:center;gap:3px;background:#fef2f2;border:1px solid #fca5a5;padding:2px 6px;border-radius:5px;font-size:10px;font-weight:700"><span style="width:14px;height:14px;border-radius:50%;background:${clr};color:#fff;font-size:7px;font-weight:900;display:inline-flex;align-items:center;justify-content:center">${seg.label}</span><span style="color:#dc2626">⚠ Rejected</span></span>`;
          if(seg.status==='Locked') return `<span style="display:inline-flex;align-items:center;gap:3px;background:var(--surface2);border:1px solid var(--border);padding:2px 6px;border-radius:5px;font-size:10px;font-weight:600"><span style="width:14px;height:14px;border-radius:50%;background:${clr};color:#fff;font-size:7px;font-weight:900;display:inline-flex;align-items:center;justify-content:center">${seg.label}</span><span style="color:var(--text3)">🔒</span></span>`;
          const _sn={1:'Gate Exit',2:'Gate Entry',3:'Mat. Receipt',4:'Trip Approval',5:'Empty Exit'};
          const _si={1:'🚪',2:'🏁',3:'📦',4:'✅',5:'📤'};
          const _cs=seg.currentStep;
          const _st=seg.steps[_cs];
          const _locId=_st?.loc;
          const _loc=_locId?byId(DB.locations,_locId):null;
          const _locName=_loc?.name||'';
          const _locColour=_loc?.colour||'var(--text3)';
          return `<span style="display:inline-flex;align-items:center;gap:3px;background:var(--surface2);border:1px solid var(--border);padding:2px 6px;border-radius:5px;font-size:10px;font-weight:700"><span style="width:14px;height:14px;border-radius:50%;background:${clr};color:#fff;font-size:7px;font-weight:900;display:inline-flex;align-items:center;justify-content:center">${seg.label}</span><span class="flash-green">${_si[_cs]||''} ${_sn[_cs]||''}</span>${_locName?`<span style="color:${_locColour};font-size:9px;font-weight:800">@${_locName}</span>`:''}</span>`;
        });
        return statusPills.length?`<div style="padding:2px 10px 6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center">${statusPills.join('')}</div>`:'';
      })()}
      <!-- Expanded details -->
      <div id="myTrip_${tid}" style="display:none;border-top:1px solid var(--border);padding:8px 10px" onclick="event.stopPropagation()">
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px">
          ${vtDisplay?`<span style="font-size:11px;font-weight:700;color:#16a34a">${vtDisplay}</span>`:''}
          ${tripOverallBadge(t)}
          <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
            ${canCancel?`<button onclick="event.stopPropagation();cancelTrip('${t.id}')" style="background:#f3f4f6;color:#6b7280;border:1px solid #d1d5db;border-radius:5px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer">✕ Cancel Trip</button>`:''}
          </span>
        </div>
        ${segRows}
      </div>
    </div>`;
  }).join('');
  document.getElementById('myTripBody').innerHTML=rows||'<div class="empty-state">No trips in selected period</div>';
  // Re-open cards that were expanded before re-render
  _expanded.forEach(tid=>{
    const el=document.getElementById('myTrip_'+tid);
    if(el){el.style.display='block';}
  });
}

function toggleMyTripCard(tid){
  const el=document.getElementById('myTrip_'+tid);
  if(!el)return;
  const isOpen=el.style.display!=='none';
  el.style.display=isOpen?'none':'block';
}

function filterQuickVeh(){
  const typeId=document.getElementById('qvType').value;
  const sel=document.getElementById('qvVehicle');
  if(!typeId){sel.disabled=true;sel.innerHTML='<option value="">— Select type first —</option>';return;}
  const filtered=sortBy(DB.vehicles.filter(v=>!v.inactive&&v.typeId===typeId),v=>v.number);
  sel.disabled=false;
  sel.innerHTML='<option value="">— Select Vehicle —</option>'+filtered.map(v=>`<option value="${v.id}">${v.number}</option>`).join('');
}
async function saveQuickVeh(){
  const tripId=document.getElementById('qvTripId').value;
  const t=byId(DB.trips,tripId);if(!t)return;
  t.vehicleTypeId=document.getElementById('qvType').value;
  t.vehicleId=document.getElementById('qvVehicle').value;
  const v=byId(DB.vehicles,t.vehicleId);
  t.vendor=byId(DB.vendors,v?.vendorId)?.name||t.vendor||'';
  cm('mQuickVeh');renderMyTrips();renderDash();renderKapPage();renderMR();renderApprove();notify('Vehicle updated!');
}

async function saveQuickChallan(){
  const tripId=document.getElementById('qcTripId').value;
  const t=byId(DB.trips,tripId);if(!t)return;
  [1,2,3].forEach(idx=>{
    const cEl=document.getElementById('qcC'+idx);
    const wEl=document.getElementById('qcW'+idx);
    const fEl=document.getElementById('qcF'+idx);
    if(!cEl)return;
    const no=cEl.value.trim();
    const wt=(wEl?wEl.value.trim():'');
    const photo=fEl&&fEl._data?fEl._data:(t['challans'+idx]?.[0]?.photo||t['photo'+idx]||'');
    t['challan'+idx]=no;
    t['weight'+idx]=wt;
    if(fEl&&fEl._data)t['photo'+idx]=fEl._data;
    // Keep challans array in sync
    if(no){
      const existing=t['challans'+idx]||[];
      if(existing.length){existing[0]={...existing[0],no,weight:wt,photo:photo||existing[0].photo};}
      else{t['challans'+idx]=[{no,weight:wt,photo}];}
    }
  });
  cm('mQuickChallan');renderMyTrips();renderDash();renderKapPage();notify('Challan details updated!');
}

let _kapMode='exit'; // 'exit', 'entry', 'spot'
function renderKapPage(){
  setKapMode(_kapMode||'exit');
}
function setKapMode(mode){
  _kapMode=mode;
  // Show/hide content sections
  const sections={exit:'kapExitSection',entry:'kapEntrySection',spot:'kapSpotSection'};
  Object.entries(sections).forEach(([m,id])=>{
    const el=document.getElementById(id);
    if(el) el.style.display=m===mode?'block':'none';
  });
  // Highlight active tab button
  const accent='var(--accent)', green='#16a34a';
  const tabCfg={
    exit:  {id:'kapTabBtnExit',  bg:accent, text:'#fff'},
    entry: {id:'kapTabBtnEntry', bg:accent, text:'#fff'},
    spot:  {id:'kapTabBtnSpot',  bg:green,  text:'#fff'},
  };
  Object.entries(tabCfg).forEach(([m,cfg])=>{
    const btn=document.getElementById(cfg.id);
    if(!btn) return;
    if(m===mode){
      btn.style.background=cfg.bg;
      btn.style.color=cfg.text;
      btn.style.fontWeight='900';
    } else {
      btn.style.background='transparent';
      btn.style.color='var(--text)';
      btn.style.fontWeight='700';
    }
  });
  // Render content for selected mode
  if(mode==='exit'||mode==='entry'){
    renderKap();
  } else if(mode==='spot'){
    const mySpotLoc=byId(DB.locations,CU.plant);
    const locBadge=document.getElementById('spotLocBadge');
    if(locBadge){
      if(mySpotLoc){
        const c=mySpotLoc.colour||'var(--accent)';const tc=colourContrast(mySpotLoc.colour||'');
        locBadge.style.cssText=`font-size:11px;font-weight:700;padding:1px 8px;border-radius:5px;background:${c};color:${tc}`;
        locBadge.textContent=mySpotLoc.name;
      } else {locBadge.textContent='';}
    }
    renderSpotTab();
  }
  // Update all count badges
  _kapUpdateCounts();
}
function _kapUpdateCounts(){
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');
  // Exit count: segments at step 1 pending
  const exitCount=DB.segments.filter(s=>{
    if(s.status==='Completed'||s.status==='Locked') return false;
    const cs=s.currentStep;
    if(cs===1&&!s.steps[1]?.skip&&!s.steps[1]?.done) return canDoStep(s,1);
    if(!s.steps[5]?.skip&&!s.steps[5]?.done&&stepsOneAndTwoDone(s)) return canDoStep(s,5);
    return false;
  }).length;
  // Entry count: segments at step 2 pending
  const entryCount=DB.segments.filter(s=>{
    if(s.status==='Completed'||s.status==='Locked') return false;
    const cs=s.currentStep;
    if(cs===2&&!s.steps[2]?.skip&&!s.steps[2]?.done) return canDoStep(s,2);
    return false;
  }).length;
  // Spot count: active spot trips (no exit time)
  const spotCount=(DB.spotTrips||[]).filter(s=>{
    if(s.exitTime) return false;
    if(isSA) return true;
    return _isMyLocation(s.location);
  }).length;
  const _setBadge=(id,n)=>{
    const el=document.getElementById(id);
    if(!el) return;
    el.textContent=n||'';
    el.style.display=n?'inline-flex':'none';
  };
  _setBadge('kapCountTabExit',exitCount);
  _setBadge('kapCountTabEntry',entryCount);
  _setBadge('kapCountTabSpot',spotCount);
}

// ═══ KAP SECURITY ═══════════════════════════════════════════════════════
let _spotChallanCount=0;
function _spotRestoreThumb(thumbId,photoData){
  const el=document.getElementById(thumbId);if(!el||!photoData)return;
  const fileInputId=thumbId.replace('Thumb','File');
  const img=document.createElement('img');
  img.src=photoData;img.style.cssText='width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in';
  // Click on image → lightbox only
  img.onclick=ev=>{ev.stopPropagation();openPhoto(photoData);};
  el.innerHTML='';el.appendChild(img);
  el.style.border='2px solid #16a34a';
  // Thumb onclick → also lightbox
  el.onclick=ev=>{ev.stopPropagation();openPhoto(photoData);};
  // Add × remove button
  const parent=el.parentElement;if(!parent) return;
  parent.style.position='relative';
  const existing=parent.querySelector('.spot-photo-clear');if(existing)existing.remove();
  const xBtn=document.createElement('button');
  xBtn.className='spot-photo-clear';xBtn.textContent='×';
  xBtn.style.cssText='position:absolute;top:-7px;right:-7px;background:#dc2626;color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:13px;cursor:pointer;padding:0;line-height:1;z-index:10;display:flex;align-items:center;justify-content:center';
  const icons={'spotVehThumb':'🚗','spotDriverThumb':'🧑','spotExitVehThumb':'🚗','spotExitPhotoThumb':'🚗'};
  xBtn.onclick=ev=>{
    ev.stopPropagation();
    const fi=document.getElementById(fileInputId);if(fi){fi.value='';fi._compressedData=null;}
    xBtn.remove();
    el.innerHTML=icons[thumbId]||'📄';
    el.style.border='2px dashed var(--border2)';
    // Restore file picker onclick
    el.onclick=()=>_showPhotoChoice(fileInputId,thumbId);
  };
  parent.appendChild(xBtn);
}
function _spotInitChallans(challans){
  _spotChallanCount=0;
  const box=document.getElementById('spotChallanRows');if(!box)return;
  box.innerHTML='';
  const list=Array.isArray(challans)&&challans.length?challans:[{no:'',photo:''}];
  list.forEach(c=>_spotAddChallanRow(c.no||'',c.photo||''));
}
function _spotAddChallanRow(no='',photo=''){
  _spotChallanCount++;const i=_spotChallanCount;
  const box=document.getElementById('spotChallanRows');if(!box)return;
  const row=document.createElement('div');
  row.id='spotChallanRow_'+i;
  row.style.cssText='display:flex;align-items:center;gap:6px;margin-bottom:5px';
  const noQ=no.replace(/"/g,'&quot;');
  // Grid cell: challan text above photo, × in top-right corner
  row.style.cssText='display:flex;flex-direction:column;gap:3px;position:relative';
  row.innerHTML=`<input type="text" id="spotChallanNo_${i}" value="${noQ}" placeholder="Challan no." style="padding:4px 6px;font-size:13px;border:1.5px solid var(--border2);border-radius:6px;box-sizing:border-box;width:100%">`
    +`<div id="spotChallanThumb_${i}" onclick="_showPhotoChoice('spotChallanFile_${i}','spotChallanThumb_${i}')" style="height:60px;border:2px dashed var(--border2);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:22px;overflow:hidden;background:var(--surface2);cursor:pointer">${photo?`<img src="${photo}" style="width:100%;height:100%;object-fit:cover">`:'📄'}</div>`
    +`<input type="file" id="spotChallanFile_${i}" accept="image/*" capture="environment" style="display:none" onchange="onSpotPhoto(this,'spotChallanThumb_${i}')">`
    +(i>1?`<button onclick="document.getElementById('spotChallanRow_${i}').remove()" style="position:absolute;top:-6px;right:-6px;background:#dc2626;color:#fff;border:none;border-radius:50%;width:18px;height:18px;font-size:11px;cursor:pointer;padding:0;line-height:1;z-index:1">×</button>`:'');
  box.appendChild(row);
}
function _spotGetChallans(){
  const rows=document.querySelectorAll('[id^="spotChallanRow_"]');
  return Array.from(rows).map(row=>{
    const idx=row.id.replace('spotChallanRow_','');
    const no=document.getElementById('spotChallanNo_'+idx)?.value.trim()||'';
    const ph=document.getElementById('spotChallanFile_'+idx)?._compressedData||'';
    return {no,photo:ph};
  }).filter(c=>c.no||c.photo);
}
function _kapOpenSpotPopup(spotId){
  _kapPopupOpen=true;
  // Update location badge
  const mySpotLoc=byId(DB.locations,CU.plant);
  const badge=document.getElementById('spotLocBadgePopup');
  if(badge&&mySpotLoc){
    const c=mySpotLoc.colour||'var(--accent)';const tc=colourContrast(mySpotLoc.colour||'');
    badge.style.cssText=`font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;background:${c};color:${tc}`;
    badge.textContent=mySpotLoc.name;
  }
  const exitSec=document.getElementById('spotExitSection');
  const popupId=document.getElementById('spotPopupId');
  if(spotId){
    // Editing existing record
    const s=(DB.spotTrips||[]).find(x=>x&&x.id===spotId);
    if(!s){_kapPopupOpen=false;return;}
    // Load photos on-demand if not cached — updates thumbnails after fetch
    _loadPhotos('spotTrips',spotId).then(function(){
      _spotRestoreThumb('spotVehThumb',s.entryVehiclePhoto);
      _spotRestoreThumb('spotDriverThumb',s.driverPhoto);
      if(s.exitVehiclePhoto) _spotRestoreThumb('spotExitVehThumb',s.exitVehiclePhoto);
      // Update onclick handlers with loaded photos
      var vt2=document.getElementById('spotVehThumb');
      if(vt2&&s.exitTime) vt2.onclick=function(){openPhoto(s.entryVehiclePhoto||'');};
      var dt2=document.getElementById('spotDriverThumb');
      if(dt2&&s.exitTime) dt2.onclick=function(){openPhoto(s.driverPhoto||'');};
      var et2=document.getElementById('spotExitVehThumb');
      if(et2&&s.exitVehiclePhoto) et2.onclick=function(){openPhoto(s.exitVehiclePhoto);};
    });
    // Fill entry fields
    document.getElementById('spotEditId').value=spotId;
    document.getElementById('spotVehNum').value=s.vehicleNum||'';
    document.getElementById('spotDriverName').value=s.driverName||'';
    document.getElementById('spotDriverMob').value=s.driverMobile||'';
    document.getElementById('spotSupplier').value=s.supplier||'';
    _spotInitChallans(s.challans||(s.challan?[{no:s.challan,photo:s.challanPhoto||''}]:[]));
    document.getElementById('spotEntryRemarks').value=s.entryRemarks||'';
    if(popupId) popupId.textContent=spotId;
    const hasExited=!!s.exitTime;
    const isAutoExited=hasExited&&(s.exitRemarks||'').indexOf('Auto-exit')>=0;
    // Stale = entry older than 48hrs (locked to view-only regardless of exit status)
    const entryTs=s.entryTime?new Date(s.entryTime).getTime():(s.date?new Date(s.date+'T00:00:00').getTime():0);
    const isStale=entryTs>0&&(Date.now()-entryTs)>48*3600000;
    const isLocked=hasExited||isStale;
    var _spotTitle=document.getElementById('spotPopupTitle');
    var _titleExtra=isAutoExited?'<span style="background:#fef3c7;color:#92400e;border:1px solid #fde047;padding:2px 8px;border-radius:5px;font-size:11px;margin-left:6px">Auto Exited</span>':(isStale&&!hasExited?'<span style="background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;padding:2px 8px;border-radius:5px;font-size:11px;margin-left:6px">Locked (48hrs)</span>':'');
    if(_spotTitle) _spotTitle.innerHTML='Spot Vehicle Entry'+_titleExtra;
    const canExit=!hasExited&&!!s.entryTime&&!isStale;
    // If exited or stale: disable all entry form fields (read-only view)
    const entryFormFields=['spotVehNum','spotDriverName','spotDriverMob','spotSupplier','spotEntryRemarks'];
    entryFormFields.forEach(id=>{
      const el=document.getElementById(id);if(el){el.disabled=isLocked;el.style.opacity=isLocked?'0.6':'';}
    });
    // Disable challan inputs and photo buttons if locked
    document.querySelectorAll('[id^="spotChallanNo_"]').forEach(el=>{el.disabled=isLocked;el.style.opacity=isLocked?'0.6':'';});
    document.querySelectorAll('[id^="spotChallanThumb_"]').forEach(el=>{if(isLocked){el.onclick=null;}});
    // Remove all photo × remove buttons if locked (entry photos are locked)
    if(isLocked){
      document.querySelectorAll('.spot-photo-clear').forEach(btn=>btn.remove());
    }
    const vehThumb=document.getElementById('spotVehThumb');
    if(vehThumb) vehThumb.onclick=isLocked?()=>openPhoto(s.entryVehiclePhoto||''):()=>_showPhotoChoice('spotVehFile','spotVehThumb');
    const drvThumb=document.getElementById('spotDriverThumb');
    if(drvThumb) drvThumb.onclick=isLocked?()=>openPhoto(s.driverPhoto||''):()=>_showPhotoChoice('spotDriverFile','spotDriverThumb');
    // Exit section: show always for exited records (read-only), show editable for inside vehicles
    if(exitSec){exitSec.style.display='flex';}
    document.getElementById('spotExitId').value=spotId;
    if(hasExited){
      // Show exit details read-only
      document.getElementById('spotExitRemarks').value=s.exitRemarks||'';
      document.getElementById('spotExitRemarks').disabled=true;
      document.getElementById('spotExitRemarks').style.opacity='0.6';
      _spotRestoreThumb('spotExitVehThumb',s.exitVehiclePhoto);
      document.getElementById('spotExitVehThumb').onclick=s.exitVehiclePhoto?()=>openPhoto(s.exitVehiclePhoto):null;
      // Check if within 2hrs for revoke
      const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');
      const can=isSA||(CU.id===s.exitBy);
      const exitAge=(Date.now()-new Date(s.exitTime))/1000/3600;
      const exitBtn=document.getElementById('spotExitBtn');
      if(exitBtn){
        if(isAutoExited){
          exitBtn.textContent='🟡 Auto Exited';exitBtn.disabled=true;
          exitBtn.style.cssText='background:#fef3c7;border:2px solid #fde047;color:#92400e;border-radius:9px;font-size:13px;padding:9px 16px;cursor:not-allowed;font-weight:800';
        } else if(can&&exitAge<=2){
          exitBtn.textContent='↩ Revoke Exit';exitBtn.className='btn';
          exitBtn.style.cssText='background:#fbbf24;border:1.5px solid #f59e0b;color:#78350f;font-weight:800;border-radius:9px;font-size:13px;padding:9px 16px;cursor:pointer';
          exitBtn.onclick=()=>_spotRevokeExit(spotId);
        } else {
          exitBtn.textContent='🚪 Exited';exitBtn.disabled=true;
          exitBtn.style.cssText='background:#f1f5f9;border:1px solid #cbd5e1;color:#94a3b8;border-radius:9px;font-size:13px;padding:9px 16px;cursor:not-allowed;opacity:.6';
        }
      }
    } else if(isStale&&!hasExited){
      // Stale (>48hrs) but not exited — locked, show disabled exit
      document.getElementById('spotExitRemarks').disabled=true;
      document.getElementById('spotExitRemarks').style.opacity='0.6';
      document.getElementById('spotExitRemarks').value='Locked — entry older than 48 hours';
      const et=document.getElementById('spotExitVehThumb');if(et){et.innerHTML='🔒';et.style.border='2px dashed #cbd5e1';et.onclick=null;}
      const exitBtn=document.getElementById('spotExitBtn');
      if(exitBtn){exitBtn.textContent='🔒 Locked (48hrs)';exitBtn.disabled=true;exitBtn.style.cssText='background:#f1f5f9;border:2px solid #cbd5e1;color:#94a3b8;border-radius:9px;font-size:13px;padding:9px 16px;cursor:not-allowed;font-weight:800';}
    } else if(canExit){
      document.getElementById('spotExitRemarks').disabled=false;
      document.getElementById('spotExitRemarks').style.opacity='';
      document.getElementById('spotExitRemarks').value='';
      const ef=document.getElementById('spotExitVehFile');if(ef){ef.value='';ef._compressedData=null;}
      const et=document.getElementById('spotExitVehThumb');if(et){et.innerHTML='🚗';et.style.border='2px dashed #fca5a5';et.onclick=()=>_showPhotoChoice('spotExitVehFile','spotExitVehThumb');}
      const exitBtn=document.getElementById('spotExitBtn');
      if(exitBtn){exitBtn.textContent='🚪 Record Exit';exitBtn.className='btn btn-danger';exitBtn.disabled=false;exitBtn.style.cssText='font-size:13px;padding:9px 16px;font-weight:800;border-radius:9px';exitBtn.onclick=doSpotExit;}
    }
    // Submit button: hide if locked, show edit if inside and not stale
    const sb=document.getElementById('spotSubmitBtn');
    if(sb){
      if(isLocked){sb.style.display='none';}
      else{sb.style.display='';sb.textContent='✏ Save Entry';sb.className='btn btn-primary';}
    }
    const cb=document.getElementById('spotCancelEditBtn');
    if(cb) cb.style.display='none';
  } else {
    // New entry
    clearSpotForm();
    _spotInitChallans([]);
    document.getElementById('spotEditId').value='';
    if(exitSec) exitSec.style.display='none';
    if(popupId) popupId.textContent='New';
    const sb=document.getElementById('spotSubmitBtn');
    if(sb){sb.textContent='🏁 Record Entry';sb.className='btn btn-green';}
    const cb=document.getElementById('spotCancelEditBtn');
    if(cb) cb.style.display='none';
  }
  const el=document.getElementById('mSpotEntry');
  if(el) el.style.display='flex';
}
function _kapCloseSpotPopup(){
  _kapPopupOpen=false;
  const el=document.getElementById('mSpotEntry');
  if(el) el.style.display='none';
}
function _kapOpenPopup(popId){
  _kapPopupOpen=true;
  const el=document.getElementById(popId);
  if(el) el.style.display='flex';
}
function _kapClosePopup(popId){
  _kapPopupOpen=false;
  const el=document.getElementById(popId);
  if(el) el.style.display='none';
}
function _kapGetOpenPopup(){
  // Return the id of any currently-open KAP popup
  const open=document.querySelector('[id^="kap_pop_"][style*="flex"]');
  return open?open.id:null;
}
function _kapRestorePopup(popId){
  if(!popId) return;
  const el=document.getElementById(popId);
  if(el){el.style.display='flex';_kapPopupOpen=true;}
}
// Generic popup open/close for MR and Approval pages
var _popOpen=false;
function _openPop(popId){
  _popOpen=true;
  const el=document.getElementById(popId);
  if(el) el.style.display='flex';
}
function _closePop(popId){
  _popOpen=false;
  const el=document.getElementById(popId);
  if(el) el.style.display='none';
  // Refresh pages now that popup is closed (data may have changed while popup was open)
  try{renderMR();}catch(e){}
  try{renderApprove();}catch(e){}
}
function renderKap(){
  try{ _renderKapInner(); }catch(e){
    console.error('renderKap error:',e);
    var el=document.getElementById(_kapMode==='entry'?'kapEntryContent':'kapExitContent');
    if(el) el.innerHTML='<div style="padding:20px;color:#dc2626;font-weight:700;font-size:13px">⚠ Error loading KAP page: '+e.message+'</div>';
  }
}
function _renderKapInner(){
  const _savedPop=_kapGetOpenPopup(); // save before re-render destroys DOM
  // Init date ranges for both exit and entry history (1M default)
  initDfMonth('kapHistExit','kapHistExitFrom','kapHistExitTo');
  initDfMonth('kapHistEntry','kapHistEntryFrom','kapHistEntryTo');
  const srch=(document.getElementById(_kapMode==='entry'?'kapSearchEntry':'kapSearchExit')?.value||'').toLowerCase();
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');

  // Read date range from mode-specific inputs
  const _kapFromId=_kapMode==='entry'?'kapHistEntryFrom':'kapHistExitFrom';
  const _kapToId=_kapMode==='entry'?'kapHistEntryTo':'kapHistExitTo';
  const _kapGrp=_kapMode==='entry'?'kapHistEntry':'kapHistExit';
  initHistDates(_kapFromId,_kapToId,_kapGrp);
  const fromVal=document.getElementById(_kapFromId)?.value||'';
  const toVal=document.getElementById(_kapToId)?.value||'';

  // All active (pending) segments across both steps — show ALL until recorded
  let allPending=DB.segments.filter(s=>{
    if(s.status==='Completed'||s.status==='Locked')return false;
    const cs=s.currentStep;
    // Steps 1 & 2: sequential KAP gate actions
    if(cs===1||cs===2){if(s.steps[cs]?.skip)return false;return canDoStep(s,cs);}
    // Step 5: parallel Empty Vehicle Exit — available as soon as steps 1 & 2 are done
    if(!s.steps[5]?.skip&&!s.steps[5]?.done&&stepsOneAndTwoDone(s))return canDoStep(s,5);
    return false;
  });
  if(srch)allPending=allPending.filter(s=>s.tripId.toLowerCase().includes(srch)||vnum(byId(DB.trips,s.tripId)?.vehicleId).toLowerCase().includes(srch));

  // Update tab counts (both tabs always) — step 5 (Empty Exit) only on exit tab
  const isStep5=(s)=>!s.steps[5]?.skip&&!s.steps[5]?.done&&stepsOneAndTwoDone(s);
  const exitCount=allPending.filter(s=>s.currentStep===1||isStep5(s)).length;
  const entryCount=allPending.filter(s=>s.currentStep===2).length;

  const step=(_kapMode==='entry')?2:1;
  let pendingSegs=allPending.filter(s=>step===1?(s.currentStep===1||isStep5(s)):s.currentStep===2);

  // Deduplicate by tripId — show one card per trip (card already shows all segments)
  const _seenTrips=new Set();
  pendingSegs=pendingSegs.filter(s=>{
    if(_seenTrips.has(s.tripId)) return false;
    _seenTrips.add(s.tripId);
    return true;
  });

  // ── Pending section ──
  // Sort by trip booking date descending (newest first)
  pendingSegs.sort((a,b)=>{const ta=byId(DB.trips,a.tripId);const tb=byId(DB.trips,b.tripId);return (tb?.date||'').localeCompare(ta?.date||'');});
  let pendingHtml='';
  if(pendingSegs.length){
    pendingHtml+=pendingSegs.map((seg,_idx)=>{
      const serialNo=pendingSegs.length-_idx; // descending
      const cs=seg.currentStep;
      const sid=seg.id.replace(/-/g,'_');
      const trip=byId(DB.trips,seg.tripId);
      const drv=byId(DB.drivers,trip?.driverId);
      const vehNum=vnum(trip?.vehicleId);
      const _isStep5=isStep5(seg);
      const btnCls=cs===1?'btn-danger':_isStep5?'btn-primary':'btn-green';
      const btnLabel=cs===1?'Record Gate Exit':_isStep5?'📤 Record Empty Vehicle Exit':'Record Gate Entry';

      // Check if ANY segment of this trip has had first action
      const allTripSegs=DB.segments.filter(s=>s.tripId===seg.tripId);
      const anySegStarted=allTripSegs.some(s=>[1,2,3,4].some(n=>s.steps[n]?.done));
      const hasVeh=vehNum&&vehNum!=='-';

      // Vehicle badge: always read-only on KAP page
      let vehBadge=hasVeh
        ?`<span style="font-family:var(--mono);font-size:clamp(18px,5vw,35px);font-weight:900;color:var(--text);background:#fef08a;border:2px solid #ca8a04;border-radius:8px;padding:2px 10px;flex-shrink:0;white-space:nowrap">${vehNum}</span>`
        :`<span class="flash-red" style="font-family:var(--mono);font-size:24px;font-weight:900;border-radius:8px;padding:2px 10px;flex-shrink:0">No Vehicle</span>`;

      // Build all segment rows
      const allSegDests=[[trip?.startLoc,trip?.dest1,'A',1]];
      if(trip?.dest2)allSegDests.push([trip.dest1,trip.dest2,'B',2]);
      if(trip?.dest3)allSegDests.push([trip.dest2,trip.dest3,'C',3]);

      // Compact route summary with challan
      const routeSummary=allSegDests.map(([from,to,lbl,idx])=>{
        const ch=trip?.['challan'+idx]||'';
        const clr={A:'#35b0b6',B:'#14b8a6',C:'#8b5cf6'}[lbl]||'var(--accent)';
        return `<span style="display:inline-flex;align-items:center;gap:3px;white-space:nowrap">`
          +`<span style="width:16px;height:16px;border-radius:50%;background:${clr};color:#fff;font-size:8px;font-weight:900;display:inline-flex;align-items:center;justify-content:center">${lbl}</span>`
          +`<span style="font-size:11px">${lnameText(from)} ⟶ ${lnameText(to)}</span>`
          +(ch?`<span style="font-size:10px;font-weight:700;background:#f0fafa;border:1px solid #b3dfe0;padding:0 4px;border-radius:3px;color:#1d6f73">📄${ch}</span>`:'')
          +`</span>`;
      }).join('<span style="font-size:10px;color:var(--text3);margin:0 3px">|</span>');

      const segRows=allSegDests.map(([from,to,lbl,idx])=>{
        const _seg=DB.segments.find(ss=>ss.tripId===seg.tripId&&ss.label===lbl);
        const ch=trip?.['challan'+idx]||'';
        const wt=trip?.['weight'+idx]||'';
        const ph=trip?.['photo'+idx];
        const _isActive=lbl===seg.label;
        const _segStarted=_seg&&[1,2,3,4].some(n=>_seg.steps[n]?.done);
        const _kapDone=_seg&&[1,2].every(n=>_seg.steps[n]?.done||_seg.steps[n]?.skip);
        const _rowClass=_isActive?'kap-row-active':_kapDone?'kap-row-done':'';
        const clr={A:'#35b0b6',B:'#14b8a6',C:'#8b5cf6'}[lbl]||'var(--accent)';

        let nextStepLabel='';
        if(_seg){
          if(_seg.status==='Completed') nextStepLabel='<span class="badge badge-green" style="font-size:9px">✓ Done</span>';
          else if(_seg.status==='Locked') nextStepLabel='<span style="font-size:10px;color:var(--text3)">🔒</span>';
          else if(_seg.status==='Rejected') nextStepLabel='<span class="badge badge-red" style="font-size:9px">⚠</span>';
          else{
            const sn={1:'Gate Exit',2:'Gate Entry',3:'Mat.Receipt',4:'Trip Approval',5:'Empty Exit'};
            const si={1:'🚪',2:'🏁',3:'📦',4:'✅'};
            nextStepLabel=`<span class="flash-green">${si[_seg.currentStep]||''} ${sn[_seg.currentStep]||''}</span>`;
          }
        }

        // KAP page: challan is always read-only; show all challans for this segment
        // Suppress warnings for in-progress (step 1 done) or completed segments
        const _segInProgress=_seg&&(_seg.steps[1]?.done||_seg.status==='Completed');
        const _t2=byId(DB.trips,seg.tripId);
        const challansArrKap=(_t2&&_t2['challans'+idx]&&_t2['challans'+idx].length?_t2['challans'+idx]:[]);
        var challanDisplay='';
        if(_segInProgress){
          // In-progress/completed: just show challan info, no warnings
          challanDisplay=challansArrKap.length
            ?challansArrKap.map(c2=>`<span style="font-size:11px;font-weight:700;background:var(--surface2);border:1px solid var(--border);padding:2px 5px;border-radius:5px;white-space:nowrap">📄 ${c2.no}${c2.weight?' · '+c2.weight+'kg':''}</span>`).join(' ')
            :(ch?`<span style="font-size:11px;font-weight:700;background:var(--surface2);border:1px solid var(--border);padding:2px 7px;border-radius:5px">📄 ${ch}${wt?' · '+wt+'kg':''}</span>`:'');
        } else {
          var _kapChStatus='none';
          if(challansArrKap.length){
            var _km=[];
            if(challansArrKap.some(function(c){return !c.no||!c.no.trim();})) _km.push('Challan');
            if(challansArrKap.some(function(c){return !c.weight;})) _km.push('Weight');
            if(challansArrKap.some(function(c){return !c.photo;})) _km.push('Photo');
            _kapChStatus=_km.length?_km:null;
          } else if(ch){
            var _km2=[];
            if(!wt) _km2.push('Weight');
            if(!ph) _km2.push('Photo');
            _kapChStatus=_km2.length?_km2:null;
          }
          challanDisplay=_kapChStatus==='none'
            ?'<span class="flash-red" style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px">⚠ No Challan / Weight / Photo</span>'
            :(!_kapChStatus)
              ?(challansArrKap.length
                ?challansArrKap.map(c2=>`<span style="font-size:11px;font-weight:700;background:var(--surface2);border:1px solid var(--border);padding:2px 5px;border-radius:5px;white-space:nowrap">📄 ${c2.no}${c2.weight?' · '+c2.weight+'kg':''}</span>`).join(' ')
                :`<span style="font-size:11px;font-weight:700;background:var(--surface2);border:1px solid var(--border);padding:2px 7px;border-radius:5px">📄 ${ch}${wt?' · '+wt+'kg':''}</span>`)
              :'<span class="flash-red" style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px">⚠ Missing: '+_kapChStatus.join(', ')+'</span>';
        }

        return `<div class="${_rowClass}" style="padding:5px 10px;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="width:20px;height:20px;border-radius:50%;background:${clr};color:#fff;font-size:10px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${lbl}</span>
            <span style="font-size:12px;font-weight:700">${lnameText(from)}</span>
            <span style="color:var(--accent);font-weight:900;font-size:13px">⟶</span>
            <span style="font-size:12px;font-weight:700">${lnameText(to)}</span>
            ${challanDisplay}
    
            ${ph?`<img src="${ph}" onclick="openPhoto(this.src)" style="width:22px;height:22px;object-fit:cover;border-radius:3px;border:1px solid var(--border2);cursor:pointer">`:''}
            <span style="margin-left:auto">${nextStepLabel}</span>
          </div>
        </div>`;
      }).join('');

      // Gate Exit blocked if missing challan, weight, or photo for this segment
      const _segIdx={'A':1,'B':2,'C':3}[seg.label]||1;
      const _tripForCh=byId(DB.trips,seg.tripId);
      const _chArr=_tripForCh?.['challans'+_segIdx]||[];
      const _hasChallanNo=(_chArr.some&&_chArr.some(x=>x.no&&x.no.trim()))||!!(_tripForCh?.['challan'+_segIdx]||'').trim();
      var _challanComplete=false;
      if(_chArr.length&&_chArr.some(x=>x.no&&x.no.trim())){
        _challanComplete=!_chArr.some(x=>!x.no||!x.no.trim()||!x.weight||!x.photo);
      } else if((_tripForCh?.['challan'+_segIdx]||'').trim()){
        _challanComplete=!!_tripForCh?.['weight'+_segIdx]&&!!_tripForCh?.['photo'+_segIdx];
      }
      const _gateExitBlocked=cs===1&&!_challanComplete;
      const pendId='kpend_'+sid;
      const vn=vnum(trip?.vehicleId);
      // Coloured location pills for route
      // Action location: where the guard needs to act
      const _actionLoc=_isStep5?seg.sLoc:cs===2?seg.dLoc:seg.sLoc;
      const routePills=allSegDests.map(([from,to,lbl,idx],i)=>{
        const lf=byId(DB.locations,from),lt=byId(DB.locations,to);
        const cf=lf?.colour||'var(--accent)',ct=lt?.colour||'var(--accent)';
        const _flashFrom=from===_actionLoc;
        const _flashTo=to===_actionLoc&&!_flashFrom;
        const _fromStyle=_flashFrom
          ?`background:${cf};color:${colourContrast(cf)};padding:2px 9px;border-radius:4px;font-size:13px;font-weight:700;white-space:nowrap;outline:2px solid #fff;animation:kapLocFlash 0.8s ease-in-out infinite alternate;box-shadow:0 0 0 2px ${cf}`
          :`${_locPillStyle(lf?.colour,13)}`;
        const _toStyle=_flashTo
          ?`background:${ct};color:${colourContrast(ct)};padding:2px 9px;border-radius:4px;font-size:13px;font-weight:700;white-space:nowrap;outline:2px solid #fff;animation:kapLocFlash 0.8s ease-in-out infinite alternate;box-shadow:0 0 0 2px ${ct}`
          :`${_locPillStyle(lt?.colour,13)}`;
        return (i===0
          ?`<span style="${_fromStyle}">${lf?.name||'?'}</span>`
          :'')
          +`<span style="color:var(--accent);font-weight:900;font-size:14px;margin:0 3px">⟶</span>`
          +`<span style="${_toStyle}">${lt?.name||'?'}</span>`;
      }).join('');

      const cardBorderClr=cs===1?'#dc2626':_isStep5?'#ea580c':'#16a34a';
      const actionBadge=_isStep5
        ?`<div style="padding:2px 10px 4px"><span style="display:inline-flex;align-items:center;gap:4px;background:#fff7ed;border:1.5px solid #fb923c;color:#c2410c;font-size:11px;font-weight:800;padding:3px 10px;border-radius:6px;animation:flashOrange 1.2s ease-in-out infinite">📤 Empty Vehicle Exit</span></div>`
        :cs===1
          ?`<div style="padding:2px 10px 4px"><span style="display:inline-flex;align-items:center;gap:4px;background:#fef2f2;border:1.5px solid #fca5a5;color:#dc2626;font-size:11px;font-weight:800;padding:3px 10px;border-radius:6px">🚪 Gate Exit — Seg ${seg.label}</span></div>`
          :`<div style="padding:2px 10px 4px"><span style="display:inline-flex;align-items:center;gap:4px;background:#f0fdf4;border:1.5px solid #86efac;color:#16a34a;font-size:11px;font-weight:800;padding:3px 10px;border-radius:6px">🏁 Gate Entry — Seg ${seg.label}</span></div>`;
      // Compact card meta
      const _bookedUser=byId(DB.users,trip?.bookedBy);
      const _bookedFirst=(_bookedUser?.fullName||_bookedUser?.name||'').split(' ')[0]||'';
      const _tripDate=trip?.date?new Date(trip.date):null;
      const _shortDate=_tripDate?_tripDate.getDate()+' '+ ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][_tripDate.getMonth()]:'';
      const _shortTime=_tripDate?String(_tripDate.getHours()).padStart(2,'0')+':'+String(_tripDate.getMinutes()).padStart(2,'0'):'';
      const _bookedLine=(_bookedFirst?`<span style="font-size:11px;color:var(--text2);font-weight:600">By: ${_bookedFirst}</span>`:'')
        +(_shortDate?`<span style="font-size:11px;color:var(--text3)">on ${_shortDate}, ${_shortTime}</span>`:'');
      // Challan summary across all segments for popup
      const _challanRows=allSegDests.map(([from,to,lbl,cidx])=>{
        const t2=trip;
        const ch=t2?.['challan'+cidx]||'';
        const wt=t2?.['weight'+cidx]||'';
        const arr=(t2?.['challans'+cidx]||[]);
        if(!arr.length&&!ch) return '';
        const items=arr.length?arr:ch?[{no:ch,weight:wt}]:[];
        const clr={A:'#35b0b6',B:'#14b8a6',C:'#8b5cf6'}[lbl]||'var(--accent)';
        return items.map(c=>`<span style="display:inline-flex;align-items:center;gap:4px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:3px 8px;white-space:nowrap">`
          +`<span style="width:14px;height:14px;border-radius:50%;background:${clr};color:#fff;font-size:8px;font-weight:900;display:inline-flex;align-items:center;justify-content:center">${lbl}</span>`
          +`<span style="font-size:12px;font-weight:700">📄 ${c.no}</span>`
          +(c.weight?`<span style="font-size:11px;color:var(--text3)">${c.weight} kg</span>`:'')
          +`</span>`).join('');
      }).filter(Boolean).join('');
      // Build popup id
      const popId='kap_pop_'+seg.id.replace(/[^a-z0-9]/gi,'_');
      return `<div style="margin-bottom:8px">
        <!-- COMPACT CARD — click opens popup -->
        <div style="padding:0;overflow:hidden;cursor:pointer;border:2px solid #000;border-radius:10px;transition:box-shadow .15s;background:#fff" onclick="_kapOpenPopup('${popId}')" onmouseover="this.style.boxShadow='0 4px 18px rgba(0,0,0,.12)'" onmouseout="this.style.boxShadow=''">
          <!-- Main row: Trip ID + Vehicle + action badge -->
          <div style="display:flex;align-items:center;gap:8px;padding:8px 12px 4px;flex-wrap:nowrap;min-width:0">
            <span style="font-family:var(--mono);font-size:21px;font-weight:900;color:#fff;background:var(--accent);padding:2px 10px;border-radius:8px;flex-shrink:0;white-space:nowrap">${_cTid(seg.tripId)}</span>
            ${vehBadge}
            <div style="flex:1;min-width:0"></div>
            <span style="font-size:18px;color:var(--text3);font-weight:300;flex-shrink:0">›</span>
          </div>
          <!-- Booked by + date row -->
          <div style="display:flex;align-items:center;gap:8px;padding:2px 12px 4px;flex-wrap:wrap">${_bookedLine}</div>
          <!-- Route row -->
          <div style="padding:0 12px 8px;display:flex;flex-wrap:wrap;gap:3px;align-items:center">${routePills}</div>
          ${_isStep5?'<div style="padding:0 12px 8px"><span style="display:inline-flex;align-items:center;gap:4px;background:#fff7ed;border:2px solid #fb923c;color:#c2410c;font-size:13px;font-weight:900;padding:4px 14px;border-radius:6px;animation:flashOrange 1.2s ease-in-out infinite">📤 EMPTY EXIT</span></div>':''}
        </div>

        <!-- POPUP OVERLAY -->
        <div id="${popId}" style="display:none;position:fixed;inset:0;z-index:100000;background:rgba(30,40,70,.55);align-items:center;justify-content:center;padding:12px" onclick="if(event.target===this)this.style.display='none'">
          <div style="background:#fff;border:2px solid #000;border-radius:16px;max-width:540px;width:100%;max-height:calc(100vh - 24px);overflow-y:auto;box-shadow:0 8px 48px rgba(0,0,0,.35)">
            <!-- Popup header -->
            <div style="padding:14px 16px 10px;border-bottom:1px solid var(--border);position:sticky;top:0;background:#fff;z-index:1;border-radius:16px 16px 0 0">
              <div style="display:flex;align-items:stretch;gap:10px">
                <!-- Stacked Trip ID + Vehicle -->
                <div style="display:flex;flex-direction:column;gap:8px;flex:1;min-width:0">
                  <span style="font-family:var(--mono);font-size:40px;font-weight:900;color:#fff;background:var(--accent);padding:4px 18px;border-radius:10px;display:block;line-height:1.2;text-align:center">${_cTid(seg.tripId)}</span>
                  <span style="font-family:var(--mono);font-size:clamp(22px,6vw,40px);font-weight:900;color:var(--text);background:#fef08a;border:2px solid #ca8a04;border-radius:10px;padding:4px 14px;display:block;white-space:nowrap;text-align:center">${hasVeh?vehNum:'No Vehicle'}</span>
                </div>
                <!-- Camera square button — fixed 110x110px square -->
                <div style="position:relative;flex-shrink:0;width:110px;height:110px">
                  <div id="thumbEmpty_${sid}" onclick="showThumbPicker('${sid}')" title="Capture Vehicle Photo" style="width:110px;height:110px;border-radius:12px;border:3px dashed var(--border2);display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:36px;cursor:pointer;background:var(--surface2);gap:4px">
                    📷<span style="font-size:11px;color:var(--text3);font-weight:600">Photo</span>
                  </div>
                  <img id="thumbImg_${sid}" style="display:none;position:absolute;inset:0;width:110px;height:110px;object-fit:cover;border-radius:12px;border:3px solid #16a34a;cursor:pointer" onclick="openPhoto(this.src)">
                  <button id="thumbClear_${sid}" onclick="clearInlinePhoto('${sid}')" style="display:none;position:absolute;top:-8px;right:-8px;background:#dc2626;color:#fff;border:none;border-radius:50%;width:24px;height:24px;font-size:14px;cursor:pointer;padding:0;line-height:1;z-index:1">×</button>
                  <div id="thumbPicker_${sid}" style="display:none;position:fixed;z-index:200000;background:var(--surface);border:1px solid var(--border2);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.2);padding:4px;min-width:140px">
                    <div onclick="openInlineCam('${sid}')" style="padding:8px 12px;cursor:pointer;font-size:13px;border-radius:6px;display:flex;align-items:center;gap:6px;margin-bottom:2px" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">📷 Camera</div>
                    <label style="padding:8px 12px;cursor:pointer;font-size:13px;border-radius:6px;display:flex;align-items:center;gap:6px;margin:0" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">🖼 File<input type="file" accept="${_photoAccept()}" capture="environment" style="display:none" onchange="onInlineFile(this,'${sid}')"></label>
                  </div>
                </div>
              </div>
              <!-- Cam preview box -->
              <div id="camBox_${sid}" style="display:none;flex-direction:column;gap:4px;margin-top:8px">
                <video id="vid_${sid}" autoplay playsinline style="width:100%;max-height:160px;border-radius:8px;border:1px solid var(--border2)"></video>
                <div style="display:flex;gap:6px">
                  <button class="btn btn-primary" onclick="snapInline('${sid}')" style="flex:1;font-size:13px;padding:7px">📸 Snap</button>
                  <button class="btn btn-secondary" onclick="stopInlineCam('${sid}')" style="flex:1;font-size:13px;padding:7px">✕ Close</button>
                </div>
              </div>
            </div>
            <!-- Route summary in popup -->
            ${_isStep5?'<div style="padding:8px 16px 0"><span style="display:inline-flex;align-items:center;gap:4px;background:#fff7ed;border:2px solid #fb923c;color:#c2410c;font-size:15px;font-weight:900;padding:5px 18px;border-radius:8px;animation:flashOrange 1.2s ease-in-out infinite">📤 EMPTY VEHICLE EXIT</span></div>':''}
            <div style="padding:8px 16px 4px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:16px">${routePills}</div>
            <div style="padding:4px 16px 6px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:16px">${_bookedLine}</div>
            ${_challanRows?`<div style="padding:0 16px 10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:15px">${_challanRows}</div>`:""}
            <!-- Action row -->
            <div style="padding:10px 14px 14px;border-top:2px solid var(--accent)" onclick="event.stopPropagation()">
              <canvas id="cnv_${sid}" style="display:none"></canvas>
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                ${(()=>{
                  const _noVeh=!hasVeh;
                  const _noCh=_gateExitBlocked;
                  var _chWarn='Challan / Weight / Photo';
                  if(_hasChallanNo&&!_challanComplete){
                    var _mf=[];
                    if(_chArr.length){
                      if(_chArr.some(x=>!x.weight))_mf.push('Weight');
                      if(_chArr.some(x=>!x.photo))_mf.push('Photo');
                    } else {
                      if(!_tripForCh?.['weight'+_segIdx])_mf.push('Weight');
                      if(!_tripForCh?.['photo'+_segIdx])_mf.push('Photo');
                    }
                    _chWarn=_mf.join(' & ');
                  }
                  const _warn=cs===1&&(_noVeh||_noCh)
                    ?`<div style="width:100%;text-align:center;margin-top:4px"><span class="flash-red" style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:5px">⚠ ${_noVeh&&_noCh?'Add Vehicle & '+_chWarn:_noVeh?'Add Vehicle':'Add '+_chWarn} before Gate Exit</span></div>`
                    :'';
                  const _btn=_gateExitBlocked
                    ?`<button class="btn btn-danger" disabled style="height:52px;flex:1;font-size:14px;font-weight:800;opacity:.4;cursor:not-allowed;white-space:nowrap">${btnLabel}</button>`
                    :`<button class="btn ${btnCls}" onclick="doKapInline('${seg.id}',${_isStep5?5:cs})" style="height:52px;flex:1;font-size:14px;font-weight:800;white-space:nowrap">${btnLabel}</button>`;
                  const _closeBtn=`<button onclick="_kapClosePopup('${popId}')" style="height:52px;width:52px;flex-shrink:0;font-size:22px;font-weight:900;background:var(--surface2);border:2px solid var(--border2);border-radius:8px;cursor:pointer;color:var(--text2);display:flex;align-items:center;justify-content:center" title="Close">✕</button>`;
                  return _btn+_closeBtn+_warn;
                })()}
              </div>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
  } else {
    pendingHtml=`<div class="empty-state" style="padding:16px 0">No pending ${step===1?'Gate Exit':'Gate Entry'} actions</div>`;
  }
  // Restore popup if one was open before re-render
  setTimeout(()=>_kapRestorePopup(_savedPop),0);
  // Route pending content to the correct tab section
  const _pendingTarget=_kapMode==='entry'?'kapEntryContent':'kapExitContent';
  const _pendingEl=document.getElementById(_pendingTarget);
  if(_pendingEl) _pendingEl.innerHTML=pendingHtml;

  // ── History section for this step ──
  let histSegs=DB.segments.filter(s=>{
    const st=s.steps[step];
    if(!st||!st.done||st.skip)return false;
    if(isSA) return true;
    // For exit history: only show if user is kapSec at START location
    // For entry history: only show if user is kapSec at DEST location
    const loc=step===1?byId(DB.locations,s.sLoc):byId(DB.locations,s.dLoc);
    return loc?.kapSec===CU.id || st.by===CU.id; // also show if user performed the action
  });
  if(!srch&&fromVal)histSegs=histSegs.filter(s=>(s.date||'').slice(0,10)>=fromVal);
  if(!srch&&toVal)histSegs=histSegs.filter(s=>(s.date||'').slice(0,10)<=toVal);
  if(srch)histSegs=histSegs.filter(s=>s.tripId.toLowerCase().includes(srch)||vnum(byId(DB.trips,s.tripId)?.vehicleId).toLowerCase().includes(srch));
  histSegs.sort((a,b)=>{
    const ta=a.steps[step]?.time?new Date(a.steps[step].time).getTime():0;
    const tb=b.steps[step]?.time?new Date(b.steps[step].time).getTime():0;
    return tb-ta;
  });

  let histHtml='';
  if(histSegs.length){
    const fmt=t=>t?new Date(t).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true}):'—';
    const stepLabel=step===1?'Gate Exit':'Gate Entry';
    const stepIcon=step===1?'🚪':'🏁';
    const clr=step===1?'#dc2626':'#16a34a';
    histHtml+=`<div>
      <div style="margin-top:20px;padding-top:16px;border-top:2px solid var(--border);font-size:11px;font-weight:700;color:var(--text3);letter-spacing:.5px;text-transform:uppercase;margin-bottom:8px">📋 ${stepLabel} History (${histSegs.length})</div>`;
    histHtml+=histSegs.map(seg=>{
      const trip=byId(DB.trips,seg.tripId);
      const drv=byId(DB.drivers,trip?.driverId);
      const st=seg.steps[step];
      const byUser=byId(DB.users,st.by);
      const byName=byUser?.fullName||byUser?.name||'—';
      const isMine=st.by===CU.id;
      const tripApproved=seg.steps[4]?.done;
      const nextStepNum=step===1?2:3;
      const canRevoke=!tripApproved&&st.done&&!seg.steps[nextStepNum]?.done&&!seg.steps[3]?.done;
      const myStyle=isMine?'background:rgba(42,154,160,.06)':'background:rgba(0,0,0,.02)';
      const actionLoc=step===1?seg.sLoc:seg.dLoc;
      const actionLabel=step===1?`Exited from ${lname(seg.sLoc)}`:`Entered at ${lname(seg.dLoc)}`;
      const hid='khist_'+seg.id.replace(/[^a-zA-Z0-9]/g,'_');

      // Build all split segment rows with challan
      const allSegDests=[[trip?.startLoc,trip?.dest1,'A',1]];
      if(trip?.dest2)allSegDests.push([trip.dest1,trip.dest2,'B',2]);
      if(trip?.dest3)allSegDests.push([trip.dest2,trip.dest3,'C',3]);

      const splitRows=allSegDests.map(([from,to,lbl,idx])=>{
        const _seg=DB.segments.find(ss=>ss.tripId===seg.tripId&&ss.label===lbl);
        const ch=trip?.['challan'+idx]||'';
        const wt=trip?.['weight'+idx]||'';
        const ph=trip?.['photo'+idx];
        const _chArr=trip?.['challans'+idx]||[];
        const _isActive=lbl===seg.label;
        const clr={A:'#35b0b6',B:'#14b8a6',C:'#8b5cf6'}[lbl]||'var(--accent)';
        let segStatus='';
        if(_seg){
          if(_seg.status==='Completed') segStatus='<span class="badge badge-green" style="font-size:9px">✓ Done</span>';
          else if(_seg.status==='Locked') segStatus='<span style="font-size:10px;color:var(--text3)">🔒</span>';
          else if(_seg.status==='Rejected') segStatus='<span class="badge badge-red" style="font-size:9px">⚠</span>';
          else{
            const sn={1:'Gate Exit',2:'Gate Entry',3:'Mat.Rcpt',4:'Trip Approval',5:'Empty Exit'};
            const si={1:'🚪',2:'🏁',3:'📦',4:'✅'};
            segStatus=`<span class="flash-green" style="font-size:10px">${si[_seg.currentStep]||''} ${sn[_seg.currentStep]||''}</span>`;
          }
        }
        // Check completeness of challan info — suppress for in-progress/completed segments
        const _histSegStarted=_seg&&(_seg.steps[1]?.done||_seg.status==='Completed');
        var _histChDisplay='';
        if(_histSegStarted){
          // In-progress/completed: just show info, no warnings
          _histChDisplay=_chArr.length
            ?_chArr.map(c2=>'<span style="font-size:10px;font-weight:700;background:#f0fafa;border:1px solid #b3dfe0;padding:1px 5px;border-radius:3px;color:#1d6f73;margin-left:2px">📄 '+c2.no+(c2.weight?' · '+c2.weight+'kg':'')+'</span>').join(' ')
            :(ch?'<span style="font-size:10px;font-weight:700;background:#f0fafa;border:1px solid #b3dfe0;padding:1px 5px;border-radius:3px;color:#1d6f73;margin-left:4px">📄 '+ch+(wt?' · '+wt+'kg':'')+'</span>':'');
        } else {
          var _histMissing=[];
          if(_chArr.length){
            if(_chArr.some(c=>!c.no||!c.no.trim())) _histMissing.push('Challan');
            if(_chArr.some(c=>!c.weight)) _histMissing.push('Weight');
            if(_chArr.some(c=>!c.photo)) _histMissing.push('Photo');
          } else if(!ch){_histMissing=['Challan','Weight','Photo'];}
          else {if(!wt) _histMissing.push('Weight');if(!ph) _histMissing.push('Photo');}
          _histChDisplay=_histMissing.length
            ?'<span class="flash-red" style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;margin-left:4px">⚠ Missing: '+_histMissing.join(', ')+'</span>'
            :(_chArr.length
              ?_chArr.map(c2=>'<span style="font-size:10px;font-weight:700;background:#f0fafa;border:1px solid #b3dfe0;padding:1px 5px;border-radius:3px;color:#1d6f73;margin-left:2px">📄 '+c2.no+(c2.weight?' · '+c2.weight+'kg':'')+'</span>').join(' ')
              :'<span style="font-size:10px;font-weight:700;background:#f0fafa;border:1px solid #b3dfe0;padding:1px 5px;border-radius:3px;color:#1d6f73;margin-left:4px">📄 '+ch+(wt?' · '+wt+'kg':'')+'</span>');
        }
        const rowBg=_isActive?'background:rgba(42,154,160,.07);':'';
        return `<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--border);${rowBg}flex-wrap:wrap">
          <span style="width:18px;height:18px;border-radius:50%;background:${clr};color:#fff;font-size:9px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${lbl}</span>
          <span style="font-size:11px;font-weight:600">${lnameText(from)}</span>
          <span style="color:var(--accent);font-weight:900;font-size:11px">⟶</span>
          <span style="font-size:11px;font-weight:600">${lnameText(to)}</span>
          ${_histChDisplay}
          <span style="margin-left:auto">${segStatus}</span>
        </div>`;
      }).join('');

      // Coloured route pills for history card
      const histRoutePills=allSegDests.map(([from,to,lbl,idx],i)=>{
        const lf=byId(DB.locations,from),lt=byId(DB.locations,to);
        const cf=lf?.colour||'var(--accent)',ct=lt?.colour||'var(--accent)';
        return (i===0
          ?`<span style="${_locPillStyle(lf?.colour,13)}">${lf?.name||'?'}</span>`
          :'')
          +`<span style="color:var(--accent);font-weight:900;font-size:14px;margin:0 3px">⟶</span>`
          +`<span style="${_locPillStyle(lt?.colour,13)}">${lt?.name||'?'}</span>`;
      }).join('');

      return `<div class="seg-card" style="padding:0;overflow:hidden;cursor:pointer;border:none;${myStyle};position:relative;padding-left:26px" onclick="toggleKapHistCard('${hid}')"><div style="position:absolute;left:0;top:0;bottom:0;width:26px;background:rgba(0,0,0,0.28);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;color:#fff;user-select:none">${histSegs.length-histSegs.indexOf(seg)}</div>
        <!-- Line 1: Trip ID + Vehicle -->
        <div style="display:flex;align-items:center;gap:6px;padding:7px 10px 3px;min-width:0">
          <span style="font-family:var(--mono);font-size:20px;font-weight:800;color:#fff;background:var(--accent);padding:3px 9px;border-radius:6px;flex-shrink:0;letter-spacing:.4px">${_cTid(trip?.id||seg.tripId)}</span>
          <span style="font-family:var(--mono);font-size:20px;font-weight:800;color:var(--text);background:#fef08a;border:1.5px solid #ca8a04;border-radius:6px;padding:2px 8px;flex-shrink:0">${vnum(trip?.vehicleId)}</span>
        </div>
        <!-- Line 2: Coloured route pills -->
        <div style="padding:2px 10px 8px;display:flex;flex-wrap:wrap;gap:3px;align-items:center">${histRoutePills}</div>
        <!-- Expanded details -->
        <div id="${hid}" style="display:none;border-top:1px solid var(--border)" onclick="event.stopPropagation()">
          ${splitRows}
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 10px;border-top:1px solid var(--border)">
            <span style="font-size:10px;color:var(--text3)">${stepIcon} ${fmt(st.time)} &nbsp;·&nbsp; by <strong${isMine?' style="color:var(--accent)"':''}>${byName}${isMine?' (You)':''}</strong></span>
            ${st.remarks?`<span style="font-size:10px;color:var(--text2)">💬 ${st.remarks}</span>`:''}
            ${st.photo?`<img src="${st.photo}" onclick="openPhoto(this.src)" style="width:28px;height:28px;object-fit:cover;border-radius:4px;border:2px solid ${clr};cursor:pointer">`:''}
            ${canRevoke&&(isSA||isMine)?`<button class="kap-revoke-btn" style="font-size:10px;padding:1px 6px;margin-left:auto" onclick="revokeKapStep('${seg.id}',${step})">↩ Revoke</button>`:''}
          </div>
        </div>
      </div>`;
    }).join('');
    histHtml+='</div>';
  } else {
    histHtml=`<div><div class="empty-state">No ${step===1?'Gate Exit':'Gate Entry'} history in selected period</div></div>`;
  }
  const _histTarget=_kapMode==='entry'?'kapEntryHistoryContent':'kapExitHistoryContent';
  const _histEl=document.getElementById(_histTarget);
  if(_histEl) _histEl.innerHTML=histHtml;
}

let _kapActiveTab=1; // kept for legacy; use _kapMode for primary routing
const _inlineStreams={};
const _inlinePhotos={};

function toggleKapHistCard(hid){
  const el=document.getElementById(hid);if(!el)return;
  const isOpen=el.style.display!=='none';
  el.style.display=isOpen?'none':'block';
}

// ═══ SPOT VEHICLE ENTRY ═════════════════════════════════════════════════
function renderSpotTab(){
  updBadges();
  initDfMonth('spotHist','spotHistFrom','spotHistTo');
  renderSpotHistory();
}

function onSpotPhoto(input, thumbId){
  const f=input.files[0];if(!f)return;
  const fileInputId=input.id;
  const reader=new FileReader();
  reader.onload=e=>{
    const dataUrl=e.target.result;
    input._compressedData=dataUrl;
    const thumb=document.getElementById(thumbId);
    if(thumb){
      const parent=thumb.parentElement;
      if(parent){parent.style.position='relative';parent.style.overflow='visible';}
      thumb.innerHTML='';thumb.style.border='2px solid var(--green)';
      const img=document.createElement('img');
      img.src=dataUrl;img.style.cssText='width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in';
      // Clicking the img opens lightbox only — stopPropagation prevents file picker opening
      img.onclick=ev=>{ev.stopPropagation();openPhoto(input._compressedData||dataUrl);};
      thumb.appendChild(img);
      // Thumb div onclick → also open lightbox (clicking border area)
      thumb.onclick=ev=>{ev.stopPropagation();openPhoto(input._compressedData||dataUrl);};
      // Add × remove button at top-right corner
      const existingX=parent?.querySelector('.spot-photo-clear');
      if(existingX) existingX.remove();
      if(parent){
        const xBtn=document.createElement('button');
        xBtn.className='spot-photo-clear';
        xBtn.textContent='×';
        xBtn.style.cssText='position:absolute;top:-7px;right:-7px;background:#dc2626;color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:13px;cursor:pointer;padding:0;line-height:1;z-index:10;display:flex;align-items:center;justify-content:center';
        xBtn.onclick=ev=>{
          ev.stopPropagation();
          input.value='';input._compressedData=null;
          xBtn.remove();
          const icons={'spotVehThumb':'🚗','spotDriverThumb':'🧑','spotExitVehThumb':'🚗','spotExitPhotoThumb':'🚗'};
          thumb.innerHTML=icons[thumbId]||'📄';
          thumb.style.border='2px dashed var(--border2)';
          // Restore: clicking thumb opens file picker again
          thumb.onclick=()=>_showPhotoChoice(fileInputId,thumbId);
        };
        parent.appendChild(xBtn);
      }
    }
    compressImage(f).then(c=>{input._compressedData=c;}).catch(()=>{});
  };
  reader.readAsDataURL(f);
}

function clearSpotForm(){
  ['spotVehNum','spotSupplier','spotChallan','spotDriverName','spotDriverMob','spotEntryRemarks'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.value='';
  });
  ['spotChallanFile','spotDriverFile','spotVehFile'].forEach(id=>{
    const el=document.getElementById(id);if(el){el.value='';el._compressedData=null;}
  });
  const resetThumb=(id,icon)=>{const t=document.getElementById(id);if(t){t.innerHTML=icon;t.style.border='2px dashed var(--border2)';}};
  resetThumb('spotChallanThumb','📄');
  resetThumb('spotDriverThumb','🧑');
  resetThumb('spotVehThumb','🚗');
}

async function submitSpotEntry(){
  const vehNum=document.getElementById('spotVehNum').value.trim().toUpperCase();
  const driverMob=document.getElementById('spotDriverMob').value.trim();
  if(!vehNum){notify('Vehicle number is required',true);return;}
  if(driverMob&&driverMob.length!==10){notify('Driver mobile must be 10 digits',true);return;}
  // Edit mode?
  const editId=document.getElementById('spotEditId').value;
  if(editId){
    const s=(DB.spotTrips||[]).find(x=>x&&x.id===editId);
    if(s){
      const _sBak={...s};
      s.vehicleNum=vehNum;
      s.driverName=document.getElementById('spotDriverName').value.trim();
      s.driverMobile=driverMob;
      s.supplier=document.getElementById('spotSupplier').value.trim();
      const _sChs=_spotGetChallans();s.challans=_sChs;s.challan=_sChs[0]?.no||'';s.challanPhoto=_sChs[0]?.photo||'';
      s.entryRemarks=document.getElementById('spotEntryRemarks').value.trim();
      if(document.getElementById('spotVehFile')?._compressedData) s.entryVehiclePhoto=document.getElementById('spotVehFile')._compressedData;
      if(document.getElementById('spotChallanFile')?._compressedData) s.challanPhoto=document.getElementById('spotChallanFile')._compressedData;
      if(document.getElementById('spotDriverFile')?._compressedData) s.driverPhoto=document.getElementById('spotDriverFile')._compressedData;
      if(!await _dbSave('spotTrips',s)){ Object.assign(s,_sBak); return; }
      cancelSpotEdit();notify('Spot entry updated!');renderSpotTab();renderDash();updBadges();
    }
    return;
  }
  // New entry
  const vehPhoto=document.getElementById('spotVehFile')?._compressedData||'';
  if(!vehPhoto){notify('📷 Vehicle photo is mandatory for Spot Entry',true);return;}
  const now=new Date();
  const _yearLastDigit=now.getFullYear().toString().slice(-1);
  const _spotLoc=byId(DB.locations,CU.plant||myLoc);
  const _plant=(()=>{
    if(!_spotLoc) return CU.plant||'P';
    const name=_spotLoc.name;
    // Extract trailing number: 'KAP-1'→'P1', 'KAP-6'→'P6', 'Plant-2'→'P2'
    const numMatch=name.match(/(\d+)$/);
    if(numMatch) return 'P'+numMatch[1];
    // Fallback: first letter of each word
    return name.split(/[\s-]+/).map(w=>w[0]?.toUpperCase()||'').join('').slice(0,4)||'P';
  })();
  const _sePrefix=_yearLastDigit+'S-'+_plant+'-';
  const _existing=(DB.spotTrips||[]).map(s=>{
    if(!s.id||!s.id.startsWith(_sePrefix)) return 0;
    return parseInt(s.id.slice(_sePrefix.length))||0;
  });
  const _serial=_existing.length?Math.max(..._existing)+1:1;
  const spotId=_sePrefix+_serial;
  if(!DB.spotTrips) DB.spotTrips=[];
  const myLoc=CU.plant||'';
  const _newSpot={
    id:spotId,vehicleNum:vehNum,
    supplier:document.getElementById('spotSupplier').value.trim(),
    challans:_spotGetChallans(),
    challan:(_spotGetChallans()[0]?.no||''),
    challanPhoto:(_spotGetChallans()[0]?.photo||''),
    driverName:document.getElementById('spotDriverName').value.trim(),
    driverMobile:driverMob,
    driverPhoto:document.getElementById('spotDriverFile')?._compressedData||'',
    entryVehiclePhoto:vehPhoto,
    entryRemarks:document.getElementById('spotEntryRemarks').value.trim(),
    date:now.toISOString().split('T')[0],
    entryTime:now.toISOString(),entryBy:CU.id,location:myLoc,
    exitTime:null,exitBy:null,exitVehiclePhoto:'',exitRemarks:''
  };
  if(!await _dbSave('spotTrips',_newSpot)) return;
  clearSpotForm();
  _kapCloseSpotPopup();
  notify(`Spot vehicle entry ${spotId} recorded!`);
  renderSpotTab();renderSpotHistory();renderDash();updBadges();
}

function cancelSpotEdit(){
  document.getElementById('spotEditId').value='';
  document.getElementById('spotSubmitBtn').textContent='🏁 Record Entry';
  document.getElementById('spotSubmitBtn').className='btn btn-green';
  document.getElementById('spotCancelEditBtn').style.display='none';
  clearSpotForm();
  _kapCloseSpotPopup();
}

async function doSpotExit(){
  const spotId=document.getElementById('spotExitId').value;
  if(!spotId){notify('No spot trip selected',true);return;}
  const exitPhoto=document.getElementById('spotExitVehFile')?._compressedData||'';
  if(!exitPhoto){notify('📷 Vehicle exit photo is mandatory',true);return;}
  const s=(DB.spotTrips||[]).find(x=>x&&x.id===spotId);
  if(!s){notify('Spot trip not found',true);return;}
  const _sBak={...s};
  s.exitTime=new Date().toISOString();
  s.exitBy=CU.id;
  s.exitVehiclePhoto=exitPhoto;
  s.exitRemarks=document.getElementById('spotExitRemarks').value.trim();
  if(!await _dbSave('spotTrips',s)){Object.assign(s,_sBak);return;}
  _kapCloseSpotPopup();
  notify(`${spotId} — vehicle exit recorded!`);
  renderSpotTab();renderSpotHistory();renderDash();updBadges();
}
async function doSpotExitModal(){
  const spotId=document.getElementById('spotExitId').value;
  const exitPhoto=document.getElementById('spotExitPhotoFile')?._compressedData||'';
  if(!exitPhoto){modalErr('mSpotExit','Capture vehicle exit photo');return;}
  const s=(DB.spotTrips||[]).find(x=>x&&x.id===spotId);
  if(!s){modalErr('mSpotExit','Spot trip not found');return;}
  const _sBak={...s};
  s.exitTime=new Date().toISOString();
  s.exitBy=CU.id;
  s.exitVehiclePhoto=exitPhoto;
  s.exitRemarks=document.getElementById('spotExitRemarks').value.trim();
  if(!await _dbSave('spotTrips',s)){ Object.assign(s,_sBak); return; }
  cm('mSpotExit');
  notify(`${spotId} — vehicle exit recorded!`);
  renderSpotTab();renderDash();updBadges();
}

async function _spotRevokeExit(spotId){
  const s=(DB.spotTrips||[]).find(x=>x&&x.id===spotId);if(!s||!s.exitTime)return;
  const exitAge=(Date.now()-new Date(s.exitTime))/1000/3600;
  if(exitAge>2){notify('Cannot revoke — exit was recorded more than 2 hours ago',true);return;}
  showConfirm('Revoke exit for '+spotId+'? Vehicle will be marked as still inside.',async()=>{
    const bak={...s};
    s.exitTime=null;s.exitBy=null;s.exitVehiclePhoto='';s.exitRemarks='';
    if(!await _dbSave('spotTrips',s)){Object.assign(s,bak);return;}
    _kapCloseSpotPopup();
    notify('Exit for '+spotId+' revoked — vehicle marked as inside.');
    renderSpotTab();renderSpotHistory();renderDash();updBadges();
  },{icon:'↩',title:'Revoke Exit',btnLabel:'↩ Revoke',btnColor:'#f59e0b'});
}

function renderSpotHistory(){
  const list=document.getElementById('spotHistoryList');
  if(!list)return;
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');
  const isSuperAdmin=CU.roles.includes('Super Admin');
  const myLocId=CU.plant||'';
  const myLoc=byId(DB.locations,myLocId);

  const spots=[...(DB.spotTrips||[])].sort((a,b)=>(b.entryTime||'').localeCompare(a.entryTime||''));
  // Init spot history date range if not set (default: today)
  const _shf=document.getElementById('spotHistFrom');const _sht=document.getElementById('spotHistTo');
  if(_shf&&!_shf.value){const _n=new Date();const _td=_n.getFullYear()+'-'+String(_n.getMonth()+1).padStart(2,'0')+'-'+String(_n.getDate()).padStart(2,'0');_shf.value=_td;updDateBtnLbl('spotHistFrom');_sht.value=_td;updDateBtnLbl('spotHistTo');}
  const _fromV=_shf?.value||'';const _toV=_sht?.value||'';
  const d30=new Date();d30.setDate(d30.getDate()-30);
  const filtered=spots.filter(s=>{
    if(!isSuperAdmin&&new Date(s.date)<d30) return false;
    if(!isSA&&!_isMyLocation(s.location)) return false;
    const sDate=(s.entryTime||s.date||'').slice(0,10);
    if(_fromV&&sDate<_fromV) return false;
    if(_toV&&sDate>_toV) return false;
    return true;
  });

  if(!filtered.length){
    list.innerHTML='<div class="empty-state">No spot entries in the last 30 days'+(myLoc?` for ${myLoc.name}`:'')+'</div>';
    return;
  }
  const now=new Date();
  const hrs24=24*60*60*1000;
  const fmt=t=>t?new Date(t).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true}):'—';
  list.innerHTML=filtered.map(s=>{
    const isInside=!s.exitTime;
    const isAutoExited=!isInside&&(s.exitRemarks||'').indexOf('Auto-exit')>=0;
    const _entryTs2=s.entryTime?new Date(s.entryTime).getTime():(s.date?new Date(s.date+'T00:00:00').getTime():0);
    const isStaleCard=isInside&&_entryTs2>0&&(now.getTime()-_entryTs2)>48*3600000;
    const fmt=t=>t?new Date(t).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true}):'—';
    const borderClr=isStaleCard?'#94a3b8':(isInside?'#dc2626':(isAutoExited?'#f59e0b':'#16a34a'));
    const statusDot=isStaleCard?'🔒':(isInside?'🔴':(isAutoExited?'🟡':'🟢'));
    return `<div style="padding:0;overflow:hidden;cursor:pointer;border:2px solid #000;border-radius:10px;margin-bottom:8px;transition:box-shadow .15s;background:#fff" onclick="_kapOpenSpotPopup('${s.id}')" onmouseover="this.style.boxShadow='0 4px 18px rgba(0,0,0,.12)'" onmouseout="this.style.boxShadow=''">
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px 4px;min-width:0;flex-wrap:nowrap">
        <span style="font-size:16px;flex-shrink:0">${statusDot}</span>
        <span style="font-family:var(--mono);font-size:21px;font-weight:900;color:#fff;background:var(--accent);padding:2px 10px;border-radius:8px;flex-shrink:0;white-space:nowrap">${s.id}</span>
        <span style="font-family:var(--mono);font-size:clamp(18px,5vw,35px);font-weight:900;color:${isInside?'#dc2626':'var(--text)'};background:${isInside?'rgba(239,68,68,.08)':'#fef08a'};border:2px solid ${isInside?'#fca5a5':'#ca8a04'};border-radius:8px;padding:2px 10px;flex-shrink:0;white-space:nowrap">${s.vehicleNum}</span>
        <div style="flex:1"></div>
        <span style="font-size:18px;color:var(--text3);font-weight:300;flex-shrink:0">›</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;padding:2px 12px 8px;flex-wrap:wrap;font-size:11px">
        ${s.challan?`<span style="background:#f0fafa;border:1px solid #b3dfe0;padding:1px 6px;border-radius:4px;color:#1d6f73;font-weight:700">📄 ${s.challan}</span>`:''}
        ${s.driverName?`<span style="color:var(--text2);font-weight:600">🧑 ${s.driverName}</span>`:''}
        ${s.supplier?`<span style="color:var(--text3)">· ${s.supplier}</span>`:''}
        ${isAutoExited?'<span style="background:#fef3c7;color:#92400e;border:1px solid #fde047;padding:1px 6px;border-radius:4px;font-weight:800;font-size:10px">Auto Exited</span>':(isStaleCard?'<span style="background:#f1f5f9;color:#64748b;border:1px solid #cbd5e1;padding:1px 6px;border-radius:4px;font-weight:800;font-size:10px">Locked</span>':'')}
        <span style="color:var(--text3);margin-left:auto;white-space:nowrap">${fmt(s.entryTime)}</span>
        ${isSuperAdmin?`<button onclick="event.stopPropagation();deleteSpotEntry('${s.id}')" style="background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;border-radius:5px;font-size:11px;padding:2px 7px;cursor:pointer;font-weight:700;flex-shrink:0">🗑</button>`:''}
      </div>
    </div>`;
  }).join('');
}

async function saveSpotEdit(){
  const id=document.getElementById('seEditId').value;
  const s=(DB.spotTrips||[]).find(x=>x&&x.id===id);if(!s){modalErr('mSpotEdit','Entry not found');return;}
  const vn=document.getElementById('seVehNum').value.trim().toUpperCase();
  if(!vn){modalErr('mSpotEdit','Vehicle number is required');return;}
  const mob=document.getElementById('seDriverMob').value.trim();
  if(mob&&mob.length!==10){modalErr('mSpotEdit','Mobile must be 10 digits');return;}
  const _sBak={...s};
  s.vehicleNum=vn;
  s.driverName=document.getElementById('seDriverName').value.trim();
  s.driverMobile=mob;
  s.supplier=document.getElementById('seSupplier').value.trim();
  s.challan=document.getElementById('seChallan').value.trim();
  s.entryRemarks=document.getElementById('seRemarks').value.trim();
  if(!await _dbSave('spotTrips',s)){ Object.assign(s,_sBak); return; }
  cm('mSpotEdit');renderSpotHistory();notify('Spot entry updated!');
}
async function deleteSpotEntry(id){
  if(!CU||!CU.roles.includes('Super Admin')) return;
  showConfirm('Delete spot entry '+id+'? This cannot be undone.',async ()=>{
    if(!await _dbDel('spotTrips',id)) return;
    renderSpotTab();renderDash();updBadges();notify('Spot entry deleted.');
  });
}

function initHistDates(fromId, toId, grpId){
  const now=new Date();
  const pad=n=>String(n).padStart(2,'0');
  // Default to this month
  const from=`${now.getFullYear()}-${pad(now.getMonth()+1)}-01`;
  const last=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  const to=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(last)}`;
  const fe=document.getElementById(fromId);const te=document.getElementById(toId);
  if(fe&&!fe.value){fe.value=from;updDateBtnLbl(fromId);}
  if(te&&!te.value){te.value=to;updDateBtnLbl(toId);}
  if(grpId)setTimeout(()=>updDrBtns(grpId,fromId,toId),50);
}

async function revokeKapStep(segId,stepNum){
  const seg=byId(DB.segments,segId);if(!seg)return;
  const st=seg.steps[stepNum];
  if(!st?.done)return;
  // Double-check: block revoke if material receipt already done
  if(seg.steps[3]?.done){notify('Cannot revoke — Material Receipt already done',true);return;}
  if(stepNum===1 && seg.steps[2]?.done){notify('Cannot revoke — Gate Entry already recorded',true);return;}
  // Also re-lock next segment if step 1+2 were done and we're revoking step 2
  let _nextSegToSave=null;
  if(stepNum===2){
    const nextLabel={A:'B',B:'C'}[seg.label];
    if(nextLabel){
      const next=DB.segments.find(s=>s.tripId===seg.tripId&&s.label===nextLabel);
      if(next&&next.status==='Active'&&next.currentStep===1&&!next.steps[1]?.done){
        next.status='Locked';
        _nextSegToSave=next;
      }
    }
  }
  st.done=false;st.time=null;st.by=null;st.remarks='';st.photo=null;
  seg.currentStep=nextStep(seg);
  if(seg.status==='Completed')seg.status='Active';
  await _dbSave('segments',seg);
  if(_nextSegToSave) _dbSave('segments',_nextSegToSave).catch(e=>console.warn('revokeKapStep next seg save:',e));
  renderKap();renderDash();updBadges();
  notify(`Step ${stepNum===1?'Gate Exit':'Gate Entry'} revoked for ${segId}`);
}

function openInlineCam(sid){
  const picker=document.getElementById('thumbPicker_'+sid);if(picker)picker.style.display='none';
  _openCamStream({video:{facingMode:{ideal:'environment'}}}).then(stream=>{
    if(!stream)return;
    _inlineStreams[sid]=stream;
    const v=document.getElementById('vid_'+sid);
    if(v)v.srcObject=stream;
    document.getElementById('camBox_'+sid).style.display='flex';
  });
}
function stopInlineCam(sid){
  const s=_inlineStreams[sid];
  if(s)s.getTracks().forEach(t=>t.stop());
  delete _inlineStreams[sid];
  document.getElementById('camBox_'+sid).style.display='none';
  document.getElementById('photoBtns_'+sid).style.display='flex';
}
function snapInline(sid){
  const v=document.getElementById('vid_'+sid);
  const c=document.getElementById('cnv_'+sid);
  if(!v||!c)return;
  c.width=v.videoWidth;c.height=v.videoHeight;
  c.getContext('2d').drawImage(v,0,0);
  _inlinePhotos[sid]=c.toDataURL('image/jpeg',0.82);
  stopInlineCam(sid);
  showInlinePreview(sid);
  // Compress to <200KB in background
  c.toBlob(blob=>{
    if(!blob)return;
    compressImage(new File([blob],'snap.jpg',{type:'image/jpeg'}))
      .then(comp=>{_inlinePhotos[sid]=comp;})
      .catch(()=>{});
  },'image/jpeg',0.82);
}
function onInlineFile(input,sid){
  const f=input.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=e=>{
    _inlinePhotos[sid]=e.target.result; // set immediately for preview
    showInlinePreview(sid);
    compressImage(f).then(c=>{_inlinePhotos[sid]=c;}).catch(()=>{});
  };
  r.readAsDataURL(f);
}
function showThumbPicker(sid){
  // Close any other open pickers
  document.querySelectorAll('[id^="thumbPicker_"]').forEach(el=>el.style.display='none');
  // Find the file input inside the picker div
  const picker=document.getElementById('thumbPicker_'+sid);
  const fileInp=picker?.querySelector('input[type="file"]');
  if(!fileInp) return;
  if(_isMobileOrTablet()){
    // Mobile/Tablet: open native device camera directly
    fileInp.setAttribute('capture','environment');
    fileInp.click();
  } else {
    // Desktop: open file picker
    fileInp.removeAttribute('capture');
    fileInp.click();
  }
}
function showInlinePreview(sid){
  const img=document.getElementById('thumbImg_'+sid);
  if(img){img.src=_inlinePhotos[sid];img.style.display='block';}
  const empty=document.getElementById('thumbEmpty_'+sid);
  if(empty)empty.style.display='none';
  const clear=document.getElementById('thumbClear_'+sid);
  if(clear)clear.style.display='block';
  const picker=document.getElementById('thumbPicker_'+sid);
  if(picker)picker.style.display='none';
  // hide cam box
  document.getElementById('camBox_'+sid).style.display='none';
}
function clearInlinePhoto(sid){
  delete _inlinePhotos[sid];
  const img=document.getElementById('thumbImg_'+sid);if(img){img.src='';img.style.display='none';}
  const empty=document.getElementById('thumbEmpty_'+sid);if(empty)empty.style.display='flex';
  const clear=document.getElementById('thumbClear_'+sid);if(clear)clear.style.display='none';
}
async function doKapInline(segId,step){
  const sid=segId.replace(/-/g,'_');
  const seg=byId(DB.segments,segId);if(!seg)return;
  const trip=byId(DB.trips,seg.tripId);

  // Validate vehicle number for all steps
  if(trip&&!trip.vehicleId){
    const sLabel={1:'Gate Exit',2:'Gate Entry',5:'Empty Vehicle Exit'}[step]||'this action';
    notify('Please assign a vehicle number before recording '+sLabel,true);
    return;
  }

  // Check if trip already has any step done (started before challan rule) — skip challan validation
  var _tripAlreadyStarted=seg.steps&&Object.keys(seg.steps).some(function(k){return seg.steps[k]&&seg.steps[k].done;});

  // For gate exit: save inline challan if entered, then validate this segment has challan
  if(step===1&&trip&&!_tripAlreadyStarted){
    const idx=seg.label==='A'?1:seg.label==='B'?2:3;
    // Check if inline challan input exists and save it
    const inlineCh=document.getElementById('kapCh_'+sid);
    if(inlineCh&&inlineCh.value.trim()){
      trip['challan'+idx]=inlineCh.value.trim();
    }
    // Validate: only THIS segment must have challan + weight + photo (segment-wise check)
    var challansCheck=trip['challans'+idx]||[];
    var hasNewCh=challansCheck.some(function(ch){return ch.no&&ch.no.trim();});
    if(!hasNewCh&&!(trip['challan'+idx]||'').trim()){
      // Skip challan check if segment starts from External location
      var segSLoc=seg.label==='A'?trip.startLoc:(seg.label==='B'?trip.dest1:trip.dest2);
      var sLocObj=byId(DB.locations||[],segSLoc);
      if(!sLocObj||sLocObj.type!=='External'){
        notify('Challan number required for segment '+seg.label+' before Gate Exit',true);
        return;
      }
    }
    // Check weight + photo for this segment
    var challansThisSeg=trip['challans'+idx]||[];
    var validChThis=challansThisSeg.filter(function(ch){return ch.no&&ch.no.trim();});
    if(validChThis.length){
      var mwt=validChThis.filter(function(ch){return !ch.weight;});
      if(mwt.length){notify('⚠ Weight is missing for '+mwt.length+' challan(s) in segment '+seg.label+'. Required before Gate Exit.',true);return;}
      var mph=validChThis.filter(function(ch){return !ch.photo;});
      if(mph.length){notify('⚠ Challan photo is missing for '+mph.length+' challan(s) in segment '+seg.label+'. Required before Gate Exit.',true);return;}
    } else if((trip['challan'+idx]||'').trim()){
      if(!trip['weight'+idx]){notify('⚠ Weight is missing for segment '+seg.label+'. Required before Gate Exit.',true);return;}
      if(!trip['photo'+idx]){notify('⚠ Challan photo is missing for segment '+seg.label+'. Required before Gate Exit.',true);return;}
    }
  }

  // For gate entry: validate challan + weight + photo — skip if trip already started
  if(step===2&&trip&&!_tripAlreadyStarted){
    const idx2=seg.label==='A'?1:seg.label==='B'?2:3;
    var challansEntry=trip['challans'+idx2]||[];
    var validChEntry=challansEntry.filter(function(ch){return ch.no&&ch.no.trim();});
    var legacyEntry=(trip['challan'+idx2]||'').trim();
    if(!validChEntry.length&&!legacyEntry){
      notify('Challan number required for segment '+seg.label+' before Gate Entry',true);
      return;
    }
    if(validChEntry.length){
      var mwt2=validChEntry.filter(function(ch){return !ch.weight;});
      if(mwt2.length){notify('⚠ Weight missing for '+mwt2.length+' challan(s). Required before Gate Entry.',true);return;}
      var mph2=validChEntry.filter(function(ch){return !ch.photo;});
      if(mph2.length){notify('⚠ Challan photo missing for '+mph2.length+' challan(s). Required before Gate Entry.',true);return;}
    } else if(legacyEntry){
      if(!trip['weight'+idx2]){notify('⚠ Weight is missing for segment '+seg.label+'. Required before Gate Entry.',true);return;}
      if(!trip['photo'+idx2]){notify('⚠ Challan photo missing for segment '+seg.label+'. Required before Gate Entry.',true);return;}
    }
  }

  const rem=(document.getElementById('rem_'+sid)?.value||'').trim();
  // Photo is mandatory for Gate Exit (1), Gate Entry (2), Empty Vehicle Exit (5)
  if(!_inlinePhotos[sid]){
    const stepName={1:'Gate Exit',2:'Gate Entry',5:'Empty Vehicle Exit'}[step]||'this action';
    notify(`📷 Vehicle photo is mandatory for ${stepName}. Please capture a photo.`,true);
    return;
  }
  seg.steps[step].done=true;
  seg.steps[step].time=new Date().toISOString();
  seg.steps[step].by=CU.id;
  seg.steps[step].remarks=rem;
  if(_inlinePhotos[sid]){seg.steps[step].photo=_inlinePhotos[sid];delete _inlinePhotos[sid];}
  if(_inlineStreams[sid]){_inlineStreams[sid].getTracks().forEach(t=>t.stop());delete _inlineStreams[sid];}
  await advance(seg);if(!await _dbSave('segments',seg)) return;
  // Remember which trip comes next so we can auto-expand it
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');
  const _pendingSegsAfter=DB.segments.filter(s=>{
    if(s.id===seg.id||s.status==='Completed'||s.status==='Locked'||s.status==='Rejected') return false;
    if(s.currentStep!==step) return false;
    return canDoStep(s,step);
  });
  renderKap();renderDash();renderTripBooking();renderMyTrips();updBadges();
  notify(step===1?"Gate Exit recorded!":step===5?"Empty Vehicle Exit recorded!":"Gate Entry recorded!");
}

async function doKapAction(){
  const segId=document.getElementById('kapSegId').value;
  const step=parseInt(document.getElementById('kapStep').value);
  const seg=byId(DB.segments,segId);
  // Skip challan/weight/photo validation if trip already has any step done (started before challan rule)
  var _kapAlreadyStarted=seg&&seg.steps&&Object.keys(seg.steps).some(function(k){return seg.steps[k]&&seg.steps[k].done;});
  // For Gate Exit (step 1), require at least 1 challan entry for this segment
  if(step===1&&!_kapAlreadyStarted){
    const t=byId(DB.trips,seg.tripId);
    if(t){
      const segIdx={'A':1,'B':2,'C':3}[seg.label]||1;
      var _segStartLocId=seg.sLoc||(segIdx===1?t.startLoc:segIdx===2?t.dest1:t.dest2);
      var _segStartLoc=byId(DB.locations||[],_segStartLocId);
      var _isExtStart=_segStartLoc&&_segStartLoc.type==='External';
      if(!_isExtStart){
        const challans=t['challans'+segIdx]||[];
        const validChallans=challans.filter(function(ch){return ch.no&&ch.no.trim();});
        const legacyCh=(t['challan'+segIdx]||'').trim();
        if(!validChallans.length&&!legacyCh){
          notify('⚠ Challan number is required for this segment before Gate Exit. Please ask the trip booker to add challan details.',true);
          return;
        }
        if(validChallans.length){
          var missingWt=validChallans.filter(function(ch){return !ch.weight;});
          if(missingWt.length){notify('⚠ Weight is missing for '+missingWt.length+' challan(s). Please ask the trip booker to add weight before Gate Exit.',true);return;}
          var missingPhoto=validChallans.filter(function(ch){return !ch.photo;});
          if(missingPhoto.length){notify('⚠ Challan photo is missing for '+missingPhoto.length+' challan(s). Please ask the trip booker to attach challan photos before Gate Exit.',true);return;}
        } else if(legacyCh){
          if(!t['weight'+segIdx]){notify('⚠ Weight is missing. Please ask the trip booker to add weight before Gate Exit.',true);return;}
          if(!t['photo'+segIdx]){notify('⚠ Challan photo is missing. Please ask the trip booker to attach challan photo before Gate Exit.',true);return;}
        }
      }
    }
  }
  // For gate entry (step 2): also validate challan+weight+photo — skip if already started
  if(step===2&&!_kapAlreadyStarted){
    const t=byId(DB.trips,seg.tripId);
    if(t){
      const segIdx={'A':1,'B':2,'C':3}[seg.label]||1;
      const challans=t['challans'+segIdx]||[];
      const validChallans=challans.filter(function(ch){return ch.no&&ch.no.trim();});
      const legacyCh=(t['challan'+segIdx]||'').trim();
      if(!validChallans.length&&!legacyCh){
        notify('⚠ Challan number required for segment '+seg.label+' before Gate Entry.',true);
        return;
      }
      if(validChallans.length){
        var missingWt2=validChallans.filter(function(ch){return !ch.weight;});
        if(missingWt2.length){notify('⚠ Weight is missing for '+missingWt2.length+' challan(s). Required before Gate Entry.',true);return;}
        var missingPhoto2=validChallans.filter(function(ch){return !ch.photo;});
        if(missingPhoto2.length){notify('⚠ Challan photo is missing for '+missingPhoto2.length+' challan(s). Required before Gate Entry.',true);return;}
      } else if(legacyCh){
        if(!t['weight'+segIdx]){notify('⚠ Weight is missing. Required before Gate Entry.',true);return;}
        if(!t['photo'+segIdx]){notify('⚠ Challan photo is missing. Required before Gate Entry.',true);return;}
      }
    }
  }
  const rem=document.getElementById('kapRem').value;
  // Photo is mandatory for Gate Exit (1), Gate Entry (2), Empty Vehicle Exit (5)
  if(!_kapPhotoData){
    const stepName={1:'Gate Exit',2:'Gate Entry',5:'Empty Vehicle Exit'}[step]||'this action';
    notify(`📷 Vehicle photo is mandatory for ${stepName}. Please capture a photo.`,true);
    return;
  }
  const _segBak=JSON.parse(JSON.stringify(seg));
  seg.steps[step].done=true;
  seg.steps[step].time=new Date().toISOString();
  seg.steps[step].by=CU.id;
  seg.steps[step].remarks=rem;
  if(_kapPhotoData) seg.steps[step].photo=_kapPhotoData;
  await advance(seg);if(!await _dbSave('segments',seg)){ Object.assign(seg,_segBak); return; }
  closeKapModal();
  renderKap();renderDash();renderTripBooking();updBadges();
  // Stay on current kap tab — scroll page into view
  const _kapSec=document.getElementById('pageKapSecurity');
  if(_kapSec) _kapSec.scrollIntoView({behavior:'smooth', block:'start'});
  notify(step===1?"Gate Exit recorded!":step===5?"Empty Vehicle Exit recorded!":"Gate Entry recorded!");
}

function clearTbPhoto(n){
  const thumb=document.getElementById('tbP'+n+'Thumb');
  if(thumb){thumb.innerHTML='📷';thumb.style.border='2px dashed var(--border2)';}
  const input=document.getElementById('tbP'+n);
  if(input){input.value='';input._compressedData=null;}
  const clearBtn=document.getElementById('tbP'+n+'Clear');
  if(clearBtn)clearBtn.style.display='none';
}

// ═══ MATERIAL RECEIPT ═══════════════════════════════════════════════════
let _mrActiveTab='pending';

function renderMR(){
  // Skip re-render while popup is open to prevent flicker
  if(_popOpen) return;
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');
  const _myTripIds=new Set(tripsForMyPlant().map(t=>t.id));
  let pending=DB.segments.filter(s=>{
    if(s.status==='Completed'||s.status==='Locked')return false;
    if(s.steps[3]?.done||s.steps[3]?.skip)return false;
    if(!stepsOneAndTwoDone(s))return false;
    return canDoStep(s,3);
  });
  // Trip ID search filter
  const mrSearch=(document.getElementById('mrTripSearch')?.value||'').toLowerCase();
  if(mrSearch) pending=pending.filter(s=>s.tripId.toLowerCase().includes(mrSearch)||vnum(byId(DB.trips,s.tripId)?.vehicleId).toLowerCase().includes(mrSearch));
  const badge=document.getElementById('mrCountPending');
  if(badge){badge.textContent=pending.length||'';badge.style.display=pending.length?'inline-flex':'none';}

  // Pending content
  // Sort by trip booking date descending (newest first)
  pending.sort((a,b)=>{const ta=byId(DB.trips,a.tripId);const tb=byId(DB.trips,b.tripId);return (tb?.date||'').localeCompare(ta?.date||'');});
  if(!pending.length){document.getElementById('mrPendingContent').innerHTML='<div class="empty-state" style="padding:12px">No pending material receipts</div>';}
  else{
    document.getElementById('mrPendingContent').innerHTML=pending.map((seg,_si)=>{
      const trip=byId(DB.trips,seg.tripId);
      const idx=seg.label==='A'?1:seg.label==='B'?2:3;
      const exitPhoto=seg.steps[1]?.photo||'';
      const entryPhoto=seg.steps[2]?.photo||'';
      const sid=seg.id.replace(/-/g,'_');
      const bu=byId(DB.users,trip?.bookedBy);const bookedName=bu?.fullName||bu?.name||'—';

      // All challans for this destination index
      const challans=trip?.['challans'+idx]||[];
      // Fallback to legacy fields
      const legacyCh=trip?.['challan'+idx]||'';const legacyWt=trip?.['weight'+idx]||'';const legacyPh=trip?.['photo'+idx]||'';
      const challanRows=challans.filter(ch=>ch.no||ch.weight||ch.photo).length
        ? challans.filter(ch=>ch.no||ch.weight||ch.photo)
        : legacyCh?[{no:legacyCh,weight:legacyWt,photo:legacyPh}]:[];

      // Photo thumbnail helper
      const thumb=(src,label,clr,sz)=>{const s=sz||52;return src
        ?`<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
            ${src.startsWith('data:application/pdf')||src==='pdf'
              ?`<div style="width:${s}px;height:${s}px;border-radius:6px;border:2px solid ${clr};background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer" onclick="openPhoto('${src}')">📄</div>`
              :`<img src="${src}" onclick="openPhoto(this.src)" title="View ${label}" style="width:${s}px;height:${s}px;object-fit:cover;border-radius:6px;border:2px solid ${clr};cursor:pointer;transition:transform .15s" onmouseover="this.style.transform='scale(1.08)'" onmouseout="this.style.transform='scale(1)'">`}
            <span style="font-size:8px;font-weight:700;color:${clr};text-transform:uppercase;letter-spacing:.3px">${label}</span>
          </div>`
        :`<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
            <div style="width:${s}px;height:${s}px;border-radius:6px;border:2px dashed var(--border2);background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--border2)">📷</div>
            <span style="font-size:8px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.3px">${label}</span>
          </div>`;};

      // Challan detail blocks — side by side compact chips
      const challanDetail=challanRows.length
        ?`<div style="display:flex;gap:6px;flex-wrap:wrap">`+challanRows.map((ch,ci)=>`
          <div style="display:flex;align-items:center;gap:6px;background:#fff;border:1.5px solid #7c3aed33;border-radius:8px;padding:5px 8px;min-width:0;flex:1;min-width:140px">
            ${thumb(ch.photo||'','','#7c3aed',38)}
            <div style="flex:1;min-width:0;overflow:hidden">
              <div style="font-size:8px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:.3px">Challan${challanRows.length>1?' '+(ci+1):''}</div>
              <div style="font-size:12px;font-weight:800;color:var(--text);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px">${ch.no||'—'}</div>
              <div style="font-size:11px;font-weight:700;color:#16a34a;font-family:var(--mono)">${ch.weight||'—'}<span style="font-size:9px;font-weight:500;color:var(--text3)"> kg</span></div>
            </div>
          </div>`).join('')+`</div>`
        :`<div style="font-size:11px;color:var(--text3);padding:4px 0">No challan details</div>`;

      const _mrPopId='mr_pop_'+sid;
      const _segClr={A:'#35b0b6',B:'#14b8a6',C:'#8b5cf6'}[seg.label]||'var(--accent)';
      // Colored route pills matching KAP style
      const _sLoc=byId(DB.locations,seg.sLoc),_dLoc=byId(DB.locations,seg.dLoc);
      const _sClr=_sLoc?.colour||'var(--accent)',_dClr=_dLoc?.colour||'var(--accent)';
      const _mrRoute=`<span style="${_locPillStyle(_sLoc?.colour,13)}">${_sLoc?.name||'?'}</span>`
        +`<span style="color:var(--accent);font-weight:900;font-size:14px;margin:0 3px">⟶</span>`
        +`<span style="${_locPillStyle(_dLoc?.colour,13)}">${_dLoc?.name||'?'}</span>`;
      const _mrBu=byId(DB.users,trip?.bookedBy);
      const _mrBookedFirst=(_mrBu?.fullName||_mrBu?.name||'').split(' ')[0]||'';
      const _mrTripDate=trip?.date?new Date(trip.date):null;
      const _mrShortDate=_mrTripDate?_mrTripDate.getDate()+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][_mrTripDate.getMonth()]:'';
      const _mrBookedLine=(_mrBookedFirst?`<span style="font-size:11px;color:var(--text2);font-weight:600">By: ${_mrBookedFirst}</span>`:'')+(_mrShortDate?`<span style="font-size:11px;color:var(--text3)">on ${_mrShortDate}</span>`:'');
      return `<div style="margin-bottom:8px">
        <!-- COMPACT CARD -->
        <div style="padding:0;overflow:hidden;cursor:pointer;border:2px solid #000;border-radius:10px;transition:box-shadow .15s;background:#fff" onclick="_openPop('${_mrPopId}')" onmouseover="this.style.boxShadow='0 4px 18px rgba(0,0,0,.12)'" onmouseout="this.style.boxShadow=''">
          <div style="display:flex;align-items:center;gap:8px;padding:8px 12px 4px;flex-wrap:nowrap;min-width:0">
            <span style="font-family:var(--mono);font-size:21px;font-weight:900;color:#fff;background:var(--accent);padding:2px 10px;border-radius:8px;flex-shrink:0;white-space:nowrap">${_cTid(seg.tripId)}</span>
            <span style="font-family:var(--mono);font-size:clamp(18px,5vw,35px);font-weight:900;color:var(--text);background:#fef08a;border:2px solid #ca8a04;border-radius:8px;padding:2px 10px;flex-shrink:0;white-space:nowrap">${vnum(trip?.vehicleId)}</span>
            <div style="flex:1"></div>
            <span style="font-size:18px;color:var(--text3);font-weight:300;flex-shrink:0">›</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;padding:2px 12px 4px;flex-wrap:wrap">${_mrBookedLine}</div>
          <div style="padding:0 12px 8px;display:flex;flex-wrap:wrap;gap:3px;align-items:center">
            <span style="width:20px;height:20px;border-radius:50%;background:${_segClr};color:#fff;font-size:9px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${seg.label}</span>
            ${_mrRoute}
          </div>
        </div>
        <!-- POPUP OVERLAY -->
        <div id="${_mrPopId}" style="display:none;position:fixed;inset:0;z-index:100000;background:rgba(30,40,70,.55);align-items:center;justify-content:center;padding:12px" onclick="if(event.target===this)_closePop('${_mrPopId}')">
          <div style="background:#fff;border:2px solid #000;border-radius:16px;max-width:540px;width:100%;max-height:calc(100vh - 24px);overflow-y:auto;box-shadow:0 8px 48px rgba(0,0,0,.35)">
            <!-- Popup header -->
            <div style="padding:14px 16px 10px;border-bottom:1px solid var(--border);position:sticky;top:0;background:#fff;z-index:1;border-radius:16px 16px 0 0">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <span style="font-family:var(--mono);font-size:28px;font-weight:900;color:#fff;background:var(--accent);padding:4px 14px;border-radius:10px">${_cTid(seg.tripId)}</span>
                <span style="font-family:var(--mono);font-size:28px;font-weight:900;color:var(--text);background:#fef08a;border:2px solid #ca8a04;padding:4px 14px;border-radius:10px">${vnum(trip?.vehicleId)}</span>
              </div>
              <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:3px;align-items:center">
                <span style="width:20px;height:20px;border-radius:50%;background:${_segClr};color:#fff;font-size:9px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${seg.label}</span>
                <span style="${_locPillStyle(_sLoc?.colour,13)}">${_sLoc?.name||'?'}</span>
                <span style="color:var(--accent);font-weight:900;font-size:14px">⟶</span>
                <span style="${_locPillStyle(_dLoc?.colour,13)}">${_dLoc?.name||'?'}</span>
              </div>
              <div style="margin-top:4px;display:flex;gap:6px;font-size:12px"><span style="color:var(--text3)">Booked by:</span><span style="font-weight:700">${bookedName}</span><span style="color:var(--border2)">·</span><span style="color:var(--text3)">📅 ${fdt(seg.date)}</span></div>
            </div>
            <!-- Gate photos + Challans -->
            <div style="padding:12px 16px">
              <div style="display:flex;gap:6px;align-items:flex-start;border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:10px;flex-wrap:wrap">
                <div style="display:flex;gap:10px;align-items:flex-start">
                  ${thumb(exitPhoto,'Gate Exit','#2a9aa0')}
                  ${thumb(entryPhoto,'Gate Entry','#0d9488')}
                </div>
                <div style="flex:1;min-width:160px;border-left:1.5px solid var(--border);padding-left:10px;margin-left:4px">
                  <div style="font-size:9px;font-weight:700;color:#000;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px">Challan Details</div>
                  ${challanDetail}
                </div>
              </div>
              <!-- Material Receipt Decision -->
              <div style="border-top:1.5px solid var(--border);padding-top:10px">
                <div style="font-size:9px;font-weight:700;color:#000;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Receipt Status</div>
                <div id="mrOpts_${sid}" style="display:flex;gap:4px;flex-wrap:nowrap">
                  <label style="flex:1;display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;padding:5px 6px;border-radius:6px;border:1.5px solid var(--border);background:#fff;transition:all .15s;min-width:0;text-align:center" id="mrOpt_dot_${sid}_received"
                    onmouseover="this.style.borderColor='#86efac'" onmouseout="if(document.getElementById('mrRad_${sid}').value!=='received')this.style.borderColor='var(--border)'">
                    <input type="radio" name="mrSel_${sid}" value="received" id="mrRad_${sid}_received" style="width:13px;height:13px;accent-color:#16a34a;cursor:pointer;flex-shrink:0"
                      onchange="selectMrOption('${sid}','received',this.closest('label'))">
                    <span style="font-size:10px;font-weight:800;color:#15803d;white-space:nowrap">✅ Received</span>
                  </label>
                  <label style="flex:1;display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;padding:5px 6px;border-radius:6px;border:1.5px solid var(--border);background:#fff;transition:all .15s;min-width:0;text-align:center" id="mrOpt_dot_${sid}_not_received"
                    onmouseover="this.style.borderColor='#fca5a5'" onmouseout="if(document.getElementById('mrRad_${sid}_not_received')&&!document.getElementById('mrRad_${sid}_not_received').checked)this.style.borderColor='var(--border)'">
                    <input type="radio" name="mrSel_${sid}" value="not_received" id="mrRad_${sid}_not_received" style="width:13px;height:13px;accent-color:#dc2626;cursor:pointer;flex-shrink:0"
                      onchange="selectMrOption('${sid}','not_received',this.closest('label'))">
                    <span style="font-size:10px;font-weight:800;color:#dc2626;white-space:nowrap">✗ Not Rcvd</span>
                  </label>
                  <label style="flex:1;display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;padding:5px 6px;border-radius:6px;border:1.5px solid var(--border);background:#fff;transition:all .15s;min-width:0;text-align:center" id="mrOpt_dot_${sid}_discrepancy"
                    onmouseover="this.style.borderColor='#fed7aa'" onmouseout="if(document.getElementById('mrRad_${sid}_discrepancy')&&!document.getElementById('mrRad_${sid}_discrepancy').checked)this.style.borderColor='var(--border)'">
                    <input type="radio" name="mrSel_${sid}" value="discrepancy" id="mrRad_${sid}_discrepancy" style="width:13px;height:13px;accent-color:#ea580c;cursor:pointer;flex-shrink:0"
                      onchange="selectMrOption('${sid}','discrepancy',this.closest('label'))">
                    <span style="font-size:10px;font-weight:800;color:#c2410c;white-space:nowrap">⚠ Discrepancy</span>
                  </label>
                  <input type="hidden" id="mrRad_${sid}" value="">
                </div>
                <div id="disc_mr_${sid}" style="display:none;margin-top:5px">
                  <textarea id="mrRem_${sid}" rows="2" placeholder="Describe the discrepancy…"
                    style="width:100%;box-sizing:border-box;background:#fff7ed;border:1.5px solid #fed7aa;border-radius:6px;padding:6px 10px;font-size:12px;color:var(--text);font-family:inherit;resize:vertical"></textarea>
                </div>
                <div style="display:flex;gap:8px;margin-top:8px" onclick="event.stopPropagation()">
                  <button id="mrAckBtn_${sid}" onclick="doMRInline('${seg.id}', document.getElementById('mrOpts_${sid}')?.dataset.selected)"
                    style="flex:1;padding:10px 16px;font-size:13px;font-weight:800;border-radius:8px;border:none;background:#d1d5db;color:#6b7280;cursor:not-allowed;transition:all .2s;white-space:nowrap" disabled>
                    📦 Acknowledge Receipt
                  </button>
                  <button onclick="_closePop('${_mrPopId}')" style="width:48px;flex-shrink:0;font-size:20px;font-weight:900;background:var(--surface2);border:2px solid var(--border2);border-radius:8px;cursor:pointer;color:var(--text2);display:flex;align-items:center;justify-content:center" title="Close">✕</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

  }

  // Always render history
  initHistDates('mrHistFrom','mrHistTo','mrHist');
  renderMRHistory();
}

function renderMRHistory(){
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');
  const _mrTripIds=new Set(tripsForMyPlant().map(t=>t.id));
  const fromVal=document.getElementById('mrHistFrom')?.value||'';
  const toVal=document.getElementById('mrHistTo')?.value||'';

  let segs=DB.segments.filter(s=>{
    if(!s.steps[3]?.done||s.steps[3]?.skip) return false;
    if(isSA) return true;
    // Show if user is assigned, performed action, or trip belongs to user's plant
    const loc=byId(DB.locations,s.dLoc);
    const tripPlantMatch=_mrTripIds.has(s.tripId);
    return (loc?.matRecv||[]).includes(CU.id)||s.steps[3]?.by===CU.id||tripPlantMatch;
  });
  if(fromVal)segs=segs.filter(s=>(s.date||'').slice(0,10)>=fromVal);
  if(toVal)segs=segs.filter(s=>(s.date||'').slice(0,10)<=toVal);
  const mrHistSearch=(document.getElementById('mrTripSearch')?.value||'').toLowerCase();
  if(mrHistSearch) segs=segs.filter(s=>s.tripId.toLowerCase().includes(mrHistSearch)||vnum(byId(DB.trips,s.tripId)?.vehicleId).toLowerCase().includes(mrHistSearch));
  segs.sort((a,b)=>(b.steps[3]?.time||'').localeCompare(a.steps[3]?.time||''));

  if(!segs.length){
    document.getElementById('mrHistBody').innerHTML='<div class="empty-state">No material receipts in selected period</div>';
    return;
  }

  const fmt=t=>t?new Date(t).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'})+' '+new Date(t).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true}):'—';

  const mrThSm=(src,clr,sz)=>{const s=sz||36;return src
    ?(src.startsWith('data:application/pdf')
      ?`<div style="width:${s}px;height:${s}px;border-radius:5px;border:2px solid ${clr};background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer" onclick="openPhoto('${src}')">📄</div>`
      :`<img src="${src}" onclick="openPhoto(this.src)" style="width:${s}px;height:${s}px;object-fit:cover;border-radius:5px;border:2px solid ${clr};cursor:pointer">`)
    :`<div style="width:${s}px;height:${s}px;border-radius:5px;border:2px dashed var(--border2);background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--border2)">📷</div>`;};

  document.getElementById('mrHistBody').innerHTML=segs.map((seg,si)=>{
    const trip=byId(DB.trips,seg.tripId);
    const st3=seg.steps[3];
    const rcvdByUser=byId(DB.users,st3?.by);
    const rcvdByName=rcvdByUser?.fullName||rcvdByUser?.name||'—';
    const bookedByUser=byId(DB.users,trip?.bookedBy);
    const bookedByName=bookedByUser?.fullName||bookedByUser?.name||'—';
    const idx=seg.label==='A'?1:seg.label==='B'?2:3;
    const challans=trip?.['challans'+idx]||[];
    const legCh=trip?.['challan'+idx]||'';const legWt=trip?.['weight'+idx]||'';const legPh=trip?.['photo'+idx]||'';
    const chRows=challans.filter(ch=>ch.no||ch.weight||ch.photo).length
      ?challans.filter(ch=>ch.no||ch.weight||ch.photo)
      :legCh?[{no:legCh,weight:legWt,photo:legPh}]:[];
    const baseTripId=(seg.tripId||'').replace(/-R\d+$/,'');
    const segClr={A:'#35b0b6',B:'#14b8a6',C:'#8b5cf6'}[seg.label]||'var(--accent)';
    const dLoc=byId(DB.locations,seg.dLoc);
    const dBg=dLoc?.colour?dLoc.colour+'18':'var(--surface2)';
    const dBorder=dLoc?.colour||'var(--border)';
    const mrDiscrep=st3?.discrepancy;
    const mrRem=st3?.remarks||'';
    const cardId='mrhc_'+seg.id.replace(/[^a-zA-Z0-9]/g,'_');
    const hasRevoke=(isSA||st3?.by===CU.id)&&!seg.steps[4]?.done;

    // Build coloured route pills like KAP history
    const mrRoutePills=(()=>{
      const lf=byId(DB.locations,seg.sLoc),lt=byId(DB.locations,seg.dLoc);
      const cf=lf?.colour||'var(--accent)',ct=lt?.colour||'var(--accent)';
      return `<span style="${_locPillStyle(lf?.colour,13)}">${lf?.name||'?'}</span>`
        +`<span style="color:var(--accent);font-weight:900;font-size:14px;margin:0 3px">⟶</span>`
        +`<span style="${_locPillStyle(lt?.colour,13)}">${lt?.name||'?'}</span>`;
    })();

    return `<div class="seg-card" style="padding:0;overflow:hidden;cursor:pointer;border:none;background:var(--surface);border:1.5px solid var(--border);border-radius:10px;margin-bottom:6px;position:relative;padding-left:38px" onclick="toggleMrCard('${cardId}')">
      <div style="position:absolute;left:0;top:0;bottom:0;width:26px;background:rgba(0,0,0,0.28);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;color:#fff;user-select:none">${segs.length-si}</div>
      <!-- Line 1: Trip ID + Vehicle -->
      <div style="display:flex;align-items:center;gap:6px;padding:7px 10px 3px;min-width:0">
        <span style="font-family:var(--mono);font-size:20px;font-weight:800;color:#fff;background:var(--accent);padding:3px 9px;border-radius:6px;flex-shrink:0;letter-spacing:.4px">${baseTripId}</span>
        <span style="font-family:var(--mono);font-size:20px;font-weight:800;color:var(--text);background:#fef08a;border:1.5px solid #ca8a04;border-radius:6px;padding:2px 8px;flex-shrink:0">${vnum(trip?.vehicleId)}</span>
        ${mrDiscrep?`<span style="font-size:10px;font-weight:700;color:#dc2626;white-space:nowrap">⚠ Discrepancy</span>`:''}
      </div>
      <!-- Line 2: Coloured route pills -->
      <div style="padding:2px 10px 8px;display:flex;flex-wrap:wrap;gap:3px;align-items:center">${mrRoutePills}</div>
      <!-- Collapsible details -->
      <div id="${cardId}" style="display:none;border-top:1px solid var(--border)" onclick="event.stopPropagation()">
        ${chRows.length
          ?`<div style="display:flex;gap:5px;flex-wrap:wrap;padding:6px 10px;">`+chRows.map((ch,ci)=>`<div style="display:flex;align-items:center;gap:5px;background:#fff;border:1.5px solid #7c3aed33;border-radius:7px;padding:4px 8px;flex:1;min-width:110px">${mrThSm(ch.photo||'','#7c3aed',32)}<div style="flex:1;min-width:0"><div style="font-size:8px;font-weight:700;color:#7c3aed;text-transform:uppercase">Ch${chRows.length>1?' '+(ci+1):''}</div><div style="font-size:11px;font-weight:800;color:var(--text);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ch.no||'—'}</div><div style="font-size:10px;font-weight:700;color:#16a34a;font-family:var(--mono)">${ch.weight||'—'}<span style="font-size:8px;color:var(--text3)"> kg</span></div></div></div>`).join('')+'</div>'
          :''}
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start;font-size:10px;background:rgba(0,0,0,0.04);padding:5px 10px 7px">
          <div><span style="color:var(--text3)">Booked by </span><span style="font-weight:700;color:var(--text2)">${bookedByName}</span></div>
          <div style="width:1px;background:var(--border);align-self:stretch"></div>
          <div><span style="color:var(--text3)">Rcvd by </span><span style="font-weight:700;color:#16a34a">${rcvdByName}</span></div>
          <div style="width:1px;background:var(--border);align-self:stretch"></div>
          <div><span style="color:var(--text3)">📅 </span><span style="font-weight:600;color:var(--text2)">${fmt(st3?.time)}</span></div>
          ${mrDiscrep?`<div style="width:100%"><span style="color:#dc2626;font-weight:700">⚠ ${mrRem.replace(/^\[Discrepancy\]\s*/,'').slice(0,80)+(mrRem.replace(/^\[Discrepancy\]\s*/,'').length>80?'…':'')}</span></div>`:''}
        </div>
        ${hasRevoke?`<div style="padding:4px 10px 7px;display:flex;justify-content:flex-end"><button class="kap-revoke-btn" onclick="revokeMR('${seg.id}')">↩ Revoke</button></div>`:''}
      </div>
    </div>`;
  }).join('');
}

function toggleMrCard(id){
  const body=document.getElementById(id);
  if(!body)return;
  const open=body.style.display!=='none';
  body.style.display=open?'none':'block';
}

function selectMrOption(sid, type, labelEl){
  const opts=['received','not_received','discrepancy'];
  const selBorders={received:'#16a34a',not_received:'#dc2626',discrepancy:'#ea580c'};
  const selBgs={received:'rgba(22,163,74,.06)',not_received:'rgba(220,38,38,.06)',discrepancy:'rgba(234,88,12,.06)'};
  // Reset all radio labels to unselected style
  opts.forEach(t=>{
    const lbl=document.getElementById('mrOpt_dot_'+sid+'_'+t);
    if(lbl){lbl.style.border='2px solid var(--border)';lbl.style.background='#fff';}
  });
  // Highlight selected label with coloured border + tinted bg
  const selLbl=document.getElementById('mrOpt_dot_'+sid+'_'+type);
  if(selLbl){selLbl.style.border='2px solid '+selBorders[type];selLbl.style.background=selBgs[type];}
  // Show/hide discrepancy textarea
  const disc=document.getElementById('disc_mr_'+sid);
  if(disc){disc.style.display=type==='discrepancy'?'block':'none';}
  if(type==='discrepancy'&&disc) disc.querySelector('textarea')?.focus();
  // Store selection in hidden input and container data attr
  const container=document.getElementById('mrOpts_'+sid);
  if(container) container.dataset.selected=type;
  const hidden=document.getElementById('mrRad_'+sid);
  if(hidden) hidden.value=type;
  // Enable acknowledge button
  const btn=document.getElementById('mrAckBtn_'+sid);
  const ackColors={received:'#16a34a',not_received:'#dc2626',discrepancy:'#ea580c'};
  if(btn){btn.disabled=false;btn.style.cursor='pointer';btn.style.background=ackColors[type];btn.style.color='#fff';}
}

async function doMRInline(segId, receiptType){
  const seg=byId(DB.segments,segId);if(!seg)return;
  const trip=byId(DB.trips,seg.tripId);
  // Check vehicle details
  if(!trip?.vehicleId||!byId(DB.vehicles,trip.vehicleId)){
    notify('⚠ Vehicle details are required before acknowledging material receipt. Please assign a vehicle to this trip first.',true);
    return;
  }
  const idx=seg.label==='A'?1:seg.label==='B'?2:3;
  // Check challan details (skip for not_received)
  if(receiptType!=='not_received'){
    const challans=(trip?.['challans'+idx]||[]).filter(ch=>ch.no||ch.weight);
    const legacyChallan=trip?.['challan'+idx]||'';
    if(!challans.length&&!legacyChallan){
      notify('⚠ Challan details are required before acknowledging material receipt. Please add challan number and weight first.',true);
      return;
    }
  }
  const sid=segId.replace(/-/g,'_');
  const ta=document.getElementById('mrRem_'+sid);
  const rem=(ta?.value||'').trim();
  if(receiptType==='discrepancy'&&!rem){
    if(ta){ta.style.border='2px solid #dc2626';ta.focus();}
    notify('⚠ Please describe the discrepancy before confirming.',true);return;
  }
  const prefix=receiptType==='not_received'?'[Not Received] ':receiptType==='discrepancy'?'[Discrepancy] ':'';
  seg.steps[3].done=true;seg.steps[3].time=new Date().toISOString();seg.steps[3].by=CU.id;
  seg.steps[3].remarks=prefix+rem;
  seg.steps[3].discrepancy=(receiptType==='discrepancy');
  seg.steps[3].notReceived=(receiptType==='not_received');
  await advance(seg);if(!await _dbSave('segments',seg)) return;renderMR();renderTripBooking();updBadges();
  const msgs={received:'✅ Material receipt acknowledged!',not_received:'Material Not Received recorded.',discrepancy:'⚠ Receipt with discrepancy recorded.'};
  notify(msgs[receiptType]||'Material receipt acknowledged!');
}
function revokeMR(segId){
  const seg=byId(DB.segments,segId);
  if(!seg){notify('⚠ Segment not found: '+segId,true);return;}
  document.getElementById('revokeMRSegId').value=segId;
  om('mRevokeMR');
}
async function _doRevokeMR(){
  try{
    const segId=document.getElementById('revokeMRSegId').value;
    const seg=byId(DB.segments,segId);
    if(!seg){notify('⚠ Segment not found.',true);cm('mRevokeMR');return;}
    const s3=seg.steps[3]||seg.steps['3'];
    if(!s3){notify('⚠ Step 3 data missing.',true);cm('mRevokeMR');return;}
    s3.done=false; s3.time=null; s3.by=null; s3.remarks=''; s3.discrepancy=false; s3.notReceived=false;
    // Revert step 4 rejection if not yet approved
    const s4=seg.steps[4]||seg.steps['4'];
    if(s4&&!s4.done&&s4.rejected){s4.rejected=false;s4.remarks='';s4.by=null;}
    seg.status='Active';
    seg.currentStep=nextStep(seg);
    await _dbSave('segments',seg); 
    cm('mRevokeMR');
    notify('↩ Material receipt revoked — returned to pending.');
    renderMR(); updBadges();
  }catch(e){
    console.error('_doRevokeMR error:',e);
    notify('⚠ Error revoking: '+e.message,true);
    cm('mRevokeMR');
  }
}
async function doMR(){
  const seg=byId(DB.segments,document.getElementById('mrSegId').value);
  const rem=(document.getElementById('mrRem')?.value||'').trim();
  seg.steps[3].done=true;seg.steps[3].time=new Date().toISOString();seg.steps[3].by=CU.id;
  if(rem)seg.steps[3].remarks=rem;
  await advance(seg);if(!await _dbSave('segments',seg)) return;cm('mMR');renderMR();renderTripBooking();updBadges();notify('Material receipt acknowledged!');
}

// ═══ TRIP APPROVALS ═════════════════════════════════════════════════════
let _apTab='pending';
function initApproveDates(){
  const now=new Date();
  const pad=n=>String(n).padStart(2,'0');
  const from=`${now.getFullYear()}-${pad(now.getMonth()+1)}-01`;
  const last=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  const to=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(last)}`;
  const fe=document.getElementById('approveFrom');const te=document.getElementById('approveTo');
  if(fe&&!fe.value){fe.value=from;updDateBtnLbl('approveFrom');}
  if(te&&!te.value){te.value=to;updDateBtnLbl('approveTo');}
  setTimeout(()=>updDrBtns('approve','approveFrom','approveTo'),30);
}

function renderApprove(){
  // Skip re-render while popup is open to prevent flicker
  if(_popOpen) return;
  initApproveDates();
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');

  // Helper: is current user an approver for this segment's destination location?

  const _apTripIds=new Set(tripsForMyPlant().map(t=>t.id));
  let pendingSegs=DB.segments.filter(s=>{
    if(s.status==='Completed'||s.status==='Locked')return false;
    if(!stepsOneAndTwoDone(s))return false;
    const isPendingStep4=!s.steps[4]?.done&&!s.steps[4]?.rejected;
    const isRejected=s.status==='Rejected'||s.steps[4]?.rejected;
    if(!isPendingStep4&&!isRejected)return false;
    return canDoStep(s,4);
  });
  // Trip ID search filter
  const apSearch=(document.getElementById('approveTripSearch')?.value||'').toLowerCase();
  if(apSearch) pendingSegs=pendingSegs.filter(s=>s.tripId.toLowerCase().includes(apSearch)||vnum(byId(DB.trips,s.tripId)?.vehicleId).toLowerCase().includes(apSearch));

  // Group by tripId — only show trips where ALL segments have gate work done
  const tripGroups={};
  pendingSegs.forEach(s=>{
    if(!tripGroups[s.tripId])tripGroups[s.tripId]=[];
    tripGroups[s.tripId].push(s);
  });
  // Filter: keep only trips where every active segment has completed gate ops AND material receipt (or is skipped/locked)
  const pendingTrips=Object.entries(tripGroups).filter(([tripId])=>{
    const allSegs=DB.segments.filter(s=>s.tripId===tripId);
    return allSegs.every(s=>s.status==='Completed'||s.status==='Locked'||stepsUpTo3Done(s)||s.status==='Rejected');
  });

  // Sort pending trips by booking date descending (newest first)
  pendingTrips.sort((a,b)=>{const ta=byId(DB.trips,a[0]);const tb=byId(DB.trips,b[0]);return (tb?.date||'').localeCompare(ta?.date||'');});
  // Update pending badge (count trips, not segments)
  const badge=document.getElementById('apBadgePending');
  if(badge){badge.textContent=pendingTrips.length||'';badge.style.display=pendingTrips.length?'inline-flex':'none';}
  if(!pendingTrips.length){document.getElementById('approveContent').innerHTML='<div class="empty-state">No pending approvals for you</div>';}
  else{
    document.getElementById('approveContent').innerHTML=pendingTrips.map(([tripId,segs],_apIdx)=>{
      const trip=byId(DB.trips,tripId);
      const allTripSegs=DB.segments.filter(s=>s.tripId===tripId).sort((a,b)=>a.label.localeCompare(b.label));
      const drv=byId(DB.drivers,trip?.driverId);
      const rate=getMatchedRate(tripId);

      // Check if any segment was previously rejected
      const rejectedSegs=allTripSegs.filter(s=>s.steps[4]?.rejected);
      const isRejectedTrip=allTripSegs.some(s=>s.status==='Rejected');
      const rejNote=rejectedSegs.length?`<div style="background:rgba(239,68,68,.08);border:1.5px solid rgba(239,68,68,.3);border-radius:8px;padding:10px 12px;margin-top:8px">
        ${rejectedSegs.map(s=>`<div style="font-size:12px;color:#dc2626;font-weight:700">⚠ Seg ${s.label} rejected — <em style="font-weight:400">${s.steps[4].remarks||'(no remarks)'}</em></div>`).join('')}
        ${isSA?`<div style="margin-top:8px;border-top:1px solid rgba(239,68,68,.2);padding-top:8px">
          <div style="font-size:10px;color:var(--text3);font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px">Admin Override — Accept Rejected Trip</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="rem_rej_${tripId}" placeholder="Reason for accepting…"
              style="flex:1;background:#fff;border:1.5px solid #dc2626;border-radius:6px;padding:6px 10px;font-size:12px;color:var(--text);font-family:inherit">
            <button style="padding:7px 16px;font-size:12px;font-weight:800;background:#16a34a;color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap"
              onclick="acceptRejectedTrip('${tripId}')">✓ Accept</button>
          </div>
        </div>`:''}
      </div>`:'';

      // Build segment rows with challan photo inline
      const segRows=allTripSegs.map(s=>{
        const idx=s.label==='A'?1:s.label==='B'?2:3;
        const ch=trip?.['challan'+idx]||'';
        const wt=trip?.['weight'+idx]||'';
        const challanPh=trip?.['photo'+idx];
        const stLabel=s.status==='Completed'?'✓ Done':s.status==='Rejected'?'⚠ Rejected':s.currentStep===5?'📤 Empty Exit':s.currentStep===4?'⏳ Trip Approval':`Step ${s.currentStep}`;
        const stClr=s.status==='Completed'?'#16a34a':s.status==='Rejected'?'#dc2626':s.currentStep===5?'#ea580c':s.currentStep===4?'var(--accent)':'var(--text3)';
        const segClr={A:'#35b0b6',B:'#14b8a6',C:'#8b5cf6'}[s.label]||'var(--accent)';
        return `<div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
          <span style="width:20px;height:20px;border-radius:50%;background:${segClr};color:#fff;font-size:9px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${s.label}</span>
          <span style="font-size:11px">${lnameText(s.sLoc)} → ${lnameText(s.dLoc)}</span>
          ${ch?`<span style="font-size:12px;font-weight:700;background:#f0fafa;border:1px solid #7dc9cb;padding:1px 6px;border-radius:4px;color:#1d6f73">📄 ${ch}</span>`:'<span style="font-size:10px;color:var(--text3)">—</span>'}
          ${wt?`<span style="font-size:11px">⚖ ${wt}kg</span>`:''}
          ${challanPh?`<img src="${challanPh}" onclick="openPhoto(this.src)" style="width:28px;height:28px;object-fit:cover;border-radius:4px;border:2px solid var(--green);cursor:pointer">`:''}
          <span style="font-size:10px;color:${stClr};font-weight:700;margin-left:auto">${stLabel}</span>
        </div>`;
      }).join('');

      const bookedBy=(()=>{const u=byId(DB.users,trip?.bookedBy);return u?.fullName||u?.name||'-';})();
      const costBadge=rate?`<div class="trip-amt-badge" style="font-size:14px">💰 ₹${rate.rate.toLocaleString()}</div>`:`<div class="trip-amt-badge trip-amt-none">₹ —</div>`;

      // Build compact challan chips per segment (same as MR page)
      const thumbSm=(src,clr,sz)=>{const s=sz||38;return src
        ?`${src.startsWith('data:application/pdf')
            ?`<div style="width:${s}px;height:${s}px;border-radius:5px;border:2px solid ${clr};background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer" onclick="openPhoto('${src}')">📄</div>`
            :`<img src="${src}" onclick="openPhoto(this.src)" style="width:${s}px;height:${s}px;object-fit:cover;border-radius:5px;border:2px solid ${clr};cursor:pointer">`}`
        :`<div style="width:${s}px;height:${s}px;border-radius:5px;border:2px dashed var(--border2);background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--border2)">📷</div>`;};

      const allSegDetails=allTripSegs.map(s=>{
        const idx2=s.label==='A'?1:s.label==='B'?2:3;
        const challans2=trip?.['challans'+idx2]||[];
        const legCh=trip?.['challan'+idx2]||'';const legWt=trip?.['weight'+idx2]||'';const legPh=trip?.['photo'+idx2]||'';
        const chRows=challans2.filter(ch=>ch.no||ch.weight||ch.photo).length
          ?challans2.filter(ch=>ch.no||ch.weight||ch.photo)
          :legCh?[{no:legCh,weight:legWt,photo:legPh}]:[];
        const exitPh2=s.steps[1]?.photo||'';const entryPh2=s.steps[2]?.photo||'';
        // Status label
        const mrDone=s.steps[3]?.done&&!s.steps[3]?.skip;
        const mrSkipped=!!s.steps[3]?.skip;
        const stLabel2=s.status==='Completed'?'✓ Trip Approval':s.status==='Rejected'?'✗ Rejected'
          :s.currentStep===5?'📤 Empty Exit Pending'
          :s.currentStep===4?'⏳ Trip Approval Pending'
          :s.currentStep===3&&!s.steps[3]?.done?'📦 Material Receipt Pending'
          :'In Progress';
        const stClr2=s.status==='Completed'?'#16a34a':s.status==='Rejected'?'#dc2626'
          :s.currentStep===4?'var(--accent)':'#ea580c';
        const segClr2={A:'#35b0b6',B:'#14b8a6',C:'#8b5cf6'}[s.label]||'var(--accent)';
        // MR received by details
        const mrByUser=mrDone?byId(DB.users,s.steps[3].by):null;
        const mrByName=mrByUser?.fullName||mrByUser?.name||'';
        const mrTime=mrDone&&s.steps[3].time?fdt(s.steps[3].time):'';
        const mrRem=s.steps[3]?.remarks||'';
        const mrDiscrep=s.steps[3]?.discrepancy;
        const _mrCleanRem=mrRem.replace(/^\[(Discrepancy|Not Received)\]\s*/,'');
        const _mrNotRcvd=s.steps[3]?.notReceived||(mrRem.startsWith('[Not Received]'));
        const mrInfo=mrDone?(()=>{
          if(_mrNotRcvd) return `<div style="margin-top:6px;padding:7px 10px;background:#fee2e2;border:2px solid #fca5a5;border-radius:7px;display:flex;align-items:flex-start;gap:6px">
            <span style="font-size:16px;line-height:1;flex-shrink:0">✗</span>
            <div>
              <div style="font-size:11px;font-weight:800;color:#dc2626">Material Not Received</div>
              <div style="font-size:10px;color:#b91c1c;margin-top:2px">Rcvd by <strong>${mrByName}</strong> · ${mrTime}</div>
              ${_mrCleanRem?`<div style="font-size:11px;color:#dc2626;margin-top:3px;font-style:italic">"${_mrCleanRem}"</div>`:''}
            </div>
          </div>`;
          if(mrDiscrep) return `<div style="margin-top:6px;padding:7px 10px;background:#fff7ed;border:2px solid #fb923c;border-radius:7px;display:flex;align-items:flex-start;gap:6px">
            <span style="font-size:16px;line-height:1;flex-shrink:0">⚠</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:11px;font-weight:800;color:#c2410c">Received with Discrepancy</div>
              <div style="font-size:10px;color:#92400e;margin-top:2px">Rcvd by <strong>${mrByName}</strong> · ${mrTime}</div>
              ${_mrCleanRem?`<div style="font-size:12px;color:#c2410c;margin-top:4px;font-weight:600;font-style:italic;background:#ffedd5;border-radius:5px;padding:4px 8px">"${_mrCleanRem}"</div>`:''}
            </div>
          </div>`;
          return `<div style="margin-top:6px;padding:5px 8px;background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:6px;font-size:10px;color:#15803d">
            ✅ Rcvd by <strong>${mrByName}</strong> · ${mrTime}
          </div>`;
        })():mrSkipped?'<div style="margin-top:6px;padding:5px 8px;background:rgba(0,0,0,.04);border-radius:6px;font-size:10px;color:var(--text3)">— Mat. Receipt skipped (External dest.)</div>':'<div style="margin-top:6px;padding:5px 8px;background:#fef9c3;border:1px solid #fde047;border-radius:6px;font-size:10px;color:#854d0e;font-weight:600">⏳ Awaiting Material Receipt</div>';
        const _sLoc2=byId(DB.locations,s.sLoc),_dLoc2=byId(DB.locations,s.dLoc);
        const _sC2=_sLoc2?.colour||'var(--accent)',_dC2=_dLoc2?.colour||'var(--accent)';
        return `<div style="background:#fff;border:3px solid var(--accent);border-radius:8px;padding:8px 10px;flex:1;min-width:220px">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
            <span style="width:20px;height:20px;border-radius:50%;background:${segClr2};color:#fff;font-size:9px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${s.label}</span>
            <span style="${_locPillStyle(_sLoc2?.colour,11)}">${_sLoc2?.name||'?'}</span>
            <span style="color:var(--accent);font-weight:900;font-size:12px">⟶</span>
            <span style="${_locPillStyle(_dLoc2?.colour,11)}">${_dLoc2?.name||'?'}</span>
          </div>
          <div style="margin-bottom:6px"><span style="font-size:10px;color:${stClr2};font-weight:700;background:${stClr2}11;border:1px solid ${stClr2}33;padding:2px 8px;border-radius:4px">${stLabel2}</span></div>
          <div style="display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap">
            <div style="display:flex;gap:8px;flex-shrink:0">
              <div style="display:flex;flex-direction:column;align-items:center;gap:2px">${thumbSm(exitPh2,'#2a9aa0')}<span style="font-size:7px;font-weight:700;color:#2a9aa0;text-transform:uppercase">Exit</span></div>
              <div style="display:flex;flex-direction:column;align-items:center;gap:2px">${thumbSm(entryPh2,'#0d9488')}<span style="font-size:7px;font-weight:700;color:#0d9488;text-transform:uppercase">Entry</span></div>
            </div>
            <div style="flex:1;min-width:120px;border-left:1.5px solid var(--border);padding-left:8px">
              <div style="font-size:8px;font-weight:700;color:#000;text-transform:uppercase;letter-spacing:.3px;margin-bottom:3px">Challans</div>
              ${chRows.length
                ?`<div style="display:flex;gap:5px;flex-wrap:wrap">`+chRows.map((ch,ci)=>`<div style="display:flex;align-items:center;gap:5px;background:#fff;border:1.5px solid #7c3aed33;border-radius:7px;padding:4px 7px;flex:1;min-width:120px">${thumbSm(ch.photo||'','#7c3aed',32)}<div style="flex:1;min-width:0"><div style="font-size:8px;font-weight:700;color:#7c3aed">Ch${chRows.length>1?' '+(ci+1):''}</div><div style="font-size:11px;font-weight:800;color:var(--text);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100px">${ch.no||'—'}</div><div style="font-size:10px;font-weight:700;color:#16a34a;font-family:var(--mono)">${ch.weight||'—'}<span style="font-size:8px;color:var(--text3)"> kg</span></div></div></div>`).join('')+`</div>`
                :`<span style="font-size:10px;color:var(--text3)">No challan</span>`}
              ${mrInfo}
            </div>
          </div>
        </div>`;
      }).join('');

      const _apPopId='ap_pop_'+tripId.replace(/[^a-z0-9]/gi,'_');
      // Colored route pills matching KAP style
      const _apRoutePills=allTripSegs.map((s,i)=>{
        const _sL=byId(DB.locations,s.sLoc),_dL=byId(DB.locations,s.dLoc);
        const _sc=_sL?.colour||'var(--accent)',_dc=_dL?.colour||'var(--accent)';
        return (i===0?`<span style="${_locPillStyle(_sL?.colour,13)}">${_sL?.name||'?'}</span>`:'')
          +`<span style="color:var(--accent);font-weight:900;font-size:14px;margin:0 3px">⟶</span>`
          +`<span style="${_locPillStyle(_dL?.colour,13)}">${_dL?.name||'?'}</span>`;
      }).join('');
      const _apBu=byId(DB.users,trip?.bookedBy);
      const _apBookedFirst=(_apBu?.fullName||_apBu?.name||'').split(' ')[0]||'';
      const _apTripDate=trip?.date?new Date(trip.date):null;
      const _apShortDate=_apTripDate?_apTripDate.getDate()+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][_apTripDate.getMonth()]:'';
      const _apBookedLine=(_apBookedFirst?`<span style="font-size:11px;color:var(--text2);font-weight:600">By: ${_apBookedFirst}</span>`:'')+(_apShortDate?`<span style="font-size:11px;color:var(--text3)">on ${_apShortDate}</span>`:'');
      return `<div style="margin-bottom:8px">
        <!-- COMPACT CARD -->
        <div style="padding:0;overflow:hidden;cursor:pointer;border:2px solid #000;border-radius:10px;transition:box-shadow .15s;background:#fff" onclick="_openPop('${_apPopId}')" onmouseover="this.style.boxShadow='0 4px 18px rgba(0,0,0,.12)'" onmouseout="this.style.boxShadow=''">
          <div style="display:flex;align-items:center;gap:8px;padding:8px 12px 4px;flex-wrap:nowrap;min-width:0">
            <span style="font-family:var(--mono);font-size:21px;font-weight:900;color:#fff;background:var(--accent);padding:2px 10px;border-radius:8px;flex-shrink:0;white-space:nowrap">${_cTid(tripId)}</span>
            <span style="font-family:var(--mono);font-size:clamp(18px,5vw,35px);font-weight:900;color:var(--text);background:#fef08a;border:2px solid #ca8a04;border-radius:8px;padding:2px 10px;flex-shrink:0;white-space:nowrap">${vnum(trip?.vehicleId)}</span>
            ${isRejectedTrip?'<span style="font-size:10px;font-weight:800;color:#dc2626;background:#fef2f2;border:1px solid #fca5a5;padding:1px 6px;border-radius:4px">⚠ Rejected</span>':''}
            <div style="flex:1"></div>
            ${costBadge}
            <span style="font-size:18px;color:var(--text3);font-weight:300;flex-shrink:0">›</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;padding:2px 12px 4px;flex-wrap:wrap">${_apBookedLine}</div>
          <div style="padding:0 12px 8px;display:flex;flex-wrap:wrap;gap:3px;align-items:center">${_apRoutePills}</div>
        </div>
        <!-- POPUP OVERLAY -->
        <div id="${_apPopId}" style="display:none;position:fixed;inset:0;z-index:100000;background:rgba(30,40,70,.55);align-items:center;justify-content:center;padding:12px" onclick="if(event.target===this)_closePop('${_apPopId}')">
          <div style="background:#fff;border:2px solid #000;border-radius:16px;max-width:580px;width:100%;max-height:calc(100vh - 24px);overflow-y:auto;box-shadow:0 8px 48px rgba(0,0,0,.35)">
            <div style="padding:14px 16px 10px;border-bottom:1px solid var(--border);position:sticky;top:0;background:#fff;z-index:1;border-radius:16px 16px 0 0">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <span style="font-family:var(--mono);font-size:28px;font-weight:900;color:#fff;background:var(--accent);padding:4px 14px;border-radius:10px">${_cTid(tripId)}</span>
                <span style="font-family:var(--mono);font-size:28px;font-weight:900;color:var(--text);background:#fef08a;border:2px solid #ca8a04;padding:4px 14px;border-radius:10px">${vnum(trip?.vehicleId)}</span>
              </div>
              <div style="margin-top:6px;display:flex;gap:6px;font-size:12px;flex-wrap:wrap;align-items:center"><span style="color:var(--text3)">Booked by:</span><span style="font-weight:700">${bookedBy}</span><span style="color:var(--border2)">·</span><span style="color:var(--text3)">📅 ${fdt(trip?.date||'')}</span></div>
              ${rate?`<div style="margin-top:6px;font-family:var(--mono);font-size:20px;font-weight:900;color:#16a34a">💰 ₹${rate.rate.toLocaleString()}</div>`:''}
              <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:3px;align-items:center">${_apRoutePills}</div>
            </div>
            <div style="padding:12px 16px">
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">${allSegDetails}</div>
              ${rejNote}
              ${(()=>{
                const _tripSegs=DB.segments.filter(s=>s.tripId===tripId);
                const _mrPendingSegs=_tripSegs.filter(s=>s.status!=='Completed'&&s.status!=='Locked'&&!s.steps[3]?.skip&&!s.steps[3]?.done);
                const _mrBlocked=_mrPendingSegs.length>0;
                const _disabledStyle=_mrBlocked?'opacity:.45;cursor:not-allowed;filter:grayscale(.5)':'';
                const _blockNote=_mrBlocked
                  ?`<div style="font-size:11px;font-weight:700;color:#b45309;background:#fef9c3;border:1.5px solid #fde047;border-radius:7px;padding:6px 10px;display:flex;align-items:center;gap:6px">
                      ⏳ Waiting for Material Receipt on ${_mrPendingSegs.length} segment(s) before approval is allowed
                    </div>`
                  :'';
                return `<div style="border-top:2px solid var(--accent);padding-top:10px;margin-top:6px;display:flex;flex-direction:column;gap:6px" onclick="event.stopPropagation()">
                  ${_blockNote}
                  <input type="text" id="rem_trip_${tripId}" placeholder="Remarks (optional)…"
                    style="background:#fffbeb;border:2px solid var(--accent);border-radius:var(--radius);padding:8px 10px;font-size:13px;color:var(--text);font-family:inherit;width:100%;box-sizing:border-box${_mrBlocked?';opacity:.5':''}">
                  <div style="display:flex;gap:8px;justify-content:flex-end">
                    <button class="btn btn-danger" style="padding:8px 22px;font-size:13px;font-weight:800;border-radius:8px;${_disabledStyle}"
                      ${_mrBlocked?'disabled':''} onclick="doTripApprovalInline('${tripId}','reject')">✗ Reject</button>
                    <button class="btn btn-green" style="padding:8px 22px;font-size:13px;font-weight:800;border-radius:8px;${_disabledStyle}"
                      ${_mrBlocked?'disabled':''} onclick="doTripApprovalInline('${tripId}','approve')">✓ Approve</button>
                    <button onclick="_closePop('${_apPopId}')" style="width:48px;flex-shrink:0;font-size:20px;font-weight:900;background:var(--surface2);border:2px solid var(--border2);border-radius:8px;cursor:pointer;color:var(--text2);display:flex;align-items:center;justify-content:center" title="Close">✕</button>
                  </div>
                </div>`;
              })()}
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // Completed with date filter — grouped by base trip ID
  // Include segments where step 4 is approved (even if step 5 still pending)
  const fromVal=document.getElementById('approveFrom')?.value||'';
  const toVal=document.getElementById('approveTo')?.value||'';
  let comp=DB.segments.filter(s=>{
    if(!s.steps[4]?.done) return false; // step 4 must be approved
    if(isSA) return true;
    return _apTripIds.has(s.tripId)||s.steps[4]?.by===CU.id;
  });
  if(fromVal)comp=comp.filter(s=>(s.steps[4]?.time||'').slice(0,10)>=fromVal);
  if(toVal)comp=comp.filter(s=>(s.steps[4]?.time||'').slice(0,10)<=toVal);
  if(apSearch) comp=comp.filter(s=>s.tripId.toLowerCase().includes(apSearch)||vnum(byId(DB.trips,s.tripId)?.vehicleId).toLowerCase().includes(apSearch));

  // Group by base trip ID (strip -R1, -R2 suffix for grouping)
  const baseTripId=tid=>tid.replace(/-R\d+$/,'');
  const grouped={};
  comp.forEach(s=>{
    const base=baseTripId(s.tripId);
    if(!grouped[base])grouped[base]=[];
    grouped[base].push(s);
  });

  // Sort groups by latest completion time descending
  const sortedGroups=Object.entries(grouped).sort(([,a],[,b])=>{
    const ta=Math.max(...a.map(s=>s.steps[4]?.time?new Date(s.steps[4].time).getTime():0));
    const tb=Math.max(...b.map(s=>s.steps[4]?.time?new Date(s.steps[4].time).getTime():0));
    return tb-ta;
  });

  let totalAmt=0;const canSeeAmt=CU.roles.some(r=>['Super Admin','Admin','Trip Approver'].includes(r));
  const fmtAp=t=>t?new Date(t).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'})+' '+new Date(t).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true}):'—';

  const apThSm=(src,clr,sz)=>{const s=sz||36;return src
    ?(src.startsWith('data:application/pdf')
      ?`<div style="width:${s}px;height:${s}px;border-radius:5px;border:2px solid ${clr};background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer" onclick="openPhoto('${src}')">📄</div>`
      :`<img src="${src}" onclick="openPhoto(this.src)" style="width:${s}px;height:${s}px;object-fit:cover;border-radius:5px;border:2px solid ${clr};cursor:pointer">`)
    :`<div style="width:${s}px;height:${s}px;border-radius:5px;border:2px dashed var(--border2);background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--border2)">📷</div>`;};

  const rows=sortedGroups.map(([baseId,segs],gi)=>{
    segs.sort((a,b)=>a.label.localeCompare(b.label));
    const latestTripId=segs.reduce((acc,s)=>s.tripId>acc?s.tripId:acc,segs[0].tripId);
    const t=byId(DB.trips,latestTripId);
    const rate=canSeeAmt?getMatchedRate(latestTripId):null;
    if(rate)totalAmt+=rate.rate;
    const approverUser=byId(DB.users,segs[segs.length-1].steps[4]?.by);
    const approverName=approverUser?.fullName||approverUser?.name||'—';
    const bookedByUser=byId(DB.users,t?.bookedBy);
    const bookedByName=bookedByUser?.fullName||bookedByUser?.name||'—';
    const closedOn=fmtAp(segs[segs.length-1].steps[4]?.time);
    const hasRevision=segs.some(s=>/-R\d+$/.test(s.tripId));
    const revBadge=hasRevision?`<span style="font-size:9px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:3px;font-weight:700">AMENDED</span>`:'';

    const segCards=segs.map(s=>{
      const idx=s.label==='A'?1:s.label==='B'?2:3;
      const challans=t?.['challans'+idx]||[];
      const legCh=t?.['challan'+idx]||'';const legWt=t?.['weight'+idx]||'';const legPh=t?.['photo'+idx]||'';
      const chRows=challans.filter(c=>c.no||c.weight||c.photo).length
        ?challans.filter(c=>c.no||c.weight||c.photo)
        :legCh?[{no:legCh,weight:legWt,photo:legPh}]:[];
      const segClr={A:'#35b0b6',B:'#14b8a6',C:'#8b5cf6'}[s.label]||'var(--accent)';
      const dLoc=byId(DB.locations,s.dLoc);
      const dBg=dLoc?.colour?dLoc.colour+'18':'var(--surface2)';
      const dBorder=dLoc?.colour||'var(--border)';
      const exitPh=s.steps[1]?.photo||'';const entryPh=s.steps[2]?.photo||'';
      // MR info
      const mrDone=s.steps[3]?.done;
      const mrUser=mrDone?byId(DB.users,s.steps[3].by):null;
      const mrName=mrUser?.fullName||mrUser?.name||'—';
      const mrDiscrep=s.steps[3]?.discrepancy;
      const mrNotRcvd=s.steps[3]?.notReceived;
      const mrRem=(s.steps[3]?.remarks||'').replace(/^\[(Discrepancy|Not Received)\]\s*/,'');
      const mrBlock=mrDone?(mrNotRcvd
        ?`<div style="margin-top:5px;padding:5px 8px;background:#fee2e2;border:1.5px solid #fca5a5;border-radius:6px;font-size:10px;color:#dc2626;font-weight:700">✗ Not Received — ${mrName}${mrRem?' · '+mrRem:''}</div>`
        :mrDiscrep
          ?`<div style="margin-top:5px;padding:5px 8px;background:#fff7ed;border:1.5px solid #fb923c;border-radius:6px;font-size:10px;color:#c2410c;font-weight:700">⚠ Discrepancy — ${mrName}${mrRem?' · <em style="font-weight:400">'+mrRem+'</em>':''}</div>`
          :`<div style="margin-top:5px;padding:3px 8px;background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:5px;font-size:10px;color:#15803d">✅ Rcvd by ${mrName} · ${fmtAp(s.steps[3].time)}</div>`)
        :`<div style="margin-top:5px;padding:3px 8px;background:#fef9c3;border:1px solid #fde047;border-radius:5px;font-size:10px;color:#854d0e">⏳ MR Pending</div>`;
      const apSegPills=(()=>{const lf=byId(DB.locations,s.sLoc),lt=byId(DB.locations,s.dLoc);const cf=lf?.colour||'var(--accent)',ct=lt?.colour||'var(--accent)';return `<span style="${_locPillStyle(lf?.colour,9)}">${lf?.name||'?'}</span><span style="color:var(--accent);font-weight:900;font-size:10px;margin:0 2px">⟶</span><span style="${_locPillStyle(lt?.colour,9)}">${lt?.name||'?'}</span>`;})();
      return `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:7px 9px;margin-bottom:5px">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:5px">
          <span style="width:18px;height:18px;border-radius:50%;background:${segClr};color:#fff;font-size:8px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${s.label}</span>
          ${apSegPills}
        </div>
        ${chRows.length?`<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:5px">`+chRows.map((ch,ci)=>`<div style="display:flex;align-items:center;gap:5px;background:#fff;border:1.5px solid #7c3aed33;border-radius:7px;padding:4px 8px;flex:1;min-width:110px">${apThSm(ch.photo||'','#7c3aed',32)}<div style="flex:1;min-width:0"><div style="font-size:8px;font-weight:700;color:#7c3aed;text-transform:uppercase">Ch${chRows.length>1?' '+(ci+1):''}</div><div style="font-size:11px;font-weight:800;color:var(--text);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ch.no||'—'}</div><div style="font-size:10px;font-weight:700;color:#16a34a;font-family:var(--mono)">${ch.weight||'—'}<span style="font-size:8px;color:var(--text3)"> kg</span></div></div></div>`).join('')+'</div>':''}
        <div style="display:flex;gap:8px;align-items:flex-start">
          <div style="display:flex;gap:6px;flex-shrink:0">
            <div style="display:flex;flex-direction:column;align-items:center;gap:2px">${apThSm(exitPh,'#2a9aa0',32)}<span style="font-size:7px;font-weight:700;color:#2a9aa0;text-transform:uppercase">Exit</span></div>
            <div style="display:flex;flex-direction:column;align-items:center;gap:2px">${apThSm(entryPh,'#0d9488',32)}<span style="font-size:7px;font-weight:700;color:#0d9488;text-transform:uppercase">Entry</span></div>
          </div>
          <div style="flex:1">${mrBlock}</div>
        </div>
      </div>`;
    }).join('');

    // Revoke button — within 24hrs of approval, for approver or SA/Admin
    const isSA_comp=CU.roles.some(r=>['Super Admin','Admin'].includes(r));
    const approvalTimeMs=Math.max(...segs.map(s=>s.steps[4]?.time?new Date(s.steps[4].time).getTime():0));
    const hrsSince_comp=(Date.now()-approvalTimeMs)/3600000;
    const hrsLeft=Math.max(0,24-hrsSince_comp);
    const iDidApprove=segs.some(s=>s.steps[4]?.by===CU.id);
    const canRevoke=(isSA_comp||iDidApprove)&&hrsLeft>0;
    const revokeBtn=canRevoke
      ?`<button onclick="revokeApproval('${baseId}')" style="background:none;border:1.5px solid #ef4444;color:#ef4444;border-radius:6px;padding:3px 9px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0" title="Revoke approval">↩ Revoke <span style="font-size:9px;font-weight:600;opacity:.85">${hrsLeft<1?Math.ceil(hrsLeft*60)+'m':hrsLeft.toFixed(1)+'h'} left</span></button>`
      :'';
    const cardId='apcard_'+baseId.replace(/[^a-z0-9]/gi,'_');

    // Build coloured route pills for outer AP card
    const apRoutePills=(()=>{
      const locs=[t?.startLoc,t?.dest1,t?.dest2,t?.dest3].filter(Boolean);
      return locs.map((id,i)=>{
        const l=byId(DB.locations,id);const clr=l?.colour||'var(--accent)';
        return (i===0
          ?`<span style="${_locPillStyle(l?.colour,13)}">${l?.name||'?'}</span>`
          :'')+
          (i<locs.length-1
            ?`<span style="color:var(--accent);font-weight:900;font-size:14px;margin:0 3px">⟶</span>`+
              (()=>{const nl=byId(DB.locations,locs[i+1]);const nc=nl?.colour||'var(--accent)';return `<span style="${_locPillStyle(nl?.colour,13)}">${nl?.name||'?'}</span>`;})()
            :'');
      }).join('');
    })();

    return `<div class="seg-card" style="padding:0;overflow:hidden;cursor:pointer;border:none;background:var(--surface);border:1.5px solid var(--border);border-radius:10px;margin-bottom:8px;position:relative;padding-left:26px" onclick="toggleApCard('${cardId}')">
      <div style="position:absolute;left:0;top:0;bottom:0;width:26px;background:rgba(0,0,0,0.28);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;color:#fff;user-select:none">${sortedGroups.length-gi}</div>
      <!-- Line 1: Trip ID + Vehicle -->
      <div style="display:flex;align-items:center;gap:6px;padding:7px 10px 3px;min-width:0">
        <span style="font-family:var(--mono);font-size:20px;font-weight:800;color:#fff;background:var(--accent);padding:3px 9px;border-radius:6px;flex-shrink:0;letter-spacing:.4px">${baseId}</span>
        ${revBadge}
        <span style="font-family:var(--mono);font-size:20px;font-weight:800;color:var(--text);background:#fef08a;border:1.5px solid #ca8a04;border-radius:6px;padding:2px 8px;flex-shrink:0">${vnum(t?.vehicleId)}</span>
        ${rate&&canSeeAmt?`<span style="font-size:12px;font-weight:800;color:#16a34a;font-family:var(--mono)">₹${rate.rate.toLocaleString()}</span>`:''}
      </div>
      <!-- Line 2: Coloured route pills -->
      <div style="padding:2px 10px 8px;display:flex;flex-wrap:wrap;gap:3px;align-items:center">${apRoutePills}</div>
      <!-- Expanded details -->
      <div id="${cardId}" style="display:none;border-top:1px solid var(--border)" onclick="event.stopPropagation()">
        <!-- Meta row -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:10px;background:rgba(0,0,0,0.04);padding:5px 10px">
          <div><span style="color:var(--text3)">Booked by </span><span style="font-weight:700;color:var(--text2)">${bookedByName}</span></div>
          <div style="width:1px;background:var(--border);align-self:stretch"></div>
          <div><span style="color:var(--text3)">Approved by </span><span style="font-weight:700;color:#16a34a">${approverName}</span></div>
          <div style="width:1px;background:var(--border);align-self:stretch"></div>
          <div><span style="color:var(--text3)">📅 </span><span style="font-weight:600;color:var(--text2)">${closedOn}</span></div>
          ${revokeBtn?`<div style="margin-left:auto">${revokeBtn}</div>`:''}
        </div>
        <!-- Segment cards -->
        <div style="padding:8px 10px">
          ${segCards}
        </div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('completedBody').innerHTML=rows||'<div class="empty-state">No completed trips in selected period</div>';

  const totalRow=document.getElementById('completedTotal');
  const totalAmtEl=document.getElementById('completedTotalAmt');
  if(totalRow&&totalAmtEl&&canSeeAmt&&totalAmt>0){
    totalAmtEl.textContent='₹'+totalAmt.toLocaleString();
    totalRow.style.display='';
  } else if(totalRow){
    totalRow.style.display='none';
  }
}

function toggleApCard(id){
  const el=document.getElementById(id);
  if(!el)return;
  const open=el.style.display!=='none';
  el.style.display=open?'none':'block';
}
function revokeApproval(baseId){
  const isSA=CU.roles.some(r=>['Super Admin','Admin'].includes(r));
  const segs=DB.segments.filter(s=>s.tripId===baseId||s.tripId.replace(/-R\d+$/,'')===baseId);
  if(!segs.length){notify('⚠ No segments found for trip '+baseId,true);return;}
  const approvedSegs=segs.filter(s=>s.steps[4]?.time);
  const latestApprovalTime=approvedSegs.length?Math.max(...approvedSegs.map(s=>new Date(s.steps[4].time).getTime())):0;
  const hrsSince=latestApprovalTime?(Date.now()-latestApprovalTime)/3600000:999;
  if(hrsSince>24&&!isSA){notify('⚠ 24-hour revoke window has passed ('+hrsSince.toFixed(1)+'h ago).',true);return;}
  const iDidApprove=segs.some(s=>s.steps[4]?.by===CU.id);
  if(!isSA&&!iDidApprove){notify('⚠ Only the approver or Admin can revoke.',true);return;}
  // Open modal instead of browser confirm (browser confirm can be silently blocked)
  document.getElementById('revokeBaseId').value=baseId;
  document.getElementById('revokeBaseIdDisplay').textContent=baseId;
  om('mRevokeConfirm');
}
async function _doRevoke(){
  const baseId=document.getElementById('revokeBaseId').value;
  if(!baseId){cm('mRevokeConfirm');return;}
  const segs=DB.segments.filter(s=>s.tripId===baseId||s.tripId.replace(/-R\d+$/,'')===baseId);
  if(!segs.length){notify('⚠ No segments found.',true);cm('mRevokeConfirm');return;}
  for(const s of segs){
    const s4=s.steps[4]||s.steps['4'];
    if(s4){s4.done=false;s4.time=null;s4.by=null;s4.remarks='';s4.rejected=false;}
    s.status='Active';
    s.currentStep=4;
    if(!await _dbSave('segments',s)) return;
  }
  cm('mRevokeConfirm');
  notify('↩ Approval revoked — trip '+baseId+' returned to pending ('+segs.length+' segment(s) reset).');
  renderApprove();updBadges();
}
async function doApproval(action){
  try{
    const seg=byId(DB.segments,document.getElementById('appSegId').value);
    const rem=document.getElementById('appRem').value;
    const _segBak=JSON.parse(JSON.stringify(seg));
    if(action==='approve'){
      seg.steps[4].done=true;seg.steps[4].rejected=false;seg.steps[4].time=new Date().toISOString();seg.steps[4].by=CU.id;seg.steps[4].remarks=rem;
      seg.status='Active';await advance(seg);if(!await _dbSave('segments',seg)){Object.assign(seg,_segBak);return;}notify('Trip segment approved and closed!');
    } else {
      seg.steps[4].done=false;seg.steps[4].rejected=true;seg.steps[4].remarks=rem;seg.steps[4].by=CU.id;
      seg.status='Rejected';if(!await _dbSave('segments',seg)){Object.assign(seg,_segBak);return;}notify('Trip segment rejected.');
    }
    cm('mApprove');renderApprove();renderTripBooking();updBadges();
  }catch(e){ console.error('doApproval error:',e); notify('⚠ Approval error: '+e.message,true); }
}


async function acceptRejectedTrip(tripId){
  const isSA=CU.roles.includes('Super Admin')||CU.roles.includes('Admin');
  if(!isSA){notify('⚠ Only Admin or Super Admin can accept a rejected trip.',true);return;}
  const rem=(document.getElementById('rem_rej_'+tripId)?.value||'').trim();
  const tripSegs=DB.segments.filter(s=>s.tripId===tripId);
  const toSave=[];
  for(const seg of tripSegs){
    if(seg.status!=='Rejected') continue;
    const s4=seg.steps[4]||seg.steps['4'];
    if(s4){s4.done=true;s4.rejected=false;s4.time=new Date().toISOString();s4.by=CU.id;s4.remarks='[Admin Override] '+rem;}
    seg.status='Active';
    await advance(seg);
    toSave.push(seg);
  }
  for(const seg of toSave){
    if(!await _dbSave('segments',seg)) return;
  }
  notify(`Trip ${tripId} accepted by admin override.`);
  renderApprove();updBadges();
}
async function doTripApprovalInline(tripId, action, receiptType){
  try{
  const tripSegs=DB.segments.filter(s=>s.tripId===tripId);
  const rem=(document.getElementById('rem_trip_'+tripId)?.value||'').trim();
  if(action==='approve'){
    // Block if any non-skipped segment hasn't completed MR (step 3)
    const mrPending=tripSegs.filter(s=>s.status!=='Completed'&&s.status!=='Locked'&&!s.steps[3]?.skip&&!s.steps[3]?.done);
    if(mrPending.length){
      notify(`⚠ Cannot approve — material receipt pending for ${mrPending.length} segment(s). All receipts must be acknowledged first.`,true);
      return;
    }
    // Collect segments to save BEFORE advance() potentially sets status='Completed'
    const toSave=[];
    const backups=[];
    for(const seg of tripSegs){
      if(seg.status==='Completed') continue;
      if(seg.steps[4]?.done||seg.steps[4]?.skip) continue;
      backups.push({seg, snap:JSON.parse(JSON.stringify(seg))});
      seg.steps[4].done=true;seg.steps[4].rejected=false;seg.steps[4].time=new Date().toISOString();seg.steps[4].by=CU.id;seg.steps[4].remarks=rem;
      seg.status='Active';
      await advance(seg); // may change status to 'Completed'
      toSave.push(seg);   // save regardless of new status
    }
    const remaining=tripSegs.filter(s=>s.status!=='Completed'&&s.currentStep<4).length;
    for(let i=0;i<toSave.length;i++){
      if(!await _dbSave('segments',toSave[i])){
        // Rollback all
        backups.forEach(({seg,snap})=>Object.assign(seg,snap));
        return;
      }
    }
    if(remaining>0) notify(`${toSave.length} segment(s) approved — ${remaining} still awaiting material receipt`);
    else notify(`Trip ${tripId} approved — all segments closed!`);
  } else {
    const toSave=[];
    const backups=[];
    for(const seg of tripSegs){
      if(seg.status==='Completed') continue;
      backups.push({seg, snap:JSON.parse(JSON.stringify(seg))});
      seg.steps[4].done=false;seg.steps[4].rejected=true;seg.steps[4].remarks=rem;seg.steps[4].by=CU.id;
      seg.status='Rejected';
      toSave.push(seg);
    }
    for(let i=0;i<toSave.length;i++){
      if(!await _dbSave('segments',toSave[i])){
        backups.forEach(({seg,snap})=>Object.assign(seg,snap));
        return;
      }
    }
    notify(`Trip ${tripId} rejected.`);
  }
  renderApprove();updBadges();renderDash();
  }catch(e){ console.error('doTripApprovalInline error:',e); notify('⚠ Approval error: '+e.message,true); }
}

// ═══ MASTERS (vehicle types, vendors, drivers, vehicles, locations, rates) ═
// Users
function renderUsers(){
  const srch=(document.getElementById('userSearch')?.value||'').toLowerCase();
  const _isViewerSA=CU?.roles?.includes('Super Admin');
  let rows=[...DB.users]
    .filter(u=>_isViewerSA||!(u.roles||[]).includes('Super Admin'))
    .sort((a,b)=>(a.fullName||a.name).localeCompare(b.fullName||b.name));
  if(srch)rows=rows.filter(u=>(u.fullName||'').toLowerCase().includes(srch)||(u.name||'').toLowerCase().includes(srch));
  document.getElementById('userBody').innerHTML=rows.filter(u=>!document.getElementById('showInactiveUsers')?.checked||!u.inactive).map(u=>{
    // Look up location from DB.locations first, fallback to PLANTS
    const loc=byId(DB.locations,u.plant);
    const pl=!loc?PLANTS.find(p=>p&&p.value===u.plant):null;
    const locBadge=loc
      ?(loc.colour?`<span style="background:${loc.colour};color:${colourContrast(loc.colour)};padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px">${loc.name}</span>`:loc.name)
      :(pl?`<span style="background:${pl.colour||'var(--surface2)'};color:${colourContrast(pl.colour||'')};padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px">${pl.label}</span>`:(u.plant||'-'));
    const isViewerSA=CU?.roles?.includes('Super Admin');
    const uInactive=u.inactive===true;
    const uInactiveBadge=uInactive?'<span style="font-size:9px;font-weight:700;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;margin-left:5px;border:1px solid #fca5a5">Inactive</span>':'';
    return `<tr class="clickable-row" onclick="showRecordDetail('users','${u.id}')" ${uInactive?'style="opacity:.55;background:rgba(239,68,68,.03)"':''}>
    <td onclick="event.stopPropagation()">${u.photo?`<img src="${u.photo}" onclick="openPhoto(this.src)" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid var(--border2);cursor:pointer">`:`<div style="width:32px;height:32px;border-radius:50%;background:var(--surface2);border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--text3)">👤</div>`}</td>
    <td style="font-weight:600">${u.fullName||'-'}${uInactiveBadge}</td>
    <td style="font-family:var(--mono);font-size:12px">${u.name}</td>
    <td>${locBadge}</td>
    <td>${(u.apps||[]).map(id=>{const a=PORTAL_APPS.find(x=>x.id===id);return a?`<span style="font-size:10px;background:#f0fafa;color:#2a9aa0;border:1px solid #b3dfe0;padding:1px 6px;border-radius:4px;margin-right:2px">${a.icon} ${a.label}</span>`:'';}).join('')||'<span style="color:#94a3b8;font-size:11px">—</span>'}</td>
    <td>${u.roles.filter(r=>r!=='Super Admin'||isViewerSA).map(r=>r==='Super Admin'
      ?`<span class="badge" style="margin-right:3px;background:rgba(139,92,246,.18);color:var(--purple)">⭐ SA</span>`
      :`<span class="badge badge-blue" style="margin-right:3px">${r}</span>`).join('')}${(u.hwmsRoles||[]).length?'<br>'+u.hwmsRoles.map(r=>`<span class="badge" style="margin-right:3px;background:rgba(139,92,246,.12);color:#7c3aed;margin-top:2px">${r}</span>`).join(''):''}</td>
    <td style="white-space:nowrap" onclick="event.stopPropagation()"><button class="action-btn" onclick="openUserModal('${u.id}')">✏️</button>${!(u.roles||[]).includes('Super Admin')?`<button class="action-btn" onclick="_resetUserPwd('${u.id}')" title="Reset Password" style="color:#f59e0b">🔑</button>`:''}<button class="action-btn" onclick="del('users','${u.id}',renderUsers)">🗑️</button></td>
  </tr>`;
  }).join('')||'<tr><td colspan="10" class="empty-state" style="padding:32px;text-align:center;color:var(--text3);font-size:13px">No users found — <a href="#" onclick="event.preventDefault()" style="color:var(--accent)">check connection</a></td></tr>';
}
function openUserModal(id){
  const u=id?byId(DB.users,id):null;
  document.getElementById('eUid').value=id||'';
  document.getElementById('uNameI').value=u?.name||'';
  document.getElementById('uPass').value=u?.password||'';
  const kapLocs=DB.locations.filter(l=>l&&l.type==='KAP').sort((a,b)=>a.name.localeCompare(b.name));
  document.getElementById('uPlant').innerHTML='<option value="">-- Select Location --</option>'+kapLocs.map(l=>{
    const bg=l.colour?` style="background:${l.colour};color:${colourContrast(l.colour)}"`:'';
    return `<option value="${l.id}"${l.id===u?.plant?' selected':''}${bg}>${l.name}</option>`;
  }).join('');
  document.getElementById('uFullName').value=u?.fullName||'';
  document.getElementById('uMobile').value=u?.mobile||'';
  document.getElementById('mUserTitle').textContent=id?'Edit User':'Add User';
  const userApps=u?.apps||(u?['vms']:[]);
  _renderAppBoxes(userApps);
  rboxes(u?.roles||[]);
  _hwmsRboxes(u?.hwmsRoles||[]);
  _hrmsRboxes(u?.hrmsRoles||[]);
  _toggleVmsRolesSection(userApps.includes('vms'));
  _toggleHwmsRolesSection(userApps.includes('hwms'));
  _toggleHrmsRolesSection(userApps.includes('hrms'));
  const uICb=document.getElementById('uInactive');if(uICb)uICb.checked=u?.inactive===true;
  om('mUser');
}
function _renderAppBoxes(selectedApps){
  const isSA=CU?.roles?.includes('Super Admin');
  document.getElementById('appBoxes').innerHTML=PORTAL_APPS.map(a=>{
    const checked=selectedApps.includes(a.id);
    const bc=checked?'var(--accent)':'var(--border)';
    const bg=checked?'rgba(42,154,160,.07)':'var(--surface2)';
    return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:${bg};padding:4px 10px;border-radius:5px;border:1px solid ${bc}" onmouseenter="this.style.borderColor='var(--accent)'" onmouseleave="this.style.borderColor='${bc}'">
      <input type="checkbox" value="${a.id}" ${checked?'checked':''} style="width:auto" onchange="_onAppBoxChange(this)"> ${a.icon} ${a.label}</label>`;
  }).join('');
}
function _onAppBoxChange(cb){
  const sel=[...document.querySelectorAll('#appBoxes input:checked')].map(i=>i.value);
  // update colors
  cb.closest('label').style.background=cb.checked?'rgba(42,154,160,.07)':'var(--surface2)';
  cb.closest('label').style.borderColor=cb.checked?'var(--accent)':'var(--border)';
  _toggleVmsRolesSection(sel.includes('vms'));
  _toggleHwmsRolesSection(sel.includes('hwms'));
  _toggleHrmsRolesSection(sel.includes('hrms'));
}
function _toggleVmsRolesSection(show){
  const sec=document.getElementById('vmsRolesSection');
  if(sec) sec.style.display=show?'block':'none';
}
function _toggleHwmsRolesSection(show){
  const sec=document.getElementById('hwmsRolesSection');
  if(sec) sec.style.display=show?'block':'none';
}
function _toggleHrmsRolesSection(show){
  const sec=document.getElementById('hrmsRolesSection');
  if(sec) sec.style.display=show?'block':'none';
}
function _hrmsRboxes(sel){
  var el=document.getElementById('hrmsRoleBoxes');if(!el)return;
  el.innerHTML=(typeof HRMS_ROLES!=='undefined'?HRMS_ROLES:[]).map(function(r){
    var checked=(sel||[]).includes(r);
    var bg='rgba(34,197,94,.06)';
    var bc=checked?'#16a34a':'rgba(34,197,94,.25)';
    return '<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:'+bg+';padding:4px 10px;border-radius:5px;border:1px solid '+bc+'"><input type="checkbox" value="'+r+'" '+(checked?'checked':'')+' style="width:auto"> '+r+'</label>';
  }).join('');
}
function _hwmsRboxes(sel){
  document.getElementById('hwmsRoleBoxes').innerHTML=HWMS_ROLES.map(r=>{
    const checked=sel.includes(r);
    const bg='rgba(139,92,246,.06)';
    const bc=checked?'var(--purple)':'rgba(139,92,246,.25)';
    return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:${bg};padding:4px 10px;border-radius:5px;border:1px solid ${bc}" onmouseenter="this.style.borderColor='var(--purple)'" onmouseleave="this.style.borderColor='${bc}'"><input type="checkbox" value="${r}" ${checked?'checked':''} style="width:auto" onchange="_updateHwmsRoleBox(this)"> ${r}</label>`;
  }).join('');
}
function _updateHwmsRoleBox(input){
  const label=input.closest('label');
  const bc=input.checked?'var(--purple)':'rgba(139,92,246,.25)';
  label.style.borderColor=bc;
}
function rboxes(sel){
  const isSA=CU?.roles?.includes('Super Admin');
  // Only Super Admin can see/assign the 'Super Admin' role
  const visibleRoles=ROLES.filter(r=>r!=='Super Admin'||isSA);
  document.getElementById('roleBoxes').innerHTML=visibleRoles.map(r=>{
    const isSARole=r==='Super Admin';
    const checked=sel.includes(r);
    const bg=isSARole?'rgba(139,92,246,.08)':'var(--surface2)';
    const bc=checked?(isSARole?'var(--purple)':'var(--accent)'):(isSARole?'rgba(139,92,246,.3)':'var(--border)');
    return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:${bg};padding:4px 10px;border-radius:5px;border:1px solid ${bc}" onmouseenter="this.style.borderColor='${isSARole?'var(--purple)':'var(--accent)'}'"><input type="checkbox" value="${r}" ${checked?'checked':''} style="width:auto" onchange="updateRoleBox(this)"> ${isSARole?'⭐ ':''}${r}</label>`;
  }).join('');
}
function updateRoleBox(input){
  const label=input.closest('label');
  const isSARole=input.value==='Super Admin';
  const bc=input.checked?(isSARole?'var(--purple)':'var(--accent)'):(isSARole?'rgba(139,92,246,.3)':'var(--border)');
  label.style.borderColor=bc;
}
async function saveUser(){
  const id=document.getElementById('eUid').value;
  const name=document.getElementById('uNameI').value.trim().toLowerCase().replace(/[\s!@#$%^&*()+=\[\]{};':"\\|,.<>\/?]/g,'');
  const pass=document.getElementById('uPass').value;
  const plant=document.getElementById('uPlant').value;
  const fullName=document.getElementById('uFullName').value.trim();
  const mobile=document.getElementById('uMobile').value;
  const apps=[...document.querySelectorAll('#appBoxes input:checked')].map(i=>i.value);
  const roles=[...document.querySelectorAll('#roleBoxes input:checked')].map(i=>i.value);
  const hwmsRoles=[...document.querySelectorAll('#hwmsRoleBoxes input:checked')].map(i=>i.value);
  const hrmsRoles=[...document.querySelectorAll('#hrmsRoleBoxes input:checked')].map(i=>i.value);
  if(!name||!pass){modalErr('mUser','Username and password required');return;}
  if(!plant){modalErr('mUser','Location name is required');return;}
  if(!fullName){modalErr('mUser','Full name required');return;}
  if(!apps.length){modalErr('mUser','Select at least one app');return;}
  if(apps.includes('vms')&&!roles.length){modalErr('mUser','Select at least one VMS role');return;}
  if(apps.includes('hwms')&&!hwmsRoles.length){modalErr('mUser','Select at least one HWMS role');return;}
  if(apps.includes('hrms')&&!hrmsRoles.length){modalErr('mUser','Select at least one HRMS role');return;}
  // KAP Security is exclusive — cannot be combined with other roles
  if(roles.includes('KAP Security')&&roles.length>1){
    modalErr('mUser','KAP Security role cannot be combined with other roles');return;
  }
  if(mobile&&mobile.length!==10){modalErr('mUser','Mobile must be 10 digits');return;}
  // Guard: ensure at least 1 Super Admin always exists in the system
  const editingUser=id?byId(DB.users,id):null;
  const hadSA=editingUser?.roles?.includes('Super Admin');
  const willHaveSA=roles.includes('Super Admin');
  if(hadSA&&!willHaveSA){
    const otherSACount=DB.users.filter(u=>u.id!==id&&u.roles.includes('Super Admin')).length;
    if(otherSACount===0){modalErr('mUser','Cannot remove Super Admin role — at least 1 Super Admin must exist in the system.');return;}
  }
  // Check inactive duplicate
  if(!id){
    const _inactDupU=DB.users.find(u=>u&&u.name===name&&u.id!==id&&u.inactive===true);
    if(_inactDupU){modalErr('mUser',`Username "${name}" already exists in Inactive Records. Activate it to use.`);return;}
    const _inactDupFN=DB.users.find(u=>(u.fullName||'').trim().toLowerCase()===fullName.toLowerCase()&&u.id!==id&&u.inactive===true);
    if(_inactDupFN){modalErr('mUser',`"${fullName}" already exists in Inactive Records. Activate it to use.`);return;}
  }
  // Check duplicate username
  const dup=DB.users.find(u=>u&&u.name===name&&u.id!==id&&!u.inactive);
  if(dup){modalErr('mUser','Username already exists');return;}
  // Check duplicate full name
  const dupFN=DB.users.find(u=>(u.fullName||'').trim().toLowerCase()===fullName.toLowerCase()&&u.id!==id&&!u.inactive);
  if(dupFN){modalErr('mUser','Full name already exists');return;}
  const uInactive=document.getElementById('uInactive')?.checked===true;
  if(id){
    const _eu=byId(DB.users,id);
    const _backup={..._eu};
    Object.assign(_eu,{name,plant,fullName,mobile,roles,hwmsRoles,hrmsRoles,apps,inactive:uInactive});
    if(!await _dbSave('users',_eu)){ Object.assign(_eu,_backup); return; }
    if(pass) await _authSetPassword(_eu.id,pass);
  }
  else{const _u={id:'u'+uid(),name,plant,fullName,mobile,roles,hwmsRoles,hrmsRoles,apps,inactive:uInactive};if(!await _dbSave('users',_u)) return;await _authSetPassword(_u.id,pass||'Kappl@123');}
  cm('mUser');
  // Auto-sync user's roles into their plant location's role arrays
  const _savedId=id||(DB.users[DB.users.length-1]?.id);
  if(_savedId&&plant&&!uInactive) await _syncUserToLocation(_savedId,plant,roles);
  // If admin edited the current user's own record, sync CU immediately
  const _editedId=id||(DB.users[DB.users.length-1]?.id);
  if(CU && _editedId===CU.id){
    const _fresh=byId(DB.users,CU.id);
    if(_fresh) Object.assign(CU,{name:_fresh.name,fullName:_fresh.fullName,mobile:_fresh.mobile,email:_fresh.email,photo:_fresh.photo,roles:_fresh.roles,plant:_fresh.plant,apps:_fresh.apps,inactive:_fresh.inactive});
    _enrichCU();
    _refreshCurrentUserUI();
  }
  renderUsers();
  notify('Saved!');
}

// Vehicle Types
function renderVTypes(){
  document.getElementById('vtBody').innerHTML=[...DB.vehicleTypes].filter(v=>!document.getElementById('showInactiveVT')?.checked||!v.inactive).sort((a,b)=>a.name.localeCompare(b.name)).map(v=>{
    const inactive=v.inactive===true;
    const badge=inactive?'<span style="font-size:9px;font-weight:700;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;margin-left:4px;border:1px solid #fca5a5">Inactive</span>':'';
    return `<tr class="clickable-row" onclick="showRecordDetail('vehicleTypes','${v.id}')" ${inactive?'style="opacity:.6;background:rgba(239,68,68,.03)"':''}><td>${v.name}${badge}</td><td>${v.capacity.toLocaleString()}</td><td style="white-space:nowrap" onclick="event.stopPropagation()"><button class="action-btn" onclick="openVTModal('${v.id}')">✏️</button><button class="action-btn" onclick="del('vehicleTypes','${v.id}',renderVTypes)">🗑️</button></td></tr>`;
  }).join('')||'<tr><td colspan="10" class="empty-state" style="padding:32px;text-align:center;color:var(--text3);font-size:13px">No vehicle types found — <a href="#" onclick="event.preventDefault()" style="color:var(--accent)">check connection</a></td></tr>';
}
function openVTModal(id){
  const v=id?byId(DB.vehicleTypes,id):null;
  document.getElementById('eVTid').value=id||'';document.getElementById('vtNameI').value=v?.name||'';document.getElementById('vtCap').value=v?.capacity||'';
  const vtICb=document.getElementById('vtInactive');if(vtICb)vtICb.checked=v?.inactive===true;om('mVT');
}
async function saveVT(){
  const id=document.getElementById('eVTid').value;const name=document.getElementById('vtNameI').value.trim();const capacity=parseInt(document.getElementById('vtCap').value);
  if(!name||!capacity){modalErr('mVT','Fill all fields');return;}
  if(!id){
    const _inactVT=(DB.vehicleTypes||[]).find(v=>v&&v.name.toLowerCase()===name.toLowerCase()&&v.id!==id&&v.inactive===true);
    if(_inactVT){modalErr('mVT',`"${name}" already exists in Inactive Records. Activate it to use.`);return;}
  }
  if((DB.vehicleTypes||[]).find(v=>v&&v.name.toLowerCase()===name.toLowerCase()&&v.id!==id&&!v.inactive)){modalErr('mVT','Type name already exists');return;}
  const vtInactive=document.getElementById('vtInactive')?.checked===true;
  if(id){
    const _vt=byId(DB.vehicleTypes,id);const _vtBak={..._vt};
    Object.assign(_vt,{name,capacity,inactive:vtInactive});
    if(!await _dbSave('vehicleTypes',_vt)){ Object.assign(_vt,_vtBak); return; }
  }
  else{const _vt={id:'vt'+uid(),name,capacity,inactive:vtInactive};if(!await _dbSave('vehicleTypes',_vt)) return;}
  cm('mVT');renderVTypes();notify('Saved!');
}

// Drivers
function renderDrivers(){
  const _canEdit=CU&&CU.roles&&CU.roles.some(r=>['Super Admin','Admin','Trip Booking User','Material Receiver'].includes(r));
  const _bAddDrv=document.getElementById('btnAddDrv');if(_bAddDrv)_bAddDrv.style.display=_canEdit?'':'none';
  document.getElementById('drvBody').innerHTML=[...DB.drivers].filter(d=>!document.getElementById('showInactiveDrv')?.checked||!d.inactive).sort((a,b)=>a.name.localeCompare(b.name)).map(d=>{
    const inactive=d.inactive===true;
    const photoHtml=d.photo?`<img src="${d.photo}" onclick="openPhoto(this.src)" style="width:32px;height:32px;object-fit:cover;border-radius:50%;border:2px solid var(--border2);cursor:pointer${inactive?';filter:grayscale(1);opacity:.6':''}">`:'<span style="width:32px;height:32px;border-radius:50%;background:var(--surface2);display:inline-flex;align-items:center;justify-content:center;font-size:14px;color:var(--text3)">🧑</span>';
    const inactiveBadge=inactive?'<span style="font-size:9px;font-weight:700;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;margin-left:4px;border:1px solid #fca5a5">Inactive</span>':'';
    const trStyle=inactive?'style="opacity:.6;background:rgba(239,68,68,.03)"':'';
    return `<tr class="clickable-row" onclick="showRecordDetail('drivers','${d.id}')" ${trStyle}><td onclick="event.stopPropagation()">${photoHtml}</td><td style="font-weight:600">${d.name}${inactiveBadge}</td><td>${d.mobile||'-'}</td><td>${byId(DB.vendors,d.vendorId)?.name||'-'}</td><td>${dateStatusHtml(d.dlExpiry)}</td><td style="white-space:nowrap" onclick="event.stopPropagation()">${_canEdit?`<button class="action-btn" onclick="openDrvModal('${d.id}')">✏️</button><button class="action-btn" onclick="del('drivers','${d.id}',renderDrivers)">🗑️</button>`:'—'}</td></tr>`;
  }).join('')||'<tr><td colspan="10" class="empty-state" style="padding:32px;text-align:center;color:var(--text3);font-size:13px">No drivers found — <a href="#" onclick="event.preventDefault()" style="color:var(--accent)">check connection</a></td></tr>';
}
function openDrvModal(id){
  const d=id?byId(DB.drivers,id):null;
  document.getElementById('eDrvId').value=id||'';
  document.getElementById('drvName').value=d?.name||'';
  document.getElementById('drvMob').value=d?.mobile||'';
  document.getElementById('drvDL').value=d?.dlExpiry||'';
  document.getElementById('drvVendorS').innerHTML='<option value="">-- None --</option>'+sortBy(DB.vendors.filter(vn=>!vn.inactive||vn.id===d?.vendorId),v=>v.name).map(v=>`<option value="${v.id}"${v.id===d?.vendorId?' selected':''}>${v.name}${v.inactive?' (Inactive)':''}</option>`).join('');
  // Photo
  const thumb=document.getElementById('drvPhotoThumb');
  const clearBtn=document.getElementById('drvPhotoClear');
  const fileInput=document.getElementById('drvPhotoFile');
  if(fileInput){fileInput.value='';fileInput._data=null;}
  if(d?.photo){
    thumb.innerHTML=`<img src="${d.photo}" style="width:100%;height:100%;object-fit:cover">`;thumb.style.border='2px solid var(--green)';
    if(clearBtn)clearBtn.style.display='inline';
  } else {
    thumb.innerHTML='🧑';thumb.style.border='2px dashed var(--border2)';
    if(clearBtn)clearBtn.style.display='none';
  }
  const inactiveCb=document.getElementById('drvInactive');if(inactiveCb)inactiveCb.checked=d?.inactive===true;
  document.getElementById('mDrvTitle').textContent=id?'Edit Driver':'Add Driver';om('mDriver');
}
async function saveDriver(){
  const id=document.getElementById('eDrvId').value;const name=document.getElementById('drvName').value.trim();const mobile=document.getElementById('drvMob').value;const dlExpiry=document.getElementById('drvDL').value;const vendorId=document.getElementById('drvVendorS').value;
  const photoData=document.getElementById('drvPhotoFile')?._data;
  if(!name){modalErr('mDriver','Name required');return;}if(mobile&&mobile.length!==10){modalErr('mDriver','Mobile must be 10 digits');return;}
  if(!id){
    const _inactDrv=DB.drivers.find(d=>d&&d.name.trim().toLowerCase()===name.toLowerCase()&&d.id!==id&&d.inactive===true);
    if(_inactDrv){modalErr('mDriver',`"${name}" already exists in Inactive Records. Activate it to use.`);return;}
  }
  if(DB.drivers.find(d=>d&&d.name.trim().toLowerCase()===name.toLowerCase()&&d.id!==id&&!d.inactive)){modalErr('mDriver','Driver name already exists');return;}
  const inactive=document.getElementById('drvInactive')?.checked===true;
  if(id){
    const d=byId(DB.drivers,id);const _dBak={...d};
    Object.assign(d,{name,mobile,dlExpiry,vendorId,inactive});if(photoData!==undefined)d.photo=photoData;
    if(!await _dbSave('drivers',d)){ Object.assign(d,_dBak); return; }
  }
  else{const _d={id:'d'+uid(),name,mobile,dlExpiry,vendorId,photo:photoData||'',inactive};if(!await _dbSave('drivers',_d)) return;}
  cm('mDriver');renderDrivers();notify('Saved!');
}
function onDrvPhoto(input){
  const f=input.files[0];if(!f)return;
  const reader=new FileReader();
  reader.onload=e=>{
    input._data=e.target.result;
    const thumb=document.getElementById('drvPhotoThumb');
    if(thumb){thumb.innerHTML=`<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover">`;thumb.style.border='2px solid var(--green)';}
    document.getElementById('drvPhotoClear').style.display='inline';
    compressImage(f).then(c=>{input._data=c;}).catch(()=>{});
  };
  reader.readAsDataURL(f);
}
function clearDrvPhoto(){
  const thumb=document.getElementById('drvPhotoThumb');
  if(thumb){thumb.innerHTML='🧑';thumb.style.border='2px dashed var(--border2)';}
  document.getElementById('drvPhotoClear').style.display='none';
  const input=document.getElementById('drvPhotoFile');
  if(input){input.value='';input._data='';}
}

// Vendors
function renderVendors(){
  document.getElementById('vndBody').innerHTML=[...DB.vendors].filter(v=>!document.getElementById('showInactiveVnd')?.checked||!v.inactive).sort((a,b)=>a.name.localeCompare(b.name)).map(v=>{
    const inactive=v.inactive===true;
    const badge=inactive?'<span style="font-size:9px;font-weight:700;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;margin-left:4px;border:1px solid #fca5a5">Inactive</span>':'';
    const mu=v.userId?byId(DB.users,v.userId):null;
    const muHtml=mu?`<span style="font-size:11px;font-weight:600;color:var(--accent)">${mu.fullName||mu.name}</span>`:'<span style="color:var(--text3);font-size:11px">—</span>';
    return `<tr class="clickable-row" onclick="showRecordDetail('vendors','${v.id}')" ${inactive?'style="opacity:.6;background:rgba(239,68,68,.03)"':''}><td>${v.name}${badge}</td><td>${v.owner}</td><td>${v.contact||'-'}</td><td>${muHtml}</td><td>${v.address||'-'}</td><td style="white-space:nowrap" onclick="event.stopPropagation()"><button class="action-btn" onclick="openVndModal('${v.id}')">✏️</button><button class="action-btn" onclick="del('vendors','${v.id}',renderVendors)">🗑️</button></td></tr>`;
  }).join('')||'<tr><td colspan="10" class="empty-state" style="padding:32px;text-align:center;color:var(--text3);font-size:13px">No vendors found — <a href="#" onclick="event.preventDefault()" style="color:var(--accent)">check connection</a></td></tr>';
}
function openVndModal(id){
  const v=id?byId(DB.vendors,id):null;
  document.getElementById('eVndId').value=id||'';document.getElementById('vndName').value=v?.name||'';document.getElementById('vndOwner').value=v?.owner||'';document.getElementById('vndContact').value=v?.contact||'';document.getElementById('vndAddr').value=v?.address||'';
  const vndICb=document.getElementById('vndInactive');if(vndICb)vndICb.checked=v?.inactive===true;
  // Populate mapped user dropdown — show users with Vendor role not already mapped to another vendor
  const vndUserS=document.getElementById('vndUserS');
  const vendorUsers=DB.users.filter(u=>!u.inactive&&(u.roles||[]).includes('Vendor'));
  const alreadyMapped=DB.vendors.filter(vn=>vn.userId&&vn.id!==id).map(vn=>vn.userId);
  vndUserS.innerHTML='<option value="">-- None --</option>'+vendorUsers.filter(u=>!alreadyMapped.includes(u.id)||u.id===v?.userId).sort((a,b)=>(a.fullName||a.name).localeCompare(b.fullName||b.name)).map(u=>`<option value="${u.id}"${u.id===v?.userId?' selected':''}>${u.fullName||u.name} (@${u.name})</option>`).join('');
  document.getElementById('mVndTitle').textContent=id?'Edit Vendor':'Add Vendor';om('mVendor');
}
async function saveVendor(){
  const id=document.getElementById('eVndId').value;const name=document.getElementById('vndName').value.trim();const owner=document.getElementById('vndOwner').value.trim();const contact=document.getElementById('vndContact').value;const address=document.getElementById('vndAddr').value;const userId=document.getElementById('vndUserS').value;
  if(!name||!owner){modalErr('mVendor','Fill required fields');return;}if(contact&&contact.length!==10){modalErr('mVendor','Contact must be 10 digits');return;}
  if(!id){
    const _inactVnd=DB.vendors.find(v=>v&&v.name.trim().toLowerCase()===name.toLowerCase()&&v.id!==id&&v.inactive===true);
    if(_inactVnd){modalErr('mVendor',`"${name}" already exists in Inactive Records. Activate it to use.`);return;}
  }
  if(DB.vendors.find(v=>v&&v.name.trim().toLowerCase()===name.toLowerCase()&&v.id!==id&&!v.inactive)){modalErr('mVendor','Vendor name already exists');return;}
  // Check userId not already mapped to another vendor
  if(userId&&DB.vendors.find(v=>v.userId===userId&&v.id!==id)){modalErr('mVendor','This user is already mapped to another vendor');return;}
  const vndInactive=document.getElementById('vndInactive')?.checked===true;
  if(id){
    const _vn=byId(DB.vendors,id);const _vnBak={..._vn};
    Object.assign(_vn,{name,owner,contact,address,userId,inactive:vndInactive});
    if(!await _dbSave('vendors',_vn)){ Object.assign(_vn,_vnBak); return; }
  }
  else{const _vn={id:'vn'+uid(),name,owner,contact,address,userId,inactive:vndInactive};if(!await _dbSave('vendors',_vn)) return;}
  cm('mVendor');renderVendors();notify('Saved!');
}

// Vehicles
function renderVehicles(){
  const _canEdit=CU&&CU.roles&&CU.roles.some(r=>['Super Admin','Admin','Trip Booking User','Material Receiver'].includes(r));
  const _bAddVeh=document.getElementById('btnAddVeh');if(_bAddVeh)_bAddVeh.style.display=_canEdit?'':'none';
  document.getElementById('vehBody').innerHTML=[...DB.vehicles].filter(v=>!document.getElementById('showInactiveVeh')?.checked||!v.inactive).sort((a,b)=>a.number.localeCompare(b.number)).map(v=>{
    const inactive=v.inactive===true;
    const inactiveBadge=inactive?'<span style="font-size:9px;font-weight:700;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;margin-left:4px;border:1px solid #fca5a5">Inactive</span>':'';
    const trStyle=inactive?'style="opacity:.6;background:rgba(239,68,68,.03)"':'';
    return `<tr class="clickable-row" onclick="showRecordDetail('vehicles','${v.id}')" ${trStyle}><td style="font-family:var(--mono);font-size:13px;font-weight:900">${v.number}${inactiveBadge}</td><td>${vtname(v.typeId)}</td><td>${byId(DB.vendors,v.vendorId)?.name||'-'}</td><td>${dateStatusHtml(v.pucExpiry)}</td><td>${dateStatusHtml(v.rtpExpiry)}</td><td>${dateStatusHtml(v.insExpiry)}</td><td style="white-space:nowrap" onclick="event.stopPropagation()">${_canEdit?`<button class="action-btn" onclick="openVehModal('${v.id}')">✏️</button><button class="action-btn" onclick="del('vehicles','${v.id}',renderVehicles)">🗑️</button>`:'—'}</td></tr>`;
  }).join('')||'<tr><td colspan="10" class="empty-state" style="padding:32px;text-align:center;color:var(--text3);font-size:13px">No vehicles found — <a href="#" onclick="event.preventDefault()" style="color:var(--accent)">check connection</a></td></tr>';
}
// Global flag: when set, after saving a vehicle, auto-select it in trip booking form
let _vehFromTB=false;
// Called after new vehicle saved from Trip Booking — runs after all events settle
function _applyTBVehicle(vehId, typeId){
  // Enable vehicle section
  const vsSec=document.getElementById('tbVehicleSection');
  if(vsSec) vsSec.classList.remove('challan-section-disabled');
  // Ensure both type selectors have options
  const _vtOpts='<option value="">— Select Type —</option>'+sortBy((DB.vehicleTypes||[]).filter(vt=>!vt.inactive),vt=>vt.name).map(vt=>`<option value="${vt.id}">${vt.name}</option>`).join('');
  const actSel=document.getElementById('tbActualVType_sel');
  const recSel=document.getElementById('tbVehicleType_sel');
  if(actSel){
    if(actSel.options.length<2) actSel.innerHTML=_vtOpts;
    actSel.value=typeId;
  }
  if(recSel){
    if(recSel.options.length<2) recSel.innerHTML=_vtOpts;
    if(!recSel.value) recSel.value=typeId;
  }
  // Build vehicle dropdown directly (bypass filterActualVehicles which resets value)
  const vehSel=document.getElementById('tbVehicle');
  if(vehSel){
    const _vOfType=sortBy(DB.vehicles.filter(v=>!v.inactive&&v.typeId===typeId),v=>v.number);
    vehSel.innerHTML='<option value="">— Vehicle Number —</option>'+_vOfType.map(v=>`<option value="${v.id}"${v.id===vehId?' selected':''}>${v.number}</option>`).join('');
    vehSel.disabled=false;
    vehSel.value=vehId;
    // Green flash to confirm
    vehSel.style.transition='box-shadow .25s,border-color .25s';
    vehSel.style.boxShadow='0 0 0 3px rgba(34,197,94,.55)';
    vehSel.style.borderColor='#16a34a';
    setTimeout(()=>{if(vehSel){vehSel.style.boxShadow='';vehSel.style.borderColor='';}},1400);
  }
  if(typeof autoVendor==='function') autoVendor();
  if(typeof updateTbPrompt==='function') updateTbPrompt();
  notify('✅ Vehicle added and selected in booking form!');
}
function openVehModalFromTB(){
  // Pre-fill vehicle type from currently selected actual type in the booking form
  const actTypeId=document.getElementById('tbActualVType_sel')?.value||'';
  _vehFromTB=true;
  openVehModal(null);
  // Pre-select the type that's already chosen in the booking form
  if(actTypeId){
    const vts=document.getElementById('vehTypeS');
    if(vts)vts.value=actTypeId;
  }
  // Update modal title to make context clear
  document.getElementById('mVehTitle').textContent='Add Vehicle (for Trip Booking)';
}
function openVehModal(id){
  const v=id?byId(DB.vehicles,id):null;
  document.getElementById('eVehId').value=id||'';
  document.getElementById('vehTypeS').innerHTML='<option value="">-- Select --</option>'+sortBy(DB.vehicleTypes||[],t=>t.name).map(t=>`<option value="${t.id}"${t.id===v?.typeId?' selected':''}>${t.name}</option>`).join('');
  document.getElementById('vehVendorS').innerHTML='<option value="">-- Select --</option>'+sortBy(DB.vendors.filter(vn=>!vn.inactive||vn.id===v?.vendorId),t=>t.name).map(t=>`<option value="${t.id}"${t.id===v?.vendorId?' selected':''}>${t.name}${t.inactive?' (Inactive)':''}</option>`).join('');
  document.getElementById('vehNumI').value=v?.number||'';document.getElementById('vehPUC').value=v?.pucExpiry||'';document.getElementById('vehRTP').value=v?.rtpExpiry||'';
document.getElementById('vehIns').value=v?.insExpiry||'';
  const vehInactiveCb=document.getElementById('vehInactive');if(vehInactiveCb)vehInactiveCb.checked=v?.inactive===true;
  document.getElementById('mVehTitle').textContent=id?'Edit Vehicle':'Add Vehicle';om('mVehicle');
}
function fmtVehNum(el){
  // Enforce format: AA00-AA-0000 (2 alpha, 2 digit, hyphen, 1-2 alpha, hyphen, 1-4 digit)
  let raw=el.value.replace(/[^a-zA-Z0-9]/g,'').toUpperCase();
  let out='';
  for(let i=0;i<raw.length&&out.replace(/-/g,'').length<10;i++){
    const pos=out.replace(/-/g,'').length;
    const ch=raw[i];
    if(pos<2){if(/[A-Z]/.test(ch))out+=ch;} // pos 0-1: alpha only
    else if(pos<4){if(/[0-9]/.test(ch))out+=ch;} // pos 2-3: digit only
    else if(pos<6){if(/[A-Z]/.test(ch))out+=ch;} // pos 4-5: alpha only
    else if(pos<10){if(/[0-9]/.test(ch))out+=ch;} // pos 6-9: digit only
    // Insert hyphens
    const newPos=out.replace(/-/g,'').length;
    if(newPos===4&&!out.endsWith('-'))out+='-';
    if(newPos===6&&out.split('-').length<3)out+='-';
  }
  el.value=out;
}
// On blur: pad last 4 digits with leading zeros
document.addEventListener('focusout',function(e){
  if(e.target&&(e.target.id==='vehNumI'||e.target.id==='spotVehNum'||e.target.id==='seVehNum')){
    const v=e.target.value;
    const m=v.match(/^([A-Z]{2})(\d{2})-([A-Z]{1,2})-(\d{1,4})$/);
    if(m){e.target.value=m[1]+m[2]+'-'+m[3]+'-'+m[4].padStart(4,'0');}
  }
});
async function saveVehicle(){
  const id=document.getElementById('eVehId').value;
  const number=document.getElementById('vehNumI').value.trim().toUpperCase();
  const typeId=document.getElementById('vehTypeS').value;const vendorId=document.getElementById('vehVendorS').value;const pucExpiry=document.getElementById('vehPUC').value;const rtpExpiry=document.getElementById('vehRTP').value;const insExpiry=document.getElementById('vehIns').value;
  if(!number||!typeId||!vendorId){modalErr('mVehicle','Fill required fields');return;}
  // Validate format AA00-AA-0000 (2 alpha, 2 digit, 1-2 alpha, 4 digit)
  if(!/^[A-Z]{2}\d{2}-[A-Z]{1,2}-\d{4}$/.test(number)){modalErr('mVehicle','Vehicle number must be in format MH12-AB-0047');return;}
  if(!id){
    const _inactVeh=DB.vehicles.find(v=>v.number.toUpperCase()===number&&v.id!==id&&v.inactive===true);
    if(_inactVeh){modalErr('mVehicle',`Vehicle "${number}" already exists in Inactive Records. Activate it to use.`);return;}
  }
  if(DB.vehicles.find(v=>v.number.toUpperCase()===number&&v.id!==id&&!v.inactive)){modalErr('mVehicle','Vehicle number already exists');return;}
  const vehInactive=document.getElementById('vehInactive')?.checked===true;
  let _savedVhId=id;
  if(id){
    const _vh=byId(DB.vehicles,id);const _vhBak={..._vh};
    Object.assign(_vh,{number,typeId,vendorId,pucExpiry,rtpExpiry,insExpiry,inactive:vehInactive});
    if(!await _dbSave('vehicles',_vh)){ Object.assign(_vh,_vhBak); return; }
  }
  else{const _vh={id:'vh'+uid(),number,typeId,vendorId,pucExpiry,rtpExpiry,insExpiry,inactive:vehInactive};if(!await _dbSave('vehicles',_vh)){return;}else{_savedVhId=_vh.id;}}
  cm('mVehicle');
  notify('Saved!');
  // If called from Trip Booking, schedule auto-select after all DOM events settle
  if(_vehFromTB&&!id){
    _vehFromTB=false;
    renderVehicles();
    // Use setTimeout so any other event handlers (filterActualVehicles etc.) run first
    const _capturedVhId=_savedVhId;
    const _capturedTypeId=typeId;
    setTimeout(()=>{
      _applyTBVehicle(_capturedVhId,_capturedTypeId);
    },80);
    return;
  }
  _vehFromTB=false;
  renderVehicles();
}

// Locations
function renderLocations(){
  var _isLocAdmin=CU&&CU.roles&&(CU.roles.includes('Admin')||CU.roles.includes('Super Admin'));
  // Hide add/export/import buttons for non-admin
  var _btnAdd=document.getElementById('btnAddLoc');if(_btnAdd)_btnAdd.style.display=_isLocAdmin?'':'none';
  var _eaWraps=document.querySelectorAll('#pageLocations .ea-wrap');_eaWraps.forEach(function(el){el.style.display=_isLocAdmin?'':'none';});
  var _locSearch=((document.getElementById('locSearchInput')||{}).value||'').toLowerCase().trim();
  document.getElementById('locBody').innerHTML=[...DB.locations].filter(l=>{
    if(document.getElementById('showInactiveLoc')?.checked&&l.inactive) return false;
    if(_locSearch&&(l.name||'').toLowerCase().indexOf(_locSearch)<0) return false;
    return true;
  }).sort((a,b)=>{
    const ta=a.type==='KAP'?0:1, tb=b.type==='KAP'?0:1;
    if(ta!==tb) return ta-tb;
    return a.name.localeCompare(b.name);
  }).map(l=>{
    const nameBadge=l.colour
      ?`<span style="background:${l.colour};color:${colourContrast(l.colour)};padding:2px 9px;border-radius:5px;font-weight:700">${l.name}</span>`
      :l.name;
    const inactive=l.inactive===true;
    const inactiveBadge=inactive?'<span style="font-size:9px;font-weight:700;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;margin-left:4px;border:1px solid #fca5a5">Inactive</span>':'';
    var actCol=_isLocAdmin?`<td style="white-space:nowrap" onclick="event.stopPropagation()"><button class="action-btn" onclick="openLocModal('${l.id}')">✏️</button><button class="action-btn" onclick="del('locations','${l.id}',renderLocations)">🗑️</button></td>`:'<td></td>';
    return `<tr class="clickable-row" onclick="showRecordDetail('locations','${l.id}')" ${inactive?'style="opacity:.6;background:rgba(239,68,68,.03)"':''}><td>${nameBadge}${inactiveBadge}</td><td><span class="badge ${l.type==='KAP'?'badge-amber':'badge-blue'}">${l.type}</span></td><td>${l.kapSec?uname(l.kapSec):'-'}</td><td>${(l.tripBook||[]).map(uname).join(', ')||'-'}</td><td>${(l.matRecv||[]).map(uname).join(', ')||'-'}</td><td>${(l.approvers||[]).map(uname).join(', ')||'-'}</td><td>${l.plantHead?uname(l.plantHead):'-'}</td>${actCol}</tr>`;
  }).join('')||'<tr><td colspan="10" class="empty-state" style="padding:32px;text-align:center;color:var(--text3);font-size:13px">No locations found — <a href="#" onclick="event.preventDefault()" style="color:var(--accent)">check connection</a></td></tr>';
}
function setLocColour(colour){
  document.getElementById('locColour').value=colour;
  // Highlight selected swatch
  // Reset all borders then set active
  document.querySelectorAll('#locColourPicker button').forEach(b=>b.style.borderColor='transparent');
  const colourToId={'':'lc_none','#fda4af':'lc_rose_lt','#f43f5e':'lc_rose','#dc2626':'lc_red','#991b1b':'lc_red_dk','#9f1239':'lc_crimson','#fdba74':'lc_orange_lt','#ea580c':'lc_orange','#d97706':'lc_amber','#92400e':'lc_brown','#fde047':'lc_yellow_lt','#eab308':'lc_yellow','#b45309':'lc_gold','#bef264':'lc_lime_lt','#65a30d':'lc_lime','#86efac':'lc_green_lt','#16a34a':'lc_green','#166534':'lc_green_dk','#059669':'lc_emerald','#5eead4':'lc_teal_lt','#0d9488':'lc_teal','#67e8f9':'lc_cyan_lt','#0891b2':'lc_cyan','#0284c7':'lc_sky','#93c5fd':'lc_blue_lt','#0369a1':'lc_blue','#175c60':'lc_royal','#1e3a8a':'lc_navy','#334155':'lc_slate','#a5b4fc':'lc_indigo_lt','#4338ca':'lc_indigo','#c4b5fd':'lc_violet_lt','#7c3aed':'lc_violet','#d8b4fe':'lc_purple_lt','#9333ea':'lc_purple','#f0abfc':'lc_fuchsia_lt','#a21caf':'lc_fuchsia','#f9a8d4':'lc_pink_lt','#be185d':'lc_pink','#db2777':'lc_hotpink','#d1d5db':'lc_gray_lt','#6b7280':'lc_gray','#374151':'lc_charcoal','#52525b':'lc_zinc','#78716c':'lc_stone','#a8a29e':'lc_warm','#ef6c56':'lc_coral','#e8795a':'lc_salmon','#f4a261':'lc_peach','#34d399':'lc_mint','#22d3ee':'lc_aqua','#a78bfa':'lc_lavender'};
  const activeId=colourToId[colour]||'lc_none';
  const activeEl=document.getElementById(activeId);
  if(activeEl) activeEl.style.borderColor='var(--accent)';
  // Preview
  const prev=document.getElementById('locColourPreview');
  const name=document.getElementById('locNameI').value||'Location';
  if(colour&&prev){prev.style.display='inline';prev.style.background=colour;prev.style.color=colourContrast(colour);prev.textContent=name;}
  else if(prev){prev.style.display='none';}
}
function colourName(hex){const map={'#fda4af':'Rose Light','#f43f5e':'Rose','#dc2626':'Red','#991b1b':'Maroon','#9f1239':'Crimson','#fdba74':'Orange Light','#ea580c':'Orange','#d97706':'Amber','#92400e':'Brown','#fde047':'Yellow Light','#eab308':'Yellow','#b45309':'Gold','#bef264':'Lime Light','#65a30d':'Lime','#86efac':'Green Light','#16a34a':'Green','#166534':'Forest','#059669':'Emerald','#5eead4':'Teal Light','#0d9488':'Teal','#67e8f9':'Cyan Light','#0891b2':'Cyan','#0284c7':'Sky','#93c5fd':'Blue Light','#0369a1':'Blue','#175c60':'Royal','#1e3a8a':'Navy','#334155':'Slate','#a5b4fc':'Indigo Light','#4338ca':'Indigo','#c4b5fd':'Violet Light','#7c3aed':'Violet','#d8b4fe':'Purple Light','#9333ea':'Purple','#f0abfc':'Fuchsia Light','#a21caf':'Fuchsia','#f9a8d4':'Pink Light','#be185d':'Pink','#db2777':'Hot Pink','#d1d5db':'Silver','#6b7280':'Gray','#374151':'Charcoal','#52525b':'Zinc','#78716c':'Stone','#a8a29e':'Warm Gray','#ef6c56':'Coral','#e8795a':'Salmon','#f4a261':'Peach','#34d399':'Mint','#22d3ee':'Aqua','#a78bfa':'Lavender'};return map[hex]||'';}
// Auto-select white or dark text based on background luminance

// Location name helpers moved to utils
function toggleKapFields(){document.getElementById('kapLocFields').style.display=document.getElementById('locTypeS').value==='KAP'?'block':'none';}
function openLocModal(id){
  const l=id?byId(DB.locations,id):null;
  document.getElementById('eLocId').value=id||'';document.getElementById('locNameI').value=l?.name||'';document.getElementById('locTypeS').value=l?.type||'';document.getElementById('locAddr').value=l?.address||'';document.getElementById('locGeo').value=l?.geo||'';
  // Helper: display user fullName with location in brackets
  const _uLabel=(u)=>{
    const fn=u.fullName||u.name;
    const loc=byId(DB.locations,u.plant);
    if(!loc?.name) return fn;
    const bg=loc.colour||'#e2e8f0';const fg=colourContrast(bg);
    return `${fn} <span style="background:${bg};color:${fg};font-size:8px;font-weight:700;padding:0 5px;border-radius:3px;margin-left:2px;vertical-align:middle">${loc.name}</span>`;
  };
  const _uLabelPlain=(u)=>{
    const fn=u.fullName||u.name;
    const loc=byId(DB.locations,u.plant);
    const locName=loc?.name||'';
    return locName?`${fn} [${locName}]`:fn;
  };
  const kU=sortBy(DB.users.filter(u=>u.roles.includes('KAP Security')),u=>(u.fullName||u.name));
  const tU=sortBy(DB.users.filter(u=>u.roles.includes('Trip Booking User')),u=>(u.fullName||u.name));
  const mU=sortBy(DB.users.filter(u=>u.roles.includes('Material Receiver')),u=>(u.fullName||u.name));
  const aU=sortBy(DB.users.filter(u=>u.roles.includes('Trip Approver')),u=>(u.fullName||u.name));
  document.getElementById('locKapSec').innerHTML='<option value="">-- None --</option>'+kU.map(u=>`<option value="${u.id}"${u.id===l?.kapSec?' selected':''}>${_uLabelPlain(u)}</option>`).join('');
  document.getElementById('locTripBook').innerHTML=tU.map(u=>`<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:11px;background:var(--surface2);padding:3px 7px;border-radius:5px;border:1px solid ${(l?.tripBook||[]).includes(u.id)?'var(--accent)':'var(--border)'}"><input type="checkbox" value="${u.id}" ${(l?.tripBook||[]).includes(u.id)?'checked':''} style="width:14px;height:14px"> ${_uLabel(u)}</label>`).join('')||'<span style="font-size:11px;color:var(--text3)">No Trip Booking Users in User Master</span>';
  document.getElementById('locMatRecv').innerHTML=mU.map(u=>`<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:11px;background:var(--surface2);padding:3px 7px;border-radius:5px;border:1px solid ${(l?.matRecv||[]).includes(u.id)?'var(--accent)':'var(--border)'}"><input type="checkbox" value="${u.id}" ${(l?.matRecv||[]).includes(u.id)?'checked':''} style="width:14px;height:14px"> ${_uLabel(u)}</label>`).join('')||'<span style="font-size:11px;color:var(--text3)">No Material Receivers in User Master</span>';
  document.getElementById('locApprover').innerHTML=aU.map(u=>`<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:11px;background:var(--surface2);padding:3px 7px;border-radius:5px;border:1px solid ${(l?.approvers||[]).includes(u.id)?'var(--accent)':'var(--border)'}"><input type="checkbox" value="${u.id}" ${(l?.approvers||[]).includes(u.id)?'checked':''} style="width:14px;height:14px"> ${_uLabel(u)}</label>`).join('')||'<span style="font-size:11px;color:var(--text3)">No Approvers in User Master</span>';
  const phU=sortBy(DB.users.filter(u=>(u.roles||[]).includes('Plant Head')),u=>(u.fullName||u.name));
  document.getElementById('locPlantHead').innerHTML='<option value="">-- None --</option>'+phU.map(u=>`<option value="${u.id}"${u.id===l?.plantHead?' selected':''}>${_uLabelPlain(u)}</option>`).join('');
  toggleKapFields();document.getElementById('mLocTitle').textContent=id?'Edit Location':'Add Location';
  // Load colour
  setLocColour(l?.colour||'');
  const locICb=document.getElementById('locInactive');if(locICb)locICb.checked=l?.inactive===true;
  om('mLoc');
}
async function saveLoc(){
  const id=document.getElementById('eLocId').value;const name=document.getElementById('locNameI').value.trim();const type=document.getElementById('locTypeS').value;const address=document.getElementById('locAddr').value;const geo=document.getElementById('locGeo').value;
  const colour=document.getElementById('locColour').value;
  const kapSec=document.getElementById('locKapSec').value;const tripBook=[...document.querySelectorAll('#locTripBook input:checked')].map(o=>o.value);
  const matRecv=[...document.querySelectorAll('#locMatRecv input:checked')].map(o=>o.value);
  const approvers=[...document.querySelectorAll('#locApprover input:checked')].map(o=>o.value);
  const plantHead=document.getElementById('locPlantHead').value;
  if(!name||!type){modalErr('mLoc','Fill required fields');return;}
  if(!id){
    const _inactLoc=DB.locations.find(l=>l&&l.name.trim().toLowerCase()===name.toLowerCase()&&l.id!==id&&l.inactive===true);
    if(_inactLoc){modalErr('mLoc',`"${name}" already exists in Inactive Records. Activate it to use.`);return;}
  }
  if(DB.locations.find(l=>l&&l.name.trim().toLowerCase()===name.toLowerCase()&&l.id!==id)){modalErr('mLoc','Location name already exists');return;}
  const locInactive=document.getElementById('locInactive')?.checked===true;
  if(id){
    const _loc=byId(DB.locations,id);
    const _locBak={..._loc};
    Object.assign(_loc,{name,type,address,geo,colour,kapSec,tripBook,matRecv,approvers,plantHead,inactive:locInactive});
    if(!await _dbSave('locations',_loc)){ Object.assign(_loc,_locBak); return; }
  }
  else{const _loc={id:'l'+uid(),name,type,address,geo,colour,kapSec,tripBook,matRecv,approvers,plantHead,inactive:locInactive};if(!await _dbSave('locations',_loc)) return;}
    cm('mLoc');renderLocations();notify('Saved!');
}

// Trip Rates
var _rateSortCol='vtype', _rateSortAsc=true;
function rateSort(col){
  if(_rateSortCol===col){ _rateSortAsc=!_rateSortAsc; }
  else { _rateSortCol=col; _rateSortAsc=true; }
  renderRates();
}
function renderRates(){
  const isSA=CU.roles.includes('Super Admin');
  const isAdmin=CU.roles.includes('Admin')||isSA;
  const today=new Date().toISOString().split('T')[0];

  // Pending section (SA only)
  const pendingSection=document.getElementById('ratePendingSection');
  const pendingList=document.getElementById('ratePendingList');
  const pendingCount=document.getElementById('ratePendingCount');
  const pending=DB.tripRates.filter(r=>r.status==='pending');
  if(isSA && pending.length){
    if(pendingSection)pendingSection.style.display='block';
    if(pendingCount){pendingCount.textContent=pending.length;pendingCount.style.display='inline-flex';}
    if(pendingList)pendingList.innerHTML=pending.map(r=>`
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(42,154,160,.08);border:1px solid rgba(42,154,160,.3);border-radius:8px;margin-bottom:6px;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-size:13px;font-weight:700">${r.name} <span style="color:var(--text3)">· ₹${r.rate.toLocaleString()}</span></div>
          <div style="font-size:12px;color:var(--text2);margin-top:2px">${vtname(r.vTypeId)} · ${lnameText(r.start)} → ${lnameText(r.dest1)}${r.dest2?' → '+lnameText(r.dest2):''}${r.dest3?' → '+lnameText(r.dest3):''}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">Valid: ${fd(r.validStart)} → ${fd(r.validEnd)} · Added by: ${uname(r.addedBy)||'Admin'}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-green" style="padding:5px 14px;font-size:12px;font-weight:700" onclick="approveRate('${r.id}')">✓ Approve</button>
          <button class="btn btn-danger" style="padding:5px 14px;font-size:12px;font-weight:700" onclick="rejectRate('${r.id}')">✗ Reject</button>
        </div>
      </div>`).join('');
  } else {
    if(pendingSection)pendingSection.style.display='none';
  }

  const addBtn=document.getElementById('btnAddRate');
  if(addBtn)addBtn.style.display=isAdmin?'':'none';

  // Group by route key
  const routeKey=r=>`${r.vTypeId}|${r.start}|${r.dest1}|${r.dest2||''}|${r.dest3||''}`;
  const groups={};
  DB.tripRates.forEach(r=>{const k=routeKey(r);if(!groups[k])groups[k]=[];groups[k].push(r);});

  // Build rows array for sorting
  let rows=Object.keys(groups).map(k=>{
    const periods=[...groups[k]].sort((a,b)=>b.validStart.localeCompare(a.validStart));
    const first=groups[k][0];
    const current=periods.find(r=>r.validStart<=today&&r.validEnd>=today&&(r.status==='approved'||!r.status));
    const pendingCnt=periods.filter(r=>r.status==='pending').length;
    return {k, periods, first, current, pendingCnt,
      _vtype: vtname(first.vTypeId)||'',
      _route: [first.start,first.dest1,first.dest2,first.dest3].filter(Boolean).map(id=>lnameText(id)).join(' → '),
      _rate: current?current.rate:-1,
      _valid: current?current.validStart:'',
      _hist: periods.length,
      _status: current?'active':pendingCnt?'pending':'none'
    };
  });

  // Sort
  rows.sort((a,b)=>{
    let va=a['_'+_rateSortCol]||'', vb=b['_'+_rateSortCol]||'';
    let cmp=typeof va==='number'?va-vb:String(va).localeCompare(String(vb));
    return _rateSortAsc?cmp:-cmp;
  });

  // Update sort icons
  ['vtype','route','rate','valid','hist','status'].forEach(col=>{
    const ico=document.getElementById('rsIco_'+col);
    if(ico) ico.textContent=_rateSortCol===col?(_rateSortAsc?' ▲':' ▼'):'';
  });

  const tbody=document.getElementById('rateBody');
  if(!tbody) return;

  if(!rows.length){
    tbody.innerHTML='<tr><td colspan="8" style="text-align:center;padding:40px;font-size:14px;color:var(--text3)">No rates defined — click <strong>+ Add Rate</strong> to begin</td></tr>';
    return;
  }

  tbody.innerHTML=rows.map((row,i)=>{
    const {k,periods,first,current,pendingCnt}=row;
    const rk=encodeURIComponent(k);
    const locs=[first.start,first.dest1,first.dest2,first.dest3].filter(Boolean);
    const locPills=locs.map((id,pi)=>{const l=byId(DB.locations,id);const c=l?.colour||'var(--accent)';
      return `<span style="${_locPillStyle(l?.colour,12)}">${l?.name||'?'}</span>`
        +(pi<locs.length-1?'<span style="color:var(--text3);font-size:11px;margin:0 2px">⟶</span>':'');}).join('');
    const vtBadge=`<span style="font-size:13px;font-weight:700;color:var(--text)">${vtname(first.vTypeId)||'—'}</span>`;
    const rateCell=current
      ?`<span style="font-family:var(--mono);font-size:16px;font-weight:900;color:#16a34a">₹${current.rate.toLocaleString()}</span>`
      :`<span style="font-size:13px;color:var(--text3);font-weight:600">—</span>`;
    const datesCell=current
      ?`<span style="font-size:13px;font-weight:600;color:var(--text2);font-family:var(--mono)">${fd(current.validStart)}</span><span style="color:var(--text3);font-size:11px;margin:0 4px">→</span><span style="font-size:13px;font-weight:600;color:var(--text2);font-family:var(--mono)">${fd(current.validEnd)}</span>`
      :`<span style="font-size:12px;color:var(--text3)">No active period</span>`;
    const statusCell=current
      ?'<span class="badge badge-green" style="font-size:11px;padding:3px 10px">✓ Active</span>'
      :pendingCnt
        ?`<span class="badge badge-amber" style="font-size:11px;padding:3px 10px">⏳ Pending</span>`
        :'<span class="badge badge-red" style="font-size:11px;padding:3px 10px">✗ Rejected</span>';
    const oddBg=i%2===0?'':'background:rgba(0,0,0,.018)';
    return `<tr class="clickable-row" onclick="openRateHistory('${rk}')" style="${oddBg};transition:background .12s">
      <td style="padding:11px 12px;font-size:13px;font-weight:700;color:var(--text3);text-align:center">${i+1}</td>
      <td style="padding:11px 12px">${vtBadge}</td>
      <td style="padding:11px 12px"><div style="display:flex;align-items:center;gap:3px;flex-wrap:wrap">${locPills}</div></td>
      <td style="padding:11px 12px;text-align:right">${rateCell}</td>
      <td style="padding:11px 12px;white-space:nowrap">${datesCell}</td>
      <td style="padding:11px 12px;text-align:center"><span style="font-size:13px;font-weight:700;color:${pendingCnt?'#d97706':'var(--text2)'}">${periods.length}${pendingCnt?` <span style="font-size:11px;color:#d97706">(${pendingCnt}⏳)</span>`:''}</span></td>
      <td style="padding:11px 12px;text-align:center">${statusCell}</td>
      <td style="padding:11px 12px;text-align:center" onclick="event.stopPropagation()">
        <button class="action-btn" onclick="openRateHistory('${rk}')" title="View history / edit">✏️</button>
      </td>
    </tr>`;
  }).join('');
}

// ── Rate History modal helpers ────────────────────────────────────────────────
function openRateHistory(encodedKey){
  const k=decodeURIComponent(encodedKey);
  const parts=k.split('|');
  const [vTypeId,start,dest1,dest2,dest3]=parts;
  const today=new Date().toISOString().split('T')[0];
  const isSA=CU.roles.includes('Super Admin');
  const isAdmin=CU.roles.includes('Admin')||isSA;
  const periods=DB.tripRates.filter(r=>
    r.vTypeId===vTypeId&&r.start===start&&r.dest1===dest1&&
    (r.dest2||'')===(dest2||'')&&(r.dest3||'')===(dest3||'')
  ).sort((a,b)=>b.validStart.localeCompare(a.validStart));
  const first=periods[0]||{};
  const locs=[start,dest1,dest2,dest3].filter(Boolean);
  const routeTxt=locs.map(id=>lnameText(id)).join(' → ');
  document.getElementById('rhTitle').textContent=vtname(vTypeId)||'Trip Rate';
  document.getElementById('rhRoute').textContent=routeTxt;
  document.getElementById('rhRouteKey').value=encodedKey;
  document.getElementById('rhEditId').value='';
  document.getElementById('rhAddWrap').style.display='none';
  document.getElementById('rhAddBtn').style.display=isAdmin?'':'none';
  // Current rate banner
  const current=periods.find(r=>r.validStart<=today&&r.validEnd>=today&&(r.status==='approved'||!r.status));
  const banner=document.getElementById('rhCurrentBanner');
  if(current){
    banner.style.display='block';
    document.getElementById('rhCurrentRate').textContent='₹'+current.rate.toLocaleString();
    document.getElementById('rhCurrentDates').textContent=fd(current.validStart)+' → '+fd(current.validEnd);
  } else {
    banner.style.display='none';
  }
  // History list
  const rhList=document.getElementById('rhList');
  rhList.innerHTML=periods.length?periods.map(r=>{
    const isCurr=r.validStart<=today&&r.validEnd>=today&&(r.status==='approved'||!r.status);
    const stClr=r.status==='approved'?'#16a34a':r.status==='rejected'?'#dc2626':'#d97706';
    const stLabel=r.status==='approved'?'✓ Approved':r.status==='rejected'?'✗ Rejected':'⏳ Pending';
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:${isCurr?'rgba(22,163,74,.06)':'var(--surface2)'};border:1px solid ${isCurr?'rgba(22,163,74,.25)':'var(--border)'}">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:16px;font-weight:900;font-family:var(--mono);color:${isCurr?'#16a34a':'var(--text)'}">₹${r.rate.toLocaleString()}</span>
          <span style="font-size:11px;font-weight:600;color:var(--text2)">${fd(r.validStart)} → ${fd(r.validEnd)}</span>
          <span style="font-size:10px;font-weight:700;color:${stClr}">${stLabel}</span>
          ${isCurr?'<span style="font-size:10px;font-weight:800;background:#dcfce7;color:#16a34a;padding:1px 7px;border-radius:4px">ACTIVE</span>':''}
        </div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">Added by ${uname(r.addedBy)||'Admin'}${r.approvedBy?' · Approved by '+uname(r.approvedBy):''}</div>
      </div>
      ${isAdmin?`<div style="display:flex;gap:4px;flex-shrink:0">
        ${isSA&&r.status==='pending'?`<button class="action-btn" style="color:#16a34a" onclick="approveRate('${r.id}');openRateHistory(document.getElementById('rhRouteKey').value)" title="Approve">✓</button>`:''}
        ${isSA&&r.status==='pending'?`<button class="action-btn" style="color:#dc2626" onclick="rejectRate('${r.id}');openRateHistory(document.getElementById('rhRouteKey').value)" title="Reject">✗</button>`:''}
        <button class="action-btn" onclick="rhEditRate('${r.id}')" title="Edit">✏️</button>
        <button class="action-btn" style="color:#dc2626" onclick="delRate('${r.id}')" title="Delete">🗑️</button>
      </div>`:''}
    </div>`;
  }).join(''):'<div style="color:var(--text3);font-size:12px;padding:8px">No rate periods recorded yet.</div>';
  om('mRateHistory');
}
function rhStartAdd(){
  document.getElementById('rhEditId').value='';
  document.getElementById('rhAmt').value='';
  const yr=new Date().getFullYear();
  document.getElementById('rhVS').value=yr+'-01-01';
  document.getElementById('rhVE').value=yr+'-12-31';
  document.getElementById('rhFormTitle').textContent='Add New Rate Period';
  document.getElementById('rhAddWrap').style.display='block';
  document.getElementById('rhAmt').focus();
}
function rhEditRate(rateId){
  const r=byId(DB.tripRates,rateId);if(!r)return;
  document.getElementById('rhEditId').value=rateId;
  document.getElementById('rhAmt').value=r.rate;
  document.getElementById('rhVS').value=r.validStart||'';
  document.getElementById('rhVE').value=r.validEnd||'';
  document.getElementById('rhFormTitle').textContent='Edit Rate Period';
  document.getElementById('rhAddWrap').style.display='block';
  document.getElementById('rhAmt').focus();
}
function rhCancelEdit(){
  document.getElementById('rhAddWrap').style.display='none';
  document.getElementById('rhEditId').value='';
}
async function rhSaveRate(){
  const encodedKey=document.getElementById('rhRouteKey').value;
  const k=decodeURIComponent(encodedKey);
  const parts=k.split('|');
  const [vTypeId,start,dest1,dest2,dest3]=parts;
  const rate=parseFloat(document.getElementById('rhAmt').value);
  const validStart=document.getElementById('rhVS').value;
  const validEnd=document.getElementById('rhVE').value;
  const existingId=document.getElementById('rhEditId').value;
  const errEl=document.getElementById('merr_mRateHistory');
  if(!rate||!validStart||!validEnd){errEl.textContent='Fill all required fields';errEl.style.display='block';return;}
  if(validEnd<validStart){errEl.textContent='Valid To must be after Valid From';errEl.style.display='block';return;}
  errEl.style.display='none';
  // Overlap check
  const overlapping=DB.tripRates.find(r=>
    r.id!==existingId&&r.vTypeId===vTypeId&&r.start===start&&r.dest1===dest1&&
    (r.dest2||'')===(dest2||'')&&(r.dest3||'')===(dest3||'')&&
    r.validStart<=validEnd&&r.validEnd>=validStart&&(r.status==='approved'||!r.status)
  );
  if(overlapping){errEl.textContent='Overlaps with existing rate: ₹'+overlapping.rate+' ('+fd(overlapping.validStart)+' → '+fd(overlapping.validEnd)+')';errEl.style.display='block';return;}
  const isSA=CU.roles.includes('Super Admin');
  if(existingId){
    const r=byId(DB.tripRates,existingId);if(!r)return;
    const bak={...r};r.rate=rate;r.validStart=validStart;r.validEnd=validEnd;
    if(!await _dbSave('tripRates',r)){Object.assign(r,bak);return;}
    notify('Rate updated');
  } else {
    const locs=[start,dest1,dest2,dest3].filter(Boolean);
    const name=locs.map(id=>lnameText(id)).join(' → ')+(vTypeId?' ['+vtname(vTypeId)+']':'');
    const newR={id:genId('TR'),vTypeId,start,dest1,dest2:dest2||'',dest3:dest3||'',rate,validStart,validEnd,name,status:isSA?'approved':'pending',addedBy:CU.id};
    if(!await _dbSave('tripRates',newR))return;
    notify(isSA?'Rate added':'Rate submitted for approval');
  }
  renderRates();updBadges();
  openRateHistory(encodedKey); // refresh modal
}


async function approveRate(rateId){
  const r=byId(DB.tripRates,rateId);if(!r)return;
  const _rBak={...r};
  r.status='approved';r.approvedBy=CU.id;r.approvedAt=new Date().toISOString();
  if(!await _dbSave('tripRates',r)){ Object.assign(r,_rBak); return; }
  renderRates();updBadges();notify('Rate approved!');
}

async function rejectRate(rateId){
  const r=byId(DB.tripRates,rateId);if(!r)return;
  const _rBak={...r};
  r.status='rejected';r.rejectedBy=CU.id;r.rejectedAt=new Date().toISOString();
  if(!await _dbSave('tripRates',r)){ Object.assign(r,_rBak); return; }
  renderRates();notify('Rate rejected.');
}

function showRateSuggestions(){
  const panel=document.getElementById('rateSuggestPanel');
  const list=document.getElementById('rateSuggestList');
  panel.style.display='block';

  // Collect unique combos: vTypeId + start + dest1 + dest2 + dest3
  const seen=new Set();
  const suggestions=[];
  DB.trips.forEach(t=>{
    // Always use recommended vehicle type (vehicleTypeId), not actual vehicle's type
    const recTypeId=t.vehicleTypeId||(byId(DB.vehicles,t.vehicleId)?.typeId)||null;
    if(!recTypeId||!t.startLoc||!t.dest1) return;
    const key=`${recTypeId}|${t.startLoc}|${t.dest1}|${t.dest2||''}|${t.dest3||''}`;
    if(seen.has(key)) return;
    seen.add(key);
    // Check if rate already exists for this combo (any validity)
    const exists=DB.tripRates.some(r=>
      r.vTypeId===recTypeId &&
      r.start===t.startLoc &&
      r.dest1===t.dest1 &&
      (r.dest2||'')===(t.dest2||'') &&
      (r.dest3||'')===(t.dest3||'')
    );
    if(!exists) suggestions.push({vTypeId:recTypeId,start:t.startLoc,dest1:t.dest1,dest2:t.dest2||'',dest3:t.dest3||'',tripCount:0});
  });
  // Count trips per suggestion using recommended type
  const countMap=new Map();
  DB.trips.forEach(t=>{const recTypeId=t.vehicleTypeId||(byId(DB.vehicles,t.vehicleId)?.typeId)||null;if(!recTypeId)return;const k=`${recTypeId}|${t.startLoc}|${t.dest1}|${t.dest2||''}|${t.dest3||''}`;countMap.set(k,(countMap.get(k)||0)+1);});
  suggestions.forEach(sg=>{sg.tripCount=countMap.get(`${sg.vTypeId}|${sg.start}|${sg.dest1}|${sg.dest2}|${sg.dest3}`)||0;});
  suggestions.sort((a,b)=>b.tripCount-a.tripCount);

  if(!suggestions.length){
    list.innerHTML='<div class="empty-state">All booked trip combinations already have a rate defined ✓</div>';
    return;
  }

  list.innerHTML=suggestions.map((sg,i)=>{
    const route=[lname(sg.start),lname(sg.dest1),sg.dest2?lname(sg.dest2):'',sg.dest3?lname(sg.dest3):''].filter(Boolean).join(' ⟶ ');
    const tripName=[vtname(sg.vTypeId),lnameText(sg.start),lnameText(sg.dest1),sg.dest2?lnameText(sg.dest2):'',sg.dest3?lnameText(sg.dest3):''].filter(Boolean).join(' - ');
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:6px;flex-wrap:wrap;gap:8px">
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--text)">${vtname(sg.vTypeId)} &nbsp;·&nbsp; ${route}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">Trip Name: <em>${tripName}</em> &nbsp;|&nbsp; ${sg.tripCount} trip${sg.tripCount!==1?'s':''} booked</div>
      </div>
      <button class="btn btn-primary" style="font-size:12px;padding:6px 14px" onclick='openRateModalPrefill(${JSON.stringify(sg)})'>+ Add Rate</button>
    </div>`;
  }).join('');
}

function openRateModalPrefill(sg){
  openRateModal(); // open blank modal first
  setTimeout(()=>{
    document.getElementById('rateVT').value=sg.vTypeId;
    document.getElementById('rateS').value=sg.start;
    // Enable D2 before setting dest1
    document.getElementById('rateD1').value=sg.dest1;
    if(sg.dest1){
      const d2=document.getElementById('rateD2');if(d2){d2.disabled=false;d2.style.opacity='1';}
    }
    document.getElementById('rateD2').value=sg.dest2||'';
    if(sg.dest2){
      const d3=document.getElementById('rateD3');if(d3){d3.disabled=false;d3.style.opacity='1';}
    }
    document.getElementById('rateD3').value=sg.dest3||'';
    autoRateName();
    rateDestCascade();
    showExistingRanges();
  },0);
}

function openRateModal(rateId){
  const r=rateId?byId(DB.tripRates,rateId):null;
  document.getElementById('eRateId').value=rateId||'';
  document.getElementById('rateNameI').value=r?.name||'';
  document.getElementById('rateAmt').value=r?.rate||100;
  // Default dates: start of year → end of year (for new rates only)
  if(r){
    document.getElementById('rateVS').value=r.validStart||'';
    document.getElementById('rateVE').value=r.validEnd||'';
  } else {
    const yr=new Date().getFullYear();
    document.getElementById('rateVS').value=`${yr}-01-01`;
    document.getElementById('rateVE').value=`${yr}-12-31`;
  }
  document.getElementById('mRate').querySelector('.modal-title').textContent=rateId?'Edit Trip Rate':'Add Trip Rate';
  document.getElementById('rateVT').innerHTML='<option value="">-- Select --</option>'+sortBy(DB.vehicleTypes||[],v=>v.name).map(v=>`<option value="${v.id}"${v.id===r?.vTypeId?' selected':''}>${v.name}</option>`).join('');
  const lo='<option value="">Start Location</option>'+sortLocsKapFirst(DB.locations).map(l=>`<option value="${l.id}">${locOptText(l)}</option>`).join('');
  const ln='<option value="">-- None --</option>'+sortLocsKapFirst(DB.locations).map(l=>`<option value="${l.id}">${locOptText(l)}</option>`).join('');
  document.getElementById('rateS').innerHTML=lo;document.getElementById('rateD1').innerHTML=lo;document.getElementById('rateD2').innerHTML=ln;document.getElementById('rateD3').innerHTML=ln;
  if(r){
    document.getElementById('rateS').value=r.start||'';
    document.getElementById('rateD1').value=r.dest1||'';
    if(r.dest1){const d2=document.getElementById('rateD2');if(d2){d2.disabled=false;d2.style.opacity='1';}}
    document.getElementById('rateD2').value=r.dest2||'';
    if(r.dest2){const d3=document.getElementById('rateD3');if(d3){d3.disabled=false;d3.style.opacity='1';}}
    document.getElementById('rateD3').value=r.dest3||'';
    rateDestCascade();
    autoRateName();
    showExistingRanges();
  } else {
    // Reset for new rate — D2 and D3 start disabled
    const d2=document.getElementById('rateD2');if(d2){d2.disabled=true;d2.style.opacity='.4';}
    const d3=document.getElementById('rateD3');if(d3){d3.disabled=true;d3.style.opacity='.4';}
    rateDestCascade();
    const hint=document.getElementById('existingRangesHint');if(hint)hint.style.display='none';
    const disp=document.getElementById('rateNameDisplay');if(disp)disp.style.display='none';
  }
  om('mRate');
}
function rateDestCascade(){
  const d1=document.getElementById('rateD1');
  const d2=document.getElementById('rateD2');
  const d3=document.getElementById('rateD3');
  const c1=document.getElementById('rateCircle1');
  const c2=document.getElementById('rateCircle2');
  const c3=document.getElementById('rateCircle3');

  const v1=d1?.value;
  const v2=d2?.value;

  // Destination colors: 1=blue, 2=teal, 3=purple (matches trip booking A/B/C)
  const clr1='#35b0b6', clr2='#14b8a6', clr3='#8b5cf6';

  // Circle 1: blue if selected, grey if not
  if(c1){
    if(v1){c1.style.background=clr1;c1.style.color='#fff';c1.style.borderColor=clr1;c1.style.opacity='1';}
    else{c1.style.background='var(--surface2)';c1.style.color='var(--text3)';c1.style.borderColor='var(--border2)';c1.style.opacity='1';}
  }

  // D2: enabled only if D1 selected
  if(d2){
    if(v1){
      d2.disabled=false;d2.style.opacity='1';
      if(c2){c2.style.opacity='1';}
    } else {
      d2.disabled=true;d2.value='';d2.style.opacity='.4';
      if(c2){c2.style.background='var(--surface2)';c2.style.color='var(--text3)';c2.style.borderColor='var(--border2)';c2.style.opacity='.5';}
      // Cascade: reset D3 too
      if(d3){d3.disabled=true;d3.value='';d3.style.opacity='.4';}
      if(c3){c3.style.background='var(--surface2)';c3.style.color='var(--text3)';c3.style.borderColor='var(--border2)';c3.style.opacity='.5';}
    }
  }

  // Circle 2: teal if D2 selected
  if(c2&&v1){
    if(v2){c2.style.background=clr2;c2.style.color='#fff';c2.style.borderColor=clr2;c2.style.opacity='1';}
    else{c2.style.background='var(--surface2)';c2.style.color='var(--text3)';c2.style.borderColor='var(--border2)';c2.style.opacity='1';}
  }

  // D3: enabled only if D2 selected
  if(d3){
    if(v1&&v2){
      d3.disabled=false;d3.style.opacity='1';
      if(c3){c3.style.opacity='1';}
    } else {
      d3.disabled=true;d3.value='';d3.style.opacity='.4';
      if(c3){c3.style.background='var(--surface2)';c3.style.color='var(--text3)';c3.style.borderColor='var(--border2)';c3.style.opacity='.5';}
    }
  }

  // Circle 3: purple if D3 selected
  if(c3&&v1&&v2){
    const v3=d3?.value;
    if(v3){c3.style.background=clr3;c3.style.color='#fff';c3.style.borderColor=clr3;c3.style.opacity='1';}
    else{c3.style.background='var(--surface2)';c3.style.color='var(--text3)';c3.style.borderColor='var(--border2)';c3.style.opacity='1';}
  }
}

function showExistingRanges(){
  const vTypeId=document.getElementById('rateVT').value;
  const start=document.getElementById('rateS').value;
  const dest1=document.getElementById('rateD1').value;
  const dest2=document.getElementById('rateD2').value;
  const dest3=document.getElementById('rateD3').value;
  const existingId=document.getElementById('eRateId').value;
  const hint=document.getElementById('existingRangesHint');
  const list=document.getElementById('existingRangesList');
  if(!vTypeId||!start||!dest1){hint.style.display='none';return;}
  const matches=DB.tripRates.filter(r=>
    r.id!==existingId &&
    r.vTypeId===vTypeId&&r.start===start&&r.dest1===dest1&&
    (r.dest2||'')===(dest2||'')&&(r.dest3||'')===(dest3||'')
  );
  if(!matches.length){hint.style.display='none';return;}
  hint.style.display='block';
  list.innerHTML=matches.map(r=>`<span style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;padding:3px 8px;font-size:11px;font-family:var(--mono);white-space:nowrap">₹${r.rate.toLocaleString()} · ${fd(r.validStart)} <span style="font-family:var(--sans);font-size:10px">To</span> ${fd(r.validEnd)} <span style="font-family:var(--sans)">${r.status==='approved'?'✓':'⏳'}</span></span>`).join('');
}
function autoRateName(){
  const vt=document.getElementById('rateVT');
  const s=document.getElementById('rateS');
  const d1=document.getElementById('rateD1');
  const d2=document.getElementById('rateD2');
  const d3=document.getElementById('rateD3');

  const vtText=vt.value?vt.options[vt.selectedIndex].text:'';
  const sVal=s.value;const d1Val=d1.value;const d2Val=d2.value;const d3Val=d3.value;

  // Determine trip type with colour/style
  let tripTypeBadge='';
  let tripTypeText='';
  if(sVal&&d1Val){
    const finalDest=d3Val||d2Val||d1Val;
    if(d2Val||d3Val){
      if(finalDest===sVal){
        tripTypeText='Return Trip';
        tripTypeBadge=`<span style="background:#b3dfe0;color:#175c60;font-weight:900;font-size:12px;padding:3px 10px;border-radius:20px;letter-spacing:.3px">🔄 Return Trip</span>`;
      } else {
        tripTypeText='Multi Location Trip';
        tripTypeBadge=`<span style="background:#e9d5ff;color:#6b21a8;font-weight:900;font-size:12px;padding:3px 10px;border-radius:20px;letter-spacing:.3px">📍 Multi Location Trip</span>`;
      }
    } else {
      tripTypeText='One Way Trip';
      tripTypeBadge=`<span style="background:#bbf7d0;color:#14532d;font-weight:900;font-size:12px;padding:3px 10px;border-radius:20px;letter-spacing:.3px">➡ One Way Trip</span>`;
    }
  }

  // Build plain text name for saving
  const locTexts=[sVal,d1Val,d2Val,d3Val].filter(Boolean).map(id=>lnameText(id));
  const plainParts=[...(tripTypeText?[tripTypeText]:[]),...(vtText?[vtText]:[]),...locTexts];
  const plainName=plainParts.join(' - ');
  document.getElementById('rateNameI').value=plainName;

  // Build rich HTML display
  const display=document.getElementById('rateNameDisplay');
  if(!display) return;
  if(!sVal||!d1Val){display.style.display='none';return;}

  // Location colour badge helper (inline)
  const locBadge=(id)=>{
    const l=byId(DB.locations,id);
    if(!l)return'?';
    if(l.colour)return`<span style="background:${l.colour};color:${colourContrast(l.colour)};padding:2px 8px;border-radius:5px;font-weight:700;font-size:12px">${l.name}</span>`;
    return`<span style="font-weight:700;font-size:12px">${l.name}</span>`;
  };

  // Arrow
  const arrow=`<span style="color:var(--accent);font-weight:900;font-size:14px;margin:0 4px">⟶</span>`;

  // Build route display
  const routeParts=[sVal,d1Val,...(d2Val?[d2Val]:[]),...(d3Val?[d3Val]:[])];
  const routeHtml=routeParts.map(locBadge).join(arrow);

  // Vehicle type badge
  const vtBadge=vtText?`<span style="background:var(--surface2);border:1px solid var(--border2);color:var(--text);font-size:11px;font-weight:700;padding:2px 8px;border-radius:5px;margin-right:6px">${vtText}</span>`:'';

  display.style.display='block';
  display.innerHTML=`
    ${vtText?`<div style="font-size:16px;font-weight:900;color:var(--text);line-height:2;letter-spacing:.3px">${vtText}</div>`:''}
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:2px">
      ${tripTypeBadge}
    </div>
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px">${routeHtml}</div>`;
}
function autoRateEnd(){
  const sd=document.getElementById('rateVS').value;
  if(sd){
    const yr=parseInt(sd.substring(0,4));
    document.getElementById('rateVE').value=`${yr}-12-31`;
  }
}
async function saveRate(){
  const existingId=document.getElementById('eRateId').value;
  const vTypeId=document.getElementById('rateVT').value;const start=document.getElementById('rateS').value;const dest1=document.getElementById('rateD1').value;
  const dest2=document.getElementById('rateD2').value;const dest3=document.getElementById('rateD3').value;const rate=parseInt(document.getElementById('rateAmt').value);
  const validStart=document.getElementById('rateVS').value;const validEnd=document.getElementById('rateVE').value;const name=document.getElementById('rateNameI').value;
  if(!vTypeId||!start||!dest1||!rate||!validStart||!validEnd){modalErr('mRate','Fill required fields');return;}
  if(validEnd<validStart){modalErr('mRate','Valid End date must be after Valid Start date');return;}
  const isSA=CU.roles.includes('Super Admin');

  // Check for overlapping date ranges for same route + vehicle type (exclude current record if editing)
  const overlapping=DB.tripRates.find(r=>{
    if(r.id===existingId) return false; // skip self when editing
    if(r.vTypeId!==vTypeId||r.start!==start||r.dest1!==dest1||(r.dest2||'')!==(dest2||'')||(r.dest3||'')!==(dest3||'')) return false;
    // Overlap: new range starts before existing ends AND new range ends after existing starts
    return validStart<=r.validEnd && validEnd>=r.validStart;
  });
  if(overlapping){
    modalErr('mRate',`Date range overlaps with existing rate "${overlapping.name}" (${fd(overlapping.validStart)} To ${fd(overlapping.validEnd)})`);
    return;
  }

  if(existingId){
    // UPDATE existing rate — Supabase-first with rollback
    const r=byId(DB.tripRates,existingId);if(!r){modalErr('mRate','Rate not found');return;}
    const _rBak={...r};
    Object.assign(r,{name,vTypeId,start,dest1,dest2,dest3,rate,validStart,validEnd});
    // If edited by Admin (not SA), reset to pending for re-approval
    if(!isSA&&r.status==='approved'){r.status='pending';r.approvedBy=null;r.approvedAt=null;}
    if(!await _dbSave('tripRates',r)){ Object.assign(r,_rBak); return; }
    cm('mRate');renderRates();
    notify(isSA?'Rate updated!':'Rate updated — pending re-approval.');
    return;
  }

  // NEW rate
  const status=isSA?'approved':'pending';
  const approvedBy=isSA?CU.id:null;
  const approvedAt=isSA?new Date().toISOString():null;
  const _nr={id:'r'+uid(),name,vTypeId,start,dest1,dest2,dest3,rate,validStart,validEnd,status,addedBy:CU.id,approvedBy,approvedAt};
  if(!await _dbSave('tripRates',_nr)) return;
  cm('mRate');renderRates();
  // If suggestions panel is open, refresh it so the added route disappears
  if(document.getElementById('rateSuggestPanel')?.style.display!=='none'){
    showRateSuggestions();
  }
  notify(isSA?'Rate saved and approved!':'Rate submitted for Super Admin approval.');
}

async function delRate(rateId){
  const r=byId(DB.tripRates,rateId);if(!r)return;
  // Block deletion if any completed trip used this rate
  const usedByTrip=DB.trips.some(t=>{
    const v=byId(DB.vehicles,t.vehicleId);
    return v &&
      v.typeId===r.vTypeId &&
      t.startLoc===r.start &&
      t.dest1===r.dest1 &&
      (t.dest2||'')===(r.dest2||'') &&
      (t.dest3||'')===(r.dest3||'');
  });
  if(usedByTrip){
    notify('Cannot delete — this rate has been used by trips in the system',true);
    return;
  }
  DB.tripRates=DB.tripRates.filter(x=>x.id!==rateId);
  await _dbDel('tripRates',rateId);renderRates();notify('Rate deleted.');
}

// ===== CLEAR TRIP BOOKING FORM =====
function clearTripForm(){
  // NOTE: _editingTripId is managed by openTripBookingModal (save/restore pattern) — do NOT reset here
  [1,2,3].forEach(n=>clearChallanList(n));
  ['tbP1','tbP2','tbP3'].forEach(id=>{const el=document.getElementById(id);if(el){el.value='';el._compressedData=null;}});
  [1,2,3].forEach(n=>{const t=document.getElementById('tbP'+n+'Thumb');if(t){t.innerHTML='📷';t.style.border='2px dashed var(--border2)';}const c=document.getElementById('tbP'+n+'Clear');if(c)c.style.display='none';});
  // Re-enable any fields that were locked during amendment
  ['tbStart','tbVehicleType_sel','tbActualVType_sel','tbVehicle','tbDriver','tbDest1','tbDest2','tbDest3'].forEach(id=>{
    const el=document.getElementById(id);if(el){el.disabled=false;el.style.opacity='';}
  });
  ['tbStartTxt','tbDest1Txt','tbDest2Txt','tbDest3Txt'].forEach(id=>{
    const el=document.getElementById(id);if(el){el.disabled=false;el.style.opacity='';el.value='';}
  });
  _locComboSetValue('tbStart','');
  _locComboSetValue('tbDest1','');
  _locComboSetValue('tbDest2','');
  _locComboSetValue('tbDest3','');
  document.getElementById('tbVehicle').value='';document.getElementById('tbDriver').value='';
  const vtSel=document.getElementById('tbVehicleType_sel');if(vtSel)vtSel.value='';
  const actVtSel=document.getElementById('tbActualVType_sel');if(actVtSel)actVtSel.value='';
  const mw=document.getElementById('tbVtMismatchWarn');if(mw)mw.classList.remove('show');
  const vehSel=document.getElementById('tbVehicle');if(vehSel){vehSel.disabled=true;vehSel.innerHTML='<option value="">Vehicle</option>';}
  document.getElementById('tbVendor').value='';document.getElementById('tbDesc').value='';
  ['tbVehicleType','tbVehicleVendor','tbDriverVendor','tbTripIdDisplay'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='';});const _dr=document.getElementById('tbDescRow');if(_dr)_dr.style.display='none';
  document.getElementById('segPreview').innerHTML='';
  const bookBtn=document.querySelector('[onclick="bookTrip()"]');
  if(bookBtn)bookBtn.textContent='Book Trip';
  document.querySelectorAll('.tb-amend-only').forEach(el=>{el.style.display='none';});
  updateTbHighlight();
  onLocChange();
  tbDestCascade();
  // Clear location colour badges
  ['tbStartBadge','tbDest1Badge','tbDest2Badge','tbDest3Badge'].forEach(id=>{const el=document.getElementById(id);if(el){el.innerHTML='';el.style.display='none';}});
}

// ===== SORTABLE TABLES =====

// ===== RECORD DETAIL POPUP =====
function _rdRow(label,value,opts){
  opts=opts||{};
  const cls=opts.mono?'font-family:var(--mono);':'';
  const vHtml=opts.html?value:(value||'<span style="color:var(--text3)">—</span>');
  return `<div style="display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);align-items:flex-start">
    <div style="width:130px;flex-shrink:0;font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.3px;padding-top:2px">${label}</div>
    <div style="flex:1;font-size:13px;color:var(--text);${cls}word-break:break-word">${vHtml}</div>
  </div>`;
}
function _rdBadges(arr,color){
  if(!arr||!arr.length)return'<span style="color:var(--text3)">—</span>';
  const c=color||'#2a9aa0';const bg=c+'18';
  return arr.map(t=>`<span style="display:inline-block;background:${bg};color:${c};border:1px solid ${c}40;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:600;margin:1px 3px 1px 0">${t}</span>`).join('');
}
function _rdStatus(inactive){
  return inactive
    ?'<span style="display:inline-flex;align-items:center;gap:4px;background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;padding:3px 10px;border-radius:6px;font-size:12px;font-weight:700">● Inactive</span>'
    :'<span style="display:inline-flex;align-items:center;gap:4px;background:#dcfce7;color:#16a34a;border:1px solid #86efac;padding:3px 10px;border-radius:6px;font-size:12px;font-weight:700">● Active</span>';
}

function showRecordDetail(table,id){
  const rec=byId(DB[table],id);
  if(!rec)return;
  const title=document.getElementById('rdTitle');
  const body=document.getElementById('rdBody');
  const editBtn=document.getElementById('rdEditBtn');
  let html='';let titleText='';let editFn='';

  if(table==='users'){
    const u=rec;
    const loc=byId(DB.locations,u.plant);
    const locLabel=loc?(loc.colour?`<span style="background:${loc.colour};color:${colourContrast(loc.colour)};padding:2px 10px;border-radius:5px;font-weight:700;font-size:12px">${loc.name}</span>`:loc.name):(u.plant||'—');
    const apps=(u.apps||[]).map(id=>{const a=PORTAL_APPS.find(x=>x.id===id);return a?a.icon+' '+a.label:'';}).filter(Boolean);
    const photo=u.photo
      ?`<div style="text-align:center;margin-bottom:14px"><img src="${u.photo}" onclick="openPhoto(this.src)" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid var(--border2);cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12)"></div>`
      :`<div style="text-align:center;margin-bottom:14px"><div style="width:80px;height:80px;border-radius:50%;background:var(--surface2);border:3px solid var(--border);display:inline-flex;align-items:center;justify-content:center;font-size:36px;color:var(--text3)">👤</div></div>`;
    titleText=u.fullName||u.name;
    html=photo
      +_rdRow('Full Name',u.fullName)
      +_rdRow('Username',u.name,{mono:true})
      +_rdRow('Mobile',u.mobile)
      +_rdRow('Email',u.email)
      +_rdRow('Location',locLabel,{html:true})
      +_rdRow('Apps',_rdBadges(apps),{html:true})
      +_rdRow('VMS Roles',_rdBadges(u.roles),{html:true})
      +((u.hwmsRoles||[]).length?_rdRow('HWMS Roles',_rdBadges(u.hwmsRoles),{html:true}):'')
      +_rdRow('Status',_rdStatus(u.inactive),{html:true});
    // Reset Password button — visible to Admin/SA, but not for SA users
    const isMeAdminOrSA=CU&&(CU.roles.includes('Super Admin')||CU.roles.includes('Admin'));
    const isTargetSA=u.roles&&u.roles.includes('Super Admin');
    if(isMeAdminOrSA&&!isTargetSA&&u.id!==CU.id){
      html+=`<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
        <button onclick="_resetUserPwd('${u.id}')" style="width:100%;padding:10px;border-radius:9px;border:1.5px solid #ef4444;background:#fef2f2;color:#dc2626;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s" onmouseover="this.style.background='#fee2e2'" onmouseout="this.style.background='#fef2f2'">🔑 Reset Password to Default</button>
      </div>`;
    }
    editFn=`openUserModal('${id}')`;
  }
  else if(table==='vehicleTypes'){
    const v=rec;
    titleText=v.name;
    html=_rdRow('Type Name',v.name)
      +_rdRow('Capacity',v.capacity?v.capacity.toLocaleString()+' kg':'—')
      +_rdRow('Status',_rdStatus(v.inactive),{html:true});
    editFn=`openVTModal('${id}')`;
  }
  else if(table==='drivers'){
    const d=rec;
    const vendor=byId(DB.vendors,d.vendorId);
    const photo=d.photo?`<div style="text-align:center;margin-bottom:14px"><img src="${d.photo}" onclick="openPhoto(this.src)" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid var(--border2);cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12)"></div>`:'';
    titleText=d.name;
    html=photo
      +_rdRow('Driver Name',d.name)
      +_rdRow('Mobile',d.mobile)
      +_rdRow('Vendor',vendor?.name)
      +_rdRow('DL Expiry',d.dlExpiry?dateStatusHtml(d.dlExpiry):'—',{html:true})
      +_rdRow('Status',_rdStatus(d.inactive),{html:true});
    editFn=`openDrvModal('${id}')`;
  }
  else if(table==='vendors'){
    const v=rec;
    // Count linked vehicles and drivers
    const vehCount=DB.vehicles.filter(vh=>vh.vendorId===id).length;
    const drvCount=DB.drivers.filter(dr=>dr.vendorId===id).length;
    titleText=v.name;
    html=_rdRow('Vendor Name',v.name)
      +_rdRow('Owner',v.owner)
      +_rdRow('Contact',v.contact)
      +_rdRow('Address',v.address)
      +_rdRow('Linked Vehicles',vehCount?vehCount+' vehicle'+(vehCount>1?'s':''):'None')
      +_rdRow('Linked Drivers',drvCount?drvCount+' driver'+(drvCount>1?'s':''):'None')
      +_rdRow('Status',_rdStatus(v.inactive),{html:true});
    editFn=`openVndModal('${id}')`;
  }
  else if(table==='vehicles'){
    const v=rec;
    const vType=byId(DB.vehicleTypes,v.typeId);
    const vendor=byId(DB.vendors,v.vendorId);
    titleText=v.number;
    html=_rdRow('Vehicle No.',`<span style="font-weight:900;font-size:15px;letter-spacing:.5px">${v.number}</span>`,{html:true,mono:true})
      +_rdRow('Vehicle Type',vType?.name)
      +_rdRow('Vendor',vendor?.name)
      +_rdRow('PUC Expiry',v.pucExpiry?dateStatusHtml(v.pucExpiry):'—',{html:true})
      +_rdRow('RTO Expiry',v.rtpExpiry?dateStatusHtml(v.rtpExpiry):'—',{html:true})
      +_rdRow('Insurance Expiry',v.insExpiry?dateStatusHtml(v.insExpiry):'—',{html:true})
      +_rdRow('Status',_rdStatus(v.inactive),{html:true});
    editFn=`openVehModal('${id}')`;
  }
  else if(table==='locations'){
    const l=rec;
    const nameBadge=l.colour?`<span style="background:${l.colour};color:${colourContrast(l.colour)};padding:3px 12px;border-radius:6px;font-weight:700;font-size:13px">${l.name}</span>`:l.name;
    const typeBadge=`<span class="badge ${l.type==='KAP'?'badge-amber':'badge-blue'}" style="font-size:12px">${l.type}</span>`;
    // Compact user chip: small name + tiny location pill
    const _uChip=(uid)=>{
      const u=byId(DB.users,uid);if(!u) return '';
      const fn=u.fullName||u.name;
      const loc=byId(DB.locations,u.plant);
      const locHtml=loc?.name?` <span style="background:${loc.colour||'#e2e8f0'};color:${colourContrast(loc.colour||'#e2e8f0')};font-size:8px;font-weight:700;padding:0 4px;border-radius:3px;vertical-align:middle">${loc.name}</span>`:'';
      return `<span style="display:inline-flex;align-items:center;gap:2px;background:var(--surface2);border:1px solid var(--border);padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;color:var(--text);margin:1px 2px 1px 0;white-space:nowrap">${fn}${locHtml}</span>`;
    };
    const _uChips=(ids)=>{
      if(!ids||!ids.length) return '<span style="color:var(--text3);font-size:10px">—</span>';
      return `<div style="display:flex;flex-wrap:wrap;gap:2px">${ids.map(_uChip).join('')}</div>`;
    };
    titleText=l.name;
    html=_rdRow('Location',nameBadge,{html:true})
      +_rdRow('Type',typeBadge,{html:true})
      +_rdRow('Address',l.address)
      +_rdRow('Geo Coordinates',l.geo)
      +(l.type==='KAP'?
        _rdRow('KAP Security',l.kapSec?_uChip(l.kapSec):'<span style="color:var(--text3);font-size:10px">—</span>',{html:true})
        +_rdRow('Trip Booking',_uChips(l.tripBook),{html:true})
        +_rdRow('Mat. Receivers',_uChips(l.matRecv),{html:true})
        +_rdRow('Approvers',_uChips(l.approvers),{html:true})
        :'')
      +_rdRow('Status',_rdStatus(l.inactive),{html:true});
    editFn=`openLocModal('${id}')`;
  }
  else if(table==='tripRates'){
    const r=rec;
    const route=[r.start,r.dest1,r.dest2,r.dest3].filter(Boolean).map(lnameText).join(' ⟶ ');
    const statusBadge=r.status==='approved'?'<span class="badge badge-green">✓ Approved</span>'
      :r.status==='rejected'?'<span class="badge" style="background:rgba(239,68,68,.15);color:#dc2626">✗ Rejected</span>'
      :'<span class="badge" style="background:rgba(42,154,160,.15);color:var(--accent)">⏳ Pending</span>';
    titleText=r.name;
    html=_rdRow('Rate Name',r.name)
      +_rdRow('Vehicle Type',vtname(r.vTypeId))
      +_rdRow('Route',route)
      +_rdRow('Rate',`<span style="font-weight:900;color:#16a34a;font-size:16px">₹${r.rate.toLocaleString()}</span>`,{html:true})
      +_rdRow('Valid From',fd(r.validStart))
      +_rdRow('Valid To',fd(r.validEnd))
      +_rdRow('Approval',statusBadge,{html:true})
      +_rdRow('Added By',r.addedBy?uname(r.addedBy):'—');
    editFn=`openRateModal('${id}')`;
  }

  title.textContent=titleText;
  body.innerHTML=html;
  if(editBtn){
    const isAdmin=CU&&CU.roles&&CU.roles.some(r=>['Super Admin','Admin'].includes(r));
    const canEditExtended=CU&&CU.roles&&CU.roles.some(r=>['Super Admin','Admin','Trip Booking User','Material Receiver'].includes(r));
    let canEdit=isAdmin;
    if(table==='drivers'||table==='vehicles') canEdit=canEditExtended;
    if(table==='tripRates') canEdit=isAdmin||(rec.addedBy===CU?.id);
    editBtn.style.display=canEdit?'inline-flex':'none';
    editBtn.onclick=()=>{cm('mRecordDetail');eval(editFn);};
  }
  om('mRecordDetail');
}

// ═══ EXCEL IMPORT / EXPORT ═══════════════════════════════════════════════
const MASTER_SCHEMA = {
  users: {
    label: 'Users',
    render: renderUsers,
    toRow: u => ({
      'Username': u.name,
      'Full Name': u.fullName||'',
        'Mobile': u.mobile||'',
      'Roles': (u.roles||[]).join('; '),
      'HWMS Roles': (u.hwmsRoles||[]).join('; '),
      'Location': u.plant?(byId(DB.locations,u.plant)?.name||u.plant):'',
    }),
    fromRow: (r,idx) => {
      const name=(r['Username']||'').toString().trim().toLowerCase();
      const fullName=(r['Full Name']||'').toString().trim();
      const roles=(r['Roles']||'').toString().split(';').map(s=>s.trim()).filter(Boolean);
      const hwmsRoles=(r['HWMS Roles']||'').toString().split(';').map(s=>s.trim()).filter(Boolean);
      const locName=(r['Location']||'').toString().trim();
      const loc=locName?DB.locations.find(l=>l&&l.name.toLowerCase()===locName.toLowerCase()):null;
      if(!name) return null;
      return {id:'u'+uid(),name,fullName,_plainPass:(r['Password']||'Kappl@123').toString(),mobile:(r['Mobile']||'').toString(),roles,hwmsRoles,plant:loc?.id||''};
    },
    matchKey: r=>(r['Username']||'').toString().trim().toLowerCase(),
    dbMatchKey: u=>u.name,
    merge: (existing,r)=>{
      if(r['Full Name']!==undefined) existing.fullName=(r['Full Name']||'').toString().trim();
      if(r['Password']!==undefined) existing._plainPass=(r['Password']||'').toString();
      if(r['Mobile']!==undefined) existing.mobile=(r['Mobile']||'').toString();
      if(r['Roles']!==undefined) existing.roles=(r['Roles']||'').toString().split(';').map(s=>s.trim()).filter(Boolean);
      if(r['HWMS Roles']!==undefined) existing.hwmsRoles=(r['HWMS Roles']||'').toString().split(';').map(s=>s.trim()).filter(Boolean);
      if(r['Location']!==undefined){const locName=(r['Location']||'').toString().trim();const loc=locName?DB.locations.find(l=>l&&l.name.toLowerCase()===locName.toLowerCase()):null;existing.plant=loc?.id||'';}
    },
  },
  vehicleTypes: {
    label: 'Vehicle Types',
    render: renderVTypes,
    toRow: v => ({'Type Name': v.name, 'Capacity (kg)': v.capacity}),
    fromRow: r => {
      const name=(r['Type Name']||'').toString().trim();
      if(!name) return null;
      return {id:'vt'+uid(),name,capacity:parseFloat(r['Capacity (kg)'])||0};
    },
    matchKey: r=>(r['Type Name']||'').toString().trim().toLowerCase(),
    dbMatchKey: v=>v.name.toLowerCase(),
    merge: (e,r)=>{if(r['Capacity (kg)']!==undefined)e.capacity=parseFloat(r['Capacity (kg)'])||e.capacity;},
  },
  drivers: {
    label: 'Drivers',
    render: renderDrivers,
    toRow: d => ({'Driver Name': d.name,'Mobile': d.mobile||'','DL Expiry': d.dlExpiry||''}),
    fromRow: r => {
      const name=(r['Driver Name']||'').toString().trim();
      if(!name) return null;
      return {id:'d'+uid(),name,mobile:(r['Mobile']||'').toString(),dlExpiry:(r['DL Expiry']||'').toString()};
    },
    matchKey: r=>(r['Driver Name']||'').toString().trim().toLowerCase(),
    dbMatchKey: d=>d.name.toLowerCase(),
    merge: (e,r)=>{
      if(r['Mobile']!==undefined)e.mobile=(r['Mobile']||'').toString();
      if(r['DL Expiry']!==undefined)e.dlExpiry=(r['DL Expiry']||'').toString();
    },
  },
  vendors: {
    label: 'Vendors',
    render: renderVendors,
    toRow: v => ({'Vendor Name': v.name,'Owner': v.owner||'','Contact': v.contact||'','Address': v.address||''}),
    fromRow: r => {
      const name=(r['Vendor Name']||'').toString().trim();
      if(!name) return null;
      return {id:'vn'+uid(),name,owner:(r['Owner']||'').toString(),contact:(r['Contact']||'').toString(),address:(r['Address']||'').toString()};
    },
    matchKey: r=>(r['Vendor Name']||'').toString().trim().toLowerCase(),
    dbMatchKey: v=>v.name.toLowerCase(),
    merge: (e,r)=>{
      if(r['Owner']!==undefined)e.owner=(r['Owner']||'').toString();
      if(r['Contact']!==undefined)e.contact=(r['Contact']||'').toString();
      if(r['Address']!==undefined)e.address=(r['Address']||'').toString();
    },
  },
  vehicles: {
    label: 'Vehicles',
    render: renderVehicles,
    toRow: v => ({
      'Vehicle Number': v.number,
      'Vehicle Type': vtname(v.typeId),
      'Vendor': byId(DB.vendors,v.vendorId)?.name||'',
      'PUC Expiry': v.pucExpiry||'',
      'RTO Expiry': v.rtpExpiry||'',
        'Insurance Expiry': v.insExpiry||'',
    }),
    fromRow: r => {
      const number=(r['Vehicle Number']||'').toString().trim();
      if(!number) return null;
      const vt=(DB.vehicleTypes||[]).find(t=>t&&t.name.toLowerCase()===(r['Vehicle Type']||'').toString().trim().toLowerCase());
      const vn=DB.vendors.find(v=>v&&v.name.toLowerCase()===(r['Vendor']||'').toString().trim().toLowerCase());
      return {id:'vh'+uid(),number,typeId:vt?.id||'',vendorId:vn?.id||'',pucExpiry:(r['PUC Expiry']||'').toString(),rtpExpiry:(r['RTO Expiry']||r['RTP Expiry']||'').toString(),insExpiry:(r['Insurance Expiry']||'').toString()};
    },
    matchKey: r=>(r['Vehicle Number']||'').toString().trim().toUpperCase(),
    dbMatchKey: v=>v.number.toUpperCase(),
    merge: (e,r)=>{
      if(r['Vehicle Type']!==undefined){const vt=(DB.vehicleTypes||[]).find(t=>t&&t.name.toLowerCase()===(r['Vehicle Type']||'').toString().trim().toLowerCase());if(vt)e.typeId=vt.id;}
      if(r['Vendor']!==undefined){const vn=DB.vendors.find(v=>v&&v.name.toLowerCase()===(r['Vendor']||'').toString().trim().toLowerCase());if(vn)e.vendorId=vn.id;}
      if(r['PUC Expiry']!==undefined)e.pucExpiry=(r['PUC Expiry']||'').toString();
      if(r['RTO Expiry']!==undefined||r['RTP Expiry']!==undefined)e.rtpExpiry=(r['RTO Expiry']||r['RTP Expiry']||'').toString();
      if(r['Insurance Expiry']!==undefined)e.insExpiry=(r['Insurance Expiry']||'').toString();
    },
  },
  locations: {
    label: 'Locations',
    render: renderLocations,
    toRow: l => ({
      'Location Name': l.name,
      'Location Type': l.type,
      'Colour Tag': l.colour?colourName(l.colour):'',
      'Address': l.address||'',
      'Geo Coordinates': l.geo||'',
      'KAP Security User': l.kapSec?byId(DB.users,l.kapSec)?.name||'':'',
      'Trip Booking User': (l.tripBook||[]).map(id=>byId(DB.users,id)?.name||'').filter(Boolean).join('; '),
      'Material Receivers': (l.matRecv||[]).map(id=>byId(DB.users,id)?.name||id).join('; '),
      'Approvers': (l.approvers||[]).map(id=>byId(DB.users,id)?.name||id).join('; '),
    }),
    fromRow: r => {
      const name=(r['Location Name']||'').toString().trim();
      if(!name) return null;
      const type=(r['Location Type']||'External').toString().trim();
      const findUser=n=>DB.users.find(u=>u&&u.name.toLowerCase()===n.toString().trim().toLowerCase());
      const kapSecU=findUser(r['KAP Security User']||'');
      const tripBookU=(r['Trip Booking User']||'').toString().split(';').map(n=>findUser(n.trim())).filter(Boolean).map(u=>u.id);
      const matRecv=(r['Material Receivers']||'').toString().split(';').map(n=>findUser(n.trim())).filter(Boolean).map(u=>u.id);
      const approvers=(r['Approvers']||'').toString().split(';').map(n=>findUser(n.trim())).filter(Boolean).map(u=>u.id);
      // Resolve colour name back to hex
      const colLabel=(r['Colour Tag']||'').toString().trim();
      const colHex=colLabel?Object.entries({'#991b1b':'Maroon','#dc2626':'Red','#ea580c':'Orange','#d97706':'Amber','#eab308':'Yellow','#65a30d':'Lime','#16a34a':'Green','#0d9488':'Teal','#0891b2':'Cyan','#0369a1':'Blue','#175c60':'Royal','#1e3a8a':'Navy','#4338ca':'Indigo','#7c3aed':'Violet','#9333ea':'Purple','#a21caf':'Fuchsia','#be185d':'Pink','#9f1239':'Crimson','#374151':'Charcoal','#6b7280':'Gray'}).find(([,v])=>v.toLowerCase()===colLabel.toLowerCase())?.[0]||colLabel:'';
      return {id:'l'+uid(),name,type,colour:colHex,address:(r['Address']||'').toString(),geo:(r['Geo Coordinates']||'').toString(),
        kapSec:kapSecU?.id||'',tripBook:tripBookU,matRecv,approvers};
    },
    matchKey: r=>(r['Location Name']||'').toString().trim().toLowerCase(),
    dbMatchKey: l=>l.name.toLowerCase(),
    merge: (e,r)=>{
      const findUser=n=>DB.users.find(u=>u&&u.name.toLowerCase()===n.toString().trim().toLowerCase());
      if(r['Location Type']!==undefined)e.type=(r['Location Type']||e.type).toString().trim();
      if(r['Colour Tag']!==undefined){const colLabel=(r['Colour Tag']||'').toString().trim();e.colour=colLabel?Object.entries({'#991b1b':'Maroon','#dc2626':'Red','#ea580c':'Orange','#d97706':'Amber','#eab308':'Yellow','#65a30d':'Lime','#16a34a':'Green','#0d9488':'Teal','#0891b2':'Cyan','#0369a1':'Blue','#175c60':'Royal','#1e3a8a':'Navy','#4338ca':'Indigo','#7c3aed':'Violet','#9333ea':'Purple','#a21caf':'Fuchsia','#be185d':'Pink','#9f1239':'Crimson','#374151':'Charcoal','#6b7280':'Gray'}).find(([,v])=>v.toLowerCase()===colLabel.toLowerCase())?.[0]||colLabel:'';}
      if(r['Address']!==undefined)e.address=(r['Address']||'').toString();
      if(r['Geo Coordinates']!==undefined)e.geo=(r['Geo Coordinates']||'').toString();
      if(r['KAP Security User']!==undefined){const u=findUser(r['KAP Security User']||'');e.kapSec=u?.id||'';}
      if(r['Trip Booking User']!==undefined)e.tripBook=(r['Trip Booking User']||'').toString().split(';').map(n=>findUser(n.trim())).filter(Boolean).map(u=>u.id);
      if(r['Material Receivers']!==undefined)e.matRecv=(r['Material Receivers']||'').toString().split(';').map(n=>findUser(n.trim())).filter(Boolean).map(u=>u.id);
      if(r['Approvers']!==undefined)e.approvers=(r['Approvers']||'').toString().split(';').map(n=>findUser(n.trim())).filter(Boolean).map(u=>u.id);
    },
  },
  tripRates: {
    label: 'Trip Rates',
    render: renderRates,
    toRow: r => ({
      'Trip Name': r.name,
      'Vehicle Type': vtname(r.vTypeId),
      'Start': lnameText(r.start),
      'Destination 1': lnameText(r.dest1),
      'Destination 2': r.dest2?lnameText(r.dest2):'',
      'Destination 3': r.dest3?lnameText(r.dest3):'',
      'Rate (Rs)': r.rate,
      'Valid From': r.validStart||'',
      'Valid To': r.validEnd||'',
    }),
    fromRow: r => {
      const name=(r['Trip Name']||'').toString().trim();
      if(!name) return null;
      const findLoc=n=>DB.locations.find(l=>l&&l.name.toLowerCase()===n.toString().trim().toLowerCase());
      const vt=(DB.vehicleTypes||[]).find(t=>t&&t.name.toLowerCase()===(r['Vehicle Type']||'').toString().trim().toLowerCase());
      return {id:'rt'+uid(),name,vTypeId:vt?.id||'',
        start:findLoc(r['Start']||'')?.id||'',
        dest1:findLoc(r['Destination 1']||'')?.id||'',
        dest2:findLoc(r['Destination 2']||'')?.id||'',
        dest3:findLoc(r['Destination 3']||'')?.id||'',
        rate:parseFloat(r['Rate (Rs)'])||0,
        validStart:(r['Valid From']||'').toString(),validEnd:(r['Valid To']||'').toString()};
    },
    matchKey: r=>(r['Trip Name']||'').toString().trim().toLowerCase(),
    dbMatchKey: r=>r.name.toLowerCase(),
    merge: (e,r)=>{if(r['Rate (Rs)']!==undefined)e.rate=parseFloat(r['Rate (Rs)'])||e.rate;},
  },
};

// ── Excel Export/Import for User Master ─────────────────────────────────────
function exportUsersExcel(){
  if(!CU||!CU.roles.some(r=>['Super Admin','Admin'].includes(r))){notify('⚠ Export is restricted to Admin users only.',true);return;}
  const rows=DB.users.map(u=>({
    'Username': u.name||'',
    'Full Name': u.fullName||'',
    'Mobile': u.mobile||'',
    'Email': u.email||'',
    'Roles': (u.roles||[]).join('; '),
    'HWMS Roles': (u.hwmsRoles||[]).join('; '),
    'Location': u.plant?(byId(DB.locations,u.plant)?.name||u.plant):'',
    'Status': u.inactive?'Inactive':'Active',
  }));
  if(!rows.length){notify('No users to export',true);return;}
  const headers=Object.keys(rows[0]);
  const data=[headers,...rows.map(r=>headers.map(h=>r[h]===undefined||r[h]===null?'':r[h]))];
  const fname='KAP_Users_'+new Date().toISOString().split('T')[0]+'.xlsx';
  _downloadAsXls(data,'Users',fname);
  notify('✅ Users exported to Excel! ('+rows.length+' users)');
}

function importUsersExcel(inputEl){
  if(!CU||!CU.roles.some(r=>['Super Admin','Admin'].includes(r))){notify('⚠ Import is restricted to Admin users only.',true);if(inputEl)inputEl.value='';return;}
  const file=inputEl.files[0];
  if(!file){return;}
  inputEl.value='';
  const ext=file.name.split('.').pop().toLowerCase();
  if(ext==='xlsx'){
    const reader=new FileReader();
    reader.onload=async e=>{
      try{
        const rows=await _parseXLSX(e.target.result);
        if(!rows.length){notify('No data found in file',true);return;}
        _applyUsersImportRows(rows);
      }catch(err){notify('⚠ '+err.message,true);}
    };
    reader.readAsArrayBuffer(file);
  } else if(ext==='csv'){
    const reader=new FileReader();
    reader.onload=e=>{
      try{
        const rows=_parseCSV(e.target.result);
        if(!rows.length){notify('No data found in file',true);return;}
        _applyUsersImportRows(rows);
      }catch(err){notify('Import failed: '+err.message,true);}
    };
    reader.readAsText(file);
  } else {
    notify('⚠ Unsupported format. Use the exported .xlsx file.',true);
  }
}

async function _applyUsersImportRows(rows){
  if(!rows.length){notify('No data rows found.',true);return;}
  let added=0,updated=0,skipped=0,errors=[];
  for(const [idx,r] of rows.entries()){
    try{
      const name=(r['Username']||'').toString().trim().toLowerCase();
      const fullName=(r['Full Name']||'').toString().trim();
      if(!name){skipped++;return;}
      const roles=(r['Roles']||'').toString().split(';').map(s=>s.trim()).filter(Boolean);
      const hwmsRoles=(r['HWMS Roles']||'').toString().split(';').map(s=>s.trim()).filter(Boolean);
      const locName=(r['Location']||'').toString().trim();
      const loc=locName?DB.locations.find(l=>l&&l.name.toLowerCase()===locName.toLowerCase()):null;
      const isInactive=(r['Status']||'').toString().trim().toLowerCase()==='inactive';
      const existing=DB.users.find(u=>u&&u.name===name);
      if(existing){
        // Update existing user — save to Supabase
        existing.fullName=fullName||existing.fullName;
        if(r['Password']) existing._plainPass=r['Password'].toString();
        if(r['Mobile']) existing.mobile=r['Mobile'].toString();
        if(r['Email']) existing.email=r['Email'].toString();
        if(roles.length) existing.roles=roles;
        if(hwmsRoles.length) existing.hwmsRoles=hwmsRoles;
        if(loc) existing.plant=loc.id;
        existing.inactive=isInactive||false;
        var _ep=existing._plainPass;delete existing._plainPass;
        const _uUpdOk = await _dbSave('users', existing);
        if(_uUpdOk){updated++;if(_ep)await _authSetPassword(existing.id,_ep);}else skipped++;
      } else {
        // Add new user
        const newUser={
          id:'u'+uid(),
          name,
          fullName,
          _plainPass:(r['Password']||'Kappl@123').toString(),
          mobile:(r['Mobile']||'').toString(),
          email:(r['Email']||'').toString(),
          roles:roles.length?roles:['Viewer'],
          hwmsRoles:hwmsRoles,
          plant:loc?.id||'',
          inactive:isInactive||false,
        };
        var _plainPw=newUser._plainPass||'Kappl@123';delete newUser._plainPass;
        const _uOk = await _dbSave('users', newUser);
        if(_uOk){added++;await _authSetPassword(newUser.id,_plainPw);}else skipped++;
      }
    }catch(e){errors.push('Row '+(idx+2)+': '+e.message);skipped++;}
  }
  
  // Refresh both VMS and portal user lists
  if(typeof renderUsers==='function') renderUsers();
  let msg=`✅ Import done: ${added} added, ${updated} updated`;
  if(skipped) msg+=`, ${skipped} skipped`;
  notify(msg, errors.length>0);
  if(errors.length) console.warn('Import warnings:',errors);
}

function exportMaster(col){
  if(!CU||!CU.roles.some(r=>['Super Admin','Admin'].includes(r))){notify('⚠ Export is restricted to Admin users only.',true);return;}
  const schema=MASTER_SCHEMA[col];
  if(!schema){notify('Export not supported for this master',true);return;}
  let objRows;
  if(schema._flatExport){
    objRows=[];
    (DB[col]||[]).forEach(item=>{
      const rows=schema.toRow(item);
      if(Array.isArray(rows)) objRows.push(...rows);
      else objRows.push(rows);
    });
  } else {
    objRows=(DB[col]||[]).map(schema.toRow);
  }
  if(!objRows.length){notify('No data to export',true);return;}
  const headers=Object.keys(objRows[0]);
  const data=[headers,...objRows.map(r=>headers.map(h=>r[h]===undefined||r[h]===null?'':r[h]))];
  const fname=`KAP_${schema.label.replace(/\s+/g,'_')}_${new Date().toISOString().split('T')[0]}.xlsx`;
  _downloadAsXls(data, schema.label, fname);
  notify(`✅ ${schema.label} exported to Excel!`);
}

// ═══ VENDOR TRIPS PAGE ══════════════════════════════════════════════════
function _isVtAdmin(){ return CU&&CU.roles.some(r=>['Super Admin','Admin'].includes(r)); }
function _getMyVendor(){
  if(!CU) return null;
  return DB.vendors.find(v=>v.userId===CU.id&&!v.inactive)||null;
}
function _getVendorVehicleIds(vendor){
  if(!vendor) return [];
  return DB.vehicles.filter(v=>v.vendorId===vendor.id).map(v=>v.id);
}
// Vendor trip status: Booked / In Progress / Complete
function _vtStatus(trip){
  const segs=DB.segments.filter(s=>s.tripId===trip.id);
  if(!segs.length) return 'Booked';
  if(segs.every(s=>s.status==='Completed')) return 'Complete';
  if(segs.some(s=>[1,2,3,4,5].some(n=>s.steps[n]?.done))) return 'In Progress';
  return 'Booked';
}
function _getTripsForVendor(vendor,from,to,statusFilter,vehicleFilter){
  if(!vendor) return [];
  const vehIds=_getVendorVehicleIds(vendor);
  return DB.trips.filter(t=>{
    if(!vehIds.includes(t.vehicleId)&&t.vendor!==vendor.name) return false;
    const d=(t.date||'').slice(0,10);
    if(from&&d<from) return false;
    if(to&&d>to) return false;
    if(statusFilter){ if(_vtStatus(t)!==statusFilter) return false; }
    if(vehicleFilter&&t.vehicleId!==vehicleFilter) return false;
    return true;
  }).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
}
function _getAllVendorTrips(from,to,statusFilter,vendorFilter,vehicleFilter){
  let vendors=DB.vendors.filter(v=>!v.inactive);
  if(vendorFilter) vendors=vendors.filter(v=>v.id===vendorFilter);
  const allTrips=[];
  vendors.forEach(vendor=>{
    const trips=_getTripsForVendor(vendor,from,to,statusFilter,vehicleFilter);
    trips.forEach(t=>allTrips.push({trip:t,vendor}));
  });
  allTrips.sort((a,b)=>(b.trip.date||'').localeCompare(a.trip.date||''));
  return allTrips;
}
// Populate vendor filter dropdown (Admin/SA only)
function _populateVtVendorFilter(){
  const sel=document.getElementById('vtVendorFilter');
  if(!sel) return;
  const cur=sel.value;
  sel.innerHTML='<option value="">All Vendors ▾</option>'+DB.vendors.filter(v=>!v.inactive).sort((a,b)=>a.name.localeCompare(b.name)).map(v=>`<option value="${v.id}">${v.name}</option>`).join('');
  sel.value=cur;
}
// Populate vehicle filter dropdown based on selected vendor
function _populateVtVehicleFilter(vendorId){
  const sel=document.getElementById('vtVehicleFilter');
  if(!sel) return;
  const cur=sel.value;
  let vehs;
  if(vendorId){
    vehs=DB.vehicles.filter(v=>v.vendorId===vendorId&&!v.inactive);
  } else if(_isVtAdmin()){
    const vendorIds=DB.vendors.filter(v=>!v.inactive).map(v=>v.id);
    vehs=DB.vehicles.filter(v=>vendorIds.includes(v.vendorId)&&!v.inactive);
  } else {
    const myV=_getMyVendor();
    vehs=myV?DB.vehicles.filter(v=>v.vendorId===myV.id&&!v.inactive):[];
  }
  sel.innerHTML='<option value="">All Vehicles ▾</option>'+vehs.sort((a,b)=>(a.number||'').localeCompare(b.number||'')).map(v=>`<option value="${v.id}">${v.number}</option>`).join('');
  sel.value=cur;
}
function _onVtVendorChange(){
  const vendorId=document.getElementById('vtVendorFilter')?.value||'';
  _populateVtVehicleFilter(vendorId);
  const vSel=document.getElementById('vtVehicleFilter');
  if(vSel) vSel.value='';
}
let _vtDatesInit=false;
function _initVtDates(){
  if(_vtDatesInit) return;
  _vtDatesInit=true;
  setDateRange('vtFrom','vtTo','month',null,'vt');
}
function renderVendorTrips(){
  _initVtDates();
  const isAdmin=_isVtAdmin();
  const vendor=isAdmin?null:_getMyVendor();
  const nameEl=document.getElementById('vtVendorName');
  const listEl=document.getElementById('vtTripList');
  const statsEl=document.getElementById('vtStats');

  // Show/hide admin filters
  const vndF=document.getElementById('vtVendorFilter');
  const vehF=document.getElementById('vtVehicleFilter');
  if(vndF) vndF.style.display=isAdmin?'':'none';
  if(vehF) vehF.style.display='';

  if(isAdmin){
    _populateVtVendorFilter();
    _populateVtVehicleFilter(vndF?.value||'');
    if(nameEl) nameEl.textContent='All vendor trip details';
  } else {
    _populateVtVehicleFilter('');
    if(nameEl) nameEl.textContent=vendor?vendor.name+' — '+vendor.owner:'No vendor mapped to your account';
  }

  if(!isAdmin&&!vendor){
    if(listEl) listEl.innerHTML='<div class="empty-state" style="padding:40px 20px"><div style="font-size:32px;margin-bottom:12px">🔗</div><div style="font-size:15px;font-weight:700;margin-bottom:6px">Account Not Linked</div><div style="font-size:13px;color:var(--text2)">Your user account is not mapped to any vendor in the system. Please contact an Admin to link your account in the Vendor Master.</div></div>';
    if(statsEl) statsEl.innerHTML='';
    return;
  }

  const from=document.getElementById('vtFrom')?.value||'';
  const to=document.getElementById('vtTo')?.value||'';
  const statusFilter=document.getElementById('vtStatusFilter')?.value||'';
  const vendorFilter=vndF?.value||'';
  const vehicleFilter=vehF?.value||'';

  let tripItems;
  if(isAdmin){
    tripItems=_getAllVendorTrips(from,to,statusFilter,vendorFilter,vehicleFilter);
  } else {
    const trips=_getTripsForVendor(vendor,from,to,statusFilter,vehicleFilter);
    tripItems=trips.map(t=>({trip:t,vendor}));
  }
  // Trip ID search filter
  const vtSearch=(document.getElementById('vtTripSearch')?.value||'').toLowerCase();
  if(vtSearch) tripItems=tripItems.filter(x=>(x.trip?.id||'').toLowerCase().includes(vtSearch)||vnum(x.trip?.vehicleId).toLowerCase().includes(vtSearch));

  // Stats
  const total=tripItems.length;
  const completed=tripItems.filter(x=>_vtStatus(x.trip)==='Complete').length;
  const inProgress=tripItems.filter(x=>_vtStatus(x.trip)==='In Progress').length;
  const booked=tripItems.filter(x=>_vtStatus(x.trip)==='Booked').length;
  let totalBilled=0;tripItems.forEach(x=>{const r=getMatchedRate(x.trip?.id);if(r)totalBilled+=r.rate;});
  if(statsEl) statsEl.innerHTML=`
    <div style="flex:2;min-width:140px;padding:10px 14px;background:var(--surface);border:2px solid var(--accent);border-radius:8px"><div style="font-size:10px;color:var(--accent);font-weight:700;text-transform:uppercase">Total Trips</div><div style="font-size:26px;font-weight:900;font-family:var(--mono);color:var(--text)">${total}</div><div style="font-size:16px;font-weight:800;font-family:var(--mono);color:#16a34a;margin-top:2px">₹${totalBilled.toLocaleString()}</div></div>
    <div style="flex:1;min-width:70px;padding:10px 14px;background:rgba(0,0,0,.03);border:1px solid var(--border);border-radius:8px"><div style="font-size:10px;color:var(--text3);font-weight:600;text-transform:uppercase">Booked</div><div style="font-size:22px;font-weight:800;font-family:var(--mono);color:var(--text3)">${booked}</div></div>
    <div style="flex:1;min-width:70px;padding:10px 14px;background:rgba(42,154,160,.06);border:1px solid rgba(42,154,160,.2);border-radius:8px"><div style="font-size:10px;color:var(--accent);font-weight:600;text-transform:uppercase">Active</div><div style="font-size:22px;font-weight:800;font-family:var(--mono);color:var(--accent)">${inProgress}</div></div>
    <div style="flex:1;min-width:70px;padding:10px 14px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:8px"><div style="font-size:10px;color:#16a34a;font-weight:600;text-transform:uppercase">Done</div><div style="font-size:22px;font-weight:800;font-family:var(--mono);color:#16a34a">${completed}</div></div>`;

  if(!tripItems.length){
    if(listEl) listEl.innerHTML='<div class="empty-state">No trips found for the selected period</div>';
    return;
  }

  // Table format — 4 columns: Trip ID | Vehicle/Driver | Route/Date/Rate | Status dot
  const thead=`<thead><tr><th>Trip ID</th><th>Vehicle / Driver</th><th>Route / Date / Rate</th><th style="width:12px;padding:0"></th></tr></thead>`;

  const _vtShortDate=(d)=>{if(!d)return'—';const dt=new Date(d);return dt.getDate()+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getMonth()]+', '+dt.toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit',hour12:true}).toLowerCase();};
  const _vtDot=(st)=>{
    if(st==='Complete') return '<span title="Complete" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#16a34a"></span>';
    if(st==='In Progress') return '<span title="In Progress" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f59e0b"></span>';
    return '<span title="Booked" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#d1d5db"></span>';
  };

  const tbody=tripItems.map((item,i)=>{
    const t=item.trip;
    const vnd=item.vendor;
    const drv=byId(DB.drivers,t.driverId);
    const vType=byId(DB.vehicleTypes,t.vehicleTypeId)?.name||'—';
    const locs=[t.startLoc,t.dest1,t.dest2,t.dest3].filter(Boolean);
    const routeLines=[];
    for(let ri=0;ri<locs.length-1;ri++){
      const from=lnameText(locs[ri]),to=lnameText(locs[ri+1]);
      routeLines.push(ri===0?`${from} → ${to}`:`→ ${to}`);
    }
    const st=_vtStatus(t);
    const rate=getMatchedRate(t.id);
    return `<tr>
      <td style="vertical-align:middle"><span style="font-family:var(--mono);font-size:13px;font-weight:800;color:var(--accent)">${_cTid(t.id)}</span></td>
      <td><div style="font-family:var(--mono);font-size:13px;font-weight:700;line-height:1.5">${vnum(t.vehicleId)}</div><div style="font-size:11px;color:var(--text3);line-height:1.5">${vType}</div><div style="font-size:11px;color:var(--text2);line-height:1.5">${drv?.name||'—'}</div>${isAdmin&&vnd?`<div style="font-size:11px;color:var(--accent);font-weight:600;line-height:1.5">${vnd.name}</div>`:''}</td>
      <td>${routeLines.map(r=>`<div style="font-size:12px;line-height:1.5">${r}</div>`).join('')}<div style="font-size:11px;color:var(--text3);line-height:1.5;margin-top:2px">${_vtShortDate(t.date)}</div><div style="font-family:var(--mono);font-size:12px;font-weight:700;color:#16a34a;line-height:1.5">${rate?'₹'+rate.rate.toLocaleString():'—'}</div></td>
      <td style="vertical-align:middle;text-align:center;padding:0 2px">${_vtDot(st)}</td>
    </tr>`;
  }).join('');

  if(listEl) listEl.innerHTML=`<table style="width:100%;font-size:13px;border-collapse:collapse"><style>#vtTripList table th{padding:6px 8px;font-size:12px;border-bottom:1.5px solid var(--border)}#vtTripList table td{padding:8px;line-height:1.3;vertical-align:top;border-bottom:1px solid var(--border)}</style>${thead}<tbody>${tbody}</tbody></table>`;
}

// ===== SECURITY CHECKPOINT MASTER =====

// Live border update for location checkbox groups
['locTripBook','locMatRecv','locApprover'].forEach(groupId=>{
  document.addEventListener('change',function(e){
    if(e.target.type==='checkbox'&&e.target.closest('#'+groupId)){
      e.target.closest('label').style.borderColor=e.target.checked?'var(--accent)':'var(--border)';
    }
  });
});

// ── Global Enter key handler for form submission ──
document.addEventListener('keydown', function(e){
  if(e.key!=='Enter') return;
  var el=e.target;
  if(!el||el.tagName==='TEXTAREA') return; // don't intercept textarea
  if(el.tagName==='BUTTON') return; // let button clicks handle themselves
  // Login form
  var loginPage=document.getElementById('loginPage');
  if(loginPage&&loginPage.style.display!=='none'&&loginPage.contains(el)){
    e.preventDefault(); doLogin(); return;
  }
  // Modal — find nearest .modal-overlay or [id^="m"] parent, then click its .btn-primary
  var modal=el.closest('.modal-overlay')||el.closest('[id^="mHwms"]')||el.closest('[id^="m"][style*="display:flex"]');
  if(modal){
    var btn=modal.querySelector('.btn-primary');
    if(btn&&!btn.disabled){e.preventDefault();btn.click();return;}
  }
  // Card with form-like inputs — find nearest .card parent, then click its .btn-primary
  var card=el.closest('.card');
  if(card){
    var btn2=card.querySelector('.btn-primary');
    if(btn2&&!btn2.disabled){e.preventDefault();btn2.click();return;}
  }
});

// ═══ HELPER PAGE (Super Admin only) ══════════════════════════════════════
function renderHelper(){
  const el=document.getElementById('helperContent');if(!el)return;
  const s=(title,color,content)=>`<div style="background:${color};border-radius:10px;padding:16px 18px;margin-bottom:14px">
    <div style="font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px;color:var(--text)">${title}</div>
    <div style="font-size:13px;line-height:1.7;color:var(--text2)">${content}</div></div>`;
  const t=(rows)=>rows.map(r=>`<tr>${r.map(c=>`<td style="padding:5px 10px;border:1px solid var(--border);font-size:12px">${c}</td>`).join('')}</tr>`).join('');
  const th=(cols)=>`<thead><tr>${cols.map(c=>`<th style="padding:5px 10px;border:1px solid var(--border);font-size:11px;background:var(--surface2);font-weight:700;text-transform:uppercase">${c}</th>`).join('')}</tr></thead>`;

  // Build Trip ID Allocation table
  const now=new Date();
  const yLast=String(now.getFullYear()).slice(-1);
  const prefixMap={};
  (DB.trips||[]).forEach(trip=>{
    const m=trip.id.match(/^(\d+P\d+-)/);
    if(m){
      const prefix=m[1];
      const serial=parseInt(trip.id.slice(prefix.length),10)||0;
      if(!prefixMap[prefix]||serial>prefixMap[prefix].max){
        prefixMap[prefix]={max:serial,count:(prefixMap[prefix]?.count||0)+1,lastTrip:trip.id};
      } else {
        prefixMap[prefix].count++;
      }
    }
  });
  // Get all KAP locations for reference
  const kapLocs=(DB.locations||[]).filter(l=>l.type==='KAP').sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  let allocRows='';
  kapLocs.forEach(loc=>{
    const digits=(loc.name||'').replace(/[^0-9]/g,'');
    const plantCode=digits?'P'+digits:'P0';
    const prefix=yLast+plantCode+'-';
    const data=prefixMap[prefix]||{max:0,count:0,lastTrip:'—'};
    const nextId=prefix+(data.max+1);
    const locColor=loc.colour||'#64748b';
    allocRows+=`<tr>
      <td style="padding:6px 10px;border:1px solid var(--border);font-size:12px"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${locColor};margin-right:6px;vertical-align:middle"></span>${loc.name}</td>
      <td style="padding:6px 10px;border:1px solid var(--border);font-size:12px;font-family:var(--mono);font-weight:700;color:var(--accent)">${prefix}</td>
      <td style="padding:6px 10px;border:1px solid var(--border);font-size:12px;font-family:var(--mono);text-align:center">${data.count}</td>
      <td style="padding:6px 10px;border:1px solid var(--border);font-size:12px;font-family:var(--mono);text-align:center;font-weight:700">${data.max||'—'}</td>
      <td style="padding:6px 10px;border:1px solid var(--border);font-size:12px;font-family:var(--mono);font-weight:800;color:#16a34a">${nextId}</td>
    </tr>`;
  });

  // Count spot vehicles pending exit > 48hrs
  var _spotStale=(DB.spotTrips||[]).filter(function(s){return !s.exitTime&&s.entryTime&&(Date.now()-new Date(s.entryTime).getTime())>48*3600000;});

  el.innerHTML=`
  <!-- REPAIR TOOLS -->
  ${s('🔧 Repair Tools','rgba(220,38,38,.06)',`
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start">
      <div style="flex:1;min-width:250px">
        <p style="margin:0 0 8px"><strong>Mark Empty Exit for Old Trips:</strong> Finds all trips with vehicles waiting for Empty Vehicle Exit and marks step 5 as completed without requiring a photo.</p>
        <button onclick="_repairMarkEmptyExitDone()" style="padding:8px 20px;font-size:12px;font-weight:800;background:#dc2626;border:none;color:#fff;border-radius:6px;cursor:pointer">🔧 Mark All Empty Exits Done</button>
        <div id="repairEmptyExitResult" style="margin-top:10px;font-size:12px;display:none"></div>
      </div>
      <div style="flex:1;min-width:250px">
        <p style="margin:0 0 8px"><strong>Auto-Exit Stale Spot Vehicles:</strong> Spot vehicles inside for more than 48 hours with no exit recorded. Marks them as auto-exited without photo.</p>
        <div style="font-size:12px;margin-bottom:8px;font-weight:700;color:${_spotStale.length?'#dc2626':'#16a34a'}">${_spotStale.length} spot vehicle(s) pending exit &gt; 48 hrs</div>
        <button onclick="_repairAutoExitSpotVehicles()" style="padding:8px 20px;font-size:12px;font-weight:800;background:#f59e0b;border:none;color:#fff;border-radius:6px;cursor:pointer" ${_spotStale.length?'':'disabled style="opacity:.5;cursor:not-allowed"'}>🏁 Auto-Exit Stale Spot Vehicles</button>
        <div id="repairSpotExitResult" style="margin-top:10px;font-size:12px;display:none"></div>
      </div>
    </div>
  `)}
  <!-- TRIP ID ALLOCATION TOOL -->
  <div style="background:linear-gradient(135deg,rgba(42,154,160,.08),rgba(34,197,94,.08));border:2px solid var(--accent);border-radius:12px;padding:18px 20px;margin-bottom:18px">
    <div style="font-size:14px;font-weight:900;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;color:var(--accent);display:flex;align-items:center;gap:8px">
      🔢 Trip ID Allocation
      <button onclick="renderHelper()" style="margin-left:auto;padding:4px 12px;font-size:11px;font-weight:700;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer">🔄 Refresh</button>
    </div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:12px">Current year digit: <strong>${yLast}</strong> (${now.getFullYear()})</div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden">
        <thead><tr style="background:var(--surface2)">
          <th style="padding:8px 10px;border:1px solid var(--border);font-size:11px;font-weight:800;text-align:left">Location</th>
          <th style="padding:8px 10px;border:1px solid var(--border);font-size:11px;font-weight:800;text-align:left">Prefix</th>
          <th style="padding:8px 10px;border:1px solid var(--border);font-size:11px;font-weight:800;text-align:center">Trip Count</th>
          <th style="padding:8px 10px;border:1px solid var(--border);font-size:11px;font-weight:800;text-align:center">Last #</th>
          <th style="padding:8px 10px;border:1px solid var(--border);font-size:11px;font-weight:800;text-align:left">Next ID</th>
        </tr></thead>
        <tbody>${allocRows||'<tr><td colspan="5" style="padding:12px;text-align:center;color:var(--text3)">No KAP locations found</td></tr>'}</tbody>
      </table>
    </div>
  </div>

  <!-- TRIP STATUS RETRIEVER TOOL -->
  <div style="background:linear-gradient(135deg,rgba(139,92,246,.08),rgba(59,130,246,.08));border:2px solid #8b5cf6;border-radius:12px;padding:18px 20px;margin-bottom:18px">
    <div style="font-size:14px;font-weight:900;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;color:#7c3aed;display:flex;align-items:center;gap:8px">
      🔍 Trip Status Retriever
    </div>
    <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-bottom:12px">
      <div style="flex:1;min-width:200px">
        <label style="display:block;font-size:11px;font-weight:700;color:var(--text2);margin-bottom:4px;text-transform:uppercase">Enter Trip ID</label>
        <input type="text" id="helperTripIdInput" placeholder="e.g. 6P2-15" style="width:100%;padding:10px 14px;font-size:15px;font-family:var(--mono);font-weight:700;border:2px solid #a78bfa;border-radius:8px;text-transform:uppercase" onkeydown="if(event.key==='Enter')_helperLookupTrip()">
      </div>
      <button onclick="_helperLookupTrip()" style="padding:10px 20px;font-size:13px;font-weight:800;background:#7c3aed;color:#fff;border:none;border-radius:8px;cursor:pointer;white-space:nowrap">🔍 Look Up</button>
    </div>
    <div id="helperTripResult" style="display:none"></div>
  </div>

  ${s('📋 Trip ID Generation','rgba(59,130,246,.06)',`
    <p style="margin:0 0 8px"><strong>Format:</strong> <code style="background:var(--surface2);padding:2px 8px;border-radius:4px;font-family:var(--mono);font-weight:700">Y + P# + - + Serial</code></p>
    <p style="margin:0 0 6px"><strong>Y</strong> = Last digit of year (2026 → 6)</p>
    <p style="margin:0 0 6px"><strong>P#</strong> = Plant code from location name digits (KAP 2 → P2, KAP 13 → P13)</p>
    <p style="margin:0 0 6px"><strong>Serial</strong> = Auto-incremented per prefix</p>
    <p style="margin:0 0 10px"><strong>Example:</strong> <span style="font-family:var(--mono);font-weight:800;color:var(--accent)">6P2-15</span> = Year 2026, Plant 2, Trip #15</p>
    <div style="font-size:12px;font-weight:700;margin-bottom:4px">Plant code resolution:</div>
    <table style="width:100%;border-collapse:collapse;margin-top:4px">
    ${th(['Trip Type','Plant Code Source','Example'])}
    <tbody>
    ${t([
      ['KAP → Any','Start location','KAP 2 → External = 6P2-xx'],
      ['External → KAP','Destination location','External → KAP 3 = 6P3-xx'],
      ['External → External','Booking user\'s plant','User at KAP 1 = 6P1-xx'],
    ])}
    </tbody></table>
  `)}

  ${s('🔀 Segment Allocation (A / B / C)','rgba(42,154,160,.06)',`
    <p style="margin:0 0 8px">Each trip can have <strong>1 to 3 segments</strong> based on number of destinations:</p>
    <table style="width:100%;border-collapse:collapse;margin-top:4px">
    ${th(['Destinations','Segments Created','Route'])}
    <tbody>
    ${t([
      ['1 destination','Segment A only','Start → Dest1'],
      ['2 destinations','Segment A + B','Start → Dest1 (A), Dest1 → Dest2 (B)'],
      ['3 destinations','Segment A + B + C','Start → Dest1 (A), Dest1 → Dest2 (B), Dest2 → Dest3 (C)'],
    ])}
    </tbody></table>
    <p style="margin:8px 0 0"><strong>Segment locking:</strong> B is locked until A completes Gate Exit + Entry. C is locked until B completes Gate Exit + Entry.</p>
  `)}

  ${s('🔄 5-Step Workflow Per Segment','rgba(34,197,94,.06)',`
    <table style="width:100%;border-collapse:collapse;margin-top:4px">
    ${th(['Step','Name','Role','Location','Action'])}
    <tbody>
    ${t([
      ['1','🚪 Gate Exit','KAP Security','Source (sLoc)','Record vehicle exit from plant gate'],
      ['2','🏁 Gate Entry','KAP Security','Destination (dLoc)','Record vehicle entry at destination gate'],
      ['3','📦 Material Receipt','Material Receiver','Destination (dLoc)','Acknowledge material received / discrepancy / not received'],
      ['4','✅ Trip Approval','Trip Approver','Destination (dLoc)','Approve or reject the trip segment'],
      ['5','📤 Empty Exit','KAP Security','Destination (dLoc)','Record empty vehicle exit (auto-skipped for last segment if vehicle returns)'],
    ])}
    </tbody></table>
    <p style="margin:8px 0 4px"><strong>Step 5 skip rules:</strong></p>
    <p style="margin:0 0 4px">• Single-segment trip (A only): Step 5 is active — vehicle exits empty</p>
    <p style="margin:0 0 4px">• Multi-segment: Intermediate segments auto-skip step 5 (vehicle continues to next destination)</p>
    <p style="margin:0">• Last segment: Step 5 is active if vehicle needs empty exit</p>
  `)}

  ${s('👥 User Roles & Permissions','rgba(139,92,246,.06)',`
    <table style="width:100%;border-collapse:collapse;margin-top:4px">
    ${th(['Role','Access Pages','Can Do'])}
    <tbody>
    ${t([
      ['<strong>Super Admin</strong>','All pages + Helper','Everything: all masters, all operations, reports, delete trips, revoke actions, approve rates'],
      ['<strong>Admin</strong>','Dashboard, all operations, all masters','Same as Super Admin minus Helper page'],
      ['<strong>Trip Booking User</strong>','Trip Booking, Vehicles, Drivers','Book/edit trips at their assigned plant locations only; see only their plant trips + trips they booked'],
      ['<strong>KAP Security</strong>','KAP Security','Gate Exit (step 1) and Gate Entry (step 2) at assigned location; Empty Exit (step 5); Spot vehicle entry'],
      ['<strong>Material Receiver</strong>','Material Receipt, Vehicles, Drivers','Acknowledge material receipt (step 3) at assigned location'],
      ['<strong>Trip Approver</strong>','Trip Approvals','Approve/reject trips (step 4) at assigned location'],
      ['<strong>Vendor</strong>','My Trips (Vendor)','View-only: see trips for their vendor\'s vehicles, trip status, rates'],
    ])}
    </tbody></table>
  `)}

  ${s('📍 Location-Based Access','rgba(234,88,12,.06)',`
    <p style="margin:0 0 8px">Each location in Location Master has role assignments:</p>
    <table style="width:100%;border-collapse:collapse;margin-top:4px">
    ${th(['Location Field','Controls Access To'])}
    <tbody>
    ${t([
      ['<strong>KAP Security</strong>','Who can do Gate Exit/Entry at this location'],
      ['<strong>Trip Booking</strong>','Who can book trips from/to this location; which trips they see on Trip Booking page'],
      ['<strong>Material Receiver(s)</strong>','Who can acknowledge material receipt at this location'],
      ['<strong>Approver(s)</strong>','Who can approve/reject trips at this location'],
    ])}
    </tbody></table>
    <p style="margin:8px 0 4px"><strong>Location types:</strong></p>
    <p style="margin:0 0 4px">• <span class="badge badge-amber" style="font-size:10px">KAP</span> = Internal plant (has gate security, material receipt, approvals)</p>
    <p style="margin:0">• <span class="badge badge-blue" style="font-size:10px">External</span> = External vendor/customer location</p>
  `)}

  ${s('👁 Trip Visibility Rules','rgba(220,38,38,.06)',`
    <table style="width:100%;border-collapse:collapse;margin-top:4px">
    ${th(['Page','Who Sees What'])}
    <tbody>
    ${t([
      ['<strong>Trip Booking</strong>','Only trips where start/destination matches user\'s plant or tripBook locations, OR trips booked by the user'],
      ['<strong>KAP Security</strong>','Pending segments where user is assigned as KAP Security at source (exit) or destination (entry) location'],
      ['<strong>Material Receipt</strong>','Pending segments where user is Material Receiver at destination location'],
      ['<strong>Trip Approval</strong>','Pending segments where user is Approver at destination location'],
      ['<strong>Dashboard</strong>','Aggregated stats for all trips the user can access via any role assignment'],
      ['<strong>My Trips (Vendor)</strong>','Trips using vehicles owned by the vendor linked to user account'],
    ])}
    </tbody></table>
  `)}

  ${s('💰 Trip Rate Matching','rgba(234,179,8,.06)',`
    <p style="margin:0 0 8px">Rates are matched by <strong>vehicle type + exact route + date within valid period</strong>:</p>
    <p style="margin:0 0 4px">1. Match <code>vehicleTypeId</code> + <code>startLoc</code> + <code>dest1</code> + <code>dest2</code> + <code>dest3</code></p>
    <p style="margin:0 0 4px">2. Trip date must fall within rate's <code>validStart</code> – <code>validEnd</code> range</p>
    <p style="margin:0 0 4px">3. Rate must be <code>approved</code> status</p>
    <p style="margin:0 0 8px">4. If multiple rates match, the one with latest <code>validStart</code> wins</p>
    <p style="margin:0"><strong>Unapproved rates</strong> are visible in Trip Rate Master but not applied to trips until approved by Admin/Super Admin.</p>
  `)}

  ${s('🔢 Trip ID Color Coding','rgba(42,154,160,.06)',`
    <p style="margin:0 0 8px">Trip IDs show the <strong>plant code portion</strong> in the location's assigned color:</p>
    <p style="margin:0 0 4px">• <span style="font-family:var(--mono);font-weight:800">6<span style="background:#0d9488;color:#fff;padding:1px 4px;border-radius:4px">P2</span>-15</span> = Plant 2 trips use Plant 2's color tag</p>
    <p style="margin:0 0 4px">• <span style="font-family:var(--mono);font-weight:800">6<span style="background:#ea580c;color:#fff;padding:1px 4px;border-radius:4px">P1</span>-8</span> = Plant 1 trips use Plant 1's color tag</p>
    <p style="margin:0">• Colors are assigned in <strong>Location Master → Colour Tag</strong></p>
  `)}

  ${s('📱 Spot Vehicle Entry','rgba(22,163,74,.06)',`
    <p style="margin:0 0 8px"><strong>Purpose:</strong> Record unplanned/spot vehicle entries that don't have a pre-booked trip.</p>
    <p style="margin:0 0 4px">• Available on KAP Security page → Spot Entry tab</p>
    <p style="margin:0 0 4px">• KAP Security user records vehicle number, driver, supplier, challan details</p>
    <p style="margin:0 0 4px">• Creates a spot record (not a full trip) for tracking purposes</p>
    <p style="margin:0">• Spot entries show in history with timestamp and recording user</p>
  `)}

  ${s('⚙ Data Model Summary','rgba(107,114,128,.06)',`
    <table style="width:100%;border-collapse:collapse;margin-top:4px">
    ${th(['Table','Key Fields','Notes'])}
    <tbody>
    ${t([
      ['<strong>trips</strong>','id, startLoc, dest1/2/3, vehicleId, driverId, bookedBy, date, challan1/2/3','One row per trip booking'],
      ['<strong>segments</strong>','id, tripId, label (A/B/C), sLoc, dLoc, steps[1-5], currentStep, status','One row per segment; steps object tracks each step\'s done/time/by/photo'],
      ['<strong>locations</strong>','id, name, type (KAP/External), colour, kapSec, tripBook[], matRecv[], approvers[]','Role assignments per location'],
      ['<strong>vehicles</strong>','id, number, typeId, vendorId, pucExpiry, rtpExpiry, insExpiry','Linked to vendor and vehicle type'],
      ['<strong>tripRates</strong>','id, vTypeId, start, dest1/2/3, rate, validStart, validEnd, status','Route+type+period based rates'],
      ['<strong>users</strong>','id, name, fullName, roles[], plant, apps[]','Multi-role, single plant assignment'],
    ])}
    </tbody></table>
  `)}

  `;
}

async function _repairMarkEmptyExitDone(){
  var resEl=document.getElementById('repairEmptyExitResult');
  if(resEl){resEl.style.display='block';resEl.innerHTML='<span style="color:var(--accent)">Scanning…</span>';}
  var fixed=0,details=[];
  for(var i=0;i<DB.segments.length;i++){
    var seg=DB.segments[i];
    if(seg.status==='Locked') continue;
    var trip=byId(DB.trips,seg.tripId);
    if(!trip||trip.cancelled) continue;
    // Create step 5 if missing (old trips before step 5 feature)
    if(!seg.steps[5]){
      var isLastSeg=(seg.label==='A'&&!trip.dest2)||(seg.label==='B'&&!trip.dest3)||seg.label==='C';
      var dLoc=byId(DB.locations||[],seg.dLoc);
      var isKapDest=dLoc&&dLoc.type==='KAP';
      if(isLastSeg&&isKapDest){
        seg.steps[5]={skip:false,label:'Empty Vehicle Exit',role:'KAP Security',done:false,time:null,by:null,loc:seg.dLoc,ownerLoc:seg.dLoc};
      } else {
        continue;// Not eligible for step 5
      }
    }
    var s5=seg.steps[5];
    if(s5.skip||s5.done) continue;
    // Accept any segment where the vehicle has arrived (step 2 done or skipped, or step 1 done)
    var vehicleArrived=(seg.steps[2]&&(seg.steps[2].done||seg.steps[2].skip))||(seg.steps[1]&&seg.steps[1].done);
    if(!vehicleArrived) continue;
    // Mark step 5 as done without photo
    s5.done=true;
    s5.time=new Date().toISOString();
    s5.by=CU?CU.id:'';
    s5.remarks='Repair: marked exit without photo';
    // Also force-complete pending steps 3 & 4 if not done (repair action)
    if(seg.steps[3]&&!seg.steps[3].skip&&!seg.steps[3].done){
      seg.steps[3].done=true;seg.steps[3].time=new Date().toISOString();seg.steps[3].by=CU?CU.id:'';seg.steps[3].remarks='Repair: auto-completed';
    }
    if(seg.steps[4]&&!seg.steps[4].skip&&!seg.steps[4].done){
      seg.steps[4].done=true;seg.steps[4].time=new Date().toISOString();seg.steps[4].by=CU?CU.id:'';seg.steps[4].remarks='Repair: auto-completed';
    }
    seg.currentStep=nextStep(seg);
    seg.status='Completed';
    await _dbSave('segments',seg);
    // Complete trip if all segments done
    var tripSegs=DB.segments.filter(function(s){return s.tripId===seg.tripId;});
    if(tripSegs.every(function(s){return s.status==='Completed'||s.status==='Rejected';})){
      trip.completedAt=new Date().toISOString();
      await _dbSave('trips',trip);
    }
    fixed++;
    details.push({tripId:seg.tripId,segId:seg.id,vehicle:vnum(trip.vehicleId)});
  }
  if(!fixed){
    if(resEl) resEl.innerHTML='<span style="color:#16a34a;font-weight:700">✅ No trips waiting for empty exit.</span>';
  } else {
    var h='<div style="color:#16a34a;font-weight:700;margin-bottom:6px">✅ Marked empty exit on '+fixed+' segment(s)</div>';
    h+='<div style="max-height:150px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:6px;font-size:11px"><table style="width:100%;border-collapse:collapse"><thead><tr style="background:#fef2f2;position:sticky;top:0"><th style="padding:3px 8px;text-align:left">Trip</th><th style="padding:3px 8px;text-align:left">Segment</th><th style="padding:3px 8px;text-align:left">Vehicle</th></tr></thead><tbody>';
    details.forEach(function(d){
      h+='<tr style="border-bottom:1px solid #f1f5f9"><td style="padding:2px 8px;font-family:var(--mono);font-weight:700;color:var(--accent)">'+d.tripId+'</td><td style="padding:2px 8px;font-family:var(--mono)">'+d.segId+'</td><td style="padding:2px 8px;font-family:var(--mono)">'+d.vehicle+'</td></tr>';
    });
    h+='</tbody></table></div>';
    if(resEl) resEl.innerHTML=h;
    updBadges();renderKap();renderDash();renderMyTrips();
  }
}

async function _repairAutoExitSpotVehicles(){
  var resEl=document.getElementById('repairSpotExitResult');
  if(resEl){resEl.style.display='block';resEl.innerHTML='<span style="color:var(--accent)">Scanning…</span>';}
  var now=Date.now();
  var cutoff=48*3600*1000;// 48 hours
  var stale=(DB.spotTrips||[]).filter(function(s){
    if(s.exitTime) return false;
    var entryTs=s.entryTime?new Date(s.entryTime).getTime():(s.date?new Date(s.date+'T00:00:00').getTime():0);
    return entryTs>0&&(now-entryTs)>cutoff;
  });
  if(!stale.length){
    if(resEl) resEl.innerHTML='<span style="color:#16a34a;font-weight:700">✅ No stale spot vehicles found.</span>';
    return;
  }
  if(!confirm('Auto-exit '+stale.length+' spot vehicle(s) that have been inside for more than 48 hours?')) {
    if(resEl) resEl.innerHTML='<span style="color:var(--text3)">Cancelled.</span>';
    return;
  }
  var fixed=0,details=[];
  for(var i=0;i<stale.length;i++){
    var s=stale[i];
    var bak={exitTime:s.exitTime,exitBy:s.exitBy,exitRemarks:s.exitRemarks};
    s.exitTime=new Date().toISOString();
    s.exitBy=CU?CU.id:'';
    s.exitRemarks='Auto-exit: exceeded 48hrs without exit';
    if(await _dbSave('spotTrips',s)){
      fixed++;
      var hrs=Math.round((now-new Date(s.entryTime||s.date+'T00:00:00').getTime())/3600000);
      details.push({id:s.id||s.code,vehicle:s.vehicleNum,supplier:s.supplier||'—',hours:hrs});
    } else {
      Object.assign(s,bak);
    }
  }
  if(!fixed){
    if(resEl) resEl.innerHTML='<span style="color:#dc2626;font-weight:700">⚠ Failed to update any records.</span>';
  } else {
    var h='<div style="color:#16a34a;font-weight:700;margin-bottom:6px">✅ Auto-exited '+fixed+' spot vehicle(s)</div>';
    h+='<div style="max-height:150px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:6px;font-size:11px"><table style="width:100%;border-collapse:collapse"><thead><tr style="background:#fef3c7;position:sticky;top:0"><th style="padding:3px 8px;text-align:left">ID</th><th style="padding:3px 8px;text-align:left">Vehicle</th><th style="padding:3px 8px;text-align:left">Supplier</th><th style="padding:3px 8px;text-align:right">Hours Inside</th></tr></thead><tbody>';
    details.forEach(function(d){
      h+='<tr style="border-bottom:1px solid #f1f5f9"><td style="padding:2px 8px;font-family:var(--mono);font-weight:700;color:var(--accent)">'+d.id+'</td><td style="padding:2px 8px;font-family:var(--mono)">'+d.vehicle+'</td><td style="padding:2px 8px">'+d.supplier+'</td><td style="padding:2px 8px;font-family:var(--mono);text-align:right;font-weight:700;color:#dc2626">'+d.hours+'h</td></tr>';
    });
    h+='</tbody></table></div>';
    if(resEl) resEl.innerHTML=h;
    if(typeof renderSpotTab==='function') renderSpotTab();
    if(typeof renderSpotHistory==='function') renderSpotHistory();
    updBadges();renderDash();
  }
  renderHelper();// Refresh count
}

// Helper page: Trip Status Retriever function
function _helperLookupTrip(){
  const input=document.getElementById('helperTripIdInput');
  const result=document.getElementById('helperTripResult');
  if(!input||!result)return;
  const tripId=(input.value||'').trim().toUpperCase();
  if(!tripId){result.style.display='none';return;}
  
  const trip=DB.trips.find(t=>t.id.toUpperCase()===tripId);
  if(!trip){
    result.innerHTML=`<div style="padding:14px;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:8px;color:#dc2626;font-weight:700">❌ Trip ID "${tripId}" not found</div>`;
    result.style.display='block';
    return;
  }
  
  // Get trip details
  const segs=DB.segments.filter(s=>s.tripId===trip.id).sort((a,b)=>a.label.localeCompare(b.label));
  const vehicle=byId(DB.vehicles,trip.vehicleId);
  const driver=byId(DB.drivers,trip.driverId);
  const vendor=byId(DB.vendors,vehicle?.vendorId);
  const bookedBy=byId(DB.users,trip.bookedBy);
  const startLoc=byId(DB.locations,trip.startLoc);
  const dest1Loc=byId(DB.locations,trip.dest1);
  const dest2Loc=byId(DB.locations,trip.dest2);
  const dest3Loc=byId(DB.locations,trip.dest3);
  
  // Overall trip status
  const isCancelled=trip.cancelled;
  const allComplete=segs.length>0&&segs.every(s=>s.status==='Completed');
  const anyActive=segs.some(s=>s.status==='Active');
  let overallStatus='<span style="background:#fef9c3;color:#92400e;padding:2px 8px;border-radius:4px;font-weight:700">In Progress</span>';
  if(isCancelled) overallStatus='<span style="background:#fef2f2;color:#dc2626;padding:2px 8px;border-radius:4px;font-weight:700">Cancelled</span>';
  else if(allComplete) overallStatus='<span style="background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:4px;font-weight:700">Completed</span>';
  
  // Format date
  const tripDate=trip.date?new Date(trip.date).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):'—';
  
  // Build route display
  let routeParts=[startLoc?.name||'?'];
  if(dest1Loc) routeParts.push(dest1Loc.name);
  if(dest2Loc) routeParts.push(dest2Loc.name);
  if(dest3Loc) routeParts.push(dest3Loc.name);
  const routeHtml=routeParts.join(' <span style="color:var(--accent);font-weight:900">→</span> ');
  
  // Build segments status
  let segsHtml='';
  segs.forEach(seg=>{
    const sLoc=byId(DB.locations,seg.sLoc);
    const dLoc=byId(DB.locations,seg.dLoc);
    let segStatus='<span style="background:#e0f2fe;color:#0369a1;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700">Active</span>';
    if(seg.status==='Completed') segStatus='<span style="background:#dcfce7;color:#16a34a;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700">Completed</span>';
    else if(seg.status==='Locked') segStatus='<span style="background:#f1f5f9;color:#64748b;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700">Locked</span>';
    
    // Steps status
    let stepsHtml='<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">';
    const stepNames=['','Gate Exit','Gate Entry','Mat Receipt','Approval','Empty Exit'];
    for(let i=1;i<=5;i++){
      const step=seg.steps[i]||{};
      const isSkip=step.skip;
      const isDone=step.done;
      let stepCls='background:#f1f5f9;color:#94a3b8';
      let stepIcon='○';
      if(isSkip){stepCls='background:#f1f5f9;color:#cbd5e1;text-decoration:line-through';stepIcon='—';}
      else if(isDone){stepCls='background:#dcfce7;color:#16a34a';stepIcon='✓';}
      else if(seg.currentStep===i){stepCls='background:#fef9c3;color:#92400e';stepIcon='●';}
      const stepBy=isDone&&step.by?byId(DB.users,step.by)?.name||step.by:'';
      const stepTime=isDone&&step.time?new Date(step.time).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'';
      stepsHtml+=`<div style="padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;${stepCls};text-align:center;min-width:70px">
        <div>${stepIcon} ${stepNames[i]}</div>
        ${stepBy?`<div style="font-size:9px;font-weight:500;margin-top:2px">${stepBy}</div>`:''}
        ${stepTime?`<div style="font-size:9px;font-weight:400;opacity:.7">${stepTime}</div>`:''}
      </div>`;
    }
    stepsHtml+='</div>';
    
    segsHtml+=`<div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-weight:800;color:var(--accent)">Segment ${seg.label}</span>
        ${segStatus}
      </div>
      <div style="font-size:12px;color:var(--text2)">${sLoc?.name||'?'} → ${dLoc?.name||'?'}</div>
      ${stepsHtml}
    </div>`;
  });
  
  result.innerHTML=`
    <div style="background:#fff;border:1.5px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="background:linear-gradient(135deg,rgba(42,154,160,.1),rgba(34,197,94,.1));padding:14px 16px;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-family:var(--mono);font-size:22px;font-weight:900;color:var(--accent)">${trip.id}</div>
            <div style="font-size:12px;color:var(--text2);margin-top:2px">Booked: ${tripDate} by ${bookedBy?.fullName||bookedBy?.name||'—'}</div>
          </div>
          ${overallStatus}
        </div>
      </div>
      <div style="padding:14px 16px">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:14px">
          <div><div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:2px">Route</div><div style="font-size:13px;font-weight:600">${routeHtml}</div></div>
          <div><div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:2px">Vehicle</div><div style="font-size:13px;font-family:var(--mono);font-weight:700">${vehicle?.number||'—'}</div></div>
          <div><div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:2px">Driver</div><div style="font-size:13px">${driver?.name||'—'}</div></div>
          <div><div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:2px">Vendor</div><div style="font-size:13px">${vendor?.name||trip.vendor||'—'}</div></div>
        </div>
        <div style="font-size:12px;font-weight:800;color:var(--text);margin-bottom:8px;text-transform:uppercase">Segments (${segs.length})</div>
        ${segsHtml||'<div style="color:var(--text3);font-size:12px">No segments found</div>'}
      </div>
    </div>
  `;
  result.style.display='block';
}

// ═══ BOOT TRIGGER ═══════════════════════════════════════════════════════
if(!_commonMissing){
  document.addEventListener('DOMContentLoaded', ()=>_appBoot().catch(e=>{console.error('Boot failed:',e);}));
}
