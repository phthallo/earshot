// Package voice wraps Cartesia: text to speech over HTTP and a websocket
// proxy for streaming speech to text, so the browser never sees the API key.
package voice

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
)

const (
	apiVersion = "2026-08-14"
	ttsURL     = "https://api.cartesia.ai/tts/bytes"
	sttURL     = "wss://api.cartesia.ai/stt/websocket"
	// Public Cartesia voice used when CARTESIA_VOICE_ID is empty.
	defaultVoice = "694f9389-aac1-45b6-b726-9d9369183238"
)

type Client struct {
	key      string
	voiceID  string
	TTSModel string
	STTModel string
	http     *http.Client
}

func New(key, voiceID string) *Client {
	if voiceID == "" {
		voiceID = defaultVoice
	}
	return &Client{key: key, voiceID: voiceID, TTSModel: "sonic-3.6", STTModel: "ink-2", http: &http.Client{Timeout: 30 * time.Second}}
}

// TTS returns MP3 bytes for text.
func (c *Client) TTS(ctx context.Context, text string) ([]byte, string, error) {
	body, _ := json.Marshal(map[string]any{
		"model_id":      c.TTSModel,
		"transcript":    text,
		"voice":         map[string]string{"id": c.voiceID},
		"output_format": map[string]any{"container": "mp3", "sample_rate": 44100, "bit_rate": 128000},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ttsURL, bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("Cartesia-Version", apiVersion)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	audio, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("cartesia tts %d: %s", resp.StatusCode, bytes.TrimSpace(audio))
	}
	return audio, "audio/mpeg", nil
}

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

// STT upgrades the browser connection and relays frames both ways to
// Cartesia. The browser sends 16 kHz pcm_s16le binary chunks and the text
// messages "finalize" and "close"; Cartesia's JSON replies go straight back.
func (c *Client) STT(w http.ResponseWriter, r *http.Request) {
	q := url.Values{}
	q.Set("model", c.STTModel)
	q.Set("encoding", "pcm_s16le")
	q.Set("sample_rate", "16000")
	q.Set("cartesia_version", apiVersion)
	if c.STTModel == "ink-whisper" {
		q.Set("language", "en")
	}
	up, _, err := websocket.DefaultDialer.DialContext(r.Context(), sttURL+"?"+q.Encode(), http.Header{"X-API-Key": {c.key}})
	if err != nil {
		http.Error(w, "speech service unavailable", http.StatusBadGateway)
		log.Printf("cartesia stt dial: %v", err)
		return
	}
	defer up.Close()
	down, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer down.Close()

	errc := make(chan error, 2)
	go relay(down, up, errc)
	go relay(up, down, errc)
	<-errc
}

func relay(src, dst *websocket.Conn, errc chan<- error) {
	for {
		mt, data, err := src.ReadMessage()
		if err != nil {
			errc <- err
			return
		}
		if err := dst.WriteMessage(mt, data); err != nil {
			errc <- err
			return
		}
	}
}
