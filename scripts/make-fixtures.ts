// Generates deterministic, fictional fixture data into fixtures/.
// All proteins and spectra are synthetic; no external databases are used.
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { neutralMass, precursorMz } from "../src/domain/mass.js";
import { theoreticalSpectrum } from "../src/domain/ions.js";
import { digest, TRYPSIN } from "../src/domain/digestion.js";
import { DEFAULT_RESIDUE_MASSES } from "../src/domain/constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = (name: string) => resolve(here, "..", "fixtures", name);

// Fictional proteins designed to exercise every digestion edge case:
//  FAKE_ALPHA "GKAAGK"   : terminal K, fully cleaved GK + AAGK
//  FAKE_BETA  "LKAAGKR"  : shares peptide AAGK with ALPHA; terminal R
//  FAKE_GAMMA "AKRKPK"   : consecutive cuts K->R produce isolated R, KP exception, terminal K
//  FAKE_DELTA "ARPGAKR"  : RP exception, K->R cut, terminal R
const proteins = [
  {
    accession: "FAKE_ALPHA",
    name: "Fictional albumin-like protein alpha",
    sequence: "GKAAGK",
    aliases: ["ALPHA_FICTION", "FA01"],
  },
  {
    accession: "FAKE_BETA",
    name: "Fictional beta protein",
    sequence: "LKAAGKR",
    aliases: ["BETA_FICTION", "FA02"],
  },
  {
    accession: "FAKE_GAMMA",
    name: "Fictional gamma protein with edge cases",
    sequence: "AKRKPK",
    aliases: ["GAMMA_FICTION", "FA03"],
  },
  {
    accession: "FAKE_DELTA",
    name: "Fictional delta protein with RP exception",
    sequence: "ARPGAKR",
    aliases: ["DELTA_FICTION", "FA04"],
  },
];
writeFileSync(out("proteins.json"), JSON.stringify(proteins, null, 2) + "\n");

// Log the digestion map for documentation/debugging.
const digestMap: Record<string, unknown> = {};
for (const p of proteins) {
  digestMap[p.accession] = digest(p.sequence, TRYPSIN, 2);
}
writeFileSync(out("digestion-map.json"), JSON.stringify(digestMap, null, 2) + "\n");

// --- Peak table matching shared peptide AAGK, precursor charge 2 ---
const pep = "AAGK";
const mNeutral = neutralMass(pep, DEFAULT_RESIDUE_MASSES);
const precZ2 = precursorMz(mNeutral, 2);
const ions = theoreticalSpectrum(pep, 1, DEFAULT_RESIDUE_MASSES);

// Every theoretical fragment is observed exactly once, plus one noise peak.
const peaksAAGK = ions.map((ion, i) => ({
  mz: Number(ion.mz.toFixed(6)),
  intensity: 1000 - i * 50,
}));
peaksAAGK.push({ mz: 500.0, intensity: 50 }); // unmatched noise peak
peaksAAGK.sort((a, b) => a.mz - b.mz);
writeFileSync(
  out("peaks_aagk_z2.json"),
  JSON.stringify(
    {
      description: "Synthetic spectrum for shared peptide AAGK, precursor z=2",
      precursorMz: Number(precZ2.toFixed(6)),
      precursorCharge: 2,
      peaks: peaksAAGK,
    },
    null,
    2
  ) + "\n"
);

// Same spectrum at precursor charge 1 (multi-charge fixture).
writeFileSync(
  out("peaks_aagk_z1.json"),
  JSON.stringify(
    {
      description: "Synthetic spectrum for peptide AAGK, precursor z=1",
      precursorMz: Number(precursorMz(mNeutral, 1).toFixed(6)),
      precursorCharge: 1,
      peaks: peaksAAGK,
    },
    null,
    2
  ) + "\n"
);

// No-match peak table: precursor and fragments far from any peptide.
writeFileSync(
  out("peaks_nomatch.json"),
  JSON.stringify(
    {
      description: "Synthetic spectrum with no candidate match",
      precursorMz: 999.999,
      precursorCharge: 2,
      peaks: [
        { mz: 111.111, intensity: 100 },
        { mz: 222.222, intensity: 200 },
        { mz: 333.333, intensity: 150 },
      ],
    },
    null,
    2
  ) + "\n"
);

// Tolerance-boundary fixture: only b ions are probed so the peaks (72/143/200
// Da) are far enough apart that no probe can satisfy a different ion. b1 sits
// exactly at +10 ppm and b3 exactly at -10 ppm (inclusive boundary -> match);
// b2 sits at +10.0001 ppm (just outside -> excluded). y ions are simply not
// observed in this spectrum.
const ppmFactor = (ppm: number) => 1 + ppm / 1_000_000;
const boundaryIons = theoreticalSpectrum(pep, 1, DEFAULT_RESIDUE_MASSES);
const boundaryProbes: { label: string; ppm: number }[] = [
  { label: "b1", ppm: 10 },       // exactly +10 ppm -> match
  { label: "b2", ppm: 10.0001 }, // just outside -> NO match
  { label: "b3", ppm: -10 },      // exactly -10 ppm -> match
];
const boundaryPeaks = boundaryProbes.map(({ label, ppm }) => {
  const ion = boundaryIons.find((i) => `${i.type}${i.number}` === label)!;
  // Full precision so the boundary sits exactly at the limit; rounding to a
  // fixed decimal would push a nominal 10 ppm over the edge.
  return { mz: ion.mz * ppmFactor(ppm), intensity: 800 };
});
writeFileSync(
  out("peaks_boundary.json"),
  JSON.stringify(
    {
      description: "Tolerance boundary spectrum for AAGK (10 ppm fragment tolerance)",
      precursorMz: Number((precZ2 * ppmFactor(5)).toFixed(6)),
      precursorCharge: 2,
      peaks: boundaryPeaks,
    },
    null,
    2
  ) + "\n"
);

// Emit the hand-verifiable constants the test suite asserts against.
writeFileSync(
  out("expected-aagk.json"),
  JSON.stringify(
    {
      peptide: pep,
      residueMasses: {
        A: DEFAULT_RESIDUE_MASSES.A,
        G: DEFAULT_RESIDUE_MASSES.G,
        K: DEFAULT_RESIDUE_MASSES.K,
      },
      water: 18.010564684,
      proton: 1.00727646688,
      neutralMass: Number(mNeutral.toFixed(9)),
      precursorMzZ1: Number(precursorMz(mNeutral, 1).toFixed(9)),
      precursorMzZ2: Number(precZ2.toFixed(9)),
      ions: ions.map((i) => ({
        label: `${i.type}${i.number}`,
        mz: Number(i.mz.toFixed(9)),
      })),
    },
    null,
    2
  ) + "\n"
);

console.log("Fixtures written to", resolve(here, "..", "fixtures"));
