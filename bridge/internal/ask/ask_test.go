package ask

import "testing"

func TestGuardSQL(t *testing.T) {
	ok := []string{
		"SELECT * FROM zone",
		"select name from zone where kind = 'food'",
		"SELECT p.display_name FROM person p JOIN position q ON p.person_id = q.person_id LIMIT 5",
	}
	for _, q := range ok {
		if _, err := GuardSQL(q); err != nil {
			t.Errorf("%q rejected: %v", q, err)
		}
	}
	bad := []string{
		"DELETE FROM zone",
		"SELECT * FROM sighting",
		"SELECT * FROM device_binding",
		"SELECT * FROM zone; DROP TABLE zone",
		"UPDATE person SET team = 'x'",
		"SELECT 1",
	}
	for _, q := range bad {
		if _, err := GuardSQL(q); err == nil {
			t.Errorf("%q accepted", q)
		}
	}
	got, _ := GuardSQL("SELECT * FROM zone")
	if got != "SELECT * FROM zone LIMIT 200" {
		t.Errorf("limit not added: %q", got)
	}
	got, _ = GuardSQL("SELECT * FROM zone LIMIT 3")
	if got != "SELECT * FROM zone LIMIT 3" {
		t.Errorf("limit doubled: %q", got)
	}
}
