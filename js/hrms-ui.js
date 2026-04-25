/** @file hrms-ui.js — UI layer for the HRMS module (employees, attendance, salary, masters) @depends common.js, hrms-logic.js */

// ═══ GUARD / DEPENDENCY CHECK ═════════════════════════════════════════════
if(typeof _sb==='undefined'||typeof DB==='undefined'){
  document.body.innerHTML='<div style="padding:40px;text-align:center;color:#dc2626"><h2>⚠ js/common.js not loaded</h2></div>';
}

// ═══ BOOT / SESSION RESTORE ═════════════════════════════════════════════
if(typeof _APP_TABLES!=='undefined') _APP_TABLES=['users','hrmsEmployees','hrmsCompanies','hrmsCategories','hrmsEmpTypes','hrmsTeams','hrmsDepartments','hrmsSubDepartments','hrmsDesignations','hrmsDayTypes','hrmsPrintFormats','hrmsSettings'];
// hrmsAttendance loaded on-demand per month, not on boot

// ── Boot — no separate login, uses portal session ──
(async function(){
  try{await bootDB();}catch(e){console.error('HRMS boot error:',e);}
  var splash=document.getElementById('dbSplash');
  if(splash) splash.style.display='none';
  // Restore session from portal (cache-based, no RPC needed)
  var su=_sessionGet('kap_session_user')||localStorage.getItem('kap_rm_user');
  var st=_sessionGet('kap_session_token')||localStorage.getItem('kap_rm_token');
  if(su&&st){
    var u=null;
    try{var _cu=localStorage.getItem('kap_current_user');if(_cu)u=JSON.parse(_cu);if(!u||u.name.toLowerCase()!==su.toLowerCase())u=null;}catch(e){u=null;}
    // Prefer the live DB record over the cached one — admin may have
    // updated roles/apps since this session was created.
    var freshU=(DB.users||[]).find(function(x){return x&&x.name&&x.name.toLowerCase()===su.toLowerCase();});
    if(freshU) u=freshU;
    if(u){
      // Role gate — block direct URL access when user has no HRMS role.
      var _isSA=((u.roles||[]).indexOf('Super Admin')>=0)
        ||((u.hrmsRoles||[]).indexOf('Super Admin')>=0);
      if(!_isSA && !((u.hrmsRoles||[]).length)){
        if(typeof notify==='function') notify('⚠ You do not have access to HRMS.',true);
        _navigateTo('index.html');
        return;
      }
      CU=u;_enrichCU();_hrmsLaunch();return;
    }
  }
  // No valid session — redirect to portal login
  setTimeout(function(){_navigateTo('index.html');},2000);
})();

function _hrmsLaunch(){
  var lp=document.getElementById('loginPage');if(lp)lp.style.display='none';
  document.getElementById('hrmsApp').style.display='block';
  document.getElementById('topbar').style.display='flex';
  document.getElementById('hrmsUserName').textContent=CU.fullName||CU.name;
  // Disable background polling — HRMS doesn't need live sync
  if(typeof _bgPollTimer!=='undefined'&&_bgPollTimer){clearInterval(_bgPollTimer);_bgPollTimer=null;}
  // Disable auto-refresh views — only manual refresh
  _onRefreshViews=function(){};
  _hrmsLoadPermissions();
  _hrmsEnforcePermissions();
  renderHrmsDashboard();
  renderHrmsEmployees();
  _hrmsUpdateChangeReqBadge();
  _hrmsLoadStatutory();
  _hrmsLoadRolls();
  // Build the empCodes-with-records index in the background. Once it
  // resolves, the employee list re-renders so trash icons disappear from
  // rows whose linked attendance/advances/etc. weren't in the boot payload.
  if(typeof _hrmsLoadEmpsWithRecordsIndex==='function') _hrmsLoadEmpsWithRecordsIndex();
  // Navigate to first allowed page
  var _firstPage=['pageHrmsDashboard','pageHrmsEmployees','pageHrmsAttSal','pageHrmsAttRules'];
  var _pagePerms={'pageHrmsDashboard':'page.dashboard','pageHrmsEmployees':'page.employees','pageHrmsAttSal':'page.attSal','pageHrmsAttRules':'page.attRules'};
  var _startPage='pageHrmsAttSal';
  for(var _pi=0;_pi<_firstPage.length;_pi++){if(_hrmsHasAccess(_pagePerms[_firstPage[_pi]])){_startPage=_firstPage[_pi];break;}}
  hrmsGo(_startPage);
}

async function _hrmsManualRefresh(){
  notify('🔄 Refreshing data…');
  showSpinner('Fetching latest data…');
  try{
    if(_sb&&_sbReady){
      await Promise.all((_APP_TABLES||[]).map(async function(tbl){
        var sbTbl=SB_TABLES[tbl];if(!sbTbl) return;
        var sel=typeof _syncSelect==='function'?_syncSelect(sbTbl):'*';
        var res=await _sb.from(sbTbl).select(sel).limit(10000);
        if(!res.error&&res.data) DB[tbl]=res.data.map(function(r){return _fromRow(tbl,r);}).filter(Boolean);
      }));
    }
    renderHrmsDashboard();
    renderHrmsEmployees();
    _hrmsUpdateChangeReqBadge();
    hideSpinner();
    notify('✅ Data refreshed — '+((DB.hrmsEmployees||[]).length)+' employees loaded');
  }catch(e){hideSpinner();notify('⚠ Refresh failed: '+e.message,true);}
}
var _hrmsPageTitles={
  pageHrmsDashboard:'Dashboard',
  pageHrmsEmployees:'Employees',
  pageHrmsEmpEdit:'Employees',
  pageHrmsAttSal:'Attendance & Salary',
  pageHrmsAttRules:'Attendance Rules',
  pageHrmsMCompany:'Masters — Plant',
  pageHrmsMCategory:'Masters — Category',
  pageHrmsMEmpType:'Masters — Employment Type',
  pageHrmsMTeam:'Masters — Team',
  pageHrmsMDept:'Masters — Department',
  pageHrmsMSubDept:'Masters — Department-Staff',
  pageHrmsMDesig:'Masters — Designation',
  pageHrmsMRoll:'Masters — Role',
  pageHrmsMAllocation:'Masters — Allocation',
  pageHrmsUtilAttConv:'Utilities — Attendance Excel Converter',
  pageHrmsUtilDailyAtt:'Utilities — Daily Attendance Summary',
  pageHrmsUtilMonthlyHc:'Utilities — Monthly Headcount Graph'
};

function _hrmsUpdateTopTitle(){
  var el=document.getElementById('topbarTitle');if(!el) return;
  var pid=(document.querySelector('.page.active')||{}).id||'';
  var base=_hrmsPageTitles[pid]||'';
  var suffix='';
  // Append month for month-aware pages
  if(pid==='pageHrmsAttSal'&&_hrmsMonth){
    var p=_hrmsMonth.split('-');
    suffix=' — '+_MONTH_NAMES[+p[1]]+' '+p[0];
  }
  el.textContent=base?('HRMS : '+base+suffix):'HRMS';
}

// Page → permission key mapping
var _HRMS_PAGE_PERMS={
  pageHrmsDashboard:'page.dashboard',pageHrmsEmployees:'page.employees',pageHrmsAttSal:'page.attSal',
  pageHrmsAttRules:'page.attRules',pageHrmsMCompany:'page.masterPlant',pageHrmsMCategory:'page.masterCategory',
  pageHrmsMEmpType:'page.masterEmpType',pageHrmsMTeam:'page.masterTeam',pageHrmsMDept:'page.masterDept',
  pageHrmsMSubDept:'page.masterSubDept',pageHrmsMDesig:'page.masterDesig',pageHrmsMRoll:'page.masterRoll',pageHrmsMAllocation:'page.masterAllocation',
  pageHrmsUtilAttConv:'page.utilAttConv',
  pageHrmsUtilDailyAtt:'page.utilDailyAttSum',
  pageHrmsUtilMonthlyHc:'page.utilMonthlyHc'
};

function _hrmsEnforcePermissions(){
  // Hide sidebar nav items the user can't access
  var navPerms={navDashboard:'page.dashboard',navEmployees:'page.employees',navAttSal:'page.attSal',navAttRules:'page.attRules',navUtilAttConv:'page.utilAttConv',navUtilDailyAtt:'page.utilDailyAttSum',navUtilMonthlyHc:'page.utilMonthlyHc'};
  Object.keys(navPerms).forEach(function(navId){
    var el=document.getElementById(navId);
    if(el) el.style.display=_hrmsHasAccess(navPerms[navId])?'':'none';
  });
  // Masters menu
  var mastersNav=document.querySelector('[onclick*="_hrmsToggleMasters"]');
  if(mastersNav) mastersNav.style.display=_hrmsHasAccess('page.masters')?'':'none';
  var mastersGroup=document.getElementById('hrmsMastersGroup');
  if(mastersGroup){
    var mPerms={navMCompany:'page.masterPlant',navMCategory:'page.masterCategory',navMEmpType:'page.masterEmpType',navMTeam:'page.masterTeam',navMDept:'page.masterDept',navMSubDept:'page.masterSubDept',navMDesig:'page.masterDesig',navMRoll:'page.masterRoll',navMAllocation:'page.masterAllocation'};
    Object.keys(mPerms).forEach(function(navId){
      var el=document.getElementById(navId);
      if(el) el.style.display=_hrmsHasAccess(mPerms[navId])?'':'none';
    });
  }
  // Utilities menu (parent toggle + child items)
  var utilsNav=document.querySelector('[onclick*="_hrmsToggleUtilities"]');
  if(utilsNav) utilsNav.style.display=_hrmsHasAccess('page.utilities')?'':'none';
  // Hide action buttons based on permissions
  var btnPerms={
    btnImportEmployees:'action.importEmployees',
    btnExportEmployees:'action.exportEmployees',
    btnAddEmployee:'action.addEmployee',
    btnAddMonth:'action.addMonth',
    btnSaveLock:'action.saveLock',
    btnUnlock:'action.unlock',
    btnAddPrintFormat:'action.addPrintFormat',
    btnImportSalExcel:'action.bulkSalRevision',
    btnApproveAllAlt:'action.approveAlt'
  };
  Object.keys(btnPerms).forEach(function(btnId){
    var el=document.getElementById(btnId);
    if(el&&!_hrmsHasAccess(btnPerms[btnId])) el.style.display='none';
  });
}

function hrmsGo(pid){
  // Permission check — block access to denied pages
  var permKey=_HRMS_PAGE_PERMS[pid];
  if(permKey&&!_hrmsHasAccess(permKey)){notify('Access denied',true);return;}
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active');});
  document.querySelectorAll('.nav-item').forEach(function(n){n.classList.remove('active');});
  var pg=document.getElementById(pid);if(pg)pg.classList.add('active');
  var navMap={pageHrmsDashboard:'navDashboard',pageHrmsEmployees:'navEmployees',pageHrmsEmpEdit:'navEmployees',pageHrmsAttSal:'navAttSal',pageHrmsAttRules:'navAttRules',pageHrmsMCompany:'navMCompany',pageHrmsMCategory:'navMCategory',pageHrmsMEmpType:'navMEmpType',pageHrmsMTeam:'navMTeam',pageHrmsMDept:'navMDept',pageHrmsMSubDept:'navMSubDept',pageHrmsMDesig:'navMDesig',pageHrmsMRoll:'navMRoll',pageHrmsMAllocation:'navMAllocation',pageHrmsUtilAttConv:'navUtilAttConv',pageHrmsUtilDailyAtt:'navUtilDailyAtt',pageHrmsUtilMonthlyHc:'navUtilMonthlyHc'};
  var nid=navMap[pid];if(nid){var ne=document.getElementById(nid);if(ne)ne.classList.add('active');}
  _hrmsUpdateTopTitle();
  // Re-render the employee list whenever the user lands on the page — the
  // initial boot render may have happened before DB.hrmsEmployees finished
  // loading, which left the table empty until a filter change forced a
  // re-render.
  if(pid==='pageHrmsEmployees') renderHrmsEmployees();
  if(pid==='pageHrmsAttSal'){
    // Find first allowed main tab
    var _mainTabs=['settings','attendance','salary','payments','esipf','pt','contract'];
    var _mainTabPerms={settings:'tab.settings',attendance:'tab.attendance',salary:'tab.salary',payments:'tab.payments',esipf:'tab.esipf',pt:'tab.pt',contract:'tab.contract'};
    var _defTab='attendance';
    for(var _ti=0;_ti<_mainTabs.length;_ti++){if(_hrmsHasAccess(_mainTabPerms[_mainTabs[_ti]])){_defTab=_mainTabs[_ti];break;}}
    _hrmsActiveMainTab=_defTab;
    // Default month: keep the user's current selection if set; otherwise pick
    // the current calendar month if data exists for it, else the most recent
    // month with data, else today's YYYY-MM as a harmless fallback.
    (async function(){
      var _dm=_hrmsMonth;
      if(!_dm){
        try{ await _hrmsAttFetchIndex(); }catch(e){}
        var _now=new Date();
        var _thisMk=_now.getFullYear()+'-'+String(_now.getMonth()+1).padStart(2,'0');
        var _idx=_hrmsAttMonthIndex||[];
        if(_idx.some(function(m){return m.monthKey===_thisMk;})) _dm=_thisMk;
        else if(_idx.length) _dm=_idx[0].monthKey; // already sorted desc
        else _dm=_thisMk;
      }
      _hrmsSelectMonth(_dm).then(function(){_hrmsMainTab(_defTab);_hrmsUpdateTopTitle();});
    })();
  }
  if(pid.indexOf('pageHrmsM')===0){
    if(pid==='pageHrmsMRoll') _hrmsRenderRollMaster();
    else if(pid==='pageHrmsMAllocation') _hrmsRenderAllocationMaster();
    else renderHrmsMaster(pid);
    document.getElementById('hrmsMastersGroup').style.display='block';
    document.getElementById('hrmsMastersArrow').textContent='▼';
  }
  if(pid.indexOf('pageHrmsUtil')===0){
    var _ug=document.getElementById('hrmsUtilsGroup');if(_ug) _ug.style.display='block';
    var _ua=document.getElementById('hrmsUtilsArrow');if(_ua) _ua.textContent='▼';
    if(pid==='pageHrmsUtilAttConv'&&typeof _hrmsAttConvRender==='function') _hrmsAttConvRender();
    if(pid==='pageHrmsUtilDailyAtt'){
      var _di=document.getElementById('hrmsDasHistDate');
      if(_di&&!_di.value){
        var _dnow=new Date();
        _di.value=_dnow.getFullYear()+'-'+String(_dnow.getMonth()+1).padStart(2,'0')+'-'+String(_dnow.getDate()).padStart(2,'0');
      }
      if(typeof _hrmsDasRender==='function') _hrmsDasRender();
    }
    if(pid==='pageHrmsUtilMonthlyHc'&&typeof _hrmsMhgInit==='function') _hrmsMhgInit();
  }
  document.querySelector('.sidebar').classList.remove('open');
  document.querySelector('.sidebar-overlay').classList.remove('show');
}

// ═══ NAVIGATION / SIDEBAR ════════════════════════════════════════════════
function _hrmsToggleMasters(){
  var g=document.getElementById('hrmsMastersGroup');
  var a=document.getElementById('hrmsMastersArrow');
  var open=g.style.display==='none';
  g.style.display=open?'block':'none';
  a.textContent=open?'▼':'▶';
}
function _hrmsToggleUtilities(){
  var g=document.getElementById('hrmsUtilsGroup');
  var a=document.getElementById('hrmsUtilsArrow');
  if(!g||!a) return;
  var open=g.style.display==='none';
  g.style.display=open?'block':'none';
  a.textContent=open?'▼':'▶';
}

// ===== SIDEBAR TOGGLE =====
var _hrmsSidebarHidden=false;
function _hrmsToggleSidebar(){
  var sb=document.querySelector('.sidebar');
  if(window.innerWidth>700){
    _hrmsSidebarHidden=!_hrmsSidebarHidden;
    sb.style.left=_hrmsSidebarHidden?'-280px':'0';
    document.getElementById('topbar').style.marginLeft=_hrmsSidebarHidden?'0':'260px';
    document.getElementById('hrmsApp').style.marginLeft=_hrmsSidebarHidden?'0':'260px';
  } else {
    sb.classList.toggle('open');
    document.querySelector('.sidebar-overlay').classList.toggle('show');
  }
}

// ═══ MASTERS (company, category, empType, team, dept, designation) ═══════
var HRMS_MASTERS={
  pageHrmsMCompany:{tbl:'hrmsCompanies',label:'Plant',icon:'🏭',empField:'location'},
  pageHrmsMCategory:{tbl:'hrmsCategories',label:'Category',icon:'🏷',empField:'category'},
  pageHrmsMEmpType:{tbl:'hrmsEmpTypes',label:'Employment Type',icon:'📋',empField:'employmentType'},
  pageHrmsMTeam:{tbl:'hrmsTeams',label:'Team',icon:'👥',empField:'teamName',extra:'empType',extraLabel:'Employment Type'},
  pageHrmsMDept:{tbl:'hrmsDepartments',label:'Department',icon:'🏛',empField:'department'},
  pageHrmsMSubDept:{tbl:'hrmsSubDepartments',label:'Department-Staff',icon:'📁',empField:'subDepartment'},
  pageHrmsMDesig:{tbl:'hrmsDesignations',label:'Designation',icon:'🎖',empField:'designation'}
};

var _hrmsTeamEtFilter='';// current employment-type filter on team master page

// Count usages of each master value across ALL employees — both the flat
// field AND every historical / revision period. An employee is counted at
// most once per master value even if the value recurs in several periods,
// which keeps the number meaningful ("employees ever using this").
// Drill-down for the master pages' Employees column. Lists every employee
// whose flat field or any period field equals `value` for the given
// `empField`. Codes are clickable → open the View/Edit Employee modal.
function _hrmsMasterShowEmps(empField,value,label,empTypeFilter){
  var v=String(value||'').trim();
  if(!v){notify('No value to filter by',true);return;}
  var etFilter=String(empTypeFilter||'').toLowerCase().replace(/\s/g,'');
  var matches=(DB.hrmsEmployees||[]).filter(function(e){
    var hit=((e[empField]||'')+'').trim()===v||(e.periods||[]).some(function(p){return((p&&p[empField]||'')+'').trim()===v;});
    if(!hit) return false;
    if(etFilter){
      var ap=(e.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
      var et=(((ap&&ap.employmentType)||e.employmentType||'')+'').toLowerCase().replace(/\s/g,'');
      if(et!==etFilter) return false;
    }
    return true;
  });
  matches.sort(function(a,b){
    var an=parseInt((a.empCode||'').replace(/\D/g,''))||0;
    var bn=parseInt((b.empCode||'').replace(/\D/g,''))||0;
    if(an!==bn) return an-bn;
    return(a.empCode||'').localeCompare(b.empCode||'');
  });
  var _esc=function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
  var rowsHtml='';
  if(!matches.length){
    rowsHtml='<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text3)">No employees found.</td></tr>';
  } else {
    matches.forEach(function(e,i){
      var ecEsc=_esc(e.empCode).replace(/'/g,"\\'");
      var status=(e.status||'Active');
      var stClr=status==='Active'?'#15803d':'#dc2626';
      rowsHtml+='<tr style="border-bottom:1px solid #f1f5f9">'
        +'<td style="padding:5px 8px;color:var(--text3);font-size:11px">'+(i+1)+'</td>'
        +'<td style="padding:5px 8px;font-family:var(--mono);font-weight:800"><a href="javascript:void(0)" onclick="document.getElementById(\'_hrmsMasDetailOverlay\').remove();_hrmsOpenEmpByCode(\''+ecEsc+'\')" style="color:var(--accent);text-decoration:underline" title="View / edit employee">'+_esc(e.empCode)+'</a></td>'
        +'<td style="padding:5px 8px;font-weight:700">'+_esc(e.name||'')+'</td>'
        +'<td style="padding:5px 8px">'+_esc(e.location||'—')+'</td>'
        +'<td style="padding:5px 8px">'+_esc(e.employmentType||'—')+'</td>'
        +'<td style="padding:5px 8px;color:'+stClr+';font-weight:700">'+_esc(status)+'</td>'
        +'</tr>';
    });
  }
  var html=''
   +'<div id="_hrmsMasDetailOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:10000" onclick="if(event.target===this)this.remove()">'
   +'<div style="background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:88vh;overflow:auto;width:min(720px,94vw);padding:0">'
   +'<div style="padding:14px 18px;border-bottom:2px solid var(--accent-light);display:flex;justify-content:space-between;align-items:start;gap:12px">'
   +'<div><div style="font-size:11px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:1px">'+_esc(label||empField)+(empTypeFilter?(' &middot; '+_esc(empTypeFilter)):'')+'</div><div style="font-size:16px;font-weight:900;margin-top:2px">'+_esc(value)+' &mdash; '+matches.length+' employee(s)</div></div>'
   +'<button onclick="document.getElementById(\'_hrmsMasDetailOverlay\').remove()" style="background:transparent;border:none;font-size:22px;cursor:pointer;color:var(--text3);line-height:1">×</button>'
   +'</div>'
   +'<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:#f1f5f9">'
   +'<th style="padding:6px 8px;font-size:11px;font-weight:800;text-align:left">#</th>'
   +'<th style="padding:6px 8px;font-size:11px;font-weight:800;text-align:left">Emp Code</th>'
   +'<th style="padding:6px 8px;font-size:11px;font-weight:800;text-align:left">Name</th>'
   +'<th style="padding:6px 8px;font-size:11px;font-weight:800;text-align:left">Plant</th>'
   +'<th style="padding:6px 8px;font-size:11px;font-weight:800;text-align:left">Emp Type</th>'
   +'<th style="padding:6px 8px;font-size:11px;font-weight:800;text-align:left">Status</th>'
   +'</tr></thead><tbody>'+rowsHtml+'</tbody></table>'
   +'</div></div>';
  var prior=document.getElementById('_hrmsMasDetailOverlay');if(prior) prior.remove();
  var tmp=document.createElement('div');tmp.innerHTML=html;
  document.body.appendChild(tmp.firstChild);
}

// CURRENT counts — what each master value is in use by RIGHT NOW (active
// approved period, or flat field as fallback). Used by the master listing's
// "Employees" column so changing a department reflects immediately.
function _hrmsMasterUsageCounts(empField){
  var out={};
  (DB.hrmsEmployees||[]).forEach(function(e){
    if(e._isNewEcr) return;// pending creations not yet official
    var ap=(e.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
    var v=(((ap&&ap[empField])||e[empField]||'')+'').trim();
    if(v) out[v]=(out[v]||0)+1;
  });
  return out;
}

// Same as _hrmsMasterUsageCounts but breaks the count down by employment-type
// bucket. Returns { value: {OnRoll:n, Contract:n, PieceRate:n, Visitor:n,
// Other:n, Total:n} }. Used by the Department / Department-Staff masters to
// show the headcount split.
function _hrmsMasterUsageCountsByEmpType(empField){
  var out={};
  (DB.hrmsEmployees||[]).forEach(function(e){
    if(e._isNewEcr) return;
    var ap=(e.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
    var v=(((ap&&ap[empField])||e[empField]||'')+'').trim();
    if(!v) return;
    var et=(((ap&&ap.employmentType)||e.employmentType||'')+'').toLowerCase().replace(/\s/g,'');
    var bucket='Other';
    if(et==='onroll') bucket='OnRoll';
    else if(et==='contract') bucket='Contract';
    else if(et==='piecerate') bucket='PieceRate';
    else if(et==='visitor') bucket='Visitor';
    if(!out[v]) out[v]={OnRoll:0,Contract:0,PieceRate:0,Visitor:0,Other:0,Total:0};
    out[v][bucket]++;
    out[v].Total++;
  });
  return out;
}

// HISTORICAL counts — every value EVER referenced by this employee across
// flat field + every period (including closed/proposed/rejected). Used by
// delete protection so a master entry can't be removed while any historical
// period still references it (avoids orphaning old salary calcs / reports).
function _hrmsMasterUsageCountsAny(empField){
  var out={};
  (DB.hrmsEmployees||[]).forEach(function(e){
    var seen={};
    var flat=((e[empField]||'')+'').trim();
    if(flat) seen[flat]=true;
    (e.periods||[]).forEach(function(p){
      var v=((p&&p[empField]||'')+'').trim();
      if(v) seen[v]=true;
    });
    Object.keys(seen).forEach(function(v){ out[v]=(out[v]||0)+1; });
  });
  return out;
}

function renderHrmsMaster(pid){
  var c=HRMS_MASTERS[pid];if(!c)return;
  var pg=document.getElementById(pid);if(!pg)return;
  var items=(DB[c.tbl]||[]).slice().sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});
  var counts=_hrmsMasterUsageCounts(c.empField);
  // Historical (any-period) counts gate the delete icon so we don't promise
  // a deletion that the protection check will then reject.
  var anyCounts=_hrmsMasterUsageCountsAny(c.empField);
  var hasExtra=!!c.extra;
  var isTeam=c.tbl==='hrmsTeams';

  // Team master: filter teams by employment type
  if(isTeam&&_hrmsTeamEtFilter){
    var bucket=_hrmsEtBucket(_hrmsTeamEtFilter);
    items=items.filter(function(t){return _hrmsEtBucket(t.empType)===bucket;});
  }

  // View-only masters: hide Add / Edit / Delete, show "View Only" badge.
  var _canEditMaster=_hrmsHasAccess('masters.edit');
  var h='<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">';
  h+='<div style="font-size:18px;font-weight:900">'+c.icon+' '+c.label+' Master</div>';
  h+='<div style="display:flex;gap:8px">';
  if(_canEditMaster) h+='<button class="btn btn-primary" onclick="_hrmsAddMaster(\''+pid+'\')">+ Add</button>';
  else h+='<span style="font-size:11px;padding:6px 12px;background:var(--surface2);border:1.5px dashed var(--border2);border-radius:6px;color:var(--text3);font-style:italic">🔒 View Only</span>';
  h+='</div></div>';

  // Team master: filter buttons (counts of teams per emp type)
  if(isTeam){
    var allTeams=(DB[c.tbl]||[]);
    var tCounts={All:allTeams.length,OnRoll:0,Contract:0,PieceRate:0,Visitor:0};
    allTeams.forEach(function(t){var b=_hrmsEtBucket(t.empType);if(b) tCounts[b]++;});
    var btnDefs=[['','All','var(--accent)','var(--accent)','var(--accent-light)',tCounts.All],
      ['On Roll','On Roll','#15803d','#86efac','#dcfce7',tCounts.OnRoll],
      ['Contract','Contract','#1d4ed8','#93c5fd','#dbeafe',tCounts.Contract],
      ['Piece Rate','Piece Rate','#7c3aed','#c4b5fd','#f3e8ff',tCounts.PieceRate],
      ['Visitor','Visitor','#a16207','#fde047','#fef9c3',tCounts.Visitor]];
    h+='<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">';
    btnDefs.forEach(function(b){
      var active=(b[0]===_hrmsTeamEtFilter);
      h+='<button onclick="_hrmsTeamEtFilterSet(\''+b[0]+'\')" style="padding:6px 14px;font-size:12px;font-weight:'+(active?'800':'700')+';border:2px solid '+b[3]+';background:'+(active?b[4]:'#fff')+';color:'+b[2]+';border-radius:20px;cursor:pointer">'+b[1]+' <span style="font-weight:800">'+b[5]+'</span></button>';
    });
    h+='</div>';
  }

  var isPlant=c.tbl==='hrmsCompanies';
  // Department / Department-Staff masters split the headcount column into
  // On Roll / Contract / Piece Rate sub-columns and surface totals at the top.
  var isDept=c.tbl==='hrmsDepartments'||c.tbl==='hrmsSubDepartments';
  var byEt=isDept?_hrmsMasterUsageCountsByEmpType(c.empField):null;
  if(isDept){
    var grandTotals={OnRoll:0,Contract:0,PieceRate:0,Visitor:0,Other:0,Total:0};
    Object.keys(byEt).forEach(function(k){
      ['OnRoll','Contract','PieceRate','Visitor','Other','Total'].forEach(function(b){grandTotals[b]+=byEt[k][b]||0;});
    });
    var lblEscG=String(c.label||'').replace(/'/g,"\\'");
    var chip=function(label,n,color,bg){return '<div style="padding:6px 14px;border:1.5px solid '+color+';border-radius:6px;font-size:12px;background:'+bg+'"><span style="color:'+color+';font-weight:700">'+label+':</span> <span style="font-weight:800;font-family:var(--mono);color:'+color+'">'+n+'</span></div>';};
    h+='<div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap">';
    h+=chip('Total',grandTotals.Total,'var(--text2)','var(--surface2)');
    h+=chip('On Roll',grandTotals.OnRoll,'#15803d','#f0fdf4');
    h+=chip('Contract',grandTotals.Contract,'#1d4ed8','#eff6ff');
    h+=chip('Piece Rate',grandTotals.PieceRate,'#7c3aed','#faf5ff');
    if(grandTotals.Visitor) h+=chip('Visitor',grandTotals.Visitor,'#a16207','#fef9c3');
    if(grandTotals.Other) h+=chip('Other',grandTotals.Other,'#64748b','#f1f5f9');
    h+='</div>';
  }
  h+='<div class="table-wrap" style="max-height:calc(100vh - 200px)"><table><thead><tr><th>#</th>';
  if(isPlant) h+='<th>Color</th>';
  h+='<th>'+c.label+'</th>';
  if(hasExtra) h+='<th>'+(c.extraLabel||c.extra)+'</th>';
  if(isDept){
    h+='<th style="text-align:center">On Roll</th><th style="text-align:center">Contract</th><th style="text-align:center">Piece Rate</th><th style="text-align:center;background:#f8fafc">Total</th>';
  } else {
    h+='<th>Employees</th>';
  }
  h+='<th>Actions</th></tr></thead><tbody>';
  var deptExtraCols=isDept?3:0;// Contract + Piece Rate + Total beyond Employees
  var colSpan=(hasExtra?5:4)+(isPlant?1:0)+deptExtraCols;
  if(!items.length) h+='<tr><td colspan="'+colSpan+'" class="empty-state">No records. Click "Sync from Employees" to populate.</td></tr>';
  else items.forEach(function(it,i){
    var cnt=counts[it.name]||0;
    h+='<tr><td style="font-family:var(--mono);color:var(--text3)">'+(i+1)+'</td>';
    if(isPlant){
      var clr=it.color||'#e2e8f0';
      h+='<td><span onclick="_hrmsPickPlantColor(\''+it.id+'\')" style="display:inline-block;width:28px;height:18px;border-radius:4px;background:'+clr+';border:1px solid rgba(0,0,0,.15);cursor:pointer;vertical-align:middle" title="Click to change color"></span></td>';
    }
    h+='<td style="font-weight:700">'+it.name+'</td>';
    if(hasExtra){
      if(c.extra==='empType'){
        var etVal=it.empType||'';
        var etColors={'on roll':'#dcfce7;color:#15803d','onroll':'#dcfce7;color:#15803d','contract':'#dbeafe;color:#1d4ed8','piece rate':'#f3e8ff;color:#7c3aed','piecerate':'#f3e8ff;color:#7c3aed'};
        var etBg=etColors[(etVal||'').toLowerCase().replace(/\s/g,'')]||'#f1f5f9;color:#475569';
        h+='<td><span onclick="_hrmsChangeTeamEmpType(\''+pid+'\',\''+it.id+'\')" style="display:inline-block;padding:3px 10px;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;background:'+etBg+';border:1px solid rgba(0,0,0,.1)" title="Click to change">'+(etVal||'Not Set')+'</span></td>';
      } else {
        h+='<td>'+(it[c.extra]||'—')+'</td>';
      }
    }
    if(isDept){
      var nameEsc=String(it.name||'').replace(/'/g,"\\'");
      var lblEsc=String(c.label||'').replace(/'/g,"\\'");
      var br=byEt[it.name]||{OnRoll:0,Contract:0,PieceRate:0,Total:0};
      var renderSub=function(n,etLit,clr){
        if(n>0) return '<td style="text-align:center"><a href="javascript:void(0)" onclick="_hrmsMasterShowEmps(\''+c.empField+'\',\''+nameEsc+'\',\''+lblEsc+'\',\''+etLit+'\')" style="font-family:var(--mono);font-weight:800;color:'+clr+';text-decoration:underline;cursor:pointer" title="Show employees">'+n+'</a></td>';
        return '<td style="text-align:center;font-family:var(--mono);font-weight:700;color:var(--text3)">'+n+'</td>';
      };
      h+=renderSub(br.OnRoll||0,'On Roll','#15803d');
      h+=renderSub(br.Contract||0,'Contract','#1d4ed8');
      h+=renderSub(br.PieceRate||0,'Piece Rate','#7c3aed');
      // Total cell — clickable (no empType filter)
      var totN=br.Total||0;
      if(totN>0){
        h+='<td style="text-align:center;background:#f8fafc"><a href="javascript:void(0)" onclick="_hrmsMasterShowEmps(\''+c.empField+'\',\''+nameEsc+'\',\''+lblEsc+'\')" style="font-family:var(--mono);font-weight:900;color:var(--accent);text-decoration:underline;cursor:pointer" title="Show all employees">'+totN+'</a></td>';
      } else {
        h+='<td style="text-align:center;background:#f8fafc;font-family:var(--mono);font-weight:700;color:var(--text3)">'+totN+'</td>';
      }
    } else if(cnt>0){
      var nameEsc=String(it.name||'').replace(/'/g,"\\'");
      var lblEsc=String(c.label||'').replace(/'/g,"\\'");
      h+='<td><a href="javascript:void(0)" onclick="_hrmsMasterShowEmps(\''+c.empField+'\',\''+nameEsc+'\',\''+lblEsc+'\')" style="font-family:var(--mono);font-weight:800;color:var(--accent);text-decoration:underline;cursor:pointer" title="Show employees">'+cnt+'</a></td>';
    } else {
      h+='<td style="font-family:var(--mono);font-weight:700;color:var(--text3)">'+cnt+'</td>';
    }
    if(_canEditMaster){
      h+='<td><button onclick="_hrmsEditMaster(\''+pid+'\',\''+it.id+'\')" style="padding:3px 10px;font-size:11px;font-weight:700;background:#fef3c7;border:1px solid #fde047;color:#a16207;border-radius:4px;cursor:pointer">✏️</button>';
      // Hide delete once this master value has been referenced anywhere —
      // flat field or historical/revision period. Rename (edit) is still
      // allowed so typos can be fixed without abandoning the record.
      var anyCnt=anyCounts[it.name]||0;
      if(anyCnt===0) h+=' <button onclick="_hrmsDelMaster(\''+pid+'\',\''+it.id+'\')" style="padding:3px 10px;font-size:11px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer">🗑</button>';
      h+='</td></tr>';
    } else {
      h+='<td><span style="font-size:10px;color:var(--text3);font-style:italic">—</span></td></tr>';
    }
  });
  h+='</tbody></table></div></div>';
  pg.innerHTML=h;
}

// 50-color palette for plant badges
var HRMS_PLANT_COLORS=[
  // Greys
  '#f8fafc','#e2e8f0','#cbd5e1','#94a3b8','#64748b','#475569','#334155','#1e293b',
  // Reds
  '#fecaca','#fca5a5','#f87171','#ef4444','#dc2626',
  // Oranges
  '#fed7aa','#fdba74','#fb923c','#f97316','#ea580c',
  // Yellows / Lemon
  '#fef9c3','#fef08a','#fde047','#facc15','#eab308',
  // Greens
  '#d9f99d','#bef264','#86efac','#4ade80','#22c55e','#16a34a',
  // Teals
  '#99f6e4','#5eead4','#2dd4bf','#14b8a6',
  // Blues
  '#bae6fd','#7dd3fc','#38bdf8','#0ea5e9','#3b82f6','#2563eb',
  // Indigos / Purples
  '#c7d2fe','#a5b4fc','#818cf8','#6366f1','#c4b5fd','#a855f7','#8b5cf6',
  // Pinks
  '#fce7f3','#f9a8d4','#f472b6','#ec4899','#db2777'
];

function _hrmsPickPlantColor(plantId){
  var old=document.getElementById('hrmsPlantColorPop');if(old)old.remove();
  var it=byId(DB.hrmsCompanies||[],plantId);if(!it)return;
  var pop=document.createElement('div');
  pop.id='hrmsPlantColorPop';
  pop.style.cssText='position:fixed;z-index:999;background:#fff;border:1.5px solid var(--border);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.15);padding:10px;width:260px;top:50%;left:50%;transform:translate(-50%,-50%)';
  var h='<div style="font-size:12px;font-weight:800;margin-bottom:8px">Pick color for: '+it.name+'</div>';
  h+='<div style="display:flex;flex-wrap:wrap;gap:4px">';
  HRMS_PLANT_COLORS.forEach(function(c){
    var sel=c===it.color;
    h+='<div onclick="_hrmsSetPlantColor(\''+plantId+'\',\''+c+'\')" style="width:22px;height:22px;border-radius:4px;background:'+c+';cursor:pointer;border:'+(sel?'3px solid #1e293b':'1.5px solid rgba(0,0,0,.1)')+'" title="'+c+'"></div>';
  });
  h+='</div>';
  h+='<div style="margin-top:8px;text-align:right"><button onclick="document.getElementById(\'hrmsPlantColorPop\').remove()" style="font-size:11px;padding:4px 12px;border-radius:4px;border:1.5px solid #475569;background:#f8f9fb;cursor:pointer">Close</button></div>';
  pop.innerHTML=h;
  document.body.appendChild(pop);
}

async function _hrmsSetPlantColor(plantId,color){
  if(!_hrmsHasAccess('masters.edit')){notify('⚠ You have view-only access to masters.',true);return;}
  var it=byId(DB.hrmsCompanies||[],plantId);if(!it)return;
  it.color=color;
  await _dbSave('hrmsCompanies',it);
  var pop=document.getElementById('hrmsPlantColorPop');if(pop)pop.remove();
  renderHrmsMaster('pageHrmsMCompany');
}

function _hrmsGetPlantColor(plantName){
  var p=(DB.hrmsCompanies||[]).find(function(c){return c.name===plantName;});
  return p&&p.color?p.color:'#e2e8f0';
}

// Pending master save callback (used by empType picker)
var _hrmsMasterPendingCb=null;

function _hrmsShowEmpTypePicker(current,cb){
  var old=document.getElementById('hrmsEmpTypePop');if(old)old.remove();
  var types=(DB.hrmsEmpTypes||[]).map(function(t){return t.name;}).sort();
  if(!types.length){cb(prompt('Employment Type:',current||'')||current||'');return;}
  var pop=document.createElement('div');
  pop.id='hrmsEmpTypePop';
  pop.style.cssText='position:fixed;z-index:999;background:#fff;border:1.5px solid var(--border);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.15);padding:12px;top:50%;left:50%;transform:translate(-50%,-50%);min-width:220px';
  var h='<div style="font-size:13px;font-weight:800;margin-bottom:8px">Select Employment Type</div>';
  types.forEach(function(t){
    var sel=t===current;
    h+='<div onclick="_hrmsPickEmpType(\''+t.replace(/'/g,"\\'")+'\')" style="padding:8px 12px;cursor:pointer;border-radius:6px;margin-bottom:4px;font-weight:'+(sel?'800':'600')+';background:'+(sel?'var(--accent-light)':'var(--surface2)')+';border:1.5px solid '+(sel?'var(--accent)':'var(--border)')+';color:'+(sel?'var(--accent)':'var(--text)')+'">'+t+'</div>';
  });
  h+='<div style="text-align:right;margin-top:8px"><button onclick="document.getElementById(\'hrmsEmpTypePop\').remove()" style="font-size:11px;padding:4px 12px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);cursor:pointer">Cancel</button></div>';
  pop.innerHTML=h;
  _hrmsMasterPendingCb=cb;
  document.body.appendChild(pop);
}

function _hrmsChangeTeamEmpType(pid,id){
  if(!_hrmsHasAccess('masters.edit')){notify('⚠ You have view-only access to masters.',true);return;}
  var it=byId(DB.hrmsTeams||[],id);if(!it)return;
  _hrmsShowEmpTypePicker(it.empType||'',async function(val){
    var oldType=it.empType||'';
    it.empType=val;
    if(!await _dbSave('hrmsTeams',it))return;
    // Update all employees under this team
    var updated=0;
    var emps=(DB.hrmsEmployees||[]).filter(function(e){return e.teamName===it.name;});
    for(var i=0;i<emps.length;i++){
      emps[i].employmentType=val;
      if(await _dbSave('hrmsEmployees',emps[i])) updated++;
    }
    renderHrmsMaster(pid);
    notify('Employment Type updated'+(updated?' — '+updated+' employee(s) synced':''));
  });
}

function _hrmsPickEmpType(val){
  var pop=document.getElementById('hrmsEmpTypePop');if(pop)pop.remove();
  if(_hrmsMasterPendingCb){_hrmsMasterPendingCb(val);_hrmsMasterPendingCb=null;}
}

function _hrmsAddMaster(pid){
  if(!_hrmsHasAccess('masters.edit')){notify('⚠ You have view-only access to masters.',true);return;}
  var c=HRMS_MASTERS[pid];if(!c)return;
  var hasExtra=!!c.extra;
  var name=prompt('Enter '+c.label+' name:');
  if(!name||!name.trim())return;
  name=name.trim();
  if((DB[c.tbl]||[]).find(function(x){return x.name===name;})){notify(c.label+' "'+name+'" already exists',true);return;}
  var rec={id:'hm'+uid(),name:name};
  if(c.extra==='empType'){
    _hrmsShowEmpTypePicker('',function(val){
      rec.empType=val;
      _dbSave(c.tbl,rec).then(function(ok){if(ok){renderHrmsMaster(pid);notify(c.label+' added');}});
    });
  } else if(hasExtra){
    rec[c.extra]=(prompt((c.extraLabel||c.extra)+':','')||'').trim();
    _dbSave(c.tbl,rec).then(function(ok){if(ok){renderHrmsMaster(pid);notify(c.label+' added');}});
  } else {
    _dbSave(c.tbl,rec).then(function(ok){if(ok){renderHrmsMaster(pid);notify(c.label+' added');}});
  }
}

function _hrmsEditMaster(pid,id){
  if(!_hrmsHasAccess('masters.edit')){notify('⚠ You have view-only access to masters.',true);return;}
  var c=HRMS_MASTERS[pid];if(!c)return;
  var it=byId(DB[c.tbl]||[],id);if(!it)return;
  var hasExtra=!!c.extra;
  var name=prompt('Edit '+c.label+' name:',it.name);
  if(!name||!name.trim())return;
  name=name.trim();
  var oldName=it.name;
  if(name!==oldName&&(DB[c.tbl]||[]).find(function(x){return x.name===name&&x.id!==id;})){notify(c.label+' "'+name+'" already exists',true);return;}
  it.name=name;
  var _doSave=function(){
    _dbSave(c.tbl,it).then(function(ok){
      if(ok){
        if(name!==oldName){
          var field=c.empField;
          (DB.hrmsEmployees||[]).forEach(function(e){
            if(e[field]===oldName){e[field]=name;_dbSave('hrmsEmployees',e);}
          });
        }
        renderHrmsMaster(pid);notify(c.label+' updated');
      }
    });
  };
  if(c.extra==='empType'){
    _hrmsShowEmpTypePicker(it.empType||'',function(val){it.empType=val;_doSave();});
  } else if(hasExtra){
    it[c.extra]=(prompt((c.extraLabel||c.extra)+':',it[c.extra]||'')||'').trim();
    _doSave();
  } else {
    _doSave();
  }
  _dbSave(c.tbl,it).then(function(ok){
    if(ok){
      // Update employee records that used the old name
      if(name!==oldName){
        var field=c.empField;
        (DB.hrmsEmployees||[]).forEach(function(e){
          if(e[field]===oldName){e[field]=name;_dbSave('hrmsEmployees',e);}
        });
      }
      renderHrmsMaster(pid);notify(c.label+' updated');
    }
  });
}

async function _hrmsDelMaster(pid,id){
  if(!_hrmsHasAccess('masters.edit')){notify('⚠ You have view-only access to masters.',true);return;}
  var c=HRMS_MASTERS[pid];if(!c)return;
  var it=byId(DB[c.tbl]||[],id);if(!it)return;
  // Period-aware usage check — matches renderHrmsMaster's Employees column.
  // Delete protection looks at HISTORICAL references (flat + every period)
  // so we don't orphan old salary/attendance calcs.
  var cnt=(_hrmsMasterUsageCountsAny(c.empField)[it.name])||0;
  if(cnt>0){notify('Cannot delete — '+c.label+' "'+it.name+'" is used by '+cnt+' employee(s) (including past revisions).',true);return;}
  if(!confirm('Delete '+c.label+': "'+it.name+'"?'))return;
  if(await _dbDel(c.tbl,id)){renderHrmsMaster(pid);notify(c.label+' deleted');}
}

async function _hrmsSeedMaster(pid){
  var c=HRMS_MASTERS[pid];if(!c)return;
  var emps=DB.hrmsEmployees||[];
  var existing=DB[c.tbl]||[];
  var hasExtra=!!c.extra;
  var unique={};
  emps.forEach(function(e){
    var v=(e[c.empField]||'').trim();
    if(!v)return;
    var key=v.toLowerCase();
    if(!unique[key]) unique[key]={name:v};
    if(hasExtra&&e.department) unique[key].department=e.department;
  });
  var added=0;
  for(var k in unique){
    if(existing.find(function(x){return(x.name||'').toLowerCase()===k;})) continue;
    var rec={id:'hm'+uid(),name:unique[k].name};
    if(hasExtra) rec.department=unique[k].department||'';
    if(await _dbSave(c.tbl,rec)) added++;
  }
  renderHrmsMaster(pid);
  notify(added?'Added '+added+' new '+c.label+'(s)':'All '+c.label+'s already exist');
}

function om(id){var el=document.getElementById(id);if(el){el.style.display='flex';el.classList.add('open');}}
function cm(id){var el=document.getElementById(id);if(el){el.style.display='none';el.classList.remove('open');}}
function modalErr(mid,msg){var el=document.getElementById(mid+'Err');if(el){el.textContent=msg;el.style.display='block';}}

// ═══ DASHBOARD ══════════════════════════════════════════════════════════
function renderHrmsDashboard(){
  var el=document.getElementById('hrmsDashContent');if(!el)return;
  var emps=(DB.hrmsEmployees||[]).filter(function(e){return(e.status||'Active')==='Active';});
  var allEmps=DB.hrmsEmployees||[];
  var active=emps.length;
  var left=allEmps.filter(function(e){return e.status==='Left';}).length;
  var onRoll=emps.filter(function(e){return(e.employmentType||'').toLowerCase()==='on roll';}).length;
  var contract=emps.filter(function(e){return(e.employmentType||'').toLowerCase()==='contract';}).length;
  var pieceRate=emps.filter(function(e){return(e.employmentType||'').toLowerCase()==='piece rate';}).length;

  var h='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">';
  h+='<div style="flex:1;min-width:100px;background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:10px;padding:12px;text-align:center"><div style="font-size:9px;font-weight:700;color:#1d4ed8;text-transform:uppercase">Total Active</div><div style="font-size:26px;font-weight:900;color:#2563eb">'+active+'</div></div>';
  h+='<div style="flex:1;min-width:100px;background:#dcfce7;border:1.5px solid #86efac;border-radius:10px;padding:12px;text-align:center"><div style="font-size:9px;font-weight:700;color:#15803d;text-transform:uppercase">On Roll</div><div style="font-size:26px;font-weight:900;color:#16a34a">'+onRoll+'</div></div>';
  h+='<div style="flex:1;min-width:100px;background:#dbeafe;border:1.5px solid #93c5fd;border-radius:10px;padding:12px;text-align:center"><div style="font-size:9px;font-weight:700;color:#1d4ed8;text-transform:uppercase">Contract</div><div style="font-size:26px;font-weight:900;color:#2563eb">'+contract+'</div></div>';
  h+='<div style="flex:1;min-width:100px;background:#f3e8ff;border:1.5px solid #c4b5fd;border-radius:10px;padding:12px;text-align:center"><div style="font-size:9px;font-weight:700;color:#7c3aed;text-transform:uppercase">Piece Rate</div><div style="font-size:26px;font-weight:900;color:#7c3aed">'+pieceRate+'</div></div>';
  h+='<div style="flex:1;min-width:100px;background:#fef2f2;border:1.5px solid #fecaca;border-radius:10px;padding:12px;text-align:center"><div style="font-size:9px;font-weight:700;color:#991b1b;text-transform:uppercase">Left</div><div style="font-size:26px;font-weight:900;color:#dc2626">'+left+'</div></div>';
  h+='</div>';

  // Team counts
  var contractTeams={},prTeams={};
  emps.forEach(function(e){
    var t=(e.teamName||'').trim();if(!t)return;
    if((e.employmentType||'').toLowerCase()==='contract') contractTeams[t]=1;
    if((e.employmentType||'').toLowerCase()==='piece rate') prTeams[t]=1;
  });
  h+='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">';
  h+='<div style="flex:1;min-width:140px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px"><div style="font-size:10px;font-weight:700;color:#1d4ed8;text-transform:uppercase">Contractor Teams</div><div style="font-size:22px;font-weight:900;color:#2563eb">'+Object.keys(contractTeams).length+'</div></div>';
  h+='<div style="flex:1;min-width:140px;background:#faf5ff;border:1px solid #c4b5fd;border-radius:8px;padding:10px 14px"><div style="font-size:10px;font-weight:700;color:#7c3aed;text-transform:uppercase">Piece Rate Teams</div><div style="font-size:22px;font-weight:900;color:#7c3aed">'+Object.keys(prTeams).length+'</div></div>';
  h+='</div>';

  // Plant-wise breakdown table
  var plants={};
  emps.forEach(function(e){
    var p=e.location||'Unassigned';
    if(!plants[p]) plants[p]={onRoll:0,contract:0,pieceRate:0,total:0};
    plants[p].total++;
    var et=(e.employmentType||'').toLowerCase();
    if(et==='on roll') plants[p].onRoll++;
    else if(et==='contract') plants[p].contract++;
    else if(et==='piece rate') plants[p].pieceRate++;
  });
  var plantKeys=Object.keys(plants).sort();
  if(plantKeys.length){
    var _th='padding:8px 10px;font-size:11px;font-weight:800;border-bottom:2px solid #94a3b8';
    h+='<div style="font-size:14px;font-weight:900;margin-bottom:8px">Plant-wise Employee Count (Active)</div>';
    h+='<div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#1e293b;color:#fff">';
    h+='<th style="'+_th+';text-align:left;color:#fff">Plant</th>';
    h+='<th style="'+_th+';text-align:right;color:#86efac">On Roll</th>';
    h+='<th style="'+_th+';text-align:right;color:#93c5fd">Contract</th>';
    h+='<th style="'+_th+';text-align:right;color:#c4b5fd">Piece Rate</th>';
    h+='<th style="'+_th+';text-align:right;color:#fff">Total</th>';
    h+='</tr></thead><tbody>';
    var gOnRoll=0,gContract=0,gPR=0,gTotal=0;
    plantKeys.forEach(function(pk){
      var d=plants[pk];gOnRoll+=d.onRoll;gContract+=d.contract;gPR+=d.pieceRate;gTotal+=d.total;
      var pClr=_hrmsGetPlantColor(pk);
      h+='<tr style="border-bottom:1px solid #e2e8f0">'
        +'<td style="padding:6px 10px;font-weight:700"><span style="background:'+pClr+';padding:2px 8px;border-radius:4px">'+pk+'</span></td>'
        +'<td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-weight:700;color:#15803d">'+d.onRoll+'</td>'
        +'<td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-weight:700;color:#1d4ed8">'+d.contract+'</td>'
        +'<td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-weight:700;color:#7c3aed">'+d.pieceRate+'</td>'
        +'<td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-weight:900">'+d.total+'</td>'
        +'</tr>';
    });
    h+='<tr style="background:#1e293b;color:#fff"><td style="padding:6px 10px;font-weight:900;color:#fff">Total</td>'
      +'<td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-weight:900;color:#86efac">'+gOnRoll+'</td>'
      +'<td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-weight:900;color:#93c5fd">'+gContract+'</td>'
      +'<td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-weight:900;color:#c4b5fd">'+gPR+'</td>'
      +'<td style="padding:6px 10px;text-align:right;font-family:var(--mono);font-weight:900;color:#fff">'+gTotal+'</td></tr>';
    h+='</tbody></table></div>';
  }
  el.innerHTML=h;
}

// ═══ EMPLOYEES (list, edit, modal, period tracking) ═════════════════════
var _hrmsEmpSortKey='empCode',_hrmsEmpSortAsc=true;
var _hrmsEmpSortCols=['empCode','name','location','employmentType','teamName','category','roll','rateDay'];
function _hrmsEmpSort(key){
  if(_hrmsEmpSortKey===key)_hrmsEmpSortAsc=!_hrmsEmpSortAsc;
  else{_hrmsEmpSortKey=key;_hrmsEmpSortAsc=true;}
  _hrmsEmpUpdateSortIcons();
  renderHrmsEmployees();
}
function _hrmsEmpUpdateSortIcons(){
  _hrmsEmpSortCols.forEach(function(col){
    var el=document.getElementById('hrmsEmpSortI_'+col);
    if(el) el.textContent=col===_hrmsEmpSortKey?(_hrmsEmpSortAsc?'▲':'▼'):'⇅';
  });
}
function _hrmsEmpClearFilters(){
  var s1=document.getElementById('hrmsEmpCodeSearch');if(s1)s1.value='';
  var s2=document.getElementById('hrmsEmpNameSearch');if(s2)s2.value='';
  ['hrmsEmpFPlant','hrmsEmpFType','hrmsEmpFTeam','hrmsEmpFCat','hrmsEmpFDept','hrmsEmpFRoll'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});
  renderHrmsEmployees();
}

function _hrmsTeamEtFilterSet(val){
  _hrmsTeamEtFilter=val;
  renderHrmsMaster('pageHrmsMTeam');
}

var _hrmsEmpTypeFilterVal='';

// Normalize an employment-type label to a bucket key: 'OnRoll' | 'Contract' | 'PieceRate' | 'Visitor' | ''
function _hrmsEtBucket(et){
  var s=(et||'').toLowerCase().replace(/\s/g,'');
  if(s==='onroll') return 'OnRoll';
  if(s==='contract') return 'Contract';
  if(s==='piecerate') return 'PieceRate';
  if(s==='visitor') return 'Visitor';
  return '';
}

// Count active employees per employment-type bucket
function _hrmsCountByEmpType(emps,onlyActive){
  if(onlyActive===undefined) onlyActive=true;// default: Active-only
  var c={All:0,OnRoll:0,Contract:0,PieceRate:0,Visitor:0};
  (emps||[]).forEach(function(e){
    var ap=(e.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
    if(onlyActive){
      // Mirror the employee-list "Show only Active/Present" filter:
      //  • flat status must be Active AND active period's status must be Active.
      if((e.status||'Active')!=='Active') return;
      if(ap&&(ap.status||'Active')!=='Active') return;
    }
    c.All++;
    var et=(ap&&ap.employmentType)||e.employmentType||'';
    var b=_hrmsEtBucket(et);if(b) c[b]++;
  });
  return c;
}

function _hrmsUpdateEtfCounts(){
  // Exclude employees whose initial ECR hasn't been approved yet — they aren't
  // official records until then, and they're already counted in the Change
  // Requests tab badge.
  var pool=(DB.hrmsEmployees||[]).filter(function(e){return !e._isNewEcr;});
  // Honour the "Show only Active/Present" checkbox on the Employees page so
  // the pill counts always match the visible row count.
  var chk=document.getElementById('hrmsEmpOnlyActive');
  var onlyActive=chk?chk.checked:true;
  var c=_hrmsCountByEmpType(pool,onlyActive);
  ['All','OnRoll','Contract','PieceRate','Visitor'].forEach(function(k){
    var el=document.getElementById('hrmsEtfCount_'+k);if(el) el.textContent=c[k];
  });
}

function _hrmsEmpTypeFilter(val){
  _hrmsEmpTypeFilterVal=val;
  // Update button styles
  var btns={All:'hrmsEtfAll','On Roll':'hrmsEtfOnRoll',Contract:'hrmsEtfContract','Piece Rate':'hrmsEtfPieceRate',Visitor:'hrmsEtfVisitor'};
  var colors={All:'var(--accent)','On Roll':'#15803d',Contract:'#1d4ed8','Piece Rate':'#7c3aed',Visitor:'#a16207'};
  var borders={All:'var(--accent)','On Roll':'#86efac',Contract:'#93c5fd','Piece Rate':'#c4b5fd',Visitor:'#fde047'};
  Object.keys(btns).forEach(function(k){
    var el=document.getElementById(btns[k]);if(!el)return;
    var isActive=(k==='All'&&!val)||(k===val);
    el.style.background=isActive?(k==='All'?'var(--accent-light)':''):'#fff';
    el.style.fontWeight=isActive?'800':'700';
    el.style.borderColor=isActive?(borders[k]||'var(--border)'):(borders[k]||'var(--border)');
    el.style.color=isActive?(colors[k]||'var(--text)'):(colors[k]||'var(--text3)');
    if(isActive) el.style.background=k==='All'?'var(--accent-light)':el.style.borderColor.replace(')',',0.15)').replace('rgb','rgba');
  });
  // Also set the Type dropdown to match
  var fType=document.getElementById('hrmsEmpFType');
  if(fType) fType.value=val;
  renderHrmsEmployees();
}
async function _hrmsMarkAllActive(){
  var inactive=(DB.hrmsEmployees||[]).filter(function(e){
    var et=(e.employmentType||'').toLowerCase();
    return(et==='contract'||et==='piece rate')&&(e.status||'Active')!=='Active';
  });
  if(!inactive.length){notify('All Contract & Piece Rate employees are already Active');return;}
  if(!confirm('Mark '+inactive.length+' Contract & Piece Rate employee(s) as Active?')) return;
  showSpinner('Marking active…');
  var count=0;
  for(var i=0;i<inactive.length;i++){
    inactive[i].status='Active';
    if(await _dbSave('hrmsEmployees',inactive[i])) count++;
  }
  hideSpinner();
  renderHrmsEmployees();renderHrmsDashboard();
  notify('✅ '+count+' employee(s) marked Active');
}
// Find Active Contract / Piece Rate employees with zero attendance in the
// given month. Presence = any ESSL punch, alteration day, or non-zero
// manual P/OT/OTS/PL override for that month. On-Roll employees are NEVER
// auto-deactivated by this rule (per policy).
async function _hrmsAbsentCPRTargets(mk){
  if(!mk) return [];
  await _hrmsAttFetchMonth(mk);
  var presentCodes={};
  (_hrmsAttCache[mk]||[]).forEach(function(a){
    var days=a.days||{};
    for(var dk in days){var dd=days[dk];if(dd&&(dd['in']||dd['out'])){presentCodes[a.empCode]=true;break;}}
  });
  (_hrmsAltCache&&_hrmsAltCache[mk]||[]).forEach(function(a){if(a.days&&Object.keys(a.days).length) presentCodes[a.empCode]=true;});
  (DB.hrmsEmployees||[]).forEach(function(e){
    var ex=e.extra||{};var v;
    v=ex.manualP&&ex.manualP[mk];if(v!==undefined&&v!==null&&+v>0){presentCodes[e.empCode]=true;return;}
    v=ex.manualPL&&ex.manualPL[mk];if(v!==undefined&&v!==null&&+v>0){presentCodes[e.empCode]=true;return;}
    v=ex.manualOT&&ex.manualOT[mk];if(v!==undefined&&v!==null&&+v>0){presentCodes[e.empCode]=true;return;}
    v=ex.manualOTS&&ex.manualOTS[mk];if(v!==undefined&&v!==null&&+v>0){presentCodes[e.empCode]=true;return;}
  });
  return (DB.hrmsEmployees||[]).filter(function(e){
    if((e.status||'Active')!=='Active') return false;
    var et=(e.employmentType||'').toLowerCase().replace(/\s/g,'');
    if(et!=='contract'&&et!=='piecerate') return false;
    return !presentCodes[e.empCode];
  });
}

// Sync Contract / Piece Rate employees' status to their attendance for the
// month: present → Active, absent → Inactive. Each status change is pushed
// as a new period revision (from=mk onward) rather than a flat-field mutation,
// so the Organization & Salary table shows the history. On-Roll employees
// are NEVER touched. Employees already in 'Left' state are skipped.
// Returns number of employee records updated. `silent` = no toasts.
async function _hrmsAutoMarkAbsentInactive(mk,silent){
  if(!mk) return 0;
  await _hrmsAttFetchMonth(mk);
  // Build presence map (same rules as _hrmsAbsentCPRTargets)
  var presence={};
  (_hrmsAttCache[mk]||[]).forEach(function(a){
    var days=a.days||{};
    for(var dk in days){var dd=days[dk];if(dd&&(dd['in']||dd['out'])){presence[a.empCode]=true;break;}}
  });
  (_hrmsAltCache&&_hrmsAltCache[mk]||[]).forEach(function(a){if(a.days&&Object.keys(a.days).length) presence[a.empCode]=true;});
  (DB.hrmsEmployees||[]).forEach(function(e){
    var ex=e.extra||{};var v;
    v=ex.manualP&&ex.manualP[mk];if(v!==undefined&&v!==null&&+v>0){presence[e.empCode]=true;return;}
    v=ex.manualPL&&ex.manualPL[mk];if(v!==undefined&&v!==null&&+v>0){presence[e.empCode]=true;return;}
    v=ex.manualOT&&ex.manualOT[mk];if(v!==undefined&&v!==null&&+v>0){presence[e.empCode]=true;return;}
    v=ex.manualOTS&&ex.manualOTS[mk];if(v!==undefined&&v!==null&&+v>0){presence[e.empCode]=true;return;}
  });

  var yr=+mk.split('-')[0], mo=+mk.split('-')[1];
  var mEnd=mk+'-'+String(new Date(yr,mo,0).getDate()).padStart(2,'0');
  var prevY=yr, prevM=mo-1; if(prevM<1){prevM=12;prevY--;}
  var prevMk=prevY+'-'+String(prevM).padStart(2,'0');

  var _norm=function(v){return ((v||'')+'').toLowerCase().replace(/\s/g,'');};
  var count=0;
  var emps=(DB.hrmsEmployees||[]).slice();
  for(var i=0;i<emps.length;i++){
    var emp=emps[i];
    if(emp.dateOfJoining&&emp.dateOfJoining>mEnd) continue;// not joined yet
    // Active period (open-ended, approved/plain).
    var curP=(emp.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
    // Skip On-Roll employees entirely — on-roll status is MANUAL
    // (Present / Resigned). If EITHER the flat field or the active period
    // says on-roll, skip. Only employees who are Contract or Piece Rate in
    // both views get auto-status.
    var etFlat=_norm(emp.employmentType);
    var etPeriod=_norm(curP&&curP.employmentType);
    if(etFlat==='onroll'||etPeriod==='onroll') continue;
    var et=etPeriod||etFlat;
    if(et!=='contract'&&et!=='piecerate') continue;
    var curStatus=(curP&&curP.status)||emp.status||'Active';
    if(curStatus==='Left') continue;// never auto-override a Left tag
    var desired=presence[emp.empCode]?'Active':'Inactive';
    if(curStatus===desired) continue;

    emp.periods=emp.periods||[];
    if(curP){
      if((curP.from||'')===mk){
        curP.status=desired;
        curP.dateOfLeft=desired==='Inactive'?mEnd:'';
      } else {
        curP.to=prevMk;
        var newP={};Object.keys(curP).forEach(function(k){newP[k]=curP[k];});
        newP.from=mk;newP.to=null;
        newP.status=desired;
        newP.dateOfLeft=desired==='Inactive'?mEnd:'';
        delete newP._wfStatus;delete newP._ecrResult;
        emp.periods.unshift(newP);
      }
    } else {
      // Legacy employee with empty periods — materialize from flat fields.
      var base={
        from:((emp.dateOfJoining||'').slice(0,7))||mk, to:null,
        location:emp.location||'',employmentType:emp.employmentType||'',
        category:emp.category||'',teamName:emp.teamName||'',
        department:emp.department||'',subDepartment:emp.subDepartment||'',
        designation:emp.designation||'',roll:emp.roll||'',
        reportingTo:emp.reportingTo||'',
        salaryDay:+emp.salaryDay||0,salaryMonth:+emp.salaryMonth||0,
        specialAllowance:+emp.specialAllowance||0,
        esiApplicable:emp.esiApplicable||'',
        status:curStatus, dateOfLeft:''
      };
      if((base.from||'')>=mk){
        base.status=desired;
        base.dateOfLeft=desired==='Inactive'?mEnd:'';
        emp.periods.push(base);
      } else {
        var closedP=Object.assign({},base,{to:prevMk,status:curStatus,dateOfLeft:''});
        var openP=Object.assign({},base,{from:mk,to:null,status:desired,dateOfLeft:desired==='Inactive'?mEnd:''});
        emp.periods.push(closedP);
        emp.periods.unshift(openP);
      }
    }
    // Sync flat fields so list view + dashboards reflect the change.
    emp.status=desired;
    emp.dateOfLeft=desired==='Inactive'?mEnd:'';
    if(typeof _hrmsSanitize==='function') _hrmsSanitize(emp);
    if(typeof _hrmsSanitizePeriods==='function') _hrmsSanitizePeriods(emp.periods);
    if(await _dbSave('hrmsEmployees',emp)) count++;
  }
  if(!silent){
    renderHrmsEmployees();renderHrmsDashboard();
    notify('✅ '+count+' contract/piece-rate employee(s) status synced for '+_hrmsMonthLabel(mk));
  }
  return count;
}

async function _hrmsMarkAbsentInactive(){
  // Manual-trigger version — uses the last calendar month and shows a confirm.
  var now=new Date();now.setMonth(now.getMonth()-1);
  var lastMk=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  var targets=await _hrmsAbsentCPRTargets(lastMk);
  if(!targets.length){notify('No absent Contract/Piece Rate employees found for '+_hrmsMonthLabel(lastMk));return;}
  if(!confirm('Mark '+targets.length+' Contract & Piece Rate employee(s) with zero attendance in '+_hrmsMonthLabel(lastMk)+' as Inactive?')) return;
  showSpinner('Marking inactive…');
  var count=await _hrmsAutoMarkAbsentInactive(lastMk,true);
  hideSpinner();
  renderHrmsEmployees();renderHrmsDashboard();
  notify('✅ '+count+' employee(s) marked Inactive');
}
function renderHrmsEmployees(){
  var body=document.getElementById('hrmsEmpBody');if(!body)return;
  var allEmps=DB.hrmsEmployees||[];
  // Update employment-type filter button counts (active employees only)
  _hrmsUpdateEtfCounts();
  // Populate filter dropdowns (preserve current selection)
  var _fillF=function(id,field){
    var el=document.getElementById(id);if(!el)return;
    var cur=el.value;
    var vals={};allEmps.forEach(function(e){if(e[field])vals[e[field]]=true;});
    var h='<option value="">All</option>';
    var sortedVals=Object.keys(vals).sort();
    sortedVals.forEach(function(v){h+='<option value="'+v+'">'+v+'</option>';});
    el.innerHTML=h;
    // Only restore previous value if it exists in the new options, else reset to All
    el.value=(cur&&sortedVals.indexOf(cur)>=0)?cur:'';
  };
  _fillF('hrmsEmpFPlant','location');
  _fillF('hrmsEmpFType','employmentType');
  _fillF('hrmsEmpFTeam','teamName');
  _fillF('hrmsEmpFCat','category');
  _fillF('hrmsEmpFRoll','roll');
  // Department dropdown — populated from both department + subDepartment
  // fields so Worker (Department) and Staff (Department-Staff) values both
  // appear in one filter list.
  (function(){
    var el=document.getElementById('hrmsEmpFDept');
    if(!el) return;
    var cur=el.value;
    var vals={};
    allEmps.forEach(function(e){
      var ap=(e.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
      var cat=(((ap&&ap.category)||e.category||'')+'').toLowerCase();
      var v=cat.indexOf('staff')>=0?((ap&&ap.subDepartment)||e.subDepartment||''):((ap&&ap.department)||e.department||'');
      v=String(v||'').trim();
      if(v) vals[v]=true;
    });
    var sortedVals=Object.keys(vals).sort();
    var html='<option value="">All</option>';
    sortedVals.forEach(function(v){html+='<option value="'+v+'">'+v+'</option>';});
    el.innerHTML=html;
    el.value=(cur&&sortedVals.indexOf(cur)>=0)?cur:'';
  })();

  // Effective rate/day for the list column — reads directly from the
  // employee's salaryDay (kept in sync with the active period on save).
  var _empRateDay=function(e){ return +e.salaryDay||0; };
  // Effective department — Worker uses department, Staff uses subDepartment
  // (Department-Staff). Falls back to flat fields when no active period.
  var _empDept=function(e){
    var ap=(e.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
    var cat=(((ap&&ap.category)||e.category||'')+'').toLowerCase();
    if(cat.indexOf('staff')>=0) return((ap&&ap.subDepartment)||e.subDepartment||'');
    return((ap&&ap.department)||e.department||'');
  };

  var emps=allEmps.slice();
  var codeSearch=(document.getElementById('hrmsEmpCodeSearch')?.value||'').toLowerCase();
  var nameSearch=(document.getElementById('hrmsEmpNameSearch')?.value||'').toLowerCase();
  var fPlant=(document.getElementById('hrmsEmpFPlant')?.value||'');
  var fType=(document.getElementById('hrmsEmpFType')?.value||'')||_hrmsEmpTypeFilterVal;
  var fTeam=(document.getElementById('hrmsEmpFTeam')?.value||'');
  var fCat=(document.getElementById('hrmsEmpFCat')?.value||'');
  var fDept=(document.getElementById('hrmsEmpFDept')?.value||'');
  var fRoll=(document.getElementById('hrmsEmpFRoll')?.value||'');
  var onlyActive=document.getElementById('hrmsEmpOnlyActive')?document.getElementById('hrmsEmpOnlyActive').checked:true;
  emps=emps.filter(function(e){
    if(codeSearch&&(e.empCode||'').toLowerCase().indexOf(codeSearch)<0) return false;
    if(nameSearch&&(e.name||'').toLowerCase().indexOf(nameSearch)<0) return false;
    if(fPlant&&e.location!==fPlant) return false;
    if(fType&&e.employmentType!==fType) return false;
    if(fTeam&&e.teamName!==fTeam) return false;
    if(fCat&&e.category!==fCat) return false;
    if(fDept&&_empDept(e)!==fDept) return false;
    if(fRoll&&(e.roll||'')!==fRoll) return false;
    if(onlyActive){
      // Consider EITHER the flat status field OR the active period's status —
      // if either one says Inactive/Resigned, hide. Prevents stale flat fields
      // (where the period was updated but the emp header wasn't synced) from
      // leaking resigned employees through the filter.
      var _ap=(e.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
      var _flatOk=(e.status||'Active')==='Active';
      var _periodOk=!_ap||(_ap.status||'Active')==='Active';
      if(!_flatOk||!_periodOk) return false;
    }
    return true;
  });
  var sk=_hrmsEmpSortKey,sa=_hrmsEmpSortAsc;
  emps.sort(function(a,b){
    if(sk==='empCode'){var an=parseInt((a.empCode||'').replace(/\D/g,''))||0,bn=parseInt((b.empCode||'').replace(/\D/g,''))||0;return sa?an-bn:bn-an;}
    if(sk==='rateDay'){var ar=_empRateDay(a),br=_empRateDay(b);return sa?ar-br:br-ar;}
    if(sk==='department'){var ad=_empDept(a).toLowerCase(),bd=_empDept(b).toLowerCase();return sa?ad.localeCompare(bd):bd.localeCompare(ad);}
    var av=(a[sk]||'').toString().toLowerCase();var bv=(b[sk]||'').toString().toLowerCase();return sa?av.localeCompare(bv):bv.localeCompare(av);
  });
  var _etBg=function(t){var m={'on roll':'#dcfce7;color:#15803d','onroll':'#dcfce7;color:#15803d','contract':'#dbeafe;color:#1d4ed8','piece rate':'#f3e8ff;color:#7c3aed','piecerate':'#f3e8ff;color:#7c3aed'};return m[(t||'').toLowerCase().replace(/\s/g,'')]||'#f1f5f9;color:#475569';};
  var _sn=0;
  body.innerHTML=emps.length?emps.map(function(e){
    _sn++;
    var pClr=_hrmsGetPlantColor(e.location);
    var etStyle=_etBg(e.employmentType);
    var _ov='overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    var _pending=!!e._isNewEcr;
    var _rowBg=_pending?'background:#fefce8':'';// soft yellow for pending
    var _hoverIn=_pending?'this.style.background=\'#fef3c7\'':'this.style.background=\'#f0f9ff\'';
    var _hoverOut=_pending?'this.style.background=\'#fefce8\'':'this.style.background=\'\'';
    var _waitBadge=_pending?' <span style="display:inline-block;background:#f59e0b;color:#fff;font-size:9px;font-weight:800;padding:1px 6px;border-radius:3px;text-transform:uppercase;letter-spacing:0.3px;vertical-align:middle">⏳ Waiting for Approval</span>':'';
    return '<tr style="font-size:11px;cursor:pointer;'+_rowBg+'" onclick="_hrmsOpenEmpPage(\''+e.id+'\')" onmouseover="'+_hoverIn+'" onmouseout="'+_hoverOut+'">'
      +'<td style="text-align:center;padding:4px 2px;font-weight:700;color:var(--text3);font-size:10px">'+_sn+'</td>'
      +'<td style="font-family:var(--mono);font-weight:800;color:var(--accent);padding:4px 6px;'+_ov+'">'+e.empCode+'</td>'
      +'<td style="font-weight:700;padding:4px 6px;'+_ov+'" title="'+e.name+'">'+e.name+_waitBadge+'</td>'
      +'<td style="padding:4px 4px;font-size:11px;'+_ov+'">'+(e.gender||'—')+'</td>'
      +'<td style="padding:4px 4px;font-size:11px;'+_ov+'">'+_hrmsFmtDate(e.dateOfJoining)+'</td>'
      +'<td style="padding:4px 3px;'+_ov+'"><span style="display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:700;background:'+pClr+';color:#1e293b;max-width:100%;'+_ov+'" title="'+(e.location||'')+'">'+(e.location||'—')+'</span></td>'
      +'<td style="padding:4px 3px;'+_ov+'"><span style="display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:700;background:'+etStyle+';max-width:100%;'+_ov+'" title="'+(e.employmentType||'')+'">'+(e.employmentType||'—')+'</span></td>'
      +'<td style="padding:4px 6px;'+_ov+'" title="'+(e.teamName||'')+'">'+(e.teamName||'—')+'</td>'
      +'<td style="padding:4px 4px;'+_ov+'">'+(e.category||'—')+'</td>'
      +(function(){var d=_empDept(e);return '<td style="padding:4px 4px;'+_ov+'" title="'+d+'">'+(d||'<span style="color:var(--text3)">—</span>')+'</td>';})()
      +'<td style="padding:4px 3px;text-align:center;font-family:var(--mono);font-weight:700;color:'+(e.roll?'var(--accent)':'var(--text3)')+';'+_ov+'" title="'+(e.roll||'')+'">'+(e.roll||'—')+'</td>'
      +'<td style="padding:4px 4px;text-align:right;font-family:var(--mono);font-weight:700;'+_ov+'">'+(function(){var rd=_empRateDay(e);return rd?rd.toLocaleString():'<span style="color:var(--text3);font-weight:400">—</span>';})()+'</td>'
      +'<td style="padding:4px 3px;white-space:nowrap;text-align:center" onclick="event.stopPropagation()"><button onclick="_hrmsOpenEmpPage(\''+e.id+'\')" style="padding:2px 6px;font-size:10px;font-weight:700;background:#fef3c7;border:1px solid #fde047;color:#a16207;border-radius:3px;cursor:pointer">✏️</button>'
      +(_hrmsEmpRecordReason(e)?'':' <button onclick="_hrmsDelEmp(\''+e.id+'\')" style="padding:2px 6px;font-size:10px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:3px;cursor:pointer">🗑</button>')
      +'</td>'
      +'</tr>';
  }).join(''):'<tr><td colspan="13" class="empty-state">No employees match filters.</td></tr>';
  var cEl=document.getElementById('cEmployees');if(cEl)cEl.textContent=allEmps.length;
  var cntEl=document.getElementById('hrmsEmpCount');if(cntEl)cntEl.textContent='(showing '+emps.length+' of '+allEmps.length+')';
}

function _hrmsSplitName(){
  var full=(document.getElementById('hrmsEmpName').value||'').trim();
  var parts=full.split(/\s+/);
  document.getElementById('hrmsEmpLastName').value=parts[0]||'';
  document.getElementById('hrmsEmpFirstName').value=parts[1]||'';
  document.getElementById('hrmsEmpMiddleName').value=parts.slice(2).join(' ')||'';
}
function _hrmsPopSelect(selId,tbl,val){
  var el=document.getElementById(selId);if(!el)return;
  var items=(DB[tbl]||[]).slice().sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});
  var h='<option value="">--</option>';
  items.forEach(function(it){h+='<option value="'+it.name+'"'+(it.name===val?' selected':'')+'>'+it.name+'</option>';});
  el.innerHTML=h;
}
function _hrmsUpdateTitle(){
  var titleEl=document.getElementById('mHrmsEmpTitle');if(!titleEl) return;
  var code=document.getElementById('hrmsEmpCode').value.trim();
  var last=document.getElementById('hrmsEmpLastName').value.trim();
  var first=document.getElementById('hrmsEmpFirstName').value.trim();
  var fullName=[first,last].filter(Boolean).join(' ');
  var base=(code&&fullName)?code+' — '+fullName:(code||fullName||'Add Employee');
  // Derive current status + label from the active period (employment-type
  // aware: On-Roll → Present/Resigned, others → Active/Inactive).
  var activeP=null;
  if(typeof _hrmsEmpPeriods!=='undefined'&&_hrmsEmpPeriods){
    activeP=_hrmsEmpPeriods.find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
  }
  var label='',color='';
  if(activeP){
    var st=activeP.status||'Active';
    var normSt=(st==='Active')?'Active':'Inactive';
    var et=((activeP.employmentType||'')+'').toLowerCase().replace(/\s/g,'');
    var isOnRoll=et==='onroll';
    if(isOnRoll){
      label=normSt==='Active'?'Present':'Resigned';
      color=normSt==='Active'?'#15803d':'#dc2626';
    } else {
      label=normSt==='Active'?'Active':'Inactive';
      color=normSt==='Active'?'#15803d':'#64748b';
    }
  }
  titleEl.innerHTML=base+(label?' <span style="font-size:14px;font-weight:800;color:'+color+'">('+label+')</span>':'');
}
function _hrmsUpdateSubHeader(){
  var sh=document.getElementById('hrmsEmpSubHeader');if(!sh)return;
  var id=document.getElementById('hrmsEmpId').value;
  if(!id){sh.style.display='none';return;}
  var e=byId(DB.hrmsEmployees||[],id);if(!e){sh.style.display='none';return;}
  var tags=[];
  if(e.location) tags.push({l:'Plant',v:e.location,bg:'#dbeafe',clr:'#1d4ed8',bdr:'#93c5fd'});
  if(e.employmentType) tags.push({l:'Type',v:e.employmentType,bg:'#dcfce7',clr:'#15803d',bdr:'#86efac'});
  if(e.category) tags.push({l:'Category',v:e.category,bg:'#fef3c7',clr:'#92400e',bdr:'#fde047'});
  if(e.teamName) tags.push({l:'Team',v:e.teamName,bg:'#ede9fe',clr:'#6d28d9',bdr:'#c4b5fd'});
  if(!tags.length){sh.style.display='none';return;}
  sh.style.display='flex';
  sh.innerHTML=tags.map(function(t){return '<span style="background:'+t.bg+';color:'+t.clr+';border:1px solid '+t.bdr+';padding:2px 8px;border-radius:5px;font-weight:700;font-size:11px">'+t.l+': '+t.v+'</span>';}).join('');
}
function _hrmsShowAge(){
  var dob=document.getElementById('hrmsEmpDOB').value;
  var ageEl=document.getElementById('hrmsEmpAge');
  if(!ageEl) return;
  if(!dob){ageEl.value='';return;}
  var bd=new Date(dob+'T00:00:00'),now=new Date();
  var age=now.getFullYear()-bd.getFullYear();
  if(now.getMonth()<bd.getMonth()||(now.getMonth()===bd.getMonth()&&now.getDate()<bd.getDate())) age--;
  ageEl.value=age+' yrs';
}
// ═══ PERIOD-BASED ORG/SALARY TRACKING ═══════════════════════════════════
var _hrmsEmpPeriods=[];// current employee's periods array
var _hrmsActivePeriodIdx=0;
var _PERIOD_FIELDS=['location','department','subDepartment','designation','employmentType','teamName','category','roll','reportingTo','salaryDay','salaryMonth','specialAllowance','esiApplicable','status','dateOfLeft'];
var _PERIOD_FORM_MAP={location:'hrmsEmpLocation',department:'hrmsEmpDept',subDepartment:'hrmsEmpSubDept',designation:'hrmsEmpDesig',employmentType:'hrmsEmpType',teamName:'hrmsEmpTeam',category:'hrmsEmpCategory',roll:'hrmsEmpRoll',reportingTo:'hrmsEmpReporting',salaryDay:'hrmsEmpSalDay',salaryMonth:'hrmsEmpSalMonth',specialAllowance:'hrmsEmpSpAllow',status:'hrmsEmpStatus',dateOfLeft:'hrmsEmpDOL'};

// _hrmsMonthLabel is in hrms-logic.js
// _hrmsCurMonth is in hrms-logic.js
// _hrmsPrevMonth is in hrms-logic.js

// _hrmsMigratePeriods is in hrms-logic.js

// _hrmsGetActivePeriod is in hrms-logic.js

// Format "2026-01" → "Jan-26". Returns empty string for falsy input.
function _hrmsShortMonth(ym){
  if(!ym) return '';
  var p=ym.split('-');
  if(p.length<2) return ym;
  var mon=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return mon[+p[1]]+'-'+p[0].slice(-2);
}

// Parse short month text like "Jan-26" / "Jan 26" / "01-26" / "1/26" / "2026-01" → "YYYY-MM" (or empty)
function _hrmsParseShortMonth(txt){
  var s=(txt||'').toString().trim();if(!s) return '';
  // Already YYYY-MM
  var m=s.match(/^(\d{4})-(\d{1,2})$/);if(m) return m[1]+'-'+m[2].padStart(2,'0');
  // MonthName-YY or MonthName YY (e.g. Jan-26, Feb 26)
  var mon=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  m=s.match(/^([a-zA-Z]{3,})[\s\-\/]+(\d{2,4})$/);
  if(m){
    var idx=mon.indexOf(m[1].slice(0,3).toLowerCase());
    if(idx>=0){
      var yr=+m[2];if(yr<100) yr+=2000;
      return yr+'-'+String(idx+1).padStart(2,'0');
    }
  }
  // MM-YY or M/YY
  m=s.match(/^(\d{1,2})[\-\/\s]+(\d{2,4})$/);
  if(m){
    var mo=+m[1];var yr2=+m[2];if(yr2<100) yr2+=2000;
    if(mo>=1&&mo<=12) return yr2+'-'+String(mo).padStart(2,'0');
  }
  return '';
}

// On focus, show the full "CODE — Description" label on every option so the
// opened dropdown is informative; on blur, collapse back to just the code so
// the resting/selected display is compact.
function _hrmsRollSelectExpand(sel){
  if(!sel||!sel.options) return;
  for(var i=0;i<sel.options.length;i++){
    var o=sel.options[i];var f=o.getAttribute('data-full');
    if(f&&o.text!==f) o.text=f;
  }
}
function _hrmsRollSelectCollapse(sel){
  if(!sel||!sel.options) return;
  for(var i=0;i<sel.options.length;i++){
    var o=sel.options[i];var v=o.value;
    if(v&&o.text!==v) o.text=v;
  }
}

function _hrmsPeriodFromTextChange(idx,inp){
  var parsed=_hrmsParseShortMonth(inp.value);
  if(!parsed){notify('Invalid month — use format like Jan-26',true);if(_hrmsEmpPeriods[idx])inp.value=_hrmsShortMonth(_hrmsEmpPeriods[idx].from);return;}
  _hrmsPeriodFieldChange(idx,'from',parsed);
  inp.value=_hrmsShortMonth(parsed);
}

function _hrmsBuildPeriodTable(){
  var body=document.getElementById('hrmsEmpPeriodBody');
  if(!body) return;
  // Build select option HTML helpers
  var _mandatoryFields={hrmsCompanies:1,hrmsEmpTypes:1,hrmsCategories:1,hrmsTeams:1,hrmsDepartments:1};
  var _selOpts=function(tbl,val){
    var items=(DB[tbl]||[]).filter(function(x){return !x.inactive;}).sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});
    var hasMatch=val&&items.some(function(x){return x.name===val;});
    // ALWAYS include a "--" option — when val is empty, mark it selected so
    // the browser doesn't auto-pick the first real option and mislead the
    // user into thinking a value was chosen. (For mandatory fields the
    // saveHrmsEmp validation still catches blanks at submit time.)
    var h='<option value=""'+(val?'':' selected')+'>--</option>';
    if(val&&!hasMatch) h+='<option value="'+val+'" selected>'+val+'</option>';
    h+=items.map(function(x){return '<option value="'+x.name+'"'+(x.name===val?' selected':'')+'>'+x.name+'</option>';}).join('');
    return h;
  };
  // Options for the From-month <select>. Compact single dropdown covering
  // ~13 years (current year − 10 to current year + 2) in YYYY-MM format
  // with "Mon-YY" labels. Unknown legacy values are preserved at the top.
  var _fromMonthOpts=function(val){
    var _moNames=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var _curYr=new Date().getFullYear();
    var h='<option value="">--</option>';
    var hasMatch=false;
    var opts='';
    for(var y=_curYr+2;y>=_curYr-10;y--){
      for(var m=12;m>=1;m--){
        var mk=y+'-'+String(m).padStart(2,'0');
        var label=_moNames[m-1]+'-'+String(y).slice(-2);
        if(mk===val) hasMatch=true;
        opts+='<option value="'+mk+'"'+(mk===val?' selected':'')+'>'+label+'</option>';
      }
    }
    if(val&&!hasMatch){
      h+='<option value="'+val+'" selected>'+(typeof _hrmsShortMonth==='function'?_hrmsShortMonth(val):val)+'</option>';
    }
    return h+opts;
  };
  // Roll options — compact code when closed, "CODE — Description" when the
  // dropdown is open. Achieved by swapping option text on focus/blur (see
  // _hrmsRollSelectExpand / _hrmsRollSelectCollapse). The data-full
  // attribute carries the full label so we can restore it on open.
  var _rollOpts=function(val){
    var rolls=((typeof _hrmsGetRolls==='function'?_hrmsGetRolls():[])||[])
      .slice().sort(function(a,b){return(a.code||'').localeCompare(b.code||'');});
    var hasMatch=val&&rolls.some(function(r){return r.code===val;});
    var h='<option value="">--</option>';
    if(val&&!hasMatch) h+='<option value="'+val+'" data-full="'+val+' (not in master)" selected>'+val+'</option>';
    h+=rolls.map(function(r){
      var code=r.code||'';var nm=(r.name||'').replace(/"/g,'&quot;');
      var full=code+(nm?' — '+nm:'');
      return '<option value="'+code+'" data-full="'+full+'"'+(code===val?' selected':'')+' title="'+nm+'">'+code+'</option>';
    }).join('');
    return h;
  };
  // Teams restricted to those matching the row's employment-type bucket
  // (On Roll / Contract / Piece Rate / Visitor). Any current value not in
  // the filtered list is preserved so legacy mismatches stay visible.
  var _teamOpts=function(val,empType){
    var bucket=(typeof _hrmsEtBucket==='function')?_hrmsEtBucket(empType||''):'';
    var items=(DB.hrmsTeams||[]).filter(function(t){return !t.inactive;});
    if(bucket) items=items.filter(function(t){return (typeof _hrmsEtBucket==='function'?_hrmsEtBucket(t.empType||''):'')===bucket;});
    items.sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});
    var hasMatch=val&&items.some(function(x){return x.name===val;});
    var h='<option value=""'+(val?'':' selected')+'>--</option>';
    if(val&&!hasMatch) h+='<option value="'+val+'" selected>'+val+' (wrong type)</option>';
    h+=items.map(function(x){return '<option value="'+x.name+'"'+(x.name===val?' selected':'')+'>'+x.name+'</option>';}).join('');
    return h;
  };
  // Plant options coloured with each plant's palette color so the open list
  // shows colored badges for every option.
  var _plantOpts=function(val){
    var items=(DB.hrmsCompanies||[]).filter(function(x){return !x.inactive;}).sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});
    var hasMatch=val&&items.some(function(x){return x.name===val;});
    var h='<option value=""'+(val?'':' selected')+'>--</option>';
    if(val&&!hasMatch) h+='<option value="'+val+'" selected>'+val+'</option>';
    h+=items.map(function(x){
      var clr=x.color||'#e2e8f0';
      return '<option value="'+x.name+'"'+(x.name===val?' selected':'')+' style="background:'+clr+';color:#1e293b">'+x.name+'</option>';
    }).join('');
    return h;
  };
  // Find which period is the true current (first with to=null and no pending workflow)
  var _currentIdx=-1;
  for(var ci=0;ci<_hrmsEmpPeriods.length;ci++){
    var cp=_hrmsEmpPeriods[ci];
    if(!cp.to&&!cp._wfStatus){_currentIdx=ci;break;}
  }
  // Assign revision numbers (oldest=1, newest=highest)
  var _totalRevs=_hrmsEmpPeriods.length;
  body.innerHTML=_hrmsEmpPeriods.map(function(p,i){
    var revNum=_totalRevs-i;
    var isActive=i===_currentIdx;
    var isProposed=p._wfStatus==='proposed';
    var isDraft=p._wfStatus==='draft';
    var isRejected=p._wfStatus==='rejected';
    var _isNewEmp=!document.getElementById('hrmsEmpId')?.value;
    // Editability rules:
    //  • Draft row — always editable in edit mode.
    //  • Proposed row — editable so the user can fix data before approval.
    //  • New-employee current row — editable (the period is also proposed).
    //  • Existing employee's active period — directly editable AS LONG AS
    //    no month in the period's range has been Save-&-Locked. Once any
    //    month is locked, direct edits would retroactively change locked
    //    salary snapshots, so all fields go read-only and changes must
    //    flow through a new revision (ECR).
    //  • Dept / Sub Dept / Role on the active period are always editable
    //    in edit mode (handled by `disOrg` below) — these don't require
    //    ECR approval and don't affect already-locked salary calcs.
    var _periodLocked=(typeof _hrmsPeriodOverlapsLock==='function')
      ?_hrmsPeriodOverlapsLock(p.from,p.to)
      :false;
    var _canEditActive=isActive&&!_isNewEmp&&!_periodLocked;
    var isEditable=_hrmsEmpEditMode&&(isDraft||isProposed||(_isNewEmp&&isActive)||_canEditActive);
    var dis=isEditable?'':'disabled style="opacity:'+(isActive?'0.8':(isProposed?'0.8':'0.5'))+'"';
    var _canEditOrgInPlace=isActive&&!_isNewEmp&&_hrmsEmpEditMode;
    var disOrg=(isEditable||_canEditOrgInPlace)?'':'disabled style="opacity:'+(isActive?'0.8':(isProposed?'0.8':'0.5'))+'"';
    var bg=isDraft?'background:#dbeafe;border-left:5px solid #2563eb':(isProposed?'background:#fefce8;border-left:5px solid #f59e0b':(isRejected?'background:#fee2e2;border-left:5px solid #dc2626':(isActive?'background:#dcfce7;border-left:5px solid #16a34a':'background:#f8fafc;border-left:5px solid #e2e8f0')));
    var statusLabel=isDraft?'✎ DRAFT':(isProposed?'⏳ PROPOSED':(isRejected?'✕ REJECTED':(isActive?'★ CURRENT':'')));
    var statusClr=isDraft?'#2563eb':(isProposed?'#f59e0b':(isRejected?'#dc2626':(isActive?'#16a34a':'#94a3b8')));
    var badge=statusLabel?'<div style="font-size:9px;font-weight:800;background:'+statusClr+';color:#fff;padding:1px 5px;border-radius:3px;margin-top:2px;text-align:center">'+statusLabel+'</div>':'';
    // Get previous period for comparison
    var prev=(isDraft||isProposed)&&_hrmsEmpPeriods[i+1]?_hrmsEmpPeriods[i+1]:null;
    var _chk=function(field){return prev&&String(p[field]||'')!==String(prev[field]||'')?' hrms-changed':'';};
    // Salary field logic: Staff→Sal/Month only, Worker→Sal/Day only
    var cat=(p.category||'').toLowerCase();
    var isStaff=cat.indexOf('staff')>=0;
    var isWorker=cat.indexOf('worker')>=0;
    var disSalDay=isEditable?(isStaff?'disabled style="opacity:0.3;background:#f1f5f9"':''):'disabled style="opacity:'+(isActive||isProposed?'0.8':'0.5')+'"';
    var disSalMon=isEditable?(isWorker?'disabled style="opacity:0.3;background:#f1f5f9"':''):'disabled style="opacity:'+(isActive||isProposed?'0.8':'0.5')+'"';
    return '<tr style="border-bottom:2px solid #cbd5e1;'+bg+'">'
      +'<td style="padding:4px 3px;text-align:center;font-weight:800;color:'+statusClr+';font-size:15px">R'+revNum+badge+'</td>'
      +'<td style="padding:4px 3px;text-align:center">'+(isEditable?'<select onchange="_hrmsPeriodFieldChange('+i+',\'from\',this.value);_hrmsBuildPeriodTable()" style="font-size:14px;font-weight:700;padding:2px 3px;border:1px solid var(--border);border-radius:4px;width:84px;box-sizing:border-box;text-align:center" '+dis+'>'+_fromMonthOpts(p.from)+'</select>':'<span style="font-size:14px;font-weight:700;color:var(--text)">'+_hrmsShortMonth(p.from)+'</span>')+'</td>'
      +'<td style="padding:4px 3px;text-align:center">'+(isDraft?'<span style="font-size:13px;font-weight:800;color:#2563eb;padding:3px 6px;background:#dbeafe;border:1px solid #93c5fd;border-radius:4px;display:inline-block">Draft</span>':(isProposed?'<span style="font-size:13px;font-weight:800;color:#f59e0b;padding:3px 6px;background:#fefce8;border:1px solid #fde047;border-radius:4px;display:inline-block">Pending</span>':(isActive?'<span style="font-size:14px;font-weight:800;color:#16a34a;padding:3px 6px;background:#f0fdf4;border:1px solid #86efac;border-radius:4px;display:inline-block">Till date</span>':'<span style="font-size:14px;font-weight:700;color:var(--text)">'+_hrmsShortMonth(p.to)+'</span>')))+'</td>'
      +'<td style="padding:4px 3px"><select class="'+_chk('location')+'" onchange="_hrmsPeriodFieldChange('+i+',\'location\',this.value);_hrmsBuildPeriodTable()" style="font-size:13px;font-weight:700;padding:2px 6px;border:1px solid rgba(0,0,0,.15);border-radius:5px;width:100%;background:'+(typeof _hrmsGetPlantColor==='function'?_hrmsGetPlantColor(p.location):'#ffffff')+';color:#1e293b" '+dis+'>'+_plantOpts(p.location)+'</select></td>'
      +'<td style="padding:4px 3px"><select class="'+_chk('employmentType')+'" onchange="_hrmsPeriodFieldChange('+i+',\'employmentType\',this.value);_hrmsBuildPeriodTable()" style="font-size:13px;padding:2px 3px;border:1px solid var(--border);border-radius:4px;width:100%" '+dis+'>'+_selOpts('hrmsEmpTypes',p.employmentType)+'</select></td>'
      +'<td style="padding:4px 3px"><select class="'+_chk('category')+'" onchange="_hrmsPeriodFieldChange('+i+',\'category\',this.value);_hrmsBuildPeriodTable()" style="font-size:13px;padding:2px 3px;border:1px solid var(--border);border-radius:4px;width:100%" '+dis+'>'+_selOpts('hrmsCategories',p.category)+'</select></td>'
      +'<td style="padding:4px 3px"><select class="'+_chk('teamName')+'" onchange="_hrmsPeriodFieldChange('+i+',\'teamName\',this.value);_hrmsBuildPeriodTable()" style="font-size:13px;padding:2px 3px;border:1px solid var(--border);border-radius:4px;width:100%" '+dis+'>'+_teamOpts(p.teamName,p.employmentType)+'</select></td>'
      // Department cell — Worker uses hrmsDepartments, Staff uses
      // hrmsSubDepartments (renamed Department-Staff). Field name varies:
      // `department` for Worker, `subDepartment` for Staff. The other field
      // is preserved (we just don't show it).
      +(function(){
        var pCat=((p.category||'')+'').toLowerCase();
        var deptIsStaff=pCat.indexOf('staff')>=0;
        var deptTbl=deptIsStaff?'hrmsSubDepartments':'hrmsDepartments';
        var deptField=deptIsStaff?'subDepartment':'department';
        var deptVal=deptIsStaff?(p.subDepartment||''):(p.department||'');
        return '<td style="padding:4px 3px"><select class="'+_chk(deptField)+'" onchange="_hrmsPeriodFieldChange('+i+',\''+deptField+'\',this.value);_hrmsBuildPeriodTable()" style="font-size:13px;padding:2px 3px;border:1px solid var(--border);border-radius:4px;width:100%" '+disOrg+'>'+_selOpts(deptTbl,deptVal)+'</select></td>';
      })()
      +'<td style="padding:4px 3px"><select class="'+_chk('designation')+'" onchange="_hrmsPeriodFieldChange('+i+',\'designation\',this.value);_hrmsBuildPeriodTable()" style="font-size:13px;padding:2px 3px;border:1px solid var(--border);border-radius:4px;width:100%" '+dis+'>'+_selOpts('hrmsDesignations',p.designation)+'</select></td>'
      +'<td style="padding:4px 3px"><select class="'+_chk('roll')+'" onfocus="_hrmsRollSelectExpand(this)" onblur="_hrmsRollSelectCollapse(this)" onchange="_hrmsRollSelectCollapse(this);_hrmsPeriodFieldChange('+i+',\'roll\',this.value);_hrmsBuildPeriodTable()" style="font-size:13px;padding:2px 3px;border:1px solid var(--border);border-radius:4px;width:100%" '+disOrg+'>'+_rollOpts(p.roll)+'</select></td>'
      +'<td style="padding:4px 3px"><input type="number" class="no-spin'+_chk('salaryDay')+'" value="'+(p.salaryDay||'')+'" step="5" min="0" onchange="_hrmsSnapSalary(this,5);_hrmsPeriodFieldChange('+i+',\'salaryDay\',parseFloat(this.value)||0);_hrmsBuildPeriodTable()" style="font-size:13px;padding:2px 3px;border:1px solid var(--border);border-radius:4px;width:100%;text-align:right" '+disSalDay+'></td>'
      +'<td style="padding:4px 3px"><input type="number" class="no-spin'+_chk('salaryMonth')+'" value="'+(p.salaryMonth||'')+'" step="50" min="0" onchange="_hrmsSnapSalary(this,50);_hrmsPeriodFieldChange('+i+',\'salaryMonth\',parseFloat(this.value)||0);_hrmsBuildPeriodTable()" style="font-size:13px;padding:2px 3px;border:1px solid var(--border);border-radius:4px;width:100%;text-align:right" '+disSalMon+'></td>'
      +'<td style="padding:4px 3px"><input type="number" class="no-spin'+_chk('specialAllowance')+'" value="'+(p.specialAllowance||'')+'" step="50" min="0" onchange="_hrmsPeriodFieldChange('+i+',\'specialAllowance\',parseFloat(this.value)||0);_hrmsBuildPeriodTable()" style="font-size:13px;padding:2px 3px;border:1px solid var(--border);border-radius:4px;width:100%;text-align:right" '+(isEditable?'':'disabled style="opacity:0.6"')+'></td>'
      +'<td style="padding:4px 3px;text-align:center"><select class="'+_chk('esiApplicable')+'" onchange="_hrmsPeriodFieldChange('+i+',\'esiApplicable\',this.value)" style="font-size:13px;padding:2px 3px;border:1px solid var(--border);border-radius:4px;width:100%;font-weight:700" '+dis+'><option value="Yes"'+((p.esiApplicable||'Yes')==='Yes'?' selected':'')+'>Yes</option><option value="No"'+(p.esiApplicable==='No'?' selected':'')+'>No</option></select></td>'
      +(function(){
        var st=p.status||'Active';
        var et=((p.employmentType||'')+'').toLowerCase().replace(/\s/g,'');
        var isOnRoll=et==='onroll';
        var opts,clr,bg;
        // Only Active / Inactive are valid statuses now — any legacy 'Left'
        // value is coerced to Inactive at render time.
        var normSt=(st==='Active')?'Active':'Inactive';
        if(isOnRoll){
          // On Roll: Active → Present, Inactive → Resigned.
          clr=normSt==='Active'?'#15803d':'#dc2626';
          bg=normSt==='Active'?'#dcfce7':'#fee2e2';
          opts='<option value="Active"'+(normSt==='Active'?' selected':'')+'>Present</option>'+
               '<option value="Inactive"'+(normSt==='Inactive'?' selected':'')+'>Resigned</option>';
        } else {
          clr=normSt==='Active'?'#15803d':'#64748b';
          bg=normSt==='Active'?'#dcfce7':'#f1f5f9';
          opts='<option value="Active"'+(normSt==='Active'?' selected':'')+'>Active</option>'+
               '<option value="Inactive"'+(normSt==='Inactive'?' selected':'')+'>Inactive</option>';
        }
        var statusDis=isEditable?'':'disabled style="opacity:'+(isActive?'0.8':(isProposed?'0.8':'0.5'))+'"';
        return '<td style="padding:4px 3px;text-align:center"><select class="'+_chk('status')+'" onchange="_hrmsPeriodFieldChange('+i+',\'status\',this.value);_hrmsBuildPeriodTable()" style="font-size:13px;padding:2px 3px;border:1.5px solid '+clr+';border-radius:4px;width:100%;font-weight:800;background:'+bg+';color:'+clr+'" '+statusDis+'>'+opts+'</select></td>';
      })()
      +'<td style="padding:4px 3px"><input type="text" value="'+(p.remarks||'')+'" onchange="_hrmsPeriodFieldChange('+i+',\'remarks\',this.value)" placeholder="'+(isEditable?'Add remarks…':'')+'" style="font-size:13px;padding:2px 3px;border:1px solid var(--border);border-radius:4px;width:100%" '+(isEditable?'':'disabled style="opacity:0.6"')+'></td>'
      +'<td style="padding:4px 3px;white-space:nowrap">'+(isDraft?'<button onclick="_hrmsSavePeriodRow()" style="font-size:12px;padding:3px 10px;font-weight:800;background:#f59e0b;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-right:3px" title="Submit for approval">📤 Submit</button><button onclick="_hrmsDeleteNewPeriod()" style="font-size:12px;padding:3px 10px;font-weight:800;background:#dc2626;color:#fff;border:none;border-radius:4px;cursor:pointer">✕ Delete</button>':(isProposed?'<span style="font-size:11px;font-weight:800;color:#f59e0b;background:#fefce8;border:1px solid #fde047;padding:2px 6px;border-radius:3px">Awaiting</span>':'')+((!isDraft&&!isActive&&_hrmsIsSA()&&!_hrmsPeriodOverlapsLock(p.from,p.to))?'<button onclick="_hrmsDeletePeriodRow('+i+')" style="font-size:11px;padding:2px 6px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:3px;cursor:pointer;margin-left:3px" title="Delete period">🗑</button>':''))+'</td>'
      +'</tr>';
  }).join('');
}

function _hrmsSnapSalary(el,step){
  var v=parseFloat(el.value)||0;
  if(v<0) v=0;
  v=Math.round(v/step)*step;
  el.value=v;
}
// _hrmsIsSA is in hrms-logic.js
function _hrmsDeletePeriodRow(idx){
  var p=_hrmsEmpPeriods[idx];if(!p) return;
  if(_hrmsPeriodOverlapsLock(p.from,p.to)){
    notify('Cannot delete — salary has been generated (month locked) within this period.',true);
    return;
  }
  if(!confirm('Delete this period record?')) return;
  _hrmsEmpPeriods.splice(idx,1);
  _hrmsBuildPeriodTable();
  notify('Period deleted — click Save to persist');
}
function _hrmsPeriodFieldChange(idx,field,value){
  if(typeof value==='string') value=value.replace(/[\r\n]+/g,' ').trim();
  if(!_hrmsEmpPeriods[idx]) return;
  _hrmsEmpPeriods[idx][field]=value;
  // Auto-default ESI Applicable when category changes: Worker=Yes, Staff=No.
  // Also clear the now-unused dept field so the Department / Department-Staff
  // master counts don't keep counting a stale value from the previous category.
  if(field==='category'){
    var cat=(value||'').toLowerCase();
    if(cat.indexOf('worker')>=0){
      _hrmsEmpPeriods[idx].esiApplicable='Yes';
      _hrmsEmpPeriods[idx].subDepartment='';
    } else if(cat.indexOf('staff')>=0){
      _hrmsEmpPeriods[idx].esiApplicable='No';
      _hrmsEmpPeriods[idx].department='';
    }
  }
  // Clear team when employment type changes — teams are bucketed by emp type
  // and the previous team is almost certainly invalid for the new bucket.
  if(field==='employmentType'){
    _hrmsEmpPeriods[idx].teamName='';
    if(typeof _hrmsUpdateTitle==='function') _hrmsUpdateTitle();// label remap
  }
  // Status lives in the modal header now — refresh it live on every change.
  if(field==='status'&&typeof _hrmsUpdateTitle==='function') _hrmsUpdateTitle();
  // Auto-fill Sal/Day when Role / Team / Emp Type / Category changes.
  //   • Contract Worker (current period) → match ANY contract worker with the
  //     same role (no team match required) — works for new AND existing.
  //   • Other emp types — only on NEW employee, and require same emp type +
  //     team + role to avoid clobbering deliberate salary edits on existing
  //     records. Uses the mode (most common value) so an outlier doesn't
  //     bias the default.
  if(field==='roll'||field==='teamName'||field==='employmentType'||field==='category'){
    var p=_hrmsEmpPeriods[idx];
    var role=(p.roll||'').trim();
    if(role){
      var et=((p.employmentType||'')+'').toLowerCase().replace(/\s/g,'');
      var pCat=((p.category||'')+'').toLowerCase();
      var isContractWorker=(et==='contract'&&pCat.indexOf('worker')>=0);
      var team=(p.teamName||'').trim();
      var empIdEl=document.getElementById('hrmsEmpId');
      var isNewEmp=!(empIdEl&&empIdEl.value);
      var canFill=isContractWorker||(isNewEmp&&team);
      if(canFill){
        var counts={};
        (DB.hrmsEmployees||[]).forEach(function(e){
          if(e._isNewEcr) return;
          var ap=(e.periods||[]).find(function(pp){return !pp.to&&(!pp._wfStatus||pp._wfStatus==='approved');});
          var eRole=((ap&&ap.roll)||e.roll||'').trim();
          if(eRole!==role) return;
          var eEt=(((ap&&ap.employmentType)||e.employmentType||'')+'').toLowerCase().replace(/\s/g,'');
          var eCat=(((ap&&ap.category)||e.category||'')+'').toLowerCase();
          if(isContractWorker){
            if(eEt!=='contract'||eCat.indexOf('worker')<0) return;
          } else {
            if(et&&eEt!==et) return;
            var eTeam=((ap&&ap.teamName)||e.teamName||'').trim();
            if(team&&eTeam!==team) return;
          }
          var sd=+((ap&&ap.salaryDay)||e.salaryDay||0);
          if(sd>0) counts[sd]=(counts[sd]||0)+1;
        });
        var bestSd=0,bestCount=0;
        Object.keys(counts).forEach(function(k){
          if(counts[k]>bestCount){bestCount=counts[k];bestSd=+k;}
        });
        if(bestSd>0) p.salaryDay=bestSd;
      }
    }
  }
}
async function _hrmsSavePeriodRow(){
  if(!_hrmsEmpPeriods[0]||_hrmsEmpPeriods[0]._wfStatus!=='draft') return;
  // Validate: at least one change required
  var draft=_hrmsEmpPeriods[0];
  var prev=_hrmsEmpPeriods.find(function(p,i){return i>0&&!p._wfStatus;});
  if(prev){
    var _changeFields=['location','employmentType','category','teamName','department','subDepartment','designation','roll','salaryDay','salaryMonth','specialAllowance','esiApplicable'];
    var hasChange=_changeFields.some(function(f){return String(draft[f]||'')!==String(prev[f]||'');});
    if(!hasChange){notify('No changes detected — modify at least one field (Plant, Type, Category, Team, Dept, Sub Dept, Designation, Roll, Salary, or ESI Applicable) before submitting',true);return;}
  }
  _hrmsEmpPeriods[0]._wfStatus='proposed';
  _hrmsEmpPeriods[0].submittedAt=new Date().toISOString();
  _hrmsEmpPeriods[0].submittedBy=CU?CU.name||CU.email||'':'';
  // Auto-save employee to DB so ECR tab can see it
  var empId=document.getElementById('hrmsEmpId')?.value;
  if(empId){
    var e=byId(DB.hrmsEmployees||[],empId);
    if(e){
      e.periods=_hrmsEmpPeriods.map(function(p){var c={};for(var k in p){if(k!=='_saved')c[k]=p[k];}return c;});
      await _dbSave('hrmsEmployees',e);
    }
  }
  _hrmsBuildPeriodTable();
  _hrmsUpdateChangeReqBadge();
  notify('📤 Revision submitted for approval');
}
function _hrmsDeleteNewPeriod(){
  if(!_hrmsEmpPeriods.length||_hrmsEmpPeriods[0]._wfStatus!=='draft') return;
  // Drafts haven't been approved yet, so no attendance can be tied to them — allow delete freely.
  if(!confirm('Delete this draft revision?')) return;
  _hrmsEmpPeriods.shift();
  _hrmsBuildPeriodTable();
  notify('Draft revision deleted');
}

function _hrmsSavePeriodToMemory(){
  // No-op — period fields are now saved directly via onchange in the table
}

// ═══ CHANGE REQUEST APPROVAL PAGE ═══════════════════════════════════════
var _PERIOD_LABELS={location:'Plant',employmentType:'Emp Type',category:'Category',teamName:'Team',department:'Dept',subDepartment:'Dept-Staff',designation:'Designation',roll:'Role',reportingTo:'Reporting To',salaryDay:'Sal/Day',salaryMonth:'Sal/Month',specialAllowance:'Sp.Allow',esiApplicable:'ESI'};
function _hrmsUpdateChangeReqBadge(){
  var count=0;
  (DB.hrmsEmployees||[]).forEach(function(e){(e.periods||[]).forEach(function(p){if(p._wfStatus==='proposed')count++;});});
  var el=document.getElementById('cChangeReqTab');
  if(el){el.textContent=count;el.style.display=count?'':'none';}
}
function _hrmsEmpSetTab(tab){
  var listSec=document.getElementById('hrmsEmpListSection');
  var ecrSec=document.getElementById('hrmsEmpEcrSection');
  var listBtn=document.getElementById('hrmsEmpTabList');
  var ecrBtn=document.getElementById('hrmsEmpTabEcr');
  if(listSec) listSec.style.display=tab==='list'?'':'none';
  if(ecrSec) ecrSec.style.display=tab==='ecr'?'':'none';
  if(listBtn){listBtn.style.borderBottomColor=tab==='list'?'var(--accent)':'transparent';listBtn.style.background=tab==='list'?'var(--accent-light)':'transparent';listBtn.style.color=tab==='list'?'var(--accent)':'var(--text3)';}
  if(ecrBtn){ecrBtn.style.borderBottomColor=tab==='ecr'?'#f59e0b':'transparent';ecrBtn.style.background=tab==='ecr'?'#fefce8':'transparent';ecrBtn.style.color=tab==='ecr'?'#92400e':'var(--text3)';}
  if(tab==='ecr') _hrmsRenderChangeReq();
}
function _hrmsRenderChangeReq(){
  var el=document.getElementById('hrmsChangeReqContent');if(!el)return;
  var isSA=CU&&((CU.hrmsRoles||[]).indexOf('Super Admin')>=0||(CU.roles||[]).indexOf('Super Admin')>=0);
  var pendingReqs=[],historyReqs=[];
  (DB.hrmsEmployees||[]).forEach(function(e){
    if(!e.periods||!e.periods.length) return;
    e.periods.forEach(function(p,pi){
      if(!p._wfStatus&&!p._ecrResult) return;
      var current=null;
      for(var j=pi+1;j<e.periods.length;j++){if(!e.periods[j]._wfStatus&&!e.periods[j]._ecrResult){current=e.periods[j];break;}}
      if(!current) current={location:e.location,employmentType:e.employmentType,category:e.category,teamName:e.teamName,department:e.department,subDepartment:e.subDepartment,designation:e.designation,roll:e.roll,reportingTo:e.reportingTo,salaryDay:e.salaryDay,salaryMonth:e.salaryMonth,specialAllowance:e.specialAllowance};
      var item={emp:e,period:p,periodIdx:pi,current:current};
      if(p._wfStatus==='proposed') pendingReqs.push(item);
      else if(p._wfStatus==='rejected'||p._ecrResult==='approved') historyReqs.push(item);
    });
  });
  var pendingCount=pendingReqs.length;
  var badgeEl=document.getElementById('cChangeReqTab');
  if(badgeEl){badgeEl.textContent=pendingCount;badgeEl.style.display=pendingCount?'':'none';}
  if(!pendingReqs.length&&!historyReqs.length){el.innerHTML='<div class="empty-state" style="padding:30px;text-align:center;color:var(--text3)">No change requests</div>';return;}

  var h='';
  // ── Pending ECR Cards ──
  if(!pendingReqs.length) h+='<div style="padding:14px;text-align:center;color:var(--text3);background:var(--surface2);border-radius:8px;margin-bottom:14px">No pending change requests</div>';
  pendingReqs.forEach(function(r,ri){
    var e=r.emp,p=r.period,cur=r.current||{};
    h+='<div style="border:2px solid #f59e0b;border-radius:10px;padding:14px;margin-bottom:12px;background:#fefce8">';
    h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">';
    var _isNewEcr=!!e._isNewEcr;
    var _ecEsc=String(e.empCode||'').replace(/'/g,"\\'");
    h+='<div><a href="javascript:void(0)" onclick="_hrmsOpenEmpByCode(\''+_ecEsc+'\')" style="font-family:var(--mono);font-weight:900;font-size:16px;color:var(--accent);text-decoration:underline;cursor:pointer" title="View / edit employee">'+e.empCode+'</a> <span style="font-weight:700;font-size:15px">'+e.name+'</span> <span style="background:#f59e0b;color:#fff;font-size:10px;font-weight:800;padding:2px 8px;border-radius:4px">⏳ Pending</span>'+(_isNewEcr?' <span style="background:#2563eb;color:#fff;font-size:10px;font-weight:800;padding:2px 8px;border-radius:4px">NEW EMPLOYEE</span>':'')+'</div>';
    h+='<div style="font-size:11px;color:var(--text3)">Proposed from <b>'+_hrmsMonthLabel(p.from)+'</b>'+(p.submittedBy?' by '+p.submittedBy:'')+'</div></div>';
    // Unified timeline table: all periods + proposed row with changes highlighted
    var _ecrCols=['location','employmentType','category','teamName','department','designation','roll','salaryDay','salaryMonth','specialAllowance','esiApplicable'];
    var _ecrColH={location:'Plant',employmentType:'Emp Type',category:'Category',teamName:'Team',department:'Dept',designation:'Designation',roll:'Role',salaryDay:'Sal/Day',salaryMonth:'Sal/Mon',specialAllowance:'Sp.Allow',esiApplicable:'ESI'};
    var _th2='padding:5px 6px;font-size:10px;font-weight:700;white-space:nowrap';
    h+='<div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:6px"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:#1e293b;color:#fff"><th style="'+_th2+'">Period</th><th style="'+_th2+'">Status</th>';
    _ecrCols.forEach(function(c){h+='<th style="'+_th2+(c==='salaryDay'||c==='salaryMonth'||c==='specialAllowance'?';text-align:right':'')+'">'+_ecrColH[c]+'</th>';});
    h+='</tr></thead><tbody>';
    // All periods for this employee (newest first = same order as array)
    e.periods.forEach(function(pp,ppi){
      var isProposedRow=pp===p;
      var isCurrentRow=!pp.to&&!pp._wfStatus&&!pp._ecrResult;
      var isRejRow=pp._wfStatus==='rejected';
      var isApprRow=pp._ecrResult==='approved';
      var rowBg=isProposedRow?'background:#fefce8;border-left:4px solid #f59e0b':(isCurrentRow?'background:#dcfce7;border-left:4px solid #16a34a':(isRejRow?'background:#fef2f2;border-left:4px solid #dc2626':(isApprRow?'background:#f0fdf4;border-left:4px solid #86efac':'border-left:4px solid #e2e8f0')));
      var pSt=isProposedRow?'<span style="background:#f59e0b;color:#fff;padding:1px 5px;border-radius:3px;font-weight:800;font-size:9px">⏳ PROPOSED</span>':(isCurrentRow?'<span style="background:#16a34a;color:#fff;padding:1px 5px;border-radius:3px;font-weight:800;font-size:9px">★ CURRENT</span>':(isRejRow?'<span style="color:#dc2626;font-weight:700;font-size:10px">Rejected</span>':(isApprRow?'<span style="color:#16a34a;font-weight:700;font-size:10px">Approved</span>':'<span style="color:var(--text3);font-size:10px">Closed</span>')));
      // Previous period for comparison (the one right after in array)
      var prevP=e.periods[ppi+1]||null;
      h+='<tr style="border-bottom:1px solid #e2e8f0;'+rowBg+'">';
      h+='<td style="padding:4px 6px;font-weight:700;font-size:11px">'+_hrmsMonthLabel(pp.from)+' — '+(pp.to?_hrmsMonthLabel(pp.to):(isProposedRow?'Pending':'Till date'))+'</td>';
      h+='<td style="padding:4px 6px">'+pSt+'</td>';
      _ecrCols.forEach(function(c){
        var val=String(pp[c]||'—');
        var prevVal=prevP?String(prevP[c]||'—'):'';
        var changed=prevP&&val!==prevVal&&val!=='—';
        h+='<td style="padding:4px 6px;font-family:var(--mono);'+(c==='salaryDay'||c==='salaryMonth'||c==='specialAllowance'?'text-align:right;':'')+(changed?'background:#fef3c7;font-weight:800;color:#92400e;':'')+'">'+val+'</td>';
      });
      h+='</tr>';
    });
    h+='</tbody></table></div>';
    // Approve / Reject buttons
    if(isSA){h+='<div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">'
      +'<button onclick="_hrmsRejectChange(\''+e.id+'\','+r.periodIdx+')" style="padding:6px 16px;font-size:12px;font-weight:800;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer">✕ Reject</button>'
      +'<button onclick="_hrmsApproveChange(\''+e.id+'\','+r.periodIdx+')" style="padding:6px 16px;font-size:12px;font-weight:800;background:#16a34a;color:#fff;border:none;border-radius:6px;cursor:pointer">✓ Approve</button></div>';}
    h+='</div>';
  });

  // ── ECR History Table ──
  if(historyReqs.length){
    historyReqs.sort(function(a,b){return(b.period.submittedAt||'').localeCompare(a.period.submittedAt||'');});
    h+='<div style="margin-top:16px;border-top:2px solid var(--border);padding-top:12px"><div style="font-size:16px;font-weight:900;margin-bottom:10px">📜 ECR History ('+historyReqs.length+')</div>';
    h+='<div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:#1e293b;color:#fff">'
      +'<th style="padding:6px 8px;font-size:11px;text-align:left">Emp Code</th><th style="padding:6px 8px;font-size:11px;text-align:left">Name</th><th style="padding:6px 8px;font-size:11px">Period</th><th style="padding:6px 8px;font-size:11px">Status</th><th style="padding:6px 8px;font-size:11px">By</th><th style="padding:6px 8px;font-size:11px">Date</th>'
      +'<th style="padding:6px 8px;font-size:11px">Plant</th><th style="padding:6px 8px;font-size:11px">Type</th><th style="padding:6px 8px;font-size:11px">Category</th><th style="padding:6px 8px;font-size:11px">Team</th><th style="padding:6px 8px;font-size:11px;text-align:right">Sal/Day</th><th style="padding:6px 8px;font-size:11px;text-align:right">Sal/Mon</th><th style="padding:6px 8px;font-size:11px;text-align:right">Sp.Allow</th>'
      +(isSA?'<th style="padding:6px 8px;font-size:11px"></th>':'')+'</tr></thead><tbody>';
    historyReqs.forEach(function(r){
      var hp=r.period,e=r.emp,cur=r.current||{};
      var isApproved=hp._ecrResult==='approved';
      var badge=isApproved?'<span style="background:#dcfce7;color:#15803d;padding:1px 6px;border-radius:3px;font-weight:700;font-size:10px">✓ Approved</span>':'<span style="background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:3px;font-weight:700;font-size:10px">✕ Rejected</span>';
      var by=isApproved?(hp.approvedBy||'—'):(hp.rejectedBy||'—');
      var dt=isApproved?(hp.approvedAt?new Date(hp.approvedAt).toLocaleDateString():'—'):(hp.rejectedAt?new Date(hp.rejectedAt).toLocaleDateString():'—');
      var rowBg=isApproved?'background:#f0fdf4':'background:#fef2f2';
      var _hi=function(f){var changed=String(hp[f]||'')!==String((cur[f])||'');return changed?'background:#fef3c7;font-weight:800;color:#92400e':'';};
      var _ecEsc2=String(e.empCode||'').replace(/'/g,"\\'");
      h+='<tr style="border-bottom:1px solid #e2e8f0;'+rowBg+'">'
        +'<td style="padding:5px 8px;font-family:var(--mono);font-weight:800"><a href="javascript:void(0)" onclick="_hrmsOpenEmpByCode(\''+_ecEsc2+'\')" style="color:var(--accent);text-decoration:underline;cursor:pointer" title="View / edit employee">'+e.empCode+'</a></td>'
        +'<td style="padding:5px 8px;font-weight:700">'+e.name+'</td>'
        +'<td style="padding:5px 8px;font-weight:600">'+_hrmsMonthLabel(hp.from)+'</td>'
        +'<td style="padding:5px 8px">'+badge+'</td>'
        +'<td style="padding:5px 8px">'+by+'</td>'
        +'<td style="padding:5px 8px;font-family:var(--mono)">'+dt+'</td>'
        +'<td style="padding:5px 8px;'+_hi('location')+'">'+(hp.location||'—')+'</td>'
        +'<td style="padding:5px 8px;'+_hi('employmentType')+'">'+(hp.employmentType||'—')+'</td>'
        +'<td style="padding:5px 8px;'+_hi('category')+'">'+(hp.category||'—')+'</td>'
        +'<td style="padding:5px 8px;'+_hi('teamName')+'">'+(hp.teamName||'—')+'</td>'
        +'<td style="padding:5px 8px;text-align:right;font-family:var(--mono);'+_hi('salaryDay')+'">'+(hp.salaryDay||'—')+'</td>'
        +'<td style="padding:5px 8px;text-align:right;font-family:var(--mono);'+_hi('salaryMonth')+'">'+(hp.salaryMonth||'—')+'</td>'
        +'<td style="padding:5px 8px;text-align:right;font-family:var(--mono);'+_hi('specialAllowance')+'">'+(hp.specialAllowance||'—')+'</td>'
        +(isSA?'<td style="padding:5px 4px"><button onclick="_hrmsDeleteEcr(\''+e.id+'\','+r.periodIdx+')" style="font-size:9px;padding:2px 6px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:3px;cursor:pointer">🗑</button></td>':'')
        +'</tr>';
    });
    h+='</tbody></table></div></div>';
  }
  el.innerHTML=h;
}

async function _hrmsDeleteEcr(empId,periodIdx){
  if(!confirm('Delete this ECR record permanently?')) return;
  var e=byId(DB.hrmsEmployees||[],empId);if(!e||!e.periods) return;
  if(periodIdx<0||periodIdx>=e.periods.length) return;
  e.periods.splice(periodIdx,1);
  if(await _dbSave('hrmsEmployees',e)){
    notify('ECR record deleted');
    _hrmsRenderChangeReq();
  }
}

async function _hrmsApproveChange(empId,periodIdx){
  if(!confirm('Approve this change request?')) return;
  var e=byId(DB.hrmsEmployees||[],empId);if(!e||!e.periods) return;
  var p=e.periods[periodIdx];if(!p||p._wfStatus!=='proposed') return;
  // Record approval metadata
  p.approvedAt=new Date().toISOString();
  p.approvedBy=CU?CU.name||CU.email||'':'';
  p._ecrResult='approved';// Permanent record for ECR history
  delete p._wfStatus;// Clear workflow status so it becomes active
  delete p._saved;
  p.to=null;
  // Close the old current active period — find by to===null and no pending _wfStatus
  for(var j=periodIdx+1;j<e.periods.length;j++){
    if(!e.periods[j]._wfStatus&&!e.periods[j].to){
      e.periods[j].to=_hrmsPrevMonth(p.from);
      break;
    }
  }
  // Clear new employee flag
  delete e._isNewEcr;
  // If the revision reinstates the employee (Active), any stale dateOfLeft
  // inherited from a prior Resigned period must be wiped — otherwise the
  // Muster Roll DOL gate filters them out despite status=Active.
  if((p.status||'Active')==='Active'){ p.dateOfLeft=''; }
  // Sync flat fields from new active period
  _PERIOD_FIELDS.forEach(function(f){e[f]=p[f]||'';});
  if(await _dbSave('hrmsEmployees',e)){
    notify('✓ Change approved for '+e.empCode);
    _hrmsRenderChangeReq();renderHrmsEmployees();
  }
}

async function _hrmsRejectChange(empId,periodIdx){
  var e=byId(DB.hrmsEmployees||[],empId);if(!e||!e.periods) return;
  var p=e.periods[periodIdx];if(!p||p._wfStatus!=='proposed') return;
  // Rejecting a brand-new employee's first ECR — delete the whole record so
  // it doesn't leave a half-dead employee with no active period.
  if(e._isNewEcr){
    if(!confirm('Reject and DELETE the new employee record for '+e.empCode+'? This cannot be undone.')) return;
    if(await _dbDel('hrmsEmployees',e.id)){
      var idx=(DB.hrmsEmployees||[]).findIndex(function(x){return x.id===e.id;});
      if(idx>=0) DB.hrmsEmployees.splice(idx,1);
      notify('✕ New employee rejected and removed: '+e.empCode);
      _hrmsRenderChangeReq();renderHrmsEmployees();
    }
    return;
  }
  if(!confirm('Reject this change request?')) return;
  p._wfStatus='rejected';
  p.to=p.from;// Close the rejected period
  p.rejectedAt=new Date().toISOString();
  p.rejectedBy=CU?CU.name||CU.email||'':'';
  delete p._saved;
  // Ensure previous period is active (to=null, no _wfStatus)
  for(var j=periodIdx+1;j<e.periods.length;j++){
    if(!e.periods[j]._wfStatus){e.periods[j].to=null;break;}
  }
  // Sync flat fields from the active period
  var activePeriod=e.periods.find(function(pp){return !pp.to&&!pp._wfStatus;});
  if(activePeriod) _PERIOD_FIELDS.forEach(function(f){e[f]=activePeriod[f]||'';});
  if(await _dbSave('hrmsEmployees',e)){
    notify('✕ Change rejected for '+e.empCode);
    _hrmsRenderChangeReq();renderHrmsEmployees();
  }
}

function _hrmsRejoinEmployee(){
  if(!_hrmsEmpPeriods.length) return;
  if(_hrmsEmpPeriods[0]._wfStatus==='draft'||_hrmsEmpPeriods[0]._wfStatus==='proposed'){notify('A pending revision already exists',true);return;}
  var curMonth=_hrmsCurMonth();
  var prev=_hrmsEmpPeriods.find(function(p){return !p._wfStatus;})||_hrmsEmpPeriods[0];
  var np={from:curMonth,to:null,_wfStatus:'draft',remarks:'Rejoining'};
  _PERIOD_FIELDS.forEach(function(f){np[f]=prev[f];});
  np.status='Active';// Override to Active for rejoin
  np.dateOfLeft='';
  _hrmsEmpPeriods.unshift(np);
  // Update header status
  var _shSel=document.getElementById('hrmsEmpStatusHeader');
  if(_shSel){_shSel.value='Active';_shSel.style.borderColor='#16a34a';_shSel.style.color='#15803d';_shSel.style.background='#dcfce7';}
  _hrmsBuildPeriodTable();
  _hrmsShowRejoinBtn();
  notify('Rejoin revision created — update details and Submit');
}
function _hrmsShowRejoinBtn(){
  var btn=document.getElementById('hrmsRejoinBtn');if(!btn) return;
  var empId=document.getElementById('hrmsEmpId')?.value;
  if(!empId){btn.style.display='none';return;}
  var e=byId(DB.hrmsEmployees||[],empId);
  var st=(e?e.status:'Active')||'Active';
  var hasPending=_hrmsEmpPeriods.length&&(_hrmsEmpPeriods[0]._wfStatus==='draft'||_hrmsEmpPeriods[0]._wfStatus==='proposed');
  btn.style.display=(st!=='Active'&&!hasPending)?'':'none';
}
function _hrmsNewPeriod(){
  if(!_hrmsEmpEditMode){notify('Click Edit to make changes',true);return;}
  if(!_hrmsEmpPeriods.length){notify('No periods exist — save the employee first',true);return;}
  // Check if there's already an unsaved or proposed period
  if(_hrmsEmpPeriods[0]._wfStatus==='draft'){notify('A draft revision already exists — submit or delete it first',true);return;}
  if(_hrmsEmpPeriods[0]._wfStatus==='proposed'){notify('A proposed revision is already pending approval',true);return;}
  var curMonth=_hrmsCurMonth();
  var prev=_hrmsEmpPeriods.find(function(p){return !p.to&&p._wfStatus!=='proposed'&&p._wfStatus!=='rejected'&&p._wfStatus!=='draft';})||_hrmsEmpPeriods[0];
  var np={from:curMonth,to:null,_wfStatus:'draft'};
  _PERIOD_FIELDS.forEach(function(f){np[f]=prev[f];});
  np.status='Active';
  np.dateOfLeft='';
  _hrmsEmpPeriods.unshift(np);
  _hrmsBuildPeriodTable();
  notify('New revision created from '+_hrmsMonthLabel(curMonth)+' — make changes and click Submit');
}

var _hrmsEmpNavList=[];// cached filtered employee IDs for prev/next
function _hrmsOpenEmpPage(id){
  // Cache current filtered list for navigation
  _hrmsEmpNavList=_hrmsGetFilteredEmployees().map(function(e){return e.id;});
  openHrmsEmpModal(id);
}

// Open employee details popup by empCode (used by clickable links everywhere)
function _hrmsOpenEmpByCode(code){
  code=(code||'').toString().trim();if(!code) return;
  var emp=(DB.hrmsEmployees||[]).find(function(e){return(e.empCode||'')===code;});
  if(!emp){notify('Employee '+code+' not found',true);return;}
  _hrmsEmpNavList=[];
  openHrmsEmpModal(emp.id);
}

// ESC key closes the employee popup (cancels edits with confirm when in edit mode)
if(!window._hrmsEmpEscInstalled){
  document.addEventListener('keydown',function(ev){
    if(ev.key!=='Escape') return;
    var modal=document.getElementById('mHrmsEmpEdit');
    if(!modal||modal.style.display==='none') return;
    // If in edit mode with changes, route through cancel flow (which asks before discarding)
    if(_hrmsEmpEditMode){
      _hrmsEmpEditCancel();
    } else {
      cm('mHrmsEmpEdit');
    }
  });
  window._hrmsEmpEscInstalled=true;
}

// Install a document-level delegated click handler: any element with data-emp-code opens the popup.
// Attribute can be added in-line: <span data-emp-code="EMP001">...</span>
if(!window._hrmsEmpDelegatedInstalled){
  document.addEventListener('click',function(ev){
    var el=ev.target;
    while(el&&el!==document){
      if(el.dataset&&el.dataset.empCode){
        ev.preventDefault();ev.stopPropagation();
        _hrmsOpenEmpByCode(el.dataset.empCode);
        return;
      }
      el=el.parentNode;
    }
  },true);
  window._hrmsEmpDelegatedInstalled=true;
}
function _hrmsBackToList(){cm('mHrmsEmpEdit');}

// Show/hide the Delete button in the view-mode header based on whether the
// current employee can be safely deleted (no linked records). Called from
// openHrmsEmpModal after the form is populated and from edit-mode toggling
// so the eligibility re-checks if the user navigated to a different employee.
function _hrmsEmpRefreshDeleteBtn(){
  var btn=document.getElementById('hrmsEmpDeleteBtn');
  if(!btn) return;
  var id=(document.getElementById('hrmsEmpId')||{}).value||'';
  var emp=id?byId(DB.hrmsEmployees||[],id):null;
  if(!emp){btn.style.display='none';return;}
  if(typeof _hrmsHasAccess==='function'&&!_hrmsHasAccess('action.deleteEmployee')){
    btn.style.display='none';return;
  }
  var reason=(typeof _hrmsEmpRecordReason==='function')?_hrmsEmpRecordReason(emp):null;
  btn.style.display=reason?'none':'';
}

// Delete the currently-open employee from inside the modal. Same safety check
// as the list-row trash icon (refuses if the employee has any linked records),
// then closes the modal on success.
async function _hrmsEmpDeleteFromModal(){
  var id=(document.getElementById('hrmsEmpId')||{}).value||'';
  if(!id){notify('No employee selected',true);return;}
  var emp=byId(DB.hrmsEmployees||[],id);
  if(!emp){notify('Employee not found',true);return;}
  if(typeof _hrmsHasAccess==='function'&&!_hrmsHasAccess('action.deleteEmployee')){
    notify('Access denied',true);return;
  }
  var reason=(typeof _hrmsEmpRecordReason==='function')?_hrmsEmpRecordReason(emp):null;
  if(reason){notify('Cannot delete — '+reason+' exist for this employee',true);return;}
  if(!confirm('Delete employee '+emp.empCode+' ('+(emp.name||'')+')? This cannot be undone.')) return;
  if(!await _dbDel('hrmsEmployees',id)) return;
  cm('mHrmsEmpEdit');
  if(typeof renderHrmsEmployees==='function') renderHrmsEmployees();
  if(typeof renderHrmsDashboard==='function') renderHrmsDashboard();
  // Refresh the Change Requests tab + badge so any pending ECR for this
  // employee disappears immediately. Both renderers no-op if the panel
  // isn't currently in the DOM.
  if(typeof _hrmsRenderChangeReq==='function') _hrmsRenderChangeReq();
  if(typeof _hrmsUpdateChangeReqBadge==='function') _hrmsUpdateChangeReqBadge();
  notify('Employee deleted');
}
// Close handler used by the corner ✕ button. Mirrors the ESC keybind so an
// in-progress edit asks for confirmation before discarding changes.
function _hrmsEmpClose(){
  if(_hrmsEmpEditMode){
    if(typeof _hrmsEmpEditCancel==='function') _hrmsEmpEditCancel();
    else cm('mHrmsEmpEdit');
  } else {
    cm('mHrmsEmpEdit');
  }
}

// View/edit mode state for the employee modal
var _hrmsEmpEditMode=false;
// Snapshot of the employee (pre-edit) for cancel-revert
var _hrmsEmpEditSnap=null;

function _hrmsSetEmpEditMode(on){
  _hrmsEmpEditMode=!!on;
  _hrmsApplyEmpEditModeToForm();
}

function _hrmsApplyEmpEditModeToForm(){
  var editing=_hrmsEmpEditMode;
  // Disable/enable all inputs in the emp modal except quick-search and buttons
  var inputs=document.querySelectorAll('#hrmsEmpModalContent input, #hrmsEmpModalContent select, #hrmsEmpModalContent textarea');
  inputs.forEach(function(el){
    if(el.id==='hrmsEmpQuickSearch') return;// always searchable
    if(el.id==='hrmsEmpStatusHeader') return;// keep header status toggle always active? lock to edit mode too
    if(editing){
      // Respect existing disabled logic (readOnly on empCode etc.)
      if(el.id==='hrmsEmpCode') el.readOnly=!!document.getElementById('hrmsEmpId').value;
      else el.disabled=false;
    } else {
      el.disabled=true;
    }
  });
  // Keep header status toggle in sync with edit mode
  var sh=document.getElementById('hrmsEmpStatusHeader');if(sh) sh.disabled=!editing;
  // Toggle buttons
  var viewBtns=document.getElementById('hrmsEmpViewBtns');
  var editBtns=document.getElementById('hrmsEmpEditBtns');
  if(viewBtns) viewBtns.style.display=editing?'none':'flex';
  if(editBtns) editBtns.style.display=editing?'flex':'none';
  // Delete button is only relevant in view mode; refresh its visibility too.
  if(!editing&&typeof _hrmsEmpRefreshDeleteBtn==='function') _hrmsEmpRefreshDeleteBtn();
  // New Revision: enabled only in edit mode AND only for already-saved
  // (approved) employees. Disabled when:
  //  • Adding a new employee (no id) — no record to revise yet.
  //  • Employee still pending its first ECR (`_isNewEcr`) — approve that first.
  //  • Active period is fully unlocked — user can edit the row in place
  //    (Plant / Emp Type / Salary / etc.), so a separate revision would
  //    just create unnecessary clutter. Once any month in the active
  //    period's range is locked, the button re-enables so changes can
  //    flow through ECR.
  var _empId=(document.getElementById('hrmsEmpId')||{}).value||'';
  var _emp=_empId?byId(DB.hrmsEmployees||[],_empId):null;
  var _isPending=!!(_emp&&_emp._isNewEcr);
  var _activeP=_emp&&_emp.periods?_emp.periods.find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');}):null;
  var _activeUnlocked=!!_activeP&&typeof _hrmsPeriodOverlapsLock==='function'
    &&!_hrmsPeriodOverlapsLock(_activeP.from,_activeP.to);
  var _nrEnabled=editing&&!!_empId&&!_isPending&&!_activeUnlocked;
  var _nrTitle=_nrEnabled?'':(
    !_empId?'Save the new employee first':
    _isPending?'Approve the pending creation first before adding revisions':
    _activeUnlocked?'Active period is unlocked — edit the row directly. Lock the month first if you want an ECR-tracked revision.':
    '');
  var nrBtn=document.querySelector('#hrmsEmpModalContent button[onclick="_hrmsNewPeriod()"]');
  if(nrBtn){nrBtn.disabled=!_nrEnabled;nrBtn.style.opacity=_nrEnabled?'1':'0.4';nrBtn.style.cursor=_nrEnabled?'pointer':'not-allowed';nrBtn.title=_nrTitle;}
  var rjBtn=document.getElementById('hrmsRejoinBtn');
  if(rjBtn&&rjBtn.style.display!=='none'){rjBtn.disabled=!editing;rjBtn.style.opacity=editing?'1':'0.4';rjBtn.style.cursor=editing?'pointer':'not-allowed';}
  // Rebuild periods table so period inputs also disable
  _hrmsBuildPeriodTable();
}

function _hrmsEmpEditStart(){
  // Snapshot current form for cancel-revert
  var id=document.getElementById('hrmsEmpId').value;
  var e=id?byId(DB.hrmsEmployees||[],id):null;
  _hrmsEmpEditSnap=e?JSON.parse(JSON.stringify(e)):null;
  _hrmsSetEmpEditMode(true);
}

function _hrmsEmpEditCancel(){
  if(!_hrmsEmpEditMode) return;
  // If this was a new (never-saved) employee, just close
  var id=document.getElementById('hrmsEmpId').value;
  if(!id){cm('mHrmsEmpEdit');return;}
  if(!confirm('Discard changes and return to view mode?')) return;
  // Reload from snapshot (restore employee state in memory)
  if(_hrmsEmpEditSnap){
    var orig=byId(DB.hrmsEmployees||[],id);
    if(orig) Object.keys(_hrmsEmpEditSnap).forEach(function(k){orig[k]=_hrmsEmpEditSnap[k];});
  }
  _hrmsEmpEditSnap=null;
  openHrmsEmpModal(id);// re-populate from memory
}

// ═══ EMPLOYEE HISTORY (Attendance & Salary, FY-wise since beginning) ══════
// ── Employee modal tabs ───────────────────────────────────────────
// Track which tab is visible and whether history has been loaded for the
// currently-open employee (keyed by empId). The cache lets tab-switching
// stay fast — we only hit Supabase on first open of the History tab.
var _hrmsEmpActiveTab='basic';
var _hrmsEmpHistoryLoadedFor=null;

function _hrmsEmpModalTab(tab){
  // Backward compat: 'basic' and 'org' both route to the combined 'details' tab.
  if(!tab||tab==='basic'||tab==='org') tab='details';
  _hrmsEmpActiveTab=tab;
  ['details','history'].forEach(function(t){
    var panel=document.getElementById('hrmsEmpTabPanel_'+t);
    var btn=document.getElementById('hrmsEmpTabBtn_'+t);
    if(panel) panel.style.display=(t===tab)?'':'none';
    if(btn){
      btn.style.borderBottomColor=(t===tab)?'var(--accent)':'transparent';
      btn.style.color=(t===tab)?'var(--accent)':'var(--text3)';
      btn.style.background=(t===tab)?'var(--accent-light)':'transparent';
    }
  });
  if(tab==='history'){
    var id=document.getElementById('hrmsEmpId')?.value;
    if(id&&_hrmsEmpHistoryLoadedFor!==id) _hrmsShowEmpHistory();
  }
}

// Live duplicate-check on the Employee Code input. Runs on every keystroke
// (and after blur). Updates an inline message below the field and tints the
// input border red/green. Self (when editing) is excluded from the lookup.
function _hrmsCheckEmpCode(){
  var input=document.getElementById('hrmsEmpCode');
  var msgEl=document.getElementById('hrmsEmpCodeMsg');
  if(!input) return;
  var raw=(input.value||'');
  var code=raw.replace(/[\r\n]+/g,'').trim();
  var setStyle=function(border,bg){
    input.style.borderColor=border||'';
    input.style.background=bg||'';
  };
  if(!code){
    setStyle('','');
    if(msgEl){msgEl.textContent='';msgEl.style.display='none';}
    return;
  }
  var currentId=(document.getElementById('hrmsEmpId')||{}).value||'';
  var dup=(DB.hrmsEmployees||[]).find(function(e){
    return(e.empCode||'').toUpperCase()===code.toUpperCase()&&e.id!==currentId;
  });
  if(dup){
    setStyle('#dc2626','#fef2f2');
    if(msgEl){
      var who=(dup.name||dup.empCode||'').toString();
      msgEl.innerHTML='⚠ Already used by <b>'+who+'</b>';
      msgEl.style.color='#dc2626';
      msgEl.style.display='';
    }
  } else {
    setStyle('#16a34a','#f0fdf4');
    if(msgEl){
      msgEl.textContent='✓ Code available';
      msgEl.style.color='#16a34a';
      msgEl.style.display='';
    }
  }
}

// Live duplicate-check on the employee's Full Name (last+first+middle). Names
// can legitimately match (common Indian names, family members), so this is
// a soft warning rather than a blocking error — listing the matching emp
// codes so the user can decide. Triggered from Full Name and the three
// individual name inputs.
function _hrmsCheckEmpName(){
  var msgEl=document.getElementById('hrmsEmpNameMsg');
  if(!msgEl) return;
  var last=((document.getElementById('hrmsEmpLastName')||{}).value||'').trim();
  var first=((document.getElementById('hrmsEmpFirstName')||{}).value||'').trim();
  var mid=((document.getElementById('hrmsEmpMiddleName')||{}).value||'').trim();
  if(!last||!first){
    msgEl.textContent='';msgEl.style.display='none';
    return;
  }
  var fullKey=(last+' '+first+' '+mid).toLowerCase().replace(/\s+/g,' ').trim();
  var currentId=(document.getElementById('hrmsEmpId')||{}).value||'';
  var matches=(DB.hrmsEmployees||[]).filter(function(e){
    if(e.id===currentId) return false;
    var eLast=(e.lastName||'').toLowerCase().trim();
    var eFirst=(e.firstName||'').toLowerCase().trim();
    var eMid=(e.middleName||'').toLowerCase().trim();
    var eKey=(eLast+' '+eFirst+' '+eMid).replace(/\s+/g,' ').trim();
    return eKey===fullKey;
  });
  if(matches.length){
    var who=matches.map(function(m){return '<b>'+m.empCode+'</b>';}).slice(0,5).join(', ');
    var more=matches.length>5?' (+'+(matches.length-5)+' more)':'';
    msgEl.innerHTML='⚠ Same name already used by '+matches.length+' employee(s): '+who+more;
    msgEl.style.color='#b45309';
    msgEl.style.background='#fef3c7';
    msgEl.style.padding='3px 8px';
    msgEl.style.borderRadius='4px';
    msgEl.style.display='';
  } else {
    msgEl.textContent='';msgEl.style.display='none';
    msgEl.style.background='';msgEl.style.padding='';msgEl.style.borderRadius='';
  }
}

// Split an "LastName FirstName MiddleName…" full-name string into the three
// individual fields. First whitespace-separated token = last name, second =
// first name, remainder joined = middle. Triggered as the user types in the
// Full Name input. Also called when the existing first/last/middle fields
// change to keep the Full Name display in sync.
function _hrmsSplitFullName(){
  var fnEl=document.getElementById('hrmsEmpFullName');
  if(!fnEl) return;
  var full=(fnEl.value||'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim();
  var parts=full?full.split(' '):[];
  var setVal=function(id,v){var el=document.getElementById(id);if(el) el.value=v||'';};
  setVal('hrmsEmpLastName',parts[0]||'');
  setVal('hrmsEmpFirstName',parts[1]||'');
  setVal('hrmsEmpMiddleName',parts.slice(2).join(' '));
  // Mirror to the legacy hidden hrmsEmpName field used by older code paths.
  setVal('hrmsEmpName',full);
  if(typeof _hrmsUpdateTitle==='function') _hrmsUpdateTitle();
}

function _hrmsSyncFullName(){
  var last=(document.getElementById('hrmsEmpLastName')||{}).value||'';
  var first=(document.getElementById('hrmsEmpFirstName')||{}).value||'';
  var mid=(document.getElementById('hrmsEmpMiddleName')||{}).value||'';
  var full=[last,first,mid].map(function(x){return(x||'').trim();}).filter(Boolean).join(' ');
  var fnEl=document.getElementById('hrmsEmpFullName');
  if(fnEl) fnEl.value=full;
}

async function _hrmsShowEmpHistory(){
  var id=document.getElementById('hrmsEmpId').value;
  var body=document.getElementById('hrmsEmpHistoryBody');
  if(!id){
    if(body) body.innerHTML='<div class="empty-state" style="padding:30px 20px;color:var(--text3)">Save the employee first to view history.</div>';
    return;
  }
  var emp=byId(DB.hrmsEmployees||[],id);
  if(!emp){
    if(body) body.innerHTML='<div class="empty-state" style="padding:30px 20px;color:var(--text3)">Employee not found.</div>';
    return;
  }
  var code=emp.empCode;
  if(body) body.innerHTML='<div class="empty-state" style="padding:30px 20px;color:var(--text3)">Loading history…</div>';

  // Fetch all saved month data for this employee. On-roll employees have a
  // direct row per month; contract employees are embedded in the per-month
  // `_meta` row's `meta.contract` array — we pull both and merge so the
  // history view works regardless of employment type.
  var rows=[];
  if(_sb&&_sbReady){
    try{
      var {data:directRows,error:directErr}=await _sb.from('hrms_month_data').select('*').eq('emp_code',code);
      if(!directErr&&directRows) rows=directRows.map(function(r){return _fromRow('hrmsMonthData',r);}).filter(Boolean);
    }catch(e){console.warn('Load history (direct) error:',e);}
    try{
      var {data:metaRows,error:metaErr}=await _sb.from('hrms_month_data').select('month_key,meta').eq('emp_code','_meta');
      if(!metaErr&&metaRows){
        var byMk={};rows.forEach(function(r){byMk[r.monthKey]=true;});
        metaRows.forEach(function(m){
          var mk=m.month_key;
          if(byMk[mk]) return;// already have a direct row for this month — skip
          var list=m.meta&&m.meta.contract;
          if(!Array.isArray(list)) return;
          var cr=list.find(function(x){return String(x.empCode||'').trim()===String(code||'').trim();});
          if(!cr) return;
          // Synthesize a hrmsMonthData-shaped row from the contract snapshot.
          var otTot=(+cr.OT||0)+(+cr.OTS||0);
          var pf=+cr.pf||0, esi=+cr.esi||0;
          rows.push({
            monthKey:mk, empCode:code,
            rateD:+cr.rateD||0, rateM:+cr.rateM||0,
            wdCount:+cr.wdCount||0,
            totalP:+cr.P||0, totalA:+cr.A||0,
            totalOT:+cr.OT||0, totalOTS:+cr.OTS||0,
            totalPL:0,
            gross:+cr.gross||0,
            advDed:0, dedTotal:pf+esi,
            net:+cr.totalSal||(+cr.gross||0),
            _contract:true
          });
          byMk[mk]=true;
        });
      }
    }catch(e){console.warn('Load history (meta) error:',e);}
  }
  _hrmsEmpHistoryLoadedFor=id;

  if(!rows.length){
    if(body) body.innerHTML='<div class="empty-state" style="padding:30px 20px;color:var(--text3)">No saved history for <b>'+code+'</b>.<br><span style="font-size:11px">History shows data only from months that have been <b>Saved &amp; Locked</b>.</span></div>';
    return;
  }

  // Sort by monthKey ascending
  rows.sort(function(a,b){return(a.monthKey||'').localeCompare(b.monthKey||'');});

  // Group by Financial Year (April→March)
  var fyGroups={};
  rows.forEach(function(r){
    var p=(r.monthKey||'').split('-');var yr=+p[0],mo=+p[1];
    var fyStart=mo>=4?yr:yr-1;
    var fyKey=fyStart+'-'+(fyStart+1);
    if(!fyGroups[fyKey]) fyGroups[fyKey]={fyKey:fyKey,fyStart:fyStart,months:[]};
    fyGroups[fyKey].months.push(r);
  });
  var fys=Object.keys(fyGroups).sort().reverse().map(function(k){return fyGroups[k];});

  var h='';
  var _r=function(v){return Math.round(v||0).toLocaleString();};
  var _f=function(v){if(!v&&v!==0)return'0';if(v%1===0)return String(v);return(Math.round(v*4)/4).toFixed(2).replace(/\.?0+$/,'');};

  fys.forEach(function(fy){
    // Compute FY totals
    var tot={totalP:0,totalA:0,totalOT:0,totalOTS:0,totalPL:0,gross:0,dedTotal:0,net:0,advOB:0,advCB:0,advDed:0};
    fy.months.forEach(function(m){
      tot.totalP+=m.totalP||0;tot.totalA+=m.totalA||0;
      tot.totalOT+=m.totalOT||0;tot.totalOTS+=m.totalOTS||0;tot.totalPL+=m.totalPL||0;
      tot.gross+=m.gross||0;tot.dedTotal+=m.dedTotal||0;tot.net+=m.net||0;
      tot.advDed+=m.advDed||0;
    });
    // First and last for OB/CB
    var first=fy.months[0],last=fy.months[fy.months.length-1];
    tot.advOB=first?(first.advOB||0):0;
    tot.advCB=last?(last.advCB||0):0;

    h+='<div style="margin-bottom:16px;border:1.5px solid var(--border);border-radius:10px;overflow:hidden">';
    h+='<div style="background:#7c3aed;color:#fff;padding:8px 14px;font-size:14px;font-weight:900;display:flex;justify-content:space-between;align-items:center">';
    h+='<span>FY '+fy.fyKey+' (Apr '+fy.fyStart+' — Mar '+(fy.fyStart+1)+')</span>';
    h+='<span style="font-size:12px;font-weight:700;opacity:0.95">Net: ₹'+_r(tot.net)+' · Gross: ₹'+_r(tot.gross)+' · '+fy.months.length+' month'+(fy.months.length>1?'s':'')+'</span>';
    h+='</div>';
    h+='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:11px">';
    h+='<thead><tr style="background:#f1f5f9;color:var(--text)">';
    var _th='padding:5px 6px;font-size:10px;font-weight:800;border-bottom:1px solid var(--border);white-space:nowrap';
    h+='<th style="'+_th+';text-align:left">Month</th>';
    h+='<th style="'+_th+';text-align:right">Sal/Day</th>';
    h+='<th style="'+_th+';text-align:right">Sal/Mon</th>';
    h+='<th style="'+_th+';text-align:right;background:#dbeafe">WD</th>';
    h+='<th style="'+_th+';text-align:right;background:#dcfce7">P</th>';
    h+='<th style="'+_th+';text-align:right;background:#fee2e2">A</th>';
    h+='<th style="'+_th+';text-align:right;background:#fff7ed">OT</th>';
    h+='<th style="'+_th+';text-align:right;background:#fff7ed">OT@S</th>';
    h+='<th style="'+_th+';text-align:right;background:#f3e8ff">PL</th>';
    h+='<th style="'+_th+';text-align:right;background:#f0fdf4">Gross</th>';
    h+='<th style="'+_th+';text-align:right;background:#fef2f2">Adv Ded</th>';
    h+='<th style="'+_th+';text-align:right;background:#f1f5f9">Total Ded</th>';
    h+='<th style="'+_th+';text-align:right;background:#dcfce7">Net</th>';
    h+='</tr></thead><tbody>';
    fy.months.forEach(function(m){
      h+='<tr style="border-bottom:1px solid #f1f5f9">';
      h+='<td style="padding:4px 6px;font-weight:700">'+_hrmsShortMonth(m.monthKey)+'</td>';
      h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono)">'+(m.rateD?_r(m.rateD):'—')+'</td>';
      h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono)">'+(m.rateM?_r(m.rateM):'—')+'</td>';
      h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono)">'+(m.wdCount||0)+'</td>';
      h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);color:#16a34a;font-weight:700">'+_f(m.totalP)+'</td>';
      h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);color:#dc2626">'+_f(m.totalA)+'</td>';
      h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);color:#c2410c">'+_f(m.totalOT)+'</td>';
      h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);color:#c2410c">'+_f(m.totalOTS)+'</td>';
      h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);color:#7c3aed">'+_f(m.totalPL)+'</td>';
      h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);font-weight:700">'+_r(m.gross)+'</td>';
      h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);color:#dc2626">'+_r(m.advDed)+'</td>';
      h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono)">'+_r(m.dedTotal)+'</td>';
      h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);font-weight:900;color:#15803d">'+_r(m.net)+'</td>';
      h+='</tr>';
    });
    // FY totals row
    h+='<tr style="background:#f1f5f9;font-weight:900;border-top:2px solid var(--border)">';
    h+='<td style="padding:6px 6px;font-weight:900">FY Total</td>';
    h+='<td colspan="2"></td>';
    h+='<td style="padding:6px 6px;text-align:right;font-family:var(--mono)"></td>';
    h+='<td style="padding:6px 6px;text-align:right;font-family:var(--mono);color:#16a34a">'+_f(tot.totalP)+'</td>';
    h+='<td style="padding:6px 6px;text-align:right;font-family:var(--mono);color:#dc2626">'+_f(tot.totalA)+'</td>';
    h+='<td style="padding:6px 6px;text-align:right;font-family:var(--mono);color:#c2410c">'+_f(tot.totalOT)+'</td>';
    h+='<td style="padding:6px 6px;text-align:right;font-family:var(--mono);color:#c2410c">'+_f(tot.totalOTS)+'</td>';
    h+='<td style="padding:6px 6px;text-align:right;font-family:var(--mono);color:#7c3aed">'+_f(tot.totalPL)+'</td>';
    h+='<td style="padding:6px 6px;text-align:right;font-family:var(--mono);color:#15803d">'+_r(tot.gross)+'</td>';
    h+='<td style="padding:6px 6px;text-align:right;font-family:var(--mono);color:#dc2626">'+_r(tot.advDed)+'</td>';
    h+='<td style="padding:6px 6px;text-align:right;font-family:var(--mono)">'+_r(tot.dedTotal)+'</td>';
    h+='<td style="padding:6px 6px;text-align:right;font-family:var(--mono);color:#15803d;font-size:13px">'+_r(tot.net)+'</td>';
    h+='</tr>';
    h+='</tbody></table></div></div>';
  });

  h+='<div style="font-size:11px;color:var(--text3);margin-top:8px;padding:8px;background:#f1f5f9;border-radius:6px">ℹ History only includes months that have been <b>Saved &amp; Locked</b>. Unlocked months (in progress) are not shown.</div>';

  if(body) body.innerHTML=h;
}

function _hrmsQuickOpenEmp(q){
  q=(q||'').trim();if(!q){notify('Enter an Emp Code or name',true);return;}
  var emps=DB.hrmsEmployees||[];
  // 1. Exact emp code match (case-insensitive)
  var ql=q.toLowerCase();
  var emp=emps.find(function(e){return(e.empCode||'').toLowerCase()===ql;});
  // 2. Exact name match
  if(!emp) emp=emps.find(function(e){return(_hrmsDispName(e)||e.name||'').toLowerCase()===ql;});
  // 3. Contains match — emp code or name (single result preferred)
  if(!emp){
    var matches=emps.filter(function(e){
      var c=(e.empCode||'').toLowerCase(),n=(_hrmsDispName(e)||e.name||'').toLowerCase();
      return c.indexOf(ql)>=0||n.indexOf(ql)>=0;
    });
    if(matches.length===1) emp=matches[0];
    else if(matches.length>1){notify(matches.length+' matches — pick one from the suggestions',true);return;}
  }
  if(!emp){notify('No employee matches "'+q+'"',true);return;}
  openHrmsEmpModal(emp.id);
}
function _hrmsEmpNav(dir){
  var curId=document.getElementById('hrmsEmpId')?.value;
  if(!curId) return;
  if(!_hrmsEmpNavList.length) _hrmsEmpNavList=_hrmsGetFilteredEmployees().map(function(e){return e.id;});
  var idx=_hrmsEmpNavList.indexOf(curId);
  if(idx<0) return;
  var nextIdx=idx+dir;
  if(nextIdx<0||nextIdx>=_hrmsEmpNavList.length) return;
  openHrmsEmpModal(_hrmsEmpNavList[nextIdx]);
  _hrmsUpdateNavBtns();
}
function _hrmsUpdateNavBtns(){
  var curId=document.getElementById('hrmsEmpId')?.value;
  var prevBtn=document.getElementById('hrmsEmpPrevBtn');
  var nextBtn=document.getElementById('hrmsEmpNextBtn');
  var posEl=document.getElementById('hrmsEmpNavPos');
  if(!prevBtn||!nextBtn) return;
  if(!curId||!_hrmsEmpNavList.length){prevBtn.disabled=true;nextBtn.disabled=true;if(posEl)posEl.textContent='';return;}
  var idx=_hrmsEmpNavList.indexOf(curId);
  prevBtn.disabled=idx<=0;prevBtn.style.opacity=idx<=0?'0.35':'1';
  nextBtn.disabled=idx<0||idx>=_hrmsEmpNavList.length-1;nextBtn.style.opacity=(idx<0||idx>=_hrmsEmpNavList.length-1)?'0.35':'1';
  if(posEl) posEl.textContent=(idx+1)+' / '+_hrmsEmpNavList.length;
}
function openHrmsEmpModal(id){
  var e=id?byId(DB.hrmsEmployees||[],id):null;
  // Render form into the modal body
  var el=document.getElementById('hrmsEmpModalContent')||document.getElementById('hrmsEmpEditContent');
  if(el) el.innerHTML='<div>'
    +'<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;position:relative"><div style="position:relative"><input type="text" id="hrmsEmpQuickSearch" placeholder="Type Emp Code or Name…" autocomplete="off" oninput="_hrmsEmpAC(this)" onfocus="_hrmsEmpAC(this)" onblur="setTimeout(function(){_hrmsEmpACClose(\'hrmsEmpQuickSearch\')},200)" onchange="_hrmsQuickOpenEmp(this.value)" onkeydown="if(event.key===\'Enter\'){_hrmsEmpACClose(\'hrmsEmpQuickSearch\');_hrmsQuickOpenEmp(this.value);}" style="font-size:13px;padding:6px 12px;border:2px solid var(--accent);border-radius:6px;width:280px"><div id="ac_hrmsEmpQuickSearch" style="display:none;position:absolute;top:100%;left:0;right:0;max-height:280px;overflow-y:auto;background:#fff;border:1.5px solid var(--accent);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:10000;margin-top:2px"></div></div><button onclick="_hrmsQuickOpenEmp(document.getElementById(\'hrmsEmpQuickSearch\').value)" style="padding:6px 14px;font-size:12px;font-weight:700;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer">Go</button></div>'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;border-bottom:2px solid var(--accent);padding-bottom:8px"><div style="display:flex;align-items:center;gap:10px"><div><div style="font-size:18px;font-weight:900;color:var(--accent)" id="mHrmsEmpTitle">Add Employee</div><div id="hrmsEmpSubHeader" style="display:none;margin-top:4px;font-size:11px;color:var(--text2);display:flex;gap:6px;flex-wrap:wrap"></div></div></div><div style="display:flex;gap:6px;align-items:center">'
    +'<button id="hrmsEmpPrevBtn" onclick="_hrmsEmpNav(-1)" style="padding:6px 12px;font-size:16px;font-weight:900;background:var(--surface2);border:1.5px solid var(--border);border-radius:6px;cursor:pointer;color:var(--text)">‹</button>'
    +'<span id="hrmsEmpNavPos" style="font-size:11px;font-weight:700;color:var(--text3);min-width:50px;text-align:center"></span>'
    +'<button id="hrmsEmpNextBtn" onclick="_hrmsEmpNav(1)" style="padding:6px 12px;font-size:16px;font-weight:900;background:var(--surface2);border:1.5px solid var(--border);border-radius:6px;cursor:pointer;color:var(--text)">›</button>'
    // View-mode buttons
    +'<div id="hrmsEmpViewBtns" style="display:flex;gap:6px">'
    +'<button onclick="_hrmsEmpEditStart()" style="font-size:12px;padding:7px 20px;font-weight:800;background:#f59e0b;color:#fff;border:none;border-radius:6px;cursor:pointer">✏️ Edit</button>'
    +'<button id="hrmsEmpDeleteBtn" onclick="_hrmsEmpDeleteFromModal()" style="display:none;font-size:12px;padding:7px 16px;font-weight:800;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer">🗑 Delete</button>'
    +'<button class="btn btn-secondary" onclick="_hrmsBackToList()" style="font-size:12px;padding:7px 16px">✕ Close</button>'
    +'</div>'
    // Edit-mode buttons
    +'<div id="hrmsEmpEditBtns" style="display:none;gap:6px">'
    +'<button class="btn btn-secondary" onclick="_hrmsEmpEditCancel()" style="font-size:12px;padding:7px 16px">✕ Cancel</button>'
    +'<button class="btn btn-primary" onclick="saveHrmsEmp()" style="font-size:12px;padding:7px 20px">💾 Save</button>'
    +'</div>'
    +'</div></div>'
    +'<div class="modal-error" id="mHrmsEmpErr" style="display:none"></div>'
    +'<input type="hidden" id="hrmsEmpId"><input type="hidden" id="hrmsEmpName">'
    // Tab bar — 2 tabs: combined Details (Basic Info + Org & Salary) and History.
    +'<div style="display:flex;gap:0;margin:6px 0 12px;border-bottom:2px solid var(--border)">'
    +'<div id="hrmsEmpTabBtn_details" onclick="_hrmsEmpModalTab(\'details\')" style="padding:8px 18px;font-size:13px;font-weight:800;cursor:pointer;border-bottom:3px solid var(--accent);background:var(--accent-light);color:var(--accent)">👤 Employee Details</div>'
    +'<div id="hrmsEmpTabBtn_history" onclick="_hrmsEmpModalTab(\'history\')" style="padding:8px 18px;font-size:13px;font-weight:800;cursor:pointer;border-bottom:3px solid transparent;color:var(--text3)">📊 History</div>'
    +'</div>'
    // ── DETAILS PANEL: 2-col layout (Personal | Statutory + Banking),
    //    then Organization & Salary full-width below.
    +'<div id="hrmsEmpTabPanel_details">'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">'
    // ── Column 1: Personal Information ──
    +'<div style="border:1.5px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--surface)">'
    +'<div style="font-size:11px;font-weight:800;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;padding-bottom:4px;border-bottom:2px solid var(--accent-light)">Personal Information</div>'
    // Row 1: Code + Full Name
    +'<div style="display:grid;grid-template-columns:140px 1fr;gap:8px;margin-bottom:4px"><div class="form-group"><label>Employee Code *</label><input type="text" id="hrmsEmpCode" oninput="_hrmsCheckEmpCode()" onblur="_hrmsCheckEmpCode()"><div id="hrmsEmpCodeMsg" style="display:none;font-size:10px;font-weight:700;margin-top:3px"></div></div><div class="form-group"><label>Full Name (auto-splits) *</label><input type="text" id="hrmsEmpFullName" oninput="_hrmsSplitFullName();_hrmsCheckEmpName()" placeholder="LastName FirstName MiddleName" autocomplete="off"><div id="hrmsEmpNameMsg" style="display:none;font-size:10px;font-weight:700;margin-top:3px"></div></div></div>'
    // Row 2: Last/First/Middle/Gender
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr 90px;gap:8px;margin-bottom:4px"><div class="form-group"><label>Last Name * <span style="font-weight:400;color:var(--text3);text-transform:none;letter-spacing:0">(auto)</span></label><input type="text" id="hrmsEmpLastName" readonly tabindex="-1" style="background:var(--surface2);color:var(--text2);cursor:not-allowed"></div><div class="form-group"><label>First Name * <span style="font-weight:400;color:var(--text3);text-transform:none;letter-spacing:0">(auto)</span></label><input type="text" id="hrmsEmpFirstName" readonly tabindex="-1" style="background:var(--surface2);color:var(--text2);cursor:not-allowed"></div><div class="form-group"><label>Middle Name <span style="font-weight:400;color:var(--text3);text-transform:none;letter-spacing:0">(auto)</span></label><input type="text" id="hrmsEmpMiddleName" readonly tabindex="-1" style="background:var(--surface2);color:var(--text2);cursor:not-allowed"></div><div class="form-group"><label>Gender</label><select id="hrmsEmpGender" style="padding:8px 4px"><option value="">--</option><option value="Male">Male</option><option value="Female">Female</option></select></div></div>'
    // Row 3: DOB / Age / Email / Mobile
    +'<div style="display:grid;grid-template-columns:140px 60px 1fr 130px;gap:8px;margin-bottom:4px"><div class="form-group"><label>Date of Birth</label><input type="date" id="hrmsEmpDOB" onchange="_hrmsShowAge()"></div><div class="form-group"><label>Age</label><input type="text" id="hrmsEmpAge" readonly style="background:var(--surface2);font-weight:700;color:var(--accent)"></div><div class="form-group"><label>Email</label><input type="email" id="hrmsEmpEmail"></div><div class="form-group"><label>Mobile</label><input type="text" id="hrmsEmpMobile"></div></div>'
    // Row 4: DOJ + PL
    +'<div style="display:grid;grid-template-columns:140px 1fr;gap:8px"><div class="form-group"><label>Date of Joining</label><input type="date" id="hrmsEmpDOJ"></div><div class="form-group" style="display:flex;align-items:center;gap:6px;padding-top:18px"><input type="checkbox" id="hrmsEmpNoPL" style="width:16px;height:16px;accent-color:#dc2626;cursor:pointer"><label for="hrmsEmpNoPL" style="font-size:12px;font-weight:700;color:#dc2626;cursor:pointer;text-transform:none;letter-spacing:0">Paid Leaves not applicable</label></div></div>'
    +'</div>'
    // ── Column 2: Statutory (top) + Banking (bottom) ──
    +'<div style="display:flex;flex-direction:column;gap:10px">'
    +'<div style="border:1.5px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--surface)">'
    +'<div style="font-size:11px;font-weight:800;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;padding-bottom:4px;border-bottom:2px solid var(--accent-light)">Statutory Details</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1fr;gap:8px"><div class="form-group"><label>PAN No.</label><input type="text" id="hrmsEmpPan"></div><div class="form-group"><label>AADHAAR No.</label><input type="text" id="hrmsEmpAadhaar"></div><div class="form-group"><label>ESI No.</label><input type="text" id="hrmsEmpEsi"></div><div class="form-group"><label>PF No.</label><input type="text" id="hrmsEmpPf"></div><div class="form-group"><label>UAN</label><input type="text" id="hrmsEmpUan"></div></div>'
    +'</div>'
    +'<div style="border:1.5px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--surface)">'
    +'<div style="font-size:11px;font-weight:800;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;padding-bottom:4px;border-bottom:2px solid var(--accent-light)">Banking Details</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px"><div class="form-group"><label>Bank Name</label><input type="text" id="hrmsEmpBankName"></div><div class="form-group"><label>Branch Name</label><input type="text" id="hrmsEmpBranchName"></div><div class="form-group"><label>Account Number</label><input type="text" id="hrmsEmpAcctNo"></div><div class="form-group"><label>IFSC Code</label><input type="text" id="hrmsEmpIfsc"></div></div>'
    +'</div>'
    +'</div>'
    +'</div>'
    // ── Organization & Salary (Revisions) — directly below Basic Info ──
    +'<div style="font-size:11px;font-weight:800;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin:14px 0 8px;padding-bottom:3px;border-bottom:2px solid var(--accent-light);display:flex;align-items:center;justify-content:space-between"><span>Organization &amp; Salary (Revisions)</span><div style="display:flex;gap:6px;text-transform:none;letter-spacing:0"><button type="button" id="hrmsRejoinBtn" onclick="_hrmsRejoinEmployee()" style="display:none;font-size:10px;padding:3px 12px;font-weight:800;background:#16a34a;color:#fff;border:none;border-radius:5px;cursor:pointer">🔄 Rejoin</button><button type="button" onclick="_hrmsNewPeriod()" style="font-size:10px;padding:3px 12px;font-weight:800;background:var(--accent);color:#fff;border:none;border-radius:5px;cursor:pointer">+ New Revision</button></div></div>'
    +'<div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px"><table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="background:#f1f5f9;color:#000"><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:40px;text-align:center">Rev</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;width:62px;min-width:62px;text-align:center">From</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;width:76px;min-width:76px;text-align:center">To</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:90px">Plant</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:90px">Emp Type</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:80px">Category</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:80px">Team</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:90px">Department</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:90px">Designation</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:50px">Role</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:68px;text-align:right">Sal/Day</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:88px;text-align:right">Sal/Mon</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:68px;text-align:right">Sp.Allow</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:50px;text-align:center">ESI</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:78px;text-align:center">Status</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:100px">Remarks</th><th style="padding:6px 4px;font-size:12px;font-weight:900;color:#000;min-width:80px"></th></tr></thead><tbody id="hrmsEmpPeriodBody"></tbody></table></div>'
    +'</div>'
    // ── HISTORY PANEL ─────────────────────────────────────────
    +'<div id="hrmsEmpTabPanel_history" style="display:none">'
    +'<div id="hrmsEmpHistoryBody"><div class="empty-state" style="padding:40px 20px;color:var(--text3)">Click the History tab to load…</div></div>'
    +'</div>'
    +'</div>';
  // Open as modal popup
  om('mHrmsEmpEdit');
  // Populate fields
  document.getElementById('hrmsEmpId').value=id||'';
  document.getElementById('mHrmsEmpErr').style.display='none';
  document.getElementById('hrmsEmpCode').value=e?e.empCode:'';
  document.getElementById('hrmsEmpCode').readOnly=!!id;
  document.getElementById('hrmsEmpCode').style.background=id?'var(--surface2)':'';
  document.getElementById('hrmsEmpName').value=e?e.name:'';
  document.getElementById('hrmsEmpLastName').value=e?e.lastName||'':'';
  document.getElementById('hrmsEmpFirstName').value=e?e.firstName||'':'';
  document.getElementById('hrmsEmpMiddleName').value=e?e.middleName||'':'';
  // Auto-split legacy `name` into last/first if individual fields are empty.
  if(e&&e.name&&!e.lastName) _hrmsSplitName();
  // Mirror the three name fields back to the visible Full Name input.
  if(typeof _hrmsSyncFullName==='function') _hrmsSyncFullName();
  document.getElementById('hrmsEmpGender').value=e?(e.gender||''):'Male';
  document.getElementById('hrmsEmpDOB').value=e?e.dateOfBirth:'';
  _hrmsShowAge();
  document.getElementById('hrmsEmpDOJ').value=e?e.dateOfJoining:'';
  document.getElementById('hrmsEmpNoPL').checked=e?!!e.noPL:false;
  document.getElementById('hrmsEmpPan').value=e?e.panNo:'';
  document.getElementById('hrmsEmpAadhaar').value=e?e.aadhaarNo:'';
  document.getElementById('hrmsEmpEsi').value=e?e.esiNo:'';
  document.getElementById('hrmsEmpPf').value=e?e.pfNo:'';
  document.getElementById('hrmsEmpUan').value=e?e.uan:'';
  document.getElementById('hrmsEmpEmail').value=e?e.email:'';
  document.getElementById('hrmsEmpMobile').value=e?e.mobile:'';
  document.getElementById('hrmsEmpBankName').value=e?e.bankName||'':'';
  document.getElementById('hrmsEmpBranchName').value=e?e.branchName||'':'';
  document.getElementById('hrmsEmpAcctNo').value=e?e.acctNo||'':'';
  document.getElementById('hrmsEmpIfsc').value=e?e.ifsc||'':'';
  // Initialize periods
  if(e){
    _hrmsEmpPeriods=_hrmsMigratePeriods(e);
  } else {
    // New-employee defaults: most additions are Contract Workers at Plant-2
    // → Fabrication. Pre-fills these so the user only edits what differs;
    // dropdowns will show "(not in master)" if the master doesn't have
    // matching entries on this install.
    _hrmsEmpPeriods=[{
      from:_hrmsCurMonth(),to:null,
      location:'Plant-2',
      department:'Fabrication',
      subDepartment:'',
      designation:'',
      employmentType:'Contract',
      teamName:'',
      category:'Worker',
      roll:'',
      reportingTo:'',
      salaryDay:0,salaryMonth:0,specialAllowance:0,
      esiApplicable:'Yes',// matches Worker default
      status:'Active',dateOfLeft:''
    }];
  }
  _hrmsActivePeriodIdx=0;
  _hrmsBuildPeriodTable();
  _hrmsUpdateTitle();// must run after periods are loaded so status renders
  _hrmsUpdateSubHeader();
  _hrmsUpdateNavBtns();
  _hrmsShowRejoinBtn();
  if(typeof _hrmsEmpRefreshDeleteBtn==='function') _hrmsEmpRefreshDeleteBtn();
  // New employee → open directly in edit mode. Existing → open in view mode.
  _hrmsEmpEditMode=!id;
  _hrmsEmpEditSnap=null;
  _hrmsApplyEmpEditModeToForm();
  // Reset to Details tab on each open; invalidate history cache so the
  // employee's history is re-fetched when that tab is next opened.
  _hrmsEmpHistoryLoadedFor=null;
  _hrmsEmpModalTab('details');
}

// Sanitize employee data: trim all strings, title case names
function _hrmsSanitize(obj){
  if(!obj) return obj;
  Object.keys(obj).forEach(function(k){
    if(typeof obj[k]==='string') obj[k]=obj[k].replace(/[\r\n]+/g,' ').trim();
  });
  // Title case name fields
  ['name','lastName','firstName','middleName'].forEach(function(f){
    if(obj[f]) obj[f]=obj[f].replace(/\w\S*/g,function(t){return t.charAt(0).toUpperCase()+t.substr(1).toLowerCase();});
  });
  // Uppercase statutory fields
  ['panNo','aadhaarNo','esiNo','pfNo','uan','ifsc','empCode'].forEach(function(f){
    if(obj[f]) obj[f]=obj[f].toUpperCase();
  });
  return obj;
}
// _hrmsSanitizePeriods is in hrms-logic.js
// Show a confirm-before-save popup summarising the key employee fields.
// Returns a Promise that resolves to true on Confirm or false on Cancel.
function _hrmsConfirmEmpSave(info){
  return new Promise(function(resolve){
    var _esc=function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
    // For NEW employee saves, highlight the three fields most often gotten
    // wrong — Emp Type, Team, Salary — in a flashing red so the user
    // double-checks them before confirming. Edit saves use normal styling.
    var flashKeys=info.isNew?{'Emp Type':1,'Team':1,'Salary':1}:{};
    var rows=[
      ['Emp Code',info.code],
      ['Name',info.name],
      ['Plant',info.plant],
      ['Emp Type',info.empType],
      ['Category',info.category],
      ['Team',info.team],
      ['Department',info.department],
      ['Role',info.role],
      ['Salary',info.salary]
    ];
    var trs=rows.map(function(r){
      var flash=!!flashKeys[r[0]];
      var labelStyle='padding:6px 10px;font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.4px;width:120px;border-bottom:1px solid #f1f5f9';
      var valStyle='padding:6px 10px;font-size:13px;font-weight:700;color:var(--text);border-bottom:1px solid #f1f5f9';
      var labelClass=flash?' class="_hrms-cf-flash"':'';
      var valClass=flash?' class="_hrms-cf-flash"':'';
      return '<tr><td'+labelClass+' style="'+labelStyle+'">'+_esc(r[0])+'</td><td'+valClass+' style="'+valStyle+'">'+_esc(r[1])+'</td></tr>';
    }).join('');
    var titleTxt=info.isNew?'Confirm New Employee':'Confirm Employee Save';
    var subTxt=info.isNew
      ?'This entry will be submitted for approval (visible in Change Requests until approved).'
      :'These changes will be saved to the employee record.';
    var html=''
     +'<div id="_hrmsEmpConfirmOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:10000">'
     +'<style>@keyframes _hrmsCfFlash{0%,100%{color:#dc2626;background:#fee2e2}50%{color:#7f1d1d;background:#fecaca}}._hrms-cf-flash{animation:_hrmsCfFlash 0.9s infinite;font-weight:900!important;color:#dc2626!important}</style>'
     +'<div style="background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);width:min(520px,94vw);max-height:90vh;overflow:auto;padding:0">'
     +'<div style="padding:14px 18px;border-bottom:2px solid var(--accent-light);display:flex;justify-content:space-between;align-items:center">'
     +'<div><div style="font-size:16px;font-weight:900;color:var(--accent)">'+titleTxt+'</div><div style="font-size:11px;font-weight:600;color:var(--text2);margin-top:2px">'+subTxt+'</div></div>'
     +'<button id="_hrmsEmpConfirmX" style="background:transparent;border:none;font-size:22px;cursor:pointer;color:var(--text3);line-height:1">×</button>'
     +'</div>'
     +'<div style="padding:8px 12px"><table style="width:100%;border-collapse:collapse">'+trs+'</table></div>'
     +'<div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">'
     +'<button id="_hrmsEmpConfirmCancel" style="font-size:13px;padding:8px 18px;font-weight:700;background:var(--surface2);border:1.5px solid var(--border);color:var(--text2);border-radius:6px;cursor:pointer">✕ Cancel</button>'
     +'<button id="_hrmsEmpConfirmOk" style="font-size:13px;padding:8px 22px;font-weight:800;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer">✓ Confirm &amp; Save</button>'
     +'</div></div></div>';
    var prior=document.getElementById('_hrmsEmpConfirmOverlay');if(prior) prior.remove();
    var tmp=document.createElement('div');tmp.innerHTML=html;
    var node=tmp.firstChild;
    document.body.appendChild(node);
    var done=false;
    var finish=function(ans){
      if(done) return;done=true;
      var n=document.getElementById('_hrmsEmpConfirmOverlay');if(n) n.remove();
      resolve(!!ans);
    };
    document.getElementById('_hrmsEmpConfirmOk').onclick=function(){finish(true);};
    document.getElementById('_hrmsEmpConfirmCancel').onclick=function(){finish(false);};
    document.getElementById('_hrmsEmpConfirmX').onclick=function(){finish(false);};
    node.addEventListener('click',function(ev){if(ev.target===node) finish(false);});
    setTimeout(function(){var ok=document.getElementById('_hrmsEmpConfirmOk');if(ok) ok.focus();},30);
  });
}

async function saveHrmsEmp(){
  var id=document.getElementById('hrmsEmpId').value;
  var code=document.getElementById('hrmsEmpCode').value.trim();
  var lastName=document.getElementById('hrmsEmpLastName').value.trim();
  var firstName=document.getElementById('hrmsEmpFirstName').value.trim();
  var middleName=document.getElementById('hrmsEmpMiddleName').value.trim();
  var name=[lastName,firstName,middleName].filter(Boolean).join(' ');
  if(!code||!firstName||!lastName){modalErr('mHrmsEmp','Employee Code, First Name and Last Name are required');return;}
  if((DB.hrmsEmployees||[]).find(function(e){return(e.empCode||'').toUpperCase()===code.toUpperCase()&&e.id!==id;})){modalErr('mHrmsEmp','Employee Code already exists');return;}
  // Mandatory period fields — Plant / Emp Type / Category / Team must all be
  // set before save. _hrmsEmpPeriods[0] is the row being persisted (draft or
  // active in edit mode, proposed for new employees).
  var _topP=_hrmsEmpPeriods[0]||{};
  var _missing=[];
  if(!(_topP.location||'').trim()) _missing.push('Plant');
  if(!(_topP.employmentType||'').trim()) _missing.push('Emp Type');
  if(!(_topP.category||'').trim()) _missing.push('Category');
  if(!(_topP.teamName||'').trim()) _missing.push('Team');
  if(_missing.length){
    modalErr('mHrmsEmp','Please pick the following required field(s) in Organization & Salary (Revisions): '+_missing.join(', '));
    return;
  }
  // Confirmation popup — show key fields before persisting.
  var _confAp=_hrmsEmpPeriods[0]||{};
  var _confSal=(+_confAp.salaryDay||0)
    ?('₹'+(+_confAp.salaryDay).toLocaleString('en-IN')+' / day')
    :((+_confAp.salaryMonth||0)?('₹'+(+_confAp.salaryMonth).toLocaleString('en-IN')+' / month'):'—');
  var _confOk=await _hrmsConfirmEmpSave({
    code:code,name:name,
    plant:_confAp.location||'—',
    empType:_confAp.employmentType||'—',
    category:_confAp.category||'—',
    team:_confAp.teamName||'—',
    department:_confAp.department||'—',
    role:_confAp.roll||'—',
    salary:_confSal,
    isNew:!id
  });
  if(!_confOk) return;
  // Save current period form values to memory
  _hrmsSavePeriodToMemory();
  // Clean temp flags before saving to DB
  _hrmsEmpPeriods.forEach(function(p){delete p._saved;});
  // Active period = first (newest), sync flat fields for backward compat
  var ap=_hrmsEmpPeriods[0]||{};
  var data={empCode:code,name:name,lastName:lastName,firstName:firstName,middleName:middleName,gender:document.getElementById('hrmsEmpGender').value,dateOfBirth:document.getElementById('hrmsEmpDOB').value,dateOfJoining:document.getElementById('hrmsEmpDOJ').value,noPL:document.getElementById('hrmsEmpNoPL').checked,panNo:document.getElementById('hrmsEmpPan').value.trim(),aadhaarNo:document.getElementById('hrmsEmpAadhaar').value.trim(),esiNo:document.getElementById('hrmsEmpEsi').value.trim(),pfNo:document.getElementById('hrmsEmpPf').value.trim(),uan:document.getElementById('hrmsEmpUan').value.trim(),email:document.getElementById('hrmsEmpEmail').value.trim(),mobile:document.getElementById('hrmsEmpMobile').value.trim(),bankName:document.getElementById('hrmsEmpBankName').value.trim(),branchName:document.getElementById('hrmsEmpBranchName').value.trim(),acctNo:document.getElementById('hrmsEmpAcctNo').value.trim(),ifsc:document.getElementById('hrmsEmpIfsc').value.trim(),periods:_hrmsEmpPeriods};
  // Sync flat fields from active period for backward compat (table display, export, etc.)
  _PERIOD_FIELDS.forEach(function(f){data[f]=ap[f]||'';});
  // `ap` above is _hrmsEmpPeriods[0] — which is the draft row when one exists.
  // Status must always reflect the TRUE active period so downstream filters
  // (salary calc, Absent FTM, dashboards) see Resigned/Inactive when the
  // user marks it that way while a draft sits alongside.
  var _activeP=_hrmsEmpPeriods.find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
  if(_activeP){
    data.status=_activeP.status||'Active';
    data.dateOfLeft=_activeP.dateOfLeft||'';
  }
  // Sanitize all data
  _hrmsSanitize(data);
  _hrmsSanitizePeriods(data.periods);
  if(!DB.hrmsEmployees) DB.hrmsEmployees=[];
  if(id){
    var e=byId(DB.hrmsEmployees,id);var bak={...e};Object.assign(e,data);
    if(!await _dbSave('hrmsEmployees',e)){Object.assign(e,bak);return;}
  } else {
    // New employee — mark first period as proposed for ECR approval
    if(data.periods&&data.periods.length){
      data.periods[0]._wfStatus='proposed';
      data.periods[0].submittedAt=new Date().toISOString();
      data.periods[0].submittedBy=CU?CU.name||CU.email||'':'';
    }
    data._isNewEcr=true;// Flag for ECR display
    var e2={id:'he'+uid(),...data};
    // _dbSave already inserts into DB.hrmsEmployees on success — no extra push.
    if(!await _dbSave('hrmsEmployees',e2)) return;
  }
  // Invalidate contract salary cache so revised salary/ESI/period data shows on next render
  if(typeof _hrmsContractCache!=='undefined') _hrmsContractCache={};
  renderHrmsEmployees();renderHrmsDashboard();_hrmsUpdateChangeReqBadge();
  // Re-render the active HRMS tab so changes (salary revisions, ESI, etc.) reflect immediately
  if(typeof _hrmsRenderActiveTab==='function') _hrmsRenderActiveTab();
  notify(id?'Employee saved!':'New employee submitted for approval!');
  _hrmsEmpEditSnap=null;
  if(id){
    // Existing employee: remain in modal but switch back to view mode
    _hrmsSetEmpEditMode(false);
  } else {
    // New employee: close the modal and route the user to the Change Requests
    // tab so the pending submission is visible immediately (the main list
    // hides _isNewEcr employees until approval).
    cm('mHrmsEmpEdit');
    if(typeof _hrmsEmpSetTab==='function') _hrmsEmpSetTab('ecr');
  }
}

// Does an employee have any linked records? Returns a short reason string
// if yes, null if the employee is fully dormant and safe to delete.
// Checked: attendance (DB + per-month cache), alterations, advances, saved
// monthly snapshots, manual P/PL/OT/OTS overrides, and revision history
// (anything beyond the single initial approved/plain period).
// Server-side index of empCodes that have ANY linked record across the four
// data tables (attendance, alterations, advances, month-data). Populated at
// HRMS boot via a small parallel set of `select('emp_code')` queries — much
// more reliable than relying on full row payloads being loaded into memory
// (which the 10K-row boot limit can truncate). Read by _hrmsEmpRecordReason.
window._hrmsEmpsWithRecords=null;

async function _hrmsLoadEmpsWithRecordsIndex(){
  if(window._hrmsEmpsWithRecords) return;
  if(!_sb||!_sbReady) return;
  var idx={};
  var tables=[
    {sb:'hrms_attendance',label:'attendance'},
    {sb:'hrms_alterations',label:'alterations'},
    {sb:'hrms_advances',label:'advances'},
    {sb:'hrms_month_data',label:'saved month data'}
  ];
  await Promise.all(tables.map(async function(t){
    try{
      // Pull emp_code only — small payload even with thousands of rows.
      var res=await _sb.from(t.sb).select('emp_code').limit(50000);
      if(res.error){console.warn('emp-records idx '+t.sb+':',res.error.message);return;}
      (res.data||[]).forEach(function(r){
        var c=String(r.emp_code||'').trim().toUpperCase();
        if(!c) return;
        if(!idx[c]) idx[c]=t.label;// keep first-seen reason (priority order above)
      });
    }catch(e){console.warn('emp-records idx '+t.sb+' failed:',e.message);}
  }));
  window._hrmsEmpsWithRecords=idx;
  // Refresh affected UI now that we know which employees can be deleted.
  if(typeof renderHrmsEmployees==='function') renderHrmsEmployees();
  if(typeof _hrmsEmpRefreshDeleteBtn==='function') _hrmsEmpRefreshDeleteBtn();
}

function _hrmsEmpRecordReason(emp){
  if(!emp||!emp.empCode) return null;
  var code=emp.empCode;
  var codeNorm=String(code).trim().toUpperCase();
  // 1) Authoritative server-side index (loaded at boot).
  if(window._hrmsEmpsWithRecords&&window._hrmsEmpsWithRecords[codeNorm]) return window._hrmsEmpsWithRecords[codeNorm];
  // 2) In-memory fallbacks (in case the index hasn't finished loading yet).
  if((DB.hrmsAttendance||[]).some(function(a){return a.empCode===code;})) return 'attendance';
  if(typeof _hrmsAttCache==='object'&&_hrmsAttCache){
    for(var mk in _hrmsAttCache){
      if((_hrmsAttCache[mk]||[]).some(function(a){return a.empCode===code;})) return 'attendance';
    }
  }
  if((DB.hrmsAlterations||[]).some(function(a){return a.empCode===code;})) return 'alterations';
  if(typeof _hrmsAltCache==='object'&&_hrmsAltCache){
    for(var mk2 in _hrmsAltCache){
      if((_hrmsAltCache[mk2]||[]).some(function(a){return a.empCode===code;})) return 'alterations';
    }
  }
  if((DB.hrmsAdvances||[]).some(function(a){return a.empCode===code;})) return 'advances';
  if((DB.hrmsMonthData||[]).some(function(r){return r.empCode===code;})) return 'saved month data';
  var ex=emp.extra||{};
  if(ex.manualP&&Object.keys(ex.manualP).length) return 'manual P entries';
  if(ex.manualPL&&Object.keys(ex.manualPL).length) return 'manual PL entries';
  if(ex.manualOT&&Object.keys(ex.manualOT).length) return 'manual OT entries';
  if(ex.manualOTS&&Object.keys(ex.manualOTS).length) return 'manual OT@S entries';
  // Revision history — only the single bootstrap period is OK; anything more
  // means the employee has been edited over time.
  var approved=(emp.periods||[]).filter(function(p){return !p._wfStatus||p._wfStatus==='approved';});
  if(approved.length>1) return 'revision history';
  return null;
}

async function _hrmsDelEmp(id){
  var emp=byId(DB.hrmsEmployees||[],id);
  var reason=_hrmsEmpRecordReason(emp);
  if(reason){notify('Cannot delete — '+reason+' exist for this employee',true);return;}
  if(!confirm('Delete this employee?'))return;
  if(!await _dbDel('hrmsEmployees',id))return;
  renderHrmsEmployees();renderHrmsDashboard();
  if(typeof _hrmsRenderChangeReq==='function') _hrmsRenderChangeReq();
  if(typeof _hrmsUpdateChangeReqBadge==='function') _hrmsUpdateChangeReqBadge();
  notify('Employee deleted');
}

// ═══ IMPORT / EXPORT EMPLOYEES ═══════════════════════════════════════════

// Build a case-insensitive lookup from a master table.
// Returns {lookup: {lowerName: canonicalName}, names: [...]}
function _hrmsMasterLookup(tbl){
  var items=DB[tbl]||[];
  var lookup={},names=[];
  items.forEach(function(it){
    var n=(it.name||'').trim();
    if(n){lookup[n.toLowerCase()]=n;names.push(n);}
  });
  return{lookup:lookup,names:names.sort()};
}

// Canonicalize a master value against a lookup. Returns {ok:bool, value:canonical, err:msg}
function _hrmsCanonicalize(raw,lookup,fieldLabel){
  var s=(raw||'').toString().trim();
  if(!s) return {ok:true,value:''};// empty is allowed
  var hit=lookup.lookup[s.toLowerCase()];
  if(hit) return {ok:true,value:hit};
  return {ok:false,err:fieldLabel+' "'+s+'" not found in masters. Valid: '+(lookup.names.slice(0,8).join(', ')||'(none)')};
}

// One-time: deduplicate masters and normalize all employees' master field values.
// Handles both: (1) master has duplicates like "Staff" + "STAFF", (2) employees have mixed casing.
async function _hrmsFixEmployeeMasterCase(){
  var emps=DB.hrmsEmployees||[];
  console.log('=== _hrmsFixEmployeeMasterCase START ===');
  console.log('Total employees:',emps.length);

  var masterTables=[
    {tbl:'hrmsCompanies',empField:'location',label:'Plant'},
    {tbl:'hrmsCategories',empField:'category',label:'Category'},
    {tbl:'hrmsEmpTypes',empField:'employmentType',label:'Employment Type'},
    {tbl:'hrmsTeams',empField:'teamName',label:'Team'},
    {tbl:'hrmsDepartments',empField:'department',label:'Department'},
    {tbl:'hrmsSubDepartments',empField:'subDepartment',label:'Sub Department'},
    {tbl:'hrmsDesignations',empField:'designation',label:'Designation'}
  ];

  // ── 1. Report current state ──
  console.log('\n--- Master Data ---');
  masterTables.forEach(function(m){
    var items=DB[m.tbl]||[];
    console.log(m.label+' ('+m.tbl+'):',items.map(function(x){return x.name;}));
  });

  console.log('\n--- Case-duplicate analysis ---');
  var report={masterDupes:[],empMismatches:[],empCaseMismatches:[]};
  masterTables.forEach(function(m){
    var items=DB[m.tbl]||[];
    var byLower={};
    items.forEach(function(it){
      var k=(it.name||'').trim().toLowerCase();if(!k)return;
      if(!byLower[k]) byLower[k]=[];
      byLower[k].push(it);
    });
    Object.keys(byLower).forEach(function(k){
      if(byLower[k].length>1) report.masterDupes.push({field:m.label,names:byLower[k].map(function(x){return x.name;})});
    });
  });
  if(report.masterDupes.length){
    console.log('⚠ Master duplicates found:');
    report.masterDupes.forEach(function(d){console.log(' ',d.field,'→',d.names.join(' vs '));});
  } else {
    console.log('✓ No master duplicates');
  }

  var summary='Analysis:\n\n';
  summary+='• '+report.masterDupes.length+' master duplicate(s) detected\n';
  report.masterDupes.forEach(function(d){summary+='  - '+d.field+': '+d.names.join(' ≈ ')+'\n';});

  // Count employee case mismatches
  var empChanges=0,empUnmatched=0;
  var plannedChanges=[];
  emps.forEach(function(e){
    masterTables.forEach(function(m){
      var cur=(e[m.empField]||'').toString().trim();
      if(!cur) return;
      var items=DB[m.tbl]||[];
      // Pick the "canonical" by preferring title-case-ish entry
      var hit=null;
      items.forEach(function(it){
        if((it.name||'').toLowerCase()===cur.toLowerCase()){
          // Prefer entries that aren't all-upper/all-lower
          if(!hit) hit=it.name;
          else{
            var a=hit,b=it.name;
            var aAllCase=(a===a.toUpperCase()||a===a.toLowerCase());
            var bAllCase=(b===b.toUpperCase()||b===b.toLowerCase());
            if(aAllCase&&!bAllCase) hit=b;
          }
        }
      });
      if(hit&&hit!==e[m.empField]){
        plannedChanges.push({emp:e.empCode,field:m.label,from:e[m.empField],to:hit});
      } else if(!hit){
        empUnmatched++;
      }
    });
  });
  summary+='\n• '+plannedChanges.length+' employee field(s) will be corrected\n';
  summary+='• '+empUnmatched+' employee field value(s) don\'t match any master (will be left unchanged)\n';

  if(plannedChanges.length){
    summary+='\nSample changes:\n';
    plannedChanges.slice(0,10).forEach(function(c){summary+='  - '+c.emp+' '+c.field+': "'+c.from+'" → "'+c.to+'"\n';});
    if(plannedChanges.length>10) summary+='  … and '+(plannedChanges.length-10)+' more\n';
  }
  summary+='\nProceed with fixing?';
  console.log('\n--- Planned changes ---');console.log(plannedChanges);
  if(!confirm(summary))return;

  // ── 2. Deduplicate masters: for each duplicate group, keep one and delete the rest ──
  var masterDeletions=0;
  for(var mi=0;mi<masterTables.length;mi++){
    var m=masterTables[mi];
    var items=(DB[m.tbl]||[]).slice();
    var byLower={};
    items.forEach(function(it){
      var k=(it.name||'').trim().toLowerCase();if(!k)return;
      if(!byLower[k])byLower[k]=[];byLower[k].push(it);
    });
    for(var k in byLower){
      if(byLower[k].length<=1) continue;
      // Keep the one with mixed case (not all-upper / all-lower)
      var group=byLower[k].slice();
      group.sort(function(a,b){
        var aBad=(a.name===a.name.toUpperCase()||a.name===a.name.toLowerCase())?1:0;
        var bBad=(b.name===b.name.toUpperCase()||b.name===b.name.toLowerCase())?1:0;
        return aBad-bBad;
      });
      var keeper=group[0];
      console.log('Master ['+m.tbl+']: keeping "'+keeper.name+'", deleting '+group.slice(1).map(function(x){return '"'+x.name+'"';}).join(', '));
      for(var gi=1;gi<group.length;gi++){
        await _dbDel(m.tbl,group[gi].id);
        DB[m.tbl]=(DB[m.tbl]||[]).filter(function(x){return x.id!==group[gi].id;});
        masterDeletions++;
      }
    }
  }

  // ── 3. Canonicalize all employees ──
  var mLookups={};
  masterTables.forEach(function(m){mLookups[m.tbl]=_hrmsMasterLookup(m.tbl);});
  var changed=[];
  emps.forEach(function(e){
    var updated=false;
    masterTables.forEach(function(m){
      var cur=(e[m.empField]||'').toString().trim();
      if(!cur) return;
      var canon=mLookups[m.tbl].lookup[cur.toLowerCase()];
      if(canon&&canon!==e[m.empField]){e[m.empField]=canon;updated=true;}
    });
    if(updated) changed.push(e);
  });
  console.log('Employees to update:',changed.length);

  if(!changed.length&&!masterDeletions){notify('No changes needed — data already clean');return;}

  var saved=0;
  if(changed.length){
    showSpinner('Saving '+changed.length+' updates…');
    saved=await _dbSaveBulk('hrmsEmployees',changed);
    hideSpinner();
  }
  console.log('=== DONE — '+saved+' employees updated, '+masterDeletions+' master duplicates removed ===');
  notify('✅ Fixed '+saved+' employee(s), removed '+masterDeletions+' master duplicate(s)');
  renderHrmsEmployees();
  renderHrmsDashboard();
}

async function _hrmsImportEmployees(inputEl){
  if(!_hrmsHasAccess('action.importEmployees')){notify('Access denied',true);return;}
  var file=inputEl.files[0];if(!file)return;inputEl.value='';
  showSpinner('Importing employees…');
  try{
    var reader=new FileReader();
    reader.onload=async function(e){
      try{
        var rows=await _parseXLSX(e.target.result);
        console.log('HRMS Import: parsed '+rows.length+' rows');
        if(rows.length) console.log('HRMS Import: columns=',Object.keys(rows[0]));
        if(!rows.length){hideSpinner();notify('No data in file',true);return;}
        if(!DB.hrmsEmployees) DB.hrmsEmployees=[];

        // Pre-build case-insensitive master lookups
        var mLoc=_hrmsMasterLookup('hrmsCompanies');       // Plant
        var mCat=_hrmsMasterLookup('hrmsCategories');      // Category
        var mET =_hrmsMasterLookup('hrmsEmpTypes');        // Employment Type
        var mTm =_hrmsMasterLookup('hrmsTeams');           // Team
        var mDp =_hrmsMasterLookup('hrmsDepartments');     // Department
        var mSD =_hrmsMasterLookup('hrmsSubDepartments'); // Sub Department
        var mDg =_hrmsMasterLookup('hrmsDesignations');    // Designation

        var _fd=function(v){var s=(v||'').toString().trim();if(!s)return'';if(s.match(/^\d{4}-\d{2}-\d{2}$/))return s;var n=parseFloat(s);if(!isNaN(n)&&n>20000&&n<60000){var d=new Date(Math.round((n-25569)*86400000));if(!isNaN(d.getTime()))return d.toISOString().slice(0,10);}var d2=new Date(s);if(!isNaN(d2.getTime()))return d2.toISOString().slice(0,10);var m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);if(m){var yr=+m[3];if(yr<100)yr+=2000;var d3=new Date(yr,m[2]-1,m[1]);if(!isNaN(d3.getTime()))return d3.toISOString().slice(0,10);}return'';};

        // ── Validate every row BEFORE saving ──
        var errors=[];
        var parsed=[];
        for(var i=0;i<rows.length;i++){
          var r=rows[i];
          var rowNum=i+2;
          var code=(r['Employee Code']||r['Emp Code']||r['EmpCode']||r['Code']||'').toString().trim();
          if(!code) continue;
          var name=(r['EmployeeFull Name']||r['Employee Full Name']||r['Full Name']||r['Name']||'').toString().trim();
          if(!name){errors.push('Row '+rowNum+' ('+code+'): missing Name');continue;}

          var rawLoc=r['Current Plant']||r['Location']||r['Plant']||r['Branch']||'';
          var rawCat=r['Category']||'';
          var rawET=r['Employment Type']||r['Emp Type']||'';
          var rawTm=r['Team Name']||r['Team']||'';
          var rawDp=r['Department']||r['Dept']||'';
          var rawSD=r['Sub Department']||r['Sub Dept']||'';
          var rawDg=r['Designation']||r['Title']||r['Position']||'';

          var vLoc=_hrmsCanonicalize(rawLoc,mLoc,'Plant');
          var vCat=_hrmsCanonicalize(rawCat,mCat,'Category');
          var vET =_hrmsCanonicalize(rawET ,mET ,'Employment Type');
          var vTm =_hrmsCanonicalize(rawTm ,mTm ,'Team');
          var vDp =_hrmsCanonicalize(rawDp ,mDp ,'Department');
          var vSD =_hrmsCanonicalize(rawSD ,mSD ,'Sub Department');
          var vDg =_hrmsCanonicalize(rawDg ,mDg ,'Designation');

          [vLoc,vCat,vET,vTm,vDp,vSD,vDg].forEach(function(v){
            if(!v.ok) errors.push('Row '+rowNum+' ('+code+'): '+v.err);
          });
          if(!vLoc.ok||!vCat.ok||!vET.ok||!vTm.ok||!vDp.ok||!vSD.ok||!vDg.ok) continue;

          var _st=(r['Current Status']||r['Status']||'').toString().trim();
          if(_st.toLowerCase()==='working'||_st.toLowerCase()==='active')_st='Active';
          else if(_st.toLowerCase()==='left'||_st.toLowerCase()==='resigned')_st='Left';
          else if(!_st)_st='Active';

          var _np=name.split(/\s+/);
          var lastName=_np[0]||'';var firstName=_np[1]||'';var middleName=_np.slice(2).join(' ')||'';

          parsed.push({rowNum:rowNum,code:code,data:{
            empCode:code,name:name,lastName:lastName,firstName:firstName,middleName:middleName,
            gender:(r['Gender']||r['Sex']||'').toString().trim(),
            dateOfBirth:_fd(r['Date of Birth']||r['DOB']),
            dateOfJoining:_fd(r['Date of Joining']||r['DOJ']||r['Joining Date']),
            department:vDp.value,subDepartment:vSD.value,
            designation:vDg.value,employmentType:vET.value,
            teamName:vTm.value,category:vCat.value,location:vLoc.value,
            roll:(r['Role']||r['Roll']||'').toString().trim(),
            reportingTo:(r['Reporting To']||r['Manager']||'').toString().trim(),
            panNo:(r['PAN No.']||r['PAN No']||r['PAN']||'').toString().trim(),
            aadhaarNo:(r['AADHAAR No.']||r['AADHAAR No']||r['Aadhaar']||'').toString().trim(),
            esiNo:(r['ESI NO']||r['ESI No']||r['ESI']||'').toString().trim(),
            pfNo:(r['PF NO']||r['PF No']||r['PF']||'').toString().trim(),
            uan:(r['UAN']||'').toString().trim(),
            salaryDay:parseFloat(r['Current Salary / Day']||r['Salary/Day']||0)||0,
            salaryMonth:parseFloat(r['Current Salary / Month']||r['Salary/Month']||0)||0,
            status:_st,
            dateOfLeft:_fd(r['Date of Left']||r['DOL']),
            email:(r['Email']||r['E-mail']||'').toString().trim(),
            mobile:(r['Mobile']||r['Phone']||r['Contact']||'').toString().trim()
          }});
        }

        if(errors.length){
          hideSpinner();
          var msg='⚠ Import rejected — '+errors.length+' validation error'+(errors.length>1?'s':'')+':\n\n'+errors.slice(0,15).join('\n')+(errors.length>15?'\n… and '+(errors.length-15)+' more':'');
          alert(msg);
          notify('Import rejected — fix master data errors first',true);
          return;
        }

        if(!parsed.length){hideSpinner();notify('No valid rows to import',true);return;}

        // ── All rows validated. Save now. ──
        var added=0,updated=0,failed=0;
        for(var j=0;j<parsed.length;j++){
          var p=parsed[j];
          var existing=DB.hrmsEmployees.find(function(e){return e.empCode===p.code;});
          if(existing){
            Object.assign(existing,p.data);
            if(await _dbSave('hrmsEmployees',existing))updated++;else failed++;
          } else {
            var emp=Object.assign({id:'he'+uid()},p.data);
            if(await _dbSave('hrmsEmployees',emp))added++;else failed++;
          }
        }
        hideSpinner();
        renderHrmsEmployees();renderHrmsDashboard();
        notify('✅ Import: '+added+' added, '+updated+' updated'+(failed?', '+failed+' failed':''));
      }catch(ex){hideSpinner();notify('⚠ Import error: '+ex.message,true);console.error(ex);}
    };
    reader.readAsArrayBuffer(file);
  }catch(ex){hideSpinner();notify('⚠ '+ex.message,true);}
}

// ── One-time Bulk Update from Excel (matches by Employee Code, updates existing only) ──
async function _hrmsBulkUpdate(inputEl){
  var file=inputEl.files[0];if(!file)return;inputEl.value='';
  showSpinner('Bulk updating employees…');
  try{
    var reader=new FileReader();
    reader.onload=async function(e){
      try{
        var rows=await _parseXLSX(e.target.result);
        if(!rows.length){hideSpinner();notify('No data in file',true);return;}
        if(!DB.hrmsEmployees) DB.hrmsEmployees=[];
        var _fd=function(v){var s=(v||'').toString().trim();if(!s)return'';if(s.match(/^\d{4}-\d{2}-\d{2}$/))return s;var d=new Date(s);return isNaN(d)?'':d.toISOString().slice(0,10);};
        var updated=0,added=0,skipped=0,errors=0;
        for(var i=0;i<rows.length;i++){
          var r=rows[i];
          // Read fields — support multiple column name variations
          var _g=function(keys){for(var ki=0;ki<keys.length;ki++){var v=(r[keys[ki]]||'').toString().trim();if(v)return v;}return '';};
          var code=_g(['Emp Code','Employee Code','EmpCode','Code']);
          if(!code){skipped++;continue;}
          var emp=DB.hrmsEmployees.find(function(e){return(e.empCode||'').toUpperCase()===code.toUpperCase();});
          var isNewEmp=!emp;
          if(isNewEmp){
            var eName=_g(['Employee Name','EmployeeName','Name']);
            if(!eName){skipped++;continue;}
            var _np=eName.split(/\s+/);
            emp={id:'he'+uid(),empCode:code,name:eName,lastName:_np[0]||'',firstName:_np[1]||'',middleName:_np.slice(2).join(' ')||'',gender:'',dateOfBirth:'',dateOfJoining:'',status:'Active',periods:[{from:_hrmsCurMonth(),to:null}]};
          }
          var bak=isNewEmp?null:{...emp};
          var eName=_g(['Employee Name','EmployeeName','Name']);
          if(eName){emp.name=eName;var _np=eName.split(/\s+/);emp.lastName=_np[0]||emp.lastName||'';emp.firstName=_np[1]||emp.firstName||'';emp.middleName=_np.slice(2).join(' ')||emp.middleName||'';}
          var g=_g(['Gender','Sex']);if(g) emp.gender=g;
          var dob=_fd(_g(['DOB','Date of Birth']));if(dob) emp.dateOfBirth=dob;
          var doj=_fd(_g(['DOJ','Date of Joining','Joining Date']));if(doj) emp.dateOfJoining=doj;
          var st=_g(['Status']);
          if(st){if(st.toLowerCase()==='working'||st.toLowerCase()==='active')st='Active';else if(st.toLowerCase()==='left'||st.toLowerCase()==='resigned')st='Left';else if(st.toLowerCase()==='inactive')st='Inactive';emp.status=st;}
          var loc=_g(['Plant','Company','Location']);if(loc) emp.location=loc;
          var cat=_g(['Category']);if(cat) emp.category=cat;
          var etype=_g(['Emp Type','Employment Type']);if(etype) emp.employmentType=etype;
          var team=_g(['Team','Team Name']);if(team) emp.teamName=team;
          var salD=parseFloat(_g(['Rate per Day','Salary/Day','Sal/Day'])||0);if(salD) emp.salaryDay=salD;
          var salM=parseFloat(_g(['Rate per Month','Salary/Month','Sal/Month'])||0);if(salM) emp.salaryMonth=salM;
          var esi=_g(['ESI','ESI No','ESI NO']);if(esi) emp.esiNo=esi;
          var pf=_g(['PF','PF No','PF NO']);if(pf) emp.pfNo=pf;
          var uan=_g(['UAN']);if(uan) emp.uan=uan;
          var pan=_g(['PAN','PAN No','PAN No.']);if(pan) emp.panNo=pan;
          var bankN=_g(['Bank Name']);if(bankN) emp.bankName=bankN;
          var branch=_g(['Branch','Branch Name']);if(branch) emp.branchName=branch;
          var acctNo=_g(['Account Number','Acct No']);if(acctNo) emp.acctNo=acctNo;
          var ifsc=_g(['IFSC','IFSC Code']);if(ifsc) emp.ifsc=ifsc;
          // Update active period if periods exist
          if(emp.periods&&emp.periods.length){
            var ap=emp.periods.find(function(p){return !p.to;});
            if(ap){if(loc)ap.location=loc;if(cat)ap.category=cat;if(etype)ap.employmentType=etype;if(team)ap.teamName=team;if(salD)ap.salaryDay=salD;if(salM)ap.salaryMonth=salM;if(st)ap.status=st;}
          }
          if(isNewEmp){
            if(await _dbSave('hrmsEmployees',emp)){DB.hrmsEmployees.push(emp);added++;}else errors++;
          } else {
            _hrmsSanitize(emp);_hrmsSanitizePeriods(emp.periods);
            if(await _dbSave('hrmsEmployees',emp)) updated++;else{Object.assign(emp,bak);errors++;}
          }
        }
        hideSpinner();
        renderHrmsEmployees();renderHrmsDashboard();
        notify('🔄 Bulk Update: '+added+' added, '+updated+' updated, '+skipped+' skipped'+(errors?', '+errors+' failed':''));
      }catch(ex){hideSpinner();notify('⚠ Update error: '+ex.message,true);}
    };
    reader.readAsArrayBuffer(file);
  }catch(ex){hideSpinner();notify('⚠ '+ex.message,true);}
}

// ── Import Salary from Excel ──
// Excel headers: Emp Code, Sal/Day, Sal/Month, Sp Allow
// Creates a new period revision w.e.f. 2026-01 with salary values from Excel
async function _hrmsImportSalary(inputEl){
  if(!inputEl||!inputEl.files||!inputEl.files[0]){notify('No file selected',true);return;}
  var file=inputEl.files[0];
  inputEl.value='';
  if(!DB.hrmsEmployees||!DB.hrmsEmployees.length){notify('No employees loaded',true);return;}
  showSpinner('Reading Excel…');
  try{
    var reader=new FileReader();
    reader.onload=async function(ev){
      try{
        var rows=await _parseXLSX(ev.target.result);
        if(!rows.length){hideSpinner();notify('No data in file',true);return;}
        var WEF='2026-01';
        var updated=0,skipped=0,errors=0,noChange=0;
        // Case-insensitive, whitespace-tolerant column lookup
        var _g=function(r,keys){
          var rKeys=Object.keys(r);
          for(var i=0;i<keys.length;i++){
            var k=keys[i].replace(/[\s.]+/g,'').toLowerCase();
            for(var j=0;j<rKeys.length;j++){
              if(rKeys[j].replace(/[\s.]+/g,'').toLowerCase()===k){
                var v=(r[rKeys[j]]||'').toString().trim();
                if(v) return v;
              }
            }
          }
          return '';
        };
        var preview=[];
        for(var i=0;i<rows.length;i++){
          var r=rows[i];
          var code=_g(r,['Emp Code','Employee Code','EmpCode','Code']);
          if(!code){skipped++;continue;}
          var emp=DB.hrmsEmployees.find(function(e){return(e.empCode||'').toUpperCase()===code.toUpperCase();});
          if(!emp){skipped++;continue;}
          var salD=parseFloat(_g(r,['Sal/Day','Sal Day','SalDay','Salary Day','Rate per Day'])||0)||0;
          var salM=parseFloat(_g(r,['Sal/Month','Sal Month','SalMonth','Salary Month','Rate per Month'])||0)||0;
          var spA=parseFloat(_g(r,['Sp Allow','Sp.Allow','SpAllow','Special Allowance','Transport Allowance','Tr Allow'])||0)||0;
          if(!salD&&!salM&&!spA){noChange++;continue;}
          // Active period includes plain-saved (no _wfStatus) and approved.
          var curP=(emp.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
          if(!curP){skipped++;continue;}
          var oldD=curP.salaryDay||0,oldM=curP.salaryMonth||0,oldSp=curP.specialAllowance||0;
          if(oldD===salD&&oldM===salM&&oldSp===spA){noChange++;continue;}
          preview.push({code:code,name:_hrmsDispName(emp),oldD:oldD,oldM:oldM,oldSp:oldSp,salD:salD,salM:salM,spA:spA,emp:emp,curP:curP});
        }
        hideSpinner();
        if(!preview.length){
          notify('No changes needed. '+skipped+' skipped, '+noChange+' unchanged.');
          return;
        }
        var msg='Salary Import (w.e.f. '+WEF+'):\n\n'+preview.length+' employees:\n';
        preview.slice(0,8).forEach(function(p){
          msg+=p.code+' '+p.name+': Day '+p.oldD+'→'+p.salD+', Mon '+p.oldM+'→'+p.salM+', SpA '+p.oldSp+'→'+p.spA+'\n';
        });
        if(preview.length>8) msg+='…and '+(preview.length-8)+' more\n';
        msg+='\nSkipped: '+skipped+', No change: '+noChange;
        msg+='\n\nThis creates a new revision per employee. Continue?';
        if(!confirm(msg)) return;
        showSpinner('Updating '+preview.length+' employees…');
        for(var j=0;j<preview.length;j++){
          var p=preview[j];
          var emp=p.emp;
          var curP=p.curP;
          curP.to='2025-12';
          var newP={};
          Object.keys(curP).forEach(function(k){newP[k]=curP[k];});
          newP.from=WEF;
          newP.to=null;
          newP.salaryDay=p.salD;
          newP.salaryMonth=p.salM;
          newP.specialAllowance=p.spA;
          delete newP._wfStatus;
          delete newP._ecrResult;
          emp.periods.unshift(newP);
          emp.salaryDay=p.salD;
          emp.salaryMonth=p.salM;
          emp.specialAllowance=p.spA;
          _hrmsSanitize(emp);
          _hrmsSanitizePeriods(emp.periods);
          if(await _dbSave('hrmsEmployees',emp)){updated++;}else{errors++;}
        }
        hideSpinner();
        renderHrmsEmployees();renderHrmsDashboard();
        notify('✅ Salary imported: '+updated+' updated'+(errors?', '+errors+' failed':''));
      }catch(ex){hideSpinner();notify('⚠ Import error: '+ex.message,true);}
    };
    reader.readAsArrayBuffer(file);
  }catch(ex){hideSpinner();notify('⚠ '+ex.message,true);}
}

// ── Collapse On Roll revisions to single R1 ──
async function _hrmsCollapseOnRollRevisions(){
  if(!DB.hrmsEmployees||!DB.hrmsEmployees.length){notify('No employees',true);return;}
  var targets=DB.hrmsEmployees.filter(function(e){
    return (e.employmentType||'').toLowerCase()==='on roll'&&(e.periods||[]).length>1;
  });
  if(!targets.length){notify('No On Roll employees with multiple revisions found');return;}
  if(!confirm('Collapse revisions for '+targets.length+' On Roll employees?\n\nKeeps only the current (latest) period as R1.\nAll older revisions will be deleted.\n\nContinue?')) return;
  showSpinner('Collapsing revisions…');
  var updated=0,errors=0;
  for(var i=0;i<targets.length;i++){
    var emp=targets[i];
    var latest=(emp.periods||[]).find(function(p){return !p.to&&!p._wfStatus;})||(emp.periods||[])[0];
    if(!latest) continue;
    latest.to=null;
    delete latest._wfStatus;
    delete latest._ecrResult;
    emp.periods=[latest];
    _hrmsSanitize(emp);
    _hrmsSanitizePeriods(emp.periods);
    if(await _dbSave('hrmsEmployees',emp)){updated++;}else{errors++;}
  }
  hideSpinner();
  renderHrmsEmployees();renderHrmsDashboard();
  notify('✅ '+updated+' On Roll employees collapsed to R1'+(errors?', '+errors+' failed':''));
}

// ── Merge Duplicate Employees (by Emp Code) ──
async function _hrmsMergeDuplicates(){
  if(!DB.hrmsEmployees||!DB.hrmsEmployees.length){notify('No employees',true);return;}
  // Group by empCode
  var groups={};
  DB.hrmsEmployees.forEach(function(e){
    var code=(e.empCode||'').trim();if(!code) return;
    if(!groups[code]) groups[code]=[];
    groups[code].push(e);
  });
  var dupes=Object.keys(groups).filter(function(k){return groups[k].length>1;});
  if(!dupes.length){notify('✅ No duplicate employee codes found');return;}
  if(!confirm('Found '+dupes.length+' duplicate employee code(s) with '+dupes.reduce(function(s,k){return s+groups[k].length;},0)+' total records.\n\nMerge them? (keeps best data from each, deletes extras)')) return;
  showSpinner('Merging duplicates…');
  var merged=0,deleted=0;
  for(var d=0;d<dupes.length;d++){
    var code=dupes[d];
    var recs=groups[code];
    // Pick the record with the most data as the keeper
    recs.sort(function(a,b){
      var aFill=Object.keys(a).filter(function(k){return a[k]&&a[k]!==''&&a[k]!==0;}).length;
      var bFill=Object.keys(b).filter(function(k){return b[k]&&b[k]!==''&&b[k]!==0;}).length;
      return bFill-aFill;
    });
    var keeper=recs[0];
    // Merge fields from other records into keeper
    for(var r=1;r<recs.length;r++){
      var donor=recs[r];
      Object.keys(donor).forEach(function(k){
        if(k==='id'||k==='_dbId') return;
        var kv=keeper[k];
        var dv=donor[k];
        // If keeper field is empty/null/0 but donor has value, use donor's
        if((!kv||kv===''||kv===0)&&dv&&dv!==''&&dv!==0){
          keeper[k]=dv;
        }
        // Merge periods arrays
        if(k==='periods'&&Array.isArray(dv)&&dv.length){
          if(!keeper.periods) keeper.periods=[];
          dv.forEach(function(dp){
            var exists=keeper.periods.some(function(kp){return kp.from===dp.from&&kp.to===dp.to;});
            if(!exists) keeper.periods.push(dp);
          });
        }
      });
    }
    // Save merged keeper
    if(await _dbSave('hrmsEmployees',keeper)){
      merged++;
      // Delete the extra records
      for(var r2=1;r2<recs.length;r2++){
        if(await _dbDel('hrmsEmployees',recs[r2].id)) deleted++;
      }
    }
  }
  hideSpinner();
  renderHrmsEmployees();renderHrmsDashboard();
  notify('🔧 Merged '+merged+' duplicate code(s), deleted '+deleted+' extra record(s)');
}

// ===== EXPORT =====
function _hrmsGetFilteredEmployees(){
  var emps=(DB.hrmsEmployees||[]).slice();
  var codeSearch=(document.getElementById('hrmsEmpCodeSearch')?.value||'').toLowerCase();
  var nameSearch=(document.getElementById('hrmsEmpNameSearch')?.value||'').toLowerCase();
  var fPlant=(document.getElementById('hrmsEmpFPlant')?.value||'');
  var fType=(document.getElementById('hrmsEmpFType')?.value||'')||_hrmsEmpTypeFilterVal;
  var fTeam=(document.getElementById('hrmsEmpFTeam')?.value||'');
  var fCat=(document.getElementById('hrmsEmpFCat')?.value||'');
  var fStatus=(document.getElementById('hrmsEmpFStatus')?.value||'');
  return emps.filter(function(e){
    if(codeSearch&&(e.empCode||'').toLowerCase().indexOf(codeSearch)<0) return false;
    if(nameSearch&&(e.name||'').toLowerCase().indexOf(nameSearch)<0) return false;
    if(fPlant&&e.location!==fPlant) return false;
    if(fType&&e.employmentType!==fType) return false;
    if(fTeam&&e.teamName!==fTeam) return false;
    if(fCat&&e.category!==fCat) return false;
    if(fStatus&&(e.status||'Active')!==fStatus) return false;
    return true;
  });
}
async function _hrmsImportDojDob(inputEl){
  var file=inputEl.files[0];if(!file)return;inputEl.value='';
  var reader=new FileReader();
  reader.onload=async function(e){
    try{
      var rows=await _parseXLSX(e.target.result);
      if(!rows.length){notify('No data found',true);return;}
      var empMap={};(DB.hrmsEmployees||[]).forEach(function(emp){empMap[emp.empCode]=emp;});
      var _fd=function(v){
        var s=(v||'').toString().trim();if(!s)return'';
        // Already ISO
        if(s.match(/^\d{4}-\d{2}-\d{2}$/))return s;
        // Excel serial number (e.g. 45577)
        var n=parseFloat(s);
        if(!isNaN(n)&&n>20000&&n<60000){var d=new Date(Math.round((n-25569)*86400000));if(!isNaN(d.getTime()))return d.toISOString().slice(0,10);}
        // dd-mmm-yy or dd/mm/yyyy etc
        var d2=new Date(s);if(!isNaN(d2.getTime()))return d2.toISOString().slice(0,10);
        // Try dd-mm-yyyy or dd/mm/yyyy
        var m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
        if(m){var yr=+m[3];if(yr<100)yr+=2000;var d3=new Date(yr,m[2]-1,m[1]);if(!isNaN(d3.getTime()))return d3.toISOString().slice(0,10);}
        return'';
      };
      var toSave=[],notFound=[];
      for(var i=0;i<rows.length;i++){
        var r=rows[i];
        var code=(r['Emp Code']||r['EmpCode']||r['emp_code']||r['Code']||'').toString().trim();
        if(!code) continue;
        var emp=empMap[code];
        if(!emp){notFound.push(code);continue;}
        var doj=_fd(r['DOJ']||r['Date of Joining']||r['Joining Date']||'');
        var dob=_fd(r['DOB']||r['Date of Birth']||r['Birth Date']||'');
        var changed=false;
        if(doj){emp.dateOfJoining=doj;changed=true;}
        if(dob){emp.dateOfBirth=dob;changed=true;}
        if(changed) toSave.push(emp);
      }
      if(!toSave.length){notify('No matching employees to update',true);return;}
      showSpinner('Updating DOJ/DOB…');
      var saved=await _dbSaveBulk('hrmsEmployees',toSave);
      hideSpinner();
      var msg='Updated '+saved+' employee(s)';
      if(notFound.length) msg+=' | Not found: '+notFound.join(', ');
      notify(msg);
      renderHrmsEmployees();
    }catch(ex){hideSpinner();notify('Error: '+ex.message,true);console.error(ex);}
  };
  reader.readAsArrayBuffer(file);
}

function _hrmsExportEmployees(){
  if(!_hrmsHasAccess('action.exportEmployees')){notify('Access denied',true);return;}
  var emps=_hrmsGetFilteredEmployees();
  if(!emps.length){notify('No employees to export (check filters)',true);return;}
  var headers=['Employee Code','EmployeeFull Name','Gender','Date of Birth','PAN No.','AADHAAR No.','Employment Type','Team Name','Category','ESI NO','PF NO','UAN','Current Plant','Date of Joining','Current Status','Date of Left','Role','Current Salary / Day','Current Salary / Month','Department','Sub Department','Designation','Email','Mobile','Reporting To'];
  var rows=emps.map(function(e){return[e.empCode,e.name,e.gender,e.dateOfBirth,e.panNo,e.aadhaarNo,e.employmentType,e.teamName,e.category,e.esiNo,e.pfNo,e.uan,e.location,e.dateOfJoining,e.status,e.dateOfLeft,e.roll,e.salaryDay,e.salaryMonth,e.department,e.subDepartment,e.designation,e.email,e.mobile,e.reportingTo];});
  _downloadAsXlsx([headers].concat(rows),'Employees','HRMS_Employees.xlsx');
  notify('📤 Exported '+emps.length+' employees');
}

// ═══ MONTHLY ATTENDANCE (grid, summary, entry/exit, POT) ════════════════
var _hrmsAttSelectedMonth=null;
var _hrmsAttCache={};// monthKey → [{id,empCode,monthKey,days}]
var _hrmsAltCache={};// monthKey → [{id,empCode,monthKey,days:{day:{in,out,reason}}}]
var _hrmsAttMonthIndex=null;// [{monthKey,empCount}] from Supabase

async function _hrmsAttFetchIndex(){
  if(!_sb||!_sbReady)return;
  try{
    var {data,error}=await _sb.from('hrms_attendance').select('month_key,emp_code');
    if(error){console.error('Att index fetch error:',error.message);return;}
    var months={};
    (data||[]).forEach(function(r){
      var k=r.month_key;if(!k)return;
      if(!months[k]) months[k]={emps:{}};
      months[k].emps[r.emp_code]=true;
    });
    _hrmsAttMonthIndex=Object.keys(months).sort().reverse().map(function(k){
      return{monthKey:k,empCount:Object.keys(months[k].emps).length};
    });
  }catch(e){console.error('Att index error:',e);}
}

async function _hrmsAttFetchMonth(monthKey){
  if(_hrmsAttCache[monthKey]&&_hrmsAltCache[monthKey]) return _hrmsAttCache[monthKey];
  if(!_sb||!_sbReady)return[];
  showSpinner('Loading attendance…');
  try{
    var [attRes,altRes]=await Promise.all([
      _sb.from('hrms_attendance').select('*').eq('month_key',monthKey),
      _sb.from('hrms_alterations').select('*').eq('month_key',monthKey)
    ]);
    hideSpinner();
    if(attRes.error) console.error('Att fetch error:',attRes.error.message);
    if(altRes.error) console.error('Alt fetch error:',altRes.error.message);
    _hrmsAttCache[monthKey]=(attRes.data||[]).map(function(row){return _fromRow('hrmsAttendance',row);}).filter(Boolean);
    _hrmsAltCache[monthKey]=(altRes.data||[]).map(function(row){return _fromRow('hrmsAlterations',row);}).filter(Boolean);
    return _hrmsAttCache[monthKey];
  }catch(e){hideSpinner();console.error('Att fetch error:',e);return[];}
}

var _hrmsAttCurrentTab='summary';
var _hrmsAttEtFilter='';// default: All (no employment-type filter)

function _hrmsAttEtFilterSet(val){
  _hrmsAttEtFilter=val;
  // Sync with sub-tab's Type dropdown (attendance grid uses it)
  var dd=document.getElementById('hrmsAttFType');
  if(dd) dd.value=val;
  // Sync with POT dropdown if present
  if(window._hrmsPotSearch) window._hrmsPotSearch.type=val;
  // Update button styles
  var btns={All:'hrmsAttEtfAll','On Roll':'hrmsAttEtfOnRoll',Contract:'hrmsAttEtfContract','Piece Rate':'hrmsAttEtfPieceRate',Visitor:'hrmsAttEtfVisitor'};
  var bgs={All:'var(--accent-light)','On Roll':'#dcfce7',Contract:'#dbeafe','Piece Rate':'#f3e8ff',Visitor:'#fef9c3'};
  Object.keys(btns).forEach(function(k){
    var el=document.getElementById(btns[k]);if(!el) return;
    var isActive=(k==='All'&&!val)||(k===val);
    el.style.background=isActive?bgs[k]:'#fff';
    el.style.fontWeight=isActive?'800':'700';
  });
  // Re-render the active tab
  _hrmsAttSetTab(_hrmsAttCurrentTab);
}

function _hrmsUpdateAttEtCounts(){
  var mk=_hrmsAttSelectedMonth;if(!mk) return;
  var att=_hrmsAttCache[mk]||[];
  var attCodes={};att.forEach(function(a){attCodes[a.empCode]=true;});
  // Match the Muster Roll display filter exactly:
  //  • On-Roll: status Active (flat AND active period).
  //  • Contract / Piece Rate: attendance record must exist for the month.
  //  • Other: attendance OR Active (legacy rule).
  var p=mk.split('-');var yr=+p[0],mo=+p[1];
  var daysInMo=new Date(yr,mo,0).getDate();
  var mStart=mk+'-01',mEnd=mk+'-'+String(daysInMo).padStart(2,'0');
  var c={All:0,OnRoll:0,Contract:0,PieceRate:0,Visitor:0};
  (DB.hrmsEmployees||[]).forEach(function(emp){
    var et=(emp.employmentType||'').toLowerCase().replace(/\s/g,'');
    var isOnRoll=et==='onroll';
    var isCPR=et==='contract'||et==='piecerate';
    var hasAtt=!!attCodes[emp.empCode];
    if(isOnRoll){
      if((emp.status||'Active')!=='Active') return;
      var ap=(emp.periods||[]).find(function(x){return !x.to&&(!x._wfStatus||x._wfStatus==='approved');});
      if(ap&&(ap.status||'Active')!=='Active') return;
    } else if(isCPR){
      if(!hasAtt) return;
    } else {
      if(!hasAtt&&(emp.status||'Active')!=='Active') return;
    }
    // DOJ/DOL gate
    if(emp.dateOfJoining&&emp.dateOfJoining>mEnd) return;
    if(emp.dateOfLeft&&emp.dateOfLeft<mStart) return;
    c.All++;
    var b=_hrmsEtBucket(emp.employmentType);if(b) c[b]++;
  });
  ['All','OnRoll','Contract','PieceRate','Visitor'].forEach(function(k){
    var el=document.getElementById('hrmsAttEtCount_'+k);if(el) el.textContent=c[k];
  });
}
var _MONTH_NAMES=['','January','February','March','April','May','June','July','August','September','October','November','December'];
var _MON3=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// _hrmsFmtDate is in hrms-logic.js


function _hrmsAttSetTab(tab){
  _hrmsAttCurrentTab=tab;
  // Permission check for attendance sub-tabs
  var _attTabPerm={summary:'att.summary',attendance:'att.muster',alteration:'att.alteration',pot:'att.pot',entry:'att.entry',exit:'att.exit',printformats:'att.printformats'};
  if(_attTabPerm[tab]&&!_hrmsHasAccess(_attTabPerm[tab])){notify('Access denied',true);return;}
  document.querySelectorAll('.hrms-att-tab').forEach(function(t){t.classList.remove('active');});
  document.querySelectorAll('.hrms-att-panel').forEach(function(p){p.style.display='none';});
  // Hide attendance sub-tab buttons without access
  Object.keys(_attTabPerm).forEach(function(t){
    var el=document.getElementById('hrmsTab'+t.charAt(0).toUpperCase()+t.slice(1));
    if(el) el.style.display=_hrmsHasAccess(_attTabPerm[t])?'':'none';
  });
  var tabEl=document.getElementById('hrmsTab'+tab.charAt(0).toUpperCase()+tab.slice(1));
  if(tabEl) tabEl.classList.add('active');
  if(!_hrmsAttSelectedMonth){
    document.getElementById('hrmsAttTabSummary').style.display='block';
    document.getElementById('hrmsAttTabSummary').innerHTML='<div class="empty-state">Select a month to view data.</div>';
    return;
  }
  _hrmsUpdateAttEtCounts();
  // Keep the Type dropdown in sync with the button filter
  var ddt=document.getElementById('hrmsAttFType');
  if(ddt&&_hrmsAttEtFilter&&ddt.value!==_hrmsAttEtFilter) ddt.value=_hrmsAttEtFilter;
  var mk=_hrmsAttSelectedMonth;var p=mk.split('-');var yr=+p[0],mo=+p[1];
  if(tab==='summary'){
    document.getElementById('hrmsAttTabSummary').style.display='block';
    _hrmsRenderSummaryTab(yr,mo);
  } else if(tab==='attendance'){
    document.getElementById('hrmsAttTabAttendance').style.display='flex';
    _hrmsRenderAttGrid(yr,mo);
  } else if(tab==='alteration'){
    document.getElementById('hrmsAttTabAlteration').style.display='flex';
    _hrmsRenderAltGrid(yr,mo);
  } else if(tab==='pot'){
    document.getElementById('hrmsAttTabPot').style.display='flex';
    _hrmsRenderPotTab(yr,mo);
  } else if(tab==='entry'){
    document.getElementById('hrmsAttTabEntry').style.display='block';
    _hrmsRenderEntryTab(yr,mo);
  } else if(tab==='exit'){
    document.getElementById('hrmsAttTabExit').style.display='block';
    _hrmsRenderExitTab(yr,mo);
  } else if(tab==='printformats'){
    document.getElementById('hrmsAttTabPrintformats').style.display='block';
    _hrmsPrintFmtRenderList();
  }
}

// Compute attendance totals (P, OT, OT@S) for all employees — stores on emp._totalP etc.
// Consistent name display: Last First Middle
// ═══ EMPLOYEE AUTOCOMPLETE (Manual Att / TDS / Advance inputs) ═══════════
function _hrmsEmpAC(inp){
  var id=inp.id;
  var list=document.getElementById('ac_'+id);if(!list)return;
  var q=(inp.value||'').trim().toLowerCase();
  var emps=(DB.hrmsEmployees||[]).filter(function(e){return(e.status||'Active')==='Active';});
  // Sort by empCode — numeric-first (so 101 < 1011 < 1100) with an alphabetic
  // tiebreaker for non-numeric codes. Applied before slicing so the visible
  // top 50 are the lowest codes alphanumerically.
  emps.sort(function(a,b){
    var ac=(a.empCode||''),bc=(b.empCode||'');
    var an=parseInt(ac.replace(/\D/g,''))||0;
    var bn=parseInt(bc.replace(/\D/g,''))||0;
    if(an!==bn) return an-bn;
    return ac.localeCompare(bc);
  });
  var matches;
  if(!q){
    matches=emps.slice(0,50);
  } else {
    matches=emps.filter(function(e){
      var code=(e.empCode||'').toLowerCase();
      var name=(_hrmsDispName(e)||e.name||'').toLowerCase();
      return code.indexOf(q)>=0||name.indexOf(q)>=0;
    }).slice(0,50);
  }
  if(!matches.length){
    list.innerHTML='<div style="padding:8px 12px;color:var(--text3);font-size:12px">No matches</div>';
    list.style.display='block';
    return;
  }
  var h='';
  matches.forEach(function(e){
    var name=_hrmsDispName(e)||e.name||'';
    var plant=e.location||'';
    var pClr=_hrmsGetPlantColor(plant);
    h+='<div onmousedown="_hrmsEmpACPick(\''+id+'\',\''+e.empCode+'\')" style="padding:6px 10px;cursor:pointer;border-bottom:1px solid #f1f5f9;font-size:12px;display:flex;align-items:center;gap:8px" onmouseover="this.style.background=\'#f0f9ff\'" onmouseout="this.style.background=\'#fff\'">';
    h+='<span style="font-family:var(--mono);font-weight:800;color:var(--accent);min-width:48px">'+e.empCode+'</span>';
    h+='<span style="font-weight:600;flex:1">'+name+'</span>';
    if(plant) h+='<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:'+pClr+';color:#1e293b;font-weight:700">'+plant+'</span>';
    h+='</div>';
  });
  list.innerHTML=h;
  list.style.display='block';
}

function _hrmsEmpACPick(inpId,code){
  var inp=document.getElementById(inpId);if(inp){inp.value=code;inp.dispatchEvent(new Event('change'));}
  _hrmsEmpACClose(inpId);
  inp&&inp.focus();
  // Auto-advance focus to next input for speed
  var nextId={hrmsManualPCode:'hrmsManualPDays',hrmsTdsCode:'hrmsTdsAmount',hrmsAdvCode:'hrmsAdvAmount'}[inpId];
  if(nextId){var n=document.getElementById(nextId);if(n)n.focus();}
}

function _hrmsEmpACClose(inpId){
  var list=document.getElementById('ac_'+inpId);if(list)list.style.display='none';
}

function _hrmsDispName(emp){
  return [emp.lastName,emp.firstName,emp.middleName].filter(Boolean).join(' ')||emp.name||'';
}

function _hrmsComputeAttTotals(yr,mo){
  var mk=yr+'-'+String(mo).padStart(2,'0');
  var daysInMonth=new Date(yr,mo,0).getDate();
  var R=_hrmsGetOtRules(mk);
  var attRecords=_hrmsAttCache[mk]||[];
  var altRecords=_hrmsAltCache[mk]||[];
  var attLookup={};attRecords.forEach(function(a){attLookup[a.empCode]=a.days||{};});
  var altLookup={};altRecords.forEach(function(a){altLookup[a.empCode]=a.days||{};});
  (DB.hrmsEmployees||[]).forEach(function(emp){
    var empAtt=attLookup[emp.empCode]||{};
    var empAlt=altLookup[emp.empCode]||{};
    var isStaff=(emp.category||'').toLowerCase()==='staff'&&(emp.employmentType||'').toLowerCase()!=='contract';
    var totalP=0,totalA=0,totalOT=0,totalOTS=0,elCount=0;
    for(var dd=1;dd<=daysInMonth;dd++){
      var alt=_hrmsEffectiveAlt(empAlt[String(dd)]||null);
      var ddd=alt||empAtt[String(dd)]||{};
      var ti=ddd['in']||'',to2=ddd['out']||'';
      var dType=_hrmsGetDayType(mk,dd,yr,mo,emp.location);
      var isDayOff=dType==='WO'||dType==='PH';
      var worked=0;
      if(ti&&to2){
        var t1=_hrmsRoundIn(_hrmsParseTime(ti)),t2=_hrmsRoundOut(_hrmsParseTime(to2));
        if(t1!==null&&t2!==null){if(t2<t1)t2+=1440;worked=(t2-t1)/60;}
      }
      var hasTime=!!(ti||to2);
      if(isDayOff){
        if(worked>0&&!isStaff){
          var otS=worked;
          if(otS>R.otsTier2Threshold) otS-=R.otsTier2Deduct;
          else if(otS>=R.otsTier1Threshold) otS-=R.otsTier1Deduct;
          totalOTS+=Math.min(Math.max(otS,0),R.otsMaxPerDay);
        }
      } else {
        var status='';
        if(!hasTime){status='A';}
        else if(worked>=R.fullDay){status='P';}
        else if(isStaff&&worked>=R.elMin&&worked<R.fullDay&&elCount<R.elMaxPerMonth){status='EL';elCount++;}
        else if(worked>=R.halfDay){status='P/2';}
        else{status='A';}
        if(status==='P'||status==='EL') totalP+=1;
        else if(status==='P/2'){totalP+=0.5;totalA+=0.5;}
        if(status==='A') totalA+=1;
        if(worked>0&&!isStaff){
          var ot=0;
          if(worked>R.otTier2Threshold) ot=worked-R.otTier2Subtract;
          else if(worked>=R.otTier1Threshold) ot=worked-R.otTier1Subtract;
          if(ot>0) totalOT+=Math.min(ot,R.otMaxPerDay);
        }
      }
    }
    emp._totalP=totalP;emp._totalA=totalA;emp._totalOT=totalOT;emp._totalOTS=totalOTS;
  });
}

// Muster-Roll-equivalent inclusion filter for a given month. Returns the list
// of employees the Summary / Muster Roll grid considers "in scope" for that
// month. Extracted so summary-cell click handlers can re-use the same rules
// without re-implementing the logic (which previously caused drift).
function _hrmsAttIncludedEmps(yr,mo){
  var mk=yr+'-'+String(mo).padStart(2,'0');
  var attRecords=_hrmsAttCache[mk]||[];
  var altRecords=(_hrmsAltCache&&_hrmsAltCache[mk])||[];
  var attCodes={};
  attRecords.forEach(function(a){
    var days=a.days||{};
    for(var dk in days){var dd=days[dk];if(dd&&((dd['in']&&String(dd['in']).trim())||(dd['out']&&String(dd['out']).trim()))){attCodes[a.empCode]=true;break;}}
  });
  altRecords.forEach(function(a){if(a.days&&Object.keys(a.days).length) attCodes[a.empCode]=true;});
  (DB.hrmsEmployees||[]).forEach(function(e){
    var ex=e.extra||{},v;
    v=ex.manualP&&ex.manualP[mk];if(v!==undefined&&v!==null&&+v>0){attCodes[e.empCode]=true;return;}
    v=ex.manualPL&&ex.manualPL[mk];if(v!==undefined&&v!==null&&+v>0){attCodes[e.empCode]=true;return;}
    v=ex.manualOT&&ex.manualOT[mk];if(v!==undefined&&v!==null&&+v>0){attCodes[e.empCode]=true;return;}
    v=ex.manualOTS&&ex.manualOTS[mk];if(v!==undefined&&v!==null&&+v>0){attCodes[e.empCode]=true;return;}
  });
  var daysInMo=new Date(yr,mo,0).getDate();
  var mStart=mk+'-01',mEnd=mk+'-'+String(daysInMo).padStart(2,'0');
  return (DB.hrmsEmployees||[]).filter(function(e){
    if(e._isNewEcr) return false;
    if(e.dateOfJoining&&e.dateOfJoining>mEnd) return false;
    if(e.dateOfLeft&&e.dateOfLeft<mStart) return false;
    var et=(e.employmentType||'').toLowerCase().replace(/\s/g,'');
    var hasAtt=!!attCodes[e.empCode];
    if(et==='onroll'){
      if((e.status||'Active')!=='Active') return false;
      var ap=(e.periods||[]).find(function(x){return !x.to&&(!x._wfStatus||x._wfStatus==='approved');});
      if(ap&&(ap.status||'Active')!=='Active') return false;
      return true;
    }
    if(et==='contract'||et==='piecerate') return hasAtt;
    return hasAtt||(e.status||'Active')==='Active';
  });
}

// Drill-down for the Summary tab's plant-summary cells. Re-derives the
// in-scope employee list via _hrmsAttIncludedEmps, applies the cell's
// row+plant filter, and renders a modal listing the matching employees.
function _hrmsSummaryShowDetail(kind,team,plant,yr,mo){
  var emps=_hrmsAttIncludedEmps(yr,mo);
  if(_hrmsAttEtFilter) emps=emps.filter(function(e){return(e.employmentType||'')===_hrmsAttEtFilter;});
  var matches=emps.filter(function(e){
    if(plant&&e.location!==plant) return false;
    var et=(e.employmentType||'').toLowerCase().replace(/\s/g,'');
    var cat=(e.category||'').toLowerCase();
    if(kind==='ORS') return et==='onroll'&&cat==='staff';
    if(kind==='ORW') return et==='onroll'&&cat==='worker';
    if(kind==='C') return et==='contract'&&(e.teamName||'Unassigned')===team;
    if(kind==='PR') return et==='piecerate'&&(e.teamName||'Unassigned')===team;
    return false;
  });
  matches.sort(function(a,b){
    var an=parseInt((a.empCode||'').replace(/\D/g,''))||0;
    var bn=parseInt((b.empCode||'').replace(/\D/g,''))||0;
    if(an!==bn) return an-bn;
    return(a.empCode||'').localeCompare(b.empCode||'');
  });
  var labelMap={ORS:'On Roll : Staff',ORW:'On Roll : Worker',C:'Contract',PR:'Piece Rate'};
  var titleParts=[labelMap[kind]||kind];
  if(team) titleParts.push(team);
  if(plant) titleParts.push(plant); else titleParts.push('All Plants');
  var titleTxt=titleParts.join(' · ');
  var _esc=function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
  var rowsHtml='';
  if(!matches.length){
    rowsHtml='<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text3)">No employees match.</td></tr>';
  } else {
    matches.forEach(function(e,i){
      var ecEsc=_esc(e.empCode).replace(/'/g,"\\'");
      rowsHtml+='<tr style="border-bottom:1px solid #f1f5f9">'
        +'<td style="padding:5px 8px;color:var(--text3);font-size:11px">'+(i+1)+'</td>'
        +'<td style="padding:5px 8px;font-family:var(--mono);font-weight:800"><a href="javascript:void(0)" onclick="document.getElementById(\'_hrmsSumDetailOverlay\').remove();_hrmsOpenEmpByCode(\''+ecEsc+'\')" style="color:var(--accent);text-decoration:underline" title="View / edit employee">'+_esc(e.empCode)+'</a></td>'
        +'<td style="padding:5px 8px;font-weight:700">'+_esc(e.name||'')+'</td>'
        +'<td style="padding:5px 8px">'+_esc(e.location||'—')+'</td>'
        +'<td style="padding:5px 8px">'+_esc(e.category||'—')+'</td>'
        +'<td style="padding:5px 8px">'+_esc(e.teamName||'—')+'</td>'
        +'</tr>';
    });
  }
  var html=''
   +'<div id="_hrmsSumDetailOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:10000" onclick="if(event.target===this)this.remove()">'
   +'<div style="background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:88vh;overflow:auto;width:min(720px,94vw);padding:0">'
   +'<div style="padding:14px 18px;border-bottom:2px solid var(--accent-light);display:flex;justify-content:space-between;align-items:start;gap:12px">'
   +'<div><div style="font-size:11px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:1px">Plant Summary</div><div style="font-size:16px;font-weight:900;margin-top:2px">'+_esc(titleTxt)+' — '+matches.length+' employee(s)</div></div>'
   +'<button onclick="document.getElementById(\'_hrmsSumDetailOverlay\').remove()" style="background:transparent;border:none;font-size:22px;cursor:pointer;color:var(--text3);line-height:1">×</button>'
   +'</div>'
   +'<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:#f1f5f9">'
   +'<th style="padding:6px 8px;font-size:11px;font-weight:800;text-align:left">#</th>'
   +'<th style="padding:6px 8px;font-size:11px;font-weight:800;text-align:left">Emp Code</th>'
   +'<th style="padding:6px 8px;font-size:11px;font-weight:800;text-align:left">Name</th>'
   +'<th style="padding:6px 8px;font-size:11px;font-weight:800;text-align:left">Plant</th>'
   +'<th style="padding:6px 8px;font-size:11px;font-weight:800;text-align:left">Category</th>'
   +'<th style="padding:6px 8px;font-size:11px;font-weight:800;text-align:left">Team</th>'
   +'</tr></thead><tbody>'+rowsHtml+'</tbody></table>'
   +'</div></div>';
  var prior=document.getElementById('_hrmsSumDetailOverlay');if(prior) prior.remove();
  var tmp=document.createElement('div');tmp.innerHTML=html;
  document.body.appendChild(tmp.firstChild);
}

function _hrmsRenderSummaryTab(yr,mo){
  var el=document.getElementById('hrmsAttTabSummary');if(!el)return;
  var mk=yr+'-'+String(mo).padStart(2,'0');
  var emps=_hrmsAttIncludedEmps(yr,mo);
  // Apply top-level employment-type pill filter
  if(_hrmsAttEtFilter) emps=emps.filter(function(e){return(e.employmentType||'')===_hrmsAttEtFilter;});

  // Get unique plants sorted
  var plants={};emps.forEach(function(e){if(e.location)plants[e.location]=true;});
  var plantList=Object.keys(plants).sort();
  var nP=plantList.length;

  // ─── On Roll & Contract Summary ───
  // Rows: On Roll:Staff, On Roll:Worker, then each contract team as C:<TeamName>
  var orConEmps=emps.filter(function(e){var t=(e.employmentType||'').toLowerCase().replace(/\s/g,'');return t==='onroll'||t==='contract';});
  // Collect unique contract teams
  var conTeams={};
  orConEmps.forEach(function(e){
    if((e.employmentType||'').toLowerCase()==='contract'){
      var t=e.teamName||'Unassigned';
      conTeams[t]=true;
    }
  });
  var conTeamList=Object.keys(conTeams).sort();
  // Build rows with a kind+team key so each cell can be made clickable and
  // the drill-down can re-derive the filter without serialising functions.
  var orConRows=[
    {label:'On Roll : Staff',kind:'ORS',team:'',filter:function(e){return(e.employmentType||'').toLowerCase().replace(/\s/g,'')==='onroll'&&(e.category||'').toLowerCase()==='staff';}},
    {label:'On Roll : Worker',kind:'ORW',team:'',filter:function(e){return(e.employmentType||'').toLowerCase().replace(/\s/g,'')==='onroll'&&(e.category||'').toLowerCase()==='worker';}}
  ];
  conTeamList.forEach(function(t){
    orConRows.push({label:'C : '+t,kind:'C',team:t,filter:function(e){return(e.employmentType||'').toLowerCase()==='contract'&&(e.teamName||'Unassigned')===t;}});
  });

  var h='<div style="font-size:15px;font-weight:900;margin-bottom:10px;color:var(--accent)">On Roll & Contract — Plant Summary</div>';
  h+='<table style="width:auto;margin-bottom:24px;font-size:13px"><thead><tr><th style="min-width:160px">Category</th>';
  plantList.forEach(function(plt){
    var pClr=_hrmsGetPlantColor(plt);
    var pShort=plt.replace(/plant[\s\-]*/i,'P').replace(/^(.{4}).*$/,'$1');
    h+='<th style="text-align:center;min-width:70px;background:'+pClr+';font-weight:800;color:#1e293b">'+pShort+'</th>';
  });
  h+='<th style="text-align:center;min-width:70px;background:#f0f9ff;font-weight:900">Total</th></tr></thead><tbody>';
  var colTotals=new Array(nP+1).fill(0);
  orConRows.forEach(function(row){
    var isOR=row.label.indexOf('On Roll')===0;
    h+='<tr><td style="font-weight:700;font-size:12px;'+(isOR?'color:var(--accent)':'color:#475569')+'">'+row.label+'</td>';
    var rowTotal=0;
    var teamEsc=String(row.team||'').replace(/'/g,"\\'");
    plantList.forEach(function(plt,pi){
      var cnt=emps.filter(function(e){return e.location===plt&&row.filter(e);}).length;
      rowTotal+=cnt;colTotals[pi]+=cnt;
      var pltEsc=String(plt||'').replace(/'/g,"\\'");
      var clickable=cnt>0;
      var clickAttrs=clickable?' onclick="_hrmsSummaryShowDetail(\''+row.kind+'\',\''+teamEsc+'\',\''+pltEsc+'\','+yr+','+mo+')" style="text-align:center;font-weight:800;color:var(--accent);cursor:pointer;text-decoration:underline" title="Show employees"':' style="text-align:center;font-weight:400;color:var(--text3)"';
      h+='<td'+clickAttrs+'>'+cnt+'</td>';
    });
    colTotals[nP]+=rowTotal;
    var rtClick=rowTotal>0?' onclick="_hrmsSummaryShowDetail(\''+row.kind+'\',\''+teamEsc+'\','+'\'\','+yr+','+mo+')" style="text-align:center;font-weight:900;background:#f0f9ff;cursor:pointer;text-decoration:underline;color:var(--accent)" title="Show employees (all plants)"':' style="text-align:center;font-weight:900;background:#f0f9ff"';
    h+='<td'+rtClick+'>'+rowTotal+'</td></tr>';
  });
  // Total row
  h+='<tr style="background:#f0f9ff"><td style="font-weight:900">Total</td>';
  plantList.forEach(function(plt,pi){h+='<td style="text-align:center;font-weight:900">'+colTotals[pi]+'</td>';});
  h+='<td style="text-align:center;font-weight:900;font-size:15px;color:var(--accent)">'+colTotals[nP]+'</td></tr>';
  h+='</tbody></table>';

  // ─── Piece Rate Summary ───
  var prEmps=emps.filter(function(e){return(e.employmentType||'').toLowerCase().replace(/\s/g,'')==='piecerate';});
  var prTeams={};prEmps.forEach(function(e){var t=e.teamName||'Unassigned';prTeams[t]=true;});
  var prTeamList=Object.keys(prTeams).sort();

  if(prTeamList.length){
    h+='<div style="font-size:15px;font-weight:900;margin-bottom:10px;color:#7c3aed">Piece Rate — Plant Summary</div>';
    h+='<table style="width:auto;margin-bottom:24px;font-size:13px"><thead><tr><th style="min-width:160px">Team</th>';
    plantList.forEach(function(plt){
      var pClr=_hrmsGetPlantColor(plt);
      var pShort=plt.replace(/plant[\s\-]*/i,'P').replace(/^(.{4}).*$/,'$1');
      h+='<th style="text-align:center;min-width:70px;background:'+pClr+';font-weight:800;color:#1e293b">'+pShort+'</th>';
    });
    h+='<th style="text-align:center;min-width:70px;background:#faf5ff;font-weight:900">Total</th></tr></thead><tbody>';
    var prColTotals=new Array(nP+1).fill(0);
    prTeamList.forEach(function(team){
      h+='<tr><td style="font-weight:700;font-size:12px;color:#475569">'+team+'</td>';
      var rowTotal=0;
      var teamEsc=String(team||'').replace(/'/g,"\\'");
      plantList.forEach(function(plt,pi){
        var cnt=prEmps.filter(function(e){return e.location===plt&&(e.teamName||'Unassigned')===team;}).length;
        rowTotal+=cnt;prColTotals[pi]+=cnt;
        var pltEsc=String(plt||'').replace(/'/g,"\\'");
        var clickable=cnt>0;
        var clickAttrs=clickable?' onclick="_hrmsSummaryShowDetail(\'PR\',\''+teamEsc+'\',\''+pltEsc+'\','+yr+','+mo+')" style="text-align:center;font-weight:800;color:#7c3aed;cursor:pointer;text-decoration:underline" title="Show employees"':' style="text-align:center;font-weight:400;color:var(--text3)"';
        h+='<td'+clickAttrs+'>'+cnt+'</td>';
      });
      prColTotals[nP]+=rowTotal;
      var rtClick=rowTotal>0?' onclick="_hrmsSummaryShowDetail(\'PR\',\''+teamEsc+'\','+'\'\','+yr+','+mo+')" style="text-align:center;font-weight:900;background:#faf5ff;cursor:pointer;text-decoration:underline;color:#7c3aed" title="Show employees (all plants)"':' style="text-align:center;font-weight:900;background:#faf5ff"';
      h+='<td'+rtClick+'>'+rowTotal+'</td></tr>';
    });
    h+='<tr style="background:#faf5ff"><td style="font-weight:900">Total</td>';
    plantList.forEach(function(plt,pi){h+='<td style="text-align:center;font-weight:900">'+prColTotals[pi]+'</td>';});
    h+='<td style="text-align:center;font-weight:900;font-size:15px;color:#7c3aed">'+prColTotals[nP]+'</td></tr>';
    h+='</tbody></table>';
  }

  el.innerHTML=h;
}

function _hrmsRenderPotTab(yr,mo){
  var el=document.getElementById('hrmsAttTabPotContent');if(!el)return;
  var mk=yr+'-'+String(mo).padStart(2,'0');
  var daysInMonth=new Date(yr,mo,0).getDate();
  var attRecords=_hrmsAttCache[mk]||[];
  var altRecords=_hrmsAltCache[mk]||[];
  var lookup={};attRecords.forEach(function(a){lookup[a.empCode]=a.days||{};});
  var altLookup={};altRecords.forEach(function(a){altLookup[a.empCode]=a.days||{};});
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});

  var _otR=_hrmsGetOtRules(mk);
  var FULL_DAY=_otR.fullDay,HALF_DAY=_otR.halfDay,EL_MIN=_otR.elMin,EL_MAX_PER_MONTH=_otR.elMaxPerMonth;

  // Build list of all emp codes with attendance
  var allCodes={};attRecords.forEach(function(a){allCodes[a.empCode]=true;});
  var emps=Object.keys(allCodes).map(function(ec){
    return empMap[ec]||{empCode:ec,name:'Employee NA',location:'',employmentType:'',category:'',teamName:'',department:'',_unmatched:true};
  }).sort(function(a,b){
    var typeOrder={'on roll':0,'onroll':0,'contract':1,'piece rate':2,'piecerate':2};
    var catOrder={'staff':0,'worker':1,'security':2};
    var at=(a.employmentType||'').toLowerCase().replace(/\s/g,''),bt=(b.employmentType||'').toLowerCase().replace(/\s/g,'');
    var t1=typeOrder[at]!==undefined?typeOrder[at]:9,t2=typeOrder[bt]!==undefined?typeOrder[bt]:9;
    if(t1!==t2) return t1-t2;
    var p=(a.location||'').localeCompare(b.location||'');if(p!==0)return p;
    var ac=(a.category||'').toLowerCase(),bc=(b.category||'').toLowerCase();
    var c1=catOrder[ac]!==undefined?catOrder[ac]:9,c2=catOrder[bc]!==undefined?catOrder[bc]:9;
    if(c1!==c2) return c1-c2;
    return(a.teamName||'').localeCompare(b.teamName||'');
  });

  // Search/filter state
  if(!window._hrmsPotSearch) window._hrmsPotSearch={code:'',name:'',type:'',plant:'',cat:'',team:'',dept:''};
  if(!window._hrmsPotSort) window._hrmsPotSort={key:'',asc:true};
  var _ps=window._hrmsPotSearch;
  var _psI=function(id,field){return '<input type="search" id="potSrch_'+field+'" value="'+(_ps[field]||'')+'" oninput="window._hrmsPotSearch.'+field+'=this.value;window._hrmsPotFocus=\'potSrch_'+field+'\';_hrmsRenderPotTab('+yr+','+mo+')" onsearch="window._hrmsPotSearch.'+field+'=this.value;window._hrmsPotFocus=\'potSrch_'+field+'\';_hrmsRenderPotTab('+yr+','+mo+')" placeholder="🔍" style="font-size:10px;padding:2px 4px;border:1px solid var(--border);border-radius:3px;width:100%">';};
  var _psSrt=function(key){return ' onclick="var s=window._hrmsPotSort;if(s.key===\''+key+'\')s.asc=!s.asc;else{s.key=\''+key+'\';s.asc=true;}_hrmsRenderPotTab('+yr+','+mo+')" style="cursor:pointer"';};
  var _psSI=function(key){var s=window._hrmsPotSort;return s.key===key?(s.asc?' ▲':' ▼'):' ⇅';};
  var _thS='padding:6px 4px;font-size:11px;font-weight:800;white-space:nowrap;border-bottom:1px solid var(--border)';
  var h='<table style="font-size:12px;margin-bottom:16px;border-collapse:collapse;table-layout:fixed;width:auto!important">';
  h+='<colgroup><col style="width:34px"><col style="width:70px"><col style="width:170px"><col style="width:80px"><col style="width:80px"><col style="width:70px"><col style="width:90px"><col style="width:90px"><col style="width:50px"><col style="width:50px"><col style="width:60px"><col style="width:60px"></colgroup>';
  h+='<thead>';
  // Build unique values for dropdowns from employees with attendance
  var _potVals=function(field){var v={};emps.forEach(function(e){if(e[field])v[e[field]]=1;});return Object.keys(v).sort();};
  var _potSel=function(field,psField){
    var vals=_potVals(field);
    return '<select id="potSrch_'+psField+'" onchange="window._hrmsPotSearch.'+psField+'=this.value;_hrmsRenderPotTab('+yr+','+mo+')" style="font-size:10px;padding:2px 2px;border:1px solid var(--border);border-radius:3px;width:100%;box-sizing:border-box"><option value="">All</option>'+vals.map(function(v){return '<option value="'+v+'"'+(v===_ps[psField]?' selected':'')+'>'+v+'</option>';}).join('')+'</select>';
  };
  // Row 1: Search / Filter inputs (above column headers)
  h+='<tr style="background:#fff">';
  h+='<th style="padding:3px 2px"></th>';
  h+='<th style="padding:3px">'+_psI('code','code')+'</th>';
  h+='<th style="padding:3px">'+_psI('name','name')+'</th>';
  h+='<th style="padding:3px">'+_potSel('employmentType','type')+'</th>';
  h+='<th style="padding:3px">'+_potSel('location','plant')+'</th>';
  h+='<th style="padding:3px">'+_potSel('category','cat')+'</th>';
  h+='<th style="padding:3px">'+_potSel('teamName','team')+'</th>';
  h+='<th style="padding:3px">'+_potSel('department','dept')+'</th>';
  h+='<th colspan="4"></th>';
  h+='</tr>';
  // Row 2: Column headers (below search)
  h+='<tr style="background:#f1f5f9;color:var(--text)">';
  h+='<th style="'+_thS+'">#</th>';
  h+='<th style="'+_thS+'"'+_psSrt('empCode')+'>Code'+_psSI('empCode')+'</th>';
  h+='<th style="'+_thS+'"'+_psSrt('name')+'>Name'+_psSI('name')+'</th>';
  h+='<th style="'+_thS+'"'+_psSrt('employmentType')+'>Type'+_psSI('employmentType')+'</th>';
  h+='<th style="'+_thS+'"'+_psSrt('location')+'>Plant'+_psSI('location')+'</th>';
  h+='<th style="'+_thS+'"'+_psSrt('category')+'>Category'+_psSI('category')+'</th>';
  h+='<th style="'+_thS+'"'+_psSrt('teamName')+'>Team'+_psSI('teamName')+'</th>';
  h+='<th style="'+_thS+'"'+_psSrt('department')+'>Dept'+_psSI('department')+'</th>';
  h+='<th style="'+_thS+';text-align:center;background:#dcfce7;color:#15803d"'+_psSrt('_totalP')+'>P'+_psSI('_totalP')+'</th>';
  h+='<th style="'+_thS+';text-align:center;background:#fee2e2;color:#dc2626"'+_psSrt('_totalA')+'>A'+_psSI('_totalA')+'</th>';
  h+='<th style="'+_thS+';text-align:center;background:#faf5ff;color:#7c3aed"'+_psSrt('_totalOT')+'>OT'+_psSI('_totalOT')+'</th>';
  h+='<th style="'+_thS+';text-align:center;background:#fff7ed;color:#c2410c"'+_psSrt('_totalOTS')+'>OT@S'+_psSI('_totalOTS')+'</th>';
  h+='</tr>';
  h+='</thead><tbody>';

  // Pre-compute P/A/OT for each employee for sorting/filtering
  emps.forEach(function(emp){
    var empAtt=lookup[emp.empCode]||{};
    var empAlt=altLookup[emp.empCode]||{};
    var isStaff=(emp.category||'').toLowerCase()==='staff'&&(emp.employmentType||'').toLowerCase()!=='contract';
    var totalP=0,totalA=0,totalOT=0,totalOTS=0,elCount=0;
    for(var dd=1;dd<=daysInMonth;dd++){
      var alt=_hrmsEffectiveAlt(empAlt[String(dd)]||null);
      var ddd=alt||empAtt[String(dd)]||{};
      var ti=ddd['in']||'',to2=ddd['out']||'';
      var dType=_hrmsGetDayType(mk,dd,yr,mo,emp.location);
      var isDayOff=dType==='WO'||dType==='PH';
      var worked=0;
      if(ti&&to2){
        var t1=_hrmsRoundIn(_hrmsParseTime(ti)),t2=_hrmsRoundOut(_hrmsParseTime(to2));
        if(t1!==null&&t2!==null){if(t2<t1)t2+=1440;worked=(t2-t1)/60;}
      }
      var hasTime=!!(ti||to2);
      if(isDayOff){
        if(worked>0&&!isStaff){var otS=worked;if(otS>_otR.otsTier2Threshold)otS-=_otR.otsTier2Deduct;else if(otS>=_otR.otsTier1Threshold)otS-=_otR.otsTier1Deduct;totalOTS+=Math.min(Math.max(otS,0),_otR.otsMaxPerDay);}
      } else {
        var status='';
        if(!hasTime){status='A';}
        else if(worked>=FULL_DAY){status='P';}
        else if(isStaff&&worked>=EL_MIN&&worked<FULL_DAY&&elCount<EL_MAX_PER_MONTH){status='EL';elCount++;}
        else if(worked>=HALF_DAY){status='P/2';}
        else{status='A';}
        if(status==='P'||status==='EL') totalP+=1;
        else if(status==='P/2'){totalP+=0.5;totalA+=0.5;}
        if(status==='A') totalA+=1;
        if(worked>0&&!isStaff){
          var ot=0;if(worked>_otR.otTier2Threshold)ot=worked-_otR.otTier2Subtract;else if(worked>=_otR.otTier1Threshold)ot=worked-_otR.otTier1Subtract;
          if(ot>0)totalOT+=Math.min(ot,_otR.otMaxPerDay);
        }
      }
    }
    emp._totalP=totalP;emp._totalA=totalA;emp._totalOT=totalOT;emp._totalOTS=totalOTS;
  });
  // Filter by search
  if(_ps.code) emps=emps.filter(function(e){return(e.empCode||'').toLowerCase().indexOf(_ps.code.toLowerCase())>=0;});
  if(_ps.name) emps=emps.filter(function(e){return(e.name||'').toLowerCase().indexOf(_ps.name.toLowerCase())>=0;});
  if(_ps.type) emps=emps.filter(function(e){return(e.employmentType||'')===_ps.type;});
  if(_ps.plant) emps=emps.filter(function(e){return(e.location||'')===_ps.plant;});
  if(_ps.cat) emps=emps.filter(function(e){return(e.category||'')===_ps.cat;});
  if(_ps.team) emps=emps.filter(function(e){return(e.teamName||'')===_ps.team;});
  if(_ps.dept) emps=emps.filter(function(e){return(e.department||'')===_ps.dept;});
  // Sort
  var sk=window._hrmsPotSort.key,sa=window._hrmsPotSort.asc;
  if(sk){emps.sort(function(a,b){var av=a[sk],bv=b[sk];if(typeof av==='number'){return sa?av-bv:bv-av;}av=String(av||'').toLowerCase();bv=String(bv||'').toLowerCase();return sa?av.localeCompare(bv):bv.localeCompare(av);});}
  // Render rows
  emps.forEach(function(emp,ei){
    var isU=!!emp._unmatched;
    var pClr=isU?'#fecaca':_hrmsGetPlantColor(emp.location);
    var pDisp=emp._totalP%1===0?emp._totalP:+emp._totalP.toFixed(1);
    var aDisp=emp._totalA%1===0?emp._totalA:+emp._totalA.toFixed(1);
    var totalOT=emp._totalOT,totalOTS=emp._totalOTS;

    var _td='padding:4px 5px;font-size:11px;border-bottom:1px solid #f1f5f9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    var nm=isU?'Employee NA':_hrmsDispName(emp);
    h+='<tr>';
    h+='<td style="'+_td+';text-align:center;color:var(--text3)">'+(ei+1)+'</td>';
    h+='<td style="'+_td+';font-family:var(--mono);font-weight:800;color:'+(isU?'#dc2626':'var(--accent)')+';cursor:'+(isU?'default':'pointer')+(isU?'':';text-decoration:underline')+'"'+(isU?'':' data-emp-code="'+emp.empCode+'" title="Click to view employee"')+'>'+emp.empCode+'</td>';
    h+='<td style="'+_td+';font-weight:700'+(isU?'':';cursor:pointer')+'" title="'+nm+'"'+(isU?'':' data-emp-code="'+emp.empCode+'"')+'>'+nm+'</td>';
    h+='<td style="'+_td+'" title="'+(emp.employmentType||'')+'">'+(emp.employmentType||'—')+'</td>';
    h+='<td style="'+_td+';font-weight:700;background:'+pClr+'" title="'+(emp.location||'')+'">'+(emp.location||'—')+'</td>';
    h+='<td style="'+_td+'" title="'+(emp.category||'')+'">'+(emp.category||'—')+'</td>';
    h+='<td style="'+_td+'" title="'+(emp.teamName||'')+'">'+(emp.teamName||'—')+'</td>';
    h+='<td style="'+_td+'" title="'+(emp.department||'')+'">'+(emp.department||'—')+'</td>';
    h+='<td style="'+_td+';text-align:center;font-weight:900;color:#16a34a;background:#f0fdf4">'+pDisp+'</td>';
    h+='<td style="'+_td+';text-align:center;font-weight:900;color:#dc2626;background:#fef2f2">'+aDisp+'</td>';
    h+='<td style="'+_td+';text-align:center;font-weight:800;color:#7c3aed;background:#faf5ff">'+_hrmsFmtOT(totalOT)+'</td>';
    h+='<td style="'+_td+';text-align:center;font-weight:800;color:#c2410c;background:#fff7ed">'+_hrmsFmtOT(totalOTS)+'</td>';
    h+='</tr>';
  });
  h+='</tbody></table>';
  el.innerHTML=h;
  // Restore focus to search box after re-render
  if(window._hrmsPotFocus){
    var _fEl=document.getElementById(window._hrmsPotFocus);
    if(_fEl){_fEl.focus();var v=_fEl.value;_fEl.value='';_fEl.value=v;}// move cursor to end
    window._hrmsPotFocus=null;
  }
}

// Shared helper for Entry/Exit tabs: compute differences and render
async function _hrmsComputeEntryExit(yr,mo){
  var mk=yr+'-'+String(mo).padStart(2,'0');
  var prevMo=mo-1,prevYr=yr;
  if(prevMo<1){prevMo=12;prevYr--;}
  var prevMk=prevYr+'-'+String(prevMo).padStart(2,'0');
  await _hrmsAttFetchMonth(mk);
  await _hrmsAttFetchMonth(prevMk);

  // "Present in month" = has ACTUAL activity:
  //   1. ESSL attendance record with at least one day that has in/out times
  //   2. Manual P / PL / OT / OTS override (non-zero) for that month
  //   3. Alteration record with at least one day
  // Employees with empty placeholder attendance records (e.g. from "Add Month") are NOT counted.
  var _presenceSet=function(targetMk){
    var set={};
    (_hrmsAttCache[targetMk]||[]).forEach(function(a){
      var days=a.days||{};
      for(var dk in days){
        var d=days[dk];if(!d) continue;
        if((d['in']&&d['in'].toString().trim())||(d['out']&&d['out'].toString().trim())){
          set[a.empCode]=true;break;
        }
      }
    });
    (_hrmsAltCache[targetMk]||[]).forEach(function(a){
      if(a.days&&Object.keys(a.days).length) set[a.empCode]=true;
    });
    (DB.hrmsEmployees||[]).forEach(function(e){
      var ex=e.extra||{};
      var v;
      v=ex.manualP&&ex.manualP[targetMk];if(v!==undefined&&v!==null&&+v>0){set[e.empCode]=true;return;}
      v=ex.manualPL&&ex.manualPL[targetMk];if(v!==undefined&&v!==null&&+v>0){set[e.empCode]=true;return;}
      v=ex.manualOT&&ex.manualOT[targetMk];if(v!==undefined&&v!==null&&+v>0){set[e.empCode]=true;return;}
      v=ex.manualOTS&&ex.manualOTS[targetMk];if(v!==undefined&&v!==null&&+v>0){set[e.empCode]=true;return;}
    });
    return set;
  };

  var curCodes=_presenceSet(mk);
  var prevCodes=_presenceSet(prevMk);

  // Build empMap keyed by normalized empCode (trimmed + uppercased) so a
  // newly-added employee is recognised even if attendance data has the code
  // in a slightly different case or padded with stray whitespace.
  var _norm=function(c){return((c||'')+'').trim().toUpperCase();};
  var empMap={};
  (DB.hrmsEmployees||[]).forEach(function(e){
    var k=_norm(e.empCode);
    if(k) empMap[k]=e;
  });
  var newCodes=Object.keys(curCodes).filter(function(ec){return !prevCodes[ec];});
  var leftCodes=Object.keys(prevCodes).filter(function(ec){return !curCodes[ec];});

  var _sort=function(a,b){
    var p=(a.location||'').localeCompare(b.location||'');if(p!==0)return p;
    var catOrder={'staff':0,'worker':1,'security':2};
    var ac=(a.category||'').toLowerCase(),bc=(b.category||'').toLowerCase();
    var c1=catOrder[ac]!==undefined?catOrder[ac]:9,c2=catOrder[bc]!==undefined?catOrder[bc]:9;
    if(c1!==c2)return c1-c2;
    var tp=(a.employmentType||'').localeCompare(b.employmentType||'');if(tp!==0)return tp;
    return(a.teamName||'').localeCompare(b.teamName||'');
  };

  // For matched employees, use the latest period's org data when the flat
  // fields are empty — happens for new-hire ECRs where the only period is
  // still proposed and saveHrmsEmp couldn't sync flat from an "active"
  // period (none exists yet).
  var _enrich=function(e){
    if(!e||e._unmatched) return e;
    var p=(e.periods||[]).find(function(pp){return !pp.to&&(!pp._wfStatus||pp._wfStatus==='approved');})
        ||(e.periods||[])[0]||{};
    var pick=function(flat,fromP){return(flat&&String(flat).trim())?flat:(fromP||'');};
    return Object.assign({},e,{
      employmentType:pick(e.employmentType,p.employmentType),
      category:pick(e.category,p.category),
      location:pick(e.location,p.location),
      teamName:pick(e.teamName,p.teamName),
      department:pick(e.department,p.department)
    });
  };
  var newEmps=newCodes.map(function(ec){return _enrich(empMap[_norm(ec)])||{empCode:ec,name:'Employee NA',location:'',employmentType:'',category:'',teamName:'',_unmatched:true};}).sort(_sort);
  var leftEmps=leftCodes.map(function(ec){return _enrich(empMap[_norm(ec)])||{empCode:ec,name:'Employee NA',location:'',employmentType:'',category:'',teamName:'',_unmatched:true};}).sort(_sort);

  // Unknown emp codes across both sets
  var unknownNew=newEmps.filter(function(e){return !!e._unmatched;});
  var unknownLeft=leftEmps.filter(function(e){return !!e._unmatched;});
  var allUnknown=[];var _seen={};
  unknownNew.concat(unknownLeft).forEach(function(e){if(!_seen[e.empCode]){_seen[e.empCode]=true;allUnknown.push(e.empCode);}});
  window._hrmsUnknownEmpCodes=allUnknown;

  return{newEmps:newEmps,leftEmps:leftEmps,prevLabel:_MONTH_NAMES[prevMo]+' '+prevYr,curLabel:_MONTH_NAMES[mo]+' '+yr,allUnknown:allUnknown};
}

function _hrmsRenderEmpGroupedTable(list,color,mode){
  if(!list.length) return '';
  // Sort order: Unknown (unmatched empCodes) first to demand attention, then
  // On Roll → Contract → Piece Rate, then anything else alphabetically.
  var typeOrder={'unknown':-1,'on roll':0,'onroll':0,'contract':1,'piece rate':2,'piecerate':2};
  var groups={};
  list.forEach(function(e){var t=e.employmentType||'Unknown';if(!groups[t])groups[t]=[];groups[t].push(e);});
  var groupList=Object.keys(groups).sort(function(a,b){
    var a1=typeOrder[a.toLowerCase().replace(/\s/g,'')],b1=typeOrder[b.toLowerCase().replace(/\s/g,'')];
    if(a1===undefined)a1=9;if(b1===undefined)b1=9;return a1-b1;
  }).map(function(t){return{type:t,emps:groups[t]};});

  // Informational tables for the Entry (New Joinee/Rejoinee) and Exit
  // (Absent Employees FTM) tabs — no status badge, no per-row action.
  var t='';
  groupList.forEach(function(g){
    t+='<div style="font-size:13px;font-weight:800;color:'+color+';margin:10px 0 4px;padding:4px 8px;background:var(--surface2);border-radius:6px;display:inline-block">'+g.type+' ('+g.emps.length+')</div>';
    t+='<table style="width:auto!important;margin-bottom:12px;font-size:13px"><thead><tr><th>#</th><th>Plant</th><th>Emp Code</th><th>Name</th><th>Category</th><th>Team</th></tr></thead><tbody>';
    g.emps.forEach(function(e,i){
      var isU=!!e._unmatched;
      var pClr=isU?'#fecaca':_hrmsGetPlantColor(e.location);
      var ecEsc=String(e.empCode||'').replace(/'/g,"\\'");
      var addBtn=isU?' <button onclick="_hrmsAddEmpWithCode(\''+ecEsc+'\')" style="margin-left:6px;padding:1px 8px;font-size:13px;font-weight:900;background:#16a34a;color:#fff;border:none;border-radius:4px;cursor:pointer;line-height:1.2" title="Add new employee with code '+ecEsc+'">+</button>':'';
      t+='<tr><td>'+(i+1)+'</td>';
      t+='<td style="font-weight:800;background:'+pClr+'">'+(e.location||'—')+'</td>';
      t+='<td style="font-weight:800;color:'+(isU?'#dc2626':'var(--accent)')+(isU?'':';cursor:pointer;text-decoration:underline')+'"'+(isU?'':' data-emp-code="'+e.empCode+'" title="Click to view employee"')+'>'+e.empCode+addBtn+'</td>';
      t+='<td style="font-weight:700">'+(isU?'Employee NA':e.name)+'</td>';
      t+='<td>'+(e.category||'—')+'</td>';
      t+='<td>'+(e.teamName||'—')+'</td>';
      t+='</tr>';
    });
    t+='</tbody></table>';
  });
  return t;
}

// Open the Add Employee modal with the given empCode pre-filled. Used by the
// "+" button beside each unknown attendance code in the New Joinee/Rejoinee
// (and Absent FTM) tabs so the user can quickly create the missing record.
function _hrmsAddEmpWithCode(code){
  if(typeof _hrmsHasAccess==='function'&&!_hrmsHasAccess('action.addEmployee')){
    notify('Access denied',true);return;
  }
  if(typeof openHrmsEmpModal!=='function'){notify('Modal unavailable',true);return;}
  openHrmsEmpModal(null);
  var el=document.getElementById('hrmsEmpCode');
  if(el){
    el.value=String(code||'').trim();
    if(typeof _hrmsCheckEmpCode==='function') _hrmsCheckEmpCode();
  }
  // Move focus to Full Name so the user can start typing the name immediately.
  setTimeout(function(){
    var fn=document.getElementById('hrmsEmpFullName');
    if(fn) fn.focus();
  },80);
}

async function _hrmsMarkEmpStatus(empCode,newStatus){
  var emp=(DB.hrmsEmployees||[]).find(function(e){return e.empCode===empCode;});
  if(!emp){notify('Employee '+empCode+' not found',true);return;}
  var curStatus=emp.status||'Active';
  if(curStatus===newStatus){notify('Already '+newStatus);return;}
  if(!confirm('Mark '+empCode+' ('+_hrmsDispName(emp)+') as '+newStatus+'?\n\nCurrent status: '+curStatus))return;
  emp.status=newStatus;
  if(newStatus==='Inactive'&&!emp.dateOfLeft){
    // Set dateOfLeft to end of previous month if marking inactive
    emp.dateOfLeft=new Date().toISOString().slice(0,10);
  }
  showSpinner('Saving…');
  var ok=await _dbSave('hrmsEmployees',emp);
  hideSpinner();
  if(!ok){notify('⚠ Failed to update status',true);return;}
  notify('✅ '+empCode+' marked as '+newStatus);
  // Refresh both entry and exit tabs
  var mk=_hrmsMonth;if(mk){var p=mk.split('-');var yr=+p[0],mo=+p[1];_hrmsRenderEntryTab(yr,mo);_hrmsRenderExitTab(yr,mo);}
  renderHrmsEmployees();
}

function _hrmsUnknownBanner(count){
  if(!count) return '';
  var h='<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;padding:10px 14px;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:8px">';
  h+='<span style="font-size:13px;font-weight:700;color:#dc2626">⚠ '+count+' unknown employee code'+(count>1?'s':'')+' found in attendance data</span>';
  h+='<div style="flex:1"></div>';
  h+='<button onclick="_hrmsExportUnknownCodes()" style="padding:6px 14px;font-size:12px;font-weight:700;background:#fee2e2;border:1.5px solid #fca5a5;color:#dc2626;border-radius:6px;cursor:pointer">📤 Export Unknown Codes</button>';
  h+='<label style="padding:6px 14px;font-size:12px;font-weight:700;background:#dbeafe;border:1.5px solid #93c5fd;color:#1d4ed8;border-radius:6px;cursor:pointer">📥 Import Employees<input type="file" accept=".xlsx,.xls,.csv" onchange="_hrmsImportEmployees(this);var mk=_hrmsMonth;if(mk){var p=mk.split(\'-\');_hrmsRenderEntryTab(+p[0],+p[1]);_hrmsRenderExitTab(+p[0],+p[1]);}" style="display:none"></label>';
  h+='</div>';
  return h;
}

async function _hrmsRenderEntryTab(yr,mo){
  var el=document.getElementById('hrmsAttTabEntry');if(!el)return;
  el.innerHTML='<div class="empty-state">Loading…</div>';
  var d=await _hrmsComputeEntryExit(yr,mo);
  var h=_hrmsUnknownBanner(d.allUnknown.length);
  h+='<div style="font-size:15px;font-weight:900;margin-bottom:6px;color:#16a34a">New Joinee / Rejoinee in '+d.curLabel+' (not in '+d.prevLabel+') — '+d.newEmps.length+'</div>';
  h+=d.newEmps.length?_hrmsRenderEmpGroupedTable(d.newEmps,'#16a34a','entry'):'<div class="empty-state" style="padding:12px">No new joinee/rejoinee compared to previous month.</div>';
  el.innerHTML=h;
}

async function _hrmsRenderExitTab(yr,mo){
  var el=document.getElementById('hrmsAttTabExit');if(!el)return;
  el.innerHTML='<div class="empty-state">Loading…</div>';
  var d=await _hrmsComputeEntryExit(yr,mo);
  var mk=yr+'-'+String(mo).padStart(2,'0');

  // Build: all Active employees who have 0 presence in the CURRENT month
  // (i.e., no ESSL punches, no alterations, no non-zero manual overrides).
  // Plus include those in d.leftEmps (prev-month presence, absent this month) that are still Active.
  var daysInMo=new Date(yr,mo,0).getDate();
  var mStart=mk+'-01',mEnd=mk+'-'+String(daysInMo).padStart(2,'0');

  // Reuse the same presence logic used in _hrmsComputeEntryExit
  var present={};
  (_hrmsAttCache[mk]||[]).forEach(function(a){
    var days=a.days||{};
    for(var dk in days){
      var dd=days[dk];if(!dd) continue;
      if((dd['in']&&dd['in'].toString().trim())||(dd['out']&&dd['out'].toString().trim())){
        present[a.empCode]=true;break;
      }
    }
  });
  (_hrmsAltCache[mk]||[]).forEach(function(a){if(a.days&&Object.keys(a.days).length) present[a.empCode]=true;});
  (DB.hrmsEmployees||[]).forEach(function(e){
    var ex=e.extra||{};var v;
    v=ex.manualP&&ex.manualP[mk];if(v!==undefined&&v!==null&&+v>0){present[e.empCode]=true;return;}
    v=ex.manualPL&&ex.manualPL[mk];if(v!==undefined&&v!==null&&+v>0){present[e.empCode]=true;return;}
    v=ex.manualOT&&ex.manualOT[mk];if(v!==undefined&&v!==null&&+v>0){present[e.empCode]=true;return;}
    v=ex.manualOTS&&ex.manualOTS[mk];if(v!==undefined&&v!==null&&+v>0){present[e.empCode]=true;return;}
  });

  // All Active employees with DOJ in range, who are NOT present this month.
  // Exclude anyone whose active period OR flat field says non-Active — the
  // flat status field can lag behind when only the period was edited.
  var exitEmps=(DB.hrmsEmployees||[]).filter(function(e){
    if((e.status||'Active')!=='Active') return false;
    var _ap=(e.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
    if(_ap&&(_ap.status||'Active')!=='Active') return false;
    if(e.dateOfJoining&&e.dateOfJoining>mEnd) return false;// not joined yet
    if(e.dateOfLeft&&e.dateOfLeft<mStart) return false;// already left
    return !present[e.empCode];
  });

  // Merge with unmatched prev-month codes (alteration/attendance codes not in master)
  var byCode={};exitEmps.forEach(function(e){byCode[e.empCode]=e;});
  (d.leftEmps||[]).forEach(function(e){
    if(e._unmatched&&!byCode[e.empCode]){byCode[e.empCode]=e;exitEmps.push(e);}
  });

  // Sort: plant → category → team
  exitEmps.sort(function(a,b){
    var p=(a.location||'').localeCompare(b.location||'');if(p!==0) return p;
    var catOrder={'staff':0,'worker':1,'security':2};
    var ac=(a.category||'').toLowerCase(),bc=(b.category||'').toLowerCase();
    var ci=catOrder[ac]!==undefined?catOrder[ac]:9;
    var cj=catOrder[bc]!==undefined?catOrder[bc]:9;
    if(ci!==cj) return ci-cj;
    return(a.teamName||'').localeCompare(b.teamName||'');
  });

  // Unknown-codes banner intentionally suppressed on Absent FTM — the
  // unknown set comes from the Entry side (new joiners) and isn't relevant
  // here. The same banner still appears on the New Joinee/Rejoinee tab.
  var h='';
  h+='<div style="font-size:15px;font-weight:900;margin-bottom:6px;color:#dc2626">Absent Employees FTM — '+d.curLabel+' ('+exitEmps.length+')</div>';
  h+='<div style="font-size:11px;color:var(--text3);margin-bottom:10px">Active employees with no punch / alteration / manual override for this month.</div>';
  h+=exitEmps.length?_hrmsRenderEmpGroupedTable(exitEmps,'#dc2626','exit'):'<div class="empty-state" style="padding:12px">All active employees have activity this month.</div>';
  el.innerHTML=h;
}

function _hrmsExportUnknownCodes(){
  var codes=window._hrmsUnknownEmpCodes||[];
  if(!codes.length){notify('No unknown employee codes',true);return;}
  var headers=['Emp Code','Employee Full Name','Gender','Date of Birth','Date of Joining',
    'Department','Designation','Employment Type','Team Name','Category',
    'Current Plant','Role','PAN No','AADHAAR No','ESI NO','PF NO','UAN',
    'Current Salary / Day','Current Salary / Month','Current Status','Bank Name','Branch Name','Account No','IFSC'];
  var rows=[headers];
  codes.forEach(function(ec){
    var row=[ec];
    for(var i=1;i<headers.length;i++) row.push('');
    rows.push(row);
  });
  _downloadAsXlsx(rows,'Unknown Employees','Unknown_Employees.xlsx');
  notify('📤 Exported '+codes.length+' unknown code'+(codes.length>1?'s':'')+' — fill in details and import back');
}

// ═══ UTILITY: ATTENDANCE EXCEL CONVERTER ═════════════════════════════════════
// Reads a multi-sheet workbook where every sheet represents one date. Fixed
// column positions:
//   A = Emp Code, C = Employee Name, D = Date, F = Time IN, G = Time Out.
// Row 1 is the header on every sheet. Produces a single consolidated table
// with Date formatted DD/MM/YYYY and Times formatted HH:MM.
var _hrmsAttConvData=null;// {rows:[{code,name,date,timeIn,timeOut,_sheet}], sheets:[names]}

// ── Cell-value normalizers ──
function _hrmsAttConvXlDate(n){
  // Excel serial (1900 base, already-baked leap-year quirk)
  var d=new Date(Math.round((n-25569)*86400000));
  if(isNaN(d)) return '';
  var yr=d.getUTCFullYear();if(yr<1900||yr>2100) return '';
  return String(d.getUTCDate()).padStart(2,'0')+'/'+String(d.getUTCMonth()+1).padStart(2,'0')+'/'+yr;
}
function _hrmsAttConvXlTime(frac){
  // Excel time fraction of a day (0..1) or serial date with fractional part
  var f=frac%1; if(f<0) f+=1;
  var totalMin=Math.round(f*24*60);
  var hh=Math.floor(totalMin/60)%24, mm=totalMin%60;
  return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
}
function _hrmsAttConvFmtDate(raw){
  if(raw==null) return '';
  var s=String(raw).trim();if(!s) return '';
  // Excel serial number
  if(/^\d+(\.\d+)?$/.test(s)){var n=+s;if(n>30000&&n<60000) return _hrmsAttConvXlDate(n);}
  // ISO YYYY-MM-DD(optional Time)
  var iso=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(iso) return String(+iso[3]).padStart(2,'0')+'/'+String(+iso[2]).padStart(2,'0')+'/'+iso[1];
  // DD/MM/YYYY or DD-MM-YYYY (assumed India locale)
  var dmy=s.match(/^(\d{1,2})[\-\/\.](\d{1,2})[\-\/\.](\d{2,4})/);
  if(dmy){var d=+dmy[1],m=+dmy[2],y=+dmy[3];if(y<100)y+=2000;
    if(m>12&&d<=12){var t=d;d=m;m=t;}// fallback for MM/DD/YYYY when day>12
    if(d>=1&&d<=31&&m>=1&&m<=12) return String(d).padStart(2,'0')+'/'+String(m).padStart(2,'0')+'/'+y;
  }
  // Mon DD YYYY / Mon-DD-YYYY etc.
  var md=s.match(/^([A-Za-z]{3,})[\s\-\/\.](\d{1,2})[\s\-\/\.,]+(\d{2,4})/);
  if(md){var mons=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    var mi=mons.indexOf(md[1].slice(0,3).toLowerCase());
    if(mi>=0){var y2=+md[3];if(y2<100)y2+=2000;return String(+md[2]).padStart(2,'0')+'/'+String(mi+1).padStart(2,'0')+'/'+y2;}
  }
  return s;// unknown — keep as-is
}
function _hrmsAttConvFmtTime(raw){
  if(raw==null) return '';
  var s=String(raw).trim();if(!s) return '';
  // Excel time fraction (0..1)
  if(/^\d*\.\d+$/.test(s)){var f=+s;if(f>=0&&f<1) return _hrmsAttConvXlTime(f);}
  // Excel datetime serial (number >= 1, with fractional part)
  if(/^\d+(\.\d+)?$/.test(s)){var n=+s;if(n>1&&n<60000) return _hrmsAttConvXlTime(n);}
  // HH:MM or HH:MM:SS
  var hm=s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?$/);
  if(hm){var h=+hm[1],m=+hm[2],ap=(hm[3]||'').toUpperCase();
    if(ap==='PM'&&h<12) h+=12; if(ap==='AM'&&h===12) h=0;
    return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
  }
  return s;
}

// ── Multi-sheet XLSX parser returning raw 2D arrays per sheet ──
// Mirrors the ZIP / XML handling in _parseXLSX but enumerates every sheet.
async function _hrmsAttConvParseAll(arrayBuffer){
  var bytes=new Uint8Array(arrayBuffer);
  function _u16(b,o){return b[o]|(b[o+1]<<8);}
  function _u32(b,o){return (b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0;}
  var eocd=-1;
  for(var i=bytes.length-22;i>=Math.max(0,bytes.length-65558);i--){
    if(bytes[i]===0x50&&bytes[i+1]===0x4B&&bytes[i+2]===0x05&&bytes[i+3]===0x06){eocd=i;break;}
  }
  if(eocd<0) throw new Error('Not a valid XLSX/ZIP file');
  var cdCount=_u16(bytes,eocd+10);var cdOffset=_u32(bytes,eocd+16);
  var entries={};var p=cdOffset;
  for(var k=0;k<cdCount;k++){
    if(p+46>bytes.length) break;
    if(!(bytes[p]===0x50&&bytes[p+1]===0x4B&&bytes[p+2]===0x01&&bytes[p+3]===0x02)) break;
    var comp=_u16(bytes,p+10), csz=_u32(bytes,p+20), fnl=_u16(bytes,p+28),
        extl=_u16(bytes,p+30), coml=_u16(bytes,p+32), loff=_u32(bytes,p+42);
    var fname=new TextDecoder('utf-8').decode(bytes.subarray(p+46,p+46+fnl));
    entries[fname]={comp:comp,csz:csz,loff:loff};
    p+=46+fnl+extl+coml;
  }
  async function readEntry(name){
    var e=entries[name];
    if(!e) e=Object.entries(entries).find(function(x){return x[0].toLowerCase()===name.toLowerCase();})?.[1];
    if(!e) return null;
    var lp=e.loff; if(lp+30>bytes.length) return null;
    var fnl2=_u16(bytes,lp+26), extl2=_u16(bytes,lp+28);
    var dataStart=lp+30+fnl2+extl2;
    var data=bytes.subarray(dataStart,dataStart+e.csz);
    if(e.comp===0) return new TextDecoder('utf-8').decode(data);
    if(typeof DecompressionStream!=='undefined'){
      var ds=new DecompressionStream('deflate-raw');
      var writer=ds.writable.getWriter();var reader=ds.readable.getReader();
      writer.write(data);writer.close();
      var chunks=[]; while(true){var r=await reader.read();if(r.done)break;chunks.push(r.value);}
      var out=new Uint8Array(chunks.reduce(function(n,c){return n+c.length;},0));
      var off=0;chunks.forEach(function(c){out.set(c,off);off+=c.length;});
      return new TextDecoder('utf-8').decode(out);
    }
    throw new Error('DecompressionStream not supported');
  }
  function unesc(s){return String(s).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#x([0-9a-fA-F]+);/g,function(_,h){return String.fromCharCode(parseInt(h,16));}).replace(/&#(\d+);/g,function(_,n){return String.fromCharCode(+n);});}
  // Shared strings
  var ss=[];
  var ssXml=await readEntry('xl/sharedStrings.xml');
  if(ssXml){
    var siRe=/<si>([\s\S]*?)<\/si>/g,sm;
    while((sm=siRe.exec(ssXml))!==null){
      var tRe=/<t(?:\s[^>]*)?>([^<]*)<\/t>/g,tm,parts=[];
      while((tm=tRe.exec(sm[1]))!==null) parts.push(unesc(tm[1]));
      ss.push(parts.join(''));
    }
  }
  // Enumerate sheets via workbook.xml + workbook.xml.rels
  var wbXml=await readEntry('xl/workbook.xml')||'';
  var wbRels=await readEntry('xl/_rels/workbook.xml.rels')||'';
  var relsMap={};
  var rlRe=/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g, rm;
  while((rm=rlRe.exec(wbRels))!==null){ relsMap[rm[1]]=rm[2]; }
  var sheets=[];
  var shRe=/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g, sm2;
  while((sm2=shRe.exec(wbXml))!==null){
    var target=relsMap[sm2[2]]; if(!target) continue;
    var path='xl/'+target.replace(/^.*xl\//,'');
    sheets.push({name:sm2[1],path:path});
  }
  if(!sheets.length) sheets.push({name:'Sheet1',path:'xl/worksheets/sheet1.xml'});
  function colIdx(ref){var n=0;for(var i=0;i<ref.length;i++) n=n*26+(ref.charCodeAt(i)-64);return n-1;}
  var out=[];
  for(var si=0;si<sheets.length;si++){
    var shXml=await readEntry(sheets[si].path);
    if(!shXml){ out.push({name:sheets[si].name,rows:[]}); continue; }
    var rows=[];
    var rowRe=/<row[^>]*>([\s\S]*?)<\/row>/g, rowM;
    while((rowM=rowRe.exec(shXml))!==null){
      var cells={};
      var cellRe=/<c\s+r="([A-Z]+)\d+"([^>\/]*)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
      while((cm=cellRe.exec(rowM[1]))!==null){
        var colRef=cm[1], attrs=cm[2]||'', inner=cm[3]||'';
        var vm=inner.match(/<v>([^<]*)<\/v>/);
        var rawVal=vm?vm[1]:'';
        var tAttr=(attrs.match(/\bt="([^"]+)"/)||[])[1]||'';
        var val='';
        if(tAttr==='s') val=ss[+rawVal]||'';
        else if(tAttr==='inlineStr'){var im=inner.match(/<t[^>]*>([^<]*)<\/t>/);val=im?unesc(im[1]):'';}
        else if(tAttr==='b') val=rawVal==='1'?'TRUE':'FALSE';
        else if(tAttr==='str'||tAttr==='e') val=unesc(rawVal);
        else val=rawVal;
        if(typeof val==='string'&&val.charAt(0)==="'") val=val.substring(1);
        cells[colIdx(colRef)]=val;
      }
      rows.push(cells);
    }
    // Convert sparse {col→value} to dense arrays
    var maxCol=rows.reduce(function(m,r){var ks=Object.keys(r);return ks.length?Math.max.apply(Math,[m].concat(ks.map(Number))):m;},0);
    var dense=rows.map(function(r){var a=[];for(var i=0;i<=maxCol;i++) a.push(r[i]===undefined?'':r[i]);return a;});
    out.push({name:sheets[si].name,rows:dense});
  }
  return out;
}

async function _hrmsAttConvUpload(inputEl){
  if(!inputEl||!inputEl.files||!inputEl.files[0]){notify('No file selected',true);return;}
  var file=inputEl.files[0]; inputEl.value='';
  showSpinner('Reading Excel…');
  try{
    var buf=await file.arrayBuffer();
    var sheets=await _hrmsAttConvParseAll(buf);
    var rows=[];
    var skipped={bothTimesBlank:0,placeholderCode:0};
    sheets.forEach(function(s){
      // Skip row 0 (header). A=0, C=2, D=3, F=5, G=6.
      for(var i=1;i<s.rows.length;i++){
        var r=s.rows[i];
        var code=((r[0]==null?'':r[0])+'').trim();
        var name=((r[2]==null?'':r[2])+'').trim();
        var date=_hrmsAttConvFmtDate(r[3]);
        var tin=_hrmsAttConvFmtTime(r[5]);
        var tout=_hrmsAttConvFmtTime(r[6]);
        if(!code&&!name&&!date&&!tin&&!tout) continue;// blank row
        // Filter: Both In AND Out blank → skip (nothing to record).
        if(!tin&&!tout){ skipped.bothTimesBlank++; continue; }
        // Filter: placeholder emp codes.
        //  - literal header text ("Emp Code" / "EmpCode")
        //  - purely numeric codes 1..99 (biometric test entries like 01, 2, 099)
        var codeLc=code.toLowerCase().replace(/\s+/g,'');
        var isHeaderish=(codeLc==='empcode');
        var isTestNum=/^\d+$/.test(code)&&(+code)>=1&&(+code)<=99;
        if(isHeaderish||isTestNum){ skipped.placeholderCode++; continue; }
        rows.push({code:code,name:name,date:date,timeIn:tin,timeOut:tout,_sheet:s.name});
      }
    });
    _hrmsAttConvData={rows:rows, sheets:sheets.map(function(s){return s.name;}), skipped:skipped};
    hideSpinner();
    _hrmsAttConvRender();
    var skipNote=[];
    if(skipped.bothTimesBlank) skipNote.push(skipped.bothTimesBlank+' blank-times');
    if(skipped.placeholderCode) skipNote.push(skipped.placeholderCode+' placeholder codes');
    notify('✅ Converted '+rows.length+' row(s) from '+sheets.length+' sheet(s)'+(skipNote.length?' · skipped: '+skipNote.join(', '):''));
  }catch(e){
    hideSpinner();
    console.error('Attendance converter error:',e);
    notify('⚠ '+(e&&e.message||e),true);
  }
}

function _hrmsAttConvRender(){
  var body=document.getElementById('hrmsAttConvBody');if(!body) return;
  var summary=document.getElementById('hrmsAttConvSummary');
  var dlBtn=document.getElementById('hrmsAttConvDlBtn');
  var clrBtn=document.getElementById('hrmsAttConvClearBtn');
  if(!_hrmsAttConvData||!_hrmsAttConvData.rows.length){
    body.innerHTML='<div class="empty-state" style="padding:30px 20px">Upload a workbook to see the consolidated attendance table here.</div>';
    if(summary) summary.textContent='';
    if(dlBtn) dlBtn.style.display='none';
    if(clrBtn) clrBtn.style.display='none';
    return;
  }
  var d=_hrmsAttConvData;
  if(summary){
    var skipParts=[];
    if(d.skipped){
      if(d.skipped.bothTimesBlank) skipParts.push(d.skipped.bothTimesBlank+' blank In/Out');
      if(d.skipped.placeholderCode) skipParts.push(d.skipped.placeholderCode+' placeholder codes');
    }
    summary.textContent=d.rows.length+' row(s) across '+d.sheets.length+' sheet(s): '+d.sheets.join(', ')+(skipParts.length?' · skipped: '+skipParts.join(', '):'');
  }
  if(dlBtn) dlBtn.style.display='';
  if(clrBtn) clrBtn.style.display='';
  var _th='padding:6px 8px;font-size:11px;font-weight:800;background:#f1f5f9;border:1px solid #cbd5e1;color:#000;text-align:left;white-space:nowrap;position:sticky;top:0;z-index:1';
  var _td='padding:4px 8px;font-size:13px;border:1px solid #e2e8f0;white-space:nowrap';
  var h='<div style="overflow:auto;border:1.5px solid var(--border);border-radius:8px;max-height:calc(100vh - 290px)">';
  h+='<table style="border-collapse:collapse;width:100%">';
  h+='<thead><tr>';
  h+='<th style="'+_th+';width:46px">#</th>';
  h+='<th style="'+_th+'">Emp Code</th>';
  h+='<th style="'+_th+'">Employee Name</th>';
  h+='<th style="'+_th+';text-align:center">Date</th>';
  h+='<th style="'+_th+';text-align:center">Time IN</th>';
  h+='<th style="'+_th+';text-align:center">Time Out</th>';
  h+='</tr></thead><tbody>';
  d.rows.forEach(function(r,i){
    h+='<tr>';
    h+='<td style="'+_td+';text-align:center;color:var(--text3);font-family:var(--mono)">'+(i+1)+'</td>';
    h+='<td style="'+_td+';font-family:var(--mono);font-weight:700;color:var(--accent)">'+(r.code||'')+'</td>';
    h+='<td style="'+_td+';font-weight:700">'+(r.name||'')+'</td>';
    h+='<td style="'+_td+';text-align:center;font-family:var(--mono)">'+(r.date||'')+'</td>';
    h+='<td style="'+_td+';text-align:center;font-family:var(--mono)">'+(r.timeIn||'')+'</td>';
    h+='<td style="'+_td+';text-align:center;font-family:var(--mono)">'+(r.timeOut||'')+'</td>';
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  body.innerHTML=h;
}

function _hrmsAttConvDownload(){
  if(!_hrmsAttConvData||!_hrmsAttConvData.rows.length){notify('Nothing to download',true);return;}
  var out=[['Emp Code','Employee Name','Date (DD/MM/YYYY)','Time IN','Time Out']];
  _hrmsAttConvData.rows.forEach(function(r){
    out.push([r.code||'',r.name||'',r.date||'',r.timeIn||'',r.timeOut||'']);
  });
  var ts=new Date();var tsStr=ts.getFullYear()+String(ts.getMonth()+1).padStart(2,'0')+String(ts.getDate()).padStart(2,'0')+'_'+String(ts.getHours()).padStart(2,'0')+String(ts.getMinutes()).padStart(2,'0');
  _downloadAsXlsx(out,'Attendance','Attendance_Consolidated_'+tsStr+'.xlsx');
  notify('📤 Downloaded '+_hrmsAttConvData.rows.length+' row(s)');
}

function _hrmsAttConvClear(){
  _hrmsAttConvData=null;
  _hrmsAttConvRender();
}

// ═══ DAILY ATTENDANCE SUMMARY (Utilities) ═══════════════════════════════════
// Upload a daily attendance export and produce a head-count pivot with
// departments as rows and plants as columns. Columns expected:
//   B = Date & Time, C = In/Out, D = Emp Code.
// Only IN records count; per emp code, the latest (max) timestamp wins.
var _hrmsDasState=null;// {present:[{code,ts,matched}],unmatched:[code],fileName,rowCount}
var _hrmsDasCompareTab=null;// active plant tab in allocation comparison

// Parse an arbitrary date+time cell into a sortable number (ms since epoch).
// Accepts Excel serial (days since 1900 with fractional time), ISO strings,
// DD/MM/YYYY [HH:MM[:SS]], Mon DD YYYY formats. Returns NaN on failure.
function _hrmsDasParseDateTime(raw){
  if(raw==null) return NaN;
  var s=String(raw).trim();if(!s) return NaN;
  // Excel serial (with optional fraction)
  if(/^\d+(\.\d+)?$/.test(s)){
    var n=+s;
    if(n>=1&&n<60000){
      return Math.round((n-25569)*86400000);
    }
  }
  // ISO: 2026-04-24[T ]HH:MM[:SS]
  var iso=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(iso){
    return Date.UTC(+iso[1],+iso[2]-1,+iso[3],+(iso[4]||0),+(iso[5]||0),+(iso[6]||0));
  }
  // DD/MM/YYYY [HH:MM[:SS]] [AM/PM]
  var dmy=s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?)?/);
  if(dmy){
    var d=+dmy[1],m=+dmy[2],y=+dmy[3];if(y<100)y+=2000;
    if(m>12&&d<=12){var t=d;d=m;m=t;}
    var hh=+(dmy[4]||0),mm=+(dmy[5]||0),ss=+(dmy[6]||0),ap=(dmy[7]||'').toUpperCase();
    if(ap==='PM'&&hh<12) hh+=12; if(ap==='AM'&&hh===12) hh=0;
    return Date.UTC(y,m-1,d,hh,mm,ss);
  }
  // Mon DD YYYY [HH:MM]
  var md=s.match(/^([A-Za-z]{3,})[\s\-\/\.](\d{1,2})[\s\-\/\.,]+(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(md){
    var mons=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    var mi=mons.indexOf(md[1].slice(0,3).toLowerCase());
    if(mi>=0){
      var y2=+md[3];if(y2<100)y2+=2000;
      return Date.UTC(y2,mi,+md[2],+(md[4]||0),+(md[5]||0),+(md[6]||0));
    }
  }
  // Last-ditch: let the JS parser try
  var t2=Date.parse(s);
  return isNaN(t2)?NaN:t2;
}

// Bucket definitions (sub-columns per plant). `short` is used in the pivot
// header to keep columns compact; `label` is the full name shown in tooltips,
// drill-down modal, and the exported file.
var _hrmsDasBuckets=[
  {key:'staff',label:'Staff',short:'Staff'},
  {key:'onrollW',label:'On Roll Workers',short:'OR'},
  {key:'contractW',label:'Contract Workers',short:'Con'},
  {key:'pieceRateW',label:'Piece Rate Workers',short:'PR'}
];

// Pull dept/plant + bucket from the employee's active period (falling back
// to flat fields). Bucket logic: Staff category → staff; else bucket by
// employment type (On Roll / Contract / Piece Rate). Anything else falls
// through to 'other' and surfaces as a dynamic 5th column.
function _hrmsDasEmpOrg(e){
  var ap=(e.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
  var cat=(((ap&&ap.category)||e.category||'')+'').toLowerCase();
  var et=(((ap&&ap.employmentType)||e.employmentType||'')+'').toLowerCase().replace(/\s/g,'');
  var bucket='other';
  if(cat.indexOf('staff')>=0) bucket='staff';
  else if(et==='onroll') bucket='onrollW';
  else if(et==='contract') bucket='contractW';
  else if(et==='piecerate') bucket='pieceRateW';
  return {
    dept:(ap&&ap.department)||e.department||'— Unassigned —',
    plant:(ap&&ap.location)||e.location||'— Unassigned —',
    bucket:bucket
  };
}

async function _hrmsDasUpload(inputEl){
  if(!inputEl||!inputEl.files||!inputEl.files[0]){notify('No file selected',true);return;}
  var file=inputEl.files[0]; inputEl.value='';
  showSpinner('Reading Excel…');
  try{
    var buf=await file.arrayBuffer();
    var sheets=await _hrmsAttConvParseAll(buf);
    var latest={};// code → ts
    var totalRows=0;
    sheets.forEach(function(s){
      for(var i=0;i<s.rows.length;i++){
        var r=s.rows[i];
        var dt=r[1], io=((r[2]==null?'':r[2])+'').trim().toUpperCase(), code=((r[3]==null?'':r[3])+'').trim();
        if(!code) continue;
        if(i===0){
          var allText=String(dt||'')+' '+String(io||'')+' '+String(code||'');
          if(/[A-Za-z]/.test(allText)&&!/^\d/.test(code)) continue;
        }
        if(io!=='IN'&&io.indexOf('IN')!==0) continue;
        if(io.indexOf('OUT')>=0) continue;
        totalRows++;
        var ts=_hrmsDasParseDateTime(dt);
        if(isNaN(ts)) continue;
        if(latest[code]===undefined||ts>latest[code]) latest[code]=ts;
      }
    });
    var empByCode={};
    (DB.hrmsEmployees||[]).forEach(function(e){if(e.empCode) empByCode[String(e.empCode).trim()]=e;});
    var present=[],unmatched=[];
    Object.keys(latest).forEach(function(code){
      var e=empByCode[code];
      if(e) present.push({code:code,ts:latest[code],emp:e});
      else unmatched.push({code:code,ts:latest[code]});
    });
    _hrmsDasState={fileName:file.name,rowCount:totalRows,present:present,unmatched:unmatched,generatedAt:new Date()};
    _hrmsDasBuildPivot();
    hideSpinner();
    _hrmsDasRender();
    notify('✅ Loaded '+present.length+' present employee(s)'+(unmatched.length?' ('+unmatched.length+' unknown code(s))':''));
  }catch(ex){hideSpinner();notify('⚠ Import error: '+ex.message,true);console.error(ex);}
}

function _hrmsDasClear(){
  _hrmsDasState=null;
  _hrmsDasRender();
}

// Build the Daily Attendance Summary from already-stored attendance + alteration
// records for a specific calendar date. Uses `days[<dayOfMonth>].in` and stamps
// each with the actual date so downstream pivot/drill-down code sees real
// timestamps like the upload path does.
async function _hrmsDasLoadFromHistory(){
  var di=document.getElementById('hrmsDasHistDate');
  if(!di||!di.value){notify('Pick a date first',true);return;}
  var parts=di.value.split('-');
  if(parts.length!==3){notify('Invalid date',true);return;}
  var yr=+parts[0], mo=+parts[1]-1, day=+parts[2];
  var mk=parts[0]+'-'+parts[1];
  var dayStr=String(day);
  var dateLbl=String(day).padStart(2,'0')+'/'+String(mo+1).padStart(2,'0')+'/'+yr;

  showSpinner('Loading attendance for '+dateLbl+'…');
  try{
    await _hrmsAttFetchMonth(mk);
    var attRecs=_hrmsAttCache[mk]||[];
    var altRecs=(_hrmsAltCache&&_hrmsAltCache[mk])||[];
    if(!attRecs.length&&!altRecs.length){
      hideSpinner();
      notify('No attendance data found for '+(typeof _hrmsMonthLabel==='function'?_hrmsMonthLabel(mk):mk),true);
      return;
    }

    // Build "latest IN" per emp code for the chosen day. Attendance stores
    // only a single HH:MM per day, so ts = (selected date at that HH:MM).
    var latest={};
    var _absorb=function(code,timeStr){
      if(!code||!timeStr) return;
      var m=String(timeStr).match(/^(\d{1,2}):(\d{2})/);
      if(!m) return;
      var ts=new Date(yr,mo,day,+m[1],+m[2]).getTime();
      if(isNaN(ts)) return;
      if(latest[code]===undefined||ts>latest[code]) latest[code]=ts;
    };
    attRecs.forEach(function(a){
      var d=a.days&&a.days[dayStr];
      if(!d) return;
      _absorb(a.empCode,d.in||d['in']);
    });
    altRecs.forEach(function(a){
      var d=a.days&&a.days[dayStr];
      if(!d) return;
      _absorb(a.empCode,d.in||d['in']);
    });

    var empByCode={};
    (DB.hrmsEmployees||[]).forEach(function(e){if(e.empCode) empByCode[String(e.empCode).trim()]=e;});
    var present=[],unmatched=[];
    Object.keys(latest).forEach(function(code){
      var e=empByCode[code];
      if(e) present.push({code:code,ts:latest[code],emp:e});
      else unmatched.push({code:code,ts:latest[code]});
    });

    if(!present.length&&!unmatched.length){
      hideSpinner();
      notify('No IN records for '+dateLbl+' in stored attendance',true);
      return;
    }

    _hrmsDasState={
      fileName:'History · '+dateLbl,
      rowCount:present.length+unmatched.length,
      present:present,
      unmatched:unmatched,
      generatedAt:new Date(),
      source:'history',
      historyDate:di.value
    };
    _hrmsDasBuildPivot();
    hideSpinner();
    _hrmsDasRender();
    notify('✅ Loaded '+present.length+' present employee(s) from history'+(unmatched.length?' ('+unmatched.length+' unknown code(s))':''));
  }catch(e){hideSpinner();notify('⚠ Load error: '+e.message,true);console.error(e);}
}

// Build the dept × plant × bucket pivot and stash on state for render,
// drill-down, and export.
function _hrmsDasBuildPivot(){
  if(!_hrmsDasState) return;
  var st=_hrmsDasState;
  var pivot={}, plantSet={}, deptSet={}, dateSet={};
  var hasOther=false;
  st.present.forEach(function(p){
    var org=_hrmsDasEmpOrg(p.emp);
    deptSet[org.dept]=1;plantSet[org.plant]=1;
    if(org.bucket==='other') hasOther=true;
    if(!pivot[org.dept]) pivot[org.dept]={};
    if(!pivot[org.dept][org.plant]) pivot[org.dept][org.plant]={};
    if(!pivot[org.dept][org.plant][org.bucket]) pivot[org.dept][org.plant][org.bucket]=[];
    pivot[org.dept][org.plant][org.bucket].push({code:p.code,name:p.emp.name||p.emp.empCode,ts:p.ts});
    var d=new Date(p.ts);
    dateSet[String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear()]=1;
  });
  st.pivot=pivot;
  st.depts=Object.keys(deptSet).sort();
  st.plants=Object.keys(plantSet).sort();
  st.dateLabels=Object.keys(dateSet).sort();
  st.bucketKeys=_hrmsDasBuckets.map(function(b){return b.key;});
  if(hasOther) st.bucketKeys.push('other');
}

function _hrmsDasBucketLabel(bk){
  var found=_hrmsDasBuckets.find(function(b){return b.key===bk;});
  return found?found.label:(bk==='other'?'Other':bk);
}
function _hrmsDasBucketShort(bk){
  var found=_hrmsDasBuckets.find(function(b){return b.key===bk;});
  return found?(found.short||found.label):(bk==='other'?'Oth':bk);
}

function _hrmsDasSetCompareTab(tab){
  _hrmsDasCompareTab=tab;
  _hrmsDasRender();
}

// Tally present employees by Plant × Department × RoleGroup for comparison
// against the Allocation Master. Returns { actuals, plants, depts, groups }.
function _hrmsDasBuildAllocActuals(st){
  var allocRec=(typeof _hrmsAllocationData==='function')?_hrmsAllocationData():null;
  var groups=(allocRec&&allocRec.data&&allocRec.data.groups)||[];
  var actuals={};// 'plant|dept|groupId' → count
  var plants={},depts={};
  st.present.forEach(function(p){
    var org=_hrmsDasEmpOrg(p.emp);
    plants[org.plant]=1;depts[org.dept]=1;
    var ap=(p.emp.periods||[]).find(function(pp){return !pp.to&&(!pp._wfStatus||pp._wfStatus==='approved');});
    var role=((ap&&ap.roll)||p.emp.roll||'');
    var gid=(typeof _hrmsAllocGroupForRole==='function')?_hrmsAllocGroupForRole(role,groups):null;
    if(!gid) return;// no group → skip
    var k=org.plant+'|'+org.dept+'|'+gid;
    actuals[k]=(actuals[k]||0)+1;
  });
  return {actuals:actuals,plants:Object.keys(plants).sort(),depts:Object.keys(depts).sort(),groups:groups,allocations:(allocRec&&allocRec.data&&allocRec.data.allocations)||{}};
}

function _hrmsDasRender(){
  var body=document.getElementById('hrmsDasBody');
  var sumEl=document.getElementById('hrmsDasSummary');
  var clrBtn=document.getElementById('hrmsDasClearBtn');
  var expBtn=document.getElementById('hrmsDasExportBtn');
  if(!body) return;
  if(!_hrmsDasState){
    body.innerHTML='<div class="empty-state" style="padding:40px">Upload an Excel file to generate the head-count summary.</div>';
    if(sumEl) sumEl.textContent='';
    if(clrBtn) clrBtn.style.display='none';
    if(expBtn) expBtn.style.display='none';
    return;
  }
  if(clrBtn) clrBtn.style.display='';
  var st=_hrmsDasState;
  if(!st.pivot) _hrmsDasBuildPivot();
  var pivot=st.pivot||{}, depts=st.depts||[], plants=st.plants||[], bucketKeys=st.bucketKeys||[];

  var _pad=function(n){return String(n).padStart(2,'0');};
  var genTs=st.generatedAt;
  var genStr=genTs?(_pad(genTs.getDate())+'/'+_pad(genTs.getMonth()+1)+'/'+genTs.getFullYear()+' '+_pad(genTs.getHours())+':'+_pad(genTs.getMinutes())):'';
  var dateHdr=(st.dateLabels&&st.dateLabels.length)?st.dateLabels.join(', '):'';
  var summary='';
  if(dateHdr) summary+='<span style="font-size:15px;font-weight:900;color:var(--accent)">📅 '+dateHdr+'</span> &nbsp; ';
  summary+='File: <b>'+(st.fileName||'')+'</b> · IN records: '+st.rowCount+' · Present: <b>'+st.present.length+'</b>';
  if(st.unmatched.length) summary+=' · <span style="color:#dc2626">Unknown codes: '+st.unmatched.length+'</span>';
  if(genStr) summary+=' · Generated: '+genStr;
  if(sumEl) sumEl.innerHTML=summary;
  if(expBtn) expBtn.style.display=st.present.length?'':'none';

  if(!st.present.length){
    body.innerHTML='<div class="empty-state" style="padding:40px">No IN records recognised in this file.</div>';
    return;
  }

  // Column totals per (plant, bucket) and per plant
  var cellTot={};// "plant|bucket" → n
  var plTot={};// plant → n (sum across buckets)
  var grand=0;
  depts.forEach(function(d){
    plants.forEach(function(pl){
      bucketKeys.forEach(function(bk){
        var n=(((pivot[d]||{})[pl]||{})[bk]||[]).length;
        cellTot[pl+'|'+bk]=(cellTot[pl+'|'+bk]||0)+n;
        plTot[pl]=(plTot[pl]||0)+n;
        grand+=n;
      });
    });
  });

  // Sticky two-row header: row 1 at top:0, row 2 stacked just below. Using
  // position:sticky on individual <th> cells (works with border-collapse:
  // separate — so we use borders + border-spacing:0 to keep the grid look).
  var _stickyBase='position:sticky;background-clip:padding-box;box-shadow:inset 0 -1px 0 #cbd5e1,inset 0 1px 0 #cbd5e1';
  var _th='padding:5px 6px;font-size:11px;font-weight:800;background:#f1f5f9;border:1px solid #cbd5e1;text-align:center;color:var(--text);white-space:nowrap;'+_stickyBase+';top:0;z-index:4';
  var _thSub='padding:3px 4px;font-size:10px;font-weight:800;background:#f8fafc;border:1px solid #e2e8f0;text-align:center;color:var(--text2);white-space:nowrap;width:42px;min-width:42px;max-width:60px;'+_stickyBase+';top:27px;z-index:3';
  var _thSubTot='padding:3px 4px;font-size:10px;font-weight:900;background:#e2e8f0;border:1px solid #cbd5e1;text-align:center;color:var(--text);white-space:nowrap;width:48px;min-width:48px;'+_stickyBase+';top:27px;z-index:3';
  var _td='padding:5px 6px;font-size:13px;border:1px solid #e2e8f0;text-align:right;font-family:var(--mono);font-weight:700';
  var _tdL='padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;text-align:left;font-weight:700;white-space:nowrap';
  var _tdSub='padding:4px 4px;font-size:12px;border:1px solid #e2e8f0;text-align:right;font-family:var(--mono);font-weight:700;width:42px;min-width:42px';
  var _tdTot='padding:5px 6px;font-size:13px;border:1px solid #94a3b8;text-align:right;font-family:var(--mono);font-weight:800;background:#f1f5f9;width:60px;min-width:60px';

  // ── Build the Summary table HTML ──
  var summaryHtml='<div style="overflow:auto;max-height:calc(100vh - 290px);position:relative"><table style="border-collapse:separate;border-spacing:0;min-width:100%">';
  // Header row 1: Department + Plant (colspan=bucketKeys.length+1 for subtotal) + Grand Total
  summaryHtml+='<thead><tr>';
  summaryHtml+='<th rowspan="2" style="'+_th+';left:0;z-index:5;text-align:left;min-width:160px">Department</th>';
  plants.forEach(function(pl){
    var plClr=(typeof _hrmsGetPlantColor==='function'?_hrmsGetPlantColor(pl):'#e2e8f0');
    summaryHtml+='<th colspan="'+(bucketKeys.length+1)+'" style="'+_th+';background:'+plClr+'">'+pl+'</th>';
  });
  summaryHtml+='<th rowspan="2" style="'+_th+';background:#1e293b;color:#fff;min-width:72px">GT</th>';
  summaryHtml+='</tr>';
  // Header row 2: sub-columns per plant. Short labels with `title` tooltips.
  summaryHtml+='<tr>';
  plants.forEach(function(pl){
    bucketKeys.forEach(function(bk){summaryHtml+='<th style="'+_thSub+'" title="'+_hrmsDasBucketLabel(bk)+'">'+_hrmsDasBucketShort(bk)+'</th>';});
    summaryHtml+='<th style="'+_thSubTot+'" title="Plant Sub-total">Σ</th>';
  });
  summaryHtml+='</tr></thead><tbody>';

  depts.forEach(function(d){
    var dEsc=String(d).replace(/'/g,"\\'");
    var rowTot=0;
    summaryHtml+='<tr><td style="'+_tdL+';position:sticky;left:0;background:#fff;z-index:1">'+d+'</td>';
    plants.forEach(function(pl){
      var plEsc=String(pl).replace(/'/g,"\\'");
      var plantRowSub=0;
      bucketKeys.forEach(function(bk){
        var n=(((pivot[d]||{})[pl]||{})[bk]||[]).length;
        plantRowSub+=n;
        if(n>0) summaryHtml+='<td style="'+_tdSub+';cursor:pointer;color:var(--accent);text-decoration:underline" onclick="_hrmsDasShowDetail(\''+dEsc+'\',\''+plEsc+'\',\''+bk+'\')" title="Click to view names">'+n+'</td>';
        else summaryHtml+='<td style="'+_tdSub+';color:var(--text3)">—</td>';
      });
      rowTot+=plantRowSub;
      summaryHtml+='<td style="'+_td+';background:#f8fafc;width:48px;min-width:48px">'+(plantRowSub||'—')+'</td>';
    });
    summaryHtml+='<td style="'+_tdTot+'">'+rowTot+'</td></tr>';
  });
  // Totals row
  summaryHtml+='<tr><td style="'+_tdL+';position:sticky;left:0;z-index:1;background:#1e293b;color:#fff">Total</td>';
  plants.forEach(function(pl){
    bucketKeys.forEach(function(bk){
      summaryHtml+='<td style="'+_tdSub+';background:#334155;color:#fff">'+(cellTot[pl+'|'+bk]||0)+'</td>';
    });
    summaryHtml+='<td style="'+_tdTot+';background:#1e293b;color:#fff">'+(plTot[pl]||0)+'</td>';
  });
  summaryHtml+='<td style="'+_tdTot+';background:#16a34a;color:#fff">'+grand+'</td></tr>';
  summaryHtml+='</tbody></table></div>';

  // ── Build per-plant Allocation Comparison HTML ──
  var alloc=_hrmsDasBuildAllocActuals(st);
  var compPlants=alloc.plants;
  var compDepts=alloc.depts;
  var compGroups=alloc.groups;
  var compHtmlByPlant={};
  var compEmptyMsg='';
  if(!compGroups.length){
    compEmptyMsg='<div style="margin:16px 0;padding:14px;background:#fef3c7;border:1.5px solid #fde047;border-radius:8px;font-size:12px;color:#92400e">No role groups defined yet. Open <b>Masters → Allocation</b> to create groups before comparing.</div>';
  } else if(!compPlants.length){
    compEmptyMsg='<div style="margin:16px 0;padding:14px;background:#fef3c7;border:1.5px solid #fde047;border-radius:8px;font-size:12px;color:#92400e">No present employees mapped to a plant yet — nothing to compare.</div>';
  } else {
    compPlants.forEach(function(plant){
      var ph='<div style="font-size:11px;color:var(--text3);margin:0 0 10px">Cells show <b>Present / Allocated</b>. Red = below allocated · Amber = exact match · Green = at or above allocated.</div>';
      ph+='<div style="overflow:auto;max-height:calc(100vh - 290px);border:1.5px solid var(--border);border-radius:8px"><table style="width:auto;border-collapse:collapse;font-size:12px">';
      ph+='<thead><tr style="background:#1e293b;color:#fff"><th style="padding:5px 10px;text-align:left;min-width:140px;position:sticky;top:0;background:#1e293b">Department</th>';
      compGroups.forEach(function(g){ph+='<th style="padding:5px 10px;text-align:center;min-width:90px;position:sticky;top:0;background:#1e293b">'+g.name+'</th>';});
      ph+='<th style="padding:5px 10px;text-align:center;background:#0f172a;min-width:90px;position:sticky;top:0">Total</th></tr></thead><tbody>';
      compDepts.forEach(function(dept){
        var rowAct=0,rowAlloc=0;
        ph+='<tr style="border-top:1px solid #e2e8f0"><td style="padding:5px 10px;font-weight:700">'+dept+'</td>';
        compGroups.forEach(function(g){
          var key=plant+'|'+dept+'|'+g.id;
          var actual=+(alloc.actuals[key]||0)||0;
          var allocated=+(alloc.allocations[key]||0)||0;
          rowAct+=actual;rowAlloc+=allocated;
          var bg='',clr='var(--text)',weight=actual||allocated?'700':'400';
          if(allocated>0||actual>0){
            if(actual<allocated){bg='#fee2e2';clr='#dc2626';}
            else if(actual===allocated){bg='#fef3c7';clr='#92400e';}
            else{bg='#dcfce7';clr='#15803d';}
          }
          ph+='<td style="padding:4px 10px;text-align:center;background:'+bg+';color:'+clr+';font-weight:'+weight+';font-family:var(--mono)">'+(actual||allocated?(actual+' / '+allocated):'—')+'</td>';
        });
        var rowBg=rowAct<rowAlloc?'#fee2e2':(rowAct===rowAlloc?'#fef3c7':'#dcfce7');
        var rowClr=rowAct<rowAlloc?'#dc2626':(rowAct===rowAlloc?'#92400e':'#15803d');
        ph+='<td style="padding:4px 10px;text-align:center;background:'+rowBg+';color:'+rowClr+';font-weight:900;font-family:var(--mono)">'+(rowAct||rowAlloc?(rowAct+' / '+rowAlloc):'—')+'</td></tr>';
      });
      ph+='</tbody></table></div>';
      compHtmlByPlant[plant]=ph;
    });
  }

  // ── Top tab bar — Summary first, then one per plant ──
  var validTabs=['summary'].concat(compPlants);
  if(validTabs.indexOf(_hrmsDasCompareTab)<0) _hrmsDasCompareTab='summary';
  var activeTab=_hrmsDasCompareTab;

  var h='<div style="display:flex;gap:0;margin-bottom:12px;border-bottom:2px solid var(--border);overflow-x:auto;flex-wrap:nowrap">';
  var renderTab=function(key,label,colour){
    var active=(activeTab===key);
    var keyEsc=key.replace(/'/g,"\\'");
    return '<div onclick="_hrmsDasSetCompareTab(\''+keyEsc+'\')" style="padding:8px 16px;font-size:13px;font-weight:'+(active?'800':'700')+';cursor:pointer;border-bottom:3px solid '+(active?(colour||'var(--accent)'):'transparent')+';color:'+(active?(colour||'var(--accent)'):'var(--text3)')+';background:'+(active?'var(--accent-light)':'transparent')+';white-space:nowrap">'+label+'</div>';
  };
  h+=renderTab('summary','📊 Daily Attendance Summary');
  compPlants.forEach(function(plant){h+=renderTab(plant,'🏭 '+plant,'#1e293b');});
  h+='</div>';

  if(activeTab==='summary') h+=summaryHtml;
  else if(compHtmlByPlant[activeTab]) h+=compHtmlByPlant[activeTab];
  else h+=compEmptyMsg||summaryHtml;

  if(st.unmatched.length){
    var _unkChips=st.unmatched.map(function(u){
      var ec=String(u.code||'');
      var ecEsc=ec.replace(/'/g,"\\'");
      // Pre-existing employee (e.g. unknown because they're _isNewEcr or
      // their flat status differs) gets a "view" link; otherwise an "Add"
      // link that opens the new-employee form pre-filled with this code.
      var existing=(DB.hrmsEmployees||[]).find(function(e){return(e.empCode||'').toUpperCase().trim()===ec.toUpperCase().trim();});
      if(existing){
        return '<a href="javascript:void(0)" onclick="_hrmsOpenEmpByCode(\''+ecEsc+'\')" style="color:#dc2626;font-weight:800;text-decoration:underline;cursor:pointer;padding:1px 4px;border-radius:3px;background:#fee2e2" title="View / edit existing employee">'+ec+'</a>';
      }
      return '<a href="javascript:void(0)" onclick="_hrmsAddEmpWithCode(\''+ecEsc+'\')" style="color:#dc2626;font-weight:800;text-decoration:underline;cursor:pointer;padding:1px 4px;border-radius:3px;background:#fee2e2" title="Add new employee with this code">'+ec+' +</a>';
    }).join(' · ');
    h+='<div style="margin-top:16px;padding:10px 12px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;font-size:12px;color:#7f1d1d">'+
       '<b>Unknown emp codes ('+st.unmatched.length+')</b> — not found in Employee master; excluded from the head count. Click a code to add or view that employee:<br>'+
       '<div style="margin-top:6px;font-family:var(--mono);font-size:11px;max-height:120px;overflow:auto;line-height:1.9">'+
       _unkChips+
       '</div></div>';
  }
  body.innerHTML=h;
}

// Drill-down: show the list of employees behind a head-count cell.
function _hrmsDasShowDetail(dept,plant,bucketKey){
  if(!_hrmsDasState||!_hrmsDasState.pivot) return;
  var list=(((_hrmsDasState.pivot[dept]||{})[plant]||{})[bucketKey])||[];
  list=list.slice().sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});
  var _pad=function(n){return String(n).padStart(2,'0');};
  var bucketLbl=_hrmsDasBucketLabel(bucketKey);
  var dateHdr=(_hrmsDasState.dateLabels||[]).join(', ');
  var h='';
  h+='<div id="_hrmsDasDetailOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:10000" onclick="if(event.target===this)this.remove()">';
  h+='<div style="background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:88vh;overflow:auto;width:min(620px,94vw);padding:20px">';
  h+='<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:14px;gap:12px">';
  h+='<div>';
  h+='<div style="font-size:11px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:1px">'+(dateHdr?'📅 '+dateHdr+' · ':'')+dept+' · '+plant+'</div>';
  h+='<div style="font-size:18px;font-weight:900;margin-top:4px">'+bucketLbl+' — '+list.length+' employee(s)</div>';
  h+='</div>';
  h+='<button onclick="document.getElementById(\'_hrmsDasDetailOverlay\').remove()" style="background:none;border:none;font-size:26px;cursor:pointer;color:var(--text3);line-height:1;padding:0 4px">×</button>';
  h+='</div>';
  if(!list.length){
    h+='<div class="empty-state" style="padding:30px">No employees.</div>';
  } else {
    h+='<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>';
    var _sth='padding:6px 8px;background:#f1f5f9;font-size:11px;font-weight:800;border-bottom:1.5px solid var(--border);text-align:left';
    h+='<th style="'+_sth+'">#</th>';
    h+='<th style="'+_sth+'">Emp Code</th>';
    h+='<th style="'+_sth+'">Name</th>';
    h+='<th style="'+_sth+';text-align:right">IN Time</th>';
    h+='</tr></thead><tbody>';
    var _std='padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:12px';
    list.forEach(function(r,i){
      var d=new Date(r.ts);
      var timeStr=_pad(d.getHours())+':'+_pad(d.getMinutes())+':'+_pad(d.getSeconds());
      var codeEsc=String(r.code||'').replace(/'/g,"\\'");
      h+='<tr>';
      h+='<td style="'+_std+';color:var(--text3)">'+(i+1)+'</td>';
      h+='<td style="'+_std+';font-family:var(--mono);font-weight:700"><a href="javascript:void(0)" onclick="document.getElementById(\'_hrmsDasDetailOverlay\').remove();_hrmsOpenEmpByCode(\''+codeEsc+'\')" style="color:var(--accent);text-decoration:underline;cursor:pointer" title="View / edit employee">'+r.code+'</a></td>';
      h+='<td style="'+_std+';font-weight:700">'+(r.name||'—')+'</td>';
      h+='<td style="'+_std+';text-align:right;font-family:var(--mono)">'+timeStr+'</td>';
      h+='</tr>';
    });
    h+='</tbody></table>';
  }
  h+='</div></div>';
  // Remove any prior overlay first
  var prior=document.getElementById('_hrmsDasDetailOverlay');if(prior) prior.remove();
  var tmp=document.createElement('div');tmp.innerHTML=h;
  document.body.appendChild(tmp.firstChild);
}

// Excel sheet names disallow : \ / ? * [ ] and cap at 31 chars.
function _hrmsDasSheetName(name){
  return String(name||'Plant').replace(/[:\\\/?*\[\]]/g,'-').slice(0,31);
}

// Format a time-of-day from ms timestamp.
function _hrmsDasFmtTime(ts){
  var d=new Date(ts);
  var _p=function(n){return String(n).padStart(2,'0');};
  return _p(d.getHours())+':'+_p(d.getMinutes())+':'+_p(d.getSeconds());
}

// Build the "All" sheet — combined plant-wise pivot on the left, full employee
// list on the right (sorted by plant, department, name).
// Returns {data, merges, colWidths, freezeRow, noFilter} for _downloadMultiSheetXlsx.
function _hrmsDasBuildAllSheet(st){
  var pivot=st.pivot, depts=st.depts||[], plants=st.plants||[], bucketKeys=st.bucketKeys||[];
  var dateHdr=(st.dateLabels||[]).join(', ');
  var perPlantSpan=bucketKeys.length+1;// buckets + Plant-Sub column
  var sumW=1+plants.length*perPlantSpan+1;// Dept + plants + GrandTotal
  var empHdr=['Plant','Department','Emp Code','Name','Bucket','IN Time'];
  var empW=empHdr.length;
  var gap=1;// single blank column between summary and emp list
  var totalCols=sumW+gap+empW;
  var lastColA=_xlCol(totalCols-1);

  // Build header rows
  var hdr1=['Department'];
  plants.forEach(function(pl){
    hdr1.push(pl);
    for(var k=0;k<perPlantSpan-1;k++) hdr1.push('');
  });
  hdr1.push('Grand Total');
  // Gap + emp header
  hdr1=hdr1.concat(['']).concat(empHdr);

  var hdr2=[''];
  plants.forEach(function(pl){
    bucketKeys.forEach(function(bk){hdr2.push(_hrmsDasBucketLabel(bk));});
    hdr2.push('Plant Sub');
  });
  hdr2.push('');// under Grand Total
  for(var g=0;g<=empW;g++) hdr2.push('');// gap + emp cols

  // Body: side-by-side summary rows and emp rows
  var cellTot={}, plTot={}, grand=0;
  var sumBody=[];
  depts.forEach(function(d){
    var row=[d];var rowTot=0;
    plants.forEach(function(pl){
      var sub=0;
      bucketKeys.forEach(function(bk){
        var n=(((pivot[d]||{})[pl]||{})[bk]||[]).length;
        row.push(n||0);sub+=n;
        cellTot[pl+'|'+bk]=(cellTot[pl+'|'+bk]||0)+n;
      });
      row.push(sub);plTot[pl]=(plTot[pl]||0)+sub;rowTot+=sub;
    });
    row.push(rowTot);grand+=rowTot;
    sumBody.push(row);
  });
  var totRow=['Total'];
  plants.forEach(function(pl){
    bucketKeys.forEach(function(bk){totRow.push(cellTot[pl+'|'+bk]||0);});
    totRow.push(plTot[pl]||0);
  });
  totRow.push(grand);

  // Emp list
  var list=[];
  st.present.forEach(function(p){
    var org=_hrmsDasEmpOrg(p.emp);
    list.push({plant:org.plant,dept:org.dept,code:p.code,name:p.emp.name||p.code,bucketKey:org.bucket,time:_hrmsDasFmtTime(p.ts)});
  });
  list.sort(function(a,b){
    return (a.plant||'').localeCompare(b.plant||'')
        || (a.dept||'').localeCompare(b.dept||'')
        || (a.name||'').localeCompare(b.name||'');
  });
  var empBody=list.map(function(e){return [e.plant,e.dept,e.code,e.name,_hrmsDasBucketLabel(e.bucketKey),e.time];});

  // Stitch rows together
  var padSum=new Array(sumW).fill('');
  var padEmp=new Array(empW).fill('');
  var data=[];
  // Row 0: banner (merged across all columns)
  data.push({banner:true,cells:(function(){var r=['Daily Attendance Summary'+(dateHdr?'  —  '+dateHdr:'')];for(var i=1;i<totalCols;i++) r.push('');return r;})()});
  // Row 1: info (merged)
  data.push({banner:true,cells:(function(){var r=['File: '+(st.fileName||'')+'    |    Present: '+st.present.length+(st.unmatched.length?'    |    Unknown codes: '+st.unmatched.length:'')];for(var i=1;i<totalCols;i++) r.push('');return r;})()});
  // Row 2: header1 (tblheader — plant labels)
  data.push({tblheader:true,cells:hdr1});
  // Row 3: header2 (tblsubheader — bucket labels)
  data.push({tblsubheader:true,cells:hdr2});
  // Data rows — each row = summary-body + gap + emp-body (padded)
  var maxBody=Math.max(sumBody.length,empBody.length);
  for(var i=0;i<maxBody;i++){
    var s=sumBody[i]||padSum;
    var e=empBody[i]||padEmp;
    data.push(s.concat(['']).concat(e));
  }
  // Total row — aligns with summary side only; pad emp cols blank
  data.push({tbltotal:true,cells:totRow.concat(['']).concat(padEmp)});

  // Unknown-code trailer (outside the pivot, spans width)
  if(st.unmatched.length){
    data.push([]);
    var unkTitle=new Array(totalCols).fill('');
    unkTitle[0]='Unknown emp codes (not in Employee master): '+st.unmatched.length;
    data.push({bold:true,cells:unkTitle});
    st.unmatched.forEach(function(u){
      var r=new Array(totalCols).fill('');r[0]=u.code;data.push(r);
    });
  }

  // Build merges
  var merges=[];
  merges.push('A1:'+lastColA+'1');// banner
  merges.push('A2:'+lastColA+'2');// info
  // Department cell: rows 3-4 (1-indexed)
  merges.push('A3:A4');
  // Plant header spans
  var colIdx=1;// after Dept
  plants.forEach(function(pl){
    var start=_xlCol(colIdx);
    var end=_xlCol(colIdx+perPlantSpan-1);
    merges.push(start+'3:'+end+'3');
    colIdx+=perPlantSpan;
  });
  // Grand Total spans rows 3-4
  var gtCol=_xlCol(sumW-1);
  merges.push(gtCol+'3:'+gtCol+'4');
  // Emp header labels span both header rows
  for(var ec=0;ec<empW;ec++){
    var c=_xlCol(sumW+gap+ec);
    merges.push(c+'3:'+c+'4');
  }

  // Column widths
  var colWidths=[];
  colWidths.push(22);// Department (summary)
  plants.forEach(function(){
    bucketKeys.forEach(function(){colWidths.push(9);});// Staff/OR/Con/PR
    colWidths.push(11);// Plant Sub
  });
  colWidths.push(13);// Grand Total
  colWidths.push(3);// gap
  // Emp list: Plant, Dept, Code, Name, Bucket, IN Time
  colWidths.push(16,22,12,28,14,12);

  return {
    data:data,
    merges:merges,
    colWidths:colWidths,
    freezeRow:4,// freeze banner + info + 2 header rows
    noFilter:true,
    noFreeze:false
  };
}

// Build a per-plant sheet — plant-scoped dept × bucket pivot on the left,
// employee list on the right (sorted by department, then name).
function _hrmsDasBuildPlantSheet(st,plantName){
  var pivot=st.pivot, bucketKeys=st.bucketKeys||[];
  var dateHdr=(st.dateLabels||[]).join(', ');
  var allDepts=st.depts||[];
  var depts=allDepts.filter(function(d){
    var pl=(pivot[d]||{})[plantName];if(!pl) return false;
    return bucketKeys.some(function(bk){return(pl[bk]||[]).length>0;});
  });

  var sumHdr=['Department'].concat(bucketKeys.map(_hrmsDasBucketLabel)).concat(['Total']);
  var sumW=sumHdr.length;
  var empHdr=['Department','Emp Code','Name','Bucket','IN Time'];
  var empW=empHdr.length;
  var totalCols=sumW+1+empW;
  var lastColA=_xlCol(totalCols-1);

  var colTot={},grand=0;
  bucketKeys.forEach(function(bk){colTot[bk]=0;});
  var body=[];
  depts.forEach(function(d){
    var row=[d];var rowTot=0;
    bucketKeys.forEach(function(bk){
      var n=(((pivot[d]||{})[plantName]||{})[bk]||[]).length;
      row.push(n);colTot[bk]+=n;rowTot+=n;
    });
    row.push(rowTot);grand+=rowTot;
    body.push(row);
  });
  var totRow=['Total'];
  bucketKeys.forEach(function(bk){totRow.push(colTot[bk]);});
  totRow.push(grand);

  var list=[];
  st.present.forEach(function(p){
    var org=_hrmsDasEmpOrg(p.emp);
    if(org.plant!==plantName) return;
    list.push({dept:org.dept,code:p.code,name:p.emp.name||p.code,bucketKey:org.bucket,time:_hrmsDasFmtTime(p.ts)});
  });
  list.sort(function(a,b){
    return (a.dept||'').localeCompare(b.dept||'')
        || (a.name||'').localeCompare(b.name||'');
  });
  var empBody=list.map(function(e){return [e.dept,e.code,e.name,_hrmsDasBucketLabel(e.bucketKey),e.time];});

  var padSum=new Array(sumW).fill('');
  var padEmp=new Array(empW).fill('');
  var data=[];
  // Banner row
  data.push({banner:true,cells:(function(){var r=['Plant: '+plantName+(dateHdr?'  —  '+dateHdr:'')];for(var i=1;i<totalCols;i++) r.push('');return r;})()});
  // Info row
  data.push({banner:true,cells:(function(){var r=['Present at this plant: '+list.length];for(var i=1;i<totalCols;i++) r.push('');return r;})()});
  // Combined header row — summary + gap + emp header
  data.push({tblheader:true,cells:sumHdr.concat(['']).concat(empHdr)});
  // Body
  var maxBody=Math.max(body.length,empBody.length);
  for(var i=0;i<maxBody;i++){
    var s=body[i]||padSum;
    var e=empBody[i]||padEmp;
    data.push(s.concat(['']).concat(e));
  }
  // Total row
  data.push({tbltotal:true,cells:totRow.concat(['']).concat(padEmp)});

  var merges=[];
  merges.push('A1:'+lastColA+'1');
  merges.push('A2:'+lastColA+'2');

  var colWidths=[22];
  bucketKeys.forEach(function(){colWidths.push(11);});
  colWidths.push(12);// Total
  colWidths.push(3);// gap
  colWidths.push(22,12,28,14,12);// Dept, Code, Name, Bucket, IN Time

  return {
    data:data,
    merges:merges,
    colWidths:colWidths,
    freezeRow:3,// freeze banner + info + header
    noFilter:true,
    noFreeze:false
  };
}

function _hrmsDasExport(){
  if(!_hrmsDasState||!_hrmsDasState.present.length){notify('Nothing to export',true);return;}
  var st=_hrmsDasState;
  if(!st.pivot) _hrmsDasBuildPivot();
  var plants=st.plants||[];
  var sheets=[];
  var allSh=_hrmsDasBuildAllSheet(st);allSh.name='All';sheets.push(allSh);
  var usedNames={'All':1};
  plants.forEach(function(pl){
    var base=_hrmsDasSheetName(pl);
    var nm=base,k=1;
    while(usedNames[nm]){ nm=_hrmsDasSheetName(base.slice(0,28)+'~'+k); k++; }
    usedNames[nm]=1;
    var sh=_hrmsDasBuildPlantSheet(st,pl);sh.name=nm;sheets.push(sh);
  });
  var fnDate=(st.dateLabels&&st.dateLabels[0]?st.dateLabels[0].replace(/\//g,'-'):'daily');
  _downloadMultiSheetXlsx(sheets,'Daily_Attendance_Summary_'+fnDate+'.xlsx');
  notify('📤 Exported '+sheets.length+' sheet(s): All + '+plants.length+' plant(s)');
}

// ═══ MONTHLY HEADCOUNT GRAPH (Utilities) ════════════════════════════════════
// Plant-wise day-by-day head-count line chart for a selected month, using
// attendance (+ alteration) records already in the system. Three overlapping
// lines per plant: On Roll / Contract / Piece Rate. Employment type is taken
// from the employee's currently-active period.
var _hrmsMhgState=null;// {mk, yr, mo, daysInMonth, byPlant}

async function _hrmsMhgInit(){
  var sel=document.getElementById('hrmsMhgMonth');
  if(!sel) return;
  // Ensure the month index is loaded — mirrors how other views bootstrap.
  if(!_hrmsAttMonthIndex){
    showSpinner('Loading month list…');
    try{ await _hrmsAttFetchIndex(); }catch(e){console.error(e);}
    hideSpinner();
  }
  var months=(_hrmsAttMonthIndex||[]).map(function(m){return m.monthKey;});
  if(!months.length){
    sel.innerHTML='<option value="">No attendance data yet</option>';
    _hrmsMhgState=null;
    _hrmsMhgRenderCharts();
    return;
  }
  sel.innerHTML=months.map(function(mk){return '<option value="'+mk+'">'+_hrmsMonthLabel(mk)+'</option>';}).join('');
  var initial=(_hrmsMhgState&&months.indexOf(_hrmsMhgState.mk)>=0)?_hrmsMhgState.mk:months[0];
  sel.value=initial;
  await _hrmsMhgLoad(initial);
}

function _hrmsMhgMonthChanged(){
  var sel=document.getElementById('hrmsMhgMonth');
  if(sel&&sel.value) _hrmsMhgLoad(sel.value);
}

// Aggregate a single month from already-cached attendance + alteration records
// into {mk, yr, mo, daysInMonth, byPlant:{plant:{onroll,contract,piecerate}[daysInMonth+1]}}.
// Synchronous — caller must ensure _hrmsAttFetchMonth(mk) was awaited first.
function _hrmsMhgAggMonth(mk){
  var attRecs=_hrmsAttCache[mk]||[];
  var altRecs=(_hrmsAltCache&&_hrmsAltCache[mk])||[];
  var parts=mk.split('-');
  var yr=+parts[0], mo=+parts[1];
  var daysInMonth=new Date(yr,mo,0).getDate();

  var empByCode={};
  (DB.hrmsEmployees||[]).forEach(function(e){if(e.empCode) empByCode[String(e.empCode).trim()]=e;});

  var presDays={};
  var absorb=function(code,daysObj){
    if(!code||!daysObj) return;
    for(var dk in daysObj){
      var d=+dk;if(isNaN(d)||d<1||d>daysInMonth) continue;
      var entry=daysObj[dk];if(!entry) continue;
      if(entry.in||entry['in']){
        if(!presDays[code]) presDays[code]={};
        presDays[code][d]=true;
      }
    }
  };
  attRecs.forEach(function(a){absorb(a.empCode,a.days);});
  altRecs.forEach(function(a){absorb(a.empCode,a.days);});

  var byPlant={};
  var ensure=function(plant){
    if(byPlant[plant]) return byPlant[plant];
    byPlant[plant]={
      staff:new Array(daysInMonth+1).fill(0),
      onroll:new Array(daysInMonth+1).fill(0),
      contract:new Array(daysInMonth+1).fill(0),
      piecerate:new Array(daysInMonth+1).fill(0)
    };
    return byPlant[plant];
  };
  // Bucketing: Staff (any emp type with category=Staff) takes priority; the
  // other three buckets are workers partitioned by employment type so Staff
  // counts don't double-count.
  Object.keys(presDays).forEach(function(code){
    var e=empByCode[code];if(!e) return;
    var ap=(e.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
    var cat=(((ap&&ap.category)||e.category||'')+'').toLowerCase();
    var et=(((ap&&ap.employmentType)||e.employmentType||'')+'').toLowerCase().replace(/\s/g,'');
    var bucket=null;
    if(cat.indexOf('staff')>=0) bucket='staff';
    else if(et==='onroll') bucket='onroll';
    else if(et==='contract') bucket='contract';
    else if(et==='piecerate') bucket='piecerate';
    if(!bucket) return;
    var plant=(ap&&ap.location)||e.location||'— Unassigned —';
    var b=ensure(plant);
    var days=presDays[code];
    for(var d in days){ b[bucket][+d]++; }
  });
  return {mk:mk,yr:yr,mo:mo,daysInMonth:daysInMonth,byPlant:byPlant};
}

// Compute working-day average for one plant in one month, excluding:
//   • H (WO) and P (PH) days per the plant calendar
//   • "Unseeded" working days where no headcount has been recorded at all
//     (total across all 3 buckets = 0). This avoids end-of-month or
//     partial-import gaps dragging the average below the daily minimum.
function _hrmsMhgComputePlantAvg(agg,plant){
  var b=agg.byPlant[plant];
  if(!b) return {workDays:0,avgS:0,avgOR:0,avgC:0,avgPR:0,hasData:false};
  var workDays=0,sS=0,sOR=0,sC=0,sPR=0;
  for(var d=1;d<=agg.daysInMonth;d++){
    var dType=(typeof _hrmsGetDayType==='function')
      ? _hrmsGetDayType(agg.mk,d,agg.yr,agg.mo,plant)
      : (new Date(agg.yr,agg.mo-1,d).getDay()===0?'WO':'WD');
    if(dType==='WO'||dType==='PH') continue;
    var tot=(b.staff[d]||0)+(b.onroll[d]||0)+(b.contract[d]||0)+(b.piecerate[d]||0);
    if(tot===0) continue;// working day but no attendance imported → skip
    workDays++;
    sS+=b.staff[d]||0;
    sOR+=b.onroll[d]||0;
    sC+=b.contract[d]||0;
    sPR+=b.piecerate[d]||0;
  }
  return {
    workDays:workDays,
    avgS:workDays?sS/workDays:0,
    avgOR:workDays?sOR/workDays:0,
    avgC:workDays?sC/workDays:0,
    avgPR:workDays?sPR/workDays:0,
    hasData:(sS+sOR+sC+sPR)>0
  };
}

async function _hrmsMhgLoad(mk){
  if(!mk) return;
  showSpinner('Computing headcount for '+_hrmsMonthLabel(mk)+'…');
  try{
    var parts=mk.split('-');
    var yr=+parts[0], mo=+parts[1];
    // Last 3 months in chronological (oldest→newest) order.
    var histMonths=[];
    for(var i=3;i>=1;i--){
      var py=yr, pm=mo-i;
      while(pm<1){pm+=12;py--;}
      histMonths.push(py+'-'+String(pm).padStart(2,'0'));
    }
    // Fetch current + 3 prior months in parallel.
    var allMonths=histMonths.concat([mk]);
    await Promise.all(allMonths.map(function(m){
      return _hrmsAttFetchMonth(m).catch(function(err){console.warn('Att fetch failed for',m,err);return null;});
    }));

    // Current-month aggregation (daily series drives the main bars).
    var curAgg=_hrmsMhgAggMonth(mk);

    // Prior-month averages per plant (keyed same as current so we can align).
    var histByPlant={};
    histMonths.forEach(function(hmk){
      var hAgg=_hrmsMhgAggMonth(hmk);
      Object.keys(hAgg.byPlant).forEach(function(plant){
        var avg=_hrmsMhgComputePlantAvg(hAgg,plant);
        if(!histByPlant[plant]) histByPlant[plant]=[];
        histByPlant[plant].push({mk:hmk,avgS:avg.avgS,avgOR:avg.avgOR,avgC:avg.avgC,avgPR:avg.avgPR,workDays:avg.workDays,hasData:avg.hasData});
      });
    });
    Object.keys(curAgg.byPlant).forEach(function(p){
      if(!histByPlant[p]) histByPlant[p]=[];
      var have={};histByPlant[p].forEach(function(e){have[e.mk]=true;});
      histMonths.forEach(function(hmk){
        if(!have[hmk]) histByPlant[p].push({mk:hmk,avgS:0,avgOR:0,avgC:0,avgPR:0,workDays:0,hasData:false});
      });
      histByPlant[p].sort(function(a,b){return a.mk<b.mk?-1:(a.mk>b.mk?1:0);});
    });

    _hrmsMhgState={
      mk:mk,yr:yr,mo:mo,daysInMonth:curAgg.daysInMonth,
      byPlant:curAgg.byPlant,
      histByPlant:histByPlant,
      histMonths:histMonths
    };
    hideSpinner();
    _hrmsMhgRenderCharts();
  }catch(e){hideSpinner();notify('⚠ Load failed: '+e.message,true);console.error(e);}
}

function _hrmsMhgRenderCharts(){
  var el=document.getElementById('hrmsMhgCharts');
  if(!el) return;
  if(!_hrmsMhgState){
    el.innerHTML='<div class="empty-state" style="padding:40px">Select a month above to load data.</div>';
    return;
  }
  var st=_hrmsMhgState;
  var plants=Object.keys(st.byPlant).sort();
  if(!plants.length){
    el.innerHTML='<div class="empty-state" style="padding:40px">No attendance data (with a recognised On Roll / Contract / Piece Rate employee) for '+_hrmsMonthLabel(st.mk)+'.</div>';
    return;
  }
  var h='';
  plants.forEach(function(pl){
    var hist=(st.histByPlant&&st.histByPlant[pl])||[];
    h+=_hrmsMhgPlantCard(pl,st.byPlant[pl],st.daysInMonth,st.yr,st.mo,hist,st.histMonths||[]);
  });
  // Combined (All Plants) chart at the end — sum across plants per day and
  // per historical month. Only show when more than one plant is present,
  // otherwise it duplicates the sole plant's card.
  if(plants.length>1){
    var combined={
      staff:new Array(st.daysInMonth+1).fill(0),
      onroll:new Array(st.daysInMonth+1).fill(0),
      contract:new Array(st.daysInMonth+1).fill(0),
      piecerate:new Array(st.daysInMonth+1).fill(0)
    };
    plants.forEach(function(p){
      var pd=st.byPlant[p];
      for(var d=1;d<=st.daysInMonth;d++){
        combined.staff[d]+=pd.staff[d]||0;
        combined.onroll[d]+=pd.onroll[d]||0;
        combined.contract[d]+=pd.contract[d]||0;
        combined.piecerate[d]+=pd.piecerate[d]||0;
      }
    });
    // Combined history = sum of each plant's history entry for the same mk.
    var combinedHist=(st.histMonths||[]).map(function(hmk){
      var sS=0,sOR=0,sC=0,sPR=0,anyData=false;
      plants.forEach(function(p){
        var hE=((st.histByPlant||{})[p]||[]).find(function(e){return e.mk===hmk;});
        if(hE){sS+=hE.avgS||0;sOR+=hE.avgOR||0;sC+=hE.avgC||0;sPR+=hE.avgPR||0;if(hE.hasData) anyData=true;}
      });
      return {mk:hmk,avgS:sS,avgOR:sOR,avgC:sC,avgPR:sPR,workDays:0,hasData:anyData};
    });
    // Plant name '' tells _hrmsGetDayType to fall back to Sunday=WO (no
    // plant-specific calendar for the combined view).
    h+=_hrmsMhgPlantCard('All Plants (Combined)',combined,st.daysInMonth,st.yr,st.mo,combinedHist,st.histMonths||[]);
  }
  el.innerHTML=h;
}

function _hrmsMhgPlantCard(plant,data,daysInMonth,yr,mo,history,histMonths){
  var plClr=(typeof _hrmsGetPlantColor==='function'?_hrmsGetPlantColor(plant):'#e2e8f0');

  // Pre-compute day type for every day (plant-specific calendar).
  var mk=_hrmsMhgState&&_hrmsMhgState.mk;
  var dayTypes=new Array(daysInMonth+1).fill('WD');
  for(var d=1;d<=daysInMonth;d++){
    dayTypes[d]=(typeof _hrmsGetDayType==='function')
      ? _hrmsGetDayType(mk,d,yr,mo,plant)
      : (new Date(yr,mo-1,d).getDay()===0?'WO':'WD');
  }

  // Average: exclude H/P days AND working days with zero recorded headcount
  // (a zero means the day hasn't been seeded with attendance yet — counting
  // it would drag the average below the actual daily minimum).
  var workDays=0, hpDays=0, noDataDays=0, sS=0, sOR=0, sC=0, sPR=0;
  for(var d=1;d<=daysInMonth;d++){
    if(dayTypes[d]==='WO'||dayTypes[d]==='PH'){ hpDays++; continue; }
    var tot=(data.staff[d]||0)+(data.onroll[d]||0)+(data.contract[d]||0)+(data.piecerate[d]||0);
    if(tot===0){ noDataDays++; continue; }
    workDays++;
    sS+=data.staff[d]||0;
    sOR+=data.onroll[d]||0;
    sC+=data.contract[d]||0;
    sPR+=data.piecerate[d]||0;
  }
  var avgS=workDays?sS/workDays:0;
  var avgOR=workDays?sOR/workDays:0;
  var avgC=workDays?sC/workDays:0;
  var avgPR=workDays?sPR/workDays:0;
  var _r=function(x){return Math.round(x);};// integer rounding for display

  var peakS=Math.max.apply(Math,data.staff);
  var peakOR=Math.max.apply(Math,data.onroll);
  var peakC=Math.max.apply(Math,data.contract);
  var peakPR=Math.max.apply(Math,data.piecerate);

  // Max Y must fit the tallest daily stack AND the tallest historical avg stack.
  var maxY=1;
  for(var d=1;d<=daysInMonth;d++){
    var sum=(data.staff[d]||0)+(data.onroll[d]||0)+(data.contract[d]||0)+(data.piecerate[d]||0);
    if(sum>maxY) maxY=sum;
  }
  (history||[]).forEach(function(h){
    var ht=(h.avgS||0)+(h.avgOR||0)+(h.avgC||0)+(h.avgPR||0);
    if(ht>maxY) maxY=ht;
  });
  var step=maxY<=10?2:(maxY<=50?5:(maxY<=100?10:(maxY<=500?50:100)));
  maxY=Math.ceil(maxY/step)*step;
  if(maxY<step) maxY=step;

  var svg=_hrmsMhgChartSvg(data,daysInMonth,yr,mo,maxY,{
    avgS:avgS,avgOR:avgOR,avgC:avgC,avgPR:avgPR,
    workDays:workDays,dayTypes:dayTypes,
    history:history||[],histMonths:histMonths||[]
  });

  var h='<div class="card" style="margin-bottom:16px;padding:14px">';
  h+='<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:10px">';
  h+='<div style="display:flex;align-items:center;gap:10px">';
  h+='<span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:'+plClr+';border:1px solid rgba(0,0,0,.15)"></span>';
  h+='<span style="font-size:16px;font-weight:900">'+plant+'</span>';
  h+='<span style="font-size:11px;font-weight:700;color:var(--text3)">· avg over '+workDays+' working day(s) with data (excluded '+hpDays+' H/P'+(noDataDays?', '+noDataDays+' no-data':'')+')</span>';
  h+='</div>';
  h+='<div style="display:flex;gap:14px;font-size:11px;flex-wrap:wrap">';
  h+='<span style="color:#d97706;font-weight:700">● Staff · peak '+peakS+' · avg '+_r(avgS)+'</span>';
  h+='<span style="color:#15803d;font-weight:700">● On Roll · peak '+peakOR+' · avg '+_r(avgOR)+'</span>';
  h+='<span style="color:#1d4ed8;font-weight:700">● Contract · peak '+peakC+' · avg '+_r(avgC)+'</span>';
  h+='<span style="color:#7c3aed;font-weight:700">● Piece Rate · peak '+peakPR+' · avg '+_r(avgPR)+'</span>';
  h+='</div>';
  h+='</div>';
  h+=svg;
  h+='</div>';
  return h;
}

function _hrmsMhgChartSvg(data,daysInMonth,yr,mo,maxY,avgs){
  var DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var W=1060,H=356;
  // padR widened for avg-line labels; padB taller for 3-line x labels.
  var padL=46,padR=70,padT=26,padB=62;
  var plotW=W-padL-padR, plotH=H-padT-padB;
  var history=(avgs&&avgs.history)||[];
  var histCount=history.length;// usually 3
  var gapSlots=histCount>0?1:0;
  var totalSlots=histCount+gapSlots+daysInMonth;
  var colW=plotW/totalSlots;
  var barW=colW*0.78;
  // Slot 0..histCount-1 = historical months; histCount = gap; histCount+gapSlots..end = daily.
  var xHistCenter=function(i){ return padL + colW*(i+0.5); };
  var xDayCenter=function(d){ return padL + colW*(histCount+gapSlots+(d-1)+0.5); };
  var xSepCenter=function(){ return padL + colW*(histCount+0.5); };
  var yOf=function(v){ return padT + plotH - (v/maxY)*plotH; };
  var dayTypes=(avgs&&avgs.dayTypes)||null;
  var isExcluded=function(d){
    if(dayTypes) return dayTypes[d]==='WO'||dayTypes[d]==='PH';
    var dow=new Date(yr,mo-1,d).getDay();
    return dow===0||dow===6;
  };
  var dayTypeOf=function(d){return dayTypes?dayTypes[d]:(new Date(yr,mo-1,d).getDay()===0?'WO':'WD');};

  var s='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block;background:#fafafa;border:1px solid var(--border);border-radius:6px">';

  // History column band — soft amber wash to signal "comparison, not current"
  if(histCount>0){
    s+='<rect x="'+padL+'" y="'+padT+'" width="'+(colW*histCount)+'" height="'+plotH+'" fill="#fef3c7" fill-opacity="0.45"/>';
    // Vertical separator line after the last historical column
    var sepX=padL+colW*histCount+colW/2;
    s+='<line x1="'+sepX+'" y1="'+padT+'" x2="'+sepX+'" y2="'+(padT+plotH)+'" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4 4"/>';
  }

  // Excluded daily column bands — H (WO) and P (PH) get a soft grey wash.
  for(var d=1;d<=daysInMonth;d++){
    if(isExcluded(d)){
      var dayX=padL+colW*(histCount+gapSlots+(d-1));
      s+='<rect x="'+dayX+'" y="'+padT+'" width="'+colW+'" height="'+plotH+'" fill="#e2e8f0" fill-opacity="0.55"/>';
    }
  }

  // Y gridlines + labels
  var ySteps=4;
  for(var i=0;i<=ySteps;i++){
    var v=Math.round(maxY*i/ySteps);
    var y=yOf(v);
    s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="#e2e8f0" stroke-width="1"/>';
    s+='<text x="'+(padL-6)+'" y="'+(y+4)+'" text-anchor="end" font-size="10" fill="#64748b">'+v+'</text>';
  }

  // X labels: three lines — date, day-of-week, optional H/P exclusion badge.
  for(var d=1;d<=daysInMonth;d++){
    var dt2=new Date(yr,mo-1,d);
    var dow2=dt2.getDay();
    var excluded=isExcluded(d);
    var dateColor=excluded?'#b91c1c':'#334155';
    var dowColor=excluded?'#dc2626':'#64748b';
    var xl=xDayCenter(d);
    s+='<text x="'+xl+'" y="'+(H-padB+14)+'" text-anchor="middle" font-size="10" font-weight="700" fill="'+dateColor+'">'+d+'</text>';
    s+='<text x="'+xl+'" y="'+(H-padB+28)+'" text-anchor="middle" font-size="9" fill="'+dowColor+'">'+DOW[dow2]+'</text>';
    if(excluded){
      var dt=dayTypeOf(d);
      var badgeTxt=dt==='PH'?'P':(dt==='WO'?'H':'');
      var badgeBg=dt==='PH'?'#dcfce7':'#dbeafe';
      var badgeFg=dt==='PH'?'#15803d':'#1d4ed8';
      if(badgeTxt){
        var bw=12, bh=11;
        s+='<rect x="'+(xl-bw/2)+'" y="'+(H-padB+32)+'" width="'+bw+'" height="'+bh+'" rx="2" ry="2" fill="'+badgeBg+'" stroke="'+badgeFg+'" stroke-width="0.6"/>';
        s+='<text x="'+xl+'" y="'+(H-padB+41)+'" text-anchor="middle" font-size="8" font-weight="800" fill="'+badgeFg+'">'+badgeTxt+'</text>';
      }
    }
  }

  // Axes
  s+='<line x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(padT+plotH)+'" stroke="#94a3b8"/>';
  s+='<line x1="'+padL+'" y1="'+(padT+plotH)+'" x2="'+(W-padR)+'" y2="'+(padT+plotH)+'" stroke="#94a3b8"/>';

  var _r0=function(x){return Math.round(x);};

  // Average reference LINES drawn here (before columns) so the stacked bars
  // render ON TOP of them — prevents the lines from obscuring the per-segment
  // count text. Right-edge labels are drawn later so they remain visible.
  var avgLineState=null;
  if(avgs){
    var lineStartX=histCount>0?(padL+colW*(histCount+gapSlots-0.1)):padL;
    var lineEndX=W-padR+4;
    var stack=[
      {v:avgs.avgS||0, color:'#d97706',label:'S'},
      {v:avgs.avgOR||0,color:'#15803d',label:'OR'},
      {v:avgs.avgC||0, color:'#1d4ed8',label:'C'},
      {v:avgs.avgPR||0,color:'#7c3aed',label:'PR'}
    ];
    var cum=0;
    var lines=[];
    stack.forEach(function(a){
      if(a.v>0){
        var mid=cum+a.v/2;
        lines.push({y:yOf(mid),color:a.color,label:a.label,v:a.v});
      }
      cum+=a.v;
    });
    lines.forEach(function(l){
      s+='<line x1="'+lineStartX+'" y1="'+l.y+'" x2="'+(W-padR)+'" y2="'+l.y+'" stroke="'+l.color+'" stroke-width="2" stroke-dasharray="6 4" stroke-linecap="round" opacity="0.9"><title>'+l.label+' avg (working days with data): '+_r0(l.v)+'</title></line>';
    });
    var totalAvg=cum;
    if(totalAvg>0){
      var totalY=yOf(totalAvg);
      s+='<line x1="'+lineStartX+'" y1="'+totalY+'" x2="'+(W-padR)+'" y2="'+totalY+'" stroke="#0f172a" stroke-width="3" stroke-linecap="round" opacity="0.95"><title>Total avg (working days with data): '+_r0(totalAvg)+'</title></line>';
    }
    // Save for label rendering at the end of the SVG (after columns).
    avgLineState={lines:lines,totalAvg:totalAvg,lineEndX:lineEndX};
  }

  // Staff (amber) sits at the bottom of every stack so it's the first row
  // counted upward. On Roll / Contract / Piece Rate follow.
  var buckets=[
    {key:'staff',color:'#d97706',label:'Staff'},
    {key:'onroll',color:'#15803d',label:'On Roll'},
    {key:'contract',color:'#1d4ed8',label:'Contract'},
    {key:'piecerate',color:'#7c3aed',label:'Piece Rate'}
  ];

  // Historical month columns (rounded averages) drawn first, then labels.
  for(var hi=0;hi<histCount;hi++){
    var hEntry=history[hi];
    var hXC=xHistCenter(hi);
    var hX=hXC-barW/2;
    var vS=_r0(hEntry.avgS||0), vOR=_r0(hEntry.avgOR||0), vC=_r0(hEntry.avgC||0), vPR=_r0(hEntry.avgPR||0);
    var hTotal=vS+vOR+vC+vPR;
    var hCumBottom=padT+plotH;
    var hSegs=[{key:'staff',v:vS,color:'#d97706',label:'Staff'},
               {key:'onroll',v:vOR,color:'#15803d',label:'On Roll'},
               {key:'contract',v:vC,color:'#1d4ed8',label:'Contract'},
               {key:'piecerate',v:vPR,color:'#7c3aed',label:'Piece Rate'}];
    hSegs.forEach(function(seg){
      if(seg.v<=0) return;
      var segH=(seg.v/maxY)*plotH;
      var yTop=hCumBottom-segH;
      s+='<rect x="'+hX+'" y="'+yTop+'" width="'+barW+'" height="'+segH+'" fill="'+seg.color+'" fill-opacity="0.7" stroke="#92400e" stroke-width="0.8" stroke-dasharray="3 2"><title>'+_hrmsMonthLabel(hEntry.mk)+' avg — '+seg.label+': '+seg.v+'</title></rect>';
      if(segH>=12){
        s+='<text x="'+(hX+barW/2)+'" y="'+(yTop+segH/2+3)+'" text-anchor="middle" font-size="9" font-weight="800" fill="#fff">'+seg.v+'</text>';
      }
      hCumBottom=yTop;
    });
    if(hTotal>0){
      var hTopY=padT+plotH-(hTotal/maxY)*plotH;
      s+='<text x="'+hXC+'" y="'+(hTopY-4)+'" text-anchor="middle" font-size="11" font-weight="800" fill="#92400e">'+hTotal+'</text>';
    } else if(!hEntry.hasData){
      // Show a faint "N/A" placeholder so the column position isn't mistaken for a zero day.
      var midY=padT+plotH/2;
      s+='<text x="'+hXC+'" y="'+midY+'" text-anchor="middle" font-size="11" font-weight="700" fill="#94a3b8">N/A</text>';
    }
    // X-axis label: month short name + year + "avg" badge
    var hParts=hEntry.mk.split('-');
    var hYr=+hParts[0], hMo=+hParts[1];
    s+='<text x="'+hXC+'" y="'+(H-padB+14)+'" text-anchor="middle" font-size="10" font-weight="800" fill="#92400e">'+MON[hMo-1]+'</text>';
    s+='<text x="'+hXC+'" y="'+(H-padB+28)+'" text-anchor="middle" font-size="9" fill="#b45309">\''+String(hYr).slice(-2)+'</text>';
    var bw=20,bh=11;
    s+='<rect x="'+(hXC-bw/2)+'" y="'+(H-padB+32)+'" width="'+bw+'" height="'+bh+'" rx="2" ry="2" fill="#fef3c7" stroke="#b45309" stroke-width="0.6"/>';
    s+='<text x="'+hXC+'" y="'+(H-padB+41)+'" text-anchor="middle" font-size="8" font-weight="800" fill="#92400e">AVG</text>';
  }

  // Stacked bars per day — On Roll (bottom), Contract (middle), Piece Rate (top)
  for(var d=1;d<=daysInMonth;d++){
    var x=xDayCenter(d)-barW/2;
    var total=0;
    buckets.forEach(function(b){total+=data[b.key][d];});
    var cumBottom=padT+plotH;
    buckets.forEach(function(b){
      var v=data[b.key][d];
      if(v<=0) return;
      var segH=(v/maxY)*plotH;
      var yTop=cumBottom-segH;
      s+='<rect x="'+x+'" y="'+yTop+'" width="'+barW+'" height="'+segH+'" fill="'+b.color+'" stroke="#fff" stroke-width="0.5"><title>Day '+d+' — '+b.label+': '+v+'</title></rect>';
      if(segH>=12){
        var ty=yTop+segH/2+3;
        s+='<text x="'+(x+barW/2)+'" y="'+ty+'" text-anchor="middle" font-size="9" font-weight="800" fill="#fff">'+v+'</text>';
      }
      cumBottom=yTop;
    });
    if(total>0){
      var topY=padT+plotH-(total/maxY)*plotH;
      s+='<text x="'+xDayCenter(d)+'" y="'+(topY-4)+'" text-anchor="middle" font-size="11" font-weight="800" fill="#1e293b">'+total+'</text>';
    }
  }

  // Average-line LABELS (right-edge tags) — drawn last so they stay visible
  // over everything. The actual dashed/solid lines were drawn before columns.
  if(avgLineState){
    var _lines=avgLineState.lines, _totalAvg=avgLineState.totalAvg, _lineEndX=avgLineState.lineEndX;
    var allLbl=_lines.map(function(l){return {y:l.y,color:l.color,label:l.label,v:l.v,total:false};});
    if(_totalAvg>0) allLbl.push({y:yOf(_totalAvg),color:'#0f172a',label:'Total',v:_totalAvg,total:true});
    var sorted=allLbl.slice().sort(function(a,b){return a.y-b.y;});
    for(var i=1;i<sorted.length;i++){
      if(sorted[i].y-sorted[i-1].y<11) sorted[i].y=sorted[i-1].y+11;
    }
    sorted.forEach(function(a){
      var fs=a.total?11:10;
      s+='<text x="'+_lineEndX+'" y="'+(a.y+4)+'" font-size="'+fs+'" font-weight="800" fill="#fff" stroke="'+a.color+'" stroke-width="3" paint-order="stroke">'+a.label+' '+_r0(a.v)+'</text>';
    });
  }

  s+='</svg>';
  return s;
}

function _hrmsAttPopFilters(){
  var emps=DB.hrmsEmployees||[];
  var plants={},cats={},types={},teams={};
  emps.forEach(function(e){
    if(e.location) plants[e.location]=1;
    if(e.category) cats[e.category]=1;
    if(e.employmentType) types[e.employmentType]=1;
    if(e.teamName) teams[e.teamName]=1;
  });
  var _fill=function(id,obj,label){
    var el=document.getElementById(id);if(!el)return;
    var v=el.value;
    var h='<option value="">All '+label+'</option>';
    Object.keys(obj).sort().forEach(function(k){h+='<option value="'+k+'">'+k+'</option>';});
    el.innerHTML=h;el.value=v;
  };
  _fill('hrmsAttFPlant',plants,'Plants');
  _fill('hrmsAttFCategory',cats,'Categories');
  _fill('hrmsAttFTeam',teams,'Teams');
}

function _hrmsAttClearFilters(){
  var s=document.getElementById('hrmsAttFSearch');if(s)s.value='';
  var sx=document.getElementById('hrmsAttFSearchX');if(sx)sx.style.display='none';
  ['hrmsAttFPlant','hrmsAttFCategory','hrmsAttFTeam'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});
  // Also reset the employment-type pill filter back to "All".
  if(typeof _hrmsAttEtFilterSet==='function') _hrmsAttEtFilterSet('');
  else _hrmsAttRefresh();
}
function _hrmsAttRefresh(){
  if(!_hrmsAttSelectedMonth)return;
  var p=_hrmsAttSelectedMonth.split('-');
  _hrmsRenderAttGrid(+p[0],+p[1]);
}

// _hrmsGetDayType is in hrms-logic.js


function _hrmsRenderAttGrid(yr,mo){
  var grid=document.getElementById('hrmsAttGrid');if(!grid){console.warn('hrmsAttGrid not found');return;}
  var daysInMonth=new Date(yr,mo,0).getDate();
  var monthKey=yr+'-'+String(mo).padStart(2,'0');
  var monthNames=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // Filters
  var fSearch=(document.getElementById('hrmsAttFSearch')?.value||'').toLowerCase();
  var fPlant=(document.getElementById('hrmsAttFPlant')||{}).value||'';
  var fCat=(document.getElementById('hrmsAttFCategory')||{}).value||'';
  var fTeam=(document.getElementById('hrmsAttFTeam')||{}).value||'';
  var fEtBtn=_hrmsAttEtFilter||'';

  // Build lookup: empCode → days object {1:{in,out},2:{in,out},...}
  var attRecords=_hrmsAttCache[monthKey]||[];
  var lookup={};
  attRecords.forEach(function(a){
    lookup[a.empCode]=a.days||{};
  });

  // Build alteration lookup: empCode → {day:{in,out,reason}}
  var altRecords=_hrmsAltCache[monthKey]||[];
  var altLookup={};
  altRecords.forEach(function(a){
    altLookup[a.empCode]=a.days||{};
  });

  // Get employees filtered (with DOJ/DOL gate matching button counts)
  var mStart=monthKey+'-01',mEnd=monthKey+'-'+String(daysInMonth).padStart(2,'0');
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});
  var emps=(DB.hrmsEmployees||[]).filter(function(e){
    var et=(e.employmentType||'').toLowerCase().replace(/\s/g,'');
    var isOnRoll=et==='onroll';
    var isCPR=et==='contract'||et==='piecerate';
    if(isOnRoll){
      // On-Roll: only Present (status='Active'). Check flat AND active period
      // so a stale flat field doesn't bring a Resigned employee back in.
      if((e.status||'Active')!=='Active') return false;
      var _ap=(e.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
      if(_ap&&(_ap.status||'Active')!=='Active') return false;
    } else if(isCPR){
      // Contract / Piece Rate: include ONLY if attendance exists for this month.
      if(!lookup[e.empCode]) return false;
    } else {
      // Others (e.g. Visitor, unclassified) — legacy behaviour.
      if(!lookup[e.empCode]&&e.status!=='Active') return false;
    }
    if(e.dateOfJoining&&e.dateOfJoining>mEnd) return false;
    if(e.dateOfLeft&&e.dateOfLeft<mStart) return false;
    if(fSearch&&((e.empCode||'')+' '+(e.name||'')+' '+_hrmsDispName(e)).toLowerCase().indexOf(fSearch)<0) return false;
    if(fPlant&&e.location!==fPlant) return false;
    if(fCat&&e.category!==fCat) return false;
    if(fEtBtn&&(e.employmentType||'')!==fEtBtn) return false;
    if(fTeam&&e.teamName!==fTeam) return false;
    return true;
  }).sort(function(a,b){
    var typeOrder={'on roll':0,'onroll':0,'contract':1,'piece rate':2,'piecerate':2};
    var catOrder={'staff':0,'worker':1,'security':2};
    var at=(a.employmentType||'').toLowerCase(),bt=(b.employmentType||'').toLowerCase();
    var t1=typeOrder[at]!==undefined?typeOrder[at]:9,t2=typeOrder[bt]!==undefined?typeOrder[bt]:9;
    if(t1!==t2) return t1-t2;
    var p=((a.location||'').localeCompare(b.location||''));if(p!==0) return p;
    var ac=(a.category||'').toLowerCase(),bc=(b.category||'').toLowerCase();
    var c1=catOrder[ac]!==undefined?catOrder[ac]:9,c2=catOrder[bc]!==undefined?catOrder[bc]:9;
    if(c1!==c2) return c1-c2;
    return(a.teamName||'').localeCompare(b.teamName||'');
  });

  // Find unmatched emp codes (attendance exists but no employee record)
  var unmatchedEmps=[];
  for(var ec in lookup){
    if(!empMap[ec]){
      unmatchedEmps.push({empCode:ec,name:'Employee NA',location:'',category:'',employmentType:'',teamName:'',department:'',status:'Active',_unmatched:true});
    }
  }
  // Also check alterations
  for(var ec2 in altLookup){
    if(!empMap[ec2]&&!unmatchedEmps.find(function(u){return u.empCode===ec2;})){
      unmatchedEmps.push({empCode:ec2,name:'Employee NA',location:'',category:'',employmentType:'',teamName:'',department:'',status:'Active',_unmatched:true});
    }
  }
  unmatchedEmps.sort(function(a,b){return(a.empCode||'').localeCompare(b.empCode||'');});
  // Append unmatched at bottom only when no filters active
  var hasFilters=!!(fSearch||fPlant||fCat||fEtBtn||fTeam);
  if(!hasFilters) emps=emps.concat(unmatchedEmps);

  var cntEl=document.getElementById('hrmsAttCount');
  if(cntEl) cntEl.textContent=emps.length+' employee(s)'+(unmatchedEmps.length?' | <span style="color:#dc2626;font-weight:800">'+unmatchedEmps.length+' No EMP</span>':'');
  if(cntEl&&unmatchedEmps.length) cntEl.innerHTML=cntEl.textContent;

  if(!emps.length){grid.innerHTML='<div class="empty-state">No employees match filters. Import attendance data or adjust filters.</div>';return;}

  // Day type colors
  var dtColors={WD:{bg:'#fef3c7',color:'#b45309',label:'W'},WO:{bg:'#dbeafe',color:'#1d4ed8',label:'H'},PH:{bg:'#dcfce7',color:'#15803d',label:'P'}};

  // Build table
  // Column left offsets: #=20px, Plant=30px, Code=50px, Name=60px(wrap), Row=36px
  var L0=0,L1=20,L2=50,L3=100,L4=160;
  var h='<table style="border-collapse:collapse;font-size:11px;white-space:nowrap">';
  // Row heights: day type row ~22px, date header row ~38px
  var RDT=0,RHD=22;
  var hdrBdr='border:1.5px solid #475569;';
  h+='<thead>';

  // Date header row
  var hdrStk='position:sticky;top:'+RDT+'px;';
  h+='<tr style="background:#f0f9ff">';
  h+='<th style="'+hdrStk+'left:'+L0+'px;z-index:4;background:#f0f9ff;width:20px;min-width:20px;'+hdrBdr+'padding:2px 3px;font-size:9px">#</th>';
  h+='<th style="'+hdrStk+'left:'+L1+'px;z-index:4;background:#f0f9ff;width:30px;min-width:30px;'+hdrBdr+'padding:2px 3px;font-size:9px">Plt</th>';
  h+='<th style="'+hdrStk+'left:'+L2+'px;z-index:4;background:#f0f9ff;width:50px;min-width:50px;'+hdrBdr+'padding:2px 3px;font-size:9px">Code</th>';
  h+='<th style="'+hdrStk+'left:'+L3+'px;z-index:4;background:#f0f9ff;width:60px;min-width:60px;'+hdrBdr+'padding:2px 3px;white-space:normal;word-wrap:break-word;font-size:10px">Name</th>';
  h+='<th style="'+hdrStk+'left:'+L4+'px;z-index:4;background:#f0f9ff;width:36px;min-width:36px;'+hdrBdr+'padding:2px 3px;font-size:9px">Row</th>';
  for(var d=1;d<=daysInMonth;d++){
    var dt2=new Date(yr,mo-1,d);
    var dn=dayNames[dt2.getDay()];
    var isSun=dt2.getDay()===0;
    h+='<th style="'+hdrStk+'z-index:3;text-align:center;min-width:36px;'+hdrBdr+'padding:2px 1px;background:'+(isSun?'#fef2f2':'#f0f9ff')+'"><div style="font-size:9px;color:'+(isSun?'#dc2626':'#475569')+'">'+dn+'</div><div style="font-size:10px">'+d+'</div></th>';
  }
  h+='<th style="'+hdrStk+'z-index:3;text-align:center;min-width:36px;'+hdrBdr+'padding:2px 4px;background:#dcfce7;color:#15803d;font-size:10px">Total<br>P</th>';
  h+='<th style="'+hdrStk+'z-index:3;text-align:center;min-width:40px;'+hdrBdr+'padding:2px 4px;background:#f3e8ff;color:#7c3aed;font-size:10px">Total<br>OT</th>';
  h+='<th style="'+hdrStk+'z-index:3;text-align:center;min-width:40px;'+hdrBdr+'padding:2px 4px;background:#fff7ed;color:#c2410c;font-size:10px">OT<br>@S</th>';
  h+='</tr>';
  h+='</thead><tbody>';

  // For each employee: 4 rows
  // Attendance thresholds (from OT rules for this month)
  var _otR=_hrmsGetOtRules(monthKey);
  var FULL_DAY=_otR.fullDay, HALF_DAY=_otR.halfDay, EL_MIN=_otR.elMin, EL_MAX_PER_MONTH=_otR.elMaxPerMonth;
  var rowLabels=['In','Out','P/A','OT'];
  var rowColors=['#eff6ff','#f0fdf4','#fefce8','#faf5ff'];
  emps.forEach(function(emp,ei){
    var empAtt=lookup[emp.empCode]||{};
    var empAlt=altLookup[emp.empCode]||{};
    var borderTop='border-top:2px solid #475569;';
    var isStaff=(emp.category||'').toLowerCase()==='staff'&&(emp.employmentType||'').toLowerCase()!=='contract';

    // Pass 1: compute worked hours per day & determine status
    // Alteration overrides regular attendance
    var dayStatus=[];// 1-indexed: dayStatus[d]={worked,status,isOff,altered}
    var elCount=0;
    for(var dd=1;dd<=daysInMonth;dd++){
      var alt=_hrmsEffectiveAlt(empAlt[String(dd)]||empAlt[dd]||null);
      var ddd=alt||empAtt[String(dd)]||empAtt[dd]||{};
      var ti=ddd['in']||'';var to2=ddd['out']||'';
      var dType=_hrmsGetDayType(monthKey,dd,yr,mo,emp.location);
      var isDayOff=dType==='WO'||dType==='PH';
      var worked=0;var isNight=false;
      if(ti&&to2){
        var t1=_hrmsParseTime(ti),t2=_hrmsParseTime(to2);
        t1=_hrmsRoundIn(t1);t2=_hrmsRoundOut(t2);
        if(t1!==null&&t2!==null){
          // Night shift: in time >= 18:00 (1080 mins)
          if(t2<t1){isNight=true;t2+=1440;}// out < in = night shift, add 24hrs
          worked=(t2-t1)/60;
        }
      }
      var hasTime=!!(ti||to2);
      var status='';
      if(isDayOff){
        status=hasTime?'P':'H';
      } else if(!hasTime){
        status='A';
      } else if(worked>=FULL_DAY){
        status='P';
      } else if(isStaff&&worked>=EL_MIN&&worked<FULL_DAY&&elCount<EL_MAX_PER_MONTH){
        status='EL';elCount++;
      } else if(worked>=HALF_DAY){
        status='P/2';
      } else {
        status='A';
      }
      dayStatus[dd]={worked:worked,status:status,isOff:isDayOff,dayType:dType,hasTime:hasTime,altered:!!alt,reason:(alt&&alt.reason)||'',isNight:isNight};
    }

    // Pass 2: compute totals
    // OT rules: Staff=no OT, Others: <8.5→0, 8.5-14→worked-8.5, >14→worked-9, max 7hrs/day
    var totalP=0,totalOT=0,totalOTS=0;
    for(var dd=1;dd<=daysInMonth;dd++){
      var ds=dayStatus[dd];
      if(!ds.isOff){
        if(ds.status==='P'||ds.status==='EL') totalP+=1;
        else if(ds.status==='P/2') totalP+=0.5;
      }
      if(ds.worked>0&&!isStaff){
        if(ds.isOff){
          // Off days: deduct tiered breaks, cap to rules max
          var otS=ds.worked;
          if(otS>_otR.otsTier2Threshold) otS-=_otR.otsTier2Deduct;
          else if(otS>=_otR.otsTier1Threshold) otS-=_otR.otsTier1Deduct;
          if(otS<0) otS=0;
          otS=Math.min(otS,_otR.otsMaxPerDay);
          totalOTS+=otS;
          ds.otS=otS;
        } else {
          var ot=0;
          if(ds.worked>_otR.otTier2Threshold) ot=ds.worked-_otR.otTier2Subtract;else if(ds.worked>=_otR.otTier1Threshold) ot=ds.worked-_otR.otTier1Subtract;
          if(ot>0){ot=Math.min(ot,_otR.otMaxPerDay);totalOT+=ot;}
          ds.ot=ot;
        }
      }
    }

    // Cell borders: dark columns (left/right), faint inner rows, dark separator on ri===0
    var cBdrInner='border-left:1.5px solid #475569;border-right:1.5px solid #475569;border-bottom:1px solid #cbd5e1;border-top:1px solid #cbd5e1;';
    var cBdrLast='border-left:1.5px solid #475569;border-right:1.5px solid #475569;border-bottom:2px solid #475569;border-top:1px solid #cbd5e1;';
    for(var ri=0;ri<4;ri++){
      h+='<tr style="background:'+rowColors[ri]+'">';
      if(ri===0){
        var isUnmatched=!!emp._unmatched;
        var plt=(emp.location||'').replace(/plant[\s\-]*/i,'P').replace(/^(.{4}).*$/,'$1');
        var pClr=isUnmatched?'#fecaca':_hrmsGetPlantColor(emp.location);
        var rowBg=isUnmatched?'#fef2f2':'#fff';
        h+='<td rowspan="4" style="position:sticky;left:'+L0+'px;z-index:2;background:'+rowBg+';font-weight:700;color:var(--text3);border:1.5px solid #475569;padding:2px 3px;vertical-align:middle;text-align:center;font-size:9px;'+borderTop+'">'+(ei+1)+'</td>';
        h+='<td rowspan="4" style="position:sticky;left:'+L1+'px;z-index:2;background:'+pClr+';font-weight:800;color:#1e293b;border:1.5px solid #475569;padding:2px 3px;vertical-align:middle;font-size:9px;text-align:center;'+borderTop+'">'+(isUnmatched?'—':plt)+'</td>';
        h+='<td rowspan="4" style="position:sticky;left:'+L2+'px;z-index:2;background:'+rowBg+';font-weight:800;color:'+(isUnmatched?'#dc2626':'var(--accent)')+';border:1.5px solid #475569;padding:2px 3px;vertical-align:middle;font-size:12px;'+(isUnmatched?'':'cursor:pointer;text-decoration:underline')+';'+borderTop+'"'+(isUnmatched?'':' data-emp-code="'+emp.empCode+'" title="Click to view employee"')+'>'+emp.empCode+'</td>';
        h+='<td rowspan="4" style="position:sticky;left:'+L3+'px;z-index:2;background:'+rowBg+';font-weight:700;color:'+(isUnmatched?'#dc2626':'')+';border:1.5px solid #475569;padding:2px 3px;vertical-align:middle;white-space:normal;word-wrap:break-word;font-size:10px;'+(isUnmatched?'':'cursor:pointer')+';'+borderTop+'"'+(isUnmatched?'':' data-emp-code="'+emp.empCode+'" title="Click to view employee"')+'>'+(isUnmatched?'Employee NA':_hrmsDispName(emp))+'</td>';
      }
      var cBdr=ri===3?cBdrLast:cBdrInner;
      h+='<td style="position:sticky;left:'+L4+'px;z-index:2;background:'+rowColors[ri]+';font-weight:700;font-size:9px;'+cBdr+'padding:2px 3px;color:#475569;'+(ri===0?borderTop:'')+'">'+rowLabels[ri]+'</td>';
      for(var d=1;d<=daysInMonth;d++){
        var ds=dayStatus[d];
        // Use alteration data if available, else regular
        var altDay=empAlt[String(d)]||empAlt[d]||null;
        var dayData=altDay||empAtt[String(d)]||empAtt[d]||{};
        var tInRaw=dayData['in']||'';
        var tOutRaw=dayData['out']||'';
        var tIn=tInRaw,tOut=tOutRaw;
        if(_hrmsAttAccounted&&tInRaw){var rm=_hrmsRoundIn(_hrmsParseTime(tInRaw));if(rm!==null)tIn=_hrmsMinToTime(rm);}
        if(_hrmsAttAccounted&&tOutRaw){var rm2=_hrmsRoundOut(_hrmsParseTime(tOutRaw));if(rm2!==null)tOut=_hrmsMinToTime(rm2);}
        var isAltered=ds.altered;
        var _dtp=ds.dayType;
        var cellBg=_dtp==='WO'?'rgba(59,130,246,.08)':_dtp==='PH'?'rgba(34,197,94,.08)':'';
        // Purple background for altered time cells
        if(isAltered&&(ri===0||ri===1)) cellBg='#f9a8d4';
        // Red background for missing in or out (one present, other missing) on non-off days
        var hasIn=!!tInRaw,hasOut=!!tOutRaw;
        var isMissing=!ds.isOff&&((hasIn&&!hasOut)||(hasOut&&!hasIn));
        if(isMissing&&ri===0&&!hasIn) cellBg='#ef4444';
        if(isMissing&&ri===1&&!hasOut) cellBg='#ef4444';
        var val='';
        if(ri===0) val=ds.isNight&&tIn?'<b>'+tIn+'</b>':tIn;
        else if(ri===1) val=ds.isNight&&tOut?'<b>'+tOut+'</b>':tOut;
        else if(ri===2){
          var st=ds.status;
          if(st==='P') val='<span style="color:#16a34a;font-weight:800">P</span>';
          else if(st==='P/2') val='<span style="color:#f59e0b;font-weight:800;font-size:9px">P/2</span>';
          else if(st==='EL'){cellBg='#bfdbfe';val='<span style="color:#1d4ed8;font-weight:800;font-size:9px">EL</span>';}
          else if(st==='A') val='<span style="color:#dc2626;font-weight:800">A</span>';
          else if(st==='H') val='<span style="color:#94a3b8;font-size:9px">H</span>';
          else val='<span style="color:#94a3b8;font-size:9px">'+st+'</span>';
        } else if(ri===3){
          if(!isStaff&&ds.worked>0){
            if(ds.isOff&&ds.otS>0){
              cellBg='#7c3aed';val='<span style="color:#fff;font-weight:800;font-size:9px">'+_hrmsFmtOT(ds.otS)+'</span>';
            } else if(!ds.isOff&&ds.ot>0){
              val='<span style="color:#7c3aed;font-weight:700">'+_hrmsFmtOT(ds.ot)+'</span>';
            }
          }
        }
        var ttip=(isAltered&&ds.reason&&(ri===0||ri===1))?' title="'+ds.reason.replace(/"/g,'&quot;')+'"':'';
        h+='<td style="text-align:center;'+cBdr+'padding:1px 2px;font-size:10px;background:'+cellBg+';'+(ri===0?borderTop:'')+'"'+ttip+'>'+val+'</td>';
      }
      // Total columns
      if(ri===0){
        var pDisp=totalP%1===0?String(totalP):totalP.toFixed(1);
        h+='<td rowspan="4" style="text-align:center;vertical-align:middle;border:1.5px solid #475569;padding:2px 4px;background:#f0fdf4;font-weight:900;font-size:14px;color:#16a34a;'+borderTop+'">'+pDisp+'</td>';
        h+='<td rowspan="4" style="text-align:center;vertical-align:middle;border:1.5px solid #475569;padding:2px 4px;background:#faf5ff;font-weight:900;font-size:13px;color:#7c3aed;'+borderTop+'">'+(totalOT>0?_hrmsFmtOT(totalOT):isStaff?'—':'0')+'</td>';
        h+='<td rowspan="4" style="text-align:center;vertical-align:middle;border:1.5px solid #475569;padding:2px 4px;background:#fff7ed;font-weight:900;font-size:13px;color:#c2410c;'+borderTop+'">'+(totalOTS>0?_hrmsFmtOT(totalOTS):isStaff?'—':'0')+'</td>';
      }
      h+='</tr>';
    }
  });
  h+='</tbody></table>';
  grid.innerHTML=h;
}

// _hrmsParseTime is in hrms-logic.js
// _hrmsMinToTime is in hrms-logic.js
// _hrmsRoundIn is in hrms-logic.js
// _hrmsRoundOut is in hrms-logic.js

// Toggle state
var _hrmsAttAccounted=false;
function _hrmsAttToggleMode(){
  _hrmsAttAccounted=!_hrmsAttAccounted;
  var btn=document.getElementById('hrmsAttToggleBtn');
  if(btn){
    btn.textContent=_hrmsAttAccounted?'Accounted':'Actual';
    btn.style.background=_hrmsAttAccounted?'var(--accent)':'var(--accent-light)';
    btn.style.color=_hrmsAttAccounted?'#fff':'var(--accent)';
  }
  _hrmsAttRefresh();
}

function _hrmsAttDownloadTemplate(){
  var headers=['Emp Code','Date','Time IN','Time Out'];
  // Pre-fill with active employee codes and sample date
  var emps=(DB.hrmsEmployees||[]).filter(function(e){return e.status==='Active';});
  var today=new Date().toISOString().slice(0,10);
  var rows=emps.length?emps.map(function(e){return[e.empCode,today,'',''];}):[['' ,today,'','']];
  _downloadAsXlsx([headers].concat(rows),'Attendance Template','Attendance_Template.xlsx');
  notify('📄 Template downloaded with '+emps.length+' employees');
}

function _hrmsAttExportMonth(){
  if(!_hrmsHasAccess('action.exportAttendance')){notify('Access denied',true);return;}
  if(!_hrmsAttSelectedMonth){notify('No month selected',true);return;}
  var mk=_hrmsAttSelectedMonth;
  var p=mk.split('-');var yr=+p[0],mo=+p[1];
  var daysInMonth=new Date(yr,mo,0).getDate();
  var monthNames=['','January','February','March','April','May','June','July','August','September','October','November','December'];
  var attRecords=_hrmsAttCache[mk]||[];
  if(!attRecords.length){notify('No data to export',true);return;}
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e.name;});
  var altRecs=_hrmsAltCache[mk]||[];
  var altMap={};altRecs.forEach(function(a){altMap[a.empCode]=a.days||{};});
  var headers=['Emp Code','Employee Name','Date','Time IN','Time Out','Altered','Reason'];
  var rows=[];
  attRecords.sort(function(a,b){return(a.empCode||'').localeCompare(b.empCode||'');}).forEach(function(rec){
    var days=rec.days||{};
    var empAlt=altMap[rec.empCode]||{};
    for(var d=1;d<=daysInMonth;d++){
      var alt=_hrmsEffectiveAlt(empAlt[String(d)]||empAlt[d]||null);
      var dd=alt||days[String(d)]||days[d];
      if(!dd)continue;
      var dateStr=yr+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      rows.push([rec.empCode,empMap[rec.empCode]||'',dateStr,dd['in']||'',dd['out']||'',alt?'Yes':'',alt?(alt.reason||''):'']);
    }
  });
  _downloadAsXlsx([headers].concat(rows),'Attendance','Attendance_'+monthNames[mo]+'_'+yr+'.xlsx');
  notify('📤 Exported '+rows.length+' records');
}

function _hrmsAttExportSummary(){
  if(!_hrmsAttSelectedMonth){notify('No month selected',true);return;}
  var mk=_hrmsAttSelectedMonth;
  var p=mk.split('-');var yr=+p[0],mo=+p[1];
  var daysInMonth=new Date(yr,mo,0).getDate();
  var monthNames=['','January','February','March','April','May','June','July','August','September','October','November','December'];
  var attRecords=_hrmsAttCache[mk]||[];
  var altRecords=_hrmsAltCache[mk]||[];
  var lookup={};attRecords.forEach(function(a){lookup[a.empCode]=a.days||{};});
  var altLookup={};altRecords.forEach(function(a){altLookup[a.empCode]=a.days||{};});

  var _otR=_hrmsGetOtRules(mk);
  var FULL_DAY=_otR.fullDay,HALF_DAY=_otR.halfDay,EL_MIN=_otR.elMin,EL_MAX_PER_MONTH=_otR.elMaxPerMonth;
  var emps=(DB.hrmsEmployees||[]).filter(function(e){
    return lookup[e.empCode]||e.status==='Active';
  }).sort(function(a,b){
    var typeOrder={'on roll':0,'onroll':0,'contract':1,'piece rate':2,'piecerate':2};
    var catOrder={'staff':0,'worker':1,'security':2};
    var at=(a.employmentType||'').toLowerCase(),bt=(b.employmentType||'').toLowerCase();
    var t1=typeOrder[at]!==undefined?typeOrder[at]:9,t2=typeOrder[bt]!==undefined?typeOrder[bt]:9;
    if(t1!==t2) return t1-t2;
    var pp=(a.location||'').localeCompare(b.location||'');if(pp!==0) return pp;
    var ac=(a.category||'').toLowerCase(),bc=(b.category||'').toLowerCase();
    var c1=catOrder[ac]!==undefined?catOrder[ac]:9,c2=catOrder[bc]!==undefined?catOrder[bc]:9;
    if(c1!==c2) return c1-c2;
    return(a.teamName||'').localeCompare(b.teamName||'');
  });

  var headers=['Emp Code','Name','Type','Plant','Category','Team','Department','P','A','OT','OT@S'];
  var rows=[];
  emps.forEach(function(emp){
    var empAtt=lookup[emp.empCode]||{};
    var empAlt=altLookup[emp.empCode]||{};
    var isStaff=(emp.category||'').toLowerCase()==='staff'&&(emp.employmentType||'').toLowerCase()!=='contract';
    var totalP=0,totalA=0,totalOT=0,totalOTS=0;
    var elCount=0;
    // Calculate totals
    for(var dd=1;dd<=daysInMonth;dd++){
      var alt=_hrmsEffectiveAlt(empAlt[String(dd)]||null);
      var ddd=alt||empAtt[String(dd)]||{};
      var ti=ddd['in']||'',to2=ddd['out']||'';
      var dType=_hrmsGetDayType(mk,dd,yr,mo,emp.location);
      var isDayOff=dType==='WO'||dType==='PH';
      var worked=0;
      if(ti&&to2){
        var t1=_hrmsRoundIn(_hrmsParseTime(ti)),t2=_hrmsRoundOut(_hrmsParseTime(to2));
        if(t1!==null&&t2!==null){if(t2<t1)t2+=1440;worked=(t2-t1)/60;}
      }
      var hasTime=!!(ti||to2);
      if(isDayOff){
        // Off day OT
        if(worked>0&&!isStaff){
          var otS=worked;if(otS>_otR.otsTier2Threshold)otS-=_otR.otsTier2Deduct;else if(otS>=_otR.otsTier1Threshold)otS-=_otR.otsTier1Deduct;
          otS=Math.min(Math.max(otS,0),_otR.otsMaxPerDay);totalOTS+=otS;
        }
      } else {
        // Working day
        var status='';
        if(!hasTime){status='A';}
        else if(worked>=FULL_DAY){status='P';}
        else if(isStaff&&worked>=EL_MIN&&worked<FULL_DAY&&elCount<EL_MAX_PER_MONTH){status='EL';elCount++;}
        else if(worked>=HALF_DAY){status='P/2';}
        else{status='A';}
        if(status==='P'||status==='EL') totalP+=1;
        else if(status==='P/2') totalP+=0.5;
        if(status==='A') totalA+=1;
        else if(status==='P/2') totalA+=0.5;
        // Working day OT
        if(worked>0&&!isStaff){
          var ot=0;
          if(worked>_otR.otTier2Threshold) ot=worked-_otR.otTier2Subtract;else if(worked>=_otR.otTier1Threshold) ot=worked-_otR.otTier1Subtract;
          if(ot>0) totalOT+=Math.min(ot,_otR.otMaxPerDay);
        }
      }
    }
    var pDisp=totalP%1===0?totalP:+totalP.toFixed(1);
    var aDisp=totalA%1===0?totalA:+totalA.toFixed(1);
    rows.push([emp.empCode,emp.name,emp.employmentType||'',emp.location||'',emp.category||'',emp.teamName||'',emp.department||'',pDisp,aDisp,totalOT>0?Math.round(totalOT*4)/4:0,totalOTS>0?Math.round(totalOTS*4)/4:0]);
  });
  _downloadAsXlsx([headers].concat(rows),'Summary','Attendance_Summary_'+monthNames[mo]+'_'+yr+'.xlsx');
  notify('📊 Exported summary for '+emps.length+' employees');
}

// ═══ MAINTENANCE: Clean up zero-amount advance records ════════════════════
// Run from console: _hrmsCleanupZeroAdvances()
async function _hrmsCleanupZeroAdvances(){
  var all=DB.hrmsAdvances||[];
  var zeros=all.filter(function(a){return(!a.advance||a.advance===0)&&(!a.deduction||a.deduction===0)&&(!a.emi||a.emi===0);});
  console.log('Total advance records:',all.length);
  console.log('Zero-amount records:',zeros.length);
  console.log('Real records to keep:',all.length-zeros.length);
  if(!zeros.length){notify('No zero-amount advance records found');return;}
  if(!confirm('Delete '+zeros.length+' zero-amount advance record(s) from '+all.length+' total?\n\nThese were created as placeholders and are no longer needed. Real advance/deduction records will be kept.'))return;
  showSpinner('Deleting '+zeros.length+' records…');
  var deleted=0,failed=0;
  for(var i=0;i<zeros.length;i++){
    try{
      await _dbDel('hrmsAdvances',zeros[i].id);
      deleted++;
    }catch(e){failed++;console.warn('Delete failed:',zeros[i].id,e);}
  }
  DB.hrmsAdvances=all.filter(function(a){return!((!a.advance||a.advance===0)&&(!a.deduction||a.deduction===0)&&(!a.emi||a.emi===0));});
  _hrmsAdvCache={};
  hideSpinner();
  notify('✅ Cleanup complete — deleted '+deleted+(failed?', '+failed+' failed':''));
  console.log('Remaining advance records:',DB.hrmsAdvances.length);
}

// ═══ ESSL / ATTENDANCE IMPORT HISTORY ════════════════════════════════════

// Render import history in the ESSL Attendance panel
function _hrmsRenderEsslImportLog(){
  var el=document.getElementById('hrmsEsslImportLog');if(!el) return;
  var logRec=(DB.hrmsSettings||[]).find(function(r){return r.key==='attImportLog';});
  var imports=(logRec&&logRec.data&&logRec.data.imports)||[];
  imports=imports.filter(function(e){return(e.type||'essl')==='essl';});
  // Filter to the currently selected month only
  var mk=_hrmsMonth;
  if(mk) imports=imports.filter(function(e){return(e.monthKey||'')===mk;});
  var monthLabel=mk?_hrmsMonthLabel(mk):'';
  if(!imports.length){el.innerHTML='<div class="empty-state" style="padding:12px;font-size:12px">No imports for '+monthLabel+' yet. Upload a file to get started.</div>';return;}

  var _fmtBytes=function(n){if(!n) return '';if(n<1024) return n+' B';if(n<1048576) return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(2)+' MB';};
  var _fmtTime=function(iso){if(!iso) return '';var d=new Date(iso);if(isNaN(d.getTime())) return iso;return d.getDate()+'-'+_MON3[d.getMonth()+1]+'-'+String(d.getFullYear()).slice(-2)+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');};
  var _th='padding:6px 10px;font-size:11px;font-weight:800;background:#f1f5f9;border-bottom:1px solid var(--border);text-align:left';
  var _td='padding:6px 10px;font-size:12px;border-bottom:1px solid #f1f5f9';

  var h='<div style="font-size:13px;font-weight:900;color:var(--text);margin:14px 0 6px">📋 Import History — '+monthLabel+' ('+imports.length+')</div>';
  h+='<div style="border:1.5px solid var(--border);border-radius:8px;overflow:hidden">';
  h+='<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>';
  h+='<th style="'+_th+'">Date/Time</th>';
  h+='<th style="'+_th+'">File Name</th>';
  h+='<th style="'+_th+'">Month</th>';
  h+='<th style="'+_th+';text-align:right">Rows</th>';
  h+='<th style="'+_th+';text-align:right">Added</th>';
  h+='<th style="'+_th+';text-align:right">Updated</th>';
  h+='<th style="'+_th+'">Action</th>';
  h+='<th style="'+_th+'">By</th>';
  h+='<th style="'+_th+';text-align:center">File</th>';
  h+='<th style="'+_th+';text-align:center">Delete</th>';
  h+='</tr></thead><tbody>';
  imports.forEach(function(e){
    var actLbl=e.action==='merge'?'MERGE':(e.action==='replace'?'REPLACE':'NEW');
    var actBg=e.action==='replace'?'#fef3c7;color:#b45309':(e.action==='merge'?'#dbeafe;color:#1d4ed8':'#dcfce7;color:#15803d');
    var empCnt=(e.affectedEmps&&e.affectedEmps.length)||e.employees||0;
    h+='<tr>';
    h+='<td style="'+_td+';white-space:nowrap;font-family:var(--mono);font-size:11px">'+_fmtTime(e.timestamp)+'</td>';
    h+='<td style="'+_td+';font-weight:700" title="'+(e.fileName||'')+' ('+_fmtBytes(e.fileSize)+')">'+(e.fileName||'—')+'</td>';
    h+='<td style="'+_td+';font-family:var(--mono);font-size:11px">'+_hrmsShortMonth(e.monthKey||'')+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono)">'+(e.totalRows||0)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);color:#16a34a;font-weight:700">'+(e.added||0)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);color:#2563eb;font-weight:700">'+(e.updated||0)+'</td>';
    h+='<td style="'+_td+';font-size:11px"><span style="display:inline-block;padding:1px 6px;border-radius:3px;font-weight:700;background:'+actBg+'">'+actLbl+'</span></td>';
    h+='<td style="'+_td+';font-size:11px;color:var(--text2)">'+(e.importedBy||'—')+'</td>';
    h+='<td style="'+_td+';text-align:center"><button onclick="_hrmsDownloadEsslImport(\''+e.id+'\',\''+(e.fileName||'file').replace(/[\'"\\]/g,'')+'\')" title="Download original file" style="padding:3px 10px;font-size:11px;font-weight:700;background:#dbeafe;border:1px solid #93c5fd;color:#1d4ed8;border-radius:4px;cursor:pointer">⬇ Download</button></td>';
    h+='<td style="'+_td+';text-align:center"><button onclick="_hrmsDeleteEsslImport(\''+e.id+'\')" title="Delete attendance data imported by this file ('+empCnt+' employee(s))" style="padding:3px 10px;font-size:11px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer">🗑 Delete</button></td>';
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  el.innerHTML=h;
}

async function _hrmsDeleteEsslImport(logId){
  if(!_hrmsHasAccess('action.importEssl')){notify('Access denied',true);return;}
  var logRec=(DB.hrmsSettings||[]).find(function(r){return r.key==='attImportLog';});
  var imports=(logRec&&logRec.data&&logRec.data.imports)||[];
  var idx=imports.findIndex(function(e){return e.id===logId;});
  if(idx<0){notify('Import log entry not found',true);return;}
  var entry=imports[idx];
  var mk=entry.monthKey||'';
  if(mk&&typeof _hrmsIsMonthLocked==='function'&&_hrmsIsMonthLocked(mk)){
    notify('⚠ '+_hrmsMonthLabel(mk)+' is locked. Unlock to delete import.',true);return;
  }
  // Determine affected empCodes — prefer stored list; fall back to re-parsing the stored file
  var empCodes=(entry.affectedEmps||[]).slice();
  if(!empCodes.length){
    showSpinner('Loading file to determine affected employees…');
    try{
      var fileRec=(DB.hrmsSettings||[]).find(function(r){return r.key==='attImpFile_'+logId;});
      if(!fileRec&&_sb&&_sbReady){
        var {data}=await _sb.from('hrms_settings').select('*').eq('code','hs_attImpFile_'+logId).maybeSingle();
        if(data) fileRec=_fromRow('hrmsSettings',data);
      }
      if(fileRec&&fileRec.data&&fileRec.data.base64){
        var blob=_hrmsB642Blob(fileRec.data.base64);
        var buf=await blob.arrayBuffer();
        var rows=await _parseXLSX(buf);
        var _norm=function(k){return String(k||'').replace(/\([^)]*\)/g,'').replace(/[\s._\-\/]+/g,'').toLowerCase();};
        var hMap={};
        if(rows.length){Object.keys(rows[0]).forEach(function(k){var n=_norm(k);if(!hMap[n])hMap[n]=k;});}
        var codeKeys=['empcode','employeecode','code'];
        var codeKey=null;
        for(var i=0;i<codeKeys.length;i++){if(hMap[codeKeys[i]]){codeKey=hMap[codeKeys[i]];break;}}
        var seen={};
        rows.forEach(function(r){var c=((codeKey?r[codeKey]:'')||'').toString().trim();if(c&&!seen[c]){seen[c]=1;empCodes.push(c);}});
      }
    }catch(e){console.error(e);}
    hideSpinner();
  }
  if(!empCodes.length){
    if(!confirm('Could not determine which employees were affected by this import (file may have been pruned).\n\nDelete just the log entry without touching attendance data?')) return;
    // Fall through to just delete log + file
  } else {
    if(!confirm('Delete attendance data for '+empCodes.length+' employee(s) imported by "'+(entry.fileName||'this file')+'" ('+_hrmsMonthLabel(mk)+')?\n\nThis cannot be undone. Other employees\' data for the month will be kept.')) return;
  }

  showSpinner('Deleting imported attendance…');
  try{
    if(empCodes.length){
      await _hrmsAttFetchMonth(mk);
      var recs=_hrmsAttCache[mk]||[];
      var byCode={};recs.forEach(function(r){byCode[r.empCode]=r;});
      var removed=0;
      for(var i=0;i<empCodes.length;i++){
        var r=byCode[empCodes[i]];
        if(r&&await _dbDel('hrmsAttendance',r.id)){ removed++; }
      }
      _hrmsAttCache[mk]=(recs||[]).filter(function(r){return empCodes.indexOf(r.empCode)<0;});
    }
    // Remove log entry
    imports.splice(idx,1);
    await _dbSave('hrmsSettings',logRec);
    // Remove the stored file record
    var fileRecIdx=(DB.hrmsSettings||[]).findIndex(function(r){return r.key==='attImpFile_'+logId;});
    if(fileRecIdx>=0){
      var fRec=DB.hrmsSettings[fileRecIdx];
      await _dbDel('hrmsSettings',fRec.id);
      DB.hrmsSettings.splice(fileRecIdx,1);
    }
    hideSpinner();
    notify('🗑 Deleted attendance for '+empCodes.length+' employee(s) and removed import log entry');
    _hrmsRenderEsslImportLog();
    if(_hrmsAttCurrentTab) _hrmsAttSetTab(_hrmsAttCurrentTab);
  }catch(e){hideSpinner();notify('⚠ Delete failed: '+e.message,true);console.error(e);}
}

// Render alteration import history
function _hrmsRenderAltImportLog(){
  var el=document.getElementById('hrmsAltImportLog');if(!el) return;
  var logRec=(DB.hrmsSettings||[]).find(function(r){return r.key==='altImportLog';});
  var imports=(logRec&&logRec.data&&logRec.data.imports)||[];
  // Filter to the currently selected month only
  var mk=_hrmsMonth;
  if(mk) imports=imports.filter(function(e){return(e.monthKey||'')===mk;});
  var monthLabel=mk?_hrmsMonthLabel(mk):'';
  if(!imports.length){el.innerHTML='<div class="empty-state" style="padding:12px;font-size:12px">No alteration imports for '+monthLabel+' yet. Upload a file to get started.</div>';return;}

  var _fmtBytes=function(n){if(!n) return '';if(n<1024) return n+' B';if(n<1048576) return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(2)+' MB';};
  var _fmtTime=function(iso){if(!iso) return '';var d=new Date(iso);if(isNaN(d.getTime())) return iso;return d.getDate()+'-'+_MON3[d.getMonth()+1]+'-'+String(d.getFullYear()).slice(-2)+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');};
  var _th='padding:6px 10px;font-size:11px;font-weight:800;background:#f1f5f9;border-bottom:1px solid var(--border);text-align:left';
  var _td='padding:6px 10px;font-size:12px;border-bottom:1px solid #f1f5f9';

  var h='<div style="font-size:13px;font-weight:900;color:var(--text);margin:14px 0 6px">📋 Alteration Import History — '+monthLabel+' ('+imports.length+')</div>';
  h+='<div style="border:1.5px solid var(--border);border-radius:8px;overflow:hidden">';
  h+='<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>';
  h+='<th style="'+_th+'">Date/Time</th>';
  h+='<th style="'+_th+'">File Name</th>';
  h+='<th style="'+_th+'">Month</th>';
  h+='<th style="'+_th+';text-align:right">Rows</th>';
  h+='<th style="'+_th+';text-align:right">Alterations</th>';
  h+='<th style="'+_th+';text-align:right">Employees</th>';
  h+='<th style="'+_th+'">Action</th>';
  h+='<th style="'+_th+'">By</th>';
  h+='<th style="'+_th+';text-align:center">File</th>';
  h+='</tr></thead><tbody>';
  imports.forEach(function(e){
    h+='<tr>';
    h+='<td style="'+_td+';white-space:nowrap;font-family:var(--mono);font-size:11px">'+_fmtTime(e.timestamp)+'</td>';
    h+='<td style="'+_td+';font-weight:700" title="'+(e.fileName||'')+' ('+_fmtBytes(e.fileSize)+')">'+(e.fileName||'—')+'</td>';
    h+='<td style="'+_td+';font-family:var(--mono);font-size:11px">'+_hrmsShortMonth(e.monthKey||'')+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono)">'+(e.totalRows||0)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);color:#f59e0b;font-weight:700">'+(e.alterations||0)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);color:#2563eb;font-weight:700">'+(e.employees||0)+'</td>';
    h+='<td style="'+_td+';font-size:11px"><span style="display:inline-block;padding:1px 6px;border-radius:3px;font-weight:700;background:'+(e.action==='replace'?'#fef3c7;color:#b45309':'#dcfce7;color:#15803d')+'">'+(e.action==='replace'?'REPLACE':'NEW')+'</span></td>';
    h+='<td style="'+_td+';font-size:11px;color:var(--text2)">'+(e.importedBy||'—')+'</td>';
    h+='<td style="'+_td+';text-align:center"><button onclick="_hrmsDownloadAltImport(\''+e.id+'\',\''+(e.fileName||'file').replace(/[\'"\\]/g,'')+'\')" title="Download original file" style="padding:3px 10px;font-size:11px;font-weight:700;background:#dbeafe;border:1px solid #93c5fd;color:#1d4ed8;border-radius:4px;cursor:pointer">⬇ Download</button></td>';
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  el.innerHTML=h;
}

async function _hrmsDownloadAltImport(logId,fileName){
  var fileRec=(DB.hrmsSettings||[]).find(function(r){return r.key==='altImpFile_'+logId;});
  if(!fileRec&&_sb&&_sbReady){
    showSpinner('Fetching file…');
    try{
      var {data,error}=await _sb.from('hrms_settings').select('*').eq('code','hs_altImpFile_'+logId).maybeSingle();
      if(!error&&data) fileRec=_fromRow('hrmsSettings',data);
      if(fileRec){
        if(!DB.hrmsSettings) DB.hrmsSettings=[];
        DB.hrmsSettings.push(fileRec);
      }
    }catch(e){console.error(e);}
    hideSpinner();
  }
  if(!fileRec||!fileRec.data||!fileRec.data.base64){notify('⚠ File not found in database',true);return;}
  try{
    var blob=_hrmsB642Blob(fileRec.data.base64);
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');a.href=url;a.download=fileRec.data.fileName||fileName||'alteration_import.xlsx';
    document.body.appendChild(a);a.click();
    setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url);},100);
    notify('📥 Download started');
  }catch(e){notify('⚠ Download failed: '+e.message,true);}
}

// Render advance import history in the Advances panel — mirrors ESSL/Alt.
function _hrmsRenderAdvImportLog(){
  var el=document.getElementById('hrmsAdvImportLog');if(!el) return;
  var logRec=(DB.hrmsSettings||[]).find(function(r){return r.key==='advImportLog';});
  var imports=(logRec&&logRec.data&&logRec.data.imports)||[];
  var mk=_hrmsMonth;
  if(mk) imports=imports.filter(function(e){return(e.monthKey||'')===mk;});
  var monthLabel=mk?_hrmsMonthLabel(mk):'';
  if(!imports.length){el.innerHTML='<div class="empty-state" style="padding:12px;font-size:12px">No advance imports for '+monthLabel+' yet.</div>';return;}

  var _fmtBytes=function(n){if(!n) return '';if(n<1024) return n+' B';if(n<1048576) return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(2)+' MB';};
  var _fmtTime=function(iso){if(!iso) return '';var d=new Date(iso);if(isNaN(d.getTime())) return iso;return d.getDate()+'-'+_MON3[d.getMonth()+1]+'-'+String(d.getFullYear()).slice(-2)+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');};
  var _actionLabel=function(a){return a==='full-replace'?'FULL REPLACE':(a==='replace-matching'?'OVERWRITE MATCH':(a==='replace'?'REPLACE':'APPEND'));};
  var _actionBg=function(a){return a==='full-replace'?'#fef3c7;color:#b45309':(a==='replace-matching'?'#fef3c7;color:#b45309':'#dcfce7;color:#15803d');};
  var _th='padding:6px 10px;font-size:11px;font-weight:800;background:#f1f5f9;border-bottom:1px solid var(--border);text-align:left';
  var _td='padding:6px 10px;font-size:12px;border-bottom:1px solid #f1f5f9';
  var h='<div style="font-size:13px;font-weight:900;color:var(--text);margin:10px 0 6px">📋 Advance Import History — '+monthLabel+' ('+imports.length+')</div>';
  h+='<div style="border:1.5px solid var(--border);border-radius:8px;overflow:hidden">';
  h+='<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>';
  h+='<th style="'+_th+'">Date/Time</th>';
  h+='<th style="'+_th+'">File Name</th>';
  h+='<th style="'+_th+'">Month</th>';
  h+='<th style="'+_th+';text-align:right">Rows</th>';
  h+='<th style="'+_th+';text-align:right">Valid</th>';
  h+='<th style="'+_th+';text-align:right">Invalid</th>';
  h+='<th style="'+_th+';text-align:right">Added</th>';
  h+='<th style="'+_th+';text-align:right">Updated</th>';
  h+='<th style="'+_th+'">Action</th>';
  h+='<th style="'+_th+'">By</th>';
  h+='<th style="'+_th+';text-align:center">File</th>';
  h+='</tr></thead><tbody>';
  imports.forEach(function(e){
    h+='<tr>';
    h+='<td style="'+_td+';white-space:nowrap;font-family:var(--mono);font-size:11px">'+_fmtTime(e.timestamp)+'</td>';
    h+='<td style="'+_td+';font-weight:700" title="'+(e.fileName||'')+' ('+_fmtBytes(e.fileSize)+')">'+(e.fileName||'—')+'</td>';
    h+='<td style="'+_td+';font-family:var(--mono);font-size:11px">'+_hrmsShortMonth(e.monthKey||'')+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono)">'+(e.totalRows||0)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);color:#16a34a;font-weight:700">'+(e.valid||0)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);color:'+(e.invalid?'#dc2626':'var(--text3)')+';font-weight:700">'+(e.invalid||0)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);color:#16a34a;font-weight:700">'+(e.added||0)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);color:#2563eb;font-weight:700">'+(e.updated||0)+'</td>';
    h+='<td style="'+_td+';font-size:11px"><span style="display:inline-block;padding:1px 6px;border-radius:3px;font-weight:700;background:'+_actionBg(e.action)+'">'+_actionLabel(e.action)+'</span></td>';
    h+='<td style="'+_td+';font-size:11px;color:var(--text2)">'+(e.importedBy||'—')+'</td>';
    h+='<td style="'+_td+';text-align:center"><button onclick="_hrmsDownloadAdvImport(\''+e.id+'\',\''+(e.fileName||'file').replace(/[\'"\\]/g,'')+'\')" title="Download original file" style="padding:3px 10px;font-size:11px;font-weight:700;background:#dbeafe;border:1px solid #93c5fd;color:#1d4ed8;border-radius:4px;cursor:pointer">⬇ Download</button></td>';
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  el.innerHTML=h;
}

async function _hrmsDownloadAdvImport(logId,fileName){
  var fileRec=(DB.hrmsSettings||[]).find(function(r){return r.key==='advImpFile_'+logId;});
  if(!fileRec&&_sb&&_sbReady){
    showSpinner('Fetching file…');
    try{
      var {data,error}=await _sb.from('hrms_settings').select('*').eq('code','hs_advImpFile_'+logId).maybeSingle();
      if(!error&&data) fileRec=_fromRow('hrmsSettings',data);
      if(fileRec){
        if(!DB.hrmsSettings) DB.hrmsSettings=[];
        DB.hrmsSettings.push(fileRec);
      }
    }catch(e){console.error(e);}
    hideSpinner();
  }
  if(!fileRec||!fileRec.data||!fileRec.data.base64){notify('⚠ File not found in database',true);return;}
  try{
    var blob=_hrmsB642Blob(fileRec.data.base64);
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');a.href=url;a.download=fileRec.data.fileName||fileName||'advances_import.xlsx';
    document.body.appendChild(a);a.click();
    setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url);},100);
    notify('📥 Download started');
  }catch(e){notify('⚠ Download failed: '+e.message,true);}
}

async function _hrmsDownloadEsslImport(logId,fileName){
  // Find the file record
  var fileRec=(DB.hrmsSettings||[]).find(function(r){return r.key==='attImpFile_'+logId;});
  // If not in memory (not pre-loaded), fetch from Supabase
  if(!fileRec&&_sb&&_sbReady){
    showSpinner('Fetching file…');
    try{
      var {data,error}=await _sb.from('hrms_settings').select('*').eq('code','hs_attImpFile_'+logId).maybeSingle();
      if(!error&&data) fileRec=_fromRow('hrmsSettings',data);
      if(fileRec){
        if(!DB.hrmsSettings) DB.hrmsSettings=[];
        DB.hrmsSettings.push(fileRec);
      }
    }catch(e){console.error(e);}
    hideSpinner();
  }
  if(!fileRec||!fileRec.data||!fileRec.data.base64){notify('⚠ File not found in database',true);return;}
  try{
    var blob=_hrmsB642Blob(fileRec.data.base64);
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');a.href=url;a.download=fileRec.data.fileName||fileName||'attendance_import.xlsx';
    document.body.appendChild(a);a.click();
    setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url);},100);
    notify('📥 Download started');
  }catch(e){notify('⚠ Download failed: '+e.message,true);}
}

// ArrayBuffer → base64 (safe for large files)
function _hrmsAb2b64(buf){
  var bytes=new Uint8Array(buf),len=bytes.byteLength,bin='';
  for(var i=0;i<len;i++) bin+=String.fromCharCode(bytes[i]);
  return btoa(bin);
}
// base64 → Blob
function _hrmsB642Blob(b64,mime){
  var bin=atob(b64),bytes=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  return new Blob([bytes],{type:mime||'application/octet-stream'});
}

async function _hrmsImportAttendance(inputEl){
  if(!_hrmsHasAccess('action.importEssl')){notify('Access denied',true);return;}
  var file=inputEl.files[0];if(!file)return;inputEl.value='';
  if(_hrmsMonth&&_hrmsIsMonthLocked(_hrmsMonth)){notify('⚠ '+_hrmsMonthLabel(_hrmsMonth)+' is locked. Unlock to import.',true);return;}
  var _fileName=file.name,_fileSize=file.size;
  showSpinner('Importing attendance…');
  try{
    var reader=new FileReader();
    reader.onload=async function(ev){
      try{
        var _fileBuf=ev.target.result;
        var rows=await _parseXLSX(_fileBuf);
        console.log('Attendance Import: parsed '+rows.length+' rows');
        if(rows.length) console.log('Attendance Import: columns=',Object.keys(rows[0]));
        if(!rows.length){hideSpinner();notify('No data in file',true);return;}
        var _fd=function(v){
          var s=(v||'').toString().trim();if(!s)return'';
          if(s.match(/^\d{4}-\d{2}-\d{2}$/))return s;
          var m2=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
          if(m2) return m2[3]+'-'+m2[2].padStart(2,'0')+'-'+m2[1].padStart(2,'0');
          var d=new Date(s);return isNaN(d)?'':d.toISOString().slice(0,10);
        };
        var _ft=function(v){
          var s=(v||'').toString().trim();if(!s)return'';
          var n=parseFloat(s);
          if(!isNaN(n)&&n>=0&&n<1){
            var totalMin=Math.round(n*24*60);
            var hh=Math.floor(totalMin/60);
            var mm=totalMin%60;
            return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
          }
          if(s.match(/^\d{1,2}:\d{2}/)) return s.slice(0,5);
          return s;
        };
        // Validate: all rows must have valid dates and belong to a single month
        var importedMonths={};
        var badRows=[];
        var parsedRows=[];
        // Header lookup with normalization: strip whitespace, punctuation,
        // and anything in parentheses, case-insensitive. Lets the importer
        // accept e.g. "Date (DD/MM/YYYY)" and "Emp Code " alongside the
        // canonical "Date" / "Emp Code".
        var _norm=function(k){return String(k||'').replace(/\([^)]*\)/g,'').replace(/[\s._\-\/]+/g,'').toLowerCase();};
        var headerMap={};
        if(rows.length){
          Object.keys(rows[0]).forEach(function(k){var n=_norm(k);if(!headerMap[n]) headerMap[n]=k;});
        }
        var _getRow=function(r,keys){
          for(var i=0;i<keys.length;i++){
            var want=_norm(keys[i]);
            var actual=headerMap[want];
            if(actual&&r[actual]!==undefined&&r[actual]!=='') return r[actual];
          }
          return '';
        };
        for(var i=0;i<rows.length;i++){
          var r=rows[i];
          var empCode=(_getRow(r,['Emp Code','Employee Code','EmpCode','Code'])||'').toString().trim();
          if(!empCode)continue;
          var attDate=_fd(_getRow(r,['Date','Att Date','AttDate'])||'');
          if(!attDate){badRows.push('Row '+(i+2)+': Invalid or missing date for '+empCode);continue;}
          var dp=attDate.split('-');
          var monthKey=dp[0]+'-'+dp[1];
          importedMonths[monthKey]=true;
          parsedRows.push({empCode:empCode,attDate:attDate,monthKey:monthKey,day:+dp[2],r:r});
        }
        // Check: must be single month
        var monthKeys=Object.keys(importedMonths);
        if(monthKeys.length>1){
          hideSpinner();
          notify('⚠ File contains records from multiple months: '+monthKeys.join(', ')+'. Import only one month at a time.',true);
          return;
        }
        if(badRows.length){
          hideSpinner();
          notify('⚠ '+badRows.length+' row(s) have invalid dates:\n'+badRows.slice(0,5).join('\n'),true);
          return;
        }
        if(!parsedRows.length){hideSpinner();notify('No valid data rows found',true);return;}

        var mk=monthKeys[0];
        // Group by empCode → days. Use the same normalized header lookup
        // so "Time IN (HH:MM)" etc. still resolve.
        var grouped={};
        for(var i=0;i<parsedRows.length;i++){
          var pr=parsedRows[i];
          var timeIn=_ft(_getRow(pr.r,['Time IN','Time In','TimeIn','IN','In'])||'');
          var timeOut=_ft(_getRow(pr.r,['Time Out','TimeOut','Time OUT','OUT','Out'])||'');
          if(!grouped[pr.empCode]) grouped[pr.empCode]={};
          grouped[pr.empCode][String(pr.day)]={'in':timeIn,'out':timeOut};
        }

        // Load existing records for the month and build a by-code index.
        // Import is ALWAYS a merge: only employees present in the file are
        // touched, and within each such employee only the imported day-keys
        // overwrite existing ones. Other employees and other days are left
        // exactly as they were — preventing accidental full wipes when the
        // file only contains a small set of corrections.
        await _hrmsAttFetchMonth(mk);
        var existingRecords=_hrmsAttCache[mk]||[];
        var existingByCode={};
        existingRecords.forEach(function(r){existingByCode[r.empCode]=r;});

        // Compute impact for the confirm prompt.
        var impUpd=0,impAdd=0;
        for(var _ec in grouped){
          if(existingByCode[_ec]) impUpd++; else impAdd++;
        }
        var impKeep=existingRecords.length-impUpd;
        if(existingRecords.length>0){
          var msg='Attendance data exists for '+mk+':\n\n'+
                  '• '+impUpd+' employee(s) will be UPDATED (imported days overwrite same dates; other days kept)\n'+
                  '• '+impAdd+' new employee(s) will be ADDED\n'+
                  '• '+impKeep+' other employee(s) will remain UNCHANGED\n\n'+
                  'Proceed?';
          if(!confirm(msg)){hideSpinner();notify('Import cancelled');return;}
        }
        var action='merge';

        // Save / merge records
        var saved=0,errors=0,addedCount=0,updatedCount=0;
        for(var ec in grouped){
          var existing=existingByCode[ec];
          if(existing){
            existing.days=existing.days||{};
            Object.keys(grouped[ec]).forEach(function(dk){existing.days[dk]=grouped[ec][dk];});
            if(await _dbSave('hrmsAttendance',existing)){saved++;updatedCount++;} else errors++;
          } else {
            var rec={id:'ha'+uid(),empCode:ec,monthKey:mk,days:grouped[ec]};
            if(await _dbSave('hrmsAttendance',rec)){
              saved++;addedCount++;
              if(!_hrmsAttCache[mk]) _hrmsAttCache[mk]=[];
              _hrmsAttCache[mk].push(rec);
            } else errors++;
          }
        }

        // ── Save import log + file copy to DB ──
        try{
          var logId='impAtt_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
          var logEntry={
            id:logId,timestamp:new Date().toISOString(),
            type:'essl',fileName:_fileName,fileSize:_fileSize,
            monthKey:mk,action:action,
            totalRows:parsedRows.length,employees:saved,
            added:addedCount,updated:updatedCount,errors:errors,
            affectedEmps:Object.keys(grouped),
            importedBy:(CU?(CU.name||CU.id||''):'')
          };
          // Save metadata (small, fast to list)
          var logRec=(DB.hrmsSettings||[]).find(function(r){return r.key==='attImportLog';});
          if(!logRec){
            logRec={id:'hs_attImpLog',key:'attImportLog',data:{imports:[]}};
            if(!DB.hrmsSettings) DB.hrmsSettings=[];
            DB.hrmsSettings.push(logRec);
          }
          if(!logRec.data.imports) logRec.data.imports=[];
          logRec.data.imports.unshift(logEntry);
          // Keep only most recent 100 log entries in metadata
          if(logRec.data.imports.length>100) logRec.data.imports.length=100;
          await _dbSave('hrmsSettings',logRec);
          // Save file content separately
          var b64=_hrmsAb2b64(_fileBuf);
          var fileRec={id:'hs_attImpFile_'+logId,key:'attImpFile_'+logId,data:{fileName:_fileName,base64:b64}};
          if(!DB.hrmsSettings.find(function(r){return r.id===fileRec.id;})) DB.hrmsSettings.push(fileRec);
          await _dbSave('hrmsSettings',fileRec);
        }catch(logErr){console.warn('Import log save failed:',logErr);}

        hideSpinner();
        _hrmsAttMonthIndex=null;
        _hrmsAttSelectedMonth=mk;
        _hrmsMonth=mk;
        var ip=mk.split('-');
        var lblEl=document.getElementById('hrmsMonthLabel');if(lblEl) lblEl.textContent=_MONTH_NAMES[+ip[1]]+' '+ip[0];
        _hrmsAttPopFilters();
        _hrmsUpdateLockBtn();
        _hrmsAttSetTab(_hrmsAttCurrentTab);
        // Refresh the ESSL import history if visible
        if(typeof _hrmsRenderEsslImportLog==='function') _hrmsRenderEsslImportLog();
        notify('✅ Imported '+parsedRows.length+' rows: '+addedCount+' added, '+updatedCount+' updated'+(errors?', '+errors+' failed':''));
      }catch(ex){hideSpinner();notify('⚠ Import error: '+ex.message,true);console.error(ex);}
    };
    reader.readAsArrayBuffer(file);
  }catch(ex){hideSpinner();notify('⚠ '+ex.message,true);}
}

// ═══ PRINT FORMATS / PDF GENERATION ═════════════════════════════════════
// _hrmsGetPrintFormats is in hrms-logic.js

function _hrmsOpenPrintFormats(){
  _hrmsPrintFmtRenderList();
  om('mPrintFmt');
}

// Check if an employee's field value matches a print format's filter.
// filterVal may be: '' (all), 'single value', or 'v1,v2,v3' (multi).
function _hrmsFmtFieldMatch(filterVal,empVal){
  if(!filterVal) return true;// empty = all
  var list=filterVal.split(',').map(function(s){return s.trim();}).filter(Boolean);
  if(!list.length) return true;
  return list.indexOf((empVal||'').toString().trim())>=0;
}

// Get selected values from a multi-select
function _hrmsMultiGet(id){
  var el=document.getElementById(id);if(!el) return [];
  var sel=[];
  for(var i=0;i<el.options.length;i++){if(el.options[i].selected&&el.options[i].value) sel.push(el.options[i].value);}
  return sel;
}
// Set selected values on a multi-select (accepts array or comma-separated string or single value)
function _hrmsMultiSet(id,vals){
  var el=document.getElementById(id);if(!el) return;
  var arr=Array.isArray(vals)?vals:(typeof vals==='string'&&vals?vals.split(',').map(function(s){return s.trim();}).filter(Boolean):[]);
  var setMap={};arr.forEach(function(v){setMap[v]=1;});
  for(var i=0;i<el.options.length;i++) el.options[i].selected=!!setMap[el.options[i].value];
}

function _hrmsOpenPrintFmtEdit(id){
  _hrmsPrintFmtReset();
  _hrmsPrintFmtPopSelects();
  if(id){
    var f=(DB.hrmsPrintFormats||[]).find(function(r){return r.id===id;});
    if(f){
      document.getElementById('printFmtId').value=f.id;
      document.getElementById('printFmtName').value=f.name||'';
      _hrmsMultiSet('printFmtPlant',f.plant||'');
      _hrmsMultiSet('printFmtType',f.empType||'');
      _hrmsMultiSet('printFmtCat',f.category||'');
      _hrmsMultiSet('printFmtTeam',f.team||'');
      document.getElementById('printFmtFormTitle').textContent='Edit Format: '+(f.name||'');
    }
  } else {
    document.getElementById('printFmtFormTitle').textContent='Add New Format';
  }
  om('mPrintFmtEdit');
}

function _hrmsPrintFmtPopSelects(){
  var emps=DB.hrmsEmployees||[];
  var plants={},types={},cats={},teams={};
  emps.forEach(function(e){
    if(e.location)plants[e.location]=1;if(e.employmentType)types[e.employmentType]=1;
    if(e.category)cats[e.category]=1;if(e.teamName)teams[e.teamName]=1;
  });
  var _fill=function(id,obj){
    var el=document.getElementById(id);if(!el)return;
    // Preserve any currently selected values
    var prev=_hrmsMultiGet(id);
    var h='';
    Object.keys(obj).sort().forEach(function(k){h+='<option value="'+k+'">'+k+'</option>';});
    el.innerHTML=h;
    _hrmsMultiSet(id,prev);
  };
  _fill('printFmtPlant',plants);_fill('printFmtType',types);
  _fill('printFmtCat',cats);_fill('printFmtTeam',teams);
}

function _hrmsPrintFmtRenderList(){
  // Render to BOTH the modal list and the inline tab panel
  var elModal=document.getElementById('printFmtList');
  var elInline=document.getElementById('printFmtListInline');
  if(!elModal&&!elInline) return;
  var fmts=_hrmsGetPrintFormats().slice().sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});
  var _fmtList=function(s){if(!s) return '';return s.split(',').map(function(x){return x.trim();}).filter(Boolean).join(', ');};
  var _build=function(cbClass){
    if(!fmts.length) return '<div class="empty-state" style="padding:16px">No print formats saved. Click "+ Add New Format" to create one.</div>';
    var h='<div style="max-height:calc(100vh - 320px);overflow-y:auto">';
    fmts.forEach(function(f){
      var desc=[];
      var pStr=_fmtList(f.plant);if(pStr) desc.push('Plant: '+pStr);
      var tStr=_fmtList(f.empType);if(tStr) desc.push('Type: '+tStr);
      var cStr=_fmtList(f.category);if(cStr) desc.push('Cat: '+cStr);
      var teamStr=_fmtList(f.team);if(teamStr) desc.push('Team: '+teamStr);
      if(!desc.length) desc.push('All employees');
      h+='<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;margin-bottom:6px;background:var(--surface2)">';
      h+='<input type="checkbox" class="'+cbClass+'" value="'+f.id+'" checked style="width:auto;flex-shrink:0">';
      h+='<div style="flex:1"><div style="font-weight:800;font-size:13px">'+f.name+'</div>';
      h+='<div style="font-size:11px;color:var(--text3)">'+desc.join(' · ')+'</div></div>';
      h+='<button onclick="_hrmsPrintWithFormat(\''+f.id+'\')" style="padding:5px 12px;font-size:11px;font-weight:700;background:var(--accent);color:#fff;border:none;border-radius:5px;cursor:pointer">🖨</button>';
      h+='<button onclick="_hrmsOpenPrintFmtEdit(\''+f.id+'\')" style="padding:5px 8px;font-size:11px;font-weight:700;background:#fef3c7;border:1px solid #fde047;color:#a16207;border-radius:4px;cursor:pointer">✏️</button>';
      h+='<button onclick="_hrmsDelPrintFmt(\''+f.id+'\')" style="padding:5px 8px;font-size:11px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer">🗑</button>';
      h+='</div>';
    });
    h+='</div>';
    return h;
  };
  if(elModal) elModal.innerHTML=_build('printFmtCb');
  if(elInline) elInline.innerHTML=_build('printFmtCbInline');
}

function _hrmsPrintFmtToggleAll(checked){
  document.querySelectorAll('.printFmtCb').forEach(function(cb){cb.checked=checked;});
}
function _hrmsPrintFmtToggleAllInline(checked){
  document.querySelectorAll('.printFmtCbInline').forEach(function(cb){cb.checked=checked;});
}
async function _hrmsBulkPrintInline(){
  // Sync inline checkbox selection to modal checkboxes, then reuse existing bulk logic
  var ids=[];
  document.querySelectorAll('.printFmtCbInline:checked').forEach(function(cb){ids.push(cb.value);});
  // Create temp .printFmtCb so _hrmsBulkPrint can find them
  var temp=document.createElement('div');temp.id='_hrmsTempPrintCbs';temp.style.display='none';
  ids.forEach(function(id){var cb=document.createElement('input');cb.type='checkbox';cb.className='printFmtCb';cb.value=id;cb.checked=true;temp.appendChild(cb);});
  document.body.appendChild(temp);
  try{await _hrmsBulkPrint();}
  finally{var t=document.getElementById('_hrmsTempPrintCbs');if(t) t.remove();}
}

function _hrmsPrintFmtReset(){
  document.getElementById('printFmtId').value='';
  document.getElementById('printFmtName').value='';
  ['printFmtPlant','printFmtType','printFmtCat','printFmtTeam'].forEach(function(id){
    var el=document.getElementById(id);if(el) for(var i=0;i<el.options.length;i++) el.options[i].selected=false;
  });
  document.getElementById('printFmtFormTitle').textContent='Add New Format';
}

// ===== PDF GENERATION (jsPDF + AutoTable) =====
function _hrmsGeneratePdf(f,mk,yr,mo,monthNames){
  var daysInMonth=new Date(yr,mo,0).getDate();
  var dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var attRecords=_hrmsAttCache[mk]||[];var altRecords=_hrmsAltCache[mk]||[];
  var lookup={};attRecords.forEach(function(a){lookup[a.empCode]=a.days||{};});
  var altLookup={};altRecords.forEach(function(a){altLookup[a.empCode]=a.days||{};});
  // Only include employees who actually show up in the month: at least one
  // day with a punch, any alteration, or a non-zero manual P/PL/OT/OTS.
  // An empty attendance row (placeholder after "Add Month") does NOT count.
  var _hasActivity=function(e){
    var days=lookup[e.empCode];
    if(days){for(var k in days){var d=days[k];if(d&&(d['in']||d['out'])) return true;}}
    var aDays=altLookup[e.empCode];
    if(aDays&&Object.keys(aDays).length) return true;
    var ex=e.extra||{};
    if(ex.manualP&&+ex.manualP[mk]>0) return true;
    if(ex.manualPL&&+ex.manualPL[mk]>0) return true;
    if(ex.manualOT&&+ex.manualOT[mk]>0) return true;
    if(ex.manualOTS&&+ex.manualOTS[mk]>0) return true;
    return false;
  };
  var emps=(DB.hrmsEmployees||[]).filter(function(e){
    if(!_hasActivity(e)) return false;
    if(!_hrmsFmtFieldMatch(f.plant,e.location)) return false;
    if(!_hrmsFmtFieldMatch(f.empType,e.employmentType)) return false;
    if(!_hrmsFmtFieldMatch(f.category,e.category)) return false;
    if(!_hrmsFmtFieldMatch(f.team,e.teamName)) return false;
    return true;
  }).sort(function(a,b){
    var typeOrder={'on roll':0,'onroll':0,'contract':1,'piece rate':2,'piecerate':2};
    var catOrder={'staff':0,'worker':1,'security':2};
    var at=(a.employmentType||'').toLowerCase(),bt=(b.employmentType||'').toLowerCase();
    var t1=typeOrder[at]!==undefined?typeOrder[at]:9,t2=typeOrder[bt]!==undefined?typeOrder[bt]:9;
    if(t1!==t2) return t1-t2;
    var pp=(a.location||'').localeCompare(b.location||'');if(pp!==0) return pp;
    var ac=(a.category||'').toLowerCase(),bc=(b.category||'').toLowerCase();
    var c1=catOrder[ac]!==undefined?catOrder[ac]:9,c2=catOrder[bc]!==undefined?catOrder[bc]:9;
    if(c1!==c2) return c1-c2;
    return(a.teamName||'').localeCompare(b.teamName||'');
  });
  if(!emps.length) return null;

  var _otR=_hrmsGetOtRules(mk);
  var FULL_DAY=_otR.fullDay,HALF_DAY=_otR.halfDay,EL_MIN=_otR.elMin,EL_MAX_PER_MONTH=_otR.elMaxPerMonth;
  // A3 landscape: 420x297mm, margin 14mm (~50px)
  var doc=new jspdf.jsPDF({orientation:'landscape',unit:'mm',format:'a3',putOnlyUsedFonts:true,compress:false});
  var pageW=420,pageH=297,margin=14;

  // Column definitions: #, Plt, Code, Name, Row, days..., P, OT, OT@S
  var fixedW=pageW-margin*2;
  var nDays=daysInMonth;
  // Widened serial column to fit 3-digit row numbers (e.g. "999") at the
  // larger fontSize used below. OT / OT@S columns widened separately so
  // multi-digit totals (e.g. "120.75") fit on one line at fontSize 10.
  var colSr=9,colPlt=8,colCode=12,colName=18,colRow=8,colTotP=10,colTotOT=14;
  var fixedCols=colSr+colPlt+colCode+colName+colRow+colTotP+colTotOT*2;
  var colDay=Math.max(6,(fixedW-fixedCols)/nDays);
  // Recalculate name column to use remaining space
  var usedByDays=colDay*nDays;
  colName=fixedW-colSr-colPlt-colCode-colRow-colTotP-colTotOT*2-usedByDays;
  if(colName<14) colName=14;

  var colWidths=[colSr,colPlt,colCode,colName,colRow];
  for(var d=0;d<nDays;d++) colWidths.push(colDay);
  colWidths.push(colTotP,colTotOT,colTotOT);

  // Colors
  var cGreen=[22,163,74],cRed=[220,38,38],cPurple=[124,58,237],cOrange=[194,65,12],cBlue=[29,78,216];
  var cAmber=[180,83,9],cGrey=[148,163,184];
  var bgOff=[254,242,242],bgEL=[191,219,254],bgAlt=[249,168,212],bgOTS=[243,232,255];
  var bgDtW=[254,243,199],bgDtH=[219,234,254],bgDtP=[220,252,231];
  var bgTotP=[240,253,244],bgTotOT=[250,245,255],bgTotOTS=[255,247,237];
  var bgHdr=[240,249,255];

  // Build header rows
  var head=[];
  // Row 1: column headers
  var hdr1=[{content:'#',styles:{halign:'center'}},{content:'Plt',styles:{halign:'center'}},{content:'Code',styles:{halign:'center'}},{content:'Name',styles:{halign:'left'}},{content:'Row',styles:{halign:'center'}}];
  for(var d=1;d<=nDays;d++){
    var dt2=new Date(yr,mo-1,d);
    var isSun=dt2.getDay()===0;
    hdr1.push({content:dayNames[dt2.getDay()]+'\n'+d,styles:{halign:'center',fillColor:isSun?bgOff:bgHdr,fontSize:9}});
  }
  hdr1.push({content:'P',styles:{halign:'center',fillColor:bgTotP,textColor:cGreen,fontStyle:'bold'}});
  hdr1.push({content:'OT',styles:{halign:'center',fillColor:bgTotOT,textColor:cPurple,fontStyle:'bold'}});
  hdr1.push({content:'OT@S',styles:{halign:'center',fillColor:bgTotOTS,textColor:cOrange,fontStyle:'bold'}});
  head.push(hdr1);

  // Build body rows
  var body=[];
  var rowBgs=[[239,246,255],[240,253,244],[254,252,232],[250,245,255]];
  var rowLabels=['In','Out','P/A','OT'];

  emps.forEach(function(emp,ei){
    var empAtt=lookup[emp.empCode]||{};var empAlt=altLookup[emp.empCode]||{};
    var isStaff=(emp.category||'').toLowerCase()==='staff'&&(emp.employmentType||'').toLowerCase()!=='contract';
    var plt=(emp.location||'').replace(/plant[\s\-]*/i,'P').replace(/^(.{4}).*$/,'$1');
    var pClr=_hrmsGetPlantColor(emp.location);
    var pClrRgb=_hexToRgb(pClr);

    // Compute day statuses
    var dayStatus=[];var elCount=0;
    for(var dd=1;dd<=daysInMonth;dd++){
      var alt=_hrmsEffectiveAlt(empAlt[String(dd)]||null);var ddd=alt||empAtt[String(dd)]||{};
      var ti=ddd['in']||'',to2=ddd['out']||'';
      var dType=_hrmsGetDayType(mk,dd,yr,mo,emp.location);var isDayOff=dType==='WO'||dType==='PH';var worked=0;
      var isNight=false;
      if(ti&&to2){var t1=_hrmsRoundIn(_hrmsParseTime(ti)),t2=_hrmsRoundOut(_hrmsParseTime(to2));if(t1!==null&&t2!==null){if(t2<t1){isNight=true;t2+=1440;}worked=(t2-t1)/60;}}
      var hasTime=!!(ti||to2);var status='';
      if(isDayOff){status=hasTime?'P':'H';}else if(!hasTime){status='A';}else if(worked>=FULL_DAY){status='P';}
      else if(isStaff&&worked>=EL_MIN&&worked<FULL_DAY&&elCount<EL_MAX_PER_MONTH){status='EL';elCount++;}
      else if(worked>=HALF_DAY){status='P/2';}else{status='A';}
      dayStatus[dd]={worked:worked,status:status,isOff:isDayOff,altered:!!alt,isNight:isNight};
    }
    var totalP=0,totalOT=0,totalOTS=0;
    for(var dd=1;dd<=daysInMonth;dd++){
      var ds=dayStatus[dd];
      if(!ds.isOff){if(ds.status==='P'||ds.status==='EL')totalP+=1;else if(ds.status==='P/2')totalP+=0.5;}
      if(ds.worked>0&&!isStaff){
        if(ds.isOff){var otS=ds.worked;if(otS>_otR.otsTier2Threshold)otS-=_otR.otsTier2Deduct;else if(otS>=_otR.otsTier1Threshold)otS-=_otR.otsTier1Deduct;otS=Math.min(Math.max(otS,0),_otR.otsMaxPerDay);totalOTS+=otS;ds.otS=otS;}
        else{var ot=0;if(ds.worked>_otR.otTier2Threshold)ot=ds.worked-_otR.otTier2Subtract;else if(ds.worked>=_otR.otTier1Threshold)ot=ds.worked-_otR.otTier1Subtract;if(ot>0){ot=Math.min(ot,_otR.otMaxPerDay);totalOT+=ot;}ds.ot=ot;}
      }
    }

    for(var ri=0;ri<4;ri++){
      var row=[];
      if(ri===0){
        row.push({content:String(ei+1),rowSpan:4,styles:{halign:'center',valign:'middle',fontStyle:'bold',fontSize:10}});
        row.push({content:plt,rowSpan:4,styles:{halign:'center',valign:'middle',fontStyle:'bold',fillColor:pClrRgb,fontSize:10}});
        // Code fontSize intentionally left at 10 — user asked to keep it unchanged.
        row.push({content:emp.empCode,rowSpan:4,styles:{halign:'center',valign:'middle',fontStyle:'bold',fontSize:10}});
        row.push({content:_hrmsDispName(emp),rowSpan:4,styles:{halign:'left',valign:'middle',fontStyle:'bold',fontSize:9,cellWidth:colName}});
      }
      row.push({content:rowLabels[ri],styles:{halign:'center',fontStyle:'bold',fillColor:rowBgs[ri],fontSize:9}});

      for(var d=1;d<=daysInMonth;d++){
        var ds=dayStatus[d];
        var alt=_hrmsEffectiveAlt(empAlt[String(d)]||null);var ddd=alt||empAtt[String(d)]||{};
        var tIn=ddd['in']||'',tOut=ddd['out']||'';
        // Display ACTUAL punch times (just normalize format HH:MM); rounding is only used for hour calculations
        if(tIn){var pm=_hrmsParseTime(tIn);if(pm!==null) tIn=_hrmsMinToTime(pm);}
        if(tOut){var pm2=_hrmsParseTime(tOut);if(pm2!==null) tOut=_hrmsMinToTime(pm2);}
        var cellStyle={halign:'center',fillColor:rowBgs[ri],fontSize:9};
        if(ds.isOff) cellStyle.fillColor=bgOff;
        if(ds.altered&&(ri===0||ri===1)) cellStyle.fillColor=bgAlt;
        // Red background for missing in or out
        var rawIn=ddd['in']||'',rawOut=ddd['out']||'';
        var isMissing=!ds.isOff&&((!!rawIn&&!rawOut)||(!!rawOut&&!rawIn));
        if(isMissing&&ri===0&&!rawIn) cellStyle.fillColor=[239,68,68];
        if(isMissing&&ri===1&&!rawOut) cellStyle.fillColor=[239,68,68];
        if(ds.isNight&&(ri===0||ri===1)) cellStyle.fontStyle='bold';
        var val='';
        if(ri===0) val=tIn;
        else if(ri===1) val=tOut;
        else if(ri===2){
          var st=ds.status;
          if(st==='P'){val='P';cellStyle.textColor=cGreen;cellStyle.fontStyle='bold';}
          else if(st==='P/2'){val='P/2';cellStyle.textColor=cAmber;cellStyle.fontStyle='bold';}
          else if(st==='EL'){val='EL';cellStyle.textColor=cBlue;cellStyle.fontStyle='bold';cellStyle.fillColor=bgEL;}
          else if(st==='A'){val='A';cellStyle.textColor=cRed;cellStyle.fontStyle='bold';}
          else if(st==='H'){val='H';cellStyle.textColor=cGrey;}
        } else if(ri===3){
          if(!isStaff&&ds.worked>0){
            if(ds.isOff&&ds.otS>0){val=_hrmsFmtOT(ds.otS);cellStyle.textColor=[255,255,255];cellStyle.fontStyle='bold';cellStyle.fillColor=[124,58,237];}
            else if(!ds.isOff&&ds.ot>0){val=_hrmsFmtOT(ds.ot);cellStyle.textColor=cPurple;}
          }
        }
        row.push({content:val,styles:cellStyle});
      }
      if(ri===0){
        var pDisp=totalP%1===0?String(totalP):totalP.toFixed(1);
        row.push({content:pDisp,rowSpan:4,styles:{halign:'center',valign:'middle',fontStyle:'bold',fillColor:bgTotP,textColor:cGreen,fontSize:10}});
        row.push({content:totalOT>0?_hrmsFmtOT(totalOT):(isStaff?'-':'0'),rowSpan:4,styles:{halign:'center',valign:'middle',fontStyle:'bold',fillColor:bgTotOT,textColor:cPurple,fontSize:10}});
        row.push({content:totalOTS>0?_hrmsFmtOT(totalOTS):(isStaff?'-':'0'),rowSpan:4,styles:{halign:'center',valign:'middle',fontStyle:'bold',fillColor:bgTotOTS,textColor:cOrange,fontSize:10}});
      }
      body.push(row);
    }
  });

  doc.autoTable({
    head:head,
    body:body,
    startY:margin+8,
    margin:{left:margin,right:margin,top:margin+8,bottom:margin+5},
    styles:{fontSize:9,cellPadding:1,lineWidth:0.2,lineColor:[71,85,105],overflow:'linebreak',halign:'center',font:'helvetica'},
    headStyles:{fillColor:bgHdr,textColor:[30,41,59],fontStyle:'bold',fontSize:9,lineWidth:0.3},
    columnStyles:_hrmsColStyles(colWidths),
    showHead:'everyPage',
    didDrawPage:function(data){
      var pg=doc.internal.getCurrentPageInfo().pageNumber;
      doc.setFontSize(9);doc.setFont('helvetica','bold');doc.setTextColor(0);
      doc.text(f.name+' - '+monthNames[mo]+' '+yr,margin,margin+4);
      doc.setFontSize(7);doc.setFont('helvetica','normal');doc.setTextColor(120);
      doc.text('Page '+pg,pageW-margin-12,pageH-margin+2);
      doc.setTextColor(0);
    }
  });

  return doc;
}

// _hrmsColStyles is in hrms-logic.js

// _hexToRgb is in hrms-logic.js

async function _hrmsBulkPrint(){
  var selected=[...document.querySelectorAll('.printFmtCb:checked')].map(function(cb){return cb.value;});
  if(!selected.length){notify('Select at least one format',true);return;}
  if(!_hrmsAttSelectedMonth){notify('No month selected',true);return;}
  var mk=_hrmsAttSelectedMonth;
  var p=mk.split('-');var yr=+p[0],mo=+p[1];
  var monthNames=['','January','February','March','April','May','June','July','August','September','October','November','December'];
  var fmts=_hrmsGetPrintFormats();

  // Ask for folder
  var folderHandle=null;
  if(window.showDirectoryPicker){
    try{folderHandle=await window.showDirectoryPicker({mode:'readwrite'});}
    catch(e){if(e.name==='AbortError')return;}
  }

  cm('mPrintFmt');
  showSpinner('Generating PDFs…');
  var saved=0;

  for(var si=0;si<selected.length;si++){
    var f=byId(fmts,selected[si]);if(!f)continue;
    var doc=_hrmsGeneratePdf(f,mk,yr,mo,monthNames);
    if(!doc)continue;
    var safeName=(f.name||'Format').replace(/[^a-zA-Z0-9\-_ ]/g,'');
    // Suffix: _MMYY (e.g. _0426 for April 2026)
    var monthSuffix='_'+String(mo).padStart(2,'0')+String(yr).slice(-2);
    var filename=safeName+monthSuffix+'.pdf';

    if(folderHandle){
      try{
        var blob=doc.output('blob');
        var fh=await folderHandle.getFileHandle(filename,{create:true});
        var wr=await fh.createWritable();
        await wr.write(blob);await wr.close();saved++;
      }catch(e){console.error('Error saving '+filename,e);}
    } else {
      doc.save(filename);saved++;
    }
  }
  hideSpinner();
  notify('✅ '+saved+' PDF(s) saved'+(folderHandle?' to folder':''));
}

async function _hrmsSavePrintFmt(){
  var editId=document.getElementById('printFmtId').value;
  var name=document.getElementById('printFmtName').value.trim();
  if(!name){notify('Format name is required',true);return;}
  // Multi-select values joined as comma-separated string (empty = all)
  var plantVal=_hrmsMultiGet('printFmtPlant').join(',');
  var typeVal=_hrmsMultiGet('printFmtType').join(',');
  var catVal=_hrmsMultiGet('printFmtCat').join(',');
  var teamVal=_hrmsMultiGet('printFmtTeam').join(',');
  if(editId){
    var existing=byId(DB.hrmsPrintFormats||[],editId);
    if(existing){
      existing.name=name;
      existing.plant=plantVal;
      existing.empType=typeVal;
      existing.category=catVal;
      existing.team=teamVal;
      await _dbSave('hrmsPrintFormats',existing);
    }
  } else {
    var rec={id:'hpf'+uid(),name:name,plant:plantVal,empType:typeVal,category:catVal,team:teamVal,createdBy:CU?CU.id:''};
    await _dbSave('hrmsPrintFormats',rec);
  }
  _hrmsPrintFmtReset();
  cm('mPrintFmtEdit');
  _hrmsPrintFmtRenderList();
  notify('✅ Format saved');
}

// Kept for backward compatibility — routes to the new edit modal
function _hrmsEditPrintFmt(id){_hrmsOpenPrintFmtEdit(id);}

async function _hrmsDelPrintFmt(id){
  if(!confirm('Delete this print format?'))return;
  await _dbDel('hrmsPrintFormats',id);
  _hrmsPrintFmtRenderList();
  notify('Format deleted');
}

function _hrmsGeneratePrintHTML(f,mk,yr,mo,monthNames){
  var daysInMonth=new Date(yr,mo,0).getDate();
  var dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var attRecords=_hrmsAttCache[mk]||[];
  var altRecords=_hrmsAltCache[mk]||[];
  var lookup={};attRecords.forEach(function(a){lookup[a.empCode]=a.days||{};});
  var altLookup={};altRecords.forEach(function(a){altLookup[a.empCode]=a.days||{};});
  var emps=(DB.hrmsEmployees||[]).filter(function(e){
    if(!lookup[e.empCode]&&e.status!=='Active') return false;
    if(!_hrmsFmtFieldMatch(f.plant,e.location)) return false;
    if(!_hrmsFmtFieldMatch(f.empType,e.employmentType)) return false;
    if(!_hrmsFmtFieldMatch(f.category,e.category)) return false;
    if(!_hrmsFmtFieldMatch(f.team,e.teamName)) return false;
    return true;
  }).sort(function(a,b){
    var typeOrder={'on roll':0,'onroll':0,'contract':1,'piece rate':2,'piecerate':2};
    var catOrder={'staff':0,'worker':1,'security':2};
    var at=(a.employmentType||'').toLowerCase(),bt=(b.employmentType||'').toLowerCase();
    var t1=typeOrder[at]!==undefined?typeOrder[at]:9,t2=typeOrder[bt]!==undefined?typeOrder[bt]:9;
    if(t1!==t2) return t1-t2;
    var pp=((a.location||'').localeCompare(b.location||''));if(pp!==0) return pp;
    var ac=(a.category||'').toLowerCase(),bc=(b.category||'').toLowerCase();
    var c1=catOrder[ac]!==undefined?catOrder[ac]:9,c2=catOrder[bc]!==undefined?catOrder[bc]:9;
    if(c1!==c2) return c1-c2;
    return(a.teamName||'').localeCompare(b.teamName||'');
  });
  if(!emps.length) return'<h2>'+f.name+'</h2><p style="color:#999">No employees match this format.</p>';
  var _otR=_hrmsGetOtRules(mk);
  var FULL_DAY=_otR.fullDay,HALF_DAY=_otR.halfDay,EL_MIN=_otR.elMin,EL_MAX_PER_MONTH=_otR.elMaxPerMonth;
  var dtCls={WD:'dt-w',WO:'dt-h',PH:'dt-p'};
  var h='<h2>'+f.name+'</h2><h3>'+monthNames[mo]+' '+yr+' &mdash; '+emps.length+' employees</h3>';
  h+='<table><thead><tr>';
  h+='<th class="sr">#</th><th class="plt">Plt</th><th class="code">Code</th><th class="name">Name</th><th class="row">Row</th>';
  for(var d=1;d<=daysInMonth;d++){
    var dt2=new Date(yr,mo-1,d);
    var isSun=dt2.getDay()===0;
    h+='<th class="day'+(isSun?' off':'')+'">'+dayNames[dt2.getDay()]+'<br>'+d+'</th>';
  }
  h+='<th class="tot">P</th><th class="tot">OT</th><th class="tot">OT@S</th></tr>';
  h+='</thead><tbody>';

  var rowLabels=['In','Out','P/A','OT'];
  var rowBg=['#eff6ff','#f0fdf4','#fefce8','#faf5ff'];
  emps.forEach(function(emp,ei){
    var empAtt=lookup[emp.empCode]||{};var empAlt=altLookup[emp.empCode]||{};
    var isStaff=(emp.category||'').toLowerCase()==='staff'&&(emp.employmentType||'').toLowerCase()!=='contract';
    var plt=(emp.location||'').replace(/plant[\s\-]*/i,'P').replace(/^(.{4}).*$/,'$1');
    var pClr=_hrmsGetPlantColor(emp.location);
    var dayStatus=[];var elCount=0;
    for(var dd=1;dd<=daysInMonth;dd++){
      var alt=_hrmsEffectiveAlt(empAlt[String(dd)]||null);var ddd=alt||empAtt[String(dd)]||{};
      var ti=ddd['in']||'',to2=ddd['out']||'';
      var dType=_hrmsGetDayType(mk,dd,yr,mo,emp.location);var isDayOff=dType==='WO'||dType==='PH';var worked=0;
      var isNight=false;
      if(ti&&to2){var t1=_hrmsRoundIn(_hrmsParseTime(ti)),t2=_hrmsRoundOut(_hrmsParseTime(to2));if(t1!==null&&t2!==null){if(t2<t1){isNight=true;t2+=1440;}worked=(t2-t1)/60;}}
      var hasTime=!!(ti||to2);var status='';
      if(isDayOff){status=hasTime?'P':'H';}else if(!hasTime){status='A';}else if(worked>=FULL_DAY){status='P';}
      else if(isStaff&&worked>=EL_MIN&&worked<FULL_DAY&&elCount<EL_MAX_PER_MONTH){status='EL';elCount++;}
      else if(worked>=HALF_DAY){status='P/2';}else{status='A';}
      dayStatus[dd]={worked:worked,status:status,isOff:isDayOff,altered:!!alt,isNight:isNight};
    }
    var totalP=0,totalOT=0,totalOTS=0;
    for(var dd=1;dd<=daysInMonth;dd++){
      var ds=dayStatus[dd];
      if(!ds.isOff){if(ds.status==='P'||ds.status==='EL')totalP+=1;else if(ds.status==='P/2')totalP+=0.5;}
      if(ds.worked>0&&!isStaff){
        if(ds.isOff){var otS=ds.worked;if(otS>_otR.otsTier2Threshold)otS-=_otR.otsTier2Deduct;else if(otS>=_otR.otsTier1Threshold)otS-=_otR.otsTier1Deduct;otS=Math.min(Math.max(otS,0),_otR.otsMaxPerDay);totalOTS+=otS;ds.otS=otS;}
        else{var ot=0;if(ds.worked>_otR.otTier2Threshold)ot=ds.worked-_otR.otTier2Subtract;else if(ds.worked>=_otR.otTier1Threshold)ot=ds.worked-_otR.otTier1Subtract;if(ot>0){ot=Math.min(ot,_otR.otMaxPerDay);totalOT+=ot;}ds.ot=ot;}
      }
    }
    for(var ri=0;ri<4;ri++){
      var trCls=ri===0?' class="sep"':(ri===3?'':' class="faint-t faint-b"');
      h+='<tr'+trCls+' style="background:'+rowBg[ri]+'">';
      if(ri===0){
        h+='<td rowspan="4" class="sep" style="font-weight:bold">'+(ei+1)+'</td>';
        h+='<td rowspan="4" class="sep" style="background:'+pClr+'">'+plt+'</td>';
        h+='<td rowspan="4" class="sep" style="font-weight:bold">'+emp.empCode+'</td>';
        h+='<td rowspan="4" class="sep name">'+_hrmsDispName(emp)+'</td>';
      }
      h+='<td style="font-weight:bold;font-size:7px">'+rowLabels[ri]+'</td>';
      for(var d=1;d<=daysInMonth;d++){
        var ds=dayStatus[d];var alt=_hrmsEffectiveAlt(empAlt[String(d)]||null);var ddd=alt||empAtt[String(d)]||{};
        var tIn=ddd['in']||'',tOut=ddd['out']||'';
        // Display ACTUAL punch times (just normalize format HH:MM); rounding is only used for hour calculations
        if(tIn){var pm=_hrmsParseTime(tIn);if(pm!==null) tIn=_hrmsMinToTime(pm);}
        if(tOut){var pm2=_hrmsParseTime(tOut);if(pm2!==null) tOut=_hrmsMinToTime(pm2);}
        var cls=[];
        if(ds.altered&&(ri===0||ri===1)) cls.push('alt');
        if(ds.isOff) cls.push('off');
        var rawIn=ddd['in']||'',rawOut=ddd['out']||'';
        var isMissing=!ds.isOff&&((!!rawIn&&!rawOut)||(!!rawOut&&!rawIn));
        if(isMissing&&ri===0&&!rawIn) cls.push('miss');
        if(isMissing&&ri===1&&!rawOut) cls.push('miss');
        var val='';
        if(ri===0) val=ds.isNight&&tIn?'<b>'+tIn+'</b>':tIn;
        else if(ri===1) val=ds.isNight&&tOut?'<b>'+tOut+'</b>':tOut;
        else if(ri===2){
          var st=ds.status;
          if(st==='P') val='<span class="P">P</span>';
          else if(st==='P/2') val='<span class="HD">P/2</span>';
          else if(st==='EL'){cls.push('EL');val='EL';}
          else if(st==='A') val='<span class="A">A</span>';
          else if(st==='H') val='<span class="H">H</span>';
        } else if(ri===3){
          if(!isStaff&&ds.worked>0){
            if(ds.isOff&&ds.otS>0){cls.push('ots');val=_hrmsFmtOT(ds.otS);}
            else if(!ds.isOff&&ds.ot>0) val=_hrmsFmtOT(ds.ot);
          }
        }
        h+='<td'+(cls.length?' class="'+cls.join(' ')+'"':'')+'>'+ val+'</td>';
      }
      if(ri===0){
        var pDisp=totalP%1===0?String(totalP):totalP.toFixed(1);
        h+='<td rowspan="4" class="tot-p sep">'+pDisp+'</td>';
        h+='<td rowspan="4" class="tot-ot sep">'+(totalOT>0?_hrmsFmtOT(totalOT):isStaff?'&#8212;':'0')+'</td>';
        h+='<td rowspan="4" class="tot-ots sep">'+(totalOTS>0?_hrmsFmtOT(totalOTS):isStaff?'&#8212;':'0')+'</td>';
      }
      h+='</tr>';
    }
  });
  h+='</tbody></table>';
  return h;
}

function _hrmsPrintWithFormat(id){
  var f=byId(DB.hrmsPrintFormats||[],id);if(!f)return;
  if(!_hrmsAttSelectedMonth){notify('No month selected',true);return;}
  var mk=_hrmsAttSelectedMonth;var p=mk.split('-');var yr=+p[0],mo=+p[1];
  var monthNames=['','January','February','March','April','May','June','July','August','September','October','November','December'];
  cm('mPrintFmt');
  showSpinner('Generating PDF…');
  var doc=_hrmsGeneratePdf(f,mk,yr,mo,monthNames);
  hideSpinner();
  if(!doc){notify('No employees match this format',true);return;}
  var safeName=(f.name||'Format').replace(/[^a-zA-Z0-9\-_ ]/g,'');
  var monthSuffix='_'+String(mo).padStart(2,'0')+String(yr).slice(-2);
  doc.save(safeName+monthSuffix+'.pdf');
  notify('✅ PDF saved');
}

// ═══ COMBINED PAGE — UNIFIED MONTH + 3 MAIN TABS ════════════════════════
var _hrmsMonth=null;
var _hrmsActiveMainTab='settings';
var _hrmsSavedMonth={};// monthKey → {meta:{...}, employees:{empCode: data}}

// Main tab switcher: settings | attendance | salary
function _hrmsMainTab(tab){
  // Permission check for main tabs
  var _tabPerm={settings:'tab.settings',attendance:'tab.attendance',salary:'tab.salary',payments:'tab.payments',esipf:'tab.esipf',pt:'tab.pt',contract:'tab.contract'};
  if(_tabPerm[tab]&&!_hrmsHasAccess(_tabPerm[tab])){notify('Access denied',true);return;}
  _hrmsActiveMainTab=tab;
  var tabs=['settings','attendance','salary','payments','esipf','pt','contract'];
  tabs.forEach(function(t){
    var btn=document.getElementById('hrmsMainTab'+t.charAt(0).toUpperCase()+t.slice(1));
    var content=document.getElementById('hrmsMain'+t.charAt(0).toUpperCase()+t.slice(1)+'Content');
    if(btn){btn.style.borderBottomColor=t===tab?'var(--accent)':'transparent';btn.style.background=t===tab?'var(--accent-light)':'transparent';btn.style.color=t===tab?'var(--accent)':'var(--text3)';}
    if(content) content.style.display=t===tab?(t==='settings'?'':'flex'):'none';
  });
  _hrmsRenderActiveTab();
}

// Unified month picker
async function _hrmsPickMonth(){
  om('mMonthPicker');
  var el=document.getElementById('monthPickerList');
  el.innerHTML='<div class="empty-state">Loading…</div>';
  await _hrmsAttFetchIndex();
  var months=_hrmsAttMonthIndex||[];
  if(!months.length){el.innerHTML='<div class="empty-state">No attendance data found.</div>';return;}
  var h='';
  months.forEach(function(m){
    var p=m.monthKey.split('-');var yr=+p[0],mo=+p[1];
    var isSel=_hrmsMonth===m.monthKey;
    h+='<div onclick="_hrmsSelectMonth(\''+m.monthKey+'\')" style="cursor:pointer;padding:12px 16px;border-radius:8px;margin-bottom:6px;border:1.5px solid '+(isSel?'var(--accent)':'var(--border)')+';background:'+(isSel?'var(--accent-light)':'var(--surface)')+';display:flex;justify-content:space-between;align-items:center" onmouseover="this.style.borderColor=\'var(--accent)\'" onmouseout="this.style.borderColor=\''+(isSel?'var(--accent)':'var(--border)')+'\'">';
    h+='<div style="font-size:15px;font-weight:800;color:'+(isSel?'var(--accent)':'var(--text)')+'">'+_MONTH_NAMES[mo]+' '+yr+'</div>';
    h+='<div style="font-size:12px;color:var(--text3)">'+m.empCount+' employees</div>';
    h+='</div>';
  });
  el.innerHTML=h;
}

async function _hrmsSelectMonth(mk){
  cm('mMonthPicker');
  _hrmsMonth=mk;
  _hrmsAttSelectedMonth=mk;
  var p=mk.split('-');var yr=+p[0],mo=+p[1];
  document.getElementById('hrmsMonthLabel').textContent=_MONTH_NAMES[mo]+' '+yr;
  if(typeof _hrmsUpdateTopTitle==='function') _hrmsUpdateTopTitle();
  // Restore any overridden employee data from previous locked month
  _hrmsRestoreSavedCaches();
  // Always load raw attendance (all employee types) for muster roll display
  showSpinner('Loading data…');
  await _hrmsAttFetchMonth(mk);
  hideSpinner();
  // If locked, also load saved snapshot and overlay salary/master data from it
  if(_hrmsIsMonthLocked(mk)){
    await _hrmsLoadSavedMonth(mk);
    if(_hrmsHasSavedData(mk)){
      _hrmsPrepSavedCaches(mk);
    }
  }
  _hrmsAttPopFilters();
  _hrmsLoadManualP();
  _hrmsUpdateLockBtn();
  _hrmsRenderActiveTab();
  // If the Contract Salary Revision sub-tab is the active Settings sub-tab,
  // re-render it so its table reflects the newly selected month.
  if(_hrmsActiveMainTab==='settings'){
    if(_hrmsActiveSettingsTab==='contractrev') _hrmsSalImpRenderPreview('contract');
    else if(_hrmsActiveSettingsTab==='salrevision') _hrmsSalImpRenderPreview('onroll');
  }
}

// ═══ ADD MONTH ═══════════════════════════════════════════════════════════
function _hrmsAddMonthOpen(){
  if(!_hrmsHasAccess('action.addMonth')){notify('Access denied',true);return;}
  var now=new Date();
  document.getElementById('addMonthMonth').value=now.getMonth()+1;
  document.getElementById('addMonthYear').value=now.getFullYear();
  document.getElementById('addMonthError').style.display='none';
  document.getElementById('addMonthInfo').style.display='none';
  om('mAddMonth');
}

async function _hrmsAddMonthConfirm(){
  var mo=+document.getElementById('addMonthMonth').value;
  var yr=+document.getElementById('addMonthYear').value;
  var errEl=document.getElementById('addMonthError');
  var infoEl=document.getElementById('addMonthInfo');
  errEl.style.display='none';infoEl.style.display='none';

  if(!yr||yr<2024||yr>2099){errEl.textContent='Please enter a valid year (2024–2099).';errEl.style.display='block';return;}

  var mk=yr+'-'+String(mo).padStart(2,'0');

  // Check for duplicate — fetch index fresh
  showSpinner('Checking existing months…');
  _hrmsAttMonthIndex=null;
  await _hrmsAttFetchIndex();
  hideSpinner();
  var existing=(_hrmsAttMonthIndex||[]).find(function(m){return m.monthKey===mk;});
  if(existing){
    errEl.textContent=_MONTH_NAMES[mo]+' '+yr+' already exists ('+existing.empCount+' employees). Choose a different month.';
    errEl.style.display='block';
    return;
  }

  // Get active employees
  var emps=(DB.hrmsEmployees||[]).filter(function(e){return(e.status||'Active')==='Active';});
  if(!emps.length){errEl.textContent='No active employees found.';errEl.style.display='block';return;}

  if(!confirm('Create '+_MONTH_NAMES[mo]+' '+yr+' with blank attendance for '+emps.length+' active employees?\n\nPL OB and Advance OB will be carried forward from the previous month.')){return;}

  showSpinner('Creating '+_MONTH_NAMES[mo]+' '+yr+'…');
  var prevMk=_hrmsPrevMonth(mk);

  // Load previous month advances for carry-forward
  await _hrmsLoadAdvances(prevMk);

  // Create blank attendance record for each active employee
  var saved=0,errors=0;
  _hrmsAttCache[mk]=[];
  for(var i=0;i<emps.length;i++){
    var emp=emps[i];
    var rec={id:'ha'+uid(),empCode:emp.empCode,monthKey:mk,days:{}};
    if(await _dbSave('hrmsAttendance',rec)){
      saved++;
      _hrmsAttCache[mk].push(rec);
    } else errors++;
  }

  // Carry forward balances: set PL OB and Advance OB from previous month CB
  for(var i=0;i<emps.length;i++){
    var emp=emps[i];
    if(!emp.extra) emp.extra={};
    if(!emp.extra.bal) emp.extra.bal={};
    var ob=_hrmsGetEmpOB(emp,mk);
    var advOB=_hrmsGetAdvOB(emp,mk);
    emp.extra.bal[mk]={plOB:ob.plOB,plCB:ob.plOB,advOB:advOB,advCB:advOB};
    await _dbSave('hrmsEmployees',emp);
  }

  // Carry forward OT rules from previous month (or default if none)
  var prevOtRules=_hrmsGetOtRules(prevMk);
  var newOtRec={id:'hs_ot_'+mk,key:'otRules_'+mk,data:prevOtRules};
  if(!DB.hrmsSettings) DB.hrmsSettings=[];
  DB.hrmsSettings.push(newOtRec);
  await _dbSave('hrmsSettings',newOtRec);


  hideSpinner();
  cm('mAddMonth');

  // Refresh index and select the new month
  _hrmsAttMonthIndex=null;
  _hrmsMonth=mk;
  _hrmsAttSelectedMonth=mk;
  document.getElementById('hrmsMonthLabel').textContent=_MONTH_NAMES[mo]+' '+yr;
  _hrmsAttPopFilters();
  _hrmsUpdateLockBtn();
  _hrmsRenderActiveTab();
  notify('✅ Created '+_MONTH_NAMES[mo]+' '+yr+': '+saved+' employees'+(errors?' ('+errors+' failed)':''));
}

// ═══ SAVE MONTH DATA (full snapshot) ═════════════════════════════════════
// _hrmsSaveMonthData is now internal — called only from _hrmsSaveAndLock
async function _hrmsSaveMonthData(mk){
  var p=mk.split('-');var yr=+p[0],mo=+p[1];
  var daysInMonth=new Date(yr,mo,0).getDate();

  // ── 1. Compute salary (populates window._hrmsSalDetails)
  _hrmsSpinMsg('Step 1/4 — Computing salary…');
  _hrmsLoadStatutory();
  await _hrmsAttFetchMonth(mk);
  _hrmsLoadManualP();
  _hrmsComputeAttTotals(yr,mo);
  await _hrmsLoadAdvances(mk);
  await _hrmsLoadAdvances(_hrmsPrevMonth(mk));
  await _hrmsRenderOrSalary(yr,mo,'all');

  // ── 2. Build per-employee rows
  _hrmsSpinMsg('Step 2/4 — Building records…');
  var salDetails=window._hrmsSalDetails||{};
  var attRecords=_hrmsAttCache[mk]||[];
  var altRecords=_hrmsAltCache[mk]||[];
  var attLookup={};attRecords.forEach(function(a){attLookup[a.empCode]=a.days||{};});
  var altLookup={};altRecords.forEach(function(a){altLookup[a.empCode]=a.days||{};});
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});

  var rows=[];
  Object.keys(salDetails).forEach(function(ec){
    var d=salDetails[ec];
    var emp=empMap[ec];if(!emp) return;
    var ex=emp.extra||{};

    var empLoc=d.location||emp.location||'';
    var empDayTypes={};
    for(var dd=1;dd<=daysInMonth;dd++){
      empDayTypes[String(dd)]=_hrmsGetDayType(mk,dd,yr,mo,empLoc);
    }

    var advRec=(DB.hrmsAdvances||[]).find(function(a){return a.empCode===ec&&a.monthKey===mk;});

    rows.push({
      id:'hmd_'+mk+'_'+ec,monthKey:mk,empCode:ec,
      name:_hrmsDispName(emp),firstName:emp.firstName||'',lastName:emp.lastName||'',middleName:emp.middleName||'',
      location:empLoc,category:d.category||emp.category||'',
      department:emp.department||'',subDepartment:emp.subDepartment||'',
      designation:emp.designation||'',employmentType:emp.employmentType||'',
      dateOfJoining:emp.dateOfJoining||'',dateOfBirth:emp.dateOfBirth||'',
      gender:emp.gender||'',status:emp.status||'Active',
      teamName:emp.teamName||'',roll:emp.roll||'',noPL:emp.noPL||false,
      esiNo:emp.esiNo||'',pfNo:emp.pfNo||'',uan:emp.uan||'',
      panNo:emp.panNo||'',aadhaarNo:emp.aadhaarNo||'',
      bankName:emp.bankName||'',branchName:emp.branchName||'',
      acctNo:emp.acctNo||'',ifsc:emp.ifsc||'',
      rateD:d.rateD,rateM:d.rateM,spAllow:d.spAllow,
      attendance:attLookup[ec]||{},alterations:altLookup[ec]||{},dayTypes:empDayTypes,
      wdCount:d.wdCount,phCount:d.phCount,
      totalP:d.totalP,totalA:d.totalA,paidAbsent:d.paidAbsent,
      totalOT:d.totalOT,totalOTS:d.totalOTS,totalPL:d.totalPL,
      manualP:(ex.manualP&&ex.manualP[mk]!==undefined)?ex.manualP[mk]:null,
      manualPL:(ex.manualPL&&ex.manualPL[mk]!==undefined)?ex.manualPL[mk]:null,
      manualOT:(ex.manualOT&&ex.manualOT[mk]!==undefined)?ex.manualOT[mk]:null,
      manualOTS:(ex.manualOTS&&ex.manualOTS[mk]!==undefined)?ex.manualOTS[mk]:null,
      tds:_hrmsGetTdsForMonth(emp,mk)||0,
      plOB:d.plOB,plGiven:d.plGiven,plCB:d.plCB,plAvail:d.plAvail,
      confMonths:d.confMonths,fyMonthNo:d.fyMonthNo,
      otAt1:d.otAt1,otAt15:d.otAt15,otAt2:d.otAt2,
      salForP:d.salForP,salAb:d.salAb,salForPL:d.salForPL,
      salOT1:d.salOT1,salOT15:d.salOT15,salOT2:d.salOT2,
      allowance:d.allowance,gross:d.gross,
      advOB:d.advOB,advMonth:(advRec&&advRec.advance)||0,
      advDed:d.dedAdv,advCB:d.advCB,
      dedPT:d.dedPT,dedPF:d.dedPF,dedESI:d.dedESI,
      dedAdv:d.dedAdv,dedTDS:d.dedTDS,dedOther:d.dedOther,dedTotal:d.dedTotal,
      net:d.net,meta:{}
    });
  });

  // ── 3. Build _meta row (statutory, calendar)
  var statSnap={};
  ['pfWorker','pfCompany','pfThreshold','esiWorker','esiThreshold','plStaffJunior','plStaffSenior','plWorker','plSeniorMonths'].forEach(function(k){
    statSnap[k]=_hrmsStatutory[k];
  });
  statSnap.ptRules=JSON.parse(JSON.stringify(_hrmsStatutory.ptRules||[]));

  var calSnap=[];
  (DB.hrmsDayTypes||[]).filter(function(r){return r.monthKey===mk;}).forEach(function(r){
    calSnap.push({plant:r.plant,dayTypes:JSON.parse(JSON.stringify(r.dayTypes||{}))});
  });

  var otRulesSnap=_hrmsGetOtRules(mk);
  // Compute & snapshot contract salary for this month (if any contract employees exist)
  var contractRows=[];
  try{
    await _hrmsRenderContractSalary(yr,mo);
    contractRows=(_hrmsContractCache[mk]||[]).slice();
  }catch(e){console.warn('Contract snapshot error:',e);}

  var metaData={savedAt:new Date().toISOString(),savedBy:CU?CU.name:'',empCount:rows.length,statutory:statSnap,calendar:calSnap,otRules:otRulesSnap,contract:contractRows};
  rows.push({id:'hmd_'+mk+'__meta',monthKey:mk,empCode:'_meta',meta:metaData});

  // ── 4. Delete existing saved data for this month (if re-saving)
  _hrmsSpinMsg('Step 3/4 — Saving '+rows.length+' records to database…');
  if(_sb&&_sbReady){
    try{
      await _sb.from('hrms_month_data').delete().eq('month_key',mk);
    }catch(e){console.warn('Delete old month data:',e);}
  }

  // ── 5. Save all rows in bulk
  var saved=await _dbSaveBulk('hrmsMonthData',rows);
  if(!saved) console.warn('hrmsMonthData save returned 0 — check if table exists in Supabase');

  // ── 6. Save balances to employee records (for next month OB chain)
  _hrmsSpinMsg('Step 4/4 — Saving balances…');
  var balData=window['_hrmsSalBal'];
  if(balData&&balData.balances&&balData.balances.length){
    var balEmpMap={};(DB.hrmsEmployees||[]).forEach(function(e){balEmpMap[e.empCode]=e;});
    var toSave=[];
    balData.balances.forEach(function(b){
      var emp=balEmpMap[b.empCode];if(!emp)return;
      if(!emp.extra) emp.extra={};
      if(!emp.extra.bal) emp.extra.bal={};
      emp.extra.bal[mk]={plOB:b.plOB,plCB:b.plCB,advOB:b.advOB,advCB:b.advCB};
      toSave.push(emp);
    });
    if(toSave.length) await _dbSaveBulk('hrmsEmployees',toSave);
  }

  // ── 7. Cache the saved data locally
  _hrmsSavedMonth[mk]={meta:metaData,employees:{}};
  rows.forEach(function(r){
    if(r.empCode!=='_meta') _hrmsSavedMonth[mk].employees[r.empCode]=r;
  });

  return saved;
}

// ═══ LOCK / UNLOCK MONTH ═════════════════════════════════════════════════
function _hrmsIsMonthLocked(mk){
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='monthLocks';});
  return rec&&rec.data&&rec.data[mk]===true;
}

// True if any month inside [from..to] (inclusive; to=null treated as 9999-12)
// has been Save-&-Locked. Used to block deleting a revision whose salary was
// already generated — those snapshots would become orphaned.
function _hrmsPeriodOverlapsLock(from,to){
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='monthLocks';});
  if(!rec||!rec.data) return false;
  var lo=(from||'0000-00'),hi=(to||'9999-12');
  for(var mk in rec.data){
    if(rec.data[mk]!==true) continue;
    if(mk>=lo&&mk<=hi) return true;
  }
  return false;
}

function _hrmsUpdateLockBtn(){
  var mk=_hrmsMonth;
  var saveLockBtn=document.getElementById('btnSaveLock');
  var unlockBtn=document.getElementById('btnUnlock');
  var banner=document.getElementById('hrmsLockBanner');
  if(!mk){
    if(saveLockBtn)saveLockBtn.style.display='none';
    if(unlockBtn)unlockBtn.style.display='none';
    if(banner)banner.style.display='none';
    return;
  }
  var locked=_hrmsIsMonthLocked(mk);
  if(saveLockBtn)saveLockBtn.style.display=locked||!_hrmsHasAccess('action.saveLock')?'none':'';
  if(unlockBtn)unlockBtn.style.display=!locked||!_hrmsHasAccess('action.unlock')?'none':'';
  if(banner)banner.style.display=locked?'flex':'none';
}

async function _hrmsSaveAndLock(){
  if(!_hrmsHasAccess('action.saveLock')){notify('Access denied',true);return;}
  var mk=_hrmsMonth;
  if(!mk){notify('Select a month first',true);return;}
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is already locked.',true);return;}
  var p=mk.split('-');var yr=+p[0],mo=+p[1];

  if(!confirm('Save & Lock '+_MONTH_NAMES[mo]+' '+yr+'?\n\nThis will save all data (salary, attendance, calendar, statutory, advances, bank details) to a permanent record, then lock the month.\n\nOnce saved, this month\'s data is fully self-contained — master data changes will NOT affect it.'))return;

  showSpinner('Saving & Locking…');
  try{
    // Save all data
    var saved=await _hrmsSaveMonthData(mk);

    // Lock the month
    _hrmsSpinMsg('Locking…');
    var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='monthLocks';});
    if(!rec){
      rec={id:'hs'+uid(),key:'monthLocks',data:{}};
      if(!DB.hrmsSettings) DB.hrmsSettings=[];
      DB.hrmsSettings.push(rec);
    }
    rec.data[mk]=true;
    await _dbSave('hrmsSettings',rec);

    // Auto-deactivate Contract / Piece Rate employees who were absent the
    // entire month. On-Roll are never touched by this rule.
    _hrmsSpinMsg('Checking absentees…');
    var autoCount=0;
    try{ autoCount=await _hrmsAutoMarkAbsentInactive(mk,true); }
    catch(e){ console.warn('Auto-mark absent failed:',e); }
    if(autoCount>0){
      renderHrmsEmployees();renderHrmsDashboard();
      setTimeout(function(){notify('⏸ '+autoCount+' Contract/Piece-Rate emp(s) marked Inactive (absent for '+_hrmsMonthLabel(mk)+')');},400);
    }
  }catch(e){
    console.error('Save & Lock error:',e);
    notify('⚠ Save & Lock failed: '+e.message,true);
  }finally{
    // Force-clear spinner depth to 0
    _spinDepth=0;hideSpinner();
    _hrmsUpdateLockBtn();
  }
  if(_hrmsIsMonthLocked(mk)) notify('🔒 '+_MONTH_NAMES[mo]+' '+yr+' saved & locked');
}

// Update spinner message without changing depth
function _hrmsSpinMsg(msg){var m=document.getElementById('kapSpinnerMsg');if(m)m.textContent=msg;}

async function _hrmsToggleMonthLock(){
  var mk=_hrmsMonth;
  if(!mk){notify('Select a month first',true);return;}
  var locked=_hrmsIsMonthLocked(mk);
  if(locked&&!_hrmsHasAccess('action.unlock')){notify('Access denied',true);return;}
  if(!locked&&!_hrmsHasAccess('action.saveLock')){notify('Access denied',true);return;}
  var label=_hrmsMonthLabel(mk);
  if(!locked){
    if(!confirm('Lock '+label+'?\n\nThis will prevent edits to attendance, salary settings, and advances for this month.'))return;
  }
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='monthLocks';});
  if(!rec){
    rec={id:'hs'+uid(),key:'monthLocks',data:{}};
    if(!DB.hrmsSettings) DB.hrmsSettings=[];
    DB.hrmsSettings.push(rec);
  }
  rec.data[mk]=!locked;
  showSpinner(locked?'Unlocking…':'Locking…');
  await _dbSave('hrmsSettings',rec);
  if(locked){
    // Unlocking: restore employee master data and reload from normal tables
    _hrmsRestoreSavedCaches();
    await _hrmsAttFetchMonth(mk);
  }
  hideSpinner();
  _hrmsUpdateLockBtn();
  _hrmsRenderActiveTab();
  notify(locked?'🔓 '+label+' unlocked':'🔒 '+label+' locked');
}

// ═══ LOAD SAVED MONTH DATA (for locked months) ══════════════════════════
async function _hrmsLoadSavedMonth(mk){
  if(_hrmsSavedMonth[mk]) return _hrmsSavedMonth[mk];
  if(!_sb||!_sbReady) return null;
  showSpinner('Loading saved data…');
  try{
    var {data,error}=await _sb.from('hrms_month_data').select('*').eq('month_key',mk);
    if(error){console.error('Load saved month error:',error.message);hideSpinner();return null;}
    if(!data||!data.length){hideSpinner();return null;}
    var result={meta:null,employees:{}};
    data.forEach(function(row){
      var rec=_fromRow('hrmsMonthData',row);if(!rec) return;
      if(rec.empCode==='_meta') result.meta=rec.meta;
      else result.employees[rec.empCode]=rec;
    });
    _hrmsSavedMonth[mk]=result;
    hideSpinner();
    return result;
  }catch(e){console.error('Load saved month error:',e);hideSpinner();return null;}
}

function _hrmsHasSavedData(mk){
  return _hrmsSavedMonth[mk]&&_hrmsSavedMonth[mk].meta&&Object.keys(_hrmsSavedMonth[mk].employees).length>0;
}

// Populate normal caches from saved data so existing render functions work for locked months
function _hrmsPrepSavedCaches(mk){
  var saved=_hrmsSavedMonth[mk];if(!saved) return;
  var empData=saved.employees;
  var codes=Object.keys(empData);

  // 1. Merge attendance cache — overlay snapshot data onto raw ESSL, keep non-snapshot employees
  var existingAtt=_hrmsAttCache[mk]||[];
  var attByCode={};existingAtt.forEach(function(a){attByCode[a.empCode]=a;});
  codes.forEach(function(ec){
    attByCode[ec]={id:'sa_'+ec,empCode:ec,monthKey:mk,days:empData[ec].attendance||{}};
  });
  _hrmsAttCache[mk]=Object.keys(attByCode).map(function(ec){return attByCode[ec];});

  // 2. Merge alteration cache — overlay snapshot, keep non-snapshot employees
  var existingAlt=_hrmsAltCache[mk]||[];
  var altByCode={};existingAlt.forEach(function(a){altByCode[a.empCode]=a;});
  codes.forEach(function(ec){
    var alt=empData[ec].alterations;
    if(alt&&Object.keys(alt).length){
      altByCode[ec]={id:'sl_'+ec,empCode:ec,monthKey:mk,days:alt};
    }
  });
  _hrmsAltCache[mk]=Object.keys(altByCode).map(function(ec){return altByCode[ec];});

  // 3. Populate day types from saved calendar
  if(saved.meta&&saved.meta.calendar){
    // Remove current month's day types and replace with saved ones
    DB.hrmsDayTypes=(DB.hrmsDayTypes||[]).filter(function(r){return r.monthKey!==mk;});
    saved.meta.calendar.forEach(function(c){
      DB.hrmsDayTypes.push({id:'sdt_'+mk+'_'+c.plant,monthKey:mk,plant:c.plant,dayTypes:c.dayTypes});
    });
  }

  // 4. Override employee master data with saved snapshot for this month
  // Store original values so they can be restored when switching to unlocked month
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});
  codes.forEach(function(ec){
    var d=empData[ec];
    var emp=empMap[ec];
    if(!emp){
      // Employee was deleted/left after this month was saved — recreate temporarily
      emp={id:'tmp_'+ec,empCode:ec,periods:[],extra:{}};
      DB.hrmsEmployees.push(emp);
    }
    // Save originals for restore
    if(!emp._savedOriginal) emp._savedOriginal={};
    var fields=['name','firstName','lastName','middleName','location','category','department','subDepartment','designation','employmentType','dateOfJoining','dateOfBirth','gender','status','teamName','roll','noPL','esiNo','pfNo','uan','panNo','aadhaarNo','bankName','branchName','acctNo','ifsc'];
    fields.forEach(function(f){
      if(emp._savedOriginal[f]===undefined) emp._savedOriginal[f]=emp[f];
      emp[f]=d[f];
    });
    // Ensure status shows as it was at save time
    emp.status=d.status||'Active';
    // Set computed totals
    emp._totalP=d.totalP||0;emp._totalA=d.totalA||0;emp._totalOT=d.totalOT||0;emp._totalOTS=d.totalOTS||0;
  });

  // 5. Populate advance cache
  _hrmsAdvCache[mk]={};
  codes.forEach(function(ec){
    var d=empData[ec];
    if(d.advMonth||d.advDed){
      _hrmsAdvCache[mk][ec]={empCode:ec,monthKey:mk,advance:d.advMonth||0,deduction:d.advDed||0,emi:0};
    }
  });

  // 6. Populate statutory from saved meta
  if(saved.meta&&saved.meta.statutory){
    var s=saved.meta.statutory;
    Object.keys(s).forEach(function(k){_hrmsStatutory[k]=s[k];});
  }

  // 7. Populate manual P data
  _hrmsManualPData[mk]={};
  codes.forEach(function(ec){
    var d=empData[ec];
    if(d.manualP!==null&&d.manualP!==undefined) _hrmsManualPData[mk][ec]=d.manualP;
  });
}

// Restore employee master data when leaving a locked month
function _hrmsRestoreSavedCaches(){
  (DB.hrmsEmployees||[]).forEach(function(emp){
    if(emp._savedOriginal){
      Object.keys(emp._savedOriginal).forEach(function(f){emp[f]=emp._savedOriginal[f];});
      delete emp._savedOriginal;
    }
  });
  // Remove temp employees
  DB.hrmsEmployees=(DB.hrmsEmployees||[]).filter(function(e){return!e.id||e.id.indexOf('tmp_')!==0;});
}

function _hrmsRenderActiveTab(){
  var mk=_hrmsMonth;
  if(!mk) return;
  var p=mk.split('-');var yr=+p[0],mo=+p[1];
  // Show/hide main tabs based on permissions
  var _tabPerms={settings:'tab.settings',attendance:'tab.attendance',salary:'tab.salary',payments:'tab.payments',esipf:'tab.esipf',pt:'tab.pt',contract:'tab.contract'};
  ['settings','attendance','salary','payments','esipf','pt','contract'].forEach(function(t){
    var btn=document.getElementById('hrmsMainTab'+t.charAt(0).toUpperCase()+t.slice(1));
    if(btn) btn.style.display=_hrmsHasAccess(_tabPerms[t])?'':'none';
  });
  if(_hrmsActiveMainTab==='settings'){ _hrmsSalSettingsRender(); _hrmsSettingsSubTab(_hrmsActiveSettingsTab); }
  else if(_hrmsActiveMainTab==='attendance') _hrmsAttSetTab(_hrmsAttCurrentTab);
  else if(_hrmsActiveMainTab==='salary') _hrmsRenderOrSalary(yr,mo,'all');
  else if(_hrmsActiveMainTab==='payments') _hrmsRenderPayments();
  else if(_hrmsActiveMainTab==='esipf') _hrmsRenderEsiPfList();
  else if(_hrmsActiveMainTab==='pt') _hrmsRenderPtDetails();
  else if(_hrmsActiveMainTab==='contract') _hrmsRenderContractSalary(yr,mo);
}

// ═══ SALARY SETTINGS — Per-Plant Working Days & Paid Holidays ═══════════
var _hrmsSettingsApplyAll=false;

// ═══ SETTINGS SUB-TABS ═══════════════════════════════════════════════════
var _hrmsActiveSettingsTab='calendar';
function _hrmsSettingsSubTab(tab){
  // Permission check for settings sub-tabs
  var _setTabPerm={calendar:'settings.calendar',esslatt:'settings.esslatt',altimport:'settings.altimport',advances:'settings.advances',manual:'settings.manual',tds:'settings.tds',salrevision:'settings.salrevision',contractrev:'page.contractRev',otrules:'settings.otrules',statutory:'settings.statutory'};
  if(_setTabPerm[tab]&&!_hrmsHasAccess(_setTabPerm[tab])){notify('Access denied',true);return;}
  _hrmsActiveSettingsTab=tab;
  ['calendar','esslatt','altimport','advances','manual','tds','salrevision','contractrev','otrules','statutory'].forEach(function(t){
    var panel=document.getElementById('hrmsSetPanel'+t.charAt(0).toUpperCase()+t.slice(1));
    var btn=document.getElementById('hrmsSetTab'+t.charAt(0).toUpperCase()+t.slice(1));
    var allowed=_hrmsHasAccess(_setTabPerm[t]);
    if(panel) panel.style.display=t===tab?'':'none';
    if(btn){btn.style.display=allowed?'':'none';btn.style.borderBottomColor=t===tab?'var(--accent)':'transparent';btn.style.color=t===tab?'var(--accent)':'var(--text3)';}
  });
  if(tab==='statutory'){_hrmsLoadStatutory();_hrmsStatutoryToUI();_hrmsRenderPtRules();}
  if(tab==='otrules'){_hrmsOtRulesEditMode=false;_hrmsRenderOtRules();}
  if(tab==='esslatt') _hrmsRenderEsslImportLog();
  if(tab==='altimport') _hrmsRenderAltImportLog();
  if(tab==='manual'){
    // Combined Alteration & Overrides tab — refresh both renderers.
    _hrmsRenderAltImportLog();
    _hrmsRenderManualPList();
  }
  if(tab==='salrevision') _hrmsSalImpRenderPreview('onroll');
  if(tab==='contractrev') _hrmsSalImpRenderPreview('contract');
  if(tab==='tds') _hrmsTdsRender();
  if(tab==='advances') _hrmsRenderAdvances();
}


function _hrmsSalSettingsRender(){
  var body=document.getElementById('hrmsSalSettingsBody');if(!body)return;
  var mk=_hrmsMonth;
  if(!mk){
    body.innerHTML='<div class="empty-state">Select a month above to configure working days and paid holidays</div>';
    return;
  }
  var p=mk.split('-');var yr=+p[0],mo=+p[1];
  var daysInMonth=new Date(yr,mo,0).getDate();
  var dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var dtColors={WD:{bg:'#fef3c7',color:'#b45309',label:'W',tip:'Working Day'},WO:{bg:'#dbeafe',color:'#1d4ed8',label:'H',tip:'Weekly Off'},PH:{bg:'#dcfce7',color:'#15803d',label:'P',tip:'Paid Holiday'}};
  var plants=(DB.hrmsCompanies||[]).map(function(c){return c.name;}).filter(Boolean).sort();
  if(!plants.length) plants=['Default'];
  var canEdit=_hrmsHasAccess('action.editCalendar')&&!_hrmsIsMonthLocked(mk);

  // Legend + Apply All checkbox
  var h='<div style="display:flex;gap:12px;margin-bottom:12px;font-size:10px;font-weight:700;align-items:center">';
  h+='<span style="display:flex;align-items:center;gap:3px"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#fef3c7;border:1px solid #f59e0b"></span><span style="color:#b45309">W = Working</span></span>';
  h+='<span style="display:flex;align-items:center;gap:3px"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#dbeafe;border:1px solid #3b82f6"></span><span style="color:#1d4ed8">H = Off</span></span>';
  h+='<span style="display:flex;align-items:center;gap:3px"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#dcfce7;border:1px solid #22c55e"></span><span style="color:#15803d">P = Paid Holiday</span></span>';
  if(canEdit) h+='<span style="color:var(--text3);margin-left:auto">Click to cycle</span>';
  else h+='<span style="color:var(--text3);margin-left:auto">🔒 View only</span>';
  h+='</div>';
  if(canEdit){
    h+='<div style="margin-bottom:12px"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;font-weight:700;color:var(--text)">';
    h+='<input type="checkbox" id="hrmsApplyAllPlants" onchange="_hrmsToggleApplyAll(this.checked)"'+(_hrmsSettingsApplyAll?' checked':'')+'>';
    h+='Apply to all Plants</label></div>';
  }

  // Per-plant calendars — sorted, side by side
  h+='<div style="display:flex;flex-wrap:wrap;gap:12px">';
  plants.forEach(function(plant,pi){
    var pClr=_hrmsGetPlantColor(plant);
    // When applyAll, non-first plants read from first plant
    var srcPlant=_hrmsSettingsApplyAll?plants[0]:plant;
    var counts={WD:0,WO:0,PH:0};
    for(var d=1;d<=daysInMonth;d++){
      var dt=_hrmsGetDayType(mk,d,yr,mo,srcPlant);
      counts[dt]=(counts[dt]||0)+1;
    }
    var disabled=_hrmsSettingsApplyAll&&pi>0;
    var opacity=disabled?'opacity:.45;pointer-events:none':'';

    h+='<div style="border:1.5px solid var(--border);border-radius:8px;padding:10px;background:var(--surface);min-width:220px;flex:1;max-width:320px;'+opacity+'">';
    // Plant header + counts inline
    h+='<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap">';
    h+='<span style="font-size:12px;font-weight:900;padding:2px 8px;border-radius:4px;background:'+pClr+'">'+plant+'</span>';
    h+='<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;background:#fef3c7;color:#92400e">'+counts.WD+'</span>';
    h+='<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;background:#dbeafe;color:#1e40af">'+counts.WO+'</span>';
    h+='<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;background:#dcfce7;color:#166534">'+counts.PH+'</span>';
    h+='</div>';

    // Compact calendar grid
    h+='<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px">';
    dayNames.forEach(function(dn){
      h+='<div style="text-align:center;font-size:8px;font-weight:800;color:var(--text3);padding:1px 0">'+dn.charAt(0)+'</div>';
    });
    var firstDow=new Date(yr,mo-1,1).getDay();
    for(var b=0;b<firstDow;b++) h+='<div></div>';
    for(var d=1;d<=daysInMonth;d++){
      var dt=_hrmsGetDayType(mk,d,yr,mo,srcPlant);
      var dc=dtColors[dt]||dtColors.WD;
      var plantEsc=plant.replace(/'/g,"\\'");
      h+='<div'+(canEdit?' onclick="_hrmsSalSettingsCycleDay(\''+mk+'\','+d+','+yr+','+mo+',\''+plantEsc+'\')"':'')+' title="'+dc.tip+'" style="'+(canEdit?'cursor:pointer':'cursor:default')+';text-align:center;padding:3px 1px;border-radius:4px;background:'+dc.bg+';border:1px solid '+dc.color+'22">';
      h+='<div style="font-size:10px;font-weight:900;color:'+dc.color+';line-height:1.2">'+d+'</div>';
      h+='</div>';
    }
    h+='</div></div>';
  });
  h+='</div>';

  body.innerHTML=h;
}

function _hrmsToggleApplyAll(checked){
  _hrmsSettingsApplyAll=checked;
  _hrmsSalSettingsRender();
}

async function _hrmsSalSettingsCycleDay(monthKey,day,yr,mo,plant){
  if(!_hrmsHasAccess('action.editCalendar')){notify('Access denied',true);return;}
  if(_hrmsIsMonthLocked(monthKey)){notify('⚠ '+_hrmsMonthLabel(monthKey)+' is locked.',true);return;}
  var plants=(DB.hrmsCompanies||[]).map(function(c){return c.name;}).filter(Boolean).sort();
  if(!plants.length) plants=['Default'];
  var targetPlants=_hrmsSettingsApplyAll?plants:[plant];
  var cur=_hrmsGetDayType(monthKey,day,yr,mo,targetPlants[0]);
  var next=cur==='WD'?'WO':cur==='WO'?'PH':'WD';
  var key=String(day);
  var toSave=[];
  for(var i=0;i<targetPlants.length;i++){
    var tp=targetPlants[i];
    var rec=(DB.hrmsDayTypes||[]).find(function(r){return r.monthKey===monthKey&&r.plant===tp;});
    if(rec){
      var newDt=Object.assign({},rec.dayTypes||{});
      newDt[key]=next;
      rec.dayTypes=newDt;
      toSave.push(rec);
    } else {
      if(!DB.hrmsDayTypes) DB.hrmsDayTypes=[];
      var dt={};dt[key]=next;
      var nr={id:'hdt'+uid(),monthKey:monthKey,plant:tp,dayTypes:dt};
      DB.hrmsDayTypes.push(nr);
      toSave.push(nr);
    }
  }
  await _dbSaveBulk('hrmsDayTypes',toSave);
  _hrmsSalSettingsRender();
}

// ═══ STATUTORY SETTINGS ══════════════════════════════════════════════════
var _hrmsStatutory={
  pfWorker:12,pfCompany:13,pfThreshold:21000,
  esiWorker:0.75,esiCompany:3.25,esiThreshold:21000,
  plStaffSenior:18,plStaffJunior:1.5,plWorker:1.5,plSeniorMonths:60,
  ptRules:[
    {amount:0,op:'lt',threshold:25000,gender:'Female',month:'',remark:'Gross < 25000 (Women only)'},
    {amount:0,op:'lt',threshold:7500,gender:'',month:'',remark:'Gross < 7500'},
    {amount:300,op:'gte',threshold:10000,gender:'',month:'feb',remark:'Gross >= 10000 (Feb only)'},
    {amount:175,op:'lt',threshold:10000,gender:'',month:'',remark:'Gross < 10000'},
    {amount:200,op:'gte',threshold:10000,gender:'',month:'',remark:'Gross >= 10000'}
  ]
};

// ═══ OT RULES (per-month) ════════════════════════════════════════════════
var _hrmsOtRulesDefault={
  fullDay:8.25,           // hours for full present
  halfDay:4,              // hours for half present (P/2)
  elMin:6.5,              // min hours for Extra Leave (Staff only)
  elMaxPerMonth:2,        // max EL days per month (Staff)
  // OT on working days
  otTier2Threshold:14,    // if worked > this → OT = worked - otTier2Subtract
  otTier2Subtract:9,
  otTier1Threshold:8.5,   // if worked >= this → OT = worked - otTier1Subtract
  otTier1Subtract:8.5,
  otMaxPerDay:7,
  // OTS on off days
  otsTier2Threshold:13,   // if worked > this → subtract otsTier2Deduct
  otsTier2Deduct:1,
  otsTier1Threshold:4,    // if worked >= this → subtract otsTier1Deduct
  otsTier1Deduct:0.5,
  otsMaxPerDay:15,
  // Ineligible OT
  iotAbsentThreshold:1.5, // if absent > this → IOT = (absent - threshold) * iotHoursPerDay
  iotHoursPerDay:8
};

function _hrmsGetOtRules(mk){
  // Per-month override, else default
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='otRules_'+mk;});
  if(rec&&rec.data){
    var out={};
    Object.keys(_hrmsOtRulesDefault).forEach(function(k){
      out[k]=rec.data[k]!==undefined?rec.data[k]:_hrmsOtRulesDefault[k];
    });
    return out;
  }
  // Global default if set
  var glob=(DB.hrmsSettings||[]).find(function(r){return r.key==='otRules';});
  if(glob&&glob.data){
    var out={};
    Object.keys(_hrmsOtRulesDefault).forEach(function(k){
      out[k]=glob.data[k]!==undefined?glob.data[k]:_hrmsOtRulesDefault[k];
    });
    return out;
  }
  return Object.assign({},_hrmsOtRulesDefault);
}

var _hrmsOtRulesEditMode=false;

function _hrmsRenderOtRules(){
  var body=document.getElementById('hrmsOtRulesBody');if(!body)return;
  var mk=_hrmsMonth;
  if(!mk){body.innerHTML='<div class="empty-state">Select a month above to configure OT rules</div>';return;}
  var locked=_hrmsIsMonthLocked(mk);
  var rules=_hrmsGetOtRules(mk);
  // Snapshot current rules for cancel-revert
  window._hrmsOtRulesSnapshot=JSON.parse(JSON.stringify(rules));
  var editable=_hrmsOtRulesEditMode&&!locked;

  var _fld=function(key,label,step,unit){
    return '<div style="display:flex;flex-direction:column;gap:3px;width:170px"><label style="font-size:11px;font-weight:700;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+label+(unit?' <span style="color:var(--text3);font-weight:500">('+unit+')</span>':'')+'</label>'+
      '<input type="number" id="otr_'+key+'" step="'+(step||0.5)+'" value="'+rules[key]+'" '+(editable?'':'disabled')+' style="font-size:13px;padding:5px 8px;border:1.5px solid '+(editable?'var(--accent)':'var(--border)')+';border-radius:4px;width:90px;background:'+(editable?'#fff':'var(--surface2)')+';color:'+(editable?'var(--text)':'var(--text2)')+'">'+
      '</div>';
  };

  var _sec=function(title,color,fields){
    var h='<div style="margin-bottom:14px"><div style="font-size:13px;font-weight:800;color:'+color+';margin-bottom:6px;padding:5px 10px;background:var(--surface2);border-radius:6px;border-left:3px solid '+color+'">'+title+'</div>';
    h+='<div style="display:flex;flex-wrap:wrap;gap:10px;padding:0 4px">';
    fields.forEach(function(f){h+=_fld(f.key,f.label,f.step,f.unit);});
    h+='</div></div>';
    return h;
  };

  var h='<div style="margin-bottom:12px;padding:10px 14px;background:var(--surface2);border-radius:8px;display:flex;align-items:center;gap:10px">';
  h+='<span style="font-size:13px;font-weight:700;color:var(--text)">Rules for <b style="color:var(--accent)">'+_hrmsMonthLabel(mk)+'</b></span>';
  h+='<span style="font-size:11px;color:var(--text3)">'+(editable?'✏️ Edit mode — make changes and Save':'🔒 View mode — click Edit to modify')+'</span>';
  h+='<div style="flex:1"></div>';
  if(!locked){
    if(editable){
      h+='<button onclick="_hrmsCancelOtRules()" style="padding:5px 14px;font-size:12px;font-weight:700;background:#f1f5f9;border:1.5px solid #cbd5e1;color:#475569;border-radius:5px;cursor:pointer">✕ Cancel</button>';
      h+='<button onclick="_hrmsSaveOtRules()" style="padding:5px 14px;font-size:12px;font-weight:800;background:var(--accent);color:#fff;border:none;border-radius:5px;cursor:pointer">💾 Save</button>';
    } else {
      h+='<button onclick="_hrmsEditOtRules()" style="padding:5px 14px;font-size:12px;font-weight:800;background:#f59e0b;color:#fff;border:none;border-radius:5px;cursor:pointer">✏️ Edit</button>';
    }
  }
  h+='</div>';

  h+=_sec('🟢 Attendance Classification','#16a34a',[
    {key:'fullDay',label:'Full Day Threshold',unit:'hrs'},
    {key:'halfDay',label:'Half Day Threshold',unit:'hrs'},
    {key:'elMin',label:'EL Minimum Hours',unit:'hrs (Staff only)'},
    {key:'elMaxPerMonth',label:'EL Max Per Month',unit:'days',step:1}
  ]);

  h+=_sec('🟠 OT on Working Days (Workers only)','#f59e0b',[
    {key:'otTier1Threshold',label:'Tier 1 Threshold',unit:'worked ≥ hrs'},
    {key:'otTier1Subtract',label:'Tier 1 Subtract',unit:'hrs'},
    {key:'otTier2Threshold',label:'Tier 2 Threshold',unit:'worked > hrs'},
    {key:'otTier2Subtract',label:'Tier 2 Subtract',unit:'hrs'},
    {key:'otMaxPerDay',label:'OT Max Per Day',unit:'hrs'}
  ]);

  h+=_sec('🔵 OT on Off Days / Sundays (Workers only)','#2563eb',[
    {key:'otsTier1Threshold',label:'Tier 1 Threshold',unit:'worked ≥ hrs'},
    {key:'otsTier1Deduct',label:'Tier 1 Deduct',unit:'hrs'},
    {key:'otsTier2Threshold',label:'Tier 2 Threshold',unit:'worked > hrs'},
    {key:'otsTier2Deduct',label:'Tier 2 Deduct',unit:'hrs'},
    {key:'otsMaxPerDay',label:'OTS Max Per Day',unit:'hrs'}
  ]);

  h+=_sec('🔴 Ineligible OT (IOT)','#dc2626',[
    {key:'iotAbsentThreshold',label:'Absent Threshold',unit:'days'},
    {key:'iotHoursPerDay',label:'IOT Hours Per Day',unit:'hrs/day'}
  ]);

  h+='<div style="margin-top:12px;padding:10px 14px;background:#f0f9ff;border-left:3px solid #3b82f6;border-radius:4px;font-size:11px;color:#1e40af;line-height:1.6">';
  h+='<b>Formula reference:</b><br>';
  h+='• Working Day OT: if worked > Tier2 → (worked − Tier2_Sub); else if worked ≥ Tier1 → (worked − Tier1_Sub); capped at Max<br>';
  h+='• Off Day OTS: if worked > Tier2 → (worked − Tier2_Deduct); else if worked ≥ Tier1 → (worked − Tier1_Deduct); capped at Max<br>';
  h+='• Ineligible OT (IOT) deducted first from OTS, then from OT';
  h+='</div>';

  body.innerHTML=h;
}

function _hrmsEditOtRules(){
  var mk=_hrmsMonth;if(!mk)return;
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked.',true);return;}
  _hrmsOtRulesEditMode=true;
  _hrmsRenderOtRules();
}

function _hrmsCancelOtRules(){
  _hrmsOtRulesEditMode=false;
  _hrmsRenderOtRules();
}

async function _hrmsSaveOtRules(){
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked.',true);return;}
  // Detect changes against snapshot
  var snap=window._hrmsOtRulesSnapshot||{};
  var data={};var changed=false;
  Object.keys(_hrmsOtRulesDefault).forEach(function(k){
    var el=document.getElementById('otr_'+k);
    var v=el?(parseFloat(el.value)||_hrmsOtRulesDefault[k]):_hrmsOtRulesDefault[k];
    data[k]=v;
    if(v!==snap[k]) changed=true;
  });
  if(!changed){
    notify('No changes to save');
    _hrmsOtRulesEditMode=false;
    _hrmsRenderOtRules();
    return;
  }
  if(!confirm('Save OT rule changes for '+_hrmsMonthLabel(mk)+'?\n\nThis will affect attendance & salary calculations for this month.'))return;
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='otRules_'+mk;});
  if(rec){rec.data=data;}
  else{
    rec={id:'hs_ot_'+mk,key:'otRules_'+mk,data:data};
    if(!DB.hrmsSettings) DB.hrmsSettings=[];
    DB.hrmsSettings.push(rec);
  }
  showSpinner('Saving OT rules…');
  await _dbSave('hrmsSettings',rec);
  hideSpinner();
  notify('✅ OT rules saved for '+_hrmsMonthLabel(mk));
  _hrmsOtRulesEditMode=false;
  _hrmsAdvCache={};
  _hrmsRenderOtRules();
}

function _hrmsLoadStatutory(){
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='statutory';});
  if(rec&&rec.data){
    var d=rec.data;
    if(d.pfWorker!==undefined) _hrmsStatutory.pfWorker=d.pfWorker;
    if(d.pfCompany!==undefined) _hrmsStatutory.pfCompany=d.pfCompany;
    if(d.pfThreshold!==undefined) _hrmsStatutory.pfThreshold=d.pfThreshold;
    if(d.esiWorker!==undefined) _hrmsStatutory.esiWorker=d.esiWorker;
    if(d.esiCompany!==undefined) _hrmsStatutory.esiCompany=d.esiCompany;
    if(d.esiThreshold!==undefined) _hrmsStatutory.esiThreshold=d.esiThreshold;
    if(d.plStaffSenior!==undefined) _hrmsStatutory.plStaffSenior=d.plStaffSenior;
    if(d.plStaffJunior!==undefined) _hrmsStatutory.plStaffJunior=d.plStaffJunior;
    if(d.plWorker!==undefined) _hrmsStatutory.plWorker=d.plWorker;
    if(d.plSeniorMonths!==undefined) _hrmsStatutory.plSeniorMonths=d.plSeniorMonths;
    if(d.ptRules) _hrmsStatutory.ptRules=d.ptRules;
  }
  _hrmsStatutoryToUI();
}

function _hrmsStatutoryToUI(){
  var s=_hrmsStatutory;
  var el=function(id){return document.getElementById(id);};
  if(el('hrmsPfWorker')) el('hrmsPfWorker').value=s.pfWorker;
  if(el('hrmsPfCompany')) el('hrmsPfCompany').value=s.pfCompany;
  if(el('hrmsPfThreshold')) el('hrmsPfThreshold').value=s.pfThreshold;
  if(el('hrmsEsiWorker')) el('hrmsEsiWorker').value=s.esiWorker;
  if(el('hrmsEsiCompany')) el('hrmsEsiCompany').value=s.esiCompany;
  if(el('hrmsEsiThreshold')) el('hrmsEsiThreshold').value=s.esiThreshold;
  if(el('hrmsPLStaffSenior')) el('hrmsPLStaffSenior').value=s.plStaffSenior;
  if(el('hrmsPLStaffJunior')) el('hrmsPLStaffJunior').value=s.plStaffJunior;
  if(el('hrmsPLWorker')) el('hrmsPLWorker').value=s.plWorker;
  if(el('hrmsPLSeniorMonths')) el('hrmsPLSeniorMonths').value=s.plSeniorMonths;
  _hrmsRenderPtRules();
}

function _hrmsRenderPtRules(){
  var el=document.getElementById('hrmsPtRules');if(!el)return;
  var _s='font-size:10px;padding:3px 4px;border:1px solid var(--border);border-radius:3px;';
  var h='<table style="border-collapse:collapse;font-size:10px;width:100%"><thead><tr style="background:#f8fafc">';
  h+='<th style="padding:3px 4px;text-align:left;font-weight:700">Amount</th>';
  h+='<th style="padding:3px 4px;text-align:left;font-weight:700">Condition</th>';
  h+='<th style="padding:3px 4px;text-align:left;font-weight:700">Threshold</th>';
  h+='<th style="padding:3px 4px;text-align:left;font-weight:700">Gender</th>';
  h+='<th style="padding:3px 4px;text-align:left;font-weight:700">Month</th>';
  h+='<th style="padding:3px 4px;text-align:left;font-weight:700">Remark</th>';
  h+='<th></th></tr></thead><tbody>';
  _hrmsStatutory.ptRules.forEach(function(r,i){
    h+='<tr style="border-bottom:1px solid var(--border)">';
    h+='<td><input type="number" value="'+r.amount+'" step="5" min="0" onchange="_hrmsStatutory.ptRules['+i+'].amount=parseFloat(this.value)||0" style="'+_s+'width:45px;text-align:right"></td>';
    h+='<td><select onchange="_hrmsStatutory.ptRules['+i+'].op=this.value" style="'+_s+'width:50px"><option value="lt"'+(r.op==='lt'?' selected':'')+'>&#60;</option><option value="gte"'+(r.op==='gte'?' selected':'')+'>&#8805;</option></select></td>';
    h+='<td><input type="number" value="'+r.threshold+'" step="500" min="0" onchange="_hrmsStatutory.ptRules['+i+'].threshold=parseFloat(this.value)||0" style="'+_s+'width:60px;text-align:right"></td>';
    h+='<td><select onchange="_hrmsStatutory.ptRules['+i+'].gender=this.value" style="'+_s+'width:55px"><option value=""'+(r.gender===''?' selected':'')+'>All</option><option value="Female"'+(r.gender==='Female'?' selected':'')+'>Women</option><option value="Male"'+(r.gender==='Male'?' selected':'')+'>Men</option></select></td>';
    h+='<td><select onchange="_hrmsStatutory.ptRules['+i+'].month=this.value" style="'+_s+'width:55px"><option value=""'+(r.month===''?' selected':'')+'>All</option><option value="feb"'+((r.month||'')==='feb'?' selected':'')+'>Feb</option></select></td>';
    h+='<td><input type="text" value="'+(r.remark||'').replace(/"/g,'&quot;')+'" onchange="_hrmsStatutory.ptRules['+i+'].remark=this.value" style="'+_s+'width:100%"></td>';
    h+='<td><button onclick="_hrmsStatutory.ptRules.splice('+i+',1);_hrmsRenderPtRules()" style="font-size:9px;padding:2px 4px;border:1px solid #fecaca;border-radius:3px;background:#fef2f2;color:#dc2626;cursor:pointer">✕</button></td>';
    h+='</tr>';
  });
  h+='</tbody></table>';
  el.innerHTML=h;
}

function _hrmsAddPtRule(){
  _hrmsStatutory.ptRules.push({amount:0,op:'lt',threshold:0,gender:'',month:'',remark:''});
  _hrmsRenderPtRules();
}

async function _hrmsSaveStatutory(){
  var s=_hrmsStatutory;
  s.pfWorker=parseFloat(document.getElementById('hrmsPfWorker').value)||0;
  s.pfCompany=parseFloat(document.getElementById('hrmsPfCompany').value)||0;
  s.pfThreshold=parseFloat(document.getElementById('hrmsPfThreshold').value)||0;
  s.esiWorker=parseFloat(document.getElementById('hrmsEsiWorker').value)||0;
  s.esiCompany=parseFloat(document.getElementById('hrmsEsiCompany').value)||0;
  s.esiThreshold=parseFloat(document.getElementById('hrmsEsiThreshold').value)||0;
  s.plStaffSenior=parseFloat(document.getElementById('hrmsPLStaffSenior').value)||0;
  s.plStaffJunior=parseFloat(document.getElementById('hrmsPLStaffJunior').value)||0;
  s.plWorker=parseFloat(document.getElementById('hrmsPLWorker').value)||0;
  s.plSeniorMonths=parseFloat(document.getElementById('hrmsPLSeniorMonths').value)||0;
  // ptRules already updated via onchange
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='statutory';});
  if(rec){
    rec.data=JSON.parse(JSON.stringify(s));
    await _dbSave('hrmsSettings',rec);
  } else {
    if(!DB.hrmsSettings) DB.hrmsSettings=[];
    var nr={id:'hset'+uid(),key:'statutory',data:JSON.parse(JSON.stringify(s))};
    DB.hrmsSettings.push(nr);
    await _dbSave('hrmsSettings',nr);
  }
  var st=document.getElementById('hrmsStatSaveStatus');
  if(st){st.textContent='✅ Saved';st.style.color='#16a34a';setTimeout(function(){st.textContent='';},3000);}
  notify('✅ Statutory settings saved');
}

// _hrmsCalcPT is in hrms-logic.js


// ═══ BALANCE HELPERS ═════════════════════════════════════════════════════
// _hrmsGetBal is in hrms-logic.js
// _hrmsGetPrevMonth is in hrms-logic.js
// _hrmsGetEmpOB is in hrms-logic.js

// ═══ PAID LEAVE ALLOCATION (FY April–March) ═════════════════════════════
// _hrmsGetConfirmationDate is in hrms-logic.js
// _hrmsMonthsSinceConfirmation is in hrms-logic.js
// _hrmsFYStart is in hrms-logic.js
// _hrmsCalcPLGiven is in hrms-logic.js
// _hrmsCumPLAvail is in hrms-logic.js

// ═══ OPENING BALANCE IMPORT ══════════════════════════════════════════════
async function _hrmsImportOB(inputEl){
  if(!_hrmsHasAccess('action.importOB')){notify('Access denied',true);return;}
  var file=inputEl.files[0];if(!file)return;inputEl.value='';
  if(_hrmsMonth&&_hrmsIsMonthLocked(_hrmsMonth)){notify('⚠ '+_hrmsMonthLabel(_hrmsMonth)+' is locked. Unlock to import.',true);return;}
  var statusEl=document.getElementById('hrmsOBStatus');
  statusEl.innerHTML='<span style="color:var(--accent);font-weight:700">Reading file…</span>';
  var reader=new FileReader();
  reader.onload=async function(e){
    try{
      var rows=await _parseXLSX(e.target.result);
      if(!rows.length){statusEl.innerHTML='<span style="color:#dc2626;font-weight:700">No data found in file</span>';return;}
      var empMap={};(DB.hrmsEmployees||[]).forEach(function(emp){empMap[emp.empCode]=emp;});
      var toSave=[],notFound=[];
      for(var i=0;i<rows.length;i++){
        var r=rows[i];
        var code=(r['Emp Code']||r['EmpCode']||r['emp_code']||r['Code']||'').toString().trim();
        if(!code) continue;
        var plOB=parseFloat(r['L-OB']||r['L-OP']||r['PL-OB']||r['Leave OB']||0)||0;
        var advOB=parseFloat(r['Adv-OB']||r['Adv-OP']||r['ADV-OB']||r['Advance OB']||0)||0;
        var emp=empMap[code];
        if(!emp){notFound.push(code);continue;}
        if(!emp.extra) emp.extra={};
        emp.extra.plOB=plOB;
        emp.extra.advOB=advOB;
        toSave.push(emp);
      }
      showSpinner('Importing opening balances…');
      var updated=await _dbSaveBulk('hrmsEmployees',toSave);
      hideSpinner();
      var msg='<span style="color:#16a34a;font-weight:700">Updated '+updated+' employee(s)</span>';
      if(notFound.length) msg+=' <span style="color:#dc2626;font-size:11px">| Not found: '+notFound.join(', ')+'</span>';
      statusEl.innerHTML=msg;
      notify('✅ Opening balances imported: '+updated+' updated');
    }catch(ex){hideSpinner();statusEl.innerHTML='<span style="color:#dc2626;font-weight:700">Error: '+ex.message+'</span>';console.error(ex);}
  };
  reader.readAsArrayBuffer(file);
}

// ═══ MANUAL PRESENT DAYS ════════════════════════════════════════════════
var _hrmsManualPData={};// monthKey → {empCode: days}

function _hrmsLoadManualP(){
  var mk=_hrmsMonth;if(!mk)return;
  _hrmsManualPData[mk]=_hrmsManualPData[mk]||{};
  (DB.hrmsEmployees||[]).forEach(function(e){
    var mp=(e.extra||{}).manualP||{};
    if(mp[mk]!==undefined) _hrmsManualPData[mk][e.empCode]=mp[mk];
  });
  _hrmsRenderManualPList();
}

function _hrmsRenderManualPList(){
  var el=document.getElementById('hrmsManualPList');if(!el)return;
  var mk=_hrmsMonth;if(!mk){el.innerHTML='';return;}
  var pData=_hrmsManualPData[mk]||{};
  // Collect all emp codes that have either manual P or manual PL
  var allCodes={};
  Object.keys(pData).forEach(function(c){allCodes[c]=true;});
  (DB.hrmsEmployees||[]).forEach(function(e){
    if(!e.extra) return;
    if((e.extra.manualPL&&e.extra.manualPL[mk]!==undefined)||(e.extra.manualOT&&e.extra.manualOT[mk]!==undefined)||(e.extra.manualOTS&&e.extra.manualOTS[mk]!==undefined)) allCodes[e.empCode]=true;
  });
  var codes=Object.keys(allCodes).sort();
  if(!codes.length){el.innerHTML='<div style="font-size:11px;color:var(--text3)">No manual entries for this month</div>';return;}
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});
  var _th='padding:3px 8px;border:1px solid var(--border)';
  var h='<table style="border-collapse:collapse;font-size:11px;width:auto"><thead><tr style="background:#f8fafc"><th style="'+_th+';text-align:left">Code</th><th style="'+_th+';text-align:left">Name</th><th style="'+_th+';text-align:right">P Days</th><th style="'+_th+';text-align:right">PL Given</th><th style="'+_th+';text-align:right;color:#7c3aed">OT</th><th style="'+_th+';text-align:right;color:#c2410c">OT@S</th><th style="padding:3px 4px;border:1px solid var(--border)"></th></tr></thead><tbody>';
  codes.forEach(function(ec){
    var emp=empMap[ec];
    var ex=emp&&emp.extra?emp.extra:{};
    var pDays=pData[ec];
    var plGiven=ex.manualPL?ex.manualPL[mk]:undefined;
    var ot=ex.manualOT?ex.manualOT[mk]:undefined;
    var ots=ex.manualOTS?ex.manualOTS[mk]:undefined;
    h+='<tr><td style="'+_th+';font-weight:700;color:var(--accent)">'+ec+'</td>';
    h+='<td style="'+_th+'">'+(emp?_hrmsDispName(emp):'—')+'</td>';
    h+='<td style="'+_th+';text-align:right;font-weight:700">'+(pDays!==undefined?pDays:'—')+'</td>';
    h+='<td style="'+_th+';text-align:right;font-weight:700">'+(plGiven!==undefined?plGiven:'—')+'</td>';
    h+='<td style="'+_th+';text-align:right;font-weight:700;color:#7c3aed">'+(ot!==undefined?ot:'—')+'</td>';
    h+='<td style="'+_th+';text-align:right;font-weight:700;color:#c2410c">'+(ots!==undefined?ots:'—')+'</td>';
    h+='<td style="padding:3px 4px;border:1px solid var(--border)"><button onclick="_hrmsRemoveManualP(\''+ec+'\')" style="font-size:9px;padding:2px 5px;border:1px solid #fecaca;border-radius:3px;background:#fef2f2;color:#dc2626;cursor:pointer">✕</button></td></tr>';
  });
  h+='</tbody></table>';
  el.innerHTML=h;
}

async function _hrmsAddManualP(){
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked. Unlock to make changes.',true);return;}
  var code=document.getElementById('hrmsManualPCode').value.trim();
  var days=document.getElementById('hrmsManualPDays').value;
  var plVal=document.getElementById('hrmsManualPL').value;
  var otVal=document.getElementById('hrmsManualOT').value;
  var otsVal=document.getElementById('hrmsManualOTS').value;
  if(!code){notify('Enter employee code',true);return;}
  var hasDays=days!==''&&!isNaN(parseFloat(days));
  var hasPL=plVal!==''&&!isNaN(parseFloat(plVal));
  var hasOT=otVal!==''&&!isNaN(parseFloat(otVal));
  var hasOTS=otsVal!==''&&!isNaN(parseFloat(otsVal));
  if(!hasDays&&!hasPL&&!hasOT&&!hasOTS){notify('Enter at least one value',true);return;}
  var emp=(DB.hrmsEmployees||[]).find(function(e){return e.empCode===code;});
  if(!emp){notify('Employee '+code+' not found',true);return;}
  if(!emp.extra) emp.extra={};
  if(!emp.extra.manualP) emp.extra.manualP={};
  if(!emp.extra.manualPL) emp.extra.manualPL={};
  if(!emp.extra.manualOT) emp.extra.manualOT={};
  if(!emp.extra.manualOTS) emp.extra.manualOTS={};
  if(!_hrmsManualPData[mk]) _hrmsManualPData[mk]={};
  if(hasDays){
    emp.extra.manualP[mk]=parseFloat(days);
    _hrmsManualPData[mk][code]=parseFloat(days);
  }
  if(hasPL) emp.extra.manualPL[mk]=parseFloat(plVal);
  if(hasOT) emp.extra.manualOT[mk]=parseFloat(otVal);
  if(hasOTS) emp.extra.manualOTS[mk]=parseFloat(otsVal);
  await _dbSave('hrmsEmployees',emp);
  document.getElementById('hrmsManualPCode').value='';
  document.getElementById('hrmsManualPDays').value='';
  document.getElementById('hrmsManualPL').value='';
  document.getElementById('hrmsManualOT').value='';
  document.getElementById('hrmsManualOTS').value='';
  _hrmsRenderManualPList();
  notify('Manual override set for '+code);
}

async function _hrmsRemoveManualP(code){
  var mk=_hrmsMonth;if(!mk)return;
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked.',true);return;}
  var emp=(DB.hrmsEmployees||[]).find(function(e){return e.empCode===code;});
  if(emp&&emp.extra){
    if(emp.extra.manualP) delete emp.extra.manualP[mk];
    if(emp.extra.manualPL) delete emp.extra.manualPL[mk];
    if(emp.extra.manualOT) delete emp.extra.manualOT[mk];
    if(emp.extra.manualOTS) delete emp.extra.manualOTS[mk];
    await _dbSave('hrmsEmployees',emp);
  }
  if(_hrmsManualPData[mk]) delete _hrmsManualPData[mk][code];
  _hrmsRenderManualPList();
  notify('Removed manual entry for '+code);
}

async function _hrmsImportManualP(inputEl){
  if(!_hrmsHasAccess('action.importOB')){notify('Access denied',true);return;}
  var file=inputEl.files[0];if(!file)return;inputEl.value='';
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked. Unlock to import.',true);return;}
  var reader=new FileReader();
  reader.onload=async function(e){
    try{
      var rows=await _parseXLSX(e.target.result);
      if(!rows.length){notify('No data found',true);return;}
      var empMap={};(DB.hrmsEmployees||[]).forEach(function(emp){empMap[emp.empCode]=emp;});
      if(!_hrmsManualPData[mk]) _hrmsManualPData[mk]={};
      var toSave=[],notFound=[];
      for(var i=0;i<rows.length;i++){
        var r=rows[i];
        var code=(r['Emp Code']||r['EmpCode']||r['Code']||'').toString().trim();
        var days=parseFloat(r['Present Days']||r['Days']||r['P']||0);
        if(!code||isNaN(days)) continue;
        var emp=empMap[code];
        if(!emp){notFound.push(code);continue;}
        if(!emp.extra) emp.extra={};
        if(!emp.extra.manualP) emp.extra.manualP={};
        emp.extra.manualP[mk]=days;
        _hrmsManualPData[mk][code]=days;
        toSave.push(emp);
      }
      if(toSave.length){
        showSpinner('Saving…');
        await _dbSaveBulk('hrmsEmployees',toSave);
        hideSpinner();
      }
      _hrmsRenderManualPList();
      var msg='Set manual present for '+toSave.length+' employee(s)';
      if(notFound.length) msg+=' | Not found: '+notFound.join(', ');
      notify(msg);
    }catch(ex){hideSpinner();notify('Error: '+ex.message,true);}
  };
  reader.readAsArrayBuffer(file);
}

// ═══ TDS TAB (month-specific) ═══════════════════════════════════════════
// TDS is stored per-month in emp.extra.tdsByMonth[monthKey].
// The old global emp.extra.tds is kept for backward compat reading but no longer written.

// Get TDS for an employee for the given month (month-specific only — no global fallback)
function _hrmsGetTdsForMonth(emp,mk){
  var ex=emp&&emp.extra;if(!ex) return 0;
  if(ex.tdsByMonth&&ex.tdsByMonth[mk]!==undefined) return +ex.tdsByMonth[mk]||0;
  return 0;
}

function _hrmsTdsRender(){
  var el=document.getElementById('hrmsTdsList');if(!el)return;
  var mk=_hrmsMonth;
  if(!mk){el.innerHTML='<div style="font-size:11px;color:var(--text3)">Select a month above to view TDS entries for that month</div>';return;}
  var emps=(DB.hrmsEmployees||[]).filter(function(e){return _hrmsGetTdsForMonth(e,mk)>0;});
  emps.sort(function(a,b){return(parseInt(a.empCode)||0)-(parseInt(b.empCode)||0);});
  var hdr='<div style="font-size:12px;color:var(--text3);margin-bottom:6px">Showing TDS for <b style="color:var(--accent)">'+_hrmsMonthLabel(mk)+'</b></div>';
  if(!emps.length){el.innerHTML=hdr+'<div style="font-size:11px;color:var(--text3)">No TDS entries for '+_hrmsMonthLabel(mk)+'. Add employees above.</div>';return;}
  var _th='padding:4px 8px;border:1px solid var(--border)';
  var h=hdr+'<table style="border-collapse:collapse;font-size:12px;width:auto!important;table-layout:fixed"><colgroup><col style="width:70px"><col style="width:180px"><col style="width:90px"><col style="width:90px"><col style="width:40px"></colgroup><thead><tr style="background:#f8fafc">';
  h+='<th style="'+_th+';text-align:left">Code</th><th style="'+_th+';text-align:left">Name</th><th style="'+_th+';text-align:left">Plant</th>';
  h+='<th style="'+_th+';text-align:right">TDS/Month</th><th style="'+_th+'"></th></tr></thead><tbody>';
  var total=0;
  var _ov='overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  emps.forEach(function(e){
    var amt=_hrmsGetTdsForMonth(e,mk);
    total+=amt;
    var nm=_hrmsDispName(e);
    h+='<tr><td style="'+_th+';font-family:var(--mono);font-weight:700;color:var(--accent);cursor:pointer;text-decoration:underline" data-emp-code="'+e.empCode+'" title="Click to view employee">'+e.empCode+'</td>';
    h+='<td style="'+_th+';'+_ov+'" title="'+nm+'">'+nm+'</td>';
    h+='<td style="'+_th+';font-size:11px;color:var(--text3);'+_ov+'" title="'+(e.location||'')+'">'+(e.location||'—')+'</td>';
    h+='<td style="'+_th+';text-align:right;font-family:var(--mono);font-weight:700">'+Math.round(amt).toLocaleString()+'</td>';
    h+='<td style="padding:3px 4px;border:1px solid var(--border);text-align:center"><button onclick="_hrmsTdsRemove(\''+e.empCode+'\')" style="font-size:9px;padding:2px 5px;border:1px solid #fecaca;border-radius:3px;background:#fef2f2;color:#dc2626;cursor:pointer">✕</button></td></tr>';
  });
  h+='<tr style="background:#f1f5f9;font-weight:800"><td style="'+_th+'" colspan="3">Total</td>';
  h+='<td style="'+_th+';text-align:right;font-family:var(--mono)">'+Math.round(total).toLocaleString()+'</td><td style="'+_th+'"></td></tr>';
  h+='</tbody></table>';
  el.innerHTML=h;
}

async function _hrmsTdsAdd(){
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked.',true);return;}
  var code=document.getElementById('hrmsTdsCode').value.trim();
  var amt=parseFloat(document.getElementById('hrmsTdsAmount').value);
  if(!code){notify('Enter employee code',true);return;}
  if(!amt||amt<=0){notify('Enter TDS amount',true);return;}
  var emp=(DB.hrmsEmployees||[]).find(function(e){return(e.empCode||'').toUpperCase()===code.toUpperCase();});
  if(!emp){notify('Employee '+code+' not found',true);return;}
  if(!emp.extra) emp.extra={};
  if(!emp.extra.tdsByMonth) emp.extra.tdsByMonth={};
  emp.extra.tdsByMonth[mk]=Math.round(amt);
  showSpinner('Saving TDS…');
  var ok=await _dbSave('hrmsEmployees',emp);
  hideSpinner();
  if(!ok){notify('⚠ Failed to save TDS',true);return;}
  document.getElementById('hrmsTdsCode').value='';
  document.getElementById('hrmsTdsAmount').value='';
  _hrmsTdsRender();
  notify('✅ TDS set for '+emp.empCode+' ('+_hrmsMonthLabel(mk)+'): '+Math.round(amt));
}

async function _hrmsTdsRemove(code){
  var mk=_hrmsMonth;if(!mk)return;
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked.',true);return;}
  var emp=(DB.hrmsEmployees||[]).find(function(e){return e.empCode===code;});
  if(!emp||_hrmsGetTdsForMonth(emp,mk)<=0){_hrmsTdsRender();return;}
  if(!confirm('Remove TDS deduction for '+code+' ('+_hrmsMonthLabel(mk)+')?'))return;
  if(emp.extra&&emp.extra.tdsByMonth) delete emp.extra.tdsByMonth[mk];
  showSpinner('Removing TDS…');
  var ok=await _dbSave('hrmsEmployees',emp);
  hideSpinner();
  if(!ok){notify('⚠ Failed to remove TDS',true);return;}
  _hrmsTdsRender();
  notify('✅ TDS removed for '+code);
}

// ═══ PAYMENTS TAB ════════════════════════════════════════════════════════
var _hrmsActivePayTab='cosmos';

function _hrmsPayTab(tab){
  _hrmsActivePayTab=tab;
  ['cosmos','neft'].forEach(function(t){
    var btn=document.getElementById('hrmsPayTab'+t.charAt(0).toUpperCase()+t.slice(1));
    if(btn){btn.style.borderBottomColor=t===tab?'var(--accent)':'transparent';btn.style.color=t===tab?'var(--accent)':'var(--text3)';}
  });
  _hrmsRenderPayments();
}

function _hrmsRenderPayments(){
  var el=document.getElementById('hrmsPayGrid');if(!el)return;
  var mk=_hrmsMonth;
  if(!mk){el.innerHTML='<div class="empty-state">Select a month above</div>';return;}
  var details=window._hrmsSalDetails||{};
  if(!Object.keys(details).length){el.innerHTML='<div class="empty-state">No salary data. Open Salary tab first.</div>';return;}
  var isCosmos=_hrmsActivePayTab==='cosmos';
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});

  // Compute totals for BOTH Cosmos and NEFT (so they show on either tab)
  var cosmosCount=0,cosmosTotal=0,neftCount=0,neftTotal=0;
  var rows=[];
  Object.keys(details).forEach(function(code){
    var d=details[code];
    var emp=empMap[code];if(!emp)return;
    var net=Math.round(d.net||0);
    if(net<=0)return;
    var bank=(emp.bankName||'').toLowerCase();
    var isCosBank=bank.indexOf('cosmos')>=0;
    if(isCosBank){cosmosCount++;cosmosTotal+=net;}
    else{neftCount++;neftTotal+=net;}
    if(isCosmos&&!isCosBank)return;
    if(!isCosmos&&isCosBank)return;
    rows.push({code:emp.empCode,name:_hrmsDispName(emp),bank:emp.bankName||'',branch:emp.branchName||'',acct:emp.acctNo||'',ifsc:emp.ifsc||'',net:net,location:emp.location||''});
  });
  if(isCosmos){
    rows.sort(function(a,b){return(a.acct||'').localeCompare(b.acct||'');});
  } else {
    rows.sort(function(a,b){var p=(a.ifsc||'').localeCompare(b.ifsc||'');return p!==0?p:(parseInt(a.code)||0)-(parseInt(b.code)||0);});
  }

  var _mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var p=mk.split('-');var monthLabel=_mn[+p[1]]+' '+p[0];
  var totalNet=0;rows.forEach(function(r){totalNet+=r.net;});
  var grandCount=cosmosCount+neftCount,grandTotal=cosmosTotal+neftTotal;

  var _th='padding:4px 6px;font-size:11px;font-weight:700;border:1px solid #cbd5e1;white-space:nowrap';
  var _td='padding:4px 6px;border:1px solid #e2e8f0;font-size:12px;white-space:nowrap';
  // Summary tiles: Cosmos + NEFT + Grand total
  var h='<div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap">';
  h+='<div style="padding:10px 16px;border:2px solid '+(isCosmos?'#f59e0b':'#fde68a')+';border-radius:8px;background:#fef3c7;min-width:180px">'
    +'<div style="font-size:10px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:1px">🏦 Cosmos Bank</div>'
    +'<div style="font-size:18px;font-weight:900;color:#92400e;font-family:var(--mono);margin-top:2px">₹'+cosmosTotal.toLocaleString()+'</div>'
    +'<div style="font-size:11px;color:#92400e;font-weight:600">'+cosmosCount+' employee'+(cosmosCount!==1?'s':'')+'</div>'
  +'</div>';
  h+='<div style="padding:10px 16px;border:2px solid '+(!isCosmos?'#3b82f6':'#93c5fd')+';border-radius:8px;background:#dbeafe;min-width:180px">'
    +'<div style="font-size:10px;font-weight:800;color:#1e40af;text-transform:uppercase;letter-spacing:1px">🏧 NEFT</div>'
    +'<div style="font-size:18px;font-weight:900;color:#1e40af;font-family:var(--mono);margin-top:2px">₹'+neftTotal.toLocaleString()+'</div>'
    +'<div style="font-size:11px;color:#1e40af;font-weight:600">'+neftCount+' employee'+(neftCount!==1?'s':'')+'</div>'
  +'</div>';
  h+='<div style="padding:10px 16px;border:2px solid #16a34a;border-radius:8px;background:#dcfce7;min-width:200px">'
    +'<div style="font-size:10px;font-weight:800;color:#15803d;text-transform:uppercase;letter-spacing:1px">💰 Grand Total</div>'
    +'<div style="font-size:20px;font-weight:900;color:#15803d;font-family:var(--mono);margin-top:2px">₹'+grandTotal.toLocaleString()+'</div>'
    +'<div style="font-size:11px;color:#15803d;font-weight:600">'+grandCount+' employee'+(grandCount!==1?'s':'')+' · '+monthLabel+'</div>'
  +'</div>';
  h+='</div>';
  h+='<div style="font-size:12px;font-weight:800;color:var(--text);margin-bottom:6px">'+(isCosmos?'Cosmos Bank':'NEFT')+' — '+monthLabel+' ('+rows.length+' employees, Total: ₹'+totalNet.toLocaleString()+')</div>';
  h+='<div style="display:inline-block;overflow-x:auto;max-height:500px;overflow-y:auto;border:1.5px solid var(--border);border-radius:8px">';
  h+='<table style="border-collapse:collapse;font-size:12px"><thead><tr style="background:#1e293b;color:#fff">';

  if(isCosmos){
    h+='<th style="'+_th+'">#</th><th style="'+_th+'">Emp Code</th><th style="'+_th+'">Name</th><th style="'+_th+'">Account No</th><th style="'+_th+'">IFSC</th><th style="'+_th+';text-align:right">Net Salary</th>';
  } else {
    h+='<th style="'+_th+'">#</th><th style="'+_th+'">Emp Code</th><th style="'+_th+'">Name</th><th style="'+_th+'">Bank</th><th style="'+_th+'">Branch</th><th style="'+_th+'">Account Type</th><th style="'+_th+'">IFSC</th><th style="'+_th+'">Account No</th><th style="'+_th+';text-align:right">Net Salary</th>';
  }
  h+='</tr></thead><tbody>';

  rows.forEach(function(r,i){
    h+='<tr>';
    h+='<td style="'+_td+';text-align:center;color:var(--text3)">'+(i+1)+'</td>';
    h+='<td style="'+_td+';font-family:var(--mono);font-weight:700;color:var(--accent)">'+r.code+'</td>';
    h+='<td style="'+_td+';font-weight:600">'+r.name+'</td>';
    if(isCosmos){
      h+='<td style="'+_td+';font-family:var(--mono)">'+r.acct+'</td>';
      h+='<td style="'+_td+';font-family:var(--mono)">'+r.ifsc+'</td>';
    } else {
      h+='<td style="'+_td+'">'+r.bank+'</td>';
      h+='<td style="'+_td+'">'+r.branch+'</td>';
      h+='<td style="'+_td+'">Savings</td>';
      h+='<td style="'+_td+';font-family:var(--mono)">'+r.ifsc+'</td>';
      h+='<td style="'+_td+';font-family:var(--mono)">'+r.acct+'</td>';
    }
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);font-weight:700">'+r.net.toLocaleString()+'</td>';
    h+='</tr>';
  });
  // Total row
  h+='<tr style="background:#f1f5f9;font-weight:800"><td style="'+_td+'" colspan="'+(isCosmos?5:8)+'">Total</td>';
  h+='<td style="'+_td+';text-align:right;font-family:var(--mono)">'+totalNet.toLocaleString()+'</td></tr>';
  h+='</tbody></table></div>';
  if(!rows.length){
    // Keep the summary tiles visible, but replace the table with an empty state
    var tileEnd=h.indexOf('<div style="font-size:12px;font-weight:800');
    if(tileEnd>0) h=h.substring(0,tileEnd)+'<div class="empty-state" style="padding:20px">No '+(isCosmos?'Cosmos bank':'non-Cosmos bank')+' employees with salary this month</div>';
    else h='<div class="empty-state">No '+(isCosmos?'Cosmos bank':'non-Cosmos bank')+' employees with salary this month</div>';
  }
  el.innerHTML=h;
}

function _hrmsPayExport(){
  if(!_hrmsHasAccess('action.exportPayments')){notify('Access denied',true);return;}
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  var details=window._hrmsSalDetails||{};
  if(!Object.keys(details).length){notify('No salary data. Open Salary tab first.',true);return;}
  _hrmsPayDatePrompt(function(payDate){_hrmsPayExportGen(payDate);});
}
function _hrmsPayExportGen(payDate){
  var mk=_hrmsMonth;
  var details=window._hrmsSalDetails||{};
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});
  var _mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var p=mk.split('-');var monthLabel=_mn[+p[1]]+'-'+p[0];

  // Collect Cosmos and NEFT rows
  var cosmosRows=[],neftRows=[];
  Object.keys(details).forEach(function(code){
    var d=details[code];var emp=empMap[code];if(!emp)return;
    var net=Math.round(d.net||0);if(net<=0)return;
    var bank=(emp.bankName||'').toLowerCase();
    if(bank.indexOf('cosmos')>=0){
      cosmosRows.push({name:_hrmsDispName(emp),acct:emp.acctNo||'',net:net});
    } else {
      neftRows.push({name:_hrmsDispName(emp),bank:emp.bankName||'',branch:emp.branchName||'',acct:emp.acctNo||'',ifsc:emp.ifsc||'',net:net});
    }
  });
  cosmosRows.sort(function(a,b){return(a.acct||'').localeCompare(b.acct||'');});
  neftRows.sort(function(a,b){var pp=(a.ifsc||'').localeCompare(b.ifsc||'');return pp!==0?pp:a.name.localeCompare(b.name);});

  // ── Build Cosmos sheet ──
  var cosTotal=0;cosmosRows.forEach(function(r){cosTotal+=r.net;});
  var cosN=cosmosRows.length;
  var cosData=[];
  // Row 0: company name (17pt bold, full width)
  cosData.push({company:true,cells:['Kelkar Auto Parts Pvt. Ltd.','','','']});
  // Row 1: title (16pt bold)
  cosData.push({bold:true,title:true,cells:['Salary For The Month '+monthLabel,'','',payDate]});
  // Row 2: blank
  cosData.push(['','','','']);
  // Row 3: table header (repeat on each printed page)
  cosData.push({bold:true,cells:['Sr.','Name','Account Number','Amount in Rs.']});
  // Row 4..4+N-1: data
  cosmosRows.forEach(function(r,i){
    cosData.push([i+1,r.name,{_t:r.acct},{_n:r.net}]);
  });
  // Total row
  var cosTotRow=4+cosN;
  cosData.push({bold:true,cells:['','','Total',{_n:cosTotal}]});
  // Footer
  cosData.push(['','','','']);
  cosData.push({bold:true,cells:['','Paid by consolidated cheque','','']});
  cosData.push({bold:true,cells:['','Cheque No.','Date',payDate]});
  cosData.push({bold:true,cells:['','Amount in Rs.',{_n:cosTotal},'/-']});
  cosData.push({bold:true,ht:30,cells:['','Amount in Words',{_w:_hrmsAmountInWords(cosTotal)},'']});
  cosData.push(['','','','']);
  cosData.push({bold:true,cells:['','','For Kelkar Auto Parts Pvt. Ltd.']});
  cosData.push(['','','','']);
  cosData.push(['','','','']);
  cosData.push({bold:true,cells:['','','Director','']});
  // Excel row = dataIndex+1. Footer indices (0-based): amtRs=cosTotRow+5, amtWords=cosTotRow+6
  var amtRsExcel=cosTotRow+6;// Amount in Rs. row
  var amtWordsExcel=cosTotRow+7;// Amount in Words row
  var cosMerges=['A1:D1','A2:C2','C'+amtRsExcel+':D'+amtRsExcel,'C'+amtWordsExcel+':D'+amtWordsExcel];

  // ── Build NEFT sheets (20 employees per sheet) ──
  var PER_PAGE=20;
  var neftSheets=[];
  var globalSr=0;
  for(var pi=0;pi<neftRows.length;pi+=PER_PAGE){
    var pageRows=neftRows.slice(pi,pi+PER_PAGE);
    var pageNum=Math.floor(pi/PER_PAGE)+1;
    var totalPages=Math.ceil(neftRows.length/PER_PAGE);
    var pageTotal=0;pageRows.forEach(function(r){pageTotal+=r.net;});
    var pN=pageRows.length;
    var nd=[];
    // Row 0: company (17pt bold, center-aligned, full width)
    nd.push({company:true,cells:['KELKAR AUTO PARTS PVT LTD','','','','','','','']});
    // Row 1: subtitle with month + page + date
    var _mn2=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var _nMkP=mk.split('-');var _nMonLabel=_mn2[+_nMkP[1]]+'-'+_nMkP[0].slice(2);
    nd.push({bold:true,cells:['List of Payees for RTGS/NEFT payment for the Salary for the Month '+_nMonLabel,'','','','','','Date',payDate]});
    // Row 2: blank
    nd.push(['','','','','','','','']);
    // Row 3: table header
    nd.push({bold:true,cells:['#','Party Name','Bank Name','Branch','A/c Type','A/C No','IFSC Code','Amount in Rs.']});
    // Row 4..4+pN-1: data
    pageRows.forEach(function(r){
      globalSr++;
      nd.push([globalSr,r.name,r.bank,r.branch,'Saving',{_t:r.acct},r.ifsc,{_n:r.net}]);
    });
    // Total row
    var nTotRow=4+pN;
    nd.push({bold:true,cells:['','','','','','','Total',{_n:pageTotal}]});
    // Footer
    nd.push({bold:true,cells:['','Amount in Words:',{_w:_hrmsAmountInWords(pageTotal)},'','','','','']});
    nd.push(['','Kindly pay above listed payees through NEFT/RTGS from our Cash Credit account No. 00860010268','','','','','','']);
    nd.push({bold:true,cells:['','','','','','','For Kelkar Auto Parts Pvt. Ltd.']});
    nd.push(['','','','','','','','']);
    nd.push(['','','','','','','','']);
    nd.push({bold:true,cells:['','','','','','','Director','']});
    var amtWordsNeft=nTotRow+2;// Excel row (1-indexed) for Amount in Words
    var kindlyPayNeft=nTotRow+4;// Excel row for Kindly pay...
    var nMerges=['A1:H1','A2:E2','C'+amtWordsNeft+':H'+amtWordsNeft,'B'+kindlyPayNeft+':H'+kindlyPayNeft];
    var sheetName=totalPages===1?'NEFT':'NEFT '+pageNum;
    neftSheets.push({name:sheetName,data:nd,stripeStart:4,stripeCount:pN,borderStart:3,borderCount:pN+2,noFilter:true,noFreeze:true,merges:nMerges,
      colWidths:[4,28,18,14,8,20,13,13],landscape:true});
  }

  var allSheets=[{name:'Cosmos',data:cosData,stripeStart:4,stripeCount:cosN,borderStart:3,borderCount:cosN+2,noFilter:true,noFreeze:true,merges:cosMerges,
    colWidths:[5,35,23,13],printTitleRow:3}];
  allSheets=allSheets.concat(neftSheets);
  _downloadMultiSheetXlsx(allSheets,'Payment_'+mk+'.xlsx');
  notify('📤 Exported Cosmos ('+cosmosRows.length+') + NEFT ('+neftRows.length+', '+neftSheets.length+' sheet'+(neftSheets.length!==1?'s':'')+')');

}

// ═══ ESI/PF LIST TAB ═════════════════════════════════════════════════════
function _hrmsRenderEsiPfList(){
  var el=document.getElementById('hrmsEsiPfGrid');if(!el)return;
  var mk=_hrmsMonth;
  if(!mk){el.innerHTML='<div class="empty-state">Select a month above</div>';return;}
  var details=window._hrmsSalDetails||{};
  if(!Object.keys(details).length){el.innerHTML='<div class="empty-state">No salary data. Open Salary tab first.</div>';return;}
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});
  var rows=[];
  Object.keys(details).forEach(function(code){
    var d=details[code];var emp=empMap[code];if(!emp)return;
    if((emp.employmentType||'').toLowerCase().replace(/\s/g,'')!=='onroll') return;
    var gross=Math.round(d.gross||0);if(gross<=0)return;
    var cat=(d.category||emp.category||'').toLowerCase();
    var wdPh=(d.wdCount||0)+(d.phCount||0);
    // Basic + DA: gs>19000→15000; gs<15000→gs; else 15000/(W+PH)*(P+PL+PH)
    var pPLPH=(d.totalP||0)+(d.totalPL||0)+(d.phCount||0);
    var basicDA;
    if(gross>19000) basicDA=15000;
    else if(gross<15000) basicDA=gross;
    else basicDA=wdPh>0?Math.round(15000/wdPh*pPLPH):0;
    var otAllow=gross-basicDA;
    // Payable Days = MROUND(basicDA*(W+PH)/15000, 0.5)
    var payableDays=wdPh>0?Math.round(basicDA*wdPh/15000*2)/2:0;
    var esi=Math.round(d.dedESI||0);
    var pf=Math.round(d.dedPF||0);
    var _lName=emp.lastName||'',_fName=emp.firstName||'',_mName=emp.middleName||'';
    var nameLFM=[_lName,_fName,_mName].filter(Boolean).join(' ');
    var nameFL=[_fName,_lName].filter(Boolean).join(' ');
    var pfComp=Math.round(basicDA*(_hrmsStatutory.pfCompany||13)/100);
    var esiComp=esi>0?Math.round(gross*(_hrmsStatutory.esiCompany||3.25)/100):0;
    rows.push({code:code,nameLFM:nameLFM,nameFL:nameFL,pfComp:pfComp,esiComp:esiComp,
      uan:emp.uan||'',esiNo:emp.esiNo||'',pfNo:emp.pfNo||'',payableDays:payableDays,
      basicDA:basicDA,otAllow:otAllow,gross:gross,esi:esi,pf:pf,cat:cat,sortKey:cat==='worker'?0:1});
  });
  rows.sort(function(a,b){if(a.sortKey!==b.sortKey)return a.sortKey-b.sortKey;return a.nameLFM.localeCompare(b.nameLFM);});
  if(!rows.length){el.innerHTML='<div class="empty-state">No On Roll employees with salary for this month</div>';return;}
  var _r=function(v){return Math.round(v).toLocaleString('en-IN');};
  var _f=function(v){if(v%1===0)return String(v);return v.toFixed(1);};
  var _mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var p=mk.split('-');var monthLabel=_mn[+p[1]]+' '+p[0];
  // Summary totals
  var sumBasicDA=0,sumGross=0,sumPfEmp=0,sumEsiEmp=0,sumPfComp=0,sumEsiComp=0;
  rows.forEach(function(r){sumBasicDA+=r.basicDA;sumGross+=r.gross;sumPfEmp+=r.pf;sumEsiEmp+=r.esi;sumPfComp+=r.pfComp;sumEsiComp+=r.esiComp;});
  var pfWorkerPct=_hrmsStatutory.pfWorker||12;
  var pfCompPct=_hrmsStatutory.pfCompany||13;
  var esiWorkerPct=_hrmsStatutory.esiWorker||0.75;
  var esiCompPct=_hrmsStatutory.esiCompany||3.25;
  var _th='padding:5px 4px;font-size:11px;font-weight:800;background:#f1f5f9;border:1px solid #cbd5e1;white-space:nowrap;color:#1e293b;text-align:center';
  var _td='padding:4px 5px;font-size:12px;border:1px solid #e2e8f0;white-space:nowrap';
  // Sticky summary header with export button
  var h='<div style="position:sticky;top:0;z-index:3;background:#fff;padding-bottom:8px">';
  h+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><div style="font-size:13px;font-weight:800;color:var(--text)">ESI / PF List \u2014 '+monthLabel+' ('+rows.length+' employees)</div><div style="margin-left:auto"><button onclick="_hrmsEsiPfExport()" style="padding:6px 14px;font-size:12px;font-weight:700;background:#f0fdf4;border:1.5px solid #86efac;color:#16a34a;border-radius:6px;cursor:pointer">\ud83d\udce4 Export</button></div></div>';
  // Summary — two side-by-side cards
  h+='<div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap">';
  // PF card
  h+='<div style="border:1.5px solid #e9d5ff;border-radius:8px;background:#faf5ff;padding:8px 14px;min-width:220px">';
  h+='<div style="display:flex;justify-content:space-between;gap:16px;margin-bottom:4px"><span style="font-size:11px;font-weight:700;color:var(--text2)">Basic + DA</span><span style="font-size:13px;font-weight:900;font-family:var(--mono)">'+_r(sumBasicDA)+'</span></div>';
  h+='<div style="display:flex;justify-content:space-between;gap:16px"><span style="font-size:11px;font-weight:700;color:#7c3aed">PF @ '+pfWorkerPct+'%</span><span style="font-size:13px;font-weight:800;font-family:var(--mono);color:#7c3aed">'+_r(sumPfEmp)+'</span></div>';
  h+='<div style="display:flex;justify-content:space-between;gap:16px"><span style="font-size:11px;font-weight:700;color:#7c3aed">PF @ '+pfCompPct+'%</span><span style="font-size:13px;font-weight:800;font-family:var(--mono);color:#7c3aed">'+_r(sumPfComp)+'</span></div>';
  h+='<div style="display:flex;justify-content:space-between;gap:16px;margin-top:4px;padding-top:4px;border-top:2px solid #7c3aed"><span style="font-size:12px;font-weight:900;color:#7c3aed">PF</span><span style="font-size:15px;font-weight:900;font-family:var(--mono);color:#7c3aed">'+_r(sumPfEmp+sumPfComp)+'</span></div>';
  h+='</div>';
  // ESI card
  h+='<div style="border:1.5px solid #fecaca;border-radius:8px;background:#fef2f2;padding:8px 14px;min-width:220px">';
  h+='<div style="display:flex;justify-content:space-between;gap:16px;margin-bottom:4px"><span style="font-size:11px;font-weight:700;color:var(--text2)">Gross Salary</span><span style="font-size:13px;font-weight:900;font-family:var(--mono)">'+_r(sumGross)+'</span></div>';
  h+='<div style="display:flex;justify-content:space-between;gap:16px"><span style="font-size:11px;font-weight:700;color:#dc2626">ESI @ '+esiWorkerPct+'%</span><span style="font-size:13px;font-weight:800;font-family:var(--mono);color:#dc2626">'+_r(sumEsiEmp)+'</span></div>';
  h+='<div style="display:flex;justify-content:space-between;gap:16px"><span style="font-size:11px;font-weight:700;color:#dc2626">ESI @ '+esiCompPct+'%</span><span style="font-size:13px;font-weight:800;font-family:var(--mono);color:#dc2626">'+_r(sumEsiComp)+'</span></div>';
  h+='<div style="display:flex;justify-content:space-between;gap:16px;margin-top:4px;padding-top:4px;border-top:2px solid #dc2626"><span style="font-size:12px;font-weight:900;color:#dc2626">ESI</span><span style="font-size:15px;font-weight:900;font-family:var(--mono);color:#dc2626">'+_r(sumEsiEmp+sumEsiComp)+'</span></div>';
  h+='</div></div>';
  h+='</div>';
  h+='<table style="border-collapse:collapse;font-size:12px;white-space:nowrap;width:auto">';
  h+='<thead style="position:sticky;top:0;z-index:2"><tr>';
  h+='<th style="'+_th+'">Sr.</th>';
  h+='<th style="'+_th+';text-align:left">Name</th>';
  h+='<th style="'+_th+';text-align:left">Name</th>';
  h+='<th style="'+_th+'">UAN No.</th>';
  h+='<th style="'+_th+'">ESI No.</th>';
  h+='<th style="'+_th+'">PF No.</th>';
  h+='<th style="'+_th+';text-align:right">Payable Days</th>';
  h+='<th style="'+_th+';text-align:right">Basic + DA</th>';
  h+='<th style="'+_th+';text-align:right">OT + Allowance</th>';
  h+='<th style="'+_th+';text-align:right">Gross Salary</th>';
  h+='<th style="'+_th+';text-align:right">ESI @ '+(_hrmsStatutory.esiWorker||0.75)+'%</th>';
  h+='<th style="'+_th+';text-align:right">PF @ '+(_hrmsStatutory.pfWorker||12)+'%</th>';
  h+='</tr></thead><tbody>';
  var totals={payableDays:0,basicDA:0,otAllow:0,gross:0,esi:0,pf:0};
  var prevCat='';var sn=0;
  rows.forEach(function(r,i){
    if(prevCat!==''&&r.cat!==prevCat){
      h+='<tr style="background:#fef3c7"><td colspan="12" style="padding:4px 8px;font-size:11px;font-weight:800;color:#92400e;border:1px solid #e2e8f0">Staff</td></tr>';
    }
    prevCat=r.cat;sn++;
    var bg=sn%2===0?'background:#f8f9fb':'';
    h+='<tr style="'+bg+'">';
    h+='<td style="'+_td+';text-align:center;color:var(--text3)">'+sn+'</td>';
    h+='<td style="'+_td+';font-weight:700">'+r.nameLFM+'</td>';
    h+='<td style="'+_td+'">'+r.nameFL+'</td>';
    h+='<td style="'+_td+';font-family:var(--mono);text-align:center">'+r.uan+'</td>';
    h+='<td style="'+_td+';font-family:var(--mono);text-align:center">'+r.esiNo+'</td>';
    h+='<td style="'+_td+';font-family:var(--mono);text-align:center">'+r.pfNo+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono)">'+_f(r.payableDays)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono)">'+_r(r.basicDA)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono)">'+_r(r.otAllow)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);font-weight:700">'+_r(r.gross)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono)">'+_r(r.esi)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono)">'+_r(r.pf)+'</td>';
    h+='</tr>';
    totals.payableDays+=r.payableDays;totals.basicDA+=r.basicDA;totals.otAllow+=r.otAllow;totals.gross+=r.gross;totals.esi+=r.esi;totals.pf+=r.pf;
  });
  var _stk='position:sticky;bottom:0;z-index:1;background:#e2e8f0';
  var _tf='padding:4px 5px;text-align:right;font-family:var(--mono);border:1px solid #cbd5e1;color:#1e293b;font-weight:900;'+_stk;
  h+='</tbody><tfoot><tr><td colspan="6" style="padding:4px 6px;border:1px solid #cbd5e1;font-weight:900;'+_stk+'">Total ('+rows.length+')</td>';
  h+='<td style="'+_tf+'">'+_f(totals.payableDays)+'</td>';
  h+='<td style="'+_tf+'">'+_r(totals.basicDA)+'</td>';
  h+='<td style="'+_tf+'">'+_r(totals.otAllow)+'</td>';
  h+='<td style="'+_tf+'">'+_r(totals.gross)+'</td>';
  h+='<td style="'+_tf+'">'+_r(totals.esi)+'</td>';
  h+='<td style="'+_tf+'">'+_r(totals.pf)+'</td>';
  h+='</tr></tfoot></table>';
  el.innerHTML=h;
  window._hrmsEsiPfRows=rows;
}

function _hrmsEsiPfExport(){
  if(!_hrmsHasAccess('action.exportEsiPf')){notify('Access denied',true);return;}
  var rows=window._hrmsEsiPfRows;
  if(!rows||!rows.length){notify('No ESI/PF data. Open the tab first.',true);return;}
  var mk=_hrmsMonth||'';
  var headers=['Sr.','Name','Name','UAN No.','ESI No.','PF No.','Payable Days (P+PH)','Basic + DA','OT + Allowance','Gross Salary','ESI @ '+(_hrmsStatutory.esiWorker||0.75)+'%','PF @ '+(_hrmsStatutory.pfWorker||12)+'%'];
  var out=[headers];
  rows.forEach(function(r,i){
    out.push([i+1,r.nameLFM,r.nameFL,{_t:r.uan},{_t:r.esiNo},{_t:r.pfNo},r.payableDays,{_n:r.basicDA},{_n:r.otAllow},{_n:r.gross},{_n:r.esi},{_n:r.pf}]);
  });
  var tot={payableDays:0,basicDA:0,otAllow:0,gross:0,esi:0,pf:0};
  rows.forEach(function(r){tot.payableDays+=r.payableDays;tot.basicDA+=r.basicDA;tot.otAllow+=r.otAllow;tot.gross+=r.gross;tot.esi+=r.esi;tot.pf+=r.pf;});
  out.push({bold:true,cells:['','','','','','Total',tot.payableDays,{_n:tot.basicDA},{_n:tot.otAllow},{_n:tot.gross},{_n:tot.esi},{_n:tot.pf}]});
  _downloadMultiSheetXlsx([{name:'ESI PF List',data:out,stripeStart:1,stripeCount:rows.length,borderStart:0,borderCount:rows.length+2,
    colWidths:[4,18,18,16,16,16,10,14,14,14,10,10]}],'ESI_PF_List_'+mk+'.xlsx');
  notify('\ud83d\udce4 Exported ESI/PF list ('+rows.length+' employees)');
}

// ═══ PT DETAILS TAB ══════════════════════════════════════════════════════
// On Roll only — mirrors the filter on ESI/PF List so both summaries cover
// the same population. Shows a single rules-applied summary (all configured
// PT rules, with 0-count rows for rules nobody matched this month) plus a
// total row — no per-employee list, as PT is a slab-driven deduction and
// the rule-level breakdown is what admins actually reconcile.
function _hrmsRenderPtDetails(){
  var el=document.getElementById('hrmsPtGrid');if(!el)return;
  var mk=_hrmsMonth;
  if(!mk){el.innerHTML='<div class="empty-state">Select a month above</div>';return;}
  var details=window._hrmsSalDetails||{};
  if(!Object.keys(details).length){el.innerHTML='<div class="empty-state">No salary data. Open Salary tab first.</div>';return;}
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});
  var _mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var _moLower=['','jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  var p=mk.split('-');var mo=+p[1];var monthLabel=_mn[mo]+' '+p[0];
  var monthLow=_moLower[mo];
  var rules=(_hrmsStatutory.ptRules||[]).slice();
  // Mirror of _hrmsCalcPT but also returns which rule matched, so we can
  // aggregate per-rule counts.
  var matchRule=function(gross,gen,moKey){
    var gl=(gen||'').toLowerCase();
    var passes=[
      function(r){return r.gender&&r.gender.toLowerCase()===gl&&(!r.month||r.month.toLowerCase()===moKey);},
      function(r){return !r.gender&&r.month&&r.month.toLowerCase()===moKey;},
      function(r){return !r.gender&&!r.month;}
    ];
    for(var pi=0;pi<passes.length;pi++){
      for(var i=0;i<rules.length;i++){
        var r=rules[i];if(!passes[pi](r)) continue;
        var match=(r.op==='lt'?gross<r.threshold:r.op==='gte'?gross>=r.threshold:false);
        if(match) return {amount:r.amount,ruleIdx:i,rule:r};
      }
    }
    return {amount:0,ruleIdx:-1,rule:null};
  };
  // Per-rule aggregate. Every configured rule gets a row, even when count=0,
  // so the table doubles as a visual inventory of the slab policy.
  var ruleAgg=rules.map(function(r,i){return {idx:i,rule:r,count:0,amount:0};});
  var noMatchAgg={idx:-1,rule:null,count:0,amount:0};
  var totalHead=0,totalPt=0,paidHead=0;
  // Iterate every On Roll employee processed for this month's salary — keep
  // zero-gross employees in the count so the PT headcount ties out with the
  // Salary tab's On Roll total. A zero-gross employee naturally falls into
  // the lowest slab (Gross < threshold) with ₹0 PT, which is correct.
  Object.keys(details).forEach(function(code){
    var d=details[code];var emp=empMap[code];if(!emp)return;
    // On Roll only — Contract / Piece Rate don't have PT slabs applied here.
    if((emp.employmentType||'').toLowerCase().replace(/\s/g,'')!=='onroll') return;
    var gross=Math.round(d.gross||0);
    var res=matchRule(gross,emp.gender||'',monthLow);
    totalHead++;totalPt+=res.amount;if(res.amount>0) paidHead++;
    var bucket=res.ruleIdx>=0?ruleAgg[res.ruleIdx]:noMatchAgg;
    bucket.count++;bucket.amount+=res.amount;
  });
  var _r=function(v){return Math.round(v).toLocaleString('en-IN');};
  var _th='padding:6px 6px;font-size:11px;font-weight:800;background:#f1f5f9;border:1px solid #cbd5e1;white-space:nowrap;color:#1e293b;text-align:center';
  var _td='padding:5px 6px;font-size:12px;border:1px solid #e2e8f0;white-space:nowrap';
  var canExport=(typeof _hrmsHasAccess!=='function')||_hrmsHasAccess('action.exportPt');
  var h='<div style="position:sticky;top:0;z-index:3;background:#fff;padding-bottom:8px">';
  h+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><div style="font-size:13px;font-weight:800;color:var(--text)">PT Details \u2014 '+monthLabel+' (On Roll)</div>';
  if(canExport) h+='<div style="margin-left:auto"><button onclick="_hrmsPtExport()" style="padding:6px 14px;font-size:12px;font-weight:700;background:#f0fdf4;border:1.5px solid #86efac;color:#16a34a;border-radius:6px;cursor:pointer">\ud83d\udce4 Export</button></div>';
  h+='</div>';
  // Rules-applied summary — all configured rules, plus a tail row for
  // employees who didn't match any rule (only shown if count > 0 since the
  // "no rule" bucket isn't part of the policy inventory).
  h+='<table style="border-collapse:collapse;font-size:12px;width:auto;margin-bottom:0">';
  h+='<thead><tr>';
  h+='<th style="'+_th+'">#</th>';
  h+='<th style="'+_th+';text-align:left">Condition</th>';
  h+='<th style="'+_th+'">Gender</th>';
  h+='<th style="'+_th+'">Month</th>';
  h+='<th style="'+_th+';text-align:right">PT Rate</th>';
  h+='<th style="'+_th+';text-align:right">Headcount</th>';
  h+='<th style="'+_th+';text-align:right">Amount</th>';
  h+='</tr></thead><tbody>';
  var _renderRow=function(a){
    var condTxt,genTxt,moTxt,rateTxt;
    if(a.rule){
      var opSym=a.rule.op==='lt'?'<':a.rule.op==='gte'?'\u2265':'?';
      condTxt='Gross '+opSym+' '+_r(a.rule.threshold||0);
      genTxt=a.rule.gender?a.rule.gender:'All';
      moTxt=a.rule.month?a.rule.month.toUpperCase():'All';
      rateTxt='\u20b9 '+_r(a.rule.amount||0);
    } else { condTxt='No matching rule'; genTxt='\u2014'; moTxt='\u2014'; rateTxt='\u2014'; }
    var zero=a.count===0;
    var tdZero=zero?';color:var(--text3);opacity:.7':'';
    h+='<tr'+(zero?' style="background:#fafbfc"':'')+'>';
    h+='<td style="'+_td+';text-align:center'+tdZero+'">'+(a.idx>=0?(a.idx+1):'\u2014')+'</td>';
    h+='<td style="'+_td+tdZero+'">'+condTxt+(a.rule&&a.rule.remark?' <span style="color:var(--text3);font-size:11px">\u2014 '+a.rule.remark+'</span>':'')+'</td>';
    h+='<td style="'+_td+';text-align:center'+tdZero+'">'+genTxt+'</td>';
    h+='<td style="'+_td+';text-align:center'+tdZero+'">'+moTxt+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono)'+tdZero+'">'+rateTxt+'</td>';
    h+='<td style="'+_td+';text-align:right;font-weight:'+(a.count>0?'800':'400')+tdZero+'">'+a.count+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);font-weight:'+(a.amount>0?'800':'400')+';color:'+(a.amount>0?'#a16207':'var(--text3)')+tdZero+'">'+_r(a.amount)+'</td>';
    h+='</tr>';
  };
  ruleAgg.forEach(_renderRow);
  if(noMatchAgg.count>0) _renderRow(noMatchAgg);
  // Total footer
  var _stk='background:#e2e8f0';
  var _tf='padding:6px 6px;text-align:right;font-family:var(--mono);border:1px solid #cbd5e1;color:#1e293b;font-weight:900;'+_stk;
  h+='</tbody><tfoot><tr>';
  h+='<td colspan="5" style="padding:6px 8px;border:1px solid #cbd5e1;font-weight:900;text-align:right;'+_stk+'">Total Headcount &amp; PT</td>';
  h+='<td style="'+_tf+'">'+totalHead+'</td>';
  h+='<td style="'+_tf+';color:#a16207">\u20b9 '+_r(totalPt)+'</td>';
  h+='</tr>';
  if(paidHead<totalHead){
    h+='<tr><td colspan="7" style="padding:4px 8px;border:1px solid #cbd5e1;background:#f8fafc;font-size:11px;color:var(--text3);text-align:right">'+(totalHead-paidHead)+' of '+totalHead+' On Roll employees are PT-exempt this month</td></tr>';
  }
  h+='</tfoot></table>';
  el.innerHTML=h;
  window._hrmsPtRuleAgg=ruleAgg;
  window._hrmsPtNoMatchAgg=noMatchAgg;
  window._hrmsPtTotals={head:totalHead,pt:totalPt,paid:paidHead};
}

// ═══ WORKER'S SALARY SLIP (PDF) ═══════════════════════════════════════════
// Generates a per-worker salary slip PDF. Each worker gets its own 2-row
// block (31-col header + values) repeated across the document — so the
// header restates on every record. Uses jsPDF + AutoTable (already loaded
// in hrms.html). Scoped to On Roll Worker category, matching the business
// need for monthly wage reconciliation that only wage workers require.
function _hrmsWorkerSalarySlip(){
  if(typeof _hrmsHasAccess==='function'&&!_hrmsHasAccess('action.exportWorkerSlip')){notify('Access denied',true);return;}
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  var details=window._hrmsSalDetails||{};
  if(!Object.keys(details).length){notify('No salary data. Open Salary tab first.',true);return;}
  if(!window.jspdf||!window.jspdf.jsPDF){notify('PDF library not loaded',true);return;}
  var _mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var p=mk.split('-');var mo=+p[1];var monthLabel=_mn[mo]+'-'+p[0].slice(2);// e.g. "Mar-26"
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});
  // Workers only, On Roll only, with positive gross (wage workers without
  // any salary for the month don't need a slip — they can be added back if
  // the user asks).
  var rows=[];
  Object.keys(details).forEach(function(code){
    var d=details[code];var emp=empMap[code];if(!emp)return;
    var cat=(d.category||emp.category||'').toLowerCase();
    if(cat!=='worker') return;
    var et=(emp.employmentType||'').toLowerCase().replace(/\s/g,'');
    if(et!=='onroll') return;
    rows.push({code:code,d:d,emp:emp});
  });
  if(!rows.length){notify('No On Roll Worker salary data for this month',true);return;}
  // Stable sort: plant, then empCode numeric.
  rows.sort(function(a,b){
    var pa=(a.d.location||a.emp.location||'').toString();
    var pb=(b.d.location||b.emp.location||'').toString();
    if(pa!==pb) return pa.localeCompare(pb);
    return (parseInt(a.code)||0)-(parseInt(b.code)||0);
  });
  var headers=['Plant','EMP',monthLabel,'P','A','PL','PH','OT','OT 1.5','OT 2',
    'P','AB','PL','OT','OT 1.5','OT 2','VP','GS',
    'OB','FTM','T','DED','CB',
    'PT','PF','ESI','ADV','TDS','OTH','TOT','NS'];
  var doc=new jspdf.jsPDF({orientation:'landscape',unit:'mm',format:'a3',compress:true});
  var _r=function(v){return Math.round(v||0);};
  var _plt=function(loc){return (loc||'').replace(/plant[\s\-]*/i,'P').replace(/^(.{4}).*$/,'$1');};
  doc.setFontSize(18);doc.setFont('helvetica','bold');
  doc.text("Worker's Salary Slip — "+monthLabel+' ('+rows.length+' workers)',14,13);
  var startY=22;
  rows.forEach(function(r){
    var d=r.d;var emp=r.emp;
    // Advance: advMonth and advTotal aren't stored on the detail object, so
    // derive them from the stored balances: advCB = advTotal - advDed, and
    // advTotal = advOB + advMonth.
    var advOB=d.advOB||0, advCB=d.advCB||0, advDed=d.dedAdv||0;
    var advTotal=advCB+advDed;
    var advMonth=advTotal-advOB;
    var body=[[
      _plt(d.location||emp.location||''),
      r.code,
      d.name||emp.name||'',
      _r(d.totalP), _r(d.totalA), _r(d.plGiven||0), _r(d.phCount),
      _r(d.otAt1), _r(d.otAt15), _r(d.otAt2),
      _r(d.salForP), _r(d.salAb), _r(d.salForPL),
      _r(d.salOT1), _r(d.salOT15), _r(d.salOT2),
      _r(d.allowance), _r(d.gross),
      _r(advOB), _r(advMonth), _r(advTotal), _r(advDed), _r(advCB),
      _r(d.dedPT), _r(d.dedPF), _r(d.dedESI), _r(d.dedAdv), _r(d.dedTDS), _r(d.dedOther), _r(d.dedTotal),
      _r(d.net)
    ]];
    // Estimate the block height (header row + 1 body row + padding) so we
    // can force a page break BEFORE this slip if it won't fit — autoTable's
    // `pageBreak:'avoid'` is also set as a safety net. Each row at fontSize
    // 12 + cellPadding 1.4 ≈ 8mm, so a 2-row block is ~16mm plus 3mm gap.
    var _blockH=18;
    var _pageH=297,_bottomMargin=14;
    if(startY+_blockH>_pageH-_bottomMargin){ doc.addPage(); startY=14; }
    doc.autoTable({
      startY:startY,
      head:[headers],
      body:body,
      margin:{left:10,right:10,bottom:_bottomMargin},
      styles:{fontSize:12,cellPadding:1.4,lineColor:[180,180,180],lineWidth:0.1,halign:'center',valign:'middle'},
      headStyles:{fillColor:[226,232,240],textColor:[15,23,42],fontStyle:'bold',fontSize:12,halign:'center'},
      columnStyles:{2:{halign:'left',cellWidth:50}},// Name column wider + left-aligned
      theme:'grid',
      tableWidth:'auto',
      // Keep header + body row together — never split a slip across pages.
      pageBreak:'avoid',
      rowPageBreak:'avoid',
      // Color-code the three main amount groups so admins can read across a
      // dense 31-col row. Columns mirror the on-screen Salary tab palette:
      //   10-17 Salary (P..GS)         → emerald-100
      //   18-22 Advance (OB..CB)       → red-50
      //   23-29 Deductions (PT..TOT)   → slate-100
      // Applied via didParseCell so both the header and body cells in each
      // group share the same tint.
      didParseCell:function(data){
        var c=data.column.index;
        if(c>=10&&c<=17) data.cell.styles.fillColor=[220,252,231];
        else if(c>=18&&c<=22) data.cell.styles.fillColor=[254,242,242];
        else if(c>=23&&c<=29) data.cell.styles.fillColor=[241,245,249];
      }
    });
    startY=doc.lastAutoTable.finalY+3;
  });
  doc.save("Workers_Salary_Slip_"+mk+".pdf");
  notify("\ud83d\udcc4 Worker's Salary Slip generated ("+rows.length+' workers)');
}

function _hrmsPtExport(){
  if(typeof _hrmsHasAccess==='function'&&!_hrmsHasAccess('action.exportPt')){notify('Access denied',true);return;}
  var agg=window._hrmsPtRuleAgg;
  if(!agg){notify('No PT data. Open the tab first.',true);return;}
  var noMatch=window._hrmsPtNoMatchAgg;
  var totals=window._hrmsPtTotals||{head:0,pt:0};
  var mk=_hrmsMonth||'';
  var _r=function(v){return Math.round(v||0);};
  var headers=['#','Condition','Gender','Month','PT Rate','Headcount','Amount','Remark'];
  var out=[headers];
  var _row=function(a){
    if(a.rule){
      var opSym=a.rule.op==='lt'?'<':a.rule.op==='gte'?'>=':'?';
      out.push([a.idx>=0?(a.idx+1):'',
        'Gross '+opSym+' '+_r(a.rule.threshold),
        a.rule.gender||'All',
        a.rule.month?a.rule.month.toUpperCase():'All',
        {_n:_r(a.rule.amount)},
        a.count,
        {_n:_r(a.amount)},
        a.rule.remark||'']);
    } else {
      out.push(['','No matching rule','\u2014','\u2014','\u2014',a.count,{_n:_r(a.amount)},'']);
    }
  };
  agg.forEach(_row);
  if(noMatch&&noMatch.count>0) _row(noMatch);
  out.push({bold:true,cells:['','','','','Total',totals.head,{_n:_r(totals.pt)},'']});
  _downloadMultiSheetXlsx([{name:'PT Details',data:out,stripeStart:1,stripeCount:agg.length+(noMatch&&noMatch.count>0?1:0),borderStart:0,borderCount:out.length,
    colWidths:[4,22,10,8,12,12,14,30]}],'PT_Details_'+mk+'.xlsx');
  notify('\ud83d\udce4 Exported PT details');
}

// ═══ AMOUNT IN WORDS (Indian: Lakhs/Crores) ═════════════════════════════
function _hrmsAmountInWords(n){
  n=Math.round(n);if(n===0)return 'Rupees Zero Only';
  var ones=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  var tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  var _w=function(num){
    if(num<20) return ones[num];
    if(num<100) return tens[Math.floor(num/10)]+(num%10?' '+ones[num%10]:'');
    return ones[Math.floor(num/100)]+' Hundred'+(num%100?' '+_w(num%100):'');
  };
  var parts=[];
  if(n>=10000000){parts.push(_w(Math.floor(n/10000000))+' Crore');n%=10000000;}
  if(n>=100000){parts.push(_w(Math.floor(n/100000))+' Lakh');n%=100000;}
  if(n>=1000){parts.push(_w(Math.floor(n/1000))+' Thousand');n%=1000;}
  if(n>0) parts.push(_w(n));
  return 'Rupees '+parts.join(' ')+' and Paise Zero Only';
}
function _hrmsIndianNum(n){return Math.round(n).toLocaleString('en-IN');}
function _hrmsFmtDateShort(d){if(!d)return '';var dt=new Date(d);if(isNaN(dt))return d;var _m=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return dt.getDate()+'-'+_m[dt.getMonth()+1]+'-'+String(dt.getFullYear()).slice(-2);}

// ═══ PAYMENT DATE PROMPT ══════════════════════════════════════════════════
function _hrmsPayDatePrompt(cb){
  var existing=document.getElementById('_hrmsPayDateOverlay');
  if(existing) existing.remove();
  var def=new Date().toISOString().slice(0,10);
  var pop=document.createElement('div');
  pop.id='_hrmsPayDateOverlay';
  pop.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center';
  pop.innerHTML='<div style="background:#fff;border-radius:12px;padding:20px 24px;box-shadow:0 12px 40px rgba(0,0,0,.3);min-width:280px">'
    +'<div style="font-size:14px;font-weight:900;margin-bottom:10px">Payment Date</div>'
    +'<input type="date" id="_payDateInput" value="'+def+'" style="font-size:14px;padding:8px 12px;border:2px solid var(--accent);border-radius:6px;width:100%;box-sizing:border-box">'
    +'<div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">'
    +'<button onclick="document.getElementById(\'_hrmsPayDateOverlay\').remove()" style="padding:6px 16px;font-size:12px;font-weight:700;border:1.5px solid var(--border);border-radius:6px;background:var(--surface2);cursor:pointer">Cancel</button>'
    +'<button id="_payDateOK" style="padding:6px 16px;font-size:12px;font-weight:700;border:none;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer">Generate</button>'
    +'</div></div>';
  document.body.appendChild(pop);
  document.getElementById('_payDateOK').onclick=function(){
    var v=document.getElementById('_payDateInput').value;
    pop.remove();
    cb(_hrmsFmtDateShort(v||def));
  };
}

// Single PDF button — generates Cosmos or NEFT based on active tab
function _hrmsPayPDF(){
  if(_hrmsActivePayTab==='cosmos') _hrmsPayCosmosPDF();
  else _hrmsPayNeftPDF();
}

// ═══ COSMOS BANK PDF ═════════════════════════════════════════════════════
function _hrmsPayCosmosPDF(){
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  var details=window._hrmsSalDetails||{};
  if(!Object.keys(details).length){notify('No salary data. Open Salary tab first.',true);return;}
  _hrmsPayDatePrompt(function(payDate){_hrmsPayCosmosPDFGen(payDate);});
}
function _hrmsPayCosmosPDFGen(payDate){
  var mk=_hrmsMonth;
  var details=window._hrmsSalDetails||{};
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});
  var _mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var p=mk.split('-');var monthLabel=_mn[+p[1]]+'-'+p[0];
  var rows=[];
  Object.keys(details).forEach(function(code){
    var d=details[code];var emp=empMap[code];if(!emp)return;
    var net=Math.round(d.net||0);if(net<=0)return;
    if((emp.bankName||'').toLowerCase().indexOf('cosmos')<0)return;
    rows.push({name:_hrmsDispName(emp),acct:emp.acctNo||'',net:net});
  });
  rows.sort(function(a,b){return(a.acct||'').localeCompare(b.acct||'');});
  if(!rows.length){notify('No Cosmos bank employees',true);return;}
  var total=0;rows.forEach(function(r){total+=r.net;});
  var h='<html><head><title>Cosmos Payment '+mk+'</title><style>'
    +'@page{size:A4;margin:15mm 20mm}'
    +'body{font-family:Calibri,Arial,sans-serif;font-size:12px;color:#000}'
    +'table{width:100%;border-collapse:collapse}td,th{padding:4px 6px;border:1px solid #000;font-size:11px}'
    +'th{font-weight:700;background:#f0f0f0;text-align:center}'
    +'.nb{border:none}.right{text-align:right}.bold{font-weight:700}'
    +'@media print{.no-print{display:none}}'
    +'</style></head><body>';
  h+='<table style="border:none;margin-bottom:8px"><tr><td class="nb" style="font-size:14px;font-weight:700">Salary For The Month '+monthLabel+'</td><td class="nb right" style="font-size:12px">'+payDate+'</td></tr>';
  h+='<tr><td class="nb" style="font-size:13px;font-weight:700">Kelkar Auto Parts Pvt. Ltd.</td><td class="nb"></td></tr></table>';
  h+='<table><thead><tr><th>Sr.</th><th style="text-align:left">Name</th><th>Account Number</th><th style="text-align:right">Amount in Rs.</th></tr></thead><tbody>';
  rows.forEach(function(r,i){
    h+='<tr><td style="text-align:center">'+(i+1)+'</td><td>'+r.name+'</td><td style="text-align:center">'+r.acct+'</td><td class="right bold">'+_hrmsIndianNum(r.net)+'</td></tr>';
  });
  h+='<tr><td colspan="3" class="right bold">Total</td><td class="right bold">'+_hrmsIndianNum(total)+'</td></tr>';
  h+='</tbody></table>';
  h+='<table style="border:none;margin-top:16px;font-size:11px">';
  h+='<tr><td class="nb" width="20%"></td><td class="nb bold">Paid by consolidated cheque</td><td class="nb" colspan="2"></td></tr>';
  h+='<tr><td class="nb"></td><td class="nb bold">Cheque No.</td><td class="nb bold">Date</td><td class="nb">'+payDate+'</td></tr>';
  h+='<tr><td class="nb"></td><td class="nb bold">Amount in Rs.</td><td class="nb bold">'+_hrmsIndianNum(total)+'</td><td class="nb">/-</td></tr>';
  h+='<tr><td class="nb"></td><td class="nb bold">Amount in Words</td><td class="nb" colspan="2" style="font-size:10px">'+_hrmsAmountInWords(total)+'</td></tr>';
  h+='<tr><td class="nb" colspan="4" style="height:30px"></td></tr>';
  h+='<tr><td class="nb" colspan="2"></td><td class="nb bold right" colspan="2">For Kelkar Auto Parts Pvt. Ltd.</td></tr>';
  h+='<tr><td class="nb" colspan="4" style="height:40px"></td></tr>';
  h+='<tr><td class="nb" colspan="2"></td><td class="nb bold right" colspan="2">Director</td></tr>';
  h+='</table>';
  h+='</body></html>';
  var iframe=document.createElement('iframe');
  iframe.style.cssText='position:fixed;left:-9999px;top:0;width:0;height:0';
  document.body.appendChild(iframe);
  iframe.contentDocument.write(h);iframe.contentDocument.close();
  setTimeout(function(){iframe.contentWindow.print();setTimeout(function(){iframe.remove();},1000);},400);
}

// ═══ NEFT PDF (paginated: 20 employees per page) ══════════════════���══════
function _hrmsPayNeftPDF(){
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  var details=window._hrmsSalDetails||{};
  if(!Object.keys(details).length){notify('No salary data. Open Salary tab first.',true);return;}
  _hrmsPayDatePrompt(function(payDate){_hrmsPayNeftPDFGen(payDate);});
}
function _hrmsPayNeftPDFGen(payDate){
  var mk=_hrmsMonth;
  var details=window._hrmsSalDetails||{};
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});
  var rows=[];
  Object.keys(details).forEach(function(code){
    var d=details[code];var emp=empMap[code];if(!emp)return;
    var net=Math.round(d.net||0);if(net<=0)return;
    if((emp.bankName||'').toLowerCase().indexOf('cosmos')>=0)return;
    rows.push({name:_hrmsDispName(emp),bank:emp.bankName||'',branch:emp.branchName||'',acct:emp.acctNo||'',ifsc:emp.ifsc||'',net:net});
  });
  rows.sort(function(a,b){var p=(a.ifsc||'').localeCompare(b.ifsc||'');return p!==0?p:a.name.localeCompare(b.name);});
  if(!rows.length){notify('No NEFT employees',true);return;}
  var PER_PAGE=20;
  var pages=[];
  for(var pi=0;pi<rows.length;pi+=PER_PAGE){pages.push(rows.slice(pi,pi+PER_PAGE));}
  var totalPages=pages.length;
  var h='<html><head><title>NEFT Payment '+mk+'</title><style>'
    +'@page{size:A4 landscape;margin:10mm 15mm}'
    +'body{font-family:Calibri,Arial,sans-serif;font-size:11px;color:#000;margin:0}'
    +'.page{page-break-after:always;padding:0}'
    +'.page:last-child{page-break-after:auto}'
    +'table{width:100%;border-collapse:collapse}td,th{padding:3px 5px;border:1px solid #000;font-size:10px}'
    +'th{font-weight:700;background:#f0f0f0;text-align:center}'
    +'.nb{border:none}.right{text-align:right}.bold{font-weight:700}'
    +'@media print{.no-print{display:none}}'
    +'</style></head><body>';
  var globalSr=0;
  pages.forEach(function(pageRows,pageIdx){
    var pageTotal=0;pageRows.forEach(function(r){pageTotal+=r.net;});
    h+='<div class="page">';
    h+='<table style="border:none;margin-bottom:6px"><tr><td class="nb" style="font-size:14px;font-weight:700">KELKAR AUTO PARTS PVT LTD</td><td class="nb right" style="font-size:9px;color:#666">Page '+(pageIdx+1)+' of '+totalPages+'</td></tr>';
    h+='<tr><td class="nb" style="font-size:12px;font-weight:700">List of Payees for RTGS/NEFT payment</td><td class="nb right bold">Date: '+payDate+'</td></tr></table>';
    h+='<table><thead><tr><th style="width:25px">#</th><th style="text-align:left">Party Name</th><th style="text-align:left">Bank Name</th><th style="text-align:left">Branch</th><th>A/c Type</th><th>A/C No</th><th>IFSC Code</th><th style="text-align:right">Amount in Rs.</th></tr></thead><tbody>';
    pageRows.forEach(function(r){
      globalSr++;
      h+='<tr><td style="text-align:center">'+globalSr+'</td><td>'+r.name+'</td><td>'+r.bank+'</td><td>'+r.branch+'</td><td style="text-align:center">Saving</td><td style="text-align:center">'+r.acct+'</td><td style="text-align:center">'+r.ifsc+'</td><td class="right bold">'+_hrmsIndianNum(r.net)+'</td></tr>';
    });
    h+='<tr><td colspan="7" class="right bold">Total</td><td class="right bold">'+_hrmsIndianNum(pageTotal)+'</td></tr>';
    h+='</tbody></table>';
    h+='<table style="border:none;margin-top:10px;font-size:10px">';
    h+='<tr><td class="nb" width="10%"></td><td class="nb bold">Amount in Rs.</td><td class="nb" colspan="2" style="font-size:9px">'+_hrmsAmountInWords(pageTotal)+'</td></tr>';
    h+='<tr><td class="nb"></td><td class="nb" colspan="3" style="font-size:9px">Kindly pay above listed payees through NEFT/RTGS from our Cash Credit account No. 00860010268</td></tr>';
    h+='<tr><td class="nb" colspan="4" style="height:16px"></td></tr>';
    h+='<tr><td class="nb" colspan="2"></td><td class="nb bold right" colspan="2">For Kelkar Auto Parts Pvt. Ltd.</td></tr>';
    h+='<tr><td class="nb" colspan="4" style="height:30px"></td></tr>';
    h+='<tr><td class="nb" colspan="2"></td><td class="nb bold right" colspan="2">Director</td></tr>';
    h+='</table>';
    h+='</div>';
  });
  h+='</body></html>';
  var iframe=document.createElement('iframe');
  iframe.style.cssText='position:fixed;left:-9999px;top:0;width:0;height:0';
  document.body.appendChild(iframe);
  iframe.contentDocument.write(h);iframe.contentDocument.close();
  setTimeout(function(){iframe.contentWindow.print();setTimeout(function(){iframe.remove();},1000);},400);
}

// ═══ CONTRACT SALARY TAB ══════════════════════════════════════════════════
// Shown only to Super Admins. Lists employees with employmentType='Contract'.
// Grouped by Team, computes salary per your formulas:
//   P+PH = P + PH;  A = WD - P;  Total OT = OT + OT@S;  OT@1 = Total OT
//   For Present = (P+PH) × Rate/Day
//   For OT@1 = OT@1 × (Rate/Day / 8)
//   Gross = For Present + For OT@1
//   PF = 0 (for now);  ESI = Gross × esiCompany%
//   Total Salary = Gross − PF − ESI
//   Commission = Gross × 8%
//   Total Bill = Total Salary + Commission
//   Diwali Bonus = P × Rate/Day × 8.33%
//   CTC = Total Bill + Diwali Bonus
var _hrmsContractCache={};// mk → computed rows for export
var _hrmsContractTeamFilter='All';// team filter selection
var _hrmsContractEmpQ='';// emp code/name search query

// ═══ CONTRACT ROLL MASTER ═════════════════════════════════════════════════
// Stored in hrmsSettings as a single record (key='rolls'). Each roll carries
// a history of {from: 'YYYY-MM', rate} entries; the effective rate at a given
// month is the most recent entry whose `from` ≤ that month. This is how the
// Contract Salary Revision page bumps rates by "increase" per roll per month.
var _HRMS_DEFAULT_ROLLS=[
  ['Bending Junior','BJ',690],['Bending Senior','BS',740],
  ['Fitter Junior','FJ',630],['Fitter Senior','FS',670],
  ['Coater Junior','CJ',700],['Coater Skilled','CS',720],
  ['Coater Skilled Old','CSO',740],['Coater Trainee','CT',620],
  ['Electrician Skilled','ES',740],
  ['Grinding Operator','G',560],['Grinding Operator Skilled','GS',620],
  ['Helper Junior','HJ',525],['Helper Junior Old','HJO',540],
  ['Helper Senior','HS',560],['Helper Senior Old','HSO',590],
  ['Housekeeping Female','HKF',550],['Housekeeping Male','HKM',620],
  ['Housekeeping Supervisor','HKS',650],
  ['Inspector','I',700],
  ['PT Operator','PT',620],['PT Operator Senior','PTS',670],
  ['Supervisor','SP',750],
  ['Welder Junior','WJ',700],['Welder Senior','WS',750],['Welder Senior Old','WSO',800],
  ['Machine Operator','M',600],['Forklift Driver','FD',800]
];

async function _hrmsLoadRolls(){
  if(!DB.hrmsSettings) DB.hrmsSettings=[];
  var rec=DB.hrmsSettings.find(function(r){return r.key==='rolls';});
  if(rec) return;
  // Seed defaults with a sentinel from='2000-01' so they apply to every month
  rec={id:'s'+uid(),key:'rolls',data:{rolls:_HRMS_DEFAULT_ROLLS.map(function(r){
    return {code:r[1],name:r[0],history:[{from:'2000-01',rate:r[2]}]};
  })}};
  DB.hrmsSettings.push(rec);
  await _dbSave('hrmsSettings',rec);
}

function _hrmsGetRolls(){
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='rolls';});
  return (rec&&rec.data&&rec.data.rolls)||[];
}

function _hrmsGetRollRate(code,mk){
  if(!code||!mk) return 0;
  var r=_hrmsGetRolls().find(function(x){return x.code===code;});
  if(!r||!r.history||!r.history.length) return 0;
  var best=null;
  r.history.forEach(function(h){
    if((h.from||'')<=mk&&(!best||(h.from||'')>(best.from||''))) best=h;
  });
  return best?(+best.rate||0):0;
}

// Latest rate on record for a roll, regardless of month — used by the
// employee list which has no month context.
function _hrmsGetRollCurrentRate(code){
  if(!code) return 0;
  var r=_hrmsGetRolls().find(function(x){return x.code===code;});
  if(!r||!r.history||!r.history.length) return 0;
  var best=null;
  r.history.forEach(function(h){if(!best||(h.from||'')>(best.from||'')) best=h;});
  return best?(+best.rate||0):0;
}

async function _hrmsSaveRolls(){
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='rolls';});
  if(!rec) return false;
  return await _dbSave('hrmsSettings',rec);
}

function _hrmsPrevMonthKey(mk){
  if(!mk) return mk;
  var p=mk.split('-'),y=parseInt(p[0]),m=parseInt(p[1]);
  m--;if(m<1){m=12;y--;}
  return y+'-'+String(m).padStart(2,'0');
}

// ═══ CONTRACT SALARY REVISION (ROLL MASTER) ══════════════════════════════════
// Simple Roll code + description master. Roll-based rate logic was removed —
// contract salary now reads Rate/Day directly from each employee's active
// period. An upload-new-contract-salary flow will be added on this page later.

// ── ROLL MASTER PAGE (sidebar → Masters → Roll) ───────────────────────────
function _hrmsRenderRollMaster(){
  var pg=document.getElementById('pageHrmsMRoll');if(!pg) return;
  if(!_hrmsHasAccess('page.masterDesig')){pg.innerHTML='<div class="card"><div class="empty-state" style="padding:30px">🔒 Access denied</div></div>';return;}
  var canEdit=_hrmsHasAccess('masters.edit');
  var rolls=_hrmsGetRolls().slice().sort(function(a,b){return(a.name||'').localeCompare(b.name||'');});

  // Display column uses CURRENT counts (active period); the Actions column
  // hides the delete icon based on HISTORICAL counts so we don't surface a
  // delete button that the protection check will reject.
  var empCounts=_hrmsMasterUsageCounts('roll');
  var empCountsAny=_hrmsMasterUsageCountsAny('roll');

  var h='<div class="card">';
  h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">';
  h+='<div style="font-size:18px;font-weight:900">🪪 Role Master</div>';
  h+='<div style="display:flex;gap:8px">';
  // Quick-link to the Contract Salary Revision sub-tab where roles are consumed.
  h+='<button class="btn btn-secondary" onclick="_hrmsRollMasterGoContractRev()" style="padding:7px 14px;font-size:12px;font-weight:700">💵 Contract Salary Revision →</button>';
  if(canEdit) h+='<button class="btn btn-primary" onclick="_hrmsRollMasterAdd()">+ Add Role</button>';
  else h+='<span style="font-size:11px;padding:6px 12px;background:var(--surface2);border:1.5px dashed var(--border2);border-radius:6px;color:var(--text3);font-style:italic">🔒 View Only</span>';
  h+='</div></div>';

  h+='<div class="table-wrap" style="max-height:calc(100vh - 200px)"><table><thead><tr>';
  h+='<th>#</th><th>Role</th><th>Description</th><th>Employees</th><th>Actions</th>';
  h+='</tr></thead><tbody>';
  if(!rolls.length){
    h+='<tr><td colspan="5" class="empty-state">No roles defined yet.</td></tr>';
  } else {
    rolls.forEach(function(r,i){
      var cnt=empCounts[r.code]||0;
      var codeEsc=(r.code||'').replace(/'/g,"\\'");
      h+='<tr>';
      h+='<td style="font-family:var(--mono);color:var(--text3)">'+(i+1)+'</td>';
      h+='<td style="font-weight:800;font-family:var(--mono);color:var(--accent)">'+(r.code||'')+'</td>';
      h+='<td style="font-weight:700">'+(r.name||'')+'</td>';
      if(cnt>0){
        h+='<td><a href="javascript:void(0)" onclick="_hrmsMasterShowEmps(\'roll\',\''+codeEsc+'\',\'Role\')" style="font-family:var(--mono);font-weight:800;color:var(--accent);text-decoration:underline;cursor:pointer" title="Show employees">'+cnt+'</a></td>';
      } else {
        h+='<td style="font-family:var(--mono);font-weight:700;color:var(--text3)">'+cnt+'</td>';
      }
      if(canEdit){
        h+='<td><button onclick="_hrmsRollMasterEdit(\''+codeEsc+'\')" style="padding:3px 10px;font-size:11px;font-weight:700;background:#fef3c7;border:1px solid #fde047;color:#a16207;border-radius:4px;cursor:pointer">✏️</button>';
        var anyCnt=empCountsAny[r.code]||0;
        if(anyCnt===0) h+=' <button onclick="_hrmsRollMasterDelete(\''+codeEsc+'\')" style="padding:3px 10px;font-size:11px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer">🗑</button>';
        h+='</td>';
      } else {
        h+='<td><span style="font-size:10px;color:var(--text3);font-style:italic">—</span></td>';
      }
      h+='</tr>';
    });
  }
  h+='</tbody></table></div></div>';
  pg.innerHTML=h;
}

// Jump from the Roll master page straight to the Contract Salary Revision
// sub-tab (Attendance & Salary → Settings & Data → Contract Salary Revision).
function _hrmsRollMasterGoContractRev(){
  if(!_hrmsHasAccess('page.attSal')){notify('Access denied',true);return;}
  if(!_hrmsHasAccess('page.contractRev')){notify('Access denied',true);return;}
  _hrmsActiveMainTab='settings';
  _hrmsActiveSettingsTab='contractrev';
  hrmsGo('pageHrmsAttSal');
}

async function _hrmsRollMasterAdd(){
  if(!_hrmsHasAccess('masters.edit')){notify('⚠ You have view-only access to masters.',true);return;}
  var code=(prompt('Role code (e.g. BJ):')||'').trim().toUpperCase();
  if(!code) return;
  var rolls=_hrmsGetRolls();
  if(rolls.some(function(r){return(r.code||'').toUpperCase()===code;})){notify('Role "'+code+'" already exists',true);return;}
  var name=(prompt('Role description:')||'').trim();
  if(!name) return;
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='rolls';});
  if(!rec){notify('Role master not initialized',true);return;}
  rec.data=rec.data||{};rec.data.rolls=rec.data.rolls||[];
  rec.data.rolls.push({code:code,name:name,history:[]});
  showSpinner('Saving…');var ok=await _hrmsSaveRolls();hideSpinner();
  if(!ok){notify('Save failed',true);rec.data.rolls.pop();return;}
  notify('Role added');_hrmsRenderRollMaster();
}

async function _hrmsRollMasterEdit(code){
  if(!_hrmsHasAccess('masters.edit')){notify('⚠ You have view-only access to masters.',true);return;}
  var rolls=_hrmsGetRolls();
  var r=rolls.find(function(x){return x.code===code;});if(!r) return;
  var newName=(prompt('Role description:',r.name||'')||'').trim();
  if(!newName||newName===r.name) return;
  var oldName=r.name;
  r.name=newName;
  showSpinner('Saving…');var ok=await _hrmsSaveRolls();hideSpinner();
  if(!ok){notify('Save failed',true);r.name=oldName;return;}
  notify('Role updated');_hrmsRenderRollMaster();
}

async function _hrmsRollMasterDelete(code){
  if(!_hrmsHasAccess('masters.edit')){notify('⚠ You have view-only access to masters.',true);return;}
  // Historical-aware delete protection — block if ANY period (current or
  // past) ever referenced this role. Display column uses the current count.
  var cnt=(_hrmsMasterUsageCountsAny('roll')[code])||0;
  if(cnt>0){notify('Cannot delete — role "'+code+'" is used by '+cnt+' employee(s) (including past revisions).',true);return;}
  if(!confirm('Delete role "'+code+'"?')) return;
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='rolls';});
  if(!rec||!rec.data||!rec.data.rolls) return;
  var backup=rec.data.rolls.slice();
  rec.data.rolls=rec.data.rolls.filter(function(r){return r.code!==code;});
  showSpinner('Deleting…');var ok=await _hrmsSaveRolls();hideSpinner();
  if(!ok){notify('Delete failed',true);rec.data.rolls=backup;return;}
  notify('Role deleted');_hrmsRenderRollMaster();
}

// ═══ ALLOCATION MASTER ══════════════════════════════════════════════════
// Plant × Department × RoleGroup → headcount target. Stored as a single
// hrmsSettings entry { key:'allocations', data:{ groups:[], allocations:{} } }.
//   • groups: [{id, name, roles:[code], isCatchAll}]
//   • allocations: { '<plant>|<dept>|<groupId>': <count> }
// Compared against actual head counts in Daily Attendance Summary.
var _HRMS_ALLOC_DEFAULTS=[
  {id:'gWelder',  name:'Welder',  roles:['WJ','WS','WSO']},
  {id:'gHelper',  name:'Helper',  roles:['HJ','HJO','HS','HSO']},
  {id:'gGrinder', name:'Grinder', roles:['G','GS']},
  {id:'gCoater',  name:'Coater',  roles:['CJ','CS','CSO','CT']},
  {id:'gOperator',name:'Operator',roles:['BJ','BS','M']},
  {id:'gOther',   name:'Other',   roles:[],isCatchAll:true}
];

function _hrmsAllocationData(){
  var rec=(DB.hrmsSettings||[]).find(function(r){return r.key==='allocations';});
  if(!rec){
    rec={id:'hs_alloc',key:'allocations',data:{groups:_HRMS_ALLOC_DEFAULTS.map(function(g){return Object.assign({},g);}),allocations:{}}};
    if(!DB.hrmsSettings) DB.hrmsSettings=[];
    DB.hrmsSettings.push(rec);
  }
  if(!rec.data) rec.data={};
  if(!Array.isArray(rec.data.groups)||!rec.data.groups.length){
    rec.data.groups=_HRMS_ALLOC_DEFAULTS.map(function(g){return Object.assign({},g);});
  }
  if(!rec.data.allocations||typeof rec.data.allocations!=='object') rec.data.allocations={};
  return rec;
}

async function _hrmsAllocationSave(){
  var rec=_hrmsAllocationData();
  return await _dbSave('hrmsSettings',rec);
}

// Compute the role-group bucket for a given role code. Uses explicit member
// lists; falls back to the catch-all group if the role isn't in any group.
function _hrmsAllocGroupForRole(roleCode,groups){
  if(!roleCode) return null;
  var rc=String(roleCode).trim().toUpperCase();
  for(var i=0;i<groups.length;i++){
    var g=groups[i];
    if(g.isCatchAll) continue;
    var roles=g.roles||[];
    for(var j=0;j<roles.length;j++){
      if(String(roles[j]).trim().toUpperCase()===rc) return g.id;
    }
  }
  // Fall back to catch-all group if any
  var catchAll=groups.find(function(g){return g.isCatchAll;});
  return catchAll?catchAll.id:null;
}

// Roles assigned (anywhere) — used to highlight free roles in the picker.
function _hrmsAllocAssignedRoles(groups,exceptId){
  var s={};
  groups.forEach(function(g){
    if(g.id===exceptId||g.isCatchAll) return;
    (g.roles||[]).forEach(function(r){s[String(r).trim().toUpperCase()]=g.name;});
  });
  return s;
}

var _hrmsAllocActiveTab='groups';
function _hrmsAllocSetTab(tab){_hrmsAllocActiveTab=tab;_hrmsRenderAllocationMaster();}

function _hrmsRenderAllocationMaster(){
  var el=document.getElementById('pageHrmsMAllocation');
  if(!el) return;
  var canEdit=typeof _hrmsHasAccess==='function'?_hrmsHasAccess('masters.edit'):true;
  var rec=_hrmsAllocationData();
  var groups=(rec.data.groups||[]).slice();
  var allocations=rec.data.allocations||{};
  var rolesAll=((typeof _hrmsGetRolls==='function'?_hrmsGetRolls():[])||[]).slice()
    .sort(function(a,b){return(a.code||'').localeCompare(b.code||'');});
  var plants=(DB.hrmsCompanies||[]).filter(function(x){return !x.inactive;}).map(function(x){return x.name;}).sort();
  var depts=(DB.hrmsDepartments||[]).filter(function(x){return !x.inactive;}).map(function(x){return x.name;}).sort();

  // Default tab — "groups" if no plants yet, otherwise the chosen tab if it
  // still exists, else fall back to the first plant.
  var validTabs=['groups'].concat(plants.map(function(p){return 'plant:'+p;}));
  if(validTabs.indexOf(_hrmsAllocActiveTab)<0) _hrmsAllocActiveTab=plants.length?('plant:'+plants[0]):'groups';

  var h='<div class="card" style="margin-bottom:14px">';
  h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">';
  h+='<div style="font-size:18px;font-weight:900">🎯 Allocation Master</div>';
  h+='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
  h+='<div style="font-size:11px;color:var(--text3)">Plantwise + Departmentwise headcount target by role group</div>';
  if(canEdit) h+='<button onclick="_hrmsAllocSaveGrid()" style="font-size:12px;padding:6px 16px;font-weight:800;background:#16a34a;color:#fff;border:none;border-radius:6px;cursor:pointer">💾 Save Allocations</button>';
  h+='</div></div>';

  // ── Tab bar — Role Groups + one tab per plant ──
  h+='<div style="display:flex;gap:0;margin-bottom:12px;border-bottom:2px solid var(--border);overflow-x:auto;flex-wrap:nowrap">';
  var renderTabBtn=function(key,label,colour){
    var active=(_hrmsAllocActiveTab===key);
    var keyEsc=key.replace(/'/g,"\\'");
    return '<div onclick="_hrmsAllocSetTab(\''+keyEsc+'\')" style="padding:8px 16px;font-size:13px;font-weight:'+(active?'800':'700')+';cursor:pointer;border-bottom:3px solid '+(active?(colour||'var(--accent)'):'transparent')+';color:'+(active?(colour||'var(--accent)'):'var(--text3)')+';background:'+(active?'var(--accent-light)':'transparent')+';white-space:nowrap">'+label+'</div>';
  };
  h+=renderTabBtn('groups','📋 Role Groups');
  plants.forEach(function(p){
    var pClr=(typeof _hrmsGetPlantColor==='function'?_hrmsGetPlantColor(p):'#e2e8f0');
    h+=renderTabBtn('plant:'+p,'🏭 '+p,'#1e293b');
    void pClr;
  });
  h+='</div>';

  // ── Tab body ──
  if(_hrmsAllocActiveTab==='groups'){
    h+='<div style="font-size:11px;color:var(--text3);margin-bottom:8px">Define groups of roles. The <b>catch-all</b> group automatically captures every role not assigned elsewhere.</div>';
    h+='<div style="overflow:auto;max-height:calc(100vh - 260px);border:1.5px solid var(--border);border-radius:8px"><table style="width:100%;border-collapse:separate;border-spacing:0;font-size:13px">';
    h+='<thead><tr style="background:#f1f5f9"><th style="padding:8px 10px;text-align:left;position:sticky;top:0;background:#f1f5f9;z-index:2;box-shadow:inset 0 -2px 0 var(--border)">#</th><th style="padding:8px 10px;text-align:left;min-width:140px;position:sticky;top:0;background:#f1f5f9;z-index:2;box-shadow:inset 0 -2px 0 var(--border)">Group Name</th><th style="padding:8px 10px;text-align:left;position:sticky;top:0;background:#f1f5f9;z-index:2;box-shadow:inset 0 -2px 0 var(--border)">Member Roles</th><th style="padding:8px 10px;text-align:center;position:sticky;top:0;background:#f1f5f9;z-index:2;box-shadow:inset 0 -2px 0 var(--border)">Catch-all</th>'+(canEdit?'<th style="padding:8px 10px;text-align:center;min-width:100px;position:sticky;top:0;background:#f1f5f9;z-index:2;box-shadow:inset 0 -2px 0 var(--border)">Actions</th>':'')+'</tr></thead><tbody>';
    groups.forEach(function(g,i){
      var assigned=_hrmsAllocAssignedRoles(groups,g.id);
      var memberStr=g.isCatchAll
        ?'<span style="color:#7c3aed;font-style:italic">All other roles ('+rolesAll.filter(function(r){return !assigned[String(r.code).trim().toUpperCase()];}).map(function(r){return r.code;}).join(', ')+')</span>'
        :((g.roles||[]).map(function(rc){
            return '<span style="display:inline-block;padding:1px 7px;background:var(--accent-light);color:var(--accent);font-family:var(--mono);font-weight:700;border-radius:10px;margin:1px 2px">'+rc+'</span>';
          }).join('')||'<span style="color:var(--text3);font-style:italic">No roles assigned</span>');
      h+='<tr style="border-top:1px solid #e2e8f0">';
      h+='<td style="padding:6px 10px;color:var(--text3);font-family:var(--mono)">'+(i+1)+'</td>';
      h+='<td style="padding:6px 10px;font-weight:800">'+g.name+'</td>';
      h+='<td style="padding:6px 10px">'+memberStr+'</td>';
      h+='<td style="padding:6px 10px;text-align:center">'+(g.isCatchAll?'<span style="font-size:11px;font-weight:800;color:#7c3aed;background:#f3e8ff;border:1px solid #c4b5fd;padding:2px 8px;border-radius:10px">CATCH-ALL</span>':'<span style="color:var(--text3)">—</span>')+'</td>';
      if(canEdit){
        h+='<td style="padding:6px 10px;text-align:center;white-space:nowrap">';
        h+='<button onclick="_hrmsAllocGroupEdit(\''+g.id+'\')" style="font-size:11px;padding:3px 10px;font-weight:700;background:#fef3c7;border:1px solid #fde047;color:#a16207;border-radius:4px;cursor:pointer;margin-right:3px">✏️</button>';
        h+='<button onclick="_hrmsAllocGroupDelete(\''+g.id+'\')" style="font-size:11px;padding:3px 10px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer">🗑</button>';
        h+='</td>';
      }
      h+='</tr>';
    });
    h+='</tbody></table></div>';
    if(canEdit) h+='<button onclick="_hrmsAllocGroupAdd()" style="font-size:12px;padding:6px 14px;font-weight:700;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;margin-top:10px">+ Add Group</button>';
  } else if(_hrmsAllocActiveTab.indexOf('plant:')===0){
    var plant=_hrmsAllocActiveTab.slice(6);
    var pClr=(typeof _hrmsGetPlantColor==='function'?_hrmsGetPlantColor(plant):'#e2e8f0');
    if(!depts.length){
      h+='<div class="empty-state" style="padding:24px">Add departments to the master first to start allocating.</div>';
    } else {
      h+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">';
      h+='<span style="display:inline-block;padding:5px 12px;background:'+pClr+';color:#1e293b;font-weight:900;font-size:13px;border-radius:6px">🏭 '+plant+'</span>';
      h+='<span style="font-size:11px;color:var(--text3)">Set the planned headcount per Department × Role Group. Edits stay in memory until you click Save Allocations.</span>';
      h+='</div>';
      h+='<div style="font-size:11px;color:var(--text3);margin-bottom:6px"><b>Tip:</b> Drag a column header (group name) to reorder columns. Order is saved automatically.</div>';
      h+='<div style="overflow:auto;max-height:calc(100vh - 280px);border:1.5px solid var(--border);border-radius:8px"><table style="width:auto;border-collapse:separate;border-spacing:0;font-size:12px">';
      h+='<thead><tr style="background:#1e293b;color:#fff">';
      h+='<th style="padding:6px 8px;text-align:left;min-width:120px;position:sticky;top:0;background:#1e293b;z-index:2;box-shadow:inset 0 -2px 0 #475569">Department</th>';
      groups.forEach(function(g,gi){
        h+='<th draggable="true" data-alloc-col="'+gi+'" ondragstart="_hrmsAllocColDragStart(event,'+gi+')" ondragover="_hrmsAllocColDragOver(event)" ondrop="_hrmsAllocColDrop(event,'+gi+')" ondragend="_hrmsAllocColDragEnd(event)" style="padding:6px 6px;text-align:center;min-width:62px;position:sticky;top:0;background:#1e293b;z-index:2;box-shadow:inset 0 -2px 0 #475569;cursor:grab;user-select:none" title="Drag to reorder">⋮⋮ '+g.name+'</th>';
      });
      h+='<th style="padding:6px 8px;text-align:center;min-width:60px;background:#0f172a;position:sticky;top:0;z-index:2;box-shadow:inset 0 -2px 0 #475569">Total</th>';
      h+='</tr></thead><tbody>';
      var colTotals={},grandTotal=0;
      groups.forEach(function(g){colTotals[g.id]=0;});
      depts.forEach(function(dept,di){
        var rowBg=di%2===1?'background:#f8fafc;':'';
        h+='<tr style="'+rowBg+'border-top:1px solid #e2e8f0">';
        h+='<td style="padding:4px 8px;font-weight:700">'+dept+'</td>';
        var rowTotal=0;
        groups.forEach(function(g){
          var key=plant+'|'+dept+'|'+g.id;
          var v=+(allocations[key]||0)||0;
          colTotals[g.id]+=v;rowTotal+=v;
          if(canEdit){
            h+='<td style="padding:2px 3px;text-align:center"><input type="number" min="0" step="1" value="'+(v||'')+'" data-alloc-key="'+key+'" oninput="_hrmsAllocCellChange(this)" style="width:48px;padding:2px 4px;border:1.5px solid var(--border);border-radius:4px;text-align:center;font-family:var(--mono);font-weight:700;font-size:12px"></td>';
          } else {
            h+='<td style="padding:4px 6px;text-align:center;font-family:var(--mono);font-weight:700">'+(v||'—')+'</td>';
          }
        });
        grandTotal+=rowTotal;
        h+='<td style="padding:4px 6px;text-align:center;font-family:var(--mono);font-weight:900;background:#e2e8f0" data-row-total="'+plant+'|'+dept+'">'+rowTotal+'</td>';
        h+='</tr>';
      });
      h+='<tr style="background:#f1f5f9;border-top:2px solid #94a3b8"><td style="padding:5px 8px;font-weight:900">Total</td>';
      groups.forEach(function(g){h+='<td style="padding:5px 6px;text-align:center;font-family:var(--mono);font-weight:900" data-col-total="'+plant+'|'+g.id+'">'+colTotals[g.id]+'</td>';});
      h+='<td style="padding:5px 6px;text-align:center;font-family:var(--mono);font-weight:900;background:#1e293b;color:#fff" data-plant-total="'+plant+'">'+grandTotal+'</td></tr>';
      h+='</tbody></table></div>';
    }
  }
  h+='</div>';
  el.innerHTML=h;
}

// On cell input — update in-memory allocations and the row/col/plant totals.
function _hrmsAllocCellChange(input){
  var key=input.dataset.allocKey;
  var v=+(input.value||0)||0;
  if(v<0){v=0;input.value='';}
  var rec=_hrmsAllocationData();
  if(v) rec.data.allocations[key]=v;
  else delete rec.data.allocations[key];
  // Refresh totals for this row, column, and plant.
  var parts=key.split('|');// plant|dept|groupId
  var plant=parts[0],dept=parts[1];
  var rowTd=document.querySelector('[data-row-total="'+plant+'|'+dept+'"]');
  if(rowTd){
    var rt=0;
    document.querySelectorAll('input[data-alloc-key^="'+plant+'|'+dept+'|"]').forEach(function(i){rt+=+(i.value||0)||0;});
    rowTd.textContent=rt;
  }
  // Column total (per plant per group)
  var colTd=document.querySelector('[data-col-total="'+plant+'|'+parts[2]+'"]');
  if(colTd){
    var ct=0;
    document.querySelectorAll('input[data-alloc-key$="|'+parts[2]+'"]').forEach(function(i){
      if(String(i.dataset.allocKey).indexOf(plant+'|')===0) ct+=+(i.value||0)||0;
    });
    colTd.textContent=ct;
  }
  // Plant grand total
  var ptTd=document.querySelector('[data-plant-total="'+plant+'"]');
  if(ptTd){
    var pt=0;
    document.querySelectorAll('input[data-alloc-key^="'+plant+'|"]').forEach(function(i){pt+=+(i.value||0)||0;});
    ptTd.textContent=pt;
  }
}

// Column reorder via HTML5 drag-and-drop on the plant grid headers. Reorders
// the groups array in allocation data and persists immediately.
var _hrmsAllocDragSrc=null;
function _hrmsAllocColDragStart(ev,colIdx){
  _hrmsAllocDragSrc=colIdx;
  try{ev.dataTransfer.effectAllowed='move';ev.dataTransfer.setData('text/plain',String(colIdx));}catch(e){}
  if(ev.target&&ev.target.style) ev.target.style.opacity='0.5';
}
function _hrmsAllocColDragOver(ev){
  if(_hrmsAllocDragSrc===null) return;
  ev.preventDefault();
  if(ev.dataTransfer) ev.dataTransfer.dropEffect='move';
}
function _hrmsAllocColDragEnd(ev){
  if(ev.target&&ev.target.style) ev.target.style.opacity='';
  _hrmsAllocDragSrc=null;
}
function _hrmsAllocColDrop(ev,destIdx){
  ev.preventDefault();
  var src=_hrmsAllocDragSrc;
  _hrmsAllocDragSrc=null;
  if(src===null||src===destIdx) return;
  var rec=_hrmsAllocationData();
  var groups=rec.data.groups||[];
  if(src<0||src>=groups.length||destIdx<0||destIdx>=groups.length) return;
  var moved=groups.splice(src,1)[0];
  groups.splice(destIdx,0,moved);
  // Persist & re-render. Save in background — UI updates immediately.
  _hrmsAllocationSave().then(function(ok){
    if(!ok) notify('Order saved locally — DB save failed',true);
  });
  _hrmsRenderAllocationMaster();
}

async function _hrmsAllocSaveGrid(){
  if(!_hrmsHasAccess('masters.edit')){notify('⚠ View-only access',true);return;}
  // Re-collect from inputs (defensive)
  var rec=_hrmsAllocationData();
  rec.data.allocations={};
  document.querySelectorAll('#pageHrmsMAllocation input[data-alloc-key]').forEach(function(i){
    var v=+(i.value||0)||0;
    if(v) rec.data.allocations[i.dataset.allocKey]=v;
  });
  showSpinner('Saving…');
  var ok=await _hrmsAllocationSave();
  hideSpinner();
  if(!ok){notify('Save failed',true);return;}
  notify('✅ Allocations saved');
}

// Group CRUD — minimal prompt-based UI; simple and reliable.
function _hrmsAllocGroupAdd(){
  if(!_hrmsHasAccess('masters.edit')){notify('⚠ View-only access',true);return;}
  var name=(prompt('Group name (e.g. Welder):')||'').trim();
  if(!name) return;
  var rec=_hrmsAllocationData();
  if(rec.data.groups.some(function(g){return(g.name||'').toLowerCase()===name.toLowerCase();})){
    notify('Group "'+name+'" already exists',true);return;
  }
  var rolesIn=(prompt('Member role codes (comma-separated, leave blank to add later):')||'').trim();
  var roles=rolesIn?rolesIn.split(/[,\s]+/).map(function(s){return s.trim().toUpperCase();}).filter(Boolean):[];
  rec.data.groups.push({id:'g'+Math.random().toString(36).slice(2,9),name:name,roles:roles});
  _hrmsAllocationSave().then(function(ok){
    if(!ok){rec.data.groups.pop();notify('Save failed',true);return;}
    notify('Group added');_hrmsRenderAllocationMaster();
  });
}

function _hrmsAllocGroupEdit(gid){
  if(!_hrmsHasAccess('masters.edit')){notify('⚠ View-only access',true);return;}
  var rec=_hrmsAllocationData();
  var g=rec.data.groups.find(function(x){return x.id===gid;});
  if(!g) return;
  var newName=(prompt('Group name:',g.name||'')||'').trim();
  if(!newName) return;
  if(g.isCatchAll){
    g.name=newName;// catch-all roles auto-derived; only rename allowed
  } else {
    var rolesIn=(prompt('Member role codes (comma-separated):',(g.roles||[]).join(', '))||'').trim();
    var roles=rolesIn?rolesIn.split(/[,\s]+/).map(function(s){return s.trim().toUpperCase();}).filter(Boolean):[];
    var oldName=g.name,oldRoles=(g.roles||[]).slice();
    g.name=newName;g.roles=roles;
    _hrmsAllocationSave().then(function(ok){
      if(!ok){g.name=oldName;g.roles=oldRoles;notify('Save failed',true);return;}
      notify('Group updated');_hrmsRenderAllocationMaster();
    });
    return;
  }
  _hrmsAllocationSave().then(function(ok){
    if(!ok) notify('Save failed',true);
    notify('Group updated');_hrmsRenderAllocationMaster();
  });
}

function _hrmsAllocGroupDelete(gid){
  if(!_hrmsHasAccess('masters.edit')){notify('⚠ View-only access',true);return;}
  var rec=_hrmsAllocationData();
  var g=rec.data.groups.find(function(x){return x.id===gid;});
  if(!g) return;
  if(g.isCatchAll){notify('Catch-all group cannot be deleted',true);return;}
  if(!confirm('Delete group "'+g.name+'"? Allocations referring to it will also be removed.')) return;
  // Remove allocations that reference this group
  Object.keys(rec.data.allocations||{}).forEach(function(k){
    if(k.endsWith('|'+gid)) delete rec.data.allocations[k];
  });
  rec.data.groups=rec.data.groups.filter(function(x){return x.id!==gid;});
  _hrmsAllocationSave().then(function(ok){
    if(!ok){notify('Save failed',true);return;}
    notify('Group deleted');_hrmsRenderAllocationMaster();
  });
}

// ═══ SALARY REVISION IMPORT (shared by On-Roll and Contract sub-tabs) ════════
// Excel columns (case/space/punct-insensitive):
//   Emp Code, Roll, Sal/Day, Sal/Month, Allowance/Month, Effective Month.
// Mode filters which employees are considered ('onroll' / 'contract').
// For Staff employees, Sal/Day is meaningless — the "diff" is computed on
// Sal/Month instead, and the Sal/Day old/new cells are hidden for that row.
var _HRMS_SAL_IMP_CFG={
  onroll:{
    etCode:'onroll',
    etPretty:'On Roll',
    perm:'action.bulkSalRevision',
    dom:{preview:'hrmsSalImpPreview_onroll',summary:'hrmsSalImpSummary_onroll',btnSel:'hrmsSalImpApproveSelBtn_onroll',btnAll:'hrmsSalImpApproveAllBtn_onroll',btnCancel:'hrmsSalImpCancelBtn_onroll'}
  },
  contract:{
    etCode:'contract',
    etPretty:'Contract',
    perm:'action.proposeContractRev',
    dom:{preview:'hrmsSalImpPreview_contract',summary:'hrmsSalImpSummary_contract',btnSel:'hrmsSalImpApproveSelBtn_contract',btnAll:'hrmsSalImpApproveAllBtn_contract',btnCancel:'hrmsSalImpCancelBtn_contract'}
  }
};
var _hrmsSalImpData={onroll:null,contract:null};

function _hrmsSalImpParseWef(v){
  if(v==null) return '';
  v=v.toString().trim();if(!v) return '';
  var _mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var iso=v.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if(iso){var moI=+iso[2];if(moI>=1&&moI<=12) return iso[1]+'-'+String(moI).padStart(2,'0');}
  if(/^\d{4,6}(\.\d+)?$/.test(v)){
    var ser=parseFloat(v);
    if(ser>30000&&ser<60000){var d=new Date((ser-25569)*86400000);if(!isNaN(d)) return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
  }
  var m=v.match(/^([A-Za-z]{3,})[\s\-\/.]+(\d{2,4})$/);
  if(m){var mn=m[1].slice(0,3);mn=mn.charAt(0).toUpperCase()+mn.slice(1).toLowerCase();var mo=_mn.indexOf(mn);if(mo>=1){var y=+m[2];if(y<100)y+=2000;return y+'-'+String(mo).padStart(2,'0');}}
  var m3=v.match(/^\d{1,2}[\s\-\/.]+([A-Za-z]{3,})[\s\-\/.]+(\d{2,4})$/);
  if(m3){var mn3=m3[1].slice(0,3);mn3=mn3.charAt(0).toUpperCase()+mn3.slice(1).toLowerCase();var mo3=_mn.indexOf(mn3);if(mo3>=1){var y3=+m3[2];if(y3<100)y3+=2000;return y3+'-'+String(mo3).padStart(2,'0');}}
  var m2=v.match(/^(\d{1,2})[\s\-\/.](\d{2,4})$/);
  if(m2){var mo2=+m2[1];var y2=+m2[2];if(y2<100)y2+=2000;if(mo2>=1&&mo2<=12) return y2+'-'+String(mo2).padStart(2,'0');}
  var m4=v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if(m4){var mp=+m4[2],y4=+m4[3];if(y4<100)y4+=2000;if(mp>=1&&mp<=12) return y4+'-'+String(mp).padStart(2,'0');}
  return '';
}

function _hrmsSalImpPrevOf(mk){var p=mk.split('-');var y=+p[0],mo=+p[1];mo--;if(mo<1){mo=12;y--;}return y+'-'+String(mo).padStart(2,'0');}

async function _hrmsSalImport(mode,inputEl){
  var cfg=_HRMS_SAL_IMP_CFG[mode];if(!cfg){notify('Invalid import mode',true);return;}
  if(!_hrmsHasAccess(cfg.perm)){notify('Access denied',true);return;}
  if(!inputEl||!inputEl.files||!inputEl.files[0]){notify('No file selected',true);return;}
  var file=inputEl.files[0];inputEl.value='';
  if(!DB.hrmsEmployees||!DB.hrmsEmployees.length){notify('No employees loaded',true);return;}

  var now=new Date();
  var defaultWef=_hrmsMonth||(now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0'));
  var _mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  showSpinner('Reading Excel…');
  try{
    var reader=new FileReader();
    reader.onload=async function(ev){
      try{
        var rows=await _parseXLSX(ev.target.result);
        if(!rows.length){hideSpinner();notify('No data in file',true);return;}

        var _g=function(r,keys){
          var rKeys=Object.keys(r);
          for(var i=0;i<keys.length;i++){
            var k=keys[i].replace(/[\s./]+/g,'').toLowerCase();
            for(var j=0;j<rKeys.length;j++){
              if(rKeys[j].replace(/[\s./]+/g,'').toLowerCase()===k){
                var v=(r[rKeys[j]]==null?'':r[rKeys[j]]).toString().trim();
                if(v!=='') return v;
              }
            }
          }
          return '';
        };

        var rollsValidSet={};(_hrmsGetRolls()||[]).forEach(function(r){rollsValidSet[(r.code||'').toUpperCase()]=true;});

        var preview=[];
        var skipped={noCode:0,noEmp:0,noCurP:0,wrongType:0,noChange:0,badWef:0,locked:0};
        for(var i=0;i<rows.length;i++){
          var r=rows[i];
          var code=_g(r,['Emp Code','Employee Code','EmpCode','Code']);
          if(!code){skipped.noCode++;continue;}
          var codeUp=String(code).toUpperCase().trim();
          var emp=DB.hrmsEmployees.find(function(e){return String(e.empCode||'').toUpperCase().trim()===codeUp;});
          if(!emp){skipped.noEmp++;continue;}

          // Active period = latest open-ended (to == null) that's either
          // plain-saved (no _wfStatus) or flagged 'approved'. Draft / proposed
          // / rejected revisions are NOT active. Legacy employees may have
          // periods:[] — synthesize a virtual period from flat fields so the
          // import still works on them (approve creates the first real period).
          var curP=(emp.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
          if(!curP){
            if((emp.periods||[]).length>0){skipped.noCurP++;continue;}// has periods but none active
            var _doj=(emp.dateOfJoining||'').slice(0,7);
            curP={
              _virtual:true,
              from:_doj||'2000-01', to:null,
              location:emp.location||'', employmentType:emp.employmentType||'',
              category:emp.category||'', teamName:emp.teamName||'',
              department:emp.department||'', subDepartment:emp.subDepartment||'',
              designation:emp.designation||'', roll:emp.roll||'',
              reportingTo:emp.reportingTo||'',
              salaryDay:+emp.salaryDay||0, salaryMonth:+emp.salaryMonth||0,
              specialAllowance:+emp.specialAllowance||0,
              esiApplicable:emp.esiApplicable||'',
              status:emp.status||'Active', dateOfLeft:emp.dateOfLeft||''
            };
          }
          var et=((curP.employmentType||emp.employmentType||'')+'').toLowerCase().replace(/\s/g,'');
          if(et!==cfg.etCode){skipped.wrongType++;continue;}

          var rawRoll=_g(r,['Roll','Role']);
          var rawD=_g(r,['Sal/Day','Sal Day','SalDay','Salary Day','Rate/Day','Rate per Day']);
          var rawM=_g(r,['Sal/Month','Sal Month','SalMonth','Salary Month','Rate per Month']);
          var rawA=_g(r,['Allowance/Month','Allowance Month','Allowance','Sp.Allow','Sp Allow','Special Allowance']);
          var wefRaw=_g(r,['Effective Month','Effective From','Wef','WEF','Applicable Month','Month']);
          var rowWef=wefRaw?_hrmsSalImpParseWef(wefRaw):defaultWef;
          if(!rowWef){skipped.badWef++;continue;}
          if(typeof _hrmsIsMonthLocked==='function'&&_hrmsIsMonthLocked(rowWef)){skipped.locked++;continue;}
          if((curP.from||'')>rowWef){skipped.badWef++;continue;}

          var isStaff=((curP.category||emp.category||'')+'').toLowerCase()==='staff';
          var oldRoll=curP.roll||emp.roll||'';
          var oldD=+curP.salaryDay||0, oldM=+curP.salaryMonth||0, oldSp=+curP.specialAllowance||0;

          var newRoll=rawRoll?rawRoll.toUpperCase():oldRoll;
          var newD=rawD!==''?(parseFloat(rawD)||0):oldD;
          var newM=rawM!==''?(parseFloat(rawM)||0):oldM;
          var newSp=rawA!==''?(parseFloat(rawA)||0):oldSp;

          if(oldRoll===newRoll&&oldD===newD&&oldM===newM&&oldSp===newSp){skipped.noChange++;continue;}

          var wefP=rowWef.split('-');
          var wefLabel=_mn[+wefP[1]]+'-'+wefP[0].slice(2);

          preview.push({
            code:String(code), name:_hrmsDispName(emp),
            isStaff:isStaff,
            oldRoll:oldRoll, newRoll:newRoll,
            oldD:oldD, oldM:oldM, oldSp:oldSp,
            newD:newD, newM:newM, newSp:newSp,
            diff: isStaff?(newM-oldM):(newD-oldD),
            chRoll:oldRoll!==newRoll, chD:oldD!==newD, chM:oldM!==newM, chSp:oldSp!==newSp,
            wef:rowWef, wefLabel:wefLabel, prevMonth:_hrmsSalImpPrevOf(rowWef),
            emp:emp, curP:curP,
            selected:true,
            rollValid:!newRoll||!!rollsValidSet[newRoll]
          });
        }
        hideSpinner();
        _hrmsSalImpData[mode]={preview:preview,skipped:skipped};
        _hrmsSalImpRenderPreview(mode);
      }catch(ex){hideSpinner();notify('Import error: '+ex.message,true);}
    };
    reader.readAsArrayBuffer(file);
  }catch(ex){hideSpinner();notify(ex.message,true);}
}

function _hrmsSalImpRenderPreview(mode){
  var cfg=_HRMS_SAL_IMP_CFG[mode];if(!cfg) return;
  var el=document.getElementById(cfg.dom.preview);if(!el) return;
  var summary=document.getElementById(cfg.dom.summary);
  var selBtn=document.getElementById(cfg.dom.btnSel);
  var allBtn=document.getElementById(cfg.dom.btnAll);
  var cancelBtn=document.getElementById(cfg.dom.btnCancel);

  var d=_hrmsSalImpData[mode];
  if(!d){
    // No import active — fall back to auto-diff of the selected month vs prev.
    if(selBtn) selBtn.style.display='none';
    if(allBtn) allBtn.style.display='none';
    if(cancelBtn) cancelBtn.style.display='none';
    _hrmsSalImpRenderAutoDiff(mode,el,summary);
    return;
  }
  var skipParts=[];
  if(d.skipped.noCode) skipParts.push(d.skipped.noCode+' no-code');
  if(d.skipped.noEmp) skipParts.push(d.skipped.noEmp+' emp-not-found');
  if(d.skipped.noCurP) skipParts.push(d.skipped.noCurP+' no-current-period');
  if(d.skipped.wrongType) skipParts.push(d.skipped.wrongType+' not-'+cfg.etPretty.toLowerCase().replace(/\s/g,''));
  if(d.skipped.badWef) skipParts.push(d.skipped.badWef+' invalid/past-wef');
  if(d.skipped.locked) skipParts.push(d.skipped.locked+' locked-month');
  if(d.skipped.noChange) skipParts.push(d.skipped.noChange+' unchanged');
  var skipNote=skipParts.length?' · skipped: '+skipParts.join(', '):'';
  var selCount=d.preview.filter(function(p){return p.selected;}).length;
  if(summary) summary.textContent=d.preview.length+' change(s) · '+selCount+' selected'+skipNote;

  if(!d.preview.length){
    el.innerHTML='<div style="padding:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;font-size:13px;color:#15803d;font-weight:600">No changes detected'+skipNote+'</div>';
    if(selBtn) selBtn.style.display='none';
    if(allBtn) allBtn.style.display='none';
    if(cancelBtn) cancelBtn.style.display='';
    return;
  }

  var _th='padding:6px 8px;font-size:10px;font-weight:800';
  var h='<div style="overflow-x:auto;border:1.5px solid var(--accent);border-radius:8px">';
  h+='<table style="width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap">';
  h+='<thead><tr style="background:#1e293b;color:#fff;position:sticky;top:0;z-index:1">';
  h+='<th style="'+_th+';text-align:center;width:34px"><input type="checkbox" '+(selCount===d.preview.length?'checked':'')+' onchange="_hrmsSalImpSelectAll(\''+mode+'\',this.checked)"></th>';
  h+='<th style="'+_th+';text-align:left">Code</th>';
  h+='<th style="'+_th+';text-align:center" colspan="2">Roll</th>';
  h+='<th style="'+_th+';text-align:left">Name</th>';
  h+='<th style="'+_th+';text-align:center">Wef</th>';
  h+='<th style="'+_th+';text-align:right" colspan="2">Sal/Day</th>';
  h+='<th style="'+_th+';text-align:right" colspan="2">Sal/Month</th>';
  h+='<th style="'+_th+';text-align:right" colspan="2">Allow/Month</th>';
  h+='<th style="'+_th+';text-align:right">Diff</th>';
  h+='</tr>';
  h+='<tr style="background:#334155;color:#94a3b8;font-size:9px">';
  h+='<th></th><th></th>';
  h+='<th style="padding:2px 8px;text-align:center">Old</th><th style="padding:2px 8px;text-align:center">New</th>';
  h+='<th></th><th></th>';
  h+='<th style="padding:2px 8px;text-align:right">Old</th><th style="padding:2px 8px;text-align:right">New</th>';
  h+='<th style="padding:2px 8px;text-align:right">Old</th><th style="padding:2px 8px;text-align:right">New</th>';
  h+='<th style="padding:2px 8px;text-align:right">Old</th><th style="padding:2px 8px;text-align:right">New</th>';
  h+='<th></th>';
  h+='</tr></thead><tbody>';

  var _hi=function(c){return c?'background:#fef3c7;font-weight:800;color:#92400e':'color:var(--text3)';};
  var _dash='<span style="color:var(--text3);font-weight:400">—</span>';
  d.preview.forEach(function(p,idx){
    h+='<tr style="border-bottom:1px solid #e2e8f0">';
    h+='<td style="padding:4px 8px;text-align:center"><input type="checkbox" '+(p.selected?'checked':'')+' onchange="_hrmsSalImpToggle(\''+mode+'\','+idx+')"></td>';
    h+='<td style="padding:4px 8px;font-family:var(--mono);font-weight:800;color:var(--accent);text-decoration:underline;cursor:pointer" onclick="event.stopPropagation();_hrmsOpenEmpByCode(\''+(p.code+'').replace(/\'/g,"\\'")+'\')" title="Click to view employee profile">'+p.code+'</td>';
    h+='<td style="padding:4px 8px;text-align:center;font-family:var(--mono);'+_hi(false)+'">'+(p.oldRoll||'—')+'</td>';
    var newRollCell=(p.newRoll||'—')+(p.newRoll&&!p.rollValid?' <span title="Unknown role — add it to the Role Master first" style="color:#dc2626">⚠</span>':'');
    h+='<td style="padding:4px 8px;text-align:center;font-family:var(--mono);'+_hi(p.chRoll)+'">'+newRollCell+'</td>';
    h+='<td style="padding:4px 8px">'+p.name+(p.isStaff?' <span style="font-size:9px;background:#ede9fe;color:#6d28d9;padding:1px 5px;border-radius:3px;margin-left:3px">STAFF</span>':'')+'</td>';
    h+='<td style="padding:4px 8px;text-align:center;font-weight:800;color:var(--accent)">'+p.wefLabel+'</td>';
    // Sal/Day — hidden for staff
    if(p.isStaff){
      h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);color:var(--text3)">'+_dash+'</td>';
      h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);color:var(--text3)">'+_dash+'</td>';
    } else {
      h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);'+_hi(false)+'">'+p.oldD+'</td>';
      h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);'+_hi(p.chD)+'">'+p.newD+'</td>';
    }
    h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);'+_hi(false)+'">'+p.oldM+'</td>';
    h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);'+_hi(p.chM)+'">'+p.newM+'</td>';
    h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);'+_hi(false)+'">'+p.oldSp+'</td>';
    h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);'+_hi(p.chSp)+'">'+p.newSp+'</td>';
    var diffClr=p.diff>0?'#16a34a':p.diff<0?'#dc2626':'var(--text3)';
    var diffSign=p.diff>0?'+':'';
    h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);font-weight:800;color:'+diffClr+'" title="'+(p.isStaff?'Sal/Month delta':'Sal/Day delta')+'">'+diffSign+p.diff+'</td>';
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  el.innerHTML=h;

  if(selBtn) selBtn.style.display=selCount?'':'none';
  if(allBtn) allBtn.style.display='';
  if(cancelBtn) cancelBtn.style.display='';
}

// Auto-diff view — compares each filtered employee's active period at the
// selected month with their period one month prior, surfacing any salary /
// roll / allowance change. Shown whenever there's no import preview active.
function _hrmsSalImpRenderAutoDiff(mode,el,summaryEl){
  var cfg=_HRMS_SAL_IMP_CFG[mode];if(!cfg||!el) return;
  var mk=_hrmsMonth;
  if(!mk){
    el.innerHTML='<div class="empty-state" style="padding:20px">Select a month above to view salary changes.</div>';
    if(summaryEl) summaryEl.textContent='';
    return;
  }
  var prevMk=_hrmsSalImpPrevOf(mk);
  var _mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var cp=mk.split('-');   var curLabel=_mn[+cp[1]]+'-'+cp[0].slice(2);
  var pp=prevMk.split('-');var prevLabel=_mn[+pp[1]]+'-'+pp[0].slice(2);

  var rows=[];
  (DB.hrmsEmployees||[]).forEach(function(emp){
    var periods=(emp.periods||[]).filter(function(pr){return !pr._wfStatus||pr._wfStatus==='approved';});
    if(!periods.length) return;
    var curP=null,prevP=null;
    for(var i=0;i<periods.length;i++){
      var from=periods[i].from||'0000-00';
      var to=periods[i].to||'9999-12';
      if(mk>=from&&mk<=to) curP=periods[i];
      if(prevMk>=from&&prevMk<=to) prevP=periods[i];
    }
    if(!curP) return;
    var et=((curP.employmentType||emp.employmentType||'')+'').toLowerCase().replace(/\s/g,'');
    if(et!==cfg.etCode) return;
    if(!prevP) prevP=curP;
    var isStaff=((curP.category||emp.category||'')+'').toLowerCase()==='staff';
    var oldRoll=prevP.roll||'', newRoll=curP.roll||'';
    var oldD=+prevP.salaryDay||0, newD=+curP.salaryDay||0;
    var oldM=+prevP.salaryMonth||0, newM=+curP.salaryMonth||0;
    var oldSp=+prevP.specialAllowance||0, newSp=+curP.specialAllowance||0;
    var chRoll=oldRoll!==newRoll, chD=oldD!==newD, chM=oldM!==newM, chSp=oldSp!==newSp;
    if(!chRoll&&!chD&&!chM&&!chSp) return;
    rows.push({
      code:emp.empCode||'', name:_hrmsDispName(emp), isStaff:isStaff,
      oldRoll:oldRoll, newRoll:newRoll,
      oldD:oldD, newD:newD, oldM:oldM, newM:newM, oldSp:oldSp, newSp:newSp,
      diff:isStaff?(newM-oldM):(newD-oldD),
      chRoll:chRoll, chD:chD, chM:chM, chSp:chSp, wefLabel:curLabel
    });
  });

  if(summaryEl) summaryEl.textContent=rows.length+' '+cfg.etPretty.toLowerCase()+' salary change(s): '+prevLabel+' → '+curLabel;

  if(!rows.length){
    el.innerHTML='<div style="padding:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;font-size:13px;color:#15803d;font-weight:600">No '+cfg.etPretty.toLowerCase()+' salary changes between '+prevLabel+' and '+curLabel+'.</div>';
    return;
  }

  rows.sort(function(a,b){return(parseInt(a.code)||0)-(parseInt(b.code)||0)||a.code.localeCompare(b.code);});

  var _th='padding:6px 8px;font-size:10px;font-weight:800';
  var h='<div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:6px">'+rows.length+' '+cfg.etPretty.toLowerCase()+' salary change(s) · '+prevLabel+' → '+curLabel+'</div>';
  h+='<div style="overflow-x:auto;border:1.5px solid var(--accent);border-radius:8px">';
  h+='<table style="width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap">';
  h+='<thead><tr style="background:#1e293b;color:#fff;position:sticky;top:0;z-index:1">';
  h+='<th style="'+_th+';text-align:left">Code</th>';
  h+='<th style="'+_th+';text-align:center" colspan="2">Roll</th>';
  h+='<th style="'+_th+';text-align:left">Name</th>';
  h+='<th style="'+_th+';text-align:right" colspan="2">Sal/Day</th>';
  h+='<th style="'+_th+';text-align:right" colspan="2">Sal/Month</th>';
  h+='<th style="'+_th+';text-align:right" colspan="2">Allow/Month</th>';
  h+='<th style="'+_th+';text-align:right">Diff</th>';
  h+='</tr>';
  h+='<tr style="background:#334155;color:#94a3b8;font-size:9px">';
  h+='<th></th>';
  h+='<th style="padding:2px 8px;text-align:center">'+prevLabel+'</th><th style="padding:2px 8px;text-align:center">'+curLabel+'</th>';
  h+='<th></th>';
  h+='<th style="padding:2px 8px;text-align:right">'+prevLabel+'</th><th style="padding:2px 8px;text-align:right">'+curLabel+'</th>';
  h+='<th style="padding:2px 8px;text-align:right">'+prevLabel+'</th><th style="padding:2px 8px;text-align:right">'+curLabel+'</th>';
  h+='<th style="padding:2px 8px;text-align:right">'+prevLabel+'</th><th style="padding:2px 8px;text-align:right">'+curLabel+'</th>';
  h+='<th></th>';
  h+='</tr></thead><tbody>';
  var _hi=function(c){return c?'background:#fef3c7;font-weight:800;color:#92400e':'color:var(--text3)';};
  var _dash='<span style="color:var(--text3);font-weight:400">—</span>';
  rows.forEach(function(r){
    h+='<tr style="border-bottom:1px solid #e2e8f0">';
    h+='<td style="padding:4px 8px;font-family:var(--mono);font-weight:800;color:var(--accent);text-decoration:underline;cursor:pointer" onclick="_hrmsOpenEmpByCode(\''+(r.code+'').replace(/\'/g,"\\'")+'\')" title="Click to view employee profile">'+r.code+'</td>';
    h+='<td style="padding:4px 8px;text-align:center;font-family:var(--mono);'+_hi(false)+'">'+(r.oldRoll||'—')+'</td>';
    h+='<td style="padding:4px 8px;text-align:center;font-family:var(--mono);'+_hi(r.chRoll)+'">'+(r.newRoll||'—')+'</td>';
    h+='<td style="padding:4px 8px">'+r.name+(r.isStaff?' <span style="font-size:9px;background:#ede9fe;color:#6d28d9;padding:1px 5px;border-radius:3px;margin-left:3px">STAFF</span>':'')+'</td>';
    if(r.isStaff){
      h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);color:var(--text3)">'+_dash+'</td>';
      h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);color:var(--text3)">'+_dash+'</td>';
    } else {
      h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);'+_hi(false)+'">'+r.oldD+'</td>';
      h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);'+_hi(r.chD)+'">'+r.newD+'</td>';
    }
    h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);'+_hi(false)+'">'+r.oldM+'</td>';
    h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);'+_hi(r.chM)+'">'+r.newM+'</td>';
    h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);'+_hi(false)+'">'+r.oldSp+'</td>';
    h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);'+_hi(r.chSp)+'">'+r.newSp+'</td>';
    var diffClr=r.diff>0?'#16a34a':r.diff<0?'#dc2626':'var(--text3)';
    var diffSign=r.diff>0?'+':'';
    h+='<td style="padding:4px 8px;text-align:right;font-family:var(--mono);font-weight:800;color:'+diffClr+'" title="'+(r.isStaff?'Sal/Month delta':'Sal/Day delta')+'">'+diffSign+r.diff+'</td>';
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  el.innerHTML=h;
}

function _hrmsSalImpToggle(mode,idx){
  var d=_hrmsSalImpData[mode];if(!d||!d.preview[idx]) return;
  d.preview[idx].selected=!d.preview[idx].selected;
  _hrmsSalImpRenderPreview(mode);
}
function _hrmsSalImpSelectAll(mode,on){
  var d=_hrmsSalImpData[mode];if(!d) return;
  d.preview.forEach(function(p){p.selected=!!on;});
  _hrmsSalImpRenderPreview(mode);
}
function _hrmsSalImpCancel(mode){ _hrmsSalImpData[mode]=null; _hrmsSalImpRenderPreview(mode); }

async function _hrmsSalImpApprove(mode,selectedOnly){
  var cfg=_HRMS_SAL_IMP_CFG[mode];if(!cfg){notify('Invalid mode',true);return;}
  if(!_hrmsHasAccess(cfg.perm)){notify('Access denied',true);return;}
  var d=_hrmsSalImpData[mode];
  if(!d||!d.preview.length){notify('Nothing to approve',true);return;}
  var items=d.preview.filter(function(p){return selectedOnly?p.selected:true;});
  if(!items.length){notify('No rows selected',true);return;}

  var wefGroups={};items.forEach(function(p){wefGroups[p.wefLabel]=(wefGroups[p.wefLabel]||0)+1;});
  var wefSummary=Object.keys(wefGroups).map(function(k){return wefGroups[k]+'×'+k;}).join(', ');
  if(!confirm('Apply salary revision for '+items.length+' '+cfg.etPretty.toLowerCase()+' employee(s)? ('+wefSummary+')')) return;

  showSpinner('Applying '+items.length+' revision(s)…');
  var updated=0,errors=0;
  for(var j=0;j<items.length;j++){
    var p=items[j];var emp=p.emp;var curP=p.curP;
    try{
      emp.periods=emp.periods||[];
      if(curP._virtual){
        // Legacy employee had no periods — materialize them now.
        var base={};
        Object.keys(curP).forEach(function(k){if(k!=='_virtual') base[k]=curP[k];});
        delete base._wfStatus;delete base._ecrResult;
        if((curP.from||'')===p.wef){
          var singleP=Object.assign({},base,{roll:p.newRoll,salaryDay:p.newD,salaryMonth:p.newM,specialAllowance:p.newSp});
          emp.periods.push(singleP);
        } else {
          var closedP=Object.assign({},base,{to:p.prevMonth});
          var openP=Object.assign({},base,{from:p.wef,to:null,roll:p.newRoll,salaryDay:p.newD,salaryMonth:p.newM,specialAllowance:p.newSp});
          emp.periods.push(closedP);
          emp.periods.unshift(openP);
        }
      } else if((curP.from||'')===p.wef){
        curP.roll=p.newRoll;
        curP.salaryDay=p.newD;
        curP.salaryMonth=p.newM;
        curP.specialAllowance=p.newSp;
      } else {
        curP.to=p.prevMonth;
        var newP={};
        Object.keys(curP).forEach(function(k){newP[k]=curP[k];});
        newP.from=p.wef;
        newP.to=null;
        newP.roll=p.newRoll;
        newP.salaryDay=p.newD;
        newP.salaryMonth=p.newM;
        newP.specialAllowance=p.newSp;
        delete newP._wfStatus;delete newP._ecrResult;
        emp.periods.unshift(newP);
      }
      emp.roll=p.newRoll;
      emp.salaryDay=p.newD;
      emp.salaryMonth=p.newM;
      emp.specialAllowance=p.newSp;
      if(typeof _hrmsSanitize==='function') _hrmsSanitize(emp);
      if(typeof _hrmsSanitizePeriods==='function') _hrmsSanitizePeriods(emp.periods);
      if(await _dbSave('hrmsEmployees',emp)) updated++;
      else errors++;
    }catch(e){console.warn('approve row failed',p.code,e);errors++;}
  }
  if(typeof _hrmsContractCache!=='undefined') _hrmsContractCache={};
  hideSpinner();

  var appliedSet={};items.forEach(function(p){appliedSet[p.code]=true;});
  d.preview=d.preview.filter(function(p){return !appliedSet[p.code];});
  if(!d.preview.length) _hrmsSalImpData[mode]=null;

  notify('✅ '+updated+' revision(s) applied'+(errors?' · '+errors+' failed':''));
  _hrmsSalImpRenderPreview(mode);
  if(typeof renderHrmsEmployees==='function') renderHrmsEmployees();
  if(typeof renderHrmsDashboard==='function') renderHrmsDashboard();
  if(typeof _hrmsRenderActiveTab==='function') _hrmsRenderActiveTab();
}

async function _hrmsRenderContractSalary(yr,mo){
  var grid=document.getElementById('hrmsContractGrid');if(!grid)return;
  if(!_hrmsHasAccess('tab.contract')){grid.innerHTML='<div class="empty-state" style="padding:20px">🔒 Access denied</div>';return;}
  var mk=yr+'-'+String(mo).padStart(2,'0');
  var daysInMo=new Date(yr,mo,0).getDate();
  var mStart=mk+'-01',mEnd=mk+'-'+String(daysInMo).padStart(2,'0');

  // NOTE: previously this short-circuited to saved.meta.contract for locked
  // months, but that froze the table against any filter-rule changes (the
  // stored snapshot only held rows computed under the old filter). Always
  // recompute live — roll rates + attendance are authoritative.

  // Load prerequisites (same as Salary tab)
  showSpinner('Loading contract salary…');
  try{
    _hrmsLoadStatutory();
    var otR=_hrmsGetOtRules(mk);
    await _hrmsAttFetchMonth(mk);
    _hrmsLoadManualP();
    _hrmsComputeAttTotals(yr,mo);
  }catch(e){
    console.error('Contract salary load error:',e);
    notify('Error loading contract salary: '+(e&&e.message||e),true);
    // Force-reset spinner depth so a stuck spinner clears
    if(typeof _spinDepth!=='undefined') _spinDepth=0;
    var ov=document.getElementById('kapSpinnerOverlay');if(ov) ov.style.display='none';
    return;
  }finally{
    hideSpinner();
  }

  // Find active (non-draft/proposed/rejected) period for each employee at this month
  var _getPeriod=function(emp,mk){
    var periods=(emp.periods||[]).slice().filter(function(p){
      // Ignore draft/proposed/rejected revisions — they're not active
      return !p._wfStatus||p._wfStatus==='approved';
    }).sort(function(a,b){return(b.from||'').localeCompare(a.from||'');});
    for(var i=0;i<periods.length;i++){
      var p=periods[i];
      if((p.from||'')<=mk&&(!p.to||p.to>=mk)) return p;
    }
    return null;
  };

  // Filter: contract employees, ignoring status entirely. Gate only by the
  // joining/leaving window plus employmentType; the attendance presence check
  // below drops anyone without a Jan-style punch record for the month.
  var emps=(DB.hrmsEmployees||[]).filter(function(e){
    if(e.dateOfJoining&&e.dateOfJoining>mEnd) return false;
    if(e.dateOfLeft&&e.dateOfLeft<mStart) return false;
    var p=_getPeriod(e,mk);
    // If no matching period, fall back entirely to flat field (pre-period data).
    var et=((p&&p.employmentType)||e.employmentType||'').toLowerCase().replace(/\s/g,'');
    return et==='contract';
  });

  // Compute each row
  var esiCompPct=_hrmsStatutory.esiCompany||3.25;
  var rows=[];
  emps.forEach(function(emp){
    var period=_getPeriod(emp,mk)||{};
    var roll=period.roll||emp.roll||'';
    // Rate/Day comes from the active period's salaryDay (Organization & Salary
    // revision), with the flat employee value as legacy fallback. Roll-based
    // rates were retired — the Roll master is now descriptive only.
    var rateD=(+period.salaryDay||0)||(+emp.salaryDay||0);
    var rateM=period.salaryMonth||emp.salaryMonth||0;
    var spAllowM=+period.specialAllowance||+emp.specialAllowance||0;
    var plant=period.location||emp.location||'';
    var team=period.teamName||emp.teamName||'—';

    // Working days & paid holidays (plant calendar)
    var wdCount=0,phCount=0;
    for(var dd=1;dd<=daysInMo;dd++){
      var dType=_hrmsGetDayType(mk,dd,yr,mo,plant);
      if(dType==='PH') phCount++;
      if(dType!=='WO'&&dType!=='PH') wdCount++;
    }

    // Attendance totals (already computed into emp._totalP etc.)
    var totalP=+emp._totalP||0;
    var totalOT=+emp._totalOT||0;
    var totalOTS=+emp._totalOTS||0;
    // Manual overrides
    var _mpData=(_hrmsManualPData[mk]||{});
    if(_mpData[emp.empCode]!==undefined) totalP=_mpData[emp.empCode];
    if(emp.extra&&emp.extra.manualOT&&emp.extra.manualOT[mk]!==undefined) totalOT=emp.extra.manualOT[mk];
    if(emp.extra&&emp.extra.manualOTS&&emp.extra.manualOTS[mk]!==undefined) totalOTS=emp.extra.manualOTS[mk];
    // Skip employees who weren't present this month — no attendance record
    // and no manual P/OT entries means there's nothing to pay.
    if(totalP<=0&&totalOT<=0&&totalOTS<=0) return;
    // OT not applicable for Staff (even under contract)
    var _empCat=(period.category||emp.category||'').toLowerCase();
    if(_empCat==='staff'){totalOT=0;totalOTS=0;}

    var absent=Math.max(wdCount-totalP,0);
    // PH paid only if employee is present at least 10 days that month
    var effPhCount=totalP>=10?phCount:0;
    var pPlusPH=totalP+effPhCount;
    var otTotal=totalOT+totalOTS;
    var otAt1=otTotal;// contract: single-tier
    // Staff: rate/day = salaryMonth / (W+PH); forPresent = (P+PH) × Rate/Day = salaryMonth/(W+PH) × (P+PH)
    if(_empCat==='staff'){
      var _wdPh=wdCount+phCount;
      rateD=_wdPh>0?(rateM/_wdPh):0;
    }

    var forPresent=Math.round(pPlusPH*rateD);
    var forOT=Math.ceil(otAt1*(rateD/8));
    // Special Allowance: monthly amount prorated → spAllowance/(W+PH) × (P+PH)
    var _wdPhT=wdCount+phCount;
    var spAllow=_wdPhT>0?Math.round(spAllowM/_wdPhT*pPlusPH):0;
    var gross=forPresent+forOT+spAllow;
    // PF rule: gs>19000 → 1950; else cap base at (P+PH)*580, apply company PF%
    var pfPct=_hrmsStatutory.pfCompany||13;
    var pf;
    if(gross>19000) pf=1950;
    else {
      var pfBase=Math.min(gross,pPlusPH*580);
      pf=Math.round(pfBase*pfPct/100);
    }
    // ESI: applied when period.esiApplicable === 'Yes' (works for staff too).
    // Default if unset: Worker = Yes, Staff = No.
    var _esiApp=period.esiApplicable||(_empCat==='staff'?'No':'Yes');
    var esi=_esiApp==='Yes'?Math.ceil(gross*esiCompPct/100):0;
    var totalSal=gross+pf+esi;
    var commission=Math.round(gross*8/100);
    var totalBill=totalSal+commission;
    // Diwali bonus: P × per-day rate × 8.33%
    //   Staff: per-day rate uses (salaryMonth + spAllowance) / (W+PH)
    //   Worker: per-day rate uses rateD (salaryDay)
    var diwaliPerDay=_empCat==='staff'?(_wdPhT>0?((rateM+spAllowM)/_wdPhT):0):rateD;
    var diwali=Math.round(totalP*diwaliPerDay*0.0833);
    var ctc=totalBill+diwali;

    rows.push({
      empCode:emp.empCode,name:_hrmsDispName(emp),doj:emp.dateOfJoining||'',team:team,plant:plant,roll:roll,
      cat:_empCat,rateD:rateD,rateM:rateM,P:totalP,OT:totalOT,OTS:totalOTS,PH:effPhCount,pPlusPH:pPlusPH,A:absent,
      totalOT:otTotal,otAt1:otAt1,forPresent:forPresent,forOT:forOT,spAllow:spAllow,gross:gross,
      pf:pf,esi:esi,totalSal:totalSal,commission:commission,totalBill:totalBill,
      diwali:diwali,ctc:ctc,wdCount:wdCount
    });
  });

  _hrmsContractCache[mk]=rows;
  _hrmsContractRenderRows(grid,rows,mk,yr,mo);
}

function _hrmsContractRenderRows(grid,rows,mk,yr,mo){
  // Drop rows with no attendance for the month. Covers legacy snapshots from
  // locked months that were saved before the "skip absent employees" rule.
  rows=(rows||[]).filter(function(r){
    return (+r.P||0)>0||(+r.OT||0)>0||(+r.OTS||0)>0;
  });
  // Build team filter buttons from the full row set (before applying filter)
  _hrmsContractBuildTeamFilter(rows);
  if(!rows.length){grid.innerHTML='<div class="empty-state" style="padding:20px">No Contract employees with attendance for '+_hrmsMonthLabel(mk)+'.</div>';return;}
  // Apply team filter
  var sel=_hrmsContractTeamFilter||'All';
  var filteredRows=sel==='All'?rows:rows.filter(function(r){return(r.team||'—')===sel;});
  // Apply emp code / name search
  var q=(_hrmsContractEmpQ||'').trim().toLowerCase();
  if(q){
    filteredRows=filteredRows.filter(function(r){
      return(r.empCode||'').toLowerCase().indexOf(q)>=0||(r.name||'').toLowerCase().indexOf(q)>=0;
    });
  }
  if(!filteredRows.length){grid.innerHTML='<div class="empty-state" style="padding:20px">No employees match'+(q?' "'+q+'"':'')+(sel!=='All'?' in team "'+sel+'"':'')+' for '+_hrmsMonthLabel(mk)+'.</div>';return;}

  // Sort across all rows: Plant → Roll → Emp Code
  filteredRows.sort(function(a,b){
    var p=(a.plant||'').localeCompare(b.plant||'');if(p!==0) return p;
    var r=(a.roll||'').localeCompare(b.roll||'');if(r!==0) return r;
    return(parseInt(a.empCode)||0)-(parseInt(b.empCode)||0)||(a.empCode||'').localeCompare(b.empCode||'');
  });

  var _r=function(v){return Math.round(v||0).toLocaleString();};
  var _f=function(v){if(v==null)return'0';if(v%1===0) return String(v); return(Math.round(v*4)/4).toFixed(2).replace(/\.?0+$/,'');};
  var _th='padding:5px 4px;font-size:12px;font-weight:800;background:#f1f5f9;border:1px solid #cbd5e1;white-space:nowrap;color:#1e293b';
  var _td='padding:4px 5px;font-size:13px;border:1px solid #e2e8f0;white-space:nowrap';

  // Sticky-left widths for #, Emp Code, Name
  var _W1=32,_W2=70,_W3=170;
  var _stkTh1='position:sticky;left:0px;z-index:4;background:#f1f5f9;min-width:'+_W1+'px';
  var _stkTh2='position:sticky;left:'+_W1+'px;z-index:4;background:#f1f5f9;min-width:'+_W2+'px';
  var _stkTh3='position:sticky;left:'+(_W1+_W2)+'px;z-index:4;background:#f1f5f9;min-width:'+_W3+'px';
  var _stkTd1='position:sticky;left:0px;z-index:1;background:#fff;min-width:'+_W1+'px';
  var _stkTd2='position:sticky;left:'+_W1+'px;z-index:1;background:#fff;min-width:'+_W2+'px';
  var _stkTd3='position:sticky;left:'+(_W1+_W2)+'px;z-index:1;background:#fff;min-width:'+_W3+'px';
  var h='<table style="border-collapse:collapse;font-size:13px;white-space:nowrap;width:auto">';
  // Header (top-sticky)
  h+='<thead style="position:sticky;top:0;z-index:3"><tr>';
  h+='<th style="'+_th+';'+_stkTh1+'">#</th>';
  h+='<th style="'+_th+';'+_stkTh2+'">Emp Code</th>';
  h+='<th style="'+_th+';text-align:left;'+_stkTh3+'">Name</th>';
  h+='<th style="'+_th+'">DOJ</th>';
  h+='<th style="'+_th+'">Team</th>';
  h+='<th style="'+_th+'">Plant</th>';
  h+='<th style="'+_th+'">Roll</th>';
  h+='<th style="'+_th+';background:#fef3c7;text-align:right">Rate/Day</th>';
  h+='<th style="'+_th+';background:#fef3c7;text-align:right">Sal/Month</th>';
  h+='<th style="'+_th+';background:#dbeafe;text-align:right">P</th>';
  h+='<th style="'+_th+';background:#dbeafe;text-align:right">OT</th>';
  h+='<th style="'+_th+';background:#dbeafe;text-align:right">OT@S</th>';
  h+='<th style="'+_th+';background:#dbeafe;text-align:right">PH</th>';
  h+='<th style="'+_th+';background:#dbeafe;text-align:right">P+PH</th>';
  h+='<th style="'+_th+';background:#fee2e2;text-align:right">A</th>';
  h+='<th style="'+_th+';background:#fff7ed;text-align:right">Total OT</th>';
  h+='<th style="'+_th+';background:#fff7ed;text-align:right">OT@1</th>';
  h+='<th style="'+_th+';background:#dcfce7;text-align:right">For Present</th>';
  h+='<th style="'+_th+';background:#dcfce7;text-align:right">For OT@1</th>';
  h+='<th style="'+_th+';background:#dcfce7;text-align:right">Sp.Allow</th>';
  h+='<th style="'+_th+';background:#dcfce7;text-align:right">Gross</th>';
  h+='<th style="'+_th+';background:#f3e8ff;text-align:right">PF</th>';
  h+='<th style="'+_th+';background:#f3e8ff;text-align:right">ESI</th>';
  h+='<th style="'+_th+';background:#f3e8ff;text-align:right">Total Salary</th>';
  h+='<th style="'+_th+';background:#fef3c7;text-align:right">Commission 8%</th>';
  h+='<th style="'+_th+';background:#fef3c7;text-align:right">Total Bill</th>';
  h+='<th style="'+_th+';background:#fce7f3;text-align:right">Diwali Bonus</th>';
  h+='<th style="'+_th+';background:#dcfce7;text-align:right">CTC</th>';
  h+='</tr></thead><tbody>';

  var sn=0;
  var grandTotals={P:0,OT:0,OTS:0,PH:0,pPlusPH:0,A:0,totalOT:0,otAt1:0,forPresent:0,forOT:0,spAllow:0,gross:0,pf:0,esi:0,totalSal:0,commission:0,totalBill:0,diwali:0,ctc:0,count:0};

  filteredRows.forEach(function(r){
    sn++;
    var pClr=_hrmsGetPlantColor(r.plant);
    h+='<tr style="cursor:pointer" onclick="_hrmsContractShowDetail(\''+r.empCode+'\')" onmouseover="this.style.outline=\'2px solid #2a9aa0\'" onmouseout="this.style.outline=\'\'">';
    h+='<td style="'+_td+';text-align:center;color:var(--text3);font-size:12px;'+_stkTd1+'">'+sn+'</td>';
    h+='<td style="'+_td+';font-family:var(--mono);font-weight:800;color:var(--accent);text-decoration:underline;cursor:pointer;'+_stkTd2+'" onclick="event.stopPropagation();_hrmsOpenEmpByCode(\''+r.empCode+'\')" title="Click to view employee profile">'+r.empCode+'</td>';
    h+='<td style="'+_td+';font-weight:700;'+_stkTd3+'">'+r.name+'</td>';
    h+='<td style="'+_td+';font-size:12px;color:var(--text3)">'+_hrmsFmtDate(r.doj)+'</td>';
    h+='<td style="'+_td+';font-weight:600">'+r.team+'</td>';
    h+='<td style="'+_td+';background:'+pClr+';font-weight:700;color:#1e293b;text-align:center">'+(r.plant||'').replace(/plant[\s\-]*/i,'P')+'</td>';
    h+='<td style="'+_td+';font-size:12px">'+r.roll+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#fef3c7">'+_r(r.rateD)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#fef3c7">'+(r.cat==='staff'?_r(r.rateM):'<span style="color:var(--text3);font-weight:400">—</span>')+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#eff6ff">'+_f(r.P)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#eff6ff">'+_hrmsFmtOT(r.OT)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#eff6ff">'+_hrmsFmtOT(r.OTS)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#eff6ff">'+r.PH+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#eff6ff;font-weight:700">'+_f(r.pPlusPH)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#fef2f2;color:#dc2626">'+_f(r.A)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#fff7ed">'+_hrmsFmtOT(r.totalOT)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#fff7ed">'+_hrmsFmtOT(r.otAt1)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#f0fdf4;font-weight:700">'+_r(r.forPresent)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#f0fdf4">'+_r(r.forOT)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#f0fdf4">'+_r(r.spAllow)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#dcfce7;font-weight:900;color:#15803d">'+_r(r.gross)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#faf5ff">'+_r(r.pf)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#faf5ff">'+_r(r.esi)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#faf5ff;font-weight:700">'+_r(r.totalSal)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#fef3c7">'+_r(r.commission)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#fef3c7;font-weight:800">'+_r(r.totalBill)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#fce7f3;color:#be185d">'+_r(r.diwali)+'</td>';
    h+='<td style="'+_td+';text-align:right;font-family:var(--mono);background:#dcfce7;font-weight:900;color:#15803d;font-size:14px">'+_r(r.ctc)+'</td>';
    h+='</tr>';
    ['P','OT','OTS','PH','pPlusPH','A','totalOT','otAt1','forPresent','forOT','spAllow','gross','pf','esi','totalSal','commission','totalBill','diwali','ctc'].forEach(function(k){grandTotals[k]+=r[k]||0;});
  });
  grandTotals.count=filteredRows.length;

  // Grand total — sticky at bottom (salary-page style: gray bg, dark text)
  var _stk='position:sticky;bottom:0;z-index:1;background:#e2e8f0';
  var _tf='padding:2px 3px;text-align:right;font-family:var(--mono);border:1px solid #cbd5e1;color:#1e293b;'+_stk;
  h+='</tbody><tfoot><tr style="font-weight:900"><td colspan="7" style="padding:4px 6px;border:1px solid #cbd5e1;left:0;z-index:2;'+_stk+'">Total ('+grandTotals.count+')</td>';
  h+='<td style="'+_tf+'"></td>';
  h+='<td style="'+_tf+'"></td>';
  h+='<td style="'+_tf+'">'+_f(grandTotals.P)+'</td>';
  h+='<td style="'+_tf+'">'+_hrmsFmtOT(grandTotals.OT)+'</td>';
  h+='<td style="'+_tf+'">'+_hrmsFmtOT(grandTotals.OTS)+'</td>';
  h+='<td style="'+_tf+'">'+grandTotals.PH+'</td>';
  h+='<td style="'+_tf+'">'+_f(grandTotals.pPlusPH)+'</td>';
  h+='<td style="'+_tf+'">'+_f(grandTotals.A)+'</td>';
  h+='<td style="'+_tf+'">'+_hrmsFmtOT(grandTotals.totalOT)+'</td>';
  h+='<td style="'+_tf+'">'+_hrmsFmtOT(grandTotals.otAt1)+'</td>';
  h+='<td style="'+_tf+'">'+_r(grandTotals.forPresent)+'</td>';
  h+='<td style="'+_tf+'">'+_r(grandTotals.forOT)+'</td>';
  h+='<td style="'+_tf+'">'+_r(grandTotals.spAllow)+'</td>';
  h+='<td style="'+_tf+';font-weight:900;color:#15803d">'+_r(grandTotals.gross)+'</td>';
  h+='<td style="'+_tf+'">'+_r(grandTotals.pf)+'</td>';
  h+='<td style="'+_tf+'">'+_r(grandTotals.esi)+'</td>';
  h+='<td style="'+_tf+'">'+_r(grandTotals.totalSal)+'</td>';
  h+='<td style="'+_tf+'">'+_r(grandTotals.commission)+'</td>';
  h+='<td style="'+_tf+'">'+_r(grandTotals.totalBill)+'</td>';
  h+='<td style="'+_tf+'">'+_r(grandTotals.diwali)+'</td>';
  h+='<td style="'+_tf+';font-weight:900;color:#15803d;font-size:14px">'+_r(grandTotals.ctc)+'</td>';
  h+='</tr></tfoot>';

  h+='</table>';
  grid.innerHTML=h;
}

function _hrmsContractBuildTeamFilter(rows){
  var bar=document.getElementById('hrmsContractTeamFilter');if(!bar)return;
  var teamCounts={};
  rows.forEach(function(r){var t=r.team||'—';teamCounts[t]=(teamCounts[t]||0)+1;});
  var teams=Object.keys(teamCounts).sort();
  var sel=_hrmsContractTeamFilter||'All';
  // If current selection no longer present, reset to All
  if(sel!=='All'&&!teamCounts[sel]){_hrmsContractTeamFilter='All';sel='All';}
  var _btn=function(label,key,count,active){
    var bg=active?'#2a9aa0':'#fff',clr=active?'#fff':'#1e293b',bd=active?'#1e7a7f':'#cbd5e1';
    return '<button onclick="_hrmsContractSetTeam(\''+key.replace(/'/g,"\\'")+'\')" style="padding:5px 12px;font-size:12px;font-weight:700;background:'+bg+';color:'+clr+';border:1.5px solid '+bd+';border-radius:6px;cursor:pointer">'+label+' <span style="opacity:.75;font-size:10px">('+count+')</span></button>';
  };
  var html=_btn('All','All',rows.length,sel==='All');
  teams.forEach(function(t){html+=_btn(t,t,teamCounts[t],sel===t);});
  bar.innerHTML=html;
}

function _hrmsContractSetTeam(team){
  _hrmsContractTeamFilter=team;
  var mk=_hrmsMonth;if(!mk)return;
  var grid=document.getElementById('hrmsContractGrid');if(!grid)return;
  var rows=_hrmsContractCache[mk]||[];
  var parts=mk.split('-');
  _hrmsContractRenderRows(grid,rows,mk,parseInt(parts[0]),parseInt(parts[1]));
}

function _hrmsContractShowDetail(empCode){
  var mk=_hrmsMonth;if(!mk) return;
  var r=(_hrmsContractCache[mk]||[]).find(function(x){return x.empCode===empCode;});
  if(!r) return;
  var _r=function(v){return Math.round(v||0).toLocaleString();};
  var _f=function(v){if(v==null)return'0';if(v%1===0) return String(v); return(Math.round(v*4)/4).toFixed(2).replace(/\.?0+$/,'');};
  var pfPct=_hrmsStatutory.pfCompany||13;
  var esiPct=_hrmsStatutory.esiCompany||3.25;
  var _section=function(title,clr,rows){
    var h='<div style="border:1.5px solid var(--border);border-radius:8px;padding:10px 12px;background:#fff;break-inside:avoid">';
    h+='<div style="font-size:13px;font-weight:900;color:'+clr+';margin-bottom:6px;padding-bottom:4px;border-bottom:2px solid '+clr+'">'+title+'</div>';
    h+='<table style="width:100%;border-collapse:collapse;font-size:12px">';
    rows.forEach(function(row){
      h+='<tr'+(row[2]?' style="'+row[2]+'"':'')+'><td style="padding:3px 4px;font-weight:600;color:var(--text2);white-space:nowrap">'+row[0]+'</td><td style="padding:3px 4px;font-weight:800;text-align:right;font-family:var(--mono)">'+row[1]+'</td></tr>';
    });
    h+='</table></div>';
    return h;
  };
  var empInfo=[
    ['Date of Joining',_hrmsFmtDate(r.doj)],
    ['Plant',r.plant||'—'],
    ['Team',r.team||'—'],
    ['Role',r.roll||'—'],
    ['Rate/Day',_r(r.rateD)]
  ];
  if(r.cat==='staff') empInfo.push(['Sal/Month',_r(r.rateM)]);
  var daysRows=[
    ['Working Days',r.wdCount],
    ['Paid Holidays (PH)',r.PH],
    ['Present (P)',_f(r.P)],
    ['P + PH',_f(r.pPlusPH)],
    ['Absent (A)',_f(r.A)]
  ];
  var otRows=[
    ['OT (weekday)',_hrmsFmtOT(r.OT)],
    ['OT@S (Sunday)',_hrmsFmtOT(r.OTS)],
    ['Total OT',_hrmsFmtOT(r.totalOT)],
    ['OT@1 (paid)',_hrmsFmtOT(r.otAt1)]
  ];
  var earnRows=[
    ['For Present (P+PH × Rate)',_r(r.forPresent)],
    ['For OT@1 (× Rate/8)',_r(r.forOT)],
    ['Special Allowance (prorated)',_r(r.spAllow)],
    ['Gross','<span style="color:#15803d">'+_r(r.gross)+'</span>','background:#dcfce7']
  ];
  var statRows=[
    ['PF ('+pfPct+'% / cap rule)',_r(r.pf)],
    ['ESI ('+(r.esi?esiPct+'%':'N/A')+')',_r(r.esi)],
    ['Total Salary (Gross + PF + ESI)','<span style="color:#15803d">'+_r(r.totalSal)+'</span>','background:#dcfce7']
  ];
  var billRows=[
    ['Total Salary',_r(r.totalSal)],
    ['Commission (8% of Gross)',_r(r.commission)],
    ['Total Bill','<span style="color:#a16207">'+_r(r.totalBill)+'</span>','background:#fef3c7'],
    ['Diwali Bonus (P × Rate × 8.33%)',_r(r.diwali)],
    ['CTC','<span style="color:#15803d">'+_r(r.ctc)+'</span>','background:#dcfce7']
  ];
  var h='<div>';
  h+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid var(--accent);gap:12px">';
  h+='<div><div style="font-size:20px;font-weight:900;color:var(--accent)"><span data-emp-code="'+r.empCode+'" style="cursor:pointer;text-decoration:underline" title="Click to view employee profile">'+r.empCode+'</span> — '+r.name+'</div>';
  h+='<div style="font-size:12px;color:var(--text3);margin-top:2px">'+(r.plant||'')+' · Contract · '+_hrmsMonthLabel(mk)+'</div></div>';
  h+='<div style="display:flex;align-items:center;gap:12px">';
  h+='<div style="text-align:right"><div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1px">CTC</div><div style="font-size:26px;font-weight:900;color:#15803d;font-family:var(--mono)">₹'+_r(r.ctc)+'</div></div>';
  h+='<button onclick="document.getElementById(\'mSalDetail\').style.display=\'none\'" style="padding:6px 14px;font-size:12px;font-weight:700;background:#f1f5f9;border:1.5px solid var(--border);color:var(--text);border-radius:6px;cursor:pointer">✕ Close</button>';
  h+='</div></div>';
  h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;align-items:start">';
  h+=_section('Employee Info','var(--accent)',empInfo);
  h+=_section('Days','#2563eb',daysRows);
  h+=_section('Overtime','#b45309',otRows);
  h+=_section('Earnings','#16a34a',earnRows);
  h+=_section('Statutory','#dc2626',statRows);
  h+=_section('Billing & CTC','#7c3aed',billRows);
  h+='</div></div>';
  // Reuse the shared salary-detail modal container
  var modal=document.getElementById('mSalDetail');
  if(!modal){
    modal=document.createElement('div');modal.id='mSalDetail';
    modal.style.cssText='display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.4);z-index:500;justify-content:center;align-items:center';
    modal.onclick=function(e){if(e.target===modal){modal.style.display='none';}};
    var inner=document.createElement('div');inner.id='mSalDetailInner';
    modal.appendChild(inner);document.body.appendChild(modal);
  }
  var inner=document.getElementById('mSalDetailInner');
  inner.style.cssText='background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);padding:18px 22px;max-width:1200px;width:96vw;max-height:94vh;overflow:auto';
  inner.innerHTML=h;
  modal.style.display='flex';
}

function _hrmsContractEmpSearchInput(inp){
  _hrmsContractEmpQ=inp.value||'';
  _hrmsContractClearBtnToggle();
  var mk=_hrmsMonth;if(!mk)return;
  var grid=document.getElementById('hrmsContractGrid');if(!grid)return;
  var rows=_hrmsContractCache[mk]||[];
  var parts=mk.split('-');
  _hrmsContractRenderRows(grid,rows,mk,parseInt(parts[0]),parseInt(parts[1]));
}

function _hrmsContractClearBtnToggle(){
  var inp=document.getElementById('hrmsContractEmpSearch');
  var btn=document.getElementById('hrmsContractEmpSearchClear');
  if(!inp||!btn)return;
  btn.style.display=inp.value?'inline-block':'none';
}

function _hrmsContractEmpSearchClear(){
  var inp=document.getElementById('hrmsContractEmpSearch');if(!inp)return;
  inp.value='';
  _hrmsEmpACClose('hrmsContractEmpSearch');
  _hrmsContractEmpSearchInput(inp);
  inp.focus();
}

function _hrmsContractExport(){
  if(!_hrmsHasAccess('action.exportContract')){notify('Access denied',true);return;}
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  var rows=_hrmsContractCache[mk]||[];
  if(!rows.length){notify('No contract salary data to export',true);return;}
  var headers=['Emp Code','Name','DOJ','Team','Plant','Role','Rate/Day','Sal/Month','P','OT','OT@S','PH','P+PH','A','Total OT','OT@1','For Present','For OT@1','Sp.Allow','Gross Salary','PF','ESI','Total Salary','Commission 8%','Total Bill','Diwali Bonus','CTC'];
  var _rowArr=function(r){return[r.empCode,r.name,r.doj,r.team,(r.plant||'').replace(/plant[\s\-]*/i,'P'),r.roll,r.rateD,r.cat==='staff'?r.rateM:'',r.P,Math.round((r.OT||0)*4)/4,Math.round((r.OTS||0)*4)/4,r.PH,r.pPlusPH,r.A,Math.round((r.totalOT||0)*4)/4,Math.round((r.otAt1||0)*4)/4,r.forPresent,r.forOT,r.spAllow,r.gross,r.pf,r.esi,r.totalSal,r.commission,r.totalBill,r.diwali,r.ctc];};
  var _totKeys=['P','OT','OTS','totalOT','forPresent','forOT','spAllow','gross','pf','esi','totalSal','commission','totalBill','diwali','ctc'];
  var _totRow=function(label,t){return['','','',label,'','','','',t.P,Math.round(t.OT*4)/4,Math.round(t.OTS*4)/4,'','','',Math.round(t.totalOT*4)/4,'',t.forPresent,t.forOT,t.spAllow,t.gross,t.pf,t.esi,t.totalSal,t.commission,t.totalBill,t.diwali,t.ctc];};
  var _sort=function(arr){arr.sort(function(a,b){
    var p=(a.plant||'').localeCompare(b.plant||'');if(p!==0) return p;
    var rr=(a.roll||'').localeCompare(b.roll||'');if(rr!==0) return rr;
    return(parseInt(a.empCode)||0)-(parseInt(b.empCode)||0)||(a.empCode||'').localeCompare(b.empCode||'');
  });};
  // Group by team
  var groups={};
  rows.forEach(function(r){var t=r.team||'—';if(!groups[t])groups[t]=[];groups[t].push(r);});
  var teamList=Object.keys(groups).sort();
  // Build "All" sheet
  var allData=[headers];
  var grand={P:0,OT:0,OTS:0,totalOT:0,forPresent:0,forOT:0,spAllow:0,gross:0,pf:0,esi:0,totalSal:0,commission:0,totalBill:0,diwali:0,ctc:0};
  teamList.forEach(function(team){
    _sort(groups[team]);
    groups[team].forEach(function(r){
      allData.push(_rowArr(r));
      _totKeys.forEach(function(k){grand[k]+=r[k]||0;});
    });
  });
  allData.push(_totRow('GRAND TOTAL',grand));
  // Build per-team sheets
  var sheets=[{name:'All',data:allData}];
  teamList.forEach(function(team){
    var teamData=[headers];
    var tt={P:0,OT:0,OTS:0,totalOT:0,forPresent:0,forOT:0,spAllow:0,gross:0,pf:0,esi:0,totalSal:0,commission:0,totalBill:0,diwali:0,ctc:0};
    groups[team].forEach(function(r){
      teamData.push(_rowArr(r));
      _totKeys.forEach(function(k){tt[k]+=r[k]||0;});
    });
    teamData.push(_totRow('TOTAL',tt));
    sheets.push({name:team.slice(0,31),data:teamData});
  });
  _downloadMultiSheetXlsx(sheets,'Contract_Salary_'+mk+'.xlsx');
  notify('📤 Exported contract salary ('+rows.length+' employees, '+(teamList.length+1)+' sheets)');
}

// ═══ CONTRACT SALARY — REFERENCE FILE COMPARE ════════════════════════════
var _hrmsContractRefData=null;

async function _hrmsContractLoadRef(inputEl){
  if(!inputEl||!inputEl.files||!inputEl.files[0])return;
  var file=inputEl.files[0];inputEl.value='';
  showSpinner('Reading reference file…');
  try{
    var reader=new FileReader();
    reader.onload=async function(ev){
      try{
        var rows=await _parseXLSX(ev.target.result);
        if(!rows.length){hideSpinner();notify('No data in file',true);return;}
        _hrmsContractRefData=rows;
        hideSpinner();
        var lbl=document.getElementById('hrmsContractRefLabel');
        if(lbl){
          lbl.innerHTML='📎 '+file.name+' ('+rows.length+' rows)<input type="file" accept=".xlsx,.xls,.csv" onchange="_hrmsContractLoadRef(this)" style="display:none">';
          lbl.style.background='#dcfce7';lbl.style.borderColor='#86efac';lbl.style.color='#15803d';
        }
        document.getElementById('hrmsContractCompareBtn').style.display='';
        notify('Reference file loaded: '+rows.length+' rows. Click Compare.');
      }catch(ex){hideSpinner();notify('Error: '+ex.message,true);}
    };
    reader.readAsArrayBuffer(file);
  }catch(ex){hideSpinner();notify(ex.message,true);}
}

function _hrmsContractGetCurrentRows(){
  var mk=_hrmsMonth;if(!mk) return [];
  var rows=_hrmsContractCache[mk]||[];
  // Build flat objects matching the export columns
  var out=[];
  rows.forEach(function(r){
    out.push({
      'Emp Code':String(r.empCode),'Name':r.name,'DOJ':r.doj,'Team':r.team,'Plant':r.plant,'Role':r.roll,
      'Rate/Day':r.rateD,'Sal/Month':r.cat==='staff'?r.rateM:'','P':r.P,'OT':Math.round((r.OT||0)*4)/4,'OT@S':Math.round((r.OTS||0)*4)/4,
      'PH':r.PH,'P+PH':r.pPlusPH,'A':r.A,
      'Total OT':Math.round((r.totalOT||0)*4)/4,'OT@1':Math.round((r.otAt1||0)*4)/4,
      'For Present':r.forPresent,'For OT@1':r.forOT,'Sp.Allow':r.spAllow,'Gross Salary':r.gross,
      'PF':r.pf,'ESI':r.esi,'Total Salary':r.totalSal,
      'Commission 8%':r.commission,'Total Bill':r.totalBill,'Diwali Bonus':r.diwali,'CTC':r.ctc
    });
  });
  return out;
}

function _hrmsContractCompare(){
  if(!_hrmsContractRefData){notify('Upload reference file first',true);return;}
  var curRows=_hrmsContractGetCurrentRows();
  if(!curRows.length){notify('No contract salary data. Open the tab first.',true);return;}
  var refRows=_hrmsContractRefData;
  var refHeaders=Object.keys(refRows[0]||{});
  var curHeaders=Object.keys(curRows[0]||{});
  // Key column: Emp Code (column index 0)
  var keyCol=refHeaders[0]||refHeaders[0];
  var _norm=function(s){return(s||'').replace(/[\s.\/]+/g,'').toLowerCase();};
  var refNormMap={};refHeaders.forEach(function(h){refNormMap[_norm(h)]=h;});
  // Map current → reference column
  var colMap={};var allHeaders=[];
  curHeaders.forEach(function(h){var rh=refNormMap[_norm(h)];if(rh){colMap[h]=rh;allHeaders.push(h);}});
  // Build keyed maps
  var refMap={};refRows.forEach(function(r){var k=(r[keyCol]||'').toString().trim();if(k)refMap[k]=r;});
  var curKeyCol=curHeaders[0]||curHeaders[0];
  var curMap={};curRows.forEach(function(r){var k=(r[curKeyCol]||'').toString().trim();if(k)curMap[k]=r;});
  // Union of keys
  var allKeys={};
  Object.keys(refMap).forEach(function(k){allKeys[k]=true;});
  Object.keys(curMap).forEach(function(k){allKeys[k]=true;});
  var keys=Object.keys(allKeys).sort(function(a,b){var na=parseInt(a)||0,nb=parseInt(b)||0;return na!==nb?na-nb:a.localeCompare(b);});
  var diffRows=[],matched=0,missingInCur=[],missingInRef=[];
  var colsWithDiffs={};colsWithDiffs[keyCol]=true;
  if(curHeaders[1]) colsWithDiffs[curHeaders[1]]=true;// Name
  keys.forEach(function(key){
    var r1=refMap[key],r2=curMap[key];
    if(!r1){missingInRef.push(key);return;}
    if(!r2){missingInCur.push(key);return;}
    var diffs={};var hasDiff=false;
    var _skipCmp={team:1,plant:1,doj:1,roll:1};
    var _strictCmp={p:1,a:1,ot:1};
    var _cleanNum=function(s){var n=parseFloat(s);if(isNaN(n))return s;var r=Math.round(n*100)/100;return String(r);};
    allHeaders.forEach(function(h){
      if(_skipCmp[_norm(h)]) return;
      var refCol=colMap[h]||h;
      var v1=(r1[refCol]===undefined?'':r1[refCol]).toString().trim();
      var v2=(r2[h]===undefined?'':r2[h]).toString().trim();
      var n1=parseFloat(v1),n2=parseFloat(v2);
      if(!isNaN(n1)&&!isNaN(n2)&&v1!==''&&v2!==''){
        // Clean floating-point noise for display
        v1=_cleanNum(v1);v2=_cleanNum(v2);
        var tol=_strictCmp[_norm(h)]?0.01:3;
        if(Math.abs(n1-n2)>tol){diffs[h]={old:v1,new:v2};hasDiff=true;colsWithDiffs[h]=true;}
      } else {
        if(v1.toLowerCase()!==v2.toLowerCase()){diffs[h]={old:v1,new:v2};hasDiff=true;colsWithDiffs[h]=true;}
      }
    });
    if(hasDiff) diffRows.push({key:key,diffs:diffs,r1:r1,r2:r2});
    else matched++;
  });
  var el=document.getElementById('hrmsContractCompareResult');
  var visHeaders=allHeaders.filter(function(h){return colsWithDiffs[h];});
  var summary='<div style="font-size:12px;font-weight:800;margin-bottom:6px">Differences: <span style="color:#dc2626">'+diffRows.length+'</span> | Matched: <span style="color:#16a34a">'+matched+'</span>';
  if(missingInCur.length) summary+=' | Missing in current: <span style="color:#f59e0b">'+missingInCur.length+'</span>';
  if(missingInRef.length) summary+=' | Missing in reference: <span style="color:#f59e0b">'+missingInRef.length+'</span>';
  summary+='</div>';
  if(!diffRows.length&&!missingInCur.length&&!missingInRef.length){
    el.innerHTML='<div style="padding:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;font-size:14px;color:#15803d;font-weight:700">✓ All matched! '+matched+' employees identical.</div>';
    el.style.display='';
    document.getElementById('hrmsContractCloseCompBtn').style.display='';
    return;
  }
  var h=summary;
  if(diffRows.length){
    h+='<div style="display:inline-block;overflow-x:auto;border:1.5px solid #dc2626;border-radius:8px;max-height:280px;overflow-y:auto">';
    h+='<table style="border-collapse:collapse;font-size:12px;white-space:nowrap"><thead><tr style="background:#1e293b;color:#fff;position:sticky;top:0;z-index:1">';
    visHeaders.forEach(function(c){h+='<th style="padding:4px 6px;font-size:10px;text-align:center">'+c+'</th>';});
    h+='</tr></thead><tbody>';
    diffRows.forEach(function(row){
      h+='<tr style="border-bottom:1px solid #e2e8f0">';
      visHeaders.forEach(function(c){
        var d=row.diffs[c];
        var val=row.r2[c]!==undefined?row.r2[c]:(row.r1[c]||'');
        var vStr=val===undefined||val===null?'':val.toString();
        var vn=parseFloat(vStr);if(!isNaN(vn)&&vStr!=='')vStr=String(Math.round(vn*100)/100);
        if(d){
          h+='<td style="padding:3px 6px;background:#fef2f2"><div style="color:#dc2626;text-decoration:line-through;font-size:10px">'+d.old+'</div><div style="color:#16a34a;font-weight:800">'+d.new+'</div></td>';
        } else {
          h+='<td style="padding:3px 6px;'+(c===keyCol?'font-family:var(--mono);font-weight:700;color:var(--accent)':'')+'">'+vStr+'</td>';
        }
      });
      h+='</tr>';
    });
    h+='</tbody></table></div>';
  }
  if(missingInCur.length){
    h+='<div style="margin-top:10px;padding:10px;background:#fef3c7;border:1.5px solid #fde047;border-radius:8px;font-size:12px"><b style="color:#92400e">In Reference but missing in current ('+missingInCur.length+'):</b> '+missingInCur.slice(0,30).join(', ')+(missingInCur.length>30?'…':'')+'</div>';
  }
  if(missingInRef.length){
    h+='<div style="margin-top:10px;padding:10px;background:#dbeafe;border:1.5px solid #93c5fd;border-radius:8px;font-size:12px"><b style="color:#1e40af">In current but missing in reference ('+missingInRef.length+'):</b> '+missingInRef.slice(0,30).join(', ')+(missingInRef.length>30?'…':'')+'</div>';
  }
  el.innerHTML=h;
  el.style.display='';
  document.getElementById('hrmsContractCloseCompBtn').style.display='';
}

function _hrmsContractCloseCompare(){
  document.getElementById('hrmsContractCompareResult').style.display='none';
  document.getElementById('hrmsContractCloseCompBtn').style.display='none';
}

// ═══ ADVANCES TAB ════════════════════════════════════════════════════════
var _hrmsAdvCache={};// monthKey → [{empCode,advance,emi,deduction,id}]

async function _hrmsLoadAdvances(mk){
  if(_hrmsAdvCache[mk]) return;
  showSpinner('Loading advances…');
  try{
    var sbTbl=SB_TABLES['hrmsAdvances'];
    if(_sb&&_sbReady&&sbTbl){
      var {data,error}=await _sb.from(sbTbl).select('*').eq('month_key',mk);
      if(!error&&data){
        if(!DB.hrmsAdvances) DB.hrmsAdvances=[];
        var parsed=data.map(function(row){return _fromRow('hrmsAdvances',row);}).filter(Boolean);
        // Merge into DB
        parsed.forEach(function(rec){
          var idx=DB.hrmsAdvances.findIndex(function(r){return r.id===rec.id;});
          if(idx>=0) DB.hrmsAdvances[idx]=rec; else DB.hrmsAdvances.push(rec);
        });
      }
    }
  }catch(e){console.warn('Advance load error:',e);}
  // Build cache from DB
  _hrmsAdvCache[mk]={};
  (DB.hrmsAdvances||[]).filter(function(a){return a.monthKey===mk;}).forEach(function(a){
    _hrmsAdvCache[mk][a.empCode]=a;
  });
  hideSpinner();
}

function _hrmsGetAdvOB(emp,mk){
  // OB = previous month's closing balance
  var prevMk=_hrmsPrevMonth(mk);
  // 1. Preferred: use the saved closing balance from previous month's salary computation
  //    (stored in emp.extra.bal[prevMk].advCB whenever salary is computed/saved).
  //    This is authoritative and doesn't require chaining back through all months.
  var bal=emp.extra&&emp.extra.bal&&emp.extra.bal[prevMk];
  if(bal&&bal.advCB!==undefined&&bal.advCB!==null){
    return Math.round(bal.advCB);
  }
  // 2. Fallback: chain from previous month's advance record (recursive)
  var prevRec=(DB.hrmsAdvances||[]).find(function(a){return a.empCode===emp.empCode&&a.monthKey===prevMk;});
  if(prevRec){
    var prevOB=_hrmsGetAdvOB(emp,prevMk);
    return Math.round(prevOB+(prevRec.advance||0)-(prevRec.deduction||0));
  }
  // 3. Final fallback: employee's initial imported OB
  return Math.round((emp.extra&&emp.extra.advOB)||0);
}

async function _hrmsRenderAdvances(){
  var mk=_hrmsMonth;
  var el=document.getElementById('hrmsAdvGrid');if(!el)return;
  if(!mk){el.innerHTML='<div class="empty-state">Select a month above</div>';return;}
  // Compute salary first (populates window._hrmsSalDetails and also writes emp.extra.bal[].advCB for OB chain)
  // Note: _hrmsRenderOrSalary wipes _hrmsAdvCache at the end, so we must load advances AFTER it.
  var p=mk.split('-');var yr=+p[0],mo=+p[1];
  await _hrmsRenderOrSalary(yr,mo,'all');
  // Load current and previous month advances (after salary so cache isn't wiped)
  await _hrmsLoadAdvances(mk);
  await _hrmsLoadAdvances(_hrmsPrevMonth(mk));

  var cache=_hrmsAdvCache[mk]||{};
  var daysInMonth=new Date(yr,mo,0).getDate();
  var _advMonthStart=mk+'-01';
  var _advMonthEnd=mk+'-'+String(daysInMonth).padStart(2,'0');
  var emps=(DB.hrmsEmployees||[]).filter(function(e){
    if((e.status||'Active')!=='Active') return false;
    // Gate by DOJ/DOL for this month
    if(e.dateOfJoining&&e.dateOfJoining>_advMonthEnd) return false;
    if(e.dateOfLeft&&e.dateOfLeft<_advMonthStart) return false;
    return true;
  });
  // Show employees who have OB or advance or deduction
  var rows=[];
  emps.forEach(function(emp){
    var rec=cache[emp.empCode]||{};
    var ob=Math.round(_hrmsGetAdvOB(emp,mk));
    var adv=Math.round(rec.advance||0);
    var emi=Math.round(rec.emi||0);
    var ded=Math.round(rec.deduction||0);
    var total=ob+adv;
    var cb=total-ded;
    if(!ob&&!adv&&!ded) return;// skip zero rows
    // Get net salary from salary details if available
    var salDet=window._hrmsSalDetails&&window._hrmsSalDetails[emp.empCode];
    var netSal=salDet?Math.round(salDet.net||0):0;
    rows.push({code:emp.empCode,name:_hrmsDispName(emp),location:emp.location||'',ob:ob,adv:adv,emi:emi,total:total,ded:ded,cb:cb,netSal:netSal,id:rec.id||null});
  });
  rows.sort(function(a,b){return(parseInt(a.code)||0)-(parseInt(b.code)||0);});

  var _mn=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var monthLabel=_mn[mo]+' '+yr;
  var totOB=0,totAdv=0,totDed=0,totCB=0;
  rows.forEach(function(r){totOB+=r.ob;totAdv+=r.adv;totDed+=r.ded;totCB+=r.cb;});
  var h='<div style="font-size:12px;font-weight:800;color:var(--text);margin-bottom:6px">Advances — '+monthLabel+' ('+rows.length+' employees)</div>';
  h+='<div style="display:flex;gap:12px;margin-bottom:8px;flex-wrap:wrap">';
  h+='<div style="padding:6px 14px;border:1.5px solid var(--border);border-radius:6px;font-size:12px"><span style="color:var(--text3);font-weight:600">Total OB:</span> <span id="hrmsAdvTotOB" style="font-weight:800;font-family:var(--mono)">'+totOB.toLocaleString()+'</span></div>';
  h+='<div style="padding:6px 14px;border:1.5px solid #fca5a5;border-radius:6px;font-size:12px;background:#fef2f2"><span style="color:#dc2626;font-weight:600">Total Advance:</span> <span id="hrmsAdvTotAdv" style="font-weight:800;font-family:var(--mono);color:#dc2626">'+totAdv.toLocaleString()+'</span></div>';
  h+='<div style="padding:6px 14px;border:1.5px solid #86efac;border-radius:6px;font-size:12px;background:#f0fdf4"><span style="color:#16a34a;font-weight:600">Total Deduction:</span> <span id="hrmsAdvTotDed" style="font-weight:800;font-family:var(--mono);color:#16a34a">'+totDed.toLocaleString()+'</span></div>';
  h+='<div id="hrmsAdvTotCBBox" style="padding:6px 14px;border:1.5px solid '+(totCB>0?'#fca5a5':'#86efac')+';border-radius:6px;font-size:12px;background:'+(totCB>0?'#fef2f2':'#f0fdf4')+'"><span style="font-weight:600;color:'+(totCB>0?'#dc2626':'#16a34a')+'">Total CB:</span> <span id="hrmsAdvTotCB" style="font-weight:800;font-family:var(--mono);color:'+(totCB>0?'#dc2626':'#16a34a')+'">'+totCB.toLocaleString()+'</span></div>';
  h+='</div>';
  h+='<div style="display:inline-block;overflow-x:auto;border:1.5px solid var(--border);border-radius:8px;max-height:500px;overflow-y:auto">';
  h+='<table style="border-collapse:collapse;font-size:12px">';
  h+='<thead><tr style="background:#1e293b;color:#fff;position:sticky;top:0;z-index:1;white-space:nowrap">';
  h+='<th style="padding:4px 6px;font-size:10px;text-align:left">Code</th>';
  h+='<th style="padding:4px 6px;font-size:10px;text-align:left">Name</th>';
  h+='<th style="padding:4px 6px;font-size:10px;text-align:left">Plant</th>';
  h+='<th style="padding:4px 6px;font-size:10px;text-align:right">OB</th>';
  h+='<th style="padding:4px 6px;font-size:10px;text-align:right">Advance</th>';
  h+='<th style="padding:4px 6px;font-size:10px;text-align:center">Action</th>';
  h+='<th style="padding:4px 6px;font-size:10px;text-align:right">Total</th>';
  h+='<th style="padding:4px 6px;font-size:10px;text-align:right">EMI</th>';
  h+='<th style="padding:4px 6px;font-size:10px;text-align:right">Deduction</th>';
  h+='<th style="padding:4px 6px;font-size:10px;text-align:right">CB</th>';
  h+='<th style="padding:4px 6px;font-size:10px;text-align:right">Net Salary</th>';
  h+='</tr></thead><tbody>';
  rows.forEach(function(r,ri){
    var cbClr=r.cb>0?'color:#dc2626':'color:#16a34a';
    h+='<tr style="border-bottom:1px solid #e2e8f0;white-space:nowrap">';
    h+='<td style="padding:4px 6px;font-family:var(--mono);font-weight:700;cursor:pointer;text-decoration:underline;color:var(--accent)" data-emp-code="'+r.code+'" title="Click to view employee">'+r.code+'</td>';
    h+='<td style="padding:4px 6px">'+r.name+'</td>';
    h+='<td style="padding:4px 6px;color:var(--text3)">'+r.location+'</td>';
    h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);'+(r.ob?'font-weight:700':'color:var(--text3)')+'">'+r.ob+'</td>';
    h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);'+(r.adv?'font-weight:700;color:#dc2626':'color:var(--text3)')+'">'+r.adv+'</td>';
    // Action: edit/delete only if an advance was taken in this month (not just carried-forward OB)
    var monthLocked=_hrmsIsMonthLocked(mk);
    var actions='';
    if(r.adv>0){
      if(monthLocked){
        actions+='<span style="color:var(--text3);font-size:10px" title="Month is locked">🔒</span>';
      } else {
        actions+='<button onclick="_hrmsEditAdvance(\''+r.code+'\')" title="Edit this month\'s advance" style="padding:2px 6px;font-size:10px;font-weight:700;background:#fef3c7;border:1px solid #fde047;color:#a16207;border-radius:3px;cursor:pointer;margin-right:3px">✏️</button>';
        actions+='<button onclick="_hrmsRemoveAdvance(\''+r.code+'\')" title="Delete this month\'s advance" style="padding:2px 6px;font-size:10px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:3px;cursor:pointer">🗑</button>';
      }
    } else {
      actions+='<span style="color:var(--text3);font-size:10px">—</span>';
    }
    h+='<td style="padding:4px 6px;text-align:center">'+actions+'</td>';
    h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);font-weight:800">'+r.total+'</td>';
    h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);color:var(--text3)">'+r.emi+'</td>';
    h+='<td style="padding:2px 4px;text-align:right"><input type="number" value="'+r.ded+'" min="0" step="100" data-code="'+r.code+'" onchange="_hrmsAdvDedChange(this)" style="width:70px;padding:3px 6px;border:1.5px solid var(--accent);border-radius:4px;text-align:right;font-family:var(--mono);font-weight:700"></td>';
    h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);font-weight:800;'+cbClr+'">'+r.cb+'</td>';
    h+='<td style="padding:4px 6px;text-align:right;font-family:var(--mono);font-weight:600" id="hrmsAdvNet_'+r.code+'">'+r.netSal.toLocaleString()+'</td>';
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  el.innerHTML=h;
  if(typeof _hrmsRenderAdvImportLog==='function') _hrmsRenderAdvImportLog();
}

// Recompute Total Deduction + Total CB from current input values + per-row
// CB cell, and re-tint the CB chip. Called after every per-row change so the
// summary chips stay in sync (single-row edits, Auto Deduct, Clear All).
function _hrmsAdvUpdateTotals(){
  var totDed=0,totCB=0;
  document.querySelectorAll('#hrmsAdvGrid tbody tr').forEach(function(tr){
    var cells=tr.querySelectorAll('td');
    var inp=cells[8]?cells[8].querySelector('input[data-code]'):null;
    if(!inp) return;
    var ded=parseFloat(inp.value)||0;
    var cb=parseFloat(((cells[9]&&cells[9].textContent)||'0').replace(/,/g,''))||0;
    totDed+=ded;totCB+=cb;
  });
  var dEl=document.getElementById('hrmsAdvTotDed');if(dEl) dEl.textContent=Math.round(totDed).toLocaleString();
  var cEl=document.getElementById('hrmsAdvTotCB');if(cEl) cEl.textContent=Math.round(totCB).toLocaleString();
  var cBox=document.getElementById('hrmsAdvTotCBBox');
  if(cBox){
    var pos=totCB>0;
    cBox.style.borderColor=pos?'#fca5a5':'#86efac';
    cBox.style.background=pos?'#fef2f2':'#f0fdf4';
    if(cEl) cEl.style.color=pos?'#dc2626':'#16a34a';
    var lbl=cBox.querySelector('span:first-child');
    if(lbl) lbl.style.color=pos?'#dc2626':'#16a34a';
  }
}

async function _hrmsAdvDedChange(input){
  var code=input.dataset.code;
  var ded=parseFloat(input.value)||0;
  var mk=_hrmsMonth;if(!mk)return;
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked.',true);return;}
  if(!_hrmsAdvCache[mk]) _hrmsAdvCache[mk]={};
  // Use DB.hrmsAdvances as source of truth (cache may be stale)
  var existingInDb=(DB.hrmsAdvances||[]).find(function(a){return a.empCode===code&&a.monthKey===mk;});
  var rec=existingInDb||_hrmsAdvCache[mk][code];
  var emp=(DB.hrmsEmployees||[]).find(function(e){return e.empCode===code;});
  var ob=emp?_hrmsGetAdvOB(emp,mk):0;
  var adv=rec?rec.advance||0:0;
  var cb=ob+adv-ded;
  // Update CB cell (index 9) and Net salary display in the row
  var tr=input.closest('tr');
  if(tr){
    var cells=tr.querySelectorAll('td');
    // Columns: 0:Code 1:Name 2:Plant 3:OB 4:Advance 5:Action 6:Total 7:EMI 8:Deduction(input) 9:CB 10:Net
    if(cells[9]){
      cells[9].style.color=cb>0?'#dc2626':'#16a34a';
      cells[9].textContent=cb;
    }
  }
  var salDet=window._hrmsSalDetails&&window._hrmsSalDetails[code];
  var netEl=document.getElementById('hrmsAdvNet_'+code);
  if(netEl&&salDet){
    var net=Math.round((salDet.net||0)-ded);
    netEl.textContent=net.toLocaleString();
  }
  // Refresh the Total Deduction / Total CB chips at the top of the panel.
  if(typeof _hrmsAdvUpdateTotals==='function') _hrmsAdvUpdateTotals();
  // Persist to database
  if(rec){
    rec.deduction=ded;
    _hrmsAdvCache[mk][code]=rec;
    await _dbSave('hrmsAdvances',rec);
  } else {
    if(!DB.hrmsAdvances) DB.hrmsAdvances=[];
    var newRec={id:'adv'+uid(),empCode:code,monthKey:mk,advance:0,emi:0,deduction:ded};
    DB.hrmsAdvances.push(newRec);
    _hrmsAdvCache[mk][code]=newRec;
    await _dbSave('hrmsAdvances',newRec);
  }
}

async function _hrmsAddAdvance(){
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked. Unlock to add advances.',true);return;}
  var code=document.getElementById('hrmsAdvCode').value.trim();
  var adv=parseFloat(document.getElementById('hrmsAdvAmount').value)||0;
  var emi=parseFloat(document.getElementById('hrmsAdvEmi').value)||0;
  if(!code){notify('Enter employee code',true);return;}
  if(!adv&&!emi){notify('Enter advance or EMI amount',true);return;}
  var emp=(DB.hrmsEmployees||[]).find(function(e){return(e.empCode||'').toUpperCase()===code.toUpperCase();});
  if(!emp){notify('Employee '+code+' not found',true);return;}
  if(!DB.hrmsAdvances) DB.hrmsAdvances=[];
  var existing=DB.hrmsAdvances.find(function(a){return a.empCode===emp.empCode&&a.monthKey===mk;});
  if(existing){
    existing.advance=(existing.advance||0)+adv;
    if(emi) existing.emi=emi;
    await _dbSave('hrmsAdvances',existing);
  } else {
    var rec={id:'adv'+uid(),empCode:emp.empCode,monthKey:mk,advance:adv,emi:emi,deduction:0};
    if(await _dbSave('hrmsAdvances',rec)) DB.hrmsAdvances.push(rec);
  }
  _hrmsAdvCache={};// force reload
  document.getElementById('hrmsAdvCode').value='';
  document.getElementById('hrmsAdvAmount').value='';
  document.getElementById('hrmsAdvEmi').value='';
  _hrmsRenderAdvances();
  notify('Advance added for '+emp.empCode);
}

async function _hrmsRemoveAdvance(code){
  var mk=_hrmsMonth;if(!mk)return;
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked.',true);return;}
  if(!confirm('Remove advance record for '+code+' in this month?'))return;
  var rec=(DB.hrmsAdvances||[]).find(function(a){return a.empCode===code&&a.monthKey===mk;});
  if(rec){
    DB.hrmsAdvances=DB.hrmsAdvances.filter(function(a){return a.id!==rec.id;});
    if(_sb&&_sbReady){try{await _sb.from(SB_TABLES['hrmsAdvances']).delete().eq('code',rec.id);}catch(e){}}
  }
  _hrmsAdvCache={};
  _hrmsRenderAdvances();
  notify('Advance removed for '+code);
}

async function _hrmsEditAdvance(code){
  var mk=_hrmsMonth;if(!mk)return;
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked.',true);return;}
  var rec=(DB.hrmsAdvances||[]).find(function(a){return a.empCode===code&&a.monthKey===mk;});
  var curAdv=rec?(rec.advance||0):0;
  var curEmi=rec?(rec.emi||0):0;
  var newAdv=prompt('Edit Advance amount for '+code+':',String(curAdv));
  if(newAdv===null) return;
  var advVal=parseFloat(newAdv);
  if(isNaN(advVal)||advVal<0){notify('Invalid advance amount',true);return;}
  var newEmi=prompt('Edit EMI amount for '+code+':',String(curEmi));
  if(newEmi===null) return;
  var emiVal=parseFloat(newEmi);
  if(isNaN(emiVal)||emiVal<0){notify('Invalid EMI amount',true);return;}

  showSpinner('Saving…');
  if(rec){
    rec.advance=Math.round(advVal);
    rec.emi=Math.round(emiVal);
    await _dbSave('hrmsAdvances',rec);
  } else {
    var newRec={id:'adv'+uid(),empCode:code,monthKey:mk,advance:Math.round(advVal),emi:Math.round(emiVal),deduction:0};
    if(!DB.hrmsAdvances) DB.hrmsAdvances=[];
    DB.hrmsAdvances.push(newRec);
    await _dbSave('hrmsAdvances',newRec);
  }
  hideSpinner();
  _hrmsAdvCache={};
  _hrmsRenderAdvances();
  notify('✅ Advance updated for '+code);
}

async function _hrmsSaveAdvDeductions(){
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked. Unlock it to make changes.',true);return;}
  var cache=_hrmsAdvCache[mk]||{};
  if(!DB.hrmsAdvances) DB.hrmsAdvances=[];
  var saved=0;
  // Read deduction values from inputs
  document.querySelectorAll('#hrmsAdvGrid input[data-code]').forEach(function(inp){
    var code=inp.dataset.code;
    var ded=Math.round(parseFloat(inp.value)||0);
    var rec=cache[code];
    if(rec) rec.deduction=ded;
  });
  // Save all cache entries with non-zero data
  var codes=Object.keys(cache);
  showSpinner('Saving deductions…');
  for(var i=0;i<codes.length;i++){
    var rec=cache[codes[i]];
    if(!rec.deduction&&!rec.advance) continue;
    var dbRec=DB.hrmsAdvances.find(function(a){return a.empCode===rec.empCode&&a.monthKey===mk;});
    if(dbRec){
      dbRec.deduction=rec.deduction;
      await _dbSave('hrmsAdvances',dbRec);
      saved++;
    } else {
      var newRec={id:rec.id||('adv'+uid()),empCode:rec.empCode,monthKey:mk,advance:rec.advance||0,emi:rec.emi||0,deduction:rec.deduction};
      if(await _dbSave('hrmsAdvances',newRec)){DB.hrmsAdvances.push(newRec);rec.id=newRec.id;saved++;}
    }
  }
  // Clear all advance caches so next month picks up updated CB as OB
  _hrmsAdvCache={};
  // Refresh salary tabs so deductions reflect immediately
  var p=mk.split('-');var yr=+p[0],mo=+p[1];
  await _hrmsRenderOrSalary(yr,mo,'all');
  await _hrmsSaveBalances('all');
  hideSpinner();
  notify('✅ Saved deductions & balances for '+saved+' employees');
}

// Bulk-set every visible row's deduction to 0. Triggers the per-row onchange
// handler so CB / Net cells update; user still needs to click Save Deductions
// to persist the changes.
function _hrmsAdvClearAll(){
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked. Unlock to make changes.',true);return;}
  if(!confirm('Set every deduction to 0?\n\nClick Save Deductions afterwards to persist the change.')) return;
  var inputs=document.querySelectorAll('#hrmsAdvGrid input[data-code]');
  if(!inputs.length){notify('No rows to clear');return;}
  inputs.forEach(function(inp){
    inp.value=0;
    inp.dispatchEvent(new Event('change'));
  });
  notify('🧹 Cleared '+inputs.length+' deduction(s) — click Save Deductions to persist');
}

// Auto-fill deductions per the user's rules:
//   • Negative total → deduction = -total (clear the credit balance).
//   • Staff: total > 5000 → deduct 5000 (capped at netSal); total < 3000 →
//     deduct full total (capped); 3000-5000 → deduct 3000 (capped).
//   • Non-staff: total > 3000 → deduct 3000 (capped at netSal); 0..3000 →
//     deduct full total (capped at netSal).
// netSal=0 (no salary computed) results in deduction=0 to avoid pushing
// the employee into negative net pay.
function _hrmsAdvAutoDeduct(){
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  if(_hrmsIsMonthLocked(mk)){notify('⚠ '+_hrmsMonthLabel(mk)+' is locked. Unlock to make changes.',true);return;}
  var inputs=document.querySelectorAll('#hrmsAdvGrid input[data-code]');
  if(!inputs.length){notify('No rows to auto-deduct');return;}
  if(!confirm('Auto-fill deductions for '+inputs.length+' row(s)?\n\nClick Save Deductions afterwards to persist the changes.')) return;
  var changed=0;
  inputs.forEach(function(inp){
    var code=inp.dataset.code;
    var emp=(DB.hrmsEmployees||[]).find(function(e){return e.empCode===code;});
    if(!emp) return;
    // Find this row's data — pull total + netSal from the rendered cells so
    // the auto-deduct uses exactly what the user sees.
    var tr=inp.closest('tr');if(!tr) return;
    var cells=tr.querySelectorAll('td');
    // Columns: 0:Code 1:Name 2:Plant 3:OB 4:Advance 5:Action 6:Total 7:EMI 8:Deduction(input) 9:CB 10:Net
    var total=parseFloat((cells[6]&&cells[6].textContent)||'0')||0;
    var netSal=parseFloat(((cells[10]&&cells[10].textContent)||'0').replace(/,/g,''))||0;
    // Determine staff status from active period (with flat fallback).
    var ap=(emp.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
    var cat=((ap&&ap.category)||emp.category||'').toLowerCase();
    var isStaff=cat.indexOf('staff')>=0;
    var deduction=0;
    if(total<0){
      deduction=-total;
    } else if(isStaff){
      if(total>5000) deduction=Math.min(5000,Math.max(0,netSal));
      else if(total<3000) deduction=Math.min(total,Math.max(0,netSal));
      else deduction=Math.min(3000,Math.max(0,netSal));
    } else {
      if(total>3000) deduction=Math.min(3000,Math.max(0,netSal));
      else deduction=Math.min(total,Math.max(0,netSal));
    }
    deduction=Math.round(deduction);
    if(String(deduction)!==String(inp.value)){
      inp.value=deduction;
      inp.dispatchEvent(new Event('change'));
      changed++;
    }
  });
  notify('⚡ Auto-deduct applied to '+changed+' row(s) — click Save Deductions to persist');
}

async function _hrmsImportAdvances(inputEl){
  if(!_hrmsHasAccess('action.importAdvances')){notify('Access denied',true);return;}
  if(!inputEl||!inputEl.files||!inputEl.files[0]){notify('No file selected',true);return;}
  if(_hrmsMonth&&_hrmsIsMonthLocked(_hrmsMonth)){notify('⚠ '+_hrmsMonthLabel(_hrmsMonth)+' is locked. Unlock to import.',true);return;}
  var file=inputEl.files[0];inputEl.value='';
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  var _fileName=file.name||'advances_import.xlsx';
  var _fileSize=file.size||0;
  var _fileBuf=null;
  showSpinner('Reading Excel…');
  try{
    var reader=new FileReader();
    reader.onload=async function(ev){
      try{
        _fileBuf=ev.target.result;
        var rows=await _parseXLSX(_fileBuf);
        if(!rows.length){hideSpinner();notify('No data in file',true);return;}
        if(!DB.hrmsAdvances) DB.hrmsAdvances=[];
        var _g=function(r,keys){
          var rKeys=Object.keys(r);
          for(var i=0;i<keys.length;i++){
            var k=keys[i].replace(/[\s./]+/g,'').toLowerCase();
            for(var j=0;j<rKeys.length;j++){
              if(rKeys[j].replace(/[\s./]+/g,'').toLowerCase()===k){
                var v=(r[rKeys[j]]||'').toString().trim();
                if(v) return v;
              }
            }
          }
          return '';
        };
        // Check if any records already exist for this month — ask user for strategy
        var existingRecs=(DB.hrmsAdvances||[]).filter(function(a){return a.monthKey===mk;});
        var mode='append';// append, replace-matching, full-replace
        if(existingRecs.length>0){
          hideSpinner();
          var choice=prompt(existingRecs.length+' advance record(s) already exist for '+_hrmsMonthLabel(mk)+'.\n\nType:\n  1 = OVERWRITE matching employees only (keep others unchanged)\n  2 = FULL REPLACE (delete ALL existing for the month, then import fresh)\n  Blank / Cancel = Cancel import','1');
          if(choice===null||choice===''){notify('Import cancelled');return;}
          if(choice==='2') mode='full-replace';
          else if(choice==='1') mode='replace-matching';
          else {notify('Import cancelled — invalid choice');return;}
          showSpinner('Importing…');
        }

        // Full replace: delete all existing records for this month first
        var deleted=0;
        if(mode==='full-replace'){
          for(var di=0;di<existingRecs.length;di++){
            var delRec=existingRecs[di];
            try{await _dbDel('hrmsAdvances',delRec.id);deleted++;}catch(e){console.warn('Delete error:',e);}
          }
          DB.hrmsAdvances=(DB.hrmsAdvances||[]).filter(function(a){return a.monthKey!==mk;});
        }

        var added=0,updated=0,skipped=0,nameMismatch=0;
        var skipReasons={noCode:[],noEmp:[],noValues:[]};
        var mismatchedNames=[];
        for(var i=0;i<rows.length;i++){
          var r=rows[i];
          var rowNum=i+2;
          var code=_g(r,['Emp Code','Employee Code','EmpCode','Code']);
          if(!code){skipped++;skipReasons.noCode.push('Row '+rowNum);continue;}
          var emp=(DB.hrmsEmployees||[]).find(function(e){return(e.empCode||'').toUpperCase()===code.toUpperCase();});
          if(!emp){skipped++;skipReasons.noEmp.push('Row '+rowNum+' (code: '+code+')');continue;}
          // Name is captured for audit/display only — warn on mismatch but
          // don't skip (the emp code is the authoritative key).
          var nameInFile=_g(r,['Name','Employee Name','Full Name','EmpName']);
          if(nameInFile){
            var masterName=(emp.name||'').toString().trim().toLowerCase();
            if(masterName&&nameInFile.toLowerCase()!==masterName){
              nameMismatch++;
              if(mismatchedNames.length<5) mismatchedNames.push(code+': "'+nameInFile+'" vs master "'+emp.name+'"');
            }
          }
          // Amount is the new canonical column; Advance/Adv are legacy aliases.
          var adv=parseFloat(_g(r,['Amount','Advance','Adv'])||0)||0;
          var ded=parseFloat(_g(r,['Deduction','Ded','Deduct'])||0)||0;
          var emi=parseFloat(_g(r,['EMI','Emi','Installment'])||0)||0;
          if(!adv&&!ded&&!emi){skipped++;skipReasons.noValues.push('Row '+rowNum+' ('+code+')');continue;}
          // paidBy and date are optional audit columns — captured for the log
          // only; not persisted on the advance row (schema has no columns).
          var existing=DB.hrmsAdvances.find(function(a){return a.empCode===emp.empCode&&a.monthKey===mk;});
          if(existing){
            existing.advance=Math.round(adv);
            existing.deduction=Math.round(ded);
            existing.emi=Math.round(emi);
            await _dbSave('hrmsAdvances',existing);
            updated++;
          } else {
            var rec={id:'adv'+uid(),empCode:emp.empCode,monthKey:mk,advance:Math.round(adv),emi:Math.round(emi),deduction:Math.round(ded)};
            if(await _dbSave('hrmsAdvances',rec)){DB.hrmsAdvances.push(rec);added++;}
          }
        }
        var valid=added+updated;

        // ── Save import log + file copy to DB (same pattern as ESSL/Alt) ──
        try{
          var logId='impAdv_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
          var logEntry={
            id:logId,timestamp:new Date().toISOString(),
            type:'advances',fileName:_fileName,fileSize:_fileSize,
            monthKey:mk,action:mode,totalRows:rows.length,
            valid:valid,invalid:skipped,
            added:added,updated:updated,deleted:deleted,
            nameMismatch:nameMismatch,
            importedBy:(CU?(CU.name||CU.id||''):'')
          };
          var advLogRec=(DB.hrmsSettings||[]).find(function(r){return r.key==='advImportLog';});
          if(!advLogRec){
            advLogRec={id:'hs_advImpLog',key:'advImportLog',data:{imports:[]}};
            if(!DB.hrmsSettings) DB.hrmsSettings=[];
            DB.hrmsSettings.push(advLogRec);
          }
          if(!advLogRec.data.imports) advLogRec.data.imports=[];
          advLogRec.data.imports.unshift(logEntry);
          if(advLogRec.data.imports.length>100) advLogRec.data.imports.length=100;
          await _dbSave('hrmsSettings',advLogRec);
          // Save file content separately so the log stays small
          if(_fileBuf){
            var b64=_hrmsAb2b64(_fileBuf);
            var fileRec={id:'hs_advImpFile_'+logId,key:'advImpFile_'+logId,data:{fileName:_fileName,base64:b64}};
            if(!DB.hrmsSettings.find(function(r){return r.id===fileRec.id;})) DB.hrmsSettings.push(fileRec);
            await _dbSave('hrmsSettings',fileRec);
          }
        }catch(logErr){console.warn('Advance import log save failed:',logErr);}

        _hrmsAdvCache={};
        hideSpinner();
        _hrmsRenderAdvances();
        var msg='✅ Advances imported: '+added+' added, '+updated+' updated'+(deleted?', '+deleted+' deleted':'')+(skipped?', '+skipped+' invalid':'')+(nameMismatch?', '+nameMismatch+' name-mismatch':'');
        notify(msg);
        // Show skip details if any
        if(skipped>0||nameMismatch>0){
          var details='';
          if(skipped>0){
            details+='Invalid '+skipped+' row(s):\n';
            if(skipReasons.noCode.length) details+='\n• Missing Emp Code ('+skipReasons.noCode.length+'): '+skipReasons.noCode.slice(0,10).join(', ')+(skipReasons.noCode.length>10?'…':'')+'\n';
            if(skipReasons.noEmp.length) details+='\n• Emp Code not found in master ('+skipReasons.noEmp.length+'): '+skipReasons.noEmp.slice(0,10).join(', ')+(skipReasons.noEmp.length>10?'…':'')+'\n';
            if(skipReasons.noValues.length) details+='\n• No Amount / Deduction / EMI ('+skipReasons.noValues.length+'): '+skipReasons.noValues.slice(0,10).join(', ')+(skipReasons.noValues.length>10?'…':'')+'\n';
          }
          if(nameMismatch>0){
            details+=(details?'\n':'')+'Name mismatch '+nameMismatch+' (file name vs master). Imported using Emp Code:\n';
            mismatchedNames.forEach(function(m){details+='• '+m+'\n';});
            if(nameMismatch>mismatchedNames.length) details+='…and '+(nameMismatch-mismatchedNames.length)+' more\n';
          }
          alert(details);
        }
      }catch(ex){hideSpinner();notify('Import error: '+ex.message,true);}
    };
    reader.readAsArrayBuffer(file);
  }catch(ex){hideSpinner();notify(ex.message,true);}
}

async function _hrmsImportAdvDeductions(inputEl){
  if(!inputEl||!inputEl.files||!inputEl.files[0]){notify('No file selected',true);return;}
  if(_hrmsMonth&&_hrmsIsMonthLocked(_hrmsMonth)){notify('⚠ '+_hrmsMonthLabel(_hrmsMonth)+' is locked. Unlock to import.',true);return;}
  var file=inputEl.files[0];inputEl.value='';
  var mk=_hrmsMonth;if(!mk){notify('Select a month first',true);return;}
  showSpinner('Reading Excel…');
  try{
    var reader=new FileReader();
    reader.onload=async function(ev){
      try{
        var rows=await _parseXLSX(ev.target.result);
        if(!rows.length){hideSpinner();notify('No data in file',true);return;}
        if(!DB.hrmsAdvances) DB.hrmsAdvances=[];
        var _g=function(r,keys){
          var rKeys=Object.keys(r);
          for(var i=0;i<keys.length;i++){
            var k=keys[i].replace(/[\s./]+/g,'').toLowerCase();
            for(var j=0;j<rKeys.length;j++){
              if(rKeys[j].replace(/[\s./]+/g,'').toLowerCase()===k){
                var v=(r[rKeys[j]]||'').toString().trim();
                if(v) return v;
              }
            }
          }
          return '';
        };
        var updated=0,skipped=0;
        for(var i=0;i<rows.length;i++){
          var r=rows[i];
          var code=_g(r,['Emp Code','Employee Code','EmpCode','Code']);
          if(!code){skipped++;continue;}
          var emp=(DB.hrmsEmployees||[]).find(function(e){return(e.empCode||'').toUpperCase()===code.toUpperCase();});
          if(!emp){skipped++;continue;}
          var ded=parseFloat(_g(r,['Deduction','Ded','Deduct','Amount'])||0)||0;
          if(!ded){skipped++;continue;}
          ded=Math.round(ded);
          // Update cache only — don't save to DB yet
          if(!_hrmsAdvCache[mk]) _hrmsAdvCache[mk]={};
          var cached=_hrmsAdvCache[mk][emp.empCode];
          if(cached){
            cached.deduction=ded;
          } else {
            _hrmsAdvCache[mk][emp.empCode]={empCode:emp.empCode,advance:0,emi:0,deduction:ded,id:null};
          }
          updated++;
        }
        hideSpinner();
        _hrmsRenderAdvances();
        notify('Deductions loaded: '+updated+' employees. Click "Save Deductions" to save.',false);
      }catch(ex){hideSpinner();notify('Import error: '+ex.message,true);}
    };
    reader.readAsArrayBuffer(file);
  }catch(ex){hideSpinner();notify(ex.message,true);}
}

// ═══ ON ROLL SALARY CALCULATION ══════════════════════════════════════════
// ═══ RENDER SALARY FROM SAVED DATA (locked months) ══════════════════════
function _hrmsRenderSavedSalary(yr,mo,catFilter){
  var mk=yr+'-'+String(mo).padStart(2,'0');
  var saved=_hrmsSavedMonth[mk];if(!saved)return;
  var isAll=catFilter==='all';
  var isWorker=catFilter==='worker';
  var gridId=isAll?'hrmsSalGrid':(isWorker?'hrmsWorkerSalGrid':'hrmsStaffSalGrid');
  var exportBtnId=isAll?'hrmsSalExportBtn':(isWorker?'hrmsWorkerSalExportBtn':'hrmsStaffSalExportBtn');
  var grid=document.getElementById(gridId);if(!grid)return;

  // Build sorted employee list from saved data
  var emps=[];
  Object.keys(saved.employees).forEach(function(ec){
    var d=saved.employees[ec];
    var et=(d.employmentType||'').toLowerCase().replace(/\s/g,'');
    if(et!=='onroll') return;
    var cat=(d.category||'').toLowerCase();
    if(isAll||(isWorker&&cat==='worker')||(!isAll&&!isWorker&&cat==='staff'))
      emps.push({empCode:ec,d:d});
  });
  emps.sort(function(a,b){
    var catA=(a.d.category||'').toLowerCase()==='worker'?0:1;
    var catB=(b.d.category||'').toLowerCase()==='worker'?0:1;
    if(catA!==catB)return catA-catB;
    var p=(a.d.location||'').localeCompare(b.d.location||'');if(p!==0)return p;
    return(parseInt(a.empCode)||0)-(parseInt(b.empCode)||0);
  });

  // Match Contract Salary table density (5px 4px th / 4px 5px td)
  var _th='padding:5px 4px;font-size:12px;font-weight:800;white-space:nowrap;border:1px solid #cbd5e1;color:#1e293b;text-align:center';
  var h='<table style="border-collapse:collapse;font-size:13px;white-space:nowrap">';
  h+='<thead style="position:sticky;top:0;z-index:2"><tr style="background:#f1f5f9;color:#1e293b">';
  var _thF=_th+';position:sticky;z-index:3;background:#f1f5f9';
  h+='<th style="'+_thF+';left:0;min-width:22px" rowspan="2">#</th><th style="'+_thF+';left:22px;min-width:40px" rowspan="2">Code</th><th style="'+_thF+';left:62px;min-width:120px;text-align:left" rowspan="2">Name</th><th style="'+_thF+';left:182px;min-width:24px" rowspan="2">Plt</th><th style="'+_th+'" rowspan="2">Sal/D</th><th style="'+_th+'" rowspan="2">Sal/M</th>';
  h+='<th style="'+_th+';background:#f3e8ff" colspan="3">Paid Leaves</th>';
  h+='<th style="'+_th+';background:#dbeafe" colspan="5">Attendance</th>';
  h+='<th style="'+_th+';background:#fff7ed" colspan="3">Eff OT</th>';
  h+='<th style="'+_th+';background:#dcfce7" colspan="8">Salary</th>';
  h+='<th style="'+_th+';background:#fef2f2" colspan="5">Advance</th>';
  h+='<th style="'+_th+';background:#f1f5f9" colspan="7">Deductions</th>';
  h+='<th style="'+_th+';background:#dcfce7" rowspan="2">Net</th>';
  h+='</tr><tr style="background:#f8fafc;color:#1e293b">';
  ['OB','Gvn','CB'].forEach(function(c){h+='<th style="'+_th+';background:#f3e8ff">'+c+'</th>';});
  ['P','A','OT','OTS','PL'].forEach(function(c){h+='<th style="'+_th+';background:#dbeafe">'+c+'</th>';});
  ['@1','@1.5','@2'].forEach(function(c){h+='<th style="'+_th+';background:#fff7ed">'+c+'</th>';});
  ['P','AB','PL','OT1','OT1.5','OT2','All','Grs'].forEach(function(c){h+='<th style="'+_th+';background:#dcfce7">'+c+'</th>';});
  ['OB','Mth','Tot','Ded','CB'].forEach(function(c){h+='<th style="'+_th+';background:#fef2f2">'+c+'</th>';});
  ['PT','PF','ESI','Adv','TDS','Oth','Tot'].forEach(function(c){h+='<th style="'+_th+';background:#f1f5f9">'+c+'</th>';});
  h+='</tr></thead><tbody>';

  var totals={salP:0,salAb:0,salPL:0,salOT1:0,salOT15:0,salOT2:0,allow:0,gross:0,advOB:0,advMonth:0,advTotal:0,advDed:0,advCB:0,dedPT:0,dedPF:0,dedESI:0,dedAdv:0,dedTDS:0,dedOther:0,dedTotal:0,net:0};
  if(!window._hrmsSalDetails) window._hrmsSalDetails={};

  emps.forEach(function(item,ei){
    var ec=item.empCode,d=item.d;
    var _r=Math.round;
    var advTotal=(d.advOB||0)+(d.advMonth||0);
    // Accumulate totals
    totals.salP+=d.salForP||0;totals.salAb+=d.salAb||0;totals.salPL+=d.salForPL||0;
    totals.salOT1+=d.salOT1||0;totals.salOT15+=d.salOT15||0;totals.salOT2+=d.salOT2||0;
    totals.allow+=d.allowance||0;totals.gross+=d.gross||0;
    totals.advOB+=d.advOB||0;totals.advMonth+=d.advMonth||0;totals.advTotal+=advTotal;totals.advDed+=d.advDed||0;totals.advCB+=d.advCB||0;
    totals.dedPT+=d.dedPT||0;totals.dedPF+=d.dedPF||0;totals.dedESI+=d.dedESI||0;
    totals.dedAdv+=d.dedAdv||0;totals.dedTDS+=d.dedTDS||0;totals.dedOther+=d.dedOther||0;totals.dedTotal+=d.dedTotal||0;totals.net+=d.net||0;

    // Store for detail click + payments
    window._hrmsSalDetails[ec]=d;

    var pClr=_hrmsGetPlantColor(d.location||'');
    var plt=(d.location||'').replace(/plant[\s\-]*/i,'P').replace(/^(.{4}).*$/,'$1');
    // Match Contract Salary table row density
    var _td='padding:4px 5px;border:1px solid #e2e8f0;';
    var _tdr=_td+'text-align:right;font-family:var(--mono);';
    var _tdF=_td+'position:sticky;z-index:1;background:#fff;';

    h+='<tr style="border-bottom:1px solid #e2e8f0;cursor:pointer" onclick="_hrmsSalShowDetail(\''+ec+'\')" onmouseover="this.style.background=\'#f0f9ff\'" onmouseout="this.style.background=\'\'">';
    h+='<td style="'+_tdF+'left:0;text-align:center">'+(ei+1)+'</td>';
    h+='<td style="'+_tdF+'left:22px;font-weight:800;color:var(--accent);font-size:12px;cursor:pointer;text-decoration:underline" data-emp-code="'+ec+'" title="Click to view employee">'+ec+'</td>';
    h+='<td style="'+_tdF+'left:62px;font-weight:700;font-size:12px;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis">'+d.name+'</td>';
    h+='<td style="'+_tdF+'left:182px"><span style="background:'+pClr+';padding:1px 2px;border-radius:3px;font-size:9px;font-weight:700">'+plt+'</span></td>';
    h+='<td style="'+_tdr+'">'+_r(d.rateD||0)+'</td><td style="'+_tdr+'">'+_r(d.rateM||0)+'</td>';
    h+='<td style="'+_tdr+'background:#faf5ff">'+(d.plOB||0)+'</td><td style="'+_tdr+'background:#faf5ff">'+(d.plGiven||0)+'</td><td style="'+_tdr+'background:#faf5ff">'+(d.plCB||0)+'</td>';
    h+='<td style="'+_tdr+'background:#eff6ff">'+(d.totalP||0)+'</td><td style="'+_tdr+'background:#eff6ff;color:#dc2626">'+(d.totalA||0)+'</td><td style="'+_tdr+'background:#eff6ff">'+_hrmsFmtOT(d.totalOT)+'</td><td style="'+_tdr+'background:#eff6ff">'+_hrmsFmtOT(d.totalOTS)+'</td><td style="'+_tdr+'background:#eff6ff">'+(d.totalPL||0)+'</td>';
    h+='<td style="'+_tdr+'background:#fff7ed">'+_hrmsFmtOT(d.otAt1)+'</td><td style="'+_tdr+'background:#fff7ed">'+_hrmsFmtOT(d.otAt15)+'</td><td style="'+_tdr+'background:#fff7ed">'+_hrmsFmtOT(d.otAt2)+'</td>';
    h+='<td style="'+_tdr+'background:#f0fdf4;font-weight:700">'+_r(d.salForP||0)+'</td><td style="'+_tdr+'background:#f0fdf4">'+_r(d.salAb||0)+'</td><td style="'+_tdr+'background:#f0fdf4">'+_r(d.salForPL||0)+'</td>';
    h+='<td style="'+_tdr+'background:#f0fdf4">'+_r(d.salOT1||0)+'</td><td style="'+_tdr+'background:#f0fdf4">'+_r(d.salOT15||0)+'</td><td style="'+_tdr+'background:#f0fdf4">'+_r(d.salOT2||0)+'</td>';
    h+='<td style="'+_tdr+'background:#f0fdf4">'+_r(d.allowance||0)+'</td><td style="'+_tdr+'background:#dcfce7;font-weight:900;color:#15803d">'+_r(d.gross||0)+'</td>';
    h+='<td style="'+_tdr+'background:#fef2f2">'+_r(d.advOB||0)+'</td><td style="'+_tdr+'background:#fef2f2">'+_r(d.advMonth||0)+'</td><td style="'+_tdr+'background:#fef2f2">'+_r(advTotal)+'</td><td style="'+_tdr+'background:#fef2f2">'+_r(d.advDed||0)+'</td><td style="'+_tdr+'background:#fef2f2">'+_r(d.advCB||0)+'</td>';
    h+='<td style="'+_tdr+'background:#f1f5f9">'+_r(d.dedPT||0)+'</td><td style="'+_tdr+'background:#f1f5f9">'+_r(d.dedPF||0)+'</td><td style="'+_tdr+'background:#f1f5f9">'+_r(d.dedESI||0)+'</td><td style="'+_tdr+'background:#f1f5f9">'+_r(d.dedAdv||0)+'</td><td style="'+_tdr+'background:#f1f5f9">'+_r(d.dedTDS||0)+'</td><td style="'+_tdr+'background:#f1f5f9">'+_r(d.dedOther||0)+'</td><td style="'+_tdr+'background:#f1f5f9;font-weight:700">'+_r(d.dedTotal||0)+'</td>';
    h+='<td style="'+_tdr+'background:#dcfce7;font-weight:900;font-size:14px;color:#15803d">'+_r(d.net||0)+'</td>';
    h+='</tr>';
  });
  // Totals row — sticky at bottom via tfoot
  var _r2=function(v){return Math.round(v).toLocaleString();};
  var _stk='position:sticky;bottom:0;z-index:1;background:#e2e8f0';
  var _tf='padding:2px 3px;text-align:right;font-family:var(--mono);border:1px solid #cbd5e1;color:#1e293b;'+_stk;
  var _tfE='border:1px solid #cbd5e1;'+_stk;
  h+='</tbody><tfoot><tr style="font-weight:900"><td colspan="4" style="padding:4px 6px;border:1px solid #cbd5e1;left:0;z-index:2;'+_stk+'">Total ('+emps.length+')</td><td style="'+_tfE+'"></td><td style="'+_tfE+'"></td>';
  h+='<td colspan="3" style="'+_tfE+'"></td><td colspan="5" style="'+_tfE+'"></td><td colspan="3" style="'+_tfE+'"></td>';
  h+='<td style="'+_tf+'">'+_r2(totals.salP)+'</td><td style="'+_tf+'">'+_r2(totals.salAb)+'</td><td style="'+_tf+'">'+_r2(totals.salPL)+'</td>';
  h+='<td style="'+_tf+'">'+_r2(totals.salOT1)+'</td><td style="'+_tf+'">'+_r2(totals.salOT15)+'</td><td style="'+_tf+'">'+_r2(totals.salOT2)+'</td>';
  h+='<td style="'+_tf+'">'+_r2(totals.allow)+'</td><td style="'+_tf+';font-weight:900;color:#15803d">'+_r2(totals.gross)+'</td>';
  h+='<td style="'+_tf+'">'+_r2(totals.advOB)+'</td><td style="'+_tf+'">'+_r2(totals.advMonth)+'</td><td style="'+_tf+'">'+_r2(totals.advTotal)+'</td><td style="'+_tf+'">'+_r2(totals.advDed)+'</td><td style="'+_tf+'">'+_r2(totals.advCB)+'</td>';
  h+='<td style="'+_tf+'">'+_r2(totals.dedPT)+'</td><td style="'+_tf+'">'+_r2(totals.dedPF)+'</td><td style="'+_tf+'">'+_r2(totals.dedESI)+'</td><td style="'+_tf+'">'+_r2(totals.dedAdv)+'</td><td style="'+_tf+'">'+_r2(totals.dedTDS)+'</td><td style="'+_tf+'">'+_r2(totals.dedOther)+'</td><td style="'+_tf+'">'+_r2(totals.dedTotal)+'</td>';
  h+='<td style="'+_tf+';font-weight:900;color:#15803d;font-size:14px">'+_r2(totals.net)+'</td></tr></tfoot>';
  h+='</table>';
  grid.innerHTML=emps.length?h:'<div class="empty-state">No saved salary data for this filter</div>';
  var expBtn=document.getElementById(exportBtnId);
  if(expBtn) expBtn.style.display=emps.length?'':'none';
  // Mirror the live-render path: show the Worker's Salary Slip button when
  // any worker row is visible and the user has export-worker-slip perm.
  if(isAll){
    var _slipBtn=document.getElementById('hrmsWorkerSlipBtn');
    if(_slipBtn){
      var _hasWorker=emps.some(function(it){return((it&&it.category)||(it&&it.d&&it.d.category)||'').toLowerCase()==='worker';});
      var _canSlip=(typeof _hrmsHasAccess!=='function')||_hrmsHasAccess('action.exportWorkerSlip');
      _slipBtn.style.display=(_hasWorker&&_canSlip)?'':'none';
    }
  }
}

async function _hrmsRenderOrSalary(yr,mo,catFilter){
  var _mk=yr+'-'+String(mo).padStart(2,'0');
  // ── LOCKED MONTH: render from saved data (no master dependency) ──
  if(_hrmsIsMonthLocked(_mk)&&_hrmsHasSavedData(_mk)){
    _hrmsRenderSavedSalary(yr,mo,catFilter);
    return;
  }
  // Load all prerequisites before calculating
  _hrmsLoadStatutory();
  var _otR=_hrmsGetOtRules(_mk);
  await _hrmsAttFetchMonth(_mk);
  _hrmsLoadManualP();
  // Compute attendance totals for all employees
  _hrmsComputeAttTotals(yr,mo);
  // Ensure advances data is loaded for this month
  await _hrmsLoadAdvances(_mk);
  await _hrmsLoadAdvances(_hrmsPrevMonth(_mk));
  var isAll=catFilter==='all';
  var isWorker=catFilter==='worker';
  var gridId=isAll?'hrmsSalGrid':(isWorker?'hrmsWorkerSalGrid':'hrmsStaffSalGrid');
  var exportBtnId=isAll?'hrmsSalExportBtn':(isWorker?'hrmsWorkerSalExportBtn':'hrmsStaffSalExportBtn');
  var grid=document.getElementById(gridId);if(!grid)return;
  var mk=yr+'-'+String(mo).padStart(2,'0');
  var daysInMonth=new Date(yr,mo,0).getDate();
  var attRecords=_hrmsAttCache[mk]||[];
  var altRecords=_hrmsAltCache[mk]||[];
  var lookup={};attRecords.forEach(function(a){lookup[a.empCode]=a.days||{};});
  var altLookup={};altRecords.forEach(function(a){altLookup[a.empCode]=a.days||{};});
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});

  // Filter: All active On Roll employees
  var _getPLoc=function(e){var periods=e.periods||[];for(var i=0;i<periods.length;i++){if(!periods[i].to&&!periods[i]._wfStatus)return periods[i].location||e.location||'';}return e.location||'';};
  // Month boundaries for DOJ/DOL gating
  var _salMonthStart=mk+'-01';// "2026-01-01"
  var _salMonthEnd=mk+'-'+String(daysInMonth).padStart(2,'0');// "2026-01-31"
  var emps=(DB.hrmsEmployees||[]).filter(function(e){
    var et=(e.employmentType||'').toLowerCase().replace(/\s/g,'');
    var cat=(e.category||'').toLowerCase();
    if(et!=='onroll'||(e.status||'Active')!=='Active') return false;
    // Also check the active period — flat status can lag when only the
    // period was edited (e.g. Resigned via period dropdown).
    var _ap=(e.periods||[]).find(function(p){return !p.to&&(!p._wfStatus||p._wfStatus==='approved');});
    if(_ap&&(_ap.status||'Active')!=='Active') return false;
    // Gate by Date of Joining: exclude employees whose DOJ is AFTER the end of this salary month
    if(e.dateOfJoining&&e.dateOfJoining>_salMonthEnd) return false;
    // Gate by Date of Left: exclude employees who left BEFORE the start of this salary month
    if(e.dateOfLeft&&e.dateOfLeft<_salMonthStart) return false;
    if(isAll) return true;
    return isWorker?cat==='worker':cat==='staff';
  }).sort(function(a,b){
    // Workers first, then Staff. Within each: plant, then emp code
    var catA=(a.category||'').toLowerCase()==='worker'?0:1;
    var catB=(b.category||'').toLowerCase()==='worker'?0:1;
    if(catA!==catB) return catA-catB;
    var p=_getPLoc(a).localeCompare(_getPLoc(b));if(p!==0)return p;
    return (parseInt(a.empCode)||0)-(parseInt(b.empCode)||0);
  });

  var FULL_DAY=_otR.fullDay,HALF_DAY=_otR.halfDay,EL_MIN=_otR.elMin,EL_MAX=_otR.elMaxPerMonth;
  var _salBalances=[];// collect {empCode,plOB,plCB,advOB,advCB} for saving
  // Match Contract Salary table density (5px 4px th / 4px 5px td)
  var _th='padding:5px 4px;font-size:12px;font-weight:800;white-space:nowrap;border:1px solid #cbd5e1;color:#1e293b;text-align:center';
  var h='<table style="border-collapse:collapse;font-size:13px;white-space:nowrap">';
  // Header row 1 — grouped
  h+='<thead style="position:sticky;top:0;z-index:2"><tr style="background:#f1f5f9;color:#1e293b">';
  var _thF=_th+';position:sticky;z-index:3;background:#f1f5f9';
  h+='<th style="'+_thF+';left:0;min-width:22px" rowspan="2">#</th><th style="'+_thF+';left:22px;min-width:40px" rowspan="2">Code</th><th style="'+_thF+';left:62px;min-width:120px;text-align:left" rowspan="2">Name</th><th style="'+_thF+';left:182px;min-width:24px" rowspan="2">Plt</th><th style="'+_th+'" rowspan="2">Sal/D</th><th style="'+_th+'" rowspan="2">Sal/M</th>';
  h+='<th style="'+_th+';background:#f3e8ff" colspan="3">Paid Leaves</th>';
  h+='<th style="'+_th+';background:#dbeafe" colspan="5">Attendance</th>';
  h+='<th style="'+_th+';background:#fff7ed" colspan="3">Eff OT</th>';
  h+='<th style="'+_th+';background:#dcfce7" colspan="8">Salary</th>';
  h+='<th style="'+_th+';background:#fef2f2" colspan="5">Advance</th>';
  h+='<th style="'+_th+';background:#f1f5f9" colspan="7">Deductions</th>';
  h+='<th style="'+_th+';background:#dcfce7" rowspan="2">Net</th>';
  h+='</tr>';
  // Header row 2 — sub-columns
  h+='<tr style="background:#f8fafc;color:#1e293b">';
  ['OB','Gvn','CB'].forEach(function(c){h+='<th style="'+_th+';background:#f3e8ff">'+c+'</th>';});
  ['P','A','OT','OTS','PL'].forEach(function(c){h+='<th style="'+_th+';background:#dbeafe">'+c+'</th>';});
  ['@1','@1.5','@2'].forEach(function(c){h+='<th style="'+_th+';background:#fff7ed">'+c+'</th>';});
  ['P','AB','PL','OT1','OT1.5','OT2','All','Grs'].forEach(function(c){h+='<th style="'+_th+';background:#dcfce7">'+c+'</th>';});
  ['OB','Mth','Tot','Ded','CB'].forEach(function(c){h+='<th style="'+_th+';background:#fef2f2">'+c+'</th>';});
  ['PT','PF','ESI','Adv','TDS','Oth','Tot'].forEach(function(c){h+='<th style="'+_th+';background:#f1f5f9">'+c+'</th>';});
  h+='</tr></thead><tbody>';

  var totals={salP:0,salAb:0,salPL:0,salOT1:0,salOT15:0,salOT2:0,allow:0,gross:0,advOB:0,advMonth:0,advTotal:0,advDed:0,advCB:0,dedPT:0,dedPF:0,dedESI:0,dedAdv:0,dedTDS:0,dedOther:0,dedTotal:0,net:0};

  // Find the active period for a given month
  var _getPeriod=function(emp,mk){
    var periods=(emp.periods||[]).slice().sort(function(a,b){return(b.from||'').localeCompare(a.from||'');});
    for(var i=0;i<periods.length;i++){
      var p=periods[i];
      if((p.from||'')<=mk&&(!p.to||p.to>=mk)) return p;
    }
    return periods[0]||{};// fallback to latest
  };

  emps.forEach(function(emp,ei){
    var empAtt=lookup[emp.empCode]||{};
    var empAlt=altLookup[emp.empCode]||{};
    var period=_getPeriod(emp,mk);
    var isStaff=(period.category||(emp.category||'')).toLowerCase()==='staff';
    var rateD=period.salaryDay||emp.salaryDay||0,rateM=period.salaryMonth||emp.salaryMonth||0,spAllow=period.specialAllowance||emp.specialAllowance||0;
    var _ob=_hrmsGetEmpOB(emp,mk);
    var plOB=emp.noPL?0:(mo===4?0:_ob.plOB);// April: PL OB resets to 0
    var _confMo=_hrmsMonthsSinceConfirmation(emp,yr,mo);
    // FY month number: Apr=1, May=2, ... Jan=10, Feb=11, Mar=12
    var _fyMonthNo=mo>=4?mo-3:mo+9;
    var s=_hrmsStatutory;
    var seniorThreshold=s.plSeniorMonths||60;
    var plAvailTill;
    if(isStaff&&_confMo>=seniorThreshold){
      plAvailTill=s.plStaffSenior||18;
    } else if(_confMo>=0){
      var rate=isStaff?(s.plStaffJunior||1.5):(s.plWorker||1.5);
      var _eligMonths=Math.min(_fyMonthNo,_confMo);
      plAvailTill=_eligMonths*rate;
    } else {
      plAvailTill=0;
    }
    if(emp.noPL) plAvailTill=0;
    // Count WD and PH from calendar
    var phCount=0,wdCount=0;
    var _pLoc=period.location||emp.location;
    for(var dd=1;dd<=daysInMonth;dd++){
      var dType=_hrmsGetDayType(mk,dd,yr,mo,_pLoc);
      if(dType==='PH') phCount++;
      if(dType!=='WO'&&dType!=='PH') wdCount++;
    }
    // Use attendance tab's pre-computed values (emp._totalP, _totalOT, _totalOTS)
    var totalP=emp._totalP||0;
    var totalOT=emp._totalOT||0;
    var totalOTS=emp._totalOTS||0;
    // Manual overrides
    var _mpData=(_hrmsManualPData[mk]||{});
    if(_mpData[emp.empCode]!==undefined) totalP=_mpData[emp.empCode];
    if(emp.extra&&emp.extra.manualOT&&emp.extra.manualOT[mk]!==undefined) totalOT=emp.extra.manualOT[mk];
    if(emp.extra&&emp.extra.manualOTS&&emp.extra.manualOTS[mk]!==undefined) totalOTS=emp.extra.manualOTS[mk];
    // Absent = Working Days - Present Days (PL/EL not included in present)
    totalA=Math.max(wdCount-totalP,0);
    // PL Given: skip if noPL flag set, check manual override, then auto-calc
    var _manualPL=emp.extra&&emp.extra.manualPL&&emp.extra.manualPL[mk];
    var plRemain=Math.max(plAvailTill-plOB,0);// PLs available beyond OB
    var plGiven;
    if(emp.noPL){
      plGiven=0;
    } else if(_manualPL!==undefined){
      plGiven=_manualPL;
    } else if(totalP<=0){
      plGiven=0;// no PL if absent entire month
    } else if(mo===3){
      // March: Workers get all available PL, Staff get max 5
      plGiven=isStaff?Math.min(plRemain,5):plRemain;
    } else {
      plGiven=Math.min(totalA,plRemain);// normal: PL up to absent days
    }
    var paidAbsent=totalA-plGiven;// absent days after PL (for salary deduction)
    var totalPL=plGiven+(totalP>0?phCount:0);// PL given + PH (if present at least 1 day)
    var plCB=plOB+plGiven;
    // Effective OT split — Workers only, no OT for Staff
    // IOT uses raw totalA (before PL reduction)
    var otAt1=0,otAt15=0,otAt2=0;
    if(!isStaff){
      // Ineligible OT (IOT): if absent > threshold days, IOT hrs = (A - threshold) * hrsPerDay
      var iot=totalA>_otR.iotAbsentThreshold?(totalA-_otR.iotAbsentThreshold)*_otR.iotHoursPerDay:0;
      // IOT deducted first from OTS, then from OT; IOT itself goes to @1 rate
      var remIOT=iot;
      var otsAfter=totalOTS;
      var otAfter=totalOT;
      if(remIOT>0){
        var fromOTS=Math.min(remIOT,otsAfter);
        otsAfter-=fromOTS;remIOT-=fromOTS;
      }
      if(remIOT>0){
        var fromOT=Math.min(remIOT,otAfter);
        otAfter-=fromOT;remIOT-=fromOT;
      }
      otAt1=iot-remIOT;// actual IOT hrs deducted (at @1 rate)
      otAt15=otAfter;// remaining OT → @1.5
      otAt2=otsAfter;// remaining OTS → @2
    }
    // Salary bifurcation
    var hourlyRate=rateD/8;
    var staffDayRate=isStaff&&(wdCount+phCount)>0?rateM/(wdCount+phCount):0;
    var salForP=Math.round(isStaff?staffDayRate*totalP:(totalP*rateD));
    var salAb=isStaff?0:(totalA<=0?200:totalA<=1?100:0);// Workers: 0A→200, 1A→100, >1A→0
    var salForPL=Math.round(isStaff?staffDayRate*totalPL:(totalPL*rateD));
    var salOT1=Math.round(otAt1*hourlyRate);
    var salOT15=Math.round(otAt15*hourlyRate*1.5);
    var salOT2=Math.round(otAt2*hourlyRate*2);
    var allowance=Math.round(_hrmsCalcTA(spAllow, wdCount, totalP));
    var gross=salForP+salAb+salForPL+salOT1+salOT15+salOT2+allowance;
    // Advance
    var advOB=_hrmsGetAdvOB(emp,mk);
    var _advRec=(DB.hrmsAdvances||[]).find(function(a){return a.empCode===emp.empCode&&a.monthKey===mk;});
    var advMonth=Math.round((_advRec&&_advRec.advance)||0);
    var advDed=Math.round((_advRec&&_advRec.deduction)||0);
    var advTotal=advOB+advMonth;
    var advCB=advTotal-advDed;
    // Deductions — from statutory settings
    var dedPT=0,dedPF=0,dedESI=0,dedAdv=advDed,dedTDS=mo===4?0:Math.round(_hrmsGetTdsForMonth(emp,mk)),dedOther=0;
    // PF: BV based on gross. GS>19000→BV=15000, GS<15000→BV=GS, 15000-19000→BV=15000/(WD+PH)*(P+totalPL)
    var pfBV=0;
    if(gross>19000) pfBV=15000;
    else if(gross<15000) pfBV=gross;
    else pfBV=(wdCount+phCount)>0?15000/(wdCount+phCount)*(totalP+totalPL):0;
    dedPF=Math.round(pfBV*_hrmsStatutory.pfWorker/100);
    // ESI: applied only if period.esiApplicable is not "No". Default to Yes for Worker, No for Staff.
    var _esiApp=period.esiApplicable||(isStaff?'No':'Yes');
    if(_esiApp==='Yes') dedESI=Math.ceil(gross*_hrmsStatutory.esiWorker/100);
    var _moNames=['','jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    dedPT=_hrmsCalcPT(gross,emp.gender,_moNames[mo]);
    dedPT=Math.round(dedPT);dedPF=Math.round(dedPF);dedESI=Math.round(dedESI);
    var dedTotal=dedPT+dedPF+dedESI+dedAdv+dedTDS+dedOther;
    var net=gross-dedTotal;
    // Store balances for saving
    _salBalances.push({empCode:emp.empCode,plOB:plOB,plGiven:plGiven,plCB:plCB,advOB:advOB,advMonth:advMonth,advDed:advDed,advCB:advCB});
    // Round
    var _r=function(v){return Math.round(v);};
    // Accumulate totals
    totals.salP+=salForP;totals.salAb+=salAb;totals.salPL+=salForPL;totals.salOT1+=salOT1;totals.salOT15+=salOT15;totals.salOT2+=salOT2;totals.allow+=allowance;totals.gross+=gross;
    totals.advOB+=advOB;totals.advMonth+=advMonth;totals.advTotal+=advTotal;totals.advDed+=advDed;totals.advCB+=advCB;
    totals.dedPT+=dedPT;totals.dedPF+=dedPF;totals.dedESI+=dedESI;totals.dedAdv+=dedAdv;totals.dedTDS+=dedTDS;totals.dedOther+=dedOther;totals.dedTotal+=dedTotal;totals.net+=net;

    var _empLoc=period.location||emp.location;
    var pClr=_hrmsGetPlantColor(_empLoc);
    // Match Contract Salary table row density
    var _td='padding:4px 5px;border:1px solid #e2e8f0;';
    var _tdr=_td+'text-align:right;font-family:var(--mono);';
    // Store detail data for click
    var _det={empCode:emp.empCode,name:_hrmsDispName(emp),location:_empLoc,category:period.category||emp.category,doj:emp.dateOfJoining,gender:emp.gender,rateD:rateD,rateM:rateM,spAllow:spAllow,plOB:plOB,plGiven:plGiven,plCB:plCB,plAvail:plAvailTill,confMonths:_confMo,fyMonthNo:_fyMonthNo,wdCount:wdCount,phCount:phCount,totalP:totalP,totalA:totalA,paidAbsent:paidAbsent,totalOT:totalOT,totalOTS:totalOTS,otAt1:otAt1,otAt15:otAt15,otAt2:otAt2,salForP:salForP,salAb:salAb,salForPL:salForPL,salOT1:salOT1,salOT15:salOT15,salOT2:salOT2,allowance:allowance,gross:gross,dedPT:dedPT,dedPF:dedPF,dedESI:dedESI,dedAdv:dedAdv,dedTDS:dedTDS,dedOther:dedOther,dedTotal:dedTotal,net:net,totalPL:totalPL,advOB:advOB,advCB:advCB,iot:(!isStaff&&totalA>_otR.iotAbsentThreshold?(totalA-_otR.iotAbsentThreshold)*_otR.iotHoursPerDay:0)};
    if(!window._hrmsSalDetails) window._hrmsSalDetails={};
    window._hrmsSalDetails[emp.empCode]=_det;
    h+='<tr style="border-bottom:1px solid #e2e8f0;cursor:pointer" onclick="_hrmsSalShowDetail(\''+emp.empCode+'\')" onmouseover="this.style.background=\'#f0f9ff\'" onmouseout="this.style.background=\'\'">';
    var plt=(_empLoc||'').replace(/plant[\s\-]*/i,'P').replace(/^(.{4}).*$/,'$1');
    var _tdF=_td+'position:sticky;z-index:1;background:#fff;';
    h+='<td style="'+_tdF+'left:0;text-align:center">'+(ei+1)+'</td>';
    h+='<td style="'+_tdF+'left:22px;font-weight:800;color:var(--accent);font-size:12px;cursor:pointer;text-decoration:underline" data-emp-code="'+emp.empCode+'" title="Click to view employee">'+emp.empCode+'</td>';
    h+='<td style="'+_tdF+'left:62px;font-weight:700;font-size:12px;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis">'+_hrmsDispName(emp)+'</td>';
    h+='<td style="'+_tdF+'left:182px"><span style="background:'+pClr+';padding:1px 2px;border-radius:3px;font-size:9px;font-weight:700">'+plt+'</span></td>';
    h+='<td style="'+_tdr+'">'+_r(rateD)+'</td>';
    h+='<td style="'+_tdr+'">'+_r(rateM)+'</td>';
    // PL
    h+='<td style="'+_tdr+'background:#faf5ff">'+plOB+'</td><td style="'+_tdr+'background:#faf5ff">'+plGiven+'</td><td style="'+_tdr+'background:#faf5ff">'+plCB+'</td>';
    // Attendance
    h+='<td style="'+_tdr+'background:#eff6ff">'+totalP+'</td><td style="'+_tdr+'background:#eff6ff;color:#dc2626">'+totalA+'</td><td style="'+_tdr+'background:#eff6ff">'+_hrmsFmtOT(totalOT)+'</td><td style="'+_tdr+'background:#eff6ff">'+_hrmsFmtOT(totalOTS)+'</td><td style="'+_tdr+'background:#eff6ff">'+totalPL+'</td>';
    // Effective OT
    h+='<td style="'+_tdr+'background:#fff7ed">'+_hrmsFmtOT(otAt1)+'</td><td style="'+_tdr+'background:#fff7ed">'+_hrmsFmtOT(otAt15)+'</td><td style="'+_tdr+'background:#fff7ed">'+_hrmsFmtOT(otAt2)+'</td>';
    // Salary bifurcation
    h+='<td style="'+_tdr+'background:#f0fdf4;font-weight:700">'+_r(salForP)+'</td><td style="'+_tdr+'background:#f0fdf4">'+_r(salAb)+'</td><td style="'+_tdr+'background:#f0fdf4">'+_r(salForPL)+'</td>';
    h+='<td style="'+_tdr+'background:#f0fdf4">'+_r(salOT1)+'</td><td style="'+_tdr+'background:#f0fdf4">'+_r(salOT15)+'</td><td style="'+_tdr+'background:#f0fdf4">'+_r(salOT2)+'</td>';
    h+='<td style="'+_tdr+'background:#f0fdf4">'+_r(allowance)+'</td><td style="'+_tdr+'background:#dcfce7;font-weight:900;color:#15803d">'+_r(gross)+'</td>';
    // Advance
    h+='<td style="'+_tdr+'background:#fef2f2">'+_r(advOB)+'</td><td style="'+_tdr+'background:#fef2f2">'+_r(advMonth)+'</td><td style="'+_tdr+'background:#fef2f2">'+_r(advTotal)+'</td><td style="'+_tdr+'background:#fef2f2">'+_r(advDed)+'</td><td style="'+_tdr+'background:#fef2f2">'+_r(advCB)+'</td>';
    // Deductions
    h+='<td style="'+_tdr+'background:#f1f5f9">'+_r(dedPT)+'</td><td style="'+_tdr+'background:#f1f5f9">'+_r(dedPF)+'</td><td style="'+_tdr+'background:#f1f5f9">'+_r(dedESI)+'</td><td style="'+_tdr+'background:#f1f5f9">'+_r(dedAdv)+'</td><td style="'+_tdr+'background:#f1f5f9">'+_r(dedTDS)+'</td><td style="'+_tdr+'background:#f1f5f9">'+_r(dedOther)+'</td><td style="'+_tdr+'background:#f1f5f9;font-weight:700">'+_r(dedTotal)+'</td>';
    // Net
    h+='<td style="'+_tdr+'background:#dcfce7;font-weight:900;font-size:14px;color:#15803d">'+_r(net)+'</td>';
    h+='</tr>';
  });
  // Totals row — sticky at bottom via tfoot
  var _r2=function(v){return Math.round(v).toLocaleString();};
  var _stk='position:sticky;bottom:0;z-index:1;background:#e2e8f0';
  var _tf='padding:2px 3px;text-align:right;font-family:var(--mono);border:1px solid #cbd5e1;color:#1e293b;'+_stk;
  var _tfE='border:1px solid #cbd5e1;'+_stk;
  h+='</tbody><tfoot><tr style="font-weight:900"><td colspan="4" style="padding:4px 6px;border:1px solid #cbd5e1;left:0;z-index:2;'+_stk+'">Total ('+emps.length+')</td><td style="'+_tfE+'"></td><td style="'+_tfE+'"></td>';
  h+='<td colspan="3" style="'+_tfE+'"></td>';
  h+='<td colspan="5" style="'+_tfE+'"></td>';
  h+='<td colspan="3" style="'+_tfE+'"></td>';
  h+='<td style="'+_tf+'">'+_r2(totals.salP)+'</td><td style="'+_tf+'">'+_r2(totals.salAb)+'</td><td style="'+_tf+'">'+_r2(totals.salPL)+'</td>';
  h+='<td style="'+_tf+'">'+_r2(totals.salOT1)+'</td><td style="'+_tf+'">'+_r2(totals.salOT15)+'</td><td style="'+_tf+'">'+_r2(totals.salOT2)+'</td>';
  h+='<td style="'+_tf+'">'+_r2(totals.allow)+'</td><td style="'+_tf+';font-weight:900;color:#15803d">'+_r2(totals.gross)+'</td>';
  h+='<td style="'+_tf+'">'+_r2(totals.advOB)+'</td><td style="'+_tf+'">'+_r2(totals.advMonth)+'</td><td style="'+_tf+'">'+_r2(totals.advTotal)+'</td><td style="'+_tf+'">'+_r2(totals.advDed)+'</td><td style="'+_tf+'">'+_r2(totals.advCB)+'</td>';
  h+='<td style="'+_tf+'">'+_r2(totals.dedPT)+'</td><td style="'+_tf+'">'+_r2(totals.dedPF)+'</td><td style="'+_tf+'">'+_r2(totals.dedESI)+'</td><td style="'+_tf+'">'+_r2(totals.dedAdv)+'</td><td style="'+_tf+'">'+_r2(totals.dedTDS)+'</td><td style="'+_tf+'">'+_r2(totals.dedOther)+'</td><td style="'+_tf+'">'+_r2(totals.dedTotal)+'</td>';
  h+='<td style="'+_tf+';font-weight:900;color:#15803d;font-size:14px">'+_r2(totals.net)+'</td></tr></tfoot>';
  h+='</table>';
  var emptyMsg=isWorker?'No Worker employees with attendance for this month':'No Staff employees with attendance for this month';
  grid.innerHTML=emps.length?h:'<div class="empty-state">'+emptyMsg+'</div>';
  var expBtn=document.getElementById(exportBtnId);
  if(expBtn) expBtn.style.display=emps.length?'':'none';
  // Worker's Salary Slip button — visible on the unified "all" grid when
  // at least one worker row exists AND the user has action.exportWorkerSlip.
  if(isAll){
    var _slipBtn=document.getElementById('hrmsWorkerSlipBtn');
    if(_slipBtn){
      var _hasWorker=emps.some(function(it){return(it.category||'').toLowerCase()==='worker';});
      var _canSlip=(typeof _hrmsHasAccess!=='function')||_hrmsHasAccess('action.exportWorkerSlip');
      _slipBtn.style.display=(_hasWorker&&_canSlip)?'':'none';
    }
  }
  // Auto-save balances in background
  var balKey=isAll?'_hrmsSalBal':(isWorker?'_hrmsWorkerBal':'_hrmsStaffBal');
  window[balKey]={mk:mk,balances:_salBalances};
  if(_salBalances.length){
    var empMap2={};(DB.hrmsEmployees||[]).forEach(function(e){empMap2[e.empCode]=e;});
    var toSave=[];
    if(!DB.hrmsAdvances) DB.hrmsAdvances=[];
    var advToSave=[];
    _salBalances.forEach(function(b){
      var emp=empMap2[b.empCode];if(!emp)return;
      if(!emp.extra) emp.extra={};
      if(!emp.extra.bal) emp.extra.bal={};
      // The authoritative CB is stored here — used by _hrmsGetAdvOB for the OB chain
      emp.extra.bal[mk]={plOB:b.plOB,plGiven:b.plGiven,plCB:b.plCB,advOB:b.advOB,advCB:b.advCB};
      toSave.push(emp);
      // Only save an advance record if there is actual activity this month
      // (advance taken, deduction applied, or EMI set). Zero-amount records
      // were previously created to maintain an OB chain, but that chain now
      // reads from emp.extra.bal[prevMk].advCB — so zero records are not needed.
      var advRec=DB.hrmsAdvances.find(function(a){return a.empCode===b.empCode&&a.monthKey===mk;});
      var hasActivity=(b.advMonth&&b.advMonth>0)||(b.advDed&&b.advDed>0);
      if(advRec){
        // Existing record: update only if we have a reason (non-zero values already exist)
        if(advRec.advance>0||advRec.deduction>0||advRec.emi>0||hasActivity) advToSave.push(advRec);
      } else if(hasActivity){
        advRec={id:'adv'+uid(),empCode:b.empCode,monthKey:mk,advance:b.advMonth||0,emi:0,deduction:b.advDed||0};
        DB.hrmsAdvances.push(advRec);
        advToSave.push(advRec);
      }
      // else: no existing record and no activity — skip (don't create a zero record)
    });
    _dbSaveBulk('hrmsEmployees',toSave).then(function(n){
      if(n) console.log('Auto-saved balances for '+n+' employees ('+mk+')');
    });
    if(advToSave.length){
      advToSave.forEach(function(r){_dbSave('hrmsAdvances',r);});
      _hrmsAdvCache={};
    }
  }
}
// ═══ SALARY COMPARE ══════════════════════════════════════════════════════
var _hrmsSalRefData=null;// reference file rows

async function _hrmsSalLoadRef(inputEl){
  if(!inputEl||!inputEl.files||!inputEl.files[0])return;
  var file=inputEl.files[0];inputEl.value='';
  showSpinner('Reading reference file…');
  try{
    var reader=new FileReader();
    reader.onload=async function(ev){
      try{
        var rows=await _parseXLSX(ev.target.result);
        if(!rows.length){hideSpinner();notify('No data in file',true);return;}
        _hrmsSalRefData=rows;
        hideSpinner();
        document.getElementById('hrmsSalRefLabel').innerHTML='📎 '+file.name+' ('+rows.length+' rows)<input type="file" accept=".xlsx,.xls,.csv" onchange="_hrmsSalLoadRef(this)" style="display:none">';
        document.getElementById('hrmsSalRefLabel').style.background='#dcfce7';
        document.getElementById('hrmsSalRefLabel').style.borderColor='#86efac';
        document.getElementById('hrmsSalRefLabel').style.color='#15803d';
        document.getElementById('hrmsSalCompareBtn').style.display='';
        notify('Reference file loaded: '+rows.length+' rows. Click Compare.');
      }catch(ex){hideSpinner();notify('Error: '+ex.message,true);}
    };
    reader.readAsArrayBuffer(file);
  }catch(ex){hideSpinner();notify(ex.message,true);}
}

function _hrmsSalGetCurrentRows(){
  // Build current salary data as array of objects (same format as export)
  var details=window._hrmsSalDetails||{};
  var mk=_hrmsMonth;if(!mk||!Object.keys(details).length) return[];
  var _mkP=mk.split('-');var _calMo=+_mkP[1];var _expMo=_calMo>=4?_calMo-3:_calMo+9;
  var rows=[];
  Object.keys(details).forEach(function(code){
    var d=details[code];
    var cat=(d.category||'').toLowerCase();
    var _r=Math.round;
    var _advRec=(DB.hrmsAdvances||[]).find(function(a){return a.empCode===code&&a.monthKey===mk;});
    var advOB=_r(d.advOB||0),advMonth=_r((_advRec&&_advRec.advance)||0);
    var advTotal=advOB+advMonth,advDed=_r((_advRec&&_advRec.deduction)||0),advCB=advTotal-advDed;
    var catShort=cat==='staff'?'ST':'W';
    var plantShort=(d.location||'').replace(/plant[\s\-]*(\d+)/i,'P$1').replace(/^(.{4}).*$/,'$1');
    rows.push({
      'Category':catShort,'Plant':plantShort,'Emp Code':String(d.empCode),'Name':d.name,
      'P':d.totalP,'A':d.totalA,'PL Given':+(d.plGiven||0).toFixed(2),'PH':d.phCount||0,
      'OT Hrs@1':Math.round((d.otAt1||0)*4)/4,'OT Hrs@1.5':Math.round((d.otAt15||0)*4)/4,'OT Hrs@2':Math.round((d.otAt2||0)*4)/4,
      'Sal for P':_r(d.salForP||0),'AB':_r(d.salAb||0),'Sal PL':_r(d.salForPL||0),
      'Sal OT@1':_r(d.salOT1||0),'Sal OT@1.5':_r(d.salOT15||0),'Sal OT@2':_r(d.salOT2||0),
      'Allow':_r(d.allowance||0),'Gross':_r(d.gross||0),
      'Adv OB':advOB,'Adv Month':advMonth,'Adv Total':advTotal,'Adv Deduction':advDed,'Adv CB':advCB,
      'PT':_r(d.dedPT||0),'PF':_r(d.dedPF||0),'ESI':_r(d.dedESI||0),'ADV':_r(d.dedAdv||0),'TDS':_r(d.dedTDS||0),'Other':_r(d.dedOther||0),
      'Total Deduction':_r(d.dedTotal||0),'Net Salary':_r(d.net||0)
    });
  });
  return rows;
}

function _hrmsSalCompare(){
  if(!_hrmsSalRefData){notify('Upload reference file first',true);return;}
  if(!window._hrmsSalDetails||!Object.keys(window._hrmsSalDetails).length){notify('No salary data. Render salary tab first.',true);return;}
  var refRows=_hrmsSalRefData;
  var curRows=_hrmsSalGetCurrentRows();
  // Same logic as Excel compare tool — match by column name, key = column C (3rd header)
  var refHeaders=Object.keys(refRows[0]||{});
  var curHeaders=Object.keys(curRows[0]||{});
  // Key column = 3rd column (index 2) from reference file
  var keyCol=refHeaders[2]||refHeaders[0];
  // Match columns between files (case/space insensitive)
  var _norm=function(s){return(s||'').replace(/[\s.]+/g,'').toLowerCase();};
  var refNormMap={};refHeaders.forEach(function(h){refNormMap[_norm(h)]=h;});
  // Build column mapping: curHeader → refHeader (only columns in both)
  var colMap={};// curHeader → refHeader
  var allHeaders=[];
  curHeaders.forEach(function(h){
    var rh=refNormMap[_norm(h)];
    if(rh){colMap[h]=rh;allHeaders.push(h);}
  });
  // Build maps
  var refMap={};refRows.forEach(function(r){var k=(r[keyCol]||'').toString().trim();if(k)refMap[k]=r;});
  // Find matching key column in current data
  var curKeyCol=curHeaders[2]||curHeaders[0];
  var curMap={};curRows.forEach(function(r){var k=(r[curKeyCol]||'').toString().trim();if(k)curMap[k]=r;});
  // All keys
  var allKeys={};
  Object.keys(refMap).forEach(function(k){allKeys[k]=true;});
  Object.keys(curMap).forEach(function(k){allKeys[k]=true;});
  var keys=Object.keys(allKeys).sort(function(a,b){
    var na=parseInt(a)||0,nb=parseInt(b)||0;
    return na!==nb?na-nb:a.localeCompare(b);
  });
  // Compare — same as Excel compare tool
  var diffRows=[],matched=0;
  var colsWithDiffs={};colsWithDiffs[keyCol]=true;
  // Always show name column (col D = index 3)
  if(curHeaders[3]) colsWithDiffs[curHeaders[3]]=true;
  keys.forEach(function(key){
    var r1=refMap[key],r2=curMap[key];
    if(!r1||!r2)return;
    var diffs={};var hasDiff=false;
    allHeaders.forEach(function(h){
      var refCol=colMap[h]||h;
      var v1=(r1[refCol]===undefined?'':r1[refCol]).toString().trim();
      var v2=(r2[h]===undefined?'':r2[h]).toString().trim();
      var n1=parseFloat(v1),n2=parseFloat(v2);
      if(!isNaN(n1)&&!isNaN(n2)&&v1!==''&&v2!==''){
        if(Math.abs(n1-n2)>3){diffs[h]={old:v1,new:v2};hasDiff=true;colsWithDiffs[h]=true;}
      } else {
        if(v1.toLowerCase()!==v2.toLowerCase()){diffs[h]={old:v1,new:v2};hasDiff=true;colsWithDiffs[h]=true;}
      }
    });
    if(hasDiff) diffRows.push({key:key,diffs:diffs,r1:r1,r2:r2});
    else matched++;
  });
  // Render — hide columns with no changes (except key + name)
  var el=document.getElementById('hrmsSalCompareResult');
  var visHeaders=allHeaders.filter(function(h){return colsWithDiffs[h];});
  if(!diffRows.length){
    el.innerHTML='<div style="padding:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;font-size:14px;color:#15803d;font-weight:700">All matched! '+matched+' employees identical.</div>';
    el.style.display='';
    document.getElementById('hrmsSalCloseCompBtn').style.display='';
    return;
  }
  var h='<div style="font-size:12px;font-weight:800;margin-bottom:6px">Differences: <span style="color:#dc2626">'+diffRows.length+'</span> | Matched: <span style="color:#16a34a">'+matched+'</span></div>';
  h+='<div style="display:inline-block;overflow-x:auto;border:1.5px solid #dc2626;border-radius:8px;max-height:50vh;overflow-y:auto">';
  h+='<table style="border-collapse:collapse;font-size:12px;white-space:nowrap"><thead><tr style="background:#1e293b;color:#fff;position:sticky;top:0;z-index:1">';
  visHeaders.forEach(function(c){h+='<th style="padding:4px 6px;font-size:10px;text-align:center">'+c+'</th>';});
  h+='</tr></thead><tbody>';
  diffRows.forEach(function(row){
    h+='<tr style="border-bottom:1px solid #e2e8f0">';
    visHeaders.forEach(function(c){
      var d=row.diffs[c];
      var val=row.r2[c]!==undefined?row.r2[c]:(row.r1[c]||'');
      if(d){
        h+='<td style="padding:3px 6px"><div style="color:#dc2626;text-decoration:line-through;font-size:10px">'+d.old+'</div><div style="color:#16a34a;font-weight:800">'+d.new+'</div></td>';
      } else {
        h+='<td style="padding:3px 6px;'+(c===keyCol?'font-family:var(--mono);font-weight:700;color:var(--accent)':'')+'">'+val+'</td>';
      }
    });
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  el.innerHTML=h;
  el.style.display='';
  document.getElementById('hrmsSalCloseCompBtn').style.display='';
}

function _hrmsSalCloseCompare(){
  document.getElementById('hrmsSalCompareResult').style.display='none';
  document.getElementById('hrmsSalCloseCompBtn').style.display='none';
}

function _hrmsOrSalExport(catFilter){
  if(!_hrmsHasAccess('action.exportSalary')){notify('Access denied',true);return;}
  if(!_hrmsMonth||!window._hrmsSalDetails) return;
  var details=window._hrmsSalDetails;
  var mk=_hrmsMonth;
  var _mkP=mk.split('-');var _calMo=+_mkP[1];var _expMo=_calMo>=4?_calMo-3:_calMo+9;// FY month: Apr=1, Mar=12
  var isAll=catFilter==='all';
  var isWorker=catFilter==='worker';
  var label=isAll?'Salary':(isWorker?'Worker':'Staff');
  var headers=['Category','Plant','Emp Code','Name','P','A','PL Given','PH','OT Hrs@1','OT Hrs@1.5','OT Hrs@2',
    'Sal for P','AB','Sal PL','Sal OT@1','Sal OT@1.5','Sal OT@2','Allow','Gross',
    'Adv OB','Adv Month','Adv Total','Adv Deduction','Adv CB',
    'PT','PF','ESI','ADV','TDS','Other','Total Deduction','Net Salary',
    'TPL','CTC','PLB'];
  var rows=[headers];
  // Sort: workers first, then staff; within each: plant, emp code
  var codes=Object.keys(details);
  codes.sort(function(a,b){
    var da=details[a],db=details[b];
    var catA=(da.category||'').toLowerCase()==='worker'?0:1;
    var catB=(db.category||'').toLowerCase()==='worker'?0:1;
    if(catA!==catB) return catA-catB;
    var p=(da.location||'').localeCompare(db.location||'');if(p!==0)return p;
    return(parseInt(a)||0)-(parseInt(b)||0);
  });
  codes.forEach(function(code){
    var d=details[code];
    var cat=(d.category||'').toLowerCase();
    if(!isAll){
      if(isWorker&&cat==='staff') return;
      if(!isWorker&&cat!=='staff') return;
    }
    var _r=Math.round;
    var _advRec=(DB.hrmsAdvances||[]).find(function(a){return a.empCode===code&&a.monthKey===mk;});
    var advOB=_r(d.advOB||0);
    var advMonth=_r((_advRec&&_advRec.advance)||0);
    var advTotal=advOB+advMonth;
    var advDed=_r((_advRec&&_advRec.deduction)||0);
    var advCB=advTotal-advDed;
    var catShort=(d.category||'').toLowerCase()==='staff'?'ST':'W';
    var plantShort=(d.location||'').replace(/plant[\s\-]*(\d+)/i,'P$1').replace(/^(.{4}).*$/,'$1');
    rows.push([
      catShort,plantShort,d.empCode,d.name,
      d.totalP,d.totalA,+(d.plGiven||0).toFixed(2),d.phCount||0,
      Math.round((d.otAt1||0)*4)/4,Math.round((d.otAt15||0)*4)/4,Math.round((d.otAt2||0)*4)/4,
      _r(d.salForP||0),_r(d.salAb||0),_r(d.salForPL||0),
      _r(d.salOT1||0),_r(d.salOT15||0),_r(d.salOT2||0),
      _r(d.allowance||0),_r(d.gross||0),
      advOB,advMonth,advTotal,advDed,advCB,
      _r(d.dedPT||0),_r(d.dedPF||0),_r(d.dedESI||0),_r(d.dedAdv||0),_r(d.dedTDS||0),_r(d.dedOther||0),
      _r(d.dedTotal||0),_r(d.net||0),
      +(d.plCB||0).toFixed(2),
      _r((d.gross||0)+2083+(cat!=='staff'?(d.gross||0)*3.25/100:0)+(d.dedPF||0)/12*13),
      +(Math.min(_expMo*1.5,d.plAvail||0)-(d.plCB||0)).toFixed(2)
    ]);
  });
  _downloadAsXlsx(rows,label+' Salary',label+'_Salary_'+_hrmsMonth+'.xlsx');
  notify('📤 Exported '+(rows.length-1)+' '+label+' records');
}

function _hrmsSalShowDetail(empCode){
  var d=window._hrmsSalDetails&&window._hrmsSalDetails[empCode];
  if(!d) return;
  var _r=function(v){return Math.round(v).toLocaleString();};
  var _f=function(v){if(v==null)return'0';if(v%1===0)return String(v);var r=Math.round(v*4)/4;return r.toFixed(2).replace(/\.?0+$/,'');};
  var isStaff=(d.category||'').toLowerCase()==='staff';
  var mk=_hrmsMonth||'';
  var conf=null;
  var emp=(DB.hrmsEmployees||[]).find(function(e){return e.empCode===empCode;});
  if(emp) conf=_hrmsGetConfirmationDate(emp);
  var confStr=conf?conf.getDate()+'-'+_MON3[conf.getMonth()+1]+'-'+String(conf.getFullYear()).slice(-2):'—';

  // Build a single section card
  var _section=function(title,clr,rows){
    var h='<div style="border:1.5px solid var(--border);border-radius:8px;padding:10px 12px;background:#fff;break-inside:avoid">';
    h+='<div style="font-size:13px;font-weight:900;color:'+clr+';margin-bottom:6px;padding-bottom:4px;border-bottom:2px solid '+clr+'">'+title+'</div>';
    h+='<table style="width:100%;border-collapse:collapse;font-size:12px">';
    rows.forEach(function(r){
      h+='<tr'+(r[2]?' style="'+r[2]+'"':'')+'><td style="padding:3px 4px;font-weight:600;color:var(--text2);white-space:nowrap">'+r[0]+'</td><td style="padding:3px 4px;font-weight:800;text-align:right;font-family:var(--mono)">'+r[1]+'</td></tr>';
    });
    h+='</table></div>';
    return h;
  };

  // Define all sections
  var empInfoRows=[
    ['Date of Joining',_hrmsFmtDate(d.doj)],
    ['Confirmation',confStr],
    ['Conf Months',d.confMonths>=0?_f(d.confMonths):'Not confirmed'],
    ['FY Month No.',d.fyMonthNo],
    ['Rate/Day',d.rateD?_r(d.rateD):'—'],
    ['Rate/Month',d.rateM?_r(d.rateM):'—'],
    ['Sp. Allow (rate)',d.spAllow?_r(d.spAllow):'0']
  ];
  var daysRows=[
    ['Working Days (WD)',d.wdCount],
    ['Paid Holidays (PH)',d.phCount],
    ['Present (P)',_f(d.totalP)],
    ['Absent (A)',_f(d.totalA)],
    ['Paid Absent (after PL)',_f(d.paidAbsent)]
  ];
  var plRows=[
    ['PL Available (cum.)',_f(d.plAvail)],
    ['PL OB',_f(d.plOB)],
    ['PL Given',_f(d.plGiven)],
    ['PL CB',_f(d.plCB)],
    ['Total PL (incl PH)',_f(d.totalPL)]
  ];
  var otRows=[
    ['Raw OT hrs',_f(d.totalOT)],
    ['Raw OT@Sunday',_f(d.totalOTS)],
    ['Ineligible OT (IOT)',_f(d.iot)],
    ['Effective @1',_f(d.otAt1)],
    ['Effective @1.5',_f(d.otAt15)],
    ['Effective @2',_f(d.otAt2)]
  ];
  var salRows=[
    ['For Present',_r(d.salForP)],
    ['Attendance Bonus',_r(d.salAb)],
    ['For PL',_r(d.salForPL)]
  ];
  if(!isStaff){
    salRows.push(['OT @1',_r(d.salOT1)]);
    salRows.push(['OT @1.5',_r(d.salOT15)]);
    salRows.push(['OT @2',_r(d.salOT2)]);
  }
  salRows.push(['Allowance',_r(d.allowance)]);
  salRows.push(['Gross','<span style="color:#15803d">'+_r(d.gross)+'</span>','background:#dcfce7']);
  var dedRows=[
    ['PT',_r(d.dedPT)],
    ['PF',_r(d.dedPF)],
    ['ESI',_r(d.dedESI)],
    ['Advance Ded',_r(d.dedAdv)],
    ['TDS',_r(d.dedTDS)],
    ['Other',_r(d.dedOther)],
    ['Total Deductions',_r(d.dedTotal),'background:#fef2f2']
  ];

  // Header
  var h='<div>';
  h+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid var(--accent);gap:12px">';
  h+='<div><div style="font-size:20px;font-weight:900;color:var(--accent)"><span data-emp-code="'+d.empCode+'" style="cursor:pointer;text-decoration:underline" title="Click to view employee details">'+d.empCode+'</span> — '+d.name+'</div>';
  h+='<div style="font-size:12px;color:var(--text3);margin-top:2px">'+d.location+' · '+(d.category||'—')+' · '+_hrmsMonthLabel(mk)+'</div></div>';
  h+='<div style="display:flex;align-items:center;gap:12px">';
  h+='<div style="text-align:right"><div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Net Salary</div><div style="font-size:26px;font-weight:900;color:#15803d;font-family:var(--mono)">₹'+_r(d.net)+'</div></div>';
  h+='<button onclick="cm(\'mSalDetail\')" style="padding:6px 14px;font-size:12px;font-weight:700;background:#f1f5f9;border:1.5px solid var(--border);color:var(--text);border-radius:6px;cursor:pointer">✕ Close</button>';
  h+='</div></div>';

  // Multi-column grid of section cards
  h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;align-items:start">';
  h+=_section('Employee Info','var(--accent)',empInfoRows);
  h+=_section('Days','#2563eb',daysRows);
  h+=_section('Paid Leave','#7c3aed',plRows);
  if(!isStaff) h+=_section('Overtime','#b45309',otRows);
  h+=_section('Salary Bifurcation','#16a34a',salRows);
  h+=_section('Deductions','#dc2626',dedRows);
  h+='</div>';

  h+='</div>';

  // Show in modal — wide, no vertical scroll
  var modal=document.getElementById('mSalDetail');
  if(!modal){
    modal=document.createElement('div');modal.id='mSalDetail';
    modal.style.cssText='display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.4);z-index:500;justify-content:center;align-items:center';
    modal.onclick=function(e){if(e.target===modal){modal.style.display='none';}};
    var inner=document.createElement('div');inner.id='mSalDetailInner';
    modal.appendChild(inner);
    document.body.appendChild(modal);
  }
  var inner=document.getElementById('mSalDetailInner');
  inner.style.cssText='background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);padding:18px 22px;max-width:1200px;width:96vw;max-height:94vh;overflow:auto';
  inner.innerHTML=h;
  modal.style.display='flex';
}

// ESC closes the salary detail popup
if(!window._hrmsSalDetailEscInstalled){
  document.addEventListener('keydown',function(ev){
    if(ev.key!=='Escape') return;
    var m=document.getElementById('mSalDetail');
    if(m&&m.style.display!=='none') m.style.display='none';
  });
  window._hrmsSalDetailEscInstalled=true;
}

async function _hrmsSaveBalances(catFilter){
  var isAll=catFilter==='all';
  var isWorker=catFilter==='worker';
  var balKey=isAll?'_hrmsSalBal':(isWorker?'_hrmsWorkerBal':'_hrmsStaffBal');
  var data=window[balKey];
  if(!data||!data.balances||!data.balances.length){if(!isAll)notify('No balances to save',true);return;}
  var mk=data.mk;
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});
  var toSave=[];
  for(var i=0;i<data.balances.length;i++){
    var b=data.balances[i];
    var emp=empMap[b.empCode];if(!emp)continue;
    if(!emp.extra) emp.extra={};
    if(!emp.extra.bal) emp.extra.bal={};
    emp.extra.bal[mk]={plOB:b.plOB,plCB:b.plCB,advOB:b.advOB,advCB:b.advCB};
    toSave.push(emp);
  }
  showSpinner('Saving balances…');
  var saved=await _dbSaveBulk('hrmsEmployees',toSave);
  hideSpinner();
  var label=isAll?'All':(isWorker?'Worker':'Staff');
  notify('✅ '+label+' balances saved for '+saved+' employees');
}

function _hrmsAltClearFilters(){
  ['altSrchCode','altSrchName'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});
  ['altFType','altFPlant','altFCat','altFTeam'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});
  _hrmsAltFilterChanged();
}
function _hrmsAltFilterChanged(){
  var mk=_hrmsAttSelectedMonth;if(!mk)return;
  var parts=mk.split('-');
  _hrmsRenderAltGrid(parseInt(parts[0]),parseInt(parts[1]));
}
function _hrmsRenderAltGrid(yr,mo){
  var grid=document.getElementById('hrmsAltGrid');if(!grid)return;
  var monthKey=yr+'-'+String(mo).padStart(2,'0');
  var canApprove=_hrmsHasAccess('action.approveAlt');
  var canReject=_hrmsHasAccess('action.rejectAlt');
  var dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var _MON3s=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  var altRecords=_hrmsAltCache[monthKey]||[];
  var attRecords=_hrmsAttCache[monthKey]||[];
  if(!altRecords.length){grid.innerHTML='<div class="empty-state">No alteration records for this month.</div>';document.getElementById('hrmsAltCount').textContent='';return;}

  var attLookup={};attRecords.forEach(function(a){attLookup[a.empCode]=a.days||{};});
  var altLookup={};altRecords.forEach(function(a){altLookup[a.empCode]=a.days||{};});

  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});

  // Build a flat list of alterations with employee context
  // Each row: { emp, day, alt, orig, dType }
  var altRows=[];
  Object.keys(altLookup).forEach(function(ec){
    var emp=empMap[ec]||{empCode:ec,name:'Employee NA',location:'',category:'',employmentType:'',teamName:'',_unmatched:true};
    var empAlt=altLookup[ec]||{};
    var empAtt=attLookup[ec]||{};
    Object.keys(empAlt).forEach(function(dk){
      var d=+dk;if(!d) return;
      altRows.push({emp:emp,day:d,alt:empAlt[dk],orig:empAtt[String(d)]||{}});
    });
  });

  // Apply emp code/name filter (single combined search)
  var _ac=(document.getElementById('altSrchCode')?.value||'').toLowerCase().trim();
  if(_ac){
    altRows=altRows.filter(function(r){
      var code=(r.emp.empCode||'').toLowerCase();
      var name=((r.emp.name||'')+' '+_hrmsDispName(r.emp)).toLowerCase();
      return code.indexOf(_ac)>=0 || name.indexOf(_ac)>=0;
    });
  }

  // Sort: plant → category → empCode → day
  var catOrder={'staff':0,'worker':1,'security':2};
  altRows.sort(function(a,b){
    var pp=(a.emp.location||'').localeCompare(b.emp.location||'');if(pp!==0) return pp;
    var ac=(a.emp.category||'').toLowerCase(),bc=(b.emp.category||'').toLowerCase();
    var ci=catOrder[ac]!==undefined?catOrder[ac]:9;
    var cj=catOrder[bc]!==undefined?catOrder[bc]:9;
    if(ci!==cj) return ci-cj;
    var ec=(parseInt(a.emp.empCode)||0)-(parseInt(b.emp.empCode)||0);
    if(ec!==0) return ec;
    return a.day-b.day;
  });

  // Summary counts
  var pendingCount=altRows.filter(function(r){return r.alt.approved===false;}).length;
  var approvedCount=altRows.length-pendingCount;
  document.getElementById('hrmsAltCount').textContent=altRows.length+' alteration(s) · '+approvedCount+' approved · '+pendingCount+' pending';

  if(!altRows.length){grid.innerHTML='<div class="empty-state">No alterations match the filter.</div>';return;}

  // Parse time to compare (for highlight)
  var _timesSame=function(a,b){
    var pa=_hrmsParseTime(a);var pb=_hrmsParseTime(b);
    if(pa===null&&pb===null) return(a||'')===(b||'');
    return pa===pb;
  };

  // Tabular view — one row per alteration
  var _th='padding:6px 8px;font-size:11px;font-weight:800;background:#f1f5f9;border-bottom:2px solid var(--border);text-align:left;white-space:nowrap';
  var _td='padding:5px 8px;font-size:12px;border-bottom:1px solid #f1f5f9;white-space:nowrap';
  var h='<div style="border:1.5px solid var(--border);border-radius:8px;overflow:hidden">';
  h+='<table style="width:100%;border-collapse:collapse">';
  h+='<thead><tr>';
  h+='<th style="'+_th+';width:30px;text-align:center">#</th>';
  h+='<th style="'+_th+';width:300px">Employee</th>';
  h+='<th style="'+_th+';width:90px">Date</th>';
  h+='<th style="'+_th+';width:55px">Day</th>';
  h+='<th style="'+_th+';width:70px;text-align:center">Actual In</th>';
  h+='<th style="'+_th+';width:70px;text-align:center">Actual Out</th>';
  h+='<th style="'+_th+';width:70px;text-align:center;background:#faf5ff;color:#7c3aed">Alt In</th>';
  h+='<th style="'+_th+';width:70px;text-align:center;background:#faf5ff;color:#7c3aed">Alt Out</th>';
  h+='<th style="'+_th+'">Reason</th>';
  h+='<th style="'+_th+';width:85px;text-align:center">Status</th>';
  h+='<th style="'+_th+';width:110px;text-align:center">Action</th>';
  h+='</tr></thead><tbody>';

  var isLocked=_hrmsIsMonthLocked(monthKey);

  // Pre-compute rowspan and per-employee serial number
  var rowSpans=new Array(altRows.length);
  var empSeq=new Array(altRows.length);
  var seq=0;
  for(var ri=0;ri<altRows.length;ri++){
    if(ri>0&&altRows[ri].emp.empCode===altRows[ri-1].emp.empCode){rowSpans[ri]=0;continue;}
    seq++;
    empSeq[ri]=seq;
    var span=1;
    for(var rj=ri+1;rj<altRows.length;rj++){
      if(altRows[rj].emp.empCode===altRows[ri].emp.empCode) span++;else break;
    }
    rowSpans[ri]=span;
  }

  altRows.forEach(function(r,idx){
    var emp=r.emp;
    var alt=r.alt||{};
    var orig=r.orig||{};
    var d=r.day;
    var dt=new Date(yr,mo-1,d);
    var dayName=dayNames[dt.getDay()];
    var isSun=dt.getDay()===0;
    var dType=_hrmsGetDayType(monthKey,d,yr,mo,emp.location);
    var dTypeBadge='';
    if(dType==='WO') dTypeBadge=' <span style="font-size:9px;padding:0 4px;border-radius:2px;background:#dbeafe;color:#1d4ed8">WO</span>';
    else if(dType==='PH') dTypeBadge=' <span style="font-size:9px;padding:0 4px;border-radius:2px;background:#dcfce7;color:#15803d">PH</span>';

    var aIn=orig['in']||'';var aOut=orig['out']||'';
    var xIn=alt['in']||'';var xOut=alt['out']||'';
    var reason=alt['reason']||'';
    var inChanged=!_timesSame(aIn,xIn);
    var outChanged=!_timesSame(aOut,xOut);

    // Approval state: approved=true → approved; approved=false → pending; absent → legacy approved
    var isPending=alt.approved===false;
    var isApproved=!isPending;

    var rowBg=isPending?'#fefce8':(idx%2===0?'#fff':'#fafbfc');
    var pClr=emp._unmatched?'#fecaca':_hrmsGetPlantColor(emp.location);
    var isGroupStart=rowSpans[idx]>0;
    var topBorder=isGroupStart?'border-top:2px solid var(--border);':'';

    h+='<tr style="background:'+rowBg+'">';
    // # column: only on the first row of each employee group, spanning all their rows
    if(isGroupStart){
      h+='<td rowspan="'+rowSpans[idx]+'" style="'+_td+';text-align:center;color:var(--text3);font-size:11px;font-weight:700;vertical-align:top;padding-top:8px;'+topBorder+'">'+empSeq[idx]+'</td>';
      // Employee cell with rowspan
      var empName=emp._unmatched?'Employee NA':_hrmsDispName(emp);
      var empCellHtml='<div style="display:flex;flex-direction:column;gap:3px;white-space:normal">';
      empCellHtml+='<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">';
      empCellHtml+='<span data-emp-code="'+emp.empCode+'" title="Click to view employee" style="cursor:pointer;text-decoration:underline;font-family:var(--mono);font-weight:800;color:'+(emp._unmatched?'#dc2626':'var(--accent)')+'">'+emp.empCode+'</span>';
      empCellHtml+='<span style="font-weight:700">'+empName+'</span>';
      empCellHtml+='</div>';
      empCellHtml+='<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">';
      empCellHtml+='<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;background:'+pClr+';color:#1e293b">'+(emp.location||'—')+'</span>';
      empCellHtml+='<span style="font-size:10px;color:var(--text3);font-weight:600">'+(emp.category||'—')+'</span>';
      empCellHtml+='</div>';
      if(rowSpans[idx]>1) empCellHtml+='<div style="font-size:10px;color:var(--text3);margin-top:2px">'+rowSpans[idx]+' alterations</div>';
      empCellHtml+='</div>';
      h+='<td rowspan="'+rowSpans[idx]+'" style="'+_td+';vertical-align:top;padding-top:6px;'+topBorder+'">'+empCellHtml+'</td>';
    }
    // topBorder also on other cells for visual grouping
    var cellTop=isGroupStart?'border-top:2px solid var(--border);':'';
    h+='<td style="'+_td+';font-family:var(--mono);font-weight:700;'+cellTop+'">'+String(d).padStart(2,'0')+'-'+_MON3s[mo]+'-'+String(yr).slice(-2)+dTypeBadge+'</td>';
    h+='<td style="'+_td+';color:'+(isSun?'#dc2626':'var(--text3)')+';font-weight:'+(isSun?'700':'500')+';'+cellTop+'">'+dayName+'</td>';
    h+='<td style="'+_td+';text-align:center;font-family:var(--mono);color:var(--text2);'+cellTop+'">'+(aIn||'—')+'</td>';
    h+='<td style="'+_td+';text-align:center;font-family:var(--mono);color:var(--text2);'+cellTop+'">'+(aOut||'—')+'</td>';
    h+='<td style="'+_td+';text-align:center;font-family:var(--mono);font-weight:'+(inChanged?'800':'500')+';background:'+(inChanged?'#fef3c7':'#faf5ff')+';color:'+(inChanged?'#b45309':'#7c3aed')+';'+cellTop+'">'+(xIn||'—')+'</td>';
    h+='<td style="'+_td+';text-align:center;font-family:var(--mono);font-weight:'+(outChanged?'800':'500')+';background:'+(outChanged?'#fef3c7':'#faf5ff')+';color:'+(outChanged?'#b45309':'#7c3aed')+';'+cellTop+'">'+(xOut||'—')+'</td>';
    h+='<td style="'+_td+';font-style:italic;color:var(--text2);white-space:normal;'+cellTop+'" title="'+(reason||'').replace(/"/g,'&quot;')+'">'+(reason||'<span style="color:#94a3b8">—</span>')+'</td>';
    // Status
    if(isApproved){
      var byTag=alt.approvedBy?'<div style="font-size:9px;color:var(--text3);margin-top:1px">by '+alt.approvedBy+'</div>':'';
      h+='<td style="'+_td+';text-align:center;'+cellTop+'"><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:800;background:#dcfce7;color:#15803d">✓ APPROVED</span>'+byTag+'</td>';
    } else {
      h+='<td style="'+_td+';text-align:center;'+cellTop+'"><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:800;background:#fef3c7;color:#92400e">⏳ PENDING</span></td>';
    }
    // Action
    if(isLocked){
      h+='<td style="'+_td+';text-align:center;color:var(--text3);font-size:10px;'+cellTop+'">🔒 Locked</td>';
    } else if(isPending){
      var pendHtml='';
      if(canApprove) pendHtml+='<button onclick="_hrmsApproveAlteration(\''+emp.empCode+'\','+d+')" title="Approve alteration" style="padding:3px 8px;font-size:10px;font-weight:700;background:#dcfce7;border:1.5px solid #86efac;color:#15803d;border-radius:4px;cursor:pointer;margin-right:3px">✓ Approve</button>';
      if(canReject) pendHtml+='<button onclick="_hrmsRejectAlteration(\''+emp.empCode+'\','+d+')" title="Reject (remove)" style="padding:3px 6px;font-size:10px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer">✕</button>';
      if(!pendHtml) pendHtml='<span style="color:var(--text3);font-size:10px">—</span>';
      h+='<td style="'+_td+';text-align:center;white-space:nowrap;'+cellTop+'">'+pendHtml+'</td>';
    } else {
      if(canReject){
        h+='<td style="'+_td+';text-align:center;'+cellTop+'"><button onclick="_hrmsRejectAlteration(\''+emp.empCode+'\','+d+')" title="Remove alteration" style="padding:3px 8px;font-size:10px;font-weight:700;background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;border-radius:4px;cursor:pointer">✕ Remove</button></td>';
      } else {
        h+='<td style="'+_td+';text-align:center;color:var(--text3);font-size:10px;'+cellTop+'">—</td>';
      }
    }
    h+='</tr>';
  });
  h+='</tbody></table></div>';

  grid.innerHTML=h;
}

// ═══ ALTERATION APPROVAL FUNCTIONS ═══════════════════════════════════════
async function _hrmsApproveAlteration(empCode,day){
  if(!_hrmsHasAccess('action.approveAlt')){notify('Access denied',true);return;}
  var mk=_hrmsAttSelectedMonth;if(!mk) return;
  if(_hrmsIsMonthLocked(mk)){notify('⚠ Month is locked.',true);return;}
  var rec=(_hrmsAltCache[mk]||[]).find(function(a){return a.empCode===empCode;});
  if(!rec||!rec.days||!rec.days[String(day)]){notify('Alteration not found',true);return;}
  rec.days[String(day)].approved=true;
  rec.days[String(day)].approvedBy=(CU?(CU.name||CU.id||''):'');
  rec.days[String(day)].approvedAt=new Date().toISOString();
  showSpinner('Saving approval…');
  var ok=await _dbSave('hrmsAlterations',rec);
  hideSpinner();
  if(!ok){notify('⚠ Failed to save',true);return;}
  var p=mk.split('-');_hrmsRenderAltGrid(+p[0],+p[1]);
  notify('✅ Alteration approved for '+empCode+' · Day '+day);
}

async function _hrmsRejectAlteration(empCode,day){
  if(!_hrmsHasAccess('action.rejectAlt')){notify('Access denied',true);return;}
  var mk=_hrmsAttSelectedMonth;if(!mk) return;
  if(_hrmsIsMonthLocked(mk)){notify('⚠ Month is locked.',true);return;}
  if(!confirm('Remove alteration for '+empCode+' on day '+day+'?\n\nThe original ESSL attendance will be used instead.')) return;
  var rec=(_hrmsAltCache[mk]||[]).find(function(a){return a.empCode===empCode;});
  if(!rec||!rec.days){notify('Alteration not found',true);return;}
  delete rec.days[String(day)];
  showSpinner('Removing…');
  // If no days left, delete the whole record
  if(!Object.keys(rec.days).length){
    await _dbDel('hrmsAlterations',rec.id);
    _hrmsAltCache[mk]=_hrmsAltCache[mk].filter(function(a){return a.id!==rec.id;});
  } else {
    await _dbSave('hrmsAlterations',rec);
  }
  hideSpinner();
  var p=mk.split('-');_hrmsRenderAltGrid(+p[0],+p[1]);
  notify('✅ Alteration removed for '+empCode+' · Day '+day);
}

async function _hrmsApproveAllAlterations(){
  if(!_hrmsHasAccess('action.approveAlt')){notify('Access denied',true);return;}
  var mk=_hrmsAttSelectedMonth;if(!mk) return;
  if(_hrmsIsMonthLocked(mk)){notify('⚠ Month is locked.',true);return;}
  var recs=_hrmsAltCache[mk]||[];
  var pending=[];
  recs.forEach(function(rec){
    Object.keys(rec.days||{}).forEach(function(d){
      if(rec.days[d].approved===false) pending.push({rec:rec,day:d});
    });
  });
  if(!pending.length){notify('No pending alterations');return;}
  if(!confirm('Approve all '+pending.length+' pending alteration(s)?')) return;
  showSpinner('Approving '+pending.length+' alterations…');
  var by=CU?(CU.name||CU.id||''):'';
  var now=new Date().toISOString();
  var touchedRecs={};
  pending.forEach(function(p){
    p.rec.days[p.day].approved=true;
    p.rec.days[p.day].approvedBy=by;
    p.rec.days[p.day].approvedAt=now;
    touchedRecs[p.rec.id]=p.rec;
  });
  var ids=Object.keys(touchedRecs);
  for(var i=0;i<ids.length;i++){
    await _dbSave('hrmsAlterations',touchedRecs[ids[i]]);
  }
  hideSpinner();
  var p=mk.split('-');_hrmsRenderAltGrid(+p[0],+p[1]);
  notify('✅ Approved '+pending.length+' alteration(s)');
}

// ═══ ALTERATION EMP AUTOCOMPLETE ═════════════════════════════════════════
function _hrmsAltEmpAutocomplete(inp){
  var list=document.getElementById('altEmpAcList');if(!list) return;
  var q=(inp.value||'').trim().toLowerCase();
  // Build candidate list from employees that have alterations this month
  var mk=_hrmsAttSelectedMonth;
  if(!mk){list.style.display='none';return;}
  var altRecs=_hrmsAltCache[mk]||[];
  var altCodes={};altRecs.forEach(function(r){altCodes[r.empCode]=true;});
  var empMap={};(DB.hrmsEmployees||[]).forEach(function(e){empMap[e.empCode]=e;});
  var codes=Object.keys(altCodes);
  var candidates=codes.map(function(ec){return empMap[ec]||{empCode:ec,name:'Employee NA',_unmatched:true};});
  if(q){
    candidates=candidates.filter(function(e){
      var code=(e.empCode||'').toLowerCase();
      var name=((e.name||'')+' '+_hrmsDispName(e)).toLowerCase();
      return code.indexOf(q)>=0||name.indexOf(q)>=0;
    });
  }
  candidates=candidates.slice(0,30);
  if(!candidates.length){list.innerHTML='<div style="padding:8px 12px;color:var(--text3);font-size:12px">No matches</div>';list.style.display='block';return;}
  var h='';
  candidates.forEach(function(e){
    var name=_hrmsDispName(e)||e.name||'';
    h+='<div onmousedown="_hrmsAltEmpACPick(\''+e.empCode+'\')" style="padding:6px 10px;cursor:pointer;border-bottom:1px solid #f1f5f9;font-size:12px;display:flex;align-items:center;gap:8px" onmouseover="this.style.background=\'#f0f9ff\'" onmouseout="this.style.background=\'#fff\'">';
    h+='<span style="font-family:var(--mono);font-weight:800;color:var(--accent);min-width:60px">'+e.empCode+'</span>';
    h+='<span style="font-weight:600;flex:1">'+name+'</span>';
    if(e.location) h+='<span style="font-size:10px;color:var(--text3)">'+e.location+'</span>';
    h+='</div>';
  });
  list.innerHTML=h;list.style.display='block';
}
function _hrmsAltEmpACPick(code){
  var inp=document.getElementById('altSrchCode');if(inp){inp.value=code;_hrmsAltEmpACClose();_hrmsAltFilterChanged();}
}
function _hrmsAltEmpACClose(){var list=document.getElementById('altEmpAcList');if(list) list.style.display='none';}

// ═══ ALTERATION SHEET (import / grid) ═══════════════════════════════════
// Format: Emp Code, Employee Name (ignored), Date, Time IN, Time Out, Reason
async function _hrmsImportAlteration(inputEl){
  if(!_hrmsHasAccess('action.importAlterations')){notify('Access denied',true);return;}
  var file=inputEl.files[0];if(!file)return;inputEl.value='';
  if(!_hrmsAttSelectedMonth){notify('Open a month first',true);return;}
  if(_hrmsIsMonthLocked(_hrmsAttSelectedMonth)){notify('⚠ '+_hrmsMonthLabel(_hrmsAttSelectedMonth)+' is locked. Unlock to import.',true);return;}
  var mk=_hrmsAttSelectedMonth;
  var _fileName=file.name,_fileSize=file.size;
  showSpinner('Importing alteration…');
  try{
    var reader=new FileReader();
    reader.onload=async function(ev){
      try{
        var _fileBuf=ev.target.result;
        var rows=await _parseXLSX(_fileBuf);
        if(!rows.length){hideSpinner();notify('No data in file',true);return;}
        var _fd=function(v){
          var s=(v||'').toString().trim();if(!s)return'';
          if(s.match(/^\d{4}-\d{2}-\d{2}$/))return s;
          var m2=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
          if(m2) return m2[3]+'-'+m2[2].padStart(2,'0')+'-'+m2[1].padStart(2,'0');
          var d=new Date(s);return isNaN(d)?'':d.toISOString().slice(0,10);
        };
        var _ft=function(v){
          var s=(v||'').toString().trim();if(!s)return'';
          var n=parseFloat(s);
          if(!isNaN(n)&&n>=0&&n<1){
            var totalMin=Math.round(n*24*60);
            var hh=Math.floor(totalMin/60);var mm=totalMin%60;
            return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
          }
          if(s.match(/^\d{1,2}:\d{2}/)) return s.slice(0,5);
          return s;
        };
        // Validate all rows belong to the selected month
        var grouped={};
        var altered=0;
        var badRows=[];
        for(var i=0;i<rows.length;i++){
          var r=rows[i];
          var empCode=(r['Emp Code']||r['Employee Code']||r['EmpCode']||r['Code']||'').toString().trim();
          if(!empCode)continue;
          var attDate=_fd(r['Date']||r['Att Date']||r['AttDate']||'');
          if(!attDate){badRows.push('Row '+(i+2)+': Invalid or missing date for '+empCode);continue;}
          var dp=attDate.split('-');
          var rowMk=dp[0]+'-'+dp[1];
          if(rowMk!==mk){
            badRows.push('Row '+(i+2)+': Date '+attDate+' does not belong to '+mk+' (Emp: '+empCode+')');
            continue;
          }
          var day=+dp[2];
          var timeIn=_ft(r['Time IN']||r['Time In']||r['TimeIn']||r['IN']||r['In']||'');
          var timeOut=_ft(r['Time Out']||r['TimeOut']||r['Time OUT']||r['OUT']||r['Out']||'');
          var reason=(r['Reason']||r['reason']||r['Remarks']||'').toString().trim();
          if(!grouped[empCode]) grouped[empCode]={};
          grouped[empCode][String(day)]={'in':timeIn,'out':timeOut,'reason':reason,'approved':false};
          altered++;
        }
        if(badRows.length){
          hideSpinner();
          notify('⚠ '+badRows.length+' row(s) have errors. Import aborted:\n'+badRows.slice(0,5).join('\n'),true);
          return;
        }
        if(!altered){hideSpinner();notify('No valid alteration data found for '+mk,true);return;}

        // Track existing state (for added vs updated count in log)
        var altCached=_hrmsAltCache[mk]||[];
        var existedBefore=altCached.length;
        var action=existedBefore>0?'replace':'new';
        // Delete all existing alteration records for this month
        for(var ei=0;ei<altCached.length;ei++){
          await _dbDel('hrmsAlterations',altCached[ei].id);
        }
        _hrmsAltCache[mk]=[];
        altCached=[];
        // Save new alteration records
        var saved=0,errors=0;
        for(var ec in grouped){
          var rec={id:'halt'+uid(),empCode:ec,monthKey:mk,days:grouped[ec]};
          if(await _dbSave('hrmsAlterations',rec)){saved++;altCached.push(rec);} else errors++;
        }
        _hrmsAltCache[mk]=altCached;

        // ── Save import log + file copy to DB ──
        try{
          var logId='impAlt_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
          var logEntry={
            id:logId,timestamp:new Date().toISOString(),
            type:'alteration',fileName:_fileName,fileSize:_fileSize,
            monthKey:mk,action:action,
            totalRows:rows.length,alterations:altered,employees:saved,
            added:action==='new'?saved:0,updated:action==='replace'?saved:0,
            errors:errors,importedBy:(CU?(CU.name||CU.id||''):'')
          };
          var logRec=(DB.hrmsSettings||[]).find(function(r){return r.key==='altImportLog';});
          if(!logRec){
            logRec={id:'hs_altImpLog',key:'altImportLog',data:{imports:[]}};
            if(!DB.hrmsSettings) DB.hrmsSettings=[];
            DB.hrmsSettings.push(logRec);
          }
          if(!logRec.data.imports) logRec.data.imports=[];
          logRec.data.imports.unshift(logEntry);
          if(logRec.data.imports.length>100) logRec.data.imports.length=100;
          await _dbSave('hrmsSettings',logRec);
          // Save file content separately
          var b64=_hrmsAb2b64(_fileBuf);
          var fileRec={id:'hs_altImpFile_'+logId,key:'altImpFile_'+logId,data:{fileName:_fileName,base64:b64}};
          if(!DB.hrmsSettings.find(function(r){return r.id===fileRec.id;})) DB.hrmsSettings.push(fileRec);
          await _dbSave('hrmsSettings',fileRec);
        }catch(logErr){console.warn('Alteration log save failed:',logErr);}

        hideSpinner();
        _hrmsAttSetTab('alteration');
        if(typeof _hrmsRenderAltImportLog==='function') _hrmsRenderAltImportLog();
        notify('✅ Alteration: '+altered+' entries for '+Object.keys(grouped).length+' employees'+(errors?', '+errors+' failed':''));
      }catch(ex){hideSpinner();notify('⚠ Import error: '+ex.message,true);console.error(ex);}
    };
    reader.readAsArrayBuffer(file);
  }catch(ex){hideSpinner();notify('⚠ '+ex.message,true);}
}

