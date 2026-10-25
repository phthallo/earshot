package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeCrowd struct {
	on    bool
	calls []bool
}

func (f *fakeCrowd) Enabled() bool { return f.on }
func (f *fakeCrowd) SetEnabled(_ context.Context, on bool) error {
	f.on = on
	f.calls = append(f.calls, on)
	return nil
}

func post(t *testing.T, s *Server, body string, signedIn bool) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	s.Register(mux)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/mock", strings.NewReader(body))
	if signedIn {
		req.AddCookie(&http.Cookie{Name: cookieName, Value: s.sign([]string{"local", "local", ""}, time.Now().Add(time.Hour))})
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	return w
}

func TestSetMock(t *testing.T) {
	crowd := &fakeCrowd{on: true}
	s := &Server{Secret: []byte("test"), Mock: crowd}

	if w := post(t, s, `{"enabled":false}`, false); w.Code != 401 {
		t.Fatalf("anonymous: %d", w.Code)
	}
	if len(crowd.calls) != 0 {
		t.Fatal("anonymous call reached the crowd")
	}

	w := post(t, s, `{"enabled":false}`, true)
	if w.Code != 200 {
		t.Fatalf("off: %d %s", w.Code, w.Body)
	}
	var out map[string]bool
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || out["enabled"] {
		t.Fatalf("off body: %s", w.Body)
	}
	if len(crowd.calls) != 1 || crowd.calls[0] {
		t.Fatalf("crowd calls: %v", crowd.calls)
	}

	if w := post(t, s, `{"enabled":true}`, true); w.Code != 200 || !crowd.on {
		t.Fatalf("on: %d, crowd on %v", w.Code, crowd.on)
	}

	if w := post(t, &Server{Secret: []byte("test")}, `{"enabled":false}`, true); w.Code != 404 {
		t.Fatalf("no crowd: %d", w.Code)
	}
}
