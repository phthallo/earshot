#pragma once

#include <stdint.h>

#define SNIFF_MAX_ENTRIES 256
#define SNIFF_MAX_APS 32

typedef struct {
    uint8_t mac[6];
    int8_t rssi;
} sniff_item_t;

void sniff_init(void);

/* Copies every station MAC seen since the previous flush into out (up to
 * SNIFF_MAX_ENTRIES), returns the count, and writes the number of distinct MACs
 * seen in the last 10 s to anon. Resets the per-second RSSI tracking. Frames sent
 * by access points are not counted. */
int sniff_flush(uint32_t now_s, sniff_item_t *out, int *anon);

/* Copies the access points heard since the previous call (beacon BSSID and
 * strongest RSSI) into out, up to SNIFF_MAX_APS, and returns the count. The
 * bridge matches this list against learned zone fingerprints to place the node. */
int sniff_flush_aps(sniff_item_t *out);
