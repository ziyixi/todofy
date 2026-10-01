/**
 * The value rules of Lab's owner API (proto/lab/ui/v1) that the IDL cannot express: sizes and counts the
 * Worker enforces and the UI shows. The UI imports this file (constants only, no code that runs).
 */

/** Cards per deck (the day's top picks). */
export const DECK_SIZE = 20;
/** Decks older than this are no longer offered (their decisions stay). */
export const DECK_OFFER_DAYS = 7;
/** Decision events per deck; more are refused with DECK_LOG_FULL. */
export const DECK_EVENTS_MAX = 400;
/** Characters of one 简介 (2–4 Chinese sentences). */
export const BRIEF_MAX_CHARS = 400;
/** Liked papers per page of ListLikedPapers (the default and the largest page_size). */
export const LIKED_PAGE = 50;
/** Characters of a ListLikedPapers filter. */
export const LIKED_FILTER_MAX = 200;
/** Literals of a ListLikedPapers filter (each one LIKE pattern in D1's query). */
export const LIKED_FILTER_LITERALS_MAX = 8;
/** Seeds at most; ListSeeds answers all of them on one page unless page_size is smaller. */
export const SEEDS_MAX = 50;
/** Characters of one ImportSeeds input. */
export const SEED_INPUT_MAX = 200;
/** arXiv categories in the settings. */
export const CATEGORIES_MAX = 6;
/** The highest `base_version` a deck mutation may send. */
export const DECK_VERSION_MAX = 1_000_000;
/** The UI asks GetSend no more often than this while a send is pending. */
export const SEND_POLL_MIN_SECONDS = 3;
/** Request bodies at most (the transcoder refuses larger ones). */
export const MAX_BODY_BYTES = 16 * 1024;
