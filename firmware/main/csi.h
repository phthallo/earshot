#pragma once

#include <stdbool.h>
#include <stdint.h>

#define CSI_NUM_AMPS 12

void csi_init(void);

/* Latest LLTF amplitudes for subcarriers 10..21. seq increments per CSI frame;
 * returns false if no frame has arrived yet. */
bool csi_latest(float *amps, uint32_t *seq);

/* Smoothed turbulence score in 0..1. Returns false when no CSI frame arrived
 * within the last max_age_ms; the caller should fall back to another signal. */
bool csi_score(uint32_t now_ms, uint32_t max_age_ms, float *score);
