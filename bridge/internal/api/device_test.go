package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"venuemap/bridge/internal/anon"
	"venuemap/bridge/internal/node"
	"venuemap/bridge/internal/venue"
)

func TestDeviceAddressOnlyForLoopback(t *testing.T) {
	v := &venue.Venue{}
	v.Nodes.MetersPerUnit = 0.072
	v.Nodes.Nodes = []venue.Node{{NodeID: 103, Floor: 1, X: 1000, Y: 500}}
	dots := &anon.Tracker{Venue: v}
	dots.Observe(103, []node.Sight{{MacHash: "abcd", RSSI: -50, MAC: "de:ad:be:ef:00:01"}})
	s := &Server{Dots: dots}

	get := func(remote string) (mac string, withheld bool) {
		r := httptest.NewRequest("GET", "/api/device?hash=abcd", nil)
		r.RemoteAddr = remote
		w := httptest.NewRecorder()
		s.device(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status %d", remote, w.Code)
		}
		var body struct {
			Device          struct{ MAC string }
			AddressWithheld bool
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Device.MAC, body.AddressWithheld
	}

	if mac, withheld := get("127.0.0.1:4000"); mac == "" || withheld {
		t.Errorf("loopback: mac %q withheld %v", mac, withheld)
	}
	if mac, withheld := get("[::1]:4000"); mac == "" || withheld {
		t.Errorf("ipv6 loopback: mac %q withheld %v", mac, withheld)
	}
	if mac, withheld := get("10.0.0.7:4000"); mac != "" || !withheld {
		t.Errorf("lan: mac %q withheld %v", mac, withheld)
	}
}
