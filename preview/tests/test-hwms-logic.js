// ═══════════════════════════════════════════════════════════════════════════════
// test-hwms-logic.js — Tests for pure logic functions in js/hwms-logic.js
// Depends on: test-helpers.js (loaded first), common.js, hwms-logic.js
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. _xlSerialToISO ──────────────────────────────────────────────────────
describe('_xlSerialToISO', function () {
  resetDB();

  it('converts Excel serial 44927 to 2023-01-01', function () {
    assertEqual(_xlSerialToISO(44927), '2023-01-01');
  });

  it('converts Excel serial 45292 to 2024-01-01', function () {
    assertEqual(_xlSerialToISO(45292), '2024-01-01');
  });

  it('converts Excel serial 25569 to 1970-01-01 (Unix epoch)', function () {
    assertEqual(_xlSerialToISO(25569), '1970-01-01');
  });

  it('returns null for 0', function () {
    assertEqual(_xlSerialToISO(0), null);
  });

  it('returns null for negative numbers', function () {
    assertEqual(_xlSerialToISO(-1), null);
  });

  it('returns null for numbers >= 100000', function () {
    assertEqual(_xlSerialToISO(100000), null);
  });
});

// ── 2. _fixExcelDate ───────────────────────────────────────────────────────
describe('_fixExcelDate', function () {
  resetDB();

  it('returns empty string for null/undefined/empty', function () {
    assertEqual(_fixExcelDate(null), '');
    assertEqual(_fixExcelDate(undefined), '');
    assertEqual(_fixExcelDate(''), '');
  });

  it('passes through YYYY-MM-DD as-is', function () {
    assertEqual(_fixExcelDate('2024-03-15'), '2024-03-15');
  });

  it('converts numeric Excel serial string', function () {
    assertEqual(_fixExcelDate('44927'), '2023-01-01');
  });

  it('converts numeric JS number Excel serial', function () {
    assertEqual(_fixExcelDate(44927), '2023-01-01');
  });

  it('converts dd-MMM-yy format', function () {
    assertEqual(_fixExcelDate('26-Mar-25'), '2025-03-26');
  });

  it('converts dd-MMM-yyyy format', function () {
    assertEqual(_fixExcelDate('26-Mar-2025'), '2025-03-26');
  });

  it('converts DD/MM/YYYY where day > 12', function () {
    // 15/03/2024 — day=15 > 12 so treated as DD/MM/YYYY
    assertEqual(_fixExcelDate('15/03/2024'), '2024-03-15');
  });

  it('converts DD/MM/YY short year format', function () {
    assertEqual(_fixExcelDate('15/03/24'), '2024-03-15');
  });

  it('returns original string for un-parseable values', function () {
    assertEqual(_fixExcelDate('hello'), 'hello');
  });

  it('returns empty string for number 0', function () {
    assertEqual(_fixExcelDate(0), '');
  });
});

// ── 3. _hwmsContainerSt ────────────────────────────────────────────────────
describe('_hwmsContainerSt', function () {
  resetDB();

  it('returns Draft for null container', function () {
    assertEqual(_hwmsContainerSt(null).label, '—');
  });

  it('returns Draft for container with no status', function () {
    assertEqual(_hwmsContainerSt({ id: 'c1' }).label, 'Draft');
  });

  it('returns Warehouse for Reached status', function () {
    assertEqual(_hwmsContainerSt({ id: 'c1', status: 'Reached' }).label, 'Warehouse');
  });

  it('returns In Transit for Onwater status', function () {
    assertEqual(_hwmsContainerSt({ id: 'c1', status: 'Onwater' }).label, 'In Transit');
  });

  it('normalizes "on water" to In Transit', function () {
    assertEqual(_hwmsContainerSt({ id: 'c1', status: 'on water' }).label, 'In Transit');
  });

  it('returns Draft for unknown status', function () {
    assertEqual(_hwmsContainerSt({ id: 'c1', status: 'pending' }).label, 'Draft');
  });
});

// ── 4. _hwmsMiSt ──────────────────────────────────────────────────────────
describe('_hwmsMiSt', function () {
  resetDB();

  it('returns Draft when not confirmed', function () {
    assertEqual(_hwmsMiSt({ confirmed: false }).label, 'Draft');
  });

  it('returns RFD when confirmed but no container', function () {
    assertEqual(_hwmsMiSt({ confirmed: true }).label, 'RFD');
  });

  it('returns Dispatched when container is Onwater', function () {
    DB.hwmsContainers = [{ id: 'c1', status: 'Onwater' }];
    assertEqual(_hwmsMiSt({ confirmed: true, containerId: 'c1' }).label, 'Dispatched');
  });

  it('returns Warehouse when container is Reached', function () {
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    assertEqual(_hwmsMiSt({ confirmed: true, containerId: 'c1' }).label, 'Warehouse');
  });

  it('returns RFD when container has unknown status', function () {
    DB.hwmsContainers = [{ id: 'c1', status: 'pending' }];
    assertEqual(_hwmsMiSt({ confirmed: true, containerId: 'c1' }).label, 'RFD');
  });
});

// ── 5. _hwmsSiAggSt ───────────────────────────────────────────────────────
describe('_hwmsSiAggSt', function () {
  resetDB();

  it('returns — for invoice with no line items', function () {
    assertEqual(_hwmsSiAggSt({ lineItems: [] }).label, '—');
  });

  it('returns Sold for air container that Reached', function () {
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached', consignmentType: 'air' }];
    var inv = { id: 'inv1', containerId: 'c1', lineItems: [{ partId: 'p1', quantity: 10 }] };
    assertEqual(_hwmsSiAggSt(inv).label, 'Sold');
  });

  it('returns — for air container not yet reached', function () {
    DB.hwmsContainers = [{ id: 'c1', status: 'Onwater', consignmentType: 'air' }];
    var inv = { id: 'inv1', containerId: 'c1', lineItems: [{ partId: 'p1', quantity: 10 }] };
    assertEqual(_hwmsSiAggSt(inv).label, '—');
  });

  it('returns Sold when all sea line items are Sold', function () {
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    var inv = { id: 'inv1', containerId: 'c1', lineItems: [
      { partId: 'p1', soldStatus: 'Sold' },
      { partId: 'p2', soldStatus: 'Sold' }
    ]};
    assertEqual(_hwmsSiAggSt(inv).label, 'Sold');
  });

  it('returns Part. Sold when some sea line items are Sold', function () {
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    var inv = { id: 'inv1', containerId: 'c1', lineItems: [
      { partId: 'p1', soldStatus: 'Sold' },
      { partId: 'p2' }
    ]};
    assertEqual(_hwmsSiAggSt(inv).label, 'Part. Sold');
  });

  it('returns SI Created when SIs exist but nothing sold', function () {
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    DB.hwmsSubInvoices = [{ id: 'si1', invoiceId: 'inv1', lineItems: [] }];
    var inv = { id: 'inv1', containerId: 'c1', lineItems: [{ partId: 'p1' }] };
    assertEqual(_hwmsSiAggSt(inv).label, 'SI Created');
  });

  it('returns — for sea with no SIs and nothing sold', function () {
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    DB.hwmsSubInvoices = [];
    var inv = { id: 'inv1', containerId: 'c1', lineItems: [{ partId: 'p1' }] };
    assertEqual(_hwmsSiAggSt(inv).label, '—');
  });
});

// ── 6. _hwmsPayAggSt ──────────────────────────────────────────────────────
describe('_hwmsPayAggSt', function () {
  resetDB();

  it('returns Pending when no payments exist', function () {
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    DB.hwmsSubInvoices = [];
    var inv = { id: 'inv1', containerId: 'c1', lineItems: [{ partId: 'p1', quantity: 10, rate: 5 }] };
    assertEqual(_hwmsPayAggSt(inv).label, 'Pending');
  });

  it('returns Fully Paid for sea when SI fully paid', function () {
    _hwmsPayCalcReset();
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    DB.hwmsSubInvoices = [{ id: 'si1', invoiceId: 'inv1', lineItems: [{ partId: 'p1', quantity: 10, rate: 5 }] }];
    DB.hwmsPaymentReceipts = [{ status: 'Posted', paymentNumber: 'PAY-1', siUpdates: [
      { siId: 'si1', lines: [{ partNumber: 'p1', palletNumber: '', payAmt: 50 }] }
    ], miUpdates: [], lineItems: [] }];
    var inv = { id: 'inv1', containerId: 'c1', lineItems: [{ partId: 'p1', quantity: 10, rate: 5 }] };
    assertEqual(_hwmsPayAggSt(inv).label, 'Fully Paid');
  });

  it('returns Part. Paid for sea when SI partially paid', function () {
    _hwmsPayCalcReset();
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    DB.hwmsSubInvoices = [{ id: 'si1', invoiceId: 'inv1', lineItems: [{ partId: 'p1', quantity: 10, rate: 5 }] }];
    DB.hwmsPaymentReceipts = [{ status: 'Posted', paymentNumber: 'PAY-1', siUpdates: [
      { siId: 'si1', lines: [{ partNumber: 'p1', palletNumber: '', payAmt: 25 }] }
    ], miUpdates: [], lineItems: [] }];
    var inv = { id: 'inv1', containerId: 'c1', lineItems: [{ partId: 'p1', quantity: 10, rate: 5 }] };
    assertEqual(_hwmsPayAggSt(inv).label, 'Part. Paid');
  });
});

// ── 7. _hwmsContPaySt ─────────────────────────────────────────────────────
describe('_hwmsContPaySt', function () {
  resetDB();

  it('returns — for null container', function () {
    assertEqual(_hwmsContPaySt(null).label, '—');
  });

  it('returns — for container with no invoices', function () {
    DB.hwmsInvoices = [];
    assertEqual(_hwmsContPaySt({ id: 'c1' }).label, '—');
  });

  it('returns Pending when invoices have no payments', function () {
    _hwmsPayCalcReset();
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    DB.hwmsInvoices = [{ id: 'inv1', containerId: 'c1', lineItems: [{ partId: 'p1', quantity: 10, rate: 5 }] }];
    DB.hwmsSubInvoices = [];
    DB.hwmsPaymentReceipts = [];
    assertEqual(_hwmsContPaySt({ id: 'c1' }).label, 'Pending');
  });
});

// ── 8. _hwmsInvStatus ──────────────────────────────────────────────────────
describe('_hwmsInvStatus', function () {
  resetDB();

  it('returns Draft when not confirmed', function () {
    assertEqual(_hwmsInvStatus({ confirmed: false }).label, 'Draft');
  });

  it('returns RFD when confirmed, no container', function () {
    assertEqual(_hwmsInvStatus({ confirmed: true }).label, 'RFD');
  });

  it('returns In Transit when container is Onwater', function () {
    DB.hwmsContainers = [{ id: 'c1', status: 'Onwater' }];
    assertEqual(_hwmsInvStatus({ confirmed: true, containerId: 'c1' }).label, 'In Transit');
  });

  it('returns Sold for air container that Reached', function () {
    _hwmsPayCalcReset();
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached', consignmentType: 'air' }];
    DB.hwmsSubInvoices = [];
    DB.hwmsPaymentReceipts = [];
    var inv = { id: 'inv1', confirmed: true, containerId: 'c1', lineItems: [{ partId: 'p1', quantity: 10, rate: 5 }] };
    assertEqual(_hwmsInvStatus(inv).label, 'Sold');
  });

  it('returns Warehouse for sea container Reached, no SIs, no sold', function () {
    _hwmsPayCalcReset();
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    DB.hwmsSubInvoices = [];
    DB.hwmsPaymentReceipts = [];
    var inv = { id: 'inv1', confirmed: true, containerId: 'c1', lineItems: [{ partId: 'p1', quantity: 10, rate: 5 }] };
    assertEqual(_hwmsInvStatus(inv).label, 'Warehouse');
  });

  it('returns SI (Draft) for sea with SI but nothing sold', function () {
    _hwmsPayCalcReset();
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    DB.hwmsSubInvoices = [{ id: 'si1', invoiceId: 'inv1', lineItems: [{ partId: 'p1', quantity: 5, rate: 5 }] }];
    DB.hwmsPaymentReceipts = [];
    var inv = { id: 'inv1', confirmed: true, containerId: 'c1', lineItems: [{ partId: 'p1', quantity: 10, rate: 5 }] };
    assertEqual(_hwmsInvStatus(inv).label, 'SI (Draft)');
  });

  it('returns Sold for sea when all line items sold', function () {
    _hwmsPayCalcReset();
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    DB.hwmsSubInvoices = [{ id: 'si1', invoiceId: 'inv1', lineItems: [{ partId: 'p1', quantity: 5, rate: 5 }] }];
    DB.hwmsPaymentReceipts = [];
    var inv = { id: 'inv1', confirmed: true, containerId: 'c1', lineItems: [
      { partId: 'p1', quantity: 10, rate: 5, soldStatus: 'Sold' }
    ]};
    assertEqual(_hwmsInvStatus(inv).label, 'Sold');
  });

  it('returns Partially Sold for sea when some items sold', function () {
    _hwmsPayCalcReset();
    DB.hwmsContainers = [{ id: 'c1', status: 'Reached' }];
    DB.hwmsSubInvoices = [{ id: 'si1', invoiceId: 'inv1', lineItems: [] }];
    DB.hwmsPaymentReceipts = [];
    var inv = { id: 'inv1', confirmed: true, containerId: 'c1', lineItems: [
      { partId: 'p1', quantity: 10, rate: 5, soldStatus: 'Sold' },
      { partId: 'p2', quantity: 10, rate: 5 }
    ]};
    assertEqual(_hwmsInvStatus(inv).label, 'Partially Sold');
  });
});

// ── 9. _hwmsContStatus ─────────────────────────────────────────────────────
describe('_hwmsContStatus', function () {
  resetDB();

  it('delegates to _hwmsContainerSt', function () {
    assertEqual(_hwmsContStatus({ id: 'c1', status: 'Reached' }).label, 'Warehouse');
    assertEqual(_hwmsContStatus(null).label, '—');
  });
});

// ── 10. _hwmsPartPalletStatus ──────────────────────────────────────────────
describe('_hwmsPartPalletStatus', function () {
  resetDB();

  it('returns Draft when invoice not confirmed', function () {
    assertEqual(_hwmsPartPalletStatus({ confirmed: false }, {}, null).label, 'Draft');
  });

  it('returns RFD when no container', function () {
    assertEqual(_hwmsPartPalletStatus({ confirmed: true }, {}, null).label, 'RFD');
  });

  it('returns In Transit when container Onwater', function () {
    var cont = { id: 'c1', status: 'Onwater' };
    assertEqual(_hwmsPartPalletStatus({ confirmed: true, containerId: 'c1' }, {}, cont).label, 'In Transit');
  });

  it('returns Sold for air container that Reached', function () {
    _hwmsPayCalcReset();
    var cont = { id: 'c1', status: 'Reached', consignmentType: 'air' };
    DB.hwmsSubInvoices = [];
    DB.hwmsPaymentReceipts = [];
    assertEqual(_hwmsPartPalletStatus({ id: 'inv1', confirmed: true, containerId: 'c1' }, {}, cont).label, 'Sold');
  });

  it('returns Warehouse-Hold for held item', function () {
    _hwmsPayCalcReset();
    var cont = { id: 'c1', status: 'Reached' };
    DB.hwmsSubInvoices = [];
    DB.hwmsPaymentReceipts = [];
    var li = { partId: 'p1', holdStatus: 'hold' };
    assertEqual(_hwmsPartPalletStatus({ id: 'inv1', confirmed: true, containerId: 'c1' }, li, cont).label, 'Warehouse-Hold');
  });

  it('returns Warehouse-Hold for bad whCondition', function () {
    _hwmsPayCalcReset();
    var cont = { id: 'c1', status: 'Reached' };
    DB.hwmsSubInvoices = [];
    DB.hwmsPaymentReceipts = [];
    var li = { partId: 'p1', whCondition: 'damaged' };
    assertEqual(_hwmsPartPalletStatus({ id: 'inv1', confirmed: true, containerId: 'c1' }, li, cont).label, 'Warehouse-Hold');
  });

  it('returns Warehouse when no SI matches and not sold', function () {
    _hwmsPayCalcReset();
    var cont = { id: 'c1', status: 'Reached' };
    DB.hwmsSubInvoices = [];
    DB.hwmsPaymentReceipts = [];
    var li = { partId: 'p1', palletNumber: 'PL1' };
    assertEqual(_hwmsPartPalletStatus({ id: 'inv1', confirmed: true, containerId: 'c1' }, li, cont).label, 'Warehouse');
  });

  it('returns Sold when no SI matches but soldStatus is Sold', function () {
    _hwmsPayCalcReset();
    var cont = { id: 'c1', status: 'Reached' };
    DB.hwmsSubInvoices = [];
    DB.hwmsPaymentReceipts = [];
    var li = { partId: 'p1', palletNumber: 'PL1', soldStatus: 'Sold' };
    assertEqual(_hwmsPartPalletStatus({ id: 'inv1', confirmed: true, containerId: 'c1' }, li, cont).label, 'Sold');
  });

  it('returns SI (Draft) when matched SI not yet picked', function () {
    _hwmsPayCalcReset();
    var cont = { id: 'c1', status: 'Reached' };
    DB.hwmsSubInvoices = [{ id: 'si1', invoiceId: 'inv1', pickupStatus: '', lineItems: [
      { partId: 'p1', palletNumber: 'PL1' }
    ]}];
    DB.hwmsPaymentReceipts = [];
    var li = { partId: 'p1', palletNumber: 'PL1' };
    assertEqual(_hwmsPartPalletStatus({ id: 'inv1', confirmed: true, containerId: 'c1' }, li, cont).label, 'SI (Draft)');
  });

  it('returns Sold when matched SI is Picked but no payment', function () {
    _hwmsPayCalcReset();
    var cont = { id: 'c1', status: 'Reached' };
    DB.hwmsSubInvoices = [{ id: 'si1', invoiceId: 'inv1', pickupStatus: 'Picked', lineItems: [
      { partId: 'p1', palletNumber: 'PL1', quantity: 10, rate: 5 }
    ]}];
    DB.hwmsPaymentReceipts = [];
    var li = { partId: 'p1', palletNumber: 'PL1' };
    assertEqual(_hwmsPartPalletStatus({ id: 'inv1', confirmed: true, containerId: 'c1' }, li, cont).label, 'Sold');
  });
});

// ── 11. _hwmsSiStatus ──────────────────────────────────────────────────────
describe('_hwmsSiStatus', function () {
  resetDB();

  it('returns SI (Draft) when not picked and no payment', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [];
    assertEqual(_hwmsSiStatus({ id: 'si1', pickupStatus: '', lineItems: [] }).label, 'SI (Draft)');
  });

  it('returns Sold when picked but no payment', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [];
    assertEqual(_hwmsSiStatus({ id: 'si1', pickupStatus: 'Picked', lineItems: [{ quantity: 10, rate: 5 }] }).label, 'Sold');
  });

  it('returns Fully Paid when received >= amount', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [{ status: 'Posted', paymentNumber: 'PAY-1', siUpdates: [
      { siId: 'si1', lines: [{ partNumber: 'p1', palletNumber: '', payAmt: 50 }] }
    ], miUpdates: [], lineItems: [] }];
    assertEqual(_hwmsSiStatus({ id: 'si1', pickupStatus: 'Picked', lineItems: [{ quantity: 10, rate: 5 }] }).label, 'Fully Paid');
  });

  it('returns Partially Paid when received > 0 but < amount', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [{ status: 'Posted', paymentNumber: 'PAY-1', siUpdates: [
      { siId: 'si1', lines: [{ partNumber: 'p1', palletNumber: '', payAmt: 10 }] }
    ], miUpdates: [], lineItems: [] }];
    assertEqual(_hwmsSiStatus({ id: 'si1', pickupStatus: 'Picked', lineItems: [{ quantity: 10, rate: 5 }] }).label, 'Partially Paid');
  });
});

// ── 12. _hwmsContNumToSortVal ──────────────────────────────────────────────
describe('_hwmsContNumToSortVal', function () {
  resetDB();

  it('parses CN-001/24 correctly', function () {
    // type=0 (CN) + 24*1000 + 1 = 24001
    assertEqual(_hwmsContNumToSortVal('CN-001/24'), 24001);
  });

  it('parses AC-005/24 with air prefix offset', function () {
    // type=100000 (AC) + 24*1000 + 5 = 124005
    assertEqual(_hwmsContNumToSortVal('AC-005/24'), 124005);
  });

  it('parses CN-123/23', function () {
    assertEqual(_hwmsContNumToSortVal('CN-123/23'), 23123);
  });

  it('returns 0 for invalid format', function () {
    assertEqual(_hwmsContNumToSortVal('INVALID'), 0);
    assertEqual(_hwmsContNumToSortVal(null), 0);
    assertEqual(_hwmsContNumToSortVal(''), 0);
  });
});

// ── 13. _hwmsContGetType ───────────────────────────────────────────────────
describe('_hwmsContGetType', function () {
  resetDB();

  it('returns air for consignmentType air', function () {
    assertEqual(_hwmsContGetType({ consignmentType: 'air' }), 'air');
  });

  it('returns air for AC- prefix container number', function () {
    assertEqual(_hwmsContGetType({ containerNumber: 'AC-001/24' }), 'air');
  });

  it('returns sea for CN- prefix container number', function () {
    assertEqual(_hwmsContGetType({ containerNumber: 'CN-001/24' }), 'sea');
  });

  it('returns sea for null', function () {
    assertEqual(_hwmsContGetType(null), 'sea');
  });

  it('returns sea for empty object', function () {
    assertEqual(_hwmsContGetType({}), 'sea');
  });
});

// ── 14. _hwmsMrCalcStatus ──────────────────────────────────────────────────
describe('_hwmsMrCalcStatus', function () {
  resetDB();

  it('returns Open for MR with no line items', function () {
    assertEqual(_hwmsMrCalcStatus({ id: 'mr1', lineItems: [] }), 'Open');
  });

  it('returns Open when nothing dispatched', function () {
    DB.hwmsSubInvoices = [];
    var mr = { id: 'mr1', lineItems: [{ partId: 'p1', quantity: 100 }] };
    assertEqual(_hwmsMrCalcStatus(mr), 'Open');
  });

  it('returns Closed when all parts fully dispatched', function () {
    DB.hwmsSubInvoices = [{ id: 'si1', lineItems: [
      { _mrMeta: true, mrId: 'mr1' },
      { partId: 'p1', quantity: 100 }
    ]}];
    var mr = { id: 'mr1', lineItems: [{ partId: 'p1', quantity: 100 }] };
    assertEqual(_hwmsMrCalcStatus(mr), 'Closed');
  });

  it('returns Partially Closed when some parts dispatched', function () {
    DB.hwmsSubInvoices = [{ id: 'si1', lineItems: [
      { _mrMeta: true, mrId: 'mr1' },
      { partId: 'p1', quantity: 50 }
    ]}];
    var mr = { id: 'mr1', lineItems: [
      { partId: 'p1', quantity: 100 },
      { partId: 'p2', quantity: 50 }
    ]};
    assertEqual(_hwmsMrCalcStatus(mr), 'Partially Closed');
  });
});

// ── 15. _hwmsMrDispatchInfo ────────────────────────────────────────────────
describe('_hwmsMrDispatchInfo', function () {
  resetDB();

  it('returns empty perPart when no SIs linked', function () {
    DB.hwmsSubInvoices = [];
    var info = _hwmsMrDispatchInfo({ id: 'mr1' });
    assertDeepEqual(info.linkedSis, []);
    assertDeepEqual(info.perPart, {});
  });

  it('aggregates qty per part from linked SIs', function () {
    DB.hwmsSubInvoices = [
      { id: 'si1', subInvoiceNumber: 'SI-001', lineItems: [
        { _mrMeta: true, mrId: 'mr1' },
        { partId: 'p1', quantity: 30 },
        { partId: 'p2', quantity: 20 }
      ]},
      { id: 'si2', subInvoiceNumber: 'SI-002', lineItems: [
        { _mrMeta: true, mrId: 'mr1' },
        { partId: 'p1', quantity: 10 }
      ]}
    ];
    var info = _hwmsMrDispatchInfo({ id: 'mr1' });
    assertEqual(info.linkedSis.length, 2);
    assertEqual(info.perPart['p1'].totalQty, 40);
    assertEqual(info.perPart['p2'].totalQty, 20);
    assertEqual(info.perPart['p1'].subInvoices.length, 2);
  });
});

// ── 16. _hwmsCurrencyParse ─────────────────────────────────────────────────
describe('_hwmsCurrencyParse', function () {
  resetDB();

  it('parses simple number string', function () {
    assertEqual(_hwmsCurrencyParse({ value: '1234.56' }), 1234.56);
  });

  it('parses comma-formatted string', function () {
    assertEqual(_hwmsCurrencyParse({ value: '1,234.56' }), 1234.56);
  });

  it('parses large comma-formatted string', function () {
    assertEqual(_hwmsCurrencyParse({ value: '1,234,567.89' }), 1234567.89);
  });

  it('returns 0 for empty value', function () {
    assertEqual(_hwmsCurrencyParse({ value: '' }), 0);
    assertEqual(_hwmsCurrencyParse({}), 0);
    assertEqual(_hwmsCurrencyParse(null), 0);
  });
});

// ── 17. _hwmsAmtToWords ────────────────────────────────────────────────────
describe('_hwmsAmtToWords', function () {
  resetDB();

  it('returns Zero for 0', function () {
    assertEqual(_hwmsAmtToWords(0), 'Zero');
  });

  it('returns Zero for null', function () {
    assertEqual(_hwmsAmtToWords(null), 'Zero');
  });

  it('converts 1 to USD One Only', function () {
    assertEqual(_hwmsAmtToWords(1), 'USD One Only');
  });

  it('converts 100 to USD One Hundred Only', function () {
    assertEqual(_hwmsAmtToWords(100), 'USD One Hundred Only');
  });

  it('converts 1234 to words', function () {
    assertEqual(_hwmsAmtToWords(1234), 'USD One Thousand Two Hundred Thirty Four Only');
  });

  it('handles cents', function () {
    assertEqual(_hwmsAmtToWords(1.50), 'USD One and Cent Fifty Only');
  });

  it('converts large number', function () {
    assertEqual(_hwmsAmtToWords(1000000), 'USD One Million Only');
  });
});

// ── 18. _hwmsPayCalc / _hwmsPayCalcReset ───────────────────────────────────
describe('_hwmsPayCalc / _hwmsPayCalcReset', function () {
  resetDB();

  it('returns empty maps when no receipts', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [];
    var pc = _hwmsPayCalc();
    assertDeepEqual(pc.bySi, {});
    assertDeepEqual(pc.byMi, {});
    assertEqual(pc.suspenseAir, 0);
    assertEqual(pc.suspenseSea, 0);
  });

  it('aggregates sea SI payments from Posted receipts', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [{ status: 'Posted', paymentNumber: 'PAY-1', siUpdates: [
      { siId: 'si1', lines: [{ partNumber: 'ABC', palletNumber: 'PL1', payAmt: 100 }] }
    ], miUpdates: [], lineItems: [] }];
    var pc = _hwmsPayCalc();
    assertEqual(pc.bySi['si1'].received, 100);
    assertEqual(pc.byLi['si1|ABC|PL1'], 100);
  });

  it('aggregates air MI payments from Posted receipts', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [{ status: 'Posted', paymentNumber: 'PAY-2', miUpdates: [
      { miId: 'inv1', lines: [{ partNumber: 'XYZ', palletNumber: '', payAmt: 200 }] }
    ], siUpdates: [], lineItems: [] }];
    var pc = _hwmsPayCalc();
    assertEqual(pc.byMi['inv1'].received, 200);
    assertEqual(pc.byMiLi['inv1|XYZ|'], 200);
  });

  it('skips non-Posted receipts', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [{ status: 'Draft', paymentNumber: 'PAY-3', siUpdates: [
      { siId: 'si2', lines: [{ partNumber: 'DEF', palletNumber: '', payAmt: 500 }] }
    ], miUpdates: [], lineItems: [] }];
    var pc = _hwmsPayCalc();
    assertDeepEqual(pc.bySi, {});
  });

  it('tracks payment numbers', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [
      { status: 'Posted', paymentNumber: 'PAY-1', siUpdates: [
        { siId: 'si1', lines: [{ partNumber: 'A', palletNumber: '', payAmt: 10 }] }
      ], miUpdates: [], lineItems: [] },
      { status: 'Posted', paymentNumber: 'PAY-2', siUpdates: [
        { siId: 'si1', lines: [{ partNumber: 'A', palletNumber: '', payAmt: 20 }] }
      ], miUpdates: [], lineItems: [] }
    ];
    var pc = _hwmsPayCalc();
    assertEqual(pc.bySi['si1'].received, 30);
    assert(pc.bySi['si1'].payNums.indexOf('PAY-1') >= 0, 'Should contain PAY-1');
    assert(pc.bySi['si1'].payNums.indexOf('PAY-2') >= 0, 'Should contain PAY-2');
  });

  it('accumulates suspense amounts', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [{ status: 'Posted', paymentNumber: 'PAY-S', siUpdates: [], miUpdates: [],
      manualPayments: [
        { type: 'suspense-sea', amount: 500 },
        { type: 'suspense-air', amount: 300 }
      ], lineItems: [] }];
    var pc = _hwmsPayCalc();
    assertEqual(pc.suspenseSea, 500);
    assertEqual(pc.suspenseAir, 300);
  });
});

// ── 19. Payment accessors ──────────────────────────────────────────────────
describe('Payment accessors (_hwmsGetSi*, _hwmsGetMi*, _hwmsGetSiAmt)', function () {
  resetDB();

  it('_hwmsGetSiRcvd returns 0 when no payments', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [];
    assertEqual(_hwmsGetSiRcvd({ id: 'si1' }), 0);
  });

  it('_hwmsGetSiRcvd returns correct amount', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [{ status: 'Posted', paymentNumber: 'P1', siUpdates: [
      { siId: 'si1', lines: [{ partNumber: 'A', palletNumber: '', payAmt: 75 }] }
    ], miUpdates: [], lineItems: [] }];
    assertEqual(_hwmsGetSiRcvd({ id: 'si1' }), 75);
  });

  it('_hwmsGetSiPayNums returns payment numbers', function () {
    // Uses same DB state from previous test — reset to be safe
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [{ status: 'Posted', paymentNumber: 'P1', siUpdates: [
      { siId: 'si1', lines: [{ partNumber: 'A', palletNumber: '', payAmt: 75 }] }
    ], miUpdates: [], lineItems: [] }];
    var nums = _hwmsGetSiPayNums({ id: 'si1' });
    assertEqual(nums.length, 1);
    assertEqual(nums[0], 'P1');
  });

  it('_hwmsGetSiAmt sums quantity*rate excluding _mrMeta', function () {
    var si = { lineItems: [
      { quantity: 10, rate: 5 },
      { quantity: 20, rate: 3 },
      { _mrMeta: true, quantity: 100, rate: 100 }
    ]};
    assertEqual(_hwmsGetSiAmt(si), 110);
  });

  it('_hwmsGetSiAmt returns 0 for empty line items', function () {
    assertEqual(_hwmsGetSiAmt({ lineItems: [] }), 0);
    assertEqual(_hwmsGetSiAmt({}), 0);
  });

  it('_hwmsGetMiRcvd returns MI received amount', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [{ status: 'Posted', paymentNumber: 'P2', miUpdates: [
      { miId: 'inv1', lines: [{ partNumber: 'X', palletNumber: '', payAmt: 250 }] }
    ], siUpdates: [], lineItems: [] }];
    assertEqual(_hwmsGetMiRcvd({ id: 'inv1' }), 250);
  });

  it('_hwmsGetMiPayNums returns MI payment numbers', function () {
    _hwmsPayCalcReset();
    DB.hwmsPaymentReceipts = [{ status: 'Posted', paymentNumber: 'P3', miUpdates: [
      { miId: 'inv1', lines: [{ partNumber: 'X', palletNumber: '', payAmt: 50 }] }
    ], siUpdates: [], lineItems: [] }];
    var nums = _hwmsGetMiPayNums({ id: 'inv1' });
    assertEqual(nums.length, 1);
    assertEqual(nums[0], 'P3');
  });
});
