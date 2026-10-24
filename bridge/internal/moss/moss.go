// Package moss is a small HTTP client for Moss cloud semantic search. The
// official Go SDK needs CGO and libmoss; this talks to the same two
// endpoints the SDK uses (manage and query) with plain net/http.
package moss

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	manageURL = "https://service.usemoss.dev/v1/manage"
	queryURL  = "https://service.usemoss.dev/query"
	model     = "moss-minilm"
)

type Doc struct {
	ID       string            `json:"id"`
	Text     string            `json:"text"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

type Hit struct {
	ID       string            `json:"id"`
	Text     string            `json:"text"`
	Score    float64           `json:"score"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

type Result struct {
	Docs        []Hit   `json:"docs"`
	TimeTakenMs float64 `json:"timeTakenMs"`
}

type Client struct {
	projectID string
	key       string
	Index     string
	http      *http.Client
}

func New(projectID, key, index string) *Client {
	return &Client{projectID: projectID, key: key, Index: index, http: &http.Client{Timeout: 120 * time.Second}}
}

// LoadDocs reads data/guide.json. Every field other than id and text
// becomes string metadata so queries can filter by type or zone.
func LoadDocs(path string) ([]Doc, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var raw []map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	docs := make([]Doc, 0, len(raw))
	for _, r := range raw {
		d := Doc{Metadata: map[string]string{}}
		for k, v := range r {
			s, ok := v.(string)
			if !ok {
				continue
			}
			switch k {
			case "id":
				d.ID = s
			case "text":
				d.Text = s
			default:
				d.Metadata[k] = s
			}
		}
		if d.ID == "" || d.Text == "" {
			return nil, fmt.Errorf("guide doc without id or text: %v", r)
		}
		docs = append(docs, d)
	}
	return docs, nil
}

func (c *Client) manage(ctx context.Context, action string, body map[string]any) (map[string]any, error) {
	payload := map[string]any{"projectId": c.projectID}
	for k, v := range body {
		payload[k] = v
	}
	payload["action"] = action
	b, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, manageURL, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-project-key", c.key)
	req.Header.Set("x-service-version", "v1")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	out := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, fmt.Errorf("moss %s: %d %s", action, resp.StatusCode, strings.TrimSpace(string(raw[:min(len(raw), 200)])))
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg, _ := out["error"].(string)
		if msg == "" {
			msg, _ = out["message"].(string)
		}
		return nil, &httpError{action: action, status: resp.StatusCode, msg: msg}
	}
	return out, nil
}

type httpError struct {
	action string
	status int
	msg    string
}

func (e *httpError) Error() string { return fmt.Sprintf("moss %s: %d %s", e.action, e.status, e.msg) }

// Sync makes sure the index exists and holds every doc. An existing index
// gets an upsert so edits to guide.json land on the next bridge start.
func (c *Client) Sync(ctx context.Context, docs []Doc) error {
	if len(docs) == 0 {
		return errors.New("no docs")
	}
	_, err := c.manage(ctx, "getIndex", map[string]any{"indexName": c.Index})
	var he *httpError
	if errors.As(err, &he) && he.status == http.StatusNotFound {
		return c.create(ctx, docs)
	}
	if err != nil {
		return err
	}
	res, err := c.manage(ctx, "addDocs", map[string]any{"indexName": c.Index, "docs": docs, "options": map[string]any{"upsert": true}})
	if err != nil {
		return err
	}
	return c.wait(ctx, res)
}

// create follows the bulk path: initUpload, PUT the payload, startBuild.
// Dimension 0 makes the server compute embeddings.
func (c *Client) create(ctx context.Context, docs []Doc) error {
	init, err := c.manage(ctx, "initUpload", map[string]any{"indexName": c.Index, "modelId": model, "docCount": len(docs), "dimension": 0})
	if err != nil {
		return err
	}
	jobID, _ := init["jobId"].(string)
	uploadURL, _ := init["uploadUrl"].(string)
	if jobID == "" || uploadURL == "" {
		return errors.New("moss initUpload: no jobId or uploadUrl")
	}
	meta, _ := json.Marshal(docs)
	var buf bytes.Buffer
	buf.WriteString("MOSS")
	for _, v := range []uint32{1, uint32(len(docs)), 0, uint32(len(meta))} {
		_ = binary.Write(&buf, binary.LittleEndian, v)
	}
	buf.Write(meta)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, uploadURL, &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("moss upload: %d", resp.StatusCode)
	}
	res, err := c.manage(ctx, "startBuild", map[string]any{"jobId": jobID})
	if err != nil {
		return err
	}
	if _, ok := res["jobId"]; !ok {
		res["jobId"] = jobID
	}
	return c.wait(ctx, res)
}

func (c *Client) wait(ctx context.Context, res map[string]any) error {
	jobID, _ := res["jobId"].(string)
	if jobID == "" {
		return nil
	}
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		st, err := c.manage(ctx, "getJobStatus", map[string]any{"jobId": jobID})
		if err != nil {
			return err
		}
		status := strings.ToLower(strings.ReplaceAll(fmt.Sprint(st["status"]), "_", ""))
		switch status {
		case "completed":
			return nil
		case "failed":
			return fmt.Errorf("moss job failed: %v", st["error"])
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return fmt.Errorf("moss job %s still running after 5 minutes", jobID)
}

// Query runs a cloud search. The key travels in the body: that is how the
// SDK's cloud fallback does it.
func (c *Client) Query(ctx context.Context, q string, topK int) (Result, error) {
	b, _ := json.Marshal(map[string]any{"query": q, "indexName": c.Index, "projectId": c.projectID, "projectKey": c.key, "topK": topK})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, queryURL, bytes.NewReader(b))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Result{}, fmt.Errorf("moss query: %d %s", resp.StatusCode, strings.TrimSpace(string(raw[:min(len(raw), 200)])))
	}
	var out Result
	if err := json.Unmarshal(raw, &out); err != nil {
		return Result{}, err
	}
	return out, nil
}

// SyncInBackground indexes the guide without holding up startup and logs
// the outcome. Queries before it finishes hit whatever the index held.
func (c *Client) SyncInBackground(ctx context.Context, docs []Doc) {
	go func() {
		start := time.Now()
		if err := c.Sync(ctx, docs); err != nil {
			log.Printf("moss: index %q not synced: %v", c.Index, err)
			return
		}
		log.Printf("moss: index %q holds %d guide docs (%s)", c.Index, len(docs), time.Since(start).Round(time.Millisecond))
	}()
}
