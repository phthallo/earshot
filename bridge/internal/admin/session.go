// Package admin is the venue admin surface: GitHub sign-in, venues, floor
// uploads, node placement and remembered boards. The bridge holds the
// session and is the only SpacetimeDB identity that writes these rows.
package admin

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const cookieName = "earshot_session"
const sessionTTL = 30 * 24 * time.Hour

type Session struct {
	Login     string `json:"login"`
	Provider  string `json:"provider"`
	AvatarURL string `json:"avatarUrl"`
}

// SecretOrRandom returns the configured secret, or a random one that only
// lasts for this process: cookies then die with the bridge.
func SecretOrRandom(configured string) []byte {
	if configured != "" {
		return []byte(configured)
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("session secret: %v", err)
	}
	log.Printf("warning: SESSION_SECRET unset, admin sessions will not survive a restart")
	return b
}

// sign joins fields and the expiry with | and appends an HMAC of the result.
// Fields must not contain |.
func (s *Server) sign(fields []string, expiry time.Time) string {
	payload := strings.Join(append(append([]string{}, fields...), strconv.FormatInt(expiry.Unix(), 10)), "|")
	enc := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return enc + "." + s.mac(enc)
}

func (s *Server) mac(enc string) string {
	m := hmac.New(sha256.New, s.Secret)
	m.Write([]byte(enc))
	return hex.EncodeToString(m.Sum(nil))
}

// verify returns the signed fields when the MAC holds and the expiry is ahead.
func (s *Server) verify(value string, now time.Time) ([]string, bool) {
	enc, sig, ok := strings.Cut(value, ".")
	if !ok || !hmac.Equal([]byte(sig), []byte(s.mac(enc))) {
		return nil, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil {
		return nil, false
	}
	parts := strings.Split(string(raw), "|")
	if len(parts) < 2 {
		return nil, false
	}
	exp, err := strconv.ParseInt(parts[len(parts)-1], 10, 64)
	if err != nil || now.Unix() > exp {
		return nil, false
	}
	return parts[:len(parts)-1], true
}

func (s *Server) setSession(w http.ResponseWriter, r *http.Request, sess Session) {
	exp := time.Now().Add(sessionTTL)
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    s.sign([]string{sess.Login, sess.Provider, sess.AvatarURL}, exp),
		Path:     "/",
		Expires:  exp,
		MaxAge:   int(sessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   isHTTPS(r, s.PublicURL),
		SameSite: http.SameSiteLaxMode,
	})
}

func clearSession(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func (s *Server) session(r *http.Request) (Session, bool) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return Session{}, false
	}
	f, ok := s.verify(c.Value, time.Now())
	if !ok || len(f) != 3 {
		return Session{}, false
	}
	return Session{Login: f[0], Provider: f[1], AvatarURL: f[2]}, true
}

// withSession runs h for signed-in callers and answers 401 otherwise.
func (s *Server) withSession(h func(http.ResponseWriter, *http.Request, Session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := s.session(r)
		if !ok {
			writeJSON(w, 401, map[string]string{"error": "Sign in first."})
			return
		}
		h(w, r, sess)
	}
}

func isHTTPS(r *http.Request, publicURL string) bool {
	if publicURL != "" {
		return strings.HasPrefix(publicURL, "https://")
	}
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}
