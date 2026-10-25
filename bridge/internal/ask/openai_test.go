package ask

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The fake proxy asks for an unknown tool on the first call, so the loop
// runs a tool without needing a database, then answers on the second.
func TestOpenAILoop(t *testing.T) {
	var requests []oaRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer k" {
			t.Errorf("auth header %q", got)
		}
		var req oaRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, req)
		w.Header().Set("Content-Type", "application/json")
		if len(requests) == 1 {
			w.Write([]byte(`{"choices":[{"finish_reason":"tool_calls","message":{"content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"bogus","arguments":"{\"query\":\"x\"}"}}]}}]}`))
			return
		}
		w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":[{"type":"text","text":"The stage is quiet."}]}}]}`))
	}))
	defer srv.Close()

	a := NewOpenAI(nil, srv.URL+"/v1", "k", "anthropic/claude-sonnet-5.5")
	got, err := a.loop(context.Background(), "sys", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if got != "The stage is quiet." {
		t.Errorf("answer %q", got)
	}
	if len(requests) != 2 {
		t.Fatalf("%d requests", len(requests))
	}
	first := requests[0]
	if first.Model != "anthropic/claude-sonnet-5.5" || first.ReasoningEffort != "low" || len(first.Tools) != 1 {
		t.Errorf("first request: model %q effort %q tools %d", first.Model, first.ReasoningEffort, len(first.Tools))
	}
	if first.Messages[0].Role != "system" || first.Messages[0].Content != "sys" || first.Messages[1].Role != "user" {
		t.Errorf("first messages: %+v", first.Messages)
	}
	second := requests[1].Messages
	if len(second) != 4 {
		t.Fatalf("second request has %d messages, want 4", len(second))
	}
	if second[2].Role != "assistant" || len(second[2].ToolCalls) != 1 || second[2].ToolCalls[0].ID != "call_1" {
		t.Errorf("assistant replay: %+v", second[2])
	}
	if second[3].Role != "tool" || second[3].ToolCallID != "call_1" || second[3].Content != "error: unknown tool bogus" {
		t.Errorf("tool result: %+v", second[3])
	}
}

func TestOpenAIErrorBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":{"message":"bad key"}}`))
	}))
	defer srv.Close()
	b := newOpenAI(srv.URL, "k", "m")
	_, err := b.complete(context.Background(), "s", "u", nil, nil)
	if err == nil || err.Error() != "chat completions 401: bad key" {
		t.Errorf("err = %v", err)
	}
}

func TestContentText(t *testing.T) {
	cases := map[string]string{
		`"plain"`: "plain",
		`null`:    "",
		`[{"type":"text","text":"a"},{"type":"text","text":"b"}]`: "ab",
		`[{"type":"image_url","text":"nope"}]`:                    "",
	}
	for in, want := range cases {
		if got := contentText(json.RawMessage(in)); got != want {
			t.Errorf("%s: got %q want %q", in, got, want)
		}
	}
}
