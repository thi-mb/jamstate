// A ~25 ms heartbeat from a Worker, so main-thread work (UI, fetches) can't
// starve the scheduler. Falls back to setInterval if Workers are unavailable.

const WORKER_SRC = `let id=null;onmessage=(e)=>{if(e.data==="start"){clearInterval(id);id=setInterval(()=>postMessage(0),${25});}else{clearInterval(id);id=null;}}`;

export class Ticker {
  private worker: Worker | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private onTick: () => void) {}

  start(): void {
    this.stop();
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
      this.worker = new Worker(url);
      this.worker.onmessage = () => this.onTick();
      this.worker.postMessage("start");
    } catch {
      this.interval = setInterval(this.onTick, 25);
    }
  }

  stop(): void {
    this.worker?.postMessage("stop");
    this.worker?.terminate();
    this.worker = null;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }
}
