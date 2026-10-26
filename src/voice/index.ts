// Voice in the window: the one entry point the rest of the app imports.
// read-aloud.ts speaks replies, dictation.ts listens, speech-text.ts turns a
// reply into what is said, settings-page.ts is Settings → Voice and the voice
// cards in Integrations, conversation.ts is hands-free talking (endpoint.ts
// hears where sentences end), and master.ts is the switch over all of it.

export { cancelDictation, dictationPrefs, dictationState, startDictation, stopDictation } from "./dictation.ts";
export { lastError, readAloud, replyText, stopReading, voicePrefs, voiceState } from "./read-aloud.ts";
export { spokenSurface, textLanguage } from "./speech-text.ts";
export { setVoiceOn, voicePage, voiceSection, voiceSettingsPage } from "./settings-page.ts";
export { voiceMaster } from "./master.ts";
export { VoiceApprovals } from "./approvals.ts";
export { VoiceDecisions } from "./decisions.ts";
export { conversationPrefs, conversationState, type ConversationState, startConversation, stopConversation } from "./conversation.ts";
