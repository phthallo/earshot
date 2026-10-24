#include "sniff.h"

#include <string.h>

#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"

#define ANON_WINDOW_S 10

typedef struct {
    uint8_t mac[6];
    int8_t best_rssi;
    uint32_t seen_s;
    uint8_t used;
    uint8_t seen_this_sec;
} entry_t;

static entry_t table[SNIFF_MAX_ENTRIES];
static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static volatile uint32_t now_s_shared;

static void record(const uint8_t *mac, int8_t rssi)
{
    uint32_t now = now_s_shared;
    entry_t *free_slot = NULL;
    entry_t *oldest = &table[0];

    portENTER_CRITICAL(&lock);
    for (int i = 0; i < SNIFF_MAX_ENTRIES; i++) {
        entry_t *e = &table[i];
        if (!e->used) {
            if (!free_slot) free_slot = e;
            continue;
        }
        if (memcmp(e->mac, mac, 6) == 0) {
            if (!e->seen_this_sec || rssi > e->best_rssi) e->best_rssi = rssi;
            e->seen_this_sec = 1;
            e->seen_s = now;
            portEXIT_CRITICAL(&lock);
            return;
        }
        if (e->seen_s < oldest->seen_s) oldest = e;
    }
    entry_t *e = free_slot ? free_slot : oldest;
    memcpy(e->mac, mac, 6);
    e->best_rssi = rssi;
    e->seen_s = now;
    e->used = 1;
    e->seen_this_sec = 1;
    portEXIT_CRITICAL(&lock);
}

typedef struct {
    uint8_t bssid[6];
    int8_t best_rssi;
    uint8_t used;
} ap_entry_t;

static ap_entry_t aps[SNIFF_MAX_APS];

static void record_ap(const uint8_t *bssid, int8_t rssi)
{
    ap_entry_t *free_slot = NULL;
    portENTER_CRITICAL(&lock);
    for (int i = 0; i < SNIFF_MAX_APS; i++) {
        ap_entry_t *e = &aps[i];
        if (!e->used) {
            if (!free_slot) free_slot = e;
            continue;
        }
        if (memcmp(e->bssid, bssid, 6) == 0) {
            if (rssi > e->best_rssi) e->best_rssi = rssi;
            portEXIT_CRITICAL(&lock);
            return;
        }
    }
    if (free_slot) {
        memcpy(free_slot->bssid, bssid, 6);
        free_slot->best_rssi = rssi;
        free_slot->used = 1;
    }
    portEXIT_CRITICAL(&lock);
}

static void rx_cb(void *buf, wifi_promiscuous_pkt_type_t type)
{
    if (type != WIFI_PKT_MGMT && type != WIFI_PKT_DATA) return;
    const wifi_promiscuous_pkt_t *p = buf;
    if (p->rx_ctrl.sig_len < 24) return;
    const uint8_t fc0 = p->payload[0];
    const uint8_t fc1 = p->payload[1];
    const uint8_t *addr2 = p->payload + 10;
    /* bit 0 of the first octet marks group addresses; a transmitter is always unicast. */
    if (addr2[0] & 0x01) return;

    if (type == WIFI_PKT_MGMT) {
        const uint8_t subtype = fc0 >> 4;
        if (subtype == 8 || subtype == 5) {
            /* Beacon or probe response: the transmitter is an access point. */
            record_ap(addr2, p->rx_ctrl.rssi);
            return;
        }
        /* Only frames a phone sends while looking for or joining a network.
         * Action frames (Apple AWDL and the like) use throwaway addresses. */
        if (subtype != 4 && subtype != 0 && subtype != 2) return;
    } else if ((fc1 & 0x03) != 0x01) {
        /* Only ToDS data: a station talking to its access point. FromDS is the
         * access point; neither bit is peer-to-peer traffic with random addresses. */
        return;
    }
    record(addr2, p->rx_ctrl.rssi);
}

int sniff_flush_aps(sniff_item_t *out)
{
    int n = 0;
    portENTER_CRITICAL(&lock);
    for (int i = 0; i < SNIFF_MAX_APS; i++) {
        ap_entry_t *e = &aps[i];
        if (!e->used) continue;
        memcpy(out[n].mac, e->bssid, 6);
        out[n].rssi = e->best_rssi;
        n++;
        e->used = 0;
    }
    portEXIT_CRITICAL(&lock);
    return n;
}

void sniff_init(void)
{
    const wifi_promiscuous_filter_t filt = {
        .filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA,
    };
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous_filter(&filt));
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous_rx_cb(rx_cb));
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous(true));
}

int sniff_flush(uint32_t now_s, sniff_item_t *out, int *anon)
{
    int n = 0;
    int distinct = 0;

    now_s_shared = now_s;
    portENTER_CRITICAL(&lock);
    for (int i = 0; i < SNIFF_MAX_ENTRIES; i++) {
        entry_t *e = &table[i];
        if (!e->used) continue;
        if (now_s - e->seen_s > ANON_WINDOW_S) {
            e->used = 0;
            continue;
        }
        distinct++;
        if (e->seen_this_sec) {
            memcpy(out[n].mac, e->mac, 6);
            out[n].rssi = e->best_rssi;
            n++;
            e->seen_this_sec = 0;
        }
    }
    portEXIT_CRITICAL(&lock);

    *anon = distinct;
    return n;
}
