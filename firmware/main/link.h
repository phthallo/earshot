#pragma once

/* Board-to-board link over ESP-NOW. A node without a USB host sends its
 * protocol lines here; a node on USB prints every line it receives, so the
 * bridge sees the remote node as if it were wired. No access point is
 * involved, which keeps venue wifi client isolation out of the way. */

/* Call after esp_wifi_start. Both roles receive; relayed lines are printed
 * on the console as they arrive. */
void link_init(void);

/* Broadcasts one line (without the newline) in fragments. Blocks for up to a
 * few ms per fragment while the radio confirms the previous one went out. */
void link_send_line(const char *line);
