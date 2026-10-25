#pragma once

#include <stdint.h>

/* Node id lives in NVS so one firmware image serves every board. Falls back
 * to CONFIG_VENUEMAP_NODE_ID when nothing has been stored. */
void config_init(void);
int config_node_id(void);
/* Stores the id and applies it to the running node. Returns 0 on success. */
int config_set_node_id(int id);
/* Station MAC as "aa:bb:cc:dd:ee:ff"; buf needs 18 bytes. */
void config_mac(char *buf);
