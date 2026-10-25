package admin

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
)

// imageSize returns the pixel size and file extension of a png, jpeg or
// webp. webp is read by hand because the standard library has no decoder.
func imageSize(b []byte) (w, h int, ext string, err error) {
	if len(b) >= 30 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP" {
		w, h, err = webpSize(b)
		return w, h, "webp", err
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return 0, 0, "", fmt.Errorf("not a png, jpeg or webp image")
	}
	switch format {
	case "png":
		return cfg.Width, cfg.Height, "png", nil
	case "jpeg":
		return cfg.Width, cfg.Height, "jpg", nil
	}
	return 0, 0, "", fmt.Errorf("not a png, jpeg or webp image")
}

func webpSize(b []byte) (int, int, error) {
	switch string(b[12:16]) {
	case "VP8 ":
		if len(b) < 30 {
			break
		}
		return int(binary.LittleEndian.Uint16(b[26:28]) & 0x3fff), int(binary.LittleEndian.Uint16(b[28:30]) & 0x3fff), nil
	case "VP8L":
		if len(b) < 25 {
			break
		}
		bits := binary.LittleEndian.Uint32(b[21:25])
		return int(bits&0x3fff) + 1, int((bits>>14)&0x3fff) + 1, nil
	case "VP8X":
		if len(b) < 30 {
			break
		}
		w := int(b[24]) | int(b[25])<<8 | int(b[26])<<16
		h := int(b[27]) | int(b[28])<<8 | int(b[29])<<16
		return w + 1, h + 1, nil
	}
	return 0, 0, fmt.Errorf("unreadable webp header")
}
