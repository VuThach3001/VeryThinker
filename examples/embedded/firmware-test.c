#include <stdio.h>
#include "controller.h"

static void emit(const char *kind, uint32_t adc, uint32_t previous_on,
                 uint32_t on_threshold, uint32_t off_threshold,
                 uint32_t fault_low, uint32_t fault_high) {
    uint32_t result = controller_step(adc, previous_on, on_threshold,
                                      off_threshold, fault_low, fault_high);
    printf("%s,%lu,%lu,%lu,%lu,%lu,%lu,%lu\n", kind,
           (unsigned long)adc, (unsigned long)previous_on,
           (unsigned long)on_threshold, (unsigned long)off_threshold,
           (unsigned long)fault_low, (unsigned long)fault_high,
           (unsigned long)result);
}

int main(void) {
    uint32_t adc;
    uint32_t previous_on;
    unsigned int i;
    const uint32_t boundary[][6] = {
        {4096u, 0u, 2800u, 2400u, 30u, 4065u},
        {0xffffffffu, 1u, 2800u, 2400u, 30u, 4065u},
        {2700u, 2u, 2800u, 2400u, 30u, 4065u},
        {2700u, 0u, 2400u, 2800u, 30u, 4065u},
        {2800u, 1u, 2800u, 2800u, 30u, 4065u},
        {2700u, 1u, 2800u, 2400u, 2400u, 4065u},
        {2800u, 0u, 2800u, 2400u, 30u, 2800u},
        {3500u, 0u, 2800u, 2400u, 30u, 4096u},
        {3500u, 0u, 0xffffffffu, 2400u, 30u, 4065u},
        {3000u, 0u, 3000u, 2600u, 50u, 4000u},
        {2600u, 1u, 3000u, 2600u, 50u, 4000u},
        {2800u, 1u, 3000u, 2600u, 50u, 4000u},
        {50u, 1u, 3000u, 2600u, 50u, 4000u},
        {4000u, 1u, 3000u, 2600u, 50u, 4000u}
    };
    const uint32_t sequence[] = {3500u, 2600u, 2400u, 2700u, 2800u,
                                 4065u, 2600u, 2800u, 0u};
    for (adc = 0u; adc <= 4095u; ++adc) {
        for (previous_on = 0u; previous_on <= 1u; ++previous_on) {
            emit("exhaustive", adc, previous_on, 2800u, 2400u, 30u, 4065u);
        }
    }
    for (i = 0u; i < sizeof(boundary) / sizeof(boundary[0]); ++i) {
        emit("boundary", boundary[i][0], boundary[i][1], boundary[i][2],
             boundary[i][3], boundary[i][4], boundary[i][5]);
    }
    previous_on = 0u;
    for (i = 0u; i < sizeof(sequence) / sizeof(sequence[0]); ++i) {
        emit("sequence", sequence[i], previous_on, 2800u, 2400u, 30u, 4065u);
        previous_on = controller_step(sequence[i], previous_on, 2800u,
                                       2400u, 30u, 4065u) & 1u;
    }
    return ferror(stdout) ? 1 : 0;
}
