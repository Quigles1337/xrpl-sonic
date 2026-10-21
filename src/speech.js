// xrpl-sonic — spoken captions through the Web Speech API, when the browser has it.
//
// Speech is independent of the synthesiser's sound: a listener can have one,
// the other, or both. Nothing here is required; every function is a no-op
// where speechSynthesis is missing.

export function speechSupported() {
  return typeof globalThis.speechSynthesis?.speak === 'function' && typeof globalThis.SpeechSynthesisUtterance === 'function';
}

/** Say a line, replacing whatever was still being said. Returns false when speech is unavailable. */
export function speak(text, { rate = 1.05, lang = 'en' } = {}) {
  if (!speechSupported() || typeof text !== 'string' || !text.trim()) return false;
  try {
    globalThis.speechSynthesis.cancel();
    const u = new globalThis.SpeechSynthesisUtterance(text);
    u.rate = rate;
    u.lang = lang;
    globalThis.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

export function hush() {
  if (speechSupported()) {
    try {
      globalThis.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}
