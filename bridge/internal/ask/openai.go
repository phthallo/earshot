package ask

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// openaiBackend speaks the OpenAI chat completions API with function
// tools. It is written against plain net/http because the only use is a
// proxy in front of Claude, and the proxy has no Messages API.
type openaiBackend struct {
	url   string
	key   string
	model string
	http  *http.Client
}

func newOpenAI(baseURL, apiKey, model string) *openaiBackend {
	return &openaiBackend{
		url:   strings.TrimRight(baseURL, "/") + "/chat/completions",
		key:   apiKey,
		model: model,
		http:  &http.Client{Timeout: 90 * time.Second},
	}
}

type oaFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type oaToolCall struct {
	ID       string     `json:"id"`
	Type     string     `json:"type"`
	Function oaFunction `json:"function"`
}

type oaMessage struct {
	Role       string       `json:"role"`
	Content    any          `json:"content,omitempty"`
	ToolCalls  []oaToolCall `json:"tool_calls,omitempty"`
	ToolCallID string       `json:"tool_call_id,omitempty"`
}

type oaRequest struct {
	Model           string      `json:"model"`
	Messages        []oaMessage `json:"messages"`
	Tools           []any       `json:"tools,omitempty"`
	MaxTokens       int         `json:"max_tokens"`
	ReasoningEffort string      `json:"reasoning_effort,omitempty"`
}

type oaResponse struct {
	Choices []struct {
		FinishReason string `json:"finish_reason"`
		Message      struct {
			Content   json.RawMessage `json:"content"`
			ToolCalls []oaToolCall    `json:"tool_calls"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// contentText accepts the string form and the array-of-parts form.
func contentText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var b strings.Builder
	for _, p := range parts {
		if p.Type == "text" || p.Type == "" {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

func (b *openaiBackend) complete(ctx context.Context, sys, user string, prior []exchange, tools []toolSpec) (reply, error) {
	messages := []oaMessage{{Role: "system", Content: sys}, {Role: "user", Content: user}}
	for _, ex := range prior {
		messages = append(messages, ex.reply.raw.(oaMessage))
		for _, r := range ex.results {
			content := r.Output
			if r.IsErr {
				content = "error: " + content
			}
			messages = append(messages, oaMessage{Role: "tool", ToolCallID: r.ID, Content: content})
		}
	}
	fns := make([]any, 0, len(tools))
	for _, t := range tools {
		props := t.Props
		if props == nil {
			props = map[string]any{}
		}
		fns = append(fns, map[string]any{"type": "function", "function": map[string]any{
			"name":        t.Name,
			"description": t.Desc,
			"parameters": map[string]any{
				"type":                 "object",
				"properties":           props,
				"required":             t.Required,
				"additionalProperties": false,
			},
		}})
	}
	body, err := json.Marshal(oaRequest{Model: b.model, Messages: messages, Tools: fns, MaxTokens: 2048, ReasoningEffort: "low"})
	if err != nil {
		return reply{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.url, bytes.NewReader(body))
	if err != nil {
		return reply{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+b.key)
	resp, err := b.http.Do(req)
	if err != nil {
		return reply{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return reply{}, err
	}
	var parsed oaResponse
	if jsonErr := json.Unmarshal(raw, &parsed); jsonErr != nil || resp.StatusCode/100 != 2 {
		msg := strings.TrimSpace(string(raw))
		if parsed.Error != nil && parsed.Error.Message != "" {
			msg = parsed.Error.Message
		}
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return reply{}, fmt.Errorf("chat completions %d: %s", resp.StatusCode, msg)
	}
	if len(parsed.Choices) == 0 {
		return reply{}, fmt.Errorf("chat completions: no choices")
	}
	choice := parsed.Choices[0]
	out := reply{Text: contentText(choice.Message.Content)}
	assistant := oaMessage{Role: "assistant", ToolCalls: choice.Message.ToolCalls}
	if out.Text != "" {
		assistant.Content = out.Text
	}
	out.raw = assistant
	for _, c := range choice.Message.ToolCalls {
		args := c.Function.Arguments
		if strings.TrimSpace(args) == "" {
			args = "{}"
		}
		out.Calls = append(out.Calls, toolCall{ID: c.ID, Name: c.Function.Name, Input: args})
	}
	switch {
	case len(out.Calls) > 0:
		out.Stop = stopTool
	case choice.FinishReason == "length":
		out.Stop = stopMax
	case choice.FinishReason == "content_filter":
		out.Stop = stopRefusal
	}
	return out, nil
}
