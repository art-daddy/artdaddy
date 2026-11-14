import { afterEach, describe, expect, it } from "vitest";

import {
  MOVE_ANNOUNCE_MS,
  PLAYHEAD_ACTIVE_MS,
  observeInput,
  observePlayback,
} from "./pcCheckSignals";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

describe("what the person's hands are doing", () => {
  const clock = (start = 1_000_000) => {
    const t = { now: start };
    return { t, now: () => t.now };
  };

  it("counts the moment the app was opened as an input, and each key, click, scroll and touch after it", () => {
    const { t, now } = clock();
    const target = new EventTarget();
    const heard: number[] = [];
    const observer = observeInput(target, now, () => heard.push(t.now));
    cleanup.push(observer.dispose);
    expect(observer.lastInputAtMs()).toBe(1_000_000);
    for (const name of ["keydown", "pointerdown", "wheel", "touchstart"]) {
      t.now += 10_000;
      target.dispatchEvent(new Event(name));
      expect(observer.lastInputAtMs(), name).toBe(t.now);
    }
    // every one of them was announced at once: a check that is running stops on the first key
    expect(heard).toEqual([1_010_000, 1_020_000, 1_030_000, 1_040_000]);
  });

  it("does not count what a person did not do: a key coming up, focus, a timer's own events", () => {
    const { t, now } = clock();
    const target = new EventTarget();
    const heard: number[] = [];
    const observer = observeInput(target, now, () => heard.push(t.now));
    cleanup.push(observer.dispose);
    t.now += 60_000;
    for (const name of ["keyup", "focus", "scroll", "resize", "visibilitychange", "message"])
      target.dispatchEvent(new Event(name));
    expect(observer.lastInputAtMs()).toBe(1_000_000);
    expect(heard).toEqual([]);
  });

  it("keeps the latest time on every pointer move but announces at most once every quarter second", () => {
    const { t, now } = clock();
    const target = new EventTarget();
    let announced = 0;
    const observer = observeInput(target, now, () => announced++);
    cleanup.push(observer.dispose);
    for (let i = 0; i < 10; i++) {
      t.now += 20;
      target.dispatchEvent(new Event("pointermove"));
    }
    expect(observer.lastInputAtMs()).toBe(t.now);
    expect(announced).toBe(1);
    t.now += MOVE_ANNOUNCE_MS;
    target.dispatchEvent(new Event("pointermove"));
    expect(announced).toBe(2);
  });

  it("hears nothing after it is disposed, and a failing announcement never reaches the page", () => {
    const { t, now } = clock();
    const target = new EventTarget();
    const observer = observeInput(target, now, () => {
      throw new Error("the check is gone");
    });
    expect(() => target.dispatchEvent(new Event("keydown"))).not.toThrow();
    observer.dispose();
    t.now += 5_000;
    target.dispatchEvent(new Event("keydown"));
    expect(observer.lastInputAtMs()).toBe(1_000_000);
  });

  it("is made on a page that is not there: it hears nothing, and says when it was made", () => {
    const { now } = clock();
    for (const target of [null, undefined]) {
      const observer = observeInput(target, now, () => undefined);
      expect(observer.lastInputAtMs()).toBe(1_000_000);
      expect(() => observer.dispose()).not.toThrow();
    }
    const broken = {
      addEventListener: () => {
        throw new Error("no page");
      },
      removeEventListener: () => {
        throw new Error("no page");
      },
    } as unknown as EventTarget;
    const observer = observeInput(broken, now, () => undefined);
    expect(observer.lastInputAtMs()).toBe(1_000_000);
    expect(() => observer.dispose()).not.toThrow();
  });
});

describe("whether something is playing", () => {
  const world = () => {
    const w = { now: 5_000_000, head: 0 as number | null };
    return { w, options: { playhead: () => w.head, now: () => w.now } };
  };

  it("is not playing while the playhead stands still, however long, and is playing once it moves, for a moment after it stops", () => {
    const { w, options } = world();
    const observer = observePlayback({ target: new EventTarget(), ...options });
    cleanup.push(observer.dispose);
    expect(observer.playing()).toBe(false);
    w.now += 60_000;
    expect(observer.playing()).toBe(false);
    // it plays: a new position at each beat of the heartbeat
    for (let beat = 1; beat <= 5; beat++) {
      w.now += 1_000;
      w.head = (w.head ?? 0) + 1;
      expect(observer.playing(), `beat ${beat}`).toBe(true);
    }
    // it stops: the answer holds for the window and then lets go
    w.now += PLAYHEAD_ACTIVE_MS;
    expect(observer.playing()).toBe(true);
    w.now += 1;
    expect(observer.playing()).toBe(false);
  });

  it("is not playing with no project open, and forgets where the playhead was when one opens", () => {
    const { w, options } = world();
    const observer = observePlayback({ target: new EventTarget(), ...options });
    cleanup.push(observer.dispose);
    w.head = null;
    expect(observer.playing()).toBe(false);
    // a project opens with its playhead somewhere else: that is not playback
    w.head = 42;
    w.now += 1_000;
    expect(observer.playing()).toBe(false);
    w.head = 43;
    w.now += 1_000;
    expect(observer.playing()).toBe(true);
  });

  it("is playing while a media element plays, and not once it pauses, ends, is emptied or is taken out of the page", () => {
    const { w, options } = world();
    const player = (document: Document) => {
      const video = document.createElement("video");
      document.body.appendChild(video);
      cleanup.push(() => video.remove());
      Object.defineProperty(video, "paused", { configurable: true, writable: true, value: false });
      Object.defineProperty(video, "ended", { configurable: true, writable: true, value: false });
      return video as HTMLVideoElement & { paused: boolean; ended: boolean };
    };
    const observer = observePlayback({ target: document, ...options });
    cleanup.push(observer.dispose);
    for (const stop of ["pause", "ended", "emptied", "abort", "error"]) {
      const video = player(document);
      video.dispatchEvent(new Event("play"));
      expect(observer.playing(), `${stop}: while it plays`).toBe(true);
      video.dispatchEvent(new Event(stop));
      w.now += PLAYHEAD_ACTIVE_MS + 1;
      expect(observer.playing(), stop).toBe(false);
      video.remove();
    }
    // one that stops without saying so (no event), and one that is removed from the page while it plays
    const silent = player(document);
    silent.dispatchEvent(new Event("playing"));
    expect(observer.playing()).toBe(true);
    silent.paused = true;
    expect(observer.playing()).toBe(false);
    const removed = player(document);
    removed.dispatchEvent(new Event("play"));
    expect(observer.playing()).toBe(true);
    removed.remove();
    expect(observer.playing()).toBe(false);
  });

  it("counts the playing of every element, not the last: two play, one stops, the page is still playing", () => {
    const { options } = world();
    const target = new EventTarget();
    const observer = observePlayback({ target, ...options });
    cleanup.push(observer.dispose);
    const a = Object.assign(new EventTarget(), { paused: false, ended: false, isConnected: true });
    const b = Object.assign(new EventTarget(), { paused: false, ended: false, isConnected: true });
    // the event is dispatched on the observed target with the element as its own target: what a capture listener on the document hears of an element below it
    const fire = (type: string, element: object) => {
      const event = new Event(type);
      Object.defineProperty(event, "target", { value: element });
      target.dispatchEvent(event);
    };
    fire("play", a);
    fire("play", b);
    fire("pause", a);
    expect(observer.playing()).toBe(true);
    fire("pause", b);
    expect(observer.playing()).toBe(false);
  });

  it("says busy when it cannot tell, and hears nothing after it is disposed", () => {
    const w = { now: 1_000_000 };
    const failing = observePlayback({
      target: new EventTarget(),
      playhead: () => {
        throw new Error("no editor");
      },
      now: () => w.now,
    });
    expect(failing.playing()).toBe(true);
    const target = new EventTarget();
    const observer = observePlayback({ target, playhead: () => 0, now: () => w.now });
    const element = Object.assign(new EventTarget(), {
      paused: false,
      ended: false,
      isConnected: true,
    });
    observer.dispose();
    const event = new Event("play");
    Object.defineProperty(event, "target", { value: element });
    target.dispatchEvent(event);
    expect(observer.playing()).toBe(false);
  });
});
