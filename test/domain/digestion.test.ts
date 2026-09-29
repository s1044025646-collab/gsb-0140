import { test } from "node:test";
import assert from "node:assert/strict";
import { digest, isCleavageSite, TRYPSIN } from "../../src/domain/digestion.js";

test("terminal K and R are cleavage points", () => {
  // nothing after the terminal residue, so the whole simple peptide is one piece
  assert.deepEqual(
    digest("AK", TRYPSIN, 0).map((p) => p.sequence),
    ["AK"]
  );
  assert.deepEqual(
    digest("AR", TRYPSIN, 0).map((p) => p.sequence),
    ["AR"]
  );
});

test("K/R followed by P does not cleave (KP and RP exception)", () => {
  // A later cut site (K/R not at terminus, followed by non-P) lets us see
  // that the KP/RP bond stayed intact.
  // "AKPKAK": the K-before-P does not fire, the second K does -> AKPK, AK
  const kp = digest("AKPKAK", TRYPSIN, 0).map((p) => p.sequence);
  assert.deepEqual(kp, ["AKPK", "AK"]);
  // "ARPRAR": R-before-P suppressed, second R fires -> ARPR, AR
  const rp = digest("ARPRAR", TRYPSIN, 0).map((p) => p.sequence);
  assert.deepEqual(rp, ["ARPR", "AR"]);
  // Contrast: without P every site fires.
  // sites after K(idx1) and R(idx2) are consecutive -> isolated R and K
  assert.deepEqual(digest("AKRKAK", TRYPSIN, 0).map((p) => p.sequence).sort(),
    ["AK", "AK", "K", "R"].sort());

  assert.equal(isCleavageSite("AKPK", 1, TRYPSIN), false); // KP
  assert.equal(isCleavageSite("ARPR", 1, TRYPSIN), false); // RP
  assert.equal(isCleavageSite("AAKA", 2, TRYPSIN), true);  // normal K cut
});

test("consecutive cut sites produce isolated single-residue peptide", () => {
  // "AKRK": cuts after K(idx1) and R(idx2) -> AK, R, K
  const seqs = digest("AKRK", TRYPSIN, 0).map((p) => p.sequence);
  assert.deepEqual(seqs.sort(), ["AK", "K", "R"].sort());
  const isolatedR = digest("AKRK", TRYPSIN, 0).find((p) => p.sequence === "R");
  assert.deepEqual({ start: isolatedR!.start, end: isolatedR!.end }, { start: 3, end: 3 });
});

test("missed cleavage enumeration is bounded and counted correctly", () => {
  const zero = digest("AAKRK", TRYPSIN, 0);
  assert.ok(zero.every((p) => p.missedCleavages === 0));
  assert.deepEqual(zero.map((p) => p.sequence).sort(), ["AAK", "R", "K"].sort());

  const one = digest("AAKRK", TRYPSIN, 1);
  const withOne = one.filter((p) => p.missedCleavages === 1).map((p) => p.sequence).sort();
  assert.deepEqual(withOne, ["AAKR", "RK"].sort());

  const two = digest("AAKRK", TRYPSIN, 2);
  assert.ok(two.some((p) => p.sequence === "AAKRK" && p.missedCleavages === 2));
});

test("peptide positions are 1-based inclusive and retained", () => {
  const peptides = digest("GKAAGK", TRYPSIN, 0);
  const aagk = peptides.find((p) => p.sequence === "AAGK")!;
  assert.deepEqual({ start: aagk.start, end: aagk.end }, { start: 3, end: 6 });
  const gk = peptides.find((p) => p.sequence === "GK")!;
  assert.deepEqual({ start: gk.start, end: gk.end }, { start: 1, end: 2 });
});

test("maxMissedCleavages validation", () => {
  assert.throws(() => digest("AAK", TRYPSIN, -1));
  assert.throws(() => digest("AAK", TRYPSIN, 1.5));
});
