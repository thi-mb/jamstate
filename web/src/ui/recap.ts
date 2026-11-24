// Post-jam Session Recap UI (v0.6): interactive SVG energy/intensity timeline
// with section blocks, clickable bars to jump replay, move/cue pins, narrative
// summary (fallback + optional LLM), and MIDI / WAV / JSON export.

import { buildRecap, type RecapBar, type RecapData, type RecapMove } from "../core/recap";
import { isBlind } from "../core/brain";
import type { SessionFile } from "../core/session";
import { PLAYER_SOURCES } from "../core/session";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export interface RecapCallbacks {
  onBack(): void;
  onPlayFrom(file: SessionFile, startBar: number): void;
  onStopReplay(): void;
  onExportMidi(file: SessionFile): void;
  onExportWav(file: SessionFile, includeRawAudio: boolean): Promise<void>;
  onExportJson(file: SessionFile): void;
  onSummarize?: (recap: RecapData) => Promise<{ summary: string; model?: string; latencyMs: number }>;
  canSummarize: () => boolean;
}

export class RecapView {
  private root: HTMLElement;
  private file: SessionFile | null = null;
  private data: RecapData | null = null;
  private playingBar: number | null = null;
  private playheadLine: SVGLineElement | null = null;
  private barCells: SVGRectElement[] = [];
  private hasRawAudio = false;

  constructor(private cb: RecapCallbacks) {
    this.root = $("recap-view");
    $("recap-back").onclick = () => {
      this.close();
      this.cb.onBack();
    };
    $("recap-play").onclick = () => {
      if (!this.file) return;
      if (this.playingBar !== null) this.cb.onStopReplay();
      else this.cb.onPlayFrom(this.file, 0);
    };
    $("recap-midi").onclick = () => {
      if (this.file) this.cb.onExportMidi(this.file);
    };
    $("recap-wav").onclick = () => void this.exportWav();
    $("recap-json").onclick = () => {
      if (this.file) this.cb.onExportJson(this.file);
    };
    $("recap-ai-btn").onclick = () => void this.runAiSummary();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get currentFile(): SessionFile | null {
    return this.file;
  }

  open(file: SessionFile, opts: { hasRawAudio?: boolean } = {}): void {
    this.file = file;
    this.hasRawAudio = !!opts.hasRawAudio;
    this.data = buildRecap(file);
    this.playingBar = null;

    $("stage").hidden = true;
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    this.root.hidden = true;
    $("stage").hidden = false;
  }

  setPlayingBar(barIndex: number | null): void {
    this.playingBar = barIndex;
    const playBtn = $<HTMLButtonElement>("recap-play");
    playBtn.textContent = barIndex !== null ? "Stop replay" : "Replay";
    for (let i = 0; i < this.barCells.length; i++) {
      this.barCells[i].classList.toggle("playing", barIndex === i);
    }
    if (this.playheadLine && this.data && this.data.bars.length) {
      if (barIndex === null) {
        this.playheadLine.setAttribute("visibility", "hidden");
      } else {
        const w = 960;
        const padL = 36;
        const padR = 16;
        const plotW = w - padL - padR;
        const x = padL + ((barIndex + 0.5) / this.data.bars.length) * plotW;
        this.playheadLine.setAttribute("x1", String(x));
        this.playheadLine.setAttribute("x2", String(x));
        this.playheadLine.setAttribute("visibility", "visible");
      }
    }
  }

  private render(): void {
    const d = this.data;
    const f = this.file;
    if (!d || !f) return;

    const leaderText = isBlind(d.leader) ? "hidden brain (blind)" : d.leader;
    $("recap-title").textContent = d.title;
    $("recap-meta").textContent = `${d.genreName} · ${d.bpm} bpm · ${fmtDuration(d.durationSec)} · leader: ${leaderText}`;

    // Stats strip
    const statItems: [string, string][] = [
      ["Bars", String(d.stats.playedBars)],
      ["Peak intensity", `${Math.round(d.stats.peakIntensity * 100)}% (${d.stats.peakSection})`],
      ["Your avg energy", `${Math.round(d.stats.meanPlayerEnergy * 100)}%`],
      ["Bandleader moves", String(d.stats.leaderMoves)],
      ["Cues", String(d.stats.playerCues)],
    ];
    if (d.stats.tradedSolos > 0) statItems.push(["Traded solos", String(d.stats.tradedSolos)]);
    $("recap-stats").replaceChildren(
      ...statItems.map(([label, val]) => {
        const card = document.createElement("div");
        card.className = "recap-stat";
        card.append(
          Object.assign(document.createElement("div"), { className: "label", textContent: label }),
          Object.assign(document.createElement("div"), { className: "recap-stat-val", textContent: val }),
        );
        return card;
      }),
    );

    // Summary
    $("recap-summary-text").textContent = d.fallbackSummary;
    $("recap-summary-meta").textContent = "Instant recap";
    const aiBtn = $<HTMLButtonElement>("recap-ai-btn");
    const canAi = this.cb.canSummarize() && !isBlind(d.leader);
    aiBtn.hidden = !canAi;
    aiBtn.disabled = false;
    aiBtn.textContent = "Summarize with AI";

    // Raw audio mix checkbox (only when the kept guitar WAV is available in memory)
    const rawWrap = $("recap-raw-wrap");
    rawWrap.hidden = !this.hasRawAudio;
    $<HTMLInputElement>("recap-include-raw").checked = this.hasRawAudio;
    $("recap-export-status").textContent = "";

    // Interactive SVG timeline
    this.renderTimeline(d);
    this.renderMoveList(d);
    this.inspectBar(d.bars[0] ?? null, []);
  }

  private renderTimeline(d: RecapData): void {
    const host = $("recap-timeline");
    host.replaceChildren();
    this.barCells = [];
    this.playheadLine = null;
    if (!d.bars.length) {
      host.textContent = "No bars recorded.";
      return;
    }

    const W = 960;
    const H = 220;
    const padL = 36;
    const padR = 16;
    const secH = 26;
    const plotTop = secH + 12;
    const plotBot = H - 28;
    const plotW = W - padL - padR;
    const plotH = plotBot - plotTop;
    const n = d.bars.length;
    const barW = plotW / n;
    const xOf = (i: number) => padL + (i + 0.5) * barW;
    const yOf = (v: number) => plotBot - Math.max(0, Math.min(1, v)) * plotH;

    const svg = svgEl("svg", {
      viewBox: `0 0 ${W} ${H}`,
      class: "recap-svg",
      role: "img",
      "aria-label": "Session energy and intensity timeline — click any bar to replay from there",
    });

    // Defs for subtle area gradients
    const defs = svgEl("defs");
    const mkGrad = (id: string, color: string) => {
      const g = svgEl("linearGradient", { id, x1: "0", y1: "0", x2: "0", y2: "1" });
      g.append(
        svgEl("stop", { offset: "0%", "stop-color": color, "stop-opacity": "0.28" }),
        svgEl("stop", { offset: "100%", "stop-color": color, "stop-opacity": "0.02" }),
      );
      return g;
    };
    defs.append(mkGrad("grad-band", "#f2a541"), mkGrad("grad-player", "#5cc8ff"));
    svg.append(defs);

    // Horizontal guide lines (0%, 50%, 100%)
    for (const frac of [0, 0.5, 1]) {
      const y = yOf(frac);
      svg.append(svgEl("line", { x1: padL, x2: W - padR, y1: y, y2: y, class: "recap-grid" }));
      const lbl = svgEl("text", { x: padL - 6, y: y + 4, "text-anchor": "end", class: "recap-axis" });
      lbl.textContent = `${Math.round(frac * 100)}`;
      svg.append(lbl);
    }

    // Proportional section bands
    d.sections.forEach((sec, idx) => {
      const x = padL + sec.startIndex * barW;
      const w = Math.max(2, sec.bars * barW - 2);
      const rect = svgEl("rect", {
        x,
        y: 2,
        width: w,
        height: secH - 4,
        rx: 4,
        class: `recap-sec ${sec.section === "count-in" ? "count-in" : idx % 2 === 0 ? "even" : "odd"}`,
      });
      svg.append(rect);
      if (w > 34) {
        const text = svgEl("text", { x: x + 6, y: 16, class: "recap-sec-label" });
        text.textContent = sec.section;
        svg.append(text);
      }
      // Section divider line
      if (idx > 0) {
        svg.append(svgEl("line", { x1: x, x2: x, y1: plotTop, y2: plotBot, class: "recap-sec-div" }));
      }
    });

    // Dual curves: band intensity & player energy
    const bandPts = d.bars.map((b, i) => `${xOf(i).toFixed(1)},${yOf(b.intensity).toFixed(1)}`);
    const playerPts = d.bars.map((b, i) => `${xOf(i).toFixed(1)},${yOf(b.playerEnergy).toFixed(1)}`);

    const areaPath = (pts: string[]) =>
      `M ${xOf(0).toFixed(1)},${plotBot} L ${pts.join(" L ")} L ${xOf(n - 1).toFixed(1)},${plotBot} Z`;

    svg.append(svgEl("path", { d: areaPath(playerPts), fill: "url(#grad-player)" }));
    svg.append(svgEl("path", { d: areaPath(bandPts), fill: "url(#grad-band)" }));
    svg.append(svgEl("polyline", { points: playerPts.join(" "), fill: "none", class: "recap-line-player" }));
    svg.append(svgEl("polyline", { points: bandPts.join(" "), fill: "none", class: "recap-line-band" }));

    // Moves grouped by bar index
    const movesByBar = new Map<number, RecapMove[]>();
    for (const m of d.moves) {
      const list = movesByBar.get(m.index) ?? [];
      list.push(m);
      movesByBar.set(m.index, list);
    }

    // Clickable bar hit targets
    for (let i = 0; i < n; i++) {
      const b = d.bars[i];
      const barMoves = movesByBar.get(i) ?? [];
      const rect = svgEl("rect", {
        x: padL + i * barW,
        y: plotTop,
        width: Math.max(1, barW),
        height: plotH,
        class: "recap-bar-hit",
        "data-bar": i,
      });
      rect.addEventListener("mouseenter", () => this.inspectBar(b, barMoves));
      rect.addEventListener("click", () => {
        this.inspectBar(b, barMoves);
        if (this.file) this.cb.onPlayFrom(this.file, i);
      });
      this.barCells.push(rect);
      svg.append(rect);

      // Bar tick labels every 4 or 8 bars
      const step = n > 48 ? 8 : n > 20 ? 4 : 2;
      if (i % step === 0 || i === n - 1) {
        const t = svgEl("text", { x: xOf(i), y: H - 8, "text-anchor": "middle", class: "recap-axis" });
        t.textContent = String(b.bar + 1);
        svg.append(t);
      }
    }

    // Move & cue pin markers
    for (const [idx, list] of movesByBar) {
      const b = d.bars[idx];
      if (!b) continue;
      const isCue = list.some((m) => PLAYER_SOURCES.has(m.source));
      const pin = svgEl("circle", {
        cx: xOf(idx),
        cy: yOf(b.intensity),
        r: isCue ? 5 : 4,
        class: isCue ? "recap-pin-cue" : "recap-pin-move",
      });
      pin.addEventListener("mouseenter", () => this.inspectBar(b, list));
      pin.addEventListener("click", () => {
        this.inspectBar(b, list);
        if (this.file) this.cb.onPlayFrom(this.file, idx);
      });
      svg.append(pin);
    }

    // Playhead line (shown during replay)
    this.playheadLine = svgEl("line", {
      x1: padL,
      x2: padL,
      y1: plotTop,
      y2: plotBot,
      class: "recap-playhead",
      visibility: "hidden",
    });
    svg.append(this.playheadLine);

    host.append(svg);
  }

  private inspectBar(b: RecapBar | null, moves: RecapMove[]): void {
    const el = $("recap-inspector");
    if (!b) {
      el.textContent = "Click any bar on the timeline to replay from there.";
      return;
    }
    const blind = this.data ? isBlind(this.data.leader) : false;
    const head = `Bar ${b.bar + 1} · ${b.kind === "count_in" ? "count-in" : b.section} · ${b.chords.join(" ") || "–"} · band ${Math.round(b.intensity * 100)}% · you ${Math.round(b.playerEnergy * 100)}% (${b.playerNotes} note${b.playerNotes === 1 ? "" : "s"})`;
    const moveDesc = moves.length
      ? " — " +
        moves
          .map((m) => {
            const src = blind && !PLAYER_SOURCES.has(m.source) ? "bandleader" : m.source;
            const reason = blind && !PLAYER_SOURCES.has(m.source) ? "" : m.reason ? `: “${m.reason}”` : "";
            return `${m.label} [${src}]${reason}`;
          })
          .join("; ")
      : " · click bar to replay from here";
    el.textContent = head + moveDesc;
  }

  private renderMoveList(d: RecapData): void {
    const ul = $("recap-moves");
    if (!d.moves.length) {
      ul.replaceChildren(Object.assign(document.createElement("li"), { className: "dim", textContent: "No bandleader moves or cues in this take." }));
      return;
    }
    const blind = isBlind(d.leader);
    ul.replaceChildren(
      ...d.moves.map((m) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.className = "recap-move-row";
        const isCue = PLAYER_SOURCES.has(m.source);
        const src = blind && !isCue ? "bandleader" : m.source;
        const reason = blind && !isCue ? "" : m.reason ? ` — ${m.reason}` : "";
        btn.innerHTML = `<span class="rm-bar">bar ${m.bar + 1}</span> <span class="rm-label"></span> <span class="rm-src"></span> <span class="rm-reason"></span>`;
        btn.querySelector(".rm-label")!.textContent = m.label;
        btn.querySelector(".rm-src")!.textContent = `[${src}]`;
        btn.querySelector(".rm-reason")!.textContent = reason;
        btn.onclick = () => this.file && this.cb.onPlayFrom(this.file, m.index);
        li.append(btn);
        return li;
      }),
    );
  }

  private async runAiSummary(): Promise<void> {
    if (!this.data || !this.cb.onSummarize) return;
    const btn = $<HTMLButtonElement>("recap-ai-btn");
    btn.disabled = true;
    btn.textContent = "Summarizing…";
    try {
      const res = await this.cb.onSummarize(this.data);
      $("recap-summary-text").textContent = res.summary;
      $("recap-summary-meta").textContent = `${res.model ?? "AI"} · ${res.latencyMs} ms`;
      btn.textContent = "Regenerate";
    } catch (e) {
      $("recap-summary-meta").textContent = `AI summary unavailable: ${(e as Error).message}`;
      btn.textContent = "Retry AI summary";
    } finally {
      btn.disabled = false;
    }
  }

  private async exportWav(): Promise<void> {
    if (!this.file) return;
    const btn = $<HTMLButtonElement>("recap-wav");
    const status = $("recap-export-status");
    btn.disabled = true;
    status.textContent = "Rendering stereo WAV mixdown…";
    try {
      const includeRaw = this.hasRawAudio && $<HTMLInputElement>("recap-include-raw").checked;
      await this.cb.onExportWav(this.file, includeRaw);
      status.textContent = "WAV mixdown downloaded.";
    } catch (e) {
      status.textContent = `WAV export failed: ${(e as Error).message}`;
    } finally {
      btn.disabled = false;
    }
  }
}
