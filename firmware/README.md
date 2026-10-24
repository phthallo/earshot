# Venuemap ESP32 node

ESP-IDF firmware for a plain ESP32 (WROOM). The board sniffs wifi on one channel and
reports hashed MACs, a motion score and optional CSI amplitudes to the Go bridge over
the USB serial port (921600 8N1, one JSON object per line; `idf.py monitor` needs
`-b 921600`).

## Setup

Install ESP-IDF v5.x and source its environment:

```sh
git clone -b v5.2.2 --recursive https://github.com/espressif/esp-idf.git ~/esp/esp-idf
~/esp/esp-idf/install.sh esp32
. ~/esp/esp-idf/export.sh
```

Build and flash from this directory:

```sh
idf.py set-target esp32
idf.py menuconfig        # Venuemap menu: node id, channel, salt, wifi, LCD
idf.py build flash monitor -b 921600
```

`sdkconfig.defaults` already enables CSI (`CONFIG_ESP_WIFI_CSI_ENABLED`) and lowers
the log level to warnings so logs do not flood the serial link. The bridge ignores
non-JSON lines.

## Serial port

The board shows up as `/dev/ttyUSB0` (CP2102/CH340 boards) or `/dev/ttyACM0`
(native USB). Check with `ls /dev/ttyUSB* /dev/ttyACM*` after plugging it in.

On Fedora, add yourself to `dialout` and log out and back in:

```sh
sudo usermod -aG dialout "$USER"
```

If ModemManager grabs the port, stop it for the session: `sudo systemctl stop ModemManager`.

Pass the port explicitly if `idf.py` picks the wrong one: `idf.py -p /dev/ttyUSB0 flash monitor`.

Close `idf.py monitor` before starting the bridge; only one program can hold the port.

```sh
go run ./bridge --serial /dev/ttyUSB0
```

The bridge's `MAC_SALT` must equal `CONFIG_VENUEMAP_MAC_SALT` (default `dev-salt`),
or hashes will not match across nodes.

## Protocol

Node to bridge, once per second:

- `{"t":"hello","id":103,"fw":"esp-0.1","ch":6}` at boot
- `{"t":"sight","id":103,"ts":<ms>,"items":[["<sha256 hex>",-61],...]}` strongest RSSI per MAC this second, RSSI >= -85 only
- `{"t":"motion","id":103,"ts":<ms>,"score":0.42,"state":"motion"|"idle","pir":0,"anon":17}` `anon` is distinct MACs in the last 10 s

Node to bridge at 10 Hz while a walk capture is on:

- `{"t":"csi","id":103,"ts":<ms>,"amps":[12 floats]}` LLTF subcarriers 10..21

Bridge to node:

- `{"t":"walk","on":1}` start or stop csi lines
- anything else is parsed and ignored (`allow` is not implemented)

Hashes are `sha256(salt || "aa:bb:cc:dd:ee:ff")` with the MAC lowercase. Raw MACs
never leave the device.

## CSI caveats

The ESP32 only delivers CSI for frames addressed to it. A board that just sniffs
receives almost none, so the motion score falls back to MAC churn
(`|distinct_now - distinct_prev| / 5`, clamped to 1) whenever no CSI frame arrived in
the last second.

For a steady CSI stream, join the venue wifi. Set `CONFIG_VENUEMAP_WIFI_SSID` and
`CONFIG_VENUEMAP_WIFI_PASSWORD` in menuconfig. The ESP32 stays in station mode with
promiscuous mode on, so sniffing keeps working. Two consequences:

- the AP decides the channel; `CONFIG_VENUEMAP_CHANNEL` is ignored and the `hello`
  line still reports the configured value
- the ESP32 reconnects on its own after a disconnect

The CSI score is the mean absolute change of the 12 subcarrier amplitudes between
consecutive frames, normalised by a slowly decaying running maximum and EMA smoothed.
`state` is `motion` when the score exceeds 0.15.

## LCD1602

Optional. The default build drives a 16x2 display on a PCF8574 I2C backpack
(address 0x27, SDA GPIO21, SCL GPIO22, all adjustable in menuconfig). The backpack is
probed once at boot; if nothing answers, the log says `no backpack at 0x27` and the
node runs without a screen. Line 1 shows `node 103 ch6`, line 2 `ph:17 mv:0.42`
(`phones:` does not fit 16 columns with the score).

A bare LCD1602 with no I2C backpack is not supported. It would need six GPIOs in
4-bit mode and a different driver. Leave it unplugged.

## Files

- `main/app_main.c` wifi bring-up, one second flush loop
- `main/sniff.c` promiscuous callback and MAC table
- `main/csi.c` CSI callback and turbulence score
- `main/proto.c` JSON line output, UART command reader, MAC hashing
- `main/lcd1602.c` PCF8574 LCD driver (legacy `driver/i2c.h` API)
