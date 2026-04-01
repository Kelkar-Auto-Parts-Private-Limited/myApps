// ═══════════════════════════════════════════════════════════════════════════════
// myApps_Common.js — Shared foundation for all KAP myApps modules
// Contains: Supabase config, data layer, constants, utilities, Excel core
// Loaded by: myApps_Portal.html, myApps_VMS.html (myApps_V17), myApps_HWMS.html
// ═══════════════════════════════════════════════════════════════════════════════
const _COMMON_LOADED = true;

// ═══ GLOBAL LOADING SPINNER ═══════════════════════════════════════════════
// Auto-injects overlay into DOM. Nested-safe (tracks depth).
var _spinDepth=0;
function _spinnerEnsureDOM(){
  if(document.getElementById('kapSpinnerOverlay')) return;
  var ov=document.createElement('div');ov.id='kapSpinnerOverlay';
  ov.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(15,23,42,.45);display:none;align-items:center;justify-content:center;flex-direction:column;gap:12px;backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)';
  ov.innerHTML='<div style="width:44px;height:44px;border:4px solid rgba(42,154,160,.2);border-top-color:#2a9aa0;border-radius:50%;animation:kapSpin .7s linear infinite"></div>'
    +'<div id="kapSpinnerMsg" style="color:#fff;font-size:14px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-shadow:0 1px 4px rgba(0,0,0,.4)">Loading…</div>';
  var style=document.createElement('style');
  style.textContent='@keyframes kapSpin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
  document.body.appendChild(ov);
}
function showSpinner(msg){
  _spinnerEnsureDOM();
  _spinDepth++;
  var ov=document.getElementById('kapSpinnerOverlay');
  var m=document.getElementById('kapSpinnerMsg');
  if(m) m.textContent=msg||'Loading…';
  if(ov) ov.style.display='flex';
}
function hideSpinner(){
  _spinDepth=Math.max(0,_spinDepth-1);
  if(_spinDepth===0){
    var ov=document.getElementById('kapSpinnerOverlay');
    if(ov) ov.style.display='none';
  }
}
function _spinnerMsg(msg){
  var m=document.getElementById('kapSpinnerMsg');
  if(m) m.textContent=msg||'Loading…';
}

// ── Module hooks (override in module scripts) ───────────────────────────────
let _onCurrentUserUpdated = function(){}; // called when realtime updates CU
let _onPostBoot = function(){};           // called after bootDB completes
let _onRefreshViews = function(){};
let _kapPopupOpen = false; // set true when KAP popup is open — pauses bg refresh       // called to refresh module views

// ═══ SUPABASE CONFIG ═══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// SUPABASE CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
const SUPABASE_URL = 'https://ehzfknwkerafblnibhps.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVoemZrbndrZXJhZmJsbmliaHBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMzc5NDEsImV4cCI6MjA4ODYxMzk0MX0.fNj15dY0fc4N1KCdRll_dTAmN295WZKB6sUYCPxjN_8';

// Supabase table name mapping (JS tbl name → Supabase table name)
const SB_TABLES = {
  users:'vms_users', vehicleTypes:'vms_vehicle_types', vendors:'vms_vendors',
  drivers:'vms_drivers', vehicles:'vms_vehicles', locations:'vms_locations',
  tripRates:'vms_trip_rates', trips:'vms_trips', segments:'vms_segments',
  spotTrips:'vms_spot_trips',
  checkpoints:'ss_checkpoints', guards:'ss_guards', roundSchedules:'ss_round_schedules',
  hwmsParts:'hwms_parts', hwmsInvoices:'hwms_invoices', hwmsContainers:'hwms_containers',
  hwmsHsn:'hwms_hsn', hwmsUom:'hwms_uom', hwmsPacking:'hwms_packing',
  hwmsCustomers:'hwms_customers', hwmsPortDischarge:'hwms_port_discharge', hwmsPortLoading:'hwms_port_loading',
  hwmsCarriers:'hwms_carriers', hwmsCompany:'hwms_company', hwmsSteelRates:'hwms_steel_rates',
  hwmsSubInvoices:'hwms_sub_invoices',
  hwmsMaterialRequests:'hwms_material_requests',
  hwmsPaymentReceipts:'hwms_payment_receipts'
};

// Initialize Supabase client — with CDN fallback + retry
let _sb = null;
let _sbReady = false;

function _initSupabase() {
  try {
    // Try window.supabase (standard UMD export)
    const sb = window.supabase || window.Supabase || (window.supabaseJs && window.supabaseJs.createClient ? window.supabaseJs : null);
    if (sb && typeof sb.createClient === 'function') {
      _sb = sb.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false },
        realtime: { params: { eventsPerSecond: 10 } }
      });
      _sbReady = true;
      console.log('✅ Supabase client initialized');
      return true;
    }
    console.warn('⚠ window.supabase not found yet');
    return false;
  } catch(e) {
    console.error('❌ Supabase init error:', e.message);
    return false;
  }
}

// Try immediately (may succeed if script loaded before this point)
_initSupabase();

// If not ready yet (async script still loading), retry on window.load before booting
// The dynamic fallback CDN is only used if BOTH the primary script failed AND retry failed
let _sbFallbackAttempted = false;
function _sbTryFallbackCDN(){
  if(_sbReady || _sbFallbackAttempted) return;
  _sbFallbackAttempted = true;
  console.warn('Supabase not loaded — trying dynamic CDN fallback...');
  const _sbScript = document.createElement('script');
  _sbScript.src = 'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  _sbScript.onload = () => {
    if (_initSupabase()) {
      console.log('✅ Supabase loaded via fallback CDN');
      _sbSetStatus('ok');
      _sbStartRealtime();
      // Don't call bootDB() again — just sync the data from Supabase.
      // bootDB was already called during boot; a second call would cause
      // a visible double-connection on the login page.
      _bgSyncFromSupabase();
    }
  };
  _sbScript.onerror = () => console.error('❌ Both CDN sources failed — offline mode');
  document.head.appendChild(_sbScript);
}

// Convert JS record → Supabase row

// ═══ DATA HELPERS (needed by _toRow/_fromRow) ═════════════════════════════
function _hwmsFixDate(d){
  if(!d) return '';
  if(typeof d==='number'||(!isNaN(d)&&typeof d==='string'&&/^\d+$/.test(d.trim()))){
    const n=typeof d==='number'?d:parseInt(d);
    if(n>30000&&n<60000){const dt=new Date((n-25569)*86400000);return dt.toISOString().slice(0,10);}
  }
  // Already ISO string
  if(typeof d==='string'&&/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0,10);
  return d.toString();
}

function _hwmsNormContStatus(s){
  if(!s) return '';
  s=s.toString().trim().toLowerCase();
  if(s==='reached'||s==='warehouse'||s==='reached wh') return 'Reached';
  if(s==='onwater'||s==='on water'||s==='in transit') return 'Onwater';
  return '';
}
// Container status helper


// ═══ SUPABASE ROW MAPPING ══════════════════════════════════════════════════
function _toRow(tbl, rec) {
  const r = rec;
  if(tbl==='users')        return {code:r.id,name:r.name||'',password:r.password||'',full_name:r.fullName||'',mobile:r.mobile||'',email:r.email||'',roles:r.roles||[],hwms_roles:r.hwmsRoles||[],plant:r.plant||'',apps:r.apps||[],photo:r.photo||'',inactive:r.inactive||false};
  if(tbl==='vehicleTypes') return {code:r.id,name:r.name||'',capacity:r.capacity||0,inactive:r.inactive||false};
  if(tbl==='vendors')      return {code:r.id,name:r.name||'',owner:r.owner||'',contact:r.contact||'',address:r.address||'',user_id:r.userId||'',inactive:r.inactive||false};
  if(tbl==='drivers')      return {code:r.id,name:r.name||'',mobile:r.mobile||'',vendor_id:r.vendorId||'',dl_expiry:r.dlExpiry||'',photo:r.photo||'',inactive:r.inactive||false};
  if(tbl==='vehicles')     return {code:r.id,number:r.number||'',type_id:r.typeId||'',vendor_id:r.vendorId||'',puc_expiry:r.pucExpiry||'',rtp_expiry:r.rtpExpiry||'',ins_expiry:r.insExpiry||'',inactive:r.inactive||false};
  if(tbl==='locations')    return {code:r.id,name:r.name||'',type:r.type||'KAP',address:r.address||'',geo:r.geo||'',colour:r.colour||'',kap_sec:r.kapSec||'',trip_book:r.tripBook||[],mat_recv:r.matRecv||[],approvers:r.approvers||[],inactive:r.inactive||false};
  if(tbl==='tripRates')    return {code:r.id,name:r.name||'',v_type_id:r.vTypeId||'',start_loc:r.start||'',dest1:r.dest1||'',dest2:r.dest2||'',dest3:r.dest3||'',rate:r.rate||0,valid_start:r.validStart||'',valid_end:r.validEnd||'',status:r.status||'',added_by:r.addedBy||'',approved_by:r.approvedBy||'',approved_at:r.approvedAt||''};
  if(tbl==='trips')        return {code:r.id,booked_by:r.bookedBy||'',plant:r.plant||'',date:r.date||'',start_loc:r.startLoc||'',dest1:r.dest1||'',dest2:r.dest2||'',dest3:r.dest3||'',driver_id:r.driverId||'',vehicle_id:r.vehicleId||'',vehicle_type_id:r.vehicleTypeId||'',actual_vehicle_type_id:r.actualVehicleTypeId||'',vendor:r.vendor||'',description:r.desc||'',trip_cat_id:r.tripCatId||'',challans1:r.challans1||[],challan1:r.challan1||'',weight1:r.weight1||'',photo1:r.photo1||'',challans2:r.challans2||[],challan2:r.challan2||'',weight2:r.weight2||'',photo2:r.photo2||'',challans3:r.challans3||[],challan3:r.challan3||'',weight3:r.weight3||'',photo3:r.photo3||'',edited_by:r.editedBy||'',edited_at:r.editedAt||'',cancelled:r.cancelled||false};
  if(tbl==='segments')     return {code:r.id,trip_id:r.tripId||'',label:r.label||'',s_loc:r.sLoc||'',d_loc:r.dLoc||'',criteria:r.criteria||1,trip_cat_id:r.tripCatId||'',steps:r.steps||{},status:r.status||'Active',date:r.date||'',current_step:r.currentStep||1};
  if(tbl==='spotTrips')    return {code:r.id,vehicle_num:r.vehicleNum||'',supplier:r.supplier||'',challan:r.challan||'',challan_photo:r.challanPhoto||'',driver_name:r.driverName||'',driver_mobile:r.driverMobile||'',driver_photo:r.driverPhoto||'',entry_vehicle_photo:r.entryVehiclePhoto||'',entry_remarks:r.entryRemarks||'',date:r.date||'',entry_time:r.entryTime||'',entry_by:r.entryBy||'',location:r.location||'',exit_time:r.exitTime||'',exit_by:r.exitBy||'',exit_vehicle_photo:r.exitVehiclePhoto||'',exit_remarks:r.exitRemarks||''};
  if(tbl==='checkpoints')  return {code:r.id,location_id:r.locationId||'',name:r.name||'',description:r.description||'',sort_order:r.sortOrder||1,active:r.active!==false};
  if(tbl==='guards')       return {code:r.id,name:r.name||'',mobile:r.mobile||'',email:r.email||'',location_id:r.locationId||'',shift:r.shift||'',photo:r.photo||'',inactive:r.inactive||false};
  if(tbl==='roundSchedules') return {code:r.id,name:r.name||'',location_id:r.locationId||'',guard_id:r.guardId||'',checkpoint_ids:r.checkpointIds||[],frequency:r.frequency||'Daily',start_time:r.startTime||'',end_time:r.endTime||'',inactive:r.inactive||false};
  if(tbl==='hwmsParts') return {code:r.id,part_number:r.partNumber||'',part_revision:r.partRevision||'',description:r.description||'',status:r.status||'Active',net_weight_kg:r.netWeightKg||0,uom:r.uom||'',hsn_code:r.hsnCode||'',part_photo:r.partPhoto||'',packing_type:r.packingType||'',packing_dimensions:r.packingDimensions||'',qty_per_package:r.qtyPerPackage||0,packing_weight:r.packingWeight||0,packing_photo:r.packingPhoto||'',ex_works_rate:r.exWorksRate||0,freight:r.freight||0,warehouse_cost:r.warehouseCost||0,icc_cost:r.iccCost||0,final_rate:r.finalRate||0,rate_valid_from:r.rateValidFrom||'',rate_valid_to:r.rateValidTo||'',rates:r.rates||[]};
  if(tbl==='hwmsInvoices') return {code:r.id,invoice_number:r.invoiceNumber||'',date:r.date||'',container_id:r.containerId||'',container_number:r.containerNumber||'',delivery:r.delivery||'',payment_terms:r.paymentTerms||'',buyer_id:r.buyerId||'',buyer_name:r.buyerName||'',consignee_idx:r.consigneeIdx!=null?r.consigneeIdx:-1,consignee_name:r.consigneeName||'',mode_of_transport:r.modeOfTransport||'',port_of_loading_id:r.portOfLoadingId||'',port_of_loading:r.portOfLoading||'',port_of_discharge_id:r.portOfDischargeId||'',port_of_discharge:r.portOfDischarge||'',country_of_dest:r.countryOfDest||'',line_items:r.lineItems||[],payment_status:r.paymentStatus||'',payment_number:r.paymentNumber||'',confirmed:r.confirmed||false};
  if(tbl==='hwmsContainers') return {code:r.id,container_number:r.containerNumber||'',container_serial_number:r.containerSerialNumber||'',expected_pickup_date:r.expectedPickupDate||'',pickup_date:r.pickupDate||'',status:r.status||'',reach_date:r.reachDate||'',expected_reach_date:r.expectedReachDate||'',reached_date:r.reachedDate||'',carrier_id:r.carrierId||'',carrier_name:r.carrierName||'',carrier_inv_number:r.carrierInvNumber||'',carrier_inv_date:r.carrierInvDate||'',carrier_inv_amount:r.carrierInvAmount||0,carrier_inv_photo:r.carrierInvPhoto||'',entry_summary_number:r.entrySummaryNumber||'',es_date:r.esDate||'',es_amount:r.esAmount||0,es_photo:r.esPhoto||'',tariff_paid:r.tariffPaid||0,tariff_percent:r.tariffPercent||0,confirmed:r.confirmed||false};
  if(tbl==='hwmsHsn') return {code:r.id,hsn_number:r.hsnNumber||'',description:r.description||''};
  if(tbl==='hwmsUom') return {code:r.id,uom:r.uom||'',description:r.description||''};
  if(tbl==='hwmsPacking') return {code:r.id,name:r.name||'',description:r.description||''};
  if(tbl==='hwmsCustomers'){
    const _cs=r.consignees||[];
    const _c=n=>_cs[n]||{};
    return {code:r.id,customer_name:r.customerName||'',supplier_code:r.supplierCode||'',address:r.address||'',country:r.country||'',
      consignee1_name:_c(0).name||'',consignee1_address:_c(0).address||'',consignee1_country:_c(0).country||'',consignee1_is_default:!!_c(0).isDefault,
      consignee2_name:_c(1).name||'',consignee2_address:_c(1).address||'',consignee2_country:_c(1).country||'',consignee2_is_default:!!_c(1).isDefault,
      consignee3_name:_c(2).name||'',consignee3_address:_c(2).address||'',consignee3_country:_c(2).country||'',consignee3_is_default:!!_c(2).isDefault,
      default_transport:r.defaultTransport||'',default_port_discharge:r.defaultPortDischarge||'',default_port_loading:r.defaultPortLoading||'',default_delivery:r.defaultDelivery||'',default_payment_terms:r.defaultPaymentTerms||''};
  }
  if(tbl==='hwmsPortDischarge') return {code:r.id,name:r.name||'',country:r.country||''};
  if(tbl==='hwmsPortLoading') return {code:r.id,name:r.name||'',country:r.country||''};
  if(tbl==='hwmsCarriers') return {code:r.id,carrier_name:r.carrierName||'',address:r.address||'',contact:r.contact||''};
  if(tbl==='hwmsSteelRates') return {code:r.id,cust_id:r.customerId||'',steel_rate:r.steelRate||0,forex_rate:r.forexRate||0,valid_from:r.validFrom||'',valid_to:r.validTo||''};
  if(tbl==='hwmsCompany') return {code:r.id,company_name:r.companyName||'',address:r.address||'',gstin:r.gstin||'',iec:r.iec||'',rex:r.rex||'',supplier_code:r.supplierCode||'',place_receipt:r.placeReceipt||'',country:r.country||'India',note:r.note||''};
  if(tbl==='hwmsSubInvoices') return {code:r.id,sub_invoice_number:r.subInvoiceNumber||'',date:r.date||'',invoice_id:r.invoiceId||'',customer_id:r.customerId||'',customer_name:r.customerName||'',line_items:r.lineItems||[],pickup_status:r.pickupStatus||'',pickup_date:r.pickupDate||'',grn_status:r.grnStatus||'',grn_date:r.grnDate||'',payment_status:r.paymentStatus||'',payment_received:r.paymentReceived||0,payment_balance:r.paymentBalance||0,payment_number:r.paymentNumber||'',payment_date:r.paymentDate||'',tariff_percent:r.tariffPercent||0,tariff_amount:r.tariffAmount||0,remarks:r.remarks||''};
  if(tbl==='hwmsMaterialRequests') return {code:r.id,mr_number:r.mrNumber||'',mr_date:r.mrDate||'',need_by_date:r.needByDate||'',status:r.status||'',line_items:r.lineItems||[],remarks:r.remarks||'',created_by:r.createdBy||''};
  if(tbl==='hwmsPaymentReceipts') return {code:r.id,payment_number:r.paymentNumber||'',payment_date:r.paymentDate||'',status:r.status||'',total_amount:r.totalAmount||0,line_items:r.lineItems||[],si_updates:r.siUpdates||[],mi_updates:r.miUpdates||[],manual_payments:r.manualPayments||[],created_at:r.createdAt||'',created_by:r.createdBy||'',updated_at:r.updatedAt||'',updated_by:r.updatedBy||''};
  return null;
}

// Convert Supabase row → JS record
function _fromRow(tbl, row) {
  if(!row) return null;
  if(tbl==='users')        return {id:row.code,_dbId:row.id,name:row.name,password:row.password,fullName:row.full_name,mobile:row.mobile||'',email:row.email||'',roles:row.roles||[],hwmsRoles:row.hwms_roles||[],plant:row.plant||'',apps:row.apps||[],photo:row.photo||'',inactive:row.inactive||false};
  if(tbl==='vehicleTypes') return {id:row.code,_dbId:row.id,name:row.name,capacity:row.capacity||0,inactive:row.inactive||false};
  if(tbl==='vendors')      return {id:row.code,_dbId:row.id,name:row.name,owner:row.owner||'',contact:row.contact||'',address:row.address||'',userId:row.user_id||'',inactive:row.inactive||false};
  if(tbl==='drivers')      return {id:row.code,_dbId:row.id,name:row.name,mobile:row.mobile||'',vendorId:row.vendor_id||'',dlExpiry:row.dl_expiry||'',photo:row.photo||'',inactive:row.inactive||false};
  if(tbl==='vehicles')     return {id:row.code,_dbId:row.id,number:row.number,typeId:row.type_id||'',vendorId:row.vendor_id||'',pucExpiry:row.puc_expiry||'',rtpExpiry:row.rtp_expiry||'',insExpiry:row.ins_expiry||'',inactive:row.inactive||false};
  if(tbl==='locations')    return {id:row.code,_dbId:row.id,name:row.name,type:row.type,address:row.address||'',geo:row.geo||'',colour:row.colour||'',kapSec:row.kap_sec||'',tripBook:row.trip_book||[],matRecv:row.mat_recv||[],approvers:row.approvers||[],inactive:row.inactive||false};
  if(tbl==='tripRates')    return {id:row.code,_dbId:row.id,name:row.name||'',vTypeId:row.v_type_id||'',start:row.start_loc||'',dest1:row.dest1||'',dest2:row.dest2||'',dest3:row.dest3||'',rate:row.rate||0,validStart:row.valid_start||'',validEnd:row.valid_end||'',status:row.status||'',addedBy:row.added_by||'',approvedBy:row.approved_by||'',approvedAt:row.approved_at||''};
  if(tbl==='trips')        return {id:row.code,_dbId:row.id,bookedBy:row.booked_by||'',plant:row.plant||'',date:row.date||'',startLoc:row.start_loc||'',dest1:row.dest1||'',dest2:row.dest2||'',dest3:row.dest3||'',driverId:row.driver_id||'',vehicleId:row.vehicle_id||'',vehicleTypeId:row.vehicle_type_id||'',actualVehicleTypeId:row.actual_vehicle_type_id||'',vendor:row.vendor||'',desc:row.description||'',tripCatId:row.trip_cat_id||'',challans1:row.challans1||[],challan1:row.challan1||'',weight1:row.weight1||'',photo1:row.photo1||'',challans2:row.challans2||[],challan2:row.challan2||'',weight2:row.weight2||'',photo2:row.photo2||'',challans3:row.challans3||[],challan3:row.challan3||'',weight3:row.weight3||'',photo3:row.photo3||'',editedBy:row.edited_by||'',editedAt:row.edited_at||'',cancelled:row.cancelled||false};
  if(tbl==='segments')     return {id:row.code,_dbId:row.id,tripId:row.trip_id||'',label:row.label||'',sLoc:row.s_loc||'',dLoc:row.d_loc||'',criteria:row.criteria||1,tripCatId:row.trip_cat_id||'',steps:row.steps||{},status:row.status||'Active',date:row.date||'',currentStep:row.current_step||1};
  if(tbl==='spotTrips')    return {id:row.code,_dbId:row.id,vehicleNum:row.vehicle_num||'',supplier:row.supplier||'',challan:row.challan||'',challanPhoto:row.challan_photo||'',driverName:row.driver_name||'',driverMobile:row.driver_mobile||'',driverPhoto:row.driver_photo||'',entryVehiclePhoto:row.entry_vehicle_photo||'',entryRemarks:row.entry_remarks||'',date:row.date||'',entryTime:row.entry_time||'',entryBy:row.entry_by||'',location:row.location||'',exitTime:row.exit_time||'',exitBy:row.exit_by||'',exitVehiclePhoto:row.exit_vehicle_photo||'',exitRemarks:row.exit_remarks||''};
  if(tbl==='checkpoints')  return {id:row.code,_dbId:row.id,locationId:row.location_id||'',name:row.name||'',description:row.description||'',sortOrder:row.sort_order||1,active:row.active!==false};
  if(tbl==='guards')       return {id:row.code,_dbId:row.id,name:row.name||'',mobile:row.mobile||'',email:row.email||'',locationId:row.location_id||'',shift:row.shift||'',photo:row.photo||'',inactive:row.inactive||false};
  if(tbl==='roundSchedules') return {id:row.code,_dbId:row.id,name:row.name||'',locationId:row.location_id||'',guardId:row.guard_id||'',checkpointIds:row.checkpoint_ids||[],frequency:row.frequency||'Daily',startTime:row.start_time||'',endTime:row.end_time||'',inactive:row.inactive||false};
  if(tbl==='hwmsParts'){const p={id:row.code,_dbId:row.id,partNumber:row.part_number||'',partRevision:row.part_revision||'',description:row.description||'',status:row.status||'Active',netWeightKg:row.net_weight_kg||0,uom:row.uom||'',hsnCode:row.hsn_code||'',partPhoto:row.part_photo||'',packingType:row.packing_type||'',packingDimensions:row.packing_dimensions||'',qtyPerPackage:row.qty_per_package||0,packingWeight:row.packing_weight||0,packingPhoto:row.packing_photo||'',exWorksRate:row.ex_works_rate||0,freight:row.freight||0,warehouseCost:row.warehouse_cost||0,iccCost:row.icc_cost||0,finalRate:row.final_rate||0,rateValidFrom:_hwmsFixDate(row.rate_valid_from),rateValidTo:_hwmsFixDate(row.rate_valid_to),rates:(row.rates||[]).map(r=>({...r,validFrom:_hwmsFixDate(r.validFrom),validTo:_hwmsFixDate(r.validTo)}))};if(!p.rates.length&&p.exWorksRate){p.rates=[{exWorksRate:p.exWorksRate,freight:p.freight,warehouseCost:p.warehouseCost,iccCost:p.iccCost,finalRate:p.finalRate,validFrom:p.rateValidFrom,validTo:p.rateValidTo,createdAt:new Date().toISOString()}];}return p;}
  if(tbl==='hwmsInvoices') return {id:row.code,_dbId:row.id,invoiceNumber:row.invoice_number||'',date:row.date||'',containerId:row.container_id||'',containerNumber:row.container_number||'',delivery:row.delivery||'',paymentTerms:row.payment_terms||'',buyerId:row.buyer_id||'',buyerName:row.buyer_name||'',consigneeIdx:row.consignee_idx!=null?row.consignee_idx:-1,consigneeName:row.consignee_name||'',modeOfTransport:row.mode_of_transport||'',portOfLoadingId:row.port_of_loading_id||'',portOfLoading:row.port_of_loading||'',portOfDischargeId:row.port_of_discharge_id||'',portOfDischarge:row.port_of_discharge||'',countryOfDest:row.country_of_dest||'',lineItems:row.line_items||[],paymentStatus:row.payment_status||'',paymentNumber:row.payment_number||'',confirmed:row.confirmed||false};
  if(tbl==='hwmsContainers') return {id:row.code,_dbId:row.id,containerNumber:row.container_number||'',containerSerialNumber:row.container_serial_number||'',expectedPickupDate:row.expected_pickup_date||'',pickupDate:row.pickup_date||'',status:_hwmsNormContStatus(row.status),reachDate:row.reach_date||'',expectedReachDate:row.expected_reach_date||'',reachedDate:row.reached_date||'',carrierId:row.carrier_id||'',carrierName:row.carrier_name||'',carrierInvNumber:row.carrier_inv_number||'',carrierInvDate:row.carrier_inv_date||'',carrierInvAmount:row.carrier_inv_amount||0,carrierInvPhoto:row.carrier_inv_photo||'',entrySummaryNumber:row.entry_summary_number||'',esDate:row.es_date||'',esAmount:row.es_amount||0,esPhoto:row.es_photo||'',tariffPaid:row.tariff_paid||0,tariffPercent:row.tariff_percent||0,confirmed:row.confirmed||false};
  if(tbl==='hwmsHsn') return {id:row.code,_dbId:row.id,hsnNumber:row.hsn_number||'',description:row.description||''};
  if(tbl==='hwmsUom') return {id:row.code,_dbId:row.id,uom:row.uom||'',description:row.description||''};
  if(tbl==='hwmsPacking') return {id:row.code,_dbId:row.id,name:row.name||'',description:row.description||''};
  if(tbl==='hwmsCustomers'){
    const _buildC=(n,a,co,d)=>n?{name:n,address:a||'',country:co||'',isDefault:!!d}:null;
    const _cs=[
      _buildC(row.consignee1_name,row.consignee1_address,row.consignee1_country,row.consignee1_is_default),
      _buildC(row.consignee2_name,row.consignee2_address,row.consignee2_country,row.consignee2_is_default),
      _buildC(row.consignee3_name,row.consignee3_address,row.consignee3_country,row.consignee3_is_default),
    ].filter(Boolean);
    return {id:row.code,_dbId:row.id,customerName:row.customer_name||'',supplierCode:row.supplier_code||'',address:row.address||'',country:row.country||'',consignees:_cs,defaultTransport:row.default_transport||'',defaultPortDischarge:row.default_port_discharge||'',defaultPortLoading:row.default_port_loading||'',defaultDelivery:row.default_delivery||'',defaultPaymentTerms:row.default_payment_terms||''};
  }
  if(tbl==='hwmsPortDischarge') return {id:row.code,_dbId:row.id,name:row.name||'',country:row.country||''};
  if(tbl==='hwmsPortLoading') return {id:row.code,_dbId:row.id,name:row.name||'',country:row.country||''};
  if(tbl==='hwmsCarriers') return {id:row.code,_dbId:row.id,carrierName:row.carrier_name||'',address:row.address||'',contact:row.contact||''};
  if(tbl==='hwmsSteelRates') return {id:row.code,_dbId:row.id,customerId:row.cust_id||'',steelRate:row.steel_rate||0,forexRate:row.forex_rate||0,validFrom:row.valid_from||'',validTo:row.valid_to||''};
  if(tbl==='hwmsCompany') return {id:row.code,_dbId:row.id,companyName:row.company_name||'',address:row.address||'',gstin:row.gstin||'',iec:row.iec||'',rex:row.rex||'',supplierCode:row.supplier_code||'',placeReceipt:row.place_receipt||'',country:row.country||'India',note:row.note||''};
  if(tbl==='hwmsSubInvoices') return {id:row.code,_dbId:row.id,subInvoiceNumber:row.sub_invoice_number||'',date:row.date||'',invoiceId:row.invoice_id||'',customerId:row.customer_id||'',customerName:row.customer_name||'',lineItems:row.line_items||[],pickupStatus:row.pickup_status||'',pickupDate:row.pickup_date||'',grnStatus:row.grn_status||'',grnDate:row.grn_date||'',paymentStatus:row.payment_status||'',paymentReceived:row.payment_received||0,paymentBalance:row.payment_balance||0,paymentNumber:row.payment_number||'',paymentDate:row.payment_date||'',tariffPercent:row.tariff_percent||0,tariffAmount:row.tariff_amount||0,remarks:row.remarks||''};
  if(tbl==='hwmsMaterialRequests') return {id:row.code,_dbId:row.id,mrNumber:row.mr_number||'',mrDate:row.mr_date||'',needByDate:row.need_by_date||'',status:row.status||'',lineItems:row.line_items||[],remarks:row.remarks||'',createdBy:row.created_by||''};
  if(tbl==='hwmsPaymentReceipts') return {id:row.code,_dbId:row.id,paymentNumber:row.payment_number||'',paymentDate:row.payment_date||'',status:row.status||'',totalAmount:row.total_amount||0,lineItems:row.line_items||[],siUpdates:row.si_updates||[],miUpdates:row.mi_updates||[],manualPayments:row.manual_payments||[],createdAt:row.created_at||'',createdBy:row.created_by||'',updatedAt:row.updated_at||'',updatedBy:row.updated_by||''};
  return null;
}


// ═══ SUPABASE CONNECTION STATUS ════════════════════════════════════════════
// ── Supabase connection status helpers ────────────────────────────────────────

// Periodic Supabase connectivity check (every 30s) — auto-recovers on failure
let _sbPingTimer = null;
let _sbPingFails = 0;
function _sbStartPing(){
  if(_sbPingTimer) return;
  _sbPingTimer = setInterval(async ()=>{
    if(!_sbReady||!_sb) return;
    try{
      const {error} = await _sb.from(SB_TABLES['users']).select('code').limit(1);
      if(error){
        _sbPingFails++;
        console.warn('Ping error ('+_sbPingFails+'):', error.message);
        if(_sbPingFails>=3) _sbSetStatus('error', error.message);
      } else {
        // Success — reset fail counter, restore status if it was degraded
        if(_sbPingFails>0||_sbStatus!=='ok'){
          console.log('✅ Ping recovered after '+_sbPingFails+' failures');
          _sbSetStatus('ok');
        }
        _sbPingFails=0;
      }
    }catch(e){
      _sbPingFails++;
      console.warn('Ping exception ('+_sbPingFails+'):', e.message);
      if(_sbPingFails>=3){
        _sbSetStatus('offline','Unreachable');
        // Try to reinitialize Supabase client
        _initSupabase();
        if(_sbReady){
          console.log('Ping: Supabase re-initialized, retrying...');
          try{
            // Don't call full bootDB on ping recovery — just sync fresh data.
            // A full bootDB re-run causes a second visible DB connection event.
            _bgSyncFromSupabase();
            _sbSetStatus('ok');
            _sbPingFails=0;
            console.log('✅ Ping: auto-recovered');
          }catch(e2){ console.error('Ping: recovery failed', e2); }
        }
      }
    }
  }, 30000);
}
function _sbStopPing(){
  if(_sbPingTimer){ clearInterval(_sbPingTimer); _sbPingTimer=null; }
}


let _sbStatus = 'connecting'; // 'connecting' | 'ok' | 'error' | 'offline'
// _sbStatus already initialised above — no need to set it again on DOMContentLoaded.
function _sbSetStatus(state, msg) {
  _sbStatus = state;
  const cfg = {
    ok:          {dot:'#22c55e', label:'Connected',   bg:'rgba(34,197,94,.06)',  border:'rgba(34,197,94,.25)'},
    error:       {dot:'#ef4444', label:'Error',        bg:'rgba(239,68,68,.06)',  border:'rgba(239,68,68,.25)'},
    offline:     {dot:'#f59e0b', label:'Offline',      bg:'rgba(245,158,11,.06)', border:'rgba(245,158,11,.25)'},
    connecting:  {dot:'#d1d5db', label:'Connecting…', bg:'#f1f5f9',             border:'#e2e8f0'},
  };
  const c = cfg[state] || cfg.connecting;
  const lbl = msg || c.label;
  // Mobile topbar dot only
  const pulse = state==='connecting' ? 'sbPulse 1.2s ease-in-out infinite' : 'none';
  const d1=document.getElementById('ptConnDot');
  if(d1){ d1.style.background=c.dot; d1.style.animation=pulse; }
  // Sidebar
  const d2=document.getElementById('sbConnDot2'), l2=document.getElementById('sbConnLabel2'), w2=document.getElementById('sbConnWidget');
  if(d2){ d2.style.background=c.dot; d2.style.animation=pulse; }
  if(l2){ l2.textContent=lbl; l2.style.color=state==='ok'?'#15803d':state==='error'?'#dc2626':state==='offline'?'#92400e':'#475569'; }
  if(w2){ w2.style.background=c.bg; w2.style.borderColor=c.border; }
  // VMS topbar dot (existing)
  const d3=document.getElementById('sbStatusDot');
  if(d3){ d3.style.background=c.dot; d3.title='Supabase: '+lbl; }
  // VMS sidebar connection widget
  const dv=document.getElementById('vmsConnDot'), lv=document.getElementById('vmsConnLabel'), wv=document.getElementById('vmsConnWidget');
  if(dv){ dv.style.background=c.dot; dv.style.animation=pulse; }
  if(lv){ lv.textContent=lbl; lv.style.color=state==='ok'?'#15803d':state==='error'?'#dc2626':state==='offline'?'#92400e':'#475569'; }
  if(wv){ wv.style.background=c.bg; wv.style.borderColor=c.border; }
  // Login page connection widget
  const dl=document.getElementById('loginConnDot'), ll=document.getElementById('loginConnLabel'), wl=document.getElementById('loginConnWidget');
  if(dl){ dl.style.background=c.dot; dl.style.animation=pulse; }
  if(ll){ ll.textContent=lbl; ll.style.color=state==='ok'?'#15803d':state==='error'?'#dc2626':state==='offline'?'#92400e':'#475569'; }
  if(wl){ wl.style.background=c.bg; wl.style.borderColor=c.border; }
  // HWMS sidebar connection widget
  const dh=document.getElementById('hwmsConnDot'), lh=document.getElementById('hwmsConnLabel'), wh=document.getElementById('hwmsConnWidget');
  if(dh){ dh.style.background=c.dot; dh.style.animation=pulse; }
  if(lh){ lh.textContent=lbl; lh.style.color=state==='ok'?'#15803d':state==='error'?'#dc2626':state==='offline'?'#92400e':'#475569'; }
  if(wh){ wh.style.background=c.bg; wh.style.borderColor=c.border; }
  // Security sidebar connection widget
  const ds=document.getElementById('secConnDot'), ls=document.getElementById('secConnLabel'), ws=document.getElementById('secConnWidget');
  if(ds){ ds.style.background=c.dot; ds.style.animation=pulse; }
  if(ls){ ls.textContent=lbl; ls.style.color=state==='ok'?'#15803d':state==='error'?'#dc2626':state==='offline'?'#92400e':'#475569'; }
  if(ws){ ws.style.background=c.bg; ws.style.borderColor=c.border; }
  // Update login button state if function exists
  if(typeof _updateLoginBtnState==='function') _updateLoginBtnState();
  if(typeof _portalUpdateLoginBtn==='function') _portalUpdateLoginBtn();
  // Portal sidebar connection widget
  const dp=document.getElementById('portalConnDot'), lp2=document.getElementById('portalConnLabel'), wp=document.getElementById('portalConnWidget');
  if(dp){ dp.style.background=c.dot; dp.style.animation=pulse; }
  if(lp2){ lp2.textContent=lbl; lp2.style.color=state==='ok'?'#15803d':state==='error'?'#dc2626':state==='offline'?'#92400e':'#475569'; }
  if(wp){ wp.style.background=c.bg; wp.style.borderColor=c.border; }
}

// Seed Supabase tables with default data
async function _sbSeedAll(seedData) {
  for(const tbl of _getActiveTables()) {
    const rows = (seedData[tbl]||[]).map(r => _toRow(tbl, r)).filter(Boolean);
    if(!rows.length) continue;
    const {error} = await _sb.from(SB_TABLES[tbl]).upsert(rows, {onConflict:'code'});
    if(error) console.error('Seed error ['+tbl+']:', error.message);
  }
  console.log('Supabase seeded with defaults');
}


// ═══ LIVE DB TEST ═════════════════════════════════════════════════════════
// ── Live DB connection test (tap the status widget to run) ─────────────────────
async function _testDbConn(){
  _sbSetStatus('connecting');
  console.log('🔍 Testing Supabase connection...');
  console.log('   _sbReady='+_sbReady+' _sb='+!!_sb+' supabase_lib='+!!(window.supabase||window.Supabase));
  if(!_sbReady||!_sb){
    // Try reinitialising
    const ok = _initSupabase();
    if(!ok){
      _sbSetStatus('offline','No Client');
      notify('⚠ Supabase not initialised — check CDN or network', true);
      console.error('❌ Supabase client missing. window.supabase=', window.supabase);
      return;
    }
  }
  try{
    const {data, error} = await _sb.from(SB_TABLES['users']).select('code').limit(1);
    if(error){
      _sbSetStatus('error', error.message);
      notify('⚠ DB Error: '+error.message, true);
      console.error('❌ Test failed:', error);
    } else {
      // Connection works — reload ALL data from Supabase
      console.log('✅ Connection OK — syncing data from Supabase...');
      _sbSetStatus('ok');
      _sbStartRealtime();
      // Sync and show count AFTER data loads
      try{
        await new Promise(function(resolve){
          var _origDone = _bgSyncDone;
          _bgSyncFromSupabase();
          // Wait for bgSync to finish (poll briefly)
          var _wt=setInterval(function(){
            if(_bgSyncDone && _bgSyncDone!==_origDone){
              clearInterval(_wt);
              resolve();
            }
          },200);
          setTimeout(function(){ clearInterval(_wt); resolve(); }, 8000);
        });
      }catch(e){}
      notify('✅ Connected to Supabase! ('+DB.users.length+' users)');
      console.log('✅ Sync complete from Supabase. users='+DB.users.length);
    }
  }catch(e){
    _sbSetStatus('offline','Unreachable');
    notify('⚠ Unreachable: '+e.message, true);
    console.error('❌ Test exception:', e);
  }
}


// ═══ SUPABASE REALTIME ═════════════════════════════════════════════════════
// ── Supabase Realtime — cross-device live sync ────────────────────────────────
// Listens to postgres_changes on all VMS tables.
// When another device saves/deletes, we update in-memory DB and refresh views.
let _sbChannel = null;
let _sbRtEnabled = false;

function _sbStartRealtime(){
  if(!_sbReady||!_sb||_sbChannel) return;
  _startBgPoll(); // 10s hot-poll fallback in case a realtime event is missed
  try{
    // Subscribe ONLY to hot tables (trips, segments, spotTrips).
    // Subscribing to all 25 tables = 75 listeners on one channel, which causes
    // Supabase to throttle/drop events and introduces 10-15s delays.
    // Masters (users, vehicles, locations…) change rarely and don't need a live channel;
    // they are refreshed by the 60s full sync or on page navigation.
    const _RT_TABLES = ['trips','segments','spotTrips'];
    const ch = _sb.channel('vms-hot-sync');
    _RT_TABLES.forEach(tbl=>{
      const sbTbl = SB_TABLES[tbl];
      ch.on('postgres_changes',{event:'INSERT',schema:'public',table:sbTbl},(payload)=>{
        _rtApply(tbl,'upsert',payload.new);
      });
      ch.on('postgres_changes',{event:'UPDATE',schema:'public',table:sbTbl},(payload)=>{
        _rtApply(tbl,'upsert',payload.new);
      });
      ch.on('postgres_changes',{event:'DELETE',schema:'public',table:sbTbl},(payload)=>{
        _rtApply(tbl,'delete',payload.old);
      });
    });
    ch.subscribe((status)=>{
      if(status==='SUBSCRIBED'){
        _sbRtEnabled=true;
        console.log('Supabase Realtime: subscribed to hot tables ✓ (trips, segments, spotTrips)');
      } else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){
        _sbRtEnabled=false;
        console.warn('Supabase Realtime: channel issue —', status, '— will retry in 10s');
        setTimeout(function(){
          if(!_sbRtEnabled && _sbReady && _sb){
            console.log('Supabase Realtime: attempting reconnect...');
            _sbStopRealtime();
            _sbStartRealtime();
          }
        }, 10000);
      }
    });
    _sbChannel = ch;
  }catch(e){ console.warn('Realtime init error:', e.message); }
}

function _sbStopRealtime(){
  if(_sbChannel){
    try{ _sb.removeChannel(_sbChannel); }catch(e){}
    _sbChannel=null;
    _sbRtEnabled=false;
    console.log('Supabase Realtime: unsubscribed');
  }
}

// Force push ALL in-memory data to Supabase (recovery/sync tool)
async function _forceSyncAll(){
  if(!_sbReady||!_sb){ notify('⚠ No Supabase connection.', true); return; }
  notify('🔄 Syncing all data to Supabase…');
  _sbSetStatus('connecting');
  let saved=0, failed=0;
  for(const tbl of DB_TABLES){
    for(const rec of (DB[tbl]||[])){
      const row = _toRow(tbl, rec);
      if(!row) continue;
      try{
        const {error} = await _sb.from(SB_TABLES[tbl]).upsert(row, {onConflict:'code'}).select();
        if(error){ console.error('ForceSync error ['+tbl+']:', error.message); failed++; }
        else saved++;
      }catch(e){ console.error('ForceSync exception ['+tbl+']:', e.message); failed++; }
    }
  }
  if(failed===0){
    _sbSetStatus('ok');
    notify(`✅ Sync complete — ${saved} records pushed to Supabase`);
  } else {
    _sbSetStatus('error','Sync errors');
    notify(`⚠ Sync done — ${saved} saved, ${failed} failed. Check console.`, true);
  }
  // Restart realtime after sync
  if(!_sbChannel) _sbStartRealtime();
}

// Console diagnostic helper — type _diagSB() in browser console
window._diagSB = async function(){
  console.group('🔍 Supabase Diagnostics');
  console.log('_sbReady:', _sbReady, '| _sb:', !!_sb, '| _sbStatus:', _sbStatus);
  console.log('_sbRtEnabled:', _sbRtEnabled, '| _sbChannel:', !!_sbChannel);
  console.log('DB counts:', _getActiveTables().map(t=>t+'='+( DB[t]||[]).length).join(', '));
  if(_sbReady && _sb){
    try{
      const {data,error} = await _sb.from('vms_users').select('code').limit(3);
      if(error) console.error('❌ Test query error:', error.message);
      else console.log('✅ Test query OK — sample codes:', data?.map(r=>r.code));
    }catch(e){ console.error('❌ Test query exception:', e.message); }
    // Test write
    try{
      const testRow={code:'__diag_test__',name:'_diag',password:'x',full_name:'Diag Test',mobile:'',roles:[],hwms_roles:[],plant:'',apps:[],photo:'',inactive:true};
      const {error:we} = await _sb.from('vms_users').upsert(testRow,{onConflict:'code'}).select();
      if(we) console.error('❌ Test write error:', we.message);
      else{
        console.log('✅ Test write OK');
        // Clean up
        await _sb.from('vms_users').delete().eq('code','__diag_test__');
        console.log('✅ Test cleanup OK');
      }
    }catch(e){ console.error('❌ Test write exception:', e.message); }
  } else {
    console.warn('⚠ Supabase client not ready — check CDN load');
  }
  console.groupEnd();
};

// Apply a realtime event to in-memory DB and refresh relevant views
function _rtApply(tbl, action, row){
  console.log('⚡ Realtime '+action+' ['+tbl+']', (row&&(row.code||row.id))||'—');
  if(!row) return;
  if(action==='upsert'){
    const rec = _fromRow(tbl, row);
    if(!rec) return;
    if(!DB[tbl]) DB[tbl]=[];
    const idx = DB[tbl].findIndex(r=>r.id===rec.id);
    if(idx>=0){ DB[tbl][idx]=rec; } else { DB[tbl].push(rec); }
    // ── Sync CU when current user's record is updated via Realtime ──
    if(tbl==='users' && CU && rec.id===CU.id){
      Object.assign(CU,{fullName:rec.fullName,name:rec.name,mobile:rec.mobile,email:rec.email,password:rec.password,photo:rec.photo,roles:rec.roles,plant:rec.plant,apps:rec.apps,inactive:rec.inactive});
      _enrichCU();
      _refreshCurrentUserUI();
    }
  } else if(action==='delete'){
    // payload.old.code exists when REPLICA IDENTITY FULL is set (preferred)
    // payload.old.id is the integer PK (always present but not the JS string id)
    const code = row.code; // string code e.g. "5C09P2-01"
    const dbId = row.id;   // integer PK from Supabase
    if(!code && !dbId) return;
    if(DB[tbl]){
      if(code){
        DB[tbl] = DB[tbl].filter(r => r.id !== code);
      } else {
        // REPLICA IDENTITY not FULL — only integer PK available, match via _dbId
        DB[tbl] = DB[tbl].filter(r => r._dbId !== dbId);
      }
    }
  }
  // Refresh only the views that care about this table
  _rtRefreshFor(tbl);
}

// Debounced realtime refresh — collapses rapid events into one render.
// Only re-renders the CURRENTLY ACTIVE page (not every page at once),
// and skips entirely if a modal is open (user is interacting).
var _rtRefreshTimers = {};
function _rtRefreshFor(tbl){
  // Badges are always cheap — update immediately
  try{ if(typeof updBadges==='function') updBadges(); }catch(e){}
  // Debounce the expensive page render per table (200ms)
  clearTimeout(_rtRefreshTimers[tbl]);
  _rtRefreshTimers[tbl] = setTimeout(function(){
    try{
      // Skip page render while any modal is open
      if(document.querySelector('.modal-overlay.open')) return;
      const activePage = document.querySelector('.page.active');
      const pid = activePage ? activePage.id : '';
      const _try = fn => { try{ fn(); }catch(e){ console.warn('RT refresh error ['+tbl+']:', e.message); } };
      // Map each table to the page(s) that display it
      if(tbl==='trips'||tbl==='segments'||tbl==='spotTrips'){
        if(pid==='pageDashboard')   _try(()=>{ if(typeof renderDash==='function') renderDash(); });
        if(pid==='pageTripBooking') _try(()=>{ if(typeof renderTripBooking==='function') renderTripBooking(); });
        if(pid==='pageKapSecurity') _try(()=>{ if(typeof renderKapPage==='function') renderKapPage(); if(typeof renderKap==='function') renderKap(); });
        if(pid==='pageMR')          _try(()=>{ if(typeof renderMR==='function') renderMR(); });
        if(pid==='pageApprove')     _try(()=>{ if(typeof renderApprove==='function') renderApprove(); });
      }
      if(tbl==='spotTrips'){
        if(pid==='pageKapSecurity') _try(()=>{ if(typeof renderSpotHistory==='function') renderSpotHistory(); if(typeof renderSpotEntry==='function') renderSpotEntry(); });
      }
      if(tbl==='users'){
        if(pid==='pageUsers') _try(()=>{ if(typeof renderUsers==='function') renderUsers(); if(typeof psRenderUsers==='function') psRenderUsers(); });
      }
      if(tbl==='drivers'     && pid==='pageDrivers')   _try(()=>{ if(typeof renderDrivers==='function')   renderDrivers(); });
      if(tbl==='vendors'     && pid==='pageVendors')   _try(()=>{ if(typeof renderVendors==='function')   renderVendors(); });
      if(tbl==='vehicles'    && pid==='pageVehicles')  _try(()=>{ if(typeof renderVehicles==='function')  renderVehicles(); });
      if(tbl==='vehicleTypes'&& pid==='pageVTypes')    _try(()=>{ if(typeof renderVTypes==='function')    renderVTypes(); });
      if(tbl==='locations'   && pid==='pageLocations') _try(()=>{ if(typeof renderLocations==='function') renderLocations(); });
      if(tbl==='tripRates'   && pid==='pageTripRates') _try(()=>{ if(typeof renderRates==='function')     renderRates(); });
    }catch(e){ console.warn('_rtRefreshFor error ['+tbl+']:', e.message); }
  }, 200);
}

// ── Refresh all UI elements that display current user info ──────────────────
function _refreshCurrentUserUI(){
  if(!CU) return;
  const initials=(CU.fullName||CU.name||'').trim().split(/\s+/).map(w=>(w[0]||'')).slice(0,2).join('').toUpperCase()||'👤';
  // Sidebar name, role
  const uName2=document.getElementById('uName2'); if(uName2) uName2.textContent=CU.fullName||CU.name;
  const uRole2=document.getElementById('uRole2'); if(uRole2) uRole2.textContent=(CU.roles||[]).concat(CU.hwmsRoles||[]).join(', ');

  // ── Update ALL avatar elements across the app ──────────────────────────────
  // VMS sidebar avatars (background-image style)
  ['uAvatar','mobAvatar'].forEach(avId=>{
    const av=document.getElementById(avId); if(!av) return;
    av.textContent=initials; av.style.backgroundImage='';av.style.backgroundSize='';av.style.backgroundPosition='';
    if(CU.photo){
      av.style.backgroundImage=`url(${CU.photo})`;av.style.backgroundSize='cover';av.style.backgroundPosition='center';av.textContent='';
    }
  });

  // VMS Profile page avatar (background-image style)
  const profAv=document.getElementById('profileAvatar');
  if(profAv){
    profAv.textContent=initials;profAv.style.backgroundImage='';profAv.style.backgroundSize='';profAv.style.backgroundPosition='';
    if(CU.photo){
      profAv.style.backgroundImage=`url(${CU.photo})`;profAv.style.backgroundSize='cover';profAv.style.backgroundPosition='center';profAv.textContent='';
    }
  }

  // Portal sidebar avatar (innerHTML style)
  const psAv=document.getElementById('psAvatar');
  if(psAv){
    if(CU.photo){ psAv.innerHTML=`<img src="${CU.photo}" alt="">`; }
    else{ psAv.innerHTML='';psAv.textContent=initials;psAv.style.background='var(--accent)'; }
  }

  // Portal profile page avatar (background-image style)
  const psProfAv=document.getElementById('psProfileAvatar');
  if(psProfAv){
    psProfAv.textContent=initials;psProfAv.style.backgroundImage='';psProfAv.style.backgroundSize='';psProfAv.style.backgroundPosition='';
    if(CU.photo){
      psProfAv.style.backgroundImage=`url(${CU.photo})`;psProfAv.style.backgroundSize='cover';psProfAv.style.backgroundPosition='center';psProfAv.textContent='';
    }
    const cb=document.getElementById('psProfilePhotoClearBtn');
    if(cb) cb.style.display=CU.photo?'block':'none';
  }

  // Portal sidebar user card name
  const psUN=document.querySelector('.ps-user-name'); if(psUN) psUN.textContent=CU.fullName||CU.name||'';

  // Portal topbar avatar (innerHTML style)
  const psUserAv=document.getElementById('psUserAvatar');
  if(psUserAv){
    if(CU.photo){ psUserAv.innerHTML=`<img src="${CU.photo}" alt="">`; }
    else{ psUserAv.textContent=initials; }
  }

  // Mobile topbar avatar
  const ptav2=document.getElementById('ptUserAvatar');
  if(ptav2){
    if(CU.photo){ ptav2.innerHTML=`<img src="${CU.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`; }
    else{ ptav2.innerHTML='';ptav2.textContent=initials;ptav2.style.background='var(--accent)'; }
  }

  // Topbar user name/avatar
  if(typeof _updTopbarUser==='function') try{_updTopbarUser();}catch(e){}
}


// ═══ DATA LAYER ═══════════════════════════════════════════════════════════
// ===== DATA =====
// ─── SEED removed — all data lives in Supabase only ────────────────────────
const SEED = {
  users:[],vehicleTypes:[],drivers:[],vendors:[],vehicles:[],locations:[],
  tripRates:[],trips:[],segments:[],spotTrips:[],
  checkpoints:[],guards:[],roundSchedules:[],
  hwmsParts:[],hwmsInvoices:[],hwmsContainers:[],
  hwmsHsn:[],hwmsUom:[],hwmsPacking:[],hwmsCustomers:[],hwmsPortDischarge:[],
  hwmsPortLoading:[],hwmsCarriers:[],hwmsCompany:[],hwmsSteelRates:[]
};

// ═══════════════════════════════════════════════════════════════════════════════
// DATA LAYER — Supabase only (localStorage removed for DB tables)
// LS_PREFIX kept for session helpers (_sessionGet/_sessionSet/_sessionDel)
// ═══════════════════════════════════════════════════════════════════════════════

const LS_PREFIX = 'vms_';
const DB_TABLES = ['users','vehicleTypes','drivers','vendors','vehicles',
                   'locations','tripRates','trips','segments','spotTrips',
                   'checkpoints','guards','roundSchedules',
                   'hwmsParts','hwmsInvoices','hwmsContainers',
                   'hwmsHsn','hwmsUom','hwmsPacking',
                   'hwmsCustomers','hwmsPortDischarge','hwmsPortLoading','hwmsCarriers','hwmsCompany','hwmsSteelRates','hwmsSubInvoices','hwmsMaterialRequests','hwmsPaymentReceipts'];

// ── App-specific table filter ──
// Each app sets _APP_TABLES before boot to load only its own tables.
// If not set, falls back to DB_TABLES (all tables — backward compatible).
let _APP_TABLES = null;
function _getActiveTables(){ return _APP_TABLES || DB_TABLES; }

let DB = {};

// Session helpers
let _sessStore = {};
// Use localStorage for session — sessionStorage doesn't persist across file:// pages
const _sessionGet = k => { try{ return localStorage.getItem(k); }catch(e){ return _sessStore[k]||null; } };
const _sessionSet = (k,v) => { try{ localStorage.setItem(k,v); }catch(e){ _sessStore[k]=v; } };
const _sessionDel = k => { try{ localStorage.removeItem(k); }catch(e){ delete _sessStore[k]; } };

// saveDB: no-op — data is stored in Supabase only; in-memory DB serves the session
function saveDB(){ /* Supabase-only mode: no localStorage writes */ }

// ── Core async save/delete: Supabase-first ────────────────────────────────────
// All writes go to Supabase first. In-memory DB is updated ONLY on success.
// On failure: error toast shown, DB NOT updated, returns false.


// ═══ CORE DB OPERATIONS ═══════════════════════════════════════════════════
async function _dbSave(tbl, record){
  showSpinner('Saving…');
  try{
  if(!_sbReady || !_sb){
    console.error('❌ _dbSave('+tbl+'): Supabase not ready — _sbReady='+_sbReady+' _sb='+!!_sb);
    notify('⚠ No database connection — data not saved.', true);
    return false;
  }
  const row = _toRow(tbl, record);
  if(!row){ console.error('❌ _dbSave: _toRow returned null for', tbl, record); return false; }
  console.log('💾 _dbSave('+tbl+') id='+record.id+' →', SB_TABLES[tbl]);
  for(var _attempt=0;_attempt<2;_attempt++){
    try{
      const {data, error} = await _sb.from(SB_TABLES[tbl]).upsert(row, {onConflict:'code'}).select();
      if(error){
        if(_attempt===0){ console.warn('_dbSave retry after error:', error.message); continue; }
        console.error('❌ Supabase upsert error ['+tbl+']:', error.code, error.message, error.details, error.hint);
        notify('⚠ Save failed: ' + error.message, true);
        _sbSetStatus('error', 'Save error');
        return false;
      }
      console.log('✅ Saved ['+tbl+'] id='+record.id);
      break;
    } catch(e){
      if(_attempt===0){ console.warn('_dbSave retry after exception:', e.message); continue; }
      console.error('❌ Supabase upsert exception ['+tbl+']:', e.message);
      notify('⚠ Connection error — data not saved.', true);
      _sbSetStatus('error', 'Unreachable');
      return false;
    }
  }
  // Supabase confirmed — update in-memory DB
  if(!DB[tbl]) DB[tbl] = [];
  const idx = DB[tbl].findIndex(r => r.id === record.id);
  if(idx >= 0) DB[tbl][idx] = record; else DB[tbl].push(record);
  _sbSetStatus('ok');
  return true;
  }finally{ hideSpinner(); }
}

async function _dbDel(tbl, id){
  showSpinner('Deleting…');
  try{
  if(!_sbReady || !_sb){
    console.error('❌ _dbDel('+tbl+'): Supabase not ready — _sbReady='+_sbReady);
    notify('⚠ No database connection — delete not saved.', true);
    return false;
  }
  console.log('🗑 _dbDel('+tbl+') id='+id);
  for(var _attempt=0;_attempt<2;_attempt++){
    try{
      const {error} = await _sb.from(SB_TABLES[tbl]).delete().eq('code', id);
      if(error){
        if(_attempt===0){ console.warn('_dbDel retry after error:', error.message); continue; }
        console.error('❌ Supabase delete error ['+tbl+']:', error.code, error.message);
        notify('⚠ Delete failed: ' + error.message, true);
        _sbSetStatus('error', 'Delete error');
        return false;
      }
      console.log('✅ Deleted ['+tbl+'] id='+id);
      break;
    } catch(e){
      if(_attempt===0){ console.warn('_dbDel retry after exception:', e.message); continue; }
      console.error('❌ Supabase delete exception ['+tbl+']:', e.message);
      notify('⚠ Connection error — delete not saved.', true);
      _sbSetStatus('error', 'Unreachable');
      return false;
    }
  }
  if(DB[tbl]) DB[tbl] = DB[tbl].filter(r => r.id !== id);
  _sbSetStatus('ok');
  return true;
  }finally{ hideSpinner(); }
}




// ═══ BOOT DB ══════════════════════════════════════════════════════════════
async function bootDB(){
  showSpinner('Connecting to database…');
  try{
  _getActiveTables().forEach(k => DB[k] = []);

  // ── Step 1: localStorage handoff (cross-page navigation fast-path) ─────
  // _navigateTo() writes kap_db_cache to localStorage before every navigation.
  // localStorage is shared across ALL pages on the same device — including file://
  // where every .html file is its own origin and sessionStorage does NOT work.
  // Cache TTL is 60s and it is deleted after first read (one-time use).
  try{
    var _cached = localStorage.getItem('kap_db_cache');
    if(_cached){
      var _cObj = JSON.parse(_cached);
      var _age = Date.now() - (_cObj.ts||0);
      if(_age < 60000){
        _getActiveTables().forEach(function(t){ if(Array.isArray(_cObj[t])) DB[t]=_cObj[t]; });
        localStorage.removeItem('kap_db_cache');
        console.log('bootDB: instant from localStorage cache (~'+_age+'ms old) — users='+DB.users.length);
        if(typeof _migrateStep3Skip==='function') _migrateStep3Skip(); _onPostBoot();
        if(!_sbReady) _initSupabase();
        if(_sbReady && _sb){
          _sbSetStatus('ok');
          _sbStartRealtime(); // opens realtime WebSocket (lightweight)
          // Delay the full background sync — the page has fresh-enough data from the
          // cache. Firing 25 Supabase queries immediately causes the status widget to
          // flicker "connecting…" on every app switch. 3s delay is imperceptible.
          setTimeout(function(){ _bgSyncFromSupabase(); }, 3000);
        } else {
          // CDN not ready yet — wait for it, then sync (no immediate polling)
          // CDN not ready yet but we have cache data — don't show 'connecting'.
          // Quietly wait for CDN then sync in background without any status flicker.
          var _cacheReady=true;
          _startBgReconnect(_cacheReady);
        }
        return;
      } else {
        localStorage.removeItem('kap_db_cache');
      }
    }
  }catch(e){ console.warn('bootDB: cache read failed:', e.message); }

  // ── Step 2: Always load fresh from Supabase — no localStorage cache ─────
  // localStorage caching was removed: it caused stale data to be shown on
  // boot, competed with realtime events, and slowed perceived reactivity.
  if(!_sbReady) _initSupabase();
  if(!_sbReady){
    for(var _w2=0;_w2<10&&!_sbReady;_w2++){
      await new Promise(function(r){setTimeout(r,250)});
      _initSupabase();
    }
  }
  if(_sbReady && _sb){
    try{
      const _sm0=document.getElementById('splashMsg');if(_sm0)_sm0.textContent='Connecting to database…';
      // Each table fetch resolves independently; collect as they arrive
      var _timedOut = false;
      const _sbFetch = Promise.all(_getActiveTables().map(async tbl=>{
        try{
          const {data,error} = await _sb.from(SB_TABLES[tbl]).select('*');
          if(error){ console.warn('bootDB: table '+tbl+' error:', error.message); return {tbl, rows:[]}; }
          // Apply immediately so partial data is available if timeout fires
          DB[tbl] = (data||[]).map(r=>_fromRow(tbl,r)).filter(Boolean);
          return {tbl, rows: data||[]};
        }catch(e){ console.warn('bootDB: table '+tbl+' exception:', e.message); return {tbl, rows:[]}; }
      }));
      const _sbTimeout = new Promise(resolve=>setTimeout(()=>{ _timedOut=true; resolve('timeout'); },15000));
      const raceResult = await Promise.race([_sbFetch, _sbTimeout]);
      if(raceResult==='timeout'){
        // Some tables may have loaded — proceed with what we have, sync rest in background
        console.warn('bootDB: timeout after 15s — users='+DB.users.length+' (will retry remaining in background)');
        if(DB.users.length>0){
          _sbSetStatus('ok');
        } else {
          _sbSetStatus('connecting');
        }
        if(typeof _migrateStep3Skip==='function') _migrateStep3Skip(); _onPostBoot();
        _sbStartRealtime();
        // Retry full sync in background to pick up any tables that didn't make it
        setTimeout(function(){ _bgSyncFromSupabase(); }, 1000);
        return;
      }
      // All tables loaded within timeout
      raceResult.forEach(({tbl,rows})=>{
        DB[tbl] = rows.map(r=>_fromRow(tbl,r)).filter(Boolean);
      });
      console.log('bootDB: ready (Supabase) — users='+DB.users.length);
      _bgSyncDone=true;
      _sbSetStatus('ok');
      if(typeof _migrateStep3Skip==='function') _migrateStep3Skip(); _onPostBoot();
      _sbStartRealtime();
      return;
    }catch(e){
      console.warn('Supabase load failed:',e.message);
    }
  }

  // Supabase unavailable — start with empty DB, keep retrying in background
  console.warn('bootDB: Supabase unavailable — starting empty, will retry');
  _sbSetStatus('offline', 'Offline');
  if(typeof _migrateStep3Skip==='function') _migrateStep3Skip(); _onPostBoot();
  _startBgReconnect();
  }finally{ hideSpinner(); }
}

// Background sync: fetch hot tables FIRST (fast), then cold tables
var _bgSyncDone=false;
var _HOT_TABLES=['trips','segments','spotTrips'];

var _dbConnectCount=0;
function _bgSyncFromSupabase(){
  if(!_sbReady||!_sb) return;
  _bgSyncDone=false;
  _dbConnectCount++;
  console.log('📡 bgSync #'+_dbConnectCount+' start — caller: '+(new Error().stack.split('\n')[2]||'?').trim());
  Promise.all(_getActiveTables().map(async tbl=>{
    const {data,error} = await _sb.from(SB_TABLES[tbl]).select('*');
    if(error) return null;
    return {tbl, rows: data||[]};
  })).then(results=>{
    if(!results) return;
    results.filter(Boolean).forEach(({tbl,rows})=>{
      DB[tbl] = rows.map(r=>_fromRow(tbl,r)).filter(Boolean);
    });
    console.log('bgSync: full — users='+DB.users.length+' trips='+DB.trips.length+' segs='+DB.segments.length);
    _bgSyncDone=true;
    // Always set status to 'ok' after a successful sync — especially important when
    // boot timed out or cache was empty and status was still 'connecting'.
    if(_sbStatus!=='ok') _sbSetStatus('ok');
    // Update login button state in case users just loaded for the first time
    if(typeof _updateLoginBtnState==='function') _updateLoginBtnState();
    if(typeof _portalUpdateLoginBtn==='function') _portalUpdateLoginBtn();
    if(!_kapPopupOpen) _onRefreshViews();
  }).catch(e=>console.warn('bgSync error:',e.message));
}

// Hot sync: only trips/segments/spotTrips — ALWAYS refresh views (no flawed change detection)
function _bgSyncHot(){
  if(!_sbReady||!_sb) return;
  Promise.all(_HOT_TABLES.map(async tbl=>{
    const {data,error} = await _sb.from(SB_TABLES[tbl]).select('*');
    if(error) return null;
    return {tbl, rows: data||[]};
  })).then(results=>{
    if(!results) return;
    results.filter(Boolean).forEach(({tbl,rows})=>{
      DB[tbl]=rows.map(r=>_fromRow(tbl,r)).filter(Boolean);
    });
    _bgSyncDone=true;
    if(_sbStatus!=='ok') _sbSetStatus('ok');
    if(!_kapPopupOpen) _onRefreshViews();
  }).catch(e=>console.warn('bgSyncHot error:',e.message));
}

// Two-tier polling:
//   • Every 10s: hot tables only (trips, segments, spotTrips) — catches any
//     realtime events that were missed due to network glitches.
//   • Every 60s (6th tick): full sync of all tables — keeps masters fresh.
var _bgPollTimer=null;
var _bgPollCount=0;
function _startBgPoll(){
  if(_bgPollTimer) return;
  _bgPollTimer=setInterval(function(){
    if(_sbReady&&_sb&&_sbStatus==='ok'){
      _bgPollCount++;
      if(_bgPollCount%6===0){
        _bgSyncFromSupabase(); // full sync every ~60s
      } else {
        _bgSyncHot();          // hot tables every 10s
      }
    }
  }, 10000);
}

// ── Visibility-aware polling ─────────────────────────────────────────────
// Pauses all background Supabase queries when the browser tab is hidden
// (minimized, screen off, switched tab/app). Resumes + immediate sync when
// the user returns. Saves network traffic and battery on mobile devices.
(function(){
  var _visPaused=false;
  document.addEventListener('visibilitychange',function(){
    if(document.hidden){
      // Tab hidden → stop all polling
      if(_bgPollTimer){clearInterval(_bgPollTimer);_bgPollTimer=null;}
      if(_sbPingTimer){clearInterval(_sbPingTimer);_sbPingTimer=null;}
      _visPaused=true;
      console.log('⏸ Polling paused (tab hidden)');
    } else if(_visPaused){
      // Tab visible again → restart polling + immediate catch-up sync
      _visPaused=false;
      console.log('▶ Polling resumed (tab visible)');
      _startBgPoll();
      _sbStartPing();
      if(_sbReady&&_sb&&_sbStatus==='ok') _bgSyncFromSupabase();
    }
  });
})();

function _startBgReconnect(silentMode){
  // silentMode=true: called after a cache hit — we have data, don't flash status widget
  var _rcDone=false;
  function _tryConnect(){
    if(_rcDone) return;
    if(!_sbReady){ _initSupabase(); if(!_sbReady) _sbTryFallbackCDN(); }
    if(_sbReady && _sb){
      _sb.from(SB_TABLES['users']).select('code').limit(1).then(function(res){
        if(!res.error && !_rcDone){
          _rcDone=true;
          if(_rc){ clearInterval(_rc); _rc=null; }
          _sbStartRealtime();
          if(!silentMode){
            // First-time connect (no cache): sync now to load users + enable login button
            // _bgSyncFromSupabase will set status ok after data loads
            _bgSyncFromSupabase();
          } else {
            // After cache hit: already have data, start delayed background refresh.
            // Only show 'ok' if cache actually had users; otherwise wait for sync.
            if(DB.users && DB.users.length>0){
              _sbSetStatus('ok');
              setTimeout(function(){ if(_sbStatus==='ok') _bgSyncFromSupabase(); }, 5000);
            } else {
              // Cache was empty — sync immediately and let bgSync set status to 'ok'
              _bgSyncFromSupabase();
            }
          }
        }
      }).catch(function(){});
    }
  }
  // Listen for CDN script load — triggers immediately when CDN finishes
  var cdn=document.getElementById('sbCDN');
  if(cdn) cdn.addEventListener('load', function(){ setTimeout(_tryConnect, 50); });
  // Also poll every 1s as backup
  var _rc=setInterval(_tryConnect, 1000);
  setTimeout(function(){ clearInterval(_rc); }, 60000);
}


// ═══ CURRENT USER ═════════════════════════════════════════════════════════
// ── App boot ──────────────────────────────────────────────────────────────────

let CU=null; // current user — declared here so boot sequence can access it

// ═══ CONSTANTS ════════════════════════════════════════════════════════════
const ROLES=['Super Admin','Admin','Trip Booking User','KAP Security','Material Receiver','Trip Approver','Vendor'];
const HWMS_ROLES=['Super Admin','HWMS Admin','Supplier','WH Admin','WH User','Buyer','Buyer Coordinator'];
const PORTAL_APPS=[
  {id:'vms',    label:'VMS',        icon:'🚚', full:'Vehicle Management System'},
  {id:'hwms',   label:'HWMS',       icon:'📦', full:'HGAP Warehouse Management System'},
  {id:'security',label:'Security',  icon:'📹', full:'Security Surveillance'},
  {id:'maintenance',label:'Maint.', icon:'🔧', full:'Maintenance'},
  {id:'review', label:'Review',     icon:'⭐', full:'Employee Review'},
  {id:'hrms',   label:'HRMS',       icon:'👥', full:'HRMS'},
];
const PLANTS=[
  {value:'P1',label:'KAP1',colour:'#fecaca'},{value:'P2',label:'KAP2',colour:'#fed7aa'},
  {value:'P3',label:'KAP3',colour:'#fef08a'},{value:'P4',label:'KAP4',colour:'#bbf7d0'},
  {value:'P5',label:'KAP5',colour:'#b3dfe0'},{value:'P6',label:'KAP6',colour:'#e9d5ff'},
  {value:'P7',label:'KAP7',colour:'#fbcfe8'},{value:'P8',label:'KAP8',colour:'#ccfbf1'},
  {value:'P9',label:'KAP9',colour:'#fde68a'},
];
// CU declared above
let _adminLocFilter=''; // '' = All Locations; else = location ID (KAP type only). Admin/SA only.


// ═══ UTILITIES ════════════════════════════════════════════════════════════
// ===== UTILS =====
const uid=()=>Math.random().toString(36).substring(2,11);
const byId=(arr,id)=>arr.find(x=>x&&x.id===id);
// Sort array by label for dropdown population
const sortBy=(arr,fn)=>[...arr].sort((a,b)=>fn(a).localeCompare(fn(b)));
// Colour-aware location name for UI display (returns HTML span)
const lname=(id)=>{
  const l=byId(DB.locations,id);
  if(!l)return'?';
  if(l.colour)return`<span style="background:${l.colour};color:${colourContrast(l.colour)};padding:1px 7px;border-radius:5px;font-weight:700;white-space:nowrap">${l.name}</span>`;
  return l.name;
};
const lnameText=(id)=>byId(DB.locations,id)?.name||'?';
// Unified trip card header — used on ALL pages for consistent display
// actions = optional HTML for right side; noVehEdit = true to disable vehicle click
function tripCardHeader(trip, actions, noVehEdit){
  if(!trip)return '';
  const vn=vnum(trip.vehicleId);
  const vt=vtype(trip.vehicleId);
  const bookedBy=byId(DB.users,trip.bookedBy);
  const bookedName=bookedBy?.fullName||bookedBy?.name||'-';
  const hasVeh=vn&&vn!=='-';
  const tripStarted=DB.segments.filter(s=>s.tripId===trip.id).some(s=>[1,2,3,4].some(n=>s.steps[n]?.done));
  const canEditVeh=!noVehEdit&&!tripStarted;
  const vehClick=canEditVeh?` style="cursor:pointer" onclick="openQuickVeh('${trip.id}')" title="Click to change vehicle"`:'';
  const _locs=[trip.startLoc,trip.dest1,trip.dest2,trip.dest3].filter(Boolean);
  let _typeBadge='';
  if(_locs.length>=2){
    const finalDest=_locs[_locs.length-1];
    if(_locs.length>2&&finalDest===_locs[0]) _typeBadge='<span style="background:#b3dfe0;color:#175c60;font-weight:800;font-size:11px;padding:2px 8px;border-radius:12px">🔄 Return</span>';
    else if(_locs.length>2) _typeBadge='<span style="background:#e9d5ff;color:#6b21a8;font-weight:800;font-size:11px;padding:2px 8px;border-radius:12px">📍 Multi</span>';
    else _typeBadge='<span style="background:#bbf7d0;color:#14532d;font-weight:800;font-size:11px;padding:2px 8px;border-radius:12px">➡ One Way</span>';
  }
  const _arrow='<span style="color:var(--accent);font-weight:900;font-size:12px;margin:0 3px">⟶</span>';
  const _route=_locs.map(id=>lname(id)).join(_arrow);
  return `<div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:nowrap;margin-bottom:2px;min-width:0">
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap">
        <span style="font-family:var(--mono);font-size:clamp(24px,7vw,36px);font-weight:900;color:#fff;background:var(--accent);padding:4px 14px;border-radius:9px;letter-spacing:.5px;display:inline-block;white-space:nowrap">${trip.id}</span>
        <div${vehClick} style="flex:1;min-width:0"><span style="font-family:var(--mono);font-size:clamp(24px,7vw,36px);font-weight:900;color:var(--text);background:var(--surface2);border:2px solid var(--border);padding:4px 14px;border-radius:9px;letter-spacing:.5px;display:inline-block;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis">${hasVeh?vn:'<span class="flash-red" style="font-family:var(--mono);font-size:clamp(11px,3vw,14px);font-weight:900;letter-spacing:0;cursor:pointer;padding:3px 8px;border-radius:6px">Select Vehicle</span>'}</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:5px;font-size:12px"><span style="color:var(--text3)">Booked by:</span><span style="font-weight:700;color:var(--text2)">${bookedName}</span><span style="color:var(--border2)">·</span><span style="color:var(--text3)">📅 ${fdt(trip.date)}</span>${hasVeh?`<span style="color:var(--border2)">·</span><span style="font-size:11px;font-weight:700;color:#16a34a">${vt}</span>`:""}</div>
    </div>
    ${actions?`<div style="margin-left:auto;display:flex;gap:6px;align-items:center;flex-shrink:0">${actions}</div>`:''}
  </div>
  <div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px;margin-bottom:4px">${_typeBadge} ${_route}</div>`; 
}
// Build location <option> text — plain name only (HTML options can't show background colour)
function locOptText(l){
  return l.name+(l.type?` (${l.type})`:'');
}
// Sort locations: KAP first (alphabetical), then External (alphabetical)
function sortLocsKapFirst(locs){
  return [...locs].sort((a,b)=>{
    const aKap=a.type==='KAP'?0:1;
    const bKap=b.type==='KAP'?0:1;
    if(aKap!==bKap) return aKap-bKap;
    return (a.name||'').localeCompare(b.name||'');
  });
}
const ltype=(id)=>byId(DB.locations,id)?.type||'?';

// ── Location & step-access helpers ──────────────────────────────────────────
// Find the primary location a user is explicitly assigned to (by membership)
function getUserLocation(userId){
  if(!userId) return null;
  for(const loc of DB.locations){
    if(loc.inactive) continue;
    if(loc.kapSec===userId) return loc;
    if((loc.tripBook||[]).includes(userId)) return loc;
    if((loc.matRecv||[]).includes(userId)) return loc;
    if((loc.approvers||[]).includes(userId)) return loc;
  }
  return null;
}
// Enrich CU with locId / locType / locName after login
function _enrichCU(){
  if(!CU) return;
  const loc=getUserLocation(CU.id)||byId(DB.locations,CU.plant)||null;
  CU.locId=loc?.id||null;
  CU.locType=loc?.type||'';
  CU.locName=loc?.name||'';
}
// Auto-sync: when a user is saved with roles + plant, ensure they appear in
// the corresponding Location Master role arrays.
async function _syncUserToLocation(userId, plantId, roles){
  if(!userId||!plantId) return;
  const targetLoc=byId(DB.locations,plantId);
  if(!targetLoc||targetLoc.type!=='KAP') return;
  const roleMap={'KAP Security':'kapSec','Trip Booking User':'tripBook','Material Receiver':'matRecv','Trip Approver':'approvers'};
  const userRoles=new Set(roles||[]);
  let locChanged=false;
  Object.entries(roleMap).forEach(([roleName,locField])=>{
    const hasRole=userRoles.has(roleName);
    if(locField==='kapSec'){
      if(hasRole&&targetLoc.kapSec!==userId){targetLoc.kapSec=userId;locChanged=true;}
      else if(!hasRole&&targetLoc.kapSec===userId){targetLoc.kapSec='';locChanged=true;}
    } else {
      const arr=targetLoc[locField]||[];
      if(hasRole&&!arr.includes(userId)){arr.push(userId);targetLoc[locField]=arr;locChanged=true;}
      else if(!hasRole&&arr.includes(userId)){targetLoc[locField]=arr.filter(id=>id!==userId);locChanged=true;}
    }
  });
  if(locChanged) await _dbSave('locations',targetLoc);
  const otherLocs=DB.locations.filter(l=>l.id!==plantId&&l.type==='KAP');
  for(const ol of otherLocs){
    let olChanged=false;
    Object.entries(roleMap).forEach(([roleName,locField])=>{
      if(locField==='kapSec'){if(ol.kapSec===userId){ol.kapSec='';olChanged=true;}}
      else{const arr=ol[locField]||[];if(arr.includes(userId)){ol[locField]=arr.filter(id=>id!==userId);olChanged=true;}}
    });
    if(olChanged) await _dbSave('locations',ol);
  }
}
// Central step-access check — location membership, not static users array
function canDoStep(seg, stepNum){
  if(!CU) return false;
  const isSA=CU.roles.some(r=>['Super Admin','Admin'].includes(r));
  if(isSA) return true;
  const step=seg.steps[stepNum];
  if(!step||step.skip||step.done) return false;
  const ownerLocId=step.ownerLoc;
  if(!ownerLocId) return false;
  const loc=byId(DB.locations,ownerLocId);
  if(!loc) return false;
  if(stepNum===1||stepNum===2||stepNum===5) return loc.kapSec===CU.id;
  if(stepNum===3) return (loc.matRecv||[]).includes(CU.id);
  if(stepNum===4) return (loc.approvers||[]).includes(CU.id);
  return false;
}
const uname=(id)=>{const u=byId(DB.users,id);return u?(u.fullName||u.name):'-';};
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fd=(d)=>{
  if(!d)return '-';
  const dt=new Date(d.length===10?d+'T00:00:00':d);
  if(isNaN(dt))return '-';
  return `${String(dt.getDate()).padStart(2,'0')}-${MONTHS[dt.getMonth()]}-${String(dt.getFullYear()).slice(2)}`;
};
// Date + Time formatter: dd-MMM-yy hh:mm AM
const fdt=(d)=>{
  if(!d)return '-';
  const dt=new Date(d.length===10?d+'T00:00:00':d);
  if(isNaN(dt))return '-';
  const dd=String(dt.getDate()).padStart(2,'0');
  const mon=MONTHS[dt.getMonth()];
  const yy=String(dt.getFullYear()).slice(2);
  let h=dt.getHours();const ampm=h>=12?'PM':'AM';h=h%12||12;
  const mm=String(dt.getMinutes()).padStart(2,'0');
  return `${dd}-${mon}-${yy} ${h}:${mm} ${ampm}`;
};
// Date-only formatter for HWMS (no time)
const _fdate=(d)=>{
  if(!d)return '—';
  const dt=new Date(d.length===10?d+'T00:00:00':d);
  if(isNaN(dt))return '—';
  return String(dt.getDate()).padStart(2,'0')+'-'+MONTHS[dt.getMonth()]+'-'+String(dt.getFullYear()).slice(2);
};
// Date status: red=expired, orange=within 3 months, green=ok
function dateStatusHtml(dateStr){
  if(!dateStr||dateStr==='-') return '<span style="color:var(--text3)">—</span>';
  const d=new Date(dateStr+'T00:00:00');if(isNaN(d)) return dateStr;
  const now=new Date();now.setHours(0,0,0,0);
  const m3=new Date(now);m3.setMonth(m3.getMonth()+3);
  const label=fd(dateStr);
  if(d<now) return `<span class="flash-red">${label}</span>`;
  if(d<=m3) return `<span style="animation:flashOrange 1.2s ease-in-out infinite;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700">${label}</span>`;
  return `<span style="color:#16a34a;font-weight:600;font-size:11px">${label}</span>`;
}
const bvt=(vehicleId)=>{const t=vtype(vehicleId);return t&&t!=='-'?`<strong style="font-weight:800;color:#16a34a">${t}</strong>`:t;};
const vtname=(id)=>byId(DB.vehicleTypes,id)?.name||'-';
const vnum=(id)=>byId(DB.vehicles,id)?.number||'-';
const vtype=(vehicleId)=>{const v=byId(DB.vehicles,vehicleId);return v?vtname(v.typeId):'-';};
// Find matching trip rate for a trip (by vehicle type + route) on the trip's booking date
function tripRate(trip){
  if(!trip) return null;
  // Rate is ALWAYS calculated on recommended vehicle type (vehicleTypeId)
  // Fall back to actual vehicle's type for legacy trips that predate this field
  const recTypeId=trip.vehicleTypeId||(byId(DB.vehicles,trip.vehicleId)?.typeId)||null;
  if(!recTypeId) return null;
  const bookDate=trip.date?trip.date.split('T')[0]:new Date().toISOString().split('T')[0];
  return DB.tripRates.find(r=>
    (r.status==='approved'||!r.status) &&
    r.vTypeId===recTypeId &&
    r.start===trip.startLoc &&
    r.dest1===trip.dest1 &&
    (r.dest2||'')===(trip.dest2||'') &&
    (r.dest3||'')===(trip.dest3||'') &&
    r.validStart<=bookDate && r.validEnd>=bookDate
  )||null;
}
function getMatchedRate(tripId){ return tripRate(byId(DB.trips,tripId)); }



// ═══ COLOUR CONTRAST HELPER ═══════════════════════════════════════════════
function colourContrast(hex){
  if(!hex)return'#1f2937';
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return(r*299+g*587+b*114)/1000>128?'#1f2937':'#ffffff';
}

// ═══ NOTIFICATION & MODAL HELPERS ═════════════════════════════════════════
function notify(msg,err=false){
  const n=document.getElementById('notification');
  n.textContent=msg;n.className='notification show'+(err?' error':'');
  setTimeout(()=>n.className='notification',err?5000:3000);
}
// Show error inside a modal footer (inline, near submit button)
function modalErr(modalId,msg){
  const el=document.getElementById('merr_'+modalId);
  if(!el){notify(msg,true);return;} // fallback to toast if no inline div
  el.textContent='⚠ '+msg;el.style.display='block';
  setTimeout(()=>{el.style.display='none';},4000);
}
// Clear modal error
function modalErrClear(modalId){
  const el=document.getElementById('merr_'+modalId);if(el)el.style.display='none';
}
function om(id){const el=document.getElementById(id);if(el){el.style.display='flex';el.classList.add('open');modalErrClear(id);}else console.error('om: missing modal id='+id);}
function cm(id){const el=document.getElementById(id);if(el){el.style.display='none';el.classList.remove('open');}else console.error('cm: missing modal id='+id);}
function showConfirm(msg, onOk, opts){
  // opts: {icon, title, btnLabel, btnColor}
  const o=opts||{};
  const el=id=>document.getElementById(id);
  const iconEl=el('confirmIcon'), titleEl=el('confirmTitle'), msgEl=el('confirmMsg'), btnEl=el('btnConfirmOk');
  if(iconEl) iconEl.textContent=o.icon||'❓';
  if(titleEl) titleEl.textContent=o.title||'Are you sure?';
  if(msgEl) msgEl.textContent=msg||'This action cannot be undone.';
  if(btnEl){
    btnEl.textContent=o.btnLabel||'Confirm';
    btnEl.style.background=o.btnColor||'#ef4444';
  }
  if(btnEl) btnEl.onclick=()=>{cm('mConfirm');onOk();};
  om('mConfirm');
}

// Global spinner (ref-counted)
var _spinCount=0;
function _spin(show, msg){
  if(show) _spinCount++; else _spinCount=Math.max(0,_spinCount-1);
  var el=document.getElementById('_globalSpin');
  if(!el) return;
  if(_spinCount>0){
    el.style.display='flex';
    var m=document.getElementById('_spinMsg');
    if(m && msg) m.textContent=msg;
  } else {
    el.style.display='none';
  }
}

// Navigate to another page — covers screen with white overlay to prevent content flash
function _navigateTo(url){
  // Serialize current in-memory DB to localStorage before navigating.
  // The destination page reads this cache in bootDB() and boots instantly
  // without re-fetching from Supabase — eliminating the "connecting" splash
  // on every page transition in both directions (Portal→App and App→Portal).
  try{
    if(typeof DB!=='undefined' && typeof DB_TABLES!=='undefined' && DB.users && DB.users.length){
      var cache={ts:Date.now()};
      _getActiveTables().forEach(function(t){ cache[t]=DB[t]||[]; });
      localStorage.setItem('kap_db_cache', JSON.stringify(cache));
    }
  }catch(e){ console.warn('_navigateTo: cache write failed', e.message); }
  var ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;background:#f8fafc;z-index:999999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px';
  ov.innerHTML='<div style="width:40px;height:40px;border:4px solid rgba(42,154,160,.2);border-top-color:#2a9aa0;border-radius:50%;animation:spin .7s linear infinite"></div><div style="color:#64748b;font-size:13px;font-weight:600">Loading…</div>';
  document.body.appendChild(ov);
  setTimeout(function(){ window.location.href=url; }, 50);
}


// ═══ ROLE CHECK ═══════════════════════════════════════════════════════════
function hasRole(roles){if(!CU)return false;if(CU.roles.includes('Super Admin')||CU.roles.includes('Admin'))return true;var allRoles=(CU.roles||[]).concat(CU.hwmsRoles||[]);return roles.some(r=>allRoles.includes(r));}

// ═══ PASSWORD POLICY ═════════════════════════════════════════════════════
function _pwdErrors(pwd){
  const errs=[];
  if(!pwd||pwd.length<6) errs.push('Minimum 6 characters');
  if(pwd&&pwd.length>12) errs.push('Maximum 12 characters');
  if(!/[A-Z]/.test(pwd||'')) errs.push('One uppercase letter (A-Z)');
  if(!/[a-z]/.test(pwd||'')) errs.push('One lowercase letter (a-z)');
  if(!/[0-9]/.test(pwd||'')) errs.push('One number (0-9)');
  if(!/[^A-Za-z0-9]/.test(pwd||'')) errs.push('One special character');
  return errs;
}

// ═══ IMAGE COMPRESSION ════════════════════════════════════════════════════
async function compressImage(file,maxKB=100){
  return new Promise(res=>{
    const img=new Image();
    const url=URL.createObjectURL(file);
    img.onload=()=>{
      URL.revokeObjectURL(url);
      let w=img.width,h=img.height;
      // iOS Safari canvas limit ~16MP (4096×4096). Pre-scale to 1920px max BEFORE
      // any canvas op to avoid "low memory" / blank canvas on high-res phone cameras.
      const MAX_SAFE=1920;
      if(w>MAX_SAFE||h>MAX_SAFE){
        const ratio=Math.min(MAX_SAFE/w,MAX_SAFE/h);
        w=Math.round(w*ratio);h=Math.round(h*ratio);
      }
      const canvas=document.createElement('canvas');
      canvas.width=w;canvas.height=h;
      const ctx=canvas.getContext('2d');
      ctx.drawImage(img,0,0,w,h);
      // Now scale further down to 900px target for 100KB output
      const MAX_DIM=900;
      if(w>MAX_DIM||h>MAX_DIM){
        const ratio2=Math.min(MAX_DIM/w,MAX_DIM/h);
        w=Math.round(w*ratio2);h=Math.round(h*ratio2);
        canvas.width=w;canvas.height=h;
        canvas.getContext('2d').drawImage(img,0,0,w,h);
      }
      // Step quality down until under maxKB
      const threshold=maxKB*1024*1.37*1.1;
      let quality=0.82;
      let dataUrl=canvas.toDataURL('image/jpeg',quality);
      while(dataUrl.length>threshold&&quality>0.2){
        quality=Math.round((quality-0.08)*100)/100;
        if(quality<0.45){
          w=Math.round(w*0.85);h=Math.round(h*0.85);
          canvas.width=w;canvas.height=h;
          canvas.getContext('2d').drawImage(img,0,0,w,h);
        }
        dataUrl=canvas.toDataURL('image/jpeg',quality);
      }
      res(dataUrl);
    };
    img.onerror=()=>{ URL.revokeObjectURL(url); res(''); };
    img.src=url;
  });
}

// ═══ EXCEL / CSV CORE UTILITIES ═══════════════════════════════════════════
// ── Safe download trigger ─────────────────────────────────────────────────────
function _triggerDownload(blob,filename){
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=filename;
  a.style.display='none';
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},200);
}

// ── Real XLSX export (OOXML + ZIP, no dependencies) ──────────────────────────
function _crc32(bytes){
  if(!_crc32._t){_crc32._t=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);_crc32._t[i]=c;}}
  let c=-1;for(let i=0;i<bytes.length;i++)c=_crc32._t[(c^bytes[i])&0xFF]^(c>>>8);return(c^-1)>>>0;
}
function _xlCol(n){let s='',i=n+1;while(i>0){i--;s=String.fromCharCode(65+(i%26))+s;i=Math.floor(i/26);}return s;}
function _buildZipBlob(files,mimeType){
  const enc=new TextEncoder();const parts=[];const cd=[];let off=0;
  for(const[name,content]of Object.entries(files)){
    const nb=enc.encode(name);const db=typeof content==='string'?enc.encode(content):content;
    const crc=_crc32(db);const sz=db.length;
    const lfh=new Uint8Array(30+nb.length);const lv=new DataView(lfh.buffer);
    lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0,true);lv.setUint16(8,0,true);
    lv.setUint16(10,0,true);lv.setUint16(12,0,true);lv.setUint32(14,crc,true);
    lv.setUint32(18,sz,true);lv.setUint32(22,sz,true);lv.setUint16(26,nb.length,true);lv.setUint16(28,0,true);
    lfh.set(nb,30);
    const cde=new Uint8Array(46+nb.length);const cv=new DataView(cde.buffer);
    cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0,true);
    cv.setUint16(10,0,true);cv.setUint16(12,0,true);cv.setUint16(14,0,true);cv.setUint32(16,crc,true);
    cv.setUint32(20,sz,true);cv.setUint32(24,sz,true);cv.setUint16(28,nb.length,true);cv.setUint16(30,0,true);
    cv.setUint16(32,0,true);cv.setUint16(34,0,true);cv.setUint16(36,0,true);cv.setUint32(38,0,true);cv.setUint32(42,off,true);
    cde.set(nb,46);parts.push(lfh,db);cd.push(cde);off+=lfh.length+sz;
  }
  const cdSz=cd.reduce((s,b)=>s+b.length,0);const eocd=new Uint8Array(22);const ev=new DataView(eocd.buffer);
  ev.setUint32(0,0x06054b50,true);ev.setUint16(4,0,true);ev.setUint16(6,0,true);ev.setUint16(8,cd.length,true);
  ev.setUint16(10,cd.length,true);ev.setUint32(12,cdSz,true);ev.setUint32(16,off,true);ev.setUint16(20,0,true);
  return new Blob([...parts,...cd,eocd],{type:mimeType||'application/octet-stream'});
}
function _downloadAsXlsx(data,sheetName,filename){
  const ex=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  // Build shared string table for text cells
  const sstArr=[];const sstMap=new Map();
  function sstIdx(s){const k=String(s);if(sstMap.has(k))return sstMap.get(k);const i=sstArr.length;sstArr.push(k);sstMap.set(k,i);return i;}
  let rowsXml='';
  data.forEach((row,ri)=>{
    const cells=Array.isArray(row)?row:Object.values(row);
    rowsXml+=`<row r="${ri+1}">`;
    cells.forEach((cell,ci)=>{
      const ref=_xlCol(ci)+(ri+1);const v=cell===null||cell===undefined?'':cell;
      const num=Number(v);
      if(typeof v==='number'||(!isNaN(num)&&String(v).trim()!=='')) rowsXml+=`<c r="${ref}" s="${ri===0?1:0}"><v>${typeof v==='number'?v:num}</v></c>`;
      else{const si=sstIdx(String(v));rowsXml+=`<c r="${ref}" t="s" s="${ri===0?1:0}"><v>${si}</v></c>`;}
    });
    rowsXml+='</row>';
  });
  const colCount=Array.isArray(data[0])?data[0].length:Object.keys(data[0]||{}).length;
  const rowCount=data.length;
  const dimRef='A1:'+_xlCol(Math.max(0,colCount-1))+rowCount;
  // Shared string table XML
  const sstXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="'+sstArr.length+'" uniqueCount="'+sstArr.length+'">'
    +sstArr.map(s=>'<si><t>'+ex(s)+'</t></si>').join('')+'</sst>';
  // Worksheet XML — correct element order per OOXML spec: dimension, sheetViews, sheetFormatPr, cols, sheetData, autoFilter
  // Build cols with reasonable default widths based on header length
  let colsXml='<cols>';
  for(let ci=0;ci<colCount;ci++){
    var hdr=Array.isArray(data[0])?(data[0][ci]||''):Object.keys(data[0]||{})[ci]||'';
    var w=Math.max(10,Math.min(40,String(hdr).length*1.3+4));
    colsXml+='<col min="'+(ci+1)+'" max="'+(ci+1)+'" width="'+w.toFixed(1)+'" bestFit="1" customWidth="1"/>';
  }
  colsXml+='</cols>';
  const sheetXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    +' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    +'<dimension ref="'+dimRef+'"/>'
    +'<sheetViews><sheetView workbookViewId="0" tabSelected="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    +'<sheetFormatPr defaultRowHeight="15"/>'
    +colsXml
    +'<sheetData>'+rowsXml+'</sheetData>'
    +(colCount>0?'<autoFilter ref="A1:'+_xlCol(colCount-1)+rowCount+'"/>':'')
    +'</worksheet>';
  const stylesXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    +'<fonts count="2"><font><sz val="10"/><name val="Calibri"/></font><font><sz val="10"/><b/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>'
    +'<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    +'<fill><patternFill patternType="solid"><fgColor rgb="FF1e2028"/></patternFill></fill></fills>'
    +'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    +'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    +'<cellXfs count="2">'
    +'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    +'<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    +'</cellXfs></styleSheet>';
  const wbXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    +'<bookViews><workbookView/></bookViews>'
    +'<sheets><sheet name="'+ex(sheetName||'Sheet1')+'" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const files={
    '[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    '_rels/.rels':'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':wbXml,
    'xl/styles.xml':stylesXml,
    'xl/sharedStrings.xml':sstXml,
    'xl/_rels/workbook.xml.rels':'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':sheetXml,
  };
  const blob=_buildZipBlob(files,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  _triggerDownload(blob,filename||((sheetName||'Export')+'.xlsx'));
}
// Keep _downloadAsXls as alias for backwards compat (trip report)
function _downloadAsXls(data,sheetName,filename){_downloadAsXlsx(data,sheetName,filename?filename.replace(/\.xls$/,'.xlsx'):filename);}


// ── CSV parser (no external lib needed) ────────────────────────────────────
// ── CSV parser ────────────────────────────────────────────────────────────────
function _parseCSV(text){
  const lines=text.split(/\r?\n/);
  if(!lines.length) return [];
  const parseRow=line=>{
    const cells=[];let cur='',inQ=false;
    for(let i=0;i<line.length;i++){
      const c=line[i];
      if(c==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ;}
      else if(c===','&&!inQ){cells.push(cur);cur='';}
      else cur+=c;
    }
    cells.push(cur);
    return cells;
  };
  const headers=parseRow(lines[0]);
  const rows=[];
  for(let i=1;i<lines.length;i++){
    if(!lines[i].trim()) continue;
    const vals=parseRow(lines[i]);
    const obj={};
    headers.forEach((h,idx)=>{ obj[h.trim()]=vals[idx]!==undefined?vals[idx].trim():''; });
    rows.push(obj);
  }
  return rows;
}

// ── Pure-JS XLSX parser (ZIP + XML, no external library) ─────────────────────
function _u16(b,o){return b[o]|(b[o+1]<<8);}
function _u32(b,o){return((b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0);}

async function _parseXLSX(arrayBuffer){
  const bytes=new Uint8Array(arrayBuffer);

  // ── 1. Find End-of-Central-Directory (supports zip64 comment) ───────────
  let eocd=-1;
  for(let i=Math.max(0,bytes.length-65558);i<=bytes.length-22;i++){
    if(bytes[i]===0x50&&bytes[i+1]===0x4B&&bytes[i+2]===0x05&&bytes[i+3]===0x06){eocd=i;break;}
  }
  // search from end for last occurrence
  for(let i=bytes.length-22;i>=0;i--){
    if(bytes[i]===0x50&&bytes[i+1]===0x4B&&bytes[i+2]===0x05&&bytes[i+3]===0x06){eocd=i;break;}
  }
  if(eocd<0) throw new Error('Not a valid XLSX/ZIP file');

  const cdCount=_u16(bytes,eocd+8)||_u16(bytes,eocd+10);
  const cdOffset=_u32(bytes,eocd+16);

  // ── 2. Parse Central Directory ──────────────────────────────────────────
  const entries={};
  let p=cdOffset;
  for(let i=0;i<cdCount;i++){
    if(p+46>bytes.length) break;
    if(!(bytes[p]===0x50&&bytes[p+1]===0x4B&&bytes[p+2]===0x01&&bytes[p+3]===0x02)) break;
    const comp=_u16(bytes,p+10);
    const csz =_u32(bytes,p+20);
    const usz =_u32(bytes,p+24);
    const fnl =_u16(bytes,p+28);
    const extl=_u16(bytes,p+30);
    const coml=_u16(bytes,p+32);
    const loff=_u32(bytes,p+42);
    const fname=new TextDecoder('utf-8').decode(bytes.subarray(p+46,p+46+fnl));
    entries[fname]={comp,csz,usz,loff};
    p+=46+fnl+extl+coml;
  }

  // ── 3. Read + decompress a ZIP entry ────────────────────────────────────
  async function readEntry(name){
    // Try exact match, then case-insensitive
    let e=entries[name];
    if(!e) e=Object.entries(entries).find(([k])=>k.toLowerCase()===name.toLowerCase())?.[1];
    if(!e) return null;
    const lp=e.loff;
    if(lp+30>bytes.length) return null;
    const fnl2=_u16(bytes,lp+26);
    const extl2=_u16(bytes,lp+28);
    const dataStart=lp+30+fnl2+extl2;
    const data=bytes.subarray(dataStart,dataStart+e.csz);
    if(e.comp===0) return new TextDecoder('utf-8').decode(data);
    // deflate-raw via DecompressionStream (supported in all modern browsers)
    if(typeof DecompressionStream!=='undefined'){
      try{
        const ds=new DecompressionStream('deflate-raw');
        const writer=ds.writable.getWriter();
        const reader=ds.readable.getReader();
        writer.write(data);
        writer.close();
        const chunks=[];
        while(true){const{done,value}=await reader.read();if(done)break;chunks.push(value);}
        const out=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));
        let off=0;for(const c of chunks){out.set(c,off);off+=c.length;}
        return new TextDecoder('utf-8').decode(out);
      }catch(e2){throw new Error('Decompression failed: '+e2.message);}
    }
    throw new Error('DecompressionStream not supported in this browser');
  }

  // ── 4. XML entity unescaping ────────────────────────────────────────────
  const unesc=s=>String(s)
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
    .replace(/&#x([0-9a-fA-F]+);/g,(_,h)=>String.fromCharCode(parseInt(h,16)))
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n));

  // ── 5. Shared strings ───────────────────────────────────────────────────
  const ssXml=await readEntry('xl/sharedStrings.xml');
  const ss=[];
  if(ssXml){
    // Match each <si> block
    const siRe=/<si>([\s\S]*?)<\/si>/g;
    let sm;
    while((sm=siRe.exec(ssXml))!==null){
      // Concatenate all <t> text nodes within this <si>
      const tRe=/<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
      let tm,parts=[];
      while((tm=tRe.exec(sm[1]))!==null) parts.push(unesc(tm[1]));
      ss.push(parts.join(''));
    }
  }

  // ── 6. Find first sheet path via workbook.xml.rels ──────────────────────
  let sheetPath='xl/worksheets/sheet1.xml';
  const wbRels=await readEntry('xl/_rels/workbook.xml.rels');
  if(wbRels){
    // Find first worksheet relationship
    const rm=wbRels.match(/Type="[^"]*\/worksheet"[^>]*Target="([^"]+)"/);
    const rm2=rm||wbRels.match(/Target="(worksheets\/[^"]+)"/);
    if(rm2) sheetPath='xl/'+rm2[1].replace(/^.*xl\//,'');
  }

  const shXml=await readEntry(sheetPath);
  if(!shXml) throw new Error('Worksheet not found in XLSX (path: '+sheetPath+')');

  // ── 7. Column letter → 0-based index ────────────────────────────────────
  const colIdx=ref=>{
    let n=0;
    for(let i=0;i<ref.length;i++) n=n*26+(ref.charCodeAt(i)-64);
    return n-1;
  };

  // ── 8. Number format detection for dates ────────────────────────────────
  // Load numFmts from styles.xml to detect date columns
  // Built-in date format IDs: 14-22 (standard), 27-36 (CJK/locale), 45-47 (time), 50-58 (more CJK)
  const dateNumFmtIds=new Set([14,15,16,17,18,19,20,21,22,27,28,29,30,31,32,33,34,35,36,45,46,47,50,51,52,53,54,55,56,57,58]);
  const cellStyleFmtId={}; // style index → numFmtId
  try{
    const styXml=await readEntry('xl/styles.xml');
    if(styXml){
      // Custom formats — detect any containing date/time tokens (y, m, d, h, s)
      const cfRe=/<numFmt numFmtId="(\d+)" formatCode="([^"]+)"/g;
      let cf;
      while((cf=cfRe.exec(styXml))!==null){
        const code=cf[2].toLowerCase();
        if(/[ymdhYMDH]/.test(cf[2])&&!/\[/.test(code)) dateNumFmtIds.add(+cf[1]);
      }
      // xf entries → map cell style index to numFmtId
      const xfSection=styXml.match(/<cellXfs>([\s\S]*?)<\/cellXfs>/);
      if(xfSection){
        const xfRe=/<xf[^>]*numFmtId="(\d+)"[^>]*>/g;
        let xi,idx2=0;
        while((xi=xfRe.exec(xfSection[1]))!==null){cellStyleFmtId[idx2++]=+xi[1];}
      }
    }
  }catch(_){}

  // Excel serial date → YYYY-MM-DD (with year validation)
  const xlDateToStr=n=>{
    const d=new Date(Math.round((n-25569)*86400000));
    if(isNaN(d)) return String(n);
    const iso=d.toISOString().split('T')[0];
    const yr=parseInt(iso);
    return (yr>=1900&&yr<=2100)?iso:String(n);
  };

  // ── 9. Parse rows ────────────────────────────────────────────────────────
  const rawRows=[];
  const rowRe=/<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowM;
  while((rowM=rowRe.exec(shXml))!==null){
    const cells={};
    const cellRe=/<c\s+r="([A-Z]+)\d+"([^>\/]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while((cm=cellRe.exec(rowM[1]))!==null){
      const colRef=cm[1];
      const attrs=cm[2]||'';
      const inner=cm[3]||'';
      let val='';
      const vm=inner.match(/<v>([^<]*)<\/v>/);
      const rawVal=vm?vm[1]:'';
      const tAttr=(attrs.match(/\bt="([^"]+)"/)||[])[1]||'';
      const sAttr=+(attrs.match(/\bs="(\d+)"/)||[0,'-1'])[1];

      if(tAttr==='s'){
        // Shared string
        val=ss[+rawVal]||'';
      } else if(tAttr==='inlineStr'){
        const im=inner.match(/<t[^>]*>([^<]*)<\/t>/);
        val=im?unesc(im[1]):'';
      } else if(tAttr==='b'){
        val=rawVal==='1'?'TRUE':'FALSE';
      } else if(tAttr==='str'||tAttr==='e'){
        val=unesc(rawVal);
      } else {
        // Numeric — check if it's a date format
        if(rawVal&&sAttr>=0&&dateNumFmtIds.has(cellStyleFmtId[sAttr])){
          val=xlDateToStr(parseFloat(rawVal));
        } else {
          val=rawVal;
        }
      }
      cells[colIdx(colRef)]=val;
    }
    rawRows.push(cells);
  }

  if(!rawRows.length) return [];

  // ── 10. Build objects from header row ────────────────────────────────────
  const maxCol=rawRows.reduce((m,r)=>Math.max(m,...Object.keys(r).map(Number)),0);
  const headers=[];
  for(let i=0;i<=maxCol;i++) headers.push(String(rawRows[0][i]||'').trim());

  // Detect "date" columns by header name — auto-convert numeric values to YYYY-MM-DD
  // This catches Excel serial numbers in date columns that weren't detected by cell style
  const dateColIdxs=new Set();
  headers.forEach((h,i)=>{
    if(h&&/date|pickup|reach|dispatch|expir|valid/i.test(h)) dateColIdxs.add(i);
  });

  const result=[];
  for(let ri=1;ri<rawRows.length;ri++){
    const obj={};
    let hasVal=false;
    headers.forEach((h,i)=>{
      if(!h) return;
      let v=String(rawRows[ri][i]===undefined?'':rawRows[ri][i]).trim();
      // Auto-convert numeric values in date columns to YYYY-MM-DD
      if(v&&dateColIdxs.has(i)){
        const num=parseFloat(v);
        if(!isNaN(num)&&/^\d+\.?\d*$/.test(v)&&num>=1&&num<100000){
          const d=new Date(Math.round((num-25569)*86400000));
          if(!isNaN(d)){const iso=d.toISOString().split('T')[0];const yr=parseInt(iso);if(yr>=1900&&yr<=2100) v=iso;}
        }
      }
      obj[h]=v;
      if(v) hasVal=true;
    });
    if(hasVal) result.push(obj);
  }
  return result;
}

// ── Universal import (CSV / XLSX / TSV) ──────────────────────────────────────
async function _applyImportRows(rows, col, schema){
  showSpinner('Importing '+rows.length+' rows…');
  try{
  if(!DB[col]) DB[col]=[];
  let added=0,updated=0,skipped=0;
  const toUpdate=[], toAdd=[];
  // For flat imports, track pending new records by key
  const pendingNew={};
  rows.forEach(r=>{
    const key=schema.matchKey(r);
    if(!key){skipped++;return;}
    const existing=(DB[col]||[]).find(item=>schema.dbMatchKey(item)===key);
    if(existing){
      schema.merge(existing,r); 
      if(!toUpdate.includes(existing)) {updated++; toUpdate.push(existing);}
    } else if(schema._flatImport && pendingNew[key]){
      // Merge into already-pending new record
      schema.merge(pendingNew[key],r);
    } else {
      const n=schema.fromRow(r);
      if(n){ 
        if(schema._flatImport) n._importMerged=true;
        toAdd.push(n); 
        if(schema._flatImport) pendingNew[key]=n;
      } else skipped++;
    }
  });
  for(const rec of toUpdate){ delete rec._importMerged; _spinnerMsg('Updating '+(toUpdate.indexOf(rec)+1)+'/'+toUpdate.length+'…'); if(!await _dbSave(col,rec)){ updated--; skipped++; } }
  for(const rec of toAdd){ delete rec._importMerged; _spinnerMsg('Adding '+(toAdd.indexOf(rec)+1)+'/'+toAdd.length+'…'); if(await _dbSave(col,rec)) added++; else skipped++; }
  schema.render();
  notify(`Import done: ${added} added, ${updated} updated${skipped?', '+skipped+' skipped':''}`);
  }finally{ hideSpinner(); }
}

function importMaster(col,inputEl){
  if(!CU||!CU.roles.some(r=>['Super Admin','Admin'].includes(r))){notify('⚠ Import is restricted to Admin users only.',true);if(inputEl)inputEl.value='';return;}
  const file=inputEl.files[0];
  if(!file){return;}
  inputEl.value='';
  const schema=MASTER_SCHEMA[col];
  if(!schema){notify('Import not supported for this master',true);return;}
  const ext=file.name.split('.').pop().toLowerCase();
  if(ext==='xlsx'){
    const reader=new FileReader();
    reader.onload=async e=>{
      try{
        const rows=await _parseXLSX(e.target.result);
        if(!rows.length){notify('No data found in file',true);return;}
        _applyImportRows(rows,col,schema);
      }catch(err){notify('⚠ '+err.message,true);}
    };
    reader.readAsArrayBuffer(file);
  } else if(ext==='csv'){
    const reader=new FileReader();
    reader.onload=e=>{
      try{
        const rows=_parseCSV(e.target.result);
        if(!rows.length){notify('No data found in file',true);return;}
        _applyImportRows(rows,col,schema);
      }catch(err){notify('Import failed: '+err.message,true);}
    };
    reader.readAsText(file);
  } else {
    notify('⚠ Unsupported format. Use the exported .xlsx file.',true);
  }
}


// ═══ SHARED UI UTILITIES ══════════════════════════════════════════════════

function openPhoto(src){
  if(!src) return;
  document.getElementById('photoLightboxImg').src=src;
  document.getElementById('photoLightbox').style.display='flex';
  // Show Share button only if Web Share API available
  const sb=document.getElementById('sharePhotoBtn');
  if(sb)sb.style.display=navigator.share?'block':'none';
}
// Delegate photo clicks to avoid long base64 strings in onclick attributes
document.addEventListener('click',function(e){
  const thumb=e.target.closest('.seg-photo-thumb');
  if(thumb&&thumb.dataset.src){openPhoto(thumb.dataset.src);return;}
});
async function savePhoto(){
  const src=document.getElementById('photoLightboxImg').src;
  if(!src)return;
  const a=document.createElement('a');
  a.href=src;
  a.download='KAP_Challan_'+(Date.now())+'.jpg';
  a.click();
}
async function sharePhoto(){
  const src=document.getElementById('photoLightboxImg').src;
  if(!src||!navigator.share)return;
  try{
    const res=await fetch(src);
    const blob=await res.blob();
    const file=new File([blob],'KAP_Challan.jpg',{type:blob.type});
    await navigator.share({title:'KAP Challan Photo',files:[file]});
  }catch(e){
    // Fallback: share URL if file sharing fails
    try{await navigator.share({title:'KAP Challan Photo',url:src});}catch(_){}
  }
}

// Compress image to <1MB and show thumbnail




const _sortState={};
function sortTable(tbodyId, colIdx){
  const tbody=document.getElementById(tbodyId);
  if(!tbody)return;
  const key=tbodyId+':'+colIdx;
  const prev=_sortState[tbodyId]||{col:-1,dir:1};
  const dir=(prev.col===colIdx)?-prev.dir:1;
  _sortState[tbodyId]={col:colIdx,dir};
  // Update header arrows
  const thead=tbody.closest('table').querySelector('thead');
  thead.querySelectorAll('th.sortable').forEach((th,i)=>{
    th.classList.remove('sort-asc','sort-desc');
    if(i===colIdx) th.classList.add(dir===1?'sort-asc':'sort-desc');
  });
  // Sort rows
  const rows=[...tbody.querySelectorAll('tr')];
  rows.sort((a,b)=>{
    const at=(a.cells[colIdx]?.innerText||'').trim().toLowerCase();
    const bt=(b.cells[colIdx]?.innerText||'').trim().toLowerCase();
    const an=parseFloat(at.replace(/[₹,]/g,'')),bn=parseFloat(bt.replace(/[₹,]/g,''));
    if(!isNaN(an)&&!isNaN(bn))return (an-bn)*dir;
    return at.localeCompare(bt)*dir;
  });
  rows.forEach(r=>tbody.appendChild(r));
}



async function del(col,id,fn){
  // Block deleting confirmed invoices/containers (SA can override)
  const isSA=CU&&CU.roles.includes('Super Admin');
  if(col==='hwmsInvoices'){const inv=byId(DB.hwmsInvoices||[],id);if(inv?.confirmed&&!isSA){notify('⚠ Cannot delete: Invoice is confirmed (RFD).',true);return;}}
  if(col==='hwmsContainers'){const c=byId(DB.hwmsContainers||[],id);if(c?.confirmed&&!isSA){notify('⚠ Cannot delete: Container is confirmed.',true);return;}}
  // Check if this record is referenced in any other data before allowing deletion
  const usageMap={
    users:(id)=>{
      const refs=[];
      // Guard: cannot delete the last Super Admin
      const target=byId(DB.users,id);
      if(target?.roles?.includes('Super Admin')){
        const otherSAs=DB.users.filter(u=>u.id!==id&&u.roles.includes('Super Admin'));
        if(otherSAs.length===0) refs.push('⭐ Last Super Admin — cannot delete (system requires at least 1)');
      }
      DB.locations.forEach(l=>{
        if(l.kapSec===id||(l.tripBook||[]).includes(id)||(l.matRecv||[]).includes(id)||(l.approvers||[]).includes(id))
          refs.push('Location: '+l.name);
      });
      DB.trips.forEach(t=>{if(t.bookedBy===id)refs.push('Trip: '+t.id);});
      return refs;
    },
    vehicleTypes:(id)=>{
      const refs=[];
      DB.vehicles.forEach(v=>{if(v.typeId===id)refs.push('Vehicle: '+v.number);});
      DB.tripRates.forEach(r=>{if(r.vTypeId===id)refs.push('Trip Rate: '+r.name);});
      return refs;
    },
    drivers:(id)=>{
      return DB.trips.filter(t=>t.driverId===id).map(t=>'Trip: '+t.id);
    },
    vendors:(id)=>{
      return DB.vehicles.filter(v=>v.vendorId===id).map(v=>'Vehicle: '+v.number);
    },
    vehicles:(id)=>{
      return DB.trips.filter(t=>t.vehicleId===id).map(t=>'Trip: '+t.id);
    },
    locations:(id)=>{
      const refs=[];
      DB.trips.forEach(t=>{
        if([t.startLoc,t.dest1,t.dest2,t.dest3].includes(id))refs.push('Trip: '+t.id);
      });
      DB.tripRates.forEach(r=>{
        if([r.start,r.dest1,r.dest2,r.dest3].includes(id))refs.push('Trip Rate: '+r.name);
      });
      return refs;
    },
    tripRates:()=>[], // trip rates not referenced by ID in trips currently
    checkpoints:(id)=>{
      return (DB.roundSchedules||[]).filter(rs=>(rs.checkpointIds||[]).includes(id)).map(rs=>'Schedule: '+rs.name);
    },
    guards:(id)=>{
      return (DB.roundSchedules||[]).filter(rs=>rs.guardId===id).map(rs=>'Schedule: '+rs.name);
    },
    roundSchedules:()=>[],
    hwmsParts:(id)=>{
      return (DB.hwmsInvoices||[]).filter(inv=>(inv.lineItems||[]).some(li=>li.partId===id)).map(inv=>'Invoice: '+inv.invoiceNumber);
    },
    hwmsInvoices:()=>[],
    hwmsContainers:(id)=>{
      return (DB.hwmsInvoices||[]).filter(inv=>inv.containerId===id).map(inv=>'Invoice: '+inv.invoiceNumber);
    },
    hwmsHsn:(id)=>{
      const h=byId(DB.hwmsHsn||[],id);if(!h)return [];
      return (DB.hwmsParts||[]).filter(p=>p.hsnCode===h.hsnNumber).map(p=>'Part: '+p.partNumber);
    },
    hwmsUom:(id)=>{
      const u=byId(DB.hwmsUom||[],id);if(!u)return [];
      return (DB.hwmsParts||[]).filter(p=>p.uom===u.uom).map(p=>'Part: '+p.partNumber);
    },
    hwmsPacking:(id)=>{
      const pk=byId(DB.hwmsPacking||[],id);if(!pk)return [];
      return (DB.hwmsParts||[]).filter(p=>p.packingType===pk.name).map(p=>'Part: '+p.partNumber);
    },
    hwmsCustomers:(id)=>{
      return (DB.hwmsInvoices||[]).filter(inv=>inv.customerId===id).map(inv=>'Invoice: '+inv.invoiceNumber);
    },
    hwmsPortDischarge:(id)=>{
      const refs=[];
      (DB.hwmsCustomers||[]).filter(c=>c.defaultPortDischarge===id).forEach(c=>refs.push('Customer: '+c.customerName));
      (DB.hwmsInvoices||[]).filter(inv=>inv.portOfDischargeId===id).forEach(inv=>refs.push('Invoice: '+inv.invoiceNumber));
      return refs;
    },
    hwmsPortLoading:(id)=>{
      const refs=[];
      (DB.hwmsCustomers||[]).filter(c=>c.defaultPortLoading===id).forEach(c=>refs.push('Customer: '+c.customerName));
      (DB.hwmsInvoices||[]).filter(inv=>inv.portOfLoadingId===id).forEach(inv=>refs.push('Invoice: '+inv.invoiceNumber));
      return refs;
    },
    hwmsCarriers:(id)=>{
      return (DB.hwmsContainers||[]).filter(c=>c.carrierId===id).map(c=>'Container: '+c.containerNumber);
    },
  };

  const checker=usageMap[col];
  if(checker){
    const refs=checker(id);
    if(refs.length){
      const list=refs.slice(0,8).map(r=>`<span style="display:block">• ${r}</span>`).join('');
      const extra=refs.length>8?`<span style="color:var(--text3)">…and ${refs.length-8} more</span>`:'';
      document.getElementById('errorMsg').innerHTML=
        `<strong>This record is used in:</strong><div style="margin-top:8px">${list}${extra}</div><div style="margin-top:10px;color:var(--text3);font-size:12px">Remove the association first, then delete.</div>`;
      om('mError');
      return;
    }
  }

  // Show styled confirmation modal
  document.getElementById('confirmMsg').textContent='This action cannot be undone.';
  document.getElementById('btnConfirmOk').onclick=async()=>{
    if(!await _dbDel(col,id)) return;
    fn();updBadges();cm('mConfirm');notify('Deleted');
  };
  om('mConfirm');
}
