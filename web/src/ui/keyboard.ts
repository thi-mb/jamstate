// Computer keyboard as a piano, so the band can be tested with no MIDI gear.

const CODES: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};

export function attachKeyboard(handler: (on: boolean, note: number, vel: number) => void): () => void {
  let octave = 60;
  const down = new Map<string, number>();
  const isTyping = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable);
  };
  const onDown = (e: KeyboardEvent) => {
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "KeyZ") return void (octave = Math.max(36, octave - 12));
    if (e.code === "KeyX") return void (octave = Math.min(84, octave + 12));
    const off = CODES[e.code];
    if (off === undefined || e.repeat || down.has(e.code)) return;
    e.preventDefault();
    const note = octave + off;
    down.set(e.code, note);
    handler(true, note, e.shiftKey ? 118 : 78);
  };
  const onUp = (e: KeyboardEvent) => {
    const note = down.get(e.code);
    if (note === undefined) return;
    down.delete(e.code);
    handler(false, note, 0);
  };
  const onBlur = () => {
    for (const note of down.values()) handler(false, note, 0);
    down.clear();
  };
  window.addEventListener("keydown", onDown);
  window.addEventListener("keyup", onUp);
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("keydown", onDown);
    window.removeEventListener("keyup", onUp);
    window.removeEventListener("blur", onBlur);
  };
}
