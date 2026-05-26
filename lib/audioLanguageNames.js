/**
 * ISO 639-2/B and ISO 639-3 audio language code → readable name mapping.
 * Audio streams typically use 3-letter codes (vs subtitles' 2-letter).
 * Fallback: if no language tag → "Track <N>"; if unknown code → uppercase.
 */

export const AUDIO_LANGUAGE_NAMES = {
  // Common ISO 639-2/B codes
  eng: 'English',
  hin: 'Hindi',
  rus: 'Russian',
  ukr: 'Ukrainian',
  spa: 'Spanish',
  fre: 'French',
  fra: 'French',
  ger: 'German',
  deu: 'German',
  ita: 'Italian',
  por: 'Portuguese',
  jpn: 'Japanese',
  kor: 'Korean',
  chi: 'Chinese',
  zho: 'Chinese',
  ara: 'Arabic',
  tur: 'Turkish',
  pol: 'Polish',
  nld: 'Dutch',
  dut: 'Dutch',
  dan: 'Danish',
  fin: 'Finnish',
  nor: 'Norwegian',
  swe: 'Swedish',
  cze: 'Czech',
  ces: 'Czech',
  gre: 'Greek',
  ell: 'Greek',
  hun: 'Hungarian',
  rum: 'Romanian',
  ron: 'Romanian',
  tha: 'Thai',
  vie: 'Vietnamese',
  ind: 'Indonesian',
  may: 'Malay',
  msa: 'Malay',
  heb: 'Hebrew',
  per: 'Persian',
  fas: 'Persian',
  // ISO 639-3 / 2-letter fallbacks
  en: 'English',
  hi: 'Hindi',
  ru: 'Russian',
  uk: 'Ukrainian',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ar: 'Arabic',
  tr: 'Turkish',
  pl: 'Polish',
  nl: 'Dutch',
  da: 'Danish',
  fi: 'Finnish',
  no: 'Norwegian',
  sv: 'Swedish',
  cs: 'Czech',
  el: 'Greek',
  hu: 'Hungarian',
  ro: 'Romanian',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  ms: 'Malay',
  he: 'Hebrew',
  fa: 'Persian',
};

/**
 * Get readable audio language name from ISO code.
 * @param {string|null} code - ISO 639 code (2 or 3 letter)
 * @param {number} index - Track index for fallback display
 * @returns {string} - Readable name, "Track N", or uppercased unknown code
 */
export function getAudioLanguageName(code, index) {
  if (!code) return `Track ${index + 1}`;
  const lower = code.toLowerCase();
  return AUDIO_LANGUAGE_NAMES[lower] || code.toUpperCase();
}

/**
 * Format channel count as readable string.
 * @param {number} channels - Number of audio channels
 * @returns {string} - "5.1", "2.0", "8ch", etc.
 */
export function formatChannels(channels) {
  if (channels === 6) return '5.1';
  if (channels === 2) return '2.0';
  if (channels === 8) return '7.1';
  if (channels === 1) return 'Mono';
  return `${channels}ch`;
}
