export const DEFAULT_CALIBRATION = Object.freeze({
  adcMax: 4095, referenceV: 3.3, onThreshold: 2800, offThreshold: 2400,
  faultLow: 30, faultHigh: 4065,
});
export const CIRCUIT = Object.freeze({ supplyV: 12, loadOhm: 120, onOhm: 0.05, offOhm: 1e9 });

export function controllerStep(adc, previousOn = false, calibration = DEFAULT_CALIBRATION) {
  if (!calibration || typeof calibration !== 'object') return { on: false, fault: true };
  const { adcMax, referenceV, onThreshold, offThreshold, faultLow, faultHigh } = calibration;
  const values = [adcMax, onThreshold, offThreshold, faultLow, faultHigh];
  const valid = values.every(Number.isInteger) && adcMax === 4095 && referenceV > 0 && Number.isFinite(referenceV)
    && 0 <= faultLow && faultLow < offThreshold && offThreshold < onThreshold
    && onThreshold < faultHigh && faultHigh <= adcMax;
  const fault = !valid || typeof previousOn !== 'boolean' || !Number.isInteger(adc)
    || adc < 0 || adc > adcMax || adc <= faultLow || adc >= faultHigh;
  if (fault) return { on: false, fault: true };
  return { on: adc >= onThreshold ? true : adc <= offThreshold ? false : previousOn, fault: false };
}

export function operatingPoint(on, circuit = CIRCUIT) {
  if (typeof on !== 'boolean' || !circuit ||
      !['supplyV', 'loadOhm', 'onOhm', 'offOhm'].every(key => Number.isFinite(circuit[key]) && circuit[key] > 0)) {
    throw new RangeError('Circuit requires a Boolean switch state and positive finite parameters.');
  }
  const switchOhm = on ? circuit.onOhm : circuit.offOhm;
  const currentA = circuit.supplyV / (circuit.loadOhm + switchOhm);
  return { currentA, drainV: currentA * switchOhm,
    loadW: currentA ** 2 * circuit.loadOhm, switchW: currentA ** 2 * switchOhm };
}

export function simulate(readings, calibration = DEFAULT_CALIBRATION) {
  let on = false;
  return readings.map(adc => {
    const state = controllerStep(adc, on, calibration);
    on = state.on;
    return { adc, ...state, ...operatingPoint(on) };
  });
}
