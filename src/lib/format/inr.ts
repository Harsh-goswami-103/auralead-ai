/**
 * `₹1,23,456.00` formatting for paise amounts (plan §8). The bigint is converted to an exact
 * decimal string and handed to Intl as a string, so precision is never lost to floats.
 * Money formatting has no time component, so it is host time zone independent by construction.
 */
const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Exact `"-1234.05"` style rupee string for a paise amount. */
export function paiseToRupeeString(paise: bigint): string {
  if (typeof paise !== 'bigint') throw new TypeError('paise must be a bigint');
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const rupees = abs / 100n;
  const rest = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${rupees.toString()}.${rest}`;
}

export function formatINR(paise: bigint): string {
  return INR.format(paiseToRupeeString(paise) as Intl.StringNumericLiteral);
}
