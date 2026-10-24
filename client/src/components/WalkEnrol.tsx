import { useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import { copy } from '../copy';
import { NODES, isRealNode } from '../venue';
import { useMe } from '../hooks';

export function WalkEnrol() {
  const me = useMe();
  const [walks] = useTable(tables.enrolmentWalk);
  const [matches] = useTable(tables.matchResult);
  const [people] = useTable(tables.person);
  const startWalk = useReducer(reducers.startWalk);
  const finishWalk = useReducer(reducers.finishWalk);
  const cancelWalk = useReducer(reducers.cancelWalk);
  const matchWalk = useReducer(reducers.matchWalk);
  const resetWalks = useReducer(reducers.resetWalks);

  const realNodes = NODES.filter((n) => isRealNode(n.nodeId));
  const [nodeId, setNodeId] = useState(realNodes[0]?.nodeId ?? 101);
  const [recording, setRecording] = useState<'walk' | 'match' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!me) return null;

  const real = walks.filter((w) => !w.synthetic).length;
  const synth = walks.length - real;
  const match = matches[0];
  const matched = match ? people.find((p) => p.personId === match.matchedPersonId) : undefined;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message || copy.errors.generic);
    }
  }

  return (
    <section className="sheet">
      <h3>{copy.walk.title}</h3>
      <p className="hint">{copy.walk.intro}</p>
      <p className="progress">{copy.walk.progress(real, synth)}</p>
      {recording ? (
        <div className="row">
          <span className="recording">{copy.walk.recording}</span>
          <button
            type="button"
            className="primary"
            onClick={() =>
              run(async () => {
                if (recording === 'walk') await finishWalk();
                else await matchWalk();
                setRecording(null);
              })
            }
          >
            {copy.walk.finish}
          </button>
          <button type="button" className="quiet" onClick={() => run(async () => { await cancelWalk(); setRecording(null); })}>
            {copy.walk.cancel}
          </button>
        </div>
      ) : (
        <div className="row">
          <label>
            Node
            <select value={nodeId} onChange={(e) => setNodeId(Number(e.target.value))}>
              {realNodes.map((n) => (
                <option key={n.nodeId} value={n.nodeId}>
                  {n.label.replace('Live node: ', '')}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="primary" onClick={() => run(async () => { await startWalk({ nodeId }); setRecording('walk'); })}>
            {copy.walk.start}
          </button>
          {real >= 1 && (
            <button type="button" onClick={() => run(async () => { await startWalk({ nodeId }); setRecording('match'); })}>
              {copy.walk.match}
            </button>
          )}
          {walks.length > 0 && (
            <button type="button" className="quiet danger-text" onClick={() => run(() => resetWalks())}>
              {copy.walk.reset}
            </button>
          )}
        </div>
      )}
      {match && match.nCandidates > 0 && (
        <p className="ok">{copy.walk.matchResult(matched?.displayName ?? `#${match.matchedPersonId}`, match.distance, match.secondDistance)}</p>
      )}
      <p className="hint">{copy.walk.simulatedNote}</p>
      {error && <p className="warn" role="alert">{error}</p>}
    </section>
  );
}
