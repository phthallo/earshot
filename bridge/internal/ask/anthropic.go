package ask

import (
	"context"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	"github.com/anthropics/anthropic-sdk-go/shared/constant"
)

type anthropicBackend struct {
	client anthropic.Client
	model  string
}

func newAnthropic(apiKey, model string) *anthropicBackend {
	return &anthropicBackend{client: anthropic.NewClient(option.WithAPIKey(apiKey)), model: model}
}

func (b *anthropicBackend) complete(ctx context.Context, sys, user string, prior []exchange, tools []toolSpec) (reply, error) {
	messages := []anthropic.BetaMessageParam{
		anthropic.NewBetaUserMessage(anthropic.NewBetaTextBlock(user)),
	}
	for _, ex := range prior {
		messages = append(messages, ex.reply.raw.(anthropic.BetaMessageParam))
		blocks := make([]anthropic.BetaContentBlockParamUnion, 0, len(ex.results))
		for _, r := range ex.results {
			blocks = append(blocks, anthropic.NewBetaToolResultBlock(r.ID, r.Output, r.IsErr))
		}
		messages = append(messages, anthropic.NewBetaUserMessage(blocks...))
	}
	params := make([]anthropic.BetaToolUnionParam, 0, len(tools))
	for _, t := range tools {
		params = append(params, anthropic.BetaToolUnionParam{OfTool: &anthropic.BetaToolParam{
			Name:        t.Name,
			Description: anthropic.String(t.Desc),
			InputSchema: anthropic.BetaToolInputSchemaParam{
				Properties:  t.Props,
				Required:    t.Required,
				ExtraFields: map[string]any{"additionalProperties": false},
			},
		}})
	}
	resp, err := b.client.Beta.Messages.New(ctx, anthropic.BetaMessageNewParams{
		Model:        anthropic.Model(b.model),
		MaxTokens:    2048,
		System:       []anthropic.BetaTextBlockParam{{Text: sys}},
		Messages:     messages,
		Tools:        params,
		OutputConfig: anthropic.BetaOutputConfigParam{Effort: anthropic.BetaOutputConfigEffortLow},
		Betas:        []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01},
		Fallbacks:    anthropic.BetaFallbacksParamUnion{OfDefault: constant.ValueOf[constant.Default]()},
	})
	if err != nil {
		return reply{}, err
	}
	out := reply{raw: resp.ToParam()}
	var text strings.Builder
	for _, block := range resp.Content {
		switch v := block.AsAny().(type) {
		case anthropic.BetaTextBlock:
			text.WriteString(v.Text)
		case anthropic.BetaToolUseBlock:
			out.Calls = append(out.Calls, toolCall{ID: v.ID, Name: v.Name, Input: v.JSON.Input.Raw()})
		}
	}
	out.Text = text.String()
	switch resp.StopReason {
	case anthropic.BetaStopReasonToolUse:
		out.Stop = stopTool
	case anthropic.BetaStopReasonMaxTokens:
		out.Stop = stopMax
	case anthropic.BetaStopReasonRefusal:
		out.Stop = stopRefusal
	}
	return out, nil
}
