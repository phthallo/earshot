import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../../api';
import { copy } from '../../copy';

const ESP_WEB_TOOLS = 'https://unpkg.com/esp-web-tools@10.1.1/dist/web/install-button.js?module';
const BAUD = 115200;
const HELLO_TIMEOUT_MS = 5000;

// The subset of Web Serial this page uses. The DOM lib does not ship these types.
type SerialPort = {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
};
type Serial = { requestPort(): Promise<SerialPort> };
const serial = (navigator as Navigator & { serial?: Serial }).serial;

type Hello = { t: 'hello'; id: number; fw: string; mac: string; ch?: number; uplink?: string };

function loadEspWebTools() {
  if (document.querySelector(`script[src="${ESP_WEB_TOOLS}"]`)) return;
  const s = document.createElement('script');
  s.type = 'module';
  s.src = ESP_WEB_TOOLS;
  document.head.append(s);
}

// Opens the port, sends the id and waits for the firmware's hello line.
async function setNodeId(port: SerialPort, id: number): Promise<Hello> {
  await port.open({ baudRate: BAUD });
  const writer = port.writable!.getWriter();
  const reader = port.readable!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + HELLO_TIMEOUT_MS;
  try {
    await writer.write(new TextEncoder().encode(JSON.stringify({ t: 'set', id }) + '\n'));
    while (Date.now() < deadline) {
      const timer = new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()));
      const { done, value } = await Promise.race([reader.read(), timer]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const msg = JSON.parse(line.trim()) as { t?: string; id?: number; fw?: string; mac?: string; msg?: string };
          // A board that reboots on port open sends its old hello first; only the one with the new id counts.
          if (msg.t === 'hello' && typeof msg.mac === 'string' && msg.id === id) return msg as Hello;
          if (msg.t === 'error' && typeof msg.msg === 'string') throw new Error(msg.msg);
        } catch {
          // boot log or a partial line
        }
      }
    }
    throw new Error(copy.admin.noReply);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    writer.releaseLock();
    await port.close().catch(() => {});
  }
}

export function Flash({ venueId, defaultId, onSaved }: { venueId: string; defaultId: number; onSaved: () => Promise<void> }) {
  const [id, setId] = useState(String(defaultId));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  const supported = !!serial;

  useEffect(() => {
    if (supported) loadEspWebTools();
  }, [supported]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const nodeId = Number(id);
    if (!serial || !Number.isInteger(nodeId) || nodeId < 1 || nodeId > 65535) return;
    setBusy(true);
    setStatus({ kind: 'ok', text: copy.admin.waitingForBoard });
    let port: SerialPort;
    try {
      port = await serial.requestPort();
    } catch {
      setStatus({ kind: 'warn', text: copy.admin.serialDenied });
      setBusy(false);
      return;
    }
    try {
      const hello = await setNodeId(port, nodeId);
      await api.rememberBoard(hello.mac, nodeId, venueId);
      await onSaved();
      setStatus({ kind: 'ok', text: copy.admin.boardSaved(hello.mac, hello.fw, nodeId) });
    } catch (err) {
      setStatus({ kind: 'warn', text: err instanceof ApiError || err instanceof Error ? err.message : copy.errors.generic });
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return <p className="hint">{copy.admin.noSerial}</p>;

  return (
    <>
      <div className="row">
        <esp-web-install-button manifest="/firmware/manifest-usb.json">
          <button type="button" slot="activate">
            {copy.admin.flashUsb}
          </button>
        </esp-web-install-button>
        <esp-web-install-button manifest="/firmware/manifest-battery.json">
          <button type="button" slot="activate">
            {copy.admin.flashBattery}
          </button>
        </esp-web-install-button>
      </div>
      <h3>{copy.admin.setIdTitle}</h3>
      <form className="row" onSubmit={submit}>
        <label>
          {copy.admin.nodeIdLabel}
          <input type="number" inputMode="numeric" min={1} max={65535} value={id} onChange={(e) => setId(e.target.value)} required />
        </label>
        <button type="submit" className="primary" disabled={busy}>
          {copy.admin.setId}
        </button>
      </form>
      {status && <p className={status.kind}>{status.text}</p>}
    </>
  );
}
