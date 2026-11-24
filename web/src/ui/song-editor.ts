// Visual in-page Song Creator & Play-In progression UI (v0.7).
// Swaps cleanly in place of Stage (just like RecapView). Produces schema-valid
// ChartJSON without requiring users to edit raw JSON.

import type { ChartJSON, SectionJSON } from "../core/chart";
import { allGenres, genreIds } from "../core/genres";
import { createBlankChart, isValidBarChord, normalizeDraft, resizeSectionChords } from "../core/song-editor";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface SongEditorCallbacks {
  onClose(): void;
  onUse(chart: ChartJSON, source: string, savedId?: string): void;
  onSave(chart: ChartJSON, existingId?: string): string;
  onAskAi?: (prompt: string) => Promise<{ chart: unknown; label: string; latencyMs: number }>;
  canAskAi: () => boolean;
  /** Start/stop Play-In metronome capture for a section; invokes onDone(chords, key) when finished. */
  onStartPlayIn(opts: {
    bpm: number;
    bpb: number;
    bars: number;
    genre: string;
    onProgress: (bar: number, total: number, chord: string | null) => void;
    onDone: (chords: string[], key: string | null) => void;
  }): () => void;
}

export class SongEditorView {
  private root: HTMLElement;
  private draft: ChartJSON = createBlankChart();
  private savedId: string | undefined;
  private stopPlayIn: (() => void) | null = null;
  private playInSectionIdx: number | null = null;

  constructor(private cb: SongEditorCallbacks) {
    this.root = $("editor-view");

    // Populate genre selector
    const gSel = $<HTMLSelectElement>("ed-genre");
    gSel.replaceChildren(...allGenres().map((g) => new Option(g.name, g.id)));

    $("ed-back").onclick = () => this.close();
    $("ed-new").onclick = () => {
      this.cancelPlayIn();
      this.savedId = undefined;
      this.draft = createBlankChart($<HTMLSelectElement>("ed-genre").value || "funk");
      this.render();
    };
    $("ed-save").onclick = () => this.saveDraft();
    $("ed-use").onclick = () => this.useDraft();
    $("ed-add-section").onclick = () => this.addSection();
    $("ed-ai-go").onclick = () => void this.runAiDraft();
    $("ed-raw-apply").onclick = () => this.applyRawJson();

    // Top metadata bindings
    $("ed-title").addEventListener("input", () => {
      this.draft.title = ($("ed-title") as HTMLInputElement).value;
      this.syncValidation();
    });
    $("ed-bpm").addEventListener("input", () => {
      this.draft.bpm = Number(($("ed-bpm") as HTMLInputElement).value) || 100;
      this.syncValidation();
    });
    $("ed-timesig").addEventListener("change", () => {
      this.draft.time_sig = ($("ed-timesig") as HTMLSelectElement).value;
      this.syncValidation();
    });
    $("ed-key").addEventListener("input", () => {
      const v = ($("ed-key") as HTMLInputElement).value.trim();
      if (v) this.draft.key = v;
      else delete this.draft.key;
      this.syncValidation();
    });
    $("ed-genre").addEventListener("change", () => {
      this.draft.genre = ($("ed-genre") as HTMLSelectElement).value;
      this.syncValidation();
    });
    $("ed-swing").addEventListener("change", () => {
      const v = ($("ed-swing") as HTMLSelectElement).value;
      if (v === "") delete this.draft.swing;
      else this.draft.swing = Number(v);
      this.syncValidation();
    });
    $("ed-countin").addEventListener("change", () => {
      this.draft.count_in = Number(($("ed-countin") as HTMLSelectElement).value);
      this.syncValidation();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(chart: ChartJSON, savedId?: string): void {
    this.cancelPlayIn();
    this.draft = structuredClone(chart);
    this.savedId = savedId;
    $("stage").hidden = true;
    $("recap-view").hidden = true;
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    this.cancelPlayIn();
    this.root.hidden = true;
    $("stage").hidden = false;
    this.cb.onClose();
  }

  private cancelPlayIn(): void {
    this.stopPlayIn?.();
    this.stopPlayIn = null;
    this.playInSectionIdx = null;
    const status = document.getElementById("ed-playin-status");
    if (status) status.textContent = "";
  }

  private render(): void {
    const d = this.draft;
    ($("ed-title") as HTMLInputElement).value = d.title;
    ($("ed-bpm") as HTMLInputElement).value = String(d.bpm);
    ($("ed-timesig") as HTMLSelectElement).value = d.time_sig;
    ($("ed-key") as HTMLInputElement).value = d.key ?? "";
    ($("ed-genre") as HTMLSelectElement).value = d.genre && genreIds().includes(d.genre) ? d.genre : "funk";
    ($("ed-swing") as HTMLSelectElement).value = d.swing === undefined ? "" : String(d.swing);
    ($("ed-countin") as HTMLSelectElement).value = String(d.count_in ?? 1);

    $("ed-ai-hint").textContent = this.cb.canAskAi()
      ? "Describe a vibe, key, form or tempo to draft a chart directly into the editor."
      : "Pick OpenAI-compatible or Claude under Studio → Leader to enable text-to-song.";
    $<HTMLButtonElement>("ed-ai-go").disabled = !this.cb.canAskAi();

    this.renderForm();
    this.renderSections();
    this.syncValidation();
  }

  private renderForm(): void {
    const list = $("ed-form-list");
    list.replaceChildren(
      ...this.draft.form.map((name, i) => {
        const pill = document.createElement("div");
        pill.className = "ed-form-pill";
        const left = Object.assign(document.createElement("button"), { type: "button", className: "ed-mini", textContent: "←", title: "Move left", disabled: i === 0 });
        const txt = Object.assign(document.createElement("span"), { textContent: name });
        const right = Object.assign(document.createElement("button"), { type: "button", className: "ed-mini", textContent: "→", title: "Move right", disabled: i === this.draft.form.length - 1 });
        const del = Object.assign(document.createElement("button"), { type: "button", className: "ed-mini ed-del", textContent: "×", title: "Remove from form", disabled: this.draft.form.length <= 1 });
        left.onclick = () => {
          [this.draft.form[i - 1], this.draft.form[i]] = [this.draft.form[i], this.draft.form[i - 1]];
          this.renderForm();
          this.syncValidation();
        };
        right.onclick = () => {
          [this.draft.form[i + 1], this.draft.form[i]] = [this.draft.form[i], this.draft.form[i + 1]];
          this.renderForm();
          this.syncValidation();
        };
        del.onclick = () => {
          this.draft.form.splice(i, 1);
          this.renderForm();
          this.syncValidation();
        };
        pill.append(left, txt, right, del);
        return pill;
      }),
    );

    const addBar = $("ed-form-add");
    addBar.replaceChildren(
      ...this.draft.sections.map((s) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "ghost-btn small", textContent: `+ ${s.name}` });
        b.onclick = () => {
          this.draft.form.push(s.name);
          this.renderForm();
          this.syncValidation();
        };
        return b;
      }),
    );
  }

  private renderSections(): void {
    const host = $("ed-sections");
    host.replaceChildren(
      ...this.draft.sections.map((sec, idx) => {
        const card = document.createElement("div");
        card.className = "ed-section";

        const head = document.createElement("div");
        head.className = "ed-sec-head";

        const nameIn = Object.assign(document.createElement("input"), { type: "text", className: "ed-sec-name", value: sec.name, "aria-label": "Section name" });
        nameIn.onchange = () => {
          const oldName = sec.name;
          const next = nameIn.value.trim().replace(/[^A-Za-z0-9_-]/g, "_") || `part_${idx + 1}`;
          sec.name = next;
          nameIn.value = next;
          this.draft.form = this.draft.form.map((f) => (f === oldName ? next : f));
          this.renderForm();
          this.syncValidation();
        };

        const barsWrap = document.createElement("label");
        barsWrap.className = "inline small";
        const barsIn = Object.assign(document.createElement("input"), { type: "number", className: "ed-num", min: "1", max: "64", value: String(sec.bars) });
        barsIn.onchange = () => {
          const nextBars = Math.max(1, Math.min(64, Math.floor(Number(barsIn.value) || 4)));
          sec.bars = nextBars;
          barsIn.value = String(nextBars);
          if (sec.chords.length > nextBars) sec.chords = sec.chords.slice(0, nextBars);
          this.renderSections();
          this.syncValidation();
        };
        barsWrap.append("Bars", barsIn);

        const intWrap = document.createElement("label");
        intWrap.className = "inline small";
        const intIn = Object.assign(document.createElement("input"), {
          type: "range",
          min: "0.1",
          max: "1",
          step: "0.05",
          value: String(sec.intensity ?? 0.5),
          className: "ed-int",
        });
        const intVal = Object.assign(document.createElement("span"), { className: "dim tabular", textContent: `${Math.round((sec.intensity ?? 0.5) * 100)}%` });
        intIn.oninput = () => {
          sec.intensity = Number(intIn.value);
          intVal.textContent = `${Math.round(sec.intensity * 100)}%`;
          this.syncValidation();
        };
        intWrap.append("Level", intIn, intVal);

        const cymSel = document.createElement("select");
        cymSel.className = "ed-cym";
        cymSel.replaceChildren(new Option("cymbal: auto", ""), new Option("hi-hat", "hat"), new Option("ride", "ride"));
        cymSel.value = sec.cymbal ?? "";
        cymSel.onchange = () => {
          if (cymSel.value === "hat" || cymSel.value === "ride") sec.cymbal = cymSel.value;
          else delete sec.cymbal;
          this.syncValidation();
        };

        const playInBtn = Object.assign(document.createElement("button"), {
          type: "button",
          className: `ghost-btn small${this.playInSectionIdx === idx ? " active-rec" : ""}`,
          textContent: this.playInSectionIdx === idx ? "Stop play-in" : "Play in chords",
          title: "Hear a click track and play your progression on MIDI, keys or guitar to fill this section",
        });
        playInBtn.onclick = () => this.togglePlayIn(idx);

        const dupBtn = Object.assign(document.createElement("button"), { type: "button", className: "ghost-btn small", textContent: "Duplicate" });
        dupBtn.onclick = () => {
          const copy: SectionJSON = structuredClone(sec);
          copy.name = this.uniqueName(sec.name);
          this.draft.sections.splice(idx + 1, 0, copy);
          this.draft.form.push(copy.name);
          this.render();
        };

        const delBtn = Object.assign(document.createElement("button"), {
          type: "button",
          className: "ghost-btn small",
          textContent: "Delete",
          disabled: this.draft.sections.length <= 1,
        });
        delBtn.onclick = () => {
          const removed = this.draft.sections.splice(idx, 1)[0];
          this.draft.form = this.draft.form.filter((f) => f !== removed.name);
          if (!this.draft.form.length && this.draft.sections[0]) this.draft.form.push(this.draft.sections[0].name);
          this.render();
        };

        head.append(nameIn, barsWrap, intWrap, cymSel, playInBtn, dupBtn, delBtn);

        // Chord grid (shows one slot per bar in sec.chords, plus + / - bar slot buttons)
        const grid = document.createElement("div");
        grid.className = "ed-chord-grid";
        sec.chords.forEach((ch, ci) => {
          const cell = document.createElement("div");
          cell.className = "ed-chord-cell";
          const num = Object.assign(document.createElement("span"), { className: "ed-bar-num tabular", textContent: String(ci + 1) });
          const inp = Object.assign(document.createElement("input"), {
            type: "text",
            value: ch,
            placeholder: "Am7",
            className: `ed-chord-in${isValidBarChord(ch) ? "" : " bad"}`,
            spellcheck: false,
            "aria-label": `${sec.name} bar ${ci + 1} chord`,
          });
          inp.oninput = () => {
            sec.chords[ci] = inp.value;
            inp.classList.toggle("bad", !isValidBarChord(inp.value));
            this.syncValidation();
          };
          cell.append(num, inp);
          grid.append(cell);
        });

        const gridFoot = document.createElement("div");
        gridFoot.className = "ed-grid-foot";
        const addBarBtn = Object.assign(document.createElement("button"), { type: "button", className: "ghost-btn small", textContent: "+ Chord bar" });
        addBarBtn.onclick = () => {
          sec.chords.push(sec.chords[sec.chords.length - 1] ?? "Am7");
          if (sec.chords.length > sec.bars) sec.bars = sec.chords.length;
          this.renderSections();
          this.syncValidation();
        };
        const trimBarBtn = Object.assign(document.createElement("button"), {
          type: "button",
          className: "ghost-btn small",
          textContent: "− Last bar",
          disabled: sec.chords.length <= 1,
        });
        trimBarBtn.onclick = () => {
          if (sec.chords.length > 1) sec.chords.pop();
          this.renderSections();
          this.syncValidation();
        };
        const matchBtn = Object.assign(document.createElement("button"), {
          type: "button",
          className: "ghost-btn small",
          textContent: `Expand to ${sec.bars} bars`,
          hidden: sec.chords.length === sec.bars,
        });
        matchBtn.onclick = () => {
          sec.chords = resizeSectionChords(sec.chords, sec.bars);
          this.renderSections();
          this.syncValidation();
        };
        const hint = Object.assign(document.createElement("span"), {
          className: "dim small",
          textContent: sec.chords.length < sec.bars ? `Cycles ${sec.chords.length} chord bars across ${sec.bars} bars. Space splits a bar ("Fm Eb").` : 'Space splits a bar ("Fm Eb").',
        });
        gridFoot.append(addBarBtn, trimBarBtn, matchBtn, hint);

        card.append(head, grid, gridFoot);
        return card;
      }),
    );
  }

  private uniqueName(base: string): string {
    const names = new Set(this.draft.sections.map((s) => s.name));
    for (let i = 2; i < 50; i++) {
      const cand = `${base}_${i}`;
      if (!names.has(cand)) return cand;
    }
    return `part_${Date.now().toString(36)}`;
  }

  private addSection(): void {
    const presets = ["verse", "chorus", "bridge", "solo", "outro", "intro"];
    const used = new Set(this.draft.sections.map((s) => s.name));
    const name = presets.find((p) => !used.has(p)) ?? this.uniqueName("section");
    const sample = this.draft.sections[0]?.chords.slice(0, 4) ?? ["Am7", "F", "C", "G"];
    this.draft.sections.push({ name, bars: 4, chords: [...sample], intensity: 0.6 });
    this.draft.form.push(name);
    this.render();
  }

  private syncValidation(): { chart: ChartJSON; errors: string[] } {
    const res = normalizeDraft(this.draft);
    const bar = $("ed-validation");
    const totalBars = this.draft.form.reduce((sum, name) => sum + (this.draft.sections.find((s) => s.name === name)?.bars ?? 0), 0);
    if (res.errors.length) {
      bar.className = "ed-validation bad";
      bar.textContent = res.errors.join(" · ");
    } else {
      bar.className = "ed-validation ok";
      bar.textContent = `Valid chart · ${totalBars} bars · ${res.chart.sections.length} section${res.chart.sections.length === 1 ? "" : "s"}`;
    }
    $<HTMLButtonElement>("ed-save").disabled = res.errors.length > 0;
    $<HTMLButtonElement>("ed-use").disabled = res.errors.length > 0;
    const rawBox = $("ed-raw-json") as HTMLTextAreaElement;
    if (document.activeElement !== rawBox) rawBox.value = JSON.stringify(res.chart, null, 2);
    return res;
  }

  private applyRawJson(): void {
    const rawBox = $("ed-raw-json") as HTMLTextAreaElement;
    try {
      const parsed = JSON.parse(rawBox.value) as ChartJSON;
      const { chart, errors } = normalizeDraft(parsed);
      if (errors.length) {
        $("ed-validation").className = "ed-validation bad";
        $("ed-validation").textContent = errors.join(" · ");
        return;
      }
      this.draft = chart;
      this.render();
    } catch (e) {
      $("ed-validation").className = "ed-validation bad";
      $("ed-validation").textContent = `Invalid JSON: ${(e as Error).message}`;
    }
  }

  private saveDraft(): void {
    const { chart, errors } = this.syncValidation();
    if (errors.length) return;
    this.savedId = this.cb.onSave(chart, this.savedId);
    $("ed-validation").className = "ed-validation ok";
    $("ed-validation").textContent = `Saved "${chart.title}" in this browser.`;
  }

  private useDraft(): void {
    const { chart, errors } = this.syncValidation();
    if (errors.length) return;
    this.savedId = this.cb.onSave(chart, this.savedId);
    this.cb.onUse(chart, "song creator", this.savedId);
    this.close();
  }

  private async runAiDraft(): Promise<void> {
    const prompt = ($("ed-ai-prompt") as HTMLInputElement).value.trim();
    if (!prompt || !this.cb.onAskAi) return;
    const btn = $<HTMLButtonElement>("ed-ai-go");
    const status = $("ed-ai-hint");
    btn.disabled = true;
    status.textContent = "Writing chart…";
    try {
      const res = await this.cb.onAskAi(prompt);
      const { chart, errors } = normalizeDraft(res.chart as ChartJSON);
      this.draft = chart;
      this.savedId = undefined;
      this.render();
      status.textContent = errors.length
        ? `${res.label} drafted a chart with ${errors.length} issue(s) to fix below.`
        : `${res.label} wrote "${chart.title}" in ${res.latencyMs} ms.`;
    } catch (e) {
      status.textContent = `Couldn't write chart: ${(e as Error).message}`;
    } finally {
      btn.disabled = !this.cb.canAskAi();
    }
  }

  private togglePlayIn(idx: number): void {
    if (this.playInSectionIdx === idx) {
      this.cancelPlayIn();
      this.renderSections();
      return;
    }
    this.cancelPlayIn();
    const sec = this.draft.sections[idx];
    if (!sec) return;
    const bpb = Number(this.draft.time_sig.split("/")[0]) || 4;
    const captureBars = Math.min(8, Math.max(2, sec.bars));
    this.playInSectionIdx = idx;
    this.renderSections();
    const status = $("ed-playin-status");
    status.textContent = `Play in ${captureBars} bars for "${sec.name}" at ${this.draft.bpm} bpm…`;
    this.stopPlayIn = this.cb.onStartPlayIn({
      bpm: this.draft.bpm,
      bpb,
      bars: captureBars,
      genre: this.draft.genre ?? "funk",
      onProgress: (bar, total, chord) => {
        status.textContent = `Play-in "${sec.name}": bar ${bar + 1}/${total}${chord ? ` → heard ${chord}` : ""}`;
      },
      onDone: (chords, key) => {
        sec.chords = chords;
        if (!this.draft.key && key) this.draft.key = key;
        this.stopPlayIn = null;
        this.playInSectionIdx = null;
        status.textContent = `Captured ${chords.join(" → ")} for "${sec.name}".`;
        this.render();
      },
    });
  }
}
