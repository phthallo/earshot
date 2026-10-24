import { useEffect, useState, type FormEvent } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import { copy } from '../copy';
import { api, ApiError } from '../api';
import { NODES, TEAM_COLORS, isRealNode } from '../venue';
import { useMe, useNow } from '../hooks';

const WARMUP_MS = 5000;
const NODE_ONLINE_MS = 60000;

export function RegisterSheet() {
  const me = useMe();
  const { identity, token } = useSpacetimeDB();
  const now = useNow(250);
  const [sessions] = useTable(tables.pairingSession);
  const [bindings] = useTable(tables.deviceBinding);
  const [liveNodes] = useTable(tables.node.where((n) => n.isReal.eq(true)));

  const upsertPerson = useReducer(reducers.upsertPerson);
  const startPairing = useReducer(reducers.startPairing);
  const cancelPairing = useReducer(reducers.cancelPairing);
  const setVisible = useReducer(reducers.setVisible);
  const unbindDevice = useReducer(reducers.unbindDevice);
  const deleteMe = useReducer(reducers.deleteMe);

  const [name, setName] = useState('');
  const [team, setTeam] = useState('');
  const [color, setColor] = useState(TEAM_COLORS[0]);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const realNodes = NODES.filter((n) => isRealNode(n.nodeId));
  const [nodeId, setNodeId] = useState(realNodes[0]?.nodeId ?? 101);
  const [mac, setMac] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (me && !editing) {
      setName(me.displayName);
      setTeam(me.team);
      setColor(me.color);
    }
    if (!me) {
      setName('');
      setTeam('');
      setColor(TEAM_COLORS[0]);
      setEditing(false);
      setConfirmDelete(false);
      setCode(null);
    }
  }, [me, editing]);

  useEffect(() => {
    if (!me || !identity || !token) return;
    api
      .pairCode(identity.toHexString(), token)
      .then((r) => setCode(r.pairCode))
      .catch(() => setCode(null));
  }, [me?.personId, identity, token]);

  const session = sessions.find((s) => s.status === 'open') ?? [...sessions].sort((a, b) => Number(b.sessionId - a.sessionId))[0];
  const openSession = session?.status === 'open' ? session : undefined;
  const closesIn = openSession ? Math.ceil((openSession.closesAt.toDate().getTime() - now) / 1000) : 0;
  const warming = openSession ? openSession.startedAt.toDate().getTime() + WARMUP_MS > now : false;

  async function run(label: string, fn: () => Promise<unknown>) {
    setError(null);
    setStatus(null);
    try {
      await fn();
      if (label) setStatus(label);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message || copy.errors.generic);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    run(copy.register.saved, async () => {
      await upsertPerson({ displayName: name.trim(), team: team.trim().toLowerCase(), color });
      setEditing(false);
    });
  }

  return (
    <section className="sheet">
      <h2>{copy.register.title}</h2>
      {!me && <p className="intro">{copy.register.intro}</p>}

      {(!me || editing) && (
        <form onSubmit={save} className="stack">
          <label>
            {copy.register.name}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={copy.register.namePlaceholder} maxLength={24} required autoComplete="nickname" />
          </label>
          <label>
            {copy.register.team}
            <input value={team} onChange={(e) => setTeam(e.target.value)} placeholder={copy.register.teamPlaceholder} maxLength={24} spellCheck={false} autoComplete="off" />
          </label>
          <fieldset className="colors">
            <legend>{copy.register.color}</legend>
            {TEAM_COLORS.map((c) => (
              <label key={c} className="color" style={{ background: c }}>
                <input type="radio" name="color" value={c} checked={color === c} onChange={() => setColor(c)} />
                <span className="sr-only">{c}</span>
              </label>
            ))}
          </fieldset>
          <button type="submit" className="primary">
            {copy.register.save}
          </button>
        </form>
      )}

      {me && !editing && (
        <div className="card person-card" style={{ borderColor: me.color }}>
          <span className="dot" style={{ background: me.color }} />
          <strong>{me.displayName}</strong>
          {me.team && <span className="team">{me.team}</span>}
          <button type="button" className="quiet" onClick={() => setEditing(true)}>
            {copy.register.editing}
          </button>
        </div>
      )}

      {me && (
        <>
          <h3>{copy.register.pairHeading}</h3>
          <p className="hint">{copy.register.pairHow}</p>
          {openSession ? (
            <div className="pairing">
              <div className="countdown" aria-live="polite">
                {warming ? copy.register.warmup(Math.max(0, closesIn - 5)) : copy.register.listening(Math.max(0, closesIn))}
              </div>
              <button type="button" className="quiet" onClick={() => run('', () => cancelPairing())}>
                {copy.register.cancelPairing}
              </button>
            </div>
          ) : (
            <div className="row">
              <label>
                {copy.register.pickNode}
                <select value={nodeId} onChange={(e) => setNodeId(Number(e.target.value))}>
                  {realNodes.map((n) => (
                    <option key={n.nodeId} value={n.nodeId}>
                      {n.label.replace('Live node: ', '')}
                      {liveNodes.some((l) => l.nodeId === n.nodeId && now - l.lastSeenAt.toDate().getTime() < NODE_ONLINE_MS) ? '' : ' (offline)'}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="primary" onClick={() => run('', () => startPairing({ nodeId }))}>
                {copy.register.startPairing}
              </button>
            </div>
          )}
          {session && session.status === 'done' && <p className="ok">{copy.register.paired}</p>}
          {session && session.status === 'failed' && <p className="warn">{copy.register.pairFailed}</p>}
          {bindings.length > 0 && (
            <ul className="bindings">
              {bindings.map((b) => (
                <li key={b.macHash}>
                  <code>{b.macHash.slice(0, 10)}…</code> <span className="muted">{b.method}</span>
                  <button type="button" className="quiet" onClick={() => run('', () => unbindDevice({ macHash: b.macHash }))}>
                    {copy.register.unbind}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <details>
            <summary>{copy.register.orType}</summary>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                run(copy.register.bound, async () => {
                  if (!identity || !token) throw new Error(copy.errors.generic);
                  await api.bindMac(identity.toHexString(), token, mac);
                  setMac('');
                });
              }}
            >
              <label>
                {copy.register.macLabel}
                <input value={mac} onChange={(e) => setMac(e.target.value)} placeholder={copy.register.macPlaceholder} inputMode="text" spellCheck={false} autoCapitalize="off" />
              </label>
              <button type="submit">{copy.register.bindMac}</button>
            </form>
            <p className="hint">{copy.register.macHelp}</p>
          </details>

          <h3>{copy.register.codeHeading}</h3>
          <p className="hint">{copy.register.codeHow}</p>
          <div className="pair-code">{code ?? <span className="muted">{copy.register.codeUnavailable}</span>}</div>

          <label className="toggle">
            <input type="checkbox" checked={me.visible} onChange={(e) => run('', () => setVisible({ visible: e.target.checked }))} />
            {copy.register.visible}
          </label>

          {confirmDelete ? (
            <div className="confirm">
              <p>{copy.register.deleteConfirm}</p>
              <button type="button" className="danger" onClick={() => run('', async () => deleteMe())}>
                {copy.register.deleteYes}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)}>
                {copy.register.deleteNo}
              </button>
            </div>
          ) : (
            <button type="button" className="quiet danger-text" onClick={() => setConfirmDelete(true)}>
              {copy.register.deleteAll}
            </button>
          )}
        </>
      )}

      {status && <p className="ok" role="status">{status}</p>}
      {error && <p className="warn" role="alert">{error}</p>}
    </section>
  );
}
