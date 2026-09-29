/**
 * Entirely fictional proteins and synthetic peak tables.
 * No real biological database is used or contacted.
 *
 * FIX_A "MACKRPEPTIDEKR"
 *   trypsin sites (1-based, cut AFTER index):
 *     4 K -> next R (not P): CUT
 *     5 R -> next P: BLOCKED (KP/RP exception)
 *    13 K -> next R: CUT
 *    14 R terminal: end of chain
 *   0-missed peptides:
 *     "MACK"        1-4
 *     "RPEPTIDEK"   5-13
 *     "R"           14-14
 *
 * FIX_B "KRPEPTIDEKQAK"
 *   sites:
 *     1 K -> next R: CUT
 *     2 R -> next P: BLOCKED
 *    10 K -> next Q: CUT
 *    13 K terminal
 *   0-missed peptides:
 *     "K"           1-1
 *     "RPEPTIDEK"   2-10   (SHARED with FIX_A 5-13 -> ambiguous protein)
 *     "QAK"          11-13
 *
 * FIX_C "KACG"
 *   trypsin cleaves after K1 (next A, not P). Chain end after G4.
 *   0-missed: "K" 1-1, "ACG" 2-4.
 *   Hand-computed singly charged ions (constants in src/core/constants.ts):
 *     b1 = A + H+                         = 72.0443902466
 *     b2 = A + C + H+                     = 175.0535747466
 *     y1 = G + H2O + H+                   = 76.0393048703
 *     y2 = C + G + H2O + H+               = 179.0484893703
 *     neutral peptide M  = sum residues + H2O = 249.0783266837
 *     precursor m/z z=1  = M + H+          = 250.0856031503
 *     precursor m/z z=2  = (M+2H+)/2       = 125.5464398085
 */

export const FICTIONAL_PROTEINS = [
  {
    accession: "FIX_A",
    name: "Fixture Alpha",
    aliases: ["ALPHA"],
    sequence: "MACKRPEPTIDEKR",
  },
  {
    accession: "FIX_B",
    name: "Fixture Bravo",
    aliases: ["BRAVO"],
    sequence: "KRPEPTIDEKQAK",
  },
  {
    accession: "FIX_C",
    name: "Fixture Short",
    aliases: ["SHORT"],
    sequence: "KACG",
  },
];

export const EXPECTED_ACG = {
  neutralMass: 249.0783266837,
  precursorMzCharge1: 250.0856031503,
  precursorMzCharge2: 125.5464398085,
  b1: 72.0443902466,
  b2: 175.0535747466,
  y1: 76.0393048703,
  y2: 179.0484893703,
} as const;

/** Synthetic MS/MS for FIX_C peptide ACG, precursor z=1. */
export const ACG_PEAKLIST = {
  clientId: "peak-acg-z1",
  label: "ACG synthetic z1",
  precursorMz: EXPECTED_ACG.precursorMzCharge1,
  chargeHint: 1,
  peaks: [
    // exact-ish b1 / y1 matches
    { mz: EXPECTED_ACG.b1 + 0.00002, intensity: 400 },
    { mz: EXPECTED_ACG.y1 - 0.00002, intensity: 900 },
    // decoy peak that matches nothing
    { mz: 300.0, intensity: 50 },
  ],
};

/**
 * Two peaks within tolerance of the SAME theoretical b1 ion.
 * Only one may consume the ion; the other must stay unmatched (and one
 * observed peak can never match two ions).
 */
export const ACG_CONTESTED_PEAKLIST = {
  clientId: "peak-acg-contested",
  label: "ACG contested ion",
  precursorMz: EXPECTED_ACG.precursorMzCharge1,
  chargeHint: 1,
  peaks: [
    { mz: EXPECTED_ACG.b1 + 0.00001, intensity: 100 }, // closer
    { mz: EXPECTED_ACG.b1 + 0.00005, intensity: 200 }, // farther -> unmatched
    { mz: EXPECTED_ACG.y1, intensity: 300 },
  ],
};

/** Doubly charged precursor, fragment ions singly charged. */
export const ACG_Z2_PEAKLIST = {
  clientId: "peak-acg-z2",
  label: "ACG synthetic z2 precursor",
  precursorMz: EXPECTED_ACG.precursorMzCharge2,
  chargeHint: 2,
  peaks: [
    { mz: EXPECTED_ACG.b2, intensity: 250 },
    { mz: EXPECTED_ACG.y2, intensity: 350 },
  ],
};

/** Precursor far outside tolerance -> no candidate survives. */
export const NO_MATCH_PEAKLIST = {
  clientId: "peak-no-match",
  label: "no precursor candidate",
  precursorMz: 9999.99,
  chargeHint: 1,
  peaks: [{ mz: 72.0444, intensity: 100 }],
};

import type { MatchParams } from "../src/core/types.ts";

type FixtureSearchParams = MatchParams & {
  label: string;
  fragmentCharges: number[];
  maxMissedCleavages: number;
};

export const SEARCH_PARAMS: FixtureSearchParams = {
  label: "default-fixture-search",
  precursorTolerance: 10,
  precursorUnit: "ppm",
  fragmentTolerance: 10,
  fragmentUnit: "ppm",
  charges: [1, 2],
  fixedModificationIds: [],
  fragmentCharges: [1],
  maxMissedCleavages: 1,
};

/** Da-unit counterpart to prove ppm and Da are both supported (never mixed). */
export const SEARCH_PARAMS_DA: FixtureSearchParams = {
  label: "default-fixture-search-da",
  precursorTolerance: 0.0025,
  precursorUnit: "da",
  fragmentTolerance: 0.001,
  fragmentUnit: "da",
  charges: [1, 2],
  fixedModificationIds: [],
  fragmentCharges: [1],
  maxMissedCleavages: 1,
};
