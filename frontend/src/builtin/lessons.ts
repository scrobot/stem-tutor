/**
 * Built-in lessons: chords and warm-ups for one hand on a 25-key mini keyboard at OCT 0
 * (keys 48–72). Each lesson becomes an ordinary Lesson in memory — every exercise is a part —
 * so the same trainer (listen / learn / play, scoring, MIDI export) works on it.
 */
import { beatTime, uniformGrid } from '../music/grid'
import type { Grid, Lesson, Note, Part } from '../types'

export type Rhythm = 'whole' | 'half' | 'quarters' | 'eighths' | 'tresillo' | 'arpUpDown'

export interface ChordStep {
  chord: string // the name shown, e.g. "Am"
  notes: number[] // a one-hand voicing (MIDI notes) that fits the keys at OCT 0
}

export interface LineNote {
  p: number // MIDI note
  d: number // beats
  f: number // finger, 1 = thumb … 5 = little finger
}

export interface Exercise {
  id: string
  title: string
  goal: string
  /** A chord exercise: one chord per bar, played in `rhythm`. */
  steps?: ChordStep[]
  rhythm?: Rhythm
  /** A single-note exercise (warm-ups, motifs). */
  line?: LineNote[]
  /** How many times the steps / the line are written out (default 2). */
  repeat?: number
  /** A long last note after a line, so the phrase ends at home. */
  end?: LineNote
}

export interface BuiltinLesson {
  id: string
  group: 'chords' | 'hand'
  title: string
  summary: string
  intro: string[]
  bpm: number
  exercises: Exercise[]
}

export interface ChordMark {
  start: number // beats
  end: number
  name: string
}

export interface ExerciseInfo {
  exercise: Exercise
  chords: ChordMark[]
  /** Finger for each note of the part (by its index in part.notes). */
  fingers: Map<number, number>
}

export interface BuiltLesson {
  def: BuiltinLesson
  lesson: Lesson
  info: Map<string, ExerciseInfo>
}

// -- voicings (one hand, near the middle of the keys at OCT 0) ------------------------------
const V = {
  C: [60, 64, 67],
  F: [60, 65, 69], // F with C at the bottom: the thumb stays on C
  G: [59, 62, 67], // G with B at the bottom
  Am: [57, 60, 64],
  AmHigh: [60, 64, 69], // Am with C at the bottom
  Dm: [57, 62, 65], // Dm with A at the bottom
  Em: [59, 64, 67], // Em with B at the bottom
  Cm: [60, 63, 67],
  A: [57, 61, 64],
  E: [56, 59, 64], // E with G# at the bottom
  FLow: [57, 60, 65], // F with A at the bottom
  CLow: [55, 60, 64], // C with G at the bottom
  GLow: [55, 59, 62],
  Cmaj7: [60, 64, 67, 71],
  Am7: [57, 60, 64, 67],
  Fmaj7: [60, 64, 65, 69], // with C at the bottom
  Em7: [59, 62, 64, 67], // with B at the bottom
  A5: [57, 64],
  D5: [50, 57],
  E5: [52, 59],
  Asus2: [57, 59, 64],
  Asus4: [57, 62, 64],
  Ab: [60, 63, 68], // Ab with C at the bottom
  Fm: [60, 65, 68], // Fm with C at the bottom
}

const step = (chord: string, notes: number[]): ChordStep => ({ chord, notes })
const POP = [step('C', V.C), step('G', V.G), step('Am', V.AmHigh), step('F', V.F)]
const line = (ps: number[], fs: number[], d = 1): LineNote[] => ps.map((p, i) => ({ p, d, f: fs[i] }))

export const BUILTIN_LESSONS: BuiltinLesson[] = [
  {
    id: 'chords-first',
    group: 'chords',
    title: 'Первый аккорд: C',
    summary: 'Что такое аккорд и как взять его одной рукой.',
    intro: [
      'Аккорд — это несколько клавиш, нажатых одновременно. Простой рецепт: нажмите белую клавишу, пропустите одну белую, нажмите следующую и ещё через одну — третью. Получится аккорд из трёх нот.',
      'Начнём с аккорда C (до мажор): белые клавиши C, E и G. C — белая клавиша слева от пары чёрных. Пальцы правой руки: 1 (большой) — на C, 3 (средний) — на E, 5 (мизинец) — на G.',
      'Нажимайте три клавиши вместе и держите, пока нота на экране не закончится. В режиме «Разучить» программа подождёт: клавиши можно нажимать по одной, но не отпускайте уже нажатые — аккорд засчитается, когда зажаты все три.',
    ],
    bpm: 70,
    exercises: [
      { id: 'hold', title: 'Держим C', goal: 'Нажать три клавиши разом и держать весь такт.', steps: [step('C', V.C)], rhythm: 'whole', repeat: 4 },
      { id: 'pulse', title: 'C на каждый счёт', goal: 'Нажимать аккорд на «раз-два-три-четыре», каждый раз отпуская.', steps: [step('C', V.C)], rhythm: 'quarters', repeat: 4 },
      { id: 'halves', title: 'C дважды за такт', goal: 'Ровно отпускать и снова нажимать — на «раз» и на «три».', steps: [step('C', V.C)], rhythm: 'half', repeat: 4 },
    ],
  },
  {
    id: 'chords-three',
    group: 'chords',
    title: 'Три главных аккорда: C, F, G',
    summary: 'На них держится огромное число песен.',
    intro: [
      'Почти любую простую песню можно сыграть тремя аккордами: C, F и G.',
      'Чтобы рука не прыгала, F и G берём в удобной форме: F — это C-F-A, G — это B-D-G. Ноты те же, просто часть из них переставлена поближе. Большой палец почти не сдвигается: C → C → B.',
      'Сначала пройдите аккорды по шагам, потом — по кругу в темпе.',
    ],
    bpm: 72,
    exercises: [
      { id: 'cfcg', title: 'C → F → C → G', goal: 'Переходить между аккордами без пауз.', steps: [step('C', V.C), step('F', V.F), step('C', V.C), step('G', V.G)], rhythm: 'whole' },
      { id: 'cfcg-pulse', title: 'То же — на каждый счёт', goal: 'Сменить аккорд точно на «раз» следующего такта.', steps: [step('C', V.C), step('F', V.F), step('C', V.C), step('G', V.G)], rhythm: 'quarters' },
      { id: 'gc', title: 'G → C: возвращение домой', goal: 'Услышать, как G «просится» обратно в C.', steps: [step('G', V.G), step('C', V.C), step('G', V.G), step('C', V.C)], rhythm: 'half' },
    ],
  },
  {
    id: 'chords-minor',
    group: 'chords',
    title: 'Грустные аккорды: Am, Dm, Em',
    summary: 'Минор — для задумчивых и тёмных подложек.',
    intro: [
      'Аккорды с буквой m — минорные. Они звучат грустно, задумчиво или мрачно — то, что нужно для атмосферных подложек.',
      'Am — это A-C-E, Dm — A-D-F, Em — B-E-G. Все на белых клавишах и рядом: между Am и Dm большой палец стоит на A, а к Em и обратно вся рука сдвигается на одну белую клавишу.',
    ],
    bpm: 70,
    exercises: [
      { id: 'am-dm', title: 'Am → Dm → Am → Em', goal: 'Привыкнуть к минорным аккордам и их смене.', steps: [step('Am', V.Am), step('Dm', V.Dm), step('Am', V.Am), step('Em', V.Em)], rhythm: 'whole' },
      { id: 'am-em', title: 'Am → Em → Dm → Am на каждый счёт', goal: 'Держать ровный пульс в миноре.', steps: [step('Am', V.Am), step('Em', V.Em), step('Dm', V.Dm), step('Am', V.Am)], rhythm: 'quarters' },
    ],
  },
  {
    id: 'chords-majmin',
    group: 'chords',
    title: 'Мажор и минор: одна клавиша',
    summary: 'Как одной клавишей сделать светлый аккорд грустным.',
    intro: [
      'Разница между светлым мажором и грустным минором — одна клавиша посередине.',
      'Возьмите C (C-E-G) и сдвиньте средний палец на одну клавишу влево — на чёрную Eb. Получится Cm. С A то же самое: A-C#-E — мажор, A-C-E — минор (Am).',
      'Слушайте, как меняется настроение от одного движения пальца.',
    ],
    bpm: 70,
    exercises: [
      { id: 'c-cm', title: 'C ↔ Cm', goal: 'Сдвигать только средний палец.', steps: [step('C', V.C), step('Cm', V.Cm), step('C', V.C), step('Cm', V.Cm)], rhythm: 'whole' },
      { id: 'a-am', title: 'A ↔ Am', goal: 'То же от другой ноты: средний палец с чёрной на белую.', steps: [step('A', V.A), step('Am', V.Am), step('A', V.A), step('Am', V.Am)], rhythm: 'half' },
    ],
  },
  {
    id: 'chords-pop',
    group: 'chords',
    title: 'Популярный круг: C – G – Am – F',
    summary: 'Четыре аккорда сотен хитов — без прыжков рукой.',
    intro: [
      'Эти четыре аккорда звучат в огромном числе песен. Повторите их по кругу — и получится готовая основа трека.',
      'Берите их так, чтобы рука стояла на месте: C (C-E-G), G (B-D-G), Am (C-E-A), F (C-F-A). Большой палец почти всё время на C, а при смене аккорда каждая клавиша сдвигается не дальше соседней.',
    ],
    bpm: 76,
    exercises: [
      { id: 'pop-whole', title: 'По аккорду на такт', goal: 'Выучить круг и смены без пауз.', steps: POP, rhythm: 'whole' },
      { id: 'pop-quarters', title: 'На каждый счёт', goal: 'Ровный пульс и смена точно на «раз».', steps: POP, rhythm: 'quarters' },
      { id: 'pop-eighths', title: 'Восьмыми — как ритм-партия', goal: 'Лёгкие быстрые нажатия: «раз-и-два-и».', steps: POP, rhythm: 'eighths' },
    ],
  },
  {
    id: 'chords-dark',
    group: 'chords',
    title: 'Мрачный круг: Am – F – C – G',
    summary: 'Те же аккорды, но от минора — тревожно и задумчиво.',
    intro: [
      'Начните круг с Am — и он зазвучит тревожно и задумчиво. Такая гармония хорошо ложится под тёмные и атмосферные ролики.',
      'Рука снова почти на месте: Am (A-C-E), F (A-C-F), C (G-C-E), G (G-B-D). Играйте медленно и держите аккорды полностью — пусть звучат.',
    ],
    bpm: 66,
    exercises: [
      { id: 'dark-whole', title: 'Длинные аккорды', goal: 'Держать каждый аккорд весь такт.', steps: [step('Am', V.Am), step('F', V.FLow), step('C', V.CLow), step('G', V.GLow)], rhythm: 'whole' },
      { id: 'dark-half', title: 'Два удара на такт', goal: 'Спокойный пульс под подложку.', steps: [step('Am', V.Am), step('F', V.FLow), step('C', V.CLow), step('G', V.GLow)], rhythm: 'half' },
    ],
  },
  {
    id: 'chords-tension',
    group: 'chords',
    title: 'Напряжение: Am – Dm – E',
    summary: 'Саспенс одной чёрной клавишей.',
    intro: [
      'Аккорд E (E-G#-B) с чёрной клавишей G# звучит напряжённо и «тянет» обратно к Am. Так строят саспенс: Am → Dm → E → Am.',
      'E берите как G#-B-E: большой палец на чёрной G#, остальные на белых.',
    ],
    bpm: 68,
    exercises: [
      { id: 'tension-whole', title: 'Am → Dm → E → Am', goal: 'Услышать напряжение E и разрешение в Am.', steps: [step('Am', V.Am), step('Dm', V.Dm), step('E', V.E), step('Am', V.Am)], rhythm: 'whole' },
      { id: 'tension-quarters', title: 'То же — на каждый счёт', goal: 'Сохранять пульс, когда большой палец уходит на чёрную.', steps: [step('Am', V.Am), step('Dm', V.Dm), step('E', V.E), step('Am', V.Am)], rhythm: 'quarters' },
    ],
  },
  {
    id: 'chords-empty',
    group: 'chords',
    title: 'Пустые и подвешенные аккорды',
    summary: 'Фон, который не спорит с голосом в ролике.',
    intro: [
      'Уберите из аккорда среднюю клавишу — останутся две ноты: аккорд станет «пустым», ни грустным, ни весёлым. Такой фон любят под голос: он не спорит с речью.',
      'Если среднюю клавишу не убрать, а сдвинуть на соседнюю белую — вниз (sus2) или вверх (sus4), — аккорд «повиснет» и попросится обратно. Это типичный звук эмбиента.',
    ],
    bpm: 60,
    exercises: [
      { id: 'empty-fifths', title: 'Две клавиши: A5 → D5 → E5 → A5', goal: 'Брать две клавиши пальцами 1 и 5 и переносить руку.', steps: [step('A5', V.A5), step('D5', V.D5), step('E5', V.E5), step('A5', V.A5)], rhythm: 'whole' },
      { id: 'sus', title: 'Asus2 → Am → Asus4 → Am', goal: 'Менять только среднюю клавишу — пальцы 1 и 5 стоят на месте — и слышать, как аккорд «повисает».', steps: [step('Asus2', V.Asus2), step('Am', V.Am), step('Asus4', V.Asus4), step('Am', V.Am)], rhythm: 'whole' },
    ],
  },
  {
    id: 'chords-dark-minor',
    group: 'chords',
    title: 'Тёмный минор с чёрными клавишами: Cm – Ab – Fm – G',
    summary: 'Мрачный киношный круг — для триллеров и хоррора.',
    intro: [
      'Чёрные клавиши дают мрак. Буква b — чёрная клавиша слева: Eb — слева от E, Ab — слева от A.',
      'Cm — C-Eb-G, Ab — C-Eb-Ab, Fm — C-F-Ab, G — B-D-G. Большой палец всё время рядом с C, обычно меняются одна-две клавиши, а от Fm к G — все три, но недалеко. Последнее упражнение — ритм «3-3-2»: удары на «раз», на «и» после «два» и на «четыре», он почти в каждом электронном треке.',
    ],
    bpm: 65,
    exercises: [
      { id: 'dark-minor-whole', title: 'Длинные аккорды', goal: 'Найти чёрные клавиши, не глядя на руку.', steps: [step('Cm', V.Cm), step('Ab', V.Ab), step('Fm', V.Fm), step('G', V.G)], rhythm: 'whole' },
      { id: 'dark-minor-half', title: 'Два удара на такт', goal: 'Ровный пульс в тёмном круге.', steps: [step('Cm', V.Cm), step('Ab', V.Ab), step('Fm', V.Fm), step('G', V.G)], rhythm: 'half' },
      { id: 'dark-minor-332', title: 'Ритм «3-3-2»', goal: 'Качающий ритм: раз — (два) и — четыре.', steps: [step('Cm', V.Cm), step('Ab', V.Ab), step('Fm', V.Fm), step('G', V.G)], rhythm: 'tresillo' },
    ],
  },
  {
    id: 'chords-dreamy',
    group: 'chords',
    title: 'Мечтательные аккорды из четырёх нот',
    summary: 'Мягкий звук для lo-fi и эмбиента.',
    intro: [
      'Добавьте к аккорду четвёртую ноту — звук станет мягче и «дороже». Так звучат lo-fi, эмбиент и спокойные подложки.',
      'Cmaj7 — C-E-G-B, Am7 — A-C-E-G, Fmaj7 — C-E-F-A, Em7 — B-D-E-G. Пальцы 1-2-3-5 (или 1-2-4-5, если две верхние ноты рядом).',
    ],
    bpm: 66,
    exercises: [
      { id: 'dreamy-whole', title: 'Cmaj7 → Am7 → Fmaj7 → Em7', goal: 'Брать четыре ноты разом, не задевая соседних клавиш.', steps: [step('Cmaj7', V.Cmaj7), step('Am7', V.Am7), step('Fmaj7', V.Fmaj7), step('Em7', V.Em7)], rhythm: 'whole' },
      { id: 'dreamy-half', title: 'Два удара на такт', goal: 'Мягко отпускать и снова брать аккорд.', steps: [step('Cmaj7', V.Cmaj7), step('Am7', V.Am7), step('Fmaj7', V.Fmaj7), step('Em7', V.Em7)], rhythm: 'half' },
    ],
  },
  {
    id: 'chords-arp',
    group: 'chords',
    title: 'Аккорд по одной ноте (арпеджио)',
    summary: 'Из аккорда — в мотив: ноты по очереди.',
    intro: [
      'Аккорд не обязательно брать разом: сыграйте его ноты по очереди, снизу вверх и обратно. Так из аккордов рождаются мотивы и подложки.',
      'Пальцы те же, что для аккорда. Держите руку над тремя клавишами и нажимайте их по одной — ровно, на каждый счёт и между счётами («раз-и-два-и»).',
    ],
    bpm: 72,
    exercises: [
      { id: 'arp-c', title: 'C по нотам', goal: 'Ровные одиночные нажатия внутри аккорда.', steps: [step('C', V.C)], rhythm: 'arpUpDown', repeat: 4 },
      { id: 'arp-pop', title: 'C – G – Am – F по нотам', goal: 'Менять аккорд, не сбивая ровный поток нот.', steps: POP, rhythm: 'arpUpDown' },
    ],
  },
  {
    id: 'hand-five',
    group: 'hand',
    title: 'Пять пальцев: C-D-E-F-G',
    summary: 'Каждому пальцу — своя клавиша.',
    intro: [
      'Поставьте пять пальцев правой руки на пять белых клавиш подряд: C D E F G — большой палец на C, мизинец на G. Пальцы держите над клавишами, не отрывайте далеко.',
      'Играйте вверх и вниз ровно, по ноте на счёт. Так рука запоминает клавиатуру, а пальцы — силу нажатия.',
    ],
    bpm: 80,
    exercises: [
      { id: 'five-up', title: 'Вверх и вниз', goal: 'Ровные нажатия всеми пятью пальцами.', line: line([60, 62, 64, 65, 67, 65, 64, 62], [1, 2, 3, 4, 5, 4, 3, 2]), end: { p: 60, d: 4, f: 1 } },
      { id: 'five-eighths', title: 'То же вдвое быстрее', goal: 'Скорость без потери ровности.', line: line([60, 62, 64, 65, 67, 65, 64, 62], [1, 2, 3, 4, 5, 4, 3, 2], 0.5), repeat: 4, end: { p: 60, d: 4, f: 1 } },
      { id: 'five-skips', title: 'Через клавишу: C-E-D-F-E-G', goal: 'Независимость пальцев.', line: line([60, 64, 62, 65, 64, 67, 65, 64], [1, 3, 2, 4, 3, 5, 4, 3]), end: { p: 60, d: 4, f: 1 } },
    ],
  },
  {
    id: 'hand-minor',
    group: 'hand',
    title: 'Минорная позиция: A-B-C-D-E',
    summary: 'Те же пальцы — в грустном настроении.',
    intro: [
      'Сдвиньте руку: большой палец на A, мизинец на E (A B C D E). Это минорная позиция — из неё играются грустные мелодии.',
      'Сначала вверх-вниз, потом короткий мотив — в нём уже слышно настроение.',
    ],
    bpm: 80,
    exercises: [
      { id: 'minor-updown', title: 'Вверх и вниз', goal: 'Запомнить новую позицию руки.', line: line([57, 59, 60, 62, 64, 62, 60, 59], [1, 2, 3, 4, 5, 4, 3, 2]), end: { p: 57, d: 4, f: 1 } },
      {
        id: 'minor-motif',
        title: 'Мотив',
        goal: 'Сыграть короткую мелодию в ритме.',
        line: [
          { p: 57, d: 1, f: 1 }, { p: 60, d: 1, f: 3 }, { p: 59, d: 1, f: 2 }, { p: 57, d: 1, f: 1 },
          { p: 64, d: 2, f: 5 }, { p: 62, d: 1, f: 4 }, { p: 60, d: 1, f: 3 },
          { p: 59, d: 1, f: 2 }, { p: 60, d: 1, f: 3 }, { p: 62, d: 1, f: 4 }, { p: 59, d: 1, f: 2 },
          { p: 57, d: 4, f: 1 },
        ],
      },
    ],
  },
  {
    id: 'hand-penta',
    group: 'hand',
    title: 'Пентатоника: мотивы из пяти нот',
    summary: 'Пять нот, из которых трудно сыграть «неправильно».',
    intro: [
      'Пентатоника — пять нот: A C D E G. Из них строят риффы и мотивы, и они почти всегда звучат хорошо.',
      'Пальцы: A — 1, C — 2, D — 3, E — 4, G — 5. Сыграйте вверх-вниз, а потом повторите мотив — хорошая заготовка для запоминающейся темы.',
    ],
    bpm: 84,
    exercises: [
      { id: 'penta-updown', title: 'Вверх и вниз', goal: 'Запомнить пять нот и пальцы.', line: line([57, 60, 62, 64, 67, 64, 62, 60], [1, 2, 3, 4, 5, 4, 3, 2]), end: { p: 57, d: 4, f: 1 } },
      {
        id: 'penta-motif',
        title: 'Мотив',
        goal: 'Короткие и длинные ноты в одной фразе.',
        line: [
          { p: 64, d: 0.5, f: 4 }, { p: 62, d: 0.5, f: 3 }, { p: 60, d: 1, f: 2 }, { p: 57, d: 1, f: 1 }, { p: 60, d: 1, f: 2 },
          { p: 62, d: 0.5, f: 3 }, { p: 64, d: 0.5, f: 4 }, { p: 67, d: 1, f: 5 }, { p: 64, d: 2, f: 4 },
        ],
      },
    ],
  },
]

// ---------------------------------------------------------------------------------------

const BAR = 4 // all built-in lessons are in 4/4
const LEAD_IN_BARS = 1

/** Right-hand fingers for a chord, bottom to top. */
export function chordFingers(notes: number[]): number[] {
  const s = notes.slice().sort((a, b) => a - b)
  if (s.length === 1) return [1]
  if (s.length === 2) return [1, 5]
  if (s.length === 3) return s[2] - s[1] >= 5 ? [1, 2, 5] : s[2] - s[1] <= 2 ? [1, 4, 5] : [1, 3, 5]
  if (s.length === 4) return s[3] - s[2] <= 2 ? [1, 2, 4, 5] : [1, 2, 3, 5]
  return [1, 2, 3, 4, 5].slice(0, s.length)
}

/** Hits of one bar: [beat offset, length in beats, which notes (indices; all when omitted)]. */
function rhythmHits(r: Rhythm, n: number): { at: number; len: number; note?: number }[] {
  switch (r) {
    case 'whole':
      return [{ at: 0, len: 3.9 }]
    case 'half':
      return [{ at: 0, len: 1.85 }, { at: 2, len: 1.85 }]
    case 'quarters':
      return [0, 1, 2, 3].map((at) => ({ at, len: 0.85 }))
    case 'eighths':
      return [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ at: k / 2, len: 0.4 }))
    case 'tresillo': // «3-3-2»: on one, on the «and» of two, on four
      return [{ at: 0, len: 1.25 }, { at: 1.5, len: 1.25 }, { at: 3, len: 0.75 }]
    case 'arpUpDown': {
      const order = n <= 1 ? [0] : [...Array.from({ length: n }, (_, i) => i), ...Array.from({ length: n - 2 }, (_, i) => n - 2 - i)]
      return Array.from({ length: 8 }, (_, k) => ({ at: k / 2, len: 0.45, note: order[k % order.length] }))
    }
  }
}

function exerciseNotes(ex: Exercise, grid: Grid): { notes: Note[]; chords: ChordMark[]; fingers: Map<number, number>; bars: number } {
  const notes: Note[] = []
  const fingers = new Map<number, number>()
  const chords: ChordMark[] = []
  const at = (beat: number) => Math.round(beatTime(grid, beat) * 1e6) / 1e6
  const add = (pitch: number, beat: number, len: number, finger: number, vel = 92) => {
    fingers.set(notes.length, finger)
    notes.push({ p: pitch, s: at(beat), e: at(beat + len), v: vel })
  }
  const start = grid.firstDownbeat
  const repeat = ex.repeat ?? 2
  let bars = 0
  if (ex.steps?.length) {
    for (let r = 0; r < repeat; r++) {
      for (const st of ex.steps) {
        const b0 = start + bars * BAR
        const sorted = st.notes.slice().sort((a, b) => a - b)
        const fs = chordFingers(sorted)
        for (const h of rhythmHits(ex.rhythm ?? 'whole', sorted.length)) {
          if (h.note !== undefined) add(sorted[h.note], b0 + h.at, h.len, fs[h.note])
          else sorted.forEach((p, i) => add(p, b0 + h.at, h.len, fs[i], h.at === 0 ? 96 : 84))
        }
        chords.push({ start: b0, end: b0 + BAR, name: st.chord })
        bars++
      }
    }
  } else if (ex.line?.length) {
    let beat = start
    for (let r = 0; r < repeat; r++) {
      for (const n of ex.line) {
        add(n.p, beat, Math.max(0.2, n.d - 0.08), n.f)
        beat += n.d
      }
    }
    if (ex.end) {
      add(ex.end.p, beat, ex.end.d - 0.1, ex.end.f)
      beat += ex.end.d
    }
    bars = Math.ceil((beat - start) / BAR - 1e-6)
  }
  return { notes, chords, fingers, bars }
}

const cache = new Map<string, BuiltLesson>()

/** The lesson as the trainer sees it: a grid with one lead-in bar and one part per exercise. */
export function builtinLesson(id: string | undefined): BuiltLesson | null {
  if (!id) return null
  const hit = cache.get(id)
  if (hit) return hit
  const def = BUILTIN_LESSONS.find((l) => l.id === id)
  if (!def) return null
  const beatSec = 60 / def.bpm
  const longest = Math.max(
    ...def.exercises.map((ex) => {
      const lineBeats = (ex.line ?? []).reduce((s, n) => s + n.d, 0) * (ex.repeat ?? 2) + (ex.end?.d ?? 0)
      const stepBars = (ex.steps?.length ?? 0) * (ex.repeat ?? 2)
      return Math.max(stepBars, Math.ceil(lineBeats / BAR))
    }),
  )
  const durationSec = (LEAD_IN_BARS + longest + 1) * BAR * beatSec
  const grid: Grid = { ...uniformGrid(def.bpm, LEAD_IN_BARS * BAR * beatSec, durationSec), origin: 'midi' }
  const info = new Map<string, ExerciseInfo>()
  const parts: Part[] = def.exercises.map((ex) => {
    const built = exerciseNotes(ex, grid)
    info.set(ex.id, { exercise: ex, chords: built.chords, fingers: built.fingers })
    return {
      id: ex.id,
      name: ex.title,
      role: def.group === 'hand' ? 'melody' : 'chords',
      isDrum: false,
      program: 0,
      origin: 'midi',
      notes: built.notes,
      media: {},
      silent: false,
    }
  })
  const lesson: Lesson = {
    id: `builtin-${def.id}`,
    title: def.title,
    artist: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    source: { kind: 'midi', stemFiles: [] },
    status: 'ready',
    progress: 1,
    warnings: [],
    durationSec,
    grid,
    media: {},
    parts,
    prefs: {},
  }
  const built: BuiltLesson = { def, lesson, info }
  cache.set(id, built)
  return built
}

/** Bars of one written pass of an exercise: the whole progression or line is learnt as one loop. */
export function exercisePassBars(ex: Exercise): number {
  if (ex.steps?.length) return ex.steps.length
  return Math.max(1, Math.ceil((ex.line ?? []).reduce((s, n) => s + n.d, 0) / BAR - 1e-6))
}

/** "C → F → C → G" for a chord exercise; the notes for a line. */
export function exerciseSummary(ex: Exercise): string {
  if (ex.steps?.length) return ex.steps.map((s) => s.chord).join(' → ')
  return `${ex.line?.length ?? 0} нот`
}
