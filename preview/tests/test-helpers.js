// ═══════════════════════════════════════════════════════════════════════════════
// test-helpers.js — Lightweight test framework + mocks for myApps logic tests
// ═══════════════════════════════════════════════════════════════════════════════

// ── Mini test framework ──
var _tests = [];
var _passed = 0;
var _failed = 0;
var _errors = [];

function describe(name, fn) {
  _tests.push({ name: name, fn: fn });
}

function it(name, fn) {
  try {
    fn();
    _passed++;
  } catch (e) {
    _failed++;
    _errors.push({ test: name, error: e.message || String(e) });
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'assertEqual') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function assertDeepEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error((msg || 'assertDeepEqual') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function assertThrows(fn, msg) {
  var threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(msg || 'Expected function to throw');
}

function runTests() {
  _passed = 0;
  _failed = 0;
  _errors = [];
  _tests.forEach(function (suite) {
    try { suite.fn(); } catch (e) {
      _failed++;
      _errors.push({ test: suite.name + ' (suite error)', error: e.message || String(e) });
    }
  });
  return { passed: _passed, failed: _failed, errors: _errors, total: _passed + _failed };
}

function renderResults(containerId) {
  var r = runTests();
  var el = document.getElementById(containerId);
  if (!el) return r;
  var html = '<h2 style="margin-bottom:12px">Test Results: ' +
    (r.failed === 0 ? '<span style="color:#16a34a">ALL PASSED</span>' : '<span style="color:#dc2626">' + r.failed + ' FAILED</span>') +
    ' (' + r.passed + '/' + r.total + ')</h2>';
  if (r.errors.length) {
    html += '<div style="margin-bottom:16px">';
    r.errors.forEach(function (e) {
      html += '<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:10px 14px;margin-bottom:6px">' +
        '<div style="font-weight:700;color:#dc2626;font-size:13px">' + e.test + '</div>' +
        '<div style="font-size:12px;color:#991b1b;margin-top:4px;font-family:monospace">' + e.error + '</div></div>';
    });
    html += '</div>';
  }
  html += '<div style="font-size:13px;color:#64748b">Passed: ' + r.passed + ' | Failed: ' + r.failed + ' | Total: ' + r.total + '</div>';
  el.innerHTML = html;
  return r;
}

// ── Common.js mocks ──
// These provide the minimal globals that logic files depend on

var DB = {};
var CU = {};

function byId(arr, id) { return (arr || []).find(function (x) { return x && x.id === id; }); }
function uid() { return Math.random().toString(36).substring(2, 11); }
function colourContrast() { return '#000'; }
function ltype(id) { return byId(DB.locations, id)?.type || '?'; }
function lnameText(id) { return byId(DB.locations, id)?.name || '?'; }
function lname(id) { return lnameText(id); }
function getUserLocation(userId) {
  var u = byId(DB.users, userId);
  return u ? byId(DB.locations, u.plant) : null;
}
function vnum(id) { var v = byId(DB.vehicles, id); return v ? v.number : '-'; }
function vtype(id) { var v = byId(DB.vehicles, id); var t = v ? byId(DB.vehicleTypes, v.typeId) : null; return t ? t.name : '-'; }
function tripsForMyPlant() { return DB.trips || []; }

// Reset DB state between test suites
function resetDB() {
  DB = {
    users: [], locations: [], trips: [], segments: [], vehicles: [], vehicleTypes: [],
    vendors: [], drivers: [], rates: [], spotTrips: [],
    checkpoints: [], guards: [], roundSchedules: [],
    hrmsEmployees: [], hrmsCompanies: [], hrmsCategories: [], hrmsEmpTypes: [],
    hrmsTeams: [], hrmsDepartments: [], hrmsSubDepartments: [], hrmsDesignations: [],
    hrmsDayTypes: [], hrmsPrintFormats: [], hrmsSettings: [],
    hwmsContainers: [], hwmsInvoices: [], hwmsSubInvoices: [], hwmsParts: [],
    hwmsPayments: [], hwmsSteelRates: [], hwmsMaterialRequests: []
  };
  CU = { id: 'u1', name: 'testadmin', fullName: 'Test Admin', roles: ['Super Admin'], apps: ['vms', 'hrms', 'hwms', 'security'], plant: 'loc1' };
}

resetDB();
