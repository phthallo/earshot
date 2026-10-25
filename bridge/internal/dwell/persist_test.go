package dwell

import (
	"path/filepath"
	"testing"
	"time"
)

func TestSaveAndLoadKeepAPhonesTravels(t *testing.T) {
	tr := &Tracker{}
	tr.Note("aa", "food", t0)
	tr.Note("aa", "food", t0.Add(5*time.Minute))
	tr.Note("aa", "stage", t0.Add(6*time.Minute))
	tr.Note("bb", "stage", t0.Add(6*time.Minute))
	path := filepath.Join(t.TempDir(), "dwell.json")
	if err := tr.Save(path); err != nil {
		t.Fatal(err)
	}

	back := &Tracker{}
	if err := back.Load(path); err != nil {
		t.Fatal(err)
	}
	d := back.Device("aa")
	if d == nil || len(d.Stays) != 1 || d.Stays[0].Zone != "food" || d.Zone != "stage" {
		t.Fatalf("device after load: %+v", d)
	}
	now := t0.Add(7 * time.Minute)
	if got, want := back.Report(now), tr.Report(now); got.Unique != want.Unique || got.Now != want.Now || len(got.Zones) != len(want.Zones) {
		t.Fatalf("report after load %+v, before %+v", got, want)
	}
	// The restored tracker keeps counting from where it left off.
	back.Note("aa", "stage", t0.Add(9*time.Minute))
	back.Note("aa", "food", t0.Add(10*time.Minute))
	if d := back.Device("aa"); len(d.Stays) != 2 {
		t.Fatalf("stays after more notes: %+v", d.Stays)
	}
}

func TestLoadOfAMissingFileIsFine(t *testing.T) {
	tr := &Tracker{}
	if err := tr.Load(filepath.Join(t.TempDir(), "none.json")); err != nil {
		t.Fatal(err)
	}
	tr.Note("aa", "food", t0)
}
