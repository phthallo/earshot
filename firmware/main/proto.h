#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "csi.h"
#include "sniff.h"

typedef void (*proto_walk_cb_t)(bool on);

/* Starts the UART reader task. walk_cb runs in that task when a walk command arrives. */
void proto_init(proto_walk_cb_t walk_cb);

void proto_send_hello(void);
void proto_send_sight(uint32_t ts, const sniff_item_t *items, int n);
void proto_send_motion(uint32_t ts, float score, bool motion, int anon);
void proto_send_csi(uint32_t ts, const float *amps);
