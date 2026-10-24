package survey

import (
	"strings"
	"testing"

	"venuemap/bridge/internal/fp"
	"venuemap/bridge/internal/sniff"
)

func TestParseLinesSplitsSightsAndAccessPoints(t *testing.T) {
	in := strings.Join([]string{
		"ets Jul 29 2019 12:21:46", // boot noise
		`{"t":"hello","id":103,"fw":"esp-0.1","ch":6}`,
		`{"t":"sight","id":103,"ts":1,"items":[["aa",-40],["bb","-80"],["",-30]]}`,
		`{"t":"motion","id":103,"ts":1,"score":0.2,"state":"motion","anon":2}`,
		`{"t":"aps","id":103,"ts":1,"items":[["00:11:22:33:44:55",-50],["66:77:88:99:aa:bb",-70]]}`,
	}, "\n") + "\n"
	caps := make(chan sniff.Capture, 16)
	aps := make(chan []fp.AP, 4)
	parseLines(strings.NewReader(in), caps, aps)
	close(caps)
	close(aps)

	var got []sniff.Capture
	for c := range caps {
		got = append(got, c)
	}
	want := []sniff.Capture{{MAC: "aa", RSSI: -40}, {MAC: "bb", RSSI: -80}}
	if len(got) != len(want) {
		t.Fatalf("captures: got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("capture %d: got %v, want %v", i, got[i], want[i])
		}
	}

	scan := <-aps
	if len(scan) != 2 || scan[0].BSSID != "00:11:22:33:44:55" || scan[1].RSSI != -70 {
		t.Errorf("aps: got %v", scan)
	}
}
