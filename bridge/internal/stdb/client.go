// Package stdb is a small SpacetimeDB HTTP client: mint an identity, call
// reducers, run SQL.
package stdb

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type Client struct {
	URI   string
	DB    string
	Token string
	HTTP  *http.Client
}

func New(uri, db, token string) *Client {
	return &Client{URI: strings.TrimRight(uri, "/"), DB: db, Token: token, HTTP: &http.Client{Timeout: 15 * time.Second}}
}

// Mint creates a fresh identity and returns its token.
func Mint(ctx context.Context, uri string) (identity, token string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(uri, "/")+"/v1/identity", nil)
	if err != nil {
		return "", "", err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	var out struct {
		Identity string `json:"identity"`
		Token    string `json:"token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", "", err
	}
	return out.Identity, out.Token, nil
}

// LoadOrMintToken reads a cached token from path or mints one and caches it.
func LoadOrMintToken(ctx context.Context, uri, path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil && len(bytes.TrimSpace(b)) > 0 {
		return string(bytes.TrimSpace(b)), nil
	}
	_, tok, err := Mint(ctx, uri)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(tok), 0o600); err != nil {
		return "", err
	}
	return tok, nil
}

func (c *Client) do(ctx context.Context, method, path string, body []byte, contentType string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.URI+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	if res.StatusCode/100 != 2 {
		return nil, fmt.Errorf("%s %s: %d %s", method, path, res.StatusCode, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// Call invokes a reducer. Args are positional and serialised as a JSON array.
// Struct fields must carry snake_case json tags to match the module.
func (c *Client) Call(ctx context.Context, reducer string, args ...any) error {
	if args == nil {
		args = []any{}
	}
	body, err := json.Marshal(args)
	if err != nil {
		return err
	}
	_, err = c.do(ctx, http.MethodPost, "/v1/database/"+c.DB+"/call/"+reducer, body, "application/json")
	return err
}

// VerifyIdentity asks the server whether token was issued for identity (hex,
// no 0x). 204 means yes; 400 or 401 means no.
func (c *Client) VerifyIdentity(ctx context.Context, identity, token string) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URI+"/v1/identity/"+identity+"/verify", nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return false, err
	}
	res.Body.Close()
	switch res.StatusCode {
	case http.StatusNoContent:
		return true, nil
	case http.StatusBadRequest, http.StatusUnauthorized:
		return false, nil
	}
	return false, fmt.Errorf("verify: %d", res.StatusCode)
}

// Row is one SQL result row as column name to value.
type Row map[string]any

// Sql runs one SELECT and returns rows keyed by column name.
func (c *Client) Sql(ctx context.Context, query string) ([]Row, error) {
	out, err := c.do(ctx, http.MethodPost, "/v1/database/"+c.DB+"/sql", []byte(query), "text/plain")
	if err != nil {
		return nil, err
	}
	var stmts []struct {
		Schema struct {
			Elements []struct {
				Name struct {
					Some string `json:"some"`
				} `json:"name"`
			} `json:"elements"`
		} `json:"schema"`
		Rows [][]any `json:"rows"`
	}
	if err := json.Unmarshal(out, &stmts); err != nil {
		return nil, fmt.Errorf("sql decode: %w", err)
	}
	var rows []Row
	for _, st := range stmts {
		for _, r := range st.Rows {
			row := Row{}
			for i, el := range st.Schema.Elements {
				if i < len(r) {
					row[el.Name.Some] = r[i]
				}
			}
			rows = append(rows, row)
		}
	}
	return rows, nil
}

// Num reads a numeric column as float64 (SpacetimeDB sends numbers as JSON numbers).
func (r Row) Num(col string) float64 {
	if v, ok := r[col].(float64); ok {
		return v
	}
	return 0
}

func (r Row) Str(col string) string {
	if v, ok := r[col].(string); ok {
		return v
	}
	return fmt.Sprint(r[col])
}
