import assert from 'node:assert/strict';
import test from 'node:test';
import { CIRCUIT, DEFAULT_CALIBRATION, controllerStep, operatingPoint, simulate } from '../simulation.mjs';

test('EM-CHECK-001: hysteresis, startup, and threshold inclusivity', () => {
  const readings = [2600, 2800, 2799, 2500, 2401, 2400, 2500, 2801];
  assert.deepEqual(simulate(readings).map(s => s.on), [false, true, true, true, true, false, false, true]);
  assert.ok(simulate(readings).every(s => !s.fault));
});

test('EM-CHECK-002: fail-off behavior and recovery', () => {
  for (const adc of [-1, 0, 30, 4065, 4095, 4096, 1.5, NaN, Infinity, '2800']) {
    assert.deepEqual(controllerStep(adc, true), { on: false, fault: true });
  }
  for (const adc of [31, 4064]) assert.equal(controllerStep(adc).fault, false);
  assert.deepEqual(simulate([3000, 0, 2600, 3000]).map(s => [s.on, s.fault]),
    [[true, false], [false, true], [false, false], [true, false]]);
  assert.deepEqual(controllerStep(3000, true, { ...DEFAULT_CALIBRATION, offThreshold: 2800 }),
    { on: false, fault: true });
  assert.deepEqual(controllerStep(3000, 1), { on: false, fault: true });
});

test('EM-CHECK-003: calibration and exhaustive ADC-domain behavior', () => {
  const calibration = { ...DEFAULT_CALIBRATION, onThreshold: 3000, offThreshold: 2600 };
  assert.equal(controllerStep(2800, false, calibration).on, false);
  assert.equal(controllerStep(3000, false, calibration).on, true);
  for (let adc = 0; adc <= 4095; adc++) {
    for (const previous of [false, true]) {
      const actual = controllerStep(adc, previous);
      const expected = adc <= 30 || adc >= 4065 ? { on: false, fault: true }
        : { on: adc >= 2800 || (previous && adc > 2400), fault: false };
      assert.deepEqual(actual, expected, `ADC ${adc}, previous ${previous}`);
    }
  }
});

test('EM-CHECK-004: circuit operating-point bounds and fault integration', () => {
  const enabled = operatingPoint(true);
  assert.ok(enabled.currentA > 0.099 && enabled.currentA < 0.100);
  assert.ok(enabled.drainV > 0.004 && enabled.drainV < 0.006);
  assert.ok(enabled.loadW < 1.2 && enabled.loadW > 1.19);
  assert.ok(operatingPoint(false).currentA < 20e-9);
  assert.ok(simulate([3000, 4095])[1].currentA < 20e-9);
  assert.throws(() => operatingPoint(true, { ...CIRCUIT, loadOhm: 0 }));
});
