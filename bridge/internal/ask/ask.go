// Package ask answers questions about the venue with Claude. Claude gets a
// snapshot of the public tables and one tool, run_sql, that only runs
// SELECTs against a whitelist of public tables.
//
// Claude is reached either through the Anthropic API (anthropic.go) or
// through an OpenAI-compatible chat completions proxy (openai.go).
package ask

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"venuemap/bridge/internal/dwell"
	"venuemap/bridge/internal/history"
	"venuemap/bridge/internal/moss"
	"venuemap/bridge/internal/stdb"
)

const maxRounds = 3

// Public tables only. Nothing with a MAC hash or an identity.
var allowedTables = map[string]bool{
	"node": true, "zone": true, "zone_activity": true, "anon_zone_count": true,
	"person": true, "position": true,
}

var (
	selectRe = regexp.MustCompile(`(?is)^\s*select\s`)
	tableRe  = regexp.MustCompile(`(?i)\b(?:from|join)\s+([a-z_][a-z0-9_]*)`)
	limitRe  = regexp.MustCompile(`(?i)\blimit\s+\d+`)
	banRe    = regexp.MustCompile(`(?i)\b(insert|update|delete|drop|alter|create|truncate|grant)\b|;`)
)

// GuardSQL returns the query with a LIMIT, or an error naming what is wrong.
func GuardSQL(q string) (string, error) {
	q = strings.TrimSpace(q)
	if !selectRe.MatchString(q) {
		return "", fmt.Errorf("only SELECT queries run here")
	}
	if banRe.MatchString(q) {
		return "", fmt.Errorf("query contains a write keyword or a semicolon")
	}
	tables := tableRe.FindAllStringSubmatch(q, -1)
	if len(tables) == 0 {
		return "", fmt.Errorf("no table named")
	}
	for _, m := range tables {
		if !allowedTables[strings.ToLower(m[1])] {
			return "", fmt.Errorf("table %q is not readable here", m[1])
		}
	}
	if !limitRe.MatchString(q) {
		q += " LIMIT 200"
	}
	return q, nil
}

// backend is one model API. complete sends the system prompt, the first
// user message, every earlier exchange and the tool list, and returns the
// model's next reply.
type backend interface {
	complete(ctx context.Context, sys, user string, prior []exchange, tools []toolSpec) (reply, error)
}

type toolSpec struct {
	Name, Desc string
	Props      map[string]any
	Required   []string
}

type toolCall struct {
	ID, Name string
	Input    string // JSON object
}

type toolResult struct {
	ID, Output string
	IsErr      bool
}

type stopReason int

const (
	stopEnd stopReason = iota
	stopTool
	stopMax
	stopRefusal
)

type reply struct {
	Text  string
	Calls []toolCall
	Stop  stopReason
	// raw is the backend's own form of this assistant turn, replayed as is
	// on the next round.
	raw any
}

// exchange is one assistant reply and the tool results it asked for.
type exchange struct {
	reply   reply
	results []toolResult
}

type Asker struct {
	db  *stdb.Client
	llm backend
	// Optional. Search adds the guide tool, History the zone_history tool,
	// Dwell the zone_dwell tool.
	Search  *moss.Client
	History *history.Store
	Dwell   *dwell.Tracker
	// MockOn, when set, tells the model whether the simulated crowd is on.
	MockOn func() bool
}

// New talks to the Anthropic API directly.
func New(db *stdb.Client, apiKey, model string) *Asker {
	return &Asker{db: db, llm: newAnthropic(apiKey, model)}
}

// NewOpenAI talks to an OpenAI-compatible chat completions endpoint, such
// as a proxy that fronts Claude. baseURL ends before /chat/completions.
func NewOpenAI(db *stdb.Client, baseURL, apiKey, model string) *Asker {
	return &Asker{db: db, llm: newOpenAI(baseURL, apiKey, model)}
}

const system = `You answer questions from hackers at Cal Hacks 13.0 about the venue, the Palace of Fine Arts, using live data from a SpacetimeDB database.

How the data works:
- Every zone has a wifi sensing node. zone_activity.smoothed_score (0 to 1) is how much movement the node sees. anon_zone_count.count is how many distinct phones it heard in the last 10 seconds. Neither identifies anyone.
- person and position are only attendees who registered on the web app and left themselves visible. position.node_id is the node their phone was last heard at. confidence is 0 to 1.
- node.is_real tells you whether a node is real hardware or part of the mock crowd for the demo.
- zone.kind is one of stage, hack, workshop, food, social, rest, entry, sponsor.

Rules for answers:
- Use the snapshot first. Call run_sql only when the snapshot does not have what you need.
- For anything about the schedule, workshops, sponsors, prizes, buses, judging or what a zone is for, call search_guide if it is available. Where a guide hit names a zone, pair it with that zone's live numbers from the snapshot.
- For "when" questions (when is food least busy, has the stage emptied out) call zone_history if it is available and describe the trend in words with rough times.
- For "how long" or "how many different people" questions call zone_dwell if it is available. Its numbers cover phones on the venue wifi only, so say "phones" not "people".
- Answer in one to three short sentences. Name zones by zone.name, never by id. Say "quiet", "some movement", "busy" rather than quoting scores unless asked.
- Never guess where an unregistered person is. If someone asks about a person who is not in the person table, say they have not registered or are hidden.
- Do not mention tables, SQL, or node ids unless the question is about them.`

const toolDesc = `Run one read-only SQL query against the live venue database. SpacetimeDB SQL: SELECT columns or * FROM table [JOIN table ON a.col = b.col] [WHERE ...] [LIMIT n]. No ORDER BY, no GROUP BY, no subqueries. COUNT(*) AS n works. Tables: node(node_id, zone_id, floor, label, x, y, is_real, last_seen_at), zone(zone_id, name, kind, floor, capacity), zone_activity(node_id, zone_id, score, smoothed_score, state, pir, anon_count, updated_at), anon_zone_count(zone_id, count, source, updated_at) where source is live, mock or survey, person(person_id, display_name, team, color, visible, paired, created_at), position(person_id, node_id, zone_id, x, y, source, median_rssi, confidence, updated_at) where source is node or app. The column named floor cannot be selected by name (it parses as a function); use SELECT * instead. Never select identity.`

func tool(name, desc string, props map[string]any, required ...string) toolSpec {
	return toolSpec{Name: name, Desc: desc, Props: props, Required: required}
}

func (a *Asker) tools() []toolSpec {
	out := []toolSpec{tool("run_sql", toolDesc, map[string]any{
		"query": map[string]any{"type": "string", "description": "The SELECT statement."},
	}, "query")}
	if a.Search != nil {
		out = append(out, tool("search_guide",
			"Semantic search over the Cal Hacks hacker guide: what each zone is for, the schedule, workshops, sponsor tracks and prizes, buses, judging, Slack. Returns the best matching passages with a zone id where one applies.",
			map[string]any{
				"query": map[string]any{"type": "string", "description": "Natural language, e.g. 'where is the Moss workshop' or 'when do buses leave'."},
			}, "query"))
	}
	if a.History != nil {
		out = append(out, tool("zone_history",
			"Phones heard and movement for one zone over the last hours, averaged into buckets, oldest first. Use it for 'when' questions and trends. Times are UTC.",
			map[string]any{
				"zone_id": map[string]any{"type": "string", "description": "zone.zone_id, e.g. food."},
				"hours":   map[string]any{"type": "integer", "description": "How far back to look, 1 to 48. Default 6."},
			}, "zone_id"))
	}
	if a.Dwell != nil {
		out = append(out, tool("zone_dwell",
			"How long unregistered phones typically stay in each zone, how many distinct phones visited today, how many are there now, and how many came back after leaving. Use it for 'how long do people spend', 'how many different people', 'do people come back'. Omit zone_id for every zone and the venue total.",
			map[string]any{
				"zone_id": map[string]any{"type": "string", "description": "zone.zone_id, e.g. food. Optional."},
			}))
	}
	return out
}

func (a *Asker) runTool(ctx context.Context, name, rawInput string) (string, bool) {
	var in struct {
		Query  string `json:"query"`
		ZoneID string `json:"zone_id"`
		Hours  int    `json:"hours"`
	}
	if err := json.Unmarshal([]byte(rawInput), &in); err != nil {
		return "input was not valid JSON", true
	}
	switch name {
	case "run_sql":
		if in.Query == "" {
			return "query is required", true
		}
		return a.runSQL(ctx, in.Query)
	case "search_guide":
		if a.Search == nil || in.Query == "" {
			return "search_guide is not available", true
		}
		res, err := a.Search.Query(ctx, in.Query, 5)
		if err != nil {
			return "search failed: " + err.Error(), true
		}
		b, _ := json.Marshal(res)
		return string(b), false
	case "zone_history":
		if a.History == nil || in.ZoneID == "" {
			return "zone_history is not available", true
		}
		window, bucket := history.Window(in.Hours)
		pts, err := a.History.Recent(ctx, in.ZoneID, window, bucket)
		if err != nil {
			return "history failed: " + err.Error(), true
		}
		if len(pts) == 0 {
			return "no samples for that zone yet", false
		}
		b, _ := json.Marshal(pts)
		return string(b), false
	case "zone_dwell":
		if a.Dwell == nil {
			return "zone_dwell is not available", true
		}
		var v any = a.Dwell.Report(time.Now())
		if in.ZoneID != "" {
			v = a.Dwell.Zone(in.ZoneID, time.Now())
		}
		b, _ := json.Marshal(v)
		return string(b), false
	}
	return "unknown tool " + name, true
}

// snapshot is a compact JSON view of zones, activity and visible people.
// With liveOnly, zones without a real node keep no movement or phone count.
func (a *Asker) snapshot(ctx context.Context, liveOnly bool) (string, error) {
	zones, err := a.db.Sql(ctx, "SELECT * FROM zone")
	if err != nil {
		return "", err
	}
	act, err := a.db.Sql(ctx, "SELECT * FROM zone_activity")
	if err != nil {
		return "", err
	}
	anon, err := a.db.Sql(ctx, "SELECT * FROM anon_zone_count")
	if err != nil {
		return "", err
	}
	people, err := a.db.Sql(ctx, "SELECT p.person_id, p.display_name, p.team, p.visible, q.node_id, q.confidence FROM person p JOIN position q ON p.person_id = q.person_id")
	if err != nil {
		return "", err
	}
	nodes, err := a.db.Sql(ctx, "SELECT node_id, zone_id, label, is_real FROM node")
	if err != nil {
		return "", err
	}
	type zoneView struct {
		Zone      string   `json:"zone"`
		Kind      string   `json:"kind"`
		Floor     float64  `json:"floor"`
		Movement  float64  `json:"movement"`
		Phones    float64  `json:"phones_heard"`
		People    []string `json:"registered_people_here"`
		RealNodes int      `json:"real_nodes"`
	}
	byZone := map[string]*zoneView{}
	order := []string{}
	for _, z := range zones {
		id := z.Str("zone_id")
		byZone[id] = &zoneView{Zone: z.Str("name"), Kind: z.Str("kind"), Floor: z.Num("floor"), People: []string{}}
		order = append(order, id)
	}
	nodeZone := map[int]string{}
	for _, n := range nodes {
		id := int(n.Num("node_id"))
		nodeZone[id] = n.Str("zone_id")
		if v := byZone[n.Str("zone_id")]; v != nil {
			if b, ok := n["is_real"].(bool); ok && b {
				v.RealNodes++
			}
		}
	}
	for _, r := range act {
		if v := byZone[r.Str("zone_id")]; v != nil {
			if s := r.Num("smoothed_score"); s > v.Movement {
				v.Movement = float64(int(s*100)) / 100
			}
		}
	}
	for _, r := range anon {
		if v := byZone[r.Str("zone_id")]; v != nil {
			v.Phones = r.Num("count")
		}
	}
	for _, p := range people {
		if vis, ok := p["visible"].(bool); ok && !vis {
			continue
		}
		if v := byZone[nodeZone[int(p.Num("node_id"))]]; v != nil {
			name := p.Str("display_name")
			if t := p.Str("team"); t != "" {
				name += " (" + t + ")"
			}
			v.People = append(v.People, name)
		}
	}
	out := make([]*zoneView, 0, len(order))
	for _, id := range order {
		v := byZone[id]
		if liveOnly && v.RealNodes == 0 {
			v.Movement, v.Phones = 0, 0
		}
		out = append(out, v)
	}
	b, err := json.Marshal(out)
	return string(b), err
}

// Ask runs the tool loop and returns Claude's final text. With liveOnly the
// viewer has hidden the simulated crowd, so zones without a real node are
// sent with no counts, the same as the map shows them.
func (a *Asker) Ask(ctx context.Context, question string, liveOnly bool) (string, error) {
	snap, err := a.snapshot(ctx, liveOnly)
	if err != nil {
		return "", fmt.Errorf("snapshot: %w", err)
	}
	crowd := ""
	switch {
	case liveOnly:
		crowd = "The viewer turned on live only and sees real phones only. Zones with real_nodes 0 have no counts: say they have no node yet. Never mention a simulated, mock or demo crowd. If you query the database, ignore anon_zone_count rows whose source is mock and zone_activity rows from nodes whose is_real is false.\n\n"
	case a.MockOn != nil && a.MockOn():
		crowd = "The simulated crowd is on: zones with real_nodes 0 show demo numbers, not real phones.\n\n"
	case a.MockOn != nil:
		crowd = "The simulated crowd is off: only zones with real_nodes above 0 have counts, the rest have no node yet. Say so instead of guessing.\n\n"
	}
	user := fmt.Sprintf("Snapshot of the venue right now (JSON, one entry per zone):\n%s\n\n%sQuestion: %s", snap, crowd, question)
	return a.loop(ctx, system, user)
}

// PrivacyReceipt writes a plain-language note of what the system holds
// about one registered person.
func (a *Asker) PrivacyReceipt(ctx context.Context, personID int) (string, error) {
	rows, err := a.db.Sql(ctx, fmt.Sprintf("SELECT * FROM person WHERE person_id = %d", personID))
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", fmt.Errorf("no person %d", personID)
	}
	pos, _ := a.db.Sql(ctx, fmt.Sprintf("SELECT * FROM position WHERE person_id = %d", personID))
	sig, _ := a.db.Sql(ctx, fmt.Sprintf("SELECT n_real, n_synthetic FROM signature WHERE person_id = %d", personID))
	facts, _ := json.Marshal(map[string]any{
		"person":    rows[0],
		"position":  pos,
		"signature": sig,
		"stored_about_devices": "the database holds a salted SHA-256 hash of the phone's wifi address; sightings of that hash are kept for 70 seconds then deleted; " +
			"the bridge holds the raw wifi address in memory while the phone is in range, and for 24 hours the hash with the zone it is in, when it was first heard, how many times it came back and which zones it stayed in; " +
			"anyone viewing the map can tap an unregistered phone's dot and see its address, which nodes hear it, and that day summary",
		"not_stored": []string{"raw MAC addresses in the database or on disk", "names of people who did not register", "any location history older than 60 seconds (2 minutes for positions sent by the phone app)"},
	})
	const receiptSystem = `Write a short privacy receipt for one attendee of a hackathon venue map, in second person, plain English, under 120 words. State what is held about them right now, how long each thing lasts, and that they can delete everything with the Delete my data button. No headings, no bullet points, no reassurance beyond the facts.`
	return a.loop(ctx, receiptSystem, "Facts as JSON:\n"+string(facts))
}

func (a *Asker) loop(ctx context.Context, sys, user string) (string, error) {
	var prior []exchange
	tools := a.tools()
	for round := 0; round <= maxRounds; round++ {
		r, err := a.llm.complete(ctx, sys, user, prior, tools)
		if err != nil {
			return "", err
		}
		if r.Stop == stopRefusal {
			return "I can't answer that one.", nil
		}
		if r.Stop != stopTool || len(r.Calls) == 0 {
			if r.Stop == stopMax {
				return r.Text + "…", nil
			}
			return strings.TrimSpace(r.Text), nil
		}
		results := make([]toolResult, 0, len(r.Calls))
		for _, c := range r.Calls {
			out, isErr := a.runTool(ctx, c.Name, c.Input)
			results = append(results, toolResult{ID: c.ID, Output: out, IsErr: isErr})
		}
		prior = append(prior, exchange{reply: r, results: results})
	}
	return "That took too many lookups. Try a narrower question.", nil
}

func (a *Asker) runSQL(ctx context.Context, q string) (string, bool) {
	safe, err := GuardSQL(q)
	if err != nil {
		return err.Error(), true
	}
	rows, err := a.db.Sql(ctx, safe)
	if err != nil {
		return "query failed: " + err.Error(), true
	}
	b, _ := json.Marshal(rows)
	if len(b) > 20000 {
		b = append(b[:20000], []byte("… (truncated)")...)
	}
	return string(b), false
}
