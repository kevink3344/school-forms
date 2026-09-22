// Wording for the two archive controls (the admin dashboard and the staff queue).
//
// It lives in one place because the strip under each toolbar tells the reader
// which control to move BY NAME. A note reading "switch on 'Show archived only'"
// beside a switch labelled something else is worse than no note at all — it
// sends the reader looking for a control that does not exist. Same reasoning for
// the counts: the pair of numbers is the whole reason two separate lists are safe
// to live with, so both pages must phrase them identically.
export const ARCHIVE_TOGGLE_LABEL = "Show archived only";

// "3 submissions" / "1 submission" — and the verb agrees too, because
// "1 archived submissions match these filters" is exactly the kind of small
// wrongness that makes a reader distrust the number beside it.
export const submissionNoun = (n: number) => (n === 1 ? "submission" : "submissions");

export const archivedMatches = (n: number) =>
  `${n} archived ${submissionNoun(n)} ${n === 1 ? "matches" : "match"}`;
