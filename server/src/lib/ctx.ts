import { SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import spacetimedb from '../tables';

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

export const toMs = (ts: Timestamp): number => Number(ts.microsSinceUnixEpoch / 1000n);
export const fromMs = (ms: number): Timestamp => new Timestamp(BigInt(Math.round(ms)) * 1000n);
export const plusMs = (ts: Timestamp, ms: number): Timestamp => new Timestamp(ts.microsSinceUnixEpoch + BigInt(ms) * 1000n);

/** Nodes may only be fed by registered ingest identities (the bridge). */
export function requireIngest(ctx: Ctx): void {
  if (!ctx.db.ingestKey.identity.find(ctx.sender)) throw new SenderError('not an ingest identity');
}

export function requirePerson(ctx: Ctx) {
  const p = ctx.db.person.identity.find(ctx.sender);
  if (!p) throw new SenderError('register first');
  return p;
}
