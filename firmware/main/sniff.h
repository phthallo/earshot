#pragma once

#include <stdint.h>

#define SNIFF_MAX_ENTRIES 128

typedef struct {
    uint8_t mac[6];
    int8_t rssi;
} sniff_item_t;

void sniff_init(void);

/* Copies every MAC seen since the previous flush into out (up to SNIFF_MAX_ENTRIES),
 * returns the count, and writes the number of distinct MACs seen in the last 10 s
 * to anon. Resets the per-second RSSI tracking. */
int sniff_flush(uint32_t now_s, sniff_item_t *out, int *anon);
