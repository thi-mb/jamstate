// The Stage overlay (v0.6): reads plans, live audio-clock frames, and decisions;
// never writes engine state directly. Mix callbacks (mute/solo/vol) route through
// main.ts to Synth and MidiSink without altering bandleader decisions.

import type { ArcSummary } from "../core/arc";
import { getInstrument, type Band } from "../core/band";
import type { BarKind, BarPlan, MoveRecord } from "../core/engine";
import type { BarFeatures } from "../core/features";
import { getGenre } from "../core/genres";
import type { Heard } from "../core/listening";
import { PART_LABELS, V01_PARTS, type Part } from "../core/types";

const genreName = (id: string) => getGenre(id).name.toLowerCase();
const $ = (id: string) => document.getElementById(id)!;

const FEEL_LABEL = { normal: "normal feel", half_time: "half time", double_time: "double time" } as const;

export interface StageFrame {
  beatInBar: number;
  bpb: number;
  kind: BarKind;
  currentChord: string | null;
  nextChord: string | null;
  anticipate: boolean;
  hits: Partial<Record<Part, number>>;
}

export interface MusicianCallbacks {
  onMute(part: Part): void;
  onSolo(part: Part): void;
  onVolume(part: Part, vol: number): void;
}

interface CardRefs {
  root: HTMLElement;
  chip: HTMLElement;
  inst: HTMLElement;
  soloTag: HTMLElement;
  muteBtn: HTMLButtonElement;
  soloBtn: HTMLButtonElement;
  vol: HTMLInputElement;
}

export class Overlay {
  private formEl = $("form");
  private log = $("log");
  private cards = new Map<Part, CardRefs>();
  private cardOrder: Part[] = [];
  private beatDots: HTMLElement[] = [];
  private lastBeatIdx = -1;
  private lastBpb = 0;
  private toastTimer: number | null = null;
  private muted = new Set<Part>();
  private soloed = new Set<Part>();
  private currentBand: Band = {};
  private currentMixVolumes: Partial<Record<Part, number>> = {};

  /** The chart's tempo; the overlay shows the band's when it differs (follow my tempo). */
  chartBpm = 0;
  /** Blind test: hide who made each move and why (the wording gives brains away). */
  blind = false;
  /** Who is in the band before the first bar (the page sets it from the lineup picker). */
  lineup: Part[] = [...V01_PARTS];
  /** Callbacks for interactive Musician Card mute/solo/volume controls. */
  musicianCb: MusicianCallbacks | null = null;

  setForm(form: string[], barCounts?: number[]): void {
    this.formEl.replaceChildren(
      ...form.map((name, i) => {
        const li = document.createElement("li");
        const bars = barCounts?.[i] ?? 4;
        li.style.flexGrow = String(Math.max(1, bars));
        const fill = document.createElement("span");
        fill.className = "form-fill";
        const label = document.createElement("span");
        label.className = "form-name";
        label.textContent = name;
        li.append(fill, label);
        return li;
      }),
    );
  }

  reset(title: string): void {
    $("section").textContent = "ready";
    $("bar").textContent = `${title}: press Start, then play`;
    $("chord").textContent = "–";
    const nextEl = document.getElementById("next-chord");
    if (nextEl) {
      nextEl.textContent = "–";
      nextEl.classList.remove("anticipate");
    }
    $("last-move").textContent = "–";
    $("last-reason").textContent = "";
    this.setEnergy(null);
    this.heard(null);
    this.arc(null);
    this.log.replaceChildren();
    this.resetProgress();
    this.renderCards(this.lineup, this.lineup, null);
  }

  resetProgress(): void {
    const ph = document.getElementById("playhead");
    if (ph) ph.style.width = "0%";
    for (const d of this.beatDots) d.classList.remove("on", "count-in");
    this.lastBeatIdx = -1;
    for (const c of this.cards.values()) c.root.style.setProperty("--hit", "0");
    for (const li of this.formEl.children) {
      li.classList.remove("current");
      const f = li.querySelector<HTMLElement>(".form-fill");
      if (f) f.style.width = "0%";
    }
  }

  private ensureBeats(bpb: number): void {
    if (this.lastBpb === bpb && this.beatDots.length === bpb) return;
    this.lastBpb = bpb;
    const host = document.getElementById("beats");
    if (!host) return;
    this.beatDots = Array.from({ length: bpb }, (_, i) => {
      const s = document.createElement("span");
      s.className = "beat-dot";
      s.textContent = String(i + 1);
      return s;
    });
    host.replaceChildren(...this.beatDots);
  }

  bar(plan: BarPlan): void {
    this.currentBand = plan.band;
    const mix = getGenre(plan.genre).mix.parts;
    for (const p of plan.lineup) this.currentMixVolumes[p] = plan.band[p]?.volume ?? mix[p]?.volume ?? 0.8;

    if (plan.kind === "count_in") {
      $("section").textContent = "count-in";
      $("bar").textContent = plan.sectionBars > 1 ? `bar ${plan.barInSection + 1} of ${plan.sectionBars}` : "1, 2, 3, 4…";
      $("chord").textContent = "–";
      const nextEl = document.getElementById("next-chord");
      if (nextEl) {
        nextEl.textContent = "–";
        nextEl.classList.remove("anticipate");
      }
      $("feel").textContent = `${genreName(plan.genre)} · swing ${plan.swing}`;
      this.renderCards(plan.layers, plan.lineup, null);
      return;
    }

    $("section").textContent = plan.kind === "ending" ? `${plan.section} · ending` : plan.section;
    $("bar").textContent = `bar ${plan.barInSection + 1} of ${plan.sectionBars}${plan.repeated.length ? ` · repeated ${plan.repeated.join(", ")}` : ""}`;
    $("chord").textContent = plan.chords.join("  ");
    $("feel").textContent =
      `${genreName(plan.genre)} · swing ${plan.swing} · ${FEEL_LABEL[plan.feel]}` +
      (plan.bpm !== this.chartBpm ? ` · ${plan.bpm.toFixed(1)} bpm (chart ${this.chartBpm})` : "") +
      (plan.stingers.length ? ` · ${plan.stingers.join(" + ")}` : "") +
      (plan.solo ? ` · ${PART_LABELS[plan.solo.part]} solo ${plan.solo.bar + 1}/${plan.solo.of}` : plan.trading ? " · trading: your turn" : "");

    ($("intensity") as HTMLElement).style.width = `${plan.intensity * 100}%`;
    ($("target") as HTMLElement).style.left = `calc(${plan.target * 100}% - 1px)`;
    $("intensity-num").textContent = `${plan.intensity.toFixed(2)} → ${plan.target.toFixed(2)}`;

    [...this.formEl.children].forEach((li, i) => {
      const cur = i === plan.formPos;
      li.classList.toggle("current", cur);
      li.classList.toggle("past", i < plan.formPos);
      const fill = li.querySelector<HTMLElement>(".form-fill");
      if (fill) {
        fill.style.width = cur ? `${((plan.barInSection + 1) / Math.max(1, plan.sectionBars)) * 100}%` : i < plan.formPos ? "100%" : "0%";
      }
    });

    this.renderCards(plan.layers, plan.lineup, plan.solo ?? null);
    for (const m of plan.moves) this.move(m, plan.bar);
  }

  /** Smooth 60fps visual update synced to AudioContext.currentTime (decoupled from scheduler). */
  frame(f: StageFrame): void {
    this.ensureBeats(f.bpb);
    const frac = Math.max(0, Math.min(1, f.beatInBar / Math.max(1, f.bpb)));
    const ph = document.getElementById("playhead");
    if (ph) ph.style.width = `${(frac * 100).toFixed(2)}%`;

    const beatIdx = Math.max(0, Math.min(f.bpb - 1, Math.floor(f.beatInBar)));
    if (beatIdx !== this.lastBeatIdx || f.kind === "count_in") {
      this.lastBeatIdx = beatIdx;
      for (let i = 0; i < this.beatDots.length; i++) {
        this.beatDots[i].classList.toggle("on", i === beatIdx);
        this.beatDots[i].classList.toggle("count-in", f.kind === "count_in" && i === beatIdx);
      }
    }

    const nextEl = document.getElementById("next-chord");
    if (nextEl) {
      const txt = f.nextChord ?? "–";
      if (nextEl.textContent !== txt) nextEl.textContent = txt;
      nextEl.classList.toggle("anticipate", !!f.nextChord && f.anticipate);
    }

    for (const [part, refs] of this.cards) {
      const lvl = f.hits[part] ?? 0;
      refs.root.style.setProperty("--hit", lvl.toFixed(3));
    }
  }

  /** Show the lineup while nothing plays. */
  showLineup(lineup: Part[], band?: Band, mixVolumes?: Partial<Record<Part, number>>): void {
    this.lineup = lineup;
    if (band) this.currentBand = band;
    if (mixVolumes) this.currentMixVolumes = mixVolumes;
    this.renderCards(lineup, lineup, null);
  }

  setMuteSolo(muted: Set<Part>, soloed: Set<Part>): void {
    this.muted = new Set(muted);
    this.soloed = new Set(soloed);
    this.syncMixBadges();
  }

  setPartVolume(part: Part, vol: number): void {
    this.currentMixVolumes[part] = vol;
    const refs = this.cards.get(part);
    if (refs && document.activeElement !== refs.vol) refs.vol.value = String(vol);
  }

  private syncMixBadges(): void {
    const hasSolo = this.soloed.size > 0;
    for (const [p, refs] of this.cards) {
      const isMuted = this.muted.has(p);
      const isSolo = this.soloed.has(p);
      const silenced = isMuted || (hasSolo && !isSolo);
      refs.root.classList.toggle("silenced", silenced);
      refs.muteBtn.classList.toggle("active", isMuted);
      refs.muteBtn.setAttribute("aria-pressed", String(isMuted));
      refs.soloBtn.classList.toggle("active", isSolo);
      refs.soloBtn.setAttribute("aria-pressed", String(isSolo));
    }
  }

  private renderCards(on: string[], lineup: Part[], solo: { part: Part; bar: number; of: number } | null): void {
    const sameOrder = lineup.length === this.cardOrder.length && lineup.every((p, i) => this.cardOrder[i] === p);
    if (!sameOrder) {
      this.cardOrder = [...lineup];
      this.cards.clear();
      const nodes = lineup.map((p) => {
        const card = document.createElement("div");
        card.className = "musician-card";
        card.dataset.part = p;

        const top = document.createElement("div");
        top.className = "mc-head";
        // Keeps `.chip` with exact PART_LABELS text for readability and automated checks.
        const chip = document.createElement("span");
        chip.className = "chip on";
        chip.textContent = PART_LABELS[p];
        const soloTag = document.createElement("span");
        soloTag.className = "mc-solo-tag";
        soloTag.hidden = true;
        top.append(chip, soloTag);

        const inst = document.createElement("div");
        inst.className = "mc-inst";

        const pulse = document.createElement("div");
        pulse.className = "mc-pulse";
        pulse.append(document.createElement("i"));

        const ctrls = document.createElement("div");
        ctrls.className = "mc-ctrls";
        const muteBtn = Object.assign(document.createElement("button"), {
          type: "button",
          className: "mc-btn mc-mute",
          textContent: "M",
          title: `Mute ${PART_LABELS[p]}`,
        });
        const soloBtn = Object.assign(document.createElement("button"), {
          type: "button",
          className: "mc-btn mc-solo",
          textContent: "S",
          title: `Solo ${PART_LABELS[p]}`,
        });
        const vol = Object.assign(document.createElement("input"), {
          type: "range",
          className: "mc-vol",
          min: "0",
          max: "1",
          step: "0.05",
          title: `${PART_LABELS[p]} volume`,
        });
        muteBtn.onclick = () => this.musicianCb?.onMute(p);
        soloBtn.onclick = () => this.musicianCb?.onSolo(p);
        vol.oninput = () => this.musicianCb?.onVolume(p, Number(vol.value));
        ctrls.append(muteBtn, soloBtn, vol);

        card.append(top, inst, pulse, ctrls);
        this.cards.set(p, { root: card, chip, inst, soloTag, muteBtn, soloBtn, vol });
        return card;
      });
      $("layers").replaceChildren(...nodes);
    }

    for (const p of lineup) {
      const refs = this.cards.get(p);
      if (!refs) continue;
      const active = on.includes(p);
      const isSoloing = solo?.part === p;
      refs.root.classList.toggle("active", active);
      refs.root.classList.toggle("laying-out", !active);
      refs.root.classList.toggle("soloing", isSoloing);
      refs.chip.className = `chip ${active ? "on" : "off"}`;
      const instId = this.currentBand[p]?.instrument;
      refs.inst.textContent = instId ? (getInstrument(instId)?.name ?? instId) : "";
      refs.soloTag.hidden = !isSoloing;
      if (isSoloing && solo) refs.soloTag.textContent = `SOLO ${solo.bar + 1}/${solo.of}`;
      const vol = this.currentBand[p]?.volume ?? this.currentMixVolumes[p];
      if (vol !== undefined && document.activeElement !== refs.vol) refs.vol.value = String(vol);
    }
    this.syncMixBadges();
  }

  /** Transient toast on Stage for spoken voice cues and keyboard cues. */
  toast(text: string, detail?: string, kind: "voice" | "cue" = "cue"): void {
    const el = document.getElementById("cue-toast");
    if (!el) return;
    el.dataset.kind = kind;
    el.innerHTML = `<span class="toast-badge"></span><span class="toast-text"></span><span class="toast-detail"></span>`;
    el.querySelector(".toast-badge")!.textContent = kind === "voice" ? "VOICE" : "CUE";
    el.querySelector(".toast-text")!.textContent = text;
    el.querySelector(".toast-detail")!.textContent = detail ?? "";
    el.hidden = false;
    el.classList.add("show");
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.classList.remove("show");
      this.toastTimer = window.setTimeout(() => (el.hidden = true), 250);
    }, 3200);
  }

  setEnergy(f: BarFeatures | null): void {
    ($("energy") as HTMLElement).style.width = `${(f?.energy ?? 0) * 100}%`;
    $("energy-num").textContent = f ? `${f.energy.toFixed(2)} · ${f.noteCount} note${f.noteCount === 1 ? "" : "s"}` : "";
  }

  /** Everything the listening layer heard, whichever groups go to the leader. */
  heard(h: Heard | null): void {
    if (!h) return void ($("heard").textContent = "");
    const p = h.position;
    const lift = p.next_lift === "up" ? " ↑" : p.next_lift === "down" ? " ↓" : "";
    const next = p.next_section === null ? "the end" : `${p.next_section}${lift}`;
    // Heard after the bar before the one sounding now, so bars_left counts from the bar playing.
    const parts = [p.bars_left ? `${p.bars_left} bar${p.bars_left > 1 ? "s" : ""} to ${next}` : `${next} next`, `phrase ${p.phrase}`, `${p.pass}`];
    const r = h.rhythm;
    if (r.syncopation !== null) parts.push(`syncopation ${r.syncopation.toFixed(2)}${r.swing ? ` · swing ${r.swing.toFixed(2)}` : ""}`);
    if (r.timing && r.timing !== "on") parts.push(`${r.timing} ${Math.abs(r.timing_ms ?? 0)} ms`);
    if (r.tempo && r.tempo !== "steady") parts.push(r.tempo);
    const hm = h.harmony;
    if (hm.fit) parts.push(`${hm.fit} (in ${Math.round((hm.inside ?? 0) * 100)}% · colour ${Math.round((hm.colour ?? 0) * 100)}% · out ${Math.round((hm.outside ?? 0) * 100)}%)`);
    const ph = h.phrasing;
    if (ph.state !== "waiting") parts.push(ph.call_response ? "trading phrases" : ph.state === "playing" ? `playing ${ph.playing_bars} bar${ph.playing_bars === 1 ? "" : "s"}` : `${ph.state} ${ph.gap_bars} bar${ph.gap_bars === 1 ? "" : "s"}`);
    if ((ph.held ?? 0) >= 0.6) parts.push("long notes");
    const d = h.dynamics;
    if (d.level !== null) parts.push(`${d.shape && d.shape !== "steady" ? `${d.shape} · ` : ""}level ${d.level.toFixed(2)}${(d.accents ?? 0) >= 0.15 ? " · accents" : ""}`);
    $("heard").textContent = `hearing: ${parts.join(" · ")}`;
  }

  /** The song so far and the plan (v0.4): this section against last time, and the next one. */
  arc(a: ArcSummary | null): void {
    if (!a) return void ($("arc").textContent = "");
    const plan = (p: ArcSummary["now"] | NonNullable<ArcSummary["next"]>) => `${p.section} ${p.pass}: ${p.idea}`;
    const peak = a.peak ? ` · peak so far ${a.peak.section} ${a.peak.pass} (${a.peak.level.toFixed(2)})` : "";
    $("arc").textContent = `plan (${a.style}): ${plan(a.now)}${a.next ? ` · next ${plan(a.next)}` : ""}${peak}`;
  }

  move(m: MoveRecord, bar: number): void {
    const reason = this.blind && m.source !== "you" ? "" : m.move.reason;
    if (m.status === "applied" && (m.move.reason || this.blind)) {
      $("last-move").textContent = m.label;
      $("last-reason").textContent = reason ?? "";
    }
    const li = document.createElement("li");
    li.className = m.status;
    const src = this.blind && m.source !== "you" ? "bandleader" : m.source;
    const detail = [reason && `“${reason}”`, m.note].filter(Boolean).join(" · ");
    li.innerHTML = `<span class="src">[${src}]</span> bar ${bar + 1}: ${m.label} (${m.status})${detail ? ` — ${escapeHtml(detail)}` : ""}`;
    this.log.prepend(li);
    while (this.log.children.length > 40) this.log.lastElementChild?.remove();
  }

  note(text: string): void {
    const li = document.createElement("li");
    li.textContent = text;
    this.log.prepend(li);
  }

  leaderStatus(text: string): void {
    $("leader-status").textContent = text;
    const pill = document.getElementById("pill-leader");
    if (pill) pill.textContent = text;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
