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
  'hwms_parts':'id,code,part_number,part_revision,description,status,net_weight_kg,uom,hsn_code,packing_type,packing_dimensions,qty_per_package,packing_weight,ex_works_rate,freight,warehouse_cost,icc_cost,final_rate,rate_valid_from,rate_valid_to,rates,updated_at',
  'hwms_containers':'id,code,container_number,container_serial_number,expected_pickup_date,pickup_date,status,reach_date,expected_reach_date,reached_date,carrier_id,carrier_name,carrier_inv_number,carrier_inv_date,carrier_inv_amount,entry_summary_number,es_date,es_amount,tariff_paid,tariff_percent,confirmed,updated_at'
};
// _syncSelect, _dateCutoff, _applyDateFilter are in common.js

// ── Date filtering ──
var _DATE_FILTER_DAYS=60;
var _DATE_FILTER_COL={
  'vms_trips':'date','vms_segments':'date','vms_spot_trips':'date'
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
