#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "csi.h"
#include "sniff.h"

typedef void (*proto_walk_cb_t)(bool on);

/* Starts the UART reader task. walk_cb runs in that task when a walk command arrives. */
void proto_init(proto_walk_cb_t walk_cb);

/* Writes a finished line to the console, serialised against the node's own
 * output. The board-to-board link uses it for lines relayed from other nodes. */
void proto_print_line(const char *line);

void proto_send_hello(void);
void proto_send_sight(uint32_t ts, const sniff_item_t *items, int n);
/* Access points heard, raw BSSIDs: infrastructure addresses, not people. */
void proto_send_aps(uint32_t ts, const sniff_item_t *aps, int n);
void proto_send_motion(uint32_t ts, float score, bool motion, int anon);
void proto_send_csi(uint32_t ts, const float *amps);
