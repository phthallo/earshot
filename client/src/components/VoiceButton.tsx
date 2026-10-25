import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { copy } from '../copy';

type Props = { onTranscript: (text: string, final: boolean) => void; onListening?: (on: boolean) => void; onError: (msg: string) => void };

// Streams 16 kHz pcm_s16le from the microphone to the bridge, which relays
// it to Cartesia Ink and returns transcripts.
export function VoiceButton({ onTranscript, onListening, onError }: Props) {
  const [on, setOn] = useState(false);
  useEffect(() => onListening?.(on), [on, onListening]);
  const starting = useRef(false);
  const ws = useRef<WebSocket | null>(null);
  const audio = useRef<{ ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode } | null>(null);

  async function start() {
    if (starting.current || ws.current) return;
    starting.current = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
    } catch {
      starting.current = false;
      onError(copy.ask.micDenied);
      return;
    }
    try {
      const ctx = new AudioContext({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const sock = new WebSocket(api.sttUrl());
      sock.binaryType = 'arraybuffer';
      sock.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data as string) as { type: string; text?: string; is_final?: boolean; message?: string };
          if (m.type === 'transcript' && m.text) onTranscript(m.text, Boolean(m.is_final));
          if (m.type === 'error') onError(m.message ?? copy.errors.generic);
        } catch {
          // non-JSON frame; ignore
        }
      };
      sock.onerror = () => onError(copy.errors.generic);
      sock.onclose = () => {
        if (ws.current === sock) stop();
      };
      node.onaudioprocess = (e) => {
        if (sock.readyState !== WebSocket.OPEN) return;
        const f32 = e.inputBuffer.getChannelData(0);
        const i16 = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
        sock.send(i16.buffer);
      };
      // A ScriptProcessor only runs while connected to the destination; the
      // muted gain keeps the microphone out of the speakers.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      ws.current = sock;
      audio.current = { ctx, stream, node };
      setOn(true);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      onError(copy.errors.generic);
    } finally {
      starting.current = false;
    }
  }

  function stop() {
    const sock = ws.current;
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send('finalize');
      setTimeout(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send('close');
        sock.close();
      }, 1500);
    }
    audio.current?.node.disconnect();
    audio.current?.stream.getTracks().forEach((t) => t.stop());
    audio.current?.ctx.close();
    audio.current = null;
    ws.current = null;
    setOn(false);
  }

  useEffect(() => () => stop(), []);

  return (
    <button type="button" className={on ? 'mic on' : 'mic'} onClick={on ? stop : start} aria-pressed={on}>
      {on && <span className="pulse" aria-hidden="true" />}
      {on ? copy.ask.stop : copy.ask.speak}
    </button>
  );
}
