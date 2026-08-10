import { NextResponse } from 'next/server';
import {
  getServiceStatuses,
  loadServices,
  saveServices,
  startService,
  stopService,
  startSession,
  stopSession,
  hostKey,
  listMics,
  findRecognizerPath,
  looksLikeRecognizer,
  listMonitors,
  arrangeWindows,
  consoleTitleFor,
  loadMonitorIndex,
  saveMonitorIndex,
  listOutputDevices,
  setDefaultOutputDevice,
  loadOutputDeviceId,
  saveOutputDeviceId,
} from '@/lib/audioServices';

// Control panel for the audio-session helper processes.
//
// GET  → this machine's service list with live running/stopped status.
// POST → { action: 'save' | 'start' | 'stop' | 'startAll' | 'stopAll', ... }
//
// Everything is scoped to the current hostname (see audioServices.ts), so the
// personal PC and the work PC keep separate setups inside one synced file.

export const runtime = 'nodejs';
// Starting a cold recognizer can take a while; don't let the platform cut it off.
export const maxDuration = 300;

export async function GET() {
  const [services, monitors, monitorIndex, outputDevices, outputDeviceId] = await Promise.all([
    getServiceStatuses(),
    listMonitors(),
    loadMonitorIndex(),
    listOutputDevices(),
    loadOutputDeviceId(),
  ]);
  return NextResponse.json({
    host: hostKey(), services, monitors, monitorIndex, outputDevices, outputDeviceId,
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action || '');

    if (action === 'mics') {
      // Enumerate microphones via the recognizer itself, so the list is exactly
      // what it will see at launch — indices included.
      //
      // The caller may pass a hint path, but the device list belongs to the
      // MACHINE, not to one service row: asking from the voice-changer row must
      // not fail just because that row points at a .py file. So fall back to
      // whichever configured service actually is a recognizer.
      const hint = String(body.path || '');
      let mics = looksLikeRecognizer(hint) ? await listMics(hint) : [];
      let usedPath = hint;
      if (!mics.length) {
        const found = await findRecognizerPath();
        if (found) {
          mics = await listMics(found);
          usedPath = found;
        }
      }
      return NextResponse.json({
        mics,
        usedPath,
        ...(mics.length ? {} : {
          error: 'No recognizer found. Add a service whose Path points at recognize.exe, then Save list.',
        }),
      });
    }

    if (action === 'setOutputDevice') {
      // Persist the choice; only apply it immediately when explicitly asked, so
      // merely picking from the dropdown doesn't reroute your sound mid-call.
      await saveOutputDeviceId(String(body.deviceId || ''));
      if (body.applyNow && body.deviceId) {
        const r = await setDefaultOutputDevice(String(body.deviceId));
        return NextResponse.json({
          ok: r.ok,
          results: [{ id: '_output', label: 'Default output device', ok: r.ok, message: r.ok ? 'switched' : (r.error || 'failed') }],
        });
      }
      return NextResponse.json({ ok: true });
    }

    if (action === 'arrange') {
      // Stack the console windows of services that are actually up. Only
      // running ones are included, so the layout doesn't leave gaps for
      // services that failed or aren't enabled.
      const monitorIndex = typeof body.monitorIndex === 'number'
        ? body.monitorIndex
        : await loadMonitorIndex();
      await saveMonitorIndex(monitorIndex);

      const statuses = await getServiceStatuses();
      const titles = statuses
        .filter(s => s.running && s.showConsole !== false)
        .map(s => consoleTitleFor(s));
      const results = await arrangeWindows(monitorIndex, titles);
      return NextResponse.json({
        ok: results.every(r => r.ok),
        results: results.map(r => ({
          id: r.title, label: r.title.replace(/^Nexus \S+ - ?/, '') || r.title,
          ok: r.ok, message: r.ok ? 'positioned' : 'window not found',
        })),
        services: statuses,
      });
    }

    if (action === 'save') {
      await saveServices(body.services || []);
      return NextResponse.json({ ok: true, services: await getServiceStatuses() });
    }

    if (action === 'startAll' || action === 'stopAll') {
      const results = action === 'startAll' ? await startSession() : await stopSession();
      return NextResponse.json({ ok: results.every(r => r.ok), results, services: await getServiceStatuses() });
    }

    if (action === 'start' || action === 'stop') {
      const def = (await loadServices()).find(s => s.id === body.id);
      if (!def) return NextResponse.json({ error: `No service "${body.id}"` }, { status: 404 });
      const result = action === 'start' ? await startService(def) : await stopService(def);
      return NextResponse.json({ ok: result.ok, results: [result], services: await getServiceStatuses() });
    }

    return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (e: any) {
    console.error('[audio-session] request failed:', e);
    return NextResponse.json({ error: e?.message || 'Request failed' }, { status: 500 });
  }
}
