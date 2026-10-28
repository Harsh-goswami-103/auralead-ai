/**
 * Where the finder's listings come from (ADR-118 (b)). LIVE results are Google content: "Google
 * Maps" in plain text, the attributions Google returned with the shown places, and the line
 * "Results from Google Maps. Use is subject to the Google Maps Additional Terms of Service and the
 * Google Privacy Policy." with links to both documents. DEMO results are not Google content: the
 * Simulated chip and no Google attribution. Server-safe (no hooks).
 */
import { ModeChip } from '@/components/patterns/StatusBadge';
import type { PlaceAttribution } from '@/server/adapters/places/port';
import { GOOGLE_MAPS_ADDITIONAL_TERMS_URL, GOOGLE_PRIVACY_POLICY_URL } from '@/server/services/lead-finder/schemas';

const LINK = 'font-medium text-fg-1 underline underline-offset-2 hover:text-cyan';

export function PlacesAttribution(props: { simulated: boolean; attributions: readonly PlaceAttribution[] }) {
  if (props.simulated) {
    return (
      <p data-places-attribution="simulated" className="flex flex-wrap items-center gap-2 text-xs text-fg-2">
        <ModeChip simulated />
        <span>Simulated listings from the DEMO directory, built from your keywords and locations. They are not Google content and no business was contacted.</span>
      </p>
    );
  }
  return (
    <div data-places-attribution="google" className="flex flex-col gap-1 text-xs text-fg-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span translate="no" className="font-medium text-fg-1">
          Google Maps
        </span>
        {props.attributions.length > 0 ? (
          <span data-provider-attributions="">
            {'Listing data also from '}
            {props.attributions.map((a, i) => (
              <span key={`${a.provider}|${a.providerUri ?? ''}`}>
                {i > 0 ? ', ' : ''}
                {a.providerUri ? (
                  <a href={a.providerUri} target="_blank" rel="noopener noreferrer nofollow" className={LINK}>
                    {a.provider}
                  </a>
                ) : (
                  a.provider
                )}
              </span>
            ))}
          </span>
        ) : null}
      </p>
      <p data-google-terms="">
        {'Results from Google Maps. Use is subject to the '}
        <a href={GOOGLE_MAPS_ADDITIONAL_TERMS_URL} target="_blank" rel="noopener noreferrer" className={LINK}>
          Google Maps Additional Terms of Service
        </a>
        {' and the '}
        <a href={GOOGLE_PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className={LINK}>
          Google Privacy Policy
        </a>
        .
      </p>
    </div>
  );
}
