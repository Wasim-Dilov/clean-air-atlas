/**
 * Hourly solar + storage dispatch against a load that a fossil source serves today.
 *
 * Each hour: solar serves the load first; surplus charges the battery (never fossil);
 * the battery discharges into the remaining load; fossil covers whatever is left;
 * solar that neither the load nor the battery can take is curtailed.
 */

export interface Battery {
  powerMW: number; // charge and discharge limit
  energyMWh: number; // nameplate energy
  roundTrip: number; // 0..1, split evenly between charging and discharging
  usableDoD: number; // 0..1, usable fraction of nameplate energy
}

export interface DispatchResult {
  solarToLoad: Float64Array;
  charge: Float64Array; // MWh drawn from solar into the battery (before losses)
  discharge: Float64Array; // MWh delivered to the load (after losses)
  fossil: Float64Array;
  curtailed: Float64Array;
  soc: Float64Array; // MWh stored at the end of each hour
  socMin: number;
  socMax: number;
  totals: {
    load: number;
    solar: number;
    solarToLoad: number;
    discharge: number;
    displaced: number; // fossil MWh avoided = solarToLoad + discharge
    fossil: number;
    curtailed: number;
    cycles: number; // equivalent full cycles of the usable window
  };
}

export function dispatch(load: ArrayLike<number>, solar: ArrayLike<number>, battery: Battery): DispatchResult {
  const n = load.length;
  if (solar.length !== n) throw new Error('load and solar must have the same number of hours');
  const { powerMW, energyMWh } = battery;
  const rte = Math.min(Math.max(battery.roundTrip, 0), 1);
  const dod = Math.min(Math.max(battery.usableDoD, 0), 1);
  const etaIn = Math.sqrt(rte);
  const etaOut = Math.sqrt(rte);
  const socMax = Math.max(energyMWh, 0);
  const socMin = socMax * (1 - dod);
  const hasBattery = powerMW > 0 && socMax > socMin && rte > 0;

  const out = {
    solarToLoad: new Float64Array(n), charge: new Float64Array(n), discharge: new Float64Array(n),
    fossil: new Float64Array(n), curtailed: new Float64Array(n), soc: new Float64Array(n),
  };

  const run = (soc0: number) => {
    let soc = soc0;
    for (let h = 0; h < n; h++) {
      const L = Math.max(load[h], 0);
      const S = Math.max(solar[h], 0);
      const direct = Math.min(S, L);
      let surplus = S - direct;
      let deficit = L - direct;
      let ch = 0;
      let dis = 0;
      if (hasBattery) {
        ch = Math.min(surplus, powerMW, (socMax - soc) / etaIn);
        ch = Math.max(ch, 0);
        soc += ch * etaIn;
        surplus -= ch;
        dis = Math.min(deficit, powerMW, (soc - socMin) * etaOut);
        dis = Math.max(dis, 0);
        soc -= dis / etaOut;
        deficit -= dis;
      }
      out.solarToLoad[h] = direct;
      out.charge[h] = ch;
      out.discharge[h] = dis;
      out.fossil[h] = deficit;
      out.curtailed[h] = surplus;
      out.soc[h] = soc;
    }
    return soc;
  };

  // Two passes so the year starts from the state it ends in (no free initial charge).
  const end = run(socMin);
  run(end);

  const sum = (a: Float64Array) => a.reduce((s, v) => s + v, 0);
  const totals = {
    load: Array.from({ length: n }, (_, h) => Math.max(load[h], 0)).reduce((s, v) => s + v, 0),
    solar: Array.from({ length: n }, (_, h) => Math.max(solar[h], 0)).reduce((s, v) => s + v, 0),
    solarToLoad: sum(out.solarToLoad),
    discharge: sum(out.discharge),
    displaced: 0,
    fossil: sum(out.fossil),
    curtailed: sum(out.curtailed),
    cycles: 0,
  };
  totals.displaced = totals.solarToLoad + totals.discharge;
  totals.cycles = socMax > socMin ? totals.discharge / etaOut / (socMax - socMin) : 0;
  return { ...out, socMin, socMax, totals };
}
