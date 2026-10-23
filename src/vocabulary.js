// xrpl-sonic — the project's terms, one sentence each, at the point of use.
//
// Every sentence here is taken from the documents named beside it (the
// README or a file under docs/), cut where a control needs it shorter and
// never reworded; docs/ux.md carries the same table, and a test checks that
// each sentence appears there verbatim. The page shows the sentence under
// the group header or beside the control that bears the term, and names it
// to screen readers with aria-describedby.
//
// Pure: no DOM.

export const TERMS = Object.freeze({
  moment: { sentence: 'Something catches your ear, live or in replay: Moment (or S) saves the selection and your observation as a case file and copies its link, without stopping playback.', source: 'README, "Save this moment"; docs/save-this-moment.md' },
  case: { sentence: 'A case is a small JSON file that describes a listening: the network, one or more ledger windows (clips), the cast, the filters and mapping, the speed, and annotations anchored to a transaction, a ledger or a position on the timeline.', source: 'README, "Cases"; docs/case-format.md' },
  cast: { sentence: 'The cast is up to five accounts to follow; each gets a voice of its own, a place in the stereo field, a colour and a label, so the same participant sounds and looks the same every time it acts.', source: 'README, "Follow a cast"' },
  outsideTheCast: { sentence: 'Transactions that involve nobody in the cast are played in their category voice (Play everything), drawn dimmed and silent (Mute others) or not drawn at all (Hide others).', source: 'README, "Follow a cast"' },
  clip: { sentence: 'A clip is one ledger window of a case; a case with two or more gets A, B, … buttons that play each on a loop, and the silence between clips is announced on the tape, in the captions and on the plate.', source: 'docs/case-format.md, clips; README, "Compare two windows"' },
  transcript: { sentence: 'The transcript is a text version of the whole score with every ledger, gap, event and annotation at its time.', source: 'README, "Cases"' },
  geiger: { sentence: 'The Geiger is a detector: for every validated ledger it measures a few plain things before any filter or rate limiting, compares each with a baseline formed from the previous ledgers, and reports a crossing with the numbers that produced it.', source: 'README, "Geiger mode"' },
  coherence: { sentence: 'Coherence reads a relation between accounts from when they act: for every pair, the peak cross-correlation of their transactions per ledger, prewhitened and raw, each with its null, the number of pairs tested, and the record check; everything is tier observation: a correlation at a lag is what the series show, and the readout says so.', source: 'README, "Coherence"; docs/coherence.md' },
  field: { sentence: "The field draws what the readout says: interference between the cast members' sigils for the pairs whose prewhitened percentile clears the 95th, and for no other pair.", source: 'README, "Coherence" (the field paragraph)' },
  blind: { sentence: 'Blind comparison keeps the plate and the sound but hides ledger numbers, the tape, the notes and the captions, so the comparison is made by ear and the labels are revealed only afterwards.', source: 'README, "Compare two windows"' },
  pauseAtNotes: { sentence: 'Pause at annotations honours notes that ask the transport to pause when they are reached.', source: 'README, "Compare two windows"; docs/case-format.md, annotations[].pause' },
  captions: { sentence: 'Captions show annotations, gaps and cast events as text.', source: 'README, "Compare two windows"' },
  speak: { sentence: "Speak annotations reads each note aloud through the browser's speech synthesis, independent of the instrument's sound.", source: 'README, "Compare two windows"' },
  notes: { sentence: "A case's annotations are edited in place: Note here adds one at the current position, Annotate in the inspector anchors one to that transaction, and each note can be edited or deleted.", source: 'README, "Cases" (Notes)' },
  copyForAi: { sentence: 'Copy for AI turns the loaded case into text an assistant can work from without the page; the size and the events-shown ratio are shown before copying.', source: 'README, "Copy for AI"; docs/copy-for-ai.md' },
  importNotes: { sentence: "An assistant's answer, a JSON array of annotations, is pasted into Import notes and lands as drafts at its anchors, with what was accepted and rejected and why.", source: 'README, "Copy for AI"' },
  longExposure: { sentence: 'Long exposure keeps a fading trace of where every track landed on the plate, so a column forms under an account that keeps acting at one pitch.', source: 'README, "Geiger mode" (last paragraph)' },
  feePressure: { sentence: 'Observed fee pressure asks the connected node, after each ledger close, for its fee report; it describes the node you are connected to, not one network-wide state.', source: 'README, "Observed fee pressure"' },
  midi: { sentence: 'Save MIDI file writes the score of the loaded case as a Standard MIDI File; Live output sends the same notes as they play to an instrument through the Web MIDI API.', source: 'README, "MIDI"' },
  capture: { sentence: 'Snapshot composes the scene with a small stats box and downloads it as a PNG; Record 30 s captures the canvas together with the audio mix.', source: 'README, "Snapshot and recording"' },
  quietMode: { sentence: 'Quiet mode keeps only transactions at or above a chosen XRP amount.', source: 'README, "Staying musical when the ledger is busy"' },
  transactionTypes: { sentence: 'The same glyphs appear as the legend tiles, on the start screen and beside every line of the tape, so shape, colour and sound are learned together.', source: 'README, "The plate"' },
  share: { sentence: 'Share copies a permalink to the ledger currently playing together with the network and the cast, so a moment you heard can be sent to someone else.', source: 'README, "Replay a ledger, with a permalink"' },
  session: { sentence: 'The Session panel shows how many events were played versus rate-limited.', source: 'README, "Staying musical when the ledger is busy"' },
  sound: { sentence: 'Only validated, successful transactions sound by default; there is a toggle for failed ones. Eight scales (major and minor pentatonic, major, Dorian, Lydian, blues, Hirajoshi, whole tone) and twelve keys are available.', source: 'README, "Sound mapping"' },
  stream: { sentence: 'Your browser connects directly to a public XRPL node over WebSocket. Nothing is sent anywhere else.', source: 'the start screen; README, "Privacy"' },
});

/** The sentence for a term, or '' for a term this table does not have. */
export function termSentence(key) {
  return TERMS[key]?.sentence ?? '';
}

/** The reasons guarded controls give (docs/ux.md, "Empty and guarded states"). */
export const REASONS = Object.freeze({
  needsCase: 'Needs a loaded case: press Moment while listening, open the sample case, load a file, or open a #replay= link.',
  needsScore: 'Needs a case with its ledgers fetched: press Start.',
  castFull: 'A cast has at most 5 members: remove one (×) first.',
  pairNeedsTwo: 'One chosen pair needs two cast members.',
  loading: 'Loading the case…',
  cannotRecord: 'Recording needs MediaRecorder and canvas.captureStream, which this browser does not provide; Snapshot still works.',
});

/** The ways to get a case, easiest first (README: "Save this moment", "Cases", "Replay a ledger"; docs/save-this-moment.md: the explorer handoff). */
export const WAYS_TO_A_CASE = Object.freeze([
  'Press Moment (or S) while listening: what is playing is saved as a case.',
  'Open the sample case: two real accounts over three mainnet ledgers.',
  'Load a .sonic-case.json file.',
  'Open a #replay=<ledger> or #case= link.',
  'From the explorer, choose Open as moment in the listener on a transaction.',
]);
