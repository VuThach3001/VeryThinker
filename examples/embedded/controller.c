#include "controller.h"

uint32_t controller_step(uint32_t adc, uint32_t previous_on,
                         uint32_t on_threshold, uint32_t off_threshold,
                         uint32_t fault_low, uint32_t fault_high) {
    if (adc > 4095u || previous_on > 1u || fault_high > 4095u ||
        !(fault_low < off_threshold && off_threshold < on_threshold &&
          on_threshold < fault_high) || adc <= fault_low || adc >= fault_high) {
        return 2u;
    }
    if (adc >= on_threshold) return 1u;
    if (adc <= off_threshold) return 0u;
    return previous_on;
}
