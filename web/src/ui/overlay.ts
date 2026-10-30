// The on-screen overlay: reads plans and decisions, never writes engine state.

import type { BarPlan, MoveRecord } from "../core/engine";
import type { BarFeatures } from "../core/features";
import { PARTS } from "../core/types";

const $ = (id: string) => document.getElementById(id)!;

const FEEL_LABEL = { normal: "normal feel", half_time: "half time", double_time: "double time" } as const;

export class Overlay {
  private formEl = $("form");
  private log = $("log");

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
    this.log.replaceChildren();
    this.renderLayers([...PARTS]);
  }

  bar(plan: BarPlan): void {
    $("section").textContent = plan.section;
    $("bar").textContent = `bar ${plan.barInSection + 1} of ${plan.sectionBars}${plan.repeated.length ? ` · repeated ${plan.repeated.join(", ")}` : ""}`;
    $("chord").textContent = plan.chords.join("  ");
    $("feel").textContent = FEEL_LABEL[plan.feel] + (plan.stingers.length ? ` · ${plan.stingers.join(" + ")}` : "");
    ($("intensity") as HTMLElement).style.width = `${plan.intensity * 100}%`;
    ($("target") as HTMLElement).style.left = `calc(${plan.target * 100}% - 1px)`;
    $("intensity-num").textContent = `${plan.intensity.toFixed(2)} → ${plan.target.toFixed(2)}`;
    [...this.formEl.children].forEach((li, i) => li.classList.toggle("current", i === plan.formPos));
    this.renderLayers(plan.layers);
    for (const m of plan.moves) this.move(m, plan.bar);
  }

  private renderLayers(on: string[]): void {
    $("layers").replaceChildren(
      ...PARTS.map((p) => Object.assign(document.createElement("span"), { className: `chip ${on.includes(p) ? "on" : "off"}`, textContent: p })),
    );
  }

  setEnergy(f: BarFeatures | null): void {
    ($("energy") as HTMLElement).style.width = `${(f?.energy ?? 0) * 100}%`;
    $("energy-num").textContent = f ? `${f.energy.toFixed(2)} · ${f.noteCount} note${f.noteCount === 1 ? "" : "s"}` : "";
  }

  move(m: MoveRecord, bar: number): void {
    if (m.status === "applied" && m.move.reason) {
      $("last-move").textContent = m.label;
      $("last-reason").textContent = m.move.reason;
    }
    this.line(
      m.status,
      `bar ${bar} ${m.status.padEnd(8)} ${m.label}`,
      m.source,
      [m.move.reason && `“${m.move.reason}”`, m.note && `(${m.note})`].filter(Boolean).join(" "),
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
