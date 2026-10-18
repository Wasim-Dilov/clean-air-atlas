export const HOURS = 8760;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Expand 12 typical days (24 values each) into a 365-day hourly year. */
export function expandMonthlyDays(monthly: number[][]): Float64Array {
  if (monthly.length !== 12 || monthly.some((d) => d.length !== 24)) throw new Error('need 12 x 24 values');
  const out = new Float64Array(HOURS);
  let h = 0;
  DAYS_IN_MONTH.forEach((days, m) => {
    for (let d = 0; d < days; d++) for (let i = 0; i < 24; i++) out[h++] = monthly[m][i];
  });
  return out;
}

/** Solar output in MW for an installed size in MWp, from a W-per-kWp profile. */
export function solarMW(wPerKWp: ArrayLike<number>, mwp: number): Float64Array {
  const out = new Float64Array(wPerKWp.length);
  for (let i = 0; i < out.length; i++) out[i] = (wPerKWp[i] / 1000) * mwp; // W/kWp = kW/MWp; /1000 -> MW/MWp
  return out;
}

/** A constant load during a daily window [startHour, endHour) in local time, in MW. */
export function windowLoad(mw: number, startHour: number, endHour: number): Float64Array {
  const out = new Float64Array(HOURS);
  for (let h = 0; h < HOURS; h++) {
    const hod = h % 24;
    const on = startHour <= endHour ? hod >= startHour && hod < endHour : hod >= startHour || hod < endHour;
    out[h] = on ? mw : 0;
  }
  return out;
}
