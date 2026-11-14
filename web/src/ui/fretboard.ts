// The fretboard view (v0.3): draws what core/fretboard.ts decides. Guitar
// (frets 0–15) or two octaves of piano following the player. Scale mode: the
// song's scale held still, the chord tones moving on top. Changes mode: chord
// tones strong, the genre's scale for the chord faint, the next chord fading
// in on the beat before a change. The player's notes are coloured by fit.

import {
  chordView,
  followWindow,
  guitarCells,
  isBlack,
  markOf,
  pianoCells,
  songScale,
  GUITAR_FRETS,
  type Cell,
  type ChordView,
  type FretboardKind,
  type FretboardMode,
  type SongScale,
} from "../core/fretboard";
import type { Chart } from "../core/chart";
import type { BarPlan } from "../core/engine";
import type { GenreListening } from "../core/genre";
import { noteFit } from "../core/listening";

const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const FRET_DOTS = new Set([3, 5, 7, 9, 12, 15]);

export class FretboardView {
  kind: FretboardKind = "guitar";
  mode: FretboardMode = "scale";
  /** The song scale, worked out once per chart and genre. */
  private song: { chart: Chart; genre: GenreListening; scale: SongScale | null } | null = null;
  private low = 48;
  private key = "";
  private cells = new Map<number, HTMLElement[]>();
  private sounding = new Map<number, string>();
  private view: ChordView = { chord: null, next: null };
  private genre?: GenreListening;
  /** Notes the player played lately (for the piano window). */
  private recent: number[] = [];

  constructor(private root: HTMLElement) {}

  setKind(kind: FretboardKind): void {
    this.kind = kind;
    this.root.hidden = kind === "off";
    this.key = "";
    this.draw();
  }

  setMode(mode: FretboardMode): void {
    this.mode = mode;
    this.key = "";
    this.draw();
  }

  /** The scale held in scale mode; null in changes mode or when the chart has no key. */
  private get scale(): SongScale | null {
    return this.mode === "scale" ? (this.song?.scale ?? null) : null;
  }

  /** Called every animation frame while a jam plays. Redraws only when something changed. */
  frame(chart: Chart, plan: BarPlan | undefined, beatInBar: number, nextPlan: BarPlan | undefined, genre: GenreListening): void {
    if (this.kind === "off") return;
    this.view = plan ? chordView(chart, plan, beatInBar, nextPlan) : { chord: null, next: null };
    this.genre = genre;
    if (this.song?.chart !== chart || this.song.genre !== genre) this.song = { chart, genre, scale: songScale(chart, genre) };
    if (this.kind === "piano") this.low = followWindow(this.low, this.recent);
    this.draw();
  }

  clear(): void {
    this.view = { chord: null, next: null };
    this.sounding.clear();
    this.recent = [];
    this.key = "";
    this.draw();
  }

  /** A note the player pressed or let go. */
  note(on: boolean, note: number): void {
    if (note < 0) return;
    if (on) {
      const fit = this.view.chord ? noteFit(note % 12, this.view.chord, this.genre) : "inside";
      this.sounding.set(note, fit);
      this.recent.push(note);
      if (this.recent.length > 24) this.recent.shift();
    } else this.sounding.delete(note);
    this.paintPlayer();
  }

  private draw(): void {
    if (this.kind === "off") return;
    const scale = this.scale;
    const chord = this.view.chord;
    // Scale mode has no next-chord fade: only the chord tones move.
    const next = scale ? null : this.view.next;
    const key = `${this.kind}|${this.mode}|${scale?.name ?? ""}|${this.low}|${chord?.symbol ?? ""}|${next?.symbol ?? ""}`;
    if (key === this.key) return;
    this.key = key;
    this.root.dataset.chord = chord?.symbol ?? "";
    this.root.dataset.next = next?.symbol ?? "";
    this.root.dataset.scale = scale?.name ?? "";
    // For the page timing check (test plan row 10): when the view last changed.
    this.root.dataset.changedAt = String(performance.now());
    const label = Object.assign(document.createElement("div"), {
      className: "fb-label",
      textContent: scale
        ? `${scale.name} scale  ·  ${chord?.symbol ?? "–"}`
        : chord
          ? `${chord.symbol}${next ? `  →  ${next.symbol}` : ""}`
          : "–",
    });
    this.cells.clear();
    const board = this.kind === "guitar" ? this.guitar() : this.piano();
    this.root.replaceChildren(label, board);
    this.paintPlayer();
  }

  private decorate(el: HTMLElement, c: Cell): void {
    if (c.mark) el.classList.add(`fb-${c.mark}`);
    if (c.root) el.classList.add("fb-root");
    if (c.passing) el.classList.add("fb-passing");
    const nm = this.scale ? null : markOf(c.note, this.view.next, this.genre);
    if (nm) el.classList.add(`fb-next-${nm}`);
    el.dataset.note = String(c.note);
    const list = this.cells.get(c.note) ?? [];
    list.push(el);
    this.cells.set(c.note, list);
  }

  private guitar(): HTMLElement {
    const grid = Object.assign(document.createElement("div"), { className: "fb-guitar" });
    grid.style.setProperty("--frets", String(GUITAR_FRETS + 1));
    for (const row of guitarCells(this.view.chord, this.genre, this.scale)) {
      for (const [f, c] of row.entries()) {
        const el = Object.assign(document.createElement("span"), { className: `fb-fret${f === 0 ? " fb-open" : ""}` });
        const dot = document.createElement("i");
        if (c.mark || c.root) dot.textContent = NOTE_NAMES[c.note % 12];
        el.append(dot);
        this.decorate(el, c);
        grid.append(el);
      }
    }
    for (let f = 0; f <= GUITAR_FRETS; f++)
      grid.append(Object.assign(document.createElement("span"), { className: "fb-fretnum", textContent: FRET_DOTS.has(f) ? String(f) : "" }));
    return grid;
  }

  private piano(): HTMLElement {
    const kb = Object.assign(document.createElement("div"), { className: "fb-piano" });
    for (const c of pianoCells(this.low, this.view.chord, this.genre, this.scale)) {
      const el = Object.assign(document.createElement("span"), { className: isBlack(c.note) ? "fb-key fb-black" : "fb-key fb-white" });
      if (c.mark || c.root) el.append(Object.assign(document.createElement("i"), { textContent: NOTE_NAMES[c.note % 12] }));
      if (c.note % 12 === 0) el.title = `C${c.note / 12 - 1}`;
      this.decorate(el, c);
      kb.append(el);
    }
    return kb;
  }

  private paintPlayer(): void {
    for (const els of this.cells.values()) for (const el of els) el.classList.remove("fb-play-inside", "fb-play-colour", "fb-play-outside");
    for (const [note, fit] of this.sounding) for (const el of this.cells.get(note) ?? []) el.classList.add(`fb-play-${fit}`);
  }
}
