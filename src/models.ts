// Every value the server is known to accept, as constants. validate() rejects
// anything else before a call is made, unless join or run is given
// `allowUnlistedValues: true`.
//
// A value is listed only once the server is known to run it. Adding a model or
// voice the server has started to support is one line in an object below.

/** The value type of a constants object: `Voice` for `typeof Voice`. */
type ValueOf<T> = T[keyof T];

/**
 * A speech-to-speech model: it hears the caller and answers in its own voice.
 * Used by {@link Realtime}.
 */
export const RealtimeModel = {
  /** The server's default. */
  GeminiLive25FlashNativeAudio: "gemini-live-2.5-flash-native-audio",
} as const;
export type RealtimeModel = ValueOf<typeof RealtimeModel>;

/** The text model a {@link Cascade} thinks with. */
export const LLMModel = {
  /** The cascade's default. */
  Gemini25Flash: "gemini-2.5-flash",
} as const;
export type LLMModel = ValueOf<typeof LLMModel>;

/**
 * The speech-to-text model a {@link Cascade} listens with. Each model is served
 * from particular regions; when `sttRegion` is empty the SDK picks the one the
 * model was measured working in.
 */
export const STTModel = {
  /**
   * The default: the fastest final transcript (about 0.6s after the caller
   * stops), with interim results.
   */
  Short: "short",
  /** Slightly more accurate, with finals in about 1.5s and no interim results. */
  Chirp2: "chirp_2",
  /** Finals in about 1.6s and no interim results. */
  Chirp3: "chirp_3",
} as const;
export type STTModel = ValueOf<typeof STTModel>;

/** How a {@link Cascade} hears the caller. */
export const CascadeMode = {
  /** Transcribe the caller and hand the text model the words. The default. */
  STT: "stt",
  /** Hand the caller's audio to the text model directly, skipping speech-to-text. */
  Audio: "audio",
} as const;
export type CascadeMode = ValueOf<typeof CascadeMode>;

/** The voice-activity detector a {@link Cascade} gates the caller's audio with. */
export const VAD = {
  Silero: "silero",
  Ten: "ten",
} as const;
export type VAD = ValueOf<typeof VAD>;

/**
 * A prebuilt voice. The same names serve {@link Realtime} and a
 * {@link Cascade}'s text-to-speech. A {@link UlaiLive} pipeline has its own
 * voices: {@link UlaiLiveVoice}.
 */
export const Voice = {
  Achernar: "Achernar",
  Achird: "Achird",
  Algenib: "Algenib",
  Algieba: "Algieba",
  Alnilam: "Alnilam",
  Aoede: "Aoede",
  Autonoe: "Autonoe",
  Callirrhoe: "Callirrhoe",
  Charon: "Charon",
  Despina: "Despina",
  Enceladus: "Enceladus",
  Erinome: "Erinome",
  Fenrir: "Fenrir",
  Gacrux: "Gacrux",
  Iapetus: "Iapetus",
  Kore: "Kore",
  Laomedeia: "Laomedeia",
  Leda: "Leda",
  Orus: "Orus",
  Puck: "Puck",
  Pulcherrima: "Pulcherrima",
  Rasalgethi: "Rasalgethi",
  Sadachbia: "Sadachbia",
  Sadaltager: "Sadaltager",
  Schedar: "Schedar",
  Sulafat: "Sulafat",
  Umbriel: "Umbriel",
  Vindemiatrix: "Vindemiatrix",
  Zephyr: "Zephyr",
  Zubenelgenubi: "Zubenelgenubi",
} as const;
export type Voice = ValueOf<typeof Voice>;

/** A voice from the Ulai Live API's catalogue. */
export const UlaiLiveVoice = {
  /** The Ulai Live default. */
  Alba: "alba",
} as const;
export type UlaiLiveVoice = ValueOf<typeof UlaiLiveVoice>;

/** The language a call is held in, as a BCP-47 code. */
export const Language = {
  EnglishIndia: "en-IN",
  EnglishUS: "en-US",
  EnglishUK: "en-GB",
  Hindi: "hi-IN",
  Bengali: "bn-IN",
  Gujarati: "gu-IN",
  Kannada: "kn-IN",
  Malayalam: "ml-IN",
  Marathi: "mr-IN",
  Tamil: "ta-IN",
  Telugu: "te-IN",
} as const;
export type Language = ValueOf<typeof Language>;

/**
 * What judged who answered a dialled call: a person, a voicemail greeting, a
 * ringtone. Used by `options.classifier`.
 *
 * @deprecated Ulai no longer detects voicemail, so `options.classifier` has no
 * effect on the call.
 */
export const ClassifierBackend = {
  /** The server's former default. */
  GeminiLive: "gemini-live",
} as const;
export type ClassifierBackend = ValueOf<typeof ClassifierBackend>;

/** Who speaks first. */
export const Opening = {
  /** The agent has the floor as soon as the call is up. The default. */
  Agent: "agent",
  /** The agent stays silent until the caller speaks. */
  Caller: "caller",
} as const;
export type Opening = ValueOf<typeof Opening>;

/** Whose voice {@link Session.injectContext} speaks in. */
export const Role = {
  /** Present the text as something the model was told. */
  User: "user",
  /** Present it as something the model itself said. */
  Model: "model",
} as const;
export type Role = ValueOf<typeof Role>;

/**
 * How the agent server carries a room's audio to the media server. Your code
 * never handles audio either way; this only picks the agent server's
 * connection.
 */
export const Transport = {
  /** Opus frames over a WebSocket. The default. */
  WebSocket: "websocket",
  /** Opus over a WebRTC peer connection. */
  WebRTC: "webrtc",
} as const;
export type Transport = ValueOf<typeof Transport>;

// ─── Internal tables ─────────────────────────────────────────────────────────

/** The server's names for its backends. Chosen through the pipeline classes. */
export const backendGeminiLive = "gemini-live";
export const backendGoogleCascade = "google-cascade";
export const backendUlaiLive = "ulai-live";

/** The server backend that runs each realtime model. */
export const realtimeBackends: ReadonlyMap<string, string> = new Map([
  [RealtimeModel.GeminiLive25FlashNativeAudio, backendGeminiLive],
]);

/**
 * Where each speech-to-text model is served when `sttRegion` is empty. Model,
 * region and language are only valid in combination.
 */
export const sttRegions: ReadonlyMap<string, string> = new Map([
  [STTModel.Short, "global"],
  [STTModel.Chirp2, "asia-southeast1"],
  [STTModel.Chirp3, "eu"],
]);

const setOf = (o: Record<string, string>): ReadonlySet<string> => new Set(Object.values(o));

export const llmModels = setOf(LLMModel);
export const cascadeModes = setOf(CascadeMode);
export const vads = setOf(VAD);
export const voices = setOf(Voice);
export const ulaiLiveVoices = setOf(UlaiLiveVoice);
export const languages = setOf(Language);
export const classifiers = setOf(ClassifierBackend);
