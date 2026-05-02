/** @file portal-ui.js — Login page, app launcher, user management, profile, DB storage analysis @depends common.js, portal-logic.js */

// ═══ GUARD / DEPENDENCY CHECK ═════════════════════════════════════════════
if(typeof _COMMON_LOADED==='undefined'){
  document.addEventListener('DOMContentLoaded',function(){
    var lp=document.getElementById('loginPage');if(lp)lp.style.display='flex';
    var ov=document.getElementById('loginConnLabel');if(ov){ov.textContent='⚠ js/common.js not found';ov.style.color='#dc2626';}
  });
}

// ═══ BOOT OVERRIDES (bootDB, _navigateTo) ════════════════════════════════

// _SYNC_SELECT, _syncSelect, _dateCutoff, _applyDateFilter are in portal-logic.js

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

// Override _navigateTo to cache ALL tables (not just portal's 2 tables).
// Critical: PRESERVE entries from any existing cache that we don't currently
// have in DB. Without this, navigating Portal → HWMS overwrites the previous
// HWMS cache (containers, invoices, etc.) with empty arrays — because those
// tables aren't in Portal's DB — forcing the next HWMS boot to cold-fetch
// every table from Supabase, which is what produced the minute-long load.
var _origNavigateTo=_navigateTo;
_navigateTo=function(url){
  try{
    if(typeof DB!=='undefined'&&typeof DB_TABLES!=='undefined'&&DB.users&&DB.users.length){
      var cache={};
      try{
        var raw=localStorage.getItem('kap_db_cache');
        if(raw){
          var ec=JSON.parse(raw)||{};
          // Carry forward every previously-cached table.
          Object.keys(ec).forEach(function(k){
            if(k==='ts') return;
            if(Array.isArray(ec[k])&&ec[k].length) cache[k]=ec[k];
          });
        }
      }catch(e){}
      // Overlay with current DB data (fresher than what's in cache).
      DB_TABLES.forEach(function(t){
        if(DB[t]&&DB[t].length) cache[t]=DB[t];
      });
      cache.ts=Date.now();
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
      ['kap_db_local','kap_rm_user','kap_rm_token'].forEach(k=>localStorage.removeItem(k));
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

// ═══ LOGIN — CAPTCHA, LOCKOUT, AUTHENTICATION ═══════════════════════════
// _captchaAnswer, _loginFailCount, _lockoutUntil, _lockoutInterval, _LOCKOUT_MAX, _LOCKOUT_SECS are in portal-logic.js

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

// _isLockedOut() is in portal-logic.js

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
    var st=localStorage.getItem('kap_rm_token');
    if(su && st){
      var uEl=document.getElementById('loginUser');
      var rmEl=document.getElementById('rememberMe');
      if(uEl) uEl.value=su;
      if(rmEl) rmEl.checked=true;
      _rememberedLogin=true;
      // Token-based session will auto-restore in _portalBoot — no password pre-fill needed
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
async function doLogin(){
  try{
  console.log('[doLogin] START');
  if(!_sbReady||!_sb){
    document.getElementById('loginError').style.display='block';
    document.getElementById('loginError').textContent='Database not ready yet. Please wait a moment…';
    return;
  }
  if(_portalRetryTimer){clearInterval(_portalRetryTimer);_portalRetryTimer=null;}
  if(_isLockedOut()){
    document.getElementById('loginError').style.display='block';
    document.getElementById('loginError').textContent='Account locked. Please wait for the timer to expire.';
    return;
  }
  const u=document.getElementById('loginUser').value.toLowerCase().trim();
  const p=document.getElementById('loginPass').value;
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
  // Server-side login via RPC (bcrypt verification in PostgreSQL)
  showSpinner('Logging in…');
  var result=await _authLogin(u,p);
  hideSpinner();
  if(!result||!result.user){
    console.warn('[doLogin] auth failed');
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
  var user=result.user;
  var token=result.token;
  if(user.inactive===true){
    document.getElementById('loginError').style.display='block';
    document.getElementById('loginError').textContent='This account has been deactivated. Contact your Admin.';
    _refreshCaptcha();
    return;
  }
  _loginFailCount=0;
  CU=user; _enrichCU();
  _portalLoggedIn=true;
  // Store session token (NOT password)
  _sessionSet('kap_session_user',u);
  _sessionSet('kap_session_token',token);
  try{ localStorage.setItem('kap_current_user', JSON.stringify(user)); }catch(e){}
  var rememberChecked=document.getElementById('rememberMe')?.checked;
  try{
    if(rememberChecked){
      localStorage.setItem('kap_rm_user', u);
      localStorage.setItem('kap_rm_token', token);
    } else {
      localStorage.removeItem('kap_rm_user');
      localStorage.removeItem('kap_rm_token');
    }
  }catch(e){}
  // Clean up old plaintext password keys (pre-migration)
  try{localStorage.removeItem('kap_rm_pass');_sessionDel('kap_session_pass');}catch(e){}
  document.getElementById('loginError').style.display='none';
  // Check if password is weak — force change
  // We check client-side since the password is in the form field (not stored)
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
const APP_FILES={vms:'vms.html',hwms:'hwms.html',security:'security.html',maintenance:'maintenance.html',review:null,hrms:'hrms.html'};
const APP_ACTIVE={vms:true,hwms:true,security:true,maintenance:true,review:false,hrms:true};

// ═══ PORTAL VIEW / APP GRID ══════════════════════════════════════════════
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
  // Tab visibility:
  //   Users     — Super Admin / Admin (platform), and any app's Admin role
  //   DB Storage— Super Admin / Admin (platform), HWMS Admin
  //   Permissions (Role Settings) — Super Admin only
  var isSuper=(CU.roles||[]).indexOf('Super Admin')>=0;
  var isAdmin=(CU.roles||[]).indexOf('Admin')>=0;
  var isVmsAdmin=(CU.roles||[]).indexOf('VMS Admin')>=0;
  var isHwmsAdmin=(CU.hwmsRoles||[]).indexOf('HWMS Admin')>=0;
  var isHrAdmin=(CU.hrmsRoles||[]).indexOf('HR Admin')>=0||(CU.hrmsRoles||[]).indexOf('HRMS Admin')>=0;
  var isMttsAdmin=(CU.mttsRoles||[]).indexOf('MTTS Admin')>=0;
  var canManageUsers=isSuper||isAdmin||isVmsAdmin||isHwmsAdmin||isHrAdmin||isMttsAdmin;
  var ut=document.getElementById('usersTab'); if(ut) ut.style.display=canManageUsers?'':'none';
  var psU=document.getElementById('psNavUsers');if(psU)psU.style.display=canManageUsers?'':'none';
  var psDb=document.getElementById('psNavDbstorage');if(psDb)psDb.style.display=(isSuper||isHwmsAdmin)?'':'none';
  var psPerm=document.getElementById('psNavPermissions');if(psPerm)psPerm.style.display=isSuper?'':'none';
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
  // usersSection uses a flex column layout when active so the table-wrap
  // can take flex:1 and own the only scrollbar. Setting display:block here
  // would override the CSS rule and break that layout.
  document.getElementById('usersSection').style.display=tab==='users'?'flex':'none';
  document.getElementById('profileSection').style.display=tab==='profile'?'block':'none';
  var permSec=document.getElementById('permissionsSection');
  if(permSec) permSec.style.display=tab==='permissions'?'block':'none';
  document.getElementById('dbStorageSection').style.display=tab==='dbstorage'?'block':'none';
  // Sidebar nav highlighting
  document.querySelectorAll('.ps-nav').forEach(n=>n.classList.remove('active'));
  var sn=document.getElementById('psNav'+tab.charAt(0).toUpperCase()+tab.slice(1));
  if(sn) sn.classList.add('active');
  if(tab==='apps') renderAppGrid();
  // Guard admin-only tabs — must stay in sync with renderPortal() visibility
  var _isSA=CU&&(CU.roles||[]).indexOf('Super Admin')>=0;
  var _isAdmin=CU&&(CU.roles||[]).indexOf('Admin')>=0;
  var _isVmsAdmin=CU&&(CU.roles||[]).indexOf('VMS Admin')>=0;
  var _isHwmsAdmin=CU&&(CU.hwmsRoles||[]).indexOf('HWMS Admin')>=0;
  var _isHrAdmin=CU&&((CU.hrmsRoles||[]).indexOf('HR Admin')>=0||(CU.hrmsRoles||[]).indexOf('HRMS Admin')>=0);
  var _isMttsAdmin=CU&&(CU.mttsRoles||[]).indexOf('MTTS Admin')>=0;
  var _canUsers=_isSA||_isAdmin||_isVmsAdmin||_isHwmsAdmin||_isHrAdmin||_isMttsAdmin;
  var _canDb=_isSA||_isAdmin||_isHwmsAdmin;
  if(tab==='users'&&!_canUsers){showTab('apps');return;}
  if(tab==='permissions'&&!_isSA){showTab('apps');return;}
  if(tab==='dbstorage'&&!_canDb){showTab('apps');return;}
  // Toggle body.tab-users so the fixed-header layout (CSS) only applies on
  // the users tab — other tabs keep their normal page-scroll behaviour.
  // #portalPage carries an inline display:block from the login flow that
  // would otherwise override the CSS flex layout, so flip it here.
  document.body.classList.toggle('tab-users',tab==='users');
  var _pp=document.getElementById('portalPage');
  if(_pp) _pp.style.display=(tab==='users')?'flex':'block';
  // Set the welcome heading + subtitle to match the active menu page —
  // the "Welcome … select an application" line only shows on the Apps
  // page; every other page shows its own title.
  var _wm=document.getElementById('welcomeMsg');
  var _ws=document.getElementById('welcomeSub');
  var _tabHeads={
    apps:        {h:CU?('Welcome, '+(CU.fullName||CU.name)):'Welcome', s:'Select an application to get started'},
    users:       {h:'User Management',  s:'Manage users, app access and roles'},
    profile:     {h:'My Profile',       s:'Update your account details'},
    permissions: {h:'Access Management', s:'Role-based permissions per app'},
    dbstorage:   {h:'DB Storage',       s:'Database tables and storage usage'}
  };
  var _th=_tabHeads[tab]||_tabHeads.apps;
  if(_wm) _wm.textContent=_th.h;
  if(_ws) _ws.textContent=_th.s;
  if(tab==='users') renderPortalUsers();
  if(tab==='profile') ppLoadProfile();
  if(tab==='permissions') renderPermissions();
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

// ═══ DB STORAGE ANALYSIS ═════════════════════════════════════════════════
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
  const grid=document.getElementById('appGrid');
  // Only Super Admin is the GLOBAL admin. "Admin" is a VMS-scoped role —
  // it shouldn't grant HWMS/HRMS/Security tile visibility.
  const isSuperAdmin=(CU.roles||[]).some(r=>r==='Super Admin')
    ||(CU.hwmsRoles||[]).some(r=>r==='Super Admin')
    ||(CU.hrmsRoles||[]).some(r=>r==='Super Admin')
    ||(CU.mttsRoles||[]).some(r=>r==='Super Admin');
  const VMS_ONLY_ROLES=(typeof ROLES!=='undefined'?ROLES:['Super Admin','VMS Admin','Plant Head','Trip Booking User','KAP Security','Material Receiver','Trip Approver','Vendor']);
  const SEC_ROLES=['Guard','Viewer'];
  function _hasAnyRoleFor(appId){
    if(isSuperAdmin) return true;
    if(appId==='vms') return (CU.roles||[]).some(r=>VMS_ONLY_ROLES.indexOf(r)>=0);
    if(appId==='security') return (CU.roles||[]).some(r=>SEC_ROLES.indexOf(r)>=0);
    if(appId==='hwms') return ((CU.hwmsRoles)||[]).length>0;
    if(appId==='hrms') return ((CU.hrmsRoles)||[]).length>0;
    if(appId==='maintenance') return ((CU.mttsRoles)||[]).length>0;
    return false; // Apps without a role model (review) hidden unless Super Admin.
  }
  // Role-based visibility is authoritative. If the user also has an explicit
  // user.apps list, it acts as an extra restriction; but a missing/empty
  // apps list does NOT hide tiles — legacy users and users whose apps list
  // wasn't re-saved after a role change would otherwise lose access.
  var _userApps=(CU.apps||[]);
  function _appsAllows(appId){
    if(isSuperAdmin) return true;
    if(!_userApps.length) return true; // no explicit restriction
    return _userApps.indexOf(appId)>=0;
  }
  const visibleApps=PORTAL_APPS.filter(a=>(_appsAllows(a.id)&&_hasAnyRoleFor(a.id))||(APP_ACTIVE[a.id]===false&&isSuperAdmin));
  if(!visibleApps.length){
    grid.innerHTML='<div style="padding:40px;text-align:center;color:var(--text3);font-size:14px;grid-column:1/-1">No apps assigned yet. Contact your admin to request access.</div>';
    return;
  }
  grid.innerHTML=visibleApps.map(app=>{
    const file=APP_FILES[app.id]||null;
    const active=APP_ACTIVE[app.id]||false;
    const enabled=active; // tile is visible only when user has role, so effectively enabled when active
    return `<div class="app-card${enabled?'':' disabled'}" ${enabled?`onclick="openApp('${app.id}','${file}')"`:''}><span class="app-icon">${app.icon}</span><div class="app-label">${app.label}</div><div class="app-full">${app.full}</div><span class="app-badge ${active?'active':'coming'}">${active?'Active':'Coming Soon'}</span></div>`;
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

// ═══ USER MANAGEMENT (table, modal, save, delete, reset) ════════════════
// Sort state for the users table — clicking a sortable header toggles
// ASC ↔ DESC; clicking a different column resets to ASC.
var _puSortKey='fullName';
var _puSortDir=1; // 1 = asc, -1 = desc
function puSort(key){
  if(_puSortKey===key) _puSortDir=-_puSortDir;
  else { _puSortKey=key; _puSortDir=1; }
  renderPortalUsers();
}
function _puSortVal(u,key){
  if(key==='fullName') return String(u.fullName||u.name||'').toLowerCase();
  if(key==='name') return String(u.name||'').toLowerCase();
  if(key==='location'){
    var loc=byId(DB.locations||[],u.plant);
    return String(loc?loc.name:(u.plant||'')).toLowerCase();
  }
  return '';
}
function _puRenderHeader(){
  // Render the thead with sortable indicators on Full Name / Username /
  // Location. Other cells stay plain.
  var arrow=function(key){
    if(_puSortKey!==key) return '<span class="puSortIcon">↕</span>';
    return '<span class="puSortIcon">'+(_puSortDir>0?'↑':'↓')+'</span>';
  };
  var sortCls=function(key){return _puSortKey===key?'puSortable is-sorted':'puSortable';};
  return '<tr>'+
    '<th></th>'+
    '<th class="'+sortCls('fullName')+'" onclick="puSort(\'fullName\')">Full Name '+arrow('fullName')+'</th>'+
    '<th class="'+sortCls('name')+'" onclick="puSort(\'name\')">Username '+arrow('name')+'</th>'+
    '<th class="'+sortCls('location')+'" onclick="puSort(\'location\')">Location '+arrow('location')+'</th>'+
    '<th>Apps &amp; Roles</th>'+
    '<th>Reset Password</th>'+
  '</tr>';
}
function renderPortalUsers(){
  const srch=(document.getElementById('puSearch')?.value||'').toLowerCase();
  const showI=document.getElementById('puShowInactive')?.checked;
  const isSA=CU?.roles?.includes('Super Admin');
  let rows=[...DB.users].filter(u=>isSA||!(u.roles||[]).includes('Super Admin'));
  if(srch) rows=rows.filter(u=>(u.fullName||'').toLowerCase().includes(srch)||(u.name||'').toLowerCase().includes(srch));
  if(!showI) rows=rows.filter(u=>!u.inactive);
  rows.sort((a,b)=>{
    // Natural sort — treat embedded digits as numbers so user2 < user10
    // and "Driver 9" < "Driver 10". Applies to all sortable columns.
    var av=_puSortVal(a,_puSortKey),bv=_puSortVal(b,_puSortKey);
    return av.localeCompare(bv,undefined,{numeric:true,sensitivity:'base'})*_puSortDir;
  });
  // Re-render the thead so the sort indicators reflect current state.
  var theadEl=document.querySelector('#usersSection .puTableWrap thead');
  if(theadEl) theadEl.innerHTML=_puRenderHeader();
  document.getElementById('puBody').innerHTML=rows.length?rows.map(u=>{
    const loc=byId(DB.locations||[],u.plant);
    const locBadge=loc?(loc.colour?`<span style="background:${loc.colour};color:${colourContrast(loc.colour)};padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px">${loc.name}</span>`:loc.name):(u.plant||'—');
    const iBadge=u.inactive?'<span style="font-size:9px;font-weight:700;background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;margin-left:5px">Inactive</span>':'';
    // Combined Apps & Roles cell. Platform roles render as a purple top
    // strip (shared across the whole portal); each app the user has
    // access to renders as one line: app icon + label, then its roles.
    const PLAT=(typeof PLATFORM_ROLES!=='undefined'?PLATFORM_ROLES:['Super Admin','Admin','Read Only']);
    const uRoles=(u.roles||[]);
    const uPlat=uRoles.filter(r=>PLAT.indexOf(r)>=0&&(r!=='Super Admin'||isSA));
    const uVms=uRoles.filter(r=>PLAT.indexOf(r)<0);
    const platBadgeMap={'Super Admin':'⭐ SA','Admin':'🛡 Admin','Read Only':'👁 Read Only'};
    const platHtml=uPlat.length?`<div style="margin-bottom:4px">${uPlat.map(r=>`<span class="badge" style="background:#ede9fe;color:#7c3aed;margin-right:3px">${platBadgeMap[r]||r}</span>`).join('')}</div>`:'';
    const appRolesByApp={vms:uVms,hwms:u.hwmsRoles||[],hrms:u.hrmsRoles||[],maintenance:u.mttsRoles||[]};
    const appBadgeStyle={vms:'background:#f0fafa;color:#2a9aa0;border:1px solid #b3dfe0',hwms:'background:rgba(139,92,246,.12);color:#7c3aed;border:1px solid rgba(139,92,246,.3)',hrms:'background:rgba(34,197,94,.12);color:#16a34a;border:1px solid rgba(34,197,94,.3)',maintenance:'background:rgba(245,158,11,.12);color:#b45309;border:1px solid rgba(245,158,11,.3)'};
    const appLines=(u.apps||[]).map(id=>{
      const a=PORTAL_APPS.find(x=>x.id===id);if(!a) return '';
      const rs=appRolesByApp[id]||[];
      const tagStyle=appBadgeStyle[id]||appBadgeStyle.vms;
      const appTag=`<span style="font-size:10px;${tagStyle};padding:2px 7px;border-radius:4px;font-weight:700;letter-spacing:.3px;margin-right:6px;white-space:nowrap">${a.icon} ${a.label}</span>`;
      const roleTags=rs.length?rs.map(r=>`<span class="badge" style="background:#f8fafc;color:var(--text2);border:1px solid var(--border);margin-right:3px;font-weight:600">${r}</span>`).join(''):`<span style="font-size:11px;color:var(--text3);font-style:italic">no role</span>`;
      return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px;margin-bottom:3px">${appTag}${roleTags}</div>`;
    }).filter(Boolean).join('');
    const roleBadges=(platHtml+appLines)||'<span style="font-size:11px;color:var(--text3);font-style:italic">No apps assigned</span>';
    // Clicking anywhere on the row opens the user form. Per-button
    // onclicks call event.stopPropagation() so they don't double-fire
    // the row handler.
    return `<tr class="clickable-row" onclick="puOpenModal('${u.id}')" style="cursor:pointer${u.inactive?';opacity:.55':''}">
      <td>${u.photo?`<img src="${u.photo}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid var(--border2)">`:'<div style="width:32px;height:32px;border-radius:50%;background:var(--surface2);border:2px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--text3)">👤</div>'}</td>
      <td style="font-weight:600">${u.fullName||'—'}${iBadge}</td>
      <td style="font-family:var(--mono);font-size:12px">${u.name}</td>
      <td>${locBadge}</td><td>${roleBadges}</td>
      <td style="white-space:nowrap;text-align:center">${!(u.roles||[]).includes('Super Admin')?`<button class="action-btn" onclick="event.stopPropagation();puResetPwd('${u.id}')" title="Reset Password" style="color:#f59e0b">🔑</button>`:`<span style="color:var(--text3);font-size:11px;font-style:italic">—</span>`}</td>
    </tr>`;
  }).join(''):'<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text3)">No users found</td></tr>';
}

// ── User modal ──────────────────────────────────────────────────────────────
function puOpenModal(id){
  const u=id?byId(DB.users,id):null;
  document.getElementById('muId').value=id||'';
  document.getElementById('muName').value=u?.name||'';
  // Password field removed — new users get _PORTAL_RESET_PWD automatically.
  document.getElementById('muFull').value=u?.fullName||'';
  document.getElementById('muMobile').value=u?.mobile||'';
  document.getElementById('muTitle').textContent=id?'Edit User':'Add User';
  // Location dropdown
  const locs=(DB.locations||[]).filter(l=>l&&l.type==='KAP'&&!l.inactive).sort((a,b)=>a.name.localeCompare(b.name));
  document.getElementById('muLoc').innerHTML='<option value="">-- Select --</option>'+locs.map(l=>`<option value="${l.id}"${l.id===u?.plant?' selected':''}>${l.name}</option>`).join('');
  // Apps
  const ua=u?.apps||(u?['vms']:[]);
  document.getElementById('muApps').innerHTML=PORTAL_APPS.map(a=>{const c=ua.includes(a.id);return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:${c?'rgba(42,154,160,.07)':'var(--surface2)'};padding:4px 10px;border-radius:5px;border:1px solid ${c?'var(--accent)':'var(--border)'}"><input type="checkbox" class="muAppCb" value="${a.id}" ${c?'checked':''} style="width:auto" onchange="puAppChange(this)"> ${a.icon} ${a.label}</label>`}).join('');
  // Platform Access — visible / editable only when current user is Super
  // Admin. Stored alongside VMS roles in u.roles (no schema change).
  const isSA=CU?.roles?.includes('Super Admin');
  const platSection=document.getElementById('muPlatformRoles');
  if(platSection) platSection.style.display=isSA?'block':'none';
  const platBoxes=document.getElementById('muPlatformBoxes');
  if(platBoxes&&isSA){
    const pr=(typeof PLATFORM_ROLES!=='undefined'?PLATFORM_ROLES:['Super Admin','Admin','Read Only']);
    platBoxes.innerHTML=pr.map(r=>{
      const c=(u?.roles||[]).includes(r);
      const sa=r==='Super Admin';
      return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:rgba(124,58,237,.07);padding:4px 10px;border-radius:5px;border:1px solid ${c?'#7c3aed':'rgba(124,58,237,.3)'}"><input type="checkbox" class="muPlatCb" value="${r}" ${c?'checked':''} style="width:auto"> ${sa?'⭐ ':''}${r}</label>`;
    }).join('');
  } else if(platBoxes){
    platBoxes.innerHTML='';
  }
  // VMS roles — Super Admin no longer appears here (it's a Platform role).
  const vr=ROLES.filter(r=>r!=='Super Admin');
  document.getElementById('muVmsBoxes').innerHTML=vr.map(r=>{const c=(u?.roles||[]).includes(r);return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:var(--surface2);padding:4px 10px;border-radius:5px;border:1px solid ${c?'var(--accent)':'var(--border)'}"><input type="checkbox" class="muVmsCb" value="${r}" ${c?'checked':''} style="width:auto"> ${r}</label>`}).join('');
  // HWMS roles
  document.getElementById('muHwmsBoxes').innerHTML=HWMS_ROLES.map(r=>{const c=(u?.hwmsRoles||[]).includes(r);return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:rgba(139,92,246,.06);padding:4px 10px;border-radius:5px;border:1px solid ${c?'var(--purple)':'rgba(139,92,246,.25)'}"><input type="checkbox" class="muHwmsCb" value="${r}" ${c?'checked':''} style="width:auto"> ${r}</label>`}).join('');
  document.getElementById('muHrmsBoxes').innerHTML=(typeof HRMS_ROLES!=='undefined'?HRMS_ROLES:[]).map(r=>{const c=(u?.hrmsRoles||[]).includes(r);return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:rgba(34,197,94,.06);padding:4px 10px;border-radius:5px;border:1px solid ${c?'#16a34a':'rgba(34,197,94,.25)'}"><input type="checkbox" class="muHrmsCb" value="${r}" ${c?'checked':''} style="width:auto"> ${r}</label>`}).join('');
  document.getElementById('muMttsBoxes').innerHTML=(typeof MTTS_ROLES!=='undefined'?MTTS_ROLES:[]).map(r=>{const c=(u?.mttsRoles||[]).includes(r);return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:rgba(245,158,11,.07);padding:4px 10px;border-radius:5px;border:1px solid ${c?'#d97706':'rgba(245,158,11,.25)'}"><input type="checkbox" class="muMttsCb" value="${r}" ${c?'checked':''} style="width:auto"> ${r}</label>`}).join('');
  document.getElementById('muVmsRoles').style.display=ua.includes('vms')?'block':'none';
  document.getElementById('muHwmsRoles').style.display=ua.includes('hwms')?'block':'none';
  document.getElementById('muHrmsRoles').style.display=ua.includes('hrms')?'block':'none';
  document.getElementById('muMttsRoles').style.display=ua.includes('maintenance')?'block':'none';
  document.getElementById('muInactive').checked=u?.inactive===true;
  om('mUser');
}
function puAppChange(cb){
  cb.closest('label').style.background=cb.checked?'rgba(42,154,160,.07)':'var(--surface2)';
  cb.closest('label').style.borderColor=cb.checked?'var(--accent)':'var(--border)';
  const sel=[...document.querySelectorAll('.muAppCb:checked')].map(i=>i.value);
  document.getElementById('muVmsRoles').style.display=sel.includes('vms')?'block':'none';
  document.getElementById('muHwmsRoles').style.display=sel.includes('hwms')?'block':'none';
  document.getElementById('muHrmsRoles').style.display=sel.includes('hrms')?'block':'none';
  document.getElementById('muMttsRoles').style.display=sel.includes('maintenance')?'block':'none';
}

// ── Save user ───────────────────────────────────────────────────────────────
async function puSaveUser(){
  const id=document.getElementById('muId').value;
  const name=document.getElementById('muName').value.trim().toLowerCase().replace(/[\s!@#$%^&*()+=\[\]{};':"\\|,.<>\/?]/g,'');
  const plant=document.getElementById('muLoc').value;
  const fullName=document.getElementById('muFull').value.trim();
  const mobile=document.getElementById('muMobile').value;
  const apps=[...document.querySelectorAll('.muAppCb:checked')].map(i=>i.value);
  const vmsRoles=[...document.querySelectorAll('.muVmsCb:checked')].map(i=>i.value);
  // Platform roles only visible to Super Admin — for non-SA editors keep
  // whatever was previously on the user record so we don't accidentally
  // strip Super Admin / Admin from a colleague.
  const editingUser=document.getElementById('muId').value?byId(DB.users,document.getElementById('muId').value):null;
  const isSAEditor=CU?.roles?.includes('Super Admin');
  var platRoles;
  if(isSAEditor){
    platRoles=[...document.querySelectorAll('.muPlatCb:checked')].map(i=>i.value);
  } else {
    var prev=editingUser?.roles||[];
    var platSet=(typeof PLATFORM_ROLES!=='undefined'?PLATFORM_ROLES:['Super Admin','Admin','Read Only']);
    platRoles=prev.filter(r=>platSet.indexOf(r)>=0);
  }
  // u.roles carries platform + VMS roles in one column for now; the modal
  // splits them visually but they're persisted together.
  const roles=platRoles.concat(vmsRoles);
  const hwmsRoles=[...document.querySelectorAll('.muHwmsCb:checked')].map(i=>i.value);
  const hrmsRoles=[...document.querySelectorAll('.muHrmsCb:checked')].map(i=>i.value);
  const mttsRoles=[...document.querySelectorAll('.muMttsCb:checked')].map(i=>i.value);
  const inactive=document.getElementById('muInactive')?.checked===true;
  if(!name){modalErr('mUser','Username required');return}
  if(!plant){modalErr('mUser','Location required');return}
  if(!fullName){modalErr('mUser','Full name required');return}
  if(!apps.length){modalErr('mUser','Select at least one app');return}
  if(apps.includes('vms')&&!vmsRoles.length){modalErr('mUser','Select at least one VMS role');return}
  if(apps.includes('hwms')&&!hwmsRoles.length){modalErr('mUser','Select at least one HWMS role');return}
  if(apps.includes('hrms')&&!hrmsRoles.length){modalErr('mUser','Select at least one HRMS role');return}
  if(apps.includes('maintenance')&&!mttsRoles.length){modalErr('mUser','Select at least one MTTS role');return}
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
    // Edit: never touch password from this form. Password changes go
    // through Reset (Super Admin 🔑 button) or self-service login flow.
    const bak={...eu};Object.assign(eu,{name,plant,fullName,mobile,roles,hwmsRoles,hrmsRoles,mttsRoles,apps,inactive});
    if(!await _dbSave('users',eu)){Object.assign(eu,bak);return}
  } else {
    // New user: always assign the default password. User must change it
    // on first login (forced via password-strength check).
    const nu={id:'u'+uid(),name,plant,fullName,mobile,roles,hwmsRoles,hrmsRoles,mttsRoles,apps,inactive,photo:'',email:''};
    if(!await _dbSave('users',nu)) return;
    await _authSetPassword(nu.id,_PORTAL_RESET_PWD);
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
  var ok=await _authResetPassword(CU.id,u.id);
  if(!ok){notify('Failed to reset password',true);return;}
  notify('🔑 Password for "'+userName+'" reset to "Kappl@123".');
  renderPortalUsers();
}

// ═══ PROFILE ═════════════════════════════════════════════════════════════
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
  const pwdErrs=_pwdErrors(newPass);
  if(pwdErrs.length){_ppMsg('ppPassMsg','Password requires: '+pwdErrs.join(', '),false);return;}
  if(newPass!==confPass){_ppMsg('ppPassMsg','New passwords do not match',false);return;}
  // Server-side old password verification + hashed new password
  showSpinner('Changing password…');
  var ok=await _authChangePassword(CU.name,oldPass,newPass);
  hideSpinner();
  if(!ok){_ppMsg('ppPassMsg','Current password is incorrect',false);return;}
  // Re-login to get a new session token
  var result=await _authLogin(CU.name,newPass);
  if(result&&result.token){
    _sessionSet('kap_session_token',result.token);
    try{if(localStorage.getItem('kap_rm_token'))localStorage.setItem('kap_rm_token',result.token);}catch(e){}
  }
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

// ═══ LOGOUT / FORCE PASSWORD CHANGE ══════════════════════════════════════
// _PORTAL_RESET_PWD, _BUILD_VERSION, _isStrongPwd are in portal-logic.js
try{var _bv=document.getElementById('buildVersion');if(_bv)_bv.textContent='Build: '+_BUILD_VERSION;}catch(e){}
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
  if(newPwd===_PORTAL_RESET_PWD){showErr('Cannot use the default password. Please choose a different one.');return;}
  // Use the password from the login form (still available) as old password
  var oldPwd=document.getElementById('loginPass')?.value||_PORTAL_RESET_PWD;
  showSpinner('Updating password…');
  var ok=await _authChangePassword(CU.name,oldPwd,newPwd);
  hideSpinner();
  if(!ok){showErr('Failed to change password. Try again.');return;}
  // Re-login with new password to get fresh token
  var result=await _authLogin(CU.name,newPwd);
  if(result&&result.token){
    _sessionSet('kap_session_token',result.token);
    try{if(localStorage.getItem('kap_rm_token'))localStorage.setItem('kap_rm_token',result.token);}catch(e){}
    try{localStorage.setItem('kap_current_user',JSON.stringify(result.user));}catch(e){}
  }
  cm('mForcePass');
  notify('🔐 Password updated successfully!');
  showPortal();
}
function _forcePassSignOut(){
  cm('mForcePass');
  doLogout();
}

function doLogout(){
  CU=null;_sessionDel('kap_session_user');_sessionDel('kap_session_token');
  try{localStorage.removeItem('kap_rm_user');localStorage.removeItem('kap_rm_token');localStorage.removeItem('kap_current_user');}catch(e){console.warn('[doLogout] ls err:',e);}
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

// ═══ BOOT / INITIALISATION ═══════════════════════════════════════════════
async function _portalBoot(){
  // Portal only needs users and locations — not VMS/HWMS/Security operational tables
  if(typeof _APP_TABLES!=='undefined') _APP_TABLES=['users','locations','hrmsSettings'];
  // Check session
  var su,sp2;
  try{ su=_sessionGet('kap_session_user'); sp2=_sessionGet('kap_session_token'); }catch(e){}
  if(!su||!sp2){
    try{ su=localStorage.getItem('kap_rm_user'); sp2=localStorage.getItem('kap_rm_token'); }catch(e){}
    if(su&&sp2){ _sessionSet('kap_session_user',su); _sessionSet('kap_session_token',sp2); }
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
    // Restore session from cache (synchronous — no RPC wait)
    var user=null;
    try{
      var _cu=localStorage.getItem('kap_current_user');
      if(_cu) user=JSON.parse(_cu);
      if(!user||user.name.toLowerCase()!==su) user=null;
    }catch(e){ user=null; }
    // Prefer the live DB record over the cached one — admin may have
    // updated roles/apps since this session was created.
    var freshU=(DB.users||[]).find(function(u){return u&&u.name&&u.name.toLowerCase()===su;});
    if(freshU) user=freshU;
    if(user&&!user.inactive){
      CU=user; _enrichCU();
      _portalLoggedIn=true;
      showPortal();
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

// ═══ ROLE SETTINGS — Multi-module Role & Permission Management ═══════════
var _permActiveModule='';
var _permActiveRole='';


// _PERM_ROLE_FIELDS, permLevel, permCanView, permCanAct, _permLoadData,
// _permKeyKind are all defined in common.js. Portal reuses those globals.

// Module → default roles from constants (Portal editor-only helper)
function _permGetDefaultRoles(mod){
  if(mod==='HRMS') return typeof HRMS_ROLES!=='undefined'?HRMS_ROLES.slice():['Super Admin','HR Manager','HR Admin','Employee'];
  if(mod==='VMS') return typeof ROLES!=='undefined'?ROLES.slice():['Super Admin','VMS Admin','Plant Head','Trip Booking User','KAP Security','Material Receiver','Trip Approver','Vendor'];
  if(mod==='HWMS') return typeof HWMS_ROLES!=='undefined'?HWMS_ROLES.slice():['Super Admin','HWMS Admin','Supplier','WH Admin','WH User','Buyer','Buyer Coordinator'];
  if(mod==='Security') return ['Super Admin','Guard','Viewer'];
  return ['Super Admin'];
}

function _permModuleData(mod){
  var all=_permLoadData();
  if(!all[mod]) all[mod]={roles:[],permissions:{}};
  var md=all[mod];
  // Auto-merge: ensure all default/constant roles exist in the saved list
  var defaults=_permGetDefaultRoles(mod);
  defaults.forEach(function(r){if(md.roles.indexOf(r)<0) md.roles.push(r);});
  // Also scan users for any custom roles assigned but not yet in the role list.
  // Filter by _PERM_MODULE_ROLES so modules that share a user field (VMS and
  // Security both use user.roles) don't leak each other's roles into the
  // Role Settings editor.
  var field=_PERM_ROLE_FIELDS[mod];
  var allow=(typeof _PERM_MODULE_ROLES!=='undefined')&&_PERM_MODULE_ROLES[mod];
  if(field){
    (DB.users||[]).forEach(function(u){
      var userRoles=u[field]||[];
      userRoles.forEach(function(r){
        if(!r||md.roles.indexOf(r)>=0) return;
        if(allow&&allow.indexOf(r)<0) return;
        md.roles.push(r);
      });
    });
  }
  // Drop any previously-saved cross-module roles that no longer belong here
  if(allow){
    md.roles=md.roles.filter(function(r){return allow.indexOf(r)>=0;});
  }
  // Ensure Super Admin is always first
  var saIdx=md.roles.indexOf('Super Admin');
  if(saIdx>0){md.roles.splice(saIdx,1);md.roles.unshift('Super Admin');}
  else if(saIdx<0) md.roles.unshift('Super Admin');
  return md;
}

function renderPermissions(){
  var tabs=document.getElementById('permModuleTabs');
  if(!tabs) return;
  var modules=Object.keys(_PERM_KEYS);
  if(!_permActiveModule) _permActiveModule=modules[0];
  tabs.innerHTML=modules.map(function(m){
    var active=m===_permActiveModule;
    return '<div onclick="_permSelectModule(\''+m+'\')" style="padding:8px 18px;font-size:13px;font-weight:'+(active?'800':'600')+';cursor:pointer;border-bottom:3px solid '+(active?'var(--accent)':'transparent')+';color:'+(active?'var(--accent)':'var(--text3)')+';transition:all .15s">'+m+'</div>';
  }).join('');
  _permRenderRoles();
}

function _permSelectModule(mod){
  _permActiveModule=mod;
  _permActiveRole='';
  renderPermissions();
}

function _permRenderRoles(){
  var el=document.getElementById('permRoleList');
  var header=document.getElementById('permHeader');
  var body=document.getElementById('permBody');
  if(!el) return;
  var md=_permModuleData(_permActiveModule);
  var roles=md.roles||[];
  var h='';
  roles.forEach(function(r){
    var isSA=r==='Super Admin';
    var active=r===_permActiveRole;
    h+='<div onclick="_permSelectRole(\''+r.replace(/'/g,"\\'")+'\')" style="display:flex;align-items:center;gap:6px;padding:8px 10px;margin-bottom:4px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:'+(active?'800':'600')+';background:'+(active?'var(--accent-light)':'#fff')+';border:1.5px solid '+(active?'var(--accent)':'var(--border)')+';color:'+(active?'var(--accent)':'var(--text)')+'">';
    h+='<span style="flex:1">'+r+'</span>';
    if(isSA) h+='<span style="font-size:9px;background:#dcfce7;color:#15803d;padding:1px 6px;border-radius:3px;font-weight:700">Full Access</span>';
    else if(!isSA) h+='<span onclick="event.stopPropagation();_permDeleteRole(\''+r.replace(/'/g,"\\'")+'\')" style="font-size:11px;color:#dc2626;cursor:pointer;opacity:0.5" title="Delete role">✕</span>';
    h+='</div>';
  });
  el.innerHTML=h;
  if(_permActiveRole) _permRenderPerms();
  else{
    if(header) header.innerHTML='<div style="font-size:13px;color:var(--text3)">← Select a role to configure permissions</div>';
    if(body) body.innerHTML='';
  }
}

function _permSelectRole(role){
  _permActiveRole=role;
  _permRenderRoles();
}

// Classify a perm key: 'pageTab' (tri-state page/tab) or 'action' (checkbox).
function _permKeyKind(key){
  return /^(page|tab)\./.test(key)?'pageTab':'action';
}
// Read tri-state level for a page/tab key from role's perms.
// Backward-compatible: rolePerms[key]===true → 'full' (legacy boolean). New value 'view' → 'view'.
function _permReadLevel(rolePerms,key){
  var v=rolePerms[key];
  if(v===true||v==='full') return 'full';
  if(v==='view') return 'view';
  return 'none';
}

// Determine indent depth for a permission key:
//   0 = page        (top-level umbrella)
//   1 = tab         (sub-umbrella)
//   2 = sub-tab     (settings.X / att.X / masters.X / etc. — umbrella if actions follow)
//   3 = action      (leaf)
function _permDepth(key){
  if(/^page\./.test(key)) return 0;
  if(/^tab\./.test(key)) return 1;
  if(/^action\./.test(key)) return 3;
  return 2;
}
// Items "under" this one: subsequent entries at greater depth, stopping at
// the next item of same or shallower depth. Based on declared order within
// the group, which already reflects the intended hierarchy.
function _permScopedChildren(items,index){
  var parentDepth=_permDepth(items[index].key);
  var kids=[];
  for(var i=index+1;i<items.length;i++){
    var d=_permDepth(items[i].key);
    if(d<=parentDepth) break;
    kids.push(items[i]);
  }
  return kids;
}
// Is this item an umbrella (no tri-state of its own, auto-derived)?
//   Must have scoped children.
//   page.* additionally requires it to be the sole page.* in the group —
//   otherwise groups like "📂 Masters" (seven page.* siblings + one shared
//   masters.edit action) would wrongly treat the last page as a parent.
function _permIsUmbrella(items,index){
  var item=items[index];
  var kids=_permScopedChildren(items,index);
  if(!kids.length) return false;
  if(/^page\./.test(item.key)){
    var pagesInGroup=items.filter(function(it){return /^page\./.test(it.key);});
    if(pagesInGroup.length>1) return false;
  }
  return true;
}

function _permRenderPerms(){
  var header=document.getElementById('permHeader');
  var body=document.getElementById('permBody');
  if(!header||!body) return;
  var role=_permActiveRole;
  var isSA=role==='Super Admin';
  var md=_permModuleData(_permActiveModule);
  var rolePerms=(md.permissions&&md.permissions[role])||{};
  var keys=_PERM_KEYS[_permActiveModule]||[];

  header.innerHTML='<div style="font-size:15px;font-weight:900;color:var(--accent)">'+role+'</div>'
    +'<span style="font-size:11px;color:var(--text3)">'+_permActiveModule+'</span>'
    +(isSA?'<span style="font-size:11px;background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:4px;font-weight:700">Full access — cannot be modified</span>':'')
    +(!isSA?'<button onclick="_permSaveRole()" style="margin-left:auto;font-size:12px;padding:5px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer">💾 Save</button>':'');

  if(isSA){body.innerHTML='<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">Super Admin has unrestricted access to all features. No configuration needed.</div>';return;}

  // Group keys (preserving declared order within each group)
  var groups={};var groupOrder=[];
  keys.forEach(function(k){
    if(!groups[k.group]){groups[k.group]=[];groupOrder.push(k.group);}
    groups[k.group].push(k);
  });

  // Tri-state segmented control renderer — used for every permission entry.
  function levelSeg(k,currentLevel){
    var levels=[
      {v:'none',lbl:'None',bg:'#f3f4f6',fg:'#6b7280',activeBg:'#9ca3af',activeFg:'#fff'},
      {v:'view',lbl:'View',bg:'#eff6ff',fg:'#1d4ed8',activeBg:'#2563eb',activeFg:'#fff'},
      {v:'full',lbl:'Full',bg:'#ecfdf5',fg:'#047857',activeBg:'#16a34a',activeFg:'#fff'}
    ];
    var out='<div data-perm-ptkey="'+k.key+'" data-level="'+currentLevel+'" style="display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;flex-shrink:0">';
    levels.forEach(function(L){
      var on=(L.v===currentLevel);
      out+='<button type="button" onclick="_permSetLevel(\''+k.key+'\',\''+L.v+'\')" '
        +'style="font-size:10px;font-weight:800;padding:3px 9px;border:none;cursor:pointer;'
        +'background:'+(on?L.activeBg:L.bg)+';color:'+(on?L.activeFg:L.fg)+';'
        +'transition:all .1s">'+L.lbl+'</button>';
    });
    out+='</div>';
    return out;
  }

  var h='';
  groupOrder.forEach(function(g){
    var items=groups[g];
    h+='<div style="margin-bottom:14px" data-perm-group="'+g.replace(/"/g,'&quot;')+'">';
    h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding-bottom:4px;border-bottom:1.5px solid var(--border)">';
    h+='<span style="font-size:13px;font-weight:900;color:var(--text)">'+g+'</span>';
    h+='</div>';
    h+='<div style="display:flex;flex-direction:column;gap:4px">';
    items.forEach(function(k,idx){
      var depth=_permDepth(k.key);
      var indent=depth*18; // slightly tighter now that we have 4 levels (0–3)
      var lvl=_permReadLevel(rolePerms,k.key);
      var icon=depth===0?'📄':depth===1?'📁':depth===2?'└─':'•';
      var fontWeight=depth<=1?'700':'500';
      var labelColor=depth===0?'var(--text)':depth===1?'var(--text)':depth===2?'var(--text2)':'var(--text3)';
      var isUmbrella=_permIsUmbrella(items,idx);
      // Fixed-width label (indent inside padding) so every tri-state lines up.
      h+='<div style="display:flex;align-items:center;gap:10px;padding:3px 0">';
      h+='<span style="font-size:'+(depth<=1?12:11)+'px;color:'+labelColor+';font-weight:'+fontWeight+';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:280px;padding-left:'+indent+'px;flex-shrink:0;box-sizing:border-box">';
      h+='<span style="opacity:0.5;margin-right:4px">'+icon+'</span>'+k.label;
      h+='</span>';
      if(isUmbrella){
        h+='<span data-perm-umbrella="'+k.key+'" data-perm-group-id="'+g.replace(/"/g,'&quot;')+'" data-perm-index="'+idx+'" style="font-size:10px;color:var(--text3);font-style:italic">auto (from items below)</span>';
      } else {
        h+=levelSeg(k,lvl);
      }
      h+='</div>';
    });
    h+='</div>';
    h+='</div>';
  });
  body.innerHTML=h;
}

// Click a segment in the tri-state selector. Updates just the DOM for this
// one entry so other unsaved rows aren't disturbed.
function _permSetLevel(pageTabKey,level){
  var body=document.getElementById('permBody');if(!body) return;
  var seg=body.querySelector('[data-perm-ptkey="'+pageTabKey+'"]');
  if(!seg) return;
  seg.setAttribute('data-level',level);
  var btns=seg.querySelectorAll('button');
  var stylesByLvl={
    none:{bg:'#f3f4f6',fg:'#6b7280',activeBg:'#9ca3af',activeFg:'#fff'},
    view:{bg:'#eff6ff',fg:'#1d4ed8',activeBg:'#2563eb',activeFg:'#fff'},
    full:{bg:'#ecfdf5',fg:'#047857',activeBg:'#16a34a',activeFg:'#fff'}
  };
  var order=['none','view','full'];
  btns.forEach(function(btn,i){
    var lv=order[i];var s=stylesByLvl[lv];var on=(lv===level);
    btn.style.background=on?s.activeBg:s.bg;
    btn.style.color=on?s.activeFg:s.fg;
  });
}

// Legacy no-op shims — the UI no longer renders checkboxes.
function _permItemChange(){}
function _permToggleGroup(){}

function _permAddRole(){
  var name=prompt('Enter new role name for '+_permActiveModule+':');
  if(!name||!name.trim()) return;
  name=name.trim();
  var md=_permModuleData(_permActiveModule);
  if(md.roles.indexOf(name)>=0){notify('Role "'+name+'" already exists',true);return;}
  md.roles.push(name);
  // Also update the constant arrays so user management picks them up
  if(_permActiveModule==='HRMS'&&typeof HRMS_ROLES!=='undefined'&&HRMS_ROLES.indexOf(name)<0) HRMS_ROLES.push(name);
  if(_permActiveModule==='HWMS'&&typeof HWMS_ROLES!=='undefined'&&HWMS_ROLES.indexOf(name)<0) HWMS_ROLES.push(name);
  _permActiveRole=name;
  _permSaveData(md);
}

function _permDeleteRole(role){
  if(role==='Super Admin'){notify('Cannot delete Super Admin',true);return;}
  if(!confirm('Delete role "'+role+'" from '+_permActiveModule+'?')) return;
  var md=_permModuleData(_permActiveModule);
  md.roles=md.roles.filter(function(r){return r!==role;});
  if(md.permissions) delete md.permissions[role];
  if(_permActiveRole===role) _permActiveRole='';
  _permSaveData(md);
}

async function _permSaveRole(){
  var role=_permActiveRole;if(!role||role==='Super Admin') return;
  var body=document.getElementById('permBody');if(!body) return;
  var perms={};
  // Every visible tri-state control (pages/tabs/sub-tabs/actions without
  // an umbrella override). Persist uniformly:
  //   Full → true,  View → 'view',  None → key omitted
  body.querySelectorAll('[data-perm-ptkey]').forEach(function(seg){
    var key=seg.getAttribute('data-perm-ptkey');
    var lvl=seg.getAttribute('data-level')||'none';
    if(lvl==='full') perms[key]=true;
    else if(lvl==='view') perms[key]='view';
    // None: key omitted — runtime falls through to role defaults for that key
  });
  // Umbrella items (no visible control). Level is auto-computed from the
  // SCOPED children — items immediately nested under this umbrella in
  // declared order, stopping at the next sibling at same-or-shallower depth.
  // This makes e.g. tab.kap.exit inherit max(recordGateExit, recordEmptyExit)
  // without accidentally absorbing tab.kap.entry's actions.
  var keys=_PERM_KEYS[_permActiveModule]||[];
  var groupsByName={};
  keys.forEach(function(k){(groupsByName[k.group]=groupsByName[k.group]||[]).push(k);});
  // Walk from deepest to shallowest so children umbrellas settle first,
  // then their parents see those rolled-up values.
  body.querySelectorAll('[data-perm-umbrella]').forEach(function(el){
    el._idxNum=parseInt(el.getAttribute('data-perm-index')||'0',10);
  });
  var umbEls=[].slice.call(body.querySelectorAll('[data-perm-umbrella]'));
  umbEls.sort(function(a,b){
    var ga=a.getAttribute('data-perm-group-id'),gb=b.getAttribute('data-perm-group-id');
    if(ga!==gb) return 0;
    return b._idxNum-a._idxNum; // later index first → deeper umbrellas resolve first
  });
  umbEls.forEach(function(el){
    var umbKey=el.getAttribute('data-perm-umbrella');
    var groupName=el.getAttribute('data-perm-group-id');
    var items=groupsByName[groupName]||[];
    var idx=items.findIndex(function(k){return k.key===umbKey;});
    if(idx<0) return;
    var kids=_permScopedChildren(items,idx);
    var best='none';
    kids.forEach(function(c){
      var v=perms[c.key];
      if(v===true||v==='full') best='full';
      else if(v==='view'&&best!=='full') best='view';
    });
    if(best==='full') perms[umbKey]=true;
    else if(best==='view') perms[umbKey]='view';
    // umbrella: none ⇒ omit (no children granted)
  });
  var md=_permModuleData(_permActiveModule);
  if(!md.permissions) md.permissions={};
  md.permissions[role]=perms;
  await _permSaveData(md);
  notify('✓ Permissions saved for '+role+' ('+_permActiveModule+')');
}

async function _permSaveData(md){
  var all=_permLoadData();
  all[_permActiveModule]=md;
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='rolePermissions';});
  if(!rec){
    rec={id:'hs_rolePermissions',key:'rolePermissions',data:{}};
    if(!DB.hrmsSettings) DB.hrmsSettings=[];
    DB.hrmsSettings.push(rec);
  }
  rec.data=all;
  showSpinner('Saving…');
  await _dbSave('hrmsSettings',rec);
  hideSpinner();
  _permRenderRoles();
}
