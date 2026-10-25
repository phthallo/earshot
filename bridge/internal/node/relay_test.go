package node

import (
	"context"
	"strings"
	"testing"

	"venuemap/bridge/internal/ingest"
)

func TestRemoteLinkNeedsAuthAndVenueNodes(t *testing.T) {
	var got []string
	h := &Handler{
		Batch:      ingest.New(nil, 0),
		LocalVenue: "calhacks",
		Auth: func(_ context.Context, key string) (string, bool) {
			if key == "good" {
				return "expo", true
			}
			return "", false
		},
		Allow:   func(_ context.Context, venue string, id int) bool { return venue == "expo" && id == 201 },
		Observe: func(venue string, id int, _ []Sight) { got = append(got, venue) },
	}
	sight := `{"t":"sight","id":201,"items":[["aa",-50]]}` + "\n"

	p := &pipe{in: strings.NewReader(sight)}
	h.ReadLines(context.Background(), p, true)
	if len(got) != 0 || !strings.Contains(p.String(), `"ok":false`) {
		t.Fatalf("unauthenticated remote line must be refused: observed=%v reply=%q", got, p.String())
	}

	p = &pipe{in: strings.NewReader(`{"t":"auth","key":"bad"}` + "\n" + sight)}
	h.ReadLines(context.Background(), p, true)
	if len(got) != 0 || !strings.Contains(p.String(), "unknown relay key") {
		t.Fatalf("bad key must be refused: observed=%v reply=%q", got, p.String())
	}

	foreign := `{"t":"sight","id":104,"items":[["aa",-50]]}` + "\n"
	p = &pipe{in: strings.NewReader(`{"t":"auth","key":"good"}` + "\n" + sight + foreign)}
	h.ReadLines(context.Background(), p, true)
	if len(got) != 1 || got[0] != "expo" {
		t.Fatalf("only the venue's own node may be observed, got %v", got)
	}
	if !strings.Contains(p.String(), `"venue":"expo"`) {
		t.Fatalf("auth ack missing: %q", p.String())
	}

	got = nil
	p = &pipe{in: strings.NewReader(foreign)}
	h.ReadLines(context.Background(), p, false)
	if len(got) != 1 || got[0] != "calhacks" {
		t.Fatalf("local serial lines belong to the local venue without a key, got %v", got)
	}
}
