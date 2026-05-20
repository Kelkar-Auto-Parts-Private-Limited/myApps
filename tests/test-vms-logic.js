// ═══════════════════════════════════════════════════════════════════════════════
// test-vms-logic.js — Unit tests for js/vms-logic.js pure logic functions
// Depends on: test-helpers.js (loaded first), then vms-logic.js
// ═══════════════════════════════════════════════════════════════════════════════

// Globals required by _syncMergeRows
var _PHOTO_PRESERVE = {
  'trips': ['photo1', 'photo2', 'photo3'],
  'spotTrips': ['challanPhoto', 'driverPhoto']
};
var _loadedTables = {};

// ── Helper: build a minimal location ──
function _mkLoc(id, name, type, opts) {
  return Object.assign({ id: id, name: name, type: type, kapSec: null, matRecv: [], approvers: [] }, opts || {});
}

// ── Helper: build a minimal trip ──
function _mkTrip(id, opts) {
  return Object.assign({ id: id, bookedBy: 'u1', plant: 'loc1', date: '2026-04-01', dest2: null, dest3: null }, opts || {});
}

// ── Helper: build a minimal segment with steps ──
function _mkSeg(tripId, label, sLoc, dLoc, stepOverrides) {
  var steps = {};
  for (var i = 1; i <= 5; i++) {
    steps[i] = { skip: false, done: false, time: null, by: null };
  }
  if (stepOverrides) {
    Object.keys(stepOverrides).forEach(function (k) {
      Object.assign(steps[k], stepOverrides[k]);
    });
  }
  return { id: tripId + label, tripId: tripId, label: label, sLoc: sLoc, dLoc: dLoc, steps: steps, status: 'Active', currentStep: 1, criteria: 1, tripCatId: '' };
}

// ═════════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═════════════════════════════════════════════════════════════════════════════

// ── getCriteria ─────────────────────────────────────────────────────────────
describe('getCriteria', function () {
  resetDB();

  it('KAP to KAP returns 1', function () {
    assertEqual(getCriteria('KAP', 'KAP'), 1);
  });

  it('KAP to External returns 2', function () {
    assertEqual(getCriteria('KAP', 'External'), 2);
  });

  it('External to KAP returns 3', function () {
    assertEqual(getCriteria('External', 'KAP'), 3);
  });

  it('External to External returns 4', function () {
    assertEqual(getCriteria('External', 'External'), 4);
  });
});

// ── getTripCatId ────────────────────────────────────────────────────────────
describe('getTripCatId', function () {
  resetDB();

  it('label A, KAP to KAP gives AKK', function () {
    assertEqual(getTripCatId('A', 'KAP', 'KAP'), 'AKK');
  });

  it('label A, KAP to External gives AKE', function () {
    assertEqual(getTripCatId('A', 'KAP', 'External'), 'AKE');
  });

  it('label B, External to KAP gives BEK', function () {
    assertEqual(getTripCatId('B', 'External', 'KAP'), 'BEK');
  });

  it('label C, External to External gives CEE', function () {
    assertEqual(getTripCatId('C', 'External', 'External'), 'CEE');
  });
});

// ── buildSegment ────────────────────────────────────────────────────────────
describe('buildSegment', function () {
  resetDB();
  DB.locations = [
    _mkLoc('loc1', 'Plant 1', 'KAP', { kapSec: 'sec1', matRecv: ['mr1'], approvers: ['ap1'] }),
    _mkLoc('loc2', 'Plant 2', 'KAP', { kapSec: 'sec2', matRecv: ['mr2'], approvers: ['ap2'] }),
    _mkLoc('loc3', 'Vendor X', 'External')
  ];
  DB.users = [{ id: 'u1', name: 'testadmin', fullName: 'Test Admin', plant: 'loc1' }];

  it('KAP to KAP: steps 1,2 not skipped, step 5 active on last seg', function () {
    DB.trips = [_mkTrip('T1')];
    var seg = buildSegment('T1', 'A', 'loc1', 'loc2');
    assertEqual(seg.criteria, 1);
    assertEqual(seg.tripCatId, 'AKK');
    assert(!seg.steps[1].skip, 'step 1 not skipped');
    assert(!seg.steps[2].skip, 'step 2 not skipped');
    assert(!seg.steps[3].skip, 'step 3 not skipped for KAP dest');
    assert(!seg.steps[4].skip, 'step 4 never skipped');
    assert(!seg.steps[5].skip, 'step 5 active: last seg + KAP dest');
  });

  it('KAP to External: step 2 skipped, step 3 skipped, step 5 skipped', function () {
    DB.trips = [_mkTrip('T2')];
    var seg = buildSegment('T2', 'A', 'loc1', 'loc3');
    assertEqual(seg.criteria, 2);
    assert(!seg.steps[1].skip, 'step 1 not skipped');
    assert(seg.steps[2].skip, 'step 2 skipped');
    assert(seg.steps[3].skip, 'step 3 skipped for External dest');
    assert(seg.steps[5].skip, 'step 5 skipped: External dest');
  });

  it('External to KAP: step 1 skipped, step 5 active on last seg', function () {
    DB.trips = [_mkTrip('T3')];
    var seg = buildSegment('T3', 'A', 'loc3', 'loc2');
    assertEqual(seg.criteria, 3);
    assert(seg.steps[1].skip, 'step 1 skipped');
    assert(!seg.steps[2].skip, 'step 2 not skipped');
    assert(!seg.steps[5].skip, 'step 5 active');
  });

  it('External to External: steps 1,2,3,5 skipped', function () {
    DB.trips = [_mkTrip('T4')];
    var seg = buildSegment('T4', 'A', 'loc3', 'loc3');
    assertEqual(seg.criteria, 4);
    assert(seg.steps[1].skip, 'step 1 skipped');
    assert(seg.steps[2].skip, 'step 2 skipped');
    assert(seg.steps[3].skip, 'step 3 skipped');
    assert(seg.steps[5].skip, 'step 5 skipped');
  });

  it('non-last segment: step 5 skipped even if KAP dest', function () {
    DB.trips = [_mkTrip('T5', { dest2: 'loc3' })];
    var seg = buildSegment('T5', 'A', 'loc1', 'loc2');
    assert(seg.steps[5].skip, 'step 5 skipped because not last segment');
  });

  it('segment assigns correct users from location roles', function () {
    DB.trips = [_mkTrip('T6')];
    var seg = buildSegment('T6', 'A', 'loc1', 'loc2');
    assertDeepEqual(seg.steps[1].users, ['sec1'], 'step 1 uses source KAP Security');
    assertDeepEqual(seg.steps[2].users, ['sec2'], 'step 2 uses dest KAP Security');
    assertDeepEqual(seg.steps[3].users, ['mr2'], 'step 3 uses dest Material Receiver');
    assertDeepEqual(seg.steps[4].users, ['ap1'], 'step 4 uses source Trip Approver (KAP->KAP)');
  });

  it('currentStep is set by nextStep', function () {
    DB.trips = [_mkTrip('T7')];
    var seg = buildSegment('T7', 'A', 'loc1', 'loc2');
    assertEqual(seg.currentStep, 1, 'first undone non-skipped step');
  });
});

// ── nextStep ────────────────────────────────────────────────────────────────
describe('nextStep', function () {
  resetDB();

  it('returns 1 when step 1 is not done and not skipped', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2');
    assertEqual(nextStep(seg), 1);
  });

  it('returns 2 when step 1 done', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', { 1: { done: true } });
    assertEqual(nextStep(seg), 2);
  });

  it('skips step 1 if marked skip, goes to step 2', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', { 1: { skip: true } });
    assertEqual(nextStep(seg), 2);
  });

  it('after steps 1+2 done, returns 5 if step 5 active', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', { 1: { done: true }, 2: { done: true } });
    assertEqual(nextStep(seg), 5);
  });

  it('after steps 1+2 done, skips step 5 if marked skip, returns 3', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', { 1: { done: true }, 2: { done: true }, 5: { skip: true } });
    assertEqual(nextStep(seg), 3);
  });

  it('returns 6 when all steps done', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', {
      1: { done: true }, 2: { done: true }, 3: { done: true }, 4: { done: true }, 5: { done: true }
    });
    assertEqual(nextStep(seg), 6);
  });

  it('returns 6 when all non-skipped steps done', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', {
      1: { skip: true }, 2: { done: true }, 3: { skip: true }, 4: { done: true }, 5: { skip: true }
    });
    assertEqual(nextStep(seg), 6);
  });
});

// ── allStepsDone ────────────────────────────────────────────────────────────
describe('allStepsDone', function () {
  resetDB();

  it('false when some steps remain', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', { 1: { done: true } });
    assert(!allStepsDone(seg));
  });

  it('true when all steps done', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', {
      1: { done: true }, 2: { done: true }, 3: { done: true }, 4: { done: true }, 5: { done: true }
    });
    assert(allStepsDone(seg));
  });

  it('true when remaining steps are skipped', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', {
      1: { skip: true }, 2: { done: true }, 3: { skip: true }, 4: { done: true }, 5: { skip: true }
    });
    assert(allStepsDone(seg));
  });
});

// ── stepsOneAndTwoDone ──────────────────────────────────────────────────────
describe('stepsOneAndTwoDone', function () {
  resetDB();

  it('false when step 1 not done', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2');
    assert(!stepsOneAndTwoDone(seg));
  });

  it('false when step 2 not done', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', { 1: { done: true } });
    assert(!stepsOneAndTwoDone(seg));
  });

  it('true when both done', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', { 1: { done: true }, 2: { done: true } });
    assert(stepsOneAndTwoDone(seg));
  });

  it('true when step 1 skipped and step 2 done', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', { 1: { skip: true }, 2: { done: true } });
    assert(stepsOneAndTwoDone(seg));
  });
});

// ── stepsUpTo3Done ──────────────────────────────────────────────────────────
describe('stepsUpTo3Done', function () {
  resetDB();

  it('false when step 3 not done', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', { 1: { done: true }, 2: { done: true } });
    assert(!stepsUpTo3Done(seg));
  });

  it('true when steps 1-3 done', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', { 1: { done: true }, 2: { done: true }, 3: { done: true } });
    assert(stepsUpTo3Done(seg));
  });

  it('true when step 3 skipped', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', { 1: { done: true }, 2: { done: true }, 3: { skip: true } });
    assert(stepsUpTo3Done(seg));
  });
});

// ── recalcSegSteps ──────────────────────────────────────────────────────────
describe('recalcSegSteps', function () {
  resetDB();
  DB.locations = [
    _mkLoc('loc1', 'Plant 1', 'KAP', { kapSec: 'sec1', matRecv: ['mr1'], approvers: ['ap1'] }),
    _mkLoc('loc2', 'Plant 2', 'KAP', { kapSec: 'sec2', matRecv: ['mr2'], approvers: ['ap2'] }),
    _mkLoc('loc3', 'Vendor X', 'External')
  ];
  DB.users = [{ id: 'u1', name: 'testadmin', fullName: 'Test Admin', plant: 'loc1' }];
  DB.trips = [_mkTrip('T1')];

  it('returns false for cancelled segment', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2');
    seg.status = 'Cancelled';
    assert(!recalcSegSteps(seg));
  });

  it('updates criteria and tripCatId when stale', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2');
    seg.criteria = 99;
    seg.tripCatId = 'WRONG';
    var changed = recalcSegSteps(seg);
    assert(changed, 'should report change');
    assertEqual(seg.criteria, 1);
    assertEqual(seg.tripCatId, 'AKK');
  });

  it('creates step 5 if missing', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2');
    delete seg.steps[5];
    var changed = recalcSegSteps(seg);
    assert(changed, 'should report change');
    assert(seg.steps[5] !== undefined, 'step 5 created');
  });

  it('marks segment Completed when all steps done', function () {
    var seg = _mkSeg('T1', 'A', 'loc1', 'loc2', {
      1: { done: true }, 2: { done: true }, 3: { done: true }, 4: { done: true }, 5: { done: true }
    });
    seg.status = 'Active';
    recalcSegSteps(seg);
    assertEqual(seg.status, 'Completed');
  });

  it('uses sibling segments to determine isLastSeg', function () {
    DB.trips = [_mkTrip('T1', { dest2: 'loc3' })];
    var segA = _mkSeg('T1', 'A', 'loc1', 'loc2');
    var segB = _mkSeg('T1', 'B', 'loc2', 'loc3');
    DB.segments = [segA, segB];
    // segA is not last because segB exists
    recalcSegSteps(segA, [segA, segB]);
    assert(segA.steps[5].skip, 'step 5 skipped for non-last segment');
  });
});

// ── tripOverallStatus ───────────────────────────────────────────────────────
describe('tripOverallStatus', function () {
  resetDB();

  it('returns Cancelled when trip.cancelled is true', function () {
    assertEqual(tripOverallStatus({ id: 'T1', cancelled: true }), 'Cancelled');
  });

  it('returns Active when no segments', function () {
    DB.segments = [];
    assertEqual(tripOverallStatus({ id: 'T1' }), 'Active');
  });

  it('returns Completed when all segments completed', function () {
    DB.segments = [
      { tripId: 'T1', status: 'Completed' },
      { tripId: 'T1', status: 'Completed' }
    ];
    assertEqual(tripOverallStatus({ id: 'T1' }), 'Completed');
  });

  it('returns Rejected when any segment rejected', function () {
    DB.segments = [
      { tripId: 'T1', status: 'Completed' },
      { tripId: 'T1', status: 'Rejected' }
    ];
    assertEqual(tripOverallStatus({ id: 'T1' }), 'Rejected');
  });

  it('returns Active when segments are mixed active/completed', function () {
    DB.segments = [
      { tripId: 'T1', status: 'Completed' },
      { tripId: 'T1', status: 'Active' }
    ];
    assertEqual(tripOverallStatus({ id: 'T1' }), 'Active');
  });

  it('ignores segments from other trips', function () {
    DB.segments = [
      { tripId: 'T1', status: 'Active' },
      { tripId: 'T2', status: 'Completed' }
    ];
    assertEqual(tripOverallStatus({ id: 'T1' }), 'Active');
  });
});

// ── _isStrongPwd ────────────────────────────────────────────────────────────
describe('_isStrongPwd', function () {
  resetDB();

  it('rejects null/empty', function () {
    assert(!_isStrongPwd(null));
    assert(!_isStrongPwd(''));
  });

  it('rejects too short (< 6)', function () {
    assert(!_isStrongPwd('Ab1!'));
  });

  it('rejects too long (> 12)', function () {
    assert(!_isStrongPwd('Abcdef1234!@#'));
  });

  it('rejects missing uppercase', function () {
    assert(!_isStrongPwd('abcde1!'));
  });

  it('rejects missing lowercase', function () {
    assert(!_isStrongPwd('ABCDE1!'));
  });

  it('rejects missing digit', function () {
    assert(!_isStrongPwd('Abcdef!'));
  });

  it('rejects missing special char', function () {
    assert(!_isStrongPwd('Abcde12'));
  });

  it('accepts valid password', function () {
    assert(_isStrongPwd('Abc12!'));
  });

  it('accepts 12-char password at boundary', function () {
    assert(_isStrongPwd('Abcdef1234!@'));
  });
});

// ── _stripStepPhotos ────────────────────────────────────────────────────────
describe('_stripStepPhotos', function () {
  resetDB();

  it('replaces photo values with __deferred__', function () {
    var segs = [{ steps: { 1: { photo: 'base64data', done: true }, 2: { done: false } } }];
    _stripStepPhotos(segs);
    assertEqual(segs[0].steps[1].photo, '__deferred__');
  });

  it('leaves steps without photos untouched', function () {
    var segs = [{ steps: { 1: { done: true }, 2: { done: false } } }];
    _stripStepPhotos(segs);
    assertEqual(segs[0].steps[1].done, true);
    assert(segs[0].steps[1].photo === undefined);
  });

  it('handles null/empty input gracefully', function () {
    _stripStepPhotos(null);
    _stripStepPhotos([]);
    // No throw = pass
    assert(true);
  });

  it('handles segment with no steps', function () {
    _stripStepPhotos([{ id: 'seg1' }]);
    assert(true);
  });
});

// ── _dateCutoff ─────────────────────────────────────────────────────────────
describe('_dateCutoff', function () {
  resetDB();

  it('returns an ISO date string (YYYY-MM-DD)', function () {
    var result = _dateCutoff(30);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(result), 'matches YYYY-MM-DD');
  });

  it('returns a date in the past', function () {
    var result = _dateCutoff(10);
    var today = new Date().toISOString().slice(0, 10);
    assert(result < today, 'cutoff is before today');
  });

  it('defaults to _DATE_FILTER_DAYS when no arg', function () {
    var result = _dateCutoff();
    var expected = _dateCutoff(_DATE_FILTER_DAYS);
    assertEqual(result, expected);
  });
});

// ── _syncSelect ─────────────────────────────────────────────────────────────
describe('_syncSelect', function () {
  resetDB();

  it('returns column list for known table', function () {
    var cols = _syncSelect('vms_trips');
    assert(cols.indexOf('id') >= 0, 'includes id');
    assert(cols.indexOf('code') >= 0, 'includes code');
  });

  it('returns * for unknown table', function () {
    assertEqual(_syncSelect('nonexistent_table'), '*');
  });

  it('returns columns for vms_segments', function () {
    var cols = _syncSelect('vms_segments');
    assert(cols.indexOf('trip_id') >= 0, 'includes trip_id');
    assert(cols.indexOf('status') >= 0, 'includes status');
  });
});

// ── _syncMergeRows ──────────────────────────────────────────────────────────
describe('_syncMergeRows', function () {
  resetDB();

  it('replace mode: overwrites table with new data', function () {
    DB.trips = [{ id: 'T1', code: 'old' }];
    _syncMergeRows('trips', [{ id: 'T1', code: 'new' }], true);
    assertEqual(DB.trips.length, 1);
    assertEqual(DB.trips[0].code, 'new');
  });

  it('replace mode: preserves photos from old records', function () {
    DB.trips = [{ id: 'T1', photo1: 'img_data', code: 'old' }];
    _syncMergeRows('trips', [{ id: 'T1', code: 'new' }], true);
    assertEqual(DB.trips[0].photo1, 'img_data', 'photo preserved');
    assertEqual(DB.trips[0].code, 'new', 'other fields updated');
  });

  it('merge mode: updates existing rows by id', function () {
    DB.trips = [{ id: 'T1', code: 'old' }, { id: 'T2', code: 'keep' }];
    _syncMergeRows('trips', [{ id: 'T1', code: 'updated' }], false);
    assertEqual(DB.trips[0].code, 'updated');
    assertEqual(DB.trips[1].code, 'keep');
  });

  it('merge mode: appends new rows', function () {
    DB.trips = [{ id: 'T1', code: 'a' }];
    _syncMergeRows('trips', [{ id: 'T2', code: 'b' }], false);
    assertEqual(DB.trips.length, 2);
    assertEqual(DB.trips[1].id, 'T2');
  });

  it('merge mode: preserves photos on updated rows', function () {
    DB.trips = [{ id: 'T1', photo1: 'img_data', code: 'old' }];
    _syncMergeRows('trips', [{ id: 'T1', code: 'new' }], false);
    assertEqual(DB.trips[0].photo1, 'img_data');
  });
});

// ── genTripId ───────────────────────────────────────────────────────────────
describe('genTripId', function () {
  resetDB();
  DB.locations = [
    _mkLoc('loc1', 'Plant 1', 'KAP'),
    _mkLoc('loc2', 'Plant 2', 'KAP'),
    _mkLoc('loc3', 'Vendor X', 'External')
  ];
  CU = { id: 'u1', name: 'testadmin', plant: 'loc1', roles: ['Super Admin'] };
  DB.users = [{ id: 'u1', name: 'testadmin', plant: 'loc1' }];

  it('KAP start uses start location plant code', function () {
    DB.trips = [];
    var id = genTripId('loc1', 'loc2');
    assert(id.indexOf('P1-') >= 0, 'uses Plant 1 digits: ' + id);
  });

  it('External start + KAP dest uses dest location plant code', function () {
    DB.trips = [];
    var id = genTripId('loc3', 'loc2');
    assert(id.indexOf('P2-') >= 0, 'uses Plant 2 digits: ' + id);
  });

  it('External to External uses CU.plant location code', function () {
    DB.trips = [];
    var id = genTripId('loc3', 'loc3');
    assert(id.indexOf('P1-') >= 0, 'uses CU plant digits: ' + id);
  });

  it('serial increments past existing trips', function () {
    // Manually set up a trip whose id matches the pattern genTripId will build
    var probe = genTripId('loc1', 'loc2');
    var prefix = probe.slice(0, probe.lastIndexOf('-') + 1);
    DB.trips = [{ id: prefix + '5' }];
    var id = genTripId('loc1', 'loc2');
    assert(id.endsWith('6'), 'serial is 6: ' + id);
  });

  it('excludeId prevents self-bumping', function () {
    var probe = genTripId('loc1', 'loc2');
    var prefix = probe.slice(0, probe.lastIndexOf('-') + 1);
    DB.trips = [{ id: prefix + '3' }];
    var id = genTripId('loc1', 'loc2', prefix + '3');
    assert(id.endsWith('1'), 'serial is 1 because existing trip excluded: ' + id);
  });
});

// ── _tripIdPrefix ───────────────────────────────────────────────────────────
describe('_tripIdPrefix', function () {
  resetDB();

  it('extracts prefix from standard trip ID', function () {
    assertEqual(_tripIdPrefix('5P2-14'), '5P2-');
  });

  it('returns empty string for null', function () {
    assertEqual(_tripIdPrefix(null), '');
  });

  it('returns empty string for non-matching format', function () {
    assertEqual(_tripIdPrefix('INVALID'), '');
  });

  it('handles single-digit plant number', function () {
    assertEqual(_tripIdPrefix('6P1-7'), '6P1-');
  });
});

// ── getReportData / rptRow ──────────────────────────────────────────────────
describe('getReportData and rptRow', function () {
  resetDB();
  DB.locations = [
    _mkLoc('loc1', 'Plant 1', 'KAP'),
    _mkLoc('loc2', 'Plant 2', 'KAP')
  ];
  DB.users = [{ id: 'u1', name: 'testadmin', fullName: 'Test Admin', plant: 'loc1' }];
  DB.vehicles = [{ id: 'v1', number: 'MH12AB1234', vendorId: 'vnd1', typeId: 'vt1' }];
  DB.vehicleTypes = [{ id: 'vt1', name: 'Tata Ace' }];
  DB.vendors = [{ id: 'vnd1', name: 'Fast Transport' }];
  DB.drivers = [{ id: 'd1', name: 'Ram' }];
  DB.trips = [_mkTrip('T1', { vehicleId: 'v1', driverId: 'd1', vehicleTypeId: 'vt1' })];
  DB.segments = [
    { id: 'T1A', tripId: 'T1', label: 'A', sLoc: 'loc1', dLoc: 'loc2', status: 'Completed', date: '2026-04-01', currentStep: 6,
      steps: { 1: { time: '2026-04-01T08:00:00Z', by: 'u1' }, 2: { time: '2026-04-01T09:00:00Z', by: 'u1' }, 3: { time: '2026-04-01T10:00:00Z', by: 'u1', remarks: 'OK' }, 4: { time: '2026-04-01T11:00:00Z', by: 'u1' }, 5: { done: true } } }
  ];
  CU = { id: 'u1', roles: ['Super Admin'], plant: 'loc1' };

  // Mock document.getElementById for getReportData
  if (typeof document === 'undefined') {
    var document = { getElementById: function () { return null; } };
  } else {
    // In browser, temporarily override
    var _origGetEl = document.getElementById;
    document.getElementById = function (id) {
      if (id === 'rptFrom' || id === 'rptTo') return null;
      return _origGetEl.call(document, id);
    };
  }

  it('getReportData returns segments for user trips', function () {
    var data = getReportData();
    assertEqual(data.segs.length, 1);
    assert(data.canSeeAmt, 'Super Admin can see amounts');
  });

  it('rptRow returns enriched row object', function () {
    var row = rptRow(DB.segments[0]);
    assertEqual(row.segId, 'T1');
    assertEqual(row.vehicleNo, 'MH12AB1234');
    assertEqual(row.vendor, 'Fast Transport');
    assertEqual(row.driver, 'Ram');
    assertEqual(row.route, 'Plant 1 to Plant 2');
    assert(row.status.indexOf('Done') >= 0, 'status shows Done');
  });

  it('rptRow handles missing trip gracefully', function () {
    var orphanSeg = { id: 'X1A', tripId: 'X1', label: 'A', sLoc: 'loc1', dLoc: 'loc2', status: 'Active', currentStep: 1,
      steps: { 1: {}, 2: {}, 3: {}, 4: {}, 5: {} } };
    var row = rptRow(orphanSeg);
    assertEqual(row.vehicleNo, '-');
    assertEqual(row.driver, '-');
  });
});
