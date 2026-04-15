/** @file HRMS pure logic functions — salary, attendance, statutory calculations. No DOM access.
 *  @depends common.js
 */

// ═══ PERIOD / MONTH HELPERS ═══

/**
 * Convert YYYY-MM string to short label like "Jan 25".
 * @param {string} ym - Month key in YYYY-MM format
 * @returns {string} Formatted label or "Till date" if falsy
 */
function _hrmsMonthLabel(ym){
  if(!ym) return 'Till date';
  var parts=ym.split('-');var mon=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return mon[parseInt(parts[1])-1]+' '+parts[0].slice(-2);
}
/**
 * Get the current month as YYYY-MM string.
 * @returns {string} Current month in YYYY-MM format
 */
function _hrmsCurMonth(){var n=new Date();return n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0');}
/**
 * Get the previous month relative to a given YYYY-MM string.
 * @param {string} ym - Month key in YYYY-MM format
 * @returns {string} Previous month in YYYY-MM format
 */
function _hrmsPrevMonth(ym){var d=new Date(ym+'-15');d.setMonth(d.getMonth()-1);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}

/**
 * Migrate legacy flat employee fields into a periods array.
 * @param {Object} e - Employee record
 * @returns {Array<Object>} Array of period objects
 */
function _hrmsMigratePeriods(e){
  // If employee has no periods array, create one from flat fields (migration)
  if(e.periods&&e.periods.length) return e.periods;
  var p={from:'2025-01',to:null};
  _PERIOD_FIELDS.forEach(function(f){p[f]=e[f]||'';});
  if(typeof p.salaryDay==='string') p.salaryDay=parseFloat(p.salaryDay)||0;
  if(typeof p.salaryMonth==='string') p.salaryMonth=parseFloat(p.salaryMonth)||0;
  if(typeof p.specialAllowance==='string') p.specialAllowance=parseFloat(p.specialAllowance)||0;
  return [p];
}

/**
 * Return the currently active period from the global periods array.
 * @returns {Object|null} Active period object or null
 */
function _hrmsGetActivePeriod(){return _hrmsEmpPeriods[_hrmsActivePeriodIdx]||_hrmsEmpPeriods[0]||null;}

// ═══ ROLE CHECK ═══

/**
 * Check if the current user has the Super Admin role.
 * @returns {boolean} True if current user is Super Admin
 */
function _hrmsIsSA(){return CU&&((CU.hrmsRoles||[]).indexOf('Super Admin')>=0||(CU.roles||[]).indexOf('Super Admin')>=0);}

// ═══ DATA SANITIZATION ═══

/**
 * Strip newlines and trim whitespace from all string fields in periods.
 * @param {Array<Object>} periods - Array of period objects to sanitize
 * @returns {void}
 */
function _hrmsSanitizePeriods(periods){
  (periods||[]).forEach(function(p){
    Object.keys(p).forEach(function(k){
      if(typeof p[k]==='string'&&k!=='_wfStatus'&&k!=='_ecrResult') p[k]=p[k].replace(/[\r\n]+/g,' ').trim();
    });
  });
}

// ═══ DATE / TIME FORMATTING ═══

/**
 * Format an ISO date string as DD-Mon-YY (e.g. "09-Apr-26").
 * @param {string} s - ISO date string
 * @returns {string} Formatted date or dash if invalid
 */
function _hrmsFmtDate(s){
  if(!s) return '—';
  var d=new Date(s.length===10?s+'T00:00:00':s);
  if(isNaN(d.getTime())) return s;
  return String(d.getDate()).padStart(2,'0')+'-'+_MON3[d.getMonth()+1]+'-'+String(d.getFullYear()).slice(-2);
}

/**
 * Determine the day type (WD/WO/holiday) for a given date and plant.
 * @param {string} monthKey - Month key in YYYY-MM format
 * @param {number} day - Day of month
 * @param {number} yr - Year
 * @param {number} mo - Month (1-12)
 * @param {string} plant - Plant identifier
 * @returns {string} Day type code (e.g. "WD", "WO")
 */
function _hrmsGetDayType(monthKey,day,yr,mo,plant){
  var key=String(day);
  if(plant){
    var rec=(DB.hrmsDayTypes||[]).find(function(r){return r.monthKey===monthKey&&r.plant===plant;});
    if(rec&&rec.dayTypes&&rec.dayTypes[key]) return rec.dayTypes[key];
  }
  var d=new Date(yr,mo-1,day);
  return d.getDay()===0?'WO':'WD';
}

// ═══ TIME PARSING & ROUNDING ═══

/**
 * Parse a time string (HH:MM or HH:MM:SS with optional AM/PM) to minutes since midnight.
 * @param {string} t - Time string
 * @returns {number|null} Minutes since midnight, or null if invalid
 */
function _hrmsParseTime(t){
  if(!t)return null;
  t=t.toString().trim();
  var m=t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if(!m)return null;
  var hr=+m[1],min=+m[2];
  if(m[4]){
    var ap=m[4].toUpperCase();
    if(ap==='PM'&&hr<12) hr+=12;
    if(ap==='AM'&&hr===12) hr=0;
  }
  return hr*60+min;
}

/**
 * Convert minutes since midnight to HH:MM string.
 * @param {number} mins - Minutes since midnight
 * @returns {string} Formatted time string or empty if null
 */
function _hrmsMinToTime(mins){
  if(mins===null||mins===undefined)return'';
  var h=Math.floor(mins/60),m=mins%60;
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}

/**
 * Round IN-punch time to nearest shift boundary or 15-minute interval.
 * @param {number|null} mins - Minutes since midnight
 * @returns {number|null} Rounded minutes or null
 */
// Rounding rules for IN time
function _hrmsRoundIn(mins){
  if(mins===null)return null;
  // 7:40-8:10 → 8:00
  if(mins>=460&&mins<=490) return 480;
  // 8:40-9:10 → 9:00
  if(mins>=520&&mins<=550) return 540;
  // 18:40-19:10 → 19:00
  if(mins>=1120&&mins<=1150) return 1140;
  // Default: round to nearest 15 min
  return Math.round(mins/15)*15;
}

/**
 * Round OUT-punch time to nearest shift boundary or 15-minute interval.
 * @param {number|null} mins - Minutes since midnight
 * @returns {number|null} Rounded minutes or null
 */
// Rounding rules for OUT time
function _hrmsRoundOut(mins){
  if(mins===null)return null;
  // 8:00-8:20 → 8:00
  if(mins>=480&&mins<=500) return 480;
  // 16:30-16:50 → 16:30
  if(mins>=990&&mins<=1010) return 990;
  // 18:00-18:20 → 18:00
  if(mins>=1080&&mins<=1100) return 1080;
  // 19:00-19:20 → 19:00
  if(mins>=1140&&mins<=1160) return 1140;
  // Default: round to nearest 15 min
  return Math.round(mins/15)*15;
}

// ═══ OT FORMATTING ═══

/**
 * Format OT hours preserving 0.25 hr precision.
 * 3.75 → "3.75", 3.5 → "3.5", 3 → "3", 8.25 → "8.25".
 * @param {number} v - OT hours value
 * @returns {string} Formatted string without trailing zeros
 */
function _hrmsFmtOT(v){
  if(!v) return '0';
  // Round to nearest 0.25 first to clean up floating-point noise (e.g. 3.7499999)
  var r=Math.round(v*4)/4;
  // Then format with up to 2 decimals, drop trailing zeros
  return r.toFixed(2).replace(/\.?0+$/,'');
}

// ═══ PRINT / PDF HELPERS ═══

/**
 * Get the list of available HRMS print formats from the database.
 * @returns {Array<Object>} Array of print format objects
 */
function _hrmsGetPrintFormats(){
  return DB.hrmsPrintFormats||[];
}

/**
 * Build a jsPDF-autoTable column styles object from an array of widths.
 * @param {Array<number>} widths - Column widths
 * @returns {Object} Column styles keyed by column index
 */
function _hrmsColStyles(widths){
  var s={};
  for(var i=0;i<widths.length;i++) s[i]={cellWidth:widths[i]};
  return s;
}

/**
 * Convert a hex color string to an RGB array.
 * @param {string} hex - Hex color (e.g. "#e2e8f0" or "e2e8f0")
 * @returns {Array<number>} [r, g, b] values 0-255
 */
function _hexToRgb(hex){
  hex=(hex||'#e2e8f0').replace('#','');
  if(hex.length===3) hex=hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  return[parseInt(hex.substring(0,2),16),parseInt(hex.substring(2,4),16),parseInt(hex.substring(4,6),16)];
}

// ═══ TRANSPORT ALLOWANCE ═══

/**
 * Calculate pro-rated Transport Allowance for the month.
 * Formula: (TA rate / Working Days) × Present Days
 * @param {number} taRate - Monthly transport allowance rate
 * @param {number} wd - Total working days in the month
 * @param {number} pDays - Number of days the employee was present
 * @returns {number} Pro-rated transport allowance (rounded to nearest rupee)
 */
function _hrmsCalcTA(taRate, wd, pDays) {
  if (!taRate || !wd || wd <= 0) return 0;
  return Math.round((taRate / wd) * (pDays || 0));
}

// ═══ STATUTORY — PT CALCULATION ═══

/**
 * Calculate Professional Tax based on gross salary, gender, and month.
 * @param {number} gross - Gross salary amount
 * @param {string} gender - "Male" or "Female"
 * @param {string} month - Month identifier for month-specific rules
 * @returns {number} PT amount (0 if exempt or no matching rule)
 */
// PT calc: rules evaluated top-to-bottom, first match wins
function _hrmsCalcPT(gross,gender,month){
  var rules=_hrmsStatutory.ptRules||[];
  var mo=(month||'').toLowerCase();
  var gen=(gender||'').toLowerCase();
  // Pass 1: gender-specific rules (highest priority — e.g. women exemption)
  for(var i=0;i<rules.length;i++){
    var r=rules[i];
    if(!r.gender) continue;
    if(r.gender.toLowerCase()!==gen) continue;
    if(r.month&&r.month.toLowerCase()!==mo) continue;
    var match=false;
    if(r.op==='lt') match=gross<r.threshold;
    else if(r.op==='gte') match=gross>=r.threshold;
    if(match) return r.amount;
  }
  // Pass 2: month-specific rules (e.g. Feb surcharge)
  for(var i=0;i<rules.length;i++){
    var r=rules[i];
    if(r.gender) continue;
    if(!r.month) continue;
    if(r.month.toLowerCase()!==mo) continue;
    var match=false;
    if(r.op==='lt') match=gross<r.threshold;
    else if(r.op==='gte') match=gross>=r.threshold;
    if(match) return r.amount;
  }
  // Pass 3: generic rules
  for(var i=0;i<rules.length;i++){
    var r=rules[i];
    if(r.gender||r.month) continue;
    var match=false;
    if(r.op==='lt') match=gross<r.threshold;
    else if(r.op==='gte') match=gross>=r.threshold;
    if(match) return r.amount;
  }
  return 0;
}

// ═══ BALANCE HELPERS ═══

/**
 * Get PL/advance balance for an employee in a given month.
 * @param {Object} emp - Employee record
 * @param {string} monthKey - Month key in YYYY-MM format
 * @returns {Object} Balance object with plOB, plCB, advOB, advCB
 */
function _hrmsGetBal(emp,monthKey){
  var ex=emp.extra||{};var bal=ex.bal||{};
  return bal[monthKey]||{plOB:0,plCB:0,advOB:0,advCB:0};
}

/**
 * Get the previous month key from a YYYY-MM string.
 * @param {string} mk - Month key in YYYY-MM format
 * @returns {string} Previous month in YYYY-MM format
 */
function _hrmsGetPrevMonth(mk){
  var p=mk.split('-');var yr=+p[0],mo=+p[1];
  mo--;if(mo<1){mo=12;yr--;}
  return yr+'-'+String(mo).padStart(2,'0');
}

/**
 * Get opening balances (PL and advance) for an employee in a given month.
 * @param {Object} emp - Employee record
 * @param {string} mk - Month key in YYYY-MM format
 * @returns {Object} Opening balances {plOB, advOB}
 */
function _hrmsGetEmpOB(emp,mk){
  // For Jan 2026 use imported OB, else use previous month's CB
  if(mk==='2026-01'){
    var ex=emp.extra||{};
    return {plOB:+(ex.plOB||0).toFixed(2),advOB:Math.round(ex.advOB||0)};
  }
  var prev=_hrmsGetPrevMonth(mk);
  var prevBal=_hrmsGetBal(emp,prev);
  return {plOB:+(prevBal.plCB||0).toFixed(2),advOB:Math.round(prevBal.advCB||0)};
}

// ═══ PAID LEAVE ALLOCATION (FY April–March) ═══

/**
 * Calculate the confirmation date (1 day before completing 3 months from DOJ).
 * @param {Object} emp - Employee record with dateOfJoining
 * @returns {Date|null} Confirmation date or null if no DOJ
 */
// Confirmation date = 1 day prior to completing 3 calendar months from joining
// e.g. DOJ 8-Sep-25 → 8-Dec-25 - 1 day = 7-Dec-25
function _hrmsGetConfirmationDate(emp){
  var doj=emp.dateOfJoining;
  if(!doj) return null;
  var d=new Date(doj.length===10?doj+'T00:00:00':doj);
  if(isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth()+3);
  d.setDate(d.getDate()-1);
  return d;
}

/**
 * Calculate months since confirmation, rounded to nearest 0.5 (MROUND).
 * @param {Object} emp - Employee record
 * @param {number} yr - Salary year
 * @param {number} mo - Salary month (1-12)
 * @returns {number} Months since confirmation or -1 if not yet confirmed
 */
// Months since confirmation: fractional based on day, rounded to nearest 0.5 (MROUND 0.5)
// e.g. conf 9-Dec-25, salary Jan-26: whole=1, frac=23/31=0.74 → total=1.74 → mround=1.5
function _hrmsMonthsSinceConfirmation(emp,yr,mo){
  var conf=_hrmsGetConfirmationDate(emp);
  if(!conf) return -1;
  // Last day of salary month
  var salEnd=new Date(yr,mo,0);// e.g. Jan-26 → 31-Jan-2026
  if(salEnd<conf) return -1;
  // Count whole calendar months: conf date to same date of next month = 1 month
  // e.g. 24-Sep to 24-Oct = 1 month, 24-Oct to 24-Nov = 2 months
  var wholeMonths=(salEnd.getFullYear()-conf.getFullYear())*12+(salEnd.getMonth()-conf.getMonth());
  // If salEnd day < conf day, we haven't completed the current month
  if(salEnd.getDate()<conf.getDate()) wholeMonths--;
  // Fraction: remaining days after last whole month boundary
  var lastBoundary=new Date(conf.getFullYear(),conf.getMonth()+wholeMonths,conf.getDate());
  var nextBoundary=new Date(conf.getFullYear(),conf.getMonth()+wholeMonths+1,conf.getDate());
  var daysInPeriod=(nextBoundary.getTime()-lastBoundary.getTime())/(1000*60*60*24);
  var daysElapsed=(salEnd.getTime()-lastBoundary.getTime())/(1000*60*60*24);
  var frac=daysInPeriod>0?daysElapsed/daysInPeriod:0;
  var total=wholeMonths+frac;
  return Math.round(total*2)/2;// MROUND to nearest 0.5
}

/**
 * Get the FY start year for a given month (April-March financial year).
 * @param {number} yr - Year
 * @param {number} mo - Month (1-12)
 * @returns {number} FY start year
 */
// FY start year for a given month (Apr-Mar FY)
function _hrmsFYStart(yr,mo){ return mo>=4?yr:yr-1; }

/**
 * Calculate monthly PL accrual for an employee in a given salary month.
 * @param {Object} emp - Employee record
 * @param {number} yr - Salary year
 * @param {number} mo - Salary month (1-12)
 * @returns {number} PL days accrued this month
 */
// Calculate monthly PL accrual for this salary month
function _hrmsCalcPLGiven(emp,yr,mo){
  var conf=_hrmsGetConfirmationDate(emp);
  if(!conf) return 0;
  // PL eligibility starts month AFTER confirmation
  var eligYr=conf.getFullYear(),eligMo=conf.getMonth()+2;// +1 for 0-based, +1 for month after
  if(eligMo>12){eligMo-=12;eligYr++;}
  // Not eligible yet this month
  if(yr<eligYr||(yr===eligYr&&mo<eligMo)) return 0;

  var s=_hrmsStatutory;
  var isStaff=(emp.category||'').toLowerCase()==='staff';
  var monthsSinceConf=_hrmsMonthsSinceConfirmation(emp,yr,mo);

  var seniorThreshold=s.plSeniorMonths||60;
  if(isStaff&&monthsSinceConf>=seniorThreshold){
    // Senior staff: 18 PL given in the month they hit 60 months, then 0 monthly
    // Check if this is the exact month they crossed the threshold
    var prevMonthsSince=_hrmsMonthsSinceConfirmation(emp,mo===1?yr-1:yr,mo===1?12:mo-1);
    if(prevMonthsSince<seniorThreshold) return s.plStaffSenior||18;// crossing month
    return 0;// already crossed in a previous month
  }
  return isStaff?(s.plStaffJunior||1.5):(s.plWorker||1.5);
}

/**
 * Calculate cumulative PL available from FY start through a given salary month.
 * @param {Object} emp - Employee record
 * @param {number} yr - Salary year
 * @param {number} mo - Salary month (1-12)
 * @returns {number} Cumulative PL days available
 */
// Cumulative PL earned from FY start (or confirmation) through salary month
// FY is April–March. PL accrual starts from month AFTER confirmation or FY April, whichever is later.
// Example: confirmed before Apr 2025, salary Jan 2026 → 10 months × 1.5 = 15
// Example: confirmed Oct 2025, salary Jan 2026 → 3 months (Nov,Dec,Jan) × 1.5 = 4.5
function _hrmsCumPLAvail(emp,yr,mo){
  var conf=_hrmsGetConfirmationDate(emp);
  if(!conf) return 0;
  // Month after confirmation (eligibility start)
  var eligYr=conf.getFullYear(),eligMo=conf.getMonth()+2;
  if(eligMo>12){eligMo-=12;eligYr++;}
  // FY start (April)
  var fyYr=_hrmsFYStart(yr,mo);
  var fyStart=fyYr*12+4;// April of FY
  var eligStart=eligYr*12+eligMo;
  var effectiveStart=Math.max(fyStart,eligStart);
  var current=yr*12+mo;
  if(current<effectiveStart) return 0;

  var s=_hrmsStatutory;
  var isStaff=(emp.category||'').toLowerCase()==='staff';
  var monthsSinceConf=_hrmsMonthsSinceConfirmation(emp,yr,mo);
  var seniorThreshold=s.plSeniorMonths||60;

  if(isStaff&&monthsSinceConf>=seniorThreshold){
    // Senior staff: 18 PL for the year (from the month they crossed 60)
    return s.plStaffSenior||18;
  }
  // Monthly accrual: count eligible months × rate
  var months=current-effectiveStart+1;// inclusive
  var rate=isStaff?(s.plStaffJunior||1.5):(s.plWorker||1.5);
  return months*rate;
}
