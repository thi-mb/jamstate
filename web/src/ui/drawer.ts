// Collapsible Studio drawer with 4 persisted tabs (v0.6).

import type { KeyValueStore } from "../core/platform";

export type StudioTab = "setup" | "song" | "leader" | "sessions";
const TABS: StudioTab[] = ["setup", "song", "leader", "sessions"];
const TAB_KEY = "jamstate.studioTab";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class StudioDrawer {
  private openState = false;
  private tab: StudioTab = "setup";
  private drawer: HTMLElement;
  private backdrop: HTMLElement;
  private toggleBtn: HTMLButtonElement;

  constructor(private settings: KeyValueStore) {
    this.drawer = $("studio-drawer");
    this.backdrop = $("drawer-backdrop");
    this.toggleBtn = $<HTMLButtonElement>("studio-toggle");

    const saved = settings.get<StudioTab>(TAB_KEY);
    this.tab = saved && TABS.includes(saved) ? saved : "song";
    this.selectTab(this.tab, false);

    this.toggleBtn.onclick = () => this.toggle();
    $("studio-close").onclick = () => this.close();
    this.backdrop.onclick = () => this.close();

    for (const btn of this.drawer.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      btn.onclick = () => {
        const t = btn.dataset.tab as StudioTab;
        if (TABS.includes(t)) this.selectTab(t);
      };
    }

    // Top-bar quick pills open directly to their Studio tab.
    for (const trigger of document.querySelectorAll<HTMLElement>("[data-open-tab]")) {
      trigger.onclick = () => {
        const t = trigger.dataset.openTab as StudioTab;
        if (TABS.includes(t)) this.open(t);
      };
    }

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.openState) this.close();
    });
  }

  get isOpen(): boolean {
    return this.openState;
  }

  get activeTab(): StudioTab {
    return this.tab;
  }

  open(tab?: StudioTab): void {
    if (tab && TABS.includes(tab)) this.selectTab(tab);
    this.openState = true;
    this.drawer.classList.add("open");
    this.drawer.setAttribute("aria-hidden", "false");
    this.backdrop.hidden = false;
    this.toggleBtn.setAttribute("aria-expanded", "true");
    document.body.classList.add("drawer-open");
  }

  close(): void {
    this.openState = false;
    this.drawer.classList.remove("open");
    this.drawer.setAttribute("aria-hidden", "true");
    this.backdrop.hidden = true;
    this.toggleBtn.setAttribute("aria-expanded", "false");
    document.body.classList.remove("drawer-open");
  }

  toggle(): void {
    if (this.openState) this.close();
    else this.open();
  }

  selectTab(tab: StudioTab, persist = true): void {
    this.tab = tab;
    if (persist) this.settings.set(TAB_KEY, tab);
    for (const btn of this.drawer.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", String(on));
    }
    for (const panel of this.drawer.querySelectorAll<HTMLElement>("[data-panel]")) {
      panel.hidden = panel.dataset.panel !== tab;
    }
  }
}
