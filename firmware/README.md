# Venuemap ESP32 node

ESP-IDF firmware for an ESP32-S3 devkit (built for the N16R8). The board sniffs wifi
on one channel and reports hashed MACs, a motion score and optional CSI amplitudes to
the Go bridge over its native USB port (`/dev/ttyACM0`, one JSON object per line). The
console is USB serial/JTAG, so no baud rate applies. A plain ESP32 still builds with
`idf.py set-target esp32` and a UART console at 921600 in `sdkconfig`.

## Setup

Install ESP-IDF v5.x and source its environment:

```sh
git clone -b v5.2.2 --recursive https://github.com/espressif/esp-idf.git ~/esp/esp-idf
~/esp/esp-idf/install.sh esp32s3
. ~/esp/esp-idf/export.sh
```

Build and flash from this directory:

```sh
idf.py set-target esp32s3
idf.py menuconfig        # Venuemap menu: node id, channel, salt, wifi, LCD
idf.py -p /dev/ttyACM0 build flash monitor
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

Pass the port explicitly if `idf.py` picks the wrong one: `idf.py -p /dev/ttyACM0 flash monitor`.

Close `idf.py monitor` before starting the bridge; only one program can hold the port.

```sh
go run ./bridge --serial /dev/ttyACM0
```

The bridge's `MAC_SALT` must equal `CONFIG_VENUEMAP_MAC_SALT` (default `dev-salt`),
or hashes will not match across nodes.

## Protocol

Node to bridge, once per second:

- `{"t":"hello","id":103,"fw":"esp-0.2","ch":6,"mac":"b4:fb:e4:1e:c0:23","uplink":"usb"}` at boot. `mac` is the board's own station address, `uplink` is `usb` or `espnow`.
- `{"t":"sight","id":103,"ts":<ms>,"items":[["<sha256 hex>",-61,"aa:bb:cc:dd:ee:ff"],...]}` strongest RSSI per MAC this second, RSSI >= -85 only. The third element is the raw MAC; the bridge shows it when a dot is tapped and never stores it.
- `{"t":"motion","id":103,"ts":<ms>,"score":0.42,"state":"motion"|"idle","pir":0,"anon":17}` `anon` is distinct MACs in the last 10 s

Every five seconds:

- `{"t":"aps","id":103,"ts":<ms>,"items":[["aa:bb:cc:dd:ee:ff",-50],...]}` access points heard (beacon BSSID, strongest RSSI). These are infrastructure addresses, sent raw; the bridge matches them against learned zone fingerprints to place a node that is being carried around.

Frames sent by access points (beacons, probe responses, data with FromDS set) are not counted as phones.

Node to bridge at 10 Hz while a walk capture is on:

- `{"t":"csi","id":103,"ts":<ms>,"amps":[12 floats]}` LLTF subcarriers 10..21

Bridge to node:

- `{"t":"walk","on":1}` start or stop csi lines
- `{"t":"set","id":104}` store the node id in NVS and reply with a fresh `hello` on the USB console, whatever the uplink. The id survives reflashing the app; `idf.py erase-flash` clears it and the node falls back to `CONFIG_VENUEMAP_NODE_ID`.
- anything else is parsed and ignored (`allow` is not implemented)

## Node id and flashing from the browser

One image serves every board of a kind. `CONFIG_VENUEMAP_NODE_ID` is only the default
when NVS has no id. The admin page in the client flashes a board with esp-web-tools and
then sends `set` over Web Serial, so the two builds that matter are the USB one (this
directory's `sdkconfig`) and the battery one (`sdkconfig.remote`). After building both,
`./publish.sh` copies them to `client/public/firmware/{usb,battery}/`, where
`manifest-usb.json` and `manifest-battery.json` point at them.

Hashes are `sha256(salt || "aa:bb:cc:dd:ee:ff")` with the MAC lowercase. The
database keys on the hash; the raw MAC rides along for the device sheet.

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
(address 0x27, SDA GPIO8, SCL GPIO9 on the S3, GPIO21/22 on a plain ESP32, all
adjustable in menuconfig). The backpack is
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
- `main/config.c` node id in NVS, station MAC
- `main/link.c` ESP-NOW relay between a battery node and the USB node
- `main/lcd1602.c` PCF8574 LCD driver (legacy `driver/i2c.h` API)
