# Voice Digest

Tap (Back Tap) -> speak -> stop. Notes are saved to Google Drive with their capture time, transcribed,
collected, and emailed to you as one digest each evening (default 18:30 UK time).

## One-time setup (about 15 minutes, on a computer)
1. Go to script.google.com -> New project. Name it "Voice Digest".
2. Project Settings -> tick "Show appsscript.json manifest file in editor". Replace its contents with `appsscript.json` from this folder.
3. Replace the contents of `Code.gs` with this folder's `Code.gs`.
4. Project Settings -> Script properties -> add `OPENAI_API_KEY` (create a key at platform.openai.com; add a few pounds of credit and a monthly spend limit).
   (Optional: set `SUMMARY_PROVIDER` to "anthropic" in `CONFIG` and add `ANTHROPIC_API_KEY`.)
5. In the editor choose the function `setup`, click Run, and approve the permissions (Drive, Sheets, Gmail send, external requests).
   It creates a Drive folder `VoiceCaptures`, a sheet `Voice Digest Log`, and the timers. Read the log for any problems.
6. Optional, for a "Summarise now" Shortcut: Deploy -> New deployment -> Web app -> Execute as: Me, Who has access: Anyone.
   Copy the URL and append `?token=` plus the value of the `WEBHOOK_TOKEN` script property.

## iPhone Shortcut "Capture note"
1. Record Audio (Start Recording: Immediately, Finish Recording: On Tap).
2. Format Date: Current Date, Custom, `yyyy-MM-dd_HH-mm-ss_Z`.
3. Set Name of Recorded Audio to `capture_` + the formatted date + `.m4a`.
4. Save File -> Google Drive / VoiceCaptures, Ask Where To Save: off.
Then Settings -> Accessibility -> Touch -> Back Tap -> Double (or Triple) Tap -> Shortcut -> Capture note.

## Behaviour
- Capture time comes from the file name, so late uploads keep the right time. No timestamp: upload time is used and flagged.
- Each recording is logged once (by file id and name); failed transcriptions retry up to 6 times; nothing is marked sent until Gmail accepts the email.
- If the AI summary fails the digest is still sent with raw transcripts.
- Owners, deadlines and numbers not found in your transcripts are removed or flagged.
- Audio and transcripts are removed 14 days after capture, only once they have been emailed.
  Google Drive keeps trashed files 30 days; empty the Drive bin to remove them sooner. The emails stay in Gmail until you delete them.
