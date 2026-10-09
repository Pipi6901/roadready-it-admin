import { collection } from 'firebase/firestore';

import { db } from './firebase';

/**
 * RoadReady ships one country per app build (ADR-013 in the mobile repo) —
 * the admin still models the full multi-country Firestore schema
 * (docs/02-architecture.md §2), but v1's UI only ever operates on GB's draft
 * test-set. Swapping this constant for a country picker is the whole change
 * needed if that ever stops being true.
 */
/**
 * The one country this admin instance edits.
 *
 * One country per deployment, mirroring the app (ADR-013). Changing it here
 * without also pointing Firebase at a different project would have this
 * instance writing Polish content into the British database.
 */
export const PRIMARY_COUNTRY_CODE = requireEnv(
  'NEXT_PUBLIC_COUNTRY_CODE',
  process.env.NEXT_PUBLIC_COUNTRY_CODE,
);

function requireEnv(name: string, value: string | undefined): string {
  // Deliberately no default. An admin that quietly fell back to Poland would
  // publish one country's content over another's, and a publish reaches every
  // installed app within minutes, without a store review to catch it.
  if (!value) throw new Error(`${name} is not set — see .env.local.example`);
  return value;
}
export const DRAFT_TESTSET_ID = 'draft';

export function topicsCollection() {
  return collection(db, 'countries', PRIMARY_COUNTRY_CODE, 'testsets', DRAFT_TESTSET_ID, 'topics');
}

export function questionsCollection(topicId: string) {
  return collection(
    db,
    'countries',
    PRIMARY_COUNTRY_CODE,
    'testsets',
    DRAFT_TESTSET_ID,
    'topics',
    topicId,
    'questions',
  );
}
