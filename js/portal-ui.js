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
    if(typeof _migrateStep3Skip==='function') _migrateStep3Skip(); if(typeof _migrateStep4Skip==='function') _migrateStep4Skip();
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
  if(label) label.textContent=loading?'Connecting to database…':'Connected to Database Successfully';
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
  var _pp=document.getElementById('portalPage');
  _pp.style.display='block';
  // Sidebar visible by default on desktop. Mobile keeps its slide-in
  // behaviour — the .open class is added/removed via the hamburger.
  _pp.classList.remove('portal-sb-hidden');
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
  var isHrAdmin=(CU.hrmsRoles||[]).indexOf('HRMS Admin')>=0;
  var isMttsAdmin=(CU.mttsRoles||[]).indexOf('MTTS Admin')>=0;
  var canManageUsers=isSuper||isAdmin||isVmsAdmin||isHwmsAdmin||isHrAdmin||isMttsAdmin;
  var ut=document.getElementById('usersTab'); if(ut) ut.style.display=canManageUsers?'':'none';
  var psU=document.getElementById('psNavUsers');if(psU)psU.style.display=canManageUsers?'':'none';
  var psDb=document.getElementById('psNavDbstorage');if(psDb)psDb.style.display=(isSuper||isHwmsAdmin)?'':'none';
  var psPerm=document.getElementById('psNavPermissions');if(psPerm)psPerm.style.display=isSuper?'':'none';
  // V53 — Backup nav is Super-Admin only.
  var psBk=document.getElementById('psNavBackup');if(psBk)psBk.style.display=isSuper?'':'none';
  // Sidebar user count
  var uc=document.getElementById('pSideUserCount');if(uc)uc.textContent=(DB.users||[]).length;
  renderAppGrid();
  // One-time housekeeping: backfill users.fullName from
  // hrmsEmployees.empCode for legacy numeric usernames whose record
  // pre-dates the modal's auto-fill. Idempotent + privilege-gated.
  setTimeout(function(){try{_repairUsernamesFromHrms();}catch(_){}},1500);
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
  // Use display:flex on the permissions tab so the body.tab-permissions
  // flex chain engages — inline display:block has higher specificity
  // than the CSS rule and would otherwise hide the chain.
  if(permSec) permSec.style.display=tab==='permissions'?'flex':'none';
  document.getElementById('dbStorageSection').style.display=tab==='dbstorage'?'block':'none';
  var _bkSec=document.getElementById('backupSection');if(_bkSec)_bkSec.style.display=tab==='backup'?'block':'none';
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
  var _isHrAdmin=CU&&(CU.hrmsRoles||[]).indexOf('HRMS Admin')>=0;
  var _isMttsAdmin=CU&&(CU.mttsRoles||[]).indexOf('MTTS Admin')>=0;
  var _canUsers=_isSA||_isAdmin||_isVmsAdmin||_isHwmsAdmin||_isHrAdmin||_isMttsAdmin;
  var _canDb=_isSA||_isAdmin||_isHwmsAdmin;
  if(tab==='users'&&!_canUsers){showTab('apps');return;}
  if(tab==='permissions'&&!_isSA){showTab('apps');return;}
  if(tab==='dbstorage'&&!_canDb){showTab('apps');return;}
  if(tab==='backup'&&!_isSA){showTab('apps');return;}
  // Users tab AND permissions tab both use a viewport-locked, contained-
  // scroll layout. Body classes drive the CSS flex chain.
  document.body.classList.toggle('tab-users',tab==='users');
  document.body.classList.toggle('tab-permissions',tab==='permissions');
  var _pp=document.getElementById('portalPage');
  if(_pp) _pp.style.display=(tab==='users'||tab==='permissions')?'flex':'block';
  // Page title routing:
  //   Apps    → topbar empty, welcome heading on the page itself.
  //   others  → topbar shows the page title, welcome heading hidden.
  //   permissions → topbar shows the live Module · Role (handled by
  //                 _permUpdateTitleBar after this block).
  var _wm=document.getElementById('welcomeMsg');
  var _ws=document.getElementById('welcomeSub');
  var _tw=document.getElementById('portalWelcomeWrap')||document.querySelector('.portal-welcome');
  var _ctxLbl=document.getElementById('portalTopbarContext');
  var _tabHeads={
    apps:        {h:CU?('Welcome, '+(CU.fullName||CU.name)):'Welcome', s:'Select an application to get started'},
    users:       {h:'👥 User Management',  s:'Manage users, app access and roles'},
    profile:     {h:'👤 My Profile',       s:'Update your account details'},
    permissions: {h:'🔐 Access Management', s:''},
    dbstorage:   {h:'📊 DB Storage',       s:'Database tables and storage usage'},
    backup:      {h:'💾 Backup',           s:'Download an Excel backup per app'}
  };
  var _th=_tabHeads[tab]||_tabHeads.apps;
  if(tab==='apps'){
    if(_tw) _tw.style.display='';
    if(_wm) _wm.textContent=_th.h;
    if(_ws) _ws.textContent=_th.s;
    if(_ctxLbl){ _ctxLbl.textContent=''; _ctxLbl.style.display='none'; }
  } else {
    if(_tw) _tw.style.display='none';
    if(_ctxLbl){ _ctxLbl.textContent=_th.h; _ctxLbl.style.display='inline-block'; }
  }
  if(tab==='users') renderPortalUsers();
  if(tab==='profile') ppLoadProfile();
  if(tab==='permissions') renderPermissions();
  if(tab==='dbstorage') renderPortalDbStorage();
  if(tab==='backup') renderPortalBackup();
}

// Title bar for Access Management is fixed at "🔐 Access Management" —
// the live "Module · Role" context used to live here, but that confused
// the page-title contract. Kept as a no-op so existing call sites don't
// break.
function _permUpdateTitleBar(){}

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
    if(_userApps.indexOf(appId)>=0) return true;
    // V2 — Module-admin role implies app access even when the user's
    // explicit apps[] list doesn't include the app. Prevents an admin
    // role from being silently shadowed by a stale apps-list entry.
    if(appId==='maintenance' && (CU.mttsRoles||[]).some(function(r){return r==='MTTS Admin'||r==='Maintenance Manager';})) return true;
    if(appId==='hrms' && (CU.hrmsRoles||[]).indexOf('HRMS Admin')>=0) return true;
    if(appId==='hwms' && (CU.hwmsRoles||[]).indexOf('HWMS Admin')>=0) return true;
    return false;
  }
  // V4 — Diagnostic: log per-app visibility for the current user so we
  // can see which gate is hiding the MTTS / other tiles.
  try{
    var _diag=PORTAL_APPS.map(function(a){return a.id+'(role='+_hasAnyRoleFor(a.id)+',apps='+_appsAllows(a.id)+')';}).join(' ');
    console.log('[portal appGrid] user='+(CU&&CU.name)+' isSA='+isSuperAdmin+' mtts='+JSON.stringify(CU&&CU.mttsRoles||[])+' apps='+JSON.stringify(CU&&CU.apps||[])+' tiles='+_diag);
  }catch(_){}
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
  // V5 — Diagnostic: confirm click reaches openApp.
  try{ console.log('[openApp] id='+id+' file='+file+' preFetchDone='+_portalPreFetchDone+' sbReady='+_sbReady); }catch(_){}
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

// One-time repair: for every user whose `name` (username) is purely
// numeric and matches an HRMS empCode, copy the employee's name into
// `fullName`. Mirrors the modal's auto-fill behaviour for legacy
// rows. Idempotent — when `fullName` already equals the emp's name,
// nothing happens. Runs only for Super Admin / Admin since others
// can't write to `users`.
async function _repairUsernamesFromHrms(){
  if(typeof CU==='undefined'||!CU) return 0;
  if(!Array.isArray(DB.users)||!Array.isArray(DB.hrmsEmployees)) return 0;
  if(!DB.hrmsEmployees.length) return 0;
  var roles=CU.roles||[];
  var canWrite=roles.indexOf('Super Admin')>=0||roles.indexOf('Admin')>=0;
  if(!canWrite) return 0;
  var empByCode={};
  DB.hrmsEmployees.forEach(function(e){
    if(e&&e.empCode) empByCode[String(e.empCode).trim()]=e;
  });
  var changed=[];
  DB.users.forEach(function(u){
    if(!u||!u.name) return;
    var n=String(u.name).trim();
    if(!/^\d+$/.test(n)) return;
    var emp=empByCode[n];
    if(!emp||!emp.name) return;
    var newFull=String(emp.name).trim();
    var curFull=String(u.fullName||'').trim();
    if(newFull===curFull||!newFull) return;
    u.fullName=newFull;
    changed.push(u);
  });
  if(!changed.length) return 0;
  if(typeof _dbSaveBulk==='function'){
    try{
      await _dbSaveBulk('users',changed,'Repairing user full names…');
      if(typeof notify==='function') notify('🔧 Updated full name for '+changed.length+' user(s)');
      if(typeof renderPortalUsers==='function') renderPortalUsers();
    }catch(e){console.warn('Username repair failed:',e);}
  }
  return changed.length;
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
// One-shot cleanup for legacy records where an app was removed but its
// role array (or VMS roles inside u.roles) wasn't cleared. Idempotent —
// safe to re-run; users already clean are left alone. Super Admin only.
// Run from the browser console: await _repairOrphanedAppRoles()
async function _repairOrphanedAppRoles(){
  if(!(CU&&(CU.roles||[]).indexOf('Super Admin')>=0)){
    if(typeof notify==='function') notify('⚠ Super Admin only',true);
    return {affected:0,failed:0,skipped:0};
  }
  var PLAT=(typeof PLATFORM_ROLES!=='undefined'?PLATFORM_ROLES:['Super Admin','Admin','Read Only']);
  var affected=0,failed=0,skipped=0;
  var fixed=[];
  for(var i=0;i<(DB.users||[]).length;i++){
    var u=DB.users[i];
    if(!u){skipped++;continue;}
    var apps=u.apps||[];
    var bak={roles:(u.roles||[]).slice(),hwmsRoles:(u.hwmsRoles||[]).slice(),hrmsRoles:(u.hrmsRoles||[]).slice(),mttsRoles:(u.mttsRoles||[]).slice()};
    var changed=false;
    // u.roles mixes platform roles with VMS roles. When VMS app is gone,
    // strip non-platform entries (which by convention are VMS roles).
    if(!apps.includes('vms')){
      var keep=(u.roles||[]).filter(function(r){return PLAT.indexOf(r)>=0;});
      if(keep.length!==(u.roles||[]).length){u.roles=keep;changed=true;}
    }
    if(!apps.includes('hwms')&&(u.hwmsRoles||[]).length){u.hwmsRoles=[];changed=true;}
    if(!apps.includes('hrms')&&(u.hrmsRoles||[]).length){u.hrmsRoles=[];changed=true;}
    if(!apps.includes('maintenance')&&(u.mttsRoles||[]).length){u.mttsRoles=[];changed=true;}
    if(!changed){skipped++;continue;}
    try{
      if(await _dbSave('users',u)){
        affected++;
        fixed.push(u.fullName||u.name);
      } else {
        Object.assign(u,bak);
        failed++;
      }
    } catch(e){
      console.error('repair save failed for '+(u.name||u.id),e);
      Object.assign(u,bak);
      failed++;
    }
  }
  console.log('Orphan-role cleanup:',{affected,failed,skipped,fixed});
  var msg='✅ Cleaned '+affected+' user'+(affected===1?'':'s')+(failed?', ⚠ '+failed+' failed':'');
  if(typeof notify==='function') notify(msg,failed>0);
  if(typeof renderPortalUsers==='function') renderPortalUsers();
  return {affected:affected,failed:failed,skipped:skipped,fixed:fixed};
}

function renderPortalUsers(){
  const srch=(document.getElementById('puSearch')?.value||'').toLowerCase();
  const showI=document.getElementById('puShowInactive')?.checked;
  const isSA=CU?.roles?.includes('Super Admin');
  // V117 — SA-only export button visibility.
  (function(){var b=document.getElementById('btnExportUsers');if(b) b.style.display=isSA?'inline-flex':'none';})();
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

// When the username field is filled with a numeric value that matches
// an HRMS empCode, auto-populate Full Name from the employee record
// and auto-select the corresponding KAP location:
//   Plant-1 / HO → KAP-1     Plant-2 → KAP-2     Plant-N → KAP-N
// If the username later stops matching, only fields that we
// auto-populated are reset (`data-mu-auto="1"`); anything the user
// typed by hand is preserved. Manual edits to those fields drop the
// flag so they're never overwritten back to blank.
function _muAutoFillFromEmpCode(){
  try{
    var nameInp=document.getElementById('muName');
    var fullInp=document.getElementById('muFull');
    var locSel=document.getElementById('muLoc');
    var note  =document.getElementById('muAutofillNote');
    if(!nameInp) return;
    var v=String(nameInp.value||'').trim();
    var isNumeric=/^\d+$/.test(v);
    // Numeric usernames are bound to HRMS empCodes — lock the auto-
    // filled fields and surface a hint banner so the operator knows
    // typing in them won't take effect. Non-numeric usernames flip
    // back to free-text editing on both fields.
    if(fullInp){fullInp.disabled=isNumeric;fullInp.style.background=isNumeric?'#f1f5f9':'';}
    if(locSel){locSel.disabled=isNumeric;locSel.style.background=isNumeric?'#f1f5f9':'';}
    if(note) note.style.display=isNumeric?'block':'none';
    if(!v||!isNumeric) return;
    // hrmsEmployees may not be loaded yet on a fresh portal boot —
    // schedule a retry so the autofill kicks in once data arrives.
    var emps=DB.hrmsEmployees||[];
    if(!emps.length){
      if(!window._muAutofillRetried){
        window._muAutofillRetried=true;
        setTimeout(function(){window._muAutofillRetried=false;_muAutoFillFromEmpCode();},1200);
      }
      return;
    }
    var emp=emps.find(function(e){return e&&String(e.empCode||'').trim()===v;});
    if(emp){
      var empName=String(emp.name||'').trim();
      if(fullInp&&empName){
        fullInp.value=empName;
        fullInp.setAttribute('data-mu-auto','1');
      }
      var plant=String(emp.location||'').trim();
      var kapName=null;
      if(/^h\.?o\.?$|head\s*office/i.test(plant)) kapName='KAP-1';
      else {
        var m=plant.match(/plant\s*[-_ ]?\s*(\d+)/i);
        if(m) kapName='KAP-'+m[1];
      }
      var loc=null;
      if(kapName){
        loc=(DB.locations||[]).find(function(l){
          return l&&l.type==='KAP'&&!l.inactive&&String(l.name||'').toLowerCase()===kapName.toLowerCase();
        });
      }
      if(locSel&&loc){
        locSel.value=loc.id;
        locSel.setAttribute('data-mu-auto','1');
      }
    } else {
      // Numeric username but no matching empCode — clear any value we
      // previously auto-populated so it's obvious the new username
      // isn't bound to a known employee. Manual values (no auto flag)
      // are preserved.
      if(fullInp&&fullInp.getAttribute('data-mu-auto')==='1'){
        fullInp.value='';
        fullInp.removeAttribute('data-mu-auto');
      }
      if(locSel&&locSel.getAttribute('data-mu-auto')==='1'){
        locSel.value='';
        locSel.removeAttribute('data-mu-auto');
      }
    }
  }catch(e){console.warn('muAutoFill error:',e);}
}

// User manually edited Full Name or Location after auto-fill — drop
// the auto flag so subsequent username changes don't overwrite them.
function _muClearAutoFlag(el){
  if(el&&el.removeAttribute) el.removeAttribute('data-mu-auto');
}

// Keyboard shortcuts for the Add/Edit User modal:
//   Esc   → cancel (close the modal)
//   Enter → save, except inside a <textarea> (multiline editing)
// Registered once at script load on the document so the shortcut
// works regardless of whether focus is currently inside the modal
// (it's gated by checking the modal's open state on every keydown).
(function(){
  if(typeof document==='undefined') return;
  document.addEventListener('keydown',function(ev){
    if(!ev) return;
    var modal=document.getElementById('mUser');
    if(!modal||!modal.classList.contains('open')) return;// only when open
    if(ev.key==='Escape'){
      ev.preventDefault();ev.stopPropagation();
      if(typeof cm==='function') cm('mUser');
      return;
    }
    if(ev.key==='Enter'){
      var t=ev.target&&ev.target.tagName||'';
      if(t==='TEXTAREA') return;
      ev.preventDefault();ev.stopPropagation();
      if(typeof puSaveUser==='function') puSaveUser();
    }
  });
})();

// ── User modal ──────────────────────────────────────────────────────────────
function puOpenModal(id){
  const u=id?byId(DB.users,id):null;
  document.getElementById('muId').value=id||'';
  document.getElementById('muName').value=u?.name||'';
  // Reset auto-fill flags — values shown for an existing user are
  // their saved values, not auto-populated, so they must NOT clear
  // when the username later changes.
  document.getElementById('muFull')?.removeAttribute('data-mu-auto');
  document.getElementById('muLoc')?.removeAttribute('data-mu-auto');
  // Password field removed — new users get _PORTAL_RESET_PWD automatically.
  document.getElementById('muFull').value=u?.fullName||'';
  // Country-code dropdown — populated from the shared list. The saved
  // mobile string is "+CC XXXX XX XXXX" (or just "XXXX XX XXXX" if
  // legacy); split it apart so the dropdown holds the dial code and
  // the input holds only digits.
  const ccSel=document.getElementById('muMobileCode');
  if(ccSel&&typeof _COUNTRY_CODES!=='undefined'){
    ccSel.innerHTML=_COUNTRY_CODES.map(c=>`<option value="${c.d}" title="${c.n}">${c.d} ${c.c}</option>`).join('');
  }
  const rawMob=String(u?.mobile||'').trim();
  let mCode='+91',mDigits='';
  const mMatch=rawMob.match(/^(\+\d{1,4})\s*(.*)$/);
  if(mMatch){mCode=mMatch[1];mDigits=mMatch[2].replace(/\D/g,'').slice(-10);}
  else mDigits=rawMob.replace(/\D/g,'').slice(-10);
  if(ccSel) ccSel.value=mCode||'+91';
  const mInp=document.getElementById('muMobile');
  if(mInp){mInp.value=mDigits;if(mDigits&&typeof _formatMobile10==='function') _formatMobile10(mInp);}
  // Email — optional; existing legacy users may have it blank.
  const eInp=document.getElementById('muEmail');
  if(eInp) eInp.value=u?.email||'';
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
  // Role lists — source from the Configure Access ordering so custom roles
  // added there automatically show up here, and the sequence matches.
  const vr=(typeof _permGetOrderedRoles==='function')?_permGetOrderedRoles('VMS'):ROLES.filter(r=>r!=='Super Admin');
  const hwr=(typeof _permGetOrderedRoles==='function')?_permGetOrderedRoles('HWMS'):(HWMS_ROLES||[]);
  const hrr=(typeof _permGetOrderedRoles==='function')?_permGetOrderedRoles('HRMS'):((typeof HRMS_ROLES!=='undefined')?HRMS_ROLES:[]);
  const mtr=(typeof _permGetOrderedRoles==='function')?_permGetOrderedRoles('MTTS'):((typeof MTTS_ROLES!=='undefined')?MTTS_ROLES:[]);
  document.getElementById('muVmsBoxes').innerHTML=vr.map(r=>{const c=(u?.roles||[]).includes(r);return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:var(--surface2);padding:4px 10px;border-radius:5px;border:1px solid ${c?'var(--accent)':'var(--border)'}"><input type="checkbox" class="muVmsCb" value="${r}" ${c?'checked':''} style="width:auto"> ${r}</label>`}).join('');
  document.getElementById('muHwmsBoxes').innerHTML=hwr.map(r=>{const c=(u?.hwmsRoles||[]).includes(r);return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:rgba(139,92,246,.06);padding:4px 10px;border-radius:5px;border:1px solid ${c?'var(--purple)':'rgba(139,92,246,.25)'}"><input type="checkbox" class="muHwmsCb" value="${r}" ${c?'checked':''} style="width:auto"> ${r}</label>`}).join('');
  document.getElementById('muHrmsBoxes').innerHTML=hrr.map(r=>{const c=(u?.hrmsRoles||[]).includes(r);return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:rgba(34,197,94,.06);padding:4px 10px;border-radius:5px;border:1px solid ${c?'#16a34a':'rgba(34,197,94,.25)'}"><input type="checkbox" class="muHrmsCb" value="${r}" ${c?'checked':''} style="width:auto"> ${r}</label>`}).join('');
  document.getElementById('muMttsBoxes').innerHTML=mtr.map(r=>{const c=(u?.mttsRoles||[]).includes(r);return `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;background:rgba(245,158,11,.07);padding:4px 10px;border-radius:5px;border:1px solid ${c?'#d97706':'rgba(245,158,11,.25)'}"><input type="checkbox" class="muMttsCb" value="${r}" ${c?'checked':''} style="width:auto"> ${r}</label>`}).join('');
  document.getElementById('muVmsRoles').style.display=ua.includes('vms')?'block':'none';
  document.getElementById('muHwmsRoles').style.display=ua.includes('hwms')?'block':'none';
  document.getElementById('muHrmsRoles').style.display=ua.includes('hrms')?'block':'none';
  document.getElementById('muMttsRoles').style.display=ua.includes('maintenance')?'block':'none';
  document.getElementById('muInactive').checked=u?.inactive===true;
  om('mUser');
  // Apply autofill / disabled state to Full Name + Location now that
  // the username is set (covers numeric edit-mode users).
  if(typeof _muAutoFillFromEmpCode==='function') _muAutoFillFromEmpCode();
  // Focus the Username input so Enter saves on first keystroke / Esc
  // cancels without an extra click. setTimeout ensures the modal's
  // CSS transition has flushed before we focus.
  setTimeout(function(){
    var first=document.getElementById('muName');
    if(first){try{first.focus();first.select&&first.select();}catch(_){}}
  },50);
}
function puAppChange(cb){
  cb.closest('label').style.background=cb.checked?'rgba(42,154,160,.07)':'var(--surface2)';
  cb.closest('label').style.borderColor=cb.checked?'var(--accent)':'var(--border)';
  const sel=[...document.querySelectorAll('.muAppCb:checked')].map(i=>i.value);
  document.getElementById('muVmsRoles').style.display=sel.includes('vms')?'block':'none';
  document.getElementById('muHwmsRoles').style.display=sel.includes('hwms')?'block':'none';
  document.getElementById('muHrmsRoles').style.display=sel.includes('hrms')?'block':'none';
  document.getElementById('muMttsRoles').style.display=sel.includes('maintenance')?'block':'none';
  // When an app is deselected, immediately uncheck every role box that
  // belongs to it so the visual state matches what will be saved. The
  // save-time guard in puSaveUser zeroes the role arrays again as a
  // defence-in-depth (covers the case where the user typed Save before
  // this handler ran).
  if(!sel.includes('vms'))         document.querySelectorAll('.muVmsCb').forEach(function(c){c.checked=false;});
  if(!sel.includes('hwms'))        document.querySelectorAll('.muHwmsCb').forEach(function(c){c.checked=false;});
  if(!sel.includes('hrms'))        document.querySelectorAll('.muHrmsCb').forEach(function(c){c.checked=false;});
  if(!sel.includes('maintenance')) document.querySelectorAll('.muMttsCb').forEach(function(c){c.checked=false;});
}

// ── Save user ───────────────────────────────────────────────────────────────
async function puSaveUser(){
  const id=document.getElementById('muId').value;
  const name=document.getElementById('muName').value.trim().toLowerCase().replace(/[\s!@#$%^&*()+=\[\]{};':"\\|,.<>\/?]/g,'');
  const plant=document.getElementById('muLoc').value;
  const fullName=document.getElementById('muFull').value.trim();
  // Mobile: capture digits only and re-attach the country code from the
  // dropdown so the saved value is "+CC XXXX XX XXXX".
  const mobileDigits=String(document.getElementById('muMobile').value||'').replace(/\D/g,'').slice(0,10);
  const mobileCode=String(document.getElementById('muMobileCode')?.value||'+91');
  const mobile=mobileDigits?(mobileCode+' '+
    (mobileDigits.length>6?mobileDigits.slice(0,4)+' '+mobileDigits.slice(4,6)+' '+mobileDigits.slice(6)
     :mobileDigits.length>4?mobileDigits.slice(0,4)+' '+mobileDigits.slice(4):mobileDigits)
  ):'';
  const email=String(document.getElementById('muEmail')?.value||'').trim();
  const apps=[...document.querySelectorAll('.muAppCb:checked')].map(i=>i.value);
  // Read role-box state, then zero out any app the user has just removed
  // from the access list — otherwise a previously-checked role box (e.g.
  // VMS Admin) leaks through even when its parent app is unchecked,
  // which kept revoking access from being effective.
  let vmsRoles=[...document.querySelectorAll('.muVmsCb:checked')].map(i=>i.value);
  if(!apps.includes('vms')) vmsRoles=[];
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
  let hwmsRoles=[...document.querySelectorAll('.muHwmsCb:checked')].map(i=>i.value);
  if(!apps.includes('hwms')) hwmsRoles=[];
  let hrmsRoles=[...document.querySelectorAll('.muHrmsCb:checked')].map(i=>i.value);
  if(!apps.includes('hrms')) hrmsRoles=[];
  let mttsRoles=[...document.querySelectorAll('.muMttsCb:checked')].map(i=>i.value);
  if(!apps.includes('maintenance')) mttsRoles=[];
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
  if(mobileDigits&&mobileDigits.length!==10){modalErr('mUser','Mobile must be 10 digits');return}
  if(email&&typeof _isValidEmailOrBlank==='function'&&!_isValidEmailOrBlank(email)){modalErr('mUser','Email format invalid');return}
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
    const bak={...eu};Object.assign(eu,{name,plant,fullName,mobile,email,roles,hwmsRoles,hrmsRoles,mttsRoles,apps,inactive});
    if(!await _dbSave('users',eu)){Object.assign(eu,bak);return}
  } else {
    // New user: always assign the default password. User must change it
    // on first login (forced via password-strength check).
    const nu={id:'u'+uid(),name,plant,fullName,mobile,email,roles,hwmsRoles,hrmsRoles,mttsRoles,apps,inactive,photo:''};
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

// ── SA-only export users to Excel ──────────────────────────────────────
// Columns: Username · Full Name · Location · Email · Mobile · Apps ·
//   Platform Roles · VMS Roles · HWMS Roles · HRMS Roles · MTTS Roles ·
//   Inactive. Respects the current Show Inactive checkbox so the export
//   matches what the operator sees on screen.
function _puExportUsers(){
  if(!CU||!(CU.roles||[]).includes('Super Admin')){
    notify('⚠ Super Admin only',true);return;
  }
  if(typeof _downloadAsXlsx!=='function'){notify('XLSX helper not loaded',true);return;}
  // Build location-id → name map so we export the human-readable plant
  // name (not the internal location id).
  var locById={};
  (DB.locations||[]).forEach(function(l){if(l&&l.id) locById[l.id]=l.name||'';});
  // Platform roles split off from u.roles so the export has VMS-only
  // roles in their own column.
  var PLAT=(typeof PLATFORM_ROLES!=='undefined'?PLATFORM_ROLES:['Super Admin','Admin','Read Only']);
  var showI=document.getElementById('puShowInactive')?.checked;
  var rows=(DB.users||[]).slice();
  if(!showI) rows=rows.filter(function(u){return u&&!u.inactive;});
  rows.sort(function(a,b){
    return String(a.fullName||a.name||'').localeCompare(String(b.fullName||b.name||''),undefined,{numeric:true,sensitivity:'base'});
  });
  var headers=['Username','Full Name','Location','Email','Mobile','Apps','Platform Roles','VMS Roles','HWMS Roles','HRMS Roles','MTTS Roles','Inactive'];
  var data=[headers];
  rows.forEach(function(u){
    if(!u) return;
    var allRoles=u.roles||[];
    var platRoles=allRoles.filter(function(r){return PLAT.indexOf(r)>=0;});
    var vmsRoles=allRoles.filter(function(r){return PLAT.indexOf(r)<0;});
    data.push([
      u.name||'',
      u.fullName||'',
      locById[u.plant]||u.plant||'',
      u.email||'',
      u.mobile||'',
      (u.apps||[]).join(', '),
      platRoles.join(', '),
      vmsRoles.join(', '),
      (u.hwmsRoles||[]).join(', '),
      (u.hrmsRoles||[]).join(', '),
      (u.mttsRoles||[]).join(', '),
      u.inactive?'Yes':'No'
    ]);
  });
  var stamp=(function(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');})();
  _downloadAsXlsx(data,'Users','KAP_Users_'+stamp+'.xlsx');
  notify('📤 Exported '+(data.length-1)+' user'+((data.length-1)===1?'':'s'));
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

// ── Sidebar toggle ──────────────────────────────────────────────────────────
// Desktop: collapses the fixed sidebar offscreen and removes the topbar/body
// left-margin so the page reflows to full width. Mobile: slides the overlay
// in/out via the `.open` class.
function togglePortalSidebar(){
  var page=document.getElementById('portalPage');
  var sb=document.getElementById('portalSidebar');
  if(!page||!sb) return;
  if(window.innerWidth>768){
    page.classList.toggle('portal-sb-hidden');
  } else {
    sb.classList.toggle('open');
  }
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
  // Portal needs users + locations + hrmsSettings, plus hrmsEmployees so
  // the Add/Edit User modal can auto-fill Full Name / Location from a
  // numeric username matching an HRMS empCode. Photos are excluded
  // from the boot select for this table (handled in bootDB).
  if(typeof _APP_TABLES!=='undefined') _APP_TABLES=['users','locations','hrmsSettings','hrmsEmployees'];
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
  if(mod==='HRMS') return typeof HRMS_ROLES!=='undefined'?HRMS_ROLES.slice():['Super Admin','HR Manager','Employee'];
  if(mod==='VMS') return typeof ROLES!=='undefined'?ROLES.slice():['Super Admin','VMS Admin','Plant Head','Trip Booking User','KAP Security','Material Receiver','Trip Approver','Vendor'];
  if(mod==='HWMS') return typeof HWMS_ROLES!=='undefined'?HWMS_ROLES.slice():['Super Admin','HWMS Admin','Supplier','WH Admin','WH User','Buyer','Buyer Coordinator'];
  if(mod==='Security') return ['Super Admin','Guard','Viewer'];
  return ['Super Admin'];
}

function _permModuleData(mod){
  var all=_permLoadData();
  if(!all[mod]) all[mod]={roles:[],permissions:{}};
  var md=all[mod];
  if(!Array.isArray(md.customRoles)) md.customRoles=[];
  // Auto-merge: ensure all default/constant roles exist in the saved list
  // — except defaults the admin has explicitly deleted (md.deletedDefaults).
  // Without that exception, deleting "Read Only" would silently come back on
  // the next render.
  var defaults=_permGetDefaultRoles(mod);
  var deletedDefaults=(md.deletedDefaults||[]);
  defaults.forEach(function(r){
    if(deletedDefaults.indexOf(r)>=0) return;
    if(md.roles.indexOf(r)<0) md.roles.push(r);
  });
  // Also scan users for any custom roles assigned but not yet in the role list.
  // _belongsToAnotherModule blocks ONLY roles that are built into a *different*
  // module — custom roles (added via "+ Add" in this editor) pass through.
  var field=_PERM_ROLE_FIELDS[mod];
  var allow=(typeof _PERM_MODULE_ROLES!=='undefined')&&_PERM_MODULE_ROLES[mod];
  var customs=md.customRoles||[];
  var _belongsToAnotherModule=function(r){
    if(typeof _PERM_MODULE_ROLES==='undefined') return false;
    // Admin explicitly added this role here via "+ Add" — keep it even
    // if the name collides with another module's built-ins (e.g. adding
    // "Plant Head" to HRMS when it's also a VMS built-in).
    if(customs.indexOf(r)>=0) return false;
    if(allow&&allow.indexOf(r)>=0) return false; // already in this module's defaults
    var mods=Object.keys(_PERM_MODULE_ROLES);
    for(var i=0;i<mods.length;i++){
      if(mods[i]===mod) continue;
      if(_PERM_MODULE_ROLES[mods[i]].indexOf(r)>=0) return true;
    }
    return false;
  };
  if(field){
    (DB.users||[]).forEach(function(u){
      var userRoles=u[field]||[];
      userRoles.forEach(function(r){
        if(!r||md.roles.indexOf(r)>=0) return;
        if(_belongsToAnotherModule(r)) return;
        // If this role is a built-in default that the admin explicitly
        // deleted, don't resurrect it just because some user is still
        // assigned to it. The user assignment is stale.
        if(deletedDefaults.indexOf(r)>=0) return;
        md.roles.push(r);
      });
    });
  }
  // Drop only roles built into another module (that weren't explicitly
  // added here), plus any deleted-default role that snuck in via some
  // other path. Custom roles created via "+ Add" survive across reloads.
  md.roles=md.roles.filter(function(r){
    if(_belongsToAnotherModule(r)) return false;
    if(deletedDefaults.indexOf(r)>=0) return false;
    return true;
  });
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
  if(typeof _permUpdateTitleBar==='function') _permUpdateTitleBar();
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
    // Super Admin is pinned at the top and not draggable — every module's
    // canonical owner role must keep its position. Custom + built-in
    // module roles are reorderable via HTML5 drag-and-drop.
    var canDrag=!isSA;
    var dragAttrs=canDrag
      ?' draggable="true" ondragstart="_permDragStart(event,\''+r.replace(/'/g,"\\'")+'\')" ondragover="_permDragOver(event)" ondragenter="_permDragEnter(event)" ondragleave="_permDragLeave(event)" ondrop="_permDragDrop(event,\''+r.replace(/'/g,"\\'")+'\')" ondragend="_permDragEnd(event)"'
      :'';
    h+='<div'+dragAttrs+' onclick="_permSelectRole(\''+r.replace(/'/g,"\\'")+'\')" data-perm-role="'+r.replace(/"/g,'&quot;')+'" style="display:flex;align-items:center;gap:6px;padding:8px 10px;margin-bottom:4px;border-radius:6px;cursor:'+(canDrag?'grab':'pointer')+';font-size:12px;font-weight:'+(active?'800':'600')+';background:'+(active?'var(--accent-light)':'#fff')+';border:1.5px solid '+(active?'var(--accent)':'var(--border)')+';color:'+(active?'var(--accent)':'var(--text)')+';user-select:none">';
    if(canDrag) h+='<span title="Drag to reorder" style="color:var(--text3);font-size:13px;line-height:1;cursor:grab">⋮⋮</span>';
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
    var saveSlot=document.getElementById('permSaveSlot');
    if(saveSlot){ saveSlot.innerHTML=''; saveSlot.style.display='none'; }
  }
}

// ─── Role drag-and-drop reorder (Configure Access) ───────────────────────────
// The drag handle and the row itself both trigger drag. On drop, the dragged
// role is inserted ABOVE the drop target in md.roles. The change is persisted
// via _permSaveData so the new order survives reload AND propagates to the
// Add/Edit User modal (which pulls roles from _permGetOrderedRoles).
var _permDragRole=null;
function _permDragStart(ev,role){
  _permDragRole=role;
  try{ ev.dataTransfer.effectAllowed='move'; ev.dataTransfer.setData('text/plain',role); }catch(_){}
  if(ev.currentTarget&&ev.currentTarget.style) ev.currentTarget.style.opacity='0.5';
}
function _permDragOver(ev){ ev.preventDefault(); try{ ev.dataTransfer.dropEffect='move'; }catch(_){}}
function _permDragEnter(ev){
  if(!_permDragRole) return;
  var t=ev.currentTarget;if(!t||!t.style) return;
  if(t.getAttribute('data-perm-role')===_permDragRole) return;
  t.style.borderTop='2px solid var(--accent)';
}
function _permDragLeave(ev){
  var t=ev.currentTarget;if(!t||!t.style) return;
  t.style.borderTop='';
  // Selected rows keep their accent border; rebuild it for them.
  var role=t.getAttribute('data-perm-role');
  if(role===_permActiveRole) t.style.border='1.5px solid var(--accent)';
}
function _permDragEnd(ev){
  if(ev.currentTarget&&ev.currentTarget.style) ev.currentTarget.style.opacity='';
  _permDragRole=null;
}
async function _permDragDrop(ev,targetRole){
  ev.preventDefault();
  var src=_permDragRole;_permDragRole=null;
  // Clear any hover-border that lingered.
  var rows=document.querySelectorAll('#permRoleList [data-perm-role]');
  rows.forEach(function(r){r.style.borderTop='';r.style.opacity='';});
  if(!src||src===targetRole||src==='Super Admin'||targetRole==='Super Admin') return;
  var md=_permModuleData(_permActiveModule);
  var srcIdx=md.roles.indexOf(src);
  var tgtIdx=md.roles.indexOf(targetRole);
  if(srcIdx<0||tgtIdx<0) return;
  md.roles.splice(srcIdx,1);
  // After removing src, recompute target index.
  var newTgt=md.roles.indexOf(targetRole);
  md.roles.splice(newTgt,0,src);
  await _permSaveData(md);
}

// Returns the role list for a module in the order persisted via Configure
// Access. Super Admin is excluded — it's handled separately as a platform
// role. Used by the Add/Edit User modal so the role boxes mirror the
// Configure Access ordering and pick up custom roles automatically.
function _permGetOrderedRoles(mod){
  var md=_permModuleData(mod);
  return (md.roles||[]).filter(function(r){return r&&r!=='Super Admin';});
}

function _permSelectRole(role){
  _permActiveRole=role;
  _permRenderRoles();
  if(typeof _permUpdateTitleBar==='function') _permUpdateTitleBar();
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
//   • Any key explicitly registered in _PERM_UMBRELLA[mod] is an umbrella,
//     regardless of group siblings — sidebar parents like page.masters,
//     page.utilities and page.utilDailyAttSum live here so the user can't
//     toggle the menu-level key directly; it derives from the sub-items.
//   • Otherwise it must have scoped children, and page.* keys still need
//     to be the sole page.* in their group (legacy detection).
function _permIsUmbrella(items,index){
  var item=items[index];
  if(typeof _PERM_UMBRELLA!=='undefined'
     &&_PERM_UMBRELLA[_permActiveModule]
     &&_PERM_UMBRELLA[_permActiveModule][item.key]) return true;
  var kids=_permScopedChildren(items,index);
  if(!kids.length) return false;
  if(/^page\./.test(item.key)){
    var pagesInGroup=items.filter(function(it){return /^page\./.test(it.key);});
    if(pagesInGroup.length>1) return false;
  }
  return true;
}

// Tree expand/collapse state — keyed by group name (top level) and perm
// key (interior nodes). Persists for the lifetime of the Access
// Management screen; resets on a fresh page load. Default = collapsed.
var _permTreeOpen={};

// Walks every leaf descendant of a tree node, returning the aggregate
// permission level: 'full' if every leaf is Full, 'none' if every leaf
// is None, otherwise 'mixed'. Umbrella nodes are not leaves themselves
// (they inherit from children) but the umbrella's children still count.
function _permComputeNodeAggregate(node,rolePerms){
  var allFull=true,allNone=true,any=false;
  function walk(n){
    if(!n.children||!n.children.length){
      // Leaf
      var lvl=_permReadLevel(rolePerms,n.item.key);
      if(lvl!=='full') allFull=false;
      if(lvl!=='none') allNone=false;
      any=true;
    } else {
      n.children.forEach(walk);
    }
  }
  walk(node);
  if(!any) return 'none';
  if(allFull) return 'full';
  if(allNone) return 'none';
  return 'mixed';
}
function _permAggregateColor(state){
  if(state==='full') return '#15803d';// green
  if(state==='none') return '#dc2626';// red
  return '#a16207';                   // yellow/amber
}

// Build a tree from the flat items list. Honours two hierarchies:
//   1) Explicit _PERM_UMBRELLA declarations — an item declared as a
//      child of an umbrella becomes that umbrella's tree child
//      whenever both are in the same group.
//   2) Depth-based fallback — for items not covered by an umbrella
//      declaration, the depth of the perm key (page/tab/sub-tab/action)
//      determines nesting via the usual stack walk.
function _permBuildTree(items){
  var mod=_permActiveModule;
  var umbDecl=(typeof _PERM_UMBRELLA!=='undefined'&&_PERM_UMBRELLA[mod])||{};
  var treeParents=(typeof _PERM_TREE_PARENTS!=='undefined'&&_PERM_TREE_PARENTS[mod])||{};
  var byKey={};items.forEach(function(it){byKey[it.key]=it;});
  // child key → declared parent key (only when both are in this group).
  // _PERM_TREE_PARENTS wins over _PERM_UMBRELLA so UI-only nesting
  // hints (e.g. tab.das.alloc → tab.das.manpower) take precedence over
  // the cascade-driven _PERM_UMBRELLA layout.
  var nestedKeys={};
  Object.keys(treeParents).forEach(function(childKey){
    var pk=treeParents[childKey];
    if(byKey[childKey]&&byKey[pk]) nestedKeys[childKey]=pk;
  });
  Object.keys(umbDecl).forEach(function(parentKey){
    if(!byKey[parentKey]) return;
    (umbDecl[parentKey]||[]).forEach(function(childKey){
      if(byKey[childKey]&&!nestedKeys[childKey]) nestedKeys[childKey]=parentKey;
    });
  });
  var nodeByKey={};
  items.forEach(function(it){nodeByKey[it.key]={item:it,depth:_permDepth(it.key),children:[]};});
  var roots=[];
  var stack=[];
  items.forEach(function(it){
    var node=nodeByKey[it.key];
    var parentKey=nestedKeys[it.key];
    if(parentKey){
      // Declared umbrella child — nest under the declared parent and
      // reset the stack to this node so subsequent depth-based items
      // can still nest under it if they have greater depth.
      var parent=nodeByKey[parentKey];
      if(parent) parent.children.push(node);
      else roots.push(node);
      // Rebuild stack so depth-based nesting under this node still works.
      // Find the depth path to this node.
      stack=[];
      var cur=node;
      while(cur){
        stack.unshift(cur);
        // climb to declared parent if any
        var pk=nestedKeys[cur.item.key];
        cur=pk?nodeByKey[pk]:null;
      }
    } else {
      while(stack.length&&stack[stack.length-1].depth>=node.depth) stack.pop();
      if(stack.length===0) roots.push(node);
      else stack[stack.length-1].children.push(node);
      stack.push(node);
    }
  });
  return roots;
}

// True if an item's label is essentially the same as the group label
// (after stripping emoji, punctuation, parenthetical suffixes). Used
// to skip redundant umbrella rows when the group header already
// serves as that umbrella's "row".
function _permItemMirrorsGroup(item,groupName){
  var clean=function(s){
    return String(s||'')
      .replace(/\([^)]*\)/g,'')      // drop "(main tab)" / "(sidebar menu)" etc.
      .replace(/\bpage\b/gi,'')      // drop the " Page" label-distinguisher suffix (HWMS)
      .replace(/[^a-zA-Z0-9]/g,'')   // strip emoji, spaces, punctuation
      .toLowerCase();
  };
  var iL=clean(item.label);
  var gL=clean(groupName);
  if(!iL||!gL) return false;
  return iL===gL;
}

// Strip the noisy "(sub-tab)" / "(main tab)" / "(sidebar menu)"
// annotations from a perm key's display label. The annotations were
// useful when the tree was flat (the bracket disambiguated similarly-
// named entries); inside the new collapsible tree they're redundant
// because the hierarchy itself carries the meaning.
function _permCleanLabel(label){
  return String(label||'')
    .replace(/\s*\(\s*sub[\s-]?tab\s*\)/ig,'')
    .replace(/\s*\(\s*main\s*tab\s*\)/ig,'')
    .replace(/\s*\(\s*sidebar\s*menu\s*\)/ig,'')
    .replace(/\s*\(\s*modal\s*\)/ig,'')
    .replace(/\s+page\s*$/i,'')          // drop trailing " Page" suffix (HWMS labels)
    .trim();
}

function _permToggleTree(key){
  _permTreeOpen[key]=!_permTreeOpen[key];
  _permRenderPerms();
}

// Copy every permission from a source role into the active role. Runs
// in-memory only — admin must click Save to commit. Triggers a confirm
// prompt because copying overwrites every existing setting on the
// target role (including explicit None / View / Full grants).
function _permCopyFromRole(sourceRole){
  if(!sourceRole||sourceRole===_permActiveRole) return;
  var role=_permActiveRole;
  if(!role||role==='Super Admin') return;
  if(!confirm('Copy ALL access settings from "'+sourceRole+'" into "'+role+'"?\n\nEvery existing setting on "'+role+'" will be overwritten.\n\nReview the result and click Save to commit, or switch roles to discard.')) return;
  var md=_permModuleData(_permActiveModule);
  if(!md.permissions) md.permissions={};
  var src=md.permissions[sourceRole]||{};
  // Deep-clone so the two roles don't share a reference.
  var clone={};Object.keys(src).forEach(function(k){clone[k]=src[k];});
  md.permissions[role]=clone;
  _permRenderPerms();
  if(typeof notify==='function') notify('Copied access settings from "'+sourceRole+'". Click Save to commit.');
}
function _permExpandAll(){
  var keys=_PERM_KEYS[_permActiveModule]||[];
  var groups={};keys.forEach(function(k){groups[k.group]=1;});
  Object.keys(groups).forEach(function(g){_permTreeOpen[g]=true;});
  keys.forEach(function(k){_permTreeOpen[k.key]=true;});
  _permRenderPerms();
}
function _permCollapseAll(){
  _permTreeOpen={};
  _permRenderPerms();
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
    +(isSA?'<span style="font-size:11px;background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:4px;font-weight:700">Full access — cannot be modified</span>':'');
  var saveSlot=document.getElementById('permSaveSlot');
  if(saveSlot){
    if(isSA){ saveSlot.innerHTML=''; saveSlot.style.display='none'; }
    else {
      // Copy/reset between roles is handled by the dedicated "🔄 Change Access"
      // button in the Roles panel header — keeps this header focused on
      // the actions that act on the active role.
      saveSlot.innerHTML='<button onclick="_permExpandAll()" style="font-size:11px;padding:6px 10px;background:#fff;color:var(--text2);border:1.5px solid var(--border);border-radius:6px;font-weight:700;cursor:pointer;margin-right:6px" title="Expand every menu">⊞ Expand</button>'
        +'<button onclick="_permCollapseAll()" style="font-size:11px;padding:6px 10px;background:#fff;color:var(--text2);border:1.5px solid var(--border);border-radius:6px;font-weight:700;cursor:pointer;margin-right:6px" title="Collapse every menu">⊟ Collapse</button>'
        +'<button onclick="_permSaveRole()" style="font-size:12px;padding:6px 18px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-weight:800;cursor:pointer">💾 Save</button>';
      saveSlot.style.display='';
    }
  }

  if(isSA){body.innerHTML='<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">Super Admin has unrestricted access to all features. No configuration needed.</div>';return;}

  // Group keys (preserving declared order within each group)
  var groups={};var groupOrder=[];
  keys.forEach(function(k){
    if(!groups[k.group]){groups[k.group]=[];groupOrder.push(k.group);}
    groups[k.group].push(k);
  });

  // Tri-state segmented control renderer — used for every permission entry.
  // Keys can opt into custom labels for the View/Full positions via
  // `scopeLabels:{view:'…',full:'…'}` (e.g. page.myAttendance uses
  // "Only Logged-in User" / "All Users" instead of View / Full).
  // Keys that need a separate row-level scope picker (which subset of
  // records the role can see — all / mapped teams / own dept / etc.)
  // declare `scopeOptions:[{v,lbl},…]` and optional
  // `defaultScopeByRole:{role:value}` for migration fallbacks. The
  // picker is rendered as a <select data-perm-scope="<key>"> right
  // after the tri-state segment and its value is persisted as a
  // sibling key (perms[role]['<key>.scope']).
  function levelSeg(k,currentLevel){
    var sl=k&&k.scopeLabels||null;
    var levels=[
      {v:'none',lbl:'None',bg:'#f3f4f6',fg:'#6b7280',activeBg:'#9ca3af',activeFg:'#fff'},
      {v:'view',lbl:(sl&&sl.view)||'View',bg:'#eff6ff',fg:'#1d4ed8',activeBg:'#2563eb',activeFg:'#fff'},
      {v:'full',lbl:(sl&&sl.full)||'Full',bg:'#ecfdf5',fg:'#047857',activeBg:'#16a34a',activeFg:'#fff'}
    ];
    var padX=sl?12:9;
    var out='<div data-perm-ptkey="'+k.key+'" data-level="'+currentLevel+'" style="display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;flex-shrink:0">';
    levels.forEach(function(L){
      var on=(L.v===currentLevel);
      out+='<button type="button" onclick="_permSetLevel(\''+k.key+'\',\''+L.v+'\')" '
        +'style="font-size:10px;font-weight:800;padding:3px '+padX+'px;border:none;cursor:pointer;white-space:nowrap;'
        +'background:'+(on?L.activeBg:L.bg)+';color:'+(on?L.activeFg:L.fg)+';'
        +'transition:all .1s">'+L.lbl+'</button>';
    });
    out+='</div>';
    var scopeOpts=(k&&Array.isArray(k.scopeOptions)&&k.scopeOptions.length)?k.scopeOptions:null;
    if(!scopeOpts && typeof _permKeyAcceptsScope==='function' && _permKeyAcceptsScope(k)){
      var modOpts=(typeof _PERM_DEFAULT_SCOPE_OPTIONS!=='undefined')?_PERM_DEFAULT_SCOPE_OPTIONS[_permActiveModule]:null;
      scopeOpts=Array.isArray(modOpts)?modOpts:null;
    }
    if(scopeOpts&&scopeOpts.length){
      var saved=rolePerms[k.key+'.scope'];
      var defByRole=(k.defaultScopeByRole||{})[_permActiveRole]||'';
      var sel=saved||defByRole||(scopeOpts[0]&&scopeOpts[0].v)||'';
      out+='<select data-perm-scope="'+k.key+'" style="font-size:10px;font-weight:700;padding:3px 6px;margin-left:6px;border:1px solid var(--border);border-radius:6px;background:#fff;color:var(--text2);cursor:pointer;max-width:160px;flex-shrink:0">';
      scopeOpts.forEach(function(O){
        out+='<option value="'+String(O.v).replace(/"/g,'&quot;')+'"'+(O.v===sel?' selected':'')+'>'+(O.lbl||O.v)+'</option>';
      });
      out+='</select>';
    }
    return out;
  }

  // Recursive tree node renderer. ALWAYS emits every node (and every
  // child wrapper) into the DOM, but applies display:none to the
  // children wrapper when collapsed. This keeps the save logic happy
  // — `_permSaveRole` reads from `[data-perm-ptkey]` and
  // `[data-perm-umbrella]` selectors that traverse the full tree, so
  // collapsing a group must NOT remove its controls from the DOM.
  function renderNode(node,allItems){
    var item=node.item;
    var key=item.key;
    var depth=node.depth;
    var hasChildren=node.children.length>0;
    var idxInFlat=allItems.indexOf(item);
    var isUmbrella=_permIsUmbrella(allItems,idxInFlat);
    var lvl=_permReadLevel(rolePerms,key);
    var agg=hasChildren?_permComputeNodeAggregate(node,rolePerms):null;
    var labelColor=hasChildren?_permAggregateColor(agg):
      (depth===0?'var(--text)':depth===1?'var(--text)':depth===2?'var(--text2)':'var(--text3)');
    var indent=depth*16;
    // ── Single-leaf-child inline: if this node is an UMBRELLA (its
    // own level is auto-derived, no separate tri-state) AND it has
    // exactly one child with no further descendants, render on a
    // single line as "Parent : Child" with the child's tri-state.
    // Saves a row of vertical real-estate for cases like
    //   settings.esslatt → action.importEssl  ("ESSL Data : Import…")
    // Parents with their own grant control (e.g. tab.das.manpower →
    // tab.das.alloc) stay as separate rows so both controls survive.
    if(isUmbrella&&node.children.length===1&&node.children[0].children.length===0){
      var only=node.children[0];
      var onlyItem=only.item;
      var onlyIdx=allItems.indexOf(onlyItem);
      var onlyIsUmbrella=_permIsUmbrella(allItems,onlyIdx);
      var onlyLvl=_permReadLevel(rolePerms,onlyItem.key);
      var h='<div style="margin-left:'+indent+'px">';
      h+='<div style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px">';
      h+='<span style="font-size:10px;color:var(--text3);width:12px;text-align:center;flex-shrink:0">•</span>';
      h+='<span style="flex:1;font-size:'+(depth<=1?12:11)+'px;color:var(--text2);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'
        +_permCleanLabel(item.label)
        +' <span style="color:var(--text3);font-weight:500"> : </span>'
        +_permCleanLabel(onlyItem.label)
        +'</span>';
      // Hidden parent umbrella marker for save (auto-derived level).
      if(isUmbrella){
        h+='<span data-perm-umbrella="'+key+'" data-perm-group-id="'+item.group.replace(/"/g,'&quot;')+'" data-perm-index="'+idxInFlat+'" style="display:none"></span>';
      }
      // Child's control — either the tri-state or its own umbrella marker.
      if(onlyIsUmbrella){
        h+='<span data-perm-umbrella="'+onlyItem.key+'" data-perm-group-id="'+onlyItem.group.replace(/"/g,'&quot;')+'" data-perm-index="'+onlyIdx+'" style="display:none"></span>';
      } else {
        h+=levelSeg(onlyItem,onlyLvl);
      }
      h+='</div></div>';
      return h;
    }
    // ── Standard row (with optional expand toggle).
    var isOpen=!!_permTreeOpen[key];
    var icon=hasChildren?(isOpen?'▼':'▶'):'•';
    var keyEsc=key.replace(/'/g,"\\'");
    var rowBg=hasChildren?'background:#f8fafc;':'';
    var rowClick=hasChildren?(' onclick="_permToggleTree(\''+keyEsc+'\')"'):'';
    var cursor=hasChildren?'cursor:pointer;':'';
    var h='<div style="margin-left:'+indent+'px">';
    h+='<div'+rowClick+' style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;'+rowBg+cursor+'">';
    h+='<span style="font-size:10px;color:var(--text3);width:12px;text-align:center;flex-shrink:0">'+icon+'</span>';
    h+='<span style="flex:1;min-width:140px;font-size:'+(depth<=1?12:11)+'px;color:'+labelColor+';font-weight:'+(hasChildren?'800':'500')+';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+_permCleanLabel(item.label)+'</span>';
    if(isUmbrella){
      // Real umbrella key — its level is auto-derived from children, so
      // emit only the hidden marker that _permSaveRole reads.
      h+='<span data-perm-umbrella="'+key+'" data-perm-group-id="'+item.group.replace(/"/g,'&quot;')+'" data-perm-index="'+idxInFlat+'" style="display:none"></span>';
    } else if(hasChildren){
      // UI-only nested parent (e.g. tab.das.manpower nests tab.das.alloc
      // via _PERM_TREE_PARENTS, but the parent itself is grantable in
      // its own right). Show the tri-state so admin can grant the page
      // directly.
      h+=levelSeg(item,lvl);
    } else {
      h+=levelSeg(item,lvl);
    }
    h+='</div>';
    if(hasChildren){
      h+='<div style="display:'+(isOpen?'block':'none')+'">';
      node.children.forEach(function(child){h+=renderNode(child,allItems);});
      h+='</div>';
    }
    h+='</div>';
    return h;
  }

  var h='';
  groupOrder.forEach(function(g){
    var items=groups[g];
    var roots=_permBuildTree(items);
    var virtualGroup={item:{key:g,label:g,group:g},depth:-1,children:roots};
    var groupAgg=_permComputeNodeAggregate(virtualGroup,rolePerms);
    var groupColor=_permAggregateColor(groupAgg);
    var isOpen=!!_permTreeOpen[g];
    var groupEsc=g.replace(/'/g,"\\'");
    // Coloured pill badge for the top-level collapsible group bar so
    // the aggregate state of every child reads at a glance: solid
    // green = every child Full, solid red = every child None, solid
    // amber = mixed.
    var groupBadge='';
    if(groupAgg==='full')      groupBadge='<span style="font-size:10px;font-weight:800;background:#16a34a;color:#fff;border:1px solid #15803d;padding:2px 10px;border-radius:10px;letter-spacing:.3px;white-space:nowrap;flex-shrink:0;box-shadow:0 1px 2px rgba(22,163,74,.25)">All Full</span>';
    else if(groupAgg==='none') groupBadge='<span style="font-size:10px;font-weight:800;background:#dc2626;color:#fff;border:1px solid #b91c1c;padding:2px 10px;border-radius:10px;letter-spacing:.3px;white-space:nowrap;flex-shrink:0;box-shadow:0 1px 2px rgba(220,38,38,.25)">All None</span>';
    else                       groupBadge='<span style="font-size:10px;font-weight:800;background:#f59e0b;color:#fff;border:1px solid #d97706;padding:2px 10px;border-radius:10px;letter-spacing:.3px;white-space:nowrap;flex-shrink:0;box-shadow:0 1px 2px rgba(245,158,11,.25)">Mixed</span>';
    // Unwrap any root whose label essentially mirrors the group name
    // and has children — the group header already serves as that
    // umbrella's row, so we promote its children up to the group level.
    // Other roots in the same group (siblings of the mirror) stay
    // where they are. A hidden span with data-perm-umbrella is emitted
    // for each unwrapped root so _permSaveRole still computes the
    // umbrella's auto-derived value at save time.
    var renderRoots=[];
    var hiddenUmbMarker='';
    roots.forEach(function(root){
      if(root.children.length&&_permItemMirrorsGroup(root.item,g)){
        var idxInFlat=items.indexOf(root.item);
        hiddenUmbMarker+='<span data-perm-umbrella="'+root.item.key+'" data-perm-group-id="'+g.replace(/"/g,'&quot;')+'" data-perm-index="'+idxInFlat+'" style="display:none"></span>';
        root.children.forEach(function(child){renderRoots.push(child);});
      } else {
        renderRoots.push(root);
      }
    });
    h+='<div style="margin-bottom:8px" data-perm-group="'+g.replace(/"/g,'&quot;')+'">';
    h+='<div onclick="_permToggleTree(\''+groupEsc+'\')" style="display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;background:linear-gradient(180deg,#f8fafc,#f1f5f9);border:1px solid var(--border);border-radius:6px;user-select:none">';
    h+='<span style="font-size:11px;color:var(--text3);width:12px;text-align:center;flex-shrink:0">'+(isOpen?'▼':'▶')+'</span>';
    h+='<span style="flex:1;font-size:13px;font-weight:900;color:'+groupColor+'">'+_permCleanLabel(g)+'</span>';
    h+=groupBadge;
    h+='</div>';
    // Always render the group's items so save selectors find them all;
    // hide via display:none when collapsed.
    h+='<div style="display:'+(isOpen?'block':'none')+';padding:6px 4px 6px 6px;background:#fff;border:1px solid var(--border);border-top:none;border-radius:0 0 6px 6px">';
    h+=hiddenUmbMarker;
    renderRoots.forEach(function(root){h+=renderNode(root,items);});
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

// Opens the Add Role modal (replaces the legacy prompt()). The modal only
// asks for a name — copy-from / reset-to-none lives in the dedicated
// "🔄 Change Access" popup so the two flows don't get tangled.
function _permAddRole(){
  var modLbl=document.getElementById('permAddRoleMod');
  if(modLbl) modLbl.textContent='('+_permActiveModule+')';
  var nameEl=document.getElementById('permAddRoleName');
  if(nameEl) nameEl.value='';
  var err=document.getElementById('merr_mPermAddRole');
  if(err) err.textContent='';
  om('mPermAddRole');
  setTimeout(function(){try{nameEl.focus();}catch(_){}},30);
}

async function _permAddRoleSave(){
  var nameEl=document.getElementById('permAddRoleName');
  var err=document.getElementById('merr_mPermAddRole');
  var setErr=function(m){if(err) err.textContent=m||'';};
  setErr('');
  var name=String((nameEl&&nameEl.value)||'').trim();
  if(!name){setErr('Role name is required.');try{nameEl.focus();}catch(_){}return;}
  var md=_permModuleData(_permActiveModule);
  if((md.roles||[]).some(function(r){return String(r).toLowerCase()===name.toLowerCase();})){
    setErr('Role "'+name+'" already exists in '+_permActiveModule+'.');return;
  }
  md.roles.push(name);
  // Tag as admin-added so the cross-module filter in _permModuleData
  // doesn't strip it (e.g. "Plant Head" added to HRMS even though it's
  // a VMS built-in).
  if(!Array.isArray(md.customRoles)) md.customRoles=[];
  if(md.customRoles.indexOf(name)<0) md.customRoles.push(name);
  // Lift any gravestone so a re-added default isn't vetoed by deletedDefaults.
  if(Array.isArray(md.deletedDefaults)) md.deletedDefaults=md.deletedDefaults.filter(function(r){return r!==name;});
  // Mirror into the legacy module-role constants so non-permission readers
  // (e.g. user-modal checkbox lists that still use the constants directly)
  // see the new role without a reload.
  if(_permActiveModule==='HRMS'&&typeof HRMS_ROLES!=='undefined'&&HRMS_ROLES.indexOf(name)<0) HRMS_ROLES.push(name);
  if(_permActiveModule==='HWMS'&&typeof HWMS_ROLES!=='undefined'&&HWMS_ROLES.indexOf(name)<0) HWMS_ROLES.push(name);
  if(_permActiveModule==='VMS' &&typeof ROLES     !=='undefined'&&ROLES.indexOf(name)<0)      ROLES.push(name);
  if(_permActiveModule==='MTTS'&&typeof MTTS_ROLES!=='undefined'&&MTTS_ROLES.indexOf(name)<0) MTTS_ROLES.push(name);
  _permActiveRole=name;
  cm('mPermAddRole');
  await _permSaveData(md);
  // Belt-and-suspenders: _permSaveData already re-renders the role list,
  // but force one more pass so the newly added role is guaranteed visible
  // even if the await raced with a parallel render cycle.
  _permRenderRoles();
  if(typeof notify==='function') notify('Role "'+name+'" added');
}

// ─── Change Access popup ──────────────────────────────────────────────
// Scope is the active module only (per user: "this button should be
// application specific"). Two modes share a single modal: copy from a
// source role into a destination role, or reset the destination role's
// access to None. Picking modes via radio so the source dropdown can be
// hidden in reset mode and the destructive intent is explicit.
function _permChangeAccessOpen(){
  var md=_permModuleData(_permActiveModule);
  var roles=(md.roles||[]).filter(function(r){return r&&r!=='Super Admin';});
  if(roles.length<1){
    if(typeof notify==='function') notify('No editable roles in '+_permActiveModule+'.',true);
    return;
  }
  var modLbl=document.getElementById('permChMod');
  if(modLbl) modLbl.textContent='('+_permActiveModule+')';
  var copyRadio=document.querySelector('input[name="permChMode"][value="copy"]');
  if(copyRadio) copyRadio.checked=true;
  var srcEl=document.getElementById('permChSrc');
  var destEl=document.getElementById('permChDest');
  var opts=roles.map(function(r){return '<option value="'+String(r).replace(/"/g,'&quot;')+'">'+r+'</option>';}).join('');
  if(srcEl) srcEl.innerHTML=opts;
  if(destEl) destEl.innerHTML=opts;
  // Default destination to the role currently being edited (if any). Then
  // default source to the first role that isn't the destination so the
  // dropdowns aren't pointing at the same value out of the gate.
  if(destEl){
    if(_permActiveRole&&_permActiveRole!=='Super Admin'&&roles.indexOf(_permActiveRole)>=0){
      destEl.value=_permActiveRole;
    } else {
      destEl.selectedIndex=0;
    }
  }
  if(srcEl&&destEl){
    var pick='';
    for(var i=0;i<roles.length;i++){ if(roles[i]!==destEl.value){pick=roles[i];break;} }
    if(pick) srcEl.value=pick;
  }
  var err=document.getElementById('merr_mPermChangeAccess');
  if(err) err.textContent='';
  _permChModeUpdate();
  om('mPermChangeAccess');
}

function _permChModeUpdate(){
  var mode=(document.querySelector('input[name="permChMode"]:checked')||{}).value||'copy';
  var wrap=document.getElementById('permChSrcWrap');
  if(wrap) wrap.style.display=(mode==='copy')?'':'none';
}

async function _permChangeAccessApply(){
  var err=document.getElementById('merr_mPermChangeAccess');
  var setErr=function(m){if(err) err.textContent=m||'';};
  setErr('');
  var mode=(document.querySelector('input[name="permChMode"]:checked')||{}).value||'copy';
  var destEl=document.getElementById('permChDest');
  var dest=String((destEl&&destEl.value)||'').trim();
  if(!dest){setErr('Pick a destination role.');return;}
  if(dest==='Super Admin'){setErr('Super Admin cannot be modified.');return;}
  var md=_permModuleData(_permActiveModule);
  if(!md.permissions) md.permissions={};
  if(mode==='copy'){
    var srcEl=document.getElementById('permChSrc');
    var src=String((srcEl&&srcEl.value)||'').trim();
    if(!src){setErr('Pick a source role.');return;}
    if(src===dest){setErr('Source and destination must be different.');return;}
    var srcPerms=md.permissions[src]||{};
    var clone={};Object.keys(srcPerms).forEach(function(k){clone[k]=srcPerms[k];});
    md.permissions[dest]=clone;
    _permActiveRole=dest;
    cm('mPermChangeAccess');
    await _permSaveData(md);
    _permRenderRoles();
    if(typeof notify==='function') notify('Access copied from "'+src+'" → "'+dest+'"');
  } else {
    md.permissions[dest]={};
    _permActiveRole=dest;
    cm('mPermChangeAccess');
    await _permSaveData(md);
    _permRenderRoles();
    if(typeof notify==='function') notify('All access reset to None for "'+dest+'"');
  }
}

function _permDeleteRole(role){
  if(role==='Super Admin'){notify('Cannot delete Super Admin',true);return;}
  if(!confirm('Delete role "'+role+'" from '+_permActiveModule+'?')) return;
  var md=_permModuleData(_permActiveModule);
  md.roles=md.roles.filter(function(r){return r!==role;});
  if(md.permissions) delete md.permissions[role];
  // Drop the custom-role flag too so the cross-module filter no longer
  // whitelists this name (relevant if the deleted role collides with
  // another module's built-in).
  if(Array.isArray(md.customRoles)) md.customRoles=md.customRoles.filter(function(r){return r!==role;});
  // If this role is one of the module's built-in defaults, remember the
  // deletion so _permModuleData won't auto-restore it on the next render.
  var defaults=_permGetDefaultRoles(_permActiveModule);
  if(defaults.indexOf(role)>=0){
    if(!Array.isArray(md.deletedDefaults)) md.deletedDefaults=[];
    if(md.deletedDefaults.indexOf(role)<0) md.deletedDefaults.push(role);
  }
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
    else perms[key]='none'; // explicit None — overrides _PERM_DEFAULTS_FULL fallback
  });
  // Scope pickers (sibling control next to the tri-state). Persisted as
  // perms[role]['<key>.scope']=<value> so the runtime resolver
  // (_hrmsResolveScope) can read it.
  body.querySelectorAll('[data-perm-scope]').forEach(function(sel){
    var key=sel.getAttribute('data-perm-scope');
    var val=String(sel.value||'').trim();
    if(val) perms[key+'.scope']=val;
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
    // Prefer the cross-group _PERM_UMBRELLA registry — covers sidebar
    // parents (page.masters / page.utilities / page.utilDailyAttSum)
    // whose children sit at the same depth as the umbrella itself, so
    // _permScopedChildren wouldn't find them. Fall back to scoped lookup
    // for nested umbrellas declared via the depth hierarchy alone.
    var explicit=(typeof _PERM_UMBRELLA!=='undefined')
                 &&_PERM_UMBRELLA[_permActiveModule]
                 &&_PERM_UMBRELLA[_permActiveModule][umbKey];
    var kidKeys;
    if(explicit){
      kidKeys=explicit.slice();
    } else {
      var groupName=el.getAttribute('data-perm-group-id');
      var items=groupsByName[groupName]||[];
      var idx=items.findIndex(function(k){return k.key===umbKey;});
      if(idx<0) return;
      kidKeys=_permScopedChildren(items,idx).map(function(c){return c.key;});
    }
    var best='none';
    kidKeys.forEach(function(ck){
      var v=perms[ck];
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

// ──────────────────────────────────────────────────────────────────────────
// V53 — BACKUP MODULE (Super Admin only)
// One Excel file per app, one sheet per table inside. Photos / base64
// blobs are skipped to keep file sizes manageable.
// ──────────────────────────────────────────────────────────────────────────

// App → list of tables that belong to it. Shared tables (users, locations)
// are included with the apps that consume them so each backup file is
// self-contained even when restored in isolation.
const _BK_APP_TABLES = {
  vms: {
    label:'VMS', icon:'🚚',
    tables:['users','locations','vehicleTypes','vendors','drivers','vehicles',
            'tripRates','trips','segments','spotTrips','hrmsSettings']
  },
  hrms: {
    label:'HRMS', icon:'👥',
    tables:['users','locations','hrmsEmployees','hrmsCompanies','hrmsCategories',
            'hrmsEmpTypes','hrmsTeams','hrmsDepartments','hrmsSubDepartments',
            'hrmsDesignations','hrmsAttendance','hrmsDayTypes','hrmsAlterations',
            'hrmsPrintFormats','hrmsSettings','hrmsAdvances','hrmsMonthData']
  },
  hwms: {
    label:'HWMS', icon:'📦',
    tables:['users','locations','hwmsParts','hwmsInvoices','hwmsContainers',
            'hwmsHsn','hwmsUom','hwmsPacking','hwmsCustomers','hwmsPortDischarge',
            'hwmsPortLoading','hwmsCarriers','hwmsCompany','hwmsSteelRates',
            'hwmsSubInvoices','hwmsMaterialRequests','hwmsPaymentReceipts',
            'hrmsSettings']
  },
  mtts: {
    label:'MTTS', icon:'🔧',
    tables:['users','locations','mttsPlants','mttsAssetTypes',
            'mttsAssetPrimaryNames','mttsAgencies','mttsAssets','mttsTickets',
            'hrmsSettings']
  },
  security: {
    label:'Security', icon:'📹',
    tables:['users','locations','checkpoints','guards','roundSchedules',
            'hrmsSettings']
  }
};

// Column-name patterns to strip from every backup row. The whitelist of
// short legitimate columns is kept narrow on purpose — anything that
// looks like a photo/image/signature payload is dropped.
const _BK_SKIP_COL_PATTERNS = [
  /^photo$/i, /photos?$/i, /_photos?$/i,
  /^picture$/i, /^image$/i, /_image$/i,
  /^signature$/i,
  /close_photos/i, /invoice_photos/i, /photos_raise/i, /photos_resume/i,
  /^avatar$/i
];

function _bkShouldSkipCol(colName){
  if(!colName) return false;
  for(var i=0;i<_BK_SKIP_COL_PATTERNS.length;i++){
    if(_BK_SKIP_COL_PATTERNS[i].test(colName)) return true;
  }
  return false;
}

// Heuristic: any string > 8KB is almost certainly base64 image bloat.
// Truncate so the cell still hints at what was there, but the file
// doesn't balloon.
function _bkScrubValue(v){
  if(v==null) return '';
  if(typeof v==='string'){
    if(v.length>8192 || /^data:[^;]+;base64,/.test(v)) return '[binary stripped]';
    return v;
  }
  if(typeof v==='object'){
    // JSONB / array values — stringify, but recursively scrub embedded
    // base64 payloads first so embedded photo arrays don't bloat the cell.
    try{
      var json=JSON.stringify(v,function(_k,_v){
        if(typeof _v==='string' && (_v.length>4096 || /^data:[^;]+;base64,/.test(_v))) return '[stripped]';
        return _v;
      });
      if(json && json.length>16384) return json.slice(0,16384)+'…[truncated]';
      return json||'';
    }catch(e){ return ''; }
  }
  return v;
}

function _bkSanitizeSheetName(name){
  // Excel sheet names: max 31 chars, no : \ / ? * [ ]
  var s=String(name||'Sheet').replace(/[:\\\/\?\*\[\]]/g,'_');
  if(s.length>31) s=s.slice(0,31);
  return s;
}

function renderPortalBackup(){
  var body=document.getElementById('bkCardsBody'); if(!body) return;
  var html='';
  Object.keys(_BK_APP_TABLES).forEach(function(appId){
    var def=_BK_APP_TABLES[appId];
    var tblCount=def.tables.length;
    html+='<div style="border:1.5px solid var(--border);border-radius:10px;padding:14px;background:#f8fafc">'+
      '<div style="font-size:14px;font-weight:900;color:var(--text);margin-bottom:6px">'+def.icon+' '+def.label+'</div>'+
      '<div style="font-size:11px;color:var(--text3);margin-bottom:10px">'+tblCount+' tables</div>'+
      '<button id="bkBtn_'+appId+'" onclick="_bkDownloadApp(\''+appId+'\')" '+
      'style="width:100%;font-size:12px;padding:8px 10px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-weight:800;cursor:pointer">'+
      '⬇ Download .xlsx</button>'+
    '</div>';
  });
  body.innerHTML=html;
  var st=document.getElementById('bkStatusBody'); if(st) st.innerHTML='';
}

function _bkSetStatus(html, append){
  var st=document.getElementById('bkStatusBody'); if(!st) return;
  if(append) st.innerHTML+=html; else st.innerHTML=html;
}

async function _bkFetchTable(tbl){
  if(!SB_TABLES[tbl]) return [];
  if(!_sb){ return DB[tbl]||[]; }
  try{
    var rows=[];
    var pageSize=1000, from=0;
    while(true){
      var res=await _sb.from(SB_TABLES[tbl]).select('*').range(from,from+pageSize-1);
      if(res.error){ console.warn('[backup] fetch failed',tbl,res.error); break; }
      var batch=res.data||[];
      rows=rows.concat(batch);
      if(batch.length<pageSize) break;
      from+=pageSize;
    }
    return rows;
  }catch(e){
    console.warn('[backup] fetch threw',tbl,e);
    return DB[tbl]||[];
  }
}

function _bkBuildSheetFromRows(tbl, rows){
  if(!rows || !rows.length){
    return {name:_bkSanitizeSheetName(tbl), data:[['(empty)']]};
  }
  // Build a stable column set: union of all keys across rows, minus
  // skip-pattern columns. Sort so output is deterministic — `id`
  // anchors first, the rest alphabetically.
  var keySet={};
  for(var i=0;i<rows.length;i++){
    var r=rows[i]; if(!r||typeof r!=='object') continue;
    for(var k in r){ if(Object.prototype.hasOwnProperty.call(r,k) && !_bkShouldSkipCol(k)) keySet[k]=true; }
  }
  var cols=Object.keys(keySet).sort(function(a,b){
    if(a==='id') return -1; if(b==='id') return 1;
    return a.localeCompare(b);
  });
  var data=[cols];
  for(var j=0;j<rows.length;j++){
    var row=rows[j]||{};
    var line=new Array(cols.length);
    for(var c=0;c<cols.length;c++) line[c]=_bkScrubValue(row[cols[c]]);
    data.push(line);
  }
  return {
    name:_bkSanitizeSheetName(tbl),
    data:data,
    stripeStart:1, stripeCount:rows.length,
    borderStart:0, borderCount:rows.length+1
  };
}

async function _bkDownloadApp(appId){
  var def=_BK_APP_TABLES[appId]; if(!def){ notify('Unknown app',true); return; }
  var btn=document.getElementById('bkBtn_'+appId);
  if(btn){ btn.disabled=true; btn.textContent='Fetching…'; btn.style.opacity='.6'; }
  _bkSetStatus('<div>⏳ Fetching <b>'+def.label+'</b> tables…</div>');
  var sheets=[];
  var totalRows=0;
  for(var i=0;i<def.tables.length;i++){
    var tbl=def.tables[i];
    _bkSetStatus('<div>⏳ '+def.label+': fetching <code>'+tbl+'</code> ('+(i+1)+'/'+def.tables.length+')…</div>');
    var rows=await _bkFetchTable(tbl);
    totalRows+=rows.length;
    sheets.push(_bkBuildSheetFromRows(tbl,rows));
  }
  if(typeof _downloadMultiSheetXlsx!=='function'){
    notify('Excel writer not available',true);
    if(btn){ btn.disabled=false; btn.textContent='⬇ Download .xlsx'; btn.style.opacity='1'; }
    return;
  }
  var stamp=new Date();
  var fname='KAP-'+def.label+'-Backup-'+
    stamp.getFullYear()+
    String(stamp.getMonth()+1).padStart(2,'0')+
    String(stamp.getDate()).padStart(2,'0')+'-'+
    String(stamp.getHours()).padStart(2,'0')+
    String(stamp.getMinutes()).padStart(2,'0')+'.xlsx';
  _downloadMultiSheetXlsx(sheets,fname);
  _bkSetStatus('<div>✅ <b>'+def.label+'</b> — '+sheets.length+' sheets, '+totalRows.toLocaleString()+' rows → <code>'+fname+'</code></div>',true);
  if(btn){ btn.disabled=false; btn.textContent='⬇ Download .xlsx'; btn.style.opacity='1'; }
}

async function _bkDownloadAll(){
  var btn=document.getElementById('bkAllBtn');
  if(btn){ btn.disabled=true; btn.textContent='⏳ Working…'; btn.style.opacity='.6'; }
  _bkSetStatus('');
  var keys=Object.keys(_BK_APP_TABLES);
  for(var i=0;i<keys.length;i++){
    await _bkDownloadApp(keys[i]);
  }
  if(btn){ btn.disabled=false; btn.textContent='⬇ Download All'; btn.style.opacity='1'; }
  _bkSetStatus('<div style="margin-top:8px;font-weight:700;color:#15803d">✅ All backups generated.</div>',true);
}
