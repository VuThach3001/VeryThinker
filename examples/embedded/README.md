# Embedded pilot: sensor-driven resistive load

This pilot defines a 12-bit sensor ADC input, hysteretic load control, portable C firmware, and an ideal switched resistive-load circuit. Its executable Node.js model performs behavioral and DC operating-point simulation. The accompanying SPICE netlist can be checked with ngspice.

## Requirements and verification

| Requirement | Behavior                                                                                                                                                                                        | Check                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| EM-REQ-001  | Start with the load disabled. Enable at ADC ≥2800 and disable at ADC ≤2400; preserve the previous state inside the band.                                                                        | EM-CHECK-001, EM-CHECK-003                                        |
| EM-REQ-002  | Invalid ADC/configuration inputs and readings ≤30 or ≥4065 force the load off. A valid sample resumes ordinary hysteresis from the off state.                                                   | EM-CHECK-002, EM-CHECK-003                                        |
| EM-REQ-003  | Thresholds are calibratable; invalid ordering is rejected by fail-off behavior.                                                                                                                 | EM-CHECK-002, EM-CHECK-003                                        |
| EM-REQ-004  | The ideal 12 V, 120 Ω load draws 99–100 mA when enabled and less than 20 nA when disabled.                                                                                                      | EM-CHECK-004, optional EM-CHECK-005 SPICE                         |
| EM-REQ-005  | Supply a portable C controller interface that can be cross-compiled with warnings treated as errors. Verify host execution against the behavioral controller when a host compiler is available. | Optional EM-CHECK-006 cross-compiler, EM-CHECK-007 host execution |

## Hardware–software interface

| Signal/configuration | Contract                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Sensor input         | Unsigned 12-bit ADC code, nominal 3.3 V reference; code 0–4095 maps to 0–3.3 V.                |
| Sampling             | One controller invocation per sample; scheduler and sampling frequency are outside this pilot. |
| Startup              | Caller initializes previous load state to zero/false.                                          |
| Load output          | Active high, nominal 3.3 V logic command to a switch model.                                    |
| Firmware result      | `controller_step` returns bit 0 for load enabled and bit 1 for fault.                          |
| Calibration          | Integer `fault_low < off_threshold < on_threshold < fault_high`, within 0–4095.                |
| Fault coverage       | Rail/open/short proxies only. A plausible stuck reading is not diagnosed.                      |

The C function and behavioral function implement the same contract. Cross-compilation checks the supplied firmware interface. Optional host execution compares all 8,192 ADC/prior-state combinations at the default calibration, 14 representative fault/calibration cases, and nine sequential startup, hysteresis, fault, and recovery samples against the JavaScript model. This establishes agreement for the recorded cases; a shared specification error remains possible. The portable C input type excludes fractional/non-numeric values by construction; the JavaScript trust boundary rejects those values explicitly.

## Circuit and configuration

```text
12 V supply ── 120 Ω load ── switch ── ground
                               ↑
                         3.3 V command
```

The switch model uses 0.05 Ω on resistance and 1 GΩ off resistance. Ohm's law gives `I = 12 / (120 + R_switch)`. Load power is `I² × 120`; switch power is `I² × R_switch`. These values are assumed for a reproducible simulation. They are not a selected MOSFET's datasheet limits.

Configuration baseline: conceptual circuit revision `sim-1`, firmware source hash recorded in evidence, and no physical BOM. ADC/reference accuracy, real sensor transfer function, resistor tolerances, thermal ratings, EMC, power-up transients, timing, and real transistor gate requirements require separate component selection and bench verification.

## Run

```sh
node --test examples/embedded/tests/controller.test.mjs
python examples/embedded/run-ngspice.py --library "/absolute/path/to/ngspice.dll"
node examples/embedded/run-firmware.mjs --compiler "/absolute/path/to/host-compiler"
```

For optional cross-compilation, use an installed cross-compiler without changing the global environment:

```sh
<cross-gcc> -std=c11 -Wall -Wextra -Werror -ffreestanding -c examples/embedded/controller.c -o controller.o
```

The host runner supports installed Digital Mars DMC on Windows and GCC-compatible host compilers, including Clang. It retains the executable, compiler log, and comparison output under the project's ignored `artifacts/firmware-test` directory. No compiler is installed and no global settings are changed. The compiler object and host executable are build artifacts; firmware execution on an MCU or board remains unverified. See `../verification.json` for captured checks and their boundaries when an evidence snapshot has been generated.
