// Pins the clock for the five test files whose fixtures contain workouts dated July 2026 (see scripts/run-tests.mjs): the Coach reads a
// 12-week window, and 2026-10-12 is the last day on which those fixtures still fall inside it. Time keeps moving from that day, so
// timers and expiries behave normally. Child servers the tests start inherit this through NODE_OPTIONS.
const Real = Date;
const offset = Real.UTC(2026, 9, 12, 12) - Real.now();
class PinnedDate extends Real {
  constructor(...a) { if (a.length === 0) super(Real.now() + offset); else super(...a); }
  static now() { return Real.now() + offset; }
}
globalThis.Date = PinnedDate;
