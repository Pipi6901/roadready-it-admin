/** Mirrors the Firestore schema in roadready's docs/02-architecture.md §2. */

export type Role = 'content_editor' | 'admin';

export interface AdminUser {
  email: string;
  role: Role;
  invitedAt: string;
}

export type CountryStatus = 'active' | 'coming_soon' | 'archived';

export interface Country {
  code: string;
  name: string;
  flagEmoji: string;
  authority: string;
  legalNotice: string;
  testTypes: string[];
  status: CountryStatus;
  questionCount: number;
  mockTest: { questionCount: number; timeLimitMinutes: number; passMark: number };
  currency: string;
  defaultLocale: string;
  sortOrder: number;
  deletedAt: string | null;
}

export type TestSetStatus = 'draft' | 'published' | 'archived';

export interface TestSet {
  version: string;
  status: TestSetStatus;
  effectiveFrom: string | null;
  archivedAt: string | null;
  versionHash: string | null;
  bundleUrl: string | null;
  bundleSize: number | null;
  publishedAt: string | null;
  publishedBy: string | null;
  deletedAt: string | null;
}

/**
 * Exam class, for the countries that have one. Poland splits its paper into
 * basic (TAK/NIE) and specialist (A/B/C) questions and draws a fixed number
 * of each; Italy asks one kind of question — 30 VERO/FALSO statements — so
 * nothing here sets it and the field stays absent throughout the Italian
 * bank. Kept in the shared schema, not deleted, so the two admins read the
 * same Firestore documents.
 */
export type QuestionCategory = 'basic' | 'specialist';

export interface Topic {
  name: string;
  slug: string;
  icon: string;
  sortOrder: number;
  color: string | null;
  category?: QuestionCategory;
  deletedAt: string | null;
}

export type QuestionType = 'single_choice' | 'case_study' | 'hazard_video';

export interface AnswerOption {
  id: string;
  text: string;
}

export interface Question {
  type: QuestionType;
  text: string;
  options: AnswerOption[];
  correctOptionId: string;
  explanation: string;
  mediaId: string | null;
  subtopic: string | null;
  sourceRef: string;
  /**
   * 1, 2 or 3. Poland scores its paper in points and draws a fixed number of
   * each weight. Italy counts errors instead — 30 statements, at most 3 wrong
   * — so every Italian statement is worth 1 and the mobile app treats a
   * missing value as 1 anyway.
   */
  points?: number;
  /** Normally inherited from the topic; stored so a question can be read alone. */
  category?: QuestionCategory;
  /**
   * Licence categories the question is asked for — the ministry's codes. Every
   * statement in the A/B listato carries the same seven (AM, A1, A2, A, B1, B,
   * BE), because that is what the listato is for; the categories above B come
   * from a separate listato that is not imported. Empty or missing means every
   * category. The app filters its whole bank by the learner's chosen licence.
   */
  licences?: string[];
  /**
   * File name of the figure the listato attaches to this statement — an md5 of
   * the image bytes (e.g. "5a226c55de66377f9dae0a004c51f57f.jpeg"), so one
   * sign drawn once is one file. Read-only here: it is what the media import
   * matches against.
   */
  sourceMedia?: string | null;
  sortOrder: number;
  deletedAt: string | null;
}

/** All licence codes in the order the catalogue and the app list them. */
export const LICENCE_CODES = ['AM', 'A1', 'A2', 'A', 'B1', 'B', 'BE'] as const;

export interface Locale {
  code: string;
  nameNative: string;
  nameEnglish: string;
  direction: 'ltr' | 'rtl';
  flagEmoji: string;
  status: 'active' | 'hidden';
  sortOrder: number;
}

export interface Media {
  type: 'image' | 'video';
  filename: string;
  storagePath: string;
  cdnUrl: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Size on Storage, set by scripts/import-media.js; the app sums these for the offline pack. */
  bytes?: number;
  hazardWindow: { startMs: number; endMs: number } | null;
  usedByQuestions: string[];
  /**
   * 'ministero-it': figures out of the ministry's own listato, imported by
   * scripts/import-media.js. They are an official act of the State, which
   * art. 5 of L. 633/1941 puts outside copyright — but the field still
   * records where a file came from, because 'own' files do not have that.
   */
  licence: 'ministero-it' | 'own';
  /** File name in the listato, for imported media (matches Question.sourceMedia). */
  sourceName?: string;
  deletedAt: string | null;
}
