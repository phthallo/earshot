#include "config.h"

#include <stdio.h>

#include "esp_mac.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#define NS "venuemap"
#define KEY_ID "id"

static int node_id = CONFIG_VENUEMAP_NODE_ID;

void config_init(void)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return;
    uint16_t v;
    if (nvs_get_u16(h, KEY_ID, &v) == ESP_OK && v > 0) node_id = v;
    nvs_close(h);
}

int config_node_id(void)
{
    return node_id;
}

int config_set_node_id(int id)
{
    if (id <= 0 || id > 65535) return -1;
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return -1;
    esp_err_t err = nvs_set_u16(h, KEY_ID, (uint16_t)id);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) return -1;
    node_id = id;
    return 0;
}

void config_mac(char *buf)
{
    uint8_t m[6];
    esp_read_mac(m, ESP_MAC_WIFI_STA);
    snprintf(buf, 18, "%02x:%02x:%02x:%02x:%02x:%02x", m[0], m[1], m[2], m[3], m[4], m[5]);
}
