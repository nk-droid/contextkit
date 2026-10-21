/**
 * Conflict rules (plan §17).
 *
 * Two things can disagree about the same subject: the scanner and the model, or two
 * slices with each other. Neither is resolved by ordering. The rule this module exists
 * to enforce is that a disagreement is *recorded* - whoever loses stays visible, with
 * its grounding intact, so a reader can see that the question was contested.
 *
 * Last-write-wins is the failure mode worth naming. It is what every naive merge does,
 * it produces a document that reads as confident, and the information that something was
 * disputed is gone by the time anyone could act on it.
 */

/**
 * Priority, highest first. A scanner observation bound to the current fingerprint beats
 * documentation; documentation beats inference; an unsupported suggestion never enters
 * the final facts at all.
 */
export const PRIORITY = Object.freeze({
  observed: 3,
  documented: 2,
  inferred: 1,
  unsupported: 0,
});

export function priorityOf(basis) {
  return PRIORITY[basis] ?? PRIORITY.unsupported;
}

/**
 * Reconcile candidates for one subject.
 *
 * Returns the winner, the candidates it displaced, and whether the outcome needs a
 * human or a narrow reconciliation request. A tie between equally grounded candidates
 * is *not* broken - it is reported as contested, because picking one would be exactly
 * the silent choice the rules forbid.
 */
export function reconcile(subject, candidates) {
  if (!candidates.length) {
    return { subject, resolution: "none", winner: null, displaced: [], contested: false };
  }

  const usable = candidates.filter((c) => priorityOf(c.basis) > PRIORITY.unsupported);
  const dropped = candidates.filter((c) => priorityOf(c.basis) === PRIORITY.unsupported);
  if (!usable.length) {
    return {
      subject, resolution: "unsupported", winner: null, displaced: dropped, contested: false,
      note: "every candidate was an unsupported suggestion",
    };
  }

  const best = Math.max(...usable.map((c) => priorityOf(c.basis)));
  const leaders = usable.filter((c) => priorityOf(c.basis) === best);
  const displaced = [...usable.filter((c) => !leaders.includes(c)), ...dropped];

  if (leaders.length === 1) {
    return { subject, resolution: "resolved", winner: leaders[0], displaced, contested: false };
  }

  // Equal grounding. Agreement is not a conflict; disagreement needs reconciliation.
  const values = new Set(leaders.map((c) => JSON.stringify(c.value)));
  if (values.size === 1) {
    return { subject, resolution: "agreed", winner: leaders[0], displaced, contested: false };
  }
  return {
    subject, resolution: "contested", winner: null, displaced,
    contested: true, candidates: leaders,
    note: "candidates are equally grounded and disagree; a narrow reconciliation is required",
  };
}

/**
 * Documentation that contradicts implementation.
 *
 * The implementation observation is kept and the documented statement is preserved
 * beside it as a contradiction, rather than one overwriting the other. A README that no
 * longer matches the code is a fact about the repository worth reporting - often a more
 * useful one than either statement alone.
 */
export function contradictionBetween(observed, documented, subject) {
  return {
    id: `contradiction.${subject}`.replace(/[^a-z0-9._-]/gi, "-").toLowerCase(),
    subject,
    kind: "documentation-vs-implementation",
    implementation: {
      value: observed.value, basis: observed.basis,
      evidenceIds: observed.evidenceIds ?? [], sliceId: observed.sliceId ?? null,
    },
    documentation: {
      value: documented.value, basis: documented.basis,
      evidenceIds: documented.evidenceIds ?? [], sliceId: documented.sliceId ?? null,
    },
    resolution: "implementation-kept",
    note: "The documented statement is preserved; it was not used as a fact.",
  };
}

/**
 * Reconcile a whole set of slice outputs, grouped by subject.
 *
 * @param {Array<{subject: string, value: *, basis: string, evidenceIds?: string[], sliceId?: string}>} claims
 */
export function reconcileAll(claims) {
  const bySubject = new Map();
  for (const claim of claims) {
    if (!bySubject.has(claim.subject)) bySubject.set(claim.subject, []);
    bySubject.get(claim.subject).push(claim);
  }

  const resolved = [];
  const contested = [];
  const contradictions = [];

  for (const [subject, candidates] of bySubject) {
    const outcome = reconcile(subject, candidates);
    if (outcome.contested) contested.push(outcome);
    else if (outcome.winner) resolved.push(outcome);

    // Documentation displaced by an observation is a contradiction, not a silent loss.
    const winner = outcome.winner;
    if (winner?.basis === "observed") {
      for (const loser of outcome.displaced) {
        if (loser.basis !== "documented") continue;
        if (JSON.stringify(loser.value) === JSON.stringify(winner.value)) continue;
        contradictions.push(contradictionBetween(winner, loser, subject));
      }
    }
  }

  return {
    resolved,
    contested,
    contradictions,
    // Nothing is dropped without being counted; a merge that quietly loses candidates is
    // indistinguishable from one that had none.
    summary: {
      subjects: bySubject.size,
      resolvedCount: resolved.length,
      contestedCount: contested.length,
      contradictionCount: contradictions.length,
      displacedCount: [...resolved, ...contested].reduce((n, o) => n + o.displaced.length, 0),
    },
  };
}

/**
 * A narrow reconciliation request for one contested subject (plan §17).
 *
 * Deliberately minimal: the subject, the competing claims, and their evidence. A broad
 * re-ask invites the model to revisit everything and produce a third answer; this one
 * can only choose between what is already grounded, or decline.
 */
export function buildReconciliationRequest(outcome) {
  return {
    subject: outcome.subject,
    instruction: [
      "Two analyses disagree about one subject, and both are equally grounded.",
      "",
      "Choose the claim the evidence supports, or answer 'unresolved' if it does not",
      "settle the question. Do not propose a third answer, and do not reason beyond the",
      "evidence listed here.",
    ].join("\n"),
    candidates: outcome.candidates.map((c, i) => ({
      option: i + 1, value: c.value, basis: c.basis,
      evidenceIds: c.evidenceIds ?? [], sliceId: c.sliceId ?? null,
    })),
    allowedAnswers: ["option-<n>", "unresolved"],
  };
}
