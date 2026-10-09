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
export const PRIMARY_COUNTRY_CODE = 'PL';
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
