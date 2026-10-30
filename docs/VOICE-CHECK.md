# Remaining live voice checks

Basic sentence endings and spoken replies were tried in the installed 0.2.0 build. The checks below remain pending; on 2026-10-26 the user requested automated work and deferred microphone testing. Unit tests and simulated recordings do not close these gates (IMPLEMENTATION-STATUS V3–V6/V8/V12).

Use the installed local dictation and read-aloud providers already configured in Settings → Voice. Record app/source build, microphone, speaker/headphone setup, selected models and observations. Do not change paid-provider settings or install anything for this check.

1. Start conversation mode (⌘⇧D). Speak a sentence, pause, and confirm exactly one turn. Repeat with a pause within a sentence. Record premature endings or long waits before changing endpoint settings.
2. On speakers, let a reply finish without speaking. Confirm its audio does not create another turn or answer a waiting control. Then speak over a reply: playback should stop and the intended next sentence should be handled once.
3. Say “stop” during a reply: speech stops. Say “stop listening”: the microphone closes. Start again and press Escape; confirm the microphone closes and the displayed state agrees. Turn Use voice off and confirm no recording or synthesis starts.
4. With a harmless local read-only integration set to Ask, request that tool. Try an unrelated answer, then bare “yes”: permission stays pending. Speak the operation phrase shown by the approval; only that one request is allowed. Repeat with “no” and confirm denial. Never use a real write or paid operation for this check.
5. Ask for two fictional options with different prices and a choice button for each. Choose by name, ordinal and “the cheaper one” on separate attempts. Confirm the spoken read-back identifies the right item and no action occurs until confirmation; try correction and cancel as well.
6. Ask for a fictional preferences form with two required fields and a number constraint. Give several values in one sentence, then an invalid value. Only missing/invalid fields should be asked again. Correct it, inspect the visible values and confirm once. Compare the delivered action with the clicked form path.
7. Try repeat, show on canvas and new chat. The open canvas should follow the waiting item without moving keyboard focus for background work. Outside/tool text and playback must never approve an operation.
8. If testing media playback, speak over a local clip. Playback pauses; the overlapping utterance is discarded before transcription. Repeat the command after the pause and confirm one local action without model/tool work.
9. Dictation Speech Cleaning: Enable "Clean speech with chat model" in Settings → Voice. Dictate a phrase with hesitation tokens ("um, ah, like, you know"), false starts, and mid-sentence backtrackings ("we need three servers wait actually four servers"). Confirm that the resolved text ("we need four servers") is placed into the message input. Next, dictate formatting requests ("give me a bullet list of alpha beta gamma"); confirm markdown list structure is produced. Disconnect the model or introduce a network timeout and verify that the verbatim transcribed text is immediately retained as a fail-safe fallback without error or dropped input.

Record each observation against its tracker item. Keep failed or untried items open; capture the relevant local transcript/log without publishing personal recordings or credentials. Tune endpoint/echo behavior only from retained observations.


Report/skill authoring now has a maintained [visual and spoken contract](SKILL-AUTHORING.md#design-the-visual-and-spoken-projections-together). The canonical weekly-report regression in `test/voice.test.ts` preserves decimal findings, period and caveat through gist/screen/details and a bound edit. These offline checks do not replace the live microphone/audio procedure in this document.
