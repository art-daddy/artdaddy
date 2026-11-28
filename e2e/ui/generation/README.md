# Generation, billing and credits: browser tests on scripted replies

These tests drive what a person does with generation and credits (ask the assistant for an image,
a video, a voice-over or music; read the price in the approval bar; Allow or Deny; place the result;
quit and come back; run out of credits; open the profile) and judge what the person gets: the screen,
the saved project (`internals/library.json`, `internals/timeline.json`, `internals/jobs.json`, the
file the generation wrote), and what the app sent to the server. No test reaches a model, a vendor
or a payment provider: the app sells nothing today, and no test may start a payment.

```
npm run e2e:ui -- e2e/ui/generation e2e/ui/billing-and-credits
```

## How it works

They run on the agent lane's rig (`../agent-and-models/lib/qa.ts`: a fake ArtDaddy server, a QA
shell standing in for the desktop side, scripted model replies; its README says how). On top of it,
`lib/gen.ts` adds the paid side of the server, scripted per test (`lib/genDesk.ts`):

- **The price** (`POST /ai/{name}/quote`): `gen.desk.quote.generate_image = 24` answers "24 credits";
  `{ status: 503 }` answers a failure; unset answers 404 (no price). Every question is kept
  (`gen.desk.quotes`), so a test can check it asked about the call that will be sent and carried
  nothing of the person's (no prompt, no script).
- **The paid call** (`POST /ai/{name}`, through the fake server's real socket): queue how the next
  call to a proxy is taken with `gen.desk.next(proxy, outcome)`: `inline` (answered at once, as a
  server with no results bucket does), `order` (taken as an order, 202, running until the test calls
  `gen.desk.finish()` or `gen.desk.fail(message, { code })`, or ready at once with `ready: true`), or
  `http` (a 402, a 429...). A paid call with nothing queued fails the test: an extra paid request
  cannot pass unnoticed. The same order number sent again is answered with the order the desk has.
- **The order desk** (`GET /orders/{id}`, `POST /orders/{id}/ack`) and the private link to the result
  are answered inside the page (`page.route` on the fake server's origin), in the server's shapes
  (`src/api/orders.ts`). Each order counts how often the app asked (`polls`), fetched (`downloads`)
  and confirmed it has the file (`acks`), and whether it sent a sign-in token to the link (it must not).
- **Finished results** are real media: the agent lane's PNG, a four-second H.264 + AAC MP4
  (`fixtures/media/four_seconds.mp4`), PCM and WAV tones made in the test (`imageAnswer`,
  `videoAnswer`, `voiceAnswer`, `musicAnswer`).

`gen.placeholder()` waits for the generation's library row, `gen.settled(ref)` for it to land or
fail, `gen.fileOf(row)` reads the bytes it wrote, `gen.wakeRounds()` lists the model rounds that
carried the app's "background work finished" message, and `gen.communityLinksOpened()` counts the
native command that opens the community (Discord) link.

Known bugs are marked with `knownBug(title, shows)` from the agent lane, after the steps that work.

## Waits

Recorded with the shared helper (`e2e/lib/timing`), named `generation: <wait> [<browser>]` or
`billing: <wait> [<browser>]`. What the vendor takes is scripted, so the waits are the app's own
part: from a finished order to the file in the library, from Allow to a voice-over that answers at
once, from opening the profile to its numbers.
