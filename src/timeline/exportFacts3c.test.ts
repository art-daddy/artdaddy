import { afterEach, describe, expect, it } from "vitest";
import {
  SEND_3C_FACTS,
  __resetFacts3c,
  factsForReport,
  factsOf3c,
  forgetFacts3c,
  noteFact3c,
} from "./exportFacts3c";

afterEach(() => __resetFacts3c());

describe("the local record of the new report facts", () => {
  it("keeps what each part of the app notes, one record per export", () => {
    noteFact3c("a", { speed_class: "weak", estimate_s: 600, estimate_basis: "pc_check" });
    noteFact3c("a", { route: "quick", quick_offer: "selected" });
    noteFact3c("b", { speed_class: "fast" });
    expect(factsOf3c("a")).toEqual({
      speed_class: "weak",
      estimate_s: 600,
      estimate_basis: "pc_check",
      route: "quick",
      quick_offer: "selected",
    });
    expect(factsOf3c("b")).toEqual({ speed_class: "fast" });
    expect(factsOf3c("c")).toBeUndefined();
  });

  it("accumulates the help words, each once, and replaces every other fact", () => {
    noteFact3c("a", { help_shown: ["heavy"], estimate_s: 100 });
    noteFact3c("a", { help_shown: ["slow", "heavy"], estimate_s: 200 });
    expect(factsOf3c("a")).toEqual({ help_shown: ["heavy", "slow"], estimate_s: 200 });
  });

  it("hands out a copy: changing it does not change the record", () => {
    noteFact3c("a", { help_shown: ["slow"] });
    factsOf3c("a")!.help_shown!.push("quiet");
    expect(factsOf3c("a")).toEqual({ help_shown: ["slow"] });
  });

  it("hands nothing to a report while the send is held, whatever was noted", () => {
    expect(SEND_3C_FACTS).toBe(false);
    noteFact3c("a", { speed_class: "weak", estimate_s: 600 });
    expect(factsForReport("a")).toBeUndefined();
  });

  it("is bounded: the oldest exports are forgotten first, and a forgotten export is not an error", () => {
    for (let i = 0; i < 250; i++) noteFact3c(`job-${i}`, { estimate_s: i + 1 });
    expect(factsOf3c("job-0")).toBeUndefined();
    expect(factsOf3c("job-249")).toEqual({ estimate_s: 250 });
    forgetFacts3c("job-249");
    expect(factsOf3c("job-249")).toBeUndefined();
  });

  it("never throws on garbage", () => {
    expect(() => {
      noteFact3c("", { estimate_s: 1 });
      noteFact3c(undefined as never, { estimate_s: 1 });
      noteFact3c("a", null as never);
      noteFact3c("a", { help_shown: "slow" as never });
    }).not.toThrow();
  });
});
