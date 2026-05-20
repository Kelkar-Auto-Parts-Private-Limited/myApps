/** @file Security app pure logic — location and checkpoint filters. @depends common.js */

// ═══════════════════════════════════════════════════════════════════════════════
// security-logic.js — Pure data/logic functions for Security app (no DOM access)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Filter DB locations to only active KAP-type entries.
 * @returns {Object[]} Array of location objects where type is 'KAP' and not inactive
 */
// Filter KAP-type active locations
function _kapLocations(){ return DB.locations.filter(l=>l.type==='KAP'&&!l.inactive); }

/**
 * Get checkpoints for a given location, sorted by their sort order.
 * @param {string} locId - Location ID to filter checkpoints by
 * @returns {Object[]} Sorted array of checkpoint objects for the location
 */
// Get checkpoints for a location, sorted by sortOrder
function _cpForLoc(locId){ return (DB.checkpoints||[]).filter(cp=>cp.locationId===locId).sort((a,b)=>(a.sortOrder||1)-(b.sortOrder||1)); }
