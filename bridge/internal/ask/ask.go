// Package ask answers questions about the venue with Claude. Claude gets a
// snapshot of the public tables and one tool, run_sql, that only runs
// SELECTs against a whitelist of public tables.
package ask

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	"github.com/anthropics/anthropic-sdk-go/shared/constant"

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

type Asker struct {
	db     *stdb.Client
	client anthropic.Client
	model  string
}

func New(db *stdb.Client, apiKey, model string) *Asker {
	return &Asker{db: db, client: anthropic.NewClient(option.WithAPIKey(apiKey)), model: model}
}

const system = `You answer questions from hackers at Cal Hacks 13.0 about the venue, the Palace of Fine Arts, using live data from a SpacetimeDB database.

How the data works:
- Every zone has a wifi sensing node. zone_activity.smoothed_score (0 to 1) is how much movement the node sees. anon_zone_count.count is how many distinct phones it heard in the last 10 seconds. Neither identifies anyone.
- person and position are only attendees who registered on the web app and left themselves visible. position.node_id is the node their phone was last heard at. confidence is 0 to 1.
- node.is_real tells you whether a node is real hardware or part of the mock crowd for the demo.
- zone.kind is one of stage, hack, workshop, food, social, rest, entry, sponsor.

Rules for answers:
- Use the snapshot first. Call run_sql only when the snapshot does not have what you need.
- Answer in one to three short sentences. Name zones by zone.name, never by id. Say "quiet", "some movement", "busy" rather than quoting scores unless asked.
- Never guess where an unregistered person is. If someone asks about a person who is not in the person table, say they have not registered or are hidden.
- Do not mention tables, SQL, or node ids unless the question is about them.`

const toolDesc = `Run one read-only SQL query against the live venue database. SpacetimeDB SQL: SELECT columns or * FROM table [JOIN table ON a.col = b.col] [WHERE ...] [LIMIT n]. No ORDER BY, no GROUP BY, no subqueries. COUNT(*) AS n works. Tables: node(node_id, zone_id, floor, label, x, y, is_real, last_seen_at), zone(zone_id, name, kind, floor, capacity), zone_activity(node_id, zone_id, score, smoothed_score, state, pir, anon_count, updated_at), anon_zone_count(zone_id, count, source, updated_at) where source is live, mock or survey, person(person_id, display_name, team, color, visible, paired, created_at), position(person_id, node_id, zone_id, x, y, source, median_rssi, confidence, updated_at) where source is node or app. The column named floor cannot be selected by name (it parses as a function); use SELECT * instead. Never select identity.`

func (a *Asker) tools() []anthropic.BetaToolUnionParam {
	return []anthropic.BetaToolUnionParam{{OfTool: &anthropic.BetaToolParam{
		Name:        "run_sql",
		Description: anthropic.String(toolDesc),
		InputSchema: anthropic.BetaToolInputSchemaParam{
			Properties: map[string]any{
				"query": map[string]any{"type": "string", "description": "The SELECT statement."},
			},
			Required:    []string{"query"},
			ExtraFields: map[string]any{"additionalProperties": false},
		},
	}}}
}

// snapshot is a compact JSON view of zones, activity and visible people.
func (a *Asker) snapshot(ctx context.Context) (string, error) {
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
		out = append(out, byZone[id])
	}
	b, err := json.Marshal(out)
	return string(b), err
}

// Ask runs the tool loop and returns Claude's final text.
func (a *Asker) Ask(ctx context.Context, question string) (string, error) {
	snap, err := a.snapshot(ctx)
	if err != nil {
		return "", fmt.Errorf("snapshot: %w", err)
	}
	user := fmt.Sprintf("Snapshot of the venue right now (JSON, one entry per zone):\n%s\n\nQuestion: %s", snap, question)
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
		"stored_about_devices": "a salted SHA-256 hash of the phone's wifi address, never the address itself; " +
			"sightings of that hash are kept for 70 seconds then deleted",
		"not_stored": []string{"raw MAC addresses", "names of people who did not register", "any location history older than 60 seconds (2 minutes for positions sent by the phone app)"},
	})
	const receiptSystem = `Write a short privacy receipt for one attendee of a hackathon venue map, in second person, plain English, under 120 words. State what is held about them right now, how long each thing lasts, and that they can delete everything with the Delete my data button. No headings, no bullet points, no reassurance beyond the facts.`
	return a.loop(ctx, receiptSystem, "Facts as JSON:\n"+string(facts))
}

func (a *Asker) loop(ctx context.Context, sys, user string) (string, error) {
	messages := []anthropic.BetaMessageParam{
		anthropic.NewBetaUserMessage(anthropic.NewBetaTextBlock(user)),
	}
	for round := 0; round <= maxRounds; round++ {
		resp, err := a.client.Beta.Messages.New(ctx, anthropic.BetaMessageNewParams{
			Model:        anthropic.Model(a.model),
			MaxTokens:    2048,
			System:       []anthropic.BetaTextBlockParam{{Text: sys}},
			Messages:     messages,
			Tools:        a.tools(),
			OutputConfig: anthropic.BetaOutputConfigParam{Effort: anthropic.BetaOutputConfigEffortLow},
			Betas:        []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01},
			Fallbacks:    anthropic.BetaFallbacksParamUnion{OfDefault: constant.ValueOf[constant.Default]()},
		})
		if err != nil {
			return "", err
		}
		if resp.StopReason == anthropic.BetaStopReasonRefusal {
			return "I can't answer that one.", nil
		}
		messages = append(messages, resp.ToParam())

		var text strings.Builder
		var results []anthropic.BetaContentBlockParamUnion
		for _, block := range resp.Content {
			switch v := block.AsAny().(type) {
			case anthropic.BetaTextBlock:
				text.WriteString(v.Text)
			case anthropic.BetaToolUseBlock:
				var in struct {
					Query string `json:"query"`
				}
				if err := json.Unmarshal([]byte(v.JSON.Input.Raw()), &in); err != nil || in.Query == "" {
					results = append(results, anthropic.NewBetaToolResultBlock(v.ID, "input was not valid JSON with a query string", true))
					continue
				}
				out, isErr := a.runSQL(ctx, in.Query)
				results = append(results, anthropic.NewBetaToolResultBlock(v.ID, out, isErr))
			}
		}
		if resp.StopReason != anthropic.BetaStopReasonToolUse || len(results) == 0 {
			if resp.StopReason == anthropic.BetaStopReasonMaxTokens {
				return text.String() + "…", nil
			}
			return strings.TrimSpace(text.String()), nil
		}
		messages = append(messages, anthropic.NewBetaUserMessage(results...))
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
