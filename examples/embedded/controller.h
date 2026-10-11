#ifndef VERYTHINKER_CONTROLLER_H
#define VERYTHINKER_CONTROLLER_H
#include <stdint.h>

/* Result bit 0: load enabled. Result bit 1: input/configuration fault. */
uint32_t controller_step(uint32_t adc, uint32_t previous_on,
                         uint32_t on_threshold, uint32_t off_threshold,
                         uint32_t fault_low, uint32_t fault_high);
#endif
