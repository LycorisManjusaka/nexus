import { NextResponse } from 'next/server';
import { stopComputerSession } from '@/lib/computerTools';

// Global stop-key target. The watcher process (scripts/nexus-stopkey.ps1)
// POSTs here when the user presses Ctrl+Shift+X. This is the only thing that
// can interrupt a runaway computer_input batch — the Stop button aborts the
// client fetch but cannot kill the PowerShell process that is already mid-way
// through executing mouse/keyboard commands.
//
// Body-less POST; returns what it actually stopped so the watcher (or a
// curious human) can see the effect rather than trusting that it worked.
export async function POST() {
  const { killedInput, stoppedTurn } = stopComputerSession();
  return NextResponse.json({ ok: true, killedInput, stoppedTurn });
}
