idf_component_register(
    SRCS "app_main.c" "sniff.c" "csi.c" "proto.c" "lcd1602.c" "link.c"
    INCLUDE_DIRS "."
    REQUIRES esp_wifi esp_netif esp_event nvs_flash driver esp_driver_usb_serial_jtag mbedtls json esp_timer)
