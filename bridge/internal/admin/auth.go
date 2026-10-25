package admin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const stateCookie = "earshot_oauth"

// GET /api/auth/github?return=<url>
// Without a GitHub app configured the caller is signed in as "local" so the
// flow works on a laptop.
func (s *Server) authGithub(w http.ResponseWriter, r *http.Request) {
	ret := s.safeReturn(r.URL.Query().Get("return"))
	if s.GithubClientID == "" {
		s.setSession(w, r, Session{Login: "local", Provider: "local"})
		http.Redirect(w, r, ret, http.StatusFound)
		return
	}
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	state := hex.EncodeToString(nonce)
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookie,
		Value:    s.sign([]string{state, ret}, time.Now().Add(10*time.Minute)),
		Path:     "/api/auth/github/callback",
		MaxAge:   600,
		HttpOnly: true,
		Secure:   isHTTPS(r, s.PublicURL),
		SameSite: http.SameSiteLaxMode,
	})
	q := url.Values{
		"client_id":    {s.GithubClientID},
		"redirect_uri": {s.redirectURI(r)},
		"scope":        {"read:user"},
		"state":        {state},
	}
	http.Redirect(w, r, "https://github.com/login/oauth/authorize?"+q.Encode(), http.StatusFound)
}

// GET /api/auth/github/callback?code=&state=
func (s *Server) authCallback(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(stateCookie)
	if err != nil {
		http.Error(w, "sign-in expired, start again", http.StatusBadRequest)
		return
	}
	saved, ok := s.verify(c.Value, time.Now())
	if !ok || len(saved) != 2 || saved[0] != r.URL.Query().Get("state") {
		http.Error(w, "sign-in state mismatch, start again", http.StatusBadRequest)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: stateCookie, Value: "", Path: "/api/auth/github/callback", MaxAge: -1})
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	sess, err := s.githubUser(ctx, r.URL.Query().Get("code"), s.redirectURI(r))
	if err != nil {
		log.Printf("github oauth: %v", err)
		http.Error(w, "GitHub did not sign you in. Try again.", http.StatusBadGateway)
		return
	}
	s.setSession(w, r, sess)
	http.Redirect(w, r, s.safeReturn(saved[1]), http.StatusFound)
}

func (s *Server) githubUser(ctx context.Context, code, redirectURI string) (Session, error) {
	form := url.Values{
		"client_id":     {s.GithubClientID},
		"client_secret": {s.GithubClientSecret},
		"code":          {code},
		"redirect_uri":  {redirectURI},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://github.com/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return Session{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := s.httpClient().Do(req)
	if err != nil {
		return Session{}, err
	}
	defer res.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&tok); err != nil {
		return Session{}, err
	}
	if tok.AccessToken == "" {
		return Session{}, fmt.Errorf("token exchange: %s", tok.Error)
	}
	req, err = http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
	if err != nil {
		return Session{}, err
	}
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err = s.httpClient().Do(req)
	if err != nil {
		return Session{}, err
	}
	defer res.Body.Close()
	var u struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := json.NewDecoder(res.Body).Decode(&u); err != nil {
		return Session{}, err
	}
	if u.Login == "" {
		return Session{}, fmt.Errorf("user lookup: %d", res.StatusCode)
	}
	return Session{Login: u.Login, Provider: "github", AvatarURL: u.AvatarURL}, nil
}

func (s *Server) httpClient() *http.Client {
	if s.HTTP != nil {
		return s.HTTP
	}
	return http.DefaultClient
}

// GET /api/auth/me
func (s *Server) authMe(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.session(r)
	if !ok {
		writeJSON(w, 401, map[string]string{"error": "Not signed in."})
		return
	}
	writeJSON(w, 200, sess)
}

// POST /api/auth/logout
func (s *Server) authLogout(w http.ResponseWriter, r *http.Request) {
	clearSession(w)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) redirectURI(r *http.Request) string {
	return s.origin(r) + "/api/auth/github/callback"
}

// origin is where the bridge is reachable from the browser: PUBLIC_URL, or
// the host the request came in on.
func (s *Server) origin(r *http.Request) string {
	if s.PublicURL != "" {
		return strings.TrimRight(s.PublicURL, "/")
	}
	scheme := "http"
	if isHTTPS(r, "") {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// safeReturn only sends the browser back to the configured client or to a
// localhost origin; anything else falls back to the client root.
func (s *Server) safeReturn(ret string) string {
	fallback := "/"
	if s.ClientURL != "" {
		fallback = s.ClientURL
	}
	u, err := url.Parse(ret)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fallback
	}
	if s.ClientURL != "" {
		if cu, err := url.Parse(s.ClientURL); err == nil && cu.Scheme == u.Scheme && cu.Host == u.Host {
			return ret
		}
	}
	host := u.Hostname()
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return ret
	}
	return fallback
}
