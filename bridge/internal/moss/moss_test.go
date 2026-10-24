package moss

import (
	"encoding/json"
	"os"
	"testing"
)

func TestGuideDocs(t *testing.T) {
	docs, err := LoadDocs("../../../data/guide.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) < 40 {
		t.Fatalf("only %d docs", len(docs))
	}
	b, err := os.ReadFile("../../../data/zones.json")
	if err != nil {
		t.Fatal(err)
	}
	var zones []struct {
		ZoneID string `json:"zoneId"`
	}
	if err := json.Unmarshal(b, &zones); err != nil {
		t.Fatal(err)
	}
	known := map[string]bool{}
	for _, z := range zones {
		known[z.ZoneID] = true
	}
	seen := map[string]bool{}
	zoneDocs := 0
	for _, d := range docs {
		if seen[d.ID] {
			t.Errorf("duplicate id %s", d.ID)
		}
		seen[d.ID] = true
		if z := d.Metadata["zone"]; z != "" {
			zoneDocs++
			if !known[z] {
				t.Errorf("%s names unknown zone %q", d.ID, z)
			}
		}
		if len(d.Text) > 1200 {
			t.Errorf("%s is %d chars; keep passages short for retrieval", d.ID, len(d.Text))
		}
	}
	if zoneDocs != len(zones) {
		t.Errorf("%d zone docs for %d zones", zoneDocs, len(zones))
	}
}
