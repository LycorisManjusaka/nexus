import { createHash } from 'crypto';

const URL = 'ws://127.0.0.1:4455';
const PASSWORD = 'ubPhqaJsiXjKA6he';
function sha256b64(s) { return createHash('sha256').update(s, 'utf8').digest('base64'); }
const ws = new WebSocket(URL);
let reqCounter = 0; const pending = new Map();
function request(type, data) {
  return new Promise((resolve, reject) => {
    const id = String(++reqCounter);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: id, requestData: data } }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + type)); } }, 8000);
  });
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.op === 0) {
    const d = msg.d;
    const identify = { op: 1, d: { rpcVersion: d.rpcVersion ?? 1, eventSubscriptions: 0 } };
    if (d.authentication) { const secret = sha256b64(PASSWORD + d.authentication.salt); identify.d.authentication = sha256b64(secret + d.authentication.challenge); }
    ws.send(JSON.stringify(identify));
  } else if (msg.op === 2) main();
  else if (msg.op === 7) {
    const d = msg.d; const p = pending.get(d.requestId);
    if (!p) return; pending.delete(d.requestId);
    if (d.requestStatus?.result) p.resolve(d.responseData || {}); else p.reject(new Error((d.requestStatus?.comment || d.requestType) + ' failed'));
  }
});
ws.addEventListener('error', (e) => { console.error('WS error', e?.message || e); process.exit(1); });
async function main() {
  try {
    for (const name of ['動画', '動画__alt']) {
      const s = await request('GetInputSettings', { inputName: name });
      console.log(`\n=== ${name} ===`);
      console.log('clear_on_media_end:', s.inputSettings?.clear_on_media_end);
      console.log('restart_on_activate:', s.inputSettings?.restart_on_activate);
      console.log('looping:', s.inputSettings?.looping);
      console.log('local_file:', s.inputSettings?.local_file);
      const st = await request('GetMediaInputStatus', { inputName: name });
      console.log('mediaState:', st?.mediaState, 'cursor:', st?.mediaCursor, 'duration:', st?.mediaDuration);
    }
    const scene = await request('GetSceneList', {});
    const sceneName = scene.currentProgramSceneName;
    const items = await request('GetSceneItemList', { sceneName });
    console.log('\n=== scene items ===');
    for (const it of items.sceneItems) console.log(`${it.sourceName} enabled=${it.sceneItemEnabled}`);
  } catch (e) { console.error('ERR', e.message); }
  process.exit(0);
}
setTimeout(() => { console.error('overall timeout'); process.exit(1); }, 15000);
