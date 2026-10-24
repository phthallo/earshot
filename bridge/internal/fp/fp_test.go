package fp

import (
	"path/filepath"
	"testing"
)

func scan(rssi ...int) []AP {
	ids := []string{"aa", "bb", "cc", "dd"}
	out := make([]AP, 0, len(rssi))
	for i, r := range rssi {
		out = append(out, AP{BSSID: ids[i], RSSI: r})
	}
	return out
}

func TestLocateIgnoresPhoneOffset(t *testing.T) {
	s, err := Load(filepath.Join(t.TempDir(), "fp.json"))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := s.Learn("stage", scan(-40, -70, -80)); err != nil {
			t.Fatal(err)
		}
		if err := s.Learn("food", scan(-80, -45, -60)); err != nil {
			t.Fatal(err)
		}
	}
	// Same place as "stage", every reading 10 dB weaker.
	m, err := s.Locate(scan(-50, -80, -90))
	if err != nil {
		t.Fatal(err)
	}
	if m.ZoneID != "stage" {
		t.Fatalf("got %s want stage (%v)", m.ZoneID, m)
	}
	if m.Confidence < 0.9 {
		t.Fatalf("confidence %v too low for an exact match", m.Confidence)
	}
	m, _ = s.Locate(scan(-85, -50, -62))
	if m.ZoneID != "food" {
		t.Fatalf("got %s want food", m.ZoneID)
	}
}

func TestLocateNeedsData(t *testing.T) {
	s, _ := Load(filepath.Join(t.TempDir(), "fp.json"))
	if _, err := s.Locate(scan(-40, -50)); err == nil {
		t.Fatal("expected error with no samples")
	}
	if err := s.Learn("x", scan(-40)); err == nil {
		t.Fatal("expected error for a one-AP scan")
	}
}

func TestPersists(t *testing.T) {
	p := filepath.Join(t.TempDir(), "fp.json")
	s, _ := Load(p)
	_ = s.Learn("stage", scan(-40, -70))
	s2, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if s2.Counts()["stage"] != 1 {
		t.Fatalf("counts %v", s2.Counts())
	}
	if _, err := s2.Locate(scan(-40, -70)); err != nil {
		t.Fatal(err)
	}
}
