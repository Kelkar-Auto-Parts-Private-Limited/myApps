if(typeof _COMMON_LOADED==='undefined'){
  document.addEventListener('DOMContentLoaded',function(){
    var lp=document.getElementById('loginPage');if(lp)lp.style.display='flex';
    var ov=document.getElementById('loginConnLabel');if(ov){ov.textContent='⚠ Common.js not found';ov.style.color='#dc2626';}
  });
}

// ── All portal code (global scope — no block wrappers) ──────────────────────

// Photo-excluded sync selects for boot (same tables as VMS+HWMS apps)
var _SYNC_SELECT={
  'vms_trips':'id,code,booked_by,plant,date,start_loc,dest1,dest2,dest3,driver_id,vehicle_id,vehicle_type_id,actual_vehicle_type_id,vendor,description,trip_cat_id,challans1,challan1,weight1,challans2,challan2,weight2,challans3,challan3,weight3,edited_by,edited_at,cancelled,updated_at',
  'vms_spot_trips':'id,code,vehicle_num,supplier,challan,driver_name,driver_mobile,entry_remarks,date,entry_time,entry_by,location,exit_time,exit_by,exit_remarks,updated_at',
  'hwms_parts':'id,code,part_number,part_revision,description,status,net_weight_kg,uom,hsn_code,packing_type,packing_dimensions,qty_per_package,packing_weight,ex_works_rate,freight,warehouse_cost,icc_cost,final_rate,rate_valid_from,rate_valid_to,rates,updated_at',
  'hwms_containers':'id,code,container_number,container_serial_number,expected_pickup_date,pickup_date,status,reach_date,expected_reach_date,reached_date,carrier_id,carrier_name,carrier_inv_number,carrier_inv_date,carrier_inv_amount,entry_summary_number,es_date,es_amount,tariff_paid,tariff_percent,confirmed,updated_at'
};
function _syncSelect(sbTbl){return _SYNC_SELECT[sbTbl]||'*';}

// ── Date filtering ──
var _DATE_FILTER_DAYS=60;
var _DATE_FILTER_COL={
  'vms_trips':'date','vms_segments':'date','vms_spot_trips':'date'
};
function _dateCutoff(days){var d=new Date();d.setDate(d.getDate()-(days||_DATE_FILTER_DAYS));return d.toISOString().slice(0,10);}
function _applyDateFilter(q,sbTbl,cutoff){var col=_DATE_FILTER_COL[sbTbl];if(!col)return q;return q.gte(col,cutoff||_dateCutoff());}

// Override bootDB to exclude photos + date filter on initial load
var _origBootDB=typeof bootDB==='function'?bootDB:null;
bootDB=async function(){
  if(!_origBootDB) return;
  if(!_sb||!_sbReady){ return _origBootDB(); }
  try{
    showSpinner('Loading…');
    var _sm=document.getElementById('splashMsg');if(_sm)_sm.textContent='Connecting to database…';
    var activeTables=_getActiveTables();
    var cutoff=_dateCutoff();
    var timeout=new Promise(function(_,rej){setTimeout(function(){rej(new Error('Boot timeout (8s)'));},8000);});
    var fetchAll=Promise.all(activeTables.map(async function(tbl){
      var sbTbl=SB_TABLES[tbl];if(!sbTbl) return {tbl:tbl,rows:[]};
      try{
        var sel=_syncSelect(sbTbl);
        var q=_sb.from(sbTbl).select(sel);
        q=_applyDateFilter(q,sbTbl,cutoff);
        var res=await q;
        if(res.error){console.warn('bootDB: '+tbl+' error:',res.error.message);return{tbl:tbl,rows:[]};}
        return{tbl:tbl,rows:res.data||[]};
      }catch(e){console.warn('bootDB: '+tbl+' exception:',e.message);return{tbl:tbl,rows:[]};}
    }));
    var results=await Promise.race([fetchAll,timeout]);
    results.forEach(function(r){
      DB[r.tbl]=(r.rows||[]).map(function(row){return _fromRow(r.tbl,row);}).filter(Boolean);
    });
    console.log('bootDB: ready (photo-excluded, '+_DATE_FILTER_DAYS+'d) — users='+((DB.users||[]).length));
    _bgSyncDone=true;
    _sbSetStatus('ok');
    if(typeof _migrateStep3Skip==='function') _migrateStep3Skip();
    _onPostBoot();
    _sbStartRealtime();
  }catch(e){
    console.warn('Photo-excluded bootDB failed:',e.message,'→ falling back to original');
    return _origBootDB();
  }finally{hideSpinner();}
};

// Override _navigateTo to cache ALL tables (not just portal's 2 tables)
var _origNavigateTo=_navigateTo;
_navigateTo=function(url){
  try{
    if(typeof DB!=='undefined'&&typeof DB_TABLES!=='undefined'&&DB.users&&DB.users.length){
      var cache={ts:Date.now()};
      DB_TABLES.forEach(function(t){cache[t]=DB[t]||[];});
      localStorage.setItem('kap_db_cache',JSON.stringify(cache));
    }
  }catch(e){}
  // Navigate with overlay (skip the cache write in original since we did it)
  var ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;background:#f8fafc;z-index:999999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px';
  ov.innerHTML='<div style="width:40px;height:40px;border:4px solid rgba(42,154,160,.2);border-top-color:#2a9aa0;border-radius:50%;animation:spin .7s linear infinite"></div><div style="color:#64748b;font-size:13px;font-weight:600">Loading…</div>';
  document.body.appendChild(ov);
  setTimeout(function(){window.location.href=url;},50);
};
function togglePassVis(){
  const el=document.getElementById('loginPass');
  const btn=document.getElementById('passToggle');
  if(el.type==='password'){el.type='text';btn.textContent='🙈';}
  else{el.type='password';btn.textContent='👁';}
}
function resetToSeed(){
  showConfirm('This will erase ALL data (localStorage + Supabase) and restore factory defaults. Continue?', ()=>{
    try{
      DB_TABLES.forEach(tbl=>localStorage.removeItem(LS_PREFIX+tbl));
      ['kap_db_local','kap_rm_user','kap_rm_pass'].forEach(k=>localStorage.removeItem(k));
      sessionStorage.clear();
    }catch(e){}
    if(_sbReady && _sb){
      (async()=>{
        try{
          for(const tbl of DB_TABLES){
            await _sb.from(SB_TABLES[tbl]).delete().neq('code','__never__');
          }
        }catch(e){ console.warn('SB clear error:',e.message); }
        location.reload();
      })();
    } else {
      location.reload();
    }
  });
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

// Init captcha on page load and pre-fill remember-me credentials if saved
var _rememberedLogin=false; // true when credentials restored from saved device
function _onManualInput(){
  // User is manually editing credentials — re-show CAPTCHA and require it
  if(_rememberedLogin){
    _rememberedLogin=false;
    var cw=document.getElementById('captchaWrap');
    if(cw) cw.style.display='';
    _refreshCaptcha();
  }
}
document.addEventListener('DOMContentLoaded', function(){
  _refreshCaptcha();
  try{
    var su=localStorage.getItem('kap_rm_user');
    var sp=localStorage.getItem('kap_rm_pass');
    if(su && sp){
      var uEl=document.getElementById('loginUser');
      var pEl=document.getElementById('loginPass');
      var rmEl=document.getElementById('rememberMe');
      if(uEl) uEl.value=su;
      if(pEl) pEl.value=sp;
      if(rmEl) rmEl.checked=true;
      _rememberedLogin=true;
      var cw=document.getElementById('captchaWrap');
      if(cw) cw.style.display='none';
    }
  }catch(e){}
});

var _portalRetryTimer=null, _portalRetryBusy=false;
var _portalLoggedIn=false; // flag to skip login UI updates while logged in
var _portalEverHadUsers=false; // once true, never disable login form again
function _portalUpdateLoginBtn(){
  if(_portalLoggedIn) return; // skip while user is logged in
  var btn=document.getElementById('loginBtn');
  var spinner=document.getElementById('loginSpinner');
  var dot=document.getElementById('loginConnDot');
  var label=document.getElementById('loginConnLabel');
  var status=document.getElementById('loginConnStatus');
  var hasUsers=!!(DB.users&&DB.users.length>0);
  if(hasUsers) _portalEverHadUsers=true;
  // Once we've ever loaded users, never go back to "loading" state
  var loading=_portalEverHadUsers?false:!hasUsers;
  // Sign In button
  if(btn){ 
    if(loading){btn.disabled=true;btn.style.opacity='0.5';btn.style.cursor='not-allowed';}
    else{btn.removeAttribute('disabled');btn.disabled=false;btn.style.opacity='1';btn.style.cursor='pointer';}
  }
  // Disable ALL form inputs while DB is loading — prevents user confusion
  ['loginUser','loginPass','captchaAns','rememberMe'].forEach(function(id){
    var el=document.getElementById(id);
    if(el){ el.disabled=loading; el.style.opacity=loading?'0.5':'1'; }
  });
  // Captcha refresh button (only if captcha is visible)
  var captchaBtn=document.querySelector('#captchaWrap button');
  var captchaVisible=document.getElementById('captchaWrap')?.style.display!=='none';
  if(captchaBtn&&captchaVisible){ captchaBtn.disabled=loading; captchaBtn.style.opacity=loading?'0.4':'1'; }
  // Spinner / connected dot
  if(spinner) spinner.style.display=loading?'block':'none';
  if(dot) dot.style.display=loading?'none':'inline-block';
  if(label) label.textContent=loading?'Connecting to database…':'Connected — '+DB.users.length+' users loaded';
  if(label) label.style.color=loading?'#475569':'#15803d';
  if(status){ status.style.background=loading?'#f8fafc':'rgba(34,197,94,.06)'; status.style.borderColor=loading?'#e2e8f0':'rgba(34,197,94,.25)'; }
}
function doLogin(){
  try{
  console.log('[doLogin] START');
  // Always require DB.users to be populated before allowing login.
  if(!DB.users||!DB.users.length){
    document.getElementById('loginError').style.display='block';
    document.getElementById('loginError').textContent='Database not ready yet. Please wait a moment…';
    return;
  }
  if(_portalRetryTimer){clearInterval(_portalRetryTimer);_portalRetryTimer=null;}
  // Check lockout
  if(_isLockedOut()){
    document.getElementById('loginError').style.display='block';
    document.getElementById('loginError').textContent='Account locked. Please wait for the timer to expire.';
    return;
  }
  const u=document.getElementById('loginUser').value.toLowerCase().trim();
  const p=document.getElementById('loginPass').value;
  // Skip CAPTCHA for remembered devices — they pre-filled from localStorage.
  if(!_rememberedLogin){
    const userAns=parseInt(document.getElementById('captchaAns').value,10);
    if(isNaN(userAns)||userAns!==_captchaAnswer){
      document.getElementById('captchaErr').style.display='block';
      document.getElementById('captchaAns').classList.add('input-error');
      _refreshCaptcha();
      return;
    }
    document.getElementById('captchaErr').style.display='none';
    document.getElementById('captchaAns').classList.remove('input-error');
  }
  const user=DB.users.find(x=>x&&x.name.toLowerCase()===u&&x.password===p);
  if(!user){
    console.warn('[doLogin] no match — DB has',DB.users?.length,'users');
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
  if(user.inactive===true){
    document.getElementById('loginError').style.display='block';
    document.getElementById('loginError').textContent='This account has been deactivated. Contact your Admin.';
    _refreshCaptcha();
    return;
  }
  // Success — reset fail count
  _loginFailCount=0;
  CU=user; _enrichCU();
  // Mark as logged in — stops _portalUpdateLoginBtn from updating login UI
  _portalLoggedIn=true;
  // Always store in sessionStorage so refresh within this tab keeps user logged in
  _sessionSet('kap_session_user',u);
  _sessionSet('kap_session_pass',p);
  // Cache the full user object — Portal uses this to restore session even when
  // Supabase is slow/unavailable and DB.users hasn't loaded yet after navigation.
  try{ localStorage.setItem('kap_current_user', JSON.stringify(user)); }catch(e){}
  // Persist to localStorage ONLY if "Remember me" is checked
  var rememberChecked=document.getElementById('rememberMe')?.checked;
  try{
    if(rememberChecked){
      localStorage.setItem('kap_rm_user', u);
      localStorage.setItem('kap_rm_pass', p);
    } else {
      // Clear any previously saved credentials when user logs in without remembering
      localStorage.removeItem('kap_rm_user');
      localStorage.removeItem('kap_rm_pass');
    }
  }catch(e){}
  document.getElementById('loginError').style.display='none';
  // Check password strength — force change before showing portal
  // NOTE: Do NOT hide loginPage here — showPortal() does it.
  // If force password modal opens, it overlays the login page (z-index 100010).
  var _RESET_PWD_PORTAL='Kappl@123';
  if(!_isStrongPwd(p)||p===_RESET_PWD_PORTAL){
    _openForcePassModal();
    return;
  }
  showPortal();
  }catch(e){
    console.error('[doLogin] error:',e);
    var errEl=document.getElementById('loginError');
    if(errEl){errEl.style.display='block';errEl.textContent='Login error: '+e.message;}
  }
}

const _LOGO="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxMiIgZmlsbD0iIzJhOWFhMCIvPjx0ZXh0IHg9IjMyIiB5PSI0MyIgZm9udC1mYW1pbHk9IkFyaWFsLHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjQiIGZvbnQtd2VpZ2h0PSI5MDAiIGZpbGw9IndoaXRlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBsZXR0ZXItc3BhY2luZz0iLTAuNSI+S0FQPC90ZXh0Pjwvc3ZnPg==";
const APP_FILES={vms:'VMS.html',hwms:'HWMS.html',security:'Security.html',maintenance:null,review:null,hrms:null};
const APP_ACTIVE={vms:true,hwms:true,security:true,maintenance:false,review:false,hrms:false};

// ── Portal ──────────────────────────────────────────────────────────────────
function showPortal(){
  document.getElementById('loginPage').style.display='none';
  document.getElementById('portalPage').style.display='block';
  // Pre-fetch ALL tables in background so app opens instantly
  _portalPreFetchAll();
  // Retry pre-fetch after 2s if Supabase wasn't ready
  if(!_portalPreFetchDone){
    setTimeout(function(){if(!_portalPreFetchDone) _portalPreFetchAll();},2000);
  }
  // Topbar user info
  var initials=(CU.fullName||CU.name||'?').trim().split(/\s+/).map(function(w){return w[0]||'';}).slice(0,2).join('').toUpperCase()||'?';
  var av=document.getElementById('portalAvatar');
  if(av){if(CU.photo){av.innerHTML='<img src="'+CU.photo+'" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';}else{av.textContent=initials;}}
  var un=document.getElementById('portalUserName'); if(un) un.textContent=CU.fullName||CU.name;
  var ur=document.getElementById('portalUserRole'); if(ur) ur.textContent=(CU.roles||[]).join(', ');
  var wm=document.getElementById('welcomeMsg'); if(wm) wm.textContent='Welcome, '+(CU.fullName||CU.name);
  // Sidebar user info
  var sa=document.getElementById('pSideAvatar');
  if(sa){if(CU.photo){sa.innerHTML='<img src="'+CU.photo+'" style="width:100%;height:100%;object-fit:cover;border-radius:10px">';}else{sa.textContent=initials;}}
  var sn=document.getElementById('pSideName');if(sn)sn.textContent=CU.fullName||CU.name;
  var sr=document.getElementById('pSideRole');if(sr)sr.textContent=(CU.roles||[]).join(', ');
  // Show Users tab for Admin/SA
  var isAdmin=(CU.roles||[]).some(function(r){return r==='Super Admin'||r==='Admin';});
  var ut=document.getElementById('usersTab'); if(ut) ut.style.display=isAdmin?'':'none';
  var psU=document.getElementById('psNavUsers');if(psU)psU.style.display=isAdmin?'':'none';
  var psDb=document.getElementById('psNavDbstorage');if(psDb)psDb.style.display=(isAdmin||(CU.hwmsRoles||[]).some(function(r){return r==='HWMS Admin';}))?'':'none';
  // Sidebar user count
  var uc=document.getElementById('pSideUserCount');if(uc)uc.textContent=(DB.users||[]).length;
  renderAppGrid();
  // Hook: refresh views when bgSync updates data
  _onRefreshViews = function(){
    try{
      if(document.getElementById('appsSection')?.style.display!=='none') renderAppGrid();
      if(document.getElementById('usersSection')?.style.display!=='none') renderPortalUsers();
      var uc=document.getElementById('pSideUserCount');if(uc)uc.textContent=(DB.users||[]).length;
    }catch(e){}
  };
}
function showTab(tab){
  document.querySelectorAll('.portal-tab').forEach(t=>t.classList.remove('active'));
  var ptab=document.querySelector(`.portal-tab[onclick*="${tab}"]`);if(ptab)ptab.classList.add('active');
  document.getElementById('appsSection').style.display=tab==='apps'?'block':'none';
  document.getElementById('usersSection').style.display=tab==='users'?'block':'none';
  document.getElementById('profileSection').style.display=tab==='profile'?'block':'none';
  document.getElementById('dbStorageSection').style.display=tab==='dbstorage'?'block':'none';
  // Sidebar nav highlighting
  document.querySelectorAll('.ps-nav').forEach(n=>n.classList.remove('active'));
  var sn=document.getElementById('psNav'+tab.charAt(0).toUpperCase()+tab.slice(1));
  if(sn) sn.classList.add('active');
  if(tab==='apps') renderAppGrid();
  if(tab==='users') renderPortalUsers();
  if(tab==='profile') ppLoadProfile();
  if(tab==='dbstorage') renderPortalDbStorage();
}

// ── Background pre-fetch ALL tables so app opens fast ───────────────────────
var _portalPreFetchDone=false;
function _portalPreFetchAll(){
  if(_portalPreFetchDone||!_sbReady||!_sb) return;
  console.log('[portal] pre-fetching all tables in background…');
  var cutoff=_dateCutoff();
  Promise.all(DB_TABLES.map(function(tbl){
    if(!SB_TABLES[tbl]) return Promise.resolve(null);
    var sel=_syncSelect(SB_TABLES[tbl]);
    var q=_sb.from(SB_TABLES[tbl]).select(sel);
    q=_applyDateFilter(q,SB_TABLES[tbl],cutoff);
    return q.then(function(res){
      if(res.error) return null;
      return {tbl:tbl, rows:res.data||[]};
    }).catch(function(){return null;});
  })).then(function(results){
    (results||[]).filter(Boolean).forEach(function(r){
      DB[r.tbl]=r.rows.map(function(row){return _fromRow(r.tbl,row);}).filter(Boolean);
    });
    _portalPreFetchDone=true;
    console.log('[portal] pre-fetch done — '+DB_TABLES.map(function(t){return t+'='+((DB[t]||[]).length);}).join(', '));
  }).catch(function(e){console.warn('[portal] pre-fetch error:',e.message);});
}

// ── DB Storage Analysis (all apps) ─────────────────────────────────────────
var _portalSyncProbe={vms:'unknown',hwms:'unknown',vmsFull:'unknown',hwmsFull:'unknown',done:false};
async function _portalProbeSyncModes(){
  if(_portalSyncProbe.done||!_sbReady||!_sb) return;
  _portalSyncProbe.done=true;
  // Probe VMS hot: vms_trips
  try{var r1=await _sb.from('vms_trips').select('updated_at').limit(1);_portalSyncProbe.vms=r1.error?'full':'incremental';}catch(e){_portalSyncProbe.vms='full';}
  // Probe HWMS hot: hwms_containers
  try{var r2=await _sb.from('hwms_containers').select('updated_at').limit(1);_portalSyncProbe.hwms=r2.error?'full':'incremental';}catch(e){_portalSyncProbe.hwms='full';}
  // Probe VMS all-tables: vms_users (master table)
  try{var r3=await _sb.from('vms_users').select('updated_at').limit(1);_portalSyncProbe.vmsFull=r3.error?'full':'incremental';}catch(e){_portalSyncProbe.vmsFull='full';}
  // Probe HWMS all-tables: hwms_hsn (master table)
  try{var r4=await _sb.from('hwms_hsn').select('updated_at').limit(1);_portalSyncProbe.hwmsFull=r4.error?'full':'incremental';}catch(e){_portalSyncProbe.hwmsFull='full';}
  console.log('[portal] Sync probe: VMS hot='+_portalSyncProbe.vms+' full='+_portalSyncProbe.vmsFull+', HWMS hot='+_portalSyncProbe.hwms+' full='+_portalSyncProbe.hwmsFull);
}

function renderPortalDbStorage(){
  var body=document.getElementById('portalDbStorageBody');if(!body)return;
  if(!_sbReady||!_sb){
    body.innerHTML='<div style="text-align:center;padding:20px;color:#dc2626">⚠ No database connection</div>';
    return;
  }
  body.innerHTML='<div style="text-align:center;padding:30px;color:#64748b"><div style="font-size:24px;margin-bottom:8px">⏳</div><div style="font-weight:700">Fetching data from all tables…</div><div style="font-size:11px;margin-top:4px;color:#94a3b8">This may take a few seconds on first load</div></div>';
  // Probe sync modes first, then fetch all data
  _portalProbeSyncModes().then(function(){
    return Promise.all((typeof DB_TABLES!=='undefined'?DB_TABLES:[]).map(function(tbl){
      if(!SB_TABLES[tbl]) return Promise.resolve(null);
      return _sb.from(SB_TABLES[tbl]).select('*').then(function(res){
        if(res.error) return null;
        return {tbl:tbl,rows:res.data||[]};
      }).catch(function(){return null;});
    }));
  }).then(function(results){
    (results||[]).filter(Boolean).forEach(function(r){
      DB[r.tbl]=r.rows.map(function(row){return _fromRow(r.tbl,row);}).filter(Boolean);
    });
    _portalPreFetchDone=true;
    _renderDbStorageAnalysis(body);
  }).catch(function(e){
    body.innerHTML='<div style="text-align:center;padding:20px;color:#dc2626">Error fetching data: '+e.message+'</div>';
  });
}
function _renderDbStorageAnalysis(body){
  body.innerHTML='<div style="text-align:center;padding:20px;color:#94a3b8">Analyzing database storage…</div>';
  setTimeout(function(){
    var tables=typeof DB_TABLES!=='undefined'?DB_TABLES:[];
    if(!tables.length){body.innerHTML='<div style="text-align:center;padding:20px;color:#94a3b8">No tables found</div>';return;}
    // Group tables by app
    var appGroups={
      'VMS':['users','vehicleTypes','vendors','drivers','vehicles','locations','tripRates','trips','segments','spotTrips'],
      'Security':['checkpoints','guards','roundSchedules'],
      'HWMS':['hwmsParts','hwmsInvoices','hwmsContainers','hwmsHsn','hwmsUom','hwmsPacking','hwmsCustomers','hwmsPortDischarge','hwmsPortLoading','hwmsCarriers','hwmsCompany','hwmsSteelRates','hwmsSubInvoices','hwmsMaterialRequests']
    };
    var results=[];
    var grandTotal=0,grandImg=0,grandJson=0,grandRecords=0;
    tables.forEach(function(tbl){
      var arr=DB[tbl]||[];
      var totalBytes=0,imgBytes=0,imgCount=0;
      var fieldBreakdown={};
      // Recursively find base64 images in any value (string, array, nested object)
      function _scanImages(val){
        var found={bytes:0,count:0};
        if(typeof val==='string'){
          if(val.startsWith('data:image/')){found.bytes=val.length*2;found.count=1;}
        } else if(Array.isArray(val)){
          val.forEach(function(item){var r=_scanImages(item);found.bytes+=r.bytes;found.count+=r.count;});
        } else if(val&&typeof val==='object'){
          for(var k in val){if(val.hasOwnProperty(k)){var r=_scanImages(val[k]);found.bytes+=r.bytes;found.count+=r.count;}}
        }
        return found;
      }
      arr.forEach(function(rec){
        var recStr=JSON.stringify(rec);
        var recBytes=recStr.length*2;
        totalBytes+=recBytes;
        for(var key in rec){
          if(!rec.hasOwnProperty(key)) continue;
          var val=rec[key];
          var valStr=typeof val==='string'?val:JSON.stringify(val||'');
          var valBytes=valStr.length*2;
          if(!fieldBreakdown[key]) fieldBreakdown[key]={bytes:0,imgBytes:0,imgCount:0,isArray:false,isObject:false};
          fieldBreakdown[key].bytes+=valBytes;
          if(Array.isArray(val)) fieldBreakdown[key].isArray=true;
          else if(val&&typeof val==='object') fieldBreakdown[key].isObject=true;
          // Deep scan for images
          var scan=_scanImages(val);
          if(scan.count>0){
            fieldBreakdown[key].imgBytes+=scan.bytes;
            fieldBreakdown[key].imgCount+=scan.count;
            imgBytes+=scan.bytes;imgCount+=scan.count;
          }
        }
      });
      var tableImgBytes=0;
      for(var fk in fieldBreakdown) tableImgBytes+=fieldBreakdown[fk].imgBytes;
      var jsonBytes=Math.max(0,totalBytes-tableImgBytes);
      // Determine app
      var app='Other';
      for(var appName in appGroups){if(appGroups[appName].indexOf(tbl)>=0){app=appName;break;}}
      results.push({tbl:tbl,app:app,records:arr.length,totalBytes:totalBytes,imgBytes:tableImgBytes,jsonBytes:jsonBytes,imgCount:imgCount,fields:fieldBreakdown});
      grandTotal+=totalBytes;grandImg+=tableImgBytes;grandJson+=jsonBytes;grandRecords+=arr.length;
    });
    results.sort(function(a,b){return b.totalBytes-a.totalBytes;});
    var fmt=function(b){if(b>=1048576)return(b/1048576).toFixed(2)+' MB';if(b>=1024)return(b/1024).toFixed(1)+' KB';return b+' B';};
    var pct=function(part,whole){return whole>0?Math.round(part/whole*100):0;};
    var barColor=function(p){return p>60?'#dc2626':p>30?'#f59e0b':'#16a34a';};
    var appColor={'VMS':'#2563eb','HWMS':'#7c3aed','Security':'#ea580c','Other':'#64748b'};
    var appBg={'VMS':'#eff6ff','HWMS':'#faf5ff','Security':'#fff7ed','Other':'#f8fafc'};
    // Per-app totals
    var appTotals={};
    results.forEach(function(r){
      if(!appTotals[r.app]) appTotals[r.app]={total:0,img:0,json:0,records:0,count:0};
      appTotals[r.app].total+=r.totalBytes;appTotals[r.app].img+=r.imgBytes;appTotals[r.app].json+=r.jsonBytes;appTotals[r.app].records+=r.records;appTotals[r.app].count++;
    });
    // Summary cards
    var html='<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">';
    html+='<div style="background:#f0f9ff;border:1.5px solid #bae6fd;border-radius:10px;padding:12px 16px;text-align:center"><div style="font-size:22px;font-weight:900;color:#0369a1;font-family:monospace">'+fmt(grandTotal)+'</div><div style="font-size:10px;font-weight:700;color:#0c4a6e;text-transform:uppercase">Total In-Memory</div></div>';
    html+='<div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:10px;padding:12px 16px;text-align:center"><div style="font-size:22px;font-weight:900;color:#dc2626;font-family:monospace">'+fmt(grandImg)+'</div><div style="font-size:10px;font-weight:700;color:#991b1b;text-transform:uppercase">Images ('+pct(grandImg,grandTotal)+'%)</div></div>';
    html+='<div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:10px;padding:12px 16px;text-align:center"><div style="font-size:22px;font-weight:900;color:#16a34a;font-family:monospace">'+fmt(grandJson)+'</div><div style="font-size:10px;font-weight:700;color:#166534;text-transform:uppercase">JSON Data ('+pct(grandJson,grandTotal)+'%)</div></div>';
    html+='<div style="background:#faf5ff;border:1.5px solid #d8b4fe;border-radius:10px;padding:12px 16px;text-align:center"><div style="font-size:22px;font-weight:900;color:#7c3aed;font-family:monospace">'+grandRecords+'</div><div style="font-size:10px;font-weight:700;color:#5b21b6;text-transform:uppercase">Total Records</div></div>';
    html+='</div>';
    // Per-app summary
    html+='<div style="display:grid;grid-template-columns:repeat('+Object.keys(appTotals).length+',1fr);gap:10px;margin-bottom:16px">';
    for(var appK in appTotals){
      var at=appTotals[appK];
      var ac=appColor[appK]||'#64748b',ab=appBg[appK]||'#f8fafc';
      html+='<div style="background:'+ab+';border:1.5px solid '+ac+'33;border-radius:10px;padding:10px 14px">';
      html+='<div style="font-size:13px;font-weight:800;color:'+ac+';margin-bottom:6px">'+appK+' <span style="font-size:10px;color:#64748b;font-weight:600">('+at.count+' tables)</span></div>';
      html+='<div style="display:flex;gap:12px;font-size:11px">';
      html+='<div><div style="font-weight:900;font-family:monospace;color:'+ac+'">'+fmt(at.total)+'</div><div style="font-size:9px;color:#64748b">Total</div></div>';
      html+='<div><div style="font-weight:900;font-family:monospace;color:#dc2626">'+fmt(at.img)+'</div><div style="font-size:9px;color:#64748b">Images</div></div>';
      html+='<div><div style="font-weight:900;font-family:monospace;color:#16a34a">'+fmt(at.json)+'</div><div style="font-size:9px;color:#64748b">Data</div></div>';
      html+='<div><div style="font-weight:900;font-family:monospace">'+at.records+'</div><div style="font-size:9px;color:#64748b">Records</div></div>';
      html+='</div></div>';
    }
    html+='</div>';
    // Table breakdown
    html+='<div style="border:1.5px solid #e2e8f0;border-radius:8px;overflow:hidden">';
    html+='<table style="width:100%;font-size:12px;border-collapse:collapse">';
    html+='<thead><tr style="background:#f8fafc">';
    html+='<th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800">Table</th>';
    html+='<th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800">App</th>';
    html+='<th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800">Records</th>';
    html+='<th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800">Total Size</th>';
    html+='<th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800">Images</th>';
    html+='<th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800">Img #</th>';
    html+='<th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800">JSON Data</th>';
    html+='<th style="padding:8px 10px;font-size:10px;font-weight:800;min-width:120px">Image %</th>';
    html+='</tr></thead><tbody>';
    results.forEach(function(r,i){
      var ip=pct(r.imgBytes,r.totalBytes);
      var bc=barColor(ip);
      var ac2=appColor[r.app]||'#64748b';
      html+='<tr style="border-top:1px solid #e2e8f0;'+(i%2?'background:#fafafa;':'')+'cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'table-row\':\'none\'">';
      html+='<td style="padding:6px 10px;font-weight:700;color:#2a9aa0">'+r.tbl+' <span style="font-size:9px;color:#94a3b8">▼</span></td>';
      html+='<td style="padding:6px 10px"><span style="font-size:10px;font-weight:700;color:'+ac2+';background:'+ac2+'15;padding:2px 8px;border-radius:4px">'+r.app+'</span></td>';
      html+='<td style="padding:6px 10px;text-align:right;font-family:monospace;font-weight:700">'+r.records+'</td>';
      html+='<td style="padding:6px 10px;text-align:right;font-family:monospace;font-weight:700">'+fmt(r.totalBytes)+'</td>';
      html+='<td style="padding:6px 10px;text-align:right;font-family:monospace;font-weight:700;color:'+(r.imgBytes>0?'#dc2626':'#94a3b8')+'">'+fmt(r.imgBytes)+'</td>';
      html+='<td style="padding:6px 10px;text-align:right;font-family:monospace">'+r.imgCount+'</td>';
      html+='<td style="padding:6px 10px;text-align:right;font-family:monospace">'+fmt(r.jsonBytes)+'</td>';
      html+='<td style="padding:6px 10px"><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden"><div style="height:100%;width:'+ip+'%;background:'+bc+';border-radius:4px"></div></div><span style="font-size:10px;font-weight:700;color:'+bc+';min-width:28px;text-align:right">'+ip+'%</span></div></td>';
      html+='</tr>';
      // Expandable field breakdown
      html+='<tr style="display:none"><td colspan="8" style="padding:0"><div style="padding:8px 20px 10px;background:rgba(42,154,160,.04);border-top:1px dashed #e2e8f0">';
      html+='<div style="font-size:10px;font-weight:800;color:#475569;margin-bottom:4px">FIELD BREAKDOWN</div>';
      html+='<table style="width:100%;font-size:11px;border-collapse:collapse">';
      html+='<tr style="color:#94a3b8"><th style="text-align:left;padding:2px 6px;font-size:9px">Field</th><th style="text-align:right;padding:2px 6px;font-size:9px">Size</th><th style="text-align:right;padding:2px 6px;font-size:9px">Images</th><th style="text-align:right;padding:2px 6px;font-size:9px">Img Size</th></tr>';
      var fields=Object.entries(r.fields).sort(function(a,b){return b[1].bytes-a[1].bytes;});
      fields.forEach(function(f){
        var fk=f[0],fv=f[1];
        if(fk==='_dbId'||fk==='id') return;
        var hasImg=fv.imgBytes>0;
        html+='<tr style="border-top:1px solid rgba(0,0,0,.05)">';
        html+='<td style="padding:2px 6px;font-family:monospace;font-weight:600;color:'+(hasImg?'#dc2626':'#1e293b')+'">'+fk+(fv.isArray?' []':fv.isObject?' {}':'')+'</td>';
        html+='<td style="padding:2px 6px;text-align:right;font-family:monospace">'+fmt(fv.bytes)+'</td>';
        html+='<td style="padding:2px 6px;text-align:right;font-family:monospace;color:'+(hasImg?'#dc2626':'#94a3b8')+'">'+fv.imgCount+'</td>';
        html+='<td style="padding:2px 6px;text-align:right;font-family:monospace;color:'+(hasImg?'#dc2626':'#94a3b8')+'">'+fmt(fv.imgBytes)+'</td>';
        html+='</tr>';
      });
      html+='</table></div></td></tr>';
    });
    // Grand total
    html+='<tr style="border-top:3px solid #2a9aa0;background:#f0f9ff">';
    html+='<td style="padding:8px 10px;font-weight:900;font-size:13px" colspan="2">TOTAL ('+tables.length+' tables)</td>';
    html+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:900;font-size:13px">'+grandRecords+'</td>';
    html+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:900;font-size:13px;color:#0369a1">'+fmt(grandTotal)+'</td>';
    html+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:900;font-size:13px;color:#dc2626">'+fmt(grandImg)+'</td>';
    html+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:900"></td>';
    html+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:900;font-size:13px;color:#16a34a">'+fmt(grandJson)+'</td>';
    html+='<td style="padding:8px 10px"><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:10px;background:#e2e8f0;border-radius:5px;overflow:hidden"><div style="height:100%;width:'+pct(grandImg,grandTotal)+'%;background:#dc2626;border-radius:5px"></div></div><span style="font-size:11px;font-weight:900;color:#dc2626;min-width:32px;text-align:right">'+pct(grandImg,grandTotal)+'%</span></div></td>';
    html+='</tr>';
    html+='</tbody></table></div>';

    // ── Estimated Egress Calculator ──────────────────────────────────────
    // Calculate based on actual data sizes + known sync patterns
    var hotTblsVMS=['trips','segments','spotTrips'];
    var hotTblsHWMS=['hwmsContainers','hwmsInvoices','hwmsSubInvoices','hwmsMaterialRequests','hwmsParts'];
    var allTbls=tables;
    // Size of hot tables
    var hotSizeVMS=0,hotSizeHWMS=0,allSize=grandTotal/2; // /2 because we measured UTF-16 but network is UTF-8
    results.forEach(function(r){
      var netBytes=r.totalBytes/2;
      if(hotTblsVMS.indexOf(r.tbl)>=0) hotSizeVMS+=netBytes;
      if(hotTblsHWMS.indexOf(r.tbl)>=0) hotSizeHWMS+=netBytes;
    });
    var hotSizeAll=hotSizeVMS+hotSizeHWMS;

    // Detect sync modes (from portal probe)
    var isVmsIncr=_portalSyncProbe.vms==='incremental';
    var isHwmsIncr=_portalSyncProbe.hwms==='incremental';
    var isVmsFullIncr=_portalSyncProbe.vmsFull==='incremental';
    var isHwmsFullIncr=_portalSyncProbe.hwmsFull==='incremental';
    var isFullIncr=isVmsFullIncr&&isHwmsFullIncr;

    // Egress per user per hour:
    // Hot poll: every 10s = 360/hr. Full mode: SELECT * every 30s=120/hr. Incremental: ~0 bytes
    // Full sync: every 60s = 60/hr → all tables
    // Boot: 1× per session (assume 2 sessions/day = 0.08/hr)
    // Realtime: ~negligible for egress (server→client push)
    // Save: .upsert().select() returns row back ~1KB avg, assume 20 saves/hr
    // VISIBILITY OPTIMIZATION: polling pauses when tab hidden. Active screen
    // time is ~50% of business hours. Polls + syncs reduced proportionally.
    // Saves and realtime only happen during active use, so they stay as-is.
    function calcEgress(users,hotSize,fullSize,isIncr){
      var hotPerHr=isIncr?360*500:120*hotSize;
      var fullPerHr=60*fullSize;
      var bootPerHr=0.08*fullSize;
      var savePerHr=20*2048;
      var rtPerHr=50*2048;
      var perUser=hotPerHr+fullPerHr+bootPerHr+savePerHr+rtPerHr;
      return perUser*users;
    }

    html+='<div style="margin-top:16px;border:1.5px solid #818cf8;border-radius:10px;overflow:hidden">';
    html+='<div style="background:#eef2ff;padding:12px 16px;font-size:14px;font-weight:900;color:#4338ca;border-bottom:1.5px solid #818cf8">📡 Estimated Supabase Egress</div>';
    html+='<div style="padding:16px">';

    // User count + active screen ratio inputs
    html+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">';
    html+='<label style="font-size:12px;font-weight:700;color:#475569">Active users:</label>';
    html+='<input type="number" id="dbEgressUsers" value="5" min="1" max="50" style="width:60px;padding:6px 8px;font-size:14px;font-weight:800;font-family:monospace;border:1.5px solid #818cf8;border-radius:6px;text-align:center" onchange="_recalcEgress()" oninput="_recalcEgress()">';
    html+='<span style="font-size:11px;color:#64748b">concurrent users during business hours (8 hrs)</span>';
    html+='</div>';
    html+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">';
    html+='<label style="font-size:12px;font-weight:700;color:#475569">Screen active:</label>';
    html+='<input type="number" id="dbEgressScreenPct" value="50" min="10" max="100" step="5" style="width:60px;padding:6px 8px;font-size:14px;font-weight:800;font-family:monospace;border:1.5px solid #818cf8;border-radius:6px;text-align:center" onchange="_recalcEgress()" oninput="_recalcEgress()">';
    html+='<span style="font-size:11px;color:#64748b">% of time tab is visible (polling pauses when hidden)</span>';
    html+='</div>';

    // Sync mode badges
    html+='<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">';
    html+='<div style="font-size:11px;padding:4px 10px;border-radius:6px;font-weight:700;background:#dcfce7;color:#16a34a;border:1px solid #86efac">⏸ Visibility Polling: ✅ Active</div>';
    html+='<div style="font-size:11px;padding:4px 10px;border-radius:6px;font-weight:700;'+(isVmsIncr?'background:#dcfce7;color:#16a34a;border:1px solid #86efac':'background:#fef9c3;color:#a16207;border:1px solid #fde68a')+'">VMS Hot: '+(isVmsIncr?'✅ Incremental':'⚠️ Full')+'</div>';
    html+='<div style="font-size:11px;padding:4px 10px;border-radius:6px;font-weight:700;'+(isHwmsIncr?'background:#dcfce7;color:#16a34a;border:1px solid #86efac':'background:#fef9c3;color:#a16207;border:1px solid #fde68a')+'">HWMS Hot: '+(isHwmsIncr?'✅ Incremental':'⚠️ Full')+'</div>';
    html+='<div style="font-size:11px;padding:4px 10px;border-radius:6px;font-weight:700;'+(isFullIncr?'background:#dcfce7;color:#16a34a;border:1px solid #86efac':'background:#fef9c3;color:#a16207;border:1px solid #fde68a')+'">Full Sync: '+(isFullIncr?'✅ Incremental':'⚠️ Standard')+'</div>';
    if(!isVmsIncr||!isHwmsIncr||!isFullIncr) html+='<div style="font-size:10px;padding:4px 10px;border-radius:6px;background:#fef2f2;color:#dc2626;border:1px solid #fecaca;font-weight:600">Run the updated_at SQL migration on ALL tables to enable full incremental sync</div>';
    html+='</div>';

    html+='<div id="dbEgressResults"></div>';
    html+='</div></div>';

    // Store egress data globally for recalc
    window._egData={hotVMS:hotSizeVMS,hotHWMS:hotSizeHWMS,allSize:allSize,vmsIncr:isVmsIncr,hwmsIncr:isHwmsIncr,fullIncr:isFullIncr};

    // Tips
    html+='<div style="margin-top:14px;padding:10px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:11px;color:#92400e;line-height:1.6">';
    html+='<div style="font-weight:800;margin-bottom:4px">💡 Storage Tips</div>';
    html+='All data is synced to every user\'s browser. Large tables with images increase bandwidth and slow sync.<br>';
    html+='Photos are compressed to ~100-150KB before saving. Click any table row to see per-field breakdown.';
    html+='</div>';
    body.innerHTML=html;
    // Trigger egress calculation after DOM is set
    setTimeout(_recalcEgress,100);
  },50);
}
function _recalcEgress(){
  var users=parseInt((document.getElementById('dbEgressUsers')||{}).value)||5;
  var screenPct=parseInt((document.getElementById('dbEgressScreenPct')||{}).value)||50;
  var screenRatio=Math.max(0.1,Math.min(1,screenPct/100));
  var d=window._egData;if(!d) return;
  var fmt2=function(b){if(b>=1073741824)return(b/1073741824).toFixed(2)+' GB';if(b>=1048576)return(b/1048576).toFixed(1)+' MB';if(b>=1024)return(b/1024).toFixed(0)+' KB';return b+' B';};
  // Polling-based egress scales with screen active ratio (paused when tab hidden)
  var hotPollVMS=(d.vmsIncr?360*500:120*d.hotVMS)*screenRatio;
  var hotPollHWMS=(d.hwmsIncr?360*500:120*d.hotHWMS)*screenRatio;
  var fullSyncIncr=((48*500)+(12*d.allSize))*screenRatio;
  var fullSyncStd=(60*d.allSize)*screenRatio;
  var fullSync=d.fullIncr?fullSyncIncr:fullSyncStd;
  // Boot, saves, realtime don't scale with visibility (they happen on active use)
  var bootSync=0.08*d.allSize;
  var saves=20*2048;
  var rt=50*2048;
  // + 1 catch-up sync per resume (~2 resumes/hr on avg when screenRatio<1)
  var resumeSyncs=screenRatio<1?2*d.allSize:0;
  var perUserHr=hotPollVMS+hotPollHWMS+fullSync+bootSync+saves+rt+resumeSyncs;
  var totalHr=perUserHr*users;
  var totalDay=totalHr*8;
  var totalMonth=totalDay*26;
  // What-if: everything incremental
  var hotPollVMSI=(360*500)*screenRatio;
  var hotPollHWMSI=(360*500)*screenRatio;
  var fullSyncI=fullSyncIncr;
  var perUserHrI=hotPollVMSI+hotPollHWMSI+fullSyncI+bootSync+saves+rt+resumeSyncs;
  var totalHrI=perUserHrI*users;var totalDayI=totalHrI*8;var totalMonthI=totalDayI*26;
  var el=document.getElementById('dbEgressResults');if(!el)return;
  var h='<table style="width:100%;font-size:12px;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:6px">';
  h+='<thead><tr style="background:#f8fafc"><th style="padding:6px 10px;text-align:left;font-size:10px">Source</th><th style="padding:6px 10px;text-align:right;font-size:10px">Per User/Hr</th><th style="padding:6px 10px;text-align:right;font-size:10px">'+users+' Users/Hr</th><th style="padding:6px 10px;text-align:right;font-size:10px">Daily (8hr)</th><th style="padding:6px 10px;text-align:right;font-size:10px">Monthly (26d)</th></tr></thead><tbody>';
  var rows=[
    ['Hot Poll — VMS (10s) ×'+screenPct+'%',hotPollVMS],['Hot Poll — HWMS (10s) ×'+screenPct+'%',hotPollHWMS],
    ['Full Sync — '+(d.fullIncr?'Incremental':'Standard')+' ×'+screenPct+'%',fullSync],
    ['Resume catch-up syncs',resumeSyncs],
    ['Boot (session start)',bootSync],
    ['Save responses',saves],
    ['Realtime events',rt]
  ];
  rows.forEach(function(r){
    var c='#475569';
    if(r[0].indexOf('Hot Poll')>=0) c=(d.vmsIncr&&r[0].indexOf('VMS')>=0||d.hwmsIncr&&r[0].indexOf('HWMS')>=0)?'#16a34a':'#dc2626';
    if(r[0].indexOf('Full Sync')>=0) c=d.fullIncr?'#16a34a':'#dc2626';
    h+='<tr style="border-top:1px solid #e2e8f0"><td style="padding:5px 10px;font-weight:600;color:'+c+'">'+r[0]+'</td>';
    h+='<td style="padding:5px 10px;text-align:right;font-family:monospace">'+fmt2(r[1])+'</td>';
    h+='<td style="padding:5px 10px;text-align:right;font-family:monospace">'+fmt2(r[1]*users)+'</td>';
    h+='<td style="padding:5px 10px;text-align:right;font-family:monospace">'+fmt2(r[1]*users*8)+'</td>';
    h+='<td style="padding:5px 10px;text-align:right;font-family:monospace">'+fmt2(r[1]*users*8*26)+'</td></tr>';
  });
  // Total row
  h+='<tr style="border-top:2px solid #4338ca;background:#eef2ff"><td style="padding:8px 10px;font-weight:900;color:#4338ca">TOTAL (Current)</td>';
  h+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:900;color:#4338ca">'+fmt2(perUserHr)+'</td>';
  h+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:900;color:#4338ca">'+fmt2(totalHr)+'</td>';
  h+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:900;color:#4338ca">'+fmt2(totalDay)+'</td>';
  h+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:900;color:#4338ca">'+fmt2(totalMonth)+'</td></tr>';
  // If not fully optimized, show potential savings
  if(!d.vmsIncr||!d.hwmsIncr||!d.fullIncr){
    h+='<tr style="background:#f0fdf4"><td style="padding:8px 10px;font-weight:800;color:#16a34a">WITH All Incremental ✅</td>';
    h+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:800;color:#16a34a">'+fmt2(perUserHrI)+'</td>';
    h+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:800;color:#16a34a">'+fmt2(totalHrI)+'</td>';
    h+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:800;color:#16a34a">'+fmt2(totalDayI)+'</td>';
    h+='<td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:800;color:#16a34a">'+fmt2(totalMonthI)+'</td></tr>';
    var saved=totalMonth-totalMonthI;
    h+='<tr style="background:#dcfce7"><td style="padding:6px 10px;font-weight:700;color:#166534" colspan="4">Potential monthly savings with full incremental sync</td>';
    h+='<td style="padding:6px 10px;text-align:right;font-family:monospace;font-weight:900;color:#166534">↓ '+fmt2(saved)+'</td></tr>';
  }
  h+='</tbody></table>';
  // Supabase plan context
  var planColor=totalMonth>5*1073741824?'#dc2626':'#16a34a';
  h+='<div style="margin-top:10px;font-size:11px;color:#64748b;line-height:1.6">';
  h+='<strong>Supabase Free plan:</strong> 5 GB egress/month · <strong>Pro plan:</strong> 250 GB egress/month · Current estimated: <strong style="color:'+planColor+'">'+fmt2(totalMonth)+'/month</strong>';
  h+='<br><strong>⏸ Visibility optimization:</strong> Polling pauses when tab is hidden/minimized. At '+screenPct+'% screen time, polling egress is reduced by '+(100-screenPct)+'%.';
  h+='</div>';
  el.innerHTML=h;
}

function renderAppGrid(){
  const grid=document.getElementById('appGrid'),userApps=CU.apps||[];
  const isAdmin=(CU.roles||[]).some(r=>r==='Super Admin'||r==='Admin');
  grid.innerHTML=PORTAL_APPS.map(app=>{
    const file=APP_FILES[app.id]||null,active=APP_ACTIVE[app.id]||false,hasAccess=isAdmin||userApps.includes(app.id),enabled=active&&hasAccess;
    return `<div class="app-card${enabled?'':' disabled'}" ${enabled?`onclick="openApp('${app.id}','${file}')"`:''}><span class="app-icon">${app.icon}</span><div class="app-label">${app.label}</div><div class="app-full">${app.full}</div><span class="app-badge ${active?'active':'coming'}">${active?(hasAccess?'Active':'No Access'):'Coming Soon'}</span></div>`;
  }).join('');
}
function openApp(id,file){
  if(!file){notify('Module not yet available',true);return;}
  // If pre-fetch already loaded all tables, navigate immediately
  if(_portalPreFetchDone){
    _APP_TABLES=null;
    _navigateTo(file+'?app='+id);
    return;
  }
  if(!_sbReady||!_sb){_navigateTo(file+'?app='+id);return;}
  // Pre-fetch ALL tables with 4s timeout
  showSpinner('Loading '+id+'…');
  var allTables=DB_TABLES;
  var fetchDone=false;
  var timeout=setTimeout(function(){
    if(fetchDone) return;
    fetchDone=true;
    hideSpinner();
    _APP_TABLES=null;
    _navigateTo(file+'?app='+id);
  },4000);
  var _openAppCutoff=_dateCutoff();
  Promise.all(allTables.map(function(tbl){
    if(!SB_TABLES[tbl]) return Promise.resolve(null);
    var sel=_syncSelect(SB_TABLES[tbl]);
    var q=_sb.from(SB_TABLES[tbl]).select(sel);
    q=_applyDateFilter(q,SB_TABLES[tbl],_openAppCutoff);
    return q.then(function(res){
      if(res.error) return null;
      return {tbl:tbl, rows:res.data||[]};
    }).catch(function(){return null;});
  })).then(function(results){
    if(fetchDone) return;
    fetchDone=true;
    clearTimeout(timeout);
    (results||[]).filter(Boolean).forEach(function(r){
      DB[r.tbl]=r.rows.map(function(row){return _fromRow(r.tbl,row);}).filter(Boolean);
    });
    hideSpinner();
    _APP_TABLES=null;
    _navigateTo(file+'?app='+id);
  }).catch(function(){
    if(fetchDone) return;
    fetchDone=true;
    clearTimeout(timeout);
    hideSpinner();
    _APP_TABLES=null;
    _navigateTo(file+'?app='+id);
  });
}

// ── Users table ─────────────────────────────────────────────────────────────
function renderPortalUsers(){
  const srch=(document.getElementById('puSearch')?.value||'').toLowerCase();
  const showI=document.getElementById('puShowInactive')?.checked;
  const isSA=CU?.roles?.includes('Super Admin');
  let rows=[...DB.users].filter(u=>isSA||!(u.roles||[]).includes('Super Admin')).sort((a,b)=>(a.fullName||a.name).localeCompare(b.fullName||b.name));
  if(srch) rows=rows.filter(u=>(u.fullName||'').toLowerCase().includes(srch)||(u.name||'').toLowerCase().includes(srch));
  if(!showI) rows=rows.filter(u=>!u.inactive);
  document.getElementById('puBody').innerHTML=rows.length?rows.map(u=>{
    const loc=byId(DB.locations||[],u.plant);
    const locBadge=loc?(loc.colour?`<span style="background:${loc.colour};color:${colourContrast(loc.colour)};padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px">${loc.name}</span>`:loc.name):(u.plant||'—');
    const iBadge=u.inactive?'<span style="font-size:9px;font-weight:700;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;margin-left:5px">Inactive</span>':'';
    const appBadges=(u.apps||[]).map(id=>{const a=PORTAL_APPS.find(x=>x.id===id);return a?`<span style="font-size:10px;background:#f0fafa;color:#2a9aa0;border:1px solid #b3dfe0;padding:1px 6px;border-radius:4px;margin-right:2px">${a.icon} ${a.label}</span>`:''}).join('')||'—';
    const roleBadges=(u.roles||[]).filter(r=>r!=='Super Admin'||isSA).map(r=>r==='Super Admin'?`<span class="badge" style="background:#ede9fe;color:#7c3aed;margin-right:3px">⭐ SA</span>`:`<span class="badge badge-blue" style="margin-right:3px">${r}</span>`).join('')+((u.hwmsRoles||[]).length?'<br>'+(u.hwmsRoles||[]).map(r=>`<span class="badge" style="background:rgba(139,92,246,.12);color:#7c3aed;margin-right:3px;margin-top:2px">${r}</span>`).join(''):'');
    return `<tr class="clickable-row" ${u.inactive?'style="opacity:.55"':''}>
      <td>${u.photo?`<img src="${u.photo}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid var(--border2)">`:'<div style="width:32px;height:32px;border-radius:50%;background:var(--surface2);border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--text3)">👤</div>'}</td>
      <td style="font-weight:600">${u.fullName||'—'}${iBadge}</td>
      <td style="font-family:var(--mono);font-size:12px">${u.name}</td>
      <td>${locBadge}</td><td>${appBadges}</td><td>${roleBadges}</td>
      <td style="white-space:nowrap"><button class="action-btn" onclick="puOpenModal('${u.id}')" title="Edit">✏️</button>${!(u.roles||[]).includes('Super Admin')?`<button class="action-btn" onclick="puResetPwd('${u.id}')" title="Reset Password" style="color:#f59e0b">🔑</button>`:``}<button class="action-btn" onclick="puDeleteUser('${u.id}')" title="Delete" style="color:#ef4444">🗑️</button></td>
    </tr>`;
  }).join(''):'<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text3)">No users found</td></tr>';
}

// ── User modal ──────────────────────────────────────────────────────────────
function puOpenModal(id){
  const u=id?byId(DB.users,id):null;
  document.getElementById('muId').value=id||'';
  document.getElementById('muName').value=u?.name||'';
  document.getElementById('muPass').value=u?.password||'';
  document.getElementById('muFull').value=u?.fullName||'';
  document.getElementById('muMobile').value=u?.mobile||'';
  document.getElementById('muTitle').textContent=id?'Edit User':'Add User';
  // Location dropdown
  const locs=(DB.locations||[]).filter(l=>l&&l.type==='KAP'&&!l.inactive).sort((a,b)=>a.name.localeCompare(b.name));
  document.getElementById('muLoc').innerHTML='<option value="">-- Select --</option>'+locs.map(l=>`<option value="${l.id}"${l.id===u?.plant?' selected':''}>${l.name}</option>`).join('');
  // Apps
  const ua=u?.apps||(u?['vms']:[]);
  document.getElementById('muApps').innerHTML=PORTAL_APPS.map(a=>{const c=ua.includes(a.id);return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:${c?'rgba(42,154,160,.07)':'var(--surface2)'};padding:4px 10px;border-radius:5px;border:1px solid ${c?'var(--accent)':'var(--border)'}"><input type="checkbox" class="muAppCb" value="${a.id}" ${c?'checked':''} style="width:auto" onchange="puAppChange(this)"> ${a.icon} ${a.label}</label>`}).join('');
  // VMS roles
  const isSA=CU?.roles?.includes('Super Admin');
  const vr=ROLES.filter(r=>r!=='Super Admin'||isSA);
  document.getElementById('muVmsBoxes').innerHTML=vr.map(r=>{const c=(u?.roles||[]).includes(r);const sa=r==='Super Admin';return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:${sa?'rgba(139,92,246,.08)':'var(--surface2)'};padding:4px 10px;border-radius:5px;border:1px solid ${c?(sa?'var(--purple)':'var(--accent)'):(sa?'rgba(139,92,246,.3)':'var(--border)')}"><input type="checkbox" class="muVmsCb" value="${r}" ${c?'checked':''} style="width:auto"> ${sa?'⭐ ':''}${r}</label>`}).join('');
  // HWMS roles
  document.getElementById('muHwmsBoxes').innerHTML=HWMS_ROLES.map(r=>{const c=(u?.hwmsRoles||[]).includes(r);return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:rgba(139,92,246,.06);padding:4px 10px;border-radius:5px;border:1px solid ${c?'var(--purple)':'rgba(139,92,246,.25)'}"><input type="checkbox" class="muHwmsCb" value="${r}" ${c?'checked':''} style="width:auto"> ${r}</label>`}).join('');
  document.getElementById('muVmsRoles').style.display=ua.includes('vms')?'block':'none';
  document.getElementById('muHwmsRoles').style.display=ua.includes('hwms')?'block':'none';
  document.getElementById('muInactive').checked=u?.inactive===true;
  om('mUser');
}
function puAppChange(cb){
  cb.closest('label').style.background=cb.checked?'rgba(42,154,160,.07)':'var(--surface2)';
  cb.closest('label').style.borderColor=cb.checked?'var(--accent)':'var(--border)';
  const sel=[...document.querySelectorAll('.muAppCb:checked')].map(i=>i.value);
  document.getElementById('muVmsRoles').style.display=sel.includes('vms')?'block':'none';
  document.getElementById('muHwmsRoles').style.display=sel.includes('hwms')?'block':'none';
}

// ── Save user ───────────────────────────────────────────────────────────────
async function puSaveUser(){
  const id=document.getElementById('muId').value;
  const name=document.getElementById('muName').value.trim().toLowerCase().replace(/[\s!@#$%^&*()+=\[\]{};':"\\|,.<>\/?]/g,'');
  const pass=document.getElementById('muPass').value;
  const plant=document.getElementById('muLoc').value;
  const fullName=document.getElementById('muFull').value.trim();
  const mobile=document.getElementById('muMobile').value;
  const apps=[...document.querySelectorAll('.muAppCb:checked')].map(i=>i.value);
  const roles=[...document.querySelectorAll('.muVmsCb:checked')].map(i=>i.value);
  const hwmsRoles=[...document.querySelectorAll('.muHwmsCb:checked')].map(i=>i.value);
  const inactive=document.getElementById('muInactive')?.checked===true;
  if(!name||!pass){modalErr('mUser','Username and password required');return}
  if(!plant){modalErr('mUser','Location required');return}
  if(!fullName){modalErr('mUser','Full name required');return}
  if(!apps.length){modalErr('mUser','Select at least one app');return}
  if(apps.includes('vms')&&!roles.length){modalErr('mUser','Select at least one VMS role');return}
  if(apps.includes('hwms')&&!hwmsRoles.length){modalErr('mUser','Select at least one HWMS role');return}
  if(roles.includes('KAP Security')&&roles.length>1){modalErr('mUser','KAP Security cannot combine with other roles');return}
  if(mobile&&mobile.length!==10){modalErr('mUser','Mobile must be 10 digits');return}
  // Guard last Super Admin
  const eu=id?byId(DB.users,id):null;
  if(eu?.roles?.includes('Super Admin')&&!roles.includes('Super Admin')){
    if(DB.users.filter(u=>u.id!==id&&u.roles.includes('Super Admin')).length===0){modalErr('mUser','Cannot remove last Super Admin');return}
  }
  // Duplicate checks
  if(DB.users.find(u=>u&&u.name===name&&u.id!==id&&!u.inactive)){modalErr('mUser','Username already exists');return}
  if(DB.users.find(u=>(u.fullName||'').trim().toLowerCase()===fullName.toLowerCase()&&u.id!==id&&!u.inactive)){modalErr('mUser','Full name already exists');return}
  if(id){
    const bak={...eu};Object.assign(eu,{name,password:pass,plant,fullName,mobile,roles,hwmsRoles,apps,inactive});
    if(!await _dbSave('users',eu)){Object.assign(eu,bak);return}
  } else {
    const nu={id:'u'+uid(),name,password:pass,plant,fullName,mobile,roles,hwmsRoles,apps,inactive,photo:'',email:''};
    if(!await _dbSave('users',nu)) return;
  }
  cm('mUser');
  // Auto-sync user's roles into their plant location's role arrays
  const _savedUId=id||(DB.users[DB.users.length-1]?.id);
  if(_savedUId&&plant&&!inactive&&typeof _syncUserToLocation==='function') await _syncUserToLocation(_savedUId,plant,roles);
  // Sync CU if editing own record
  if(CU&&(id===CU.id||(!id&&DB.users[DB.users.length-1]?.name===name))){
    const fresh=DB.users.find(u=>u.name===name);
    if(fresh) Object.assign(CU,fresh);
  }
  renderPortalUsers();notify('User saved!');
}

// ── Delete user ─────────────────────────────────────────────────────────────
async function puDeleteUser(id){
  const u=byId(DB.users,id);if(!u) return;
  if(u.roles?.includes('Super Admin')&&DB.users.filter(x=>x.id!==id&&x.roles.includes('Super Admin')).length===0){notify('Cannot delete last Super Admin',true);return}
  // Check references
  const refs=[];
  (DB.locations||[]).forEach(l=>{if(l.kapSec===id||(l.tripBook||[]).includes(id)||(l.matRecv||[]).includes(id)||(l.approvers||[]).includes(id)) refs.push('Location: '+l.name)});
  (DB.trips||[]).forEach(t=>{if(t.bookedBy===id) refs.push('Trip: '+t.id)});
  if(refs.length){notify('Cannot delete — referenced by: '+refs.slice(0,3).join(', ')+(refs.length>3?' + '+(refs.length-3)+' more':''),true);return}
  showConfirm('Delete user "'+u.fullName+'"?', async ()=>{
    if(!await _dbDel('users',id)) return;
    renderPortalUsers();notify('User deleted');
  });
}

// ── Reset password ──────────────────────────────────────────────────────────
async function puResetPwd(id){
  var u=byId(DB.users,id);if(!u){notify('User not found',true);return;}
  var userName=u.fullName||u.name||'this user';
  if(!confirm('Reset password for "'+userName+'" to "Kappl@123"?\n\nThe user will be forced to change password on next login.')) return;
  var bak=u.password;
  u.password='Kappl@123';
  try{
    var ok=await _dbSave('users',u);
    if(!ok){u.password=bak;notify('Failed to reset password',true);return;}
    notify('🔑 Password for "'+userName+'" reset to "Kappl@123".');
    renderPortalUsers();
  }catch(err){
    u.password=bak;
    notify('Failed: '+err.message,true);
  }
}

// ── Profile ─────────────────────────────────────────────────────────────────
function ppLoadProfile(){
  if(!CU) return;
  const initials=(CU.fullName||CU.name).split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  const av=document.getElementById('ppAvatar');
  if(CU.photo){av.innerHTML=`<img src="${CU.photo}" style="width:100%;height:100%;object-fit:cover">`;document.getElementById('ppPhotoClearBtn').style.display='block';}
  else{av.textContent=initials;av.style.backgroundImage='';document.getElementById('ppPhotoClearBtn').style.display='none';}
  document.getElementById('ppName').textContent=CU.fullName||CU.name;
  document.getElementById('ppRole').textContent=[...(CU.roles||[]),...(CU.hwmsRoles||[])].join(', ');
  document.getElementById('ppUser').textContent='@'+CU.name;
  document.getElementById('ppFullName').value=CU.fullName||'';
  document.getElementById('ppUsername').value=CU.name||'';
  document.getElementById('ppMobile').value=CU.mobile||'';
  document.getElementById('ppEmail').value=CU.email||'';
  // Reset password section
  document.getElementById('ppPassSection').style.display='none';
  document.getElementById('ppPassIcon').style.transform='rotate(0deg)';
  document.getElementById('ppOldPass').value='';
  document.getElementById('ppNewPass').value='';
  document.getElementById('ppConfPass').value='';
  _ppMsg('ppInfoMsg','',true);_ppMsg('ppPassMsg','',true);
}
function _ppMsg(elId,msg,ok){
  const el=document.getElementById(elId);if(!el)return;
  if(!msg){el.style.display='none';return;}
  el.textContent=msg;el.style.display='block';
  el.style.color=ok?'#4ade80':'#f87171';
  el.style.background=ok?'rgba(74,222,128,.08)':'rgba(248,113,113,.08)';
  el.style.border=ok?'1px solid rgba(74,222,128,.2)':'1px solid rgba(248,113,113,.2)';
  if(ok) setTimeout(()=>{el.style.display='none';},3000);
}
async function ppSaveProfile(){
  if(!CU) return;
  const fullName=(document.getElementById('ppFullName').value||'').trim();
  const mobile=(document.getElementById('ppMobile').value||'').trim();
  const email=(document.getElementById('ppEmail').value||'').trim();
  if(!fullName){_ppMsg('ppInfoMsg','Full name is required',false);return;}
  if(mobile&&mobile.length!==10){_ppMsg('ppInfoMsg','Mobile must be 10 digits',false);return;}
  const dbUser=byId(DB.users,CU.id);
  if(dbUser){
    const bak={...dbUser};
    Object.assign(dbUser,{fullName,mobile,email,photo:CU.photo||''});
    if(!await _dbSave('users',dbUser)){Object.assign(dbUser,bak);return;}
  }
  CU.fullName=fullName;CU.mobile=mobile;CU.email=email;
  document.getElementById('ppName').textContent=fullName;
  // Update topbar
  document.getElementById('portalUserName').textContent=fullName;
  const initials=fullName.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  document.getElementById('portalAvatar').textContent=CU.photo?'':initials;
  _ppMsg('ppInfoMsg','Profile saved!',true);
}
function ppTogglePass(){
  const s=document.getElementById('ppPassSection');
  const ic=document.getElementById('ppPassIcon');
  const open=s.style.display==='none';
  s.style.display=open?'block':'none';
  if(ic)ic.style.transform=open?'rotate(180deg)':'rotate(0deg)';
}
async function ppSavePass(){
  if(!CU) return;
  const oldPass=document.getElementById('ppOldPass').value||'';
  const newPass=document.getElementById('ppNewPass').value||'';
  const confPass=document.getElementById('ppConfPass').value||'';
  if(!oldPass||!newPass||!confPass){_ppMsg('ppPassMsg','Fill all password fields',false);return;}
  if(oldPass!==CU.password){_ppMsg('ppPassMsg','Current password is incorrect',false);return;}
  const pwdErrs=_pwdErrors(newPass);
  if(pwdErrs.length){_ppMsg('ppPassMsg','Password requires: '+pwdErrs.join(', '),false);return;}
  if(newPass!==confPass){_ppMsg('ppPassMsg','New passwords do not match',false);return;}
  const dbUser=byId(DB.users,CU.id);
  if(dbUser){const bak={...dbUser};dbUser.password=newPass;if(!await _dbSave('users',dbUser)){dbUser.password=bak.password;return;}}
  CU.password=newPass;
  try{if(localStorage.getItem('kap_rm_pass'))localStorage.setItem('kap_rm_pass',newPass);}catch(e){}
  try{if(sessionStorage.getItem('kap_session_pass'))sessionStorage.setItem('kap_session_pass',newPass);}catch(e){}
  document.getElementById('ppOldPass').value='';document.getElementById('ppNewPass').value='';document.getElementById('ppConfPass').value='';
  _ppMsg('ppPassMsg','Password updated!',true);
}
function ppOnPhoto(input){
  if(!input.files||!input.files[0])return;
  const file=input.files[0];
  const reader=new FileReader();
  reader.onload=ev=>{
    CU.photo=ev.target.result;
    ppLoadProfile(); // refresh avatar immediately
    compressImage(file).then(async c=>{
      CU.photo=c;
      const dbUser=byId(DB.users,CU.id);
      if(dbUser){dbUser.photo=c;await _dbSave('users',dbUser);}
      ppLoadProfile();
    }).catch(()=>{});
  };
  reader.readAsDataURL(file);input.value='';
}
async function ppClearPhoto(){
  if(!CU)return;
  CU.photo='';
  const dbUser=byId(DB.users,CU.id);
  if(dbUser){dbUser.photo='';await _dbSave('users',dbUser);}
  ppLoadProfile();
}

// ── Dropdown ────────────────────────────────────────────────────────────────
function toggleDropdown(){document.getElementById('userDropdown').classList.toggle('show')}
document.addEventListener('click',e=>{
  if(!e.target.closest('.user-pill')&&!e.target.closest('.user-dropdown'))document.getElementById('userDropdown').classList.remove('show');
  // Close sidebar on mobile when clicking outside it
  var sb=document.getElementById('portalSidebar');
  if(sb&&sb.classList.contains('open')&&!e.target.closest('#portalSidebar')&&!e.target.closest('#portalHbBtn'))sb.classList.remove('open');
});
function openProfile(){document.getElementById('userDropdown').classList.remove('show');showTab('profile')}

// ── Logout ──────────────────────────────────────────────────────────────────
// ── Force Password Change ───────────────────────────────────────────────────
var _PORTAL_RESET_PWD='Kappl@123';
function _isStrongPwd(pwd){
  if(!pwd||pwd.length<6||pwd.length>12) return false;
  if(!/[A-Z]/.test(pwd)) return false;
  if(!/[a-z]/.test(pwd)) return false;
  if(!/[0-9]/.test(pwd)) return false;
  if(!/[^A-Za-z0-9]/.test(pwd)) return false;
  return true;
}
function _liveValidatePwd(pwd){
  var rules=[
    {id:'fpR1',ok:pwd.length>=6&&pwd.length<=12},
    {id:'fpR2',ok:/[A-Z]/.test(pwd)},
    {id:'fpR3',ok:/[a-z]/.test(pwd)},
    {id:'fpR4',ok:/[0-9]/.test(pwd)},
    {id:'fpR5',ok:/[^A-Za-z0-9]/.test(pwd)}
  ];
  var labels=['6–12 characters','One uppercase letter (A-Z)','One lowercase letter (a-z)','One number (0-9)','One special character'];
  rules.forEach(function(r,i){
    var el=document.getElementById(r.id);
    if(el){el.textContent=(r.ok?'✅':'❌')+' '+labels[i];el.style.color=r.ok?'#16a34a':'#dc2626';el.style.fontWeight=r.ok?'600':'400';}
  });
}
function _toggleFpVis(inputId,btn){
  var inp=document.getElementById(inputId);if(!inp)return;
  var isPass=inp.type==='password';
  inp.type=isPass?'text':'password';
  btn.textContent=isPass?'🙈':'👁';
}
function _openForcePassModal(){
  document.getElementById('forceNewPass').value='';
  document.getElementById('forceConfPass').value='';
  document.getElementById('forcePassMsg').style.display='none';
  document.getElementById('forceNewPass').type='password';
  document.getElementById('forceConfPass').type='password';
  if(CU){
    var fn=document.getElementById('fpFullName');
    var un=document.getElementById('fpUserName');
    var av=document.getElementById('fpUserAvatar');
    if(fn) fn.textContent=CU.fullName||CU.name||'';
    if(un) un.textContent='@'+CU.name;
    if(av){
      if(CU.photo){av.textContent='';av.style.backgroundImage='url('+CU.photo+')';av.style.backgroundSize='cover';av.style.backgroundPosition='center';}
      else{var initials=(CU.fullName||CU.name||'').trim().split(/\s+/).map(function(w){return w[0]||'';}).slice(0,2).join('').toUpperCase()||'👤';av.textContent=initials;av.style.backgroundImage='';}
    }
  }
  _liveValidatePwd('');
  om('mForcePass');
}
async function _doForceChangePass(){
  var newPwd=document.getElementById('forceNewPass').value;
  var confPwd=document.getElementById('forceConfPass').value;
  var msgEl=document.getElementById('forcePassMsg');
  var showErr=function(msg){msgEl.style.display='block';msgEl.style.background='#fee2e2';msgEl.style.color='#dc2626';msgEl.textContent=msg;};
  if(!newPwd||!confPwd){showErr('Please fill both password fields');return;}
  var errs=_pwdErrors(newPwd);
  if(errs.length){showErr('Password requires: '+errs.join(', '));return;}
  if(newPwd!==confPwd){showErr('Passwords do not match');return;}
  if(newPwd===CU.password){showErr('New password must be different from current password');return;}
  if(newPwd===_PORTAL_RESET_PWD){showErr('Cannot use the default password. Please choose a different one.');return;}
  var dbUser=byId(DB.users,CU.id);
  if(dbUser){
    var bak=dbUser.password;
    dbUser.password=newPwd;
    if(!await _dbSave('users',dbUser)){dbUser.password=bak;showErr('Failed to save. Try again.');return;}
  }
  CU.password=newPwd;
  try{if(localStorage.getItem('kap_rm_pass'))localStorage.setItem('kap_rm_pass',newPwd);}catch(e){}
  try{if(sessionStorage.getItem('kap_session_pass'))sessionStorage.setItem('kap_session_pass',newPwd);}catch(e){}
  cm('mForcePass');
  notify('🔐 Password updated successfully!');
  showPortal();
}
function _forcePassSignOut(){
  cm('mForcePass');
  doLogout();
}

function doLogout(){
  CU=null;_sessionDel('kap_session_user');_sessionDel('kap_session_pass');
  try{localStorage.removeItem('kap_rm_user');localStorage.removeItem('kap_rm_pass');localStorage.removeItem('kap_current_user');}catch(e){console.warn('[doLogout] ls err:',e);}
  // Allow login UI updates again
  _portalLoggedIn=false;
  // Reset login form state
  _rememberedLogin=false;
  _loginFailCount=0;
  _lockoutUntil=0;
  if(_lockoutInterval){clearInterval(_lockoutInterval);_lockoutInterval=null;}
  // Switch views
  document.getElementById('portalPage').style.display='none';
  document.getElementById('loginPage').style.display='flex';
  // Clear and re-enable all form inputs
  document.getElementById('loginUser').value='';
  document.getElementById('loginPass').value='';
  var loginErr=document.getElementById('loginError');
  if(loginErr){loginErr.textContent='';loginErr.style.display='none';}
  var captchaErr=document.getElementById('captchaErr');
  if(captchaErr) captchaErr.style.display='none';
  var lockBanner=document.getElementById('lockoutBanner');
  if(lockBanner) lockBanner.style.display='none';
  var btn=document.getElementById('loginBtn');
  if(btn){btn.removeAttribute('disabled');btn.disabled=false;btn.textContent='Sign In';btn.style.opacity='1';btn.style.cursor='pointer';}
  ['loginUser','loginPass','captchaAns'].forEach(function(id){
    var el=document.getElementById(id);
    if(el){el.disabled=false;el.style.opacity='1';el.classList.remove('input-error');el.value='';}
  });
  // Uncheck Remember Me
  var rmEl=document.getElementById('rememberMe');
  if(rmEl){rmEl.checked=false;rmEl.disabled=false;rmEl.style.opacity='1';}
  // Show and refresh CAPTCHA
  var cw=document.getElementById('captchaWrap');if(cw) cw.style.display='';
  _refreshCaptcha();
  // Sync login button state with current DB
  _portalUpdateLoginBtn();
  // Safety: re-enable login form after a short delay in case background sync disables it
  setTimeout(function(){
    var b=document.getElementById('loginBtn');
    if(b&&document.getElementById('loginPage').style.display!=='none'){
      b.removeAttribute('disabled');b.disabled=false;b.style.opacity='1';b.style.cursor='pointer';
      ['loginUser','loginPass','captchaAns'].forEach(function(id){
        var el=document.getElementById(id);if(el){el.disabled=false;el.style.opacity='1';}
      });
      var rm=document.getElementById('rememberMe');if(rm){rm.disabled=false;rm.style.opacity='1';}
    }
    console.log('[doLogout] safety re-enable done');
  },300);
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function _portalBoot(){
  // Portal only needs users and locations — not VMS/HWMS/Security operational tables
  if(typeof _APP_TABLES!=='undefined') _APP_TABLES=['users','locations'];
  // Check session
  var su,sp2;
  try{ su=_sessionGet('kap_session_user'); sp2=_sessionGet('kap_session_pass'); }catch(e){}
  if(!su||!sp2){
    try{ su=localStorage.getItem('kap_rm_user'); sp2=localStorage.getItem('kap_rm_pass'); }catch(e){}
    if(su&&sp2){ _sessionSet('kap_session_user',su); _sessionSet('kap_session_pass',sp2); }
  }

  var hasSession=!!(su&&sp2);
  var _bootDone=false; // guard: ensure bootDB is called exactly once

  // FAST PATH: session exists → bootDB → show portal
  if(hasSession){
    // Hide login page during boot — bootDB shows its own spinner
    document.getElementById('loginPage').style.display='none';
    var splash=document.getElementById('dbSplash');
    if(splash) splash.style.display='none';
    try{ await bootDB(); _bootDone=true; }catch(e){ _bootDone=true; }
    if(splash) splash.style.display='none';
    var user=(DB.users||[]).find(function(u){return u&&u.name.toLowerCase()===su&&u.password===sp2;});
    if(!user){
      // DB.users might be empty if Supabase failed/timed out.
      // Try to restore from the cached user object we save on every login.
      try{
        var _cu=localStorage.getItem('kap_current_user');
        if(_cu) user=JSON.parse(_cu);
        if(user&&user.name.toLowerCase()===su) { /* restored from cache */ }
        else user=null;
      }catch(e){ user=null; }
    }
    if(user&&!user.inactive){
      CU=user; _enrichCU();
      _portalLoggedIn=true;
      // Check password strength on session restore too
      if(!_isStrongPwd(user.password)||user.password==='Kappl@123'){
        // Show login page behind the modal so there's no blank screen
        document.getElementById('loginPage').style.display='flex';
        _openForcePassModal();
      } else {
        showPortal();
      }
      return;
    }
    // Session failed — show login page
    document.getElementById('loginPage').style.display='flex';
    // Session credentials did not match — fall through to login page.
    // bootDB already ran above; skip the second call below.
  }

  // Show login page — bootDB already called if hasSession was true
  if(!_bootDone){
    try{ await bootDB(); }catch(e){}
  }
  document.getElementById('loginPage').style.display='flex';
  // Update button state once after boot — not before (pre-boot DB is empty → shows 'connecting' unnecessarily)
  _portalUpdateLoginBtn();
  document.getElementById('loginUser')?.focus();
}

// Global Enter key handler
document.addEventListener('keydown', function(e){
  if(e.key!=='Enter') return;
  var el=e.target;
  if(!el||el.tagName==='TEXTAREA'||el.tagName==='BUTTON') return;
  var loginPage=document.getElementById('loginPage');
  if(loginPage&&loginPage.style.display!=='none'&&loginPage.contains(el)){
    e.preventDefault(); doLogin(); return;
  }
  var modal=el.closest('.modal-overlay');
  if(modal){var btn=modal.querySelector('.btn-primary');if(btn&&!btn.disabled){e.preventDefault();btn.click();return;}}
});

// ── Boot trigger ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', ()=>{
  if(typeof _COMMON_LOADED==='undefined') return; // Common.js missing — error already shown
  _portalBoot().catch(e=>{
    console.error('Portal boot failed:',e);
    // Show login page anyway
    document.getElementById('loginPage').style.display='flex';
  });
});

