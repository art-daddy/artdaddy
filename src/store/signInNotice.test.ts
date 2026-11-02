import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGN_IN_PROBLEMS } from "../api/signInProblems";
import { NOTICE_FRESH_MS, freshSignInNotice, useSignInNotice } from "./signInNotice";

beforeEach(() => {
  useSignInNotice.getState().clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const shown = () => freshSignInNotice(useSignInNotice.getState());

describe("the sentence about the last sign-in that did not finish", () => {
  it("is empty until a callback fails", () => {
    expect(shown()).toBeNull();
  });

  it("holds the plain sentence for the reason, and shows it", () => {
    useSignInNotice.getState().failed("exchange_rejected");
    expect(shown()).toBe(SIGN_IN_PROBLEMS.exchange_rejected);
  });

  it("is replaced by the next failure", () => {
    useSignInNotice.getState().failed("exchange_network");
    useSignInNotice.getState().failed("state_mismatch");
    expect(shown()).toBe(SIGN_IN_PROBLEMS.state_mismatch);
  });

  it("is never wiped by a failure there is nothing to say about", () => {
    useSignInNotice.getState().failed("exchange_server");
    useSignInNotice.getState().failed("cancelled");
    useSignInNotice.getState().failed("unrecognized");
    useSignInNotice.getState().failed(undefined);
    expect(shown()).toBe(SIGN_IN_PROBLEMS.exchange_server);
  });

  it("says nothing when the first failure is one there is nothing to say about", () => {
    useSignInNotice.getState().failed("cancelled");
    expect(shown()).toBeNull();
  });

  it("goes when it is cleared", () => {
    useSignInNotice.getState().failed("exchange_rejected");
    useSignInNotice.getState().clear();
    expect(shown()).toBeNull();
  });

  it("stops being shown once it is about an attempt the person has long since left", () => {
    useSignInNotice.getState().failed("exchange_rejected");
    vi.setSystemTime(Date.now() + NOTICE_FRESH_MS - 1);
    expect(shown()).toBe(SIGN_IN_PROBLEMS.exchange_rejected);
    vi.setSystemTime(Date.now() + 1);
    expect(shown()).toBeNull();
  });

  it("starts the clock again on a newer failure", () => {
    useSignInNotice.getState().failed("exchange_rejected");
    vi.setSystemTime(Date.now() + NOTICE_FRESH_MS - 1000);
    useSignInNotice.getState().failed("exchange_network");
    vi.setSystemTime(Date.now() + NOTICE_FRESH_MS - 1000);
    expect(shown()).toBe(SIGN_IN_PROBLEMS.exchange_network);
  });
});
