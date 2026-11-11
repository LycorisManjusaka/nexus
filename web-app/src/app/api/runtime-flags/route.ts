import { NextResponse } from 'next/server';
import { isBaseBindingOptional } from '@/lib/baseBinding';
import { refusalFallbackModelEnvValue } from '@/lib/agentEnv';

// GET /api/runtime-flags → process-level switches the interface needs to know
// about. Read-only, no arguments, nothing cached.
//
// These are NOT user settings. User settings live in localStorage
// (globalSettings) or in local_data (folder settings); these are properties of
// the process the server is running in, so the browser cannot read them and
// has to ask.
//
// Deliberate shape: a switch that is OFF is ABSENT from the response, not
// `false`/`null`. On an ordinary install this endpoint returns `{}` — so the
// developer override for the Absolute Base Binding leaves no trace in the
// network tab of a machine that isn't using it. That is not a security
// property (the source says what the variable is called); it just avoids
// advertising, in every single session, a door that is almost never open.
//
// refusalFallbackModel is a STRING, not a boolean: the .bat override value, so
// the Settings UI can show the real effective retry target instead of the stale
// "claude-opus-4-8" placeholder while the launcher quietly wins. Same absence
// discipline — unset .bat means the key is simply not here, and `{}` stands.
export async function GET() {
  const flags: Record<string, true | string> = {};
  if (isBaseBindingOptional()) flags.bindingOptional = true;
  const refusalFallbackModel = refusalFallbackModelEnvValue();
  if (refusalFallbackModel) flags.refusalFallbackModel = refusalFallbackModel;
  return NextResponse.json(flags);
}
