#include "csi.h"

#include <math.h>
#include <string.h>

#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"

#define FIRST_SUBCARRIER 10
#define EMA_ALPHA 0.3f
#define MAX_DECAY 0.999f

static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static float amps[CSI_NUM_AMPS];
static float prev_amps[CSI_NUM_AMPS];
static float running_max = 1.0f;
static float ema;
static uint32_t seq;
static uint32_t last_ms;

/* CSI frames only arrive for packets addressed to this station, so a steady
 * stream needs the ESP32 associated to an AP (set VENUEMAP_WIFI_SSID). */
static void csi_cb(void *ctx, wifi_csi_info_t *info)
{
    /* LLTF is 64 subcarriers of (imag, real) int8 pairs. */
    if (!info || !info->buf || info->len < (FIRST_SUBCARRIER + CSI_NUM_AMPS) * 2) return;

    float cur[CSI_NUM_AMPS];
    float diff = 0.0f;
    for (int i = 0; i < CSI_NUM_AMPS; i++) {
        int idx = (FIRST_SUBCARRIER + i) * 2;
        float im = info->buf[idx];
        float re = info->buf[idx + 1];
        cur[i] = sqrtf(im * im + re * re);
    }

    portENTER_CRITICAL(&lock);
    if (seq > 0) {
        for (int i = 0; i < CSI_NUM_AMPS; i++) diff += fabsf(cur[i] - prev_amps[i]);
        diff /= CSI_NUM_AMPS;
        running_max = fmaxf(running_max * MAX_DECAY, diff);
        float norm = diff / running_max;
        if (norm > 1.0f) norm = 1.0f;
        ema = EMA_ALPHA * norm + (1.0f - EMA_ALPHA) * ema;
    }
    memcpy(prev_amps, cur, sizeof(cur));
    memcpy(amps, cur, sizeof(cur));
    seq++;
    last_ms = (uint32_t)(esp_timer_get_time() / 1000);
    portEXIT_CRITICAL(&lock);
}

void csi_init(void)
{
    const wifi_csi_config_t cfg = {
        .lltf_en = true,
        .htltf_en = false,
        .stbc_htltf2_en = false,
        .ltf_merge_en = true,
        .channel_filter_en = true,
        .manu_scale = false,
        .shift = false,
    };
    ESP_ERROR_CHECK(esp_wifi_set_csi_config(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(csi_cb, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_csi(true));
}

bool csi_latest(float *out, uint32_t *out_seq)
{
    portENTER_CRITICAL(&lock);
    bool have = seq > 0;
    memcpy(out, amps, sizeof(amps));
    *out_seq = seq;
    portEXIT_CRITICAL(&lock);
    return have;
}

bool csi_score(uint32_t now_ms, uint32_t max_age_ms, float *score)
{
    portENTER_CRITICAL(&lock);
    bool fresh = seq > 1 && (now_ms - last_ms) <= max_age_ms;
    *score = ema;
    portEXIT_CRITICAL(&lock);
    return fresh;
}
