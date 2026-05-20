/** @file Portal pure logic — auth lockout, config constants. @depends common.js */

// ═══════════════════════════════════════════════════════════════════════════════
// portal-logic.js — Pure data/logic functions for Portal app (no DOM access)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Config & constants ──
var _PORTAL_RESET_PWD='Kappl@123';
var _BUILD_VERSION='09-Apr-2026 20:23';

// Photo-excluded sync selects for boot
var _SYNC_SELECT={
  'vms_trips':'id,code,booked_by,plant,date,start_loc,dest1,dest2,dest3,driver_id,vehicle_id,vehicle_type_id,actual_vehicle_type_id,vendor,description,trip_cat_id,challan1,weight1,challan2,weight2,challan3,weight3,edited_by,edited_at,cancelled,updated_at',
  'vms_spot_trips':'id,code,vehicle_num,supplier,challan,driver_name,driver_mobile,entry_remarks,date,entry_time,entry_by,location,exit_time,exit_by,exit_remarks,updated_at',
  // 260520-V5 — vms_segments.steps embeds base64 step photos; on one
  // user's session this column alone was 403 MB of the Portal egress.
  // Mirror VMS's own select: pull steps_light (server-side photo-
  // stripped variant). The destination VMS app already expects this
  // shape and lazy-loads full step photos on demand.
  'vms_segments':'id,code,trip_id,label,s_loc,d_loc,criteria,trip_cat_id,steps_light,status,date,current_step,updated_at',
  'hwms_parts':'id,code,part_number,part_revision,description,status,net_weight_kg,uom,hsn_code,packing_type,packing_dimensions,qty_per_package,packing_weight,ex_works_rate,freight,warehouse_cost,icc_cost,final_rate,rate_valid_from,rate_valid_to,rates,updated_at',
  'hwms_containers':'id,code,container_number,container_serial_number,expected_pickup_date,pickup_date,status,reach_date,expected_reach_date,reached_date,carrier_id,carrier_name,carrier_inv_number,carrier_inv_date,carrier_inv_amount,entry_summary_number,es_date,es_amount,tariff_paid,tariff_percent,confirmed,updated_at',
  // 260520-V5 — drop hwms_invoices.line_items (a fat JSONB array)
  // from Portal pre-fetch — ~36 MB on the same user's session.
  // HWMS bg-sync (full mode, no Portal _SYNC_SELECT in scope) will
  // replenish line_items within ~3s of the HWMS app booting.
  'hwms_invoices':'id,code,invoice_number,date,container_id,container_number,delivery,payment_terms,buyer_id,buyer_name,consignee_idx,consignee_name,mode_of_transport,port_of_loading_id,port_of_loading,port_of_discharge_id,port_of_discharge,country_of_dest,payment_status,payment_number,confirmed,updated_at',
  // V90 — strip users.photo at Portal boot.
  'vms_users':'id,code,name,full_name,mobile,email,roles,hwms_roles,hrms_roles,mtts_roles,plant,apps,inactive,updated_at'
};
// V90 — preserve on-demand user photos across Portal syncs.
var _PHOTO_PRESERVE = { 'users':['photo'] };
var _PHOTO_DB_COLS  = { 'vms_users':['photo'] };
// _syncSelect, _dateCutoff, _applyDateFilter are in common.js

// ── Date filtering ──
var _DATE_FILTER_DAYS=60;
var _DATE_FILTER_COL={
  'vms_trips':'date','vms_segments':'date','vms_spot_trips':'date',
  // 260520-V5 — Borrow HWMS's payment_date filter at the Portal layer.
  // hwms_payment_receipts carries four fat JSONB columns (line_items /
  // si_updates / mi_updates / manual_payments) that grow combinatorially
  // with payment fan-out; on one user's session it pulled 39 MB unfiltered.
  // 60d window mirrors Portal's _DATE_FILTER_DAYS (HWMS itself uses 180d).
  'hwms_payment_receipts':'payment_date'
};

// ── Auth / lockout logic ──
var _captchaAnswer=0;
var _loginFailCount=0;
var _lockoutUntil=0;
var _lockoutInterval=null;
var _LOCKOUT_MAX=3;
var _LOCKOUT_SECS=60;

/**
 * Check whether the user is currently locked out after failed login attempts.
 * @returns {boolean} True if lockout period has not yet expired
 */
function _isLockedOut(){ return Date.now()<_lockoutUntil; }

// _isStrongPwd is in common.js
