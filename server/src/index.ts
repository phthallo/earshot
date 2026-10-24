import { ScheduleAt } from 'spacetimedb';
import spacetimedb from './tables';
import { TICK_MS } from './reducers/tick';

export { default } from './tables';
export { registerIngest, addIngest, seedNodes, seedZones } from './reducers/venue';
export { pushMotionBatch, pushSightingsBatch, pushAnonPoints, pushCsi } from './reducers/ingest';
export { upsertPerson, setTeam, setVisible, startPairing, cancelPairing, bindMacFor, unbindDevice, deleteMe, setAppPosition, setSurveyCount } from './reducers/people';
export { startWalk, cancelWalk, finishWalk, matchWalk, resetWalks } from './reducers/walks';
export { tick } from './reducers/tick';

export const init = spacetimedb.init((ctx) => {
  ctx.db.tickSchedule.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(BigInt(TICK_MS) * 1000n) });
});

// Own-row tables: a client only ever sees its own rows.
export const deviceBindingFilter = spacetimedb.clientVisibilityFilter.sql('SELECT * FROM device_binding WHERE identity = :sender');
export const pairingSessionFilter = spacetimedb.clientVisibilityFilter.sql('SELECT * FROM pairing_session WHERE identity = :sender');
export const enrolmentWalkFilter = spacetimedb.clientVisibilityFilter.sql('SELECT * FROM enrolment_walk WHERE identity = :sender');
export const matchResultFilter = spacetimedb.clientVisibilityFilter.sql('SELECT * FROM match_result WHERE identity = :sender');
