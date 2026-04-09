// ═══════════════════════════════════════════════════════════════════════════════
// test-hrms-logic.js — Tests for js/hrms-logic.js pure functions
// Requires: test-helpers.js loaded first, then hrms-logic.js
// ═══════════════════════════════════════════════════════════════════════════════

// Globals that hrms-logic.js depends on (normally defined in hrms-ui.js)
var _MON3 = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var _PERIOD_FIELDS = ['location', 'department', 'subDepartment', 'designation', 'employmentType', 'teamName', 'category', 'roll', 'reportingTo', 'salaryDay', 'salaryMonth', 'specialAllowance', 'status', 'dateOfLeft'];
var _hrmsStatutory = {
  pfWorker: 12, pfCompany: 13, pfThreshold: 21000,
  esiWorker: 0.75, esiCompany: 3.25, esiThreshold: 21000,
  plStaffSenior: 18, plStaffJunior: 1.5, plWorker: 1.5, plSeniorMonths: 60,
  ptRules: [
    { amount: 0, op: 'lt', threshold: 25000, gender: 'Female', month: '', remark: 'Women < 25000' },
    { amount: 0, op: 'lt', threshold: 7500, gender: '', month: '', remark: 'Gross < 7500' },
    { amount: 175, op: 'lt', threshold: 10000, gender: '', month: '', remark: 'Gross < 10000' },
    { amount: 200, op: 'gte', threshold: 10000, gender: '', month: '', remark: 'Gross >= 10000' },
    { amount: 300, op: 'gte', threshold: 10000, gender: '', month: 'feb', remark: 'Gross >= 10000 (Feb)' }
  ]
};
var _hrmsEmpPeriods = [];
var _hrmsActivePeriodIdx = 0;

// ── 1. _hrmsMonthLabel ──

describe('_hrmsMonthLabel', function () {
  resetDB();

  it('formats 2025-01 as Jan 25', function () {
    assertEqual(_hrmsMonthLabel('2025-01'), 'Jan 25');
  });

  it('formats 2025-12 as Dec 25', function () {
    assertEqual(_hrmsMonthLabel('2025-12'), 'Dec 25');
  });

  it('returns "Till date" for falsy input', function () {
    assertEqual(_hrmsMonthLabel(''), 'Till date');
    assertEqual(_hrmsMonthLabel(null), 'Till date');
    assertEqual(_hrmsMonthLabel(undefined), 'Till date');
  });
});

// ── 2. _hrmsCurMonth ──

describe('_hrmsCurMonth', function () {
  resetDB();

  it('returns current YYYY-MM matching today', function () {
    var now = new Date();
    var expected = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    var result = _hrmsCurMonth();
    assert(/^\d{4}-\d{2}$/.test(result), 'Should match YYYY-MM, got: ' + result);
    assertEqual(result, expected);
  });
});

// ── 3. _hrmsPrevMonth ──

describe('_hrmsPrevMonth', function () {
  resetDB();

  it('returns previous month within same year', function () {
    assertEqual(_hrmsPrevMonth('2025-06'), '2025-05');
  });

  it('handles year boundary: Jan to Dec', function () {
    assertEqual(_hrmsPrevMonth('2026-01'), '2025-12');
  });
});

// ── 4. _hrmsFYStart ──

describe('_hrmsFYStart', function () {
  resetDB();

  it('returns same year for Apr-Dec', function () {
    assertEqual(_hrmsFYStart(2025, 4), 2025);
    assertEqual(_hrmsFYStart(2025, 12), 2025);
  });

  it('returns previous year for Jan-Mar', function () {
    assertEqual(_hrmsFYStart(2026, 1), 2025);
    assertEqual(_hrmsFYStart(2026, 3), 2025);
  });
});

// ── 5. _hrmsParseTime ──

describe('_hrmsParseTime', function () {
  resetDB();

  it('parses 24-hour "HH:MM" to minutes', function () {
    assertEqual(_hrmsParseTime('08:30'), 510);
    assertEqual(_hrmsParseTime('00:00'), 0);
    assertEqual(_hrmsParseTime('23:59'), 1439);
  });

  it('parses single-digit hour', function () {
    assertEqual(_hrmsParseTime('8:05'), 485);
  });

  it('parses 12-hour AM/PM format', function () {
    assertEqual(_hrmsParseTime('08:30 AM'), 510);
    assertEqual(_hrmsParseTime('02:00 PM'), 840);
  });

  it('handles 12 AM (midnight) and 12 PM (noon)', function () {
    assertEqual(_hrmsParseTime('12:00 AM'), 0);
    assertEqual(_hrmsParseTime('12:00 PM'), 720);
  });

  it('returns null for empty/falsy input', function () {
    assertEqual(_hrmsParseTime(''), null);
    assertEqual(_hrmsParseTime(null), null);
  });

  it('returns null for invalid format', function () {
    assertEqual(_hrmsParseTime('abc'), null);
    assertEqual(_hrmsParseTime('hello world'), null);
  });
});

// ── 6. _hrmsMinToTime ──

describe('_hrmsMinToTime', function () {
  resetDB();

  it('converts minutes to "HH:MM"', function () {
    assertEqual(_hrmsMinToTime(510), '08:30');
    assertEqual(_hrmsMinToTime(0), '00:00');
    assertEqual(_hrmsMinToTime(1439), '23:59');
  });

  it('returns empty string for null/undefined', function () {
    assertEqual(_hrmsMinToTime(null), '');
    assertEqual(_hrmsMinToTime(undefined), '');
  });
});

// ── 7. _hrmsRoundIn ──

describe('_hrmsRoundIn', function () {
  resetDB();

  it('returns null for null input', function () {
    assertEqual(_hrmsRoundIn(null), null);
  });

  it('rounds within defined windows and defaults to 15-min rounding', function () {
    // 7:40-8:10 → 8:00
    assertEqual(_hrmsRoundIn(460), 480);
    assertEqual(_hrmsRoundIn(490), 480);
    // 8:40-9:10 → 9:00
    assertEqual(_hrmsRoundIn(520), 540);
    assertEqual(_hrmsRoundIn(550), 540);
    // 18:40-19:10 → 19:00
    assertEqual(_hrmsRoundIn(1120), 1140);
    assertEqual(_hrmsRoundIn(1150), 1140);
    // Default: Math.round(607/15)*15 = 600
    assertEqual(_hrmsRoundIn(607), 600);
  });
});

// ── 8. _hrmsRoundOut ──

describe('_hrmsRoundOut', function () {
  resetDB();

  it('returns null for null input', function () {
    assertEqual(_hrmsRoundOut(null), null);
  });

  it('rounds within defined windows and defaults to 15-min rounding', function () {
    // 6:00-6:20 → 6:00
    assertEqual(_hrmsRoundOut(360), 360);
    assertEqual(_hrmsRoundOut(380), 360);
    // 8:00-8:20 → 8:00
    assertEqual(_hrmsRoundOut(500), 480);
    // 16:30-16:50 → 16:30
    assertEqual(_hrmsRoundOut(1010), 990);
    // 18:00-18:20 → 18:00
    assertEqual(_hrmsRoundOut(1100), 1080);
    // 19:00-19:20 → 19:00
    assertEqual(_hrmsRoundOut(1160), 1140);
    // Default: Math.round(607/15)*15 = 600
    assertEqual(_hrmsRoundOut(607), 600);
  });
});

// ── 9. _hrmsFmtDate ──

describe('_hrmsFmtDate', function () {
  resetDB();

  it('formats ISO date to DD-MMM-YY', function () {
    assertEqual(_hrmsFmtDate('2025-09-08'), '08-Sep-25');
    assertEqual(_hrmsFmtDate('2026-01-15'), '15-Jan-26');
    assertEqual(_hrmsFmtDate('2025-12-31'), '31-Dec-25');
  });

  it('returns em-dash for empty/null input', function () {
    assertEqual(_hrmsFmtDate(''), '\u2014');
    assertEqual(_hrmsFmtDate(null), '\u2014');
  });
});

// ── 10. _hrmsCalcPT ──

describe('_hrmsCalcPT', function () {
  resetDB();

  it('returns 0 for female with gross < 25000', function () {
    assertEqual(_hrmsCalcPT(20000, 'Female', 'jan'), 0);
  });

  it('returns 0 for gross < 7500 (any gender)', function () {
    assertEqual(_hrmsCalcPT(5000, 'Male', 'jan'), 0);
  });

  it('returns 175 for gross 7500-9999', function () {
    assertEqual(_hrmsCalcPT(8000, 'Male', 'jan'), 175);
  });

  it('returns 200 for gross >= 10000 (non-Feb)', function () {
    assertEqual(_hrmsCalcPT(15000, 'Male', 'jan'), 200);
  });

  it('returns 300 for gross >= 10000 in Feb', function () {
    assertEqual(_hrmsCalcPT(15000, 'Male', 'feb'), 300);
  });

  it('female with gross >= 25000 falls through to general rules', function () {
    assertEqual(_hrmsCalcPT(30000, 'Female', 'jan'), 200);
  });
});

// ── 11. _hrmsGetConfirmationDate ──

describe('_hrmsGetConfirmationDate', function () {
  resetDB();

  it('returns DOJ + 3 months - 1 day', function () {
    var emp = { dateOfJoining: '2025-09-08' };
    var conf = _hrmsGetConfirmationDate(emp);
    assertEqual(conf.getFullYear(), 2025);
    assertEqual(conf.getMonth(), 11); // December (0-based)
    assertEqual(conf.getDate(), 7);
  });

  it('handles year boundary: DOJ in November', function () {
    var emp = { dateOfJoining: '2025-11-15' };
    var conf = _hrmsGetConfirmationDate(emp);
    assertEqual(conf.getFullYear(), 2026);
    assertEqual(conf.getMonth(), 1); // February
    assertEqual(conf.getDate(), 14);
  });

  it('returns null if no DOJ', function () {
    assertEqual(_hrmsGetConfirmationDate({}), null);
    assertEqual(_hrmsGetConfirmationDate({ dateOfJoining: '' }), null);
  });
});

// ── 12. _hrmsMonthsSinceConfirmation ──

describe('_hrmsMonthsSinceConfirmation', function () {
  resetDB();

  it('returns -1 if no DOJ', function () {
    assertEqual(_hrmsMonthsSinceConfirmation({}, 2026, 1), -1);
  });

  it('returns -1 if salary month is before confirmation', function () {
    var emp = { dateOfJoining: '2025-09-08' };
    assertEqual(_hrmsMonthsSinceConfirmation(emp, 2025, 11), -1);
  });

  it('calculates months for DOJ 8-Sep-25, salary Jan-26', function () {
    // Conf = 7-Dec-25, salStart = 1-Jan-26
    // wholeMonths=1, frac=(31-7+1)/31=25/31=0.806, total=1.806, MROUND=2.0
    var emp = { dateOfJoining: '2025-09-08' };
    assertEqual(_hrmsMonthsSinceConfirmation(emp, 2026, 1), 2);
  });

  it('returns -1 when salary month equals conf month but salStart < conf', function () {
    // DOJ 1-Oct-25, conf = 31-Dec-25, salStart 1-Dec-25 < conf → -1
    var emp = { dateOfJoining: '2025-10-01' };
    assertEqual(_hrmsMonthsSinceConfirmation(emp, 2025, 12), -1);
  });
});

// ── 13. _hrmsCalcPLGiven ──

describe('_hrmsCalcPLGiven', function () {
  resetDB();

  it('returns 0 if no DOJ', function () {
    assertEqual(_hrmsCalcPLGiven({}, 2026, 4), 0);
  });

  it('returns 0 before eligibility month', function () {
    var emp = { dateOfJoining: '2025-09-08', category: 'Staff' };
    assertEqual(_hrmsCalcPLGiven(emp, 2025, 12), 0);
  });

  it('returns 1.5 for junior staff in eligible month', function () {
    var emp = { dateOfJoining: '2025-09-08', category: 'Staff' };
    assertEqual(_hrmsCalcPLGiven(emp, 2026, 1), 1.5);
  });

  it('returns 1.5 for worker in eligible month', function () {
    var emp = { dateOfJoining: '2025-09-08', category: 'Worker' };
    assertEqual(_hrmsCalcPLGiven(emp, 2026, 1), 1.5);
  });
});

// ── 14. _hrmsCumPLAvail ──

describe('_hrmsCumPLAvail', function () {
  resetDB();

  it('returns 0 if no DOJ', function () {
    assertEqual(_hrmsCumPLAvail({}, 2026, 1), 0);
  });

  it('returns 0 before eligibility', function () {
    var emp = { dateOfJoining: '2025-09-08', category: 'Staff' };
    assertEqual(_hrmsCumPLAvail(emp, 2025, 12), 0);
  });

  it('accumulates PL from FY start when confirmed before FY', function () {
    // DOJ 1-Jan-25, conf 31-Mar-25, eligible Apr 25
    // FY Apr 2025. Salary Jan 26: 10 months x 1.5 = 15
    var emp = { dateOfJoining: '2025-01-01', category: 'Staff' };
    assertEqual(_hrmsCumPLAvail(emp, 2026, 1), 15);
  });

  it('starts from eligibility month when confirmed mid-FY', function () {
    // DOJ 8-Sep-25, conf 7-Dec-25, eligible Jan 26
    // Salary Mar 26: Jan,Feb,Mar = 3 x 1.5 = 4.5
    var emp = { dateOfJoining: '2025-09-08', category: 'Staff' };
    assertEqual(_hrmsCumPLAvail(emp, 2026, 3), 4.5);
  });
});

// ── 15. _hrmsGetDayType ──

describe('_hrmsGetDayType', function () {
  resetDB();

  it('returns WO for Sunday when no plant override', function () {
    // 2025-09-07 is a Sunday
    assertEqual(_hrmsGetDayType('2025-09', 7, 2025, 9, null), 'WO');
  });

  it('returns WD for weekday when no plant override', function () {
    // 2025-09-08 is a Monday
    assertEqual(_hrmsGetDayType('2025-09', 8, 2025, 9, null), 'WD');
  });

  it('returns plant-specific day type from DB', function () {
    DB.hrmsDayTypes = [
      { monthKey: '2025-09', plant: 'P1', dayTypes: { '8': 'WO', '10': 'HD' } }
    ];
    assertEqual(_hrmsGetDayType('2025-09', 8, 2025, 9, 'P1'), 'WO');
    assertEqual(_hrmsGetDayType('2025-09', 10, 2025, 9, 'P1'), 'HD');
  });

  it('falls back to calendar if day not in plant record', function () {
    DB.hrmsDayTypes = [
      { monthKey: '2025-09', plant: 'P1', dayTypes: { '8': 'WO' } }
    ];
    // Day 9 not in dayTypes, 2025-09-09 is Tuesday
    assertEqual(_hrmsGetDayType('2025-09', 9, 2025, 9, 'P1'), 'WD');
  });

  it('falls back to calendar if plant does not match', function () {
    DB.hrmsDayTypes = [
      { monthKey: '2025-09', plant: 'P1', dayTypes: { '8': 'WO' } }
    ];
    assertEqual(_hrmsGetDayType('2025-09', 8, 2025, 9, 'P2'), 'WD');
  });
});

// ── 16. _hrmsIsSA ──

describe('_hrmsIsSA', function () {
  resetDB();

  it('returns true via roles or hrmsRoles', function () {
    CU = { roles: ['Super Admin'] };
    assert(_hrmsIsSA() === true, 'Should be SA via roles');
    CU = { hrmsRoles: ['Super Admin'], roles: [] };
    assert(_hrmsIsSA() === true, 'Should be SA via hrmsRoles');
  });

  it('returns false when no Super Admin role or empty CU', function () {
    CU = { roles: ['User'], hrmsRoles: ['Editor'] };
    assert(!_hrmsIsSA(), 'Should not be SA');
    CU = {};
    assert(!_hrmsIsSA(), 'Should not be SA for empty CU');
  });
});

// ── 17. _hrmsGetBal / _hrmsGetEmpOB ──

describe('_hrmsGetBal and _hrmsGetEmpOB', function () {
  resetDB();

  it('returns zero balances if no data', function () {
    assertDeepEqual(_hrmsGetBal({}, '2026-01'), { plOB: 0, plCB: 0, advOB: 0, advCB: 0 });
  });

  it('returns stored balance for a given month', function () {
    var emp = { extra: { bal: { '2026-01': { plOB: 5, plCB: 3, advOB: 1000, advCB: 500 } } } };
    assertDeepEqual(_hrmsGetBal(emp, '2026-01'), { plOB: 5, plCB: 3, advOB: 1000, advCB: 500 });
  });

  it('_hrmsGetEmpOB uses imported OB for 2026-01', function () {
    var emp = { extra: { plOB: 10, advOB: 2000 } };
    assertDeepEqual(_hrmsGetEmpOB(emp, '2026-01'), { plOB: 10, advOB: 2000 });
  });

  it('_hrmsGetEmpOB uses previous month CB for other months', function () {
    var emp = { extra: { bal: { '2026-01': { plOB: 5, plCB: 8, advOB: 1000, advCB: 700 } } } };
    assertDeepEqual(_hrmsGetEmpOB(emp, '2026-02'), { plOB: 8, advOB: 700 });
  });

  it('_hrmsGetEmpOB returns zeros if no previous month data', function () {
    assertDeepEqual(_hrmsGetEmpOB({ extra: {} }, '2026-06'), { plOB: 0, advOB: 0 });
  });
});

// ── 18. _hexToRgb ──

describe('_hexToRgb', function () {
  resetDB();

  it('converts 6-char hex with and without hash', function () {
    assertDeepEqual(_hexToRgb('#ff0000'), [255, 0, 0]);
    assertDeepEqual(_hexToRgb('0000ff'), [0, 0, 255]);
  });

  it('expands 3-char shorthand hex', function () {
    assertDeepEqual(_hexToRgb('#f0a'), [255, 0, 170]);
  });

  it('uses default #e2e8f0 for falsy input', function () {
    assertDeepEqual(_hexToRgb(null), [226, 232, 240]);
    assertDeepEqual(_hexToRgb(''), [226, 232, 240]);
  });
});
