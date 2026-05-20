/** @file HWMS pure logic functions — container, invoice, payment, and status calculations. No DOM access.
 *  @depends common.js (byId, _hwmsNormContStatus), DB global
 */

// ═══════════════════════════════════════════════════════════════════════════
// hwms-logic.js — Pure logic functions extracted from hwms.js (no DOM access)
// Depends on: common.js (byId, _hwmsNormContStatus), DB global
// ═══════════════════════════════════════════════════════════════════════════

// ── Date Helpers ────────────────────────────────────────────────────────
var _MON_MAP={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
/**
 * Convert an Excel serial date number to ISO date string.
 * @param {number} n - Excel serial date number
 * @returns {string|null} ISO date (YYYY-MM-DD) or null if invalid
 */
function _xlSerialToISO(n){
  if(n>=1&&n<100000){
    var d=new Date(Math.round((n-25569)*86400000));
    if(!isNaN(d)){var iso=d.toISOString().slice(0,10);var yr=parseInt(iso);if(yr>=1900&&yr<=2100) return iso;}
  }
  return null;
}
/**
 * Normalize various date formats (Excel serial, dd-MMM-yy, DD/MM/YYYY, etc.) to YYYY-MM-DD.
 * @param {string|number} v - Date value in any supported format
 * @returns {string} Normalized YYYY-MM-DD string, or original value if unparseable
 */
function _fixExcelDate(v){
  if(v===null||v===undefined||v==='') return '';
  // Handle raw JS numbers directly
  if(typeof v==='number'){if(!v) return '';var r=_xlSerialToISO(v);return r||String(v);}
  var s=String(v).trim();
  if(!s) return '';
  // 1. Already YYYY-MM-DD — pass through
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // 2. Any pure number (integer or decimal) — try as Excel serial
  var num=parseFloat(s);
  if(!isNaN(num)&&/^-?\d+\.?\d*$/.test(s)){var r2=_xlSerialToISO(num);if(r2) return r2;}
  // 3. dd-MMM-yy or dd-MMM-yyyy (e.g. 26-Mar-25, 26-Mar-2025)
  var m1=s.match(/^(\d{1,2})[- ](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[- ](\d{2,4})$/i);
  if(m1){
    var dd=parseInt(m1[1]),mm=_MON_MAP[m1[2].toLowerCase()],yy=parseInt(m1[3]);
    if(yy<100) yy+=2000;
    return yy+'-'+String(mm+1).padStart(2,'0')+'-'+String(dd).padStart(2,'0');
  }
  // 4. DD/MM/YYYY or MM/DD/YYYY
  var m2=s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if(m2){
    var p1=parseInt(m2[1]),p2=parseInt(m2[2]),p3=parseInt(m2[3]);
    if(p1>12){var dt2=new Date(p3,p2-1,p1);if(!isNaN(dt2)) return dt2.toISOString().slice(0,10);}
    else{var dt3=new Date(p3,p1-1,p2);if(!isNaN(dt3)) return dt3.toISOString().slice(0,10);}
  }
  // 5. DD/MM/YY
  var m3=s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2})$/);
  if(m3){var dt4=new Date(2000+parseInt(m3[3]),parseInt(m3[2])-1,parseInt(m3[1]));if(!isNaN(dt4)) return dt4.toISOString().slice(0,10);}
  // 6. Native fallback
  var dt5=new Date(s);
  if(!isNaN(dt5)&&s.length>4) return dt5.toISOString().slice(0,10);
  return s;
}
/**
 * Export-friendly date formatter (alias for _fixExcelDate).
 * @param {string|number} v - Date value
 * @returns {string} Normalized YYYY-MM-DD string
 */
// Export uses same YYYY-MM-DD format as DB
function _exportDate(v){ return _fixExcelDate(v); }

// ── Data Parsing Utilities ──────────────────────────────────────────────
/**
 * Parse a container notes field into a structured {n1, n2, n3} object.
 * @param {string|Object} noteField - Raw note field (JSON string or object)
 * @returns {Object} Parsed notes with n1, n2, n3 keys
 */
function _hwmsParseCoNotes(noteField){
  if(!noteField) return{n1:'',n2:'',n3:''};
  // Already an object (Supabase may return parsed JSON)
  if(typeof noteField==='object'&&noteField.n1!==undefined) return{n1:noteField.n1||'',n2:noteField.n2||'',n3:noteField.n3||''};
  if(typeof noteField!=='string') return{n1:'',n2:'',n3:''};
  try{
    var trimmed=noteField.trim();
    if(trimmed.charAt(0)==='{'){var o=JSON.parse(trimmed);return{n1:o.n1||'',n2:o.n2||'',n3:o.n3||''};}
  }catch(e){console.warn('_hwmsParseCoNotes parse error:',e.message);}
  return{n1:noteField,n2:'',n3:''}; // backward compat: old single note → n1
}

/**
 * Parse a formatted currency string (e.g. "1,234.56") from an input element to a number.
 * @param {HTMLElement} el - Input element with a value property
 * @returns {number} Parsed numeric value or 0
 */
function _hwmsCurrencyParse(el){
  // Parse back from formatted string like "1,234.56" to number
  var v=(el?.value||'').replace(/,/g,'');
  return parseFloat(v)||0;
}

/**
 * Convert a container number (CN-NNN/YY or AC-NNN/YY) to a sortable numeric value.
 * @param {string} cn - Container number string
 * @returns {number} Sort value (0 if unparseable)
 */
function _hwmsContNumToSortVal(cn){
  // CN-NNN/YY or AC-NNN/YY → type*100000 + YY*1000+NNN
  var m=(cn||'').match(/(CN|AC)-(\d+)\/(\d+)/);
  if(m) return (m[1]==='AC'?100000:0)+parseInt(m[3])*1000+parseInt(m[2]);
  return 0;
}
/**
 * Determine consignment type ("air" or "sea") from a container record.
 * @param {Object} c - Container record
 * @returns {string} "air" or "sea"
 */
function _hwmsContGetType(c){return (c?.consignmentType==='air'||/^AC-/.test(c?.containerNumber))?'air':'sea';}

/**
 * Extract the linked MR ID from a sub-invoice record.
 * @param {Object} si - Sub-invoice record
 * @returns {string} MR ID or empty string
 */
function _hwmsSiGetMrId(si){
  if(!si) return '';
  if(si.lineItems&&Array.isArray(si.lineItems)){
    var meta=si.lineItems.find(function(l){return l._mrMeta;});
    if(meta&&meta.mrId) return meta.mrId;
  }
  return si.mrId||'';
}

/**
 * Get warehouse locations for a part across all reached containers.
 * @param {string} partId - Part identifier
 * @returns {string} Comma-separated unique warehouse locations
 */
function _hwmsGetPartWhLoc(partId){
  if(!partId) return '';
  var locs=[];
  (DB.hwmsInvoices||[]).forEach(function(inv){
    var cont=byId(DB.hwmsContainers||[],inv.containerId);
    if(!cont||cont.status!=='Reached') return;
    (inv.lineItems||[]).forEach(function(li){
      if(li.partId===partId&&li.whLocation) locs.push(li.whLocation);
    });
  });
  return [...new Set(locs)].join(', ');
}

/**
 * Get the latest applicable steel rate for a customer as of an invoice date.
 * @param {string} customerId - Customer identifier
 * @param {string} invoiceDate - Invoice date in ISO format
 * @returns {Object|null} Steel rate record or null
 */
function _hwmsGetLatestSteelRate(customerId, invoiceDate){
  // Steel rates are stored in the separate hwms_steel_rates table, linked by customerId
  const all=(DB.hwmsSteelRates||[]).filter(r=>r.customerId===customerId);
  if(!all.length) return null;
  // Try to find rate whose validity period covers the invoice date
  if(invoiceDate){
    const d=invoiceDate.split('T')[0]; // date-only string
    const active=all.filter(r=>r.validFrom<=d&&(!r.validTo||r.validTo>=d));
    if(active.length) return active.sort((a,b)=>b.validFrom.localeCompare(a.validFrom))[0];
  }
  // Fallback: most recently started rate
  return all.sort((a,b)=>(b.validFrom||'').localeCompare(a.validFrom||''))[0];
}

/**
 * Convert a numeric USD amount to words (e.g. "USD One Thousand Two Hundred Only").
 * @param {number} n - Amount in USD
 * @returns {string} Amount in words
 */
function _hwmsAmtToWords(n){
  if(!n||n===0) return 'Zero';
  const ones=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function w(num){
    if(num<20) return ones[num];
    if(num<100) return tens[Math.floor(num/10)]+(num%10?' '+ones[num%10]:'');
    if(num<1000) return ones[Math.floor(num/100)]+' Hundred'+(num%100?' '+w(num%100):'');
    if(num<1000000) return w(Math.floor(num/1000))+' Thousand'+(num%1000?' '+w(num%1000):'');
    if(num<1000000000) return w(Math.floor(num/1000000))+' Million'+(num%1000000?' '+w(num%1000000):'');
    return w(Math.floor(num/1000000000))+' Billion'+(num%1000000000?' '+w(num%1000000000):'');
  }
  const int=Math.floor(n);
  const cents=Math.round((n-int)*100);
  let result='USD '+w(int);
  if(cents>0) result+=' and Cent '+(cents<20?ones[cents]:(tens[Math.floor(cents/10)]+(cents%10?' '+ones[cents%10]:'')))+' Only';
  else result+=' Only';
  return result;
}

// ── Status Functions ────────────────────────────────────────────────────
/**
 * Get container display status (Draft / In Transit / Warehouse).
 * @param {Object} cont - Container record
 * @returns {Object} Status object with label and cls properties
 */
// Container: Draft → In Transit → Warehouse
function _hwmsContainerSt(cont){
  if(!cont) return {label:'—',cls:'badge-yellow'};
  var st=_hwmsNormContStatus(cont.status);
  if(st==='Reached') return {label:'Warehouse',cls:'badge-wh'};
  if(st==='Onwater') return {label:'In Transit',cls:'badge-onwater'};
  return {label:'Draft',cls:'badge-yellow'};
}

/**
 * Get MI (Master Invoice) display status (Draft / RFD / Dispatched / Warehouse).
 * @param {Object} inv - Invoice record
 * @returns {Object} Status object with label and cls properties
 */
// MI Status: Draft → RFD → Dispatched → Warehouse
function _hwmsMiSt(inv){
  if(!inv.confirmed) return {label:'Draft',cls:'badge-yellow'};
  var cont=inv.containerId?byId(DB.hwmsContainers||[],inv.containerId):null;
  var cst=cont?_hwmsNormContStatus(cont.status):'';
  if(!cont||!cst) return {label:'RFD',cls:'badge-rfd'};
  if(cst==='Onwater') return {label:'Dispatched',cls:'badge-onwater'};
  if(cst==='Reached') return {label:'Warehouse',cls:'badge-wh'};
  return {label:'RFD',cls:'badge-rfd'};
}

/**
 * Get aggregate SI (Sub-Invoice) sales status for an MI.
 * @param {Object} inv - Invoice record
 * @returns {Object} Status object with label and cls properties
 */
// SI Status (aggregate for an MI): — → SI Created → Part. Sold → Sold
function _hwmsSiAggSt(inv){
  var lis=(inv.lineItems||[]).filter(function(li){return !li._meta;});
  if(!lis.length) return {label:'—',cls:''};
  var cont=inv.containerId?byId(DB.hwmsContainers||[],inv.containerId):null;
  var isAir=cont?_hwmsContGetType(cont)==='air':inv.modeOfTransport==='By Air';
  // Air: all sold once container reaches
  if(isAir){
    var cst=cont?_hwmsNormContStatus(cont.status):'';
    if(cst==='Reached') return {label:'Sold',cls:'badge-sold'};
    return {label:'—',cls:''};
  }
  // Sea: check SIs and sold status
  var siForInv=(DB.hwmsSubInvoices||[]).filter(function(si){return si.invoiceId===inv.id;});
  var allSold=lis.every(function(li){return li.soldStatus==='Sold';});
  var anySold=lis.some(function(li){return li.soldStatus==='Sold';});
  if(allSold) return {label:'Sold',cls:'badge-sold'};
  if(anySold) return {label:'Part. Sold',cls:'badge-partsold'};
  if(siForInv.length>0) return {label:'SI Created',cls:'badge-sidraft'};
  return {label:'—',cls:''};
}

/**
 * Get aggregate payment status for an MI (Pending / Part. Paid / Fully Paid).
 * @param {Object} inv - Invoice record
 * @returns {Object} Status object with label and cls properties
 */
// Payment Status (aggregate for an MI): Pending → Part. Paid → Fully Paid
function _hwmsPayAggSt(inv){
  var siForInv=(DB.hwmsSubInvoices||[]).filter(function(si){return si.invoiceId===inv.id;});
  var cont=inv.containerId?byId(DB.hwmsContainers||[],inv.containerId):null;
  var isAir=cont?_hwmsContGetType(cont)==='air':inv.modeOfTransport==='By Air';
  var totalAmt=0,totalRcvd=0;
  if(isAir){
    // Air: payments go directly to MI line items
    totalAmt=(inv.lineItems||[]).filter(function(li){return !li._meta;}).reduce(function(s,li){return s+(li.quantity||0)*(li.rate||0);},0);
    totalRcvd=_hwmsGetMiRcvd(inv);
    // Also check via SIs if any exist
    if(!totalRcvd&&siForInv.length){
      siForInv.forEach(function(si){totalRcvd+=_hwmsGetSiRcvd(si);});
    }
  } else {
    // Sea: payments go to SLIs
    if(siForInv.length){
      siForInv.forEach(function(si){totalAmt+=_hwmsGetSiAmt(si);totalRcvd+=_hwmsGetSiRcvd(si);});
    }
  }
  if(totalRcvd>0&&totalRcvd>=totalAmt) return {label:'Fully Paid',cls:'badge-fullpaid'};
  if(totalRcvd>0) return {label:'Part. Paid',cls:'badge-partpaid'};
  return {label:'Pending',cls:'badge-pmtpend'};
}

/**
 * Get aggregate payment status across all MIs in a container.
 * @param {Object} cont - Container record
 * @returns {Object} Status object with label and cls properties
 */
// Payment aggregate for a Container
function _hwmsContPaySt(cont){
  if(!cont) return {label:'—',cls:''};
  var invs=(DB.hwmsInvoices||[]).filter(function(inv){return inv.containerId===cont.id;});
  if(!invs.length) return {label:'—',cls:''};
  var statuses=invs.map(function(inv){return _hwmsPayAggSt(inv).label;});
  var allFull=statuses.every(function(s){return s==='Fully Paid';});
  var anyPay=statuses.some(function(s){return s==='Fully Paid'||s==='Part. Paid';});
  if(allFull) return {label:'Fully Paid',cls:'badge-fullpaid'};
  if(anyPay) return {label:'Part. Paid',cls:'badge-partpaid'};
  return {label:'Pending',cls:'badge-pmtpend'};
}

/**
 * Get legacy combined invoice status for dashboard and backward compatibility.
 * @param {Object} inv - Invoice record
 * @returns {Object} Status object with label and cls properties
 */
// Legacy combined status — kept for backward compatibility (dashboard counts etc.)
function _hwmsInvStatus(inv){
  try{
  if(!inv.confirmed) return {label:'Draft',cls:'badge-yellow'};
  var cont=inv.containerId?byId(DB.hwmsContainers||[],inv.containerId):null;
  var cst=cont?_hwmsNormContStatus(cont.status):'';
  if(!cont||!cst) return {label:'RFD',cls:'badge-rfd'};
  if(cst==='Onwater') return {label:'In Transit',cls:'badge-onwater'};
  if(cst!=='Reached') return {label:'RFD',cls:'badge-rfd'};
  // ── Container Reached ──
  var isAir=cont?_hwmsContGetType(cont)==='air':inv.modeOfTransport==='By Air';
  var lis=(inv.lineItems||[]).filter(function(li){return !li._meta;});
  var siForInv=(DB.hwmsSubInvoices||[]).filter(function(si){return si.invoiceId===inv.id;});

  if(isAir){
    // ── AIR: CT received → MI = Sold immediately ──
    // Check payment from receipts
    var airTotalAmt=0,airTotalRcvd=0;
    siForInv.forEach(function(si){airTotalAmt+=_hwmsGetSiAmt(si);airTotalRcvd+=_hwmsGetSiRcvd(si);});
    if(airTotalRcvd>0&&airTotalRcvd>=airTotalAmt) return {label:'Fully Paid',cls:'badge-fullpaid'};
    if(airTotalRcvd>0) return {label:'Partially Paid',cls:'badge-partpaid'};
    return {label:'Sold',cls:'badge-sold'};
  }

  // ── SEA: WH → SI(Draft) → Sold/Part.Sold → Paid ──
  if(!lis.length) return {label:'Warehouse',cls:'badge-wh'};
  var hasSI=siForInv.length>0;
  var hasAnySold=lis.some(function(li){return li.soldStatus==='Sold';});
  var allSold=lis.every(function(li){return li.soldStatus==='Sold';});
  // Check payment from receipts
  var seaTotalAmt=0,seaTotalRcvd=0;
  siForInv.forEach(function(si){seaTotalAmt+=_hwmsGetSiAmt(si);seaTotalRcvd+=_hwmsGetSiRcvd(si);});
  if(seaTotalRcvd>0&&seaTotalRcvd>=seaTotalAmt&&allSold) return {label:'Fully Paid',cls:'badge-fullpaid'};
  if(seaTotalRcvd>0) return {label:'Partially Paid',cls:'badge-partpaid'};
  if(allSold) return {label:'Sold',cls:'badge-sold'};
  if(hasAnySold) return {label:'Partially Sold',cls:'badge-partsold'};
  if(hasSI) return {label:'SI (Draft)',cls:'badge-sidraft'};
  return {label:'Warehouse',cls:'badge-wh'};
  }catch(e){console.warn('_hwmsInvStatus error:',e.message);return {label:'—',cls:'badge-yellow'};}
}

/**
 * Get container status (alias for _hwmsContainerSt).
 * @param {Object} c - Container record
 * @returns {Object} Status object with label and cls properties
 */
function _hwmsContStatus(c){
  return _hwmsContainerSt(c);
}

/**
 * Get status for a specific part/pallet line item within an MI.
 * @param {Object} inv - Invoice record
 * @param {Object} li - Line item object
 * @param {Object} cont - Container record
 * @returns {Object} Status object with label and cls properties
 */
// Part + Pallet status (SLI = MI + PL + PRT)
function _hwmsPartPalletStatus(inv,li,cont){
  try{
  if(!inv||!inv.confirmed) return {label:'Draft',cls:'badge-yellow'};
  var cst=cont?_hwmsNormContStatus(cont.status):'';
  if(!cont||!cst) return {label:'RFD',cls:'badge-rfd'};
  if(cst==='Onwater') return {label:'In Transit',cls:'badge-onwater'};
  if(cst!=='Reached') return {label:'RFD',cls:'badge-rfd'};
  // ── Container Reached ──
  var isAir=cont?_hwmsContGetType(cont)==='air':inv.modeOfTransport==='By Air';

  if(isAir){
    // ── AIR: CT received → SLI = Sold immediately ──
    // Check payment from receipts via matching SIs
    var airSis=(DB.hwmsSubInvoices||[]).filter(function(si){return si.invoiceId===inv.id;});
    var airRcvd=0,airAmt=0;
    airSis.forEach(function(si){airRcvd+=_hwmsGetSiRcvd(si);airAmt+=_hwmsGetSiAmt(si);});
    if(airRcvd>0&&airRcvd>=airAmt) return {label:'Fully Paid',cls:'badge-fullpaid'};
    if(airRcvd>0) return {label:'Partially Paid',cls:'badge-partpaid'};
    return {label:'Sold',cls:'badge-sold'};
  }

  // ── SEA: WH → SI(Draft) → Sold → Paid ──
  if(li.holdStatus==='hold') return {label:'Warehouse-Hold',cls:'badge-whhold'};
  if(li.whCondition&&li.whCondition!=='good') return {label:'Warehouse-Hold',cls:'badge-whhold'};
  // Check if this SLI is in any SI
  var palletKey=inv.id+'|'+(li.partId||'')+'|'+(li.palletNumber||'');
  var matchSi=null;
  (DB.hwmsSubInvoices||[]).forEach(function(si){
    if(si.invoiceId!==inv.id) return;
    (si.lineItems||[]).forEach(function(sl){
      if(!sl._mrMeta&&(si.invoiceId+'|'+(sl.partId||'')+'|'+(sl.palletNumber||''))===palletKey) matchSi=si;
    });
  });
  if(!matchSi){
    return li.soldStatus==='Sold'?{label:'Sold',cls:'badge-sold'}:{label:'Warehouse',cls:'badge-wh'};
  }
  // In an SI — check SI pickup status
  if(matchSi.pickupStatus!=='Picked') return {label:'SI (Draft)',cls:'badge-sidraft'};
  // Picked up = Sold → check payment from receipts
  var siRcvd=_hwmsGetSiRcvd(matchSi);
  var siAmt=_hwmsGetSiAmt(matchSi);
  if(siRcvd>0&&siRcvd>=siAmt) return {label:'Fully Paid',cls:'badge-fullpaid'};
  if(siRcvd>0) return {label:'Partially Paid',cls:'badge-partpaid'};
  return {label:'Sold',cls:'badge-sold'};
  }catch(e){console.warn('_hwmsPartPalletStatus error:',e.message);return {label:'—',cls:'badge-yellow'};}
}

/**
 * Get SI payment/pickup status (sea shipments only).
 * @param {Object} si - Sub-invoice record
 * @returns {Object} Status object with label and cls properties
 */
// SI status (sea only)
function _hwmsSiStatus(si){
  var rcvd=_hwmsGetSiRcvd(si);
  var amt=_hwmsGetSiAmt(si);
  if(rcvd>0&&rcvd>=amt) return {label:'Fully Paid',cls:'badge-fullpaid'};
  if(rcvd>0) return {label:'Partially Paid',cls:'badge-partpaid'};
  if(si.pickupStatus==='Picked') return {label:'Sold',cls:'badge-sold'};
  return {label:'SI (Draft)',cls:'badge-sidraft'};
}

/**
 * Get SI overall status as a plain string (no CSS class).
 * @param {Object} si - Sub-invoice record
 * @returns {string} Status label string
 */
function _hwmsSiOverallStatus(si){
  var rcvd=_hwmsGetSiRcvd(si);
  var amt=_hwmsGetSiAmt(si);
  if(rcvd>0&&rcvd>=amt) return 'Fully Paid';
  if(rcvd>0) return 'Partially Paid';
  if(si.pickupStatus==='Picked') return 'Sold';
  return 'SI (Draft)';
}

// ── MR Status ───────────────────────────────────────────────────────────
/**
 * Calculate MR status based on dispatch fulfillment (Open / Partially Closed / Closed).
 * @param {Object} mr - Material Request record
 * @returns {string} Status string
 */
// Auto-calc MR Status: Open / Partially Closed / Closed
function _hwmsMrCalcStatus(mr){
  var lis=mr.lineItems||[];
  if(!lis.length) return 'Open';
  var info=_hwmsMrDispatchInfo(mr);
  // Consolidate by partId
  var parts={};
  lis.forEach(function(l){
    var k=l.partId||l.partNumber;
    if(!parts[k]) parts[k]={totalReq:0};
    parts[k].totalReq+=(l.quantity||0);
  });
  var partKeys=Object.keys(parts);
  var fullyDispatched=0;
  var partiallyDispatched=0;
  partKeys.forEach(function(k){
    var dispatched=info.perPart[k]?info.perPart[k].totalQty:0;
    if(dispatched>=parts[k].totalReq) fullyDispatched++;
    else if(dispatched>0) partiallyDispatched++;
  });
  if(fullyDispatched>=partKeys.length) return 'Closed';
  if(fullyDispatched>0||partiallyDispatched>0) return 'Partially Closed';
  return 'Open';
}
/**
 * Get dispatch info for an MR: linked sub-invoices and per-part quantities.
 * @param {Object} mr - Material Request record
 * @returns {Object} {linkedSis: Array, perPart: Object} dispatch breakdown
 */
// Get dispatch info for an MR: which sub-invoices, qty per part
function _hwmsMrDispatchInfo(mr){
  var mrId=mr.id;
  // Find sub-invoices linked to this MR
  var linkedSis=(DB.hwmsSubInvoices||[]).filter(function(si){return _hwmsSiGetMrId(si)===mrId;});
  // Per-part dispatch: partId → {totalQty, subInvoices:[{siNum,qty}]}
  var perPart={};
  linkedSis.forEach(function(si){
    (si.lineItems||[]).filter(function(l){return !l._mrMeta;}).forEach(function(l){
      var key=l.partId||l.partNumber;
      if(!perPart[key]) perPart[key]={totalQty:0,subInvoices:[]};
      perPart[key].totalQty+=(l.quantity||0);
      // Check if this SI already recorded
      var existing=perPart[key].subInvoices.find(function(s){return s.siNum===si.subInvoiceNumber;});
      if(existing) existing.qty+=(l.quantity||0);
      else perPart[key].subInvoices.push({siNum:si.subInvoiceNumber,siId:si.id,qty:l.quantity||0});
    });
  });
  return{linkedSis:linkedSis,perPart:perPart};
}

// ── Payment Calculator ──────────────────────────────────────────────────
// Receipt-based payment calculator — single source of truth.
// All payment status/amounts across SI/MI/Container derive from this.
var _hwmsPayCalcCache=null,_hwmsPayCalcTs=0;
/**
 * Build and cache payment totals from all posted receipts (SI, MI, suspense).
 * @returns {Object} Payment cache {bySi, byLi, byMi, byMiLi, suspenseAir, suspenseSea}
 */
function _hwmsPayCalc(){
  if(_hwmsPayCalcCache&&Date.now()-_hwmsPayCalcTs<2000) return _hwmsPayCalcCache;
  var bySi={};  // siId → {received:number, payNums:[]}
  var byLi={};  // 'siId|PARTNUM|palletNumber' → received
  var byMi={};  // miId → {received:number, payNums:[]}
  var byMiLi={}; // 'miId|PARTNUM|palletNumber' → received
  var suspenseAir=0,suspenseSea=0;// Suspense account totals
  (DB.hwmsPaymentReceipts||[]).forEach(function(pr){
    if(pr.status!=='Posted'||pr._deleted) return;
    // Sea: siUpdates
    (pr.siUpdates||[]).forEach(function(su){
      if(!bySi[su.siId]) bySi[su.siId]={received:0,payNums:[]};
      if(pr.paymentNumber) bySi[su.siId].payNums.push(pr.paymentNumber);
      (su.lines||[]).forEach(function(l){
        var amt=l.payAmt||0;
        bySi[su.siId].received+=amt;
        var key=su.siId+'|'+(l.partNumber||'').toUpperCase()+'|'+(l.palletNumber||'');
        byLi[key]=(byLi[key]||0)+amt;
      });
    });
    // Air: miUpdates
    (pr.miUpdates||[]).forEach(function(mu){
      if(!byMi[mu.miId]) byMi[mu.miId]={received:0,payNums:[]};
      if(pr.paymentNumber) byMi[mu.miId].payNums.push(pr.paymentNumber);
      (mu.lines||[]).forEach(function(l){
        var amt=l.payAmt||0;
        byMi[mu.miId].received+=amt;
        var key=mu.miId+'|'+(l.partNumber||'').toUpperCase()+'|'+(l.palletNumber||'');
        byMiLi[key]=(byMiLi[key]||0)+amt;
      });
    });
    // Suspense: from manualPayments (common account) + legacy per-PLI matchedSlis
    (pr.manualPayments||[]).forEach(function(mp){
      if(mp.type==='suspense-sea') suspenseSea+=(mp.amount||0);
      else if(mp.type==='suspense-air') suspenseAir+=(mp.amount||0);
    });
    // Legacy: per-PLI suspense from older receipts + fallback Air MI payments
    var hasMiUpdates=(pr.miUpdates||[]).length>0;
    (pr.lineItems||[]).forEach(function(li){
      (li.matchedSlis||[]).forEach(function(m){
        if(m.type==='suspense'||String(m.siId||'').startsWith('suspense:')){
          var amt=m.amount||0;
          if(m.suspenseMode==='air'||String(m.siId||'').indexOf('air')>=0) suspenseAir+=amt;
          else suspenseSea+=amt;
        }
        if(!hasMiUpdates&&(m.type==='mi'||String(m.siId||'').startsWith('mi:'))&&m.amount>0){
          var miId=m.miId||(m.siId||'').replace('mi:','');
          if(miId){
            if(!byMi[miId]) byMi[miId]={received:0,payNums:[]};
            if(pr.paymentNumber&&byMi[miId].payNums.indexOf(pr.paymentNumber)<0) byMi[miId].payNums.push(pr.paymentNumber);
            byMi[miId].received+=m.amount;
            var key=miId+'|'+(m.partNumber||'').toUpperCase()+'|'+(m.palletNumber||'');
            byMiLi[key]=(byMiLi[key]||0)+m.amount;
          }
        }
      });
    });
  });
  // Round all values
  Object.keys(bySi).forEach(function(k){bySi[k].received=Math.round(bySi[k].received*100)/100;});
  Object.keys(byLi).forEach(function(k){byLi[k]=Math.round(byLi[k]*100)/100;});
  Object.keys(byMi).forEach(function(k){byMi[k].received=Math.round(byMi[k].received*100)/100;});
  Object.keys(byMiLi).forEach(function(k){byMiLi[k]=Math.round(byMiLi[k]*100)/100;});
  _hwmsPayCalcCache={bySi:bySi,byLi:byLi,byMi:byMi,byMiLi:byMiLi,suspenseAir:Math.round(suspenseAir*100)/100,suspenseSea:Math.round(suspenseSea*100)/100};
  _hwmsPayCalcTs=Date.now();
  return _hwmsPayCalcCache;
}
/**
 * Reset the payment calculator cache to force recalculation on next call.
 * @returns {void}
 */
function _hwmsPayCalcReset(){_hwmsPayCalcCache=null;_hwmsPayCalcTs=0;}

/**
 * Get total amount received for a sub-invoice.
 * @param {Object} si - Sub-invoice record
 * @returns {number} Total received amount
 */
function _hwmsGetSiRcvd(si){
  var pc=_hwmsPayCalc();
  return (pc.bySi[si.id]||{}).received||0;
}
/**
 * Get payment receipt numbers associated with a sub-invoice.
 * @param {Object} si - Sub-invoice record
 * @returns {Array<string>} Array of payment numbers
 */
function _hwmsGetSiPayNums(si){
  var pc=_hwmsPayCalc();
  return (pc.bySi[si.id]||{}).payNums||[];
}
/**
 * Get amount received for a specific SI line item (by part and pallet).
 * @param {string} siId - Sub-invoice ID
 * @param {string} partNumber - Part number
 * @param {string} palletNumber - Pallet number
 * @returns {number} Received amount for the line item
 */
function _hwmsGetLiRcvd(siId,partNumber,palletNumber){
  var pc=_hwmsPayCalc();
  var key=siId+'|'+(partNumber||'').toUpperCase()+'|'+(palletNumber||'');
  return pc.byLi[key]||0;
}
/**
 * Get total received for a part across all pallets in a sub-invoice.
 * @param {string} siId - Sub-invoice ID
 * @param {string} partNumber - Part number
 * @returns {number} Total received for the part
 */
// Get received for SI+Part across ALL pallets (sum all byLi keys matching siId|PARTNUM|*)
function _hwmsGetPartRcvd(siId,partNumber){
  var pc=_hwmsPayCalc();
  var prefix=siId+'|'+(partNumber||'').toUpperCase()+'|';
  var total=0;
  Object.keys(pc.byLi).forEach(function(k){if(k.indexOf(prefix)===0) total+=pc.byLi[k];});
  return Math.round(total*100)/100;
}
/**
 * Get total amount received for an air MI (Master Invoice).
 * @param {Object} inv - Invoice record
 * @returns {number} Total received amount
 */
// Air MI-level payment helpers
function _hwmsGetMiRcvd(inv){
  var pc=_hwmsPayCalc();
  return (pc.byMi[inv.id]||{}).received||0;
}
/**
 * Get payment receipt numbers associated with an MI.
 * @param {Object} inv - Invoice record
 * @returns {Array<string>} Array of payment numbers
 */
function _hwmsGetMiPayNums(inv){
  var pc=_hwmsPayCalc();
  return (pc.byMi[inv.id]||{}).payNums||[];
}
/**
 * Get amount received for a specific MI line item (by part and pallet).
 * @param {string} miId - Master Invoice ID
 * @param {string} partNumber - Part number
 * @param {string} palletNumber - Pallet number
 * @returns {number} Received amount for the line item
 */
function _hwmsGetMiLiRcvd(miId,partNumber,palletNumber){
  var pc=_hwmsPayCalc();
  var key=miId+'|'+(partNumber||'').toUpperCase()+'|'+(palletNumber||'');
  return pc.byMiLi[key]||0;
}
/**
 * Get total received for a part across all pallets in an MI.
 * @param {string} miId - Master Invoice ID
 * @param {string} partNumber - Part number
 * @returns {number} Total received for the part
 */
// Get received for MI+Part across ALL pallets
function _hwmsGetMiPartRcvd(miId,partNumber){
  var pc=_hwmsPayCalc();
  var prefix=miId+'|'+(partNumber||'').toUpperCase()+'|';
  var total=0;
  Object.keys(pc.byMiLi).forEach(function(k){if(k.indexOf(prefix)===0) total+=pc.byMiLi[k];});
  return Math.round(total*100)/100;
}
/**
 * Calculate total invoice amount for a sub-invoice (sum of qty * rate).
 * @param {Object} si - Sub-invoice record
 * @returns {number} Total amount
 */
function _hwmsGetSiAmt(si){
  return (si.lineItems||[]).filter(function(l){return !l._mrMeta;}).reduce(function(s,l){return s+(l.quantity||0)*(l.rate||0);},0);
}
