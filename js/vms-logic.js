/** @file VMS pure logic functions — segment workflow, reports, trip ID generation. @depends common.js */

/*  vms-logic.js — Pure logic functions extracted from vms.js (now vms-ui.js)
 *  No DOM access — safe to unit-test without a browser.
 *  Depends on: common.js globals (DB, CU, byId, ltype, getUserLocation, lname, lnameText, vnum, vt, tripsForMyPlant, colourContrast)
 */

// ═══ CONFIG / CONSTANTS ═════════════════════════════════════════════════════

// Supabase column selections — exclude large photo columns to reduce egress
var _SYNC_SELECT={
  'vms_trips':'id,code,booked_by,plant,date,start_loc,dest1,dest2,dest3,driver_id,vehicle_id,vehicle_type_id,actual_vehicle_type_id,vendor,description,trip_cat_id,challans1,challan1,weight1,challans2,challan2,weight2,challans3,challan3,weight3,edited_by,edited_at,cancelled,updated_at',
  'vms_segments':'id,code,trip_id,label,s_loc,d_loc,criteria,trip_cat_id,steps_light,status,date,current_step,updated_at',
  'vms_spot_trips':'id,code,vehicle_num,supplier,challan,driver_name,driver_mobile,entry_remarks,date,entry_time,entry_by,location,exit_time,exit_by,exit_remarks,updated_at'
};

// Date filtering: only fetch recent data, load history on-demand
var _DATE_FILTER_DAYS=31; // last 1 calendar month

// Supabase table name → date column name
var _DATE_FILTER_COL={
  'vms_trips':'date',
  'vms_segments':'date',
  'vms_spot_trips':'date'
};

// ═══ UTILITY FUNCTIONS ══════════════════════════════════════════════════════

/**
 * Return list of table names that have been fully loaded.
 * @returns {string[]} Array of loaded table name strings
 */
function _getLoadedTables(){return Object.keys(_loadedTables).filter(function(t){return _loadedTables[t];});}

/**
 * Strip base64 photos from segment steps JSON to reduce memory after fetch.
 * @param {Object[]} segments - Array of segment objects with steps property
 * @returns {void}
 */
// Strip base64 photos from segment steps JSON to reduce memory after fetch
function _stripStepPhotos(segments){
  (segments||[]).forEach(function(seg){
    if(seg.steps&&typeof seg.steps==='object'){
      Object.keys(seg.steps).forEach(function(k){
        if(seg.steps[k]&&seg.steps[k].photo) seg.steps[k].photo='__deferred__';
      });
    }
  });
}

// _dateCutoff, _syncSelect, _applyDateFilter are in common.js

/**
 * Merge fetched rows into the local DB table, preserving photo fields.
 * @param {string} localTbl - Name of the local DB table
 * @param {Object[]} newParsed - Array of newly fetched/parsed row objects
 * @param {boolean} replace - If true, replace entire table; if false, upsert by id
 * @returns {void}
 */
function _syncMergeRows(localTbl,newParsed,replace){
  var pf=_PHOTO_PRESERVE[localTbl]||[];
  var existing=DB[localTbl]||[];
  if(replace){
    if(pf.length>0){
      var oldMap={};existing.forEach(function(r){oldMap[r.id]=r;});
      newParsed.forEach(function(rec){var old=oldMap[rec.id];if(old)pf.forEach(function(f){if(old[f]&&!rec[f])rec[f]=old[f];});});
    }
    DB[localTbl]=newParsed;
  } else {
    var idMap={};for(var i=0;i<existing.length;i++)idMap[existing[i].id]=i;
    newParsed.forEach(function(rec){
      var idx=idMap[rec.id];
      if(idx!==undefined){pf.forEach(function(f){if(existing[idx][f]&&!rec[f])rec[f]=existing[idx][f];});existing[idx]=rec;}
      else existing.push(rec);
    });
    DB[localTbl]=existing;
  }
}

// ═══ PASSWORD VALIDATION ════════════════════════════════════════════════════

// _isStrongPwd is in common.js

// ═══ SEGMENT WORKFLOW ═══════════════════════════════════════════════════════

/**
 * Determine the criteria code based on source and destination location types.
 * @param {string} st - Source location type ('KAP' or 'External')
 * @param {string} dt - Destination location type ('KAP' or 'External')
 * @returns {number} Criteria code: 1 (KAP→KAP), 2 (KAP→Ext), 3 (Ext→KAP), 4 (Ext→Ext)
 */
function getCriteria(st,dt){
  if(st==='KAP'&&dt==='KAP') return 1;
  if(st==='KAP'&&dt==='External') return 2;
  if(st==='External'&&dt==='KAP') return 3;
  return 4;
}

/**
 * Build the trip category ID string from segment label and location types.
 * @param {string} label - Segment label ('A', 'B', or 'C')
 * @param {string} st - Source location type ('KAP' or 'External')
 * @param {string} dt - Destination location type ('KAP' or 'External')
 * @returns {string} Trip category ID (e.g. 'AKK', 'BKE')
 */
function getTripCatId(label,st,dt){
  return label+(st==='KAP'?'K':'E')+(dt==='KAP'?'K':'E');
}

/**
 * Build a full segment object with steps, skip flags, and assigned users.
 * @param {string} tripId - Parent trip ID
 * @param {string} label - Segment label ('A', 'B', or 'C')
 * @param {string} sLoc - Source location ID
 * @param {string} dLoc - Destination location ID
 * @returns {Object} Fully constructed segment object with steps 1-5
 */
function buildSegment(tripId,label,sLoc,dLoc){
  const st=ltype(sLoc), dt=ltype(dLoc);
  const c=getCriteria(st,dt);
  const catId=getTripCatId(label,st,dt);
  const sl=byId(DB.locations,sLoc);
  const dl=byId(DB.locations,dLoc);

  // Get booking user's location for Ext→Ext fallback
  const trip=byId(DB.trips,tripId);
  const bookingUser=trip?byId(DB.users,trip.bookedBy):CU;
  const bookingLoc=bookingUser?(getUserLocation(bookingUser.id)||byId(DB.locations,bookingUser.plant)):null;

  // Helper: get location's role users
  const locUsers=(loc,role)=>{
    if(!loc) return [];
    if(role==='KAP Security') return loc.kapSec?[loc.kapSec]:[];
    if(role==='Material Receiver') return loc.matRecv||[];
    if(role==='Trip Approver') return loc.approvers||[];
    return [];
  };

  // Determine owner location for each step
  let s1Loc, s2Loc, s3Loc, s4Loc;
  let s1Skip=false, s2Skip=false;

  if(c===1){ // KAP→KAP
    s1Loc=sl; s2Loc=dl; s3Loc=dl; s4Loc=sl;
  } else if(c===2){ // KAP→External
    s1Loc=sl; s2Skip=true; s3Loc=sl; s4Loc=sl;
  } else if(c===3){ // External→KAP
    s1Skip=true; s2Loc=dl; s3Loc=dl; s4Loc=bookingLoc;
  } else { // External→External
    s1Skip=true; s2Skip=true; s3Loc=bookingLoc; s4Loc=bookingLoc;
  }

  // Step 3 (Material Receipt) is skipped when destination is External — no KAP to receive at
  const s3Skip=(dt==='External');

  // Step 5: Empty Vehicle Exit — only on LAST segment when destination is KAP
  const isLastSeg=(label==='A'&&!trip?.dest2)||(label==='B'&&!trip?.dest3)||label==='C';
  const s5Active=isLastSeg&&dt==='KAP';

  const steps={
    1:{skip:s1Skip, users:s1Skip?[]:locUsers(s1Loc,'KAP Security'), label:'Gate Exit', loc:s1Skip?null:sLoc, ownerLoc:s1Skip?null:sLoc, role:'KAP Security', done:false, time:null, by:null},
    2:{skip:s2Skip, users:s2Skip?[]:locUsers(s2Loc,'KAP Security'), label:'Gate Entry', loc:s2Skip?null:dLoc, ownerLoc:s2Skip?null:dLoc, role:'KAP Security', done:false, time:null, by:null},
    3:{skip:s3Skip, users:s3Skip?[]:locUsers(s3Loc,'Material Receiver'), label:'Material Receipt', loc:s3Skip?null:(s3Loc?.id||null), ownerLoc:s3Skip?null:(s3Loc?.id||null), role:'Material Receiver', done:false, time:null, by:null},
    4:{skip:false, users:locUsers(s4Loc,'Trip Approver'), label:'Approve', loc:s4Loc?.id||null, ownerLoc:s4Loc?.id||null, role:'Trip Approver', done:false, time:null, by:null, rejected:false, remarks:''},
    5:{skip:!s5Active, users:s5Active?locUsers(dl,'KAP Security'):[], label:'Empty Vehicle Exit', loc:s5Active?dLoc:null, ownerLoc:s5Active?dLoc:null, role:'KAP Security', done:false, time:null, by:null},
  };

  const seg={id:tripId+label, tripId, label, sLoc, dLoc, criteria:c, tripCatId:catId, steps, status:'Active', date:new Date().toISOString()};
  seg.currentStep=nextStep(seg);
  return seg;
}

/**
 * Determine the next active step in a segment workflow.
 * @param {Object} seg - Segment object with steps property
 * @returns {number} Next step number (1-5), or 6 if all done
 */
function nextStep(seg){
  // Steps 1 & 2: sequential gate operations
  if(!seg.steps[1]?.done&&!seg.steps[1]?.skip) return 1;
  if(!seg.steps[2]?.done&&!seg.steps[2]?.skip) return 2;
  // Once gate ops done: Step 5 (Empty Vehicle Exit) is next KAP priority — runs in parallel with 3 & 4
  if(seg.steps[5]&&!seg.steps[5].skip&&!seg.steps[5].done) return 5;
  // Steps 3 & 4: background MR & Approval (also run in parallel with step 5)
  if(!seg.steps[3]?.done&&!seg.steps[3]?.skip) return 3;
  if(!seg.steps[4]?.done&&!seg.steps[4]?.skip) return 4;
  return 6; // all steps done
}

/**
 * Check whether all non-skipped steps in a segment are complete.
 * @param {Object} seg - Segment object with steps property
 * @returns {boolean} True if every non-skipped step is done
 */
function allStepsDone(seg){
  // True when ALL non-skipped steps (including step 5) are done
  for(let s=1;s<=5;s++){const st=seg.steps[s];if(st&&!st.skip&&!st.done)return false;}
  return true;
}

/**
 * Check whether steps 1 and 2 are each done or skipped.
 * @param {Object} seg - Segment object with steps property
 * @returns {boolean} True if both gate steps are complete or skipped
 */
function stepsOneAndTwoDone(seg){
  // Returns true when Steps 1 & 2 are each either done or skipped
  return [1,2].every(s=>seg.steps[s]?.done||seg.steps[s]?.skip);
}

/**
 * Check whether steps 1, 2, and 3 are each done or skipped.
 * @param {Object} seg - Segment object with steps property
 * @returns {boolean} True if gate steps and material receipt are complete or skipped
 */
function stepsUpTo3Done(seg){
  // Returns true when Steps 1, 2 & 3 are each either done or skipped
  return [1,2,3].every(s=>seg.steps[s]?.done||seg.steps[s]?.skip);
}

/**
 * Recalculate undone step properties for a segment using current DB state.
 * @param {Object} seg - Segment object to recalculate
 * @param {Object[]} [siblingSegs] - Optional array of sibling segments for the same trip
 * @returns {boolean} True if any property was changed
 */
// Recalculate undone step properties for a segment.
// Reads the full trip route AND sibling segments to determine isLastSeg correctly.
// Recomputes skip, loc, ownerLoc, users for every undone step.
// Also updates criteria, tripCatId, currentStep, status.
// Returns true if anything changed.
function recalcSegSteps(seg, siblingSegs){
  const trip=byId(DB.trips,seg.tripId);
  if(!trip||seg.status==='Cancelled') return false;
  const sLoc=seg.sLoc,dLoc=seg.dLoc;
  const stype=ltype(sLoc),dtype=ltype(dLoc);
  const crit=getCriteria(stype,dtype);
  const sl=byId(DB.locations,sLoc);
  const dl=byId(DB.locations,dLoc);
  const bookingUser=byId(DB.users,trip.bookedBy)||CU;
  const bookingLoc=bookingUser?(getUserLocation(bookingUser.id)||byId(DB.locations,bookingUser.plant)):null;
  const locUsr=(loc,role)=>{
    if(!loc) return [];
    if(role==='KAP Security') return loc.kapSec?[loc.kapSec]:[];
    if(role==='Material Receiver') return loc.matRecv||[];
    if(role==='Trip Approver') return loc.approvers||[];
    return [];
  };
  let s1Loc,s2Loc,s3Loc,s4Loc,s1Skip=false,s2Skip=false;
  if(crit===1){s1Loc=sl;s2Loc=dl;s3Loc=dl;s4Loc=sl;}
  else if(crit===2){s1Loc=sl;s2Skip=true;s3Loc=sl;s4Loc=sl;}
  else if(crit===3){s1Skip=true;s2Loc=dl;s3Loc=dl;s4Loc=bookingLoc;}
  else{s1Skip=true;s2Skip=true;s3Loc=bookingLoc;s4Loc=bookingLoc;}
  const s3Skip=(dtype==='External');
  // isLastSeg: use BOTH trip.dest fields AND sibling segments to cross-check
  // A segment is "last" if no later label (B or C) exists among sibling segments of the same trip
  const allSegsForTrip=siblingSegs||DB.segments.filter(s=>s.tripId===seg.tripId);
  const hasSegB=allSegsForTrip.some(s=>s.label==='B');
  const hasSegC=allSegsForTrip.some(s=>s.label==='C');
  // Also cross-check with trip destinations
  const tripHasDest2=!!(trip.dest2&&trip.dest2!=='');
  const tripHasDest3=!!(trip.dest3&&trip.dest3!=='');
  // A is last only if no B exists AND trip has no dest2
  const aIsLast=seg.label==='A'&&!hasSegB&&!tripHasDest2;
  // B is last only if no C exists AND trip has no dest3
  const bIsLast=seg.label==='B'&&!hasSegC&&!tripHasDest3;
  const cIsLast=seg.label==='C';
  const isLastSeg=aIsLast||bIsLast||cIsLast;
  const s5Active=isLastSeg&&dtype==='KAP';
  let changed=false;
  const patch=(n,props)=>{
    const step=seg.steps[n];
    if(!step||step.done) return;
    Object.keys(props).forEach(k=>{
      if(JSON.stringify(step[k])!==JSON.stringify(props[k])){step[k]=props[k];changed=true;}
    });
  };
  patch(1,{skip:s1Skip,loc:s1Skip?null:sLoc,ownerLoc:s1Skip?null:sLoc,users:s1Skip?[]:locUsr(s1Loc,'KAP Security')});
  patch(2,{skip:s2Skip,loc:s2Skip?null:dLoc,ownerLoc:s2Skip?null:dLoc,users:s2Skip?[]:locUsr(s2Loc,'KAP Security')});
  patch(3,{skip:s3Skip,loc:s3Skip?null:(s3Loc?.id||null),ownerLoc:s3Skip?null:(s3Loc?.id||null),users:s3Skip?[]:locUsr(s3Loc,'Material Receiver')});
  patch(4,{loc:s4Loc?.id||null,ownerLoc:s4Loc?.id||null,users:locUsr(s4Loc,'Trip Approver')});
  // Step 5: create it if missing (trips booked before step 5 was introduced have no steps[5])
  if(!seg.steps[5]){
    seg.steps[5]={skip:!s5Active,label:'Empty Vehicle Exit',role:'KAP Security',done:false,time:null,by:null,
      loc:s5Active?dLoc:null,ownerLoc:s5Active?dLoc:null,users:s5Active?locUsr(dl,'KAP Security'):[]};
    changed=true;
  } else {
    patch(5,{skip:!s5Active,loc:s5Active?dLoc:null,ownerLoc:s5Active?dLoc:null,users:s5Active?locUsr(dl,'KAP Security'):[]});
  }
  const newCatId=getTripCatId(seg.label,stype,dtype);
  if(seg.criteria!==crit){seg.criteria=crit;changed=true;}
  if(seg.tripCatId!==newCatId){seg.tripCatId=newCatId;changed=true;}
  const newStep=nextStep(seg);
  if(seg.currentStep!==newStep){seg.currentStep=newStep;changed=true;}
  if(seg.status!=='Completed'&&seg.status!=='Rejected'&&allStepsDone(seg)){seg.status='Completed';changed=true;}
  return changed;
}

// ═══ DASHBOARD ══════════════════════════════════════════════════════════════

/**
 * Compute the overall status of a trip from its child segments.
 * @param {Object} trip - Trip object with id and cancelled properties
 * @returns {string} One of 'Cancelled', 'Completed', 'Rejected', or 'Active'
 */
function tripOverallStatus(trip){
  if(trip.cancelled) return 'Cancelled';
  const segs=DB.segments.filter(s=>s.tripId===trip.id);
  if(!segs.length) return 'Active';
  if(segs.every(s=>s.status==='Completed')) return 'Completed';
  if(segs.some(s=>s.status==='Rejected')) return 'Rejected';
  return 'Active';
}

// ═══ REPORTS ════════════════════════════════════════════════════════════════

/**
 * Fetch filtered segment data for the report view using date range inputs.
 * @returns {{segs: Object[], canSeeAmt: boolean}} Filtered segments and amount visibility flag
 */
function getReportData(){
  const fromVal=document.getElementById('rptFrom')?.value||'';
  const toVal=document.getElementById('rptTo')?.value||'';
  const canSeeAmt=CU.roles.some(r=>['Super Admin','Admin','Trip Approver'].includes(r));
  // Show segments for trips visible to current user (plant-based)
  const myTrips=new Set(tripsForMyPlant().map(t=>t.id));
  let segs=DB.segments.filter(s=>myTrips.has(s.tripId));
  if(fromVal)segs=segs.filter(s=>(s.date||'').slice(0,10)>=fromVal);
  if(toVal)segs=segs.filter(s=>(s.date||'').slice(0,10)<=toVal);

  segs.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  return {segs,canSeeAmt};
}

/**
 * Build an enriched display-ready row object for a single segment.
 * @param {Object} s - Segment object from DB.segments
 * @returns {Object} Row object with formatted fields for report rendering
 */
// Build enriched row data for a segment
function rptRow(s){
  const t=byId(DB.trips,s.tripId)||byId(DB.trips,s.tripId.replace(/-R\d+$/,''));
  const v=byId(DB.vehicles,t?.vehicleId);
  const vnd=byId(DB.vendors,v?.vendorId);
  const drv=byId(DB.drivers,t?.driverId);
  const recVt=byId(DB.vehicleTypes,t?.vehicleTypeId);          // recommended type
  const actVt=byId(DB.vehicleTypes,byId(DB.vehicleTypes,t?.actualVehicleTypeId)?.id?t?.actualVehicleTypeId:v?.typeId);  // actual used type
  const fmtTime=ts=>ts?new Date(ts).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'2-digit',hour:'2-digit',minute:'2-digit',hour12:true}):'—';
  const stepNames={1:'Gate Exit',2:'Gate Entry',3:'Mat. Receipt',4:'Trip Approval',5:'Empty Vehicle Exit'};
  const status=s.status==='Completed'?'✓ Done':s.status==='Rejected'?'⚠ Rejected':s.status==='Locked'?'🔒 Locked':stepNames[s.currentStep]||'Step '+s.currentStep;
  const stClr=s.status==='Completed'?'#16a34a':s.status==='Rejected'?'#dc2626':'var(--accent)';
  const bookedByU=byId(DB.users,t?.bookedBy);
  const editedByU=byId(DB.users,t?.editedBy);
  const mrByU=byId(DB.users,s.steps[3]?.by);
  const apByU=byId(DB.users,s.steps[4]?.by);
  return {
    seg:s,trip:t,
    segId:s.tripId.replace(/-R\d+$/,''),
    date:s.date||'-',
    route:lnameText(s.sLoc)+' to '+lnameText(s.dLoc),
    routeHtml:lname(s.sLoc)+' to '+lname(s.dLoc),
    vehicleNo:vnum(t?.vehicleId),
    vehicleType:recVt?.name||vt?.name||'-',
    recVehicleType:recVt?.name||'-',
    actVehicleType:(actVt?.name&&actVt?.name!==(recVt?.name||''))?actVt.name:'-',
    vendor:vnd?.name||t?.vendor||'-',
    driver:drv?.name||'-',
    gateExitTime:fmtTime(s.steps[1]?.time),
    gateEntryTime:fmtTime(s.steps[2]?.time),
    mrBy:mrByU?.fullName||mrByU?.name||'-',
    mrTime:fmtTime(s.steps[3]?.time),
    mrDiscrepancy:s.steps[3]?.discrepancy?'Yes':'',
    mrRemarks:s.steps[3]?.remarks||'',
    approvedBy:apByU?.fullName||apByU?.name||'-',
    approvedTime:fmtTime(s.steps[4]?.time),
    bookedBy:bookedByU?.fullName||bookedByU?.name||'-',
    bookedTime:fmtTime(t?.date),
    editedBy:editedByU?.fullName||editedByU?.name||'-',
    editedTime:t?.editedAt?fmtTime(t.editedAt):'',
    startTime:fmtTime(s.steps[1]?.time),
    endTime:fmtTime(s.steps[4]?.time),
    status:status,stClr:stClr,
    vendorId:v?.vendorId||'',
    typeId:v?.typeId||'',
    vehicleId:t?.vehicleId||''
  };
}

// ═══ TRIP ID GENERATION ═════════════════════════════════════════════════════

/**
 * Generate a new unique trip ID from location, date, and plant code.
 * @param {string} startLocId - Start location ID
 * @param {string} dest1LocId - First destination location ID
 * @param {string} [excludeId] - Trip ID to exclude from serial counter (for edits)
 * @returns {string} Generated trip ID (e.g. '5P2-14')
 */
// Generate new Trip ID: LastDigitYear + MonthLetter + DD + Plant + Serial
function genTripId(startLocId, dest1LocId, excludeId){
  const now=new Date();
  const yLast=String(now.getFullYear()).slice(-1);
  // Determine which location supplies the plant code:
  //   KAP→*        → start location
  //   External→KAP → dest1 location
  //   External→External → booking user's plant (CU.plant)
  const _locPlantCode=id=>{
    const l=byId(DB.locations,id);
    const digits=(l?.name||'').replace(/[^0-9]/g,'');
    return digits?'P'+digits:'P0';
  };
  const sType=(byId(DB.locations,startLocId)||{}).type||'External';
  const dType=(byId(DB.locations,dest1LocId)||{}).type||'External';
  let plantCode;
  if(sType==='KAP'){
    plantCode=_locPlantCode(startLocId);          // KAP→any: use start loc
  } else if(dType==='KAP'){
    plantCode=_locPlantCode(dest1LocId);          // External→KAP: use dest loc
  } else {
    plantCode=_locPlantCode(CU.plant);            // External→External: user's plant
  }
  const prefix=`${yLast}${plantCode}-`;
  // Serial: find the highest existing number with this prefix and add 1.
  // Exclude the current trip being edited so its number doesn't bump the counter.
  const existingNums=DB.trips
    .filter(t=>t.id.startsWith(prefix)&&t.id!==excludeId)
    .map(t=>parseInt(t.id.slice(prefix.length),10)||0);
  const maxNum=existingNums.length?Math.max(...existingNums):0;
  return `${prefix}${maxNum+1}`;
}

/**
 * Extract the plant prefix from an existing trip ID.
 * @param {string} tripId - Trip ID string (e.g. '5P2-14')
 * @returns {string} Prefix portion (e.g. '5P2-') or empty string
 */
// Extract the plant prefix from an existing trip ID (e.g. "5P2-" from "5P2-14")
function _tripIdPrefix(tripId){
  if(!tripId) return '';
  const m=tripId.match(/^(\d+P\d+-)/);
  return m?m[1]:'';
}

/**
 * Format a trip ID for plain text display.
 * @param {string} tripId - Trip ID string
 * @returns {string} The trip ID as-is, or empty string if falsy
 */
// Format trip ID for display (plain text, no colored badge)
function _cTid(tripId){
  return tripId||'';
}
