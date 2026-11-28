# By hand: the paid looks against the real vision service (release check, with approval only)

`video_ask` and `video_find_moment` send a reduced copy of a clip to the paid vision service. Every
automated test of them answers that service with a pre-written reply
(`e2e/ui/video-understanding/paidLooks.spec.ts`), so nothing there proves that the real service still
answers in the shape the app reads. This script is that proof. **It costs money: run it only at a
release, and only with the owner's approval for that run** (which tools, how many calls, the most it
may cost). No approval, no run: write "not run" in the release report.

## Before you start

- **Approval** for exactly this: 2 calls, the account to use, and the most they may cost.
- **Which build:** the release candidate built from the commit under test, signed in with the account
  the approval names. Write down its version and the commit.
- **Media:** `e2e/ui/captions-and-transcription/fixtures/media/spoken_scenes.mp4` (12 s: red 0-4 s,
  green 4-8 s, blue 8-12 s). Synthetic footage only: no person, no real scene.

## Steps (each with what must be true after it)

1. **File > New Project**, name it `sweep_qa_paid_looks`. Import the clip and drag it onto the timeline
   so that it starts at 2 s (frame 60 at 30 fps).
2. **Ask the assistant:** "When does the picture turn green? Use video_ask."
   - True: before anything is sent, a card names the tool and says "This spends your credits.", with
     **Allow** and **Deny**.
3. **Allow.** Time it: Allow to the answer.
   - True: the answer says about 4 s into the clip. Open the tool call row: `timing` is
     `project_frames` and the frame it gives is about 60 + 4 x 30 = 180 (within 30 frames).
4. **Ask:** "Find the blue part with video_find_moment." **Allow.** Time it: Allow to the answer.
   - True: the moment starts about frame 60 + 8 x 30 = 300 and ends near the clip's end (frame 420).
5. **The credits** shown in the status bar went down by the cost of two calls, no more.

## Record

Pass or fail per step, the two times (with the timing helper, `e2e/lib/timing.mjs`, under the names
`vision: video_ask real service, Allow to answer (installed build)` and
`vision: video_find_moment real service, Allow to answer (installed build)`), the build, the approval,
and the cost the app reports.

## Clean-up

Remove the project `sweep_qa_paid_looks`. The service deletes its copy of the clip after the call.
