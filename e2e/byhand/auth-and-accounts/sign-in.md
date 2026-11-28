# By hand: the sign-in round trip with a real account

The one sign-in path no automated lane can take: the real browser, the real sign-in page on artdaddy.app, Clerk and
the real server, back to the installed app. The browser lane (`e2e/ui/auth-and-accounts/signIn.spec.ts`) covers the app's
side of every step with a fake server; this script is the whole round trip once, by a person or by Copilot with computer
use, following the labels on screen (never screen positions).

## Rules for this script

- **The owner's account only, and only by clicking** (the qa skill, rule 9). No QA account exists; never create one. The
  browser must already be signed in to artdaddy.app: never type, store or print a password or a code. If the browser
  asks for a password, a code or a passkey, stop, sign in again only if the owner is at the PC to do it himself, and
  report the run "not run".
- **While signed in: no prompt to the agent, no Generate, no paid tool.** They spend money on his account.
- **The installed app, never a dev build.** A dev build must never talk to the live service (the qa skill, rule 5). The
  installed app always does. It must not be running when the script starts, and nothing else may be using it (rule 7).
- **His e-mail address goes in no file**, including the receipt: write "the owner's account".
- Run it on Windows first. Record the waits marked "time it".

## Before

1. Check that the installed app is not running: no `artdaddy.exe` process whose path is
   `%LOCALAPPDATA%\artdaddy\artdaddy.exe`. If it runs, stop: the owner is using it.
2. Note the installed version (the file's version, or the About box at step 4) for the receipt.
3. Check the sign-in link still opens the installed app: `reg query HKCU\Software\Classes\artdaddy\shell\open\command /ve`
   names `%LOCALAPPDATA%\artdaddy\artdaddy.exe`. If it names a test build in the lab folder, stop and report it (the
   lab guard puts it back once no real-app run holds the slot).
4. Start the installed app from the Start menu. It opens signed in (the menu bar shows File, Edit, View, Window, Help, and
   the account button at the right shows the account's name). If it shows "Sign in to continue" instead, skip to step 7.

## Sign out

5. Click the account button at the right of the menu bar. The menu shows the account's name, **Profile** and
   **Sign out**. Click **Sign out**.
6. The window shows **Sign in to continue** and the button **Log in or sign up**, and nothing of the editor. Time it from
   the click (time it: "auth: sign out to the sign-in screen (installed)").

## Sign in

7. Click **Log in or sign up**. The button reads **Opening your browser…** and the line
   **Already finished in the browser? Check again** appears under it.
8. The default browser opens a tab at `https://artdaddy.app/auth?...`. Because the browser is already signed in, the page
   goes straight on (it may show the account and a **Continue** button: click it). If it asks for a password, a code
   or a passkey: stop here (see the rules), report "not run", and leave the app on its sign-in screen for the owner.
9. The page says it is opening ArtDaddy and the browser may ask "Open ArtDaddy?" (Chrome and Edge ask this for an
   `artdaddy://` link). Click **Open ArtDaddy** (or the page's own **Open ArtDaddy** button if the prompt does not come).
10. The app comes to the front and leaves the sign-in screen: the menu bar is back and the account button shows the
    account's name. Time it from the click at step 7 (time it: "auth: sign-in round trip, button to the editor
    (installed)").

## Check what the person got

11. Click the account button, then **Profile**. The page shows the account's name, the credits (Remaining, Used, Limit)
    and, under About, the app's version. Do not press anything else on this page. Click **← Back**.
12. Close the app with **File > Exit**, start it again from the Start menu, and check it opens signed in, with no browser
    (the saved session was kept). Time the start (time it: "auth: start with a saved session to the editor (installed)").
13. Close the app with **File > Exit**. Leave it signed in: that is how the owner had it.

## After

- Close the browser tab the sign-in opened.
- The receipt names the installed version, the times, and anything that did not match a step (the words on screen,
  a prompt that was not expected), with a screenshot where it helps. Never his e-mail address.

## Not covered here

- A second device: signing in on another computer gives that computer its own session; signing out there does not end
  this one. That is the server's (token families, `tests/unit/server/test_desktop_auth.py` in the server repository).
- macOS and Linux sign-in (Linux needs a real desktop; the auth hub lists it as not coverable by a worker).
