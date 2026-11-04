/**
 * TEMPORARY INSTRUMENT — where does an `attachment_described` frame die?
 * ⚠ REMOVE once the answer is in. Added 2026-11-04, see the shared list §3.
 *
 * WHY THIS EXISTS, and why reading the code a fourth time was the wrong move:
 *
 * Every link of the chain reads correctly, and three of them are now proven in
 * process: `tests/lib/runTurnForQueue.descriptions.test.ts` drives real frames
 * through turnStreamLoop → applyTurnEvent → runnerSink → applyDescriptions →
 * saveLog and the description lands on the earlier message. The compiled dev
 * chunk on the runner's installation contains the new module (measured:
 * `src_lib_0ossoda._.js`, 14:49, 6 references). And disk still holds ZERO
 * descriptions across 79 attachments.
 *
 * "Nobody collected it" and "someone collected it and something overwrote it"
 * leave the identical zero, and so do "the route never flushed" and "the
 * runner never received". Four candidates, one observation. The Stop bug cost
 * three rounds of plausible fixes against a measurement that said "nothing
 * changed" each time — this writes down which link is which instead.
 *
 * Deliberately a FILE and not console.log: the runner's console is a window
 * nobody is reading, and the person who can see the screen is not the person
 * who can read a server log.
 */

import fs from 'fs/promises';
import path from 'path';

/** One line per event, in the shared store so either installation's runner writes the same file. */
const PROBE = path.resolve(process.cwd(), '..', 'local_data', 'sense_probe.log');

/**
 * Append one line. Never throws and never awaits the caller: an instrument that
 * can fail a turn is worse than no instrument.
 */
export function senseProbe(stage: string, detail: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} ${stage} ${JSON.stringify(detail)}\n`;
  void fs.appendFile(PROBE, line, 'utf-8').catch(() => {});
}
