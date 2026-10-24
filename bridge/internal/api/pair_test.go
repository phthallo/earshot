package api

import "testing"

func TestPairCode(t *testing.T) {
	a := PairCode("salt", 1)
	if len(a) != 6 || !pairCodeRe.MatchString(a) {
		t.Fatalf("bad code %q", a)
	}
	if a != PairCode("salt", 1) {
		t.Fatal("not deterministic")
	}
	if a == PairCode("salt", 2) || a == PairCode("other", 1) {
		t.Fatal("collision across person or salt")
	}
}
