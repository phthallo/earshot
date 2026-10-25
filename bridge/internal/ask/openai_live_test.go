package ask

import (
	"context"
	"os"
	"testing"
	"time"

	"venuemap/bridge/internal/config"
)

// TestOpenAILive calls the real proxy named in .env or the environment.
// It is skipped when OPENAI_BASE_URL and OPENAI_API_KEY are not set.
func TestOpenAILive(t *testing.T) {
	config.LoadDotenv("../../../.env")
	base, key := os.Getenv("OPENAI_BASE_URL"), os.Getenv("OPENAI_API_KEY")
	if base == "" || key == "" {
		t.Skip("OPENAI_BASE_URL and OPENAI_API_KEY not set")
	}
	a := NewOpenAI(nil, base, key, config.Get("OPENAI_MODEL", "anthropic/claude-sonnet-5.5"))
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	got, err := a.loop(ctx, "Reply with exactly the word pong.", "ping")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("model said: %q", got)
	if got == "" {
		t.Error("empty answer")
	}
}
