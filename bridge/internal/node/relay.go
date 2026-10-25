package node

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"strings"
	"time"
)

// Relay forwards the lines of the boards on ports to a hosted bridge at addr,
// authenticating with the venue's relay key, and carries the bridge's
// commands back to the first port. It reconnects on either side until ctx ends.
func Relay(ctx context.Context, ports []string, addr, key string) error {
	for ctx.Err() == nil {
		conn, err := dialRetry(ctx, addr)
		if err != nil {
			return err
		}
		if err := relayOnce(ctx, conn, ports, key); err != nil {
			log.Printf("relay: %v (reconnecting)", err)
		}
		conn.Close()
		time.Sleep(2 * time.Second)
	}
	return nil
}

func relayOnce(ctx context.Context, conn net.Conn, ports []string, key string) error {
	auth, _ := json.Marshal(Message{T: "auth", Key: key})
	if _, err := conn.Write(append(auth, '\n')); err != nil {
		return err
	}
	rd := bufio.NewReader(conn)
	line, err := rd.ReadString('\n')
	if err != nil {
		return err
	}
	var ack struct {
		OK    bool   `json:"ok"`
		Venue string `json:"venue"`
		Msg   string `json:"msg"`
	}
	if json.Unmarshal([]byte(line), &ack) != nil || !ack.OK {
		return &authError{strings.TrimSpace(ack.Msg)}
	}
	log.Printf("relay accepted for venue %s", ack.Venue)

	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, len(ports)+1)
	var first io.Writer
	for i, p := range ports {
		f, err := OpenSerial(cctx, p)
		if err != nil {
			return err
		}
		defer f.Close()
		if i == 0 {
			first = f
		}
		go func() { done <- copyLines(cctx, conn, f) }()
	}
	// Commands from the bridge (walk capture on/off) go to the USB board.
	go func() {
		if first == nil {
			<-cctx.Done()
			done <- nil
			return
		}
		_, err := io.Copy(first, rd)
		done <- err
	}()
	select {
	case <-cctx.Done():
		return nil
	case err := <-done:
		return err
	}
}

// copyLines forwards the JSON lines of r to w, skipping boot noise.
func copyLines(ctx context.Context, w io.Writer, r io.Reader) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		if ctx.Err() != nil {
			return nil
		}
		b := sc.Bytes()
		if len(b) == 0 || b[0] != '{' || !json.Valid(b) {
			continue
		}
		if _, err := w.Write(append(append([]byte{}, b...), '\n')); err != nil {
			return err
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return io.EOF
}

type authError struct{ msg string }

func (e *authError) Error() string {
	if e.msg == "" {
		return "relay key refused"
	}
	return "relay key refused: " + e.msg
}

func dialRetry(ctx context.Context, addr string) (net.Conn, error) {
	for {
		conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
		if err == nil {
			log.Printf("connected to bridge at %s", addr)
			return conn, nil
		}
		log.Printf("dial %s: %v (retry in 3s)", addr, err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}
