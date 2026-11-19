import { useRef, useState } from 'react';
import { FileUp, Radio, Usb } from 'lucide-react';
import { flashEspDevice } from '../device/flash/esp';
import { WebSerialTransport } from '../device/transport';
import { api } from '../platform/cloud';
import { words } from './controller';
import { set, toast } from './store';

/** Flash an ExpressLRS receiver or transmitter, or an ESP32 ground radio, plugged in directly over USB. */
export function RadioFlash({ onClose }: { onClose(): void }) {
  const [file, setFile] = useState<File>(), [address, setAddress] = useState('0x0'), [busy, setBusy] = useState(false), [status, setStatus] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const go = async () => {
    if (!file) return;
    const offset = Number(address);
    if (!Number.isInteger(offset) || offset < 0 || offset % 4096) return toast('The address must be a multiple of 0x1000.', 'bad');
    let port: WebSerialTransport;
    try { port = await WebSerialTransport.request(115200); } catch (error) { if ((error as Error).name !== 'NotFoundError') toast(words(error), 'bad'); return; }
    setBusy(true);
    try {
      const result = await flashEspDevice(port, new Uint8Array(await file.arrayBuffer()), offset, (label, done, total) => { setStatus(label); set({ progress: { label, done, total } }); });
      const summary = result.verified ? `${result.chip} flashed and verified.` : `${result.chip} flashed. This chip cannot read back; check its light to confirm.`;
      toast(summary, 'ok');
      await api('POST', '/activity', { kind: 'test', title: `Flashed ${result.chip}`, part: 'receiver', ok: result.verified ? true : null, testId: 'radio.flash', args: { file: file.name, address }, detail: { summary } }).catch(() => {});
      onClose();
    } catch (error) { toast(words(error), 'bad'); }
    finally { setBusy(false); set({ progress: undefined }); await port.close().catch(() => {}); }
  };
  return (
    <div className="lu-scrim" role="dialog" aria-modal aria-label="Flash a radio">
      <div className="lu-dialog">
        <h2><Radio size={20} /> Flash a radio</h2>
        <p className="lu-hint">ExpressLRS receivers and transmitters, and ESP32 ground radios, plugged in over USB. For a receiver wired to a Betaflight board, use the receiver on the drone instead.</p>
        <input ref={input} type="file" accept=".bin" hidden onChange={e => setFile(e.target.files?.[0])} />
        <button className="lu-btn" onClick={() => input.current?.click()}><FileUp size={15} /> {file ? file.name : 'Choose firmware (.bin)'}</button>
        <label className="lu-tempo">Address<input className="lu-text" value={address} onChange={e => setAddress(e.target.value)} aria-label="Flash address" /></label>
        {busy && <div className="lu-progress" role="status"><span>{status}</span><i /></div>}
        <div className="lu-row"><button className="lu-btn is-primary" disabled={!file || busy} onClick={go}><Usb size={15} /> Choose device and flash</button><button className="lu-link" onClick={onClose} disabled={busy}>Cancel</button></div>
      </div>
    </div>
  );
}
