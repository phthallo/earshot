# Hardware to grab from the rental desk

| Qty | Part | Used for |
|----:|------|----------|
| 1 | Raspberry Pi (3B+ or 4 preferred, any Pi with wifi works) | Node 1: wifi sniffer. 3B+/4 can also do CSI with nexmon |
| 1 | microSD card, 16 GB or more | Pi OS |
| 1 | Pi power supply or USB-C cable + brick | Powering the Pi |
| 1 | Pack of female-to-male Dupont jumper wires | Female end on the Pi header, male end into a breadboard |
| 1 | Pack of male-to-male Dupont jumper wires | Breadboard to the LCD pins |
| 1 | Breadboard | Joins the two wire types. No breadboard: skip the LCD |
| 0-1 | LCD1602 display, only if it has an I2C backpack (4 pins on the back) | Node status screen ("pairing: hold phone here"). A bare 16-pin LCD1602 needs a contrast pot, skip it |
| 0-2 | ESP32 dev board | Only if they reappear. Firmware in `firmware/` is optional |

Not useful here: GY-6500 (MPU-6500 accelerometer/gyro). It senses the board moving, not people. Without a PIR the motion score comes from wifi alone.

Your laptop is node 2 (monitor mode sniffer), so one Pi is enough.

## Plans by what is in stock

Nothing below changes the software. Every plan runs the same bridge and the same web app. The demo falls back to the mock crowd whenever a real node is missing.

Check stock in this order, stop at the first row that matches.

| Plan | Pi 4B | Wires | Breadboard | What you get | What to tell judges |
|------|-------|-------|------------|--------------|---------------------|
| A, best | yes | any F-F, F-M or M-M | yes or no | Pi node at check-in (sniffer, optional nexmon CSI) + laptop node at the hardware desk + LCD status screen | Two real nodes, live pairing on stage, CSI motion from the Pi |
| B | yes | none | no | Pi node + laptop node, no LCD | Two real nodes, pairing works. Status shows on the web page instead of an LCD |
| C | no | any | any | Laptop only, one real node | One real node at the demo table, rest of the venue from the mock replayer |
| D, worst | no | none | no | Laptop only | Same as C. Nothing changes except the wording |

### Plan A: Pi + wires

Grab: 1 Pi 4B, 1 microSD 16 GB+, 1 USB-C power cable, 1 LCD1602 with I2C backpack, wires per the table below.

| Wires in stock | Breadboard | How the LCD connects |
|----------------|------------|----------------------|
| F-F | not needed | LCD backpack pins straight to the Pi header, 4 wires |
| F-M + M-M | needed | F-M from Pi header to breadboard, M-M from breadboard to LCD |
| F-M only | needed | F-M from Pi to breadboard. LCD pins push into the breadboard directly if the backpack has a straight header |
| M-M only | no good | Skip the LCD. Nothing male fits the Pi header |

F-F wires are the best case because they remove the breadboard entirely. If you see F-F, take one pack and stop looking for a breadboard.

Steps on the day:
1. Flash Pi OS Lite to the card, enable SSH and wifi in the imager.
2. SSH in, install Go, run `bridge --node --id 101 --connect <laptop-ip>:9000` (full steps in `HANDOFF.md`).
3. Only if time is left: nexmon CSI for a real motion score at that node.

### Plan B: Pi, no wires

Same as A without the LCD. The web page already shows "hold your phone near the check-in node" during pairing, so the LCD is a nicety. Spend the saved time on nexmon CSI instead.

### Plan C or D: no Pi

Laptop is the only real node. Put it on the demo table as node 101 (check-in). The pairing demo still works: judge toggles airplane mode, their phone appears at the laptop node. Everything else on the map is the mock crowd, labelled as such in the UI.

If ESP32s reappear at any point, two of them replace the Pi in plan A and add real CSI without nexmon. Firmware is in `firmware/`.

### Time cost

| Plan | Setup time before it works |
|------|---------------------------|
| A | about 60 min (Pi flash 15, SSH + Go 20, LCD wiring 10, test 15), plus 60-90 min if you attempt nexmon |
| B | about 45 min |
| C, D | about 15 min (monitor mode on the laptop, already scripted in `HANDOFF.md`) |

## Wiring (no solder)

LCD1602 I2C backpack: VCC to Pi pin 2 (5V), GND to pin 6, SDA to pin 3 (GPIO 2), SCL to pin 5 (GPIO 3).

If a PIR (HC-SR501) turns up: VCC to pin 4 (5V), GND to pin 9, OUT to pin 13 (GPIO 27).
