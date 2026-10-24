#include "link.h"

#include <stdlib.h>
#include <string.h>

#include "esp_now.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "proto.h"

#define MAGIC0 'V'
#define MAGIC1 'M'
#define HDR_LEN 8
#define FRAG_PAYLOAD (ESP_NOW_MAX_DATA_LEN - HDR_LEN)
#define MAX_FRAGS 64
#define LINE_MAX (MAX_FRAGS * FRAG_PAYLOAD)
#define SENDERS 4

/* Header: magic(2) node id(2, big endian) seq(1) fragment index(1) fragment count(1) pad(1). */

typedef struct {
    uint8_t mac[6];
    uint8_t seq;
    uint8_t cnt;
    uint64_t got;
    uint16_t len;
    char buf[LINE_MAX + 1];
} slot_t;

static slot_t slots[SENDERS];
static QueueHandle_t lines;
static SemaphoreHandle_t sent;
static const uint8_t broadcast[6] = { 0xff, 0xff, 0xff, 0xff, 0xff, 0xff };

static slot_t *slot_for(const uint8_t *mac)
{
    slot_t *oldest = &slots[0];
    for (int i = 0; i < SENDERS; i++) {
        if (memcmp(slots[i].mac, mac, 6) == 0) return &slots[i];
        if (slots[i].len == 0) oldest = &slots[i];
    }
    memset(oldest, 0, sizeof(*oldest));
    memcpy(oldest->mac, mac, 6);
    return oldest;
}

static void on_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len)
{
    if (len < HDR_LEN || data[0] != MAGIC0 || data[1] != MAGIC1) return;
    uint8_t seq = data[4], idx = data[5], cnt = data[6];
    if (cnt == 0 || cnt > MAX_FRAGS || idx >= cnt) return;

    slot_t *s = slot_for(info->src_addr);
    if (s->seq != seq || s->cnt != cnt) {
        s->seq = seq;
        s->cnt = cnt;
        s->got = 0;
        s->len = 0;
    }
    int n = len - HDR_LEN;
    memcpy(s->buf + idx * FRAG_PAYLOAD, data + HDR_LEN, n);
    s->got |= (uint64_t)1 << idx;
    if (idx == cnt - 1) s->len = idx * FRAG_PAYLOAD + n;

    uint64_t all = cnt == 64 ? ~(uint64_t)0 : (((uint64_t)1 << cnt) - 1);
    if (s->got != all || s->len == 0) return;

    char *line = malloc(s->len + 1);
    if (line) {
        memcpy(line, s->buf, s->len);
        line[s->len] = '\0';
        if (xQueueSend(lines, &line, 0) != pdTRUE) free(line);
    }
    s->got = 0;
    s->len = 0;
}

static void on_sent(const esp_now_send_info_t *info, esp_now_send_status_t status)
{
    xSemaphoreGive(sent);
}

static void print_task(void *arg)
{
    char *line;
    for (;;) {
        if (xQueueReceive(lines, &line, portMAX_DELAY) == pdTRUE) {
            proto_print_line(line);
            free(line);
        }
    }
}

void link_init(void)
{
    lines = xQueueCreate(16, sizeof(char *));
    sent = xSemaphoreCreateBinary();
    ESP_ERROR_CHECK(esp_now_init());
    ESP_ERROR_CHECK(esp_now_register_recv_cb(on_recv));
    ESP_ERROR_CHECK(esp_now_register_send_cb(on_sent));
    esp_now_peer_info_t peer = { 0 };
    memcpy(peer.peer_addr, broadcast, 6);
    peer.ifidx = WIFI_IF_STA;
    peer.channel = 0; /* whatever channel the radio is on */
    ESP_ERROR_CHECK(esp_now_add_peer(&peer));
    xTaskCreate(print_task, "link_print", 4096, NULL, 4, NULL);
}

void link_send_line(const char *line)
{
    static uint8_t seq;
    static uint8_t pkt[ESP_NOW_MAX_DATA_LEN];
    size_t len = strlen(line);
    if (len == 0 || len > LINE_MAX) return;
    int cnt = (len + FRAG_PAYLOAD - 1) / FRAG_PAYLOAD;
    seq++;
    for (int i = 0; i < cnt; i++) {
        size_t off = (size_t)i * FRAG_PAYLOAD;
        size_t n = len - off < FRAG_PAYLOAD ? len - off : FRAG_PAYLOAD;
        pkt[0] = MAGIC0;
        pkt[1] = MAGIC1;
        pkt[2] = CONFIG_VENUEMAP_NODE_ID >> 8;
        pkt[3] = CONFIG_VENUEMAP_NODE_ID & 0xff;
        pkt[4] = seq;
        pkt[5] = (uint8_t)i;
        pkt[6] = (uint8_t)cnt;
        pkt[7] = 0;
        memcpy(pkt + HDR_LEN, line + off, n);
        if (esp_now_send(broadcast, pkt, HDR_LEN + n) != ESP_OK) return;
        /* One fragment in flight at a time; the radio drops bursts otherwise. */
        xSemaphoreTake(sent, pdMS_TO_TICKS(50));
    }
}
