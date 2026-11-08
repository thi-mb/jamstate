// The on-screen overlay: reads plans and decisions, never writes engine state.

import type { BarPlan, MoveRecord } from "../core/engine";
import type { BarFeatures } from "../core/features";
import { getGenre } from "../core/genres";
import type { Heard } from "../core/listening";
import { PART_LABELS, V01_PARTS, type Part } from "../core/types";

const genreName = (id: string) => getGenre(id).name.toLowerCase();

const $ = (id: string) => document.getElementById(id)!;

const FEEL_LABEL = { normal: "normal feel", half_time: "half time", double_time: "double time" } as const;

export class Overlay {
  private formEl = $("form");
  private log = $("log");
  /** Blind test: hide who made each move and why (the wording gives brains away). */
  blind = false;

  setForm(form: string[]): void {
    this.formEl.replaceChildren(...form.map((name) => Object.assign(document.createElement("li"), { textContent: name })));
  }

  reset(title: string): void {
    $("section").textContent = "ready";
    $("bar").textContent = `${title}: press Start, then play`;
    $("chord").textContent = "–";
    $("last-move").textContent = "–";
    $("last-reason").textContent = "";
    this.setEnergy(null);
    this.heard(null);
    this.log.replaceChildren();
    this.renderLayers(this.lineup, this.lineup);
  }

  bar(plan: BarPlan): void {
    if (plan.kind === "count_in") {
      $("section").textContent = "count-in";
      $("bar").textContent = plan.sectionBars > 1 ? `bar ${plan.barInSection + 1} of ${plan.sectionBars}` : "1, 2, 3, 4…";
      $("chord").textContent = "–";
      $("feel").textContent = `${genreName(plan.genre)} · swing ${plan.swing}`;
      return;
    }
    $("section").textContent = plan.kind === "ending" ? `${plan.section} · ending` : plan.section;
    $("bar").textContent = `bar ${plan.barInSection + 1} of ${plan.sectionBars}${plan.repeated.length ? ` · repeated ${plan.repeated.join(", ")}` : ""}`;
    $("chord").textContent = plan.chords.join("  ");
    $("feel").textContent =
      `${genreName(plan.genre)} · swing ${plan.swing} · ${FEEL_LABEL[plan.feel]}` + (plan.stingers.length ? ` · ${plan.stingers.join(" + ")}` : "");
    ($("intensity") as HTMLElement).style.width = `${plan.intensity * 100}%`;
    ($("target") as HTMLElement).style.left = `calc(${plan.target * 100}% - 1px)`;
    $("intensity-num").textContent = `${plan.intensity.toFixed(2)} → ${plan.target.toFixed(2)}`;
    [...this.formEl.children].forEach((li, i) => li.classList.toggle("current", i === plan.formPos));
    this.renderLayers(plan.layers, plan.lineup);
    for (const m of plan.moves) this.move(m, plan.bar);
  }

  /** Who is in the band before the first bar (the page sets it from the lineup picker). */
  lineup: Part[] = [...V01_PARTS];

  private renderLayers(on: string[], lineup: Part[]): void {
    $("layers").replaceChildren(
      ...lineup.map((p) => Object.assign(document.createElement("span"), { className: `chip ${on.includes(p) ? "on" : "off"}`, textContent: PART_LABELS[p] })),
    );
  }

  /** Show the lineup while nothing plays. */
  showLineup(lineup: Part[]): void {
    this.lineup = lineup;
    this.renderLayers(lineup, lineup);
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
    $("heard").textContent = `hearing: ${parts.join(" · ")}`;
  }

  move(m: MoveRecord, bar: number): void {
    const reason = this.blind && m.source !== "you" ? "" : m.move.reason;
    if (m.status === "applied" && (m.move.reason || this.blind)) {
      $("last-move").textContent = m.label;
      $("last-reason").textContent = reason ?? "";
    }
    this.line(
      m.status,
      `bar ${bar} ${m.status.padEnd(8)} ${m.label}`,
      this.blind && m.source !== "you" ? "band" : m.source,
      [reason && `“${reason}”`, m.note && `(${m.note})`].filter(Boolean).join(" "),
    );
  }

  note(text: string): void {
    this.line("note", text);
  }

  private line(cls: string, text: string, source?: string, extra?: string): void {
    const li = document.createElement("li");
    li.className = cls;
    li.append(text);
    if (source) li.append(" ", Object.assign(document.createElement("span"), { className: "src", textContent: `[${source}]` }));
    if (extra) li.append(" ", extra);
    this.log.prepend(li);
    while (this.log.children.length > 80) this.log.lastChild!.remove();
  }

  leaderStatus(text: string): void {
    $("leader-status").textContent = text;
  }
}
