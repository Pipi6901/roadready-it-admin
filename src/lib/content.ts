import { collection } from 'firebase/firestore';

import { db } from './firebase';

/**
 * The one country this admin instance edits.
 *
 * One admin per country, mirroring the app's one country per build
 * (ADR-013): this instance is the Italian one, the Polish and British banks
 * are edited from their own deployments against their own Firebase projects.
 * The Firestore schema is the shared multi-country one
 * (docs/02-architecture.md §2), so what separates them is this constant plus
 * .firebaserc — changing one without the other would have this instance
 * writing Italian content into another country's database.
 */
export const PRIMARY_COUNTRY_CODE = 'IT';
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
