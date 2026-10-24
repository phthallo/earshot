// Package history keeps a per-zone time series in Postgres. SpacetimeDB
// deletes counts as they age, so "when is food least busy" needs a second
// store. Only anonymous zone numbers go in: never a person or a hash.
//
// Any Postgres works. On TigerData or another Timescale the table becomes
// a hypertable; elsewhere it stays a plain table with an index.
package history

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"venuemap/bridge/internal/stdb"
)

type Store struct {
	pool *pgxpool.Pool
	db   *stdb.Client
}

type Point struct {
	T        time.Time `json:"t"`
	Phones   float64   `json:"phones"`
	Movement float64   `json:"movement"`
}

func Open(ctx context.Context, dsn string, db *stdb.Client) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	s := &Store{pool: pool, db: db}
	if err := s.init(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) init(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS zone_sample (
		ts timestamptz NOT NULL,
		zone_id text NOT NULL,
		phones integer NOT NULL,
		movement real NOT NULL
	)`)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `CREATE EXTENSION IF NOT EXISTS timescaledb`); err == nil {
		_, err = s.pool.Exec(ctx, `SELECT create_hypertable('zone_sample', 'ts', if_not_exists => TRUE)`)
		if err != nil {
			log.Printf("history: hypertable: %v", err)
		}
	}
	_, err = s.pool.Exec(ctx, `CREATE INDEX IF NOT EXISTS zone_sample_zone_ts ON zone_sample (zone_id, ts DESC)`)
	return err
}

// Run samples SpacetimeDB every interval until ctx ends.
func (s *Store) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			s.pool.Close()
			return
		case <-t.C:
			if err := s.sample(ctx); err != nil && ctx.Err() == nil {
				log.Printf("history: %v", err)
			}
		}
	}
}

func (s *Store) sample(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	counts, err := s.db.Sql(ctx, "SELECT zone_id, count FROM anon_zone_count")
	if err != nil {
		return err
	}
	act, err := s.db.Sql(ctx, "SELECT zone_id, smoothed_score FROM zone_activity")
	if err != nil {
		return err
	}
	movement := map[string]float64{}
	for _, r := range act {
		if v := r.Num("smoothed_score"); v > movement[r.Str("zone_id")] {
			movement[r.Str("zone_id")] = v
		}
	}
	now := time.Now().UTC()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, r := range counts {
		zone := r.Str("zone_id")
		if _, err := tx.Exec(ctx, `INSERT INTO zone_sample (ts, zone_id, phones, movement) VALUES ($1, $2, $3, $4)`,
			now, zone, int(r.Num("count")), float32(movement[zone])); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Window clamps a requested number of hours and picks a bucket width that
// keeps a chart or a tool result to a few dozen points.
func Window(hours int) (window, bucket time.Duration) {
	if hours < 1 || hours > 48 {
		hours = 6
	}
	bucket = 5 * time.Minute
	if hours > 12 {
		bucket = 30 * time.Minute
	}
	return time.Duration(hours) * time.Hour, bucket
}

// Recent returns one point per bucket for a zone over the last window.
// Buckets are computed with plain SQL so the query is the same on a
// hypertable and on a normal table.
func (s *Store) Recent(ctx context.Context, zoneID string, window, bucket time.Duration) ([]Point, error) {
	if bucket < time.Minute {
		bucket = time.Minute
	}
	rows, err := s.pool.Query(ctx, `
		SELECT to_timestamp(floor(extract(epoch FROM ts) / $3) * $3) AS b,
		       avg(phones), max(movement)
		FROM zone_sample
		WHERE zone_id = $1 AND ts > now() - $2::interval
		GROUP BY b ORDER BY b`,
		zoneID, fmt.Sprintf("%d seconds", int(window.Seconds())), bucket.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Point{}
	for rows.Next() {
		var p Point
		if err := rows.Scan(&p.T, &p.Phones, &p.Movement); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
