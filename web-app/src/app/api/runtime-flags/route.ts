import { NextResponse } from 'next/server';
import { isBaseBindingOptional } from '@/lib/baseBinding';

// GET /api/runtime-flags → process-level switches the interface needs to know
// about. Read-only, no arguments, nothing cached.
//
// These are NOT user settings. User settings live in localStorage
// (globalSettings) or in local_data (folder settings); these are properties of
// the process the server is running in, so the browser cannot read them and
// has to ask.
//
// Deliberate shape: a flag that is OFF is ABSENT from the response, not
// `false`. On an ordinary install this endpoint returns `{}` — so the
// developer override for the Absolute Base Binding leaves no trace in the
// network tab of a machine that isn't using it. That is not a security
// property (the source says what the variable is called); it just avoids
// advertising, in every single session, a door that is almost never open.
export async function GET() {
  const flags: Record<string, true> = {};
  if (isBaseBindingOptional()) flags.bindingOptional = true;
  return NextResponse.json(flags);
}
