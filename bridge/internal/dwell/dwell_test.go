package dwell

import (
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 24, 10, 0, 0, 0, time.UTC)

func TestStayIsCountedWhenThePhoneChangesZone(t *testing.T) {
	tr := &Tracker{}
	tr.Note("aa", "food", t0)
	tr.Note("aa", "food", t0.Add(5*time.Minute))
	tr.Note("aa", "stage", t0.Add(6*time.Minute))
	z := tr.Zone("food", t0.Add(6*time.Minute))
	if z.Stays != 1 || z.MedianStayMin != 6 {
		t.Fatalf("food stays %d median %v, want 1 and 6", z.Stays, z.MedianStayMin)
	}
	if d := tr.Device("aa"); len(d.Stays) != 1 || d.Stays[0].Zone != "food" || !d.Stays[0].To.Equal(t0.Add(6*time.Minute)) {
		t.Fatalf("device stays %+v, want one food stay ending at +6m", d.Stays)
	}
	if tr.Zone("stage", t0.Add(6*time.Minute)).Now != 1 {
		t.Fatal("phone should be in stage now")
	}
	// Moving on does not remove it from food's visitors for the day.
	if z.Unique != 1 {
		t.Fatalf("food unique %d, want 1", z.Unique)
	}
}

func TestShortPassThroughIsNotAStay(t *testing.T) {
	tr := &Tracker{}
	tr.Note("aa", "hall", t0)
	tr.Note("aa", "food", t0.Add(30*time.Second))
	if z := tr.Zone("hall", t0.Add(time.Minute)); z.Stays != 0 || z.Unique != 0 {
		t.Fatalf("hall stays %d unique %d, want 0 and 0", z.Stays, z.Unique)
	}
}

func TestLeavingClosesTheStayAndComingBackIsAReturn(t *testing.T) {
	tr := &Tracker{}
	tr.Note("aa", "food", t0)
	tr.Note("aa", "food", t0.Add(10*time.Minute))
	later := t0.Add(40 * time.Minute)
	r := tr.Report(later)
	if r.Unique != 1 || r.Now != 0 || r.Returning != 0 {
		t.Fatalf("unique %d now %d returning %d after leaving", r.Unique, r.Now, r.Returning)
	}
	if z := tr.Zone("food", later); z.Stays != 1 || z.MedianStayMin != 10 {
		t.Fatalf("food stays %d median %v, want 1 and 10", z.Stays, z.MedianStayMin)
	}
	tr.Note("aa", "food", later)
	r = tr.Report(later)
	if r.Returning != 1 || r.Now != 1 {
		t.Fatalf("returning %d now %d, want 1 and 1", r.Returning, r.Now)
	}
	// Sweep already counted the first stay; the return must not count it twice.
	tr.Note("aa", "stage", later.Add(3*time.Minute))
	if z := tr.Zone("food", later.Add(3*time.Minute)); z.Stays != 2 {
		t.Fatalf("food stays %d, want 2", z.Stays)
	}
}

func TestDayOldHashesAreForgotten(t *testing.T) {
	tr := &Tracker{}
	tr.Note("aa", "food", t0)
	if r := tr.Report(t0.Add(25 * time.Hour)); r.Unique != 0 || len(r.Zones) != 0 {
		t.Fatalf("unique %d zones %d after a day, want 0 and 0", r.Unique, len(r.Zones))
	}
}

func TestMedianOfEvenCount(t *testing.T) {
	if m := median([]time.Duration{4 * time.Minute, time.Minute, 3 * time.Minute, 2 * time.Minute}); m != 150*time.Second {
		t.Fatalf("median %v, want 2m30s", m)
	}
}
