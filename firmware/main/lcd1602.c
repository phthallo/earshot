#include "lcd1602.h"

#include "sdkconfig.h"

#if CONFIG_VENUEMAP_LCD

#include <string.h>

#include "driver/i2c.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define I2C_PORT I2C_NUM_0
#define I2C_TIMEOUT pdMS_TO_TICKS(50)

static const char *TAG = "lcd";

/* False when no backpack answered at boot; every call is then a no-op so a
 * missing screen costs nothing and the node runs the same without it. */
static bool present;

/* PCF8574 backpack pin map: P0 RS, P1 RW, P2 EN, P3 backlight, P4..P7 D4..D7. */
#define PIN_RS 0x01
#define PIN_EN 0x04
#define PIN_BL 0x08

static void write_byte(uint8_t b)
{
    i2c_master_write_to_device(I2C_PORT, CONFIG_VENUEMAP_LCD_ADDR, &b, 1, I2C_TIMEOUT);
}

static void write_nibble(uint8_t nibble, uint8_t flags)
{
    uint8_t b = (uint8_t)((nibble << 4) | flags | PIN_BL);
    write_byte(b | PIN_EN);
    esp_rom_delay_us(1);
    write_byte(b);
    esp_rom_delay_us(50);
}

static void send(uint8_t value, uint8_t flags)
{
    write_nibble(value >> 4, flags);
    write_nibble(value & 0x0f, flags);
}

static void command(uint8_t cmd)
{
    send(cmd, 0);
}

void lcd1602_init(void)
{
    const i2c_config_t cfg = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = CONFIG_VENUEMAP_LCD_SDA,
        .scl_io_num = CONFIG_VENUEMAP_LCD_SCL,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = 100000,
    };
    if (i2c_param_config(I2C_PORT, &cfg) != ESP_OK ||
        i2c_driver_install(I2C_PORT, I2C_MODE_MASTER, 0, 0, 0) != ESP_OK) {
        ESP_LOGW(TAG, "i2c setup failed, running without a screen");
        return;
    }
    uint8_t probe = PIN_BL;
    if (i2c_master_write_to_device(I2C_PORT, CONFIG_VENUEMAP_LCD_ADDR, &probe, 1, I2C_TIMEOUT) != ESP_OK) {
        ESP_LOGW(TAG, "no backpack at 0x%02x, running without a screen", CONFIG_VENUEMAP_LCD_ADDR);
        return;
    }
    present = true;

    /* HD44780 4-bit init sequence; timings from the datasheet. */
    vTaskDelay(pdMS_TO_TICKS(50));
    write_nibble(0x03, 0);
    vTaskDelay(pdMS_TO_TICKS(5));
    write_nibble(0x03, 0);
    esp_rom_delay_us(150);
    write_nibble(0x03, 0);
    write_nibble(0x02, 0);

    command(0x28); /* 4-bit, 2 lines, 5x8 */
    command(0x0c); /* display on, cursor off */
    command(0x01); /* clear */
    vTaskDelay(pdMS_TO_TICKS(2));
    command(0x06); /* entry mode: increment, no shift */
}

static void write_line(uint8_t row_addr, const char *text)
{
    command((uint8_t)(0x80 | row_addr));
    for (int i = 0; i < 16; i++) {
        char c = *text ? *text++ : ' ';
        send((uint8_t)c, PIN_RS);
    }
}

void lcd1602_show(const char *line1, const char *line2)
{
    if (!present) return;
    write_line(0x00, line1);
    write_line(0x40, line2);
}

#else

void lcd1602_init(void) {}
void lcd1602_show(const char *line1, const char *line2)
{
    (void)line1;
    (void)line2;
}

#endif
