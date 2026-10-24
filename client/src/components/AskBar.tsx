import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { copy } from '../copy';
import { VoiceButton } from './VoiceButton';

type Turn = { id: number; q: string; a?: string; err?: string };

let nextTurnId = 1;

export function AskBar({ enabled, voice }: { enabled: boolean; voice: boolean }) {
  const [q, setQ] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  // Mirrors `busy` for callbacks the voice socket captured in an older render.
  const busyRef = useRef(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => player.current?.pause(), []);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busyRef.current) return;
    const id = nextTurnId++;
    setQ('');
    busyRef.current = true;
    setBusy(true);
    setTurns((t) => [...t, { id, q: text }]);
    try {
      const r = await api.ask(text);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, a: r.answer } : x)));
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : copy.errors.generic;
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, err: msg } : x)));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function speak(text: string) {
    try {
      const blob = await api.tts(text);
      const url = URL.createObjectURL(blob);
      player.current?.pause();
      const el = new Audio(url);
      player.current = el;
      el.onended = () => URL.revokeObjectURL(url);
      await el.play();
    } catch (e) {
      setVoiceError(e instanceof ApiError ? e.message : copy.errors.generic);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    ask(q);
  }

  if (!enabled) {
    return (
      <section className="sheet ask">
        <h2>{copy.ask.title}</h2>
        <p className="intro">{copy.ask.off}</p>
        <p className="hint">{copy.ask.offDetail}</p>
      </section>
    );
  }

  return (
    <section className="sheet ask">
      <h2>{copy.ask.title}</h2>
      <form onSubmit={submit} className="askbar">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={copy.ask.placeholder} aria-label={copy.ask.title} />
        {voice && (
          <VoiceButton
            onTranscript={(text, final) => {
              setQ(text);
              if (final) ask(text);
            }}
            onError={setVoiceError}
          />
        )}
        <button type="submit" className="primary" disabled={busy}>
          {copy.ask.send}
        </button>
      </form>
      {turns.length === 0 && (
        <ul className="examples">
          {copy.ask.examples.map((ex) => (
            <li key={ex}>
              <button type="button" className="link" onClick={() => ask(ex)}>
                {ex}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ol className="turns">
        {turns.map((t) => (
          <li key={t.id}>
            <p className="q">{t.q}</p>
            {t.a && (
              <p className="a">
                {t.a}
                {voice && (
                  <button type="button" className="quiet" onClick={() => speak(t.a!)}>
                    {copy.ask.listen}
                  </button>
                )}
              </p>
            )}
            {t.err && <p className="warn">{t.err}</p>}
            {!t.a && !t.err && <p className="muted">{copy.ask.thinking}</p>}
          </li>
        ))}
      </ol>
      {voiceError && <p className="warn" role="alert">{voiceError}</p>}
    </section>
  );
}
