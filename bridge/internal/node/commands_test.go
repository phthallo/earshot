package node

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"

	"venuemap/bridge/internal/ingest"
)

type pipe struct {
	in  io.Reader
	out bytes.Buffer
}

func (p *pipe) Read(b []byte) (int, error)  { return p.in.Read(b) }
func (p *pipe) Write(b []byte) (int, error) { return p.out.Write(b) }
func (p *pipe) String() string              { return p.out.String() }

func TestHelloRegistersLinkForCommands(t *testing.T) {
	h := &Handler{Batch: ingest.New(nil, 0)}
	p := &pipe{in: strings.NewReader(`{"t":"hello","id":103,"fw":"esp-0.1","ch":6}` + "\n")}
	h.ReadLines(context.Background(), p, false)

	h.Send(103, Command{T: "walk", On: 1})
	if got := p.String(); got != "" {
		t.Fatalf("link should be dropped once the reader ends, got %q", got)
	}

	h.links.set(103, p)
	h.Send(103, Command{T: "walk", On: 1})
	h.Send(104, Command{T: "walk", On: 1})
	if got := p.String(); got != `{"t":"walk","on":1}`+"\n" {
		t.Fatalf("got %q", got)
	}
}
