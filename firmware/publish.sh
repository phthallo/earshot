#!/bin/sh
# Copies the two builds into the client so the flash page can install them.
# Run after `idf.py build` (USB) and the battery build from sdkconfig.remote.
set -e
cd "$(dirname "$0")"
out=../client/public/firmware
for pair in build:usb build-remote:battery; do
  src=${pair%%:*}
  dst=$out/${pair##*:}
  mkdir -p "$dst"
  cp "$src/bootloader/bootloader.bin" "$src/partition_table/partition-table.bin" "$src/venuemap_node.bin" "$dst/"
done
ls -l $out/usb $out/battery
