#include <math.h>
#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#include "csi.h"
#include "lcd1602.h"
#include "proto.h"
#include "sniff.h"

#define TICK_MS 100
#define FLUSH_MS 1000
#define CSI_MAX_AGE_MS 1000
#define RSSI_FLOOR (-85)
#define MOTION_THRESHOLD 0.15f

static volatile bool walk_on;
static sniff_item_t items[SNIFF_MAX_ENTRIES];

static void on_walk(bool on)
{
    walk_on = on;
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        esp_wifi_connect();
    }
}

static void wifi_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));

    bool join = strlen(CONFIG_VENUEMAP_WIFI_SSID) > 0;
    if (join) {
        wifi_config_t sta = { 0 };
        strncpy((char *)sta.sta.ssid, CONFIG_VENUEMAP_WIFI_SSID, sizeof(sta.sta.ssid));
        strncpy((char *)sta.sta.password, CONFIG_VENUEMAP_WIFI_PASSWORD, sizeof(sta.sta.password));
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
        ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    }

    ESP_ERROR_CHECK(esp_wifi_start());

    if (join) {
        ESP_ERROR_CHECK(esp_wifi_connect());
    } else {
        ESP_ERROR_CHECK(esp_wifi_set_channel(CONFIG_VENUEMAP_CHANNEL, WIFI_SECOND_CHAN_NONE));
    }
}

static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

static float churn_score(int anon, int prev_anon)
{
    float s = fabsf((float)(anon - prev_anon)) / 5.0f;
    return s > 1.0f ? 1.0f : s;
}

static void flush(uint32_t ms, int *prev_anon)
{
    int anon = 0;
    int n = sniff_flush(ms / 1000, items, &anon);

    int kept = 0;
    for (int i = 0; i < n; i++) {
        if (items[i].rssi >= RSSI_FLOOR) items[kept++] = items[i];
    }
    proto_send_sight(ms, items, kept);

    float score;
    if (!csi_score(ms, CSI_MAX_AGE_MS, &score)) {
        score = churn_score(anon, *prev_anon);
    }
    *prev_anon = anon;
    bool motion = score > MOTION_THRESHOLD;
    proto_send_motion(ms, score, motion, anon);

    char l1[17], l2[17];
    snprintf(l1, sizeof(l1), "node %d ch%d", CONFIG_VENUEMAP_NODE_ID, CONFIG_VENUEMAP_CHANNEL);
    snprintf(l2, sizeof(l2), "ph:%d mv:%.2f", anon, score);
    lcd1602_show(l1, l2);
}

void app_main(void)
{
    proto_init(on_walk);
    lcd1602_init();
    wifi_init();
    sniff_init();
    csi_init();
    proto_send_hello();

    float amps[CSI_NUM_AMPS];
    uint32_t last_flush = now_ms();
    uint32_t last_csi_seq = 0;
    int prev_anon = 0;

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(TICK_MS));
        uint32_t ms = now_ms();

        uint32_t seq;
        if (walk_on && csi_latest(amps, &seq) && seq != last_csi_seq) {
            last_csi_seq = seq;
            proto_send_csi(ms, amps);
        }

        if (ms - last_flush >= FLUSH_MS) {
            last_flush = ms;
            flush(ms, &prev_anon);
        }
    }
}
