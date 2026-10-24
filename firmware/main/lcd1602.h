#pragma once

/* Both calls compile to nothing when CONFIG_VENUEMAP_LCD is off. */
void lcd1602_init(void);
void lcd1602_show(const char *line1, const char *line2);
