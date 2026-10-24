#include "proto.h"

#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "link.h"
#include "mbedtls/sha256.h"
#include "sdkconfig.h"

#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
#include "driver/usb_serial_jtag.h"
#else
#include "driver/uart.h"
#endif

#define FW_VERSION "esp-0.1"
#define RX_LINE_MAX 1024
/* One item is a 64 hex hash, an RSSI and a 17 char MAC plus JSON framing. */
#define TX_BUF_MAX (SNIFF_MAX_ENTRIES * 100 + 128)

static char tx_buf[TX_BUF_MAX];
static proto_walk_cb_t walk_cb;
static SemaphoreHandle_t out_lock;

void proto_print_line(const char *s)
{
    xSemaphoreTake(out_lock, portMAX_DELAY);
    fputs(s, stdout);
    fputc('\n', stdout);
    fflush(stdout);
    xSemaphoreGive(out_lock);
}

static void emit(const char *s)
{
#if CONFIG_VENUEMAP_UPLINK_ESPNOW
    link_send_line(s);
#else
    proto_print_line(s);
#endif
}

static void hash_mac(const uint8_t *mac, char *hex65)
{
    static const char salt[] = CONFIG_VENUEMAP_MAC_SALT;
    char in[sizeof(salt) - 1 + 18];
    unsigned char digest[32];

    memcpy(in, salt, sizeof(salt) - 1);
    snprintf(in + sizeof(salt) - 1, 18, "%02x:%02x:%02x:%02x:%02x:%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    mbedtls_sha256((const unsigned char *)in, sizeof(salt) - 1 + 17, digest, 0);
    for (int i = 0; i < 32; i++) sprintf(hex65 + i * 2, "%02x", digest[i]);
}

void proto_send_hello(void)
{
    snprintf(tx_buf, sizeof(tx_buf), "{\"t\":\"hello\",\"id\":%d,\"fw\":\"%s\",\"ch\":%d}",
             CONFIG_VENUEMAP_NODE_ID, FW_VERSION, CONFIG_VENUEMAP_CHANNEL);
    emit(tx_buf);
}

void proto_send_sight(uint32_t ts, const sniff_item_t *items, int n)
{
    char hex[65];
    int off = snprintf(tx_buf, sizeof(tx_buf), "{\"t\":\"sight\",\"id\":%d,\"ts\":%lu,\"items\":[",
                       CONFIG_VENUEMAP_NODE_ID, (unsigned long)ts);
    for (int i = 0; i < n; i++) {
        const uint8_t *m = items[i].mac;
        hash_mac(m, hex);
        /* The hash is what the database keys on; the MAC is shown when a dot
         * is clicked and is otherwise not stored. */
        off += snprintf(tx_buf + off, sizeof(tx_buf) - off, "%s[\"%s\",%d,\"%02x:%02x:%02x:%02x:%02x:%02x\"]",
                        i ? "," : "", hex, items[i].rssi, m[0], m[1], m[2], m[3], m[4], m[5]);
        if (off >= (int)sizeof(tx_buf) - 8) break;
    }
    snprintf(tx_buf + off, sizeof(tx_buf) - off, "]}");
    emit(tx_buf);
}

void proto_send_aps(uint32_t ts, const sniff_item_t *aps, int n)
{
    int off = snprintf(tx_buf, sizeof(tx_buf), "{\"t\":\"aps\",\"id\":%d,\"ts\":%lu,\"items\":[",
                       CONFIG_VENUEMAP_NODE_ID, (unsigned long)ts);
    for (int i = 0; i < n; i++) {
        const uint8_t *m = aps[i].mac;
        off += snprintf(tx_buf + off, sizeof(tx_buf) - off, "%s[\"%02x:%02x:%02x:%02x:%02x:%02x\",%d]",
                        i ? "," : "", m[0], m[1], m[2], m[3], m[4], m[5], aps[i].rssi);
        if (off >= (int)sizeof(tx_buf) - 8) break;
    }
    snprintf(tx_buf + off, sizeof(tx_buf) - off, "]}");
    emit(tx_buf);
}

void proto_send_motion(uint32_t ts, float score, bool motion, int anon)
{
    snprintf(tx_buf, sizeof(tx_buf),
             "{\"t\":\"motion\",\"id\":%d,\"ts\":%lu,\"score\":%.3f,\"state\":\"%s\",\"pir\":0,\"anon\":%d}",
             CONFIG_VENUEMAP_NODE_ID, (unsigned long)ts, score, motion ? "motion" : "idle", anon);
    emit(tx_buf);
}

void proto_send_csi(uint32_t ts, const float *amps)
{
    int off = snprintf(tx_buf, sizeof(tx_buf), "{\"t\":\"csi\",\"id\":%d,\"ts\":%lu,\"amps\":[",
                       CONFIG_VENUEMAP_NODE_ID, (unsigned long)ts);
    for (int i = 0; i < CSI_NUM_AMPS; i++) {
        off += snprintf(tx_buf + off, sizeof(tx_buf) - off, "%s%.1f", i ? "," : "", amps[i]);
    }
    snprintf(tx_buf + off, sizeof(tx_buf) - off, "]}");
    emit(tx_buf);
}

static void handle_line(const char *line)
{
    cJSON *root = cJSON_Parse(line);
    if (!root) return;
    const cJSON *t = cJSON_GetObjectItem(root, "t");
    if (cJSON_IsString(t) && strcmp(t->valuestring, "walk") == 0) {
        const cJSON *on = cJSON_GetObjectItem(root, "on");
        if (walk_cb) walk_cb(cJSON_IsNumber(on) ? on->valueint != 0 : cJSON_IsTrue(on));
    }
    cJSON_Delete(root);
}

/* One byte from whichever port the console is on, 100 ms timeout. */
static int read_byte(uint8_t *c)
{
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
    return usb_serial_jtag_read_bytes(c, 1, pdMS_TO_TICKS(100));
#else
    return uart_read_bytes(UART_NUM_0, c, 1, pdMS_TO_TICKS(100));
#endif
}

static void rx_task(void *arg)
{
    static char line[RX_LINE_MAX];
    int len = 0;
    uint8_t c;

    for (;;) {
        if (read_byte(&c) != 1) continue;
        if (c == '\n' || c == '\r') {
            if (len > 0) {
                line[len] = '\0';
                handle_line(line);
            }
            len = 0;
        } else if (len < RX_LINE_MAX - 1) {
            line[len++] = (char)c;
        } else {
            len = 0;
        }
    }
}

void proto_init(proto_walk_cb_t cb)
{
    walk_cb = cb;
    out_lock = xSemaphoreCreateMutex();
    /* RX only; stdout keeps using the console's polled writes. */
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
    usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&cfg));
#else
    ESP_ERROR_CHECK(uart_driver_install(UART_NUM_0, 1024, 0, 0, NULL, 0));
#endif
    xTaskCreate(rx_task, "proto_rx", 4096, NULL, 5, NULL);
}
