// Probe prompts (ONP-3 §4a). Every chat request the registry sends to a node, in Stages A, B and C,
// takes its text from a corpus, so a node cannot tell a probe from a customer's request by its words.
// A production registry keeps its corpus private: a JSON file outside the public source, named by
// ONP_PROBE_CORPUS. Without one the registry falls back to the small built-in corpus below, which is
// public and therefore fit only for development and tests; /v0/health says which one is in use.
//
// File format (every list is an array of non-empty strings, except `needles`):
//   {
//     "chat":     ["short, ordinary requests"],         // Stage A, the capacity ramp, Stage C blind probes (5 or more)
//     "identity": ["prompts for identity references"],  // optional, defaults to chat
//     "filler":   ["long passages of plain prose"],     // the context probes' haystack
//     "needles":  [{"fact": "… {n} …", "question": "…"}] // the fact hidden in the haystack ({n}: an 8-digit number)
//   }
// One request is not a probe and takes no corpus text: the origin comparison behind a CDN
// (location.js checkOrigins, ONP-3 §6.4) announces itself, so it asks originPrompt() below instead.
// Identity prompts must read like the chat prompts (same kind of request, length and tone), or be
// left out so that references are captured from chat prompts: Stage C asks some of them in blind
// probes (stagec.js), which only work if a node cannot pick them out from the ordinary ones.
import { readFileSync } from 'node:fs';

/**
 * Identity prompts of registries before revision 11. They were public, so a reference captured
 * with them proves nothing: Stage B ignores such references. Kept only to recognise them.
 */
export const LEGACY_IDENTITY_PROMPTS = Object.freeze([
  'ONP identity probe 1: repeat exactly: correlation-4417',
  'ONP identity probe 2: repeat exactly: meridian-9022',
  'ONP identity probe 3: repeat exactly: basalt-7301',
]);

/** How many identity references a capture stores, and how many of them one Stage B run asks. */
export const IDENTITY_CAPTURE = 8;
export const IDENTITY_SAMPLE = 3;

/**
 * Prompts for the origin comparison behind a CDN (ONP-3 §6.4). It is labelled and an operator can set
 * it off at will (a card that changes its origin addresses is checked at once), so it must never ask
 * corpus text: that would show the operator the identity references or the blind probes. These are
 * public on purpose, and each carries a random number, so that no reply can be prepared in advance.
 */
export const ORIGIN_PROMPT_TEMPLATES = Object.freeze([
  'Write one sentence about the number {n}.',
  'Invent a short name for a shop at number {n} on a high street.',
  'Describe the number {n} in a few words.',
  'Write a short line of a poem that mentions the number {n}.',
  'Say something interesting about the number {n}, in one sentence.',
]);

/** One origin-comparison prompt: a template with a random six-digit number. */
export function originPrompt(random = Math.random) {
  const template = ORIGIN_PROMPT_TEMPLATES[Math.floor(random() * ORIGIN_PROMPT_TEMPLATES.length)];
  return template.replace('{n}', String(100_000 + Math.floor(random() * 900_000)));
}

const DEFAULT_NEEDLE = Object.freeze({
  fact: 'The magic number is {n}.',
  question: 'What is the magic number mentioned in the text above? Reply with the number only.',
});

/** Development corpus. Public, so nothing in it ever counts as private. */
export const BUILTIN_CORPUS = Object.freeze({
  chat: Object.freeze([
    'What is the capital of Portugal?',
    'Give me three name ideas for a small neighbourhood bakery.',
    'Translate "good morning, how are you?" into German.',
    'Write one sentence describing an autumn afternoon.',
    'Convert 25 degrees Celsius to Fahrenheit.',
    'Suggest a short subject line for an email about a rescheduled meeting.',
    'List two benefits of stretching before a run.',
    'Explain what a prime number is in one sentence.',
    'Rewrite this more politely: send me the report now.',
    'What does HTTP stand for?',
    'Give a one-line tip for writing clear commit messages.',
    'Which is larger, a kilobyte or a megabyte?',
    'Name a vegetable that grows well in cold weather.',
    'What is a haiku? Answer briefly.',
    'Summarise in a few words: the library is open late during exam week.',
    'How many minutes are there in three hours?',
  ]),
  identity: Object.freeze([
    'Spell the word "necessary" backwards.',
    'List the first five prime numbers, separated by commas.',
    'What is 17 multiplied by 23? Answer with the number only.',
    'Name the planets of the solar system in order from the Sun.',
    'Write the letters of the alphabet from F to M.',
    'Give the plural of "cactus" and of "mouse".',
    'Which month comes two months after October?',
    'Complete the sequence: 2, 4, 8, 16, ...',
    'Name three primary colours.',
    'What is the chemical symbol for gold?',
  ]),
  filler: Object.freeze([
    'The town council met on Tuesday evening to discuss the new cycle lanes along the river road. '
      + 'Residents raised questions about parking, delivery vans and the timing of the works, and the '
      + 'engineers promised a second round of drawings before the summer. ',
    'In the old orchard behind the school the apple trees are pruned every February. The children help '
      + 'gather the cut branches, which are dried and burned in the autumn bonfire, and the best fruit '
      + 'goes to the harvest market in the square. ',
    'A good loaf needs flour, water, salt and time. Bakers who let the dough rise slowly overnight say '
      + 'the crust is darker and the crumb more open, while quicker methods give a softer bread that keeps '
      + 'for fewer days. ',
    'The ferry leaves the harbour at half past seven and calls at two islands before turning back. On '
      + 'calm days passengers sit on the upper deck, and in winter the café below serves soup and tea to '
      + 'the few commuters who make the crossing. ',
  ]),
  needles: Object.freeze([DEFAULT_NEEDLE]),
});

const strings = (value, name, { min = 1 } = {}) => {
  if (!Array.isArray(value) || value.length < min || !value.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 20_000)) {
    throw new Error(`probe corpus: "${name}" must be a list of at least ${min} non-empty strings`);
  }
  return Object.freeze([...value]);
};

const needlesOf = (value) => {
  if (!Array.isArray(value) || !value.length || !value.every((n) => typeof n?.fact === 'string' && n.fact.includes('{n}') && typeof n?.question === 'string' && n.question.trim())) {
    throw new Error('probe corpus: "needles" must be a list of {fact, question} with "{n}" in each fact');
  }
  return Object.freeze(value.map((n) => Object.freeze({ fact: n.fact, question: n.question })));
};

const pickFrom = (list, random) => list[Math.floor(random() * list.length)];

/** k distinct items of `list` in random order (all of them when k >= list.length). */
export function sample(list, k, random = Math.random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.max(0, k));
}

/**
 * The registry's probe corpus. `source`: null (built-in), a path to a JSON file, or an object in
 * the file format. A file that cannot be read or parsed is an error: a registry configured for a
 * private corpus must never fall back to the public one silently.
 */
export function loadCorpus(source = null, { random = Math.random } = {}) {
  let raw = null, origin = 'built-in';
  if (typeof source === 'string' && source) {
    raw = JSON.parse(readFileSync(source, 'utf8'));
    origin = 'file';
  } else if (source && typeof source === 'object') {
    raw = source;
    origin = 'inline';
  }
  const isPrivate = raw !== null;
  const base = raw ?? BUILTIN_CORPUS;
  // A private corpus brings everything: a public haystack or needle question would give the
  // context probes away even if every short prompt were private.
  const chat = strings(base.chat, 'chat', { min: isPrivate ? 5 : 1 });
  const identity = base.identity == null ? chat : strings(base.identity, 'identity');
  const filler = strings(base.filler, 'filler');
  const needles = needlesOf(base.needles);
  const builtinPrompts = new Set([...BUILTIN_CORPUS.chat, ...BUILTIN_CORPUS.identity]);
  const legacy = new Set(LEGACY_IDENTITY_PROMPTS);

  return Object.freeze({
    private: isPrivate,
    origin,
    chat, identity, filler, needles,
    /** One ordinary request for Stage A, the capacity ramp or a blind probe. */
    chatPrompt: () => pickFrom(chat, random),
    /** Prompts for a reference capture. */
    identityPrompts: (k = IDENTITY_CAPTURE) => sample(identity, k, random),
    needle: () => pickFrom(needles, random),
    /** A prompt for the origin comparison: never corpus text (originPrompt above). */
    originPrompt: () => originPrompt(random),
    /** `chars` characters of haystack, from the filler passages in random order. */
    haystack(chars) {
      const n = Math.max(0, Math.floor(chars));
      let out = '';
      while (out.length < n) out += sample(filler, filler.length, random).join('');
      return out.slice(0, n);
    },
    /**
     * Whether a stored reference may vouch for identity: never one captured with a legacy public
     * prompt, and, once the corpus is private, never one captured with a built-in prompt.
     */
    usableReference: (prompt) => !legacy.has(prompt) && !(isPrivate && builtinPrompts.has(prompt)),
    /** What /v0/health publishes: whether the corpus is private and its size, never its contents. */
    summary: () => ({
      private: isPrivate,
      prompts: { chat: chat.length, identity: identity.length, filler: filler.length, needles: needles.length },
      ...(isPrivate ? {} : { note: 'built-in development corpus: public, so nodes can recognise its probes' }),
    }),
  });
}
